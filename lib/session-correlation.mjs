/**
 * Per-conversation correlation state for the 2.1.329 wire inputs.
 *
 * The genuine client threads a handful of conversation-scoped values through
 * every request: the prompt UUID and the prompt/turn counters (billing-block
 * segments), the previous response's `request-id` (billing `cc_prev_req`), the
 * previous response's message id (body `diagnostics`), and the tools the
 * conversation has used (`x-claude-code-sandy-plover`). The wire library only
 * PLACES them; it cannot observe them. This module owns the observable part.
 *
 * Counting rules (only the first request and the typed-prompt boundary are
 * attested; the increment after the first request is INFERRED from the segment
 * names and is documented as such in docs/mimicry/wire-compat-divergences.md):
 *
 *  - A request whose last user message carries typed text and no tool result,
 *    and whose fingerprint differs from the current prompt's, starts a NEW
 *    prompt: fresh UUID, `promptIndex++`, `turnIndex = 1`. The first typed prompt is
 *    index 1, as the genuine interactive client sends it (live capture:
 *    `cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;`).
 *  - The first request of a session always starts a prompt, typed text or not
 *    (a resumed conversation can open on a tool result).
 *  - Any other request is another model turn of the same prompt:
 *    `turnIndex++`. A re-send of the same prompt (retry, regenerate) therefore
 *    counts as a further turn instead of a new prompt.
 *
 * Pure of I/O. Randomness (the prompt UUID) is injectable for tests.
 * @module session-correlation
 */

import { randomUUID } from "node:crypto";

/** The library rejects more than 64 `toolsUsed` entries and over 7168 serialized bytes. */
export const MAX_TOOLS_USED = 64;
const MAX_TOOL_NAME_LENGTH = 256;
/** Stay under the library's 7168-byte ceiling with room for its own framing. */
const MAX_TOOLS_USED_SERIALIZED = 7000;

const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,36}$/;
/** The library throws INVALID_INPUT for a previous message id outside this shape. */
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_]{1,64}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MCP_TOOL_PREFIX = "mcp__";
const PROMPT_FINGERPRINT_TEXT_LIMIT = 256;

/**
 * @typedef {object} CorrelationSnapshot
 * @property {string} promptId
 * @property {number} promptIndex
 * @property {number} turnIndex
 * @property {string | undefined} previousRequestId
 * @property {string | undefined} previousMessageId
 * @property {{name: string, mcp?: true}[]} toolsUsed
 */

/**
 * The typed text of the LAST user message, or null when that message is not a
 * typed prompt (a tool-result turn, an empty message, or no user message).
 *
 * @param {unknown} messages
 * @returns {string | null}
 */
export function lastTypedPromptText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content.trim() === "" ? null : content;
    if (!Array.isArray(content)) return null;
    let text = "";
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") return null;
      if (block.type === "text" && typeof block.text === "string") text += block.text;
    }
    return text.trim() === "" ? null : text;
  }
  return null;
}

/**
 * Distinct `tool_use` names of a message list, first-seen order.
 *
 * @param {unknown} messages
 * @returns {string[]}
 */
function toolUseNames(messages) {
  /** @type {string[]} */
  const names = [];
  if (!Array.isArray(messages)) return names;
  for (const message of messages) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && block.type === "tool_use" && typeof block.name === "string") names.push(block.name);
    }
  }
  return names;
}

/**
 * @param {{name: string, mcp?: true}[]} tools
 * @returns {{name: string, mcp?: true}[]}
 */
function boundedToolsUsed(tools) {
  const kept = tools.slice(0, MAX_TOOLS_USED);
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_TOOLS_USED_SERIALIZED) kept.pop();
  return kept;
}

/**
 * @param {{maxSessions?: number, randomUUID?: () => string}} [options]
 */
export function createSessionCorrelation({ maxSessions = 256, randomUUID: uuid = randomUUID } = {}) {
  /**
   * @type {Map<string, {
   *   promptId: string | null,
   *   promptIndex: number,
   *   turnIndex: number,
   *   fingerprint: string | null,
   *   previousRequestId: string | undefined,
   *   previousMessageId: string | undefined,
   *   usedTools: Map<string, {name: string, mcp?: true}>,
   * }>}
   */
  const sessions = new Map();

  function touch(sessionKey) {
    let state = sessions.get(sessionKey);
    if (state) {
      sessions.delete(sessionKey);
    } else {
      state = {
        promptId: null,
        promptIndex: 0,
        turnIndex: 0,
        fingerprint: null,
        previousRequestId: undefined,
        previousMessageId: undefined,
        usedTools: new Map(),
      };
    }
    sessions.set(sessionKey, state);
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return state;
  }

  return {
    /**
     * Account for one outgoing MAIN-role request and return what its wire
     * inputs should carry. Call once per logical request (not per retry).
     *
     * @param {string} sessionKey
     * @param {{messages?: unknown, mapToolName?: (name: string) => string}} [request]
     * @returns {CorrelationSnapshot}
     */
    begin(sessionKey, { messages, mapToolName } = {}) {
      const state = touch(sessionKey);

      for (const rawName of toolUseNames(messages)) {
        const name = typeof mapToolName === "function" ? mapToolName(rawName) : rawName;
        if (typeof name !== "string" || name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) continue;
        if (!PRINTABLE_ASCII.test(name) || state.usedTools.has(name)) continue;
        state.usedTools.set(name, name.startsWith(MCP_TOOL_PREFIX) ? { name, mcp: true } : { name });
      }

      const typed = lastTypedPromptText(messages);
      const fingerprint =
        typed === null
          ? null
          : `${Array.isArray(messages) ? messages.length : 0}:${typed.length}:${typed.slice(0, PROMPT_FINGERPRINT_TEXT_LIMIT)}`;
      const startsPrompt = state.promptId === null || (fingerprint !== null && fingerprint !== state.fingerprint);
      if (startsPrompt) {
        state.promptId = uuid();
        state.promptIndex += 1;
        state.turnIndex = 1;
        state.fingerprint = fingerprint;
      } else {
        state.turnIndex += 1;
      }

      return {
        promptId: /** @type {string} */ (state.promptId),
        promptIndex: state.promptIndex,
        turnIndex: state.turnIndex,
        previousRequestId: state.previousRequestId,
        previousMessageId: state.previousMessageId,
        toolsUsed: boundedToolsUsed([...state.usedTools.values()].map((tool) => ({ ...tool }))),
      };
    },

    /**
     * Record what the response of a successful main request reported. Values
     * outside the shapes the library accepts are ignored, so a malformed
     * header can never turn into a local `INVALID_INPUT` on the next request.
     *
     * @param {string} sessionKey
     * @param {{requestId?: string | null, messageId?: string | null}} ids
     */
    recordResponse(sessionKey, { requestId, messageId } = {}) {
      const state = sessions.get(sessionKey);
      if (!state) return;
      if (typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)) state.previousRequestId = requestId;
      if (typeof messageId === "string" && MESSAGE_ID_PATTERN.test(messageId)) state.previousMessageId = messageId;
    },

    /** @param {string} sessionKey */
    forget(sessionKey) {
      sessions.delete(sessionKey);
    },

    get size() {
      return sessions.size;
    },
  };
}
