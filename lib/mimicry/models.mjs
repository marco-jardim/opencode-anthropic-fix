import { isTruthyEnv } from "../env.mjs";

// Perf: module-scope regex reused across per-request hot paths. It does not use
// the `/g` flag and is consumed via `.test()`, so the shared instance is
// stateless and safe (no `lastIndex` to reset between calls).
export const CLAUDE_3_MODEL_RE = /claude-3-/i;

/**
 * Detects claude-opus-4.6 / claude-opus-4-6 model IDs.
 * These models use adaptive thinking (effort parameter) instead of
 * manual budgetTokens.
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isOpus46Model(model) {
  if (!model) return false;
  // Match standard IDs (claude-opus-4-6, claude-opus-4.6) and Bedrock ARNs
  // (arn:aws:bedrock:...anthropic.claude-opus-4-6-...).
  // Also match bare "opus-4-6" / "opus-4.6" fragments for non-standard strings.
  return /claude-opus-4[._-]6|opus[._-]4[._-]6/i.test(model);
}

/**
 * Detects claude-opus-4.7 / claude-opus-4-7 model IDs.
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isOpus47Model(model) {
  if (!model) return false;
  return /claude-opus-4[._-]7|opus[._-]4[._-]7/i.test(model);
}

/**
 * Detects claude-opus-4.8 / claude-opus-4-8 model IDs.
 * Opus 4.8 (launched 2026-05-28) is an adaptive-thinking model: manual
 * `thinking: {type: "enabled", budget_tokens}` returns a 400 — it MUST use
 * `thinking: {type: "adaptive"}` + the effort parameter. It also supports
 * `speed: "fast"` (fast-mode research preview) and 1M context by default.
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isOpus48Model(model) {
  if (!model) return false;
  return /claude-opus-4[._-]8|opus[._-]4[._-]8/i.test(model);
}

/**
 * Check if a model is eligible for 1M context (can receive context-1m beta).
 * Real CC v2.1.97 U01(): claude-sonnet-4* || opus-4-6 are eligible.
 * Also matches explicit "1m" in the name (e.g. "claude-opus-4-6[1m]").
 * @param {string} model
 * @returns {boolean}
 */
export function isEligibleFor1MContext(model) {
  if (!model) return false;
  if (/(^|[-_ ])1m($|[-_ ])|context[-_]?1m|\[1m\]/i.test(model)) return true;
  return (
    /claude-sonnet-4|sonnet[._-]4/i.test(model) || isOpus46Model(model) || isOpus47Model(model) || isOpus48Model(model)
  );
}

/**
 * Check if a model should ALWAYS use 1M context (static mode, no adaptive gating).
 * Only models with explicit "1m" in the name — NOT bare Opus 4.6.
 * When adaptive_context is enabled, Opus 4.6 uses the adaptive decision instead.
 * @param {string} model
 * @returns {boolean}
 */
export function hasOneMillionContext(model) {
  return /(^|[-_ ])1m($|[-_ ])|context[-_]?1m/i.test(model);
}

/**
 * Detects claude-sonnet-4.6 / claude-sonnet-4-6 model IDs.
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isSonnet46Model(model) {
  if (!model) return false;
  return /claude-sonnet-4[._-]6|sonnet[._-]4[._-]6/i.test(model);
}

/**
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isFable5Model(model) {
  if (!model) return false;
  return /claude-fable-5|fable[._-]5/i.test(model);
}

/**
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isMythos5Model(model) {
  if (!model) return false;
  return /claude-mythos-5|mythos[._-]5/i.test(model);
}

/**
 * Detects models that support adaptive thinking ({type: "adaptive"}).
 * Currently: Opus 4.6, Opus 4.7, Opus 4.8, Sonnet 4.6, Fable 5, and Mythos 5.
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isAdaptiveThinkingModel(model) {
  return (
    isOpus46Model(model) ||
    isOpus47Model(model) ||
    isOpus48Model(model) ||
    isSonnet46Model(model) ||
    isFable5Model(model) ||
    isMythos5Model(model)
  );
}

/**
 * @param {any} thinking
 * @param {string} model
 * @returns {any}
 */
export function normalizeThinkingBlock(thinking, model) {
  // If thinking is absent or not an object, pass through
  if (!thinking || typeof thinking !== "object") {
    return thinking;
  }

  // Adaptive thinking models always get { type: "adaptive" }
  // regardless of what format the incoming thinking block has
  if (isAdaptiveThinkingModel(model)) {
    // Check for env-var override to force budget_tokens fallback
    if (isTruthyEnv(process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING)) {
      // Fallback: return as-is if already budget_tokens shape, otherwise default
      if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
        return thinking;
      }
      const parsedBudget = parseInt(process.env.MAX_THINKING_TOKENS, 10);
      return { type: "enabled", budget_tokens: Number.isNaN(parsedBudget) ? 16000 : parsedBudget };
    }
    return { type: "adaptive" };
  }

  // Non-adaptive models: pass through unchanged
  return thinking;
}
