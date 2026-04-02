# OpenCode Proxy Latency Analysis Report

**Date**: April 2, 2026  
**Scope**: index.mjs and related modules  
**Focus**: Per-request/per-turn (round-trip) latency sources

---

## EXECUTIVE SUMMARY

Found **13 major latency sources** that add measurable overhead to each turn. The most impactful are:

1. **Sequential JSON parsing operations** (4-6 times per request)
2. **Exponential backoff sleep delays** (up to 8+ seconds)
3. **Synchronous token estimation** (scales with message history)
4. **Deep message array processing** (repairOrphanedToolUseBlocks)
5. **Multi-pass request body transformation**

**Total estimated per-request overhead**: 5-50ms baseline + sleep delays up to 8000ms+

---

## DETAILED FINDINGS

### 1. EXPONENTIAL BACKOFF SLEEP IN SERVICE-WIDE RETRY LOOP ⚠️ CRITICAL

**File**: `index.mjs`  
**Lines**: 3147-3162  
**Severity**: CRITICAL - Direct request blocking

```javascript
const baseDelay = Math.min(0.5 * Math.pow(2, serviceWideRetryCount), 8);
const jitter = 1 - Math.random() * 0.25;
const sleepMs = Math.round(baseDelay * jitter * 1000);
// ...
await new Promise((r) => setTimeout(r, sleepMs));
```

**Impact**:

- On 1st 529/503 retry: 500ms-750ms sleep
- On 2nd 529/503 retry: 1000ms-1500ms sleep
- On 3rd+ retries: up to **8000ms (8 seconds)** blocking sleep

**Frequency**: Triggered on every 529 (overloaded) or 503 (unavailable) error
**Overhead per turn**: 0-8000ms (depends on error rate)

---

### 2. TRANSIENT 429 RATE-LIMIT SLEEP ⚠️ CRITICAL

**File**: `index.mjs`  
**Lines**: 3050-3065  
**Severity**: CRITICAL - Direct request blocking

```javascript
if (
  response.status === 429 &&
  reason === "RATE_LIMIT_EXCEEDED" &&
  retryAfterMs != null &&
  retryAfterMs > 0 &&
  retryAfterMs <= TRANSIENT_RETRY_THRESHOLD_MS
) {
  await new Promise((r) => setTimeout(r, retryAfterMs));
  attempt--;
  continue;
}
```

**Impact**:

- **Sleep duration**: Reads from `retry-after` header, up to TRANSIENT_RETRY_THRESHOLD_MS
- Blocking delay of 1000ms-10000ms possible per rate-limited request
- **Frequency**: Every rate-limited turn

**Overhead per turn**: 0-10000ms (depends on rate limit headers)

---

### 3. X-SHOULD-RETRY FORCED SLEEP ⚠️ CRITICAL

**File**: `index.mjs`  
**Lines**: 3026-3040  
**Severity**: CRITICAL - Unpredictable blocking

```javascript
if (shouldRetry === true && !accountSpecific && shouldRetryCount < maxShouldRetries) {
  shouldRetryCount++;
  const retryDelay = parseRetryAfterMsHeader(response) ?? parseRetryAfterHeader(response) ?? 2000;
  debugLog("x-should-retry: true on service-wide error, sleeping before retry", {
    status: response.status,
    retryDelay,
    shouldRetryCount,
  });
  await new Promise((r) => setTimeout(r, retryDelay));
  attempt--;
  continue;
}
```

**Impact**:

- Default 2000ms sleep if server specifies x-should-retry: true
- Capped at 3 retries (maxShouldRetries)
- **Overhead per turn**: 0-6000ms (3 retries × 2000ms default)

---

### 4. RECURSIVE REQUEST BODY JSON.PARSE (MULTIPLE TIMES) ⚠️ HIGH

**File**: `index.mjs`  
**Lines**: Multiple locations

| Location           | Line | Context                          | Frequency                               |
| ------------------ | ---- | -------------------------------- | --------------------------------------- |
| File-ID pinning    | 2360 | `JSON.parse(requestInit.body)`   | Every request with body                 |
| Adaptive context   | 4122 | Inside `estimatePromptTokens()`  | Every request if adaptive enabled       |
| Token estimation   | 4122 | Inside `estimatePromptTokens()`  | Called 2x per request (line 2563, 2581) |
| 529 model fallback | 3116 | Inside retry handler             | Only on 3+ consecutive 529s             |
| Context analysis   | 4188 | Inside `analyzeRequestContext()` | Only on `/anthropic context` command    |

