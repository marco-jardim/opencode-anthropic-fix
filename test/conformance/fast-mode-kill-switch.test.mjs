// FAST MODE — kill switch, catalogue gate and fast-pool fallback, driven through
// the REAL fetch interceptor with a stubbed `fetch`.
//
// What this pins (the wire-level half of lib/mimicry/request-body.test.mjs):
//  - `OPENCODE_ANTHROPIC_DISABLE_FAST_MODE` truthy -> no `speed` and no
//    `fast-mode-2026-02-01` beta on the wire, even when the HOST sent both;
//  - a host-sent `speed: "fast"` on a model without the catalogue capability is
//    dropped together with its beta; on a fast-capable model both are kept;
//  - a fast-pool 429 retries on the same account WITHOUT `speed` and WITHOUT the
//    beta, including when `speed` came from the host.
//
// ISOLATION: every module that could touch the user's config, the accounts
// files, `~/.claude` credentials or the network is mocked BEFORE the plugin is
// imported, and `globalThis.fetch` is stubbed per request. `node:https` is
// replaced with a stub that fails loudly if anything tries to use it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("a"),
    close: vi.fn(),
  })),
}));

vi.mock("node:https", () => {
  const blocked = () => {
    throw new Error("node:https must not be used by the fast-mode tests");
  };
  return { default: { request: blocked, get: blocked }, request: blocked, get: blocked };
});

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
  acquireRefreshLock: vi.fn().mockResolvedValue({
    acquired: true,
    lockPath: "/tmp/opencode-fast-mode-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/cc-credentials.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    readCCCredentials: vi.fn(() => null),
    readCCCredentialsFromKeychain: vi.fn(() => null),
    readCCCredentialsFromFile: vi.fn(() => null),
  };
});

const testConfig = vi.hoisted(() => ({
  fastMode: false,
  fastModeLegacyModels: false,
}));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      enabled: true,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
    custom_betas: [],
    fast_mode: testConfig.fastMode,
    fast_mode_legacy_models: testConfig.fastModeLegacyModels,
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
    token_economy: { ...original.DEFAULT_CONFIG.token_economy, context_hint: false },
  });
  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const FAST_BETA = "fast-mode-2026-02-01";
const KILL_SWITCH = "OPENCODE_ANTHROPIC_DISABLE_FAST_MODE";

function makeClient() {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    session: { prompt: vi.fn().mockResolvedValue(undefined) },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeProvider() {
  const makeModel = (id) => ({
    id,
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200_000, output: 32_000 },
  });
  const ids = ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"];
  return { models: Object.fromEntries(ids.map((id) => [id, makeModel(id)])) };
}

function successResponse() {
  return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function fastPoolRateLimitResponse() {
  const error = { type: "rate_limit_error", message: "Number of request tokens has exceeded" };
  return new Response(JSON.stringify({ type: "error", error }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Drive one host request through the real interceptor. `responses` are consumed
 * in order, one per outgoing call; the outgoing calls are returned parsed.
 */
async function drive({ model, hostSpeed = true, hostBeta = true, responses = [successResponse] }) {
  const queue = [...responses];
  const mockFetch = vi.fn(() => {
    const next = queue.shift() ?? successResponse;
    return Promise.resolve(next());
  });
  vi.stubGlobal("fetch", mockFetch);

  const plugin = await AnthropicAuthPlugin({ client: makeClient() });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 3_600_000,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());

  const headers = { "content-type": "application/json" };
  if (hostBeta) headers["anthropic-beta"] = FAST_BETA;
  const body = {
    model,
    max_tokens: 8000,
    system: [{ type: "text", text: "You are a helpful assistant." }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...(hostSpeed ? { speed: "fast" } : {}),
  };

  const response = await fetchFn(MESSAGES_URL, { method: "POST", headers, body: JSON.stringify(body) });
  await response.text();

  return mockFetch.mock.calls
    .filter(([input]) => String(input).includes("/messages"))
    .map(([input, init]) => ({
      url: String(input),
      body: JSON.parse(init.body),
      beta: new Headers(init.headers).get("anthropic-beta") ?? "",
    }));
}

beforeEach(() => {
  testConfig.fastMode = false;
  testConfig.fastModeLegacyModels = false;
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
  vi.stubEnv("OPENCODE_ANTHROPIC_SIGNATURE_USER_ID", "test-signature-user");
  vi.stubEnv(KILL_SWITCH, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fast mode through the interceptor", () => {
  it("keeps a host-sent speed and its beta on a fast-capable model (control)", async () => {
    const [call] = await drive({ model: "claude-opus-4-8" });
    expect(call.body.speed).toBe("fast");
    expect(call.beta.split(",")).toContain(FAST_BETA);
  });

  it.each(["1", "true", "yes", " TRUE "])("kill switch %j removes host speed and beta", async (value) => {
    vi.stubEnv(KILL_SWITCH, value);
    const calls = await drive({ model: "claude-opus-4-8" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.speed).toBeUndefined();
    expect(calls[0].beta.split(",")).not.toContain(FAST_BETA);
  });

  it.each(["1", "true"])("kill switch %j also overrides config.fast_mode", async (value) => {
    vi.stubEnv(KILL_SWITCH, value);
    testConfig.fastMode = true;
    const [call] = await drive({ model: "claude-opus-4-8", hostSpeed: false, hostBeta: false });
    expect(call.body.speed).toBeUndefined();
    expect(call.beta.split(",")).not.toContain(FAST_BETA);
  });

  it.each(["0", "false", "no", ""])("a falsy value %j does not disable fast mode", async (value) => {
    vi.stubEnv(KILL_SWITCH, value);
    const [call] = await drive({ model: "claude-opus-4-8" });
    expect(call.body.speed).toBe("fast");
    expect(call.beta.split(",")).toContain(FAST_BETA);
  });

  it.each(["claude-sonnet-5", "claude-opus-4-7"])("drops host speed and beta on ineligible %s", async (model) => {
    const [call] = await drive({ model });
    expect(call.body.speed).toBeUndefined();
    expect(call.beta.split(",")).not.toContain(FAST_BETA);
  });

  it("does not rescue a host fast-mode beta when no speed is sent", async () => {
    const [call] = await drive({ model: "claude-opus-4-8", hostSpeed: false, hostBeta: true });
    expect(call.body.speed).toBeUndefined();
    expect(call.beta.split(",")).not.toContain(FAST_BETA);
  });

  it("keeps speed on Opus 4.7 only with fast_mode_legacy_models", async () => {
    testConfig.fastModeLegacyModels = true;
    const [call] = await drive({ model: "claude-opus-4-7" });
    expect(call.body.speed).toBe("fast");
    expect(call.beta.split(",")).toContain(FAST_BETA);
  });

  it("falls back to standard speed after a fast-pool 429, even when speed was host-sent", async () => {
    const calls = await drive({
      model: "claude-opus-4-8",
      responses: [fastPoolRateLimitResponse, successResponse],
    });
    expect(calls).toHaveLength(2);

    expect(calls[0].body.speed).toBe("fast");
    expect(calls[0].beta.split(",")).toContain(FAST_BETA);

    expect(calls[1].body.speed).toBeUndefined();
    expect(calls[1].beta.split(",")).not.toContain(FAST_BETA);
  });
});
