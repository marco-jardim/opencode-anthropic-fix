# Phase A — Surgical Token-Economy Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate three confirmed, high-ROI causes of cache churn in long opencode sessions — (1) `thinking: undefined` for `claude-opus-4-7`, (2) `systemPromptTailing` breaking cache over ~1MB of history at turn 6, (3) overflow-only (100%) auto-compact trigger — to cut per-turn input cost 30–40% on 20+ turn sessions.

**Architecture:** Two repos. Plugin-side fixes (A1, A2) are one-line regex + default-flip edits in `D:\git\opencode-anthropic-fix\index.mjs` and `lib/config.mjs`, guarded by new regression tests. Fork-side fix (A3) adds a `compaction.threshold` config knob to `D:\git\opencode\packages\opencode` and uses it in `overflow.ts`.

**Tech Stack:** Node.js (ESM), Vitest, Zod (opencode config), TypeScript (opencode), Bun (opencode runtime & tests).

**Baseline (measured 2026-04-18):** 1100 messages, ~1MB per request, ~262k tokens, `thinking: undefined` on every opus-4-7 turn, single cache break at turn 6 re-billing ~48KB system + ~215k history.

**Exit criteria:**

- All plugin + fork tests pass (`bun test` both repos).
- Fresh 20-turn session with 5 tool calls per turn shows `cache_read ≥ 3 × cache_creation` after turn 3 (measured via `cache_break_detection` toasts absent + usage field inspection).
- `thinking: {type: "adaptive"}` is present in every `claude-opus-4-7` request body (verify with `token_economy.debug_dump_bodies: true`).
- No cache break toasts on the happy path for 20+ turns.

**Repos in scope:**

- `D:\git\opencode-anthropic-fix` — plugin (Node.js)
- `D:\git\opencode` — opencode fork (TypeScript/Bun)

---

## File Structure

### Plugin repo (`D:\git\opencode-anthropic-fix`)

| File                                   | Role                       | Change                                                                                                                                                                |
| -------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.mjs`                            | Request transform pipeline | A1: add opus-4-7 to `isOpus46Model` (or new detector) so `isAdaptiveThinkingModel` recognizes it. A2: flip `systemPromptTailing` from opt-out to opt-in at line 7590. |
| `lib/config.mjs`                       | Config schema/defaults     | A2: add `token_economy_strategies` normalization with `system_prompt_tailing: false` default so `saveConfig` persists user overrides cleanly.                         |
| `test/conformance/regression.test.mjs` | E2E tests                  | A1: new test `Opus 4.7 gets adaptive thinking`. A2: new test `systemPromptTailing is OFF by default`.                                                                 |
| `CHANGELOG.md`                         | Release notes              | Bump to v0.1.16 entry.                                                                                                                                                |
| `package.json`                         | Plugin version             | Bump to v0.1.16.                                                                                                                                                      |

### Opencode fork (`D:\git\opencode`)

| File                                                     | Role                    | Change                                                   |
| -------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| `packages/opencode/src/config/config.ts`                 | Config Zod schema       | A3: add `compaction.threshold` field (number, 0.5–0.99). |
| `packages/opencode/src/session/overflow.ts`              | Auto-compact trigger    | A3: multiply `usable` by `threshold` (default 0.85).     |
| `packages/opencode/src/session/overflow.test.ts` _(new)_ | Unit test for threshold | A3: verify triggers at 85% not 100%.                     |

---

## Task 1 (A1): Recognize `claude-opus-4-7` as adaptive-thinking model

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\index.mjs:6133-6159`
- Test: `D:\git\opencode-anthropic-fix\test\conformance\regression.test.mjs` (append to existing `describe("E2E: Thinking normalization")` block at line 1183)

**Why this matters:** Request dumps of the user's 1100-message session show `thinking: undefined` on every outbound request because `isAdaptiveThinkingModel(model)` returns `false` for `claude-opus-4-7`. This omits the `thinking: {type: "adaptive"}` field that real CC v2.1.114 sends, which (a) costs billing-header signature match and (b) means the `effort-2025-11-24` beta path is never taken for this model.

- [ ] **Step 1.1: Write the failing test for Opus 4.7 adaptive thinking**

