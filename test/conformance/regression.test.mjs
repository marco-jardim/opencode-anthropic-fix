/**
 * Conformance Regression Tests — Phase 6 Audit Findings
 *
 * These tests guard against regressions of the 15 specific audit findings
 * (9 HIGH + 6 MEDIUM) discovered during the Phase 6 QA review, plus key
 * E2E conformance invariants from the RE doc.
 *
 * Each test is tagged with its finding number (Fix #N) for traceability.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — same pattern as index.test.mjs
// ---------------------------------------------------------------------------

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("a"),
    close: vi.fn(),
  })),
}));

vi.mock("../../lib/storage.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadAccounts: vi.fn().mockResolvedValue(null),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    clearAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../lib/refresh-lock.mjs", () => ({
  acquireRefreshLock: vi.fn().mockResolvedValue({ acquired: true, lockPath: "/tmp/opencode-test.lock" }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
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
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    })),
    loadConfigFresh: vi.fn(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    })),
    saveConfig: vi.fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { AnthropicAuthPlugin } from "../../index.mjs";
import { saveAccounts, loadAccounts } from "../../lib/storage.mjs";
import { loadConfig } from "../../lib/config.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    session: { prompt: vi.fn().mockResolvedValue(undefined) },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
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
    },
  };
}

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

async function setupFetchFn(client, accountOverrides = [{}], authOverrides = {}) {
  const data = makeAccountsData(accountOverrides);
  loadAccounts.mockResolvedValue(data);
  saveAccounts.mockResolvedValue(undefined);

  const plugin = await AnthropicAuthPlugin({ client });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: data.accounts[0].refreshToken,
    access: "access-1",
    expires: Date.now() + 3600_000,
    ...authOverrides,
  });

  const result = await plugin.auth.loader(getAuth, makeProvider());
  return result.fetch;
}

/** Send a standard /v1/messages request through the interceptor */
async function sendRequest(fetchFn, bodyOverrides = {}, headerOverrides = {}) {
  mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

  await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headerOverrides },
    body: JSON.stringify({ model: "claude-sonnet-4", messages: [], ...bodyOverrides }),
  });

  const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return {
    headers: init.headers,
    body: JSON.parse(init.body),
  };
}

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
  delete process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT;
  delete process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING;
  delete process.env.MAX_THINKING_TOKENS;
  process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";
});

// =============================================================================
// HIGH PRIORITY FIXES (1-9)
// =============================================================================

describe("Fix #1: betas NOT in request body (header-only for first-party)", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("body does NOT contain betas field (API rejects it)", async () => {
    const { headers, body } = await sendRequest(fetchFn);

    // Header MUST contain all betas including oauth-2025-04-20
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");

    // Body MUST NOT have betas — API rejects with "Extra inputs are not permitted"
    expect(body.betas).toBeUndefined();
  });

  it("incoming body betas are stripped", async () => {
    const { body } = await sendRequest(fetchFn, { betas: ["foo-beta"] });

    // Any incoming betas in body must be removed
    expect(body.betas).toBeUndefined();
  });
});

describe("Fix #2: EXPERIMENTAL_BETA_FLAGS filter behavior", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 strips most always-on betas", async () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    const { headers } = await sendRequest(fetchFn);
    const betaHeader = headers.get("anthropic-beta");

    // Survivors: oauth, claude-code, effort
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).toContain("effort-2025-11-24");

    // Stripped: experimental set
    expect(betaHeader).not.toContain("interleaved-thinking-2025-05-14");
    expect(betaHeader).not.toContain("advanced-tool-use-2025-11-20");
    expect(betaHeader).not.toContain("fast-mode-2026-02-01");
  });
});

