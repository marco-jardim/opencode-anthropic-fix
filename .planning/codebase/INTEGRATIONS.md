# External Integrations

**Analysis Date:** 2026-02-07

## APIs & External Services

**Anthropic OAuth (Primary Integration):**

- **Purpose:** OAuth 2.0 authentication for Claude Pro/Max subscriptions and API key creation
- **SDK/Client:** Native `fetch()` — no SDK wrapper
- **Auth:** OAuth 2.0 with PKCE (Authorization Code flow)
- **Client ID:** `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (hardcoded in `lib/config.mjs:71`)
- **PKCE Library:** `@openauthjs/openauth/pkce` — `generatePKCE()` function

**Anthropic OAuth Endpoints (used in `index.mjs` and `cli.mjs`):**

| Endpoint                                                        | Method        | Purpose                               | Used In                                        |
| --------------------------------------------------------------- | ------------- | ------------------------------------- | ---------------------------------------------- |
| `https://claude.ai/oauth/authorize`                             | GET (browser) | OAuth authorization (Max plan)        | `index.mjs:21`                                 |
| `https://console.anthropic.com/oauth/authorize`                 | GET (browser) | OAuth authorization (Console/API key) | `index.mjs:21`                                 |
| `https://console.anthropic.com/v1/oauth/token`                  | POST          | Token exchange & refresh              | `index.mjs:42`, `index.mjs:536`, `cli.mjs:140` |
| `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` | POST          | Create API key from OAuth token       | `index.mjs:1028`                               |
| `https://api.anthropic.com/api/oauth/usage`                     | GET           | Fetch per-account usage quotas        | `cli.mjs:168`                                  |

**Anthropic Messages API (Proxied):**

- **Purpose:** The plugin intercepts and transforms requests to the Anthropic Messages API
- **Endpoint:** `/v1/messages` — detected via URL pathname matching
- **Transforms applied:**
  - Adds `?beta=true` query parameter (`index.mjs:296`)
  - Sets `Authorization: Bearer {access_token}` header
  - Adds `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14` header
  - Sets `user-agent: claude-cli/2.1.2 (external, cli)`
  - Removes `x-api-key` header
  - Prefixes tool names with `mcp_` in request body
  - Strips `mcp_` prefix from tool names in response stream
  - Rewrites `OpenCode` → `Claude Code` and `opencode` → `Claude` in system prompts

**OAuth Flow Parameters:**

- Redirect URI: `https://console.anthropic.com/oauth/code/callback`
- Scopes: `org:create_api_key user:profile user:inference`
- PKCE: S256 challenge method
- Grant types: `authorization_code` (initial), `refresh_token` (renewal)

## Data Storage

**Databases:**

- None — All storage is local filesystem JSON files

**File Storage (Local):**

- `~/.config/opencode/anthropic-accounts.json` — Multi-account OAuth token storage
  - Written by: `lib/storage.mjs` (`saveAccounts()`)
  - Read by: `lib/storage.mjs` (`loadAccounts()`)
  - Format: JSON with version, accounts array, activeIndex
  - Security: File mode `0o600` (owner read/write only)
  - Write strategy: Atomic (temp file + rename via `randomBytes(6)` suffix)
  - Auto-deduplication by refresh token on load
  - Auto `.gitignore` maintained in config directory

- `~/.config/opencode/anthropic-auth.json` — Plugin configuration
  - Written by: `lib/config.mjs` (`saveConfig()`)
  - Read by: `lib/config.mjs` (`loadConfig()`)
  - Format: JSON with strategy, health scores, token bucket settings
  - Security: File mode `0o600`
  - Write strategy: Atomic (temp file + rename via PID suffix)

**Caching:**

- In-memory only — Health scores (`HealthScoreTracker`), token buckets (`TokenBucketTracker`), and stats deltas (`Map<string, StatsDelta>`) are held in memory during the process lifetime
- No external cache service

## Authentication & Identity

**Auth Provider:** Anthropic OAuth 2.0 (custom implementation)

**Implementation:**

- PKCE Authorization Code flow for initial login
- Refresh token rotation for session maintenance
- Multi-account support (up to 10 accounts, `MAX_ACCOUNTS` in `lib/accounts.mjs:35`)
- Single-flight refresh protection (prevents concurrent refresh races in `index.mjs:659`)
- Automatic account switching on auth failure, rate limit, or quota exhaustion

**Token Lifecycle:**

1. User visits authorization URL in browser
2. User pastes authorization code back to CLI
3. Plugin exchanges code for access + refresh tokens
4. Access token used for API requests (short-lived)
5. Refresh token used to obtain new access tokens when expired
6. Plugin persists tokens to `anthropic-accounts.json`
7. Also syncs primary account to OpenCode's `auth.json` for compatibility

