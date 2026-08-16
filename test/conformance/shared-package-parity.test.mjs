// WHAT THIS SUITE GUARANTEES (the file name is a historical artifact — this is
// no longer a parity suite).
//
// It was written as a DIFFERENTIAL suite: it captured the request the plugin's
// own legacy forge produced and compared it byte for byte against the shared
// package (`@tormentalabs/claude-code-wire-compat`), to prove the migration
// would not move the wire. That framing is SPENT for the first-party
// `/v1/messages` turn. `index.mjs` now routes that turn THROUGH the package
// (`_useAdapter` in index.mjs), so the "existing" side stopped being an
// independent implementation — it is the package plus a thin layer of
// plugin-owned policy. A byte-for-byte comparison of the two was therefore
// asserting that the package equals itself, and it was RETIRED (Phase 4.1): the
// `shared package foreground parity` describe, its `DIFFERENTIAL_VECTORS` table
// and its normalization helpers are gone. Nothing in this file compares the two
// paths for SAMENESS any more.
//
// What the suite guarantees now, in four parts:
//
//  1. GOLDEN PINNING of the package output. `adapter golden wire` pins the
//     literal URL, header list and body the package emits for the reference
//     foreground request, key order included. Every value here was CAPTURED
//     from a run of the real code, never hand-written. Its job is to make an
//     unintended wire change in a future package bump fail loudly. The three
//     machine-dependent stainless headers are held out of the list golden and
//     asserted separately against the runtime facts the transport was handed.
//
//  2. THE EMULATION-OFF ENVELOPE. `emulation-off passthrough envelope` is the
//     one place `_useAdapter` is false, and so the only genuinely independent
//     construction left in the file. It pins that with signature emulation off
//     the outgoing request is the host's request plus the AUTH ENVELOPE
//     (`authorization`, an ADDITIVE `oauth-2025-04-20`, and the removal of
//     `x-api-key`/`x-session-affinity`) and nothing else — including a named
//     negative list of headers that must NOT appear. It also pins that
//     `/v1/messages/count_tokens` routes through the package's own count
//     surface with emulation ON, which is what proves the routing guard in
//     index.mjs has not quietly collapsed into the adapter path.
//
//  3. ADAPTER INPUT NORMALIZATION. `shared package adapter input normalization`
//     exercises the seam in `lib/mimicry/wire-compat.mjs` directly: what it
//     accepts (string and array system prompts, `thinking.display`, a
//     `cacheControl` decision, a profile override from config or env) and what
//     it rejects loudly (a non-string/array system prompt, a non-array `tools`,
//     a missing body, malformed override JSON). This is contract coverage of
//     our own wrapper, not of the package.
//
//  4. THE BOUNDARY. `shared package boundary - deferred plugin policy` pins the
//     exact places the two paths still DISAGREE — plugin-retained policy the
//     package has no surface for (anti-verbosity injection, adaptive-thinking
//     derivation, default effort) and plugin-retained configuration layered on
//     top (the `custom_betas` merge). These are the file's remaining
//     differential assertions, and unlike the retired block they assert
//     difference, not sameness, so none of them can go tautological.
//
// APPROVED wire changes that this suite records as golden rather than as bugs:
// the package's `anthropic-beta` ORDER wins (it was derived from the genuine
// Claude Code 2.1.195 binary), `thinking` is re-ordered and clamped, and
// `max_tokens` is clamped to the model's real output ceiling.
//
// WHERE THE RETIRED BLOCK'S NON-TAUTOLOGICAL PINS LIVE NOW: per-model
// `anthropic-beta` composition is covered by
// test/conformance/adapter-beta-composition.test.mjs and the
// test/fixtures/wire-baseline/ corpus; the `context_hint` omission by
// test/conformance/context-hint-gating.test.mjs; the thinking-budget clamp by
// the adapter-side assertion in part 3 below.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWireCompatibleRequest } from "../../lib/mimicry/wire-compat.mjs";

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
    lockPath: "/tmp/opencode-shared-package-parity-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

