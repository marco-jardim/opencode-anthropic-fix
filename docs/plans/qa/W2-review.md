# Wave 2 — Senior QA Review (Verification Infrastructure)

**Reviewer:** orchestrator (opus-tier, per plan §A5 self-review clause; producer ≠ reviewer for each
delegated task — implementers were `medium` subagents).
**Date:** 2026-07-13
**Scope:** W2·P2.1–P2.4 + gate.
**Verdict:** ✅ **PASS** (all findings resolved before this doc landed).

## Commits under review

| Commit    | Phase    | Summary                                                                        |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `8f160c6` | P2.1     | Shared HTTP/SSE mock harness (`test/helpers/fake-anthropic.mjs` + `http-mock`) |
| `69c9b29` | P2.4·T-a | `lib/refresh-lock.test.mjs` +4 (race / IO-fail / win32-guard)                  |
| `afb0824` | P2.4·T-b | `lib/storage.test.mjs` +3 (concurrent-writer / ACL / temp-cleanup)             |
| `43b05e3` | P2.3     | `lib/config.test.mjs` +7 (57.7%→92.5%)                                         |
| `df78528` | P2.3     | Root `vitest.config.mjs` V8 coverage + thresholds + baseline doc + policy      |
| `fe80215` | P2.2     | Capture→fixture→replay harness + real redacted fixture + repro test (**G1**)   |
| `9409cfd` | P2.4·T-c | `test/conformance/stream-transform.test.mjs` (6 tests)                         |
| `c529909` | P2.4·T-d | `test/phase3/retry-injection.test.mjs` (4 tests)                               |

## Rubric findings

1. **Correctness** — PASS. G1 replay drives the _real_ `AnthropicAuthPlugin` interceptor (transforms are
   not exported, so the public `auth.loader().fetch` path is used — the plan's "in-place shim", retargeted
   to `lib/mimicry/*` in W3). Tests are assertion-bearing and non-tautological.
   - **QA finding F-W2-1 (resolved):** the P2.2 drift test was initially tautological (derived the "drift"
     from the actual output, then asserted the output didn't contain it). Rewritten into a load-bearing
     golden comparator that checks the _actual_ transformed outgoing request against a golden and proves the
     comparator flips to `false` under an injected drift. Fixed before `fe80215` landed.
2. **Mimicry integrity** — PASS. Zero production edits in all of Wave 2 (`index.mjs`/`cli.mjs`/`lib/*`
   untouched — verified per task via scoped `git status`). `test/conformance/regression.test.mjs` remains
   green in the full suite. No wire-contract change → `docs/mimese-http-header-system-prompt.md` needs no
   update this wave.
3. **Security** — PASS. The one committed fixture (`test/fixtures/requests/plugin-001-messages.json`) was
   secret-scanned (`sk-ant`/`Bearer`/`oat01`/`x-api-key`) → clean; redaction routes through the existing
   `lib/redact.mjs` (`redactSecrets`) at fixture write time. `_analysis/captures/` (the request-only source
   with a real `x-api-key`) stays gitignored.
4. **No regressions** — PASS. Full suite **61 files / 1274 passed + 1 skipped**; `npm run coverage` exit 0;
   lint clean.
   - **QA finding F-W2-2 (resolved):** T-d tripped `prefer-const` (`let fetchFn` assigned once via
     destructuring). Collapsed to `const { fetch: fetchFn } = …`; husky green.
5. **Edge cases** — PASS. refresh-lock: concurrent race (one winner), non-EEXIST IO-failure rejection,
   POSIX-perms win32-skip. storage: out-of-order concurrent commit (last-rename-wins), Windows-ACL EACCES
   (guarded), temp cleanup on EPERM. stream: `mcp_` strip on tool names _and_ non-strip of prose,
   `stop_details` passthrough, mid-stream error, empty stream, thinking round-trip. retry: account-switch on
   QUOTA_EXHAUSTED and AUTH_FAILED (distinct per-account authorization observed), 529 same-account retry→200,
   529 exhaustion→user-facing overload toast + 529.
6. **Structure** — PASS. All additions live in `test/helpers`, `test/fixtures`, `test/conformance`,
   `test/phase3`, `scripts/`, root `vitest.config.mjs` — no new production coupling.
7. **Docs & discoverability** — PASS. Coverage policy documented in `CONTRIBUTING.md` + `CLAUDE.md`;
   `coverage-baseline.md` recorded; fixture format `README.md` present; harness API self-documented via JSDoc.

## Acceptance criteria (plan Wave 2 gate)

- **G1 (replay + drift detection):** MET — `test/helpers/replay.test.mjs` replays the committed fixture
  deterministically and catches an injected mimicry drift.
- **G2 (coverage + thresholds):** MET — `npm run coverage` enforces per-glob thresholds and exits 0;
  `lib/` 89.0% stmt / 83.4% br; `index.mjs` **57.96%→58.5%** stmt / 53.85%→**54.84%** br (rose via the new
  interceptor-driven tests); `cli.mjs` 70.1% / 61.4% (ratchets up in W3).
- **S1/S2/S4/S5 gaps:** closed (refresh-lock race, storage concurrency, SSE transform, retry injection).
- **`stop_details` TODO:** covered by the P2.4·T-c test; `CHANGELOG.md:41` note updated to "resolved".

## Deferred / carried notes

- **F1 (flaky `TokenBucketTracker > tracks accounts independently`, `lib/rotation.test.mjs`):** did not
  recur this wave; candidate stabilization deferred (tracked in `preflight-notes.md`).
- **529 → model-fallback (`consecutive529 ≥ 3`)** is **unreachable via the public interceptor** with default
  `maxServiceRetries = 2` (the fallback is gated _inside_ the `< maxServiceRetries` branch, so `consecutive529`
  caps at 2). Documented honestly in the T-d test; the pure decision core will be unit-tested directly when
  the overload loop is extracted in **W3·P3.2**.

**Result: PASS — Wave 2 closed.**
