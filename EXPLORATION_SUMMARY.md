# OpenCode Anthropic Fix - Codebase Exploration Summary

## Project Overview

**Name:** `opencode-anthropic-fix`  
**Version:** 0.0.41  
**License:** GPL-3.0-or-later  
**Purpose:** OAuth-based multi-account Anthropic API plugin for OpenCode that emulates Claude Code's signature to enable using Claude Pro/Max subscriptions

### What This Project Does

This is an OpenCode plugin that:

1. Provides OAuth login flows for Anthropic Claude accounts (Claude Pro/Max)
2. Manages multiple accounts with automatic rotation when rate limits are hit
3. Emulates Claude Code's HTTP signature (headers, system prompts, beta flags)
4. Handles tool use/tool result message pairing and protocol
5. Provides a standalone CLI for account management (`opencode-anthropic-auth`)
6. Includes 680+ tests across 26 test files for deep conformance validation

---

## Directory Structure

```
opencode-anthropic-fix/
├── index.mjs                      # Main plugin entry point (6777 lines)
├── index.test.mjs                 # Main plugin tests (~5000+ lines)
├── cli.mjs                        # CLI entry point
├── cli.test.mjs                   # CLI tests
├── lib/
│   ├── accounts.mjs               # Account manager (selection, rotation, state)
│   ├── account-state.mjs          # OAuth credential application & tracking
│   ├── oauth.mjs                  # OAuth authorization & token exchange
│   ├── storage.mjs                # File I/O for config & accounts
│   ├── config.mjs                 # Configuration management
│   ├── backoff.mjs                # Retry logic, error classification
│   ├── rotation.mjs               # Account selection strategies
│   ├── cc-credentials.mjs         # Claude Code signature data
│   ├── refresh-lock.mjs           # Token refresh concurrency control
│   └── *.test.mjs                 # Tests for each module
├── test/
│   ├── conformance/               # Regression tests (40+ tests)
│   ├── phase1/                    # Feature phase tests
│   ├── phase2/
│   ├── phase3/
│   ├── phase4/
│   └── helpers/                   # Test fixtures
├── docs/
│   ├── mimese-http-header-system-prompt.md    # Full HTTP/system prompt analysis
│   ├── claude-code-reverse-engineering.md     # Reverse engineering details
│   └── *.md                       # Architecture & planning docs
├── scripts/
│   ├── build.mjs                  # esbuild bundler for release
│   └── install.mjs                # Installation symlink/copy
└── package.json
```

---

## Key Message Handling: Tool Use & Tool Result

### 1. **Message Array Structure & Validation**

Located in `index.mjs` around **lines 6100-6160**:

```javascript
// Strip mcp_ prefixes from tool_use blocks in outgoing messages
if (parsed.messages && Array.isArray(parsed.messages)) {
  parsed.messages = parsed.messages.map((msg) => {
    if (msg.content && Array.isArray(msg.content)) {
      msg.content = msg.content.map((block) => {
        if (block.type === "tool_use" && block.name) {
          return {
            ...block,
            name: `${TOOL_PREFIX}${block.name}`, // Add "mcp_" prefix for routing
          };
        }
        return block;
      });
    }
    return msg;
  });
}
```

### 2. **Tool Use Block Detection & Tool Result Synthesis**

Located in `index.mjs` around **lines 6133-6160** & **lines 2940-2962**:

**Problem:** When OpenCode reconstructs messages for overflow recovery or context trimming, the message array might end with an assistant message containing `tool_use` blocks. The API rejects this as "assistant message prefill."

**Solution:** Synthesize `tool_result` responses:

```javascript
// Guard: ensure messages array never ends with an assistant message.
if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
  const lastMsg = parsed.messages[parsed.messages.length - 1];
  if (lastMsg && lastMsg.role === "assistant") {
    const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [];
    const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length > 0) {
      // Synthesize tool_result for each pending tool_use
      parsed.messages.push({
        role: "user",
        content: toolUseBlocks.map((tu) => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "[Result unavailable — conversation was restructured]",
        })),
      });
    } else {
      parsed.messages.push({
        role: "user",
        content: [{ type: "text", text: "Continue." }],
      });
    }
  }
}
```

### 3. **Message Filtering: Slash Commands**

Located in `index.mjs` around **lines 4742-4811**:

Removes leaked `/anthropic` slash command messages from conversation history before sending to the API:

```javascript
function stripSlashCommandMessages(messages) {
  // Pattern: /anthropic followed by optional subcommand
  const CMD_RE = /^\s*\/anthropic\b/i;
  // Pattern: ▣ Anthropic — prefix used by all sendCommandMessage outputs
  const RESP_RE = /^▣\s*Anthropic/;

  // ... filters out command messages and their responses ...

  // Safety: if filtering removed ALL messages, return the original
  if (filtered.length === 0) return messages;
  return filtered;
}
```

