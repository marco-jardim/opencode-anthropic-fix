# Multi-Account OAuth Load Balancing — Implementation Plan

## Overview

Add support for multiple Anthropic OAuth accounts with configurable load balancing, automatic backoff on throttling/blocking, and transparent account switching to the `opencode-anthropic-auth` plugin.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  OpenCode Plugin (index.mjs)                        │
│                                                     │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Auth Methods  │  │ Config Loader (lib/config)   │ │
│  │ (OAuth flow)  │  │ ~/.config/opencode/          │ │
│  │ Add/manage    │  │ anthropic-auth.json          │ │
│  │ accounts      │  └──────────┬───────────────────┘ │
│  └──────┬───────┘              │                    │
│         │                      │                    │
│  ┌──────▼──────────────────────▼────────────────┐   │
│  │         Account Manager (lib/accounts)        │   │
│  │  - accounts[] from anthropic-accounts.json    │   │
│  │  - getCurrentAccount(strategy)                │   │
│  │  - markRateLimited(account, backoffMs)        │   │
│  │  - markSuccess(account)                       │   │
│  └──────┬────────────────────────────────────────┘   │
│         │                                            │
│  ┌──────▼────────────────────────────────────────┐   │
│  │         Rotation / Health (lib/rotation)       │   │
│  │  - HealthScoreTracker (per account)            │   │
│  │  - TokenBucketTracker (client-side RL)         │   │
│  │  - Strategy: sticky | round-robin | hybrid     │   │
│  └──────┬────────────────────────────────────────┘   │
│         │                                            │
│  ┌──────▼────────────────────────────────────────┐   │
│  │         Backoff Logic (lib/backoff)             │   │
│  │  - Parse Anthropic error responses              │   │
│  │  - Escalating backoff per reason                │   │
│  │  - Retry-After header support                   │   │
│  │  - Jitter for thundering herd prevention        │   │
│  └──────┬────────────────────────────────────────┘   │
│         │                                            │
│  ┌──────▼────────────────────────────────────────┐   │
│  │         Fetch Interceptor (index.mjs)          │   │
│  │  - Select account → set Bearer token           │   │
│  │  - On 429/529 → markRateLimited, retry next    │   │
│  │  - On success → markSuccess                    │   │
│  │  - ALL existing transforms preserved:          │   │
│  │    • System prompt OpenCode→Claude rewrite     │   │
│  │    • Tool name mcp_ prefixing (req + resp)     │   │
│  │    • Beta header merging                       │   │
│  │    • User-agent spoofing                       │   │
│  │    • x-api-key deletion                        │   │
│  │    • URL ?beta=true injection                  │   │
│  └───────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘

Storage files:
  ~/.config/opencode/anthropic-accounts.json  ← multi-account data
  ~/.config/opencode/anthropic-auth.json      ← config/settings
  ~/.local/share/opencode/auth.json           ← OpenCode native (single-account fallback)
```

## File Structure

```
index.mjs                    ← entry point (modified)
lib/
  config.mjs                 ← config loading from anthropic-auth.json
  storage.mjs                ← disk persistence for anthropic-accounts.json
  accounts.mjs               ← AccountManager class
  rotation.mjs               ← HealthScoreTracker, TokenBucketTracker, selection algorithms
  backoff.mjs                ← rate limit reason parsing, backoff calculation
