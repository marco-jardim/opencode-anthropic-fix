/**
 * Workers AI client for Kimi K2.5 contract analysis.
 *
 * Wraps env.AI.run() with error handling, timeout, and response validation.
 *
 * @module llm
 */

const LLM_TIMEOUT_MS = 120_000;

/**
 * @typedef {Object} LLMResponse
 * @property {boolean} safe_for_auto_pr
 * @property {"low"|"medium"|"high"|"critical"} risk_level
 * @property {string} summary
 * @property {Array<{field: string, description: string, impact: string, action_required: string}>} changes
 * @property {Array<{file: string, description: string}>} [recommended_file_changes]
 * @property {number} confidence
 */

/**
 * Invoke Kimi K2.5 for structured analysis.
 *
 * @param {object} env - Worker environment bindings
 * @param {string} env.AI_MODEL - Model ID (default: @cf/moonshotai/kimi-k2.5)
 * @param {AI} env.AI - Workers AI binding
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} schema - JSON schema for structured output
 * @returns {Promise<LLMResponse>}
 * @throws {Error} on model error, timeout, or invalid response
 */
export async function invokeLLM(env, systemPrompt, userPrompt, schema) {
  const modelId = env.AI_MODEL ?? "@cf/moonshotai/kimi-k2.5";

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Run with timeout
  const result = await Promise.race([
    runModel(env.AI, modelId, messages, schema),
    timeoutPromise(LLM_TIMEOUT_MS, `LLM inference timed out after ${LLM_TIMEOUT_MS}ms`),
  ]);

  return result;
}

/**
 * Call Workers AI and parse the structured response.
 *
 * @param {AI} ai
 * @param {string} modelId
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} schema
 * @returns {Promise<LLMResponse>}
 */
async function runModel(ai, modelId, messages, schema) {
  let response;
  try {
    response = await ai.run(modelId, {
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "contract_analysis", schema },
      },
      // Enable thinking for complex analysis (costs more but more reliable)
      // Kimi K2.5 thinking is on by default; we keep it enabled
    });
  } catch (err) {
    throw new Error(`Workers AI model error: ${err.message}`, { cause: err });
  }

  // Workers AI may return either:
  //   - Old format: { response: string }
  //   - OpenAI-compatible: { choices: [{ message: { content: string } }] }
  //   - Already a string
  const raw = response?.choices?.[0]?.message?.content ?? response?.response ?? response;
  if (typeof raw !== "string") {
    throw new Error(`Unexpected Workers AI response shape: ${JSON.stringify(raw).slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 500)}`);
  }

  validateAnalysisResponse(parsed);
  return parsed;
}

/**
 * Validate that a parsed response has all required fields.
 *
 * @param {any} obj
 * @throws {Error} if validation fails
 */
function validateAnalysisResponse(obj) {
  if (typeof obj.safe_for_auto_pr !== "boolean") {
    throw new Error("LLM response missing or invalid 'safe_for_auto_pr' field");
  }
  if (!["low", "medium", "high", "critical"].includes(obj.risk_level)) {
    throw new Error(`LLM response has invalid 'risk_level': ${obj.risk_level}`);
  }
  if (typeof obj.summary !== "string") {
    throw new Error("LLM response missing 'summary' field");
  }
  if (!Array.isArray(obj.changes)) {
    throw new Error("LLM response missing 'changes' array");
  }
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    throw new Error(`LLM response has invalid 'confidence': ${obj.confidence}`);
  }
}

/**
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<never>}
 */
function timeoutPromise(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
