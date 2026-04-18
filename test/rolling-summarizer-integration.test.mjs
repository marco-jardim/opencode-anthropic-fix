import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicAuthPlugin } from "../index.mjs";

const { runHaikuSessionSummarize } = AnthropicAuthPlugin.__testing__;

function makeMessages() {
  return [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello back" },
  ];
}

function makeInput(messages = makeMessages()) {
  return { sessionID: "sess-abc", messages, model: { id: "opus", providerID: "anthropic" } };
}

function makeOutput() {
  return { summary: undefined, modelID: undefined, providerID: undefined, tokens: undefined, cost: undefined };
}

describe("runHaikuSessionSummarize — integration", () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = {
      calls: [],
      warn: function (msg) {
        this.calls.push(msg);
      },
    };
  });

  it("no-ops when config flag is off", async () => {
    const callHaikuFn = vi.fn();
    const rollingSummarizeFn = vi.fn();
    const output = makeOutput();

    await runHaikuSessionSummarize(
      {
        config: { token_economy_strategies: { haiku_rolling_summary: false } },
        getAccessToken: async () => "tok",
        fetchFn: vi.fn(),
        callHaikuFn,
        rollingSummarizeFn,
        logger: warnSpy,
      },
      makeInput(),
      output,
    );

    expect(output.summary).toBeUndefined();
    expect(callHaikuFn).not.toHaveBeenCalled();
    expect(rollingSummarizeFn).not.toHaveBeenCalled();
  });

  it("no-ops when config is missing the token_economy_strategies key entirely", async () => {
    const callHaikuFn = vi.fn();
    const rollingSummarizeFn = vi.fn();
    const output = makeOutput();

    await runHaikuSessionSummarize(
      {
        config: {},
        getAccessToken: async () => "tok",
        fetchFn: vi.fn(),
        callHaikuFn,
        rollingSummarizeFn,
        logger: warnSpy,
      },
      makeInput(),
      output,
    );

    expect(output.summary).toBeUndefined();
    expect(rollingSummarizeFn).not.toHaveBeenCalled();
  });

  it("populates output with summary + metadata when Haiku returns a summary", async () => {
    const callHaikuFn = vi.fn(async ({ prompt: _prompt }) => ({
      text: "raw haiku response",
      tokens: { input: 500, output: 80 },
      cost: 0.0009,
    }));
    // rollingSummarize takes (messages, { haikuCall }) and internally calls
    // haikuCall(request) where request = { model, prompt, temperature }. It
    // returns the parsed+formatted summary string.
    const rollingSummarizeFn = vi.fn(async (_messages, { haikuCall }) => {
      // Invoke haikuCall to exercise the adapter's token/cost capture path.
      await haikuCall({ model: "x", prompt: "summarize please", temperature: 0 });
      return "rolled-up summary body";
    });
    const output = makeOutput();

    await runHaikuSessionSummarize(
      {
        config: { token_economy_strategies: { haiku_rolling_summary: true } },
        getAccessToken: async () => "oauth-token",
        fetchFn: vi.fn(),
        callHaikuFn,
        rollingSummarizeFn,
        logger: warnSpy,
      },
      makeInput(),
      output,
    );

    expect(output.summary).toBe("rolled-up summary body");
    expect(output.modelID).toBe("claude-haiku-4-5-20251001");
    expect(output.providerID).toBe("anthropic");
    expect(output.tokens).toEqual({ input: 500, output: 80 });
    expect(output.cost).toBeCloseTo(0.0009, 8);
    expect(warnSpy.calls).toHaveLength(0);

    // Verify the adapter unwrapped request.prompt before calling callHaikuFn
    expect(callHaikuFn).toHaveBeenCalledTimes(1);
    expect(callHaikuFn.mock.calls[0][0].prompt).toBe("summarize please");
  });

  it("leaves output unchanged and logs when rollingSummarize rejects (fall-through)", async () => {
    const callHaikuFn = vi.fn();
    const rollingSummarizeFn = vi.fn(async () => {
      throw new Error("haiku 429 rate limit");
    });
    const output = makeOutput();

    await runHaikuSessionSummarize(
      {
        config: { token_economy_strategies: { haiku_rolling_summary: true } },
        getAccessToken: async () => "oauth-token",
        fetchFn: vi.fn(),
        callHaikuFn,
        rollingSummarizeFn,
        logger: warnSpy,
      },
      makeInput(),
      output,
    );

    expect(output.summary).toBeUndefined();
    expect(output.modelID).toBeUndefined();
    expect(warnSpy.calls).toHaveLength(1);
    expect(warnSpy.calls[0]).toMatch(/haiku rolling summary failed/);
    expect(warnSpy.calls[0]).toMatch(/haiku 429 rate limit/);
  });

  it("leaves output unchanged when rollingSummarize returns empty string", async () => {
    const callHaikuFn = vi.fn();
    const rollingSummarizeFn = vi.fn(async () => "");
    const output = makeOutput();

    await runHaikuSessionSummarize(
      {
        config: { token_economy_strategies: { haiku_rolling_summary: true } },
        getAccessToken: async () => "oauth-token",
        fetchFn: vi.fn(),
        callHaikuFn,
        rollingSummarizeFn,
        logger: warnSpy,
      },
      makeInput(),
      output,
    );

    expect(output.summary).toBeUndefined();
  });
});
