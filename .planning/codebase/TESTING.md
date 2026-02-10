# Testing Patterns

**Analysis Date:** 2026-02-07

## Test Framework

**Runner:**

- Vitest 4.x
- No config file — uses Vitest defaults (auto-discovers `*.test.mjs` files)
- Global test APIs **not** enabled — all test functions must be explicitly imported

**Assertion Library:**

- Vitest built-in `expect` (Jest-compatible API)

**Run Commands:**

```bash
npm test                # Run all tests (vitest run — single pass, CI mode)
npm run test:watch      # Watch mode (vitest — re-runs on file change)
```

**Pre-push hook:** Husky runs `npm test` before every push.

## Test File Organization

**Location:**

- Co-located with source files (test file next to the module it tests)

**Naming:**

- `{module-name}.test.mjs` — same name as source file with `.test` suffix

**Structure:**

```
project-root/
├── index.mjs              # Plugin entry point
├── index.test.mjs         # Integration tests (49 tests)
├── cli.mjs                # CLI tool
├── cli.test.mjs           # CLI command tests (87 tests)
└── lib/
    ├── accounts.mjs
    ├── accounts.test.mjs  # AccountManager tests (67 tests)
    ├── backoff.mjs
    ├── backoff.test.mjs   # Rate limit classification tests (42 tests)
    ├── config.mjs
    ├── config.test.mjs    # Config loading/validation tests (25 tests)
    ├── rotation.mjs
    ├── rotation.test.mjs  # Health score, token bucket, selection tests (38 tests)
    ├── storage.mjs
    └── storage.test.mjs   # Storage I/O and validation tests (27 tests)
```

**Total:** 7 test files, 335 tests, all passing.

## Test Structure

**Imports — always explicit:**

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";
```

**Suite organization — `describe` blocks by feature/method, not by file:**

```javascript
// ---------------------------------------------------------------------------
// AccountManager.load
// ---------------------------------------------------------------------------

describe("AccountManager.load", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  it("creates empty manager when no stored accounts and no fallback", async () => {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(manager.getAccountCount()).toBe(0);
  });
});
```

**Key patterns:**

- Section separator comments (`// ---`) between major `describe` groups
- `beforeEach` with `vi.resetAllMocks()` at the start of every `describe` block
- `vi.useFakeTimers()` and `vi.setSystemTime()` for time-sensitive tests
- Flat `it()` calls with descriptive names — no deep nesting beyond one `describe` level
- JSDoc comments on test helper functions

## Mocking

### Module Mocks (`vi.mock`)

**Pattern: Partial mock with `importOriginal`**
Keep pure helper functions real, mock only I/O:

```javascript
vi.mock("./storage.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // Keep pure helpers
    loadAccounts: vi.fn(), // Mock I/O functions
    saveAccounts: vi.fn().mockResolvedValue(undefined),
  };
});
```

Used in: `lib/accounts.test.mjs`, `index.test.mjs`

**Pattern: Full mock for system modules**
Replace entire modules when all exports need control:

```javascript
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    chmod: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
  },
}));
```

Used in: `lib/storage.test.mjs`

**Pattern: Mock with inline return value**
For simple stubs:

```javascript
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({
    toString: () => "abcdef123456",
  })),
}));
```

**Pattern: Mock third-party packages**

```javascript
vi.mock("@openauthjs/openauth/pkce", () => ({
  generatePKCE: vi.fn(async () => ({
    challenge: "test-challenge",
    verifier: "test-verifier",
  })),
}));
```

### Import Order Rule

**Mocks must be declared BEFORE importing the module under test.** Vitest hoists `vi.mock()` calls, but the mock setup still must appear before the import in the file for clarity:

```javascript
// 1. Set up mocks
vi.mock("./lib/storage.mjs", async (importOriginal) => { ... });
vi.mock("./lib/config.mjs", async (importOriginal) => { ... });

// 2. Global mocks
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// 3. Import module under test
import { AnthropicAuthPlugin } from "./index.mjs";
import { saveAccounts, loadAccounts } from "./lib/storage.mjs";
```

### Global Mocks (`vi.stubGlobal`)

**Pattern: Mock `fetch` globally**

```javascript
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
```

Used in: `index.test.mjs`, `cli.test.mjs`

### Timer Mocks

**Pattern: Fake timers for time-dependent logic**

```javascript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
});
```

Used in: `lib/accounts.test.mjs` for debounced save, token expiry, etc.

**What to mock:**

- File system I/O (`node:fs`)
- Network requests (`fetch`)
- System time (`vi.useFakeTimers`)
- External packages (`@openauthjs/openauth/pkce`)
- Interactive I/O (`node:readline/promises`)
- Crypto (`node:crypto` for deterministic tests)

**What NOT to mock:**

- Pure functions (validation, deduplication, formatting, clamping)
- Class constructors and their in-memory logic
- Config defaults and constants

## Factory Helpers

**Test data factories are defined per test file, not shared.** Each test file defines its own factory functions at the top, after mocks.

**`makeStoredAccount(overrides)` — Build a single account object:**

```javascript
function makeStoredAccount(overrides = {}) {
  return {
    refreshToken: "token1",
    addedAt: 1000,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    ...overrides,
  };
}
```

Used in: `lib/accounts.test.mjs`, `index.test.mjs`

**`makeAccountsData(overrides, extra)` — Build full storage payload:**

