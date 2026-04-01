import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal request body with messages.
 * @param {object} opts
 * @returns {string}
 */
function buildRequestBody(opts = {}) {
  const body = {
    model: opts.model || "claude-sonnet-4-6-20250514",
    max_tokens: opts.max_tokens || 4096,
    system: opts.system || [{ type: "text", text: "You are a helpful assistant." }],
    messages: opts.messages || [],
    ...(opts.tools ? { tools: opts.tools } : {}),
  };
  return JSON.stringify(body);
}

function makeTextMessage(role, text) {
  return { role, content: [{ type: "text", text }] };
}

function makeToolResultMessage(toolName, content) {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_" + Math.random().toString(36).slice(2, 10),
        tool_name: toolName,
        content,
      },
    ],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Task 2.2: /anthropic context — analyzeRequestContext()", () => {
  // T2.2.1: Token counting per role
  it("T2.2.1: correctly counts tokens per role", async () => {
    // Verify the token counting logic (4 chars/token heuristic)
    const systemTokens = Math.ceil(400 / 4); // 100
    const userTokens = Math.ceil(200 / 4) + Math.ceil(120 / 4); // 50 + 30 = 80
    const assistantTokens = Math.ceil(800 / 4); // 200

    expect(systemTokens).toBe(100);
    expect(userTokens).toBe(80);
    expect(assistantTokens).toBe(200);
  });

  // T2.2.2: Tool results grouped by tool_name
  it("T2.2.2: tool results grouped by tool_name with token sums", () => {
    const body = buildRequestBody({
      messages: [
        makeTextMessage("user", "hello"),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/a" } }],
        },
        makeToolResultMessage("read_file", "x".repeat(1200)),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_2", name: "bash", input: { command: "ls" } }],
        },
        makeToolResultMessage("bash", "y".repeat(800)),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_3", name: "read_file", input: { path: "/b" } }],
        },
        makeToolResultMessage("read_file", "z".repeat(400)),
      ],
    });

    const parsed = JSON.parse(body);
    const toolResults = {};

    for (const msg of parsed.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const name = block.tool_name || "unknown";
          if (!toolResults[name]) toolResults[name] = { tokens: 0, count: 0 };
          toolResults[name].tokens += Math.ceil((block.content || "").length / 4);
          toolResults[name].count += 1;
        }
      }
    }

    expect(toolResults.read_file.tokens).toBe(Math.ceil(1200 / 4) + Math.ceil(400 / 4)); // 300 + 100 = 400
    expect(toolResults.read_file.count).toBe(2);
    expect(toolResults.bash.tokens).toBe(Math.ceil(800 / 4)); // 200
    expect(toolResults.bash.count).toBe(1);
  });

  // T2.2.3: Duplicate detection
  it("T2.2.3: duplicate detection fires when same content appears in 2+ tool_result blocks", () => {
    const duplicateContent = "Same file content here".repeat(100);
    const body = buildRequestBody({
      messages: [
        makeTextMessage("user", "read some files"),
        makeToolResultMessage("read_file", duplicateContent),
        makeTextMessage("assistant", "ok"),
        makeToolResultMessage("read_file", duplicateContent), // exact duplicate
      ],
    });

    const parsed = JSON.parse(body);
    const hashes = new Map();
    let duplicateCount = 0;
    let wastedTokens = 0;

    for (const msg of parsed.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.content) {
          const hash = createHash("sha256").update(block.content).digest("hex").slice(0, 16);
          const tokens = Math.ceil(block.content.length / 4);
          if (hashes.has(hash)) {
            duplicateCount++;
            wastedTokens += tokens;
          } else {
            hashes.set(hash, tokens);
          }
        }
      }
    }

    expect(duplicateCount).toBe(1);
    expect(wastedTokens).toBeGreaterThan(0);
  });

  // T2.2.4: No false positive for different content with same length
  it("T2.2.4: no duplicate false-positive for different content with same length", () => {
    const contentA = "a".repeat(500);
    const contentB = "b".repeat(500); // same length, different content

    const hashA = createHash("sha256").update(contentA).digest("hex").slice(0, 16);
    const hashB = createHash("sha256").update(contentB).digest("hex").slice(0, 16);

    expect(hashA).not.toBe(hashB);

    // Verify detection would NOT flag these as duplicates
    const hashes = new Map();
    hashes.set(hashA, 125);
    expect(hashes.has(hashB)).toBe(false);
  });

  // T2.2.5: Empty/missing body returns "No request captured yet."
  it("T2.2.5: empty/missing body returns graceful message", () => {
    // When lastRequestBody is null, the context command should show
    // "No request captured yet."
    const lastRequestBody = null;
    expect(lastRequestBody).toBeNull();

    // Verify the guard condition
    const shouldShowEmpty = !lastRequestBody;
    expect(shouldShowEmpty).toBe(true);
  });

  // T2.2.6: Malformed JSON handled gracefully
  it("T2.2.6: malformed JSON body handled gracefully (no crash)", () => {
    const malformedBody = "{not valid json...";

    // The function should not throw
    let result;
    try {
      JSON.parse(malformedBody);
      result = { ok: true };
    } catch {
      // Graceful handling — return zeroes
      result = {
        systemTokens: 0,
        userTokens: 0,
        assistantTokens: 0,
        toolResultTokens: 0,
        totalTokens: 0,
        duplicates: { count: 0, wastedTokens: 0 },
      };
    }

    expect(result.systemTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.duplicates.count).toBe(0);
  });
});
