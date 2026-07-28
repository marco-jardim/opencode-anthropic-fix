/**
 * Conformance tests for the deprecated Claude Code context-hint knob.
 *
 * The genuine Claude Code 2.1.195 client sends neither the
 * `context-hint-2026-04-09` beta nor the paired `context_hint` body field, so
 * emitting either one would make requests fingerprintable. Both emissions were
 * removed from every request path (adapter and legacy), and
 * `token_economy.context_hint` is deprecated rather than honoured.
 *
 * These tests pin:
 *   1. Default resolves to false
 *   2. Explicit opt-out (false) changes nothing
 *   3. Explicit opt-in (true) ALSO changes nothing — no beta, no body field,
 *      on the first request and on every subsequent one
 *   4. The same holds for the old gating dimensions (claude-3 models,
 *      non-first-party providers, non-main-thread request shapes), which are
 *      kept because their INPUT shape is still discriminating
 *   5. The knob is not a silent no-op: an explicit opt-in emits a one-time
 *      deprecation warning from validateConfig
 *
 * Test harness mirrors test/conformance/regression.test.mjs.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// Default value tests
// =============================================================================

describe("Claude Code 2.1.195 context_hint default", () => {
  it("DEFAULT_CONFIG.token_economy.context_hint === false", () => {
    expect(DEFAULT_CONFIG.token_economy.context_hint).toBe(false);
  });

  it("loadConfig() returns context_hint === false when no user override", () => {
    const cfg = loadConfig();
    expect(cfg.token_economy.context_hint).toBe(false);
  });

  it("requires context_hint to be explicitly opted in", () => {
    const cfg = loadConfig({ token_economy: {} });
    expect(cfg.token_economy.context_hint).toBe(false);
  });
});

// =============================================================================
// Per-request gating with default-off config
// =============================================================================

describe("context-hint beta is absent by default on first-party main-thread", () => {
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

  it("default config + claude-4 + main-thread → beta and body context_hint absent", async () => {
    const { headers, body } = await sendRequest(fetchFn);

    expect(headers.get("anthropic-beta")).not.toContain("context-hint-2026-04-09");
    expect(body.context_hint).toBeUndefined();
  });

  it("default-off remains sticky across subsequent main-thread requests", async () => {
    // First request
    const first = await sendRequest(fetchFn);
    expect(first.headers.get("anthropic-beta")).not.toContain("context-hint-2026-04-09");

    // Second request — the false default keeps the beta absent.
    const second = await sendRequest(fetchFn);
    expect(second.headers.get("anthropic-beta")).not.toContain("context-hint-2026-04-09");
  });
});

describe("context-hint explicit opt-out", () => {
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

describe("context-hint explicit opt-in", () => {
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

  it("context_hint=true → beta STILL not sent (knob deprecated, emission removed)", async () => {
    const { headers, body } = await sendRequest(fetchFn);

    // The knob used to push the beta here. It no longer does, on any path: the
    // genuine Claude Code 2.1.195 client sends neither the beta nor the body
    // field, so emitting them was a fingerprint. The opt-in now only produces a
    // deprecation warning at config-validation time (see the describe below).
    expect(headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(body.context_hint).toBeUndefined();
  });

  it("context_hint=true → beta absent on every subsequent request too", async () => {
    const first = await sendRequest(fetchFn);
    const second = await sendRequest(fetchFn);

    expect(first.headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(second.headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(first.body.context_hint).toBeUndefined();
    expect(second.body.context_hint).toBeUndefined();
  });
});

// =============================================================================
// Gating: excluded scenarios
// =============================================================================

describe("context-hint gating — claude-3 models excluded", () => {
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

  it("claude-3-5-sonnet → beta NOT sent even with explicit opt-in + main-thread", async () => {
    const { headers, body } = await sendRequest(fetchFn, { model: "claude-3-5-sonnet-20241022" });

    expect(headers.get("anthropic-beta") || "").not.toContain("context-hint-2026-04-09");
    expect(body.context_hint).toBeUndefined();
  });
});

describe("context-hint gating — non-first-party provider excluded", () => {
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

describe("context-hint gating — non-main-thread excluded", () => {
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

// =============================================================================
// Deprecation: the knob must not become a silent no-op
// =============================================================================

describe("token_economy.context_hint deprecation warning", () => {
  // This suite deliberately bypasses the module-level vi.mock of lib/config.mjs:
  // the warning lives in validateConfig, which a mocked loadConfig never reaches.
  // getConfigDir() reads APPDATA on win32 and XDG_CONFIG_HOME elsewhere, and both
  // resolve to <dir>/opencode/anthropic-auth.json, so pointing both at a temp dir
  // makes the real loader hermetic on every platform.
  let tmpRoot;
  let configPath;
  let savedAppData;
  let savedXdg;
  let realConfig;
  let warnSpy;

  const writeUserConfig = (tokenEconomy) => {
    writeFileSync(configPath, JSON.stringify({ token_economy: tokenEconomy }), "utf-8");
  };

  beforeAll(async () => {
    realConfig = await vi.importActual("../../lib/config.mjs");
    tmpRoot = mkdtempSync(join(tmpdir(), "opencode-context-hint-"));
    mkdirSync(join(tmpRoot, "opencode"), { recursive: true });
    configPath = join(tmpRoot, "opencode", "anthropic-auth.json");

    savedAppData = process.env.APPDATA;
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = tmpRoot;
    process.env.XDG_CONFIG_HOME = tmpRoot;
  });

  afterAll(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Ordered on purpose: the warning latch is one-shot per process, so the two
  // silent cases must be proven before the opt-in trips it.
  it("stays silent for the default (knob absent from the config file)", () => {
    writeUserConfig({});

    const cfg = realConfig.loadConfig();

    expect(cfg.token_economy.context_hint).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays silent for an explicit opt-out (context_hint: false)", () => {
    writeUserConfig({ context_hint: false });

    const cfg = realConfig.loadConfig();

    expect(cfg.token_economy.context_hint).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns on an explicit opt-in (context_hint: true) instead of silently ignoring it", () => {
    writeUserConfig({ context_hint: true });

    const cfg = realConfig.loadConfig();

    // The value is still normalized so an existing config file keeps loading...
    expect(cfg.token_economy.context_hint).toBe(true);
    // ...but the user is told the switch does nothing.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0];
    expect(message).toContain("[anthropic-auth]");
    expect(message).toContain("token_economy.context_hint");
    expect(message).toContain("deprecated");
    expect(message).toContain("no effect");
  });

  it("warns only once per process, not on every config reload", () => {
    writeUserConfig({ context_hint: true });

    realConfig.loadConfig();
    realConfig.loadConfig();

    // The latch tripped in the previous test; reloads must stay quiet.
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
