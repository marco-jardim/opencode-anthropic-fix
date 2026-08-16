/**
 * The emulation-OFF request envelope.
 *
 * WHY THIS MODULE IS NOT UNDER lib/mimicry/. That is the point of it. With
 * `signature_emulation.enabled === false` the plugin makes NO attempt to look
 * like Claude Code, so no mimicry function may compose the outgoing headers —
 * if one did, "off" would keep meaning "less mimicry" instead of "none", which
 * is exactly the half-state Phase 2.2 removed.
 *
 * WHAT SURVIVES, AND WHY IT IS NOT MIMICRY. The plugin is an OAuth transport:
 * it owns the AUTH ENVELOPE and nothing else.
 *
 *  - `authorization` — the selected account's bearer. Without it there is no
 *    request; account rotation is the plugin's entire reason to exist.
 *  - `anthropic-beta` — ADDITIVE, never substitutive. The host's value is
 *    preserved verbatim and `oauth-2025-04-20` is appended when missing. That
 *    beta is a CONTRACT of the OAuth token, not a fingerprint: the API rejects
 *    an OAuth bearer without it (docs/claude-code-reverse-engineering.md §14.2
 *    item 3 and §14.3, both listing it as MUST for OAuth). Forging the rest of
 *    the beta list, or replacing the host's, would be mimicry — and is gone.
 *  - `x-api-key`, `x-session-affinity` — REMOVED. The first is a competing
 *    credential that would travel next to our bearer; the second is an opencode
 *    SDK routing hint that leaks session identity upstream. Both are envelope
 *    hygiene, not disguise.
 *
 * Everything else the host sent — `user-agent` above all — goes out untouched.
 */

import { stripStainlessHelperMarkers } from "./mimicry/headers.mjs";

/** The beta the Anthropic API requires alongside an OAuth bearer. */
export const OAUTH_BETA_FLAG = "oauth-2025-04-20";

/**
 * Credentials and routing hints that must not travel with our bearer.
 * @see the module comment
 */
const STRIPPED_HOST_HEADERS = ["x-api-key", "x-session-affinity"];

/**
 * Copy the host's headers, from either carrier, into one mutable set.
 *
 * @param {Request | URL | string | undefined} input
 * @param {RequestInit} requestInit
 * @returns {Headers}
 */
function collectHostHeaders(input, requestInit) {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, name) => headers.set(name, value));
  }

  const initHeaders = requestInit?.headers;
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, name) => headers.set(name, value));
  } else if (Array.isArray(initHeaders)) {
    for (const [name, value] of initHeaders) {
      if (typeof value !== "undefined") headers.set(name, String(value));
    }
  } else if (initHeaders && typeof initHeaders === "object") {
    for (const [name, value] of Object.entries(initHeaders)) {
      if (typeof value !== "undefined") headers.set(name, String(value));
    }
  }

  return headers;
}

/**
 * Build the outgoing headers for a request that carries NO Claude Code
 * emulation: the host's own headers plus the auth envelope.
 *
 * @param {Request | URL | string | undefined} input The host's fetch input.
 * @param {RequestInit} requestInit The host's fetch init.
 * @param {string} accessToken The selected account's access token.
 * @returns {Headers}
 */
export function buildPassthroughHeaders(input, requestInit, accessToken) {
  const headers = collectHostHeaders(input, requestInit);

  for (const name of STRIPPED_HOST_HEADERS) headers.delete(name);

  // ANTHROPIC_AUTH_TOKEN is the documented manual-bearer escape hatch and
  // belongs to the same envelope: it selects WHICH token authenticates, not how
  // the request looks.
  const authTokenOverride = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  headers.set("authorization", `Bearer ${authTokenOverride || accessToken}`);

  const hostBetas = (headers.get("anthropic-beta") || "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
  if (!hostBetas.includes(OAUTH_BETA_FLAG)) hostBetas.push(OAUTH_BETA_FLAG);
  headers.set("anthropic-beta", hostBetas.join(","));

  return headers;
}

/**
 * Remove the body fields the Anthropic API does not accept, and nothing else.
 *
 * THE ONLY BODY EDITS LEFT WITH EMULATION OFF. Every structural normalization
 * `transformRequestBody` performs (output cap, thinking, effort ->
 * output_config, system sanitize/compact, metadata, cache breakpoints) is
 * skipped on this path — the host's body goes out as the host wrote it. These
 * two strips are the exception, on the same grounds as the auth envelope: they
 * are what keeps the request VALID, not what makes it look like Claude Code.
 * Both were already applied unconditionally with emulation off, so keeping them
 * preserves a working request rather than adding policy.
 *
 *  - `betas` — never a first-party field. It existed for Bedrock, which cannot
 *    forward custom HTTP headers; the first-party API answers "Extra inputs are
 *    not permitted".
 *  - the stainless-helper markers — a HOST-side signal (opencode tags a tool or
 *    message so the plugin can derive `x-stainless-helper`). The plugin never
 *    injects them and, with emulation off, never derives the header either; the
 *    API has never known the keys and rejects them inside a tool definition.
 *    The marker list lives in lib/mimicry/headers.mjs and is imported rather
 *    than copied: the boundary rule this module enforces is that no mimicry
 *    function COMPOSES a fingerprint here, and removing a field the API rejects
 *    is the exact inverse of that.
 *
 * When neither is present the ORIGINAL string is returned, byte for byte: a
 * re-serialization would reorder nothing today but would make the passthrough
 * claim untrue tomorrow.
 *
 * @param {unknown} body
 * @returns {unknown} The body, with the non-API fields removed if present.
 */
export function stripNonApiBodyFields(body) {
  if (typeof body !== "string" || body.length === 0) return body;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON — there is no field to strip, and rewriting is not our business.
    return body;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;

  let changed = false;
  if (Object.hasOwn(parsed, "betas")) {
    delete parsed.betas;
    changed = true;
  }
  if (stripStainlessHelperMarkers(parsed.tools, parsed.messages) > 0) changed = true;

  return changed ? JSON.stringify(parsed) : body;
}
