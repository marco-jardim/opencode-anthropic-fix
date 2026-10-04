# Plugin compatibility with OpenCode v1 and v2

Assessment date: 2026-09-30 (America/Sao_Paulo). Status: implementation completed in the original compatibility worktree, with automated tests and smoke tests for all four hosts passing on Windows. Real OAuth/Anthropic and the interactive TUI still require manual validation before release. The assessment below describes the baseline before implementation; the final architecture and evidence matrix are in [the v2 guide](../opencode-v2.md).

## Assessment and scope

**The current plugin is not compatible with OpenCode v2.0.21.** The incompatibility starts at loading and also affects authentication, transport and commands. Simply changing the configuration name or wrapping the existing function in `setup` does not solve it.

Inspected baseline: `opencode-anthropic-fix` 2.1.1, commit `2a7ebc3`, in this task's worktree. The code exports `AnthropicAuthPlugin({ client })`, a function that returns v1 hooks (`index.mjs:255`, `index.mjs:2454`, `index.mjs:6584`). The v2 loader requires `default` with `id` and a `setup` or `effect` function; the rejection message defined in the code is `Plugin must export a default definition with an id and an effect or setup function.` [S1]

On 2026-09-30, the direct npm query returned **2.0.21** for `@opencode/cli` and `@opencode/plugin`, and **1.18.34** for `opencode-ai` and `@opencode-ai/plugin`. These are queried versions, not guarantees about future versions of `latest`. This plugin's lockfile contains `@opencode-ai/plugin` and SDK **1.2.27**, plus wire-compat **0.7.1**. The development dependency version alone does not determine host compatibility.

Goal: one package that preserves the v1 path and adds a v2 implementation, sharing accounts, configuration, OAuth and wire behavior. Implementation takes place in this task's worktree. It does not change the active checkout at `D:\git\opencode-anthropic-fix`, installations, credentials or user settings.

### Proposed version contract

| Line      | Initial validation target          | Policy                                                                                    |
| --------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Recent V1 | 1.18.29 and 1.18.34                | Validate the dual object entry; 1.18.29 is the documented minimum for this format. [S2]   |
| Legacy V1 | 1.2.27 as a loader regression case | Preserve `index.mjs` and test the old route; do not declare all 1.x versions certified.   |
| V2        | 2.0.21                             | First version to certify fully; earlier or later versions require running the matrix.     |
| V1 forks  | Existing optional features         | Preserve behavior conditional on the fork's capabilities, separate from upstream support. |

## Evidence and verification limits

- Read the v2 loader at tag `v2.0.21`, commit `8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72`, and the v1 loader at tag `v1.18.34`, commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.
- An in-memory Node probe evaluated only the local factory declaration, without executing it or loading its dependencies. Result: `type=function`, `id=undefined`, `setup=undefined`, `effect=undefined`; the v2 required-field predicate evaluates to `false`. This was not a host startup test.
- Probe of the actual `lib/mimicry/response-stream.mjs` module: the shim is active for `ai-sdk/anthropic/3.0.111`, inactive for `4.0.0` and **active** for a User-Agent containing only `opencode/2.0.21`. This demonstrates the risk of applying the old policy to the new transport; it does not prove how a v2 session would respond.
- The existing suite uses hook/client mocks. CI varies Node 20/22/24, but not OpenCode versions (`.github/workflows/ci.yml`).
- `node_modules` is absent from this worktree. No installation, Vitest run, build, login, Anthropic call or end-to-end trial took place. The negative assessment follows from the incompatible entry contract, not from an observed failure in an authenticated session.

## Capability inventory