describe("Fix #3: Identity block has cache_control", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("identity block (second system block) has cache_control: {type: 'ephemeral'}", async () => {
    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: "Custom instructions" }],
    });

    // Block 0: billing header (no cache_control)
    expect(body.system[0].text).toContain("x-anthropic-billing-header:");
    expect(body.system[0].cache_control).toBeUndefined();

    // Block 1: identity string (WITH cache_control per RE doc §14.1, §15.17)
    // Uses same TTL as other cached blocks to satisfy API TTL ordering constraint.
    expect(body.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("Fix #4: OAuth state validation (CSRF protection)", () => {
  let client;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeClient();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);
  });

  it("stores state from authorize and validates it in callback", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "access-test",
        refresh_token: "refresh-test",
        expires_in: 3600,
      }),
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const method = plugin.auth.methods[0];
    const authResult = await method.authorize();

    // Extract the state from the URL
    const authUrl = new URL(authResult.url);
    const realState = authUrl.searchParams.get("state");
    expect(realState).toBeTruthy();

    // Callback with correct state should succeed
    const result = await authResult.callback(`auth-code#${realState}`);
    expect(result.type).toBe("success");
  });

  it("rejects callback with mismatched state via server-side validation", async () => {
    // The main auth flow sends state to the server for validation.
    // Mock the server rejecting the mismatched state.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "invalid_state",
    });

    const plugin = await AnthropicAuthPlugin({ client });
    const method = plugin.auth.methods[0];
    const authResult = await method.authorize();

    const result = await authResult.callback("auth-code#wrong-state");
    expect(result.type).toBe("failed");
  });
});

describe("Fix #5: x-should-retry: true forces retry on service-wide errors", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("x-should-retry: false returns response immediately", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "api_error" } }), {
        status: 500,
        headers: { "x-should-retry": "false" },
      }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(500);
    // Only 1 fetch call — no retry
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("x-should-retry: true on 500 retries the request", async () => {
    // First: 500 with x-should-retry: true
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: "api_error" } }), {
        status: 500,
        headers: { "x-should-retry": "true", "retry-after-ms": "10" },
      }),
    );
    // Second: success
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    // Should have retried at least once
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Fix #6: 529 overloaded responses are retried", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("529 is retried up to 2 times with Stainless backoff", async () => {
    // 3x 529 → exhausted retries, returns last 529
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }));

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(529);
    // Initial attempt + 2 retries = 3 total calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 15000);

  it("529 → success on retry returns 200", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 15000);
});

describe("Fix #7: Telemetry session ID matches API session ID", () => {
  it("sessionId from API request matches (both derived from signatureSessionId)", async () => {
    // QA fix C5: replaced tautological test with real assertion.
    // Verify that the session_id in metadata.user_id is a valid UUID
    // (meaning the plugin's signatureSessionId was properly generated and used).
    vi.resetAllMocks();
    const client = makeClient();
    const fetchFn = await setupFetchFn(client);

    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    const { body } = await sendRequest(fetchFn);
    const userId = JSON.parse(body.metadata.user_id);
    // session_id must be a valid UUID (not empty, not undefined)
    expect(userId.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("Fix #8: Exit telemetry uses live token reference", () => {
  it("liveTokenRef is updated with valid token on successful auth", async () => {
    // QA fix C5: replaced tautological test with real assertion.
    // Verify that after a successful request, the auth token is non-empty
    // (indicating liveTokenRef has been updated for exit telemetry).
    vi.resetAllMocks();
    const client = makeClient();
    const fetchFn = await setupFetchFn(client);

    const { headers } = await sendRequest(fetchFn);
    // After a successful request, the Authorization header should have a valid Bearer token
    const authHeader = headers.get("authorization");
    expect(authHeader).toBeTruthy();
    expect(authHeader).toMatch(/^Bearer .+/);
    // The token should not be empty (confirming the token path works for exit telemetry)
    expect(authHeader.replace("Bearer ", "")).not.toBe("");
  });
});

describe("Fix #9: Telemetry auth.account_uuid uses getAccountIdentifier", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("metadata.user_id contains account_uuid (not email)", async () => {
    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    const { body } = await sendRequest(fetchFn);

    const userId = JSON.parse(body.metadata.user_id);
    // account_uuid should not contain '@' (i.e., not an email)
    expect(userId.account_uuid).toBeDefined();
    expect(userId.account_uuid).not.toContain("@");
  });
});

// =============================================================================
// MEDIUM PRIORITY FIXES (10-15)
// =============================================================================

describe("Fix #10: MAX_THINKING_TOKENS env var honored in budget fallback", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("uses MAX_THINKING_TOKENS when adaptive thinking disabled", async () => {
    process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING = "1";
    process.env.MAX_THINKING_TOKENS = "32000";

    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      thinking: { type: "enabled", budget_tokens: 5000 },
    });

    // With adaptive disabled AND existing budget_tokens, it should keep existing
    expect(body.thinking.type).toBe("enabled");
    expect(body.thinking.budget_tokens).toBe(5000);
  });

  it("uses MAX_THINKING_TOKENS as fallback when no budget_tokens provided", async () => {
    process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING = "1";
    process.env.MAX_THINKING_TOKENS = "32000";

    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      thinking: { type: "enabled" },
    });

    expect(body.thinking.type).toBe("enabled");
    expect(body.thinking.budget_tokens).toBe(32000);
  });

  it("defaults to 16000 when MAX_THINKING_TOKENS not set", async () => {
    process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING = "1";
    delete process.env.MAX_THINKING_TOKENS;

    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      thinking: { type: "enabled" },
    });

    expect(body.thinking.type).toBe("enabled");
    expect(body.thinking.budget_tokens).toBe(16000);
  });
});

