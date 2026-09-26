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
 * intermediary, not of the account, and must not be reported as one. As of
 * F5, a non-SSE body is not decoded at all: it bypasses this module's whole
 * decode/line/re-encode pipeline via {@link createPassthroughStream}.
 * @param {Response} response
 * @returns {boolean}
 */
function isSSEContentType(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * The exact opencode 1.18.32 host-SDK version the L5 allowlists
 * ({@link SDK_KNOWN_BLOCK_TYPES}, {@link SDK_KNOWN_DELTA_TYPES},
 * {@link SDK_KNOWN_TOP_LEVEL_EVENT_TYPES}, {@link SDK_KNOWN_CITATION_TYPES})
 * were extracted against. Re-extract all four allowlists — and move this
 * constant to match — the next time opencode bumps its pinned
 * `@ai-sdk/anthropic` version; {@link shouldApplyHostCompatShim}'s threshold
 * is only correct for the version this describes.
 */
const HOST_SDK_BASELINE_VERSION = Object.freeze([3, 0, 111]);

/**
 * Matches the `ai-sdk/anthropic/<semver>` token the Vercel AI SDK sends in
 * its own outgoing `User-Agent` header (and which opencode 1.18.32 sends
 * unchanged, since it embeds that SDK unmodified — see the version-constant
 * note in the doc above {@link SDK_KNOWN_BLOCK_TYPES}).
 *
 * QA fix L1: the negative lookbehind requires the match to start at the
 * beginning of the string or right after a non-identifier character, so a
 * *different* package whose name merely ends in `ai-sdk` — e.g.
 * `xai-sdk/anthropic/9.0.0` — never matches `ai-sdk/anthropic/...` as a
 * substring. Any of start-of-string, a space, `(`, `;`, or `,` (the
 * separators real `User-Agent` strings use between tokens) satisfies it.
 */
const HOST_SDK_USER_AGENT_RE = /(?<![A-Za-z0-9_-])ai-sdk\/anthropic\/(\d+)\.(\d+)\.(\d+)/;

/**
 * Whether the L5 host-compatibility shim (F3/F4) should run for a request
 * whose *incoming* `User-Agent` header has this value.
 *
 * The shim's allowlists describe exactly opencode 1.18.32's pinned
 * `@ai-sdk/anthropic@3.0.111` — see the doc above {@link SDK_KNOWN_BLOCK_TYPES}
 * for how they were extracted, byte-offset and all. Conservative default:
 * apply the shim whenever the host SDK's version token is absent or
 * unparseable, or when the parsed version is `<= 3.0.111` — only a
 * *strictly newer* `ai-sdk/anthropic` version disables it, on the
 * assumption a newer SDK ships its own fix for the zod schema / switch
 * statements this shim works around. When opencode bumps its pinned SDK
 * version, re-extract every allowlist above and move
 * {@link HOST_SDK_BASELINE_VERSION} to match — this function's threshold
 * must move with it, or it will silently stop protecting (or start
 * needlessly gating) the new version.
 *
 * @param {string | null | undefined} userAgent - the incoming request's
 *   `User-Agent` header value (not the outgoing header this plugin sends to
 *   Anthropic — the host's own, as received by this plugin).
 * @returns {boolean}
 */
export function shouldApplyHostCompatShim(userAgent) {
  if (typeof userAgent !== "string") return true;
  const match = userAgent.match(HOST_SDK_USER_AGENT_RE);
  if (!match) return true;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (version[i] !== HOST_SDK_BASELINE_VERSION[i]) {
      return version[i] < HOST_SDK_BASELINE_VERSION[i];
    }
  }
  return true; // exactly equal to the baseline
}

