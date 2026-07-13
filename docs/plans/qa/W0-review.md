# Wave 0 — Senior QA Review

**Verdict: PASS** (after fixes recorded below).
**Reviewer:** orchestrator (opus, acting per plan §A5.5 — reviewer tier ≥ producer for all subagent-produced work).
**Date:** 2026-07-13
**Scope:** P0.1–P0.5.

## Evidence

- Full suite: **56 files / 1227 tests passed** (baseline was 54 / 1218; +2 files, +9 tests from `lib/tuning.test.mjs` and `scripts/check-invariants.test.mjs`).
- `npm run lint`: exit 0 (22 pre-existing unused-var warnings only; none in new files).
- `npm run format:check`: exit 0 (after fix F3 below).
- `node scripts/check-invariants.mjs`: exit 0 — `PASS (0 errors, 2 warnings)`.

## Rubric

1. **Correctness** — PASS. P0.3b `tuning.test.mjs` cross-checks each constant against the live `index.mjs` literal (real drift guard, not tautological). P0.4 `check-invariants.test.mjs` exercises pass + fabricated-mismatch + regex edge cases.
2. **Mimicry integrity** — PASS. No wire change in W0 (docs + new lib/tuning + guard only; `index.mjs` untouched). `test/conformance/regression.test.mjs` green within the full suite.
3. **Security** — PASS. No secrets introduced; no debug sinks touched.
4. **No regressions** — PASS. Full suite green; lint exit 0; no `as any`/`@ts-ignore`; no skipped/deleted tests.
5. **Edge cases** — PASS. tuning `@see`-coverage test; check-invariants changelog-with/without-date regex; changelog-behind = warn, changelog-ahead = error.
6. **Structure** — PASS. All new files within declared ownership; `index.mjs` global lock never taken in W0.
7. **Docs & discoverability** — PASS. `CLAUDE.md` (6 required sections, links resolve), beta table (28 registry flags + forced + conditional + caller-supplied, each with source-of-truth `file:line`), strategy table (behavior + hybrid scoring + symptom→strategy + precedence).

## Findings caught & resolved during the gate

- **F1 (P0.5, real bug):** The hygiene sweep reported `nul` absent, but a **real** stray `nul` file existed. Windows `Test-Path`/`fs.existsSync` are unreliable for the reserved device name `nul`. The P0.4 guard's `readdirSync`-based check correctly detected it; deleted via the `\\?\` extended-length path. `readdirSync` now shows no `nul`. RESOLVED.
- **F2 (P0.1, self-inflicted):** An illustrative `"Claude Code" → "Claude Code"` literal was added to `AGENTS.md`, which would trip both P0.1 acceptance and the P0.4 guard. Reworded to describe the artifact without embedding it. RESOLVED.
- **F3 (P0.3b + qa docs):** `npm run format:check` failed on `lib/tuning.test.mjs` and `docs/plans/qa/preflight-notes.md`. `prettier --write` applied; suite still green. RESOLVED. (Note: the P0.3b agent's "prettier passes" self-report was inaccurate for its test file — verified independently here.)

## Notes

- C2 sources-of-truth drift is a known, non-failing warning from `check:invariants`; deferred to the Global DoD per `docs/plans/qa/preflight-notes.md`.
- `nul`, `.ruff_cache/`, and root `*.tgz` are now absent from the working tree; the guard fails if `nul` reappears.
