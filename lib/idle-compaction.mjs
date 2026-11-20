/**
 * Idle compaction scheduler (pure).
 *
 * Mirrors the genuine client's idle compaction (current upstream release): when a
 * session goes idle with a 1-hour prompt cache, compact the conversation shortly
 * BEFORE the cache expires (at 90% of its life), so the compaction request still
 * reads the cached prefix instead of paying for a cold re-write of a large
 * context.
 *
 * This module owns only the timing decision and the timer bookkeeping. It never
 * performs compaction, reads config, touches the network or the host: the host
 * wires `onFire` and decides whether to act (config opt-in, rate-limit state, a
 * summarize API being available). Time and timers are injected so the whole thing
 * is deterministic under test.
 */

/** Fraction of the cache lifetime after which the compaction fires. */
export const IDLE_COMPACT_FRACTION = 0.9;

/** A timer that fires later than this after the deadline is stale: refuse it. */
export const IDLE_COMPACT_MAX_LATE_MS = 60_000;

/** Lowest context size (tokens) the minimum can ever be set to. */
export const IDLE_COMPACT_MIN_TOKENS_FLOOR = 100_000;

/** Context size (tokens) below which compaction is not worth it, when nothing else is set. */
export const IDLE_COMPACT_DEFAULT_MIN_TOKENS = 200_000;

const ONE_HOUR_MS = 60 * 60 * 1000;
/** Largest delay a platform timer accepts (2^31 - 1 ms). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * When should the idle compaction fire? Only a 1-hour cache qualifies: a 5-minute
 * cache is too short to schedule anything useful against.
 *
 * @param {{ lastActivityAt: number, ttl: unknown }} options
 * @returns {number | null} Epoch ms of the deadline, or null when none applies.
 */
export function computeIdleCompactionDeadline({ lastActivityAt, ttl }) {
  if (ttl !== "1h") return null;
  if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt)) return null;
  return lastActivityAt + IDLE_COMPACT_FRACTION * ONE_HOUR_MS;
}

/**
 * Minimum context size for idle compaction:
 * `max(100000, env CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS || configured || 200000)`.
 * A malformed or non-positive env value is ignored, like an unset one.
 *
 * @param {{ env?: Record<string, string | undefined>, configured?: number }} [options]
 * @returns {number}
 */
export function resolveIdleCompactMinTokens({ env = process.env, configured } = {}) {
  const fromEnv = Number(env?.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS);
  const fromConfig = typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : 0;
  const requested =
    (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 0) || fromConfig || IDLE_COMPACT_DEFAULT_MIN_TOKENS;
  return Math.max(IDLE_COMPACT_MIN_TOKENS_FLOOR, requested);
}

/**
 * Should a fired timer actually compact?
 *
 * False when: there is no deadline, the timer fired more than 60 s after the
 * deadline (the machine slept; the cache is likely gone and the premise is
 * stale), the account's usage is limited, or the context is below the minimum.
 *
 * @param {{ now: number, deadline: number | null, estimatedTokens: number, minTokens: number, usageLimited?: boolean }} options
 * @returns {boolean}
 */
export function shouldIdleCompact({ now, deadline, estimatedTokens, minTokens, usageLimited = false }) {
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return false;
  if (now - deadline > IDLE_COMPACT_MAX_LATE_MS) return false;
  if (usageLimited === true) return false;
  if (typeof estimatedTokens !== "number" || !Number.isFinite(estimatedTokens)) return false;
  return estimatedTokens >= minTokens;
}

/**
 * @typedef {object} IdleCompactionContext
 * @property {number} lastActivityAt - Epoch ms of the last request/response.
 * @property {unknown} ttl - Prompt-cache TTL of that conversation ("1h" qualifies).
 * @property {number} [estimatedTokens]
 * @property {string} [modelID]
 */

/**
 * @typedef {object} IdleCompactionFire
 * @property {number} deadline - Epoch ms the timer was scheduled for.
 * @property {number} firedAt - Epoch ms the timer actually fired.
 * @property {number} lateMs - firedAt - deadline (may be negative on an early timer).
 * @property {boolean} late - lateMs exceeds `IDLE_COMPACT_MAX_LATE_MS`.
 * @property {IdleCompactionContext} context - The context given to `arm`.
 */

/**
 * One timer per session key. `arm` (re)schedules, `cancel` clears one key,
 * `dispose` clears everything and refuses further arming. Timers are unref'd so
 * a pending compaction never keeps the process alive.
 *
 * `onFire` receives the session key and the firing details; it is expected to
 * apply `shouldIdleCompact` plus its own host gates. A throwing or rejecting
 * `onFire` is contained: a scheduler must never take the host down.
 *
 * @param {{
 *   setTimeout?: (fn: () => void, ms: number) => unknown,
 *   clearTimeout?: (timer: unknown) => void,
 *   now?: () => number,
 *   onFire: (key: string, fire: IdleCompactionFire) => unknown,
 * }} options
 */
export function createIdleCompactionScheduler({
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  now = Date.now,
  onFire,
}) {
  /** @type {Map<string, unknown>} */
  const timers = new Map();
  let disposed = false;

  function cancel(key) {
    const timer = timers.get(key);
    if (timer === undefined) return false;
    timers.delete(key);
    clearTimer(timer);
    return true;
  }

  /**
   * @param {string} key
   * @param {IdleCompactionContext} context
   * @returns {boolean} true when a timer is now pending for the key.
   */
  function arm(key, context) {
    if (disposed) return false;
    cancel(key);
    const deadline = computeIdleCompactionDeadline({
      lastActivityAt: context?.lastActivityAt,
      ttl: context?.ttl,
    });
    if (deadline === null) return false;

    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - now()));
    const timer = setTimer(() => {
      // Only act if THIS timer is still the registered one (a re-arm replaces it).
      if (timers.get(key) !== timer) return;
      timers.delete(key);
      const firedAt = now();
      const lateMs = firedAt - deadline;
      try {
        const result = onFire(key, {
          deadline,
          firedAt,
          lateMs,
          late: lateMs > IDLE_COMPACT_MAX_LATE_MS,
          context,
        });
        if (result && typeof (/** @type {any} */ (result).catch) === "function") {
          /** @type {Promise<unknown>} */ (result).catch(() => {});
        }
      } catch {
        // contained on purpose
      }
    }, delay);
    if (timer && typeof (/** @type {any} */ (timer).unref) === "function") /** @type {any} */ (timer).unref();
    timers.set(key, timer);
    return true;
  }

  function dispose() {
    disposed = true;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  }

  return {
    arm,
    cancel,
    dispose,
    /** Number of pending timers (diagnostics and tests). */
    get pending() {
      return timers.size;
    },
  };
}
