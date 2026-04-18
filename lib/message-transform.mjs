/**
 * Stateless message-list transforms applied via
 * `experimental.chat.messages.transform` hook. The hook input is empty
 * (`{}` — no sessionID, no agent role), so these policies are global to
 * all sessions when enabled.
 *
 * The `messages` array passed to the hook is a `structuredClone` of the
 * session state, so mutation is safe and ONLY affects the outbound
 * request — storage is untouched.
 */

/** Tool names treated as read-class (content can be re-fetched). */
export const STALE_READ_TOOLS = new Set(["read", "view"]);

/** Tool names trivially re-runnable (idempotent + cheap). */
export const REPRODUCIBLE_TOOLS = new Set(["read", "grep", "glob", "ls", "list", "find"]);

/** Tools never pruned (provider-critical, e.g. skill catalog). */
const PRUNE_PROTECTED_TOOLS = new Set(["skill"]);

/** Replacement text for stale read outputs. */
const STALE_READ_PLACEHOLDER = "[File was read earlier in this session — re-read if you need the current contents]";

/** Rough char-to-token ratio — same heuristic opencode uses for estimates. */
function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Replace read/view tool outputs from messages older than `threshold`
 * messages-from-end with a placeholder note, and drop their attachments.
 *
 * Stateless. Does NOT mutate storage. Only affects the outbound request.
 *
 * @param {{messages: Array<{info: any, parts: any[]}>, threshold?: number, tools?: Set<string>}} args
 * @returns {{evicted: number}} — how many tool parts were rewritten
 */
export function staleReadEviction({ messages, threshold = 10, tools = STALE_READ_TOOLS }) {
  if (!Array.isArray(messages) || messages.length <= threshold) {
    return { evicted: 0 };
  }

  const cutoff = messages.length - threshold;
  let evicted = 0;

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (!msg?.parts) continue;

    for (const part of msg.parts) {
      if (part?.type !== "tool") continue;
      if (part.state?.status !== "completed") continue;
      if (part.state.time?.compacted) continue;
      if (!tools.has(part.tool)) continue;

      part.state.output = STALE_READ_PLACEHOLDER;
      if (part.state.attachments) {
        part.state.attachments = [];
      }
      evicted++;
    }
  }

  return { evicted };
}

/**
 * Prune older tool outputs by class, keeping the most recent N tokens
 * worth per class (reproducible vs stateful). Walks backward from the
 * end; once a class's running total exceeds its threshold, older outputs
 * of that class are replaced with empty strings.
 *
 * Stateless. Mirrors the core `compaction.prune()` logic but applies at
 * request-assembly time instead of persisting to storage.
 *
 * @param {{messages: Array<{info: any, parts: any[]}>, reproducibleThreshold?: number, statefulThreshold?: number, reproducibleTools?: Set<string>}} args
 * @returns {{pruned: number, tokensSaved: number}}
 */
export function perToolClassPrune({
  messages,
  reproducibleThreshold = 10_000,
  statefulThreshold = 40_000,
  reproducibleTools = REPRODUCIBLE_TOOLS,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { pruned: 0, tokensSaved: 0 };
  }

  let totalReproducible = 0;
  let totalStateful = 0;
  let pruned = 0;
  let tokensSaved = 0;

  // Walk backward through messages; within each message, also backward
  // through parts — matches the original prune() ordering.
  outer: for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg?.parts?.length) continue;

    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j];
      if (part?.type !== "tool") continue;
      if (part.state?.status !== "completed") continue;
      if (PRUNE_PROTECTED_TOOLS.has(part.tool)) continue;
      if (part.state.time?.compacted) break outer;

      const estimate = estimateTokens(part.state.output);
      const isReproducible = reproducibleTools.has(part.tool.toLowerCase());

      if (isReproducible) {
        totalReproducible += estimate;
        if (totalReproducible > reproducibleThreshold) {
          part.state.output = "";
          if (part.state.attachments) part.state.attachments = [];
          pruned++;
          tokensSaved += estimate;
        }
      } else {
        totalStateful += estimate;
        if (totalStateful > statefulThreshold) {
          part.state.output = "";
          if (part.state.attachments) part.state.attachments = [];
          pruned++;
          tokensSaved += estimate;
        }
      }
    }
  }

  return { pruned, tokensSaved };
}
