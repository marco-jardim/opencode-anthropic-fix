# Wave 1 — Senior QA Review (Observability & Safe Reproduction)

**Reviewer:** orchestrator (opus, direct per plan §A5.5 — producer work was delegated to `medium`, review is independent).
**Date:** 2026-07-07 session.
**Scope:** P1.1 (redaction coverage), P1.2 (correlation ID + opt-in SSE capture), P1.3 (`diagnose` bundle).
**Commits reviewed:** `8e4edca`, `3db80f0`, `effef0a`, `ab459b1`.
**Verdict:** ✅ **PASS** (2 findings — F1 pre-existing/non-blocking, F2 accepted-with-rationale).

---

## Rubric findings

### 1. Correctness — PASS

- P1.1: `lib/redact.test.mjs` gained 3 real tests (generic-fields-intact, token-mid-URL, grep-proof header+body fixture). Not tautological — seeds fake secrets and proves absence.
- P1.2: correlation ID generated per attempt (`createDebugCorrelationId`, session-hex + monotonic base36 seq), stamped on the request-dump filename+envelope and both `debug-headers.log` entries. Tests assert matching id, monotonicity, and disabled-sink no-write.
- P1.2 SSE: opt-in capture with 256KB cap + keep-last-10 rotation; tests cover enabled/disabled/redaction/truncation.
- P1.3: `buildDiagnosticBundle()` returns `meta/config/env/accounts/artifacts`; tests cover grep-proof zero-secrets, email masking, graceful degradation (no accounts, missing dirs, corrupt `req-*.json`).

### 2. Mimicry integrity — PASS

- P1.2 correlation ID: **zero wire impact** — `correlationId` flows only into `createDebug*` helpers that write debug files; never added to `requestHeaders`/`finalBody`/`fetch` (diff-verified).
- P1.2 SSE capture: **passive tee** — copies raw upstream decoded `text` into a capped buffer only; `controller.enqueue`/`rewriteSSEChunk`/`stripMcpPrefixFromSSE`/`new Response` output untouched. A dedicated guardrail test asserts downstream bytes are **byte-identical** with capture on vs off.
- `test/conformance/regression.test.mjs` green throughout (capture flag is off there). No header/beta/system-prompt/body-shape change → `docs/mimese-http-header-system-prompt.md` correctly NOT modified (no wire contract change).

### 3. Security (EMPHASIS) — PASS

- **Sink audit (index.mjs disk writes):** request-body dump (`:3123`, redacted envelope), outgoing header log (`:3144`, `redactSecrets`), response header log (`:3246`, `redactSecrets`), SSE capture (`:4495`, `redactString`) — all redacted. Non-debug writes carry no credentials and are out of G3 scope: Files-API download (`:1678`, user-requested file content), session stats (`:5645`, aggregate counts), generated signature user-id (`:6677`, non-credential id, mode 0600).
- **diagnose bundle:** per-section `redactSecrets` + a whole-bundle `redactSecrets` safety net; account summary maps only safe fields and explicitly omits `access`/`refreshToken`; emails masked to `a***@domain`.
- Since P1.1, `redactSecrets` also scrubs string **leaf values** via `redactString` (Bearer/`sk-ant`/`oat01`), so tokens embedded in nested string values are caught, not just secret-named keys.
- **G3 = SATISFIED**, encoded in grep-proof tests (`redact`, `diagnose`) + the byte-identical SSE guardrail.

### 4. No regressions — PASS (see F1)

- Full suite green: **57 files / 1241 tests**. Lint: 0 errors (20 pre-existing unused-var warnings). No new `as any`/`@ts-ignore`; the added `catch {}` blocks are intentional debug-safety with explanatory comments; no skipped/deleted tests.

### 5. Edge cases — PASS

- P1.2: two rapid requests → distinct ids; capture disabled by default (no files when flags off); >256KB → truncation marker.
- P1.3: no accounts (`count:0`); corrupt `req-*.json` → `{error:"unparseable"}` (does not abort); missing dirs → empty arrays.

### 6. Structure — PASS

- P1.2 extracted pure, exported helpers (`createDebugCorrelationId`, `isDebugSinkEnabled`, `createDebugRequestDump`, `createDebugOutgoingHeadersEntry`, `createDebugResponseHeadersEntry`, `writeSseCapture`) — directly unit-testable and pre-stages W3 extraction. `lib/diagnose.mjs` is a clean, dependency-injectable-by-mock new module. No new cross-module entanglement.

### 7. Docs & discoverability — PASS

- `diagnose` documented in README (Troubleshooting) + `CLAUDE.md`. The diagnose command is the intended shareable path and exposes the artifact inventory, so raw debug-artifact formats are discoverable through it + code/tests/commit messages.

---

## Findings

### F1 — Flaky `TokenBucketTracker > tracks accounts independently` under full-suite load (pre-existing) — NON-BLOCKING

- **Symptom:** `lib/rotation.test.mjs` failed once inside the husky full-suite run during the P1.3 commit; passed 36/36 in isolation twice immediately after. Time/refill-based assertion sensitive to parallel-load scheduling jitter.
- **Not introduced by W1** (P1.3 does not touch `lib/rotation.mjs`). Workaround: re-run the commit (the flaky test passes on retry).
- **Ownership:** recorded in `docs/plans/qa/preflight-notes.md`. Candidate for a small timing-hardening fix during **W2·P2.4** (concurrency/timing test work) or opportunistically. If it begins to block gates repeatedly, fix immediately (fake timers or tolerance).

### F2 — Raw debug-artifact format not separately documented — ACCEPTED

- Correlation-ID envelope + `res-*.sse` format are understandable from code/tests; the user-facing `diagnose` path (documented) is the intended consumption route. No further doc expansion required for W1 close.

---

## Gate decision

Wave 1 acceptance met: G3 proven; correlation IDs link request/response/header artifacts; `diagnose` produces a valid secret-free bundle. All findings resolved or accepted. **PASS → proceed to Wave 2.**
