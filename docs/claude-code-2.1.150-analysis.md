# Claude Code 2.1.150 Analysis

Date: 2026-05-24
Analyst: static binary extraction (win32-x64 native Bun binary)
Compared against: 2.1.143 (plugin baseline)
Plugin currently emulates: 2.1.143
Latest published: 2.1.150 (2026-05-23)

---

## 1. Package / binary metadata

| Field       | Value                                         |
| ----------- | --------------------------------------------- |
| Package     | @anthropic-ai/claude-code@2.1.150             |
| Version     | 2.1.150                                       |
| Build time  | 2026-05-23T01:22:49Z                          |
| Git SHA     | 28d4819e                                      |
| SDK bundled | @anthropic-ai/sdk 0.94.0 (bumped from 0.81.0) |

---

## 2. Executive Summary

Major beta registry expansion: 26 registered betas (up from ~8 explicitly mapped). CC 2.1.150
significantly restructured which betas are always-on vs feature-gated. Several betas we were
sending always-on (`advanced-tool-use`, `tool-search-tool`, `fast-mode`, `effort`) are NOT in
CC's per-request builder (D5q). New default beta: `redact-thinking-2026-02-12`.

Wire-level drift from 2.1.143: **MEDIUM** — beta set changed substantially.

---

## 3. Mimicry impact (summary)

| Area                          | Status                                                                     |
| ----------------------------- | -------------------------------------------------------------------------- |
| Wire-protocol fingerprint     | Beta set changed substantially. 4 betas removed from always-on.            |
| OAuth login flow              | No wire change.                                                            |
| Always-on beta header set     | `redact-thinking-2026-02-12` now default ON. 4 betas moved to opt-in.      |
| `x-` headers                  | `x-anthropic-additional-protection: true` confirmed as conditional header. |
| `anthropic-version`           | Still `2023-06-01`.                                                        |
| `x-stainless-package-version` | SDK bumped to `0.94.0` (was `0.81.0`).                                     |
| Billing header                | Format unchanged. Upstream CC omits it for bedrock/anthropicAws/mantle.    |
| Beta registry                 | Expanded to 26 entries (full list in §4).                                  |

**TL;DR:** The main mimicry risk is the 4 always-on betas that CC dropped. The plugin should
remove `advanced-tool-use`, `tool-search-tool`, `fast-mode`, and `effort` from always-on
emission. Note: `redact-thinking` is **default ON** (matching CC 2.1.150 behavior). Opt out via
`/anthropic set redact-thinking off`.

---

## 4. Beta Registry (complete, 26 entries)

| #   | Internal Name           | Header                             | Always-On in D5q          |
| --- | ----------------------- | ---------------------------------- | ------------------------- |
| 1   | claude_code             | claude-code-20250219               | Yes (non-haiku)           |
| 2   | oauth_auth              | oauth-2025-04-20                   | Yes (OAuth)               |
| 3   | interleaved_thinking    | interleaved-thinking-2025-05-14    | Yes (thinking models)     |
| 4   | long_context            | context-1m-2025-08-07              | Yes (long-ctx models)     |
| 5   | context_management      | context-management-2025-06-27      | No (hardcoded false)      |
| 6   | structured_outputs      | structured-outputs-2025-12-15      | No (caller output format) |
| 7   | web_search              | web-search-2025-03-05              | No (vertex/foundry only)  |
| 8   | tool_search_adv         | advanced-tool-use-2025-11-20       | No                        |
| 9   | tool_search             | tool-search-tool-2025-10-19        | No (legacy Z6q filter)    |
| 10  | effort                  | effort-2025-11-24                  | No                        |
| 11  | task_budgets            | task-budgets-2026-03-13            | No                        |
| 12  | prompt_caching_scope    | prompt-caching-scope-2026-01-05    | Yes (first-party)         |
| 13  | extended_cache_ttl      | extended-cache-ttl-2025-04-11      | No                        |
| 14  | speed                   | fast-mode-2026-02-01               | No                        |
| 15  | redact_thinking         | redact-thinking-2026-02-12         | Yes (default ON)          |
| 16  | thinking_token_count    | thinking-token-count-2026-05-13    | No (tengu_chert_bezel)    |
| 17  | (removed)               | null                               | Removed                   |
| 18  | afk_mode                | afk-mode-2026-01-31                | No                        |
| 19  | advisor_tool            | advisor-tool-2026-03-01            | No                        |
| 20  | cache_diagnosis         | cache-diagnosis-2026-04-07         | No                        |
| 21  | context_hint            | context-hint-2026-04-09            | No                        |
| 22  | mcp_servers             | mcp-servers-2025-12-04             | No                        |
| 23  | files_api               | files-api-2025-04-14               | No (file uploads only)    |
| 24  | environments            | environments-2025-11-01            | No                        |
| 25  | ccr_byoc                | ccr-byoc-2025-07-29                | No                        |
| 26  | mid_conversation_system | mid-conversation-system-2026-04-07 | No (model+flag gated)     |

---

## 5. Beta Assembly Logic (D5q)

For first-party OAuth, non-haiku, CC 2.1.150 sends:

