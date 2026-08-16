/**
 * COM-466 — the shared package is on the HOT PATH, not merely parity-tested.
 *
 * WHY THIS FILE EXISTS. `lib/mimicry/adapter-bifurcation.test.mjs` exercises
 * both sides of the bifurcation in isolation, and
 * `test/conformance/shared-package-parity.test.mjs` proves the two sides agree
 * byte-for-byte. Neither one pins WHICH side production actually takes. If
 * `_useAdapter` (index.mjs) or `_adapterResult.applicable`
 * (lib/mimicry/adapter-input.mjs) ever evaluated `false` permanently, every
 * one of those tests would stay green while the live request path silently
 * fell back to the legacy `buildRequestHeaders` construction — the exact
 * regression a parity suite cannot see, because parity is what makes the
 * fallback invisible.
 *
 * So this file observes the ADAPTER BOUNDARY during a real request driven
 * through `AnthropicAuthPlugin`'s fetch interceptor, and asserts three
 * independent things:
 *
 *   1. `buildWireCompatibleRequest` was invoked (module spy);
 *   2. the bytes that reached `fetch` are the ones it returned (body identity
 *      + header-set equality) — invocation alone would not prove the result
 *      was used;
 *   3. the `anthropic-beta` value on the wire carries the PACKAGE's beta
 *      order, which the legacy path does not produce. This one is deliberately
 *      redundant with the spy: it keeps discriminating even if a future
 *      refactor removes the seam the spy hooks.
 *
 * And the converse, so the test discriminates in both directions rather than
 * just asserting "adapter always": the two documented decline conditions
 * (a non-/v1/messages endpoint, a bodiless request) must still go legacy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  acquireRefreshLock: vi.fn().mockResolvedValue({
    acquired: true,
    lockPath: "/tmp/opencode-shared-package-usage-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

// Same harness configuration as the golden-outgoing conformance test: startup
// version fetch and idle refresh off so the only network call in the run is the
// request under observation.
// `signature` is the `_useAdapter` switch in index.mjs. Every test in this file
// runs with it ON except the emulation-off count_tokens case, which is the only
// route left where the legacy forge still owns the request.
const testPolicy = vi.hoisted(() => ({ signature: true }));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      enabled: testPolicy.signature,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
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

// The observation seam. The spy DELEGATES to the real implementation, so the
// request under test is the genuine production request, not a stub: this test
// must not be able to pass by replacing the thing it is meant to observe.
const wireCompat = vi.hoisted(() => ({
  /** @type {((body: string | undefined, transport: unknown) => Promise<unknown>) | null} */
  original: null,
  /** @type {import('vitest').Mock | null} */
  spy: null,
  /** @type {((body: string | undefined, transport: unknown) => Promise<unknown>) | null} */
  countOriginal: null,
  /** Second seam, for the package's count-tokens surface. @type {import('vitest').Mock | null} */
  countSpy: null,
}));

vi.mock("../../lib/mimicry/wire-compat.mjs", async (importOriginal) => {
  const original = await importOriginal();
  wireCompat.original = original.buildWireCompatibleRequest;
  wireCompat.spy = vi.fn((...args) => wireCompat.original(...args));
  wireCompat.countOriginal = original.buildWireCompatibleCountTokensRequest;
  wireCompat.countSpy = vi.fn((...args) => wireCompat.countOriginal(...args));
  return {
    ...original,
    buildWireCompatibleRequest: wireCompat.spy,
    buildWireCompatibleCountTokensRequest: wireCompat.countSpy,
  };
});

import { buildClaudeCodeRequest } from "@tormentalabs/claude-code-wire-compat";
import { toClaudeCodeRequestInput } from "../../lib/mimicry/wire-compat.mjs";
import { AnthropicAuthPlugin } from "../../index.mjs";

const FOREGROUND_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

function makeClient() {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    session: { prompt: vi.fn().mockResolvedValue(undefined) },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeProvider() {
  const makeModel = (id, input, output, cacheRead, cacheWrite) => ({
    id,
    cost: { input, output, cache: { read: cacheRead, write: cacheWrite } },
    limit: { context: 200_000, output: 32_000 },
  });

  return {
    models: {
      "claude-sonnet-4-5": makeModel("claude-sonnet-4-5", 3, 15, 0.3, 3.75),
      "claude-haiku-4-5": makeModel("claude-haiku-4-5", 1, 5, 0.1, 1.25),
    },
  };
}

function makeSuccessResponse() {
  return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Drive one request through the plugin's real fetch interceptor.
 *
 * @param {string} url
 * @param {RequestInit} init
 */
async function driveRequest(url, init) {
  const { fetchFn, mockFetch } = await makeInterceptor();
  const response = await fetchFn(url, init);
  await response.text();
  return mockFetch;
}

/**
 * Same interceptor, handed back UNCALLED, for the cases where driving the
 * request is expected to reject rather than return a response.
 */
async function makeInterceptor() {
  const mockFetch = vi.fn(() => Promise.resolve(makeSuccessResponse()));
  vi.stubGlobal("fetch", mockFetch);
  const plugin = await AnthropicAuthPlugin({ client: makeClient() });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 3_600_000,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());
  return { fetchFn, mockFetch };
}

/** @param {import('vitest').Mock} mockFetch @param {string} pathname */
function outgoingCallsFor(mockFetch, pathname) {
  return mockFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === pathname);
}

