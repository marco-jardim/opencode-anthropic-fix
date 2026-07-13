# Agent-Native Readiness Audit

> **Status:** Resolved (see plan) — full remediation executed across Waves 0–4 (2026-07-13): `index.mjs` reduced
> from ~9688 to 5915 LOC across 11 unit-tested `lib/` modules with no mimicry regression, redaction + `diagnose`
> bundle + replay/coverage harnesses landed, and every phase gate plus the GLOBAL gate passed senior-QA. See
> [`docs/plans/qa/GLOBAL-review.md`](./plans/qa/GLOBAL-review.md).
> **Date:** 2026-07-07
> **Auditor:** Sisyphus (agentic review pass)
> **Repo:** `opencode-anthropic-fix` @ `0.1.32` (branch `master`, tree clean)
> **Companion:** [`docs/plans/agent-native-remediation-plan.md`](./plans/agent-native-remediation-plan.md)
>
> **Update log:**
>
> - _2026-07-07_ — Applied ahead of the formal plan: (1) secret-redaction layer `lib/redact.mjs`
>   wired into all debug sinks + a new masked outgoing-header dump (Axis 3, Rank 2 partial); (2) removed
>   the unrelated nested `.opencode/` project (§5 hygiene). The original 🔴 "bearer leak" finding was
>   **downgraded** after verification — the bearer was never written to disk (see Axis 3 table).

## 0. Purpose & definition

**Goal of this audit:** measure how close this codebase is to being _agent-native_ and produce a
prioritized remediation plan.

**Agent-native (working definition):** a coding agent can take a user bug report _or_ a roadmap
feature, then **reproduce → implement → test → verify on a real build** with minimal human input.

The audit covers four axes:

1. **Human-judgment chokepoints** — where change needs personal judgment / tribal knowledge.
2. **Verification gaps** — what stops an agent verifying its own change end-to-end per subsystem.
3. **Reproduction paths** — what an agent needs to reproduce a typical user bug autonomously.
4. **Structural obstacles** — modules too entangled to change without reading the whole repo.

### Method

Evidence gathered by 8 parallel read-only exploration passes over the full tree, **including
gitignored artifacts** (`dist/`, `_analysis/`, `tmp/`, `.opencode/`, `scripts/{mitm,capture,replay,…}/`,
worker `.wrangler/`) — the maintainer explicitly authorized this. All secret _values_ were redacted;
only shapes/keys are reported. File:line citations are against the working tree at audit time.

---

## 1. Project shape (ground truth)

A precise mental model matters because the in-repo agent guidance is partly self-contradictory.

| Fact              | Value                                                                                                                                                            | Note                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Real package name | `opencode-anthropic-fix`                                                                                                                                         | **not** `Claude-anthropic-fix`                                       |
| What it is        | an **opencode** plugin **+** standalone CLI                                                                                                                      | opencode = the OSS coding agent host                                 |
| What it does      | lets Claude Pro/Max users auth via OAuth, rotates multiple accounts, and **mimics Anthropic's official Claude Code CLI** on the wire so the API accepts requests | mimicry is the crown jewel                                           |
| Runtime           | Node 18+, ESM `.mjs`, JSDoc types (no TS)                                                                                                                        | one `script/publish.ts` violates this                                |
| Prod deps         | `@openauthjs/openauth`, `xxhash-wasm`                                                                                                                            | **two**, not one (AGENTS.md says one)                                |
| On-disk root      | `D:\git\opencode-anthropic-fix`                                                                                                                                  | tooling alias `Claude-anthropic-fix` is a sanitized display artifact |

> ⚠️ **Naming hazard for agents.** The repo's own sanitization rule (`OpenCode` → `Claude Code` in
> the _system prompt sent to Anthropic_) has leaked into the agent-facing context: `AGENTS.md` shows
> a broken `"Claude Code" → "Claude Code"` rule and a `Claude-anthropic-fix` canonical path. Future
> agents must treat **`opencode` (host)** and **`Claude Code` (mimicry target)** as two different
> things. This audit uses the real names throughout. Fixing this confusion is Wave 0, Phase 0.1.

