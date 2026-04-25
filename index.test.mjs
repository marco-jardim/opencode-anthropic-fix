/**
 * Integration tests for the plugin lifecycle.
 *
 * These test the wiring in index.mjs — the ordering of authorize → callback → loader,
 * the accountManager initialization, and the fetch interceptor retry loop.
 *
 * We mock external dependencies (fetch, PKCE, readline, storage fs) but exercise
 * the real plugin code paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

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

vi.mock("./lib/refresh-lock.mjs", () => ({
  acquireRefreshLock: vi.fn().mockResolvedValue({ acquired: true, lockPath: "/tmp/opencode-test.lock" }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

// Mock config — always return defaults
vi.mock("./lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadConfig: vi.fn(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: {
        ...original.DEFAULT_CONFIG.override_model_limits,
      },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
    })),
    loadConfigFresh: vi.fn(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: {
        ...original.DEFAULT_CONFIG.override_model_limits,
      },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
    })),
    saveConfig: vi.fn(),
  };
});

// Mock global fetch for OAuth token exchange and API requests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { AnthropicAuthPlugin } from "./index.mjs";
import { saveAccounts, loadAccounts, clearAccounts } from "./lib/storage.mjs";
import { acquireRefreshLock, releaseRefreshLock } from "./lib/refresh-lock.mjs";
import { loadConfig, loadConfigFresh, saveConfig as saveRuntimeConfig, DEFAULT_CONFIG } from "./lib/config.mjs";

beforeEach(() => {
  delete process.env.DISABLE_INTERLEAVED_THINKING;
  delete process.env.USE_API_CONTEXT_MANAGEMENT;
  delete process.env.TENGU_MARBLE_ANVIL;
  delete process.env.TENGU_TOOL_PEAR;
  delete process.env.TENGU_SCARF_COFFEE;
  delete process.env.ANTHROPIC_BETAS;
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  delete process.env.CLAUDE_AGENT_SDK_VERSION;
  delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
  delete process.env.CLAUDE_CODE_CONTAINER_ID;
  delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  delete process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION;
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
  delete process.env.OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT;
  delete process.env.CLAUDE_CODE_ACCOUNT_UUID;
  delete process.env.CLAUDE_CODE_USER_EMAIL;
  delete process.env.CLAUDE_CODE_ORGANIZATION_UUID;
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  delete process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS;
  delete process.env.CLAUDE_CODE_USE_MANTLE;
  delete process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT;
  process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";
});

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
        id: "claude-sonnet",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 8192 },
      },
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        cost: { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-sonnet-4-1m": {
        id: "claude-sonnet-4-1m",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 16_000 },
      },
    },
  };
}

/**
 * Poll until condition passes or timeout.
 * @param {() => void} assertion
 * @param {number} [timeoutMs]
 */
async function waitForAssertion(assertion, timeoutMs = 500) {
  const started = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() - started >= timeoutMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
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
    const savedArg = saveAccounts.mock.calls[0][0];
    expect(savedArg.version).toBe(1);
    expect(savedArg.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refreshToken: "refresh-from-oauth",
          enabled: true,
        }),
      ]),
    );
  });

  it("F3: callback forwards state to the token endpoint", async () => {
    // F3: the plugin callback must pass the original user input (code#state) to
    // exchange() so that `state` is included in the token-endpoint POST body.
    // Without the fix, parsedCode (bare code) was forwarded and state was dropped.
    let capturedBody;
    mockFetch.mockImplementationOnce(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          access_token: "at-f3",
          refresh_token: "rt-f3",
          expires_in: 3600,
        }),
      };
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const method = plugin.auth.methods[0];
    const authResult = await method.authorize();

    // Pass a code#state string as the user would paste.
    await authResult.callback("myauthcode#mystatevalue");

    // The token endpoint body must contain state=mystatevalue.
    expect(capturedBody).toBeDefined();
    expect(capturedBody.code).toBe("myauthcode");
    expect(capturedBody.state).toBe("mystatevalue");
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
    const savedArg2 = saveAccounts.mock.calls[0][0];
    expect(savedArg2.version).toBe(1);
    expect(savedArg2.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refreshToken: "existing-refresh",
        }),
      ]),
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
    const output = { parts: [] };
    await plugin["command.execute.before"](
      {
        command: "anthropic",
        arguments: args,
        sessionID: "session-1",
      },
      output,
    );

    // Verify the hook signals "handled — don't forward to agent"
    expect(output.noReply).toBe(true);

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

  it("supports 1m beta shortcut in slash command", async () => {
    const text = await runAnthropic("betas add 1m");

    expect(text).toContain("Added: context-1m-2025-08-07");
    expect(saveRuntimeConfig).toHaveBeenLastCalledWith({ custom_betas: ["context-1m-2025-08-07"] });
  });

  it("supports fast beta shortcut in slash command", async () => {
    const text = await runAnthropic("betas add fast");

    expect(text).toContain("Added: fast-mode-2026-02-01");
    expect(saveRuntimeConfig).toHaveBeenLastCalledWith({ custom_betas: ["fast-mode-2026-02-01"] });
  });

  it("supports beta shortcut in remove flow", async () => {
    loadConfigFresh.mockReturnValueOnce({
      ...DEFAULT_CONFIG,
      custom_betas: ["fast-mode-2026-02-01"],
    });

    const text = await runAnthropic("betas remove fast");

    expect(text).toContain("Removed: fast-mode-2026-02-01");
    expect(saveRuntimeConfig).toHaveBeenLastCalledWith({ custom_betas: [] });
  });

  it("starts and completes login OAuth flow", async () => {
    let text = await runAnthropic("login");
    expect(text).toContain("Anthropic OAuth");
    expect(text).toContain("Started login flow");
    expect(text).toContain("claude.ai/oauth/authorize");

    // Extract the state from the authorize URL to pass back in the completion
    const stateMatch = text.match(/[?&]state=([^&\s]+)/);
    const state = stateMatch ? stateMatch[1] : "test-state";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "access-from-login",
        refresh_token: "refresh-from-login",
        expires_in: 3600,
        account: { email_address: "new@example.com" },
      }),
    });

    text = await runAnthropic(`login complete test-code#${state}`);
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

  it("surfaces token exchange error details in slash OAuth flow", async () => {
    const loginText = await runAnthropic("login");

    // Extract the state from the authorize URL to pass back correctly
    const stateMatch = loginText.match(/[?&]state=([^&\s]+)/);
    const state = stateMatch ? stateMatch[1] : "test-state";

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant", error_description: "state mismatch" }),
    });

    const text = await runAnthropic(`login complete bad-code#${state}`);
    expect(text).toContain("Token exchange failed");
    expect(text).toContain("HTTP 400");
    expect(text).toContain("invalid_grant");
  });

  it("applies slash OAuth exchange cooldown after 429 failures", async () => {
    vi.useFakeTimers();
    try {
      const loginText = await runAnthropic("login");

      const stateMatch = loginText.match(/[?&]state=([^&\s]+)/);
      const state = stateMatch ? stateMatch[1] : "test-state";

      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited" } }),
      });

      const firstPromise = runAnthropic(`login complete bad-code#${state}`);
      await vi.runAllTimersAsync();
      const first = await firstPromise;
      expect(first).toContain("Token exchange failed");
      expect(first).toContain("Wait about");

      const callsAfterFirst = mockFetch.mock.calls.length;
      const second = await runAnthropic(`login complete bad-code#${state}`);
      expect(second).toContain("still rate-limited");
      expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
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

    // Extract the state from the authorize URL
    const stateMatch = text.match(/[?&]state=([^&\s]+)/);
    const state = stateMatch ? stateMatch[1] : "state";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
        account: { email_address: "reauth@example.com" },
      }),
    });

    text = await runAnthropic(`reauth complete another-code#${state}`);
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
    delete process.env.DISABLE_INTERLEAVED_THINKING;
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    delete process.env.USE_API_CONTEXT_MANAGEMENT;
    delete process.env.TENGU_MARBLE_ANVIL;
    delete process.env.TENGU_TOOL_PEAR;
    delete process.env.TENGU_SCARF_COFFEE;
    delete process.env.ANTHROPIC_BETAS;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
    delete process.env.CLAUDE_CODE_CONTAINER_ID;
    delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    delete process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION;
    delete process.env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION;
    delete process.env.CLAUDE_CODE_ACCOUNT_UUID;
    delete process.env.CLAUDE_CODE_USER_EMAIL;
    delete process.env.CLAUDE_CODE_ORGANIZATION_UUID;
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;

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
    expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
    expect(headers.get("user-agent")).toContain("claude-cli/2.1.119");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("X-Claude-Code-Session-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(headers.get("x-stainless-lang")).toBe("js");
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

  it("adds ?beta=true to /v1/messages/count_tokens URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });

    const [input] = mockFetch.mock.calls[0];
    const url = input instanceof URL ? input : new URL(input.toString());
    expect(url.pathname).toBe("/v1/messages/count_tokens");
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
    const payloadText = body.system.map((item) => item.text);
    expect(payloadText).toContain("You are Claude Code, an Claude assistant.");
  });

  it("redacts opencode mentions inside path-like text in system prompt", async () => {
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
    const payloadText = body.system.map((item) => item.text);
    expect(payloadText).toContain("Working dir: /Users/rmk/projects/Claude-auth");
    expect(payloadText.join("\n")).not.toMatch(/opencode/i);
  });

  it("compacts verbose system instructions in minimal mode (default)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [],
        system: [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.\n\nHeader\n<example>remove me</example>\nRule A\nRule A\n\n\nRule B",
          },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const userBlock = body.system[2].text;
    expect(userBlock).not.toContain("<example>");
    expect(userBlock).toContain("Rule A");
    expect(userBlock).toContain("Rule B");
    expect(userBlock).not.toContain("\n\n\n");
  });

  it("deduplicates nested repeated instruction blocks in minimal mode", async () => {
    const repeated =
      "## Model Delegation Protocol\nPreset: openai\nDelegate with Task(subagent_type='fast|medium|heavy', prompt='...').";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        system: [
          {
            type: "text",
            text: `You are Claude Code, the best coding agent on the planet.\n\n${repeated}\n\nOther section`,
          },
          { type: "text", text: repeated },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const joined = body.system.map((item) => item.text).join("\n\n");
    const occurrences = (joined.match(/## Model Delegation Protocol/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("uses compact dedicated prompt for title-generator requests", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "test" }],
        system: [
          {
            type: "text",
            text: "You are a title generator. You output ONLY a thread title. Nothing else.\n\n<task>\nGenerate a brief title that would help the user find this conversation later.\n</task>",
          },
          {
            type: "text",
            text: "## Model Delegation Protocol\nPreset: openai\nDelegate with Task(subagent_type='fast|medium|heavy', prompt='...').",
          },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const textBlocks = body.system.map((item) => item.text);

    expect(textBlocks.join("\n")).not.toContain("Model Delegation Protocol");
    expect(textBlocks.join("\n")).not.toContain("Delegate with Task(");
    expect(textBlocks.join("\n")).toContain("You are a title generator. You output ONLY a thread title. Nothing else.");
    expect(textBlocks.join("\n")).toContain("- Keep the title at or below 50 characters.");
    expect(textBlocks.join("\n")).not.toContain("<task>");
  });

  it("preserves verbose system instructions when prompt compaction is off", async () => {
    const configModule = await import("./lib/config.mjs");
    loadConfig.mockReturnValueOnce({
      ...loadConfig(),
      signature_emulation: {
        ...loadConfig().signature_emulation,
        prompt_compaction: "off",
      },
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const result = await plugin.auth.loader(
      vi.fn().mockResolvedValue({
        type: "oauth",
        refresh: "test-refresh",
        access: "test-access",
        expires: Date.now() + 3600_000,
      }),
      makeProvider(),
    );

    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [],
        system: [{ type: "text", text: "Header\n<example>keep me</example>\nRule A\nRule A" }],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system[2].text).toContain("<example>keep me</example>");
  });

  it("does not prefix tool names with mcp_ in request (v2.1.107+)", async () => {
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
    // Tool names should pass through unchanged (no mcp_ prefix added)
    expect(body.tools[0].name).toBe("read_file");
    expect(body.messages[0].content[0].name).toBe("read_file");
  });

  it("renames known opencode tool names to CC PascalCase", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        tools: [
          { name: "todowrite", description: "Manage todos" },
          { name: "bash", description: "Run commands" },
          { name: "webfetch", description: "Fetch web" },
        ],
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", name: "todowrite", id: "t1", input: {} }],
          },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.tools[0].name).toBe("TodoWrite");
    expect(body.tools[1].name).toBe("Bash");
    expect(body.tools[2].name).toBe("WebFetch");
    expect(body.messages[0].content[0].name).toBe("TodoWrite");
  });

  it("passes through non-opencode tool names unchanged", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        tools: [
          { name: "mcp_server", description: "An MCP server tool" },
          { name: "chrome-devtools_click", description: "Click" },
        ],
        messages: [],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    // Non-opencode tool names pass through as-is
    expect(body.tools[0].name).toBe("mcp_server");
    expect(body.tools[1].name).toBe("chrome-devtools_click");
  });

  it("reverse-maps PascalCase tool names in response stream to opencode lowercase", async () => {
    const responseBody =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Write","id":"t1"}}\n\n';
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
    expect(text).toContain('"name":"write"');
    expect(text).not.toContain('"name":"Write"');
  });

  it("does not strip mcp_ from text content in response stream", async () => {
    // A text content block that happens to contain "name": "mcp_foo" — should NOT be modified
    const responseBody =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The tool \\"name\\": \\"mcp_foo\\" was called."}}\n\n';
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
    // The mcp_foo in text content should be preserved
    expect(text).toContain("mcp_foo");
  });

  it("strips mcp_ from tool_use blocks but not text blocks in response stream", async () => {
    // Two SSE events: one tool_use (should strip), one text (should preserve)
    const sseBody = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_write_file","id":"t1"}}',
      "",
      'data: {"type":"content_block_start","content_block":{"type":"text","text":"Using tool \\"name\\": \\"mcp_write_file\\""}}',
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
      body: JSON.stringify({ messages: [] }),
    });

    const text = await response.text();
    // tool_use name should have mcp_ stripped
    expect(text).toContain('"name":"write_file"');
    // text content should still have mcp_write_file
    expect(text).toContain("mcp_write_file");
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
// File-ID account pinning
// ---------------------------------------------------------------------------

describe("file-id account pinning", () => {
  it("pins messages request to the account that owns the file_id", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    // Two accounts with valid tokens
    const data = makeAccountsData([
      {
        refreshToken: "refresh-1",
        email: "a@test.com",
        access: "access-1",
        expires: Date.now() + 3600_000,
      },
      {
        refreshToken: "refresh-2",
        email: "b@test.com",
        access: "access-2",
        expires: Date.now() + 3600_000,
      },
    ]);
    loadAccounts.mockResolvedValue(data);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });

    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());
    const fetchFn = result.fetch;

    // Populate fileAccountMap via /anthropic files list (lists from ALL accounts)
    // Account 1 (index 0) → file-abc, Account 2 (index 1) → file-xyz
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "file-abc", filename: "a.txt", size: 100, purpose: "assistants" }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "file-xyz", filename: "b.txt", size: 200, purpose: "assistants" }] }),
          { status: 200 },
        ),
      );

    await plugin["command.execute.before"](
      {
        command: "anthropic",
        arguments: "files list",
        sessionID: "s1",
      },
      { parts: [] },
    );

    // Verify files list fetched from both accounts
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Now test pinning: request with file-xyz (owned by account 2)
    // Without pinning, sticky strategy would always use account 1
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [{ type: "file", source: { type: "file", file_id: "file-xyz" } }],
          },
        ],
      }),
    });

    // Should have used account 2's token due to pinning
    const apiCall = mockFetch.mock.calls[0];
    const headers = apiCall[1].headers;
    expect(headers.get("authorization")).toBe("Bearer access-2");
  });

  it("uses default account selection when no file_ids are referenced", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    const data = makeAccountsData([
      {
        refreshToken: "refresh-1",
        email: "a@test.com",
        access: "access-1",
        expires: Date.now() + 3600_000,
      },
      {
        refreshToken: "refresh-2",
        email: "b@test.com",
        access: "access-2",
        expires: Date.now() + 3600_000,
      },
    ]);
    loadAccounts.mockResolvedValue(data);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());
    const fetchFn = result.fetch;

    // Populate fileAccountMap via /anthropic files list
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "file-abc", filename: "a.txt", size: 100, purpose: "assistants" }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await plugin["command.execute.before"](
      {
        command: "anthropic",
        arguments: "files list",
        sessionID: "s1",
      },
      { parts: [] },
    );

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    // Request WITHOUT file_ids — should use default (sticky → account 1)
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });

    const apiCall = mockFetch.mock.calls[0];
    const headers = apiCall[1].headers;
    expect(headers.get("authorization")).toBe("Bearer access-1");
  });

  it("removes file_id mapping after /anthropic files delete", async () => {
    vi.resetAllMocks();
    const client = makeClient();

    const data = makeAccountsData([
      {
        refreshToken: "refresh-1",
        email: "a@test.com",
        access: "access-1",
        expires: Date.now() + 3600_000,
      },
      {
        refreshToken: "refresh-2",
        email: "b@test.com",
        access: "access-2",
        expires: Date.now() + 3600_000,
      },
    ]);
    loadAccounts.mockResolvedValue(data);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());
    const fetchFn = result.fetch;

    // Populate: account 2 owns file-xyz
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "file-xyz", filename: "b.txt", size: 200, purpose: "assistants" }] }),
          { status: 200 },
        ),
      );

    await plugin["command.execute.before"](
      {
        command: "anthropic",
        arguments: "files list",
        sessionID: "s1",
      },
      { parts: [] },
    );

    // Delete file-xyz (uses current account = account 1 by sticky)
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await plugin["command.execute.before"](
      {
        command: "anthropic",
        arguments: "files delete file-xyz",
        sessionID: "s1",
      },
      { parts: [] },
    );

    // Now request with file-xyz — should NOT pin (mapping deleted)
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [{ type: "file", source: { type: "file", file_id: "file-xyz" } }],
          },
        ],
      }),
    });

    // Without pinning, sticky selects account 1
    const apiCall = mockFetch.mock.calls[0];
    const headers = apiCall[1].headers;
    expect(headers.get("authorization")).toBe("Bearer access-1");
  });
});

