import { OAUTH_EXPIRY_SKEW_SECONDS } from "./oauth-constants.mjs";

/** The attested 30-second expiry skew, in milliseconds. @see docs/oauth-2.1.280-contract.md §3 */
export const TOKEN_EXPIRY_SKEW_MS = OAUTH_EXPIRY_SKEW_SECONDS * 1000;

/**
 * The single expiry predicate. Every "is this access token still usable?"
 * question in this repository routes through here.
 *
 * ATTESTED: §13.8 (byte 4418342) records `expiry skew (seconds): 30`. A token is
 * therefore treated as expired 30 s before its nominal expiry, so a request is
 * never sent with a credential that dies in flight.
 *
 * WHY leadMs IS A FLOOR AND NOT AN ADDEND. Some callers deliberately refresh far
 * ahead of expiry — a foreground buffer, an idle-refresh window. Adding the skew
 * to those would silently retune them; dropping the skew for them would leave a
 * site that can still call a token valid seconds before it dies. Taking the
 * larger of the two keeps every tuned lead time exactly as it was while
 * guaranteeing the 30 s floor everywhere.
 *
 * A missing or non-numeric `expires` is EXPIRED, not valid: an unknown expiry is
 * not evidence of freshness, and the alternative is sending a dead token.
 *
 * @param {number | null | undefined} expires - Absolute expiry, ms since epoch
 * @param {number} [leadMs=0] - Extra lead time this caller wants
 * @param {number} [now=Date.now()] - Injectable clock for tests
 * @returns {boolean}
 * @see docs/oauth-2.1.280-contract.md §3
 */
export function isTokenExpired(expires, leadMs = 0, now = Date.now()) {
  if (typeof expires !== "number" || !Number.isFinite(expires)) return true;
  const lead = Math.max(Number.isFinite(leadMs) ? leadMs : 0, TOKEN_EXPIRY_SKEW_MS);
  return now >= expires - lead;
}

/**
 * Convenience inverse of {@link isTokenExpired}. Exists so call sites read as
 * the question they are asking instead of as a negation.
 *
 * @param {number | null | undefined} expires
 * @param {number} [leadMs=0]
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isTokenUsable(expires, leadMs = 0, now = Date.now()) {
  return !isTokenExpired(expires, leadMs, now);
}

/**
 * @typedef {import('./storage.mjs').AccountMetadata} AccountMetadata
 * @typedef {import('./storage.mjs').AccountStorage} AccountStorage
 */

/**
 * Reset transient account tracking fields.
 * @param {AccountMetadata} account
 */
export function resetAccountTracking(account) {
  account.rateLimitResetTimes = {};
  account.consecutiveFailures = 0;
  account.lastFailureTime = null;
}

/**
 * Normalize active index after removing one account.
 * NOTE: This operates on the disk-level AccountStorage shape (activeIndex >= 0).
 * AccountManager.removeAccount has its own inline variant using #currentIndex = -1
 * for empty accounts (runtime sentinel). The two are intentionally different.
 * @param {AccountStorage} storage
 * @param {number} removedIndex
 */
export function adjustActiveIndexAfterRemoval(storage, removedIndex) {
  if (storage.accounts.length === 0) {
    storage.activeIndex = 0;
    return;
  }

  if (storage.activeIndex >= storage.accounts.length) {
    storage.activeIndex = storage.accounts.length - 1;
    return;
  }

  if (storage.activeIndex > removedIndex) {
    storage.activeIndex -= 1;
  }
}

/**
 * Apply OAuth credentials to an existing account record.
 * @param {AccountMetadata} account
 * @param {{refresh: string, access: string, expires: number, email?: string}} credentials
 */
export function applyOAuthCredentials(account, credentials) {
  account.refreshToken = credentials.refresh;
  account.access = credentials.access;
  account.expires = credentials.expires;
  account.token_updated_at = Date.now();
  if (credentials.email) {
    account.email = credentials.email;
  }
}
