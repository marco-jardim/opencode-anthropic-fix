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
import { CLAUDE_AI_BASE_SCOPES, missingBaseScopes } from "./oauth-scopes.mjs";

/**
 * Read one environment entry as a trimmed string.
 *
 * A non-string value is treated as absent rather than thrown on: `env` is an
 * arbitrary caller-supplied object in tests and a `ProcessEnv` in production,
 * and the two disagree about what a "set" variable can hold.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @param {string} key
 * @returns {string} the trimmed value, or `""` when absent or not a string
 */
function readEnv(env, key) {
  const raw = env?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

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
  if (readEnv(env, "CLAUDE_CODE_CUSTOM_OAUTH_URL") === "") return undefined;
  // The RAW value is compared, never the trimmed one: normalising here would
  // widen the allowlist beyond what the genuine client accepts.
  return assertApprovedOAuthUrl(env.CLAUDE_CODE_CUSTOM_OAUTH_URL);
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
  return Boolean(readEnv(env, "CLAUDE_LOCAL_OAUTH_APPS_BASE") || readEnv(env, "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE"));
}

/** Origins a CLAUDE_LOCAL_OAUTH_*_BASE may name. @see docs/oauth-2.1.280-contract.md §5 */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/**
 * Refuse a local-dev base that is not a loopback origin.
 *
 * §13.8 records the two variables and their localhost defaults but nothing about
 * validation, so this guard is [unattested]. It exists because the alternative is
 * strictly worse: an unvalidated base lets any environment that can set one
 * variable redirect a production OAuth flow to an arbitrary host, which is the
 * exact class of defect the CLAUDE_CODE_CUSTOM_OAUTH_URL allowlist exists to
 * prevent. Refusing a non-loopback value is the narrowest reading of "LOCAL".
 *
 * @param {string} base
 * @param {string} varName
 * @returns {string}
 */
function assertLoopbackBase(base, varName) {
  if (!LOOPBACK_ORIGIN.test(base)) {
    throw new Error(
      `${varName} must be a loopback origin such as http://localhost:4000, http://127.0.0.1:4000 or http://[::1]:4000. Received: ${base}`,
    );
  }
  return base;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function resolveAppsBase(env) {
  if (!isLocalOAuthDevMode(env)) return undefined;
  // Console-only opt-in deliberately selects the documented apps default, not production.
  return assertLoopbackBase(
    readEnv(env, "CLAUDE_LOCAL_OAUTH_APPS_BASE") || OAUTH_LOCAL_APPS_BASE_DEFAULT,
    "CLAUDE_LOCAL_OAUTH_APPS_BASE",
  );
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function resolveConsoleBase(env) {
  if (!isLocalOAuthDevMode(env)) return undefined;
  // Apps-only opt-in likewise selects the documented console default, not production.
  return assertLoopbackBase(
    readEnv(env, "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE") || OAUTH_LOCAL_CONSOLE_BASE_DEFAULT,
    "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  );
}

/** Environment variable carrying a pre-issued refresh token. @see docs/oauth-2.1.280-contract.md §5.2 */
export const HEADLESS_REFRESH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_REFRESH_TOKEN";

/** Environment variable declaring the scopes that token was granted. @see docs/oauth-2.1.280-contract.md §5.2 */
export const HEADLESS_SCOPES_VAR = "CLAUDE_CODE_OAUTH_SCOPES";

/** Environment variable overriding the OAuth client id. @see docs/oauth-2.1.280-contract.md §5.2 */
export const HEADLESS_CLIENT_ID_VAR = "CLAUDE_CODE_OAUTH_CLIENT_ID";

/** One-shot latch: an incomplete headless scope declaration warns once per process, not once per load. */
let headlessScopeWarningEmitted = false;

/** Reset the one-shot scope warning. Exported for tests only. */
export function resetHeadlessScopeWarning() {
  headlessScopeWarningEmitted = false;
}

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
  const refreshToken = readEnv(env, HEADLESS_REFRESH_TOKEN_VAR);
  if (!refreshToken) return undefined;

  const scopes = readEnv(env, HEADLESS_SCOPES_VAR).split(/\s+/).filter(Boolean);
  if (scopes.length === 0) {
    throw new Error(
      `${HEADLESS_REFRESH_TOKEN_VAR} is set but ${HEADLESS_SCOPES_VAR} is missing. Set ${HEADLESS_SCOPES_VAR} to the space-separated scope list that token was granted, for example: ${CLAUDE_AI_BASE_SCOPES.join(" ")}`,
    );
  }

  // An incomplete declaration warns rather than throwing. The scope list is a
  // declaration about a token this plugin did not issue: it may legitimately be
  // a console-issued token with a different set, and refusing to start would
  // take every unrelated stored account down with it.
  const missing = missingBaseScopes(scopes);
  if (missing.length > 0 && !headlessScopeWarningEmitted) {
    headlessScopeWarningEmitted = true;
    console.warn(
      `[anthropic-auth] ${HEADLESS_SCOPES_VAR} does not declare every scope this plugin normally requires. Missing: ${missing.join(", ")}. Requests needing those scopes will fail at the server.`,
    );
  }

  const trimmedClientId = readEnv(env, HEADLESS_CLIENT_ID_VAR);
  return { refreshToken, scopes, clientId: trimmedClientId || OAUTH_CLIENT_ID };
}
