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
    lockPath: "/tmp/opencode-stream-transform-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    account_selection_strategy: "sticky",
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
  });

  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";
import { loadAccounts, saveAccounts } from "../../lib/storage.mjs";
import { createFakeAnthropic, createViFetch, toSSEFrames } from "../helpers/fake-anthropic.mjs";

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
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        cost: { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-sonnet": {
        id: "claude-sonnet",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 8192 },
      },
    },
  };
}

describe("response stream transform conformance", () => {
  let fake;
  let fetchFn;

  beforeEach(async () => {
    vi.clearAllMocks();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);

    fake = createFakeAnthropic();
    vi.stubGlobal("fetch", createViFetch(vi, fake));

    const plugin = await AnthropicAuthPlugin({ client: makeClient() });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "test-refresh",
      access: "test-access",
      expires: Date.now() + 3_600_000,
    });
    ({ fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider()));
  });

  afterEach(() => {
    fake.reset();
    vi.unstubAllGlobals();
  });

  async function transformFrames(frames) {
    fake.enqueueSSE(frames, { status: 200 });
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    return response.text();
  }

  it("strips mcp_ prefix from tool_use names on the way back", async () => {
    const frames = toSSEFrames([
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_write_file","id":"t1"}}',
    ]);

    const output = await transformFrames(frames);

    expect(output).toContain('"name":"write_file"');
    expect(output).not.toContain("mcp_write_file");
  });

  it("does NOT strip mcp_ from text content", async () => {
    const frame =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"call mcp_write_file now"}}';
    const frames = toSSEFrames([frame]);

    const output = await transformFrames(frames);

    expect(output).toBe(`${frame}\n\n`);
    expect(output).toContain('"text":"call mcp_write_file now"');
  });

  it("passes stop_details through unchanged", async () => {
    const frame =
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_details":{"type":"tool_use"}},"usage":{"output_tokens":7}}';
    const frames = toSSEFrames([frame]);

    const output = await transformFrames(frames);

    expect(output).toBe(`${frame}\n\n`);
    expect(output).toContain('"stop_details":{"type":"tool_use"}');
  });

  it("handles a mid-stream error event without crashing", async () => {
    const contentFrame =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}';
    const errorFrame = 'data: {"type":"error","error":{"type":"overloaded_error","message":"x"}}';
    const frames = toSSEFrames([contentFrame, errorFrame]);

    const output = await transformFrames(frames);

    expect(output).toBe(`${contentFrame}\n\n${errorFrame}\n\n`);
    expect(output).toContain('"type":"overloaded_error","message":"x"');
  });

  it("handles an empty / minimal stream", async () => {
    const frame =
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}';
    const frames = toSSEFrames([frame]);

    const output = await transformFrames(frames);

    expect(output).toBe(`${frame}\n\n`);
    expect(output.match(/^data: /gm)).toHaveLength(1);
  });

  it("round-trips a thinking_delta frame byte-identically", async () => {
    const frame =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"consider mcp_write_file carefully"}}';
    const frames = toSSEFrames([frame]);

    const output = await transformFrames(frames);

    expect(output).toBe(`${frame}\n\n`);
  });
});
