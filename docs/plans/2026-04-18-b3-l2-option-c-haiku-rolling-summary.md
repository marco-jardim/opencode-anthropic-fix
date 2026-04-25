# B3 L2 Option C — Haiku Rolling Summary (Plugin-Generated Compaction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the `opencode-anthropic-fix` plugin generate session-compaction summaries via Claude Haiku, bypassing opencode's default main-model summarizer. Plugin-generated summaries are deterministic (cache-stable) and ~10× cheaper than having Opus/Sonnet summarize.

**Architecture:** Two-repo change. Opencode fork grows a new hook `experimental.session.summarize` that fires right before the current model-based summary call; if the plugin returns `{summary}`, opencode skips its `processor.process()` call entirely and uses the plugin's string as the assistant-message content. Plugin wires this hook to its existing deterministic `lib/rolling-summarizer.mjs`, calling Haiku via OAuth. Gated behind opt-in config `token_economy_strategies.haiku_rolling_summary` (default `false`); on Haiku failure/rate-limit, plugin returns `{}` so opencode falls through to its normal model-based path.

**Tech Stack:** TypeScript (opencode fork — Bun test runner), JavaScript ESM (plugin — Vitest), Effect-TS for opencode layers, Anthropic Messages API via plugin OAuth for Haiku calls.

**Repos:**

- Opencode fork: `D:\git\opencode`
- Plugin: `D:\git\opencode-anthropic-fix`

**Why a new hook (not extending `experimental.session.compacting`):** The existing hook receives no messages — it only injects prompt context. Adding `messages` to its input changes semantics for every plugin that already uses it. A dedicated `experimental.session.summarize` hook is additive, zero-break, single-purpose.

**Why Haiku ignores the `model` opencode passes:** Simplicity + cost. Plugin's `rolling-summarizer.mjs` is pinned to `claude-haiku-4-5-20251001` with `temperature: 0` for deterministic, byte-stable output. Letting opencode pick the model would defeat the caching win (Opus summaries drift across turns even at temp 0 due to nondeterminism in larger models).

---

## File Structure

**Opencode fork** (`D:\git\opencode\packages\`):

| File                                       | Responsibility               | Action                                                                                                      |
| ------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `plugin/src/index.ts`                      | Plugin hook type definitions | Add `experimental.session.summarize` type after line 306                                                    |
| `opencode/src/session/compaction.ts`       | Compaction orchestration     | Wire new hook between messages-transform and assistant-message creation; short-circuit processor on summary |
| `opencode/test/session/compaction.test.ts` | Compaction tests             | Add tests for short-circuit path and fall-through path                                                      |

**Plugin** (`D:\git\opencode-anthropic-fix\`):

| File                                           | Responsibility                                              | Action                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `lib/haiku-call.mjs`                           | OAuth-authenticated Anthropic Messages API caller for Haiku | Create                                                                                        |
| `lib/haiku-call.test.mjs`                      | Haiku-call unit tests                                       | Create                                                                                        |
| `lib/config.mjs`                               | Config schema                                               | Add `token_economy_strategies.haiku_rolling_summary` (boolean, default `false`)               |
| `lib/config.test.mjs`                          | Config validation tests                                     | Add 2 cases for new flag                                                                      |
| `index.mjs`                                    | Plugin entry + hook handlers                                | Add `experimental.session.summarize` handler gated on config                                  |
| `test/rolling-summarizer-integration.test.mjs` | End-to-end plugin flow                                      | Create — asserts hook returns summary when enabled, `{}` when disabled, `{}` on Haiku failure |
| `CHANGELOG.md`                                 | Release notes                                               | v0.1.20 entry                                                                                 |
| `package.json`                                 | Version bump                                                | 0.1.19 → 0.1.20                                                                               |

**No dist/ edits** — `scripts/build.mjs` regenerates `dist/opencode-anthropic-auth-plugin.js` and `dist/opencode-anthropic-auth-cli.mjs` from `index.mjs` and `cli.mjs`. The final commit step runs `npm run build` to regenerate both.

---

## Pre-Implementation Verification

- [ ] **Step 0.1: Confirm `lib/rolling-summarizer.mjs` exports**

Run:

```bash
cd D:/git/opencode-anthropic-fix && grep -nE "^export " lib/rolling-summarizer.mjs
```

Expected output contains: `MODEL`, `TEMPERATURE`, `DEFAULT_MAX_CHARS`, `buildPrompt`, `parseHaikuResponse`, `formatTemplate`, `summarize`.

If `summarize` is missing or signature differs from `summarize(messages, { haikuCall, maxChars })`, stop and notify the user — the module has drifted from what this plan assumes.

- [ ] **Step 0.2: Confirm opencode fork builds clean on master**

Run:

```bash
cd D:/git/opencode && git status && git log --oneline -1
```

Expected: clean working tree (except maybe `dist/` noise in plugin repo — not this one). Last commit should be `969e265c6 fix(session): purge envCache on session.deleted to prevent Map leak` or later.

If dirty, stop — do not layer plan changes on uncommitted work.

- [ ] **Step 0.3: Confirm opencode Bun test suite passes on master**

Run:

```bash
cd D:/git/opencode/packages/opencode && bun test test/session/
```

Expected: all green. This baseline ensures any failure in Task 2 is our fault, not pre-existing.

---

## Task 1: Add `experimental.session.summarize` hook type (opencode fork)

**Files:**

- Modify: `D:\git\opencode\packages\plugin\src\index.ts:303-306`

**Context:** The current `experimental.session.compacting` definition sits at lines 303-306. We add a sibling definition right after it. Both `Message`, `Part`, and `Model` types are already imported and used elsewhere in this file, so no new imports needed.

- [ ] **Step 1.1: Add the hook type after `experimental.session.compacting`**

Insert after line 306 (after the closing `) => Promise<void>` of `experimental.session.compacting`):

```ts
  /**
   * Called during session compaction, after `experimental.session.compacting`
   * (which allows prompt customization). Allows plugins to generate the
   * summary themselves — typically using a smaller, cheaper model — and
   * bypass opencode's internal model-based summarization.
   *
   * - `input.messages`: full message history of the session (post-transform)
   * - `input.model`: the model opencode would have used for summarization
   *
   * - `output.summary`: if set, opencode uses this string as the compaction
   *   summary and SKIPS its own model call entirely. If unset/empty, opencode
   *   falls through to its normal model-based summarization path.
   * - `output.modelID` / `output.providerID`: informational — the model/provider
   *   the plugin actually used. Stored on the compaction assistant message.
   * - `output.tokens` / `output.cost`: informational — for accounting display.
   */
  "experimental.session.summarize"?: (
    input: {
      sessionID: string
      messages: {
        info: Message
        parts: Part[]
      }[]
      model: Model
    },
    output: {
      summary?: string
      modelID?: string
      providerID?: string
      tokens?: { input: number; output: number }
      cost?: number
    },
  ) => Promise<void>
