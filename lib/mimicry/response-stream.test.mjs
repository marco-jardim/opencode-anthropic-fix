import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTransformedSSEStream,
  extractUsageFromSSEEvent,
  getMidStreamAccountError,
  getSSEDataPayload,
  resolveStreamIdleTimeoutMs,
  shouldApplyHostCompatShim,
  stripMcpPrefixFromParsedEvent,
} from "./response-stream.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for the U5/U6 (UTF-8 flush + SSE framing) regression tests.
// All corpus strings below are built from \u escapes so the source file
// itself stays ASCII-only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a fixed sequence of byte chunks as a Response whose body is a
 * ReadableStream that enqueues exactly those chunks, in order, then closes.
 * Zero-length chunks are dropped (they collapse a split back to a no-op).
 * Sets `Content-Type: text/event-stream` by default, matching every real
 * Anthropic streaming response — createTransformedSSEStream (L4) now keys
 * its strict-vs-lenient UTF-8 decoding on this header, so tests exercising
 * the SSE/strict path must carry it just like production traffic does.
 * @param {Uint8Array[]} chunks
 * @param {{contentType?: string | null}} [options] - pass `contentType: null`
 *   to build a response with no Content-Type header (the non-SSE/lenient case).
 * @returns {Response}
 */
function makeChunkedResponse(chunks, { contentType = "text/event-stream" } = {}) {
  const headers = contentType == null ? undefined : { "content-type": contentType };
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          if (chunk.length > 0) controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    headers ? { headers } : undefined,
  );
}

/**
 * Run createTransformedSSEStream over a fixed sequence of byte chunks and
 * collect its output plus every onUsage/onAccountError/onHostCompatShim call.
 * @param {Uint8Array[]} chunks
 * @param {{contentType?: string | null, hostCompatShim?: boolean}} [options] -
 *   `contentType` is forwarded to makeChunkedResponse; `hostCompatShim` is
 *   forwarded to createTransformedSSEStream (default true, matching prod).
 * @returns {Promise<{output: string, usageCalls: any[], accountErrorCalls: any[], hostCompatShimCalls: any[]}>}
 */
async function runTransformed(chunks, options) {
  const onUsage = vi.fn();
  const onAccountError = vi.fn();
  const onHostCompatShim = vi.fn();
  const stream = createTransformedSSEStream(makeChunkedResponse(chunks, options), {
    onUsage,
    onAccountError,
    onHostCompatShim,
    hostCompatShim: options?.hostCompatShim ?? true,
    correlationId: undefined,
    idleTimeoutMs: 0,
    captureEnabled: false,
    writeSseCapture: vi.fn(),
  });
  const output = await new Response(stream).text();
  return {
    output,
    usageCalls: onUsage.mock.calls,
    accountErrorCalls: onAccountError.mock.calls,
    hostCompatShimCalls: onHostCompatShim.mock.calls,
  };
}

/**
 * Run createTransformedSSEStream over a fixed sequence of byte chunks and
 * collect the RAW output bytes (via `Response#arrayBuffer`, which performs
 * no text decoding), instead of `runTransformed`'s decoded string — needed
 * to prove F5 byte-for-byte fidelity for a non-SSE body, since `.text()`
 * would itself lossily re-decode any invalid UTF-8 before the comparison
 * ever saw the raw bytes.
 * @param {Uint8Array[]} chunks
 * @param {{contentType?: string | null}} [options] - forwarded to makeChunkedResponse.
 * @returns {Promise<Uint8Array>}
 */
async function runTransformedRawBytes(chunks, options) {
  const stream = createTransformedSSEStream(makeChunkedResponse(chunks, options), {
    onUsage: vi.fn(),
    onAccountError: vi.fn(),
    onHostCompatShim: vi.fn(),
    correlationId: undefined,
    idleTimeoutMs: 0,
    captureEnabled: false,
    writeSseCapture: vi.fn(),
  });
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Build one SSE event's wire text using the real Anthropic framing (an
 * `event:` line naming the type, then a `data:` line carrying the JSON) —
 * distinct from {@link buildCorpusSSE} below, which omits the `event:` line
 * entirely. The L5 host-compat shim tests need the `event:` line present:
 * dropping a shimmed block must remove it too, not just the `data:` line,
 * or the host's SSE reader would see a named event with no matching data.
 * @param {object} obj - the event's JSON payload; `obj.type` names the event.
 * @returns {string}
 */
