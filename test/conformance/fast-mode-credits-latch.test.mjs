// FAST MODE — entitlement 429 ("Usage credits are required for fast mode") latch,
// driven through the REAL fetch interceptor with a stubbed `fetch`.
//
// What this pins:
//  - a 429 on a request that carried `speed: "fast"` whose error says usage
//    credits are required for fast mode is a missing ENTITLEMENT, not a rate
//    limit: the request is retried once on the same account WITHOUT `speed` and
//    WITHOUT the fast-mode beta, and fast mode stays off for that account for the
//    rest of the session, whatever the source of `speed` (host-sent, the
//    `fast_mode` setting, `fast_mode_auto`), without waiting for any cooldown;
//  - the toast fires once per account per session;
//  - neither the standard bucket nor the fast bucket is marked, and no account
//    rotates;
//  - a plain fast-pool 429 keeps its behaviour: fast-bucket cooldown only, fast
//    re-armed once it expires.
//
// ISOLATION: same hermetic setup as fast-mode-kill-switch.test.mjs. Every module
// that could touch the user's config, the accounts files, `~/.claude`
// credentials or the network is mocked BEFORE the plugin is imported, and
// `globalThis.fetch` is stubbed. `node:https` fails loudly if anything uses it.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HERMETIC PROFILE: see fast-mode-kill-switch.test.mjs. Previous values are
// restored in `afterAll`.
const savedProfileEnv = vi.hoisted(() => {
  const os = process.getBuiltinModule("node:os");
  const path = process.getBuiltinModule("node:path");
  const root = path.join(os.tmpdir(), `opencode-fast-credits-test-profile-${process.pid}`);
  const overrides = {
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(root, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_DATA_HOME: path.join(root, ".local", "share"),
    XDG_CACHE_HOME: path.join(root, ".cache"),
    XDG_STATE_HOME: path.join(root, ".local", "state"),
  };
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedProfileEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("a"),
    close: vi.fn(),
  })),
}));

vi.mock("node:https", () => {
  const blocked = () => {
    throw new Error("node:https must not be used by the fast-mode credits tests");
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
    lockPath: "/tmp/opencode-fast-credits-test.lock",
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
  fastModeAuto: false,
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
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    // Default-on HEAD probe at loader time; not part of what these tests pin.
    preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
    adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
    token_economy: {
      ...original.DEFAULT_CONFIG.token_economy,
      context_hint: false,
      fast_mode_auto: testConfig.fastModeAuto,
    },
  });
  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";
import { AccountManager, RATE_LIMIT_KEY_FAST } from "../../lib/accounts.mjs";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const FAST_BETA = "fast-mode-2026-02-01";
const CREDITS_TOAST = "⚡ Fast mode needs usage credits on this account, using standard speed";
const FAST_POOL_TOAST = "⚡ Fast pool limited — falling back to standard speed";
const FAR_FUTURE_MS = 365 * 24 * 3_600_000;
const PAST_ANY_FAST_COOLDOWN_MS = 10 * 60_000;

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
  return { models: { "claude-opus-4-8": makeModel("claude-opus-4-8") } };
}

