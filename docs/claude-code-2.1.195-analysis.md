# Claude Code 2.1.195 Analysis

Date: 2026-06-29
Analyst: static binary extraction (linux-x64 native Bun binary, Bun-embedded JS bundle)
Compared against: 2.1.159 (last analyzed) / 2.1.154 (plugin wire baseline)
Plugin currently emulates: 2.1.159 (`FALLBACK_CLAUDE_CLI_VERSION`)
Latest published: 2.1.195

> Extraction method: `npm pack @anthropic-ai/claude-code-linux-x64@2.1.195`, then
> carve the embedded JS out of the 233 MB Bun `--compile` ELF (one contiguous
> printable run at offset `224326136`, len `17939574`, header
> `// @bun @bytecode @bun-cjs`). All offsets below are byte indices into that
> carved bundle. Helper scripts (`extract-strings.cjs`, `wgrep.cjs`) used for
> windowed minified-grep.

---

## 1. Package / binary metadata

| Field       | 2.1.159                                  | 2.1.195                                                                        |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| Package     | @anthropic-ai/claude-code@2.1.159        | @anthropic-ai/claude-code@2.1.195                                              |
| Version     | 2.1.159                                  | **2.1.195**                                                                    |
| Build time  | 2026-05-31T16:22:50Z                     | **2026-06-26T01:00:56Z**                                                       |
| Git SHA     | dd8c11fc8d05cea0b2b9fc8f5a99a5c5c5dffc9b | **4603aa3f2ea164bd0974f82eb413ae7acc99a7ee**                                   |
| SDK bundled | @anthropic-ai/sdk 0.94.0                 | @anthropic-ai/sdk **0.94.0** (no bump)                                         |
| Docs URL    | (n/a)                                    | **`https://code.claude.com/docs/en/overview`** (was `docs.claude.com`/support) |

`x-stainless-package-version` still binds to `PK = "0.94.0"` — the plugin's
hardcoded `0.94.0` (and `anthropic-version: 2023-06-01`) remain correct.

### Distribution model (unchanged since 2.1.159, but worth restating)

The npm `@anthropic-ai/claude-code` package is a **thin wrapper** — its tarball
ships only `install.cjs`, `cli-wrapper.cjs`, a `bin/claude.exe` stub, `package.json`,
and `sdk-tools.d.ts` (≈19 KB). The real CLI is a **native Bun single-file
executable (~225–245 MB unpacked)** delivered through `optionalDependencies`
(`@anthropic-ai/claude-code-{darwin,linux,win32}-{arch}[-musl|-android]@2.1.195`).
`install.cjs` postinstall hardlinks the platform binary over the stub. There is
**no longer a readable `cli.js`** in the npm package; the JS is embedded in the
Bun binary and must be carved out. This does not affect the plugin's runtime, but
it is the reason these analyses now require binary extraction.

---

## 2. Executive Summary

**Wire-level drift from 2.1.159: LOW for headers/OAuth-endpoints, but TWO concrete
default-beta gaps and ONE OAuth token-call change matter.**

1. **Beta registry grew 24 → 28** (well, 26 → 28 counting `claude_code`/`oauth_auth`).
   The two genuinely new registrations are `server-side-fallback-2026-06-01` and
   `fallback-credit-2026-06-01`. **Both are opt-in / gated** (refusal-fallback
   feature) and are _not_ on a default `/v1/messages` request — no default drift.
   Nothing was retired.

2. **The plugin UNDER-sends two betas that real CC sends by default** on modern
   first-party models:
   - `context-management-2025-06-27` — default-on for first-party non-`claude-3`
     models (incl. Haiku 4.5) via the `n0d(model)` eligibility path.
   - `effort-2025-11-24` — default-on for effort-capable models (Opus 4.5/4.6/4.7/4.8,
     Sonnet 4.6, Fable/Mythos).
     Under-sending a beta that a genuine client always emits is a **more reliable
     fingerprint than over-sending** (real CC traffic on Opus 4.8 _always_ carries
     `context-management` + `effort`; the plugin never does). See §5.