function sseEvent(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Build a synthetic stream exercising the L5 host-compat shim: a known
 * `thinking` block, an unknown `connector_text` block (must become a
 * `fallback` content_block_start) whose two deltas must be dropped, a known
 * `text` block carrying one unknown delta type that must also be dropped,
 * and content_block_stop for every index (all must survive — see
 * `applyHostCompatShim`'s doc on why `content_block_stop` is always safe).
 * The expected output is computed from the same per-event annotations
 * (`drop`/`rewriteTo`) the assertions check against, not from calling the
 * implementation, so it is an independent oracle.
 * @returns {{input: string, expectedOutput: string, expectedFallbacks: number, expectedDropped: number, expectedEventsDropped: number, knownThinkingText: string, knownTextText: string}}
 */
function buildHostCompatCase() {
  const knownThinkingText = "known thinking content, byte-identical";
  const knownTextText = "known text content, byte-identical";
  const events = [
    {
      obj: {
        type: "message_start",
        message: {
          id: "msg_1",
          usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      obj: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    },
    { obj: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: knownThinkingText } } },
    { obj: { type: "content_block_stop", index: 0 } },
    {
      obj: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "connector_text", text: "unknown block type" },
      },
      rewriteTo: { type: "content_block_start", index: 1, content_block: { type: "fallback" } },
    },
    {
      obj: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "dropped: fallback index" } },
      drop: true,
    },
    {
      obj: { type: "content_block_delta", index: 1, delta: { type: "tool_addition_delta", tool: "dropped too" } },
      drop: true,
    },
    { obj: { type: "content_block_stop", index: 1 } },
    { obj: { type: "content_block_start", index: 2, content_block: { type: "text" } } },
    { obj: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: knownTextText } } },
    {
      obj: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "totally_unknown_delta_type", value: "dropped: unknown delta in a known block" },
      },
      drop: true,
    },
    { obj: { type: "content_block_stop", index: 2 } },
    {
      obj: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    { obj: { type: "message_stop" } },
  ];

  let input = "";
  let expectedOutput = "";
  let expectedFallbacks = 0;
  let expectedDropped = 0;
  // No event in this case has an unrecognized top-level `type` (that's
  // exercised by its own dedicated test below) — kept here, at 0, so the
  // hostCompatShimCalls assertions below stay complete against the actual
  // {blockTypeFallbacks, deltasDropped, eventsDropped} callback payload.
  const expectedEventsDropped = 0;
  for (const ev of events) {
    input += sseEvent(ev.obj);
    if (ev.drop) {
      expectedDropped++;
      expectedOutput += "\n"; // the whole block (event: + data:) vanishes; the blank-line terminator alone remains
    } else if (ev.rewriteTo) {
      expectedFallbacks++;
      expectedOutput += sseEvent(ev.rewriteTo);
    } else {
      expectedOutput += sseEvent(ev.obj);
    }
  }
  return {
    input,
    expectedOutput,
    expectedFallbacks,
    expectedDropped,
    expectedEventsDropped,
    knownThinkingText,
    knownTextText,
  };
}

/**
 * Every way to split `bytes` into exactly two chunks (offsets 0..length,
 * inclusive — the endpoints collapse to a single-chunk run once empty
 * chunks are dropped by makeChunkedResponse), plus a byte-by-byte partition.
 * @param {Uint8Array} bytes
 * @returns {{ twoPart: Uint8Array[][], perByte: Uint8Array[] }}
 */
