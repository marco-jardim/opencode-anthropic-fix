# Future Improvements

Planned enhancements not yet implemented. Items are ordered by expected impact.

---

## 1. Deferred Tool Loading

**Status:** Designed, not implemented
**Risk:** Medium-high (modifies tool calling flow)
**Config:** `deferred_tools: { enabled: false, threshold: 15 }`

### Problem

When OpenCode has many MCP servers or custom tools, the full tool schema array
in every API request can consume thousands of system prompt tokens. Claude Code
v2.1.81 addresses this with `tengu_defer_all_bn4` (default `true`) — it sends
only tool **names** initially and loads full schemas on-demand via a built-in
`ToolSearchTool`.

### Proposed Approach

1. **Register a `tool_search` custom tool** via OpenCode's `tool()` helper from
   `@opencode-ai/plugin`. This tool accepts a query string and returns matching
   tool schemas from an in-memory cache.

2. **In `transformRequestBody()`**, when the tool count exceeds a configurable
   threshold (default 15):
   - Strip full tool schemas from `parsed.tools`
   - Store them in a session-scoped `Map<string, object>`
   - Inject a system prompt block listing tool names with one-line descriptions
   - Keep essential tools inline (e.g., `read`, `write`, `bash`, `glob`, `grep`)

3. **The `tool_search` custom tool** serves schemas from the in-memory cache:
   - `select:toolName` syntax for exact lookup (comma-separated)
   - Keyword search with fuzzy matching against name + description
   - Returns full JSON schema definitions for matched tools

### OpenCode Plugin API Support

