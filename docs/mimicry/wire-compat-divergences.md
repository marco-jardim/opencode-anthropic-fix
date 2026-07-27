# Wire-Compat Package Divergences

Use this table when reasoning about a difference between what this plugin puts on the wire and what
`@tormentalabs/claude-code-wire-compat` would put on the wire for the same host request. Both construction paths are
exercised side by side in `test/conformance/shared-package-parity.test.mjs`, which compares URL, method, headers and
body byte-for-byte after normalising genuine per-run nondeterminism.

**The direction of the difference has inverted.** That suite was written when the shared package was the incomplete
implementation and the plugin was the reference. Since the package's Wave 7 work (`v0.1.0-rc.10`) and the max-tokens
clamp (`v0.1.0-rc.11`), the package is derived directly from the 2.1.195 client binary and the plugin is the lagging
side of every remaining difference. Read every row below as "the plugin has not caught up", not as "the package is
wrong".

**Nothing in this document is a bug report against the plugin's runtime behaviour.** Each row is a deliberate,
recorded decision to keep the plugin emitting what it emits today. Changing what goes on the wire in production is a
product decision with its own risk and rollout, not a side effect of upgrading a dependency. This document exists so
that the decision stays visible and does not decay into an accident.

## How each divergence is held in place

Two fields are excluded from the byte-for-byte comparison, and each exclusion is backstopped by a dedicated test that
pins the exact value both sides produce, so neither can drift unnoticed:

| Field            | Excluded in                                                 | Pinned by                                               |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `anthropic-beta` | `normalizeHeaders`                                          | `BETA_HEADER_DIVERGENCE`, 8 model rows as exact strings |
| `thinking`       | `normalizeBody`, opt-in via `normalizeThinking`, one vector | `ENABLED_THINKING_DIVERGENCE`, exact serialised objects |

`max_tokens` needs no exclusion: the difference is invisible at the fixture's values (see row 6).

> **This mechanism does not scale.** Two exclusions is the practical ceiling. If a third field diverges, the honest
> move is to invert the suite's default — compare against the package as the reference and enumerate the plugin's
> known-stale fields — rather than keep carving exceptions out of a comparison that is supposed to be exhaustive.

## Outbound divergences

Upstream symbol names and byte offsets refer to the genuine 2.1.195 client binary, as recorded in the package's
`docs/source-trace.md`.

| #   | Field                                | Plugin emits                                        | Package emits                                     | Upstream truth                                                                                   |
| --- | ------------------------------------ | --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `claude-code-20250219` on Haiku      | present                                             | absent                                            | The base beta set opens `if(!isHaiku) push(claudeCode)`, so Haiku never carries it.              |
| 2   | `web-search-2025-03-05`              | present on first party                              | absent                                            | The only two push sites are guarded by `provider==="vertex"` and `provider==="foundry"` (`IPt`). |
| 3   | `advisor-tool-2026-03-01`            | present                                             | absent                                            | The identifier exists in the registry (`f2r`) but no push site was found anywhere in the binary. |
| 4   | `mid-conversation-system-2026-04-07` | absent                                              | present on `claude-opus-4-8` and `claude-fable-5` | Gated by `RCn`, whose exclusion list omits exactly those two models.                             |
| 5   | `thinking` on the enabled branch     | `{"type":"enabled","budget_tokens":<caller value>}` | `{"budget_tokens":<clamped>,"type":"enabled"}`    | `Tr = Math.min(Fi - 1, Tr)`, and `budget_tokens` is inserted first.                              |
| 6   | `max_tokens`                         | caller value verbatim                               | capped at the model's default output limit        | `Fi = Math.min(callerValue, qct(model))`, where `qct` resolves to `Xxe(model).default`.          |

Rows 1 to 4 are all `anthropic-beta` content and are covered by that header's exclusion. Row 5 is the `thinking`
exclusion. Row 6 is new in `v0.1.0-rc.11` and is discussed below because it behaves differently from the others.

### Row 5, in detail

Two independent differences in one field. The package clamps an over-limit budget the way upstream does, and it emits
`budget_tokens` before `type`, which is upstream's insertion order for the enabled branch. Key order matters here
because the parity suite compares serialised bytes, so the divergence is pinned as an exact string rather than with
`toEqual`.

Vectors that send `type: "adaptive"` do **not** set the `normalizeThinking` flag. Both paths still agree on the
adaptive branch and must keep agreeing.

### Row 6, in detail

The plugin does have a `resolveMaxTokens` (`lib/mimicry/request-helpers.mjs:227`), but it is a **policy** cap for
context-window economy, not a protocol cap against the model's limit. Its first rule is that a caller-supplied value
wins outright (`request-helpers.mjs:229`), so the model is never consulted.

This row is invisible to the byte-for-byte vectors: `HOST_BODY.max_tokens` is 8000 and every model those vectors
exercise has a default output limit of 8192 or above, so the cap cannot bite. It only appears once a caller asks for
more than the model will give — for example 40000 on `claude-sonnet-4-5`, whose default is 32000. Two tests hold this
in place, one pinning the divergence at 40000 and one control asserting both paths still agree at 8000.

The bound is the model **default**, not its upper limit. Upstream only ever compares the
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment value against `upperLimit`, and the package reads no environment.

## Divergences that the package has already closed

Recorded so nobody re-opens them as "missing" behaviour. All three were live before `v0.1.0-rc.10`:

- **Unknown model identifiers.** The package no longer refuses them. `UNSUPPORTED_MODEL` and the invented alias table
  were removed; any model string is now forwarded verbatim, which is what the client does — it never rejects a model
  identifier.
- **Beta over-emission on `claude-3-*`.** The package used to add betas the plugin did not; that set is now empty.
- **`temperature` on `claude-opus-4-8`.** Emitted only when thinking is inactive _and_ the model is in the `LCn`
  allowlist. Opus 4.8 is not in it, so the field is absent on both paths now.

## Syncing a new package version

1. Update the pin in `package.json` to the new release tarball URL and run `npm install`.
2. Run `npm test`. Failures will concentrate in `test/conformance/shared-package-parity.test.mjs`.
3. For each failure, measure both sides before deciding anything. Do not assume the plugin is the reference.
4. A difference that the package fixed becomes a closed row above. A difference the plugin has not caught up with
   becomes an outbound row, plus either a pinning test or a normalisation exclusion with a pinning test.
5. Re-read the scaling warning above before adding a third exclusion.
