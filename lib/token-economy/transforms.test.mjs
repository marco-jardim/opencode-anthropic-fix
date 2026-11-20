import { describe, expect, it } from "vitest";
import {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  applyAdaptiveThinkingZero,
  applyContextHintCompaction,
  applyIdleToolResultClearing,
  applySessionToolResultDedupe,
  applyStableToolOrdering,
  applyToolResultDedupe,
  applyToolSchemaDeferral,
  applyTrailingSummaryTrim,
  estimatePromptTokensFromParsed,
  injectTokenBudgetBlock,
  parseNaturalLanguageBudget,
} from "./transforms.mjs";

describe("token-economy transforms", () => {
  it.each([
    ["Use 1 million tokens", 1_000_000],
    ["budget: 500k", 500_000],
    ["spend 1200", 1_200],
  ])("parses natural-language budget %s", (content, expected) => {
    expect(parseNaturalLanguageBudget([{ role: "user", content }])).toBe(expected);
  });

  it("injects a token budget system block", () => {
    const existing = { type: "text", text: "Existing prompt" };
    const result = injectTokenBudgetBlock([existing], { limit: 10_000, used: 2_500, continuations: 1 }, 0.9);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "text",
      text: `Token budget: ${(2_500).toLocaleString()}/${(10_000).toLocaleString()} tokens used (25%). Stop generating at ${(9_000).toLocaleString()} tokens. Remaining: ${(7_500).toLocaleString()} tokens.`,
    });
    expect(result[1]).toBe(existing);
  });

  it("estimates a plausible prompt token count from a parsed body", () => {
    const result = estimatePromptTokensFromParsed({
      system: [{ type: "text", text: "12345678" }],
      messages: [{ role: "user", content: "12345678" }],
    });

    expect(result).toBe(4);
  });

  it("dedupes repeated reproducible results while preserving stateful results", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "read-1", name: "read", input: { path: "a.mjs" } },
          { type: "tool_use", id: "bash-1", name: "bash", input: { command: "date" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "read-1", content: "old read" },
          { type: "tool_result", tool_use_id: "bash-1", content: "old bash" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "read-2", name: "read", input: { path: "a.mjs" } },
          { type: "tool_use", id: "bash-2", name: "bash", input: { command: "date" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "read-2", content: "latest read" },
          { type: "tool_result", tool_use_id: "bash-2", content: "latest bash" },
        ],
      },
    ];

    const result = applySessionToolResultDedupe(messages);

    expect(result.changed).toBe(true);
    expect(result.stats.deduped).toBe(1);
    expect(result.messages[1].content[0].content).toBe('[Read of {"path":"a.mjs"} superseded by later read at msg #3]');
    expect(result.messages[3].content[0].content).toBe("latest read");
    expect(result.messages[1].content[1].content).toBe("old bash");
    expect(result.messages[3].content[1].content).toBe("latest bash");
  });

  it("clears thinking and old tool results while keeping the latest eight", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "answer" },
        ],
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: `result-${i}` }],
      })),
      // The latest assistant message: its thinking must survive.
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest", signature: "sig" },
          { type: "text", text: "current" },
        ],
      },
    ];

    const result = applyContextHintCompaction(messages);

    expect(result.stats).toEqual({ thinkingCleared: 1, toolResultsCleared: 2 });
    expect(result.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
    expect(result.messages[1].content[0].content).toBe("[Old tool result content cleared]");
    expect(result.messages[2].content[0].content).toBe("[Old tool result content cleared]");
    expect(result.messages[3].content[0].content).toBe("result-2");
    expect(result.messages[10].content[0].content).toBe("result-9");
    expect(result.messages[11]).toBe(messages[11]);
  });

  it("keeps the latest assistant message's thinking even when it is the only assistant message", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "keep me", signature: "sig" },
          { type: "tool_use", id: "t1", name: "read", input: {} },
        ],
      },
    ];

    const result = applyContextHintCompaction(messages);

    expect(result.changed).toBe(false);
    expect(result.stats.thinkingCleared).toBe(0);
    expect(result.messages[1]).toBe(messages[1]);
  });

  it("uses the shared genuine placeholder text", () => {
    expect(CLEARED_TOOL_RESULT_PLACEHOLDER).toBe("[Old tool result content cleared]");
  });

  it("trims a trailing summary block from a past assistant message", () => {
    const summary = `Summary: ${"completed the requested implementation. ".repeat(3)}`;
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Useful detail" },
          { type: "text", text: summary },
        ],
      },
      { role: "user", content: "Continue" },
      { role: "assistant", content: [{ type: "text", text: "Current response" }] },
    ];

    const result = applyTrailingSummaryTrim(messages);

    expect(result).toMatchObject({ changed: true, trimmed: 1 });
    expect(result.messages[0].content).toEqual([{ type: "text", text: "Useful detail" }]);
  });

  it("dedupes a repeated safe tool result", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "first", name: "Read", input: { file: "a" } },
          { type: "tool_use", id: "second", name: "Read", input: { file: "a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "first", content: "one" },
          { type: "tool_result", tool_use_id: "second", content: "two" },
        ],
      },
    ];

    const result = applyToolResultDedupe(messages, { seen: new Map(), safeTools: new Set(["Read"]) });

    expect(result).toMatchObject({ changed: true, deduped: 1 });
    expect(result.messages[1].content[1].content).toBe("[Identical to tool_use_id=first]");
  });

  it("orders tools stably by name", () => {
    const tools = [{ name: "write" }, { name: "grep" }, { name: "read" }];
    expect(applyStableToolOrdering(tools).map((tool) => tool.name)).toEqual(["grep", "read", "write"]);
    expect(tools.map((tool) => tool.name)).toEqual(["write", "grep", "read"]);
  });

  it("defers schemas only for uninvoked configured tools", () => {
    const tools = [
      { name: "read", input_schema: { type: "object", required: ["path"] } },
      { name: "grep", input_schema: { type: "object", required: ["pattern"] } },
    ];

    const result = applyToolSchemaDeferral(tools, {
      deferred: new Set(["read", "grep"]),
      invoked: new Set(["grep"]),
    });

    expect(result.deferredCount).toBe(1);
    expect(result.tools[0].input_schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(result.tools[1]).toBe(tools[1]);
  });

  it("disables thinking for a simple follow-up", () => {
    const parsed = {
      thinking: { type: "enabled", budget_tokens: 4_096 },
      messages: [
        { role: "user", content: "Initial request" },
        { role: "assistant", content: "Done" },
        { role: "user", content: "Thanks" },
      ],
    };

    expect(applyAdaptiveThinkingZero(parsed)).toEqual({ applied: true, previousBudget: 4_096 });
    expect(parsed).not.toHaveProperty("thinking");
    expect(parsed.temperature).toBe(1);
  });
});

