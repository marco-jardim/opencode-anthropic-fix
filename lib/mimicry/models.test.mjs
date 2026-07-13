import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_3_MODEL_RE,
  isAdaptiveThinkingModel,
  isFable5Model,
  isMythos5Model,
  isOpus46Model,
  isOpus47Model,
  isOpus48Model,
  isSonnet46Model,
  normalizeThinkingBlock,
} from "./models.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("model detection", () => {
  it("detects Claude 3 model IDs", () => {
    expect(CLAUDE_3_MODEL_RE.test("claude-3-5-sonnet-20241022")).toBe(true);
    expect(CLAUDE_3_MODEL_RE.test("claude-sonnet-4-6")).toBe(false);
  });

  it("detects Opus 4.6 model IDs", () => {
    expect(isOpus46Model("claude-opus-4-6-20260205")).toBe(true);
    expect(isOpus46Model("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4.6-v1")).toBe(true);
    expect(isOpus46Model("claude-opus-4-7")).toBe(false);
  });

  it("detects Opus 4.7 model IDs", () => {
    expect(isOpus47Model("claude-opus-4.7")).toBe(true);
    expect(isOpus47Model("opus_4_7-eap")).toBe(true);
    expect(isOpus47Model("claude-opus-4-8")).toBe(false);
  });

  it("detects Opus 4.8 model IDs", () => {
    expect(isOpus48Model("claude-opus-4-8")).toBe(true);
    expect(isOpus48Model("opus.4.8-fast")).toBe(true);
    expect(isOpus48Model("claude-opus-4-7")).toBe(false);
  });

  it("detects Sonnet 4.6 model IDs", () => {
    expect(isSonnet46Model("claude-sonnet-4-6")).toBe(true);
    expect(isSonnet46Model("sonnet.4.6")).toBe(true);
    expect(isSonnet46Model("claude-sonnet-4-5")).toBe(false);
  });

  it("detects Fable 5 model IDs", () => {
    expect(isFable5Model("claude-fable-5")).toBe(true);
    expect(isFable5Model("fable_5-preview")).toBe(true);
    expect(isFable5Model("claude-mythos-5")).toBe(false);
  });

  it("detects Mythos 5 model IDs", () => {
    expect(isMythos5Model("claude-mythos-5")).toBe(true);
    expect(isMythos5Model("mythos.5-preview")).toBe(true);
    expect(isMythos5Model("claude-fable-5")).toBe(false);
  });

  it.each([
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-fable-5",
    "claude-mythos-5",
  ])("recognizes %s as an adaptive-thinking model", (model) => {
    expect(isAdaptiveThinkingModel(model)).toBe(true);
  });

  it("rejects non-adaptive models", () => {
    expect(isAdaptiveThinkingModel("claude-sonnet-4-5")).toBe(false);
    expect(isAdaptiveThinkingModel(undefined)).toBe(false);
  });
});

describe("normalizeThinkingBlock", () => {
  it("passes absent and non-object values through", () => {
    expect(normalizeThinkingBlock(undefined, "claude-opus-4-8")).toBeUndefined();
    expect(normalizeThinkingBlock("enabled", "claude-opus-4-8")).toBe("enabled");
  });

  it("passes a non-adaptive model's block through unchanged", () => {
    const thinking = { type: "enabled", budget_tokens: 8000 };

    expect(normalizeThinkingBlock(thinking, "claude-sonnet-4-5")).toBe(thinking);
  });

  it("normalizes adaptive models to adaptive thinking", () => {
    expect(normalizeThinkingBlock({ type: "enabled", budget_tokens: 8000 }, "claude-opus-4-8")).toEqual({
      type: "adaptive",
    });
  });

  it("preserves an enabled block when adaptive thinking is disabled", () => {
    vi.stubEnv("OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING", "1");
    const thinking = { type: "enabled", budget_tokens: 12000 };

    expect(normalizeThinkingBlock(thinking, "claude-opus-4-8")).toBe(thinking);
  });

  it("uses the configured fallback budget when adaptive thinking is disabled", () => {
    vi.stubEnv("OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING", "true");
    vi.stubEnv("MAX_THINKING_TOKENS", "24000");

    expect(normalizeThinkingBlock({ type: "adaptive" }, "claude-sonnet-4-6")).toEqual({
      type: "enabled",
      budget_tokens: 24000,
    });
  });

  it("uses the default fallback budget when the configured value is invalid", () => {
    vi.stubEnv("OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING", "yes");
    vi.stubEnv("MAX_THINKING_TOKENS", "invalid");

    expect(normalizeThinkingBlock({}, "claude-fable-5")).toEqual({
      type: "enabled",
      budget_tokens: 16000,
    });
  });
});
