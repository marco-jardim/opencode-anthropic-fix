/**
 * Microcompact decision helpers (token-economy).
 *
 * Pure helper extracted from index.mjs: whether estimated prompt token usage has
 * crossed the microcompact threshold. The stateful microcompact gating
 * (microcompactState) remains in the interceptor shell in index.mjs.
 *
 * @module token-economy/microcompact
 */

/**
 * Determine if microcompact betas should be injected based on estimated token usage.
 * @param {number} estimatedTokens - Estimated prompt token count
 * @param {object} config - Plugin config
 * @returns {boolean}
 */
export function shouldMicrocompact(estimatedTokens, config) {
  if (!config.microcompact?.enabled) return false;
  const thresholdPct = config.microcompact.threshold_percent ?? 80;
  // Use the model's context window. Default to 200K if unknown.
  // Adaptive context may escalate to 1M, but we use the base 200K for threshold
  // to be conservative (microcompact at 160K tokens is still valuable).
  const contextWindow = 200_000;
  const threshold = contextWindow * (thresholdPct / 100);
  return estimatedTokens >= threshold;
}
