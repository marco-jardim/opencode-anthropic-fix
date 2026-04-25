# Token Economy CC-Parity — Master Roadmap

> **For agentic workers:** This is a roadmap across 3 phases. Each phase has (or will have) its own detailed plan. Do NOT execute from this document. Execute from `2026-04-18-phase-a-surgical-fixes.md` (Phase A ready now) and later `phase-b-*.md` / `phase-c-*.md` (written before each phase begins).

**Goal:** Bring opencode's per-turn token cost to within 1.1×–1.3× of real Claude Code by fixing cache-invalidation bugs, tuning built-in compaction, and adopting CC's context-hint protocol.

**Baseline (measured from user's 2026-04-18 session):** 1100 messages, ~1MB per request, ~262k estimated tokens. System prompt 48KB (3× CC). One confirmed cache break at turn 6 (systemPromptTailing). Plugin already has most mimicry; gap is economy.

**Target:** cache_read dominates over cache_creation in long sessions; no cache breaks except true invalidations (new tools, new system blocks, expired TTL).

**Repos in scope:**

- `D:\git\opencode-anthropic-fix` (plugin) — edits to `index.mjs`, `lib/config.mjs`, new tests.
- `D:\git\opencode` (fork) — edits to `packages/opencode/src/session/*.ts`, `packages/opencode/src/provider/transform.ts`, `packages/opencode/src/config/config.ts`.

---

## Phase A — Surgical fixes (1 day, highest ROI)

Fix confirmed bugs and flip two defaults. Expected immediate reduction: 30–40% on long sessions.

| ID  | Summary                                                                                                                                                              | Repo   | File                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| A1  | Fix `isAdaptiveThinkingModel` to recognize opus-4-7 — dumps show `thinking: undefined` on every request for this model; no effort-beta either.                       | plugin | `index.mjs:6157`                                                                            |
| A2  | Default `token_economy_strategies.system_prompt_tailing` to `false` — dumps show it shrinks system prompt 48KB→1.8KB at turn 6, breaking cache over ~1MB of history. | plugin | `lib/config.mjs` + `index.mjs:7589`                                                         |
| A3  | Add `compaction.threshold` (default 0.85) — trigger auto-compact BEFORE overflow, not AT overflow.                                                                   | fork   | `packages/opencode/src/config/config.ts:202`, `packages/opencode/src/session/overflow.ts:8` |

**Detailed plan:** `2026-04-18-phase-a-surgical-fixes.md` (ready to execute).

**Exit criteria:** all tests pass; measured via a fresh session of 20 turns with 5 tool calls each, cache_read ≥ cache_creation × 3 after turn 3.

---

## Phase B — Structural (3–5 days)

After Phase A stabilizes, tackle the next tier: more selective pruning, env stability, and a new rolling summarizer.

| ID  | Summary                                                                                                                                                                                | Repo                                        | File                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| B1  | Per-tool-class prune thresholds — `Read`/`Grep`/`Glob`/`LS` outputs prunable at 10k (reproducible); `Bash`/`Edit`/`Write` keep 40k.                                                    | fork                                        | `packages/opencode/src/session/compaction.ts:31-33`            |
| B2  | Session-stable env snapshot — `sys.environment()` is called per-request (`prompt.ts:1490`). Cache at session start, invalidate only on `/refresh` or explicit config change.           | fork                                        | `packages/opencode/src/session/system.ts:48`, `prompt.ts:1490` |
| B3  | Rolling summarizer via plugin hook — wire `experimental.session.compacting` to a deterministic Haiku summary (temp 0, fixed template) after N turns. Runs client-side before overflow. | plugin (new hook impl) + fork (verify hook) | new: `lib/rolling-summarizer.mjs`, wired via `opencode.plugin` |

**Why B2 matters:** env currently includes `Today's date: ${toDateString()}` — stable within a day but rebuilt each request. If the session spans midnight, one cache break. More importantly, once we add more env fields (git branch, open files), stability becomes critical.

**Plan:** `2026-04-18-phase-b-structural.md` (TO BE WRITTEN before starting Phase B; decision points to resolve during writing: does B3 go in the plugin or as a new opencode plugin? Current recommendation: plugin, because the anthropic-fix plugin already has closure state and a Haiku call path).

---

## Phase C — CC parity (5–7 days)

Adopt CC's context-hint protocol for production. The plugin already has the wire shape for `context-hint-2026-04-09` and the 400/409/422/424/529 error handling (from v2.1.110 work); what's missing is a **deterministic** message compaction (MC) so enabling it doesn't re-break the cache on each trigger.

| ID  | Summary                                                                                                                                                                                                                                                                       | Repo        | File                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| C1  | Deterministic message compaction for 422/424 retry — when server signals compact-and-retry, apply a canonical transform that produces byte-identical output given identical input (no timestamps, no ordering drift).                                                         | plugin      | `index.mjs:~5312` (existing `applyContextHintCompaction`) |
| C2  | Flip `token_economy.context_hint` default to `true` for main-thread on first-party providers and non-claude-3 models — after C1 proves determinism via regression test.                                                                                                       | plugin      | `lib/config.mjs` default block                            |
| C3  | Session-wide tool-result dedupe — if `Read` of file X happens 5 times, earlier 4 become stubs `[Read of X superseded by later read at msg Y]`. Uses `experimental.chat.messages.transform` hook. Determinism requirement: decision function is pure over the message history. | fork plugin | new file in fork OR new plugin                            |

**RE reference:** CC v2.1.112 `cli.js`, function `d6A` (`createContextHintController`) and `d85` (`applyHintEdits`). Key properties to mirror:

- Activates only for `querySource.startsWith("repl_main_thread")`.
- Beta header `context-hint-2026-04-09` + body `context_hint: {enabled: true}` only on first request each session (latching).
- On 422/424: `applyHintEdits` → clear thinking + run MC (`qD4`) with `keepRecent: Q6A` → retry with `clearedIds` returned.
- On 400 (with context-hint in error) / 409 / 529: disable sticky for session.

**Plan:** `2026-04-18-phase-c-cc-parity.md` (TO BE WRITTEN after Phase B merges).

---

## Observability (parallel to all phases)

Opt-in diagnostics we already ship (keep enabled during testing):

- `token_economy.debug_dump_bodies: true` — dumps request bodies to `~/.opencode/opencode-anthropic-fix/request-dumps/`.
- `cache_break_detection.enabled: true` (default) — toasts when `cache_read_input_tokens` drops >threshold.
- `v0.1.14+` tracks `messages_prefix` hash, so toasts name the broken source.

**After Phase A ships:** add a one-line "session cache economy" toast at session end: `cache_read=X  cache_create=Y  ratio=Z` so the user sees the win concretely.

---

## Cross-phase dependencies

```
A1 ─┬─► (unblocks thinking signature correctness for all subsequent work)
A2 ─┤
A3 ─┤
    │
    ├─► B1 ─► B2 ─► B3 ─► (requires A3's threshold plumbing)
    │
    └─► C1 ─► C2 ─► C3 ─► (C1 requires B2's env stability to test determinism)
```

**Parallelization:** A1/A2/A3 independent. B1 independent of A. B2 independent. B3 depends on A3. C requires B2. C1/C2/C3 sequential.

---

## Metrics to track (collect before Phase A and after each phase)

1. **Per-turn input tokens** (from API response `usage.input_tokens`).
2. **Per-turn cache_read / cache_creation** (from `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`).
3. **Session total cost** via plugin's existing accounting.
4. **Cache-break events** via `cache_break_detection` toasts.

**Expected deltas (best case):**

- After A: cache_creation on long sessions drops ~60% (tailing-break eliminated); thinking fix stabilizes signature cache.
- After B: per-turn input tokens drop another 20–30% on sessions >15 turns (prune + summarizer).
- After C: opt-in message compaction cuts catastrophic overflow-path retries; servers context-hint delivers CC-level efficiency.

---

## Non-goals

- Rewriting the ai-sdk message serialization (determined stable in the 2026-04-18 dumps).
- Implementing client-side context-hint when no server support (protocol is server-driven; we only react).
- Fast-mode / effort changes (already handled in prior work).
- Multi-account rotation strategy (orthogonal).

---

## Open questions

1. **B3 location**: plugin vs new opencode plugin? Writing Phase B plan resolves this. Current lean: plugin (has Haiku call path + closure state).
2. **C2 gating**: roll out default-on to all first-party main-thread, or behind an env flag for 1 week? Writing Phase C plan resolves.
3. **Worktree strategy**: single worktree per phase (recommended) or per task? Writing phase plans pick one.
