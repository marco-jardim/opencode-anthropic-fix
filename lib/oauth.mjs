import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { parseRetryAfterHeader, parseRetryAfterMsHeader } from "./backoff.mjs";
import {
  OAUTH_BETA,
  OAUTH_CLAUDE_AI_AUTHORIZE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CONSOLE_AUTHORIZE_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_SDK_USER_AGENT,
  OAUTH_TOKEN_URL,
} from "./oauth-constants.mjs";
import { CLAUDE_AI_BASE_SCOPES, composeScopes, serializeScopes } from "./oauth-scopes.mjs";

// ---------------------------------------------------------------------------
// OAuth helpers — shared between plugin (index.mjs) and CLI (cli.mjs)
//
// Every *genuine* endpoint, user-agent and beta name used here is imported from
// ./oauth-constants.mjs, which transcribes docs/oauth-2.1.280-contract.md.
// This module owns OAuth *behaviour*; it owns no genuine OAuth *values*. The one
// value it does own is OAUTH_REVOKE_URL below, which is a divergence (D1) and is
// deliberately kept out of the transcription module.
// ---------------------------------------------------------------------------

/**
 * The RFC 7009 revocation endpoint.
 *
 * NOT PART OF GENUINE CLIENT BEHAVIOUR. `/v1/oauth/revoke` appears nowhere in
 * the Claude Code 2.1.280 bundle, so this URL is deliberately absent from
 * ./oauth-constants.mjs — that module is the transcription of the genuine
 * contract, and this is a divergence.
 * @see docs/oauth-2.1.280-contract.md §6 item 1, §7 divergence D1
 */
const OAUTH_REVOKE_URL = "https://platform.claude.com/v1/oauth/revoke";
const OAUTH_MAX_RETRIES = 2;
const OAUTH_MAX_RETRY_DELAY_MS = 30_000;
const OAUTH_RATE_LIMIT_COOLDOWN_MS = 30_000;
const OAUTH_RETRY_AFTER_SOURCE_HEADER_MS = "retry-after-ms";
const OAUTH_RETRY_AFTER_SOURCE_HEADER = "retry-after";
const OAUTH_RETRY_AFTER_SOURCE_FALLBACK_429 = "fallback-429";

/**
 * The claude.ai base scope set, in wire order.
 *
 * The array itself is now owned by `./oauth-scopes.mjs`, which composes the
 * conditional extensions. This is an alias binding onto that same frozen array
 * (not an `export … from` re-export), retained so existing importers of
 * `CLAUDE_AI_SCOPES` keep resolving.
 *
 * PARITY IS CONDITIONAL. §13.8 records two conditional extensions to this set:
 * `user:plugins` is appended when the `PLUGINS_SCOPE_REGISTERED` gate is on, and
 * `user:projects:read` / `user:projects:write` when requested. §13.8 does not
 * record the gate's shipped state. If it ships on, a genuine authorize URL
 * carries six scopes and this five-scope URL is itself a distinguishing signal.
 * That is an open, unverifiable item, not a solved one.
 * @see docs/oauth-2.1.280-contract.md §4.1, §4.2, §7 divergence D9
 */
export const CLAUDE_AI_SCOPES = CLAUDE_AI_BASE_SCOPES;

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
 * Resolve whether logout should attempt server-side token revocation.
 *
 * Defaults to `false`: revocation is not genuine-client behaviour, so it is an
 * explicit opt-in rather than something a user has to discover and disable.
 * An explicit boolean override (used by callers/tests) wins.
 * @param {boolean | undefined} override
 * @returns {boolean}
 * @see docs/oauth-2.1.280-contract.md §7 divergence D1
 */
function revokeOnLogoutEnabled(override) {
  if (typeof override === "boolean") return override;
  try {
    return loadConfig()?.oauth?.revoke_on_logout === true;
  } catch {
    return false;
  }
}

/**
 * Resolve the scope gates for an authorize call.
 *
 * An explicit option always wins over config, so a caller can force either
 * state in a test without touching the user's config file. A wrongly-typed
 * explicit option throws rather than silently deferring to config: these are
 * programmer inputs, and a silent fallback would make the forced state a lie.
 *
 * Config is read live (never cached in a closed-over constant) because
 * `/anthropic set` mutates it at runtime, and it is read ONLY when at least one
 * gate is still unresolved — `authorize()` used to be free of any filesystem
 * dependency and should reacquire one no more often than it must.
 *
 * A config read that fails degrades to the documented defaults rather than
 * failing the login, but it warns: silently downgrading a user who configured
 * `plugins_scope: true` to a five-scope token with no diagnostic is exactly the
 * kind of unexplained behaviour this project treats as a defect.
 * @param {{pluginsRegistered?: boolean, projectScopes?: string[]} | null} [options]
 * @returns {{pluginsRegistered: boolean, projectScopes: unknown}}
 * @see docs/oauth-2.1.280-contract.md §4.2, §7 divergence D9
 */