```

- [ ] **Step 1.2: Type-check the plugin package**

Run:

```bash
cd D:/git/opencode/packages/plugin && bun run typecheck
```

If `typecheck` script does not exist, run:

```bash
cd D:/git/opencode/packages/plugin && bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 1.3: Commit**

```bash
cd D:/git/opencode
git add packages/plugin/src/index.ts
git commit -m "feat(plugin): add experimental.session.summarize hook type

Allows plugins to generate compaction summaries themselves (e.g., with
a cheaper model like Haiku) and short-circuit opencode's internal
model-based summarization. Additive — existing hooks unchanged."
```

---

## Task 2: Wire summarize hook into `compaction.ts` (opencode fork)

**Files:**

- Modify: `D:\git\opencode\packages\opencode\src\session\compaction.ts:238-270`
- Test: `D:\git\opencode\packages\opencode\test\session\compaction.test.ts`

**Context:** The existing flow (compaction.ts:204-290):

1. `plugin.trigger("experimental.session.compacting", ...)` — prompt customization
2. `plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })` — msgs mutation
3. Assistant message `msg` created (`session.updateMessage(msg)`) with empty tokens/cost
4. `processors.create(...)` + `processor.process(...)` — main model call, streams summary into msg
5. On `result === "continue"`, publishes `Event.Compacted`

Our insertion point is **between step 2 and step 3**: after the transform hook finishes mutating `msgs`, ask the plugin if it has a summary ready. If yes, we still create the assistant message shell (so UI shows the compaction turn), but instead of running the processor we append a text part and finalize the message directly, mirroring the error path's shape (which does `processor.message.finish = "error"; yield* session.updateMessage(processor.message)` at compaction.ts:298-299).

`MessageV2.Assistant` schema (from message-v2.ts:405-452) confirms these fields exist: `time.completed?`, `finish?`, `cost`, `tokens.{input, output, reasoning, cache.{read, write}}`, `modelID`, `providerID`. `TextPart` (message-v2.ts:112-) has: `id`, `messageID`, `sessionID`, `type: "text"`, `text`, `synthetic?`, `time: {start, end?}`.

- [ ] **Step 2.1: Write failing test — short-circuit path**

Append to `D:\git\opencode\packages\opencode\test\session\compaction.test.ts` (alongside the existing `plugin(ready)` mock):

```ts
function pluginWithSummarize(summary: string) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name === "experimental.session.summarize") {
        return Effect.sync(() => {
          (
            output as {
              summary?: string;
              modelID?: string;
              providerID?: string;
              tokens?: { input: number; output: number };
              cost?: number;
            }
          ).summary = summary;
          (output as { modelID?: string }).modelID = "claude-haiku-4-5-20251001";
          (output as { providerID?: string }).providerID = "anthropic";
          (output as { tokens?: { input: number; output: number } }).tokens = {
            input: 1234,
            output: 567,
          };
          (output as { cost?: number }).cost = 0.00123;
          return output;
        });
      }
      return Effect.succeed(output);
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  });
}

describe("session.compaction.process — plugin-provided summary", () => {
  it.live(
    "uses plugin summary when experimental.session.summarize returns one",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Arrange: set up a session with a user message so compaction has a parent
        const compact = yield* SessionCompaction.Service;
        const sess = yield* SessionNs.Service;
        const sessionID = SessionID.ascending();
        yield* sess.create({ sessionID });

        const userMsg = yield* sess.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID,
          agent: "general",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
          time: { created: Date.now() },
        });
        yield* sess.updatePart({
          id: PartID.ascending(),
          messageID: userMsg.id,
          sessionID,
          type: "text",
          text: "hello",
          time: { start: Date.now(), end: Date.now() },
        });

        const allMsgs = yield* sess.messages({ sessionID });

        // Act
        const result = yield* compact.process({
          parentID: userMsg.id,
          messages: allMsgs,
          sessionID,
          auto: false,
        });

        // Assert
        expect(result).toBe("continue");
        const after = yield* sess.messages({ sessionID });
        // There should be a new assistant message with summary=true, containing "PLUGIN_SUMMARY_XYZ"
        const compactionMsg = after.find((m) => m.info.role === "assistant" && m.info.summary === true);
        expect(compactionMsg).toBeTruthy();
        expect(compactionMsg!.info.role).toBe("assistant");
        if (compactionMsg!.info.role === "assistant") {
          expect(compactionMsg!.info.modelID).toBe("claude-haiku-4-5-20251001");
          expect(compactionMsg!.info.providerID).toBe("anthropic");
          expect(compactionMsg!.info.tokens.input).toBe(1234);
          expect(compactionMsg!.info.tokens.output).toBe(567);
          expect(compactionMsg!.info.cost).toBe(0.00123);
          expect(compactionMsg!.info.finish).toBe("stop");
          expect(compactionMsg!.info.time.completed).toBeGreaterThan(0);
        }
        const textPart = compactionMsg!.parts.find((p) => p.type === "text");
        expect(textPart).toBeTruthy();
        if (textPart && textPart.type === "text") {
          expect(textPart.text).toBe("PLUGIN_SUMMARY_XYZ");
          expect(textPart.synthetic).toBe(true);
        }
      }),
    ).pipe(Effect.provide(pluginWithSummarize("PLUGIN_SUMMARY_XYZ"))),
    // ^ Note: Layer composition — the pluginWithSummarize layer OVERRIDES
    //   the default Plugin.Service provided by provideTmpdirInstance. Verify
    //   the ordering matches the pattern used for `plugin(ready)` at test line
    //   ~350 (adjust if that helper composes differently).
  );
});
```

