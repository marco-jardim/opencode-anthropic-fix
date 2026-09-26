import { describe, it, expect } from "vitest";
import { truncateGraphemes } from "./unicode-text.mjs";

// ---------------------------------------------------------------------------
// ASCII-only source file. Every non-ASCII code point below is written as a
// \u escape so the fixed-oracle expectations are literal and reviewable
// without a Unicode-aware editor.
// ---------------------------------------------------------------------------

// A grinning-face emoji: one grapheme cluster, 2 UTF-16 units (surrogate pair).
const GRIN = "😀";
// "e" + combining acute accent: one grapheme cluster, 2 UTF-16 units.
const E_ACUTE = "é";
// Family emoji (man, ZWJ, woman, ZWJ, boy): one grapheme cluster, 8 units.
const FAMILY_ZWJ = "👨‍👩‍👦";
// Flag of Japan (two regional-indicator surrogate pairs): one cluster, 4 units.
const FLAG_JP = "🇯🇵";
// Thumbs-up + medium skin tone modifier: one cluster, 4 units.
const THUMBSUP_SKINTONE = "👍🏽";
// U+20000 (CJK Ext. B, supplementary plane): one cluster, 2 units.
const U20000 = "𠀀";
// Heavy black heart + VS16 (emoji variation selector): one cluster, 2 units.
const HEART_VS16 = "❤️";
// CJK BMP characters, each its own 1-unit grapheme cluster.
const CJK = "中文中文";
// Zalgo-style long combining sequence: base + 50 combining marks, one 51-unit cluster.
const LONG_COMBINING = "e" + "́".repeat(50);

describe("truncateGraphemes — fixed-oracle boundary cases", () => {
  it("emoji ending exactly at the legacy 200-boundary (199/200/201) never splits the surrogate pair", () => {
    // 199 'a's + a 2-unit emoji = 201 units total. The emoji's high surrogate
    // sits at index 199 and its low surrogate at index 200 — this is exactly
    // the shape that a bare slice(0, 200) would cut in half.
    const text = "a".repeat(199) + GRIN;
    expect(text.length).toBe(201);

    // Negative control: demonstrate that the OLD behavior (slice(0, 200))
    // would have produced a lone surrogate here.
    const legacySlice = text.slice(0, 200);
    expect(legacySlice.length).toBe(200);
    expect(legacySlice.isWellFormed()).toBe(false);
    expect(legacySlice.charCodeAt(199)).toBe(0xd83d); // lone high surrogate

    // 199: the emoji cannot fit at all (needs 2 more units) -> excluded whole.
    expect(truncateGraphemes(text, 199)).toBe("a".repeat(199));
    // 200: still only 1 unit of room past the a's -> emoji still excluded
    // whole, so the safe result is SHORTER than the (broken) legacy output.
    expect(truncateGraphemes(text, 200)).toBe("a".repeat(199));
    // 201: the whole string (including the emoji) fits -> returned unchanged.
    expect(truncateGraphemes(text, 201)).toBe(text);

    for (const n of [199, 200, 201]) {
      expect(truncateGraphemes(text, n).isWellFormed()).toBe(true);
    }
  });

  it("never splits a base character from its combining accent", () => {
    const text = "a".repeat(5) + E_ACUTE; // 5 + 2 = 7 units
    // Budget 6: the accented "e" (2 units) can't fit in the 1 unit of room
    // left after the 5 a's, so it is excluded whole rather than emitting a
    // bare "e" without its accent.
    expect(truncateGraphemes(text, 6)).toBe("a".repeat(5));
    expect(truncateGraphemes(text, 7)).toBe(text);
  });

  it("never splits a ZWJ emoji sequence", () => {
    const text = "a".repeat(3) + FAMILY_ZWJ; // 3 + 8 = 11 units
    expect(truncateGraphemes(text, 10)).toBe("a".repeat(3));
    expect(truncateGraphemes(text, 11)).toBe(text);
  });

  it("never splits a flag sequence", () => {
    const text = "a".repeat(2) + FLAG_JP; // 2 + 4 = 6 units
    expect(truncateGraphemes(text, 5)).toBe("a".repeat(2));
    expect(truncateGraphemes(text, 6)).toBe(text);
  });

  it("never splits an emoji from its skin-tone modifier", () => {
    const text = "a".repeat(2) + THUMBSUP_SKINTONE; // 2 + 4 = 6 units
    expect(truncateGraphemes(text, 5)).toBe("a".repeat(2));
    expect(truncateGraphemes(text, 6)).toBe(text);
  });

  it("never splits a supplementary-plane surrogate pair (U+20000)", () => {
    const text = "a".repeat(3) + U20000; // 3 + 2 = 5 units
    expect(truncateGraphemes(text, 4)).toBe("a".repeat(3));
    expect(truncateGraphemes(text, 5)).toBe(text);
  });

  it("never splits a base emoji from its variation selector", () => {
    const text = "a".repeat(3) + HEART_VS16; // 3 + 2 = 5 units
    expect(truncateGraphemes(text, 4)).toBe("a".repeat(3));
    expect(truncateGraphemes(text, 5)).toBe(text);
  });

  it("truncates CJK text at a codepoint boundary like plain ASCII", () => {
    expect(truncateGraphemes(CJK, 2)).toBe(CJK.slice(0, 2));
    expect(truncateGraphemes(CJK, 4)).toBe(CJK);
  });

  it("treats a long combining-mark sequence as one indivisible cluster", () => {
    expect(LONG_COMBINING.length).toBe(51);
    expect(truncateGraphemes(LONG_COMBINING, 50)).toBe("");
    expect(truncateGraphemes(LONG_COMBINING, 51)).toBe(LONG_COMBINING);
  });
});

