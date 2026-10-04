# OpenCode v2 cold SDK initialization investigation

## Evidence and scope

Investigated on Windows / Node 24 against `feat/opencode-v2` at `71f0462`.
All host binaries came from the official npm platform package, with SHA512
integrity checked by `scripts/run-host-smoke.mjs`. No real credentials were used.

The supplied `anthropic-v2-host-smoke-MpjlCB/host.log:155` records:

```text
2026-10-04T01:23:26.145Z run=6e8fed88
Failed to drain Session
Cannot initialize anthropic/claude-sonnet-5-5:
Protocol "https:" not supported. Expected "http:"
at Vc (B:/~BUN/root/chunk-94p3wazh.js:37:17761)
at ModelResolver.resolveCatalogModel
```

Its `report.json` records zero upstream requests and 72,560 ms elapsed, failing
in `primary generation (including a cold SDK install)`.

Host source references below are at **tag `v2.0.22`**, not current HEAD:

- `packages/core/src/model-resolver.ts:196-219,328-344`: `resolveCatalogModel`
  maps an AI SDK initialization cause into `ModelInitializationError`. The
  compiled `Vc` frame is the error-wrapper path, not an HTTP request callsite.
- `packages/core/src/plugin/internal.ts`: `ProviderPlugins` are in `pre`.
  `plugin/supervisor.ts:91-95` orders pre, external packages, then post;
  `plugin.ts:125-146` activates them sequentially. This is **not** a race where
  the external SDK hook sometimes registers too late.
- `packages/core/src/aisdk.ts:290-299,334-356` runs SDK hooks in registration
  order. `plugin/provider/dynamic.ts:13-15` loads a factory if `evt.sdk` is empty.
- `packages/core/src/plugin/provider/sdk-factory.ts:5-15` installs registry
  specifiers through `npm.add`; only `file://` bypasses that install. This file
  is under `plugin/provider/`, not `packages/core/src/sdk-factory.ts`.
- `packages/util/src/npm.ts:207-246` uses `@npmcli/arborist` and `reify`, not a
  `bun install` subprocess. `npm-config.ts` loads npm configuration. The old
  plugin's pinned registry specifier therefore required a redundant install
  **before** `lib/host/v2-transport.mjs` could replace the SDK with its own copy.
  A successful baseline run (`WKGSg9`) has that extra package in its isolated
  `cache/opencode/npm/@ai-sdk/anthropic@3.0.111/` directory.

The original smoke whitelists environment variables: it does not inherit proxy
or npm registry settings, and uses a fresh HOME/config/cache. Its HTTP mock is
only `OPENCODE_MITM_BASE_URL`, used by the shared request executor. It does not
redirect the host's npm registry traffic. The network guard wraps web `fetch`,
not npm's Node-compatible HTTP transport.

`aisdk.ts:121-174` constructs a fetch closure during initialization; it does not
send a request then. `provider.ts:154-164` only parses timeout settings. The
HTTP request hook and loopback bridge run during generation, after SDK
initialization. No timeout or bridge changes are needed for this failure.

**Diagnosis boundary:** the observed protocol rejection belongs to host SDK
initialization, with its redundant npm install the identified network path.
The natural protocol mismatch did not recur in ten baseline runs. The supplied
log discards the original HTTP/agent stack, so this investigation does **not**
claim to identify the particular Bun/npm agent defect or its intermittent
trigger. That needs upstream instrumentation preserving the nested install
cause, request protocol and agent protocol. It is not evidence of an Anthropic
API failure or of the plugin's loopback agent choosing HTTPS incorrectly.

Upstream should make the dynamic installer a final fallback after external SDK
hooks, so supplying an SDK actually avoids an install. Separately, the host must
retain the underlying npm HTTP error stack to diagnose and fix the incompatible
HTTPS URL / HTTP request-or-agent selection in its bundled runtime. Moving that
fallback would remove this exposure for plugins, but would not fix registry
transport for other host installs. No change was made to the host checkout.

## Clean mitigation

Managed model packages now point to `aisdk:file://…/v2-sdk.mjs`. Both supported
host tags explicitly support this factory path. The module re-exports the
already-installed, pinned `createAnthropic`; the standalone build ships a
self-contained copy. The existing external SDK hook still supplies managed
credentials, the language adapter and Core's fetch middleware. No host globals,
retry policy, deadlines, native-provider hooks or unrelated providers change.

This removes the plugin's unnecessary dependency on the host npm transport,
rather than patching that transport or retrying a failed initialization. Core
uses the provider ID `anthropic` for a file factory's option/metadata key. The
language adapter accepts the old version-qualified input key as well, preserving
signed reasoning supplied by older sessions.

The smoke now points the host registry to an isolated loopback endpoint that
returns 403 and counts requests. Generation must complete with **zero registry
requests**. This is deliberately stronger than relying on a warm npm cache.
Host binary and catalog downloads are still allowed; this is not an offline-host
claim. The registry restriction does not apply to the binary downloader.

## Measurements

Artifacts are under `node_modules/.host-smoke-artifacts/`; each smoke directory
has `report.json` and `host.log`. Directory names below have prefix
`anthropic-v2-host-smoke-`.

| Experiment                                                            | Result                                                            | Artifact suffixes                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Unchanged 2.0.22 baseline, 10 consecutive runs                        | 10 passed, 0 failed                                               | WKGSg9, NDYvIL, PeQxsN, Nsrnw0, CrPJBa, Rjy004, 1kZlgw, l2BxXH, OzFERu, kyjPQT |
| Old plugin, registry-denial negative control                          | Failed before generation; 1 registry request, 0 upstream requests | 66Sodr                                                                         |
| Local-factory mitigation, 10 consecutive 2.0.22 runs, registry denied | 10 passed, 0 failed; all 0 registry requests                      | sppapt, RWUgOx, cjpRCk, FRohZG, yh5CEz, Pvg4bv, 5aQTzh, BDX5LR, UTH9uX, JqQLsV |
| Local-factory mitigation, 3 consecutive 2.0.21 runs, registry denied  | 3 passed, 0 failed; all 0 registry requests                       | nFMpZA, kKiCUa, URhq8o                                                         |

The negative-control log reports `403 Forbidden - GET
http://127.0.0.1:6072/registry/@ai-sdk%2fanthropic`, wrapped at the **same `Vc`
and `ModelResolver.resolveCatalogModel` frames** as the original failure. This
proves the old plugin cannot initialize without the redundant install; it is
not a forced reproduction of the exact HTTPS/HTTP protocol defect.

Do not interpret 0/10 before and 0/10 after as a measured statistical reduction
in the natural flake rate. The deterministic improvement is removal of the
registry request and survival of registry denial, not a claimed baseline rate
extrapolated from the originally reported one failure and one success.

`npm test` passed 2,090 tests in 104 files, with two platform skips; `npm run
lint` passed. Regression coverage checks the local factory using the host's
load-before-hook ordering, actual SDK streaming through Core-style middleware,
current and legacy option/metadata keys, and standalone factory imports outside
the repository and its node_modules. Installer fixtures include the extra
bundled factory file. The initial targeted runs caught and corrected two test
fixture issues: a hard-coded old package name, then an invalid two-credential
constructor input in the new pre-hook simulation.
