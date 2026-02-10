# Architecture

**Analysis Date:** 2026-02-07

## Pattern Overview

**Overall:** Plugin + CLI dual-entry-point architecture with shared library layer

**Key Characteristics:**

- OpenCode plugin providing OAuth-based multi-account Anthropic authentication
- Standalone CLI binary for account management (shares storage layer with plugin)
- Fetch interceptor pattern: the plugin wraps HTTP requests to Anthropic API, injecting OAuth tokens, transforming request/response bodies, and rotating accounts on failures
- Stateful account management with disk persistence and in-memory health tracking
- No framework — pure Node.js ESM modules with zero runtime dependencies beyond `@openauthjs/openauth`

## Layers

**Plugin Entry (`index.mjs`):**

- Purpose: OpenCode plugin that intercepts Anthropic API calls with OAuth multi-account support
- Location: `index.mjs`
- Contains: OAuth authorize/exchange helpers, request/response transform functions, `AnthropicAuthPlugin` factory, token refresh logic, CLI-style interactive prompts for auth flow
- Depends on: `lib/accounts.mjs`, `lib/config.mjs`, `lib/storage.mjs`, `lib/backoff.mjs`, `@openauthjs/openauth`
- Used by: OpenCode runtime (loaded as plugin)

**CLI Entry (`cli.mjs`):**

- Purpose: Standalone CLI for managing accounts outside of the OpenCode TUI
- Location: `cli.mjs`
- Contains: All CLI commands (list, switch, enable, disable, remove, reset, stats, strategy, config, manage), formatting/color helpers, usage quota fetching
- Depends on: `lib/storage.mjs`, `lib/config.mjs`
- Used by: End users via `opencode-anthropic-auth` binary

**Account Management (`lib/accounts.mjs`):**

- Purpose: In-memory account pool with health scoring, rotation, and disk sync
- Location: `lib/accounts.mjs`
- Contains: `AccountManager` class — the core runtime coordinator for account selection, failure tracking, rate limit handling, and usage statistics
- Depends on: `lib/storage.mjs`, `lib/rotation.mjs`, `lib/backoff.mjs`
- Used by: `index.mjs`

**Rotation Logic (`lib/rotation.mjs`):**

- Purpose: Account selection algorithms and health/token tracking
- Location: `lib/rotation.mjs`
- Contains: `HealthScoreTracker` class, `TokenBucketTracker` class, `selectAccount()` function implementing sticky/round-robin/hybrid strategies
- Depends on: `lib/config.mjs` (for defaults only)
- Used by: `lib/accounts.mjs`

**Backoff Logic (`lib/backoff.mjs`):**

- Purpose: Error classification and retry backoff calculation
- Location: `lib/backoff.mjs`
- Contains: `isAccountSpecificError()`, `parseRateLimitReason()`, `calculateBackoffMs()`, `parseRetryAfterHeader()`
- Depends on: Nothing
- Used by: `index.mjs`, `lib/accounts.mjs`

**Configuration (`lib/config.mjs`):**

- Purpose: Config file loading, validation, and env var overrides
- Location: `lib/config.mjs`
- Contains: `loadConfig()`, `saveConfig()`, `DEFAULT_CONFIG`, `CLIENT_ID`, strategy validation, XDG-compliant path resolution
- Depends on: Node.js builtins only
- Used by: `index.mjs`, `cli.mjs`, `lib/accounts.mjs`, `lib/rotation.mjs`

**Storage (`lib/storage.mjs`):**

- Purpose: Atomic JSON file persistence for account data
- Location: `lib/storage.mjs`
- Contains: `loadAccounts()`, `saveAccounts()`, `clearAccounts()`, account validation/deduplication, `.gitignore` management
- Depends on: `lib/config.mjs` (for config dir path)
- Used by: `index.mjs`, `cli.mjs`, `lib/accounts.mjs`

## Data Flow

**API Request (Plugin fetch interceptor):**

