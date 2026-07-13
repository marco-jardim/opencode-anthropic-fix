import { isAccountSpecificError, parseRateLimitReason } from "../backoff.mjs";

/**
 * @typedef {object} UsageStats
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} [webSearchRequests]
 * @property {string} [lastStopReason]
 */

/**
 * Update running usage stats from a parsed SSE event.
 * @param {any} parsed
 * @param {UsageStats} stats
 */
export function extractUsageFromSSEEvent(parsed, stats) {
  // message_delta: cumulative usage (preferred, overwrites)
  if (parsed?.type === "message_delta" && parsed.usage) {
    const u = parsed.usage;
    if (typeof u.input_tokens === "number") stats.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") stats.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") stats.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") stats.cacheWriteTokens = u.cache_creation_input_tokens;
    // Web search requests (server tool usage)
    if (typeof u.server_tool_use?.web_search_requests === "number") {
      stats.webSearchRequests = u.server_tool_use.web_search_requests;
    }
    // Capture stop_reason from message_delta for output cap escalation
    if (parsed.delta?.stop_reason) {
      stats.lastStopReason = parsed.delta.stop_reason;
    }
    return;
  }

  // message_start: initial usage (only set if we haven't seen message_delta yet)
  if (parsed?.type === "message_start" && parsed.message?.usage) {
    const u = parsed.message.usage;
    if (stats.inputTokens === 0 && typeof u.input_tokens === "number") {
      stats.inputTokens = u.input_tokens;
    }
    if (stats.cacheReadTokens === 0 && typeof u.cache_read_input_tokens === "number") {
      stats.cacheReadTokens = u.cache_read_input_tokens;
    }
    if (stats.cacheWriteTokens === 0 && typeof u.cache_creation_input_tokens === "number") {
      stats.cacheWriteTokens = u.cache_creation_input_tokens;
    }
  }
}

/**
 * Extract the combined SSE data payload from one event block.
 * @param {string} eventBlock
 * @returns {string | null}
 */
export function getSSEDataPayload(eventBlock) {
  if (!eventBlock) return null;

  const dataLines = [];
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("data:")) continue;
    // QA fix: SSE spec says strip only a single leading space after "data:", not all whitespace
    const raw = line.slice(5);
    dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
  }

  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

/**
 * Parse one SSE event payload and return account-error details if present.
 * @param {any} parsed
 * @returns {{reason: import('../backoff.mjs').RateLimitReason, invalidateToken: boolean} | null}
 */
export function getMidStreamAccountError(parsed) {
  if (!parsed || parsed.type !== "error" || !parsed.error) {
    return null;
  }

  const errorBody = {
    error: {
      type: String(parsed.error.type || ""),
      message: String(parsed.error.message || ""),
    },
  };

  // Mid-stream errors do not include a reliable HTTP status. Use 400-style
  // body parsing to identify account-specific errors.
  if (!isAccountSpecificError(400, errorBody)) {
    return null;
  }

  const reason = parseRateLimitReason(400, errorBody);

  return {
    reason,
    invalidateToken: reason === "AUTH_FAILED",
  };
}

/**
 * Strip `mcp_` prefix from tool_use `name` fields in SSE data lines.
 * Only modifies `name` values inside content blocks with `"type": "tool_use"`.
 * Non-JSON lines and text blocks are left untouched.
 *
 * @param {string} text - Raw SSE chunk text (may contain multiple lines)
 * @returns {string}
 */
export function stripMcpPrefixFromSSE(text) {
  return text.replace(/^data:\s*(.+)$/gm, (_match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (stripMcpPrefixFromParsedEvent(parsed)) {
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
      // Not valid JSON — pass through unchanged.
    }
    return _match;
  });
}

/**
 * Reverse map: CC PascalCase → opencode lowercase for response stream.
 * Built from the outgoing OC_TO_CC_TOOL_NAMES map (defined in transformRequestBody).
 * Must stay in sync with that map.
 */
export const CC_TO_OC_TOOL_NAMES = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Skill: "skill",
  Task: "task",
  Compress: "compress",
};

/**
 * Reverse-map a tool name from CC PascalCase back to opencode lowercase,
 * and strip `mcp_` prefix if present. Returns the original name if no mapping exists.
 * @param {string} name
 * @returns {string}
 */
export function reverseMapToolName(name) {
  if (CC_TO_OC_TOOL_NAMES[name]) return CC_TO_OC_TOOL_NAMES[name];
  if (name.startsWith("mcp_")) return name.slice(4);
  return name;
}

