# Agent-Native Remediation Plan

> **Status:** Ready to execute
> **Date:** 2026-07-07
> **Owner:** autonomous agent swarm (orchestrated)
> **Source audit:** [`docs/agent-native-audit.md`](../agent-native-audit.md)
> **Repo:** `opencode-anthropic-fix` @ `0.1.32`, on-disk root `D:\git\opencode-anthropic-fix`

This plan fills every gap in the audit. It is written to be executed by coding agents with minimal
human intervention. Read §A (directives) before starting any wave.

---

## A. Execution directives (read first — binding)

### A1. Iterate continuously

> **Execute the plan wave by wave, phase by phase, without stopping for human sign-off between phases.**
> Only halt and ask the human when one of the **STOP conditions** is met. Otherwise: pre-flight →
> implement → test → QA review → fix QA findings → commit → next phase.

**STOP conditions (the _only_ reasons to interrupt the loop):**

1. **Ambiguity** — a requirement has ≥2 valid interpretations with materially different outcomes and no
   default is defensible from the audit + code.
2. **Critical/blocking discovery** — a change would break the mimicry contract irrecoverably, corrupt
   user account data, leak secrets, or require a schema migration not covered here.
3. **Repeated failure** — 3 consecutive failed attempts on the same task after an Oracle (`heavy`)
   consult (per Sisyphus Phase 2C).

When stopping, post: what was attempted, the exact blocker, the decision needed, and a recommended
default. Then continue with any _non-blocked_ parallel work while waiting.

### A2. Parallelism with write-safety (mandatory)

Maximize throughput, but **never** let two agents touch the same file unsafely.

- **File-ownership lock.** Every task below declares `owns:` (files it may write) and `reads:` (files it
  may read). The orchestrator must not dispatch two concurrently-running tasks whose `owns:` sets
  intersect, **nor** dispatch a task that `reads:` a file currently in another task's `owns:` set.
- **Parallel groups.** Tasks tagged `∥group=X` in the same phase have disjoint `owns:` sets and may run
  simultaneously. Tasks tagged `seq` must run in listed order.
- **New files are free.** Creating a brand-new file never conflicts; only edits to existing files lock.
- **`index.mjs` is a global lock.** Because it is huge and central, at most **one** task may `own`
  `index.mjs` at a time, and no other task may `read` it while owned. Schedule `index.mjs` edits
  serially and keep them small.
- **Test files colocate with their target's owner.** The agent that owns `lib/foo.mjs` also owns
  `lib/foo.test.mjs` in the same task, to avoid a second agent editing tests mid-change.

### A3. Commit often (mandatory)

