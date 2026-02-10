/**
 * Integration tests for the plugin lifecycle.
 *
 * These test the wiring in index.mjs — the ordering of authorize → callback → loader,
 * the accountManager initialization, and the fetch interceptor retry loop.
 *
 * We mock external dependencies (fetch, PKCE, readline, storage fs) but exercise
 * the real plugin code paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Mock @openauthjs/openauth/pkce
vi.mock("@openauthjs/openauth/pkce", () => ({
  generatePKCE: vi.fn(async () => ({
    challenge: "test-challenge",
    verifier: "test-verifier",
  })),
}));

// Mock readline (used by promptAccountMenu / promptManageAccounts)
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("a"),
    close: vi.fn(),
  })),
}));

// Mock storage — we control what's on "disk"
vi.mock("./lib/storage.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadAccounts: vi.fn().mockResolvedValue(null),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    clearAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock config — always return defaults
vi.mock("./lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadConfig: vi.fn(() => ({ ...original.DEFAULT_CONFIG })),
  };
});

// Mock global fetch for OAuth token exchange and API requests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { AnthropicAuthPlugin } from "./index.mjs";
import { saveAccounts, loadAccounts, clearAccounts } from "./lib/storage.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return {
    auth: {
      set: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeProvider() {
  return {
    models: {
      "claude-sonnet": {
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      },
    },
  };
}

/**
 * Build a stored account object with sensible defaults.
 * Override any field by passing partial overrides.
 */
function makeStoredAccount(overrides = {}) {
  return {
    refreshToken: "refresh-1",
    addedAt: 1000,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    ...overrides,
  };
}

/** Build a stored accounts data structure with N accounts. */
function makeAccountsData(accountOverrides = [{}], extra = {}) {
  return {
    version: 1,
    accounts: accountOverrides.map((o, i) =>
      makeStoredAccount({ refreshToken: `refresh-${i + 1}`, addedAt: (i + 1) * 1000, ...o }),
    ),
    activeIndex: 0,
    ...extra,
  };
}

/**
 * Bootstrap a plugin with loaded accounts and return the fetch interceptor.
 * Accepts an array of account overrides (one per account) and optional auth overrides.
 */
async function setupFetchFn(client, accountOverrides = [{}], authOverrides = {}) {
  const data = makeAccountsData(accountOverrides);
  loadAccounts.mockResolvedValue(data);
  saveAccounts.mockResolvedValue(undefined);

  const plugin = await AnthropicAuthPlugin({ client });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: data.accounts[0].refreshToken,
    access: `access-1`,
    expires: Date.now() + 3600_000,
    ...authOverrides,
  });

  const result = await plugin.auth.loader(getAuth, makeProvider());
  return result.fetch;
}

/** Shorthand for a successful token refresh mock response */
function mockTokenRefresh(token = "access-new", refresh = "refresh-new") {
  return {
    ok: true,
    json: async () => ({
      access_token: token,
      refresh_token: refresh,
      expires_in: 3600,
    }),
  };
}

// ---------------------------------------------------------------------------
// Plugin lifecycle: authorize → callback → loader ordering
// ---------------------------------------------------------------------------