function allBytePartitions(bytes) {
  const twoPart = [];
  for (let i = 0; i <= bytes.length; i++) {
    twoPart.push([bytes.slice(0, i), bytes.slice(i)]);
  }
  const perByte = Array.from(bytes, (b) => new Uint8Array([b]));
  return { twoPart, perByte };
}

// Portuguese accents, CJK, an emoji, a ZWJ family sequence, and a
// supplementary-plane character (U+20000) — one corpus exercising 1-, 2-,
// 3-, and 4-byte UTF-8 sequences plus a surrogate-pair-heavy grapheme.
const MULTILINGUAL_CORPUS =
  "Descri\u00e7\u00e3o em portugu\u00eas: a\u00e7\u00e3o, cora\u00e7\u00e3o, n\u00e3o \u4e2d\u6587\u6d4b\u8bd5 \ud83d\ude00 \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 \ud840\udc00";

/**
 * Build a 4-event SSE stream (message_start, a text delta carrying the
 * multilingual corpus, an mcp_-prefixed tool_use start, and a message_delta
 * with final usage) using the given line ending for every terminator.
 * @param {string} lineEnding - "\n" or "\r\n"
 * @returns {string}
 */
function buildCorpusSSE(lineEnding) {
  const events = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: MULTILINGUAL_CORPUS },
    },
    {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "mcp_write_file", id: "t1" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 10, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`).join("");
}

const EXPECTED_CORPUS_USAGE = {
  inputTokens: 10,
  outputTokens: 42,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  lastStopReason: "end_turn",
};

// Regardless of the input's line ending, output framing always reserializes
// to "\n" (permitted by the mimicry contract); only the tool_use line's
// content changes (mcp_write_file -> write_file).
const EXPECTED_CORPUS_OUTPUT = buildCorpusSSE("\n").replace('"name":"mcp_write_file"', '"name":"write_file"');

describe("response stream mimicry", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS;
  });

  it("reverse-maps tool names in every supported tool_use location", () => {
    const parsed = {
      type: "message_start",
      content_block: { type: "tool_use", name: "mcp_write_file" },
      message: {
        content: [
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "call mcp_write_file", name: "mcp_keep_me" },
        ],
      },
      content: [{ type: "tool_use", name: "WebFetch" }],
    };

    expect(stripMcpPrefixFromParsedEvent(parsed)).toBe(true);
    expect(parsed.content_block.name).toBe("write_file");
    expect(parsed.message.content[0].name).toBe("bash");
    expect(parsed.message.content[1]).toEqual({ type: "text", text: "call mcp_write_file", name: "mcp_keep_me" });
    expect(parsed.content[0].name).toBe("webfetch");
  });

  it("combines multiline data payloads and ignores the done sentinel", () => {
    expect(getSSEDataPayload("event: message\ndata: first\ndata:  second")).toBe("first\n second");
    expect(getSSEDataPayload("data: [DONE]")).toBeNull();
  });

  it("extracts final usage and stop reason from message_delta", () => {
    const stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    extractUsageFromSSEEvent(
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
          server_tool_use: { web_search_requests: 2 },
        },
      },
      stats,
    );

    expect(stats).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      webSearchRequests: 2,
      lastStopReason: "max_tokens",
    });
  });

  it("identifies an account-specific mid-stream authentication error", () => {
    expect(
      getMidStreamAccountError({
        type: "error",
        error: { type: "authentication_error", message: "invalid bearer token" },
      }),
    ).toEqual({ reason: "AUTH_FAILED", invalidateToken: true });
  });

  it("resolves idle timeout from env, config, then the disabled default", () => {
    expect(resolveStreamIdleTimeoutMs({ streaming: { idle_timeout_ms: 1234.9 } })).toBe(1234);
    expect(resolveStreamIdleTimeoutMs({})).toBe(0);

    process.env.OPENCODE_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = "456.8";
    expect(resolveStreamIdleTimeoutMs({ streaming: { idle_timeout_ms: 1234 } })).toBe(456);
  });

  it("round-trips thinking bytes, rewrites tool names, and reports final usage", async () => {
    const thinkingFrame =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"consider mcp_write_file carefully"}}\n\n';
    const toolFrame =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_write_file","id":"t1"}}\n\n';
    const usageFrame =
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":4,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":0}}\n\n';
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(thinkingFrame.slice(0, 47)));
          controller.enqueue(encoder.encode(thinkingFrame.slice(47) + toolFrame + usageFrame));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const onUsage = vi.fn();
    const stream = createTransformedSSEStream(response, {
      onUsage,
      onAccountError: null,
      correlationId: undefined,
      idleTimeoutMs: 0,
      captureEnabled: false,
      writeSseCapture: vi.fn(),
    });

    const output = await new Response(stream).text();

    expect(output.startsWith(thinkingFrame)).toBe(true);
    expect(output).toContain('"name":"write_file"');
    expect(output).not.toContain('"name":"mcp_write_file"');
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      lastStopReason: "end_turn",
    });
  });

  describe("UTF-8 flush and SSE framing integrity (U5/U6)", () => {
    it("preserves a multilingual corpus and fires onUsage identically across every partition (LF)", async () => {
      const sse = buildCorpusSSE("\n");
      const bytes = new TextEncoder().encode(sse);
      const { twoPart, perByte } = allBytePartitions(bytes);

      const whole = await runTransformed([bytes]);
      expect(whole.output).toBe(EXPECTED_CORPUS_OUTPUT);
      expect(whole.usageCalls).toEqual([[EXPECTED_CORPUS_USAGE]]);
      expect(whole.accountErrorCalls).toEqual([]);
      expect(whole.output).toContain(MULTILINGUAL_CORPUS);

      for (const chunks of twoPart) {
        const result = await runTransformed(chunks);
        expect(result.output).toBe(whole.output);
        expect(result.usageCalls).toEqual(whole.usageCalls);
        expect(result.accountErrorCalls).toEqual([]);
      }

      const perByteResult = await runTransformed(perByte);
      expect(perByteResult.output).toBe(whole.output);
      expect(perByteResult.usageCalls).toEqual(whole.usageCalls);
    });

    it("preserves a multilingual corpus and fires onUsage identically across every partition (CRLF)", async () => {
      const sse = buildCorpusSSE("\r\n");
      const bytes = new TextEncoder().encode(sse);
      const { twoPart, perByte } = allBytePartitions(bytes);

      const whole = await runTransformed([bytes]);
      // CRLF framing reserializes to LF framing — same reconstructed output
      // as the LF-framed corpus, since no line's content is CRLF-dependent.
      expect(whole.output).toBe(EXPECTED_CORPUS_OUTPUT);
      expect(whole.usageCalls).toEqual([[EXPECTED_CORPUS_USAGE]]);

      for (const chunks of twoPart) {
        const result = await runTransformed(chunks);
        expect(result.output).toBe(whole.output);
        expect(result.usageCalls).toEqual(whole.usageCalls);
      }

      const perByteResult = await runTransformed(perByte);
      expect(perByteResult.output).toBe(whole.output);
      expect(perByteResult.usageCalls).toEqual(whole.usageCalls);
    });

    it("fires onUsage when a CRLF blank-line terminator is split across chunks", async () => {
      const usageEvent = {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      const prefix = `data: ${JSON.stringify(usageEvent)}`;
      const full = `${prefix}\r\n\r\n`;
      const bytes = new TextEncoder().encode(full);
      // Split so the blank-line terminator's CR ends chunk 1 and its LF
      // starts chunk 2 — the exact split the old per-chunk regex missed.
      const splitAt = new TextEncoder().encode(`${prefix}\r\n\r`).length;

      const { output, usageCalls } = await runTransformed([bytes.slice(0, splitAt), bytes.slice(splitAt)]);

      expect(usageCalls).toEqual([
        [{ inputTokens: 5, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, lastStopReason: "end_turn" }],
      ]);
      expect(output).toBe(`${prefix}\n\n`);
    });

    it("fires onUsage when a CRLF data-line terminator is split across chunks", async () => {
      const usageEvent = {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      const prefix = `data: ${JSON.stringify(usageEvent)}`;
      const full = `${prefix}\r\n\r\n`;
      const bytes = new TextEncoder().encode(full);
      // Split so the data line's own CR ends chunk 1 and its LF starts
      // chunk 2 (before the blank-line terminator is even reached).
      const splitAt = new TextEncoder().encode(`${prefix}\r`).length;

      const { output, usageCalls } = await runTransformed([bytes.slice(0, splitAt), bytes.slice(splitAt)]);

      expect(usageCalls).toEqual([
        [{ inputTokens: 6, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, lastStopReason: "end_turn" }],
      ]);
      expect(output).toBe(`${prefix}\n\n`);
    });

    it("passes a genuine U+FFFD character through unchanged", async () => {
      const event = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `before \ufffd after` },
      };
      const sse = `data: ${JSON.stringify(event)}\n\n`;

      const { output } = await runTransformed([new TextEncoder().encode(sse)]);

      expect(output).toBe(sse);
      expect(output).toContain("\ufffd");
    });

    it("surfaces a truncated multibyte sequence at end-of-stream as an explicit error, never a silent success", async () => {
      // A CJK character is 3 UTF-8 bytes; sending only the first 2 leaves an
      // incomplete-but-plausible prefix that must fail at final flush.
      const fullBytes = new TextEncoder().encode("\u4e2d");
      expect(fullBytes.length).toBe(3);
      const truncated = fullBytes.slice(0, 2);

      const onUsage = vi.fn();
      const stream = createTransformedSSEStream(makeChunkedResponse([truncated]), {
        onUsage,
        onAccountError: vi.fn(),
        correlationId: undefined,
        idleTimeoutMs: 0,
        captureEnabled: false,
        writeSseCapture: vi.fn(),
      });

      await expect(new Response(stream).text()).rejects.toThrow(/invalid UTF-8/i);
      expect(onUsage).not.toHaveBeenCalled();
    });

    it("surfaces a truncated multibyte sequence even when only 1 of 3 bytes arrived", async () => {
      const fullBytes = new TextEncoder().encode("\u4e2d");
      const truncated = fullBytes.slice(0, 1);

      await expect(runTransformed([truncated])).rejects.toThrow(/invalid UTF-8/i);
    });

    it("surfaces a genuinely invalid UTF-8 byte sequence mid-stream, before EOF", async () => {
      // 0x41 ("A"), then a lone continuation byte with no lead byte (never
      // valid, regardless of what follows), then 0x42 ("B").
      const invalid = new Uint8Array([0x41, 0x80, 0x42]);

      await expect(runTransformed([invalid])).rejects.toThrow(/invalid UTF-8/i);
    });

    it("keeps existing tool-name rewriting behavior for a plain LF stream (no regression)", async () => {
      const event = {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Bash", id: "t1" },
      };
      const sse = `data: ${JSON.stringify(event)}\n\n`;

      const { output } = await runTransformed([new TextEncoder().encode(sse)]);

      expect(output).toContain('"name":"bash"');
      expect(output).not.toContain('"name":"Bash"');
    });
  });

  describe("L3: incremental line splitting stays linear on one very long line", () => {
    it("processes a 2MB single SSE line split into 1KB chunks within a generous time bound", async () => {
      // Regression for a quadratic blowup: the old splitTerminatedLines
      // re-scanned the entire accumulated carry on every pull() call, so a
      // single long line split into many small chunks degraded badly (a 5MB
      // line at 1KB chunks measured ~45s pre-fix). 2MB / 1KB chunks here
      // (2000 pull() calls) with a generous 2s bound catches a regression
      // back to that behavior without being flaky on slower CI hardware.
      const total = 2_000_000;
      const line = `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "y".repeat(total) },
      })}\n\n`;
      const bytes = new TextEncoder().encode(line);
      const chunkSize = 1024;
      const chunks = [];
      for (let i = 0; i < bytes.length; i += chunkSize) {
        chunks.push(bytes.slice(i, i + chunkSize));
      }

      const startedAt = Date.now();
      const { output } = await runTransformed(chunks);
      const elapsedMs = Date.now() - startedAt;

      expect(output).toBe(line);
      expect(elapsedMs).toBeLessThan(2000);
    });
  });

  describe("L4: strict UTF-8 decoding applies only to SSE responses", () => {
    it("decodes a non-SSE error body leniently instead of throwing on invalid UTF-8", async () => {
      // Simulates a non-UTF-8 proxy/gateway error page: a 4xx/5xx body whose
      // Content-Type is not text/event-stream. 0x80 is a lone continuation
      // byte with no lead byte — never valid UTF-8 on its own — embedded in
      // an otherwise-readable error message.
      const bytes = new Uint8Array([
        ...new TextEncoder().encode('{"error":"upstream said: '),
        0x80,
        ...new TextEncoder().encode(' bad gateway"}'),
      ]);

      const { output } = await runTransformed([bytes], { contentType: "application/json" });

      expect(output).toContain("upstream said:");
      expect(output).toContain("bad gateway");
      expect(output).toContain("\ufffd");
    });

    it("decodes leniently when there is no Content-Type header at all", async () => {
      const invalid = new Uint8Array([0x41, 0x80, 0x42]);

      const { output } = await runTransformed([invalid], { contentType: null });

      expect(output).toContain("A");
      expect(output).toContain("\ufffd");
      expect(output).toContain("B");
    });

    it("still throws on invalid UTF-8 for an actual text/event-stream response", async () => {
      const invalid = new Uint8Array([0x41, 0x80, 0x42]);

      await expect(runTransformed([invalid], { contentType: "text/event-stream" })).rejects.toThrow(/invalid UTF-8/i);
    });
  });

  describe("L5: host-compat shim for opencode's pinned @ai-sdk/anthropic switch", () => {
    it("rewrites an unknown content_block_start to fallback, drops its deltas and any unknown delta in a known block, keeps content_block_stop, and leaves known blocks byte-identical", async () => {
      const {
        input,
        expectedOutput,
        expectedFallbacks,
        expectedDropped,
        expectedEventsDropped,
        knownThinkingText,
        knownTextText,
      } = buildHostCompatCase();

      const { output, hostCompatShimCalls } = await runTransformed([new TextEncoder().encode(input)]);

      expect(output).toBe(expectedOutput);
      expect(output).toContain(knownThinkingText);
      expect(output).toContain(knownTextText);
      expect(output).not.toContain("dropped");
      expect(output).not.toContain("connector_text");
      expect(output).toContain('"content_block":{"type":"fallback"}');
      expect(output).toContain('"type":"content_block_stop","index":1');
      expect(hostCompatShimCalls).toEqual([
        [
          {
            blockTypeFallbacks: expectedFallbacks,
            deltasDropped: expectedDropped,
            eventsDropped: expectedEventsDropped,
          },
        ],
      ]);
    });

    it("keeps the host-compat shim's output and shim-call count partition-independent", async () => {
      const { input, expectedOutput, expectedFallbacks, expectedDropped, expectedEventsDropped } =
        buildHostCompatCase();
      const bytes = new TextEncoder().encode(input);
      const { twoPart, perByte } = allBytePartitions(bytes);

      const whole = await runTransformed([bytes]);
      expect(whole.output).toBe(expectedOutput);
      expect(whole.hostCompatShimCalls).toEqual([
        [
          {
            blockTypeFallbacks: expectedFallbacks,
            deltasDropped: expectedDropped,
            eventsDropped: expectedEventsDropped,
          },
        ],
      ]);

      for (const chunks of twoPart) {
        const result = await runTransformed(chunks);
        expect(result.output).toBe(whole.output);
        expect(result.hostCompatShimCalls).toEqual(whole.hostCompatShimCalls);
      }

      const perByteResult = await runTransformed(perByte);
      expect(perByteResult.output).toBe(whole.output);
      expect(perByteResult.hostCompatShimCalls).toEqual(whole.hostCompatShimCalls);
    });

    it("drops an unknown delta type even inside an otherwise-known content block, keeping the block's other deltas and its content_block_stop", async () => {
      const sse =
        sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }) +
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "keep me" } }) +
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "made_up_delta_type", value: "drop me" } }) +
        sseEvent({ type: "content_block_stop", index: 0 });

      const { output } = await runTransformed([new TextEncoder().encode(sse)]);

      expect(output).toContain("keep me");
      expect(output).not.toContain("drop me");
      expect(output).not.toContain("made_up_delta_type");
      expect(output).toContain('"type":"content_block_stop","index":0');
    });

    it("leaves a stream containing only SDK-known block/delta types byte-identical, with no shim activity", async () => {
      const sse =
        sseEvent({
          type: "message_start",
          message: {
            id: "msg_2",
            usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }) +
        sseEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }) +
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "all good" } }) +
        sseEvent({ type: "content_block_stop", index: 0 }) +
        sseEvent({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t1", name: "read", input: {} },
        }) +
        sseEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }) +
        sseEvent({ type: "content_block_stop", index: 1 }) +
        sseEvent({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }) +
        sseEvent({ type: "message_stop" });

      const { output, hostCompatShimCalls } = await runTransformed([new TextEncoder().encode(sse)]);

      expect(output).toBe(sse);
      expect(hostCompatShimCalls).toEqual([]);
    });

    it("drops a whole SSE event with an unrecognized top-level type (F4d), counting it as eventsDropped, leaving adjacent known events byte-identical", async () => {
      const before = sseEvent({ type: "ping" });
      const unknown = sseEvent({ type: "some_future_event", note: "drop me whole" });
      const after = sseEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      const sse = before + unknown + after;
      // The whole dropped block's event:/data: lines vanish; its blank-line
      // terminator alone remains (same convention as buildHostCompatCase's
      // `drop` case above).
      const expectedOutput = before + "\n" + after;

      const { output, hostCompatShimCalls } = await runTransformed([new TextEncoder().encode(sse)]);

      expect(output).toBe(expectedOutput);
      expect(output).not.toContain("some_future_event");
      expect(output).not.toContain("drop me whole");
      expect(hostCompatShimCalls).toEqual([[{ blockTypeFallbacks: 0, deltasDropped: 0, eventsDropped: 1 }]]);
    });

    it("drops a citations_delta whose citation type is unrecognized, and keeps one whose citation type is SDK-known", async () => {
      const start = sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } });
      const knownCitation = sseEvent({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "citations_delta",
          citation: {
            type: "char_location",
            cited_text: "kept citation",
            document_index: 0,
            document_title: null,
            start_char_index: 0,
            end_char_index: 5,
          },
        },
      });
      const unknownCitation = sseEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "citations_delta", citation: { type: "future_citation_type", cited_text: "dropped citation" } },
      });
      const stop = sseEvent({ type: "content_block_stop", index: 0 });
      const sse = start + knownCitation + unknownCitation + stop;

      const { output, hostCompatShimCalls } = await runTransformed([new TextEncoder().encode(sse)]);

      expect(output).toContain("kept citation");
      expect(output).not.toContain("dropped citation");
      expect(output).not.toContain("future_citation_type");
      expect(output).toContain('"type":"content_block_stop","index":0');
      expect(hostCompatShimCalls).toEqual([[{ blockTypeFallbacks: 0, deltasDropped: 1, eventsDropped: 0 }]]);
    });

    it("with hostCompatShim:false, applies no shim rewriting at all — unknown blocks/deltas/events pass through byte-identical and onHostCompatShim never fires", async () => {
      const { input } = buildHostCompatCase();

      const { output, hostCompatShimCalls } = await runTransformed([new TextEncoder().encode(input)], {
        hostCompatShim: false,
      });

      expect(output).toBe(input);
      expect(hostCompatShimCalls).toEqual([]);
    });
  });

  describe("F3: shouldApplyHostCompatShim (host-SDK version gate)", () => {
    it("applies the shim for a host SDK version at or below the 3.0.111 baseline", () => {
      const ua = (v) => `opencode/1.18.32 ai-sdk/anthropic/${v} node/24`;
      expect(shouldApplyHostCompatShim(ua("3.0.110"))).toBe(true); // older patch
      expect(shouldApplyHostCompatShim(ua("3.0.111"))).toBe(true); // exact baseline
    });

    it("disables the shim only for a strictly newer host SDK version", () => {
      const ua = (v) => `opencode/1.18.32 ai-sdk/anthropic/${v} node/24`;
      expect(shouldApplyHostCompatShim(ua("3.0.112"))).toBe(false); // newer patch
      expect(shouldApplyHostCompatShim(ua("3.1.0"))).toBe(false); // newer minor
      expect(shouldApplyHostCompatShim(ua("4.0.0"))).toBe(false); // newer major
    });

    it("defaults to applying the shim (conservative) when the token is missing or unparseable", () => {
      expect(shouldApplyHostCompatShim("opencode/1.18.32 node/24")).toBe(true); // token absent
      expect(shouldApplyHostCompatShim("ai-sdk/anthropic/garbage")).toBe(true); // unparseable version
      expect(shouldApplyHostCompatShim("")).toBe(true);
      expect(shouldApplyHostCompatShim(undefined)).toBe(true);
      expect(shouldApplyHostCompatShim(null)).toBe(true);
    });
  });

  describe("F5: non-SSE response bodies pass through byte-for-byte, unbuffered", () => {
    it("leaves a non-SSE JSON body with CRLF line endings and no trailing newline byte-identical", async () => {
      const body = '{\r\n  "error": "bad request",\r\n  "detail": "no trailing newline"\r\n}';
      const bytes = new TextEncoder().encode(body);
      expect(bytes[bytes.length - 1]).not.toBe(0x0a); // sanity: source really has no trailing LF

      const output = await runTransformedRawBytes([bytes], { contentType: "application/json" });

      expect(output).toEqual(bytes);
    });

    it("leaves an invalid-UTF-8 non-SSE body byte-identical instead of substituting U+FFFD", async () => {
      const bytes = new Uint8Array([
        ...new TextEncoder().encode('{"error":"upstream said: '),
        0x80,
        ...new TextEncoder().encode(' bad gateway"}'),
      ]);

      const output = await runTransformedRawBytes([bytes], { contentType: "application/json" });

      expect(output).toEqual(bytes);
    });

    it("stays byte-identical when the body is split across an arbitrary chunk boundary", async () => {
      const body = "line one\r\nline two, no trailing newline";
      const bytes = new TextEncoder().encode(body);
      const splitAt = 5;

      const output = await runTransformedRawBytes([bytes.slice(0, splitAt), bytes.slice(splitAt)], {
        contentType: "text/plain",
      });

      expect(output).toEqual(bytes);
    });

    it("enqueues each input chunk immediately (unbuffered), never merging chunks or holding them until EOF", async () => {
      const chunks = [
        new TextEncoder().encode("abc"),
        new TextEncoder().encode("def"),
        new TextEncoder().encode("ghi"),
      ];
      const stream = createTransformedSSEStream(makeChunkedResponse(chunks, { contentType: "text/plain" }), {
        onUsage: vi.fn(),
        onAccountError: vi.fn(),
        onHostCompatShim: vi.fn(),
        correlationId: undefined,
        idleTimeoutMs: 0,
        captureEnabled: false,
        writeSseCapture: vi.fn(),
      });
      const reader = stream.getReader();
      const seen = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen.push(new TextDecoder().decode(value));
      }

      expect(seen).toEqual(["abc", "def", "ghi"]);
    });
  });
});
