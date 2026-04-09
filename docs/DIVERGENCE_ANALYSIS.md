# System Prompt Block Construction: Real CC vs Plugin Divergence Analysis

## Executive Summary

The plugin's `buildSystemPromptBlocks` function (index.mjs:5751) has **MAJOR structural divergences** from the real Claude Code implementation (src88/src/services/api/claude.ts:3213). The real CC uses a sophisticated multi-path cache scoping strategy that the plugin does not implement.

---

## 1. FUNCTION SIGNATURES & CALL PATTERNS

### Real Claude Code (src88)

```typescript
// src/services/api/claude.ts:3213
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean;
    querySource?: QuerySource;
  },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map((block) => {
    return {
      type: "text" as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    };
  });
}
```

**Call site (src88, line 1376):**

```typescript
const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
  skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
  querySource: options.querySource,
});
```

### Plugin (index.mjs)

```javascript
// index.mjs:5751
function buildSystemPromptBlocks(system, signature) {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);

  let sanitized = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text), signature.promptCompactionMode),
  }));

  if (titleGeneratorRequest) {
    sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
  } else if (signature.promptCompactionMode !== "off") {
    sanitized = dedupeSystemBlocks(sanitized);
  }

  if (!signature.enabled) {
    return sanitized;
  }

  const filtered = sanitized.filter(
    (item) => !item.text.startsWith("x-anthropic-billing-header:") && !KNOWN_IDENTITY_STRINGS.has(item.text),
  );

  const blocks = [];
  // ... builds billing header, identity block, then scattered blocks with cache_control ...
}
```

**Call site (index.mjs, line 6370):**

```javascript
parsed.system = buildSystemPromptBlocks(normalizeSystemTextBlocks(parsed.system), signatureWithModel);
```

### ⚠️ CRITICAL DIVERGENCE #1: Function Signature

| Aspect           | Real CC                                                               | Plugin                                       |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| **Param 1**      | `systemPrompt: SystemPrompt`                                          | `system: already-normalized array`           |
| **Param 2**      | `enablePromptCaching: boolean`                                        | `signature: object with 10+ fields`          |
| **Param 3**      | `options?: {skipGlobalCacheForSystemPrompt, querySource}`             | (none)                                       |
| **Architecture** | Delegates all logic to `splitSysPromptPrefix()` + `getCacheControl()` | Implements logic directly with no delegation |

---

## 2. CACHE SCOPING STRATEGY: The Core Divergence

The real CC uses **THREE DISTINCT PATHS** based on feature flags, determined in `splitSysPromptPrefix()`:

### Real CC Path A: Tool-Based Cache (skipGlobalCacheForSystemPrompt=true)

**src88/src/utils/api.ts:325-360**

When `shouldUseGlobalCacheScope() && skipGlobalCacheForSystemPrompt`:

- **Attribution header**: `cacheScope: null` (never cached)
- **System prefix** (identity string): `cacheScope: 'org'` (internal-only scope)
- **Rest of system prompt**: `cacheScope: 'org'`

```typescript
if (useGlobalCacheFeature && options?.skipGlobalCacheForSystemPrompt) {
  const result: SystemPromptBlock[] = [];
  if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
  if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: "org" }); // <-- org scope!
  const restJoined = rest.join("\n\n");
  if (restJoined) result.push({ text: restJoined, cacheScope: "org" }); // <-- org scope!
  return result;
}
```

### Real CC Path B: Global Cache with Boundary (useGlobalCacheFeature && boundary marker found)

**src88/src/utils/api.ts:362-404**

When `shouldUseGlobalCacheScope() && SYSTEM_PROMPT_DYNAMIC_BOUNDARY found`:

- **Attribution header**: `cacheScope: null` (never cached)
- **System prefix** (identity string): `cacheScope: null` (NOT cached in boundary mode!)
- **Static blocks** (before boundary): `cacheScope: 'global'` (static, cacheable at API)
- **BOUNDARY MARKER**: `{type: 'text', text: SYSTEM_PROMPT_DYNAMIC_BOUNDARY, cacheScope: null}`
- **Dynamic blocks** (after boundary): `cacheScope: null` (never cached)

