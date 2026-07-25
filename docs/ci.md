# CI and prerelease policy

## Continuous integration gate

The [`ci` workflow](../.github/workflows/ci.yml) runs for every pull request and every push to
`master`. Its `quality` job runs independently on Node.js 20, 22, and 24. Each matrix job executes
the complete gate in this order:

1. `npm ci`
2. `npm run lint`
3. `npm run format:check`
4. `npm run check:invariants`
5. `npm test`
6. `npm run coverage`
7. `npm run build`

The frozen passing-test floor is **1414**. This is a minimum based on the measured `master`
baseline, not an expected exact count. New tests may legitimately increase the observed count.
When a higher count is established on `master`, raise the floor deliberately in the workflow and
its policy test in the same reviewed change. Never lower the floor to make a regression pass.

The Node matrix checks should be required by branch protection and required to be up to date
before merge. The [`ci` workflow](../.github/workflows/ci.yml) and the
[`publish` workflow](../.github/workflows/publish.yml) are independent. Publication runs its own
gate only on Node.js 24; requiring all three `ci` checks is what prevents code that fails on Node.js
20 or 22 from reaching publication.

## Publication and dist-tags

The [`publish` workflow](../.github/workflows/publish.yml) enables npm provenance. Its configuration
appears to rely on npm trusted publishing for authentication (`id-token: write` is granted and no
`NODE_AUTH_TOKEN` is supplied), but the npm package settings must be confirmed before the next
release. It runs on manual dispatch, and a push to `master` that changes
[`package.json`](../package.json) also triggers the publication automation. **Merging any
`package.json` change to `master` triggers this sensitive workflow**, so such changes require
release-level review.

Before its publish step, the same Node.js 24 job runs `npm ci`, `npm run lint`,
`npm run check:invariants`, `npm test`, and `npm run build`. Publication proceeds only when its
version-change/manual-dispatch condition is true. If the package version cannot be parsed, the job
fails without publishing.

Dist-tags are selected from the version in `package.json`:

- A hyphenated version such as `0.3.0-beta.0` publishes to the npm `beta` dist-tag.
- A non-hyphenated stable version publishes to the npm `latest` dist-tag.
- A prerelease must never be published to `latest`.

## Canary and promotion procedure

Publishing to `beta` begins a human canary window; it does not authorize promotion. During the
window, maintainers install the exact `opencode-anthropic-fix@beta` artifact in representative
environments, exercise authentication and account rotation, inspect npm provenance, and monitor
for regressions. The window ends only when a human release owner records that the canary evidence
is acceptable. There is no automatic timeout or automatic promotion.

Promotion to `latest` is a separate human-gated decision:

1. Identify and verify the exact version currently selected by `beta`.
2. Confirm the CI matrix passed for the release commit and the Node.js 24 publication gate passed.
3. Review the canary evidence and obtain explicit human approval for that exact version.
4. Only an authorized npm maintainer may then move the `latest` dist-tag to that exact version.
5. Verify that `beta` and `latest` resolve to the intended versions and record the release evidence.

Never promote without explicit human approval. Never treat a successful prerelease publication,
elapsed canary time, or a green Node.js 24 publish job as approval.