```

## Preserved Behaviors (from current plugin)

Every behavior in the current plugin MUST be preserved identically. Reference inventory:

| ID    | Behavior                                                                                                                                                                                                  | Location                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| A1-A4 | System prompt transform: prepend Claude Code identity prefix (for anthropic provider only)                                                                                                                | `experimental.chat.system.transform` hook |
| B1-B2 | Cost zeroing: set all model costs to 0 for OAuth users                                                                                                                                                    | `loader()`                                |
| C1-C7 | Token refresh: refresh via `console.anthropic.com/v1/oauth/token`, persist via `client.auth.set()`                                                                                                        | `fetch()`                                 |
| D1-D7 | Header construction: merge incoming headers, merge beta headers (oauth-2025-04-20, interleaved-thinking-2025-05-14), set Bearer auth, set user-agent `claude-cli/2.1.2 (external, cli)`, delete x-api-key | `fetch()`                                 |
| E1-E7 | Body transforms: `OpenCode`→`Claude Code`, `opencode`→`Claude` (with path lookbehind), `mcp_` prefix on tool names in tools array and tool_use message blocks                                             | `fetch()`                                 |
| F1-F3 | URL transform: add `?beta=true` to `/v1/messages` requests                                                                                                                                                | `fetch()`                                 |
| G1-G5 | Response stream: strip `mcp_` prefix from tool names in streaming response                                                                                                                                | `fetch()`                                 |
| H1-H3 | Auth methods: Claude Pro/Max OAuth, Create API Key, Manual API Key                                                                                                                                        | `methods[]`                               |
| I1-I5 | OAuth flow: PKCE via @openauthjs/openauth, code exchange with console.anthropic.com                                                                                                                       | `authorize()`, `exchange()`               |

## Config Schema

File: `~/.config/opencode/anthropic-auth.json`

```json
{
  "account_selection_strategy": "hybrid",
  "max_rate_limit_wait_seconds": 300,
  "switch_on_first_rate_limit": true,
  "failure_ttl_seconds": 3600,
  "request_jitter_max_ms": 0,
  "health_score": {
    "initial": 70,
    "success_reward": 1,
    "rate_limit_penalty": -10,
    "failure_penalty": -20,
    "recovery_rate_per_hour": 2,
    "min_usable": 50,
    "max_score": 100
  },
  "token_bucket": {
    "max_tokens": 50,
    "regeneration_rate_per_minute": 6,
    "initial_tokens": 50
  }
}
```

All fields optional with sensible defaults. No Zod — manual validation.

## Account Storage Schema

File: `~/.config/opencode/anthropic-accounts.json`

```json
{
  "version": 1,
  "accounts": [
    {
      "email": "user@example.com",
      "refreshToken": "rt_...",
      "addedAt": 1706000000000,
      "lastUsed": 1706000000000,
      "enabled": true,
      "rateLimitResetTimes": {},
      "consecutiveFailures": 0,
      "lastFailureTime": null,
      "lastSwitchReason": "initial"
    }
  ],
  "activeIndex": 0
}
```

## Selection Strategies

### Sticky (default-like)

Use current account until rate-limited, then switch to next available. Preserves prompt cache.

### Round-Robin

Rotate to next account on every request. Maximum throughput distribution.

### Hybrid (default)

Deterministic selection based on composite score:

- Health component: `healthScore × 2` (0-200)
- Token component: `(tokens/maxTokens) × 100 × 5` (0-500)
- Freshness component: `min(secondsSinceUsed, 3600) × 0.1` (0-360)
- Stickiness bonus: +150 for current account
- Switch threshold: must beat current by 100+ to switch

## Backoff Logic

| HTTP Status           | Reason          | Backoff                                |
| --------------------- | --------------- | -------------------------------------- |
| 429                   | Rate limited    | 30s (or Retry-After header)            |
| 429 + quota exhausted | Quota exhausted | Escalating: 60s → 300s → 1800s → 7200s |
| 529                   | Overloaded      | 45s ± 15s jitter                       |
| 500                   | Server error    | 20s                                    |

- Respect `Retry-After` header (minimum 2s)
- Jitter on capacity errors to prevent thundering herd
- Consecutive failure tracking with TTL-based reset (default 1 hour)

## Auth Flow UX

When user has existing accounts and runs auth again, present menu:

```
3 account(s) configured:
  1. user1@example.com (active)
  2. user2@example.com
  3. user3@example.com

