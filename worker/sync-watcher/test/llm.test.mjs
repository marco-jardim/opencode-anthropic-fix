/**
 * Unit tests for llm.mjs — Workers AI client for Kimi K2.5.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { invokeLLM } from "../src/llm.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

const SCHEMA = { type: "object", properties: {} };
const SYSTEM = "You are a helpful assistant.";
const USER = "Analyze this diff.";

function makeValidResponse(overrides = {}) {
  return JSON.stringify({
    safe_for_auto_pr: true,
    risk_level: "low",
    summary: "Only version bumped.",
    changes: [],
    confidence: 0.95,
    ...overrides,
  });
}

function makeEnv(responseValue) {
  return {
    AI_MODEL: "@cf/moonshotai/kimi-k2.5",
    AI: {
      run: vi.fn().mockResolvedValue({ response: responseValue }),
    },
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("invokeLLM — happy path", () => {
  it("returns parsed LLM response on valid input", async () => {
    const env = makeEnv(makeValidResponse());
    const result = await invokeLLM(env, SYSTEM, USER, SCHEMA);

    expect(result.safe_for_auto_pr).toBe(true);
    expect(result.risk_level).toBe("low");
    expect(result.confidence).toBe(0.95);
  });

  it("passes messages with system and user roles", async () => {
    const env = makeEnv(makeValidResponse());
    await invokeLLM(env, SYSTEM, USER, SCHEMA);

    const callArgs = env.AI.run.mock.calls[0];
    expect(callArgs[0]).toBe("@cf/moonshotai/kimi-k2.5");
    const messages = callArgs[1].messages;
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM });
    expect(messages[1]).toEqual({ role: "user", content: USER });
  });

  it("passes response_format with json_schema", async () => {
    const env = makeEnv(makeValidResponse());
    await invokeLLM(env, SYSTEM, USER, SCHEMA);

    const callArgs = env.AI.run.mock.calls[0];
    expect(callArgs[1].response_format?.type).toBe("json_schema");
  });

  it("uses AI_MODEL env var as model ID", async () => {
    const env = { ...makeEnv(makeValidResponse()), AI_MODEL: "@cf/custom/model" };
    await invokeLLM(env, SYSTEM, USER, SCHEMA);
    expect(env.AI.run.mock.calls[0][0]).toBe("@cf/custom/model");
  });

  it("falls back to default model when AI_MODEL is not set", async () => {
    const env = makeEnv(makeValidResponse());
    delete env.AI_MODEL;
    await invokeLLM(env, SYSTEM, USER, SCHEMA);
    expect(env.AI.run.mock.calls[0][0]).toBe("@cf/moonshotai/kimi-k2.5");
  });

  it("handles response as bare string (not wrapped in .response)", async () => {
    const env = {
      AI_MODEL: "@cf/moonshotai/kimi-k2.5",
      AI: { run: vi.fn().mockResolvedValue(makeValidResponse()) },
    };
    const result = await invokeLLM(env, SYSTEM, USER, SCHEMA);
    expect(result.safe_for_auto_pr).toBe(true);
  });
});

// ─── Validation edge cases ────────────────────────────────────────────────────

describe("invokeLLM — validation", () => {
  it("throws on missing safe_for_auto_pr", async () => {
    const env = makeEnv(makeValidResponse({ safe_for_auto_pr: undefined }));
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("safe_for_auto_pr");
  });

  it("throws on invalid risk_level", async () => {
    const env = makeEnv(makeValidResponse({ risk_level: "extreme" }));
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("risk_level");
  });

  it("throws on missing summary", async () => {
    const env = makeEnv(makeValidResponse({ summary: 42 }));
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("summary");
  });

  it("throws on missing changes array", async () => {
    const env = makeEnv(makeValidResponse({ changes: "not-array" }));
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("changes");
  });

  it("accepts confidence = 0 (boundary)", async () => {
    const env = makeEnv(makeValidResponse({ confidence: 0 }));
    const result = await invokeLLM(env, SYSTEM, USER, SCHEMA);
    expect(result.confidence).toBe(0);
  });

  it("accepts confidence = 1 (boundary)", async () => {
    const env = makeEnv(makeValidResponse({ confidence: 1 }));
    const result = await invokeLLM(env, SYSTEM, USER, SCHEMA);
    expect(result.confidence).toBe(1);
  });

  it("throws on confidence < 0", async () => {
    const env = makeEnv(makeValidResponse({ confidence: -0.1 }));
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("confidence");
  });

  it("throws on confidence > 1", async () => {
    const env = makeEnv(makeValidResponse({ confidence: 1.5 }));
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("confidence");
  });

  it("accepts empty changes array", async () => {
    const env = makeEnv(makeValidResponse({ changes: [] }));
    const result = await invokeLLM(env, SYSTEM, USER, SCHEMA);
    expect(result.changes).toEqual([]);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("invokeLLM — error handling", () => {
  it("throws wrapped error when AI.run throws", async () => {
    const env = {
      AI_MODEL: "@cf/moonshotai/kimi-k2.5",
      AI: { run: vi.fn().mockRejectedValue(new Error("model unavailable")) },
    };
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("Workers AI model error");
  });

  it("throws on invalid JSON response", async () => {
    const env = makeEnv("not valid json {{{");
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("invalid JSON");
  });

  it("throws on unexpected response shape (not string)", async () => {
    const env = {
      AI_MODEL: "@cf/moonshotai/kimi-k2.5",
      AI: { run: vi.fn().mockResolvedValue({ unexpected: "shape" }) },
    };
    await expect(invokeLLM(env, SYSTEM, USER, SCHEMA)).rejects.toThrow("response shape");
  });

  it("throws on timeout (rejects after timeout duration)", async () => {
    vi.useFakeTimers();
    const env = {
      AI_MODEL: "@cf/moonshotai/kimi-k2.5",
      AI: { run: vi.fn().mockImplementation(() => new Promise(() => {})) }, // never resolves
    };

    const promise = invokeLLM(env, SYSTEM, USER, SCHEMA).catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_001);
    vi.useRealTimers();

    const err = await promise;
    expect(err.message).toContain("timed out");
  });
});
