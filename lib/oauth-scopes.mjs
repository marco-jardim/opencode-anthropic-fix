/**
 * OAuth scope sets transcribed from docs/oauth-2.1.280-contract.md §4 and
 * corrected by docs/oauth-2.1.329-contract.md §3.
 *
 * WHAT IS ATTESTED (genuine bundle, both 2.1.280 and 2.1.329): the two base
 * arrays and their element order, and that the authorize URL ALWAYS carries the
 * de-duplicated union `[...console, ...claude.ai, user:plugins]` for BOTH the
 * console and the claude.ai login. 2.1.329 appends further registered scopes
 * after `user:plugins` (see PRIVACY_CONSENTS_SCOPE / DESKTOP_CONFIG_SCOPE); the
 * caller supplies those through `extraScopes`.
 *
 * `user:projects:read` / `user:projects:write` appear only in the genuine
 * allowed-extras filter and are never part of a login request, so this module
 * has no way to emit them.
 *
 * Base-set order is offset-attested and must never be sorted.
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

/**
 * Plugin scope. A normal default in the genuine client (the registered gate is
 * on in the production config); only an explicit `pluginsRegistered: false`
 * removes it.
 */
export const PLUGINS_SCOPE = "user:plugins";

/**
 * Scope added to the genuine default login set from 2.1.329. Exported for the
 * release repoint; the composition seam only emits it when passed through
 * `extraScopes`.
 */
export const PRIVACY_CONSENTS_SCOPE = "user:privacy_consents:write";

/**
 * Scope added to the genuine default login set from 2.1.329 (hybrid settings).
 * Exported for the release repoint; emitted only through `extraScopes`.
 */
export const DESKTOP_CONFIG_SCOPE = "org:desktop_config";

/**
 * Scopes a refresh requests when the account has no stored grant: the
 * claude.ai base set plus `user:plugins` (genuine `ufn()` default).
 */
export const DEFAULT_REFRESH_SCOPES = Object.freeze([...CLAUDE_AI_BASE_SCOPES, PLUGINS_SCOPE]);

/**
 * Return a fresh claude.ai scope list, with `user:plugins` appended when
 * `pluginsRegistered` is literally true.
 * @param {{ pluginsRegistered?: unknown }} [options]
 * @returns {string[]}
 */
export function claudeAiScopes({ pluginsRegistered } = {}) {
  return pluginsRegistered === true ? [...CLAUDE_AI_BASE_SCOPES, PLUGINS_SCOPE] : [...CLAUDE_AI_BASE_SCOPES];
}

/**
 * Single composition seam for the authorize `scope` parameter.
 *
 * The result is identical for `max` and `console`: the genuine client sends the
 * union in both modes. The order is console base, claude.ai base, `user:plugins`
 * (omitted only when `pluginsRegistered === false`), then `extraScopes`; the
 * first occurrence of a duplicate keeps its position.
 *
 * An unrecognised `mode` throws rather than being ignored: a mistyped mode is a
 * programmer error and must not silently pick a scope string.
 * @param {{ mode?: string, pluginsRegistered?: unknown, extraScopes?: unknown } | null} [options]
 * @returns {string[]}
 */
export function composeScopes(options) {
  const { mode, pluginsRegistered, extraScopes } = options ?? {};
  if (mode !== undefined && mode !== "max" && mode !== "console") {
    throw new Error(`Unknown OAuth mode "${mode}" (expected "max" or "console")`);
  }
  const extras = Array.isArray(extraScopes)
    ? extraScopes.filter((scope) => typeof scope === "string" && scope.length > 0)
    : [];
  const scopes = [
    ...CONSOLE_BASE_SCOPES,
    ...CLAUDE_AI_BASE_SCOPES,
    ...(pluginsRegistered === false ? [] : [PLUGINS_SCOPE]),
    ...extras,
  ];
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

/**
 * Which of the five attested claude.ai base scopes are absent from `scopes`.
 *
 * Single seam so the refresh-time check (`hasRequiredScopes`) and the headless
 * boot-time check cannot drift apart. Returns entries in `CLAUDE_AI_BASE_SCOPES`
 * order, never caller order, so the resulting message is deterministic.
 *
 * @param {string[] | undefined | null} scopes
 * @returns {string[]}
 * @see docs/oauth-2.1.280-contract.md §4.1
 */
export function missingBaseScopes(scopes) {
  const granted = new Set(Array.isArray(scopes) ? scopes : []);
  return CLAUDE_AI_BASE_SCOPES.filter((scope) => !granted.has(scope));
}