```typescript
if (useGlobalCacheFeature) {
  const boundaryIndex = systemPrompt.findIndex((s) => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (boundaryIndex !== -1) {
    const result: SystemPromptBlock[] = [];
    if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
    if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: null }); // <-- NO cache in boundary mode!
    const staticJoined = staticBlocks.join("\n\n");
    if (staticJoined) result.push({ text: staticJoined, cacheScope: "global" });
    const dynamicJoined = dynamicBlocks.join("\n\n");
    if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null });
    return result;
  }
}
```

### Real CC Path C: Fallback (No Global Cache Feature)

**src88/src/utils/api.ts:411-435**

When `!shouldUseGlobalCacheScope()`:

- **Attribution header**: `cacheScope: null` (never cached)
- **System prefix** (identity string): `cacheScope: 'org'`
- **Rest**: `cacheScope: 'org'`

```typescript
const result: SystemPromptBlock[] = [];
if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: "org" }); // <-- org scope!
const restJoined = rest.join("\n\n");
if (restJoined) result.push({ text: restJoined, cacheScope: "org" }); // <-- org scope!
return result;
```

### Plugin Implementation: **NONE OF THE ABOVE**

**index.mjs:5751-5850**

The plugin:

1. ❌ Has NO concept of `shouldUseGlobalCacheScope()` feature flag
2. ❌ Does NOT implement tool-based cache marker path (Path A)
3. ❌ Does NOT implement global cache boundary path (Path B)
4. ❌ Implements only a simplified "static/dynamic split heuristic" (lines 5814-5839)
5. ❌ **Identity string always gets `cache_control`** in both modes (line 5802)
6. ❌ **System prefix scope is NEVER 'org'** — only 'ephemeral' with optional 'global'

**Plugin's simpler two-mode system:**

```javascript
if (useBoundary) {
  // Plugin guesses split point by looking for "working directory", "today's date", etc.
  const splitIndex = filtered.findIndex((block) => {
    const text = block.text.toLowerCase();
    return text.includes("working directory") || text.includes("today's date") || ...
  });

  // Static blocks → {cache_control: {type: 'ephemeral', scope: 'global', ttl: ...}}
  // Boundary marker → no cache_control
  // Dynamic blocks → no cache_control
} else {
  // Original mode: only last block gets cache_control
}
```

---

## 3. IDENTITY STRING HANDLING

### Real CC Constants

**src88/src/constants/system.ts:10-18**

```typescript
const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`;
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`;
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`;

const CLI_SYSPROMPT_PREFIX_VALUES = [DEFAULT_PREFIX, AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX, AGENT_SDK_PREFIX] as const;
```

The **real CC selects one prefix** based on `getCLISyspromptPrefix()` at line 1361-1364:

```typescript
getCLISyspromptPrefix({
  isNonInteractive: options.isNonInteractiveSession,
  hasAppendSystemPrompt: options.hasAppendSystemPrompt,
});
```

### Plugin Constants

**index.mjs:5143-5148**

```javascript
const CLAUDE_CODE_IDENTITY_STRING = "You are Claude Code, Anthropic's official CLI for Claude.";
const KNOWN_IDENTITY_STRINGS = new Set([
  CLAUDE_CODE_IDENTITY_STRING,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);
```

### ⚠️ DIVERGENCE #2: Identity String Injection

| Aspect                     | Real CC                                                                               | Plugin                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Selection Logic**        | `getCLISyspromptPrefix()` examines `isNonInteractive` + `hasAppendSystemPrompt` flags | **NONE** — always uses hardcoded `CLAUDE_CODE_IDENTITY_STRING`                                       |
| **Scope in System Prompt** | Added to system array BEFORE `buildSystemPromptBlocks()`                              | Re-injected by `buildSystemPromptBlocks()` if missing                                                |
| **Cache Handling**         | Respects `cacheScope` from `splitSysPromptPrefix()`: can be `null` or `'org'`         | Always gets `cache_control: {type: 'ephemeral'}` or `{type: 'ephemeral', scope: 'global', ttl: ...}` |

---

## 4. BILLING HEADER (Attribution Header) HANDLING

### Real CC Attribution Header

**src88/src/constants/system.ts:73-95**

```typescript
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return "";
  }

  const version = `${MACRO.VERSION}.${fingerprint}`;
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown";

  // cch=00000 placeholder is overwritten by Bun's HTTP stack with attestation token
  const cch = feature("NATIVE_CLIENT_ATTESTATION") ? " cch=00000;" : "";
  const workload = getWorkload();
  const workloadPair = workload ? ` cc_workload=${workload};` : "";
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`;

  logForDebugging(`attribution header ${header}`);
  return header;
}
```