function resolveScopeOptions(options) {
  const opts = options ?? {};
  const pluginsExplicit = opts.pluginsRegistered !== undefined;
  const projectExplicit = opts.projectScopes !== undefined;
  if (pluginsExplicit && typeof opts.pluginsRegistered !== "boolean") {
    throw new TypeError("authorize(): options.pluginsRegistered must be a boolean when supplied");
  }
  if (projectExplicit && !Array.isArray(opts.projectScopes)) {
    throw new TypeError("authorize(): options.projectScopes must be an array when supplied");
  }
  if (pluginsExplicit && projectExplicit) {
    return { pluginsRegistered: opts.pluginsRegistered === true, projectScopes: opts.projectScopes };
  }

  let oauth;
  try {
    oauth = loadConfig()?.oauth;
  } catch (err) {
    console.warn(
      `[anthropic-auth] could not read config while composing OAuth scopes; requesting the default set: ${err?.message ?? err}`,
    );
    oauth = undefined;
  }
  return {
    pluginsRegistered: pluginsExplicit ? opts.pluginsRegistered === true : oauth?.plugins_scope === true,
    projectScopes: projectExplicit
      ? opts.projectScopes
      : Array.isArray(oauth?.project_scopes)
        ? oauth.project_scopes
        : [],
  };
}

/**
 * Build the headers for an OAuth token POST (exchange/refresh).
 *
 * MEASURED FOR REFRESH, ASSUMED FOR EXCHANGE. §13.8 attests this triple only at
 * the refresh call site (byte 4429828). It records no `authorization_code` grant
 * at all, so reusing the triple on exchange is assumption D8, not a measurement.
 *
 * This module emits one triple rather than switching between two: no axios usage
 * appears anywhere in §13.8, so a switch selecting an axios shape could not make
 * a user more anonymous — it would make them the only client sending that shape.
 *
 * SCOPE OF THE CLAIM: these are the three headers this module controls. The host
 * runtime adds its own (`host`, `connection`, `accept-encoding`, `content-length`
 * and others) with its own casing and ordering. §13.8 names no transport and no
 * platform, so the runtime-added set is unverifiable from the evidence and is
 * listed as an open signal in the contract doc. §13.8 also records a second
 * token-endpoint fingerprint (`oidcFederationProvider`); that surface is out of
 * scope here (D12).
 *
 * Header **order** is emitted in the order §13.8 enumerates it for refresh; the
 * source literal's own order is not attested. The literal is built in emission
 * order and must never be sorted or spread through a helper that reorders it.
 * @returns {Record<string, string>}
 * @see docs/oauth-2.1.280-contract.md §2.3, §2.5, §7 divergences D8 and D12
 */
