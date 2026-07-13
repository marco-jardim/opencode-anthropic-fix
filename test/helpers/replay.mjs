import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { redactSecrets, redactString } from "../../lib/redact.mjs";

/**
 * Load a captured request fixture.
 *
 * @param {string} absPath
 * @returns {Record<string, unknown>}
 */
export function loadFixture(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8"));
}

/**
 * Persist a fixture after recursively removing secrets.
 *
 * @param {string} absPath
 * @param {unknown} fixture
 */
export function writeFixture(absPath, fixture) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(redactSecrets(fixture), null, 2)}\n`, "utf8");
}

/**
 * @param {{
 *   label?: string,
 *   timestamp?: string,
 *   method?: string,
 *   url?: string,
 *   headers?: Record<string, unknown>,
 *   body?: unknown,
 * }} capture
 * @param {{ status?: number, headers?: Record<string, unknown>, sseChunks?: string[] }} responseSpec
 * @param {Record<string, unknown>} meta
 * @returns {Record<string, unknown>}
 */
export function buildFixtureFromCapture(capture, responseSpec, meta) {
  const body = typeof capture.body === "string" ? redactString(capture.body) : redactSecrets(capture.body);
  const fixture = {
    meta,
    request: {
      method: capture.method,
      url: capture.url,
      headers: redactSecrets(capture.headers ?? {}),
      body,
    },
    response: redactSecrets(responseSpec),
  };

  return /** @type {Record<string, unknown>} */ (redactSecrets(fixture));
}

/**
 * @param {HeadersInit | undefined} headers
 * @returns {Record<string, string>}
 */
function headersToObject(headers) {
  if (!headers) return {};

  try {
    const normalized = new Headers(headers);
    return Object.fromEntries(normalized.entries());
  } catch {
    if (typeof headers !== "object" || headers === null) return {};
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
  }
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readResponseText(response) {
  if (!response.body || typeof response.body.getReader !== "function") return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

/**
 * Replay a fixture through the public plugin interceptor.
 *
 * @param {{
 *   request: { method?: string, url: string, headers?: Record<string, string>, body?: unknown },
 *   response: { status?: number, headers?: Record<string, string>, sseChunks: string[] },
 * }} fixture
 * @param {{
 *   fetchFn: typeof globalThis.fetch,
 *   fake: {
 *     enqueueSSE: (chunks: string[], options?: { status?: number, headers?: HeadersInit }) => void,
 *     calls: Array<{ input: RequestInfo | URL, init: RequestInit | undefined }>,
 *   },
 * }} dependencies
 */
export async function replayThroughInterceptor(fixture, { fetchFn, fake }) {
  fake.enqueueSSE(fixture.response.sseChunks, {
    status: fixture.response.status,
    headers: fixture.response.headers,
  });

  const response = await fetchFn(fixture.request.url, {
    method: fixture.request.method || "POST",
    headers: fixture.request.headers,
    body: typeof fixture.request.body === "string" ? fixture.request.body : JSON.stringify(fixture.request.body),
  });

  const call = fake.calls.at(-1);
  if (!call) throw new Error("Interceptor did not send a request upstream");

  const requestInput = call.input;
  const request = requestInput instanceof Request ? requestInput : null;
  const body = call.init?.body;
  let outgoingBody = "";
  if (typeof body === "string") outgoingBody = body;
  else if (body !== undefined && body !== null) outgoingBody = String(body);
  else if (request) outgoingBody = await request.clone().text();

  const outgoing = {
    url:
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput.url,
    headers: headersToObject(call.init?.headers ?? request?.headers),
    body: outgoingBody,
  };

  return {
    outgoing,
    response: {
      status: response.status,
      text: await readResponseText(response),
    },
  };
}
