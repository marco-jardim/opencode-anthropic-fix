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
const testPolicy = vi.hoisted(() => ({ antiVerbosity: true }));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
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
    normalizeThinking: true,
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
});

const NORMALIZED_HEADER_NAMES = new Set([
  "x-claude-code-session-id",
  "x-client-request-id",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-runtime-version",
  // NOT a per-run nondeterminism normalization like the rest of this set: as of
  // rc.10 the shared package is the REFERENCE implementation for
  // `anthropic-beta` and the plugin's own header builder is the stale side, so
  // the two legitimately differ on every vector. Excluding the value here keeps
  // the byte-for-byte assertion enforcing every OTHER header, while
  // `BETA_HEADER_DIVERGENCE` below pins the exact measured value on both sides
  // for each model so nothing is lost.
  "anthropic-beta",
]);

// The measured per-model `anthropic-beta` divergence. The left column is what
// the plugin's own wire path emits today; the right column is what the shared
// package emits, which is what the genuine client emits. Where they differ the
// PACKAGE is correct:
//
//   * `claude-code-20250219` is omitted for haiku models — upstream `$9r` does
//     `if (!isHaiku) push(CLAUDE_CODE)`. The plugin pushes it unconditionally.
//   * `web-search-2025-03-05` is never emitted — upstream pushes it only under
//     the `vertex` and `foundry` providers, never first-party.
//   * `advisor-tool-2026-03-01` is never emitted — no upstream push site for it
//     exists at all.
//   * `mid-conversation-system-2026-04-07` IS emitted for opus-4-8 and fable-5,
//     which the plugin misses entirely.
//   * The ORDER is upstream's emergent push order, not a sorted or curated
//     list, so both sides are pinned as exact strings rather than as sets.
//
// Realigning the plugin onto the package is a product decision reserved for a
// separate change. Until then this table is the contract: any drift on EITHER
// side fails here.
const BETA_HEADER_DIVERGENCE = [
  {
    name: "golden foreground model",
    hostBody: HOST_BODY,
    plugin:
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,web-search-2025-03-05,advisor-tool-2026-03-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    package:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-3-5-haiku",
    hostBody: { ...HOST_BODY, model: "claude-3-5-haiku" },
    plugin:
      "oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,web-search-2025-03-05",
    package: "oauth-2025-04-20,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-haiku-4-5",
    hostBody: { ...HOST_BODY, model: "claude-haiku-4-5" },
    plugin:
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,web-search-2025-03-05,advisor-tool-2026-03-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    package:
      "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-sonnet-4-6",
    hostBody: { ...HOST_BODY, model: "claude-sonnet-4-6", thinking: { type: "adaptive" }, effort: "high" },
    plugin:
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,effort-2025-11-24,web-search-2025-03-05,advisor-tool-2026-03-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    package:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-opus-4-6",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-6", thinking: { type: "adaptive" }, effort: "high" },
    plugin:
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,effort-2025-11-24,web-search-2025-03-05,advisor-tool-2026-03-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    package:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-opus-4-7",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-7", thinking: { type: "adaptive" }, effort: "high" },
    plugin:
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,effort-2025-11-24,web-search-2025-03-05,advisor-tool-2026-03-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    package:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-opus-4-8",
    hostBody: { ...HOST_BODY, model: "claude-opus-4-8", thinking: { type: "adaptive" }, effort: "high" },
    plugin:
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,effort-2025-11-24,web-search-2025-03-05,advisor-tool-2026-03-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    package:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
  {
    name: "claude-fable-5",
    hostBody: { ...HOST_BODY, model: "claude-fable-5", thinking: { type: "adaptive" }, effort: "high" },
    plugin:
      "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,effort-2025-11-24,web-search-2025-03-05,advisor-tool-2026-03-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13",
    package:
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  },
];

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

function normalizeBody(body, { normalizeThinking = false } = {}) {
  const parsed = JSON.parse(body);
  if (!parsed.metadata?.user_id) throw new Error("Missing normalized path: body.metadata.user_id");
  parsed.metadata.user_id = "<normalized>";
  // Opt-in, and only for the enabled-thinking vector. Unlike `user_id` this is
  // not per-run nondeterminism: as of rc.10 the package emits the enabled
  // branch the way upstream does and the plugin does not (see
  // `ENABLED_THINKING_DIVERGENCE` below). Excluding the field keeps the rest of
  // that vector's body under byte-for-byte comparison. Vectors that send
  // `type: "adaptive"` do NOT set this flag — both paths still agree there and
  // must keep agreeing.
  if (normalizeThinking) {
    if (parsed.thinking === undefined) throw new Error("Missing normalized path: body.thinking");
    parsed.thinking = "<normalized>";
  }
  return JSON.stringify(parsed);
}