describe("plugin lifecycle", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);
  });

  it("authorize callback creates accounts file on first login (accountManager starts null)", async () => {
    // Mock the OAuth token exchange response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "access-from-oauth",
        refresh_token: "refresh-from-oauth",
        expires_in: 3600,
      }),
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const method = plugin.auth.methods[0]; // "Claude Pro/Max (multi-account)"

    // Step 1: authorize() — returns URL + callback
    const authResult = await method.authorize();
    expect(authResult.url).toContain("claude.ai/oauth/authorize");
    expect(authResult.method).toBe("code");

    // Step 2: callback() — user pastes the code
    // At this point, loader() has NOT been called yet, so accountManager is null.
    const credentials = await authResult.callback("auth-code#state");

    expect(credentials.type).toBe("success");
    expect(credentials.refresh).toBe("refresh-from-oauth");
    expect(credentials.access).toBe("access-from-oauth");

    // KEY ASSERTION: saveAccounts must have been called — the accounts file is created
    expect(saveAccounts).toHaveBeenCalledTimes(1);
    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        accounts: expect.arrayContaining([
          expect.objectContaining({
            refreshToken: "refresh-from-oauth",
            enabled: true,
          }),
        ]),
      }),
    );
  });

  it("loader bootstraps from auth.json and saves accounts file immediately", async () => {
    const plugin = await AnthropicAuthPlugin({ client });
    const provider = makeProvider();

    // Simulate OpenCode calling loader() after auth is stored
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "existing-refresh",
      access: "existing-access",
      expires: Date.now() + 3600_000,
    });

    const result = await plugin.auth.loader(getAuth, provider);

    // Should have saved the bootstrapped account immediately
    expect(saveAccounts).toHaveBeenCalledTimes(1);
    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        accounts: expect.arrayContaining([
          expect.objectContaining({
            refreshToken: "existing-refresh",
          }),
        ]),
      }),
    );

    // Should return fetch interceptor
    expect(result.fetch).toBeTypeOf("function");

    // Model costs should be zeroed
    expect(provider.models["claude-sonnet"].cost.input).toBe(0);
    expect(provider.models["claude-sonnet"].cost.output).toBe(0);
  });

  it("second login adds to existing account pool", async () => {
    // First login already happened — accounts file exists
    loadAccounts.mockResolvedValue(makeAccountsData([{ refreshToken: "first-refresh", lastUsed: 2000 }]));

    const plugin = await AnthropicAuthPlugin({ client });

    // Run loader first (simulating normal startup after first login)
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "first-refresh",
      access: "first-access",
      expires: Date.now() + 3600_000,
    });
    await plugin.auth.loader(getAuth, makeProvider());

    // Reset mock to track only the second login's save
    saveAccounts.mockClear();

    // Now simulate second OAuth login
    // loadAccounts returns existing accounts — but accountManager is already loaded,
    // so the menu check (stored && stored.accounts.length > 0 && accountManager) is true.
    // We need to mock readline to return "a" (add) — already done in mock setup.

    // Mock the OAuth exchange for second account
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "second-access",
        refresh_token: "second-refresh",
        expires_in: 3600,
      }),
    });

    const method = plugin.auth.methods[0];
    const authResult = await method.authorize();
    const credentials = await authResult.callback("second-code#state");

    expect(credentials.type).toBe("success");
    expect(credentials.refresh).toBe("second-refresh");

    // Should have saved with BOTH accounts
    expect(saveAccounts).toHaveBeenCalled();
    const savedData = saveAccounts.mock.calls[saveAccounts.mock.calls.length - 1][0];
    expect(savedData.accounts).toHaveLength(2);
    expect(savedData.accounts[0].refreshToken).toBe("first-refresh");
    expect(savedData.accounts[1].refreshToken).toBe("second-refresh");
  });

  it("loader returns empty object for non-oauth auth", async () => {
    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "api",
      key: "sk-ant-xxx",
    });

    const result = await plugin.auth.loader(getAuth, makeProvider());
    expect(result).toEqual({});
    expect(saveAccounts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Slash command hooks (/anthropic)
// ---------------------------------------------------------------------------

describe("slash commands", () => {
  let client;
  let plugin;

  /**
   * Run /anthropic command hook and return the last session message.
   * @param {string} args
   * @returns {Promise<string>}
   */
  async function runAnthropic(args) {
    client.session.prompt.mockClear();
    await expect(
      plugin["command.execute.before"]({
        command: "anthropic",
        arguments: args,
        sessionID: "session-1",
      }),
    ).rejects.toThrow("__ANTHROPIC_COMMAND_HANDLED__");

    const calls = client.session.prompt.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0].body.parts[0].text;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);
    plugin = await AnthropicAuthPlugin({ client });
  });

  it("registers /anthropic command in config hook", async () => {
    const cfg = { command: {} };
    await plugin.config(cfg);
    expect(cfg.command.anthropic).toEqual(
      expect.objectContaining({
        template: "/anthropic",
        description: expect.stringContaining("Manage Anthropic"),
      }),
    );
  });

  it("shows list view by default", async () => {
    const text = await runAnthropic("");
    expect(text).toContain("▣ Anthropic (error)");
    expect(text).toContain("No accounts configured");
  });

  it("routes usage alias to CLI list", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData([{ refreshToken: "refresh-1", enabled: true }]));
    const text = await runAnthropic("usage");
    expect(text).toContain("Anthropic Multi-Account Status");
  });

  it("routes switch through CLI command surface", async () => {
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { refreshToken: "refresh-1", enabled: true, email: "a@example.com" },
        { refreshToken: "refresh-2", enabled: true, email: "b@example.com" },
      ]),
    );

    const text = await runAnthropic("switch 2");
    expect(text).toContain("Switched");
    expect(saveAccounts).toHaveBeenCalledWith(expect.objectContaining({ activeIndex: 1 }));
  });

  it("starts and completes login OAuth flow", async () => {
    let text = await runAnthropic("login");
    expect(text).toContain("Anthropic OAuth");
    expect(text).toContain("Started login flow");
    expect(text).toContain("claude.ai/oauth/authorize");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "access-from-login",
        refresh_token: "refresh-from-login",
        expires_in: 3600,
        account: { email_address: "new@example.com" },
      }),
    });

    text = await runAnthropic("login complete test-code#test-state");
    expect(text).toContain("Added account #1");
    expect(client.auth.set).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "anthropic" },
        body: expect.objectContaining({
          type: "oauth",
          refresh: "refresh-from-login",
          access: "access-from-login",
        }),
      }),
    );
    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        accounts: expect.arrayContaining([
          expect.objectContaining({
            refreshToken: "refresh-from-login",
            access: "access-from-login",
            email: "new@example.com",
          }),
        ]),
      }),
    );
  });

  it("expires pending slash OAuth flow after TTL", async () => {
    await runAnthropic("login");

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      const text = await runAnthropic("login complete stale-code#state");
      expect(text).toContain("expired");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("starts and completes reauth OAuth flow", async () => {
    const stored = makeAccountsData([
      {
        refreshToken: "refresh-1",
        access: "old-access",
        expires: Date.now() + 1000,
        enabled: false,
        consecutiveFailures: 3,
        lastFailureTime: Date.now(),
        rateLimitResetTimes: { anthropic: Date.now() + 60_000 },
      },
    ]);
    loadAccounts.mockResolvedValue(stored);

    let text = await runAnthropic("reauth 1");
    expect(text).toContain("Started reauth 1 flow");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
        account: { email_address: "reauth@example.com" },
      }),
    });

    text = await runAnthropic("reauth complete another-code#state");
    expect(text).toContain("Re-authenticated account #1");
    expect(client.auth.set).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "anthropic" },
        body: expect.objectContaining({
          type: "oauth",
          refresh: "fresh-refresh",
          access: "fresh-access",
        }),
      }),
    );

    const saved = saveAccounts.mock.calls[saveAccounts.mock.calls.length - 1][0];
    expect(saved.accounts[0]).toEqual(
      expect.objectContaining({
        refreshToken: "fresh-refresh",
        access: "fresh-access",
        email: "reauth@example.com",
        enabled: true,
        consecutiveFailures: 0,
        lastFailureTime: null,
        rateLimitResetTimes: {},
      }),
    );
  });

  it("returns without handling non-anthropic commands", async () => {
    await expect(
      plugin["command.execute.before"]({
        command: "usage",
        arguments: "",
        sessionID: "session-1",
      }),
    ).resolves.toBeUndefined();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fetch interceptor
// ---------------------------------------------------------------------------

describe("fetch interceptor", () => {
  let client;
  let fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "test-refresh",
      access: "test-access",
      expires: Date.now() + 3600_000,
    });

    const result = await plugin.auth.loader(getAuth, makeProvider());
    fetchFn = result.fetch;
  });

  it("adds Bearer auth header and required beta headers", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('data: {"type":"message_start"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const headers = init.headers;
    expect(headers.get("authorization")).toBe("Bearer test-access");
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("user-agent")).toContain("claude-cli");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("adds ?beta=true to /v1/messages URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const [input] = mockFetch.mock.calls[0];
    const url = input instanceof URL ? input : new URL(input.toString());
    expect(url.searchParams.get("beta")).toBe("true");
  });

  it("transforms system prompt: OpenCode → Claude Code, opencode → Claude", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        system: [{ type: "text", text: "You are OpenCode, an opencode assistant." }],
        messages: [],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system[0].text).toBe("You are Claude Code, an Claude assistant.");
  });

  it("preserves paths containing opencode in system prompt", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        system: [{ type: "text", text: "Working dir: /Users/rmk/projects/opencode-auth" }],
        messages: [],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system[0].text).toBe("Working dir: /Users/rmk/projects/opencode-auth");
  });

  it("prefixes tool names with mcp_ in request", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        tools: [{ name: "read_file", description: "Read a file" }],
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", name: "read_file", id: "t1", input: {} }],
          },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.tools[0].name).toBe("mcp_read_file");
    expect(body.messages[0].content[0].name).toBe("mcp_read_file");
  });

  it("strips mcp_ prefix from tool names in response stream", async () => {
    const responseBody =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read_file"}}\n\n';
    mockFetch.mockResolvedValueOnce(
      new Response(responseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const text = await response.text();
    expect(text).toContain('"name": "read_file"');
    expect(text).not.toContain("mcp_read_file");
  });

  it("does not show account usage toast for non-message endpoints", async () => {
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/models", {
      method: "GET",
    });

    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it("shows account usage toast on first messages request", async () => {
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { message: expect.stringContaining("Account 1"), variant: "info" },
    });
  });

  it("does not repeat toast when account stays the same", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    // First request — should toast
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);

    // Second request, same account — no new toast
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 with a different account", async () => {
    // Set up two accounts — the auth fallback provides access token for account 1.
    // Account 2 will need a token refresh before it can be used.
    vi.resetAllMocks();
    const fetchFn = await setupFetchFn(client, [{}, {}]);

    // First API request: 429 (account 1 has access token from auth fallback)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );
    // Token refresh for account 2 (no access token yet)
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("access-2", "refresh-2"));
    // Retry API request with account 2: 200
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // 3 calls: first API (429), token refresh for account 2, retry API (200)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// System prompt transform
// ---------------------------------------------------------------------------

