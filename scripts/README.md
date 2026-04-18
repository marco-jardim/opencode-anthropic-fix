# `scripts/` — developer and reverse-engineering tooling

Not shipped with the npm package. Two top-level scripts are tracked in git
(`build.mjs`, `install.mjs`); everything in the subfolders below is gitignored
because it's research scaffolding with no stable API.

## Tracked (shipped to contributors via git)

| File          | Purpose                                                          |
| ------------- | ---------------------------------------------------------------- |
| `build.mjs`   | esbuild bundle step invoked by `npm run build`                   |
| `install.mjs` | `npm run install:link` / `install:copy` / `uninstall` entrypoint |

## Untracked subfolders (research / debugging)

All paths below are gitignored. Copy them from a prior clone or regenerate
them as needed.

### `mitm/` — headed MITM proxy for comparing opencode vs. real Claude Code

- `proxy.mjs` — Node HTTPS MITM. Terminates TLS with a local CA, streams both
  request and SSE response bodies to disk, and tags each transaction with the
  originating client (CC vs. plugin) via Host/User-Agent sniff. **Runs headed**
  — you must interact with CC or opencode manually in a second terminal.
- `capture-and-compare.ps1` — PowerShell wrapper that spawns the proxy, sets
  `HTTPS_PROXY`, and kicks off a paired capture.

### `capture/` — one-shot request dumpers

Non-MITM variants used when you can't terminate TLS. These hook the plugin's
fetch layer directly from within the running process to serialize request
bodies to JSON for later replay.

- `proxy.mjs`, `proxy-v2.mjs` — generic request tap
- `opencode-proxy.mjs` — opencode-specific hook points
- `plugin.mjs` — hooks into the plugin's internal `fetchFn` for live dumps
- `dump-proxy.mjs` — minimal stdout-only dumper for quick diagnostics

### `extract/` — static analysis of the CC binary / bundle

- `binary.mjs` — runs `strings` on the CC Bun-compiled binary and extracts JS
  literals (error messages, beta names, URLs). Needed from v2.1.113+ when CC
  stopped shipping a JS bundle.
- `betas.mjs` — greps extracted strings for `*-YYYY-MM-DD` beta identifiers
- `keywords.mjs` — pulls all string literals matching known mimicry-relevant
  patterns (`claude-code-*`, `anthropic-*`, URL prefixes)
- `find-vars.mjs` — locates variable bindings that correspond to hand-named
  reference functions (`d6A`, `d85`, `NJ7`, etc.) in the bundle
- `list-tools.mjs` — enumerates all built-in tool definitions by reading the
  bundle's tool registry map

### `bisect/` — binary-search tools for finding the minimal request shape

that reproduces a server-side error. Each file is a different axis of
narrowing (`tools`, `names`, `schema`, `size`, `body`, `todowrite`, …).
Historically used to debug why the plugin's request was rejected while CC's
passed (e.g., tool-name case sensitivity, oversized tool schemas).

### `verify/` — post-fix validation harnesses

- `cch.mjs` — verifies the client attestation hash against a known-good
  capture (now trivial since v2.1.97 made `cch=00000` static)
- `fix.mjs` — replays a regression-triggering request against a running
  plugin to confirm the fix holds
- `check-todowrite.mjs` — specifically exercises the `TodoWrite` tool path
- `curl-cc-test.mjs` — shell-style one-shot round-trip
- `minimal-request.mjs` — smallest valid request shape used as a sanity probe

### `replay/` — replay captured requests

- `request.mjs` — generic replay of any dumped `request-*.json`
- `sonnet.mjs` — Sonnet-specific replay with model override

### `analyze/` — diffing tools

- `compare-captures.mjs` — side-by-side diff of paired CC vs. plugin captures
- `diff-requests.mjs` — structural JSON diff with key-path callouts
- `v96-diff.mjs` — version-specific diff helper (CC 2.1.95 → 2.1.96)

## Typical workflows

**"The plugin is getting a 4xx that CC doesn't get"**

1. `mitm/proxy.mjs` — capture paired requests
2. `analyze/compare-captures.mjs` — find the divergence
3. `bisect/<axis>.mjs` — minimize the bad request
4. Fix in `index.mjs`
5. `verify/fix.mjs` — confirm it passes

**"New CC version dropped, what's different?"**

1. `extract/binary.mjs` — pull strings from the new binary
2. `extract/betas.mjs` — find new beta identifiers
3. `extract/find-vars.mjs` — locate renamed reference functions
4. Update `FALLBACK_CLAUDE_CLI_VERSION` + `CLAUDE_CODE_BUILD_TIME` in
   `index.mjs` (~line 5080)