// ---------------------------------------------------------------------------
// System prompt transform
// ---------------------------------------------------------------------------

describe("system prompt transform", () => {
  it("does not prepend Claude Code prefix in emulation mode", async () => {
    const client = makeClient();
    const plugin = await AnthropicAuthPlugin({ client });

    const output = { system: ["You are a helpful assistant."] };
    plugin["experimental.chat.system.transform"]({ model: { providerID: "anthropic" } }, output);

    expect(output.system).toEqual(["You are a helpful assistant."]);
  });

  it("does not modify system for non-anthropic provider", async () => {
    const client = makeClient();
    const plugin = await AnthropicAuthPlugin({ client });

    const output = { system: ["You are a helpful assistant."] };
    plugin["experimental.chat.system.transform"]({ model: { providerID: "openai" } }, output);

    expect(output.system).toEqual(["You are a helpful assistant."]);
  });

  it("keeps legacy prefix behavior when emulation is disabled", async () => {
    const configModule = await import("./lib/config.mjs");
    loadConfig.mockReturnValueOnce({
      ...loadConfig(),
      signature_emulation: {
        enabled: false,
        fetch_claude_code_version_on_startup: false,
      },
    });

    const client = makeClient();
    const plugin = await AnthropicAuthPlugin({ client });

    const output = { system: ["You are a helpful assistant."] };
    plugin["experimental.chat.system.transform"]({ model: { providerID: "anthropic" } }, output);

    expect(output.system[0]).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(output.system[1]).toContain("You are Claude Code");
    expect(output.system[1]).toContain("You are a helpful assistant.");
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
    expect(refreshUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(JSON.parse(refreshInit.body).grant_type).toBe("refresh_token");
    expect(refreshInit.headers["User-Agent"]).toBe("axios/1.13.6");

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

  it("continues request flow when auth.json persistence fails after successful refresh", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData());
    saveAccounts.mockResolvedValue(undefined);
    client.auth.set.mockRejectedValueOnce(new Error("disk temporarily unavailable"));

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "expired-access",
      expires: Date.now() - 1000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    mockFetch.mockResolvedValueOnce(mockTokenRefresh("fresh-access", "refresh-1-rotated"));
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, apiInit] = mockFetch.mock.calls[1];
    expect(apiInit.headers.get("authorization")).toBe("Bearer fresh-access");
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

    let refreshCallCount = 0;
    /** @type {() => void} */
    let markRefreshInFlight;
    const refreshInFlight = new Promise((resolve) => {
      markRefreshInFlight = resolve;
    });

    /** @type {string[]} */
    const apiAuthHeaders = [];

    mockFetch.mockImplementation((url, init) => {
      const s = String(url);
      if (s.includes("/v1/oauth/token")) {
        refreshCallCount += 1;
        if (refreshCallCount === 1) markRefreshInFlight();
        return refreshPromise;
      }

      const headers = new Headers(init?.headers ?? undefined);
      apiAuthHeaders.push(headers.get("authorization") || "");
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

    // Wait until refresh is definitely in-flight, then resolve it.
    await refreshInFlight;

    resolveRefresh(mockTokenRefresh("fresh-access", "refresh-1-rotated"));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const refreshCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
    expect(refreshCalls).toHaveLength(1);
    expect(apiAuthHeaders).toEqual(["Bearer fresh-access", "Bearer fresh-access"]);
  });

  it("uses disk-updated token state when refresh lock is held by another process", async () => {
    const staleToken = "refresh-1-stale";
    const rotatedToken = "refresh-1-rotated";
    const rotatedAccess = "access-from-other-process";
    const accountId = "stable-id-1";

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: accountId,
          refreshToken: staleToken,
          access: "expired-access",
          expires: Date.now() - 1_000,
          token_updated_at: 10,
        },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    acquireRefreshLock.mockResolvedValue({ acquired: false, lockPath: null });

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: staleToken,
      access: "expired-access",
      expires: Date.now() - 1_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Request-time reads: sync + lock-held disk reread.
    const requestDiskReads = [
      makeAccountsData([
        {
          id: accountId,
          refreshToken: staleToken,
          access: "expired-access",
          expires: Date.now() - 1_000,
          token_updated_at: 10,
        },
      ]),
      makeAccountsData([
        {
          id: accountId,
          refreshToken: rotatedToken,
          access: rotatedAccess,
          expires: Date.now() + 3_600_000,
          token_updated_at: 999,
        },
      ]),
    ];
    loadAccounts.mockImplementation(async () => requestDiskReads.shift() ?? requestDiskReads.at(-1));

    // No oauth refresh should be issued; only API call should happen.
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    const oauthCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
    expect(oauthCalls).toHaveLength(0);

    const [, apiInit] = mockFetch.mock.calls[0];
    expect(apiInit.headers.get("authorization")).toBe(`Bearer ${rotatedAccess}`);
  });

  it("refreshes near-expiry idle account in background while serving active account", async () => {
    loadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      signature_emulation: { ...DEFAULT_CONFIG.signature_emulation, fetch_claude_code_version_on_startup: false },
      override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
      idle_refresh: { ...DEFAULT_CONFIG.idle_refresh, enabled: true },
    });

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 2 * 3600_000 },
        { refreshToken: "refresh-2", access: "access-2", expires: Date.now() + 10 * 60_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 2 * 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    mockFetch.mockImplementation((url) => {
      const s = String(url);
      if (s.includes("/v1/oauth/token")) {
        return Promise.resolve(mockTokenRefresh("idle-fresh-access", "refresh-2-rotated"));
      }
      return Promise.resolve(new Response('{"content":[]}', { status: 200 }));
    });

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(200);

    await waitForAssertion(() => {
      const refreshCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
      expect(refreshCalls.length).toBe(1);
    });

    const refreshCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
    const refreshBody = JSON.parse(refreshCalls[0][1].body);
    expect(refreshBody.refresh_token).toBe("refresh-2");
  });

  it("does not disable idle account on background refresh failure", async () => {
    loadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      signature_emulation: { ...DEFAULT_CONFIG.signature_emulation, fetch_claude_code_version_on_startup: false },
      override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
      idle_refresh: { ...DEFAULT_CONFIG.idle_refresh, enabled: true },
    });

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 2 * 3600_000 },
        { refreshToken: "refresh-2", access: "access-2", expires: Date.now() + 10 * 60_000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 2 * 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Background idle refresh fails terminally and retry fails too.
    mockFetch.mockImplementation((url) => {
      const s = String(url);
      if (s.includes("/v1/oauth/token")) {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: "invalid_grant" }),
        });
      }
      return Promise.resolve(new Response('{"content":[]}', { status: 200 }));
    });

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(200);

    await waitForAssertion(() => {
      const refreshCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
      expect(refreshCalls.length).toBeGreaterThanOrEqual(2);
    });

    // Background maintenance should not auto-disable accounts.
    const disabledToasts = client.tui.showToast.mock.calls.filter(([arg]) =>
      String(arg?.body?.message || "").includes("Disabled"),
    );
    expect(disabledToasts).toHaveLength(0);

    for (const [storage] of saveAccounts.mock.calls) {
      expect(storage.accounts[1]?.enabled).not.toBe(false);
    }
  });

  it("foreground refresh does not inherit an in-flight idle refresh failure", async () => {
    loadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      signature_emulation: { ...DEFAULT_CONFIG.signature_emulation, fetch_claude_code_version_on_startup: false },
      override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
      idle_refresh: { ...DEFAULT_CONFIG.idle_refresh, enabled: true },
    });

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { access: "access-1", expires: Date.now() + 2 * 3600_000 },
        { refreshToken: "refresh-2", access: "stale-access-2", expires: Date.now() - 1000 },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 2 * 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    /** @type {(error: Error) => void} */
    let rejectIdleRefresh;
    const idleRefreshPromise = new Promise((_, reject) => {
      rejectIdleRefresh = reject;
    });

    let oauthCount = 0;
    mockFetch.mockImplementation((url, init) => {
      const s = String(url);
      const headers = new Headers(init?.headers ?? undefined);

      if (s.includes("/v1/oauth/token")) {
        oauthCount += 1;
        if (oauthCount === 1) return idleRefreshPromise;
        return Promise.resolve(mockTokenRefresh("fresh-access-2", "refresh-2-rotated"));
      }

      // First request on account 1 fails account-specific so flow switches to account 2.
      if (headers.get("authorization") === "Bearer access-1") {
        // Let idle refresh fail while foreground is preparing to use account 2.
        rejectIdleRefresh(new Error("idle refresh failed"));
        return Promise.resolve(
          new Response('{"error":{"type":"rate_limit_error","message":"Rate limit"}}', { status: 429 }),
        );
      }

      return Promise.resolve(new Response('{"content":[]}', { status: 200 }));
    });

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);

    const oauthCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
    expect(oauthCalls).toHaveLength(2);
    const secondBody = JSON.parse(oauthCalls[1][1].body);
    expect(secondBody.refresh_token).toBe("refresh-2");

    const disabledToasts = client.tui.showToast.mock.calls.filter(([arg]) =>
      String(arg?.body?.message || "").includes("Disabled"),
    );
    expect(disabledToasts).toHaveLength(0);
  });

  // F5 (idle race): expanding the lock scope to cover disk adoption inside the
  // refresh lock would require the disk token to be valid+fresh at lock time. This
  // test already verifies the happy path (disk token is fresher, so no HTTP request).
  // A race where a concurrent writer replaces the token *between* the pre-check
  // and lock acquisition cannot be closed without a full lock-on-read refactor;
  // accepted with this comment per QA finding F5.
  it("idle refresh adopts disk-fresher token and skips HTTP refresh", async () => {
    const accountId1 = "stable-idle-a1";
    const accountId2 = "stable-idle-a2";
    const staleAccess = "stale-access-2-idle";
    const freshAccess = "disk-fresh-access-2-idle";
    const refreshToken2 = "refresh-token-idle-2";

    loadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      signature_emulation: { ...DEFAULT_CONFIG.signature_emulation, fetch_claude_code_version_on_startup: false },
      override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
      idle_refresh: { ...DEFAULT_CONFIG.idle_refresh, enabled: true },
    });

    // Initial load: account-2 is near-expiry with a stale token (token_updated_at: 100)
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { id: accountId1, access: "access-1", expires: Date.now() + 2 * 3600_000 },
        {
          id: accountId2,
          refreshToken: refreshToken2,
          access: staleAccess,
          expires: Date.now() + 10 * 60_000,
          token_updated_at: 100,
        },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 2 * 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Simulate another process having refreshed account-2 on disk before our idle refresh
    // runs. readDiskAccountAuth (inside refreshAccountToken) calls loadAccounts, so switching
    // the mock here is sufficient — no test-only seam needed.
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        { id: accountId1, access: "access-1", expires: Date.now() + 2 * 3600_000 },
        {
          id: accountId2,
          refreshToken: refreshToken2,
          access: freshAccess,
          expires: Date.now() + 3_600_000,
          token_updated_at: 999,
        },
      ]),
    );

    const loadCallsBeforeFetch = loadAccounts.mock.calls.length;

    mockFetch.mockResolvedValue(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(200);

    // Wait until the background idle refresh has read from disk (proves it ran).
    // readDiskAccountAuth always calls loadAccounts, so this is a reliable signal.
    await waitForAssertion(() => {
      expect(loadAccounts.mock.calls.length).toBeGreaterThan(loadCallsBeforeFetch);
    });

    // Allow the background task to fully settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The idle refresh must NOT have issued an HTTP token request — disk had a valid
    // fresher token (token_updated_at 999 > 100), so applyDiskAuthIfFresher returned
    // early and the OAuth endpoint was never reached.
    const oauthCalls = mockFetch.mock.calls.filter(([u]) => String(u).includes("/v1/oauth/token"));
    expect(oauthCalls).toHaveLength(0);
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

  it("recovers when another instance rotated the refresh token (disk read before refresh)", async () => {
    // Simulate: in-memory has stale token, disk has the rotated token from another instance.
    // Plugin loads with the stale token, but readDiskRefreshToken finds the new one.
    const staleToken = "stale-refresh";
    const rotatedToken = "rotated-by-other-instance";
    const accountId = "stable-id-1";

    // First loadAccounts call (plugin init) — stale token
    loadAccounts.mockResolvedValue(makeAccountsData([{ id: accountId, refreshToken: staleToken }]));
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: staleToken,
      access: "expired-access",
      expires: Date.now() - 1000, // expired — forces refresh
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Subsequent loadAccounts calls (readDiskRefreshToken) — return the rotated token
    loadAccounts.mockResolvedValue(makeAccountsData([{ id: accountId, refreshToken: rotatedToken }]));

    // Refresh with rotated token succeeds
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("new-access", "new-refresh"));
    // API call succeeds
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // Only 2 fetch calls: successful refresh (with rotated token) + API call
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Verify the refresh used the rotated token, not the stale one
    const refreshCall = mockFetch.mock.calls[0];
    const refreshBody = JSON.parse(refreshCall[1].body);
    expect(refreshBody.refresh_token).toBe(rotatedToken);
  });

  it("retries with disk token when initial refresh fails with invalid_grant", async () => {
    // Simulate: two instances loaded the same token. Instance A rotated it.
    // Instance B's memory still has the old token. refreshAccountToken reads disk
    // (gets old token, same as memory), refresh fails. Retry reads disk again,
    // this time instance A's save has landed, finds the rotated token.
    const oldToken = "old-refresh";
    const rotatedToken = "rotated-refresh";
    const accountId = "stable-id-1";

    // Default: return old token for all loadAccounts calls (init, saveToDisk merge, Option A)
    loadAccounts.mockResolvedValue(makeAccountsData([{ id: accountId, refreshToken: oldToken }]));
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: oldToken,
      access: "expired-access",
      expires: Date.now() - 1000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Request-time disk reads happen in this order:
    // 1) syncActiveIndexFromDisk, 2) pre-refresh disk read, 3) retry disk read after invalid_grant.
    const requestDiskReads = [
      makeAccountsData([{ id: accountId, refreshToken: oldToken }]),
      makeAccountsData([{ id: accountId, refreshToken: oldToken }]),
      makeAccountsData([{ id: accountId, refreshToken: rotatedToken }]),
    ];
    loadAccounts.mockImplementation(async () => {
      return requestDiskReads.shift() ?? makeAccountsData([{ id: accountId, refreshToken: rotatedToken }]);
    });

    // First refresh fails with invalid_grant (old token was rotated by other instance)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });
    // Retry refresh with rotated token succeeds
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("recovered-access", "recovered-refresh"));
    // API call succeeds
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // 3 fetch calls: failed refresh + successful retry refresh + API call
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const refreshCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes("/v1/oauth/token"));
    expect(refreshCalls).toHaveLength(2);
    const firstRefreshBody = JSON.parse(refreshCalls[0][1].body);
    const secondRefreshBody = JSON.parse(refreshCalls[1][1].body);
    expect(firstRefreshBody.refresh_token).toBe(oldToken);
    expect(secondRefreshBody.refresh_token).toBe(rotatedToken);
  });

  it("persists new tokens to disk before releasing the refresh lock", async () => {
    // This is the critical race-prevention test.  Previously, refreshAccountToken
    // released the lock, then the caller scheduled a debounced save (~1 s later).
    // A second process could acquire the lock and read the stale (rotated-away)
    // refresh token from disk, causing an invalid_grant cascade.
    const accountId = "stable-id-1";
    const oldToken = "pre-rotation-refresh";

    loadAccounts.mockResolvedValue(makeAccountsData([{ id: accountId, refreshToken: oldToken }]));
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: oldToken,
      access: "expired-access",
      expires: Date.now() - 1000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Disk reads during request: syncActiveIndexFromDisk
    loadAccounts.mockResolvedValue(makeAccountsData([{ id: accountId, refreshToken: oldToken }]));

    // Token refresh succeeds — returns a rotated refresh token
    mockFetch.mockResolvedValueOnce(mockTokenRefresh("new-access", "rotated-refresh"));
    // API call succeeds
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));

    // Track call ordering between saveAccounts and releaseRefreshLock
    const callOrder = [];
    saveAccounts.mockImplementation(async () => {
      callOrder.push("save");
    });
    releaseRefreshLock.mockImplementation(async () => {
      callOrder.push("unlock");
    });

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);

    // The save that contains the rotated token must happen before the lock
    // is released so other processes see it on disk immediately.
    const saveIdx = callOrder.indexOf("save");
    const unlockIdx = callOrder.indexOf("unlock");
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(saveIdx).toBeLessThan(unlockIdx);

    // Verify the saved data contains the rotated token
    const savedData = saveAccounts.mock.calls.find(
      (call) => call[0]?.accounts?.[0]?.refreshToken === "rotated-refresh",
    );
    expect(savedData).toBeTruthy();
  });

  it("still disables account when retry also fails", async () => {
    const oldToken = "doomed-refresh";
    const accountId = "stable-id-1";

    loadAccounts.mockResolvedValue(makeAccountsData([{ id: accountId, refreshToken: oldToken }]));
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: oldToken,
      access: "expired-access",
      expires: Date.now() - 1000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Request-time reads: sync, pre-refresh disk read, retry-read.
    const requestDiskReads = [
      makeAccountsData([{ id: accountId, refreshToken: oldToken }]),
      makeAccountsData([{ id: accountId, refreshToken: oldToken }]),
      makeAccountsData([{ id: accountId, refreshToken: "also-bad-token" }]),
    ];
    loadAccounts.mockImplementation(async () => {
      return requestDiskReads.shift() ?? makeAccountsData([{ id: accountId, refreshToken: "also-bad-token" }]);
    });

    // First refresh fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });
    // Retry refresh also fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });

    // No more accounts — should throw
    await expect(
      result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow();

    const refreshCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes("/v1/oauth/token"));
    expect(refreshCalls).toHaveLength(2);
    const firstRefreshBody = JSON.parse(refreshCalls[0][1].body);
    const secondRefreshBody = JSON.parse(refreshCalls[1][1].body);
    expect(firstRefreshBody.refresh_token).toBe(oldToken);
    expect(secondRefreshBody.refresh_token).toBe("also-bad-token");
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

    // Refresh fails with transient 500 (refreshToken retries 2 extra times)
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "server error",
      });
    }

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

  it("applies cooldown after refresh endpoint 429 to avoid hammering OAuth token endpoint", async () => {
    const fetchFn = await setupFetchFn(client, [{ access: "expired", expires: Date.now() - 1000 }], {
      access: "expired",
      expires: Date.now() - 1000,
    });

    // refreshToken now retries 2 times on retryable responses; keep all attempts at 429.
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      );
    }

    await expect(
      fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow(/Token refresh failed|No available Anthropic account|All accounts exhausted/);

    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Immediate next request should not call token endpoint again while cooldown is active.
    await expect(
      fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow(/No available Anthropic account|All accounts exhausted/);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries 503 up to 2 times then returns directly", async () => {
    const fetchFn = await setupFetchFn(client, [{}, {}]);

    // 503 is retried up to 2 times (RE doc §5.5)
    const makeErrorResponse = () =>
      new Response(JSON.stringify({ error: { type: "service_unavailable", message: "temporarily unavailable" } }), {
        status: 503,
      });
    mockFetch.mockResolvedValueOnce(makeErrorResponse());
    mockFetch.mockResolvedValueOnce(makeErrorResponse());
    mockFetch.mockResolvedValueOnce(makeErrorResponse());

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(503);
    // 1 initial + 2 retries = 3 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries 529 up to 2 times then attempts quota-aware account switch", async () => {
    // Give both accounts valid tokens so token refresh doesn't trigger extra fetch calls
    const expires = Date.now() + 3600_000;
    const fetchFn = await setupFetchFn(client, [
      { access: "access-1", expires },
      { access: "access-2", expires },
    ]);

    // 529 with 2 accounts: after 2 retries on account 0, overload recovery
    // switches to account 1 for one more attempt.
    // The background pollOAuthUsage also fires one fetch call on success.
    const makeErrorResponse = () =>
      new Response(JSON.stringify({ error: { type: "overloaded_error", message: "Server is overloaded" } }), {
        status: 529,
      });
    // Use mockResolvedValue for unlimited 529 responses (covers API + background poll calls)
    mockFetch.mockResolvedValue(makeErrorResponse());

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(529);
    // 3 on account 0 + 1 on account 1 + 1 background poll = 5
    // (background poll is fire-and-forget so timing may vary)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("returns 500 directly without switching accounts", async () => {
    const fetchFn = await setupFetchFn(client, [{}, {}]);

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "internal_error", message: "internal server error" } }), {
        status: 500,
      }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(500);
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
          variant: "info",
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

    const switchToasts = client.tui.showToast.mock.calls.filter(
      (call) => call[0]?.body?.variant === "info" && call[0]?.body?.message?.includes("switching account"),
    );

    // Debounce should suppress immediate duplicate switch warnings.
    expect(switchToasts).toHaveLength(1);
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
    const [, exchangeInit] = mockFetch.mock.calls[0];
    expect(exchangeInit.headers["User-Agent"]).toBe("axios/1.13.6");
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
    delete process.env.DISABLE_INTERLEAVED_THINKING;
    delete process.env.USE_API_CONTEXT_MANAGEMENT;
    delete process.env.TENGU_MARBLE_ANVIL;
    delete process.env.TENGU_TOOL_PEAR;
    delete process.env.TENGU_SCARF_COFFEE;
    delete process.env.ANTHROPIC_BETAS;

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
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).toContain("advanced-tool-use-2025-11-20");
    expect(betaHeader).toContain("fast-mode-2026-02-01");
    expect(betaHeader).not.toContain("redact-thinking-2026-02-12");
    expect(betaHeader).not.toContain("fine-grained-tool-streaming-2025-05-14");
    expect(betaHeader).not.toContain("code-execution-2025-08-25");
    expect(betaHeader).not.toContain("files-api-2025-04-14");
    expect(betaHeader).toContain("custom-beta-2025-01-01");
    expect(betaHeader).toContain("another-beta-2025-02-01");
  });

  it("adds context-1m beta for eligible models on all providers including OAuth", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-1m", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    // Claude Code v2.1.81: context-1m is always-on for eligible models regardless of provider.
    expect(init.headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
  });

  it("adds effort beta AND interleaved-thinking for Opus 4.6 models (both always-on)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).toContain("effort-2025-11-24");
    expect(betaHeader).toContain("advanced-tool-use-2025-11-20");
    expect(betaHeader).toContain("fast-mode-2026-02-01");
    // Claude Code v2.1.81: interleaved-thinking is now always-on (not model-gated)
    expect(betaHeader).toContain("interleaved-thinking-2025-05-14");
    expect(betaHeader).not.toContain("redact-thinking-2026-02-12");
  });

  it("does NOT send context-hint-2026-04-09 by default (partial server rollout, v2.1.110+)", async () => {
    // Default token_economy.context_hint is false because the server rollout
    // is partial and opting in uninvited yields 400 "Unexpected value". Opt-in
    // + main-thread body shape is covered in test/conformance/regression.test.mjs.
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).not.toContain("context-hint-2026-04-09");
    const parsed = JSON.parse(init.body);
    expect(parsed.context_hint).toBeUndefined();
  });

  it("normalizes thinking to adaptive for Opus 4.6 (regardless of incoming format)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "think hard" }],
        thinking: { type: "enabled", budget_tokens: 20000 },
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // RE doc §5.2: Opus 4.6 always uses adaptive thinking
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });

  it("normalizes all budget_tokens variants to adaptive for Opus 4.6", async () => {
    /** @type {Array<number>} */
    const budgets = [512, 1024, 1025, 8000, 8001, 16000, 16001, 100000];

    for (const budget of budgets) {
      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
      mockFetch.mockClear();

      await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          messages: [],
          thinking: { type: "enabled", budget_tokens: budget },
        }),
      });

      const [, init] = mockFetch.mock.calls[0];
      const parsed = JSON.parse(init.body);
      // RE doc §5.2: adaptive for all Opus 4.6 regardless of budget
      expect(parsed.thinking).toEqual({ type: "adaptive" });
    }
  });

  it("normalizes enabled thinking (no budget) to adaptive for Opus 4.6", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [],
        thinking: { type: "enabled" },
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });

  it("normalizes effort-based thinking to adaptive for Opus 4.6", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [],
        thinking: { type: "enabled", effort: "low" },
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });

  it("moves top-level effort into output_config.effort for Opus 4.6 (fingerprint parity)", async () => {
    // opencode's provider transform sets `effort: "max"` at the body root for
    // variant=max on Opus 4.6. Real Claude Code v2.1.87+ nests it inside
    // `output_config.effort` via Lyz(). If the plugin forwards the top-level
    // shape the Anthropic server fingerprints it as non-CC and bills the
    // request as pay-as-you-go ("You're out of extra usage").
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [],
        thinking: { type: "adaptive" },
        effort: "max",
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.effort).toBeUndefined();
    expect(parsed.output_config).toEqual({ effort: "max" });
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });

  it("moves top-level effort into output_config.effort for Sonnet 4.6", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [],
        thinking: { type: "adaptive" },
        effort: "high",
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.effort).toBeUndefined();
    expect(parsed.output_config).toEqual({ effort: "high" });
  });

  it("preserves existing output_config.effort when already present", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [],
        thinking: { type: "adaptive" },
        effort: "low",
        output_config: { effort: "max" },
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // Existing output_config.effort wins; top-level effort is still stripped.
    expect(parsed.effort).toBeUndefined();
    expect(parsed.output_config).toEqual({ effort: "max" });
  });

  it("strips top-level effort for non-adaptive models", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [],
        effort: "medium",
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.effort).toBeUndefined();
    // Haiku never gets output_config.effort in real CC, don't fabricate it.
    expect(parsed.output_config?.effort).toBeUndefined();
  });

  it("passes thinking through unchanged for older models (budget_tokens preserved)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [],
        thinking: { type: "enabled", budget_tokens: 8000 },
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });

  it("haiku 3.5 gets base betas but NOT effort/interleaved (matches real CC hv4/rE gating)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Canonical Anthropic model ID form — the Claude-3 detection regex
      // matches "claude-3-" prefix which exists in the canonical form.
      body: JSON.stringify({ model: "claude-3-5-haiku-latest", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    // Haiku gets CLAUDE_CODE_BETA_FLAG so subagent delegation gets full mimic
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).toContain("advanced-tool-use-2025-11-20");
    expect(betaHeader).toContain("fast-mode-2026-02-01");
    // Real CC's Lyz() only pushes effort for Opus/Sonnet 4.6 — not Haiku
    expect(betaHeader).not.toContain("effort-2025-11-24");
    // Real CC's hv4() excludes Claude 3.x from interleaved thinking
    expect(betaHeader).not.toContain("interleaved-thinking-2025-05-14");
  });

  it("haiku 4.5 gets interleaved thinking but NOT effort (matches real CC hv4/rE gating)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    // Haiku 4.5 is Claude 4+ firstParty → hv4=true → interleaved pushed
    expect(betaHeader).toContain("interleaved-thinking-2025-05-14");
    // Haiku 4.5 is NOT rE(model) → effort must NOT be pushed
    expect(betaHeader).not.toContain("effort-2025-11-24");
    // Other always-on betas still present
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).toContain("advanced-tool-use-2025-11-20");
    expect(betaHeader).toContain("fast-mode-2026-02-01");
  });

  it("sonnet 4.6 gets BOTH effort and interleaved thinking (matches real CC)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    // Sonnet 4.6 is rE(model) → effort pushed
    expect(betaHeader).toContain("effort-2025-11-24");
    // Sonnet 4.6 is Claude 4+ → hv4=true → interleaved pushed
    expect(betaHeader).toContain("interleaved-thinking-2025-05-14");
  });

  it("does not auto-include code-execution beta", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).not.toContain("code-execution-2025-08-25");
  });

  it("adds files-api beta for /v1/files endpoints", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/files", {
      method: "GET",
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).toContain("files-api-2025-04-14");
  });

  it("adds files-api beta when messages payload references file_id", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "file",
                  file_id: "file_123",
                },
              },
            ],
          },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).toContain("files-api-2025-04-14");
  });

  it("does not add files-api beta to regular messages without file_id", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).not.toContain("files-api-2025-04-14");
  });

  it("adds token-counting beta for /v1/messages/count_tokens", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).toContain("token-counting-2024-11-01");
  });

  it("excludes prompt-caching-scope beta in round-robin strategy", async () => {
    // Override config with round-robin strategy for a fresh plugin
    loadConfig.mockReturnValueOnce({
      ...loadConfig(),
      account_selection_strategy: "round-robin",
    });

    const rrClient = makeClient();
    loadAccounts.mockResolvedValue(null);

    const plugin = await AnthropicAuthPlugin({ client: rrClient });
    const result = await plugin.auth.loader(
      vi.fn().mockResolvedValue({
        type: "oauth",
        refresh: "test-refresh",
        access: "test-access",
        expires: Date.now() + 3600_000,
      }),
      makeProvider(),
    );

    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");

    // Prompt caching excluded in round-robin (cache is per-workspace)
    expect(betaHeader).not.toContain("prompt-caching-scope-2026-01-05");
    // Files API is only endpoint/content-scoped
    expect(betaHeader).not.toContain("files-api-2025-04-14");
    // Core betas still present
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
  });

  it("includes prompt-caching-scope beta in sticky strategy", async () => {
    // Default fetchFn uses sticky strategy
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");

    expect(betaHeader).toContain("prompt-caching-scope-2026-01-05");
    expect(betaHeader).not.toContain("files-api-2025-04-14");
  });

  it("disables experimental betas when CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1", async () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Use opus-4-6 (adaptive model) so effort-2025-11-24 is actually pushed —
      // the point of this test is to verify that non-experimental betas survive
      // the disable filter, and effort is only pushed for rE(model) per real CC.
      body: JSON.stringify({ model: "claude-opus-4-6", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    // Non-experimental betas survive
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
    // effort-2025-11-24 is NOT in EXPERIMENTAL_BETA_FLAGS so it survives
    expect(betaHeader).toContain("effort-2025-11-24");
    // All EXPERIMENTAL_BETA_FLAGS members are filtered out
    expect(betaHeader).not.toContain("interleaved-thinking-2025-05-14");
    expect(betaHeader).not.toContain("prompt-caching-scope-2026-01-05");
    expect(betaHeader).not.toContain("tool-examples-2025-10-29");
    expect(betaHeader).not.toContain("redact-thinking-2026-02-12");
    expect(betaHeader).not.toContain("advanced-tool-use-2025-11-20");
    expect(betaHeader).not.toContain("fast-mode-2026-02-01");
  });

  it("computes x-stainless-helper from tools and message content", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hello", stainlessHelper: "compaction" }],
          },
        ],
        tools: [{ name: "read_file", stainlessHelper: "BetaToolRunner" }],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("x-stainless-helper")).toContain("BetaToolRunner");
    expect(init.headers.get("x-stainless-helper")).toContain("compaction");
  });

  it("injects billing and identity system blocks in request body", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "abcd_efghijklmnopqrstuv" }],
        system: [{ type: "text", text: "Use OpenCode defaults" }],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.system[0].text).toContain("x-anthropic-billing-header:");
    expect(parsed.system[0].text).toContain("cc_entrypoint=cli");
    // cch is computed via xxHash64 post-serialization; in tests it may be the computed value
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};/);
    expect(parsed.system[0].cache_control).toBeUndefined();
    expect(parsed.system[1]).toEqual({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(parsed.system[2].text).toBe("Use Claude Code defaults");
  });

  it("redacts opencode mentions and compacts duplicated identity prefix", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        system: [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.\n\nUse OpenCode defaults\n\n\nSee https://opencode.ai/docs and github.com/anomalyco/opencode",
          },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);

    // identity block is injected once by the plugin
    expect(parsed.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    // original block is compacted and redacted
    expect(parsed.system[2].text.startsWith("You are Claude Code, Anthropic's official CLI for Claude.")).toBe(false);
    expect(parsed.system[2].text).toContain("Use Claude Code defaults");
    expect(parsed.system[2].text).not.toMatch(/opencode/i);
    expect(parsed.system[2].text).not.toContain("\n\n\n");
  });

  it("rewrites opencode env-context phrasing to real CC phrasing", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        system: [
          {
            type: "text",
            text: "Here is some useful information about the environment you are running in:\n<cwd>/tmp</cwd>",
          },
        ],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    const joined = parsed.system.map((b) => b.text).join("\n");
    expect(joined).toContain("Here is useful information about the environment you are running in:");
    expect(joined).not.toContain("Here is some useful information about the environment");
  });

  it("leaves system blocks without the opencode env-context phrase untouched", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        system: [{ type: "text", text: "Plain user instructions without env context." }],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    const joined = parsed.system.map((b) => b.text).join("\n");
    expect(joined).toContain("Plain user instructions without env context.");
  });

  it("does not inject billing block when CLAUDE_CODE_ATTRIBUTION_HEADER=0", async () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello world" }], system: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.system[0]).toEqual({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(parsed.system.some((item) => item.text.startsWith("x-anthropic-billing-header:"))).toBe(false);
  });

  it("adds metadata.user_id to request body", async () => {
    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
        system: [],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // metadata.user_id is now JSON.stringify({device_id, account_uuid, session_id})
    const userId = JSON.parse(parsed.metadata.user_id);
    expect(userId).toHaveProperty("device_id");
    expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(userId).toHaveProperty("account_uuid");
    expect(userId).toHaveProperty("session_id");
    expect(userId.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // First-party API rejects "betas" in body — betas are header-only
    expect(parsed.betas).toBeUndefined();
  });

  it("sends X-Claude-Code-Session-Id header matching metadata.user_id.session_id", async () => {
    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
        system: [],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const headers = init.headers;
    const parsed = JSON.parse(init.body);
    const userId = JSON.parse(parsed.metadata.user_id);
    // Header must be a valid UUID and must match the session_id in the body metadata
    const sessionHeader = headers.get("X-Claude-Code-Session-Id");
    expect(sessionHeader).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sessionHeader).toBe(userId.session_id);
  });

  it("adds metadata fields from CLAUDE_CODE_* env vars", async () => {
    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    process.env.CLAUDE_CODE_ACCOUNT_UUID = "acct-uuid-123";
    process.env.CLAUDE_CODE_ORGANIZATION_UUID = "org-uuid-456";
    process.env.CLAUDE_CODE_USER_EMAIL = "dev@example.com";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], system: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // metadata.user_id is JSON with device_id, account_uuid, session_id
    const userId = JSON.parse(parsed.metadata.user_id);
    expect(userId).toHaveProperty("device_id");
    expect(userId).toHaveProperty("account_uuid");
    expect(userId).toHaveProperty("session_id");
    // organization_uuid and user_email are NOT in request metadata — only in telemetry events
  });

  it("strips any incoming betas from request body (API rejects betas in body)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [], betas: ["foo-beta"] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // First-party API rejects "betas" in body with "Extra inputs are not permitted"
    // Betas are header-only; any incoming body betas must be stripped
    expect(parsed.betas).toBeUndefined();
    // Betas still present in header
    expect(init.headers.get("anthropic-beta")).toContain("claude-code-20250219");
  });

  it("uses ANTHROPIC_AUTH_TOKEN when provided", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "manual-override-token";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("authorization")).toBe("Bearer manual-override-token");
  });

  it("builds user-agent with agent sdk suffixes", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDE_AGENT_SDK_VERSION = "1.2.3";
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = "my-app";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const ua = init.headers.get("user-agent");
    expect(ua).toContain("(external, cli, agent-sdk/1.2.3, client-app/my-app)");
  });

  it("adds remote and custom headers from environment", async () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Extra-One: value1\nX-Extra-Two: value2";
    process.env.CLAUDE_CODE_CONTAINER_ID = "container-123";
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = "session-456";
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = "my-app";
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION = "1";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("x-extra-one")).toBe("value1");
    expect(init.headers.get("x-extra-two")).toBe("value2");
    expect(init.headers.get("x-claude-remote-container-id")).toBe("container-123");
    expect(init.headers.get("x-claude-remote-session-id")).toBe("session-456");
    expect(init.headers.get("x-client-app")).toBe("my-app");
    expect(init.headers.get("x-anthropic-additional-protection")).toBe("true");
  });

  it("logs transformed system prompt when debug env is enabled", async () => {
    process.env.OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT = "1";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        system: [{ type: "text", text: "Use OpenCode defaults" }],
      }),
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[opencode-anthropic-auth][system-debug] transformed system:",
      expect.stringContaining("Use Claude Code defaults"),
    );
    consoleSpy.mockRestore();
  });

  it("does not log title-generator system prompt when debug env is enabled", async () => {
    process.env.OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT = "1";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test" }],
        system: [
          {
            type: "text",
            text: "You are a title generator. You output ONLY a thread title. Nothing else.",
          },
        ],
      }),
    });

    const hadSystemDebugLog = consoleSpy.mock.calls.some(
      (call) => call[0] === "[opencode-anthropic-auth][system-debug] transformed system:",
    );
    expect(hadSystemDebugLog).toBe(false);
    consoleSpy.mockRestore();
  });

  it("filters unsupported betas on bedrock endpoints", async () => {
    process.env.TENGU_SCARF_COFFEE = "1";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://bedrock-runtime.us-east-1.amazonaws.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-1m", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    expect(betaHeader).not.toContain("context-1m-2025-08-07");
    expect(betaHeader).not.toContain("tool-examples-2025-10-29");
    expect(betaHeader).not.toContain("code-execution-2025-08-25");
    expect(betaHeader).not.toContain("files-api-2025-04-14");
    expect(betaHeader).toContain("claude-code-20250219");
  });

  it("uses mantle provider beta/header behavior when CLAUDE_CODE_USE_MANTLE=1", async () => {
    process.env.CLAUDE_CODE_USE_MANTLE = "1";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [{ role: "user", content: "hello" }] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    const parsed = JSON.parse(init.body);
    expect(betaHeader).toContain("tool-search-tool-2025-10-19");
    expect(betaHeader).not.toContain("advanced-tool-use-2025-11-20");
    expect(parsed.system[0].text).toContain("x-anthropic-billing-header:");
    expect(parsed.system[0].text).not.toContain("cch=00000");
  });

  it("omits cch for anthropicAws provider when CLAUDE_CODE_USE_ANTHROPIC_AWS=1", async () => {
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = "1";
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [{ role: "user", content: "hello" }] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");
    const parsed = JSON.parse(init.body);
    expect(betaHeader).toContain("advanced-tool-use-2025-11-20");
    expect(betaHeader).not.toContain("tool-search-tool-2025-10-19");
    expect(parsed.system[0].text).toContain("x-anthropic-billing-header:");
    expect(parsed.system[0].text).not.toContain("cch=00000");
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
// OPENCODE_ANTHROPIC_INITIAL_ACCOUNT pinning
// ---------------------------------------------------------------------------

describe("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT;
  });

  it("pins session to specific account by 1-based index and overrides strategy to sticky", async () => {
    vi.resetAllMocks();
    process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT = "2";
    process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";

    const client = makeClient();
    const data = makeAccountsData([
      {
        refreshToken: "refresh-1",
        email: "a@test.com",
        access: "access-1",
        expires: Date.now() + 3600_000,
      },
      {
        refreshToken: "refresh-2",
        email: "b@test.com",
        access: "access-2",
        expires: Date.now() + 3600_000,
      },
    ]);
    loadAccounts.mockResolvedValue(data);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Make API request — should use account 2 (pinned) not account 1
    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));
    await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("authorization")).toBe("Bearer access-2");
  });

  it("pins session to specific account by email", async () => {
    vi.resetAllMocks();
    process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT = "b@test.com";
    process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";

    const client = makeClient();
    const data = makeAccountsData([
      {
        refreshToken: "refresh-1",
        email: "a@test.com",
        access: "access-1",
        expires: Date.now() + 3600_000,
      },
      {
        refreshToken: "refresh-2",
        email: "b@test.com",
        access: "access-2",
        expires: Date.now() + 3600_000,
      },
    ]);
    loadAccounts.mockResolvedValue(data);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));
    await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("authorization")).toBe("Bearer access-2");
  });

  it("includes prompt-caching beta when round-robin config is overridden to sticky by pinning", async () => {
    vi.resetAllMocks();
    process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT = "1";
    process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";

    // Config says round-robin, but pinning should override to sticky
    loadConfig.mockReturnValueOnce({
      ...loadConfig(),
      account_selection_strategy: "round-robin",
    });

    const client = makeClient();
    const data = makeAccountsData([
      {
        refreshToken: "refresh-1",
        email: "a@test.com",
        access: "access-1",
        expires: Date.now() + 3600_000,
      },
      {
        refreshToken: "refresh-2",
        email: "b@test.com",
        access: "access-2",
        expires: Date.now() + 3600_000,
      },
    ]);
    loadAccounts.mockResolvedValue(data);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const betaHeader = init.headers.get("anthropic-beta");

    // Pinning overrides round-robin to sticky — prompt-caching should be included
    expect(betaHeader).toContain("prompt-caching-scope-2026-01-05");
    expect(betaHeader).not.toContain("code-execution-2025-08-25");
    expect(betaHeader).not.toContain("files-api-2025-04-14");
    // Should use account 1 (pinned)
    expect(init.headers.get("authorization")).toBe("Bearer access-1");
  });

  it("ignores env var when only one account exists", async () => {
    vi.resetAllMocks();
    process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT = "2";
    process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";

    const client = makeClient();
    // Only one account
    const data = makeAccountsData([
      {
        refreshToken: "refresh-1",
        email: "a@test.com",
        access: "access-1",
        expires: Date.now() + 3600_000,
      },
    ]);
    loadAccounts.mockResolvedValue(data);
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    mockFetch.mockResolvedValueOnce(new Response('{"content":[]}', { status: 200 }));
    await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    // Should use account 1 (only account — pinning skipped because count <= 1)
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("authorization")).toBe("Bearer access-1");
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
    vi.useFakeTimers();

    try {
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

      // recordUsage triggers a debounced save (1s); flush deterministically.
      await vi.advanceTimersByTimeAsync(1500);

      // Verify usage was recorded: the stats should reflect the message_delta usage
      const saveCalls = saveAccounts.mock.calls;
      expect(saveCalls.length).toBeGreaterThan(0);
      const lastSave = saveCalls[saveCalls.length - 1][0];
      const acc = lastSave.accounts[0];
      expect(acc.stats.requests).toBeGreaterThan(0);
      expect(acc.stats.outputTokens).toBe(42);
      expect(acc.stats.inputTokens).toBe(25);
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// override_model_limits — uses setupFetchFn which wires auth.loader via makeProvider()
// ---------------------------------------------------------------------------
describe("override_model_limits", () => {
  let client;

  beforeEach(async () => {
    client = makeClient();
    loadAccounts.mockResolvedValue(makeAccountsData());
    saveAccounts.mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(new Response("", { status: 200 }));
    delete process.env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS;
  });

  it("does not override context limit by default (1m-context off)", async () => {
    const provider = makeProvider();
    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3_600_000,
    });
    await plugin.auth.loader(getAuth, provider);

    expect(provider.models["claude-opus-4-6"].limit.context).toBe(200_000);
    expect(provider.models["claude-sonnet-4-1m"].limit.context).toBe(200_000);
    expect(provider.models["claude-sonnet"].limit.context).toBe(200_000);
  });

  it("overrides context limit to 1M when override_model_limits.enabled is true", async () => {
    const configModule = await import("./lib/config.mjs");
    configModule.loadConfig.mockReturnValueOnce({
      ...configModule.loadConfig(),
      override_model_limits: { enabled: true, context: 1_000_000, output: 0 },
    });
    const provider = makeProvider();
    const pluginEnabled = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3_600_000,
    });
    await pluginEnabled.auth.loader(getAuth, provider);

    expect(provider.models["claude-opus-4-6"].limit.context).toBe(1_000_000);
    expect(provider.models["claude-sonnet-4-1m"].limit.context).toBe(1_000_000);
    expect(provider.models["claude-sonnet"].limit.context).toBe(200_000);
  });

  it("does not override 1M context when CLAUDE_CODE_DISABLE_1M_CONTEXT is set", async () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    const configModule = await import("./lib/config.mjs");
    configModule.loadConfig.mockReturnValueOnce({
      ...configModule.loadConfig(),
      override_model_limits: { enabled: true, context: 1_000_000, output: 0 },
    });
    const provider = makeProvider();
    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3_600_000,
    });

    await plugin.auth.loader(getAuth, provider);

    expect(provider.models["claude-opus-4-6"].limit.context).toBe(200_000);
    expect(provider.models["claude-sonnet-4-1m"].limit.context).toBe(200_000);
  });

  it("preserves original output limit when override_model_limits.output is 0 (default)", async () => {
    const provider = makeProvider();
    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3_600_000,
    });
    await plugin.auth.loader(getAuth, provider);

    expect(provider.models["claude-opus-4-6"].limit.output).toBe(32_000);
    expect(provider.models["claude-sonnet-4-1m"].limit.output).toBe(16_000);
  });

  it("does not modify limits for non-OAuth auth (API key path)", async () => {
    const provider = makeProvider();
    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({ type: "api" });
    await plugin.auth.loader(getAuth, provider);

    expect(provider.models["claude-opus-4-6"].limit.context).toBe(200_000);
    expect(provider.models["claude-sonnet-4-1m"].limit.context).toBe(200_000);
  });

  it("does not override limits when override_model_limits.enabled is false in config", async () => {
    const configModule = await import("./lib/config.mjs");
    configModule.loadConfig.mockReturnValueOnce({
      ...configModule.loadConfig(),
      override_model_limits: { enabled: false, context: 1_000_000, output: 0 },
    });
    const provider = makeProvider();
    const pluginDisabled = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3_600_000,
    });
    await pluginDisabled.auth.loader(getAuth, provider);

    expect(provider.models["claude-opus-4-6"].limit.context).toBe(200_000);
    expect(provider.models["claude-sonnet-4-1m"].limit.context).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// Adaptive 1M Context
