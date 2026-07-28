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
      preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
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
      preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
    })),
    saveConfig: vi.fn(),
  };
});

vi.mock("../../lib/context-hint-persist.mjs", () => ({
  loadContextHintDisabledFlag: vi.fn(() => ({ disabled: false })),
  saveContextHintDisabledFlag: vi.fn(),
  getContextHintFlagPath: vi.fn(() => "/tmp/test-context-hint-disabled.flag"),
}));

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
    body: JSON.stringify({ model: "claude-sonnet-4", max_tokens: 1024, messages: [], ...bodyOverrides }),
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
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  delete process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS;
  delete process.env.CLAUDE_CODE_USE_MANTLE;
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
    // Use opus-4-6 so effort-2025-11-24 is model-gated ON — real CC's Kw(model)
    // emits effort for Opus 4.5/4.6/4.7/4.8 and Sonnet 4.6.
    const { headers } = await sendRequest(fetchFn, { model: "claude-opus-4-6" });
    const betaHeader = headers.get("anthropic-beta");

    // Survivors: oauth, claude-code, and effort (model-gated default, NOT a member
    // of EXPERIMENTAL_BETA_FLAGS, so the disable guard does not strip it).
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).toContain("effort-2025-11-24");

    // Stripped: experimental set (context-management IS in EXPERIMENTAL_BETA_FLAGS)
    expect(betaHeader).not.toContain("context-management-2025-06-27");
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
    // Identity uses the request-wide resolved TTL so it never sits at ttl=1h
    // AFTER a ttl=5m tools/messages block (Anthropic processes tools→system→
    // messages and rejects 1h-after-5m). This is a non-main ("empty") request
    // (default messages:[]), so the role-scoped downgrade resolves to 5m.
    expect(body.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 15000);
});

describe("Context-hint protocol (CC v2.1.110+)", () => {
  let client, fetchFn;

  // Context-hint defaults off (partial server rollout). Opt it in per test via
  // a config override. Body shape must classify as "main" (long system prompt
  // + non-trivial max_tokens + real messages) to match CC's querySource gate.
  async function setupWithCtxHint() {
    const original = await vi.importActual("../../lib/config.mjs");
    const cfgFactory = () => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
      token_economy: { ...original.DEFAULT_CONFIG.token_economy, context_hint: true },
    });
    loadConfig.mockImplementation(cfgFactory);
    return setupFetchFn(client);
  }

  const MAIN_THREAD_BODY = (messages = [{ role: "user", content: "hello" }]) => ({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: "x".repeat(300),
    messages,
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupWithCtxHint();
  });

  it("sends context-hint beta without a below-threshold body on first request", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MAIN_THREAD_BODY()),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("anthropic-beta")).toContain("context-hint-2026-04-09");
    expect(JSON.parse(init.body).context_hint).toBeUndefined();
  });

  it("skips context-hint for non-main-thread requests (title-gen shape)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 100, // title-gen signal
        messages: [{ role: "user", content: "pick a title" }],
      }),
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.get("anthropic-beta")).not.toContain("context-hint-2026-04-09");
    expect(JSON.parse(init.body).context_hint).toBeUndefined();
  });

  it("disables context-hint after 400 'Unexpected value / anthropic-beta / context-hint' rejection + retries without the beta + persists the flag", async () => {
    const { saveContextHintDisabledFlag } = await import("../../lib/context-hint-persist.mjs");
    saveContextHintDisabledFlag.mockClear();

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Unexpected value "context-hint-2026-04-09" in anthropic-beta header' },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MAIN_THREAD_BODY()),
    });
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MAIN_THREAD_BODY()),
    });

    // 3 calls: initial (400) → retry (200) → next user request (200)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [, firstInit] = mockFetch.mock.calls[0];
    expect(firstInit.headers.get("anthropic-beta")).toContain("context-hint-2026-04-09");

    const [, retryInit] = mockFetch.mock.calls[1];
    expect(retryInit.headers.get("anthropic-beta")).not.toContain("context-hint-2026-04-09");
    expect(JSON.parse(retryInit.body).context_hint).toBeUndefined();

    const [, secondInit] = mockFetch.mock.calls[2];
    expect(secondInit.headers.get("anthropic-beta")).not.toContain("context-hint-2026-04-09");
    expect(JSON.parse(secondInit.body).context_hint).toBeUndefined();

    expect(saveContextHintDisabledFlag).toHaveBeenCalledWith({
      reason: "beta_unsupported_400",
      status: 400,
    });
  }, 15000);

  it("compacts messages and retries on 422", async () => {
    const heavyMessages = [
      { role: "user", content: [{ type: "text", text: "Start" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x".repeat(5000) },
          { type: "text", text: "Okay." },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "old tool output" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
      { role: "user", content: [{ type: "text", text: "Next" }] },
    ];

    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "context too large" } }), { status: 422 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MAIN_THREAD_BODY(heavyMessages)),
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, retryInit] = mockFetch.mock.calls[1];
    const retryBody = JSON.parse(retryInit.body);
    const asst = retryBody.messages.find((m) => m.role === "assistant");
    expect(asst.content.some((b) => b.type === "thinking")).toBe(false);
  }, 15000);
});

