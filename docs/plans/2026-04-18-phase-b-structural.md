# Phase B — Structural Token-Economy Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` for tracking.

**Goal:** After Phase A stabilizes cache-break sources, tackle the next tier — (B1) more selective tool-output pruning, (B2) session-stable env snapshot (avoid cache invalidation on date rollover / per-request env drift), and (B3) a deterministic rolling summarizer wired through the plugin hook.

**Architecture:** B1 and B2 are opencode-fork edits (TypeScript, Bun, Effect layers). B3 is a new plugin-side module that hooks into opencode's `experimental.session.compacting` trigger and produces a deterministic Haiku summary. Determinism (byte-identical output for identical input) is the load-bearing property — any summarizer that introduces per-run jitter re-breaks the cache on every compaction.

**Tech Stack:** TypeScript (opencode fork), JavaScript ESM (plugin), Haiku 4.5 (summarizer), Bun test runner, Vitest (plugin).

**Exit criteria:**

- B1: `prune()` short-tool outputs (≤10k tokens, coming from reproducible tools Read/Grep/Glob/LS) become eligible for erasure even when session has not crossed the 40k-tool-output PRUNE_PROTECT threshold.
- B2: `sys.environment(model)` called once per session. Re-invocation only on explicit config change or `/refresh`. Mid-session date rollover does NOT mutate the env block.
- B3: On `experimental.session.compacting` firing, the plugin emits a Haiku-generated summary with `temp: 0`, fixed template, no timestamps. Two runs over the same prefix produce byte-identical output. Wire verified by integration test.

**Repos in scope:**

- `D:\git\opencode` — `packages/opencode/src/session/compaction.ts` (B1), `packages/opencode/src/session/system.ts` (B2), `packages/opencode/src/session/prompt.ts:1490` (B2 callsite).
- `D:\git\opencode-anthropic-fix` — new `lib/rolling-summarizer.mjs` (B3), plugin trigger registration.

---

## Task 1 (B1): Per-tool-class prune thresholds

**Files:**

- Modify: `D:\git\opencode\packages\opencode\src\session\compaction.ts:31-123` (constants + `prune` loop).
- Create test: `D:\git\opencode\packages\opencode\test\session\prune-per-tool.test.ts`.

**Why this matters:** Today's `prune` pipeline has two constants: `PRUNE_MINIMUM = 20_000` (only prune if at least this much would be freed) and `PRUNE_PROTECT = 40_000` (protect the most recent 40k tokens of tool output from pruning). For sessions that spam Grep/Read/Glob, the 40k protection window is too generous — those outputs are trivially reproducible (re-run the search), so freeing them earlier is pure upside. Bash/Edit/Write outputs, by contrast, may represent non-idempotent state (executed commands, diffs that were applied) and should keep the 40k floor.

### Implementation

- [ ] **B1.1: Write the failing test**

Create `D:\git\opencode\packages\opencode\test\session\prune-per-tool.test.ts`. Import patterns and style should match `compaction.test.ts` in the same directory (use `testEffect`, `Instance`, `Session`, `Plugin`, etc.).

Assertion shape: build a session whose recent tool output stack is:

1. 3 Read tool outputs of ~8k each (24k total — under PRUNE_PROTECT if it were 40k, over new per-class threshold of 10k).
2. 1 Bash tool output of ~30k (single large; under 40k alone).
3. Total: 54k. Classic prune (40k protect) would spare the last ~40k, pruning only ~14k.

Call `SessionCompaction.prune` and verify:

- The 3 Read outputs are marked `time.compacted` (pruned).
- The Bash output is spared.

Run: `bun test test/session/prune-per-tool.test.ts` — expect fail.

- [ ] **B1.2: Introduce per-class constants + classifier**

In `compaction.ts`, replace:

```ts
export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];
```

With:

