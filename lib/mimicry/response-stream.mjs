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
 * Mutable cross-call state for {@link splitTerminatedLines}. `pendingPieces`
 * holds the fragments of the line currently being assembled (oldest first);
 * they are joined into one string only when that line's terminator is
 * actually found, so a single very long line costs one join over its whole
 * length instead of a fresh copy on every chunk. `heldCR` records that the
 * line's content so far ends right at an unresolved trailing CR (the CR
 * itself is never stored in `pendingPieces` — it is not line content, it is
 * either about to merge into a CRLF terminator or about to stand alone as
 * one).
 * @typedef {{pendingPieces: string[], heldCR: boolean}} LineSplitState
 */

/**
 * @returns {LineSplitState}
 */
function createLineSplitState() {
  return { pendingPieces: [], heldCR: false };
}

/**
 * Split newly decoded text into complete lines, terminated by LF, CR, or
 * CRLF (SSE line endings per the WHATWG spec), carrying any unresolved tail
 * forward in `state` instead of guessing at a boundary. A lone trailing CR
 * is ambiguous — it may be the first half of a CRLF pair whose LF arrives in
 * the next chunk — so it is held back (`state.heldCR`) until either the next
 * chunk resolves it or `flush` forces a decision at end-of-stream. This
 * makes line/event framing independent of how upstream bytes happen to be
 * chunked (U6): the same boundary is found whether a CRLF arrives whole or
 * split across two `pull()` calls.
 *
 * Only `chunk` (plus, when `state.heldCR` is set, the single held-back CR)
 * is scanned on each call — never the full accumulated line — so cost is
 * O(chunk length) per call and O(total input length) overall, regardless of
 * how many chunks one line is split across (perf fix for the quadratic
 * blowup a per-call `carry + chunk` re-scan produced on very long single
 * lines split into many small chunks).
 *
 * Line terminators are always consumed and never re-emitted; callers that
 * reconstruct output join lines with `"\n"`, which reserializes framing
 * (permitted by the mimicry contract) without altering any line's content.
 *
 * @param {LineSplitState} state - cross-call state, mutated in place
 * @param {string} chunk - newly decoded text (may be empty, e.g. while the
 *   UTF-8 decoder is buffering an incomplete multi-byte sequence)
 * @param {boolean} flush - true at EOF: resolve a trailing partial line or lone CR
 * @returns {string[]} completed lines found in this call
 */
function splitTerminatedLines(state, chunk, flush) {
  const lines = [];
  const n = chunk.length;
  let bufStart = 0;
  let i = 0;

  if (state.heldCR) {
    if (n > 0) {
      state.heldCR = false;
      if (chunk[0] === "\n") {
        // CRLF completed by this chunk's leading LF: terminator consumes it.
        lines.push(state.pendingPieces.join(""));
        state.pendingPieces = [];
        bufStart = 1;
        i = 1;
      } else {
        // Followed by something other than LF: the held CR was a lone-CR
        // terminator on its own; this chunk starts the next line.
        lines.push(state.pendingPieces.join(""));
        state.pendingPieces = [];
      }
    } else if (flush) {
      // EOF with nothing left to disambiguate the held CR: it terminates.
      state.heldCR = false;
      lines.push(state.pendingPieces.join(""));
      state.pendingPieces = [];
    } else {
      // No new bytes yet (decoder still buffering) — keep waiting.
      return lines;
    }
  }

  while (i < n) {
    const c = chunk[i];
    if (c === "\n") {
      state.pendingPieces.push(chunk.slice(bufStart, i));
      lines.push(state.pendingPieces.join(""));
      state.pendingPieces = [];
      bufStart = i + 1;
      i += 1;
    } else if (c === "\r") {
      if (i + 1 < n) {
        const consumed = chunk[i + 1] === "\n" ? 2 : 1;
        state.pendingPieces.push(chunk.slice(bufStart, i));
        lines.push(state.pendingPieces.join(""));
        state.pendingPieces = [];
        bufStart = i + consumed;
        i += consumed;
      } else if (flush) {
        state.pendingPieces.push(chunk.slice(bufStart, i));
        lines.push(state.pendingPieces.join(""));
        state.pendingPieces = [];
        bufStart = i + 1;
        i += 1;
      } else {
        // Lone CR at the very end of this chunk: could still turn into a
        // CRLF pair once more bytes arrive. Hold it and wait.
        state.pendingPieces.push(chunk.slice(bufStart, i));
        state.heldCR = true;
        bufStart = i + 1;
        break;
      }
    } else {
      i += 1;
    }
  }

  if (bufStart < n) {
    state.pendingPieces.push(chunk.slice(bufStart, n));
  }

  if (flush && state.pendingPieces.length > 0) {
    lines.push(state.pendingPieces.join(""));
    state.pendingPieces = [];
  }

  return lines;
}