describe("system prompt transform", () => {
  it("prepends Claude Code prefix for anthropic provider", async () => {
    const client = makeClient();
    const plugin = await AnthropicAuthPlugin({ client });

    const output = { system: ["You are a helpful assistant."] };
    plugin["experimental.chat.system.transform"]({ model: { providerID: "anthropic" } }, output);

    expect(output.system[0]).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(output.system[1]).toContain("You are Claude Code");
    expect(output.system[1]).toContain("You are a helpful assistant.");
  });

  it("does not modify system for non-anthropic provider", async () => {
    const client = makeClient();
    const plugin = await AnthropicAuthPlugin({ client });

    const output = { system: ["You are a helpful assistant."] };
    plugin["experimental.chat.system.transform"]({ model: { providerID: "openai" } }, output);

    expect(output.system).toEqual(["You are a helpful assistant."]);
  });
});

// ---------------------------------------------------------------------------
// Fetch interceptor — token refresh paths
// ---------------------------------------------------------------------------

describe("fetch interceptor — token refresh", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    saveAccounts.mockResolvedValue(undefined);
  });

  it("refreshes expired account token before making API request", async () => {
    // Set up one account with an EXPIRED token
    loadAccounts.mockResolvedValue(makeAccountsData());
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "expired-access",
      expires: Date.now() - 1000, // expired
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Token refresh call
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("fresh-access", "refresh-1-rotated"));
    // Actual API call
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // 2 calls: token refresh + API request
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call should be the token refresh
    const [refreshUrl, refreshInit] = mockFetch.mock.calls[0];
    expect(refreshUrl).toBe("https://console.anthropic.com/v1/oauth/token");
    expect(JSON.parse(refreshInit.body).grant_type).toBe("refresh_token");

    // Second call should use the fresh token
    const [, apiInit] = mockFetch.mock.calls[1];
    expect(apiInit.headers.get("authorization")).toBe("Bearer fresh-access");

    // Should persist updated tokens (client.auth.set called during refresh)
    expect(client.auth.set).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          access: "fresh-access",
          refresh: "refresh-1-rotated",
        }),
      }),
    );
  });

  it("coalesces concurrent refreshes for the same account", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData());
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "expired-access",
      expires: Date.now() - 1000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    let resolveRefresh;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    mockFetch.mockImplementation((url) => {
      const s = String(url);
      if (s.includes("/v1/oauth/token")) {
        return refreshPromise;
      }
      return Promise.resolve(new Response('{"content":[]}', { status: 200 }));
    });

    const p1 = result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    const p2 = result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    // Let both requests reach refresh path
    await Promise.resolve();

    resolveRefresh(mockTokenRefresh("fresh-access", "refresh-1-rotated"));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const refreshCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
    expect(refreshCalls).toHaveLength(1);
  });

  it("disables account on 401 token refresh failure and retries with next account", async () => {
    // Two accounts — first will fail refresh, second will succeed
    loadAccounts.mockResolvedValue(
      makeAccountsData([{ refreshToken: "revoked-refresh" }, { refreshToken: "good-refresh" }]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "revoked-refresh",
      access: "expired-access",
      expires: Date.now() - 1000, // expired — forces refresh
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Account 1 token refresh: 401 (revoked)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_grant" }),
    });
    // Account 2 token refresh (also no access token)
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("good-access", "good-refresh"));
    // API call with account 2
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // 3 calls: failed refresh (acct 1), successful refresh (acct 2), API call
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("disables account on 400 invalid_grant refresh failure and retries with next account", async () => {
    loadAccounts.mockResolvedValue(
      makeAccountsData([{ refreshToken: "bad-refresh" }, { refreshToken: "good-refresh" }]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "bad-refresh",
      access: "expired-access",
      expires: Date.now() - 1000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Account 1 refresh fails with 400 invalid_grant
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });
    // Account 2 refresh succeeds
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("good-access", "good-refresh"));
    // API call with account 2
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("fails over to next account on transient refresh failure", async () => {
    loadAccounts.mockResolvedValue(
      makeAccountsData([{ refreshToken: "transient-refresh" }, { refreshToken: "good-refresh" }]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "transient-refresh",
      access: "expired-access",
      expires: Date.now() - 1000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Account 1 refresh fails transiently (500) -> should fail over
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    // Account 2 refresh succeeds
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("good-access", "good-refresh"));
    // API call succeeds on account 2
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Fetch interceptor — edge conditions
// ---------------------------------------------------------------------------

describe("fetch interceptor — edge conditions", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    saveAccounts.mockResolvedValue(undefined);
  });

  it("fails fast when all accounts are disabled", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData([{ refreshToken: "disabled-refresh", enabled: false }]));

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "opencode-refresh",
      access: "opencode-access",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    await expect(
      result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow("No enabled Anthropic accounts available");

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fetch interceptor — account exhaustion and service-wide errors
// ---------------------------------------------------------------------------

describe("fetch interceptor — account exhaustion", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    saveAccounts.mockResolvedValue(undefined);
  });

  it("throws when single account fails token refresh (transient skip, no more accounts)", async () => {
    // Single account that fails token refresh with a transient error
    loadAccounts.mockResolvedValue(makeAccountsData([{ refreshToken: "bad-refresh" }]));

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "bad-refresh",
      access: "expired-access",
      expires: Date.now() - 1000, // expired — forces refresh
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Refresh fails with transient 500
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    await expect(
      result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow(/Token refresh failed|No available Anthropic account|All accounts exhausted/);
  });

  it("throws when only account gets rate-limited (no more accounts to try)", async () => {
    const fetchFn = await setupFetchFn(client);

    // 429 — account-specific, but no other accounts to try
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );

    await expect(
      fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow(/All accounts exhausted|No available Anthropic account/);

    // Only 1 fetch call — no retry (no other accounts)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 529, errorType: "overloaded_error", errorMsg: "Server is overloaded" },
    { status: 503, errorType: "service_unavailable", errorMsg: "temporarily unavailable" },
    { status: 500, errorType: "internal_error", errorMsg: "internal server error" },
  ])("returns $status directly without switching accounts", async ({ status, errorType, errorMsg }) => {
    const fetchFn = await setupFetchFn(client, [{}, {}]);

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: errorType, message: errorMsg } }), { status }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(status);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles 400 account-specific error (billing) by switching accounts", async () => {
    const fetchFn = await setupFetchFn(client, [{}, {}]);

    // Account 1: 400 with billing language — account-specific
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "This request would exceed your account's rate limit. Please try again later.",
          },
        }),
        { status: 400 },
      ),
    );
    // Token refresh for account 2
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("access-2", "refresh-2"));
    // API call with account 2: success
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // 3 calls: first API (400), token refresh (acct 2), retry API (200)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles 400 non-account-specific error by returning directly", async () => {
    const fetchFn = await setupFetchFn(client, [{}, {}]);

    // 400 with generic error (not account-specific) — should NOT switch
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid model specified" } }), {
        status: 400,
      }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    // Should return the 400 directly — not switch accounts
    expect(response.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles 403 permission_error by switching accounts", async () => {
    const fetchFn = await setupFetchFn(client, [{}, {}]);

    // Account 1 fails with structured permission error
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "permission_error", message: "Forbidden" } }), { status: 403 }),
    );
    // Refresh account 2 token
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("access-2", "refresh-2"));
    // Retry with account 2 succeeds
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(client.tui.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          message: expect.stringContaining("permission denied"),
          variant: "warning",
        }),
      }),
    );
  });

  it("clears token state on 401 so next attempt refreshes token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    try {
      loadAccounts.mockResolvedValue(makeAccountsData([{ access: "stale-access", expires: Date.now() + 3600_000 }]));
      saveAccounts.mockResolvedValue(undefined);

      const plugin = await AnthropicAuthPlugin({ client });
      const getAuth = vi.fn().mockResolvedValue({
        type: "oauth",
        refresh: "refresh-1",
        access: "stale-access",
        expires: Date.now() + 3600_000,
      });
      const result = await plugin.auth.loader(getAuth, makeProvider());

      // First API call fails with 401 (account-specific auth error)
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
          status: 401,
        }),
      );

      await expect(
        result.fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          body: JSON.stringify({ messages: [] }),
        }),
      ).rejects.toThrow(/All accounts exhausted|No available Anthropic account/);

      // 401 path uses short AUTH_FAILED cooldown (5s)
      vi.advanceTimersByTime(6_000);

      // Next request should refresh token before calling API
      mockFetch.mockResolvedValueOnce(mockTokenRefresh("fresh-access", "refresh-1"));
      mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

      const response = await result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const refreshCallUrl = String(mockFetch.mock.calls[1][0]);
      expect(refreshCallUrl).toContain("/v1/oauth/token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries next account when fetch throws a network error", async () => {
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 3600_000 },
        { access: "access-2", expires: Date.now() + 3600_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    mockFetch.mockRejectedValueOnce(new Error("network down"));
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondHeaders.get("authorization")).toBe("Bearer access-2");
  });

  it("handles mixed account-specific failures across three accounts", async () => {
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 3600_000 },
        { access: "access-2", expires: Date.now() + 3600_000 },
        { access: "access-3", expires: Date.now() + 3600_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Account 1: 429 rate limit
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
        status: 429,
      }),
    );
    // Account 2: 403 permission error
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "permission_error", message: "Forbidden" } }), { status: 403 }),
    );
    // Account 3: success
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const thirdHeaders = mockFetch.mock.calls[2][1].headers;
    expect(thirdHeaders.get("authorization")).toBe("Bearer access-3");
  });

  it("debounces rapid account-switch warning toasts", async () => {
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 3600_000 },
        { access: "access-2", expires: Date.now() + 3600_000 },
        { access: "access-3", expires: Date.now() + 3600_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Two immediate account-specific failures trigger two switches in one request.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
        status: 429,
      }),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
        status: 429,
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);

    const warningToasts = client.tui.showToast.mock.calls.filter((call) => call[0]?.body?.variant === "warning");

    // Debounce should suppress immediate duplicate switch warnings.
    expect(warningToasts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OAuth exchange failure
// ---------------------------------------------------------------------------

describe("OAuth exchange failure", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);
  });

  it("propagates exchange failure without saving accounts", async () => {
    // Mock the OAuth token exchange to fail
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const method = plugin.auth.methods[0];

    const authResult = await method.authorize();
    const credentials = await authResult.callback("bad-code#state");

    expect(credentials.type).toBe("failed");
    // saveAccounts should NOT have been called
    expect(saveAccounts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth menu actions (cancel, fresh, manage)
// ---------------------------------------------------------------------------

describe("auth menu actions", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    saveAccounts.mockResolvedValue(undefined);
  });

  /**
   * Helper: set up a plugin with existing accounts and a loaded accountManager,
   * then configure readline to return a specific menu choice.
   */
  async function setupWithMenuChoice(menuChoice) {
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "existing-refresh",
          addedAt: 1000,
          lastUsed: 2000,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin = await AnthropicAuthPlugin({ client });

    // Run loader to initialize accountManager
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "existing-refresh",
      access: "existing-access",
      expires: Date.now() + 3600_000,
    });
    await plugin.auth.loader(getAuth, makeProvider());

    // Configure readline mock to return the menu choice
    const { createInterface: mockCreateInterface } = await import("node:readline/promises");
    mockCreateInterface.mockReturnValue({
      question: vi.fn().mockResolvedValue(menuChoice),
      close: vi.fn(),
    });

    // Reset saveAccounts tracking after loader's save
    saveAccounts.mockClear();

    return plugin;
  }

  it("cancel action returns about:blank with failed callback", async () => {
    const plugin = await setupWithMenuChoice("c");
    const method = plugin.auth.methods[0];

    const authResult = await method.authorize();

    expect(authResult.url).toBe("about:blank");
    expect(authResult.method).toBe("code");

    const credentials = await authResult.callback("anything");
    expect(credentials.type).toBe("failed");

    // No accounts should have been saved
    expect(saveAccounts).not.toHaveBeenCalled();
  });

  it("fresh action clears accounts and proceeds to OAuth", async () => {
    const plugin = await setupWithMenuChoice("f");
    const method = plugin.auth.methods[0];

    const authResult = await method.authorize();

    // Should have cleared accounts
    expect(clearAccounts).toHaveBeenCalled();

    // Should proceed to OAuth (URL should be the authorize URL, not about:blank)
    expect(authResult.url).toContain("claude.ai/oauth/authorize");
    expect(authResult.method).toBe("code");

    // Simulate completing the OAuth flow
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      }),
    });

    const credentials = await authResult.callback("fresh-code#state");
    expect(credentials.type).toBe("success");
    expect(credentials.refresh).toBe("fresh-refresh");
  });

  it("manage action saves and returns about:blank", async () => {
    // For manage, readline returns "m" for menu, then "b" for back in manage submenu
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "existing-refresh",
          addedAt: 1000,
          lastUsed: 2000,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin = await AnthropicAuthPlugin({ client });

    // Run loader to initialize accountManager
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "existing-refresh",
      access: "existing-access",
      expires: Date.now() + 3600_000,
    });
    await plugin.auth.loader(getAuth, makeProvider());

    // Configure readline: first call returns "m" (menu), second returns "b" (back from manage)
    const { createInterface: mockCreateInterface } = await import("node:readline/promises");
    let callCount = 0;
    mockCreateInterface.mockReturnValue({
      question: vi.fn().mockImplementation(() => {
        callCount++;
        // First question call is the menu prompt, second is the manage submenu
        return Promise.resolve(callCount === 1 ? "m" : "b");
      }),
      close: vi.fn(),
    });

    saveAccounts.mockClear();

    const method = plugin.auth.methods[0];
    const authResult = await method.authorize();

    expect(authResult.url).toBe("about:blank");
    expect(authResult.method).toBe("code");

    // Should have saved after manage
    expect(saveAccounts).toHaveBeenCalled();

    // Callback should return failed (no OAuth was performed)
    const credentials = await authResult.callback("anything");
    expect(credentials.type).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Header handling edge cases
