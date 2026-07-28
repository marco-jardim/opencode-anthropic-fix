# Shared wire package provenance and rollback

The plugin builds its outgoing Anthropic Messages request through
[`@tormentalabs/claude-code-wire-compat`](https://github.com/marco-jardim/claude-code-wire-compat),
consumed by the adapter in [`wire-compat.mjs`](../lib/mimicry/wire-compat.mjs). This document records
where that dependency comes from, why it is pinned the way it is, and how to back it out.

Attribution for the dependency and its license lives in [`NOTICE`](../NOTICE). The policy in this
document is enforced by
[`package-dependency-policy.test.mjs`](../test/conformance/package-dependency-policy.test.mjs).

## Current pin

| Field              | Value                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Package            | `@tormentalabs/claude-code-wire-compat`                                                                                                       |
| Version            | `0.1.0-rc.16`                                                                                                                                 |
| Release tag        | `v0.1.0-rc.16`                                                                                                                                |
| Artifact           | `https://github.com/marco-jardim/claude-code-wire-compat/releases/download/v0.1.0-rc.16/tormentalabs-claude-code-wire-compat-0.1.0-rc.16.tgz` |
| Lockfile integrity | `sha512-M+irkLzRt7D7x0gcJYqsvGG/bJ5iWHRypLpv14Y9g5srBy/LMbJj9qrj7tdxGAbJBvnKam5MNobDH4gQNsQ+aQ==`                                             |
| License            | `GPL-3.0-or-later`, compatible with this plugin's GPLv3                                                                                       |

The specifier lives in [`package.json`](../package.json) and the resolved artifact plus its integrity
hash live in `package-lock.json`. Both must agree; the conformance test fails if they drift.

## Why the pin is a tarball today

The shared package has not been published to the npm registry yet. Until it is, the only immutable
public artifact is the GitHub release tarball for a specific release-candidate tag, so the plugin
depends on that exact tarball with `--save-exact` semantics and a recorded lockfile integrity hash.

The pin is temporary. Phase 9 of the extraction plan replaces it with the exact registry version
`0.1.0` from npm, in the same reviewed change that prepares the plugin's own beta release. Once that
happens, this document's pin table must be updated to the registry version and the policy test's
`registry` branch takes over from the `tarball` branch automatically.

The following specifier shapes are forbidden and fail the policy test: `file:` and `link:` paths,
`git`/`github:` references, branch archives, any URL without a recorded release-candidate tag, and
semver ranges such as `^0.1.0`. Each of them lets the built wire request change without a reviewed
dependency bump, which is exactly the failure mode the parity suite cannot catch after the fact.

## Verify the pin

```bash
npm ls @tormentalabs/claude-code-wire-compat
npm test -- --run test/conformance/package-dependency-policy.test.mjs
npm test -- --run test/conformance/shared-package-parity.test.mjs
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

| SHA       | Message                                                                             | What reverting it undoes                                                    |
| --------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `0508b55` | `COM-466 deps: migrate the shared wire package pin to rc.15`                        | pin to `rc.15`; falls back to `rc.14` and its two defects                   |
| `df639f3` | `COM-466 deps: migrate the shared wire package pin to rc.14`                        | pin to `rc.14` and the `extraHeaderPolicy` seam; falls back to `rc.13`      |
| `f57b06b` | `COM-466 deps: migrate the shared wire package pin to rc.13`                        | pin to `rc.13` and its four seams; falls back to `rc.11`                    |
| `8f1d954` | `deps: upgrade the shared wire package to rc.11 and record the divergences`         | pin to `rc.11`, the divergences document, and its parity cases              |
| `19847f1` | `deps: upgrade the shared wire package to the client-derived protocol`              | pin to the client-derived protocol build and the adapter line it required   |
| `6d64945` | `chore(deps): upgrade the shared wire package to the catalogue-derived model table` | pin to the catalogue-derived model table                                    |
| `fc7cf2e` | `chore(deps): upgrade the shared wire package and align parity expectations`        | pin bump plus the parity expectations aligned with it                       |
| `cca5b56` | `test(conformance): expand shared package parity matrix`                            | parity coverage only; no runtime effect                                     |
| `9c4967f` | `refactor(mimicry): consume wire compatibility rc.5`                                | adapter simplification against the `rc.5` API and its pin                   |
| `f5bd6fd` | `feat: add emergency protocol profile override`                                     | the profile override seam in the adapter and its documentation              |
| `e42621d` | `test: freeze published model helper exports`                                       | the public API contract test only; no runtime effect                        |
| `6375cee` | `refactor: add shared wire package adapter`                                         | the adapter itself and the dependency in `package.json`/`package-lock.json` |

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

   There is no separate "construction swap" commit to revert today. Nothing outside
   [`wire-compat.mjs`](../lib/mimicry/wire-compat.mjs) imports `buildWireCompatibleRequest` yet: the
   adapter is built and parity-tested, but the plugin's live request path still uses its own
   construction. When that swap lands, add its SHA to the top of the table and revert it first.

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