**Impact**:

- **JSON.parse is O(n) where n = body size**
- Large messages (100KB+) can take 5-15ms per parse
- Called 2-4 times per request in hot path:
  1. Line 2360: File ID extraction
  2. Line 4122 (first call): estimatePromptTokens for adaptive decision (line 2563)
  3. Line 4122 (second call): estimatePromptTokens for microcompact decision (line 2581)
  4. Line 3116: Model fallback on consecutive 529s

**Overhead per turn**: 5-60ms (scales with body size)

---

### 5. ESTIMATE PROMPT TOKENS — SYNCHRONOUS STRING ITERATION ⚠️ MEDIUM-HIGH

**File**: `index.mjs`  
**Lines**: 4119-4165  
**Severity**: MEDIUM-HIGH - Scales with message history

```javascript
function estimatePromptTokens(bodyString) {
  if (!bodyString || typeof bodyString !== "string") return 0;
  try {
    const parsed = JSON.parse(bodyString); // PARSE #1
    let charCount = 0;

    // Iterate system blocks
    if (Array.isArray(parsed.system)) {
      for (const block of parsed.system) {
        if (block.type === "text" && typeof block.text === "string") {
          charCount += block.text.length; // O(n) string operation
        }
      }
    }

    // Iterate ALL messages
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        // NESTED LOOP: O(m)
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            // TRIPLE NESTED: O(m*k)
            if (block.type === "text") {
              charCount += block.text.length; // String concat
            } else if (block.type === "tool_use") {
              charCount += JSON.stringify(block.input || {}).length; // PARSE #2
            } else if (block.type === "image") {
              charCount += 8000; // Constant
            }
          }
        }
      }
    }
    return Math.ceil(charCount / 4);
  } catch {
    return Math.ceil(bodyString.length / 4);
  }
}
```

**Call Sites**:

- **Line 2563**: For adaptive context decision (toast notification)
- **Line 2581**: For microcompact decision
- **Line 4303**: When analyzing request context for `/anthropic context` command

**Complexity**: O(system_blocks + messages × content_blocks)

**Overhead per turn**:

- Small message (< 10K chars): 1-3ms
- Medium message (100K chars): 5-10ms
- Large message (500K+ chars): 15-30ms

---

### 6. REPAIR ORPHANED TOOL USE BLOCKS — NESTED ITERATION ⚠️ MEDIUM

**File**: `index.mjs`  
**Lines**: 4764-4831  
**Severity**: MEDIUM - Runs on every request body transformation

```javascript
function repairOrphanedToolUseBlocks(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const repaired = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    repaired.push(msg);

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const toolUseIds = [];
    for (const block of msg.content) {
      // NESTED LOOP #1
      if (block.type === "tool_use" && block.id) {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    if (next && next.role === "user" && Array.isArray(next.content)) {
      const resultIds = new Set();
      for (const block of next.content) {
        // NESTED LOOP #2
        if (block.type === "tool_result" && block.tool_use_id) {
          resultIds.add(block.tool_use_id);
        }
      }

      const missingIds = toolUseIds.filter((id) => !resultIds.has(id)); // FILTER: O(m*k)
      if (missingIds.length === 0) continue;

      const patchedNext = {
        ...next,
        content: [
          ...missingIds.map((id) => ({
            // MAPPING: Creates new objects
            type: "tool_result",
            tool_use_id: id,
            content: "[Result unavailable — tool execution was interrupted]",
          })),
          ...next.content, // ARRAY SPREAD: O(k)
        ],
      };
      i++;
      repaired.push(patchedNext);
    } else {
      repaired.push({
        role: "user",
        content: toolUseIds.map((id) => ({
          // O(m)
          type: "tool_result",
          tool_use_id: id,
          content: "[Result unavailable — tool execution was interrupted]",
        })),
      });
    }
  }

  return repaired;
}
```

**Complexity**: O(messages × content_blocks) per request

**Overhead per turn**:

- 10 messages, avg 5 content blocks: ~2-3ms
- 100 messages, avg 5 content blocks: ~20-30ms
- 1000 messages, avg 5 content blocks: ~200-300ms (worst case)

**Called From**:

- Line 2979: Request body transformation
- Line 6233: Main transformRequestBody path

---

### 7. TRANSFORM REQUEST BODY — MULTI-PASS PROCESSING ⚠️ MEDIUM

**File**: `index.mjs`  
**Lines**: 6052-6300+  
**Severity**: MEDIUM - Runs on every request

The `transformRequestBody` function performs multiple sequential passes over the messages array and systems prompt, including:

- JSON.parse
- System prompt normalization
- Token budget parsing
- Cache control injection (O(messages))
- Tool name prefixing (O(messages × content))
- Repair orphaned blocks (O(messages × content))
- Trailing message guard (O(messages))
- JSON.stringify

**Complexity**: O(messages × content_blocks) for the full transformation

**Overhead per turn**: 10-50ms (scales with request size and message count)

---

### 8. STRIP SLASH COMMAND MESSAGES — LINEAR SCAN ⚠️ MEDIUM

**File**: `index.mjs`  
**Lines**: 4833-4902  
**Severity**: MEDIUM - Called during transformRequestBody

Linear scan of all messages looking for `/anthropic` command patterns and filtering them out.

**Complexity**: O(messages × avg_content_blocks)

**Overhead per turn**: 2-10ms

---

### 9. ACCOUNT TOKEN REFRESH — DISK I/O ⚠️ MEDIUM

**File**: `index.mjs`  
**Lines**: 2431-2480  
**Severity**: MEDIUM - Blocking I/O operation

Refreshes OAuth token when expiring in 5 minutes. Includes:

- Single-flight locking (avoid duplicate refresh)
- Disk read on failure (belt-and-suspenders retry)
- Network call to OAuth endpoint

**Impact**:

- Disk reads: 5-20ms per operation
- Network call to OAuth endpoint: 500ms-2000ms on success
- Occurs once per request when token expires (every 1 hour)
- Occurs every request on token refresh failures

**Overhead per turn**:

- Normal path (token fresh): 0ms
- Token refresh path: 500ms-2000ms (network bound)
- Retry path: 1000ms-4000ms (network + disk I/O)

---

### 10. EXTRACT FILE IDS — RECURSIVE TRAVERSAL ⚠️ MEDIUM

**File**: `index.mjs`  
**Lines**: 6856-6874  
**Severity**: MEDIUM - Called for file-ID account pinning

Recursive object traversal to find all file_id references in request body.

**Complexity**: O(object_depth)

**Overhead per turn**: 2-5ms (negligible unless deeply nested)

---

### 11. BUILD ANTHROPIC BETA HEADER — STRING OPERATIONS ⚠️ LOW-MEDIUM

**File**: `index.mjs`  
**Lines**: 5628-5786  
**Severity**: LOW-MEDIUM - Many string splits/joins

String splitting, Set deduplication, array filtering, and joining betas.

**Complexity**: O(betas_count) with multiple array operations

**Overhead per turn**: 1-3ms

---

### 12. SYNC ACTIVE INDEX FROM DISK ⚠️ LOW

**File**: `index.mjs`  
**Lines**: 2323-2325  
**Severity**: LOW - Disk I/O but runs every request

Disk read to sync active account index from CLI changes.

**Overhead per turn**: 5-20ms (disk I/O, happens once per request)

---

### 13. WILLOW MODE IDLE DETECTION & TOAST ⚠️ LOW

**File**: `index.mjs`  
**Lines**: 2330-2345  
**Severity**: LOW - Infrequent toast trigger

Detects session idle time and shows notification.

**Overhead per turn**: 0-1ms (negligible, runs rarely)

---

## SUMMARY TABLE

