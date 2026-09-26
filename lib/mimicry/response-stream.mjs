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
 * Reverse-map tool names inside one SSE `data:` line's JSON payload.
 * Returns `fallback` unchanged if the payload is not valid JSON or no
 * `mcp_`-prefixed / CC-PascalCase tool name needed remapping. Shared by
 * {@link stripMcpPrefixFromSSE} (whole-text, regex-driven) and the
 * chunk-boundary-independent line processor in
 * {@link createTransformedSSEStream}, so both paths rewrite identically.
 *
 * @param {string} jsonStr - the JSON payload captured after `data:`
 * @param {string} fallback - text to return when nothing was rewritten
 * @returns {string}
 */
function rewriteSSEDataJson(jsonStr, fallback) {
  try {
    const parsed = JSON.parse(jsonStr);
    if (stripMcpPrefixFromParsedEvent(parsed)) {
      return `data: ${JSON.stringify(parsed)}`;
    }
  } catch {
    // Not valid JSON — pass through unchanged.
  }
  return fallback;
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
  return text.replace(/^data:\s*(.+)$/gm, (match, jsonStr) => rewriteSSEDataJson(jsonStr, match));
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
 * Split accumulated text into complete lines, terminated by LF, CR, or CRLF
 * (SSE line endings per the WHATWG spec), carrying any unresolved tail
 * forward instead of guessing at a boundary. A lone trailing CR is
 * ambiguous — it may be the first half of a CRLF pair whose LF arrives in
 * the next chunk — so it is held back until either the next chunk resolves
 * it or `flush` forces a decision at end-of-stream. This makes line/event
 * framing independent of how upstream bytes happen to be chunked (U6): the
 * same boundary is found whether a CRLF arrives whole or split across two
 * `pull()` calls.
 *
 * Line terminators are always consumed and never re-emitted; callers that
 * reconstruct output join lines with `"\n"`, which reserializes framing
 * (permitted by the mimicry contract) without altering any line's content.
 *
 * @param {string} carry - unresolved tail from the previous call
 * @param {string} chunk - newly decoded text to append
 * @param {boolean} flush - true at EOF: resolve a trailing partial line or lone CR
 * @returns {{lines: string[], rest: string}}
 */
function splitTerminatedLines(carry, chunk, flush) {
  const buf = carry + chunk;
  const lines = [];
  let start = 0;
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    if (c === "\n") {
      lines.push(buf.slice(start, i));
      start = i + 1;
      i += 1;
    } else if (c === "\r") {
      if (i + 1 < buf.length) {
        const consumed = buf[i + 1] === "\n" ? 2 : 1;
        lines.push(buf.slice(start, i));
        start = i + consumed;
        i += consumed;
      } else if (flush) {
        lines.push(buf.slice(start, i));
        start = i + 1;
        i += 1;
      } else {
        // Lone CR at the very end of the buffer: could still turn into a
        // CRLF pair once more bytes arrive. Stop and wait.
        break;
      }
    } else {
      i += 1;
    }
  }
  let rest = buf.slice(start);
  if (flush && rest.length > 0) {
    lines.push(rest);
    rest = "";
  }
  return { lines, rest };
}

