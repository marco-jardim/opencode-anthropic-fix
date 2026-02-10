# Codebase Concerns

**Analysis Date:** 2026-02-07

## Tech Debt

**Duplicated Token Refresh Logic:**

- Issue: Token refresh is implemented three separate times with different error handling
- Files: `index.mjs` (lines 40-68 `exchange()`, lines 535-591 `refreshAccountToken()`), `cli.mjs` (lines 138-159 `refreshAccessToken()`)
- Impact: Bug fixes or API changes must be applied in three places. `cli.mjs` version silently swallows errors (returns `null`), while `index.mjs` version throws with detailed error codes. Divergent behavior makes debugging harder.
- Fix approach: Extract a shared `refreshToken()` function into `lib/auth.mjs` with consistent error handling. Both `index.mjs` and `cli.mjs` should import from the shared module.

**Hardcoded User-Agent String:**

- Issue: `user-agent` header is hardcoded as `"claude-cli/2.1.2 (external, cli)"` with a static version
- Files: `index.mjs` (line 210)
- Impact: Version never updates as the actual project version changes (currently `0.0.13` in `package.json`). Server-side analytics will show a stale version. The user-agent also impersonates a different product.
- Fix approach: Read version from `package.json` or a generated constant at build time. Consider using the actual product name.

**Hardcoded Beta Header Versions:**

- Issue: Required beta header values `"oauth-2025-04-20"` and `"interleaved-thinking-2025-05-14"` are hardcoded inline
- Files: `index.mjs` (line 205)
- Impact: When Anthropic updates or removes beta flags, the change must be found inline rather than in a central configuration.
- Fix approach: Move beta header values to constants in `lib/config.mjs` alongside `CLIENT_ID`.

**Hardcoded OAuth URLs:**

- Issue: URLs like `https://console.anthropic.com/v1/oauth/token`, `https://claude.ai/oauth/authorize`, and `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` are scattered as string literals
- Files: `index.mjs` (lines 21, 25, 42, 536, 1028), `cli.mjs` (lines 140, 168)
- Impact: No way to override for testing or staging environments. URLs duplicated across files.
- Fix approach: Centralize all API URLs as constants in `lib/config.mjs`.

**No TypeScript — JSDoc Only:**

- Issue: The entire codebase uses plain `.mjs` files with JSDoc type annotations instead of TypeScript
- Files: All source files (`index.mjs`, `cli.mjs`, `lib/*.mjs`)
- Impact: No compile-time type checking unless an editor provides it. `@ts-ignore` comments (3 instances in `index.mjs` lines 563-567) indicate type system friction. JSDoc types are more verbose and less expressive than TypeScript equivalents.
- Fix approach: This is a conscious design choice (no build step for plugin, direct ESM). If migrating, use esbuild's existing TS support. Low priority unless type bugs emerge.

**System Prompt Manipulation is Fragile:**

- Issue: System prompt transform uses regex replacement `OpenCode → Claude Code` and `opencode → Claude` with a lookbehind `(?<!\/)` to preserve paths
- Files: `index.mjs` (lines 233-239)
- Impact: The regex may not handle all edge cases (e.g., `opencode` in URLs with query strings, or in code blocks). The prefix injection `"You are Claude Code, Anthropic's official CLI for Claude."` is concatenated by string position (`output.system[1]`), which assumes specific system prompt array structure.
- Fix approach: Consider a more robust approach that doesn't depend on array index positions. Document the assumed system prompt structure.

**`index.mjs` is a 1050-line Monolith:**

- Issue: `index.mjs` contains OAuth helpers, request building, body transformation, SSE parsing, response wrapping, token refresh, the entire retry loop, and the plugin entry point — all in one file
- Files: `index.mjs` (1050 lines)
- Impact: Difficult to test individual pieces in isolation (integration test `index.test.mjs` must mock many dependencies). High cognitive load for maintainers.
- Fix approach: Extract into focused modules: `lib/oauth.mjs` (authorize/exchange), `lib/request.mjs` (header building, body/URL transforms), `lib/sse.mjs` (stream parsing, usage extraction), `lib/retry.mjs` (fetch retry loop). Keep `index.mjs` as thin plugin wiring.