```ts
export const PRUNE_MINIMUM = 20_000;
/** Protect the most recent N tokens from REPRODUCIBLE tool outputs (re-runnable
 *  searches/reads). Higher threshold = more aggressive pruning. */
export const PRUNE_PROTECT_REPRODUCIBLE = 10_000;
/** Protect the most recent N tokens from STATEFUL tool outputs (executed
 *  commands, applied edits, written files). Lower threshold = keep more. */
export const PRUNE_PROTECT_STATEFUL = 40_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];

/** Tool outputs that are trivially re-runnable (idempotent + cheap). */
const REPRODUCIBLE_TOOLS = new Set(["read", "grep", "glob", "ls", "list", "find"]);

function pruneProtectFor(toolName: string): number {
  const normalized = toolName.toLowerCase();
  return REPRODUCIBLE_TOOLS.has(normalized) ? PRUNE_PROTECT_REPRODUCIBLE : PRUNE_PROTECT_STATEFUL;
}
```

- [ ] **B1.3: Update the prune loop**

In the `prune` function, track `total` per tool-class instead of a single global counter. Replace the `if (total > PRUNE_PROTECT)` branch with a per-tool-class check.

Approach: maintain `totalByClass: { reproducible: number; stateful: number }` keyed by the result of `pruneProtectFor(part.tool)`. For each tool output encountered (walking backward):

- Add `estimate` to the right bucket.
- If the bucket total exceeds its per-class protect threshold, the current part is prunable.

Keep the overall `pruned` accumulator (used for the `PRUNE_MINIMUM` gate).

- [ ] **B1.4: Verify tests pass**