/**
 * Host-compatibility shim (L5): opencode 1.18.32 embeds `@ai-sdk/anthropic`
 * 3.0.111 (its own version constant, `UQ="3.0.111"`, sits inline in the
 * bundle, and that exact string is what the SDK sends as the
 * `ai-sdk/anthropic/3.0.111` token in its own outgoing `User-Agent` header —
 * see {@link shouldApplyHostCompatShim}).
 *
 * Every SSE event that SDK receives is first validated by a zod
 * `discriminatedUnion("type", [...])` (bound to the bundle constant `WL`,
 * consumed via `successfulResponseHandler:aG(WL)` in `doStream`), producing
 * `{success:true, value}` on a matching event or `{success:false, error}`
 * otherwise. A validation failure does **not** throw — `doStream`'s
 * `transform` re-enqueues it as an SDK-level `{type:"error", error}` stream
 * part (`if(!H.success){K.enqueue({type:"error",error:H.error});return}`) —
 * but the outcome for the turn is the same either way: a stream part the
 * host doesn't otherwise expect. Separately, once `H.success` is true (so
 * `z = H.value` already passed that schema), the same `transform` also runs
 * two *exhaustive* switch statements with no catch-all — any
 * `content_block_start.content_block.type` outside its case list throws
 * `` Unsupported content block type: ${R} ``, and any
 * `content_block_delta.delta.type` outside its case list throws
 * `` Unsupported delta type: ${Q} ``, either of which kills the whole
 * ReadableStream reader. In practice the zod schema's own discriminatedUnions
 * for `content_block.type` and `delta.type` list the exact same literals as
 * these switches, so an unrecognized value is normally rejected at the zod
 * step first and the throw is a dead-code fallback — but whichever mechanism
 * fires, a single unrecognized block/delta (or top-level event, or
 * `citations_delta` citation type — see {@link SDK_KNOWN_TOP_LEVEL_EVENT_TYPES}
 * and {@link SDK_KNOWN_CITATION_TYPES}) still breaks the entire turn, which is
 * what this shim prevents. `content_block.type === "fallback"` is the one
 * literal the SDK special-cases before that switch (`if(R==="fallback")
 * return`) — it is always safe and never registers per-index state.
 *
 * These sets are that switch's (and the matching zod discriminatedUnion's —
 * both list the exact same literals) exact case list, extracted read-only by
 * scanning `opencode.exe` as text for the two throw sites and the `WL`
 * schema definition, and reading the switch/union bodies around them (see
 * the task/PR notes for the exact byte offsets and quoted snippets) — not
 * guessed from docs. A profile that asks for `thinking.display:"updates"`
 * (beta `thinking-display-updates-2026-08-18`, the 2.1.280 profile) can make
 * the real Anthropic API return newer block/delta types (e.g.
 * `connector_text`, `tool_addition`, `tool_removal`) that this pinned SDK
 * version has never heard of; the shim below keeps those from ever reaching
 * the SDK's zod schema / switches.
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

/**
 * @see SDK_KNOWN_BLOCK_TYPES — same extraction, `content_block_delta`'s
 * switch/union. `citations_delta`'s own `citation` field is a further
 * nested discriminatedUnion of exactly 3 literals — see
 * {@link SDK_KNOWN_CITATION_TYPES}.
 */
const SDK_KNOWN_DELTA_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "signature_delta",
  "compaction_delta",
  "input_json_delta",
  "citations_delta",
]);

/**
 * SDK-known top-level SSE event types (L5, F4d). The outer zod
 * `discriminatedUnion("type", [...])` bound to `WL` in the bundle accepts
 * exactly these 8 literals — quoted from the bundle (whitespace/aliasing
 * elided): `WL=E(()=>j(G.discriminatedUnion("type",[G.object({type:
 * G.literal("message_start"),message:{...}}), ...,
 * G.object({type:G.literal("content_block_stop"),index:G.number()}),
 * G.object({type:G.literal("error"),error:G.object({type:G.string(),
 * message:G.string()})}), G.object({type:G.literal("message_delta"),
 * delta:{...},usage:{...}}), G.object({type:G.literal("message_stop")}),
 * G.object({type:G.literal("ping")})])))`. Any other top-level event `type`
 * fails that union (see the doc above {@link SDK_KNOWN_BLOCK_TYPES}) and
 * must be dropped whole — `event:`/`id:`/comment/`data:` lines all
 * together — before it ever reaches the SDK.
 */
const SDK_KNOWN_TOP_LEVEL_EVENT_TYPES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "error",
  "message_delta",
  "message_stop",
  "ping",
]);

