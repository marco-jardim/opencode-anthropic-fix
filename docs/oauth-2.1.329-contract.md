# Claude Code 2.1.329 OAuth Wire Contract

This document is the current contract for the OAuth token layer this plugin
emits. It supersedes the statements in `oauth-2.1.280-contract.md` that its
"Corrections 2026-11-19" section retires, and records what is new in `2.1.329`.
The URLs, client id, authorize parameter order, custom-URL allowlist and local
bases are unchanged from `2.1.280` and stay documented there.

**Evidence base:**

- A live capture of the genuine `2.1.329` login (token exchange, profile, roles
  and bootstrap requests), kept outside the repository. Its structure (header
  names and order, body key order) is pinned in
  `test/fixtures/oauth/genuine-2.1.329-exchange.json`. No secret or value is
  stored there.
- The `2.1.329` and `2.1.280` bundle analyses (axios token calls at `@329 @9220448`
  and `@329 @9221471`, revoke at `@329 @9224120`, axios defaults at `@329 @7415983`
  and `@329 @7428470`).

## 1) Token requests are axios calls

Exchange, refresh and revoke go through axios in both `2.1.280` and `2.1.329`.
The only explicit header is `Content-Type`; axios adds the rest.

- Header order on the wire: `Accept: application/json, text/plain, */*`,
  `Content-Type: application/json`, `User-Agent: axios/1.15.2`, `Content-Length`,
  `Accept-Encoding: gzip, compress, deflate, br`, `Host`, `Connection: close`.
- The plugin sets `Accept`, `Content-Type`, `User-Agent` and `Accept-Encoding`
  in that order. It sets `User-Agent` explicitly because the host `fetch` would
  otherwise send its own.
- There is **no `anthropic-beta`** and no SDK user agent on any token request. The
  SDK (`0.128.0` in `2.1.329`, `0.112.1` in `2.1.280`) is used only by the SDK
  `user_oauth` credentials-file path, which Claude Code's own login never takes.
- Redirects are refused (`maxRedirects: 0`) and only a 2xx response is accepted.
  The plugin sends `redirect: "manual"` and treats any non-2xx response, including
  a 3xx, as a failure.
- Residual signal, not controllable from `fetch`: `Content-Length`, `Host` and
  `Connection` are added by the runtime, with its own casing, position and
  keep-alive behaviour (the genuine capture shows `Connection: close`).

### Exchange body

Key order: `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`,
`state`. `state` is **always** sent. The plugin takes it from the pasted callback
and falls back to the value `authorize()` returned. A pasted state that differs
from the expected one is refused locally (`state_mismatch`) before any request.
If neither source has a state the plugin sends the legacy five-key body and logs
one warning, so a bare pasted code still logs in. That shape is a known
divergence: the genuine client never omits `state`.

The captured `redirect_uri` was a loopback callback (automatic flow); this plugin
uses the manual redirect `https://platform.claude.com/oauth/code/callback`.

### Refresh body

Key order: `grant_type`, `refresh_token`, `client_id`, `scope`. `scope` is the
space-joined stored scope list of the account, otherwise the Claude.ai base
scopes plus `user:plugins`. A legacy account whose grant is narrower is refused
with `invalid_scope`; the plugin then retries once without `scope` (the server
answers with the original grant) and records the granted scopes from the
response. Scopes are persisted per account. An `env` account keeps its
operator-declared scopes in memory only and is never written to disk.

### Revoke

`POST ${TOKEN_URL}/revoke` (`https://platform.claude.com/v1/oauth/token/revoke`),
body `{token, token_type_hint: "refresh_token", client_id}`, 5 s timeout, same
axios headers. In `2.1.329` a revocation counts as acknowledged only when a 2xx
response carries a `request-id` header; the plugin reports it the same way. The
genuine client does not revoke on every logout, so `oauth.revoke_on_logout` stays
off by default, and the plugin never revokes `cc-keychain`, `cc-file` or `env`
accounts.

## 2) Scopes

The authorize URL carries the same de-duplicated union for the console and the
Claude.ai login:

`org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins`

- The authorize host still depends on the mode; the scope string does not.
- `user:plugins` is a normal default. Only an explicit `false` (option or
  `oauth.plugins_scope`) removes it, and that diverges from the genuine client.
- `user:projects:read` and `user:projects:write` appear only in an allowed-extras
  filter in the genuine client and are never part of a login request. The plugin
  cannot send them; `oauth.project_scopes` is deprecated and has no effect.

### New in 2.1.329

The default login set gains `user:privacy_consents:write` and
`org:desktop_config`, in that order after `user:plugins`:

`... user:file_upload user:plugins user:privacy_consents:write org:desktop_config`

The plugin is repointed to the `2.1.329` profile, so `authorize()` takes the profile's
nine `oauthAuthorizeScopes` (`lib/oauth.mjs`) and requests both. An explicit
`extraScopes` option still wins, and `oauth.plugins_scope: false` still removes
`user:plugins`.

## 3) Other `2.1.329` changes that are not implemented

- Profile, validate, roles, organisation and API-key requests now send
  `User-Agent: claude-code/2.1.329`. This plugin does not make those requests
  through the OAuth module.
- New credential slots (`cloudSessionsOauth`, `hybridOauth`, `hybridGatewayAuth`,
  `hybridGatewayIdp`) and new sign-in flows (cloud sessions, hybrid settings).
  Not implemented; the OIDC federation grant also stays out of scope.
- New environment variables (`CLAUDE_CODE_SESSIONS_OAUTH_TOKEN` and others) are
  not read.

## 4) Verification

- `test/conformance/oauth-wire-parity.test.mjs` pins the header set and order,
  the refresh and exchange body key order, the revoke URL and acknowledgement
  rule, and compares the exchange request against the fixture.
- `test/fixtures/oauth/genuine-2.1.329-exchange.json` holds header names and
  order plus body key order only.
