# Opencode fork customizations — plugin migration audit

**Last audit:** 2026-04-18
**Fork:** `marco-jardim/opencode` branch `dev` (based on `anomalyco/opencode:dev`)
**Plugin:** `opencode-anthropic-fix` ≥ v0.1.21

This document tracks which customizations in the opencode fork have been
migrated to the plugin, and justifies why the remaining ones cannot be.

---

## Migrated to plugin (reverted from fork)

These commits were reverted from the fork and reimplemented in the plugin.

| Commit      | Feature                         | Plugin location                                                                                 | Revert commit |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| `4c3f4fc19` | Stale file-read eviction        | `lib/message-transform.mjs` · `staleReadEviction` · hook `experimental.chat.messages.transform` | `d01c8c724`   |
| `797ae24d8` | Per-tool-class prune thresholds | `lib/message-transform.mjs` · `perToolClassPrune` · hook `experimental.chat.messages.transform` | `050ef3c00`   |

Gated by `token_economy_strategies.stale_read_eviction` and
`token_economy_strategies.per_tool_class_prune` (both default `false`).

**Behavioral delta vs the reverted core code:** plugin path is
**non-destructive** — the transform sees a `structuredClone` of the
session messages and mutation only affects the outbound request. The
original core prune also wrote `state.time.compacted` to storage via
`session.updatePart`, permanently erasing old tool outputs. Plugin path
keeps them intact for later inspection/replay.

---

## Hook enablers (must stay in fork)

These are **not customizations** — they are the plugin surface that the
plugin depends on. Keep in fork; candidates for upstream PR.

| Commit      | What it adds                                                        | Consumer                       |
| ----------- | ------------------------------------------------------------------- | ------------------------------ |
| `dcefeacc7` | `experimental.session.summarize` hook type in `@opencode-ai/plugin` | Plugin’s haiku rolling summary |
| `5bcdf5fda` | Wire the hook into `session/compaction.ts`                          | Plugin’s haiku rolling summary |
| `34aed6ac4` | Refactor compaction short-circuit branch                            | Code hygiene                   |
| `a3626f3b2` | Typecheck fixes (branded ID casts + env-snapshot type)              | Build                          |
| `f9f404759` | TUI slot `session_above_prompt` + `onSlashSubmit`                   | Any TUI plugin                 |
| `cfb05eaba` | TUI plugin infrastructure for slash commands with arguments         | Any TUI plugin                 |

---

## Core-only customizations (cannot be plugins today)

Each entry below explains which hook would need to exist (or what core
surface area would need exposing) before migration is possible.

### 1. Subagent scoping (`8beac06d3`)

**What it does (5 sub-features):**

- llm.ts ELSE-branch system prompt assembly for subagents
- prompt.ts skip env briefing + skill catalog for subagents
- prompt.ts skip MCP tool schemas for subagents unless `options.enableMcp`
- llm.ts header telemetry (anthropic-beta, user-agent, x-session-affinity)
- `OPENCODE_DUMP_REQUESTS` env flag

**Why not a plugin:** the three relevant hooks
(`experimental.chat.system.transform`, `experimental.chat.messages.transform`,
`tool.definition`) do not expose the agent role in their `input`.
Plugin cannot distinguish primary agent from subagent → cannot apply
subagent-specific policies. Header/request telemetry has no dedicated
hook at all (would need `chat.request.before` / `chat.response.after`).

**Upstream PR that would unblock:** add `agent?: "primary" | "subagent"`
to the input of `system.transform`, `messages.transform`, and
`tool.definition`.

---

### 2. Env snapshot cache + invalidation (`51b7b9844`, `969e265c6`)

**What it does:** caches the session environment briefing (CWD, git
state, tooling versions) per-session, invalidates on `session.deleted`
bus event.

**Why not a plugin:** lives inside an Effect `Layer` with a bus
subscription (forkScoped subscriber on `SessionEvent.Deleted`). Plugins
have no access to the internal `Bus.Service` or `Effect.Layer`
composition. The cache also needs to intercept the environment-briefing
builder directly, not the final system prompt.

