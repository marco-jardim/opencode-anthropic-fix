/**
 * @typedef {object} ScriptedResponse
 * @property {number} [status]
 * @property {string} [statusText]
 * @property {HeadersInit} [headers]
 * @property {BodyInit | null} [body]
 * @property {unknown} [json]
 * @property {Error} [error]
 */

/**
 * @typedef {object} SSEOptions
 * @property {number} [status]
 * @property {string} [statusText]
 * @property {HeadersInit} [headers]
 * @property {number} [disconnectAfter] Number of chunks to emit before erroring the stream.
 * @property {Error} [error]
 */

/**
 * Convert event payloads into complete SSE frames.
 *
 * @param {string[]} events
 * @returns {string[]}
 */
export function toSSEFrames(events) {
  return events.map((event) => `${event.replace(/(?:\r?\n)+$/u, "")}\n\n`);
}

/**
 * Create an Error suitable for a rejected fetch or an errored response stream.
 *
 * @param {string} [code]
 * @param {string} [message]
 * @returns {Error & { code: string }}
 */
export function createNetworkError(code = "ECONNRESET", message = "socket hang up") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {ScriptedResponse | Response} scripted
 * @returns {Response}
 */
function createResponse(scripted) {
  if (scripted instanceof Response) return scripted;

  const headers = new Headers(scripted.headers);
  let body = scripted.body ?? null;

  if (Object.hasOwn(scripted, "json")) {
    body = JSON.stringify(scripted.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  return new Response(body, {
    status: scripted.status ?? 200,
    statusText: scripted.statusText,
    headers,
  });
}

/**
 * Create a real streaming SSE Response whose chunks are delivered separately.
 *
 * @param {string[]} chunks Literal wire chunks. Use toSSEFrames() for complete events.
 * @param {SSEOptions} options
 * @returns {Response}
 */
function createSSEResponse(chunks, options) {
  const encoder = new TextEncoder();
  const encodedChunks = chunks.map((chunk) => encoder.encode(chunk));
  const disconnectAfter = options.disconnectAfter;
  let index = 0;

  if (disconnectAfter !== undefined && (!Number.isInteger(disconnectAfter) || disconnectAfter < 0)) {
    throw new RangeError("disconnectAfter must be a non-negative integer");
  }

  const stream = new ReadableStream(
    {
      pull(controller) {
        if (disconnectAfter !== undefined && index >= disconnectAfter) {
          controller.error(options.error ?? createNetworkError());
          return;
        }

        if (index >= encodedChunks.length) {
          controller.close();
          return;
        }

        controller.enqueue(encodedChunks[index]);
        index += 1;

        if (index >= encodedChunks.length && disconnectAfter === undefined) controller.close();
      },
    },
    { highWaterMark: 0 },
  );

  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");

  return new Response(stream, {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers,
  });
}

/**
 * Build a FIFO-scripted replacement for globalThis.fetch.
 *
 * @returns {{
 *   fetch: typeof globalThis.fetch,
 *   enqueue: (response: ScriptedResponse | Response) => void,
 *   enqueueSSE: (chunks: string[], options?: SSEOptions) => void,
 *   enqueueError: (error?: Error) => void,
 *   reset: () => void,
 *   calls: Array<{ input: RequestInfo | URL, init: RequestInit | undefined }>,
 * }}
 */
export function createFakeAnthropic() {
  /** @type {Array<ScriptedResponse | Response>} */
  const queue = [];
  /** @type {Array<{ input: RequestInfo | URL, init: RequestInit | undefined }>} */
  const calls = [];

  /** @type {typeof globalThis.fetch} */
  const fakeFetch = async (input, init) => {
    calls.push({ input, init });

    if (queue.length === 0) {
      throw new Error("Fake Anthropic response queue is empty");
    }

    const scripted = queue.shift();
    if (!scripted) throw new Error("Fake Anthropic response queue is empty");
    if (!(scripted instanceof Response) && scripted.error) throw scripted.error;
    return createResponse(scripted);
  };

  return {
    fetch: fakeFetch,
    enqueue(response) {
      queue.push(response);
    },
    enqueueSSE(chunks, options = {}) {
      queue.push(createSSEResponse(chunks, options));
    },
    enqueueError(error = createNetworkError()) {
      queue.push({ error });
    },
    reset() {
      queue.length = 0;
      calls.length = 0;
    },
    calls,
  };
}

/**
 * Wrap a fake fetch in vi.fn() without making Vitest a dependency of the helper.
 *
 * @param {{ fn: (implementation: typeof globalThis.fetch) => typeof globalThis.fetch }} vi
 * @param {ReturnType<typeof createFakeAnthropic>} fake
 * @returns {typeof globalThis.fetch}
 */
export function createViFetch(vi, fake) {
  return vi.fn(fake.fetch);
}