(a)dd new, (f)resh start, (m)anage? [a/f/m]:
```

- **Add**: Run OAuth flow, add to pool
- **Fresh start**: Clear all accounts, start over
- **Manage**: Select account → delete or enable/disable

---

## Tasks

### Task 1: Create `lib/config.mjs` — Config Loader

- **Status**: ✅ Complete
- **Description**: Load and validate config from `~/.config/opencode/anthropic-auth.json`
- **Details**:
  - `getConfigDir()` — returns `~/.config/opencode` (XDG-compliant, Windows-aware)
  - `getConfigPath()` — returns full path to `anthropic-auth.json`
  - `loadConfig()` — read file, parse JSON, validate with defaults, return merged config
  - `DEFAULT_CONFIG` — all defaults as a plain object
  - Manual validation (no Zod): check types, clamp ranges, fall back to defaults
  - Environment variable overrides: `OPENCODE_ANTHROPIC_STRATEGY`, `OPENCODE_ANTHROPIC_DEBUG`
- **Exports**: `loadConfig()`, `getConfigDir()`, `DEFAULT_CONFIG`

### Task 2: Create `lib/storage.mjs` — Account Persistence

- **Status**: ✅ Complete
- **Description**: Read/write `anthropic-accounts.json` with atomic operations
- **Details**:
  - `getStoragePath()` — returns `~/.config/opencode/anthropic-accounts.json`
  - `loadAccounts()` — read file, parse, validate, return `AccountStorage` or null
  - `saveAccounts(storage)` — atomic write (temp file + rename), set permissions 0o600
  - `ensureGitignore(configDir)` — add `anthropic-accounts.json` to `.gitignore` in config dir
  - `deduplicateByRefreshToken(accounts)` — remove duplicate accounts
  - Schema version 1 with migration support
  - Handle ENOENT gracefully (first run)
- **Exports**: `loadAccounts()`, `saveAccounts()`, `getStoragePath()`, `ensureGitignore()`

### Task 3: Create `lib/backoff.mjs` — Rate Limit Parsing & Backoff

- **Status**: ✅ Complete
- **Description**: Parse Anthropic error responses and calculate backoff durations
- **Details**:
  - `parseRateLimitReason(status, responseBody)` — returns reason enum
  - `calculateBackoffMs(reason, consecutiveFailures, retryAfterMs)` — returns backoff in ms
  - `parseRetryAfterHeader(response)` — extract Retry-After value from response headers
  - Reason types: `QUOTA_EXHAUSTED`, `RATE_LIMIT_EXCEEDED`, `OVERLOADED`, `SERVER_ERROR`, `UNKNOWN`
  - Escalating backoffs for quota exhaustion: [60s, 300s, 1800s, 7200s]
  - Jitter generation for capacity errors
- **Exports**: `parseRateLimitReason()`, `calculateBackoffMs()`, `parseRetryAfterHeader()`

### Task 4: Create `lib/rotation.mjs` — Health Scoring & Selection

- **Status**: ✅ Complete
- **Description**: Per-account health tracking and selection algorithms
- **Details**:
  - `HealthScoreTracker` class:
    - `getScore(index)` — current score with passive recovery
    - `recordSuccess(index)` — +reward
    - `recordRateLimit(index)` — +penalty
    - `recordFailure(index)` — +penalty
    - `isUsable(index)` — score >= minUsable
    - Configurable via config.health_score
  - `TokenBucketTracker` class:
    - `getTokens(index)` — current tokens with regeneration
    - `hasTokens(index)` — can make a request
    - `consume(index)` — use a token
    - `refund(index)` — return a token (on non-rate-limit failure)
    - Configurable via config.token_bucket
  - `selectAccount(accounts, strategy, currentIndex, healthTracker, tokenTracker)`:
    - `sticky` — return current if healthy, else next available
    - `round-robin` — return next available
    - `hybrid` — composite scoring with stickiness bonus
- **Exports**: `HealthScoreTracker`, `TokenBucketTracker`, `selectAccount()`

### Task 5: Create `lib/accounts.mjs` — Account Manager

- **Status**: ✅ Complete
- **Description**: Core class managing the account pool, tying together storage, rotation, and backoff
- **Details**:
  - `AccountManager` class:
    - `static async load(authFallback, config)` — load from disk, merge with OpenCode auth.json fallback
    - `getAccountCount()` — number of enabled accounts
    - `getCurrentAccount(strategy)` — select best account using rotation logic
    - `markRateLimited(account, reason, retryAfterMs)` — apply backoff, track failures
    - `markSuccess(account)` — reset failures, reward health
    - `addAccount(refreshToken, accessToken, expires, email)` — add to pool
    - `removeAccount(index)` — remove from pool
    - `toggleAccount(index)` — enable/disable
    - `refreshToken(account, clientId)` — refresh a specific account's access token
    - `getMinWaitTime()` — shortest backoff across all accounts
    - `saveToDisk()` — persist to anthropic-accounts.json
    - `toAuthDetails(account)` — convert to OpenCode auth format for client.auth.set()
  - Manages HealthScoreTracker and TokenBucketTracker instances internally
  - Handles per-account token refresh with invalid_grant detection (disables account)
- **Exports**: `AccountManager`

### Task 6: Modify `index.mjs` — Auth Flow (Account Management UX)

- **Status**: ✅ Complete
- **Description**: Update the "Claude Pro/Max" auth method to support multi-account with interactive menu
- **Details**:
  - On auth trigger, check if accounts already exist in anthropic-accounts.json
  - If accounts exist, present menu: add / fresh start / manage
  - "Add" runs the existing OAuth flow and adds to pool
  - "Fresh start" clears anthropic-accounts.json and runs OAuth
  - "Manage" shows account list with enable/disable/delete options
  - After OAuth success, store in both anthropic-accounts.json AND OpenCode's auth.json (for fallback)
  - Keep "Create an API Key" and "Manually enter API Key" methods unchanged (single-account)
  - Cap at 10 accounts maximum
- **Preserved behaviors**: H1-H3, I1-I5

### Task 7: Modify `index.mjs` — Fetch Interceptor (Multi-Account + Retry)

- **Status**: ✅ Complete
- **Description**: Update the fetch interceptor to use AccountManager for account selection and retry on failure
- **Details**:
  - Initialize AccountManager in the `loader()` function (once, when auth type is oauth)
  - Load config via `loadConfig()`
  - Before each request: `accountManager.getCurrentAccount(config.strategy)` → select account
  - Use selected account's access token for Bearer auth (was: single auth.access)
  - Per-account token refresh (was: single token refresh)
  - On 429/529 response:
    1. Parse error reason and Retry-After header
    2. `accountManager.markRateLimited(account, reason, retryAfterMs)`
    3. Select next account via `accountManager.getCurrentAccount()`
    4. If next account available, retry the request (re-apply all transforms)
    5. If all accounts exhausted, wait for shortest backoff or fail
  - On success: `accountManager.markSuccess(account)`
  - Retry loop: max 3 retries across accounts before failing
  - ALL existing transforms preserved identically:
    - Header construction (D1-D7)
    - Body transforms (E1-E7)
    - URL transform (F1-F3)
    - Response stream transform (G1-G5)
  - Periodically save account state to disk (debounced, not on every request)
- **Preserved behaviors**: A1-A4, B1-B2, C1-C7, D1-D7, E1-E7, F1-F3, G1-G5

### Task 8: Backward Compatibility & Single-Account Mode

- **Status**: ✅ Complete (addressed in index.mjs rewrite — fallback path bootstraps from auth.json)
- **Description**: Ensure zero behavior change for existing single-account users
- **Details**:
  - If no `anthropic-accounts.json` exists, bootstrap from OpenCode's auth.json
  - Single OAuth account = no menu, no rotation, behaves exactly like current plugin
  - API key auth = completely unchanged, no multi-account logic
  - No config file required — all defaults are sensible
  - First-time OAuth auth creates anthropic-accounts.json with one account

### Task 9: Testing & Verification

- **Status**: ✅ Complete (154 unit tests passing across 5 test files)
- **Description**: Verify all behaviors work correctly
- **Details**:
  - Verify single-account mode is identical to current behavior
  - Verify multi-account OAuth flow (add, manage, delete)
  - Verify strategy switching (sticky, round-robin, hybrid)
  - Verify backoff on 429 responses
  - Verify account switching on rate limit
  - Verify config loading and defaults
  - Verify all preserved behaviors A1-I5
  - Verify backward compatibility (no config file, no accounts file)
