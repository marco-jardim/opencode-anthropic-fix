# Changelog

All notable changes to `opencode-anthropic-fix` are documented here.

## [0.1.15] — 2026-04-18

### `token_economy.debug_dump_bodies` — opt-in request dumper

Diagnostic tool for the ongoing "why is spend still above CC" investigation.
When enabled, writes every outgoing request body to
`~/.opencode/opencode-anthropic-fix/request-dumps/req-<timestamp>.json`,
rotating at 10 files. Contains raw conversation content (user messages,
tool results) — do not enable on shared hosts. Intended flow: enable, run
3–4 turns, share the dump files for a byte-level diff of what's changing
between turns.

## [0.1.14] — 2026-04-18

### Cache-break detector: add `messages_prefix` + fix minus-sign typo

User reported frequent `Cache break detected` toasts with the `(u2212NNNN tokens)`
prefix but **no source name** after. Two fixes:

1. `(u2212...)` was a sed-escape residue — the intended character is the
   unicode minus sign (`−`, U+2212). Now renders correctly.
2. Toasts without a source name mean the detector knew the cache dropped but
   couldn't identify which source changed — because `extractCacheSourceHashes`
   only hashed `system_prompt` and tool schemas, not the conversation history.
   Added a `messages_prefix` hash (everything except the last message, with
   `cache_control` markers stripped to avoid false positives). When the toast
   names `messages_prefix`, the cache break is in the conversation history
   prefix — most likely opencode sending a rewritten history each turn, or
   per-turn metadata (timestamps, cwd snapshots) baked into the messages.

## [0.1.13] — 2026-04-17

### `token_economy.conservative` (default ON) — stop cache thrash

High-priority fix for user report "CC uses far fewer tokens than the plugin."
The v0.1.10 token-economy transforms shrink each request body but rewrite the
message history / tools array turn-to-turn. Every rewrite risks breaking the
prompt-cache prefix, forcing a fresh `cache_creation_input_tokens` charge
(2x base input multiplier) every turn. For long sessions, cache reuse
dominates per-turn cost — the "optimizations" were net negative.

New `token_economy.conservative: true` (default) disables all
cache-invalidating transforms:

- `ttl_thinking_strip`
- `proactive_microcompact`
- `trailing_summary_trim`
- `tool_result_dedupe`
- `stable_tool_ordering`
- `deferred_tool_names`

Unaffected (cache-safe): `adaptive_thinking_zero_simple` (only mutates the
thinking budget, not cached content).

To restore the v0.1.10–0.1.12 behavior, set `token_economy.conservative: false`
in `~/.opencode/opencode-anthropic-fix.json`.

## [0.1.12] — 2026-04-17

### `role_scoped_cache_ttl` default flipped off

Per user feedback, long-running opencode sessions benefit from 1h TTL on all
requests, not just main-thread. The role-scoped 5m downgrade was saving
marginal cache-write cost on title/small requests at the expense of shorter
cache lifetime for workflows that reuse those prefixes across multiple
minutes. Flag stays available (opt-in) for users who want the CC-accurate
`MoY` behavior.

## [0.1.11] — 2026-04-17

### Role-Scoped Cache TTL (CC v2.1.110+ `MoY` parity)

Real CC's `MoY(querySource)` gates the `ttl:"1h"` field on an allowlist of
query sources (`repl_main_thread*`, `sdk`, `auto_mode`). Non-matching requests
fall back to the default 5m tier, which has a cheaper write multiplier. We
were unconditionally writing 1h — inflating cache-write cost on title-gen /
small one-shot requests where the entry would never be reused before the 5m
mark anyway.

Implementation reuses the existing `classifyRequestRole(parsed)` classifier.
Cache breakpoints on tools and the last user message now use `ttl:"1h"` only
when the request role is `main`; everything else gets `ttl:"5m"`.

| Flag                    | Default | What it does                                        |
| ----------------------- | ------- | --------------------------------------------------- |
| `role_scoped_cache_ttl` | `true`  | Downgrade cache TTL to 5m for non-main requests     |
| `lean_system_non_main`  | `false` | Strip billing+identity system blocks on title/small |

### Lean System Prompt (opt-in)

When `token_economy.lean_system_non_main = true`, title-gen and small-shape
requests skip the billing-header and CC-identity prefix blocks in
`buildSystemPromptBlocks`. This preserves only the sanitized user system
prompt and eliminates ~3.5KB of cached-but-unused prefix for one-shots.
Default off because it changes the visible system-prompt shape — flip on if
your workflow relies heavily on non-main fanout (title generation,
name-this-chat, etc.).

Gate is deliberately narrow: only `"title"` and `"small"` roles are
affected — `"empty"` and `"unknown"` fall through unchanged to preserve
existing test contracts.

### `scripts/` reorganization

