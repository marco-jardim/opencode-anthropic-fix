# Changelog

All notable changes to `opencode-anthropic-fix` are documented here.

## [sync-2.1.92] — 2026-04-04

### Emulation Sync — v2.1.92

- **Bumped to Claude Code v2.1.92** — version, build_time (2026-04-03T23:25:15Z), SDK 0.80.0
- Synced from v3.936.0

## [0.0.45] — 2026-04-03

### Emulation Sync — v2.1.91

- **Bumped to Claude Code v2.1.91** — `FALLBACK_CLAUDE_CLI_VERSION`, `CLAUDE_CODE_BUILD_TIME` (2026-04-02T21:58:41Z), SDK version map entry (SDK 0.208.0 — unchanged)
- **No mimese-critical changes** — beta set, OAuth module, system prompt, identity strings, and SDK token all identical to v2.1.90
- **`CLAUDE_CODE_MCP_INSTR_DELTA` env var removed** — feature flag `tengu_basalt_3kr` was retired; MCP instruction delta graduated to default behavior. No action needed in our codebase.
- **Bundle size**: +34KB / +55 lines vs v2.1.90 (internal refinements, no API-facing changes)

### Tests

- Updated version conformance tests: `v2.1.90` → `v2.1.91` in user-agent and billing header assertions
- All tests passing

## [0.0.41] — 2026-04-01

### Emulation Sync — v2.1.90

- **Bumped to Claude Code v2.1.90** — `FALLBACK_CLAUDE_CLI_VERSION`, `CLAUDE_CODE_BUILD_TIME` (2026-04-01T22:53:10Z), SDK version map entry (SDK 0.208.0 — unchanged)
- **3 betas removed from v90** (verified against actual bundle, not docs):
  - `token-efficient-tools-2026-03-28` — fully absent from v90 bundle
  - `summarize-connector-text-2026-03-13` — dead slot `njq=""` in bundle, no-op expression
  - `cli-internal-2026-02-09` — fully absent, ant-internal feature graduated/retired
- **3 betas initially claimed as new were DOCS ONLY** (exist in embedded SDK documentation examples, not runtime code):
  - `compact-2026-01-12` — 5 matches, all in TS/PY/Go/C# code examples
  - `mcp-client-2025-11-20` — 2 matches, Java/PHP examples only
  - `structured-outputs-2025-11-13` — 1 match in Java example; only `-2025-12-15` is active

### Mimicry Improvements (verified against v90 bundle)

- **`cache_control` scope correctness** — identity block now emits `{type:"ephemeral"}` without `scope` field (matching CC behavior where `scope:"org"` is internal-only, never sent on wire). Static pre-boundary blocks correctly use `scope:"global"`.
- **Incoming `cache_control` stripping** — `normalizeSystemTextBlocks()` no longer passes through upstream `cache_control` markers, preventing "maximum of 4 blocks with cache_control" API errors when combined with our own markers.
- **`context-management-2025-06-27` model gate** — now excluded for Claude 3.x models (`/claude-3-/i` test), matching CC's `modelSupportsContextManagement()` function. Only Claude 4+ models support this beta.
- **Removed stale `tool-examples-2025-10-29`** from `EXPERIMENTAL_BETA_FLAGS` and `BEDROCK_UNSUPPORTED_BETAS`.

### Rate Limit Improvements (from sjawhar analysis, independently validated)

- **Transient 429 retry-same-account** — when `retry-after` is ≤10s and reason is `RATE_LIMIT_EXCEEDED`, sleeps and retries on the SAME account instead of rotating. Prevents wasting the account pool on momentary burst throttles.
- **`MAX_COOLDOWN_FROM_RESET` cap (5 minutes)** — cooldowns derived from `Retry-After` headers are now capped at 300,000ms. Prevents lock-out from buggy or far-future timestamps.

### Config

- `token_economy.token_efficient_tools` and `token_economy.connector_text_summarization` defaults changed to `false` (deprecated — betas removed in v90). Existing user configs with `true` are harmless but have no effect.

### Tests

- 683 tests across 26 files, all passing
- Updated conformance tests for v2.1.90 beta set, version strings, and removed betas

## [0.0.40] — 2026-03-31

### Internal Improvements (Plan A)

10 new features focused on cost optimization, observability, and resilience — no external API behavior changes.

#### Quick Wins

- **A1: API Preconnect** — fire-and-forget HEAD request on plugin init to pre-warm TCP+TLS connection. Auto-skipped when proxy/mTLS environment is detected (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, etc.). Config: `preconnect`.
- **A10: 8K Default Output Cap** — limits `max_tokens` to 8,000 by default (was uncapped). Auto-escalates to 64,000 after `stop_reason: "max_tokens"`, resets after one turn. Preserves caller-specified values. Config: `output_cap`.
- **A2: Context Overflow Auto-Recovery** — parses structured `prompt_too_long` errors (`input + max_tokens > limit`) to auto-reduce `max_tokens` with a configurable safety margin, before falling back to message trimming. Config: `overflow_recovery`.

#### Observability

- **A4: Per-Model Stats** — `sessionMetrics.perModel` tracks input/output/cache/cost per model. Shown in `/anthropic stats` when >1 model used. `stats reset` supported.
- **A5: `/anthropic context` Command** — token breakdown by role (system/user/assistant), tool_result grouping by tool name, duplicate content detection via SHA-256 hashing.
- **A3: Cache Break Detection** — hashes system prompt + tool schemas each turn. Alerts when `cache_read_input_tokens` drops >2K between turns, identifying which source changed. Config: `cache_break_detection`.

#### Cost & Context Optimization