describe("truncateGraphemes — budget edge cases", () => {
  it("returns the empty string unchanged", () => {
    expect(truncateGraphemes("", 10)).toBe("");
    expect(truncateGraphemes("", 0)).toBe("");
    expect(truncateGraphemes("", -1)).toBe("");
  });

  it("returns text unchanged, with no suffix, when it already fits", () => {
    expect(truncateGraphemes("short", 100)).toBe("short");
    expect(truncateGraphemes("short", 100, { suffix: "..." })).toBe("short");
    expect(truncateGraphemes("short", 5)).toBe("short"); // exactly at budget
  });

  it("treats a negative budget as 0", () => {
    expect(truncateGraphemes("hello", -5)).toBe("");
    expect(truncateGraphemes("hello", -Infinity)).toBe("");
  });

  it("treats NaN as 0", () => {
    expect(truncateGraphemes("hello", NaN)).toBe("");
  });

  it("treats a non-number maxUnits as 0", () => {
    expect(truncateGraphemes("hello", undefined)).toBe("");
    expect(truncateGraphemes("hello", "10")).toBe("");
  });

  it("returns text unchanged for an Infinity budget", () => {
    expect(truncateGraphemes("hello world", Infinity)).toBe("hello world");
    expect(truncateGraphemes(LONG_COMBINING, Infinity)).toBe(LONG_COMBINING);
  });

  it("returns the empty string when maxUnits is 0 and text is non-empty", () => {
    expect(truncateGraphemes("hi", 0)).toBe("");
    expect(truncateGraphemes(GRIN, 0)).toBe("");
  });

  it("never emits a partial cluster when a single grapheme exceeds the whole budget", () => {
    expect(truncateGraphemes(GRIN, 1)).toBe("");
    expect(truncateGraphemes(FAMILY_ZWJ, 3)).toBe("");
  });
});

describe("truncateGraphemes — suffix accounting", () => {
  it("counts the suffix length against maxUnits", () => {
    // "hello world" -> budget 5, suffix "..." (3) -> 2 units of room for the
    // prefix -> "he" + "..." = "he..." (5 units total).
    expect(truncateGraphemes("hello world", 5, { suffix: "..." })).toBe("he...");
  });

  it("returns the suffix alone when there is no room for any prefix content", () => {
    expect(truncateGraphemes("hello", 3, { suffix: "..." })).toBe("...");
  });

  it("returns empty when even the suffix does not fit the budget", () => {
    expect(truncateGraphemes("hello", 2, { suffix: "..." })).toBe("");
  });

  it("never splits a cluster to make room for the suffix", () => {
    // 3 a's + GRIN (2 units) = 5 units. Budget 4 with a 1-unit suffix leaves
    // 3 units of prefix room -> exactly the 3 a's, GRIN excluded whole.
    const text = "a".repeat(3) + GRIN;
    expect(truncateGraphemes(text, 4, { suffix: "#" })).toBe("aaa#");
  });
});

// ---------------------------------------------------------------------------
// Property sweep: for a mixed corpus, every budget from 0 to length + margin
// must produce a well-formed, budget-respecting, genuine prefix that ends on
// a grapheme boundary. Boundary offsets are computed independently in this
// test (directly via Intl.Segmenter, not by calling the function under
// test) so this is a real oracle, not a tautology.
// ---------------------------------------------------------------------------
describe("truncateGraphemes — budget sweep (property oracle)", () => {
  const corpus =
    "The quick " +
    GRIN +
    " brown fox " +
    E_ACUTE +
    " jumps " +
    FAMILY_ZWJ +
    " over " +
    FLAG_JP +
    " a " +
    CJK +
    " " +
    U20000 +
    HEART_VS16;

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const boundaryOffsets = new Set([0]);
  {
    let offset = 0;
    for (const { segment } of segmenter.segment(corpus)) {
      offset += segment.length;
      boundaryOffsets.add(offset);
    }
  }

  it("the independently computed boundary oracle covers the full corpus length", () => {
    expect(boundaryOffsets.has(corpus.length)).toBe(true);
  });

  it("holds for every budget from 0 to length + margin", () => {
    for (let n = 0; n <= corpus.length + 5; n++) {
      const out = truncateGraphemes(corpus, n);
      expect(out.length).toBeLessThanOrEqual(n);
      expect(corpus.startsWith(out)).toBe(true);
      expect(out.isWellFormed()).toBe(true);
      expect(boundaryOffsets.has(out.length)).toBe(true);
    }
  });

  it("is monotonically non-decreasing in length as the budget grows", () => {
    let prevLength = -1;
    for (let n = 0; n <= corpus.length + 5; n++) {
      const out = truncateGraphemes(corpus, n);
      expect(out.length).toBeGreaterThanOrEqual(prevLength);
      prevLength = out.length;
    }
  });
});

describe("truncateGraphemes — termination and non-quadratic behavior", () => {
  it("terminates promptly for a long ASCII string with a tight budget", () => {
    const long = "x".repeat(50_000);
    const start = Date.now();
    const out = truncateGraphemes(long, 10);
    const elapsedMs = Date.now() - start;
    expect(out).toBe("x".repeat(10));
    expect(elapsedMs).toBeLessThan(500);
  });

  it("terminates promptly for a long string entirely made of multi-unit clusters", () => {
    const long = FAMILY_ZWJ.repeat(5_000); // 40,000 units, 5,000 clusters
    const start = Date.now();
    const out = truncateGraphemes(long, 100);
    const elapsedMs = Date.now() - start;
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
