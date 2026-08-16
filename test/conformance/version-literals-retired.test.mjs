import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { WIRE_PROFILE } from "../../lib/mimicry/wire-compat.mjs";

/**
 * GOVERNANCE GUARD for hardcoded Claude Code protocol versions.
 *
 * The emulated CLI version and the user-agent it composes are WIRE state: they
 * belong to the protocol profile the wire package ships
 * (`CLAUDE_CODE_2_1_233_PROFILE`, re-exported as `WIRE_PROFILE` through
 * `lib/mimicry/wire-compat.mjs`). Phase 3.3 removed the last re-typed copies
 * from `lib/mimicry/adapter-input.mjs`; every consumer now READS the profile,
 * so a package bump moves the plugin without a source edit.
 *
 * Nothing in the language stops the next contributor from typing `"2.1.233"`
 * back into a module and re-opening the drift — the failure mode is silent
 * (a spurious `profileOverride` on every request, or a beta header the package
 * no longer composes). This file is the ratchet: after comments are stripped,
 * production code may contain neither a `claude-cli/` user-agent literal nor a
 * `2.1.<NN>` version literal unless it is listed below WITH A REASON.
 *
 * A new allowlist entry is not forbidden — it is a REVIEW PROMPT. If the
 * profile or the beta registry can answer the question, use the seam instead.
 *
 * Scope: `index.mjs`, `cli.mjs`, `lib/**` production sources. Tests, docs and
 * the CHANGELOG are deliberately OUT of scope: pinning the current version as a
 * literal expectation is exactly what a test is for (see the profile-propagation
 * suite in `lib/mimicry/adapter-input.test.mjs`), and prose must be free to name
 * the binary it was reverse-engineered from.
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

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Drop line and block comments while PRESERVING string and template literals —
 * the opposite bias of the model-regex guard, because the literals this file
 * hunts (`claude-cli/2.1.233 (external, cli)`) live inside strings.
 *
 * Strings are matched by the same alternation as comments, so a `//` inside a
 * URL (`"https://api.anthropic.com"`) is never read as a comment opener, and a
 * `'` inside a comment (`// real CC's Ukd`) is never read as a string opener.
 *
 * ALL quoted alternatives are LINE-BOUNDED on purpose, including the template
 * literal. An unbalanced quote or backtick in executable code (inside a regex
 * character class, say) then simply fails to match, instead of putting the
 * scanner into string mode for the remainder of the file and silently
 * resurrecting every comment it swallows on the way — which is exactly what a
 * multi-line-capable backtick rule did here, reviving two `v2.1.x` prose
 * mentions in `lib/mimicry/system-prompt.mjs`.
 *
 * The tradeoff is that a `//` INSIDE a multi-line template literal is stripped
 * as if it were a comment. Both literals this guard hunts are single-line by
 * construction (a user-agent string, a version string), so the blind spot is
 * unreachable in practice, and erring toward stripping keeps false ALARMS out
 * of a guard whose whole value is that a failure means something.
 *
 * Comments are replaced by their own newlines so reported line context stays
 * aligned with the file.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  const TOKEN = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(TOKEN, (match) => {
    if (!match.startsWith("//") && !match.startsWith("/*")) return match;
    return "\n".repeat((match.match(/\n/g) ?? []).length);
  });
}

// ---------------------------------------------------------------------------
// The two banned shapes
// ---------------------------------------------------------------------------

/** The Claude Code user-agent prefix, in any form. */
const USER_AGENT_LITERAL = /claude-cli\//g;

/** A Claude Code 2.1.x version literal (`2.1.233`, `2.1.195`, …). */
const CC_VERSION_LITERAL = /2\.1\.\d{2,}/g;

/**
 * Files allowed to keep a `claude-cli/` literal, with the reason.
 *
 * Both entries are the SAME user-agent FORMAT string with the version
 * interpolated (`` `claude-cli/${version} (external, …)` ``) — the format is
 * pinned by the package's own goldens, the version is not present. Neither is a
 * version literal; forbidding the format outright would mean deleting the
 * composition itself.
 *
 * @type {Record<string, number>}
 */