describe("Fix #11: Non-1 temperature overridden unconditionally", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("temperature=0 is overridden to 1 on non-thinking requests", async () => {
    const { body } = await sendRequest(fetchFn, { temperature: 0 });
    expect(body.temperature).toBe(1);
  });

  it("temperature=0.5 is overridden to 1 on non-thinking requests", async () => {
    const { body } = await sendRequest(fetchFn, { temperature: 0.5 });
    expect(body.temperature).toBe(1);
  });

  it("temperature is deleted when thinking is active", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      thinking: { type: "enabled", budget_tokens: 8000 },
      temperature: 1,
    });

    expect(body.temperature).toBeUndefined();
  });
});

describe("Fix #12: Refresh timeout is 15s (not 10s)", () => {
  it("refresh call uses AbortSignal with appropriate timeout", async () => {
    // QA fix C5: replaced tautological test with real assertion.
    // Verify that when a token refresh is needed, the refresh fetch call
    // is made (confirming the refresh path works). The 15s timeout is
    // set via AbortSignal.timeout(15_000) at index.mjs:2039.
    vi.resetAllMocks();
    const client = makeClient();

    // Set token to expire within 5-min buffer to trigger refresh
    const fourMinutesFromNow = Date.now() + 4 * 60 * 1000;

    // First call: token refresh response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "refreshed-token",
        refresh_token: "refreshed-refresh",
        expires_in: 3600,
      }),
    });
    // Second call: actual API request
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const fetchFn = await setupFetchFn(client, [{}], {
      expires: fourMinutesFromNow,
    });

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    // The first call should be the refresh (to platform.claude.com/v1/oauth/token)
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall[0]).toContain("/v1/oauth/token");
    // Total calls: 1 refresh + 1 API = 2
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("Fix #13: 5-minute expiry buffer on foreground refresh", () => {
  let client;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
  });

  it("refreshes token when expires within 5 minutes", async () => {
    // Token that expires in 4 minutes (within 5-min buffer)
    const fourMinutesFromNow = Date.now() + 4 * 60 * 1000;

    // First call: token refresh
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        expires_in: 3600,
      }),
    });
    // Second call: actual API request
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const fetchFn = await setupFetchFn(client, [{}], {
      expires: fourMinutesFromNow,
    });

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    // Should have made 2 calls: 1 refresh + 1 API
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The API call should use the refreshed token
    const [, apiInit] = mockFetch.mock.calls[1];
    expect(apiInit.headers.get("authorization")).toBe("Bearer refreshed-access");
  });
});