Append immediately after the existing `Sonnet 4.6` test at `test/conformance/regression.test.mjs:1208`, inside the `describe("E2E: Thinking normalization")` block:

```js
it("Opus 4.7 gets adaptive thinking", async () => {
  const { body } = await sendRequest(fetchFn, {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  });

  expect(body.thinking).toEqual({ type: "adaptive" });
});

it("Opus 4.7 dotted variant gets adaptive thinking", async () => {
  const { body } = await sendRequest(fetchFn, {
    model: "claude-opus-4.7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  });

  expect(body.thinking).toEqual({ type: "adaptive" });
});
```

- [ ] **Step 1.2: Run the new tests to verify they FAIL**

Run: `bun test test/conformance/regression.test.mjs -t "Opus 4.7"`
Expected: 2 tests fail with `expected undefined to deeply equal { type: 'adaptive' }`.

- [ ] **Step 1.3: Add `isOpus47Model` detector and extend `isAdaptiveThinkingModel`**

In `D:\git\opencode-anthropic-fix\index.mjs`, locate the block at line 6133-6159. Insert a new detector function between `isOpus46Model` (line 6139) and `isSonnet46Model` (line 6146), and update `isAdaptiveThinkingModel` (line 6157) to include it:

Replace:

```js
function isOpus46Model(model) {
  if (!model) return false;
  // Match standard IDs (claude-opus-4-6, claude-opus-4.6) and Bedrock ARNs
  // (arn:aws:bedrock:...anthropic.claude-opus-4-6-...).
  // Also match bare "opus-4-6" / "opus-4.6" fragments for non-standard strings.
  return /claude-opus-4[._-]6|opus[._-]4[._-]6/i.test(model);
}

/**
 * Detects claude-sonnet-4.6 / claude-sonnet-4-6 model IDs.
 * @param {string | undefined} body
 * @returns {boolean}
 */
function isSonnet46Model(model) {
  if (!model) return false;
  return /claude-sonnet-4[._-]6|sonnet[._-]4[._-]6/i.test(model);
}

/**
 * Detects models that support adaptive thinking ({type: "adaptive"}).
 * Currently: Opus 4.6 and Sonnet 4.6.
 * @param {string | undefined} body
 * @returns {boolean}
 */
function isAdaptiveThinkingModel(model) {
  return isOpus46Model(model) || isSonnet46Model(model);
}
```

With:

```js
function isOpus46Model(model) {
  if (!model) return false;
  // Match standard IDs (claude-opus-4-6, claude-opus-4.6) and Bedrock ARNs
  // (arn:aws:bedrock:...anthropic.claude-opus-4-6-...).
  // Also match bare "opus-4-6" / "opus-4.6" fragments for non-standard strings.
  return /claude-opus-4[._-]6|opus[._-]4[._-]6/i.test(model);
}

/**
 * Detects claude-opus-4.7 / claude-opus-4-7 model IDs.
 * @param {string | undefined} model
 * @returns {boolean}
 */
function isOpus47Model(model) {
  if (!model) return false;
  return /claude-opus-4[._-]7|opus[._-]4[._-]7/i.test(model);
}

/**
 * Detects claude-sonnet-4.6 / claude-sonnet-4-6 model IDs.
 * @param {string | undefined} body
 * @returns {boolean}
 */
function isSonnet46Model(model) {
  if (!model) return false;
  return /claude-sonnet-4[._-]6|sonnet[._-]4[._-]6/i.test(model);
}

/**
 * Detects models that support adaptive thinking ({type: "adaptive"}).
 * Currently: Opus 4.6, Opus 4.7, and Sonnet 4.6.
 * @param {string | undefined} body
 * @returns {boolean}
 */
function isAdaptiveThinkingModel(model) {
  return isOpus46Model(model) || isOpus47Model(model) || isSonnet46Model(model);
}
```

- [ ] **Step 1.4: Run the new tests to verify they PASS**

Run: `bun test test/conformance/regression.test.mjs -t "Opus 4.7"`
Expected: both tests pass.

- [ ] **Step 1.5: Run the full regression suite to confirm no side effects**

Run: `bun test test/conformance/regression.test.mjs`
Expected: all tests pass, including the pre-existing `Opus 4.6 gets adaptive thinking`, `Sonnet 4.6 gets adaptive thinking`, and `older model keeps original thinking config`.