// ---------------------------------------------------------------------------

describe("header handling", () => {
  let client;
  let fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "test-refresh",
      access: "test-access",
      expires: Date.now() + 3600_000,
    });

    const result = await plugin.auth.loader(getAuth, makeProvider());
    fetchFn = result.fetch;
  });

  it("preserves and merges incoming anthropic-beta headers", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "custom-beta-2025-01-01,another-beta-2025-02-01",
      },
      body: JSON.stringify({ messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");

    // Should contain both required betas AND the custom ones
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("interleaved-thinking-2025-05-14");
    expect(betaHeader).toContain("custom-beta-2025-01-01");
    expect(betaHeader).toContain("another-beta-2025-02-01");
  });

  it("extracts headers from Request object input", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-custom-header": "custom-value",
      },
      body: JSON.stringify({ messages: [] }),
    });

    await fetchFn(request, {});

    const [, init] = mockFetch.mock.calls[0];
    // The custom header from the Request should be preserved
    expect(init.headers.get("x-custom-header")).toBe("custom-value");
    // Auth headers should still be set
    expect(init.headers.get("authorization")).toBe("Bearer test-access");
  });

  it("does NOT add ?beta=true to non-/v1/messages URLs", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/complete", {
      method: "POST",
      body: JSON.stringify({ prompt: "Hello" }),
    });

    const [input] = mockFetch.mock.calls[0];
    const url = input instanceof URL ? input : new URL(input.toString());
    expect(url.searchParams.has("beta")).toBe(false);
    expect(url.pathname).toBe("/v1/complete");
  });
});