const ALLOWED_USER_AGENT_LITERALS = {
  // The legacy header forge, frozen as a compat exception in Phase 3.2 (see the
  // module banner). `buildExtendedUserAgent` takes the version as a PARAMETER;
  // only the format lives here.
  "lib/mimicry/headers.mjs": 1,

  // `buildAdapterUserAgent` is the pure mirror of the frozen forge above, pinned
  // to agree with it by `adapter-input.test.mjs`. Its version argument resolves
  // to `WIRE_PROFILE.cliVersion` when the host detects nothing.
  "lib/mimicry/adapter-input.mjs": 1,
};

/**
 * Files allowed to keep a `2.1.<NN>` version literal, with the reason.
 *
 * EMPTY BY DESIGN. The emulated version has exactly one source — the profile —
 * and every production consumer reads it through the seam. An entry here means
 * a module re-typed the version and must justify why the profile could not
 * answer.
 *
 * @type {Record<string, number>}
 */
const ALLOWED_VERSION_LITERALS = {};

/** @param {string} source @param {RegExp} pattern @returns {number} */
function countMatches(source, pattern) {
  return (source.match(new RegExp(pattern.source, "g")) ?? []).length;
}

/**
 * The matched literal plus its surrounding line, so a failure names the offender
 * instead of just counting it.
 *
 * @param {string} source
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function matchContexts(source, pattern) {
  /** @type {string[]} */
  const out = [];
  for (const line of source.split("\n")) {
    if (new RegExp(pattern.source).test(line)) out.push(line.trim().slice(0, 120));
  }
  return out;
}

/** @param {RegExp} pattern @returns {Record<string, number>} */
function scanProduction(pattern) {
  /** @type {Record<string, number>} */
  const found = {};
  for (const file of PRODUCTION_FILES) {
    const count = countMatches(stripComments(readFileSync(file, "utf8")), pattern);
    if (count > 0) found[relative(file)] = count;
  }
  return found;
}

/** @param {RegExp} pattern @returns {Record<string, string[]>} */
function scanProductionContexts(pattern) {
  /** @type {Record<string, string[]>} */
  const found = {};
  for (const file of PRODUCTION_FILES) {
    const contexts = matchContexts(stripComments(readFileSync(file, "utf8")), pattern);
    if (contexts.length > 0) found[relative(file)] = contexts;
  }
  return found;
}

describe("Claude Code version literals are retired from production code", () => {
  it("keeps `claude-cli/` only in the two user-agent composition sites", () => {
    expect(scanProduction(USER_AGENT_LITERAL)).toEqual(ALLOWED_USER_AGENT_LITERALS);
  });

  it("keeps no `2.1.<NN>` version literal anywhere in production code", () => {
    expect(scanProductionContexts(CC_VERSION_LITERAL)).toEqual({});
    expect(scanProduction(CC_VERSION_LITERAL)).toEqual(ALLOWED_VERSION_LITERALS);
  });

  it("still emulates the profile version it always did — the value moved, not changed", () => {
    expect(WIRE_PROFILE.cliVersion).toBe("2.1.233");
    expect(WIRE_PROFILE.userAgent).toBe("claude-cli/2.1.233 (external, cli)");
  });
});

describe("the scanner itself", () => {
  it("strips comments but preserves string bodies", () => {
    const sample = [
      "// claude-cli/2.1.233",
      "/* 2.1.195 */",
      'const ua = "claude-cli/9.9.9";',
      'const url = "https://api.anthropic.com/v1/messages"; // 2.1.233',
    ].join("\n");
    const stripped = stripComments(sample);

    expect(countMatches(stripped, USER_AGENT_LITERAL)).toBe(1);
    expect(countMatches(stripped, CC_VERSION_LITERAL)).toBe(0);
    expect(stripped).toContain("https://api.anthropic.com/v1/messages");
  });

  it("catches a re-typed version literal", () => {
    const offender = 'const PROFILE_CLI_VERSION = "2.1.233";';

    expect(countMatches(stripComments(offender), CC_VERSION_LITERAL)).toBe(1);
  });

  it("does not resurrect later comments after an unbalanced quote or backtick", () => {
    const sample = ["const RE = /[`'\"]/;", "// prose about CC v2.1.195", 'const ua = "claude-cli/9.9.9";'].join("\n");
    const stripped = stripComments(sample);

    expect(countMatches(stripped, CC_VERSION_LITERAL)).toBe(0);
    expect(countMatches(stripped, USER_AGENT_LITERAL)).toBe(1);
  });
});
