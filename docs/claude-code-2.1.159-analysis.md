# Claude Code 2.1.159 Analysis

Date: 2026-06-01
Analyst: static binary extraction (linux-x64 native Bun binary, Bun-embedded JS)
Compared against: 2.1.154 (plugin baseline)
Plugin currently emulates: 2.1.154
Latest published: 2.1.159

---

## 1. Package / binary metadata

| Field       | 2.1.154                                  | 2.1.159                                      |
| ----------- | ---------------------------------------- | -------------------------------------------- |
| Package     | @anthropic-ai/claude-code@2.1.154        | @anthropic-ai/claude-code@2.1.159            |
| Version     | 2.1.154                                  | 2.1.159                                      |
| Build time  | 2026-05-28T12:27:24Z                     | **2026-05-31T16:22:50Z**                     |
| Git SHA     | b84d2da9ada13121515426fc644786a303e9ac53 | **dd8c11fc8d05cea0b2b9fc8f5a99a5c5c5dffc9b** |
| SDK bundled | @anthropic-ai/sdk 0.94.0                 | @anthropic-ai/sdk **0.94.0** (no bump)       |

Distribution model unchanged: the npm `@anthropic-ai/claude-code` package is a thin
wrapper (`install.cjs` + `cli-wrapper.cjs`) that hardlinks a per-platform native
binary from `optionalDependencies`. The Anthropic SDK version is no longer a
string in a JS bundle but is still recoverable from the embedded blob:
`x-stainless-package-version` binds to `NQ="0.94.0"`.

---

## 2. Executive Summary

**Wire-level drift from 2.1.154: MINIMAL.** Exactly one registered beta was added,
and it is GrowthBook-gated (default-off). OAuth, stainless headers, billing header,
`anthropic-version`, and the always-on beta set are otherwise byte-identical.

The single change: `summarize-connector-text-2026-03-13` (internal label
`narration_summaries`) was **revived** into the per-request beta builder. It had
been a dead/no-op slot since v2.1.90. In 2.1.159 the dead slot (`v76;` in the
2.1.154 builder) became:

```js
if (_ && t36()) $.push(QY$); // QY$ = narration_summaries beta
// t36()  === s36("pewter_owl_header")  → GrowthBook feature flag
```

with an additional fast-mode strip downstream:

```js
if (q.type === "disabled" || !!z.fastMode) M = M.filter((pH) => pH !== QY$);
```

Because `pewter_owl_header` is a server-controlled GrowthBook flag (default-off),
real Claude Code does **not** emit this beta for the vast majority of accounts.
**The plugin must keep it off by default** — emitting it unconditionally would be
an over-broadcast fingerprint. This mirrors the existing handling of
`mid-conversation-system-2026-04-07` (registered, GrowthBook-gated, not always-on).

---

## 3. Mimicry impact (summary)

| Area                          | Status                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Wire-protocol fingerprint     | Minimal drift. One gated beta added; nothing removed.                            |
| OAuth login flow              | **No change.** client_id, scopes, token endpoints byte-identical (see §5).       |
| Always-on beta header set     | Unchanged. `narration_summaries` is gated by `pewter_owl_header` (default-off).  |
| `x-` headers                  | New `x-is-refusal-fallback` — gated by server `convolute_arcades` (default-off). |
| `anthropic-version`           | Still `2023-06-01`.                                                              |
| `x-stainless-package-version` | Still `0.94.0`.                                                                  |
| Billing header                | Format unchanged.                                                                |
| Beta registry                 | 24 entries (was 23): `+ narration_summaries`.                                    |

**TL;DR:** Bump the tracked version + build markers to 2.1.159. Add
`summarize-connector-text-2026-03-13` to `EXPERIMENTAL_BETA_FLAGS` (disable-guard /
forward-compat) and to `BETA_SHORTCUTS`. Do **NOT** add it to any always-on path.
Do **NOT** emit `x-is-refusal-fallback`.

---

## 4. Beta registry diff (rD() table)

The registry constructor was minified from `_W(...)` (2.1.154) to `rD(...)` (2.1.159);
the entries are otherwise identical except for one addition.

### Added in 2.1.159

| Internal label        | Header                                | Always-On?                                                                            |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `narration_summaries` | `summarize-connector-text-2026-03-13` | No — gated by GrowthBook `pewter_owl_header`, first-party only, stripped in fast-mode |

### Unchanged (23 entries, identical to 2.1.154)

`advisor_tool`, `afk_mode`, `cache_diagnosis`, `ccr_byoc`, `context_hint`,
`context_management`, `effort`, `environments`, `extended_cache_ttl`, `files_api`,
`interleaved_thinking`, `long_context` (context-1m), `mcp_servers`,
`mid_conversation_system`, `prompt_caching_scope`, `redact_thinking`, `speed`
(fast-mode), `structured_outputs`, `task_budgets`, `thinking_token_count`,
`tool_search` (advanced-tool-use), `tool_search` (tool-search-tool), `web_search`.

### Always-on builder diff (the decisive evidence)

2.1.154 (`includes("haiku")` anchor — note the `v76;` no-op slot):

