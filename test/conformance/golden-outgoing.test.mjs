import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStainlessArch, getStainlessOs } from "../../lib/mimicry/headers.mjs";

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
    lockPath: "/tmp/opencode-golden-outgoing-test.lock",
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
    // The golden encodes vanilla's default-off GrowthBook assignment; see
    // docs/claude-code-2.1.195-analysis.md:214.
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

// Calibrated by comparing two fresh plugin/interceptor runs of the same input:
// - body.metadata.user_id embeds the generated account, device, and session IDs.
// - headers.x-claude-code-session-id repeats the generated session ID.
// - headers.x-client-request-id is a fresh UUID emitted for every request.
// Host-derived Stainless headers are normalized separately after their presence
// and live-process values are asserted. Other mimicry-critical headers and
// request body fields remain literal in the golden so any drift fails this test.
const GENERATED_PATHS = ["body.metadata.user_id", "headers.x-claude-code-session-id", "headers.x-client-request-id"];
const HOST_DERIVED_PATHS = [
  "headers.x-stainless-arch",
  "headers.x-stainless-os",
  "headers.x-stainless-runtime-version",
];
const NORMALIZED_PATHS = [...GENERATED_PATHS, ...HOST_DERIVED_PATHS];

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

async function driveForegroundRequest(mockFetch) {
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
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  await response.text();
}

function captureOutgoing([_input, init]) {
  if (!init || typeof init.body !== "string") {
    throw new TypeError("Expected the interceptor to send a JSON request body");
  }

  return {
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: JSON.parse(init.body),
  };
}

function differingPaths(left, right, path = "") {
  if (Object.is(left, right)) return [];

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) => differingPaths(left[index], right[index], `${path}[${index}]`)).flat();
  }

  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => differingPaths(left[key], right[key], path ? `${path}.${key}` : key));
  }

  return [path];
}

function normalizeOutgoing(outgoing) {
  const normalized = structuredClone(outgoing);

  for (const path of NORMALIZED_PATHS) {
    const segments = path.split(".");
    const leaf = segments.pop();
    let cursor = normalized;
    for (const segment of segments) cursor = cursor[segment];
    if (!leaf || !Object.hasOwn(cursor, leaf)) throw new Error(`Missing normalized path: ${path}`);
    cursor[leaf] = "<normalized>";
  }

  return normalized;
}

function expectHostDerivedHeaders(outgoing) {
  const { headers } = outgoing;

  expect(headers).toHaveProperty("x-stainless-arch");
  expect(headers["x-stainless-arch"]).toBe(getStainlessArch(process.arch));
  expect(headers).toHaveProperty("x-stainless-os");
  expect(headers["x-stainless-os"]).toBe(getStainlessOs(process.platform));
  expect(headers).toHaveProperty("x-stainless-runtime-version");
  expect(headers["x-stainless-runtime-version"]).toBe(process.version);
  expect(headers["x-stainless-runtime-version"]).toMatch(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
}

describe("golden outgoing foreground request", () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn(() => Promise.resolve(makeSuccessResponse()));
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
    vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "");
    vi.stubEnv("CLAUDE_CODE_ADDITIONAL_PROTECTION", "");
    vi.stubEnv("CLAUDE_CODE_BACKGROUND", "");
    vi.stubEnv("CLAUDE_CODE_CONTAINER_ID", "");
    vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("matches the byte-shape golden after calibrating generated values", async () => {
    await driveForegroundRequest(mockFetch);
    await driveForegroundRequest(mockFetch);

    const messageCalls = mockFetch.mock.calls.filter(([input]) => String(input).includes("/v1/messages"));
    expect(messageCalls).toHaveLength(2);
    const first = captureOutgoing(messageCalls[0]);
    const second = captureOutgoing(messageCalls[1]);
    const calibratedPaths = differingPaths(first, second);

    expect(calibratedPaths).toEqual(GENERATED_PATHS);
    expectHostDerivedHeaders(first);
    expectHostDerivedHeaders(second);
    const normalizedGolden = normalizeOutgoing(golden);
    expect(normalizeOutgoing(first)).toEqual(normalizedGolden);
    expect(normalizeOutgoing(second)).toEqual(normalizedGolden);
  });
});
