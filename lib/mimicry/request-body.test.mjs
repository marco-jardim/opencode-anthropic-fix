import { describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES, transformRequestBody } from "./request-body.mjs";

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