/**
 * Whether a response's body is an SSE event stream, per its Content-Type
 * header. Real Anthropic API streaming responses always send this header;
 * a non-SSE body (a JSON error payload, or a non-UTF-8 proxy/gateway HTML
 * error page) does not, and must not be held to the strict UTF-8 contract
 * below (L4 fix) — a decode failure there is a property of a broken
 * intermediary, not of the account, and must not be reported as one.
 * @param {Response} response
 * @returns {boolean}
 */
function isSSEContentType(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * Host-compatibility shim (L5): opencode 1.18.32 embeds `@ai-sdk/anthropic`
 * 3.0.111 (its own version constant, `UQ="3.0.111"`, sits inline in the
 * bundle). That SDK's stream converter (`doStream`'s `transform`, inside
 * `opencode.exe`) drives two *exhaustive* switch statements with no
 * catch-all: any `content_block_start.content_block.type` outside its case
 * list throws `` Unsupported content block type: ${R} ``, and any
 * `content_block_delta.delta.type` outside its case list throws
 * `` Unsupported delta type: ${Q} ``. Either throw kills the whole
 * ReadableStream reader, breaking the entire turn on a single unrecognized
 * block. `content_block.type === "fallback"` is the one literal the SDK
 * special-cases before that switch (`if(R==="fallback")return`) — it is
 * always safe and never registers per-index state.
 *
 * These sets are that switch's exact case list, extracted read-only by
 * scanning `opencode.exe` as text for the two throw sites and reading the
 * switch bodies around them (see the task/PR notes for the exact byte
 * offsets and quoted snippets) — not guessed from docs. A profile that asks
 * for `thinking.display:"updates"` (beta `thinking-display-updates-2026-08-18`,
 * the 2.1.280 profile) can make the real Anthropic API return newer
 * block/delta types (e.g. `connector_text`, `tool_addition`, `tool_removal`)
 * that this pinned SDK version has never heard of; the shim below keeps
 * those from ever reaching the SDK's switches.
 */
const SDK_KNOWN_BLOCK_TYPES = new Set([
  "fallback", // short-circuited before the inner switch; always safe, never registered
  "text",
  "thinking",
  "redacted_thinking",
  "compaction",
  "tool_use",
  "server_tool_use",
  "web_fetch_tool_result",
  "web_search_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "advisor_tool_result",
  "mcp_tool_use",
  "mcp_tool_result",
]);

/** @see SDK_KNOWN_BLOCK_TYPES — same extraction, `content_block_delta`'s switch. */
const SDK_KNOWN_DELTA_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "signature_delta",
  "compaction_delta",
  "input_json_delta",
  "citations_delta",
]);

/**
 * Cross-call state for {@link applyHostCompatShim}, scoped to one stream.
 * @typedef {object} HostCompatShimState
 * @property {Set<number>} fallbackIndexes - `content_block_start` indexes
 *   rewritten to `{type:"fallback"}`; their deltas must be dropped too.
 * @property {number} blockTypeFallbacks - count of block-start rewrites.
 * @property {number} deltasDropped - count of deltas dropped (fallback index
 *   or an unrecognized `delta.type`).
 */

/**
 * @returns {HostCompatShimState}
 */
function createHostCompatShimState() {
  return { fallbackIndexes: new Set(), blockTypeFallbacks: 0, deltasDropped: 0 };
}

/**
 * Apply the L5 host-compatibility shim to one already-JSON-parsed SSE event,
 * mutating `parsed` in place for a rewrite. Every other event type (ping,
 * message_start, message_delta, error, ...) is untouched — this only gates
 * the three event types the SDK's block/delta switches can throw on.
 *
 * `content_block_stop` is deliberately never rewritten or dropped: the SDK's
 * own stop handler is `if(u[index]!=null){...}` with an unconditional
 * `delete u[index]` after — an index that a fallback start never registered
 * just skips the `if` body and no-ops, so the stop event is always safe to
 * forward as-is (see the switch extraction above {@link SDK_KNOWN_BLOCK_TYPES}).
 *
 * @param {any} parsed
 * @param {HostCompatShimState} state
 * @returns {"keep" | "rewrite" | "drop"}
 */