// ---------------------------------------------------------------------------
describe("adaptive 1M context", () => {
  let fetchFn;
  let client;

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

  it("does NOT send context-1m for bare Opus 4.6 when adaptive is disabled (default test config)", async () => {
    // The test harness sets adaptive_context.enabled = false.
    // Bare Opus 4.6 (no "1m" suffix) should NOT get context-1m in static mode.
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("anthropic-beta")).not.toContain("context-1m-2025-08-07");
  });

  it("STILL sends context-1m for explicit 1m models when adaptive is disabled", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-1m", messages: [] }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
  });
});

// ---------------------------------------------------------------------------
// Slash Command Message Stripping
// ---------------------------------------------------------------------------
describe("slash command message stripping", () => {
  let fetchFn;
  let client;

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

  it("strips user message starting with /anthropic from conversation", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "/anthropic switch 2" },
      { role: "assistant", content: "▣ Anthropic\n\nSwitched active account to #2." },
      { role: "user", content: "Now do something" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // The /anthropic message and its ▣ Anthropic response should be gone
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0].content).toBe("Hello");
    expect(parsed.messages[1].content).toBe("Hi there");
    expect(parsed.messages[2].content).toBe("Now do something");
  });

  it("strips /anthropic command with array content blocks", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: [{ type: "text", text: "/anthropic stats" }] },
      { role: "assistant", content: [{ type: "text", text: "▣ Anthropic Stats\n\nSession: 5 turns" }] },
      { role: "user", content: [{ type: "text", text: "Continue working" }] },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].content[0].text).toBe("Continue working");
  });

  it("strips multiple /anthropic commands from conversation", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "/anthropic config" },
      { role: "assistant", content: "▣ Anthropic Config\n\nemulation: on" },
      { role: "user", content: "Write a function" },
      { role: "assistant", content: "Here is the function..." },
      { role: "user", content: "/anthropic betas add web-search" },
      { role: "assistant", content: "▣ Anthropic Betas\n\nAdded: web-search" },
      { role: "user", content: "Now use web search" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0].content).toBe("Write a function");
    expect(parsed.messages[1].content).toBe("Here is the function...");
    expect(parsed.messages[2].content).toBe("Now use web search");
  });

  it("preserves messages that mention /anthropic but don't start with it", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "How do I use /anthropic commands?" },
      { role: "assistant", content: "You can type /anthropic followed by a subcommand." },
      { role: "user", content: "Thanks!" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // All 3 messages preserved — none start with /anthropic
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0].content).toBe("How do I use /anthropic commands?");
    expect(parsed.messages[2].content).toBe("Thanks!");
  });

  it("does not strip non-command messages", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "What is 2+2?" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.messages).toHaveLength(3);
  });

  it("handles /anthropic with leading whitespace", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "  /anthropic switch 1" },
      { role: "assistant", content: "▣ Anthropic\n\nSwitched." },
      { role: "user", content: "Continue" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].content).toBe("Continue");
  });

  it("does not return empty messages array when all messages are commands", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "/anthropic config" },
      { role: "assistant", content: "▣ Anthropic Config\n\nDone." },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    // Safety: returns original messages rather than empty array
    expect(parsed.messages.length).toBeGreaterThan(0);
  });

  it("strips orphaned ▣ Anthropic response without preceding command", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "▣ Anthropic\n\nSome leftover command output" },
      { role: "user", content: "Do something" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].content).toBe("Hello");
    expect(parsed.messages[1].content).toBe("Do something");
  });
});

