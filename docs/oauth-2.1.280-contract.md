# Claude Code 2.1.280 OAuth Wire Contract

This document is the contract for every OAuth request this plugin emits. It
records what the genuine Claude Code `2.1.280` client does, what it deliberately
does **not** do, and where this plugin knowingly diverges.

**Sole evidence base:** section 13.8 (`OAuth constants, verbatim`) of
`D:\git\claude-code-wire-compat\docs\protocol\versions\claude-code-2.1.280-analysis.md`,
lines 950–1021. That section records byte offsets into the carved `2.1.280`
win32-x64 bundle.

**Rule of this document:** a value with a byte offset is transcribed from the
bundle. A value without one is **not** attested by §13.8 and is marked
`[unattested]`. An `[unattested]` value is either pre-existing plugin behaviour
or a necessary inference, and it is called out so that a future maintainer can
tell a measured constant from a chosen one. Nothing here may be interpolated
from an older release or from another platform's build.

Companion document: [`mimese-http-header-system-prompt.md`](./mimese-http-header-system-prompt.md)
covers `/v1/messages` traffic. This document covers the OAuth token layer only.

---

## 1) Endpoints

Endpoint block, byte `4655440`.

| Constant                  | Value                                                           | Offset    | Used by                        |
| ------------------------- | --------------------------------------------------------------- | --------- | ------------------------------ |
| `BASE_API_URL`            | `https://api.anthropic.com`                                     | `4655440` | API key creation               |
| `CONSOLE_AUTHORIZE_URL`   | `https://platform.claude.com/oauth/authorize`                   | `4655440` | console (`org:create_api_key`) |
| `CLAUDE_AI_AUTHORIZE_URL` | `https://claude.com/cai/oauth/authorize`                        | `4655440` | consumer max/inference login   |
| `CLAUDE_AI_ORIGIN`        | `https://claude.ai`                                             | `4655440` | origin only — not an endpoint  |
| `TOKEN_URL`               | `https://platform.claude.com/v1/oauth/token`                    | `4655440` | exchange, refresh, federation  |
| `API_KEY_URL`             | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` | `4655440` | console API-key mint           |
| `MCP_PROXY_PATH`          | `/v1/toolbox/shttp/mcp/{server_id}`                             | `4655440` | not used by this plugin        |

`CLAUDE_AI_AUTHORIZE_URL` is the load-bearing row. The interactive consumer
authorisation page lives on **`claude.com/cai/`**, not on `claude.ai`.
`CLAUDE_AI_ORIGIN` remains `https://claude.ai` and is a **distinct value**; the
two must never be collapsed into one constant.

### 1.1) Values this plugin uses that §13.8 does not attest

| Constant             | Value                                             | Status         | Note                                                              |
| -------------------- | ------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `OAUTH_REDIRECT_URI` | `https://platform.claude.com/oauth/code/callback` | `[unattested]` | Pre-existing plugin value. §13.8 records no redirect URI.         |
| `CLIENT_ID`          | `9d1c250a-e61b-44d9-88ed-5944d1962f5e`            | attested       | §13.8 states it is "unchanged" at this value; no discrete offset. |

---

## 2) Request fingerprints

Each row below is a contract row. Section 5.2 of the parity plan requires exactly
one conformance assertion per row, enforced by a meta-test.

### 2.1) `authorize` — interactive authorisation URL

| Field            | Value                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Method           | none — a URL handed to a browser, not an HTTP request this client makes                                           |
| URL (consumer)   | `https://claude.com/cai/oauth/authorize`                                                                          |
| URL (console)    | `https://platform.claude.com/oauth/authorize`                                                                     |
| Query parameters | `code`, `client_id`, `response_type`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method`, `state` |
| PKCE             | `S256`, verifier = 32 random bytes base64url                                                                      |

**Attestation:** the two URLs are attested at byte `4655440`. The query parameter
**set and order** are `[unattested]` — §13.8 records no authorize query string.
They are pre-existing plugin behaviour and are preserved unchanged, because a
change without evidence would be a guess.

### 2.2) `exchange` — authorization-code grant

| Field     | Value                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Method    | `POST`                                                                                                |
| URL       | `https://platform.claude.com/v1/oauth/token`                                                          |
| Header 1  | `Content-Type: application/json`                                                                      |
| Header 2  | `anthropic-beta: oauth-2025-04-20`                                                                    |
| Header 3  | `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`                                      |
| Body keys | `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, and `state` **only when present** |

**Attestation:** the URL and the three header names/values are attested at bytes
`4655440`, `4418342` and `4429828`. §13.8 describes the header set for the
**refresh** request; the exchange request is `[unattested]` as a body shape and
inherits the same header triple because both grants run through the same
`userOAuthProvider` in the same SDK. The body key set is pre-existing plugin
behaviour.

### 2.3) `refresh` — refresh-token grant

| Field     | Value                                                                |
| --------- | -------------------------------------------------------------------- |
| Method    | `POST`                                                               |
| URL       | `https://platform.claude.com/v1/oauth/token`                         |
| Header 1  | `Content-Type: application/json`                                     |
| Header 2  | `anthropic-beta: oauth-2025-04-20`                                   |
| Header 3  | `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`     |
| Body keys | `grant_type`, `refresh_token`, `client_id` — **exactly these three** |

