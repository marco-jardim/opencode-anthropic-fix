# Claude Code 2.1.280 OAuth Wire Contract

This document is the **target** contract for every OAuth request this plugin
emits. It records what the genuine Claude Code `2.1.280` client is attested to
do, what it is attested **not** to do, and where this plugin knowingly diverges.
Until every wave of the parity plan has landed, §7 lists the divergences that are
still open; the plugin's current behaviour is therefore §2 **plus** §7, not §2
alone.

**Sole evidence base:** section 13.8 (`OAuth constants, verbatim`) of
`D:\git\claude-code-wire-compat\docs\protocol\versions\claude-code-2.1.280-analysis.md`,
lines 950–1021. That section records byte offsets into a carved `2.1.280` bundle.
§13.8 does not state the bundle's platform, so this document does not claim one.

## Attestation vocabulary

Three levels, and the level is always stated:

| Marking              | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| _offset_             | §13.8 gives a byte offset for this exact value. Strongest.                                   |
| _prose_              | §13.8 asserts the value in prose inside an offset-bearing paragraph, without its own offset. |
| `[unattested]`       | §13.8 does not record it. Pre-existing plugin behaviour or a necessary inference.            |
| `[unattested-order]` | The constituent values are attested; their **order** is taken from the analysis prose only.  |
| `[unattested-bind]`  | The **string** is attested; which request uses it is not.                                    |

An `[unattested]` value is not a defect — an unmarked one is. Nothing here may be
interpolated from an older release or from another platform's build.

Companion document: [`mimese-http-header-system-prompt.md`](./mimese-http-header-system-prompt.md)
covers `/v1/messages` traffic. This document covers the OAuth token layer only.

---

## 1) Endpoints

Endpoint block, byte `4655440`. Every string in this table is offset-attested.
The "Used by" column is **plugin-side inference**, not evidence: §13.8 records
the constants, not their consumers.

| Constant                  | Value                                                           | Offset    | Used by (inferred)                           |
| ------------------------- | --------------------------------------------------------------- | --------- | -------------------------------------------- |
| `BASE_API_URL`            | `https://api.anthropic.com`                                     | `4655440` | unknown — `API_KEY_URL` is absolute          |
| `CONSOLE_AUTHORIZE_URL`   | `https://platform.claude.com/oauth/authorize`                   | `4655440` | console (`org:create_api_key`)               |
| `CLAUDE_AI_AUTHORIZE_URL` | `https://claude.com/cai/oauth/authorize`                        | `4655440` | consumer max/inference login                 |
| `CLAUDE_AI_ORIGIN`        | `https://claude.ai`                                             | `4655440` | origin value — no consumer in §13.8          |
| `TOKEN_URL`               | `https://platform.claude.com/v1/oauth/token`                    | `4655440` | exchange, refresh, federation — but see §2.6 |
| `API_KEY_URL`             | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` | `4655440` | not used by this plugin                      |
| `MCP_PROXY_PATH`          | `/v1/toolbox/shttp/mcp/{server_id}`                             | `4655440` | not used by this plugin                      |

`CLAUDE_AI_AUTHORIZE_URL` is the load-bearing row. The interactive consumer
authorisation page lives on **`claude.com/cai/`**, not on `claude.ai`.
`CLAUDE_AI_ORIGIN` remains `https://claude.ai` and is a **distinct value**; the
two must never be collapsed into one constant.

### 1.1) Values this plugin uses that §13.8 does not offset-attest

| Constant             | Value                                             | Status         | Note                                                                                    |
| -------------------- | ------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `OAUTH_REDIRECT_URI` | `https://platform.claude.com/oauth/code/callback` | `[unattested]` | Pre-existing plugin value. §13.8 records no redirect URI.                               |
| `CLIENT_ID`          | `9d1c250a-e61b-44d9-88ed-5944d1962f5e`            | _prose_        | Asserted "unchanged" inside the scopes paragraph at byte `4654950`; no discrete offset. |

