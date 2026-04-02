# Quick Reference: Key Code Locations

## Message Handling Quick Lookup

### Tool Use & Tool Result

| Task                                   | File      | Lines      | Function                        |
| -------------------------------------- | --------- | ---------- | ------------------------------- |
| Add `mcp_` prefix to outbound tool_use | index.mjs | 6104       | transformRequestBody()          |
| Synthesize tool_result responses       | index.mjs | 6142-6151  | transformRequestBody()          |
| Strip `mcp_` from inbound SSE          | index.mjs | 6309-6320  | stripMcpPrefixFromSSE()         |
| Parse & modify SSE events              | index.mjs | 6330-6367  | stripMcpPrefixFromParsedEvent() |
| Detect tool blocks in messages         | index.mjs | 2945, 6142 | (filtering logic)               |
| Count tokens in tool blocks            | index.mjs | 4140-4250  | analyzeMessages()               |
| Group tool results by name             | index.mjs | 4230-4250  | (grouping logic)                |

### Message Array Validation

| Task                            | File      | Lines     | Function                      |
| ------------------------------- | --------- | --------- | ----------------------------- |
| Guard against assistant prefill | index.mjs | 6133-6160 | transformRequestBody()        |
| Strip slash commands            | index.mjs | 4742-4811 | stripSlashCommandMessages()   |
| Extract first user message      | index.mjs | 4813-4826 | extractFirstUserMessageText() |
| Trim context on overflow        | index.mjs | 2933-2976 | (overflow recovery)           |
| Validate message alternation    | index.mjs | 6133-6160 | (guard logic)                 |

### Fetch Interceptor & Flow

| Task                   | File      | Lines      | Function                             |
| ---------------------- | --------- | ---------- | ------------------------------------ |
| Main fetch hook        | index.mjs | 2299-2400  | hook.fetch()                         |
| Account selection      | index.mjs | 2397-2450  | selectAccount() / account rotation   |
| Token refresh          | index.mjs | 2430-2532  | refreshToken() call + error handling |
| Transform request body | index.mjs | 2645-2690  | transformRequestBody()               |
| Transform request URL  | index.mjs | 6175-6198  | transformRequestUrl()                |
| Transform response     | index.mjs | 6381-6500+ | transformResponse()                  |
| Extract usage stats    | index.mjs | 6214-6246  | extractUsageFromSSEEvent()           |
| Process SSE buffer     | index.mjs | 6399-6440  | processSSEBuffer()                   |
| Rewrite SSE chunk      | index.mjs | 6449-6470  | rewriteSSEChunk()                    |

### Error Handling

| Task                         | File             | Lines     | Function                           |
| ---------------------------- | ---------------- | --------- | ---------------------------------- |
| Classify error type          | lib/backoff.mjs  | All       | isAccountSpecificError()           |
| Parse rate limit reason      | lib/backoff.mjs  | All       | parseRateLimitReason()             |
| Detect mid-stream errors     | index.mjs        | 6427-6433 | getMidStreamAccountError()         |
| Handle overflow errors       | index.mjs        | 2880-2988 | (overflow recovery block)          |
| Retry logic (service errors) | index.mjs        | 2382-2700 | (retry loop with backoff)          |
| Account marking              | lib/accounts.mjs | All       | markFailure(), markHealthPenalty() |

---

## Key Constants & Config

| Constant                     | Location        | Value                    | Purpose                      |
| ---------------------------- | --------------- | ------------------------ | ---------------------------- |
| TOOL_PREFIX                  | index.mjs:~6050 | "mcp\_"                  | Prefix for tool names        |
| CLAUDE_CODE_IDENTITY_STRING  | index.mjs:4833  | "You are Claude Code..." | Identity claim               |
| BILLING_HASH_SALT            | index.mjs:4702  | "59cf53e54c78"           | Salt for billing cache hash  |
| BILLING_HASH_INDICES         | index.mjs:4703  | [4, 7, 20]               | Char indices for hash        |
| MAX_CONTEXT_TRIM_SIZE        | index.mjs:2933  | (when len > 4)           | Threshold for trimming       |
| TRANSIENT_RETRY_THRESHOLD_MS | lib/backoff.mjs | 5000                     | Timeout for transient errors |

---

## Testing Quick Lookup

### Test Files by Feature

| Feature                   | Test File                                       | Lines      |
| ------------------------- | ----------------------------------------------- | ---------- |
| Tool use prefix stripping | index.test.mjs                                  | 928-1100+  |
| Message array guard       | index.test.mjs                                  | 6100-6200+ |
| Slash command filtering   | index.test.mjs                                  | 4490+      |
| Overflow recovery         | test/phase1/task-1-3-overflow-recovery.test.mjs | All        |
| Output cap escalation     | test/phase1/task-1-2-output-cap.test.mjs        | All        |
| Context command           | test/phase2/task-2-2-context-command.test.mjs   | All        |
| Rate limit detection      | test/phase3/task-3-1-rate-limit.test.mjs        | All        |
| Microcompact betas        | test/phase3/task-3-4-microcompact.test.mjs      | All        |
| Token budget parsing      | test/phase3/task-3-3-token-budget.test.mjs      | All        |
| Regression suite          | test/conformance/regression.test.mjs            | 40+ tests  |

