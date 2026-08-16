import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * GOVERNANCE GUARD for hand-written model-family regexes.
 *
 * `lib/mimicry/models.mjs` answered "is this Opus 4.7?", "does this model have
 * a 1M context?" and friends with regexes maintained in parallel with the wire
 * package's model catalogue. It drifted, it is deleted, and those questions now
 * resolve through the `lib/mimicry/wire-compat.mjs` seam.
 *
 * Nothing in the language stops the next contributor from writing
 * `/claude-opus-4-9/i.test(model)` inline and re-opening the drift. This file
 * is the ratchet: `CLAUDE_3_MODEL_RE` is banned outright, and every regex
 * literal naming a model family inside `lib/mimicry` production code must be
 * listed in ALLOWED_FAMILY_REGEXES below with a reason.
 *
 * A new entry in that allowlist is not forbidden — it is a REVIEW PROMPT. If
 * the package can answer the question, use the seam instead.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** @param {string} dir @returns {string[]} */
function mjsFilesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mjsFilesUnder(full));
    else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

/** @param {string} file */
function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

const PRODUCTION_FILES = [
  path.join(repoRoot, "index.mjs"),
  path.join(repoRoot, "cli.mjs"),
  ...mjsFilesUnder(path.join(repoRoot, "lib")),
];

const MIMICRY_FILES = mjsFilesUnder(path.join(repoRoot, "lib", "mimicry"));

// ---------------------------------------------------------------------------
// (1) The retired identifier
// ---------------------------------------------------------------------------

describe("CLAUDE_3_MODEL_RE is retired", () => {
  it("appears in no production source file", () => {
    const offenders = PRODUCTION_FILES.filter((file) => readFileSync(file, "utf8").includes("CLAUDE_3_MODEL_RE")).map(
      relative,
    );

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (2) No NEW local model-family regexes in lib/mimicry
// ---------------------------------------------------------------------------

/**
 * Strip comments and string/template literals so the regex-literal scan below
 * only sees executable source. Without this, a prose mention of `claude-3` in a
 * doc comment or a model id inside a string would read as a regex.
 *
 * @param {string} source
 * @returns {string}
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** Keywords after which a `/` opens a regex literal rather than dividing. */
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Collect regex literals from already-stripped source.
 *
 * A `/` starts a regex unless the previous significant character could end an
 * expression (identifier, number, `)`, `]`, `}`) — the standard heuristic, with
 * the usual keyword exception so `return /haiku/i.test(m)` is not read as
 * division. That is sufficient here: every model regex in this tree follows
 * `(`, `,`, `=`, `!`, `[` or `return`.
 *
 * @param {string} source
 * @returns {string[]}
 */
function regexLiteralsIn(source) {
  /** @type {string[]} */
  const literals = [];
  let prevSignificant = "";
  let prevWord = "";
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      prevWord = source.slice(start, i);
      prevSignificant = prevWord[prevWord.length - 1];
      continue;
    }

    const afterKeyword = /[A-Za-z0-9_$]/.test(prevSignificant) && KEYWORDS_BEFORE_REGEX.has(prevWord);
    if (ch === "/" && (afterKeyword || !/[A-Za-z0-9_$)\]}]/.test(prevSignificant))) {
      const start = i;
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          break;
        } else if (c === "\n") break;
        i += 1;
      }
      if (closed) {
        i += 1;
        while (i < source.length && /[dgimsuvy]/.test(source[i])) i += 1;
        literals.push(source.slice(start, i));
        prevSignificant = "/";
        prevWord = "";
        continue;
      }
      i = start + 1;
      prevSignificant = "/";
      prevWord = "";
      continue;
    }

    prevSignificant = ch;
    prevWord = "";
    i += 1;
  }

  return literals;
}

/** Any regex literal naming a Claude model family is in scope for the guard. */
const FAMILY_TOKEN = /claude-|opus|sonnet|haiku|fable|mythos/i;

/**
 * The model-family regexes that may remain in `lib/mimicry` production code,
 * each with the reason it is not a seam candidate. Keyed by file so a literal
 * cannot silently migrate between modules.
 *
 * Everything listed here is CAPABILITY HEURISTIC state that predates the model
 * catalogue migration and has no package equivalent today. Phase 3.1 moved the
 * nine catalogue predicates (`isOpus47Model`, `hasOneMillionContext`, …); it
 * deliberately did not touch these. They stay visible here rather than
 * invisible in the tree.
 *
 * @type {Record<string, readonly string[]>}
 */
const ALLOWED_FAMILY_REGEXES = {
  // `_EFFORT_EXCLUDED_MODELS` plus the three capability probes below encode
  // header-level policy (does this id take an `effort` field, structured
  // outputs, web search) rather than model identity. The package catalogue
  // exposes no equivalent query, so the local list is still the source.
  "lib/mimicry/headers.mjs": [
    "/claude-opus-4-0/i",
    "/claude-opus-4-1/i",
    "/claude-sonnet-4-0/i",
    "/claude-sonnet-4-5/i",
    "/claude-haiku-4-5/i",
    "/haiku/i",
    "/claude|sonnet|opus|haiku/i",
    "/claude|sonnet|opus|haiku|gpt|gemini/i",
  ],

  // Token-economy gates (adaptive tool set, MCP tool deferral) opt the oldest
  // and smallest models out of schema deferral. This is a plugin cost policy,
  // not a statement about what the model supports, so it does not belong on the
  // seam. Note both occurrences are the SAME literal, deduplicated below.
  "lib/mimicry/request-body.mjs": ["/claude-3-|haiku/i"],
};

describe("no local model-family regexes outside the allowlist", () => {
  it("scans lib/mimicry production sources", () => {
    /** @type {Record<string, string[]>} */
    const found = {};

    for (const file of MIMICRY_FILES) {
      const literals = regexLiteralsIn(stripCommentsAndStrings(readFileSync(file, "utf8")))
        .filter((literal) => FAMILY_TOKEN.test(literal))
        .sort();
      const deduped = [...new Set(literals)];
      if (deduped.length > 0) found[relative(file)] = deduped;
    }

    /** @type {Record<string, string[]>} */
    const expected = {};
    for (const [file, literals] of Object.entries(ALLOWED_FAMILY_REGEXES)) {
      expected[file] = [...new Set(literals)].sort();
    }

    expect(found).toEqual(expected);
  });

  it("does not flag the seam's separator rewrite, which names no family", () => {
    const seam = readFileSync(path.join(repoRoot, "lib", "mimicry", "wire-compat.mjs"), "utf8");
    const literals = regexLiteralsIn(stripCommentsAndStrings(seam));

    expect(literals).toContain("/([A-Za-z0-9])\\.(?=\\d)/g");
    expect(literals.filter((literal) => FAMILY_TOKEN.test(literal))).toEqual([]);
  });

  it("detects a family regex that is not allowlisted", () => {
    const sample = 'const s = "claude-opus-4-9"; // /claude-opus-4-9/i\nif (/claude-opus-4-9/i.test(m)) return true;';
    const literals = regexLiteralsIn(stripCommentsAndStrings(sample)).filter((literal) => FAMILY_TOKEN.test(literal));

    expect(literals).toEqual(["/claude-opus-4-9/i"]);
  });
});
