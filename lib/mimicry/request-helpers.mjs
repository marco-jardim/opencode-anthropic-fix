// ---------------------------------------------------------------------------
// Request-body mimicry helpers (W3·P3.1)
// ---------------------------------------------------------------------------
//
// Leaf helpers used by transformRequestBody, extracted from index.mjs so the
// orchestrator can become a thin importer. All are pure except resolveMaxTokens,
// which reads/writes the shared sessionMetrics.lastStopReason singleton.

import { sessionMetrics } from "../session-metrics.mjs";

/**
 * Ensure every assistant tool_use block has a matching tool_result in the next
 * user message; synthesize placeholders for interrupted/orphaned tool calls so
 * the API never rejects the conversation for unbalanced tool blocks.
 * @param {any[]} messages
 * @returns {any[]}
 */
export function repairOrphanedToolUseBlocks(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const repaired = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    repaired.push(msg);

    // Only check assistant messages with array content
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    // Collect tool_use IDs from this assistant message
    const toolUseIds = [];
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    // Check if the next message is a user message with matching tool_results
    const next = messages[i + 1];
    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Collect tool_result IDs present in the next user message
      const resultIds = new Set();
      for (const block of next.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          resultIds.add(block.tool_use_id);
        }
      }

      // Find which tool_use IDs are missing from the tool_results
      const missingIds = toolUseIds.filter((id) => !resultIds.has(id));
      if (missingIds.length === 0) continue; // All paired, nothing to fix

      // There are missing tool_results — inject them into the existing user message.
      // Clone the next message to avoid mutating the original.
      const patchedNext = {
        ...next,
        content: [
          ...missingIds.map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: "[Result unavailable — tool execution was interrupted]",
          })),
          ...next.content,
        ],
      };
      // Replace the next message in-place by skipping it and pushing the patched version
      i++; // skip original next
      repaired.push(patchedNext);
    } else {
      // Next message is missing or is not a user message — synthesize a full
      // tool_result user message for all tool_use IDs.
      repaired.push({
        role: "user",
        content: toolUseIds.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          content: "[Result unavailable — tool execution was interrupted]",
        })),
      });
    }
  }

  return repaired;
}

/**
 * Strip internal `/anthropic` slash-command messages and their `▣ Anthropic`
 * responses from the conversation before it is sent upstream.
 * @param {any[]} messages
 * @returns {any[]}
 */
export function stripSlashCommandMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // Pattern: /anthropic followed by optional subcommand
  const CMD_RE = /^\s*\/anthropic\b/i;
  // Pattern: ▣ Anthropic — prefix used by all sendCommandMessage outputs
  const RESP_RE = /^▣\s*Anthropic/;

  /**
   * Extract the first text content from a message's content field.
   * Handles both string content and array-of-blocks content.
   */
  function getFirstText(msg) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") return block.text;
      }
    }
    return "";
  }

  /**
   * Check if a user message is a /anthropic command.
   * A message is a command if its text content starts with /anthropic.
   */
  function isCommandMessage(msg) {
    if (msg.role !== "user") return false;
    const text = getFirstText(msg);
    return CMD_RE.test(text);
  }

  /**
   * Check if an assistant message is a sendCommandMessage response.
   * These always start with ▣ Anthropic.
   */
  function isCommandResponse(msg) {
    if (msg.role !== "assistant") return false;
    const text = getFirstText(msg);
    return RESP_RE.test(text);
  }

  const filtered = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Drop /anthropic command messages
    if (isCommandMessage(msg)) {
      // Also drop the immediately following assistant response if it's a command response
      if (i + 1 < messages.length && isCommandResponse(messages[i + 1])) {
        i++; // Skip the response too
      }
      continue;
    }

    // Drop orphaned command responses (in case the command message was already removed
    // or the ordering is different)
    if (isCommandResponse(msg)) {
      continue;
    }

    filtered.push(msg);
  }

  // Safety: if filtering removed ALL messages, return the original to avoid sending
  // an empty messages array to the API.
  if (filtered.length === 0) return messages;

  return filtered;
}

/**
 * Return the first user message's text (string or first text block), or "".
 * @param {any[]} messages
 * @returns {string}
 */
export function extractFirstUserMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") return block.text;
      }
    }
    return "";
  }
  return "";
}

/**
 * Build the request `metadata` field mimicking Claude Code's user_id envelope.
 * Honors OPENCODE_ANTHROPIC_SIGNATURE_USER_ID (raw override) and merges
 * CLAUDE_CODE_EXTRA_METADATA (JSON object) into the encoded user_id.
 * @param {{persistentUserId: string, accountId: string, sessionId: string}} input
 * @returns {{user_id: string}}
 */
export function buildRequestMetadata(input) {
  // Backward-compat override: raw user_id passed through without JSON-encoding.
  const envUserId = process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID?.trim();
  if (envUserId) return { user_id: envUserId };

  const extraMetadataEnv = process.env.CLAUDE_CODE_EXTRA_METADATA?.trim();
  let extraMetadata = {};
  if (extraMetadataEnv) {
    try {
      const parsed = JSON.parse(extraMetadataEnv);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extraMetadata = parsed;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    user_id: JSON.stringify({
      ...extraMetadata,
      device_id: input.persistentUserId,
      account_uuid: input.accountId,
      session_id: input.sessionId,
    }),
  };
}

/**
 * Resolve the outgoing max_tokens honoring the output_cap config and a
 * one-turn escalation when the previous stream stopped on max_tokens.
 * Reads/writes the shared sessionMetrics.lastStopReason singleton.
 * @param {{max_tokens?: number}} body
 * @param {any} config
 * @returns {number|undefined}
 */
export function resolveMaxTokens(body, config) {
  if (!config.output_cap?.enabled) return body.max_tokens; // passthrough
  if (body.max_tokens != null) return body.max_tokens; // caller-specified wins
  // QA note L-escalation: lastStopReason is set by extractUsageFromSSEEvent AFTER the stream
  // completes. The timing works correctly for "escalate for one turn" because this function runs
  // BEFORE the next request's stream starts. If the response pipeline changes to update stop
  // reason mid-stream or before response completion, this ordering assumption would break.
  const escalated = sessionMetrics.lastStopReason === "max_tokens";
  const result = escalated
    ? (config.output_cap.escalated_max_tokens ?? 64_000)
    : (config.output_cap.default_max_tokens ?? 8_000);
  // Reset after escalation is consumed (sticky for exactly one turn)
  if (escalated) {
    sessionMetrics.lastStopReason = null;
  }
  return result;
}
