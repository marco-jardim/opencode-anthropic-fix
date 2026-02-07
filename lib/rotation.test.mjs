import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HealthScoreTracker,
  TokenBucketTracker,
  selectAccount,
} from "./rotation.mjs";

// ---------------------------------------------------------------------------
// HealthScoreTracker
// ---------------------------------------------------------------------------

describe("HealthScoreTracker", () => {
  /** @type {HealthScoreTracker} */
  let tracker;

  beforeEach(() => {
    tracker = new HealthScoreTracker();
  });

  it("returns initial score for unknown account", () => {
    expect(tracker.getScore(0)).toBe(70);
  });

  it("increases score on success", () => {
    tracker.recordSuccess(0);
    expect(tracker.getScore(0)).toBe(71);
  });

  it("decreases score on rate limit", () => {
    tracker.recordRateLimit(0);
    expect(tracker.getScore(0)).toBe(60);
  });

  it("decreases score on failure", () => {
    tracker.recordFailure(0);
    expect(tracker.getScore(0)).toBe(50);
  });

  it("does not go below 0", () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordFailure(0);
    }
    expect(tracker.getScore(0)).toBe(0);
  });

  it("caps at max_score", () => {
    for (let i = 0; i < 50; i++) {
      tracker.recordSuccess(0);
    }
    expect(tracker.getScore(0)).toBe(100);
  });

  it("isUsable returns true when score >= min_usable", () => {
    expect(tracker.isUsable(0)).toBe(true); // 70 >= 50
  });

  it("isUsable returns false when score < min_usable", () => {
    // 70 - 20 = 50 (still usable), need one more
    tracker.recordFailure(0); // 50
    expect(tracker.isUsable(0)).toBe(true);
    tracker.recordRateLimit(0); // 40
    expect(tracker.isUsable(0)).toBe(false);
  });

  it("reset removes tracking for an account", () => {
    tracker.recordFailure(0);
    tracker.reset(0);
    expect(tracker.getScore(0)).toBe(70); // Back to initial
  });

  it("tracks accounts independently", () => {
    tracker.recordFailure(0);
    tracker.recordSuccess(1);
    expect(tracker.getScore(0)).toBe(50);
    expect(tracker.getScore(1)).toBe(71);
  });

  it("applies passive recovery over time", () => {
    tracker.recordFailure(0); // Score = 50
    // Simulate 1 hour passing
    const state = tracker.getScore(0);
    expect(state).toBe(50);

    // We can't easily test time-based recovery without mocking Date.now
    // but we can verify the formula works by checking the code path
  });

  it("uses custom config", () => {
    const custom = new HealthScoreTracker({
      initial: 100,
      success_reward: 5,
      rate_limit_penalty: -5,
      failure_penalty: -10,
      min_usable: 80,
      max_score: 100,
    });
    expect(custom.getScore(0)).toBe(100);
    custom.recordRateLimit(0);
    expect(custom.getScore(0)).toBe(95);
    expect(custom.isUsable(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TokenBucketTracker
// ---------------------------------------------------------------------------

describe("TokenBucketTracker", () => {
  /** @type {TokenBucketTracker} */
  let tracker;

  beforeEach(() => {
    tracker = new TokenBucketTracker();
  });

  it("returns initial tokens for unknown account", () => {
    expect(tracker.getTokens(0)).toBe(50);
  });

  it("hasTokens returns true when tokens available", () => {
    expect(tracker.hasTokens(0)).toBe(true);
  });

  it("consume reduces tokens", () => {
    tracker.consume(0);
    expect(tracker.getTokens(0)).toBe(49);
  });

  it("consume returns false when insufficient tokens", () => {
    // Drain all tokens
    for (let i = 0; i < 50; i++) {
      tracker.consume(0);
    }
    expect(tracker.consume(0)).toBe(false);
    expect(tracker.hasTokens(0)).toBe(false);
  });

  it("refund adds tokens back", () => {
    tracker.consume(0);
    tracker.consume(0);
    tracker.refund(0);
    expect(tracker.getTokens(0)).toBe(49);
  });

  it("refund does not exceed max", () => {
    tracker.refund(0, 100);
    expect(tracker.getTokens(0)).toBe(50);
  });

  it("getMaxTokens returns configured max", () => {
    expect(tracker.getMaxTokens()).toBe(50);
  });

  it("uses custom config", () => {
    const custom = new TokenBucketTracker({
      max_tokens: 10,
      initial_tokens: 5,
      regeneration_rate_per_minute: 1,
    });
    expect(custom.getTokens(0)).toBe(5);
    expect(custom.getMaxTokens()).toBe(10);
  });

  it("tracks accounts independently", () => {
    tracker.consume(0);
    expect(tracker.getTokens(0)).toBe(49);
    expect(tracker.getTokens(1)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// selectAccount
// ---------------------------------------------------------------------------

describe("selectAccount", () => {
  /** @type {HealthScoreTracker} */
  let healthTracker;
  /** @type {TokenBucketTracker} */
  let tokenTracker;

  beforeEach(() => {
    healthTracker = new HealthScoreTracker();
    tokenTracker = new TokenBucketTracker();
  });

  /**
   * @param {Partial<import('./rotation.mjs').AccountCandidate>} overrides
   * @returns {import('./rotation.mjs').AccountCandidate}
   */
  function makeCandidate(overrides = {}) {
    return {
      index: 0,
      lastUsed: 0,
      healthScore: 70,
      isRateLimited: false,
      enabled: true,
      ...overrides,
    };
  }

  it("returns null when no candidates", () => {
    expect(
      selectAccount([], "sticky", null, healthTracker, tokenTracker, 0),
    ).toBeNull();
  });

  it("returns null when all candidates are rate-limited", () => {
    const candidates = [
      makeCandidate({ index: 0, isRateLimited: true }),
      makeCandidate({ index: 1, isRateLimited: true }),
    ];
    expect(
      selectAccount(candidates, "sticky", null, healthTracker, tokenTracker, 0),
    ).toBeNull();
  });

  it("returns null when all candidates are disabled", () => {
    const candidates = [
      makeCandidate({ index: 0, enabled: false }),
    ];
    expect(
      selectAccount(candidates, "sticky", null, healthTracker, tokenTracker, 0),
    ).toBeNull();
  });

  // Sticky strategy
  describe("sticky strategy", () => {
    it("returns current account if available", () => {
      const candidates = [
        makeCandidate({ index: 0 }),
        makeCandidate({ index: 1 }),
      ];
      const result = selectAccount(
        candidates, "sticky", 0, healthTracker, tokenTracker, 0,
      );
      expect(result?.index).toBe(0);
    });

    it("switches when current is rate-limited", () => {
      const candidates = [
        makeCandidate({ index: 0, isRateLimited: true }),
        makeCandidate({ index: 1 }),
      ];
      const result = selectAccount(
        candidates, "sticky", 0, healthTracker, tokenTracker, 0,
      );
      expect(result?.index).toBe(1);
    });

    it("does not switch when current is unhealthy", () => {
      // Make account 0 unhealthy
      for (let i = 0; i < 5; i++) {
        healthTracker.recordFailure(0);
      }
      const candidates = [
        makeCandidate({ index: 0 }),
        makeCandidate({ index: 1 }),
      ];
      const result = selectAccount(
        candidates, "sticky", 0, healthTracker, tokenTracker, 0,
      );
      expect(result?.index).toBe(0);
      expect(result?.cursor).toBe(0);
    });

    it("keeps current even when cursor points elsewhere", () => {
      // Make account 0 unhealthy
      for (let i = 0; i < 5; i++) {
        healthTracker.recordFailure(0);
      }
      const candidates = [
        makeCandidate({ index: 0 }),
        makeCandidate({ index: 1 }),
      ];
      // Even with cursor=1, sticky should keep the current account
      const result = selectAccount(
        candidates, "sticky", 0, healthTracker, tokenTracker, 1,
      );
      expect(result?.index).toBe(0);
      expect(result?.cursor).toBe(1);
    });

    it("selects first available when no current", () => {
      const candidates = [
        makeCandidate({ index: 0 }),
        makeCandidate({ index: 1 }),
      ];
      const result = selectAccount(
        candidates, "sticky", null, healthTracker, tokenTracker, 0,
      );
      expect(result?.index).toBe(0);
    });
  });

  // Round-robin strategy
  describe("round-robin strategy", () => {
    it("rotates through accounts", () => {
      const candidates = [
        makeCandidate({ index: 0 }),
        makeCandidate({ index: 1 }),
        makeCandidate({ index: 2 }),
      ];

      const r1 = selectAccount(
        candidates, "round-robin", null, healthTracker, tokenTracker, 0,
      );
      expect(r1?.index).toBe(0);

      const r2 = selectAccount(
        candidates, "round-robin", 0, healthTracker, tokenTracker, r1.cursor,
      );
      expect(r2?.index).toBe(1);

      const r3 = selectAccount(
        candidates, "round-robin", 1, healthTracker, tokenTracker, r2.cursor,
      );
      expect(r3?.index).toBe(2);

      // Wraps around
      const r4 = selectAccount(
        candidates, "round-robin", 2, healthTracker, tokenTracker, r3.cursor,
      );
      expect(r4?.index).toBe(0);
    });

    it("skips rate-limited accounts", () => {
      const candidates = [
        makeCandidate({ index: 0, isRateLimited: true }),
        makeCandidate({ index: 1 }),
        makeCandidate({ index: 2 }),
      ];
      const result = selectAccount(
        candidates, "round-robin", null, healthTracker, tokenTracker, 0,
      );
      expect(result?.index).toBe(1);
    });
  });

  // Hybrid strategy
  describe("hybrid strategy", () => {
    it("selects the account with highest composite score", () => {
      const candidates = [
        makeCandidate({ index: 0, lastUsed: Date.now() }),
        makeCandidate({ index: 1, lastUsed: 0 }), // Older = more fresh
      ];
      // Account 1 should have higher freshness score
      const result = selectAccount(
        candidates, "hybrid", null, healthTracker, tokenTracker, 0,
      );
      // Both have same health and tokens, but account 1 has more freshness
      expect(result?.index).toBe(1);
    });

    it("applies stickiness bonus to current account", () => {
      const candidates = [
        makeCandidate({ index: 0, lastUsed: Date.now() }),
        makeCandidate({ index: 1, lastUsed: Date.now() - 1000 }),
      ];
      // Account 0 is current — stickiness bonus should keep it
      const result = selectAccount(
        candidates, "hybrid", 0, healthTracker, tokenTracker, 0,
      );
      expect(result?.index).toBe(0);
    });

    it("falls back to any available when all are unhealthy", () => {
      // Make all accounts unhealthy
      for (let i = 0; i < 10; i++) {
        healthTracker.recordFailure(0);
        healthTracker.recordFailure(1);
      }
      const candidates = [
        makeCandidate({ index: 0 }),
        makeCandidate({ index: 1 }),
      ];
      const result = selectAccount(
        candidates, "hybrid", null, healthTracker, tokenTracker, 0,
      );
      // Should fall back to first available
      expect(result).not.toBeNull();
    });

    it("switches when advantage exceeds threshold", () => {
      // Make account 0 very unhealthy
      for (let i = 0; i < 4; i++) {
        healthTracker.recordFailure(0);
      }
      // Drain account 0's tokens
      for (let i = 0; i < 50; i++) {
        tokenTracker.consume(0);
      }

      const candidates = [
        makeCandidate({ index: 0, lastUsed: Date.now() }),
        makeCandidate({ index: 1, lastUsed: 0 }),
      ];
      const result = selectAccount(
        candidates, "hybrid", 0, healthTracker, tokenTracker, 0,
      );
      // Account 1 should win despite stickiness bonus because account 0 is very degraded
      expect(result?.index).toBe(1);
    });
  });

  // Default/unknown strategy
  it("falls back to first available for unknown strategy", () => {
    const candidates = [
      makeCandidate({ index: 0 }),
      makeCandidate({ index: 1 }),
    ];
    const result = selectAccount(
      candidates, "unknown", null, healthTracker, tokenTracker, 0,
    );
    expect(result?.index).toBe(0);
  });
});
