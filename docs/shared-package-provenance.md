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
| Version            | `0.1.0-rc.11`                                                                                                                                 |
| Release tag        | `v0.1.0-rc.11`                                                                                                                                |
| Artifact           | `https://github.com/marco-jardim/claude-code-wire-compat/releases/download/v0.1.0-rc.11/tormentalabs-claude-code-wire-compat-0.1.0-rc.11.tgz` |
| Lockfile integrity | `sha512-rWPOHhR9lsI1k5/EVH/v5MDzFkCPq3kM4nJeZfn2LMLgnO1BVOXuHjw8sD4/H1sF+qONTJhgIxPG1cBFHSLCtw==`                                             |
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

## Rollback

Roll back by reverting commits, newest first, and re-running the full gate after each step.

1. Revert the construction swap (the commit that made the plugin consume the shared builder,
   `refactor: consume shared wire request builder`):

   ```bash
   git revert --no-edit <sha-of-construction-swap>
   ```

2. If the adapter commit (`refactor: add shared wire package adapter`) has not been merged, revert it
   too, which also removes the dependency from `package.json` and `package-lock.json`:

   ```bash
   git revert --no-edit <sha-of-adapter-commit>
   npm ci
   ```

   If it has been merged and shipped, keep the dependency installed and unused rather than editing
   `package.json` on a hotfix branch: any `package.json` change merged to `master` triggers the
   publication workflow described in [`ci.md`](./ci.md).

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
