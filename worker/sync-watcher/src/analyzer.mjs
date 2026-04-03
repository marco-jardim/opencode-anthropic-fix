/**
 * Analysis orchestrator: diff → prompt → LLM → structured result.
 *
 * Decides whether to auto-PR or create an issue based on the contract diff
 * and LLM analysis. Falls back gracefully when LLM is unavailable.
 *
 * @module analyzer
 */

import { buildSystemPrompt, buildUserPrompt, ANALYSIS_SCHEMA } from "./prompts.mjs";
import { invokeLLM } from "./llm.mjs";
import { isTrivialDiff, isAutoPatchableDiff } from "./differ.mjs";

/**
 * @typedef {import('./types.mjs').ExtractedContract} ExtractedContract
 * @typedef {import('./types.mjs').ContractDiff} ContractDiff
 * @typedef {import('./llm.mjs').LLMResponse} LLMResponse
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {"auto-pr"|"create-issue"} action - Recommended action
 * @property {LLMResponse|null} llmAnalysis - LLM output (null if not invoked or failed)
 * @property {boolean} llmInvoked - Whether LLM was called
 * @property {string|null} llmError - Error message if LLM failed
 * @property {ContractDiff} diff - The underlying diff
 */

/**
 * Analyze a contract diff and determine the recommended action.
 *
 * Decision logic:
 * 1. No change → should not reach here, but handled
 * 2. Trivial (version/buildTime only) → auto-pr without LLM
 * 3. Non-trivial → invoke LLM
 *    - LLM says safe + confidence >= 0.8 → auto-pr
 *    - LLM says not safe, or confidence < 0.8 → create-issue
 *    - LLM fails → create-issue with raw diff (fallback)
 *
 * @param {object} env - Worker environment
 * @param {ExtractedContract} baseline
 * @param {ExtractedContract} extracted
 * @param {ContractDiff} diff
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeContractDiff(env, baseline, extracted, diff) {
  // No change — shouldn't be called but handle defensively
  if (!diff.changed) {
    return {
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff,
    };
  }

  // Trivial diffs (version + buildTime only) — no LLM needed
  if (isTrivialDiff(diff)) {
    return {
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff,
    };
  }

  // Auto-patchable diffs (version, buildTime, sdkVersion, beta flag sets) — no LLM needed
  if (isAutoPatchableDiff(diff)) {
    return {
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff,
    };
  }

  // Non-trivial — invoke LLM
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(baseline, extracted, diff);

  let llmAnalysis = null;
  let llmError = null;

  try {
    llmAnalysis = await invokeLLM(env, systemPrompt, userPrompt, ANALYSIS_SCHEMA);
  } catch (err) {
    llmError = err.message;
  }

  // Determine action based on LLM result
  let action;
  if (llmAnalysis && llmAnalysis.safe_for_auto_pr && llmAnalysis.confidence >= 0.8) {
    action = "auto-pr";
  } else {
    // LLM failed, not safe, or low confidence → create issue
    action = "create-issue";
  }

  return {
    action,
    llmAnalysis,
    llmInvoked: true,
    llmError,
    diff,
  };
}