### Scale (why "read the whole repo" is infeasible)

| Artifact               | LOC                           | Signal                                                        |
| ---------------------- | ----------------------------- | ------------------------------------------------------------- |
| `index.mjs`            | **9584**                      | single `AnthropicAuthPlugin` closure spanning lines 188 → EOF |
| `index.test.mjs`       | ~5600 (212 KB)                | largest test file; grep-only territory                        |
| `cli.mjs`              | 1780                          | 17 subcommands                                                |
| `lib/*.mjs`            | 13 modules, 44–1239 LOC each  | **well-factored**, the healthy part of the repo               |
| `docs/*.md`            | 37 files + `docs/plans/` (10) | rich but drifting (see §1-chokepoints)                        |
| `worker/sync-watcher/` | 17 src + 14 tests             | separate Cloudflare Worker subproject                         |
| Tests total            | ~51 files, ~951–1141 cases    | no coverage measurement configured                            |

The `lib/` layer is disciplined and testable. **`index.mjs` is the mass that resists change** — it is
the primary structural obstacle (§4) and the reason every other axis is harder than it should be.

### Core subsystems (the units an agent must reason about)

| #   | Subsystem                    | Primary code                                                                                                                           | Colocated tests                                                            |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S1  | **OAuth & token lifecycle**  | `lib/oauth.mjs`, `lib/cc-credentials.mjs`, `lib/refresh-lock.mjs`                                                                      | oauth(28), cc-credentials(27), refresh-lock(4)                             |
| S2  | **Account store & rotation** | `lib/accounts.mjs`, `lib/storage.mjs`, `lib/rotation.mjs`, `lib/account-state.mjs`                                                     | accounts(54), storage(33), rotation(36), account-state(8)                  |
| S3  | **Rate-limit / backoff**     | `lib/backoff.mjs`                                                                                                                      | backoff(57)                                                                |
| S4  | **Request mimicry**          | `lib/request-headers.mjs` **+ inline** `index.mjs`: `buildRequestHeaders`@7967, `transformRequestBody`@8137, `transformResponse`@9058  | request-headers(26), `test/conformance/regression.test.mjs` (29 describes) |
| S5  | **Retry / overload loop**    | `index.mjs` 2651–3960 (fetch interceptor)                                                                                              | `test/phase3/*`, conformance                                               |
| S6  | **Token economy**            | `index.mjs` (adaptive/cache-break/microcompact state), `lib/rolling-summarizer.mjs`, `lib/message-transform.mjs`, `lib/haiku-call.mjs` | rolling-summarizer, message-transform(14), cache-adaptive, phase2/3        |
| S7  | **CLI**                      | `cli.mjs`                                                                                                                              | `cli.test.mjs`                                                             |
| S8  | **Upstream watcher**         | `worker/sync-watcher/src/*`                                                                                                            | 14 worker tests                                                            |

---

## 2. Axis 1 — Human-judgment chokepoints

Every row is a place where a change currently needs _your_ judgment. The right-hand column is what it
could become so an agent proceeds alone.