- [ ] **Step 1.6: Grep for other consumers of `isOpus46Model` that might also need `isOpus47Model`**

Run: `rg "isOpus46Model|isSonnet46Model" index.mjs -n`
Read each callsite. If any callsite gates behavior that also applies to 4.7 (e.g., adaptive-effort beta selection, 1M-context eligibility, MCP-tool list), extend with `|| isOpus47Model(model)`. If a callsite is specifically 4.6-only (e.g., a dated workaround), leave alone and add a one-line comment explaining why 4.7 is intentionally excluded.

Expected decision: most callsites (effort push, thinking normalization) should include 4.7; at least verify that `isEligibleFor1MContext` (line 6168) still matches 4.7 via its own regex or is updated.

- [ ] **Step 1.7: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add index.mjs test/conformance/regression.test.mjs
git commit -m "fix(A1): recognize claude-opus-4-7 as adaptive-thinking model"
```

---

## Task 2 (A2): Disable `systemPromptTailing` by default (opt-in)

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\index.mjs:7590`
- Modify: `D:\git\opencode-anthropic-fix\lib\config.mjs` (add `token_economy_strategies` normalization)
- Test: `D:\git\opencode-anthropic-fix\test\conformance\regression.test.mjs` (new `describe` block)

**Why this matters:** Dumps show the plugin's system prompt is ~48KB. At turn 6, `systemPromptTailing` shrinks it to ~1.8KB. Because the system prompt block is a cache source, this re-creates a ~48KB cache block (billed 1.25× input) and invalidates the ~215k-token message-history suffix that was cached behind the old system hash. Net: one cache break loses more than the tailing saves.

The flag sits in `config.token_economy_strategies.system_prompt_tailing`. Currently `undefined` reads as "enabled" in `index.mjs:7590` (`!== false`). Two-part fix:

(a) Add `token_economy_strategies` to `lib/config.mjs` so the schema has a documented default of `false`.
(b) Invert the sense in `index.mjs:7590` — require explicit `=== true` to activate.

- [ ] **Step 2.1: Write the failing test — default behavior**

Append a new `describe` block to `test/conformance/regression.test.mjs` after the thinking-normalization block (line 1218):

```js
describe("E2E: systemPromptTailing default", () => {
  let client, fetchFn;

  beforeEach(async () => {
    vi.resetAllMocks();
    client = makeClient();
    fetchFn = await setupFetchFn(client);
  });

  it("long system prompt is NOT tailed at turn 6 by default (A2)", async () => {
    // Build a >4KB system block to exceed the tailing threshold.
    const longText = "X".repeat(5000);

    // Simulate 6 turns before the test request.
    const plugin = await import("../../index.mjs");
    if (typeof plugin.__setSessionTurnsForTest === "function") {
      plugin.__setSessionTurnsForTest(6);
    }

    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: longText }],
    });

    // After A2 default flip: system block should retain its full length.
    const textBlock = body.system.find((b) => b.type === "text" && b.text.includes("X".repeat(100)));
    expect(textBlock).toBeDefined();
    expect(textBlock.text.length).toBeGreaterThanOrEqual(5000);
  });

  it("systemPromptTailing: true in config re-enables truncation", async () => {
    // Override the mocked config to opt in.
    loadConfig.mockReturnValueOnce({
      ...require("../../lib/config.mjs").DEFAULT_CONFIG,
      token_economy_strategies: {
        system_prompt_tailing: true,
        system_prompt_tail_turns: 6,
        system_prompt_tail_max_chars: 2000,
      },
      account_selection_strategy: "sticky",
    });

    const longText = "X".repeat(5000);
    const plugin = await import("../../index.mjs");
    if (typeof plugin.__setSessionTurnsForTest === "function") {
      plugin.__setSessionTurnsForTest(6);
    }

    const { body } = await sendRequest(fetchFn, {
      system: [{ type: "text", text: longText }],
    });

    const textBlock = body.system.find((b) => b.type === "text" && b.text.length >= 1000);
    // When opted in, the huge block was shortened.
    expect(textBlock.text.length).toBeLessThan(5000);
  });
});
```