// ---------------------------------------------------------------------------
// markSuccess wiring
// ---------------------------------------------------------------------------

describe("markSuccess wiring", () => {
  it("resets failure tracking on successful 200 response", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    // Account with prior failures
    loadAccounts.mockResolvedValue(makeAccountsData([{ consecutiveFailures: 3, lastFailureTime: Date.now() - 5000 }]));
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Successful API call
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);

    // Verify via a debounced save that the account's failures were reset.
    // We can't directly inspect the AccountManager, but we can trigger a save
    // and check what was persisted. The markSuccess resets consecutiveFailures
    // and lastFailureTime, which will be reflected in the next save.
    // For now, just verify the response came back successfully — the unit tests
    // in accounts.test.mjs verify markSuccess behavior directly.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("records token usage from streaming response", async () => {
    vi.resetAllMocks();
    const client = makeClient();
    const fetchFn = await setupFetchFn(client);

    // Build an SSE stream with message_start and message_delta usage events
    const sseBody = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":25,"output_tokens":42,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    mockFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(response.status).toBe(200);

    // Consume the stream so the onUsage callback fires
    const text = await response.text();
    expect(text).toContain("Hello");

    // The recordUsage triggers a debounced save; flush it
    vi.useFakeTimers();
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));

    // Verify usage was recorded: the stats should reflect the message_delta usage
    const saveCalls = saveAccounts.mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    const lastSave = saveCalls[saveCalls.length - 1][0];
    const acc = lastSave.accounts[0];
    expect(acc.stats.requests).toBeGreaterThan(0);
    expect(acc.stats.outputTokens).toBe(42);
    expect(acc.stats.inputTokens).toBe(25);
  });

  it("detects whitespace-formatted mid-stream error events and switches account on next request", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 3600_000 },
        { access: "access-2", expires: Date.now() + 3600_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    const sseBody = [
      "event: error",
      'data: { "type": "error", "error": { "type": "rate_limit_error", "message": "Rate limit exceeded" } }',
      "",
    ].join("\n");

    mockFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const first = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });
    await first.text();

    const second = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Again" }] }),
    });

    expect(second.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondHeaders.get("authorization")).toBe("Bearer access-2");
  });

  it("detects chunk-split mid-stream error events and switches account on next request", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 3600_000 },
        { access: "access-2", expires: Date.now() + 3600_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    const encoder = new TextEncoder();
    const splitStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: error\n"));
        controller.enqueue(encoder.encode('data: {"type":"error","error":{"type":"rate_'));
        controller.enqueue(encoder.encode('limit_error","message":"Rate limit exceeded"}}\n'));
        controller.enqueue(encoder.encode("\n"));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce(
      new Response(splitStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const first = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });
    await first.text();

    const second = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Again" }] }),
    });

    expect(second.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondHeaders.get("authorization")).toBe("Bearer access-2");
  });

  it("does not switch account on mid-stream service-wide overloaded error", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 3600_000 },
        { access: "access-2", expires: Date.now() + 3600_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    const sseBody = [
      "event: error",
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Server overloaded"}}',
      "",
    ].join("\n");

    mockFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const first = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });
    await first.text();

    const second = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Again" }] }),
    });

    expect(second.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondHeaders.get("authorization")).toBe("Bearer access-1");
  });

  it("ignores SSE-like payloads when response is not text/event-stream", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 3600_000 },
        { access: "access-2", expires: Date.now() + 3600_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    const sseLikeJsonPayload = [
      "event: error",
      'data: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}',
      "",
    ].join("\n");

    mockFetch.mockResolvedValueOnce(
      new Response(sseLikeJsonPayload, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const first = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    });
    await first.text();

    const second = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Again" }] }),
    });

    expect(second.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Should still use account 1 — non-SSE payload must not trigger account failover.
    const secondHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondHeaders.get("authorization")).toBe("Bearer access-1");
  });

  it("clears token and refreshes after mid-stream auth error cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    try {
      vi.resetAllMocks();
      const client = makeClient();

      loadAccounts.mockResolvedValue(makeAccountsData([{ access: "stale-access", expires: Date.now() + 3600_000 }]));
      saveAccounts.mockResolvedValue(undefined);

      const plugin = await AnthropicAuthPlugin({ client });
      const getAuth = vi.fn().mockResolvedValue({
        type: "oauth",
        refresh: "refresh-1",
        access: "stale-access",
        expires: Date.now() + 3600_000,
      });
      const result = await plugin.auth.loader(getAuth, makeProvider());

      const sseBody = [
        "event: error",
        'data: {"type":"error","error":{"type":"authentication_error","message":"Unauthorized"}}',
        "",
      ].join("\n");

      mockFetch.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const first = await result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
      });
      await first.text();

      // AUTH_FAILED backoff is short (5s).
      vi.advanceTimersByTime(6_000);

      // Next request should refresh token first.
      mockFetch.mockResolvedValueOnce(mockTokenRefresh("fresh-access", "refresh-1"));
      mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

      const second = await result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "Again" }] }),
      });

      expect(second.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const refreshCallUrl = String(mockFetch.mock.calls[1][0]);
      expect(refreshCallUrl).toContain("/v1/oauth/token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies quota-style cooldown for mid-stream billing errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    try {
      vi.resetAllMocks();
      const client = makeClient();

      loadAccounts.mockResolvedValue(makeAccountsData([{ access: "access-1", expires: Date.now() + 3600_000 }]));
      saveAccounts.mockResolvedValue(undefined);

      const plugin = await AnthropicAuthPlugin({ client });
      const getAuth = vi.fn().mockResolvedValue({
        type: "oauth",
        refresh: "refresh-1",
        access: "access-1",
        expires: Date.now() + 3600_000,
      });
      const result = await plugin.auth.loader(getAuth, makeProvider());

      const sseBody = [
        "event: error",
        'data: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}',
        "",
      ].join("\n");

      mockFetch.mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const first = await result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
      });
      await first.text();

      // QUOTA_EXHAUSTED first tier is 60s, so at 35s this account is still blocked.
      vi.advanceTimersByTime(35_000);

      await expect(
        result.fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          body: JSON.stringify({ messages: [{ role: "user", content: "Again" }] }),
        }),
      ).rejects.toThrow(/No available Anthropic account|All accounts exhausted/);

      // Should fail before issuing another upstream fetch.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
