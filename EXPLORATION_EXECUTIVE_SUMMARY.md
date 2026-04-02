# OpenCode Anthropic Fix - Executive Summary

**Project:** `opencode-anthropic-fix` v0.0.41  
**Purpose:** OAuth-based multi-account Anthropic Claude API plugin for OpenCode with Claude Code signature emulation  
**Language:** JavaScript (Node.js ESM)  
**Test Coverage:** 680+ tests across 26 test files  
**License:** GPL-3.0

---

## 📋 What This Project Does

This plugin enables OpenCode (a code editor extension) to use your Claude Pro/Max subscription directly via OAuth, rather than requiring an API key. Key features:

1. **Multi-account support** — Add up to 10 Claude accounts, automatic rotation on rate limits
2. **OAuth-first** — Browser-based login flows, automatic token refresh
3. **Claude Code emulation** — Mimics the real Claude Code CLI's HTTP headers and system prompts
4. **Tool use protocol** — Proper handling of the Anthropic tool_use/tool_result message pairing
5. **Error recovery** — Context overflow auto-trimming, account switching, exponential backoff
6. **Comprehensive testing** — 680+ tests validating every request/response path

---

## 🎯 Codebase Structure

### Core Files (Message Handling)

| File                    | Lines  | Purpose                                                           |
| ----------------------- | ------ | ----------------------------------------------------------------- |
| `index.mjs`             | ~6,777 | Main plugin + fetch interceptor (request/response transformation) |
| `lib/backoff.mjs`       | ~400   | Error classification, retry logic, rate limit parsing             |
| `lib/accounts.mjs`      | ~400   | Account manager, selection strategies (sticky/round-robin/hybrid) |
| `lib/oauth.mjs`         | ~400   | OAuth token exchange and refresh                                  |
| `lib/account-state.mjs` | ~300   | OAuth credential application, failure tracking                    |
| `lib/storage.mjs`       | ~200   | File I/O (config, credentials)                                    |
| `lib/config.mjs`        | ~400   | Configuration management, validation                              |
| `cli.mjs`               | ~1,000 | CLI entry point for account management                            |

### Test Files

- `index.test.mjs` — ~5,000 lines of fetch interceptor tests
- `test/conformance/regression.test.mjs` — 40+ regression tests
- `test/phase*/*.test.mjs` — Feature-specific tests (overflow, cache, rate limits, etc.)
- `lib/*.test.mjs` — Unit tests for each module

---

## 🔄 Message Handling: The Core Flow

### Outbound (Client → API)

```
Raw messages from OpenCode
         ↓
stripSlashCommandMessages()      [Remove /anthropic commands]
         ↓
Add mcp_ prefix to tool_use      [read_file → mcp_read_file]
         ↓
Guard: ensure array ends with user message
  ├─ If ends with assistant+tool_use: synthesize tool_result responses
  └─ If ends with assistant+text: append "Continue." user message
         ↓
Add system prompt & signature headers
         ↓
Compute anthropic-beta header
         ↓
Send to Anthropic API via fetch()
```

### Inbound (API → Client)

```
SSE stream from Anthropic API
         ↓
Parse SSE events (content_block_start, message_start, message_delta, etc.)
         ↓
For each event:
  ├─ Extract token usage stats (input, output, cache)
  ├─ Strip mcp_ prefix from tool_use names
  ├─ Detect mid-stream errors (account-specific vs service-wide)
  └─ Buffer & rewrite SSE lines
         ↓
Return transformed stream to OpenCode
```

---

## 🛡️ Tool Use Protocol

### The Problem

The Anthropic Messages API uses a request-response protocol:

1. **tool_use block** — Assistant says "I want to use tool X with input Y"
2. **tool_result block** — User responds with the result

The message array must maintain strict invariants:

- Messages alternate: user → assistant → user → ...
- Array must END with user (never assistant)
- Each tool_use must have a paired tool_result

### The Solution

**Outbound Transformation** (lines 6100-6160):

```javascript
// Problem: If message array ends with assistant + tool_use blocks,
// the API rejects it as "assistant message prefill"

// Solution: Synthesize tool_result responses
if (lastMsg.role === "assistant") {
  const toolUseBlocks = lastMsg.content.filter((b) => b.type === "tool_use");
  if (toolUseBlocks.length > 0) {
    // Append synthesized tool_results for each tool_use
    messages.push({
      role: "user",
      content: toolUseBlocks.map((tu) => ({
        type: "tool_result",
        tool_use_id: tu.id,
        content: "[Result unavailable — conversation was restructured]",
      })),
    });
  }
}
```

**Name Prefix Handling** (request → response):

- **Outbound:** `read_file` → `mcp_read_file` (for MCP server routing)
- **Inbound:** `mcp_read_file` → `read_file` (for client display)

---