| Capability                 | Current implementation                                                                | V2 target and condition                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin entry               | Named/default are the same factory; tests require only functions                      | New entry with `id`/`setup`, preserving `index.mjs` for v1.                                                                                         |
| OAuth and persistence      | `auth.methods`, `auth.loader`, `client.auth.set`; `index.mjs:436`, `:2492`, `:4547`   | `ctx.integration.transform`, OAuth method registration and connection/credential APIs. V2 credentials include `methodID`. [S5]                      |
| HTTP interception          | `auth.loader` returns `apiKey: ""` and `fetch`; `index.mjs:2586`                      | `http.request`/`http.response` hooks; there is no `next` callback or direct fetch replacement on this surface. Feasibility proof required. [S6, S7] |
| Rotation/retries           | Executor controls account, refresh, HTTP errors and body/beta fallback                | Reuse existing decisions; define a single owner for each retry between plugin and host.                                                             |
| Models and costs           | Mutates `provider.models[*].cost/limit`; `index.mjs:2498`                             | `ctx.model.transform`; v2 cost is an array of tiers. Change all relevant tiers, only for managed OAuth. [S16]                                       |
| `/anthropic`               | `config.command`, `command.execute.before`, `output.noReply`; `index.mjs:2470`        | Server-side `execute` returns `void`; interactive display requires TUI + RPC. Do not assume the command returns text. [S8, S15]                     |
| Response and notifications | V1 SDK `{ path, body }`, `session.prompt`, `tui.showToast`; `index.mjs:412`, `:2177`  | Adapt session APIs; the v2 UI has a separate lifecycle. Do not assume that `ctx.client` or `ctx.tui` exist.                                         |
| Prompt and messages        | `experimental.chat.*`; `index.mjs:2456`, `:4628`                                      | Adapt the actual formats in the `context` hook; register `compaction`, `generate` and `title` when transformation is needed in those flows.         |
| Compaction                 | `experimental.session.compacting`; `index.mjs:4640`                                   | `compaction` hook, preserving limits and without treating v2 checkpoints/parts as v1 messages.                                                      |
| Optional Haiku summary     | `experimental.session.summarize`; `index.mjs:4687`                                    | Fork-dependent feature, off by default (`lib/config.mjs:348`). Not a mandatory upstream v1/v2 requirement; diagnose the missing capability.         |
| SSE and tools              | Removes `mcp_`, converts PascalCase names, extracts usage and applies the v1 SDK shim | Preserve protocol/usage, but select policy based on the actual parser. The native v2 provider and the AI SDK path are different consumers.          |
| Files and CLI              | Local config/accounts and `cliMain`, independent of the SDK                           | Share modules; retain paths, schema, permissions and in-process CLI execution.                                                                      |

## Recommended architecture

### Separate entries, shared core

Keep `index.mjs` as the v1 entry, exporting only `AnthropicAuthPlugin` and `default` as it does today. Add `server.mjs` with a single default containing `id`, `server` for recent v1 and `setup` for v2. Each implementation must initialize lazily: loading one host does not initialize the other implementation.

The v2 loader looks for `server` before the root; recent v1 also checks `exports["./server"]`. [S3, S4] Proposed manifest:

```json
{
  "main": "./index.mjs",
  "exports": {
    ".": "./index.mjs",
    "./server": "./server.mjs"
  }
}
```

Add the new entry to `files`. Validate resolution of the npm package, absolute directory, `file:` and installed bundle before finalizing this manifest. Adding `exports` may restrict old subpaths; inventory documented uses and preserve those that are needed. V1.2.27 imports the root and deduplicates the named/default factory by identity. V1.18.34, however, can find the manifest and redirect even an explicit file path to `./server`: pointing to `index.mjs` is not a universal bypass. [S4, S20]

The current `index.mjs` export tests remain valid; add separate tests for `server.mjs`. Avoid exporting helpers from any entry. The proposed ID is `opencode-anthropic-fix`, constant across reinstalls and reloads.

Extract only the necessary boundaries from the current closure into `.mjs` modules in `lib/host/` and a shared transport executor: credential reading/persistence, local output delivery, notifications and host capabilities. Do not duplicate the interceptor's approximately two thousand lines of code or rewrite the wire, rotation or backoff modules.

There is module-scoped state in `index.mjs`: `_pluginConfig:4724`, `adaptiveContextState:4757`, `cacheBreakState:4780`, `microcompactState:4803`, `telemetryEmitter:5795`, `liveTokenRef:5798` and the `beforeExit:5806` listener. The extraction must place the necessary state in a per-instance runtime factory, with explicit disposal. Importing the v1 entry as the v2 core would risk configuration, metrics and tokens crossing instance/reload boundaries.

Use JSDoc with the v1/v2 contracts. In v2.0.21, `Plugin.define` returns the object it receives, so a typed structural definition is an option to avoid a runtime dependency just for this helper. If the solution uses other exports at runtime, declare a compatible `@opencode/plugin` production dependency and justify the cost; do not accidentally depend on a devDependency in the published package. [S14]

### Options considered

| Option                                                      | Benefit                                                        | Cost/decision                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Entries above + adapters and shared core                    | Preserves the legacy contract and allows a single distribution | **Recommended**, subject to the resolution trial.                                                     |
| Directly replace the `index.mjs` default with a dual object | Fewer files                                                    | Imposes a recent v1 minimum and breaks the repo's legacy invariants; do not choose.                   |
| V2-only package or release line                             | Isolates dependencies and loaders                              | Alternative if resolution or transport makes a single package infeasible; increases maintenance.      |
| Replace the native v2 provider with the AI SDK path         | May offer custom fetch close to the current contract           | Fallback plan: requires validating the SDK, dependencies, native features and compaction regressions. |

