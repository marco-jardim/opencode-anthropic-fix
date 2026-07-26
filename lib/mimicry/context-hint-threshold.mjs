/**
 * Claude Code 2.1.195 context-hint token accounting.
 *
 * The native bundle calls these values Pac, gao, Acp, aNn, and Ecp,
 * respectively. Its internal transcript checks `type === "assistant"`; the
 * plugin receives the equivalent wire shape as `role === "assistant"`.
 *
 * Genuine Claude Code also filters tool uses through `Hcp.has(block.name)`.
 * In Claude Code 2.1.195, `Hcp` contains Read, Bash, PowerShell, Grep, Glob,
 * WebSearch, WebFetch, Edit, and Write.
 *
 * @typedef {{ type?: string, id?: string, name?: string, tool_use_id?: string, content?: unknown, text?: unknown }} ContextBlock
 * @typedef {{ role?: string, content?: unknown }} ContextMessage
 */

export const KEPT_TOOL_RESULT_GROUPS = 5;
export const CONTEXT_HINT_TOKEN_THRESHOLD = 20_000;
export const MEDIA_BLOCK_TOKENS = 2_000;
export const CLEARED_MARKER = "[Old tool result content cleared]";
export const PERSISTED_PREFIX = "<persisted-output>";
export const CONTEXT_HINT_TOOL_NAMES = new Set([
  "Read",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
]);

/**
 * Genuine `If` estimator. This intentionally uses Math.round, unlike the
 * plugin's other token estimators.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function estimateTextTokens(value) {
  if (typeof value !== "string") return 0;
  return Math.round(value.length / 4);
}

/**
 * Genuine `Tcp` tool-result estimator.
 *
 * @param {ContextBlock} block
 * @returns {number}
 */
export function estimateToolResultTokens(block) {
  if (!block.content) return 0;
  if (typeof block.content === "string") return estimateTextTokens(block.content);
  if (!Array.isArray(block.content)) return 0;

  return block.content.reduce((sum, item) => {
    if (item?.type === "text") return sum + estimateTextTokens(item.text);
    if (item?.type === "image" || item?.type === "document") return sum + MEDIA_BLOCK_TOKENS;
    return sum;
  }, 0);
}

/**
 * Genuine `wcp` cleared-result check.
 *
 * @param {unknown} content
 * @returns {boolean}
 */
export function isAlreadyCleared(content) {
  return typeof content === "string" && (content === CLEARED_MARKER || content.startsWith(PERSISTED_PREFIX));
}

/**
 * Genuine `vcp` collection order, adapted from the internal transcript's
 * `type` discriminator to the wire message's `role` discriminator. Tool names
 * are matched case-sensitively against Claude Code 2.1.195's native `Hcp` set.
 *
 * @param {ContextMessage[]} messages
 * @returns {string[]}
 */
export function collectClearableToolUseIds(messages) {
  const ids = [];

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_use" && CONTEXT_HINT_TOOL_NAMES.has(block.name)) ids.push(block.id);
    }
  }

  return ids;
}

/**
 * Genuine `hao(messages, Pac)` saved-token calculation.
 *
 * @param {ContextMessage[]} messages
 * @returns {number}
 */
export function computeContextHintTokensSaved(messages) {
  const ids = collectClearableToolUseIds(messages);
  const keep = Math.max(1, KEPT_TOOL_RESULT_GROUPS);
  const keepSet = new Set(ids.slice(-keep));
  const clearSet = new Set(ids.filter((id) => !keepSet.has(id)));
  let tokensSaved = 0;

  if (clearSet.size > 0) {
    for (const message of messages) {
      if (message?.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type === "tool_result" && clearSet.has(block.tool_use_id) && !isAlreadyCleared(block.content)) {
          tokensSaved += estimateToolResultTokens(block);
        }
      }
    }
  }

  return tokensSaved;
}

/**
 * @param {ContextMessage[]} messages
 * @returns {boolean}
 */
export function shouldEmitContextHintBody(messages) {
  return computeContextHintTokensSaved(messages) >= CONTEXT_HINT_TOKEN_THRESHOLD;
}
