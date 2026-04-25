# Claude Code 2.1.119 Analysis

Date: 2026-04-23
Analyst: static binary extraction (win32-x64 native Bun binary)
Compared against: 2.1.117 (previous baseline)

---

## 1. Package / binary metadata

| Field       | Value                                             |
| ----------- | ------------------------------------------------- |
| Package     | @anthropic-ai/claude-code-win32-x64@2.1.119       |
| Version     | 2.1.119                                           |
| Build time  | 2026-04-23T19:08:52Z                              |
| Git SHA     | 6f68554839756189e277b8285a18fe47acd9a5a1          |
| Binary      | claude.exe (native Bun, win32-x64)                |
| SDK bundled | @anthropic-ai/sdk 0.81.0 (unchanged from 2.1.117) |

---

## 2. Mimicry impact

- `FALLBACK_CLAUDE_CLI_VERSION` updated 2.1.117 -> 2.1.119.
- `CLAUDE_CODE_BUILD_TIME` updated to 2026-04-23T19:08:52Z.
- `CLI_TO_SDK_VERSION` map: entry `["2.1.119", "0.81.0"]` prepended; 2.1.117 retained.
- HTTP header shape is otherwise byte-identical to 2.1.117 when cache-diagnosis is off
  (which is the default). No regression to existing mimicry fingerprint.

---

## 3. OAuth impact

None. The following constants/flows are identical to 2.1.117:

- Token endpoint: /v1/oauth/token
- Beta used: oauth-2025-04-20
- Federation beta: oidc-federation-2026-04-01
- PKCE: authorization code, code_challenge_method=S256
- Grant types: authorization_code, refresh_token
- Profile URL: unchanged
- API-key URL: unchanged

No OAuth code changes required in the plugin.

Scope note: this plugin targets first-party Claude OAuth. Vertex, Bedrock, Anthropic AWS,
Foundry, Mantle, and other third-party/provider-specific branches observed in the upstream
binary are out of scope for local behavior and were not implemented.

---

## 4. Beta impact

One beta flag added:

| Flag                       | Default | Gate                                      |
| -------------------------- | ------- | ----------------------------------------- |
| cache-diagnosis-2026-04-07 | off     | GrowthBook tengu_prompt_cache_diagnostics |

No flags removed.

Plugin changes made:

- Added to `EXPERIMENTAL_BETA_FLAGS` set.
- Shortcuts `cache-diagnosis` and `cache-diag` added to `BETA_SHORTCUTS`.
- NOT added to any always-on list; must be explicitly opted in via `/anthropic set betas`.

---

## 5. Token / performance opportunities

When `cache-diagnosis-2026-04-07` is active the server returns diagnostic data about
prompt-cache hit/miss behavior. This could be surfaced as debug output. Not implemented
in this update -- the flag is merely registered so users can opt in via the experimental
flags mechanism.

The `diagnostics.previous_message_id` injection links consecutive turns for server-side
cache attribution. Enabling the beta on long agentic sessions may provide visibility into
cache efficiency. Regression risk if the server rejects the field on older model versions
is mitigated by the built-in 400-retry path in the CC binary (drop beta, retry clean).

---

## 6. Regression risk

Low.

- Default behavior is identical to 2.1.117: cache-diagnosis is off unless explicitly
  configured in this plugin. Real Claude Code only enables it behind GrowthBook
  `tengu_prompt_cache_diagnostics`; for this plugin, only the first-party OAuth path matters.
- The only observable change in baseline requests is the version string in User-Agent
  and the billing system-prompt block (2.1.117 -> 2.1.119).
- Tests updated: `index.test.mjs` line 738; `test/conformance/regression.test.mjs`
  describe block "E2E: Version is 2.1.119".

---

## 7. Files changed

| File                                     | Change                                             |
| ---------------------------------------- | -------------------------------------------------- |
| index.mjs                                | version/build constants, CLI_TO_SDK_VERSION entry, |
|                                          | EXPERIMENTAL_BETA_FLAGS, BETA_SHORTCUTS            |
| index.test.mjs                           | user-agent version assertion 2.1.117->2.1.119      |
| test/conformance/regression.test.mjs     | version describe/it/expect 2.1.117->2.1.119        |
| docs/mimese-http-header-system-prompt.md | version history table + cache-diagnosis section    |
| docs/claude-code-reverse-engineering.md  | 2.1.119 findings summary + decompiled snippets     |
| docs/claude-code-2.1.119-analysis.md     | this file (new)                                    |
