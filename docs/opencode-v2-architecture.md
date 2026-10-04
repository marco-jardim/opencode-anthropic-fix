# Decision: dual host adapters with one OAuth executor

## Context and decision

OpenCode 2.0.21 uses a definition object, registration APIs, a separate TUI
plugin, and different provider/message schemas. The existing v1 factory cannot
be loaded unchanged by that host. Preserve `index.mjs` as the legacy factory;
expose `server.mjs` with v1 `server` and v2 `setup`, and a separate `tui.mjs`.

Move the existing implementation into `createAnthropicRuntime()` rather than
maintaining two OAuth pools or wire implementations. Mutable metrics, config,
retry state, refresh flights and telemetry belong to each runtime. Disposal
aborts requests, refresh waits and backoff, and flushes pending account writes.
Disk account format and the cross-process refresh lock remain shared.

## Transport options

The native HTTP hooks do not expose a continuation that can own the existing
multi-account retry loop. Directly assigning a custom fetch to provider or model
settings was also rejected by the real 2.0.21 host: its overlay decoder requires
JSON values and fails on `settings.fetch`. A mocked hook test cannot detect this
constraint, which is why the binary smoke is part of validation.

Use the package spec `aisdk:@ai-sdk/anthropic@3.0.111` with a process-local HTTP
bridge. The versioned spec prevents the host from rewriting the unversioned
Anthropic SDK to its native provider, while remaining resolvable by the host's
built-in dynamic package loader. The
public `http.request` hook associates a request with its session and redirects
it to the bridge. A single-use random ticket identifies the original request;
the bridge invokes the existing executor and streams its response to the host.
No function is stored in provider/model settings. The SDK hook retains the
host's middleware fetch, and the executor remains the only retry owner for
managed OAuth requests. Other providers and explicitly selected foreign
connections retain their own settings.

The pin also makes Core's option/metadata key `anthropic@3.0.111`, whereas the
SDK reads and emits `anthropic`. A language-model boundary remaps incoming
provider options (including replay parts) and outgoing stream/non-stream metadata
(including reasoning signatures and finish metadata). An unversioned specifier
is not safe: `aisdk-native.ts:resolve` rewrites even the explicit `aisdk:` route
to the native provider. The host's dynamic SDK hook may install the pinned
package first; our later hook replaces that SDK with the plugin's pinned copy.

The bridge binds only to IPv4 loopback on an ephemeral port. It accepts only
issued request tickets, never accepts a caller-supplied destination, and strips
its private correlation data before the executor. Plugin unload closes it.
The public session-interruption event cancels pending requests because the
2.0.21 AI SDK call does not itself receive the host's abort signal. Losing that
event subscription aborts active requests and rejects new requests.

This is immediate cancellation for primary execution events, not a guarantee
for auxiliary fiber interruption. 2.0.22 and inspected HEAD `f74512b` still omit
the interruption signal from `doStream`. Supplied SDK signals and loopback
disconnects propagate upstream. Otherwise `generate` and `title` tickets have a
10-minute total deadline, including pre-header waits and streaming, to bound
orphaned requests. Slow primary/compaction streams are exempt. Upstream must pass
the Effect interruption signal to `doStream` as `abortSignal` for immediate
auxiliary cancellation; no plugin hook currently exposes that fiber lifetime.

Managed provider settings disable `timeout`, `headerTimeout` and `chunkTimeout`.
2.0.22 already has HEAD's 300-second default header/chunk limits. These conflict
with an executor that bounds attempts but not total wall time (uncapped
Retry-After waits and repeated transient 429s). The auxiliary deadline remains
independent of those host defaults. 2.0.21 ignores the new header option and
uses `chunkTimeout: 0`, because its public schema rejects `false` for that field
(its fetch wrapper activates the timer only for positive numbers).

## Credentials, commands and history

The plugin registers its own OAuth method ID. Host credential values are copies;
the pool on disk is authoritative for rotation, removal and refresh. A foreign
OAuth method or an explicit API-key/environment connection must not be replaced.
Only managed models receive zero costs across every tier and configured limits.

Administrative commands use a typed RPC definition and a local TUI slash layer.
They return bounded, sanitized dialog content; no prompt endpoint carries the
arguments or output. The server command name is reserved and returns guidance
for clients that have no administrative result channel.