// Anti-verbosity injection is plugin-retained POLICY. The shared package has no
// `systemPromptFeatures` surface as of rc.10, so it never emits the
// `# Text output (does not apply to tool calls)` block. The retired parity
// vectors used to switch `antiVerbosity` off on Opus 4.6/4.7 so a byte-for-byte
// comparison could survive that divergence; with the comparison gone the knob
// is left at its default in every test here, and the boundary suite at the foot
// of the file asserts the divergence explicitly instead.
// `signature` is the `_useAdapter` switch in index.mjs: with emulation off the
// plugin runs no forge at all. The `emulation-off passthrough envelope`
// describe below is the only place that turns it off.
const testPolicy = vi.hoisted(() => ({ antiVerbosity: true, signature: true }));

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
    anti_verbosity: { ...original.DEFAULT_CONFIG.anti_verbosity, enabled: testPolicy.antiVerbosity },
  });

  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";

const goldenPath = fileURLToPath(new URL("../fixtures/golden/outgoing-foreground.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
const HOST_BODY = {
  model: golden.body.model,
  max_tokens: golden.body.max_tokens,
  // opencode always emits `system` as an array of text blocks, never a bare
  // string: packages/llm/src/protocols/anthropic-messages.ts maps it through
  // `request.system.map(...)` against a schema of `optionalArray(TextBlock)`.
  // The parity vector must match what the host actually sends.
  system: [{ type: "text", text: "You are a helpful assistant." }],
  messages: golden.body.messages,
};

beforeEach(() => {
  testPolicy.antiVerbosity = true;
  testPolicy.signature = true;
});

// The literal wire the package emits for the reference foreground request.
// Captured, not composed. `x-stainless-os`, `x-stainless-arch` and
// `x-stainless-runtime-version` are machine-dependent and are asserted
// separately from this list.
const GOLDEN_ADAPTER_URL = "https://api.anthropic.com/v1/messages?beta=true";

const GOLDEN_ADAPTER_HEADERS = [
  [
    "anthropic-beta",
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11",
  ],
  ["anthropic-dangerous-direct-browser-access", "true"],
  ["anthropic-version", "2023-06-01"],
  ["authorization", "Bearer test-access"],
  ["content-type", "application/json"],
  ["user-agent", "claude-cli/2.1.233 (external, cli)"],
  ["x-app", "cli"],
  ["x-claude-code-session-id", "11111111-1111-4111-8111-111111111111"],
  ["x-client-request-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  ["x-stainless-arch", "<machine>"],
  ["x-stainless-lang", "js"],
  ["x-stainless-os", "<machine>"],
  // 2.1.233 bundles @anthropic-ai/sdk 0.112.1 (was 0.94.0 through 2.1.222).
  ["x-stainless-package-version", "0.112.1"],
  ["x-stainless-retry-count", "0"],
  ["x-stainless-runtime", "node"],
  ["x-stainless-runtime-version", "<machine>"],
  ["x-stainless-timeout", "600"],
];

const MACHINE_DEPENDENT_HEADERS = new Set(["x-stainless-arch", "x-stainless-os", "x-stainless-runtime-version"]);

const GOLDEN_ADAPTER_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system: [
    // The `.768` suffix is the fingerprint: unchanged algorithm (salt
    // `59cf53e54c78` + chars 4/7/20 of the first user message + VERSION,
    // SHA-256, first three hex chars), different output only because VERSION is
    // an input and VERSION moved 2.1.195 -> 2.1.233.
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.233.768; cc_entrypoint=cli; cch=00000;" },
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  messages: [{ role: "user", content: "Hello" }],
  temperature: 1,
  metadata: {
    user_id: JSON.stringify({
      device_id: "2".repeat(64),
      account_uuid: "33333333-3333-4333-8333-333333333333",
      session_id: "11111111-1111-4111-8111-111111111111",
    }),
  },
};

// Key ORDER in the emitted body is load-bearing — the package reproduces
// upstream's insertion order and these bodies go on the wire as bytes — so the
// golden above is also pinned as a serialised string, not only with `toEqual`.
const GOLDEN_ADAPTER_BODY_KEYS = ["model", "max_tokens", "system", "messages", "temperature", "metadata"];

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
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-opus-4-7": {
        id: "claude-opus-4-7",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-fable-5": {
        id: "claude-fable-5",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-mythos-5": {
        id: "claude-mythos-5",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-3-5-haiku-latest": {
        id: "claude-3-5-haiku-latest",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-3-5-haiku": {
        id: "claude-3-5-haiku",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
    },
  };
}

