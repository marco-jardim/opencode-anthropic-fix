# Executive Summary: System Prompt Block Construction Divergences

## TL;DR

The plugin's `buildSystemPromptBlocks()` is **architecturally incompatible** with real Claude Code. The real CC uses a sophisticated 3-path cache scoping system with org-scope support and feature flags, while the plugin implements a simplified 2-path heuristic. This causes:

1. ❌ **Cache key mismatches** — system prompt blocks get different cache_control scopes
2. ❌ **TTL ordering violations** — org-scope blocks (which shouldn't cache) now cache with TTL
3. ❌ **Boundary detection fragility** — heuristic string matching instead of precise marker
4. ❌ **Feature flag gaps** — missing NATIVE_CLIENT_ATTESTATION, GrowthBook integration
5. ❌ **Identity string lock** — always uses DEFAULT_PREFIX, ignores SDK/non-interactive contexts

---

## Three Real CC Cache Scoping Paths

### Path A: Tool-Based Cache (when skipGlobalCacheForSystemPrompt=true)

```
Attribution header      → cacheScope: null        (never cached)
Identity string        → cacheScope: 'org'        (org-internal cache)
Rest of system         → cacheScope: 'org'        (org-internal cache)
```

### Path B: Global Boundary (when SYSTEM_PROMPT_DYNAMIC_BOUNDARY present)

```
Attribution header     → cacheScope: null        (never cached)
Identity string        → cacheScope: null        (NOT cached in boundary mode!)
Static blocks          → cacheScope: 'global'    (API-level cache)
[BOUNDARY MARKER]      → cacheScope: null        (no cache_control)
Dynamic blocks         → cacheScope: null        (never cached)
```

### Path C: Fallback (when no global cache feature)

```
Attribution header     → cacheScope: null        (never cached)
Identity string        → cacheScope: 'org'        (org-internal cache)
Rest of system         → cacheScope: 'org'        (org-internal cache)
```

---

## Plugin's Incompatible Implementation

### Mode 1: Heuristic Boundary (if "working directory" found)

```
Billing header         → no cache_control        (implicit null)
Identity string        → cache_control: ephemeral (WRONG! Should be null in boundary mode)
Static blocks (heuristic) → cache_control: {scope: 'global', ttl: ...}
[BOUNDARY MARKER]      → no cache_control
Dynamic blocks         → no cache_control
```

### Mode 2: Original (fallback)

```
Billing header         → no cache_control
Identity string        → cache_control: ephemeral (WRONG! Should be org-scope)
Rest of blocks         → no cache_control
Last block             → cache_control: ephemeral (WRONG! Should be org-scope)
```

---

## Critical Mismatches

| Real CC                                                | Plugin                                      | Problem                              |
| ------------------------------------------------------ | ------------------------------------------- | ------------------------------------ |
| 3 distinct paths chosen by feature logic               | 2 hardcoded paths chosen by heuristic       | Cache keys never align               |
| Org-scope support (→ converts to ephemeral TTL)        | No org-scope support                        | Org blocks lose caching efficiency   |
| Identity block cache: conditional (null/org/none)      | Identity block cache: always present        | Over-caching in boundary mode        |
| Attribution header: never cached                       | Attribution header: never cached (implicit) | OK, but API contract differs         |
| Boundary marker: exact match (`===`)                   | Boundary marker: string search (heuristic)  | Fragile to prompt changes            |
| Identity string: dynamic via `getCLISyspromptPrefix()` | Identity string: hardcoded DEFAULT_PREFIX   | Ignores non-interactive/SDK contexts |
| Attestation: feature flag driven                       | Attestation: provider check (hardcoded)     | Missing feature gating mechanism     |

---

## Why This Matters

### Cache Hit Rate Impact

- **Real CC Path A (org-scope)**: System blocks cache separately from API-level cache, enabling fine-grained reuse
- **Plugin**: Converts org-scope to ephemeral, losing org-level cache benefits
- **Symptom**: Identical system prompts in different org contexts get different cache keys

### Boundary Mode Correctness

- **Real CC Path B**: Identity block gets `cacheScope: null` (not cached) because it appears BEFORE boundary
- **Plugin**: Identity block gets `cache_control: ephemeral` regardless
- **Symptom**: Identity string changes bust the API-level cache when it shouldn't (API spec: only first block before boundary can have global scope)

### Feature Flag Gaps

- **Real CC**: Checks `feature('NATIVE_CLIENT_ATTESTATION')` to conditionally add `cch=00000`
- **Plugin**: Hardcoded `if (provider !== bedrock) add cch=00000`
- **Symptom**: When feature is disabled server-side (e.g., for security), real CC stops adding cch, but plugin continues

### Identity String Selection

- **Real CC**: 3 variants based on context (interactive vs non-interactive, SDK vs CLI)
  - `getCLISyspromptPrefix({isNonInteractive, hasAppendSystemPrompt})`
- **Plugin**: Hardcoded to `"You are Claude Code, Anthropic's official CLI for Claude."`
- **Symptom**: Agent SDK context always shows "official CLI" instead of "Claude Agent SDK"

---

## Concrete API Call Example

### Real CC System Blocks (Path C fallback)

```json
{
  "system": [
    {
      "type": "text",
      "text": "x-anthropic-billing-header: cc_version=2.1.92.abc; cc_entrypoint=vscode; cch=00000;"
    },
    {
      "type": "text",
      "text": "You are Claude Code, Anthropic's official CLI for Claude.",
      "cache_control": {
        "type": "ephemeral",
        "ttl": "1h"
      }
    },
    {
      "type": "text",
      "text": "[tools and instructions...]",
      "cache_control": {
        "type": "ephemeral",
        "ttl": "1h"
      }
    }
  ]
}
```

### Plugin System Blocks (Mode 2 fallback)

```json
{
  "system": [
    {
      "type": "text",
      "text": "x-anthropic-billing-header: cc_version=2.1.92.abc; cc_entrypoint=vscode; cch=00000;"
    },
    {
      "type": "text",
      "text": "You are Claude Code, Anthropic's official CLI for Claude.",
      "cache_control": {
        "type": "ephemeral",
        "ttl": "1h"
      }
    },
    {
      "type": "text",
      "text": "[tools and instructions...]"
    },
    {
      "type": "text",
      "text": "[last block]",
      "cache_control": {
        "type": "ephemeral",
        "ttl": "1h"
      }
    }
  ]
}
```

**Different cache keys → different prompt cache hits → worse performance**

---

## Must-Fix Issues

### Issue #1: Implement Real Three-Path Logic

Replace hardcoded two modes with feature-driven three paths:

- Path A: `if (shouldUseGlobalCacheScope() && skipGlobalCacheForSystemPrompt)` → org-scope
- Path B: `if (shouldUseGlobalCacheScope() && boundaryMarkerFound)` → global + null split
- Path C: `else` → fallback org-scope

### Issue #2: Support Org Scope

Add `cacheScope: 'org'` support (convert to ephemeral with TTL in cache_control).

### Issue #3: Fix Identity Block Cache Conditional

- Boundary mode: `cache_control: null` (not cached)
- Tool-based/fallback mode: `cache_control: {type: 'ephemeral', ttl: ...}`

### Issue #4: Precise Boundary Detection

Use exact marker match `block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY` instead of string search heuristic.

### Issue #5: Dynamic Identity String Selection

Implement `getCLISyspromptPrefix()` logic or pass it as parameter.

---

## Low-Priority Issues

- [ ] Add `feature('NATIVE_CLIENT_ATTESTATION')` check (currently provider-hardcoded)
- [ ] Integrate GrowthBook for `should1hCacheTTL()` logic
- [ ] Refactor to delegate to `splitSysPromptPrefix()` + `getCacheControl()` equivalents
- [ ] Add logging for cache path selection (debug)

---

## Files to Review

1. **Real CC Architecture**:
   - `tmp/src88/src/services/api/claude.ts` (lines 3213-3237) — main entry point
   - `tmp/src88/src/utils/api.ts` (lines 321-435) — three-path logic
   - `tmp/src88/src/constants/system.ts` (lines 10-95) — identity + attribution

2. **Plugin Current Implementation**:
   - `index.mjs` (lines 5751-5850) — buildSystemPromptBlocks
   - `index.mjs` (lines 5143-5148) — constants
   - `index.mjs` (lines 5568-5592) — billing header

3. **Documentation**:
   - `DIVERGENCE_ANALYSIS.md` — detailed comparison
   - `CODE_COMPARISON_REFERENCE.md` — side-by-side code sections

---

## Estimated Effort to Fix

- **Core Logic (Path A/B/C)**: ~200 lines, moderate complexity
- **Org Scope Support**: ~50 lines
- **Identity String Selection**: ~30 lines (or accept as parameter)
- **Boundary Marker Fix**: ~10 lines
- **Feature Flag Integration**: ~20 lines
- **Tests**: ~100 lines
- **Total**: ~400-500 lines of changes
