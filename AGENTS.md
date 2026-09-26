# AGENTS.md

> **CANONICAL PATH: `D:\git\opencode-anthropic-fix`** — the env block may show
> `Claude-anthropic-fix`; that is stale. Always use `opencode-anthropic-fix`.

Compact guidance for agents working in this repo. See `CONTRIBUTING.md` for full
architecture, `README.md` for user-facing features, and
`docs/mimese-http-header-system-prompt.md` for the HTTP mimicry contract.

## What this repo is

OpenCode plugin + standalone CLI (`index.mjs` + `cli.mjs`, both ESM `.mjs`) that
lets Claude Pro/Max subscribers use OpenCode over OAuth, with multi-account
rotation and deep Claude Code request mimicry. Node 18+ runtime, no TypeScript
(typing is via JSDoc). Two production deps: `@tormentalabs/claude-code-wire-compat` and `xxhash-wasm`.

## Layout (what matters)

- `index.mjs` — plugin entry (OAuth, fetch interceptor, retry loop, `/anthropic`
  slash command). Large file; prefer `grep` over reading end-to-end. **It must
  export only `AnthropicAuthPlugin` and `default`**: opencode calls every export
  of the entry module as a plugin factory, so any helper exported here breaks
  with `failed to load plugin …` on every start.
  `test/conformance/plugin-entry-exports.test.mjs` enforces it; put helpers in
  `lib/` (e.g. `lib/debug-dump.mjs`).
- `lib/mimicry/wire-compat.mjs` — the **only** import point for
  `@tormentalabs/claude-code-wire-compat`. Binds `WIRE_PROFILE` (currently
  `CLAUDE_CODE_2_1_280_PROFILE`) and passes it explicitly to every builder.
- `lib/mimicry/adapter-input.mjs` — maps the host body/config to the package
  input: additive betas, `suppressBetas`, the beta-rejection latch helpers.
- `lib/mimicry/response-stream.mjs` — SSE transform: UTF-8 decode, line framing,
  `mcp_` tool-name stripping, usage extraction, host-compat shim.
- `lib/unicode-text.mjs` — `truncateGraphemes`; use it for any deliberate cut of
  text that goes to the API (never `slice(0, n)`).
- `cli.mjs` — standalone CLI. The `/anthropic` slash command dispatches into
  `cliMain(argv, { io })` in-process via `AsyncLocalStorage` — no subprocess.
- `lib/*.mjs` — `oauth`, `accounts`, `rotation`, `backoff`, `config`,
  `storage`, `refresh-lock`, `cc-credentials`, `account-state`. Each has a
  colocated `*.test.mjs`.
- `test/` — extra suites organized as `phase1..phase4/` and
  `conformance/regression.test.mjs` (40 tests validating mimicry against
  `docs/claude-code-reverse-engineering.md`). Do not delete these when
  refactoring mimicry code — they are the contract.
- `worker/sync-watcher/` — **separate Cloudflare Workers subproject** with its
  own `package.json`, `vitest`, and `wrangler` deploy. Unrelated to the plugin
  runtime. Its tests run as part of the root `npm test` (vitest picks them up).
- `scripts/build.mjs` — esbuild bundler (ESM, node20, `node:*` external only).
- `scripts/install.mjs` — `link` | `copy` | `uninstall` for
  `~/.config/opencode/plugin/` and `~/.local/bin/`.
- `docs/` — research + mimicry docs. Keep mimicry changes in sync with
  `docs/mimese-http-header-system-prompt.md`.

## Commands

```
npm test              # full suite (root + worker/sync-watcher, ~14s)
npm run test:watch
npx vitest run <name> # single file by name substring
npm run lint          # eslint flat config
npm run lint:fix
npm run format        # prettier write
npm run format:check
npm run build         # esbuild -> dist/
npm run install:link  # dev symlink install
npm run install:copy  # build + copy standalone files
```

Do not run `git commit` manually for small edits — `pre-commit` runs
`npm test` + `lint-staged` (prettier + eslint --fix on staged files).
`pre-push` runs `npm test` + `prettier --check .` + `eslint .`. Both are slow
(~13s minimum) because of the full test suite; budget for it.

## Repo-specific conventions

- **OAuth-first.** Direct `ANTHROPIC_API_KEY` usage is out of scope for normal
  operation. In OAuth mode, `oauth-2025-04-20` is always in `anthropic-beta`.
- **Claude signature emulation is on by default.** Do not regress it. Changes
  to headers / system prompt / betas / body shape require matching updates to
  `docs/mimese-http-header-system-prompt.md`, tests in `index.test.mjs`, and
  `test/conformance/regression.test.mjs`.
