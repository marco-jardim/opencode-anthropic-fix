// WHAT THIS SUITE GUARANTEES (the file name is now only half accurate).
//
// It was written as a DIFFERENTIAL suite: it captured the request the plugin's
// own legacy forge produced and compared it byte for byte against the shared
// package (`@tormentalabs/claude-code-wire-compat`), to prove the migration
// would not move the wire. That framing is spent for the first-party
// `/v1/messages` turn: `index.mjs` now routes that turn THROUGH the package
// (`_useAdapter` in index.mjs), so the "existing" side is no longer an
// independent implementation — it is the package plus a thin layer of
// plugin-owned policy. Comparing the two proves less than it used to, and where
// they agree completely the comparison is a tautology.
//
// What the suite guarantees NOW, in three parts:
//
//  1. GOLDEN PINNING of the package output. `adapter golden wire` pins the
//     literal URL, header list and body the package emits for the reference
//     foreground request, plus the per-model `anthropic-beta` string, the
//     enabled-thinking shape and the `max_tokens` clamp. Every value here was
//     CAPTURED from a run of the real code, never hand-written. Its job is to
//     make an unintended wire change in a future package bump fail loudly.
//
//  2. NO-DRIFT between the package called bare and the package called through
//     the plugin. `shared package foreground parity` still runs byte for byte,
//     but what it now proves is that the plugin's pre-processing
//     (`transformRequestBody`) and transport construction (`buildAdapterTransport`)
//     do not perturb the wire beyond the fields listed in
//     `NORMALIZED_HEADER_NAMES`. That is a real property, and it is the one that
//     breaks first when someone adds body-mutating policy.
//
//     Every field held out of that comparison costs coverage, so the held-out
//     set is kept minimal and each member has to earn its slot. It is currently
//     TWO: `anthropic-beta` (a real, permanent divergence — the plugin merges
//     `custom_betas` on top of the package's list — re-pinned on both sides by
//     `BETA_HEADER_GOLDEN`), and `body.metadata.user_id` (per-run
//     nondeterminism). A third, `body.thinking`, was removed once the migration
//     to the package made both paths emit the same value: it had stopped
//     excluding any difference and would only have hidden a future real one.
//
//  3. TRUE DIFFERENTIAL on the two routes where the LEGACY forge still runs.
//     `_useAdapter` is false when signature emulation is off and on
//     `/v1/messages/count_tokens`. `legacy request path` pins both, and asserts
//     they are distinguishable from the package output — that is what proves the
//     routing guard in index.mjs is still doing its job rather than having
//     quietly collapsed into the adapter path.
//
// APPROVED wire changes that this suite now records as golden rather than as
// bugs: the package's `anthropic-beta` ORDER wins (it was derived from the
// genuine Claude Code 2.1.195 binary), `thinking` is re-ordered and clamped, and
// `max_tokens` is clamped to the model's real output ceiling.

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
// `# Text output (does not apply to tool calls)` block. Vectors that assert
// PROTOCOL parity on Opus 4.6/4.7 therefore disable it; the boundary suite
// below asserts the divergence explicitly so the deferral stays visible.
// `signature` is the `_useAdapter` switch in index.mjs: with emulation off the
// plugin's LEGACY forge runs instead of the package. The `legacy request path`
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

