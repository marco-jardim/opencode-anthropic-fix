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
