import { describe, it, expect } from "vitest";
import { AnthropicAuthPlugin } from "../../index.mjs";

const { compactToolDescription, stripMcpPrefixFromParsedEvent, CORE_TOOL_NAMES } = AnthropicAuthPlugin.__testing__;

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers — re-implemented from index.mjs so each strategy can be tested
// as a pure function without spinning up the full plugin fetch interceptor.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * S1 helper: strip all existing cache_control from tools and set the canonical
 * ephemeral breakpoint on the last tool.  Mirrors lines 6940-6950 of index.mjs.
 * @param {Array<object>} tools - mutated in place
 * @param {string} [ttl="1h"]
 */
function applyToolCacheControl(tools, ttl = "1h") {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  for (const tool of tools) {
    delete tool.cache_control;
  }
  tools[tools.length - 1].cache_control = { type: "ephemeral", ttl };
  return tools;
}

/**
 * S2 helper: defer non-core tools with defer_loading: true.
 * Mirrors lines 7057-7069 of index.mjs.
 * @param {Array<object>} tools - mutated in place
 * @param {string} model
 * @param {{toolDeferral?: boolean}} [opts]
 */
function applyMcpDeferral(tools, model, opts = {}) {
  if (opts.toolDeferral === false) return tools;
  if (!model || /claude-3-|haiku/i.test(model)) return tools;
  // S2 uses OC_TO_CC_TOOL_NAMES values; CORE_TOOL_NAMES contains the same set.
  for (const tool of tools) {
    if (tool.name && !CORE_TOOL_NAMES.has(tool.name)) {
      tool.defer_loading = true;
    }
  }
  return tools;
}

/**
 * S4 helper: after turn 3 defer non-core tools not yet used by the model.
 * Mirrors lines 7025-7038 of index.mjs.
 * @param {Array<object>} tools - mutated in place
 * @param {string} model
 * @param {number} turns
 * @param {Set<string>} usedTools
 * @param {{adaptiveToolSet?: boolean}} [opts]
 */
function applyAdaptiveToolSet(tools, model, turns, usedTools, opts = {}) {
  if (opts.adaptiveToolSet === false) return tools;
  if (turns < 3) return tools;
  if (!model || /claude-3-|haiku/i.test(model)) return tools;
  for (const tool of tools) {
    if (tool.name && !usedTools.has(tool.name) && !CORE_TOOL_NAMES.has(tool.name)) {
      tool.defer_loading = true;
    }
  }
  return tools;
}

/**
 * S4 tracking helper: scan messages for assistant tool_use blocks and record
 * the tool names in usedTools.  Mirrors lines 7010-7020 of index.mjs.
 * @param {Array<{role: string, content: Array<object>}>} messages
 * @param {Set<string>} usedTools
 */
function trackUsedTools(messages, usedTools) {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.name) {
          usedTools.add(block.name);
        }
      }
    }
  }
}

/**
 * S5 helper: after `threshold` turns, truncate large system-prompt blocks.
 * Mirrors lines 6879-6892 of index.mjs.  Returns a shallow-copied array so
 * that tests can compare before/after without mutating the input.
 * @param {Array<{type: string, text: string}>} systemBlocks
 * @param {number} turns
 * @param {{systemPromptTailing?: boolean, systemPromptTailTurns?: number, systemPromptTailMaxChars?: number}} [opts]
 */