## ⚡ Error Recovery

### Three-Level Error Handling

1. **Account-Specific** (401, 403, 429)
   - Mark account as failed
   - Try next enabled account
   - Each account tried at most once per request

2. **Service-Wide** (529, 503)
   - Exponential backoff with jitter
   - Retry up to 2 times
   - If all retries fail, return error

3. **Context Overflow** (prompt_too_long)
   - Reduce `max_tokens` automatically
   - If still too long: trim message array to first 2 + last 2 messages
   - Insert marker explaining the trim
   - Synthesize missing tool_results
   - Retry with trimmed context

### Account Selection Strategies

- **Sticky** (default) — Stay on one account until it fails
- **Round-Robin** — Rotate through accounts on every request
- **Hybrid** — Score-based selection (considers health, token budget, freshness)

---

## 📊 Key Metrics & Limits

| Metric                 | Value                  | Notes                             |
| ---------------------- | ---------------------- | --------------------------------- |
| Max accounts           | 10                     | Hard limit in UI                  |
| Health score range     | 0-100                  | Initial: 70, min usable: 50       |
| Max service retries    | 2                      | 529/503 errors only               |
| Max should-retries     | 3                      | x-should-retry header             |
| Default output cap     | 8K tokens              | Escalates to 64K after truncation |
| Context overflow check | >80% utilization       | Activates microcompact            |
| Token bucket           | 50 tokens, 6/min regen | Client-side rate limiting         |
| Failure TTL            | 3,600 seconds          | When failure count resets         |

---

## 🧪 Test Coverage

### Test Categories

| Category          | Files           | Count  | Focus                                   |
| ----------------- | --------------- | ------ | --------------------------------------- |
| Fetch interceptor | index.test.mjs  | 2,000+ | Request/response transformation, errors |
| Regression        | conformance/    | 40+    | Real-world scenarios, CLI output        |
| Overflow recovery | phase1/         | 50+    | Context trimming, max_tokens            |
| Output cap        | phase1/         | 40+    | Token escalation, reset                 |
| Context command   | phase2/         | 50+    | Message analysis, deduplication         |
| Rate limit        | phase3/         | 60+    | Proactive detection, health scoring     |
| Microcompact      | phase3/         | 30+    | Beta injection, context utilization     |
| Token budget      | phase3/         | 30+    | Expression parsing, accounting          |
| Integration       | phase4/         | 80+    | Multi-step workflows, edge cases        |
| Modules           | lib/\*.test.mjs | 300+   | OAuth, accounts, config, storage        |

Each test validates:

- ✅ Request transformation correctness
- ✅ Message array invariants
- ✅ Tool use/result pairing
- ✅ Error detection & recovery
- ✅ Header composition
- ✅ Beta flag injection
- ✅ Token counting
- ✅ Account rotation logic

---

## 🔍 Key Code Locations (Quick Reference)

### Message Handling

| What                    | Where                 |
| ----------------------- | --------------------- |
| Main fetch hook         | index.mjs:2299        |
| Strip slash commands    | index.mjs:4742        |
| Add mcp\_ prefix        | index.mjs:6104        |
| Synthesize tool_results | index.mjs:6142        |
| Guard assistant prefill | index.mjs:6133        |
| Strip mcp\_ from SSE    | index.mjs:6309        |
| Extract token usage     | index.mjs:6214        |
| Process SSE events      | index.mjs:6399        |
| Account error detection | index.mjs:6427        |
| Error classification    | lib/backoff.mjs (all) |

### Configuration & Storage

| What                | Where                 |
| ------------------- | --------------------- |
| Config loading      | lib/config.mjs        |
| Account management  | lib/accounts.mjs      |
| OAuth flow          | lib/oauth.mjs         |
| File storage        | lib/storage.mjs       |
| Token refresh logic | lib/account-state.mjs |

---

## 📦 Dependencies

- `@openauthjs/openauth@^0.4.3` — OAuth protocol implementation
- `@opencode-ai/plugin@^1.2.27` — OpenCode plugin API

Dev dependencies:

- `vitest@^4.0.18` — Test runner
- `eslint@^10.0.0` — Linting
- `prettier@^3.8.1` — Formatting
- `esbuild@^0.27.3` — Bundling for release

---

## 🚀 Installation & Usage

### For Users

```bash
# 1. Add to OpenCode config
echo 'plugins: ["opencode-anthropic-fix@latest"]' >> ~/.config/opencode/opencode.json

# 2. Restart OpenCode
opencode

# 3. Connect: Ctrl+K → Connect Provider → Anthropic → "Claude Pro/Max (multi-account)"
```

### For Developers

```bash
# Clone & install
git clone https://github.com/marco-jardim/opencode-anthropic-fix.git
cd opencode-anthropic-fix
npm install

# Run tests
npm test

# Link for development
npm run install:link

# Build for release
npm run build
```

