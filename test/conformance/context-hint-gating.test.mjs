/**
 * Phase C Task C2 — Conformance tests for context-hint default flip.
 *
 * With C1 proving applyContextHintCompaction is byte-deterministic, the
 * default for `token_economy.context_hint` flips from false to true.
 * These tests pin:
 *   1. Default resolves to true
 *   2. Explicit opt-out (false) honored
 *   3. Explicit opt-in (true) honored
 *   4. Gating: claude-3 models excluded
 *   5. Gating: non-first-party provider (bedrock/vertex/mantle) excluded
 *   6. Gating: non-main-thread (title/small/empty) excluded
 *   7. Main-thread + first-party + claude-4 — beta sent; latch keeps it on
 *      for subsequent requests (sticky-ON design)
 *
 * Test harness mirrors test/conformance/regression.test.mjs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — mirrors regression.test.mjs
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

vi.mock("../../lib/context-hint-persist.mjs", () => ({
  loadContextHintDisabledFlag: vi.fn(() => ({ disabled: false })),
  saveContextHintDisabledFlag: vi.fn(),
  getContextHintFlagPath: vi.fn(() => "/tmp/test-context-hint-disabled.flag"),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { AnthropicAuthPlugin } from "../../index.mjs";
import { saveAccounts, loadAccounts } from "../../lib/storage.mjs";
import { loadConfig, DEFAULT_CONFIG } from "../../lib/config.mjs";

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

function makeAccountsData(accountOverrides = [{}]) {
  return {
    version: 1,
    accounts: accountOverrides.map((o, i) =>
      makeStoredAccount({ refreshToken: `refresh-${i + 1}`, addedAt: (i + 1) * 1000, ...o }),
    ),
    activeIndex: 0,
  };
}

async function setupFetchFn(client) {
  const data = makeAccountsData();
  loadAccounts.mockResolvedValue(data);
  saveAccounts.mockResolvedValue(undefined);

  const plugin = await AnthropicAuthPlugin({ client });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: data.accounts[0].refreshToken,
    access: "access-1",
    expires: Date.now() + 3600_000,
  });

  const result = await plugin.auth.loader(getAuth, makeProvider());
  return result.fetch;
}

// Main-thread classification requires: long system prompt (>=200 chars),
// messages.length > 2 OR sysLen>=200 with maxTokens>2048, and not matching
// title/small heuristics in classifyRequestRole.
const MAIN_THREAD_BODY = (overrides = {}) => ({
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system: "x".repeat(300),
  messages: [{ role: "user", content: "hello main thread" }],
  ...overrides,
});

async function sendRequest(fetchFn, bodyOverrides = {}, url = "https://api.anthropic.com/v1/messages") {
  mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

  await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...MAIN_THREAD_BODY(), ...bodyOverrides }),
  });

  const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return {
    headers: init.headers,
    body: JSON.parse(init.body),
  };
}

beforeEach(() => {
  // Clean slate for env vars that affect provider detection / gating.
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  delete process.env.CLAUDE_CODE_USE_MANTLE;
  delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  delete process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS;
  delete process.env.ANTHROPIC_BETAS;
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
  delete process.env.OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT;
  process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "test-signature-user";
});

// =============================================================================
// Default value tests (Phase C2 flip)
// =============================================================================

describe("Phase C2: context_hint default flipped to true", () => {
  it("DEFAULT_CONFIG.token_economy.context_hint === true", () => {
    expect(DEFAULT_CONFIG.token_economy.context_hint).toBe(true);
  });

  it("loadConfig() returns context_hint === true when no user override", () => {
    const cfg = loadConfig();
    expect(cfg.token_economy.context_hint).toBe(true);
  });
});

// =============================================================================
// Per-request gating with default-on config
// =============================================================================

describe("Phase C2: context-hint beta emitted by default on first-party main-thread", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    // Reapply default loadConfig after resetAllMocks
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
    }));
    fetchFn = await setupFetchFn(client);
  });

  it("default config + claude-4 + main-thread → beta sent + body context_hint present", async () => {
    const { headers, body } = await sendRequest(fetchFn);

    expect(headers.get("anthropic-beta")).toContain("context-hint-2026-04-09");
    expect(body.context_hint).toEqual({ enabled: true });
  });

  it("latch keeps beta sticky-on across subsequent main-thread requests", async () => {
    // First request
    const first = await sendRequest(fetchFn);
    expect(first.headers.get("anthropic-beta")).toContain("context-hint-2026-04-09");

    // Second request — latch is sticky-ON so beta stays in header.
    const second = await sendRequest(fetchFn);
    expect(second.headers.get("anthropic-beta")).toContain("context-hint-2026-04-09");
  });
});

describe("Phase C2: explicit opt-out respected", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
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
      token_economy: { ...original.DEFAULT_CONFIG.token_economy, context_hint: false },
    }));
    fetchFn = await setupFetchFn(client);
  });

  it("context_hint=false → beta NOT sent, body field absent", async () => {
    const { headers, body } = await sendRequest(fetchFn);

    expect(headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(body.context_hint).toBeUndefined();
  });
});

describe("Phase C2: explicit opt-in honored (matches new default behavior)", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
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
      token_economy: { ...original.DEFAULT_CONFIG.token_economy, context_hint: true },
    }));
    fetchFn = await setupFetchFn(client);
  });

  it("context_hint=true → beta sent, body field present", async () => {
    const { headers, body } = await sendRequest(fetchFn);

    expect(headers.get("anthropic-beta")).toContain("context-hint-2026-04-09");
    expect(body.context_hint).toEqual({ enabled: true });
  });
});

// =============================================================================
// Gating: excluded scenarios
// =============================================================================

describe("Phase C2: gating — claude-3 models excluded", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
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
    }));
    fetchFn = await setupFetchFn(client);
  });

  it("claude-3-5-sonnet → beta NOT sent even with default-on + main-thread", async () => {
    const { headers, body } = await sendRequest(fetchFn, { model: "claude-3-5-sonnet-20241022" });

    expect(headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(body.context_hint).toBeUndefined();
  });
});

describe("Phase C2: gating — non-first-party provider excluded", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
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
    }));
    fetchFn = await setupFetchFn(client);
  });

  it("bedrock provider (env flag) → beta NOT sent", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const { headers, body } = await sendRequest(fetchFn);

    expect(headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(body.context_hint).toBeUndefined();
  });

  it("vertex provider (env flag) → beta NOT sent", async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    const { headers, body } = await sendRequest(fetchFn);

    expect(headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(body.context_hint).toBeUndefined();
  });
});

describe("Phase C2: gating — non-main-thread excluded", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
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
    }));
    fetchFn = await setupFetchFn(client);
  });

  it("title-gen shape (small max_tokens + 1 message) → beta NOT sent", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 100, // classifies as "title"
        messages: [{ role: "user", content: "pick a title" }],
      }),
    });

    const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(init.headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(JSON.parse(init.body).context_hint).toBeUndefined();
  });

  it("small background query (short system + 1 msg) → beta NOT sent", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024, // classifies as "small"
        system: "short",
        messages: [{ role: "user", content: "quick question" }],
      }),
    });

    const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(init.headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(JSON.parse(init.body).context_hint).toBeUndefined();
  });
});