**Key Feature: Attestation Flag (NATIVE_CLIENT_ATTESTATION)**

- When enabled: includes `cch=00000;` placeholder
- Bun's native HTTP stack overwrites the zeros with computed hash
- Server verifies to confirm request from real CC client

### Plugin Attribution Header

**index.mjs:5568-5592**

```javascript
function buildAnthropicBillingHeader(version, firstUserMessage, provider) {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "unknown";
  const fingerprint = computeBillingCacheHash(firstUserMessage || "", version);
  const ccVersion = `${version}.${fingerprint}`;
  // Fix #4: cch is a static "00000" placeholder for Bun's native client attestation.
  const isBedrock = provider === "bedrock" || provider === "anthropicAws";
  const cchPart = isBedrock ? "" : " cch=00000;";
  let header = `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${entrypoint};${cchPart}`;
  const workload = process.env.CLAUDE_CODE_WORKLOAD;
  if (workload) {
    const safeWorkload = workload.replace(/[;\s\r\n]/g, "_");
    header = header.replace(/;$/, ` cc_workload=${safeWorkload};`);
  }
  return header;
}
```

### ⚠️ DIVERGENCE #3: Attestation Flag Handling

| Aspect                     | Real CC                                                      | Plugin                                                                |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Attestation Check**      | `feature('NATIVE_CLIENT_ATTESTATION')` — feature flag-driven | **Hardcoded logic** — checks `provider !== bedrock/anthropicAws`      |
| **Placeholder Logic**      | Only adds `cch=00000` if feature enabled                     | Always adds `cch=00000` for non-Bedrock providers                     |
| **Scope in System Prompt** | Always `cacheScope: null` (never cached)                     | Always `{type: "text", text: billingHeader}` — no cache_control field |

**Real CC Comment (line 3222):**

```typescript
// IMPORTANT: Do not add any more blocks for caching or you will get a 400
return splitSysPromptPrefix(systemPrompt, {
  skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
}).map(block => {
  return {
    type: 'text' as const,
    text: block.text,
    ...(enablePromptCaching && block.cacheScope !== null && {
      cache_control: getCacheControl({...}),
    }),
  }
})
```

The real CC applies `cache_control` **only when `cacheScope !== null`**, which means the attribution header (with `cacheScope: null`) **never gets cache_control**.

---

## 5. CACHE_CONTROL OBJECT STRUCTURE

### Real CC getCacheControl()

**src88/src/services/api/claude.ts:358-374**

```typescript
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope;
  querySource?: QuerySource;
} = {}): {
  type: "ephemeral";
  ttl?: "1h";
  scope?: CacheScope;
} {
  return {
    type: "ephemeral",
    ...(should1hCacheTTL(querySource) && { ttl: "1h" }),
    ...(scope === "global" && { scope }),
  };
}
```

**Outcomes:**

- No scope, 0h TTL: `{type: 'ephemeral'}`
- No scope, 1h TTL: `{type: 'ephemeral', ttl: '1h'}`
- Global scope, 0h TTL: `{type: 'ephemeral', scope: 'global'}`
- Global scope, 1h TTL: `{type: 'ephemeral', scope: 'global', ttl: '1h'}`
- **Org scope**: NOT passed to `getCacheControl()` — org-scoped blocks get converted to `{type: 'ephemeral', ttl: ...}` by map function

### Plugin getCacheControlForPolicy()

**index.mjs:5738-5744**

```javascript
function getCacheControlForPolicy(cachePolicy) {
  if (!cachePolicy) return { type: "ephemeral" };
  if (cachePolicy.ttl === "off" || cachePolicy.ttl_supported === false) {
    return { type: "ephemeral" };
  }
  return { type: "ephemeral", ttl: cachePolicy.ttl };
}
```

This function is **NOT USED** in the plugin's `buildSystemPromptBlocks()` — only in title generator request handling.

