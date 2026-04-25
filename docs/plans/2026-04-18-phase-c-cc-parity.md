# Phase C — CC Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` for tracking.

**Goal:** Adopt Claude Code's context-hint protocol for production use. The plugin already has the wire shape (`context-hint-2026-04-09` beta, 400/409/422/424/529 handling) from v2.1.110 work; what's missing is a **deterministic** message compaction (MC) pass so enabling context-hint on by default doesn't re-break the cache each time the server triggers compact-and-retry.

**Architecture:** Three plugin-side changes. C1 adds a regression harness proving `applyContextHintCompaction` is byte-stable across runs (pure function invariant — any future edit that introduces non-determinism fails a test). C2 flips the `token_economy.context_hint` default to `true` only for first-party providers on non-claude-3 models in main-thread requests (matches real CC gating). C3 adds session-wide tool-result dedupe behind a flag.

**Tech Stack:** JavaScript ESM (plugin), Vitest, Node 18+.

**Exit criteria:**

- C1: `applyContextHintCompaction` proven byte-identical across two runs over the same input; tests enumerate determinism-hostile patterns (timestamps, random IDs, set iteration order) and assert none creep in.
- C2: On first-party providers with a non-claude-3 model and main-thread classification, `context_hint: true` is the default unless the user explicitly sets `false`. Opt-out respected.
- C3: With `token_economy.tool_result_dedupe_session_wide: true`, repeated `Read(X)` tool outputs in a session produce a single latest verbatim block — older blocks become `[Read of X superseded by later read at msg Y]` stubs. Decision function is pure over history (deterministic).

**Repos in scope:**

- `D:\git\opencode-anthropic-fix` — `index.mjs`, `lib/config.mjs`, new test files.
- No fork changes.

---

## Task 1 (C1): Determinism regression harness for `applyContextHintCompaction`

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\index.mjs:5399-5461` — inline determinism hardening only if the test reveals a gap. Otherwise just the regression test.
- Create test: `D:\git\opencode-anthropic-fix\test\conformance\context-hint-determinism.test.mjs`.

**Why this matters:** `applyContextHintCompaction` runs on every 422/424 response. If its output drifts byte-for-byte across runs over the same input (timestamps in placeholder text, Set iteration order leaking into a `Set<>` scan, sort-stability on mixed-type keys), the post-MC prefix hashes differently each time → server-side cache for the already-paid prefix dies → cache*creation spikes on every retry. The function \_looks* pure today but there's no guard; C1 installs one.

### Implementation

- [ ] **C1.1: Write the failing determinism test FIRST**

Create `test/conformance/context-hint-determinism.test.mjs`. Import `applyContextHintCompaction` via the plugin's existing test-hook export (check `AnthropicAuthPlugin.__testing__` in `index.mjs` around line ~2300 for the existing pattern — add `applyContextHintCompaction` to the exported testing surface if it isn't already there).

Required assertions:

1. **Byte-identical output**: build a fixture messages array with 20 mixed user/assistant messages, including 12 tool_result blocks (half with content strings, half with structured `[{type:"text",text:"..."}]` content) and 4 assistant messages with thinking blocks. Call `applyContextHintCompaction(messages)` twice in a row → `JSON.stringify(out1.messages) === JSON.stringify(out2.messages)`.
2. **Stable across Object.keys insertion order**: construct two semantically equivalent fixtures where block objects were built with keys in different orders (`{type, content, tool_use_id}` vs `{tool_use_id, type, content}`). Output of `applyContextHintCompaction` on both → `JSON.stringify` equal.
3. **No timestamps in output**: regex-scan the stringified output for any 13-digit number (unix ms) or ISO-8601 date — assert none present that weren't in the input.
4. **No Date.now / Math.random / new Date in the function source**: read `index.mjs` as text, slice out the `applyContextHintCompaction` function body (from `function applyContextHintCompaction` to its closing brace), regex-scan for forbidden tokens. Same pattern as `test/rolling-summarizer.test.mjs` source-hygiene test.
5. **Stats are deterministic**: the `stats.thinkingCleared` and `stats.toolResultsCleared` counts are identical across runs.
6. **keepRecent boundary**: with `keepRecent=8`, exactly the last 8 tool_result blocks remain untouched; with `keepRecent=0`, all blocks become placeholders; with `keepRecent=100` (> total), none become placeholders.

Run: `cd D:/git/opencode-anthropic-fix && npx vitest run test/conformance/context-hint-determinism.test.mjs` — expect fail if the function isn't exported via `__testing__` yet; otherwise expect all tests pass (the function is already pure; the test just pins it).

- [ ] **C1.2: Export `applyContextHintCompaction` via `__testing__`**

In `index.mjs`, find the `AnthropicAuthPlugin.__testing__` block (grep for `__testing__`). Add `applyContextHintCompaction` to the export list with a one-line comment: `// exposed for determinism regression tests (phase C1)`.