From the [plugin docs](https://opencode.ai/docs/plugins/):

```ts
import { type Plugin, tool } from "@opencode-ai/plugin";

export const DeferredToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      tool_search: tool({
        description: "Search for available tools by name or keyword. Returns full tool schemas.",
        args: {
          query: tool.schema.string().describe("Tool name (select:name1,name2) or keyword search"),
        },
        async execute(args, context) {
          // Look up from in-memory cache populated by transformRequestBody()
          return JSON.stringify(matchTools(args.query));
        },
      }),
    },
  };
};
```

### Why It's Deferred

1. **Risk of breaking tool execution.** If the model calls a tool whose schema
   was stripped, OpenCode won't have the schema to validate arguments. The model
   must first call `tool_search` to load the schema, which changes the standard
   tool-calling flow.

2. **Double-turn overhead.** Every tool call that isn't in the inline set
   requires an extra model turn: (1) call `tool_search`, (2) call the actual
   tool. This adds latency and cost for the first use of each deferred tool.

3. **Interaction with OpenCode's tool system.** OpenCode registers tools
   server-side and expects the full schema in the request body. Stripping
   schemas at the fetch interceptor level could confuse OpenCode's tool
   execution pipeline if it validates tool calls against its own registry.

4. **Testing complexity.** Requires end-to-end testing with real MCP servers
   to verify the tool search → tool call flow works correctly. Unit tests
   can't fully validate this.

### Mitigation Strategy

- **Off by default** — opt-in via config toggle
- **Threshold-based** — only activates when tool count exceeds threshold
- **Essential tools exempt** — core tools (`read`, `write`, `bash`, `glob`,
  `grep`, `edit`) always kept inline
- **Graceful fallback** — if `tool_search` fails, include all schemas on the
  next request

### Token Savings Estimate

With 30 MCP tools averaging ~200 tokens each:

- Current: ~6,000 tokens per request in tool schemas
- Deferred: ~300 tokens (name list) + ~200 tokens per tool_search call
- Net savings: ~5,500 tokens on first turn, ~5,700 on subsequent turns
  (assuming most tools aren't called)

### Implementation Steps

1. Add `deferred_tools` to config schema and validation (`lib/config.mjs`)
2. Add in-memory tool schema cache (module-level `Map`)
3. Register `tool_search` custom tool in plugin return object
4. In `transformRequestBody()`: strip schemas when count > threshold,
   populate cache, inject name list into system prompt
5. Add config toggle via `/anthropic set deferred-tools on`
6. Add tests for tool stripping, cache population, and search matching
7. End-to-end test with MCP tools

---

## 2. Output Truncation Retry

**Status:** Designed, partially blocked
**Risk:** Low

When the model hits `max_tokens` and returns `stop_reason: "max_tokens"`,
automatically inject a continuation prompt and retry:

```
[Continue from where you left off. Resume directly — no apology, no recap.
Break remaining work into smaller pieces if needed.]
```

**Challenge:** The `stop_reason` is in the SSE stream's `message_delta` event,
which is parsed inside `transformResponse()`. By the time the stream finishes,
the fetch interceptor has already returned the response to OpenCode. Retrying
requires either:

- Buffering the full response to detect truncation before returning (breaks streaming)
- A post-response hook that injects a follow-up prompt via `client.session.prompt()`

The second approach is more viable using the `session.idle` event to detect
when a truncated response has been fully rendered, then injecting a continuation.

---

## 3. Compaction Token Budget Tracking

**Status:** Idea
**Risk:** Low

Track cumulative token usage per session and warn at configurable thresholds
(e.g., 60%, 80%, 95% of context window). Currently the plugin tracks usage
for cost estimation but doesn't compare against the model's context window
for compaction warnings.

Would require knowing the model's context window size, which is available
from `provider.models[modelId].limit.context` in the auth loader.

---

## 4. Upstream Version Auto-Sync

**Status:** Idea
**Risk:** Low

Periodically check for new `@anthropic-ai/claude-code` releases and
automatically update version constants (`FALLBACK_CLAUDE_CLI_VERSION`,
`ANTHROPIC_SDK_VERSION`, `CLI_TO_SDK_VERSION` map, `OAUTH_AXIOS_VERSION`).

Currently the plugin fetches the latest version on startup via npm registry
but only uses it for the User-Agent string. Could extend this to:

- Parse the new CLI bundle for updated constants
- Warn if local constants are stale
- Auto-update `anthropic-auth.json` with new version mappings

---

## 5. Refresh `CLAUDE_CODE_BUILD_TIME` Constant

**Status:** Cosmetic, optional
**Risk:** None
**Source:** v2.1.105 drift review (see `claude-code-reverse-engineering.md` §16, 2026-04-13 entry)

Plugin currently hardcodes `CLAUDE_CODE_BUILD_TIME = "2026-04-08T20:46:46Z"` (≈v2.1.97
era). Upstream v2.1.105 emits `2026-04-13T19:06:08Z`. The field appears to be purely
informational in observed traffic — no server-side block/accept logic has ever been
tied to it — so this is not a correctness issue, but refreshing it on the next touch
of `index.mjs` keeps the header within a reasonable drift window from the latest CC.

**Suggested follow-on:** pair the bump with an `ANTHROPIC_SDK_VERSION` / `CLI_TO_SDK_VERSION`
audit (see §4 "Upstream Version Auto-Sync" above). `x-stainless-package-version`
confirmed still `0.81.0` in 2.1.105 (no bump needed).

---

## 6. Opt-In SDK OAuth-Refresh Signal

**Status:** Idea
**Risk:** Low
**Source:** v2.1.105 drift review

v2.1.105 introduced `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` — when set, the Claude Agent
SDK stops erroring on HTTP 401s and instead calls `$.requestOAuthTokenRefresh()` on
the host. This is meaningful only if the plugin is ever embedded inside an SDK
guest context. For the current OpenCode-as-host topology, the plugin _is_ the OAuth
authority, so the env var is inert and nothing to implement.

If the plugin ever grows an "embed inside another host" mode (e.g., for MCP bridges
that want to borrow our token rotation), this is the signal to set outgoing so the
guest delegates refresh to us rather than failing loudly.

---

## 7. Monitor Future Drift Signals

**Status:** Documentation hint
**Risk:** None

The 2026-04-13 drift review identified the single most-likely-to-drift constant:

- **`x-stainless-package-version`** — currently hardcoded `"0.81.0"` in `index.mjs`.
  Stable from v2.1.97 through v2.1.105 (only the minifier identifier name changed,
  `d66` → `g86`). Re-check with a single grep on every upstream bump:

  ```bash
  rg -n '"0\.\d+\.\d+"' _tmp_claude_pkg/<version>/package/cli.js | grep -A0 -B2 'stainless'
  ```

  If it bumps, the plugin's hardcoded value must follow within a release or the
  server may fingerprint the mismatch.

Additional "cheap watch" grep targets:

- `oauth-2025-`, `claude-code-2025`, `files-api-` — new OAuth/file-upload beta flags.
- `x-app|x-service-name|anthropic-dangerous-direct-browser-access` — header set.
- `"You are Claude Code,` — identity preamble.
- `cch=|cc_version=|cc_entrypoint=` — billing-header template.
- `thinking:{type:` — nested `effort`/`budget_tokens` shape.

If any of these diverge in a future version, the plugin's mimesis must follow.

---

_Last updated: 2026-04-13 (added items 5–7 from v2.1.105 drift review)_