Instead, plugin builds cache_control inline:

```javascript
const baseCacheControl = hasTtl ? { type: "ephemeral", ttl: effectiveCachePolicy.ttl } : { type: "ephemeral" };
const globalCacheControl = hasTtl
  ? { type: "ephemeral", scope: "global", ttl: effectiveCachePolicy.ttl }
  : { type: "ephemeral", scope: "global" };
```

### ⚠️ DIVERGENCE #4: Cache Control & TTL

| Aspect                 | Real CC                                                              | Plugin                                                |
| ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| **Org-Scope Handling** | Blocks with `cacheScope: 'org'` get `{type: 'ephemeral', ttl: '1h'}` | No 'org' scope — `scope` field only used for 'global' |
| **TTL Determination**  | `should1hCacheTTL(querySource)` checks GrowthBook + user eligibility | `signature.cachePolicy.ttl` hardcoded or from config  |
| **Scope Values**       | Supports `null`, `'global'`, `'org'`                                 | Only uses `null` and `'global'`; no `'org'`           |

---

## 6. BLOCK ORDERING IN SYSTEM PROMPT

### Real CC Order (splitSysPromptPrefix output)

1. **Attribution header** (if present) → `cacheScope: null`
2. **System prefix** (identity string) → `cacheScope: 'org'` OR `null` (depends on path)
3. **Rest of system** (tools, instructions, etc.) → `cacheScope: 'org'` OR `'global'` OR `null` (depends on path)

### Plugin Order

1. **Billing header** (if enabled) → no cache_control field
2. **Identity block** → `cache_control: {type: 'ephemeral'}` (or with global + ttl)
3. **Filtered blocks** → scattered with optional cache_control based on boundary

**Both systems filter the input before reassembling:**

**Real CC (splitSysPromptPrefix, line 339-345):**

```typescript
for (const prompt of systemPrompt) {
  if (!prompt) continue;
  if (prompt === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue; // Skip boundary
  if (prompt.startsWith("x-anthropic-billing-header")) {
    attributionHeader = prompt; // Extract
  } else if (CLI_SYSPROMPT_PREFIXES.has(prompt)) {
    systemPromptPrefix = prompt; // Extract
  } else {
    rest.push(prompt); // Accumulate
  }
}
```

**Plugin (buildSystemPromptBlocks, line 5769-5771):**

```javascript
const filtered = sanitized.filter(
  (item) => !item.text.startsWith("x-anthropic-billing-header:") && !KNOWN_IDENTITY_STRINGS.has(item.text),
);
```

---

## 7. NATIVE_CLIENT_ATTESTATION IMPACT ON SYSTEM PROMPT

### Real CC Behavior

The `NATIVE_CLIENT_ATTESTATION` feature flag **affects only the attribution header**, NOT the system prompt structure:

**src88/src/constants/system.ts:82**

```typescript
const cch = feature("NATIVE_CLIENT_ATTESTATION") ? " cch=00000;" : "";
```

This adds/removes `cch=00000;` from the header string, but does **NOT** change:

- Block ordering
- Cache scoping
- Identity string handling

### Plugin Behavior

No feature flag handling for attestation — **hardcoded based on provider**:

**index.mjs:5582-5583**

```javascript
const isBedrock = provider === "bedrock" || provider === "anthropicAws";
const cchPart = isBedrock ? "" : " cch=00000;";
```

System prompt structure is **unaffected** — no feature flag checking.

---

## 8. SYSTEM PROMPT DYNAMIC BOUNDARY MARKER

### Real CC Boundary Marker

**src88/src/utils/api.ts & src/constants/prompts.ts**

