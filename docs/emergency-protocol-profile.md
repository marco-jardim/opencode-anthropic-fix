# Emergency protocol profile override

The plugin can temporarily override the Claude Code profile the shared wire package composes against
when an upstream Claude Code release requires an immediate compatibility update. This is an
emergency bridge, not a replacement for updating the shared package.

Read "Keep the override to `{userAgent, cliVersion}`" below before setting one: the override is
merged field by field over a base profile that advances with every package release, so a broad
override goes stale silently.

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
request instead of silently using the base profile. Unknown or prohibited fields also fail
validation. In particular, the endpoint, provider, and Anthropic API version cannot be overridden.
When changing `cliVersion`, change `userAgent` to the same version in the same override.

## Keep the override to `{userAgent, cliVersion}`

**The override is applied field by field, wholesale per field, against the package's _current_
base profile — and that base moves.** The plugin deliberately omits the `profile` argument, so the
base is whatever `DEFAULT_PROFILE` the installed
`@tormentalabs/claude-code-wire-compat` declares, and the dependency tracks the `latest` dist-tag.
Every package release can advance it (it moved 2.1.195 → 2.1.233 at the `0.3.0` bump).

There is no deep merge. A field you supply **replaces** the base field entirely; a field you omit is
inherited from the new base. That is fine for scalars like `userAgent` and `cliVersion`, and it is a
trap for structured data:

- An override carrying `supportedModels` freezes the model catalogue at the era it was written. The
  base grew 14 → 17 entries at 2.1.233 (`claude-sonnet-5`, `claude-opus-5`, `claude-mythos-5`) and
  changed capabilities on existing ones; a stale copy silently reverts all of it.
- An override carrying `betaPolicy` or `sdkVersion` pins the beta gating and the
  `x-stainless-package-version` fingerprint to that era too.

Nothing fails when this happens. The request is structurally valid and goes out looking correct
while announcing a client that never existed: a new user agent over an old catalogue. That is worse
than not overriding at all, because the mismatch is exactly the kind of inconsistency the emulation
exists to avoid, and no test in this repository can see it — the values came from an environment
variable at runtime.

**The environment variable does not validate field contents, by design.** It accepts any JSON object
whose fields are permitted, so that an emergency override is never blocked by a validator this
repository would have to ship a release to relax. Failing open is the deliberate choice; the cost is
that correctness here is yours, not the plugin's.

So: in an emergency, override `{userAgent, cliVersion}` and nothing else. If you genuinely need
different catalogue or policy data, that is not an emergency override — it is a package release (see
"Reconcile with the shared package" below). And whichever you set, treat the override as perishable:
re-read it after every dependency bump, or delete it.

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
package's own `DEFAULT_PROFILE`; rerun the conformance test and full release gate before publishing.

## Reconcile with the shared package

After the emergency release, add the verified profile to the shared package, run its complete gate,
and publish a reviewed shared-package release. Re-pin the plugin to that exact artifact, remove the
temporary plugin override, and rerun the plugin's end-to-end conformance evidence and six-command
gate. The emergency override is complete only after the plugin uses the shared package's pinned
profile with no configuration or environment override active.