const DIFFERENTIAL_VECTORS = [
  {
    name: "golden foreground",
    hostBody: HOST_BODY,
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "short-user",
    hostBody: {
      ...HOST_BODY,
      messages: [{ role: "user", content: "hi" }],
    },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "tools",
    hostBody: {
      ...HOST_BODY,
      tools: [
        {
          name: "lookup_weather",
          description: "Look up the weather for a city",
          input_schema: {
            type: "object",
            required: ["city"],
            properties: { city: { type: "string" } },
          },
        },
        {
          name: "lookup_time",
          description: "Look up the time for a timezone",
          input_schema: {
            type: "object",
            required: ["timezone"],
            properties: { timezone: { type: "string" } },
          },
        },
      ],
    },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true, toolBreakpoint: true },
  },
  {
    name: "tool-use-result",
    hostBody: {
      ...HOST_BODY,
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "calc", input: { expr: "2+2" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "4" }],
        },
      ],
    },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true, messageBreakpoint: true },
  },
  {
    name: "thinking",
    hostBody: {
      ...HOST_BODY,
      thinking: { type: "enabled", budget_tokens: 10000 },
    },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "multi-block-system",
    hostBody: {
      ...HOST_BODY,
      system: [
        { type: "text", text: "You are a helpful assistant." },
        { type: "text", text: "Keep answers concise." },
      ],
    },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "model-haiku-4-5",
    hostBody: { ...HOST_BODY, model: "claude-haiku-4-5" },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "model-sonnet-4-6-adaptive",
    hostBody: { ...HOST_BODY, model: "claude-sonnet-4-6", thinking: { type: "adaptive" }, effort: "high" },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "model-opus-4-6-adaptive",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-6", thinking: { type: "adaptive" }, effort: "high" },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
    antiVerbosity: false,
  },
  {
    name: "model-opus-4-7-adaptive",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-7", thinking: { type: "adaptive" }, effort: "high" },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
    antiVerbosity: false,
  },
  {
    name: "model-opus-4-8-adaptive",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-8", thinking: { type: "adaptive" }, effort: "high" },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "effort-medium-adaptive",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-8", thinking: { type: "adaptive" }, effort: "medium" },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
  {
    name: "model-fable-5-adaptive",
    hostBody: { ...HOST_BODY, model: "claude-fable-5", thinking: { type: "adaptive" }, effort: "high" },
    cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
  },
];

beforeEach(() => {
  testPolicy.antiVerbosity = true;
  testPolicy.signature = true;
});

const NORMALIZED_HEADER_NAMES = new Set([
  "x-claude-code-session-id",
  "x-client-request-id",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-runtime-version",
  // NOT a per-run nondeterminism normalization like the rest of this set. Both
  // sides now get their base beta set from the package, but the plugin path
  // additionally merges its own configured betas on top (`custom_betas` reaches
  // the package as `signature.customBetas`), so the two legitimately differ on
  // every vector. Excluding the value here keeps the byte-for-byte assertion
  // enforcing every OTHER header, while `BETA_HEADER_GOLDEN` below pins the
  // exact captured value on both sides for each model so nothing is lost.
  "anthropic-beta",
]);

// GOLDEN, per model, for the `anthropic-beta` header. Both columns were
// captured from a run of the real code; neither was hand-composed.
//
//   * `packageOnly` is what `buildWireCompatibleRequest` emits when called bare.
//     This is the reference: the package's beta list and its ORDER were derived
//     from the genuine Claude Code 2.1.195 binary, so the package order is the
//     client's order and it wins. `claude-code-20250219` leads on non-haiku
//     models and is suppressed entirely on `claude-3-5-haiku` (upstream `$9r`
//     does `if (!isHaiku) push(CLAUDE_CODE)`), and
//     `mid-conversation-system-2026-04-07` appears only for opus-4-8 and
//     fable-5.
//   * `pluginPath` is what actually leaves index.mjs for the same request. It is
//     the package list PLUS the plugin's own configured betas merged on top —
//     `web-search-2025-03-05` and `advisor-tool-2026-03-01` come from
//     `custom_betas`, which is why they trail the package's entries. On
//     `claude-3-5-haiku` and `claude-haiku-4-5` that merge also re-adds
//     `claude-code-20250219` at the END, where the package deliberately dropped
//     it.
//
// The order is upstream's emergent push order, not a sorted or curated list, so
// both columns are pinned as exact strings rather than as sets. Any drift on
// EITHER column fails here.
const BETA_HEADER_GOLDEN = [
  {
    name: "golden foreground model",
    hostBody: HOST_BODY,
    pluginPath:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,web-search-2025-03-05,advisor-tool-2026-03-01",
    packageOnly:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-3-5-haiku",
    hostBody: { ...HOST_BODY, model: "claude-3-5-haiku" },
    pluginPath:
      "oauth-2025-04-20,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,web-search-2025-03-05,claude-code-20250219",
    packageOnly: "oauth-2025-04-20,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-haiku-4-5",
    hostBody: { ...HOST_BODY, model: "claude-haiku-4-5" },
    pluginPath:
      "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,web-search-2025-03-05,advisor-tool-2026-03-01,claude-code-20250219",
    packageOnly:
      "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-sonnet-4-6",
    hostBody: { ...HOST_BODY, model: "claude-sonnet-4-6", thinking: { type: "adaptive" }, effort: "high" },
    pluginPath:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11,web-search-2025-03-05,advisor-tool-2026-03-01",
    packageOnly:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-opus-4-6",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-6", thinking: { type: "adaptive" }, effort: "high" },
    pluginPath:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11,web-search-2025-03-05,advisor-tool-2026-03-01",
    packageOnly:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-opus-4-7",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-7", thinking: { type: "adaptive" }, effort: "high" },
    pluginPath:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11,web-search-2025-03-05,advisor-tool-2026-03-01",
    packageOnly:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-opus-4-8",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-8", thinking: { type: "adaptive" }, effort: "high" },
    pluginPath:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,extended-cache-ttl-2025-04-11,web-search-2025-03-05,advisor-tool-2026-03-01",
    packageOnly:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-fable-5",
    hostBody: { ...HOST_BODY, model: "claude-fable-5", thinking: { type: "adaptive" }, effort: "high" },
    pluginPath:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,extended-cache-ttl-2025-04-11,web-search-2025-03-05,advisor-tool-2026-03-01",
    packageOnly:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
];

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

