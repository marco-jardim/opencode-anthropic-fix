import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { parseRetryAfterHeader, parseRetryAfterMsHeader } from "./backoff.mjs";
import {
  OAUTH_AXIOS_ACCEPT,
  OAUTH_AXIOS_ACCEPT_ENCODING,
  OAUTH_AXIOS_USER_AGENT,
  OAUTH_CLAUDE_AI_AUTHORIZE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CONSOLE_AUTHORIZE_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_REVOKE_URL,
  OAUTH_TOKEN_URL,
} from "./oauth-constants.mjs";
import {
  CLAUDE_AI_BASE_SCOPES,
  DEFAULT_REFRESH_SCOPES,
  PLUGINS_SCOPE,
  composeScopes,
  missingBaseScopes,
  serializeScopes,
} from "./oauth-scopes.mjs";
import { resolveCustomOAuthUrl } from "./oauth-env.mjs";
import { WIRE_PROFILE } from "./mimicry/wire-compat.mjs";

// ---------------------------------------------------------------------------
// OAuth helpers — shared between plugin (index.mjs) and CLI (cli.mjs)
//
// Every *genuine* endpoint, header value and scope name used here is imported
// from ./oauth-constants.mjs and ./oauth-scopes.mjs, which transcribe
// docs/oauth-2.1.280-contract.md as corrected by docs/oauth-2.1.329-contract.md.
// This module owns OAuth *behaviour*; it owns no genuine OAuth *values*.
// ---------------------------------------------------------------------------

const OAUTH_MAX_RETRIES = 2;
/** One-shot latch for the "exchange without state" warning. */
let stateWarningEmitted = false;
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
 * This is only the claude.ai base set. The authorize URL carries the wider
 * union composed by `composeScopes()` (console base, this set, `user:plugins`).
 * @see docs/oauth-2.1.329-contract.md §3
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
 * Resolve the plugins-scope gate for an authorize call.
 *
 * An explicit option always wins over config, so a caller can force either
 * state in a test without touching the user's config file. A wrongly-typed
 * explicit option throws rather than silently deferring to config: these are
 * programmer inputs, and a silent fallback would make the forced state a lie.
 *
 * Config is read live (never cached in a closed-over constant) because
 * `/anthropic set` mutates it at runtime, and it is read ONLY when the gate is
 * still unresolved. `user:plugins` is a genuine default, so only an explicit
 * `false` (option or config) removes it; a failed config read keeps it, with a
 * warning.
 *
 * Project scopes are never part of a login request and have no option here;
 * the deprecated `oauth.project_scopes` config key is not read.
 * @param {{pluginsRegistered?: boolean} | null} [options]
 * @returns {{pluginsRegistered: boolean}}
 * @see docs/oauth-2.1.329-contract.md §3
 */
