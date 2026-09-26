<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

> **Where this document came from**
>
> Unlike [`claude-code-2.1.233-analysis.md`](claude-code-2.1.233-analysis.md), this file is **not** a
> verbatim copy of an upstream document. The shared library's own 2.1.280 analysis
> (`docs/protocol/versions/claude-code-2.1.280-analysis.md` in
> [`claude-code-wire-compat`](https://github.com/marco-jardim/claude-code-wire-compat), the package
> this plugin depends on for request composition) runs to roughly 2,600 lines of byte-offset
> forensics — hashes, minified-identifier collision tables, and transcribed decompiled functions. That
> level of detail belongs in the library, not duplicated here. This document is a plugin-authored
> **synthesis** of that analysis, condensed to exactly what a reader of this plugin's mimicry contract
> needs, and it cites the library source by path at every claim rather than re-deriving anything from a
> binary.
>
> **Why it lives here.** `scripts/check-invariants.mjs` requires a
> `docs/claude-code-<version>-analysis.md` matching the `CLAUDE_CODE_<x>_<y>_<z>_PROFILE` symbol
> imported by `lib/mimicry/wire-compat.mjs`. That symbol is now `CLAUDE_CODE_2_1_280_PROFILE`, so the
> analysis backing that emulation claim has to be readable from this repository.
>
> **Sources consulted**, each cited again at its point of use below:
>
> - `docs/protocol/versions/claude-code-2.1.280-analysis.md` (the library's own binary-derived
>   analysis; sections 1, 4, 5, 6.3–6.7, 7.1–7.8, 9, 13, 14 are the ones this document draws from)
> - `CHANGELOG.md` — `claude-code-wire-compat` `0.6.0` (the 2.1.280 profile's introduction) and the
>   fork `claude-code-wire-compat`'s `0.7.0` (the body-prose Unicode policy the plugin now depends on)
> - `MEMORY.md` — the 2026-09-23 entries "claude-code-2.1.280: seven port decisions",
>   "claude-code-2.1.280 behaviour-flag audit: no new flag", "corrections to the 2.1.280
>   behaviour-flag audit entry", and "claude-code-2.1.280: the shared model-id normalizer reaches the
>   previous pin"; and the 2026-09-24 entry on the `tool_choice` `"any"` demotion
> - `src/betas.ts` (the composable-registry push sites, roughly lines 232–467)
> - `src/profiles/claude-code-2.1.280.ts` and `src/profiles/beta-registry-2.1.280.ts` (the ported
>   catalogue and registry data)
> - `src/thinking.ts` (the thinking-budget floor and the `tool_choice` guard input)
> - `src/request-body.ts` (the `tool_choice` `"any"` demotion site)
> - `src/violation.ts`, `src/redaction.ts`, `src/unicode.ts` (the 0.7.0 body-prose Unicode policy and
>   its `safeDetails` diagnostic fields)
> - `test/fixtures/golden/outgoing-default-path-2.1.280.json` (the sealed default-path request this
>   document's beta literal is checked against)
>
> **Evidence tags below reuse the library's own convention** exactly (`docs/protocol/versions/claude-code-2.1.280-analysis.md`
> §1.3):
>
> | Tag                  | Meaning                                                                                   |
> | -------------------- | ----------------------------------------------------------------------------------------- |
> | `[BIN]`              | Transcribed by the library from the genuine client binary at a stated offset              |
> | `[DER]`              | Derived by the library from `[BIN]` facts evaluated under stated default conditions       |
> | `[UNR]`              | Located but not resolved by the library; the open question is stated explicitly           |
> | `[library-decision]` | A choice the library made about what to port, not a claim about the genuine client's wire |
>
> A claim tagged here with any of the first three carries the library's own tag; this document adds no
> new binary evidence of its own.

---

> **Provenance (this repository)**
>
> - Authored in this repository, as a synthesis of external analysis
> - License: `GPL-3.0-or-later`
> - Method: reading and citing the shared library's own binary-derived documentation and source, not
>   independent binary extraction

# Claude Code 2.1.280 Analysis

- **Date**: 2026-09-26
- **Emulated profile**: `claude-code-2.1.280-sdk-0.112.1` (`CLAUDE_CODE_2_1_280_PROFILE`,
  `@tormentalabs/claude-code-wire-compat` `0.7.0`)
- **Compared against**: `2.1.233` (`docs/claude-code-2.1.233-analysis.md`, the plugin's previous
  baseline)
- **Full byte-offset evidence**: `docs/protocol/versions/claude-code-2.1.280-analysis.md` in the
  library source tree. This document does not repeat offsets; it cites the section that carries them.

---

## 1. Beta composition on the pinned first-party OAuth path

The library derives the complete, ordered `anthropic-beta` header the genuine 2.1.280 client sends on
a first request under a fixed scenario — `claude-opus-5-5`, first-party OAuth, interactive REPL,
adaptive thinking, caller supplies no `thinking.display`, 5-minute cache, every remote flag at its
shipped default (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §7.6). `[DER]` That literal
is sealed in this plugin's own fixture, `test/fixtures/golden/outgoing-default-path-2.1.280.json`:

```
claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,
thinking-token-count-2026-05-13,context-management-2025-06-27,
prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,
per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,
mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,
thinking-binding-controls-2026-08-01,thinking-display-updates-2026-08-18,
cache-diagnosis-2026-04-07
```

with body `thinking: {type: "adaptive", display: "updates"}` and no `output_config` asserted either
way (§7.6.1 leaves that field's presence unestablished — see §11 below).

### 1.1 Always-on core (unconditional on first-party OAuth, non-Claude-3)

| Beta                              | Gate, condensed                                                        | Tag     |
| --------------------------------- | ---------------------------------------------------------------------- | ------- |
| `claude-code-20250219`            | any model except Haiku                                                 | `[DER]` |
| `oauth-2025-04-20`                | OAuth session (fires through `ft()`, not the API-key disjunct — §6.4)  | `[DER]` |
| `interleaved-thinking-2025-05-14` | model declares the capability, `DISABLE_INTERLEAVED_THINKING` unset    | `[DER]` |
| `thinking-token-count-2026-05-13` | interleaved thinking active, `thinkingTokenCountEnabled`               | `[DER]` |
| `prompt-caching-scope-2026-01-05` | first-party, unconditional                                             | `[DER]` |
| `context-management-2025-06-27`   | catalogue declares `context_management` (every non-`claude-3-*` model) | `[DER]` |
| `effort-2025-11-24`               | catalogue declares `effort`                                            | `[DER]` |
| `cache-diagnosis-2026-04-07`      | see §3 below — default-on for 2.1.280                                  | `[DER]` |

### 1.2 Conditional, catalogue- or state-gated

| Beta                                          | What decides it                                                                                      | Tag     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| `mid-conversation-system-2026-04-07`          | catalogue declares `mid_conv_system`                                                                 | `[DER]` |
| `per-turn-control-2026-07-01`                 | catalogue declares `per_turn_effort` — only `claude-opus-5-5`, `claude-fable-5-1`                    | `[DER]` |
| `mid-conversation-tool-changes-2026-07-01`    | `mid-conversation-system` fired **and** catalogue declares `mid_conv_tool_change`                    | `[DER]` |
| `mid-conversation-system-clear-at-2026-08-21` | `mid-conversation-system` fired (remote flag `tengu_sleepy_snowflake` defaults `"all"`, not `"off"`) | `[DER]` |
| `thinking-binding-controls-2026-08-01`        | thinking active — see §4                                                                             | `[DER]` |
| `thinking-display-updates-2026-08-18`         | thinking active, caller supplied no `display` — see §2                                               | `[DER]` |

### 1.3 Absent by default (registry entries with no live push site)

Of the registry's 40 entries, the library accounts for all of them across three groups: fourteen
present (above), one composed-then-removed (`redact-thinking-2026-02-12`, §2), and twenty-five absent
for a stated reason each (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §7.6, the table
following the fourteen-identifier literal). `[DER]` Grouped by reason:

- **Remote flag defaults false**: `structured-outputs-2025-12-15`, `timing-2026-09-09`,
  `inline-tools-2026-09-15`, `thinking-resumption-2026-07-17`, `advisor-tool-2026-03-01`,
  `context-hint-2026-04-09`, `prompt-caching-evict-2026-05-12`.
- **Provider-restricted**: `web-search-2025-03-05` (vertex/foundry only), `context-1m-2025-08-07`
  (needs a literal `[1m]` marker in the model id, which `claude-opus-5-5` does not carry).
- **Caller-flag-gated, unset in the default scenario**: `fast-mode-2026-02-01`,
  `dangerous-tool-use-2026-09-03`, `task-budgets-2026-03-13`, `server-side-fallback-2026-06-01`,
  `server-side-fallback-2026-07-01`, `fallback-credit-2026-06-01`, `auto-mode-classifier-2026-07-16`.
- **Cache-TTL mismatch**: `extended-cache-ttl-2025-04-11` (needs a 1-hour TTL; the scenario is 5m).
- **First-request-only null**: `message-threads-2026-08-12` (the planner is `null` before a second
  turn).
- **No `/v1/messages` push site at all**: `advanced-tool-use-2025-11-20`, `tool-search-tool-2025-10-19`,
  `mcp-servers-2025-12-04`, `files-api-2025-04-14`, `environments-2025-11-01`, `ccr-byoc-2025-07-29`
  — registry entries for surfaces outside the request-builder seam.
- **Never a beta at all** (registry members, not HTTP identifiers, consumer unresolved):
  `x-cc-internal-mid-conv-cache-promotion`, `x-cc-internal-mid-conv-cache-promotion-ok` `[UNR]`.

---

## 2. `redact-thinking` / `thinking-display-updates`: one coupled change, three surfaces

The library is explicit that this is **one** upstream branch producing a beta push, a body field, and a
removal together, and that landing any one of the three without the other two "writes bytes no genuine
client sends" (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §13 preamble). `[DER]`

1. `redact-thinking-2026-02-12` is **composed** by a four-conjunct guard (experimental betas,
   interleaved thinking, interactive session, thinking summaries not shown) — `src/betas.ts` around
   lines 249–257.
2. When thinking is active **and** the caller supplied no `thinking.display`, on the first-party path,
   a second, later site fires: it pushes `thinking-display-updates-2026-08-18`, sets
   `thinking.display: "updates"` on the outgoing body, and **splices `redact-thinking-2026-02-12` back
   out** of the already-composed beta list — `src/betas.ts` around lines 423–436, mirroring the
   library's transcription at §6.4/§7.5.
3. The splice deliberately runs **before** the caller-supplied `additionalBetas` merge, so a caller who
   explicitly asks for `redact-thinking-2026-02-12` still gets it: the merge's "not already present"
   test succeeds because the canonical copy was already removed. This ordering is `MEMORY.md`'s
   port-decision #3, `[library-decision]`.

Net effect: on the pinned default path — thinking active, no caller display — `redact-thinking-2026-02-12`
never reaches the wire, and `thinking.display: "updates"` does. When thinking is **inactive**, or the
caller supplies an explicit `display`, the first (composition) guard's own terms decide the outcome
without the second site ever firing, and `redact-thinking-2026-02-12` can reach the wire.

**This is the adapter (production) path only.** `token_economy.redact_thinking` and
`/anthropic set redact-thinking` are read in exactly one place in this plugin,
`lib/mimicry/headers.mjs`'s frozen legacy forge — confirmed by a direct search of `lib/mimicry/*.mjs`
and `index.mjs`, which finds no reference to that config key outside `lib/config.mjs` (the schema) and
`lib/mimicry/headers.mjs` (the one consumer). The adapter path that composes the default,
signature-emulation-on `/v1/messages` turn never reads it: the wire-compat package's own guards above
decide the outcome unconditionally.

That legacy forge is reached only when `_emulationEnabled` is `true` **and** the request's pathname is
outside the adapter's own surface — `index.mjs` gates `_useAdapter` on
`_emulationEnabled && (ADAPTER_MESSAGES_PATHNAMES.has(pathname) || ADAPTER_COUNT_TOKENS_PATHNAMES.has(pathname))`
(`index.mjs` around lines 3050–3052), and those two sets hold exactly `/v1/messages`, `/messages`,
`/v1/messages/count_tokens`, `/messages/count_tokens` (`lib/mimicry/adapter-input.mjs` lines 68 and 71).
So the forge fires only for the files endpoint, the models endpoint, or a gateway-prefixed route whose
pathname does not match one of those four strings — never for the default `/v1/messages` turn.
Signature emulation **off** does not reach the forge either: `index.mjs`'s
`if (!requestHeaders && !_emulationEnabled)` branch (around lines 3268–3278) runs first and calls
`buildPassthroughHeaders` (`lib/passthrough-headers.mjs`), which forwards the host's headers verbatim
plus the OAuth auth envelope and contains no redact-thinking logic at all; the legacy-forge branch right
below it (around lines 3281–3297) only runs when `requestHeaders` is still unset, which the
emulation-off branch has already prevented. A user who runs `/anthropic set redact-thinking off` today
changes nothing about the beta on their normal `/v1/messages` turns; it only affects the frozen legacy
forge on the files/models/gateway-prefixed surface reached with signature emulation **on**. See
`docs/mimese-http-header-system-prompt.md` §11.3 for where this is now stated plainly.

---

## 3. `cache-diagnosis-2026-04-07` is default-on for 2.1.280

The library resolves the gate `ppr() = Fg() && FOe() && Nn()` to `true` on every leg for a first-party
install (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §7.6.2). `[DER]` The 2.1.280 profile
therefore sets `cacheDiagnosisEnabled: true`, changed from `false` under 2.1.233
(`MEMORY.md`, 2026-09-23, decision #1). `[library-decision]` The push site itself (`src/betas.ts`
around lines 452–457) is unconditional once the flag is true, guarded only by a
"not already present" check.

Whether the 2.1.233 profile's `false` was ever correct is a **separate, open** question the library
declines to answer without that release's own binary — see §11.

This plugin's session retry latch is expected to **evict** the header via `suppressBetas` when the API
rejects it: `lib/mimicry/adapter-input.mjs`'s `buildSuppressBetas` already routes `signature.rejectedBetas`
(canonical betas the API rejected this session) into the package's `suppressBetas` input, which is the
one seam that can reach a beta the package composes itself (see S6 in
`docs/mimicry/wire-compat-divergences.md`). Because `cacheDiagnosisEnabled` now defaults `true`, a
rejection of `cache-diagnosis-2026-04-07` — which the plugin previously could not provoke, since the
legacy forge only ever added the header when the operator opted in — becomes newly reachable, and the
latch is the mechanism that evicts it.

That latch is **not** "for the rest of the session": it expires after a fixed 5-minute TTL
(`SESSION_REJECTED_BETA_TTL_MS`, `index.mjs` line 312), so a request more than 5 minutes after the
rejection re-admits the beta rather than suppressing it indefinitely. It is also keyed **per account**
(`sentBetaLatchKey`, `sentBetaSuppressionsByAccount`), so a rejection observed on one account never
suppresses the beta for a different account in the same rotation. Two categories of beta are never
latched at all: `oauth-2025-04-20` and the Claude Code identity beta (`UNSUPPRESSIBLE_BETAS`), and every
beta whose presence is coupled to a request-body field — `thinking-display-updates-2026-08-18`,
`context-management-2025-06-27`, `effort-2025-11-24`, `structured-outputs-2025-12-15`,
`fast-mode-2026-02-01`, and others in `BODY_COUPLED_BETAS` — because suppressing only the header would
leave the paired body field on a request that no longer carries the beta. `cache-diagnosis-2026-04-07`
carries no such paired field, so it remains eligible. The latch is also never written for a
`/v1/messages/count_tokens` request: `index.mjs` only computes and records `_sentLatchableBetas` when
`_betaRejectionSignal && _useAdapter && !_isCountTokens` (the `_isCountTokens`-gated block that calls
`selectLatchableRejectedBetas`, currently line 3788), since that surface has no `suppressBetas` input for
a latch to reach. Finally, if the very next retry on the **same account** (`pendingSentBetaLatch`,
checked against `sentBetaLatchKey(account)`) fails the same way, the entries just latched are dropped
immediately rather than kept for the rest of the 5-minute window (the `_latchUnderTest` block, currently
`index.mjs` lines 3761–3773).

---

## 4. `thinking-binding-controls-2026-08-01`: header only, no `block_binding`

The library separates the header decision from the body-field decision (§6.3, §13.5). `[DER]`

- **Header.** `thinking-binding-controls-2026-08-01` is sent whenever thinking is active on the
  first-party experimental path — `thinking active ∧ experimentalBetasEnabled ∧ firstParty` reduces
  the full upstream guard on the pinned path.
- **Body.** The paired body field `thinking.block_binding` needs a **second**, independent condition:
  either the environment variable `CLAUDE_CODE_POLISHED_DEWDROP` or the remote flag
  `tengu_polished_dewdrop`, both absent by default. Neither this plugin nor the shared library reads
  environment or remote configuration, so the field is permanently withheld under default conditions.

`src/betas.ts` around lines 374–381 ports the header-only half; the body field is not modelled at all,
matching the library's port table (§13, row `thinking.block_binding`): "do **not** emit; the beta is
still emitted; only the body field is withheld."

---

## 5. The nine new registry entries, ported vs. not

The registry grows 31 → 40 entries, non-uniformly inserted (`docs/protocol/versions/claude-code-2.1.280-analysis.md`
§4.1–§4.2). `[BIN]` Nine of those forty are new to this release:

| Feature key                        | Header                                        | Ported? | Why                                                                                       |
| ---------------------------------- | --------------------------------------------- | :-----: | ----------------------------------------------------------------------------------------- |
| `mid_conv_tool_change`             | `mid-conversation-tool-changes-2026-07-01`    |   yes   | new composable key, catalogue-gated (§1.2)                                                |
| `mid_conversation_system_clear_at` | `mid-conversation-system-clear-at-2026-08-21` |   yes   | new composable key, fires with `mid-conversation-system` (§1.2)                           |
| `thinking_binding_controls`        | `thinking-binding-controls-2026-08-01`        |   yes   | new composable key, header only (§4)                                                      |
| `thinking_display_updates`         | `thinking-display-updates-2026-08-18`         |   yes   | new composable key, coupled with the `redact-thinking` removal (§2)                       |
| `thinking_resumption`              | `thinking-resumption-2026-07-17`              |   no    | remote flag `tengu_thinking_block_resumption` defaults false                              |
| `per_turn_timing`                  | `timing-2026-09-09`                           |   no    | needs env `CLAUDE_CODE_PER_TURN_TIMING`; the package reads no environment                 |
| `inline_tools`                     | `inline-tools-2026-09-15`                     |   no    | remote flag defaults false, and it layers on top of `mid_conv_tool_change`                |
| `dangerous_tool_use`               | `dangerous-tool-use-2026-09-03`               |   no    | needs a caller `serverClassifier` flag the plugin never sets                              |
| `message_threads`                  | `message-threads-2026-08-12`                  |   no    | conversation-state feature above the request-builder seam (§12 of the library's document) |

`[DER]` for each "why", derived from the gates the library transcribed at each push site.

A tenth beta is newly **reachable** in this release without being new to the registry:
`per-turn-control-2026-07-01` (`per_message_effort`) already existed in the 2.1.233 registry, but no
2.1.233 catalogue entry ever declared the `per_turn_effort` capability it needs. 2.1.280 is the first
profile whose catalogue declares that capability (`claude-opus-5-5`, `claude-fable-5-1`), so this is the
first release where the composable key is worth adding — it is listed in §1.2, not in the table above,
because the registry entry itself is not new.

---

## 6. User agent and `cliVersion`

`[BIN]` (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §8.1): the template is
`claude-cli/2.1.280 (external, ${CLAUDE_CODE_ENTRYPOINT ?? "cli"}[, agent-sdk/..][, client-app/..][, workload/..])`,
identical in shape to 2.1.233, differing only in the version number. This plugin never re-types the
literal: `PROFILE_CLI_VERSION` / `PROFILE_USER_AGENT` (`lib/mimicry/adapter-input.mjs`) are derived from
`WIRE_PROFILE.cliVersion` as re-exported by `lib/mimicry/wire-compat.mjs`, which is now bound to
`CLAUDE_CODE_2_1_280_PROFILE`. `test/conformance/version-literals-retired.test.mjs` enforces that no
version literal exists outside that binding. Moving the emulated baseline was therefore the one-line
change at that seam, not a text edit anywhere else — see
`docs/mimicry/wire-compat-divergences.md`, "Syncing a new package version," step 2.

---

## 7. Unchanged: Stainless headers and the fingerprint

`[BIN]` (§8.1 of the library document): the bundled SDK version did not move between 2.1.233 and
2.1.280 — `x-stainless-package-version` stays `0.112.1`, so the nine `X-Stainless-*` header names and
their values are byte-identical to the 2.1.233 baseline. The endpoint (`/v1/messages?beta=true`) and
`anthropic-version` (`2023-06-01`) are unchanged. The billing-block fingerprint algorithm is
re-transcribed rather than assumed for this release (§13.1 item 3): salt `59cf53e54c78`, character
positions `[4, 7, 20]` of the first non-meta user message's first text block (each missing character
falling back to `"0"`), concatenated with the version string, SHA-256, first three hex characters —
identical to what this package already implements.

---

## 8. Model catalogue additions and the server-side version gate

The catalogue grows 17 → 20 entries, adding `claude-opus-5-5`, `claude-fable-5-1` and
`claude-mythos-5-1` (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §5). `[BIN]`
`claude-opus-5-5` becomes the new default for the `opus` alias and `claude-fable-5-1` the new default
for `fable` (§5.6); `claude-mythos-5-1` has no `aliases` entry.

**The correctness stake.** Two independent external reports (`[EXT-1]` a GitHub issue on
`1jehuang/jcode`, `[EXT-2]` a GitHub issue on
`NousResearch/hermes-plugin-claude-subscription-directsdk`, both filed 2026-09-22) observe the Anthropic
API refusing `claude-opus-5-5` to a client presenting an older version signal — "Claude Code 2.1.257
does not support this model; version 2.1.280 or newer is required" — and, in some paths, silently
falling back to `claude-opus-5` instead of failing outright (§9.1). Neither report identifies the exact
header or field the server keys on, so this is recorded as "a client-version signal is gated," not
narrowed to the user agent specifically. `[EXT-1]` `[EXT-2]`

The consequence for this plugin is unconditional: **a profile still emulating 2.1.233 cannot address
`claude-opus-5-5` at all.** The 2.1.280 default-profile switch is therefore a correctness requirement
for reaching the current default model, not a cosmetic version bump.

---

## 9. `tool_choice` `"any"` demotion and the thinking-budget floor (shared across profiles)

Both of these are library-side policy decisions that apply to **every** pinned profile, not only
2.1.280 — recorded here because the evidence that justifies them was gathered during the 2.1.280 port.

**`tool_choice` demotion.** The genuine client demotes only `{type: "tool", name}` to `{type: "auto"}`
while extended thinking is active; `{type: "any"}` is left alone by the transcribed code
(`docs/protocol/versions/claude-code-2.1.280-analysis.md` §6.6). `[BIN]` Since 2026-09-24 the shared
library additionally demotes `{type: "any"}` under the same condition, on every profile, as a
deliberate, recorded divergence from that transcription: the Messages API rejects **every** forced
`tool_choice` while extended thinking is on, so passing `"any"` through would only produce an HTTP 400
(`src/request-body.ts`, `src/thinking.ts`; `MEMORY.md`, 2026-09-24). `[library-decision]`

**Thinking-budget floor.** For a resolved `{type: "enabled"}` thinking request, the genuine client
computes a default budget from the model's own upper output limit minus one, substitutes the caller's
`budgetTokens` when the caller's own request was itself `type: "enabled"`, then clamps:
`Math.max(1024, Math.min(maxTokens - 1, requested))` — transcribed for 2.1.280 only
(`docs/protocol/versions/claude-code-2.1.280-analysis.md` §6.1). `[BIN]` No older analysis document in
the library's history transcribes this computation at all, so the 1024-token floor and the
caller-`type`-must-match-`"enabled"` guard are evidenced for 2.1.280 specifically. The library applies
both to every pinned profile as one shared behaviour (`src/thinking.ts`) rather than gating them by
profile id, on the same reasoning already used for the model-id normalizer ladder: nothing asserts that
older clients lacked the floor, and the shared behaviour is the conservative default.
`[library-decision]`

---

## 10. The 0.7.0 body-prose Unicode policy

`@tormentalabs/claude-code-wire-compat` `0.7.0` changes what the request builder accepts as body prose
(`CHANGELOG.md`, `[0.7.0]`). `[library-decision]`

- **Accepted now.** Message content, `tool_result` content, `tool_use` input, tool descriptions and the
  `system` field accept **every well-formed UTF-16 string**. C0 control characters other than
  TAB/LF/CR, `DEL`, and the C1 range no longer fail the local pre-flight screen in prose positions.
- **Still rejected.** **Lone surrogates** remain rejected everywhere: raw UTF-8 encoding would replace
  an unpaired surrogate, while JSON serialization escapes it instead — neither produces valid scalar
  text, so there is no safe encoding to send. `src/unicode.ts`'s `classifySurrogateAt` remains the
  single authority for this distinction.
- **Unaffected.** Headers, metadata identifiers, and runtime identity fields keep their strict rules.
  Model and tool identifiers keep control screening. Opaque image/file/URL data, thinking signatures,
  redacted-thinking data and search-result source identifiers also keep control screening — only
  _prose_ positions relaxed.
- **Byte-stable for prior input.** Every input accepted before 0.7.0 produces the same bytes after it;
  no golden fixture or digest needed resealing. A consumer that relied on the library to scrub control
  characters from body prose must now sanitize at its own display boundary — a request the remote API
  rejects surfaces as a remote error rather than a local abort.

**Diagnostics.** A rejection now carries safe, additive detail through the public builder and the error
sanitizer: `violationReason`, `violationPath`, `violationOffset`, `violationCodeUnit`,
`violationTextLength` and `violationInKey` (`src/violation.ts`, `src/redaction.ts`). Dynamic user keys
in a path are masked, paths are capped at segment boundaries, numeric diagnostics are bounded, and no
caller text excerpt is ever included. This plugin already folds `error.safeDetails` into the thrown
message (`foldSafeDetailsIntoMessage`, `lib/mimicry/wire-compat.mjs`), so these six fields become
visible in a stack trace without any change on this plugin's side.

This policy is orthogonal to the 2.1.280 protocol profile — it changes what the builder accepts as
input, not what a genuine 2.1.280 client puts on the wire — but it ships in the same `0.7.0` release
this plugin now depends on, so it is recorded here alongside the profile it travels with.

---

## 11. Open questions / known limitations

- **Was `cacheDiagnosisEnabled: false` ever correct for 2.1.233?** The library states plainly that it
  cannot settle this without acquiring the 2.1.233 binary and transcribing `ppr()` from it directly —
  inferring one release's value from another's is exactly what its runbook forbids
  (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §7.6.2). `[UNR]` The 2.1.233 profile is left
  unchanged pending that work.
- **Does `output_config.effort` survive the `clear_at`/effort push site?** The library locates the call
  site (`gTe`, byte 13602839) that deletes and rewrites `Mi.output_config` but does not transcribe what
  it writes back — whether a caller-omitted effort is repopulated from the model's catalogue default is
  not established. The §7.6 fourteen-identifier literal therefore makes no claim about
  `output_config`'s presence in the default-path body. `[UNR]`
- **No live 2.1.280 traffic has been captured.** Every `[BIN]`/`[DER]` claim above is static analysis of
  the extracted release bundle; the sealed default-path literal is falsifiable against the **package**
  (which fixtures in this plugin and in the library both pin), not yet against genuine wire traffic from
  a real 2.1.280 install (`docs/protocol/versions/claude-code-2.1.280-analysis.md` §14 item 5). `[UNR]`
- **Deliberate divergences carried forward, not defects to close.** The library does not port: the
  `web_search`/`advisor-tool` push conditions (vertex/foundry only, and a remote flag respectively —
  see `docs/mimicry/wire-compat-divergences.md` for this plugin's own, separate divergence on the same
  two betas); the permissive "no catalogue entry" fallbacks inside `Tue`/`Sw`/`GF` for an unrecognised
  model string; the remote served-capability override layer (`np`/`gq`); and the exact
  presence-vs-position rule for Haiku's `isAgenticQuery` re-push of `claude-code-20250219`. Each is
  recorded at its point of use in the library's own §13 port table. `[library-decision]`
- **Grapheme truncation follows the runtime's own ICU, not a pinned one.** `lib/unicode-text.mjs`'s
  `truncateGraphemes` — the helper the rolling summarizer uses to cut text without splitting a
  surrogate pair or a grapheme cluster — draws its boundaries from `new Intl.Segmenter(undefined, {
granularity: "grapheme" })`, i.e. whichever Unicode-segmentation tables the host JS engine ships.
  opencode itself runs on Bun (JavaScriptCore), while this plugin's test suite runs on Node (V8); the
  two engines' bundled ICU/segmentation data can disagree on where a cluster boundary falls for newer
  emoji ZWJ sequences and some Indic/complex-script sequences. A test asserting an exact truncated
  byte sequence under Node is therefore not a guarantee that a live opencode session under Bun cuts a
  rolling-summary section at the same code-unit offset — this is a property of the runtime boundary,
  not a bug in `truncateGraphemes` itself, and nothing in this codebase pins a specific segmentation
  table to close it.
- **Pre-existing `formatTemplate` edge cases, left as-is.** `lib/rolling-summarizer.mjs`'s
  `formatTemplate` has three sharp edges this pass did not change: (1) when `maxChars` does not exceed
  the closing tag's own length (`"\n</session-summary>".length`, 19), the function returns that bare
  closing tag as `out` — which is itself longer than `maxChars`, so the "hard cap" is not actually
  enforced below that threshold; (2) a section can shrink to `""` when its very first grapheme cluster
  is wider, in UTF-16 code units, than the truncation target computed for it — `truncateGraphemes`'s
  documented contract for an over-wide leading cluster — which a single complex ZWJ emoji sequence at
  the start of a summarized section can trigger even though the target is floored at
  `EMPTY_SECTION.length` (6, for the literal `"(none)"`); (3) `render()`'s
  `TEMPLATE.replace("{topics}", sec.topics).replace(...)` chain passes each section as a plain string
  replacement, so a summarized section that itself contains a literal `$&`, `$$`, `` $` ``, `$'`, or
  `$<name>` is silently reinterpreted by `String.prototype.replace`'s special-replacement-pattern
  syntax instead of being inserted verbatim.
