# Emergency protocol profile override

The plugin can temporarily override the shared wire package's pinned Claude Code profile when an
upstream Claude Code release requires an immediate compatibility update. This is an emergency
bridge, not a replacement for updating the shared package.

## Set the override

Prefer explicit plugin configuration when preparing a plugin release. Pass `profileOverride` in the
transport configuration supplied to `buildWireCompatibleRequest`:

```js
profileOverride: {
  cliVersion: "2.1.196",
  userAgent: "claude-cli/2.1.196 (external, cli)",
}
```

For an operational override without a configuration change, set
`OPENCODE_ANTHROPIC_PROFILE_OVERRIDE` to the same object encoded as JSON:

```text
OPENCODE_ANTHROPIC_PROFILE_OVERRIDE={"cliVersion":"2.1.196","userAgent":"claude-cli/2.1.196 (external, cli)"}
```

Explicit plugin configuration takes precedence over the environment. Malformed JSON fails the
request instead of silently using the pinned profile. Unknown or prohibited fields also fail
validation. In particular, the endpoint, provider, and Anthropic API version cannot be overridden.
When changing `cliVersion`, change `userAgent` to the same version in the same override.

## Validate and release

1. Add an end-to-end conformance case in
   [`shared-package-parity.test.mjs`](../test/conformance/shared-package-parity.test.mjs).
2. Assert that the built request's `user-agent` and the `cc_version=` field in the first system body
   block announce the new version.
3. Assert that the URL remains exactly `https://api.anthropic.com/v1/messages?beta=true`.
4. Add negative evidence that malformed environment JSON fails loudly.
5. Run `npm run lint`, `npm run format:check`, `npm run check:invariants`, `npm test`,
   `npm run coverage`, and `npm run build` and record their outputs.
6. Release the plugin through the existing reviewed prerelease and canary process in
   [`ci.md`](./ci.md). No shared-package release is required for this emergency plugin release.

## Roll back

Remove `OPENCODE_ANTHROPIC_PROFILE_OVERRIDE` and restart the plugin process. For a released explicit
override, publish a follow-up plugin release that removes `profileOverride`. Both paths restore the
shared package's pinned profile; rerun the conformance test and full release gate before publishing.

## Reconcile with the shared package

After the emergency release, add the verified profile to the shared package, run its complete gate,
and publish a reviewed shared-package release. Re-pin the plugin to that exact artifact, remove the
temporary plugin override, and rerun the plugin's end-to-end conformance evidence and six-command
gate. The emergency override is complete only after the plugin uses the shared package's pinned
profile with no configuration or environment override active.