// The measured enabled-thinking divergence, for a host request carrying
// `thinking: {type: "enabled", budget_tokens: 10000}` against `max_tokens:
// 8000`. The package is correct on both counts:
//
//   * it clamps with upstream's `Tr = Math.min(Fi - 1, Tr)`, so 10000 becomes
//     7999; the plugin forwards the caller's over-limit value untouched.
//   * it emits `budget_tokens` FIRST, which is upstream's insertion order for
//     the enabled branch; the plugin emits `type` first.
//
// Key order is load-bearing because these bodies are compared as serialised
// bytes, so this is pinned as an exact string rather than with `toEqual`.
const ENABLED_THINKING_DIVERGENCE = {
  plugin: '{"type":"enabled","budget_tokens":10000}',
  package: '{"budget_tokens":7999,"type":"enabled"}',
};

async function captureExistingRequest(mockFetch, hostBody) {
  vi.stubGlobal("fetch", mockFetch);
  const plugin = await AnthropicAuthPlugin({ client: makeClient() });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 3_600_000,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());
  const response = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(hostBody),
  });
  await response.text();

  const [url, init] = mockFetch.mock.calls.find(([input]) => String(input).includes("/v1/messages"));
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
    async ({ hostBody, cacheControl, antiVerbosity, normalizeThinking }) => {
      testPolicy.antiVerbosity = antiVerbosity !== false;
      const existing = await captureExistingRequest(
        vi.fn(() => Promise.resolve(makeSuccessResponse())),
        hostBody,
      );
      const adapter = await buildAdapterRequest(hostBody, cacheControl);
      const bodyOptions = { normalizeThinking: normalizeThinking === true };

      expect(normalizeUrl(adapter.url)).toBe(normalizeUrl(existing.url));
      expect(adapter.method).toBe(existing.method);
      expect(normalizeHeaders(adapter.headers)).toEqual(normalizeHeaders(existing.headers));
      expect(normalizeBody(adapter.body, bodyOptions)).toBe(normalizeBody(existing.body, bodyOptions));
    },
  );

  // `normalizeBody` excludes `thinking` from the byte-for-byte comparison for
  // the enabled-thinking vector. This test is what keeps that exclusion honest,
  // pinning the exact serialised object each path produces.
  it("pins the enabled-thinking body divergence with the package as the reference", async () => {
    const hostBody = { ...HOST_BODY, thinking: { type: "enabled", budget_tokens: 10000 } };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );
    const adapter = await buildAdapterRequest(hostBody);

    expect(JSON.stringify(JSON.parse(existing.body).thinking)).toBe(ENABLED_THINKING_DIVERGENCE.plugin);
    expect(JSON.stringify(JSON.parse(adapter.body).thinking)).toBe(ENABLED_THINKING_DIVERGENCE.package);
    expect(JSON.parse(existing.body).max_tokens).toBe(8000);
    expect(JSON.parse(adapter.body).max_tokens).toBe(8000);
  });

  // `normalizeHeaders` excludes `anthropic-beta` from the byte-for-byte
  // comparison above because the plugin and the package no longer agree on it.
  // This test is what keeps that exclusion honest: both sides stay pinned to an
  // exact measured string, so neither can drift unnoticed.
  it.each(BETA_HEADER_DIVERGENCE)(
    "pins the $name anthropic-beta divergence with the package as the reference",
    async ({ hostBody, plugin, package: packageBeta }) => {
      const existing = await captureExistingRequest(
        vi.fn(() => Promise.resolve(makeSuccessResponse())),
        hostBody,
      );
      const adapter = await buildAdapterRequest(hostBody);

      expect(new Headers(existing.headers).get("anthropic-beta")).toBe(plugin);
      expect(adapter.headers.get("anthropic-beta")).toBe(packageBeta);
    },
  );

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
//   * places where the PLUGIN is now the stale side and the package matches
//     upstream (the `anthropic-beta` set above, `temperature` suppression).
//
// Where the two differ on PROTOCOL rather than policy, the package is correct.
// Realigning the plugin is out of scope here; recording the inversion is not.
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
