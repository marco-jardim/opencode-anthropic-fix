import { perToolClassPrune, staleReadEviction } from "../message-transform.mjs";

/**
 * Reuse the existing pruning policies through a lossless view of v2 results.
 * Only a result that a policy changes is replaced; IDs, tool inputs, provider
 * metadata and all unmodified result objects retain their original shape.
 * @param {Array<import('@opencode/ai').Message>} messages
 * @param {object} strategies
 */
export function applyV2MessagePolicies(messages, strategies = {}) {
  if (!strategies.stale_read_eviction && !strategies.per_tool_class_prune) return;
  const bindings = [];
  const view = messages.map((message) => ({
    parts: message.content.flatMap((block) => {
      if (block.type !== "tool-result" || block.result.type === "error") return [];
      const result = block.result;
      const output =
        result.type === "content"
          ? result.value
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : typeof result.value === "string"
            ? result.value
            : JSON.stringify(result.value);
      const part = { type: "tool", tool: block.name, state: { status: "completed", output } };
      bindings.push({ block, part, output });
      return [part];
    }),
  }));
  if (strategies.stale_read_eviction) staleReadEviction({ messages: view });
  if (strategies.per_tool_class_prune) perToolClassPrune({ messages: view });
  for (const { block, part, output } of bindings) {
    if (part.state.output !== output) block.result = { type: "text", value: part.state.output };
  }
}

/** Fail explicitly rather than sending opaque native checkpoints to an AI SDK. */
export function assertPortableV2History(messages) {
  if (messages.some((message) => message.content.some((part) => part.type === "compaction"))) {
    throw new Error(
      "This session contains native provider compaction state. Start a new session to use the Anthropic OAuth compatibility transport.",
    );
  }
}
