<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

> **Where this document came from**
>
> This file is a verbatim copy of
> `docs/protocol/versions/claude-code-2.1.233-analysis.md` from
> [`claude-code-wire-compat`](https://github.com/marco-jardim/claude-code-wire-compat),
> the package this plugin depends on for request composition. It is
> `GPL-3.0-or-later`, the same licence as this repository, so the copy is a
> licence-clean redistribution rather than a quotation.
>
> **Why it lives here.** `scripts/check-invariants.mjs` requires a
> `docs/claude-code-<version>-analysis.md` matching
> `FALLBACK_CLAUDE_CLI_VERSION` in `lib/request-headers.mjs`. That invariant
> exists so the plugin can never claim to emulate a client version nobody
> analysed. The plugin now composes against the wire-compat package's
> `DEFAULT_PROFILE`, which is `claude-code-2.1.233-sdk-0.112.1`, so the analysis
> backing that claim has to be readable from this repository.
>
> **Read it as upstream's document, not this repository's.** Everything below is
> written from the package's point of view: "this package" means
> `claude-code-wire-compat`, and its scope decisions (no I/O, no environment
> reads, `effort_cost_index` omitted) are the package's, not the plugin's. The
> plugin's own divergences from a genuine client are recorded separately in
> [`mimicry/wire-compat-divergences.md`](mimicry/wire-compat-divergences.md).
>
> The sections that matter most for this plugin are §3 (beta registry — note the
> `summarize-connector-text-2026-03-13` REMOVAL), §10 (billing block, including
> the `cc_prev_req` / `cc_prompt_id` segments the plugin does not populate) and
> §11 (`x-stainless-package-version` `0.94.0` → `0.112.1`).

---

> **Provenance (upstream, as written)**
>
> - First-party analysis authored in this repository
> - License: `GPL-3.0-or-later`
> - Method: static binary extraction from the official npm artifacts
>
> Scope: original reverse-engineering research performed for this package,
> comparing the official `2.1.233` release against `2.1.222` and against the
> `2.1.195` baseline this package previously pinned. Nothing in this document
> is reproduced from any external repository.

# Claude Code 2.1.233 Analysis

Date: 2026-08-15
Analyst: static binary extraction (win32-x64 native Bun binary, Bun-embedded JS bundle)
Compared against: 2.1.222 and 2.1.195 (package baseline)

> Extraction method: `npm pack @anthropic-ai/claude-code-win32-x64@2.1.233` and
> `npm pack @anthropic-ai/claude-code-win32-x64@2.1.222`, then carve the printable
> JS region out of each Bun `--compile` executable. For 2.1.233 that region starts
> at offset `285016064` and runs ≈25.6 MB; for 2.1.222 it starts at offset
> `249495552` and runs ≈21.9 MB. Every offset quoted below is an absolute byte
> index into the corresponding `.exe`, not an index into the carved region.

---

## 1. Package / binary metadata

| Field       | 2.1.222                                    | 2.1.233                                        |
| ----------- | ------------------------------------------ | ---------------------------------------------- |
| Version     | 2.1.222                                    | **2.1.233**                                    |
| Build time  | `2026-08-04T01:24:05Z`                     | **`2026-08-14T17:21:48Z`**                     |
| Git SHA     | `fbf49312c28437bf9c2546b9ace3bd7b34eb6ff6` | **`f8d57569aaf350fe25dc4dfa10cad59db8ea4d45`** |
| SDK bundled | `@anthropic-ai/sdk` 0.94.0                 | `@anthropic-ai/sdk` **0.112.1**                |

The SDK bump is the single metadata change with a wire consequence: it is what
`x-stainless-package-version` binds to. See §10.

---

## 2. Executive summary

1. **The beta registry is identical between 2.1.222 and 2.1.233.** All registry
   drift in this hop is 2.1.195 → 2.1.222: four new registrations, one removal.
2. **The model catalogue grows 14 → 17** (`claude-sonnet-5`, `claude-opus-5`,
   `claude-mythos-5`). `claude-mythos-5` is now a catalogue entry; under 2.1.195
   it was catalogue-less and reachable only by name.
3. **`effort_cost_index` is the only static-catalogue field added between 2.1.222
   and 2.1.233.** Zero occurrences in 2.1.222, seven in 2.1.233.
4. **The billing block gains a `cc_prompt_id` segment** and tightens
   `cc_prev_req` from a truthy check to a regex.
5. **Transport is byte-stable apart from the SDK version value.** Header names,
   ordering, endpoint and `anthropic-version` are unchanged.
6. Every genuinely new beta is **inert under default conditions** — each is gated
   behind a runtime-armed lane, a remote configuration flag defaulting to false,
   or a query source that is not the main `/v1/messages` call.

---

## 3. D1 — Beta registry

The frozen registry array holds **32 slots**, of which **one is `null`** — the
hole left by removing `narration_summaries`
(`summarize-connector-text-2026-03-13`) — for **31 effective entries**. The
array is at absolute offset `287505865` in 2.1.233 (minified name `Fb_`) and at
`251917590` in 2.1.222 (minified name `XVg`). The two arrays are identical
entry for entry.

| #   | Feature key                         | Beta header                           |
| --- | ----------------------------------- | ------------------------------------- |
| 1   | `claude_code`                       | `claude-code-20250219`                |
| 2   | `oauth_auth`                        | `oauth-2025-04-20`                    |
| 3   | `interleaved_thinking`              | `interleaved-thinking-2025-05-14`     |
| 4   | `long_context`                      | `context-1m-2025-08-07`               |
| 5   | `context_management`                | `context-management-2025-06-27`       |
| 6   | `structured_outputs`                | `structured-outputs-2025-12-15`       |
| 7   | `web_search`                        | `web-search-2025-03-05`               |
| 8   | `tool_search`                       | `advanced-tool-use-2025-11-20`        |
| 9   | `tool_search`                       | `tool-search-tool-2025-10-19`         |
| 10  | `effort`                            | `effort-2025-11-24`                   |
| 11  | `task_budgets`                      | `task-budgets-2026-03-13`             |
| 12  | `prompt_caching_scope`              | `prompt-caching-scope-2026-01-05`     |
| 13  | **`prompt_caching_evict`**          | **`prompt-caching-evict-2026-05-12`** |
| 14  | `extended_cache_ttl`                | `extended-cache-ttl-2025-04-11`       |
| 15  | `speed`                             | `fast-mode-2026-02-01`                |
| 16  | `redact_thinking`                   | `redact-thinking-2026-02-12`          |
| 17  | `thinking_token_count`              | `thinking-token-count-2026-05-13`     |
| 18  | `afk_mode`                          | `afk-mode-2026-01-31`                 |
| 19  | `advisor_tool`                      | `advisor-tool-2026-03-01`             |
| 20  | `cache_diagnosis`                   | `cache-diagnosis-2026-04-07`          |
| 21  | `context_hint`                      | `context-hint-2026-04-09`             |
| 22  | `mcp_servers`                       | `mcp-servers-2025-12-04`              |
| 23  | `files_api`                         | `files-api-2025-04-14`                |
| 24  | `environments`                      | `environments-2025-11-01`             |
| 25  | `ccr_byoc`                          | `ccr-byoc-2025-07-29`                 |
| 26  | `mid_conversation_system`           | `mid-conversation-system-2026-04-07`  |
| 27  | **`per_message_effort`**            | **`per-turn-control-2026-07-01`**     |
| 28  | `server_side_fallback`              | `server-side-fallback-2026-06-01`     |
| 29  | **`server_side_fallback_category`** | **`server-side-fallback-2026-07-01`** |
| 30  | `fallback_credit`                   | `fallback-credit-2026-06-01`          |
| 31  | _(null slot)_                       | _(removed `narration_summaries`)_     |
| 32  | **`auto_mode_classifier`**          | **`auto-mode-classifier-2026-07-16`** |

`prompt_caching_evict` is inserted between `prompt_caching_scope` and
`extended_cache_ttl`; the remaining new entries are appended at the tail.
Registry order is load-bearing for anyone reproducing the `anthropic-beta`
header, because the header is composed by walking this array.

Two further identifiers exist outside the registry and must not be mistaken for
betas: the internal latch pseudo-betas
`x-cc-internal-mid-conv-cache-promotion` and
`x-cc-internal-mid-conv-cache-promotion-ok`.

### Delta against 2.1.195 (28 entries)

- **Added (4):** `prompt_caching_evict`, `per_message_effort`,
  `server_side_fallback_category`, `auto_mode_classifier`.
- **Removed (1):** `narration_summaries` / `summarize-connector-text-2026-03-13`,
  leaving the null slot.
- `server_side_fallback` and `fallback_credit` are **not** new — both were
  already registered in 2.1.195.

### Consumer consequence of the removal

`narrationSummariesEnabled` in the beta policy becomes **inert** at 2.1.233.
Enabling it cannot emit a header, because the registry entry it would resolve
through no longer exists. A faithful port skips the step silently rather than
raising: the genuine client has nothing to look up, so it emits nothing, and any
error would itself be a distinguishing behaviour.

### Emission conditions for the new betas (decompiled from 2.1.233)

Every one of these is unreachable in the default first-party flow.

| Beta                            | Conditions                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt_caching_evict`          | Canonical first-party provider (`fTr()`: `firstParty` on host `api.anthropic.com`, or `anthropicAws` with no custom base) **and** either the `CLAUDE_CODE_SUBAGENT_CACHE_EVICT` environment variable or the remote gate `tengu_subagent_cache_evict` (default false), **and** a subagent path carrying `evictCacheOnComplete`. |
| `per_message_effort`            | Requires the model catalogue to declare the `per_turn_effort` capability. **None of the 17 static catalogue entries declares it**; it can only arrive through remote configuration, which is out of scope.                                                                                                                     |
| `server_side_fallback`          | A refusal-fallback lane armed at runtime, plus `firstParty` on an Anthropic host.                                                                                                                                                                                                                                              |
| `server_side_fallback_category` | As above, plus a remote gate defaulting to false.                                                                                                                                                                                                                                                                              |
| `fallback_credit`               | A lane armed by the caller. It is the only fallback beta present in the third-party allowlist and the only one injected into the `anthropic_beta` body field on Bedrock.                                                                                                                                                       |
| `auto_mode_classifier`          | Only on auto-mode classifier sub-requests (`querySource` `auto_mode`). Never on the primary `/v1/messages` call.                                                                                                                                                                                                               |
| `context_hint`                  | Remote gate `tengu_hazel_osprey` (default false) **and** `querySource` `repl_main_thread`. Visible default: off, consistent with a pinned `contextHintEnabled: false`.                                                                                                                                                         |

---

## 4. Derived beta sets (identical in 2.1.222 and 2.1.233)

**Third-party allowlist — 11 headers:**
`claude-code-20250219`, `interleaved-thinking-2025-05-14`,
`context-1m-2025-08-07`, `context-management-2025-06-27`,
`structured-outputs-2025-12-15`, `web-search-2025-03-05`, `effort-2025-11-24`,
`tool-search-tool-2025-10-19`, `afk-mode-2026-01-31`,
`fallback-credit-2026-06-01`, `mid-conversation-system-2026-04-07`.

Delta against 2.1.195, which had 10: **`mid-conversation-system-2026-04-07`
was added**.

**Bedrock-unsupported set** — `interleaved-thinking`, `context-1m`,
`tool-search-tool`. Identical to 2.1.195.

**Count-tokens set** — `claude-code`, `interleaved-thinking`,
`context-management`, `oauth`. Identical to 2.1.195.

**New concept in 2.1.222+:** an allowlist for user-supplied custom betas
containing exactly `context-1m-2025-08-07`, guarded by the warning
`Custom betas are only available for API key users`.

---

## 5. D2 — Model catalogue (17 entries)

Order is the catalogue's own order and is preserved below. `mot` is
`max_output_tokens` as `{default}/{upper}`. Context flags are recorded as
declared: `native_1m`, `supports_1m_beta` (`1m_beta`), `supports_1m_suffix`
(`1m_suffix`).

| #   | Model               | Context                                                         | mot            | Capabilities                                                                                                                                                                                | `default_effort` |
| --- | ------------------- | --------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | `claude-3-5-haiku`  | —                                                               | 8192 / 8192    | —                                                                                                                                                                                           | —                |
| 2   | `claude-haiku-4-5`  | 200000, 1m_suffix                                               | 32000 / 64000  | `context_management`                                                                                                                                                                        | —                |
| 3   | `claude-3-5-sonnet` | —                                                               | 8192 / 8192    | —                                                                                                                                                                                           | —                |
| 4   | `claude-3-7-sonnet` | —                                                               | 32000 / 64000  | —                                                                                                                                                                                           | —                |
| 5   | `claude-sonnet-4-0` | 200000, 1m_beta, 1m_suffix                                      | 32000 / 64000  | `context_management`                                                                                                                                                                        | —                |
| 6   | `claude-sonnet-4-5` | 200000, 1m_beta, 1m_suffix                                      | 32000 / 64000  | `context_management`                                                                                                                                                                        | —                |
| 7   | `claude-sonnet-4-6` | 200000, 1m_beta, 1m_suffix                                      | 32000 / 128000 | `effort`, `max_effort`, `adaptive_thinking`, `context_management`                                                                                                                           | —                |
| 8   | `claude-sonnet-5`   | 1e6 native_1m (native_1m_3p on bedrock/vertex/foundry), 1m_beta | 64000 / 128000 | `effort`, `max_effort`, `xhigh_effort`, `adaptive_thinking`, `mid_conv_system`, `context_management`                                                                                        | `high`           |
| 9   | `claude-opus-4-0`   | 200000, 1m_suffix                                               | 32000 / 32000  | `context_management`                                                                                                                                                                        | —                |
| 10  | `claude-opus-4-1`   | 200000, 1m_suffix                                               | 32000 / 32000  | `context_management`                                                                                                                                                                        | —                |
| 11  | `claude-opus-4-5`   | 200000, 1m_suffix                                               | 32000 / 64000  | `context_management`                                                                                                                                                                        | —                |
| 12  | `claude-opus-4-6`   | 200000, 1m_beta, 1m_suffix                                      | 64000 / 128000 | `effort`, `max_effort`, `adaptive_thinking`, `context_management`                                                                                                                           | —                |
| 13  | `claude-opus-4-7`   | 1e6 native_1m, 1m_beta, 1m_suffix                               | 64000 / 128000 | `effort`, `max_effort`, `xhigh_effort`, `adaptive_thinking`, `context_management`                                                                                                           | `xhigh`          |
| 14  | `claude-opus-4-8`   | 1e6 native_1m, 1m_beta, 1m_suffix                               | 64000 / 128000 | as `claude-opus-4-7` plus `mid_conv_system`, `fast_mode`, `lean_prompt`                                                                                                                     | `high`           |
| 15  | `claude-opus-5`     | 1e6 native_1m, 1m_beta, 1m_suffix                               | 64000 / 128000 | as `claude-opus-4-8` plus `refusal_fallback`, `opus_5_prompt_bundle`                                                                                                                        | `high`           |
| 16  | `claude-fable-5`    | 1e6 native_1m, 1m_beta                                          | 64000 / 128000 | `effort`, `max_effort`, `xhigh_effort`, `adaptive_thinking`, `rejects_disabled_thinking`, `mid_conv_system`, `context_management`, `lean_prompt`, `fable_5_mitigations`, `refusal_fallback` | `high`           |
| 17  | `claude-mythos-5`   | 1e6 native_1m, 1m_beta                                          | 64000 / 128000 | —                                                                                                                                                                                           | —                |

Three entries are new relative to 2.1.195: `claude-sonnet-5`, `claude-opus-5`
and `claude-mythos-5`. The last is the notable one — **`claude-mythos-5` is now
catalogued**. Under 2.1.195 it had no catalogue entry at all and was recognised
only by name in individual predicates.

---

## 6. D3 — Capability deltas against 2.1.195

- `claude-opus-4-6` **lost** `fast_mode`.
- `claude-opus-4-7` **lost** `fast_mode`.
- `claude-fable-5` **gained** `refusal_fallback`.
- Two capability keys are new to the lexicon: `refusal_fallback` and
  `opus_5_prompt_bundle`.

Both new keys are inert for request construction. `refusal_fallback` feeds the
server-side-fallback lane, which is armed at runtime and out of scope here.
`opus_5_prompt_bundle` selects a client-side prompt bundle; it is not a wire
field.

---

## 7. D6 (amended) — `effort_cost_index`

`effort_cost_index` is the **only static-catalogue change between 2.1.222 and
2.1.233**. The string has zero occurrences in 2.1.222 and seven in 2.1.233. It
sits between `default_effort` and `image_limits` in the entry layout, and is a
`{low, medium, high, xhigh, max}` record of costs relative to `high = 1`. It is
present on exactly four models:

| Model             | low  | medium | high | xhigh | max  |
| ----------------- | ---- | ------ | ---- | ----- | ---- |
| `claude-sonnet-5` | 0.47 | 0.74   | 1    | 2.41  | 5.59 |
| `claude-opus-4-8` | 0.72 | 0.90   | 1    | 1.65  | 1.88 |
| `claude-opus-5`   | 0.67 | 0.76   | 1    | 1.60  | 1.70 |
| `claude-fable-5`  | 0.60 | 0.77   | 1    | 1.74  | 1.91 |

**Verification outcome.** The field was traced through every read site and it
feeds no wire-visible decision: nothing in request construction — effort
selection, beta gating, token limits — reads it. It is cost data for the client's
UI and mode advisor, in the same class as `pricing` and `advisor_rank`. It is
therefore omitted from this package's catalogue; the decision is recorded in
`docs/source-trace.md`.

**Correction to an earlier record:** `fallback_chain` is **not** a field of the
static catalogue. The static entries carry a single `fallback_3p` string. A
`fallback_chain` array exists only in the zod schema for remote-configuration
overrides, which is out of scope.

---

## 8. D4 — `max_output_tokens` resolver (identical in 2.1.222 and 2.1.233)

Resolution order:

1. The catalogue entry's `{default, upper}`.
2. Legacy fallbacks for ids with no catalogue entry: `claude-3-opus` and
   `claude-3-haiku` → 4096 / 4096; `claude-3-sonnet` → 8192 / 8192; anything
   else → 32000 / 128000.
3. Override 1 — the `heather_vale` remote-configuration object. **Out of scope**
   for this package (see §13).
4. Override 2 — when the request's `max_tokens` is at least 4096, `upper` becomes
   that `max_tokens` and `default` becomes `min(default, upper)`.

---

## 9. D5 — the 1M-context predicate

**Corrected.** An earlier record described this gate as catalogue-driven, via
the per-model `native_1m`, `supports_1m_beta` and `supports_1m_suffix` flags of
§5. That is wrong. The predicate that decides whether `context-1m-2025-08-07`
joins the base beta list is **purely marker-based**: it tests the model
identifier for a `[1m]` substring and consults no catalogue entry at all.

The whole function, verbatim, in 2.1.233 at absolute offset `287567706`:

```js
function KE(e) {
  if (lce()) return !1;
  return /\[1m\]/i.test(e);
}
```

and in 2.1.222 at absolute offset `263213749`:

```js
function ZS(e) {
  if (c9e()) return !1;
  return /\[1m\]/i.test(e);
}
```

Both are 57 bytes and token-identical; the pair differs only by minified name.
`lce()` / `c9e()` is the kill switch reading the environment variable
`CLAUDE_CODE_DISABLE_1M_CONTEXT`. There is **no** hardcoded model identifier in
this chain, in either version.

The consequences of a marker-only gate are worth stating plainly, because they
are counter-intuitive and they are what the package must reproduce:

- A model declaring `native_1m`, presented **without** the `[1m]` suffix, does
  **not** get the beta.
- A model declaring `supports_1m_beta`, presented without the suffix, does
  **not** get the beta either.
- **Any** identifier carrying `[1m]` gets the beta, with **no** validation that
  the model supports 1M context at all — including identifiers absent from the
  catalogue.

The catalogue flags therefore do not participate in emitting this beta on the
base list. They remain transcribed in §5 as catalogue data, and
`supports_1m_suffix` describes which models the client's own UI is willing to
attach the marker to — a different question from which requests carry the beta.

### The `claude-mythos-5` red herring

There is no `claude-mythos-5` special case in the 1M chain. The only `mythos`
literal anywhere in it is `"claude-mythos-preview"` — a **different
identifier** — and it sits in the native-1M chain (`t2` / `xO`, helper `L4u`),
not in the beta gate. That chain feeds `w4u`, which **appends** the `[1m]`
suffix to native-1M models; it is an identifier-normalisation path, and its
presence on the request path is **not confirmed**.

### Alternative paths, all out of scope

Four routes can produce the 1M beta outside the base list. None is modelled:

| Route                            | Nature                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `w4u` suffix auto-append         | Identifier normalisation for native-1M models. Not confirmed on the request path. |
| `EMo` / `kelp_forest_sonnet`     | Remote-configuration gate, and only for `claude-sonnet-4-6`.                      |
| `ANTHROPIC_BETAS`                | Process environment.                                                              |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | Process environment; the kill switch inside `KE` / `ZS` above.                    |

### What the package does

The package gate is

```
policy.oneMillionContextEnabled && (use1MContextOverride ?? /\[1m\]/i.test(model))
```

which is faithful to the upstream predicate: the same regular expression against
the same input, with the environment kill switch necessarily absent since the
package reads no environment. `use1MContextOverride` is a documented **package
extension** — a consumer seam that substitutes the marker test for callers who
resolve the decision themselves. It replaces only the marker half; the profile
policy gate still applies. Recorded in `docs/source-trace.md` under governance
ledger L10 and locked by `test/validation/beta-overrides-1m.test.ts`.

---

## 10. D7 — the billing block

This is **text inside the system prompt**, not an HTTP header; the consumer
matches it with `startsWith`. Two fixed segments followed by five optional ones,
in this order:

```
x-anthropic-billing-header: cc_version=<VERSION>.<fp>; cc_entrypoint=<e>;[ cch=00000;][ cc_workload=<w>;][ cc_is_subagent=true;][ cc_prev_req=<r>;][ cc_prompt_id=<p>;]
```

New in 2.1.233 relative to 2.1.222:

1. **`cc_prompt_id` segment.** Emitted when the value is defined **and** matches
   `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, on
   `firstParty` against an Anthropic host.
2. **`cc_prev_req` is now regex-validated** in the builder against
   `/^req_[A-Za-z0-9_-]{1,36}$/`. A value outside that shape is **silently
   omitted**. In 2.1.222 the builder performed a truthy check only, so a
   malformed value would have been emitted verbatim.
3. **An `ignoreEnvOptOut` option** that disregards `CLAUDE_CODE_ATTRIBUTION_HEADER`
   under first-party conditions. **Out of scope** — it is environment and process
   state, and mirrors the `heather_vale` decision.

The fingerprint algorithm is **unchanged**: salt `59cf53e54c78`, plus the
characters at indices 4, 7 and 20 of the first non-meta user message (each
missing character contributing `"0"`), plus `VERSION`; SHA-256, hex, first three
characters.

---

## 11. Transport envelope (re-verified for 2.1.233, not inherited)

- **Endpoint** — `/v1/messages?beta=true`, confirmed at the
  `beta.messages.create` call site.
- **`anthropic-version`** — `2023-06-01`.
- **User agent** —
  `claude-cli/2.1.233 (external, ${CLAUDE_CODE_ENTRYPOINT ?? "cli"}[, agent-sdk/..][, client-app/..][, workload/..])`.
- **`x-app`** — `cli`, or `cli-bg` for background work.
- **CLI default headers** — `x-app`, `User-Agent`, `X-Claude-Code-Session-Id`,
  plus `ANTHROPIC_CUSTOM_HEADERS`, plus the optional remote-container,
  remote-session, client-app, agent-id and parent-agent-id headers. Identical
  between 2.1.222 and 2.1.233.
- **SDK `buildHeaders`** — byte-identical between 2.1.222 and 2.1.233. Order:
  idempotency header → SDK defaults (`Accept`, `User-Agent`,
  `X-Stainless-Retry-Count`, optional `X-Stainless-Timeout`, the six platform
  headers, `anthropic-version`) → auth → default headers → body headers →
  per-request headers.
- **The nine `X-Stainless-*` names are unchanged.**

Two differences, one of which matters:

1. **`X-Stainless-Package-Version` changes value**, `0.94.0` → **`0.112.1`**,
   because the bundled SDK moved. This is a real change to the `/v1/messages`
   envelope: the header name is the same, the emitted value is not. A profile
   pinned to 2.1.233 must therefore carry `sdkVersion` `0.112.1`.
2. `X-Stainless-Helper-Method` is now spelled `x-stainless-helper-method`.
   Wire-equivalent (HTTP field names are case-insensitive) but byte-different,
   and it appears only in the streaming helper — not on the primary request.

---

## 12. Method caveats

Recorded so a reader can judge the strength of each claim rather than taking the
document as uniformly verified.

1. **Beta selection logic was not diffed instruction by instruction.** The
   prefix of the base selection function — registry entry to `anthropic-beta`
   header — was not literal-diffed between 2.1.222 and 2.1.233. Mitigation is
   layered rather than absolute: the registry array is identical, every derived
   set is identical, the transport envelope is identical, and the golden
   fixtures capture any drift the moment it reaches the wire.
2. **Auxiliary gates of the server-side-fallback lane were not fully resolved.**
   Immaterial here: the lane is armed at runtime and is out of scope.
3. **The origin of `sdkBetas` (`surfaceCapabilities`) was not traced.** It
   affects Agent SDK consumers only, not the CLI wire path analysed here.

---

## 13. Out of scope for this package

This package is a pure request builder: no filesystem access, no network access,
no environment reads. The following are therefore **permanent, deliberate
divergences** from the genuine client rather than gaps to be closed later.

| Mechanism                                       | Why it is out of scope                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `heather_vale` output-token override            | Remote configuration. Fetching it would require network I/O.                                              |
| `ignoreEnvOptOut`                               | Environment and process state, read from `CLAUDE_CODE_ATTRIBUTION_HEADER`.                                |
| `per_turn_effort` capability                    | Only obtainable through a remote-configuration catalogue override; no static entry declares it.           |
| `server_side_fallback`, `fallback_credit` lanes | Armed by runtime conversation state that a request builder does not observe.                              |
| `tengu_*` remote gates                          | Remote configuration, all defaulting to false. The default-off behaviour is what this package reproduces. |

Each of these resolves to "emit nothing" under default conditions, which is
exactly what a package with no I/O does anyway. The divergence is therefore
invisible on the wire for a default first-party install, and is documented here
so that it stays a known quantity rather than an assumption.