3. **OAuth token endpoint client migrated from axios to the SDK's native fetch
   OAuth provider.** Real CC 2.1.195 sends token refresh/exchange with
   `User-Agent: anthropic-sdk-typescript/0.94.0 userOAuthProvider` **and**
   `anthropic-beta: oauth-2025-04-20` on the token POST. The plugin still mimics
   the _old_ `axios/1.13.6` + `Accept: application/json, text/plain, */*` shape.
   See §6. (Behavioral change — test carefully against the 429 guard.)

4. **Header wiring deltas** (§7): CC's first-party middleware now re-adds
   `x-client-request-id: <uuid>` (the plugin _deletes_ it) and conditionally adds
   `x-cc-atis` (a server-issued attestation token the plugin cannot synthesize).
   `anthropic-dispatch-id` is experimental/default-off (plugin correctly omits).
   The always-on `x-stainless-helper` the plugin sends is **not** present on a
   genuine CC main-turn request (potential over-send). The optional
   `, workload/<n>` User-Agent segment is new but absent in normal interactive use.

OAuth login flow (endpoints, `client_id`, PKCE, scopes) is otherwise **byte-identical**.

---

## 3. Mimicry impact (summary)

| Area                          | Status                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Version / build markers       | Bump `2.1.159 → 2.1.195`, build time, git SHA (see §9).                                                                |
| `anthropic-version`           | Still `2023-06-01`.                                                                                                    |
| `x-stainless-package-version` | Still `0.94.0`.                                                                                                        |
| Beta registry                 | 28 entries: `+ server-side-fallback`, `+ fallback-credit` (both gated, not default). None removed.                     |
| **Default beta set**          | **Plugin under-sends `context-management` + `effort`** on modern first-party models. ← act on this.                    |
| Always-on over-send risk      | Plugin's always-on `extended-cache-ttl`, `advisor-tool`, `context-hint`, `redact-thinking` are conditional in CC.      |
| **OAuth token-call**          | **Changed**: UA `axios/1.13.6` → `anthropic-sdk-typescript/0.94.0 userOAuthProvider` + `anthropic-beta` on token POST. |
| OAuth login flow / scopes     | No change. `client_id`, scopes, authorize/token endpoints byte-identical.                                              |
| `x-client-request-id`         | CC now **sends** it (random uuid); plugin **deletes** it → presence/absence drift.                                     |
| `x-cc-atis`                   | New server-issued attestation header; conditional; **unmimicable** (no GrowthBook init).                               |
| `anthropic-dispatch-id`       | Experimental, GrowthBook `tengu_cedar_lattice` default-off. Plugin omits — correct.                                    |
| `x-stainless-helper`          | Not on genuine main turns; plugin's always-on value is a likely over-send (verify, §7).                                |
| Billing header                | Format unchanged (`cc_version=<v>.<3-char-fp>; cc_entrypoint=cli; cch=00000;`).                                        |
| Rate-limit response headers   | `anthropic-ratelimit-unified-*` family expanded (§8) — relevant to rotation/backoff, not outbound.                     |

---

## 4. Beta registry diff (`Udd` table, 28 entries)

The canonical registry is the frozen array `Udd` of `OE("internal_label","beta-flag")`
entries (`OE(n,h)=Object.freeze({name:n,header:h})`), with lookup map `uoi`
(`header → entry`) and projection `fI(arr)=arr.map(t=>t.header)`.

### Added vs 2.1.159 (two entries)