## Technical decisions that need proof

### Transport, rotation and cancellation

In v2.0.21, the host converts the request to `Request`, fires `http.request`, sends it through the handler and then fires `http.response`. The response receives the same `before.request` reference. This allows investigating a `WeakMap<Request, AttemptState>` without adding internal headers to the wire. A transport failure before the response skips `http.response`. These details are evidence from the analyzed tag, not a promise of future stability. [S7]

Proposed initial proof:

1. `http.request` selects the account and prepares an Anthropic request through the same wire builder; the host performs the first send.
2. `http.response` receives that first result, runs only the necessary additional attempts and replaces `event.response` with the final result, transforming SSE exactly once.
3. The host's `retry` hook covers transport errors that do not reach the response hook. The policy must avoid multiplying attempts already consumed by the plugin and preserve per-account limits/backoff.
4. Attempt state, configuration and account are associated with the correct request; do not use a single slot per session for parallel title, subagent and generation calls.

**Architecture gate:** prove abort during waiting, refresh, fetch and SSE consumption. The public Promise callback does not receive an explicit cancellation signal; do not assume that `request.signal` propagates cancellation of the entire operation. The host limits retries to ten, and the retry event contains neither `kind` nor a request ID. [S17] If these constraints prevent preserving behavior, test the AI SDK alternative with custom fetch; if both fail, record the required public extension upstream and keep v2 unsupported. Do not publish partial support as complete.

On the native path, `Provider.nativeSettings` removes `fetch`; adding `settings.fetch` does not solve this. On the AI SDK path, `core/aisdk.ts` accepts this executor. [S18] On either route, discard rejected response bodies, preserve the original request per attempt and prevent double sanitization/tool prefixing.

### Authentication and state

- Register a dedicated method in the `anthropic` integration, with a stable ID, mapping `authorize`, the `mode: "code"` return value and `refresh`; do not return the v1 OAuth object without conversion. [S5]
- Preserve `AccountManager` as the owner of pool selection. The adapter keeps the managed connection's credential consistent with the selected account, without overwriting unrelated connections.
- The plugin surface offers `integration.connection.active/resolve/status`, but not `ctx.credential`. The public `credential.update` endpoint changes only the label. Do not plan around a nonexistent arbitrary token setter. The authorization/refresh bridge and behavior after switch/removal must be demonstrated in step 1; evaluate a logical pool credential without duplicating all accounts in the host. [S5, S19]
- Define a single refresh path so that the host callback and executor share the existing single-flight refresh and locking mechanism. Test simultaneous renewal by v1, v2 and CLI.
- Startup without accounts must allow login. Login, reauth, switch, disable/remove and logout must update provider activation and inventory, without capturing expired tokens in transforms.
- Do not silently migrate `anthropic-accounts.json` to `ctx.storage`: retain schemas and paths. On Windows, the code uses `%APPDATA%\opencode`; on other platforms it uses XDG. The plugin installation directory is a separate concern.
- Preserve atomic writes, `0600` permissions where supported, the 10-account limit, debounce and `.gitignore`. Test cross-process concurrency to detect refresh/state overwrites; any required persistence fix must maintain file compatibility.

### Models, tools, streaming and commands

- Treat transforms as synchronous, repeatable callbacks. Load external data outside them and use `reload()` when configuration or account changes. `/anthropic set` must take effect on the next request.
- Apply wire policy to all required call types, not just the main chat: chat, title, compaction, generate and plugin-controlled auxiliary calls, including token counting.
- Keep the single wire-compat import point, `WIRE_PROFILE`, OAuth betas, identity/sanitization only in the system prompt, literal paths and Unicode intact.
- Audit actual tool names: v2 adopts `shell` and `subagent`, among others, while the current reverse map contains `Bash → bash` and `Task → task`. Create a reversible translation from the tools advertised in the request; test collisions, MCP and history. Do not apply an unconditional v1 table to v2. [S11]
- Separate SSE policy from the Anthropic protocol: the `@ai-sdk/anthropic@3.0.111` shim is not automatically appropriate for the native `@opencode/ai/providers/anthropic` provider. Test unknown events, thinking, citations, tools, usage and errors after partial emission; never repeat a generation already partially delivered as though nothing had happened.
- Share parsing and `cliMain(argv, { io })` in a server executor. For interactive `/anthropic`, plan for `tui.mjs` and `exports["./tui"]`, register `keymap.layer` with `slash: { name: "anthropic", arguments: true }`, call the executor through RPC and display the result in `ui.dialog.alert`/`ui.toast.show`. Validate the TUI entry signature and its behavior in recent v1; the additional feature must not prevent v1 loading. [S15]
- `ctx.command.transform` allows execution without an LLM, but `execute` does not return text to the UI. `ctx.session.synthetic` must not be used as an equivalent of `noReply`: its content enters the conversation. Test precedence before registering the same slash command on the server and in the TUI. Displaying output in a dialog instead of inserting text into history is an interface difference to document.
- RPC must validate arguments and return only sanitized output, without tokens; prove **zero model calls** for administrative commands. OAuth codes must not become prompts. Login, transport and CLI remain operational without TUI; other clients use the documented programmatic interface.
- Return cleanup from `setup`: stop timers, pending OAuth flows, subscriptions and the plugin's own requests; unloading/reloading must not duplicate handlers or write state after shutdown.

