# Technology Stack

**Analysis Date:** 2026-02-07

## Languages

**Primary:**

- JavaScript (ESM / `.mjs`) — All application code, no TypeScript compilation step

**Secondary:**

- TypeScript — Single publish script only (`script/publish.ts`, run via Bun)
- Python — MITM proxy debugging tool (`.mitm/dump_anthropic.py`, not part of core)

**Key Decision:** Pure JavaScript with JSDoc type annotations throughout. No `.ts` source files in the main codebase — types are expressed via `@typedef` and `@param` JSDoc comments. This avoids a TypeScript compilation step while still providing IDE type checking.

## Runtime

**Environment:**

- Node.js ≥ 20 (build target: `node20` in `scripts/build.mjs`)
- Development machine: Node.js v25.4.0

**Package Manager:**

- npm 11.7.0
- Lockfile: `package-lock.json` (present via `node_modules/`)

## Frameworks

**Core:**

- `@opencode-ai/plugin` ^0.4.45 (devDependency) — OpenCode plugin SDK; defines the `Plugin` interface the project exports
- `@openauthjs/openauth` ^0.4.3 (runtime dependency) — PKCE code generation for OAuth flows (`generatePKCE`)

**Testing:**

- Vitest ^4.0.18 — Test runner and assertion library
- Config: implicit (no `vitest.config.*` found; uses defaults with `*.test.mjs` pattern)

**Build/Dev:**

- esbuild ^0.27.3 — Bundles plugin + CLI into self-contained single files in `dist/`
- Husky ^9.1.7 — Git hooks (pre-commit, pre-push)
- lint-staged ^16.2.7 — Run lint/format on staged files only
- ESLint ^10.0.0 — Linting (flat config at `eslint.config.mjs`)
- Prettier ^3.8.1 — Formatting (config at `.prettierrc`)

## Key Dependencies

**Critical (runtime):**

- `@openauthjs/openauth` 0.4.3 — Only runtime dependency; provides `generatePKCE` for OAuth PKCE flow. Everything else is Node.js built-ins.

**Critical (dev/build):**

- `@opencode-ai/plugin` 0.4.45 — Defines the `Plugin` type interface. Transitive dependency: `@opencode-ai/sdk` 0.4.19 (provides `createOpencodeClient`)
- `esbuild` 0.27.3 — Bundles both entry points into zero-dependency single files

**Infrastructure:**

- `husky` 9.1.7 — Git hooks
- `lint-staged` 16.2.7 — Pre-commit quality gates

## Configuration

**Environment Variables (runtime):**

- `OPENCODE_ANTHROPIC_STRATEGY` — Override account selection strategy (`sticky`, `round-robin`, `hybrid`)
- `OPENCODE_ANTHROPIC_DEBUG` — Enable debug logging (`1`/`true` or `0`/`false`)
- `OPENCODE_ANTHROPIC_QUIET` — Suppress non-error toasts (`1`/`true` or `0`/`false`)
- `XDG_CONFIG_HOME` — Override config directory (default: `~/.config`)
- `NO_COLOR` — Disable ANSI color output in CLI

**Config Files (user-facing, not in repo):**

- `~/.config/opencode/anthropic-auth.json` — Plugin configuration (strategy, health scores, token bucket, etc.)
- `~/.config/opencode/anthropic-accounts.json` — Multi-account storage (OAuth tokens, stats, rate limit state)

**Build Config:**

- `eslint.config.mjs` — ESLint flat config (ECMAScript 2025, Node.js globals, vitest test globals)
- `.prettierrc` — Prettier (120 char width, double quotes, trailing commas, 2-space indent)
- `scripts/build.mjs` — esbuild config (ESM format, node20 target, node:\* external)

**Git Hooks:**

- `.husky/pre-commit` — Runs `npm test` then `npx lint-staged`
- `.husky/pre-push` — Runs `npm test`, `npx prettier --check .`, `npx eslint .`

## Build System

**Build command:** `npm run build` → `node scripts/build.mjs`

**Outputs:**

- `dist/opencode-anthropic-auth-plugin.js` — Bundled plugin (60KB, single file, no deps)
- `dist/opencode-anthropic-auth-cli.mjs` — Bundled CLI (37KB, single file, no deps)

**Build characteristics:**

- ESM format (`"format": "esm"`)
- All dependencies bundled except `node:*` builtins
- Target: Node.js 20+
- Both outputs are self-contained — no `node_modules` needed at runtime

**Install modes:**

- `npm run install:link` — Symlinks source files for development (live editing)
- `npm run install:copy` — Copies built artifacts for stable deployment
- `npm run uninstall` — Removes both plugin and CLI

**Install targets:**

- Plugin → `~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js`
- CLI → `~/.local/bin/opencode-anthropic-auth`

## NPM Scripts

| Script         | Command                                          | Purpose                          |
| -------------- | ------------------------------------------------ | -------------------------------- |
| `build`        | `node scripts/build.mjs`                         | Bundle plugin + CLI with esbuild |
| `test`         | `vitest run`                                     | Run all tests once               |
| `test:watch`   | `vitest`                                         | Run tests in watch mode          |
| `lint`         | `eslint .`                                       | Lint all files                   |
| `lint:fix`     | `eslint --fix .`                                 | Lint and auto-fix                |
| `format`       | `prettier --write .`                             | Format all files                 |
| `format:check` | `prettier --check .`                             | Check formatting                 |
| `install:link` | `node scripts/install.mjs link`                  | Dev install (symlinks)           |
| `install:copy` | `npm run build && node scripts/install.mjs copy` | Production install (copy)        |
| `uninstall`    | `node scripts/install.mjs uninstall`             | Remove installed files           |
| `prepare`      | `husky`                                          | Set up git hooks                 |

## Platform Requirements

**Development:**

- Node.js ≥ 20
- npm (for dependency management)
- macOS/Linux (install scripts use Unix paths and symlinks)
- Optional: Bun (for `script/publish.ts` only)

**Production/Runtime:**

- Node.js ≥ 20
- OpenCode installed and configured
- No external dependencies at runtime (everything is bundled)

**Publishing:**

- GitHub Actions (`.github/workflows/publish.yml`)
- npm registry (`npm publish --access public`)
- Node.js 24 in CI
- Bun for version bump script (`script/publish.ts`)
- GitHub CLI (`gh`) for triggering workflow

---

_Stack analysis: 2026-02-07_
