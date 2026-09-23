/**
 * OAuth scope sets and conditional extensions transcribed from
 * docs/oauth-2.1.280-contract.md §4 (evidence: byte 4654950 of the 2.1.280 analysis).
 * The base sets and two conditional extensions are attested; array order is
 * offset-attested and must never be sorted. Space-join serialisation is marked
 * [unattested] in §4.1: the arrays are attested, the string they become is not.
 * @module oauth-scopes
 */

/** Offset-attested console base scopes, in wire order. */
export const CONSOLE_BASE_SCOPES = Object.freeze(["org:create_api_key", "user:profile"]);

/** Offset-attested claude.ai base scopes, in wire order. */
export const CLAUDE_AI_BASE_SCOPES = Object.freeze([
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]);

/** Conditional plugin scope appended after the claude.ai base scopes. */
export const PLUGINS_SCOPE = "user:plugins";

/** Conditional project scopes, in offset-attested order. */
export const PROJECT_SCOPES = Object.freeze(["user:projects:read", "user:projects:write"]);

/**
 * Return a fresh claude.ai scope list. The genuine client's default state of
 * PLUGINS_SCOPE_REGISTERED is unattested, so this plugin defaults it off;
 * this choice is divergence D9 in the contract doc.
 * @param {{ pluginsRegistered?: unknown }} [options]
 * @returns {string[]}
 */
export function claudeAiScopes({ pluginsRegistered } = {}) {
  return pluginsRegistered === true ? [...CLAUDE_AI_BASE_SCOPES, PLUGINS_SCOPE] : [...CLAUDE_AI_BASE_SCOPES];
}

/**
 * Select supported project scopes in the attested order, ignoring unknown input.
 * @param {unknown} [requested]
 * @returns {string[]}
 */
export function requestedProjectScopes(requested) {
  if (!Array.isArray(requested)) return [];
  // Filtering PROJECT_SCOPES also prevents duplicate input from duplicating output.
  return PROJECT_SCOPES.filter((scope) => requested.includes(scope));
}

/**
 * Single composition seam. The default (no options) output, when serialized,
 * must be byte-identical to the pre-Wave-2 five-scope string: the no-regression
 * guarantee.
 * @param {{ mode?: string, pluginsRegistered?: unknown, projectScopes?: unknown }} [options]
 * @returns {string[]}
 */
export function composeScopes({ mode, pluginsRegistered, projectScopes } = {}) {
  // Project scopes must never leak into a console authorize URL; ignore both extensions.
  if (mode === "console") return [...CONSOLE_BASE_SCOPES];
  const scopes = [...claudeAiScopes({ pluginsRegistered }), ...requestedProjectScopes(projectScopes)];
  // Set iterates in insertion order, safely preserving the first occurrence.
  return [...new Set(scopes)];
}

/**
 * The ONLY place a scope list is turned into a string: a single seam means
 * the wire format has one owner. Space-join serialisation is [unattested] (§4.1).
 * @param {readonly string[] | null} [list]
 * @returns {string}
 */
export function serializeScopes(list) {
  return list == null ? "" : list.join(" ");
}