**Note:** If `__setSessionTurnsForTest` does not exist, either add it as a test-only export in `index.mjs` next to the existing `sessionMetrics` usage, OR rewrite the test to call `sendRequest` in a loop 6 times (each turn increments `sessionMetrics.turns`). Pick the loop approach if adding a test hook is disruptive — it adds ~15 lines but touches no production surface.

- [ ] **Step 2.2: Run the test to verify it FAILS**

Run: `bun test test/conformance/regression.test.mjs -t "systemPromptTailing default"`
Expected: the first test fails because, with today's code, the 5000-char block gets tailed down to ~2000 chars at turn 6.

- [ ] **Step 2.3: Add `token_economy_strategies` default to `lib/config.mjs`**

In `D:\git\opencode-anthropic-fix\lib\config.mjs`, inside `DEFAULT_CONFIG`, add a new section right after the existing `token_economy` block (which ends around line 260 based on current layout — find the closing `}` of `token_economy: { ... }`). Insert:

```js
  /** Advanced strategies that may trade cache stability for verbosity reduction.
   *  Default OFF because most produce a net cache loss on long sessions. */
  token_economy_strategies: {
    /** System prompt tailing: after N turns, trim large system blocks.
     *  Default OFF — causes cache break over history cached under the
     *  pre-tail system hash. Opt in for short sessions with huge prompts. */
    system_prompt_tailing: false,
    /** Turn count at which tailing starts (if enabled). */
    system_prompt_tail_turns: 6,
    /** Max chars per system block after tailing. */
    system_prompt_tail_max_chars: 2000,
    /** Tool deferral (send sparse schemas until first use). Default OFF. */
    tool_deferral: false,
    /** Tool description compaction (strip example output). Default OFF. */
    tool_description_compaction: false,
    /** Adaptive tool set (main vs subagent roles). Default OFF. */
    adaptive_tool_set: false,
  },
```

Then, inside the cloning/reset section (search for `token_economy: { ...DEFAULT_CONFIG.token_economy }` at line ~378), add a sibling line:

```js
    token_economy_strategies: { ...DEFAULT_CONFIG.token_economy_strategies },
```

Then, inside the user-config normalization block (after the `token_economy` normalization ending at line 720), add:

```js
// Token-economy strategies sub-config (A2: default-off advanced knobs)
if (raw.token_economy_strategies && typeof raw.token_economy_strategies === "object") {
  const tes = /** @type {Record<string, unknown>} */ (raw.token_economy_strategies);
  config.token_economy_strategies = {
    system_prompt_tailing:
      typeof tes.system_prompt_tailing === "boolean"
        ? tes.system_prompt_tailing
        : DEFAULT_CONFIG.token_economy_strategies.system_prompt_tailing,
    system_prompt_tail_turns: clampNumber(
      tes.system_prompt_tail_turns,
      1,
      1000,
      DEFAULT_CONFIG.token_economy_strategies.system_prompt_tail_turns,
    ),
    system_prompt_tail_max_chars: clampNumber(
      tes.system_prompt_tail_max_chars,
      100,
      50_000,
      DEFAULT_CONFIG.token_economy_strategies.system_prompt_tail_max_chars,
    ),
    tool_deferral:
      typeof tes.tool_deferral === "boolean"
        ? tes.tool_deferral
        : DEFAULT_CONFIG.token_economy_strategies.tool_deferral,
    tool_description_compaction:
      typeof tes.tool_description_compaction === "boolean"
        ? tes.tool_description_compaction
        : DEFAULT_CONFIG.token_economy_strategies.tool_description_compaction,
    adaptive_tool_set:
      typeof tes.adaptive_tool_set === "boolean"
        ? tes.adaptive_tool_set
        : DEFAULT_CONFIG.token_economy_strategies.adaptive_tool_set,
  };
}
```

- [ ] **Step 2.4: Flip the default check in `index.mjs:7590`**

Replace:

```js
    if (signature.systemPromptTailing !== false && runtime.turns >= tailThreshold && Array.isArray(parsed.system)) {
```

With:

```js
    if (signature.systemPromptTailing === true && runtime.turns >= tailThreshold && Array.isArray(parsed.system)) {
```

- [ ] **Step 2.5: Run the test to verify it PASSES**