## Implementation steps and exit criteria

| Step                              | Work                                                                                                        | Criterion to advance                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contract proofs                | Pin versions; reproduce loaders, credential bridge, TUI/RPC and transport with a simulated Anthropic server | Dual entry resolves once; switch/refresh have a viable API; administrative output does not become a prompt; retries, concurrency and abort can be preserved. Choose the native or AI SDK route based on evidence. |
| 2. Common boundaries              | Extract host adapter and reusable executor, keeping v1 as the first consumer                                | V1 tests and wire snapshots do not change semantically; no v2 API required on the legacy path.                                                                                                                    |
| 3. V2 entry, OAuth and models     | Add `server.mjs`, v2 adapter, OAuth method, connection and transforms                                       | Login/refresh/switch work; costs and limits update with OAuth and config; v1 continues to load.                                                                                                                   |
| 4. V2 transport and context       | Implement the approved option, SSE/tool map policies and context hooks                                      | Chat and auxiliary calls pass the error, streaming, tool and cancellation matrix without duplication.                                                                                                             |
| 5. Commands and lifecycle         | Port `/anthropic`, RPC, TUI entry, local output, notifications and cleanup                                  | Administrative commands do not invoke an LLM; documented interfaces work without TUI; reload does not leak resources.                                                                                             |
| 6. Distribution and documentation | Adjust `files`/`exports`, build, installer, README and mimicry contract                                     | Packed package and link/copy installation pass on target hosts, including Windows. Instructions preserve rollback to v1.                                                                                          |
| 7. Certification                  | Run the full matrix and a controlled real OAuth trial                                                       | Evidence attached by version; no mandatory gaps; only then declare support and follow the PR release process.                                                                                                     |

Planned files: `server.mjs`, `tui.mjs` and RPC contract according to the host API, new `lib/host/*.mjs` modules, targeted extractions from `index.mjs`, `lib/mimicry/response-stream.mjs`, adapter tests and fixtures, `package.json`/lock, `scripts/build.mjs`, `scripts/install.mjs`, CI, README, CONTRIBUTING and `docs/mimese-http-header-system-prompt.md`. Preserve conformance tests; expand coverage rather than replacing it with mocks of the new wrapper.

## Testing strategy

### Host matrix and distribution

- v1.2.27: legacy entry and resolution regression; expand functional certification only if this minimum is retained as a support promise.
- v1.18.29 and v1.18.34: loading, OAuth, fetch, command and dual entry.
- v2.0.21: the same behaviors through the v2 adapter, including operation without TUI.
- Node 20/22/24 for current checks; include Linux and Windows in the package/installer trial. Use each host release's own runtime, without confusing Node tests with OpenCode tests.
- Test the locally published tarball with `npm pack`, in addition to the linked checkout, absolute directory, package-based configuration and bundles. Keep temporary homes/config/data isolated and prevent tests from reading real credentials.

### Acceptance cases

1. Factory/definition loaded exactly once; helper never called as a plugin; provider and command appear in public APIs. Test an old standalone installation coexisting with the package, to diagnose duplication without initializing two pools.
2. No credential, login, expired/invalid code, reauth, single refresh, disabled/removed account, exhausted pool and switching with an ongoing session.
3. Requests as URL/init and `Request` with body; large messages, Unicode, streaming, token counting, custom baseURL and non-Anthropic providers intact.
4. 401 with refresh, account-specific 403, 429 and `Retry-After`, 529, beta rejection, fast/standard fallback, network error and maximum attempt budget.
5. Cancellation at all phases, backpressure, first token, mid-SSE error, reader cancellation and no replay after partial output.
6. Native/MCP/subagent tools: outbound/inbound names and matching `tool_use`/`tool_result`; thinking/citations/usage and unknown events handled by the correct consumer.
7. Mutable config, OAuth costs/limits, title/compaction/generate, two simultaneous sessions and v1/v2/CLI concurrency over existing files.
8. Administrative commands without an LLM; authentication text/codes do not become prompts. Repeated cleanup, reload and removal without duplicate timers/connections.