---

## 2) Request fingerprints

Each row below is a contract row. The conformance meta-test (§8) requires exactly
one assertion per **attested** row. `[unattested]` rows are excluded from that
requirement by construction: pinning a guess as if it were a measurement is the
failure mode this vocabulary exists to prevent.

### 2.1) `authorize` — interactive authorisation URL

| Field            | Value                                                                                                             | Status         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| Method           | none — a URL handed to a browser, not an HTTP request this client makes                                           | —              |
| URL (consumer)   | `https://claude.com/cai/oauth/authorize`                                                                          | _offset_       |
| URL (console)    | `https://platform.claude.com/oauth/authorize`                                                                     | _offset_       |
| Query parameters | `code`, `client_id`, `response_type`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method`, `state` | `[unattested]` |
| PKCE             | `S256`, verifier = 32 random bytes base64url                                                                      | `[unattested]` |

**Attestation:** only the two URLs are attested (byte `4655440`). §13.8 records
no authorize query string and no PKCE material whatsoever. The query parameter
set, its order, and the PKCE parameters are pre-existing plugin behaviour and are
preserved unchanged, because changing them without evidence would be a guess
dressed as a fix.

### 2.2) `exchange` — authorization-code grant

| Field     | Value                                                                                                 | Status              |
| --------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| Method    | `POST`                                                                                                | `[unattested]`      |
| URL       | `https://platform.claude.com/v1/oauth/token`                                                          | `[unattested-bind]` |
| Header 1  | `Content-Type: application/json`                                                                      | `[unattested]`      |
| Header 2  | `anthropic-beta: oauth-2025-04-20`                                                                    | `[unattested]`      |
| Header 3  | `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`                                      | `[unattested]`      |
| Body keys | `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, and `state` **only when present** | `[unattested]`      |

**Attestation — read this before citing the row.** §13.8's SDK constant block at
byte `4418342` enumerates exactly two grant types, `refresh_token` and
`urn:ietf:params:oauth:grant-type:jwt-bearer`. **There is no `authorization_code`
constant anywhere in §13.8, and no offset locates the code-exchange call site.**
The header triple above is therefore an **assumption**: that the exchange runs
through the same `userOAuthProvider` as the refresh. That assumption is not
supported by §13.8 and byte `4429828` — which records the **refresh** site — must
not be cited as attesting it.

The assumption is nonetheless the one this plugin implements, for a reason worth
stating: if the exchange does run through the same provider, emitting the same
triple is parity; if it does not, emitting the same triple is still closer to any
plausible genuine shape than the axios fingerprint it replaces. This row is
excluded from the §8 meta-test until an offset for the exchange call site exists.

### 2.3) `refresh` — refresh-token grant

| Field     | Value                                                                | Status              |
| --------- | -------------------------------------------------------------------- | ------------------- |
| Method    | `POST`                                                               | _prose_ (`4429828`) |
| URL       | `https://platform.claude.com/v1/oauth/token`                         | `[unattested-bind]` |
| Header 1  | `Content-Type: application/json`                                     | _offset_            |
| Header 2  | `anthropic-beta: oauth-2025-04-20`                                   | _offset_            |
| Header 3  | `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`     | _offset_            |
| Body keys | `grant_type`, `refresh_token`, `client_id` — **exactly these three** | _offset_            |

**The refresh body has no `scope` key.** Stated explicitly at byte `4429828`: the
body is `{ grant_type, refresh_token, client_id }`, "**no `scope` field**".
Emitting `scope` on refresh is a positive fingerprint: no genuine `2.1.280`
client sends it.

### 2.4) `federation` — OIDC JWT-bearer grant — **NOT IMPLEMENTED BY THIS PLUGIN**

Byte `4427476`.

