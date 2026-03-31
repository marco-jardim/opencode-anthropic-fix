# Plan B: New Standalone OpenCode Plugins — Feasibility Study & Implementation Proposal

**Date:** 2026-03-31  
**Status:** Draft  
**Source:** Analysis of `@anthropic-ai/claude-code@2.1.88` (1,906 files, 515K lines)  
**Scope:** 7 plugin opportunities distinct from `opencode-anthropic-fix` (Plan A)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [OpenCode Plugin API Capabilities Assessment](#2-opencode-plugin-api-capabilities-assessment)
3. [Per-Plugin Feasibility Analysis](#3-per-plugin-feasibility-analysis)
4. [Prioritization Matrix](#4-prioritization-matrix)
5. [Recommended Implementation Roadmap](#5-recommended-implementation-roadmap)
6. [Plugins That Need OpenCode Core Changes](#6-plugins-that-need-opencode-core-changes)
7. [Overlap Analysis with Plan A](#7-overlap-analysis-with-plan-a)

---

## 1. Executive Summary

Analysis of the Claude Code v2.1.88 source reveals 7 features with potential value as standalone OpenCode plugins. After rigorous assessment against OpenCode's plugin API capabilities:

**Viable (build now):**

- **B3 `opencode-cost-tracker`** — reads usage from API responses via middleware, persists to JSON. Fully within plugin API scope. High value, provider-agnostic.
- **B2 `opencode-context-inspector`** — approximated token accounting via message inspection. Output as markdown table via slash command. Viable with the caveat that token counts are estimates, not exact.

**Viable with significant limitations (build with caveats):**

- **B1 `opencode-session-memory`** — the forked-agent extraction pattern from CC can't be replicated, but a command-triggered extraction variant is workable. Requires making its own LLM API calls, which adds complexity and cost.
- **B6 `opencode-prompt-cache-optimizer`** — technically viable, but mostly redundant with Plan A feature A5. Should be implemented as an enhancement to the existing plugin, not a new package.

**Not viable as plugins today:**

- **B4 `opencode-hook-system`** — requires OpenCode core to expose new event types. A plugin can't create hook points that don't exist.
- **B5 `opencode-permission-guard`** — requires tool execution interception, which the plugin API does not expose. Fundamentally a core concern.
- **B7 `opencode-speculation`** — makes real API calls against prediction of unknown future prompts. Low match rate means wasted cost. The risk/reward is poor.

**Recommended priority:** B3 → B2 → B1 → (B6 as Plan A enhancement, not new package) → defer B4/B5/B7.

---

## 2. OpenCode Plugin API Capabilities Assessment

This section documents what the `@opencode-ai/plugin` API can and cannot do. These boundaries determine feasibility for all 7 plugins.

### 2.1 What Plugins CAN Do

| Capability                | Mechanism                              | Notes                                                                               |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Intercept API requests    | `middleware()` fetch interceptor       | Full access to request body, headers before send                                    |
| Intercept API responses   | `middleware()` response handler        | Can read body/SSE stream, but consuming the stream prevents OpenCode from seeing it |
| Inject into system prompt | Modify `body.system` in `middleware()` | Works reliably; already used in Plan A                                              |
| Modify request headers    | Modify headers in `middleware()`       | Works; already used in Plan A                                                       |
| Modify request body       | Mutate parsed body in `middleware()`   | Works; already used in Plan A                                                       |
| Register custom tools     | `tool()`                               | Model can call these; tool result returned to conversation                          |
| Register slash commands   | `command()`                            | User types `/command` in OpenCode; returns markdown text response                   |
| Lifecycle hooks           | `hook()`                               | Limited: `init`, `auth`, and a few others                                           |
| Toast notifications       | Plugin context API                     | Works; used in Plan A                                                               |
| Read/write files          | Standard `node:fs`                     | No restrictions; plugins can write JSON/markdown to any path                        |
| Make HTTP requests        | Standard `fetch`                       | Plugins can make arbitrary HTTP calls including to Anthropic API                    |
| Access model/provider     | Plugin context                         | Model ID, provider name accessible in middleware                                    |
| Access project path       | Plugin context                         | CWD / project root accessible                                                       |
| Set timers                | `setTimeout` / `setInterval`           | Works but no lifecycle guarantees (cleared on OpenCode restart)                     |

### 2.2 What Plugins CANNOT Do

| Capability                                            | Why Not                                                                              | Impact                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Intercept individual tool calls                       | Tool execution happens inside OpenCode's agent loop, not at the fetch layer          | Blocks B5 entirely                               |
| Create new hook types                                 | Plugins consume hooks; they can't publish new event types to other consumers         | Blocks B4 entirely                               |
| Render rich terminal UI                               | No access to Ink/React rendering pipeline                                            | Degrades B2 from treemap to text table           |
| Access full session message history                   | Middleware sees the current request body; prior turns are not separately addressable | Complicates B1                                   |
| Persistent KV storage                                 | No built-in store; must use filesystem                                               | Workaround exists (JSON files)                   |
| Background task scheduling                            | `setInterval` is not guaranteed to survive OpenCode process restarts                 | Complicates B1 auto-extraction                   |
| Pause/resume the agent loop                           | No API for flow control                                                              | Blocks B7 (can't hold response while spec fires) |
| Read cache hit counts directly                        | Must parse from SSE `message_delta` usage fields                                     | Workaround exists                                |
| Access SSE stream for inspection without consuming it | Consuming the stream in middleware means OpenCode never sees it                      | Must tee the stream or inspect non-destructively |

### 2.3 Stream Inspection Constraint (Critical for B3, B2)

The most critical constraint for cost/token tracking: when `middleware()` intercepts a streaming response, reading the response body consumes it. OpenCode then gets an empty body. The solution is to **tee the stream**:

```js
const [streamA, streamB] = response.body.tee();
// Pass streamA to OpenCode (original consumer)
// Read streamB in plugin for usage extraction
return new Response(streamA, response);
```

This works but adds memory pressure proportional to response size. It's the approach Plan A already uses for token tracking.

### 2.4 API Call Cost Constraint (Critical for B1, B7)

Plugins can make their own API calls via `fetch`. However:

- These calls consume the user's API quota/subscription allowance
- They appear in cost tracking as additional usage
- They require credentials (the plugin would need to read the current auth token)
- For B1: an extraction call once per session is acceptable cost
- For B7: speculative prefetch calls on every response is unacceptable cost

---

## 3. Per-Plugin Feasibility Analysis

---

### 3.1 `opencode-session-memory`

**Concept:** Periodically extracts key decisions, file paths, and discoveries from the conversation into a structured markdown file. This "memory" survives context compaction and is injected back into the system prompt at the start of each session or after compaction.

**CC Source Reference:**

- `sessionMemory.ts` — 495 lines. Manages extraction, freshness tracking, token-threshold triggers, forked agent calls, and markdown persistence.
- Uses a forked agent pattern: spins up a separate, cheaper model call to summarize the session without interrupting the main conversation.

**Pre-Flight Feasibility Check:**

1. Can middleware inject a memory block into the system prompt? → **YES** — Plan A already does this for billing/identity blocks. Straightforward.
2. Can the plugin read the full conversation history from the current request? → **PARTIAL** — `body.messages` in the intercepted request contains the history up to the current turn. Not all prior context is available after compaction.
3. Can the plugin trigger a separate LLM call for extraction? → **YES** — via `fetch` to `/v1/messages` using the active auth token. Cost: ~500–2,000 input tokens per extraction call.
4. Can the plugin persist memory to disk? → **YES** — write to `.opencode/session-memory.md` or per-project path.
5. Can the plugin detect compaction events to re-inject? → **PARTIAL** — no dedicated compaction hook. Can detect via `hook('init')` at session start and inject then.
6. Can the plugin auto-trigger extraction at token thresholds? → **PARTIAL** — can track cumulative tokens via middleware (already done in Plan A). When threshold is reached, can fire extraction, but only on the next request turn (not mid-response).
7. Is there overlap with Plan A? → **YES** — Plan A's A1 (auto-compaction enhancement) injects context into compaction. Complementary but distinct.
8. Does extraction require its own API costs? → **YES** — each extraction call costs tokens. Must be opt-in or threshold-gated.

**Verdict: VIABLE WITH LIMITATIONS**

The forked-agent automatic extraction from CC cannot be replicated exactly. The plugin version will:

- Use a slash command `/memory extract` for on-demand extraction
- Auto-trigger extraction when cumulative tokens cross a configurable threshold (default: 80% context window)
- Inject persisted memory into system prompt via middleware on each request
- Persist to a project-local markdown file

**Implementation Proposal:**

**Architecture:**

```
[middleware — request] → count tokens, check threshold
    → if threshold hit: fire async extraction call (non-blocking)
    → inject memory block from disk into body.system

[tool: memory_extract] → user-callable tool to force extraction
[command: /memory] → subcommands: show, extract, clear, edit
```

**Key Components:**

- `MemoryStore` — reads/writes `.opencode/session-memory.md`
- `ExtractionEngine` — builds extraction prompt, calls `/v1/messages`, parses structured markdown response
- `MemoryInjector` — prepends memory block to system prompt in middleware
- Token threshold tracker (reuse Plan A's cumulative token count)

**Plugin API Usage:**

- `middleware()` — inject memory into request, track token usage
- `tool()` — `memory_extract` tool callable by the model when it detects important context
- `command()` — `/memory [show|extract|clear]`
- `hook('init')` — load memory file at session start
- `toast()` — notify when extraction completes or memory is injected

**Storage Strategy:** `.opencode/session-memory.md` (per-project) + `.opencode/session-memory-meta.json` (freshness/token count metadata)

**Config Schema:**

```json
{
  "session_memory": {
    "enabled": true,
    "extraction_threshold_pct": 80,
    "max_memory_tokens": 2000,
    "extraction_model": "claude-haiku-4-5",
    "inject_on_init": true
  }
}
```

**Estimated Effort:** 4–6 days  
**Dependencies:** Active Anthropic auth token accessible from plugin context (requires coordination with `opencode-anthropic-fix` or a generic auth abstraction)

**Risks & Mitigations:**

| Risk                                    | Likelihood | Impact                 | Mitigation                                         |
| --------------------------------------- | ---------- | ---------------------- | -------------------------------------------------- |
| Extraction call fails (auth error, 429) | Medium     | Low (graceful degrade) | Skip extraction, log toast, retry next turn        |
| Memory grows unbounded                  | Medium     | Medium                 | Token-limit enforcement; summarize-the-summary     |
| Extraction prompt leaks private code    | Low        | High                   | Clear user documentation; opt-in by default        |
| Threshold trigger fires too often       | Medium     | Medium                 | Rate-limit extraction to once per N turns          |
| Breaking if Plan A is not present       | Low        | High                   | Don't hard-depend on Plan A; use own token counter |

---

### 3.2 `opencode-context-inspector`

**Concept:** Visualizes how the context window is being used. Breaks down token consumption by category (system prompt, tool definitions, conversation history, cached vs. uncached). Outputs a markdown table showing the "treemap" of token usage. Triggered by `/context` slash command.

**CC Source Reference:**

- `contextAnalysis.ts` — 272 lines. Breaks down token counts by message role, tool definitions, system blocks, and cache status. Renders a visual treemap using Ink (React-based terminal renderer).

**Pre-Flight Feasibility Check:**

1. Can middleware read the full request body including messages and tools? → **YES** — `body.messages`, `body.tools`, `body.system` all available.
2. Can the plugin count tokens accurately? → **NO** — the exact Claude tokenizer is not available. Approximation via character-to-token ratio (~4 chars/token) gives ±10–15% error. Good enough for planning; not suitable for exact accounting.
3. Can the plugin render a visual treemap in the terminal? → **NO** — no Ink/React access. Output is limited to markdown text.
4. Can the plugin access cache hit data from responses? → **YES** — via stream tee, reads `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens` from SSE `message_delta`.
5. Is the slash command output readable as a markdown table? → **YES** — OpenCode renders markdown in command output.
6. Is there value without the visual treemap? → **YES** — a percentage breakdown table is actionable even without pixel-level visualization.

**Verdict: VIABLE WITH LIMITATIONS**

The Ink-based visual treemap from CC cannot be replicated. The plugin outputs a markdown table with estimated token counts and percentage breakdown. This is still useful for understanding context window pressure.

**Implementation Proposal:**

**Architecture:**

```
[command: /context] →
    read last intercepted request state
    estimate token counts per category
    read last response usage (cache hits)
    render markdown table + warnings

[middleware — request] → snapshot request state for inspection
[middleware — response] → capture usage fields from stream
```

**Sample Output (markdown):**

```markdown
## Context Window: claude-opus-4-6 (200K)

| Category             | Tokens (est.) | % Used    | Cached |
| -------------------- | ------------- | --------- | ------ |
| System prompt        | 2,847         | 1.4%      | ✓ (1h) |
| Tool definitions     | 8,234         | 4.1%      | ✓      |
| Conversation (user)  | 12,451        | 6.2%      | ✗      |
| Conversation (asst)  | 31,892        | 16.0%     | ✗      |
| **Total in-context** | **55,424**    | **27.7%** |        |
| Remaining budget     | 144,576       | 72.3%     |        |

Cache efficiency: 38.4% of tokens served from cache (last turn)
⚠ Tool definitions are large (8.2K tokens). Consider deferred tool loading.
```

**Plugin API Usage:**

- `middleware()` — snapshot request body, tee response stream for usage
- `command()` — `/context [full|summary|cache]`

**Storage Strategy:** In-memory only. No persistence needed; state is per-turn.

**Config Schema:**

```json
{
  "context_inspector": {
    "enabled": true,
    "warn_threshold_pct": 75,
    "show_cache_breakdown": true
  }
}
```

**Estimated Effort:** 2–3 days  
**Dependencies:** None. Fully standalone. Works with any provider.

**Risks & Mitigations:**

| Risk                                                  | Likelihood | Impact | Mitigation                                    |
| ----------------------------------------------------- | ---------- | ------ | --------------------------------------------- |
| Token estimates mislead user                          | High       | Low    | Clear "estimated" label on all counts         |
| State stale if `/context` called before first request | Low        | Low    | Show "No data yet" message                    |
| Large message arrays slow inspection                  | Low        | Low    | Compute on-demand, not continuously           |
| Cache data only available for Anthropic               | Medium     | Low    | Hide cache column for non-Anthropic providers |

---

### 3.3 `opencode-cost-tracker`

**Concept:** Persistent cost tracking across sessions. Per-project and per-model budget tracking with configurable alerts. Weekly/monthly usage reports. Multi-provider pricing tables (Anthropic, OpenAI, Google). CSV export.

**CC Source Reference:**

- `cost-tracker.ts` — 323 lines. Session-level accumulator with persistence.
- `modelCost.ts` — 231 lines. Per-model pricing table with input/output/cache token rates.

**Pre-Flight Feasibility Check:**

1. Can middleware read usage from streaming responses? → **YES** — via stream tee, reads `usage` from `message_delta` SSE events. Plan A already does this.
2. Can the plugin persist data across sessions? → **YES** — JSON file to `~/.config/opencode/cost-tracker.json`.
3. Can the plugin access model ID and provider to apply correct pricing? → **YES** — available in middleware context.
4. Is there a mechanism to alert on budget thresholds? → **YES** — via `toast()` notifications. Can check threshold on each request completion.
5. Can the plugin generate reports via slash command? → **YES** — markdown formatted output from `/cost` command.
6. Can the plugin export to CSV? → **YES** — write a CSV file to disk, report path in command output.
7. Does it need provider-specific pricing tables? → **YES** — pricing must be hardcoded and manually maintained. No live pricing API.
8. Is there overlap with Plan A? → **YES** — Plan A A6 includes a cost accumulator toast. B3 is strictly a superset with persistence and budget controls.

**Verdict: VIABLE**

This is the most straightforward of the 7 plugins. All required capabilities are available in the plugin API. The main ongoing burden is keeping the pricing table updated when providers change rates.

**Implementation Proposal:**

**Architecture:**

```
[middleware — response] →
    tee SSE stream
    extract: model, provider, usage.input_tokens,
             usage.output_tokens, usage.cache_read_input_tokens
    apply pricing → compute turn cost
    append to session ledger → check budget alert

[command: /cost] → subcommands: show, report, budget, export, reset
```

**Key Components:**

- `PricingTable` — hardcoded rates for Anthropic, OpenAI, Google (in $/M tokens). Versioned with `lastUpdated` field.
- `CostLedger` — append-only log: `{timestamp, model, provider, project, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUSD}[]`
- `BudgetTracker` — per-project and global budget thresholds; fires toast on 80% and 100% breach
- `ReportGenerator` — aggregates ledger by day/week/month, formats markdown table and CSV

**Plugin API Usage:**

- `middleware()` — intercept responses, tee stream, extract usage
- `command()` — `/cost [show|report|budget|export|reset]`
- `hook('init')` — load persisted ledger, check if budget was already exceeded
- `toast()` — budget threshold alerts

**Data Flow:**

```
SSE stream → tee → [OpenCode sees original]
                 → [plugin reads] → parse usage fields
                                 → compute cost (tokens × rate)
                                 → append to ledger JSON
                                 → check budget threshold
                                 → toast if threshold breached
```

**Storage Strategy:**

- `~/.config/opencode/cost-tracker.json` — global ledger (append-only, rotated monthly)
- `~/.config/opencode/cost-tracker-config.json` — budgets, settings

**Pricing Table Maintenance:** Semver the pricing data. When rates change, increment version and document in changelog.

**Sample Pricing Table:**

```js
const PRICING = {
  "claude-opus-4-6": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 }, // per M tokens
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  "gpt-4o": { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: null },
  "gemini-2.0-flash": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: null },
};
```

**Config Schema:**

```json
{
  "cost_tracker": {
    "enabled": true,
    "alert_threshold_usd": 10.0,
    "budget_daily_usd": null,
    "budget_monthly_usd": null,
    "per_project_budgets": {},
    "export_dir": "~/.config/opencode/reports/"
  }
}
```

**Sample `/cost show` Output:**

```markdown
## Cost Summary

**Session:** $0.43  
**Today:** $2.17  
**This month:** $34.82 / $50.00 budget (69.6%)

| Model             | Turns | Input Tokens | Output Tokens | Cost  |
| ----------------- | ----- | ------------ | ------------- | ----- |
| claude-opus-4-6   | 12    | 145,230      | 23,840        | $2.99 |
| claude-sonnet-4-6 | 34    | 287,100      | 51,200        | $1.63 |

Cache savings this month: $8.24 (from 22.1M cache read tokens)
```

**Estimated Effort:** 3–4 days  
**Dependencies:** None. Fully standalone. Works with any provider.

**Risks & Mitigations:**

| Risk                                       | Likelihood | Impact | Mitigation                                                    |
| ------------------------------------------ | ---------- | ------ | ------------------------------------------------------------- |
| Pricing table becomes stale                | High       | Medium | Version table, warn if `lastUpdated` > 90 days                |
| Ledger grows too large                     | Low        | Low    | Monthly rotation; configurable max size                       |
| Plan A already tracks session cost         | Medium     | Low    | B3 is persistent + multi-session; Plan A is per-session toast |
| Missing pricing for new models             | High       | Low    | Default to nearest known model, log warning                   |
| OpenCode restarts lose in-progress session | Low        | Low    | Flush ledger on each turn, not on exit                        |

---

### 3.4 `opencode-hook-system`

**Concept:** Event-driven hooks for extensibility: pre/post tool use, file changed, session start/end, context compaction, idle detection. JSON/script matchers let external scripts react to events.

**CC Source Reference:**

- `hooks.ts` — 5,022 lines. 20+ event types. Glob and command pattern matchers. Shell script execution. Per-event timeout management.

**Pre-Flight Feasibility Check:**

1. Can a plugin create new hook event types that other plugins subscribe to? → **NO** — the plugin API provides hooks for plugins to consume; there is no pub/sub mechanism between plugins.
2. Can a plugin intercept tool execution? → **NO** — tool calls happen inside OpenCode's agent loop, invisible to middleware.
3. Can a plugin detect "session start"? → **YES** — `hook('init')`.
4. Can a plugin detect file changes? → **NO** — no fs watcher hook in plugin API.
5. Can a plugin execute external shell scripts in response to events? → **PARTIAL** — can use `node:child_process` but only within the plugin's own event handlers, not on behalf of other consumers.
6. Can a plugin detect idleness? → **NO** — no idle detection hook.
7. Is the CC hooks system replicate-able as a plugin? → **NO** — it fundamentally requires intercepting events that occur inside OpenCode's core.

**Verdict: NOT VIABLE AS PLUGIN**

The CC hook system requires the ability to (1) intercept tool calls, (2) publish events that external consumers can subscribe to, and (3) react to internal agent loop state changes. None of these are possible from the fetch-interceptor layer.

**Alternative Path:**

This is a **core OpenCode contribution opportunity**, not a plugin opportunity.

What OpenCode core would need to add:

1. A plugin-accessible event bus: `pluginContext.events.emit(type, data)` / `pluginContext.events.on(type, handler)`
2. Pre/post tool execution hooks: `hook('tool:before', handler)` / `hook('tool:after', handler)`
3. Session lifecycle events: `hook('session:start')`, `hook('session:end')`, `hook('session:compact')`
4. Idle detection event: `hook('session:idle', { thresholdMs })`

**Fallback approach (partial value today):** A plugin can implement a _reduced_ hook system that fires on the events it can observe:

- `hook('init')` → session start
- Infer "post-request" from middleware response handler
- No tool interception, no idle detection, no file watching

This reduced version covers ~15% of CC's hook functionality. Not worth a standalone package at this scope.

**Risks & Mitigations:** N/A — blocked on core.

---

### 3.5 `opencode-permission-guard`

**Concept:** Rule-based command safety layer. Detects destructive bash commands via AST parsing. Path-based access control lists. Auto-approves safe read operations. Requires explicit confirmation for writes and deletes.

**CC Source Reference:**

- `bash.ts` — 1,144 lines. Shell command AST parser (handles pipes, redirects, subshells, command substitution). Dangerous command detection with configurable severity.
- `permissions.ts` — 441 lines. Rule-based ACL engine. Glob matchers for path-based allow/deny. Per-session and per-project permission scopes.

**Pre-Flight Feasibility Check:**

1. Can middleware intercept tool execution requests? → **NO** — tool calls (including bash execution) are handled inside OpenCode's agent loop. The middleware layer sees API requests to `/v1/messages`, not individual tool invocations.
2. Can a plugin intercept the model's tool-use response before OpenCode executes it? → **NO** — the model responds with a `tool_use` block, OpenCode reads it from the stream and executes the tool. There is no interception point between "model decides to run bash" and "bash runs."
3. Could middleware inspect the response stream for `tool_use` blocks? → **PARTIAL** — technically yes (via stream tee), but by the time the plugin reads the `tool_use` block from the stream, OpenCode is simultaneously executing the tool. There is no mechanism to pause execution while the plugin evaluates safety.
4. Could a plugin register a `bash` tool that wraps the real bash tool? → **NO** — tool registration via `tool()` adds new tools but cannot shadow OpenCode's built-in tools.
5. Is there any hook that fires before tool execution? → **NO** — not exposed in the plugin API.

**Verdict: NOT VIABLE AS PLUGIN**

Permission guarding requires interception between the model's decision and the tool's execution. This is architecturally impossible from the middleware layer. The middleware sees the API call as a whole unit; it cannot pause in the middle of a streaming response to block a specific tool call.

**Alternative Path:**

This is the most important **core OpenCode contribution** of the 7. OpenCode core would need to add:

1. `hook('tool:before', { tool, args, session })` — async hook that can return a `{ allow: true }` or `{ allow: false, reason: string }` decision.
2. A confirmation UI primitive (e.g., `pluginContext.confirm(message)`) that the hook can call to prompt the user before allowing execution.
3. A rule engine integration point where plugins can register path matchers and command patterns.

With those three additions, a full permission guard plugin becomes viable. Without them, it's impossible.

**Risks & Mitigations:** N/A — blocked on core.

---

### 3.6 `opencode-prompt-cache-optimizer`

**Concept:** Dedicated cache optimization layer. Schema fingerprinting to detect when system prompt changes break cache. Cache hit rate tracking and trend analysis. Proactive suggestions for improving cache efficiency (e.g., stable vs. unstable blocks, cache placement strategy).

**CC Source Reference:**

- `promptCacheBreakDetection.ts` — 727 lines. Computes fingerprints of cacheable blocks. Detects structural changes that invalidate the cache. Tracks hit rate per session. Emits warnings when cache efficiency drops below threshold.

**Pre-Flight Feasibility Check:**

1. Can middleware compute fingerprints of system prompt blocks? → **YES** — full `body.system` available.
2. Can middleware track cache hit rates from response usage? → **YES** — via stream tee, reads `cache_read_input_tokens`.
3. Can the plugin suggest cache improvements? → **YES** — via markdown output in slash command or toast.
4. Is there significant overlap with Plan A? → **YES (SIGNIFICANT)** — Plan A feature A5 already implements: cache_control placement, 1h TTL, runtime auto-disable, cache hit rate tracking with configurable warning threshold, and the dynamic boundary marker (opt-in). The core functionality of B6 is substantially covered.
5. Does B6 add meaningful value beyond Plan A A5? → **PARTIAL** — schema fingerprinting (detecting which block changed) and structured improvement suggestions are not in Plan A.
6. Is a standalone package the right delivery vehicle? → **NO** — the incremental value over Plan A is too small to justify a separate package install and maintenance burden.

**Verdict: VIABLE WITH LIMITATIONS — BUT BETTER AS PLAN A ENHANCEMENT**

The standalone plugin is technically buildable but strategically wrong. The unique value (fingerprinting + suggestions) should be added to Plan A's existing cache optimization code, not extracted into a separate package.

**Alternative Path (recommended):**

Implement as two additions to `opencode-anthropic-fix`:

1. `CacheFingerprinter` — SHA-256 fingerprint of each system block. Detects when a block changes between turns (the change that broke the cache). Logs which block changed.
2. `/anthropic cache` command — shows cache efficiency trend and the specific blocks that broke cache in the last N turns.

This delivers all unique value without requiring users to install and configure a second package.

**If built as a standalone anyway (discouraged):**  
Estimated Effort: 2–3 days | Dependencies: Requires access to system prompt content (only available if the target provider sends it through the fetch layer, which Anthropic does but others may not)

**Risks & Mitigations:**

| Risk                                     | Likelihood | Impact | Mitigation                              |
| ---------------------------------------- | ---------- | ------ | --------------------------------------- |
| Duplicates Plan A A5 entirely            | High       | Medium | Don't build standalone; enhance Plan A  |
| Anthropic-only cache semantics           | High       | Low    | Guard behind Anthropic provider check   |
| Fingerprinting adds per-request CPU cost | Low        | Low    | SHA-256 on strings < 50KB is negligible |

---

### 3.7 `opencode-speculation`

**Concept:** Speculatively prefetch the next response while the user is reading the current one. Uses a forked API request with the predicted next user message. If the user's actual next message matches the prediction, the pre-fetched response is served immediately (zero latency).

**CC Source Reference:**

- Claude Code's forked agent pattern, speculative request management.
- CC implementation uses internal agent loop control to fork a parallel execution path and cancel on mismatch.

**Pre-Flight Feasibility Check:**

1. Can the plugin make a speculative API call? → **YES** — via fetch to `/v1/messages`.
2. Can the plugin predict the user's next message? → **NO** — this requires either (a) asking the model to predict the next user message (another API call, higher cost) or (b) using a heuristic that will have very low accuracy.
3. If prediction is wrong (expected: >95% of the time), are the speculative tokens wasted? → **YES** — the speculative request completes and its output is discarded. Real tokens consumed, real cost paid by the user.
4. Can the plugin cancel an in-flight speculative request if the prediction mismatches? → **YES** — `AbortController` works.
5. Can the plugin intercept OpenCode's response delivery to substitute the pre-fetched response? → **NO** — there is no mechanism to inject a pre-computed response into the conversation flow. The middleware can modify requests before they're sent; it cannot substitute a stored response for a live request.
6. Can the plugin hold the next request until the speculative response is ready? → **NO** — middleware cannot pause request processing.
7. Does this impose costs on the user with uncertain benefit? → **YES** — every speculative call costs real money. Expected savings only materialize when prediction matches, which requires either model-based prediction (adds cost) or heuristic prediction (low match rate).
8. Does this risk exceeding rate limits? → **YES** — doubles the request rate, consuming 2x quota on every turn.

**Verdict: NOT VIABLE AS PLUGIN**

Even setting aside the plugin API limitations, the risk/reward calculus is poor:

- Cannot substitute a pre-fetched response into the conversation (blocked by API)
- Cannot hold live requests until speculative result is ready (no flow control)
- High cost exposure with uncertain benefit
- Rate limit doubling creates a new failure mode

In CC, speculation works because it has full control over the agent loop — it can actually swap in the speculative result. A plugin only has fetch interception, which operates at the request level, not the conversation flow level.

**Alternative Path:**

There is no useful partial implementation. The value proposition (instant response if prediction matches) requires response substitution, which the plugin API cannot do. A plugin that fires speculative calls it can never use is strictly harmful.

If OpenCode adds a `hook('request:before', { session, history })` that can return a pre-computed response, speculation becomes viable. Until then: skip.

---

## 4. Prioritization Matrix

| Plugin                 | Feasibility (1-5) | Impact (1-5) | Effort (days) | Standalone Worthy | Dependencies          | Order                |
| ---------------------- | ----------------- | ------------ | ------------- | ----------------- | --------------------- | -------------------- |
| B3 `cost-tracker`      | 5                 | 5            | 3–4           | ✓                 | None                  | **1**                |
| B2 `context-inspector` | 4                 | 3            | 2–3           | ✓                 | None                  | **2**                |
| B1 `session-memory`    | 3                 | 4            | 4–6           | ✓                 | Auth token access     | **3**                |
| B6 `cache-optimizer`   | 4                 | 2            | 2–3           | ✗ (Plan A)        | Anthropic-only        | **4 (as Plan A PR)** |
| B4 `hook-system`       | 1                 | 5            | N/A           | ✗ (core)          | OpenCode core API     | Defer                |
| B5 `permission-guard`  | 1                 | 5            | N/A           | ✗ (core)          | OpenCode core API     | Defer                |
| B7 `speculation`       | 1                 | 3            | N/A           | ✗                 | OpenCode flow control | Reject               |

**Feasibility score:** 5 = fully viable, 1 = blocked on core changes  
**Impact score:** 5 = high daily-use value for most users, 1 = niche or marginal

---

## 5. Recommended Implementation Roadmap

### Wave 1 (Weeks 1–2): Provider-Agnostic Utilities

**B3 `opencode-cost-tracker`** (3–4 days)

Most straightforward plugin with highest daily utility. Builds on stream-tee pattern already proven in Plan A. Zero dependencies. Ships as `opencode-cost-tracker` on npm.

Deliverables:

- `index.mjs` — middleware + command registration
- `lib/pricing.mjs` — pricing table with `lastUpdated` versioning
- `lib/ledger.mjs` — append-only JSON ledger with monthly rotation
- `lib/reports.mjs` — markdown/CSV report generation
- `README.md` — setup and configuration
- Full test suite (>90% coverage)

**B2 `opencode-context-inspector`** (2–3 days, can overlap with B3)

Lower effort, ships in same wave. Good companion to B3 — both are "observability" plugins.

Deliverables:

- `index.mjs` — middleware snapshot + command registration
- `lib/estimator.mjs` — token estimation with explicit uncertainty markers
- `/context` slash command with `full`, `summary`, `cache` subcommands

### Wave 2 (Weeks 3–5): AI-Assisted Memory

**B1 `opencode-session-memory`** (4–6 days)

Requires auth token access. Needs careful design to avoid excessive API costs and accidental data leakage. Ships only after B3 is live (can borrow token-counting from B3's middleware pattern).

Deliverables:

- `index.mjs` — middleware injection + command + tool registration
- `lib/extractor.mjs` — extraction prompt construction and LLM call
- `lib/store.mjs` — per-project markdown persistence
- `/memory` slash command
- `memory_extract` tool (model-callable)
- Cost accounting integration (uses B3 if present, own counter if not)

### Wave 3 (Ongoing): Plan A Enhancement

**B6 `cache-optimizer` → Plan A PR** (2–3 days)

Not a new package. Open a PR to `opencode-anthropic-fix` adding:

- `CacheFingerprinter` class in `lib/cache.mjs`
- `/anthropic cache` command showing per-block change history
- Integration with existing A5 cache hit rate tracking

### Deferred (Waiting on OpenCode Core)

**B4 `hook-system`** and **B5 `permission-guard`** are formally deferred pending three specific OpenCode core additions:

1. Pre/post tool execution hooks
2. Plugin-accessible event bus
3. Confirmation UI primitive

File these as OpenCode GitHub issues with the specific API shape needed (see Section 6).

**B7 `speculation`** is rejected. No plugin-viable path exists, and the risk profile is poor even if it were.

---

## 6. Plugins That Need OpenCode Core Changes

The following capabilities, if added to OpenCode core, would unlock two high-value plugins (B4, B5) that are currently impossible:

### 6.1 Pre/Post Tool Execution Hooks (Unlocks B5)

**Proposed API:**

```ts
// In @opencode-ai/plugin
hook("tool:before", async (ctx: ToolContext) => {
  // ctx.tool: string (tool name, e.g. "bash")
  // ctx.args: Record<string, unknown>
  // ctx.session: SessionInfo
  // Return: { proceed: true } | { proceed: false; reason: string }
  return { proceed: true };
});

hook("tool:after", async (ctx: ToolResultContext) => {
  // ctx.tool, ctx.args, ctx.result, ctx.durationMs
});
```

**Use case:** Permission guard, audit logging, rate-limiting tool executions.

### 6.2 Plugin Event Bus (Unlocks B4)

**Proposed API:**

```ts
// Emit events that other plugins can subscribe to
pluginContext.events.emit('my-plugin:event', data);

// Subscribe to events from other plugins or OpenCode core
pluginContext.events.on('opencode:compact', (ctx) => { ... });
pluginContext.events.on('opencode:idle', (ctx) => { ... });
```

**Use case:** Decoupled plugin orchestration. B4 hook system pattern.

### 6.3 Confirmation UI Primitive (Unlocks B5)

**Proposed API:**

```ts
// Show a yes/no prompt in OpenCode's UI before proceeding
const allowed = await pluginContext.confirm({
  title: "Destructive command detected",
  body: `bash: \`rm -rf ./dist\`\n\nAllow execution?`,
  defaultValue: false,
});
```

**Use case:** Permission guard confirmation dialogs.

### 6.4 Pre-Computed Response Injection (Unlocks B7 if speculation becomes viable)

Not recommended for now. If OpenCode ever adds this, revisit B7. But given the cost and complexity arguments against speculation, this should be low priority even for OpenCode core.

**Contribution strategy:** File GitHub issues in `opencode-ai/opencode` for 6.1, 6.2, and 6.3. These are additive APIs that don't break existing plugins. 6.1 (tool hooks) is the highest value — even one use case (permission guard) justifies it.

---

## 7. Overlap Analysis with Plan A

Plan A refers to the 6 features in `docs/plans/2026-03-21-five-features-design.md` implemented within `opencode-anthropic-fix`:

- **A1:** Auto-compaction enhancement (injects context at compaction)
- **A2:** Predictive rate limit avoidance
- **A3:** Deferred tool loading (opt-in)
- **A4:** Multi-layer retry with graceful degradation
- **A5:** Cache breakpoint optimization (cache_control placement, 1h TTL, hit rate tracking)
- **A6:** Toast improvements (token usage, cost accumulator, rate limit, context window)

### Overlap Map

| Plan B Plugin          | Overlaps With                                  | Nature                                                                                               | Recommendation                                                                                    |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| B1 `session-memory`    | A1 (compaction context injection)              | **Complementary** — A1 injects context _at compaction_; B1 persists summaries _across_ compactions   | Build B1. No conflict. Consider B1 injecting before A1's compaction hook.                         |
| B2 `context-inspector` | A5 (token tracking), A6 (context window toast) | **Partial overlap** — A6 toasts context % as a notification; B2 gives on-demand detail view          | Build B2. Different UX surface. B2 can consume token data already tracked by A5/A6.               |
| B3 `cost-tracker`      | A6 (cost accumulator toast)                    | **Superset** — A6 shows per-session toast; B3 adds persistence, budgets, multi-session reporting     | Build B3. If both present, B3 should suppress A6's cost toast to avoid duplication (config flag). |
| B6 `cache-optimizer`   | A5 (cache optimization)                        | **Near-duplicate** — A5 covers the core mechanism; B6's unique value (fingerprinting) is incremental | Do NOT build B6 as standalone. Merge fingerprinting into A5 as a Plan A enhancement.              |
| B4 `hook-system`       | None in Plan A                                 | No overlap                                                                                           | Deferred (core blocker)                                                                           |
| B5 `permission-guard`  | None in Plan A                                 | No overlap                                                                                           | Deferred (core blocker)                                                                           |
| B7 `speculation`       | None in Plan A                                 | No overlap                                                                                           | Rejected                                                                                          |

### Synergy Opportunities

1. **B3 + Plan A token tracking:** Plan A already tracks cumulative tokens per session via middleware. B3 can read from this shared state rather than re-implementing stream tee independently. Consider exposing Plan A's token state as a module export.

2. **B2 + Plan A cache data:** B2's context inspector `/context cache` view can display Plan A's cache hit rate data (already tracked in Plan A's session state). B2 should check whether Plan A is loaded and read its state if available, falling back to its own stream tee if not.

3. **B1 + Plan A compaction hook:** Plan A hooks `experimental.session.compacting`. B1 can use the same event to trigger memory extraction before compaction flattens the context.

### Conflict Points

1. **B3 cost toast vs. A6 cost toast:** If a user installs both `opencode-anthropic-fix` (A6) and `opencode-cost-tracker` (B3), they'll see two cost toasts per turn. B3 should detect Plan A's presence and suppress its own toast if A6 is active, or Plan A should expose a config flag `usage_toast: false` to let B3 take over.

2. **B2 token estimates vs. A6 token toast:** A6's token toast uses exact counts from the API response. B2's inspector uses estimates from message sizes. If both are displayed in the same session, the user may see inconsistent numbers. B2 should use A6's exact counts when available and only estimate when Plan A is absent.

---

_Document end. Total: 7 plugins assessed, 3 viable standalone packages recommended (B3, B2, B1), 1 Plan A enhancement (B6), 2 OpenCode core contributions scoped (B4, B5), 1 rejected (B7)._