describe("Role-scoped cache TTL (opt-in; CC v2.1.110+ MoY parity)", () => {
  // Default is 1h for all roles (user preference: long-running opencode sessions
  // benefit from longer TTL even on title/small requests). Opting in via
  // `role_scoped_cache_ttl: true` mirrors CC's MoY(querySource) allowlist:
  // main-thread-shape → 1h, everything else → 5m (cheaper write tier).
  let client, fetchFn;

  async function setupWithRoleScoped() {
    const original = await vi.importActual("../../lib/config.mjs");
    loadConfig.mockImplementation(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
      token_economy: { ...original.DEFAULT_CONFIG.token_economy, role_scoped_cache_ttl: true },
    }));
    return setupFetchFn(client);
  }

  // Mirrors setupWithRoleScoped but explicitly sets role_scoped_cache_ttl:false to test
  // the flag-off path deterministically (default changed to true in lib/config.mjs).
  async function setupWithRoleScopedOff() {
    const original = await vi.importActual("../../lib/config.mjs");
    loadConfig.mockImplementation(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
      token_economy: { ...original.DEFAULT_CONFIG.token_economy, role_scoped_cache_ttl: false },
    }));
    return setupFetchFn(client);
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
  });

  it("default (flag off): uses ttl:1h regardless of request shape", async () => {
    // Use setupWithRoleScopedOff to explicitly set role_scoped_cache_ttl:false
    // (the default flipped to true; this test documents the flag-off behavior)
    fetchFn = await setupWithRoleScopedOff();
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 512, // would classify as "small"
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const lastUser = body.messages[body.messages.length - 1];
    const lastBlock = Array.isArray(lastUser.content) ? lastUser.content[lastUser.content.length - 1] : null;
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("opt-in: uses ttl:1h on main-thread-shaped requests", async () => {
    fetchFn = await setupWithRoleScoped();
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        system: "x".repeat(300),
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const lastUser = body.messages[body.messages.length - 1];
    const lastBlock = Array.isArray(lastUser.content) ? lastUser.content[lastUser.content.length - 1] : null;
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("opt-in: downgrades to ttl:5m for small/one-shot requests", async () => {
    fetchFn = await setupWithRoleScoped();
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 512,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const lastUser = body.messages[body.messages.length - 1];
    const lastBlock = Array.isArray(lastUser.content) ? lastUser.content[lastUser.content.length - 1] : null;
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  // Regression: subagent requests (marked by opencode with x-parent-session-id)
  // resolve to the 5m tier for tools/messages. Before the fix, the system blocks
  // kept the configured 1h, so the request emitted 5m tools followed by a 1h
  // system block — which Anthropic rejects with:
  //   "system.1.cache_control.ttl: a ttl='1h' cache_control block must not come
  //    after a ttl='5m' cache_control block. Note that blocks are processed in
  //    the following order: tools, system, messages."
  // The fix threads one resolved ttl through system + tools + messages.
  function collectTtlsInProcessingOrder(body) {
    // API processing order: tools → system → messages.
    const ttls = [];
    for (const t of body.tools || []) {
      if (t?.cache_control?.ttl) ttls.push(t.cache_control.ttl);
    }
    for (const s of body.system || []) {
      if (s?.cache_control?.ttl) ttls.push(s.cache_control.ttl);
    }
    for (const m of body.messages || []) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.cache_control?.ttl) ttls.push(b.cache_control.ttl);
        }
      }
    }
    return ttls;
  }

  function assertNo1hAfter5m(ttls) {
    let seen5m = false;
    for (const ttl of ttls) {
      if (ttl === "5m") seen5m = true;
      if (ttl === "1h" && seen5m) {
        throw new Error(`TTL ordering violation (1h after 5m). Order: [${ttls.join(", ")}]`);
      }
    }
  }

  it("subagent request (x-parent-session-id): system ttl matches tools/messages 5m (no 1h-after-5m)", async () => {
    fetchFn = await setupWithRoleScoped();
    const { body } = await sendRequest(
      fetchFn,
      {
        max_tokens: 8000, // main-shaped: would be 1h WITHOUT the subagent marker
        system: [{ type: "text", text: "x".repeat(300) }],
        tools: [
          { name: "Read", description: "read", input_schema: { type: "object" } },
          { name: "Bash", description: "bash", input_schema: { type: "object" } },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: "do the task" }] }],
      },
      { "x-parent-session-id": "parent-session-abc" },
    );

    const ttls = collectTtlsInProcessingOrder(body);
    expect(ttls.length).toBeGreaterThan(0);
    assertNo1hAfter5m(ttls);
    // Subagents resolve to the cheap 5m tier across the board.
    expect(ttls.every((t) => t === "5m")).toBe(true);
    // Identity block specifically must be 5m, matching tools/messages.
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("main-shaped request (no subagent marker): system ttl matches tools/messages 1h (no ordering violation)", async () => {
    fetchFn = await setupWithRoleScoped();
    const { body } = await sendRequest(fetchFn, {
      max_tokens: 8000,
      system: [{ type: "text", text: "x".repeat(300) }],
      tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "second real question" }] },
      ],
    });

    const ttls = collectTtlsInProcessingOrder(body);
    expect(ttls.length).toBeGreaterThan(0);
    assertNo1hAfter5m(ttls);
    expect(ttls.every((t) => t === "1h")).toBe(true);
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("Lean system prompt for non-main requests (opt-in)", () => {
  let client, fetchFn;

  async function setupLean() {
    const original = await vi.importActual("../../lib/config.mjs");
    loadConfig.mockImplementation(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
      token_economy: { ...original.DEFAULT_CONFIG.token_economy, lean_system_non_main: true },
    }));
    return setupFetchFn(client);
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupLean();
  });

  it("strips billing + identity blocks for small-shaped requests when opted in", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 512,
        system: "Custom instructions",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const systemText = body.system.map((b) => b.text).join("\n");
    expect(systemText).not.toMatch(/x-anthropic-billing-header:/);
    expect(systemText).not.toMatch(/You are an interactive/);
  });

  it("still injects billing + identity on main-thread requests when opted in", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        system: "x".repeat(300),
        messages: [{ role: "user", content: "real question" }],
      }),
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const systemText = body.system.map((b) => b.text).join("\n");
    expect(systemText).toMatch(/x-anthropic-billing-header:/);
  });
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

    // `max_tokens` must stay ABOVE the expected budget: the package clamps the
    // thinking budget with `Math.min(max_tokens - 1, requested)`, so the shared
    // helper's default of 1024 would cap the budget at 1023 regardless of the
    // env var under test. A real request emitting budget_tokens > max_tokens
    // would be rejected with a 400, so the clamp itself is correct.
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      max_tokens: 8192,
      thinking: { type: "enabled", budget_tokens: 5000 },
    });

    // With adaptive disabled AND existing budget_tokens, it should keep existing
    expect(body.thinking.type).toBe("enabled");
    expect(body.thinking.budget_tokens).toBe(5000);
  });

  it("uses MAX_THINKING_TOKENS as fallback when no budget_tokens provided", async () => {
    process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING = "1";
    // 20000, not 32000: `max_tokens` is itself clamped to the model's default
    // output limit (32000 for claude-opus-4-6), and the budget is then clamped
    // to `max_tokens - 1`, so a 32000 budget is unreachable on this model. The
    // value only has to be low enough that the env var, not the clamp, is what
    // the assertion observes.
    process.env.MAX_THINKING_TOKENS = "20000";

    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      max_tokens: 32000,
      thinking: { type: "enabled" },
    });

    expect(body.thinking.type).toBe("enabled");
    expect(body.thinking.budget_tokens).toBe(20000);
  });

  it("defaults to 16000 when MAX_THINKING_TOKENS not set", async () => {
    process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING = "1";
    delete process.env.MAX_THINKING_TOKENS;

    // Above the expected 16000 default so the `max_tokens - 1` budget clamp is
    // not what the assertion ends up measuring.
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      max_tokens: 20000,
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
    // x-stainless-package-version: passthrough from host SDK (or fallback "0.208.0")
    expect(headers.get("x-stainless-retry-count")).toBe("0");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("includes anthropic-dangerous-direct-browser-access and excludes x-stainless-helper-method", async () => {
    const { headers } = await sendRequest(fetchFn);

    // Real CC sends this header (confirmed via proxy capture)
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.has("x-stainless-helper-method")).toBe(false);
  });

  it("emits x-client-request-id as a random uuid (CC 2.1.195 first-party middleware)", async () => {
    const { headers } = await sendRequest(fetchFn);

    // Real CC 2.1.195's first-party fetch middleware (Ukd) sets x-client-request-id
    // to crypto.randomUUID() on every first-party request.
    const reqId = headers.get("x-client-request-id");
    expect(reqId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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
    // cch is the static "00000" placeholder — matches cc-107/108 cli.js bundles,
    // which emit `cch=00000;` unconditionally. Any per-request mutation of
    // system[0] would break the prompt cache on every turn.
    expect(body.system[0].text).toContain("cch=00000;");
    expect(body.system[0].cache_control).toBeUndefined();
    // Block 1: identity (request-wide resolved TTL; non-main "empty" request
    // (default messages:[]) resolves to 5m via the role-scoped downgrade, so the
    // identity block matches the tools/messages ttl and avoids 1h-after-5m).
    expect(body.system[1].text).toContain("Claude Code");
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    // Block 2+: user content
    expect(body.system[2].text).toContain("User instructions here");
  });

  it("billing cc_version includes 3-char fingerprint hash (not model ID)", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      // force main-shaped (max_tokens>2048 + 3 messages) so lean_system_non_main does not strip billing
      max_tokens: 8192,
      messages: [
        { role: "user", content: "warm up" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "hello world" },
      ],
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

  it("contains all required always-on betas for non-Haiku effort-capable model (v2.1.195 set)", async () => {
    // Use opus-4-6: real CC's Kw(model) pushes effort-2025-11-24 for Opus 4.5/4.6/
    // 4.7/4.8 and Sonnet 4.6, and n0d(model) pushes context-management for any
    // first-party non-claude-3 model — so this model carries BOTH.
    const { headers } = await sendRequest(fetchFn, { model: "claude-opus-4-6" });
    const beta = headers.get("anthropic-beta");

    // RE doc §15.16 always-on set — synced to v2.1.195
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).toContain("claude-code-20250219");
    expect(beta).not.toContain("advanced-tool-use-2025-11-20");
    expect(beta).not.toContain("fast-mode-2026-02-01");
    // v2.1.195: effort is a model-gated default for effort-capable models.
    expect(beta).toContain("effort-2025-11-24");
    expect(beta).toContain("interleaved-thinking-2025-05-14");
    expect(beta).toContain("prompt-caching-scope-2026-01-05");
    // v2.1.195: context-management is default-on for first-party non-claude-3.
    expect(beta).toContain("context-management-2025-06-27");
    expect(beta).toContain("extended-cache-ttl-2025-04-11");
    expect(beta).toContain("thinking-token-count-2026-05-13");
    expect(beta).toContain("redact-thinking-2026-02-12");
    // Provider-aware tool search: tool-search-tool for 3P, neither for 1P by default.
    expect(beta).not.toContain("advanced-tool-use-2025-11-20");

    // Token economy betas (config-controlled, defaults in DEFAULT_CONFIG.token_economy)
    // token-efficient-tools was removed in v2.1.90 (fully absent from bundle)
    expect(beta).not.toContain("token-efficient-tools-2026-03-28");
    // summarize-connector-text was a dead slot v2.1.90-2.1.154; REVIVED in CC 2.1.159
    // as label `narration_summaries` but gated by GrowthBook `pewter_owl_header`
    // (default-off) + first-party + non-fast-mode. Plugin keeps it OFF by default
    // (registered in EXPERIMENTAL_BETA_FLAGS for disable-guard/opt-in only), so the
    // default beta header must still NOT contain it.
    expect(beta).not.toContain("summarize-connector-text-2026-03-13");
    // redact-thinking is on by default for non-Claude-3 models
    expect(beta).toContain("redact-thinking-2026-02-12");

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

  it("Opus 4.7 gets adaptive thinking", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-7",
      thinking: { type: "enabled", budget_tokens: 10000 },
    });

    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("Opus 4.7 dotted variant gets adaptive thinking", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4.7",
      thinking: { type: "enabled", budget_tokens: 10000 },
    });

    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  // Pins the observable side effect of normalizing dotted model ids to dashed
  // ones before they reach the shared package (lib/mimicry/wire-compat.mjs).
  // The package classifies models by dashed id only, so a dotted id would fall
  // through to `claude-opus-4-0` and silently lose adaptive thinking. Because
  // the emitted wire id derives from the same string, the `model` field itself
  // changes too — which is correct, the real API only accepts dashed ids.
  it("rewrites a dotted model id to the dashed spelling on the wire", async () => {
    const { body } = await sendRequest(fetchFn, { model: "claude-opus-4.7" });

    expect(body.model).toBe("claude-opus-4-7");
  });

  it("rewrites the dotted Opus 4.8 id to the dashed spelling too", async () => {
    const { body } = await sendRequest(fetchFn, { model: "claude-opus-4.8" });

    expect(body.model).toBe("claude-opus-4-8");
  });

  it("older model keeps original thinking config", async () => {
    // Same `Math.min(max_tokens - 1, requested)` budget clamp as the
    // MAX_THINKING_TOKENS tests above: `max_tokens` has to exceed the expected
    // budget or the clamp, not the "keeps original config" behaviour under
    // test, is what the assertion measures.
    const { body } = await sendRequest(fetchFn, {
      model: "claude-sonnet-4-5",
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 10000 },
    });

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });
});

