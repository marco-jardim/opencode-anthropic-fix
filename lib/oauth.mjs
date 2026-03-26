import { createHash, randomBytes } from "node:crypto";
import { CLIENT_ID } from "./config.mjs";
import { parseRetryAfterHeader, parseRetryAfterMsHeader } from "./backoff.mjs";

// ---------------------------------------------------------------------------
// OAuth helpers — shared between plugin (index.mjs) and CLI (cli.mjs)
// ---------------------------------------------------------------------------

const OAUTH_CONSOLE_HOST = "platform.claude.com";
const OAUTH_MAX_HOST = "claude.ai";
const OAUTH_REDIRECT_URI = `https://${OAUTH_CONSOLE_HOST}/oauth/code/callback`;
const OAUTH_TOKEN_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/token`;
const OAUTH_REVOKE_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/revoke`;
// Real Claude Code uses axios 1.13.6 for OAuth calls — axios sets User-Agent
// automatically and adds Accept header. We must match this fingerprint exactly.
// CLI version profile: 2.1.84 (for reference; not sent on OAuth calls)
const OAUTH_AXIOS_VERSION = "1.13.6";
const OAUTH_USER_AGENT = `axios/${OAUTH_AXIOS_VERSION}`;
const OAUTH_ACCEPT = "application/json, text/plain, */*";
const OAUTH_MAX_RETRIES = 2;
const OAUTH_MAX_RETRY_DELAY_MS = 30_000;
const OAUTH_RATE_LIMIT_COOLDOWN_MS = 30_000;
const OAUTH_RETRY_AFTER_SOURCE_HEADER_MS = "retry-after-ms";
const OAUTH_RETRY_AFTER_SOURCE_HEADER = "retry-after";
const OAUTH_RETRY_AFTER_SOURCE_FALLBACK_429 = "fallback-429";

export const CLAUDE_AI_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const CONSOLE_SCOPES = ["org:create_api_key", "user:profile"];

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableTokenStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * @param {Response} resp
 * @param {number} attempt
 * @returns {number}
 */
function getRetryDelayMs(resp, attempt) {
  if (!resp || !resp.headers || typeof resp.headers.get !== "function") {
    return Math.min(1000 * 2 ** attempt, 8000);
  }
  const headerMs = parseRetryAfterMsHeader(resp);
  const retryAfterMs = parseRetryAfterHeader(resp);
  const fallback = Math.min(1000 * 2 ** attempt, 8000);
  const resolved = headerMs ?? retryAfterMs ?? fallback;
  return Math.max(250, Math.min(resolved, OAUTH_MAX_RETRY_DELAY_MS));
}

/**
 * Build a caller-facing cooldown hint from Retry-After headers.
 * Falls back to a conservative 30s cooldown for 429s.
 * @param {Response | null | undefined} resp
 * @param {number | undefined} status
 * @returns {{ retryAfterMs: number | null, retryAfterSource?: string }}
 */
function getCooldownHint(resp, status) {
  if (resp && resp.headers && typeof resp.headers.get === "function") {
    const headerMs = parseRetryAfterMsHeader(resp);
    if (Number.isFinite(headerMs) && headerMs > 0) {
      return {
        retryAfterMs: Math.max(250, Math.min(headerMs, OAUTH_MAX_RETRY_DELAY_MS)),
        retryAfterSource: OAUTH_RETRY_AFTER_SOURCE_HEADER_MS,
      };
    }

    const retryAfterMs = parseRetryAfterHeader(resp);
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return {
        retryAfterMs: Math.max(250, Math.min(retryAfterMs, OAUTH_MAX_RETRY_DELAY_MS)),
        retryAfterSource: OAUTH_RETRY_AFTER_SOURCE_HEADER,
      };
    }
  }

  if (status === 429) {
    return {
      retryAfterMs: OAUTH_RATE_LIMIT_COOLDOWN_MS,
      retryAfterSource: OAUTH_RETRY_AFTER_SOURCE_FALLBACK_429,
    };
  }

  return { retryAfterMs: null };
}

/**
 * @param {string} rawText
 * @returns {{ errorCode?: string, reason?: string }}
 */
function parseOAuthErrorBody(rawText) {
  if (!rawText) return {};

  try {
    const parsed = JSON.parse(rawText);
    let errorCode;
    let reason;

    if (typeof parsed.error === "string" && parsed.error) {
      errorCode = parsed.error;
    } else if (parsed.error && typeof parsed.error === "object") {
      if (typeof parsed.error.type === "string" && parsed.error.type) {
        errorCode = parsed.error.type;
      }
      if (typeof parsed.error.message === "string" && parsed.error.message) {
        reason = parsed.error.message;
      }
    }

    if (!reason) {
      if (typeof parsed.error_description === "string" && parsed.error_description) {
        reason = parsed.error_description;
      } else if (typeof parsed.message === "string" && parsed.message) {
        reason = parsed.message;
      }
    }

    return {
      ...(errorCode ? { errorCode } : {}),
      ...(reason ? { reason } : {}),
    };
  } catch {
    const trimmed = rawText.trim();
    return trimmed ? { reason: trimmed } : {};
  }
}

/**
 * Build an OAuth authorization URL with PKCE challenge.
 * @param {"max" | "console"} mode
 * @returns {Promise<{url: string, verifier: string, state: string}>}
 */
