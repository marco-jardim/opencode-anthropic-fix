import { DEFAULT_CONFIG } from "./config.mjs";

/**
 * @typedef {import('./config.mjs').HealthScoreConfig} HealthScoreConfig
 * @typedef {import('./config.mjs').TokenBucketConfig} TokenBucketConfig
 * @typedef {import('./config.mjs').AccountSelectionStrategy} AccountSelectionStrategy
 */

/**
 * @typedef {object} AccountCandidate
 * @property {number} index
 * @property {number} lastUsed
 * @property {number} healthScore
 * @property {boolean} isRateLimited
 * @property {boolean} enabled
 */

// --- Health Score Tracker ---

export class HealthScoreTracker {
  /** @type {Map<number, {score: number, lastUpdated: number, consecutiveFailures: number}>} */
  #scores = new Map();
  /** @type {HealthScoreConfig} */
  #config;

  /**
   * @param {Partial<HealthScoreConfig>} [config]
   */
  constructor(config = {}) {
    this.#config = { ...DEFAULT_CONFIG.health_score, ...config };
  }

  /**
   * Get the current health score for an account, including passive recovery.
   * @param {number} accountIndex
   * @returns {number}
   */
  getScore(accountIndex) {
    const state = this.#scores.get(accountIndex);
    if (!state) return this.#config.initial;

    const hoursSinceUpdate = (Date.now() - state.lastUpdated) / (1000 * 60 * 60);
    const recoveredPoints = Math.floor(hoursSinceUpdate * this.#config.recovery_rate_per_hour);

    return Math.min(this.#config.max_score, state.score + recoveredPoints);
  }

  /**
   * Record a successful request.
   * @param {number} accountIndex
   */
  recordSuccess(accountIndex) {
    const current = this.getScore(accountIndex);
    this.#scores.set(accountIndex, {
      score: Math.min(this.#config.max_score, current + this.#config.success_reward),
      lastUpdated: Date.now(),
      consecutiveFailures: 0,
    });
  }

  /**
   * Record a rate limit event.
   * @param {number} accountIndex
   */
  recordRateLimit(accountIndex) {
    const current = this.getScore(accountIndex);
    const state = this.#scores.get(accountIndex);
    this.#scores.set(accountIndex, {
      score: Math.max(0, current + this.#config.rate_limit_penalty),
      lastUpdated: Date.now(),
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    });
  }

  /**
   * Record a general failure.
   * @param {number} accountIndex
   */
  recordFailure(accountIndex) {
    const current = this.getScore(accountIndex);
    const state = this.#scores.get(accountIndex);
    this.#scores.set(accountIndex, {
      score: Math.max(0, current + this.#config.failure_penalty),
      lastUpdated: Date.now(),
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    });
  }

  /**
   * Check if an account is usable (score above minimum).
   * @param {number} accountIndex
   * @returns {boolean}
   */
  isUsable(accountIndex) {
    return this.getScore(accountIndex) >= this.#config.min_usable;
  }

  /**
   * Reset tracking for an account.
   * @param {number} accountIndex
   */
  reset(accountIndex) {
    this.#scores.delete(accountIndex);
  }
}

// --- Token Bucket Tracker ---

export class TokenBucketTracker {
  /** @type {Map<number, {tokens: number, lastUpdated: number}>} */
  #buckets = new Map();
  /** @type {TokenBucketConfig} */
  #config;

  /**
   * @param {Partial<TokenBucketConfig>} [config]
   */
  constructor(config = {}) {
    this.#config = { ...DEFAULT_CONFIG.token_bucket, ...config };
  }

