/**
 * Per-turn effort through the genuine control message.
 *
 * The genuine client changes the effort of ONE turn, mid-conversation, without
 * rewriting the cached prefix: before the turn whose effort differs from the
 * effort in force it puts a `role: "system"` entry with an empty content list
 * and an `output_config` into `messages`
 *
 *     {"role":"system","content":[],"output_config":{"effort":"low"}}
 *
 * (attaching `output_config` to the system entry right before the turn when
 * there already is one). The top-level `output_config.effort` stays the
 * effort the conversation was established with. The wire library accepts that
 * shape on the 2.1.329 profile only, passes it through verbatim, and composes
 * `per-turn-control-2026-07-01` for models whose catalogue entry declares
 * `per_turn_effort`.
 *
 * CACHE SAFETY IS THE POINT. A request is the byte-for-byte continuation of
 * the previous one up to its newest turn, so the control messages of ALL past
 * turns are re-derived on every request from what was decided when each turn
 * first appeared. The decision for a turn is made exactly once, on the request
 * where it is the newest message, and remembered; nothing about a past turn is
 * ever recomputed from the current host effort or the current config.
 *
 * Two effort sources feed the decision for a new turn:
 *  - the host's effort (an opencode variant switch changes it mid-session);
 *  - auto-low: a short typed question is answered at "low".
 * Both are expressed as control messages. The session's top-level effort is its
 * base and never moves. Thinking is never touched here.
 *
 * Pure apart from the per-session memory, which is an LRU of sessions with a
 * bounded number of remembered turns each.
 */

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Sessions remembered at once (least recently used evicted first). */
export const MAX_TRACKED_SESSIONS = 256;

/** Turns remembered per session (oldest evicted first). */
export const MAX_TRACKED_TURNS = 4096;

/**
 * @typedef {object} SessionState
 * @property {string} model Model the base was established with.
 * @property {string} base The conversation's established effort (top-level).
 * @property {Map<string, string>} turns Turn key -> effort decided for that turn.
 */

/** @type {Map<string, SessionState>} */
const sessions = new Map();

/** Test hook: forget every session. */
export function resetPerTurnEffortState() {
  sessions.clear();
}

/** @returns {number} Sessions currently remembered (diagnostics and tests). */
export function trackedPerTurnEffortSessions() {
  return sessions.size;
}

/**
 * A `<router-state>` tail: per-request state the host never persists. It must
 * not count as typed text and must not feed a turn's identity, or the identity
 * would change from one request of the turn to the next.
 *
 * @param {unknown} block
 * @returns {boolean}
 */
function isRouterStateBlock(block) {
  if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return false;
  const text = block.text.trim();
  return text.startsWith("<router-state>") && text.endsWith("</router-state>");
}

/**
 * FNV-1a over UTF-16 code units, 32 bit, hex. A fingerprint, not a secret.
 *
 * @param {string} text
 * @returns {string}
 */
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * @typedef {object} Turn
 * @property {number} index Position of the user message in `messages`.
 * @property {string} key Stable identity: index plus a fingerprint of its text.
 * @property {string} text Typed text (router-state tails excluded).
 * @property {boolean} typedOnly True when the message is typed text and nothing else.
 */

/**
 * Describe a message as a user turn, or null when it is not one: not a user
 * message, a tool-result continuation, or nothing typed at all.
 *
 * @param {any} message
 * @param {number} index
 * @returns {Turn | null}
 */
function describeTurn(message, index) {
  if (!message || typeof message !== "object" || message.role !== "user") return null;
  const content = message.content;
  let text = "";
  let typedOnly = true;
  let shape = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") return null;
      if (block.type === "text") {
        if (isRouterStateBlock(block)) continue;
        if (typeof block.text === "string") text += block.text;
        continue;
      }
      typedOnly = false;
      shape += `|${String(block.type)}`;
    }
  } else {
    return null;
  }
  if (text.trim() === "" && typedOnly) return null;
  return { index, key: `${index}:${fingerprint(text)}:${text.length}${shape}`, text, typedOnly };
}

/**
 * @param {readonly any[]} messages
 * @returns {Turn[]}
 */
function findTurns(messages) {
  /** @type {Turn[]} */
  const turns = [];
  for (let i = 0; i < messages.length; i++) {
    const turn = describeTurn(messages[i], i);
    if (turn) turns.push(turn);
  }
  return turns;
}

/**
 * Does this turn count as a short question?
 *
 * @param {Turn} turn
 * @param {number} maxChars
 * @returns {boolean}
 */
function isShortQuestion(turn, maxChars) {
  if (!turn.typedOnly) return false;
  const text = turn.text.trim();
  if (text === "" || text.length > maxChars) return false;
  return !text.includes("```");
}

