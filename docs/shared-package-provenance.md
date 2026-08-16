# Shared wire package provenance and rollback

The plugin builds its outgoing Anthropic Messages request through
[`@tormentalabs/claude-code-wire-compat`](https://github.com/marco-jardim/claude-code-wire-compat),
consumed by the adapter in [`wire-compat.mjs`](../lib/mimicry/wire-compat.mjs). This document records
where that dependency comes from, why it is pinned the way it is, and how to back it out.

Attribution for the dependency and its license lives in [`NOTICE`](../NOTICE). The policy in this
document is enforced by
[`package-dependency-policy.test.mjs`](../test/conformance/package-dependency-policy.test.mjs).

## Current specifier

| Field       | Value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Package     | `@tormentalabs/claude-code-wire-compat`                                 |
| Specifier   | `latest` (npm dist-tag), in [`package.json`](../package.json)           |
| Origin      | npm registry                                                            |
| Resolved by | `package-lock.json` — version, registry tarball URL, `sha512` integrity |
| License     | `GPL-3.0-or-later`, compatible with this plugin's GPLv3                 |

This table deliberately does **not** name a version. The resolved version lives in one place —
`package-lock.json` — and duplicating it here would create a second source of truth that rots on the
first `npm update`. To read the version actually installed:

```bash
npm ls @tormentalabs/claude-code-wire-compat
```

## Why the specifier is the `latest` dist-tag

The plugin does not compose the wire request itself; it delegates to the package and **omits the
`profile` argument**, which means it inherits whatever the package declares as its `DEFAULT_PROFILE`.
That default is the package's statement of "the newest genuine Claude Code client we have analysed
and transcribed" — `claude-code-2.1.233-sdk-0.112.1` at the time of writing. Tracking `latest` is
therefore not laziness about versioning; it is the mechanism by which a newly analysed client profile
reaches this plugin's wire without a code change to the composition path.

Two constants shadow that default and must move with it —
`PROFILE_CLI_VERSION` / `PROFILE_USER_AGENT` in
[`adapter-input.mjs`](../lib/mimicry/adapter-input.mjs), both tracking `WIRE_PROFILE.cliVersion` as
re-exported by [`wire-compat.mjs`](../lib/mimicry/wire-compat.mjs). They exist so `resolveProfileOverride` stays
silent in the common case; if they lag the package, every request starts carrying a redundant profile
override. The conformance suite fails loudly when they drift, so this is a caught mistake rather than
a silent one.

### Where reproducibility actually lives

A dist-tag is mutable, so the immutability guarantee moves to the lockfile:

- `package-lock.json` records the resolved version, the exact registry tarball URL, and its `sha512`
  integrity hash.
- `npm ci` installs exactly that, byte for byte. CI uses `npm ci`, never `npm install`.
- Moving the tag therefore still requires a **reviewed lockfile diff** — the same review gate an
  exact pin gave, applied at the point where the bytes actually change.

The policy test asserts `resolved` against the lock's own `version` (not against the specifier), plus
the `sha512` hash and the `GPL-3.0-or-later` licence field.

### What is still forbidden

`file:` and `link:` paths, `git`/`github:` references, branch archives, any URL without a recorded
release-candidate tag, non-`latest` dist-tags (`next`, `beta`), and semver **ranges** such as
`^0.3.0`, `~0.3.0` or `0.3.x`.

Ranges deserve a word, since they are also lock-backed. `latest` is a deliberate, greppable statement
of intent: _track the package, inherit its default profile._ A range says nothing — it silently
widens what a fresh resolution may pick without anyone having decided that. Emergency rollback is the
one case that pins an exact version, and it is exact precisely because it is a decision.

## Emergency rollback of the wire shape

Two levers, in increasing order of blast radius. Neither is a runtime switch (see the next section).

1. **Pin an exact version.** If a package release regresses the wire bytes, replace the specifier
   with the last good exact version and re-lock:

   ```bash
   npm install --save-exact @tormentalabs/claude-code-wire-compat@0.3.0
   npm test -- --run test/conformance/shared-package-parity.test.mjs
   ```

   The policy test accepts an exact semver specifier for exactly this reason. Restore `latest` once
   the regression is fixed upstream.

2. **Override the profile without changing the package.** If the _profile_ is the problem but the
   builder is fine, `OPENCODE_ANTHROPIC_PROFILE_OVERRIDE` overrides fields of the profile the
   package composes against — see
   [`emergency-protocol-profile.md`](./emergency-protocol-profile.md). This is the cheaper lever when
   a new default profile turns out to be wrong on the wire: the package still ships the previous
   profile alongside the new default.

   **Keep such an override to `{userAgent, cliVersion}`.** It is applied field by field, wholesale
   per field with no deep merge, over the package's _current_ `DEFAULT_PROFILE` — which advances on
   every package release. An override that also carries catalogue or policy data (`supportedModels`,
   `betaPolicy`, `sdkVersion`) pins that data to the era it was written in and goes stale silently on
   the next upgrade: the request stays structurally valid while announcing a new client over old
   data. The environment variable does not validate field contents by design, so that an emergency is
   never blocked by a validator — which means the staleness is yours to catch, not the plugin's.

## Historical pins

Kept as a record; none of these is the live policy.

| Period               | Specifier                                   | Note                                                                                              |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Pre-publication      | GitHub release tarball, `v0.1.0-rc.17` last | The only immutable public artifact before the package was published to npm                        |
| Phase 9 → 0.3.0 bump | exact registry version `0.1.0`              | `sha512-+BYniAAGj2mCv2MOCusIVueRphdfp4Pnse0641ruF3e4I/yz48kJ17KaFc4fp0OqbX8Z7FBQWzhACfLtJFbiRA==` |
| Current              | `latest` dist-tag                           | Inherits the package's `DEFAULT_PROFILE`; reproducibility via `package-lock.json`                 |

The `0.1.0` era pinned the profile as a side effect: `0.1.0`'s default was `claude-code-2.1.195`, and
moving to `0.3.0` moved the wire to `claude-code-2.1.233-sdk-0.112.1`. That coupling is the reason
the specifier policy and the profile policy are documented together.

**0.4.0 (plugin 0.6.0).** Picked up by `npm update` under the same `latest` specifier — no
`package.json` change, lock only. It adds `extraHeaderPolicy` to `ClaudeCodeCountTokensInput`, which
the plugin adopted immediately: `toClaudeCodeCountTokensInput` now sends
`extraHeaderPolicy: "dropConflicting"` instead of reproducing the policy plugin-side against three
mirrored header-ownership lists, and those mirrors were deleted. The count wire is byte-identical
across the bump. See `docs/mimicry/wire-compat-divergences.md`.

## Verify the dependency

```bash
npm ls @tormentalabs/claude-code-wire-compat
npm test -- --run test/conformance/package-dependency-policy.test.mjs
npm test -- --run test/conformance/shared-package-parity.test.mjs
npm test -- --run test/conformance/golden-outgoing.test.mjs
```

Byte-level differences between the plugin's historical construction and the shared package are
recorded in [`wire-compat-divergences.md`](./mimicry/wire-compat-divergences.md).

## There is no runtime kill-switch

This is an operational limitation, not an oversight to work around at 3 a.m.:

- [`wire-compat.mjs`](../lib/mimicry/wire-compat.mjs) imports `buildClaudeCodeRequest` with a static,
  unconditional ES module import. There is no lazy import, no feature flag, and no fallback to the
  removed in-repo construction path.
- The only related environment variable is `OPENCODE_ANTHROPIC_PROFILE_OVERRIDE`. It overrides the
  Claude Code **profile** used by the shared builder, as described in
  [`emergency-protocol-profile.md`](./emergency-protocol-profile.md). It does **not** disable the
  shared package, and it cannot restore the previous request builder.
- Therefore an incident caused by the shared package is resolved by shipping code: an override
  profile release if the profile is the problem, or the revert below if the builder itself is.

If a runtime disable switch is ever wanted, it is a design change with its own tests, not something
to improvise during an incident.

## Migration commit chain

Every commit that introduced or moved the shared package, newest first. Reverting in this order is
the rollback; there are no placeholders to resolve during an incident.

| SHA       | Message                                                                              | What reverting it undoes                                                                                        |
| --------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `93779c7` | `COM-466 feat(mimicry): migrate the pin to rc.17 and close the wave 6.2 divergences` | pin to `rc.17`; falls back to `rc.16`                                                                           |
| `99f4844` | `COM-466 WIP: adapter swap, capability fixes and rc.16 migration`                    | **the construction swap**: the live request path stops calling the package and returns to `buildRequestHeaders` |
| `0508b55` | `COM-466 deps: migrate the shared wire package pin to rc.15`                         | pin to `rc.15`; falls back to `rc.14` and its two defects                                                       |
| `df639f3` | `COM-466 deps: migrate the shared wire package pin to rc.14`                         | pin to `rc.14` and the `extraHeaderPolicy` seam; falls back to `rc.13`                                          |
| `f57b06b` | `COM-466 deps: migrate the shared wire package pin to rc.13`                         | pin to `rc.13` and its four seams; falls back to `rc.11`                                                        |
| `8f1d954` | `deps: upgrade the shared wire package to rc.11 and record the divergences`          | pin to `rc.11`, the divergences document, and its parity cases                                                  |
| `19847f1` | `deps: upgrade the shared wire package to the client-derived protocol`               | pin to the client-derived protocol build and the adapter line it required                                       |
| `6d64945` | `chore(deps): upgrade the shared wire package to the catalogue-derived model table`  | pin to the catalogue-derived model table                                                                        |
| `fc7cf2e` | `chore(deps): upgrade the shared wire package and align parity expectations`         | pin bump plus the parity expectations aligned with it                                                           |
| `cca5b56` | `test(conformance): expand shared package parity matrix`                             | parity coverage only; no runtime effect                                                                         |
| `9c4967f` | `refactor(mimicry): consume wire compatibility rc.5`                                 | adapter simplification against the `rc.5` API and its pin                                                       |
| `f5bd6fd` | `feat: add emergency protocol profile override`                                      | the profile override seam in the adapter and its documentation                                                  |
| `e42621d` | `test: freeze published model helper exports`                                        | the public API contract test only; no runtime effect                                                            |
| `6375cee` | `refactor: add shared wire package adapter`                                          | the adapter itself and the dependency in `package.json`/`package-lock.json`                                     |

`205241e` (secret scanner configuration) and `d8d4c54` (removal of an unrelated production
dependency) are interleaved in the branch history but are not part of this migration; do not revert
them as part of a shared-package rollback.

## Rollback

Scope the rollback to the smallest commit that reproduces the incident, then work newest-first
through the table above, re-running the full gate after each step.

1. Reverting only a version bump downgrades the pin without removing the adapter. This is the usual
   fix when a specific release candidate regressed the wire bytes:

   ```bash
   git revert --no-edit 0508b55
   npm ci
   npm test -- --run test/conformance/shared-package-parity.test.mjs
   ```

   Chain further reverts (`df639f3`, then `f57b06b`, then `8f1d954`, then `19847f1`, then `6d64945`,
   then `fc7cf2e`) to step further back.

2. Reverting the whole chain removes the shared package entirely. The last commit to revert is the
   adapter commit, which also drops the dependency from `package.json` and `package-lock.json`:

   ```bash
   git revert --no-edit 6375cee
   npm ci
   ```

   As of this document, `refactor/extract-wire-compat` is **not merged** into `master`, so the full
   revert is safe on the branch. Once it is merged and released, prefer leaving the dependency
   installed over editing `package.json` on a hotfix branch: any `package.json` change merged to
   `master` triggers the publication workflow described in [`ci.md`](./ci.md).

   The construction swap has landed, so it is a distinct rollback step and it is the FIRST one to
   consider. [`index.mjs`](../index.mjs) imports `buildWireCompatibleRequest` and calls it on the
   live request path for every first-party `/v1/messages` turn with signature emulation on.

   The package's SECOND surface is consumed too: `buildWireCompatibleCountTokensRequest` wraps
   `buildClaudeCodeCountTokensRequest`, and every `/v1/messages/count_tokens` turn with signature
   emulation on is built by it. Both wrappers come from the same static import in
   [`lib/mimicry/wire-compat.mjs`](../lib/mimicry/wire-compat.mjs), so a revert unwinds two entry
   points rather than one.

   The legacy `buildRequestHeaders` construction survives beside them only as the fallback for the
   requests the adapter declines (a bodiless request, or signature emulation off — on either
   endpoint). Reverting `99f4844` therefore sends every turn back down the legacy path without
   removing the package:

   ```bash
   git revert --no-edit 99f4844
   npm test -- --run test/conformance/shared-package-usage.test.mjs
   ```

   That suite is the one that fails if the swap is undone by accident rather than on purpose: it
   observes the adapter boundary during a real request instead of comparing the two constructions,
   which is what the parity suite does and why parity alone stays green on a silent fallback.

3. Re-run the complete gate and confirm the parity and golden suites still pass:

   ```bash
   npm run lint
   npm run format:check
   npm run check:invariants
   npm test
   npm run coverage
   npm run build
   ```

4. Release through the normal prerelease and human-gated promotion path in [`ci.md`](./ci.md). A
   rollback is still a release; it does not bypass the canary window.

Never remove GPL notices as part of a rollback. [`LICENSE`](../LICENSE), [`NOTICE`](../NOTICE), and
the license headers in source files stay in place even when the dependency they attribute is removed;
delete the dependency's attribution block from `NOTICE` only after the dependency is actually gone
from `package.json` and `package-lock.json`, and never delete the plugin's own GPL notice.
