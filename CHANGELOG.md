# Changelog

All notable changes to `opencode-anthropic-fix` are documented here.

## [0.0.37] — 2026-03-31

### Emulation Sync

- **Bumped to Claude Code v2.1.88** — updated `FALLBACK_CLAUDE_CLI_VERSION`, `CLAUDE_CODE_BUILD_TIME`, SDK version map entry for v2.1.88 (SDK 0.208.0)
- No breaking mimesis changes — betas, headers, and body fields unchanged between v87 and v88

### Notes (v2.1.88 internal changes, no action needed)

- New `PermissionDenied` hook event (auto mode classifier deny → hook can retry)
- New `classifierApprovable` field on safety checks (routine boundaries vs exploit attempts)
- System prompt refactored: new `# Session-specific guidance` first-position block; Ask-tool/`! <command>` hints moved from `# System`; subagent/skill hints moved from `# Using your tools`
- Global cache separator now first-party-only (no env-var/feature-flag pathway)
- Manual compact excludes prior compact summaries from re-summarization
- Compact summaries skip message classification

## [0.0.36] — 2026-03-30

### Fixes

- **noReply bug fix** — `/anthropic` slash commands now set `output.noReply = true` to prevent command text from leaking to the agent as a user message

## [0.0.35] — 2026-03-29

### Emulation Sync

- **Bumped to Claude Code v2.1.87** — updated `FALLBACK_CLAUDE_CLI_VERSION`, `CLAUDE_CODE_BUILD_TIME`, SDK version map entries for v2.1.85–v2.1.87 (all SDK 0.208.0)
- **Removed `tool-examples-2025-10-29` beta** — no longer in the always-on beta list as of v2.1.87

### Features

- **Task Budgets propagation** — `task-budgets-2026-03-13` beta shortcut added (`task-budgets` / `budgets`); when active, `output_config: {max_output_tokens: 16384}` is injected into the request body. Compatible with model-router proxy (beta header + body forwarded as-is).
- **ECONNRESET recovery** — detects `ECONNRESET`, `EPIPE`, `ECONNABORTED`, `socket hang up`, and `network socket disconnected` errors in the fetch loop. On detection, disables keepalive (`keepalive: false, agent: false`) and retries the same account without consuming an attempt slot.
- **Willow Mode (Idle Return)** — detects session inactivity (default: 30 min idle with 3+ turns) and shows a toast suggesting `/clear` for a fresh context. Configurable via `willow_mode` in `anthropic-auth.json` with `idle_threshold_minutes`, `cooldown_minutes`, and `min_turns_before_suggest`.
- **`/anthropic review` slash command** — access Claude Code Review (Bughunter) results:
  - `/anthropic review` / `/anthropic review pr [<number>]` — show review findings for a PR
  - `/anthropic review branch [<name>]` — find PRs for a branch and show results
  - `/anthropic review status` — check if Code Review is configured on the repo
  - `/anthropic review help` — usage guide with severity docs
  - Parses `bughunter-severity` JSON from check run output (🔴 Important, 🟡 Nit, 🟣 Pre-existing)

### Documentation

- Updated `docs/claude-code-reverse-engineering.md` — added v2.1.85–v2.1.87 enforcement changelog, Code Review (Bughunter) section (§17), updated beta lists, version references
- Updated `docs/mimese-http-header-system-prompt.md` — added ECONNRESET recovery (§8), Willow Mode (§9), `/anthropic review` command (§10), task budgets body field (§7.4), removed `tool-examples` from beta lists

### Tests

- All 533 tests passing

## [0.0.34] — 2026-03-26

### Emulation Sync

- Bumped to Claude Code v2.1.84
- Added `context_management` body field injection when thinking is active
- Added `x-client-request-id` header (UUID per request)

## [0.0.33] — 2026-03-25

### Fixes

- CC credential source persistence, shell injection hardening, adaptive context hardening, tool_use-aware prefill guard

## [0.0.32] — 2026-03-24

### Fixes

- Minor patches and stability improvements