describe("applyIdleToolResultClearing", () => {
  const HOUR = 3_600_000;
  const IDLE = 3_900_000;

  /** n tool_result messages, each `chars` characters long. */
  function conversation(n, chars) {
    return [
      { role: "user", content: "start" },
      ...Array.from({ length: n }, (_, i) => ({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `${i}`.padEnd(chars, "x") }],
      })),
    ];
  }

  it("clears all but the last 12 tool results once idle, large and numerous enough", () => {
    const messages = conversation(30, 4_000); // 30 x 1000 tokens, 18 old = 18 000 tokens < 20 000
    expect(applyIdleToolResultClearing(messages, { idleMs: IDLE, ttlMs: HOUR }).changed).toBe(false);

    const big = conversation(30, 5_000); // 18 old x 1250 = 22 500 tokens
    const result = applyIdleToolResultClearing(big, { idleMs: IDLE, ttlMs: HOUR });

    expect(result.changed).toBe(true);
    expect(result.cleared).toBe(18);
    expect(result.clearedTokens).toBe(22_500);
    expect(result.messages[1].content[0].content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    expect(result.messages[18].content[0].content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    expect(result.messages[19].content[0].content).toBe(big[19].content[0].content);
    expect(result.messages[30].content[0].content).toBe(big[30].content[0].content);
    // tool_use_id survives, input is not mutated
    expect(result.messages[1].content[0].tool_use_id).toBe("t0");
    expect(big[1].content[0].content).not.toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
  });

  it("is a no-op when the idle time is below the minimum or does not exceed the TTL", () => {
    const big = conversation(30, 5_000);
    expect(applyIdleToolResultClearing(big, { idleMs: IDLE - 1, ttlMs: HOUR }).messages).toBe(big);
    expect(applyIdleToolResultClearing(big, { idleMs: HOUR, ttlMs: HOUR, minIdleMs: 0 }).changed).toBe(false);
    expect(applyIdleToolResultClearing(big, { idleMs: Number.NaN }).changed).toBe(false);
  });

  it("is a no-op below 27 tool results", () => {
    const few = conversation(26, 50_000);
    const result = applyIdleToolResultClearing(few, { idleMs: IDLE, ttlMs: HOUR });
    expect(result.changed).toBe(false);
    expect(result.messages).toBe(few);
  });

  it("is a no-op below 20 000 cleared tokens and honours overridden thresholds", () => {
    const small = conversation(30, 100);
    expect(applyIdleToolResultClearing(small, { idleMs: IDLE, ttlMs: HOUR }).changed).toBe(false);
    const relaxed = applyIdleToolResultClearing(small, {
      idleMs: IDLE,
      ttlMs: HOUR,
      clearAtLeastTokens: 1,
      keepToolUses: 2,
      minTriggerToolUses: 3,
    });
    expect(relaxed.cleared).toBe(28);
  });

  it("does not re-clear a result that already holds the placeholder", () => {
    const big = conversation(30, 5_000);
    const once = applyIdleToolResultClearing(big, { idleMs: IDLE, ttlMs: HOUR });
    const twice = applyIdleToolResultClearing(once.messages, { idleMs: IDLE, ttlMs: HOUR });
    expect(twice.changed).toBe(false);
  });
});