function applySystemPromptTailing(systemBlocks, turns, opts = {}) {
  const threshold = opts.systemPromptTailTurns ?? 6;
  if (opts.systemPromptTailing === false) return systemBlocks;
  if (turns < threshold) return systemBlocks;
  const maxChars = opts.systemPromptTailMaxChars ?? 2000;
  const result = systemBlocks.map((b) => ({ ...b }));
  for (const block of result) {
    if (block.type === "text" && block.text && block.text.length > maxChars * 2) {
      block.text =
        block.text.slice(0, maxChars) +
        "\n\n[System instructions truncated after turn " +
        threshold +
        " for token efficiency. Full instructions were provided in earlier turns.]";
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────────────────────

describe("Task 3.6: Token Economy Strategies", () => {
  // ───────────────────────────────────────────────────────────────────────────
  describe("S1: Tool cache_control", () => {
    it("S1.1: empty tools array is returned unchanged (no crash)", () => {
      const result = applyToolCacheControl([]);
      expect(result).toEqual([]);
    });

    it("S1.2: single tool receives cache_control on the only (last) slot", () => {
      const tools = [{ name: "Bash", description: "runs commands" }];
      applyToolCacheControl(tools);
      expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("S1.3: with three tools only the last one gets cache_control", () => {
      const tools = [{ name: "Bash" }, { name: "Read" }, { name: "TodoWrite" }];
      applyToolCacheControl(tools);
      expect(tools[0].cache_control).toBeUndefined();
      expect(tools[1].cache_control).toBeUndefined();
      expect(tools[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("S1.4: existing cache_control on earlier tools is stripped", () => {
      const tools = [
        { name: "Bash", cache_control: { type: "ephemeral", ttl: "5m" } },
        { name: "Read", cache_control: { type: "ephemeral", ttl: "5m" } },
        { name: "TodoWrite" },
      ];
      applyToolCacheControl(tools);
      expect(tools[0].cache_control).toBeUndefined();
      expect(tools[1].cache_control).toBeUndefined();
      expect(tools[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("S1.5: cache_control on the last tool itself is replaced by the canonical value", () => {
      const tools = [{ name: "Bash", cache_control: { type: "ephemeral", ttl: "5m" } }];
      applyToolCacheControl(tools);
      expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("S2: MCP tool deferral", () => {
    it("S2.1: CORE_TOOL_NAMES contains the expected CC PascalCase names", () => {
      expect(CORE_TOOL_NAMES.has("Bash")).toBe(true);
      expect(CORE_TOOL_NAMES.has("Read")).toBe(true);
      expect(CORE_TOOL_NAMES.has("TodoWrite")).toBe(true);
      expect(CORE_TOOL_NAMES.has("Skill")).toBe(true);
      expect(CORE_TOOL_NAMES.has("Task")).toBe(true);
      expect(CORE_TOOL_NAMES.has("chrome-devtools_click")).toBe(false);
    });

    it("S2.2: core tool Bash is NOT deferred", () => {
      const tools = [{ name: "Bash" }];
      applyMcpDeferral(tools, "claude-sonnet-4-5");
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S2.3: core tool Read is NOT deferred", () => {
      const tools = [{ name: "Read" }];
      applyMcpDeferral(tools, "claude-sonnet-4-5");
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S2.4: non-core MCP tool gets defer_loading: true", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyMcpDeferral(tools, "claude-sonnet-4-5");
      expect(tools[0].defer_loading).toBe(true);
    });

    it("S2.5: haiku model skips MCP deferral entirely", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyMcpDeferral(tools, "claude-haiku-4-5");
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S2.6: claude-3- model skips MCP deferral", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyMcpDeferral(tools, "claude-3-5-sonnet-20241022");
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S2.7: toolDeferral: false option suppresses deferral", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyMcpDeferral(tools, "claude-sonnet-4-5", { toolDeferral: false });
      expect(tools[0].defer_loading).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("S3: Tool description compaction", () => {
    it("S3.1: strips <example>...</example> blocks (case-insensitive, multiline)", () => {
      const text = "Before the example.\n<example>\nsome example\ncode here\n</example>\nAfter the example.";
      const result = compactToolDescription(text);
      expect(result).not.toContain("<example>");
      expect(result).not.toContain("</example>");
      expect(result).toContain("Before the example.");
      expect(result).toContain("After the example.");
    });

    it("S3.2: strips markdown table rows (pipe-delimited lines)", () => {
      const text = "Intro.\n| Column 1 | Column 2 |\n| --- | --- |\n| value 1 | value 2 |\nOutro.";
      const result = compactToolDescription(text);
      expect(result).not.toContain("| Column 1 |");
      expect(result).not.toContain("| value 1 |");
      expect(result).toContain("Intro.");
      expect(result).toContain("Outro.");
    });

    it("S3.3: strips heading prefixes # ## ### but keeps the heading text", () => {
      const text = "# Main Title\n## Section A\n### Subsection B\nNormal paragraph.";
      const result = compactToolDescription(text);
      expect(result).not.toMatch(/^# /m);
      expect(result).not.toMatch(/^## /m);
      expect(result).not.toMatch(/^### /m);
      expect(result).toContain("Main Title");
      expect(result).toContain("Section A");
      expect(result).toContain("Subsection B");
      expect(result).toContain("Normal paragraph.");
    });

    it("S3.4: strips bold **markers** leaving only the inner text", () => {
      const result = compactToolDescription("Use **bold text** to highlight **key ideas**.");
      expect(result).not.toContain("**");
      expect(result).toContain("bold text");
      expect(result).toContain("key ideas");
    });

    it("S3.5: strips backtick inline-code markers leaving only the inner text", () => {
      const result = compactToolDescription("Run `npm install` then `npm test` to verify.");
      expect(result).not.toContain("`");
      expect(result).toContain("npm install");
      expect(result).toContain("npm test");
    });

    it("S3.6: list items longer than 200 chars are truncated with '...'", () => {
      const longItem = "- " + "a".repeat(250);
      const text = `First line.\n${longItem}\nLast line.`;
      const result = compactToolDescription(text);
      expect(result).toContain("...");
      const bullet = result.split("\n").find((l) => l.startsWith("- "));
      expect(bullet).toBeDefined();
      expect(bullet.length).toBeLessThan(longItem.length);
    });

    it("S3.7: three or more consecutive newlines collapse to two", () => {
      const text = "Paragraph one.\n\n\n\nParagraph two.\n\n\n\n\nParagraph three.";
      const result = compactToolDescription(text);
      expect(result).not.toMatch(/\n{3}/);
      expect(result).toContain("Paragraph one.");
      expect(result).toContain("Paragraph two.");
      expect(result).toContain("Paragraph three.");
    });

    it("S3.8: leading and trailing whitespace is trimmed from the result", () => {
      const result = compactToolDescription("\n\n   content here   \n\n");
      expect(result).toBe("content here");
    });

    it("S3.9: short text with no compactable patterns is returned unchanged (after trim)", () => {
      // The 500-char length gate lives in the caller (transformRequestBody), not here.
      // The function itself always applies all transforms; a pattern-free string is a no-op.
      const short = "Runs the given bash command in a shell.";
      expect(compactToolDescription(short)).toBe(short);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("S4: Adaptive tool set", () => {
    it("S4.1: turn 1 — no tools deferred regardless of name", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyAdaptiveToolSet(tools, "claude-sonnet-4-5", 1, new Set());
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S4.2: turn 2 — no tools deferred (threshold is turn 3)", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyAdaptiveToolSet(tools, "claude-sonnet-4-5", 2, new Set());
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S4.3: turn 3 — unused non-core tool is deferred", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyAdaptiveToolSet(tools, "claude-sonnet-4-5", 3, new Set());
      expect(tools[0].defer_loading).toBe(true);
    });

    it("S4.4: turn 3 — previously used non-core tool is NOT deferred", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      const used = new Set(["chrome-devtools_click"]);
      applyAdaptiveToolSet(tools, "claude-sonnet-4-5", 3, used);
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S4.5: core tool (Bash) is never deferred regardless of turn count or usage", () => {
      const tools = [{ name: "Bash" }];
      applyAdaptiveToolSet(tools, "claude-sonnet-4-5", 10, new Set());
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S4.6: haiku model skips adaptive deferral at any turn", () => {
      const tools = [{ name: "chrome-devtools_click" }];
      applyAdaptiveToolSet(tools, "claude-haiku-4-5", 10, new Set());
      expect(tools[0].defer_loading).toBeUndefined();
    });

    it("S4.7: assistant tool_use blocks populate usedTools; user messages do not", () => {
      const usedTools = new Set();
      trackUsedTools(
        [
          {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Bash" },
              { type: "tool_use", name: "chrome-devtools_click" },
            ],
          },
          {
            // user messages must be ignored
            role: "user",
            content: [{ type: "tool_use", name: "Read" }],
          },
        ],
        usedTools,
      );
      expect(usedTools.has("Bash")).toBe(true);
      expect(usedTools.has("chrome-devtools_click")).toBe(true);
      expect(usedTools.has("Read")).toBe(false);
    });

    it("S4.8: tool names are accumulated across multiple assistant turns", () => {
      const usedTools = new Set();
      trackUsedTools(
        [
          { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
          { role: "user", content: [{ type: "text", text: "ok" }] },
          { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
          { role: "user", content: [{ type: "text", text: "done" }] },
          { role: "assistant", content: [{ type: "tool_use", name: "chrome-devtools_click" }] },
        ],
        usedTools,
      );
      expect(usedTools.size).toBe(3);
      expect(usedTools.has("Bash")).toBe(true);
      expect(usedTools.has("Read")).toBe(true);
      expect(usedTools.has("chrome-devtools_click")).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("S5: System prompt tailing", () => {
    const makeBlock = (len) => ({ type: "text", text: "A".repeat(len) });

    it("S5.1: block under 4000 chars at turn 6 is NOT truncated", () => {
      // Condition is length > maxChars*2 = 4000; 3999 does not satisfy it.
      const result = applySystemPromptTailing([makeBlock(3999)], 6);
      expect(result[0].text.length).toBe(3999);
      expect(result[0].text).not.toContain("truncated");
    });

    it("S5.2: block over 4000 chars at turn 1 is NOT truncated (below threshold)", () => {
      const result = applySystemPromptTailing([makeBlock(4001)], 1);
      expect(result[0].text.length).toBe(4001);
    });

    it("S5.3: block over 4000 chars at turn 5 is NOT truncated (threshold is 6)", () => {
      const result = applySystemPromptTailing([makeBlock(4001)], 5);
      expect(result[0].text.length).toBe(4001);
    });

    it("S5.4: block over 4000 chars at turn 6 IS truncated to ~2000 chars", () => {
      const result = applySystemPromptTailing([makeBlock(8000)], 6);
      expect(result[0].text.length).toBeLessThan(8000);
      // First 2000 characters preserved exactly
      expect(result[0].text.slice(0, 2000)).toBe("A".repeat(2000));
      expect(result[0].text).toContain("truncated");
    });

    it("S5.5: truncation note includes the turn threshold number", () => {
      const result = applySystemPromptTailing([makeBlock(5000)], 6);
      expect(result[0].text).toContain("turn 6");
      expect(result[0].text).toContain("token efficiency");
    });

    it("S5.6: custom systemPromptTailTurns threshold is respected", () => {
      const longBlock = makeBlock(5000);
      // custom threshold=3 → truncated at turn 3
      const truncated = applySystemPromptTailing([longBlock], 3, {
        systemPromptTailTurns: 3,
      });
      expect(truncated[0].text).toContain("truncated");
      expect(truncated[0].text).toContain("turn 3");

      // default threshold=6 → turn 3 does NOT truncate
      const intact = applySystemPromptTailing([makeBlock(5000)], 3);
      expect(intact[0].text).not.toContain("truncated");
    });

    it("S5.7: systemPromptTailing: false disables truncation at any turn count", () => {
      const result = applySystemPromptTailing([makeBlock(9000)], 20, {
        systemPromptTailing: false,
      });
      expect(result[0].text.length).toBe(9000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("S6: tool_reference stream handling", () => {
    it("S6.1: content_block tool_use — CC PascalCase name is reverse-mapped to OC lowercase", () => {
      const event = { content_block: { type: "tool_use", name: "Bash" } };
      const modified = stripMcpPrefixFromParsedEvent(event);
      expect(modified).toBe(true);
      expect(event.content_block.name).toBe("bash");
    });

    it("S6.2: content_block tool_use — mcp_ prefix is stripped", () => {
      const event = {
        content_block: { type: "tool_use", name: "mcp_chrome-devtools_click" },
      };
      const modified = stripMcpPrefixFromParsedEvent(event);
      expect(modified).toBe(true);
      expect(event.content_block.name).toBe("chrome-devtools_click");
    });

    it("S6.3: message.content tool_use — CC name is reverse-mapped", () => {
      const event = {
        message: { content: [{ type: "tool_use", name: "TodoWrite" }] },
      };
      const modified = stripMcpPrefixFromParsedEvent(event);
      expect(modified).toBe(true);
      expect(event.message.content[0].name).toBe("todowrite");
    });

    it("S6.4: top-level content array tool_use — mcp_ prefix stripped; non-tool blocks untouched", () => {
      const event = {
        content: [
          { type: "tool_use", name: "mcp_github_create_issue" },
          { type: "text", text: "some prose" },
        ],
      };
      stripMcpPrefixFromParsedEvent(event);
      expect(event.content[0].name).toBe("github_create_issue");
      expect(event.content[1].text).toBe("some prose");
    });

    it("S6.5: non-tool_use content_block type is not modified; returns false", () => {
      const event = { content_block: { type: "text", text: "hello world" } };
      const modified = stripMcpPrefixFromParsedEvent(event);
      expect(modified).toBe(false);
      expect(event.content_block.text).toBe("hello world");
    });

    it("S6.6: null / undefined input returns false without throwing", () => {
      expect(stripMcpPrefixFromParsedEvent(null)).toBe(false);
      expect(stripMcpPrefixFromParsedEvent(undefined)).toBe(false);
    });

    it("S6.7: already-lowercase unmapped name is a no-op and returns false", () => {
      // "bash" has no CC→OC mapping and no mcp_ prefix → reverseMapToolName returns it unchanged.
      const event = { content_block: { type: "tool_use", name: "bash" } };
      const modified = stripMcpPrefixFromParsedEvent(event);
      expect(modified).toBe(false);
      expect(event.content_block.name).toBe("bash");
    });
  });
});