/** @param {HeadersInit | undefined} headers */
function headerSet(headers) {
  return Object.fromEntries(new Headers(headers).entries());
}

describe("the live request path goes through the shared wire package", () => {
  beforeEach(() => {
    testPolicy.signature = true;
    wireCompat.spy.mockClear();
    wireCompat.countSpy.mockClear();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
    vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "");
    vi.stubEnv("CLAUDE_CODE_ADDITIONAL_PROTECTION", "");
    vi.stubEnv("CLAUDE_CODE_BACKGROUND", "");
    vi.stubEnv("CLAUDE_CODE_CONTAINER_ID", "");
    vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "");
    vi.stubEnv("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("invokes buildWireCompatibleRequest for a first-party /v1/messages turn", async () => {
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });

    expect(outgoingCallsFor(mockFetch, "/v1/messages")).toHaveLength(1);
    // The whole point of the file. A `0` here means production silently
    // reverted to the legacy `buildRequestHeaders` path.
    expect(wireCompat.spy).toHaveBeenCalledTimes(1);
  });

  it("sends the exact body and headers the package produced", async () => {
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });

    expect(wireCompat.spy).toHaveBeenCalledTimes(1);
    const built = await wireCompat.spy.mock.results[0].value;
    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages")[0];

    // Invocation alone would not prove anything: the result has to be what
    // actually left the process. `index.mjs` assigns `built.body` to
    // `adapterBody` and `built.headers` to `requestHeaders`, and both flow
    // straight into `fetch`.
    expect(typeof built.body).toBe("string");
    expect(init.body).toBe(built.body);
    expect(headerSet(init.headers)).toEqual(headerSet(built.headers));

    // Sanity: the package rebuilt the body rather than forwarding the host's.
    expect(init.body).not.toBe(JSON.stringify(FOREGROUND_BODY));
  });

  it("puts the package's own beta ordering on the wire", async () => {
    // Independent of the spy on purpose. The legacy path hand-rolls the
    // anthropic-beta list in a different order (see the calibration note in
    // test/conformance/golden-outgoing.test.mjs), so the header VALUE — not
    // just its set of members — identifies which constructor ran.
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });

    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages")[0];
    const wireBeta = new Headers(init.headers).get("anthropic-beta");

    // Derived from the package directly, with a throwaway transport: the beta
    // list does not depend on session/device identity, so this is the package's
    // canonical ordering with nothing borrowed from the run under test.
    const bare = await buildClaudeCodeRequest(
      toClaudeCodeRequestInput(FOREGROUND_BODY, {
        accessToken: "test-access",
        clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        runtime: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          deviceId: "2".repeat(64),
          accountUuid: "33333333-3333-4333-8333-333333333333",
          runtime: "node",
          runtimeVersion: process.version,
          os: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
          arch: process.arch,
        },
      }),
    );
    const packageBeta = new Headers(bare.headers).get("anthropic-beta");

    expect(packageBeta).toBeTruthy();
    // A PREFIX, not equality: the plugin legitimately appends `config.custom_betas`
    // through `additionalBetas`, so the wire value is the package's canonical list
    // followed by the configured extras. The legacy constructor produces neither
    // that prefix nor that layout — it opens with `oauth-2025-04-20` and INTERLEAVES
    // the custom betas among the canonical ones — so the prefix is what identifies
    // the constructor.
    expect(wireBeta.split(",").slice(0, packageBeta.split(",").length)).toEqual(packageBeta.split(","));
    // Pinned separately because it is the cheapest single discriminator: the two
    // constructors disagree on the very first beta.
    expect(wireBeta.split(",")[0]).toBe("claude-code-20250219");
  });
});