| label                  | flag                              | Default-on?                                                                                                                                                            |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server_side_fallback` | `server-side-fallback-2026-06-01` | **No** — only when a `fallbacks:[{model}]` body param is present (opt-in). Rejected on Batches API; unavailable on Bedrock/Vertex/Foundry.                             |
| `fallback_credit`      | `fallback-credit-2026-06-01`      | **No** — sent by client-side `BetaRefusalFallbackMiddleware` for refusal-retry repricing; refusal carries `stop_details.fallback_credit_token`. Not on a default turn. |

These supersede/relate to the 2.1.159 `x-is-refusal-fallback` header experiment —
the refusal-fallback feature graduated into two registered betas. Both remain
**off by default**; the plugin should keep them out of every always-on path (add
to `EXPERIMENTAL_BETA_FLAGS` for registry-completeness + the disable-guard only).

### Retired vs 2.1.159

**None.** All prior registrations are still present.

### Helper sets (decoded, for accuracy of platform gating)

- `S2r = Set([interleaved_thinking, long_context, tool-search-tool])` — **the
  bedrock-unsupported filter** (`V9`: on bedrock these three are stripped from the
  header and re-added to the body `anthropic_beta` via the inverse set `O9r`). This
  is upstream-only. The plugin has **no** `BEDROCK_UNSUPPORTED_BETAS` set and no bedrock
  branch — `buildAnthropicBetaHeader()` takes no `provider` argument, and the absence of the
  symbol is pinned by `lib/mimicry/headers.test.mjs`. Anthropic first-party is the only
  supported provider ([Provider Scope](../README.md#provider-scope)),
  so there is nothing to filter — no change.
- `E2r = Set([claude_code, interleaved_thinking, context_management, oauth])` —
  the **count-tokens allowlist** (`beta.messages.countTokens` filters request betas
  to this set). It does **not** gate `/v1/messages`.
- `Pvi = Set([claude_code, interleaved_thinking, long_context, context_management,
structured_outputs, web_search, effort, tool-search-tool, afk_mode,
fallback_credit])` — the **non-first-party (3P) allowlist** (`N9r`). For OAuth
  (first-party) it is a no-op; only bites on custom gateways.

### Betas present in the binary but NOT in `Udd` (feature/endpoint-specific)

Not part of any default `/v1/messages` set — used on their own APIs:
`managed-agents-2026-04-01` (agents/deployments API), `mcp-client-2025-11-20`,
`oidc-federation-2026-04-01` (enterprise OIDC federation), `user-profiles-2026-03-24`,
`skills-2025-10-02`, `code-execution-2025-08-25`, `compact-2026-01-12` (compaction
edit-type), `token-counting-2024-11-01`, plus SDK-level
`message-batches` / `output-128k` / `token-efficient-tools` /
`fine-grained-tool-streaming` / `structured-outputs-2025-11-13`. The plugin must
not emit any of these on a coding turn.

---

## 5. Default beta-assembly wiring (the decisive evidence)

The per-request set is built by `$9r(model)` (base, module `Vw` @3056000–@3062710),
wrapped by `V9` (bedrock filter), augmented by `jot` (agentic), then per-request
pushes in the `/v1/messages` query closure (`vt` @13828019), and finally
3P-filtered by `N9r`. Shipped header = `fI(N9r(us))`.

Provider predicates: `fr()` = auth source (`firstParty`|`anthropicAws`|`foundry`|
`bedrock`|`vertex`|`mantle`|`gateway`); `ZO(p)` = `p ∈ {firstParty,anthropicAws,foundry,mantle}`;
`M9r()` = `fr() ∈ {firstParty,anthropicAws,foundry}`; `F4e()` = experimental-betas
disabled (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` or HIPAA taint); `CM()` =
`M9r() && !F4e()`.

### DEFAULT set — OAuth (first-party), Opus/Sonnet 4.x, main/parent thread, 5 m cache

```
oauth-2025-04-20                  bo()  (OAuth)
claude-code-20250219              non-Haiku
interleaved-thinking-2025-05-14   QOt(model)  (first-party, non-claude-3)
context-management-2025-06-27     ZO && !F4e() && n0d(model)   ← plugin OMITS (drift)
prompt-caching-scope-2026-01-05   CM()
thinking-token-count-2026-05-13   CM() && QOt && first-party
effort-2025-11-24                 Kw(model)   ← plugin OMITS (drift)
redact-thinking-2026-02-12        added by $9r, but SPLICED OUT when the turn sends
                                  extended-thinking-with-display (Xn && Yn)
```

