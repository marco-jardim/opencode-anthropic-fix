/**
 * OAuth scope sets and conditional extensions transcribed from
 * docs/oauth-2.1.280-contract.md §4 (evidence: byte 4654950 of the 2.1.280 analysis).
 *
 * WHAT IS ATTESTED: the two base arrays and their element order, the *names* of
 * the three conditional extensions, and the condition under which each is added.
 *
 * WHAT IS NOT ATTESTED, and is this plugin's own choice:
 *   - the position of `user:plugins` relative to the project scopes when both
 *     gates fire;
 *   - the order of `user:projects:read` against `user:projects:write`;
 *   - the space-join into the `scope` query parameter.
 * All three are wire-visible. They are recorded as divergence D13 in §7 of the
 * contract doc so that a future maintainer does not mistake them for evidence.
 *
 * Base-set order is offset-attested and must never be sorted.
 * @module oauth-scopes
 */

/** Offset-attested console base scopes, in wire order (byte 4654950). */
export const CONSOLE_BASE_SCOPES = Object.freeze(["org:create_api_key", "user:profile"]);

/** Offset-attested claude.ai base scopes, in wire order (byte 4654950). */
export const CLAUDE_AI_BASE_SCOPES = Object.freeze([
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]);

/**
 * Conditional plugin scope. §13.8 attests the name and the gate; it does not
 * attest the append position. Appending last is this plugin's choice (D13).
 */
export const PLUGINS_SCOPE = "user:plugins";

/**
 * Conditional project scopes. §13.8 attests both names and that they are added
 * only when requested and allowed; the read-before-write order is this plugin's
 * choice (D13), made so that the emitted string is deterministic.
 */
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
 * Select supported project scopes in the canonical order, ignoring unknown input.
 *
 * Iteration is over PROJECT_SCOPES, never over `requested`, so caller order and
 * caller duplicates cannot reach the wire.
 * @param {unknown} [requested]
 * @returns {string[]}
 */
export function requestedProjectScopes(requested) {
  if (!Array.isArray(requested)) return [];
  return PROJECT_SCOPES.filter((scope) => requested.includes(scope));
}

/**
 * Single composition seam. The default (no options) output, when serialized,
 * must be byte-identical to the pre-Wave-2 five-scope string: the no-regression
 * guarantee.
 *
 * An unrecognised `mode` throws rather than falling through to the claude.ai
 * set: silently emitting consumer scopes for a mode the caller mistyped would
 * send a wrong scope string to a real authorize endpoint.
 * @param {{ mode?: string, pluginsRegistered?: unknown, projectScopes?: unknown } | null} [options]
 * @returns {string[]}
 */
export function composeScopes(options) {
  const { mode, pluginsRegistered, projectScopes } = options ?? {};
  if (mode !== undefined && mode !== "max" && mode !== "console") {
    throw new Error(`Unknown OAuth mode "${mode}" (expected "max" or "console")`);
  }
  // Project scopes must never leak into a console authorize URL; ignore both extensions.
  if (mode === "console") return [...CONSOLE_BASE_SCOPES];
  const scopes = [...claudeAiScopes({ pluginsRegistered }), ...requestedProjectScopes(projectScopes)];
  // The three scope pools are disjoint today, so this dedupe is a no-op — it is
  // kept as a structural guarantee that the seam can never emit a repeated
  // scope if a future extension overlaps. `Set` iterates in insertion order, so
  // the first occurrence keeps its position. A test pins the disjointness.
  return [...new Set(scopes)];
}

/**
 * The only place the authorize `scope` parameter is serialised: one seam means
 * the wire format has one owner. Space-join serialisation is [unattested] (§4.1).
 * @param {readonly string[] | null} [list]
 * @returns {string}
 */
export function serializeScopes(list) {
  return list == null ? "" : list.join(" ");
}