V2 message policies operate on a temporary view and replace only pruned results.
Tool aliases are request-local and reversible. Summary compaction is selected
explicitly. Normal host history loading skips incompatible native checkpoints
and re-expands the original transcript; a new session is not required, and no
history is corrupted, although context can grow substantially. The defensive
adapter guard rejects opaque checkpoint parts only if explicitly passed to it.
The optional Haiku rolling-summary hook remains a v1
fork capability and emits a diagnostic when configured on v2.

## Consequences and validation boundary

One extra pinned production dependency is required for a known parser/provider
contract. The standalone dual-package build bundles it; the host's dynamic
provider loader may also populate its own cache on first use. The loopback bridge adds
one local streaming hop; disposal, backpressure, request authentication,
interruption and non-replay after streamed bytes must be covered by tests.

Keep regression tests for the v1 exports and wire fixtures, deterministic v2
SDK/transport tests, isolated installer and bundle tests, and real host smoke
scripts. Smoke runs use temporary configuration roots and fake credentials.
They prove host integration; they do not prove an authenticated Anthropic session
or future host releases. See [support and usage](opencode-v2.md) for the recorded
validation matrix.

## Host-contract review sources

Inspected `v2.0.21`, `v2.0.22` and upstream `f74512b` without changing the host:

- **Options and SDK loading:** `packages/core/src/provider.ts:30-34` strips
  only `aisdk:`. In `v2.0.21`, `aisdk.ts:429-442` derives the option key,
  `:362-367` assigns the same metadata key and `:690-700` nests request options.
  `session/runner/publish-llm-event.ts:120,421-436` persists reasoning state only
  under that key. `aisdk-native.ts:57,135-143` maps the unversioned Anthropic SDK
  to the native provider, including explicit `aisdk:` specs. This behavior is
  unchanged in the inspected 2.0.22/HEAD sources. `aisdk.ts:280-288,324-347` runs
  SDK hooks in registration order and caches their final SDK; the dynamic hook
  (`plugin/provider/dynamic.ts:10-15`) installs only when `evt.sdk` is empty.
  Installation is inside that hook, not an independent prerequisite:
  `plugin/provider/sdk-factory.ts:5-16` calls `npm.add(packageName)` and resolves
  `installed.name` in its installed directory. With the built-in hook first it
  can install before our replacement, so retaining the resolvable pin matters.
  `plugin/internal.ts:213-226` puts provider plugins in the pre-list;
  `plugin/supervisor.ts:138-155` places that list before external plugins.
- **Cancellation:** `session.ts@v2.0.21:405-411` invokes auxiliary generation
  directly, not a primary execution. `aisdk.ts@v2.0.21:715-718`,
  `@v2.0.22:733-736` and `@f74512b:729-732` call `language.doStream(options)`
  without the `Effect.tryPromise` signal. Auxiliary generation also uses this
  streaming route, not a separate `doGenerate` cancellation path.
- **Timeouts:** `provider.ts@v2.0.22:149-164` (HEAD `:151-166`) supplies the
  300,000 ms defaults; `aisdk.ts@v2.0.22:130-170` applies them around the
  middleware fetch. `model-resolver.ts:373` merges provider settings after
  removing model/variant transport settings. `packages/schema/src/provider.ts@v2.0.21:49-50`
  permits `timeout: false` but only numeric `chunkTimeout`; `aisdk.ts:137-149`
  treats zero as disabled. The executor's real budgets are in
  `lib/host/runtime.mjs:2873,2912-2928,4278-4312,4393-4448`, not a total five-minute
  deadline; `lib/backoff.mjs:11` caps account cooldowns, not whole requests.
- **History:** `session/history.ts@v2.0.21:23-26,99-107` filters incompatible
  checkpoints and retains the original transcript for re-expansion.

The 2.0.21 → 2.0.22 diff contains no change to the consumed loader, OAuth
methods, SDK-hook, RPC or TUI-command interfaces. The plugin Promise/Effect
session APIs add `remove` and `compact`; the Core host adds parent-aware session
creation and metadata updates. Model capability overlays now merge instead of
replacing fields. None requires an adapter change here. The transport timeout
defaults and the expanded timeout schema are the relevant breaking behavior;
the new bounded host timeout retry policy does not supersede our managed retry
hook. Core also preserves HTTP options when rebuilding a session request and
adds content-filter explanations to published errors; neither changes our hook
shapes. Provider-specific Azure/DigitalOcean changes do not affect this route.