- `context-management`: `n0d(model)` = foundry→true; `ZO`→ `!claude-3`; else per-model
  flag. For first-party non-`claude-3` (incl. Haiku 4.5) this is **true by default**.
  Note: the _separate_ `USE_API_CONTEXT_MANAGEMENT` env path (`i = env... && false`)
  is still hardcoded-off — the prior 2.1.159 analysis read only that term and
  recorded context-management as "off", under-reading the `n0d` eligibility path.
  **In 2.1.195 it is confirmed default-on for modern first-party models.** (Verify
  whether this was already true in 2.1.159; structurally the `A=mH5(H)` var in the
  2.1.159 snippet is the same `n0d` path, so this gap likely predates 2.1.195.)
- `effort`: `Kw(model)` returns `false` for `claude-3-*`, `opus-4-0/4-1`,
  `sonnet-4-0/4-5`, `haiku-4-5`; `true` for effort-capable models
  (Opus 4.5/4.6/4.7/4.8, Sonnet 4.6, Mythos) and otherwise `ZO(provider)` for
  first-party. The accompanying body `effort` field is only set if a value resolves,
  but the **beta header is pushed for capable models regardless**.

### Haiku (`claude-haiku-4-5`)

`oauth-2025-04-20`, `context-management-2025-06-27`, `prompt-caching-scope-2026-01-05`
only — no `claude-code`, no thinking betas, no effort. (Plugin already skips
`claude-code` on Haiku — matches — but still omits `context-management`.)

### Subagent thread (`querySource` starts with `agent:`)

Same as main thread **minus `context-hint`** (`context-hint` requires
`querySource.startsWith("repl_main_thread")`).

### Gating for entries the plugin currently treats as always-on (CC = conditional)

| Beta (plugin always-on)         | CC's real gate                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extended-cache-ttl-2025-04-11` | only when 1 h cache active: `V==="1h" && CM()` (`ENABLE_PROMPT_CACHING_1H` env or `tengu_prompt_cache_1h_config` allowlist). Default 5 m → not sent. |
| `advisor-tool-2026-03-01`       | `F6() && CM()`; `F6()` needs GrowthBook `tengu_sage_compass2.enabled` (default-off).                                                                 |
| `context-hint-2026-04-09`       | GrowthBook `tengu_hazel_osprey` (default-off) **and** main thread.                                                                                   |
| `redact-thinking-2026-02-12`    | added, then **removed** when the turn sends extended-thinking-with-`display`.                                                                        |

> The plugin emitting these unconditionally is the inverse risk to the
> under-send: on a vanilla account they are _over-broadcast_. The plugin's design
> notes already mark several as "default-on (plugin addition)"; this analysis
> documents the exact upstream gate so the divergence is a conscious choice, not
> drift. (See §9 for the recommendation to make `extended-cache-ttl` 1h-conditional.)

### Explicit answers

- `effort-2025-11-24` → **DEFAULT** (model-gated, no feature flag).
- `advanced-tool-use-2025-11-20` / `tool-search-tool-2025-10-19` → **NOT default**;
  only when dynamic tool-search activates (`b = pYt(...)`), selected by provider
  (`Dvi()`). Plugin correctly keeps these as passthrough-only.

---

## 6. OAuth token-call drift (HIGH) — axios → SDK fetch provider

OAuth **login flow** (authorize/callback/token endpoints, `client_id`
`9d1c250a-e61b-44d9-88ed-5944d1962f5e`, PKCE `S256`, `code=true`, refresh grant) and
the **claude_code scopes** (`user:profile user:inference user:sessions:claude_code
user:mcp_servers user:file_upload`) are **byte-identical** to 2.1.159. New cosmetic
success URL `platform.claude.com/oauth/code/success?app=claude-code`. New OIDC
artifacts (`claude.ai/oauth/claude-code-client-metadata`, grant
`urn:ietf:params:oauth:grant-type:jwt-bearer`, scopes `user:design:*`/`user:projects:*`/
`org:admin`) are for enterprise OIDC-federation / other product flows — **not** the
Claude Pro/Max inference login.