### 4. **Token Count Analysis**

Located in `index.mjs` around **lines 4140-4250**:

Analyzes message structure for token budgeting:

```javascript
else if (block.type === "tool_result" && typeof block.content === "string") {
  tokens += estimateTokens(block.content);
} else if (block.type === "tool_use") {
  // tool_use blocks have JSON input, estimate it
  ...
}

// Group by tool_name (may be on the block or need to look up from tool_use_id)
else if (block.type === "tool_use") {
  // tool_use is part of assistant turn, accumulate into assistantTokens
}
```

---

## Fetch Interceptor & Message Construction

### Main Entry Point

**Location:** `index.mjs` lines **2299-3200+**

The core `fetch` interceptor is part of the plugin hook configuration. It intercepts ALL fetch calls to the Anthropic API and:

1. **Selects an account** (based on strategy: sticky, round-robin, hybrid)
2. **Refreshes OAuth token** if expired
3. **Transforms request URL** (adds `?beta=true` to `/v1/messages`)
4. **Transforms request body** (lines 2645+):
   - Strips slash command messages
   - Adds `mcp_` prefix to tool_use blocks
   - Injects system prompt & signature headers
   - Adds betas to `anthropic-beta` header
   - Handles overflow recovery
   - Ensures message array never ends with assistant message
5. **Handles response** (lines 6300+):
   - Strips `mcp_` prefix from SSE events
   - Extracts token usage stats
   - Detects account-specific errors

### Request Body Transformation

**Function:** `transformRequestBody()` at **lines 5900-6166**

```javascript
function transformRequestBody(body, signature, requestUrl, context = {}) {
  try {
    const parsed = JSON.parse(body);

    // 1. Add mcp_ prefix to tool_use blocks in messages
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === "tool_use" && block.name) {
              return {
                ...block,
                name: `${TOOL_PREFIX}${block.name}`,
              };
            }
            return block;
          });
        }
        return msg;
      });
    }

    // 2. Guard: ensure messages array never ends with assistant message
    if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");
        if (toolUseBlocks.length > 0) {
          parsed.messages.push({
            role: "user",
            content: toolUseBlocks.map((tu) => ({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "[Result unavailable — conversation was restructured]",
            })),
          });
        } else {
          parsed.messages.push({
            role: "user",
            content: [{ type: "text", text: "Continue." }],
          });
        }
      }
    }

    return JSON.stringify(parsed);
  } catch {
    return body; // If parse fails, return original body
  }
}
```

---

## Response Handling & SSE Streaming

### Tool Use Prefix Stripping in Streaming Responses

**Function:** `stripMcpPrefixFromSSE()` at **lines 6309-6367**

The API returns tool names prefixed with `mcp_` (e.g., `mcp_read_file`) in the streaming response. This function strips that prefix from SSE events in real-time:

```javascript
/**
 * Strip `mcp_` prefix from tool_use `name` fields in SSE data lines.
 * Handles:
 * - content_block_start: { content_block: { type: "tool_use", name: "mcp_..." } }
 * - message_start: { message: { content: [{ type: "tool_use", name: "mcp_..." }] } }
 * - Top-level content arrays
 */
function stripMcpPrefixFromSSE(text) {
  return text.replace(/^data:\s*(.+)$/gm, (_match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (stripMcpPrefixFromParsedEvent(parsed)) {
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
      // Not valid JSON — pass through unchanged.
    }
    return _match;
  });
}

function stripMcpPrefixFromParsedEvent(parsed) {
  // Mutate parsed SSE event, removing mcp_ prefix from tool_use.name
  // Returns true if modified
  ...
}
```

### Response Wrapping & Usage Extraction

**Function:** `transformResponse()` at **lines 6381-6500+**

Wraps the response body stream to:

1. Parse SSE events and extract token usage stats
2. Call `onUsage` callback with final usage numbers
3. Detect mid-stream account-specific errors via `getMidStreamAccountError()`
4. Rewrite SSE data lines to strip `mcp_` prefixes

---

## Error Handling for Tool Calls

### Error Classification

**Module:** `lib/backoff.mjs`

Key functions:

- `isAccountSpecificError(status, body)` — Determines if error is per-account (401, 403, 429) vs service-wide (529, 503)
- `parseRateLimitReason(body)` — Extracts rate limit reason from error response
- `getMidStreamAccountError(parsed)` — Detects account errors in streaming responses

### Mid-Stream Error Detection

**Location:** `index.mjs` around **lines 2427-2435**

```javascript
if (onAccountError && !accountErrorHandled) {
  const details = getMidStreamAccountError(parsed);
  if (details) {
    accountErrorHandled = true;
    onAccountError(details); // Mark account for next request
  }
}
```

### Retry Logic

**Location:** `index.mjs` around **lines 2382-2400**