function applyHostCompatShim(parsed, state) {
  if (!parsed || typeof parsed !== "object") return "keep";

  if (parsed.type === "content_block_start") {
    const blockType = parsed.content_block?.type;
    if (typeof blockType === "string" && !SDK_KNOWN_BLOCK_TYPES.has(blockType)) {
      state.fallbackIndexes.add(parsed.index);
      state.blockTypeFallbacks++;
      parsed.content_block = { type: "fallback" };
      return "rewrite";
    }
    return "keep";
  }

  if (parsed.type === "content_block_delta") {
    if (state.fallbackIndexes.has(parsed.index)) {
      state.deltasDropped++;
      return "drop";
    }
    const deltaType = parsed.delta?.type;
    if (typeof deltaType === "string" && !SDK_KNOWN_DELTA_TYPES.has(deltaType)) {
      state.deltasDropped++;
      return "drop";
    }
    return "keep";
  }

  if (parsed.type === "content_block_stop") {
    // Safe either way (see doc above) — just stop remembering the index.
    state.fallbackIndexes.delete(parsed.index);
    return "keep";
  }

  return "keep";
}

/**
 * Create a response body stream that rewrites tool names, extracts usage, and
 * detects account-specific errors while preserving all other SSE bytes.
 *
 * UTF-8 contract (U5): for an SSE response (`Content-Type: text/event-stream`,
 * per {@link isSSEContentType}) decoding is strict (`fatal: true`) and the
 * decoder is flushed with no pending arguments at EOF. `{ stream: true }`
 * already buffers a multi-byte sequence split across chunk boundaries and
 * completes it normally once the rest arrives, so `fatal` changes nothing for
 * a well-formed stream regardless of chunking — it only turns a byte sequence
 * that is genuinely invalid (or still incomplete at the final flush) into an
 * explicit thrown error instead of a silent U+FFFD substitution. That
 * error is surfaced via `controller.error` (never a fabricated success, never
 * a replay, never an account-specific callback) so a real U+FFFD present in
 * valid input is never confused with decoder-inserted replacement text.
 *
 * A non-SSE response (any other Content-Type — e.g. a 4xx/5xx JSON error
 * body, or an HTML error page from a proxy/gateway that isn't even UTF-8)
 * decodes leniently (`fatal: false`, the pre-U5 default): invalid bytes
 * become U+FFFD instead of throwing, so a non-UTF-8 error page surfaces as
 * its own (readable, if lossy) status/body instead of being hidden behind an
 * "invalid UTF-8 in response stream" error.
 *
 * SSE framing (U6): line and event-block boundaries are resolved by
 * {@link splitTerminatedLines} instead of a per-chunk regex, so a CR/LF pair
 * (or any line) split across chunk boundaries is parsed identically to one
 * delivered whole — tool-name rewriting and usage/account-error extraction
 * read from the very same lines, so they can never diverge.
 *
 * Host compatibility (L5): every event block is buffered and its `data:`
 * payload parsed once (not just when usage/account-error tracking is
 * requested — the shim below must run unconditionally), and that same parse
 * feeds {@link applyHostCompatShim}. A block whose fate is "drop" has *all*
 * of its lines (any `event:`, `id:`, comment, and `data:` lines) omitted
 * from the output — never just the `data:` line — so the host's SSE reader
 * never sees a named event with no matching data. Every other block is
 * re-serialized byte-identically except for the specific `data:` line a
 * rewrite touched.
 *
 * @param {Response} response
 * @param {object} options
 * @param {((stats: UsageStats) => void) | null} [options.onUsage]
 * @param {((details: {reason: import('../backoff.mjs').RateLimitReason, invalidateToken: boolean}) => void) | null} [options.onAccountError]
 * @param {((stats: {blockTypeFallbacks: number, deltasDropped: number}) => void) | null} [options.onHostCompatShim]
 *   Called once at stream end, only if the L5 shim actually rewrote or
 *   dropped at least one event — mirrors {@link options.onUsage}'s
 *   "only fire if something happened" shape.
 * @param {string} [options.correlationId]
 * @param {number} options.idleTimeoutMs
 * @param {boolean} options.captureEnabled
 * @param {(correlationId: string | undefined, body: string, truncated: boolean) => Promise<void>} options.writeSseCapture
 * @returns {ReadableStream}
 */