**The change that matters:** the token refresh/exchange request is no longer made by
axios. There is **no `axios/1.x.x` UA string** constructed for OAuth in the bundle.
Token calls now go through the SDK's native fetch OAuth providers:

```js
// userOAuthProvider (@92887) — token refresh/exchange
method: "POST",
headers: {
  "Content-Type": "application/json",
  "anthropic-beta": "oauth-2025-04-20",                       // ← NEW on token POST
  "User-Agent": e.userAgent || `anthropic-sdk-typescript/${PK} userOAuthProvider`,
                                                              // PK = "0.94.0"
},
body: JSON.stringify(...)                                     // JSON (unchanged)
// no explicit Accept header (fetch default "*/*")
```

```js
// oidcFederationProvider (@90904) — enterprise only
"anthropic-beta": "oauth-2025-04-20,oidc-federation-2026-04-01",
"User-Agent": `anthropic-sdk-typescript/0.94.0 oidcFederationProvider`,
```

**Plugin today** (`lib/oauth.mjs`): `OAUTH_AXIOS_VERSION = "1.13.6"`,
`User-Agent: axios/1.13.6`, `Accept: application/json, text/plain, */*` on token
calls. (The `application/json, text/plain, */*` value still appears in the bundle,
but it is axios's default `headers.common.Accept` config — axios is still bundled
for _other_ uses — not the OAuth path.)

**Recommendation (behavioral — test against the 429 guard):**

- Change the token-call `User-Agent` to `anthropic-sdk-typescript/0.94.0 userOAuthProvider`.
- Add `anthropic-beta: oauth-2025-04-20` to the token-exchange and refresh POSTs.
- Drop (or re-evaluate) the axios-style `Accept` header.

Caveat: the plugin's docs note the token endpoint historically 429'd requests
without the axios UA. `axios/1.13.6` may still be allow-listed. Validate that the
new UA does **not** regress refresh reliability before shipping (gate behind a flag
or A/B if unsure). This is the single highest-fidelity OAuth improvement available.

---

## 7. Header wiring — new / changed / retired

CC `/v1/messages` outbound headers come from three layers: (1) the Anthropic TS SDK
base headers, (2) CC's `defaultHeaders` block `p` (@3037791), (3) the first-party
fetch middleware `Ukd` (@3046745).

| Header                                               | 2.1.195 behavior                                                                                                                                                                                                                    | Plugin                               | Verdict                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `User-Agent` (messages)                              | `claude-cli/2.1.195 (external, cli[, agent-sdk/…][, client-app/…][, workload/<n>])`. New optional `workload/<n>` segment (only when `wAn()` set; absent in normal interactive).                                                     | `claude-cli/2.1.159 (external, cli)` | **Version drift only** — bump to 2.1.195.                                                                                        |
| `x-app`                                              | `cli` (or `cli-bg` background). Unchanged.                                                                                                                                                                                          | matches                              | OK                                                                                                                               |
| `anthropic-dangerous-direct-browser-access`          | `true` — CC main client constructs with `dangerouslyAllowBrowser:!0` (@3038758). Confirmed on wire.                                                                                                                                 | sends `true`                         | **Match** (correct)                                                                                                              |
| `x-client-request-id`                                | **CC SENDS** it: middleware `Ukd` sets `crypto.randomUUID()` on first-party requests when absent (`Mot="x-client-request-id"`).                                                                                                     | **deletes/omits**                    | **Drift** — plugin removes a header CC sends. Value is random, so only presence is the signal. Recommend emitting a random uuid. |
| `x-cc-atis`                                          | Conditional: `Ukd` sets it to `getClientDataAtis()` (server-pushed attestation token) when present.                                                                                                                                 | cannot send                          | **Unmimicable** — no GrowthBook/clientData init; document as a known gap, do not fake.                                           |
| `anthropic-dispatch-id`                              | Value `v2s`. Only when `querySource!="auxiliary" && firstParty && tengu_cedar_lattice` (GrowthBook **default-off**). CC strips + retries on pre-first-event stream error.                                                           | omits                                | **Correct** to omit (experimental/default-off).                                                                                  |
| `anthropic-client-platform`                          | `_x()` (e.g. `claude_code_vscode`). Only on cloud/code-session, presence-pulse, voice-stream, GitHub-app, session APIs — **NOT** `/v1/messages`.                                                                                    | n/a                                  | No drift.                                                                                                                        |
| `x-stainless-helper`                                 | SDK header set **only** by SDK helpers (`BetaToolRunner, …` via toolRunner; `compaction`). A genuine CC main turn (`beta.messages.create({stream:true})`) carries **neither** `x-stainless-helper` nor `X-Stainless-Helper-Method`. | sends always-on tool-manifest value  | **Likely OVER-SEND** — verify against `index.mjs` (~L8023) + conformance test; consider dropping on normal turns.                |
| `x-stainless-*` (lang/os/arch/runtime/retry/timeout) | Unchanged shape.                                                                                                                                                                                                                    | matches                              | OK                                                                                                                               |
| `x-is-refusal-fallback` (2.1.159)                    | Superseded by the `fallback-credit` beta + middleware. Still gated/default-off.                                                                                                                                                     | omits                                | OK                                                                                                                               |
| Ignore (not CC API headers)                          | `x-app-name`/`x-app-ver` (bundled `@azure/msal-node`), `X-Claude-Code-Ide-Authorization` (IDE MCP WS), `x-cc-gateway-version` (server-side CCR gateway response header).                                                            | —                                    | —                                                                                                                                |

