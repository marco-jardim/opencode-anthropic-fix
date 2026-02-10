# Codebase Structure

**Analysis Date:** 2026-02-07

## Directory Layout

```
opencode-anthropic-auth/
├── index.mjs                  # Plugin entry point (AnthropicAuthPlugin)
├── index.test.mjs             # Plugin tests
├── cli.mjs                    # CLI entry point (standalone account management)
├── cli.test.mjs               # CLI tests
├── package.json               # Package manifest (v0.0.13)
├── package-lock.json          # Lockfile
├── eslint.config.mjs          # ESLint configuration
├── .gitignore                 # Git ignore rules
├── lib/                       # Shared library modules
│   ├── accounts.mjs           # AccountManager class (runtime coordinator)
│   ├── accounts.test.mjs      # AccountManager tests
│   ├── backoff.mjs            # Error classification and backoff calculation
│   ├── backoff.test.mjs       # Backoff tests
│   ├── config.mjs             # Configuration loading, validation, defaults
│   ├── config.test.mjs        # Config tests
│   ├── rotation.mjs           # Selection algorithms (sticky/round-robin/hybrid)
│   ├── rotation.test.mjs      # Rotation tests
│   ├── storage.mjs            # Disk persistence (atomic JSON read/write)
│   └── storage.test.mjs       # Storage tests
├── scripts/                   # Build and install tooling
│   ├── build.mjs              # esbuild bundler (→ dist/)
│   └── install.mjs            # Plugin/CLI installer (link/copy/uninstall)
├── script/                    # Release automation
│   └── publish.ts             # Bun script: version bump + trigger GitHub workflow
├── dist/                      # Build output (gitignored)
│   ├── opencode-anthropic-auth-plugin.js   # Bundled plugin (single file)
│   └── opencode-anthropic-auth-cli.mjs     # Bundled CLI (single file)
├── .github/
│   └── workflows/
│       └── publish.yml        # GitHub Actions: npm publish on manual trigger
├── .husky/                    # Git hooks
│   ├── pre-commit             # Runs lint-staged
│   └── pre-push               # Runs tests
├── .mitm/                     # mitmproxy debugging tools (gitignored)
│   ├── dump_anthropic.py      # Proxy script for capturing API traffic
│   ├── capture.jsonl          # Captured request/response data
│   ├── flows                  # mitmproxy flow data
│   └── mitmdump.log           # Proxy logs
└── .planning/                 # GSD planning documents
    └── codebase/              # Architecture analysis (this directory)
```

## Directory Purposes

**Root (`/`):**

- Purpose: Entry points and project configuration
- Contains: Two main entry points (`index.mjs`, `cli.mjs`), their co-located tests, and standard Node.js config files
- Key files: `index.mjs` (plugin), `cli.mjs` (CLI), `package.json`

**`lib/`:**

- Purpose: Shared library modules used by both plugin and CLI
- Contains: Five module pairs (source + test), each with a single clear responsibility
- Key files: `accounts.mjs` (core runtime), `config.mjs` (configuration), `storage.mjs` (persistence), `rotation.mjs` (algorithms), `backoff.mjs` (error handling)

**`scripts/`:**

- Purpose: Build and installation tooling
- Contains: `build.mjs` (esbuild bundler), `install.mjs` (symlink/copy installer)
- Key files: `build.mjs` produces single-file bundles in `dist/`

**`script/`:**

- Purpose: Release automation
- Contains: `publish.ts` — Bun-based version bump and GitHub workflow trigger
- Note: Uses Bun APIs (not Node.js), separate from `scripts/` directory

**`dist/`:**

- Purpose: Built artifacts (gitignored)
- Contains: Two self-contained bundled files (plugin + CLI) with all dependencies except Node.js builtins
- Generated: `npm run build`
- Committed: No

**`.github/workflows/`:**

- Purpose: CI/CD automation
- Contains: `publish.yml` — manual-trigger npm publish workflow
- Note: No CI testing workflow; tests run locally via pre-push hook

**`.husky/`:**

- Purpose: Git hooks via husky
- Contains: `pre-commit` (lint-staged), `pre-push` (test runner)

**`.mitm/`:**

- Purpose: Development debugging tools for API traffic inspection
- Contains: mitmproxy scripts and captured traffic data
- Committed: No (gitignored)

## Key File Locations

**Entry Points:**

- `index.mjs`: Plugin entry — exports `AnthropicAuthPlugin` function
- `cli.mjs`: CLI entry — exports `main()` and individual command functions, self-executes when run directly

**Configuration:**

- `package.json`: Package manifest, scripts, dependencies
- `eslint.config.mjs`: ESLint flat config with Node.js globals
- `lib/config.mjs`: Runtime config loading from `~/.config/opencode/anthropic-auth.json`

**Core Logic:**