```js
…$.push(LY$);                                    // redact_thinking
if(dr$&&_&&EO$(H)&&V$("tengu_chert_bezel",!1))$.push(dr$);  // thinking_token_count
v76;                                             // ← dead slot (removed beta)
let z=…USE_API_CONTEXT_MANAGEMENT&&!1,A=qH5(H);  // context_management (&&!1 → off)
```

2.1.159 (same region — the no-op became the revived push):

```js
…$.push(FY$);                                    // redact_thinking
if(yo$&&_&&tf$(H)&&Z$("tengu_chert_bezel",!1))$.push(yo$);  // thinking_token_count
if(_&&t36())$.push(QY$);                         // ← narration_summaries (NEW)
let z=…USE_API_CONTEXT_MANAGEMENT&&!1,A=mH5(H);  // context_management (&&!1 → off)
```

Everything else in the builder (claude-code, context-1m, prompt-caching-scope,
interleaved-thinking, redact-thinking, thinking-token-count gating, context-management
hardcoded-off, structured-outputs from caller output format, `tool.strict` behind
`tengu_tool_pear`, web-search vertex/foundry)
is structurally identical.

---

## 5. OAuth — byte-identical (no drift)

Extracted from both binaries and diffed:

| Constant        | Value (both 2.1.154 and 2.1.159)                 |
| --------------- | ------------------------------------------------ |
| client_id       | `9d1c250a-e61b-44d9-88ed-5944d1962f5e`           |
| scopes          | `org:create_api_key user:inference user:profile` |
| token endpoints | `/oauth/token`, `/v1/oauth/token`                |

No change to the OAuth login flow, PKCE, token exchange, or refresh. `lib/oauth.mjs`
requires no changes for 2.1.159.

---

## 6. New header: `x-is-refusal-fallback`

```js
var _B1 = "convolute_arcades",
  WMK = "x-is-refusal-fallback";
function ZMK() {
  return S$().clientDataCache?.convolute_arcades === true;
}
```

The header is emitted only when the server-pushed client-data flag
`convolute_arcades` is `true`. `convolute_arcades` is a GrowthBook/clientData flag,
default-off. Real CC does not send this header for default accounts.

**Plugin action: none.** Continue omitting it — adding it unconditionally would be
an over-broadcast fingerprint. It is a per-request retry marker the server expects
only when it has opted the account into the refusal-fallback experiment.

---

## 7. New telemetry events (vs 2.1.154)

18 added, 1 removed (`tengu_anchor_tide`). Wire-relevant ones:

| Event                                          | Meaning / relevance                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tengu_reorder_tool_uses_skipped_for_thinking` | CC reorders `tool_use` blocks but **skips when `thinking`/`redacted_thinking` present**. Corroborates the byte-identity contract the plugin already enforces.               |
| `tengu_byte_stream_idle_timeout_ms`            | Client-side stream idle-timeout (ms), read from env `*_STREAM_IDLE_TIMEOUT_MS` or GrowthBook. Robustness opportunity — abort/retry stalled streams earlier. No fingerprint. |
| `tengu_pewter_owl_model`                       | `pewter_owl` model/feature family (same family as `narration_summaries`).                                                                                                   |
| `tengu_kairos_loop_keepalive`, `tengu_loop_*`  | Streaming keepalive / loop lifecycle. Local; no wire impact.                                                                                                                |

Local-only (no wire impact): `tengu_plugins_sync_*` (×7), `tengu_compass_dial`,
`tengu_coordinator_panel`, `tengu_cedar_marsh`, `tengu_fotw_nudge_shown`,
`tengu_plugin_install_failed`.

---

## 8. Recommended plugin changes

### Required for version tracking

- `lib/request-headers.mjs`: `FALLBACK_CLAUDE_CLI_VERSION` → `2.1.159`;
  `CLAUDE_CODE_BUILD_TIME` → `2026-05-31T16:22:50Z`;
  `CLAUDE_CODE_GIT_SHA` → `dd8c11fc8d05cea0b2b9fc8f5a99a5c5c5dffc9b`;
  add `CLI_TO_SDK_VERSION` rows `2.1.155`–`2.1.159` → `0.94.0`.

### Mimicry (forward-compat, low risk)

- Add `summarize-connector-text-2026-03-13` to `EXPERIMENTAL_BETA_FLAGS`
  (so `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` can strip it and the registry is
  complete) and a `BETA_SHORTCUTS` alias (`connector-text` / `narration-summaries`).
  **Keep it out of every always-on path.** Default behavior stays: not emitted.
- If the plugin ever exposes manual opt-in for this beta, replicate CC's fast-mode
  strip: do not send it when `speed:"fast"` is in the body.

### Robustness / performance (optional)

- Consider a client-side byte-stream idle timeout (parity with
  `tengu_byte_stream_idle_timeout_ms`): abort + retry a stream that has produced no
  bytes for N ms, instead of waiting for the full request timeout. Complements the
  existing ECONNRESET keepalive-disable recovery.

### No action (correctly already handled)

- OAuth: unchanged.
- `x-is-refusal-fallback`: keep omitting.
- `token_efficient_tools`: stays inert/deprecated — `token-efficient-tools-2026-03-28`
  does not exist in real CC. Do not emit.
- Thinking-block byte-identity guard: already correct (corroborated by
  `tengu_reorder_tool_uses_skipped_for_thinking`).