- **System prompt sanitization:** "OpenCode" → "Claude Code" is mandatory (the
  API blocks the literal string "OpenCode"). This rewrite applies **only** to the
  system prompt sent to Anthropic — NEVER to code, docs (including this file), or
  paths. Paths like `/path/to/opencode-foo` must be preserved. (If a doc's
  sanitization rule appears to have two identical sides, or shows a
  `Claude-anthropic-fix` path, you are reading a sanitized copy — the real on-disk
  source says `OpenCode → Claude Code` and `opencode-anthropic-fix`.)
- **Tool names get an `mcp_` prefix on the way out and are stripped on the way
  back** (response stream transform). Keep both sides in sync.
- **Config is runtime-mutable.** `/anthropic set ...` writes to
  `~/.config/opencode/anthropic-auth.json`. Functions inside the plugin closure
  must read config live (re-call `loadConfig()` or read from the captured
  `config` ref) — see QA fix H6 in `index.mjs`. Do not cache feature flags in
  closed-over constants.
- **Account storage:** atomic writes, `0600` perms, debounced 1s, max 10
  accounts, auto `.gitignore`. Don't shortcut these.
- **JSDoc types, no `.ts`.** The big `/** @type {{...}} */` block on
  `sessionMetrics` in `index.mjs` is the contract — update it if you add
  fields.
- **ESLint:** unused vars must start with `_` to silence. There are existing
  unused-var warnings — don't treat the lint output as clean-slate.

## Debugging runtime failures in opencode

Start from evidence in the host log, not from the user's pasted snippet:

- **Log:** `~/.local/share/opencode/log/opencode.log` (hundreds of MB — grep, never
  read). One file per start is also written, named by the **UTC** start time.
  Every line carries `run=<id>` (one per opencode process) and `session.id=`.
  Grep the session id the user gives you, then read the `stack=` of the
  `level=ERROR` line.
- **Which code produced the error?** opencode loads the plugin from the path in
  `~/.config/opencode/opencode.json` → `"plugin"` (on the maintainer's machine:
  the live checkout `D:\git\opencode-anthropic-fix`, entry `index.mjs`, deps from
  its `node_modules`). A running opencode keeps the modules it loaded at start:
  updating the checkout does nothing until the user restarts. Compare the
  error's timestamp and `run=` start with the mtime of
  `node_modules/@tormentalabs/claude-code-wire-compat/package.json`. Stack line
  numbers also identify the version, since `sanitizeError` sits on a different
  line of `dist/build-request.js` in each library release.
- **`ClaudeCodeWireError: <CODE>` is a LOCAL rejection by the wire package,
  before fetch.** It has no HTTP status and no request-id. A stack through
  `…claude-code-wire-compat/dist/build-request.js` → `buildWireCompatibleRequest`
  means the library's own validation refused the request, not the API.
  - `INVALID_UNICODE`: since library 0.7.0 only a lone surrogate. The error
    carries `violationPath` / `violationOffset` / `violationReason` in
    `safeDetails`, which the plugin folds into the message. Up to 0.6.x any C0
    control (ANSI `ESC` in tool output) was rejected too.
  - `INPUT_TOO_LARGE (maximumSize=N)`: since 0.7.1 the ceiling is 32 MiB,
    matching the API's request limit. Up to 0.7.0 it was about 1 MB and killed
    long 1M-context sessions.
  - When the library is stricter than the real API, the fix belongs in the
    library (release a new version, then sync). Do not bypass or catch it in the
    plugin.
- **Reproduce offline, no credentials:** import the package from the checkout's
  `node_modules` and call `buildClaudeCodeRequest(input, WIRE_PROFILE)` with a
  minimal input (`accessToken`, `model`, `maxTokens`, `messages`, `runtime` with
  UUID `sessionId`/`deviceId`/`accountUuid`, `clientRequestId`). Build special
  characters with `\u` escapes. Never paste raw control characters or lone
  surrogates into prompts, files or commands. They break the tooling itself,
  including subagent sessions that run through this very plugin.
- **Stale dependency checklist.** The specifier is `latest`, so
  `package-lock.json` decides the version:
  - `npm install` never moves it.
  - A plain `npm update` can answer from npm's cached packument, keep the old
    version and still exit 0.
  - Use `npm run sync:wire-compat`, which runs with `--prefer-online` and then
    the drift check.
  - `npm run check:wire-compat-drift` compares the lock, the installed copy and
    the registry `latest`.
  - npm consumers of the plugin get opencode's own cached deps
    (`~/.cache/opencode/packages/opencode-anthropic-fix@latest/…`); tell them
    to run `opencode plugin opencode-anthropic-fix --force`.