**Note to implementer:** before running the test, verify how the existing `plugin(ready)` helper is composed into the test harness (search `plugin(ready)` usages in this file). Mirror that pattern. The `.pipe(Effect.provide(...))` shown above is a best-guess; the existing test composition may wrap the whole `Effect.gen` differently.

- [ ] **Step 2.2: Run test to verify it fails**

Run:

```bash
cd D:/git/opencode/packages/opencode && bun test test/session/compaction.test.ts -t "plugin-provided summary"
```

Expected: FAIL — the hook is registered but compaction.ts doesn't consult it yet, so the existing model-based path runs (and probably crashes because the test doesn't mock the provider/processor for a real model call, OR it produces a summary but not "PLUGIN_SUMMARY_XYZ").

If the test times out instead of failing, the processor is hanging on a missing provider mock — that's still a "failing test" for our purposes (it tells us the short-circuit isn't happening).

- [ ] **Step 2.3: Implement the short-circuit in `compaction.ts`**

In `D:\git\opencode\packages\opencode\src\session\compaction.ts`, locate the existing block (around lines 238-270):

```ts
const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n");
const msgs = structuredClone(messages);
yield * plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs });
const modelMessages = yield * MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true });
const ctx = yield * InstanceState.context;
const msg: MessageV2.Assistant = {
  id: MessageID.ascending(),
  role: "assistant",
  parentID: input.parentID,
  sessionID: input.sessionID,
  mode: "compaction",
  agent: "compaction",
  variant: userMessage.model.variant,
  summary: true,
  path: {
    cwd: ctx.directory,
    root: ctx.worktree,
  },
  cost: 0,
  tokens: {
    output: 0,
    input: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  modelID: model.id,
  providerID: model.providerID,
  time: {
    created: Date.now(),
  },
};
yield * session.updateMessage(msg);
```

Replace with:

```ts
const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n");
const msgs = structuredClone(messages);
yield * plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs });

// Let plugins generate the summary themselves (e.g. via Haiku) and
// skip opencode's internal model call entirely. Returning output.summary
// short-circuits; otherwise we fall through to the model-based path.
const summarize =
  yield *
  plugin.trigger(
    "experimental.session.summarize",
    { sessionID: input.sessionID, messages: msgs, model },
    {
      summary: undefined as string | undefined,
      modelID: undefined as string | undefined,
      providerID: undefined as string | undefined,
      tokens: undefined as { input: number; output: number } | undefined,
      cost: undefined as number | undefined,
    },
  );

const ctx = yield * InstanceState.context;
const msg: MessageV2.Assistant = {
  id: MessageID.ascending(),
  role: "assistant",
  parentID: input.parentID,
  sessionID: input.sessionID,
  mode: "compaction",
  agent: "compaction",
  variant: userMessage.model.variant,
  summary: true,
  path: {
    cwd: ctx.directory,
    root: ctx.worktree,
  },
  cost: summarize.summary ? (summarize.cost ?? 0) : 0,
  tokens: {
    output: summarize.summary && summarize.tokens ? summarize.tokens.output : 0,
    input: summarize.summary && summarize.tokens ? summarize.tokens.input : 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  modelID: summarize.summary ? (summarize.modelID ?? model.id) : model.id,
  providerID: summarize.summary ? (summarize.providerID ?? model.providerID) : model.providerID,
  time: {
    created: Date.now(),
  },
};
yield * session.updateMessage(msg);

if (summarize.summary) {
  // Plugin produced the summary — persist it as a text part and finalize
  // the message without calling the processor (no main-model token cost).
  yield *
    session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "text",
      text: summarize.summary,
      synthetic: true,
      time: { start: Date.now(), end: Date.now() },
    });
  msg.finish = "stop";
  msg.time.completed = Date.now();
  yield * session.updateMessage(msg);
  yield * bus.publish(Event.Compacted, { sessionID: input.sessionID });
  return "continue";
}

const modelMessages = yield * MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true });
```