- [ ] **C1.3: If tests fail — add determinism guards**

If any of C1.1's assertions fail (they shouldn't based on code inspection, but verify), the fix is targeted:

- If timestamps leak: remove them from the placeholder string (the default `"[Old tool result content cleared]"` has none — check custom `opts.clearedPlaceholder` paths).
- If Set iteration order matters: replace `new Set(...)` + `has()` with sorted `Array.prototype.includes` or keep the Set but enforce ordered key generation.
- If `msg.content.map` drops object property order: the assertion is written to tolerate this — the fix is to canonicalize before comparison, not in the function.

- [ ] **C1.4: Verify**

```bash
cd D:/git/opencode-anthropic-fix
npx vitest run test/conformance/context-hint-determinism.test.mjs
npx vitest run
```

All 1027+ tests pass.

- [ ] **C1.5: Commit on branch `phase-c-c1-context-hint-determinism`**

```bash
cd D:/git/opencode-anthropic-fix
git checkout -b phase-c-c1-context-hint-determinism
git add index.mjs test/conformance/context-hint-determinism.test.mjs
git commit -m "test(context-hint): determinism regression harness

Pins applyContextHintCompaction as a pure, byte-stable function. Any future
edit that leaks timestamps, random IDs, or Set iteration order into the
output will fail these tests. Prerequisite for C2 (flipping context_hint
default to true) — we must prove determinism before enabling the feature
by default.

Phase C work tracked in docs/plans/2026-04-18-phase-c-cc-parity.md."
```

---