---

## 🔐 Security & Privacy

### Account Credentials

- Stored in `~/.config/opencode/anthropic-accounts.json`
- File permissions: 0600 (owner read/write only)
- OAuth tokens (not API keys)
- Auto-excluded from git via `.gitignore`

### Message Privacy

- System prompts are compacted to reduce token usage
- Slash commands are filtered (never sent to model)
- Slash command responses are removed from history
- No telemetry by default (opt-in via config)

---

## ⚙️ Architecture Highlights

### Fetch Interception

The plugin hooks into the OpenCode request lifecycle at the fetch level:

1. Intercepts ALL fetch calls
2. Routes to either OAuth or legacy auth
3. For OAuth: transforms request → makes fetch → transforms response
4. Retry loop handles account switching & backoff

### Message Transformation Pipeline

Clean functional design with clear separation:

```
input → parse → filter → transform → guard → serialize → output
```

### Streaming Response Handling

Rather than buffering the entire response, the plugin:

1. Wraps the response reader
2. Processes SSE events as they arrive
3. Transforms each event in-place
4. Extracts usage stats incrementally
5. Detects errors mid-stream

### Error Recovery Strategy

Multi-level fallback approach:

1. Try with current configuration
2. On account error → switch account
3. On service error → exponential backoff
4. On overflow → reduce tokens or trim context
5. If all else fails → return error to user

---

## 📈 Performance Characteristics

### Time Complexity

- Message transformation: O(n) where n = message count
- Token counting: O(n × m) where m = avg blocks per message
- SSE processing: O(k) where k = stream chunks (not messages)

### Space Complexity

- Message array: O(n)
- SSE buffer: O(1) [resets per event block]
- Token stats: O(1)
- Account state: O(a) where a ≤ 10

### Optimizations

- Regex replace in SSE (batch per chunk, not per event)
- Token budget caching (computed once per request)
- Beta header latching (avoid cache busts)
- Cache TTL session latching (preserve prompts cache)

---

## 🔗 Related Documentation

- **`docs/mimese-http-header-system-prompt.md`** — Full signature emulation analysis
- **`docs/claude-code-reverse-engineering.md`** — Reverse engineering details
- **`README.md`** — User documentation, CLI reference, troubleshooting
- **`AGENTS.md`** — AI agent operating rules
- **`CONTRIBUTION.md`** — Contribution guidelines

---

## ✅ Quality Assurance

### Test Categories

- 40+ regression tests (real-world scenarios)
- 300+ unit tests (individual modules)
- 340+ feature tests (phases 1-4)

### Validation Gates

- ESLint + Prettier (code style)
- Husky pre-commit hooks (lint-staged)
- Vitest (unit & integration tests)
- Manual regression testing

### CI/CD

- GitHub Actions (configured in `.github/`)
- Runs tests on push
- Validates formatting, linting, tests

---

## 🎓 Key Learnings

1. **Message Protocol Strictness** — The Anthropic API enforces strict message ordering. Even one violation (e.g., missing tool_result) causes rejection.

2. **Tool Prefix Routing** — The `mcp_` prefix is required for OpenCode's MCP infrastructure to route tools correctly. Must be added in outbound requests and stripped in responses.

3. **Streaming Complexity** — SSE streams complicate error handling since responses are partial. Must detect errors mid-stream and mark accounts appropriately.

4. **Context Overflow Recovery** — Token limits are strict. Must have multiple fallbacks: reduce max_tokens → trim context → bail out.

5. **Account Rotation Logic** — Can't just pick the next account naively. Must track health, failures, rate limits, and token budgets across 10 accounts.

6. **OAuth Signature Emulation** — To avoid account suspension, the plugin closely mimics Claude Code's HTTP headers and system prompts. Not just a system prompt injection.

---

## 🏁 Summary

**opencode-anthropic-fix** is a sophisticated plugin that bridges OpenCode (a code editor) and the Anthropic Claude API by:

1. ✅ Managing OAuth credentials for up to 10 Claude accounts
2. ✅ Properly handling the tool_use/tool_result message protocol
3. ✅ Transforming requests/responses to match Claude Code's signature
4. ✅ Implementing robust error recovery (account switching, context trimming, backoff)
5. ✅ Providing a CLI and slash commands for account management
6. ✅ Including 680+ tests validating every critical path

The codebase is well-structured, thoroughly tested, and production-ready.

---

**For detailed exploration, see:**

- `EXPLORATION_SUMMARY.md` — Comprehensive technical breakdown
- `TOOL_USE_CODE_EXAMPLES.md` — Concrete code examples
- `MESSAGE_FLOW_DIAGRAM.md` — Visual flow diagrams
- `QUICK_REFERENCE.md` — Code location quick lookup