| ID  | Chokepoint                                                                                                                                                                                                     | Evidence                                                                                                                                             | Codify as                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **Mimicry drift decisions** — on each Claude Code release, which betas to add/remove, whether the delta is "trivial" vs "semantic", which body/header fields changed                                           | `worker/sync-watcher/analyzer.mjs` (auto-PR if `confidence≥0.85`), `docs/mimese-http-header-system-prompt.md` §5 "DEFAULT-SET drift" warning         | **Decision table** `docs/mimicry/beta-decision-table.md`: per-beta {send when, layer (header/body), OAuth-safe?, source-of-truth line}. Machine-checkable against `lib/request-headers.mjs`. |
| C2  | **Sources of truth diverge** — git tags stop at `v0.1.27`, `CHANGELOG.md` newest is `0.1.27`, `package.json` is `0.1.32`; RE doc pinned at 2.1.119/2.1.123 while per-version analyses reach 2.1.195            | tags vs `CHANGELOG.md:5` vs `package.json`; `docs/claude-code-reverse-engineering.md:3` (baseline 2.1.119) vs `docs/claude-code-2.1.195-analysis.md` | **CLAUDE.md release ritual** + a `scripts/check-sources-of-truth.mjs` CI-style assertion that version, changelog head, and mimicry baseline agree (or explicitly waive).                     |
| C3  | **Magic numbers** — `maxServiceRetries=2`, `consecutive529Count>=3` → model fallback, backoff cap `min(0.5·2^n,3)` ±25%, 15s refresh timeout, 5-min expiry buffer, health-score thresholds, token-bucket sizes | `index.mjs` retry loop 3852–3909; `lib/backoff.mjs`; `lib/rotation.mjs`; regression Fix #10–#14                                                      | **Named constants module** `lib/tuning.mjs` with JSDoc rationale per value + back-reference to the RE-doc section that justifies it. Tests already pin several; centralize + document.       |
| C4  | **Beta OAuth-safety filter** — which betas are legal on OAuth vs first-party is encoded but the _why_ is tribal                                                                                                | `EXPERIMENTAL_BETA_FLAGS` filter, regression Fix #1/#2                                                                                               | Inline the rationale into the C1 decision table; each entry cites the RE-doc evidence line.                                                                                                  |
| C5  | **Strategy choice** (sticky/round-robin/hybrid) + when to switch accounts                                                                                                                                      | `lib/rotation.mjs`, `cli strategy`                                                                                                                   | **Decision table** mapping symptom → recommended strategy + the config keys that implement it.                                                                                               |
| C6  | **"Docs are the contract" rule is not where agents look** — it lives only in `AGENTS.md`; `CONTRIBUTING.md` never cross-references it                                                                          | `CONTRIBUTING.md` (no mimicry-doc rule); `AGENTS.md:59`                                                                                              | Add a **root `CLAUDE.md`** (agent entrypoint) that links the decision tables, the mimicry contract, the release ritual, and the parallel-safety rules.                                       |
| C7  | **Release ritual** — bump `--no-git-tag-version`, rebuild `dist/`, separate `chore:` commit, tag inconsistently                                                                                                | commit history (`f10139e`, `10b2ebc`…)                                                                                                               | Document in `CLAUDE.md`; provide `npm run release` wrapper script that enforces the sequence.                                                                                                |

**Attention-saved ranking within Axis 1:** C6+C1+C3 are the highest ratio — mostly _writing_, and they
unlock autonomous mimicry/tuning changes (the most frequent recurring work per the commit history,
which is dominated by "track Claude Code 2.1.x" syncs).

---

## 3. Axis 2 — Verification gaps (per subsystem)

What is missing for an agent to prove its own change is correct **before** claiming done.