/**
 * Mutate a parsed SSE event object, reversing tool name renames (CC PascalCase
 * → opencode lowercase) and removing `mcp_` prefix from tool_use name fields.
 * Returns true if any modification was made.
 *
 * @param {any} parsed
 * @returns {boolean}
 */
export function stripMcpPrefixFromParsedEvent(parsed) {
  if (!parsed || typeof parsed !== "object") return false;

  let modified = false;

  // content_block_start: { content_block: { type: "tool_use"|"tool_reference", name: "..." } }
  if (
    parsed.content_block &&
    (parsed.content_block.type === "tool_use" || parsed.content_block.type === "tool_reference") &&
    typeof parsed.content_block.name === "string"
  ) {
    const mapped = reverseMapToolName(parsed.content_block.name);
    if (mapped !== parsed.content_block.name) {
      parsed.content_block.name = mapped;
      modified = true;
    }
  }

  // message_start: { message: { content: [{ type: "tool_use"|"tool_reference", name: "..." }] } }
  if (parsed.message && Array.isArray(parsed.message.content)) {
    for (const block of parsed.message.content) {
      if ((block.type === "tool_use" || block.type === "tool_reference") && typeof block.name === "string") {
        const mapped = reverseMapToolName(block.name);
        if (mapped !== block.name) {
          block.name = mapped;
          modified = true;
        }
      }
    }
  }

  // Top-level content array (non-streaming responses forwarded through SSE)
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if ((block.type === "tool_use" || block.type === "tool_reference") && typeof block.name === "string") {
        const mapped = reverseMapToolName(block.name);
        if (mapped !== block.name) {
          block.name = mapped;
          modified = true;
        }
      }
    }
  }

  return modified;
}

/**
 * Resolve the byte-stream idle timeout in milliseconds.
 *
 * Parity with Claude Code's `tengu_byte_stream_idle_timeout_ms`: a watchdog that
 * fires when the upstream SSE stream produces no bytes for N ms, so a stalled /
 * half-dead connection surfaces as a fast error instead of an indefinite hang.
 *
 * Resolution order: env `OPENCODE_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS` →
 * `config.streaming.idle_timeout_ms` → 0 (disabled). Disabled by default because
 * a too-aggressive value could abort a legitimate long generation; Anthropic SSE
 * emits periodic `ping` events, so a multi-minute silence is the safe signal.
 *
 * @param {any} cfg
 * @returns {number} timeout in ms, or 0 to disable
 */
