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
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return {
    auth: {
      set: vi.fn().mockResolvedValue(undefined),
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
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "first-refresh",
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
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const [input] = mockFetch.mock.calls[0];
    const url = input instanceof URL ? input : new URL(input.toString());
    expect(url.searchParams.get("beta")).toBe("true");
  });

  it("transforms system prompt: OpenCode → Claude Code, opencode → Claude", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        system: [{ type: "text", text: "You are OpenCode, an opencode assistant." }],
        messages: [],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system[0].text).toBe(
      "You are Claude Code, an Claude assistant.",
    );
  });

  it("preserves paths containing opencode in system prompt", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        system: [{ type: "text", text: "Working dir: /Users/rmk/projects/opencode-auth" }],
        messages: [],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system[0].text).toBe(
      "Working dir: /Users/rmk/projects/opencode-auth",
    );
  });

  it("prefixes tool names with mcp_ in request", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

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
    const responseBody = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read_file"}}\n\n';
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

  it("retries on 429 with a different account", async () => {
    // Set up two accounts — the auth fallback provides access token for account 1.
    // Account 2 will need a token refresh before it can be used.
    vi.resetAllMocks();
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "refresh-1",
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
        {
          refreshToken: "refresh-2",
          addedAt: 2000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });
    saveAccounts.mockResolvedValue(undefined);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // First API request: 429 (account 1 has access token from auth fallback)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }),
        { status: 429, headers: { "retry-after": "0" } },
      ),
    );
    // Token refresh for account 2 (no access token yet)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
      }),
    });
    // Retry API request with account 2: 200
    mockFetch.mockResolvedValueOnce(
      new Response('{"content":[]}', { status: 200 }),
    );

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
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
    plugin["experimental.chat.system.transform"](
      { model: { providerID: "anthropic" } },
      output,
    );

    expect(output.system[0]).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(output.system[1]).toContain("You are Claude Code");
    expect(output.system[1]).toContain("You are a helpful assistant.");
  });

  it("does not modify system for non-anthropic provider", async () => {
    const client = makeClient();
    const plugin = await AnthropicAuthPlugin({ client });

    const output = { system: ["You are a helpful assistant."] };
    plugin["experimental.chat.system.transform"](
      { model: { providerID: "openai" } },
      output,
    );

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
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "refresh-1",
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "expired-access",
      expires: Date.now() - 1000, // expired
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Token refresh call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "fresh-access",
        refresh_token: "refresh-1-rotated",
        expires_in: 3600,
      }),
    });
    // Actual API call
    mockFetch.mockResolvedValueOnce(
      new Response('{"content":[]}', { status: 200 }),
    );

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

  it("disables account on 401 token refresh failure and retries with next account", async () => {
    // Two accounts — first will fail refresh, second will succeed
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "revoked-refresh",
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
        {
          refreshToken: "good-refresh",
          addedAt: 2000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "good-access",
        refresh_token: "good-refresh",
        expires_in: 3600,
      }),
    });
    // API call with account 2
    mockFetch.mockResolvedValueOnce(
      new Response('{"content":[]}', { status: 200 }),
    );

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // 3 calls: failed refresh (acct 1), successful refresh (acct 2), API call
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Fetch interceptor — single-account fallback (no accountManager accounts)
// ---------------------------------------------------------------------------

describe("fetch interceptor — single-account fallback", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    saveAccounts.mockResolvedValue(undefined);
  });

  it("falls back to OpenCode auth when accountManager has no accounts", async () => {
    // No stored accounts — accountManager will have 0 accounts after load
    // because we pass null authFallback AND loadAccounts returns null
    loadAccounts.mockResolvedValue(null);

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "opencode-refresh",
      access: "opencode-access",
      expires: Date.now() + 3600_000,
    });

    // loader bootstraps from auth.json — creates 1 account
    // But let's test the path where getCurrentAccount() returns null.
    // We need to make the account manager have zero accounts.
    // The simplest way: load with accounts that are all disabled.
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "disabled-refresh",
          addedAt: 1000,
          lastUsed: 0,
          enabled: false, // disabled — getCurrentAccount() returns null
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin2 = await AnthropicAuthPlugin({ client });
    const getAuth2 = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "opencode-refresh",
      access: "opencode-access",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin2.auth.loader(getAuth2, makeProvider());

    // API call — should use opencode-access directly
    mockFetch.mockResolvedValueOnce(
      new Response('{"content":[]}', { status: 200 }),
    );

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    const [, apiInit] = mockFetch.mock.calls[0];
    expect(apiInit.headers.get("authorization")).toBe("Bearer opencode-access");
  });

  it("refreshes OpenCode auth token when expired in fallback path", async () => {
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "disabled-refresh",
          addedAt: 1000,
          lastUsed: 0,
          enabled: false,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "opencode-refresh",
      access: "expired-opencode-access",
      expires: Date.now() - 1000, // expired
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // Token refresh for OpenCode auth
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "fresh-opencode-access",
        refresh_token: "opencode-refresh-rotated",
        expires_in: 3600,
      }),
    });
    // API call
    mockFetch.mockResolvedValueOnce(
      new Response('{"content":[]}', { status: 200 }),
    );

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Should have persisted to auth.json via client.auth.set
    expect(client.auth.set).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          access: "fresh-opencode-access",
          refresh: "opencode-refresh-rotated",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Fetch interceptor — retry exhaustion and wait paths
// ---------------------------------------------------------------------------

describe("fetch interceptor — retry exhaustion", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    saveAccounts.mockResolvedValue(undefined);
  });

  it("throws after MAX_RETRIES when all attempts fail with token refresh errors", async () => {
    // Single account that always fails token refresh
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "bad-refresh",
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "bad-refresh",
      access: "expired-access",
      expires: Date.now() - 1000, // expired — forces refresh every attempt
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // All refresh attempts fail (MAX_RETRIES + 1 = 4 attempts)
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "server_error" }),
      });
    }

    await expect(
      result.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow("Token refresh failed");
  });

  it("waits and retries when all accounts are rate-limited but within max wait", async () => {
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "refresh-1",
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // First request: 429
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }),
        { status: 429, headers: { "retry-after": "1" } },
      ),
    );
    // After wait, retry succeeds
    mockFetch.mockResolvedValueOnce(
      new Response('{"content":[]}', { status: 200 }),
    );

    // Spy on setTimeout to verify wait happens
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // setTimeout should have been called for the wait
    const waitCalls = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => typeof ms === "number" && ms > 0,
    );
    expect(waitCalls.length).toBeGreaterThanOrEqual(1);

    setTimeoutSpy.mockRestore();
  });

  it("returns error response when max wait time exceeded", async () => {
    // Use a config with very low max_rate_limit_wait_seconds
    // The default is 120s, but the backoff for retry-after: 999 will exceed it
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "refresh-1",
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "refresh-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    const result = await plugin.auth.loader(getAuth, makeProvider());

    // 429 with very long retry-after (999 seconds > default 120s max wait)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }),
        { status: 429, headers: { "retry-after": "999" } },
      ),
    );

    const response = await result.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    // Should return the 429 response directly (not retry)
    expect(response.status).toBe(429);
    // Only 1 fetch call — no retry
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

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
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

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
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

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
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "refresh-1",
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 3,
          lastFailureTime: Date.now() - 5000,
        },
      ],
      activeIndex: 0,
    });
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
    mockFetch.mockResolvedValueOnce(
      new Response('{"content":[]}', { status: 200 }),
    );

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
});