function successResponse() {
  return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The canary response: HTTP 429 + x-should-retry: false, no retry-after. */
function creditsRequiredResponse() {
  const error = { type: "rate_limit_error", message: "Usage credits are required for fast mode." };
  return new Response(JSON.stringify({ type: "error", error, request_id: "req_test" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "x-should-retry": "false",
      "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
    },
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
 * One plugin session: the interceptor is built once, so account state (rate-limit
 * buckets, the entitlement latch) persists across `send` calls. Scripted
 * `responses` are consumed in order, only by /v1/messages calls, so the
 * runtime's own fire-and-forget fetches cannot swallow them.
 */
async function startSession({ responses = [] } = {}) {
  const queue = [...responses];
  const mockFetch = vi.fn((input) => {
    const isMessages = String(input).includes("/v1/messages");
    const next = (isMessages ? queue.shift() : undefined) ?? successResponse;
    return Promise.resolve(next());
  });
  vi.stubGlobal("fetch", mockFetch);

  const client = makeClient();
  const plugin = await AnthropicAuthPlugin({ client });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + FAR_FUTURE_MS,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());

  const messagesCalls = () =>
    mockFetch.mock.calls
      .filter(([input]) => String(input).includes("/v1/messages"))
      .map(([, init]) => {
        const headers = new Headers(init.headers);
        return {
          body: JSON.parse(init.body),
          beta: headers.get("anthropic-beta") ?? "",
          authorization: headers.get("authorization") ?? "",
        };
      });

  /**
   * Send one host request and return the calls it caused on the wire, the final
   * status and the response body.
   */
  async function send({ hostSpeed = true, hostBeta = true, messages } = {}) {
    const before = messagesCalls().length;
    const headers = { "content-type": "application/json" };
    if (hostBeta) headers["anthropic-beta"] = FAST_BETA;
    const body = {
      model: "claude-opus-4-8",
      max_tokens: 8000,
      system: [{ type: "text", text: "You are a helpful assistant." }],
      messages: messages ?? [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      ...(hostSpeed ? { speed: "fast" } : {}),
    };
    const response = await fetchFn(MESSAGES_URL, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    return { calls: messagesCalls().slice(before), status: response.status, text };
  }

  const toastMessages = () => client.tui.showToast.mock.calls.map(([arg]) => arg.body.message);

  return { send, toastMessages, remainingScripted: () => queue.length };
}

const hasFastBeta = (call) => call.beta.split(",").includes(FAST_BETA);

beforeEach(() => {
  testConfig.fastMode = false;
  testConfig.fastModeAuto = false;
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
  vi.stubEnv("OPENCODE_ANTHROPIC_SIGNATURE_USER_ID", "test-signature-user");
  vi.stubEnv("OPENCODE_ANTHROPIC_DISABLE_FAST_MODE", "");
  // Only `Date` is faked, so the interceptor's real timers and promises are
  // untouched; `vi.setSystemTime` is what moves the cooldown clock.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fast mode entitlement 429 (usage credits required)", () => {
  it("retries once at standard speed without the beta, latches fast off for the session and toasts once", async () => {
    const markRateLimited = vi.spyOn(AccountManager.prototype, "markRateLimited");
    const session = await startSession({ responses: [creditsRequiredResponse, successResponse] });

    const first = await session.send();
    expect(first.status).toBe(200);
    expect(first.calls).toHaveLength(2);
    expect(first.calls[0].body.speed).toBe("fast");
    expect(hasFastBeta(first.calls[0])).toBe(true);
    expect(first.calls[1].body.speed).toBeUndefined();
    expect(hasFastBeta(first.calls[1])).toBe(false);
    // Same account: the retry reuses the credential and consumed no other slot.
    expect(first.calls[1].authorization).toBe(first.calls[0].authorization);

    // Past any fast cooldown, with the host asking for fast again: still off.
    vi.setSystemTime(Date.now() + PAST_ANY_FAST_COOLDOWN_MS);
    const later = await session.send();
    expect(later.status).toBe(200);
    expect(later.calls).toHaveLength(1);
    expect(later.calls[0].body.speed).toBeUndefined();
    expect(hasFastBeta(later.calls[0])).toBe(false);

    const withoutHostBeta = await session.send({ hostBeta: false });
    expect(withoutHostBeta.calls).toHaveLength(1);
    expect(withoutHostBeta.calls[0].body.speed).toBeUndefined();
    expect(hasFastBeta(withoutHostBeta.calls[0])).toBe(false);

    // One toast for the whole session, and no rotation toast.
    expect(session.toastMessages().filter((m) => m === CREDITS_TOAST)).toHaveLength(1);
    expect(session.toastMessages()).not.toContain(FAST_POOL_TOAST);
    expect(session.toastMessages().some((m) => /switching account/i.test(m))).toBe(false);

    // The entitlement miss is not a rate limit: no bucket (standard or fast) was marked.
    expect(markRateLimited).not.toHaveBeenCalled();
  });

  it("keeps fast off when speed comes from the fast_mode setting", async () => {
    testConfig.fastMode = true;
    const session = await startSession({ responses: [creditsRequiredResponse, successResponse] });

    const first = await session.send({ hostSpeed: false, hostBeta: false });
    expect(first.calls).toHaveLength(2);
    expect(first.calls[0].body.speed).toBe("fast");
    expect(hasFastBeta(first.calls[0])).toBe(true);
    expect(first.calls[1].body.speed).toBeUndefined();
    expect(hasFastBeta(first.calls[1])).toBe(false);

    vi.setSystemTime(Date.now() + PAST_ANY_FAST_COOLDOWN_MS);
    const later = await session.send({ hostSpeed: false, hostBeta: false });
    expect(later.calls).toHaveLength(1);
    expect(later.calls[0].body.speed).toBeUndefined();
    expect(hasFastBeta(later.calls[0])).toBe(false);
    expect(session.toastMessages().filter((m) => m === CREDITS_TOAST)).toHaveLength(1);
  });

  it("keeps fast off when speed comes from fast_mode_auto", async () => {
    testConfig.fastModeAuto = true;
    const followUp = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
    const session = await startSession({ responses: [creditsRequiredResponse, successResponse] });

    const first = await session.send({ hostSpeed: false, hostBeta: false, messages: followUp });
    // Guard the premise: auto mode really injected speed on the first attempt.
    expect(first.calls[0].body.speed).toBe("fast");
    expect(first.calls).toHaveLength(2);
    expect(first.calls[1].body.speed).toBeUndefined();
    expect(hasFastBeta(first.calls[1])).toBe(false);

    vi.setSystemTime(Date.now() + PAST_ANY_FAST_COOLDOWN_MS);
    const later = await session.send({ hostSpeed: false, hostBeta: false, messages: followUp });
    expect(later.calls).toHaveLength(1);
    expect(later.calls[0].body.speed).toBeUndefined();
    expect(hasFastBeta(later.calls[0])).toBe(false);
  });

  it("does not mark the standard quota rate-limited: the same account serves the next request", async () => {
    const markRateLimited = vi.spyOn(AccountManager.prototype, "markRateLimited");
    const session = await startSession({ responses: [creditsRequiredResponse, successResponse, successResponse] });

    const first = await session.send();
    expect(first.status).toBe(200);
    // With a single account, a standard-bucket mark would leave nothing to serve
    // the next request from. It is served at once, on the same credential.
    const second = await session.send();
    expect(second.status).toBe(200);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].authorization).toBe(first.calls[0].authorization);
    expect(session.remainingScripted()).toBe(0);
    expect(markRateLimited).not.toHaveBeenCalled();
  });
});

describe("plain fast-pool 429 (unchanged behaviour)", () => {
  it("cools the fast bucket only, falls back once, and re-arms fast after the cooldown", async () => {
    const markRateLimited = vi.spyOn(AccountManager.prototype, "markRateLimited");
    const session = await startSession({ responses: [fastPoolRateLimitResponse, successResponse] });

    const first = await session.send();
    expect(first.status).toBe(200);
    expect(first.calls).toHaveLength(2);
    expect(first.calls[0].body.speed).toBe("fast");
    expect(first.calls[1].body.speed).toBeUndefined();
    expect(hasFastBeta(first.calls[1])).toBe(false);

    // Fast bucket only, exactly once.
    expect(markRateLimited).toHaveBeenCalledTimes(1);
    expect(markRateLimited.mock.calls[0][1]).toBe("RATE_LIMIT_EXCEEDED");
    expect(markRateLimited.mock.calls[0][3]).toBe(RATE_LIMIT_KEY_FAST);
    expect(session.toastMessages()).toContain(FAST_POOL_TOAST);
    expect(session.toastMessages()).not.toContain(CREDITS_TOAST);

    // Inside the cooldown fast stays off...
    const during = await session.send();
    expect(during.calls).toHaveLength(1);
    expect(during.calls[0].body.speed).toBeUndefined();

    // ...and after it expires fast is armed again.
    vi.setSystemTime(Date.now() + PAST_ANY_FAST_COOLDOWN_MS);
    const after = await session.send();
    expect(after.calls).toHaveLength(1);
    expect(after.calls[0].body.speed).toBe("fast");
    expect(hasFastBeta(after.calls[0])).toBe(true);
  });
});
