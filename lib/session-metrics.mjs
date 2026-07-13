// ---------------------------------------------------------------------------
// Session-level cache & cost tracking (Phase 4)
// ---------------------------------------------------------------------------
//
// Extracted from index.mjs (W3·P3.3). `sessionMetrics` is a process-lifetime
// singleton shared BY REFERENCE across the plugin and the extracted lib
// modules: importers mutate `sessionMetrics.<field>` in place and it is never
// reassigned, so a plain `import { sessionMetrics }` observes the same live
// object everywhere. The test reset helper mutates in place (delete keys +
// Object.assign) precisely to preserve this shared identity.

/**
 * Factory for the initial sessionMetrics shape. Returns a fresh object each
 * call so the reset helper (and any future test hook) doesn't alias nested
 * state (lastQuota, perModel, costBreakdown, tokenBudget, usedTools Set).
 * Keep this in sync with the type annotation below.
 */
export function createInitialSessionMetrics() {
  return {
    turns: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalWebSearchRequests: 0,
    recentCacheRates: [], // rolling window of last 5 turns
    sessionCostUsd: 0,
    costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    sessionStartTime: Date.now(),
    lastQuota: {
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      updatedAt: 0,
      // Window-based unified headers from response
      fiveHour: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
      sevenDay: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
      // Overall/fallback/overage from response headers
      overallStatus: null,
      representativeClaim: null,
      fallback: null,
      fallbackPercentage: null,
      overageStatus: null,
      overageReason: null,
      // Usage endpoint polling (A6)
      lastPollAt: 0,
    },
    lastStopReason: null, // tracks most recent stop_reason for output cap escalation
    perModel: {}, // Map<modelId, { input, output, cacheRead, cacheWrite, costUsd, turns }>
    lastModelId: null,
    lastRequestBody: null, // Last intercepted request body (JSON string, capped 2MB) for /anthropic context
    /** Token budget tracking (A9) */
    tokenBudget: {
      limit: 0, // 0 = unset
      used: 0, // accumulated output tokens
      continuations: 0,
      outputHistory: [], // last 5 output token deltas
    },
    /** Tools used in this session (populated from assistant tool_use blocks in messages) */
    usedTools: new Set(),
  };
}

/** @type {{turns: number, totalInput: number, totalOutput: number, totalCacheRead: number, totalCacheWrite: number, totalWebSearchRequests: number, recentCacheRates: number[], sessionCostUsd: number, costBreakdown: {input: number, output: number, cacheRead: number, cacheWrite: number}, sessionStartTime: number, lastQuota: {tokens: number, requests: number, inputTokens: number, updatedAt: number, fiveHour: {utilization: number, resets_at: string|null, status: string|null, surpassedThreshold: number|null}, sevenDay: {utilization: number, resets_at: string|null, status: string|null, surpassedThreshold: number|null}, overallStatus: string|null, representativeClaim: string|null, fallback: string|null, fallbackPercentage: number|null, overageStatus: string|null, overageReason: string|null, lastPollAt: number}, lastStopReason: string | null, perModel: Record<string, {input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number, turns: number}>, lastModelId: string | null, lastRequestBody: string | null, tokenBudget: {limit: number, used: number, continuations: number, outputHistory: number[]}, usedTools: Set<string>}} */
export const sessionMetrics = createInitialSessionMetrics();

/**
 * Get rolling average cache hit rate over last 5 turns.
 * @returns {number} 0-1
 */
export function getAverageCacheHitRate() {
  const rates = sessionMetrics.recentCacheRates;
  if (rates.length === 0) return 0;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}