## Known Bugs

**Tool Name Prefix Regex May Match False Positives in SSE Stream:**

- Symptoms: The response stream regex `/"name"\s*:\s*"mcp_([^"]+)"/g` strips `mcp_` from any JSON `"name"` field in the raw text stream, not just tool_use blocks
- Files: `index.mjs` (line 489)
- Trigger: An assistant response containing literal text like `"name": "mcp_something"` in a string field (e.g., in a code example within the response) would have `mcp_` incorrectly stripped
- Workaround: Low probability in practice since the regex requires the exact JSON format. A proper fix would parse SSE events and only transform `tool_use` blocks.

**Storage Version Migration Returns Null:**

- Symptoms: If the storage file has a version other than `1`, `loadAccounts()` returns `null` — silently discarding all accounts
- Files: `lib/storage.mjs` (lines 193-196)
- Trigger: Future version migration — the comment says "Future: handle migrations here" but currently just returns null
- Workaround: None currently needed (only version 1 exists), but this will cause data loss when version 2 is introduced unless migration is implemented first.

## Security Considerations

**Refresh Tokens Stored in Plaintext JSON:**

- Risk: OAuth refresh tokens (long-lived credentials) are stored in `~/.config/opencode/anthropic-accounts.json` as plaintext JSON
- Files: `lib/storage.mjs` (lines 230-251), `lib/config.mjs` (lines 253-268)
- Current mitigation: File permissions set to `0o600` (owner-only read/write). `.gitignore` entry added automatically by `ensureGitignore()`. Storage path is in XDG config directory.
- Recommendations: Consider using OS keychain (macOS Keychain, Linux Secret Service) for refresh tokens. At minimum, document the security model for users. The `0o600` permission is correctly applied.

**Access Tokens Briefly Stored on Disk:**

- Risk: Short-lived access tokens are persisted alongside refresh tokens in the accounts JSON file (via debounced save)
- Files: `lib/accounts.mjs` (lines 474-479)
- Current mitigation: Access tokens expire (typically 1 hour). File has `0o600` permissions.
- Recommendations: Consider not persisting access tokens at all — they can always be re-derived from the refresh token. This reduces the window of exposure.

**Silent Error Swallowing (17 Empty Catch Blocks):**

- Risk: 17 empty `catch {}` blocks across the codebase silently swallow errors, potentially hiding security-relevant failures
- Files: `index.mjs` (7 instances: lines 270, 292, 457, 557, 639, 738, 854), `cli.mjs` (3 instances: lines 156, 178, 1288), `lib/accounts.mjs` (line 435), `lib/backoff.mjs` (lines 57, 68), `lib/config.mjs` (lines 224, 242), `lib/storage.mjs` (lines 116, 246)
- Current mitigation: Many are intentional (e.g., fallback to defaults on parse error, ignore cleanup errors). The `debugLog` function exists but is only used in the fetch retry loop.
- Recommendations: Add `debugLog` calls to critical catch blocks (token refresh errors, storage write failures). At minimum, differentiate between "expected/safe" catches and "should-never-happen" catches with comments.

**Client ID is Hardcoded and Public:**

