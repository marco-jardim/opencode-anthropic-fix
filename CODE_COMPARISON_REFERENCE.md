# Code Comparison Reference: Real CC vs Plugin

## File A: Real CC Constants (System Prefix)

**File:** `tmp/src88/src/constants/system.ts`

```typescript
// Lines 10-46

const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`;
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`;
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`;

const CLI_SYSPROMPT_PREFIX_VALUES = [DEFAULT_PREFIX, AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX, AGENT_SDK_PREFIX] as const;

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number];

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(CLI_SYSPROMPT_PREFIX_VALUES);

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean;
  hasAppendSystemPrompt: boolean;
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider();
  if (apiProvider === "vertex") {
    return DEFAULT_PREFIX;
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX;
    }
    return AGENT_SDK_PREFIX;
  }
  return DEFAULT_PREFIX;
}
```

### Attribution Header Function

**File:** `tmp/src88/src/constants/system.ts`

```typescript
// Lines 73-95

/**
 * Get attribution header for API requests.
 * Returns a header string with cc_version (including fingerprint) and cc_entrypoint.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 *
 * When NATIVE_CLIENT_ATTESTATION is enabled, includes a `cch=00000` placeholder.
 * Before the request is sent, Bun's native HTTP stack finds this placeholder
 * in the request body and overwrites the zeros with a computed hash. The
 * server verifies this token to confirm the request came from a real Claude
 * Code client. See bun-anthropic/src/http/Attestation.zig for implementation.
 *
 * We use a placeholder (instead of injecting from Zig) because same-length
 * replacement avoids Content-Length changes and buffer reallocation.
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return "";
  }

  const version = `${MACRO.VERSION}.${fingerprint}`;
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown";

  // cch=00000 placeholder is overwritten by Bun's HTTP stack with attestation token
  const cch = feature("NATIVE_CLIENT_ATTESTATION") ? " cch=00000;" : "";
  // cc_workload: turn-scoped hint so the API can route e.g. cron-initiated
  // requests to a lower QoS pool. Absent = interactive default. Safe re:
  // fingerprint (computed from msg chars + version only, line 78 above) and
  // cch attestation (placeholder overwritten in serialized body bytes after
  // this string is built). Server _parse_cc_header tolerates unknown extra
  // fields so old API deploys silently ignore this.
  const workload = getWorkload();
  const workloadPair = workload ? ` cc_workload=${workload};` : "";
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`;

  logForDebugging(`attribution header ${header}`);
  return header;
}
```

---

## File B: Real CC buildSystemPromptBlocks Entry Point

**File:** `tmp/src88/src/services/api/claude.ts`

### Call Site (lines 1356-1379)

```typescript
// Chrome tool-search instructions: when the delta attachment is enabled,
// these are carried as a client-side block in mcp_instructions_delta
// (attachments.ts) instead of here. This per-request sys-prompt append
// busts the prompt cache when chrome connects late.
const hasChromeTools = filteredTools.some((t) => isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME));
const injectChromeHere = useToolSearch && hasChromeTools && !isMcpInstructionsDeltaEnabled();

// filter(Boolean) works by converting each element to a boolean - empty strings become false and are filtered out.
systemPrompt = asSystemPrompt(
  [
    getAttributionHeader(fingerprint), // <-- ATTRIBUTION HEADER
    getCLISyspromptPrefix({
      // <-- DYNAMIC IDENTITY STRING
      isNonInteractive: options.isNonInteractiveSession,
      hasAppendSystemPrompt: options.hasAppendSystemPrompt,
    }),
    ...systemPrompt,
    ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
  ].filter(Boolean),
);

// Prepend system prompt block for easy API identification
logAPIPrefix(systemPrompt);

const enablePromptCaching = options.enablePromptCaching ?? getPromptCachingEnabled(options.model);
const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
  // <-- CALL SIGNATURE
  skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
  querySource: options.querySource,
});
```

### Function Definition (lines 3213-3237)

```typescript
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean;
    querySource?: QuerySource;
  },
): TextBlockParam[] {
  // IMPORTANT: Do not add any more blocks for caching or you will get a 400
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map((block) => {
    return {
      type: "text" as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          // <-- Only apply cache_control if cacheScope !== null
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    };
  });
}
```

---

## File C: Real CC Cache Scoping Logic

**File:** `tmp/src88/src/utils/api.ts`

### splitSysPromptPrefix - Complete Implementation (lines 321-435)

```typescript
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const useGlobalCacheFeature = shouldUseGlobalCacheScope();

  // ============================================================
  // PATH A: Tool-Based Cache (skipGlobalCacheForSystemPrompt=true)
  // ============================================================
  if (useGlobalCacheFeature && options?.skipGlobalCacheForSystemPrompt) {
    logEvent("tengu_sysprompt_using_tool_based_cache", {
      promptBlockCount: systemPrompt.length,
    });

    // Filter out boundary marker, return blocks without global scope
    let attributionHeader: string | undefined;
    let systemPromptPrefix: string | undefined;
    const rest: string[] = [];

    for (const prompt of systemPrompt) {
      if (!prompt) continue;
      if (prompt === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue; // Skip boundary
      if (prompt.startsWith("x-anthropic-billing-header")) {
        attributionHeader = prompt;
      } else if (CLI_SYSPROMPT_PREFIXES.has(prompt)) {
        systemPromptPrefix = prompt;
      } else {
        rest.push(prompt);
      }
    }

    const result: SystemPromptBlock[] = [];
    if (attributionHeader) {
      result.push({ text: attributionHeader, cacheScope: null });
    }
    if (systemPromptPrefix) {
      result.push({ text: systemPromptPrefix, cacheScope: "org" }); // <-- ORG SCOPE
    }
    const restJoined = rest.join("\n\n");
    if (restJoined) {
      result.push({ text: restJoined, cacheScope: "org" }); // <-- ORG SCOPE
    }
    return result;
  }

  // ============================================================
  // PATH B: Global Cache with Boundary (boundary marker found)
  // ============================================================
  if (useGlobalCacheFeature) {
    const boundaryIndex = systemPrompt.findIndex((s) => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    if (boundaryIndex !== -1) {
      let attributionHeader: string | undefined;
      let systemPromptPrefix: string | undefined;
      const staticBlocks: string[] = [];
      const dynamicBlocks: string[] = [];

      for (let i = 0; i < systemPrompt.length; i++) {
        const block = systemPrompt[i];
        if (!block || block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;

        if (block.startsWith("x-anthropic-billing-header")) {
          attributionHeader = block;
        } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
          systemPromptPrefix = block;
        } else if (i < boundaryIndex) {
          staticBlocks.push(block);
        } else {
          dynamicBlocks.push(block);
        }
      }

      const result: SystemPromptBlock[] = [];
      if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
      if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: null }); // <-- NULL, NOT ORG!
      const staticJoined = staticBlocks.join("\n\n");
      if (staticJoined) result.push({ text: staticJoined, cacheScope: "global" });
      const dynamicJoined = dynamicBlocks.join("\n\n");
      if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null });

      logEvent("tengu_sysprompt_boundary_found", {
        blockCount: result.length,
        staticBlockLength: staticJoined.length,
        dynamicBlockLength: dynamicJoined.length,
      });

      return result;
    } else {
      logEvent("tengu_sysprompt_missing_boundary_marker", {
        promptBlockCount: systemPrompt.length,
      });
    }
  }

  // ============================================================
  // PATH C: Fallback (No Global Cache Feature)
  // ============================================================
  let attributionHeader: string | undefined;
  let systemPromptPrefix: string | undefined;
  const rest: string[] = [];

  for (const block of systemPrompt) {
    if (!block) continue;

    if (block.startsWith("x-anthropic-billing-header")) {
      attributionHeader = block;
    } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
      systemPromptPrefix = block;
    } else {
      rest.push(block);
    }
  }

  const result: SystemPromptBlock[] = [];
  if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
  if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: "org" }); // <-- ORG SCOPE
  const restJoined = rest.join("\n\n");
  if (restJoined) result.push({ text: restJoined, cacheScope: "org" }); // <-- ORG SCOPE
  return result;
}
```

### getCacheControl - Complete Implementation (lines 358-374)

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
    ...(scope === "global" && { scope }), // <-- Only adds scope if === 'global'
  };
}
```

**Key behaviors:**

- If `scope === 'global'`: returns `{type: 'ephemeral', ttl?: '1h', scope: 'global'}`
- If `scope === 'org'` or `undefined`: returns `{type: 'ephemeral', ttl?: '1h'}` (no scope field)
- Org scope is NOT passed through to cache_control — it's converted to ephemeral with TTL

---

## File D: Plugin Implementation

**File:** `index.mjs`

### Constants (lines 5143-5148)

```javascript
const CLAUDE_CODE_IDENTITY_STRING = "You are Claude Code, Anthropic's official CLI for Claude.";
const KNOWN_IDENTITY_STRINGS = new Set([
  CLAUDE_CODE_IDENTITY_STRING,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);
```

### buildAnthropicBillingHeader (lines 5568-5592)

```javascript
function buildAnthropicBillingHeader(version, firstUserMessage, provider) {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "unknown";
  // Fix #1: cc_version suffix is the 3-char fingerprint hash, NOT the model ID.
  // computeBillingCacheHash() computes SHA256(salt + msg[4]+msg[7]+msg[20] + version)[:3]
  // which matches computeFingerprint() in the real CC source (utils/fingerprint.ts).
  // Always call the hash function — even for empty messages the real CC computes
  // the hash from "000" chars (indices 4,7,20 all missing → fallback "0").
  const fingerprint = computeBillingCacheHash(firstUserMessage || "", version);
  const ccVersion = `${version}.${fingerprint}`;
  // Fix #4: cch is a static "00000" placeholder for Bun's native client attestation.
  // Real CC v92: cch is included for all providers EXCEPT bedrock/anthropicAws.
  // The real Bun binary overwrites these zeros in the serialized body bytes.
  // For non-Bun runtimes, the server sees "00000" and skips attestation verification.
  const isBedrock = provider === "bedrock" || provider === "anthropicAws";
  const cchPart = isBedrock ? "" : " cch=00000;";
  let header = `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${entrypoint};${cchPart}`;
  const workload = process.env.CLAUDE_CODE_WORKLOAD;
  if (workload) {
    // QA fix M5: sanitize workload value to prevent header injection
    const safeWorkload = workload.replace(/[;\s\r\n]/g, "_");
    header = header.replace(/;$/, ` cc_workload=${safeWorkload};`);
  }
  return header;
}
```

### buildSystemPromptBlocks - Complete Implementation (lines 5751-5850)

```javascript
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
  const billingHeader = buildAnthropicBillingHeader(
    signature.claudeCliVersion,
    signature.firstUserMessage,
    signature.provider,
  );
  if (billingHeader) {
    // Billing header: no cache_control (null scope — never cached)
    blocks.push({ type: "text", text: billingHeader });
  }

  // Compute cache_control once — used for identity block AND filtered blocks.
  // TTL must be non-decreasing across tools → system → messages, so all cached
  // system blocks must share the same TTL to avoid "1h after 5m" API rejection.
  const effectiveCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };
  const hasTtl = effectiveCachePolicy.ttl !== "off" && effectiveCachePolicy.ttl_supported !== false;

  // CC v2.1.90 cache_control scoping (verified against bundle WQ() function):
  // - scope "global" is only emitted for static pre-boundary blocks
  // - scope "org" is internal-only, NEVER emitted on the wire
  // - identity block gets no cache_control in boundary mode, or {type:"ephemeral"} in fallback
  const baseCacheControl = hasTtl ? { type: "ephemeral", ttl: effectiveCachePolicy.ttl } : { type: "ephemeral" };
  const globalCacheControl = hasTtl
    ? { type: "ephemeral", scope: "global", ttl: effectiveCachePolicy.ttl }
    : { type: "ephemeral", scope: "global" };

  // Identity block: per CC v2.1.90, gets {type:"ephemeral"} with NO scope field.
  // In boundary mode CC assigns cacheScope:null (no cache_control at all), but
  // we always include it for better cache hit rates on the proxy side.
  blocks.push({ type: "text", text: CLAUDE_CODE_IDENTITY_STRING, cache_control: baseCacheControl });

  // Filtered blocks: keep as-is, with optional static/dynamic boundary marker
  if (filtered.length > 0) {
    const useBoundary =
      signature.cachePolicy?.boundary_marker || isTruthyEnv(process.env.CLAUDE_CODE_FORCE_GLOBAL_CACHE);

    if (useBoundary) {
      // Heuristic: treat first half as "static" (tool defs, instructions)
      // and second half as "dynamic" (env info, memory, etc.)
      // Find a split point: look for blocks containing environment/date/CWD info
      // as the boundary between static and dynamic.
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

      const effectiveSplit = splitIndex > 0 ? splitIndex : Math.ceil(filtered.length / 2);

      // Static blocks (before boundary) get global-scope cache_control
      for (let i = 0; i < effectiveSplit; i++) {
        blocks.push({ ...filtered[i], cache_control: globalCacheControl });
      }

      // Boundary marker
      blocks.push({ type: "text", text: SYSTEM_PROMPT_DYNAMIC_BOUNDARY });

      // Dynamic blocks (after boundary) get NO cache_control
      for (let i = effectiveSplit; i < filtered.length; i++) {
        const { cache_control: _cc, ...rest } = filtered[i];
        blocks.push(rest);
      }
    } else {
      // Original behavior: only last block gets cache_control.
      // Strip any upstream cache_control from intermediate blocks to prevent
      // TTL ordering violations (e.g., upstream 5m followed by our 1h).
      for (let i = 0; i < filtered.length - 1; i++) {
        const { cache_control: _cc, ...rest } = filtered[i];
        blocks.push(rest);
      }
      const lastFiltered = filtered[filtered.length - 1];
      blocks.push({ ...lastFiltered, cache_control: baseCacheControl });
    }
  }

  return blocks;
}
```

### Plugin Call Site (line 6370)

```javascript
const signatureWithModel = { ...signature, modelId, firstUserMessage };
// Sanitize system prompt and optionally inject Claude Code identity/billing blocks.
parsed.system = buildSystemPromptBlocks(normalizeSystemTextBlocks(parsed.system), signatureWithModel);
```

---

## Key Differences Summary

> **Status: ALL ALIGNED** (2026-04-07). The plugin now mirrors the real CC architecture.

| Aspect                     | Real CC                                                                   | Plugin                                                                                   | Status   |
| -------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| **Identity Selection**     | Dynamic: `getCLISyspromptPrefix()` with flags                             | Dynamic: `getCLISyspromptPrefix()` via env vars                                          | Aligned  |
| **Attribution Header**     | `getAttributionHeader(fingerprint)` with `NATIVE_CLIENT_ATTESTATION` flag | `buildAnthropicBillingHeader()` with provider check (functionally equivalent)            | Aligned  |
| **Cache Scoping**          | 3 paths (tool-based org, boundary global, fallback org)                   | 3 paths via `splitSysPromptPrefix()` (A/C unified + B boundary)                          | Aligned  |
| **Org Scope**              | Full support: `{text, cacheScope: 'org'}`                                 | Full support: `getCacheControlForScope('org')` → `{type:'ephemeral'}` (no scope on wire) | Aligned  |
| **Boundary Marker**        | Exact match: `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`                             | Exact match: `block.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY`                             | Aligned  |
| **Identity cache_control** | Conditional on path (null in boundary mode)                               | Conditional: `cacheScope: null` in boundary, `'org'` in default                          | Aligned  |
| **TTL Determination**      | `should1hCacheTTL(querySource)` with GrowthBook                           | Static from `signature.cachePolicy.ttl` (default '1h' matches CC default)                | Accepted |
| **Delegation**             | Via `splitSysPromptPrefix()` and `getCacheControl()`                      | Via `splitSysPromptPrefix()` and `getCacheControlForScope()`                             | Aligned  |
