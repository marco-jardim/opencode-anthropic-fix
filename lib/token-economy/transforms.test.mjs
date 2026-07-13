import { describe, expect, it } from "vitest";
import {
  applyAdaptiveThinkingZero,
  applyContextHintCompaction,
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
    ];

    const result = applyContextHintCompaction(messages);

    expect(result.stats).toEqual({ thinkingCleared: 1, toolResultsCleared: 2 });
    expect(result.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
    expect(result.messages[1].content[0].content).toBe("[Old tool result content cleared]");
    expect(result.messages[2].content[0].content).toBe("[Old tool result content cleared]");
    expect(result.messages[3].content[0].content).toBe("result-2");
    expect(result.messages[10].content[0].content).toBe("result-9");
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