  /**
   * Get current token count for an account, including regeneration.
   * @param {number} accountIndex
   * @returns {number}
   */
  getTokens(accountIndex) {
    const state = this.#buckets.get(accountIndex);
    if (!state) return this.#config.initial_tokens;

    const minutesSinceUpdate = (Date.now() - state.lastUpdated) / (1000 * 60);
    const recoveredTokens = minutesSinceUpdate * this.#config.regeneration_rate_per_minute;

    return Math.min(this.#config.max_tokens, state.tokens + recoveredTokens);
  }

  /**
   * Check if an account has enough tokens.
   * @param {number} accountIndex
   * @param {number} [cost=1]
   * @returns {boolean}
   */
  hasTokens(accountIndex, cost = 1) {
    return this.getTokens(accountIndex) >= cost;
  }

  /**
   * Consume tokens for a request.
   * @param {number} accountIndex
   * @param {number} [cost=1]
   * @returns {boolean} Whether tokens were available and consumed
   */
  consume(accountIndex, cost = 1) {
    const current = this.getTokens(accountIndex);
    if (current < cost) return false;

    this.#buckets.set(accountIndex, {
      tokens: current - cost,
      lastUpdated: Date.now(),
    });
    return true;
  }

  /**
   * Refund tokens (e.g., on non-rate-limit failure).
   * @param {number} accountIndex
   * @param {number} [amount=1]
   */
  refund(accountIndex, amount = 1) {
    const current = this.getTokens(accountIndex);
    this.#buckets.set(accountIndex, {
      tokens: Math.min(this.#config.max_tokens, current + amount),
      lastUpdated: Date.now(),
    });
  }

  /**
   * Get the max tokens value (for scoring calculations).
   * @returns {number}
   */
  getMaxTokens() {
    return this.#config.max_tokens;
  }
}

// --- Selection Algorithms ---

const STICKINESS_BONUS = 150;
const SWITCH_THRESHOLD = 100;

/**
 * Calculate hybrid score for an account.
 * @param {AccountCandidate & {tokens: number}} account
 * @param {number} maxTokens
 * @returns {number}
 */
function calculateHybridScore(account, maxTokens) {
  const healthComponent = account.healthScore * 2;
  const tokenComponent = (account.tokens / maxTokens) * 100 * 5;
  const secondsSinceUsed = (Date.now() - account.lastUsed) / 1000;
  const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1;

  return Math.max(0, healthComponent + tokenComponent + freshnessComponent);
}

/**
 * Select the best account based on the configured strategy.
 *
 * @param {AccountCandidate[]} candidates - All enabled, non-rate-limited accounts
 * @param {AccountSelectionStrategy} strategy
 * @param {number | null} currentIndex - Currently active account index
 * @param {HealthScoreTracker} healthTracker
 * @param {TokenBucketTracker} tokenTracker
 * @param {number} cursor - Round-robin cursor position
 * @returns {{index: number, cursor: number} | null}
 */
export function selectAccount(candidates, strategy, currentIndex, healthTracker, tokenTracker, cursor) {
  const available = candidates.filter((acc) => acc.enabled && !acc.isRateLimited);

  if (available.length === 0) return null;

  switch (strategy) {
    case "sticky": {
      // Use current if available. Sticky should not switch based on health score.
      if (currentIndex !== null) {
        const current = available.find((acc) => acc.index === currentIndex);
        if (current) {
          return { index: current.index, cursor };
        }
      }
      // Fall through to next available
      const next = available[cursor % available.length];
      return next ? { index: next.index, cursor: cursor + 1 } : null;
    }

    case "round-robin": {
      const next = available[cursor % available.length];
      return next ? { index: next.index, cursor: cursor + 1 } : null;
    }

    case "hybrid": {
      const scoredCandidates = available
        .filter((acc) => healthTracker.isUsable(acc.index) && tokenTracker.hasTokens(acc.index))
        .map((acc) => ({
          ...acc,
          tokens: tokenTracker.getTokens(acc.index),
        }));

      if (scoredCandidates.length === 0) {
        // Fall back to any available account
        const fallback = available[0];
        return fallback ? { index: fallback.index, cursor } : null;
      }

      const maxTokens = tokenTracker.getMaxTokens();
      const scored = scoredCandidates
        .map((acc) => {
          const baseScore = calculateHybridScore(acc, maxTokens);
          const stickinessBonus = acc.index === currentIndex ? STICKINESS_BONUS : 0;
          return {
            index: acc.index,
            baseScore,
            score: baseScore + stickinessBonus,
            isCurrent: acc.index === currentIndex,
          };
        })
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best) return null;

      // Only switch if the advantage is significant
      const currentCandidate = scored.find((s) => s.isCurrent);
      if (currentCandidate && !best.isCurrent) {
        const advantage = best.baseScore - currentCandidate.baseScore;
        if (advantage < SWITCH_THRESHOLD) {
          return { index: currentCandidate.index, cursor };
        }
      }

      return { index: best.index, cursor };
    }

    default:
      return available[0] ? { index: available[0].index, cursor } : null;
  }
}
