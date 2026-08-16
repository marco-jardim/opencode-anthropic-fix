// PHASE 2.2 — THE ADAPTER IS UNCONDITIONAL, AND THE LEGACY FORGE IS DEAD CODE
// FOR THE MESSAGES SURFACES.
//
// WHY THIS FILE EXISTS, next to shared-package-usage.test.mjs. That suite
// observes the POSITIVE side: `buildWireCompatibleRequest` ran and its bytes
// reached `fetch`. It cannot see the negative side, because a request that went
// through BOTH constructions would still satisfy every one of its assertions.
// This file watches the other seam — `buildRequestHeaders`, the legacy forge —
// and asserts it is NEVER invoked while signature emulation is on and the turn
// is a messages/count_tokens turn, across the shapes the plugin actually sends:
// streaming and non-streaming, count_tokens with and without `custom_betas`,
// both the `/v1/...` and the bare `/...` spellings of every route.
//
// The spy DELEGATES to the real implementation, so the discrimination is not
// bought by breaking the path it observes: the emulation-off and
// non-messages-endpoint cases below still go out for real and still assert the
// spy fired, which is what proves a green run means "not called" rather than
// "not callable".
//
// It also carries the two INTEGRATION smokes for the adapter path, which no
// unit-level suite covers: an account rotation driven by a real 429 response
// (the retry loop rebuilds the whole request per attempt — through the adapter
// — with a different account's token), and a recorded SSE stream travelling
// interceptor -> adapter -> response transform.

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
    lockPath: "/tmp/opencode-adapter-unconditional-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

const testPolicy = vi.hoisted(() => ({ signature: true, customBetas: [] }));

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
    custom_betas: [...testPolicy.customBetas],
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

// The observation seam for the LEGACY path. Delegates to the real forge.
const legacy = vi.hoisted(() => ({
  /** @type {((...args: unknown[]) => unknown) | null} */
  original: null,
  /** @type {import('vitest').Mock | null} */
  spy: null,
}));

vi.mock("../../lib/mimicry/headers.mjs", async (importOriginal) => {
  const original = await importOriginal();
  legacy.original = original.buildRequestHeaders;
  legacy.spy = vi.fn((...args) => legacy.original(...args));
  return { ...original, buildRequestHeaders: legacy.spy };
});

import { AnthropicAuthPlugin } from "../../index.mjs";
import { loadAccounts, saveAccounts } from "../../lib/storage.mjs";

const FOREGROUND_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

const COUNT_BODY = {
  model: "claude-sonnet-4-5",
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

/** Stored-account shape the AccountManager round-trips to disk. */
function makeStoredAccount(overrides = {}) {
  return {
    refreshToken: "refresh-1",
    addedAt: 1000,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    expires: Date.now() + 3_600_000,
    ...overrides,
  };
}

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

async function makeInterceptor(mockFetch) {
  vi.stubGlobal("fetch", mockFetch);
  const plugin = await AnthropicAuthPlugin({ client: makeClient() });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 3_600_000,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());
  return fetchFn;
}

async function driveRequest(url, init) {
  const mockFetch = vi.fn(() => Promise.resolve(makeSuccessResponse()));
  const fetchFn = await makeInterceptor(mockFetch);
  const response = await fetchFn(url, init);
  await response.text();
  return mockFetch;
}

/** @param {import('vitest').Mock} mockFetch @param {string} pathname */
function outgoingCallsFor(mockFetch, pathname) {
  // The interceptor forwards a `Request` when the host handed it one, and a URL
  // otherwise; `String(request)` is "[object Request]", hence the branch.
  return mockFetch.mock.calls.filter(
    ([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname === pathname,
  );
}

function stubRequestEnv() {
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "");
  vi.stubEnv("CLAUDE_CODE_ADDITIONAL_PROTECTION", "");
  vi.stubEnv("CLAUDE_CODE_BACKGROUND", "");
  vi.stubEnv("CLAUDE_CODE_CONTAINER_ID", "");
  vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "");
  vi.stubEnv("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE", "");
}

