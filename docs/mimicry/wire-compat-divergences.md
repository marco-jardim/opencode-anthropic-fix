# Wire-Compat Package Divergences

Use this table when reasoning about a difference between what this plugin puts on the wire and what
`@tormentalabs/claude-code-wire-compat` would put on the wire for the same host request. Both construction paths are
exercised side by side in `test/conformance/shared-package-parity.test.mjs`, which compares URL, method, headers and
body byte-for-byte after normalising genuine per-run nondeterminism.

**The direction of the difference inverted once, and then the ground moved again.** That suite was written when the
shared package was the incomplete implementation and the plugin was the reference. Since the package's Wave 7 work
(`v0.1.0-rc.10`) and the max-tokens clamp (`v0.1.0-rc.11`), the package is derived directly from a genuine client
binary — 2.1.195 then, 2.1.233 since the `0.3.0` default profile — and is the reference. Since `index.mjs` started routing the first-party `/v1/messages` turn through the adapter,
the plugin's production path **is** the package plus plugin-owned policy — so most rows below are no longer "two
implementations disagree" but "the plugin deliberately steers the package through a seam".

**Nothing in this document is a bug report against the plugin's runtime behaviour.** Each open row is a deliberate,
recorded decision to keep the plugin emitting what it emits today. Changing what goes on the wire in production is a
product decision with its own risk and rollout, not a side effect of upgrading a dependency. This document exists so
that the decision stays visible and does not decay into an accident.

**Governing rule ("Option A").** When the consumer loses a capability because of the package's validation, the fix is
an opt-in seam in the package — never a degradation of the consumer. The single exception is a capability that was
itself a defect: then the fix belongs in the consumer. `stainlessHelper` markers in the body were that exception.

## Package version state (read this before running `npm install`)

- `package.json` specifies the **`latest` dist-tag**, not a version. The resolved version, its
  registry tarball URL and its `sha512` integrity live in `package-lock.json`, and `npm ci` installs
  exactly that. Run `npm ls @tormentalabs/claude-code-wire-compat` to see what is installed.
- The wire shape follows from that: the adapter calls the package **without a `profile` argument**, so
  the plugin inherits the package's `DEFAULT_PROFILE`. `0.1.0` defaulted to `claude-code-2.1.195`;
  `0.3.0` defaults to `claude-code-2.1.233-sdk-0.112.1`. A package release can therefore move the
  wire, which is the whole point of the arrangement and the reason the golden suite exists.
- S8 and S9 shipped in `0.1.0-rc.17` and are present in every release since.

The lockfile and `docs/shared-package-provenance.md` must agree with the policy.
`test/conformance/package-dependency-policy.test.mjs` fails if they drift, which is what caught this
document's predecessor: `rc.17` was installed with `--no-save` while the pin still read `rc.16`, so a
clean `npm install` would have silently downgraded and taken both seams out with it.

## How each divergence is held in place

Two fields are excluded from the byte-for-byte comparison, and each exclusion is backstopped by a dedicated test that
pins the exact value both sides produce, so neither can drift unnoticed:

| Field                   | Excluded in        | Pinned by                                           | Why                                    |
| ----------------------- | ------------------ | --------------------------------------------------- | -------------------------------------- |
| `anthropic-beta`        | `normalizeHeaders` | `BETA_HEADER_GOLDEN`, 8 model rows as exact strings | Real, permanent divergence (see row 1) |
| `body.metadata.user_id` | `normalizeBody`    | —                                                   | Per-run nondeterminism                 |

`thinking` used to be a third exclusion. It was removed once both paths started emitting the same value: it had
stopped excluding any difference and would only have hidden a future real one. `max_tokens` never needed one — the
difference is invisible at the fixture's values (see row 6).

The pinning test for `thinking` (`ENABLED_THINKING_GOLDEN`) stays, and not out of caution: the differential vector
catches the two paths diverging **from each other**, but it cannot catch them drifting **together**, which is exactly
what a package bump does.

> **This mechanism does not scale.** Two exclusions is the practical ceiling. If a third field diverges, the honest
> move is to invert the suite's default — compare against the package as the reference and enumerate the plugin's
> known-stale fields — rather than keep carving exceptions out of a comparison that is supposed to be exhaustive.
>
> The reverse question is worth asking on every bump: an exclusion whose two sides have converged is not free, it is
> a blind spot with a comment on it. `thinking` was one for several release candidates.

