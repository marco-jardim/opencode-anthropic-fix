/**
 * Centralized documentation for tuning values that are currently inline in
 * index.mjs; these exports are not wired into runtime code yet, and Wave 3 will
 * replace the inline values with imports from this module.
 *
 * Constants that are already centralized remain in their existing homes:
 * retry cooldown constants live in lib/backoff.mjs, while account-selection
 * stickiness and switch thresholds live in lib/rotation.mjs.
 *
 * @module tuning
 */

/**
 * Bounds foreground service-wide retries so overload recovery cannot loop indefinitely.
 * Current call-site: index.mjs:2662.
 * @see docs/claude-code-reverse-engineering.md
 */
export const SERVICE_WIDE_MAX_RETRIES = 2;

/**
 * Delays model fallback until repeated overloads show that retrying the current model is ineffective.
 * Current call-site: index.mjs:3892.
 * @see docs/claude-code-reverse-engineering.md
 */
export const CONSECUTIVE_529_FALLBACK_THRESHOLD = 3;

/**
 * Starts service retries with a short delay to recover quickly from transient overloads.
 * Current call-site: index.mjs:3927.
 * @see docs/claude-code-reverse-engineering.md
 */
export const SERVICE_RETRY_BASE_DELAY_SEC = 0.5;

/**
 * Doubles each service-retry delay to reduce pressure during a sustained outage.
 * Current call-site: index.mjs:3927.
 * @see docs/claude-code-reverse-engineering.md
 */
export const SERVICE_RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * Caps service-retry latency so overload handling remains responsive.
 * Current call-site: index.mjs:3927.
 * @see docs/claude-code-reverse-engineering.md
 */
export const SERVICE_RETRY_MAX_DELAY_SEC = 3;

/**
 * Spreads service retries across clients while retaining most of the calculated delay.
 * Current call-site: index.mjs:3928.
 * @see docs/claude-code-reverse-engineering.md
 */
export const SERVICE_RETRY_JITTER_FRACTION = 0.25;

/**
 * Prevents an unresponsive OAuth refresh request from blocking account recovery indefinitely.
 * Current call-site: index.mjs:9419.
 * @see test/conformance/regression.test.mjs Fix #12
 */
export const TOKEN_REFRESH_TIMEOUT_MS = 15000;

/**
 * Refreshes foreground credentials early enough to avoid token expiry during an active request.
 * Current call-site: index.mjs:2714.
 * @see test/conformance/regression.test.mjs Fix #13
 */
export const FOREGROUND_REFRESH_EXPIRY_BUFFER_MS = 300000;
