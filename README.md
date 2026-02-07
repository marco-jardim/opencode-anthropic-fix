# opencode-anthropic-auth

Use your Claude Pro or Max subscription with [OpenCode](https://github.com/anomalyco/opencode). Supports multiple accounts with automatic rotation when you hit rate limits.

## Quick Start

**Prerequisites:** [OpenCode](https://github.com/anomalyco/opencode) installed, a Claude Pro or Max subscription, Node.js 18+.

```bash
# 1. Clone and install
git clone https://github.com/actualyze-ai/opencode-anthropic-auth.git
cd opencode-anthropic-auth
npm install

# 2. Install the plugin + CLI
npm run install:link

# 3. Start OpenCode and connect
opencode
# Press Ctrl+K → Connect Provider → Anthropic → "Claude Pro/Max (multi-account)"
# Follow the OAuth prompts to log in
```

That's it. OpenCode will now use your Claude subscription directly. All model costs show as $0.00.

## Why This Fork?

The [upstream plugin](https://github.com/anomalyco/opencode-anthropic-auth) ships as a built-in default with OpenCode. This fork adds:

- **Multi-account support** &mdash; add up to 10 Claude accounts and rotate between them
- **Automatic rate limit handling** &mdash; when one account hits a limit, the plugin switches to another
- **Health scoring** &mdash; tracks account reliability and prefers healthy accounts
- **Standalone CLI** &mdash; manage accounts without opening OpenCode
- **Configurable strategies** &mdash; sticky, round-robin, or hybrid account selection

## Installation

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

### Additional Accounts

Run the auth flow again. The plugin detects existing accounts and shows a menu:

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

You can also use the **"Create an API Key"** or **"Manually enter API Key"** auth methods if you prefer API key auth (single account, no rotation).

## CLI

The CLI lets you manage accounts outside of OpenCode.

```bash
opencode-anthropic-auth [command] [args]
```

| Command                | Description                              |
| ---------------------- | ---------------------------------------- |
| `list`                 | Show all accounts with status (default)  |
| `status`               | Compact one-liner for scripts/prompts    |
| `switch <N>`           | Set account N as active                  |
| `enable <N>`           | Enable a disabled account                |
| `disable <N>`          | Disable an account (skipped in rotation) |
| `remove <N>`           | Remove an account permanently            |
| `reset <N\|all>`       | Clear rate-limit / failure tracking      |
| `stats`                | Show per-account token usage statistics  |
| `reset-stats [N\|all]` | Reset usage statistics                   |
| `strategy [name]`      | Show or change selection strategy        |
| `config`               | Show configuration and file paths        |
| `manage`               | Interactive account management menu      |
| `help`                 | Show help                                |

### Examples

```bash
# See account status
opencode-anthropic-auth list

# Output:
# Anthropic Multi-Account Status
# ──────────────────────────────────────────────────────────────
#   #    Account               Status        Failures   Rate Limit
#   1    alice@example.com     ● active      0          —
#   2    bob@example.com       ● ready       0          —
#
# Strategy: sticky | 2 of 2 enabled
# Storage: ~/.config/opencode/anthropic-accounts.json

# Switch active account
opencode-anthropic-auth switch 2

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

| Flag         | Description                              |
| ------------ | ---------------------------------------- |
| `--force`    | Skip confirmation prompts (for `remove`) |
| `--no-color` | Disable colored output                   |
| `--help`     | Show help message                        |

Most commands have short aliases: `ls`, `st`, `sw`, `en`, `dis`, `rm`, `strat`, `cfg`, `mg`.

## Account Selection Strategies

Control how the plugin picks which account to use for each request.

| Strategy               | Behavior                                                                                  | Best For                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **`sticky`** (default) | Stay on one account until it fails or is rate-limited                                     | Single account, or when you want predictable behavior |
| **`round-robin`**      | Rotate through accounts on every request                                                  | Spreading load evenly across accounts                 |
| **`hybrid`**           | Score-based selection with stickiness bias. Considers health, token budget, and freshness | Multiple accounts with varying rate limits            |

### Change Strategy

```bash
# Via CLI
opencode-anthropic-auth strategy round-robin

# Via environment variable (overrides config file)
export OPENCODE_ANTHROPIC_STRATEGY=hybrid

# Via config file
# Edit ~/.config/opencode/anthropic-auth.json
```

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

  // Toast notification settings
  "toasts": {
    // Suppress non-error toasts (account status, switching)
    "quiet": false,
    // Minimum seconds between account-switch toasts (0-300)
    "debounce_seconds": 30,
  },
}
```

### Environment Variables

| Variable                      | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| `OPENCODE_ANTHROPIC_STRATEGY` | Override the account selection strategy at runtime.                  |
| `OPENCODE_ANTHROPIC_DEBUG`    | Set to `1` to enable debug logging.                                  |
| `OPENCODE_ANTHROPIC_QUIET`    | Set to `1` to suppress non-error toasts (account status, switching). |

## How It Works

When you make a request through OpenCode:

1. The plugin selects an account based on your strategy
2. It refreshes the OAuth token if expired
3. It transforms the request (adds OAuth headers, beta flags, tool prefixes)
4. If the response is account-specific (429/401, plus 400/403 billing/quota/permission errors), it marks that account and immediately tries the next account
5. If the response is service-wide (500/503/529), it returns the error directly (switching accounts would not help)
6. It tries each available account at most once per request
7. Successful responses have tool name prefixes stripped from the stream

The plugin also:

- Zeros out model costs (your subscription covers usage)
- Prepends the "Claude Code" system prompt prefix
- Sanitizes "OpenCode" references to "Claude Code" in system prompts (required by Anthropic's API)
- Adds `?beta=true` to `/v1/messages` requests

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

### "Auth flow completes but requests fail"

Your OAuth token may have expired. Re-run the auth flow: `Ctrl+K` &rarr; Connect Provider &rarr; Anthropic.

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

Same as upstream. See [anomalyco/opencode-anthropic-auth](https://github.com/anomalyco/opencode-anthropic-auth).

---

_Maintained at [actualyze-ai/opencode-anthropic-auth](https://github.com/actualyze-ai/opencode-anthropic-auth)._