- **Response-side failures inside opencode.** opencode embeds
  `@ai-sdk/anthropic` (3.0.111 in opencode 1.18.32), which validates every SSE
  event against an exhaustive schema. An unknown block, delta or event type
  fails the turn. `response-stream.mjs` maps unknown types to the SDK's
  `fallback` no-op for SDK versions up to 3.0.111; the version comes from the
  incoming user agent. For newer SDKs it only dry-runs and logs through
  `debugLog`. When opencode bumps its SDK, re-extract the allowlists from the
  opencode binary (see the comments on `SDK_KNOWN_*`).
- **`failed to load plugin … <something>` at start:** check `index.mjs` exports
  first (see Layout).

## Testing gotchas

- Tests mock `node:fs` and `node:https` extensively. Mock **before** importing
  the module under test (see existing patterns in `cli.test.mjs`,
  `index.test.mjs`).
- `worker/sync-watcher/test/registry.test.mjs` intentionally sleeps ~3s
  (AbortError timeout test). `test/conformance/regression.test.mjs` has 529
  backoff tests that sleep 2-3s each. Suite total ~13s — not flaky, just slow.
- `test/phase*/` directories are feature-specific integration tests; keep them
  named after the feature they guard.
- Many tests emit stdout from the CLI's account listing — that's expected, not
  a failure.

## Release flow

- Run `npm run check:invariants` then `npm run check:wire-compat-drift` before
  bumping a version — the latter fails if `package-lock.json` is behind the
  registry's `latest` dist-tag for `@tormentalabs/claude-code-wire-compat`
  (see `docs/shared-package-provenance.md`). `.github/workflows/publish.yml`
  runs the same check and blocks the publish step on it.
- Version bumps use `npm version patch --no-git-tag-version` (minor when the
  emulated wire changes), then a `chore: release X.Y.Z` commit with the dated
  CHANGELOG heading. Keep unreleased notes under `## [Unreleased]`, which
  `check:invariants` ignores.
- **`master` is protected** (required checks `quality (20)`, `quality (22)`,
  `quality (24)`, strict): every change, releases included, goes through a PR.
  Wait for `gh pr checks <n> --watch`, then squash-merge. Tag `vX.Y.Z` on the
  merge commit and push the tag.
- `.github/workflows/publish.yml` auto-publishes to npm on push to `master`
  **only if `package.json` version changed** (diff vs `HEAD~1`). Manual
  `workflow_dispatch` also works. It uses OIDC trusted publishing with
  provenance (`id-token: write`, no npm token). The registry can take a few
  minutes to show the new version, and `npm view` may answer from cache, so
  confirm with `curl -s https://registry.npmjs.org/opencode-anthropic-fix`.
- After a release, the maintainer's live checkout (the path opencode loads)
  needs `git pull --ff-only`, `npm ci`, `npm run build` and an opencode restart.
- The wire library (`D:\git\claude-code-wire-compat`, GitHub
  `marco-jardim/claude-code-wire-compat`) has its own release flow: reviewed
  artifact manifest under `release-manifests/`, then a GitHub release
  `vX.Y.Z` that triggers its OIDC publish. Read its `AGENTS.md` first. After it
  publishes, run `npm run sync:wire-compat` here.
- Commits follow conventional-ish prefixes: `feat:`, `fix:`, `chore:`,
  `docs:`. Check `git log --oneline` for tone before writing messages.

## Windows caveats (active dev env)

- Repo lives at `D:\git\opencode-anthropic-fix`. CRLF ↔ LF warnings on every
  commit are expected (`warning: LF will be replaced by CRLF`). Ignore.
- The maintainer's opencode loads the plugin by **absolute path**:
  `"plugin": ["D:\\git\\opencode-anthropic-fix", …]` in
  `~/.config/opencode/opencode.json`. That checkout is live. Never leave it on
  a half-done branch, and do risky work in a git worktree
  (`D:\git\opencode-anthropic-fix-*`). The junction install described in
  `README.md` (`%USERPROFILE%\.config\opencode\node_modules\opencode-anthropic-fix`
  with `"plugin": ["opencode-anthropic-fix"]`) is the alternative that avoids the
  `hook.config` crash from stale standalone files in the `plugin/` dir.
- The shell is pwsh. `ls --color=never` does not work; use `Get-ChildItem` or
  the repo's Glob/Grep tools.

## Don't do

- Don't add another production dependency without strong reason — the bundled
  output size and mimicry surface area both matter.
- Don't introduce TypeScript — the project is deliberately `.mjs` + JSDoc.
- Don't touch `rateLimitResetTimes` / `consecutiveFailures` schema in
  `anthropic-accounts.json` without a migration path; users have existing
  files on disk.
- Don't commit `dist/`, `_tmp_*`, `.mitm/`, `tmp/`, or `_analysis/`.