Moved 41 loose reverse-engineering files from `tmp/` and `_analysis/` into
`scripts/{mitm,capture,extract,bisect,verify,replay,analyze}/`. Only
`scripts/build.mjs`, `scripts/install.mjs`, and `scripts/README.md` are
tracked; subfolders are gitignored (research scaffolding, no stable API).
`scripts/README.md` documents each subfolder and two common workflows (plugin
4xx debugging, new CC version sync).

### Test coverage

- `regression.test.mjs` gains 4 tests: role-scoped TTL (1h vs 5m) and lean
  system prompt (strip on small, retain on main). All 1002 tests pass.

## [0.1.10] — 2026-04-17

### Token-Economy Overhaul

After benchmarking opencode vs. official Claude Code post-v2.1.110, opencode
showed higher per-turn token usage. Re-reading CC 2.1.112's
`createContextHintController` (`d6A`) revealed that context-hint is **purely
error-driven** — there is no success-path hint parser in CC. The real source
of the gap was missing client-side compaction strategies. This release ships
eight new `token_economy` knobs (most default on) that match what CC does
internally:

| Flag                            | Default | What it does                                      |
| ------------------------------- | ------- | ------------------------------------------------- |
| `ttl_thinking_strip`            | `true`  | Strips stale `thinking` blocks past cache TTL     |
| `proactive_microcompact`        | `true`  | Client-side compaction at `microcompact_percent`  |
| `microcompact_percent`          | `70`    | Usage threshold for proactive compaction          |
| `microcompact_keep_recent`      | `10`    | Recent turns preserved during compaction          |
| `stable_tool_ordering`          | `true`  | Canonical tool array order for prefix-cache hits  |
| `deferred_tool_names`           | `[…]`   | Tools replaced with name-only stubs until needed  |
| `adaptive_thinking_zero_simple` | `true`  | Zeros thinking budget for trivial follow-ups      |
| `tool_result_dedupe`            | `true`  | Cross-turn dedupe of identical tool_result blocks |
| `fast_mode_auto`                | `false` | Opus 4.6 short-message auto fast-mode (opt-in)    |
| `trailing_summary_trim`         | `true`  | Trims repetitive trailing summary blocks          |

Transformer order in `transformRequestBody` (line ~7412): TTL strip →
proactive microcompact → trailing summary trim → tool_result dedupe → stable
tool ordering → schema deferral → adaptive thinking zero. All gated on the
request classifying as `"main"` (see below). Session state lives in a new
`tokenEconomySession` closure (line ~195).

### Context-Hint Hardening

- **Default flipped to opt-out**: `token_economy.context_hint = false`. The
  `context-hint-2026-04-09` beta's server rollout is partial — uninvited
  clients receive `400 Unexpected value(s) 'context-hint-2026-04-09' for the
'anthropic-beta' header`, which was disrupting live sessions.
- **querySource-style gate added**: real CC only sends context-hint when
  `querySource.startsWith("repl_main_thread")`. We classify via body shape
  in new `classifyRequestRole(parsed)` (line ~5907). Title-gen / subagent
  shapes are now excluded even when the user opts in.
- Role is threaded via `_tokenEconomy.__requestRole` so both
  `buildAnthropicBetaHeader` call sites (latch + `buildRequestHeaders`) see
  the same decision.

### Tests

- `test/conformance/regression.test.mjs`: 4 tests in "Context-hint protocol
  (CC v2.1.110+)" using new `setupWithCtxHint()` + `MAIN_THREAD_BODY()`
  helpers. Covers opt-in + main-thread body, title-gen exclusion, disable
  state machine, and 422-retry compaction.
- `index.test.mjs:2906`: default-off guard — asserts no beta + no body field
  in the default config.
- Full suite: **998/998 pass**.

## [0.1.1] — 2026-04-08

### Emulation Sync — Claude Code v2.1.97

#### CCH Attestation Removed

- **`cch=00000` is now always static** — Claude Code v2.1.97 completely removed the xxHash64 attestation mechanism. The plugin no longer computes or injects any hash value.
- Removed `xxhash-wasm` dependency (no longer needed)
- Removed `computeAndReplaceCch()` function and its `CCH_SEED` constant
- Plugin was previously computing a real hash value; sending a computed `cch` with the server expecting `00000` caused request rejection. This was the root cause of the v2.1.97 breakage.

#### Version Bump

- `FALLBACK_CLAUDE_CLI_VERSION`: `2.1.96` → `2.1.97`
- `CLAUDE_CODE_BUILD_TIME`: updated to `2026-04-08T20:46:46Z`
- Added `["2.1.97", "0.208.0"]` to `CLI_TO_SDK_VERSION` map (SDK version unchanged)

#### Fast Mode — Opus 4.6 Only

- Fast mode (`speed: "fast"` body injection) now restricted to Opus 4.6 models only, matching v2.1.97's `xJ()` eligibility function. Previously also applied to Sonnet 4.6.

#### 1M Context Eligibility Expanded

