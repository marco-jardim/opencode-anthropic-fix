/**
 * Grapheme-safe text truncation.
 *
 * Every plugin-side text budget that ends up on the wire (system prompt
 * compaction, rolling-summary sections/envelope, and any future caller) has
 * historically been enforced with `String.prototype.slice(0, N)`. `slice`
 * counts UTF-16 code units and has no notion of "user-perceived character":
 * it can cut a surrogate pair in half (producing a lone surrogate, which
 * `@tormentalabs/claude-code-wire-compat` rejects with `INVALID_UNICODE`) or
 * cut a multi-codepoint grapheme cluster in half (producing well-formed
 * UTF-16 that nonetheless renders as a broken glyph — a dangling combining
 * mark, half a ZWJ sequence, half a flag, a skin-tone modifier with no base
 * emoji, and so on).
 *
 * `truncateGraphemes` is the single, pure helper that replaces those
 * `slice(0, N)` call sites. It only ever cuts on a grapheme-cluster boundary
 * (per `Intl.Segmenter` with `granularity: "grapheme"`) and never emits a
 * lone surrogate or a split cluster.
 *
 * Budget unit: UTF-16 code units — i.e. `String.prototype.length`. This is
 * the same unit the `slice(0, N)` call sites it replaces already used, so
 * swapping in this helper with the same `N` preserves the legacy budget
 * semantics (it does NOT switch callers to a UTF-8 byte budget or a visual
 * column budget; a caller that needs one of those must convert before and
 * after calling in).
 *
 * @module lib/unicode-text
 */

/**
 * Return the longest prefix of `text` that:
 *   - ends exactly on a grapheme-cluster boundary (never splits a surrogate
 *     pair and never splits a base character from a combining mark, ZWJ
 *     sequence, flag, or emoji modifier);
 *   - together with `options.suffix` appended, has a UTF-16 length
 *     (`.length`) less than or equal to `maxUnits`.
 *
 * Edge-case contract (all explicit; the function never throws):
 *   - `text === ""` -> `""`.
 *   - `maxUnits` is `NaN`, or not a number at all -> treated as `0` (the
 *     most conservative reading: if the budget itself is meaningless,
 *     nothing is guaranteed to fit).
 *   - `maxUnits < 0` -> treated as `0`.
 *   - `maxUnits === Infinity` -> `text` is returned unchanged; there is no
 *     ceiling to cut against.
 *   - `text.length <= maxUnits` -> `text` is returned unchanged, WITHOUT the
 *     suffix appended. Nothing was truncated, so nothing marks that it was —
 *     this matches the legacy call sites, where the suffix only ever showed
 *     up when a cut actually happened.
 *   - The very first grapheme cluster of `text` is already wider than the
 *     room left for the prefix (`maxUnits - suffix.length`) -> the prefix is
 *     `""`. The cluster is NEVER split to make it fit; if `options.suffix`
 *     itself fits within `maxUnits` on its own it is still returned alone,
 *     otherwise the overall result is `""`.
 *   - Long combining-mark sequences, ZWJ emoji, flags, and skin-tone
 *     modifiers are each a single grapheme cluster to `Intl.Segmenter` and
 *     are therefore included or excluded as one indivisible unit, however
 *     many UTF-16 units or code points they span.
 *
 * Performance: `text` is segmented at most once. If `text.length <=
 * maxUnits`, segmentation is skipped entirely (fast path) — no reason to pay
 * for it when no truncation can possibly be needed. When truncation IS
 * needed, the segments are walked forward exactly once, accumulating length
 * until the next segment would exceed the budget; this is O(n) in the length
 * of `text`, never quadratic, and always terminates because the walk is a
 * single forward pass over a finite iterator.
 *
 * @param {string} text
 * @param {number} maxUnits - budget in UTF-16 code units (`.length`).
 * @param {{suffix?: string}} [options]
 * @returns {string}
 */
export function truncateGraphemes(text, maxUnits, options) {
  const suffix = options && typeof options.suffix === "string" ? options.suffix : "";
  const input = typeof text === "string" ? text : String(text ?? "");
  if (input.length === 0) return "";

  // Normalize the budget: non-numbers and NaN are the most conservative
  // reading (0); negative budgets clamp to 0; Infinity is left as-is and
  // falls through the normal comparisons below (any finite length is <=
  // Infinity, so it hits the "already fits" fast path further down).
  let limit = maxUnits;
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    limit = 0;
  } else if (limit < 0) {
    limit = 0;
  }

  // Fast path: already within budget. Skip segmenting entirely, and do NOT
  // append the suffix — nothing was truncated.
  if (input.length <= limit) return input;

  const budgetForPrefix = limit - suffix.length;
  if (budgetForPrefix <= 0) {
    // No room for even one grapheme once the suffix is reserved. Return the
    // suffix alone if it fits the whole budget by itself; otherwise "".
    // Either way, no partial cluster is ever produced.
    return suffix.length <= limit ? suffix : "";
  }

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let prefix = "";
  let used = 0;
  for (const { segment } of segmenter.segment(input)) {
    const segmentLength = segment.length;
    if (used + segmentLength > budgetForPrefix) break;
    prefix += segment;
    used += segmentLength;
  }
  return prefix + suffix;
}