Note the re-order: `modelMessages` was computed BEFORE the `msg` object was built in the original code. In the new version it moves to AFTER the short-circuit branch, because we only need it on the fall-through path. The `msg` object shape is otherwise unchanged on the fall-through path (cost: 0, tokens: zero, modelID from opencode's model) — the conditional expressions collapse to the original values when `summarize.summary` is falsy.

**Subtle invariant:** the tokens/cost/modelID on `msg` are set based on `summarize.summary` at message-creation time. On the fall-through path, the processor overwrites them during streaming anyway, so the initial values don't matter. We keep the ternary for clarity (a future reader should see that the plugin-provided metadata is applied only when used).

- [ ] **Step 2.4: Run test to verify it passes**

Run:

```bash
cd D:/git/opencode/packages/opencode && bun test test/session/compaction.test.ts -t "plugin-provided summary"
```

Expected: PASS.

- [ ] **Step 2.5: Run the full `test/session/compaction.test.ts` file to verify no regression**

Run:

```bash
cd D:/git/opencode/packages/opencode && bun test test/session/compaction.test.ts
```

Expected: all tests pass. The existing tests mock `experimental.session.compacting` but not `experimental.session.summarize`, which means the `Effect.succeed(output)` branch in the default mock runs — output's summary stays `undefined`, so the fall-through path is taken. If any test fails because it was not expecting the new plugin.trigger call, update the test's mock to ignore `experimental.session.summarize` explicitly (return `Effect.succeed(output)`).

- [ ] **Step 2.6: Run the full session test suite**

Run:

```bash
cd D:/git/opencode/packages/opencode && bun test test/session/
```

Expected: all green. If `test/session/env-snapshot.test.ts` or `test/session/snapshot-tool-race.test.ts` fail, these are pre-existing flakes noted in the session memory — verify by running them in isolation 2x to confirm the flake.

- [ ] **Step 2.7: Commit**

```bash
cd D:/git/opencode
git add packages/opencode/src/session/compaction.ts packages/opencode/test/session/compaction.test.ts
git commit -m "feat(session): wire experimental.session.summarize into compaction

When a plugin returns output.summary, opencode skips processor.process()
and uses the plugin-generated string as the compaction summary. Tokens,
cost, modelID, providerID from the plugin are stored on the assistant
message for accounting. On empty output, falls through to the existing
model-based summarization path unchanged."
```

---

## Task 3: Create `lib/haiku-call.mjs` in plugin

**Files:**

- Create: `D:\git\opencode-anthropic-fix\lib\haiku-call.mjs`
- Create: `D:\git\opencode-anthropic-fix\lib\haiku-call.test.mjs`

**Context:** The plugin already has OAuth plumbing (`lib/oauth.mjs`, `lib/accounts.mjs`) that returns a Bearer access token. We need a focused wrapper that takes a prompt, calls Anthropic's Messages API with the Haiku model at temperature 0, and returns `{text, tokens, cost}` or throws.

We inject `fetch` and a `getAccessToken` function so tests are fully offline.

- [ ] **Step 3.1: Write failing test — happy path**

Create `D:\git\opencode-anthropic-fix\lib\haiku-call.test.mjs`:

```javascript
import { describe, expect, it, vi } from "vitest";
import { callHaiku } from "./haiku-call.mjs";

describe("callHaiku", () => {
  it("returns text + tokens + cost on 200 response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "summary body here" }],
        usage: { input_tokens: 100, output_tokens: 30 },
      }),
    }));
    const getAccessToken = vi.fn(async () => "oauth-token-abc");

    const result = await callHaiku({
      prompt: "summarize this",
      fetch: fetchMock,
      getAccessToken,
    });

    expect(result.text).toBe("summary body here");
    expect(result.tokens).toEqual({ input: 100, output: 30 });
    // Haiku 4.5 pricing: $1/MTok input, $5/MTok output (2026-04-18)
    // cost = 100/1e6 * 1 + 30/1e6 * 5 = 0.0001 + 0.00015 = 0.00025
    expect(result.cost).toBeCloseTo(0.00025, 8);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.method).toBe("POST");
    expect(opts.headers.authorization).toBe("Bearer oauth-token-abc");
    expect(opts.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "summarize this" }] }]);
  });

  it("throws on non-2xx HTTP response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    const getAccessToken = vi.fn(async () => "oauth-token-abc");

    await expect(callHaiku({ prompt: "x", fetch: fetchMock, getAccessToken })).rejects.toThrow(/HTTP 429/);
  });

  it("throws when response content is missing or not text", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }),
    }));
    const getAccessToken = vi.fn(async () => "oauth-token-abc");

    await expect(callHaiku({ prompt: "x", fetch: fetchMock, getAccessToken })).rejects.toThrow(/no text content/i);
  });

  it("throws when getAccessToken rejects", async () => {
    const fetchMock = vi.fn();
    const getAccessToken = vi.fn(async () => {
      throw new Error("oauth expired");
    });

    await expect(callHaiku({ prompt: "x", fetch: fetchMock, getAccessToken })).rejects.toThrow(/oauth expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npx vitest run lib/haiku-call.test.mjs
```

Expected: FAIL — `haiku-call.mjs` does not exist.

- [ ] **Step 3.3: Implement `lib/haiku-call.mjs`**

Create `D:\git\opencode-anthropic-fix\lib\haiku-call.mjs`:

```javascript
export const MODEL = "claude-haiku-4-5-20251001";
export const TEMPERATURE = 0;
export const MAX_TOKENS = 2048;
export const ANTHROPIC_VERSION = "2023-06-01";
export const API_URL = "https://api.anthropic.com/v1/messages";

// Haiku 4.5 pricing as of 2026-04-18 (USD per million tokens).
// Keep in sync with model-card if Anthropic repriced.
const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;

/**
 * Call Claude Haiku with a single user-turn prompt.
 *
 * @param {object} args
 * @param {string} args.prompt - The user-turn text. Sent as a single
 *   content-text block. No system prompt is used (summaries should be
 *   self-contained in the prompt per lib/rolling-summarizer.mjs).
 * @param {typeof fetch} args.fetch - Injected fetch (for testability).
 * @param {() => Promise<string>} args.getAccessToken - Resolves to a Bearer
 *   OAuth token. Called once per invocation; rely on plugin's existing
 *   refresh logic upstream.
 * @returns {Promise<{text: string, tokens: {input: number, output: number}, cost: number}>}
 * @throws when the HTTP call fails, when token acquisition fails, or when
 *   the response has no text content.
 */
export async function callHaiku({ prompt, fetch, getAccessToken }) {
  const token = await getAccessToken();

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Haiku call failed: HTTP ${res.status} ${body}`);
  }

  const json = await res.json();
  const textBlock = (json.content ?? []).find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string" || textBlock.text.length === 0) {
    throw new Error("Haiku response has no text content");
  }
  const input = json.usage?.input_tokens ?? 0;
  const output = json.usage?.output_tokens ?? 0;
  const cost = (input / 1e6) * PRICE_INPUT_PER_MTOK + (output / 1e6) * PRICE_OUTPUT_PER_MTOK;

  return { text: textBlock.text, tokens: { input, output }, cost };
}
```

- [ ] **Step 3.4: Run test to verify it passes**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npx vitest run lib/haiku-call.test.mjs
```

Expected: PASS — 4/4 tests green.

