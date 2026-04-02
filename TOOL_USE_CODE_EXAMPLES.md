# Tool Use & Tool Result Code Examples

This document provides concrete code examples for how `opencode-anthropic-fix` handles tool use and tool result message pairing.

---

## Example 1: Basic Tool Use Flow

### Incoming Request (before transformation)

```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {
      "role": "user",
      "content": "Read the file /etc/passwd"
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "tooluse_abc123",
          "name": "read_file",
          "input": {
            "path": "/etc/passwd"
          }
        }
      ]
    }
  ],
  "tools": [...]
}
```

### After Message Array Guard (index.mjs lines 6133-6160)

The fetch interceptor detects that the message array ends with an assistant message containing a `tool_use` block. Since there's no corresponding `tool_result`, it synthesizes one:

```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {
      "role": "user",
      "content": "Read the file /etc/passwd"
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "tooluse_abc123",
          "name": "mcp_read_file",  // <-- mcp_ prefix added
          "input": {
            "path": "/etc/passwd"
          }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "tooluse_abc123",
          "content": "[Result unavailable — conversation was restructured]"
        }
      ]
    }
  ],
  "tools": [...]
}
```

### Response (SSE stream from API)

The API returns tool execution result in the stream:

```
data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The /etc/passwd file contains user account information..."}}

data: {"type":"content_block_stop","index":0}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":150,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}

data: {"type":"message_stop"}
```

### After SSE Processing (index.mjs lines 6309-6367)

The `stripMcpPrefixFromSSE()` function removes `mcp_` prefixes from tool names in any SSE event that contains them (though in streaming responses, tool_use blocks are typically sent as part of content_block events, not in deltas).

---

## Example 2: Multiple Tool Uses in One Assistant Message

### Scenario

Assistant wants to use multiple tools in a single message (e.g., read 2 files simultaneously):

```javascript
// Outbound message array
const messages = [
  {
    role: "user",
    content: "Compare /etc/passwd and /etc/shadow",
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "read_file",
        input: { path: "/etc/passwd" },
      },
      {
        type: "tool_use",
        id: "tu_2",
        name: "read_file",
        input: { path: "/etc/shadow" },
      },
    ],
  },
];

// The guard in transformRequestBody detects this:
const lastMsg = messages[messages.length - 1]; // assistant message
const toolUseBlocks = lastMsg.content.filter((b) => b.type === "tool_use");
// toolUseBlocks.length === 2

// So it synthesizes tool_results for BOTH:
messages.push({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "[Result unavailable — conversation was restructured]",
    },
    {
      type: "tool_result",
      tool_use_id: "tu_2",
      content: "[Result unavailable — conversation was restructured]",
    },
  ],
});
```

---

## Example 3: Tool Use Name Prefix Handling

### Why Prefixes Are Needed

OpenCode uses MCP (Model Context Protocol) servers to provide tools. Tool names need to be prefixed with `mcp_` to route through the MCP infrastructure:

- Tool name: `read_file`
- MCP server name: `mcp`
- Fully qualified: `mcp_read_file`

### Transformation Flow

**1. Outbound (Client → API)** — `transformRequestBody()` at line 6104

```javascript
if (block.type === "tool_use" && block.name) {
  return {
    ...block,
    name: `${TOOL_PREFIX}${block.name}`, // TOOL_PREFIX = "mcp_"
  };
}

// Example:
// Input:  { type: "tool_use", name: "read_file", ... }
// Output: { type: "tool_use", name: "mcp_read_file", ... }
```

**2. Inbound (API → Client)** — `stripMcpPrefixFromSSE()` at line 6309

The API echoes back tool_use blocks with the prefixed name in streaming responses:

```
data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read_file","id":"tu_abc123"}}
```

The stripper processes each SSE event:

```javascript
function stripMcpPrefixFromSSE(text) {
  return text.replace(/^data:\s*(.+)$/gm, (_match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (stripMcpPrefixFromParsedEvent(parsed)) {
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
      return _match;
    }
    return _match;
  });
}

// Input:  data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read_file"}}
// Output: data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"read_file"}}
```

