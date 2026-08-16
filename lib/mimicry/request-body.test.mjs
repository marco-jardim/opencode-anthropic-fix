import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_TOOL_NAMES, normalizeThinkingBlock, transformRequestBody } from "./request-body.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("request body mimicry", () => {
  it("exports core tools and renames opencode tool names", () => {
    expect(CORE_TOOL_NAMES).toBeInstanceOf(Set);
    expect(CORE_TOOL_NAMES.has("Bash")).toBe(true);
    expect(CORE_TOOL_NAMES.has("Read")).toBe(true);
    expect(CORE_TOOL_NAMES.has("Task")).toBe(true);

    const body = {
      model: "claude-opus-4-1",
      max_tokens: 8000,
      system: [{ type: "text", text: "You are opencode" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
    };
    const signature = { enabled: false };
    const runtime = {
      turns: 1,
      usedTools: new Set(),
      tokenEconomySession: null,
      cacheBoundaryStability: new Map(),
      persistentUserId: "d",
      accountId: "a",
      sessionId: "s",
    };

    const result = transformRequestBody(JSON.stringify(body), signature, runtime, "oauth-2025-04-20", {});

    expect(typeof result).toBe("string");
    expect(JSON.parse(result).tools[0].name).toBe("Bash");
  });
});