Run: `bun test test/session/prune-per-tool.test.ts` — expect pass.
Run: `bun test test/session/compaction.test.ts` — existing tests must remain green. Update any test that relied on `PRUNE_PROTECT` being a single constant to reference the new pair with appropriate intent (don't weaken).

- [ ] **B1.5: Run full session test suite**

Run: `bun test test/session/` — expect all tests pass except the pre-existing `snapshot-tool-race.test.ts` flake noted in Phase A.

- [ ] **B1.6: Commit on branch `phase-b-b1-per-tool-prune`**

```bash
cd D:/git/opencode
git checkout -b phase-b-b1-per-tool-prune
git add packages/opencode/src/session/compaction.ts packages/opencode/test/session/prune-per-tool.test.ts
git commit -m "feat(session): per-tool-class prune thresholds

Reproducible tools (read/grep/glob/ls) now prune at 10k instead of 40k,
since their outputs can be re-run on demand. Stateful tools (bash/edit/
write) keep the 40k floor.

Phase B work tracked in opencode-anthropic-fix/docs/plans/
2026-04-18-phase-b-structural.md."
```

---

## Task 2 (B2): Session-stable env snapshot

**Files:**

- Modify: `D:\git\opencode\packages\opencode\src\session\system.ts` — turn `environment()` into a memoized-per-session function, with an invalidation hook.
- Modify: `D:\git\opencode\packages\opencode\src\session\prompt.ts:1490` — ensure each session uses a cached env block instead of re-computing per request.
- Create test: `D:\git\opencode\packages\opencode\test\session\env-snapshot.test.ts`.

**Why this matters:** `sys.environment(model)` runs every outbound request and embeds `Today's date: ${new Date().toDateString()}`. Within a day this is stable, but a session that spans midnight rewrites the env block → one cache invalidation (on an already-hot prefix) = the expensive part of the prefix gets re-billed. When future fields land (git branch, open files), the stability requirement becomes critical.

### Implementation

- [ ] **B2.1: Write the failing test**

`test/session/env-snapshot.test.ts` exercises two properties:

1. **Within a session, `environment()` returns the same array reference on repeat calls.**
2. **If a test mocks `Date.now()` / `new Date()` to shift across midnight mid-session, the returned env block's `"Today's date:"` line does NOT change.**

Use Bun's `mock` facility. Shape the Service layer via `testEffect` so `Instance.project` / `Instance.directory` are fixture-provided.

Run: `bun test test/session/env-snapshot.test.ts` — expect fail.

- [ ] **B2.2: Introduce a per-session memo**

In `system.ts`, change the `environment` method from a pure function to one that checks an internal cache keyed by session identity. Two viable shapes:

- **Shape A (Effect context):** thread a `SessionID` argument through; memoize into a `Map<SessionID, string[]>` held on the Service closure.
- **Shape B (signal-based):** expose a `environmentForSession(sessionID, model)` method; internal `Map<SessionID, { computedAt: number; env: string[] }>`. Add an `invalidate(sessionID)` method.

Pick Shape B — it matches the "invalidate on /refresh" requirement cleanly.

New `environmentForSession` in `system.ts`:

```ts
environmentForSession(sessionID: SessionID, model: Provider.Model): string[] {
  const cached = envCache.get(sessionID)
  if (cached) return cached.env
  const env = buildEnvArray(model)  // extract existing string builder
  envCache.set(sessionID, { computedAt: Date.now(), env })
  return env
},
invalidateSessionEnv(sessionID: SessionID): void {
  envCache.delete(sessionID)
},
```

Keep legacy `environment(model)` for backward compat (delegates to `environmentForSession` using a special NO_SESSION key, or just keep the inline impl for subagents who don't cache).

- [ ] **B2.3: Wire callsite in `prompt.ts:1490`**

Replace `sys.environment(model)` with `sys.environmentForSession(sessionID, model)`. Confirm `sessionID` is in scope at that call site (it should be — this is inside the session request pipeline).

- [ ] **B2.4: Hook `/refresh`**

Grep for `/refresh` command handlers. Wire `sys.invalidateSessionEnv(sessionID)` into the existing refresh pathway so a user forcing a refresh gets a fresh env snapshot (covers cases like "I moved to a new git branch mid-session").

- [ ] **B2.5: Verify tests pass + full suite**

```
bun test test/session/env-snapshot.test.ts
bun test test/session/
```

- [ ] **B2.6: Commit on branch `phase-b-b2-env-snapshot`**

```bash
cd D:/git/opencode
git checkout -b phase-b-b2-env-snapshot
git add packages/opencode/src/session/system.ts packages/opencode/src/session/prompt.ts packages/opencode/test/session/env-snapshot.test.ts
# include any /refresh callsite file touched in B2.4
git commit -m "feat(session): cache env snapshot per session, invalidate on /refresh"
```

---

## Task 3 (B3): Deterministic rolling summarizer (plugin)

**Files:**

- Create: `D:\git\opencode-anthropic-fix\lib\rolling-summarizer.mjs`.
- Modify: `D:\git\opencode-anthropic-fix\index.mjs` — register the plugin hook for `experimental.session.compacting` if not already wired.
- Test: `D:\git\opencode-anthropic-fix\test\rolling-summarizer.test.mjs`.

**Why this matters:** Opencode's built-in compaction uses the session's own model + a SessionSummary agent. This works but has two issues: (a) a full Opus-4-7 pass is expensive, (b) it's non-deterministic — summaries drift across runs and the resulting cache is re-broken each compaction. We want a Haiku-based summarizer with `temperature: 0`, fixed template, no timestamps, no non-determinism sources — so two runs over the same messages produce byte-identical output. That way the post-compaction prefix hashes to the same value as the last time we compacted at this boundary, preserving whatever cache still lives server-side.

### Implementation

- [ ] **B3.1: Write the failing test**

`test/rolling-summarizer.test.mjs` uses Vitest. Tests:

1. `summarize(messages)` returns a string matching a canonical template.
2. **Determinism**: calling `summarize(messages)` twice with the same input produces byte-identical output (i.e., no timestamps, no `Math.random`, no iteration-order drift in Object.keys).
3. **Length bound**: summary is shorter than the concatenated input, respecting a configured `maxChars` (default 2000).

Mock the Haiku call so tests are fully offline — exercise only the formatting + determinism property, not the actual Haiku response. Record the exact prompt shape that would be sent to Haiku; assert it.

Run: `npx vitest run test/rolling-summarizer.test.mjs` — expect fail.

- [ ] **B3.2: Implement `rolling-summarizer.mjs`**

```js
// lib/rolling-summarizer.mjs
const MODEL = "claude-haiku-4-5-20251001";
const TEMPERATURE = 0;
const DEFAULT_MAX_CHARS = 2000;

// Deterministic template — no timestamps, no per-run nonces.
const TEMPLATE = [
  "<session-summary>",
  "Previous conversation summarized for context efficiency.",
  "",
  "Key topics covered:",
  "{topics}",
  "",
  "Outstanding state:",
  "{outstanding}",
  "",
  "Files touched:",
  "{files}",
  "</session-summary>",
].join("\n");

export async function summarize(messages, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const haikuCall = opts.haikuCall ?? defaultHaikuCall;

  const prompt = buildPrompt(messages, maxChars);
  const raw = await haikuCall({ model: MODEL, temperature: TEMPERATURE, prompt });

  const parsed = parseHaikuResponse(raw); // pure — extracts topics/outstanding/files
  return formatTemplate(parsed, maxChars);
}

// buildPrompt, parseHaikuResponse, formatTemplate — all pure, deterministic.
// No Date.now(). No Math.random(). Object.keys with explicit sort.
```

Determinism checklist (enforce in tests):

- No `Date.now()`, `new Date()`, `Math.random()` anywhere in the formatter.
- Any object iteration uses `.sort()` on keys before `.map()`.
- String concatenation uses fixed separators.

- [ ] **B3.3: Register the plugin hook**

In `index.mjs`, find where opencode's `experimental.session.compacting` trigger is consumed (grep for `experimental.session.compacting` or `session.compacting`). If no wiring exists, add a new hook registration that invokes `summarize()` and returns the result where opencode expects it.

If the hook surface isn't a straightforward function — if it's event-emitter shaped — then this task becomes "subscribe + write a new system message with the summary." Follow whatever shape opencode's plugin API currently requires.

- [ ] **B3.4: Verify tests pass + full vitest suite**

```
npx vitest run test/rolling-summarizer.test.mjs
npx vitest run
```

All 1008+ tests should still pass.

- [ ] **B3.5: Commit on branch `phase-b-b3-rolling-summarizer` (plugin)**

```bash
cd D:/git/opencode-anthropic-fix
git checkout -b phase-b-b3-rolling-summarizer
git add lib/rolling-summarizer.mjs index.mjs test/rolling-summarizer.test.mjs
git commit -m "feat(summarizer): deterministic Haiku rolling summary for compaction

Adds a plugin-side summarizer that runs via the session.compacting hook.
Uses temperature=0, fixed template, no timestamps — so two runs over the
same input produce byte-identical output. Preserves server-side cache
across compaction boundaries."
```

---

## Cross-task dependencies

B1 and B2 are independent (different files, no shared state). B3 depends on A3's `compaction.threshold` being available (Phase A task 4 / commit `43c1a3269`) — without it, the summarizer would only fire AT overflow, not proactively.

Merge order: B1 → B2 → B3.

---

## Self-review

- **Spec coverage**: roadmap's 3 items each have a task with tests + commit.
- **Placeholders**: none — each task lists exact files, full code blocks for new constants/functions, exact commit messages. B3's `buildPrompt`/`parseHaikuResponse`/`formatTemplate` are one-step-removed from full code because the opencode plugin hook surface is something the implementer needs to inspect at execution time; the determinism requirement compensates by being testable independently.
- **Type consistency**: `PRUNE_PROTECT_REPRODUCIBLE` and `PRUNE_PROTECT_STATEFUL` used consistently across task text; B2's `environmentForSession` / `invalidateSessionEnv` names used consistently.
- **Gap accepted**: B3's full hook-wiring code isn't spelled out because opencode's plugin hook API shape requires code inspection. Implementer should report back if the hook shape differs from the simple "return a string" assumption.
