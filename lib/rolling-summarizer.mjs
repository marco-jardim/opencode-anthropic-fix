/**
 * Deterministic rolling summarizer — Phase B Task B3.
 *
 * Produces a byte-identical string summary for a given message array so the
 * Anthropic prompt cache stays warm across compaction boundaries.
 *
 * Invariants (enforced by test/rolling-summarizer.test.mjs):
 *  - No Date.now / new Date / Math.random / performance.now anywhere.
 *  - temperature: 0 on the Haiku call.
 *  - Object iteration is sorted before join.
 *  - The Haiku call is injected as `haikuCall(request)` so tests stay offline.
 *
 * @module lib/rolling-summarizer
 */

/** Haiku 4.5 — deterministic, cheap summarization model. */
export const MODEL = "claude-haiku-4-5-20251001";

/** Forced to 0 — non-zero temperature would break the byte-equality guarantee. */
export const TEMPERATURE = 0;

/** Default length bound for the full rendered `<session-summary>` block. */
export const DEFAULT_MAX_CHARS = 2000;

/** Canonical template — every field is a placeholder, never a timestamp. */
export const TEMPLATE = [
  "<session-summary>",
  "Previous conversation summarized for context efficiency.",
  "",
  "Key topics covered:",
  "{topics}",
  "",
  "Outstanding state:",
  "{outstanding}",
  "",
  "Files touched:",
  "{files}",
  "</session-summary>",
].join("\n");

/** Fixed sections the Haiku response is expected to emit, in this exact order. */
const SECTIONS = ["TOPICS", "OUTSTANDING", "FILES"];

/** Always-present fallback when a section is missing from the Haiku reply. */
const EMPTY_SECTION = "(none)";

/** @typedef {{role: string, content: string}} Message */
/** @typedef {{topics: string, outstanding: string, files: string}} ParsedSections */
/** @typedef {{model: string, temperature: number, prompt: string}} HaikuRequest */
/** @typedef {(req: HaikuRequest) => Promise<string>} HaikuCall */

/**
 * Serialize an object with keys in sorted order.  JSON.stringify follows
 * insertion order in V8, so sorting first guarantees byte-equality across
 * property-order-varied inputs.
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function stableStringify(obj) {
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(obj[k]));
  return "{" + parts.join(",") + "}";
}

/**
 * Build the prompt text fed to Haiku.  Pure; no timestamps, no IDs.
 * Uses sorted-key serialization so the output doesn't change if the caller
 * built `{role, content}` vs `{content, role}`.
 * @param {Message[]} messages
 * @param {number} maxChars — soft cap used to trim oldest messages first.
 * @returns {string}
 */
export function buildPrompt(messages, maxChars) {
  const rendered = messages.map((m) => {
    // Re-shape every message in a canonical sorted form so insertion order
    // of {role, content} vs {content, role} cannot affect the bytes.
    const norm = stableStringify({ role: String(m.role ?? ""), content: String(m.content ?? "") });
    // Render as "role: content" for the model — deterministic and readable.
    const parsed = JSON.parse(norm);
    return `${parsed.role}: ${parsed.content}`;
  });

  // Keep under the cap by trimming the oldest entries first.  Deterministic:
  // no randomness, purely length-driven.
  let body = rendered.join("\n");
  let dropped = 0;
  while (body.length > maxChars && rendered.length - dropped > 1) {
    dropped += 1;
    body = rendered.slice(dropped).join("\n");
  }

  const header = [
    "Summarize the conversation below for context compaction.",
    "Respond with EXACTLY these three sections, in this order:",
    "TOPICS:",
    "- <bullet per topic>",
    "OUTSTANDING:",
    "- <bullet per outstanding item, or (none)>",
    "FILES:",
    "- <bullet per touched file, or (none)>",
    "Do not include dates, times, IDs, greetings, or apologies.",
    "---",
  ].join("\n");

  return `${header}\n${body}`;
}

