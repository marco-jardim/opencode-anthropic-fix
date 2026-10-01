import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createAnthropic } from "@ai-sdk/anthropic";

const TICKET_HEADER = "x-opencode-anthropic-fix-request";
const SDK_PACKAGE = "@ai-sdk/anthropic@3.0.111";

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * OpenCode 2.0.21 does not pass an abortSignal to LanguageModelV3.doStream.
 * Associate the host's HTTP hook with the custom fetch using a single-use
 * ticket. Its private header is stripped before the shared executor can send
 * anything. Public session interruption events cancel every request belonging
 * to that session, including requests waiting for their first response byte.
 *
 * Core 2.0.21 also JSON-validates provider/model settings, so settings.fetch is
 * rejected before initialization. A loopback bridge receives the host's normal
 * HTTP fetch and delegates to the existing executor. The SDK keeps Core's fetch
 * middleware; never put the returned internal fetch in provider/model settings.
 *
 * @param {{session: {hook: Function}, aisdk: {hook: Function}, event: {subscribe: Function}} context
 * @param {{fetch: typeof fetch, isManagedModel?: (model: object) => boolean, onError?: (error: Error) => void}} options
 * @returns {Promise<{fetch: typeof fetch, dispose: () => Promise<void>}>}
 */
export async function setupV2Transport(context, options) {
  const isManagedModel = options.isManagedModel ?? ((model) => model.providerID === "anthropic");
  const onError = options.onError ?? ((error) => console.error(`[anthropic] ${error.message}`));
  const tickets = new Map();
  const registrations = [];
  const subscription = new AbortController();
  let disposed = false;
  let eventFailure;
  let bridge;
  let bridgePromise;
  const bridgeSockets = new Set();

  const release = (ticket) => tickets.delete(ticket.id);
  const cancel = (ticket, reason) => {
    ticket.controller.abort(reason);
    release(ticket);
  };
  const cancelAll = (reason) => {
    for (const ticket of tickets.values()) cancel(ticket, reason);
  };

  // Begin listening before registering HTTP hooks. Losing the event stream must
  // fail closed: otherwise a later stop could silently leave a paid request alive.
  const eventTask = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: subscription.signal })) {
        if (event.type === "session.execution.interrupted") {
          for (const ticket of tickets.values()) {
            if (ticket.sessionID === event.data.sessionID) {
              cancel(ticket, abortError("OpenCode session interrupted."));
            }
          }
        } else if (["session.execution.succeeded", "session.execution.failed"].includes(event.type)) {
          for (const ticket of tickets.values()) {
            // A request that never reached fetch may have failed in another
            // HTTP hook. Keep active auxiliary streams until their own EOF.
            if (!ticket.started && ticket.sessionID === event.data.sessionID) release(ticket);
          }
        }
      }
      if (!disposed) throw new Error("OpenCode session event stream closed unexpectedly.");
    } catch (error) {
      if (disposed) return;
      eventFailure = error instanceof Error ? error : new Error(String(error));
      cancelAll(eventFailure);
      onError(eventFailure);
    }
  })();

  /** @type {typeof fetch} */
  const managedFetch = async (input, init) => {
    if (disposed) throw abortError("Anthropic plugin has been disposed.");
    if (eventFailure) throw eventFailure;
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    const id = headers.get(TICKET_HEADER);
    headers.delete(TICKET_HEADER);
    const ticket = tickets.get(id);
    if (!ticket || ticket.started) {
      throw new Error("Managed Anthropic requests require the OpenCode v2 HTTP hook.");
    }
    ticket.started = true;
    const callerSignal = init?.signal ?? request?.signal;
    const signals = [ticket.controller.signal, callerSignal].filter(Boolean);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const originalUserAgent = headers.get("user-agent");
    if (!originalUserAgent?.includes("ai-sdk/anthropic/")) {
      headers.set("user-agent", [originalUserAgent, "ai-sdk/anthropic/3.0.111"].filter(Boolean).join(" "));
    }
    // Normalize Request inputs too: no copy of the ticket-bearing Request is
    // handed to the executor, even when it inspects input.headers directly.
    for (const name of ["host", "connection", "content-length", "transfer-encoding", "keep-alive"])
      headers.delete(name);
    const cleanInput = request
      ? new Request(ticket.url, { method: request.method, body: request.body, headers, signal, duplex: "half" })
      : ticket.url;
    let response;
    try {
      signal.throwIfAborted();
      response = await options.fetch(cleanInput, { ...init, headers, signal });
      signal.throwIfAborted();
    } catch (error) {
      release(ticket);
      if (response?.body) await response.body.cancel(error);
      throw error;
    }
    if (!response.body) {
      release(ticket);
      return response;
    }
    const reader = response.body.getReader();
    let settled = false;
    let abort;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      release(ticket);
      reader.releaseLock();
    };
    const body = new ReadableStream(
      {
        start(controller) {
          abort = () => {
            if (settled) return;
            controller.error(signal.reason);
            // Abort also reaches the executor. Explicit reader cancellation
            // covers its in-memory response transforms and releases resources.
            reader.cancel(signal.reason).then(finish, (error) => {
              finish();
              onError(error instanceof Error ? error : new Error(String(error)));
            });
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
        async pull(controller) {
          try {
            const part = await reader.read();
            if (settled || signal.aborted) return;
            if (part.done) {
              controller.close();
              finish();
            } else controller.enqueue(part.value);
          } catch (error) {
            if (!settled) {
              controller.error(error);
              finish();
            }
          }
        },
        async cancel(reason) {
          // Remove our listener before aborting: cancellation already owns the
          // reader, and must not error a stream that the consumer just closed.
          signal.removeEventListener("abort", abort);
          ticket.controller.abort(reason ?? abortError("Anthropic response cancelled."));
          try {
            await reader.cancel(reason);
          } finally {
            finish();
          }
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  async function ensureBridge() {
    if (bridgePromise) return bridgePromise;
    bridge = createServer((request, response) => {
      const ticket = tickets.get(request.headers[TICKET_HEADER]);
      if (request.method !== "POST" || request.url !== "/" || !ticket || ticket.started) {
        response.writeHead(404).end();
        return;
      }
      // Claim at the HTTP boundary before reading the body. The fetch bridge
      // still checks started, so a second connection cannot replay this ticket.
      if (ticket.claimed) {
        response.writeHead(404).end();
        return;
      }
      ticket.claimed = true;
      const disconnect = () => {
        if (!response.writableFinished) cancel(ticket, abortError("OpenCode HTTP request disconnected."));
      };
      response.once("close", disconnect);
      void (async () => {
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) throw new Error("Anthropic request exceeds 32 MiB.");
            chunks.push(chunk);
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          const result = await managedFetch(ticket.url, { method: "POST", headers, body });
          const resultHeaders = Object.fromEntries(result.headers);
          for (const name of ["connection", "content-length", "transfer-encoding", "content-encoding"]) {
            delete resultHeaders[name];
          }
          response.writeHead(result.status, resultHeaders);
          if (result.body) await pipeline(Readable.fromWeb(result.body), response);
          else response.end();
        } catch (error) {
          const interrupted = ticket.controller.signal.aborted;
          cancel(ticket, error);
          if (!response.headersSent && !response.destroyed) {
            response.writeHead(502, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                type: "error",
                error: { type: "api_error", message: "Anthropic compatibility request failed." },
              }),
            );
          } else response.destroy();
          if (!interrupted) onError(new Error("Anthropic compatibility transport failed."));
        } finally {
          response.removeListener("close", disconnect);
        }
      })();
    });
    bridge.on("clientError", (_error, socket) => socket.destroy());
    bridge.on("connection", (socket) => {
      bridgeSockets.add(socket);
      socket.once("close", () => bridgeSockets.delete(socket));
    });
    bridgePromise = new Promise((resolve, reject) => {
      bridge.once("error", reject);
      bridge.listen(0, "127.0.0.1", () => {
        bridge.removeListener("error", reject);
        const address = bridge.address();
        resolve(`http://127.0.0.1:${address.port}/`);
      });
    });
    bridge.unref();
    return bridgePromise;
  }

  async function closeBridge() {
    if (!bridge) return;
    await bridgePromise;
    if (!bridge.listening) return;
    for (const socket of bridgeSockets) socket.destroy();
    await new Promise((resolve, reject) => bridge.close((error) => (error ? reject(error) : resolve())));
  }

  async function releaseResources(reason) {
    disposed = true;
    cancelAll(reason);
    subscription.abort();
    const results = await Promise.allSettled([
      ...registrations.map(async (registration) => registration.dispose()),
      closeBridge(),
      eventTask,
    ]);
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Failed to dispose Anthropic transport resources.");
  }

  try {
    registrations.push(
      await context.session.hook(
        "http.request",
        async (event) => {
          if (!isManagedModel(event.model)) return;
          if (disposed) throw abortError("Anthropic plugin has been disposed.");
          if (eventFailure) throw eventFailure;
          if (event.request.method !== "POST") throw new Error("Managed Anthropic HTTP requests must use POST.");
          const url = event.request.url;
          const ticket = {
            id: randomUUID(),
            url,
            sessionID: event.sessionID,
            controller: new AbortController(),
            started: false,
          };
          tickets.set(ticket.id, ticket);
          try {
            const bridgeURL = await ensureBridge();
            ticket.controller.signal.throwIfAborted();
            if (disposed) throw abortError("Anthropic plugin has been disposed.");
            if (eventFailure) throw eventFailure;
            const headers = new Headers(event.request.headers);
            headers.set(TICKET_HEADER, ticket.id);
            event.request = new Request(bridgeURL, {
              method: event.request.method,
              body: event.request.body,
              signal: event.request.signal,
              duplex: "half",
              headers,
            });
          } catch (error) {
            cancel(ticket, error);
            throw error;
          }
        },
        { providerID: "anthropic" },
      ),
    );
    registrations.push(
      await context.session.hook(
        "retry",
        (event) => {
          if (isManagedModel(event.model)) event.decision = { retry: false };
        },
        { providerID: "anthropic" },
      ),
    );
    registrations.push(
      await context.aisdk.hook(
        "sdk",
        (event) => {
          if (event.package !== SDK_PACKAGE || !isManagedModel(event.model)) return;
          event.sdk = createAnthropic({
            ...event.options,
            // The shared executor owns real account credentials and refresh.
            // A stable placeholder avoids caching credentials in SDK instances.
            apiKey: undefined,
            authToken: "opencode-managed-oauth",
          });
        },
        { providerID: "anthropic" },
      ),
    );
  } catch (error) {
    try {
      await releaseResources(error);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Anthropic transport initialization and cleanup failed.", {
        cause: cleanupError,
      });
    }
    throw error;
  }

  return {
    fetch: managedFetch,
    async dispose() {
      if (disposed) return;
      await releaseResources(abortError("Anthropic plugin has been disposed."));
    },
  };
}