1. OpenCode calls `fetch(input, init)` on the plugin's custom fetch
2. `transformRequestBody()` sanitizes system prompts and prefixes tool names with `mcp_`
3. `transformRequestUrl()` adds `?beta=true` to `/v1/messages` endpoint
4. `AccountManager.getCurrentAccount()` selects best account via strategy (sticky/round-robin/hybrid)
5. If token expired, `refreshAccountTokenSingleFlight()` refreshes OAuth token (single-flight deduplication)
6. `buildRequestHeaders()` sets Authorization bearer, anthropic-beta headers, removes x-api-key
7. Actual `fetch()` to Anthropic API executes
8. On account-specific error (429, 401, 400/403 with account language): mark account, try next account (up to N accounts)
9. On service-wide error (529, 503, 500): return immediately (switching won't help)
10. On success: `transformResponse()` wraps the SSE stream to strip `mcp_` prefix from tool names, extract token usage, and detect mid-stream account errors

**Account Selection (per-request):**

1. `AccountManager.syncActiveIndexFromDisk()` reconciles with CLI changes
2. Build candidate list: enabled accounts, not in per-request exclusion set
3. `selectAccount()` applies configured strategy:
   - **sticky**: Stay on current account unless rate-limited/failed
   - **round-robin**: Rotate cursor through available accounts
   - **hybrid**: Score accounts by health (weighted ×2) + token bucket (weighted ×5) + freshness, with stickiness bonus (150 points) and switch threshold (100 points)
4. Consume a token bucket token for the selected account
5. Return selected `ManagedAccount`

**OAuth Login Flow:**

1. User triggers `opencode auth login` → plugin's `auth.methods[0].authorize()` runs
2. If existing accounts: prompt menu (add/fresh/manage/cancel)
3. Generate PKCE challenge via `@openauthjs/openauth`
4. Build authorize URL for `claude.ai/oauth/authorize`
5. User pastes authorization code
6. `exchange()` POSTs to `console.anthropic.com/v1/oauth/token` for tokens
7. `AccountManager.addAccount()` stores new credentials (deduplicates by refresh token)
8. `AccountManager.saveToDisk()` persists to `~/.config/opencode/anthropic-accounts.json`

**State Management:**

- **In-memory (plugin process):** `AccountManager` with `HealthScoreTracker` and `TokenBucketTracker` — these are ephemeral, rebuilt on plugin load
- **On-disk (shared):** `anthropic-accounts.json` stores account credentials, failure tracking, rate limit reset times, usage stats, and active index
- **Sync mechanism:** Plugin reads `activeIndex` from disk before each request to pick up CLI changes; debounced writes (1s) persist plugin-side changes back
- **Stats merge-on-save:** To handle concurrent instances, `saveToDisk()` reads disk values and applies in-memory deltas rather than overwriting

## Key Abstractions

**AccountManager (`lib/accounts.mjs`):**

- Purpose: Central coordinator for multi-account state and request routing
- Pattern: Singleton per plugin instance with private state (`#accounts`, `#healthTracker`, `#tokenTracker`)
- Static factory: `AccountManager.load(config, authFallback)` bootstraps from disk + OpenCode auth
- Key methods: `getCurrentAccount()`, `markRateLimited()`, `markSuccess()`, `markFailure()`, `recordUsage()`, `syncActiveIndexFromDisk()`

**HealthScoreTracker (`lib/rotation.mjs`):**

- Purpose: Track per-account health with passive time-based recovery
- Pattern: In-memory score map with configurable initial/penalty/recovery values
- Score range: 0–100, min_usable threshold (default 50) gates account selection

**TokenBucketTracker (`lib/rotation.mjs`):**

- Purpose: Rate-limit requests per account using token bucket algorithm
- Pattern: Per-account bucket with configurable max tokens, regeneration rate
- Default: 50 tokens, 6/minute regen

**ManagedAccount (typedef in `lib/accounts.mjs`):**

- Purpose: Runtime representation of an Anthropic OAuth account
- Contains: id, index, email, refreshToken, access, expires, enabled, rateLimitResetTimes, consecutiveFailures, stats
- Pattern: Mutable in-memory state with periodic disk sync

## Entry Points

**Plugin (`index.mjs` → `AnthropicAuthPlugin`):**

- Location: `index.mjs`
- Triggers: Loaded by OpenCode plugin system as ESM module
- Responsibilities: Exports an async plugin factory function returning hooks for `experimental.chat.system.transform`, `auth.loader`, and `auth.methods`
- Exported as: `export async function AnthropicAuthPlugin({ client })`

**CLI (`cli.mjs` → `main()`):**

- Location: `cli.mjs`
- Triggers: Executed as `opencode-anthropic-auth [command]` via `~/.local/bin` symlink/copy
- Responsibilities: Parse argv, route to command handlers, manage accounts via direct storage manipulation
- Self-detection: Uses `import.meta.url === pathToFileURL(process.argv[1]).href` with symlink resolution

**Build (`scripts/build.mjs`):**

- Location: `scripts/build.mjs`
- Triggers: `npm run build`
- Responsibilities: Bundle `index.mjs` → `dist/opencode-anthropic-auth-plugin.js` and `cli.mjs` → `dist/opencode-anthropic-auth-cli.mjs` using esbuild (ESM, node20 target, all deps bundled except node: builtins)

**Install (`scripts/install.mjs`):**

- Location: `scripts/install.mjs`
- Triggers: `npm run install:link` (dev) or `npm run install:copy` (production)
- Responsibilities: Symlink or copy plugin to `~/.config/opencode/plugin/` and CLI to `~/.local/bin/`

## Error Handling

**Strategy:** Account-specific vs. service-wide error classification with automatic account rotation

**Patterns:**

- **Account-specific errors** (429, 401, 400/403 with account error body): Mark account with backoff, rotate to next account. Auth failures (401) invalidate cached token.
- **Service-wide errors** (529, 503, 500): Return immediately to caller — switching accounts won't help.
- **Token refresh failures**: Transient errors skip account for current request; terminal errors (400, 401, 403, `invalid_grant`) disable the account permanently.
- **Mid-stream SSE errors**: Detected in response stream transformer. Account marked for next request (not retried mid-stream).
- **Single-flight token refresh**: Concurrent requests to the same account share one in-flight refresh promise to prevent race conditions.
- **Backoff calculation** (`lib/backoff.mjs`): Retry-After header takes precedence. Otherwise, reason-based: AUTH_FAILED=5s, RATE_LIMIT_EXCEEDED=30s, QUOTA_EXHAUSTED=escalating [1m, 5m, 30m, 2h].

## Cross-Cutting Concerns

**Logging:** Debug logging via `console.error("[opencode-anthropic-auth]", ...)` gated by `config.debug` flag (env: `OPENCODE_ANTHROPIC_DEBUG=1`). CLI uses direct `console.log` with ANSI color helpers.

**Validation:** Config values are clamped to valid ranges in `lib/config.mjs` (`clampNumber()`). Account data is validated on load with type checks and fallbacks in `lib/storage.mjs` (`validateAccount()`). Duplicate refresh tokens are deduplicated.

**Persistence:** All disk writes use atomic temp-file-and-rename pattern. Account storage uses `randomBytes(6).hex` temp names; config uses PID-based temp names. Files are written with `mode: 0o600` for security.

**Configuration Precedence:** Config file (`~/.config/opencode/anthropic-auth.json`) → environment variable overrides (`OPENCODE_ANTHROPIC_STRATEGY`, `OPENCODE_ANTHROPIC_DEBUG`, `OPENCODE_ANTHROPIC_QUIET`).

**Toast Notifications:** Plugin sends TUI toasts via `client.tui?.showToast()` for account usage, switching, and errors. Toasts are debounced per category and suppressible via quiet mode.

---

_Architecture analysis: 2026-02-07_