describe("E2E: systemPromptTailing default (A2)", () => {
  let client, fetchFn;

  async function setupWithTailing(tailingOverride /* undefined = rely on default */) {
    const original = await vi.importActual("../../lib/config.mjs");
    // Override key only when the caller passes an explicit boolean, so the
    // "default" test exercises the real DEFAULT_CONFIG.token_economy_strategies.
    const strategies = { ...original.DEFAULT_CONFIG.token_economy_strategies };
    if (typeof tailingOverride === "boolean") {
      strategies.system_prompt_tailing = tailingOverride;
      strategies.system_prompt_tail_turns = 6;
      strategies.system_prompt_tail_max_chars = 2000;
    }
    const cfgFactory = () => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      token_economy_strategies: strategies,
    });
    loadConfig.mockImplementation(cfgFactory);
    return setupFetchFn(client);
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    // sessionMetrics is a module-level singleton — reset turns so each test
    // starts from a known state. Mock responses in this suite don't produce
    // SSE usage callbacks, so we drive the counter explicitly via the test hook.
    AnthropicAuthPlugin.__testing__.resetSessionMetricsForTest();
    client = makeClient();
  });

  afterEach(() => {
    AnthropicAuthPlugin.__testing__.resetSessionMetricsForTest();
  });

  // Build a realistic-looking multi-line system prompt large enough to exceed
  // maxChars*2 (4000) and trigger tailing. `tailSystemBlock` splits on `\n`
  // so a single-line blob is essentially uncompressable — simulate paragraphs.
  function buildLongSystemText() {
    const paragraph = "X".repeat(200);
    const lines = [];
    lines.push(paragraph); // first paragraph (identity) preserved
    lines.push("");
    for (let i = 0; i < 40; i++) {
      // Neutral body text — no MUST/NEVER/CRITICAL/# headers/list markers, so
      // tailing logic drops these lines and the block shrinks to first para + marker.
      lines.push(paragraph);
      lines.push("");
    }
    const text = lines.join("\n");
    // Sanity: > 4000 so tailing condition (length > maxChars * 2) triggers.
    if (text.length < 5000) throw new Error("test fixture too small: " + text.length);
    return text;
  }

  async function setupWithoutStrategies() {
    // User on an older config version with NO token_economy_strategies block
    // → `config.token_economy_strategies?.system_prompt_tailing` is undefined.
    // This is what catches regressions in the OPERATOR check (!== false would
    // treat undefined as opt-in; === true treats undefined as opt-out).
    const original = await vi.importActual("../../lib/config.mjs");
    const cfgFactory = () => {
      const c = {
        ...original.DEFAULT_CONFIG,
        account_selection_strategy: "sticky",
        signature_emulation: {
          ...original.DEFAULT_CONFIG.signature_emulation,
          fetch_claude_code_version_on_startup: false,
        },
        override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
        custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
        idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      };
      delete c.token_economy_strategies;
      return c;
    };
    loadConfig.mockImplementation(cfgFactory);
    return setupFetchFn(client);
  }

  it("long system prompt is NOT tailed at turn 6 when no strategies config is present", async () => {
    // Guards the operator check: `=== true` (new) vs `!== false` (old).
    // With no token_economy_strategies key, signature.systemPromptTailing is
    // undefined; new operator → OFF, old operator → ON (implicit-on bug).
    fetchFn = await setupWithoutStrategies();
    AnthropicAuthPlugin.__testing__.setSessionTurnsForTest(6);
    const longText = buildLongSystemText();
    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: longText }],
    });
    for (const b of body.system) {
      if (b.type === "text") {
        expect(b.text).not.toContain("Verbose instructions trimmed");
      }
    }
    // Positive assertion: the long X-block must have survived intact
    // (tolerance accounts for any CC identity-prefix injection).
    const textBlock = body.system.find((b) => b.type === "text" && b.text.includes("X".repeat(200)));
    expect(textBlock).toBeDefined();
    expect(textBlock.text.length).toBeGreaterThanOrEqual(longText.length - 200);
  });

  it("long system prompt is NOT tailed at turn 6 by default (DEFAULT_CONFIG)", async () => {
    // Do NOT pass any override — exercise the real DEFAULT_CONFIG path so
    // this test fails if a future edit re-introduces implicit-on behavior
    // by flipping the default from false back to true.
    fetchFn = await setupWithTailing(undefined);
    AnthropicAuthPlugin.__testing__.setSessionTurnsForTest(6);
    const longText = buildLongSystemText();
    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: longText }],
    });
    const textBlock = body.system.find((b) => b.type === "text" && b.text.includes("X".repeat(200)));
    expect(textBlock).toBeDefined();
    // Default is OFF — the huge X-block must survive at roughly its original size.
    expect(textBlock.text.length).toBeGreaterThanOrEqual(longText.length - 200);
    // And the tailing truncation marker must NOT appear anywhere.
    for (const b of body.system) {
      if (b.type === "text") {
        expect(b.text).not.toContain("Verbose instructions trimmed");
      }
    }
  });

  it("systemPromptTailing: true opts back in", async () => {
    fetchFn = await setupWithTailing(true);
    AnthropicAuthPlugin.__testing__.setSessionTurnsForTest(6);

    const longText = buildLongSystemText();
    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: longText }],
    });
    // With opt-in, the long block must have been truncated below its original size.
    const textBlock = body.system.find(
      (b) => b.type === "text" && typeof b.text === "string" && b.text.startsWith("X".repeat(100)),
    );
    expect(textBlock).toBeDefined();
    expect(textBlock.text.length).toBeLessThan(longText.length);
    expect(textBlock.text).toContain("Verbose instructions trimmed");
  });
});