## Outbound divergences

Upstream symbol names and byte offsets refer to the genuine client binary the row was traced against — 2.1.195 for
rows written before the `0.3.0` default-profile move, 2.1.233 after — as recorded in the package's
`docs/source-trace.md` and, for 2.1.233, in [`../claude-code-2.1.233-analysis.md`](../claude-code-2.1.233-analysis.md).

| #   | Field                                | Plugin emits                                      | Package emits                                     | State                                                                                           |
| --- | ------------------------------------ | ------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | `claude-code-20250219` on Haiku      | present (appended last)                           | absent                                            | **Open** — deliberate, re-added through S1 `additionalBetas`.                                   |
| 2   | `web-search-2025-03-05`              | present on first party                            | absent                                            | **Open** — deliberate, re-added through S1 `additionalBetas`.                                   |
| 3   | `advisor-tool-2026-03-01`            | present on non-`claude-3-*`                       | absent                                            | **Open** — deliberate, re-added through S1 `additionalBetas`.                                   |
| 4   | `mid-conversation-system-2026-04-07` | present on `claude-opus-4-8` and `claude-fable-5` | present on `claude-opus-4-8` and `claude-fable-5` | **Closed** — the adapter path composes it; both columns of `BETA_HEADER_GOLDEN` carry it.       |
| 5   | `thinking` on the enabled branch     | `{"budget_tokens":7999,"type":"enabled"}`         | `{"budget_tokens":7999,"type":"enabled"}`         | **Closed** — the plugin's first-party turn routes through the package, so both emit the golden. |
| 6   | `max_tokens`                         | capped at the model's default output limit        | capped at the model's default output limit        | **Closed** — same reason; both paths land on 32000 for `max_tokens: 40000` on sonnet-4-5.       |

Upstream truth for the rows that are still open:

- Row 1: the base beta set opens `if(!isHaiku) push(claudeCode)`, so the genuine client never carries it on Haiku.
- Row 2: the only two push sites are guarded by `provider==="vertex"` and `provider==="foundry"` (`IPt`).
- Row 3: the identifier exists in the registry (`f2r`) but no push site was found anywhere in the binary.

### Rows 1 to 3, in detail

These are the only rows where the plugin still puts something on the wire that the genuine client does not, and they
survive on purpose. `buildAdditionalBetas` (`lib/mimicry/adapter-input.mjs:347`) pushes `web-search-2025-03-05` when
`supportsWebSearch(model)`, `advisor-tool-2026-03-01` on any non-`claude-3-*` model, and `CLAUDE_CODE_BETA_FLAG` when
`isHaikuModel(model)` — the last one so Haiku subagents reached through model-router delegation still get full mimic
behaviour.

Because they arrive through `additionalBetas` rather than through the package's own composer, they land at the END of
the header, after every beta the package composed. `BETA_HEADER_GOLDEN` pins that order on both columns as exact
strings, so a change on either side fails.

### Row 4, in detail

Previously "the plugin does not emit it". It does now, and not because anyone added it: the plugin stopped composing
the beta header itself for the first-party turn. `pluginPath` and `packageOnly` for `claude-opus-4-8` and
`claude-fable-5` both carry `mid-conversation-system-2026-04-07` in the package's position, ahead of `effort-2025-11-24`.

### Row 5, in detail

Two independent differences in one field, both now shared by the two paths: the package clamps an over-limit budget
the way upstream does (`Tr = Math.min(Fi - 1, Tr)`, so 10000 against `max_tokens: 8000` becomes 7999), and it emits
`budget_tokens` before `type`, which is upstream's insertion order for the enabled branch. Key order is load-bearing
because the parity suite compares serialised bytes, so this is pinned as an exact string rather than with `toEqual`.

`thinking` is no longer excluded from the byte-for-byte comparison. The exclusion existed because the two sides
disagreed on the enabled branch; the first-party turn now routes through the package, so both emit the same object
and the exclusion was excluding nothing. It was removed and the differential vector passes with the field compared as
bytes — which is the evidence that closes it. The pinning test on its own would not have been enough: a captured
single-value golden proves the two sides agree on that golden, not on every vector.

### Row 6, in detail

The plugin does have a `resolveMaxTokens` (`lib/mimicry/request-helpers.mjs:227`), but it is a **policy** cap for
context-window economy, not a protocol cap against the model's limit. Its first rule is that a caller-supplied value
wins outright (`request-helpers.mjs:229`), so the model is never consulted — which is exactly why the package's cap is
the one that bites, on both paths.