| Sub                | What exists                                                               | What's missing (the gap)                                                                                                                                                                                                                               | Impact |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **Global**         | ~951 tests, husky pre-commit/pre-push run them                            | **No coverage tooling at all** (no provider, no thresholds, no `npm run coverage`). An agent cannot see what it left untested.                                                                                                                         | HIGH   |
| **Global**         | Every test hand-rolls `vi.mock("node:https"/"node:fs")`                   | **No shared HTTP/SSE mock harness, no fake Anthropic server.** Writing a new end-to-end test means re-deriving the mock each time → drift + high friction.                                                                                             | HIGH   |
| **S4 mimicry**     | `regression.test.mjs` asserts headers/betas/system-prompt/body vs the doc | **No golden snapshot of the actual outgoing request** (headers+body) to diff a mimicry change. `debug_dump_bodies` writes dumps but no test consumes them.                                                                                             | HIGH   |
| **S4/S5 stream**   | header assertions                                                         | **SSE response transform under-tested.** `stop_details` passthrough is an _explicit untested P3 TODO_ (`CHANGELOG.md:41`, `docs/claude-code-2.1.143-analysis.md:536`). `transformResponse`@9058 (mcp\_ strip, tool-name round-trip) has thin coverage. | HIGH   |
| **S1 concurrency** | `refresh-lock.test.mjs` (4 tests)                                         | No concurrent-acquire race, no lock-file IO-failure, no Windows-ACL path. It is _the_ cross-process primitive and is the thinnest-tested file relative to risk.                                                                                        | HIGH   |
| **S2 atomicity**   | `storage.test.mjs` (33 tests, logic-complete)                             | No concurrent-writer collision test; no Windows-ACL-denied path, despite `0600` being POSIX-only (Windows relies on ACLs).                                                                                                                             | MED    |
| **S5 retry**       | `phase3/*`, conformance triggers                                          | Retry-loop branches (529 → model fallback opus→sonnet→haiku, account-switch on PERMISSION_DENIED/AUTH_FAILED/QUOTA_EXHAUSTED) are exercised indirectly; **no mock-event injection harness** to drive a precise sequence of upstream statuses.          | MED    |
| **S8 worker**      | good src↔test parity                                                      | `delivery.mjs` regex-based file patching against live upstream is fragile; `lock.mjs` is "best-effort" with no double-cron-fire test.                                                                                                                  | MED    |
| **S6 token econ**  | phase2/3 tests                                                            | `index.mjs:4331 TODO(B3)` rolling-summarizer not wired → untested stub.                                                                                                                                                                                | LOW    |
| **UI**             | —                                                                         | opencode TUI cache widgets (`docs/anti-verbosity-and-cache-transparency.md`) have no screenshot/snapshot diff.                                                                                                                                         | LOW    |

**No live probe exists.** Mimicry is validated only against _static doc assertions_. Nothing replays a
real (or recorded) `200/429/529` upstream response through the interceptor. That's the single biggest
"verify on a real build" gap.

---

## 4. Axis 3 — Reproduction paths

Given a typical user bug report (free text + whatever they can copy), what would an agent need to
reproduce it **autonomously**? Today: not enough.

### What a bug report can contain right now

- Free-text symptom + maybe stderr lines.
- If the user knew to enable it: `OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT=1` → system prompt to stderr
  (`README.md:645`), _or_ `config.debug` → `<configDir>/debug-headers.log`, _or_
  `token_economy.debug_dump_bodies` → `~/.opencode/.../request-dumps/req-*.json`.

### Why that is not reproducible-by-an-agent

| Gap                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                    | Consequence                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No diagnostic bundle command**                                    | none found (`doctor`/`diagnose`/`selfcheck` grep → ABSENT)                                                                                                                                                                                                                                                                                                                                  | user must manually assemble scattered artifacts; most won't                                                                                                                                          |
| **Debug sinks are uncorrelated**                                    | request dump uses ISO timestamp; header log uses a separate ISO timestamp; **no shared request/session ID** (`index.mjs` 3098–3123 vs 3184–3222)                                                                                                                                                                                                                                            | can't line up "this request" with "this response header set"                                                                                                                                         |
| **Secrets not redacted in debug output** — ✅ _resolved 2026-07-07_ | Corrected finding: the OAuth **bearer is never written to disk** — outgoing `requestHeaders` were not logged anywhere. Real (narrower) risk: the **response**-header dump (`debug-headers.log`, `index.mjs:3184–3222`) could contain `set-cookie`, and the request-**body** dump (`request-dumps/*.json`) holds prompt/message content. Both opt-in (`config.debug` / `debug_dump_bodies`). | 🟠 → ✅ Fixed by `lib/redact.mjs`: every debug sink now routes a **clone** through credential redaction; a new opt-in outgoing-header dump is masked from birth (fingerprint headers stay verbatim). |
| **Response body / SSE never captured**                              | only response _headers_ dumped                                                                                                                                                                                                                                                                                                                                                              | can't reproduce stream-transform / `stop_details` / tool-round-trip bugs                                                                                                                             |
| **No replay harness / fixtures**                                    | `scripts/replay/` is gitignored dev scaffolding; `.mitm/` + `_analysis/captures/*.json` exist but aren't turned into test fixtures; `test/` has **no** recorded request/response pairs (only worker has `cli.js` snippets)                                                                                                                                                                  | can't turn a captured request into a deterministic replay                                                                                                                                            |
| **No mock-event injection**                                         | rate-limit/rotation tests construct 429/529 ad hoc per file                                                                                                                                                                                                                                                                                                                                 | reproducing a rotation/backoff bug means rebuilding scaffolding each time                                                                                                                            |