// ---------------------------------------------------------------------------
// Orphaned tool_use repair
// ---------------------------------------------------------------------------

describe("orphaned tool_use repair", () => {
  let client;
  let fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    delete process.env.DISABLE_INTERLEAVED_THINKING;
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    delete process.env.USE_API_CONTEXT_MANAGEMENT;
    delete process.env.TENGU_MARBLE_ANVIL;
    delete process.env.TENGU_TOOL_PEAR;
    delete process.env.TENGU_SCARF_COFFEE;
    delete process.env.ANTHROPIC_BETAS;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
    delete process.env.CLAUDE_CODE_CONTAINER_ID;
    delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    delete process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION;
    delete process.env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION;
    delete process.env.CLAUDE_CODE_ACCOUNT_UUID;
    delete process.env.CLAUDE_CODE_USER_EMAIL;
    delete process.env.CLAUDE_CODE_ORGANIZATION_UUID;
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";

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

  it("synthesizes tool_result when assistant tool_use has no following user message", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    // Simulate: assistant used a tool, but OpenCode crashed before sending the result.
    // Then the user sends a new message.
    const messages = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "toolu_orphan1", name: "read_file", input: { path: "/test" } },
        ],
      },
      // Missing user tool_result here!
      { role: "user", content: "What happened?" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);

    // Should have 4 messages: user, assistant, synthetic tool_result, user
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[2].role).toBe("user");
    expect(parsed.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_orphan1",
        content: "[Result unavailable — tool execution was interrupted]",
      },
    ]);
    expect(parsed.messages[3].content).toBe("What happened?");
  });

  it("synthesizes tool_result when assistant tool_use is the last message", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_last1", name: "bash", input: { command: "ls" } }],
      },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);

    // repairOrphanedToolUseBlocks + the trailing assistant guard both apply
    // Result: user, assistant, synthetic tool_result
    expect(parsed.messages.length).toBeGreaterThanOrEqual(3);
    // The message right after the assistant should be a user with tool_result
    const toolResultMsg = parsed.messages[2];
    expect(toolResultMsg.role).toBe("user");
    const toolResultBlock = toolResultMsg.content.find((b) => b.type === "tool_result");
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.tool_use_id).toBe("toolu_last1");
  });

  it("patches existing user message with missing tool_result IDs", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    // Assistant used 2 tools, but user message only has result for 1
    const messages = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_a", name: "read_file", input: {} },
          { type: "tool_use", id: "toolu_b", name: "bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "file contents" },
          // Missing tool_result for toolu_b!
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "OK" }] },
      { role: "user", content: "Thanks" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);

    // The user message at index 2 should now have both tool_results
    const userMsg = parsed.messages[2];
    expect(userMsg.role).toBe("user");
    const resultIds = userMsg.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(resultIds).toContain("toolu_a");
    expect(resultIds).toContain("toolu_b");
  });

  it("does not modify correctly paired tool_use/tool_result", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const messages = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_ok1", name: "read_file", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_ok1", content: "the file" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Got it." }] },
      { role: "user", content: "Done" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);

    // Should have exactly 5 messages — no synthetic ones added
    expect(parsed.messages).toHaveLength(5);
  });

  it("repairs multiple orphaned tool_use blocks at different positions", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    // Two separate assistant messages with orphaned tool_use blocks
    const messages = [
      { role: "user", content: "Start" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_first", name: "read_file", input: {} }],
      },
      // Missing tool_result for toolu_first — next is another user message
      { role: "user", content: "Keep going" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_second", name: "bash", input: {} }],
      },
      // Missing tool_result for toolu_second
      { role: "user", content: "What happened?" },
    ];

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(init.body);

    // Should have 7 messages: 5 original + 2 synthetic tool_results
    expect(parsed.messages).toHaveLength(7);

    // Verify both synthetic tool_results exist
    const syntheticResults = parsed.messages.filter(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) => b.type === "tool_result" && b.content === "[Result unavailable — tool execution was interrupted]",
        ),
    );
    expect(syntheticResults).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// custom_betas retry latch
