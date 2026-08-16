import { describe, expect, it } from "vitest";
import {
  buildSystemPromptBlocks,
  dedupeSystemBlocks,
  getCacheControlForScope,
  isSimpleSystemPromptEligible,
  isTitleGeneratorSystemBlocks,
  sanitizeSystemText,
  tailSystemBlock,
} from "./system-prompt.mjs";

describe("system prompt host policy", () => {
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
        promptCompactionMode: "off",
      }),
    ).toEqual([{ type: "text", text: "Claude Code assistant", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("uses the Claude Code 2.1.195 anti-verbosity heading", () => {
    const blocks = buildSystemPromptBlocks([{ type: "text", text: "Base prompt" }], {
      promptCompactionMode: "off",
      modelId: "claude-opus-4-6",
      antiVerbosity: { enabled: true },
    });

    // The host blocks are joined onto ONE cache breakpoint before the package
    // sees them, so the anti-verbosity text lands inside the joined block.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.startsWith("Base prompt\n# Text output (does not apply to tool calls)\n")).toBe(true);
  });

  it("never injects the non-native numeric length anchors prompt", () => {
    const blocks = buildSystemPromptBlocks([{ type: "text", text: "Base prompt" }], {
      promptCompactionMode: "off",
      modelId: "claude-opus-4-6",
      antiVerbosity: { enabled: true },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toMatch(/numeric length anchor/i);
  });

  it("places the host cache breakpoint with the resolved ttl", () => {
    const blocks = buildSystemPromptBlocks([{ type: "text", text: "Base prompt" }], {
      promptCompactionMode: "off",
      cachePolicy: { ttl: "5m", ttl_supported: true },
    });

    expect(blocks).toEqual([{ type: "text", text: "Base prompt", cache_control: { type: "ephemeral", ttl: "5m" } }]);
  });

  it("splits static and dynamic halves when the boundary marker is enabled", () => {
    const blocks = buildSystemPromptBlocks(
      [
        { type: "text", text: "Static half" },
        { type: "text", text: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" },
        { type: "text", text: "Dynamic half" },
      ],
      {
        promptCompactionMode: "off",
        cachePolicy: { ttl: "1h", ttl_supported: true, boundary_marker: true },
      },
    );

    expect(blocks).toEqual([
      { type: "text", text: "Static half", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } },
      { type: "text", text: "Dynamic half" },
    ]);
  });

  it("does not treat a trailing -eap- segment as simple-system-prompt eligible", () => {
    expect(isSimpleSystemPromptEligible("claude-sonnet-4-6-eap-preview")).toBe(false);
    expect(isSimpleSystemPromptEligible("claude-sonnet-4-6-eap")).toBe(true);
    expect(isSimpleSystemPromptEligible("claude-sonnet-4-6-eap[1m]")).toBe(true);
  });
});