function normalizeUrl(value) {
  return new URL(String(value)).toString();
}

function normalizeHeaders(headers) {
  return [...new Headers(headers).entries()].map(([name, value]) => [
    name,
    NORMALIZED_HEADER_NAMES.has(name) ? "<normalized>" : value,
  ]);
}

// `metadata.user_id` is the ONLY body field held out of the byte-for-byte
// comparison, and it is held out for per-run nondeterminism alone. `thinking`
// used to be excluded here too, opt-in per vector: as of rc.10 the package
// emitted upstream's enabled branch and the plugin did not. That divergence is
// closed — the first-party turn routes through the package, both paths emit
// `ENABLED_THINKING_GOLDEN`, and the exclusion was excluding nothing while
// still hiding any future real drift in the field. It was removed; `thinking`
// is now compared as bytes like every other field.
function normalizeBody(body) {
  const parsed = JSON.parse(body);
  if (!parsed.metadata?.user_id) throw new Error("Missing normalized path: body.metadata.user_id");
  parsed.metadata.user_id = "<normalized>";
  return JSON.stringify(parsed);
}

// GOLDEN for the enabled-thinking shape, for a host request carrying
// `thinking: {type: "enabled", budget_tokens: 10000}` against `max_tokens:
// 8000`. Captured from a run, and identical on both construction paths now that
// the first-party turn routes through the package:
//
//   * the budget is clamped with upstream's `Tr = Math.min(Fi - 1, Tr)`, so
//     10000 becomes 7999;
//   * `budget_tokens` is emitted FIRST, which is upstream's insertion order for
//     the enabled branch.
//
// Both are APPROVED wire changes, not regressions. Key order is load-bearing
// because these bodies are compared as serialised bytes, so this is pinned as an
// exact string rather than with `toEqual`.
const ENABLED_THINKING_GOLDEN = '{"budget_tokens":7999,"type":"enabled"}';