- `isEligibleFor1MContext()` now covers all `claude-sonnet-4*` models (any Sonnet 4.x), matching CC's `U01()` function which checks `claude-sonnet-4*` OR `opus-4-6`.
- Previously only Opus 4.6 and explicit `*-1m` suffix models were eligible. Sonnet 4.x users with 200K+ context windows were not being escalated to the 1M beta.

#### Beta Flag Updates

- **Removed** `fine-grained-tool-streaming-2025-05-14` from `BEDROCK_UNSUPPORTED_BETAS` and `EXPERIMENTAL_BETA_FLAGS` (removed from v2.1.97 bundle entirely)
- **Removed** `code-execution-2025-08-25` and `files-api-2025-04-14` from `BEDROCK_UNSUPPORTED_BETAS` (Bedrock exclusion set simplified to 3 items in v2.1.97)
- **Added** `advisor-tool-2026-03-01`, `compact-2026-01-12` to `EXPERIMENTAL_BETA_FLAGS`
- `task-budgets-2026-03-13` already present from v2.1.84 sync

### Tests

- Version strings updated: `2.1.96` → `2.1.97` in all conformance and unit tests
- CCH test updated: `toMatch(/cch=[0-9a-f]{5}/)` → `toContain("cch=00000;")`
- 945 tests across all test files, all passing

### Documentation

- `README.md`: updated billing header bullet — removed xxHash64 claim, now correctly states `cch=00000` static
- `docs/mimese-http-header-system-prompt.md`: section 6.5 updated to reflect static `cch=00000`; section 6.6 rewritten as historical reference documenting the removed attestation mechanism

## [0.0.49] — 2026-04-08

### Major Features: CCH Attestation & System Prompt Validation

**Reverse Engineering Milestone** — Completed deep analysis of Claude Code's client attestation and API validation mechanisms.

#### CCH Attestation (xxHash64)

- **Implemented native xxHash64 client attestation** matching Claude Code's Bun binary behavior
- Computes 20-bit masked hash over full serialized JSON body with `"cch": "00000"` placeholder
- Uses version-specific seed: `0x6E52736AC806831E` (Claude Code v2.1.96)
- Automatically replaces placeholder in request body before sending to API
- Skipped on non-1P providers (bedrock, anthropicAws, mantle) and when attribution header disabled
- **Dependency added:** `xxhash-wasm ^1.1.0`
- **Documentation:** New section 6.6 in `docs/mimese-http-header-system-prompt.md` with algorithm details, implementation notes, and version registry

#### System Prompt Pattern Validation

- **Discovered Anthropic's system prompt validation rules** via binary search of API responses
- Server validates system prompt format to detect custom injections (e.g., "you are the best coding agent")
- Custom text outside the expected pattern triggers extra usage billing
- **Mitigation:** Plugin truncates user system text to 5000 characters (safe zone established in testing)
- Preserves Claude Code identity string, cache scope markers, and billing headers
- Sanitizes OpenCode references to match real Claude Code wire format
- **Documentation:** New section 6.7 with validation strategy and truncation behavior

#### OAuth Account UUID

- **Implemented account UUID retrieval from OAuth profile** to prevent cross-account impersonation
- Fetches `/api/oauth/profile` endpoint on account authorization
- Stores `accountUuid` in account credentials and persists across sessions
- Injects into `metadata.user_id.account_uuid` for every API request
- Server validates UUID against OAuth token to gate API access
- Prevents billing errors from UUID mismatch
- **Documentation:** New section 6.8 with validation flow and implementation details

### Updated Documentation

- **`docs/mimese-http-header-system-prompt.md`:**
  - Section 6.5: Updated billing header description to reference computed cch
  - Section 6.6: Complete CCH attestation algorithm with seed registry and version handling
  - Section 6.7: System prompt pattern validation rules and truncation strategy
  - Section 6.8: OAuth account UUID validation and implementation
  - Updated wire format examples to show real computed cch values

- **`README.md`:**
  - Updated billing header bullet point to mention xxHash64 computation and system prompt sanitization
  - Added Credits & Acknowledgments section with external research references:
    - CCH Attestation Reverse Engineering (a10k.co)
    - OpenClaw Billing Proxy (zacdcook)
    - Free Code CCH Implementation (paoloanzn)
    - rmk40 co-author credit for fingerprint work

### Bug Fixes

- System prompt serialization now matches real Claude Code body format exactly
- Account UUID handling improved in credential persistence and reloading

### Security

- Client-side attestation provides defense against direct API spoofing attempts
- System prompt pattern validation prevents unauthorized custom instruction injections
- Account UUID validation prevents cross-account request forgery

### Tests

- All existing tests passing (680+ tests across 26 files)
- New conformance tests for cch computation validation
- System prompt truncation edge cases covered

### Emulation Sync

- **Claude Code v2.1.96** — compatible with latest version's attestation mechanism
- Billing header format updated to reflect computed attestation values
- No breaking changes to beta flags, headers, or request flow

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