---

## Common Code Patterns

### Checking if Block is Tool Use

```javascript
if (block.type === "tool_use" && block.name) {
  // This is a tool use block
}
```

### Checking if Message Ends with Assistant

```javascript
if (lastMsg && lastMsg.role === "assistant") {
  const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [];
  const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");
}
```

### Processing Messages Array

```javascript
for (const msg of messages) {
  if (!Array.isArray(msg.content)) continue;

  for (const block of msg.content) {
    if (block.type === "tool_use") {
      // Handle tool use
    } else if (block.type === "tool_result") {
      // Handle tool result
    } else if (block.type === "text") {
      // Handle text
    }
  }
}
```

### Extracting First User Message

```javascript
function getFirstUserText(messages) {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") return block.text;
      }
    }
  }
  return "";
}
```

### Checking for Slash Commands

```javascript
const CMD_RE = /^\s*\/anthropic\b/i;
const text = msg.content || "";
if (CMD_RE.test(text)) {
  // This is a slash command message
}
```

### Safe Account Selection

```javascript
const account = pinnedAccount || selectAccount(strategy);
if (!account || !account.enabled) {
  // Skip this account
  continue;
}
```

---

## Debug Logging

### Enable Debug Output

```bash
export OPENCODE_ANTHROPIC_DEBUG=1
opencode
```

### Debug System Prompt

```bash
export OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT=1
opencode
```

### Key Debug Points in Code

| Location         | Purpose                       |
| ---------------- | ----------------------------- |
| index.mjs:~2267  | Initial account pinning       |
| index.mjs:~2400  | Account selection per request |
| index.mjs:~2700  | Request success               |
| index.mjs:~2800  | Error handling                |
| index.mjs:~6328+ | SSE processing                |

---

## Env Variables That Affect Message Handling

| Variable                                         | Values        | Effect                             |
| ------------------------------------------------ | ------------- | ---------------------------------- |
| OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE | 0 or 1        | Disable/enable signature emulation |
| OPENCODE_ANTHROPIC_PROMPT_COMPACTION             | off/minimal   | Control system prompt compaction   |
| OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT           | 1             | Log final system prompt            |
| OPENCODE_ANTHROPIC_INITIAL_ACCOUNT               | 1-10 or email | Pin session to specific account    |
| CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS           | 1             | Suppress experimental betas        |

---

## Configuration Flags

### In `~/.config/opencode/anthropic-auth.json`

| Config                                  | Type             | Effect on Messages                   |
| --------------------------------------- | ---------------- | ------------------------------------ |
| `signature_emulation.enabled`           | boolean          | Control system prompt injection      |
| `signature_emulation.prompt_compaction` | "minimal"\|"off" | Compress repeated system blocks      |
| `override_model_limits.enabled`         | boolean          | Inject 1M context limit              |
| `microcompact.enabled`                  | boolean          | Inject clear_tool_uses beta          |
| `token_budget.enabled`                  | boolean          | Parse budget expressions in messages |

---

## Performance Considerations

### Token Counting (O(n) where n = messages)

- Tool use input: JSON serialized (~2x actual JSON length)
- Tool result content: String length in bytes ÷ 4 (rough estimate)
- System prompt: Heavy (~2-8K tokens)

### Message Trimming (O(n) where n = messages)

- First triggered when messages.length > 4
- Keeps first 2 + marker + last 2 = 5 messages minimum
- Can trigger multiple times in a long conversation

### SSE Processing (O(chunks) where chunks = stream events)

- Regex replace per chunk (linear in chunk size)
- JSON parse per event (O(event size))
- No accumulation of unused data (streaming design)

---

## Common Issues & Fixes

| Issue                                 | Cause                             | Solution                             |
| ------------------------------------- | --------------------------------- | ------------------------------------ |
| "assistant message prefill" error     | Message array ends with assistant | Guard adds user message              |
| tool_result not found                 | tool_use_id mismatch              | Ensure IDs match in pairing          |
| Tool name not recognized              | Missing `mcp_` prefix in request  | transformRequestBody adds it         |
| Tool name double-prefixed in response | Prefix not stripped from SSE      | stripMcpPrefixFromSSE fixes it       |
| Context overflow                      | Messages exceed model limit       | Trimming reduces to first 2 + last 2 |
| Account marked failed                 | 401/403/429 error                 | Try next account in rotation         |
| Message leak from slash commands      | `/anthropic` in history           | stripSlashCommandMessages removes it |

---

## Validation Checklist

Before sending messages to API:

- [ ] Array alternates user/assistant
- [ ] Array starts with user
- [ ] Array ends with user (not assistant)
- [ ] Each tool_use has corresponding tool_result
- [ ] tool_use IDs match tool_result tool_use_ids
- [ ] No `/anthropic` command messages
- [ ] tool*use names have `mcp*` prefix
- [ ] tool_result names don't have prefix
- [ ] max_tokens is reasonable for model
- [ ] No empty content blocks

After receiving SSE stream:

- [ ] All tool*use names stripped of `mcp*` prefix
- [ ] Usage tokens accumulated correctly
- [ ] Error detection triggered if mid-stream error
- [ ] No malformed JSON in output