Run: `bun test test/conformance/regression.test.mjs -t "systemPromptTailing default"`
Expected: both tests pass.

- [ ] **Step 2.6: Run the full test suite to confirm no regressions**

Run: `bun test`
Expected: all tests pass. Pay attention to `test/phase3/task-3-6-token-economy.test.mjs` — if any test there assumed tailing-on-by-default, it should now either explicitly opt in (`systemPromptTailing: true` in its signature mock) or be tagged as asserting opt-in behavior. Do not weaken a test; add the explicit opt-in on the test side so it still asserts the tailing logic.

- [ ] **Step 2.7: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add index.mjs lib/config.mjs test/conformance/regression.test.mjs
git commit -m "fix(A2): default token_economy_strategies.system_prompt_tailing to false"
```

---

## Task 3 (A2 cont.): Add release notes and version bump for plugin

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\CHANGELOG.md`
- Modify: `D:\git\opencode-anthropic-fix\package.json`

- [ ] **Step 3.1: Append changelog entry**

Prepend a new section at the top of `CHANGELOG.md` (under the top-level heading, above the v0.1.15 entry):

```md
## v0.1.16 — Phase A surgical token-economy fixes

**Fixes:**

- **A1**: `claude-opus-4-7` now recognized as adaptive-thinking model; requests
  correctly include `thinking: {type: "adaptive"}`. Previously produced
  `thinking: undefined` on every turn.
- **A2**: `token_economy_strategies.system_prompt_tailing` default flipped from
  implicit-on to explicit opt-in (`false`). Tailing shrinks system prompts at
  turn 6; on sessions with ~1MB cumulative history, the resulting cache break
  costs more than the tailing saves. Opt in only for short sessions with huge
  prompts.

**Expected impact on long sessions:** 30–40% lower per-turn input tokens, no
more turn-6 cache break toast.

**Opt-in to pre-0.1.16 behavior:** set
`{"token_economy_strategies": {"system_prompt_tailing": true}}` in
`anthropic-auth.json`.
```

- [ ] **Step 3.2: Bump version**

Replace `"version": "0.1.15"` with `"version": "0.1.16"` in `package.json`.

- [ ] **Step 3.3: Verify build**

