import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber } from "effect";
import { setupV2Transport, V2_AUXILIARY_DEADLINE_MS } from "./v2-transport.mjs";
import { V2_MODEL_PACKAGE } from "./v2.mjs";

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dispose) => dispose()));
});

function eventSource() {
  const queue = [];
  let next;
  let closed = false;
  let failed;
  const push = (value) => {
    queue.push(value);
    next?.();
  };
  return {
    push,
    fail(error) {
      failed = error;
      next?.();
    },
    close() {
      closed = true;
      next?.();
    },
    async *subscribe({ signal }) {
      const abort = () => {
        closed = true;
        next?.();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (!closed) {
          if (failed) throw failed;
          if (queue.length) yield queue.shift();
          else await new Promise((resolve) => (next = resolve));
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

async function harness(send, options = {}) {
  const hooks = {};
  const dispose = vi.fn(async () => {});
  const events = eventSource();
  const onError = vi.fn();
  const hook = async (name, callback) => {
    hooks[name] = callback;
    return { dispose };
  };
  const transport = await setupV2Transport(
    { session: { hook }, aisdk: { hook }, event: events },
    { fetch: send, onError, ...options },
  );
  cleanups.push(transport.dispose);
  const model = { providerID: "anthropic", id: "claude-sonnet-4-5" };
  const request = async (sessionID, body = "{}", signal, kind = "primary") => {
    const event = {
      sessionID,
      model,
      kind,
      request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body, signal }),
    };
    await hooks["http.request"](event);
    return event.request;
  };
  return { transport, events, hooks, request, dispose, onError, model };
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const textEvents = [
  {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

describe("OpenCode v2 AI SDK transport", () => {
  it("bounds an unclaimed auxiliary ticket at the production deadline and clears timers at EOF", async () => {
    const app = await harness(async () => new Response("ok"));
    // Start the real listener before switching timers; only ticket deadlines
    // are virtualized, not socket setup or HTTP traffic.
    await app.request("listener");
    vi.useFakeTimers();
    try {
      expect(V2_AUXILIARY_DEADLINE_MS).toBe(600_000);
      const orphan = await app.request("orphan", "{}", undefined, "generate");
      const completed = await app.transport.fetch(await app.request("completed", "{}", undefined, "title"));
      expect(await completed.text()).toBe("ok");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(V2_AUXILIARY_DEADLINE_MS);
      await expect(app.transport.fetch(orphan)).rejects.toThrow("HTTP hook");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves host-selected thinking/effort and persists signed reasoning under the host key", async () => {
    const thinkingEvents = [
      textEvents[0],
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Consider this" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-thinking" } },
      ...textEvents.slice(3),
    ];
    const send = vi.fn(
      async () => new Response(sse(thinkingEvents), { headers: { "content-type": "text/event-stream" } }),
    );
    const app = await harness(send);
    const event = {
      model: app.model,
      package: V2_MODEL_PACKAGE.slice("aisdk:".length),
      options: { fetch: async (_url, init) => fetch(await app.request("one", init.body, init.signal)) },
    };
    app.hooks.sdk(event);
    // packages/core/src/aisdk.ts@v2.0.21:429-442 providerOptionKey:
    // if (packageName?.startsWith("@ai-sdk/")) return packageName.slice("@ai-sdk/".length)
    // return providerID
    const optionKey = event.package.startsWith("@ai-sdk/")
      ? event.package.slice("@ai-sdk/".length)
      : app.model.providerID;
    const selectedVariant = { thinking: { type: "enabled", budgetTokens: 1024 }, effort: "high" };
    const result = await event.sdk.languageModel(app.model.id).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Think" }] }],
      maxOutputTokens: 2048,
      providerOptions: { [optionKey]: selectedVariant },
    });
    const parts = [];
    for await (const part of result.stream) parts.push(part);
    expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "high" },
    });
    // publish-llm-event.ts:120 persists only metadata[providerMetadataKey].
    // The SDK attaches signature metadata to a reasoning-delta; the host folds
    // metadata from start/delta/end into the durable reasoning state.
    const state = Object.assign(
      {},
      ...parts.filter((part) => part.type.startsWith("reasoning-")).map((part) => part.providerMetadata?.[optionKey]),
    );
    expect(state).toMatchObject({ signature: "signed-thinking" });
    expect(parts.find((part) => part.type === "finish")?.providerMetadata?.[optionKey]).toBeDefined();
    const replay = await event.sdk.languageModel(app.model.id).doStream({
      prompt: [
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "Consider this", providerOptions: { [optionKey]: state } }],
        },
      ],
    });
    for await (const _part of replay.stream) {
      /* drain */
    }
    expect(JSON.parse(send.mock.calls[1][1].body).messages[0].content[0]).toMatchObject({
      type: "thinking",
      thinking: "Consider this",
      signature: "signed-thinking",
    });
  });

  it.each(["generate", "title"])(
    "bounds interrupted auxiliary %s fibers before headers without a primary event",
    async (kind) => {
      let signal;
      const app = await harness(
        (_input, init) => {
          signal = init.signal;
          return new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
        { auxiliaryDeadlineMs: 500 },
      );
      const request = await app.request("aux", "{}", undefined, kind);
      // Exactly the host's missing-signal call: interrupting this fiber neither
      // disconnects HTTP nor publishes session.execution.interrupted.
      const fiber = Effect.runFork(Effect.tryPromise({ try: () => fetch(request), catch: (error) => error }));
      await vi.waitFor(() => expect(signal).toBeDefined());
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(signal.aborted).toBe(false);
      await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 1500 });
      expect(signal.reason.message).toContain("auxiliary request deadline");
      expect(app.onError).not.toHaveBeenCalled();
    },
  );

  it("does not impose the auxiliary deadline on slow primary or compaction streams", async () => {
    const signals = [];
    const app = await harness(
      async (_input, init) => {
        signals.push(init.signal);
        return new Response("ok");
      },
      { auxiliaryDeadlineMs: 10 },
    );
    const responses = [];
    for (const kind of ["primary", "compaction"])
      responses.push(await app.transport.fetch(await app.request(kind, "{}", undefined, kind)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    for (const response of responses) expect(await response.text()).toBe("ok");
  });

  it("propagates an AI SDK abortSignal through loopback before headers without a primary event", async () => {
    let signal;
    const app = await harness((_input, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const event = {
      model: app.model,
      package: V2_MODEL_PACKAGE.slice("aisdk:".length),
      options: { fetch: async (_url, init) => fetch(await app.request("aux", init.body, init.signal, "generate")) },
    };
    app.hooks.sdk(event);
    const caller = new AbortController();
    const pending = event.sdk.languageModel(app.model.id).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      abortSignal: caller.signal,
    });
    const stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    caller.abort();
    await stopped;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("keeps Core's fetch middleware and parses an Anthropic SSE response with the pinned real SDK", async () => {
    const send = vi.fn(async () => new Response(sse(textEvents), { headers: { "content-type": "text/event-stream" } }));
    const app = await harness(send);
    // This follows aisdk.ts:prepareOptions/throughMiddleware: Core's normal
    // fetch runs the request hook before sending HTTP to our loopback bridge.
    const middlewareFetch = vi.fn(async (url, init) => {
      const event = { sessionID: "one", model: app.model, request: new Request(url, init), kind: "primary" };
      await app.hooks["http.request"](event);
      return fetch(event.request);
    });
    const event = {
      model: app.model,
      package: V2_MODEL_PACKAGE.slice("aisdk:".length),
      options: { apiKey: "host-key", authToken: "host-token", fetch: middlewareFetch },
    };
    // Core's dynamic hook runs first. Mirror sdk-factory.ts's file:// branch:
    // it must resolve a create* export locally, before our hook replaces it.
    expect(event.package.startsWith("file://")).toBe(true);
    const module = await import(event.package);
    expect(Object.keys(module)).toEqual(["createAnthropic"]);
    // Core supplies one credential; the later hook must also clear a conflicting
    // apiKey/authToken supplied by another hook (the fixture above tests both).
    event.sdk = module.createAnthropic({ ...event.options, authToken: undefined });
    expect(event.sdk.languageModel(app.model.id).specificationVersion).toBe("v3");
    app.hooks.sdk(event);
    const language = event.sdk.languageModel(app.model.id);
    expect(language.specificationVersion).toBe("v3");
    const result = await language.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 16,
    });
    const parts = [];
    for await (const part of result.stream) parts.push(part);
    expect(parts.find((part) => part.type === "text-delta")?.delta).toBe("Hello");
    expect(parts.find((part) => part.type === "finish")?.usage.inputTokens.total).toBe(3);
    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(middlewareFetch).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0][1];
    expect(sent.headers.has("x-opencode-anthropic-fix-request")).toBe(false);
    expect(sent.headers.get("user-agent")).toContain("ai-sdk/anthropic/3.0.111");
    expect(sent.headers.get("authorization")).toBe("Bearer opencode-managed-oauth");
    app.events.push({ type: "session.execution.interrupted", data: { sessionID: "one" } });
    await Promise.resolve();
    expect(sent.signal.aborted).toBe(false); // EOF removed this request.
  });

  it("aborts a pending first response only for the interrupted session", async () => {
    const signals = [];
    const send = vi.fn((_input, init) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });
    const app = await harness(send);
    const first = app.transport.fetch(await app.request("one"));
    const firstRejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = app.transport.fetch(await app.request("two"));
    const secondRejection = expect(second).rejects.toMatchObject({ name: "AbortError" });
    app.events.push({ type: "session.execution.interrupted", data: { sessionID: "one", reason: "user" } });
    await firstRejection;
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await app.transport.dispose();
    await secondRejection;
    expect(signals[1].aborted).toBe(true);
  });

  it("cancels requests interrupted while their lazy loopback listener is starting", async () => {
    const send = vi.fn();
    const app = await harness(send);
    const pending = app.request("one");
    const stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    app.events.push({ type: "session.execution.interrupted", data: { sessionID: "one" } });
    await stopped;
    expect(send).not.toHaveBeenCalled();
  });

  it("bridges real Effect interruption even when Core supplies no abortSignal", async () => {
    let signal;
    const app = await harness((_input, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const request = await app.request("one");
    // aisdk.ts ignores Effect.tryPromise's signal argument. execution.ts emits
    // the lifecycle event when that fiber settles. Use the pinned host's Effect
    // implementation to prove settlement does not await the pending HTTP promise.
    const hostCall = Effect.tryPromise({ try: () => app.transport.fetch(request), catch: (error) => error }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? Effect.sync(() => app.events.push({ type: "session.execution.interrupted", data: { sessionID: "one" } }))
          : Effect.void,
      ),
    );
    const fiber = Effect.runFork(hostCall);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await Effect.runPromise(Fiber.interrupt(fiber));
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("removes tickets from Request inputs and propagates caller aborts", async () => {
    const controller = new AbortController();
    const send = vi.fn(async (input, init) => {
      expect(input.headers.has("x-opencode-anthropic-fix-request")).toBe(false);
      expect(init.headers.has("x-opencode-anthropic-fix-request")).toBe(false);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });
    const app = await harness(send);
    const pending = app.transport.fetch(await app.request("one", "{}", controller.signal));
    const result = expect(pending).rejects.toThrow("caller stopped");
    controller.abort(new Error("caller stopped"));
    await result;
  });

  it("cancels a pending SSE read on session interruption without buffering", async () => {
    const cancelled = vi.fn();
    const send = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const app = await harness(send);
    const response = await app.transport.fetch(await app.request("one"));
    const reader = response.body.getReader();
    const pending = expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    app.events.push({ type: "session.execution.interrupted", data: { sessionID: "one" } });
    await pending;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("cancels upstream when its response consumer cancels and cleans up once", async () => {
    const cancelled = vi.fn();
    const app = await harness(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const response = await app.transport.fetch(await app.request("one"));
    await response.body.cancel("reader closed");
    expect(cancelled).toHaveBeenCalledExactlyOnceWith("reader closed");
    await app.transport.dispose();
    await app.transport.dispose();
    expect(app.dispose).toHaveBeenCalledTimes(3);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("propagates an error after emitted SSE bytes without replaying the request", async () => {
    let upstream;
    const send = vi.fn(
      async () => new Response(new ReadableStream({ start: (controller) => (upstream = controller) })),
    );
    const app = await harness(send);
    const response = await app.transport.fetch(await app.request("one"));
    const reader = response.body.getReader();
    upstream.enqueue(new TextEncoder().encode("data: first\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    upstream.error(new Error("stream failed"));
    await expect(reader.read()).rejects.toThrow("stream failed");
    await app.transport.dispose();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it("keeps an active auxiliary response when the primary execution succeeds", async () => {
    const send = vi.fn(async () => new Response("title"));
    const app = await harness(send);
    const response = await app.transport.fetch(await app.request("one"));
    app.events.push({ type: "session.execution.succeeded", data: { sessionID: "one" } });
    await Promise.resolve();
    expect(send.mock.calls[0][1].signal.aborted).toBe(false);
    expect(await response.text()).toBe("title");
  });

  it("releases responses without a body", async () => {
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    const app = await harness(send);
    expect((await app.transport.fetch(await app.request("one"))).status).toBe(204);
    await app.transport.dispose();
    expect(send.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it("fails closed and cancels pending requests if the session event subscription fails", async () => {
    const app = await harness(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );
    const pending = app.transport.fetch(await app.request("one"));
    const result = expect(pending).rejects.toThrow("subscription failed");
    app.events.fail(new Error("subscription failed"));
    await result;
    expect(app.onError).toHaveBeenCalledOnce();
    await expect(app.request("two")).rejects.toThrow("subscription failed");
  });

  it("rejects untracked requests, used tickets and calls after disposal", async () => {
    const send = vi.fn(async () => new Response("ok"));
    const app = await harness(send);
    await expect(app.transport.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow("HTTP hook");
    const request = await app.request("one");
    const response = await app.transport.fetch(request.clone());
    await expect(app.transport.fetch(request)).rejects.toThrow("HTTP hook");
    await response.text();
    await app.transport.dispose();
    await expect(app.transport.fetch("https://api.anthropic.com/v1/messages")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("binds only loopback and rejects missing tickets, replay, other methods and caller-selected targets", async () => {
    const send = vi.fn(async () => new Response("ok"));
    const app = await harness(send);
    const request = await app.request("one");
    expect(new URL(request.url).hostname).toBe("127.0.0.1");
    expect((await fetch(request.url, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(request.url, { headers: request.headers })).status).toBe(404);
    expect(
      (
        await fetch(`${request.url}?target=https://evil.example`, {
          method: "POST",
          headers: request.headers,
          body: "{}",
        })
      ).status,
    ).toBe(404);
    const replay = request.clone();
    const response = await fetch(request);
    expect(await response.text()).toBe("ok");
    expect((await fetch(replay)).status).toBe(404);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(send.mock.calls[0][1].headers.has("x-opencode-anthropic-fix-request")).toBe(false);
  });

  it("aborts the executor when the host disconnects its loopback request before headers", async () => {
    let executorSignal;
    const app = await harness((_input, init) => {
      executorSignal = init.signal;
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const request = await app.request("one");
    const response = fetch(request, { signal: controller.signal });
    const stopped = expect(response).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(executorSignal).toBeDefined());
    controller.abort();
    await stopped;
    await vi.waitFor(() => expect(executorSignal.aborted).toBe(true));
    expect(app.onError).not.toHaveBeenCalled();
  });

  it("lets only the shared executor retry and leaves unmanaged models alone", async () => {
    const app = await harness(vi.fn(), { isManagedModel: (model) => model.id === "managed" });
    const managed = { model: { id: "managed" }, decision: { retry: true, delay: 500 } };
    const other = { model: { id: "other" }, decision: { retry: true, delay: 500 } };
    app.hooks.retry(managed);
    app.hooks.retry(other);
    expect(managed.decision).toEqual({ retry: false });
    expect(other.decision).toEqual({ retry: true, delay: 500 });
    const request = new Request("https://example.org");
    const event = { model: { id: "other" }, request };
    app.hooks["http.request"](event);
    expect(event.request).toBe(request);
    const sdk = { model: { id: "other" }, package: "@ai-sdk/anthropic@3.0.111", options: {} };
    app.hooks.sdk(sdk);
    expect(sdk.sdk).toBeUndefined();
  });

  it("disposes registrations and its event subscription when setup fails", async () => {
    const events = eventSource();
    const dispose = vi.fn(async () => {});
    const sessionHook = vi.fn(async () => ({ dispose }));
    const sdkHook = vi.fn(async () => {
      throw new Error("SDK hook unavailable");
    });
    await expect(
      setupV2Transport({ session: { hook: sessionHook }, aisdk: { hook: sdkHook }, event: events }, { fetch: vi.fn() }),
    ).rejects.toThrow("SDK hook unavailable");
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("closes its loopback listener even when disposing a host registration fails", async () => {
    const app = await harness(vi.fn());
    const request = await app.request("one");
    app.dispose.mockRejectedValueOnce(new Error("Host registration is already closed"));
    await expect(app.transport.dispose()).rejects.toThrow("Failed to dispose Anthropic transport resources");
    expect(app.dispose).toHaveBeenCalledTimes(3);
    await expect(fetch(request.url)).rejects.toThrow();
    await app.transport.dispose();
  });
});