- Risk: The OAuth client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e` is hardcoded in source
- Files: `lib/config.mjs` (line 71)
- Current mitigation: OAuth client IDs are considered public (not secrets). PKCE flow provides security without a client secret.
- Recommendations: No action needed — this is correct OAuth design.

## Performance Bottlenecks

**Disk I/O on Every Request (syncActiveIndexFromDisk):**

- Problem: `syncActiveIndexFromDisk()` reads the entire accounts JSON file from disk at the start of every API request
- Files: `lib/accounts.mjs` (lines 513-573), `index.mjs` (line 747)
- Cause: Enables the CLI to change active account while the plugin is running. Reads `anthropic-accounts.json`, parses JSON, compares snapshots, potentially rebuilds the entire account list.
- Improvement path: Use filesystem watcher (`fs.watch`) instead of polling on every request. Alternatively, add a TTL cache (e.g., only re-read if more than 5 seconds since last read). The current approach adds file I/O latency to every API call.

**Debounced Save Creates Write Pressure:**

- Problem: `requestSaveToDisk()` uses a 1-second debounce timer, but during rapid account switching (multiple 429s in quick succession), each `markRateLimited()` call resets the timer — meaning the write can be delayed indefinitely under sustained failures
- Files: `lib/accounts.mjs` (lines 412-418)
- Cause: Debounce resets on each call. Under heavy load with rapid account switches, state may be stale on disk for extended periods.
- Improvement path: Add a maximum delay (e.g., save at most every 5 seconds regardless of debounce resets). Use a "leading + trailing" debounce pattern.

**Full Account List Rebuild on Sync:**

- Problem: When `syncActiveIndexFromDisk()` detects changes, it rebuilds the entire `#accounts` array and resets both `HealthScoreTracker` and `TokenBucketTracker`
- Files: `lib/accounts.mjs` (lines 521-558)
- Cause: Snapshot comparison uses string concatenation of all refresh tokens and enabled states. Any change triggers full rebuild.
- Improvement path: Track individual account changes rather than full rebuild. Preserve health/token state for accounts that haven't changed.

## Fragile Areas

**SSE Stream Parser:**

- Files: `index.mjs` (lines 406-499, `transformResponse()`)
- Why fragile: The SSE parser manually splits on `\n\n` boundaries, handles chunk splitting across `reader.read()` calls, normalizes CRLF, and simultaneously strips tool name prefixes via regex, extracts usage stats, and detects mid-stream errors — all in a single `ReadableStream.pull()` callback.
- Safe modification: Any changes to SSE parsing should be accompanied by tests that verify chunk-split scenarios (data split across multiple `reader.read()` calls). The existing tests in `index.test.mjs` cover this well (see "chunk-split mid-stream error" test).
- Test coverage: Good — multiple SSE edge cases tested. But the regex-based tool name stripping (line 489) operates on raw text, not parsed JSON, making it sensitive to formatting changes.

**Account Selection Retry Loop:**

- Files: `index.mjs` (lines 723-930, the `for` loop inside `fetch()`)
- Why fragile: 200+ line retry loop with nested async operations, multiple `continue` paths, error classification, token refresh with single-flight protection, toast debouncing, and account state mutations. Interleaves I/O (fetch, disk sync, toast) with state transitions.
- Safe modification: Ensure any changes maintain the invariant that each account is tried at most once per request. The `maxAttempts = accountManager.getTotalAccountCount()` bound prevents infinite loops. Always test with 1, 2, and 3+ accounts.
- Test coverage: Good — `index.test.mjs` has comprehensive tests for 429 retry, 401 auth failure, network errors, and mixed failures across accounts.

**Plugin-CLI Shared State via Disk:**

- Files: `lib/accounts.mjs` (`saveToDisk`, `syncActiveIndexFromDisk`), `lib/storage.mjs` (`saveAccounts`, `loadAccounts`)
- Why fragile: The plugin (running inside OpenCode) and CLI (separate process) share state through `anthropic-accounts.json`. Both can read and write concurrently. The merge-on-save strategy in `saveToDisk()` (lines 427-506) attempts to handle this, but there's no file locking.
- Safe modification: Always use atomic write (temp file + rename, already implemented). Test any changes with concurrent read/write scenarios. The stats delta merge system is particularly complex — changes need careful testing.
- Test coverage: `lib/accounts.test.mjs` covers the AccountManager thoroughly. Storage atomicity is implemented but not stress-tested.

## Scaling Limits

**MAX_ACCOUNTS = 10:**

- Current capacity: Hard limit of 10 accounts
- Limit: `addAccount()` returns `null` when at capacity
- Scaling path: The limit is defined in `lib/accounts.mjs` (line 35). Increasing it is trivial but would slow down the retry loop (which tries each account at most once per request) and make the disk sync snapshot comparison heavier.
- Files: `lib/accounts.mjs` (line 35)

