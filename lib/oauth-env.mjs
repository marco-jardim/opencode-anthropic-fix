/**
 * OAuth environment surface from docs/oauth-2.1.280-contract.md §5: the
 * allowlist and two local bases (evidence bytes 4657393 and 4656690).
 * Comparison semantics are [unattested]; exact equality is the narrowest
 * defensible reading. The rejection message is byte-exact because it is
 * attested verbatim.
 */
import {
  OAUTH_CUSTOM_URL_ALLOWLIST,
  OAUTH_CUSTOM_URL_REJECTION_MESSAGE,
  OAUTH_LOCAL_APPS_BASE_DEFAULT,
  OAUTH_LOCAL_CONSOLE_BASE_DEFAULT,
} from "./oauth-constants.mjs";

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