Run: `bun run build` (or the plugin's build script — check `package.json` scripts)
Expected: `dist/opencode-anthropic-auth-plugin.js` rebuilt successfully.

- [ ] **Step 3.4: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add CHANGELOG.md package.json dist/
git commit -m "chore: release v0.1.16 (Phase A surgical fixes)"
```

---

## Task 4 (A3): Add `compaction.threshold` to opencode fork

**Files:**

- Modify: `D:\git\opencode\packages\opencode\src\config\config.ts:202-213`
- Modify: `D:\git\opencode\packages\opencode\src\session\overflow.ts`
- Create: `D:\git\opencode\packages\opencode\src\session\overflow.test.ts`

**Why this matters:** `isOverflow` today only returns `true` when `count >= usable`, where `usable = model.limit.input - reserved`. This means auto-compaction triggers AT context overflow. Users observe the final request inflating to near-max-context before compaction kicks in. We want to trigger earlier — at ~85% of usable — so compaction reclaims slack before cost spikes. This is a pre-req for B3 (rolling summarizer) and mirrors CC's preemptive compaction behavior.

- [ ] **Step 4.1: Write the failing test**

Create `D:\git\opencode\packages\opencode\src\session\overflow.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { isOverflow } from "./overflow";

const model = {
  id: "test",
  limit: { context: 200_000, input: 200_000, output: 8_192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
} as any;

const tokens = (input: number) => ({
  input,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total: input,
});

describe("isOverflow — compaction.threshold (A3)", () => {
  it("without threshold, triggers only at >= usable (old behavior)", () => {
    const cfg = { compaction: { reserved: 20_000 } } as any;
    // usable = 200_000 - 20_000 = 180_000
    expect(isOverflow({ cfg, model, tokens: tokens(179_999) })).toBe(false);
    expect(isOverflow({ cfg, model, tokens: tokens(180_000) })).toBe(true);
  });

  it("threshold 0.85 triggers at 85% of usable", () => {
    const cfg = { compaction: { reserved: 20_000, threshold: 0.85 } } as any;
    // effective usable = 180_000 * 0.85 = 153_000
    expect(isOverflow({ cfg, model, tokens: tokens(152_999) })).toBe(false);
    expect(isOverflow({ cfg, model, tokens: tokens(153_000) })).toBe(true);
  });

  it("threshold clamped to (0, 1]", () => {
    const cfgZero = { compaction: { reserved: 20_000, threshold: 0 } } as any;
    // zero threshold is nonsensical; treat as unset (fall back to 1.0)
    expect(isOverflow({ cfg: cfgZero, model, tokens: tokens(179_999) })).toBe(false);

    const cfgOne = { compaction: { reserved: 20_000, threshold: 1 } } as any;
    // threshold 1.0 == old behavior
    expect(isOverflow({ cfg: cfgOne, model, tokens: tokens(179_999) })).toBe(false);
    expect(isOverflow({ cfg: cfgOne, model, tokens: tokens(180_000) })).toBe(true);
  });

  it("auto: false disables overflow regardless of threshold", () => {
    const cfg = { compaction: { auto: false, threshold: 0.5 } } as any;
    expect(isOverflow({ cfg, model, tokens: tokens(195_000) })).toBe(false);
  });
});
```

- [ ] **Step 4.2: Run the test to verify it FAILS**

Run from `D:/git/opencode`:

```
bun test packages/opencode/src/session/overflow.test.ts
```

Expected: 4 tests fail with messages indicating threshold is not applied.

- [ ] **Step 4.3: Add `threshold` to the config schema**

In `D:\git\opencode\packages\opencode\src\config\config.ts`, modify the `compaction` block (lines 202-213). Replace:

```ts
    compaction: z
      .object({
        auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
        prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
        reserved: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
      })
      .optional(),
```

With:

```ts
    compaction: z
      .object({
        auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
        prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
        reserved: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Fraction (0-1] of usable context at which auto-compaction triggers. Default 1.0 (at overflow). Recommended 0.85 to compact before cost spikes.",
          ),
      })
      .optional(),
```

- [ ] **Step 4.4: Apply `threshold` in `overflow.ts`**

Replace the entire contents of `D:\git\opencode\packages\opencode\src\session\overflow.ts` with:

```ts
import type { Config } from "@/config";
import type { Provider } from "@/provider";
import { ProviderTransform } from "@/provider";
import type { MessageV2 } from "./message-v2";

const COMPACTION_BUFFER = 20_000;

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false;
  const context = input.model.limit.context;
  if (context === 0) return false;

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write;

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model));
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - ProviderTransform.maxOutputTokens(input.model);

  const raw = input.cfg.compaction?.threshold;
  const threshold = typeof raw === "number" && raw > 0 && raw <= 1 ? raw : 1;
  const effective = Math.floor(usable * threshold);

  return count >= effective;
}
```

- [ ] **Step 4.5: Run the test to verify it PASSES**

Run: `bun test packages/opencode/src/session/overflow.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 4.6: Run the opencode package test suite**

Run from `D:/git/opencode`: `bun test packages/opencode`
Expected: all tests pass. If a snapshot test captures a config schema dump, regenerate it and inspect the diff — the new `threshold` field should appear under `compaction`.

- [ ] **Step 4.7: Type-check the fork**

Run: `bun run typecheck` (or equivalent — check `package.json` in `packages/opencode`).
Expected: no new type errors.

- [ ] **Step 4.8: Commit**

```bash
cd D:/git/opencode
git checkout -b phase-a-a3-compaction-threshold
git add packages/opencode/src/config/config.ts packages/opencode/src/session/overflow.ts packages/opencode/src/session/overflow.test.ts
git commit -m "feat(session): add compaction.threshold to trigger auto-compact before overflow

Adds an optional threshold (0-1] that multiplies the usable context window.
Default 1.0 preserves existing behavior (trigger at overflow). Recommended
0.85 lets compaction reclaim slack before the final request inflates to
near-max context.

Part of the token-economy Phase A work tracked in
opencode-anthropic-fix/docs/plans/2026-04-18-phase-a-surgical-fixes.md."
```

---

## Task 5: End-to-end validation across both repos

**Files:**

- Read: `C:\Users\Marquinho\.opencode\opencode-anthropic-fix\request-dumps` (session dumps)