- One commit per completed subtask (or tighter). Never batch a whole phase into one commit.
- Conventional prefixes matching repo tone: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`.
- Commit message body references the plan node, e.g. `refactor(mimicry): extract response-stream (W3·P3.1·T2)`.
- **Never** commit `dist/`, `_tmp_*`, `.mitm/`, `tmp/`, `_analysis/`, `.opencode/`, secrets.
- Do **not** hand-run `git commit` for trivial edits that would trip the slow pre-commit hook
  unnecessarily; batch a subtask's files, then commit once. Let husky run (do not `--no-verify` unless a
  hook is itself broken — if so, that's a STOP-condition class 2).
- Bump version only per the release ritual (§C, Global DoD), not per phase.

### A4. Model-router annotations

Each task is tagged with the tier that should execute it:

| Tag        | Tier (cost)                   | Use for                                                          |
| ---------- | ----------------------------- | ---------------------------------------------------------------- |
| `[fast]`   | `claude-sonnet-5 / high` (1×) | search, read, grep, inventory, doc-outline, count, verify-only   |
| `[medium]` | `claude-opus-4.8 / high` (5×) | implementation, refactor, test authoring, bug-fix, config        |
| `[heavy]`  | `claude-opus-4.8 / max` (20×) | boundary design, security (redaction), retry-loop RCA, tradeoffs |

Rules: gather context with `[fast]` **before** any `[heavy]` dispatch. The orchestrator (if already
opus) performs `[heavy]`-class _design/analysis_ itself instead of self-dispatching. Every dispatch
carries the ENVIRONMENT block (`D:\git\opencode-anthropic-fix`, win32, pwsh) and a `CAP:N` read budget.

### A5. Per-phase ceremony (applies to _every_ phase)

1. **Pre-flight check** — run the phase's listed pre-flight before writing code. If pre-flight fails,
   fix the environment first (or STOP if class-2).
2. **Implement** tasks respecting §A2 ownership.
3. **New tests** — author the phase's test list with edge cases; run them green.
4. **Phase acceptance** — verify the phase's acceptance criteria (evidence, not assertion).
5. **Senior QA review** — dispatch a `[heavy]` (or orchestrator-as-opus) QA pass using the §B QA rubric,
   producer ≠ reviewer. Record findings in `docs/plans/qa/W<n>P<n>-review.md`.
6. **Fix all QA findings** — loop until the QA reviewer returns PASS. Re-run tests.
7. **Commit** the phase's work (multiple commits per §A3).
8. Proceed to next phase (per §A1).

### A6. Definition of "done" is evidence-based

No task is complete on intent. Completion requires the acceptance checks to have **run** and passed:
targeted tests green, lint clean on changed files, and (feature-complete points) full `npm test` green.

---

## B. Senior-QA review rubric (used at every phase gate + globally)

The QA reviewer is an independent agent (never the task's implementer; reviewer tier ≥ producer tier).
It must produce a verdict `PASS | CHANGES-REQUIRED` with file:line evidence against this rubric:

1. **Correctness** — acceptance criteria demonstrably met; new tests actually exercise the change
   (no assertion-free or tautological tests).
2. **Mimicry integrity** — `test/conformance/regression.test.mjs` green; no header/beta/system-prompt/
   body-shape regression; docs updated if the wire contract changed
   (`docs/mimese-http-header-system-prompt.md`).
3. **Security** — no secret written unredacted anywhere; no token in logs/fixtures/snapshots.
4. **No regressions** — full `npm test` green; lint clean; no new `as any`/`@ts-ignore`
   (JS: no silent `catch {}`), no skipped/deleted tests.
5. **Edge cases** — the phase's required edge cases are covered (listed per phase).
6. **Structure** — change stays within declared boundaries; no new cross-module entanglement; no
   duplication reintroduced.
7. **Docs & discoverability** — an agent could understand the change from the repo alone (CLAUDE.md /
   decision tables / JSDoc updated where relevant).

QA findings are logged to `docs/plans/qa/` and must be fixed before the phase closes.

---

## C. Global acceptance criteria & Definition of Done

**Global acceptance criteria (the whole plan):**

- G1. An agent can take a _recorded_ bug bundle and replay it through the interceptor deterministically
  (Wave 2 harness) — demonstrated by at least one repro fixture-driven test.
- G2. `npm run coverage` exists and reports; core subsystems S1–S6 meet the coverage threshold set in
  W2·P2.3 (statements ≥ 85% for `lib/`, ≥ 70% for extracted `index.mjs` modules).
- G3. No secret value is ever written unredacted by any debug/diagnostic/test path (grep-proof test).
- G4. `index.mjs` is reduced below **6000 LOC** with mimicry, retry, and token-economy logic living in
  `lib/` modules that have direct unit tests.
- G5. A root `CLAUDE.md` + decision tables let an agent perform a Claude Code version-sync and a
  rotation-strategy change without human judgment (dry-run demonstrated).
- G6. Every phase gate passed senior-QA with findings resolved; `docs/plans/qa/` complete.
- G7. Full `npm test` green; `npm run lint`, `npm run format:check` clean; `npm run build` succeeds.

**Global Definition of Done:**

- All waves' phase-DoDs met; all QA reviews PASS.
- `CHANGELOG.md` updated; version bumped per the ritual (`npm version patch --no-git-tag-version` +
  separate `chore:` commit + matching git tag — closing chokepoint **C2**).
- `docs/agent-native-audit.md` "Status" flipped to _Resolved (see plan)_ with a short outcomes note.
- No item left in a partial state without an explicit follow-up task recorded.

---

## D. Waves overview

| Wave   | Theme                                          | Phases    | Depends on | Dominant tier |
| ------ | ---------------------------------------------- | --------- | ---------- | ------------- |
| **W0** | Foundation: agent knowledge + hygiene + guards | P0.1–P0.5 | —          | fast/medium   |
| **W1** | Observability & safe reproduction              | P1.1–P1.3 | W0         | heavy/medium  |
| **W2** | Verification infrastructure                    | P2.1–P2.4 | W1         | medium        |
| **W3** | Structural decomposition of `index.mjs`        | P3.1–P3.4 | W2         | heavy/medium  |
| **W4** | Close the loop: live probe + upstream wiring   | P4.1–P4.2 | W3         | medium/heavy  |

Cross-wave parallelism: within a wave, phases with disjoint `owns:` may overlap (noted per phase). Waves
run in order because each depends on the prior's safety nets (e.g. don't refactor `index.mjs` in W3
before the W2 harness can prove you didn't break mimicry).

---

# Wave 0 — Foundation

_Goal:_ give agents the written knowledge, guards, and clean tree they need so later waves need zero
tribal input. Lowest effort, highest attention-saved. Most of W0 is disjoint and highly parallel.

### Pre-flight (Wave 0)

- `git status --porcelain` clean (tree is clean at audit time; if not, STOP-class-2).
- `npm test` green baseline (record pass count).
- `node --version` ≥ 18.
- Confirm on-disk root is `D:\git\opencode-anthropic-fix`.

---

## Phase 0.1 — Fix the opencode / Claude Code naming leak `[medium]` ∥group=A

Addresses audit **C6** naming hazard.

- **owns:** `AGENTS.md`
- **reads:** `docs/agent-native-audit.md`, `README.md`
- **Tasks:**
  - T1 `[fast]` — grep `AGENTS.md` for the broken `"Claude Code" → "Claude Code"` sanitization artifact
    and the `Claude-anthropic-fix` canonical-path claim; list every line.
  - T2 `[medium]` — rewrite the affected `AGENTS.md` lines so they state the truth: package is
    `opencode-anthropic-fix`; host is **opencode**; mimicry target is **Claude Code**; the
    system-prompt sanitization rule is `OpenCode → Claude Code` (and must NOT be applied to agent docs).
    Correct the prod-dependency count to **two** (`@openauthjs/openauth`, `xxhash-wasm`).
- **New tests:** none (doc-only) — but add a guard in P0.4 that greps for the broken literal.
- **Acceptance:** `AGENTS.md` contains no `"Claude Code" → "Claude Code"` string; dependency count
  correct; a fresh reader cannot confuse host vs target.
- **DoD:** committed as `docs: correct opencode/Claude-Code naming in AGENTS.md (W0·P0.1)`.

## Phase 0.2 — Root `CLAUDE.md` agent entrypoint `[medium]` ∥group=A

Addresses **C6, C7**.

- **owns:** `CLAUDE.md` (new)
- **reads:** `AGENTS.md`, `CONTRIBUTING.md`, `docs/mimese-http-header-system-prompt.md`, this plan
- **Content (required sections):**
  1. _What this repo is_ (2-sentence truthful summary; link audit).
  2. _Golden rules_ — docs-are-the-contract; mimicry changes require matching
     `docs/mimese-http-header-system-prompt.md` + `regression.test.mjs` updates; OAuth-first; no TS;
     no 3rd heavy dep; account-schema migrations need a path.
  3. _Decision tables index_ — link P0.3 tables.
  4. _Release ritual_ (C7) — the exact bump/rebuild/commit/tag sequence.
  5. _Parallel-safety & commit-often_ — point to this plan's §A2/§A3 for any multi-agent work.
  6. _Where things live_ — subsystem→file map from audit §1.
- **Acceptance:** every link resolves; a `[fast]` agent asked "how do I sync a new Claude Code version?"
  can answer using only `CLAUDE.md` + linked tables.
- **DoD:** committed `docs: add root CLAUDE.md agent entrypoint (W0·P0.2)`.

## Phase 0.3 — Decision tables + `lib/tuning.mjs` `[medium]` ∥group=B

Addresses **C1, C3, C4, C5**.

- **owns:** `docs/mimicry/beta-decision-table.md` (new), `docs/mimicry/strategy-decision-table.md` (new),
  `lib/tuning.mjs` (new), `lib/tuning.test.mjs` (new)
- **reads:** `lib/request-headers.mjs`, `lib/backoff.mjs`, `lib/rotation.mjs`, `index.mjs` (grep-only,
  **no writes** — so this task must not run concurrently with any `index.mjs`-owning task; none in W0),
  `docs/mimese-http-header-system-prompt.md`, `docs/claude-code-reverse-engineering.md`
- **Tasks:**
  - T1 `[fast]` — extract the live beta set from `lib/request-headers.mjs` + the "DEFAULT-SET drift"
    table from the mimese doc.
  - T2 `[medium]` — write `beta-decision-table.md`: one row per beta {flag, send-when, layer
    header/body, OAuth-safe?, source-of-truth doc:line}.
  - T3 `[medium]` — write `strategy-decision-table.md`: symptom → strategy (sticky/round-robin/hybrid)
    → config keys.
  - T4 `[medium]` — create `lib/tuning.mjs` exporting the C3 magic numbers as named consts **with JSDoc
    rationale + RE-doc back-reference**. Do **not** wire it into `index.mjs` yet (that's W3, keeps this
    phase lock-free). Add `lib/tuning.test.mjs` asserting each constant's presence/shape and that values
    match the ones currently hard-coded (grep the current literals to pin them).
- **New tests:** `lib/tuning.test.mjs` — value pins + JSDoc-present assertions; edge case: every exported
  const has a `@see` back-reference.
- **Acceptance:** tables cover 100% of betas in `EXPERIMENTAL_BETA_FLAGS`; `tuning.mjs` values equal the
  in-code literals (proven by a cross-check test).
- **DoD:** committed across ≥3 commits (tables, tuning, tests).

## Phase 0.4 — Sources-of-truth + naming guard `[medium]` ∥group=B

Addresses **C2** + guards P0.1.

- **owns:** `scripts/check-invariants.mjs` (new), `scripts/check-invariants.test.mjs` (new),
  `package.json` (add `"check:invariants"` script — ⚠ `package.json` is a shared hot file; run this task
  **seq** after P0.3's package edits if any, and never concurrently with another `package.json` owner)
- **reads:** `CHANGELOG.md`, `package.json`, `docs/claude-code-reverse-engineering.md`, `AGENTS.md`
- **Tasks:**
  - T1 `[medium]` — `check-invariants.mjs` asserts: (a) `package.json.version` matches the newest
    `CHANGELOG.md` heading **or** prints an explicit "changelog behind by N" warning with exit code;
    (b) the mimicry baseline version referenced in the newest analysis doc is recorded somewhere the
    plugin reports; (c) `AGENTS.md` contains no broken `"Claude Code" → "Claude Code"` literal.
  - T2 `[medium]` — wire `npm run check:invariants`; document in `CLAUDE.md` release ritual.
- **New tests:** `check-invariants.test.mjs` — passing tree returns 0; a fabricated mismatch (temp
  fixture) returns non-zero; edge case: changelog head parseable with/without trailing date.
- **Acceptance:** `npm run check:invariants` exits 0 on current tree after C2 reconciliation (bump
  CHANGELOG or waive explicitly).
- **DoD:** committed; script referenced from `CLAUDE.md`.

## Phase 0.5 — Repo hygiene sweep `[medium]` ∥group=C

Addresses audit §5 hygiene.

- **owns:** `.gitignore`, and deletions of untracked strays (`nul`, root `*.tgz`, `.ruff_cache/`);
  **investigation-only** for `.opencode/` and `script/publish.ts`
- **reads:** whole-tree listing
- **Tasks:**
  - T1 `[fast]` — confirm `nul`, `.ruff_cache/`, root `*.tgz` are untracked & safe to delete
    (`git ls-files --error-unmatch`); confirm `.opencode/` and `script/publish.ts` are not referenced by
    any build/import (grep). **Do not delete** anything referenced.
  - T2 `[medium]` — delete confirmed strays; ensure `.gitignore` covers them; if `.opencode/` or
    `script/publish.ts` are unreferenced, propose removal in the phase note but **STOP-class-1**
    (ambiguous ownership) rather than deleting a possibly-intentional sibling project.
- **New tests:** none; add a `check-invariants` rule (P0.4) that fails if `nul` reappears.
- **Acceptance:** tree has no `nul`/`.ruff_cache`/root `*.tgz`; `git status` clean; `npm test` green.
- **DoD:** committed `chore: repo hygiene sweep (W0·P0.5)`.

### Wave 0 gate

- **Acceptance:** P0.1–P0.5 acceptance all met; `npm test` + `npm run lint` + `check:invariants` green.
- **Senior QA review** (`docs/plans/qa/W0-review.md`) per §B → fix findings → PASS.
- **DoD:** all W0 commits landed; `CLAUDE.md` + decision tables + tuning + guard exist.

---

# Wave 1 — Observability & safe reproduction

_Goal:_ make every bug shareable and replayable **safely**. Security (redaction) comes first because it
is a prerequisite for richer debug output. Addresses audit Axis 3 + the token-leak.

### Pre-flight (Wave 1)

- W0 gate PASS.
- Confirm the two existing debug sinks still behave (`index.mjs` 3098–3123 body dump; 3184–3222 header
  log) — record current format.
- Grep-confirm the leak is real: `Authorization`/bearer present in `allHeaders` dump path.
- Snapshot `getConfigDir()` layout so the new bundle writes to the right place.

---

## Phase 1.1 — Redaction layer (SECURITY, do first) `[heavy]` seq

Addresses audit **Axis 3 leak** (🔴) — highest-severity single item.

- **owns:** `lib/redact.mjs` (new), `lib/redact.test.mjs` (new)
- **reads:** `index.mjs` (grep-only for all sink call sites — no write yet), `lib/accounts.mjs`
  (token-hashing precedent)
- **Design (heavy):** a pure `redactSecrets(value, opts)` that recursively redacts: `Authorization`/
  bearer tokens, `access`/`refreshToken`/`token_updated_at`-adjacent secrets, OAuth codes, account
  emails (to `a***@domain`), and any string matching known token prefixes. Must be allocation-safe on
  large header/body objects and never throw (returns best-effort redacted copy).
- **New tests:** `lib/redact.test.mjs` — redacts bearer in a headers object; redacts nested
  `refreshToken`; leaves non-secret fields intact; idempotent (redact∘redact == redact); handles
  circular refs, `null`/`undefined`, huge objects; **edge case:** a token embedded mid-string in a URL;
  **edge case:** email redaction preserves domain for debugging.
- **Acceptance:** grep-proof test asserts no known-secret pattern survives `redactSecrets` over a
  realistic header+body fixture.
- **DoD:** committed `feat(security): add redaction layer (W1·P1.1)`.

## Phase 1.2 — Route all debug sinks through redaction + correlation ID `[medium]` seq (owns `index.mjs`)

Addresses **uncorrelated + unredacted sinks**.

- **owns:** `index.mjs` (⚠ global lock — no other task may run against `index.mjs` now)
- **reads:** `lib/redact.mjs`, `lib/redact.test.mjs`
- **Tasks:**
  - T1 `[medium]` — generate a per-request **correlation ID** (session-scoped + monotonic) available to
    both the request-body dump and the header log; stamp both artifacts with it.
  - T2 `[medium]` — pipe `debug-headers.log` writes and `request-dumps/*.json` writes through
    `redactSecrets`. Add **rotation** to `debug-headers.log` (currently unbounded append,
    `index.mjs:3184–3222`) mirroring the request-dump 10-file cap.
  - T3 `[medium]` — add opt-in **response/SSE capture** (redacted, size-capped) so stream bugs
    (`stop_details`, tool round-trip) are reproducible; gate behind the existing debug flag.
- **New tests:** extend `index.test.mjs` (owned here) — header log line contains correlation ID and no
  bearer; request dump filename+content carry the same correlation ID; SSE capture writes a redacted,
  capped artifact; rotation deletes oldest beyond cap. **Edge case:** two rapid requests get distinct
  IDs; **edge case:** capture disabled by default (no files written when flags off).
- **Acceptance:** with debug on, a single request yields correlated request+headers(+SSE) artifacts,
  all redacted; with debug off, nothing is written.
- **DoD:** committed in ≤3 small commits (this is `index.mjs`, keep diffs tight).

## Phase 1.3 — `diagnose` command → single shareable bundle `[medium]` ∥group=A

Addresses **no diagnostic bundle**.

- **owns:** `cli.mjs`, `cli.test.mjs`, `lib/diagnose.mjs` (new), `lib/diagnose.test.mjs` (new)
- **reads:** `lib/redact.mjs`, `lib/config.mjs`, `lib/storage.mjs`, `lib/request-headers.mjs`
  (this phase does **not** read/own `index.mjs`, so it may run parallel to nothing in W1 that owns
  `index.mjs` — schedule after P1.2 releases the `index.mjs` lock, or in parallel if it truly avoids it)
- **Tasks:**
  - T1 `[medium]` — `lib/diagnose.mjs buildDiagnosticBundle()` collects: redacted config, redacted
    account state (counts, health, reset times — no tokens), resolved env flags, plugin+node versions,
    mimicry baseline version, and the last-N correlated request/response metadata (from P1.2 artifacts).
  - T2 `[medium]` — add `cli.mjs` subcommand `diagnose` (alias `dg`): writes
    `opencode-anthropic-diagnose-<ts>.json` and prints the path; `--stdout` to print instead.
- **New tests:** `lib/diagnose.test.mjs` + `cli.test.mjs` — bundle contains required sections; **grep
  test: zero secrets**; missing artifacts degrade gracefully (empty sections, no throw); **edge case:**
  no accounts configured; **edge case:** corrupted request-dump file is skipped with a note.
- **Acceptance:** `opencode-anthropic-auth diagnose` on a seeded fixture home produces a valid,
  secret-free bundle an agent can consume.
- **DoD:** committed; documented in `README.md` Troubleshooting + `CLAUDE.md`.

### Wave 1 gate

- **Acceptance:** G3 (no unredacted secret) demonstrably true across all sinks + bundle; correlation IDs
  link artifacts; `diagnose` works.
- **Senior QA review** (`docs/plans/qa/W1-review.md`) — emphasis on rubric #3 (security) → fix → PASS.
- **DoD:** README/CLAUDE updated; `npm test` green.

---

# Wave 2 — Verification infrastructure

_Goal:_ let an agent prove a change end-to-end and reproduce from captured traffic. Addresses Axis 2 +
completes Axis 3 (replay).

### Pre-flight (Wave 2)

- W1 gate PASS.
- Inventory existing ad-hoc mocks (`vi.mock("node:https")` sites) to design a compatible shared harness.
- Confirm `.mitm/` + `_analysis/captures/*.json` shapes (gitignored) to design the fixture format from
  real captures. Redact before importing any as a fixture.

---

## Phase 2.1 — Shared HTTP/SSE mock harness + fake Anthropic server `[medium]` ∥group=A

Addresses **no shared mock harness**.

- **owns:** `test/helpers/http-mock.mjs` (new), `test/helpers/fake-anthropic.mjs` (new),
  `test/helpers/http-mock.test.mjs` (new)
- **reads:** a few representative existing tests (grep-only) to match call conventions
- **Tasks:**
  - T1 `[medium]` — `fake-anthropic.mjs`: a scriptable stub that, given a queue of responses (status,
    headers, SSE chunks), answers `node:https`/fetch calls; supports 200 streaming, 401, 429 (+headers),
    529 overloaded, connection-reset.
  - T2 `[medium]` — `http-mock.mjs`: install/teardown helpers wrapping the stub so a test is 3 lines.
- **New tests:** `http-mock.test.mjs` — replays a scripted 200 SSE; simulates 429 with reset headers;
  simulates 529; **edge case:** mid-stream disconnect; **edge case:** empty/short SSE.
- **Acceptance:** a sample test drives a full fetch→stream cycle through the harness with zero bespoke
  mocking.
- **DoD:** committed; `CONTRIBUTING.md` "Writing Tests" points to the harness.

## Phase 2.2 — Capture→fixture→replay harness `[medium]` ∥group=A

Addresses **no replay harness / fixtures** (G1).

- **owns:** `test/fixtures/requests/` (new dir + README), `test/helpers/replay.mjs` (new),
  `test/helpers/replay.test.mjs` (new), `scripts/capture-to-fixture.mjs` (new)
- **reads:** `lib/redact.mjs`, `lib/mimicry` sources (grep-only until W3; here they are still in
  `index.mjs` — so **grep-only, no write**, and must not run while any task owns `index.mjs`)
- **Tasks:**
  - T1 `[medium]` — define the fixture format: `{ meta, request:{headers,body}, response:{status,
headers, sseChunks} }`, **redacted at write time** via `lib/redact.mjs`.
  - T2 `[medium]` — `scripts/capture-to-fixture.mjs`: convert a redacted `diagnose` bundle (W1) or a
    `.mitm`/`_analysis` capture into a fixture.
  - T3 `[medium]` — `replay.mjs replayThroughInterceptor(fixture)`: feed the request through the current
    body/response transforms and assert against expected output. In W2 it calls the functions in place
    (via a thin import shim); after W3 it targets the extracted `lib/mimicry/*`.
  - T4 `[medium]` — commit **one real redacted fixture** derived from an existing capture + a repro test
    that replays it (satisfies **G1**).
- **New tests:** `replay.test.mjs` — round-trips the committed fixture; detects an intentional mimicry
  drift (mutate expected → test fails); **edge case:** fixture with thinking-block round-trip;
  **edge case:** fixture with tool-use `mcp_`-prefixed names verifying the strip.
- **Acceptance:** G1 — a recorded bundle replays deterministically and a mimicry regression is caught.
- **DoD:** committed; fixture dir documented.

## Phase 2.3 — Coverage tooling + thresholds `[medium]` ∥group=B

Addresses **no coverage** (G2).

- **owns:** `vitest.config.mjs` (new at root), `package.json` (⚠ shared — seq w.r.t. other
  `package.json` owners), `CONTRIBUTING.md`
- **reads:** existing scripts
- **Tasks:**
  - T1 `[medium]` — add root `vitest.config.mjs` with V8 coverage, `include` for `lib/**` + root
    `index.mjs`/`cli.mjs`, sensible excludes (worker has its own config, `dist/`, gitignored dirs).
  - T2 `[medium]` — add `npm run coverage`; set **thresholds**: `lib/` statements ≥85%, branches ≥75%;
    `index.mjs`/`cli.mjs` start at current measured baseline (record it), ratcheting up in W3.
  - T3 `[fast]` — run coverage, record baseline numbers in `docs/plans/qa/coverage-baseline.md`.
- **New tests:** none (tooling) — but the baseline doc is a required artifact.
- **Acceptance:** `npm run coverage` runs and enforces thresholds; baseline recorded.
- **DoD:** committed; thresholds documented in `CLAUDE.md`.

## Phase 2.4 — Fill S1/S2/S4/S5 verification gaps `[medium]` ∥group=C (multiple disjoint owners)

Addresses concurrency/stream/retry test gaps. **Parallelizable** — each sub-task owns a different test
file (disjoint), so dispatch simultaneously.

- **T-a `[medium]` owns `lib/refresh-lock.test.mjs`** — add: successful first-acquire happy path;
  concurrent-acquire race (two callers, one wins); lock-file write IO-failure; Windows-ACL/permission
  path (skip-guarded on non-win32). reads `lib/refresh-lock.mjs`.
- **T-b `[medium]` owns `lib/storage.test.mjs`** — add: concurrent-writer collision (interleaved
  save via the harness); Windows-ACL-denied path (guarded); temp-file cleanup on rename failure already
  present → assert cross-platform. reads `lib/storage.mjs`.
- **T-c `[medium]` owns `test/conformance/stream-transform.test.mjs` (new)** — cover `transformResponse`
  (still in `index.mjs` — **grep/read-only**, do not write `index.mjs`): `stop_details` passthrough
  (the P3 TODO), `mcp_` tool-name strip on the way back, mid-stream error, empty stream, thinking-block
  byte-identical round-trip. Uses the W2.1 harness + W2.2 fixtures. reads `index.mjs` (grep-only).
- **T-d `[medium]` owns `test/phase3/retry-injection.test.mjs` (new)** — use the harness to script
  exact upstream sequences: `429→retry→200`, `529×3→model-fallback`, account-switch on
  `PERMISSION_DENIED`/`AUTH_FAILED`/`QUOTA_EXHAUSTED`, service-wide exhaustion → user message. reads
  `index.mjs` (grep-only), `lib/backoff.mjs`, `lib/tuning.mjs`.

> ⚠ Scheduling: T-c and T-d both `read` `index.mjs` (grep-only, no writes) → allowed concurrently with
> each other, but **not** concurrently with any task that _owns_ `index.mjs`. There is none in W2, so
> T-a…T-d run fully parallel.

- **New tests:** all of the above (that _is_ the phase).
- **Acceptance:** new tests green; coverage of S1/S2/S4/S5 rises above the W2.3 baseline; the
  `stop_details` TODO is now covered (update `CHANGELOG.md:41` note + remove the TODO).
- **DoD:** committed per sub-task (4+ commits).

### Wave 2 gate

- **Acceptance:** G1 met (replay), G2 met (coverage + thresholds), stream/concurrency/retry gaps closed.
- **Senior QA review** (`docs/plans/qa/W2-review.md`) — rubric #1/#4/#5 emphasis → fix → PASS.
- **DoD:** harness + fixtures + coverage documented; `npm test` + `npm run coverage` green.

---

# Wave 3 — Structural decomposition of `index.mjs`

_Goal:_ carve the monolith into ownable, unit-testable modules **without any mimicry regression**. The
W2 harness + conformance suite are the safety net. Addresses Axis 4 (G4).

> **Global-lock discipline:** `index.mjs` is owned by exactly one task at a time throughout W3. Phases
> here are **mostly `seq`**. Extraction targets (new `lib/` files) can be _scaffolded_ in parallel, but
> the `index.mjs` edit that wires each one is serialized.

### Pre-flight (Wave 3)

- W2 gate PASS; `regression.test.mjs` green; replay fixture(s) green (these are the regression oracle).
- Snapshot current outgoing request via the W2 harness → a **golden fixture** committed _before_ touching
  `index.mjs`, so every extraction is diffed against it.
- Oracle (`heavy`) reviews the target boundary map (audit §5) and confirms extraction order.

---

## Phase 3.1 — Extract mimicry: response-stream, then request-body, then headers `[heavy]` design / `[medium]` impl · seq

Highest-risk, least-tested logic first (with the new tests from W2.4 guarding it).

- **owns (serialized):** `index.mjs`, plus new files `lib/mimicry/response-stream.mjs`,
  `lib/mimicry/request-body.mjs`, `lib/mimicry/headers.mjs` and their `.test.mjs`
- **reads:** `lib/request-headers.mjs`, `lib/tuning.mjs`, W2 harness/fixtures
- **Tasks (each: extract → inject logger → wire → test green → commit):**
  - T1 — move `transformResponse`@9058 → `lib/mimicry/response-stream.mjs` with an **injected logger**
    (removes the manual `debugLog` mirroring). Add direct unit tests (SSE, `mcp_` strip, `stop_details`,
    thinking round-trip) — port from W2.4 T-c to target the new module.
  - T2 — move `transformRequestBody`@8137 → `lib/mimicry/request-body.mjs` (injected logger, `tuning`).
  - T3 — merge `buildRequestHeaders`@7967 into `lib/mimicry/headers.mjs` de-duplicated with
    `lib/request-headers.mjs`.
- **New tests:** colocated `lib/mimicry/*.test.mjs` for each; replay/golden fixture unchanged (proves no
  wire change). **Edge cases:** identical to W2.4 T-c plus header composition completeness (port
  relevant `regression.test.mjs` assertions into focused unit tests).
- **Acceptance:** `regression.test.mjs` + replay/golden fixtures **byte-identical** pass; new modules
  have direct unit tests; `index.mjs` LOC reduced.
- **DoD:** 3 commits (one per extraction), each keeping all tests green.

## Phase 3.2 — Extract retry/overload loop `[heavy]` design / `[medium]` impl · seq

- **owns (serialized):** `index.mjs`, `lib/retry/overload-loop.mjs` (new) + test
- **reads:** `lib/backoff.mjs`, `lib/tuning.mjs`, `lib/accounts.mjs`, W2.4 T-d tests
- **Design (heavy):** separate **pure decisions** (given status+headers+counts → {retry, switchAccount,
  modelFallback, fail}) from **effects** (sleep, account switch, toast). Pure core is unit-tested; the
  effectful shell stays thin in `index.mjs`.
- **New tests:** `lib/retry/overload-loop.test.mjs` — table-driven over status sequences (429/529/503/
  connection-reset) asserting the decision; **edge cases:** `consecutive529≥3` fallback boundary,
  `maxServiceRetries=0` for background requests, jitter bounds from `tuning`.
- **Acceptance:** decision core has ≥90% branch coverage; phase3 retry-injection tests still green via
  the new module; no mimicry change.
- **DoD:** committed serially; `index.mjs` LOC drops further.

## Phase 3.3 — Extract token-economy + session-metrics `[medium]` · seq

- **owns (serialized):** `index.mjs`, `lib/token-economy/{adaptive-thinking,cache-break,microcompact,
quota-warning}.mjs` (new) + tests, `lib/session-metrics.mjs` (new) + test
- **reads:** existing phase2/phase3 token-economy tests, `lib/rolling-summarizer.mjs`
- **Tasks:** move each closure state machine into its module with a clear state object + pure
  transitions; keep `sessionMetrics` JSDoc contract intact (move it to `lib/session-metrics.mjs`).
- **New tests:** colocated per module; **edge cases:** boundary-stability counter, microcompact gating
  thresholds, quota-warning tier flips, cache-break `messages_prefix` path.
- **Acceptance:** phase2/3 suites green; new modules unit-tested; `sessionMetrics` contract unchanged
  (a test asserts the shape).
- **DoD:** committed per module.

## Phase 3.4 — De-duplicate + CLI uses shared helpers `[medium]` ∥group=A (does NOT own index.mjs)

Addresses audit §5 duplication. Runs parallel to nothing that owns `index.mjs` (P3.1–3.3 finished).

- **owns:** `cli.mjs`, `cli.test.mjs`, `lib/format.mjs` (new, for shared `formatResetTime`) + test
- **reads:** `lib/oauth.mjs`, `lib/account-state.mjs`
- **Tasks:**
  - T1 — extract `formatResetTime` to `lib/format.mjs`; `cli.mjs` and the extracted modules import it
    (removes the `index.mjs:4666` / `cli.mjs:241` duplication — the `index.mjs` side was already moved in
    3.1–3.3, so this edits only `cli.mjs` + new lib).
  - T2 — `cli.mjs refreshAccessToken` (147) delegates to `lib/oauth.mjs refreshToken` (kill the reimpl).
  - T3 — `cli.mjs` uses `lib/account-state.mjs adjustActiveIndexAfterRemoval` instead of 3× inline logic.
- **New tests:** `lib/format.test.mjs`; extend `cli.test.mjs` for the delegated refresh + index
  adjustment; **edge case:** removal of the active account re-points index correctly.
- **Acceptance:** no duplicated `formatResetTime`/token-refresh/index-adjust remains (grep-proof);
  `cli.test.mjs` green.
- **DoD:** committed per task.

### Wave 3 gate

- **Acceptance:** G4 — `index.mjs` < 6000 LOC; mimicry/retry/token-economy in tested `lib/` modules;
  `regression.test.mjs` + replay/golden fixtures byte-identical; coverage thresholds ratcheted up.
- **Senior QA review** (`docs/plans/qa/W3-review.md`) — rubric #2 (mimicry integrity) + #6 (structure)
  emphasis → fix → PASS.
- **DoD:** `docs/mimese-http-header-system-prompt.md` cross-refs updated to new module paths;
  `CONTRIBUTING.md` architecture section updated.

---

# Wave 4 — Close the loop

_Goal:_ the last mile of "verify on a real build" + keep mimicry self-updating.

### Pre-flight (Wave 4)

- W3 gate PASS. Confirm extracted `lib/mimicry/*` are the replay target now.

## Phase 4.1 — Opt-in live-probe smoke test `[medium]` ∥group=A

- **owns:** `test/live/probe.test.mjs` (new, **skipped by default**), `scripts/live-probe.mjs` (new),
  `CONTRIBUTING.md`
- **reads:** `lib/mimicry/*`, W2 harness
- **Tasks:** a smoke test that, when `RUN_LIVE_PROBE=1` + a real token are present, sends one minimal
  request and asserts a `200` + expected response shape; **default: replays a recorded response** through
  the extracted mimicry so it runs in CI without credentials.
- **New tests:** the probe itself; **edge case:** missing creds → cleanly skipped, never fails CI.
- **Acceptance:** default run replays recorded response green; live mode documented but not required.
- **DoD:** committed; `CLAUDE.md` notes how to run a real probe.

## Phase 4.2 — Wire worker sync-watcher output → fixtures/decision table `[medium]` ∥group=B

- **owns:** `worker/sync-watcher/src/delivery.mjs` (+ its test), `docs/mimicry/beta-decision-table.md`
- **reads:** `worker/sync-watcher/src/{extractor,differ,analyzer}.mjs`
- **Tasks:** when the watcher detects a new Claude Code version, have its PR body also update the beta
  decision table (P0.3) and emit a redacted fixture skeleton, so the human/agent review of an upstream
  sync starts from structured data (further shrinks chokepoint **C1**).
- **New tests:** extend `delivery.test.mjs` — PR body includes decision-table diff; **edge case:**
  no-op when no beta changed.
- **Acceptance:** a simulated upstream bump produces a decision-table-aware PR body in tests.
- **DoD:** committed.

### Wave 4 gate + GLOBAL gate

- **Acceptance:** all Global acceptance criteria G1–G7 met.
- **GLOBAL senior QA review** (`docs/plans/qa/GLOBAL-review.md`) — full rubric across the whole change
  set; producer ≠ reviewer; reviewer tier `[heavy]`. Fix every finding → PASS.
- **Global DoD** (§C) executed: CHANGELOG + version bump + tag + audit status flip.

---

## E. Top-5, start-here specs (each startable from this doc alone)

These are the concrete entry points; ranked by attention-saved ÷ effort (audit §6).

### #1 — Agent decision layer (W0·P0.1–P0.3) `[medium]`

**Start:** create `CLAUDE.md`, `docs/mimicry/beta-decision-table.md`,
`docs/mimicry/strategy-decision-table.md`, `lib/tuning.mjs`(+test); fix `AGENTS.md` naming.
**Inputs:** audit §2 (C1–C7), `lib/request-headers.mjs`, `lib/backoff.mjs`, `lib/rotation.mjs`,
`docs/mimese-http-header-system-prompt.md`. **owns/reads:** per P0.1–P0.3. **Done when:** a `[fast]`
agent can answer "sync a new Claude Code version" and "pick a rotation strategy" from the docs alone;
`tuning.test.mjs` pins values to current literals.

### #2 — Redaction + `diagnose` bundle (W1·P1.1–P1.3) `[heavy]`+`[medium]`

**Start:** `lib/redact.mjs`(+test) → route `index.mjs` sinks through it + correlation IDs → `diagnose`
CLI cmd. **Inputs:** audit §4, `index.mjs` 3098–3123 & 3184–3222. **Critical:** fixes the live-token
leak in `debug-headers.log`. **Done when:** grep-proof no-secret test passes; one request yields
correlated redacted artifacts; `diagnose` emits a shareable bundle.

### #3 — Capture→fixture→replay + mock server (W2·P2.1–P2.2) `[medium]`

**Start:** `test/helpers/fake-anthropic.mjs`, `test/helpers/http-mock.mjs`, `test/helpers/replay.mjs`,
`scripts/capture-to-fixture.mjs`, `test/fixtures/requests/` + one real redacted fixture + repro test.
**Inputs:** existing `vi.mock` sites, `.mitm`/`_analysis` captures, `lib/redact.mjs` (from #2).
**Done when:** G1 — a recorded bundle replays deterministically and catches an injected mimicry drift.

### #4 — Coverage + fill concurrency/stream/retry gaps (W2·P2.3–P2.4) `[medium]`

**Start:** root `vitest.config.mjs` + `npm run coverage` + thresholds + baseline doc; then the 4
disjoint test tasks (refresh-lock race, storage concurrent-writer, stream `stop_details`/`mcp_` strip,
retry-injection sequences). **Inputs:** audit §3 table, harness from #3. **Done when:** G2 met; the
`stop_details` P3 TODO is covered and removed.

### #5 — Carve `index.mjs` (W3·P3.1–P3.4) `[heavy]`+`[medium]`

**Start:** commit a golden request fixture, then extract in order: `lib/mimicry/response-stream.mjs` →
`request-body.mjs` → `headers.mjs` → `lib/retry/overload-loop.mjs` → `lib/token-economy/*` →
`lib/session-metrics.mjs`; finally de-dupe CLI helpers. **Guardrail:** `regression.test.mjs` + replay
fixtures byte-identical at every step; `index.mjs` is a single-owner global lock. **Done when:** G4 —
`index.mjs` < 6000 LOC with extracted modules directly unit-tested.

---

## F. Traceability (audit → plan)

| Audit finding                               | Addressed by                         |
| ------------------------------------------- | ------------------------------------ |
| C1 mimicry drift                            | P0.3 (tables), P4.2 (auto-wired)     |
| C2 sources-of-truth drift                   | P0.4, Global DoD                     |
| C3 magic numbers                            | P0.3 (`lib/tuning.mjs`), wired in W3 |
| C4 beta OAuth-safety                        | P0.3                                 |
| C5 strategy choice                          | P0.3                                 |
| C6 tribal "docs are contract" / naming leak | P0.1, P0.2                           |
| C7 release ritual                           | P0.2, P0.4, Global DoD               |
| Axis2 no coverage                           | P2.3                                 |
| Axis2 no shared mock                        | P2.1                                 |
| Axis2 no golden request                     | P2.2, P3.1 pre-flight                |
| Axis2 SSE/`stop_details`                    | P2.4 T-c, P3.1 T1                    |
| Axis2 refresh-lock/storage concurrency      | P2.4 T-a/T-b                         |
| Axis2 retry-loop injection                  | P2.4 T-d, P3.2                       |
| Axis2 no live probe                         | P4.1                                 |
| Axis3 leak (unredacted)                     | P1.1, P1.2                           |
| Axis3 no bundle / uncorrelated              | P1.2, P1.3                           |
| Axis3 no replay/fixtures                    | P2.2                                 |
| Axis3 no mock-event injection               | P2.1, P2.4 T-d                       |
| Axis4 `index.mjs` monolith                  | W3 (all)                             |
| Axis4 duplication                           | P3.4                                 |
| Axis4 hygiene                               | P0.5                                 |
