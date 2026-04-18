/**
 * Phase B Task B3 — Deterministic rolling summarizer
 *
 * These tests enforce that `lib/rolling-summarizer.mjs` produces
 * byte-identical output for equivalent inputs so that server-side
 * prompt cache is preserved across compaction boundaries.
 *
 * Non-negotiables:
 *  - No Date.now() / new Date() / Math.random() / performance.now().
 *  - Haiku call uses temperature=0 and a fixed model ID.
 *  - Object iteration is sorted before join so property-insertion
 *    order never leaks into the output.
 *  - Template is fixed and the output stays under maxChars.
 */
import { describe, it, expect, vi } from "vitest";
import {
  summarize,
  buildPrompt,
  parseHaikuResponse,
  formatTemplate,
  MODEL,
  TEMPERATURE,
  DEFAULT_MAX_CHARS,
  TEMPLATE,
} from "../lib/rolling-summarizer.mjs";

// ---------------------------------------------------------------------------
// Canned Haiku responses — pure strings, no randomness anywhere.
// ---------------------------------------------------------------------------

const CANNED_RESPONSE = [
  "TOPICS:",
  "- Set up plugin build pipeline",
  "- Investigated cache thrash root cause",
  "",
  "OUTSTANDING:",
  "- Decide on rollout flag name",
  "",
  "FILES:",
  "- index.mjs",
  "- lib/config.mjs",
].join("\n");

function makeStub(response = CANNED_RESPONSE) {
  return vi.fn(async () => response);
}