- [ ] **Step 5.1: Configure the user session for validation**

Ensure `C:\Users\Marquinho\AppData\Roaming\opencode\anthropic-auth.json` contains:

```json
{
  "account_selection_strategy": "sticky",
  "custom_betas": ["context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "fast-mode-2026-02-01"],
  "cache_policy": { "ttl_supported": false },
  "token_economy": { "debug_dump_bodies": true },
  "token_economy_strategies": { "system_prompt_tailing": false },
  "cache_break_detection": { "enabled": true, "alert_threshold": 2000 }
}
```

- [ ] **Step 5.2: Configure opencode fork for threshold-based compaction**

In the user's opencode config (typically `~/.config/opencode/opencode.json` or project-local `.opencode/config.json`), add:

```json
{
  "compaction": { "threshold": 0.85 }
}
```

- [ ] **Step 5.3: Run a 20-turn validation session**

Open opencode with the patched plugin + fork build. Run 20 sequential turns each issuing at least 5 tool calls (grep, read, edit). Use `claude-opus-4-7` as the model.

Expected observations (record into a validation note):

- **No cache-break toast** at turn 6 (A2 validation).
- **Every dumped request** in `request-dumps/` has `thinking: {"type":"adaptive"}` (A1 validation; grep each dumped file).
- **Pre-compaction trigger** fires between turns 15–20 (A3 validation; session log shows compaction summary emitted).
- **`cache_read_input_tokens` ≥ 3 × `cache_creation_input_tokens`** after turn 3, inspected from API response usage fields (the plugin already logs these in debug mode).

- [ ] **Step 5.4: If validation passes, commit the validation notes**

Create or append `D:\git\opencode-anthropic-fix\docs\plans\2026-04-18-phase-a-validation.md` with:

- Session turn count
- Model used
- Cache-read vs cache-create ratios per turn (table)
- Cache-break toasts observed (ideally: none)
- Compaction trigger turn number

Commit:

```bash
cd D:/git/opencode-anthropic-fix
git add docs/plans/2026-04-18-phase-a-validation.md
git commit -m "docs: Phase A validation results"
```

- [ ] **Step 5.5: If validation fails, capture failure mode**

If a cache-break toast fires despite A2, or `cache_read` never dominates, or `thinking` is still undefined on some requests — DO NOT iterate blindly. Capture the exact failing request dump filename and fire the debugging skill (`superpowers:debugging`). Likely culprits:

- **thinking undefined**: an unknown callsite bypasses `isAdaptiveThinkingModel`.
- **cache break persists**: another mutation (tool ordering, system-block re-synthesis, fast-mode injection) is the real source — consult the `cache_break_detection` toast label (v0.1.14+ reports `messages_prefix` vs `system_prompt` vs `tool:X`).
- **cache_read low**: investigate whether `cache_policy.ttl_supported: false` is forcing 5min TTL that expires mid-session.

---

## Cross-phase notes

- **A1 and A2 are plugin-only**; they ship as part of v0.1.16. Users pulling the new plugin build get the fixes automatically.
- **A3 is fork-only**; it ships to users of the custom fork. The plugin is ambivalent to whether the fork has the threshold — it just sees compaction happening earlier.
- **Worktree strategy**: recommend one worktree per repo for this phase. Plugin worktree: `D:/git/opencode-anthropic-fix-phase-a`. Fork worktree: `D:/git/opencode-phase-a-a3`.
- **Merge order**: A1 → A2 → A3 (independent but this preserves a clean bisect if something regresses).

---

## Self-review (performed during drafting)

- **Spec coverage**: A1 (opus-4-7), A2 (tailing default), A3 (threshold) — each has at least one task plus a regression test; validation in Task 5 covers the end-to-end claim.
- **Placeholder scan**: no "TBD" / "similar to" / "add error handling"; every code step is complete.
- **Type consistency**: `compaction.threshold` is declared in the Zod schema and consumed via `input.cfg.compaction?.threshold` — same shape.
- **Gap identified during review**: Step 2.1's reliance on `__setSessionTurnsForTest` may not exist. Instruction added to either export it as a test-only helper OR use a 6-iteration loop instead. Task executor should choose the loop if the helper is disruptive.