describe("the legacy path still owns the requests the package declines", () => {
  beforeEach(() => {
    testPolicy.signature = true;
    wireCompat.spy.mockClear();
    wireCompat.countSpy.mockClear();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
    vi.stubEnv("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // INVERTED by the count-tokens migration. This used to assert that
  // count_tokens never reached the package, on the premise that the package
  // pinned the /v1/messages endpoint and would rewrite the turn to the wrong
  // one. The package now has a count surface with its own pinned endpoint, and
  // index.mjs discards `built.url` on both surfaces anyway, so the premise is
  // gone and the assertion is the other way round.
  it("uses the package's count surface for /v1/messages/count_tokens", async () => {
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });

    const calls = outgoingCallsFor(mockFetch, "/v1/messages/count_tokens");
    expect(calls).toHaveLength(1);
    expect(wireCompat.countSpy).toHaveBeenCalledTimes(1);
    // The count surface, and ONLY the count surface: routing a count turn
    // through the main builder would forge a system prompt and a max_tokens
    // upstream never sends on this endpoint.
    expect(wireCompat.spy).not.toHaveBeenCalled();
    // Independent of the spy, so this keeps discriminating even if a refactor
    // removes the seam: the package's count body carries exactly these keys.
    expect(Object.keys(JSON.parse(calls[0][1].body))).toEqual(["model", "messages", "tools"]);
    expect(new Headers(calls[0][1].headers).get("authorization")).toBeTruthy();
  });

  it("does not use the package for count_tokens when signature emulation is off", async () => {
    testPolicy.signature = false;
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });

    const calls = outgoingCallsFor(mockFetch, "/v1/messages/count_tokens");
    expect(calls).toHaveLength(1);
    expect(wireCompat.countSpy).not.toHaveBeenCalled();
    expect(wireCompat.spy).not.toHaveBeenCalled();
    // The legacy forge leaves the host body alone with emulation off.
    expect(JSON.parse(calls[0][1].body).max_tokens).toBe(FOREGROUND_BODY.max_tokens);
    expect(new Headers(calls[0][1].headers).get("authorization")).toBeTruthy();
  });

  // PHASE 2.2 — an endpoint the package has NO surface for is the only thing
  // left that the adapter declines. It is not a fallback: nothing about the
  // request is forged into a Claude Code shape, the interceptor just adds auth
  // and forwards.
  it("leaves an endpoint outside the package's surfaces on the passthrough path", async () => {
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: { "content-type": "application/json" },
    });

    expect(outgoingCallsFor(mockFetch, "/v1/models")).toHaveLength(1);
    expect(wireCompat.spy).not.toHaveBeenCalled();
    expect(wireCompat.countSpy).not.toHaveBeenCalled();
    expect(new Headers(outgoingCallsFor(mockFetch, "/v1/models")[0][1].headers).get("authorization")).toBeTruthy();
  });
});

// PHASE 2.2 — THE FALLBACK IS GONE, AND THIS IS WHAT PROVES IT.
//
// Before this phase a body the package could not consume (absent, unparsable,
// not an object) silently routed to the legacy `buildRequestHeaders` forge. The
// request still went out, with a DIFFERENT fingerprint from every other turn in
// the same session — the dual-path failure the migration exists to remove. It
// now raises, and the assertions below pin BOTH halves: the raise, and the fact
// that nothing reached the wire behind it.
describe("an unusable body on an adapter endpoint is an error, never a legacy fallback", () => {
  beforeEach(() => {
    testPolicy.signature = true;
    wireCompat.spy.mockClear();
    wireCompat.countSpy.mockClear();
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
    vi.stubEnv("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const UNUSABLE_BODIES = [
    { name: "absent", init: {}, message: /no usable body \(undefined\)/ },
    { name: "empty string", init: { body: "" }, message: /an empty string/ },
    { name: "unparsable JSON", init: { body: "{not json" }, message: /could not be parsed as JSON/ },
    { name: "a JSON array", init: { body: "[1,2,3]" }, message: /parsed as an array/ },
    { name: "JSON null", init: { body: "null" }, message: /parsed as null/ },
  ];

  for (const endpoint of ["/v1/messages", "/v1/messages/count_tokens"]) {
    for (const { name, init, message } of UNUSABLE_BODIES) {
      it(`rejects ${name} on ${endpoint}`, async () => {
        const { fetchFn, mockFetch } = await makeInterceptor();

        await expect(
          fetchFn(`https://api.anthropic.com${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...init,
          }),
        ).rejects.toThrow(message);

        // The error names the endpoint, so a user report is self-locating.
        await expect(
          fetchFn(`https://api.anthropic.com${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...init,
          }),
        ).rejects.toThrow(endpoint);

        // Nothing went out behind the raise, and the legacy forge did not run.
        expect(outgoingCallsFor(mockFetch, endpoint)).toHaveLength(0);
        expect(wireCompat.spy).not.toHaveBeenCalled();
        expect(wireCompat.countSpy).not.toHaveBeenCalled();
      });
    }
  }

  // The converse, so the rejection is scoped rather than global: with emulation
  // OFF the same unusable body is not the adapter's problem, and the request
  // keeps going out on the passthrough path exactly as before.
  it("does not reject an unparsable body when signature emulation is off", async () => {
    testPolicy.signature = false;
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(outgoingCallsFor(mockFetch, "/v1/messages")).toHaveLength(1);
    expect(wireCompat.spy).not.toHaveBeenCalled();
  });
});
