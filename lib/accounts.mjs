import { loadAccounts, saveAccounts } from "./storage.mjs";
import { HealthScoreTracker, TokenBucketTracker, selectAccount } from "./rotation.mjs";
import { calculateBackoffMs, parseRateLimitReason, parseRetryAfterHeader } from "./backoff.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";

/**
 * @typedef {import('./config.mjs').AnthropicAuthConfig} AnthropicAuthConfig
 * @typedef {import('./config.mjs').AccountSelectionStrategy} AccountSelectionStrategy
 * @typedef {import('./storage.mjs').AccountMetadata} AccountMetadata
 * @typedef {import('./storage.mjs').AccountStorage} AccountStorage
 * @typedef {import('./backoff.mjs').RateLimitReason} RateLimitReason
 */

/**
 * @typedef {object} ManagedAccount
 * @property {number} index
 * @property {string} [email]
 * @property {string} refreshToken
 * @property {string} [access]
 * @property {number} [expires]
 * @property {number} addedAt
 * @property {number} lastUsed
 * @property {boolean} enabled
 * @property {Record<string, number>} rateLimitResetTimes
 * @property {number} consecutiveFailures
 * @property {number | null} lastFailureTime
 * @property {string} [lastSwitchReason]
 */

const MAX_ACCOUNTS = 10;
const RATE_LIMIT_KEY = "anthropic";

export class AccountManager {
  /** @type {ManagedAccount[]} */
  #accounts = [];
  /** @type {number} */
  #cursor = 0;
  /** @type {number} */
  #currentIndex = -1;
  /** @type {HealthScoreTracker} */
  #healthTracker;
  /** @type {TokenBucketTracker} */
  #tokenTracker;
  /** @type {AnthropicAuthConfig} */
  #config;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #saveTimeout = null;

  /**
   * @param {AnthropicAuthConfig} config
   */
  constructor(config) {
    this.#config = config;
    this.#healthTracker = new HealthScoreTracker(config.health_score);
    this.#tokenTracker = new TokenBucketTracker(config.token_bucket);
  }

