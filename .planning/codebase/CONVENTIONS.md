# Coding Conventions

**Analysis Date:** 2026-02-07

## Language & Module System

**Language:** Pure JavaScript (ES2025) — no TypeScript, no compilation for source files.
**Module System:** ESM exclusively. All source files use `.mjs` extension.
**Type Safety:** JSDoc annotations provide full type information without a compile step.

## Naming Patterns

**Files:**

- Source files: `kebab-case.mjs` — e.g., `lib/storage.mjs`, `lib/backoff.mjs`
- Test files: `kebab-case.test.mjs` — co-located next to source
- Scripts: `kebab-case.mjs` in `scripts/` — e.g., `scripts/build.mjs`, `scripts/install.mjs`
- Entry points: `index.mjs`, `cli.mjs` at project root

**Functions:**

- Use `camelCase` for all functions: `loadAccounts`, `calculateBackoffMs`, `parseRetryAfterHeader`
- Factory/builder functions: `make*` prefix — `makeStoredAccount`, `makeClient`
- Validation functions: `validate*` prefix — `validateAccount`, `validateConfig`, `validateStats`
- Boolean-returning functions: `is*` prefix — `isAccountSpecificError`, `isUsable`
- Getters: `get*` prefix — `getScore`, `getConfigDir`, `getStoragePath`, `getCurrentIndex`
- Event recorders: `record*` prefix — `recordSuccess`, `recordRateLimit`, `recordFailure`

**Variables:**

- Use `camelCase`: `storagePath`, `configDir`, `activeIndex`
- Constants: `UPPER_SNAKE_CASE` — `MAX_ACCOUNTS`, `RATE_LIMIT_KEY`, `CURRENT_VERSION`
- Unused parameters: prefix with `_` — `_error`, `_response` (enforced by ESLint `argsIgnorePattern: "^_"`)

**Classes:**

- Use `PascalCase`: `AccountManager`, `HealthScoreTracker`, `TokenBucketTracker`
- Private fields use `#` prefix (true private fields): `#accounts`, `#cursor`, `#config`, `#scores`
- No underscore-prefixed "private" conventions — always use `#` for private state

**Types (JSDoc):**

- Use `PascalCase` for `@typedef` names: `ManagedAccount`, `AccountStorage`, `RateLimitReason`
- String literal unions: `@typedef {'AUTH_FAILED' | 'QUOTA_EXHAUSTED' | 'RATE_LIMIT_EXCEEDED'} RateLimitReason`

## Code Style

**Formatting (Prettier):**

- Config: `.prettierrc`
- Print width: 120
- Indent: 2 spaces (no tabs)
- Semicolons: always
- Quotes: double quotes (`"`)
- Trailing commas: all (including function parameters)
- Bracket spacing: true
- Arrow parens: always

**Linting (ESLint):**

- Config: `eslint.config.mjs` (flat config format)
- Base: `@eslint/js` recommended
- ECMAScript: 2025
- Key rules:
  - `prefer-const`: error — always use `const` unless reassignment needed
  - `no-var`: error — never use `var`
  - `eqeqeq: smart` — use `===` except allow `== null` for null/undefined checks
  - `no-console: off` — this is a CLI tool, console output is expected
  - `no-constant-condition: { checkLoops: false }` — `while (true)` is intentional
  - `no-unused-vars: warn` with `argsIgnorePattern: "^_"` and `varsIgnorePattern: "^_"`
- Globals: Node.js + Web API globals declared explicitly (no `node: true` environment)

**Pre-commit (Husky + lint-staged):**

- Config: `package.json` under `lint-staged`
- `.mjs` files: `prettier --write` then `eslint --fix`
- `.json`, `.md` files: `prettier --write`
- Pre-push hook: runs `npm test`

## Import Organization

**Order:**

1. External packages — `import { createClient } from "@openauthjs/openauth/client"`
2. Node built-ins — `import { promises as fs } from "node:fs"`, `import { join } from "node:path"`
3. Local modules — `import { loadAccounts } from "./lib/storage.mjs"`

**Rules:**

- Always use `node:` prefix for Node.js built-in modules
- Always include `.mjs` extension in relative imports
- Named exports only — no default exports anywhere in the codebase
- Destructured imports preferred: `import { loadAccounts, saveAccounts } from "./storage.mjs"`

**Path Aliases:**

- None configured. All imports use relative paths.

## JSDoc Type System

**Every function gets JSDoc:**

```javascript
/**
 * Parse the Retry-After header from a response.
 * Supports both seconds (integer) and HTTP-date formats.
 * @param {Response} response
 * @returns {number | null} Retry-after duration in milliseconds, or null
 */
export function parseRetryAfterHeader(response) {
```

**Type definitions at the top of files using `@typedef`:**

```javascript
/**
 * @typedef {object} ManagedAccount
 * @property {string} id
 * @property {number} index
 * @property {string} [email]
 * @property {string} refreshToken
 * @property {boolean} enabled
 * @property {AccountStats} stats
 */
```

**Cross-file type imports:**