- **A6: Rate Limit Awareness** — polls `/api/oauth/usage` every 10 turns or 5 minutes. Progressive warning toasts (caution at 50%, warning at 75%, danger at 90%). Config integrated into existing quota display.
- **A8: FG/BG Request Classification** — detects title-generation and short-context background requests. Reduces retry budget (0 service retries, 1 should-retry) to avoid wasting quota on throwaway requests. Config: `request_classification`.
- **A9: Token Budget Parsing** — parses natural-language budget expressions in user messages (`+500k`, `use 2M tokens`, `budget: 1M`). Injects budget progress into system prompt. Detects diminishing returns. Config: `token_budget` (disabled by default).
- **A7: Microcompact** — injects `clear_tool_uses_20250919` and `clear_thinking_20251015` betas when context utilization exceeds 80% of window. State resets on session compaction. Config: `microcompact`.

#### Bonus

- **Smart 529 Overload Recovery** — on 529 retry exhaustion, attempts quota-aware account switching with cached usage data for cooldown timing. Comprehensive error messages with quota %, reset times, and action suggestions. Config: `overload_recovery`.

### Bug Fixes

- **`_reqHasFileReferences` → `_reqHasFileRefs`** — variable name mismatch in fetch interceptor caused `ReferenceError` on all file-reference code paths.
- **`pollOAuthUsage` debugLog scope** — removed `debugLog` calls from module-scope function (only accessible inside plugin closure).
- **A3+A9 false alarm** — token budget system prompt block excluded from cache source hashing to prevent false cache break alerts every turn.

### Tests

- 137 new tests across 14 new test files (683 total across 26 files)
- Phase 0: 9 preflight validation tests
- Phase 1: 28 tests (preconnect, output cap, overflow recovery)
- Phase 2: 17 tests (context command, cache break detection)
- Phase 3: 50 tests (rate limit, FG/BG, token budget, microcompact, overload recovery)
- Phase 4: 36 tests (cross-feature integration, edge cases, performance)

### Configuration

8 new config sections in `anthropic-auth.json`: `preconnect`, `output_cap`, `overflow_recovery`, `cache_break_detection`, `request_classification`, `token_budget`, `microcompact`, `overload_recovery`. All have sensible defaults — no configuration required.

## [0.0.39] — 2026-03-31

### Bug Fixes

- **Slash command context leak** — `/anthropic` command text and `sendCommandMessage` output were leaking into the API messages array, causing the agent to see and respond to internal plugin commands. Added `stripSlashCommandMessages()` in `transformRequestBody()` that strips user messages starting with `/anthropic` and their associated `▣ Anthropic` responses before sending to the API.

### Tests

- 8 new slash command stripping tests (543 total)

## [0.0.38] — 2026-03-31

### Token Economy

- **Token-efficient tools** — `token-efficient-tools-2026-03-28` beta auto-included (default on). JSON tool_use format (FC v3) saves ~4.5% output tokens. Mutually exclusive with structured-outputs.
- **Redact thinking** — `redact-thinking-2026-02-12` beta opt-in (default off). Suppresses thinking summaries server-side. Toggle with `/anthropic set redact-thinking on|off`.
- **Connector-text summarization** — `summarize-connector-text-2026-03-13` beta auto-included (default on). API-side anti-distillation for assistant text between tool calls.
- **Provider-aware tool search** — uses `advanced-tool-use-2025-11-20` for 1P/foundry, `tool-search-tool-2025-10-19` for vertex/bedrock (was incorrectly using 3P header for all providers).
- **Beta header latching** — once a beta is sent in a session, it stays on for all subsequent requests. Prevents ~50-70K token cache key churn from mid-session beta changes.
- **Cache TTL session latching** — cache policy latched at first request for session stability.
- **Title generator cache skip** — title generator requests skip cache_control breakpoints (fire-and-forget queries don't benefit from caching).

### Adaptive 1M Context Fix

Three bugs fixed in the adaptive context auto-toggle system:

1. **Eligibility vs always-on confusion** — `hasOneMillionContext()` returned `true` for all Opus 4.6 models, keeping 1M always-on even when adaptive context was supposed to gate it. Split into `isEligibleFor1MContext()` (includes Opus 4.6) and `hasOneMillionContext()` (only explicit "-1m" suffix models).
2. **Sticky error escalation** — `escalatedByError` (set after `prompt_too_long`) was permanent until session compaction. Now clears after 5 turns if tokens drop below 75% of the de-escalation threshold.
3. **Cached decision invalidation** — `forceEscalateAdaptiveContext()` during `prompt_too_long` retry didn't reset the cached `_adaptiveOverrideForRequest`, so the retry used the stale (non-escalated) decision. Now resets `_adaptiveDecisionMade = false` after force-escalation.

### Configuration

New `token_economy` config section in `anthropic-auth.json`:

```jsonc
{
  "token_economy": {
    "token_efficient_tools": true,
    "redact_thinking": false,
    "connector_text_summarization": true,
  },
}
```

New `/anthropic set` commands: `token-efficient-tools`, `redact-thinking`, `connector-text`.

### Tests

- All 535 tests passing (533 original + 2 new adaptive context tests)

### Emulation Sync

- **Bumped to Claude Code v2.1.89** — updated `FALLBACK_CLAUDE_CLI_VERSION`, `CLAUDE_CODE_BUILD_TIME`, SDK version map entry for v2.1.89 (SDK 0.208.0 — unchanged)
- v2.1.89 is a build optimization release: 28% smaller bundle (18.2 MB → 13.1 MB), no API-facing changes
- Beta flags, system prompt, tool definitions, and API version all identical to v2.1.88
- New model aliases added upstream (`claude-opus-4-5`, `claude-haiku-4-5`, etc.) — already handled by regex-based model detection

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
