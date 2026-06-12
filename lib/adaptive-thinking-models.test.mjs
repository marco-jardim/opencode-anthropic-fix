import { describe, expect, test } from "vitest";

import { isAdaptiveThinkingModel, isFable5Model, isMythos5Model } from "../index.mjs";

describe("Claude 5 adaptive thinking model predicates", () => {
  test("isFable5Model matches version-anchored fable 5 model names", () => {
    expect(isFable5Model("claude-fable-5")).toBe(true);
    expect(isFable5Model("anthropic/claude-fable-5")).toBe(true);
  });

  test("isFable5Model rejects non-fable-5 model names", () => {
    expect(isFable5Model("claude-opus-4-8")).toBe(false);
    expect(isFable5Model("claude-haiku-4-5")).toBe(false);
    expect(isFable5Model("")).toBe(false);
  });

  test("isMythos5Model matches version-anchored mythos 5 model names", () => {
    expect(isMythos5Model("claude-mythos-5")).toBe(true);
  });

  test("isMythos5Model rejects non-mythos-5 model names", () => {
    expect(isMythos5Model("claude-opus-4-8")).toBe(false);
    expect(isMythos5Model("claude-haiku-4-5")).toBe(false);
    expect(isMythos5Model("")).toBe(false);
  });

  test("isAdaptiveThinkingModel includes fable 5 models", () => {
    expect(isAdaptiveThinkingModel("claude-fable-5")).toBe(true);
  });
});
