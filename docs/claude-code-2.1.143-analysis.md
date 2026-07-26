# Claude Code 2.1.143 Analysis

Date: 2026-05-16
Analyst: static binary extraction (win32-x64 native Bun binary)
Compared against: 2.1.133 (plugin baseline)
Plugin currently emulates: 2.1.133
Latest published: 2.1.143 (2026-05-15)

---

## 1. Package / binary metadata

| Field       | Value                                             |
| ----------- | ------------------------------------------------- |
| Package     | @anthropic-ai/claude-code@2.1.143                 |
| Version     | 2.1.143                                           |
| Build time  | 2026-05-15T17:39:39Z                              |
| Git SHA     | cfb8132e4c3551e2773f41a1900efd1cc93637db          |
| Binary      | claude.exe (native Bun, win32-x64), 228,902,560 B |
| SDK bundled | @anthropic-ai/sdk 0.81.0 (unchanged)              |

Distribution model unchanged from 2.1.113+: Bun-compiled native binaries per platform package. No JS bundle.

Binary growth 2.1.133 -> 2.1.143: +3,243,008 B (~1.4 %). Most of this is new
telemetry plumbing (50+ new `tengu_*` events) and the new agent-context
plumbing, not core wire protocol.

---

## 2. Mimicry impact (summary)

| Area                      | Status                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| Wire-protocol fingerprint | Effectively unchanged for `/v1/messages` main thread. 2 new optional headers.     |
| OAuth login flow          | No wire change. Client-side refresh-lock plumbing got more elaborate.             |
| Always-on beta header set | No removals. One genuinely new beta (`mid-conversation-system-2026-04-07`).       |
| `x-` headers              | Two new headers: `x-claude-code-agent-id`, `x-claude-code-parent-agent-id`.       |
| `anthropic-version`       | Still `2023-06-01`.                                                               |
| `stainlessHelper` shape   | Unchanged.                                                                        |
| Billing header            | Format unchanged (`cch=00000` still placeholder). `cc_workload=` already existed. |
| Model registry            | Identical set (`claude-opus-4-7` still present, was already in 2.1.133).          |
| System-prompt identity    | Identical strings.                                                                |

**TL;DR:** drift risk between 2.1.133 and 2.1.143 is low. The plugin will keep
working as-is. The valuable work is registering 2 new flags, recognising 2 new
optional headers, and exploiting opportunities the prior analyses missed.

---

## 3. OAuth audit

**Wire constants unchanged:**

- Token endpoint: `https://platform.claude.com/v1/oauth/token`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Refresh-grant scopes: identical (`user:profile`, `user:inference`, `user:sessions`,
  `user:mcp_servers`, `user:file_upload`)
- Refresh beta header: `oauth-2025-04-20`
- OIDC federation beta: `oidc-federation-2026-04-01`
- Bundled axios version (used for OAuth axios path): unchanged

**Client-side OAuth changes (no wire impact):**

Real CC has expanded its token-refresh concurrency code. New telemetry events
indicate the shape:

- `.oauth_refresh.lock` filename now appears explicitly in the binary
- `tengu_oauth_token_refresh_lock_acquiring` / `_acquired` / `_retry` / `_releasing` / `_released`
- `tengu_oauth_token_refresh_lock_retry_limit_reached`
- `tengu_oauth_token_refresh_race_resolved` / `_race_recovered`
- `tengu_oauth_refresh_legacy_lock_contended` (new in 2.1.143; "legacy" suggests
  an older lock format is being phased out)
- `tengu_oauth_refresh_token_marked_dead_invalid_grant` (refresh tokens that
  receive `invalid_grant` are now actively flagged dead instead of silently
  retrying)
- `tengu_oauth_401_recovered_from_disk` / `_recovered_from_keychain` /
  `oauth_401_no_refresh_token_bg_worker` (multi-source 401 recovery: SDK
  callback -> disk -> keychain)

**Plugin status:** the plugin already implements a per-account cross-process
file lock in `lib/refresh-lock.mjs`, with stale-lock detection and a pre-refresh
disk read (`applyDiskAuthIfFresher`). The shape matches the spirit of CC's
approach. No change needed for wire compatibility.

