import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTransformedSSEStream,
  extractUsageFromSSEEvent,
  getMidStreamAccountError,
  getSSEDataPayload,
  resolveStreamIdleTimeoutMs,
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
 * @param {Uint8Array[]} chunks
 * @returns {Response}
 */
function makeChunkedResponse(chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          if (chunk.length > 0) controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  );
}

/**
 * Run createTransformedSSEStream over a fixed sequence of byte chunks and
 * collect its output plus every onUsage/onAccountError call.
 * @param {Uint8Array[]} chunks
 * @returns {Promise<{output: string, usageCalls: any[], accountErrorCalls: any[]}>}
 */
async function runTransformed(chunks) {
  const onUsage = vi.fn();
  const onAccountError = vi.fn();
  const stream = createTransformedSSEStream(makeChunkedResponse(chunks), {
    onUsage,
    onAccountError,
    correlationId: undefined,
    idleTimeoutMs: 0,
    captureEnabled: false,
    writeSseCapture: vi.fn(),
  });
  const output = await new Response(stream).text();
  return { output, usageCalls: onUsage.mock.calls, accountErrorCalls: onAccountError.mock.calls };
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
});
