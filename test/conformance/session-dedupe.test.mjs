/**
 * Phase C Task C3: Session-wide tool-result dedupe conformance tests.
 *
 * `applySessionToolResultDedupe(messages)` — pure over message history.
 * Replaces earlier reproducible-tool (Read/Grep/Glob/LS) results with stub
 * strings pointing at the latest identical-args call. Default OFF.
 *
 * Each test case corresponds to an acceptance criterion from the C3 task
 * spec (see docs/plans/2026-04-18-phase-c-cc-parity.md).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { AnthropicAuthPlugin } from "../../index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INDEX_PATH = resolve(__dirname, "../../index.mjs");

const { applySessionToolResultDedupe } = AnthropicAuthPlugin.__testing__;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a simple [assistant tool_use] + [user tool_result] pair. */
function pair(toolUseId, name, input, resultText) {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: resultText,
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applySessionToolResultDedupe", () => {
  it("(1) basic dedupe: 3 identical Read calls → first 2 stubbed, 3rd verbatim", () => {
    const messages = [
      ...pair("tu_1", "Read", { path: "/a" }, "FIRST CONTENT"),
      ...pair("tu_2", "Read", { path: "/a" }, "SECOND CONTENT"),
      ...pair("tu_3", "Read", { path: "/a" }, "THIRD CONTENT"),
    ];
    // Latest result lives at index 5 (pair 3's user message).
    const out = applySessionToolResultDedupe(messages);
    expect(out.changed).toBe(true);
    expect(out.stats.deduped).toBe(2);

    const expectedStub = `[Read of {"path":"/a"} superseded by later read at msg #5]`;

    // Pair 1 user message: content[0] stubbed, tool_use_id preserved.
    expect(out.messages[1].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: expectedStub,
    });
    // Pair 2 user message.
    expect(out.messages[3].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_2",
      content: expectedStub,
    });
    // Pair 3 verbatim.
    expect(out.messages[5].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_3",
      content: "THIRD CONTENT",
    });
  });

  it("(2) different args → not deduped", () => {
    const messages = [
      ...pair("tu_1", "Read", { path: "/a" }, "A CONTENT"),
      ...pair("tu_2", "Read", { path: "/b" }, "B CONTENT"),
    ];
    const out = applySessionToolResultDedupe(messages);
    expect(out.changed).toBe(false);
    expect(out.stats.deduped).toBe(0);
    expect(out.messages[1].content[0].content).toBe("A CONTENT");
    expect(out.messages[3].content[0].content).toBe("B CONTENT");
  });

  it("(3) different tool → not deduped", () => {
    const messages = [
      ...pair("tu_1", "Read", { path: "/a" }, "READ CONTENT"),
      ...pair("tu_2", "Grep", { pattern: "foo" }, "GREP CONTENT"),
    ];
    const out = applySessionToolResultDedupe(messages);
    expect(out.changed).toBe(false);
    expect(out.stats.deduped).toBe(0);
    expect(out.messages[1].content[0].content).toBe("READ CONTENT");
    expect(out.messages[3].content[0].content).toBe("GREP CONTENT");
  });

  it("(4) determinism: two runs produce byte-identical output", () => {
    const messages = [
      // Intentionally use keys in different orders to exercise stableStringify.
      ...pair("tu_1", "Read", { b: 2, a: 1 }, "R1"),
      ...pair("tu_2", "Read", { a: 1, b: 2 }, "R2"),
      ...pair("tu_3", "Glob", { pattern: "*.ts", cwd: "/x" }, "G1"),
      ...pair("tu_4", "Glob", { cwd: "/x", pattern: "*.ts" }, "G2"),
    ];
    const run1 = applySessionToolResultDedupe(messages);
    const run2 = applySessionToolResultDedupe(messages);
    expect(JSON.stringify(run1.messages)).toBe(JSON.stringify(run2.messages));
    // Stable-key canonicalization should treat reordered keys as identical.
    expect(run1.stats.deduped).toBe(2);
  });

  it("(5) pure over history: no hidden state carries between independent calls", () => {
    const messagesA = [...pair("tu_1", "Read", { path: "/a" }, "A1"), ...pair("tu_2", "Read", { path: "/a" }, "A2")];
    const messagesB = [...pair("tu_9", "Read", { path: "/a" }, "B_ONLY")];

    // Run A, then run B. B has only one call → nothing to dedupe.
    applySessionToolResultDedupe(messagesA);
    const outB = applySessionToolResultDedupe(messagesB);
    expect(outB.changed).toBe(false);
    expect(outB.stats.deduped).toBe(0);
    expect(outB.messages[1].content[0].content).toBe("B_ONLY");

    // And running A twice remains deterministic.
    const outA1 = applySessionToolResultDedupe(messagesA);
    const outA2 = applySessionToolResultDedupe(messagesA);
    expect(JSON.stringify(outA1.messages)).toBe(JSON.stringify(outA2.messages));
  });

  it("(6) disabled path: when flag is false, messages returned unchanged", () => {
    const { maybeApplySessionToolResultDedupe } = AnthropicAuthPlugin.__testing__;
    expect(typeof maybeApplySessionToolResultDedupe).toBe("function");

    const messages = [
      ...pair("tu_1", "Read", { path: "/a" }, "R1"),
      ...pair("tu_2", "Read", { path: "/a" }, "R2"),
      ...pair("tu_3", "Read", { path: "/a" }, "R3"),
    ];
    const disabledCfg = {
      token_economy_strategies: { tool_result_dedupe_session_wide: false },
    };
    const out = maybeApplySessionToolResultDedupe(messages, disabledCfg);
    expect(out).toBe(messages); // identity preserved when disabled
    // And deep-equal (no mutation).
    expect(JSON.stringify(out)).toBe(JSON.stringify(messages));
  });

  it("(7) reproducible tools only: Bash/Edit never dedupe", () => {
    const bashMessages = [
      ...pair("tu_1", "Bash", { cmd: "ls" }, "OUT1"),
      ...pair("tu_2", "Bash", { cmd: "ls" }, "OUT2"),
      ...pair("tu_3", "Bash", { cmd: "ls" }, "OUT3"),
    ];
    const bashOut = applySessionToolResultDedupe(bashMessages);
    expect(bashOut.changed).toBe(false);
    expect(bashOut.stats.deduped).toBe(0);
    expect(bashOut.messages[1].content[0].content).toBe("OUT1");
    expect(bashOut.messages[3].content[0].content).toBe("OUT2");
    expect(bashOut.messages[5].content[0].content).toBe("OUT3");

    const editMessages = [
      ...pair("tu_1", "Edit", { path: "/a" }, "E1"),
      ...pair("tu_2", "Edit", { path: "/a" }, "E2"),
      ...pair("tu_3", "Edit", { path: "/a" }, "E3"),
    ];
    const editOut = applySessionToolResultDedupe(editMessages);
    expect(editOut.changed).toBe(false);
    expect(editOut.stats.deduped).toBe(0);

    // Case-insensitive tool name classifier — lowercase should also be read.
    const lowerReadMessages = [
      ...pair("tu_1", "read", { path: "/a" }, "LR1"),
      ...pair("tu_2", "read", { path: "/a" }, "LR2"),
    ];
    const lowerOut = applySessionToolResultDedupe(lowerReadMessages);
    expect(lowerOut.stats.deduped).toBe(1);
  });

  it("(8) source hygiene: no time / randomness sources in function body", () => {
    const src = readFileSync(INDEX_PATH, "utf8");
    // Extract the function body (naive: slice between signature and first
    // top-level closing brace followed by a newline + another top-level decl).
    const startRe = /function applySessionToolResultDedupe\s*\(/;
    const startIdx = src.search(startRe);
    expect(startIdx).toBeGreaterThan(-1);

    // Walk braces to find function end.
    let depth = 0;
    let i = src.indexOf("{", startIdx);
    expect(i).toBeGreaterThan(-1);
    let endIdx = -1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);

    expect(body).not.toMatch(/Date\.now/);
    expect(body).not.toMatch(/new Date\b/);
    expect(body).not.toMatch(/Math\.random/);
    expect(body).not.toMatch(/performance\.now/);
    expect(body).not.toMatch(/crypto\.randomUUID/);
    expect(body).not.toMatch(/crypto\.getRandomValues/);
  });
});
