/**
 * Determinism regression harness for `applyContextHintCompaction`.
 *
 * `applyContextHintCompaction` is invoked on 422/424 server responses to
 * compact prior messages before a retry. It MUST be a pure, byte-stable
 * function: same input → same output, forever, across Node versions and
 * object-key-insertion orders. Any leakage of timestamps, random IDs, or
 * Set-iteration-order-dependent output would cause retry payloads to
 * differ from the original request in ways that look like cache-break to
 * upstream Anthropic infra.
 *
 * This is a prerequisite for Phase C2 (flipping `context_hint` default to
 * true) — we must prove determinism before enabling the feature by default.
 *
 * Phase C work tracked in docs/plans/2026-04-18-phase-c-cc-parity.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { AnthropicAuthPlugin } from "../../index.mjs";

const { applyContextHintCompaction } = AnthropicAuthPlugin.__testing__;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Build a ~20-message fixture with 12 tool_result blocks (mixed string and
 * array content) and 4 assistant messages carrying `thinking` blocks.
 *
 * @param {{ keyOrder?: "natural" | "reversed" }} [opts]
 */
function buildFixture(opts = {}) {
  const keyOrder = opts.keyOrder ?? "natural";

  // Two styles of tool_result content: bare string, and [{type:"text", ...}].
  const makeToolResult = (id, idx) => {
    const contentArr = idx % 2 === 0 ? `tool output ${idx}` : [{ type: "text", text: `tool output ${idx}` }];
    if (keyOrder === "reversed") {
      // Reverse insertion order to assert stability across Object.keys order.
      return { content: contentArr, tool_use_id: id, type: "tool_result" };
    }
    return { type: "tool_result", tool_use_id: id, content: contentArr };
  };

  const makeThinkingBlock = (text) => {
    if (keyOrder === "reversed") {
      return { thinking: text, type: "thinking" };
    }
    return { type: "thinking", thinking: text };
  };

  const makeTextBlock = (text) => {
    if (keyOrder === "reversed") {
      return { text, type: "text" };
    }
    return { type: "text", text };
  };

  /** @type {Array<any>} */
  const messages = [];

  // Seed with a user text message.
  messages.push({ role: "user", content: [makeTextBlock("Please run a series of tools.")] });

  // Interleave 4 assistant (with thinking) / user (with tool_result) pairs,
  // each user message carrying 3 tool_result blocks = 12 tool_results total.
  // Plus one assistant text-only reply between the 3rd and 4th pair to pad.
  let toolIdx = 0;
  for (let turn = 0; turn < 4; turn++) {
    messages.push({
      role: "assistant",
      content: [
        makeThinkingBlock(`reasoning step ${turn}`),
        makeTextBlock(`calling tools (turn ${turn})`),
        { type: "tool_use", id: `tu_${turn}_a`, name: "bash", input: { cmd: "ls" } },
        { type: "tool_use", id: `tu_${turn}_b`, name: "bash", input: { cmd: "pwd" } },
        { type: "tool_use", id: `tu_${turn}_c`, name: "bash", input: { cmd: "date" } },
      ],
    });
    messages.push({
      role: "user",
      content: [
        makeToolResult(`tu_${turn}_a`, toolIdx++),
        makeToolResult(`tu_${turn}_b`, toolIdx++),
        makeToolResult(`tu_${turn}_c`, toolIdx++),
      ],
    });
    if (turn === 2) {
      messages.push({
        role: "assistant",
        content: [makeTextBlock("intermediate commentary")],
      });
    }
  }

  // Trailing user text nudge.
  messages.push({ role: "user", content: [makeTextBlock("Now summarize.")] });

  return messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyContextHintCompaction — determinism regression harness (phase C1)", () => {
  it("produces byte-identical output across two runs on the same input", () => {
    const fixture1 = buildFixture();
    const fixture2 = buildFixture();

    const out1 = applyContextHintCompaction(fixture1);
    const out2 = applyContextHintCompaction(fixture2);

    expect(JSON.stringify(out1.messages)).toBe(JSON.stringify(out2.messages));
    expect(out1.stats).toEqual(out2.stats);
    expect(out1.changed).toBe(out2.changed);
  });

  it("is stable across Object.keys insertion order in input blocks", () => {
    const natural = buildFixture({ keyOrder: "natural" });
    const reversed = buildFixture({ keyOrder: "reversed" });

    const outNatural = applyContextHintCompaction(natural);
    const outReversed = applyContextHintCompaction(reversed);

    // Compare using a canonicalized JSON (keys sorted) so we only assert on
    // semantic equality — object-key insertion order is a JS detail, not
    // something we want to pin. What we DO want to pin: the function must
    // not reorder, drop, or add blocks based on key order.
    const canonicalize = (v) => JSON.stringify(v, Object.keys(v).sort ? undefined : undefined);

    // Deep-sort-keys canonicalizer for fair equality.
    const sortKeysDeep = (value) => {
      if (Array.isArray(value)) return value.map(sortKeysDeep);
      if (value && typeof value === "object") {
        const sorted = {};
        for (const k of Object.keys(value).sort()) sorted[k] = sortKeysDeep(value[k]);
        return sorted;
      }
      return value;
    };

    expect(JSON.stringify(sortKeysDeep(outNatural.messages))).toBe(JSON.stringify(sortKeysDeep(outReversed.messages)));
    expect(outNatural.stats).toEqual(outReversed.stats);

    // Also: running the SAME key-ordering twice should be byte-identical
    // (not just semantically equal) — that's the stricter guarantee.
    const outNatural2 = applyContextHintCompaction(buildFixture({ keyOrder: "natural" }));
    expect(JSON.stringify(outNatural.messages)).toBe(JSON.stringify(outNatural2.messages));

    // Suppress unused-var lint on the helper above.
    void canonicalize;
  });

  it("does not leak timestamps into the output (13-digit unix-ms or ISO-8601)", () => {
    const fixture = buildFixture();
    const out = applyContextHintCompaction(fixture);
    const serialized = JSON.stringify(out.messages);

    // 13-digit unix-ms (starting with 1, so it covers ~2001-2286).
    const unixMsPattern = /\b1\d{12}\b/;
    // ISO-8601 datetime prefix: YYYY-MM-DDTHH:MM
    const iso8601Pattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

    // Neither should appear unless they were in the input fixture — and the
    // fixture contains neither.
    const inputSerialized = JSON.stringify(fixture);
    expect(unixMsPattern.test(inputSerialized)).toBe(false);
    expect(iso8601Pattern.test(inputSerialized)).toBe(false);

    expect(unixMsPattern.test(serialized)).toBe(false);
    expect(iso8601Pattern.test(serialized)).toBe(false);
  });

  it("source hygiene: function body contains no non-deterministic APIs", () => {
    // Read index.mjs as text and extract the applyContextHintCompaction body.
    const indexPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../index.mjs");
    const source = readFileSync(indexPath, "utf8");

    const sigIdx = source.indexOf("function applyContextHintCompaction(");
    expect(sigIdx).toBeGreaterThan(-1);

    // Find opening brace of the function body.
    const openBraceIdx = source.indexOf("{", sigIdx);
    expect(openBraceIdx).toBeGreaterThan(-1);

    // Walk with a simple brace counter, aware of single-line comments,
    // block comments, and string literals (single, double, backtick).
    let depth = 0;
    let i = openBraceIdx;
    let endIdx = -1;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      // Line comment.
      if (ch === "/" && next === "/") {
        const nl = source.indexOf("\n", i);
        if (nl === -1) break;
        i = nl + 1;
        continue;
      }
      // Block comment.
      if (ch === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end === -1) break;
        i = end + 2;
        continue;
      }
      // String literal.
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        i += 1;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === quote) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
      i += 1;
    }

    expect(endIdx).toBeGreaterThan(openBraceIdx);
    const body = source.slice(openBraceIdx, endIdx + 1);

    // Forbidden tokens — any of these would introduce non-determinism.
    const forbidden = [
      "Date.now",
      "new Date",
      "Math.random",
      "performance.now",
      "crypto.randomUUID",
      "crypto.getRandomValues",
    ];
    for (const token of forbidden) {
      expect(body.includes(token), `forbidden non-deterministic token in body: ${token}`).toBe(false);
    }
  });

  it("stats are deterministic across two runs on the same input", () => {
    const out1 = applyContextHintCompaction(buildFixture());
    const out2 = applyContextHintCompaction(buildFixture());
    expect(out1.stats.thinkingCleared).toBe(out2.stats.thinkingCleared);
    expect(out1.stats.toolResultsCleared).toBe(out2.stats.toolResultsCleared);
    // Sanity: fixture has 4 thinking blocks and 12 tool_results; default
    // keepRecent=8, so we expect 4 thinking cleared and 12-8=4 tool_results cleared.
    expect(out1.stats.thinkingCleared).toBe(4);
    expect(out1.stats.toolResultsCleared).toBe(4);
  });

  describe("keepRecent boundary behavior", () => {
    it("keepRecent=8 preserves exactly the last 8 tool_result blocks verbatim", () => {
      const fixture = buildFixture();
      const out = applyContextHintCompaction(fixture, { keepRecentToolResults: 8 });

      // Collect all tool_result blocks from output in document order.
      const outToolResults = [];
      for (const msg of out.messages) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "tool_result") outToolResults.push(block);
        }
      }
      expect(outToolResults).toHaveLength(12);

      // Collect originals from the unmodified fixture.
      const inFixture = buildFixture();
      const inToolResults = [];
      for (const msg of inFixture) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "tool_result") inToolResults.push(block);
        }
      }
      expect(inToolResults).toHaveLength(12);

      // First 4 should be stubbed, last 8 should be identical to input.
      for (let idx = 0; idx < 4; idx++) {
        expect(outToolResults[idx].content).toBe("[Old tool result content cleared]");
      }
      for (let idx = 4; idx < 12; idx++) {
        expect(outToolResults[idx].content).toEqual(inToolResults[idx].content);
      }

      expect(out.stats.toolResultsCleared).toBe(4);
    });

    it("keepRecent=0 stubs every tool_result block", () => {
      const fixture = buildFixture();
      const out = applyContextHintCompaction(fixture, { keepRecentToolResults: 0 });

      let count = 0;
      for (const msg of out.messages) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "tool_result") {
            expect(block.content).toBe("[Old tool result content cleared]");
            count += 1;
          }
        }
      }
      expect(count).toBe(12);
      expect(out.stats.toolResultsCleared).toBe(12);
    });

    it("keepRecent greater than total stubs no tool_result blocks", () => {
      const fixture = buildFixture();
      const out = applyContextHintCompaction(fixture, { keepRecentToolResults: 100 });

      const inFixture = buildFixture();
      const inToolResults = [];
      for (const msg of inFixture) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "tool_result") inToolResults.push(block);
        }
      }

      const outToolResults = [];
      for (const msg of out.messages) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "tool_result") outToolResults.push(block);
        }
      }

      expect(outToolResults).toHaveLength(12);
      for (let idx = 0; idx < 12; idx++) {
        expect(outToolResults[idx].content).toEqual(inToolResults[idx].content);
      }
      expect(out.stats.toolResultsCleared).toBe(0);
    });
  });
});
