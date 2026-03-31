# Implementation Plan: Internal Plugin Improvements (Plan A)

**Plan ID:** `PLANA-2026-03-31`
**Version:** 1.0
**Status:** Draft
**Author:** Internal analysis — opencode-anthropic-fix plugin (`index.mjs`, ~5,143 lines)
**References:** `index.mjs`, `lib/config.mjs`, `index.test.mjs`, `test/conformance/regression.test.mjs`

> **Scope:** All 10 features are implemented entirely within the existing plugin — no new npm packages required. This plan covers features A1–A10 organized into 4 implementation phases preceded by a pre-flight validation wave.

---

## Table of Contents

0. [Task Master List](#task-master-list) ← **Start here**
1. [Objective](#1-objective)
2. [Prerequisites](#2-prerequisites)
3. [Expected Outcome](#3-expected-outcome)
4. [Phases & Waves](#4-phases--waves)
   - [Phase 0: Pre-Flight Validation (Wave 0)](#phase-0-pre-flight-validation-wave-0)
   - [Phase 1: Quick Wins (Wave 1)](#phase-1-quick-wins-wave-1)
   - [Phase 2: Observability (Wave 2)](#phase-2-observability-wave-2)
   - [Phase 3: Cost & Context Optimization (Wave 3)](#phase-3-cost--context-optimization-wave-3)
   - [Phase 4: Senior QA Review (Wave 4)](#phase-4-senior-qa-review-wave-4)
5. [Global Acceptance Criteria](#5-global-acceptance-criteria)
6. [Global Definition of Done](#6-global-definition-of-done)
7. [Global Senior QA Review](#7-global-senior-qa-review)
8. [Rollback Strategy](#8-rollback-strategy)
9. [Risk Register](#9-risk-register)
10. [Appendix A: Task Dependency Graph](#appendix-a-task-dependency-graph)
11. [Appendix B: Files Impact Matrix](#appendix-b-files-impact-matrix)
12. [Appendix C: Test Coverage Matrix](#appendix-c-test-coverage-matrix)

---

## Task Master List

> Legend: `‖` = can run in parallel with adjacent tasks in the same group. `→` = sequential dependency. `⊘` = blocked until prerequisite completes. Duration is per-task estimated effort.
>
> **Tier Directives** (model delegation protocol):
> | Tier | Agent | Use For | Cost |
> |------|-------|---------|------|
> | `[tier:fast]` | Haiku 4.5 | Search, grep, read, lookup, validation, exists-check | 1x |
> | `[tier:medium]` | Sonnet 4.6 | Implementation, refactoring, tests, bugfix, config | 5x |
> | `[tier:heavy]` | Opus 4.6 | Architecture, security audit, conformance review, complex logic | 20x |
>
> Every numbered implementation step is prefixed with its tier. Multi-phase work: explore (`[tier:fast]`) → execute (`[tier:medium]`). Cheapest-first.

### Phase 0: Pre-Flight Validation (Wave 0) — ~1h total

All pre-flight tasks are independent and run in parallel except 0.7.

| #   | Task                                               | Tier          | Duration | Parallel      | Depends On | Files             | Status  |
| --- | -------------------------------------------------- | ------------- | -------- | ------------- | ---------- | ----------------- | ------- |
| 0.1 | Verify HEAD to `api.anthropic.com` responds        | `[tier:fast]` | 10 min   | ‖ 0.2-0.6     | —          | `test/preflight/` | Pending |
| 0.2 | Verify `/api/oauth/usage` endpoint exists & format | `[tier:fast]` | 15 min   | ‖ 0.1,0.3-0.6 | —          | `test/preflight/` | Pending |
| 0.3 | Verify `clear_tool_uses_20250919` beta accepted    | `[tier:fast]` | 15 min   | ‖ 0.1-0.2,0.4 | —          | `test/preflight/` | Pending |
| 0.4 | Verify `clear_thinking_20251015` beta accepted     | `[tier:fast]` | 15 min   | ‖ 0.1-0.3,0.5 | —          | `test/preflight/` | Pending |
| 0.5 | Verify context limit error message format          | `[tier:fast]` | 15 min   | ‖ 0.1-0.4,0.6 | —          | `test/preflight/` | Pending |
| 0.6 | Verify proxy/mTLS detection approach               | `[tier:fast]` | 10 min   | ‖ 0.1-0.5     | —          | `test/preflight/` | Pending |
| 0.7 | Document pre-flight results                        | `[tier:fast]` | 20 min   | →             | ⊘ 0.1-0.6  | `docs/plans/`     | Pending |

**Parallelism: 6 tasks run simultaneously, then 1 sequential.**

---

### Phase 1: Quick Wins (Wave 1) — ~3h total

| #   | Task                               | Tier            | Duration | Parallel | Depends On | Files                         | Status  |
| --- | ---------------------------------- | --------------- | -------- | -------- | ---------- | ----------------------------- | ------- |
| 1.1 | A1: API Preconnect on init         | `[tier:medium]` | 30 min   | ‖ 1.2    | ⊘ Phase 0  | `index.mjs`                   | Pending |
| 1.2 | A10: 8K Default Output Cap         | `[tier:medium]` | 60 min   | ‖ 1.1    | ⊘ Phase 0  | `index.mjs`, `lib/config.mjs` | Pending |
| 1.3 | A2: Context Overflow Auto-Recovery | `[tier:medium]` | 90 min   | →        | ⊘ 1.2      | `index.mjs`                   | Pending |

**Parallelism: 1.1 ‖ 1.2 simultaneously, then 1.3 sequential (depends on 1.2 for max_tokens logic).**

---

### Phase 2: Observability (Wave 2) — ~5h total

| #   | Task                                  | Tier            | Duration | Parallel   | Depends On | Files       | Status  |
| --- | ------------------------------------- | --------------- | -------- | ---------- | ---------- | ----------- | ------- |
| 2.1 | A4: `/anthropic stats` Per-Model Data | `[tier:medium]` | 90 min   | ‖ 2.2, 2.3 | ⊘ Phase 1  | `index.mjs` | Pending |
| 2.2 | A5: `/anthropic context` Command      | `[tier:medium]` | 90 min   | ‖ 2.1, 2.3 | ⊘ Phase 1  | `index.mjs` | Pending |
| 2.3 | A3: Cache Break Detection             | `[tier:medium]` | 120 min  | ‖ 2.1, 2.2 | ⊘ Phase 1  | `index.mjs` | Pending |

**Parallelism: All 3 tasks run simultaneously.**

---

### Phase 3: Cost & Context Optimization (Wave 3) — ~10h total

| #   | Task                                     | Tier            | Duration | Parallel | Depends On | Files                         | Status  |
| --- | ---------------------------------------- | --------------- | -------- | -------- | ---------- | ----------------------------- | ------- |
| 3.1 | A6: Rate Limit Awareness & OAuth Usage   | `[tier:medium]` | 150 min  | ‖ 3.2    | ⊘ 0.2, 2.1 | `index.mjs`                   | Pending |
| 3.2 | A8: Foreground/Background Classification | `[tier:medium]` | 120 min  | ‖ 3.1    | ⊘ Phase 2  | `index.mjs`, `lib/config.mjs` | Pending |
| 3.3 | A9: Token Budget Parsing & Enforcement   | `[tier:heavy]`  | 150 min  | →        | ⊘ 3.1, 3.2 | `index.mjs`, `lib/config.mjs` | Pending |
| 3.4 | A7: Microcompact — Selective Trimming    | `[tier:heavy]`  | 240 min  | →        | ⊘ 0.3, 0.4 | `index.mjs`, `lib/config.mjs` | Pending |

**Parallelism: 3.1 ‖ 3.2 simultaneously, then 3.3 → 3.4 sequentially.**

---

### Phase 4: Senior QA Review (Wave 4) — ~4h total

| #   | Task                              | Tier            | Duration | Parallel   | Depends On | Files                | Status  |
| --- | --------------------------------- | --------------- | -------- | ---------- | ---------- | -------------------- | ------- |
| 4.1 | Cross-feature integration testing | `[tier:heavy]`  | 60 min   | ‖ 4.2, 4.3 | ⊘ Phase 3  | `index.test.mjs`     | Pending |
| 4.2 | Edge case & error path validation | `[tier:heavy]`  | 60 min   | ‖ 4.1, 4.3 | ⊘ Phase 3  | `index.test.mjs`     | Pending |
| 4.3 | Performance regression testing    | `[tier:medium]` | 45 min   | ‖ 4.1, 4.2 | ⊘ Phase 3  | `index.test.mjs`     | Pending |
| 4.4 | Documentation audit               | `[tier:fast]`   | 30 min   | →          | ⊘ 4.1-4.3  | `README.md`, `docs/` | Pending |

**Parallelism: 4.1 ‖ 4.2 ‖ 4.3 simultaneously, then 4.4 sequential.**

---

### Summary: Total Tasks & Parallelism

| Phase     | Tasks  | Parallel Groups       | Sequential Bottlenecks       | Est. Wall-Clock (with parallelism) |
| --------- | ------ | --------------------- | ---------------------------- | ---------------------------------- |
| 0         | 7      | 6 ‖ → 1               | 0.7 (doc)                    | ~40 min                            |
| 1         | 3      | 2 ‖ → 1               | 1.3 (overflow)               | ~2.5h                              |
| 2         | 3      | 3 ‖                   | None                         | ~2h                                |
| 3         | 4      | 2 ‖ → 1 → 1           | 3.3 (budget), 3.4 (µcompact) | ~7h                                |
| 4         | 4      | 3 ‖ → 1               | 4.4 (docs)                   | ~1.5h                              |
| **Total** | **21** | **16 parallelizable** | **5 sequential**             | **~13.5h wall-clock**              |

**Critical path:** Phase 0.7 → 1.2 → 1.3 → Phase 2 (parallel) → 3.1/3.2 → 3.3 → 3.4 → Phase 4.4

---

## 1. Objective

Add 10 self-contained improvements to the OpenCode anthropic-auth plugin that enhance performance, observability, and cost efficiency for Claude-based coding sessions. All features are implemented within `index.mjs` and `lib/config.mjs` — no new npm packages. The goals are:

1. **Reduce latency** — API preconnect overlaps TCP/TLS with startup (A1)
2. **Recover gracefully** — auto-fix context overflow instead of surfacing errors (A2)
3. **Save context window** — cap output at 8K by default, escalate only when needed (A10)
4. **Add visibility** — per-model stats dashboard, context breakdown, cache break alerts (A3, A4, A5)
5. **Stay within limits** — proactive OAuth usage polling with progressive warnings (A6)
6. **Reduce cost** — selective tool/thinking context trimming before full compaction (A7)
7. **Prioritize correctly** — foreground vs background retry budgets (A8)
8. **Respect budgets** — natural-language token budget enforcement (A9)

**Success metric:** A multi-hour coding session with these features enabled should use ≥20% fewer context tokens, never surface a `prompt_too_long` error to the user, and maintain real-time visibility into token consumption and costs.

---

## 2. Prerequisites

| #   | Prerequisite                                                                    | Status       |
| --- | ------------------------------------------------------------------------------- | ------------ |
| P1  | Plugin `index.mjs` at ~5,143 lines with fetch interceptor at ~line 2270         | Verify first |
| P2  | `buildAnthropicBetaHeader()` at line ~4454 in place                             | Verify first |
| P3  | `transformRequestBody()` at line ~4851 in place                                 | Verify first |
| P4  | `sessionMetrics` at line 3210 with token/cost accumulation in place             | Done         |
| P5  | `adaptiveContextState` at line 3235 in place                                    | Done         |
| P6  | `handleAnthropicSlashCommand()` at line 523 with stats display at lines 631–714 | Done         |
| P7  | Retry logic at line ~2272 (`serviceWideRetryCount`, `shouldRetryCount`)         | Done         |
| P8  | `sessionMetrics.lastQuota` populated from response headers at lines 2618–2621   | Done         |
| P9  | Test suite: 543 tests passing (127 + 40 + 42 + others)                          | Verify first |
| P10 | Phase 0 pre-flight results documented before Phase 1 begins                     | Required     |

---

## 3. Expected Outcome

### After Phase 0 (Validation)

- Documented whether HEAD preconnect is viable, `/api/oauth/usage` format known, microcompact betas confirmed.
- Go/no-go decisions for A1 (proxy/mTLS skip), A6 (usage endpoint), A7 (microcompact betas).

### After Phase 1 (Quick Wins)

- First real API call latency reduced by 100–200ms (A1).
- `prompt_too_long` errors auto-recovered via max_tokens reduction (A2).
- 8K output cap reduces context waste for typical requests (A10).

### After Phase 2 (Observability)

- Per-model cost breakdown in `/anthropic stats` (A4).
- `/anthropic context` shows token breakdown per message role with duplicate detection (A5).
- Cache break alerts fire when system prompt or tool schema changes invalidate the cache (A3).

### After Phase 3 (Optimization)

- OAuth usage endpoint polled every 10 requests; toasts at 75%/50%/25% remaining (A6).
- Background requests (title generation) get reduced retry budget, saving account quota (A8).
- Natural-language token budgets parsed and enforced with system-prompt injection (A9).
- Microcompact injects context-clearing betas at 80% window usage, deferring full compaction (A7).

### After Phase 4 (QA)

- All cross-feature interactions verified (e.g., A2 + A10 interplay, A7 + A3 interplay).
- Performance regression baseline established. Documentation updated.

---

## 4. Phases & Waves

---

### Phase 0: Pre-Flight Validation (Wave 0)

**Goal:** Validate external API assumptions and environment constraints before committing to implementation.
**Duration:** ~1 hour
**Dependencies:** Active OAuth account

#### Pre-flight Checks

- [ ] [tier:fast] 0.a: Environment has `index.mjs` at expected line ranges (spot-check lines 2272, 3210, 4454, 4723, 4851)
- [ ] [tier:medium] 0.b: Vitest test suite passes: `npm test` exits 0
- [ ] [tier:fast] 0.c: Active OAuth account available for live API calls

---

#### Task 0.1: Verify HEAD Request to `api.anthropic.com`

**Risk addressed:** The API preconnect (A1) must not block on environments with HTTP proxies or mTLS gateways where a bare HEAD would fail or require auth.

**Method:**

1. [tier:fast] Send `HEAD https://api.anthropic.com` with 10s timeout; check HTTP status
2. [tier:fast] Check if `HTTPS_PROXY` / `http_proxy` / `ALL_PROXY` env vars are set — if so, mark preconnect as proxy-aware
3. [tier:fast] Check if `NODE_EXTRA_CA_CERTS` or `NODE_TLS_REJECT_UNAUTHORIZED=0` is set (mTLS signal)

**Output:** `PREFLIGHT_PRECONNECT = "ok" | "proxy" | "mtls" | "blocked"`

---

#### Task 0.2: Verify `/api/oauth/usage` Endpoint

**Risk addressed:** The endpoint format, auth requirements, and response schema for A6 rate limit awareness must be known before implementation.

**Method:**

1. [tier:fast] `GET https://api.anthropic.com/api/oauth/usage` with valid OAuth Bearer token
2. [tier:fast] Log response status, Content-Type, and body structure
3. [tier:fast] Identify: `{ session: { used, limit, reset_at }, weekly: { used, limit, reset_at } }` or similar
4. [tier:fast] Check if endpoint requires additional scopes beyond `user:inference`

**Output:** `PREFLIGHT_OAUTH_USAGE = { status, schema, requires_scope }` or `"not_found"`

---

#### Task 0.3: Verify `clear_tool_uses_20250919` Beta

**Risk addressed:** The microcompact feature (A7) depends on this beta being accepted.

**Method:**

1. [tier:fast] Send a `/v1/messages` request with `anthropic-beta: clear_tool_uses_20250919` in header
2. [tier:fast] Verify: 200 response (accepted) vs 400 with error mentioning the beta (rejected)

**Output:** `PREFLIGHT_CLEAR_TOOL_USES = "accepted" | "rejected"`

---

#### Task 0.4: Verify `clear_thinking_20251015` Beta

**Risk addressed:** Microcompact's thinking-clearing path depends on this beta.

**Method:**

1. [tier:fast] Send a `/v1/messages` request with `anthropic-beta: clear_thinking_20251015` in header (note: a reference to this beta already appears in `index.mjs` at line 4893, but API-side validation is unconfirmed)
2. [tier:fast] Verify: 200 vs 400

**Output:** `PREFLIGHT_CLEAR_THINKING = "accepted" | "rejected"`

---

#### Task 0.5: Verify Context Limit Error Message Format

**Risk addressed:** A2 auto-recovery parses the error message `"input length and \`max_tokens\` exceed context limit: {input} + {max_tokens} > {limit}"`. The format must be stable.

**Method:**

1. [tier:fast] Intentionally send a request with `max_tokens` set so that `input + max_tokens > context_window` (e.g., send a 1-token prompt with `max_tokens: 1_000_000` to claude-haiku-4-5)
2. [tier:fast] Capture the exact error body: `error.type`, `error.message` pattern
3. [tier:fast] Verify the numeric pattern `(\d+) \+ (\d+) > (\d+)` matches

**Output:** `PREFLIGHT_OVERFLOW_FORMAT = { type, message_regex, confirmed: boolean }`

---

#### Task 0.6: Verify Proxy/mTLS Detection Logic

**Risk addressed:** A1 preconnect must skip gracefully in corporate environments.

**Method:**

1. [tier:fast] Enumerate env vars that signal proxy: `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `NO_PROXY`
2. [tier:fast] Enumerate mTLS signals: `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`
3. [tier:fast] Confirm the detection function can be a pure predicate with no side effects

**Output:** `PREFLIGHT_PROXY_DETECTION = { env_vars_checked: string[], approach: "env_scan" }`

---

#### Task 0.7: Document Pre-Flight Results

**Output file:** `docs/plans/preflight-results-plan-a.md`

1. [tier:fast] Date, account used, Claude models tested
2. [tier:fast] Result table: all `PREFLIGHT_*` values
3. [tier:fast] Go/no-go per feature: A1 (proxy safe?), A6 (usage schema), A7 (betas confirmed)
4. [tier:fast] Any adjusted implementation approaches

**This file MUST be completed before Phase 1 begins.**

---

#### Phase 0 — New Tests

> [tier:medium] All Phase 0 tests are written and run by the medium-tier agent.

| Test | Description                                                 |
| ---- | ----------------------------------------------------------- |
| T0.1 | `preflightHeadRequest()` resolves in < 10s on clean network |
| T0.2 | Proxy env vars detected correctly (mock env)                |
| T0.3 | Context limit error regex matches expected format           |

**Phase 0 test target: 3 tests**

---

#### Phase 0 Acceptance Criteria

- [ ] [tier:fast] All 6 pre-flight tasks documented in `preflight-results-plan-a.md`
- [ ] [tier:fast] Every `PREFLIGHT_*` variable has a value (not "unknown")
- [ ] [tier:fast] Go/no-go decisions written for A1, A6, A7

#### Phase 0 Definition of Done

- [ ] [tier:fast] `preflight-results-plan-a.md` committed
- [ ] [tier:fast] No Phase 1 tasks started without Phase 0 sign-off

#### Phase 0 Senior QA Review

> [tier:heavy] Senior QA review for Phase 0.

- Verify pre-flight tests don't accidentally consume significant API tokens
- Confirm proxy detection approach works on Windows (`HTTPS_PROXY` case-sensitivity)

---

### Phase 1: Quick Wins (Wave 1)

**Goal:** High-value, low-risk improvements with no behavioral changes to normal requests.
**Duration:** ~3 hours
**Dependencies:** Phase 0 complete

#### Pre-flight Check (Phase 1)

- [ ] [tier:fast] Phase 0 results confirm `PREFLIGHT_PRECONNECT !== "blocked"` before starting 1.1
- [ ] [tier:fast] Phase 0 results confirm `PREFLIGHT_OVERFLOW_FORMAT.confirmed === true` before starting 1.3
- [ ] [tier:medium] `npm test` passes (zero regressions baseline)

---

#### Task 1.1 (A1): API Preconnect on Plugin Init

**What:** Fire-and-forget `HEAD https://api.anthropic.com` during plugin startup to pre-warm TCP+TLS. Saves 100–200ms on the first real API call.

**Files to modify:**

- `index.mjs` — `AnthropicAuthPlugin` init section (near line ~2174 where `telemetryEmitter.init()` is called)

**New functions:**

- `preconnectApi()` — new standalone function (add near line ~2170)

**Implementation steps:**

1. [tier:fast] Locate the plugin's `init()` / startup section in `index.mjs` (near line 2174)
2. [tier:medium] Add new function `preconnectApi(config)`:
   ```js
   async function preconnectApi(config) {
     if (!config.preconnect?.enabled) return;
     if (isProxyOrMtlsEnvironment()) return; // skip in proxy/mTLS
     try {
       await Promise.race([
         globalThis.fetch("https://api.anthropic.com", { method: "HEAD" }),
         new Promise((_, r) => setTimeout(() => r(new Error("timeout")), config.preconnect.timeout_ms ?? 10_000)),
       ]);
     } catch {
       /* fire-and-forget — never throws */
     }
   }
   ```
3. [tier:medium] Add helper `isProxyOrMtlsEnvironment()` — checks `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`
4. [tier:medium] Call `preconnectApi(config)` (no `await`) from plugin init — explicitly fire-and-forget
5. [tier:medium] Add config keys to `lib/config.mjs` `DEFAULT_CONFIG`:
   ```js
   preconnect: {
     enabled: true,
     timeout_ms: 10_000,
   }
   ```

**Tests:**

- [ ] [tier:medium] T1.1.1: `preconnectApi()` called at startup when `preconnect.enabled: true`
- [ ] [tier:medium] T1.1.2: `preconnectApi()` skipped when `preconnect.enabled: false`
- [ ] [tier:medium] T1.1.3: `preconnectApi()` skipped when `HTTPS_PROXY` env var is set

**Phase 1.1 acceptance criteria:**

- [ ] [tier:fast] No `await` on preconnect — startup time not blocked
- [ ] [tier:medium] No exception thrown if preconnect fails (network offline, DNS failure)
- [ ] [tier:fast] Config key `preconnect.enabled` toggles feature off

---

#### Task 1.2 (A10): 8K Default Output Cap

**What:** Default `max_tokens` to 8,000 (CC's p99 real output ≈ 4,900). Escalate to 64,000 only after output truncation (`stop_reason: "max_tokens"`). Saves input context window for prompt content.

**Files to modify:**

- `index.mjs` — `transformRequestBody()` at line ~4851
- `lib/config.mjs` — add `output_cap` section to `DEFAULT_CONFIG`

**New functions:**

- `resolveMaxTokens(body, config, sessionState)` — new function near line ~4850

**New session state field:**

- `sessionMetrics.lastStopReason` — tracks the most recent `stop_reason` from streaming responses

**Implementation steps:**

1. [tier:fast] Read `transformRequestBody()` at line ~4851 to identify current `max_tokens` handling
2. [tier:medium] Add `output_cap` to `lib/config.mjs` `DEFAULT_CONFIG`:
   ```js
   output_cap: {
     enabled: true,
     default_max_tokens: 8_000,
     escalated_max_tokens: 64_000,
   }
   ```
3. [tier:medium] Add `lastStopReason: null` field to `sessionMetrics` at line 3210
4. [tier:medium] In the SSE stream parsing (fetch interceptor, near line ~2618), capture `stop_reason` from `message_delta` event and write to `sessionMetrics.lastStopReason`
5. [tier:medium] Implement `resolveMaxTokens(body, config)`:
   ```js
   function resolveMaxTokens(body, config) {
     if (!config.output_cap?.enabled) return body.max_tokens; // passthrough
     if (body.max_tokens != null) return body.max_tokens; // caller-specified wins
     const escalated = sessionMetrics.lastStopReason === "max_tokens";
     return escalated ? config.output_cap.escalated_max_tokens : config.output_cap.default_max_tokens;
   }
   ```
6. [tier:medium] In `transformRequestBody()`, replace raw `max_tokens` passthrough with `resolveMaxTokens()` call
7. [tier:medium] After escalation used, reset `sessionMetrics.lastStopReason` to `null`

**Tests:**

- [ ] [tier:medium] T1.2.1: No caller `max_tokens` → resolved to `8_000` (default)
- [ ] [tier:medium] T1.2.2: Caller-specified `max_tokens` is preserved unchanged
- [ ] [tier:medium] T1.2.3: After `stop_reason === "max_tokens"`, next request resolves to `64_000`
- [ ] [tier:medium] T1.2.4: After escalated response (non-truncated), resets to `8_000` on next request
- [ ] [tier:medium] T1.2.5: `output_cap.enabled: false` → passthrough behavior (no cap applied)

**Phase 1.2 acceptance criteria:**

- [ ] [tier:medium] Existing tests for `transformRequestBody()` still pass
- [ ] [tier:medium] Escalation is sticky exactly one turn (then resets)

---

#### Task 1.3 (A2): Context Overflow Auto-Recovery

**What:** Fetch interceptor catches `prompt_too_long` / `invalid_request_error` with pattern `"input length and \`max_tokens\` exceed context limit: {input} + {max_tokens} > {limit}"`. Parses numbers. Auto-reduces `max_tokens`to`limit - input - 1000`. Retries once.

**Files to modify:**

- `index.mjs` — retry logic near line ~2719 (where `prompt_too_long` is already detected)

**New functions:**

- `parseContextLimitError(errorMessage)` — returns `{ input, maxTokens, limit }` or `null`
- `computeSafeMaxTokens(input, limit, margin)` — returns `limit - input - margin`

**Implementation steps:**

1. [tier:fast] Read lines 2715–2730 of `index.mjs` to understand existing `prompt_too_long` handling (currently only triggers adaptive context escalation, does not retry with reduced `max_tokens`)
2. [tier:medium] Add `parseContextLimitError(msg)`:
   ```js
   function parseContextLimitError(msg) {
     const m = msg?.match(/input length and `max_tokens` exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
     if (!m) return null;
     return { input: +m[1], maxTokens: +m[2], limit: +m[3] };
   }
   ```
3. [tier:medium] In the retry block near line 2719, after the existing `prompt_too_long` branch:
   - Call `parseContextLimitError(errorBody)` to attempt structured parse
   - If successful AND no overflow-retry has been attempted yet (guard: `overflowRetryAttempted` flag scoped to the request):
     - Compute safe `max_tokens = limit - input - OVERFLOW_SAFETY_MARGIN` (default margin: 1,000)
     - Re-inject `max_tokens` into the cloned request body
     - Set `overflowRetryAttempted = true`
     - Retry the request with the same account (not account rotation — this is a body issue, not an auth issue)
   - If parse fails or already attempted, fall through to existing error handling
4. [tier:medium] Add config key `overflow_recovery` to `lib/config.mjs`:
   ```js
   overflow_recovery: {
     enabled: true,
     safety_margin: 1_000,
   }
   ```
5. [tier:medium] Ensure the overflow-retry does NOT trigger the adaptive context escalation path (they are separate concerns)

**Tests:**

- [ ] [tier:medium] T1.3.1: `parseContextLimitError()` parses the exact format from preflight result
- [ ] [tier:medium] T1.3.2: `parseContextLimitError()` returns `null` for unrelated error messages
- [ ] [tier:medium] T1.3.3: Auto-retry fires with reduced `max_tokens` on first overflow
- [ ] [tier:medium] T1.3.4: Overflow-retry uses correct safe value: `limit - input - 1000`
- [ ] [tier:medium] T1.3.5: Second overflow in the same request does NOT retry (guard prevents infinite loop)
- [ ] [tier:medium] T1.3.6: `overflow_recovery.enabled: false` → no auto-retry, error surfaces normally

**Phase 1.3 acceptance criteria:**

- [ ] [tier:medium] No infinite retry loops (single overflow-retry only per request)
- [ ] [tier:fast] `overflowRetryAttempted` flag is request-scoped, not session-scoped
- [ ] [tier:fast] Safety margin is configurable via `overflow_recovery.safety_margin`

---

#### Phase 1 — New Tests Summary

> [tier:medium] All Phase 1 tests are written and run by the medium-tier agent.

| Task                 | Tests         | Subtotal |
| -------------------- | ------------- | -------- |
| A1 preconnect        | T1.1.1–T1.1.3 | 3        |
| A10 output cap       | T1.2.1–T1.2.5 | 5        |
| A2 overflow recovery | T1.3.1–T1.3.6 | 6        |
| **Phase 1 total**    |               | **14**   |

#### Phase 1 Acceptance Criteria

- [ ] [tier:medium] `npm test` passes with all 14 new tests green, no regressions
- [ ] [tier:fast] Preconnect fires at startup (verify via mock fetch spy)
- [ ] [tier:fast] `prompt_too_long` error no longer surfaces when auto-recovery fires
- [ ] [tier:fast] Default `max_tokens` for new requests is 8,000 (verify via request capture)

#### Phase 1 Definition of Done

- [ ] [tier:medium] All 3 tasks code-complete
- [ ] [tier:fast] `lib/config.mjs` updated with `preconnect`, `output_cap`, `overflow_recovery` sections
- [ ] [tier:fast] TypeScript JSDoc types added for new config sections
- [ ] [tier:medium] Existing conformance tests pass: `npm run test:conformance`

#### Phase 1 Senior QA Review

> [tier:heavy] Senior QA review for Phase 1.

- Confirm preconnect cannot be `await`-ed (no latency regression on slow networks)
- Verify `max_tokens: 0` caller edge case does not conflict with `output_cap` logic
- Verify overflow recovery does not interact with the adaptive context escalation path at line 2723 in unexpected ways

---

### Phase 2: Observability (Wave 2)

**Goal:** Add visibility tooling that does not change API request behavior.
**Duration:** ~5 hours
**Dependencies:** Phase 1 complete

#### Pre-flight Check (Phase 2)

- [ ] [tier:medium] Phase 1 `npm test` passed with 0 failures
- [ ] [tier:fast] `sessionMetrics` at line 3210 accumulates correctly (manual spot-check)
- [ ] [tier:fast] `/anthropic stats` command at line 631 renders without error

---

#### Task 2.1 (A4): `/anthropic stats` Per-Model Breakdown & Reset

**What:** Extend existing stats (lines 631–714) with per-model token/cost breakdown and a `/anthropic stats reset` subcommand. The existing infrastructure is already accumulating aggregate metrics; this task adds the per-model dimension.

**Files to modify:**

- `index.mjs` — `sessionMetrics` declaration at line 3210; stats display in `handleAnthropicSlashCommand()` at line ~631; usage accumulation at lines ~2618+

**Changes to existing functions:**

- `handleAnthropicSlashCommand()` — add `stats reset` branch
- Usage accumulation in fetch interceptor — also write to per-model map

**New session state fields:**

```js
sessionMetrics.perModel = {}; // Map<modelId, { input, output, cacheRead, cacheWrite, costUsd }>
sessionMetrics.lastModelId = null;
```

**Implementation steps:**

1. [tier:fast] Read lines 2618–2650 to understand where usage fields are accumulated into `sessionMetrics`
2. [tier:medium] Add `perModel: {}` and `lastModelId: null` to `sessionMetrics` at line 3210
3. [tier:medium] In the usage accumulation block, also write to `sessionMetrics.perModel[modelId]` — creating an entry if absent
4. [tier:medium] In the stats display (line ~631), after aggregate section, add per-model breakdown block only when `Object.keys(sessionMetrics.perModel).length > 1` (suppress when only one model used)
5. [tier:medium] Add `stats reset` subcommand in `handleAnthropicSlashCommand()` near line 523:
   ```
   /anthropic stats reset → zero out sessionMetrics, show "Stats reset." toast
   ```
6. [tier:medium] Add `lines_changed` tracking: read `file_write`/`file_edit` tool result counts from the request body in the fetch interceptor, accumulate into `sessionMetrics.linesChanged`

**Tests:**

- [ ] [tier:medium] T2.1.1: After two requests with different models, `perModel` has two entries
- [ ] [tier:medium] T2.1.2: Per-model cost is calculated correctly using pricing table
- [ ] [tier:medium] T2.1.3: `/anthropic stats reset` zeroes all `sessionMetrics` fields
- [ ] [tier:medium] T2.1.4: Per-model section suppressed when only one model has been used
- [ ] [tier:medium] T2.1.5: Unknown model uses Sonnet 4.6 pricing as fallback
- [ ] [tier:medium] T2.1.6: Stats display includes session duration in minutes
- [ ] [tier:medium] T2.1.7: `linesChanged` increments per file_write/file_edit tool result

---

#### Task 2.2 (A5): `/anthropic context` Command

**What:** New slash command that analyzes the most-recently-captured request body to show token breakdown by message role, identify expensive tool_result blocks by tool name, and detect duplicate file contents.

**Files to modify:**

- `index.mjs` — `handleAnthropicSlashCommand()` at line 523; add session state to capture last request body

**New session state:**

- `sessionMetrics.lastRequestBody` — stores the last intercepted request body (JSON string, capped at 2MB)

**New functions:**

- `analyzeRequestContext(requestBody)` — returns context breakdown object

**Implementation steps:**

1. [tier:fast] Identify where the raw request body is available in the fetch interceptor (before send)
2. [tier:medium] In the fetch interceptor, store `sessionMetrics.lastRequestBody = bodyStr.slice(0, 2_000_000)` (2MB cap) before sending
3. [tier:medium] Implement `analyzeRequestContext(bodyStr)`:
   - Parse JSON
   - Count tokens per role: system, user, assistant, tool_result (use `estimatePromptTokens()` at line ~3250 on each block)
   - Extract tool_result blocks: group by `tool_name`, sum token estimates
   - Detect duplicates: hash content blocks with `crypto.createHash('sha256')`, flag any hash seen 2+ times
   - Return structured object
4. [tier:medium] Add `context` subcommand to `handleAnthropicSlashCommand()`:
   - If no `lastRequestBody`, show "No request captured yet."
   - Otherwise render the breakdown as a toast
5. [tier:medium] Format output:
   ```
   Context Breakdown (estimated)
   System:          12,400 tokens
   User messages:    8,200 tokens
     tool_result:    6,100 tokens
       read_file:    3,200 tokens  (3 blocks)
       bash:         2,900 tokens  (2 blocks)
   Assistant:        5,100 tokens
   Total:           25,700 tokens
   ⚠ 2 duplicate file contents detected (~1,600 tokens wasted)
   ```

**Tests:**

- [ ] [tier:medium] T2.2.1: `analyzeRequestContext()` correctly counts tokens per role
- [ ] [tier:medium] T2.2.2: Tool results grouped by `tool_name` with token sums
- [ ] [tier:medium] T2.2.3: Duplicate detection fires when same content appears in 2+ tool_result blocks
- [ ] [tier:medium] T2.2.4: No duplicate false-positive for different content with same length
- [ ] [tier:medium] T2.2.5: Empty/missing body returns "No request captured yet."
- [ ] [tier:medium] T2.2.6: Malformed JSON body handled gracefully (no crash)

---

#### Task 2.3 (A3): Cache Break Detection

**What:** Two-phase system: (1) Pre-call: hash system prompt + tool schemas; (2) Post-call: if `cache_read_input_tokens` drops >2,000 tokens vs previous turn, fire alert toast identifying which source changed.

**Files to modify:**

- `index.mjs` — fetch interceptor pre-send (hash capture) and post-response (compare); session state

**New session state:**

```js
const cacheBreakState = {
  enabled: true,
  prevCacheRead: 0,
  sourceHashes: new Map(), // source_id → hash (LRU, max 10)
  alertThreshold: 2_000,
};
```

**New functions:**

- `hashCacheSource(content)` — `crypto.createHash('sha256').update(content).digest('hex').slice(0,16)`
- `detectCacheBreak(requestBody, cacheReadTokens)` — returns changed source IDs or null

**Implementation steps:**

1. [tier:fast] Read existing `adaptiveContextState` at line ~3235 and `message_start` event handling in the fetch interceptor to understand where `cache_read_input_tokens` is available
2. [tier:medium] Add `cacheBreakState` object near `adaptiveContextState` at line ~3235
3. [tier:medium] Pre-call: extract system prompt blocks + tool schemas from request body; hash each; store in `cacheBreakState.sourceHashes` with LRU eviction at 10 entries
4. [tier:medium] Post-call (after `cache_read_input_tokens` available from `message_start` event):
   - Compare against `cacheBreakState.prevCacheRead`
   - If drop > `alertThreshold`, call `detectCacheBreak()` to identify changed sources
   - Fire toast: "Cache break detected: tool schema for `<tool_name>` changed (−2,400 tokens)"
5. [tier:medium] Reset `prevCacheRead` and source hashes on context compaction signal (detect via the compaction marker in `transformRequestBody()`)
6. [tier:medium] Add config to `lib/config.mjs`:
   ```js
   cache_break_detection: {
     enabled: true,
     alert_threshold: 2_000,
   }
   ```

**Tests:**

- [ ] [tier:medium] T2.3.1: Hash computed for system prompt block before each request
- [ ] [tier:medium] T2.3.2: Alert fires when `cache_read_input_tokens` drops by >2,000 vs prior turn
- [ ] [tier:medium] T2.3.3: No alert when drop is ≤2,000 (below threshold)
- [ ] [tier:medium] T2.3.4: Changed tool schema identified by name in alert message
- [ ] [tier:medium] T2.3.5: Source hash map never exceeds 10 entries (LRU eviction)
- [ ] [tier:medium] T2.3.6: State resets after compaction event
- [ ] [tier:medium] T2.3.7: `cache_break_detection.enabled: false` → no hashing, no alerts

---

#### Phase 2 — New Tests Summary

> [tier:medium] All Phase 2 tests are written and run by the medium-tier agent.

| Task              | Tests         | Subtotal |
| ----------------- | ------------- | -------- |
| A4 stats          | T2.1.1–T2.1.7 | 7        |
| A5 context        | T2.2.1–T2.2.6 | 6        |
| A3 cache break    | T2.3.1–T2.3.7 | 7        |
| **Phase 2 total** |               | **20**   |

#### Phase 2 Acceptance Criteria

- [ ] [tier:fast] `/anthropic stats reset` zeroes session metrics correctly
- [ ] [tier:fast] `/anthropic context` renders without error on a real request body
- [ ] [tier:medium] Cache break alert fires in test when system prompt changes between turns

#### Phase 2 Definition of Done

- [ ] [tier:medium] All 3 tasks code-complete and tested
- [ ] [tier:fast] `sessionMetrics` JSDoc type comment updated with new fields
- [ ] [tier:heavy] No extra memory allocation in the hot path (pre-call hashing deferred until after interceptor decision)

#### Phase 2 Senior QA Review

> [tier:heavy] Senior QA review for Phase 2.

- Verify `lastRequestBody` 2MB cap doesn't silently corrupt context analysis for very large requests
- Confirm `analyzeRequestContext()` handles streaming requests (where body is already sent) correctly
- Confirm cache break detection doesn't generate false positives on the first turn of a session (no prior baseline)
- Verify LRU eviction logic in `cacheBreakState.sourceHashes` is correct under concurrent requests

---

### Phase 3: Cost & Context Optimization (Wave 3)

**Goal:** Behavioral features that reduce token cost and API pressure based on observed data from Phase 2.
**Duration:** ~10 hours
**Dependencies:** Phase 2 complete; Phase 0 pre-flight results for A6 (usage endpoint) and A7 (betas)

#### Pre-flight Check (Phase 3)

- [ ] [tier:medium] Phase 2 `npm test` passed with 0 failures (542+ tests)
- [ ] [tier:fast] `PREFLIGHT_OAUTH_USAGE` documented from Phase 0
- [ ] [tier:fast] `PREFLIGHT_CLEAR_TOOL_USES` and `PREFLIGHT_CLEAR_THINKING` documented from Phase 0
- [ ] [tier:fast] Phase 2 session metrics accumulating accurately (manual verification)

---

#### Task 3.1 (A6): Rate Limit Awareness & OAuth Usage Polling

**What:** Periodically poll `/api/oauth/usage` for session/weekly utilization windows. Show progressive warnings (75%/50%/25% remaining). Display in `/anthropic stats`.

**Note:** `sessionMetrics.lastQuota` already exists (line 3221) and is populated from response headers (lines 2618–2621). This task adds the active polling via the usage endpoint.

**Files to modify:**

- `index.mjs` — new `pollOAuthUsage()` function; call site in fetch interceptor post-response

**New functions:**

- `pollOAuthUsage(config, oauthToken)` — async, fires every 10 requests or 5 minutes
- `computeQuotaWarningLevel(quota)` — returns `"danger" | "warning" | "caution" | null`

**Implementation steps:**

1. [tier:fast] Read `sessionMetrics.lastQuota` declaration at line 3221 and population at lines 2618–2621
2. [tier:medium] Extend `sessionMetrics.lastQuota` with usage-endpoint fields:
   ```js
   lastQuota: {
     tokens: 0, requests: 0, inputTokens: 0, updatedAt: 0, // existing (from headers)
     session: { used: 0, limit: 0, reset_at: null }, // new (from /api/oauth/usage)
     weekly: { used: 0, limit: 0, reset_at: null },  // new
     lastPollAt: 0, // timestamp of last usage endpoint poll
   }
   ```
3. [tier:medium] Implement `pollOAuthUsage(config, getToken)`:
   - `getToken()` — async callback to get current OAuth token without importing account logic
   - `GET /api/oauth/usage` with Bearer token
   - Parse response per `PREFLIGHT_OAUTH_USAGE.schema`
   - Write to `sessionMetrics.lastQuota.session` and `.weekly`
   - Set `lastPollAt = Date.now()`
   - If non-2xx: log debug, don't throw
4. [tier:medium] Polling trigger in fetch interceptor post-response:
   ```js
   const shouldPoll = sessionMetrics.turns % 10 === 0 || Date.now() - sessionMetrics.lastQuota.lastPollAt > 5 * 60_000;
   if (shouldPoll) pollOAuthUsage(config, getToken).catch(() => {}); // fire-and-forget
   ```
5. [tier:medium] After each poll, call `checkAndWarnQuota(config)`:
   - > 75% remaining: no action
   - ≤75% remaining (25% used): caution toast, once per session
   - ≤50% remaining: warning toast
   - ≤25% remaining: danger toast, repeat every 5 requests
6. [tier:medium] In stats display (line ~698), update the quota block to show session/weekly from usage endpoint when available

**Tests:**

- [ ] [tier:medium] T3.1.1: Poll triggered after every 10th request (`turns % 10 === 0`)
- [ ] [tier:medium] T3.1.2: Poll triggered after 5 minutes since last poll regardless of request count
- [ ] [tier:medium] T3.1.3: No poll when `PREFLIGHT_OAUTH_USAGE === "not_found"` (feature gate)
- [ ] [tier:medium] T3.1.4: Danger toast fires when ≤25% remaining
- [ ] [tier:medium] T3.1.5: Warning toast fires when ≤50% remaining
- [ ] [tier:medium] T3.1.6: Caution toast fires once when ≤75% remaining (deduplicated)
- [ ] [tier:medium] T3.1.7: Non-2xx response from usage endpoint does not throw or block main flow

---

#### Task 3.2 (A8): Foreground/Background Request Classification

**What:** Tag requests as `foreground` (user-initiated turns) vs `background` (title generation, speculation). Background requests get reduced retry budget (no 529 retry, max 1 retry attempt) and shorter timeout.

**Note:** The "foreground/idle" terminology already exists for token refresh (lines 139, 1906, 1909). This task adds a parallel classification for the API request path.

**Files to modify:**

- `index.mjs` — fetch interceptor retry logic at line ~2272; new classification function
- `lib/config.mjs` — add `request_classification` config section

**New functions:**

- `classifyApiRequest(body, url)` — returns `"foreground" | "background"`

**Implementation steps:**

1. [tier:fast] Study the patterns of title-generation and speculation requests sent by OpenCode (look for short context, specific system prompt patterns, `max_tokens` ≤ 256)
2. [tier:medium] Implement `classifyApiRequest(body)`:
   ```js
   function classifyApiRequest(body) {
     // Background signals: very short context, no tools, very small max_tokens
     const msgCount = body.messages?.length ?? 0;
     const maxToks = body.max_tokens ?? 99999;
     const hasTitleSignal = body.system?.some(
       (b) => typeof b.text === "string" && b.text.includes("Generate a short title"),
     );
     if (hasTitleSignal || (msgCount <= 2 && maxToks <= 256)) return "background";
     return "foreground";
   }
   ```
3. [tier:medium] In fetch interceptor at line ~2272, classify request before retry loop:
   ```js
   const requestClass = classifyApiRequest(parsedBody);
   const maxServiceRetries = requestClass === "background" ? 0 : 2; // no 529 retry for bg
   const maxShouldRetries = requestClass === "background" ? 1 : 3;
   ```
4. [tier:medium] Use `maxServiceRetries` / `maxShouldRetries` in place of hardcoded values in retry loop
5. [tier:medium] Add config:
   ```js
   request_classification: {
     enabled: true,
     background_max_service_retries: 0,
     background_max_should_retries: 1,
   }
   ```

**Tests:**

- [ ] [tier:medium] T3.2.1: Request with title generation system prompt classified as `background`
- [ ] [tier:medium] T3.2.2: Request with `max_tokens <= 256` and `messages.length <= 2` classified as `background`
- [ ] [tier:medium] T3.2.3: Normal multi-turn request classified as `foreground`
- [ ] [tier:medium] T3.2.4: Background request gets 0 service-wide retries (no 529 retry)
- [ ] [tier:medium] T3.2.5: Background request gets max 1 `x-should-retry` retry
- [ ] [tier:medium] T3.2.6: `request_classification.enabled: false` → all requests use foreground retry budget

---

#### Task 3.3 (A9): Token Budget Parsing & Enforcement

**What:** Parse natural-language budget expressions from user messages (+500k, "use 2M tokens", "spend 500k"). Track accumulated output tokens. Stop at 90% (COMPLETION_THRESHOLD). Detect diminishing returns: ≥3 continuations + <500 token delta → stop. Inject budget status into system prompt.

**Files to modify:**

- `index.mjs` — `transformRequestBody()` at line ~4851; new budget parser function; session state extension

**New functions:**

- `parseNaturalLanguageBudget(messages)` — scan user messages for budget expressions
- `injectTokenBudgetBlock(systemBlocks, budget)` — prepend/append budget status block
- `detectDiminishingReturns(outputHistory)` — returns bool

**New session state:**

```js
sessionMetrics.tokenBudget = {
  limit: 0, // 0 = unset
  used: 0, // accumulated output tokens
  continuations: 0,
  outputHistory: [], // last 5 output token deltas
};
```

**Implementation steps:**

1. [tier:heavy] Design the budget expression parser — must handle: `+500k`, `500,000`, `2M`, `2 million`, `"spend 500k"`, `"use 2M tokens"`, `"budget: 1M"`:
   ```js
   function parseNaturalLanguageBudget(messages) {
     const patterns = [
       /\+\s*(\d[\d,]*)\s*k\b/i, // +500k
       /\buse\s+(\d[\d,]*)\s*[mk]?\s*tokens?\b/i,
       /\bspend\s+(\d[\d,]*)\s*[mk]?\b/i,
       /\bbudget[:\s]+(\d[\d,]*)\s*[mk]?\b/i,
     ];
     // ... parse, normalize to absolute token count
   }
   ```
2. [tier:heavy] In `transformRequestBody()`, scan the last user message for budget expressions; if found, update `sessionMetrics.tokenBudget.limit`
3. [tier:heavy] If budget is set, inject a system prompt text block:
   `"Token budget: {used}/{total} tokens used. Stop generating at {threshold} tokens."`
4. [tier:heavy] After each response, add output tokens to `sessionMetrics.tokenBudget.used`; check completion threshold (90%); if exceeded, inject a stop signal (set `max_tokens: 1` on next request as a soft stop) — log warning
5. [tier:heavy] Diminishing returns detection: if `continuations >= 3` AND `outputHistory` shows 3 consecutive deltas < 500 tokens, log "Diminishing returns detected, budget stop recommended"
6. [tier:medium] Add config:
   ```js
   token_budget: {
     enabled: false,
     default: 0,
     completion_threshold: 0.9,
   }
   ```

**Tests:**

- [ ] [tier:medium] T3.3.1: `"+500k"` parsed as 500,000 tokens
- [ ] [tier:medium] T3.3.2: `"use 2M tokens"` parsed as 2,000,000 tokens
- [ ] [tier:medium] T3.3.3: `"spend 500k"` parsed as 500,000 tokens
- [ ] [tier:medium] T3.3.4: Budget status injected into system prompt when limit is set
- [ ] [tier:medium] T3.3.5: Stop signal fired at 90% of limit
- [ ] [tier:medium] T3.3.6: Diminishing returns detected after 3 continuations with <500 token delta
- [ ] [tier:medium] T3.3.7: `token_budget.enabled: false` → no parsing, no injection
- [ ] [tier:medium] T3.3.8: `token_budget.default: 500000` sets budget without user message

---

#### Task 3.4 (A7): Microcompact — Selective Context Trimming

**What:** When approaching context limits (>80% of estimated window), inject `clear_tool_uses_20250919` and `clear_thinking_20251015` betas to request server-side clearing of old tool results and thinking content. Middle ground before full compaction.

**Prerequisite:** `PREFLIGHT_CLEAR_TOOL_USES === "accepted"` AND `PREFLIGHT_CLEAR_THINKING === "accepted"`

**Files to modify:**

- `index.mjs` — `buildAnthropicBetaHeader()` at line ~4454; fetch interceptor thinking-clear logic near line 4893; session state

**New functions:**

- `shouldMicrocompact(estimatedTokens, config)` — threshold check
- `buildMicrocompactBetas(config, idleMs)` — returns array of context-clearing betas to add

**New session state:**

```js
const microcompactState = {
  active: false,
  lastThinkingClearAt: 0, // timestamp of last thinking clear
};
```

**Implementation steps:**

1. [tier:fast] Read `buildAnthropicBetaHeader()` at line ~4454 and the thinking-clear logic at line ~4893
2. [tier:heavy] Implement `shouldMicrocompact(estimatedTokens, windowSize, config)`:
   - Returns `true` when `estimatedTokens / windowSize > config.microcompact.threshold_percent / 100`
   - `windowSize` from model config (1M for opus-4-6, 200K for sonnet-4-6, etc.)
3. [tier:heavy] Implement `buildMicrocompactBetas(config, idleMs)`:
   - If `PREFLIGHT_CLEAR_TOOL_USES === "accepted"`: include `clear_tool_uses_20250919`
   - If `PREFLIGHT_CLEAR_THINKING === "accepted"` AND (`idleMs > 3_600_000` OR microcompact active > 2 turns): include `clear_thinking_20251015`
   - Returns array of betas to add
4. [tier:heavy] In `buildAnthropicBetaHeader()`, call `shouldMicrocompact()` using `estimatePromptTokens()` at line ~3250; if true, merge microcompact betas into the beta array
5. [tier:medium] Update `microcompactState.active` and set `microcompactState.lastThinkingClearAt` when thinking clear beta is included
6. [tier:medium] Clear `microcompactState.active` when context compaction resets the session
7. [tier:medium] Add config:
   ```js
   microcompact: {
     enabled: true,
     threshold_percent: 80,
   }
   ```

**Tests:**

- [ ] [tier:medium] T3.4.1: `clear_tool_uses_20250919` beta added when >80% window used
- [ ] [tier:medium] T3.4.2: `clear_thinking_20251015` beta added when idle >1h
- [ ] [tier:medium] T3.4.3: Neither beta added when <80% window used
- [ ] [tier:medium] T3.4.4: Feature fully gated: when `PREFLIGHT_CLEAR_TOOL_USES === "rejected"`, no beta added
- [ ] [tier:medium] T3.4.5: `microcompact.enabled: false` → no betas added regardless of window usage
- [ ] [tier:medium] T3.4.6: `microcompact.threshold_percent: 90` changes the trigger point
- [ ] [tier:medium] T3.4.7: `microcompactState.active` resets after compaction event
- [ ] [tier:medium] T3.4.8: Thinking clear beta not added twice in consecutive turns (idempotent)

---

#### Phase 3 — New Tests Summary

> [tier:medium] All Phase 3 tests are written and run by the medium-tier agent.

| Task                    | Tests         | Subtotal |
| ----------------------- | ------------- | -------- |
| A6 rate limit           | T3.1.1–T3.1.7 | 7        |
| A8 fg/bg classification | T3.2.1–T3.2.6 | 6        |
| A9 token budget         | T3.3.1–T3.3.8 | 8        |
| A7 microcompact         | T3.4.1–T3.4.8 | 8        |
| **Phase 3 total**       |               | **29**   |

#### Phase 3 Acceptance Criteria

- [ ] [tier:medium] Rate limit toast fires at ≤25% remaining (verified with mock usage response)
- [ ] [tier:fast] Background requests confirmed to receive `maxServiceRetries = 0` in interceptor
- [ ] [tier:medium] Token budget `+500k` parsed and system prompt injected in test harness
- [ ] [tier:medium] Microcompact betas appear in `anthropic-beta` header when window >80% (mock token estimate)

#### Phase 3 Definition of Done

- [ ] [tier:medium] All 4 tasks code-complete and tested
- [ ] [tier:medium] `npm test` passes (557+ tests — prior 543 + 29 new phase-3 + 14 phase-1 + 20 phase-2 = 606 total, less ~3 pre-flight = 603 new + existing)
- [ ] [tier:fast] Microcompact pre-flight gate respected: if `PREFLIGHT_CLEAR_TOOL_USES === "rejected"`, feature disabled automatically with log message
- [ ] [tier:fast] No system-prompt modifications without explicit config enable (`token_budget.enabled: true`)

#### Phase 3 Senior QA Review

> [tier:heavy] Senior QA review for Phase 3.

- Verify A9 budget injection does not conflict with A3 cache break detection (injecting a new block changes the system prompt hash every turn → would generate false cache break alerts). Fix: exclude the budget injection block from cache break hashing.
- Verify A7 microcompact does not interact with A2 overflow recovery (adding betas doesn't change `max_tokens` arithmetic)
- Verify A8 classification does not mis-classify agentic sub-agent requests as background (tool-using requests should always be foreground)
- Confirm A6 polling is truly fire-and-forget (non-2xx does not block subsequent requests)
- Memory check: `sessionMetrics.tokenBudget.outputHistory` is capped at 5 entries

---

### Phase 4: Senior QA Review (Wave 4)

**Goal:** Cross-feature integration audit, edge case validation, performance regression baseline, and documentation update.
**Duration:** ~4 hours
**Dependencies:** All previous phases complete

#### Pre-flight Check (Phase 4)

- [ ] [tier:medium] `npm test` passes with all new tests from phases 1–3 green
- [ ] [tier:fast] No `console.error` spam in normal operation (manual run check)
- [ ] [tier:medium] `npm run test:conformance` passes (zero regression on existing conformance suite)

---

#### Task 4.1: Cross-Feature Integration Testing

**Scope:** Verify that features A1–A10 interact correctly under real session patterns.

1. [tier:heavy] **A2 + A10 interaction:** When A2 overflow recovery fires, the `max_tokens` it computes (`limit - input - 1000`) must respect A10's default cap. If `limit - input - 1000 < 8000`, use the computed value; if `> 8000`, clamp to `8000` to avoid wasting the output slot. Add test.
2. [tier:heavy] **A3 + A9 interaction:** Token budget injection adds a system prompt block each turn → changes system prompt hash → triggers false cache break alerts. Fix: exclude the budget block from `cacheBreakState.sourceHashes`. Add test verifying no false alert when only budget block changes.
3. [tier:heavy] **A7 + A4 interaction:** When microcompact betas are active, `sessionMetrics.perModel` stats still accumulate correctly (microcompact doesn't clear stats). Add test.
4. [tier:heavy] **A6 + A8 interaction:** Usage polls triggered by background requests should not count toward the 10-request poll interval. Add test verifying poll interval counts foreground turns only.
5. [tier:heavy] **A1 + slow network:** Preconnect timeout (10s) must not hold any lock that delays the first real request. Add test verifying first request proceeds immediately even if preconnect is pending.
6. [tier:heavy] **Session lifecycle:** All session state correctly zeroed on a new session/compaction signal. Add test covering: `microcompactState`, `cacheBreakState`, `sessionMetrics.tokenBudget`, `sessionMetrics.lastStopReason`.

**Tests:**

- [ ] [tier:heavy] T4.1.1: A2 + A10: overflow recovery `max_tokens` capped at output_cap default
- [ ] [tier:heavy] T4.1.2: A3 + A9: budget block change does not trigger cache break alert
- [ ] [tier:medium] T4.1.3: A6 poll interval counts foreground turns only
- [ ] [tier:fast] T4.1.4: A1: slow preconnect does not delay first real request
- [ ] [tier:medium] T4.1.5: Session reset zeroes all new state fields
- [ ] [tier:heavy] T4.1.6: Full mock session: 20 turns, stats accurate at end

---

#### Task 4.2: Edge Case & Error Path Validation

1. [tier:heavy] Empty request bodies at each feature boundary
2. [tier:heavy] Malformed API responses (missing `usage` field, missing `stop_reason`)
3. [tier:heavy] Concurrent requests: `cacheBreakState` and `microcompactState` are module-level singletons — verify concurrent request doesn't corrupt state (two simultaneous requests should both read the same state snapshot, not write-conflict)
4. [tier:heavy] Config disabled states: every feature individually disabled produces identical behavior to pre-plan baseline

---

#### Task 4.3: Performance Regression Testing

1. [tier:medium] Benchmark `transformRequestBody()` before and after changes: must add < 5ms per request
2. [tier:medium] Benchmark `buildAnthropicBetaHeader()` with microcompact path active
3. [tier:medium] Verify `analyzeRequestContext()` (A5) is not called on every request — only on `/anthropic context` command invocation
4. [tier:medium] Verify `hashCacheSource()` (A3) uses lazy evaluation: only hashes when cache break detection is enabled

---

#### Task 4.4: Documentation Audit

1. [tier:fast] Update `README.md` with new config keys: `preconnect`, `output_cap`, `overflow_recovery`, `cache_break_detection`, `request_classification`, `token_budget`, `microcompact`
2. [tier:fast] Update `lib/config.mjs` JSDoc types for all new config sections
3. [tier:fast] Add new features to CHANGELOG.md under next version heading
4. [tier:fast] Verify `docs/mimese-http-header-system-prompt.md` is not impacted (none of Plan A's features change headers or system prompt structure, only request body optimization)

---

#### Phase 4 — New Tests Summary

> [tier:medium] All Phase 4 tests are written and run by the medium-tier agent.

| Task                       | Tests         | Subtotal                              |
| -------------------------- | ------------- | ------------------------------------- |
| Integration                | T4.1.1–T4.1.6 | 6                                     |
| Edge cases (counted above) | —             | 0 (covered by existing test patterns) |
| **Phase 4 total**          |               | **6**                                 |

#### Phase 4 Acceptance Criteria

- [ ] [tier:medium] All 6 integration tests pass
- [ ] [tier:medium] `npm test` passes with complete new test suite (prior 543 + ~75 new = ~618 total)
- [ ] [tier:medium] `npm run test:conformance` passes (40 conformance tests unchanged)
- [ ] [tier:fast] `README.md` documents all 10 new config sections

#### Phase 4 Definition of Done

- [ ] [tier:medium] All 4 tasks complete
- [ ] [tier:fast] No TODO comments left in new code
- [ ] [tier:fast] No `console.log` debug statements left in production paths
- [ ] [tier:fast] CHANGELOG.md updated

#### Phase 4 Senior QA Review

> [tier:heavy] Senior QA review for Phase 4.

- Final check: does any Plan A feature change the `anthropic-beta` header composition in a way that conflicts with Plan B (implementation-plan-v2.md) beta management? Answer must be documented.
- Confirm `clear_tool_uses_20250919` and `clear_thinking_20251015` (A7) are added to the always-on beta set gating in `buildAnthropicBetaHeader()` at line ~4454, not to the `ALWAYS_ON_BETAS` constant (since they are microcompact-specific, not always-on).
- Verify that all new config sections in `lib/config.mjs` are included in the deep-clone in `createDefaultConfig()` at line ~193.

---

## 5. Global Acceptance Criteria

- [ ] [tier:heavy] All 10 features (A1–A10) implemented and tested
- [ ] [tier:medium] `npm test` passes: ~618 total tests (543 existing + ~75 new), 0 failures
- [ ] [tier:medium] `npm run test:conformance` passes: 40 conformance tests unchanged
- [ ] [tier:medium] `lib/config.test.mjs`: 42 existing tests pass + new tests for each new config section
- [ ] [tier:heavy] Every new feature has a config toggle that, when set to `false`/`0`/disabled, produces **identical behavior** to the pre-plan baseline
- [ ] [tier:fast] No new npm runtime dependencies
- [ ] [tier:fast] No TypeScript `@ts-ignore` or `as any` suppressions
- [ ] [tier:fast] `README.md` documents all new config keys with examples
- [ ] [tier:fast] Phase 0 `preflight-results-plan-a.md` completed and committed

---

## 6. Global Definition of Done

A **task** is Done when:

1. **Code complete:** Matches specification in this plan
2. **Tests written:** All tests for the task are green (`npm test`)
3. **Config documented:** JSDoc types updated in `lib/config.mjs` for any new config key
4. **No regression:** `npm run test:conformance` still passes
5. **Pre-flight honored:** Features gated by `PREFLIGHT_*` values check before activating
6. **No side effects on disable:** Feature disabled = identical behavior to pre-plan state

A **phase** is Done when all tasks are Done AND phase acceptance criteria are met.

The **plan** is Done when all phases are Done AND global acceptance criteria are met.

---

## 7. Global Senior QA Review

> [tier:heavy] Global QA review — all items reviewed by the heavy-tier agent.

A senior QA engineer should verify:

### Session Lifecycle

- [ ] [tier:heavy] **Init → Requests → Compaction → Reset:** All new state fields (`microcompactState`, `cacheBreakState`, `sessionMetrics.tokenBudget`, `sessionMetrics.lastStopReason`, `sessionMetrics.lastRequestBody`) are correctly zeroed or reset on session compaction
- [ ] [tier:heavy] **Multi-session:** Plugin used for 2+ consecutive OpenCode sessions — state does not leak between sessions

### Cross-Feature Interactions

- [ ] [tier:heavy] A2 + A10 (overflow + output cap): reviewed and tested (T4.1.1)
- [ ] [tier:heavy] A3 + A9 (cache break + budget injection): false-positive mitigation implemented and tested (T4.1.2)
- [ ] [tier:heavy] A6 + A8 (rate limit polling + fg/bg classification): poll interval foreground-only (T4.1.3)
- [ ] [tier:heavy] A7 + existing `buildAnthropicBetaHeader()`: microcompact betas appended correctly, not duplicated

### Error Recovery Paths

- [ ] [tier:heavy] A2 overflow recovery: verify the overflow-retry does NOT also trigger the adaptive context escalation path (A2 and adaptive context are separate retry reasons at line ~2719)
- [ ] [tier:heavy] A6 usage endpoint non-2xx: no request blocking, no unhandled rejection
- [ ] [tier:heavy] A7 with rejected preflight: graceful fallback, no beta injected, feature logs once and stays quiet

### Config Backward Compatibility

- [ ] [tier:fast] No existing config keys renamed or removed
- [ ] [tier:fast] All new config sections have defaults in `DEFAULT_CONFIG`
- [ ] [tier:fast] `createDefaultConfig()` at line ~193 deep-clones all new sections
- [ ] [tier:fast] Users with old config files (missing new sections) get defaults merged in correctly

### Performance

- [ ] [tier:fast] Preconnect (A1): confirmed fire-and-forget, no await
- [ ] [tier:fast] Cache break hashing (A3): lazy, only when enabled, not in critical path
- [ ] [tier:fast] Context analysis (A5): on-demand only, not per-request
- [ ] [tier:fast] Budget parser (A9): scans only the last user message, not all history

### Memory Leak Potential (Long Sessions)

- [ ] [tier:fast] `cacheBreakState.sourceHashes`: LRU capped at 10 entries
- [ ] [tier:fast] `sessionMetrics.lastRequestBody`: capped at 2MB
- [ ] [tier:fast] `sessionMetrics.tokenBudget.outputHistory`: capped at 5 entries
- [ ] [tier:fast] `sessionMetrics.perModel`: grows by unique model count (bounded in practice to 2–3 models)
- [ ] [tier:fast] `microcompactState`: no unbounded growth

---

## 8. Rollback Strategy

### Per-Feature Config Toggles (Runtime Rollback)

| Feature                  | Config Toggle                                   | Effect When Disabled               |
| ------------------------ | ----------------------------------------------- | ---------------------------------- |
| A1 Preconnect            | `preconnect.enabled: false`                     | No startup HEAD request            |
| A2 Overflow recovery     | `overflow_recovery.enabled: false`              | Errors surface normally            |
| A3 Cache break detection | `cache_break_detection.enabled: false`          | No hashing, no toasts              |
| A4 Stats extension       | (built-in, no toggle needed)                    | Use `/anthropic stats reset`       |
| A5 Context command       | (on-demand, no toggle needed)                   | Command returns "disabled"         |
| A6 Rate limit polling    | (gate: `PREFLIGHT_OAUTH_USAGE !== "not_found"`) | No polling                         |
| A7 Microcompact          | `microcompact.enabled: false`                   | No context-clearing betas          |
| A8 FG/BG classification  | `request_classification.enabled: false`         | All requests use foreground budget |
| A9 Token budget          | `token_budget.enabled: false`                   | No parsing, no injection           |
| A10 Output cap           | `output_cap.enabled: false`                     | Passthrough `max_tokens`           |

### Per-Phase Git Rollback

Each phase is independently deployable. Rollback by reverting the git commits for that phase:

- Phase 1 (A1, A2, A10): `git revert` Phase 1 commits
- Phase 2 (A3, A4, A5): `git revert` Phase 2 commits
- Phase 3 (A6, A7, A8, A9): `git revert` Phase 3 commits

### Full Rollback

```bash
npm install opencode-anthropic-fix@<previous_version>
```

All config toggles default to safe/off values for the new features, so a config file with new keys does not break an older plugin version — the keys are simply ignored.

---

## 9. Risk Register

| #   | Risk                                                                                  | Likelihood | Impact | Mitigation                                                                                                                              |
| --- | ------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `/api/oauth/usage` endpoint absent or format changes                                  | Medium     | Medium | Phase 0 validates. Feature gate: if endpoint returns non-2xx, A6 silently disabled.                                                     |
| R2  | `clear_tool_uses_20250919` beta rejected by API                                       | Medium     | Medium | Phase 0 validates. A7 skips beta if preflight shows rejected.                                                                           |
| R3  | `clear_thinking_20251015` beta rejected by API                                        | Medium     | Medium | Phase 0 validates. A7 partial: tool-use clearing still works even without thinking clearing.                                            |
| R4  | A2 overflow recovery triggers infinite loop                                           | Low        | High   | Single `overflowRetryAttempted` flag per request scope. Hard guard: never retry if already attempted.                                   |
| R5  | A10 output cap breaks caller-specified `max_tokens`                                   | Low        | High   | Caller-specified wins unconditionally: `if (body.max_tokens != null) return body.max_tokens`.                                           |
| R6  | A9 budget parser generates false positives on code with `+500k` patterns              | Medium     | Low    | Scope parser to last user message only. Require surrounding context ("budget", "use", "spend").                                         |
| R7  | A3 cache break detection generates noisy alerts                                       | Medium     | Medium | 2,000-token threshold (configurable). Debounce: max 1 alert per 5 turns.                                                                |
| R8  | A7 microcompact betas added to requests that don't support them (Haiku, older models) | Low        | Medium | Model allowlist: only inject for models with ≥200K context windows.                                                                     |
| R9  | A8 classification mis-tags user agentic turns as background                           | Medium     | Medium | Foreground classification is the safe default; only background if strong signals (title regex OR tiny max_tokens + very short context). |
| R10 | Memory accumulation in `sessionMetrics.perModel` over very long sessions              | Low        | Low    | Bounded by number of distinct models used (2–3 in practice). No fix needed.                                                             |
| R11 | A1 preconnect triggers corporate proxy/WAF alerts                                     | Low        | Medium | Skip on any proxy env var detection. `preconnect.enabled: false` config escape hatch.                                                   |

---

## Appendix A: Task Dependency Graph

```
Phase 0 (Pre-Flight)
  ├─ 0.1 HEAD to api.anthropic.com
  ├─ 0.2 /api/oauth/usage endpoint
  ├─ 0.3 clear_tool_uses beta
  ├─ 0.4 clear_thinking beta
  ├─ 0.5 context limit error format
  ├─ 0.6 proxy/mTLS detection
  └─ 0.7 document results (depends on 0.1-0.6)
       │
Phase 1 (Quick Wins) — depends on Phase 0
  ├─ 1.1 A1 preconnect (depends on 0.1, 0.6)
  ├─ 1.2 A10 output cap (depends on Phase 0 complete)
  └─ 1.3 A2 overflow recovery (depends on 0.5, and 1.2 for max_tokens logic)
       │
Phase 2 (Observability) — depends on Phase 1
  ├─ 2.1 A4 stats per-model (parallel with 2.2, 2.3)
  ├─ 2.2 A5 context command (parallel with 2.1, 2.3)
  └─ 2.3 A3 cache break detection (parallel with 2.1, 2.2)
       │
Phase 3 (Optimization) — depends on Phase 2
  ├─ 3.1 A6 rate limit (depends on 0.2 result, 2.1 for stats infra) ‖ 3.2
  ├─ 3.2 A8 fg/bg classification (depends on Phase 2) ‖ 3.1
  ├─ 3.3 A9 token budget (depends on 3.1 for cost awareness, 3.2 for class logic) →
  └─ 3.4 A7 microcompact (depends on 0.3, 0.4 preflight, 3.3 complete) →
       │
Phase 4 (QA) — depends on ALL above
  ├─ 4.1 cross-feature integration (parallel with 4.2, 4.3)
  ├─ 4.2 edge case validation (parallel with 4.1, 4.3)
  ├─ 4.3 performance regression (parallel with 4.1, 4.2)
  └─ 4.4 documentation audit (depends on 4.1-4.3)
```

---

## Appendix B: Files Impact Matrix

| File                                     | Phase 0 | Phase 1        | Phase 2        | Phase 3            | Phase 4 |
| ---------------------------------------- | ------- | -------------- | -------------- | ------------------ | ------- |
| `index.mjs`                              |         | ✏️ 1.1,1.2,1.3 | ✏️ 2.1,2.2,2.3 | ✏️ 3.1,3.2,3.3,3.4 | 🔍      |
| `lib/config.mjs`                         |         | ✏️ 1.2         |                | ✏️ 3.2,3.3,3.4     | 🔍      |
| `index.test.mjs`                         |         | ✏️             | ✏️             | ✏️                 | ✏️      |
| `lib/config.test.mjs`                    |         | ✏️             |                | ✏️                 | ✏️      |
| `test/conformance/regression.test.mjs`   |         | 🔍             | 🔍             | 🔍                 | 🔍      |
| `test/preflight/plan-a.mjs`              | ✏️ NEW  |                |                |                    |         |
| `docs/plans/preflight-results-plan-a.md` | ✏️ NEW  |                |                |                    |         |
| `README.md`                              |         |                |                |                    | ✏️ 4.4  |
| `CHANGELOG.md`                           |         |                |                |                    | ✏️ 4.4  |

Legend: ✏️ = Modified, 🔍 = Audited/Verified, NEW = Created

**Files NOT modified by Plan A:**

- `lib/oauth.mjs` — no OAuth flow changes
- `lib/accounts.mjs` — no account management changes
- `lib/rotation.mjs` — no rotation logic changes
- `lib/backoff.mjs` — no backoff changes
- `cli.mjs` — no CLI changes

---

## Appendix C: Test Coverage Matrix

| Phase     | Feature               | New Tests   | Running Total | Notes                  |
| --------- | --------------------- | ----------- | ------------- | ---------------------- |
| Baseline  | Existing suite        | 543         | 543           | 127 + 40 + 42 + others |
| 0         | Pre-flight validation | 3           | 546           | T0.1–T0.3              |
| 1         | A1 preconnect         | 3           | 549           | T1.1.1–T1.1.3          |
| 1         | A10 output cap        | 5           | 554           | T1.2.1–T1.2.5          |
| 1         | A2 overflow recovery  | 6           | 560           | T1.3.1–T1.3.6          |
| 2         | A4 stats              | 7           | 567           | T2.1.1–T2.1.7          |
| 2         | A5 context command    | 6           | 573           | T2.2.1–T2.2.6          |
| 2         | A3 cache break        | 7           | 580           | T2.3.1–T2.3.7          |
| 3         | A6 rate limits        | 7           | 587           | T3.1.1–T3.1.7          |
| 3         | A8 fg/bg class        | 6           | 593           | T3.2.1–T3.2.6          |
| 3         | A9 token budget       | 8           | 601           | T3.3.1–T3.3.8          |
| 3         | A7 microcompact       | 8           | 609           | T3.4.1–T3.4.8          |
| 4         | Integration           | 6           | 615           | T4.1.1–T4.1.6          |
| **Total** | **10 features**       | **~72 new** | **~615**      | Exceeds 60-80 target ✓ |

**Edge cases covered across all phases:**

- Empty/null request bodies (A2, A5, A9)
- Malformed JSON in error responses (A2)
- Missing `usage` fields in API response (A4, A6)
- Concurrent requests with shared state (A3, A7 — Phase 4)
- Config disabled state for every feature
- Session reset / compaction lifecycle
- First-turn baseline (no prior data for comparison — A3)

---

_Plan generated from analysis of `opencode-anthropic-fix` plugin internals._
_Reference: `index.mjs` (~5,143 lines), `lib/config.mjs` (646 lines), `index.test.mjs` (127 tests)._
_Plan ID: PLANA-2026-03-31. Version 1.0. Date: 2026-03-31._
