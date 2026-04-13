# AGENTS.md

Compact guidance for agents working in this repo. See `CONTRIBUTING.md` for full
architecture, `README.md` for user-facing features, and
`docs/mimese-http-header-system-prompt.md` for the HTTP mimicry contract.

## What this repo is

OpenCode plugin + standalone CLI (`index.mjs` + `cli.mjs`, both ESM `.mjs`) that
lets Claude Pro/Max subscribers use OpenCode over OAuth, with multi-account
rotation and deep Claude Code request mimicry. Node 18+ runtime, no TypeScript
(typing is via JSDoc). One production dep: `@openauthjs/openauth`.

## Layout (what matters)

- `index.mjs` — plugin entry (OAuth, fetch interceptor, retry loop, `/anthropic`
  slash command). Large file; prefer `grep` over reading end-to-end.
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
npm test              # full suite (root + worker/sync-watcher, ~13s, ~951 tests)
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
  API blocks the literal string "OpenCode"). Paths like
  `/path/to/opencode-foo` must be preserved.
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

- Version bumps use `npm version patch --no-git-tag-version`, then a separate
  `chore: bump version to X.Y.Z` commit.
- `.github/workflows/publish.yml` auto-publishes to npm on push to `master`
  **only if `package.json` version changed** (diff vs `HEAD~1`). Manual
  `workflow_dispatch` also works. Uses OIDC provenance (`id-token: write`).
- `npm publish --access public` from local also works if you have the token.
- Commits follow conventional-ish prefixes: `feat:`, `fix:`, `chore:`,
  `docs:`. Check `git log --oneline` for tone before writing messages.

## Windows caveats (active dev env)

- Repo lives at `D:\git\opencode-anthropic-fix`. CRLF ↔ LF warnings on every
  commit are expected (`warning: LF will be replaced by CRLF`). Ignore.
- For local OpenCode loading on Windows, use a **junction** (not symlink) into
  `%USERPROFILE%\.config\opencode\node_modules\opencode-anthropic-fix` and
  declare `"plugin": ["opencode-anthropic-fix"]` in `opencode.json`. See the
  troubleshooting section of `README.md` — this avoids the
  `hook.config` crash from stale standalone files in the `plugin/` dir.
- The shell is pwsh. `ls --color=never` does not work; use `Get-ChildItem` or
  the repo's Glob/Grep tools.

## Don't do

- Don't add a second production dependency without strong reason — the bundled
  output size and mimicry surface area both matter.
- Don't introduce TypeScript — the project is deliberately `.mjs` + JSDoc.
- Don't touch `rateLimitResetTimes` / `consecutiveFailures` schema in
  `anthropic-accounts.json` without a migration path; users have existing
  files on disk.
- Don't commit `dist/`, `_tmp_*`, `.mitm/`, `tmp/`, or `_analysis/`.
