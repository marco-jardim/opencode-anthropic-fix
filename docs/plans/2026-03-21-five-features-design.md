# Design: 5 Performance Features + Toast Fix

**Date:** 2026-03-21
**Status:** Approved
**Scope:** opencode-anthropic-fix plugin v0.0.28

---

## Features

### 1. Auto-compaction Enhancement

- Hook `experimental.session.compacting` to inject account/rate-limit context
- Track cumulative tokens from SSE `message_delta` usage in fetch interceptor
- On "prompt too long" (400): trim oldest non-system messages, retry once
- Toast warning at 80% context utilization

### 2. Predictive Rate Limit Avoidance

- Parse `anthropic-ratelimit-unified-*` headers (5h + 7d windows)
- Prediction: `risk = utilization / (1 - timeElapsedFraction)`
- When risk > 0.85: preemptive account switch before 429
- Toast: "Account X at 85% quota, switching to Y"

### 3. Deferred Tool Loading (opt-in)

- When tools > threshold (default 15): strip schemas, inject names as system text
- Register `tool_search` custom tool via `tool()` to serve schemas on demand
- Config: `deferred_tools: { enabled: false, threshold: 15 }`

### 4. Multi-layer Retry with Graceful Degradation

- (a) Disable fast mode on 429/529 for remainder of session
- (b) On `stop_reason: "max_tokens"`: inject continuation prompt, retry (max 3)
- (c) After 3 consecutive 529s: fallback model (opus→sonnet, sonnet→haiku)

### 5. Cache Breakpoint Optimization

- Add `cache_control` to last content block of each user message
- Skip for round-robin (cache defeated by account rotation)
- Track cache hit rate, warn if below threshold

### 6. Toast Bug Fix + New Informative Toasts

- Fix: ensure toasts fire for all informative events, not just account switch
- Add: token usage toast per turn (input/output/cache)
- Add: cost accumulator toast (session total)
- Add: rate limit utilization toast on high usage
- Add: context window utilization toast approaching limits
- Config: `usage_toast: true` to enable per-turn usage toasts

## Architecture

All features are implemented within the existing fetch interceptor + plugin
lifecycle. No new files — extensions to `index.mjs` only, plus one custom tool
registration for deferred loading.

## Risk

- Feature 3 (deferred tools) is highest risk — off by default
- Feature 4c (model fallback) modifies request body model field — could confuse OpenCode's model tracking