**The refresh body has no `scope` key.** This is stated explicitly at byte
`4429828`: the body is `{ grant_type, refresh_token, client_id }`, "**no `scope`
field**". Emitting `scope` on refresh is a positive fingerprint: no genuine
`2.1.280` client sends it.

### 2.4) `federation` — OIDC JWT-bearer grant

Byte `4427476`.

| Field        | Value                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| Method       | `POST`                                                                                                             |
| URL          | `https://platform.claude.com/v1/oauth/token`                                                                       |
| Header 1     | `Content-Type: application/json`                                                                                   |
| Header 2     | `anthropic-beta: oauth-2025-04-20,oidc-federation-2026-04-01`                                                      |
| Header 3     | `User-Agent: anthropic-sdk-typescript/0.112.1 oidcFederationProvider`                                              |
| Body (req'd) | `grant_type` = `urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion`, `federation_rule_id`, `organization_id` |
| Body (opt.)  | `service_account_id`, `workspace_id` — emitted **only when supplied**, never as `undefined`                        |

The `anthropic-beta` value is a **single comma-joined string with no space**
between the two beta names.

### 2.5) Header ordering

§13.8 lists the refresh headers in the order `Content-Type`, `anthropic-beta`,
`User-Agent`, and the federation headers in the same relative order. This
document adopts that as the canonical emission order. **Status:
`[unattested-order]`** — the listing order in the analysis prose is strong
evidence but is not an independent byte-level proof of serialisation order. The
implementation builds the header object literal in this order and never sorts it,
so the emitted order is deterministic and matches the evidence.

---

## 3) SDK constants

Byte `4418342`, with the version string at byte `4407908`.

| Constant                  | Value                                                     | Offset    |
| ------------------------- | --------------------------------------------------------- | --------- |
| SDK version               | `0.112.1`                                                 | `4407908` |
| User-Agent (interactive)  | `anthropic-sdk-typescript/0.112.1 userOAuthProvider`      | `4429828` |
| User-Agent (federation)   | `anthropic-sdk-typescript/0.112.1 oidcFederationProvider` | `4427476` |
| `grant_type` (refresh)    | `refresh_token`                                           | `4418342` |
| `grant_type` (federation) | `urn:ietf:params:oauth:grant-type:jwt-bearer`             | `4418342` |
| Token path                | `/v1/oauth/token`                                         | `4418342` |
| Beta (oauth)              | `oauth-2025-04-20`                                        | `4418342` |
| Beta (federation)         | `oidc-federation-2026-04-01`                              | `4418342` |
| Expiry skew (seconds)     | `30`                                                      | `4418342` |
| Assertion size limit      | `1048576` guard, `16384` **enforced**                     | `4418342` |

`0.112.1` is the same `var ne = "0.112.1"` that feeds
`X-Stainless-Package-Version`, and it is the only such declaration in the dump.

The SDK appends `oauth-2025-04-20` to `anthropic-beta` on **every** request when
a token cache is present and no API key is set (byte `4541482`).

---

## 4) Scopes

Byte `4654950`.

### 4.1) Base sets

| Mode      | Scopes, in order                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------- |
| console   | `org:create_api_key`, `user:profile`                                                                  |
| claude.ai | `user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload` |

**Order is wire-visible.** The list is space-joined into the `scope` query
parameter, so re-ordering or sorting changes the emitted bytes.

### 4.2) Conditional extensions

| Scope                 | Gating condition                                                   |
| --------------------- | ------------------------------------------------------------------ |
| `user:plugins`        | **appended** when the `PLUGINS_SCOPE_REGISTERED` gate is on        |
| `user:projects:read`  | appended only when **requested** _and_ present in the allowed list |
| `user:projects:write` | appended only when **requested** _and_ present in the allowed list |

Both extensions are **appended**, never inserted into the base set. The base set
order is therefore invariant under any gating.

---

## 5) Environment variables

| Variable                          | Default                 | Offset         | Behaviour                                                              |
| --------------------------------- | ----------------------- | -------------- | ---------------------------------------------------------------------- |
| `CLAUDE_LOCAL_OAUTH_APPS_BASE`    | `http://localhost:4000` | `4656690`      | local-dev apps base                                                    |
| `CLAUDE_LOCAL_OAUTH_CONSOLE_BASE` | `http://localhost:3000` | `4656690`      | local-dev console base                                                 |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL`    | unset                   | `4657393`      | validated against the allowlist in §5.1; **throws** on any other value |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | unset                   | `[unattested]` | headless login seed; see §5.2                                          |
| `CLAUDE_CODE_OAUTH_SCOPES`        | unset                   | `[unattested]` | space-separated scope list, used verbatim; see §5.2                    |
| `CLAUDE_CODE_OAUTH_CLIENT_ID`     | unset                   | `[unattested]` | overrides `CLIENT_ID`; see §5.2                                        |

### 5.1) `CLAUDE_CODE_CUSTOM_OAUTH_URL` allowlist

Exactly three entries, byte `4657393`, in bundle order:

1. `https://beacon.claude-ai.staging.ant.dev`
2. `https://claude.fedstart.com`
3. `https://claude-staging.fedstart.com`

Any other value throws, with this exact message:

```text
CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.
```

Comparison is **exact string equality** against the configured value. The
implementation must not normalise, lowercase, strip a trailing slash, or parse
and re-serialise the URL: every one of those widens the allowlist beyond what the
genuine client accepts, turning a security control into a suggestion.

### 5.2) Headless-login variables — attestation status

`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES` and
`CLAUDE_CODE_OAUTH_CLIENT_ID` are **`[unattested]`**: §13.8 does not record them.
They are carried in the parity plan as a headless-login surface. They are
implemented as a **local capability**, not as a parity claim, and are therefore
also listed in §7 (Divergences). No request they produce differs in shape from
the attested refresh fingerprint in §2.3.

---

## 6) What the genuine client does NOT do

This section is the reason this document exists. An absence is as load-bearing as
a presence, and it is the thing a future maintainer will otherwise helpfully
re-add.

1. **It does not revoke tokens.** `/v1/oauth/revoke` **appears nowhere in the
   2.1.280 bundle** (§13.8, closing paragraph). Any `POST` to a revoke endpoint
   is a request no genuine client emits and is therefore a positive fingerprint.
2. **It does not send `scope` on refresh.** The refresh body is exactly
   `{ grant_type, refresh_token, client_id }` (byte `4429828`).
3. **It does not use axios.** The OAuth token client is the Anthropic TS SDK's
   native-`fetch` `userOAuthProvider`. There is no `axios/` User-Agent and no
   axios `Accept: application/json, text/plain, */*` header anywhere in the
   `2.1.280` OAuth path.
4. **It does not send SDK version `0.94.0`.** `0.112.1` is the only version
   declaration in the dump (byte `4407908`).
5. **It does not authorise on `claude.ai/oauth/authorize`.** The consumer
   authorisation page is `https://claude.com/cai/oauth/authorize`.
6. **It does not accept an arbitrary `CLAUDE_CODE_CUSTOM_OAUTH_URL`.** Three
   values are approved; everything else throws.
7. **It does not refresh a federated credential with the `refresh_token`
   grant.** Federation is a separate, non-interactive grant; a federated
   credential is renewed by re-running the JWT-bearer exchange.

---

## 7) Divergences this plugin knowingly keeps

Each row is a deliberate, justified departure from §6. A row with no
justification is a defect, not a divergence.

| #   | Divergence                 | Justification |
| --- | -------------------------- | ------------- |
|     | _(populated by Waves 1–5)_ |               |

---

## 8) Change control

- Every constant in §1–§5 is pinned by a literal assertion in
  `lib/oauth-constants.test.mjs`. A test that compares an import to itself proves
  nothing; the test re-writes the literal.
- Every row of §2 maps to exactly one assertion in
  `test/conformance/oauth-wire-parity.test.mjs`, enforced by a meta-test that
  fails when a row gains no assertion.
- Changing any value here requires a matching byte offset in a
  `claude-code-wire-compat` analysis document. A value without an offset is
  marked `[unattested]` and stays marked.