const SAMPLE_MESSAGES = [
  { role: "user", content: "Please build me a plugin." },
  { role: "assistant", content: "Working on it — step 1 done." },
  { role: "user", content: "What about caching?" },
  { role: "assistant", content: "Added prompt cache blocks." },
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("rolling-summarizer constants", () => {
  it("exposes the Haiku 4.5 model ID expected by the plan", () => {
    expect(MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("enforces temperature=0", () => {
    expect(TEMPERATURE).toBe(0);
  });

  it("defaults maxChars to 2000", () => {
    expect(DEFAULT_MAX_CHARS).toBe(2000);
  });

  it("template has placeholders for topics, outstanding, files", () => {
    expect(TEMPLATE).toContain("{topics}");
    expect(TEMPLATE).toContain("{outstanding}");
    expect(TEMPLATE).toContain("{files}");
    expect(TEMPLATE.startsWith("<session-summary>")).toBe(true);
    expect(TEMPLATE.endsWith("</session-summary>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape of the returned summary
// ---------------------------------------------------------------------------

describe("summarize — output shape", () => {
  it("returns a string starting with <session-summary> and ending with </session-summary>", async () => {
    const out = await summarize(SAMPLE_MESSAGES, { haikuCall: makeStub() });
    expect(typeof out).toBe("string");
    expect(out.startsWith("<session-summary>\n")).toBe(true);
    expect(out.endsWith("</session-summary>")).toBe(true);
  });

  it("substitutes each section from the parsed Haiku response", async () => {
    const out = await summarize(SAMPLE_MESSAGES, { haikuCall: makeStub() });
    expect(out).toContain("- Set up plugin build pipeline");
    expect(out).toContain("- Decide on rollout flag name");
    expect(out).toContain("- index.mjs");
  });
});

// ---------------------------------------------------------------------------
// Determinism — the core invariant
// ---------------------------------------------------------------------------

describe("summarize — determinism", () => {
  it("two runs with the same messages + stub produce byte-identical output", async () => {
    const a = await summarize(SAMPLE_MESSAGES, { haikuCall: makeStub() });
    const b = await summarize(SAMPLE_MESSAGES, { haikuCall: makeStub() });
    expect(a).toBe(b);
  });

  it("the Haiku request itself is byte-identical across runs", async () => {
    const stub1 = makeStub();
    const stub2 = makeStub();
    await summarize(SAMPLE_MESSAGES, { haikuCall: stub1 });
    await summarize(SAMPLE_MESSAGES, { haikuCall: stub2 });
    const req1 = stub1.mock.calls[0][0];
    const req2 = stub2.mock.calls[0][0];
    expect(req1.prompt).toBe(req2.prompt);
    expect(req1.model).toBe(req2.model);
    expect(req1.temperature).toBe(req2.temperature);
    // Also full object equality via JSON with sorted keys — if the module
    // were adding a timestamp, a nonce, or random ID, this would diverge.
    expect(JSON.stringify(req1)).toBe(JSON.stringify(req2));
  });

  it("the request passed to haikuCall has exactly {model, temperature, prompt}", async () => {
    const stub = makeStub();
    await summarize(SAMPLE_MESSAGES, { haikuCall: stub });
    const req = stub.mock.calls[0][0];
    expect(req.model).toBe("claude-haiku-4-5-20251001");
    expect(req.temperature).toBe(0);
    expect(typeof req.prompt).toBe("string");
    expect(Object.keys(req).sort()).toEqual(["model", "prompt", "temperature"]);
  });

  it("is stable across different property-insertion orders on messages", async () => {
    // Build two arrays with the same semantic content but different insertion orders.
    const m1 = SAMPLE_MESSAGES.map((m) => ({ role: m.role, content: m.content }));
    const m2 = SAMPLE_MESSAGES.map((m) => {
      const o = {};
      o.content = m.content;
      o.role = m.role;
      return o;
    });
    const a = await summarize(m1, { haikuCall: makeStub() });
    const b = await summarize(m2, { haikuCall: makeStub() });
    expect(a).toBe(b);

    // And so is the request.
    const s1 = makeStub();
    const s2 = makeStub();
    await summarize(m1, { haikuCall: s1 });
    await summarize(m2, { haikuCall: s2 });
    expect(s1.mock.calls[0][0].prompt).toBe(s2.mock.calls[0][0].prompt);
  });
});

// ---------------------------------------------------------------------------
// Length bound
// ---------------------------------------------------------------------------

describe("summarize — length bound", () => {
  it("respects maxChars when the Haiku response is huge", async () => {
    const huge = [
      "TOPICS:",
      ...Array.from({ length: 200 }, (_, i) => `- topic line ${i} ${"x".repeat(40)}`),
      "OUTSTANDING:",
      ...Array.from({ length: 200 }, (_, i) => `- outstanding line ${i} ${"y".repeat(40)}`),
      "FILES:",
      ...Array.from({ length: 200 }, (_, i) => `- file_${i}.mjs`),
    ].join("\n");
    const stub = vi.fn(async () => huge);
    const out = await summarize(SAMPLE_MESSAGES, { haikuCall: stub, maxChars: 500 });
    expect(out.length).toBeLessThanOrEqual(500);
    // Must still be a well-formed envelope.
    expect(out.startsWith("<session-summary>\n")).toBe(true);
    expect(out.endsWith("</session-summary>")).toBe(true);
  });

  it("truncation is itself deterministic", async () => {
    const huge = [
      "TOPICS:",
      ...Array.from({ length: 50 }, (_, i) => `- topic ${i}`),
      "OUTSTANDING:",
      ...Array.from({ length: 50 }, (_, i) => `- outstanding ${i}`),
      "FILES:",
      ...Array.from({ length: 50 }, (_, i) => `- f${i}.mjs`),
    ].join("\n");
    const a = await summarize(SAMPLE_MESSAGES, { haikuCall: vi.fn(async () => huge), maxChars: 400 });
    const b = await summarize(SAMPLE_MESSAGES, { haikuCall: vi.fn(async () => huge), maxChars: 400 });
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// No forbidden non-determinism sources in the module source
// ---------------------------------------------------------------------------

describe("rolling-summarizer — source hygiene", () => {
  it("module source contains no Date.now / new Date / Math.random / performance.now", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(new URL("../lib/rolling-summarizer.mjs", import.meta.url));
    const src = readFileSync(path, "utf8");
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new\s+Date\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
    expect(src).not.toMatch(/performance\.now\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseHaikuResponse", () => {
  it("splits sections by TOPICS:/OUTSTANDING:/FILES: headers", () => {
    const parsed = parseHaikuResponse(CANNED_RESPONSE);
    expect(parsed.topics).toContain("- Set up plugin build pipeline");
    expect(parsed.outstanding).toContain("- Decide on rollout flag name");
    expect(parsed.files).toContain("- index.mjs");
  });

  it("is deterministic and pure", () => {
    expect(parseHaikuResponse(CANNED_RESPONSE)).toEqual(parseHaikuResponse(CANNED_RESPONSE));
  });

  it("tolerates missing sections with stable empty fallbacks", () => {
    const parsed = parseHaikuResponse("TOPICS:\n- only topic");
    expect(parsed.topics).toBe("- only topic");
    expect(parsed.outstanding).toBe("(none)");
    expect(parsed.files).toBe("(none)");
  });
});

describe("buildPrompt", () => {
  it("returns a string that lists messages in order", () => {
    const p = buildPrompt(SAMPLE_MESSAGES, 2000);
    expect(p).toContain("user: Please build me a plugin.");
    expect(p).toContain("assistant: Added prompt cache blocks.");
  });

  it("is deterministic across insertion-order-varied inputs", () => {
    const m1 = SAMPLE_MESSAGES.map((m) => ({ role: m.role, content: m.content }));
    const m2 = SAMPLE_MESSAGES.map((m) => {
      const o = {};
      o.content = m.content;
      o.role = m.role;
      return o;
    });
    expect(buildPrompt(m1, 2000)).toBe(buildPrompt(m2, 2000));
  });
});

describe("formatTemplate", () => {
  it("fills all three placeholders", () => {
    const out = formatTemplate({ topics: "- a", outstanding: "- b", files: "- c" }, 2000);
    expect(out).toContain("- a");
    expect(out).toContain("- b");
    expect(out).toContain("- c");
    expect(out).not.toContain("{topics}");
    expect(out).not.toContain("{outstanding}");
    expect(out).not.toContain("{files}");
  });
});