The marker `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is used to **split blocks at cache boundary**:

- Blocks before boundary → `cacheScope: 'global'`
- Boundary itself → included in output, no cache_control
- Blocks after boundary → `cacheScope: null` (dynamic, not cached)

### Plugin Boundary Marker

The plugin has `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` but uses it **only as a split hint**, not as a precise API boundary marker. Lines 5814-5839 use a heuristic search:

```javascript
const splitIndex = filtered.findIndex((block) => {
  const text = block.text.toLowerCase();
  return (
    text.includes("working directory") ||
    text.includes("today's date") ||
    text.includes("current date") ||
    text.includes("environment") ||
    text.includes("platform:")
  );
});
```

If found, uses that as boundary; otherwise uses `Math.ceil(filtered.length / 2)` — **NOT a precise marker match**.

---

## 9. SUMMARY TABLE: CRITICAL DIVERGENCES

> **Status: ALL RESOLVED** (2026-04-07). See resolution column for implementation details.

| #      | Category                  | Real CC                                              | Plugin (before)                                   | Resolution                                                                                |
| ------ | ------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **1**  | Function signature        | 3 params: systemPrompt, enablePromptCaching, options | 2 params: system, signature                       | RESOLVED: Delegated to `splitSysPromptPrefix()` + `getCacheControlForScope()`             |
| **2**  | Cache scoping paths       | 3 distinct paths (tool-based, boundary, fallback)    | 2 simplified modes (boundary heuristic, original) | RESOLVED: 3 paths implemented (A/C unified + B). Wire output matches real CC exactly.     |
| **3**  | Identity string selection | Dynamic via `getCLISyspromptPrefix()` flags          | Hardcoded to `DEFAULT_PREFIX`                     | RESOLVED: Dynamic `getCLISyspromptPrefix()` selects based on env vars.                    |
| **4**  | Org-scope support         | Full support: `cacheScope: 'org'`                    | None: only 'global' and null                      | RESOLVED: `getCacheControlForScope('org')` → `{type:'ephemeral', ttl}` (no scope on wire) |
| **5**  | Attestation handling      | Feature flag `NATIVE_CLIENT_ATTESTATION`             | Hardcoded provider check                          | ACCEPTED: Provider check is functionally equivalent (CC enables for all non-Bedrock)      |
| **6**  | Identity cache_control    | Conditional (null in boundary mode)                  | Always present (ephemeral or global)              | RESOLVED: `cacheScope: null` in boundary mode → no `cache_control` on wire                |
| **7**  | Attribution header cache  | Always null (never cached)                           | No cache_control field                            | RESOLVED: `cacheScope: null` → `cache_control` omitted (identical wire result)            |
| **8**  | Boundary detection        | Explicit marker match                                | Heuristic string search                           | RESOLVED: Exact match on `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` constant                        |
| **9**  | TTL determination         | `should1hCacheTTL(querySource)` with GrowthBook      | Static from config                                | ACCEPTED: Default '1h' matches real CC for majority of users. No GrowthBook available.    |
| **10** | Block assembly            | Via delegation to `splitSysPromptPrefix()`           | Direct inline logic                               | RESOLVED: `splitSysPromptPrefix()` delegation mirrors real CC architecture                |

---

## 10. RECOMMENDATIONS FOR FIX PRIORITY

> **All items below have been addressed.** Kept for historical reference.

### Must Fix (Blocking Cache Correctness) — DONE

1. ~~**Implement three-path cache scoping** instead of two modes~~ — Paths A/C unified (identical wire) + Path B boundary mode
2. ~~**Support 'org' scope** in addition to 'global'~~ — `getCacheControlForScope('org')` returns `{type:'ephemeral'}` without scope field
3. ~~**Respect skipGlobalCacheForSystemPrompt flag** (tool-based marker path)~~ — Path A wire output identical to Path C, both covered
4. ~~**Implement precise boundary marker detection** (not heuristic)~~ — Exact string match on `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`

### Should Fix (Feature Parity) — DONE

5. ~~**Add feature flag support** for `NATIVE_CLIENT_ATTESTATION`~~ — Accepted: provider check is functionally equivalent
6. ~~**Implement `getCLISyspromptPrefix()` selection logic** for identity string~~ — Dynamic via env var detection
7. ~~**Make identity block cache_control conditional** on cache path~~ — null in boundary, org in default

### Could Fix (Low Impact) — DONE/ACCEPTED

8. ~~**Implement GrowthBook-aware TTL selection**~~ — Accepted: static '1h' matches default behavior
9. ~~**Add org-scope handling in getCacheControl()**~~ — `getCacheControlForScope()` handles all three scopes
10. ~~**Refactor to use delegation pattern**~~ — `splitSysPromptPrefix()` + `getCacheControlForScope()` delegation