```javascript
/**
 * @typedef {import('./config.mjs').AnthropicAuthConfig} AnthropicAuthConfig
 * @typedef {import('./storage.mjs').AccountMetadata} AccountMetadata
 */
```

**Inline JSDoc casts for type narrowing:**

```javascript
const code = /** @type {NodeJS.ErrnoException} */ (error).code;
const hs = /** @type {Record<string, unknown>} */ (raw.health_score);
```

**Private class field annotations:**

```javascript
/** @type {ManagedAccount[]} */
#accounts = [];
/** @type {Map<string, StatsDelta>} */
#statsDeltas = new Map();
```

## Error Handling

**Pattern 1: Silent catch for non-critical operations**
Used when failure should not disrupt the main flow:

```javascript
try {
  await fs.unlink(tempPath);
} catch {
  // Ignore cleanup errors
}
```

**Pattern 2: Error code discrimination for fs operations**

```javascript
try {
  const content = await fs.readFile(storagePath, "utf-8");
  // ...process
} catch (error) {
  const code = /** @type {NodeJS.ErrnoException} */ (error).code;
  if (code === "ENOENT") return null;
  return null;
}
```

**Pattern 3: Graceful degradation — return defaults on failure**
Config loading, account loading, etc. return defaults or null rather than throwing:

```javascript
export function loadConfig() {
  try {
    // ...try to read and parse
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
```

**Pattern 4: Propagate errors for critical paths**
Storage save errors are thrown after cleanup, so callers know the save failed:

```javascript
try {
  await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, storagePath);
} catch (error) {
  try {
    await fs.unlink(tempPath);
  } catch {
    /* ignore */
  }
  throw error;
}
```

**General rule:** Never crash the plugin. If something fails, log/ignore and continue. The plugin is middleware for a CLI tool — availability beats correctness for non-critical paths.

## File I/O Patterns

**Atomic writes (temp file + rename):**
All data persistence uses this pattern to prevent corruption on crash:

```javascript
const tempPath = `${storagePath}.${randomBytes(6).toString("hex")}.tmp`;
await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
await fs.rename(tempPath, storagePath);
```

See `lib/storage.mjs` `saveAccounts()`.

**File permissions:**
Sensitive files (accounts with tokens) are written with `mode: 0o600` (owner read/write only).

**Debounced persistence:**
`AccountManager` in `lib/accounts.mjs` uses a 1-second debounce (`#saveTimeout`) to coalesce rapid state changes into a single disk write.

**Merge-on-save:**
Before writing, `AccountManager._persistNow()` re-reads the current disk state and merges in-memory deltas. This supports multiple CLI/plugin instances running concurrently without data loss.

## Code Organization

**Section comments:**
Major logical sections are separated with comment blocks:

```javascript
// ---------------------------------------------------------------------------
// Color helpers — zero dependencies, respects NO_COLOR / TTY
// ---------------------------------------------------------------------------
```

**Module structure pattern:**

1. Imports
2. JSDoc `@typedef` declarations
3. Constants (`const UPPER_SNAKE = ...`)
4. Internal/private helper functions
5. Exported functions/classes
6. Main entry point (in entry files like `cli.mjs`)

**Export pattern:**

- Named exports only: `export function ...`, `export class ...`, `export const ...`
- No barrel files — each module exports its own public API
- No default exports

## CLI Patterns

**Command functions return exit codes:**

```javascript
async function cmdList(storage) {
  // ...
  return 0; // success
}
```

**Color helpers respect `NO_COLOR` and TTY:**

```javascript
let USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const ansi = (code, text) => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const c = {
  bold: (t) => ansi("1", t),
  dim: (t) => ansi("2", t),
  green: (t) => ansi("32", t),
  // ...
};
```

**Interactive prompts:**
Use `node:readline/promises` with `createInterface({ input: stdin, output: stdout })`.

## Validation Patterns

**Config validation with clamping:**
Invalid or out-of-range values are clamped to valid ranges, never rejected:

```javascript
function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
```

See `lib/config.mjs` `validateConfig()`.

**Account validation with field-level sanitization:**
Each field is individually validated and defaulted. Invalid accounts (no refreshToken) return null and are filtered out:

```javascript
if (typeof acc.refreshToken !== "string" || !acc.refreshToken.trim()) return null;
```

See `lib/storage.mjs` `validateAccount()`.

**Deduplication:**
Accounts are deduplicated by `refreshToken` — the one with the latest `lastUsed` timestamp wins. See `lib/storage.mjs` `deduplicateByRefreshToken()`.

## Null Handling

**Use `== null` for null/undefined checks** (enabled by `eqeqeq: smart`):

```javascript
if (body == null) {
  return { errorType, message, text };
}
```

**Nullable fields use `| null` in JSDoc, not `undefined`:**

```javascript
/** @property {number | null} lastFailureTime */
```

**Optional fields use `[bracket]` notation in JSDoc:**

```javascript
/** @property {string} [email] */
```

---

_Convention analysis: 2026-02-07_
