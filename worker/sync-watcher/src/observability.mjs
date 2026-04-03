/**
 * Observability helpers: structured logging and DEAD_LETTER alerting.
 *
 * @module observability
 */

const ALERT_KEY_PREFIX = "alert:dead_letter:";

/**
 * Store a DEAD_LETTER alert in KV for dashboard pickup.
 * Alerts are keyed by version so they don't accumulate unboundedly.
 *
 * @param {KVNamespace} kv
 * @param {string} version
 * @param {import('./types.mjs').StateRecord} record
 * @returns {Promise<void>}
 */
export async function storeDeadLetterAlert(kv, version, record) {
  const alert = {
    version,
    state: record.state,
    retries: record.retries,
    error: record.error,
    updatedAt: record.updatedAt,
    alertedAt: new Date().toISOString(),
  };
  // 90-day TTL — prevents unbounded accumulation in KV
  await kv.put(`${ALERT_KEY_PREFIX}${version}`, JSON.stringify(alert), {
    expirationTtl: 90 * 86_400,
  });
}

/**
 * Retrieve a stored DEAD_LETTER alert.
 *
 * @param {KVNamespace} kv
 * @param {string} version
 * @returns {Promise<object|null>}
 */
export async function getDeadLetterAlert(kv, version) {
  const json = await kv.get(`${ALERT_KEY_PREFIX}${version}`);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Calculate estimated cost for an LLM invocation.
 *
 * Kimi K2.5 pricing (Workers AI):
 * - Input:  $0.60 / 1M tokens
 * - Output: $3.00 / 1M tokens
 *
 * @param {{input: number, output: number}} tokenUsage
 * @returns {number} cost in USD
 */
export function estimateCost(tokenUsage) {
  const inputCost = (tokenUsage.input / 1_000_000) * 0.6;
  const outputCost = (tokenUsage.output / 1_000_000) * 3.0;
  return inputCost + outputCost;
}