function buildTokenHeaders() {
  return {
    "Content-Type": "application/json",
    "anthropic-beta": OAUTH_BETA,
    "User-Agent": OAUTH_SDK_USER_AGENT,
  };
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
 *
 * ASSUMPTION — THE QUERY STRING IS NOT ATTESTED. §13.8 records the two authorize
 * *URLs* and nothing else about this request: no query parameter set, no
 * parameter order, no PKCE material, and no redirect URI. Everything below the
 * origin and path is therefore pre-existing plugin behaviour preserved verbatim,
 * not a transcription of a measurement. Tests pin it so it cannot drift
 * accidentally; they do not certify it as genuine.
 *
 * The scope list is composed at call time from a base set plus gated additions.
 * Defaults reproduce the previous five-scope / two-scope strings byte for byte.
 * The genuine client's gate state is unattested (§7 divergence D9).
 * @param {"max" | "console"} mode
 * @param {{pluginsRegistered?: boolean, projectScopes?: string[]}} [options]
 * @returns {Promise<{url: string, verifier: string, state: string}>}
 * @see docs/oauth-2.1.280-contract.md §2.1, §1.1 (OAUTH_REDIRECT_URI)
 */
export async function authorize(mode, options = {}) {
  if (mode !== "max" && mode !== "console") {
    // Silently treating an unknown mode as consumer login would send a user to
    // the wrong provider with the wrong scope set and no visible failure.
    throw new Error(`Unknown OAuth mode "${mode}" (expected "max" or "console")`);
  }
  const pkce = generatePKCE();
  // Console mode ignores both gates (`composeScopes` drops them), so it must not
  // pay for a config read: `authorize()` acquires a filesystem dependency only
  // on the path that can actually use the answer.
  const gates = mode === "console" ? { pluginsRegistered: false, projectScopes: [] } : resolveScopeOptions(options);

  // The consumer authorize page carries a `/cai/` path segment, so this is a
  // full URL and not a host interpolated into a shared template.
  const url = new URL(mode === "console" ? OAUTH_CONSOLE_AUTHORIZE_URL : OAUTH_CLAUDE_AI_AUTHORIZE_URL);
  // --- unattested region: parameter set, order, and values (see the docblock) ---
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set(
    "scope",
    serializeScopes(
      composeScopes({ mode, pluginsRegistered: gates.pluginsRegistered, projectScopes: gates.projectScopes }),
    ),
  );
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
 * Parse an OAuth callback input into { code, state }.
 *
 * Tolerates all these input shapes:
 *  - Full redirect URL:   "https://host/path?code=X&state=Y"
 *  - Query string:        "?code=X&state=Y" or "code=X&state=Y"
 *  - Hash fragment URL:   "https://host/path#code=X&state=Y"
 *  - Hash fragment bare:  "#code=X&state=Y"
 *  - Legacy code#state:   "abc123#statevalue"
 *  - Plain code:          "abc123"
 *
 * Inputs are trimmed. URLSearchParams decoding is applied where applicable.
 * @param {string | null | undefined} input
 * @returns {{ code: string, state: string | null }}
 */
export function parseOAuthCallback(input) {
  if (!input || typeof input !== "string") return { code: "", state: null };
  const trimmed = input.trim();
  if (!trimmed) return { code: "", state: null };

  // --- Attempt 1: full URL (https://... or http://...) ---
  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      // Prefer hash params if they carry a "code" key (some OAuth flows use fragment)
      const hashStr = url.hash.slice(1);
      if (hashStr && hashStr.includes("=")) {
        const hashParams = new URLSearchParams(hashStr);
        const hCode = hashParams.get("code");
        if (hCode) return { code: hCode, state: hashParams.get("state") };
      }
      const qCode = url.searchParams.get("code");
      if (qCode) return { code: qCode, state: url.searchParams.get("state") };
    } catch {
      // fall through
    }
  }

  // --- Attempt 2: query string ("?code=X&state=Y" or "code=X&state=Y") ---
  {
    const qs = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    if (qs.includes("=") && (qs.startsWith("code") || qs.includes("&code"))) {
      try {
        const params = new URLSearchParams(qs);
        const qCode = params.get("code");
        if (qCode) return { code: qCode, state: params.get("state") };
      } catch {
        // fall through
      }
    }
  }

  // --- Attempt 3: hash fragment bare ("#code=X&state=Y") ---
  if (trimmed.startsWith("#")) {
    const hashStr = trimmed.slice(1);
    if (hashStr.includes("=")) {
      try {
        const params = new URLSearchParams(hashStr);
        const hCode = params.get("code");
        if (hCode) return { code: hCode, state: params.get("state") };
      } catch {
        // fall through
      }
    }
  }

  // --- Attempt 4: "code#state" bare format ---
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx > 0) {
    const codePart = trimmed.slice(0, hashIdx);
    const statePart = trimmed.slice(hashIdx + 1);
    return { code: codePart, state: statePart || null };
  }

  // --- Attempt 5: plain code ---
  return { code: trimmed, state: null };
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @param {string} verifier
 * @param {{ sdkTokenUserAgent?: boolean }} [options] - `sdkTokenUserAgent` is
 *   accepted and ignored. It is retained so existing call sites keep type-
 *   checking; there is only one token fingerprint. See §7 divergence D2.
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
export async function exchange(code, verifier, _options = {}) {
  const tokenHeaders = buildTokenHeaders();
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

  const { code: authCode, state: authState } = parseOAuthCallback(code);
  let result;
  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    try {
      // SHAPE IS INPUT-DEPENDENT (D8). `state` is present only when the pasted
      // callback carried one, so this body is five keys for a bare code and six
      // for a full callback URL. §13.8 records no authorization_code grant, so
      // neither shape can be checked against the evidence; the conditional is
      // preserved because the server has always accepted both from this client.
      const exchangeBody = {
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: OAUTH_REDIRECT_URI,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: verifier,
        ...(authState != null ? { state: authState } : {}),
      };
      result = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: tokenHeaders,
        body: JSON.stringify(exchangeBody),
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

  // Defensive guard — control flow guarantees result is always set, but kept for safety
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
    // Real CC extracts account UUID from token response (oauth/client.ts:253)
    // and uses it in metadata.user_id.account_uuid for billing correlation.
    accountUuid: json.account?.uuid || undefined,
    organizationUuid: json.organization?.uuid || undefined,
  };
}