export async function authorize(mode) {
  const pkce = generatePKCE();

  const url = new URL(`https://${mode === "console" ? OAUTH_CONSOLE_HOST : OAUTH_MAX_HOST}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  const scopes = mode === "console" ? CONSOLE_SCOPES : CLAUDE_AI_SCOPES;
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.state);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state: pkce.state,
  };
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @param {string} verifier
 * @returns {Promise<
 *   | { type: "success", refresh: string, access: string, expires: number, email?: string }
 *   | {
 *       type: "failed",
 *       status?: number,
 *       code?: string,
 *       reason?: string,
 *       details?: string,
 *       retryAfterMs?: number,
 *       retryAfterSource?: "retry-after-ms" | "retry-after" | "fallback-429"
 *     }
 * >}
 */
export async function exchange(code, verifier) {
  const fail = (status, rawText = "", cooldownHint = { retryAfterMs: null }) => {
    const { errorCode, reason } = parseOAuthErrorBody(rawText);
    const retryAfterMs =
      Number.isFinite(cooldownHint?.retryAfterMs) && cooldownHint.retryAfterMs > 0
        ? Number(cooldownHint.retryAfterMs)
        : null;

    const detailsParts = [];
    if (typeof status === "number") detailsParts.push(`HTTP ${status}`);
    if (errorCode) detailsParts.push(errorCode);
    if (reason) detailsParts.push(reason);

    return {
      type: "failed",
      ...(typeof status === "number" ? { status } : {}),
      ...(errorCode ? { code: errorCode } : {}),
      ...(reason ? { reason } : {}),
      ...(detailsParts.length ? { details: detailsParts.join(" · ") } : {}),
      ...(retryAfterMs ? { retryAfterMs } : {}),
      ...(cooldownHint?.retryAfterSource ? { retryAfterSource: cooldownHint.retryAfterSource } : {}),
    };
  };

  const splits = code.split("#");
  let result;
  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    try {
      result = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: OAUTH_ACCEPT,
          "Content-Type": "application/json",
          "User-Agent": OAUTH_USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: splits[0],
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
          state: splits[1],
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (attempt < OAUTH_MAX_RETRIES) {
        await sleep(Math.min(500 * 2 ** attempt, 2000));
        continue;
      }
      return fail(undefined, err instanceof Error ? err.message : String(err));
    }

    if (!result.ok) {
      const raw =
        typeof result.text === "function"
          ? await result
              .text()
              .then((value) => (typeof value === "string" ? value : ""))
              .catch(() => "")
          : "";

      if (attempt < OAUTH_MAX_RETRIES && isRetryableTokenStatus(result.status)) {
        await sleep(getRetryDelayMs(result, attempt));
        continue;
      }

      return fail(result.status, raw, getCooldownHint(result, result.status));
    }

    break;
  }

  if (!result) {
    return fail(undefined, "Token exchange request did not complete");
  }

  let json;
  try {
    json = await result.json();
  } catch {
    return fail(result.status, "Invalid JSON in token response");
  }

  // Validate required fields before returning success (QA fix C4)
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    return fail(result.status, "Missing required fields in token response");
  }

  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
    email: json.account?.email_address || undefined,
  };
}

/**
 * Attempt to revoke a refresh token server-side (best-effort, RFC 7009).
 *
 * Anthropic may or may not support this endpoint. The function returns
 * `true` on a 2xx response and `false` otherwise — callers should always
 * proceed with local cleanup regardless of the result.
 *
 * @param {string} refreshToken
 * @returns {Promise<boolean>}
 */
export async function revoke(refreshToken) {
  try {
    const resp = await fetch(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: {
        Accept: OAUTH_ACCEPT,
        "Content-Type": "application/json",
        "User-Agent": OAUTH_USER_AGENT,
      },
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Refresh an OAuth access token.
 * @param {string} refreshTokenValue - The refresh token to use
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
 * @throws {Error} On HTTP errors or network failures
 */
export async function refreshToken(refreshTokenValue, options = {}) {
  // QA fix M13: default 30s timeout to prevent hanging on unresponsive server
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  let lastError = null;

  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: OAUTH_ACCEPT,
          "Content-Type": "application/json",
          "User-Agent": OAUTH_USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
          client_id: CLIENT_ID,
          scope: options.scopes ? options.scopes.join(" ") : CLAUDE_AI_SCOPES.join(" "),
        }),
        signal,
      });
    } catch (err) {
      lastError = err;
      if (attempt < OAUTH_MAX_RETRIES) {
        await sleep(Math.min(500 * 2 ** attempt, 2000));
        continue;
      }
      throw err;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const retryAfterMs = getRetryDelayMs(resp, attempt);

      if (attempt < OAUTH_MAX_RETRIES && isRetryableTokenStatus(resp.status)) {
        await sleep(retryAfterMs);
        continue;
      }

      const error = new Error(`Token refresh failed (HTTP ${resp.status}): ${text}`);
      error.status = resp.status;
      const cooldownHint = getCooldownHint(resp, resp.status);
      error.retryAfterMs =
        Number.isFinite(cooldownHint.retryAfterMs) && cooldownHint.retryAfterMs > 0
          ? cooldownHint.retryAfterMs
          : retryAfterMs;
      if (cooldownHint.retryAfterSource) {
        error.retryAfterSource = cooldownHint.retryAfterSource;
      }

      const parsed = parseOAuthErrorBody(text);
      if (parsed.errorCode) error.code = parsed.errorCode;

      throw error;
    }

    return resp.json();
  }

  throw lastError instanceof Error ? lastError : new Error("Token refresh failed after retries");
}

/**
 * Check if an account has all required Claude.ai scopes.
 * @param {string[] | undefined} scopes
 * @returns {boolean}
 */
export function hasRequiredScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  const stored = new Set(scopes);
  return CLAUDE_AI_SCOPES.every((s) => stored.has(s));
}
