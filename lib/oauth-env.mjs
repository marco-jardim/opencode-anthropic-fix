/**
 * OAuth environment surface from docs/oauth-2.1.280-contract.md §5: the
 * allowlist and two local bases (evidence bytes 4657393 and 4656690).
 * Comparison semantics are [unattested]; exact equality is the narrowest
 * defensible reading. The rejection message is byte-exact because it is
 * attested verbatim.
 */
import {
  OAUTH_CLIENT_ID,
  OAUTH_CUSTOM_URL_ALLOWLIST,
  OAUTH_CUSTOM_URL_REJECTION_MESSAGE,
  OAUTH_LOCAL_APPS_BASE_DEFAULT,
  OAUTH_LOCAL_CONSOLE_BASE_DEFAULT,
} from "./oauth-constants.mjs";
import { CLAUDE_AI_BASE_SCOPES } from "./oauth-scopes.mjs";

/**
 * Reject anything outside the exact, unnormalised allowlist.
 * @param {string} url
 * @returns {string}
 */
export function assertApprovedOAuthUrl(url) {
  if (!OAUTH_CUSTOM_URL_ALLOWLIST.includes(url)) {
    throw new Error(OAUTH_CUSTOM_URL_REJECTION_MESSAGE);
  }
  return url;
}

/**
 * An absent or blank variable is not configured; otherwise validate the raw value.
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function resolveCustomOAuthUrl(env) {
  const url = env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  if (url === undefined || url.trim() === "") return undefined;
  return assertApprovedOAuthUrl(url);
}

/**
 * This activation predicate is [unattested]: §13.8 records the two variables
 * and their defaults but not what activates them. Setting either variable to
 * a non-blank value is itself the opt-in, so an entirely unset environment
 * can never silently redirect a production login to localhost. The documented
 * defaults are only reachable once the mode is already active, which is why
 * they cannot leak on their own.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isLocalOAuthDevMode(env) {
  return Boolean(env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.trim() || env.CLAUDE_LOCAL_OAUTH_CONSOLE_BASE?.trim());
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function resolveAppsBase(env) {
  if (!isLocalOAuthDevMode(env)) return undefined;
  // Console-only opt-in deliberately selects the documented apps default, not production.
  return env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.trim() || OAUTH_LOCAL_APPS_BASE_DEFAULT;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function resolveConsoleBase(env) {
  if (!isLocalOAuthDevMode(env)) return undefined;
  // Apps-only opt-in likewise selects the documented console default, not production.
  return env.CLAUDE_LOCAL_OAUTH_CONSOLE_BASE?.trim() || OAUTH_LOCAL_CONSOLE_BASE_DEFAULT;
}

/** Environment variable carrying a pre-issued refresh token. @see docs/oauth-2.1.280-contract.md §5.2 */
export const HEADLESS_REFRESH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_REFRESH_TOKEN";

/** Environment variable declaring the scopes that token was granted. @see docs/oauth-2.1.280-contract.md §5.2 */
export const HEADLESS_SCOPES_VAR = "CLAUDE_CODE_OAUTH_SCOPES";

/** Environment variable overriding the OAuth client id. @see docs/oauth-2.1.280-contract.md §5.2 */
export const HEADLESS_CLIENT_ID_VAR = "CLAUDE_CODE_OAUTH_CLIENT_ID";

/**
 * Resolve a headless (non-interactive) login declared entirely by environment.
 *
 * ATTESTATION. §13.8 records the three variable NAMES (contract §5.2). It does
 * NOT record the parsing rules, the required-ness of the scope list, or any
 * error text. Those are this plugin's choices, recorded as divergence D10.
 *
 * WHY THE SCOPE LIST IS REQUIRED. The operator, not this plugin, knows which
 * scopes the injected token actually carries. Defaulting it would be an
 * invention, and a token silently missing `user:inference` would fail at the
 * first request instead of at boot.
 *
 * WHERE THE SCOPES ARE USED. Verbatim, and only as a boot-time declaration
 * check. They are never re-composed through `composeScopes()` and they MUST
 * NEVER reach a refresh body: the attested refresh body (byte 4429828) has
 * exactly three keys and no `scope` — contract §2.3 and divergence D5.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {{refreshToken: string, scopes: string[], clientId: string} | undefined}
 *   `undefined` when no refresh token is declared.
 * @throws {Error} when a refresh token is declared without a usable scope list.
 */
export function resolveHeadlessLogin(env) {
  const rawToken = env?.[HEADLESS_REFRESH_TOKEN_VAR];
  const refreshToken = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!refreshToken) return undefined;

  const rawScopes = env?.[HEADLESS_SCOPES_VAR];
  const scopes = typeof rawScopes === "string" ? rawScopes.trim().split(/\s+/).filter(Boolean) : [];
  if (scopes.length === 0) {
    throw new Error(
      `${HEADLESS_REFRESH_TOKEN_VAR} is set but ${HEADLESS_SCOPES_VAR} is missing. Set ${HEADLESS_SCOPES_VAR} to the space-separated scope list that token was granted, for example: ${CLAUDE_AI_BASE_SCOPES.join(" ")}`,
    );
  }

  const granted = new Set(scopes);
  const missing = CLAUDE_AI_BASE_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new Error(
      `${HEADLESS_SCOPES_VAR} does not declare every scope this plugin requires. Missing: ${missing.join(", ")}. Re-authorise the token with the full set, or correct ${HEADLESS_SCOPES_VAR}.`,
    );
  }

  const rawClientId = env?.[HEADLESS_CLIENT_ID_VAR];
  const trimmedClientId = typeof rawClientId === "string" ? rawClientId.trim() : "";
  return { refreshToken, scopes, clientId: trimmedClientId || OAUTH_CLIENT_ID };
}
