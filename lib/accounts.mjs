import { loadAccounts, saveAccounts, createDefaultStats } from "./storage.mjs";
import { HealthScoreTracker, TokenBucketTracker, selectAccount } from "./rotation.mjs";
import { calculateBackoffMs } from "./backoff.mjs";

/**
 * @typedef {import('./config.mjs').AnthropicAuthConfig} AnthropicAuthConfig
 * @typedef {import('./config.mjs').AccountSelectionStrategy} AccountSelectionStrategy
 * @typedef {import('./storage.mjs').AccountMetadata} AccountMetadata
 * @typedef {import('./storage.mjs').AccountStorage} AccountStorage
 * @typedef {import('./backoff.mjs').RateLimitReason} RateLimitReason
 */

/**
 * @typedef {import('./storage.mjs').AccountStats} AccountStats
 */

/**
 * @typedef {object} ManagedAccount
 * @property {string} id
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
 * @property {AccountStats} stats
 */

const MAX_ACCOUNTS = 10;
const RATE_LIMIT_KEY = "anthropic";

/**
 * @typedef {object} StatsDelta
 * @property {number} requests
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {boolean} isReset - If true, this delta represents an absolute reset, not an increment
 * @property {number} [resetTimestamp] - The lastReset value when isReset is true
 */

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
   * Pending stats deltas per account id, merged into disk values on save.
   * @type {Map<string, StatsDelta>}
   */
  #statsDeltas = new Map();

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

    // If storage exists (even with zero accounts), treat disk as authoritative.
    // This allows explicit CLI logout-all to remain logged out instead of
    // re-bootstrapping from OpenCode auth fallback credentials.
    if (stored) {
      manager.#accounts = stored.accounts.map((acc, index) => ({
        id: acc.id || `${acc.addedAt}:${acc.refreshToken.slice(0, 12)}`,
        index,
        email: acc.email,
        refreshToken: acc.refreshToken,
        access: acc.access,
        expires: acc.expires,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        enabled: acc.enabled,
        rateLimitResetTimes: acc.rateLimitResetTimes,
        consecutiveFailures: acc.consecutiveFailures,
        lastFailureTime: acc.lastFailureTime,
        lastSwitchReason: acc.lastSwitchReason,
        stats: acc.stats ?? createDefaultStats(acc.addedAt),
      }));

      manager.#currentIndex =
        manager.#accounts.length > 0 ? Math.min(stored.activeIndex, manager.#accounts.length - 1) : -1;

      // If we have a fallback auth, match it to an existing account and set tokens
      if (authFallback && manager.#accounts.length > 0) {
        const match = manager.#accounts.find((acc) => acc.refreshToken === authFallback.refresh);
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
          id: `${now}:${authFallback.refresh.slice(0, 12)}`,
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
          stats: createDefaultStats(now),
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
   * @param {Set<number>} [excludedIndices] - Temporary per-request exclusions
   * @returns {ManagedAccount | null}
   */
  getCurrentAccount(excludedIndices) {
    if (this.#accounts.length === 0) return null;

    // Build candidates list
    const candidates = this.#accounts
      .filter((acc) => acc.enabled && !excludedIndices?.has(acc.index))
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
    if (account.lastFailureTime !== null && now - account.lastFailureTime > this.#config.failure_ttl_seconds * 1000) {
      account.consecutiveFailures = 0;
    }

    account.consecutiveFailures += 1;
    account.lastFailureTime = now;

    const backoffMs = calculateBackoffMs(reason, account.consecutiveFailures - 1, retryAfterMs);

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
    const existing = this.#accounts.find((acc) => acc.refreshToken === refreshToken);
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
      id: `${now}:${refreshToken.slice(0, 12)}`,
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
      stats: createDefaultStats(now),
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
    for (let i = 0; i < this.#accounts.length; i++) {
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
   * Stats use merge-on-save: read disk values, add this instance's deltas,
   * write merged result. This prevents concurrent instances from clobbering
   * each other's stats.
   * @returns {Promise<void>}
   */
  async saveToDisk() {
    // Read current disk state to merge stats
    let diskAccounts = null;
    try {
      const diskData = await loadAccounts();
      if (diskData) {
        diskAccounts = new Map(diskData.accounts.map((a) => [a.id, a]));
      }
    } catch {
      // If we can't read, fall through to writing absolute values
    }

    /** @type {AccountStorage} */
    const storage = {
      version: 1,
      accounts: this.#accounts.map((acc) => {
        const delta = this.#statsDeltas.get(acc.id);
        let mergedStats = acc.stats;

        if (delta) {
          const diskAcc = diskAccounts?.get(acc.id);
          const diskStats = diskAcc?.stats;

          if (delta.isReset) {
            // Absolute reset: start from zero + any post-reset usage
            mergedStats = {
              requests: delta.requests,
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              cacheReadTokens: delta.cacheReadTokens,
              cacheWriteTokens: delta.cacheWriteTokens,
              lastReset: delta.resetTimestamp ?? acc.stats.lastReset,
            };
          } else if (diskStats) {
            // Incremental: add our deltas to whatever's on disk
            mergedStats = {
              requests: diskStats.requests + delta.requests,
              inputTokens: diskStats.inputTokens + delta.inputTokens,
              outputTokens: diskStats.outputTokens + delta.outputTokens,
              cacheReadTokens: diskStats.cacheReadTokens + delta.cacheReadTokens,
              cacheWriteTokens: diskStats.cacheWriteTokens + delta.cacheWriteTokens,
              lastReset: diskStats.lastReset,
            };
          }
          // If no diskStats and no reset, we write acc.stats as-is (first save)
        }

        return {
          id: acc.id,
          email: acc.email,
          refreshToken: acc.refreshToken,
          access: acc.access,
          expires: acc.expires,
          addedAt: acc.addedAt,
          lastUsed: acc.lastUsed,
          enabled: acc.enabled,
          rateLimitResetTimes: Object.keys(acc.rateLimitResetTimes).length > 0 ? acc.rateLimitResetTimes : {},
          consecutiveFailures: acc.consecutiveFailures,
          lastFailureTime: acc.lastFailureTime,
          lastSwitchReason: acc.lastSwitchReason,
          stats: mergedStats,
        };
      }),
      activeIndex: Math.max(0, this.#currentIndex),
    };

    await saveAccounts(storage);

    // Clear deltas after successful write
    this.#statsDeltas.clear();

    // Update in-memory stats to match what we wrote (so subsequent reads
    // reflect the merged values, not stale pre-merge values)
    for (const saved of storage.accounts) {
      const acc = this.#accounts.find((a) => a.id === saved.id);
      if (acc) {
        acc.stats = saved.stats;
      }
    }
  }

  /**
   * Sync activeIndex from disk (picks up CLI changes while OpenCode is running).
   * Only switches if the disk value differs and the target account is enabled.
   * @returns {Promise<void>}
   */
  async syncActiveIndexFromDisk() {
    const stored = await loadAccounts();
    if (!stored) return;

    // Reconcile account list/enabled states with disk (CLI may add/remove/enable/disable)
    const diskSnapshot = stored.accounts.map((acc) => `${acc.refreshToken}:${acc.enabled ? 1 : 0}`).join("|");
    const memSnapshot = this.#accounts.map((acc) => `${acc.refreshToken}:${acc.enabled ? 1 : 0}`).join("|");

    if (diskSnapshot !== memSnapshot) {
      const existingByToken = new Map(this.#accounts.map((acc) => [acc.refreshToken, acc]));

      this.#accounts = stored.accounts.map((acc, index) => {
        const existing = existingByToken.get(acc.refreshToken);
        return {
          id: acc.id || existing?.id || `${acc.addedAt}:${acc.refreshToken.slice(0, 12)}`,
          index,
          email: acc.email ?? existing?.email,
          refreshToken: acc.refreshToken,
          access: acc.access ?? existing?.access,
          expires: acc.expires ?? existing?.expires,
          addedAt: acc.addedAt,
          lastUsed: acc.lastUsed,
          enabled: acc.enabled,
          rateLimitResetTimes: acc.rateLimitResetTimes,
          consecutiveFailures: acc.consecutiveFailures,
          lastFailureTime: acc.lastFailureTime,
          lastSwitchReason: acc.lastSwitchReason || existing?.lastSwitchReason || "initial",
          stats: acc.stats ?? existing?.stats ?? createDefaultStats(),
        };
      });

      // Trackers are index-based; reset when account set/order changes.
      this.#healthTracker = new HealthScoreTracker(this.#config.health_score);
      this.#tokenTracker = new TokenBucketTracker(this.#config.token_bucket);

      // Prune orphaned stats deltas for accounts no longer in the set.
      const currentIds = new Set(this.#accounts.map((a) => a.id));
      for (const id of this.#statsDeltas.keys()) {
        if (!currentIds.has(id)) this.#statsDeltas.delete(id);
      }

      if (this.#accounts.length === 0) {
        this.#currentIndex = -1;
        this.#cursor = 0;
        return;
      }
    }

    const diskIndex = Math.min(stored.activeIndex, this.#accounts.length - 1);
    if (diskIndex >= 0 && diskIndex !== this.#currentIndex) {
      const diskAccount = stored.accounts[diskIndex];
      if (!diskAccount || !diskAccount.enabled) return;

      const account = this.#accounts[diskIndex];
      if (account && account.enabled) {
        this.#currentIndex = diskIndex;
        this.#cursor = diskIndex;
        // Reset health so sticky strategy honors the explicit switch
        this.#healthTracker.reset(diskIndex);
      }
    }
  }

  /**
   * Record token usage for an account after a successful API response.
   * @param {number} index
   * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage
   */
  recordUsage(index, usage) {
    const account = this.#accounts[index];
    if (!account) return;

    const inTok = usage.inputTokens || 0;
    const outTok = usage.outputTokens || 0;
    const crTok = usage.cacheReadTokens || 0;
    const cwTok = usage.cacheWriteTokens || 0;

    // Update in-memory stats (for reads within this process)
    account.stats.requests += 1;
    account.stats.inputTokens += inTok;
    account.stats.outputTokens += outTok;
    account.stats.cacheReadTokens += crTok;
    account.stats.cacheWriteTokens += cwTok;

    // Accumulate delta for merge-on-save
    const delta = this.#statsDeltas.get(account.id);
    if (delta) {
      // For both incremental and reset deltas, accumulate usage on top.
      delta.requests += 1;
      delta.inputTokens += inTok;
      delta.outputTokens += outTok;
      delta.cacheReadTokens += crTok;
      delta.cacheWriteTokens += cwTok;
    } else {
      this.#statsDeltas.set(account.id, {
        requests: 1,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: crTok,
        cacheWriteTokens: cwTok,
        isReset: false,
      });
    }

    this.requestSaveToDisk();
  }

  /**
   * Reset stats for a specific account or all accounts.
   * @param {number | "all"} target - Account index or "all"
   */
  resetStats(target) {
    const now = Date.now();
    const resetAccount = (/** @type {ManagedAccount} */ acc) => {
      acc.stats = createDefaultStats(now);
      // Mark as absolute reset — saveToDisk will write these values directly
      this.#statsDeltas.set(acc.id, {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        isReset: true,
        resetTimestamp: now,
      });
    };

    if (target === "all") {
      for (const acc of this.#accounts) {
        resetAccount(acc);
      }
    } else {
      const account = this.#accounts[target];
      if (account) {
        resetAccount(account);
      }
    }
    this.requestSaveToDisk();
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