- `lib/accounts.mjs`: `AccountManager` class — central account coordinator
- `lib/rotation.mjs`: `HealthScoreTracker`, `TokenBucketTracker`, `selectAccount()` — selection algorithms
- `lib/backoff.mjs`: `isAccountSpecificError()`, `parseRateLimitReason()`, `calculateBackoffMs()` — error classification
- `lib/storage.mjs`: `loadAccounts()`, `saveAccounts()` — atomic JSON persistence

**Testing:**

- `index.test.mjs`: Plugin integration tests
- `cli.test.mjs`: CLI command tests
- `lib/accounts.test.mjs`: AccountManager unit tests
- `lib/rotation.test.mjs`: Selection algorithm tests
- `lib/backoff.test.mjs`: Error classification/backoff tests
- `lib/config.test.mjs`: Config loading tests
- `lib/storage.test.mjs`: Storage persistence tests

**Build & Deploy:**

- `scripts/build.mjs`: esbuild bundler producing `dist/` artifacts
- `scripts/install.mjs`: Plugin/CLI installer (link for dev, copy for prod)
- `script/publish.ts`: Release script (version bump + publish trigger)

## Naming Conventions

**Files:**

- Source modules: `kebab-case.mjs` (e.g., `storage.mjs`, `config.mjs`)
- Test files: `<module>.test.mjs` co-located with source (e.g., `lib/storage.test.mjs`)
- Entry points: `index.mjs` (plugin), `cli.mjs` (CLI)
- Build artifacts: `opencode-anthropic-auth-{plugin,cli}.{js,mjs}`

**Directories:**

- `lib/`: Shared library modules (lowercase)
- `scripts/`: Build/install tooling (plural)
- `script/`: Release automation (singular — legacy Bun convention)
- `dist/`: Build output (standard)

**Exports:**

- Classes: PascalCase (`AccountManager`, `HealthScoreTracker`, `TokenBucketTracker`)
- Functions: camelCase (`loadConfig`, `saveAccounts`, `selectAccount`, `calculateBackoffMs`)
- Constants: SCREAMING_SNAKE_CASE (`DEFAULT_CONFIG`, `CLIENT_ID`, `VALID_STRATEGIES`, `RATE_LIMIT_KEY`)
- Types (JSDoc): PascalCase (`ManagedAccount`, `AccountStorage`, `RateLimitReason`)

## Where to Add New Code

**New Library Module:**

- Implementation: `lib/<module-name>.mjs`
- Tests: `lib/<module-name>.test.mjs`
- Import from entry points or other lib modules as needed

**New CLI Command:**

- Add command function in `cli.mjs` (exported, named `cmd<Name>`)
- Add routing in the `switch` statement within `main()` function
- Add to help text in `cmdHelp()`

**New Plugin Hook:**

- Add in the returned object from `AnthropicAuthPlugin()` in `index.mjs`
- Follow OpenCode plugin API types from `@opencode-ai/plugin`

**New Account Selection Strategy:**

- Add strategy name to `VALID_STRATEGIES` in `lib/config.mjs`
- Add case to `selectAccount()` switch in `lib/rotation.mjs`
- Update `AccountSelectionStrategy` typedef

**Utilities/Helpers:**

- If used by multiple modules: create new file in `lib/`
- If used by single module: add as local function in that module
- CLI-only helpers: keep in `cli.mjs`
- Plugin-only helpers: keep in `index.mjs`

## Special Directories

**`dist/`:**

- Purpose: Self-contained bundled artifacts (plugin + CLI)
- Generated: Yes (`npm run build` via esbuild)
- Committed: No (gitignored)
- Consumers: `scripts/install.mjs copy` deploys these to user's system

**`.mitm/`:**

- Purpose: mitmproxy debugging for inspecting API traffic between plugin and Anthropic
- Generated: Manually (development tool)
- Committed: No (gitignored)

**`node_modules/`:**

- Purpose: npm dependencies
- Generated: Yes (`npm install`)
- Committed: No (gitignored)

**`.planning/`:**

- Purpose: GSD codebase analysis documents
- Generated: By analysis tooling
- Committed: Yes (intended to be tracked)

## Import Dependency Graph

```
index.mjs (plugin)
  ├── lib/accounts.mjs
  │     ├── lib/storage.mjs
  │     │     └── lib/config.mjs
  │     ├── lib/rotation.mjs
  │     │     └── lib/config.mjs
  │     └── lib/backoff.mjs
  ├── lib/config.mjs
  ├── lib/storage.mjs
  ├── lib/backoff.mjs
  └── @openauthjs/openauth (external)

cli.mjs (CLI)
  ├── lib/storage.mjs
  │     └── lib/config.mjs
  └── lib/config.mjs
```

Note: `cli.mjs` does NOT depend on `lib/accounts.mjs` — it operates directly on the storage layer. The `AccountManager` class is plugin-only (in-memory runtime state). The CLI reads/writes the shared JSON file directly.

---

_Structure analysis: 2026-02-07_