async function captureExistingRequest(mockFetch, hostBody, pathname = "/v1/messages") {
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
    headers: { "content-type": "application/json" },
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

describe("shared package foreground parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubCleanEnvironment();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(DIFFERENTIAL_VECTORS)(
    "matches the $name request byte-for-byte after golden normalization",
    async ({ hostBody, cacheControl, antiVerbosity }) => {
      testPolicy.antiVerbosity = antiVerbosity !== false;
      const existing = await captureExistingRequest(
        vi.fn(() => Promise.resolve(makeSuccessResponse())),
        hostBody,
      );
      const adapter = await buildAdapterRequest(hostBody, cacheControl);

      expect(normalizeUrl(adapter.url)).toBe(normalizeUrl(existing.url));
      expect(adapter.method).toBe(existing.method);
      expect(normalizeHeaders(adapter.headers)).toEqual(normalizeHeaders(existing.headers));
      expect(normalizeBody(adapter.body)).toBe(normalizeBody(existing.body));
    },
  );

  // `thinking` is NO LONGER excluded from the byte-for-byte comparison above —
  // both paths emit the same object, so the vector compares it as bytes like
  // any other field. What that vector cannot catch is the two paths drifting
  // TOGETHER, which is exactly what a package bump does. This test pins the
  // exact serialised object each path produces against the captured golden. The
  // clamp to 7999 and the `budget_tokens`-first key order are APPROVED wire
  // changes; the assertion exists so an UNAPPROVED one fails.
  it("pins the enabled-thinking golden on both construction paths", async () => {
    const hostBody = { ...HOST_BODY, thinking: { type: "enabled", budget_tokens: 10000 } };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );
    const adapter = await buildAdapterRequest(hostBody);

    expect(JSON.stringify(JSON.parse(existing.body).thinking)).toBe(ENABLED_THINKING_GOLDEN);
    expect(JSON.stringify(JSON.parse(adapter.body).thinking)).toBe(ENABLED_THINKING_GOLDEN);
    expect(JSON.parse(existing.body).max_tokens).toBe(8000);
    expect(JSON.parse(adapter.body).max_tokens).toBe(8000);
  });

  // `normalizeHeaders` excludes `anthropic-beta` from the byte-for-byte
  // comparison above because the plugin path merges its own configured betas on
  // top of the package's list. This test is what keeps that exclusion honest:
  // both sides stay pinned to an exact captured string, so neither can drift
  // unnoticed — not the package's list or order, and not the plugin's merge.
  it.each(BETA_HEADER_GOLDEN)(
    "pins the $name anthropic-beta golden on both construction paths",
    async ({ hostBody, pluginPath, packageOnly }) => {
      const existing = await captureExistingRequest(
        vi.fn(() => Promise.resolve(makeSuccessResponse())),
        hostBody,
      );
      const adapter = await buildAdapterRequest(hostBody);

      expect(new Headers(existing.headers).get("anthropic-beta")).toBe(pluginPath);
      expect(adapter.headers.get("anthropic-beta")).toBe(packageOnly);
    },
  );

  // The package caps `max_tokens` at the model's own default output limit before
  // it reaches the wire, matching upstream's `Fi = Math.min(callerValue,
  // qct(model))`. This is an APPROVED wire change and it converts an error into
  // a success: `max_tokens: 64000` on sonnet-4-5 takes an HTTP 400 from the real
  // API today, and the clamp is what stops that.
  //
  // The clamp is invisible to the byte-for-byte vectors above because
  // `HOST_BODY.max_tokens` is 8000 and every model those vectors exercise has a
  // default output limit at or above 8192. It only appears once a caller asks
  // for more than the model will give, which is what this vector does. Both
  // paths land on the same golden because the first-party turn now routes
  // through the package; the assertion is here so a future package bump that
  // moved the ceiling would fail rather than silently change the wire.
  it("pins the max_tokens clamp golden on both construction paths", async () => {
    // claude-sonnet-4-5 has a default output limit of 32000.
    const hostBody = { ...HOST_BODY, max_tokens: 40000 };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );
    const adapter = await buildAdapterRequest(hostBody);

    expect(JSON.parse(existing.body).max_tokens).toBe(32000);
    expect(JSON.parse(adapter.body).max_tokens).toBe(32000);
  });

  it("leaves max_tokens untouched on both paths when it is under the model limit", async () => {
    // The control for the test above: at 8000 the cap cannot bite, which is why
    // the byte-for-byte vectors still agree on this field.
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
    );
    const adapter = await buildAdapterRequest(HOST_BODY);

    expect(JSON.parse(existing.body).max_tokens).toBe(8000);
    expect(JSON.parse(adapter.body).max_tokens).toBe(8000);
  });

  it("omits the context hint beta and body field on both construction paths", async () => {
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
    );
    const adapter = await buildAdapterRequest(HOST_BODY);

    const existingBeta = new Headers(existing.headers).get("anthropic-beta") ?? "";
    const adapterBeta = adapter.headers.get("anthropic-beta") ?? "";

    expect(existingBeta).not.toContain("context-hint-2026-04-09");
    expect(adapterBeta).not.toContain("context-hint-2026-04-09");
    expect(JSON.parse(existing.body).context_hint).toBeUndefined();
    expect(JSON.parse(adapter.body).context_hint).toBeUndefined();
  });
});

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