**Scope note.** This plugin does not implement the OIDC federation grant and
emits no request of this shape. The row is retained because the contract's job is
to record what the genuine client does, and an omitted grant is exactly the kind
of fact a future maintainer needs in order to add it correctly. It is exempt from
the §8 conformance meta-test — there is no request to assert against — and the
omission is recorded as divergence **D12**. The corresponding constants are
deliberately absent from `lib/oauth-constants.mjs`; re-transcribe them from this
table if the grant is ever implemented.

| Field        | Value                                                                                                              | Status              |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Method       | `POST`                                                                                                             | _prose_ (`4427476`) |
| URL          | `https://platform.claude.com/v1/oauth/token`                                                                       | `[unattested-bind]` |
| Header 1     | `Content-Type: application/json`                                                                                   | `[unattested]`      |
| Header 2     | `anthropic-beta: oauth-2025-04-20,oidc-federation-2026-04-01`                                                      | _offset_            |
| Header 3     | `User-Agent: anthropic-sdk-typescript/0.112.1 oidcFederationProvider`                                              | _offset_            |
| Body (req'd) | `grant_type` = `urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion`, `federation_rule_id`, `organization_id` | _offset_            |
| Body (opt.)  | `service_account_id`, `workspace_id` — present **only when supplied**                                              | _offset_            |

`Content-Type` is marked `[unattested]` deliberately: §13.8's federation
paragraph lists the body, `anthropic-beta` and `User-Agent`, and **does not list
a `Content-Type`**. The plugin sends `application/json` because the body is JSON,
which is an inference, not a measurement.

The `anthropic-beta` value is a **single comma-joined string with no space**
between the two beta names.

§13.8 marks `service_account_id` and `workspace_id` optional (`?`). The
implementation builds them with conditional spreads so the keys are absent rather
than present-and-null; JSON cannot serialise `undefined` in any case, so the
requirement is about key **presence**, not about a literal `undefined`.

### 2.5) Header ordering

**Status: `[unattested-order]` for both requests.**

- Refresh (`4429828`): §13.8 lists `Content-Type`, `anthropic-beta`,
  `User-Agent`, in that prose order.
- Federation (`4427476`): §13.8 lists only `anthropic-beta` then `User-Agent`.
  `Content-Type` is not listed at this site at all, so no order is attested for
  it; the implementation places it first to match the refresh shape.

Prose listing order is **not** proof of serialisation order. This document adopts
it as the canonical emission order because a deterministic order chosen from the
evidence beats an accidental one, not because the evidence proves it. The
implementation builds each header object literal in the stated order and never
sorts it, so the emitted order is at least stable and reviewable.

### 2.6) Host binding is not attested

§13.8 records **two different things** that both look like the token endpoint:

- an application-level absolute `TOKEN_URL` = `https://platform.claude.com/v1/oauth/token`
  at byte `4655440`, and
- an SDK-level **relative** `path` = `/v1/oauth/token` at byte `4418342`.

A relative path implies the SDK composes `<base> + path`, and §13.8 never states
what that `<base>` is. The only base constant it records is
`BASE_API_URL` = `https://api.anthropic.com`, which is a **different host**. The
host is wire-visible via SNI and the `Host` header, so this is not a cosmetic
gap.

**Resolution:** the plugin keeps `https://platform.claude.com/v1/oauth/token`,
the absolute string §13.8 actually attests, and marks the binding
`[unattested-bind]` in §2.2–§2.4. Switching the host to `api.anthropic.com` on
the strength of a relative path and an unrelated base constant would be exactly
the kind of interpolation this document forbids. Closing this gap requires a new
offset locating the provider's base-URL configuration.

---

## 3) SDK constants

Byte `4418342`, with the version string at byte `4407908`.

| Constant                            | Value                                                     | Offset    |
| ----------------------------------- | --------------------------------------------------------- | --------- |
| SDK version                         | `0.112.1`                                                 | `4407908` |
| User-Agent (userOAuthProvider)      | `anthropic-sdk-typescript/0.112.1 userOAuthProvider`      | `4429828` |
| User-Agent (oidcFederationProvider) | `anthropic-sdk-typescript/0.112.1 oidcFederationProvider` | `4427476` |
| `grant_type` (refresh)              | `refresh_token`                                           | `4418342` |
| `grant_type` (federation)           | `urn:ietf:params:oauth:grant-type:jwt-bearer`             | `4418342` |
| Token path (relative — see §2.6)    | `/v1/oauth/token`                                         | `4418342` |
| Beta (oauth)                        | `oauth-2025-04-20`                                        | `4418342` |
| Beta (federation)                   | `oidc-federation-2026-04-01`                              | `4418342` |
| Expiry skew (seconds)               | `30`                                                      | `4418342` |
| Assertion size limit                | `1048576` guard, `16384` **enforced**                     | `4418342` |

The `userOAuthProvider` user-agent is attested at the **refresh** site
(`4429828`), which is non-interactive. It is labelled by provider name rather
than by "interactive" so that no reader infers it was measured on the
authorization-code exchange — it was not (§2.2).

`0.112.1` is the same `var ne = "0.112.1"` that feeds
`X-Stainless-Package-Version`, and §13.8 calls it the only **such** declaration
in the dump — that is, the only SDK-version declaration. The dump necessarily
contains other version strings, `2.1.280` among them.

### 3.1) `X-Stainless-*` headers on token requests: `[unattested]`

The sentence above attests that an `X-Stainless-Package-Version` header exists
somewhere in the bundle and is fed by `0.112.1`. §13.8 does **not** say whether
token requests carry it or any other `X-Stainless-*` header. The header tables in
§2.3 and §2.4 are therefore **lower bounds**, not closed sets: they record the
headers §13.8 lists, and the conformance suite asserts the **presence and values
of those headers**, never the **absence** of headers §13.8 is silent about.

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

**Array order is offset-attested** at `4654950`. The **serialisation** — a
space-join into a `scope` query parameter — is `[unattested]`, for the same
reason the authorize query string is (§2.1): §13.8 records the arrays, not the
URL they end up in. The plugin space-joins, which is the OAuth 2.0 norm and is
what it already did before this contract existed.

Given that serialisation, array order is wire-visible, so the implementation
preserves it and never sorts.

### 4.2) Conditional extensions

| Scope                 | Gating condition                                                   | Genuine-client default |
| --------------------- | ------------------------------------------------------------------ | ---------------------- |
| `user:plugins`        | **appended** when the `PLUGINS_SCOPE_REGISTERED` gate is on        | `[unattested]`         |
| `user:projects:read`  | appended only when **requested** _and_ present in the allowed list | `[unattested]`         |
| `user:projects:write` | appended only when **requested** _and_ present in the allowed list | `[unattested]`         |

Both extensions are **appended**, never inserted into the base set, so the base
set order is invariant under any gating.

§13.8 records neither the default state of `PLUGINS_SCOPE_REGISTERED` nor the
contents of "the allowed list".

**What §13.8 does _not_ fix is the order _among_ the extensions**
(`[unattested-order]`). It attests the extension names and their gating
conditions; it does not say whether `user:plugins` precedes or follows the
project scopes when both gates fire, nor whether `user:projects:read` precedes
`user:projects:write`. This plugin chooses base → `user:plugins` → `read` →
`write`, so with both gates on it emits:

```
user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins user:projects:read user:projects:write
```

That eight-scope string is wire-visible and is this plugin's assumption, not a
transcription. It is recorded as divergence **D13** and is reachable only by
explicit opt-in.

**What this plugin emits by default:** the base set only. `user:plugins` requires
`oauth.plugins_scope: true`; the project scopes require an explicit
`oauth.project_scopes` entry. Both default off, which makes the default emitted
scope string byte-identical to the pre-contract one. Because the genuine
client's default is unattested, defaulting these **on** would be an unforced
fingerprint risk; defaulting them **off** is the conservative choice and is
recorded as such in §7.

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

Exactly three entries, byte `4657393`. The order below is the order the analysis
prose lists them in; §13.8 does not attest a bundle ordering, and nothing in the
implementation depends on the order.

1. `https://beacon.claude-ai.staging.ant.dev`
2. `https://claude.fedstart.com`
3. `https://claude-staging.fedstart.com`

Any non-approved value throws, with this exact message:

```text
CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.
```

**Comparison semantics are `[unattested]`.** §13.8 says the value is "validated
against a three-entry allowlist … and otherwise throws"; it does not say whether
the check is equality, prefix, or origin matching. This plugin uses **exact
string equality** and does not normalise, lowercase, strip a trailing slash, or
parse and re-serialise the URL. That is the **narrowest** reading of the
evidence: every relaxation would admit values the genuine client might reject,
and a security control that is wrong in the permissive direction is worse than
one that is wrong in the strict direction.

Whether an unset or empty value short-circuits validation is also `[unattested]`.
This plugin treats absent, empty and whitespace-only as "not configured" and
performs no validation, because throwing on an unset variable would break every
login that does not use the feature.

### 5.2) Headless-login variables — attestation status

`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES` and
`CLAUDE_CODE_OAUTH_CLIENT_ID` are **`[unattested]`**: §13.8 does not record them.
They are a **local capability**, not a parity claim, and are recorded as such in
§7.

Two consequences, because "same shape" is not "same bytes":

- `CLAUDE_CODE_OAUTH_SCOPES` is consumed **only** at authorize time and when
  seeding an env account's recorded scope list. It never reaches a refresh body:
  that would contradict §2.3 and §6.2.
- `CLAUDE_CODE_OAUTH_CLIENT_ID` changes a **wire value** (`client_id`) in the
  token body. A request made with it is not byte-identical to a genuine one. That
  is the point of the variable and is the user's explicit choice, but it is a
  divergence and is listed in §7 rather than waved through.

---

## 6) What the genuine client does NOT do

This section is the reason this document exists. An absence is as load-bearing as
a presence, and it is the thing a future maintainer will otherwise helpfully
re-add. Each claim is scoped to what §13.8 actually supports.

1. **It does not have a `/v1/oauth/revoke` endpoint.** That literal path
   **appears nowhere in the 2.1.280 bundle** (§13.8, closing paragraph), and the
   analysis concludes "the genuine client does not revoke". Scoped precisely:
   the evidence is the absence of that literal, so a `POST` to it is a request no
   genuine client emits. §13.8 does not enumerate every path the client might
   use, so this is not a claim that no revocation mechanism of any kind exists.
2. **It does not send `scope` on refresh.** The refresh body is exactly
   `{ grant_type, refresh_token, client_id }` (byte `4429828`).
3. **Its attested OAuth user-agents are SDK user-agents, not `axios/…`.** Stated
   as a positive, which is all the evidence supports: at byte `4429828` the
   refresh sends `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`
   and at byte `4427476` the federation exchange sends
   `…/0.112.1 oidcFederationProvider`. §13.8 lists **no `Accept` header** at
   either site. It does not name a transport, so "does not use axios" is not
   something this document can assert; what it can assert is that the two
   attested sites do not send an `axios/…` user-agent and that this plugin's
   `axios/1.13.6` + `Accept: application/json, text/plain, */*` pair matches
   nothing in §13.8. The exchange site is not covered at all (§2.2).
4. **It does not send SDK version `0.94.0`.** `0.112.1` is the only SDK-version
   declaration in the dump (byte `4407908`).
5. **It does not authorise on `claude.ai/oauth/authorize`.** The consumer
   authorisation page is `https://claude.com/cai/oauth/authorize` (byte
   `4655440`).
6. **It does not accept an arbitrary `CLAUDE_CODE_CUSTOM_OAUTH_URL`.** Three
   values are approved; everything else throws (byte `4657393`).

### 6.1) Federated-credential renewal is `[unattested]` — and moot here

**This plugin does not implement federation at all (§2.4, D12), so nothing below
governs any request it makes.** The subsection is kept as guidance for a future
implementer, because the uncertainty it records is the first thing such an
implementer would otherwise rediscover the hard way.

§13.8 describes federation as "a separate, non-interactive path for service
accounts and CI" and records its request shape. It records **nothing** about the
federation token response: not whether it contains a `refresh_token`, not how
renewal happens. Any claim that a federated credential "cannot" be refreshed with
the `refresh_token` grant would be an invention.

**Guidance if federation is ever implemented:** renew by re-running the
JWT-bearer exchange and never route a federated credential into `refreshToken()`.
That would be a **design choice under uncertainty**, not a parity claim: the
re-exchange path is attested as the way to obtain a federated token, whereas
sending a federation-issued token to the `refresh_token` grant is unattested in
both directions.

---

## 7) Divergences this plugin knowingly keeps

Each row is a deliberate, justified departure, or a behaviour that is not attested
either way. A row with no justification is a defect, not a divergence. The
"Status" column tracks which are still open.

| #   | Divergence                                                                                 | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                         |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| D1  | `POST /v1/oauth/revoke` on logout                                                          | Contradicts §6.1. Becomes opt-in and off-by-default rather than being deleted, so users relying on the security affordance keep it by explicit choice. The request shape is **unverified**: §13.8 has no revoke endpoint, so nothing attests that the server accepts a JSON body (RFC 7009 §2.1 mandates form encoding) or this user-agent. Sending the SDK triple rather than the retired axios triple is a **judgement call, not a parity claim** — a `userOAuthProvider` user-agent on a path the SDK never calls is arguably a stronger tell than a neutral one, but the axios pair is a known-wrong fingerprint on every other request and keeping two shapes in one module is worse.      | closed Wave 1 — opt-in         |
| D2  | `User-Agent: axios/1.13.6` + `Accept: application/json, text/plain, */*` on token requests | Matches nothing in §13.8 (§6.3). The code path is removed; the config key survives as inert so existing config files keep loading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | closed Wave 1                  |
| D3  | SDK version `0.94.0` in the OAuth user-agent                                               | Contradicts §6.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | closed Wave 1                  |
| D4  | Authorize host `https://claude.ai/oauth/authorize`                                         | Contradicts §6.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | closed Wave 1                  |
| D5  | `scope` key in the refresh body                                                            | Contradicts §6.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | closed Wave 1                  |
| D6  | Token-endpoint host kept at `platform.claude.com` despite the unresolved base/path split   | §2.6. The absolute string is attested; the SDK's base is not. Keeping the attested string is the narrower error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | permanent until new evidence   |
| D7  | `Content-Type: application/json` on the federation request                                 | §2.4. Not listed at byte `4427476`; inferred from the JSON body. **Moot while D12 stands** — no federation request is made.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | superseded by D12              |
| D8  | Exchange request reuses the refresh header triple                                          | §2.2. No `authorization_code` grant or call site exists in §13.8. Closest plausible shape, explicitly marked as an assumption and excluded from the meta-test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | permanent until new evidence   |
| D9  | Conditional scopes default **off**                                                         | §4.2. The genuine default is unattested; defaulting on would add an unforced fingerprint. Default-off also keeps the emitted scope string unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | permanent until new evidence   |
| D10 | `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` / `_SCOPES` / `_CLIENT_ID` headless login                | §5.2. Local capability, unattested in §13.8. `_CLIENT_ID` changes a wire value by the user's explicit choice. A **missing** `_SCOPES` is a hard error, because the operator — not this plugin — knows which scopes the injected token carries and a default would be an invention. An **incomplete** `_SCOPES` only warns: completeness checking is this plugin's own idea, and refusing to start over it would take every unrelated stored account down with it. The declared list is used verbatim, at boot only, and never reaches a refresh body.                                                                                                                                           | permanent — local feature      |
| D11 | Federated credentials renewed by re-exchange rather than by `refresh_token`                | §6.1. Design choice under uncertainty; the re-exchange path is attested, the alternative is unattested in both directions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | superseded by D12              |
| D13 | Order among the conditional scope extensions, and the space-join that serialises them      | §4.2. §13.8 attests the extension names and their gating conditions, not their relative position; it attests the base arrays, not their serialisation into a `scope` parameter. This plugin chooses base → `user:plugins` → `user:projects:read` → `user:projects:write`, space-joined. Both choices are wire-visible. They are reachable only by explicit opt-in, so the default emitted string is unaffected, and the chosen order matches the order §13.8 itself enumerates the extensions in — the weakest available basis, recorded as a choice rather than dressed up as a measurement.                                                                                                   | permanent until new evidence   |
| D12 | **The OIDC federation grant is not implemented.** No JWT-bearer request is ever emitted.   | Deliberate scope decision. Federation is a distinct authentication surface for service accounts and CI, not an enhancement of the interactive flow, and this plugin's users authenticate interactively. Implementing an unused grant would add a maintained code path, a second credential lifecycle, and a set of constants with no consumer — cost with no delivered value. §2.4 and §3's federation constants are recorded here so the grant can be added correctly later; they are absent from `lib/oauth-constants.mjs` by design, enforced by a test that fails if any `OIDC_*` export appears. Consequence: drift row 10 of the parity plan is **not** closed, and is not claimed to be. | permanent — scope              |
| D14 | `CLAUDE_CODE_CUSTOM_OAUTH_URL` is **validated but not consumed**                           | §5.1. §13.8 (byte 4657393) attests that the variable is checked against a three-entry allowlist and that an unapproved value **throws**. It does not attest what an **approved** value is then used for. `authorize()` therefore runs the guard — the attested half — and leaves the endpoint constants standing. Redirecting the flow to the approved value would be inventing a behaviour the evidence does not record; throwing on an unapproved one is the security control the evidence does record, and shipping the module without a caller would have been a guard that never runs.                                                                                                     | until the use site is attested |
| D15 | `CLAUDE_LOCAL_OAUTH_*_BASE` must name a loopback origin                                    | §5. §13.8 records the two variables and their `localhost` defaults but nothing about validation. Accepting an arbitrary value would let anything that can set one environment variable redirect a production OAuth flow to a host of its choosing — the exact class of defect the `CLAUDE_CODE_CUSTOM_OAUTH_URL` allowlist exists to prevent, reachable through a variable that has no allowlist. Restricting them to `http://localhost`, `http://127.0.0.1` or `http://[::1]` (optionally with a port) is the narrowest reading of "LOCAL". The guard is `[unattested]` and is a deliberate hardening, not a parity claim.                                                                     | permanent — hardening          |
| D16 | A rotated refresh token for an env-seeded account is **not persisted**                     | §5.2. The credential is process-lifetime by design (D10), so a successor the server issues mid-session is written nowhere and the next start re-seeds the retired value from the environment. Persisting it would turn an environment variable into a stored secret the operator never asked for, which is the property that makes headless injection safe. The failure is therefore made loud rather than silent: the first rotation warns once, naming the variable to update. Whether the genuine server rotates these tokens at all is `[unattested]`.                                                                                                                                      | permanent — by design          |

---

## 7.1) Known open signals

A divergence in §7 is a value this plugin deliberately sends differently. An
**open signal** is different: it is a way the two clients could still be told
apart that this plugin does not control, cannot currently verify, or has not yet
closed. Listing them is the honest alternative to claiming parity the evidence
does not support.

| #   | Signal                                                                                                                                                  | Why it is open                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Runtime-added request headers — `host`, `connection`, `accept`, `accept-encoding`, `content-length` — their presence, values, casing and relative order | The module controls three headers; the host runtime adds the rest. §13.8 names no transport and no platform, so there is nothing to compare against. The tests inspect the `init` object, not the socket.                                             |
| O2  | Authorize query string: parameter set, order, `code=true`, `S256`, `redirect_uri`, and `URLSearchParams` encoding (`+` for space, `%3A` for colon)      | §2.1. §13.8 records no authorize query string, no redirect URI and no PKCE material. The current values are pre-existing plugin behaviour, pinned by tests as **implementation pins, not evidence**. Closing this needs a captured genuine login URL. |
| O3  | Retry and timeout policy: at most 3 attempts, 250 ms–30 s backoff, `Retry-After` honoured, 15 s exchange / 30 s refresh / 5 s revoke timeouts           | Server-observable. §13.8 says nothing about the provider's retry policy.                                                                                                                                                                              |
| O4  | Refresh trigger timing relative to expiry                                                                                                               | `OAUTH_EXPIRY_SKEW_SECONDS` is attested (30 s, byte `4418342`) but is not consumed until Wave 5. Until then the plugin refreshes on its own schedule.                                                                                                 |
| O5  | Scope-set size, conditional on `PLUGINS_SCOPE_REGISTERED`                                                                                               | §4.2. If the gate ships **on**, every genuine authorize URL carries six scopes and this plugin's five-scope URL is itself the fingerprint. The gate's shipped state is unattested.                                                                    |
| O6  | Exchange body shape varies with user input — 6 keys for a `code#state` paste, 5 for a bare code                                                         | §2.2 is an assumption (D8) in the first place, so neither shape is evidenced. Both are pinned by tests so the variation is at least deliberate and visible.                                                                                           |

### 7.2) Known non-parity gap: CSRF state validation in the CLI

`index.mjs` captures the `state` returned by `authorize()`, stores it with the
pending flow, and refuses the callback when the returned `state` is missing or
does not match. **`cli.mjs` does not**: its paste-driven login destructures only
`{ url, verifier }`, so a pasted `state` is forwarded to the server without ever
being compared locally.

This is pre-existing behaviour, not something the parity work introduced, and it
is not a wire-fingerprint issue — it is a security gap. It is recorded here
rather than fixed in place because fixing it changes the CLI's login control flow,
which no wave of this plan owns.

### 7.3) Known product gap: enabling a scope gate does not re-issue a token

`hasRequiredScopes()` checks the five-scope **base** set only. Turning on
`oauth.plugins_scope` — or adding an `oauth.project_scopes` entry — therefore
does **not** invalidate a token that was issued without the extension, and the
user is not prompted to re-authenticate. The knob appears inert until the next
voluntary login.

This is deliberate. Making the extensions "required" would mark every stored
token as insufficient the moment the key is set, forcing a re-login on users who
flipped a knob they may not have understood. The alternative — silently keeping a
token that lacks the requested scope — is at least non-destructive, and the
authorize URL does carry the extension the next time the user logs in.

Related: the `oauth.*` config namespace is **file-only**. `/anthropic set`
carries an explicit per-key allowlist and has never had a branch for any `oauth`
key, including the pre-existing `revoke_on_logout`. All four keys
(`sdk_token_useragent`, `revoke_on_logout`, `plugins_scope`, `project_scopes`)
are set by editing `anthropic-auth.json` directly.

## 8) Change control

- Every **attested** constant in §1–§5 is pinned by a literal assertion in
  `lib/oauth-constants.test.mjs`. A test that compares an import to itself proves
  nothing; the test re-writes the literal.
- Every **attested** row of §2 maps to exactly one assertion in
  `test/conformance/oauth-wire-parity.test.mjs`, enforced by a meta-test that
  fails when such a row gains no assertion. Rows marked `[unattested]`,
  `[unattested-bind]` or `[unattested-order]` are deliberately exempt: pinning an
  assumption as a measurement is how a guess becomes folklore.
- Header assertions check **presence and value** of the attested headers. They do
  not assert the absence of unlisted headers, because §13.8 is not a closed set
  (§3.1).
- Changing an attested value requires a matching byte offset in a
  `claude-code-wire-compat` analysis document. Changing an `[unattested]` value
  requires either a new offset — which promotes it out of `[unattested]` — or a
  justified row in §7.
