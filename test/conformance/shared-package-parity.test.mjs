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

async function captureExistingRequest(mockFetch) {
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
    body: JSON.stringify(HOST_BODY),
  });
  await response.text();

  const [url, init] = mockFetch.mock.calls.find(([input]) => String(input).includes("/v1/messages"));
  return { url, method: init.method, headers: init.headers, body: init.body };
}

describe("shared package foreground parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("matches the golden foreground request byte-for-byte after golden normalization", async () => {
    const existing = await captureExistingRequest(vi.fn(() => Promise.resolve(makeSuccessResponse())));
    const adapter = await buildWireCompatibleRequest(JSON.stringify(HOST_BODY), {
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
      systemCacheControl: { type: "ephemeral", ttl: "1h" },
    });

    expect(normalizeUrl(adapter.url)).toBe(normalizeUrl(existing.url));
    expect(adapter.method).toBe(existing.method);
    expect(normalizeHeaders(adapter.headers)).toEqual(normalizeHeaders(existing.headers));
    expect(normalizeBody(adapter.body)).toBe(normalizeBody(existing.body));
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

  it("does not add cache control to caller system blocks when omitted", async () => {
    const built = await buildWireCompatibleRequest(
      bodyWith({ system: ["First caller block.", { type: "text", text: "Last caller block." }] }),
      transport,
    );
    const system = JSON.parse(built.body).system.filter((block) => block?.text?.includes("caller block."));
    expect(system).toHaveLength(2);
    expect(system.every((block) => !("cache_control" in block))).toBe(true);
  });

  it("rejects a non-object system cache control value", async () => {
    await expect(
      buildWireCompatibleRequest(bodyWith({}), { ...transport, systemCacheControl: "ephemeral" }),
    ).rejects.toThrow(new TypeError("Expected systemCacheControl to be a non-null plain object"));
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
