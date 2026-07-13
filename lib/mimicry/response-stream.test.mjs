import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTransformedSSEStream,
  extractUsageFromSSEEvent,
  getMidStreamAccountError,
  getSSEDataPayload,
  resolveStreamIdleTimeoutMs,
  stripMcpPrefixFromParsedEvent,
} from "./response-stream.mjs";

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
});
