import { describe, expect, it } from "vitest";

import {
  CONTEXT_HINT_TOKEN_THRESHOLD,
  MEDIA_BLOCK_TOKENS,
  collectClearableToolUseIds,
  computeContextHintTokensSaved,
  estimateTextTokens,
  estimateToolResultTokens,
  isAlreadyCleared,
  shouldEmitContextHintBody,
} from "../../lib/mimicry/context-hint-threshold.mjs";

const assistantToolUses = (count = 6) =>
  Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    content: [{ type: "tool_use", id: `tool-${index + 1}`, name: "Read" }],
  }));

const transcriptWithFirstResult = (content, count = 6) => [
  ...assistantToolUses(count),
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool-1", content }],
  },
];

describe("genuine context-hint body threshold", () => {
  it("suppresses the body below the threshold", () => {
    expect(shouldEmitContextHintBody(transcriptWithFirstResult("x".repeat(79_996)))).toBe(false);
  });

  it("emits the body at exactly 20,000 estimated tokens", () => {
    const messages = transcriptWithFirstResult("x".repeat(80_000));

    expect(computeContextHintTokensSaved(messages)).toBe(CONTEXT_HINT_TOKEN_THRESHOLD);
    expect(shouldEmitContextHintBody(messages)).toBe(true);
  });

  it("emits the body above the threshold", () => {
    expect(shouldEmitContextHintBody(transcriptWithFirstResult("x".repeat(80_004)))).toBe(true);
  });

  it("never counts the last five tool-result groups", () => {
    const messages = [
      ...assistantToolUses(),
      {
        role: "user",
        content: Array.from({ length: 5 }, (_, index) => ({
          type: "tool_result",
          tool_use_id: `tool-${index + 2}`,
          content: "x".repeat(100_000),
        })),
      },
    ];

    expect(computeContextHintTokensSaved(messages)).toBe(0);
  });

  it("counts nothing when fewer than six tool_use ids exist", () => {
    expect(computeContextHintTokensSaved(transcriptWithFirstResult("x".repeat(100_000), 5))).toBe(0);
  });

  it("ignores already-cleared and persisted string results", () => {
    expect(isAlreadyCleared("[Old tool result content cleared]")).toBe(true);
    expect(isAlreadyCleared("<persisted-output>artifact-1")).toBe(true);
    expect(computeContextHintTokensSaved(transcriptWithFirstResult("[Old tool result content cleared]"))).toBe(0);
    expect(computeContextHintTokensSaved(transcriptWithFirstResult("<persisted-output>artifact-1"))).toBe(0);
  });

  it("sums array text with Math.round and charges exactly 2,000 per media block", () => {
    const content = [
      { type: "text", text: "x".repeat(4_001) },
      { type: "image", source: {} },
      { type: "document", source: {} },
      { type: "other", value: "ignored" },
    ];

    expect(estimateTextTokens("x".repeat(4_001))).toBe(1_000);
    expect(estimateTextTokens("x".repeat(4_001))).not.toBe(Math.ceil(4_001 / 4));
    expect(estimateToolResultTokens({ content })).toBe(1_000 + MEDIA_BLOCK_TOKENS * 2);
  });

  it("returns zero for non-string, non-array content", () => {
    expect(estimateToolResultTokens({ content: { type: "text", text: "ignored" } })).toBe(0);
    expect(estimateToolResultTokens({})).toBe(0);
  });

  it("collects wire assistant tool_use ids in transcript order", () => {
    const messages = [
      { type: "assistant", content: [{ type: "tool_use", id: "internal", name: "Read" }] },
      ...assistantToolUses(2),
    ];

    expect(collectClearableToolUseIds(messages)).toEqual(["tool-1", "tool-2"]);
  });
});