/**
 * An assistant message that left `tool_use` blocks open right before a typed
 * turn is an interrupted call. The orphan repair later in the pipeline folds
 * the missing results into that user turn, so nothing may sit between the two.
 *
 * @param {any} previous
 * @returns {boolean}
 */
function endsWithToolUse(previous) {
  return (
    previous?.role === "assistant" &&
    Array.isArray(previous.content) &&
    previous.content.some((block) => block?.type === "tool_use")
  );
}

/**
 * @typedef {object} PerTurnEffortInput
 * @property {readonly any[]} messages The conversation, without control messages.
 * @property {string} sessionKey Conversation identity (`runtime.sessionKey`).
 * @property {string} model Wire model id.
 * @property {string} effort The effort the request resolved to (host or default).
 * @property {{enabled?: boolean, auto_low_short_questions?: boolean, short_question_max_chars?: number} | undefined} settings
 *   Config `per_turn_effort`.
 * @property {boolean} capable The model's catalogue entry has `per_turn_effort`.
 */

/**
 * Apply per-turn effort to a main-thread request.
 *
 * @param {PerTurnEffortInput} input
 * @returns {{messages: readonly any[], effort: string, active: boolean}}
 *   `effort` is the value for the top-level `output_config.effort`: the
 *   session's base once the feature is active, the input otherwise.
 */
export function applyPerTurnEffort(input) {
  const { messages, sessionKey, model, effort, settings, capable } = input;
  const inactive = { messages, effort, active: false };
  if (!settings || settings.enabled !== true || capable !== true) return inactive;
  if (!Array.isArray(messages) || messages.length === 0) return inactive;
  if (typeof effort !== "string" || !EFFORT_LEVELS.has(effort)) return inactive;

  const turns = findTurns(messages);
  if (turns.length === 0) return inactive;

  let state = sessions.get(sessionKey);
  sessions.delete(sessionKey);
  // A different model, or a conversation whose first message is not the one we
  // saw (cleared, compacted, branched): nothing sent before is a prefix of this
  // request, so the memory is stale and the effort now in hand becomes the base.
  const first = turns[0];
  if (state && (state.model !== model || (first.index === 0 && state.turns.size > 0 && !state.turns.has(first.key)))) {
    state = undefined;
  }
  if (!state) state = { model, base: effort, turns: new Map() };

  const lastIndex = messages.length - 1;
  const newest = turns[turns.length - 1];
  const autoLow = settings.auto_low_short_questions === true;
  const maxChars =
    typeof settings.short_question_max_chars === "number" && settings.short_question_max_chars > 0
      ? settings.short_question_max_chars
      : 280;

  /** @type {Map<string, string>} */
  const decided = new Map();
  for (const turn of turns) {
    let turnEffort = state.turns.get(turn.key);
    if (turnEffort === undefined) {
      if (turn.index === 0 || turn !== newest) {
        // The conversation's first turn IS the base; an older turn this process
        // never saw was sent before it started tracking, at the base.
        turnEffort = state.base;
      } else {
        // The newest turn, seen for the first time: decide it now, once. A
        // tool-result continuation has no typed turn at the end, so only a
        // typed message that IS the last message can be auto-low.
        turnEffort = effort;
        if (autoLow && turn.index === lastIndex && isShortQuestion(turn, maxChars)) turnEffort = "low";
      }
    }
    decided.set(turn.key, turnEffort);
  }

  const byIndex = new Map(turns.map((turn) => [turn.index, turn]));
  /** @type {any[]} */
  const out = [];
  let inForce = state.base;
  for (let i = 0; i < messages.length; i++) {
    const turn = byIndex.get(i);
    if (turn && i > 0) {
      const wanted = /** @type {string} */ (decided.get(turn.key));
      const previous = out[out.length - 1];
      if (previous?.role === "system" && previous.output_config && typeof previous.output_config === "object") {
        // The host already put a statement there: it speaks for this turn.
        if (EFFORT_LEVELS.has(previous.output_config.effort)) inForce = previous.output_config.effort;
      } else if (wanted !== inForce && !endsWithToolUse(messages[i - 1])) {
        if (previous?.role === "system") {
          out[out.length - 1] = { ...previous, output_config: { effort: wanted } };
        } else {
          out.push({ role: "system", content: [], output_config: { effort: wanted } });
        }
        inForce = wanted;
      }
    }
    out.push(messages[i]);
  }

  // Remember only the turns this request carries, bounded.
  state.turns = decided;
  while (state.turns.size > MAX_TRACKED_TURNS) {
    const oldest = state.turns.keys().next().value;
    if (oldest === undefined) break;
    state.turns.delete(oldest);
  }
  sessions.set(sessionKey, state);
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }

  return { messages: out, effort: state.base, active: true };
}