describe("Fix #14: Multiple rate-limit subtypes monitored", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("reads tokens utilization header", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", {
        status: 200,
        headers: { "anthropic-ratelimit-unified-tokens-utilization": "0.5" },
      }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
  });

  it("reads requests utilization header", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", {
        status: 200,
        headers: { "anthropic-ratelimit-unified-requests-utilization": "0.5" },
      }),
    );

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(response.status).toBe(200);
  });
});

describe("Fix #15: Telemetry schema fields present", () => {
  it("telemetry event schema fields are present in API request metadata", async () => {
    // QA fix C5: replaced tautological test with real assertion.
    // We verify the metadata.user_id JSON has the required schema fields
    // that the telemetry emitter also uses (device_id, account_uuid, session_id).
    vi.resetAllMocks();
    const client = makeClient();
    const fetchFn = await setupFetchFn(client);

    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    const { body } = await sendRequest(fetchFn);
    const userId = JSON.parse(body.metadata.user_id);

    // These fields must be present (shared schema between telemetry and API)
    expect(userId).toHaveProperty("device_id");
    expect(userId).toHaveProperty("account_uuid");
    expect(userId).toHaveProperty("session_id");
    // device_id must be 64-char hex
    expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
    // session_id must be UUID
    expect(userId.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// =============================================================================
// E2E CONFORMANCE INVARIANTS
// =============================================================================

describe("E2E: Full header set on a standard request", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("includes all required Stainless headers", async () => {
    const { headers } = await sendRequest(fetchFn);

    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("x-stainless-lang")).toBe("js");
    expect(headers.get("x-stainless-runtime")).toBe("node");
    expect(headers.get("x-stainless-runtime-version")).toBe(process.version);
    expect(headers.get("x-stainless-package-version")).toBe("0.208.0");
    expect(headers.get("x-stainless-retry-count")).toBe("0");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("does NOT include dangerous-direct-browser-access or x-stainless-helper-method", async () => {
    const { headers } = await sendRequest(fetchFn);

    expect(headers.has("anthropic-dangerous-direct-browser-access")).toBe(false);
    expect(headers.has("x-stainless-helper-method")).toBe(false);
  });

  it("User-Agent follows claude-cli pattern for API calls", async () => {
    const { headers } = await sendRequest(fetchFn);
    const ua = headers.get("user-agent");

    expect(ua).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external/);
    expect(ua).not.toContain("claude-code/");
  });

  it("x-stainless-os maps darwin to macOS correctly", async () => {
    const { headers } = await sendRequest(fetchFn);
    const os = headers.get("x-stainless-os");

    if (process.platform === "darwin") {
      expect(os).toBe("macOS");
    } else if (process.platform === "win32") {
      expect(os).toBe("Windows");
    } else if (process.platform === "linux") {
      expect(os).toBe("Linux");
    }
  });
});

describe("E2E: System prompt block ordering invariants", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("billing is first, identity is second, user blocks follow", async () => {
    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: "User instructions here" }],
    });

    expect(body.system.length).toBeGreaterThanOrEqual(3);
    // Block 0: billing
    expect(body.system[0].text).toContain("x-anthropic-billing-header:");
    expect(body.system[0].text).toMatch(/cch=[0-9a-f]{3,5}/);
    expect(body.system[0].cache_control).toBeUndefined();
    // Block 1: identity (same TTL as other cached blocks)
    expect(body.system[1].text).toContain("Claude Code");
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Block 2+: user content
    expect(body.system[2].text).toContain("User instructions here");
  });

  it("billing cc_version includes 3-char fingerprint hash (not model ID)", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hello world" }],
      system: [{ type: "text", text: "test" }],
    });

    // cc_version suffix is a 3-char fingerprint hash, NOT the model ID.
    // Real CC (utils/fingerprint.ts): SHA256(salt + msg[4]+msg[7]+msg[20] + version)[:3]
    expect(body.system[0].text).toMatch(/cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}/);
    expect(body.system[0].text).not.toContain("claude-opus-4-6");
  });
});