`tengu_oauth_gateway_selected` is an interactive OAuth onboarding wizard event
(used during the "platform vs gateway vs claudeai" picker step) and has no
runtime impact.

---

## 4. Beta header audit

### 4.1 Master beta-map registry diff (2.1.133 -> 2.1.143)

The binary embeds a master `{json_key: beta_header}` registry. Only one entry
was appended between versions:

```
mid_conversation_system -> mid-conversation-system-2026-04-07   <-- NEW
```

All other entries are byte-identical:

```
long_context              context-1m-2025-08-07
context_management        context-management-2025-06-27
structured_outputs        structured-outputs-2025-12-15
web_search                web-search-2025-03-05
tool_search               advanced-tool-use-2025-11-20 / tool-search-tool-2025-10-19
effort                    effort-2025-11-24
task_budgets              task-budgets-2026-03-13
prompt_caching_scope      prompt-caching-scope-2026-01-05
extended_cache_ttl        extended-cache-ttl-2025-04-11
fast_mode                 fast-mode-2026-02-01
redact_thinking           redact-thinking-2026-02-12
afk_mode                  afk-mode-2026-01-31
advisor_tool              advisor-tool-2026-03-01
cache_diagnosis           cache-diagnosis-2026-04-07
context_hint              context-hint-2026-04-09
mcp_servers               mcp-servers-2025-12-04
files_api                 files-api-2025-04-14
environments              environments-2025-11-01
ccr_byoc                  ccr-byoc-2025-07-29
```

### 4.2 New non-`/v1/messages` betas (SDK route only)

Found in tree but only for SDK admin routes, not chat completions:

- `user-profiles-2026-03-24` -> appears alongside `/v1/user_profiles?beta=true`,
  `/v1/user_profiles/{id}/enrollment_url?beta=true`. SDK admin endpoint.
- `managed-agents-2026-04-01` -> already known, used by `/v1/environments`
  and `/v1/agents/{id}` admin endpoints.

Plugin proxies `/v1/messages` only, so neither needs auto-emission. Register
in `EXPERIMENTAL_BETA_FLAGS` for forward-compat if/when users opt in.

### 4.3 `mid-conversation-system-2026-04-07` deep dive

**What it does:** allows the client to inject `system` blocks at points OTHER
than the leading `system` array on `/v1/messages`. Specifically, system blocks
can appear inside the `messages` array between turns (in the same shape the
plugin already handles for `<system-reminder>` blocks).

**Evidence from the binary (2.1.143 / win32-x64):**

- Beta descriptor registered in the master beta-map at strings line 551831-32:
  `mid_conversation_system -> mid-conversation-system-2026-04-07`.
- Constructor at bundle position ~625080:
  ```js
  WE = lP("mid_conversation_system", "mid-conversation-system-2026-04-07");
  ```
  `lP(<key>, <header>)` is real CC's beta-descriptor factory. `WE` is then
  pushed onto the master frozen array `Yz9` alongside ~25 other descriptors,
  and indexed into `Qs$ = new Map(Yz9.map(H => [H.header, H]))` for lookup.
- `WE` is **NOT** in either of the two always-on subsets (`yi6` and `Si6`)
  that share scope with `Yz9`. Those two sets contain `$JH` (claude_code),
  `WxH`, `KJH`, `PxH`, `CB`, `R_8` — the actual auto-emit core. Conclusion:
  the beta is **registered for opt-in lookup, never auto-emitted**.
- Telemetry coupling: `tengu_mid_conv_system_fallback_retry`. The "fallback
  retry" phrasing tells us the wire interaction is:
  1. Client sends the request WITH `anthropic-beta: ...,mid-conversation-system-2026-04-07,...`
  2. Server returns 4xx (likely 422 referencing the beta) if it doesn't
     accept the mid-conversation system shape.
  3. Client strips the beta, restructures the system blocks to the leading
     `system` array shape, retries ONCE, fires the telemetry event.

**Risk to the plugin's mimese (real assessment):**