This row is invisible to the byte-for-byte vectors: `HOST_BODY.max_tokens` is 8000 and every model those vectors
exercise has a default output limit of 8192 or above, so the cap cannot bite. It only appears once a caller asks for
more than the model will give — for example 40000 on `claude-sonnet-4-5`, whose default is 32000. Two tests hold this
in place, one pinning 32000 on both paths at 40000 and one control asserting both paths still return 8000 at 8000.

The bound is the model **default**, not its upper limit. Upstream only ever compares the
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment value against `upperLimit`, and the package reads no environment.

## Seams the plugin uses, and what each one keeps alive

Every entry here was a capability the plugin lost — or would have lost — when the adapter took over request
construction. Under Option A each was answered with an opt-in seam in the package, not by degrading the plugin.

| Seam | Field                                | Set in                                             | What it preserves                                                                                                                                                          |
| ---- | ------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `additionalBetas`                    | `adapter-input.mjs:347` (`buildAdditionalBetas`)   | Rows 1–3, `custom_betas` (shortcut-expanded), files-api, structured-outputs, host-SDK betas rescued from the dropped `anthropic-beta` header                               |
| S2   | `betaOverrides.use1MContext`         | `adapter-input.mjs:554`                            | The plugin's `hasOneMillionContext` rule instead of the package's `/\[1m\]/iu` default                                                                                     |
| S3   | `cacheControl.suppressIdentityBlock` | **not used by the plugin**                         | Would drop the identity block's `cache_control` marker and keep the block. See the name-collision note below.                                                              |
| S4   | `metadataOverrides`                  | `adapter-input.mjs:444` (`buildMetadataOverrides`) | `OPENCODE_ANTHROPIC_SIGNATURE_USER_ID` and `CLAUDE_CODE_EXTRA_METADATA`                                                                                                    |
| S5   | `extraHeaderPolicy`                  | `adapter-input.mjs:612` (`"dropConflicting"`)      | Host headers reaching the wire without overwriting canonical ones                                                                                                          |
| S6   | `suppressBetas`                      | `adapter-input.mjs:409` (`buildSuppressBetas`)     | Round-robin's `prompt-caching-scope-2026-01-05` suppression and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` — the only seam that can reach a beta the package composes itself |
| S7   | `suppressBillingBlock`               | `adapter-input.mjs:624`, `:644`                    | `CLAUDE_CODE_ATTRIBUTION_HEADER` opt-out, and half of the lean-system-prompt gate                                                                                          |
| S8   | `suppressIdentityBlock` (**root**)   | `adapter-input.mjs:648`                            | The other half of the lean-system-prompt gate                                                                                                                              |
| S9   | `preserveThinkingBlockCacheControl`  | `wire-compat.mjs:242` (**unconditional**)          | Reasoning blocks that arrive carrying `cache_control` — see below                                                                                                          |

Two more seams are used outside this table: `capabilities` (`adapter-input.mjs:662`) downgrades `adaptiveThinking` so
`OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING` is not a no-op, and `profileOverride` (`adapter-input.mjs:197`) carries
the coupled `userAgent`/`cliVersion` pair when the plugin's dynamic user agent diverges from the pinned profile.

### S8 vs S3 — two different fields with the same name

This is the sharpest edge in the whole surface and it is worth stating twice.

- **`cacheControl.suppressIdentityBlock` (S3)** — emits the canonical identity block at index 1 **without** its
  `cache_control` marker. The block, text included, stays. The plugin does **not** set this anywhere.
- **`suppressIdentityBlock` at the ROOT of `ClaudeCodeRequestInput` (S8)** — omits the identity block
  (`"You are Claude Code, Anthropic's official CLI for Claude."`) entirely. Sibling of `suppressBillingBlock` (S7).
  This is the one the plugin sets, and only inside the lean-system-prompt gate.

Both default to `false`, both are independent, and they may be combined — in which case the root seam wins because
there is no block left to mark. The package carries cross-referencing JSDoc on both (`dist/contracts.d.ts:603` and
`:803`), and `lib/mimicry/wire-compat.mjs:225-231` and `adapter-input.mjs:645-648` repeat the warning at both plugin
call sites. Do not "simplify" either comment away.