export function createTransformedSSEStream(
  response,
  { onUsage, onAccountError, onHostCompatShim, correlationId, idleTimeoutMs, captureEnabled, writeSseCapture },
) {
  const reader = response.body.getReader();
  // Strict only for SSE — see the UTF-8 contract note above the function doc.
  const decoder = new TextDecoder("utf-8", { fatal: isSSEContentType(response) });
  const encoder = new TextEncoder();
  const EMPTY_CHUNK = new Uint8Array();
  const MAX_SSE_CAPTURE_BYTES = 256 * 1024;
  let sseCaptureBuf = "";
  let sseCaptureTruncated = false;

  /** @type {UsageStats} */
  const stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /** Unresolved-line state for splitTerminatedLines, carried across pull() calls. */
  const lineSplitState = createLineSplitState();
  /** Cross-call state for the L5 host-compat shim, scoped to this one stream. */
  const hostCompatShimState = createHostCompatShimState();
  /**
   * Raw (pre-rewrite) lines of the SSE event block currently being assembled
   * (terminated by a blank line). Always populated: the L5 host-compat shim
   * must see a whole block — event/id lines included — to drop one safely,
   * not just when usage/account-error tracking is requested (that
   * conditional gate was fine when block-buffering was only a usage/
   * account-error optimization; L5 needs it unconditionally for correctness).
   * @type {string[]}
   */
  let currentBlockLines = [];
  let accountErrorHandled = false;

  /**
   * Finalize the currently buffered event block and return the lines that
   * should reach the output (in order, no trailing newline — the caller
   * joins with "\n" and appends the block-terminating blank line itself).
   * Parses the block's combined `data:` payload once and feeds that single
   * parse to usage extraction, account-error detection, mcp_ tool-name
   * rewriting, and the L5 host-compat shim, so none of them can see
   * different data than each other for the same event.
   * @returns {string[]}
   */
  function finalizeBlock() {
    const lines = currentBlockLines;
    currentBlockLines = [];
    if (lines.length === 0) return lines;

    const blockText = lines.join("\n");
    const payload = getSSEDataPayload(blockText);
    if (!payload) return lines;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Ignore malformed event payloads (pre-existing policy).
      return lines;
    }

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

    const shimAction = applyHostCompatShim(parsed, hostCompatShimState);
    if (shimAction === "drop") return [];

    const mcpModified = stripMcpPrefixFromParsedEvent(parsed);
    if (shimAction === "rewrite" || mcpModified) {
      // Re-serialize only the `data:` line(s) this event actually changed;
      // every other line in the block (event:, id:, comments) is untouched.
      // A payload combined from more than one `data:` line (spec-legal,
      // never observed from Anthropic) collapses to a single rewritten line.
      let replaced = false;
      return lines
        .map((line) => {
          if (!/^data:\s*(.+)$/.test(line)) return line;
          if (replaced) return null;
          replaced = true;
          return `data: ${JSON.stringify(parsed)}`;
        })
        .filter((line) => line !== null);
    }
    return lines;
  }

  /**
   * Consume newly decoded text: split it into terminator-delimited lines
   * (carrying any unresolved tail via `lineSplitState`), buffer each into
   * the in-progress block, and finalize (parse + shim + emit) that block
   * whenever a blank line closes it or `flush` forces a decision at EOF.
   * @param {string} text
   * @param {boolean} flush
   * @returns {string}
   */
  function processText(text, flush) {
    const lines = splitTerminatedLines(lineSplitState, text, flush);

    let out = "";
    for (const line of lines) {
      if (line === "") {
        for (const emitted of finalizeBlock()) out += emitted + "\n";
        out += "\n"; // the blank-line terminator itself, always preserved
      } else {
        currentBlockLines.push(line);
      }
    }
    if (flush) {
      // EOF without a trailing blank line still ends whatever event was
      // in progress; emit it rather than dropping it silently.
      for (const emitted of finalizeBlock()) out += emitted + "\n";
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
        if (onHostCompatShim && (hostCompatShimState.blockTypeFallbacks > 0 || hostCompatShimState.deltasDropped > 0)) {
          onHostCompatShim({
            blockTypeFallbacks: hostCompatShimState.blockTypeFallbacks,
            deltasDropped: hostCompatShimState.deltasDropped,
          });
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