/**
 * SDK-known `citations_delta.citation.type` literals (L5, F4d). Nested one
 * level further inside `content_block_delta.delta`'s discriminatedUnion,
 * `citations_delta`'s `citation` field is itself a
 * `discriminatedUnion("type", [...])` of exactly these 3 literals — quoted
 * from the bundle: `G.object({type:G.literal("citations_delta"),citation:
 * G.discriminatedUnion("type",[G.object({type:
 * G.literal("web_search_result_location"),cited_text:G.string(),url:
 * G.string(),title:G.string(),encrypted_index:G.string()}),
 * G.object({type:G.literal("page_location"),cited_text:G.string(),
 * document_index:G.number(),document_title:G.string().nullable(),
 * start_page_number:G.number(),end_page_number:G.number()}),
 * G.object({type:G.literal("char_location"),cited_text:G.string(),
 * document_index:G.number(),document_title:G.string().nullable(),
 * start_char_index:G.number(),end_char_index:G.number()})])})`. A
 * `citations_delta` carrying any other citation type fails that union just
 * like an unrecognized top-level event or block/delta type, and is dropped
 * the same way an unrecognized `delta.type` is — as a dropped delta, since
 * the enclosing `content_block_delta` event is the unit of failure here.
 */
const SDK_KNOWN_CITATION_TYPES = new Set(["web_search_result_location", "page_location", "char_location"]);

/**
 * Cross-call state for {@link applyHostCompatShim}, scoped to one stream.
 * @typedef {object} HostCompatShimState
 * @property {Set<number>} fallbackIndexes - `content_block_start` indexes
 *   rewritten to `{type:"fallback"}`; their deltas must be dropped too.
 * @property {number} blockTypeFallbacks - count of block-start rewrites.
 * @property {number} deltasDropped - count of deltas dropped (fallback index,
 *   an unrecognized `delta.type`, or an unrecognized `citations_delta`
 *   citation type).
 * @property {number} eventsDropped - count of whole SSE events dropped for
 *   an unrecognized top-level `type` (F4d).
 */

/**
 * @returns {HostCompatShimState}
 */
function createHostCompatShimState() {
  return { fallbackIndexes: new Set(), blockTypeFallbacks: 0, deltasDropped: 0, eventsDropped: 0 };
}

/**
 * Apply the L5 host-compatibility shim to one already-JSON-parsed SSE event,
 * mutating `parsed` in place for a rewrite. An unrecognized top-level `type`
 * (F4d, {@link SDK_KNOWN_TOP_LEVEL_EVENT_TYPES}) is dropped whole before any
 * type-specific check below runs. Every other recognized event type other
 * than content_block_start/delta/stop (ping, message_start, message_delta,
 * error, message_stop) is otherwise untouched — this only gates the event
 * types the SDK's zod schema and block/delta switches can reject or throw
 * on.
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

  if (typeof parsed.type === "string" && !SDK_KNOWN_TOP_LEVEL_EVENT_TYPES.has(parsed.type)) {
    state.eventsDropped++;
    return "drop";
  }

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
    if (deltaType === "citations_delta") {
      const citationType = parsed.delta?.citation?.type;
      if (typeof citationType === "string" && !SDK_KNOWN_CITATION_TYPES.has(citationType)) {
        state.deltasDropped++;
        return "drop";
      }
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
 * Read the next chunk from `reader`, applying an idle-timeout watchdog when
 * `idleTimeoutMs > 0` (parity with Claude Code's stream-idle watchdog: no
 * silent hang on a stalled/half-dead connection). Shared by the SSE pipeline
 * below and by {@link createPassthroughStream} (F5) so both honor the exact
 * same watchdog contract. On timeout (or any other read error under the
 * race), the caller is responsible for canceling `reader` and surfacing the
 * rejection via `controller.error` — this helper only resolves or rejects.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} idleTimeoutMs
 * @returns {Promise<ReadableStreamReadResult<Uint8Array>>}
 */