```javascript
let serviceWideRetryCount = 0; // Track 529/503 retries (max 2)
let shouldRetryCount = 0; // Track x-should-retry forced retries (max 3)
let consecutive529Count = 0;

// Classify request for retry budget
const requestClass = classifyApiRequest(requestInit.body);
const maxServiceRetries = requestClass === "background" ? 0 : 2;
const maxShouldRetries = requestClass === "background" ? 1 : 3;

// Per-request retry loop (tries each account at most once)
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  // ... select account, make request, handle errors ...
}
```

---

## Key Files for Message Handling

| File               | Lines      | Purpose                                                             |
| ------------------ | ---------- | ------------------------------------------------------------------- |
| `index.mjs`        | 4742-4811  | `stripSlashCommandMessages()` — Remove `/anthropic` commands        |
| `index.mjs`        | 4813-4826  | `extractFirstUserMessageText()` — Extract text for billing hash     |
| `index.mjs`        | 5900-6166  | `transformRequestBody()` — Add prefixes, synthesize tool_results    |
| `index.mjs`        | 6100-6160  | Tool use guard & assistant message prefill fix                      |
| `index.mjs`        | 6175-6198  | `transformRequestUrl()` — Add `?beta=true`                          |
| `index.mjs`        | 6209-6246  | `extractUsageFromSSEEvent()` — Parse token counts                   |
| `index.mjs`        | 6300-6367  | `stripMcpPrefixFromSSE()` — Remove `mcp_` from tool names           |
| `index.mjs`        | 6381-6500+ | `transformResponse()` — Wrap response stream                        |
| `index.mjs`        | 2299-3200+ | Main fetch interceptor (account selection, retries, error handling) |
| `lib/backoff.mjs`  | All        | Error classification, rate limit parsing, retry logic               |
| `lib/accounts.mjs` | All        | Account manager, strategy selection                                 |

---

## Message Handling Summary

### Outbound Messages

1. **Strip slash commands** — Remove `/anthropic` from history
2. **Add mcp\_ prefix** — Prefix tool names for MCP server routing
3. **Synthesize tool_results** — When restructuring messages ends with tool_use
4. **Guard assistant prefill** — Ensure no assistant message at array end
5. **Compute billing hash** — Extract first user message for signature

### Incoming Messages (Streaming)

1. **Parse SSE events** — Extract individual event blocks
2. **Extract usage stats** — Accumulate input/output/cache tokens
3. **Strip mcp\_ prefix** — Restore tool names before returning to client
4. **Detect errors** — Identify account-specific vs service-wide errors

### Error Handling

1. **Account-specific** (401, 403, 429) — Mark account, try next
2. **Service-wide** (529, 503) — Retry with exponential backoff (max 2x)
3. **Overflow** (prompt_too_long) — Auto-reduce `max_tokens`, retry
4. **Context trim** — Keep first 2 + last 2 messages, fill middle with marker
5. **Terminal errors** (invalid_grant) — Disable account, toast error

---

## Testing Structure

680+ tests across 26 files:

- **`index.test.mjs`** — 5000+ lines of fetch interceptor tests
- **`test/conformance/regression.test.mjs`** — 40+ regression tests
- **`test/phase1/`** — Feature tests (preconnect, output cap, overflow)
- **`test/phase2/`** — Context commands, cache detection
- **`test/phase3/`** — Rate limit, FG/BG classification, microcompact
- **`test/phase4/`** — Integration & edge cases
- **`lib/**/\*.test.mjs`\*\* — Unit tests for accounts, oauth, config, etc.

Each test validates message handling, tool use/result pairing, error recovery, and signature conformance.

---

## Documentation References

1. **`docs/mimese-http-header-system-prompt.md`** — Deep dive into Claude Code signature emulation
2. **`docs/claude-code-reverse-engineering.md`** — Reverse engineering analysis
3. **`README.md`** — User documentation with CLI usage, configuration, troubleshooting
4. **`AGENTS.md`** — AI agent operating rules for the repository
5. **`CONTRIBUTING.md`** — Contribution guidelines

---

## Key Concepts

### Tool Use Protocol

- **tool_use block** — Assistant's request to use a tool (has `id`, `name`, `input`)
- **tool_result block** — User's response with the tool result (has `tool_use_id`, `content`)
- **Pairing** — Each tool_use must be paired with a tool_result in the messages array
- **Prefix stripping** — Names sent as `mcp_<name>` (for routing), received as `<name>` (for display)

### Message Array Invariants

1. Messages alternate user/assistant (no two consecutive messages of same role)
2. Array must start with user message
3. Array must end with user message (never assistant)
4. Assistant messages with tool_use blocks must be followed by tool_result messages
5. Tool_result tool_use_id must match a previous tool_use id

### Error Recovery

- **Account-level** — Token refresh, rate limit tracking, health scoring
- **Request-level** — Message trimming, overflow recovery, adaptive context escalation
- **Service-level** — Exponential backoff (529/503), quota-aware switching