/**
 * Create a response body stream that rewrites tool names, extracts usage, and
 * detects account-specific errors while preserving all other SSE bytes.
 *
 * UTF-8 contract (U5): decoding is strict (`fatal: true`) and the decoder is
 * flushed with no pending arguments at EOF. `{ stream: true }` already
 * buffers a multi-byte sequence split across chunk boundaries and completes
 * it normally once the rest arrives, so `fatal` changes nothing for a
 * well-formed stream regardless of chunking — it only turns a byte sequence
 * that is genuinely invalid (or still incomplete at the final flush) into an
 * explicit thrown error instead of a silent U+FFFD substitution. That
 * error is surfaced via `controller.error` (never a fabricated success, never
 * a replay, never an account-specific callback) so a real U+FFFD present in
 * valid input is never confused with decoder-inserted replacement text.
 *
 * SSE framing (U6): line and event-block boundaries are resolved by
 * {@link splitTerminatedLines} instead of a per-chunk regex, so a CR/LF pair
 * (or any line) split across chunk boundaries is parsed identically to one
 * delivered whole — tool-name rewriting and usage/account-error extraction
 * read from the very same lines, so they can never diverge.
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
  // Strict mode: see the UTF-8 contract note above the function doc.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const EMPTY_CHUNK = new Uint8Array();
  const MAX_SSE_CAPTURE_BYTES = 256 * 1024;
  let sseCaptureBuf = "";
  let sseCaptureTruncated = false;

  /** @type {UsageStats} */
  const stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /** Unresolved tail from splitTerminatedLines, carried across pull() calls. */
  let lineCarry = "";
  /**
   * Lines accumulated for the SSE event block currently being assembled
   * (terminated by a blank line). Only populated when a caller actually
   * wants usage/account-error extraction, matching the pre-existing
   * "skip parsing work when nobody asked" behavior.
   * @type {string[]}
   */
  let currentEventLines = [];
  let accountErrorHandled = false;

  /**
   * Rewrite one already-terminator-stripped line if it is an SSE `data:`
   * line; every other line (event/id/comment/blank) passes through as-is.
   * @param {string} line
   * @returns {string}
   */
  function rewriteLine(line) {
    const match = /^data:\s*(.+)$/.exec(line);
    if (!match) return line;
    return rewriteSSEDataJson(match[1], line);
  }

  /**
   * Finalize the currently buffered event block: join its lines back with
   * "\n" (matching {@link getSSEDataPayload}'s expected input), parse its
   * combined `data:` payload once, and feed that single parse to both usage
   * extraction and account-error detection so they never see different data
   * than each other for the same event.
   */
  function finalizeBlock() {
    if (currentEventLines.length === 0) return;
    const blockText = currentEventLines.join("\n");
    currentEventLines = [];

    const payload = getSSEDataPayload(blockText);
    if (!payload) return;

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
      // Ignore malformed event payloads (pre-existing policy).
    }
  }

  /**
   * Process one already-terminator-stripped line: rewrite it for output and,
   * if usage/account-error tracking is enabled, fold it into the event block
   * used for extraction.
   * @param {string} line
   * @returns {string}
   */
  function processLine(line) {
    const rewritten = rewriteLine(line);
    if (onUsage || onAccountError) {
      if (line === "") {
        finalizeBlock();
      } else {
        currentEventLines.push(line);
      }
    }
    return rewritten;
  }

  /**
   * Consume newly decoded text: split it into terminator-delimited lines
   * (carrying any unresolved tail via `lineCarry`), rewrite/extract from
   * each, and reassemble the output text.
   * @param {string} text
   * @param {boolean} flush
   * @returns {string}
   */
  function processText(text, flush) {
    const { lines, rest } = splitTerminatedLines(lineCarry, text, flush);
    lineCarry = rest;

    let out = "";
    for (const line of lines) {
      out += processLine(line) + "\n";
    }
    if (flush) {
      // EOF without a trailing blank line still ends whatever event was
      // in progress; process it rather than dropping it silently.
      finalizeBlock();
    }
    return out;
  }

  /**
   * Append newly decoded text to the bounded SSE debug capture buffer.
   * @param {string} text
   */
  function appendCapture(text) {
    const remaining = MAX_SSE_CAPTURE_BYTES - sseCaptureBuf.length;
    if (remaining <= 0) {
      sseCaptureTruncated = true;
      return;
    }
    sseCaptureBuf += text.length > remaining ? text.slice(0, remaining) : text;
    if (sseCaptureBuf.length >= MAX_SSE_CAPTURE_BYTES) sseCaptureTruncated = true;
  }

  /**
   * Surface a decode failure as an explicit stream error: cancel the
   * upstream reader, never emit a fabricated success/usage, and never
   * trigger an account-specific callback or a replay — a local decoder
   * error must not penalize an account.
   * @param {ReadableStreamDefaultController} controller
   * @param {unknown} err
   * @param {string} where
   */
  async function failOnDecodeError(controller, err, where) {
    try {
      await reader.cancel();
    } catch {
      // Reader may already be released; nothing to do.
    }
    const message = err instanceof Error ? err.message : String(err);
    controller.error(new Error(`invalid UTF-8 in response stream (${where}): ${message}`));
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
        let flushedText;
        try {
          // No args (stream:false): flush any incomplete trailing sequence.
          // A genuinely truncated/invalid tail throws here (see U5 contract
          // above) instead of vanishing silently.
          flushedText = decoder.decode();
        } catch (err) {
          await failOnDecodeError(controller, err, "end of stream");
          return;
        }

        if (captureEnabled && !sseCaptureTruncated && flushedText) {
          appendCapture(flushedText);
        }

        const rewrittenTail = processText(flushedText, true);
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

      let text;
      try {
        text = decoder.decode(value, { stream: true });
      } catch (err) {
        await failOnDecodeError(controller, err, "mid-stream");
        return;
      }

      if (captureEnabled && !sseCaptureTruncated && text) {
        appendCapture(text);
      }

      const rewrittenText = processText(text, false);
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