/**
 * Parse Haiku's "TOPICS:\n...\nOUTSTANDING:\n...\nFILES:\n..." reply into
 * the three fields the template expects.  Unknown sections are ignored.
 * Missing sections fall back to EMPTY_SECTION so the output stays stable.
 * @param {string} raw
 * @returns {ParsedSections}
 */
export function parseHaikuResponse(raw) {
  /** @type {Record<string, string[]>} */
  const buckets = {};
  for (const name of SECTIONS) buckets[name] = [];

  let current = /** @type {string | null} */ (null);
  const lines = String(raw ?? "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z]+)\s*:\s*$/);
    if (match && SECTIONS.includes(match[1])) {
      current = match[1];
      continue;
    }
    if (current && line.trim() !== "") {
      buckets[current].push(line);
    }
  }

  const pick = (name) => {
    const arr = buckets[name];
    if (!arr || arr.length === 0) return EMPTY_SECTION;
    return arr.join("\n");
  };

  return {
    topics: pick("TOPICS"),
    outstanding: pick("OUTSTANDING"),
    files: pick("FILES"),
  };
}

/**
 * Render the canonical TEMPLATE with parsed sections substituted in.
 * If the result exceeds `maxChars`, sections are truncated deterministically
 * from the longest one first until the total fits.
 * @param {ParsedSections} parsed
 * @param {number} maxChars
 * @returns {string}
 */
export function formatTemplate(parsed, maxChars) {
  /** @type {ParsedSections} */
  let current = {
    topics: parsed.topics || EMPTY_SECTION,
    outstanding: parsed.outstanding || EMPTY_SECTION,
    files: parsed.files || EMPTY_SECTION,
  };

  const render = (sec) =>
    TEMPLATE.replace("{topics}", sec.topics).replace("{outstanding}", sec.outstanding).replace("{files}", sec.files);

  let out = render(current);
  // Deterministic truncation: iterate sections in a fixed order and shorten
  // the longest until we fit.  No Math.random, no timing-based bail.
  let guard = 0;
  while (out.length > maxChars && guard < 1000) {
    guard += 1;
    const names = /** @type {(keyof ParsedSections)[]} */ (["topics", "outstanding", "files"]);
    // Pick the longest section; ties broken by fixed order above.
    let longestName = names[0];
    for (const n of names) {
      if (current[n].length > current[longestName].length) longestName = n;
    }
    const longest = current[longestName];
    if (longest.length <= EMPTY_SECTION.length) break;
    // Chop 10% (at least 8 chars) off the end of the longest section.
    const chop = Math.max(8, Math.floor(longest.length * 0.1));
    current = { ...current, [longestName]: longest.slice(0, Math.max(EMPTY_SECTION.length, longest.length - chop)) };
    out = render(current);
  }

  // Final hard cap: if we somehow still exceed, slice the envelope.  Still
  // deterministic (input-driven only).
  if (out.length > maxChars) {
    const closing = "\n</session-summary>";
    const head = out.slice(0, Math.max(0, maxChars - closing.length));
    out = head + closing;
  }
  return out;
}

/**
 * Summarize `messages` into a canonical `<session-summary>` string.
 *
 * @param {Message[]} messages
 * @param {{maxChars?: number, haikuCall: HaikuCall}} opts
 *   - maxChars: soft cap on the returned string (default 2000).
 *   - haikuCall: dependency-injected Haiku invoker — `(request) => Promise<string>`.
 * @returns {Promise<string>}
 */
export async function summarize(messages, opts) {
  if (!opts || typeof opts.haikuCall !== "function") {
    throw new Error("summarize() requires opts.haikuCall");
  }
  const maxChars = typeof opts.maxChars === "number" ? opts.maxChars : DEFAULT_MAX_CHARS;
  const prompt = buildPrompt(Array.isArray(messages) ? messages : [], maxChars);
  /** @type {HaikuRequest} */
  const request = { model: MODEL, prompt, temperature: TEMPERATURE };
  const raw = await opts.haikuCall(request);
  const parsed = parseHaikuResponse(String(raw ?? ""));
  return formatTemplate(parsed, maxChars);
}