**Retired headers:** none observed on the `/v1/messages` path.

---

## 8. Rate-limit response header family (expanded) — rotation/backoff relevance

2.1.195 reads a much larger unified rate-limit response family than earlier
versions:

```
anthropic-ratelimit-unified
anthropic-ratelimit-unified-status
anthropic-ratelimit-unified-reset
anthropic-ratelimit-unified-fallback
anthropic-ratelimit-unified-overage-status
anthropic-ratelimit-unified-overage-reset
anthropic-ratelimit-unified-overage-in-use
anthropic-ratelimit-unified-overage-disabled-reason
anthropic-ratelimit-unified-overage-period-channel-utilization
anthropic-ratelimit-unified-overage-period-monthly-utilization
anthropic-ratelimit-unified-representative-claim
anthropic-ratelimit-unified-upgrade-paths
```

These are **inbound** (server → client), so they are not a fingerprint, but they
matter for the plugin's account **rotation/backoff** logic: CC now distinguishes
plan-limit vs **overage** state and surfaces channel/monthly utilization. A
robustness/economy opportunity is to parse `…-unified-status` /
`…-unified-overage-status` / `…-unified-reset` to drive smarter rotation (e.g.
rotate before hard-429 when overage is exhausted, respect `…-reset` precisely).
See `docs/future-improvements.md`.

---

## 9. Performance / economy opportunities (plugin code)

From the plugin hot-path map (`index.mjs` fetch interceptor + retry loop,
`lib/request-headers.mjs`, `lib/config.mjs token_economy`):

1. **Per-request regex recompilation.** `sanitizeSystemText` (`index.mjs:~7092`)
   and `tailSystemBlock` (`~7112`) rebuild `importantRe`/`headerRe`/`listItemRe`
   on every call, and `buildAnthropicBetaHeader` runs `/claude-3-/i` repeatedly
   (`~7662,7689,7707,7724,7742,7748`). Hoist these to module-level constants.
2. **Per-request hashing / stringify churn.** `computeBillingCacheHash` SHA-256
   (`~5792`), `hashCacheSource(JSON.stringify(tool))` per tool (`~4863`),
   `estimateTokens(JSON.stringify(block.input))` (`~5164/5265/6257`), and full-body
   re-serialization on each retry branch (`~3492/3588/3669/3873`). Cache the
   billing fingerprint per request (it only depends on `msg[4]+msg[7]+msg[20]+version`),
   and serialize the body once per attempt rather than per branch.
