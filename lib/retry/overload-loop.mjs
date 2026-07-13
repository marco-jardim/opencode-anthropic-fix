/**
 * Pure decision helpers for the service-wide retry / overload-recovery loop.
 *
 * The effectful retry loop itself (account switching, sleeping, toasts, body
 * rewriting, response transformation) stays in index.mjs; this module holds the
 * side-effect-free computations it depends on so they can be unit-tested
 * directly. Tuning values come from lib/tuning.mjs (single source of truth).
 *
 * @module retry/overload-loop
 */

import {
  SERVICE_RETRY_BASE_DELAY_SEC,
  SERVICE_RETRY_BACKOFF_MULTIPLIER,
  SERVICE_RETRY_MAX_DELAY_SEC,
  SERVICE_RETRY_JITTER_FRACTION,
} from "../tuning.mjs";

/**
 * Exponential backoff (capped) with downward jitter for service-wide 529/503
 * retries. Verbatim-equivalent to the former inline formula in index.mjs.
 *
 * @param {number} serviceWideRetryCount - Number of service-wide retries already taken.
 * @param {{baseDelaySec?: number, backoffMultiplier?: number, maxDelaySec?: number, jitterFraction?: number}} [opts]
 * @param {() => number} [random] - Injectable RNG (defaults to Math.random) for deterministic tests.
 * @returns {number} Sleep duration in milliseconds.
 */
export function computeServiceRetrySleepMs(serviceWideRetryCount, opts = {}, random = Math.random) {
  const baseDelaySec = opts.baseDelaySec ?? SERVICE_RETRY_BASE_DELAY_SEC;
  const multiplier = opts.backoffMultiplier ?? SERVICE_RETRY_BACKOFF_MULTIPLIER;
  const maxDelaySec = opts.maxDelaySec ?? SERVICE_RETRY_MAX_DELAY_SEC;
  const jitterFraction = opts.jitterFraction ?? SERVICE_RETRY_JITTER_FRACTION;
  const baseDelay = Math.min(baseDelaySec * Math.pow(multiplier, serviceWideRetryCount), maxDelaySec);
  const jitter = 1 - random() * jitterFraction;
  return Math.round(baseDelay * jitter * 1000);
}

/**
 * Model fallback chain for sustained overloads: opus -> sonnet -> haiku.
 * Verbatim-equivalent to the former inline logic in index.mjs.
 *
 * @param {string} currentModel - The model id currently being requested.
 * @returns {string|null} The next fallback model id, or null if none applies.
 */
export function selectFallbackModel(currentModel) {
  const model = currentModel || "";
  if (/opus-4-6|opus-4/i.test(model)) return model.replace(/opus/i, "sonnet");
  if (/sonnet-4-6|sonnet-4/i.test(model)) return model.replace(/sonnet/i, "haiku");
  return null;
}

/**
 * Whether a 529 (overloaded) / 503 (unavailable) response is still eligible for
 * a service-wide sleep-and-retry (as opposed to overload-recovery / return).
 *
 * @param {number} status
 * @param {number} serviceWideRetryCount
 * @param {number} maxServiceRetries
 * @returns {boolean}
 */
export function shouldServiceRetry(status, serviceWideRetryCount, maxServiceRetries) {
  return (status === 529 || status === 503) && serviceWideRetryCount < maxServiceRetries;
}

/**
 * Whether a 429 is a transient burst-throttle (short retry-after) that should be
 * retried on the SAME account rather than rotating the account pool.
 *
 * @param {number} status
 * @param {string|null|undefined} reason - Parsed rate-limit reason.
 * @param {number|null|undefined} retryAfterMs - Parsed retry-after in ms.
 * @param {number} thresholdMs - Upper bound below which a 429 counts as transient.
 * @returns {boolean}
 */
export function isTransientRateLimit(status, reason, retryAfterMs, thresholdMs) {
  return (
    status === 429 &&
    reason === "RATE_LIMIT_EXCEEDED" &&
    retryAfterMs != null &&
    retryAfterMs > 0 &&
    retryAfterMs <= thresholdMs
  );
}