S8 also forced a redesign inside the package: `canonicalSystemPrefixLength`
(`dist/build-request.js:931`) used to infer the canonical prefix length from the POSITION of the identity text. It now
takes `evidence.billingBlockSuppressed` and `evidence.identityBlockSuppressed` as arguments
(`dist/build-request.js:1327`) and confirms structurally. With two suppression seams there are four prefix states
(2, 1, 1, 0), and the empty-prefix state was not parseable under the old positional rule.

### S9 — why it is passed unconditionally

`toClaudeCodeRequestInput` sets `preserveThinkingBlockCacheControl: true` on **every** request
(`lib/mimicry/wire-compat.mjs:242`), with no condition and no scan of the messages.

The reason is an API round-trip constraint, not a per-request property. The Anthropic API answers 400 when the client
mutates a reasoning block in the latest assistant message — _"thinking or redacted_thinking blocks in the latest
assistant message cannot be modified. These blocks must remain as they were in the original response."_ A `delete
block.cache_control` **is** such a mutation. So the plugin cannot strip the key before handing the message over, and
before S9 the package's strict thinking-block allowlist rejected the whole request with `INVALID_INPUT`, leaving the
consumer no legal move.

Gating the flag on "does some block actually carry the key" would add a traversal and a second state to get wrong, and
getting that traversal wrong reproduces exactly the `INVALID_INPUT` the seam exists to remove. With the flag on and no
such key present, the package output is byte-identical.

Scope, from the package's own contract (`dist/contracts.d.ts:858`): the allowlist grows by `cache_control` and by
nothing else. `scope`, which `text` blocks tolerate for legacy reasons, is **not** accepted on a reasoning block. The
value goes through the same `cache_control` validator every other block uses, so a malformed marker still fails closed,
and the preserved marker takes no part in the package's cache-control machinery — no TTL, no breakpoint, verbatim
passthrough.

## Divergences the plugin closed on its own side

These were the plugin's defect, so under the Option A exception they were fixed in the plugin. No seam was added.

- **`stainlessHelper` markers no longer reach the wire.** `stripStainlessHelperMarkers`
  (`lib/mimicry/headers.mjs:146`) removes `x_stainless_helper`, `x-stainless-helper`, `stainless_helper`,
  `stainlessHelper` and `_stainless_helper` from tools, messages and nested content blocks. It shares the traversal
  `walkStainlessHelperCarriers` (`headers.mjs:101`) with `buildStainlessHelperHeader` (`:118`) precisely so that what
  is READ to compute `x-stainless-helper` and what is REMOVED from the body cannot drift apart. Applied on **every**
  path: the adapter path strips inside `buildWireCompatibleRequest`, the count-tokens path inside
  `buildWireCompatibleCountTokensRequest` (both in `lib/mimicry/wire-compat.mjs`), and the frozen legacy forge right
  after `buildRequestHeaders` in `index.mjs` (non-covered endpoints only).
  Before this, the markers went to the API on every request — the API has never
  known those keys, so the package was right to reject them with `INVALID_INPUT`.

- **`context-hint-2026-04-09` is gone from every path.** The adapter path never emitted it; the legacy path used to
  push the beta in `buildAnthropicBetaHeader` and inject `context_hint: { enabled: true }` in `transformRequestBody`.
  Both push sites are now comments explaining the removal (`lib/mimicry/headers.mjs:291-297`,
  `lib/mimicry/request-body.mjs:592-596`). The genuine 2.1.195 client sends neither, so emitting them was a
  fingerprint. Pinned by a parity test asserting the beta and the body field are absent on both construction paths.

- **`token_economy.context_hint` is deprecated, not deleted.** The key still parses and still normalises
  (`lib/config.mjs:794`) so existing config files keep loading, but nothing reads it. An explicit `context_hint: true`
  makes `validateConfig` emit a one-shot `console.warn("[anthropic-auth] ...")` (`lib/config.mjs:771-780`), latched by
  `contextHintDeprecationWarned` (`lib/config.mjs:537`) so it fires once per process. The default `false` stays quiet.
  A user-facing switch that becomes a silent no-op is not acceptable in this codebase; this is the required exit.

- **The lean-system-prompt opt-in works again on the adapter path.** `token_economy.lean_system_non_main` was a silent
  no-op there. On the legacy path the decision lives in `buildSystemPromptBlocks` (`leanNonMain`,
  `lib/mimicry/system-prompt.mjs:581-587`), which returns the sanitized blocks before the billing header and the
  identity prefix are prepended — but on the adapter path those two blocks are no longer the plugin's to withhold,
  because the package composes them. `adapter-input.mjs:639-649` re-expresses the SAME conjunction
  (`lean_system_non_main === true && (requestRole === "title" || "small") && !isTitleGenerator`) as S7 + S8.

  `isTitleGenerator` is derived in `index.mjs:3196-3197` from the **pre-transform** body (`_parsedBodyOnce`). By the
  time the transport is built, the title-generator system-prompt swap has already rewritten those blocks, so detecting
  it later would give a false negative and the attribution would be dropped from a turn that must keep it.

## `/v1/messages/count_tokens` now flows through the package

Until this migration the count endpoint was the one route that stayed on the legacy forge even with signature
emulation on, on the premise that the package had no count surface. It has one:
`buildClaudeCodeCountTokensRequest`, wrapped by `buildWireCompatibleCountTokensRequest`
(`lib/mimicry/wire-compat.mjs`). `_useAdapter` in `index.mjs` now covers both endpoints and `_isCountTokens` picks
the surface; the legacy forge owns count_tokens only when signature emulation is off.

`built.url` is discarded on both surfaces, exactly as before, so the package's pinned
`https://api.anthropic.com/v1/messages/count_tokens?beta=true` never overrides a custom `ANTHROPIC_BASE_URL`.
`transformRequestUrl` already appends `?beta=true` to both endpoints, so there is no double application.

