# Implementation Plan: Claude Code Signature Fidelity & Long-Session Optimization

**Plan ID:** `CCRF-2026-03-20`
**Version:** 3.0
**Status:** Draft → Reviewed → Amended → **Phases 1-6 Complete**
**Author:** Automated analysis of `@anthropic-ai/claude-code@2.1.80` vs `opencode-anthropic-fix`
**Reference:** `docs/claude-code-reverse-engineering.md` (Sections 1–15)
**Review:** Senior engineer review applied (16 corrections, 3 structural changes)

---

## Table of Contents

0. [Task Master List](#task-master-list) ← **Start here**
1. [Objective](#1-objective)
2. [Prerequisites](#2-prerequisites)
3. [Requisites](#3-requisites)
4. [Expected Outcome](#4-expected-outcome)
5. [Phases & Waves](#5-phases--waves)
   - [Phase 0: Pre-Flight Validation (Wave 0)](#phase-0-pre-flight-validation-wave-0)
   - [Phase 1: Critical Fixes (Wave 1)](#phase-1-critical-fixes-wave-1)
   - [Phase 2: High-Priority Fixes (Wave 2)](#phase-2-high-priority-fixes-wave-2)
   - [Phase 3: Medium-Priority Fixes (Wave 3)](#phase-3-medium-priority-fixes-wave-3)
   - [Phase 4: Token Optimization (Wave 4)](#phase-4-token-optimization-wave-4)
   - [Phase 5: Speed & Adaptive Intelligence (Wave 5)](#phase-5-speed--adaptive-intelligence-wave-5)
   - [Phase 6: Deep QA Review (Wave 6)](#phase-6-deep-qa-review-wave-6)
6. [Acceptance Criteria](#6-acceptance-criteria)
7. [Definition of Done](#7-definition-of-done)
8. [Rollback Strategy](#8-rollback-strategy)
9. [Risk Register](#9-risk-register)

---

## Task Master List

> Legend: `‖` = can run in parallel with adjacent tasks in the same group. `→` = sequential dependency. `⊘` = blocked until prerequisite completes. Duration is per-task estimated effort.
>
> **Tier Directives** (model delegation protocol):
> | Tier | Agent | Use For | Cost |
> |------|-------|---------|------|
> | `[tier:fast]` | Haiku 4.5 | Search, grep, read, lookup, validation, exists-check | 1x |
> | `[tier:medium]` | Sonnet 4.6 | Implementation, refactoring, tests, bugfix, config | 5x |
> | `[tier:heavy]` | Opus 4.6 | Architecture, security audit, privacy design, conformance review | 20x |
>
> Every numbered implementation step is prefixed with its tier. Mixed steps have been split. Multi-phase work: explore (`[tier:fast]`) → execute (`[tier:medium]`). Cheapest-first.

### Phase 0: Pre-Flight Validation (Wave 0) — 1-2h total

All pre-flight tasks are independent and can run in parallel except 0.7.

| #   | Task                                    | Tier          | Duration | Parallel          | Depends On | Files                             | Status  |
| --- | --------------------------------------- | ------------- | -------- | ----------------- | ---------- | --------------------------------- | ------- |
| 0.1 | Validate extended cache TTL (`1h`)      | `[tier:fast]` | 15 min   | ‖ 0.2-0.6         | —          | `test/preflight/`                 | Pending |
| 0.2 | Validate `betas` array in request body  | `[tier:fast]` | 15 min   | ‖ 0.1,0.3-0.6     | —          | `test/preflight/`                 | Pending |
| 0.3 | Validate `speed: "fast"` parameter      | `[tier:fast]` | 15 min   | ‖ 0.1-0.2,0.4-0.6 | —          | `test/preflight/`                 | Pending |
| 0.4 | Validate `{type: "adaptive"}` thinking  | `[tier:fast]` | 15 min   | ‖ 0.1-0.3,0.5-0.6 | —          | `test/preflight/`                 | Pending |
| 0.5 | Validate rate limit utilization headers | `[tier:fast]` | 15 min   | ‖ 0.1-0.4,0.6     | —          | `test/preflight/`                 | Pending |
| 0.6 | Validate telemetry endpoint access      | `[tier:fast]` | 15 min   | ‖ 0.1-0.5         | —          | `test/preflight/`                 | Pending |
| 0.7 | Document pre-flight results             | `[tier:fast]` | 30 min   | →                 | ⊘ 0.1-0.6  | `docs/plans/preflight-results.md` | Pending |

**Parallelism: 6 tasks run simultaneously, then 1 sequential.**

---

### Phase 1: Critical Fixes (Wave 1) — 3-4h total

Tasks 1.1-1.3 are independent. Task 1.4 is independent of 1.1-1.3 but informs 1.5.

| #   | Task                                               | Tier            | Duration | Parallel        | Depends On | Files                                            | Status  |
| --- | -------------------------------------------------- | --------------- | -------- | --------------- | ---------- | ------------------------------------------------ | ------- |
| 1.1 | Fix `metadata.user_id` format + migration          | `[tier:medium]` | 60 min   | ‖ 1.2, 1.3, 1.4 | ⊘ Phase 0  | `index.mjs`, `lib/storage.mjs`, `lib/config.mjs` | ✅ Done |
| 1.2 | Remove `anthropic-dangerous-direct-browser-access` | `[tier:medium]` | 10 min   | ‖ 1.1, 1.3, 1.4 | ⊘ Phase 0  | `index.mjs`                                      | ✅ Done |
| 1.3 | Fix OAuth scopes + `code=true` + refresh scope     | `[tier:medium]` | 45 min   | ‖ 1.1, 1.2, 1.4 | ⊘ Phase 0  | `lib/oauth.mjs`                                  | ✅ Done |
| 1.4 | Adaptive thinking for Opus/Sonnet 4.6              | `[tier:medium]` | 30 min   | ‖ 1.1, 1.2, 1.3 | ⊘ 0.4      | `index.mjs`                                      | ✅ Done |
| 1.5 | Fix temperature handling                           | `[tier:medium]` | 20 min   | →               | ⊘ 1.4      | `index.mjs`                                      | ✅ Done |

**Parallelism: 4 tasks run simultaneously (1.1 ‖ 1.2 ‖ 1.3 ‖ 1.4), then 1.5 sequential after 1.4.**

---

### Phase 2: High-Priority Fixes (Wave 2) — 3-5h total

Tasks 2.1-2.3 are independent. Task 2.4 depends on 2.1.

| #   | Task                                 | Tier            | Duration | Parallel   | Depends On | Files                        | Status  |
| --- | ------------------------------------ | --------------- | -------- | ---------- | ---------- | ---------------------------- | ------- |
| 2.1 | Fix beta composition (always-on set) | `[tier:medium]` | 60 min   | ‖ 2.2, 2.3 | ⊘ Phase 1  | `index.mjs`                  | ✅ Done |
| 2.2 | Fix User-Agent prefix (OAuth calls)  | `[tier:medium]` | 30 min   | ‖ 2.1, 2.3 | ⊘ Phase 1  | `lib/oauth.mjs`, `index.mjs` | ✅ Done |
| 2.3 | Fix `x-stainless-package-version`    | `[tier:medium]` | 30 min   | ‖ 2.1, 2.2 | ⊘ Phase 1  | `index.mjs`                  | ✅ Done |
| 2.4 | Add `betas` array to request body    | `[tier:medium]` | 30 min   | →          | ⊘ 0.2, 2.1 | `index.mjs`                  | ✅ Done |

**Parallelism: 3 tasks run simultaneously (2.1 ‖ 2.2 ‖ 2.3), then 2.4 sequential after 2.1.**

---

### Phase 3: Medium/Low-Priority Fixes (Wave 3) — 3-5h total

All 6 tasks are independent except 3.6 depends on 2.2.

| #   | Task                                     | Tier            | Duration | Parallel           | Depends On | Files                        | Status  |
| --- | ---------------------------------------- | --------------- | -------- | ------------------ | ---------- | ---------------------------- | ------- |
| 3.1 | Fix stainless OS casing (`macOS`)        | `[tier:medium]` | 10 min   | ‖ 3.2-3.5          | ⊘ Phase 2  | `index.mjs`                  | ✅ Done |
| 3.2 | Fix billing header (`cch`, model ID)     | `[tier:medium]` | 30 min   | ‖ 3.1, 3.3-3.5     | ⊘ Phase 2  | `index.mjs`                  | ✅ Done |
| 3.3 | Fix `x-stainless-helper` (tool manifest) | `[tier:medium]` | 30 min   | ‖ 3.1-3.2, 3.4-3.5 | ⊘ Phase 2  | `index.mjs`                  | ✅ Done |
| 3.4 | Add `x-stainless-timeout` (non-stream)   | `[tier:medium]` | 15 min   | ‖ 3.1-3.3, 3.5     | ⊘ Phase 2  | `index.mjs`                  | ✅ Done |
| 3.5 | Fix OAuth state parameter (independent)  | `[tier:medium]` | 20 min   | ‖ 3.1-3.4          | ⊘ Phase 2  | `lib/oauth.mjs`              | ✅ Done |
| 3.6 | Fix version staleness                    | `[tier:medium]` | 30 min   | ‖ 3.1-3.5          | ⊘ 2.2      | `lib/oauth.mjs`, `index.mjs` | ✅ Done |

**Parallelism: All 6 tasks can run simultaneously.**

---

### Phase 4: Token Optimization (Wave 4) — 6-8h total

Tasks 4.1, 4.4, 4.5 are independent. Task 4.2 can parallel 4.1. Task 4.3 depends on 4.1+4.2.

| #   | Task                                   | Tier            | Duration | Parallel        | Depends On | Files                         | Status  |
| --- | -------------------------------------- | --------------- | -------- | --------------- | ---------- | ----------------------------- | ------- |
| 4.1 | Extended cache TTL (1h, on by default) | `[tier:medium]` | 60 min   | ‖ 4.2, 4.4, 4.5 | ⊘ Phase 3  | `index.mjs`                   | ✅ Done |
| 4.2 | Fix system prompt cache scope          | `[tier:medium]` | 30 min   | ‖ 4.1, 4.4, 4.5 | ⊘ Phase 3  | `index.mjs`                   | ✅ Done |
| 4.3 | Dynamic boundary marker (opt-in)       | `[tier:heavy]`  | 60 min   | →               | ⊘ 4.1, 4.2 | `index.mjs`                   | ✅ Done |
| 4.4 | Cache hit rate tracking & reporting    | `[tier:medium]` | 45 min   | ‖ 4.1, 4.2, 4.5 | ⊘ Phase 3  | `index.mjs`                   | ✅ Done |
| 4.5 | Token budget awareness & cost tracking | `[tier:medium]` | 60 min   | ‖ 4.1, 4.2, 4.4 | ⊘ Phase 3  | `index.mjs`, `lib/config.mjs` | ✅ Done |

**Parallelism: 4 tasks run simultaneously (4.1 ‖ 4.2 ‖ 4.4 ‖ 4.5), then 4.3 sequential.**

---

### Phase 5: Speed & Adaptive Intelligence (Wave 5) — 8-10h total

Tasks 5.1 and 5.5 are independent. Task 5.2 informs 5.4. Task 5.3 is independent.

| #   | Task                                | Tier            | Duration | Parallel        | Depends On     | Files                                               | Status  |
| --- | ----------------------------------- | --------------- | -------- | --------------- | -------------- | --------------------------------------------------- | ------- |
| 5.1 | Fast mode toggle                    | `[tier:medium]` | 60 min   | ‖ 5.2, 5.3, 5.5 | ⊘ 0.3, Phase 4 | `index.mjs`, `lib/config.mjs`                       | ✅ Done |
| 5.2 | Proactive rate limit detection      | `[tier:medium]` | 90 min   | ‖ 5.1, 5.3, 5.5 | ⊘ 0.5, Phase 4 | `index.mjs`, `lib/accounts.mjs`, `lib/rotation.mjs` | ✅ Done |
| 5.3 | `x-should-retry` + `retry-after-ms` | `[tier:medium]` | 45 min   | ‖ 5.1, 5.2, 5.5 | ⊘ Phase 4      | `index.mjs`, `lib/backoff.mjs`                      | ✅ Done |
| 5.4 | Automatic strategy adaptation       | `[tier:heavy]`  | 60 min   | →               | ⊘ 5.2          | `index.mjs`, `lib/accounts.mjs`                     | ✅ Done |
| 5.5 | Minimal telemetry emulation         | `[tier:heavy]`  | 90 min   | ‖ 5.1, 5.2, 5.3 | ⊘ 0.6, 1.1     | `index.mjs`, `lib/config.mjs`                       | ✅ Done |

**Parallelism: 4 tasks run simultaneously (5.1 ‖ 5.2 ‖ 5.3 ‖ 5.5), then 5.4 sequential after 5.2.**

---

### Phase 6: Deep QA Review (Wave 6) — 5-6h total

Tasks 6.1-6.6, 6.8 are independent audits. Tasks 6.7 and 6.9 depend on all prior audits.

| #   | Task                          | Tier            | Duration | Parallel                | Depends On | Files                | Status  |
| --- | ----------------------------- | --------------- | -------- | ----------------------- | ---------- | -------------------- | ------- |
| 6.1 | Full header audit             | `[tier:heavy]`  | 30 min   | ‖ 6.2-6.6, 6.8          | ⊘ Phase 5  | `index.test.mjs`     | ✅ Done |
| 6.2 | Full body audit               | `[tier:heavy]`  | 30 min   | ‖ 6.1, 6.3-6.6, 6.8     | ⊘ Phase 5  | `index.test.mjs`     | ✅ Done |
| 6.3 | Full OAuth flow audit         | `[tier:heavy]`  | 30 min   | ‖ 6.1-6.2, 6.4-6.6, 6.8 | ⊘ Phase 5  | `lib/oauth.test.mjs` | ✅ Done |
| 6.4 | Full beta composition audit   | `[tier:heavy]`  | 45 min   | ‖ 6.1-6.3, 6.5-6.6, 6.8 | ⊘ Phase 5  | `index.test.mjs`     | ✅ Done |
| 6.5 | System prompt structure audit | `[tier:heavy]`  | 30 min   | ‖ 6.1-6.4, 6.6, 6.8     | ⊘ Phase 5  | `index.test.mjs`     | ✅ Done |
| 6.6 | Response handling audit       | `[tier:heavy]`  | 30 min   | ‖ 6.1-6.5, 6.8          | ⊘ Phase 5  | `index.test.mjs`     | ✅ Done |
| 6.7 | End-to-end conformance test   | `[tier:heavy]`  | 60 min   | →                       | ⊘ 6.1-6.6  | `test/conformance/`  | ✅ Done |
| 6.8 | Telemetry conformance audit   | `[tier:heavy]`  | 30 min   | ‖ 6.1-6.6               | ⊘ Phase 5  | `test/conformance/`  | ✅ Done |
| 6.9 | Regression test suite         | `[tier:medium]` | 60 min   | →                       | ⊘ 6.1-6.8  | `test/conformance/`  | ✅ Done |

**Parallelism: 7 audits run simultaneously (6.1-6.6 ‖ 6.8), then 6.7 → 6.9 sequential.**

---

### Summary: Total Tasks & Parallelism

| Phase     | Tasks  | Parallel Groups       | Sequential Bottlenecks | Est. Wall-Clock (with parallelism)        |
| --------- | ------ | --------------------- | ---------------------- | ----------------------------------------- |
| 0         | 7      | 6 ‖ → 1               | 0.7 (doc)              | ~45 min                                   |
| 1         | 5      | 4 ‖ → 1               | 1.5 (temp)             | ~1.5h                                     |
| 2         | 4      | 3 ‖ → 1               | 2.4 (body betas)       | ~1.5h                                     |
| 3         | 6      | 6 ‖                   | None                   | ~30 min                                   |
| 4         | 5      | 4 ‖ → 1               | 4.3 (boundary)         | ~2h                                       |
| 5         | 5      | 4 ‖ → 1               | 5.4 (auto-strategy)    | ~2.5h                                     |
| 6         | 9      | 7 ‖ → 1 → 1           | 6.7 (E2E), 6.9 (suite) | ~2.5h                                     |
| **Total** | **41** | **34 parallelizable** | **7 sequential**       | **~10.5h wall-clock** (vs ~30-40h serial) |

**Critical path:** Phase 0.7 → 1.4 → 1.5 → 2.1 → 2.4 → Phase 3 → 4.1 → 4.3 → Phase 5 → 5.2 → 5.4 → 6.7 → 6.9

---

## 1. Objective

Bring the OpenCode anthropic-auth plugin into **exact protocol fidelity** with Claude Code v2.1.80 across all 13 inspection areas (OAuth, system prompts, headers, fingerprinting, messaging, endpoints, telemetry, phoning home, callbacks, security hardening, encryption, token optimization, logging), then layer on **long-session optimization** features that Claude Code uses internally but the plugin does not yet leverage.

**Success metric:** An API request from the plugin should be indistinguishable from a genuine Claude Code request at the HTTP level — same headers, same body structure, same metadata format, same beta composition, same minimal telemetry footprint — while being more token-efficient and adaptive over multi-hour coding sessions.

---

## 2. Prerequisites

| #   | Prerequisite                                                      | Status       |
| --- | ----------------------------------------------------------------- | ------------ |
| P1  | `@anthropic-ai/claude-code@2.1.80` downloaded and inspected       | Done         |
| P2  | `docs/claude-code-reverse-engineering.md` completed (15 sections) | Done         |
| P3  | Gap analysis (Section 15) with 20 discrepancies identified        | Done         |
| P4  | Optimization opportunities analysis (17 items)                    | Done         |
| P5  | Current plugin codebase fully inventoried                         | Done         |
| P6  | Test infrastructure (Vitest) operational                          | Verify first |
| P7  | At least one active OAuth account for live testing                | Required     |
| P8  | Node.js >= 18 development environment                             | Required     |
| P9  | Phase 0 pre-flight results documented (see Phase 0)               | Required     |

---

## 3. Requisites

### 3.1 Functional Requisites

| ID   | Requirement                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1  | `metadata.user_id` MUST be JSON-stringified `{device_id, account_uuid, session_id}` with correct types                                                |
| FR2  | `anthropic-dangerous-direct-browser-access` header MUST NOT be sent                                                                                   |
| FR3  | OAuth scopes MUST include all 5 Claude.ai scopes; existing tokens with insufficient scopes MUST trigger reauth                                        |
| FR4  | Beta composition MUST match Claude Code's always-on set for first-party; `betas` array MUST also appear in request body                               |
| FR5  | Thinking config MUST use `{type: "adaptive"}` for Opus 4.6 and Sonnet 4.6 (prefix-matched), enabled by default with runtime auto-disable on rejection |
| FR6  | `x-stainless-os` MUST map darwin to `"macOS"` (correct casing)                                                                                        |
| FR7  | `x-stainless-package-version` MUST use SDK version, not CLI version                                                                                   |
| FR8  | Billing header `cch` MUST be `00000` (not random)                                                                                                     |
| FR9  | Billing header `cc_version` MUST include `{ver}.{modelId}`                                                                                            |
| FR10 | Prompt caching MUST default to `ttl: "1h"` (matching Claude Code), with runtime auto-disable on rejection and configurable override                   |
| FR11 | Rate limit utilization headers MUST be extracted and used for proactive rotation                                                                      |
| FR12 | Fast mode MUST be toggleable and set `speed: "fast"` in request body (validated in Phase 0)                                                           |
| FR13 | Token refresh MUST include scope parameter with all 5 Claude.ai scopes                                                                                |
| FR14 | Version MUST be dynamically fetched or updated to latest                                                                                              |
| FR15 | `x-stainless-helper-method` header MUST be removed; `x-stainless-helper` with tool manifest MUST be sent                                              |
| FR16 | `temperature` MUST be `1` when thinking disabled, MUST be absent when thinking enabled                                                                |
| FR17 | OAuth authorization URL MUST include `code=true` query parameter                                                                                      |
| FR18 | Model detection MUST use prefix matching (e.g., `model.startsWith('claude-opus-4-6')`) not exact match                                                |
| FR19 | Minimal telemetry emulation MUST be available (opt-in) to match Claude Code's session lifecycle pattern                                               |

### 3.2 Non-Functional Requisites

| ID   | Requirement                                                                         |
| ---- | ----------------------------------------------------------------------------------- |
| NFR1 | All changes MUST have unit tests with >= 90% branch coverage for modified functions |
| NFR2 | Existing tests MUST continue to pass (no regressions)                               |
| NFR3 | Plugin MUST remain backward-compatible with current config schema                   |
| NFR4 | Each phase MUST be independently deployable                                         |
| NFR5 | Performance: header/body transformation MUST add < 5ms per request                  |
| NFR6 | No new runtime dependencies unless absolutely necessary                             |
| NFR7 | All hardcoded versions MUST be configurable or auto-updated                         |
| NFR8 | Each phase MUST have a rollback path (see Section 8)                                |

---

## 4. Expected Outcome

### After Phase 0 (Validation)

- Documented which API features are available vs internal-only
- Go/no-go decision for extended cache TTL, betas-in-body, fast mode, adaptive thinking
- No wasted implementation effort on unsupported features

### After Phase 1-3 (Fidelity)

- Zero detectable fingerprint differences in HTTP headers, body metadata, OAuth parameters, and beta composition compared to Claude Code v2.1.80
- All 20 gap analysis items from Section 15 resolved
- Existing users with old-scope tokens gracefully prompted to reauth
- Existing deviceId values migrated to correct format

### After Phase 4-5 (Optimization)

- 30-60% reduction in input token costs for sessions > 10 turns (via cache TTL + scope, if API supports TTL; otherwise standard ephemeral caching applied)
- Adaptive thinking saves ~10-30% output tokens vs fixed effort
- Fast mode available for routine operations
- Proactive rate limit avoidance reduces 429 errors by ~80%
- Minimal telemetry emulation removes the "zero telemetry" fingerprint signal (opt-in)

### After Phase 6 (QA)

- Full protocol conformance verified against reverse-engineering document
- All edge cases documented and tested
- Regression test suite prevents future drift

---

## 5. Phases & Waves

---

### Phase 0: Pre-Flight Validation (Wave 0)

**Goal:** Validate API assumptions before committing to implementation decisions.
**Duration:** 1-2 hours
**Dependencies:** Active OAuth account (P7)

> **Rationale:** Several features (extended cache TTL, betas-in-body, fast mode, adaptive thinking) are based on Claude Code's observed behavior. Some may be internal-only. Pre-flight validation **informs** the implementation — features that match Claude Code behavior (adaptive thinking, 1h cache TTL) are **enabled by default** with runtime auto-disable on rejection, while features that are purely additive (fast mode, telemetry) respect pre-flight results as gates. Pre-flight also documents which headers/endpoints are available so implementation doesn't assume.

---

#### Task 0.1: Validate Extended Cache TTL (`ttl: "1h"`)

**Risk addressed:** `{type: "ephemeral", ttl: "1h"}` may be internal-only. Public docs only document `{type: "ephemeral"}`.

**Method:**

1. [tier:fast] Send a `/v1/messages` request with `system` containing a content block with `cache_control: {type: "ephemeral", ttl: "1h"}`
2. [tier:fast] Check response for:
   - **200 + normal response** → TTL is accepted (PROCEED with Task 4.1)
   - **200 but `ttl` silently ignored** → Accepted but no benefit (PROCEED with caveat)
   - **400 error mentioning `ttl`** → Not supported (SKIP Task 4.1, use standard `ephemeral`)
3. [tier:fast] If accepted, verify via `cache_read_input_tokens > 0` on a repeat request within 6 minutes (past default 5-min TTL)

**Output:** `PREFLIGHT_CACHE_TTL = "supported" | "ignored" | "rejected"`

---

#### Task 0.2: Validate `betas` Array in Request Body

**Risk addressed:** Claude Code sends betas as both header and body field. The body field may be ignored or may cause errors for non-beta clients.

**Method:**

1. [tier:fast] Send a `/v1/messages` request with `betas: ["claude-code-20250219"]` in the JSON body
2. [tier:fast] Check response:
   - **200** → Body betas accepted (PROCEED with Task 2.4)
   - **400 mentioning `betas`** → Not supported in body (SKIP Task 2.4, header-only)
3. [tier:fast] Test with the full always-on beta set to check for rejected betas

**Output:** `PREFLIGHT_BODY_BETAS = "supported" | "rejected"`

---

#### Task 0.3: Validate `speed: "fast"` Parameter

**Risk addressed:** Fast mode may only work for specific subscription tiers or Claude Code client IDs.

**Method:**

1. [tier:fast] Send a `/v1/messages` request with `speed: "fast"` and `fast-mode-2026-02-01` beta
2. [tier:fast] Check response:
   - **200 with faster output** → Supported (PROCEED with Task 5.1)
   - **400 mentioning `speed`** → Not available (SKIP speed param, keep beta for future)
   - **200 but speed ignored** → Accepted silently (PROCEED, may activate later)

**Output:** `PREFLIGHT_FAST_MODE = "supported" | "rejected" | "ignored"`

---

#### Task 0.4: Validate `{type: "adaptive"}` Thinking

**Risk addressed:** Adaptive thinking may require specific client credentials or subscription level.

**Method:**

1. [tier:fast] Send a `/v1/messages` request with `thinking: {type: "adaptive"}` for `claude-opus-4-6`
2. [tier:fast] Check response:
   - **200 with thinking blocks** → Supported (PROCEED with Task 1.5)
   - **400 mentioning `adaptive`** → Not available (KEEP effort-based as fallback)

**Output:** `PREFLIGHT_ADAPTIVE_THINKING = "supported" | "rejected"`

---

#### Task 0.5: Validate Rate Limit Utilization Headers

**Risk addressed:** `anthropic-ratelimit-unified-*` headers may not be present for OAuth clients.

**Method:**

1. [tier:fast] Send a normal `/v1/messages` request and examine ALL response headers
2. [tier:fast] Log every header name starting with `anthropic-ratelimit`
3. [tier:fast] Document which rate limit header types are present

**Output:** `PREFLIGHT_RATELIMIT_HEADERS = { present: string[], absent: string[] }`

---

#### Task 0.6: Validate Telemetry Endpoint Accessibility

**Risk addressed:** `/api/event_logging/batch` may reject events from non-Claude-Code sessions or require specific client attestation.

**Method:**

1. [tier:fast] Send a minimal `ClaudeCodeInternalEvent` batch (single `tengu_started` event) to `POST /api/event_logging/batch`
2. [tier:fast] Use current OAuth token with standard headers (`anthropic-version`, `User-Agent: claude-code/{ver}`, `x-service-name: claude-code`)
3. [tier:fast] Check response:
   - **200/202/204** → Accepted (PROCEED with Task 5.6)
   - **401/403** → Requires different auth or client attestation (SKIP telemetry emulation)
   - **400** → Format wrong, adjust and retry

**Output:** `PREFLIGHT_TELEMETRY = "accepted" | "rejected" | "needs_adjustment"`

---

#### Task 0.7: Document Pre-Flight Results

**Output file:** `docs/plans/preflight-results.md`

**Contents:**

1. [tier:fast] Date and account used for testing
2. [tier:fast] Claude Code version targeted
3. [tier:fast] Result table with all `PREFLIGHT_*` values
4. [tier:fast] Go/no-go decisions per feature
5. [tier:fast] Any adjusted implementation approach based on findings

**This file MUST be completed before Phase 1 begins.**

---

### Phase 1: Critical Fixes (Wave 1)

**Goal:** Fix issues that could cause API rejection or are trivially detectable.
**Duration:** 3-4 hours (adjusted from original 1-2h estimate)
**Dependencies:** Phase 0 complete with documented results

---

#### Task 1.1: Fix `metadata.user_id` Format

**Ref:** Gap 15.5 (CRITICAL)

**Current behavior:** `user_{uuid}_account_{uuid}_session_{uuid}` — underscore-delimited string with UUID-format device ID.

**Target behavior:** `JSON.stringify({device_id: "<64-hex>", account_uuid: "<uuid>", session_id: "<uuid>"})`

**Files to modify:**

- `index.mjs` — `transformRequestBody()` (lines 453-466)
- `lib/storage.mjs` — Add `deviceId` field to plugin-level config (NOT per-account)
- `lib/config.mjs` — Add persistent `deviceId` to config, add migration function

**Implementation steps:**

1. [tier:medium] Add `deviceId` generation: `crypto.randomBytes(32).toString('hex')` — 64-char hex, generated once, persisted in config
2. [tier:medium] Add **migration function** `migrateDeviceId(config)`:
   - If `config.deviceId` exists and matches `/^[0-9a-f]{64}$/` → keep it (already correct)
   - If `config.deviceId` exists but is UUID format → regenerate as 64-char hex, log migration
   - If `config.deviceId` absent → generate new 64-char hex
3. [tier:medium] Add `sessionId` generation: `crypto.randomUUID()` — generated once per plugin load
4. [tier:medium] Restructure `metadata.user_id` to `JSON.stringify({device_id, account_uuid, session_id})`
5. [tier:medium] Support `CLAUDE_CODE_EXTRA_METADATA` env var for additional JSON fields merged into the object
6. [tier:medium] When `account_uuid` is not available, use empty string `""` (matches Claude Code behavior)
7. [tier:medium] Keep `OPENCODE_ANTHROPIC_SIGNATURE_USER_ID` override for backward compat (if set, use raw value instead of JSON)

**Tests:**

- [ ] `metadata.user_id` is valid JSON when parsed
- [ ] `device_id` is exactly 64 hex characters
- [ ] `device_id` is stable across plugin reloads (persisted)
- [ ] `device_id` migration: UUID → 64-hex regeneration works
- [ ] `device_id` migration: already-correct values preserved
- [ ] `account_uuid` matches the active account's OAuth UUID
- [ ] `account_uuid` is `""` (empty string) when not authenticated
- [ ] `session_id` is a valid UUID, changes per plugin load
- [ ] `CLAUDE_CODE_EXTRA_METADATA={"foo":"bar"}` merges additional fields
- [ ] Override env var still works (produces raw value, not JSON)

**Acceptance criteria:**

- `JSON.parse(metadata.user_id)` succeeds
- `device_id` matches `/^[0-9a-f]{64}$/`
- `session_id` matches UUID v4 regex
- Existing configs migrated without data loss

---

#### Task 1.2: Remove `anthropic-dangerous-direct-browser-access` Header

**Ref:** Gap 15.9 (HIGH)

**Files to modify:**

- `index.mjs` — `buildRequestHeaders()` (find and remove the header assignment)

**Implementation steps:**

1. [tier:fast] Search for `anthropic-dangerous-direct-browser-access` in `index.mjs`
2. [tier:medium] Remove the line(s) that set this header
3. [tier:fast] Verify no other code path references it

**Tests:**

- [ ] `buildRequestHeaders()` output does NOT contain `anthropic-dangerous-direct-browser-access`
- [ ] Existing header tests updated to verify absence

**Acceptance criteria:**

- Header is absent from all outgoing requests
- No references to this header remain in codebase (except docs/tests verifying absence)

---

#### Task 1.3: Fix OAuth Scopes + Authorization URL + Refresh Scope

**Ref:** Gap 15.3 (HIGH) — **merged with former Task 3.6 (refresh scope)**

**Current scopes:** `org:create_api_key user:profile user:inference`

**Target scopes:** `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` (Claude.ai flow)

**Files to modify:**

- `lib/oauth.mjs` — `authorize()` function (scope + `code=true` param), `refreshToken()` (add scope), `exchange()` (verify)

**Implementation steps:**

1. [tier:medium] Define scope constants:
   ```js
   const CLAUDE_AI_SCOPES = [
     "user:profile",
     "user:inference",
     "user:sessions:claude_code",
     "user:mcp_servers",
     "user:file_upload",
   ];
   const CONSOLE_SCOPES = ["org:create_api_key", "user:profile"];
   ```
2. [tier:medium] Update `authorize()` to use `CLAUDE_AI_SCOPES` (Claude.ai login is the default)
3. [tier:medium] **Add `code=true` query parameter** to the authorization URL (Claude Code sends this as a custom param — see RE doc Section 1.4)
4. [tier:medium] Update `refreshToken()` to include `scope: CLAUDE_AI_SCOPES.join(' ')` in the refresh body
5. [tier:medium] Export scope constants for use in tests and migration check
6. [tier:medium] **Add scope migration helper** `hasRequiredScopes(account)`:
   ```js
   function hasRequiredScopes(account) {
     const required = new Set(CLAUDE_AI_SCOPES);
     const stored = new Set(account.scopes || []);
     return [...required].every((s) => stored.has(s));
   }
   ```
7. [tier:medium] When `hasRequiredScopes()` returns false for an account, mark it as `needsReauth: true` and log a warning prompting the user to run `opencode-anthropic-auth reauth`
8. [tier:medium] On refresh, if server returns a token with fewer scopes than requested, store the actual returned scopes and mark `needsReauth: true`

**Tests:**

- [ ] `authorize()` URL includes all 5 Claude.ai scopes
- [ ] `authorize()` URL includes `code=true` query parameter
- [ ] `refreshToken()` body includes `scope` field with all 5 scopes space-separated
- [ ] Scope string is space-separated (not comma-separated)
- [ ] `hasRequiredScopes()` returns true when all 5 present
- [ ] `hasRequiredScopes()` returns false when missing `user:mcp_servers`
- [ ] Account with old 3-scope token marked `needsReauth: true` on load
- [ ] Refresh with insufficient-scope response stores actual scopes

**Acceptance criteria:**

- Authorization URL query param `scope` contains all 5 scopes
- Authorization URL includes `code=true`
- Refresh request body includes `scope` field
- Existing users with old tokens see a clear reauth prompt, not a crash

---

#### Task 1.4: Fix Thinking Configuration for Opus 4.6 and Sonnet 4.6

**Ref:** Gaps 15.13, 15.14 (MEDIUM, but simple and high-impact)

**Current:** `{ type: "enabled", effort: "high" }` for Opus 4.6 only.

**Target:** `{ type: "adaptive" }` for both `claude-opus-4-6*` and `claude-sonnet-4-6*` (prefix-matched). **Enabled by default** — this is what Claude Code sends; anything else is a fingerprint difference. Auto-disables if Phase 0 Task 0.4 shows API rejection.

**Files to modify:**

- `index.mjs` — `normalizeThinkingBlock()` (lines 797-854)

**Implementation steps:**

1. [tier:medium] Add model detection with **prefix matching** (FR18):
   ```js
   function isAdaptiveThinkingModel(model) {
     return model.startsWith("claude-opus-4-6") || model.startsWith("claude-sonnet-4-6");
   }
   ```
2. [tier:medium] In `normalizeThinkingBlock()`, if `isAdaptiveThinkingModel(model)` returns true → return `{ type: "adaptive" }` **unconditionally by default**
3. [tier:medium] **Runtime auto-disable:** If the API returns a 400 error mentioning `adaptive` → log warning, fall back to `{ type: "enabled", budget_tokens: N }` for the rest of the session, and persist `adaptiveThinkingSupported: false` in config as a sticky override
4. [tier:fast] Locate all `budgetTokensToEffort()` call sites in `index.mjs` that apply to adaptive models
5. [tier:medium] Remove `budgetTokensToEffort()` usage for these models
6. [tier:medium] Keep existing thinking handling as fallback for older models (Claude 3.x, Haiku 4.5)
7. [tier:medium] Config override: `OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING=1` forces budget_tokens fallback

**Tests:**

- [ ] `claude-opus-4-6` → `{ type: "adaptive" }` (when supported)
- [ ] `claude-opus-4-6-20260115` → `{ type: "adaptive" }` (versioned model ID, prefix matched)
- [ ] `claude-sonnet-4-6` → `{ type: "adaptive" }`
- [ ] `claude-sonnet-4-6-20260301` → `{ type: "adaptive" }` (versioned)
- [ ] `claude-sonnet-4-5` → retains existing behavior (not adaptive)
- [ ] `claude-haiku-4-5` → retains existing behavior
- [ ] Fallback when adaptive unsupported: `{ type: "enabled", budget_tokens: N }`

**Acceptance criteria:**

- Model-specific thinking format matches Claude Code exactly for current models
- Prefix matching handles versioned model IDs
- No regression for non-adaptive models

---

#### Task 1.5: Fix Temperature Handling

**Ref:** RE doc Section 6 (FR16) — identified in review as missing implementation task

**Current behavior:** Unknown/uncontrolled — temperature may be sent unconditionally.

**Target behavior:**

- When thinking is **enabled** (any type): `temperature` MUST be absent from request body
- When thinking is **disabled**: `temperature: 1` (or `temperatureOverride` if configured)

**Files to modify:**

- `index.mjs` — `transformRequestBody()`

**Implementation steps:**

1. [tier:medium] In `transformRequestBody()`, after determining whether thinking is enabled:
   - If thinking is present and enabled → `delete body.temperature` (ensure absent)
   - If thinking is absent or disabled → `body.temperature = body.temperature ?? 1`
2. [tier:medium] Support `CLAUDE_CODE_TEMPERATURE_OVERRIDE` env var for custom temperature when thinking disabled

**Tests:**

- [ ] Request with `thinking: {type: "adaptive"}` → no `temperature` field in body
- [ ] Request with `thinking: {type: "enabled", budget_tokens: N}` → no `temperature` field
- [ ] Request without thinking → `temperature: 1`
- [ ] `CLAUDE_CODE_TEMPERATURE_OVERRIDE=0.5` → `temperature: 0.5` (when thinking disabled)

**Acceptance criteria:**

- Temperature presence/absence matches Claude Code behavior exactly

---

### Phase 2: High-Priority Fixes (Wave 2)

**Goal:** Fix all HIGH-impact fingerprint differences.
**Duration:** 3-5 hours (adjusted from original 2-3h)
**Dependencies:** Phase 1 complete

---

#### Task 2.1: Fix Beta Composition — Always-On Set

**Ref:** Gaps 15.15, 15.16 (HIGH)

**Files to modify:**

- `index.mjs` — `buildAnthropicBetaHeader()` (lines 670-795)

**Implementation steps:**

1. [tier:medium] Define the always-on beta set for first-party OAuth:
   ```js
   const ALWAYS_ON_BETAS = [
     "claude-code-20250219",
     "interleaved-thinking-2025-05-14",
     "context-management-2025-06-27",
     "structured-outputs-2025-12-15",
     "web-search-2025-03-05",
     "tool-examples-2025-10-29",
     "advanced-tool-use-2025-11-20",
     "tool-search-tool-2025-10-19",
     "effort-2025-11-24",
     "prompt-caching-scope-2026-01-05",
     "redact-thinking-2026-02-12",
   ];
   ```
2. [tier:medium] Remove env var gates (`TENGU_MARBLE_ANVIL`, `TENGU_TOOL_PEAR`, `TENGU_SCARF_COFFEE`, `USE_API_CONTEXT_MANAGEMENT`) for these betas
3. [tier:medium] Add conditional betas using **prefix matching** (FR18) for model detection:
   - `context-1m-2025-08-07` → if model supports 1M context (`model.startsWith('claude-opus-4-6') || model.startsWith('claude-sonnet-4-6')`) — **remove the OAuth exclusion** at line 742 (Claude Code DOES include it for OAuth)
   - `fast-mode-2026-02-01` → if fast mode enabled AND model supports AND `PREFLIGHT_FAST_MODE !== "rejected"`
   - `afk-mode-2026-01-31` → if auto mode active (future, gate behind env var for now)
4. [tier:medium] Keep `prompt-caching-scope-2026-01-05` exclusion for round-robin strategy (correct behavior — per-workspace cache scope doesn't benefit when switching accounts every request)
5. [tier:medium] Keep `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` override for user control
6. [tier:medium] Deduplicate final beta array before sending

**Tests:**

- [ ] First-party OAuth request includes all 11 always-on betas
- [ ] `context-1m-2025-08-07` included for `claude-opus-4-6` regardless of OAuth/API key auth
- [ ] `context-1m-2025-08-07` included for `claude-opus-4-6-20260115` (versioned, prefix match)
- [ ] `prompt-caching-scope-2026-01-05` excluded in round-robin strategy
- [ ] Bedrock provider excludes first-party-only betas
- [ ] `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` strips experimental set
- [ ] No duplicate betas in final header
- [ ] Env var gates for always-on betas no longer affect behavior

**Acceptance criteria:**

- Beta header for a first-party Opus 4.6 request matches Claude Code's output exactly
- Env var removal doesn't break any other code path

---

#### Task 2.2: Fix User-Agent Prefix for Non-API Calls

**Ref:** Gap 15.4 (MEDIUM, but grouped here for coherence)

**Current:** Token exchange, account settings use `claude-cli/{ver} (external, cli)`.

**Target:** Claude Code has THREE UA functions (minimal, extended, transport). We simplify to two:

| Context                | UA String                                    | Notes                       |
| ---------------------- | -------------------------------------------- | --------------------------- |
| OAuth, settings, grove | `claude-code/{ver}`                          | Minimal UA                  |
| `/v1/messages` API     | `claude-cli/{ver} (external, ${entrypoint})` | Extended UA (correct as-is) |

**Files to modify:**

- `lib/oauth.mjs` — User-Agent in `exchange()`, `refreshToken()`, `revoke()` calls
- `index.mjs` — Any non-API HTTP calls (account settings, grove config)

**Implementation steps:**

1. [tier:medium] Define two UA functions:
   ```js
   const minimalUA = () => `claude-code/${version}`; // for OAuth, settings, grove
   const extendedUA = () => `claude-cli/${version} (external, ${entrypoint})`; // for API calls
   ```
2. [tier:medium] Update OAuth module to use `minimalUA` for token exchange/refresh/revoke
3. [tier:medium] Keep `extendedUA` for `/v1/messages` API calls (this IS correct per Claude Code)
4. [tier:fast] Note: Claude Code also has a "transport UA" (`claude-code/{ver}` with optional SDK/entrypoint). We don't need this unless we add SSE/WS support.

**Tests:**

- [ ] Token exchange request User-Agent is `claude-code/{ver}`
- [ ] Token refresh request User-Agent is `claude-code/{ver}`
- [ ] Token revoke request User-Agent is `claude-code/{ver}`
- [ ] `/v1/messages` request User-Agent is `claude-cli/{ver} (external, cli)`

**Acceptance criteria:**

- Correct UA variant used per endpoint type

---

#### Task 2.3: Fix `x-stainless-package-version`

**Ref:** Gap 15.11 (MEDIUM)

**Current:** Sends CLI version (e.g., `2.1.80`).

**Target:** Sends SDK version (the `@anthropic-ai/sdk` package version embedded in Claude Code).

**Files to modify:**

- `index.mjs` — Stainless header construction

**Implementation steps:**

1. [tier:fast] Extract the SDK version from the Claude Code bundle analysis or from npm `@anthropic-ai/sdk` latest
2. [tier:medium] Store as a separate constant `SDK_VERSION` (distinct from `CLI_VERSION`)
3. [tier:medium] Maintain a version map: `{ cliVersion: "2.1.80", sdkVersion: "X.Y.Z" }`
4. [tier:medium] Make auto-fetchable: when fetching CLI version from npm, also fetch SDK version
5. [tier:medium] Fallback chain: fetched SDK version → config override → hardcoded value from analysis
6. [tier:medium] Use `SDK_VERSION` for `x-stainless-package-version`
7. [tier:medium] Use `CLI_VERSION` for `User-Agent`

**Tests:**

- [ ] `x-stainless-package-version` differs from the CLI version
- [ ] Value matches the known SDK version for the target Claude Code release
- [ ] Fallback to hardcoded when fetch fails

**Acceptance criteria:**

- Header value is the SDK version, not CLI version

---

#### Task 2.4: Add `betas` Array to Request Body

**Ref:** Review correction #4 — Claude Code sends betas in BOTH header AND body

**Prerequisite:** `PREFLIGHT_BODY_BETAS === "supported"` (Phase 0 Task 0.2)

**Current behavior:** Betas only sent as `anthropic-beta` header.

**Target behavior:** For `/v1/messages` requests (first-party), also include `betas: [...]` array in the JSON body. Same array contents as the header.

**Files to modify:**

- `index.mjs` — `transformRequestBody()`

**Implementation steps:**

1. [tier:medium] After composing the beta array for the header, also inject it into the body:
   ```js
   if (isFirstParty && PREFLIGHT_BODY_BETAS === "supported") {
     body.betas = betaArray;
   }
   ```
2. [tier:medium] For Bedrock, inject as `anthropic_beta` (underscore, in body — Claude Code Bedrock behavior)
3. [tier:medium] If `PREFLIGHT_BODY_BETAS === "rejected"`, skip body injection entirely (header-only)

**Tests:**

- [ ] First-party `/v1/messages` request body contains `betas` array
- [ ] `betas` array matches `anthropic-beta` header contents
- [ ] Bedrock request body contains `anthropic_beta` (underscore)
- [ ] Body betas skipped when pre-flight showed rejection

**Acceptance criteria:**

- Body and header betas are consistent for first-party
- No errors from API when body betas present

---

### Phase 3: Medium-Priority Fixes (Wave 3)

**Goal:** Fix all remaining fingerprint differences from Section 15 (excluding cache scope, moved to Phase 4).
**Duration:** 3-5 hours (adjusted from original 2-3h)
**Dependencies:** Phase 2 complete

> **Note:** Former Task 3.6 (refresh scope) merged into Task 1.3. Former Task 3.7 (cache scope) moved to Phase 4 as Task 4.2 to maintain NFR4 (independently deployable phases).

---

#### Task 3.1: Fix Stainless OS Casing

**Ref:** Gap 15.10 (LOW)

**File:** `index.mjs` — OS mapping function.

**Change:** `darwin` → `"macOS"` (was `"MacOS"`).

**Tests:**

- [ ] On macOS/darwin, header value is `"macOS"` (not `"MacOS"`)

---

#### Task 3.2: Fix Billing Header

**Ref:** Gaps 15.6, 15.7, 15.8 (LOW)

**Files:** `index.mjs` — billing header construction (lines 473-479).

**Changes:**

1. [tier:medium] `cch=00000` — hardcode instead of random hex
2. [tier:fast] Inspect `buildSystemPromptBlocks()` signature to check if `model` parameter is already present
3. [tier:medium] `cc_version={ver}.{modelId}` — append model ID (add `model` parameter to `buildSystemPromptBlocks()` if not already present)
4. [tier:medium] Add `cc_workload={workloadId}` when `fq8()` equivalent is available (optional field — omit if not set)

**Tests:**

- [ ] `cch` is always `00000`
- [ ] `cc_version` includes model ID (e.g., `2.1.80.claude-opus-4-6`)
- [ ] `cc_workload` present when workload is set, absent otherwise
- [ ] Billing header absent when `CLAUDE_CODE_ATTRIBUTION_HEADER=false`

---

#### Task 3.3: Fix `x-stainless-helper-method` → `x-stainless-helper`

**Ref:** Gap 15.12 (LOW)

**File:** `index.mjs` — Stainless header construction.

**Changes:**

1. [tier:medium] Remove `x-stainless-helper-method: stream`
2. [tier:medium] Add `x-stainless-helper: BetaToolRunner, <tool_list>` — extract tool names from `body.tools` array:
   ```js
   const toolNames = (body.tools || []).map((t) => t.name).join(", ");
   headers["x-stainless-helper"] = `BetaToolRunner, ${toolNames}`;
   ```

**Tests:**

- [ ] `x-stainless-helper-method` header is NOT sent
- [ ] `x-stainless-helper` header IS sent with tool manifest
- [ ] Tool names extracted from request body tools array

---

#### Task 3.4: Add `x-stainless-timeout` for Non-Streaming

**Ref:** Gap 15.18 (LOW)

**File:** `index.mjs` — Stainless header construction.

**Change:** When request has `stream: false` or stream absent, add `X-Stainless-Timeout: 600`.

**Tests:**

- [ ] Non-streaming request includes `X-Stainless-Timeout: 600`
- [ ] Streaming request does NOT include this header

---

#### Task 3.5: Fix OAuth State Parameter

**Ref:** Gap 15.3 detail (LOW)

**File:** `lib/oauth.mjs` — `authorize()`.

**Change:** Generate state independently from verifier: `state = base64url(randomBytes(32))` (currently reuses the verifier as state).

**Tests:**

- [ ] State parameter differs from code verifier
- [ ] State is 43 characters (32 bytes base64url)
- [ ] Both verifier and state use `crypto.randomBytes(32)`

---

#### Task 3.6: Fix Version Staleness

**Ref:** Gap 15.19 (MEDIUM)

> **Note:** Renumbered from former 3.8 after merging old 3.6 into 1.3 and moving old 3.7 to Phase 4.

**Files:**

- `lib/oauth.mjs` — hardcoded `2.1.79`
- `index.mjs` — version fetching logic

**Changes:**

1. [tier:medium] Remove hardcoded `2.1.79` from `lib/oauth.mjs`
2. [tier:medium] Import version from config or fetch result
3. [tier:medium] Fallback chain: fetched latest → config → hardcoded minimum
4. [tier:fast] Search all source files for version usage sites (OAuth UA, API UA, billing header)
5. [tier:medium] Update each usage site to draw from the consistent version source

**Tests:**

- [ ] No `2.1.79` literal in any source file
- [ ] Version used in OAuth User-Agent matches version used in API headers
- [ ] Fallback to hardcoded minimum when fetch fails

---

### Phase 4: Token Optimization (Wave 4)

**Goal:** Leverage Claude Code's caching and token-saving features for long sessions.
**Duration:** 6-8 hours (adjusted from original 4-6h)
**Dependencies:** Phase 3 complete, Phase 0 results for cache TTL

---

#### Task 4.1: Extended Cache TTL (On by Default)

**File:** `index.mjs` — `buildSystemPromptBlocks()` (lines 620-657).

**Design rationale:** Claude Code sends `{type: "ephemeral", ttl: "1h"}` — sending anything less is both a fingerprint difference and a missed optimization. We enable 1h TTL by default and auto-disable only if the API explicitly rejects it.

**Implementation:**

1. [tier:medium] Change `cache_control: {type: "ephemeral"}` to `cache_control: {type: "ephemeral", ttl: "1h"}` for system prompt blocks — **on by default**
2. [tier:medium] Apply TTL to the last tool definition block as well (Claude Code's `lR8` function)
3. [tier:medium] Make TTL configurable via config: `cachePolicy.ttl` (default `"1h"`)
4. [tier:medium] **Runtime auto-disable:** If the API returns a 400 error mentioning `ttl` or `cache_control`:
   - Fall back to standard `{type: "ephemeral"}` (no TTL)
   - Persist `cachePolicy.ttlSupported: false` in config as a sticky override
   - Log warning: "Extended cache TTL not supported, falling back to 5-minute default"
5. [tier:medium] Phase 0 Task 0.1 pre-validates this, but runtime protection ensures safety even if pre-flight is skipped
6. [tier:medium] Config: `cachePolicy.ttl: "off"` explicitly disables extended TTL

**Tests:**

- [ ] Default behavior: system prompt blocks include `ttl: "1h"` in cache_control
- [ ] `cachePolicy.ttl: "off"` → standard `ephemeral` without TTL
- [ ] `cachePolicy.ttl: "5m"` → custom TTL value
- [ ] Runtime auto-disable: after 400 with ttl-related error, subsequent requests omit TTL
- [ ] Sticky override persisted to config after auto-disable
- [ ] Tool definition block includes cache_control when caching enabled
- [ ] Cache_control absent when caching fully disabled

**Acceptance criteria:**

- Repeated requests within 1-hour window show `cache_read_input_tokens > 0` (when API supports TTL)
- No 400 errors from cache_control format (auto-disable catches rejections)
- Default config produces Claude Code-matching behavior

---

#### Task 4.2: Fix System Prompt Cache Scope

**Ref:** Gap 15.17 (LOW) — **moved from Phase 3 to maintain NFR4**

**File:** `index.mjs` — `buildSystemPromptBlocks()`.

**Change:** Align cache_control placement with Claude Code's behavior:

- **Billing header block:** No `cache_control` (null scope — never cached)
- **Identity block:** No `cache_control` by default. Add `cache_control: {type: "ephemeral"}` only when explicitly opted in via config
- **Static blocks:** `cache_control: {type: "ephemeral"}` (with TTL from Task 4.1 if supported)
- **Dynamic blocks:** No `cache_control`

**Tests:**

- [ ] Billing header block has no `cache_control`
- [ ] Identity block defaults to no `cache_control`
- [ ] Static blocks (tool definitions, instructions) have `cache_control`
- [ ] Configuration allows enabling identity block caching

---

#### Task 4.3: Dynamic Boundary Marker (Experimental, Opt-In)

**File:** `index.mjs` — `buildSystemPromptBlocks()`.

> **⚠️ FRAGILITY WARNING:** The plugin intercepts and transforms system prompts that OpenCode constructs — it does not build the full prompt from scratch. The boundary marker works in Claude Code because they control the entire prompt pipeline. In the plugin, we must identify which parts of OpenCode's prompt are "static" vs "dynamic" without guaranteed knowledge of OpenCode's prompt structure. If OpenCode reorganizes its prompt between versions, the marker may split incorrectly, causing worse caching than without it.

**Implementation (opt-in only):**

1. [tier:medium] Add `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker injection, gated behind `CLAUDE_CODE_FORCE_GLOBAL_CACHE=true` or `cachePolicy.boundaryMarker: true` config
2. [tier:heavy] When enabled, scan the system prompt blocks for a heuristic split point:
   - Static: Tool definitions, role instructions, formatting rules (rarely change)
   - Dynamic: Environment info, CLAUDE.md content, session state (change per session)
3. [tier:medium] When marker present:
   - Blocks before marker get `cache_control: {type: "ephemeral"}`
   - Blocks after marker get no `cache_control`
4. [tier:medium] **Disabled by default** (opt-in only due to fragility)
5. [tier:medium] Log `tengu_sysprompt_boundary_found` equivalent metric when used

**Tests:**

- [ ] Marker is present in system prompt when enabled
- [ ] Static blocks (before marker) have cache_control
- [ ] Dynamic blocks (after marker) lack cache_control
- [ ] Billing header always lacks cache_control
- [ ] Disabled by default (opt-in)
- [ ] No errors when OpenCode sends an unexpected prompt structure

---

#### Task 4.4: Cache Hit Rate Tracking & Reporting

**File:** `index.mjs` — `transformResponse()` usage extraction section.

**Implementation:**

1. [tier:medium] Track per-turn: `cacheReadTokens`, `cacheCreationTokens`, `inputTokens`
2. [tier:medium] Calculate cache hit rate with **correct formula** (review fix #5):
   ```js
   const totalPromptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
   const cacheHitRate = totalPromptTokens > 0 ? cacheReadTokens / totalPromptTokens : 0;
   ```
3. [tier:medium] Track rolling average over last 5 turns
4. [tier:medium] Log warning when hit rate drops below configurable threshold (default 30%)
5. [tier:medium] Expose via `/anthropic stats` command as "Cache efficiency: XX%"

**Tests:**

- [ ] Cache hit rate calculated correctly (denominator includes all prompt token types)
- [ ] Edge case: all zeros → 0% (no division by zero)
- [ ] Rolling average updates on each turn
- [ ] Warning logged when rate drops below threshold
- [ ] Stats command shows cache efficiency

---

#### Task 4.5: Token Budget Awareness

**File:** `index.mjs` — new `SessionBudget` class or inline tracking.

**Implementation:**

1. [tier:medium] Track cumulative cost per session using pricing table:
   ```js
   const PRICING = {
     "claude-opus-4-6": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
     "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
     "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
   };
   // Fallback: use claude-sonnet-4-6 pricing for unknown models
   ```
2. [tier:medium] After each response, update cumulative cost
3. [tier:medium] When `maxBudgetUsd` config is set:
   - Warn at 80% via toast
   - **Soft block at 100%:** Log warning and set a `budgetExceeded: true` flag, but do NOT prevent requests. User can override with `OPENCODE_ANTHROPIC_IGNORE_BUDGET=1` or `/anthropic set ignoreBudget on`. (Review fix #10: hard block is too aggressive mid-operation)
4. [tier:medium] Expose via `/anthropic stats` as "Session cost: $X.XX"
5. [tier:medium] Cost resets on new session

**Tests:**

- [ ] Cost calculation matches expected values for known token counts
- [ ] Warning at 80% threshold
- [ ] Soft block at 100% (warning, flag, but no request prevention by default)
- [ ] Override `OPENCODE_ANTHROPIC_IGNORE_BUDGET=1` suppresses soft block
- [ ] Stats command shows session cost
- [ ] Cost resets on new session
- [ ] Unknown model uses fallback pricing

---

### Phase 5: Speed & Adaptive Intelligence (Wave 5)

**Goal:** Add fast mode, proactive rate limiting, adaptive behavior, and minimal telemetry.
**Duration:** 8-10 hours (adjusted from original 4-6h)
**Dependencies:** Phase 4 complete

---

#### Task 5.1: Fast Mode Toggle

**Prerequisite:** `PREFLIGHT_FAST_MODE !== "rejected"` (Phase 0 Task 0.3)

**Files:**

- `index.mjs` — `transformRequestBody()`, `buildAnthropicBetaHeader()`
- `lib/config.mjs` — Add `fastMode` config field

**Implementation:**

1. [tier:medium] Add config field `fastMode: false` (default off)
2. [tier:medium] Add `/anthropic set fast on|off` slash command
3. [tier:medium] When enabled AND `PREFLIGHT_FAST_MODE !== "rejected"`:
   - Add `speed: "fast"` to request body
   - Include `fast-mode-2026-02-01` beta (if not already present)
   - Only for models that support it (prefix match: `claude-opus-4-6*`, `claude-sonnet-4-6*`)
4. [tier:medium] If API returns 400 mentioning `speed`, auto-disable and log warning
5. [tier:medium] Display mode indicator in status

**Tests:**

- [ ] `speed: "fast"` present in body when enabled
- [ ] `fast-mode-2026-02-01` beta included when enabled
- [ ] Non-supporting models don't get speed param (e.g., `claude-haiku-4-5`)
- [ ] Toggle via slash command works
- [ ] Config persistence works
- [ ] Auto-disable on 400 error from API

---

#### Task 5.2: Proactive Rate Limit Detection

**Prerequisite:** `PREFLIGHT_RATELIMIT_HEADERS.present.length > 0` (Phase 0 Task 0.5)

**Files:**

- `index.mjs` — fetch interceptor (response handling, NOT inside SSE stream transform — headers are on the HTTP response object, not SSE events)
- `lib/accounts.mjs` — `AccountManager` class
- `lib/rotation.mjs` — `HealthScoreTracker`

**Implementation:**

1. [tier:medium] Extract response headers **at the fetch response level** (before entering SSE stream transform):
   ```js
   // In the fetch interceptor, after receiving response:
   const utilization = parseFloat(response.headers.get("anthropic-ratelimit-unified-tokens-utilization") || "0");
   const surpassed = response.headers.get("anthropic-ratelimit-unified-tokens-surpassed-threshold");
   const resetAt = response.headers.get("anthropic-ratelimit-unified-tokens-reset");
   ```
2. [tier:medium] Parse utilization as float (0.0 - 1.0)
3. [tier:medium] When utilization > 0.8:
   - Reduce health score by proportional penalty
   - Log debug warning with utilization %
   - Set a "soft cooldown" flag on the account
4. [tier:medium] When `surpassed-threshold` header present:
   - More aggressive penalty
   - Bias rotation to alternate accounts immediately
5. [tier:medium] Feed reset timestamps into backoff calculation
6. [tier:medium] **Graceful degradation:** When headers absent, do nothing (no impact)

**Tests:**

- [ ] Utilization header parsed correctly (decimal 0.0-1.0)
- [ ] Health score decreases when utilization > 0.8
- [ ] Account rotation prefers lower-utilization accounts
- [ ] surpassed-threshold triggers immediate rotation
- [ ] Reset timestamp used for backoff calculation
- [ ] No impact when headers absent (graceful degradation)
- [ ] Headers extracted from HTTP response, not from SSE event stream

---

#### Task 5.3: `x-should-retry` and `retry-after-ms` Support

**File:** `index.mjs` — error handler in fetch interceptor (lines 3098-3145), `lib/backoff.mjs`.

**Implementation:**

1. [tier:medium] Check `x-should-retry` header first:
   - `"true"` → retry with next account
   - `"false"` → do NOT retry (fail immediately, surface error to user)
2. [tier:medium] Check `retry-after-ms` header (milliseconds) before `Retry-After` (seconds)
3. [tier:medium] Priority chain: `x-should-retry` > `retry-after-ms` > `Retry-After` > calculated backoff

**Tests:**

- [ ] `x-should-retry: false` prevents retry
- [ ] `x-should-retry: true` enables retry even for normally non-retryable status
- [ ] `retry-after-ms: 500` used when present (ms precision)
- [ ] Fallback to `Retry-After` (seconds) when `retry-after-ms` absent
- [ ] Fallback to calculated backoff when no headers

---

#### Task 5.4: Automatic Strategy Adaptation (Simplified)

> **Simplified from original design** (review fix #15): Removed CONSERVATION state. Reduced to 2 states. Made behavioral modifications opt-in only.

**Files:**

- `index.mjs` — fetch interceptor
- `lib/accounts.mjs` — `AccountManager`

**Implementation:**

1. [tier:medium] Track session-level metrics: `totalRequests`, `rateLimitCount`, `rateLimitWindow` (sliding 5-minute window)
2. [tier:heavy] **Two states only:**
   ```
   CONFIGURED (user's chosen strategy)
        ↓ 3+ rate limits within 5 minutes
   DEGRADED (forced hybrid with increased rotation bias)
        ↓ 5 minutes with 0 rate limits
   CONFIGURED
   ```
3. [tier:medium] DEGRADED mode:
   - Override strategy to hybrid regardless of config
   - Increase rotation bias (reduce stickiness bonus)
   - Log warning to user: "Multiple rate limits detected, temporarily rotating accounts more aggressively"
4. [tier:medium] Auto-recovery: After 5 minutes with zero rate limits, revert to CONFIGURED
5. [tier:medium] Manual strategy override (`/anthropic set strategy sticky`) forces CONFIGURED and disables auto-adaptation for the session
6. [tier:heavy] **No system prompt modification** — this is explicitly out of scope (review fix #15: modifying prompts without user consent is unacceptable)

**Tests:**

- [ ] Strategy stays CONFIGURED on isolated 429 (single event)
- [ ] Strategy transitions to DEGRADED after 3 rate limits in 5 minutes
- [ ] Strategy reverts to CONFIGURED after 5 minutes without rate limits
- [ ] DEGRADED mode uses hybrid rotation regardless of config
- [ ] Manual override disables auto-adaptation
- [ ] No system prompt modification in any state
- [ ] State resets on new session

---

#### Task 5.5: Minimal Telemetry Emulation ("Silent Observer")

> **Replaces former "Idle Cache Priming" task** (review fix #16: cache priming via count_tokens is unlikely to work and wastes tokens)

**Prerequisite:** `PREFLIGHT_TELEMETRY === "accepted"` (Phase 0 Task 0.6)

**Rationale:** Claude Code sends 264+ `tengu_*` lifecycle events per session to `/api/event_logging/batch`. Complete absence of telemetry from an OAuth token that makes inference requests is itself a detectable fingerprint signal. This task adds opt-in minimal telemetry that makes the session look like a quiet but legitimate Claude Code session.

**Design principles:**

- **Opt-in only** — disabled by default (respect user privacy)
- **Lifecycle events only** — startup/exit, no per-turn events
- **Zero user content** — no prompts, no tool calls, no code, no file paths
- **Real system info** — platform, arch, node version (already visible in headers)
- **Plausible timing** — send startup event after first API call, exit event on shutdown
- **Minimal volume** — 2-3 events per session (matches a short Claude Code session)

**Files to modify:**

- `index.mjs` — new `TelemetryEmitter` class
- `lib/config.mjs` — add `telemetry.emulateMinimal: false` config

**Implementation:**

1. [tier:medium] **Config gating:**

   ```js
   // Default OFF — user must explicitly enable
   telemetry: {
     emulateMinimal: false,  // set to true to enable
   }
   ```

   Also controlled by: `OPENCODE_ANTHROPIC_TELEMETRY_EMULATE=1` env var

2. [tier:heavy] **Event format** (matching Claude Code's `ClaudeCodeInternalEvent` schema):

   ```js
   {
     event_type: "ClaudeCodeInternalEvent",
     event_data: {
       event_id: crypto.randomUUID(),
       event_name: "tengu_started",
       client_timestamp: new Date().toISOString(),
       device_id: deviceId,  // same 64-hex from metadata.user_id
       auth: {
         account_uuid: accountUuid,
         organization_uuid: orgUuid || ""
       },
       core: {
         session_id: sessionId,
         model: "",  // empty — don't reveal model choice
         is_interactive: true,
         entrypoint: "cli"
       },
       env: {
         platform: process.platform,
         arch: process.arch,
         node_version: process.version,
         version: cliVersion,
         build_time: "",  // omit — we don't know the real build time
         is_ci: false,
         is_claude_ai_auth: true
       }
     }
   }
   ```

3. [tier:heavy] **Events to send (per session):**

   | Event                     | When                                | Payload extras                                           |
   | ------------------------- | ----------------------------------- | -------------------------------------------------------- |
   | `tengu_started`           | After first successful API response | `{}`                                                     |
   | `tengu_startup_telemetry` | 2-5 seconds after `tengu_started`   | `{is_git: true/false, sandbox_enabled: false}`           |
   | `tengu_exit`              | On plugin shutdown / session end    | `{last_session_duration: <ms>, last_session_id: <uuid>}` |

4. [tier:medium] **Sending mechanism:**

   ```
   POST https://api.anthropic.com/api/event_logging/batch
   Headers:
     Content-Type: application/json
     Authorization: Bearer <oauth_token>
     anthropic-version: 2023-06-01
     User-Agent: claude-code/<version>
     x-service-name: claude-code
   Body:
     { events: [event1, event2, ...] }
   ```

5. [tier:heavy] **Timing:**
   - `tengu_started` — sent 0.5-2 seconds after first successful `/v1/messages` response (random jitter to avoid fingerprinting)
   - `tengu_startup_telemetry` — sent 2-5 seconds after `tengu_started` (random jitter)
   - `tengu_exit` — sent synchronously on shutdown (best-effort, no retry)
   - All events batched into a single `POST` where possible

6. [tier:heavy] **What we explicitly do NOT send:**
   - Per-turn events (`tengu_compact_*`, `tengu_tool_*`, `tengu_bash_*`)
   - Error events (`tengu_uncaught_exception`, etc.)
   - Model-specific events (`tengu_model_picker_hotkey`)
   - Any event containing file paths, code content, or tool results
   - GrowthBook experiment events (would require maintaining feature flag state)

7. [tier:heavy] **Safety rails:**
   - If the batch POST returns 401/403 → disable telemetry for the session (don't retry)
   - If the batch POST returns 400 → log debug message, disable telemetry
   - Max 1 batch per session (no repeated sends)
   - Total payload < 2KB (minimal data)

**Tests:**

- [ ] No events sent when `telemetry.emulateMinimal` is false (default)
- [ ] `tengu_started` sent after first successful API response when enabled
- [ ] `tengu_exit` sent on shutdown when enabled
- [ ] Event format matches `ClaudeCodeInternalEvent` schema
- [ ] `device_id` matches the metadata.user_id device_id
- [ ] `session_id` matches the metadata.user_id session_id
- [ ] No user content in any event payload
- [ ] No events sent after 401/403 from telemetry endpoint
- [ ] Timing has random jitter (not deterministic)
- [ ] Events work with and without OAuth account UUID
- [ ] Env var `OPENCODE_ANTHROPIC_TELEMETRY_EMULATE=1` enables telemetry

**Acceptance criteria:**

- When enabled: session produces 2-3 lifecycle events indistinguishable from a quiet Claude Code session
- When disabled (default): zero external telemetry calls
- No user content or operational details ever leave the client

---

### Phase 6: Deep QA Review (Wave 6)

**Goal:** Full protocol conformance verification against the reverse-engineering document.
**Duration:** 5-6 hours (adjusted from original 3-4h)
**Dependencies:** All previous phases complete

---

#### Task 6.1: Full Header Audit

**Scope:** Compare every outgoing HTTP header from the plugin against Section 3 (Headers), Section 4 (Fingerprinting), and Section 5 (Endpoints) of the reverse-engineering document.

**Method:**

1. [tier:medium] Add a test that captures the complete header set from a request to `/v1/messages`
2. [tier:heavy] Compare against the reference table in Section 3 of the doc
3. [tier:heavy] Verify:
   - [ ] `anthropic-version: 2023-06-01` present
   - [ ] `Authorization: Bearer <token>` present (OAuth mode)
   - [ ] `anthropic-beta` includes `oauth-2025-04-20` + all always-on betas
   - [ ] `Content-Type: application/json` present
   - [ ] `User-Agent: claude-cli/{ver} (external, cli)` for API calls
   - [ ] `x-app: cli` present
   - [ ] All `X-Stainless-*` headers present with correct values
   - [ ] `x-stainless-os` has correct casing (`macOS` not `MacOS`)
   - [ ] `x-stainless-package-version` is SDK version (not CLI version)
   - [ ] `x-stainless-helper` present with tool manifest (not `-method`)
   - [ ] `x-stainless-timeout: 600` present for non-streaming (absent for streaming)
   - [ ] `anthropic-dangerous-direct-browser-access` ABSENT
   - [ ] `x-stainless-helper-method` ABSENT
   - [ ] No extra/unknown headers present
4. [tier:medium] Produce a conformance report (pass/fail per header)

**Acceptance criteria:**

- 100% of required headers present with correct values
- 0% extra headers that Claude Code doesn't send

---

#### Task 6.2: Full Body Audit

**Scope:** Compare every field in the request body against Section 6 (Messaging) and Section 4 (Fingerprinting).

**Method:**

1. [tier:fast] Read the body-building code path in `index.mjs` to identify every field included in a `/v1/messages` request body
2. [tier:medium] Write a test to capture the complete raw request body for a typical `/v1/messages` call
3. [tier:heavy] Verify:
   - [ ] `model` field present and valid
   - [ ] `messages` array correctly formatted
   - [ ] `system` blocks have correct `cache_control` structure
   - [ ] `metadata.user_id` is JSON-stringified `{device_id, account_uuid, session_id}`
   - [ ] `metadata.user_id.device_id` is 64-char hex
   - [ ] `thinking` is `{type: "adaptive"}` for Opus/Sonnet 4.6
   - [ ] `temperature` is `1` when thinking disabled, ABSENT when thinking enabled
   - [ ] `stream: true` for streaming requests
   - [ ] `max_tokens` set appropriately per model
   - [ ] **`betas` array IS in body** for first-party /v1/messages (review fix: was incorrectly listed as "NOT in body" in v2.0)
   - [ ] `betas` array matches `anthropic-beta` header contents
   - [ ] `speed: "fast"` present only when fast mode enabled
   - [ ] No extra/unexpected body fields

---

#### Task 6.3: Full OAuth Flow Audit

**Scope:** Compare the OAuth implementation against Section 1 of the reverse-engineering document.

**Method:**

1. [tier:heavy] Trace a complete OAuth login flow and verify:
   - [ ] Authorization URL uses `https://claude.ai/oauth/authorize` (Claude.ai mode)
   - [ ] Client ID is `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
   - [ ] PKCE verifier is 32 random bytes → base64url
   - [ ] PKCE challenge is SHA-256(verifier) → base64url
   - [ ] State is independently generated (not same as verifier)
   - [ ] `code_challenge_method=S256`
   - [ ] `code=true` query parameter present
   - [ ] Scopes include all 5 Claude.ai scopes
   - [ ] Redirect URI format is correct
2. [tier:heavy] Trace a token exchange and verify:
   - [ ] POST to `https://platform.claude.com/v1/oauth/token`
   - [ ] Content-Type is `application/json` (not form-encoded)
   - [ ] Body includes `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`
   - [ ] User-Agent is `claude-code/{ver}` (minimal UA, not extended)
3. [tier:heavy] Trace a token refresh and verify:
   - [ ] Body includes `scope` field with all 5 scopes
   - [ ] `client_id` present
   - [ ] User-Agent is `claude-code/{ver}`
4. [tier:heavy] Verify scope migration:
   - [ ] Account with old 3-scope token marked `needsReauth`
   - [ ] Reauth prompt is clear and actionable

---

#### Task 6.4: Full Beta Composition Audit

**Scope:** Compare the outgoing `anthropic-beta` header AND `betas` body field against Section 3.5 of the reverse-engineering document for every supported model+provider combination.

**Method:**
Create a matrix test:

| Model                      | Provider   | Expected Header Betas                            | Expected Body Betas     | Notes                       |
| -------------------------- | ---------- | ------------------------------------------------ | ----------------------- | --------------------------- |
| `claude-opus-4-6`          | firstParty | All 11 always-on + context-1m + oauth-2025-04-20 | Same as header          | Most complete set           |
| `claude-opus-4-6` (fast)   | firstParty | Above + fast-mode-2026-02-01                     | Same as header          | Fast mode enabled           |
| `claude-opus-4-6-20260115` | firstParty | Same as `claude-opus-4-6` (prefix matched)       | Same as header          | Versioned model ID          |
| `claude-sonnet-4-6`        | firstParty | All 11 always-on + context-1m + oauth-2025-04-20 | Same as header          | Same as opus                |
| `claude-haiku-4-5`         | firstParty | All 11 minus context-1m + oauth-2025-04-20       | Same as header          | No 1M context               |
| `claude-opus-4-6`          | bedrock    | None (betas in body as `anthropic_beta`)         | All as `anthropic_beta` | Provider-specific           |
| (round-robin strategy)     | firstParty | Above minus prompt-caching-scope                 | Same as header          | Strategy-specific exclusion |

**Tests:**

- [ ] One test per row in the matrix
- [ ] Verify both header and body placement per provider
- [ ] Verify prefix-matched model IDs produce correct beta sets

---

#### Task 6.5: System Prompt Structure Audit

**Scope:** Compare the injected system prompt blocks against Section 2 of the reverse-engineering document.

**Method:**

1. [tier:fast] Read `buildSystemPromptBlocks()` in `index.mjs` to understand block ordering and structure
2. [tier:medium] Write a test to invoke `buildSystemPromptBlocks()` and capture/snapshot its output blocks
3. [tier:heavy] Verify:
   - [ ] Block 0 is billing header: `x-anthropic-billing-header: cc_version=...`
   - [ ] `cch=00000` (not random)
   - [ ] `cc_version` includes model ID (e.g., `2.1.80.claude-opus-4-6`)
   - [ ] Block 1 is identity string matching one of the three variants
   - [ ] Billing header has no `cache_control`
   - [ ] Identity block cache_control matches expected scope (none by default)
4. [tier:heavy] Verify billing header is skipped when `CLAUDE_CODE_ATTRIBUTION_HEADER=false`

---

#### Task 6.6: Response Handling Audit

**Scope:** Verify SSE event parsing, rate limit header extraction, usage tracking.

**Method:**

1. [tier:medium] Mock SSE stream with all event types:
   - `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`
2. [tier:heavy] Verify each event type is handled correctly
3. [tier:heavy] Verify rate limit headers extracted **from HTTP response** (not SSE stream):
   - `anthropic-ratelimit-unified-*-utilization`
   - `anthropic-ratelimit-unified-*-surpassed-threshold`
   - `x-should-retry`
   - `retry-after-ms`
4. [tier:heavy] Verify usage fields extracted: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
5. [tier:heavy] Verify cache hit rate calculation uses correct formula

---

#### Task 6.7: End-to-End Conformance Test

**Scope:** Full request-response cycle compared against Claude Code wire format.

**Method (two approaches, both acceptable):**

**Approach A — Network capture comparison (thorough):**

1. [tier:fast] Record a genuine Claude Code request (headers + body) using network proxy (mitmproxy/Charles)
2. [tier:fast] Record the plugin's request for the same prompt and model
3. [tier:heavy] Diff the two

**Approach B — Fixture-based comparison (practical, simpler):**

1. [tier:medium] Construct expected request fixtures from the reverse-engineering document Section 6
2. [tier:medium] Include exact header sets, body structure, metadata format
3. [tier:heavy] Compare plugin output against fixtures

**For either approach, verify:**

- Headers: exact match (allowing for dynamic values like tokens, timestamps, UUIDs)
- Body: structural match (same fields, same types, same format)
- Metadata: `user_id` JSON format with correct field types
- Betas: same set (header AND body)

4. [tier:medium] Document any remaining differences with justification

**Acceptance criteria:**

- Zero unexplained structural differences
- All dynamic values (tokens, UUIDs, timestamps) have correct format/length

---

#### Task 6.8: Telemetry Conformance Audit (if telemetry emulation enabled)

**Scope:** Verify telemetry events match Claude Code's format.

**Method:**

1. [tier:fast] Enable telemetry emulation and capture the outgoing batch
2. [tier:heavy] Verify:
   - [ ] Endpoint is `POST /api/event_logging/batch`
   - [ ] `event_type` is `"ClaudeCodeInternalEvent"`
   - [ ] `event_name` values are valid `tengu_*` names
   - [ ] `device_id` matches `metadata.user_id.device_id`
   - [ ] `session_id` matches `metadata.user_id.session_id`
   - [ ] No user content in any event
   - [ ] Headers include `x-service-name: claude-code`
   - [ ] Total events per session is 2-3 (plausible for short session)
3. [tier:heavy] Compare event structure against RE doc Section 7 (Telemetry) format

---

#### Task 6.9: Regression Test Suite

**Scope:** Create a permanent regression test suite that prevents future drift.

**Implementation:**

1. [tier:medium] Create `test/conformance/` directory with:
   - `headers.test.mjs` — header conformance tests (snapshot approach)
   - `body.test.mjs` — body structure tests
   - `oauth.test.mjs` — OAuth flow tests
   - `betas.test.mjs` — beta composition matrix
   - `system-prompt.test.mjs` — system prompt structure tests
   - `response.test.mjs` — response handling tests
   - `telemetry.test.mjs` — telemetry format tests
   - `fixtures/` — expected header sets, body structures as JSON files
2. [tier:medium] Each test file references the reverse-engineering doc section number
3. [tier:medium] **Snapshot tests:** Capture expected header/body shapes as fixture files, compare against them
4. [tier:medium] Add npm script: `npm run test:conformance`
5. [tier:medium] Add CI check that runs conformance tests on every PR

**Acceptance criteria:**

- All conformance tests pass
- Tests are documented with references to the source analysis
- CI integration configured
- Fixture files serve as living documentation of expected wire format

---

## 6. Acceptance Criteria

### Per-Phase Acceptance

| Phase | Criteria                                                                                   |
| ----- | ------------------------------------------------------------------------------------------ |
| 0     | All pre-flight tests documented. Go/no-go decisions made. `preflight-results.md` written.  |
| 1     | All CRITICAL fixes applied. Scope migration works. `npm test` passes. No regressions.      |
| 2     | All HIGH-priority fixes applied. Beta composition matches Claude Code exactly.             |
| 3     | All remaining MEDIUM/LOW fixes applied. Zero known fingerprint differences.                |
| 4     | Cache policy applied (TTL if supported). Cache hit rate > 50% after turn 3. Cost tracking. |
| 5     | Fast mode toggleable. Proactive rate limit reduces 429s. Telemetry emulation functional.   |
| 6     | 100% conformance on all audit tasks. Regression suite passes. Documentation updated.       |

### Global Acceptance

- [ ] All 20 gap items from Section 15 have corresponding fixes verified
- [ ] All 17 optimization opportunities have implementations, documented deferrals, or pre-flight rejections
- [ ] `npm test` passes with 0 failures
- [ ] `npm run test:conformance` passes with 0 failures
- [ ] No new runtime dependencies added (or justified if needed)
- [ ] `docs/mimese-http-header-system-prompt.md` updated to reflect all changes
- [ ] `README.md` updated with new features (fast mode, cache policy, telemetry emulation, etc.)
- [ ] `docs/plans/preflight-results.md` completed with all validation results

---

## 7. Definition of Done

A task is **Done** when ALL of the following are true:

1. **Code complete:** Implementation matches the specification in this plan
2. **Tests written:** Unit tests cover the changed behavior with >= 90% branch coverage
3. **Tests pass:** `npm test` passes with 0 failures, 0 new warnings
4. **No regressions:** Existing tests continue to pass unchanged (or updated with justification)
5. **Docs updated:** If the change affects user-facing behavior, `README.md` and/or `docs/mimese-http-header-system-prompt.md` updated
6. **Reviewed:** Changes reviewed against the corresponding section of `docs/claude-code-reverse-engineering.md`
7. **Config backward-compatible:** No existing config keys renamed or removed without migration
8. **Pre-flight honored:** Any task conditional on pre-flight results checks the documented result before implementation

A phase is **Done** when ALL tasks in the phase are Done AND the phase acceptance criteria are met.

The plan is **Done** when ALL phases are Done AND the global acceptance criteria are met AND Task 6.7 (end-to-end conformance) passes.

---

## 8. Rollback Strategy

### Per-Phase Rollback

Each phase is independently deployable (NFR4). Rollback is achieved by reverting the git commits for that phase.

### Feature-Level Rollback

For features that may cause runtime issues, the following config toggles serve as runtime rollback switches:

| Feature                  | Rollback Toggle                                           | Effect When Disabled                    |
| ------------------------ | --------------------------------------------------------- | --------------------------------------- |
| Signature emulation      | `emulateClaudeCodeSignature: false`                       | Disables all header/body mimicry        |
| Extended cache TTL       | `cachePolicy.ttl: "off"` or `cachePolicy.ttl: ""`         | Falls back to standard `ephemeral`      |
| Dynamic boundary marker  | `cachePolicy.boundaryMarker: false`                       | No boundary marker injected             |
| Fast mode                | `fastMode: false`                                         | No `speed` param in body                |
| Auto-strategy adaptation | `/anthropic set strategy sticky` + manual override flag   | Disables CONFIGURED→DEGRADED transition |
| Telemetry emulation      | `telemetry.emulateMinimal: false`                         | Zero telemetry events sent              |
| Token budget enforcement | `maxBudgetUsd: 0` or `OPENCODE_ANTHROPIC_IGNORE_BUDGET=1` | No budget warnings/blocks               |
| Betas in body            | (auto-disabled if PREFLIGHT_BODY_BETAS was "rejected")    | Header-only betas                       |

### Full Rollback

If a release causes widespread issues:

1. Revert to previous npm version: `npm install opencode-anthropic-fix@<previous>`
2. All config toggles default to safe/backward-compatible values
3. Pre-Phase-1 behavior is the baseline (no plan changes active)

### Versioned Emulation

Future consideration: Add a `signatureEmulationVersion` config key (`"v1"` = pre-plan, `"v2"` = post-plan) for clean A/B comparison during rollout.

---

## 9. Risk Register

| #   | Risk                                                       | Likelihood | Impact | Mitigation                                                                    |
| --- | ---------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------- |
| R1  | Claude Code updates to v2.2.x during implementation        | High       | Medium | Version fetching + dynamic adaptation. Re-run analysis on major updates.      |
| R2  | Extended cache TTL (`ttl: "1h"`) rejected by API           | Medium     | Medium | **Phase 0 validates first.** Fallback to standard `ephemeral` (no TTL).       |
| R3  | Always-on betas cause errors on some API configurations    | Low        | Medium | Keep `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` escape hatch.                   |
| R4  | Proactive rate limit headers not present on all endpoints  | Medium     | Low    | Graceful degradation: only act when headers present. Phase 0 validates.       |
| R5  | Auto-strategy adaptation causes unnecessary rotation       | Low        | Medium | Requires 3+ rate limits in 5-min window (not single event). Manual override.  |
| R6  | SDK version changes between Claude Code releases           | High       | Low    | Auto-fetch or maintain a version map updated by upstream watcher.             |
| R7  | Breaking changes to Anthropic API invalidate assumptions   | Low        | High   | Regression test suite catches drift. Monitoring via upstream watcher.         |
| R8  | Fast mode not available for all subscription tiers         | Medium     | Low    | Phase 0 validates. Auto-disable on 400 error.                                 |
| R9  | OAuth scope change breaks existing refresh tokens          | High       | High   | **`hasRequiredScopes()` migration.** Graceful reauth prompt, not crash.       |
| R10 | `betas` in request body rejected by API                    | Medium     | Medium | **Phase 0 validates.** Conditional injection, header-only fallback.           |
| R11 | Telemetry endpoint rejects events from non-Claude-Code     | Medium     | Low    | **Phase 0 validates.** Telemetry disabled by default. Auto-disable on reject. |
| R12 | Dynamic boundary marker splits OpenCode prompt incorrectly | Medium     | Medium | Experimental, opt-in only. Heuristic split with conservative fallback.        |

---

## Appendix A: Task Dependency Graph

```
Phase 0 (Pre-Flight)
  ├─ 0.1 validate cache TTL
  ├─ 0.2 validate body betas
  ├─ 0.3 validate fast mode
  ├─ 0.4 validate adaptive thinking
  ├─ 0.5 validate rate limit headers
  ├─ 0.6 validate telemetry endpoint
  └─ 0.7 document results (depends on 0.1-0.6)
       │
Phase 1 (Critical) — depends on Phase 0
  ├─ 1.1 metadata.user_id (+ deviceId migration)
  ├─ 1.2 remove dangerous-browser-access
  ├─ 1.3 OAuth scopes + code=true + refresh scope + scope migration
  ├─ 1.4 adaptive thinking (depends on 0.4 result)
  └─ 1.5 temperature handling (depends on 1.4 for thinking detection)
       │
Phase 2 (High) — depends on Phase 1
  ├─ 2.1 beta composition (depends on 1.4 for model awareness)
  ├─ 2.2 User-Agent prefix
  ├─ 2.3 stainless-package-version
  └─ 2.4 betas in body (depends on 0.2 result, 2.1 for beta array)
       │
Phase 3 (Medium/Low) — depends on Phase 2
  ├─ 3.1 OS casing
  ├─ 3.2 billing header
  ├─ 3.3 stainless-helper
  ├─ 3.4 stainless-timeout
  ├─ 3.5 OAuth state
  └─ 3.6 version staleness (depends on 2.2 for consistent version)
       │
Phase 4 (Token Optimization) — depends on Phase 3
  ├─ 4.1 extended cache TTL (depends on 0.1 result)
  ├─ 4.2 cache scope (moved from Phase 3 for NFR4 compliance)
  ├─ 4.3 dynamic boundary marker (depends on 4.1, 4.2) [EXPERIMENTAL, OPT-IN]
  ├─ 4.4 cache hit rate tracking
  └─ 4.5 token budget awareness
       │
Phase 5 (Speed & Adaptive) — depends on Phase 4
  ├─ 5.1 fast mode (depends on 0.3 result, 2.1 for beta)
  ├─ 5.2 proactive rate limit (depends on 0.5 result, 4.4 for metrics infra)
  ├─ 5.3 x-should-retry support
  ├─ 5.4 auto-strategy adaptation (depends on 5.2)
  └─ 5.5 minimal telemetry emulation (depends on 0.6 result, 1.1 for deviceId)
       │
Phase 6 (QA) — depends on ALL above
  ├─ 6.1 header audit
  ├─ 6.2 body audit
  ├─ 6.3 OAuth audit
  ├─ 6.4 beta audit
  ├─ 6.5 system prompt audit
  ├─ 6.6 response handling audit
  ├─ 6.7 end-to-end conformance (depends on ALL above)
  ├─ 6.8 telemetry conformance audit
  └─ 6.9 regression test suite (depends on ALL above)
```

## Appendix B: Files Impact Matrix

| File                 | Phase 0 | Phase 1            | Phase 2        | Phase 3     | Phase 4    | Phase 5        | Phase 6 |
| -------------------- | ------- | ------------------ | -------------- | ----------- | ---------- | -------------- | ------- |
| `index.mjs`          |         | ✏️ 1.1,1.2,1.4,1.5 | ✏️ 2.1,2.3,2.4 | ✏️ 3.1-3.4  | ✏️ 4.1-4.5 | ✏️ 5.1-5.5     | 🔍      |
| `lib/oauth.mjs`      |         | ✏️ 1.3             | ✏️ 2.2         | ✏️ 3.5, 3.6 |            |                | 🔍      |
| `lib/config.mjs`     |         | ✏️ 1.1             |                |             | ✏️ 4.5     | ✏️ 5.1,5.4,5.5 | 🔍      |
| `lib/storage.mjs`    |         | ✏️ 1.1             |                |             |            |                | 🔍      |
| `lib/accounts.mjs`   |         |                    |                |             |            | ✏️ 5.2, 5.4    | 🔍      |
| `lib/rotation.mjs`   |         |                    |                |             |            | ✏️ 5.2         | 🔍      |
| `lib/backoff.mjs`    |         |                    |                |             |            | ✏️ 5.3         | 🔍      |
| `index.test.mjs`     |         | ✏️                 | ✏️             | ✏️          | ✏️         | ✏️             | ✏️      |
| `lib/*.test.mjs`     |         | ✏️                 | ✏️             | ✏️          | ✏️         | ✏️             | ✏️      |
| `test/conformance/*` |         |                    |                |             |            |                | ✏️ NEW  |
| `test/preflight/*`   | ✏️ NEW  |                    |                |             |            |                |         |
| `docs/mimese-*.md`   |         |                    |                | ✏️          |            | ✏️             | ✏️      |
| `docs/plans/*.md`    | ✏️      |                    |                |             |            |                |         |
| `README.md`          |         |                    |                |             | ✏️         | ✏️             | ✏️      |

Legend: ✏️ = Modified, 🔍 = Audited, NEW = Created

---

## Appendix C: Telemetry Emulation Threat Model

### What Anthropic can detect without telemetry emulation

| Signal                                 | Visibility   | Risk                                                            |
| -------------------------------------- | ------------ | --------------------------------------------------------------- |
| OAuth token makes inference calls      | Always       | Expected — this is what OAuth is for                            |
| Zero `tengu_*` events for session      | Correlatable | "This token sends messages but no lifecycle events" — anomalous |
| No GrowthBook feature flag fetches     | Correlatable | "This token never fetches feature flags" — anomalous            |
| No `/api/oauth/account/settings` calls | Correlatable | "This token never checks account settings" — anomalous          |

### What telemetry emulation addresses

| Signal           | With Emulation                               | Risk Reduction                              |
| ---------------- | -------------------------------------------- | ------------------------------------------- |
| Lifecycle events | 2-3 events matching real Claude Code format  | High — removes zero-event signal            |
| Event timing     | Plausible startup/exit pattern               | Medium — not per-turn matched but plausible |
| System info      | Real platform/arch/node (already in headers) | Low — no new info exposed                   |

### What telemetry emulation does NOT address

| Signal                          | Status   | Rationale                                                               |
| ------------------------------- | -------- | ----------------------------------------------------------------------- |
| GrowthBook feature flag fetches | NOT SENT | Would require maintaining feature flag state — too complex, too fragile |
| Account settings fetches        | NOT SENT | Would need to handle response correctly — scope creep                   |
| Per-turn tool events            | NOT SENT | Would require faking tool use patterns — too detectable if wrong        |
| Version check events            | NOT SENT | Minimal value, could reveal fake version if format drifts               |
| Error/crash events              | NOT SENT | Would be fabricated — ethical concern                                   |

### Privacy guarantees

1. **No user content ever transmitted** — prompts, code, file paths, tool results never included
2. **Opt-in only** — `telemetry.emulateMinimal: false` by default
3. **System info only** — platform, arch, node version (already visible in every API request header)
4. **Disable on reject** — if endpoint returns auth error, telemetry auto-disables for the session
5. **Auditable** — every event payload is documented in this plan, no dynamic content generation

---

_Plan generated from analysis of `@anthropic-ai/claude-code@2.1.80` bundle._
_Reference: `docs/claude-code-reverse-engineering.md` (1,703 lines, 15 sections)_
_Version 3.0 incorporates 16 review corrections, Phase 0 pre-flight, telemetry emulation strategy, and rollback framework._
_Date: 2026-03-20_