3. **`loadConfig()` in the hot path.** Config is intentionally read live (AGENTS.md
   H6), but confirm the per-request path reads a captured ref rather than re-parsing
   the JSON file each request; debounce/memoize with mtime invalidation if not.
4. **Token economy** (`lib/config.mjs:205–319`): existing `microcompact`,
   `ttl_thinking_strip`, `role_scoped_cache_ttl`, `stable_tool_ordering`,
   `simple_system_prompt`. New parity opportunity from §8: drive cache-TTL and
   rotation decisions off the `anthropic-ratelimit-unified-*` overage signals.
5. **Stream idle watchdog** (carried from the 2.1.159 analysis, still applicable):
   CC's `Ukd` runs a byte-stream idle watchdog (`tengu_stream_watchdog_default_on`,
   default **true**). Aborting + retrying a stream that has produced no bytes for
   N ms (instead of waiting the full request timeout) is a robustness win that also
   complements the existing ECONNRESET keepalive-disable recovery.

These are optimizations, not correctness bugs; none changes the wire fingerprint.

---

## 10. Recommended plugin changes

### Required (version tracking)

- `lib/request-headers.mjs`: `FALLBACK_CLAUDE_CLI_VERSION → "2.1.195"`;
  `CLAUDE_CODE_BUILD_TIME → "2026-06-26T01:00:56Z"`;
  `CLAUDE_CODE_GIT_SHA → "4603aa3f2ea164bd0974f82eb413ae7acc99a7ee"`;
  extend `CLI_TO_SDK_VERSION` rows `2.1.160`–`2.1.195` → `0.94.0`.
  (The wire SDK version stays `0.94.0` — `index.mjs:~8008` hardcode is still correct.)

### Mimicry — high value

- **Add `context-management-2025-06-27` to the default beta set** for first-party
  non-`claude-3` models (incl. Haiku). This is the most detectable current gap.
- **Add `effort-2025-11-24`** for effort-capable models (Opus 4.5/4.6/4.7/4.8,
  Sonnet 4.6) — gate on model id, mirror `Kw(model)`'s exclusions
  (`opus-4-0/4-1`, `sonnet-4-0/4-5`, `haiku-4-5`, `claude-3-*`).
- **Emit `x-client-request-id: <crypto.randomUUID()>`** instead of deleting it
  (CC's middleware adds it on every first-party request).
- **OAuth token call** (§6, behavioral — test 429 guard): UA →
  `anthropic-sdk-typescript/0.94.0 userOAuthProvider`, add
  `anthropic-beta: oauth-2025-04-20`, re-evaluate the axios-style `Accept`.

### Mimicry — registry completeness / forward-compat

- Add `server-side-fallback-2026-06-01` and `fallback-credit-2026-06-01` to
  `EXPERIMENTAL_BETA_FLAGS` (+ `BETA_SHORTCUTS` aliases). **Keep both OFF by
  default** (opt-in / refusal-fallback only).
- Consider making always-on `extended-cache-ttl-2025-04-11` **1h-conditional**
  (CC only sends it with 1 h caching) to reduce over-broadcast; same for
  `advisor-tool` / `context-hint` (both GrowthBook-gated default-off in CC).

### Verify (do not blindly change)

- `x-stainless-helper`: confirm whether the plugin's always-on value matches any
  genuine CC turn. A normal `beta.messages.create({stream:true})` carries none;
  the plugin may be over-sending. Check the conformance test expectation first.
- `redact-thinking`: CC removes it when the turn sends extended-thinking-with-display.
  Confirm the plugin's typical thinking turns before changing.

### No action (correctly handled)

- OAuth login flow, scopes, `client_id`, PKCE: unchanged.
- `anthropic-dispatch-id`, `x-cc-atis`, `x-is-refusal-fallback`: keep omitting
  (experimental/default-off/unmimicable).
- `S2r` bedrock-unsupported filter: upstream-only. The plugin has no equivalent set and needs
  none — it is Anthropic first-party only. No change.
- `anthropic-version 2023-06-01`, `x-stainless-package-version 0.94.0`: unchanged.