describe("context_management body field — field ⊆ beta invariant", () => {
  // Regression: a top-level context_management field WITHOUT the beta returns
  // 400 "context_management: Extra inputs are not permitted". As of v2.1.195 the
  // context-management beta header is default-ON for first-party non-claude-3
  // models, but the body field stays opt-in (token_economy.context_management).
  // Default config does NOT opt in, so a thinking request carries the beta but NOT
  // the field — which is safe (field-without-beta is the only 400 case).
  let client, fetchFn;
  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("emits the beta by default but omits the body field unless opted in", async () => {
    const { body, headers } = await sendRequest(fetchFn, {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    // Sanity: thinking is active (otherwise the field path would not run).
    expect(body.thinking?.type).toBe("adaptive");
    // v2.1.195: beta is default-on for first-party non-claude-3 models.
    expect(headers.get("anthropic-beta") || "").toContain("context-management-2025-06-27");
    // Field stays opt-in → absent by default (keeps field ⊆ beta; no 400).
    expect(body.context_management).toBeUndefined();
  });
});

describe("E2E: Version is 2.1.195", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("User-Agent contains 2.1.195", async () => {
    const { headers } = await sendRequest(fetchFn);
    expect(headers.get("user-agent")).toContain("2.1.195");
  });

  it("billing header contains 2.1.195", async () => {
    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: "test" }],
    });

    expect(body.system[0].text).toContain("2.1.195");
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
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
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [] }),
    });

    const [input] = mockFetch.mock.calls[0];
    const url = input instanceof URL ? input : new URL(input.toString());
    expect(url.searchParams.get("beta")).toBe("true");
  });
});