### The wire change, measured

This is an ADOPTION of the genuine binary's count request, not a regression. Upstream derives the count beta set from
the model alone and its count body carries no system prompt, no metadata and no token budget.

**Body.** Six keys become three:

| field         | legacy forge (emulation on)                                                                 | package count surface                   |
| ------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| `model`       | present                                                                                     | present, unchanged                      |
| `max_tokens`  | present                                                                                     | **dropped**                             |
| `system`      | forged 3-block Claude Code prefix, `system[1]`/`system[2]` carrying `cache_control` markers | **dropped**                             |
| `messages`    | present                                                                                     | present, unchanged                      |
| `temperature` | present                                                                                     | **dropped**                             |
| `metadata`    | `{user_id: JSON{device_id, account_uuid, session_id}}`                                      | **dropped**                             |
| `tools`       | absent                                                                                      | **added**, `[]` when the host sent none |

**`anthropic-beta`.** `filterCountTokensBetas` strips everything upstream does not send on a count turn, including the
betas the plugin pushes in through `additionalBetas`. `token-counting-2024-11-01` is still emitted, but by the package
rather than by `headers.mjs`:

- before: `oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,extended-cache-ttl-2025-04-11,context-management-2025-06-27,web-search-2025-03-05,advisor-tool-2026-03-01,token-counting-2024-11-01,redact-thinking-2026-02-12,thinking-token-count-2026-05-13`
- after: `claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01`

**Header names.** Unchanged — both constructions emit the same 17 names, verified at migration time by
diffing `buildRequestHeaders` against a count build. `buildRequestHeaders` is now the frozen compatibility
forge for endpoints outside the package surface and no longer serves count turns, so that diff is a
historical measurement, not a live invariant; the count surface's names are pinned by
`test/conformance/golden-outgoing-count.test.mjs`. Only values move.

### The count-tokens extra-header policy

Under the package default (`strict`) the first host header the package owns raises `DUPLICATE_HEADER` or
`FORBIDDEN_HEADER` and nothing reaches the wire. The plugin forwards the host header map — the opencode SDK alone
sends `content-type` and `accept` — so a count turn under `strict` would simply throw.

Since wire-compat **0.4.0** the count surface takes `extraHeaderPolicy?: "strict" | "dropConflicting"`, so
`toClaudeCodeCountTokensInput` (`lib/mimicry/wire-compat.mjs`) sets `extraHeaderPolicy: "dropConflicting"` exactly as
the main turn sets it on the transport, and the package resolves ownership conflicts itself. Only OWNERSHIP conflicts
are dropped: header syntax is still validated package-side, and a caller duplicating one of its OWN extra headers
still raises `DUPLICATE_HEADER`. The names the package dropped come back as `evidence.droppedExtraHeaderNames`
(the key is absent under `strict`).