**In-Memory Health/Token Trackers Not Persisted:**

- Current capacity: Health scores and token bucket states exist only in memory
- Limit: Plugin restart (OpenCode restart) resets all health scores to defaults. Recent rate-limit history from the health tracker is lost, potentially sending traffic to recently-failed accounts.
- Scaling path: Persist tracker state alongside accounts, or at minimum, bootstrap health scores from `consecutiveFailures` and `lastFailureTime` on load.
- Files: `lib/rotation.mjs` (classes `HealthScoreTracker`, `TokenBucketTracker`)

## Dependencies at Risk

**`@openauthjs/openauth` (^0.4.3):**

- Risk: Only used for PKCE generation (`generatePKCE`). Small API surface but the package is pre-1.0 and could introduce breaking changes.
- Impact: Auth flow breaks if PKCE generation API changes.
- Migration plan: PKCE is a simple algorithm — could be replaced with a ~20 line implementation using `node:crypto`. Would eliminate the only production dependency.

**`@opencode-ai/plugin` (devDependency, ^0.4.45):**

- Risk: Defines the plugin interface (`Plugin` type). Pre-1.0, interface may change without notice.
- Impact: Plugin won't load if the interface changes. This is a dev dependency (types only), so runtime impact is indirect.
- Migration plan: No alternative — must track OpenCode's plugin interface. Pin version when stability is critical.

## Missing Critical Features

**No Automatic Account Recovery:**

- Problem: When an account is disabled (e.g., due to repeated token refresh failures), it stays disabled forever until manually re-enabled via CLI
- Blocks: Unattended long-running sessions. If a token refresh fails due to a transient network issue and triggers the disable path (400/401/403 status), the user must notice and manually run `opencode-anthropic-auth enable N`.
- Files: `index.mjs` (lines 798-809, `shouldDisable` logic)
- Fix approach: Add a periodic recovery check that attempts to refresh disabled accounts (e.g., every 30 minutes). Or add an `auto_disable: false` config option to prevent automatic disabling.

**No Token Refresh Retry:**

- Problem: Token refresh failures are treated as final — no retry with backoff. A single network hiccup during refresh disables or skips the account.
- Blocks: Reliability in unstable network conditions.
- Files: `index.mjs` (lines 785-816)
- Fix approach: Add 1-2 retries with short backoff for token refresh before marking the account as failed.

## Test Coverage Gaps

**CLI Commands (`cli.mjs`) — Partial Coverage:**

- What's not tested: `cmdList()` live usage quota fetching, `cmdManage()` interactive flows with actual account mutations, `cmdConfig()` output formatting, error paths in `cmdSwitch`/`cmdEnable`/`cmdDisable` when storage write fails
- Files: `cli.mjs` (1301 lines), `cli.test.mjs` (1443 lines — tests exist but focus on unit functions and command routing, not integration)
- Risk: CLI commands that mutate storage could have bugs in edge cases (e.g., removing the last account, disabling while active). The formatting/display functions are tested but the end-to-end command flows less so.
- Priority: Medium — CLI is a secondary interface; the plugin's fetch interceptor is the critical path.

**No Coverage Enforcement:**

- What's not tested: No coverage thresholds or reports are configured
- Files: `package.json` (no coverage script)
- Risk: Coverage can silently degrade. Currently at 335 passing tests across 7 files, which is good, but there's no gate preventing regressions.
- Priority: Low — test suite is healthy, but adding `vitest --coverage` to CI would formalize the baseline.

**SSE Stream Edge Cases:**

- What's not tested: Malformed SSE payloads (partially valid JSON), very large SSE events, streams with only `event:` lines and no `data:` lines, CRLF vs LF mixed in same stream
- Files: `index.mjs` (lines 406-499)
- Risk: Parsing bugs could cause token usage tracking to miss events or tool name stripping to fail silently
- Priority: Low — existing tests cover the main paths including chunk splitting. The parser is defensive (catches JSON parse errors).

---

_Concerns audit: 2026-02-07_
