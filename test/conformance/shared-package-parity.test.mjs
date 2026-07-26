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
// `systemPromptFeatures` surface in rc.6, so it never emits the
// `# Text output (does not apply to tool calls)` block. Vectors that assert
// PROTOCOL parity on Opus 4.6/4.7 therefore disable it; the deferred-policy
// suite below asserts the divergence explicitly so the deferral stays visible.
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
  {
    name: "model-mythos-5-adaptive",
    hostBody: { ...HOST_BODY, model: "claude-mythos-5", thinking: { type: "adaptive" }, effort: "high" },
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
]);

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

function normalizeBody(body) {
  const parsed = JSON.parse(body);
  if (!parsed.metadata?.user_id) throw new Error("Missing normalized path: body.metadata.user_id");
  parsed.metadata.user_id = "<normalized>";
  return JSON.stringify(parsed);
}

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
      bodyWith({ thinking: { type: "enabled", budget_tokens: 8192 } }),
      transport,
    );

    expect(JSON.parse(built.body).thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
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

// These tests do NOT assert parity. They pin the exact places where the plugin
// still applies behaviour the shared package rc.6 does not implement, so the
// boundary is visible and any future package release that closes a gap fails
// here loudly instead of silently changing the wire.
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
    expect(adapterBody.temperature).toBe(1);
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

  // The plugin recognizes models with unanchored regexes and forwards any id
  // verbatim; the shared package pins an exhaustive allowlist of the first-party
  // `api.anthropic.com` surface and fails closed on everything else. Claude 3 is
  // reachable only through gateway and cloud providers, each of which prefixes
  // the identifier differently, so the package deliberately refuses it. A host
  // that routes Claude 3 through this plugin must not be migrated to the adapter
  // without first deciding what that request should become.
  it("forwards a Claude 3 model in the plugin while the adapter refuses it", async () => {
    const hostBody = { ...HOST_BODY, model: "claude-3-5-haiku-latest" };
    const existing = await captureExistingRequest(
      vi.fn(() => Promise.resolve(makeSuccessResponse())),
      hostBody,
    );

    expect(JSON.parse(existing.body).model).toBe("claude-3-5-haiku-latest");
    await expect(buildAdapterRequest(hostBody)).rejects.toThrow("UNSUPPORTED_MODEL");
  });
});