| Scenario                                                             | Risk       | Why                                                                                                    |
| -------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| Plugin omits the beta header                                         | **NONE**   | Real CC also omits it on the wire today (registry-only).                                               |
| Plugin omits a mid-conversation `system` block in messages array     | **NONE**   | Without the beta header, the server doesn't expect one. Plugin's existing leading-system path matches. |
| GrowthBook flag flips on for real CC users and plugin doesn't follow | **LOW**    | Until we MITM-capture real CC actually sending the beta + a body shape, we can't mirror correctly.     |
| Plugin emits the beta unilaterally                                   | **MEDIUM** | Could trigger 422 from servers that aren't rolled out yet. Avoid until verified.                       |

**Plugin status after this session:** registered in `EXPERIMENTAL_BETA_FLAGS`
with shortcuts `mid-conv-system` / `mid-system` so users can opt in via
`custom_betas`, but NOT in any always-on code path. Matches the conservative
posture real CC currently takes.

### 4.4 Plugin emission set (current) vs real CC always-on set

The plugin currently emits this on a main-thread non-Haiku non-Claude-3 first-party request:

```
oauth-2025-04-20,
claude-code-20250219,
advanced-tool-use-2025-11-20,
fast-mode-2026-02-01,
effort-2025-11-24                (only when isAdaptiveThinkingModel),
interleaved-thinking-2025-05-14,
prompt-caching-scope-2026-01-05  (unless round-robin),
context-management-2025-06-27,
structured-outputs-2025-12-15    (supportsStructuredOutputs),
web-search-2025-03-05            (supportsWebSearch),
advisor-tool-2026-03-01,
context-hint-2026-04-09          (gated: 1P, main, non-c3, opt-in default off),
extended-cache-ttl-2025-04-11    (1P, non-c3),
```

This matches what real CC 2.1.143 emits for the same shape with one caveat:

- Real CC has an additional GrowthBook-gated rollout for `redact-thinking-2026-02-12`
  for some accounts. The plugin keeps this gated behind `token_economy.redact_thinking`
  which defaults off so visible thinking is preserved. **No change needed.**

---

## 5. HTTP header audit

### 5.1 New `x-` headers in 2.1.143

Two new headers found in the same code block as the existing
`x-claude-remote-container-id`, `x-claude-remote-session-id`, `x-client-app`:

| Header                          | Plugin status |
| ------------------------------- | ------------- |
| `x-claude-code-agent-id`        | not emitted   |
| `x-claude-code-parent-agent-id` | not emitted   |

**Exact emission code (from win32-x64 binary, deminified):**

```js
let Y = bw(); // gets active subagent context from AsyncLocalStorage
let j = {
  "x-app": G7() ? "cli-bg" : "cli",
  "User-Agent": Ol(),
  "X-Claude-Code-Session-Id": v8(),
  ...M, // OAuth Authorization
  ...(A && { "x-claude-remote-container-id": A }), // env CLAUDE_CODE_CONTAINER_ID
  ...(f && { "x-claude-remote-session-id": f }), // env CLAUDE_CODE_REMOTE_SESSION_ID
  ...(z && { "x-client-app": z }), // env CLAUDE_AGENT_SDK_CLIENT_APP
  ...(Y?.agentId && { "x-claude-code-agent-id": Y.agentId }), // NEW
  ...(Y?.parentAgentId && { "x-claude-code-parent-agent-id": Y.parentAgentId }), // NEW
};
```

`bw()` is the public binding for `getTeammateContext()` exported from the
teammate module (`ci6` in the binary). It reads from an `AsyncLocalStorage`
populated by real CC's internal subagent dispatcher when an Agent tool spawns
a child. Outside that scope, `bw()` returns `undefined`/`null`, so both
spread-conditionals are no-ops.

**What "subagent context" means here:**

