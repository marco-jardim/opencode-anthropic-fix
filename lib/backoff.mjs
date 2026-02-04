/**
 * @typedef {'QUOTA_EXHAUSTED' | 'RATE_LIMIT_EXCEEDED' | 'OVERLOADED' | 'UNKNOWN'} RateLimitReason
 */

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000];
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
const OVERLOADED_BASE_BACKOFF = 45_000;
const OVERLOADED_JITTER_MAX = 30_000;
const UNKNOWN_BACKOFF = 60_000;
const MIN_BACKOFF_MS = 2_000;

/**
 * Generate jitter in range [-maxJitterMs/2, +maxJitterMs/2].
 * @param {number} maxJitterMs
 * @returns {number}
 */
function generateJitter(maxJitterMs) {
  return Math.random() * maxJitterMs - maxJitterMs / 2;
}

/**
 * Parse the Retry-After header from a response.
 * Supports both seconds (integer) and HTTP-date formats.
 * @param {Response} response
 * @returns {number | null} Retry-after duration in milliseconds, or null
 */
export function parseRetryAfterHeader(response) {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  // Try as integer (seconds)
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try as HTTP-date
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : null;
  }

  return null;
}

/**
 * Parse the rate limit reason from an HTTP status and response body.
 * @param {number} status
 * @param {string | object | null} [body]
 * @returns {RateLimitReason}
 */
export function parseRateLimitReason(status, body) {
  if (status === 529 || status === 503) return "OVERLOADED";

  // Try to extract error details from body
  let message = "";
  let errorType = "";

  if (body) {
    try {
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      message = (parsed?.error?.message || "").toLowerCase();
      errorType = (parsed?.error?.type || "").toLowerCase();
    } catch {
      if (typeof body === "string") {
        message = body.toLowerCase();
      }
    }
  }

  if (status === 429) {
    if (
      errorType.includes("quota") ||
      message.includes("quota") ||
      message.includes("exhausted")
    ) {
      return "QUOTA_EXHAUSTED";
    }

    if (
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      message.includes("per minute")
    ) {
      return "RATE_LIMIT_EXCEEDED";
    }

    if (
      message.includes("overloaded") ||
      message.includes("capacity")
    ) {
      return "OVERLOADED";
    }

    // Default 429 to rate limit exceeded
    return "RATE_LIMIT_EXCEEDED";
  }

  return "UNKNOWN";
}

/**
 * Calculate backoff duration in milliseconds.
 * @param {RateLimitReason} reason
 * @param {number} consecutiveFailures - Zero-based count of consecutive failures
 * @param {number | null} [retryAfterMs] - Value from Retry-After header
 * @returns {number}
 */
export function calculateBackoffMs(reason, consecutiveFailures, retryAfterMs) {
  // Retry-After header takes precedence
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.max(retryAfterMs, MIN_BACKOFF_MS);
  }

  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(
        consecutiveFailures,
        QUOTA_EXHAUSTED_BACKOFFS.length - 1,
      );
      return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF;
    }
    case "RATE_LIMIT_EXCEEDED":
      return RATE_LIMIT_EXCEEDED_BACKOFF;
    case "OVERLOADED":
      return Math.max(
        MIN_BACKOFF_MS,
        OVERLOADED_BASE_BACKOFF + generateJitter(OVERLOADED_JITTER_MAX),
      );
    case "UNKNOWN":
    default:
      return UNKNOWN_BACKOFF;
  }
}

/**
 * Check if an HTTP status code indicates a rate limit or capacity error
 * that should trigger account switching.
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return status === 429 || status === 529 || status === 503;
}
