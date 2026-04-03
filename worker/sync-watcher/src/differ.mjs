/**
 * Contract diff engine with severity classification.
 *
 * Compares two ExtractedContract objects and produces a structured diff
 * with per-field change details and an overall severity classification.
 *
 * Severity rules (§4.4 of the implementation plan):
 *   - none     → contracts are identical
 *   - trivial  → only version and/or buildTime changed
 *   - medium   → sdkVersion changed (or new unknown field)
 *   - high     → beta flags added/removed
 *   - critical → oauth endpoints, identity strings, billingSalt, or clientId changed
 *
 * @module differ
 */

import { SEVERITY } from "./types.mjs";
import { canonicalize } from "./hasher.mjs";

/**
 * @typedef {import('./types.mjs').ExtractedContract} ExtractedContract
 * @typedef {import('./types.mjs').ContractDiff} ContractDiff
 * @typedef {import('./types.mjs').Severity} Severity
 */

// Fields and their severity when changed
const FIELD_SEVERITY = /** @type {Record<string, Severity>} */ ({
  // Scalar fields
  version: SEVERITY.TRIVIAL,
  buildTime: SEVERITY.TRIVIAL,
  sdkVersion: SEVERITY.MEDIUM,
  sdkToken: SEVERITY.MEDIUM,
  billingSalt: SEVERITY.CRITICAL,
  clientId: SEVERITY.CRITICAL,
  // OAuth endpoints
  oauthTokenUrl: SEVERITY.CRITICAL,
  oauthRevokeUrl: SEVERITY.CRITICAL,
  oauthRedirectUri: SEVERITY.CRITICAL,
  oauthConsoleHost: SEVERITY.CRITICAL,
  // System prompt
  systemPromptBoundary: SEVERITY.CRITICAL,
  // Collections — severity set at classification time
  allBetaFlags: SEVERITY.HIGH,
  alwaysOnBetas: SEVERITY.HIGH,
  experimentalBetas: SEVERITY.HIGH,
  bedrockUnsupported: SEVERITY.HIGH,
  claudeAiScopes: SEVERITY.CRITICAL,
  consoleScopes: SEVERITY.CRITICAL,
  identityStrings: SEVERITY.CRITICAL,
});

/** Severity ordering for comparison */
const SEVERITY_ORDER = {
  [SEVERITY.NONE]: 0,
  [SEVERITY.TRIVIAL]: 1,
  [SEVERITY.MEDIUM]: 2,
  [SEVERITY.HIGH]: 3,
  [SEVERITY.CRITICAL]: 4,
};

/**
 * Compare two extracted contracts and return a structured diff.
 *
 * @param {ExtractedContract} baseline - Previously stored contract
 * @param {ExtractedContract} extracted - Freshly extracted contract
 * @returns {ContractDiff}
 */
export function diffContracts(baseline, extracted) {
  /** @type {Record<string, {from: any, to: any}>} */
  const fields = {};
  let maxSeverity = SEVERITY.NONE;

  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(extracted)]);

  for (const key of allKeys) {
    const fromVal = baseline[key] ?? null;
    const toVal = extracted[key] ?? null;

    if (!valuesEqual(fromVal, toVal)) {
      fields[key] = { from: fromVal, to: toVal };

      // Determine severity for this field
      const fieldSev = FIELD_SEVERITY[key] ?? SEVERITY.MEDIUM; // unknown fields = medium
      if (SEVERITY_ORDER[fieldSev] > SEVERITY_ORDER[maxSeverity]) {
        maxSeverity = fieldSev;
      }
    }
  }

  const changed = Object.keys(fields).length > 0;

  // If only trivial fields changed (version + buildTime), severity stays trivial
  // If trivial fields changed AND other fields changed, max severity wins
  return {
    changed,
    severity: changed ? maxSeverity : SEVERITY.NONE,
    fields,
  };
}

/**
 * Check if two values are deeply equal (handles arrays and nulls).
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    // Compare sorted copies for order-independence
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  if (typeof a === "object" && typeof b === "object") {
    // Use canonicalize for deterministic, key-order-independent comparison
    return canonicalize(a) === canonicalize(b);
  }
  return false;
}

/**
 * Check if a diff is trivial (only version/buildTime changed).
 *
 * @param {ContractDiff} diff
 * @returns {boolean}
 */
export function isTrivialDiff(diff) {
  if (!diff.changed) return false;
  const changedKeys = new Set(Object.keys(diff.fields));
  const trivialKeys = new Set(["version", "buildTime"]);
  for (const k of changedKeys) {
    if (!trivialKeys.has(k)) return false;
  }
  return true;
}

/**
 * Fields that can be auto-patched deterministically without LLM involvement.
 *
 * - version / buildTime   — scalar replacement in index.mjs, tests, CHANGELOG
 * - sdkVersion            — ANTHROPIC_SDK_VERSION constant + CLI_TO_SDK_VERSION map in index.mjs
 * - allBetaFlags          — no direct constant; derived from individual flag constants
 * - alwaysOnBetas         — drives individual beta flag constants in index.mjs
 * - experimentalBetas     — EXPERIMENTAL_BETA_FLAGS set in index.mjs
 * - bedrockUnsupported    — BEDROCK_UNSUPPORTED_BETAS set in index.mjs
 *
 * All other fields (oauth endpoints, identity strings, billingSalt, clientId,
 * scopes, systemPromptBoundary, sdkToken) span multiple files with no
 * mechanical replacement pattern and require human/LLM review.
 */
const AUTO_PATCHABLE_FIELDS = new Set([
  "version",
  "buildTime",
  "sdkVersion",
  "allBetaFlags",
  "alwaysOnBetas",
  "experimentalBetas",
  "bedrockUnsupported",
]);

/**
 * Check if a diff can be fully resolved by the automated patcher
 * (i.e. every changed field has a deterministic patch strategy).
 *
 * @param {ContractDiff} diff
 * @returns {boolean}
 */
export function isAutoPatchableDiff(diff) {
  if (!diff.changed) return false;
  for (const k of Object.keys(diff.fields)) {
    if (!AUTO_PATCHABLE_FIELDS.has(k)) return false;
  }
  return true;
}

/**
 * Produce a human-readable summary of a diff for PR/Issue bodies.
 *
 * @param {ContractDiff} diff
 * @returns {string}
 */
export function summarizeDiff(diff) {
  if (!diff.changed) return "No changes detected.";

  const lines = [`**Severity:** ${diff.severity}`, "", "**Changed fields:**"];
  for (const [key, { from, to }] of Object.entries(diff.fields)) {
    const fromStr = JSON.stringify(from);
    const toStr = JSON.stringify(to);
    lines.push(`- \`${key}\`: ${fromStr} → ${toStr}`);
  }
  return lines.join("\n");
}