async function readWithIdleTimeout(reader, idleTimeoutMs) {
  if (idleTimeoutMs <= 0) return reader.read();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => {
        idleTimer = setTimeout(
          () => reject(new Error(`stream idle timeout: no bytes for ${idleTimeoutMs}ms`)),
          idleTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * F5: byte-for-byte pass-through for a non-SSE response body. Each chunk
 * read from `reader` is enqueued exactly as received — no decode, no
 * re-encode, no line reframing, and no synthesized trailing newline — so
 * concatenating the enqueued chunks reproduces the original bytes exactly.
 * This intentionally skips everything the SSE pipeline does: usage
 * extraction, account-error detection, mcp_ tool-name rewriting, the L5
 * host-compat shim, and the SSE debug capture side-channel are all
 * SSE-specific and never apply to a non-SSE body. Only the idle-timeout
 * watchdog is still honored.
 *
 * QA fix L3: this stream's bytes are whatever `reader` hands back, which for
 * a fetch()/undici response is *already decoded* (e.g. gzip has been
 * transparently inflated) — so a `Content-Length`/`Content-Encoding` copied
 * from the original upstream response would describe the original
 * (possibly compressed) wire bytes, not what this stream actually emits.
 * The caller (`transformResponse` in index.mjs) strips both headers rather
 * than forward a value that no longer matches the body.
 *
 * QA fix L4: `cancel` propagates the consumer's cancellation to `reader` so
 * the upstream connection is torn down instead of left dangling when the
 * consumer walks away early.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} idleTimeoutMs
 * @returns {ReadableStream}
 */
function createPassthroughStream(reader, idleTimeoutMs) {
  return new ReadableStream({
    async pull(controller) {
      let readResult;
      try {
        readResult = await readWithIdleTimeout(reader, idleTimeoutMs);
      } catch (err) {
        // Idle timeout (or read error): cancel the upstream reader and surface a
        // clear error so the consumer can retry instead of waiting on a dead
        // connection. Mirrors the SSE pipeline's own watchdog handling below.
        try {
          await reader.cancel();
        } catch {
          // Reader may already be released; nothing to do.
        }
        controller.error(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const { done, value } = readResult;
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      // L4: propagate the consumer's cancellation to the upstream reader.
      return reader.cancel(reason);
    },
  });
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
 * skips this whole pipeline (F5): see {@link createPassthroughStream}. It is
 * never decoded or re-encoded at all, so it cannot be held to any UTF-8
 * contract, strict or lenient. (QA fix L3: the caller no longer forwards the
 * original Content-Length/Content-Encoding for either path — see
 * {@link createPassthroughStream}'s own doc.)
 *
 * SSE framing (U6): line and event-block boundaries are resolved by
 * {@link splitTerminatedLines} instead of a per-chunk regex, so a CR/LF pair
 * (or any line) split across chunk boundaries is parsed identically to one
 * delivered whole — tool-name rewriting and usage/account-error extraction
 * read from the very same lines, so they can never diverge.
 *
 * Host compatibility (L5): every event block is buffered and its `data:`
 * payload parsed once (not just when usage/account-error tracking is
 * requested — parsing itself must happen unconditionally, since usage and
 * account-error extraction need it too), and that same parse feeds
 * {@link applyHostCompatShim} whenever `options.hostCompatShim` is not
 * `false` (see that option's own doc below). A block whose fate is "drop"
 * has *all* of its lines (any `event:`, `id:`, comment, and `data:` lines)
 * omitted from the output — never just the `data:` line — so the host's SSE
 * reader never sees a named event with no matching data. Every other block
 * is re-serialized byte-identically except for the specific `data:` line a
 * rewrite touched.
 *
 * @param {Response} response
 * @param {object} options
 * @param {((stats: UsageStats) => void) | null} [options.onUsage]
 * @param {((details: {reason: import('../backoff.mjs').RateLimitReason, invalidateToken: boolean}) => void) | null} [options.onAccountError]
 * @param {((stats: {blockTypeFallbacks: number, deltasDropped: number, eventsDropped: number, dryRun?: boolean}) => void) | null} [options.onHostCompatShim]
 *   Called once at stream end, only if the L5 shim actually rewrote or
 *   dropped at least one event — mirrors {@link options.onUsage}'s
 *   "only fire if something happened" shape. When `hostCompatShim` is
 *   `false`, the shim itself never touches the real event or output, but
 *   (QA fix L1) it still runs as a DRY RUN against a copy of each parsed
 *   event, purely to report what it *would* have rewritten or dropped; if
 *   that dry run finds anything, this fires once with `dryRun: true` set
 *   (omitted/falsy on a normal, live-shim call) so callers such as
 *   index.mjs's debugLog can surface "a newer host SDK is receiving types
 *   the pinned allowlist doesn't know" instead of staying silent. Never
 *   called for a non-SSE body.
 * @param {boolean} [options.hostCompatShim] - F3/F4: enable/disable the L5
 *   host-compat shim ({@link applyHostCompatShim}) for this stream. Defaults
 *   to `true`. Callers resolve this once per request from the *incoming*
 *   request's `User-Agent` via {@link shouldApplyHostCompatShim} — this
 *   function itself never inspects any header, it only obeys the resolved
 *   flag. `false` means no shim *rewriting*: unknown block/delta/event types
 *   and unknown citation types all pass through byte-identical — but see
 *   `onHostCompatShim` above for the dry-run report this still produces
 *   (QA fix L1).
 * @param {string} [options.correlationId]
 * @param {number} options.idleTimeoutMs
 * @param {boolean} options.captureEnabled
 * @param {(correlationId: string | undefined, body: string, truncated: boolean) => Promise<void>} options.writeSseCapture
 * @returns {ReadableStream}
 */
export function createTransformedSSEStream(
  response,
  {
    onUsage,
    onAccountError,
    onHostCompatShim,
    hostCompatShim = true,
    correlationId,
    idleTimeoutMs,
    captureEnabled,
    writeSseCapture,
  },
) {
  const reader = response.body.getReader();

  // F5: a non-SSE body (any Content-Type other than text/event-stream) is
  // never framed as SSE — pass it through exactly as read instead of forcing
  // it through the decode/line/re-encode pipeline below (see the UTF-8
  // contract note above and createPassthroughStream's own doc).
  if (!isSSEContentType(response)) {
    return createPassthroughStream(reader, idleTimeoutMs);
  }

  // Strict only for SSE — see the UTF-8 contract note above the function doc.
  const decoder = new TextDecoder("utf-8", { fatal: true });
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
   * QA fix L1: cross-call state for a DRY RUN of the L5 shim, used only when
   * `hostCompatShim` is `false` (a newer host SDK the allowlists above have
   * not been re-extracted for). Tracked separately from `hostCompatShimState`
   * because it is fed by a throwaway copy of each parsed event, never the
   * real one — the dry run must never influence the real block/delta fate.
   */
  const dryRunHostCompatShimState = createHostCompatShimState();
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

    let shimAction = "keep";
    if (hostCompatShim) {
      shimAction = applyHostCompatShim(parsed, hostCompatShimState);
    } else if (onHostCompatShim) {
      // QA fix L1: the shim is gated off for this (newer) host SDK, but run
      // it anyway as a DRY RUN against a throwaway copy so a caller that
      // wants to know can find out what it *would* have flagged. `parsed`
      // itself, and therefore the real output, is never touched by this.
      applyHostCompatShim(structuredClone(parsed), dryRunHostCompatShimState);
    }
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
      try {
        readResult = await readWithIdleTimeout(reader, idleTimeoutMs);
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
        if (
          onHostCompatShim &&
          (hostCompatShimState.blockTypeFallbacks > 0 ||
            hostCompatShimState.deltasDropped > 0 ||
            hostCompatShimState.eventsDropped > 0)
        ) {
          onHostCompatShim({
            blockTypeFallbacks: hostCompatShimState.blockTypeFallbacks,
            deltasDropped: hostCompatShimState.deltasDropped,
            eventsDropped: hostCompatShimState.eventsDropped,
          });
        } else if (
          // QA fix L1: the shim was gated off (a newer host SDK), but the dry
          // run above still found something it would have flagged — report
          // it with dryRun:true rather than staying silent.
          onHostCompatShim &&
          !hostCompatShim &&
          (dryRunHostCompatShimState.blockTypeFallbacks > 0 ||
            dryRunHostCompatShimState.deltasDropped > 0 ||
            dryRunHostCompatShimState.eventsDropped > 0)
        ) {
          onHostCompatShim({
            blockTypeFallbacks: dryRunHostCompatShimState.blockTypeFallbacks,
            deltasDropped: dryRunHostCompatShimState.deltasDropped,
            eventsDropped: dryRunHostCompatShimState.eventsDropped,
            dryRun: true,
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
    cancel(reason) {
      // L4: propagate the consumer's cancellation to the upstream reader.
      return reader.cancel(reason);
    },
  });
}