```javascript
function makeAccountsData(overrides = [{}], extra = {}) {
  return {
    version: 1,
    accounts: overrides.map((o, i) =>
      makeStoredAccount({ refreshToken: `token${i + 1}`, addedAt: (i + 1) * 1000, ...o }),
    ),
    activeIndex: 0,
    ...extra,
  };
}
```

Used in: `lib/accounts.test.mjs`

**`makeClient()` / `makeProvider()` — Build OpenCode plugin client/provider stubs:**

```javascript
function makeClient() {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeProvider() {
  return {
    models: {
      "claude-sonnet": {
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      },
    },
  };
}
```

Used in: `index.test.mjs`

**`makeStorage(overrides)` / `captureOutput()` — CLI test helpers:**

```javascript
/** Capture console.log and console.error output */
function captureOutput() {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;

  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  return {
    logs,
    errors,
    text: () => logs.join("\n").replace(/\x1b\[[0-9;]*m/g, ""),
    errorText: () => errors.join("\n").replace(/\x1b\[[0-9;]*m/g, ""),
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}
```

Used in: `cli.test.mjs`

## Fixture Patterns

**No shared fixture files.** All test data is created inline via factory functions (above).

**Large data setup — use factory composition:**

```javascript
loadAccounts.mockResolvedValue(makeAccountsData([{ lastUsed: 2000 }, { lastUsed: 4000 }], { activeIndex: 1 }));
```

**Mock response setup for fetch:**

```javascript
mockFetch.mockResolvedValueOnce(
  new Response(JSON.stringify({ error: { type: "overloaded_error", message: "Server is overloaded" } }), {
    status: 529,
  }),
);
```

## Coverage

**Requirements:** None enforced. No coverage configuration or thresholds.

**No coverage script in package.json.** To run coverage manually:

```bash
npx vitest run --coverage
```

## Test Types

**Unit Tests** (`lib/*.test.mjs`):

- Test individual modules in isolation
- Mock I/O dependencies, test pure logic directly
- Each class/function gets its own `describe` block
- Files: `lib/accounts.test.mjs`, `lib/backoff.test.mjs`, `lib/config.test.mjs`, `lib/rotation.test.mjs`, `lib/storage.test.mjs`

**Integration Tests** (`index.test.mjs`):

- Test the plugin lifecycle end-to-end: auth → callback → fetch interceptor
- Mock external boundaries (fetch, storage, config) but exercise real plugin wiring
- Tests: OAuth flow, token refresh, rate-limit retry loop, SSE stream rewriting, account rotation
- File header documents the integration scope:
  ```
  These test the wiring in index.mjs — the ordering of authorize → callback → loader,
  the accountManager initialization, and the fetch interceptor retry loop.
  ```

**CLI Tests** (`cli.test.mjs`):

- Test each CLI command function independently
- Mock storage/config I/O, capture console output
- Verify exit codes, output formatting, and state mutations

**E2E Tests:**

- Not used. No browser/E2E test framework configured.

## Common Patterns

**Async Testing:**

```javascript
it("loads stored accounts from disk", async () => {
  loadAccounts.mockResolvedValue(makeAccountsData([{ lastUsed: 2000 }]));
  const manager = await AccountManager.load(DEFAULT_CONFIG, null);
  expect(manager.getAccountCount()).toBe(1);
});
```

**Error Testing:**

```javascript
it("returns null on malformed JSON", async () => {
  fs.promises.readFile.mockResolvedValue("not json");
  const result = await loadAccounts();
  expect(result).toBeNull();
});
```

**Parameterized Tests (`it.each`):**

```javascript
it.each([
  { status: 529, errorType: "overloaded_error", errorMsg: "Server is overloaded" },
  { status: 503, errorType: "service_unavailable", errorMsg: "temporarily unavailable" },
  { status: 500, errorType: "internal_error", errorMsg: "internal server error" },
])("returns $status directly without switching accounts", async ({ status, errorType, errorMsg }) => {
  // ...test body using destructured params
});
```

**Mock assertion pattern:**

```javascript
expect(saveAccounts).toHaveBeenCalledTimes(1);
expect(saveAccounts).toHaveBeenCalledWith(
  expect.objectContaining({
    accounts: expect.arrayContaining([expect.objectContaining({ refreshToken: "token1" })]),
  }),
);
```

**Console output testing (CLI):**

```javascript
const out = captureOutput();
try {
  const exitCode = await cmdList(storage);
  expect(exitCode).toBe(0);
  expect(out.text()).toContain("alice@example.com");
} finally {
  out.restore();
}
```

**Response mock chain (fetch interceptor):**

```javascript
// Token refresh response
mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 })));
// Actual API response
mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ text: "Hello" }] }), { status: 200 }));
```

## Writing New Tests

**When adding a new module `lib/foo.mjs`:**

1. Create `lib/foo.test.mjs` next to the source file
2. Import test functions: `import { describe, it, expect, vi, beforeEach } from "vitest"`
3. Mock I/O dependencies with `vi.mock()` + `importOriginal` pattern
4. Define factory helpers at top of file for test data
5. Group tests with `describe` blocks per function/class
6. Add `beforeEach(() => { vi.resetAllMocks(); })` in each `describe`
7. Test pure logic directly, mock only I/O boundaries

**When adding tests to `index.test.mjs`:**

1. Use existing `makeClient()`, `makeProvider()`, `makeStoredAccount()` helpers
2. Set up mock responses with `mockFetch.mockResolvedValueOnce()`
3. Follow the existing `setupFetchFn()` pattern for fetch interceptor tests

---

_Testing analysis: 2026-02-07_