describe("the legacy forge is unreachable while signature emulation is on", () => {
  beforeEach(() => {
    testPolicy.signature = true;
    testPolicy.customBetas = [];
    legacy.spy.mockClear();
    stubRequestEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const ADAPTER_ROUTES = [
    { pathname: "/v1/messages", body: FOREGROUND_BODY, name: "canonical messages" },
    { pathname: "/messages", body: FOREGROUND_BODY, name: "bare messages" },
    { pathname: "/v1/messages/count_tokens", body: COUNT_BODY, name: "canonical count_tokens" },
    { pathname: "/messages/count_tokens", body: COUNT_BODY, name: "bare count_tokens" },
  ];

  for (const route of ADAPTER_ROUTES) {
    it(`never calls buildRequestHeaders for ${route.name}`, async () => {
      const mockFetch = await driveRequest(`https://api.anthropic.com${route.pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(route.body),
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(legacy.spy).not.toHaveBeenCalled();
    });
  }

  it("never calls buildRequestHeaders for a streaming turn", async () => {
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...FOREGROUND_BODY, stream: true }),
    });

    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages")[0];
    expect(JSON.parse(init.body).stream).toBe(true);
    expect(legacy.spy).not.toHaveBeenCalled();
  });

  it("never calls buildRequestHeaders for a non-streaming turn", async () => {
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });

    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages")[0];
    expect(JSON.parse(init.body).stream).toBeUndefined();
    expect(legacy.spy).not.toHaveBeenCalled();
  });

  it("never calls buildRequestHeaders for count_tokens with custom betas configured", async () => {
    testPolicy.customBetas = ["cache-diagnosis-2026-04-07"];
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(COUNT_BODY),
    });

    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages/count_tokens")[0];
    // The count surface composes its OWN beta list and drops user betas — the
    // property vector 05 of the migration harness pins. The key set is asserted
    // here too so a green "legacy never ran" cannot be bought by the count turn
    // silently becoming a main turn: the main surface emits `max_tokens`,
    // `system` and `metadata`, and this one emits none of them.
    expect(Object.keys(JSON.parse(init.body))).toEqual(["model", "messages", "tools"]);
    expect(new Headers(init.headers).get("anthropic-beta")).not.toContain("cache-diagnosis-2026-04-07");
    expect(legacy.spy).not.toHaveBeenCalled();
  });

  // A host may pass the body on a `Request` instead of in the init. Before the
  // adapter became unconditional that shape quietly bypassed every body-aware
  // stage in the plugin — no transform, no adapter, the raw host body on the
  // wire. The interceptor now lifts the body onto the init, so this shape gets
  // the same construction as every other turn.
  it("builds a Request-carried body through the adapter too", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(makeSuccessResponse()));
    const fetchFn = await makeInterceptor(mockFetch);
    const response = await fetchFn(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(FOREGROUND_BODY),
      }),
      {},
    );
    await response.text();

    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages")[0];
    expect(JSON.parse(init.body).metadata.user_id).toEqual(expect.any(String));
    expect(legacy.spy).not.toHaveBeenCalled();
  });

  // Emulation OFF does not reach the legacy forge either — it gets the
  // passthrough envelope, which composes no mimicry at all. Phase 2.2.2.
  it("does not call buildRequestHeaders when signature emulation is off", async () => {
    testPolicy.signature = false;
    const mockFetch = await driveRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });

    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages")[0];
    expect(new Headers(init.headers).get("user-agent")).toBeNull();
    expect(legacy.spy).not.toHaveBeenCalled();
  });

  // DISCRIMINATION. If the spy could never fire, every assertion above would be
  // vacuous. This makes it fire: the one caller of the legacy forge left is an
  // endpoint the package has no surface for, with emulation ON.
  it("still calls buildRequestHeaders for an endpoint the package has no surface for", async () => {
    await driveRequest("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: { "content-type": "application/json" },
    });

    expect(legacy.spy).toHaveBeenCalledTimes(1);
  });
});

// INTEGRATION SMOKES. Everything above observes ONE request in isolation; the
// two below drive the paths where the adapter interacts with the rest of the
// plugin — the retry/rotation loop, and the response transform.
describe("adapter path integration smokes", () => {
  beforeEach(() => {
    testPolicy.signature = true;
    testPolicy.customBetas = [];
    legacy.spy.mockClear();
    loadAccounts.mockReset();
    saveAccounts.mockResolvedValue(undefined);
    stubRequestEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rotates to the second account on 429 and rebuilds the retry through the adapter", async () => {
    loadAccounts.mockResolvedValue({
      version: 1,
      activeIndex: 0,
      accounts: [
        makeStoredAccount({ refreshToken: "refresh-1", access: "access-1", email: "a@test.com", addedAt: 1000 }),
        makeStoredAccount({ refreshToken: "refresh-2", access: "access-2", email: "b@test.com", addedAt: 2000 }),
      ],
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValue(makeSuccessResponse());

    const fetchFn = await makeInterceptor(mockFetch);
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FOREGROUND_BODY),
    });
    await response.text();

    const calls = outgoingCallsFor(mockFetch, "/v1/messages");
    expect(response.status).toBe(200);
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const first = new Headers(calls[0][1].headers);
    const retry = new Headers(calls[calls.length - 1][1].headers);

    // Rotation happened: the retry carries the OTHER account's bearer.
    expect(first.get("authorization")).toBe("Bearer access-1");
    expect(retry.get("authorization")).toBe("Bearer access-2");
    // And it was rebuilt through the adapter, not through the legacy forge:
    // the package's fingerprint headers and beta ordering are present on BOTH
    // attempts, and the legacy seam never fired.
    for (const headers of [first, retry]) {
      expect(headers.get("user-agent")).toMatch(/^claude-cli\//);
      expect(headers.get("x-stainless-lang")).toBe("js");
      expect(headers.get("x-app")).toBe("cli");
      expect(headers.get("anthropic-beta").split(",")[0]).toBe("claude-code-20250219");
    }
    expect(legacy.spy).not.toHaveBeenCalled();
  });

  it("carries a recorded SSE stream through the adapter and the response transform", async () => {
    loadAccounts.mockResolvedValue(null);

    // A recorded stream with an mcp_-prefixed tool name: the response transform
    // must map it back to the host-visible name, because the request transform
    // is what added the prefix on the way out.
    const recorded = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":11,"output_tokens":1,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp_read_file","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const mockFetch = vi.fn(
      () =>
        new Response(recorded, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const fetchFn = await makeInterceptor(mockFetch);
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...FOREGROUND_BODY,
        stream: true,
        tools: [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: {} } }],
      }),
    });
    const text = await response.text();

    // Request side: the adapter built it — the package's beta ordering and its
    // forged `metadata.user_id` are both present, and the legacy seam is cold.
    const [, init] = outgoingCallsFor(mockFetch, "/v1/messages")[0];
    expect(new Headers(init.headers).get("anthropic-beta").split(",")[0]).toBe("claude-code-20250219");
    expect(JSON.parse(init.body).metadata.user_id).toEqual(expect.any(String));
    expect(legacy.spy).not.toHaveBeenCalled();

    // Response side: the prefix is stripped back out, and nothing else in the
    // recorded stream is disturbed.
    expect(text).toContain('"name":"read_file"');
    expect(text).not.toContain("mcp_read_file");
    expect(text).toContain('"type":"message_stop"');

    // Usage survives the transform verbatim — the session accounting reads it
    // from this stream, so a transform that dropped or rewrote it would silently
    // break cost reporting.
    expect(text).toContain('"cache_read_input_tokens":7');
    expect(text).toContain('"output_tokens":9');

    // The plugin's own response headers are attached. They are computed when the
    // response is wrapped, BEFORE the body is consumed, so their values reflect
    // the session up to the request — only their presence is asserted here.
    expect(Number(response.headers.get("x-opencode-turns"))).toBeGreaterThanOrEqual(1);
    expect(response.headers.get("x-opencode-cache-read-total")).not.toBeNull();
  });
});