1. `claude-code-20250219` — always (non-haiku)
2. `oauth-2025-04-20` — if OAuth
3. `context-1m-2025-08-07` — if model supports long context
4. `interleaved-thinking-2025-05-14` — if model supports thinking
5. `redact-thinking-2026-02-12` — default ON (first-party, non-SDK); opt-out via `/anthropic set redact-thinking off`
6. `prompt-caching-scope-2026-01-05` — first-party only
7. Custom betas from `ANTHROPIC_BETAS` env

Feature-flagged (not default):

- `thinking-token-count-2026-05-13` — behind `tengu_chert_bezel`
- `context-management-2025-06-27` — hardcoded `&& false`
- `structured-outputs-2025-12-15` — enabled when the caller supplies an output format; `tengu_tool_pear` gates `tool.strict = true` on the tool-schema path
- `mid-conversation-system-2026-04-07` — model check + flag

---

## 6. HTTP header audit

### 6.1 Header changes vs 2.1.143

- `x-stainless-package-version`: SDK bumped to `0.94.0` (was `0.81.0`)
- `x-anthropic-additional-protection: true` — confirmed conditional header (from `CLAUDE_CODE_ADDITIONAL_PROTECTION` env); was listed in earlier analysis but now confirmed in 2.1.150
- Stainless headers moved to SDK layer (still sent, not in CC's request block)
- `oidc-federation-2026-04-01` — OAuth-only beta for JWT bearer (not Messages API)

### 6.2 Headers stable vs 2.1.143

- `anthropic-version: 2023-06-01`
- `x-app: cli` (or `cli-bg`)
- `X-Claude-Code-Session-Id`
- `x-stainless-arch`, `x-stainless-lang`, `x-stainless-os`, `x-stainless-runtime`

---

## 7. Billing Header

Format unchanged: `x-anthropic-billing-header: cc_version=<ver>; cc_entrypoint=<entry>;[ cch=00000;][ cc_workload=<wl>;]`
Still gated **in upstream CC**: NOT sent for bedrock/anthropicAws/mantle. The plugin has no provider
gate and always sends it — see [Provider Scope](../README.md#provider-scope).

---

## 8. User-Agent

Format: `claude-cli/2.1.150 (external, ${entrypoint}[, agent-sdk/<ver>][, client-app/<app>][, workload/<wl>])`

---

## 9. Drift risk assessment

| Risk                                                                                                 | Severity |
| ---------------------------------------------------------------------------------------------------- | -------- |
| Plugin emits `advanced-tool-use` always-on while CC dropped it                                       | MEDIUM   |
| Plugin emits `tool-search-tool` always-on while CC dropped it                                        | MEDIUM   |
| Plugin emits `fast-mode` always-on while CC dropped it                                               | MEDIUM   |
| Plugin emits `effort` always-on while CC dropped it                                                  | LOW      |
| `redact-thinking` default ON — matches CC 2.1.150 (opt-out via `/anthropic set redact-thinking off`) | INFO     |
| SDK version mismatch (0.81.0 vs 0.94.0 in stainless header)                                          | LOW      |

---

## 10. Action Items Implemented

### P0 — Fingerprint Fixes

- [x] Removed `advanced-tool-use-2025-11-20` from always-on
- [x] Removed `tool-search-tool-2025-10-19` from always-on
- [x] Removed `fast-mode-2026-02-01` from always-on
- [x] Removed `effort-2025-11-24` from always-on
- [x] Gated `context-management-2025-06-27` behind opt-in (`token_economy.context_management`)
- [x] Gated `structured-outputs-2025-12-15` behind opt-in (`token_economy.structured_outputs`)
- [x] `redact-thinking-2026-02-12` **default ON** (matching CC 2.1.150; opt-out via `/anthropic set redact-thinking off`)

### P1 — Version Bumps

- [x] `x-stainless-package-version`: 0.81.0 → 0.94.0
- [x] claude-cli version: 2.1.143 → 2.1.150
- [x] BUILD_TIME: 2026-05-15T17:39:39Z → 2026-05-23T01:22:49Z

### P2 — Performance/Token Economy (plugin additions, not CC parity)

- [x] `extended-cache-ttl-2025-04-11` — default ON for better cache rates
- [x] `thinking-token-count-2026-05-13` — default ON for token tracking

### P3 — New Features

- [x] `x-anthropic-additional-protection` header confirmed
- [x] Registered 20 new beta shortcuts from the expanded 26-entry registry

---

## 11. Files changed

| File                                                  | Change                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs/claude-code-2.1.150-analysis.md                  | this file (new)                                                                                                                                                                                                                             |
| docs/mimese-http-header-system-prompt.md              | version-history row, beta assembly section, 5.1/5.2/5.3 updates, token economy section updates                                                                                                                                              |
| lib/request-headers.mjs                               | P0: bump FALLBACK_CLAUDE_CLI_VERSION + BUILD_TIME + SDK version; remove 4 betas from always-on                                                                                                                                              |
| lib/config.mjs                                        | add `token_economy.extended_cache_ttl`, `token_economy.thinking_token_count`, `token_economy.context_management`, `token_economy.structured_outputs`                                                                                        |
| index.mjs                                             | `redact_thinking` **default ON** (matching CC; opt-out via `/anthropic set redact-thinking off`); gate `context-management` and `structured-outputs` behind config flags; add `extended-cache-ttl` and `thinking-token-count` as default-on |
| index.test.mjs / test/conformance/regression.test.mjs | Version assertions bumped 2.1.143 → 2.1.150                                                                                                                                                                                                 |
