<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

> **Where this document came from**
>
> Like [`claude-code-2.1.280-analysis.md`](claude-code-2.1.280-analysis.md), this file is **not** a copy of the
> library's analysis. The shared library's own 2.1.329 analysis
> (`docs/protocol/versions/claude-code-2.1.329-analysis.md` in
> [`claude-code-wire-compat`](https://github.com/marco-jardim/claude-code-wire-compat), the package this plugin
> depends on for request composition) is long, offset-level forensics. This document is a plugin-authored
> **synthesis** of it, condensed to what a reader of this plugin's mimicry contract needs, with a pointer to the
> library section at every claim. It also records the **live genuine findings** the library's analysis carries
> (§4.3 there) and what the plugin did about them.
>
> **Why it lives here.** `scripts/check-invariants.mjs` expects one `docs/claude-code-<version>-analysis.md` per
> emulated version and compares the newest one against the `CLAUDE_CODE_<x>_<y>_<z>_PROFILE` symbol imported by
> `lib/mimicry/wire-compat.mjs`. The check only reads the file **name**; it asserts no heading or shape. This file
> follows the shape of the 2.1.280 analysis (provenance banner, evidence tags, numbered sections, open questions).
>
> **Status, read this first.** The plugin has **not** been repointed to the 2.1.329 library profile yet.
> `lib/mimicry/wire-compat.mjs` still binds the 2.1.280 profile, so on the wire the plugin still emulates
> 2.1.280 for everything the library composes (user agent, SDK and runtime versions, beta list, header case and
> order, body key order, `cch`). What is implemented is the **plugin-side** work that does not need the new
> profile (§3). The repoint and per-turn effort are in §5, "Pending (lands with the 2.1.329 profile repoint)".
> Until that lands the `check:invariants` gate reports a mismatch between this document (2.1.329) and the bound
> profile (2.1.280); it clears with the repoint.
>
> **Evidence tags** reuse the library's own convention: `[BIN]` transcribed from the binary, `[DER]` derived from
> `[BIN]` under stated default conditions, `[UNR]` located but unresolved, `[LIVE]` observed in a local
> TLS-intercepted capture of the genuine client, `[library-decision]` a choice about what to port. This document
> adds no new binary evidence of its own.

---

> **Provenance (this repository)**
>
> - Authored in this repository, as a synthesis of external analysis and of the plugin's own implementation
> - License: `GPL-3.0-or-later`
> - Captures: no identifier, token, account value or local path from any capture appears here; every id is
>   written `<uuid>` or omitted

# Claude Code 2.1.329 Analysis

- **Date**: 2026-11-19
- **Target release**: `@anthropic-ai/claude-code-win32-x64@2.1.329`
- **Compared against**: `2.1.280` (`docs/claude-code-2.1.280-analysis.md`, the profile the plugin still binds)
- **Library analysis**: `docs/protocol/versions/claude-code-2.1.329-analysis.md` in the library source tree; section
  numbers below (`lib §n`) refer to it
- **OAuth contract**: [`oauth-2.1.329-contract.md`](oauth-2.1.329-contract.md)
- **Plugin branch**: `feat/claude-code-2.1.329`

---

## 1. What the library found (summary, lib §2, §4, §6–§11)

2.1.329 is **additive on the wire**, with one retired beta, one re-ordered beta and one value the plugin and the
library both believed static (`cch`).

### 1.1 What moves on the wire

| Item                                 | 2.1.280 → 2.1.329                                                                                                                                                                        | Tag              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Client identity                      | `User-Agent` `claude-cli/2.1.329 (external, <entrypoint>)`; `X-Stainless-Package-Version` 0.112.1 → 0.128.0; `X-Stainless-Runtime-Version` v26.3.0 → v26.12.1 (lib §3.1, §4.1)           | `[BIN]` `[LIVE]` |
| `mid-conversation-system-2026-04-07` | no longer sent (the beta graduated; the header-less registry slot stays). The condition still gates tool-changes and clear-at (lib §5.3)                                                 | `[BIN]` `[LIVE]` |
| `cch`                                | the JS writes `cch=00000`; the wire carries a per-request 5-hex value on **both** 2.1.280 and 2.1.329 (lib §4.1)                                                                         | `[LIVE]` `[DER]` |
| New betas                            | six registry additions; only `tool-provenance-2026-10-26` could be default-on, and it is **absent** from both genuine OAuth captures (lib §5.2, §4.3)                                    | `[BIN]` `[LIVE]` |
| Beta order                           | `thinking-token-count-2026-05-13` moves from position 4 to after the per-request betas; `context-1m` is no longer sent for natively-1M models (lib §5.4)                                 | `[LIVE]` `[BIN]` |
| New request headers                  | `x-claude-1p-request-class: main`, `x-claude-code-prompt-id`, `x-claude-code-sandy-plover`; names capitalised on the wire; `Accept: application/json` (lib §6.1)                         | `[LIVE]` `[BIN]` |
| Billing block                        | `cc_prompt_index` and `cc_turn_index` after `cc_turn_origin` (which already existed in 2.1.280); fingerprint algorithm unchanged (lib §6.2)                                              | `[LIVE]` `[BIN]` |
| Body                                 | `fallbacks` gone, `thread: {"type":"create"}` appears, key order ends `output_config, thread, diagnostics, stream` (lib §4.1, §6.4)                                                      | `[LIVE]`         |
| Transport                            | bodies of 4096 characters and up are gzipped and padded when no proxy or custom CA intervenes (lib §6.6); not exercised by the capture                                                   | `[BIN]` `[DER]`  |
| Models                               | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-fable-5-2`, `claude-mythos-5-2`; the `sonnet`, `haiku`, `fable` aliases re-point; `mid_conv_system` leaves every model (lib §3.3, §6.8) | `[BIN]`          |
| Tools                                | `DeferredToolPlaceholder` and the `advisor_20260301` server tool, both deferred; MCP tools gain `ownership_metadata` (lib §6.5)                                                          | `[BIN]` `[LIVE]` |
| System prompt                        | the shared static block opens with a new sentence; the lean `# Harness` body is now locatable (lib §9.4)                                                                                 | `[BIN]` `[LIVE]` |
| OAuth                                | additive: two new default scopes, axios redirect hardening, more `claude-code/2.1.329` user agents; core contract unchanged (lib §7)                                                     | `[BIN]` `[LIVE]` |
| Cache                                | keepalive, resumption, idle compaction, after-idle tool-result clearing and a split TTL variable are new; none is on by default (lib §8)                                                 | `[BIN]`          |

### 1.2 What does not move

Endpoint (`/v1/messages?beta=true`), `anthropic-version`, `x-app`, the fingerprint salt `59cf53e54c78` with
characters 4, 7 and 20 and the first three hex characters of the SHA-256, the identity strings, the system-block
`cache_control` mapping, the `thinking` key order, the catalogue-derived `max_tokens` (128000 on the new models)
and the catalogue-derived default effort (`medium` on the 5.5 / 5.2 models) (lib §2.2).

### 1.3 Library-side decisions that shape the plugin (lib §2.3, resolved 2026-11-19)

`cch=00000` stays the library default, with an optional host seam for a caller-supplied value; every 2.1.329 fix
is made **only in the 2.1.329 profile** so the three frozen digests stay put; account-served features
(`anthropic-dispatch-id`, `message-threads`, `inline-tools`, `advisor-tool`, tool provenance) are opt-in caller
inputs, off by default; `mid-conversation-system` becomes an optional registry key.

---

## 2. Live genuine findings the plugin relies on

All `[LIVE]`, from the library's §4.1 and §4.3. The captures are local TLS-intercepted runs of the genuine
2.1.329 binary as an OAuth subscriber on `claude-opus-5-5`, an interactive (`cli`) request, an auxiliary quota
probe and a `-p` (`sdk-cli`) request, plus the `claude auth login --claudeai` exchange. An earlier pair of
captures used an API key and the `sdk-cli` entrypoint and is not conclusive for anything that depends on the
authentication mode (lib §4.0, §4.2).

### 2.1 Interactive OAuth request

- **Header order and casing.** `Accept: application/json`, then `Authorization` capitalised (between `Accept`
  and `Content-Type`), `Content-Type`, `User-Agent`, `X-Claude-Code-Session-Id`, the capitalised `X-Stainless-*`
  set (`Arch`, `Lang`, `OS`, `Package-Version` 0.128.0, `Retry-Count`, `Runtime`, `Runtime-Version` v26.12.1,
  `Timeout`), then the lowercase block: `anthropic-beta`, `anthropic-dangerous-direct-browser-access`,
  `anthropic-dispatch-id` (`v2d`, account-served), `anthropic-version`, `x-app`, `x-claude-1p-request-class`
  (`main`), `x-claude-code-prompt-id`, `x-claude-code-request-class` (`main`), `x-claude-code-sandy-plover` (`[]`
  when no tool was used), `x-client-request-id`. The auxiliary quota probe (haiku, `max_tokens: 1`) carries no
  `claude-code` beta, request class `auxiliary`, 1p class `summary-extraction`, and neither a dispatch id nor a
  prompt id.
- **Beta list, wire order (20 identifiers).** `claude-code`, `oauth`, `interleaved-thinking`, `context-management`,
  `prompt-caching-scope`, `per-turn-control`, `mid-conversation-tool-changes`, `inline-tools`, `advisor-tool`,
  `thinking-token-count`, `advanced-tool-use`, `mid-conversation-system-clear-at`, `effort`, `dangerous-tool-use`,
  `thinking-binding-controls`, `thinking-display-updates`, `afk-mode`, `extended-cache-ttl`, `cache-diagnosis`,
  `message-threads`. The `-p` list is the same without `thinking-display-updates`. `inline-tools`, `advisor-tool`
  and `message-threads` are account-served remote flags, not code defaults (lib §5.9). The 1h cache TTL and
  `extended-cache-ttl` are on by default for a subscriber; thinking is `adaptive` with display `updates`
  (interactive) or `omitted` (`-p`).
- **Billing segments.** `x-anthropic-billing-header: cc_version=2.1.329.<fp>; cc_entrypoint=cli; cch=<5 hex>;
cc_prompt_id=<uuid>; cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;`. The `-p` request carries
  `cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;` and `cc_entrypoint=sdk-cli`. `cch` varies per request.
- **Body order (both entrypoints).** `model, messages, system, tools, metadata, max_tokens, thinking,
context_management, safeguards, output_config, thread, diagnostics, stream`. `context_management` is
  generated (`{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`), `thread` is `{"type":"create"}`,
  `diagnostics` is `{"previous_message_id":null}`, `output_config` is `{"effort":"medium"}`, `max_tokens` is 128000.
- **Tool provenance is absent.** `tool-provenance-2026-10-26` is on neither OAuth capture, which contradicts the
  library's earlier `[DER]` reading that it is default-on for subscribers. The port treats it as an opt-in,
  account-served feature (`account_features.tool_provenance`, off by default).
- **Inline-tools coupling.** With `inline-tools-2026-09-15` on the wire, the `-p` capture carries
  `role: "system"` entries in `messages` holding `tool_addition` blocks, and the deferred `advisor` tool is
  appended last in `tools`. The header alone is a half port, so the plugin keeps the feature behind an opt-in.

### 2.2 OAuth login and token exchange

- **Authorize scopes** (`claude auth login --claudeai`):
  `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload
user:plugins user:privacy_consents:write org:desktop_config`.
- **Token exchange** is a JSON POST made by `axios/1.15.2` with `Accept: application/json, text/plain, */*`,
  `Content-Type: application/json`, **no** `anthropic-beta`. Wire order: `Accept`, `Content-Type`, `User-Agent`,
  `Content-Length`, `Accept-Encoding: gzip, compress, deflate, br`, `Host`, `Connection: close`. Body keys:
  `grant_type, code, redirect_uri, client_id, code_verifier, state`.
- The follow-up profile, roles and bootstrap requests use `User-Agent: claude-code/2.1.329`.
- Both 2.1.280 and 2.1.329 take the **axios path** for exchange, refresh and revoke; the SDK `userOAuthProvider`
  path (UA `anthropic-sdk-typescript/<ver> userOAuthProvider`) belongs only to SDK credentials-file profiles (lib
  §7.3). The plugin's earlier 2.1.280 contract claimed the opposite; see
  [`oauth-2.1.280-contract.md`](oauth-2.1.280-contract.md), "Corrections 2026-11-19".

### 2.3 Plugin comparison (library §4.2)

The plugin (2.1.280 profile plus a dynamic version override) differed from genuine 2.1.329 in: a UA that said
2.1.329 beside Stainless 0.112.1 and runtime v26.3.0; the retired `mid-conversation-system` beta; `Accept: */*`;
lowercase header names and a different order; five host-leaked headers (`x-opencode-client`,
`x-opencode-project`, `x-opencode-session`, `x-opencode-session-id`, `x-session-id`) on the wire to
`api.anthropic.com`; a different body key order; `cch=00000`; effort `high` and `max_tokens` 64000 against
`medium` and 128000. §3 and §5 record which of these are fixed and which wait for the repoint.

---

## 3. Implemented on this branch (pre-repoint)

The numbered findings are lib §11.1. Class (a) is wire-safe (closer to genuine); class (b) is a documented
divergence behind an opt-in (lib §11.2).

| Finding (lib §11.1)            | What changed                                                                                                                                                                                                                                                                                    | Escape hatch                                                                            | Class                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------- |
| 1–4 model-id folding (interim) | `lib/mimicry/request-body.mjs` sends effort and adaptive thinking only to models the pinned catalogue marks as supporting them, so `claude-mythos-5` no longer gets them; `thinking: {type: "disabled"}` is dropped for ids the catalogue does not know. Removed when the profile is repointed  | none (defensive)                                                                        | (a)                       |
| 5 effort default               | default `medium`, resolved from `CLAUDE_CODE_EFFORT_LEVEL` > `default_effort` > (`auto`) catalogue default > `high`, clamped to what the model supports; host-supplied effort still wins                                                                                                        | `default_effort`                                                                        | (a)                       |
| 7 version never floats         | the user agent and `cc_version` always carry the pinned profile's version; the npm "latest" lookup is recorded for diagnostics only (`emulating X; upstream latest Y`)                                                                                                                          | none                                                                                    | (a)                       |
| 8 leaked host headers          | `x-opencode-*` and `x-session-id` are removed on the adapter path and the legacy forge before `ANTHROPIC_CUSTOM_HEADERS` is merged, so a user can still send one deliberately. **Pass-through mode keeps them**                                                                                 | none (pass-through is the opt-out of emulation)                                         | (a)                       |
| 10–13 OAuth                    | axios header set and order, no `anthropic-beta`, redirects refused, `state` always sent, refresh `scope` sent with the stored scopes (and an `invalid_scope` retry), revoke URL `${TOKEN_URL}/revoke` with the `request-id` acknowledgement rule, scope union for both modes, no project scopes | `oauth.plugins_scope: false` drops `user:plugins`                                       | (a)                       |
| 14 scope after latch           | `cache_control.scope` is dropped when the scope beta is suppressed (round-robin, disabled experimental betas, or a latched rejection), including on the retry                                                                                                                                   | none                                                                                    | (a)                       |
| 15 TTL variables               | `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and the split `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL` (5m) are honoured; `extended-cache-ttl` is sent only when the resolved TTL is 1h                                                                                  | the environment variables themselves                                                    | (a)                       |
| 16 tool deferral               | deferral excludes only `claude-3-*` models (Haiku 5.5 is no longer skipped by name); the feature stays opt-in                                                                                                                                                                                   | `token_economy.tool_deferral` (off by default)                                          | (b)                       |
| 17 fast mode                   | follows the catalogue `fast_mode` holders; Opus 4.6 and 4.7 stay eligible only with the opt-in                                                                                                                                                                                                  | `fast_mode_legacy_models`                                                               | (b)                       |
| 18 native 1M context           | the adaptive-context path never escalates a natively-1M model to `context-1m`; the context-limit override covers them (still behind `override_model_limits.enabled`)                                                                                                                            | none                                                                                    | (a)                       |
| 19 org-locked thinking         | for models with `org_locked_thinking`, the first attempt prefers a usable account in the organization that last served the conversation (`lib/org-affinity.mjs`); with none, it continues, toasts once, and strips older thinking only when opted in                                            | `account_affinity.org_locked_thinking`, `account_affinity.strip_thinking_on_org_switch` | (a) stickiness, (b) strip |
| 20 stale docs and pins         | this document set; `tengu_velvet_tide` in code comments; microcompact documented as toast-only; the OAuth `0.112.1` SDK pin removed                                                                                                                                                             | n/a                                                                                     | docs                      |
| Haiku `claude-code` beta       | re-added on agentic main requests only (genuine `isAgenticQuery`), never on title, small or subagent-side requests                                                                                                                                                                              | none                                                                                    | (a)                       |
| Cold-cache rewrites            | history and tool rewrites (`conservative: false`) and idle tool-result clearing run only when the prompt cache is already cold                                                                                                                                                                  | `token_economy.cold_cache_only`, `token_economy.idle_tool_result_clearing`              | (b)                       |
| Idle compaction                | compacts a 1h-cache conversation at 0.9 of its life through `client.session.summarize` (v1 host only, feature-detected)                                                                                                                                                                         | `token_economy.idle_compaction`                                                         | (b)                       |
| System prompt                  | segment-aware rewrite, genuine opening sentence, empowerment blocks, stable and volatile split (§4)                                                                                                                                                                                             | `system_prompt.*`                                                                       | (a) neutral               |
| Changed defaults               | `lean_system_non_main`, `output_cap.enabled`, `prompt_compaction`, `anti_verbosity`, `adaptive_thinking_zero_simple` all default off                                                                                                                                                            | each key                                                                                | (b) → off                 |

Not implemented, by design (library §8 and §10.2): cache keepalive (`/v1/messages/cache_touch`), resumption,
shared-head and parent-reply markers, `resume_cache_warm`, the total-tokens reminder,
`__SYSTEM_PROMPT_STATIC_BREAKPOINT__`, gzip and padding, moving instruction files into the first user message
(needs a library fingerprint fix first), and the genuine cyber notice.

### 3.1 Why thinking is never toggled and effort is `medium`

Changing the thinking configuration between turns invalidates the message cache, and the new models reject
`thinking: {type: "disabled"}` (`rejects_disabled_thinking`, lib §9.3). So `token_economy.adaptive_thinking_zero_simple`
defaults to off and thinking stays `adaptive`. The genuine default effort is the catalogue's `default_effort`
(`medium` for every 5.5 and 5.2 model, `[LIVE]`); the plugin's maintainer-chosen default is `medium` for every
model that supports effort, with `auto` available to follow the catalogue.

---

## 4. System prompt: what the host block now contains

The genuine 2.1.329 shared static block opens with "You are an agent working with the user toward their goals,
using your own judgment along the way." (lib §9.4). The rest of the static prompt is byte-identical to 2.1.280.
The plugin's host system block (`lib/mimicry/system-prompt.mjs`, `lib/system-prompt-empowerment.mjs`) is **host
content placed after the identity block**; per the library's evidence it is not checked server-side, so these
changes are neutral for the fingerprint and exist for correctness and cache stability.

1. **Segment-aware rewrite** (`system_prompt.rewrite_scope`, default `base`). The OpenCode → Claude Code branding
   rewrite applies only to the opencode base prompt and the `<env>` header. It never touches file paths, URLs,
   `Instructions from:` instruction files or skill text. `all` restores the legacy whole-text rewrite. The
   obsolete "You are an interactive" prefix cut was removed.
2. **Genuine opening sentence** (`system_prompt.genuine_opening`, default on): the stable block starts with the
   sentence above.
3. **Empowerment blocks** (`system_prompt.empowerment`, default `max`), inserted right after the opening sentence
   and before the instruction files, so user and project instructions keep the last word. Values: `off`, `power`,
   `research`, `max`, or an array of block ids (`ownership`, `depth`, `tool_power`, `persistence`,
   `recommendations`, `proof`, `research`, `context_economy`, `communication`, `initiative`). The text is
   byte-stable: no dates, ids or config-dependent wording.
4. **Stable and volatile split** (`system_prompt.split_stable_volatile`, default on). The stable block holds the
   opening, the empowerment blocks, the opencode base prompt, global instruction files and skills, and takes the
   organization-scope breakpoint (`{type: "ephemeral", ttl}`; never `scope: "global"` for user content). The
   volatile block holds the `<env>` header (date, cwd, platform), project-level instruction files and anything
   unclassified (doubt means volatile) and carries **no** breakpoint: the wire package joins adjacent blocks that
   share an equal `cache_control`, so a second identical marker would merge the two back into one, and the
   message breakpoint already covers the volatile block. A change confined to it still reads the cached stable
   prefix. The breakpoint budget stays within four.
5. **Anti-verbosity** is off by default; the byte-identical text remains for the opt-in. The lean `# Harness`
   body is now locatable (see [`lean-prompt-claude-code-2.1.280.md`](lean-prompt-claude-code-2.1.280.md) §3).

---

## 5. Pending (lands with the 2.1.329 profile repoint)

These items need the library's 2.1.329 profile (`CLAUDE_CODE_2_1_329_PROFILE`, `BETA_REGISTRY_2_1_329`) and are
**not** implemented on this branch.

- **Repoint (WP7).** Bind `WIRE_PROFILE` to the 2.1.329 profile; this moves the user agent, Stainless package
  version (0.128.0), runtime version (`v26.12.1` from the profile), the beta registry and order (without
  `mid-conversation-system`, with `thinking-token-count` moved), header capitalisation and order, `Accept`,
  `x-claude-code-request-class` and `x-claude-1p-request-class`, the body key order and generated
  `context_management` / `diagnostics`, and the `cc_turn_origin` / `cc_prompt_index` / `cc_turn_index` billing
  segments. All of these are library-side and arrive with the new profile.
- **Session correlation** (`signature_emulation.session_correlation`, inert until then): per-conversation
  `promptId`, `turnOrigin`, `turnPosition`, `toolsUsed`, `previousRequestId` and `previousMessageId` fed to the
  library. The increment rule after the first request is inferred, not transcribed.
- **Account-served features as opt-ins** (`account_features.*`, off by default, inert until then):
  `dispatch_id`, `message_threads`, `inline_tools`, `advisor`, `tool_provenance`.
- **OAuth scopes from the profile.** The authorize request will take the profile's `oauthAuthorizeScopes`, which
  adds `user:privacy_consents:write org:desktop_config`. Until then the authorize URL carries the seven-scope
  2.1.280 string.
- **Per-turn effort (WP8).** Effort changes mid-conversation are sent as the genuine `role: "system"` message with
  an `output_config` inside `messages` (beta `per-turn-control-2026-07-01`, lib §4.3.1), which keeps the cached
  prefix intact; the top-level `output_config.effort` stays fixed for the conversation. Auto-`low` for short typed
  questions is planned on by default (`per_turn_effort.auto_low_short_questions`) for models with the
  `per_turn_effort` capability. The `per_turn_effort` config block exists but is inert until then.
- **Interim guards removed.** The model-id-folding guards of §3 are removed once the catalogue covers the new ids.
- **Tests and goldens** move with the repoint, reviewed byte by byte; the frozen library digests do not move.

---

## 6. Open questions and known limitations

- **`cch` is not reproducible.** The genuine client sends a per-request 5-hex value substituted below the JS; the
  algorithm is not recoverable from the bundle (lib §4.1, `[UNR]`). The plugin sends `cch=00000` and is accepted,
  but the request is distinguishable. The library will carry an optional seam; the plugin deliberately leaves it
  unset (no host source).
- **Residual transport signal.** `Content-Length`, `Host`, `Connection` (genuine: `Connection: close`) and header
  case and position on the OAuth token calls are set by the runtime, not by `fetch` options.
- **Gzip and padding** (lib §6.6) is a host transport concern; the padding is body bytes and is not modelled.
- **Fingerprint input.** Genuine hashes the first typed, non-meta prompt; the library hashes the first text block
  of the first wire user message, which diverges whenever a host merges reminders into the first message (lib
  §6.2). Library-side.
- **`max_tokens` policy.** opencode sends its own `max_tokens`; the plugin passes it through (the output cap is
  off by default) and only fills the catalogue default (128000 on the new models) when the host sent none. Genuine
  always sends the catalogue default.
- **No genuine capture of** the idle-compaction, cache-keepalive or resumption features; they are off by default
  upstream and `[BIN]`-only.
