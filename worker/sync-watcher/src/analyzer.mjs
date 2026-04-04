/**
 * Analysis orchestrator: diff → LLM → structured result.
 *
 * Every diff, no matter how small, goes through the LLM. Heuristic pre-filtering
 * was removed because it misclassified diffs (e.g. SDK/beta changes treated as
 * mechanical when they require careful review). The LLM is cheap relative to the
 * cost of a wrong auto-PR or a missed critical change.
 *
 * Decision logic:
 *   - LLM says safe_for_auto_pr AND confidence >= 0.85 → auto-pr
 *   - Otherwise (including LLM failure) → create-issue
 *
 * @module analyzer
 */

import { buildSystemPrompt, buildUserPrompt, ANALYSIS_SCHEMA } from "./prompts.mjs";
import { invokeLLM } from "./llm.mjs";

/**
 * @typedef {import('./types.mjs').ExtractedContract} ExtractedContract
 * @typedef {import('./types.mjs').ContractDiff} ContractDiff
 * @typedef {import('./llm.mjs').LLMResponse} LLMResponse
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {"auto-pr"|"create-issue"} action - Recommended action
 * @property {LLMResponse|null} llmAnalysis - LLM output (null only if not invoked)
 * @property {boolean} llmInvoked - Always true for changed diffs
 * @property {string|null} llmError - Error message if LLM failed
 * @property {ContractDiff} diff - The underlying diff
 */

/** Minimum confidence required for the LLM to green-light an auto-PR */
const AUTO_PR_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Analyze a contract diff and determine the recommended action.
 * Always invokes the LLM — no heuristic bypass.
 *
 * @param {object} env - Worker environment
 * @param {ExtractedContract} baseline
 * @param {ExtractedContract} extracted
 * @param {ContractDiff} diff
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeContractDiff(env, baseline, extracted, diff) {
  // No change — shouldn't reach here but handled defensively
  if (!diff.changed) {
    return {
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff,
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(baseline, extracted, diff);

  let llmAnalysis = null;
  let llmError = null;

  try {
    llmAnalysis = await invokeLLM(env, systemPrompt, userPrompt, ANALYSIS_SCHEMA);
  } catch (err) {
    llmError = err.message;
  }

  // Auto-PR only when LLM explicitly says safe AND confidence is high
  const action =
    llmAnalysis &&
    llmAnalysis.safe_for_auto_pr === true &&
    typeof llmAnalysis.confidence === "number" &&
    llmAnalysis.confidence >= AUTO_PR_CONFIDENCE_THRESHOLD
      ? "auto-pr"
      : "create-issue";

  return {
    action,
    llmAnalysis,
    llmInvoked: true,
    llmError,
    diff,
  };
}
