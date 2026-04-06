# opencode-anthropic-fix

Use your Claude Pro or Max subscription with [OpenCode](https://github.com/anomalyco/opencode). Supports multiple accounts with automatic rotation when you hit rate limits.

## Background

[AnomalyCo](https://github.com/anomalyco/opencode-anthropic-auth) originally published this as a built-in plugin shipped with OpenCode itself. The repo was archived following a legal request from Anthropic. Before it was archived, [rmk40](https://github.com/rmk40/opencode-anthropic-auth) — a frequent contributor unrelated to AnomalyCo — had developed multi-account support that never made it upstream.

This fork continues that work and extends it with deeper research into how the official Claude Code CLI identifies itself to the API. The mimicry was derived by analyzing [Claude Code's open source code on GitHub](https://github.com/anthropics/claude-code). This isn't just a system prompt injection — see the [full mimicry analysis](https://github.com/marco-jardim/opencode-anthropic-fix/blob/master/docs/mimese-http-header-system-prompt.md) for details.

> **Educational purpose.** This code exists to study how Anthropic's OAuth protocol and Claude Code's HTTP communication pattern work. It is not intended to be used in violation of Anthropic's Terms of Service.

> **Account risk.** There is a real risk of account suspension if Anthropic detects requests are not coming from Claude Code. The mimicry tries hard to make every request look as close as possible to a genuine Claude Code request, but that reduces rather than eliminates the risk. Use at your own risk.

## Quick Start

**Prerequisites:** [OpenCode](https://github.com/anomalyco/opencode) installed, a Claude Pro or Max subscription, Node.js 18+.

```bash
# 1. Clone and install
git clone https://github.com/marco-jardim/opencode-anthropic-fix.git
cd opencode-anthropic-fix
npm install

# 2. Install the plugin + CLI
npm run install:link

# 3. Start OpenCode and connect
opencode
# Press Ctrl+K → Connect Provider → Anthropic → "Claude Pro/Max (multi-account)"
# Follow the OAuth prompts to log in
```

That's it. OpenCode will now use your Claude subscription directly. All model costs show as $0.00.

## What This Fork Adds

The [original plugin](https://github.com/anomalyco/opencode-anthropic-auth) provided basic OAuth support. This fork adds:

- **Multi-account support** &mdash; add up to 10 Claude accounts and rotate between them
- **Automatic rate limit handling** &mdash; when one account hits a limit, the plugin switches to another
- **Health scoring** &mdash; tracks account reliability and prefers healthy accounts
- **Standalone CLI** &mdash; manage accounts without opening OpenCode
- **Configurable strategies** &mdash; sticky, round-robin, or hybrid account selection
- **Claude Code signature emulation** &mdash; full HTTP header, system prompt, beta flag, and metadata mimicry derived from Claude Code's open source code
- **OAuth endpoint fingerprint parity** &mdash; matches the real CLI's bundled axios 1.13.6 HTTP client signature (`Accept`, `User-Agent`, `Content-Type`) on all OAuth token endpoint calls, required since 2026-03-21 server-side enforcement
- **Billing header fingerprint parity** &mdash; `cc_version` suffix uses the real CLI's 3-char fingerprint hash (SHA-256 of salt + first user message chars + version), `cch` matches the Bun native client attestation placeholder, and `X-Claude-Code-Session-Id` header is sent on all requests
- **Adaptive thinking for Opus/Sonnet 4.6** &mdash; automatically normalizes thinking to `{type: "adaptive"}` for supported models, with `effort-2025-11-24` beta
- **Upstream-aligned auto betas** &mdash; 13+ always-on betas matching Claude Code 2.1.92 (`redact-thinking-2026-02-12` available as opt-in to preserve thinking block visibility)
- **1M context limit override** &mdash; patches `model.limit.context` so OpenCode compacts at the right threshold while `models.dev` catches up
- **Runtime config + custom betas** &mdash; `/anthropic set`, `/anthropic config`, and `/anthropic betas` slash commands for live feature toggling without restarting OpenCode
- **Files API integration** &mdash; upload, list, download, and manage files via `/anthropic files` with endpoint/content-scoped `files-api-2025-04-14` beta injection
- **Code execution support** &mdash; available via explicit custom beta opt-in (`code-execution-2025-08-25`), not auto-enabled
- **Deep QA conformance** &mdash; 680+ tests across 26 test files, including 40 regression tests validating every header, body field, OAuth parameter, beta flag, system prompt block, response handling path, and telemetry schema against the [reverse-engineering doc](docs/claude-code-reverse-engineering.md)
- **Prompt caching with 1h TTL** &mdash; extended cache TTL on system prompt blocks, auto-disabled if API rejects; cache hit rate tracking with configurable warning threshold
- **API preconnect** &mdash; fire-and-forget HEAD request on init to pre-warm TCP+TLS connection, skipped when proxy/mTLS detected
- **8K default output cap** &mdash; limits `max_tokens` to 8K by default, auto-escalates to 64K after output truncation, resets after one turn
- **Context overflow auto-recovery** &mdash; parses structured `prompt_too_long` errors to auto-reduce `max_tokens` before falling back to message trimming
- **Cache break detection** &mdash; hashes system prompt and tool schemas per turn, alerts when `cache_read_input_tokens` drops >2K
- **`/anthropic context` command** &mdash; token breakdown by role, tool_result grouping, duplicate content detection via SHA-256
- **Token budget parsing** &mdash; natural-language budget expressions (`+500k`, `use 2M tokens`) with system prompt injection and diminishing returns detection
- **Microcompact context trimming** &mdash; injects `clear_tool_uses` / `clear_thinking` betas at >80% context utilization
- **FG/BG request classification** &mdash; reduced retry budget for background requests (title generation, short queries)
- **Smart 529 overload recovery** &mdash; quota-aware account switching on overload exhaustion with cooldown and progressive error messaging
- **Proactive rate limit detection** &mdash; reads `anthropic-ratelimit-unified-*-utilization` headers (tokens, requests, input-tokens) and applies health penalties before hitting 429
- **OAuth usage polling** &mdash; periodic polling of `/api/oauth/usage` endpoint with progressive warning toasts (caution/warning/danger)
- **529/503 retry with Stainless backoff** &mdash; service-wide overload errors retried up to 2 times using the same exponential backoff formula as the official SDK
- **OAuth CSRF protection** &mdash; state parameter stored and validated on callback, independent from PKCE verifier
- **Telemetry emulation (opt-in)** &mdash; minimal `tengu_started`/`tengu_exit` events matching Claude Code's schema; disabled by default for privacy

## Installation

### From npm (recommended)

Add to your `opencode.json`:

```json
{
  "plugins": ["opencode-anthropic-fix@latest"]
}
```

OpenCode will install and load the plugin automatically on next start.

### Development (symlink)

Best for active development. Edits to source files take effect immediately.

```bash
npm run install:link
```

This creates:

- **Plugin:** `~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js` &rarr; `./index.mjs`
- **CLI:** `~/.local/bin/opencode-anthropic-auth` &rarr; `./cli.mjs`

### Stable (copy)

Bundles the plugin and CLI into self-contained single files (via esbuild) and copies them. No symlinks, no `node_modules` needed at the destination.

```bash
npm run install:copy
```

This creates:

- **Plugin:** `~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js` (standalone, ~50KB)
- **CLI:** `~/.local/bin/opencode-anthropic-auth` (standalone, ~35KB)

### Uninstall

```bash
npm run uninstall
```

### PATH Setup

If `~/.local/bin` isn't on your PATH, add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Adding Accounts

### First Account

1. Open OpenCode
2. Press `Ctrl+K` &rarr; **Connect Provider** &rarr; **Anthropic**
3. Select **"Claude Pro/Max (multi-account)"**
4. Open the URL in your browser, authorize, and paste the code back

You can also add accounts directly from the CLI without opening OpenCode:

```bash
opencode-anthropic-auth login
```

### Additional Accounts

Run the auth flow again (via CLI `login` or OpenCode's Connect Provider). The plugin detects existing accounts and shows a menu:

```
2 account(s) configured:
  1. alice@example.com (active)
  2. bob@example.com

(a)dd new, (f)resh start, (m)anage, (c)ancel? [a/f/m/c]:
```

- **Add** &mdash; log in with another Claude account
- **Fresh start** &mdash; clear all accounts and start over
- **Manage** &mdash; enable/disable/remove accounts inline
- **Cancel** &mdash; keep current setup

This fork is OAuth-first. Use `claude.ai` login flows (`login` / `reauth`) for all accounts.

## CLI

The CLI lets you manage accounts outside of OpenCode.

```bash
opencode-anthropic-auth [command] [args]
```

| Command                | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `login`                | Add a new account via browser OAuth flow                      |
| `logout <N>`           | Revoke tokens and remove account N                            |
| `logout --all`         | Revoke all tokens and clear all accounts                      |
| `reauth <N>`           | Re-authenticate account N with fresh OAuth tokens             |
| `refresh <N>`          | Attempt token refresh (no browser needed)                     |
| `list`                 | Show all accounts with status and live usage quotas (default) |
| `status`               | Compact one-liner for scripts/prompts                         |
| `switch <N>`           | Set account N as active                                       |
| `enable <N>`           | Enable a disabled account                                     |
| `disable <N>`          | Disable an account (skipped in rotation)                      |
| `remove <N>`           | Remove an account permanently                                 |
| `reset <N\|all>`       | Clear rate-limit / failure tracking                           |
| `stats`                | Show per-account token usage statistics                       |
| `reset-stats [N\|all]` | Reset usage statistics                                        |
| `strategy [name]`      | Show or change selection strategy                             |
| `config`               | Show configuration and file paths                             |
| `manage`               | Interactive account management menu                           |
| `help`                 | Show help                                                     |

### Examples

```bash
# Add a new account via browser OAuth
opencode-anthropic-auth login

# See account status (includes live usage quotas)
opencode-anthropic-auth list

# Output:
# Anthropic Multi-Account Status
#   #    Account               Status        Failures   Rate Limit
#   ──────────────────────────────────────────────────────────────
#   1    alice@example.com     ● active      0          —
#        5h            █████░░░░░ 45%  resets in 2h 30m
#        7d            █████░░░░░ 45%  resets in 4d 16h
#        Sonnet 7d     ░░░░░░░░░░  0%
#
#   2    bob@example.com       ● ready       0          —
#        5h            ███░░░░░░░ 31%  resets in 30m
#        7d            ███████░░░ 70%  resets in 19h 31m
#        Sonnet 7d     █░░░░░░░░░ 11%  resets in 2d 10h
#
# Strategy: sticky | 2 of 2 enabled
# Storage: ~/.config/opencode/anthropic-accounts.json

# Switch active account
opencode-anthropic-auth switch 2

# Re-authenticate a broken account (opens browser)
opencode-anthropic-auth reauth 1

# Quick token refresh without browser
opencode-anthropic-auth refresh 1

# Revoke tokens and remove an account
opencode-anthropic-auth logout 2

# Revoke all tokens and clear all accounts
opencode-anthropic-auth logout --all

# View token usage per account
opencode-anthropic-auth stats

# Reset all usage counters
opencode-anthropic-auth reset-stats all

# One-liner for shell prompts
opencode-anthropic-auth status
# anthropic: 2 accounts (2 active), strategy: sticky, next: #1

# Interactive management
opencode-anthropic-auth manage
```

### Flags

| Flag         | Description                                        |
| ------------ | -------------------------------------------------- |
| `--force`    | Skip confirmation prompts (for `remove`, `logout`) |
| `--all`      | Target all accounts (for `logout`)                 |
| `--no-color` | Disable colored output                             |
| `--help`     | Show help message                                  |

Most commands have short aliases: `ln`, `lo`, `ra`, `rf`, `ls`, `st`, `sw`, `en`, `dis`, `rm`, `strat`, `cfg`, `mg`.

## Slash Commands in OpenCode

The plugin registers a built-in `/anthropic` slash command for account management, feature toggles, and custom beta headers — all without leaving OpenCode.

### Account management

```text
/anthropic                # list accounts (default)
/anthropic usage          # full account list + quota windows
/anthropic switch 2
/anthropic refresh 1
/anthropic logout 2       # revoke tokens and remove account 2
/anthropic logout --all   # revoke all tokens and clear all accounts
/anthropic stats
```

### Runtime configuration

Toggle features live without restarting OpenCode. Changes are persisted to `anthropic-auth.json`.

```text
/anthropic config                  # show all current settings
/anthropic set emulation on        # enable/disable Claude signature emulation
/anthropic set compaction minimal  # set prompt compaction mode (minimal/off)
/anthropic set 1m-context on       # enable/disable 1M context limit override
/anthropic set idle-refresh on     # enable/disable idle account refresh
/anthropic set strategy round-robin # change account selection strategy
/anthropic set debug on            # enable/disable debug logging
/anthropic set quiet on            # suppress non-error toasts
```

### Custom beta headers

Add or remove beta flags that get included in every `anthropic-beta` header. Persisted across sessions.

```text
/anthropic betas                   # show active betas (auto + custom) with presets
/anthropic betas add <beta-name>   # add a custom beta
/anthropic betas remove <beta-name> # remove a custom beta
/anthropic betas add 1m            # shortcut => context-1m-2025-08-07
```

**Available preset betas** (shown by `/anthropic betas`):

| Beta                              | Description                                       |
| --------------------------------- | ------------------------------------------------- |
| `prompt-caching-scope-2026-01-05` | Cache control with `scope: "org"` — free perf win |
| `context-management-2025-06-27`   | Server-side auto-summarization when context fills |
| `structured-outputs-2025-12-15`   | Strict JSON schema output enforcement             |
| `tool-examples-2025-10-29`        | Input/output examples in tool definitions         |
| `compact-2026-01-12`              | Conversation compaction endpoint                  |
| `mcp-servers-2025-12-04`          | MCP servers in API request payload                |
| `web-search-2025-03-05`           | Web search (Vertex/Foundry only)                  |
| `context-1m-2025-08-07`           | 1M context beta (provider/model dependent)        |
| `redact-thinking-2026-02-12`      | Hide thinking blocks from responses (opt-in)      |

Example workflow:

```text
/anthropic betas add prompt-caching-scope-2026-01-05
/anthropic betas add context-management-2025-06-27
/anthropic betas   # verify
```

### Files API management

Upload, list, download, and delete files via the Anthropic Files API. The `files-api-2025-04-14` beta is injected only when needed (`/v1/files` requests or Messages payloads with `file_id`).

```text
/anthropic files                       # list files across ALL accounts
/anthropic files upload ./report.pdf   # upload a file
/anthropic files get file_abc123       # get file metadata
/anthropic files download file_abc123  # download to current directory
/anthropic files download file_abc123 ./out.pdf  # download to specific path
/anthropic files delete file_abc123    # delete a file
```

Supported formats: PDF, DOCX, TXT, CSV, Excel, Markdown, images (max 350 MB per file). Uploaded files can be referenced by `file_id` in Messages API requests.

**Multi-account behavior:** Files on Anthropic are per-account. With multiple accounts:

- `/anthropic files list` (no `--account`) queries **all** enabled accounts, labeling each file with its owner email
- Use `--account <email|index>` to target a specific account for any action:
  ```text
  /anthropic files list --account alice@example.com
  /anthropic files upload ./data.csv --account 2
  ```
- **Auto-pinning:** When you upload or list files, the plugin remembers which account owns each `file_id`. If a subsequent Messages API request references that `file_id`, the plugin automatically routes it to the correct account — even with round-robin or hybrid strategies.

### OAuth flows from slash command

Login and reauth are two-step flows in slash mode:

```text
/anthropic login
# opens URL instructions in chat
/anthropic login complete <code#state>

/anthropic reauth 1
# opens URL instructions in chat
/anthropic reauth complete <code#state>
```

Pending slash OAuth flows expire after 10 minutes. If completion fails with an expiration message, run the start command again.

### Notes

- Destructive commands (`remove`, `logout`) run with non-interactive `--force` behavior in slash mode.
- Interactive `manage` is terminal-only; use granular slash commands instead.

## Account Selection Strategies

Control how the plugin picks which account to use for each request.

| Strategy               | Behavior                                                                                  | Best For                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **`sticky`** (default) | Stay on one account until it fails or is rate-limited                                     | Single account, predictable behavior, full feature compatibility                    |
| **`round-robin`**      | Rotate through accounts on every request                                                  | Spreading load evenly across accounts (see [limitations](#round-robin-limitations)) |
| **`hybrid`**           | Score-based selection with stickiness bias. Considers health, token budget, and freshness | Multiple accounts with varying rate limits                                          |

### Change Strategy

```bash
# Via CLI
opencode-anthropic-auth strategy round-robin

# Via environment variable (overrides config file)
export OPENCODE_ANTHROPIC_STRATEGY=hybrid

# Via config file
# Edit ~/.config/opencode/anthropic-auth.json
```

### Round-Robin Limitations

Some Anthropic API features maintain server-side per-account state that breaks when requests alternate between accounts:

| Feature                                                | Impact                                                                                                           | Plugin Mitigation                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Files API** (`files-api-2025-04-14`)                 | `file_id` is per-account; referencing Account A's file from Account B = `file_not_found`                         | **Auto-pinning**: the plugin tracks which account owns each `file_id` and routes the request accordingly |
| **Prompt Caching** (`prompt-caching-scope-2026-01-05`) | Cache is per-workspace; alternating accounts means zero cache hits, doubling token costs                         | **Auto-skipped** in round-robin: the `prompt-caching-scope` beta is excluded from the header             |
| **Code Execution** (`code-execution-2025-08-25`)       | Sandbox state is ephemeral per-request; multi-step workflows lose files/state when routed to a different account | **Manual opt-in only**: add the beta explicitly, and prefer sticky/pinned sessions for multi-step flows  |
| **Message Batches** (`message-batches-2024-09-24`)     | `batch_id` is per-account; polling from wrong account = 404                                                      | No automatic mitigation (not auto-included)                                                              |

**Recommendation for round-robin users:** If you need prompt caching or code execution, pin each OpenCode session to a single account:

```bash
# Terminal 1 — uses account 1
OPENCODE_ANTHROPIC_INITIAL_ACCOUNT=1 opencode

# Terminal 2 — uses account 2
OPENCODE_ANTHROPIC_INITIAL_ACCOUNT=2 opencode
```

This automatically overrides the strategy to `sticky` for that session, re-enabling strategy-sensitive auto betas (for example `prompt-caching-scope-2026-01-05`). Other sessions are unaffected.

## Configuration

Configuration is stored at `~/.config/opencode/anthropic-auth.json`. All settings are optional &mdash; defaults work well for most users.

```jsonc
{
  // Account selection strategy: "sticky" | "round-robin" | "hybrid"
  "account_selection_strategy": "sticky",

  // Seconds before consecutive failure count resets (60-7200)
  "failure_ttl_seconds": 3600,

  // Enable debug logging
  "debug": false,

  // Claude Code signature emulation behavior
  "signature_emulation": {
    // Enable Claude-style attribution/stainless headers and betas
    "enabled": true,
    // Resolve latest @anthropic-ai/claude-code version once on plugin startup
    "fetch_claude_code_version_on_startup": true,
    // Compact long injected system instructions to reduce token usage.
    // In "minimal" mode, repeated/contained blocks are deduplicated and title-generator
    // requests are replaced with a compact dedicated prompt.
    // "minimal" | "off"
    "prompt_compaction": "minimal",
  },

  // Context limit override for 1M-window models.
  // Prevents OpenCode from compacting too early when models.dev hasn't been
  // updated yet (e.g. claude-opus-4-6 and any *-1m model variants).
  // Only applied for OAuth (Max Plan) sessions — API key users use the
  // context-1m-2025-08-07 beta header instead.
  "override_model_limits": {
    // Enable/disable the override (default: off — enable if you need 1M context)
    "enabled": false,
    // Context window to inject (tokens). Default: 1_000_000.
    "context": 1000000,
    // Max output tokens to inject. 0 = leave the model's default unchanged.
    "output": 0,
  },

  // Health score tuning (0-100 scale)
  "health_score": {
    "initial": 70,
    "success_reward": 1,
    "rate_limit_penalty": -10,
    "failure_penalty": -20,
    "recovery_rate_per_hour": 2,
    "min_usable": 50,
    "max_score": 100,
  },

  // Client-side rate limiting (token bucket)
  "token_bucket": {
    "max_tokens": 50,
    "regeneration_rate_per_minute": 6,
    "initial_tokens": 50,
  },

  // Custom beta headers (added to every request via /anthropic betas add)
  "custom_betas": [],

  // Toast notification settings
  "toasts": {
    // Suppress non-error toasts (account status, switching)
    "quiet": false,
    // Minimum seconds between account-switch toasts (0-300)
    "debounce_seconds": 30,
  },

  // API preconnect: fire-and-forget HEAD to pre-warm TCP+TLS on init.
  // Skipped automatically when proxy/mTLS environment is detected.
  "preconnect": {
    "enabled": true,
    "timeout_ms": 10000,
  },

  // Output cap: default max_tokens per request. Escalates to 64K
  // after stop_reason: "max_tokens", then resets after one turn.
  "output_cap": {
    "enabled": true,
    "default_max_tokens": 8000,
    "escalated_max_tokens": 64000,
  },

  // Overflow recovery: auto-reduce max_tokens when the API returns
  // a structured "prompt_too_long" error, before falling back to
  // message trimming.
  "overflow_recovery": {
    "enabled": true,
    "safety_margin": 1000,
  },

  // Cache break detection: toast alert when cache_read_input_tokens
  // drops significantly between turns (system prompt or tool change).
  "cache_break_detection": {
    "enabled": true,
    "alert_threshold": 2000,
  },

  // Request classification: reduced retry budget for background
  // requests (title generation, short context queries).
  "request_classification": {
    "enabled": true,
    "background_max_service_retries": 0,
    "background_max_should_retries": 1,
  },

  // Token budget: parse natural-language budget expressions in user
  // messages (e.g. "+500k", "use 2M tokens"). Disabled by default.
  "token_budget": {
    "enabled": false,
    "default": 0,
    "completion_threshold": 0.9,
  },

  // Microcompact: inject clear_tool_uses/clear_thinking betas
  // when context utilization exceeds threshold_percent.
  "microcompact": {
    "enabled": true,
    "threshold_percent": 80,
  },

  // Overload recovery: quota-aware account switching on 529
  // exhaustion, with cooldown and error messaging.
  "overload_recovery": {
    "enabled": true,
    "default_cooldown_ms": 60000,
    "poll_quota_on_overload": true,
  },
}
```

### Environment Variables

| Variable                                           | Description                                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_ANTHROPIC_STRATEGY`                      | Override the account selection strategy at runtime.                                                                                                       |
| `OPENCODE_ANTHROPIC_DEBUG`                         | Set to `1` to enable debug logging.                                                                                                                       |
| `OPENCODE_ANTHROPIC_QUIET`                         | Set to `1` to suppress non-error toasts (account status, switching).                                                                                      |
| `OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE` | Set to `0` to disable Claude signature emulation (legacy mode).                                                                                           |
| `OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION`     | Set to `0` to skip npm version lookup at startup.                                                                                                         |
| `OPENCODE_ANTHROPIC_PROMPT_COMPACTION`             | Set to `off` to disable default minimal system prompt compaction.                                                                                         |
| `OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT`           | Set to `1` to log the final transformed `system` prompt to stderr (title-generator requests are skipped).                                                 |
| `OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS`         | Set to `0` to disable context limit overrides for 1M-window models (e.g. when models.dev has been updated).                                               |
| `OPENCODE_ANTHROPIC_INITIAL_ACCOUNT`               | Pin this session to a specific account (1-based index or email). Overrides strategy to `sticky`. See [Round-Robin Limitations](#round-robin-limitations). |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`           | Set to `1` to suppress experimental auto-betas (mirrors Claude Code gateway safety switch).                                                               |

### OAuth-only behavior

- The expected auth mode is OAuth (`claude login` / browser flow), not direct `ANTHROPIC_API_KEY` usage.
- In OAuth mode, the plugin always includes `oauth-2025-04-20` in `anthropic-beta`.
- This applies to all models, including Haiku.

## How It Works

When you make a request through OpenCode:

1. The plugin selects an account based on your strategy
2. It refreshes the OAuth token if expired
3. It transforms the request (adds OAuth headers, `oauth-2025-04-20`, signature headers, beta flags, tool prefixes)
4. If the response is account-specific (429/401, plus 400/403 billing/quota/permission errors), it marks that account and immediately tries the next account
5. If the response is service-wide (529/503), it retries up to 2 times with exponential backoff before returning the error
6. It tries each available account at most once per request
7. Successful responses have tool name prefixes stripped from the stream

The plugin also:

- Zeros out model costs (your subscription covers usage)
- Emulates Claude-style request headers and beta flags by default
- Sanitizes "OpenCode" references to "Claude Code" in system prompts (required by Anthropic's API)
- In `prompt_compaction="minimal"`, deduplicates repeated/contained system blocks and uses a compact dedicated prompt for internal title-generation requests
- Adds `?beta=true` to `/v1/messages` and `/v1/messages/count_tokens` requests

When signature emulation is disabled (`signature_emulation.enabled=false`), the plugin falls back to legacy behavior including the Claude Code system prompt prefix.

## Files

| Path                                                          | Description                            |
| ------------------------------------------------------------- | -------------------------------------- |
| `~/.config/opencode/anthropic-auth.json`                      | Plugin configuration                   |
| `~/.config/opencode/anthropic-accounts.json`                  | Account credentials (0600 permissions) |
| `~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js` | Installed plugin entry point           |
| `~/.local/bin/opencode-anthropic-auth`                        | CLI binary                             |

Account credentials are stored with restrictive file permissions (owner read/write only) and are excluded from git via an auto-generated `.gitignore`.

## Troubleshooting

### "Provider not showing up"

Make sure the plugin is installed in `~/.config/opencode/plugin/`. Restart OpenCode after installing.

### "TypeError: undefined is not an object (evaluating 'hook.config')"

This usually means OpenCode loaded a broken/missing plugin entry (often a stale file in `~/.config/opencode/plugin/`, or a plugin listed in `opencode.json` that is not actually installed).

For OpenCode v1.x, the safest local-dev setup is to link the package directory into OpenCode's `node_modules` and load it by package name:

```powershell
$link = "$env:USERPROFILE\.config\opencode\node_modules\opencode-anthropic-fix"
$target = "D:\git\opencode-anthropic-fix"

New-Item -ItemType Directory -Force -Path (Split-Path $link) | Out-Null
if (Test-Path $link) { Remove-Item $link -Recurse -Force }
New-Item -ItemType Junction -Path $link -Target $target
```

Then ensure `~/.config/opencode/opencode.json` contains:

```json
{
  "plugin": ["opencode-anthropic-fix"]
}
```

If you still see the error, temporarily keep only `"opencode-anthropic-fix"` in the plugin array and add other plugins back one-by-one to find the broken one.

Important: remove stale standalone files like `~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js` if present. They can shadow package loading and trigger `hook.config` crashes.

### "Auth flow completes but requests fail"

Your OAuth token may have expired. Try a quick refresh first, or re-authenticate with fresh browser login:

```bash
# Quick token refresh (no browser needed)
opencode-anthropic-auth refresh 1

# Full re-authentication (opens browser)
opencode-anthropic-auth reauth 1
```

Or re-run the auth flow from OpenCode: `Ctrl+K` &rarr; Connect Provider &rarr; Anthropic.

### "Need to inspect the final system prompt sent to Anthropic"

Enable system prompt debug logging:

```bash
export OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT=1
opencode
```

When enabled, the plugin prints the transformed `system` block (after sanitization/compaction) to `stderr` with prefix:

```text
[opencode-anthropic-auth][system-debug] transformed system:
```

Note: internal title-generator requests are intentionally skipped by this debug log to avoid noisy high-volume output.

### "Rate limited on all accounts"

When all accounts are exhausted for an account-specific error, the plugin returns immediately instead of sleeping in-process. Try:

```bash
# Check status
opencode-anthropic-auth list

# Reset tracking if stuck
opencode-anthropic-auth reset all
```

### "Toast notifications when using other models"

You may see `Claude: <email>` toasts even when your selected model is not Anthropic (e.g., OpenAI Codex, Gemini). This is expected behavior — OpenCode uses Claude Haiku as a background "small model" for internal tasks like generating session titles, regardless of which model you selected. These background API calls go through the Anthropic provider, which triggers the plugin's fetch interceptor and its account-usage toast.

To suppress non-error toasts, set `quiet` mode in your config:

```jsonc
// ~/.config/opencode/anthropic-auth.json
{
  "toasts": { "quiet": true },
}
```

Or via environment variable:

```bash
export OPENCODE_ANTHROPIC_QUIET=1
```

Error toasts (e.g., "Disabled Account 1 (token refresh failed)") are never suppressed.

### "CLI command not found"

Make sure `~/.local/bin` is on your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE) (GPLv3).

Copyright &copy; 2025-2026 Marco Jardim and contributors.

---

_Maintained at [marco-jardim/opencode-anthropic-fix](https://github.com/marco-jardim/opencode-anthropic-fix)._