**3. Inbound Event Handling** — `stripMcpPrefixFromParsedEvent()` at line 6330

Handles three SSE event structures:

```javascript
// content_block_start event:
if (parsed.content_block?.type === "tool_use" && parsed.content_block.name?.startsWith("mcp_")) {
  parsed.content_block.name = parsed.content_block.name.slice(4);
}

// message_start event (initial message with all content):
if (parsed.message?.content) {
  for (const block of parsed.message.content) {
    if (block.type === "tool_use" && block.name?.startsWith("mcp_")) {
      block.name = block.name.slice(4);
    }
  }
}

// Top-level content array:
if (Array.isArray(parsed.content)) {
  for (const block of parsed.content) {
    if (block.type === "tool_use" && block.name?.startsWith("mcp_")) {
      block.name = block.name.slice(4);
    }
  }
}
```

---

## Example 4: Context Overflow Recovery with Tool Use

### Scenario

User has a long conversation history. OpenCode detects `prompt_too_long` error and triggers recovery. The trimmed message array might end with a tool_use block.

### Error Response

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "prompt_too_long: Prompt or output max tokens too long for the model."
  }
}
```

### Recovery Code (index.mjs lines 2933-2962)

```javascript
const parsedBody = JSON.parse(body);
if (Array.isArray(parsedBody.messages) && parsedBody.messages.length > 4) {
  const msgs = parsedBody.messages;
  const tail = msgs.slice(-2); // Keep last 2 messages

  // If tail ends with assistant message containing tool_use blocks,
  // synthesize tool_result responses
  if (tail.length > 0 && tail[tail.length - 1]?.role === "assistant") {
    const lastAssistant = tail[tail.length - 1];
    const lastContent = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
    const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length > 0) {
      // Synthesize tool_result for each pending tool_use
      tail.push({
        role: "user",
        content: toolUseBlocks.map((tu) => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "[Context trimmed — previous result unavailable]",
        })),
      });
    } else {
      tail.push({
        role: "user",
        content: [{ type: "text", text: "Continue." }],
      });
    }
  }

  // Build trimmed message array with marker
  const trimmed = [
    ...msgs.slice(0, 2), // First 2 messages (context)
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "[Earlier conversation was trimmed due to context limits. Continue from the most recent context.]",
        },
      ],
    },
    ...tail, // Last 2 messages (with synthesized tool_results if needed)
  ];

  parsedBody.messages = trimmed;
  requestInit.body = JSON.stringify(parsedBody);
  // Retry with trimmed messages
}
```

---

## Example 5: Slash Command Message Filtering

### Incoming Message Array with Leak

User runs `/anthropic switch 2` in OpenCode. The command gets included in the message history:

```json
[
  {
    "role": "user",
    "content": "What is the weather?"
  },
  {
    "role": "assistant",
    "content": "I'll check the weather for you."
  },
  {
    "role": "user",
    "content": "/anthropic switch 2"
  },
  {
    "role": "assistant",
    "content": "▣ Anthropic: Switched to account #2"
  }
]
```

### After stripSlashCommandMessages() (index.mjs lines 4742-4811)

```javascript
function stripSlashCommandMessages(messages) {
  const CMD_RE = /^\s*\/anthropic\b/i;
  const RESP_RE = /^▣\s*Anthropic/;

  const filtered = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (isCommandMessage(msg)) {
      // Drop /anthropic command
      if (i + 1 < messages.length && isCommandResponse(messages[i + 1])) {
        i++; // Also skip the response
      }
      continue;
    }

    if (isCommandResponse(msg)) {
      continue;
    }

    filtered.push(msg);
  }

  // Result:
  return [
    {
      role: "user",
      content: "What is the weather?",
    },
    {
      role: "assistant",
      content: "I'll check the weather for you.",
    },
  ];
}
```

The model never sees the internal command in its context.

---

## Example 6: Token Counting with Tool Blocks

### Message Structure

```javascript
const messages = [
  {
    role: "user",
    content: "Read /tmp/config.json and summarize it",
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "read_file",
        input: {
          path: "/tmp/config.json",
        },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: '{"db": "postgres", "cache": "redis", "region": "us-east-1"}',
      },
    ],
  },
];
```

### Token Counting Code (index.mjs lines 4140-4250)

```javascript
function analyzeMessages(messages) {
  let assistantTokens = 0;
  let userTokens = 0;
  const toolStats = {};

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "text" && msg.role === "user") {
        userTokens += estimateTokens(block.text);
      } else if (block.type === "text" && msg.role === "assistant") {
        assistantTokens += estimateTokens(block.text);
      } else if (block.type === "tool_result" && typeof block.content === "string") {
        // tool_result is part of user turn
        userTokens += estimateTokens(block.content);

        // Group by tool_name (look up from tool_use_id)
        const toolName = findToolNameById(block.tool_use_id);
        if (toolName) {
          toolStats[toolName] = (toolStats[toolName] || 0) + 1;
        }
      } else if (block.type === "tool_use") {
        // tool_use is part of assistant turn
        assistantTokens += estimateTokens(JSON.stringify(block.input || {}));
      }
    }
  }

  return {
    assistantTokens,
    userTokens,
    toolStats,
    totalTokens: assistantTokens + userTokens,
  };
}