### What's needed (specified in the plan)

1. ✅ **DONE (2026-07-07)** — A **redaction layer** (`lib/redact.mjs`, 8 tests) that masks credential
   values only (bearer/cookie/api-key/refresh/access/email) while keeping fingerprint headers verbatim;
   all current debug sinks route a clone through it, plus a new masked outgoing-header dump for complete
   mimicry debugging. _Remaining W1 work builds on this — all future debug output must route through it._
2. A **single `diagnose` command** that emits one redacted, correlation-ID-stamped bundle:
   config (redacted) + account state (redacted) + last-N request/response metadata + env flags + versions.
3. A **capture→fixture→replay harness**: a stable on-disk format for a request/response pair, a loader
   in `test/helpers/`, and a `replayThroughInterceptor(fixture)` that runs it past `transformRequestBody`
   - `transformResponse` deterministically.
4. **Mock-event injection** for S5: a helper that scripts a sequence of upstream statuses so a rotation
   or backoff scenario is one function call.

---

## 5. Axis 4 — Structural obstacles & proposed boundaries

### The obstacle: `index.mjs` (9584 LOC)

A single `AnthropicAuthPlugin` closure (line 188 → EOF) owns: interactive OAuth prompts, the whole
`/anthropic` slash-command handler, the fetch retry/overload loop, header construction, request-body
transform, SSE response transform, `sessionMetrics`, and four separate token-economy state machines
(`adaptiveContextState`, `cacheBreakState`, `microcompactState`, `quotaWarningState`). To change any one
safely an agent must load most of the file into context.

Aggravating specifics:

- `transformRequestBody`@8137 and `transformResponse`@9058 are top-level yet **still inside `index.mjs`**,
  and lack access to the closure's `debugLog` (they re-mirror it manually, 8147–8150).
- `buildRequestHeaders`@7967 overlaps `lib/request-headers.mjs` (partial extraction already happened).
- Two separate `return {…}` plugin-hook blocks (2413, 4389) make the exported surface hard to trace.

### Duplication (change-one-miss-the-other traps)

| Duplicated logic                    | Locations                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `formatResetTime()`                 | `index.mjs:4666` **and** `cli.mjs:241` (separate impls)                                                      |
| Token refresh                       | `lib/oauth.mjs refreshToken()` vs `cli.mjs:147 refreshAccessToken()` (CLI reimplements instead of importing) |
| Active-index adjustment on removal  | inline 3× in `cli.mjs` (486, 954, 1021) instead of `lib/account-state.mjs adjustActiveIndexAfterRemoval`     |
| `cli.mjs` bypasses `AccountManager` | operates on raw storage, re-deriving invariants                                                              |

### Proposed boundaries (target module map)

Extract from `index.mjs` into cohesive, independently testable units. Each becomes a file an agent can
own end-to-end without reading the rest:

```
lib/mimicry/
  headers.mjs          ← buildRequestHeaders (merge with request-headers.mjs)
  request-body.mjs     ← transformRequestBody  (+ injectable logger)
  response-stream.mjs  ← transformResponse     (+ injectable logger)
lib/retry/
  overload-loop.mjs    ← the 2651–3960 fetch retry state machine (pure decisions + injected effects)
lib/token-economy/
  adaptive-thinking.mjs
  cache-break.mjs
  microcompact.mjs
  quota-warning.mjs
lib/session-metrics.mjs ← createInitialSessionMetrics + the JSDoc contract
lib/tuning.mjs          ← C3 constants
```

