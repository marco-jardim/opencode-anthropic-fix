/**
 * State machine for per-version pipeline tracking.
 *
 * Each detected upstream version gets its own state record in KV, keyed by
 * `state:<version>`. The state machine enforces monotonic forward transitions
 * (with one backward path: FAILED_RETRYABLE → DETECTED for retry).
 *
 * State transitions:
 *   IDLE            → DETECTED          (new version found)
 *   DETECTED        → ANALYZING         (non-trivial diff, LLM invoked)
 *   DETECTED        → PR_CREATED        (trivial diff, auto-PR)
 *   ANALYZING       → ISSUE_CREATED     (LLM done, issue created)
 *   ANALYZING       → PR_CREATED        (LLM says safe for auto-PR)
 *   PR_CREATED      → DELIVERED         (PR confirmed on GitHub)
 *   ISSUE_CREATED   → DELIVERED         (Issue confirmed on GitHub)
 *   *               → FAILED_RETRYABLE  (transient error)
 *   FAILED_RETRYABLE → DETECTED         (retry)
 *   FAILED_RETRYABLE → DEAD_LETTER      (retry limit exceeded)
 *
 * Terminal states: DELIVERED, DEAD_LETTER
 *
 * @module state
 */

import { STATES, MAX_RETRIES } from "./types.mjs";

/**
 * @typedef {import('./types.mjs').State} State
 * @typedef {import('./types.mjs').StateRecord} StateRecord
 */

/** Valid transitions: Map<fromState, Set<toState>> */
const VALID_TRANSITIONS = new Map([
  [STATES.IDLE, new Set([STATES.DETECTED])],
  [STATES.DETECTED, new Set([STATES.ANALYZING, STATES.PR_CREATED, STATES.FAILED_RETRYABLE])],
  [STATES.ANALYZING, new Set([STATES.ISSUE_CREATED, STATES.PR_CREATED, STATES.FAILED_RETRYABLE])],
  [STATES.PR_CREATED, new Set([STATES.DELIVERED, STATES.FAILED_RETRYABLE])],
  [STATES.ISSUE_CREATED, new Set([STATES.DELIVERED, STATES.FAILED_RETRYABLE])],
  [STATES.DELIVERED, new Set()], // terminal
  [STATES.FAILED_RETRYABLE, new Set([STATES.DETECTED, STATES.DEAD_LETTER])],
  [STATES.DEAD_LETTER, new Set()], // terminal
]);

/** Terminal states — no further transitions */
const TERMINAL_STATES = new Set([STATES.DELIVERED, STATES.DEAD_LETTER]);

/**
 * Get the state record for a specific upstream version.
 *
 * @param {KVNamespace} kv
 * @param {string} version
 * @returns {Promise<StateRecord|null>} null if no record exists
 */
export async function getState(kv, version) {
  const json = await kv.get(stateKey(version));
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Transition a version's state record to a new state.
 *
 * - Creates the record if it doesn't exist (treating missing as IDLE).
 * - Validates the transition is allowed.
 * - For FAILED_RETRYABLE transitions: increments retry count.
 * - For DETECTED retries (from FAILED_RETRYABLE): checks if retry limit exceeded → DEAD_LETTER.
 * - Idempotent: transitioning to the current state is a no-op (returns existing record).
 *
 * @param {KVNamespace} kv
 * @param {string} version
 * @param {State} toState
 * @param {object} [meta] - Optional metadata to merge into the record
 * @param {string} [meta.error] - Error message for FAILED_RETRYABLE
 * @param {number} [meta.prNumber]
 * @param {number} [meta.issueNumber]
 * @param {string} [meta.branchName]
 * @returns {Promise<StateRecord>}
 * @throws {Error} if transition is invalid
 */
export async function transition(kv, version, toState, meta = {}) {
  const existing = await getState(kv, version);
  const fromState = existing?.state ?? STATES.IDLE;

  // Idempotent: already in target state
  if (fromState === toState) {
    return existing;
  }

  // Validate transition
  const allowed = VALID_TRANSITIONS.get(fromState);
  if (!allowed || !allowed.has(toState)) {
    throw new Error(`Invalid state transition for version ${version}: ${fromState} → ${toState}`);
  }

  const now = new Date().toISOString();

  /** @type {StateRecord} */
  const record = {
    state: toState,
    retries: existing?.retries ?? 0,
    version,
    lastEvent: `${fromState} → ${toState}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    prNumber: meta.prNumber ?? existing?.prNumber ?? null,
    issueNumber: meta.issueNumber ?? existing?.issueNumber ?? null,
    branchName: meta.branchName ?? existing?.branchName ?? null,
    error: meta.error ?? null,
  };

  // Increment retry count when entering FAILED_RETRYABLE
  if (toState === STATES.FAILED_RETRYABLE) {
    record.retries = (existing?.retries ?? 0) + 1;
  }

  await kv.put(stateKey(version), JSON.stringify(record));
  return record;
}

/**
 * Determine the next retry state: DETECTED (if retries < MAX_RETRIES) or DEAD_LETTER.
 *
 * Call this when processing a FAILED_RETRYABLE record to decide whether to retry.
 *
 * @param {StateRecord} record
 * @returns {State} DETECTED or DEAD_LETTER
 */
export function nextRetryState(record) {
  return record.retries >= MAX_RETRIES ? STATES.DEAD_LETTER : STATES.DETECTED;
}

/**
 * Check if a state is terminal.
 *
 * @param {State} state
 * @returns {boolean}
 */
export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

/**
 * KV key for a version's state record.
 *
 * @param {string} version
 * @returns {string}
 */
function stateKey(version) {
  return `state:${version}`;
}