- [ ] **Step 3.5: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add lib/haiku-call.mjs lib/haiku-call.test.mjs
git commit -m "feat(lib): haiku-call — OAuth-authenticated Messages API wrapper

Dedicated caller for claude-haiku-4-5-20251001 at temperature 0. Used
by the rolling summarizer path (experimental.session.summarize hook).
Pure, dependency-injected (fetch + getAccessToken) — fully offline tests."
```

---

## Task 4: Add config flag `token_economy_strategies.haiku_rolling_summary`

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\lib\config.mjs`
- Modify: `D:\git\opencode-anthropic-fix\lib\config.test.mjs`

**Context:** Per user direction, the key is explicit: `token_economy_strategies.haiku_rolling_summary` (default `false`). The plugin already has `token_economy_strategies` as a namespace (C3 added `tool_result_dedupe_session_wide` there). We extend the same schema.

- [ ] **Step 4.1: Locate the existing `token_economy_strategies` schema**

Run:

```bash
cd D:/git/opencode-anthropic-fix && grep -n "token_economy_strategies\|tool_result_dedupe_session_wide" lib/config.mjs
```

Note the line number of the `token_economy_strategies` object / its field definitions (likely around where `tool_result_dedupe_session_wide` is declared).

- [ ] **Step 4.2: Write failing test**

Append to `D:\git\opencode-anthropic-fix\lib\config.test.mjs` (inside an appropriate `describe` block — reuse the one covering `token_economy_strategies` if present, otherwise add alongside existing coverage):

```javascript
describe("token_economy_strategies.haiku_rolling_summary", () => {
  it("defaults to false when omitted", () => {
    const parsed = parseConfig({});
    expect(parsed.token_economy_strategies?.haiku_rolling_summary).toBe(false);
  });

  it("accepts true when explicitly set", () => {
    const parsed = parseConfig({
      token_economy_strategies: { haiku_rolling_summary: true },
    });
    expect(parsed.token_economy_strategies.haiku_rolling_summary).toBe(true);
  });

  it("rejects non-boolean values", () => {
    expect(() =>
      parseConfig({
        token_economy_strategies: { haiku_rolling_summary: "yes" },
      }),
    ).toThrow();
  });
});
```

**Note to implementer:** `parseConfig` may be named differently (`validateConfig`, `loadConfig`, etc.). Check the top of `config.test.mjs` for the import to match the actual export. If the test helper is `validateConfig(raw)` or similar, adjust these tests.

- [ ] **Step 4.3: Run test to verify it fails**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npx vitest run lib/config.test.mjs -t "haiku_rolling_summary"
```

Expected: FAIL — schema lacks the field; default is `undefined`, not `false`.

- [ ] **Step 4.4: Implement schema change in `lib/config.mjs`**

Find the `token_economy_strategies` object in the schema. Add the new field alongside `tool_result_dedupe_session_wide` (and any other existing strategy flags). Use the same Zod (or validation library) pattern as neighboring fields. If neighboring fields look like:

```javascript
tool_result_dedupe_session_wide: z.boolean().optional().default(false),
```

then add:

```javascript
haiku_rolling_summary: z.boolean().optional().default(false),
```

If the schema is hand-rolled (no Zod), mirror whatever pattern exists — the key invariant is: default `false`, accept only boolean, reject strings/numbers/etc.

- [ ] **Step 4.5: Run test to verify it passes**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npx vitest run lib/config.test.mjs
```

Expected: all config tests pass (the 3 new ones + existing ones).

- [ ] **Step 4.6: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add lib/config.mjs lib/config.test.mjs
git commit -m "feat(config): add token_economy_strategies.haiku_rolling_summary

Opt-in flag (default false) for the experimental.session.summarize hook
handler landing in the next task. Gates Haiku-based compaction summaries."
```

---

## Task 5: Wire `experimental.session.summarize` handler in plugin

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\index.mjs`
- Test: new tests appended to an existing integration-test file OR a new one (see Task 6)

**Context:** The plugin's `index.mjs` is a large file (lines 1-8800+) with hook handlers registered via an opencode plugin factory. We need to:

1. Find where existing hook handlers are registered (search for `experimental.chat.messages.transform` as an anchor).
2. Register a handler for `experimental.session.summarize`.
3. In the handler, gate on config; if off, return (output unchanged — `summary` stays undefined). If on, call `rolling-summarizer.summarize(messages, {haikuCall})` and assign the result to `output.summary` + tokens + cost + modelID + providerID.

The `haikuCall` passed to `summarize` is a closure: `(prompt) => callHaiku({prompt, fetch, getAccessToken})`. The plugin already has `fetch` and OAuth access functions in scope near other hook handlers — reuse the same references.

- [ ] **Step 5.1: Locate hook registration site**

Run:

```bash
cd D:/git/opencode-anthropic-fix && grep -nE '"experimental\.chat\.messages\.transform"|"experimental\.session\.compacting"' index.mjs
```

Note the line numbers and the surrounding object structure. You're looking for the handler-registration block (e.g., a returned object with keys like `"experimental.chat.messages.transform": async (input, output) => { ... }`).

Also locate:

```bash
cd D:/git/opencode-anthropic-fix && grep -nE "getAccessToken|accessToken|Bearer " index.mjs | head -30
```

Identify the function the plugin already uses to get an OAuth token for outgoing Anthropic calls. Use that same function in the new handler.

- [ ] **Step 5.2: Write failing test (deferred to Task 6)**

Task 6 writes the integration test that drives this handler. Start Task 5 implementation now; Task 6 will verify it end-to-end.

- [ ] **Step 5.3: Add handler registration in `index.mjs`**

Near the existing `experimental.session.compacting` handler (if any) or alongside `experimental.chat.messages.transform`, add:

```javascript
import { callHaiku } from "./lib/haiku-call.mjs";
import { summarize as rollingSummarize } from "./lib/rolling-summarizer.mjs";
```

(Place the imports at the top of `index.mjs` with the other imports. If the file uses CommonJS-style `require`, match that pattern instead — but per the vitest setup, `.mjs` extension indicates ESM.)