**Historical note.** Before 0.4.0 `ClaudeCodeCountTokensInput` was a sixteen-key `Pick<ClaudeCodeRequestInput, ...>`
that excluded `extraHeaderPolicy`, and `validateCountTokensInput` runs `assertExactKeys`, so passing the key was
`INVALID_INPUT` rather than an ignored no-op. The plugin therefore carried `dropConflictingExtraHeaders` and three
exported mirrors of the package's header-ownership lists (`PACKAGE_CANONICAL_HEADER_NAMES`,
`PACKAGE_FORBIDDEN_HEADER_NAMES`, `PACKAGE_FORBIDDEN_HEADER_PREFIXES`), plus a drift guard asserting each mirror
against the package's real behaviour. All of it was deleted on the 0.4.0 adoption; the wire is byte-identical, because
the package's native `dropConflicting` resolves to the same kept/dropped set the mirrors computed.

`test/conformance/count-tokens-header-policy.test.mjs` now pins the seam instead of the mirrors: that the mapper emits
the policy, that the installed package still ACCEPTS the key (an `assertExactKeys` regression would surface as
`INVALID_INPUT` here rather than as a throwing count turn in production), and the end-to-end behaviour — an owned
header is not duplicated, an unowned one is forwarded, a forbidden one is dropped without raising, and the dropped
names appear in the evidence.

## Divergences that the package has already closed

Recorded so nobody re-opens them as "missing" behaviour. All three were live before `v0.1.0-rc.10`:

- **Unknown model identifiers.** The package no longer refuses them. `UNSUPPORTED_MODEL` and the invented alias table
  were removed; any model string is now forwarded verbatim, which is what the client does — it never rejects a model
  identifier.
- **Beta over-emission on `claude-3-*`.** The package used to add betas the plugin did not; that set is now empty.
- **`temperature` on `claude-opus-4-8`.** Emitted only when thinking is inactive _and_ the model is in the `LCn`
  allowlist. Opus 4.8 is not in it, so the field is absent on both paths now.

## Technical debt this migration created

None open. The three items this migration created are closed and kept below, because the failure mode each one
describes is the reason the corresponding test or carve-out exists, and that reasoning is not reconstructable from
the code.

### Closed

- **The `thinking` exclusion had gone vestigial** — removed, and the differential vector now compares the field as
  bytes. It cost one of the two exclusion slots the scaling warning above is rationing while excluding no real
  difference. General lesson, worth re-reading on every package bump: an exclusion whose two sides have converged is
  not free, it is a blind spot with a comment on it.

- **No guard test on `toClaudeCodeRequestInput`** — closed by
  `test/conformance/wire-compat-input-coverage.test.mjs`. The translator builds the package input from an explicit
  field list and had forgotten to forward a field three separate times during this migration, with an identical
  symptom each time: the seam looks configured at the call site, nothing warns, and it has no effect. That is exactly
  how the lean-system-prompt feature became a no-op. The test parses `ClaudeCodeRequestInput` out of the installed
  package's `dist/contracts.d.ts` and compares it against the keys the translator actually produces, in both
  directions. Omissions are allowed but must be declared with a reason, and an entry naming a field the package no
  longer declares fails too, so the allowlist cannot rot. If a package bump adds a field, this test names it.

- **The context-hint latch and its persistence module were dead code** — removed. `lib/context-hint-persist.mjs`,
  `contextHintState`, `_disableCtxHint`, the beta kill-switch pair and the 400/409/529 handlers that matched an error
  body mentioning the hint are all gone. The server cannot reject a hint the client no longer advertises. The 422/424
  compaction branch stayed: it reacts to the response status, not to an error body naming the hint, so it fires
  regardless of what the client advertises.

## Syncing a new package version

The specifier is the `latest` dist-tag, so a sync is a lockfile move, not a `package.json` edit. Do not re-pin an
exact version to perform a routine sync — that is the emergency-rollback shape (see
`docs/shared-package-provenance.md`).

1. `npm update @tormentalabs/claude-code-wire-compat`. This rewrites `package-lock.json` only: new version, new
   registry tarball URL, new `sha512` integrity. **The lockfile diff is the review artifact** — read it before
   anything else. `docs/shared-package-provenance.md` needs no version edit by design; it documents the policy, and
   `test/conformance/package-dependency-policy.test.mjs` validates `resolved` against the lock's own `version`.