// TRUE DIFFERENTIAL. `_useAdapter` in index.mjs is false on exactly two routes,
// and on both of them the plugin's LEGACY forge — `buildRequestHeaders` plus the
// untouched `transformRequestBody` output — is what reaches the wire. These are
// the only assertions left in this file where the two implementations are
// genuinely independent, so they are also the only ones that can still catch the
// routing guard collapsing into the adapter path.
describe("legacy request path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubCleanEnvironment();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Route 1: signature emulation off. index.mjs: "with it off the plugin emits
  // only 3 headers and a minimal beta set, while the package always emits the
  // full Claude Code set."
  it("emits the minimal legacy header set when signature emulation is off", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
    );

    expect([...new Headers(existing.headers).entries()]).toEqual([
      ["anthropic-beta", "oauth-2025-04-20,interleaved-thinking-2025-05-14"],
      ["authorization", "Bearer test-access"],
      ["content-type", "application/json"],
      ["user-agent", "claude-cli/2.1.233 (external, cli)"],
    ]);
  });

  it("leaves the body unforged when signature emulation is off, unlike the package", async () => {
    testPolicy.signature = false;
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
    );
    const adapter = await buildAdapterRequest(HOST_BODY);
    const legacyBody = JSON.parse(existing.body);

    expect(legacyBody).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: [{ type: "text", text: "You are a helpful assistant." }],
      messages: [{ role: "user", content: "Hello" }],
      temperature: 1,
    });
    expect(Object.keys(legacyBody)).toEqual(["model", "max_tokens", "system", "messages", "temperature"]);

    // The differential itself: no billing prefix, no Claude Code identity block,
    // no `metadata.user_id`, no cache breakpoints — all of which the package
    // adds unconditionally.
    expect(legacyBody.metadata).toBeUndefined();
    expect(JSON.parse(adapter.body).metadata.user_id).toEqual(expect.any(String));
    expect(existing.body).not.toContain("x-anthropic-billing-header");
    expect(adapter.body).toContain("x-anthropic-billing-header");
  });

  // Route 2: /v1/messages/count_tokens. index.mjs: "the package pins
  // `https://api.anthropic.com/v1/messages?beta=true`, so a
  // /v1/messages/count_tokens turn sent through it would be silently rewritten
  // to the wrong endpoint." This is the assertion that proves it is not.
  it("keeps count_tokens on its own endpoint instead of the package's pinned URL", async () => {
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages/count_tokens",
    );
    const adapter = await buildAdapterRequest(HOST_BODY);

    expect(String(existing.url)).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(adapter.url).toBe(GOLDEN_ADAPTER_URL);
  });

  it("emits the legacy beta set with token-counting-2024-11-01 on count_tokens", async () => {
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages/count_tokens",
    );
    const adapter = await buildAdapterRequest(HOST_BODY);

    // Captured. Note the ORDER: `oauth-2025-04-20` leads, because this is the
    // plugin's own header builder rather than the package's. That is the
    // fingerprint of the legacy path, and the reason this assertion can still
    // tell the two implementations apart.
    expect(new Headers(existing.headers).get("anthropic-beta")).toBe(
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,web-search-2025-03-05,advisor-tool-2026-03-01,token-counting-2024-11-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    );
    // The package has no count_tokens surface, so it never emits this beta.
    expect(adapter.headers.get("anthropic-beta")).not.toContain("token-counting-2024-11-01");
  });

  // The body transform runs on BOTH routes — only the header forge and the URL
  // are legacy here — so count_tokens still carries the forged Claude Code
  // system prefix. Pinned so a future change that skipped the transform for
  // count_tokens would be caught.
  it("still forges the count_tokens body through the shared transform", async () => {
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      HOST_BODY,
      "/v1/messages/count_tokens",
    );
    const parsed = JSON.parse(existing.body);

    expect(Object.keys(parsed)).toEqual(GOLDEN_ADAPTER_BODY_KEYS);
    expect(parsed.system.map((block) => block.text)).toEqual(
      GOLDEN_ADAPTER_BODY.system
        .map((block) => block.text)
        .map((text) =>
          text.startsWith("x-anthropic-billing-header:") ? expect.stringContaining("cc_entrypoint=cli") : text,
        ),
    );
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(JSON.parse(parsed.metadata.user_id)).toEqual({
      device_id: expect.stringMatching(/^[0-9a-f]{64}$/),
      account_uuid: expect.any(String),
      session_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
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
//     `custom_betas` merge pinned in `BETA_HEADER_GOLDEN`, which re-adds betas
//     the package deliberately omits.
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
