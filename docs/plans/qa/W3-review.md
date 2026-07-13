# Wave 3 — Senior QA Review (structural decomposition of `index.mjs`)

**Verdict: PASS**
**Reviewer tier:** heavy (orchestrator, opus) — producer ≠ reviewer for each extraction (medium/orchestrator implemented; reviewed here independently).
**Date:** 2026-07-13
**Baseline:** `240685c` → **`347c20b`** (14 W3 commits).
**Rubric emphasis (per plan §B / W3 gate):** #2 Mimicry integrity, #6 Structure.

## Scope delivered

`index.mjs` decomposed from **9688 → 5915 LOC** (`git show HEAD:index.mjs | Measure-Object -Line`) — **G4 (`< 6000`) met.** Eleven `lib/` modules extracted, each with direct unit tests, **none importing `index.mjs`** (verified acyclic):

| Module                               | Contents                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/env.mjs`                        | `isFalsyEnv`, `isTruthyEnv`                                                                                                                       |
| `lib/mimicry/models.mjs`             | `CLAUDE_3_MODEL_RE`, `isOpus46/47/48Model`, `isAdaptiveThinkingModel`, `hasOneMillionContext`, `isEligibleFor1MContext`, `normalizeThinkingBlock` |
| `lib/mimicry/cache.mjs`              | `resolveCacheTtl`, `shouldPlaceToolBreakpoint`, `updateBoundaryStability`                                                                         |
| `lib/mimicry/response-stream.mjs`    | `createTransformedSSEStream`, `stripMcpPrefixFromSSE`, usage/stop-reason extraction, idle timeout                                                 |
| `lib/mimicry/system-prompt.mjs`      | `buildSystemPromptBlocks`, `normalizeSystemTextBlocks`, `sanitizeSystemText` (OpenCode→Claude Code), compaction/dedupe/tail helpers               |
| `lib/mimicry/request-helpers.mjs`    | `repairOrphanedToolUseBlocks`, `stripSlashCommandMessages`, `extractFirstUserMessageText`, `buildRequestMetadata`, `resolveMaxTokens`             |
| `lib/mimicry/request-body.mjs`       | `transformRequestBody` (orchestrator), `CORE_TOOL_NAMES`                                                                                          |
| `lib/mimicry/headers.mjs`            | `buildRequestHeaders`, `buildAnthropicBetaHeader`, `detectProvider`, stainless headers, `extractFileIds`                                          |
| `lib/token-economy/transforms.mjs`   | 13 pure token-economy transforms (ttl-strip, microcompact, dedupe, tool-ordering, budget)                                                         |
| `lib/token-economy/microcompact.mjs` | `shouldMicrocompact`, `buildMicrocompactBetas`                                                                                                    |
| `lib/session-metrics.mjs`            | `sessionMetrics` singleton, `createInitialSessionMetrics`, `getAverageCacheHitRate`                                                               |
| `lib/retry/overload-loop.mjs`        | `computeServiceRetrySleepMs`, `selectFallbackModel`, `shouldServiceRetry`, `isTransientRateLimit` (pure decision core) + wired `lib/tuning.mjs`   |

## Rubric findings

1. **Correctness** — PASS. Every extraction moved function bodies **verbatim** (headers cluster AST-verified; others diff-verified as pure moves). New modules carry direct unit tests (models, cache, response-stream, system-prompt, request-helpers, request-body, headers, transforms, microcompact, session-metrics, overload-loop). No tautological tests.

2. **Mimicry integrity (EMPHASIS)** — PASS. The golden-outgoing guard (drives the real interceptor twice, self-calibrates non-determinism, deep-equals a committed golden) and `regression.test.mjs` (68) stayed **byte-identical green across all 14 W3 commits**. `buildAnthropicBetaHeader` (oauth-2025-04-20 forced first + full beta-decision logic), `transformResponse`, and `transformRequestBody` now live verbatim in `lib/mimicry/*`. `stream-transform` (6) + `response-stream` (6) + `retry-injection` (429→200, 529×3→fallback, account-switch, exhaustion) all green — confirming the P3.2 pure-decision extraction preserved retry behavior. `docs/mimese-http-header-system-prompt.md` updated with new module homes (wire semantics unchanged).

3. **Security** — PASS. No secret-handling or redaction code touched; no tokens in fixtures/snapshots.

4. **No regressions** — PASS. Full suite **74 files / 1403 passed + 1 skipped**; `eslint` 0 errors (pre-existing warnings only); `npm run coverage` EXIT 0.

5. **Edge cases** — PASS. Ported unit tests + guards cover SSE mcp\_ strip/`stop_details`/thinking round-trip, 1M-context predicates, transient-429 vs service-retry vs model-fallback boundaries, microcompact threshold gating.

6. **Structure (EMPHASIS)** — PASS. `index.mjs` is now a thin interceptor/OAuth/retry shell. Export discipline preserved (only function-valued top-level exports; test-only internals on `AnthropicAuthPlugin.__testing__`/`__cacheInternals`, re-attached via imports). Lib modules import only from other lib modules — no cycles. State shared by reference where needed (`sessionMetrics` singleton).

7. **Docs & discoverability** — PASS. `CONTRIBUTING.md` architecture section + mimese contract doc updated; `preflight-notes.md` records the two deferrals below.

## Accepted deferrals / non-actions (documented)

- **F-W3-1 (coverage re-baseline, accepted):** decomposition redistributed covered mimicry logic from `index.mjs` into directly-unit-tested `lib/` modules, so `index.mjs` file-local coverage fell (51.67/48.05). Thresholds re-baselined to a regression-guarding floor (50/47); `cli.mjs` ratcheted up (70/61); `lib/**` held (85/75); overall ~70% unchanged. Rationale in `coverage-baseline.md`.
- **F-W3-2 (P3.3 stateful cluster deferred, accepted):** `resolveAdaptiveContext`, `cacheBreakState`, `microcompactState`, `quotaWarningState` are module-mutable state machines entangled with the interceptor and the mimicry beta-assembly surface. G4 already met; extracting them risks the #1 regression surface for negligible structural gain. Leaf-pure microcompact helpers were extracted.
- **F-W3-3 (T1 `formatResetTime` non-merge, accepted):** the `index.mjs` and `cli.mjs` versions are intentionally different formatters (rounded `~2m`/`unknown` vs precise `2m 30s`); merging would change user-visible output. `lib/format.mjs` not created.

All findings accepted/resolved. **Wave 3 gate: PASS.**
