import { describe, expect, it } from "vitest";
import {
  buildSystemPromptBlocks,
  dedupeSystemBlocks,
  getCacheControlForScope,
  getCachedCCPrompt,
  isTitleGeneratorSystemBlocks,
  resetCachedCCPrompt,
  sanitizeSystemText,
  tailSystemBlock,
} from "./system-prompt.mjs";

describe("system prompt mimicry", () => {
  it("sanitizes OpenCode branding with the existing case rules", () => {
    expect(sanitizeSystemText("OpenCode opencode openCode opencode_helper")).toBe(
      "Claude Code Claude Claude opencode_helper",
    );
  });

  it("removes duplicate normalized text blocks", () => {
    const first = { type: "text", text: "First line\nSecond line" };
    const duplicate = { type: "text", text: " First line \r\n Second line " };
    const unique = { type: "text", text: "Unique" };

    expect(dedupeSystemBlocks([first, duplicate, unique])).toEqual([first, unique]);
  });

  it("tails a system block while retaining key constraints", () => {
    expect(tailSystemBlock("Identity\n\ndiscard this\n# Keep\nMUST remain", 200, 3)).toBe(
      "Identity\n\n# Keep\nMUST remain\n\n[Verbose instructions trimmed after turn 3. Key constraints preserved above.]",
    );
  });

  it("detects title-generator system blocks", () => {
    expect(isTitleGeneratorSystemBlocks([{ type: "text", text: "You are a title generator." }])).toBe(true);
    expect(isTitleGeneratorSystemBlocks([{ type: "text", text: "You are a coding assistant." }])).toBe(false);
  });

  it("builds cache-control wire shapes for each scope", () => {
    const policy = { ttl: "1h", ttl_supported: true };

    expect(getCacheControlForScope("global", policy)).toEqual({ type: "ephemeral", ttl: "1h", scope: "global" });
    expect(getCacheControlForScope("org", policy)).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(getCacheControlForScope(null, policy)).toBeNull();
    expect(getCacheControlForScope("org", { ttl: "off", ttl_supported: true })).toEqual({ type: "ephemeral" });
  });

  it("builds system prompt blocks from a minimal prompt and signature", () => {
    expect(
      buildSystemPromptBlocks([{ type: "text", text: "OpenCode assistant" }], {
        enabled: false,
        claudeCliVersion: "2.1.0",
        promptCompactionMode: "off",
      }),
    ).toEqual([{ type: "text", text: "Claude Code assistant" }]);
  });

  it("exposes cache reset and round-trip helpers", () => {
    resetCachedCCPrompt();
    expect(getCachedCCPrompt()).toBeNull();

    buildSystemPromptBlocks([{ type: "text", text: "You are an interactive assistant." }], {
      enabled: true,
      claudeCliVersion: "2.1.0",
      promptCompactionMode: "off",
      cachePolicy: { ttl: "1h", ttl_supported: true },
    });

    expect(getCachedCCPrompt()).toBe("You are an interactive assistant.");
    resetCachedCCPrompt();
    expect(getCachedCCPrompt()).toBeNull();
  });
});