## Task 2 (C2): Flip `token_economy.context_hint` default to `true`

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\lib\config.mjs:202` — flip default and update JSDoc.
- Modify: `D:\git\opencode-anthropic-fix\index.mjs` — ensure gating still respects explicit user opt-out.
- Tests: `D:\git\opencode-anthropic-fix\test\conformance\context-hint-gating.test.mjs` (new).

**Why this matters:** Real CC sends `context-hint-2026-04-09` for first-party providers on main-thread requests by default. With C1 proving the retry path is deterministic, we can safely enable by default — gaining CC-level efficiency while keeping the existing disable-on-error latching (`contextHintState.disabled`) for servers that 400 the beta. Users who've explicitly set `context_hint: false` in config stay opted out.

### Implementation

- [ ] **C2.1: Write the failing test FIRST**

Create `test/conformance/context-hint-gating.test.mjs`. Tests:

1. With default config (no explicit `context_hint`), `context_hint` resolves to `true` after config normalization.
2. With explicit `context_hint: false`, it stays `false` (opt-out respected).
3. With a claude-3 model (e.g., `claude-3-5-sonnet-20241022`), the beta is **not** sent even when default-on.
4. With a non-first-party provider (e.g., `requestyai`), the beta is **not** sent.
5. For subagent role (non-main-thread), the beta is **not** sent.
6. For main-thread on first-party provider + claude-4.x/opus-4.7 model, the beta **is** sent on first latched request, then suppressed on subsequent requests (latching).

Use the same test patterns as existing `test/conformance/regression.test.mjs` (mock fetch, read captured headers/body).

Run: `cd D:/git/opencode-anthropic-fix && npx vitest run test/conformance/context-hint-gating.test.mjs` — expect fail.

- [ ] **C2.2: Flip the default**

In `lib/config.mjs:202`, change:

```js
context_hint: false,
```

to:

```js
context_hint: true,
```

Update the JSDoc comment above (lines 196-201) to reflect the new default:

- Remove the "Off by default" language.
- Add: "Default ON; server-side gating + `contextHintState.disabled` latching means compatible servers use it and incompatible ones fall back cleanly."
- Keep the "main-thread only" note — that gate stays in index.mjs.

- [ ] **C2.3: Verify no other code path assumes false default**

```bash
cd D:/git/opencode-anthropic-fix
grep -n "context_hint" index.mjs lib/config.mjs | grep -v "context-hint-2026"
```

Check each callsite: does any code path do `if (te.context_hint)` without handling `undefined`? With the default flip, `undefined` now means "on", so callers checking `te.context_hint === true` are fine. Callers checking `te.context_hint` truthy are also fine. Callers checking `te.context_hint !== false` were already handling both cases — still fine.

The existing gate at `index.mjs:7074` is:

```js
if (isFirstPartyProvider && !/claude-3-/i.test(model) && te.context_hint !== false && _isMainThread) {
```

This is correct — `!== false` means "on unless explicitly off", matches the new default.

- [ ] **C2.4: Verify**

```bash
cd D:/git/opencode-anthropic-fix
npx vitest run test/conformance/context-hint-gating.test.mjs
npx vitest run
```

- [ ] **C2.5: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git checkout -b phase-c-c2-context-hint-default-on
git add lib/config.mjs test/conformance/context-hint-gating.test.mjs
git commit -m "feat(context-hint): flip default to on for first-party main-thread

With C1 proving applyContextHintCompaction is byte-deterministic, it's
safe to enable the context-hint-2026-04-09 beta by default. Gating
(first-party providers, non-claude-3 models, main-thread only) is
unchanged; explicit opt-out via token_economy.context_hint=false is
respected; error-latching on 400/409/529 still disables for the session.

Phase C work tracked in docs/plans/2026-04-18-phase-c-cc-parity.md."
```

---

## Task 3 (C3): Session-wide tool-result dedupe (opt-in)

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\index.mjs` — new helper `applySessionToolResultDedupe(messages)` + wire into request pipeline.
- Modify: `D:\git\opencode-anthropic-fix\lib\config.mjs` — add `token_economy_strategies.tool_result_dedupe_session_wide` (default `false`).
- Test: `D:\git\opencode-anthropic-fix\test\conformance\session-dedupe.test.mjs`.

**Why this matters:** Over a long session, the same `Read(X)` tool may run 5–10 times (user exploration, re-reads after edits). Earlier copies are redundant — the latest result subsumes them. Deduping at session scope (keep only latest per unique tool+args combo) can save 10–20% on long debugging sessions. Pure history-driven decision → deterministic. Default OFF because it's a history-mutating optimization and `token_economy.conservative` is ON by default (see existing JSDoc on `conservative` mode); users flip conservative off or opt in explicitly.

### Implementation

- [ ] **C3.1: Write the failing test FIRST**

Create `test/conformance/session-dedupe.test.mjs`. Tests:

1. **Basic dedupe**: messages contain 3 `tool_use` + `tool_result` pairs for `Read({path:"/a"})`. After `applySessionToolResultDedupe(messages)`, the first 2 results become `[Read of /a superseded by later read at msg M<n>]` stubs; the latest is verbatim. `tool_use_id` linkage preserved (the stub keeps the same `tool_use_id` so the API doesn't reject the message).
2. **Different args = not deduped**: `Read({path:"/a"})` + `Read({path:"/b"})` → both verbatim.
3. **Different tool = not deduped**: `Read({path:"/a"})` + `Grep({pattern:"foo"})` → both verbatim.
4. **Determinism**: two runs over the same input produce byte-identical output.
5. **Pure decision function**: the function doesn't read from any outside state; all decisions are derivable from `messages` alone.
6. **No-op when disabled**: with `config.token_economy_strategies.tool_result_dedupe_session_wide === false`, calling the dispatch wrapper returns messages unchanged.
7. **Only `read`, `grep`, `glob`, `ls`, `list`, `find` are deduped** (reproducible tools — same classifier as B1). Bash/Edit/Write results never deduped because later calls may have different side-effects.

Run: `cd D:/git/opencode-anthropic-fix && npx vitest run test/conformance/session-dedupe.test.mjs` — expect fail.

- [ ] **C3.2: Add config flag**

In `lib/config.mjs`, add to `token_economy_strategies`:

```js
/** Replace old reproducible-tool results (Read/Grep/Glob/LS) with stubs
 *  when a later call with identical args produces a fresh result. Saves
 *  10-20% on long sessions. Pure over message history → cache-stable.
 *  Off by default (conservative mode territory). */
tool_result_dedupe_session_wide: false,
```

Add the clone entry and normalizer entry alongside the other `token_economy_strategies` fields.

- [ ] **C3.3: Implement `applySessionToolResultDedupe`**

In `index.mjs`, adjacent to `applyContextHintCompaction` (~line 5461), add:

```js
const REPRODUCIBLE_TOOL_NAMES = new Set(["read", "grep", "glob", "ls", "list", "find"]);

/**
 * Session-wide tool-result dedupe. For each sequence of identical (tool_name, args)
 * tool_use calls, replaces older tool_result content with a stub pointing at the
 * latest one. Only applies to reproducible tools (Read/Grep/Glob/LS) — stateful
 * tools (Bash/Edit/Write) always keep verbatim results.
 *
 * Decision is pure over `messages`: deterministic, cache-stable.
 *
 * @param {Array} messages
 * @returns {{ messages: Array, changed: boolean, stats: { deduped: number } }}
 */
function applySessionToolResultDedupe(messages) {
  // 1. Walk forward. Build toolUseById: Map<tool_use_id, {name, argsKey, msgIdx, blockIdx}>.
  // 2. Group by (name, argsKey). Sort each group by message index. Mark all but last as "superseded".
  // 3. Rewrite: walk user messages, replace tool_result.content for superseded ids with
  //    `[<Tool> of <args> superseded by later <same tool> at msg #<latest_msg_idx>]`.
  // 4. Preserve tool_use_id; do not reorder messages.
  // Implementation details: argsKey = JSON.stringify with sorted keys (pure stableStringify
  // borrowed from lib/rolling-summarizer.mjs or inlined — match that pattern for determinism).
  // Exact impl left to implementer — follow the same style as applyContextHintCompaction.
  // Must NOT use Date.now() or Math.random() anywhere.
}
```

Full body is left for the implementer; follow the established style and reference `applyContextHintCompaction`. A `stableStringify` utility should already exist (rolling-summarizer has one) — extract to a shared helper if it saves ≥20 LOC, otherwise inline.

- [ ] **C3.4: Wire into the request pipeline**

Grep for where `applyProactiveMicrocompact` or `applyContextHintCompaction` is called in the outbound path (`index.mjs:5528` shows one callsite pattern). Add a conditional call to `applySessionToolResultDedupe` gated by `config.token_economy_strategies?.tool_result_dedupe_session_wide === true`. Placement: **before** `applyProactiveMicrocompact` — dedupe first, then microcompact on what remains.

- [ ] **C3.5: Verify**

```bash
cd D:/git/opencode-anthropic-fix
npx vitest run test/conformance/session-dedupe.test.mjs
npx vitest run
```

- [ ] **C3.6: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git checkout -b phase-c-c3-session-dedupe
git add index.mjs lib/config.mjs test/conformance/session-dedupe.test.mjs
git commit -m "feat(dedupe): session-wide reproducible-tool result dedupe (opt-in)

applySessionToolResultDedupe replaces older Read/Grep/Glob/LS results with
stubs pointing at the latest identical-args call. Pure over message history
so it's deterministic and cache-stable. Default off — flip via
token_economy_strategies.tool_result_dedupe_session_wide.

Phase C work tracked in docs/plans/2026-04-18-phase-c-cc-parity.md."
```

---

## Cross-task dependencies

C1 → C2 (determinism proof gates the default flip).
C1 → C3 (same determinism invariants apply to the new dedupe function; reuse `stableStringify`).

Merge order: C1 → C2 → C3.

---

## Self-review

- **Spec coverage**: roadmap's 3 items each have a task with tests + commit.
- **Placeholders**: C3.3 leaves the function body as pseudocode — acceptable because the pattern is established (`applyContextHintCompaction` is the template), the helper to reuse exists (`stableStringify` from rolling-summarizer), and the test fixtures in C3.1 fully pin the behavior. An implementer writing the body from the test fixtures alone has everything they need.
- **Type consistency**: `token_economy.context_hint` and `token_economy_strategies.tool_result_dedupe_session_wide` are the exact keys used across tasks.
- **Determinism**: every new function in this phase is a pure function over `messages`. No Date.now, Math.random, performance.now.
- **Gap accepted**: C3's "only reproducible tools" classifier overlaps with B1's `REPRODUCIBLE_TOOLS` Set in `compaction.ts` (opencode fork). These are separate repos — duplication is fine; if we ever add a new reproducible tool we update both. Future cross-repo shared config is out of scope.
