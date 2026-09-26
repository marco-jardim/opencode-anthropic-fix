import { describe, expect, it } from "vitest";
import {
  buildSystemPromptBlocks,
  compactToolDescription,
  dedupeSystemBlocks,
  getCacheControlForScope,
  isSimpleSystemPromptEligible,
  isTitleGeneratorSystemBlocks,
  sanitizeSystemText,
  tailSystemBlock,
} from "./system-prompt.mjs";

// A grinning-face emoji: one grapheme cluster, 2 UTF-16 units (surrogate pair).
const GRIN = "😀";

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

describe("compactToolDescription — grapheme-safe bullet truncation (U1)", () => {
  it("preserves ASCII output byte-for-byte versus the legacy slice(0, 200) + '...' behavior", () => {
    const bullet = "- " + "a".repeat(300);
    const text = `Intro line.\n${bullet}\nOutro line.`;

    const legacyLine = bullet.slice(0, 200) + "...";
    const result = compactToolDescription(text);
    const resultLine = result.split("\n").find((l) => l.startsWith("- "));

    expect(resultLine).toBe(legacyLine);
    expect(resultLine.length).toBe(203);
  });

  it("excludes an emoji straddling the 200-unit cut whole, instead of splitting its surrogate pair", () => {
    // Bullet marker "- " (2 units) + 197 'a's + GRIN (2 units) + 1 trailing
    // 'a' = 200 content units (satisfies the >=200 regex gate), 202 total
    // line units. The emoji's high surrogate lands at absolute index 199 and
    // its low surrogate at 200 — exactly the shape a bare slice(0, 200)
    // would cut in half.
    const bullet = "- " + "a".repeat(197) + GRIN + "a";
    expect(bullet.length).toBe(202);
    const text = `Intro line.\n${bullet}\nOutro line.`;

    // Negative control: this is what the OLD implementation produced.
    const legacyLine = bullet.slice(0, 200) + "...";
    expect(legacyLine.isWellFormed()).toBe(false);

    const result = compactToolDescription(text);
    const resultLine = result.split("\n").find((l) => l.startsWith("- "));

    expect(resultLine.isWellFormed()).toBe(true);
    expect(resultLine).toBe("- " + "a".repeat(197) + "...");
    expect(resultLine).not.toBe(legacyLine);
    expect(result).toContain("Intro line.");
    expect(result).toContain("Outro line.");
  });

  it("keeps an emoji that fits entirely within the budget intact", () => {
    // Every matched bullet line has at least 202 units (200-char content
    // minimum + the 2-unit marker), so the 200-unit cut always removes some
    // tail. Placing the emoji early and padding the tail with plain 'a's
    // means the cut lands inside the ASCII padding, well past the emoji.
    const bullet = "- " + GRIN + "a".repeat(300);
    const text = `Intro.\n${bullet}\nOutro.`;
    const result = compactToolDescription(text);
    const resultLine = result.split("\n").find((l) => l.startsWith("- "));

    expect(resultLine.isWellFormed()).toBe(true);
    expect(resultLine).toBe("- " + GRIN + "a".repeat(196) + "...");
    expect(resultLine.length).toBe(203);
  });

  it("never emits a lone surrogate for any emoji position around the boundary (199/200/201)", () => {
    for (const padding of [196, 197, 198]) {
      const bullet = "- " + "a".repeat(padding) + GRIN + "a".repeat(200 - padding - 2);
      const text = `Intro.\n${bullet}\nOutro.`;
      const result = compactToolDescription(text);
      const resultLine = result.split("\n").find((l) => l.startsWith("- "));
      expect(resultLine.isWellFormed()).toBe(true);
      expect(resultLine.length).toBeLessThanOrEqual(203);
    }
  });

  it("leaves short text without a >=200-char bullet untouched", () => {
    const short = "Runs the given bash command in a shell.";
    expect(compactToolDescription(short)).toBe(short);
  });
});