export function resolveStreamIdleTimeoutMs(cfg) {
  const envRaw = process.env.OPENCODE_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS;
  if (envRaw != null && envRaw !== "") {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const c = cfg?.streaming?.idle_timeout_ms;
  if (typeof c === "number" && Number.isFinite(c) && c >= 0) return Math.floor(c);
  return 0;
}

/**
 * Create a response body stream that rewrites tool names, extracts usage, and
 * detects account-specific errors while preserving all other SSE bytes.
 *
 * @param {Response} response
 * @param {object} options
 * @param {((stats: UsageStats) => void) | null} [options.onUsage]
 * @param {((details: {reason: import('../backoff.mjs').RateLimitReason, invalidateToken: boolean}) => void) | null} [options.onAccountError]
 * @param {string} [options.correlationId]
 * @param {number} options.idleTimeoutMs
 * @param {boolean} options.captureEnabled
 * @param {(correlationId: string | undefined, body: string, truncated: boolean) => Promise<void>} options.writeSseCapture
 * @returns {ReadableStream}
 */
export function createTransformedSSEStream(
  response,
  { onUsage, onAccountError, correlationId, idleTimeoutMs, captureEnabled, writeSseCapture },
) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const EMPTY_CHUNK = new Uint8Array();
  const MAX_SSE_CAPTURE_BYTES = 256 * 1024;
  let sseCaptureBuf = "";
  let sseCaptureTruncated = false;

  /** @type {UsageStats} */
  const stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let sseBuffer = "";
  let sseRewriteBuffer = "";
  let accountErrorHandled = false;

  /**
   * Process buffered SSE event blocks.
   * @param {boolean} flush
   */
  function processSSEBuffer(flush = false) {
    while (true) {
      const boundary = sseBuffer.indexOf("\n\n");

      if (boundary === -1) {
        if (!flush) return;
        if (!sseBuffer.trim()) {
          sseBuffer = "";
          return;
        }
      }

      const eventBlock = boundary === -1 ? sseBuffer : sseBuffer.slice(0, boundary);
      sseBuffer = boundary === -1 ? "" : sseBuffer.slice(boundary + 2);

      const payload = getSSEDataPayload(eventBlock);
      if (!payload) {
        if (boundary === -1) return;
        continue;
      }

      try {
        const parsed = JSON.parse(payload);

        if (onUsage) {
          extractUsageFromSSEEvent(parsed, stats);
        }

        if (onAccountError && !accountErrorHandled) {
          const details = getMidStreamAccountError(parsed);
          if (details) {
            accountErrorHandled = true;
            onAccountError(details);
          }
        }
      } catch {
        // Ignore malformed event payloads.
      }

      if (boundary === -1) return;
    }
  }

  /**
   * Rewrite complete SSE lines while preserving chunk boundaries for streaming.
   * Buffers trailing partial lines to avoid parsing split JSON payloads.
   * @param {string} chunk
   * @param {boolean} [flush]
   * @returns {string}
   */
  function rewriteSSEChunk(chunk, flush = false) {
    sseRewriteBuffer += chunk;

    if (!flush) {
      const boundary = sseRewriteBuffer.lastIndexOf("\n");
      if (boundary === -1) return "";
      const complete = sseRewriteBuffer.slice(0, boundary + 1);
      sseRewriteBuffer = sseRewriteBuffer.slice(boundary + 1);
      return stripMcpPrefixFromSSE(complete);
    }

    if (!sseRewriteBuffer) return "";
    const finalText = stripMcpPrefixFromSSE(sseRewriteBuffer);
    sseRewriteBuffer = "";
    return finalText;
  }

  return new ReadableStream({
    async pull(controller) {
      let readResult;
      if (idleTimeoutMs > 0) {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let idleTimer;
        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise((_resolve, reject) => {
              idleTimer = setTimeout(
                () => reject(new Error(`stream idle timeout: no bytes for ${idleTimeoutMs}ms`)),
                idleTimeoutMs,
              );
            }),
          ]);
        } catch (err) {
          // Idle timeout (or read error): cancel the upstream reader and surface a
          // clear error so the consumer can retry instead of waiting on a dead
          // connection. Mirrors CC's stream-idle watchdog (no silent hang).
          try {
            await reader.cancel();
          } catch {
            // Reader may already be released; nothing to do.
          }
          controller.error(err instanceof Error ? err : new Error(String(err)));
          return;
        } finally {
          clearTimeout(idleTimer);
        }
      } else {
        readResult = await reader.read();
      }
      const { done, value } = readResult;
      if (done) {
        processSSEBuffer(true);

        const rewrittenTail = rewriteSSEChunk("", true);
        if (rewrittenTail) {
          controller.enqueue(encoder.encode(rewrittenTail));
        }

        if (
          onUsage &&
          (stats.inputTokens > 0 || stats.outputTokens > 0 || stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0)
        ) {
          onUsage(stats);
        }
        if (captureEnabled) {
          try {
            await writeSseCapture(correlationId, sseCaptureBuf, sseCaptureTruncated);
          } catch {
            // Never let a debug write break the stream.
          }
        }
        controller.close();
        return;
      }

      const text = decoder.decode(value, { stream: true });

      if (captureEnabled && !sseCaptureTruncated && text) {
        const remaining = MAX_SSE_CAPTURE_BYTES - sseCaptureBuf.length;
        if (remaining <= 0) {
          sseCaptureTruncated = true;
        } else {
          sseCaptureBuf += text.length > remaining ? text.slice(0, remaining) : text;
          if (sseCaptureBuf.length >= MAX_SSE_CAPTURE_BYTES) sseCaptureTruncated = true;
        }
      }

      if (onUsage || onAccountError) {
        // Normalize CRLF for parser only; preserve original bytes for passthrough.
        sseBuffer += text.replace(/\r\n/g, "\n");
        processSSEBuffer(false);
      }

      const rewrittenText = rewriteSSEChunk(text, false);
      if (rewrittenText) {
        controller.enqueue(encoder.encode(rewrittenText));
      } else {
        // Keep the pull/read loop progressing when this chunk only extends a
        // partial line buffered for later rewrite.
        controller.enqueue(EMPTY_CHUNK);
      }
    },
  });
}