`index.mjs` shrinks to plugin wiring: build the hook object, delegate to the modules above. The retry
loop and stream transform become the highest-value extractions because they are the least-tested,
highest-risk logic and are currently unreachable to focused unit tests.

### Repo hygiene (cheap, removes agent confusion)

Stray/irrelevant on-disk items an agent will trip over: `nul` (0-byte artifact), `.ruff_cache/` (Python
tool cache in a JS repo), ~~`.opencode/` (an unrelated nested project with its own lockfiles)~~ ✅ _removed
2026-07-07_, the singular `script/publish.ts` (TS in a no-TS repo, distinct from `scripts/` — **kept** by
maintainer decision as a manual release helper), stale `_tmp_*`, committed `dist/` on disk, `*.tgz`
snapshots at root.

---

## 6. Prioritized remediation plan (ranked by human-attention-saved ÷ effort)

Full specs, waves, phases, pre-flight checks, tests, acceptance/DoD, QA reviews, parallelism rules and
model-router annotations are in
[`docs/plans/agent-native-remediation-plan.md`](./plans/agent-native-remediation-plan.md). Ranking summary:

| Rank  | Item                                                                                                                                      | Axis     | Effort | Attention saved | Wave/Phase  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------- | ----------- |
| **1** | **Agent decision layer** — root `CLAUDE.md` + beta/strategy decision tables + `lib/tuning.mjs` + fix the opencode/Claude-Code naming leak | 1        | S      | ★★★★★           | W0·P0.1–0.3 |
| **2** | **Redaction + `diagnose` bundle** — redaction layer ✅ _done_; `diagnose` cmd + correlation IDs remain                                    | 3 (+sec) | M      | ★★★★★           | W1·P1.1–1.3 |
| **3** | **Capture→fixture→replay harness + shared HTTP/SSE mock server**                                                                          | 2,3      | M–L    | ★★★★☆           | W2·P2.1–2.2 |
| **4** | **Coverage tooling + fill S1/S2/S4 concurrency & stream gaps**                                                                            | 2        | M      | ★★★★☆           | W2·P2.3–2.4 |
| **5** | **Carve `index.mjs`** → `lib/mimicry/*`, `lib/retry/*`, `lib/token-economy/*`; dedupe                                                     | 4        | L      | ★★★☆☆           | W3·P3.1–3.4 |
| 6     | Sources-of-truth guard + release wrapper                                                                                                  | 1        | S      | ★★★☆☆           | W0·P0.4     |
| 7     | Live-probe smoke test (opt-in, recorded responses)                                                                                        | 2        | M      | ★★★☆☆           | W4·P4.1     |
| 8     | Wire worker sync-watcher output → fixtures                                                                                                | 2        | M      | ★★☆☆☆           | W4·P4.2     |
| 9     | Repo hygiene sweep                                                                                                                        | 4        | S      | ★★☆☆☆           | W0·P0.5     |

The **top 5** are specified concretely enough to start from the plan document alone (each has a
pre-flight, explicit file ownership, test list, and acceptance criteria).

---

## 7. Risks & non-goals

- **Mimicry regressions are the primary risk.** Any extraction (Rank 5) must keep
  `test/conformance/regression.test.mjs` green at every step; that suite is the contract.
- **Do not weaken secret handling** while adding observability — the redaction layer (Rank 2) is a
  prerequisite for, not a follow-up to, richer debug output. _(The layer now exists in `lib/redact.mjs`;
  any new debug/diagnostic output MUST route a clone through `redactSecrets`/`redactString`.)_
- **Non-goal:** introducing TypeScript, a second heavy prod dependency, or changing the
  `anthropic-accounts.json` schema without migration.
- **Non-goal:** rewriting the worker subproject; it is already agent-navigable.