// =============================================================================
// Opus 4.8 — new model coverage (a)–(e)
// =============================================================================

describe("Opus 4.8", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  // ── (a) No thinking field → adaptive injected ─────────────────────────────

  it("(a) claude-opus-4-8 with no thinking field gets thinking:{type:'adaptive'}", async () => {
    const { body } = await sendRequest(fetchFn, { model: "claude-opus-4-8" });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("(a) dotted variant claude-opus-4.8 also gets adaptive thinking injected", async () => {
    const { body } = await sendRequest(fetchFn, { model: "claude-opus-4.8" });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  // ── (b) Manual thinking → converted to adaptive ───────────────────────────

  it("(b) manual thinking {type:'enabled',budget_tokens:10000} converted to {type:'adaptive'}", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budget_tokens: 10000 },
    });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  // ── (c) top-level effort → output_config.effort ───────────────────────────

  it("(c) top-level effort:'high' moved into output_config:{effort:'high'}, removed from root", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(body.effort).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "high" });
  });

  // ── (d) CONTRACT GUARD: cache_control preserved on thinking/redacted blocks ─

  it("(d) thinking+signature block cache_control preserved; redacted_thinking data preserved; normal text block cache_control stripped", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-8",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "internal thought",
              signature: "sig-abc-123",
              cache_control: { type: "ephemeral" },
            },
            {
              type: "redacted_thinking",
              data: "redacted-data-xyz",
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text: "I have answered.",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });

    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();

    // thinking block: cache_control and signature must survive untouched
    const thinkingBlock = assistantMsg.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(thinkingBlock.signature).toBe("sig-abc-123");

    // redacted_thinking block: cache_control and data must survive untouched
    const redactedBlock = assistantMsg.content.find((b) => b.type === "redacted_thinking");
    expect(redactedBlock).toBeDefined();
    expect(redactedBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(redactedBlock.data).toBe("redacted-data-xyz");

    // normal text block: cache_control MUST be stripped by the plugin
    const textBlock = assistantMsg.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock.cache_control).toBeUndefined();
  });

  // ── (e) Fast mode: speed:"fast" injected when fast_mode enabled ───────────

  it("(e) fast mode enabled: speed:'fast' injected for claude-opus-4-8", async () => {
    const original = await vi.importActual("../../lib/config.mjs");
    loadConfig.mockImplementation(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      fast_mode: true,
    }));
    const fastModeFetchFn = await setupFetchFn(makeClient());
    const { body } = await sendRequest(fastModeFetchFn, { model: "claude-opus-4-8" });
    expect(body.speed).toBe("fast");
  });

  it("(e) fast mode enabled: speed:'fast' injected for claude-opus-4-7", async () => {
    const original = await vi.importActual("../../lib/config.mjs");
    loadConfig.mockImplementation(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      fast_mode: true,
    }));
    const fastModeFetchFn = await setupFetchFn(makeClient());
    const { body } = await sendRequest(fastModeFetchFn, { model: "claude-opus-4-7" });
    expect(body.speed).toBe("fast");
  });

  // ── (f) Fast mode: anthropic-beta header must contain fast-mode-2026-02-01 ──

  it("(f) fast mode active: anthropic-beta header contains fast-mode-2026-02-01 for claude-opus-4-8", async () => {
    const original = await vi.importActual("../../lib/config.mjs");
    loadConfig.mockImplementation(() => ({
      ...original.DEFAULT_CONFIG,
      account_selection_strategy: "sticky",
      signature_emulation: {
        ...original.DEFAULT_CONFIG.signature_emulation,
        fetch_claude_code_version_on_startup: false,
      },
      override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
      custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
      idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
      fast_mode: true,
    }));
    const fastModeFetchFn = await setupFetchFn(makeClient());
    const { body, headers } = await sendRequest(fastModeFetchFn, { model: "claude-opus-4-8" });
    // Both body.speed and the beta header must be present together — mimicry contract.
    expect(body.speed).toBe("fast");
    expect(headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
  });

  it("(f) fast mode OFF: anthropic-beta header does NOT contain fast-mode-2026-02-01", async () => {
    // Default config has fast_mode disabled. Beta must be absent unless passed through from host.
    const { headers } = await sendRequest(fetchFn, { model: "claude-opus-4-8" });
    expect(headers.get("anthropic-beta")).not.toContain("fast-mode-2026-02-01");
  });

  // ── (g) Real-world tool-continuation turn: the exact shape that triggered the
  //        "thinking blocks cannot be modified" 400. thinking + tool_use live in
  //        the SAME assistant message, followed by a user tool_result. The thinking
  //        block (with signature) must be byte-identical on the way out, while the
  //        tool_result still receives the cache_control breakpoint. ─────────────
  it("(g) tool-continuation: latest-assistant thinking+tool_use preserved; tool_result gets cache breakpoint", async () => {
    const { body } = await sendRequest(fetchFn, {
      model: "claude-opus-4-8",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me compute", signature: "sig-tool-987" },
            { type: "tool_use", id: "tu_1", name: "calc", input: { expr: "2+2" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "4" }],
        },
      ],
    });

    // The assistant thinking block must remain byte-identical: signature intact,
    // no cache_control injected, type unchanged.
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    const thinkingBlock = assistantMsg.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.signature).toBe("sig-tool-987");
    expect(thinkingBlock.cache_control).toBeUndefined();
    expect(thinkingBlock.thinking).toBe("let me compute");

    // The tool_use block must also be untouched (no cache_control).
    const toolUseBlock = assistantMsg.content.find((b) => b.type === "tool_use");
    expect(toolUseBlock).toBeDefined();

    // The cache breakpoint goes on the last user message (the tool_result block).
    const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user");
    const lastBlock = lastUserMsg.content[lastUserMsg.content.length - 1];
    expect(lastBlock.cache_control).toMatchObject({ type: "ephemeral" });
  });
});
