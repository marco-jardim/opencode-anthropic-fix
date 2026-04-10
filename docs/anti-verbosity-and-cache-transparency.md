# Anti-Verbosity & Cache Transparency

## Overview

Two features added to reduce token consumption and improve cost visibility:

1. **Anti-verbosity system prompt injection** — Mirrors CC v2.1.100's `quiet_salted_ember` A/B test
2. **Cache transparency** — Real-time cache stats exposed to the TUI via file + response headers

---

## Anti-Verbosity (Task 1)

### What it does

Injects two system prompt sections when the model is **Opus 4.6**:

1. **`anti_verbosity`** — Communication style instructions that tell the model to be concise:
   - One sentence before first tool call
   - Short updates at key moments only
   - End-of-turn: 1-2 sentences max
   - No comments in code by default
   - No planning/analysis documents unless asked

2. **`numeric_length_anchors`** — Hard word-count limits:
   - Between tool calls: 25 words max
   - Final responses: 100 words max (unless task requires more)

### How it works

- Text extracted verbatim from CC v2.1.100 cli.js
- In CC: gated on `quiet_salted_ember` feature flag (server-side A/B test via `clientDataCache`)
- In our plugin: enabled by default (no server-side dependency), configurable via config
- Injected in `buildSystemPromptBlocks()` after dedup, before cache split
- Blocks flow through the normal caching pipeline (get `org` scope with TTL 1h in Path C)

### Configuration

```json
{
  "anti_verbosity": {
    "enabled": true,
    "length_anchors": true
  }
}
```

Environment variables:

- `OPENCODE_ANTHROPIC_ANTI_VERBOSITY=0|1` — Master switch
- `OPENCODE_ANTHROPIC_LENGTH_ANCHORS=0|1` — Length anchors only

### Files changed

- `lib/config.mjs` — Added `anti_verbosity` config section, typedef, validation, env overrides
- `index.mjs` — Added `ANTI_VERBOSITY_SYSTEM_PROMPT` and `NUMERIC_LENGTH_ANCHORS_PROMPT` constants; injection logic in `buildSystemPromptBlocks()`; status display in `/anthropic status`

### Expected impact

Significant reduction in output tokens for Opus 4.6 sessions. The numeric length anchors alone should cut output by 50-70% for typical agentic workflows (tool call → brief update → tool call pattern).

---

## Cache Transparency (Task 2)

### What it does

Exposes cache performance metrics through two channels:

1. **`cache-stats.json`** — Written to `~/.config/opencode/` (or `%APPDATA%/opencode/` on Windows) after each API turn. Contains per-turn and session-level stats.

2. **Response headers** — Custom `x-opencode-*` headers injected into every API response:
   - `x-opencode-cache-hit-rate` — Rolling average hit rate (0-1)
   - `x-opencode-cache-read-total` — Total cache read tokens this session
   - `x-opencode-session-cost` — Session cost in USD
   - `x-opencode-turns` — Number of API turns
   - `x-opencode-anti-verbosity` — "on" or "off"

### cache-stats.json format

```json
{
  "turn": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read_tokens": 45000,
    "cache_write_tokens": 2000,
    "cache_hit_rate": 0.923,
    "model": "claude-opus-4-6"
  },
  "session": {
    "turns": 5,
    "total_input": 6000,
    "total_output": 3000,
    "total_cache_read": 200000,
    "total_cache_write": 10000,
    "session_hit_rate": 0.926,
    "avg_recent_hit_rate": 0.91,
    "cost_usd": 0.4523,
    "cache_savings_usd": 2.7
  },
  "config": {
    "cache_ttl": "1h",
    "boundary_marker": false,
    "anti_verbosity": true,
    "length_anchors": true
  },
  "timestamp": "2026-04-10T08:30:00.000Z"
}
```

### Files changed

- `index.mjs` — Added `_pluginConfig` module-level ref, `writeCacheStatsFile()` function, response header injection in `transformResponse()`

---

## OpenCode TUI Changes (Task 3)

### Sidebar cache widget

New sidebar plugin `cache.tsx` that displays:

- Cache hit rate with color-coded indicator (green >=70%, yellow >=30%, red <30%)
- Cache read/write token counts (formatted as K/M)
- Cache savings in USD (from `cache-stats.json`)
- Cache TTL and anti-verbosity status

### Footer cache indicator

Added to the session footer bar:

- `75% cache` with color-coded diamond indicator
- Only shown when there's at least one assistant message with cache data

### Files changed (D:\git\opencode)

- `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/cache.tsx` — New sidebar plugin
- `packages/opencode/src/cli/cmd/tui/plugin/internal.ts` — Register cache plugin
- `packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx` — Cache hit rate in footer bar

---

## Relationship to CC v2.1.100

| Feature             | CC v2.1.100                                       | Our Plugin                       |
| ------------------- | ------------------------------------------------- | -------------------------------- |
| Anti-verbosity text | Identical                                         | Identical                        |
| Length anchors text | Identical                                         | Identical                        |
| Gate condition      | Opus 4.6 + `quiet_salted_ember` flag              | Opus 4.6 + config (default on)   |
| Server dependency   | Requires `clientDataCache`                        | None                             |
| Cache TTL 1h        | Gated on `tengu_prompt_cache_1h_config` allowlist | Default on (more aggressive)     |
| Cache transparency  | Internal metrics only                             | Exposed via file + headers + TUI |