function makeSuccessResponse() {
  return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function captureExistingRequest(mockFetch, hostBody, pathname = "/v1/messages", hostHeaders = {}) {
  vi.stubGlobal("fetch", mockFetch);
  const plugin = await AnthropicAuthPlugin({ client: makeClient() });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 3_600_000,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());
  const response = await fetchFn(`https://api.anthropic.com${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...hostHeaders },
    body: JSON.stringify(hostBody),
  });
  await response.text();

  const [url, init] = mockFetch.mock.calls.find(([input]) => String(input).includes(pathname));
  return { url, method: init.method, headers: init.headers, body: init.body };
}

function buildAdapterRequest(hostBody, cacheControl = { enabled: true, ttl: "1h", systemBreakpoint: true }) {
  return buildWireCompatibleRequest(JSON.stringify(hostBody), {
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
    cacheControl,
  });
}

function stubCleanEnvironment() {
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "");
  vi.stubEnv("CLAUDE_CODE_ADDITIONAL_PROTECTION", "");
  vi.stubEnv("CLAUDE_CODE_BACKGROUND", "");
  vi.stubEnv("CLAUDE_CODE_CONTAINER_ID", "");
  vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "");
  vi.stubEnv("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE", "");
}

// GOLDEN PINNING. Nothing differential here: these assertions exist purely so
// that an unintended wire change in a future release of
// `@tormentalabs/claude-code-wire-compat` fails loudly instead of shipping. Every
// expected value was captured from a run of the real code.
describe("adapter golden wire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubCleanEnvironment();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("pins the golden foreground URL and header list emitted by the package", async () => {
    const adapter = await buildAdapterRequest(HOST_BODY);
    const observed = [...adapter.headers.entries()].map(([name, value]) => [
      name,
      MACHINE_DEPENDENT_HEADERS.has(name) ? "<machine>" : value,
    ]);

    expect(adapter.url).toBe(GOLDEN_ADAPTER_URL);
    expect(adapter.method).toBe("POST");
    expect(observed).toEqual(GOLDEN_ADAPTER_HEADERS);
  });

  // The three headers held out of the list golden above. They are machine
  // dependent, not free: each must equal the value the transport was handed.
  it("pins the machine-dependent stainless headers to the transport runtime facts", async () => {
    const adapter = await buildAdapterRequest(HOST_BODY);
    const expectedOs = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

    expect(adapter.headers.get("x-stainless-arch")).toBe(process.arch);
    expect(adapter.headers.get("x-stainless-os")).toBe(expectedOs);
    expect(adapter.headers.get("x-stainless-runtime-version")).toBe(process.version);
  });

  it("pins the golden foreground body emitted by the package, key order included", async () => {
    const adapter = await buildAdapterRequest(HOST_BODY);
    const parsed = JSON.parse(adapter.body);

    expect(parsed).toEqual(GOLDEN_ADAPTER_BODY);
    expect(Object.keys(parsed)).toEqual(GOLDEN_ADAPTER_BODY_KEYS);
    expect(adapter.body).toBe(JSON.stringify(GOLDEN_ADAPTER_BODY));
  });
});

// TRUE DIFFERENTIAL — and, since Phase 2.2, a different differential than it
// used to be.
//
// WHAT CHANGED. `_useAdapter` is false on exactly one condition now: signature
// emulation off. And with it off the plugin no longer runs a REDUCED forge — it
// runs NO forge. The old assertions in this block pinned the half-mimicry that
// survived: a forged `claude-cli/2.1.233` user-agent emitted outside the
// signature gate, and a minimal `anthropic-beta` that REPLACED whatever the host
// sent. Both were mimicry with the mimicry switch off, and both are gone.
//
// WHAT IS PINNED NOW is the boundary itself, which is the property most likely
// to erode: with emulation off the outgoing request is the host's request plus
// the AUTH ENVELOPE (`authorization`, an ADDITIVE `oauth-2025-04-20`, and the
// removal of `x-api-key`/`x-session-affinity`) and nothing else. The negative
// assertion below — a named list of headers that must NOT appear — is the part
// that catches a future "just one more header" regression, because a positive
// header-set equality can always be satisfied by loosening the expectation.
//
// This is still the only genuinely independent construction left in the file,
// so it is also still what catches the routing guard collapsing into the
// adapter path.
describe("emulation-off passthrough envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubCleanEnvironment();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Every header the emulation path forges. None of them may appear on a
  // request the user asked NOT to be disguised. Listed literally rather than
  // derived, so adding a forged header to the emulation path cannot silently
  // extend this list too.
  const FORBIDDEN_WITH_EMULATION_OFF = [
    "x-app",
    "x-claude-code-session-id",
    "x-client-request-id",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-version",
    "x-stainless-arch",
    "x-stainless-lang",
    "x-stainless-os",
    "x-stainless-package-version",
    "x-stainless-retry-count",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
    "x-stainless-timeout",
  ];

  it("emits the host's headers plus the auth envelope, and nothing else", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
    );
    const headers = new Headers(existing.headers);

    // The host sent one header (`content-type`). What comes back is that header,
    // the bearer, and the OAuth beta the API requires alongside it.
    expect([...headers.entries()]).toEqual([
      ["anthropic-beta", "oauth-2025-04-20"],
      ["authorization", "Bearer test-access"],
      ["content-type", "application/json"],
    ]);
  });

  it("forges NONE of the Claude Code headers when signature emulation is off", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
    );
    const headers = new Headers(existing.headers);

    // The negative assertion. Each name is checked individually so a failure
    // names the header that leaked.
    for (const name of FORBIDDEN_WITH_EMULATION_OFF) {
      expect(headers.get(name), `${name} must not be forged with emulation off`).toBeNull();
    }
    // The two that used to survive the switch, called out separately because
    // they are the actual Phase 2.2 breaking change.
    expect(headers.get("user-agent")).toBeNull();
    expect(headers.get("anthropic-beta")).not.toContain("interleaved-thinking-2025-05-14");

    // Discrimination: with emulation ON the very same request grows all of them.
    const adapter = await buildAdapterRequest(HOST_BODY);
    for (const name of FORBIDDEN_WITH_EMULATION_OFF) {
      expect(adapter.headers.get(name), `${name} must still be emitted with emulation on`).toBeTruthy();
    }
    expect(adapter.headers.get("user-agent")).toMatch(/^claude-cli\//);
  });

  it("preserves the host's user-agent and appends to the host's beta list", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages",
      {
        "user-agent": "opencode/1.2.3",
        "anthropic-beta": "prompt-caching-2024-07-31,context-1m-2025-08-07",
        "x-custom-host-header": "kept",
      },
    );
    const headers = new Headers(existing.headers);

    // Untouched: forging a user-agent is mimicry, and mimicry is off.
    expect(headers.get("user-agent")).toBe("opencode/1.2.3");
    expect(headers.get("x-custom-host-header")).toBe("kept");
    // ADDITIVE, not substitutive: the host's betas survive in their own order
    // and the OAuth contract beta is appended.
    expect(headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31,context-1m-2025-08-07,oauth-2025-04-20");
  });

  it("does not duplicate oauth-2025-04-20 when the host already sent it", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages",
      { "anthropic-beta": "oauth-2025-04-20,prompt-caching-2024-07-31" },
    );

    expect(new Headers(existing.headers).get("anthropic-beta")).toBe("oauth-2025-04-20,prompt-caching-2024-07-31");
  });

  it("strips the competing credential and the session-affinity hint", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages",
      { "x-api-key": "sk-ant-should-not-travel", "x-session-affinity": "affinity-1" },
    );
    const headers = new Headers(existing.headers);

    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-session-affinity")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer test-access");
  });

  it("puts the host's body on the wire byte for byte, unlike the package", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
    );
    const adapter = await buildAdapterRequest(HOST_BODY);

    // BYTE FOR BYTE. Not "deep equals": no re-serialization, no key reordering,
    // and none of transformRequestBody's structural normalizations (which used
    // to run here and, among other things, injected `temperature`).
    expect(existing.body).toBe(JSON.stringify(HOST_BODY));

    // The differential itself: no billing prefix, no Claude Code identity block,
    // no `metadata.user_id`, no cache breakpoints — all of which the package
    // adds unconditionally.
    expect(JSON.parse(existing.body).metadata).toBeUndefined();
    expect(JSON.parse(adapter.body).metadata.user_id).toEqual(expect.any(String));
    expect(existing.body).not.toContain("x-anthropic-billing-header");
    expect(adapter.body).toContain("x-anthropic-billing-header");
  });

  it("strips the body-level betas field, the one edit left with emulation off", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      { ...HOST_BODY, betas: ["prompt-caching-2024-07-31"] },
    );
    const parsed = JSON.parse(existing.body);

    // The field is not part of the first-party API — it answers "Extra inputs
    // are not permitted" — so forwarding it would break the request outright.
    expect(parsed.betas).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(Object.keys(HOST_BODY));
  });

  // PREMISE FLIP — READ BEFORE EDITING THE ASSERTION BELOW.
  //
  // Until the count-tokens migration this block asserted the opposite of what
  // it asserts now. Its premise was "the shared package has no count_tokens
  // surface", so /v1/messages/count_tokens was pinned to the legacy forge on
  // BOTH the URL and the body, and the package was pinned to never emit
  // `token-counting-2024-11-01`. That premise is dead: the package exposes
  // `buildClaudeCodeCountTokensRequest`, with its own pinned
  // `countTokensEndpoint`, its own `filterCountTokensBetas` composition and its
  // own body builder. The plugin now routes every count turn through it while
  // signature emulation is on.
  //
  // WHERE THE COUNT WIRE IS PINNED. The three emulation-ON tests that used to
  // live here — URL + body keys, the filtered beta set with the Claude Code
  // user-agent and stainless version, and the absent system/metadata/max_tokens
  // — were byte-level pins of a single request, which is exactly what a golden
  // fixture is for. They now live in test/fixtures/golden/outgoing-count.json,
  // asserted end to end through the real interceptor by
  // test/conformance/golden-outgoing-count.test.mjs. Duplicating them here
  // meant two places to recalibrate on every package release; the routing
  // assertion below is all this file still needs, because parity is about the
  // package-vs-legacy differential and not about the wire's exact bytes.
  //
  // `_useAdapter` is consequently false on ONE route, not two: signature
  // emulation off. That is what the second test below guards, and it is now the
  // only genuinely independent count_tokens differential in this file.
  it("routes count_tokens through the package's own count surface", async () => {
    testPolicy.signature = true;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages/count_tokens",
    );

    // The URL is now `built.url` — the package's pinned count endpoint, adopted
    // verbatim by index.mjs so URL, headers and body all come from one source.
    // Against the default base it agrees with transformRequestUrl's output, so
    // the body is still what proves the routing; url-source.test.mjs is where
    // the adoption itself is pinned.
    expect(String(existing.url)).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    // The package's count body builder emits exactly these three keys; the
    // legacy forge below emits `max_tokens`, `system` and `temperature`
    // instead. One key set apart from the other is the whole differential —
    // the values are the golden's business.
    expect(Object.keys(JSON.parse(existing.body))).toEqual(["model", "messages", "tools"]);
  });

  // The remaining count_tokens differential: with emulation off the count
  // endpoint gets the same passthrough envelope as every other route. It used to
  // receive a THIRD forged beta here (`token-counting-2024-11-01`), which was
  // endpoint-aware mimicry with mimicry off; the envelope is endpoint-blind now.
  it("gives count_tokens the same passthrough envelope when signature emulation is off", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages/count_tokens",
    );
    const headers = new Headers(existing.headers);

    expect([...headers.keys()].sort()).toEqual(["anthropic-beta", "authorization", "content-type"]);
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headers.get("anthropic-beta")).not.toContain("token-counting-2024-11-01");
    // Untouched host body: nothing is forged with emulation off, here either.
    expect(existing.body).toBe(JSON.stringify(HOST_BODY));
  });
});

describe("shared package adapter input normalization", () => {
  const transport = {
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
  };

  function bodyWith(overrides) {
    return JSON.stringify({ ...HOST_BODY, ...overrides });
  }

  it("carries a string system prompt through instead of dropping it", async () => {
    const built = await buildWireCompatibleRequest(bodyWith({ system: "Stay terse." }), transport);
    const system = JSON.parse(built.body).system;
    expect(system.some((block) => block?.text === "Stay terse.")).toBe(true);
  });

  it("preserves an array system prompt unchanged", async () => {
    const built = await buildWireCompatibleRequest(
      bodyWith({ system: [{ type: "text", text: "Stay terse." }] }),
      transport,
    );
    const system = JSON.parse(built.body).system;
    expect(system.some((block) => block?.text === "Stay terse.")).toBe(true);
  });

  it("changes nothing when cacheControl is omitted", async () => {
    const built = await buildWireCompatibleRequest(
      bodyWith({ system: ["First caller block.", { type: "text", text: "Last caller block." }] }),
      transport,
    );
    const system = JSON.parse(built.body).system.filter((block) => block?.text?.includes("caller block."));
    expect(system).toHaveLength(1);
    expect(system[0].text).toBe("First caller block.\nLast caller block.");
    expect("cache_control" in system[0]).toBe(false);
  });

  it("maps thinking.budget_tokens to the package contract and built body", async () => {
    const built = await buildWireCompatibleRequest(
      bodyWith({ thinking: { type: "enabled", budget_tokens: 4096 } }),
      transport,
    );

    expect(JSON.parse(built.body).thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  // rc.10 added upstream's budget clamp: `Tr = Math.min(Fi - 1, Tr)` where `Fi`
  // is the emitted `max_tokens`. `HOST_BODY.max_tokens` is 8000, so a requested
  // 8192 reaches the wire as 7999 rather than being forwarded verbatim. This is
  // the package reproducing the genuine client, not losing the caller's value —
  // the under-the-limit case above still passes through untouched.
  it("clamps a thinking budget that exceeds max_tokens the way upstream does", async () => {
    const built = await buildWireCompatibleRequest(
      bodyWith({ thinking: { type: "enabled", budget_tokens: 8192 } }),
      transport,
    );

    expect(JSON.parse(built.body).max_tokens).toBe(8000);
    expect(JSON.parse(built.body).thinking).toEqual({ type: "enabled", budget_tokens: 7999 });
  });

  it("forwards thinking.display to the package instead of dropping it", async () => {
    const built = await buildWireCompatibleRequest(
      bodyWith({ thinking: { type: "enabled", budget_tokens: 4096, display: "omitted" } }),
      transport,
    );

    expect(JSON.parse(built.body).thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
      display: "omitted",
    });
  });

  it("passes a cacheControl decision through to package breakpoint placement", async () => {
    const built = await buildWireCompatibleRequest(
      bodyWith({ system: ["First caller block.", { type: "text", text: "Last caller block." }] }),
      {
        ...transport,
        cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
      },
    );
    const system = JSON.parse(built.body).system.filter((block) => block?.text?.includes("caller block."));

    expect(system).toHaveLength(1);
    expect(system[0]).toEqual({
      type: "text",
      text: "First caller block.\nLast caller block.",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });

  it("rejects a system prompt that is neither a string nor an array", async () => {
    await expect(buildWireCompatibleRequest(bodyWith({ system: { text: "nope" } }), transport)).rejects.toThrow(
      TypeError,
    );
  });

  it("rejects a tools value that is not an array", async () => {
    await expect(buildWireCompatibleRequest(bodyWith({ tools: { name: "nope" } }), transport)).rejects.toThrow(
      TypeError,
    );
  });

  it("rejects a missing or non-string request body", async () => {
    await expect(buildWireCompatibleRequest(undefined, transport)).rejects.toThrow(TypeError);
  });

  it("applies an emergency plugin-owned Claude Code profile override end to end", async () => {
    vi.stubEnv(
      "OPENCODE_ANTHROPIC_PROFILE_OVERRIDE",
      JSON.stringify({
        cliVersion: "2.1.197",
        userAgent: "claude-cli/2.1.197 (external, cli)",
      }),
    );
    const built = await buildWireCompatibleRequest(bodyWith({}), {
      ...transport,
      profileOverride: {
        cliVersion: "2.1.196",
        userAgent: "claude-cli/2.1.196 (external, cli)",
      },
    });
    const body = JSON.parse(built.body);

    expect(built.headers.get("user-agent")).toBe("claude-cli/2.1.196 (external, cli)");
    expect(body.system[0].text).toContain("cc_version=2.1.196.");
    expect(built.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("uses an emergency profile override from the environment when plugin configuration is absent", async () => {
    vi.stubEnv(
      "OPENCODE_ANTHROPIC_PROFILE_OVERRIDE",
      JSON.stringify({
        cliVersion: "2.1.196",
        userAgent: "claude-cli/2.1.196 (external, cli)",
      }),
    );

    const built = await buildWireCompatibleRequest(bodyWith({}), transport);
    const body = JSON.parse(built.body);

    expect(built.headers.get("user-agent")).toBe("claude-cli/2.1.196 (external, cli)");
    expect(body.system[0].text).toContain("cc_version=2.1.196.");
    expect(built.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("fails loudly when the environment profile override is malformed JSON", async () => {
    vi.stubEnv("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE", '{"cliVersion":');

    await expect(buildWireCompatibleRequest(bodyWith({}), transport)).rejects.toThrow(SyntaxError);
  });
});

// These tests do NOT assert parity. They pin the exact places where the two
// construction paths still disagree, so the boundary stays visible and any
// future package release that moves it fails here loudly instead of silently
// changing the wire.
//
// The direction of that disagreement inverted at rc.10. When this suite was
// written the package lagged the plugin, and every entry here was a package gap
// awaiting an upstream port. Several of those gaps are now closed, and the
// remaining differences split into two kinds:
//
//   * plugin-retained POLICY the package deliberately has no surface for
//     (anti-verbosity injection, adaptive-thinking derivation, default effort);
//   * plugin-retained CONFIGURATION layered on top of the package output — the
//     `custom_betas` merge, which re-adds betas the package deliberately omits.
//     Its per-model golden strings used to live in this file as
//     `BETA_HEADER_GOLDEN`; they went with the retired parity block, and
//     test/conformance/adapter-beta-composition.test.mjs is where beta
//     composition is pinned now.
//
// Where the two differ on PROTOCOL rather than policy or configuration, the
// package is correct and its output is the golden.
describe("shared package boundary - deferred plugin policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubCleanEnvironment();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("drops a bare-string system prompt in the plugin while the adapter preserves it", async () => {
    const hostBody = { ...HOST_BODY, system: "You are a helpful assistant." };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );
    const adapter = await buildAdapterRequest(hostBody);

    expect(existing.body).not.toContain("You are a helpful assistant.");
    expect(adapter.body).toContain("You are a helpful assistant.");
    expect(JSON.parse(existing.body).system.every((block) => block.text !== "You are a helpful assistant.")).toBe(true);
    expect(JSON.parse(adapter.body).system.some((block) => block.text === "You are a helpful assistant.")).toBe(true);
  });

  it("appends the anti-verbosity block on Opus 4.6 in the plugin only", async () => {
    const hostBody = { ...HOST_BODY, model: "claude-opus-4-6", thinking: { type: "adaptive" }, effort: "high" };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );
    const adapter = await buildAdapterRequest(hostBody);

    expect(existing.body).toContain("# Text output (does not apply to tool calls)");
    expect(adapter.body).not.toContain("# Text output (does not apply to tool calls)");
  });

  // Thinking derivation and the default effort remain plugin-only POLICY: the
  // host sent neither, and the package will not invent them.
  //
  // `temperature` is no longer part of that divergence. rc.9 emitted a bare
  // `temperature: 1` here; rc.10 gates the field on upstream's allowlist
  // predicate, which EXCLUDES `claude-opus-4-8`, so the field must be absent.
  // Both paths now agree on omitting it and the assertion below pins that
  // agreement rather than the old divergence.
  it("derives adaptive thinking and the default effort in the plugin only", async () => {
    const hostBody = { ...HOST_BODY, model: "claude-opus-4-8" };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );
    const adapter = await buildAdapterRequest(hostBody);

    const existingBody = JSON.parse(existing.body);
    const adapterBody = JSON.parse(adapter.body);

    expect(existingBody.thinking).toEqual({ type: "adaptive" });
    expect(existingBody.output_config).toEqual({ effort: "high" });
    expect(existingBody.temperature).toBeUndefined();

    expect(adapterBody.thinking).toBeUndefined();
    expect(adapterBody.output_config).toBeUndefined();
    expect(adapterBody.temperature).toBeUndefined();
  });

  it("strips effort for a model without the effort capability while the adapter rejects it", async () => {
    const hostBody = { ...HOST_BODY, effort: "medium" };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );

    expect(JSON.parse(existing.body).effort).toBeUndefined();
    await expect(buildAdapterRequest(hostBody)).rejects.toThrow("INVALID_EFFORT");
  });

  // CLOSED divergence. The plugin recognizes models with unanchored regexes and
  // forwards any id verbatim. rc.9 instead pinned the genuine client catalogue
  // and failed closed with `UNSUPPORTED_MODEL`; rc.10 removed that error code
  // from the package entirely, because the genuine client does not refuse an id
  // it fails to recognize either — it sends it and lets the API answer.
  //
  // `claude-3-5-haiku-latest` is a `provider_ids.first_party` dated form rather
  // than a catalogue id, and `claude-mythos-5` has no catalogue entry in this
  // client version even though its display code recognizes the string. Both now
  // reach the wire unchanged on both paths.
  it.each([["claude-3-5-haiku-latest"], ["claude-mythos-5"]])(
    "forwards %s verbatim on both paths now that the package no longer fails closed",
    async (model) => {
      const hostBody = { ...HOST_BODY, model };
      const existing = await captureExistingRequest(
        vi.fn(() => Promise.resolve(makeSuccessResponse())),
        hostBody,
      );
      const adapter = await buildAdapterRequest(hostBody);

      expect(JSON.parse(existing.body).model).toBe(model);
      expect(JSON.parse(adapter.body).model).toBe(model);
    },
  );

  // INVERTED divergence. rc.9 over-emitted four betas that upstream suppresses
  // for `claude-3-*` models; rc.10 widened the package capability contract and
  // closed that gap, so `adapterOnly` is now empty.
  //
  // What survives is the PLUGIN over-emitting: `claude-code-20250219`, which
  // upstream `$9r` suppresses for haiku models, and `web-search-2025-03-05`,
  // which upstream pushes only under the `vertex` and `foundry` providers. The
  // package is the correct side of both.
  it("pins the inverted Claude 3 beta divergence, with the plugin now over-emitting", async () => {
    const hostBody = { ...HOST_BODY, model: "claude-3-5-haiku" };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );
    const adapter = await buildAdapterRequest(hostBody);

    const pluginBeta = new Headers(existing.headers).get("anthropic-beta") ?? "";
    const adapterBeta = adapter.headers.get("anthropic-beta") ?? "";
    const pluginBetas = pluginBeta.split(",").map((value) => value.trim());
    const adapterBetas = adapterBeta.split(",").map((value) => value.trim());
    const adapterOnly = adapterBetas.filter((value) => !pluginBetas.includes(value)).sort();
    const pluginOnly = pluginBetas.filter((value) => !adapterBetas.includes(value)).sort();

    expect(adapterOnly).toEqual([]);
    expect(pluginOnly).toEqual(["claude-code-20250219", "web-search-2025-03-05"]);
  });
});