  /**
   * Load accounts from disk, optionally merging with an OpenCode auth fallback.
   * @param {AnthropicAuthConfig} config
   * @param {{refresh: string, access?: string, expires?: number} | null} [authFallback]
   * @returns {Promise<AccountManager>}
   */
  static async load(config, authFallback) {
    const manager = new AccountManager(config);
    const stored = await loadAccounts();

    if (stored && stored.accounts.length > 0) {
      manager.#accounts = stored.accounts.map((acc, index) => ({
        index,
        email: acc.email,
        refreshToken: acc.refreshToken,
        access: undefined,
        expires: undefined,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        enabled: acc.enabled,
        rateLimitResetTimes: acc.rateLimitResetTimes,
        consecutiveFailures: acc.consecutiveFailures,
        lastFailureTime: acc.lastFailureTime,
        lastSwitchReason: acc.lastSwitchReason,
      }));

      manager.#currentIndex = Math.min(
        stored.activeIndex,
        manager.#accounts.length - 1,
      );

      // If we have a fallback auth, match it to an existing account and set tokens
      if (authFallback) {
        const match = manager.#accounts.find(
          (acc) => acc.refreshToken === authFallback.refresh,
        );
        if (match) {
          match.access = authFallback.access;
          match.expires = authFallback.expires;
        }
      }

      return manager;
    }

    // No stored accounts — bootstrap from fallback if available
    if (authFallback && authFallback.refresh) {
      const now = Date.now();
      manager.#accounts = [
        {
          index: 0,
          email: undefined,
          refreshToken: authFallback.refresh,
          access: authFallback.access,
          expires: authFallback.expires,
          addedAt: now,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
          lastSwitchReason: "initial",
        },
      ];
      manager.#currentIndex = 0;
    }

    return manager;
  }

  /**
   * Get the number of enabled accounts.
   * @returns {number}
   */
  getAccountCount() {
    return this.#accounts.filter((acc) => acc.enabled).length;
  }

  /**
   * Get the total number of accounts (including disabled).
   * @returns {number}
   */
  getTotalAccountCount() {
    return this.#accounts.length;
  }

  /**
   * Get a snapshot of all accounts (for display/management).
   * @returns {ManagedAccount[]}
   */
  getAccountsSnapshot() {
    return this.#accounts.map((acc) => ({ ...acc }));
  }

  /**
   * Get the current active account index.
   * @returns {number}
   */
  getCurrentIndex() {
    return this.#currentIndex;
  }

  /**
   * Clear expired rate limits for an account.
   * @param {ManagedAccount} account
   */
  #clearExpiredRateLimits(account) {
    const now = Date.now();
    for (const key of Object.keys(account.rateLimitResetTimes)) {
      if (account.rateLimitResetTimes[key] <= now) {
        delete account.rateLimitResetTimes[key];
      }
    }
  }

  /**
   * Check if an account is currently rate-limited.
   * @param {ManagedAccount} account
   * @returns {boolean}
   */
  #isRateLimited(account) {
    this.#clearExpiredRateLimits(account);
    const resetTime = account.rateLimitResetTimes[RATE_LIMIT_KEY];
    return resetTime !== undefined && Date.now() < resetTime;
  }

  /**
   * Select the best account for the current request.
   * @returns {ManagedAccount | null}
   */
  getCurrentAccount() {
    if (this.#accounts.length === 0) return null;

    // Build candidates list
    const candidates = this.#accounts
      .filter((acc) => acc.enabled)
      .map((acc) => {
        this.#clearExpiredRateLimits(acc);
        return {
          index: acc.index,
          lastUsed: acc.lastUsed,
          healthScore: this.#healthTracker.getScore(acc.index),
          isRateLimited: this.#isRateLimited(acc),
          enabled: acc.enabled,
        };
      });

    const result = selectAccount(
      candidates,
      this.#config.account_selection_strategy,
      this.#currentIndex >= 0 ? this.#currentIndex : null,
      this.#healthTracker,
      this.#tokenTracker,
      this.#cursor,
    );

    if (!result) return null;

    this.#cursor = result.cursor;
    this.#currentIndex = result.index;

    const account = this.#accounts[result.index];
    if (account) {
      account.lastUsed = Date.now();
      this.#tokenTracker.consume(account.index);
    }

    return account ?? null;
  }

  /**
   * Mark an account as rate-limited.
   * @param {ManagedAccount} account
   * @param {RateLimitReason} reason
   * @param {number | null} [retryAfterMs]
   * @returns {number} The backoff duration in ms
   */
  markRateLimited(account, reason, retryAfterMs) {
    const now = Date.now();

    // Reset consecutive failures if TTL has expired
    if (
      account.lastFailureTime !== null &&
      now - account.lastFailureTime > this.#config.failure_ttl_seconds * 1000
    ) {
      account.consecutiveFailures = 0;
    }

    account.consecutiveFailures += 1;
    account.lastFailureTime = now;

    const backoffMs = calculateBackoffMs(
      reason,
      account.consecutiveFailures - 1,
      retryAfterMs,
    );

    account.rateLimitResetTimes[RATE_LIMIT_KEY] = now + backoffMs;

    this.#healthTracker.recordRateLimit(account.index);

    this.requestSaveToDisk();

    return backoffMs;
  }

  /**
   * Mark a successful request for an account.
   * @param {ManagedAccount} account
   */
  markSuccess(account) {
    account.consecutiveFailures = 0;
    account.lastFailureTime = null;
    this.#healthTracker.recordSuccess(account.index);
  }

  /**
   * Mark a general failure (not rate limit) for an account.
   * @param {ManagedAccount} account
   */
  markFailure(account) {
    this.#healthTracker.recordFailure(account.index);
    this.#tokenTracker.refund(account.index);
  }

  /**
   * Add a new account to the pool.
   * @param {string} refreshToken
   * @param {string} accessToken
   * @param {number} expires
   * @param {string} [email]
   * @returns {ManagedAccount | null} The new account, or null if at capacity
   */
  addAccount(refreshToken, accessToken, expires, email) {
    if (this.#accounts.length >= MAX_ACCOUNTS) return null;

    // Check for duplicate refresh token
    const existing = this.#accounts.find(
      (acc) => acc.refreshToken === refreshToken,
    );
    if (existing) {
      existing.access = accessToken;
      existing.expires = expires;
      if (email) existing.email = email;
      existing.enabled = true;
      return existing;
    }

    const now = Date.now();
    /** @type {ManagedAccount} */
    const account = {
      index: this.#accounts.length,
      email,
      refreshToken,
      access: accessToken,
      expires,
      addedAt: now,
      lastUsed: 0,
      enabled: true,
      rateLimitResetTimes: {},
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSwitchReason: "initial",
    };

    this.#accounts.push(account);

    // If this is the first account, make it active
    if (this.#accounts.length === 1) {
      this.#currentIndex = 0;
    }

    this.requestSaveToDisk();
    return account;
  }

  /**
   * Remove an account by index.
   * @param {number} index
   * @returns {boolean}
   */
  removeAccount(index) {
    if (index < 0 || index >= this.#accounts.length) return false;

    this.#accounts.splice(index, 1);

    // Re-index remaining accounts
    this.#accounts.forEach((acc, i) => {
      acc.index = i;
    });

    // Adjust current index
    if (this.#accounts.length === 0) {
      this.#currentIndex = -1;
      this.#cursor = 0;
    } else {
      if (this.#currentIndex >= this.#accounts.length) {
        this.#currentIndex = this.#accounts.length - 1;
      }
      if (this.#cursor > 0) {
        this.#cursor = Math.min(this.#cursor, this.#accounts.length);
      }
    }

    // Reset health scores for all accounts since indices shifted after splice.
    // This is simpler and safer than trying to remap individual scores.
    for (let i = 0; i <= this.#accounts.length; i++) {
      this.#healthTracker.reset(i);
    }
    this.requestSaveToDisk();
    return true;
  }

  /**
   * Toggle an account's enabled state.
   * @param {number} index
   * @returns {boolean} New enabled state
   */
  toggleAccount(index) {
    const account = this.#accounts[index];
    if (!account) return false;

    account.enabled = !account.enabled;
    this.requestSaveToDisk();
    return account.enabled;
  }

  /**
   * Get the minimum wait time across all accounts before one becomes available.
   * @returns {number} Wait time in ms (0 if an account is available now)
   */
  getMinWaitTime() {
    const now = Date.now();
    let minWait = Infinity;

    for (const acc of this.#accounts) {
      if (!acc.enabled) continue;
      this.#clearExpiredRateLimits(acc);

      if (!this.#isRateLimited(acc)) return 0;

      const resetTime = acc.rateLimitResetTimes[RATE_LIMIT_KEY];
      if (resetTime !== undefined) {
        const wait = Math.max(0, resetTime - now);
        minWait = Math.min(minWait, wait);
      }
    }

    return minWait === Infinity ? 0 : minWait;
  }

  /**
   * Clear all accounts and reset state.
   */
  clearAll() {
    this.#accounts = [];
    this.#currentIndex = -1;
    this.#cursor = 0;
  }

  /**
   * Request a debounced save to disk.
   * Each call resets the debounce timer so the latest state is always persisted.
   */
  requestSaveToDisk() {
    if (this.#saveTimeout) clearTimeout(this.#saveTimeout);
    this.#saveTimeout = setTimeout(() => {
      this.#saveTimeout = null;
      this.saveToDisk().catch(() => {});
    }, 1000);
  }

  /**
   * Persist current state to disk immediately.
   * @returns {Promise<void>}
   */
  async saveToDisk() {
    /** @type {AccountStorage} */
    const storage = {
      version: 1,
      accounts: this.#accounts.map((acc) => ({
        email: acc.email,
        refreshToken: acc.refreshToken,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        enabled: acc.enabled,
        rateLimitResetTimes:
          Object.keys(acc.rateLimitResetTimes).length > 0
            ? acc.rateLimitResetTimes
            : {},
        consecutiveFailures: acc.consecutiveFailures,
        lastFailureTime: acc.lastFailureTime,
        lastSwitchReason: acc.lastSwitchReason,
      })),
      activeIndex: Math.max(0, this.#currentIndex),
    };

    await saveAccounts(storage);
  }

  /**
   * Convert a managed account to the format expected by OpenCode's auth.json.
   * @param {ManagedAccount} account
   * @returns {{type: 'oauth', refresh: string, access: string | undefined, expires: number | undefined}}
   */
  toAuthDetails(account) {
    return {
      type: "oauth",
      refresh: account.refreshToken,
      access: account.access,
      expires: account.expires,
    };
  }
}