**Account Selection Strategies (configurable in `lib/rotation.mjs`):**

- `sticky` — Stay on current account until it fails (default)
- `round-robin` — Rotate through accounts on every request
- `hybrid` — Score-based selection using health scores + token buckets + freshness

## OpenCode Plugin SDK Integration

**SDK:** `@opencode-ai/plugin` ^0.4.45 (via `@opencode-ai/sdk` 0.4.19)

**Plugin hooks used:**

- `auth.loader(getAuth, provider)` — Custom auth loader that intercepts fetch requests
- `auth.methods[]` — Three auth methods (OAuth Max, OAuth Console/API Key, Manual API Key)
- `experimental.chat.system.transform` — Prepends Claude Code identity to system prompts

**SDK Client API used:**

- `client.auth.set()` — Persist OAuth tokens to OpenCode's auth store (`index.mjs:580`)
- `client.tui?.showToast()` — Display notifications in OpenCode TUI (`index.mjs:638`)

## Monitoring & Observability

**Error Tracking:**

- None — No external error tracking service

**Logs:**

- Debug logging to `stderr` via `console.error()` when `config.debug` is enabled
- Prefix: `[opencode-anthropic-auth]`
- Controlled by: `OPENCODE_ANTHROPIC_DEBUG=1` env var or `debug: true` in config file

**TUI Toasts:**

- Account usage notifications (which account is active)
- Account switch notifications (when switching due to rate limit/failure)
- Error toasts (disabled accounts, auth failures)
- Configurable: `toasts.quiet` suppresses non-error toasts, `toasts.debounce_seconds` rate-limits toast frequency

## CI/CD & Deployment

**Hosting:**

- npm registry (`opencode-anthropic-auth` package, currently v0.0.13)
- Self-installed to user machine (not a hosted service)

**CI Pipeline:**

- GitHub Actions: `.github/workflows/publish.yml`
- Trigger: Manual (`workflow_dispatch`) with optional version bump type
- Steps: Checkout → Node.js 24 → `npm install` → `npm publish --access public`
- Auth: `NPM_TOKEN` secret

**Publishing Flow:**

1. Run `bun script/publish.ts [patch|minor|major]` locally
2. Bumps version in `package.json`, commits, pushes
3. Triggers GitHub Actions workflow via `gh workflow run`
4. CI publishes to npm

## Environment Configuration

**Required env vars:**

- None required for runtime (config file is optional, defaults are sane)

**Optional env vars (runtime):**

- `OPENCODE_ANTHROPIC_STRATEGY` — Override account selection strategy
- `OPENCODE_ANTHROPIC_DEBUG` — Toggle debug logging
- `OPENCODE_ANTHROPIC_QUIET` — Suppress non-error toasts
- `XDG_CONFIG_HOME` — Override config/storage directory base
- `NO_COLOR` — Disable ANSI colors in CLI output

**CI/CD env vars:**

- `NPM_TOKEN` — npm authentication for publishing (GitHub Actions secret)
- `NODE_AUTH_TOKEN` — Mapped from `NPM_TOKEN` in workflow

**Secrets location:**

- OAuth tokens stored in `~/.config/opencode/anthropic-accounts.json` (file mode 0o600)
- `.gitignore` auto-maintained in config directory to prevent accidental commits
- No secrets in repository

## Webhooks & Callbacks

**Incoming:**

- OAuth callback URL: `https://console.anthropic.com/oauth/code/callback` (handled by Anthropic's servers; user pastes the returned code manually)

**Outgoing:**

- None

## SSE Stream Processing

**The plugin processes Server-Sent Events (SSE) streams from the Anthropic API:**

- Strips `mcp_` prefix from tool names in response stream (`index.mjs:489`)
- Extracts token usage from `message_start` and `message_delta` events (`index.mjs:317-341`)
- Detects mid-stream account errors for proactive switching (`index.mjs:368-392`)
- Implemented via `ReadableStream` wrapping of response body (`index.mjs:465-492`)

## Rate Limit & Backoff System

**The plugin implements sophisticated rate limit handling across accounts:**

- Categorizes errors: `AUTH_FAILED`, `QUOTA_EXHAUSTED`, `RATE_LIMIT_EXCEEDED` (`lib/backoff.mjs`)
- Respects `Retry-After` headers (both seconds and HTTP-date formats)
- Escalating backoffs for quota exhaustion: 1m → 5m → 30m → 2h
- Fixed backoffs: Auth failure 5s, Rate limit 30s
- Health scoring with passive recovery (configurable in `lib/rotation.mjs`)
- Token bucket for request gating (`lib/rotation.mjs`)

---

_Integration audit: 2026-02-07_
