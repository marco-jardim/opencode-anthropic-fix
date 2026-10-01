# OpenCode v2 adapter

## Validation recorded on 2026-09-30

Local validation used Windows and Node 24.21.0, plus each official OpenCode
release's own runtime. Host binaries were downloaded from npm with SHA512
integrity verification. All smoke configurations and credentials were temporary.

| Host    | Result | Scope                                                                                                                                                                                    |
| ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2.27  | Passed | Legacy loader, OAuth registration, command registration, 23 OAuth models with zero costs.                                                                                                |
| 1.18.29 | Passed | Dual entry, OAuth registration, one administrative command, 16 OAuth models with zero costs.                                                                                             |
| 1.18.34 | Passed | Dual entry and public provider model hook, OAuth/command registration, 19 OAuth models with zero costs.                                                                                  |
| 2.0.21  | Passed | Server load, OAuth registration, 19 models, RPC without model invocation, chat, auxiliary generation, title, summary compaction, cancellation before response headers and plugin reload. |

The complete automated suite passed **2,286 tests across 113 files**, with two
platform skips on Windows. Build, ESLint, formatting and invariant checks passed;
the invariant check retains the existing warning about differing reverse-engineering
documentation baselines. Installer and standalone package tests run in temporary
directories. The v2 host smoke uses a local Anthropic simulator and blocks direct
Anthropic API access. The v1 host smoke checks loading and registration, not inference.

Run a pinned host again with `node scripts/run-host-smoke.mjs 2.0.21` (or one of
the v1 versions above). CI now runs these four hosts on Linux and Windows; the
Linux jobs have not been run locally. Real OAuth login, real Anthropic inference
and interactive TUI rendering still require manual validation before release.
The TUI behavior is covered by deterministic tests, and its RPC runs in the real
v2 server smoke. See the [architecture decision](opencode-v2-architecture.md).

## Installation

The npm package exposes separate `./server` and `./tui` entries for recent v1
and v2 hosts, and keeps the root `index.mjs` entry for legacy v1 loaders. Existing
`index.mjs`, `cli.mjs` and `lib/*` imports remain available. Use the v2 `plugins`
configuration key when loading the package in OpenCode 2.0.21.

For development or a standalone bundle, run:

```sh
node scripts/install.mjs link --host=v2
# or
npm run build
node scripts/install.mjs copy --host=v2
```

The explicit v2 mode installs the package in
`$XDG_CONFIG_HOME/opencode/node_modules/opencode-anthropic-fix`, falling back to
`~/.config/opencode/node_modules/opencode-anthropic-fix`. Development links use
a directory junction on Windows. The copy contains bundled server, TUI, RPC,
legacy plugin and CLI entries and requires no `npm install` at its destination.
The host may still resolve or download the pinned AI SDK package into its own
cache when initializing the provider.
The installer prints the exact configuration to add and leaves existing
configuration untouched. It reports old standalone plugin entries that could
cause duplicate loading; remove those entries before enabling the new package.

Use `node scripts/install.mjs uninstall --host=v2` to remove a managed package.
The installer refuses to replace or remove an unrecognized package directory or
one with additional files. Without `--host=v2`, installation keeps the legacy
standalone v1 behavior.

## Transport and version boundary

The adapter targets the public OpenCode **2.0.21** contract. It routes managed
Anthropic models through `aisdk:@ai-sdk/anthropic@3.0.111`;
the public SDK hook supplies the pinned `@ai-sdk/anthropic` **3.0.111** provider.
The versioned specifier prevents the host from rewriting the SDK name back to its
native provider and lets its built-in package loader resolve the SDK before the
plugin hook executes. The shared plugin executor keeps account rotation,
wire construction, backoff and the response compatibility shim on the same
path as v1. Explicitly selected API-key or unrelated OAuth connections retain
their own provider settings. A connection owned by this plugin is disabled
when its account pool has no enabled account; it cannot fall back to a stale
credential cached by the host.

OpenCode 2.0.21 accepts only JSON data in provider/model settings, so an injected
`settings.fetch` function is unavailable. On first use, the adapter opens an
HTTP bridge bound to `127.0.0.1` on an ephemeral port. The public HTTP request
hook redirects the host request to that bridge with a single-use random ticket.
The bridge retrieves the original destination from its own ticket map, invokes
the shared executor and streams the response back. It does not accept an
arbitrary target URL from incoming HTTP requests. The host's normal HTTP
middleware remains in place; no functions are stored in model settings.

The host also does not forward its cancellation signal to the AI SDK call.
The adapter therefore associates tickets with session IDs and listens
for the public `session.execution.interrupted` event. Interrupting a session or
unloading the plugin aborts its requests; a lost event stream aborts outstanding
requests and prevents new ones. A disconnected loopback request also cancels
its upstream operation. The correlation header is removed before the shared
executor sends a request to Anthropic. Plugin cleanup closes the local listener.

The compatibility route uses summary compaction. Existing native-provider
checkpoint history must not be treated as ordinary AI SDK message history.
Validation against other OpenCode versions is required before widening the
support claim. Tests against the actual 2.0.21 host exercise boot, RPC, streaming
generation and cancellation using a local mock upstream. They do not constitute
an authenticated end-to-end certification against Anthropic.

## Administrative commands and the TUI

On OpenCode v2, the `./tui` entry registers `/anthropic` as a local TUI command.
The TUI calls the server through the plugin's RPC method and shows the result in
a dialog. Failures appear as toast notifications. Output is not inserted into
the conversation and the command does not submit a model prompt. OpenCode v1
continues to use the existing server slash-command hook.

Run the usual commands, for example `/anthropic usage`, `/anthropic switch 2`,
or `/anthropic set debug true`. OAuth keeps the same two-step flow:

1. Run `/anthropic login` or `/anthropic reauth 1` and open the authorization URL.
2. Complete authorization in the browser.
3. Run `/anthropic login complete <code#state>` or
   `/anthropic reauth complete <code#state>` in the same session.

When invoked from the home screen, the TUI creates an empty session before
running the command. That session holds the pending OAuth flow; it contains no
administrative output or authorization code. Commands entered through the
plugin's TUI layer are intercepted before the host's server command dispatch.

The RPC method is available to other OpenCode v2 clients. Use an existing
session and the location where the plugin is loaded:

```js
import { anthropicCommandRpc } from "opencode-anthropic-fix/rpc";

const commands = client.rpc(anthropicCommandRpc);
const { output } = await commands.execute(
  { sessionID, arguments: "usage" },
  { location, signal: abortController.signal },
);
```

The server also reserves the `anthropic` slash-command name. Clients that call
the server command endpoint directly receive an error directing them to the TUI
or RPC, because that endpoint cannot return administrative output. This avoids
starting an OAuth flow whose URL could not be displayed and prevents command
arguments from falling through to a model prompt.

The RPC ID is `opencode-anthropic-fix`; its method is `execute`. Input is
`{ sessionID, arguments }` and successful output is `{ output }`. The server
verifies that the session exists before executing a command. Arguments must be
a single CLI-style line of at most 8,192 characters. Responses are bounded to
65,536 UTF-16 code units, with grapheme-safe truncation. The server removes
terminal escape sequences, token-shaped credentials and submitted OAuth
completion codes from responses and errors. Authorization URLs remain intact.

The plugin declares `command_failed` and `invalid_session` RPC errors. The host
can additionally return its standard `rpc.*` errors for unavailable services or
invalid requests. Unloading the TUI aborts outstanding RPC calls; disposing the
server registration propagates cancellation to its command executor and removes
the method. Neither RPC nor TUI requires an additional runtime SDK dependency.
