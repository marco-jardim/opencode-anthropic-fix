/**
 * Debug-dump helpers for the request/response debug sinks (`config.debug`,
 * `token_economy.debug_dump_bodies`).
 *
 * These are plain helper functions, NOT plugin factories. They must never be
 * re-exported from `index.mjs`: opencode's plugin loader iterates
 * `Object.values(mod)` of the plugin entry module and calls every export as a
 * plugin factory with the plugin input object (`{ client, ... }`, no
 * `response`), then throws "Plugin export is not a function" / crashes on
 * `response.status` for any export that isn't one. See
 * `test/conformance/plugin-entry-exports.test.mjs`.
 */
import { randomUUID } from "node:crypto";
import { redactSecrets, redactString } from "./redact.mjs";

const _debugSessionId = randomUUID().slice(0, 8);
let _debugReqSeq = 0;

/**
 * Create a short, human-scannable id correlating the outgoing request debug
 * dump with its response debug dump.
 *
 * @returns {string}
 */
export function createDebugCorrelationId() {
  return `${_debugSessionId}-${(++_debugReqSeq).toString(36).padStart(4, "0")}`;
}

/**
 * Whether a given debug sink is enabled for the current config.
 *
 * @param {any} config
 * @param {"body"|"headers"} sink
 * @returns {boolean}
 */
export function isDebugSinkEnabled(config, sink) {
  return sink === "body" ? config.token_economy?.debug_dump_bodies === true : Boolean(config.debug);
}

/**
 * Build the {filename, content} pair for a request-body debug dump.
 *
 * @param {string} correlationId
 * @param {string} timestamp
 * @param {string} finalBody
 * @returns {{filename: string, content: string}}
 */
export function createDebugRequestDump(correlationId, timestamp, finalBody) {
  return {
    filename: `req-${timestamp}-${correlationId}.json`,
    content: JSON.stringify({ correlationId, timestamp, bodyRedacted: redactString(finalBody) }),
  };
}

/**
 * Build a log-file entry describing the outgoing request headers.
 *
 * @param {string} correlationId
 * @param {string} timestamp
 * @param {any} requestHeaders
 * @returns {string}
 */
export function createDebugOutgoingHeadersEntry(correlationId, timestamp, requestHeaders) {
  return [
    `\n=== ${timestamp} | corr=${correlationId} | OUTGOING request headers ===`,
    JSON.stringify(redactSecrets(requestHeaders), null, 2),
    "",
  ].join("\n");
}

/**
 * Build a log-file entry describing the response status/headers.
 *
 * @param {string} correlationId
 * @param {string} timestamp
 * @param {Response} response
 * @param {{account: boolean, accountManager: boolean, rateLimitHeaders: any, allHeaders: any}} debugHeaders
 * @returns {string}
 */
export function createDebugResponseHeadersEntry(correlationId, timestamp, response, debugHeaders) {
  return [
    `\n=== ${timestamp} | corr=${correlationId} | status=${response.status} ok=${response.ok} account=${debugHeaders.account} mgr=${debugHeaders.accountManager} ===`,
    `Rate-limit headers: ${JSON.stringify(debugHeaders.rateLimitHeaders, null, 2)}`,
    `All headers: ${JSON.stringify(debugHeaders.allHeaders, null, 2)}`,
    "",
  ].join("\n");
}