/**
 * THIS REQUEST IS NOT PART OF GENUINE CLIENT BEHAVIOUR. `/v1/oauth/revoke`
 * appears nowhere in the Claude Code 2.1.280 bundle, so every revocation this
 * plugin performs is a request that identifies it. It is therefore gated behind
 * `oauth.revoke_on_logout`, which defaults to `false`.
 *
 * With the gate off the function performs **no network call at all** and
 * reports `{ attempted: false }`. With the gate on an RFC 7009-*style* request
 * is sent — note that RFC 7009 §2.1 mandates form encoding and this body is
 * JSON, matching the rest of this plugin's token layer rather than the RFC.
 *
 * The request carries the same SDK fingerprint as the other token requests
 * rather than the retired axios one. That is a judgement call, not a parity
 * claim: §13.8 has no revoke endpoint, so no user-agent is "correct" here, and
 * a `userOAuthProvider` agent on a path the SDK never calls is arguably its own
 * tell. The alternative was keeping a second, equally unevidenced fingerprint
 * alive purely for this one request, which is worse.
 *
 * THE RETURN VALUE DISTINGUISHES THREE OUTCOMES, because "we chose not to try"
 * and "we tried and the server refused" are different facts and a caller must
 * not report one as the other. Callers must proceed with local cleanup in all
 * three cases.
 *
 * @param {string} refreshToken
 * @param {{ revokeOnLogout?: boolean }} [options] - `revokeOnLogout` overrides
 *   the config flag (mainly for tests).
 * @returns {Promise<{ attempted: boolean, ok: boolean, status?: number, error?: string }>}
 * @see docs/oauth-2.1.280-contract.md §6 item 1, §7 divergence D1
 */
export async function revoke(refreshToken, options = {}) {
  if (!revokeOnLogoutEnabled(options.revokeOnLogout)) return { attempted: false, ok: false };
  try {
    const resp = await fetch(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: buildTokenHeaders(),
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return { attempted: true, ok: resp.ok === true, status: resp.status };
  } catch (err) {
    return { attempted: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Refresh an OAuth access token.
 * The request body is exactly `{ grant_type, refresh_token, client_id }`.
 * Genuine Claude Code 2.1.280 sends **no `scope` key** on refresh; sending one
 * is a positive fingerprint. `options.scopes` is therefore accepted and
 * ignored — it is retained so existing call sites keep working. No call site in
 * this repository passes it; the guard exists so a future one cannot silently
 * reintroduce the key.
 *
 * @param {string} refreshTokenValue - The refresh token to use
 * @param {{ signal?: AbortSignal, scopes?: string[], sdkTokenUserAgent?: boolean }} [options]
 *   `scopes` and `sdkTokenUserAgent` are accepted and ignored. A caller-supplied
 *   `signal` bounds the whole call including retries; when omitted, each attempt
 *   gets its own fresh 30 s timeout.
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
 * @throws {Error} On HTTP errors or network failures
 * @see docs/oauth-2.1.280-contract.md §2.3, §6 item 2
 */
export async function refreshToken(refreshTokenValue, options = {}) {
  const tokenHeaders = buildTokenHeaders();

  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    let resp;
    // A single AbortSignal.timeout() created outside the loop starts counting at
    // creation, so a slow first attempt would leave the retries with no budget
    // and turn a 3-attempt policy into a 1-attempt one. A caller that supplies
    // its own signal is explicitly bounding the whole operation, retries
    // included, so that one is shared on purpose.
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    try {
      resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: tokenHeaders,
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
          client_id: OAUTH_CLIENT_ID,
        }),
        signal,
      });
    } catch (err) {
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
}

/**
 * Check if an account has all required Claude.ai scopes.
 *
 * "Required" means the five-scope base set only. The conditional extensions
 * (`user:plugins`, `user:projects:*`) are deliberately NOT required: they are
 * opt-in, and demanding them would invalidate every already-stored token the
 * moment a user enables a gate. The consequence is that enabling
 * `oauth.plugins_scope` on an existing account does not by itself obtain the
 * scope — the user must re-authorise for the wider grant to be issued. That
 * gap is recorded in §7.3 of the contract doc.
 * @param {string[] | undefined} scopes
 * @returns {boolean}
 */
export function hasRequiredScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  const stored = new Set(scopes);
  return CLAUDE_AI_SCOPES.every((s) => stored.has(s));
}