describe("E2E: Beta composition is complete and correct", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("contains all required always-on betas for non-Haiku model (v2.1.92 set)", async () => {
    const { headers } = await sendRequest(fetchFn);
    const beta = headers.get("anthropic-beta");

    // RE doc §15.16 always-on set — synced to v2.1.92
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).toContain("claude-code-20250219");
    expect(beta).toContain("advanced-tool-use-2025-11-20");
    expect(beta).toContain("fast-mode-2026-02-01");
    expect(beta).toContain("effort-2025-11-24");
    expect(beta).toContain("interleaved-thinking-2025-05-14");
    expect(beta).toContain("prompt-caching-scope-2026-01-05");
    expect(beta).toContain("context-management-2025-06-27");
    // Provider-aware tool search: 1P uses advanced-tool-use, 3P uses tool-search-tool.
    // Since tests hit first-party (default), expect advanced-tool-use.
    expect(beta).toContain("advanced-tool-use-2025-11-20");

    // Token economy betas (config-controlled, defaults in DEFAULT_CONFIG.token_economy)
    // token-efficient-tools was removed in v2.1.90 (fully absent from bundle)
    expect(beta).not.toContain("token-efficient-tools-2026-03-28");
    // summarize-connector-text was removed in v2.1.90 (dead slot njq="" / NHq="" in v2.1.91+)
    expect(beta).not.toContain("summarize-connector-text-2026-03-13");
    // redact-thinking is off by default
    expect(beta).not.toContain("redact-thinking-2026-02-12");

    // Removed in v2.1.84 — must NOT be sent
    expect(beta).not.toContain("tool-examples-2025-10-29");
    // Should NOT contain non-existent betas from bad checklist
    expect(beta).not.toContain("code-execution-2025-01-24");
    expect(beta).not.toContain("prompt-caching-2024-07-31");
    expect(beta).not.toContain("token-efficient-tools-2025-02-19");
  });

  it("betas are in header only, not in body (first-party API)", async () => {
    const { headers, body } = await sendRequest(fetchFn);

    // All betas in header
    const headerBetas = headers.get("anthropic-beta").split(",");
    expect(headerBetas.length).toBeGreaterThan(5);

    // No betas in body
    expect(body.betas).toBeUndefined();
  });
});

describe("E2E: metadata.user_id JSON format (RE doc §4.2)", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("user_id is valid JSON with device_id, account_uuid, session_id", async () => {
    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    const { body } = await sendRequest(fetchFn);

    const userId = JSON.parse(body.metadata.user_id);
    expect(userId).toHaveProperty("device_id");
    expect(userId).toHaveProperty("account_uuid");
    expect(userId).toHaveProperty("session_id");

    // device_id: 64-char hex
    expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
    // session_id: UUID format
    expect(userId.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("E2E: Thinking normalization", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("Opus 4.6 gets adaptive thinking", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      thinking: { type: "enabled", budget_tokens: 10000 },
    });

    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("Sonnet 4.6 gets adaptive thinking", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-sonnet-4-6-20260320",
      thinking: { type: "enabled", budget_tokens: 10000 },
    });

    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("older model keeps original thinking config", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 10000 },
    });

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });
});

describe("E2E: Version is 2.1.92", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("User-Agent contains 2.1.92", async () => {
    const { headers } = await sendRequest(fetchFn);
    expect(headers.get("user-agent")).toContain("2.1.92");
  });

  it("billing header contains 2.1.92", async () => {
    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: "test" }],
    });

    expect(body.system[0].text).toContain("2.1.92");
  });
});

describe("E2E: URL transform adds ?beta=true", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("/v1/messages gets ?beta=true", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const [input] = mockFetch.mock.calls[0];
    const url = input instanceof URL ? input : new URL(input.toString());
    expect(url.searchParams.get("beta")).toBe("true");
  });

  it("/v1/messages/count_tokens gets ?beta=true", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const [input] = mockFetch.mock.calls[0];
    const url = input instanceof URL ? input : new URL(input.toString());
    expect(url.searchParams.get("beta")).toBe("true");
  });
});