2. Check whether the package's `DEFAULT_PROFILE` moved (its CHANGELOG says so, and
   `node_modules/@tormentalabs/claude-code-wire-compat/src/build-request.ts` is the seam). If it did:
   - no version literal needs editing. `PROFILE_CLI_VERSION` / `PROFILE_USER_AGENT`
     (`lib/mimicry/adapter-input.mjs:238-239`) are derived from `WIRE_PROFILE` (`lib/mimicry/wire-compat.mjs`), so
     they follow the profile the seam binds rather than being re-typed — `test/conformance/version-literals-retired.test.mjs`
     enforces that. What DOES need a decision is the `WIRE_PROFILE` binding itself: it names an explicit profile
     export (currently `CLAUDE_CODE_2_1_233_PROFILE`), so moving to a newer client is an intentional one-line change
     at the seam, not a side effect of the bump. Leaving it behind the package's `DEFAULT_PROFILE` does not fail
     closed — it makes every request carry a redundant `profileOverride`. (The old
     `FALLBACK_CLAUDE_CLI_VERSION` / `CLI_TO_SDK_VERSION` literals lived in `lib/request-headers.mjs`, which this
     migration deleted.)
   - copy the package's analysis doc for the new client version into `docs/claude-code-<version>-analysis.md`, which
     `scripts/check-invariants.mjs` requires and which is the evidence for the emulation claim.
3. Run `npm test`. Failures concentrate in `test/conformance/shared-package-parity.test.mjs`,
   `test/conformance/golden-outgoing.test.mjs` and `test/conformance/wire-compat-input-coverage.test.mjs` (the last
   one fires when the package declares a new request-input field).
4. **Review the golden diff by hand, byte by byte.** A default-profile move legitimately changes the user agent,
   `x-stainless-package-version`, the `anthropic-beta` list and the billing `cc_version`. Anything else changing is a
   finding, not a golden to regenerate. Regenerating a golden you have not read is how a wire regression ships.
5. For each remaining failure, measure both sides before deciding anything. Do not assume the plugin is the reference.
6. A difference that the package fixed becomes a closed row above. A difference the plugin has not caught up with
   becomes an outbound row, plus either a pinning test or a normalisation exclusion with a pinning test.
7. If the plugin lost a capability to the package's validation, the answer is a new opt-in seam in the package
   (Option A) — unless the capability was itself a defect, in which case fix the plugin and record it under
   "Divergences the plugin closed on its own side".
8. Re-read the scaling warning above before adding a third exclusion.

## Where this document stands after the migration

As of the migration's completion the plugin **no longer maintains an independent implementation of Claude Code
protocol composition**. Headers, body shape, system prefix, beta lists, URL, model queries and protocol constants come
from `@tormentalabs/claude-code-wire-compat` through the single seam `lib/mimicry/wire-compat.mjs`. This document is
therefore no longer a ledger of two implementations drifting apart; it is the record of how they were reconciled, plus
the triage sequence for the next package bump.

What remains divergent is **host policy by design** — deliberate plugin behaviour the package does not model, not
catch-up work:

- **Emulation off is transparent passthrough plus an auth envelope.** With `signature_emulation` disabled the host's
  headers travel verbatim (`lib/passthrough-headers.mjs`) minus `x-api-key` / `x-session-affinity`, plus
  `authorization` and an additive `oauth-2025-04-20`. The URL is untouched. No package composition runs at all,
  because the point of the mode is that nothing is forged.
- **Beta UX aliases** (`lib/betas.mjs`). The package owns which betas go on the wire; the host owns the shorthand
  users type in config and the mapping from it. That vocabulary is a plugin affordance and has no wire meaning.
- **The cache turn-stability heuristic** (`lib/mimicry/cache.mjs`), and with it the scoping half of
  `splitSysPromptPrefix` (`splitSystemCacheScopes`). TTL and scope selection depend on plugin-side `cache_policy`
  config and role resolution the package knows nothing about.
- **`SESSION_ID_FALLBACK`.** A host invention: the plugin must produce a session identity even when the host gave it
  none. The real client always has one, so the package has no notion of a fallback.
- **The frozen legacy forge** (`buildRequestHeaders`, `lib/mimicry/headers.mjs`). A compatibility exception for
  endpoints the package has no surface for — files, models, gateway-prefixed routes. It is frozen: it is not a second
  implementation competing for `/v1/messages` traffic, and it does not get new features. See the boundary banner at
  the top of that file.

Anything else that diverges is a finding.
