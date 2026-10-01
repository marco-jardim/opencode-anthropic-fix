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

The bridge binds only to IPv4 loopback on an ephemeral port. It accepts only
issued request tickets, never accepts a caller-supplied destination, and strips
its private correlation data before the executor. Plugin unload closes it.
The public session-interruption event cancels pending requests because the
2.0.21 AI SDK call does not itself receive the host's abort signal. Losing that
event subscription aborts active requests and rejects new requests.

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
explicitly; opaque native compaction checkpoints are rejected with an instruction
to start a new session. The optional Haiku rolling-summary hook remains a v1
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
