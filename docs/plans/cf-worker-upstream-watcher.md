# Implementation Plan: Cloudflare Worker Upstream Sync Watcher

**Plan ID:** `CFWSW-2026-04-03`
**Version:** 1.0
**Status:** Draft
**Supersedes:** `docs/plans/afcw-upstream-watcher.json` (GitHub Actions-only approach)
**Author:** Automated analysis of manual sync workflows (v2.1.80→v2.1.91)
**Reference:** `docs/mimese-http-header-system-prompt.md`, `docs/claude-code-reverse-engineering.md`

---

## Table of Contents

0. [Task Master List](#task-master-list) ← **Start here**
1. [Objective](#1-objective)
2. [Architecture Overview](#2-architecture-overview)
3. [Prerequisites](#3-prerequisites)
4. [Extraction Contract](#4-extraction-contract)
5. [Waves & Phases](#5-waves--phases)
   - [Wave 0 — Foundation (Phases 0–1)](#wave-0--foundation-phases-01)
   - [Wave 1 — Core Pipeline (Phases 2–3)](#wave-1--core-pipeline-phases-23)
   - [Wave 2 — Intelligence & Delivery (Phases 4–5)](#wave-2--intelligence--delivery-phases-45)
   - [Wave 3 — Hardening & Acceptance (Phase 6)](#wave-3--hardening--acceptance-phase-6)
6. [Global Acceptance Criteria](#6-global-acceptance-criteria)
7. [Global Definition of Done](#7-global-definition-of-done)
8. [Global Senior QA Review Checklist](#8-global-senior-qa-review-checklist)
9. [Risk Register](#9-risk-register)
10. [Rollback Strategy](#10-rollback-strategy)
11. [Troubleshooting Runbook](#11-troubleshooting-runbook)

---

## Task Master List

> Legend: `‖` = can run in parallel with adjacent tasks. `→` = sequential dependency. `⊘` = blocked until prerequisite completes.
>
> **Tier Directives** (model delegation protocol):
> | Tier | Agent | Use For | Cost |
> |------|-------|---------|------|
> | `[tier:fast]` | Haiku 4.5 | Search, grep, read, lookup, validation, fixture generation | 1x |
> | `[tier:medium]` | Sonnet 4.6 | Implementation, tests, refactoring, config, wrangler setup | 5x |
> | `[tier:heavy]` | Opus 4.6 | Architecture, LLM prompt design, security audit, conformance review | 20x |
>
> Every step is prefixed with its tier. Mixed steps are split. Multi-phase: explore (`[tier:fast]`) → execute (`[tier:medium]`). Cheapest-first.

### Summary

| Wave | Phase | Name                               | Tasks        | Estimated Effort |
| ---- | ----- | ---------------------------------- | ------------ | ---------------- |
| 0    | P0    | Scaffolding & Tooling              | 0.1–0.5      | 2–3h             |
| 0    | P1    | Extraction Engine                  | 1.1–1.5      | 4–6h             |
| 1    | P2    | Registry Poller & Diff             | 2.1–2.5      | 3–4h             |
| 1    | P3    | Baseline KV & State Machine        | 3.1–3.5      | 3–4h             |
| 2    | P4    | LLM Analysis Gate (Kimi K2.5)      | 4.1–4.5      | 4–6h             |
| 2    | P5    | GitHub Delivery (PR/Issue)         | 5.1–5.5      | 3–4h             |
| 3    | P6    | Hardening, E2E & System Acceptance | 6.1–6.6      | 4–6h             |
| —    | —     | **Total**                          | **36 tasks** | **~23–33h**      |

---

## 1. Objective

Automate the detection and response pipeline for upstream `@anthropic-ai/claude-code` releases:

1. **Detect** — Poll npm registry every 15 min via Cloudflare Cron Trigger
2. **Extract** — Download tarball, extract `cli.js`, run deterministic regex extraction of ~30 mimese-critical constants
3. **Diff** — Compare extracted contract against baseline stored in KV
4. **Classify** — Trivial (version/timestamp only) vs. Non-trivial (beta flags, OAuth, system prompt, SDK version changed)
5. **Respond** — Trivial: auto-generate PR via GitHub API. Non-trivial: invoke Kimi K2.5 for semantic analysis, create Issue with findings
6. **Converge** — Idempotent operations ensure exactly-once PR/Issue creation per upstream version

**Success metric:** Time from upstream npm publish to PR/Issue creation < 20 minutes for trivial changes, < 30 minutes for non-trivial.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Worker Runtime                   │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Cron Trigger  │───▶│ Registry     │───▶│ Extractor     │  │
│  │ (*/15 * * * *)│    │ Poller       │    │ (regex engine)│  │
│  └──────────────┘    └──────────────┘    └───────┬───────┘  │
│                                                   │          │
│                    ┌──────────────────────────────┼──────┐   │
│                    │         Diff Engine           │      │   │
│                    │  baseline (KV) vs extracted   │      │   │
│                    └──────────────┬───────────────┘      │   │
│                                   │                       │   │
│                    ┌──────────────▼───────────────┐      │   │
│                    │       Classification          │      │   │
│                    │  trivial │ non-trivial │ none │      │   │
│                    └────┬─────┴──────┬──────┴─────┘      │   │
│                         │            │                    │   │
│              ┌──────────▼──┐  ┌──────▼────────────┐      │   │
│              │ Auto-PR     │  │ Kimi K2.5 Analysis│      │   │
│              │ (GitHub API)│  │ (Workers AI)      │      │   │
│              └─────────────┘  └──────┬────────────┘      │   │
│                                      │                    │   │
│                               ┌──────▼────────────┐      │   │
│                               │ Issue + Analysis   │      │   │
│                               │ (GitHub API)       │      │   │
│                               └────────────────────┘      │   │
│                                                            │   │
│  Storage:                                                  │   │
│  ├── KV: baseline contract, ETag, state, lock             │   │
│  └── R2: temporary bundles (auto-expire 24h)              │   │
└────────────────────────────────────────────────────────────┘
```

### Component Inventory

| Component   | Cloudflare Product                      | Purpose                                    |
| ----------- | --------------------------------------- | ------------------------------------------ |
| Poller      | Worker + Cron Trigger                   | Check npm registry every 15 min            |
| Extractor   | Worker (CPU)                            | Regex extraction from minified `cli.js`    |
| Baseline    | KV                                      | Store current contract + ETag + state      |
| Bundles     | R2                                      | Temporary tarball/cli.js storage (24h TTL) |
| Diff Engine | Worker (CPU)                            | JSON diff with severity classification     |
| LLM Gate    | Workers AI (`@cf/moonshotai/kimi-k2.5`) | Semantic analysis of non-trivial diffs     |
| Delivery    | Worker (fetch)                          | GitHub API for PR/Issue creation           |
| Lock        | KV (CAS)                                | Prevent concurrent runs from racing        |

### Secrets / Environment Bindings

| Binding        | Type         | Purpose                                  |
| -------------- | ------------ | ---------------------------------------- |
| `UPSTREAM_KV`  | KV Namespace | Baseline, state, ETag, lock              |
| `UPSTREAM_R2`  | R2 Bucket    | Temporary bundle storage                 |
| `AI`           | Workers AI   | Kimi K2.5 inference                      |
| `GITHUB_TOKEN` | Secret       | GitHub API (repo scope, create PR/Issue) |
| `GITHUB_REPO`  | Var          | `marco-jardim/opencode-anthropic-fix`    |
| `NPM_PACKAGE`  | Var          | `@anthropic-ai/claude-code`              |

---

## 3. Prerequisites

- [x] Cloudflare account (paid tier) with Workers, KV, R2, Workers AI enabled
- [ ] `wrangler` CLI installed and authenticated (`npx wrangler login`)
- [ ] GitHub personal access token with `repo` scope stored as Worker secret
- [ ] npm registry access (public, no auth needed for read)
- [ ] KV namespace created: `UPSTREAM_KV`
- [ ] R2 bucket created: `upstream-bundles` (lifecycle rule: delete after 24h)

---

## 4. Extraction Contract

The extraction engine must reliably extract these fields from the minified `cli.js` bundle. Each field has a primary regex and a fallback strategy.

### 4.1 Scalar Constants

| Field          | Example Value            | Regex Pattern                                    | Priority |
| -------------- | ------------------------ | ------------------------------------------------ | -------- |
| `version`      | `"2.1.91"`               | `VERSION\s*=\s*"(\d+\.\d+\.\d+)"`                | Critical |
| `build_time`   | `"2026-04-02T21:58:41Z"` | `BUILD_TIME\s*=\s*"(\d{4}-\d{2}-\d{2}T[\d:]+Z)"` | Critical |
| `sdk_version`  | `"0.208.0"`              | `VERSION\s*=\s*"(0\.\d+\.\d+)"` (SDK context)    | Critical |
| `sdk_token`    | `"sdk-zAZezfDKGoZuXXKe"` | `"(sdk-[A-Za-z0-9]{16})"`                        | High     |
| `billing_salt` | `"59cf53e54c78"`         | Pattern near billing hash function               | High     |
| `client_id`    | `"9d1c250a-..."`         | UUID pattern near OAuth authorize                | High     |

### 4.2 Collection Constants

| Field                 | Current Count | Extraction Strategy                                            |
| --------------------- | ------------- | -------------------------------------------------------------- |
| `beta_flags`          | 15+           | All strings matching `\w+-\d{4}-\d{2}-\d{2}` near beta builder |
| `always_on_betas`     | 5             | Flags in the always-on set (near `fV1` builder)                |
| `experimental_betas`  | 14            | Flags in experimental set                                      |
| `bedrock_unsupported` | 6             | Flags in bedrock exclusion list                                |
| `oauth_scopes`        | 5+2           | String arrays near OAuth authorize                             |
| `identity_strings`    | 3             | Known prefixes: `"You are Claude"`                             |

### 4.3 Structural Constants

| Field                     | Extraction Strategy                                    |
| ------------------------- | ------------------------------------------------------ |
| `oauth_endpoints`         | URLs matching `platform.claude.com/v1/oauth/*`         |
| `oauth_redirect_uri`      | URL matching `platform.claude.com/oauth/code/callback` |
| `system_prompt_structure` | Boundary markers, identity block patterns              |

### 4.4 Classification Rules

| Change Type                                     | Severity | Auto-PR?        |
| ----------------------------------------------- | -------- | --------------- |
| `version` only                                  | Trivial  | Yes             |
| `version` + `build_time` only                   | Trivial  | Yes             |
| `version` + `build_time` + `sdk_version` (same) | Trivial  | Yes             |
| `sdk_version` changed                           | Medium   | Yes (with note) |
| `beta_flags` added/removed                      | High     | No → LLM        |
| `oauth_*` changed                               | Critical | No → LLM        |
| `identity_strings` changed                      | Critical | No → LLM        |
| `billing_salt` changed                          | Critical | No → LLM        |
| `client_id` changed                             | Critical | No → LLM        |
| New unknown patterns detected                   | High     | No → LLM        |

---

## 5. Waves & Phases

---

### Wave 0 — Foundation (Phases 0–1)

**Goal:** Scaffolding, tooling, and a battle-tested extraction engine that can reliably parse any Claude Code bundle version.

---

#### Phase 0: Scaffolding & Tooling (Wave 0)

**Pre-flight checks:**

- [ ] Node 18+ available
- [ ] `wrangler` CLI authenticated
- [ ] Vitest available in repo root
- [ ] `worker/sync-watcher/` directory does not exist yet
- [ ] `package.json` `files` array excludes `worker/`

| #   | Task                                                 | Tier            | Duration | Parallel | Depends On | Output Files                                                                    |
| --- | ---------------------------------------------------- | --------------- | -------- | -------- | ---------- | ------------------------------------------------------------------------------- |
| 0.1 | Create `worker/sync-watcher/` directory structure    | `[tier:medium]` | 30 min   | ‖ 0.2    | —          | `worker/sync-watcher/{src/,test/,wrangler.toml,package.json,vitest.config.mjs}` |
| 0.2 | Create `wrangler.toml` with KV/R2/AI/Secret bindings | `[tier:medium]` | 20 min   | ‖ 0.1    | —          | `worker/sync-watcher/wrangler.toml`                                             |
| 0.3 | Create worker entry point skeleton (`src/index.mjs`) | `[tier:medium]` | 30 min   | →        | ⊘ 0.1      | `worker/sync-watcher/src/index.mjs`                                             |
| 0.4 | Create shared types/constants module                 | `[tier:medium]` | 20 min   | ‖ 0.3    | ⊘ 0.1      | `worker/sync-watcher/src/types.mjs`                                             |
| 0.5 | Verify `npm pack` excludes `worker/` from tarball    | `[tier:fast]`   | 10 min   | →        | ⊘ 0.1      | — (test only)                                                                   |

**Subtasks for 0.1:**

- 0.1.1 `[tier:fast]` — Verify `package.json` `files` array excludes `worker/`
- 0.1.2 `[tier:medium]` — Create directory tree: `worker/sync-watcher/{src/,test/,fixtures/}`
- 0.1.3 `[tier:medium]` — Create `worker/sync-watcher/package.json` with vitest, wrangler devDependencies
- 0.1.4 `[tier:medium]` — Create `worker/sync-watcher/vitest.config.mjs`

**Subtasks for 0.3:**

- 0.3.1 `[tier:medium]` — Implement `export default { scheduled(event, env, ctx) {} }` skeleton
- 0.3.2 `[tier:medium]` — Wire up env bindings type stubs (KV, R2, AI, secrets)
- 0.3.3 `[tier:medium]` — Add health check fetch handler for manual testing

**Tests (Phase 0):**

| Test ID | Description                                             | Edge Case?                 |
| ------- | ------------------------------------------------------- | -------------------------- |
| T0.1    | `wrangler.toml` parses without errors                   | —                          |
| T0.2    | Worker entry exports `scheduled` and `fetch` handlers   | —                          |
| T0.3    | `npm pack --dry-run` output excludes `worker/`          | Yes: verify glob edge case |
| T0.4    | vitest config resolves and runs zero tests successfully | —                          |

**Phase 0 Acceptance Criteria:**

- [ ] `worker/sync-watcher/` exists with valid `wrangler.toml`, `package.json`, entry point
- [ ] `wrangler dev` starts without errors (even if handlers are no-ops)
- [ ] `npm pack --dry-run` in repo root excludes all `worker/` files
- [ ] `vitest run` in `worker/sync-watcher/` exits 0

**Phase 0 Definition of Done:**

- [ ] All T0.x tests pass
- [ ] No lint errors in new files
- [ ] PR-ready: could merge this phase independently

**Phase 0 Senior QA Review:**

- [ ] Binding names match Cloudflare resource naming conventions
- [ ] `wrangler.toml` uses `compatibility_date` ≥ `2024-01-01`
- [ ] Worker entry does not import Node.js builtins incompatible with Workers runtime
- [ ] vitest config is isolated from root vitest config

---

#### Phase 1: Extraction Engine (Wave 0)

**Pre-flight checks:**

- [ ] Phase 0 complete and green
- [ ] At least 2 historical `cli.js` bundles available as test fixtures (v2.1.90, v2.1.91)
- [ ] Regex patterns from §4 documented

| #   | Task                                                       | Tier            | Duration | Parallel | Depends On | Output Files                                                           |
| --- | ---------------------------------------------------------- | --------------- | -------- | -------- | ---------- | ---------------------------------------------------------------------- |
| 1.1 | Implement scalar constant extractor                        | `[tier:medium]` | 60 min   | ‖ 1.2    | ⊘ Phase 0  | `worker/sync-watcher/src/extractor.mjs`                                |
| 1.2 | Implement collection constant extractor (betas, scopes)    | `[tier:medium]` | 90 min   | ‖ 1.1    | ⊘ Phase 0  | `worker/sync-watcher/src/extractor.mjs`                                |
| 1.3 | Implement structural extractor (OAuth endpoints, identity) | `[tier:medium]` | 60 min   | →        | ⊘ 1.1, 1.2 | `worker/sync-watcher/src/extractor.mjs`                                |
| 1.4 | Create test fixtures from real bundles (v2.1.90, v2.1.91)  | `[tier:fast]`   | 30 min   | ‖ 1.1    | ⊘ Phase 0  | `worker/sync-watcher/fixtures/{v2.1.90.snippet.js,v2.1.91.snippet.js}` |
| 1.5 | Implement canonical hashing (deterministic JSON → SHA-256) | `[tier:medium]` | 30 min   | ‖ 1.3    | ⊘ 1.1      | `worker/sync-watcher/src/hasher.mjs`                                   |

**Subtasks for 1.1:**

- 1.1.1 `[tier:fast]` — Research regex patterns by reading current `cli.js` bundles for VERSION, BUILD_TIME, SDK patterns
- 1.1.2 `[tier:medium]` — Implement `extractScalars(cliText)` → `{ version, buildTime, sdkVersion, sdkToken, billingSalt, clientId }`
- 1.1.3 `[tier:medium]` — Handle obfuscated variable names (regex anchored to value patterns, not var names)
- 1.1.4 `[tier:medium]` — Return `null` for any field that fails extraction (never throw)
- 1.1.5 `[tier:fast]` — Unit tests: exact match against known v2.1.91 values

**Subtasks for 1.2:**

- 1.2.1 `[tier:fast]` — Research beta flag extraction from minified beta builder function
- 1.2.2 `[tier:medium]` — Implement `extractBetas(cliText)` → `{ allBetas: string[], alwaysOn: string[], experimental: string[], bedrockUnsupported: string[] }`
- 1.2.3 `[tier:medium]` — Implement `extractOAuthScopes(cliText)` → `{ claudeAiScopes: string[], consoleScopes: string[] }`
- 1.2.4 `[tier:medium]` — Sort all arrays for deterministic comparison
- 1.2.5 `[tier:fast]` — Unit tests: verify against known flag sets from v2.1.91

**Subtasks for 1.3:**

- 1.3.1 `[tier:medium]` — Implement `extractOAuthEndpoints(cliText)` → `{ tokenUrl, revokeUrl, redirectUri, consoleHost }`
- 1.3.2 `[tier:medium]` — Implement `extractIdentityStrings(cliText)` → `string[]`
- 1.3.3 `[tier:medium]` — Implement `extractSystemPromptMarkers(cliText)` → `{ boundary, billingBlockPattern }`
- 1.3.4 `[tier:medium]` — Compose into `extractContract(cliText)` → full contract object

**Subtasks for 1.5:**

- 1.5.1 `[tier:medium]` — Implement `canonicalize(contract)` → deterministic JSON (sorted keys, sorted arrays, trimmed strings)
- 1.5.2 `[tier:medium]` — Implement `hashContract(contract)` → SHA-256 hex (first 16 chars)
- 1.5.3 `[tier:fast]` — Test: same input → same hash; different input → different hash

**Tests (Phase 1):**

| Test ID | Description                                                     | Edge Case?                     |
| ------- | --------------------------------------------------------------- | ------------------------------ |
| T1.1    | `extractScalars` returns correct values for v2.1.91 fixture     | —                              |
| T1.2    | `extractScalars` returns correct values for v2.1.90 fixture     | —                              |
| T1.3    | `extractScalars` returns `null` fields for garbage input        | Yes: malformed bundle          |
| T1.4    | `extractScalars` handles minified code with no whitespace       | Yes: ultra-minified            |
| T1.5    | `extractBetas` returns sorted arrays matching known v2.1.91 set | —                              |
| T1.6    | `extractBetas` detects added/removed flag between v90→v91       | Yes: empty diff                |
| T1.7    | `extractOAuthScopes` returns 5 claude.ai + 2 console scopes     | —                              |
| T1.8    | `extractOAuthEndpoints` returns all 3 OAuth URLs                | —                              |
| T1.9    | `extractIdentityStrings` returns 3 known strings                | —                              |
| T1.10   | `extractContract` composes all sub-extractors correctly         | —                              |
| T1.11   | `canonicalize` produces identical JSON for reordered input      | Yes: key order                 |
| T1.12   | `hashContract` is stable across calls                           | —                              |
| T1.13   | `hashContract` differs when `version` changes but betas don't   | —                              |
| T1.14   | `hashContract` differs when one beta flag is added              | —                              |
| T1.15   | Extraction works on a 2MB+ minified bundle (perf ≤ 500ms)       | Yes: large input               |
| T1.16   | `extractScalars` distinguishes CLI VERSION from SDK VERSION     | Yes: both `"0.208.0"` patterns |

**Phase 1 Acceptance Criteria:**

- [ ] `extractContract(cliText)` returns complete contract for v2.1.90 and v2.1.91 fixtures
- [ ] All extracted values match manually verified values (cross-ref with `index.mjs` constants)
- [ ] `hashContract` is deterministic and stable
- [ ] Extraction completes in < 500ms for a 2MB input
- [ ] Graceful degradation: partial extraction when some patterns don't match (returns nulls, doesn't throw)

**Phase 1 Definition of Done:**

- [ ] All T1.x tests pass (16+ tests)
- [ ] `extractContract` tested against 2+ real bundle versions
- [ ] No false positives (doesn't extract wrong values)
- [ ] Code is documented with JSDoc for each extraction function

**Phase 1 Senior QA Review:**

- [ ] Regex patterns are anchored appropriately (no runaway backtracking)
- [ ] SDK VERSION vs CLI VERSION disambiguation is robust (test T1.16)
- [ ] Canonical JSON sort is locale-independent
- [ ] SHA-256 implementation uses Web Crypto API (Workers-compatible, not Node `crypto`)
- [ ] Fixtures are sanitized (no actual secrets if any existed)
- [ ] No `eval()` or `new Function()` — pure regex extraction only

---

### Wave 1 — Core Pipeline (Phases 2–3)

**Goal:** Registry polling with ETag caching, diff engine, KV-backed baseline and state management.

---

#### Phase 2: Registry Poller & Diff Engine (Wave 1)

**Pre-flight checks:**

- [ ] Phase 1 complete and green
- [ ] KV namespace `UPSTREAM_KV` created
- [ ] R2 bucket `upstream-bundles` created with 24h lifecycle rule

| #   | Task                                                      | Tier            | Duration | Parallel | Depends On      | Output Files                           |
| --- | --------------------------------------------------------- | --------------- | -------- | -------- | --------------- | -------------------------------------- |
| 2.1 | Implement npm registry metadata fetcher with ETag caching | `[tier:medium]` | 45 min   | ‖ 2.2    | ⊘ Phase 1       | `worker/sync-watcher/src/registry.mjs` |
| 2.2 | Implement tarball downloader + cli.js extraction          | `[tier:medium]` | 60 min   | ‖ 2.1    | ⊘ Phase 1       | `worker/sync-watcher/src/tarball.mjs`  |
| 2.3 | Implement JSON diff engine with severity classification   | `[tier:medium]` | 45 min   | ‖ 2.1    | ⊘ Phase 1       | `worker/sync-watcher/src/differ.mjs`   |
| 2.4 | Integrate poller → extractor → differ pipeline            | `[tier:medium]` | 30 min   | →        | ⊘ 2.1, 2.2, 2.3 | `worker/sync-watcher/src/pipeline.mjs` |
| 2.5 | Implement R2 bundle storage (store cli.js, auto-expire)   | `[tier:medium]` | 20 min   | ‖ 2.4    | ⊘ 2.2           | `worker/sync-watcher/src/storage.mjs`  |

**Subtasks for 2.1:**

- 2.1.1 `[tier:medium]` — `fetchRegistryMetadata(env)` → `{ version, tarballUrl, etag, notModified: boolean }`
- 2.1.2 `[tier:medium]` — Store/retrieve ETag in KV key `registry:etag`
- 2.1.3 `[tier:medium]` — Handle `304 Not Modified` (short-circuit, no tarball download)
- 2.1.4 `[tier:medium]` — Handle npm registry errors (502, 503, timeout) with exponential backoff (max 2 retries)
- 2.1.5 `[tier:fast]` — Unit tests with mocked fetch responses

**Subtasks for 2.2:**

- 2.2.1 `[tier:medium]` — Download `.tgz` tarball via fetch
- 2.2.2 `[tier:medium]` — Extract `package/cli.js` from tar.gz stream (use `pako` or `fflate` for gzip, manual tar header parsing)
- 2.2.3 `[tier:medium]` — Handle alternate paths: `package/cli.mjs`, `package/dist/cli.js`
- 2.2.4 `[tier:medium]` — Size guard: reject bundles > 10MB
- 2.2.5 `[tier:fast]` — Unit tests with fixture `.tgz` (small synthetic tarball)

**Subtasks for 2.3:**

- 2.3.1 `[tier:medium]` — `diffContracts(baseline, extracted)` → `{ changed: boolean, severity, fields: { [key]: { from, to } } }`
- 2.3.2 `[tier:medium]` — Classify severity per §4.4 rules
- 2.3.3 `[tier:medium]` — Handle missing fields (new field in extracted = medium severity)
- 2.3.4 `[tier:fast]` — Tests for all severity classifications with fixture pairs

**Tests (Phase 2):**

| Test ID | Description                                                                    | Edge Case?             |
| ------- | ------------------------------------------------------------------------------ | ---------------------- |
| T2.1    | Registry fetch returns version and tarball URL for `@anthropic-ai/claude-code` | —                      |
| T2.2    | ETag caching: second call with same ETag returns `notModified: true`           | —                      |
| T2.3    | Registry 502 is retried and succeeds on retry                                  | Yes: transient failure |
| T2.4    | Registry timeout after 10s returns error (no hang)                             | Yes: slow registry     |
| T2.5    | Tarball extracts `package/cli.js` from valid `.tgz`                            | —                      |
| T2.6    | Tarball rejects > 10MB input                                                   | Yes: oversized bundle  |
| T2.7    | Tarball handles alternate path `package/cli.mjs`                               | Yes: path change       |
| T2.8    | Tarball returns error for corrupted `.tgz`                                     | Yes: corruption        |
| T2.9    | Diff: identical contracts → `{ changed: false }`                               | —                      |
| T2.10   | Diff: version-only change → `severity: "trivial"`                              | —                      |
| T2.11   | Diff: beta flag added → `severity: "high"`                                     | —                      |
| T2.12   | Diff: OAuth endpoint changed → `severity: "critical"`                          | —                      |
| T2.13   | Diff: new unknown field in extracted → `severity: "medium"`                    | Yes: schema evolution  |
| T2.14   | Pipeline: end-to-end mock run returns correct classification                   | —                      |
| T2.15   | R2 storage: put and get cli.js content round-trips correctly                   | —                      |

**Phase 2 Acceptance Criteria:**

- [ ] Poller correctly fetches and caches registry metadata with ETag
- [ ] Tarball extraction works on real `@anthropic-ai/claude-code` tarballs
- [ ] Diff engine correctly classifies all severity levels
- [ ] Pipeline composes poller → tarball → extract → diff without errors
- [ ] R2 storage stores and retrieves bundle content

**Phase 2 Definition of Done:**

- [ ] All T2.x tests pass (15+ tests)
- [ ] Manual `wrangler dev` test against live npm registry succeeds
- [ ] No unhandled promise rejections in any error path

**Phase 2 Senior QA Review:**

- [ ] Tar parsing doesn't use `eval` or shell commands (pure JS parsing)
- [ ] Gzip decompression uses Workers-compatible library (not Node zlib)
- [ ] ETag comparison is constant-time or at least safe from timing attacks (not security-critical but good practice)
- [ ] Fetch timeout is explicitly set (no reliance on Workers default timeout)
- [ ] R2 keys include version for namespacing

---

#### Phase 3: Baseline KV & State Machine (Wave 1)

**Pre-flight checks:**

- [ ] Phase 2 complete and green
- [ ] KV namespace writable from Worker

| #   | Task                                                                      | Tier            | Duration | Parallel | Depends On           | Output Files                           |
| --- | ------------------------------------------------------------------------- | --------------- | -------- | -------- | -------------------- | -------------------------------------- |
| 3.1 | Implement KV baseline store (get/set contract + hash)                     | `[tier:medium]` | 30 min   | ‖ 3.2    | ⊘ Phase 2            | `worker/sync-watcher/src/baseline.mjs` |
| 3.2 | Implement state machine (per-version state tracking)                      | `[tier:medium]` | 60 min   | ‖ 3.1    | ⊘ Phase 2            | `worker/sync-watcher/src/state.mjs`    |
| 3.3 | Implement distributed lock (KV CAS for cron dedup)                        | `[tier:medium]` | 30 min   | ‖ 3.1    | ⊘ Phase 2            | `worker/sync-watcher/src/lock.mjs`     |
| 3.4 | Implement baseline seeding (initial bootstrap from current `index.mjs`)   | `[tier:medium]` | 30 min   | →        | ⊘ 3.1                | `worker/sync-watcher/src/seed.mjs`     |
| 3.5 | Wire cron handler: lock → poll → extract → diff → classify → update state | `[tier:medium]` | 45 min   | →        | ⊘ 3.1, 3.2, 3.3, 3.4 | `worker/sync-watcher/src/index.mjs`    |

**Subtasks for 3.2:**

- 3.2.1 `[tier:heavy]` — Define state machine (preserving good ideas from `afcw-upstream-watcher.json`):

```
States: IDLE → DETECTED → ANALYZING → PR_CREATED → ISSUE_CREATED → DELIVERED → FAILED_RETRYABLE → DEAD_LETTER

Transitions:
  IDLE → DETECTED              (new version found, contract differs)
  DETECTED → ANALYZING         (non-trivial diff, invoking LLM)
  DETECTED → PR_CREATED        (trivial diff, auto-PR created)
  ANALYZING → ISSUE_CREATED    (LLM analysis complete, issue created)
  ANALYZING → PR_CREATED       (LLM says safe for auto-PR)
  PR_CREATED → DELIVERED       (confirmed PR exists on GitHub)
  ISSUE_CREATED → DELIVERED    (confirmed issue exists on GitHub)
  * → FAILED_RETRYABLE         (transient error, will retry)
  FAILED_RETRYABLE → DETECTED  (retry, re-enter pipeline)
  FAILED_RETRYABLE → DEAD_LETTER (retry limit exceeded: 6 attempts)

Terminal: DELIVERED, DEAD_LETTER
```

- 3.2.2 `[tier:medium]` — Implement `StateManager` class with `transition(version, event)` → validates and persists
- 3.2.3 `[tier:medium]` — State stored in KV key `state:<version>` as JSON
- 3.2.4 `[tier:medium]` — Monotonic: transitions only move forward (no backward except FAILED_RETRYABLE → DETECTED for retry)
- 3.2.5 `[tier:fast]` — Table-driven tests for all transitions + invalid transition rejection

**Subtasks for 3.3:**

- 3.3.1 `[tier:medium]` — `acquireLock(env, key, ttlMs)` using KV with metadata timestamp
- 3.3.2 `[tier:medium]` — `releaseLock(env, key)` — delete KV entry
- 3.3.3 `[tier:medium]` — Stale lock detection: if lock age > TTL, force-acquire
- 3.3.4 `[tier:fast]` — Tests: acquire/release, double-acquire fails, stale lock reclaimed

**Tests (Phase 3):**

| Test ID | Description                                                     | Edge Case?            |
| ------- | --------------------------------------------------------------- | --------------------- |
| T3.1    | Baseline get/set round-trips contract correctly                 | —                     |
| T3.2    | Baseline returns `null` when no baseline exists (first run)     | Yes: bootstrap        |
| T3.3    | State: IDLE → DETECTED on new version                           | —                     |
| T3.4    | State: DETECTED → PR_CREATED on trivial diff                    | —                     |
| T3.5    | State: DETECTED → ANALYZING on non-trivial diff                 | —                     |
| T3.6    | State: ANALYZING → ISSUE_CREATED on LLM analysis complete       | —                     |
| T3.7    | State: FAILED_RETRYABLE → DETECTED on retry (count incremented) | —                     |
| T3.8    | State: FAILED_RETRYABLE → DEAD_LETTER after 6 retries           | Yes: retry exhaustion |
| T3.9    | State: Invalid transition (e.g., IDLE → PR_CREATED) throws      | Yes: invalid path     |
| T3.10   | State: Idempotent — applying same event twice is safe           | Yes: idempotency      |
| T3.11   | Lock: acquire succeeds, second acquire fails                    | —                     |
| T3.12   | Lock: stale lock (age > TTL) is reclaimable                     | Yes: stale lock       |
| T3.13   | Lock: release then re-acquire succeeds                          | —                     |
| T3.14   | Cron handler: no new version → no state change, exits cleanly   | —                     |
| T3.15   | Cron handler: new trivial version → DETECTED state created      | —                     |
| T3.16   | Cron handler: concurrent cron → second run skipped (lock held)  | Yes: race condition   |
| T3.17   | Seed: generates valid baseline from current contract values     | —                     |

**Phase 3 Acceptance Criteria:**

- [ ] Baseline stored/retrieved from KV correctly
- [ ] State machine enforces valid transitions only
- [ ] Lock prevents concurrent cron executions
- [ ] Cron handler composes the full detection pipeline end-to-end
- [ ] First run (no baseline) triggers seeding, not an error

**Phase 3 Definition of Done:**

- [ ] All T3.x tests pass (17+ tests)
- [ ] State machine covers all transitions from §3.2.1
- [ ] `wrangler dev` cron simulation produces correct state transitions
- [ ] No data loss on Worker restart (all state in KV)

**Phase 3 Senior QA Review:**

- [ ] KV keys are namespaced to avoid collisions (e.g., `baseline:`, `state:`, `lock:`)
- [ ] State transitions are atomic (read-modify-write with version check or accept last-write-wins with idempotency)
- [ ] Lock TTL is appropriate (recommend 120s for a cron that runs every 15min)
- [ ] Seed baseline matches actual current values in `index.mjs`
- [ ] No infinite retry loops possible (dead letter after 6 attempts is enforced)

---

### Wave 2 — Intelligence & Delivery (Phases 4–5)

**Goal:** Kimi K2.5 analysis for non-trivial diffs, and GitHub API integration for PR/Issue creation.

---

#### Phase 4: LLM Analysis Gate (Kimi K2.5) (Wave 2)

**Pre-flight checks:**

- [ ] Phase 3 complete and green
- [ ] Workers AI binding available
- [ ] `@cf/moonshotai/kimi-k2.5` model accessible
- [ ] Structured output JSON schema tested against model

| #   | Task                                                                   | Tier            | Duration | Parallel | Depends On | Output Files                                 |
| --- | ---------------------------------------------------------------------- | --------------- | -------- | -------- | ---------- | -------------------------------------------- |
| 4.1 | Design LLM analysis prompt and structured output schema                | `[tier:heavy]`  | 60 min   | —        | ⊘ Phase 3  | `worker/sync-watcher/src/prompts.mjs`        |
| 4.2 | Implement Workers AI client for Kimi K2.5                              | `[tier:medium]` | 30 min   | ‖ 4.1    | ⊘ Phase 3  | `worker/sync-watcher/src/llm.mjs`            |
| 4.3 | Implement analysis orchestrator (diff → prompt → invoke → parse)       | `[tier:medium]` | 60 min   | →        | ⊘ 4.1, 4.2 | `worker/sync-watcher/src/analyzer.mjs`       |
| 4.4 | Implement fallback handling (LLM failure → create issue with raw diff) | `[tier:medium]` | 30 min   | →        | ⊘ 4.3      | `worker/sync-watcher/src/analyzer.mjs`       |
| 4.5 | Create analysis prompt test suite with fixture diffs                   | `[tier:medium]` | 45 min   | ‖ 4.3    | ⊘ 4.1      | `worker/sync-watcher/test/analyzer.test.mjs` |

**Subtasks for 4.1:**

- 4.1.1 `[tier:heavy]` — Design system prompt explaining: Claude Code mimicry context, what each contract field means, how changes affect the `opencode-anthropic-fix` codebase
- 4.1.2 `[tier:heavy]` — Design user prompt template: injects baseline contract, new contract, and diff with severity
- 4.1.3 `[tier:heavy]` — Design structured output JSON schema:
  ```json
  {
    "type": "object",
    "properties": {
      "safe_for_auto_pr": { "type": "boolean" },
      "risk_level": { "enum": ["low", "medium", "high", "critical"] },
      "summary": { "type": "string", "maxLength": 500 },
      "changes": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "field": { "type": "string" },
            "description": { "type": "string" },
            "impact": { "enum": ["none", "cosmetic", "functional", "breaking"] },
            "action_required": { "type": "string" }
          }
        }
      },
      "recommended_file_changes": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "file": { "type": "string" },
            "description": { "type": "string" }
          }
        }
      },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
    },
    "required": ["safe_for_auto_pr", "risk_level", "summary", "changes", "confidence"]
  }
  ```
- 4.1.4 `[tier:heavy]` — Enable reasoning mode (`enable_thinking: true`) for complex diffs
- 4.1.5 `[tier:fast]` — Validate schema against Kimi K2.5 structured output capabilities

**Subtasks for 4.2:**

- 4.2.1 `[tier:medium]` — `invokeLLM(env, messages, schema)` wrapper around `env.AI.run()`
- 4.2.2 `[tier:medium]` — Handle streaming vs non-streaming (use non-streaming for structured output)
- 4.2.3 `[tier:medium]` — Parse response, validate against schema, return typed result
- 4.2.4 `[tier:medium]` — Handle model errors: timeout (120s), rate limit (429), server error (500/503)
- 4.2.5 `[tier:medium]` — Log token usage for cost monitoring

**Subtasks for 4.3:**

- 4.3.1 `[tier:medium]` — `analyzeContractDiff(env, baseline, extracted, diff)` → `AnalysisResult`
- 4.3.2 `[tier:medium]` — Include both contracts + diff in context (well within 256k limit)
- 4.3.3 `[tier:medium]` — Parse and validate LLM response against schema
- 4.3.4 `[tier:medium]` — If `safe_for_auto_pr && confidence > 0.8` → return "auto-pr" recommendation
- 4.3.5 `[tier:medium]` — If not safe or low confidence → return "create-issue" recommendation

**Tests (Phase 4):**

| Test ID | Description                                                            | Edge Case?               |
| ------- | ---------------------------------------------------------------------- | ------------------------ |
| T4.1    | LLM client sends correct model ID and parameters                       | —                        |
| T4.2    | LLM client handles 429 rate limit with retry                           | Yes: rate limited        |
| T4.3    | LLM client handles timeout (> 120s)                                    | Yes: slow model          |
| T4.4    | LLM client handles malformed response (invalid JSON)                   | Yes: model hallucination |
| T4.5    | Analyzer: trivial diff (version only) → `safe_for_auto_pr: true`       | —                        |
| T4.6    | Analyzer: beta flag change → detailed analysis with field-level impact | —                        |
| T4.7    | Analyzer: LLM failure → fallback to raw diff issue                     | Yes: total LLM failure   |
| T4.8    | Analyzer: LLM returns `confidence < 0.5` → force "create-issue"        | Yes: low confidence      |
| T4.9    | Prompt renders correctly with fixture baseline and extracted contracts | —                        |
| T4.10   | Structured output schema validates known good responses                | —                        |
| T4.11   | Structured output schema rejects missing required fields               | Yes: partial response    |

**Phase 4 Acceptance Criteria:**

- [ ] LLM analysis produces structured JSON output conforming to schema
- [ ] Fallback path works when LLM is unavailable
- [ ] Low-confidence results never trigger auto-PR
- [ ] Cost per analysis < $0.10 (estimated: ~50K input tokens × $0.60/M + ~2K output × $3.00/M = ~$0.04)

**Phase 4 Definition of Done:**

- [ ] All T4.x tests pass (11+ tests)
- [ ] At least one end-to-end test with mocked Workers AI response
- [ ] Prompt documented in `worker/sync-watcher/src/prompts.mjs` with version comment
- [ ] Token usage logged for cost monitoring

**Phase 4 Senior QA Review:**

- [ ] System prompt does not leak internal codebase secrets
- [ ] Structured output schema is strict enough to prevent prompt injection in output
- [ ] Reasoning mode (`enable_thinking`) only enabled for complex diffs (cost control)
- [ ] Fallback path doesn't silently swallow important analysis
- [ ] Model ID is configurable (env var) for easy model swaps
- [ ] No PII in prompts or logs

---

#### Phase 5: GitHub Delivery (PR/Issue Creation) (Wave 2)

**Pre-flight checks:**

- [ ] Phase 4 complete and green
- [ ] `GITHUB_TOKEN` secret configured in Worker
- [ ] Token has `repo` scope (verified via `GET /user`)

| #   | Task                                                                       | Tier            | Duration | Parallel | Depends On | Output Files                           |
| --- | -------------------------------------------------------------------------- | --------------- | -------- | -------- | ---------- | -------------------------------------- |
| 5.1 | Implement GitHub API client (auth, error handling, rate limiting)          | `[tier:medium]` | 45 min   | —        | ⊘ Phase 4  | `worker/sync-watcher/src/github.mjs`   |
| 5.2 | Implement auto-PR creation for trivial changes                             | `[tier:medium]` | 60 min   | ‖ 5.3    | ⊘ 5.1      | `worker/sync-watcher/src/delivery.mjs` |
| 5.3 | Implement issue creation for non-trivial changes                           | `[tier:medium]` | 30 min   | ‖ 5.2    | ⊘ 5.1      | `worker/sync-watcher/src/delivery.mjs` |
| 5.4 | Implement idempotent delivery (check before create)                        | `[tier:medium]` | 30 min   | →        | ⊘ 5.2, 5.3 | `worker/sync-watcher/src/delivery.mjs` |
| 5.5 | Wire delivery into cron handler (classification → delivery → state update) | `[tier:medium]` | 30 min   | →        | ⊘ 5.4      | `worker/sync-watcher/src/index.mjs`    |

**Subtasks for 5.2:**

- 5.2.1 `[tier:medium]` — Create branch `auto/sync-<version>` via GitHub API (create ref)
- 5.2.2 `[tier:medium]` — Generate file patches: update `index.mjs` (version, build_time, SDK map entry), `index.test.mjs`, `test/conformance/regression.test.mjs`, `CHANGELOG.md`, `package.json`
- 5.2.3 `[tier:medium]` — Commit changes via GitHub API (create tree + commit + update ref)
- 5.2.4 `[tier:medium]` — Create PR with title: `chore: sync emulation to Claude Code v{version}` and body with diff summary
- 5.2.5 `[tier:medium]` — Add labels: `auto-sync`, `trivial`

**Subtasks for 5.3:**

- 5.3.1 `[tier:medium]` — Create issue with title: `[Upstream] Claude Code v{version} — non-trivial changes detected`
- 5.3.2 `[tier:medium]` — Issue body: LLM analysis summary, field-level changes, recommended file changes, raw diff
- 5.3.3 `[tier:medium]` — Add labels: `upstream-sync`, `needs-review`

**Subtasks for 5.4:**

- 5.4.1 `[tier:medium]` — Before creating PR: search for existing PR with head `auto/sync-<version>`
- 5.4.2 `[tier:medium]` — Before creating issue: search for existing issue with title containing version
- 5.4.3 `[tier:medium]` — If exists: update body (append new analysis), don't duplicate
- 5.4.4 `[tier:fast]` — Tests for idempotent create and update paths

**Tests (Phase 5):**

| Test ID | Description                                                          | Edge Case?               |
| ------- | -------------------------------------------------------------------- | ------------------------ |
| T5.1    | GitHub client authenticates and makes API calls                      | —                        |
| T5.2    | GitHub client handles 403 (bad token) with clear error               | Yes: auth failure        |
| T5.3    | GitHub client handles rate limit (403 + `X-RateLimit-Remaining: 0`)  | Yes: rate limited        |
| T5.4    | Auto-PR: creates branch, commits files, opens PR                     | —                        |
| T5.5    | Auto-PR: branch already exists → updates existing PR                 | Yes: idempotent          |
| T5.6    | Auto-PR: PR title and body contain correct version info              | —                        |
| T5.7    | Issue: creates issue with LLM analysis in body                       | —                        |
| T5.8    | Issue: issue with same version exists → updates body                 | Yes: idempotent          |
| T5.9    | Delivery: trivial classification → PR path                           | —                        |
| T5.10   | Delivery: non-trivial classification → Issue path                    | —                        |
| T5.11   | Delivery: state transitions to PR_CREATED/ISSUE_CREATED              | —                        |
| T5.12   | Full cron: poll → extract → diff → classify → deliver → state update | —                        |
| T5.13   | Auto-PR: generates correct file content patches for version bump     | Yes: content correctness |

**Phase 5 Acceptance Criteria:**

- [ ] Trivial changes produce a valid, mergeable PR
- [ ] Non-trivial changes produce an issue with structured analysis
- [ ] Duplicate detection prevents PR/Issue spam
- [ ] State machine transitions to terminal state after delivery
- [ ] GitHub API errors don't leave state in inconsistent position

**Phase 5 Definition of Done:**

- [ ] All T5.x tests pass (13+ tests)
- [ ] End-to-end test with mocked GitHub API completes full cycle
- [ ] PR content includes version-correct file patches
- [ ] Issue content includes LLM analysis (or raw diff on LLM failure)

**Phase 5 Senior QA Review:**

- [ ] GitHub token has minimal required scope (avoid broad permissions)
- [ ] Branch name is deterministic per version (prevents duplicates)
- [ ] PR patches are generated from templates, not arbitrary LLM output (for trivial path)
- [ ] Issue body is sanitized (no raw code injection from upstream bundle)
- [ ] Rate limit handling includes backoff, not just retry
- [ ] Commit author is clearly identified as bot (e.g., `sync-watcher[bot]`)

---

### Wave 3 — Hardening & Acceptance (Phase 6)

**Goal:** End-to-end validation, failure injection, observability, and system acceptance testing.

---

#### Phase 6: Hardening, E2E & System Acceptance (Wave 3)

**Pre-flight checks:**

- [ ] All phases 0–5 complete and green
- [ ] Worker deployed to Cloudflare (staging environment or preview)
- [ ] GitHub test repo available for dry-run PR/Issue creation

| #   | Task                                                                   | Tier            | Duration | Parallel | Depends On      | Output Files                                |
| --- | ---------------------------------------------------------------------- | --------------- | -------- | -------- | --------------- | ------------------------------------------- |
| 6.1 | End-to-end integration test: full cron cycle with mocked externals     | `[tier:medium]` | 60 min   | ‖ 6.2    | ⊘ Phase 5       | `worker/sync-watcher/test/e2e.test.mjs`     |
| 6.2 | Failure injection tests: registry down, LLM timeout, GitHub 500        | `[tier:medium]` | 60 min   | ‖ 6.1    | ⊘ Phase 5       | `worker/sync-watcher/test/failure.test.mjs` |
| 6.3 | Observability: structured logging, cost tracking, alert on DEAD_LETTER | `[tier:medium]` | 45 min   | ‖ 6.1    | ⊘ Phase 5       | `worker/sync-watcher/src/observability.mjs` |
| 6.4 | Manual validation: deploy to staging, trigger with real npm data       | `[tier:medium]` | 30 min   | →        | ⊘ 6.1, 6.2, 6.3 | — (manual)                                  |
| 6.5 | Documentation: README, architecture diagram, runbook                   | `[tier:medium]` | 30 min   | ‖ 6.4    | ⊘ 6.1           | `worker/sync-watcher/README.md`             |
| 6.6 | Production deployment with seed baseline                               | `[tier:medium]` | 20 min   | →        | ⊘ 6.4, 6.5      | — (deploy)                                  |

**Subtasks for 6.1:**

- 6.1.1 `[tier:medium]` — Simulate: new version detected → trivial → PR created → DELIVERED
- 6.1.2 `[tier:medium]` — Simulate: new version detected → non-trivial → LLM analysis → Issue created → DELIVERED
- 6.1.3 `[tier:medium]` — Simulate: no new version → no action → IDLE (no state change)
- 6.1.4 `[tier:medium]` — Simulate: same version re-detected → idempotent (no duplicate PR/Issue)
- 6.1.5 `[tier:medium]` — Simulate: two cron fires within lock TTL → second skipped

**Subtasks for 6.2:**

- 6.2.1 `[tier:medium]` — Registry down: poller fails → FAILED_RETRYABLE → retry on next cron
- 6.2.2 `[tier:medium]` — LLM timeout: analyzer falls back to raw diff issue
- 6.2.3 `[tier:medium]` — GitHub 500: delivery fails → FAILED_RETRYABLE
- 6.2.4 `[tier:medium]` — All three fail simultaneously → graceful degradation, no crash
- 6.2.5 `[tier:medium]` — Retry exhaustion (6×) → DEAD_LETTER state + alert

**Subtasks for 6.3:**

- 6.3.1 `[tier:medium]` — Structured JSON logs for each pipeline stage
- 6.3.2 `[tier:medium]` — Log fields: `{ stage, version, severity, duration_ms, tokens_used, cost_usd, error? }`
- 6.3.3 `[tier:medium]` — DEAD_LETTER alert: store alert in KV for dashboard/webhook pickup
- 6.3.4 `[tier:fast]` — Verify logs are queryable via `wrangler tail`

**Tests (Phase 6):**

| Test ID | Description                                                           | Edge Case?        |
| ------- | --------------------------------------------------------------------- | ----------------- |
| T6.1    | E2E: trivial path completes in < 30s (mocked)                         | —                 |
| T6.2    | E2E: non-trivial path completes in < 60s (mocked)                     | —                 |
| T6.3    | E2E: no-change path completes in < 5s                                 | —                 |
| T6.4    | E2E: idempotent re-run creates no duplicates                          | —                 |
| T6.5    | E2E: concurrent cron dedup works                                      | Yes: race         |
| T6.6    | Failure: registry 502 → FAILED_RETRYABLE                              | —                 |
| T6.7    | Failure: LLM timeout → fallback issue created                         | —                 |
| T6.8    | Failure: GitHub 500 → FAILED_RETRYABLE                                | —                 |
| T6.9    | Failure: all externals down → no crash, clean error log               | Yes: total outage |
| T6.10   | Failure: 6 retries → DEAD_LETTER + alert stored                       | —                 |
| T6.11   | Observability: logs contain all required fields                       | —                 |
| T6.12   | Observability: cost_usd is calculated correctly from token usage      | —                 |
| T6.13   | Manual: deploy to staging succeeds with `wrangler deploy`             | —                 |
| T6.14   | Manual: cron trigger via dashboard produces expected state transition | —                 |

**Phase 6 Acceptance Criteria:**

- [ ] Full pipeline works end-to-end (trivial and non-trivial paths)
- [ ] All failure scenarios converge to terminal state (DELIVERED or DEAD_LETTER)
- [ ] No scenario leaves system in stuck state
- [ ] Observability provides enough data to debug any pipeline failure
- [ ] Production deployment succeeds with seeded baseline

**Phase 6 Definition of Done:**

- [ ] All T6.x tests pass (14+ tests)
- [ ] Manual staging validation documented with screenshots/logs
- [ ] `wrangler deploy` to production succeeds
- [ ] First real cron fire produces expected "no change" result
- [ ] README and runbook written

**Phase 6 Senior QA Review:**

- [ ] E2E tests don't hit real external services (fully mocked)
- [ ] Failure injection covers all external dependency failure modes
- [ ] DEAD_LETTER alert mechanism is reliable (KV-based, not just console.log)
- [ ] Production deployment uses `wrangler deploy` (not `wrangler publish` — deprecated)
- [ ] Seed baseline values match current `index.mjs` at deploy time
- [ ] Worker memory usage stays within Workers limits (128MB)
- [ ] Cron handler completes within Workers CPU time limit (30s for cron triggers on paid plan)
- [ ] No hardcoded secrets in source code

---

## 6. Global Acceptance Criteria

| #     | Criterion                                                                          | Measurement                                                  |
| ----- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| GA-1  | Trivial upstream release → auto-PR within 20 minutes                               | Measured from npm publish timestamp to PR creation timestamp |
| GA-2  | Non-trivial upstream release → Issue with analysis within 30 minutes               | Same measurement                                             |
| GA-3  | No duplicate PRs or Issues for the same upstream version                           | Verified by GitHub search API                                |
| GA-4  | LLM analysis cost per invocation < $0.10                                           | Token usage logging                                          |
| GA-5  | Pipeline handles total external outage without crash                               | Failure injection test                                       |
| GA-6  | State machine converges to terminal state for every detected version               | KV state inspection                                          |
| GA-7  | Worker operates within Cloudflare Workers limits (CPU, memory, execution time)     | Staging performance test                                     |
| GA-8  | Extraction engine correctly parses 100% of known bundle versions (v2.1.80–v2.1.91) | Fixture-based test suite                                     |
| GA-9  | `npm pack` in repo root excludes all worker files                                  | `npm pack --dry-run` verification                            |
| GA-10 | Observability logs enable root-cause analysis for any failure                      | Log review exercise                                          |

---

## 7. Global Definition of Done

- [ ] All 36 tasks completed
- [ ] All ~100 tests passing
- [ ] Worker deployed to production Cloudflare
- [ ] Baseline seeded from current `index.mjs` values
- [ ] First real cron cycle produces "no change" result
- [ ] README written at `worker/sync-watcher/README.md`
- [ ] Architecture documented (diagram + component descriptions)
- [ ] Runbook written (troubleshooting common failures)
- [ ] Root repo `npm pack` excludes worker directory
- [ ] No lint errors, no type suppressions
- [ ] Cost estimate validated: < $5/month at 15-min polling + ~2 LLM calls/month

---

## 8. Global Senior QA Review Checklist

| Area              | Check                                                       | Pass? |
| ----------------- | ----------------------------------------------------------- | ----- |
| **Security**      | No secrets in source code                                   | [ ]   |
| **Security**      | GitHub token has minimal scope                              | [ ]   |
| **Security**      | LLM prompts don't leak internal secrets                     | [ ]   |
| **Security**      | Issue/PR bodies are sanitized (no code injection)           | [ ]   |
| **Reliability**   | All external calls have timeouts                            | [ ]   |
| **Reliability**   | All external failures are handled (no unhandled rejections) | [ ]   |
| **Reliability**   | State machine is monotonic and convergent                   | [ ]   |
| **Reliability**   | Lock prevents concurrent cron races                         | [ ]   |
| **Reliability**   | Retry limit prevents infinite loops                         | [ ]   |
| **Performance**   | Cron handler completes in < 30s CPU time                    | [ ]   |
| **Performance**   | Extraction completes in < 500ms for 2MB+ input              | [ ]   |
| **Performance**   | Memory stays within 128MB Workers limit                     | [ ]   |
| **Cost**          | LLM calls only for non-trivial diffs                        | [ ]   |
| **Cost**          | ETag caching avoids unnecessary tarball downloads           | [ ]   |
| **Correctness**   | Extracted values match manually verified constants          | [ ]   |
| **Correctness**   | Auto-PR file patches produce correct content                | [ ]   |
| **Correctness**   | Hash is deterministic and collision-resistant               | [ ]   |
| **Idempotency**   | Duplicate cron fires don't create duplicate PRs/Issues      | [ ]   |
| **Idempotency**   | State transitions are safe to replay                        | [ ]   |
| **Observability** | Structured logs cover all pipeline stages                   | [ ]   |
| **Observability** | DEAD_LETTER triggers alert                                  | [ ]   |
| **Maintenance**   | Code is documented with JSDoc                               | [ ]   |
| **Maintenance**   | Tests are deterministic (no real external calls)            | [ ]   |
| **Compatibility** | Worker uses only Workers-compatible APIs (no Node builtins) | [ ]   |
| **Compatibility** | Gzip/tar parsing uses Workers-compatible libraries          | [ ]   |

---

## 9. Risk Register

| ID   | Risk                                            | Likelihood | Impact | Mitigation                                                           |
| ---- | ----------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------- |
| R-1  | npm registry changes API format                 | Low        | High   | Monitor for 404/5xx, fallback to alternative endpoint                |
| R-2  | Tarball structure changes (no `package/cli.js`) | Medium     | High   | Heuristic path search (cli.mjs, dist/cli.js, etc.)                   |
| R-3  | Bundle obfuscation breaks regex extraction      | Medium     | High   | Multiple regex patterns per field, LLM fallback for unknown patterns |
| R-4  | Kimi K2.5 model deprecated or pricing changes   | Low        | Medium | Model ID is configurable env var, easy to swap                       |
| R-5  | GitHub API rate limiting during PR creation     | Low        | Low    | Exponential backoff, FAILED_RETRYABLE → retry on next cron           |
| R-6  | Workers AI outage                               | Low        | Medium | Fallback to raw diff issue (skip LLM analysis)                       |
| R-7  | KV consistency issues (eventual consistency)    | Low        | Low    | Idempotent operations, last-write-wins with version tracking         |
| R-8  | Upstream publishes multiple versions rapidly    | Low        | Medium | State machine per-version, parallel processing                       |
| R-9  | Bundle exceeds Workers memory limit             | Very Low   | High   | Size guard (reject > 10MB), stream processing                        |
| R-10 | Cron handler exceeds CPU time limit             | Low        | Medium | Profile extraction, optimize hot paths, reduce regex complexity      |

---

## 10. Rollback Strategy

| Scenario                                      | Action                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| Worker deployment fails                       | `wrangler rollback` to previous version                     |
| Worker produces incorrect PR                  | Close PR, delete branch, reset state in KV                  |
| Worker creates spam Issues                    | Disable cron trigger in dashboard, bulk-close issues        |
| Extraction engine wrong for new bundle format | Update regex patterns, re-deploy, re-seed baseline          |
| LLM produces harmful output                   | Disable LLM gate (env flag), fall back to raw diff issues   |
| KV state corrupted                            | Delete state keys, re-seed baseline, let pipeline re-detect |

---

## 11. Troubleshooting Runbook

### Symptom: No PR/Issue created for new upstream version

1. Check `wrangler tail` for recent cron invocations
2. Inspect KV state: `wrangler kv:key get state:<version> --namespace-id=<id>`
3. If state is FAILED_RETRYABLE: check error logs, verify external APIs are up
4. If no state exists: check if registry poller got `304 Not Modified` (ETag issue)
5. If state is IDLE: extraction might have matched existing baseline (diff found no changes)
6. Force re-check: delete ETag from KV, trigger cron manually from dashboard

### Symptom: Duplicate PRs created

1. Check if lock mechanism failed (concurrent cron executions)
2. Verify branch naming is deterministic: `auto/sync-<version>`
3. Check idempotent PR search logic (GitHub API query)
4. Close duplicates, ensure state is DELIVERED

### Symptom: LLM analysis is wrong or low quality

1. Check prompt version in `src/prompts.mjs`
2. Review token usage (too much input → truncation?)
3. Test with `wrangler dev` using saved diff fixture
4. Consider switching model (update `AI_MODEL` env var)

### Symptom: Worker timeout / CPU limit exceeded

1. Profile extraction time with `console.time()`
2. Check bundle size — may need streaming extraction
3. Optimize regex patterns (avoid backtracking)
4. Consider splitting extraction across multiple Worker invocations via Queue

### Symptom: State stuck in non-terminal state

1. Check retry count: if < 6, wait for next cron cycle
2. If retry count ≥ 6 but not DEAD_LETTER: manually transition state in KV
3. If DEAD_LETTER: investigate root cause from logs, fix, reset state to IDLE