function resolveScopeOptions(options) {
  const opts = options ?? {};
  if (opts.pluginsRegistered !== undefined) {
    if (typeof opts.pluginsRegistered !== "boolean") {
      throw new TypeError("authorize(): options.pluginsRegistered must be a boolean when supplied");
    }
    return { pluginsRegistered: opts.pluginsRegistered };
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
  return { pluginsRegistered: oauth?.plugins_scope !== false };
}

/**
 * Build the headers for an OAuth token POST (exchange, refresh, revoke).
 *
 * The genuine client issues these as axios calls whose only explicit header is
 * `Content-Type`; axios adds `Accept`, `User-Agent` and `Accept-Encoding`. There
 * is no `anthropic-beta` and no SDK user agent. `User-Agent` is set explicitly
 * because the host `fetch` would otherwise inject its own.
 *
 * Order matches the live capture of the genuine exchange: Accept, Content-Type,
 * User-Agent, Accept-Encoding. The literal is built in emission order and must
 * never be sorted or spread through a helper that reorders it.
 *
 * SCOPE OF THE CLAIM: these are the headers this module controls. The runtime
 * adds `Content-Length`, `Host` and `Connection` itself, with its own casing,
 * position and keep-alive behaviour (the genuine capture shows `Connection:
 * close`). That residual is recorded in the contract doc.
 * @returns {Record<string, string>}
 * @see docs/oauth-2.1.329-contract.md §1
 */
function buildTokenHeaders() {
  return {
    Accept: OAUTH_AXIOS_ACCEPT,
    "Content-Type": "application/json",
    "User-Agent": OAUTH_AXIOS_USER_AGENT,
    "Accept-Encoding": OAUTH_AXIOS_ACCEPT_ENCODING,
  };
}

/**
 * Build the `fetch` init shared by every token-endpoint POST.
 *
 * `redirect: "manual"` mirrors the genuine `maxRedirects: 0`: a redirect is never
 * followed, and since only a 2xx response is accepted (`Response.ok`) the 3xx
 * surfaces as a failure instead of leaking the body to another origin.
 * @param {unknown} body
 * @param {AbortSignal} signal
 * @returns {RequestInit}
 */
function tokenRequestInit(body, signal) {
  return {
    method: "POST",
    headers: buildTokenHeaders(),
    body: JSON.stringify(body),
    redirect: "manual",
    signal,
  };
}

/**
 * Split a token response `scope` string into a scope list.
 * @param {unknown} scope
 * @returns {string[] | undefined}
 */
function parseGrantedScopes(scope) {
  if (typeof scope !== "string") return undefined;
  const list = scope.split(/\s+/).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
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
 * The scope list is the same union in both modes (console base, claude.ai base,
 * `user:plugins`, then `options.extraScopes`); `mode` only selects the host.
 * Project scopes are never sent.
 * @param {"max" | "console"} mode
 * @param {{pluginsRegistered?: boolean, extraScopes?: string[], env?: Record<string, string | undefined>}} [options]
 * @returns {Promise<{url: string, verifier: string, state: string}>}
 * @see docs/oauth-2.1.280-contract.md §2.1, §1.1 (OAUTH_REDIRECT_URI)
 */
export async function authorize(mode, options = {}) {
  if (mode !== "max" && mode !== "console") {
    // Silently treating an unknown mode as consumer login would send a user to
    // the wrong provider with the wrong scope set and no visible failure.
    throw new Error(`Unknown OAuth mode "${mode}" (expected "max" or "console")`);
  }

  // ATTESTED: §13.8 (byte 4657393) records that CLAUDE_CODE_CUSTOM_OAUTH_URL is
  // validated against a three-entry allowlist and throws otherwise. That throw is
  // the attested behaviour and is enforced here: an unapproved value rejects with
  // the byte-exact genuine message.
  //
  // NOT ATTESTED: what an APPROVED value is then used for. §13.8 records the
  // validation, not the consumption, so redirecting the flow to it would be an
  // invention. But silently ignoring an approved value is worse than either
  // option: an operator who points this plugin at a FedRAMP endpoint would get no
  // error and would still have their authorization code and refresh token sent to
  // platform.claude.com. Validate-then-ignore is a misroute dressed as a feature.
  // So an approved value is refused explicitly until the use site is attested.
  // Divergence D14.
  const customOAuthUrl = resolveCustomOAuthUrl(options?.env ?? process.env);
  if (customOAuthUrl) {
    throw new Error(
      `CLAUDE_CODE_CUSTOM_OAUTH_URL is set to the approved endpoint ${customOAuthUrl}, but this plugin cannot honour it: the evidence records that the value is validated, not what it is used for, so redirecting the flow would be a guess. Unset the variable to authenticate against the default endpoints. See the OAuth wire contract doc, divergence D14.`,
    );
  }

  const pkce = generatePKCE();
  // The genuine client sends the same scope union for both modes, so both read
  // the plugins gate the same way.
  const gates = resolveScopeOptions(options);

  // The consumer authorize page carries a `/cai/` path segment, so this is a
  // full URL and not a host interpolated into a shared template.
  const url = new URL(mode === "console" ? OAUTH_CONSOLE_AUTHORIZE_URL : OAUTH_CLAUDE_AI_AUTHORIZE_URL);
  // --- unattested region: parameter set, order, and values (see the docblock) ---
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  // Scopes beyond the attested base union come from the emulated profile
  // (`oauthAuthorizeScopes`, the genuine authorize URL's list); an explicit
  // `options.extraScopes` wins. `user:plugins` stays removable: the profile list
  // carries it, so an opt-out has to filter it out of the extras too.
  const profileScopes = Array.isArray(WIRE_PROFILE.oauthAuthorizeScopes) ? WIRE_PROFILE.oauthAuthorizeScopes : [];
  const extraScopes = (options?.extraScopes ?? profileScopes).filter(
    (scope) => !(gates.pluginsRegistered === false && scope === PLUGINS_SCOPE),
  );
  url.searchParams.set(
    "scope",
    serializeScopes(composeScopes({ mode, pluginsRegistered: gates.pluginsRegistered, extraScopes })),
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
 *
 * The genuine exchange always sends `state`. It is taken from the pasted
 * callback (`code#state`, a URL, a query string) and falls back to
 * `options.state`, the value `authorize()` returned. When both are present and
 * differ the exchange is refused with `state_mismatch` before any request. When
 * neither is present the body is sent without `state` (legacy shape) and a
 * one-time warning is logged, so a bare pasted code still works.
 * @param {string} code
 * @param {string} verifier
 * @param {{ state?: string, signal?: AbortSignal, sdkTokenUserAgent?: boolean }} [options] - `sdkTokenUserAgent`
 *   is accepted and ignored; there is only one token fingerprint.
 * @returns {Promise<
 *   | { type: "success", refresh: string, access: string, expires: number, email?: string, scopes?: string[] }
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
export async function exchange(code, verifier, options = {}) {
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

  const { code: authCode, state: callbackState } = parseOAuthCallback(code);
  const expectedState = typeof options.state === "string" && options.state.length > 0 ? options.state : null;
  if (callbackState != null && callbackState !== "" && expectedState != null && callbackState !== expectedState) {
    // Refused locally: never put a code whose state does not match this login
    // attempt on the wire (RFC 6749 §10.12).
    return {
      type: "failed",
      code: "state_mismatch",
      reason: "OAuth state mismatch — possible CSRF. Start a new login flow.",
      details: "state_mismatch · OAuth state mismatch — possible CSRF. Start a new login flow.",
    };
  }
  const bodyState = callbackState != null && callbackState !== "" ? callbackState : expectedState;
  if (bodyState == null && !stateWarningEmitted) {
    // Tolerated rather than refused so a bare pasted code keeps logging in. The
    // body then has the legacy five-key shape, which the genuine client never sends.
    stateWarningEmitted = true;
    console.warn(
      "[anthropic-auth] token exchange has no OAuth state (bare code pasted and no state supplied); sending the legacy body without `state`",
    );
  }
  // The genuine exchange body always carries `state`, in this key order (live
  // capture of the genuine client; see docs/oauth-2.1.329-contract.md §1).
  const exchangeBody = {
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: verifier,
    ...(bodyState != null ? { state: bodyState } : {}),
  };
  let result;
  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    options.signal?.throwIfAborted();
    try {
      // Match the runtime's AbortSignal.any baseline; a caller signal must
      // not replace the independent per-attempt network deadline.
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      result = await fetch(OAUTH_TOKEN_URL, tokenRequestInit(exchangeBody, signal));
    } catch (err) {
      options.signal?.throwIfAborted();
      if (attempt < OAUTH_MAX_RETRIES) {
        await sleep(Math.min(500 * 2 ** attempt, 2000), options.signal);
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
        await sleep(getRetryDelayMs(result, attempt), options.signal);
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

  const grantedScopes = parseGrantedScopes(json.scope);
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
    // The granted scope set, persisted so a later refresh can request exactly it.
    ...(grantedScopes ? { scopes: grantedScopes } : {}),
  };
}

/**
 * Server-side token revocation, gated behind `oauth.revoke_on_logout` (default
 * `false`). The genuine client posts `{token, token_type_hint, client_id}` to
 * `${TOKEN_URL}/revoke` with the same axios fingerprint as the other token
 * requests and a 5 s timeout, and counts the revocation as acknowledged only
 * when a 2xx response carries a `request-id` header. The gate stays off by
 * default because logout revocation is not something the genuine CLI does on
 * every logout, so enabling it is an explicit user decision.
 *
 * With the gate off the function performs **no network call at all** and
 * reports `{ attempted: false }`.
 *
 * THE RETURN VALUE DISTINGUISHES THREE OUTCOMES, because "we chose not to try"
 * and "we tried and the server did not acknowledge" are different facts and a
 * caller must not report one as the other. Callers must proceed with local
 * cleanup in all three cases. `ok` is the acknowledgement: it is `false` for a
 * non-2xx response and for a 2xx response without a `request-id` header.
 *
 * @param {string} refreshToken
 * @param {{ revokeOnLogout?: boolean }} [options] - `revokeOnLogout` overrides
 *   the config flag (mainly for tests).
 * @returns {Promise<{ attempted: boolean, ok: boolean, status?: number, error?: string }>}
 * @see docs/oauth-2.1.329-contract.md §2
 */
export async function revoke(refreshToken, options = {}) {
  if (!revokeOnLogoutEnabled(options.revokeOnLogout)) return { attempted: false, ok: false };
  try {
    const resp = await fetch(
      OAUTH_REVOKE_URL,
      tokenRequestInit(
        {
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: OAUTH_CLIENT_ID,
        },
        AbortSignal.timeout(5000),
      ),
    );
    if (resp.ok !== true) return { attempted: true, ok: false, status: resp.status };
    const acknowledged = typeof resp.headers?.has === "function" && resp.headers.has("request-id");
    if (!acknowledged) {
      return { attempted: true, ok: false, status: resp.status, error: "no request-id acknowledgement" };
    }
    return { attempted: true, ok: true, status: resp.status };
  } catch (err) {
    return { attempted: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Refresh an OAuth access token.
 *
 * The request body is `{ grant_type, refresh_token, client_id, scope }`, in that
 * order, as the genuine client sends it: `scope` is always present. It carries
 * `options.scopes` (the grant stored for the account) and otherwise the default
 * list — the claude.ai base scopes plus `user:plugins`. A legacy account whose
 * grant is narrower than that default is refused with `invalid_scope`; the
 * request is then retried once without `scope`, which the server answers with
 * the original grant, and the granted set is returned as `scopes` so the caller
 * can persist it.
 *
 * @param {string} refreshTokenValue - The refresh token to use
 * @param {{ signal?: AbortSignal, scopes?: string[], sdkTokenUserAgent?: boolean, clientId?: string }} [options]
 *   `scopes` is the stored grant to request; `sdkTokenUserAgent` is accepted and
 *   ignored. A caller-supplied `signal` bounds the whole call including retries;
 *   when omitted, each attempt gets its own fresh 30 s timeout.
 *   `clientId` overrides the default OAuth client id. It exists for
 *   CLAUDE_CODE_OAUTH_CLIENT_ID-seeded accounts (contract §5.2, divergence D10).
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number, scope?: string, scopes?: string[]}>}
 * @throws {Error} On HTTP errors or network failures
 * @see docs/oauth-2.1.329-contract.md §1
 */
export async function refreshToken(refreshTokenValue, options = {}) {
  const requestedScopes =
    Array.isArray(options.scopes) && options.scopes.some((scope) => typeof scope === "string" && scope.length > 0)
      ? options.scopes.filter((scope) => typeof scope === "string" && scope.length > 0)
      : DEFAULT_REFRESH_SCOPES;
  let includeScope = true;

  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    options.signal?.throwIfAborted();
    let resp;
    // A single AbortSignal.timeout() created outside the loop starts counting at
    // creation, so a slow first attempt would leave the retries with no budget
    // and turn a 3-attempt policy into a 1-attempt one. A caller that supplies
    // its own signal is explicitly bounding the whole operation, retries
    // included, so that one is shared on purpose.
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    try {
      resp = await fetch(
        OAUTH_TOKEN_URL,
        tokenRequestInit(
          {
            grant_type: "refresh_token",
            refresh_token: refreshTokenValue,
            client_id:
              typeof options.clientId === "string" && options.clientId.length > 0 ? options.clientId : OAUTH_CLIENT_ID,
            ...(includeScope ? { scope: requestedScopes.join(" ") } : {}),
          },
          signal,
        ),
      );
    } catch (err) {
      options.signal?.throwIfAborted();
      if (attempt < OAUTH_MAX_RETRIES) {
        await sleep(Math.min(500 * 2 ** attempt, 2000), options.signal);
        continue;
      }
      throw err;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const retryAfterMs = getRetryDelayMs(resp, attempt);

      // A grant narrower than the requested scope set is refused with
      // `invalid_scope`. Retry once without `scope` (the server then answers with
      // the original grant). This is not a transient-failure retry, so it does not
      // consume one of the OAUTH_MAX_RETRIES attempts.
      if (includeScope && resp.status === 400 && parseOAuthErrorBody(text).errorCode === "invalid_scope") {
        includeScope = false;
        attempt -= 1;
        continue;
      }

      if (attempt < OAUTH_MAX_RETRIES && isRetryableTokenStatus(resp.status)) {
        await sleep(retryAfterMs, options.signal);
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

    const json = await resp.json();
    const grantedScopes = parseGrantedScopes(json?.scope);
    return grantedScopes ? { ...json, scopes: grantedScopes } : json;
  }
}

/**
 * Check if an account has all required Claude.ai scopes.
 *
 * "Required" means the five-scope base set only. Newer scopes (`user:plugins`
 * and the 2.1.329 additions) are deliberately NOT required: demanding them
 * would invalidate every already-stored token. A legacy account keeps
 * refreshing with its stored grant (or, when none is stored, the default list
 * with the `invalid_scope` fallback) and picks up the wider grant only when the
 * user re-authorises.
 * @param {string[] | undefined} scopes
 * @returns {boolean}
 */
export function hasRequiredScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  // Routed through missingBaseScopes() so the refresh-time check and the
  // headless boot-time check in ./oauth-env.mjs cannot drift apart.
  return missingBaseScopes(scopes).length === 0;
}