**Why this probably stays core:** the integration surface is too deep
— a plugin-level equivalent would need a full session lifecycle hook
(`session.created`, `session.deleted`) plus access to a mutable
per-session key/value store. Not worth the API complexity for a perf
optimization.

---

### 3. Retry hardening for 529 / auth / billing (`61991849b`)

**What it does:** retry semantics for overloaded (529) responses, auth
failures (401), and billing errors (402) in the provider request
pipeline. Also: per-error-class logging and quota-aware account
failover coordination with the plugin’s account manager.

**Why not a plugin:** request retry is in the Effect pipeline between
serialization and transport. There is no hook surface that lets a
plugin observe a response code and decide to retry the same request.
The plugin already handles OAuth token refresh and account rotation,
but only at the provider-auth boundary, not at the per-request retry
layer.

---

### 4. Subagent cost attribution + usage telemetry (`632ff4e90`)

**What it does:** tracks token usage and cost per-subagent invocation,
shows aggregated numbers in the TUI footer.

**Why not a plugin:** two problems.

1. The telemetry emit point is internal to the session processor —
   no hook exposes per-subagent usage. Would need
   `session.subagent.metrics` hook fired after subagent completion.
2. The display side is hardcoded in the TUI footer. Even with a
   telemetry hook, the feature would split across plugin (emit) +
   TUI fork (render).

---

### 5. Claude Code skills loader (`01a27bead`, `c860552de`)

**What it does:** discovers skills from `.claude/plugins/cache/` (full
plugin tree) and flat `.md` files, merges with opencode's native
skills.

**Why not a plugin:** the skills registry is populated at startup by a
discovery pass over known roots. To extend it via plugin, opencode
would need a `skill.discover` hook with a registry builder — more
complex than the code it would replace, because discovery has
recursive tree walks, conflict resolution (`name` collisions between
sources), and skill-manifest parsing. Low ROI.

---

### 6. Claude Code commands loader (`7c0af1bee`, `8206be65f`, `47318bdaf`)

**What it does:** loads slash commands from `.claude/commands/*.md`,
merges with opencode’s native commands.

**Why not a plugin:** same problem as skills loader. Command registry
is a startup-time merge from multiple sources. Needed hook:
`command.discover` with full registry-builder semantics including
name-conflict policy.

---

### 7. Compaction threshold (`43c1a3269`)

**What it does:** triggers auto-compaction BEFORE context-overflow
signal, configured via `compaction.threshold` (fraction of context).

**Why not a plugin (for now):** compaction is triggered by the overflow
predicate in `compaction/overflow.ts`. No hook lets a plugin influence
the "should compact now?" decision. Would need a small hook:
`experimental.session.should-compact`.

**Likely migratable later:** this IS the most plausible candidate for a
future PR. Hook is small and self-contained, matching the recipe that
worked for `experimental.session.summarize`.

---

### 8. TUI footer, stats, TPS (`aad82aaeb`, `107204191`, `198304220`, `25ce15061`, `42adbe51a`)

**What it does:** enhanced footer (cache stats, token counters, tool
count, compression indicator, turn timer), moving-average TPS
calculation, semantic stat groups.

**Why not a plugin:** direct React/Ink component rendering in the TUI.
No TUI plugin surface exists for arbitrary footer content — the
existing `session_above_prompt` + `onSlashSubmit` slots are structural,
not render-extensible. A TUI plugin API for arbitrary component
injection would be a large core change.

---

### 9. CLI `--stream-stdin` + context bar (`ce54c5116`)

**What it does:** run-mode batch input via stdin, plus an inline
context-usage bar in the run-mode output header.

**Why not a plugin:** CLI-flag parsing and run-mode header rendering
are not plugin-extensible surfaces. Would need a `cli.args` hook (for
flags) and the same render extensibility as #8.

---

## Summary scoreboard

| Group                        | Commits | Status                               |
| ---------------------------- | ------- | ------------------------------------ |
| Migrated to plugin           | 2       | Done                                 |
| Hook enablers (keep in fork) | 6       | Permanent                            |
| Core-only customizations     | ~20     | Documented, not blocked on migration |

Fork is now ~5 % smaller than before this audit. The next realistic
migration target is `43c1a3269` (compaction threshold) — pursue via
upstream PR for `experimental.session.should-compact`.
