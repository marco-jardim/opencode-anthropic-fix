import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNetworkError, toSSEFrames } from "./fake-anthropic.mjs";
import { installHttpMock, teardownHttpMock } from "./http-mock.mjs";

describe("HTTP mock harness", () => {
  let http;

  beforeEach(() => {
    http = installHttpMock();
  });

  afterEach(() => {
    teardownHttpMock(http);
  });

  it("replays a multi-chunk SSE response through global fetch", async () => {
    const frames = toSSEFrames([
      'data: {"type":"message_start"}',
      'data: {"type":"content_block_delta","delta":{"text":"hello"}}',
      'data: {"type":"message_stop"}',
    ]);
    http.enqueueSSE(frames);

    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const received = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(decoder.decode(value, { stream: true }));
    }

    expect(received).toEqual(frames);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(http.calls).toEqual([
      {
        input: "https://api.anthropic.com/v1/messages",
        init: { method: "POST" },
      },
    ]);
  });

  it("simulates a 429 response with rate-limit reset headers", async () => {
    http.enqueue({
      status: 429,
      headers: {
        "retry-after": "3",
        "anthropic-ratelimit-unified-reset": "1700000000",
      },
      json: { error: { type: "rate_limit_error", message: "Rate limited" } },
    });

    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages");

    expect(response.ok).toBe(false);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("anthropic-ratelimit-unified-reset")).toBe("1700000000");
    await expect(response.text()).resolves.toContain("rate_limit_error");
  });

  it("simulates a 529 overloaded response", async () => {
    http.enqueue({
      status: 529,
      json: { error: { type: "overloaded_error", message: "Overloaded" } },
    });

    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages");

    expect(response.ok).toBe(false);
    expect(response.status).toBe(529);
    await expect(response.text()).resolves.toContain("overloaded_error");
  });

  it("errors the reader after a mid-stream disconnect", async () => {
    const disconnect = createNetworkError("ECONNRESET", "connection reset during stream");
    http.enqueueSSE(toSSEFrames(["data: first", "data: never-delivered"]), {
      disconnectAfter: 1,
      error: disconnect,
    });

    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages");
    const reader = response.body.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    await expect(reader.read()).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  it("supports empty and one-tiny-chunk SSE responses", async () => {
    http.enqueueSSE([]);
    http.enqueueSSE(toSSEFrames(["x"]));

    const empty = await globalThis.fetch("https://api.anthropic.com/v1/messages");
    await expect(empty.body.getReader().read()).resolves.toEqual({ done: true, value: undefined });

    const short = await globalThis.fetch("https://api.anthropic.com/v1/messages");
    const reader = short.body.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe("x\n\n");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("supports unauthorized responses and rejected fetches in FIFO order", async () => {
    http.enqueue({ status: 401, json: { error: { type: "authentication_error" } } });
    http.enqueueError(createNetworkError());

    const unauthorized = await globalThis.fetch("https://api.anthropic.com/v1/messages");
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.text()).resolves.toContain("authentication_error");

    await expect(globalThis.fetch("https://api.anthropic.com/v1/messages")).rejects.toMatchObject({
      code: "ECONNRESET",
    });
  });

  it("restores the original global fetch during teardown", () => {
    const installedFetch = globalThis.fetch;

    teardownHttpMock(http);

    expect(globalThis.fetch).not.toBe(installedFetch);
  });
});
