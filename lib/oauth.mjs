import { createHash, randomBytes } from "node:crypto";
import { CLIENT_ID } from "./config.mjs";

// ---------------------------------------------------------------------------
// OAuth helpers — shared between plugin (index.mjs) and CLI (cli.mjs)
// ---------------------------------------------------------------------------

const OAUTH_CONSOLE_HOST = "platform.claude.com";
const OAUTH_MAX_HOST = "claude.ai";
const OAUTH_REDIRECT_URI = `https://${OAUTH_CONSOLE_HOST}/oauth/code/callback`;
const OAUTH_TOKEN_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/token`;
const OAUTH_REVOKE_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/revoke`;
const OAUTH_CLI_VERSION_PROFILE = "2.1.80";
const OAUTH_USER_AGENT = `claude-code/${OAUTH_CLI_VERSION_PROFILE}`;

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
 *   | { type: "failed", status?: number, code?: string, reason?: string, details?: string }
 * >}
 */
export async function exchange(code, verifier) {
  const fail = (status, rawText = "") => {
    let errorCode;
    let reason;

    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        if (typeof parsed.error === "string" && parsed.error) {
          errorCode = parsed.error;
        }
        if (typeof parsed.error_description === "string" && parsed.error_description) {
          reason = parsed.error_description;
        } else if (typeof parsed.message === "string" && parsed.message) {
          reason = parsed.message;
        }
      } catch {
        reason = rawText.trim() || undefined;
      }
    }

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
    };
  };

  const splits = code.split("#");
  let result;
  try {
    result = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": OAUTH_USER_AGENT,
      },
      body: JSON.stringify({
        code: splits[0],
        state: splits[1],
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
  } catch (err) {
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
    return fail(result.status, raw);
  }

  const json = await result.json();
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
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": OAUTH_USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshTokenValue,
      scope: CLAUDE_AI_SCOPES.join(" "),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const error = new Error(`Token refresh failed (HTTP ${resp.status}): ${text}`);
    error.status = resp.status;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) error.code = parsed.error;
    } catch {
      // Body may not be valid JSON
    }
    throw error;
  }

  return resp.json();
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