First run targeted tests for the step. On implementation completion: `npm test`, `npm run lint`, `npm run format:check`, `npm run build` and `npm run check:invariants`; before release, also `npm run check:wire-compat-drift`. A real authenticated test validates login and the Anthropic response, but does not replace the simulator's deterministic failures. Do not store tokens in fixtures, logs or CI.

## Risks, rollback and open decisions

| Risk                                                            | Mitigation/condition                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Native retries do not offer the same control as v1 fetch        | Step 1 before broad extraction; explicitly measure the AI SDK alternative; block support announcements if public capabilities are missing. |
| Abort does not reach the plugin's own fetch in the Promise hook | Proof with real cancellation; the feature cannot be considered complete based solely on tests with mocked objects.                         |
| V1 shim or names corrupt the v2 response                        | Explicit per-adapter profiles and tests through the host's parser/tool execution.                                                          |
| New `exports`/bundle breaks v1                                  | Preserve the old entry and its tests; run all installation modes and ensure a single load.                                                 |
| Double refresh or lost update across processes                  | Share locks and persistence policy; exercise concurrent v1/v2/CLI operation.                                                               |
| API evolves or beta docs diverge from stable                    | Use exact tags/SHAs and npm versions; update the matrix before expanding the support claim.                                                |

Rollback: reinstall the previous plugin version and select the preserved v1 entry/configuration, without destructive file migration. Keep a backup before any future host configuration conversion. V1 and v2 use the same configuration locations and the `opencode` command in the stable distribution; side-by-side testing requires isolated executables and directories, not installing one over the other. [S11]

Proposed implementation decisions: start with v2.0.21; preserve recent v1 with the dual entry and the legacy `index.mjs` path; do not promise equivalence for the fork hook `experimental.session.summarize`; use TUI/RPC for interactive output and choose transport after the step 1 proof. The final minimum supported legacy v1 version and the scope of support for clients beyond the TUI depend on the trials, without blocking the initial investigation. No authorization to implement, commit or release is inferred from this plan.

## Primary sources

- **S1:** [V2.0.21 loader: schema and entry rejection](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/plugin/module.ts#L60).
- **S2:** [Official plugin migration guide: dual contract and v1 minimum](https://opencode.ai/v2/docs/build/plugins/migrate-v1/#support-v1-and-v2-from-one-package).
- **S3:** [V2.0.21 entry resolution](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/host.ts#L17).
- **S4:** [V1.18.34 resolution and validation](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/plugin/shared.ts#L103).
- **S5:** [V2.0.21 integrations/OAuth Promise API](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/integration.ts).
- **S6:** [V2.0.21 session and HTTP events](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/session.ts#L63).
- **S7:** [HTTP hook execution in the v2.0.21 host](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/session/model-request.ts#L334).
- **S8:** [V2.0.21 command contract](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/command.ts).
- **S9:** [Official plugin reference](https://opencode.ai/v2/docs/build/plugins/).
- **S10:** [V2.0.21 public AI SDK hooks](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/aisdk.ts).
- **S11:** [Stable host migration: configuration, tools and installation](https://opencode.ai/v2/docs/migrate-v1/).
- **S12:** [@opencode/plugin 2.0.21 npm manifest](https://registry.npmjs.org/@opencode%2fplugin/2.0.21).
- **S13:** [V2 CLI npm registry](https://registry.npmjs.org/@opencode%2fcli) and [v1 host npm registry](https://registry.npmjs.org/opencode-ai).
- **S14:** [V2.0.21 context, definition and Plugin.define helper](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/plugin.ts).
- **S15:** [V2.0.21 public TUI context](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/tui/context.ts).
- **S16:** [V2.0.21 model/cost schema](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/schema/src/model.ts).
- **S17:** [Host retry policy](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/session/runner/retry.ts) and [Promise hook adapter](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/adapter.ts#L578).
- **S18:** [Native provider settings](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/provider.ts#L135) and [custom fetch in AI SDK](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/aisdk.ts#L130).
- **S19:** [V2.0.21 credential API](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/protocol/src/groups/credential.ts).
- **S20:** [V1.2.27 legacy loader](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/plugin/index.ts).
- **S21:** [V2.0.21 native Anthropic parser](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/ai/src/protocols/anthropic-messages.ts#L1510).