Inside the hook-registration object, add:

```javascript
    "experimental.session.summarize": async (input, output) => {
      // Lazy config read — matches the pattern used by other hooks here.
      const cfg = await loadConfig(); // or whatever the in-file helper is named
      if (!cfg?.token_economy_strategies?.haiku_rolling_summary) {
        return; // leave output.summary undefined — opencode falls through
      }

      try {
        const haikuCall = async (prompt) =>
          callHaiku({
            prompt,
            fetch: globalThis.fetch,
            getAccessToken, // reuse the plugin's existing OAuth helper (verified in 5.1)
          });
        const result = await rollingSummarize(input.messages, { haikuCall });
        // rollingSummarize returns { text, tokens, cost } per lib/rolling-summarizer.mjs
        output.summary = result.text;
        output.modelID = "claude-haiku-4-5-20251001";
        output.providerID = "anthropic";
        output.tokens = result.tokens;
        output.cost = result.cost;
      } catch (err) {
        // On any failure (rate limit, network, OAuth, malformed response),
        // leave output.summary undefined so opencode falls through to its
        // own model-based summarization. Log for the user's debug toast.
        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            `[opencode-anthropic-fix] haiku rolling summary failed; falling back to default compaction: ${err.message}`,
          );
        }
      }
    },
```

**Note to implementer:** verify the actual config-load helper name and the OAuth-token accessor name before wiring — the snippet above uses `loadConfig` and `getAccessToken` as placeholders that match the style of other handlers. Do NOT use different naming than what the file already uses.

**Also verify:** that `rollingSummarize` from `lib/rolling-summarizer.mjs` actually returns `{text, tokens, cost}`. Per Step 0.1, `summarize` exists and accepts `(messages, {haikuCall, maxChars})`. If its return shape differs (e.g., returns just a string), wrap the call:

```javascript
const summaryText = await rollingSummarize(input.messages, { haikuCall });
// then assign output.summary = summaryText and compute tokens/cost from the
// inner haikuCall wrapper by capturing them in a closure (see below).
```

A defensive approach — capture tokens/cost via a closure since rolling-summarizer may not expose them:

```javascript
let capturedTokens = { input: 0, output: 0 };
let capturedCost = 0;
const haikuCall = async (prompt) => {
  const r = await callHaiku({ prompt, fetch: globalThis.fetch, getAccessToken });
  capturedTokens = r.tokens;
  capturedCost = r.cost;
  return r.text; // rolling-summarizer expects haikuCall to return a string
};
const summaryText = await rollingSummarize(input.messages, { haikuCall });
output.summary = summaryText;
output.modelID = "claude-haiku-4-5-20251001";
output.providerID = "anthropic";
output.tokens = capturedTokens;
output.cost = capturedCost;
```

Pick whichever matches the existing `lib/rolling-summarizer.mjs` contract. Read the file once, then pick.

- [ ] **Step 5.4: Run plugin's full test suite to confirm no regression**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npm test 2>&1 | tail -20
```

Expected: 1060 + new tests all pass. No regression in existing handlers (we added, didn't modify).

- [ ] **Step 5.5: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add index.mjs
git commit -m "feat(plugin): wire experimental.session.summarize via rolling-summarizer

Hook is gated on token_economy_strategies.haiku_rolling_summary (default
off). When enabled, calls claude-haiku-4-5-20251001 via plugin OAuth with
the deterministic template from lib/rolling-summarizer.mjs. On Haiku
failure (rate limit, network, OAuth), leaves output.summary undefined so
opencode falls through to its default model-based summarization."
```

---

## Task 6: Integration test — end-to-end hook flow

**Files:**

- Create: `D:\git\opencode-anthropic-fix\test\rolling-summarizer-integration.test.mjs`

**Context:** We test the hook handler from Task 5 directly, by importing the plugin factory, invoking the handler with a mocked `fetch` and `getAccessToken`, and asserting the output shape across three scenarios: gate off, gate on + success, gate on + Haiku failure.

The plugin exports its hook map through its factory. Find the exported entry point:

```bash
cd D:/git/opencode-anthropic-fix && grep -nE "^export (default|const|function)" index.mjs | head -20
```

Typically opencode plugins export a factory that returns the hook map. Adjust the test's import accordingly.

- [ ] **Step 6.1: Write the integration test**

Create `D:\git\opencode-anthropic-fix\test\rolling-summarizer-integration.test.mjs`:

```javascript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The plugin factory default export — adjust name to match index.mjs.
import createPlugin from "../index.mjs";

function makeMessages() {
  return [
    {
      info: {
        id: "msg1",
        role: "user",
        sessionID: "sess-abc",
        time: { created: 1_700_000_000_000 },
      },
      parts: [{ id: "p1", messageID: "msg1", sessionID: "sess-abc", type: "text", text: "hi" }],
    },
    {
      info: {
        id: "msg2",
        role: "assistant",
        sessionID: "sess-abc",
        time: { created: 1_700_000_010_000 },
      },
      parts: [{ id: "p2", messageID: "msg2", sessionID: "sess-abc", type: "text", text: "hello back" }],
    },
  ];
}

describe("experimental.session.summarize — integration", () => {
  let tmp;
  let origEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oaf-integ-"));
    origEnv = { ...process.env };
    process.env.HOME = tmp;
    process.env.APPDATA = tmp;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    process.env = origEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function bootstrapHandlers(configOverride = {}) {
    const configDir = join(tmp, "opencode");
    require("node:fs").mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "anthropic-auth.json"),
      JSON.stringify({
        token_economy_strategies: configOverride,
      }),
    );
    // Construct the plugin — adjust signature to match what index.mjs expects.
    // Opencode calls the factory with a context object.
    const handlers = await createPlugin({
      /* minimal stubs — extend if plugin requires specific context fields */
      project: { id: "test" },
      directory: tmp,
      worktree: tmp,
      serverUrl: "http://localhost:0",
      $: () => {},
    });
    return handlers;
  }

  it("when config flag is off, leaves output.summary undefined", async () => {
    const handlers = await bootstrapHandlers({ haiku_rolling_summary: false });
    const output = { summary: undefined };
    await handlers["experimental.session.summarize"]?.(
      { sessionID: "sess-abc", messages: makeMessages(), model: { id: "opus", providerID: "anthropic" } },
      output,
    );
    expect(output.summary).toBeUndefined();
  });

  it("when flag is on, returns Haiku summary + metadata", async () => {
    const handlers = await bootstrapHandlers({ haiku_rolling_summary: true });

    // Mock global fetch for this test
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "rolled-up summary body" }],
        usage: { input_tokens: 500, output_tokens: 80 },
      }),
    }));

    try {
      const output = {
        summary: undefined,
        modelID: undefined,
        providerID: undefined,
        tokens: undefined,
        cost: undefined,
      };
      await handlers["experimental.session.summarize"]?.(
        { sessionID: "sess-abc", messages: makeMessages(), model: { id: "opus", providerID: "anthropic" } },
        output,
      );
      expect(output.summary).toBe("rolled-up summary body");
      expect(output.modelID).toBe("claude-haiku-4-5-20251001");
      expect(output.providerID).toBe("anthropic");
      expect(output.tokens).toEqual({ input: 500, output: 80 });
      // cost = 500/1e6 * 1 + 80/1e6 * 5 = 0.0005 + 0.0004 = 0.0009
      expect(output.cost).toBeCloseTo(0.0009, 8);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("on Haiku failure, leaves output.summary undefined (fall-through)", async () => {
    const handlers = await bootstrapHandlers({ haiku_rolling_summary: true });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));

    // Silence the console.warn noise from the handler's fall-through log
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const output = { summary: undefined };
      await handlers["experimental.session.summarize"]?.(
        { sessionID: "sess-abc", messages: makeMessages(), model: { id: "opus", providerID: "anthropic" } },
        output,
      );
      expect(output.summary).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
      warnSpy.mockRestore();
    }
  });
});
```

**Note to implementer:** The `bootstrapHandlers` factory signature is a best-guess. Read `index.mjs`'s actual `export default` signature (what does opencode pass as context?) and adjust the arguments accordingly. If there is no `export default`, find the `init` function or hook-registering factory and import it by name.

If the plugin reads config from `~/.config/opencode/anthropic-auth.json` (not `<XDG>/opencode/anthropic-auth.json`), adjust `configDir`.

If OAuth acquires tokens via a background refresh flow (not a direct `getAccessToken` call in the handler), the integration test may need to additionally stub the OAuth subsystem. Look at how existing hook tests handle this — e.g., `test/context-hint-persist.test.mjs` shows the canonical pattern for bootstrapping the plugin with a tmpdir config.

- [ ] **Step 6.2: Run the test**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npx vitest run test/rolling-summarizer-integration.test.mjs
```

Expected: 3/3 pass.

- [ ] **Step 6.3: Run the full plugin test suite**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npm test 2>&1 | tail -10
```

Expected: all tests pass (1060 + 4 new haiku-call + 3 new config + 3 new integration = ~1070).

- [ ] **Step 6.4: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add test/rolling-summarizer-integration.test.mjs
git commit -m "test(plugin): integration test for experimental.session.summarize

Covers the three hook paths: config off (no-op), config on + Haiku
success (full summary + tokens + cost), config on + Haiku 429 (fall-
through, warning logged, output.summary stays undefined)."
```

---

## Task 7: Version bump, CHANGELOG, and dist rebuild

**Files:**

- Modify: `D:\git\opencode-anthropic-fix\package.json` (0.1.19 → 0.1.20)
- Modify: `D:\git\opencode-anthropic-fix\CHANGELOG.md` (add v0.1.20 entry)
- Rebuild: `D:\git\opencode-anthropic-fix\dist\opencode-anthropic-auth-plugin.js`
- Rebuild: `D:\git\opencode-anthropic-fix\dist\opencode-anthropic-auth-cli.mjs`

- [ ] **Step 7.1: Bump version in `package.json`**

Edit `package.json`:

```json
"version": "0.1.20",
```

(was `"0.1.19"`)

- [ ] **Step 7.2: Add CHANGELOG entry**

Prepend a new section to `D:\git\opencode-anthropic-fix\CHANGELOG.md` immediately after the `# Changelog` header and intro line, BEFORE the existing `## [0.1.19]` section:

````markdown
## [0.1.20] — 2026-04-18

### Feature — Haiku rolling summary (opt-in, requires opencode fork with `experimental.session.summarize`)

When the opencode fork exposes the new `experimental.session.summarize`
hook (introduced this week), the plugin can now generate session
compaction summaries using `claude-haiku-4-5-20251001` at
`temperature: 0` instead of the main model the user's session is running
on. This short-circuits opencode's internal model-based summarizer
entirely on the compaction turn.

**Why it saves money:** Opus/Sonnet summarizing a large session costs
~$0.50–$2.00 per compaction turn. Haiku costs ~$0.001–$0.005 for the
same summarization. Beyond the per-turn cost, Haiku at temp 0 with the
deterministic template in `lib/rolling-summarizer.mjs` produces
byte-identical summaries for identical input, so the Anthropic prompt
cache can reuse the summary prefix across the post-compaction session.

**Enable:** set in `anthropic-auth.json`:

```json
{
  "token_economy_strategies": {
    "haiku_rolling_summary": true
  }
}
```
````

Default is `false` because the feature requires a matching version of
the opencode fork (`experimental.session.summarize` hook must exist).
Plugin gracefully falls through to opencode's default summarization
when Haiku is unreachable (rate limit, network, OAuth) — users never
get stuck without a summary.

**New files:**

- `lib/haiku-call.mjs` — OAuth-authenticated Anthropic Messages API
  caller pinned to `claude-haiku-4-5-20251001`, `temperature: 0`,
  `max_tokens: 2048`. Pure + dependency-injected for offline tests.