- Real CC's `getTeammateContext()` returns a record with `{ agentId, agentName,
parentSessionId, teamName, color, planModeRequired, parentAgentId }`.
- `agentId` is the unique ID of the child agent (uuid).
- `parentAgentId` is the ID of the agent that spawned it, allowing the server
  to reconstruct the fanout tree for billing/observability.
- Telemetry events `tengu_subagent_type_miss` / `tengu_subagent_type_normalized`
  show real CC also validates and normalises the `subagent_type` parameter when
  the Agent tool is invoked.

**Risk to the plugin's mimese (real assessment):**

| Scenario                                                    | Risk     | Why                                                                                                                                           |
| ----------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin omits both headers for main-thread requests          | **NONE** | Real CC also omits them on main thread. Spread-conditional is a no-op there.                                                                  |
| OpenCode dispatches a subagent and plugin omits headers     | **NONE** | Plugin can't know — OpenCode doesn't propagate agent identity. Real CC ALSO omits when its internal AsyncLocalStorage is empty.               |
| OpenCode passes a subagent flag and plugin can't pick it up | **LOW**  | Mostly a telemetry / billing-attribution gap. Server doesn't appear to reject requests for missing agent IDs.                                 |
| Server pivots to REQUIRING these headers for billing        | **LOW**  | No evidence today. If it does, OpenCode would need to expose subagent identity through `experimental.chat.params` and plugin would propagate. |
| Subagent header is emitted with empty/wrong value           | **LOW**  | Server appears to tolerate. Plugin's posture (skip) is safer than guess.                                                                      |

**Plugin status after this session:** unchanged. Skipping these headers
matches real CC's main-thread behaviour exactly. A future subagent-identity
plumbing would need OpenCode-side support to populate `parsed.metadata.agentId`
or similar; until then, no action.

### 5.2 Headers stable across 2.1.119 / 2.1.123 / 2.1.133 / 2.1.143

- `x-client-request-id`, `x-claude-remote-container-id`, `x-claude-remote-session-id`
- `x-anthropic-additional-protection`, `x-client-app`, `x-app`
- `X-Claude-Code-Session-Id`
- `anthropic-version: 2023-06-01`
- `User-Agent: claude-cli/<version> (external, <entrypoint>)`
- `Claude-User: <hashed-billing-id>`
- `X-Stainless-Helper` (only when `x-stainless-helper` betas are in scope)

---

## 6. Body / wire shape audit

### 6.1 Already present in 2.1.133, missed by prior analyses

These items existed in 2.1.133 but were not surfaced in the 2.1.133 analysis
document. They show up again in 2.1.143 and represent real plugin gaps:

#### 6.1.1 Billing header has an optional `cc_workload=` segment

```
x-anthropic-billing-header: cc_version=<v>.<entrypoint>; cc_entrypoint=<e>; cch=00000; cc_workload=<tag>;
```

- Set via the `--workload <tag>` CLI flag (only for `--print` non-interactive
  runs; "process-scoped, set by SDK daemon callers that spawn subprocesses for
  cron work").
- Provider-gated: bedrock / anthropicAws / mantle skip the `cch` and `cc_workload`
  segments entirely.
- Plugin status: never emits `cc_workload`. Absence is silently tolerated by the
  server, so this is not a hard fingerprint mismatch. Opportunity: expose a
  `signature_emulation.workload` config knob so SDK-daemon users can tag their
  cron traffic for billing attribution.

#### 6.1.2 Simple-system-prompt mode for Opus 4.7+

Real CC since 2.1.133 has a simple-system-prompt branch:

```js
function sR9(H){
  return Z7(H)==="claude-opus-4-7"
      || ... (other model checks)
      || YTK(H)   // -eap suffix models
      || MTK(H);  // GrowthBook-listed models
}
```

Gating logic (top of `Wz`):

```
1. CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1   -> force-on
2. CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0   -> force-off
3. else require sR9(model) === true
4. else require GrowthBook tengu_velvet_cascade === true
```

When on, the system prompt is leaner (less identity boilerplate, less tool
self-description). Token savings can be material for short-prompt requests
on Opus 4.7.

Plugin status: not implemented. The plugin's `signature_emulation` still emits
the full system prompt for every model.

#### 6.1.3 `stop_details` on responses

**What it is:** a structured response-side field that the Anthropic API
populates when `stop_reason === "refusal"`. Shape (from the binary's embedded
SDK docs):

```json
{
  "stop_reason": "refusal",
  "stop_details": {
    "category": "cyber" | "bio" | null,
    "explanation": "<free-form reason text from the safety classifier>"
  }
}
```

This is an API-level **safety refusal classifier** added by Anthropic
server-side, not a Claude Code feature. It surfaces only on completions the
model refused on safety grounds; for normal `end_turn` / `tool_use` /
`max_tokens` completions, the field is absent.

**Evidence from the binary:**

- Embedded Python SDK example at strings line 458861:
  ```python
  if response.stop_reason == "refusal" and response.stop_details:
      print(f"Category: {response.stop_details.category}")
      print(f"Explanation: {response.stop_details.explanation}")
  ```
- Ruby equivalent at 459799-800.
- Plugin transcript normaliser (`o0` / `nzA`) propagates the field on
  reassembled assistant messages:
  ```js
  if (M.normalized[0]?.message.stop_reason !== A.message.stop_reason) {
    for (let O of M.normalized)
      if (O.type === "assistant") {
        O.message.stop_reason = A.message.stop_reason;
        O.message.stop_details = A.message.stop_details; // <-- new in 2.1.143
        O.message.usage = A.message.usage;
      }
  }
  ```

**Risk to the plugin's mimese (real assessment):**

| Scenario                                               | Risk       | Why                                                                                                                         |
| ------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Plugin's SSE re-emitter strips unknown response fields | **MEDIUM** | If the plugin parses + re-serialises assistant message blocks, an unrecognised key may be silently dropped. Need to verify. |
| Plugin passes through raw SSE bytes                    | **NONE**   | Pure-passthrough preserves any new field automatically.                                                                     |
| OpenCode chokes on unknown response field              | **LOW**    | OpenCode typically does property-by-property destructuring; unknown keys are usually ignored.                               |
| Plugin emits `stop_details` on **outbound** requests   | **N/A**    | Field is response-side only. Plugin never sets it on requests.                                                              |

**Action recommended:** the next time someone touches the SSE / response path,
add a smoke test that constructs a synthetic SSE response with
`stop_reason: "refusal", stop_details: {...}` and confirms the field arrives
at OpenCode unchanged. This is P3 in §9.

**Why this matters even if it's "just a passthrough":** if a user runs into a
real refusal and the plugin silently drops `stop_details`, they get
`stop_reason: "refusal"` with no diagnostic info — bad UX. The plugin should
preserve the field even if it doesn't act on it.

### 6.2 Genuinely new in 2.1.143

- `stop_details` referenced in more places (it propagates through more code paths
  in 2.1.143), confirming it's settling as a stable response field.
- Telemetry events (`tengu_*`) added: 50+ new entries, none with direct wire
  impact (all internal). Notable for understanding what's rolling out:
  - `tengu_loop_dynamic_wakeup_ends_turn` -> /loop dynamic mode
  - `tengu_goal_failed` / `_goal_restored_on_resume` -> /goal command lifecycle
  - `tengu_bridge_attestation_enforce` -> client-to-server attestation rollout
  - `tengu_subagent_type_miss` / `_normalized` -> subagent type validation
  - `tengu_model_response_keyword_detected` -> server-classifier-based content gating
  - `tengu_mid_conv_system_fallback_retry` -> retry path for mid-conversation-system beta
  - `tengu_skills_dashboard_enabled` / `tengu_plugin_skills_dir_loaded` -> Skills UX

### 6.3 Body fields confirmed unchanged

- `context_management.edits` types: `clear_thinking_20251015` + `compact_20260112` (both since 2.1.133).
- `context_hint: { enabled: true }` paired with `context-hint-2026-04-09` beta.
- `output_config.effort` values: `low|medium|high`.
- `eager_input_streaming`, `speed`, `thinking.display: summarized`.

---

## 7. Drift risk assessment

| Risk                                                                 | Severity |
| -------------------------------------------------------------------- | -------- |
| Plugin emits exact 2.1.133 fingerprint while target moves to 2.1.143 | LOW      |
| Plugin omits `x-claude-code-agent-id` headers from subagent contexts | NONE     |
| Plugin omits `mid-conversation-system-2026-04-07` beta               | NONE     |
| Plugin omits `cc_workload=` billing segment                          | NONE     |
| Plugin doesn't implement simple-system-prompt mode for Opus 4.7      | LOW      |
| Plugin doesn't process `stop_details` field on responses             | LOW      |

The only mandatory change is the version string itself. Everything else is
opt-in mimicry/economy work.

---

## 8. Opportunities (mimicry + performance + economy)

### 8.1 Mandatory (mimicry parity)

1. Bump `FALLBACK_CLAUDE_CLI_VERSION` to `2.1.143`.
2. Bump `CLAUDE_CODE_BUILD_TIME` to `2026-05-15T17:39:39Z`.
3. Add `CLI_TO_SDK_VERSION` entries for 2.1.134 through 2.1.143 (all map to `0.81.0`).
4. Add `mid-conversation-system-2026-04-07` to `EXPERIMENTAL_BETA_FLAGS`. (Do NOT add to always-on emission until confirmed gated.)
5. Optionally add `user-profiles-2026-03-24` to `EXPERIMENTAL_BETA_FLAGS` for forward-compat.

### 8.2 Tier-1 opportunities (low risk, real upside)

1. **Simple-system-prompt mode (token economy)**
   Add a `token_economy.simple_system_prompt` flag (default off). When true and
   model is `claude-opus-4-7` (or anything matching real CC's `sR9`), emit the
   leaner system prompt. Expected savings: 200-600 input tokens per request on
   short prompts. Real CC ships this gated behind GrowthBook
   `tengu_velvet_cascade`, so opt-in default is correct.

2. **`cc_workload` billing tag passthrough**
   Add `signature_emulation.workload` (string, optional). When set, append
   `cc_workload=<value>;` to the billing header. Lets SDK daemon users tag cron
   traffic for billing attribution exactly like real CC's `--workload` flag.
   Zero cost when unset.

3. **OAuth refresh telemetry alignment**
   The plugin's own refresh-lock instrumentation is rich, but the telemetry
   event names don't match real CC's. If the user runs Datadog/OTEL on opencode,
   aligning event names (e.g. `oauth_token_refresh_lock_acquired`) with real CC's
   helps unified dashboards. Cosmetic, low priority.

### 8.3 Tier-2 opportunities (defer until evidence)

1. **`mid-conversation-system-2026-04-07` opt-in**
   Add a `token_economy.mid_conversation_system` flag (default off). When the
   plugin detects a system reminder being injected mid-conversation (we already
   do this for `<system-reminder>` blocks), set the beta and accept the 422
   fallback retry. Defer until we see real CC sending it in the wild (probably
   server-side rollout pending).

2. **Subagent header propagation (`x-claude-code-agent-id`)**
   Only if OpenCode adopts subagent metadata propagation. Today: no.

3. **`stop_details` response passthrough check**
   Verify the plugin's SSE re-emitter preserves `stop_details`. If not, add a
   small test to lock in that future API additions on the response side don't
   regress.

### 8.4 Performance audit (separate from mimese)

While reading the new tengu events, the plugin's token-economy module looks
solid (10+ flags already shipped). The one CC-mimicry economy gap is the
simple-system-prompt mode (8.2.1 above). The other gaps real CC closed in
2.1.140-2.1.143 are client-side (loop dynamic mode, goal command, skills
dashboard, plugin discovery) and not relevant to the plugin's proxy scope.

The `binarystrings.txt` files are 50 MB each. They will live under
`_tmp_claude_pkg/` and should be `.gitignore`'d if not already. Worth checking.

---

## 9. Action items (prioritized)

| Priority | Item                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| P0       | Bump version constants in `lib/request-headers.mjs` (2.1.133 -> 2.1.143, new BUILD_TIME, CLI_TO_SDK_VERSION entries). |
| P0       | Register `mid-conversation-system-2026-04-07` in `EXPERIMENTAL_BETA_FLAGS`. Shortcut `mid-system` recommended.        |
| P1       | Update `docs/mimese-http-header-system-prompt.md` version-history table with 2.1.143 row.                             |
| P2       | Implement simple-system-prompt mode behind `token_economy.simple_system_prompt` (default off).                        |
| P2       | Add `signature_emulation.workload` to emit `cc_workload=` billing segment when set.                                   |
| P3       | Verify SSE re-emitter preserves `stop_details` on assistant responses.                                                |
| P3       | Register `user-profiles-2026-03-24` in `EXPERIMENTAL_BETA_FLAGS` for forward compat.                                  |
| P3       | Update plugin emit telemetry event names to align with real CC's (`oauth_token_refresh_lock_*`).                      |

---

## 10. Files changed

| File                                                                                 | Change                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs/claude-code-2.1.143-analysis.md                                                 | this file (new)                                                                                                                                                                                                                                                                               |
| docs/mimese-http-header-system-prompt.md                                             | version-history row + mid-conversation-system section                                                                                                                                                                                                                                         |
| docs/future-improvements.md                                                          | items 8 (simple-system-prompt), 9 (cc_workload), 10 (mid-conversation-system) with implementation plan                                                                                                                                                                                        |
| lib/request-headers.mjs                                                              | P0: bump FALLBACK_CLAUDE_CLI_VERSION + BUILD_TIME; add 2.1.134-2.1.143 to CLI_TO_SDK_VERSION; add mid-conversation-system + user-profiles to EXPERIMENTAL_BETA_FLAGS; add mid-conv-system / mid-system shortcuts                                                                              |
| lib/config.mjs                                                                       | P2: add `signature_emulation.workload` (string, default ""); add `token_economy.simple_system_prompt` (boolean, default false)                                                                                                                                                                |
| index.mjs                                                                            | P2: add `isSimpleSystemPromptEligible(model)` helper; extend `buildAnthropicBillingHeader` with `workloadOverride` param; gate anti-verbosity injection off when simple-system-prompt mode is on AND model is eligible; thread `workload` + `simpleSystemPrompt` through `signatureWithModel` |
| index.test.mjs / lib/request-headers.test.mjs / test/conformance/regression.test.mjs | Version assertions bumped 2.1.133 → 2.1.143                                                                                                                                                                                                                                                   |

---

## 11. Implementation status (this session)

| Action item                                                | Status                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| P0: bump version constants                                 | shipped                                              |
| P0: register `mid-conversation-system-2026-04-07`          | shipped                                              |
| P0: register `user-profiles-2026-03-24`                    | shipped                                              |
| P1: update version-history table                           | shipped                                              |
| P2: simple-system-prompt mode (conservative scope)         | shipped                                              |
| P2: `cc_workload` billing segment                          | shipped                                              |
| P3: verify SSE re-emitter preserves `stop_details`         | TODO                                                 |
| P3: align OAuth refresh telemetry event names with real CC | TODO                                                 |
| Tier-2: `mid-conversation-system` opt-in body shape        | TODO (defer until MITM evidence)                     |
| Tier-2: subagent identity header propagation               | TODO (defer until OpenCode exposes subagent context) |

Test suite: **1141/1141 pass** after these changes.

### Simple-system-prompt scope decision

I picked the most conservative useful interpretation: when the flag is on AND
the model is eligible (Opus 4.7 or `-eap` variants), SKIP the plugin's
anti-verbosity boilerplate injection (`ANTI_VERBOSITY_SYSTEM_PROMPT`). That
block is plugin-owned, not required by the CC fingerprint check, and it accounts for the
biggest chunk of plugin-injected system text. Savings: ~600-1500 tokens per
request on eligible models.

What I did NOT do, deliberately:

- Did not strip the identity preamble (`You are Claude Code, ...`) — the
  server uses this to identify CC requests for billing.
- Did not strip the billing header pseudo-block — same reason.
- Did not strip user instruction blocks (CLAUDE.md) — those are user content.
- Did not strip `<system-reminder>` blocks — those carry per-request state.

If a future MITM capture shows real CC stripping more aggressively, the gate
in `buildSystemPromptBlocks` can be widened. For now, this is the most we can
do without risking a fingerprint mismatch.

### Why `cc_workload` is shipped behind a config knob and an env var

Real CC reads its workload tag from a `--workload <tag>` CLI flag, then keeps
it process-scoped. The plugin doesn't have a CLI; the natural surface is:

1. `signature_emulation.workload: "<tag>"` in the JSON config (preferred).
2. `CLAUDE_CODE_WORKLOAD=<tag>` env var (fallback, was already supported).

Config wins. Both are sanitised against header-injection characters
(`[;\s\r\n]` -> `_`). Provider gated: bedrock / anthropicAws / mantle skip the
segment (same gate as `cch=00000`).
