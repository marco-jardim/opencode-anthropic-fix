# Claude Code 2.1.133 Analysis

Date: 2026-05-07
Analyst: static binary extraction (win32-x64 native Bun binary)
Compared against: 2.1.123 (plugin baseline), 2.1.119 (last full analysis)

---

## 1. Package / binary metadata

| Field       | Value                                             |
| ----------- | ------------------------------------------------- |
| Package     | @anthropic-ai/claude-code-win32-x64@2.1.133       |
| Version     | 2.1.133                                           |
| Build time  | 2026-05-07T18:26:46Z                              |
| Git SHA     | cba57ffec4f5d5c279b5f66ea9d7a2544fa410ec          |
| Binary      | claude.exe (native Bun, win32-x64)                |
| SDK bundled | @anthropic-ai/sdk 0.81.0 (unchanged from 2.1.119) |

---

## 2. Mimicry impact

- `FALLBACK_CLAUDE_CLI_VERSION` needs update 2.1.123 -> 2.1.133.
- `CLAUDE_CODE_BUILD_TIME` needs update to 2026-05-07T18:26:46Z.
- `CLI_TO_SDK_VERSION` map: entries for 2.1.124 through 2.1.133 all map to
  `0.81.0`.
- HTTP header shape is byte-identical to 2.1.119/2.1.123. No new headers and no
  removed headers.
- Known headers unchanged: `x-client-request-id`, `x-claude-remote-*`,
  `x-anthropic-additional-protection`, `x-client-app`, `x-app`,
  `X-Claude-Code-Session`, `anthropic-version`, `user-agent`, `Claude-User`,
  and `stainlessHelper`.

---

## 3. OAuth impact

None. The following constants/flows are identical to 2.1.119:

- Token endpoint: /v1/oauth/token
- Beta used: oauth-2025-04-20
- Federation beta: oidc-federation-2026-04-01
- PKCE: unchanged
- Profile URL: unchanged
- Axios still bundled for OAuth calls

No OAuth code changes required in the plugin.

---

## 4. Beta impact

New betas found in 2.1.133:

| Flag                          | Default | Gate                                                       | Plugin status                                                           |
| ----------------------------- | ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| extended-cache-ttl-2025-04-11 | off     | Unknown (likely feature-flag gated)                        | Not registered -- add to `EXPERIMENTAL_BETA_FLAGS` and `BETA_SHORTCUTS` |
| context-hint-2026-04-09       | gated   | GrowthBook tengu_time_based_microcompact, repl_main_thread | Already implemented (Phase C2)                                          |
| environments-2025-11-01       | off     | Unknown                                                    | Not registered -- add to `EXPERIMENTAL_BETA_FLAGS`                      |

Betas confirmed absent from 2.1.133:

- `token-efficient-tools-2026-03-28` -- not in binary. Binary has
  `token-efficient-tools-2025-02-19` described as "Built in to all Claude 4+
  models -- Remove (no effect)". Plugin already correctly does not send this.
- `summarize-connector-text-2026-03-13` -- not in binary anywhere. Plugin
  already correctly does not send this.

Other betas found, but not for the first-party CLI plugin:

- `managed-agents-2026-04-01` -- cloud managed agents, API only.
- `ccr-triggers-2026-01-30` -- CCR triggers (Code Review).
- `mcp-client-2025-11-20` -- Java SDK MCP client.

---

## 5. Body field changes

- `context_management` now uses `compact_20260112` type in addition to
  `clear_thinking_20251015`. The plugin currently only injects
  `clear_thinking_20251015`. The `compact_20260112` type is used during full
  context compaction, not just thinking management. Since the plugin does not
  perform server-side context compaction, this is a feature gap, not fingerprint
  drift.
- `output_config` with `effort: "high"` appears in examples.
- `eager_input_streaming` and `speed` field are unchanged.

---

## 6. System prompt

- All three identity string variants are identical to 2.1.119.
- `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` is still present.
- Billing header format unchanged: `cc_version=<v>.<fingerprint>; cc_entrypoint=<e>; cch=00000;`.
- `cch=00000` is still a static placeholder.

---

## 7. Environment variables

New environment variables observed, with no wire impact:

- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` -- disables adaptive thinking.
- `CLAUDE_CODE_DISABLE_THINKING` -- disables thinking entirely.

---

## 8. Other binary discoveries

- `output-128k-2025-02-19` is noted as "Built in to Claude 4+ models -- Remove
  (no effect)".
- `token-efficient-tools-2025-02-19` is also built in and removable.

---

## 9. Regression risk

Low.

- Default behavior is identical to 2.1.123 except for the version string in
  User-Agent and the billing system-prompt block.
- HTTP header shape remains byte-identical to 2.1.119/2.1.123.
- OAuth behavior remains unchanged.

---

## 10. Action items

1. Bump version constants: `FALLBACK_CLAUDE_CLI_VERSION`,
   `CLAUDE_CODE_BUILD_TIME`, and `CLI_TO_SDK_VERSION`.
2. Add `extended-cache-ttl-2025-04-11` to `EXPERIMENTAL_BETA_FLAGS` and
   `BETA_SHORTCUTS`.
3. Add `environments-2025-11-01` to `EXPERIMENTAL_BETA_FLAGS`.
4. Update `docs/mimese-http-header-system-prompt.md` version history.
5. Update regression tests for version 2.1.133.

---

## 11. Files changed

| File                                 | Change          |
| ------------------------------------ | --------------- |
| docs/claude-code-2.1.133-analysis.md | this file (new) |