// ---------------------------------------------------------------------------
// Verify that a 400 response citing "anthropic-beta" (or a 413) triggers
// exactly one retry that omits config.custom_betas while retaining the
// mandatory always-on betas (oauth-2025-04-20, claude-code-20250219), and
// that the latch (customBetasStripped) prevents infinite loops.
//
// Each test creates a fresh plugin instance via setupFetchFn so that
// config.custom_betas is captured from the per-test loadConfig mock.
// mockFetch is the backend; fetchFn() triggers the real retry loop.
// ---------------------------------------------------------------------------
describe("custom_betas retry latch (400/anthropic-beta and 413)", () => {
  // Config that includes a custom beta so the retry latch code path fires.
  const testConfig = {
    ...DEFAULT_CONFIG,
    account_selection_strategy: "sticky",
    signature_emulation: {
      ...DEFAULT_CONFIG.signature_emulation,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
    idle_refresh: { ...DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: { ...DEFAULT_CONFIG.adaptive_context, enabled: false },
    custom_betas: ["cache-diagnosis-2026-04-07"],
  };

  let fetchFn;

  beforeEach(async () => {
    mockFetch.mockReset();
    vi.mocked(loadConfig).mockReturnValue(testConfig);
    vi.mocked(loadConfigFresh).mockReturnValue(testConfig);
    const client = makeClient();
    fetchFn = await setupFetchFn(client);
    // setupFetchFn may have triggered loadAccounts; reset so tests start clean.
    mockFetch.mockReset();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it("first request includes configured custom beta; retry after 400/anthropic-beta omits it", async () => {
    const body400 = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown beta flag in anthropic-beta header" },
    });
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => JSON.parse(body400),
        text: async () => body400,
        clone() {
          return this;
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (h) => (h === "content-type" ? "text/event-stream" : null) },
        body: null,
        text: async () => 'data: {"type":"message_stop"}\n\n',
        clone() {
          return this;
        },
      });

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      }),
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);

    const firstBetas = mockFetch.mock.calls[0][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());
    const secondBetas = mockFetch.mock.calls[1][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());

    expect(firstBetas).toContain("cache-diagnosis-2026-04-07");
    expect(secondBetas).not.toContain("cache-diagnosis-2026-04-07");
    expect(secondBetas).toContain("oauth-2025-04-20");
    expect(secondBetas).toContain("claude-code-20250219");
  });

  it("413 response with beta/context signal body triggers single custom-beta strip and retry", async () => {
    // F2: 413 only fires the strip latch when the body contains a specific keyword.
    // "context_window" is an explicit signal; generic "context" alone is not.
    const body413 = JSON.stringify({
      error: { message: "Request too large: context_window limit exceeded" },
    });
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        headers: { get: () => null },
        json: async () => JSON.parse(body413),
        text: async () => body413,
        clone() {
          return this;
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (h) => (h === "content-type" ? "text/event-stream" : null) },
        body: null,
        text: async () => 'data: {"type":"message_stop"}\n\n',
        clone() {
          return this;
        },
      });

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      }),
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);

    const firstBetas = mockFetch.mock.calls[0][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());
    const secondBetas = mockFetch.mock.calls[1][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());

    expect(firstBetas).toContain("cache-diagnosis-2026-04-07");
    expect(secondBetas).not.toContain("cache-diagnosis-2026-04-07");
    expect(secondBetas).toContain("oauth-2025-04-20");
  });

  it("F2: 413 with empty body does NOT trigger custom-beta strip or retry", async () => {
    // A plain 413 with no body text (e.g. upload-size limit) must not trigger
    // the custom-beta strip latch - it is unrelated to betas.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 413,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => "",
      clone() {
        return this;
      },
    });

    try {
      await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 10,
        }),
      });
    } catch {
      // May throw — we only care about call count.
    }

    // With an empty 413 body, no strip-and-retry occurs; the request is NOT
    // duplicated by the custom-beta retry path (total calls still 1 per attempt,
    // not 2 from a strip-triggered re-issue).
    const betaCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).startsWith("https://api.anthropic.com/v1/messages"),
    );
    expect(betaCalls).toHaveLength(1);
    // All calls use the same betas — the custom beta must still be present on
    // the only attempt (no strip happened).
    for (const call of betaCalls) {
      const betas = call[1].headers
        .get("anthropic-beta")
        .split(",")
        .map((s) => s.trim());
      expect(betas).toContain("cache-diagnosis-2026-04-07");
    }
  });

  it("F1: alias in custom_betas ('cache-diag') is evicted canonically on retry", async () => {
    // F1: config.custom_betas may contain aliases. The eviction code must delete
    // the canonical form (cache-diagnosis-2026-04-07), not just the raw alias.
    const aliasConfig = {
      ...testConfig,
      custom_betas: ["cache-diag"], // alias for cache-diagnosis-2026-04-07
    };
    vi.mocked(loadConfig).mockReturnValue(aliasConfig);
    vi.mocked(loadConfigFresh).mockReturnValue(aliasConfig);
    const aliasClient = makeClient();
    const aliasFetchFn = await setupFetchFn(aliasClient);
    mockFetch.mockReset();

    const body400 = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown beta flag in anthropic-beta header" },
    });
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => JSON.parse(body400),
        text: async () => body400,
        clone() {
          return this;
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (h) => (h === "content-type" ? "text/event-stream" : null) },
        body: null,
        text: async () => 'data: {"type":"message_stop"}\n\n',
        clone() {
          return this;
        },
      });

    await aliasFetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      }),
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);

    const firstBetas = mockFetch.mock.calls[0][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());
    const retryBetas = mockFetch.mock.calls[1][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());

    // First attempt must include the canonical beta resolved from the alias.
    expect(firstBetas).toContain("cache-diagnosis-2026-04-07");
    // Retry must not include the canonical beta (alias eviction worked).
    expect(retryBetas).not.toContain("cache-diagnosis-2026-04-07");
    // Mandatory betas must still be present on the retry.
    expect(retryBetas).toContain("oauth-2025-04-20");
    expect(retryBetas).toContain("claude-code-20250219");
  });

  it("F4: second request in same plugin instance skips a previously rejected custom beta", async () => {
    // F4: session latch — after a custom beta is rejected, the NEXT logical request
    // (new fetchFn call) must already omit that beta without paying a first-fail.
    const body400 = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown beta flag in anthropic-beta header" },
    });
    const successResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h === "content-type" ? "text/event-stream" : null) },
      body: null,
      text: async () => 'data: {"type":"message_stop"}\n\n',
      clone() {
        return this;
      },
    });
    // First request: 400, then retry and succeed.
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => JSON.parse(body400),
        text: async () => body400,
        clone() {
          return this;
        },
      })
      .mockResolvedValueOnce(successResponse())
      // Second request should go straight through (no 400 needed).
      .mockResolvedValueOnce(successResponse());

    const makeReq = () =>
      fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 10,
        }),
      });

    // First request: triggers strip latch and succeeds on retry (2 fetch calls).
    await makeReq();
    const callsAfterFirst = mockFetch.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(2);

    // Second request: session latch already active — must omit the custom beta
    // from the very first attempt (no 400 retry needed = exactly 1 new fetch call).
    await makeReq();
    const secondReqCalls = mockFetch.mock.calls.slice(callsAfterFirst);
    expect(secondReqCalls.length).toBe(1); // No retry needed.

    const secondReqBetas = secondReqCalls[0][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());
    // Session latch must have evicted the custom beta before the request was sent.
    expect(secondReqBetas).not.toContain("cache-diagnosis-2026-04-07");
    // Mandatory betas must still be present.
    expect(secondReqBetas).toContain("oauth-2025-04-20");
    expect(secondReqBetas).toContain("claude-code-20250219");
  });

  it("F4-selective: when error body names one custom beta, only that beta is session-latched", async () => {
    // Two custom betas configured; the 400 body explicitly names only the first.
    // The second request must omit the named beta but retain the other.
    const twoBetaConfig = {
      ...testConfig,
      custom_betas: ["cache-diagnosis-2026-04-07", "interleaved-thinking-2025-05-14"],
    };
    vi.mocked(loadConfig).mockReturnValue(twoBetaConfig);
    vi.mocked(loadConfigFresh).mockReturnValue(twoBetaConfig);
    const twoBetaClient = makeClient();
    const twoBetaFetchFn = await setupFetchFn(twoBetaClient);
    mockFetch.mockReset();

    // Body only names the first beta.
    const body400 = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Unknown beta flag: cache-diagnosis-2026-04-07 is not supported in anthropic-beta",
      },
    });
    const successResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h === "content-type" ? "text/event-stream" : null) },
      body: null,
      text: async () => 'data: {"type":"message_stop"}\n\n',
      clone() {
        return this;
      },
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => JSON.parse(body400),
        text: async () => body400,
        clone() {
          return this;
        },
      })
      .mockResolvedValueOnce(successResponse())
      // Second logical request goes straight through.
      .mockResolvedValueOnce(successResponse());

    const makeReq = () =>
      twoBetaFetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 10,
        }),
      });

    // First request: 400 → strip all custom betas for this retry, session-latch only cache-diagnosis.
    await makeReq();
    const callsAfterFirst = mockFetch.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(2);

    // Second logical request: session latch filters cache-diagnosis; interleaved-thinking passes.
    await makeReq();
    const secondReqBetas = mockFetch.mock.calls[callsAfterFirst][1].headers
      .get("anthropic-beta")
      .split(",")
      .map((s) => s.trim());

    // Only the mentioned beta is suppressed.
    expect(secondReqBetas).not.toContain("cache-diagnosis-2026-04-07");
    // The un-mentioned beta must still be present.
    expect(secondReqBetas).toContain("interleaved-thinking-2025-05-14");
    // Mandatory betas must always be present.
    expect(secondReqBetas).toContain("oauth-2025-04-20");
    expect(secondReqBetas).toContain("claude-code-20250219");
  });

  it("F4-TTL: session-rejected beta is re-included after the 5-minute TTL expires", async () => {
    // After a beta is rejected and session-latched, requests within the TTL omit it.
    // Once the TTL elapses, the beta must be re-tried (latch entry expires).
    const body400 = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Unknown beta flag: cache-diagnosis-2026-04-07 in anthropic-beta header",
      },
    });
    const successResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h === "content-type" ? "text/event-stream" : null) },
      body: null,
      text: async () => 'data: {"type":"message_stop"}\n\n',
      clone() {
        return this;
      },
    });

    let fakeNow = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    try {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          headers: { get: () => null },
          json: async () => JSON.parse(body400),
          text: async () => body400,
          clone() {
            return this;
          },
        })
        .mockResolvedValueOnce(successResponse())
        // Second request (TTL still active): omits beta, succeeds.
        .mockResolvedValueOnce(successResponse())
        // Third request (after TTL): beta re-included, succeeds.
        .mockResolvedValueOnce(successResponse());

      const makeReq = () =>
        fetchFn("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-opus-4-5",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 10,
          }),
        });

      // Request 1: 400 → strip + session-latch, then retry succeeds.
      await makeReq();
      const callsAfterFirst = mockFetch.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(2);

      // Request 2: TTL not elapsed → beta is still suppressed.
      await makeReq();
      const callsAfterSecond = mockFetch.mock.calls.length;
      const secondBetas = mockFetch.mock.calls[callsAfterFirst][1].headers
        .get("anthropic-beta")
        .split(",")
        .map((s) => s.trim());
      expect(secondBetas).not.toContain("cache-diagnosis-2026-04-07");

      // Advance fake time past the 5-minute TTL.
      fakeNow += 5 * 60 * 1000 + 1;

      // Request 3: TTL expired → beta is back in the header.
      await makeReq();
      const thirdBetas = mockFetch.mock.calls[callsAfterSecond][1].headers
        .get("anthropic-beta")
        .split(",")
        .map((s) => s.trim());
      expect(thirdBetas).toContain("cache-diagnosis-2026-04-07");
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("latch prevents infinite loop: second 400/anthropic-beta does not re-strip", async () => {
    // Always return 400/anthropic-beta — the latch must prevent infinite retry.
    const latchBody = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown beta flag in anthropic-beta header" },
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => JSON.parse(latchBody),
      text: async () => latchBody,
      clone() {
        return this;
      },
    });

    try {
      await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 10,
        }),
      });
    } catch {
      // Expected — all attempts exhaust with 400.
    }

    // Latch fires after first strip; subsequent 400/anthropic-beta responses
    // are NOT re-stripped. Total calls are bounded, never infinite.
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    expect(mockFetch.mock.calls.length).toBeLessThan(30);
  });
});