// Result:
// {
//   assistantTokens: ~50 (for tool_use call),
//   userTokens: ~150 (for user text + tool_result),
//   toolStats: { read_file: 1 },
//   totalTokens: ~200
// }
```

---

## Example 7: Error Detection in Streaming Response

### Mid-Stream Error in SSE

API detects an error while streaming and includes it in the SSE:

```
data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Attempting to read file..."}}

data: {"type":"error","error":{"type":"invalid_request_error","message":"invalid_api_key","status":401}}
```

### Detection Code (index.mjs lines 6427-6433)

```javascript
if (onAccountError && !accountErrorHandled) {
  const details = getMidStreamAccountError(parsed);
  if (details) {
    accountErrorHandled = true;
    onAccountError(details); // Mark account for next request
  }
}

// getMidStreamAccountError() returns:
// {
//   reason: "invalid_api_key",
//   invalidateToken: true
// }

// The fetch interceptor then:
// 1. Marks this account as failed
// 2. Moves to the next available account
// 3. Retries the entire request with a fresh token
```

---

## Example 8: Tool Result Grouping for Analysis

### Scenario

Command: `/anthropic context` — user wants to see token breakdown

### Code (index.mjs lines 4200-4250)

```javascript
function groupToolResults(messages) {
  const groups = {};

  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        // Find the corresponding tool_use block
        const toolUseBlock = findToolUseById(block.tool_use_id);
        if (toolUseBlock) {
          const toolName = toolUseBlock.name;
          if (!groups[toolName]) {
            groups[toolName] = {
              count: 0,
              totalTokens: 0,
              examples: [],
            };
          }
          groups[toolName].count++;
          groups[toolName].totalTokens += estimateTokens(block.content);
          if (groups[toolName].examples.length < 2) {
            groups[toolName].examples.push({
              toolUseId: block.tool_use_id,
              contentPreview: block.content.slice(0, 100),
            });
          }
        }
      }
    }
  }

  return groups;

  // Result:
  // {
  //   "read_file": {
  //     count: 3,
  //     totalTokens: 450,
  //     examples: [...]
  //   },
  //   "bash": {
  //     count: 1,
  //     totalTokens: 150,
  //     examples: [...]
  //   }
  // }
}
```

---

## Key Takeaways

1. **Tool Use Pairing** — Every `tool_use` block must have a corresponding `tool_result` block in the messages array
2. **Prefix Management** — `mcp_` prefix added for outbound (API routing), stripped for inbound (client display)
3. **Message Array Invariants** — Must end with user message; never assistant message (except when immediately followed by tool_result)
4. **Overflow Recovery** — Synthesizes missing tool_results when trimming context
5. **Command Filtering** — Removes `/anthropic` slash commands before sending to model
6. **Token Accounting** — Properly counts tool_use input and tool_result content separately
7. **Error Detection** — Identifies account-specific errors in mid-stream SSE to trigger account switching