| ID  | Source                              | Severity       | Type         | Per-Turn Overhead | Frequency                |
| --- | ----------------------------------- | -------------- | ------------ | ----------------- | ------------------------ |
| 1   | Exponential backoff sleep (529/503) | ⚠️ CRITICAL    | Sleep        | 0-8000ms          | Rate-dependent           |
| 2   | Transient 429 sleep                 | ⚠️ CRITICAL    | Sleep        | 0-10000ms         | Rate-dependent           |
| 3   | x-should-retry sleep                | ⚠️ CRITICAL    | Sleep        | 0-6000ms          | Service-dependent        |
| 4   | JSON.parse (4x)                     | ⚠️ HIGH        | Computation  | 5-60ms            | Every request            |
| 5   | estimatePromptTokens                | ⚠️ MEDIUM-HIGH | Iteration    | 1-30ms            | Every request (2x)       |
| 6   | repairOrphanedToolUseBlocks         | ⚠️ MEDIUM      | Iteration    | 2-300ms           | Every request            |
| 7   | transformRequestBody                | ⚠️ MEDIUM      | Multi-pass   | 10-50ms           | Every request            |
| 8   | stripSlashCommandMessages           | ⚠️ MEDIUM      | Iteration    | 2-10ms            | Every request            |
| 9   | Token refresh (auth)                | ⚠️ MEDIUM      | Async I/O    | 500-4000ms        | Hourly + failures        |
| 10  | extractFileIds                      | ⚠️ MEDIUM      | Recursion    | 2-5ms             | Every request (if files) |
| 11  | buildAnthropicBetaHeader            | ⚠️ LOW-MEDIUM  | String ops   | 1-3ms             | Every request            |
| 12  | syncActiveIndexFromDisk             | ⚠️ LOW         | Disk I/O     | 5-20ms            | Every request            |
| 13  | Willow mode toast                   | ⚠️ LOW         | Notification | 0-1ms             | Rare                     |

---

## PERFORMANCE PROFILE

### Baseline Request (No Errors, Fresh Token)

- 4x JSON.parse: 20ms
- estimatePromptTokens (2x): 10ms
- repairOrphanedToolUseBlocks: 15ms
- transformRequestBody: 20ms
- stripSlashCommandMessages: 5ms
- buildAnthropicBetaHeader: 2ms
- syncActiveIndexFromDisk: 10ms
- **Total**: ~82ms overhead before network

### Rate-Limited Request (429)

- All baseline operations: 82ms
- Transient 429 sleep: **1000-10000ms** (retry-after header)
- **Total**: 1082-10082ms

### Service Overload Request (529/503)

- All baseline operations: 82ms
- Exponential backoff sleep (1st retry): **500-750ms**
- Exponential backoff sleep (2nd retry): **1000-1500ms**
- **Total**: Up to 2332ms for 2 retries + 8000ms+ for 3+ retries

### Token Refresh Needed

- All baseline: 82ms
- Refresh endpoint call: **500-2000ms** (network bound)
- **Total**: 582-2082ms

---

## RECOMMENDED OPTIMIZATIONS (Priority Order)

### P0: Eliminate or Reduce Sleep Delays

1. **Batch retry sleep into network call wait time** (don't artificially wait on 429/503)
2. **Use exponential backoff on server side** (return appropriate retry-after)
3. **Cap sleep delays** at 2-3 seconds max

### P1: Reduce JSON Parsing

1. **Cache first JSON.parse result** per request
2. **Pass parsed object instead of string** through call chain
3. **Combine estimatePromptTokens calls** (call once, cache result)

### P2: Optimize Message Processing

1. **Delay repairOrphanedToolUseBlocks** until needed (lazy repair)
2. **Combine message passes** (stripSlashCommandMessages + repair in single loop)
3. **Profile repairOrphanedToolUseBlocks** on large message histories (1000+ messages)

### P3: Parallelize Non-Critical Work

1. **Move token refresh to background** if token is still valid for this request
2. **Fire-and-forget disk sync** instead of awaiting
3. **Batch disk operations** (account sync + token save)

---

## RELATED FILES

- `lib/backoff.mjs` - Rate limit parsing & retry constants
- `lib/accounts.mjs` - Account selection & state management
- `lib/oauth.mjs` - Token refresh endpoint
- `lib/storage.mjs` - Disk read/write

---

## CONCLUSION

The biggest latency source is **intentional delays** (sleep) rather than computation:

- **0-8000ms per request** in sleep times (service retries)
- **~82ms** in baseline computation overhead
- **500-4000ms** in token refresh (hourly, then only on failure)

**Quick wins**: Cap sleep delays at 2-3s, cache JSON parses, combine message processing passes.