**Schema additions:**

- `token_economy_strategies.haiku_rolling_summary` (boolean, default
  `false`).

````

- [ ] **Step 7.3: Rebuild dist bundles**

Run:
```bash
cd D:/git/opencode-anthropic-fix && npm run build
````

Expected output: `Built dist/opencode-anthropic-auth-plugin.js and dist/opencode-anthropic-auth-cli.mjs`.

- [ ] **Step 7.4: Commit**

```bash
cd D:/git/opencode-anthropic-fix
git add package.json CHANGELOG.md dist/opencode-anthropic-auth-plugin.js dist/opencode-anthropic-auth-cli.mjs
git commit -m "chore: v0.1.20 — haiku rolling summary (opt-in, requires fork hook)

See CHANGELOG.md for user-facing documentation. Feature is gated behind
token_economy_strategies.haiku_rolling_summary (default off) and is a
no-op on opencode versions without experimental.session.summarize."
```

---

## Task 8: Final validation — full test suites both repos

- [ ] **Step 8.1: Opencode fork — full session test suite**

Run:

```bash
cd D:/git/opencode/packages/opencode && bun test test/session/
```

Expected: all green. Known flakes: `snapshot-tool-race.test.ts` (pre-existing, unrelated to this work).

- [ ] **Step 8.2: Plugin — full vitest suite**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npm test 2>&1 | tail -8
```

Expected: `Test Files XX passed`, `Tests 1070+ passed`.

- [ ] **Step 8.3: Plugin — eslint passes on affected files**

Run:

```bash
cd D:/git/opencode-anthropic-fix && npx eslint lib/haiku-call.mjs lib/haiku-call.test.mjs test/rolling-summarizer-integration.test.mjs
```

Expected: zero errors. Pre-existing warnings in `index.mjs` are OK (they already existed pre-plan; don't fix them as part of this change — scope creep).

---

## Task 9: User hand-off for manual end-to-end validation

**Do NOT publish to npm or push to GitHub without explicit user authorization** — these are shared-state gates per `CLAUDE.md`.

- [ ] **Step 9.1: Report completion to user**

Deliver a concise summary:

- Plugin tests: X passed
- Opencode fork tests: Y passed
- New files created: `lib/haiku-call.mjs`, `lib/haiku-call.test.mjs`, `test/rolling-summarizer-integration.test.mjs`
- Files modified: `index.mjs`, `lib/config.mjs`, `CHANGELOG.md`, `package.json`, `dist/*`, `compaction.ts`, `plugin/src/index.ts`
- Opencode fork commits ready (task 1 + task 2 commits)
- Plugin commits ready (task 3 + task 4 + task 5 + task 6 + task 7 commits)
- **NOT pushed, NOT published** — waiting on user confirmation

- [ ] **Step 9.2: Manual-validation checklist for the user**

Present this checklist for the user to execute themselves:

1. Install the new plugin version locally from the built dist:
   ```bash
   cd D:/git/opencode-anthropic-fix && npm pack
   # Install the resulting .tgz into wherever opencode picks up the plugin
   ```
2. Update the opencode fork to the new commits (tasks 1 + 2):
   ```bash
   cd D:/git/opencode && bun install && bun run build
   ```
3. Enable the flag in `%APPDATA%\opencode\anthropic-auth.json` (Windows) or
   `~/.config/opencode/anthropic-auth.json`:
   ```json
   { "token_economy_strategies": { "haiku_rolling_summary": true } }
   ```
4. Start an opencode session, work until compaction triggers (or run
   `/compact` manually).
5. Verify in the plugin's debug dump directory (or logs) that a Haiku
   Messages API call fired at the compaction turn.
6. Verify the assistant message produced for the compaction turn has:
   - `modelID: "claude-haiku-4-5-20251001"`
   - Low `cost` (< $0.01)
   - Non-empty text
7. After compaction, send another message and confirm prompt cache hits
   (low `cache_creation_input_tokens`, high `cache_read_input_tokens` in
   the next response usage block).

- [ ] **Step 9.3: Wait for user decision**

Ask the user:

- "All tests green in both repos. Want me to push the opencode fork commits, push the plugin commits, tag v0.1.20, and publish to npm?"

Do not take these actions unless the user says yes.

---

## Self-Review Summary

**Spec coverage check:**

- ✅ Task 1 — hook type (`experimental.session.summarize`) defined
- ✅ Task 2 — opencode fork wiring + short-circuit
- ✅ Task 3 — Haiku caller with OAuth
- ✅ Task 4 — config flag `token_economy_strategies.haiku_rolling_summary` (default off — user direction 1)
- ✅ Task 5 — plugin handler that ignores the input `model` and always uses Haiku (user direction 2)
- ✅ Task 5 error branch + Task 6 test case — fallback on Haiku failure returns `{}` so opencode falls through (user direction 3)
- ✅ Task 7 — version + CHANGELOG + dist rebuild
- ✅ Task 8 — both-repo test validation
- ✅ Task 9 — manual validation + user authorization gate for npm/push (user direction 4 — formal plan + subagent-driven execution)

**Placeholder scan:** Two notes-to-implementer in Tasks 5 and 6 flag fields (`loadConfig`, `getAccessToken`, `export default`) whose exact names need verification against the real `index.mjs` before final wiring. These are not placeholders in the "TODO fill in later" sense — they are "match the surrounding code's naming" directives with fallback patterns provided. Acceptable per the skill: the implementer runs one grep, picks the match, proceeds.

**Type consistency:** The hook output shape `{summary?, modelID?, providerID?, tokens?, cost?}` is identical across Task 1 (type def), Task 2 (opencode-side consumption), and Task 5 (plugin-side production). `tokens: {input, output}` is consistent. `cost: number` is consistent. The `messages` input type on the hook matches the `MessageV2.WithParts[]` signature that opencode's `compaction.process` already accepts (`{info: Message; parts: Part[]}[]`).
