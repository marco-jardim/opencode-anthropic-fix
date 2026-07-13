/**
 * Centralized tuning values for retry / overload-recovery behavior, wired into
 * runtime code as of Wave 3. The service-wide retry budget and the 529 fallback
 * threshold are consumed directly in index.mjs; the base-delay, backoff, max-delay
 * and jitter constants are consumed by the pure decision helpers in
 * lib/retry/overload-loop.mjs. The OAuth token-refresh timeout and the
 * foreground-refresh expiry buffer remain inline in index.mjs (documented below).
 *
 * Constants that are already centralized remain in their existing homes:
 * retry cooldown constants live in lib/backoff.mjs, while account-selection
 * stickiness and switch thresholds live in lib/rotation.mjs.
 *
 * @module tuning
 */

/**
 * Bounds foreground service-wide retries so overload recovery cannot loop indefinitely.
 * Consumed at the index.mjs maxServiceRetries budget (foreground branch).
 * @see lib/retry/overload-loop.mjs
 */
export const SERVICE_WIDE_MAX_RETRIES = 2;

/**
 * Delays model fallback until repeated overloads show that retrying the current model is ineffective.
 * Consumed at the index.mjs consecutive-529 model-fallback gate.
 * @see lib/retry/overload-loop.mjs
 */
export const CONSECUTIVE_529_FALLBACK_THRESHOLD = 3;

/**
 * Starts service retries with a short delay to recover quickly from transient overloads.
 * Consumed by computeServiceRetrySleepMs in lib/retry/overload-loop.mjs.
 * @see lib/retry/overload-loop.mjs
 */
export const SERVICE_RETRY_BASE_DELAY_SEC = 0.5;

/**
 * Doubles each service-retry delay to reduce pressure during a sustained outage.
 * Consumed by computeServiceRetrySleepMs in lib/retry/overload-loop.mjs.
 * @see lib/retry/overload-loop.mjs
 */
export const SERVICE_RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * Caps service-retry latency so overload handling remains responsive.
 * Consumed by computeServiceRetrySleepMs in lib/retry/overload-loop.mjs.
 * @see lib/retry/overload-loop.mjs
 */
export const SERVICE_RETRY_MAX_DELAY_SEC = 3;

/**
 * Spreads service retries across clients while retaining most of the calculated delay.
 * Consumed by computeServiceRetrySleepMs in lib/retry/overload-loop.mjs.
 * @see lib/retry/overload-loop.mjs
 */
export const SERVICE_RETRY_JITTER_FRACTION = 0.25;

/**
 * Prevents an unresponsive OAuth refresh request from blocking account recovery indefinitely.
 * Current call-site: index.mjs (inline OAuth refresh AbortSignal.timeout).
 * @see test/conformance/regression.test.mjs Fix #12
 */
export const TOKEN_REFRESH_TIMEOUT_MS = 15000;

/**
 * Refreshes foreground credentials early enough to avoid token expiry during an active request.
 * Current call-site: index.mjs (inline foreground refresh expiry check).
 * @see test/conformance/regression.test.mjs Fix #13
 */
export const FOREGROUND_REFRESH_EXPIRY_BUFFER_MS = 300000;
