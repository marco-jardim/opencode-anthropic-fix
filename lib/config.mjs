import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { OAUTH_CLIENT_ID } from "./oauth-constants.mjs";

/**
 * @typedef {'sticky' | 'round-robin' | 'hybrid' | 'single'} AccountSelectionStrategy
 */

/**
 * @typedef {object} HealthScoreConfig
 * @property {number} initial
 * @property {number} success_reward
 * @property {number} rate_limit_penalty
 * @property {number} failure_penalty
 * @property {number} recovery_rate_per_hour
 * @property {number} min_usable
 * @property {number} max_score
 */

/**
 * @typedef {object} TokenBucketConfig
 * @property {number} max_tokens
 * @property {number} regeneration_rate_per_minute
 * @property {number} initial_tokens
 */

/**
 * @typedef {object} ToastConfig
 * @property {boolean} quiet - Suppress non-error toasts
 * @property {number} debounce_seconds - Minimum seconds between account-switch toasts
 */

/**
 * @typedef {object} OverrideModelLimitsConfig
 * @property {boolean} enabled - When true, overrides model context limits for 1M-window models so OpenCode compacts at the right threshold.
 * @property {number} context - Context window size to inject (tokens). Default: 1_000_000.
 * @property {number} output - Max output tokens to inject. 0 = leave model default unchanged.
 */

/**
 * @typedef {object} IdleRefreshConfig
 * @property {boolean} enabled - Opportunistically refresh near-expiry idle accounts
 * @property {number} window_minutes - Refresh idle accounts within this many minutes of expiry
 * @property {number} min_interval_minutes - Minimum minutes between idle refresh attempts per account
 */

/**
 * @typedef {object} CachePolicyConfig
 * @property {string} ttl - "1h" (default), "5m", or "off"
 * @property {boolean} ttl_supported - Auto-set to false if API rejects TTL
 * @property {boolean} boundary_marker - Inject static/dynamic boundary marker into system prompt (opt-in)
 * @property {number} hit_rate_warning_threshold - Warn when avg cache hit rate falls below this (0-1). Default: 0.3
 */

/**
 * @typedef {object} AdaptiveContextConfig
 * @property {boolean} enabled - When true, context-1m beta is toggled per-request based on prompt size.  Default: false.
 * @property {number} escalation_threshold - Token count (input+cache) above which 1M context is activated. Default: 150_000.
 * @property {number} deescalation_threshold - Token count below which 1M context is deactivated. Default: 100_000.
 */

/**
 * @typedef {object} CCCredentialReuseConfig
 * @property {boolean} enabled - Master switch for CC credential reuse.  Default: false.
 * @property {boolean} auto_detect - Auto-discover CC credentials on startup. Default: true.
 * @property {boolean} prefer_over_oauth - When true, CC credentials are tried before plugin-managed OAuth accounts. Default: false.
 */

/**
 * @typedef {object} HeaderConfig
 * @property {string} emulation_profile - Claude Code version to emulate in headers
 * @property {Record<string, string>} overrides - Custom header overrides
 * @property {string[]} disable - Headers to disable/remove
 * @property {boolean} billing_header - Whether to include billing header in system prompt
 */

/**
 * @typedef {'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'} DefaultEffort
 */

/**
 * @typedef {object} AccountFeaturesConfig
 * @property {boolean} dispatch_id
 * @property {boolean} message_threads
 * @property {boolean} inline_tools
 * @property {boolean} advisor
 * @property {boolean} tool_provenance
 */

/**
 * @typedef {object} SystemPromptConfig
 * @property {'off' | 'power' | 'research' | 'max' | string[]} empowerment - Package name or an explicit list of block ids. Default: "max".
 * @property {boolean} genuine_opening - Start the stable block with the genuine opening sentence. Default: true.
 * @property {boolean} split_stable_volatile - Split the host block into a stable and a volatile block. Default: true.
 * @property {'base' | 'all'} rewrite_scope - Where the OpenCode -> Claude Code rewrite applies. Default: "base".
 */

/**
 * @typedef {object} AnthropicAuthConfig
 * @property {AccountSelectionStrategy} account_selection_strategy
 * @property {number} failure_ttl_seconds
 * @property {boolean} debug
 * @property {DefaultEffort} default_effort - Effort level injected for adaptive models that support it. Default: "medium".
 * @property {boolean} fast_mode_legacy_models - Allow fast mode on Opus 4.6/4.7 even when the catalogue lacks the capability. Default: false.
 * @property {{ enabled: boolean, fetch_claude_code_version_on_startup: boolean, prompt_compaction: 'minimal' | 'off', workload: string, session_correlation: boolean }} signature_emulation
 *   `fetch_claude_code_version_on_startup` is informational only: the emulated version is pinned by the wire profile.
 * @property {OverrideModelLimitsConfig} override_model_limits
 * @property {string[]} custom_betas
 * @property {HealthScoreConfig} health_score
 * @property {TokenBucketConfig} token_bucket
 * @property {ToastConfig} toasts
 * @property {HeaderConfig} headers
 * @property {IdleRefreshConfig} idle_refresh
 * @property {CachePolicyConfig} cache_policy
 * @property {boolean} fast_mode
 * @property {{emulate_minimal: boolean}} telemetry
 * @property {boolean} usage_toast
 * @property {CCCredentialReuseConfig} cc_credential_reuse
 * @property {AdaptiveContextConfig} adaptive_context
 * @property {{ enabled: boolean, default_max_tokens: number, escalated_max_tokens: number }} output_cap
 * @property {{ enabled: boolean, timeout_ms: number }} preconnect
 * @property {{ enabled: boolean, safety_margin: number }} overflow_recovery
 * @property {{ enabled: boolean, alert_threshold: number, adaptive_breakpoint: boolean }} cache_break_detection
 * @property {{ enabled: boolean, background_max_service_retries: number, background_max_should_retries: number }} request_classification
 * @property {{ enabled: boolean, default: number, completion_threshold: number }} token_budget
 * @property {{ enabled: boolean, threshold_percent: number }} microcompact
 * @property {{ enabled: boolean, default_cooldown_ms: number, poll_quota_on_overload: boolean }} overload_recovery
 * @property {{ proactive_disabled: boolean }} account_management
 * @property {{ enabled: boolean }} anti_verbosity
 * @property {{ sdk_token_useragent: boolean, revoke_on_logout: boolean, plugins_scope: boolean, project_scopes: string[] }} oauth
 * @property {{ org_locked_thinking: boolean, strip_thinking_on_org_switch: boolean }} account_affinity
 * @property {AccountFeaturesConfig} account_features
 * @property {{ enabled: boolean, auto_low_short_questions: boolean, short_question_max_chars: number }} per_turn_effort
 * @property {SystemPromptConfig} system_prompt
 */

/** Accepted values of `default_effort`. */
export const VALID_DEFAULT_EFFORTS = Object.freeze(["auto", "low", "medium", "high", "xhigh", "max"]);

/** Every system-prompt empowerment block id (`system_prompt.empowerment` array form). */
export const EMPOWERMENT_BLOCK_IDS = Object.freeze([
  "ownership",
  "depth",
  "tool_power",
  "persistence",
  "recommendations",
  "proof",
  "research",
  "context_economy",
  "communication",
  "initiative",
]);

/** Named `system_prompt.empowerment` packages (besides "off" and "max", which is all ten blocks). */
export const EMPOWERMENT_PACKAGES = Object.freeze({
  off: Object.freeze([]),
  power: Object.freeze(["ownership", "depth", "persistence", "recommendations", "context_economy", "initiative"]),
  research: Object.freeze([
    "ownership",
    "depth",
    "persistence",
    "recommendations",
    "context_economy",
    "initiative",
    "research",
  ]),
  max: EMPOWERMENT_BLOCK_IDS,
});

/** @type {AnthropicAuthConfig} */
export const DEFAULT_CONFIG = {
  account_selection_strategy: "sticky",
  failure_ttl_seconds: 3600,
  debug: false,
  /** Effort level for adaptive models that support effort: auto | low | medium |
   *  high | xhigh | max. "auto" defers to the catalogue's default effort. The
   *  request builder resolves env `CLAUDE_CODE_EFFORT_LEVEL` first, then this
   *  value, and clamps xhigh/max where the model does not support them. A
   *  host-supplied effort always wins. */
  default_effort: "medium",
  /** Keep fast mode available on Opus 4.6/4.7 even when the model catalogue
   *  does not advertise the fast-mode capability. Opt-in. */
  fast_mode_legacy_models: false,
  signature_emulation: {
    enabled: true,
    /** Informational only: the emulated client version is pinned by the wire
     *  profile. The version fetched from npm is reported (debug, diagnose) but
     *  is never emulated. */
    fetch_claude_code_version_on_startup: true,
    /** Default "off". "minimal" (opt-in) deduplicates repeated system blocks
     *  and uses a compact prompt for title generation. */
    prompt_compaction: "off",
    /** Workload tag emitted in the `x-anthropic-billing-header` as
     *  `cc_workload=<tag>;`. Mirrors real CC's `--workload <tag>` flag — used
     *  by SDK daemon callers that spawn subprocesses for cron work, to tag
     *  billing attribution. Empty string => omit (default). Not provider-gated:
     *  the plugin is Anthropic first-party only, so this segment is emitted
     *  whenever a tag is set (see "Provider Scope" in README.md).
     *  Env var `CLAUDE_CODE_WORKLOAD` is a fallback when this is empty. */
    workload: "",
    /** Correlate requests of one session the way the genuine client does
     *  (prompt id, turn position, previous request/message ids). Inert until the
     *  profile that carries those fields is wired. */
    session_correlation: true,
  },
  override_model_limits: {
    enabled: false,
    context: 1_000_000,
    output: 0,
  },
  custom_betas: [],
  health_score: {
    initial: 70,
    success_reward: 1,
    rate_limit_penalty: -10,
    failure_penalty: -20,
    recovery_rate_per_hour: 2,
    min_usable: 50,
    max_score: 100,
  },
  token_bucket: {
    max_tokens: 50,
    regeneration_rate_per_minute: 6,
    initial_tokens: 50,
  },
  toasts: {
    quiet: false,
    debounce_seconds: 30,
  },
  idle_refresh: {
    enabled: true,
    window_minutes: 60,
    min_interval_minutes: 30,
  },
  cache_policy: {
    ttl: "1h",
    ttl_supported: true,
    boundary_marker: false,
    hit_rate_warning_threshold: 0.3,
  },
  fast_mode: false,
  telemetry: {
    emulate_minimal: false,
  },
  usage_toast: false,
  headers: {
    emulation_profile: "",
    overrides: {},
    disable: [],
    billing_header: true,
  },
  cc_credential_reuse: {
    enabled: false,
    auto_detect: true,
    prefer_over_oauth: false,
  },
  adaptive_context: {
    enabled: true,
    escalation_threshold: 150_000,
    deescalation_threshold: 100_000,
  },
  /** Willow Mode: detect inactivity and suggest context reset. */
  willow_mode: {
    /** Enable idle detection and context-reset suggestions. */
    enabled: true,
    /** Minutes of inactivity before suggesting a fresh context. */
    idle_threshold_minutes: 30,
    /** Minimum minutes between willow suggestions (to avoid nagging). */
    cooldown_minutes: 60,
    /** Minimum turns in the current session before suggesting reset
     *  (no point suggesting reset at the start of a session). */
    min_turns_before_suggest: 3,
  },
  /** SSE response streaming behavior. */
  streaming: {
    /** Byte-stream idle-timeout watchdog (ms). Parity with Claude Code's
     *  `tengu_byte_stream_idle_timeout_ms`: if the upstream produces no bytes for
     *  this long, the reader is cancelled and the stream errors instead of hanging.
     *  0 = disabled (default — Anthropic SSE sends periodic pings, so only set a
     *  multi-minute value to catch genuinely dead connections). Env override:
     *  `OPENCODE_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS`. */
    idle_timeout_ms: 0,
  },
  /** Token economy optimizations. */
  token_economy: {
    /** [DEPRECATED] token-efficient-tools-2026-03-28 was removed in CC v2.1.90.
     *  This flag is retained for config backward compatibility but has no effect. */
    token_efficient_tools: false,
    /** Enable redact-thinking-2026-02-12 beta (suppresses thinking summaries
     *  server-side for lower bandwidth). On by default for non-Claude-3 models
     *  (CC v2.1.150+). Opt out via `/anthropic set redact-thinking off`. */
    redact_thinking: true,
    /** [DEPRECATED — has no effect] context-hint-2026-04-09.
     *  The profile derived from the real Claude Code 2.1.195 binary sends
     *  neither the `context-hint-2026-04-09` beta nor the paired
     *  `context_hint: { enabled: true }` body field. Emitting either one made
     *  the request distinguishable from the genuine client, so both emissions
     *  were removed from every path (adapter and legacy alike). The effect
     *  cannot come back without breaking the mimicry, so this knob is not
     *  silently ignored: validateConfig emits a one-time deprecation warning
     *  when a user explicitly sets it to `true`. Retained only so an existing
     *  config file keeps loading. */
    context_hint: false,

    /** Dump outgoing request bodies to
     *  `~/.opencode/opencode-anthropic-fix/request-dumps/` (rotating, last 10).
     *  Diagnostic tool — enable, run 3-4 conversation turns, ship the files
     *  so we can diff what's changing between turns. Writes raw JSON bodies,
     *  so contains user conversation content — don't enable on a shared host. */
    debug_dump_bodies: false,

    /** Conservative mode (default ON). Disables every history-rewriting and
     *  tool-array transform below that can invalidate the prompt-cache prefix
     *  turn-to-turn. Rationale: every rewrite risks breaking the 1h cache,
     *  forcing a fresh cache_write (2x base input cost). For long opencode
     *  sessions, cache reuse dominates per-turn cost — the optimizations below
     *  save kB in the request body but cost much more in cache misses.
     *  Affects: ttl_thinking_strip, proactive_microcompact, trailing_summary_trim,
     *  tool_result_dedupe, stable_tool_ordering, deferred_tool_names.
     *  Unaffected: adaptive_thinking_zero_simple (only changes thinking budget). */
    conservative: true,

    /** Only rewrite history (thinking strip and the other `conservative`-gated
     *  transforms) when the prompt cache is already cold, i.e. the time since the
     *  last main request exceeds the cache TTL. A rewrite on a warm cache would
     *  force a fresh cache write for no benefit. Default OFF. */
    cold_cache_only: false,

    /** Genuine-client idle tool-result clearing: when the cache is cold, replace
     *  old tool results with a placeholder. Opt-in, default OFF. */
    idle_tool_result_clearing: false,

    /** Idle compaction: summarize the session while idle, shortly before the
     *  prompt cache expires. Opt-in, default OFF. */
    idle_compaction: false,

    /** Minimum estimated context size (tokens) before idle compaction fires.
     *  Clamped to 100_000-2_000_000. */
    idle_compaction_min_tokens: 200_000,

    /** TTL-based thinking strip (CC parity). When the time since the last
     *  thinking strip exceeds the cache TTL, drop all `thinking` /
     *  `redacted_thinking` blocks from prior assistant messages. Mirrors CC's
     *  `logThinkingClearLatched("ttl", ...)` behavior. Zero quality impact
     *  because stale thinking blocks don't influence the next response. */
    ttl_thinking_strip: true,

    /** Proactive client-side microcompact. At or above `microcompact_percent`
     *  of the model context window, replace old tool_result content with a
     *  placeholder (keeping the last `microcompact_keep_recent` verbatim).
     *  Runs BEFORE the request hits the server — preempts 422s. */
    proactive_microcompact: true,
    microcompact_percent: 70,
    microcompact_keep_recent: 8,

    /** Stable tool ordering — sort tools deterministically across turns so
     *  the system-prompt prefix stays cache-stable. Safe and cheap. */
    stable_tool_ordering: true,

    /** Tool schema deferral — ship minimal (name+description only) schemas
     *  for tools below the defer threshold until they're actually invoked in
     *  the session. Accepts a list of tool names to defer. Empty = feature off. */
    deferred_tool_names: [],

    /** Adaptive thinking — zero the thinking budget for simple follow-up
     *  user turns (short user message, no file refs, no tool_use in prior
     *  assistant turn). Reduces thinking tokens on trivial exchanges.
     *  Default OFF: changing the thinking configuration between turns
     *  invalidates the message cache, and current models reject disabled
     *  thinking. Thinking stays adaptive and stable. */
    adaptive_thinking_zero_simple: false,

    /** Cross-turn tool_result dedupe — when the same (tool_use_name + input)
     *  appears twice, replace the later result content with a pointer to the
     *  earlier tool_use_id. Opt-in; can surprise models that expected a fresh
     *  read. Applies only to read-only tools in the safe set. */
    tool_result_dedupe: false,

    /** Fast-mode auto-opt-in — detect simple exchanges (short user msg, no
     *  tools likely needed) and emit speed:fast for that turn. Opt-in. */
    fast_mode_auto: false,

    /** Trailing-summary trimmer — detect trailing summary paragraphs in past
     *  assistant text blocks and strip them from the outgoing messages array.
     *  Opt-in; can hide context the model relied on. */
    trailing_summary_trim: false,

    /** Role-scoped cache TTL (CC parity). Real CC's MoY(querySource) gates
     *  `ttl:"1h"` on an allowlist of query sources (`repl_main_thread*`, `sdk`,
     *  `auto_mode`). Everything else falls back to the 5m tier, which is
     *  cheaper to write. Matches by classifying request role: main → 1h (or
     *  whatever signature.cachePolicy.ttl is configured as), else → 5m.
     *  Default ON: this MATCHES real CC behaviour (main thread 1h, side-queries
     *  5m) and only makes non-main cache writes cheaper — no fingerprint risk. */
    role_scoped_cache_ttl: true,

    /** Lean system prompt for non-main requests. For title-gen / small /
     *  subagent-shaped requests, strip billing identity + CC identity
     *  injection. Saves ~1-2kB per request. Default OFF (opt-in): a stripped
     *  identity/billing block makes those requests differ from what the genuine
     *  client sends. The main interactive thread is untouched either way. */
    lean_system_non_main: false,

    /** Simple system prompt mode (real CC v2.1.133+ `tengu_velvet_tide`
     *  equivalent). When enabled AND the request model is eligible
     *  (claude-opus-4-7, -eap variants — see `isSimpleSystemPromptEligible`),
     *  skip the anti-verbosity boilerplate (`ANTI_VERBOSITY_SYSTEM_PROMPT`)
     *  that the plugin injects on Opus 4.x.
     *  Conservative implementation: gates ONLY anti-verbosity. Identity
     *  preamble, billing block, user instructions, and `<system-reminder>`
     *  blocks are all preserved so the CC fingerprint match still holds.
     *  Saves ~600-1500 tokens per request on eligible models. Default ON:
     *  gates ONLY the anti-verbosity boilerplate (which real CC v2.1.133+ also
     *  drops for eligible Opus 4.x via tengu_velvet_tide); identity, billing
     *  and system-reminders are preserved, so the fingerprint match holds. */
    simple_system_prompt: true,

    // NOTE: identical-tool-call short-circuit was considered but requires SSE
    // response-stream rewriting that breaks normal tool-execution semantics.
    // Tracked as future work — not exposed as a config flag here.
  },
  /** Advanced strategies that may trade cache stability for verbosity reduction.
   *  Default OFF because most produce a net cache loss on long sessions. */
  token_economy_strategies: {
    /** System prompt tailing: after N turns, trim large system blocks.
     *  Default OFF — causes cache break over history cached under the
     *  pre-tail system hash. Opt in for short sessions with huge prompts. */
    system_prompt_tailing: false,
    /** Turn count at which tailing starts (if enabled). */
    system_prompt_tail_turns: 6,
    /** Max chars per system block after tailing. */
    system_prompt_tail_max_chars: 2000,
    /** Tool deferral (send sparse schemas until first use). Default OFF. */
    tool_deferral: false,
    /** Tool description compaction (strip example output). Default OFF. */
    tool_description_compaction: false,
    /** Adaptive tool set (main vs subagent roles). Default OFF. */
    adaptive_tool_set: false,
    /** Replace old reproducible-tool results (Read/Grep/Glob/LS) with stubs
     *  when a later call with identical args produces a fresh result. Saves
     *  10-20% on long sessions. Pure over message history → cache-stable.
     *  Off by default (conservative mode territory). */
    tool_result_dedupe_session_wide: false,
    /** Haiku rolling-summary compaction: when a matching opencode fork
     *  exposes the `experimental.session.summarize` hook, the plugin calls
     *  claude-haiku-4-5-20251001 at temperature 0 to produce the compaction
     *  summary, bypassing the main model. Requires opencode fork support
     *  — no-op without it. Off by default. */
    haiku_rolling_summary: false,
    /** Stale-read eviction: replace `read`/`view` tool outputs from
     *  messages older than N turns with a placeholder. Runs on every
     *  request via `experimental.chat.messages.transform`. Saves
     *  ~1-2KB per old read × conversation depth. Off by default. */
    stale_read_eviction: false,
    /** Per-tool-class prune thresholds: apply different token budgets
     *  to reproducible (read/grep/glob/ls) vs stateful (bash/edit/write)
     *  tool outputs during request assembly. Reproducible outputs can
     *  be re-run on demand, so they prune at a lower threshold. Off by
     *  default — when ON, uses 10_000/40_000 token budgets. */
    per_tool_class_prune: false,
  },
  /** Output cap: default max_tokens to save context window. Default OFF
   *  (opt-in): the caller's max_tokens passes through unchanged. */
  output_cap: {
    enabled: false,
    default_max_tokens: 8_000,
    escalated_max_tokens: 64_000,
  },
  /** API preconnect: fire-and-forget HEAD to pre-warm TCP+TLS. */
  preconnect: {
    enabled: true,
    timeout_ms: 10_000,
  },
  /** Context overflow auto-recovery: parse error, reduce max_tokens, retry once. */
  overflow_recovery: {
    enabled: true,
    safety_margin: 1_000,
  },
  /** Cache break detection: alert when cache_read_input_tokens drops significantly. */
  cache_break_detection: {
    enabled: true,
    alert_threshold: 2_000,
    /**
     * Adaptive breakpoint placement (opt-in). When true, the prompt-cache
     * breakpoint is anchored on the most-stable boundary (e.g. the system
     * prompt) instead of always on the last tool. This is a DELIBERATE
     * divergence from Claude Code, useful for hosts (like opencode) whose tool
     * array order/count is less stable than CC's. Default true (opencode's tool
     * presentation is less stable than CC's, so adaptive anchoring improves cache
     * hit rate). Set false to force exact CC behavior. Safe either way: with no
     * stability baseline (first turns) it falls back to CC's last-tool breakpoint.
     */
    adaptive_breakpoint: true,
  },
  /** Request classification: reduced retry budget for background requests. */
  request_classification: {
    enabled: true,
    background_max_service_retries: 0,
    background_max_should_retries: 1,
  },
  /** Token budget: parse NL budget expressions, track output, enforce limits. */
  token_budget: {
    enabled: false,
    default: 0,
    completion_threshold: 0.9,
  },
  /** Microcompact: tracks context utilization and shows a toast at the
   *  threshold. It injects nothing on the wire. */
  microcompact: {
    enabled: true,
    threshold_percent: 80,
  },
  /** Overload recovery: quota-aware account switching on 529 exhaustion. */
  overload_recovery: {
    enabled: true,
    /** Cooldown (ms) applied to overloaded accounts when no quota data available. */
    default_cooldown_ms: 60_000,
    /** Whether to poll /api/oauth/usage on 529 exhaustion for smarter cooldowns. */
    poll_quota_on_overload: true,
  },
  /** Account management: control automatic account penalties and switching.
   *  When proactive_disabled is true (default), the plugin will NOT apply
   *  utilization penalties, surpassed-threshold penalties, or predictive
   *  switches based on response headers (200 OK responses). Reactive 429
   *  handling still works. This makes account switching fully manual and
   *  prevents single-account users from being locally locked out by warning
   *  thresholds the server still allows. */
  account_management: {
    proactive_disabled: true,
  },
  /** Anti-verbosity: inject conciseness instructions into system prompt for Opus 4.6.
   *  Mirrors the CC anti_verbosity section (gated on the quiet_salted_ember A/B
   *  test in CC). Default OFF (opt-in): the injected text is byte-identical when
   *  enabled. Only activates when model is opus-4-6. */
  anti_verbosity: {
    /** Master switch: inject anti-verbosity communication style instructions. */
    enabled: false,
  },
  /** OAuth token-endpoint request fingerprint. */
  oauth: {
    /** [DEPRECATED — has no effect] Formerly selected between the SDK
     *  fingerprint and a legacy axios one. The genuine client's token requests
     *  carry the genuine axios fingerprint, so every token request sends that
     *  one shape regardless of this switch; a user-selectable fingerprint could
     *  only make a user the only client on the network sending a different one.
     *  The key stays recognised so existing config files keep loading, and an
     *  explicit value warns once per process. */
    sdk_token_useragent: true,
    /** Attempt server-side revocation on logout. Default OFF. The request goes
     *  to `${TOKEN_URL}/revoke` with the genuine axios fingerprint, but the
     *  genuine CLI does not revoke on every logout, so it stays an opt-in that a
     *  user chooses knowingly.
     *  @see docs/oauth-2.1.329-contract.md §2 */
    revoke_on_logout: false,
    /** Request the `user:plugins` scope at authorize time. Default ON: the
     *  genuine client requests it. An explicit `false` diverges from the genuine
     *  client and warns once per process. */
    plugins_scope: true,
    /** [DEPRECATED — has no effect] Formerly added `user:projects:read` /
     *  `user:projects:write` to the authorize scopes. The genuine client never
     *  sends project scopes, so the key is ignored and always resolves to an
     *  empty list. It stays recognised so existing config files keep loading;
     *  a non-empty value warns once per process. */
    project_scopes: Object.freeze([]),
  },
  /** Organization affinity (accounts that belong to different organizations). */
  account_affinity: {
    /** Models whose thinking blocks are bound to the organization that produced
     *  them: keep a session on the account of the same organization when one is
     *  usable. */
    org_locked_thinking: true,
    /** When no account of the same organization is usable, strip prior thinking
     *  blocks from the history instead of sending them to another organization.
     *  Opt-in. */
    strip_thinking_on_org_switch: false,
  },
  /** Optional per-account request features (all opt-in, default OFF). Inert
   *  until the profile that carries them is wired. */
  account_features: {
    dispatch_id: false,
    message_threads: false,
    inline_tools: false,
    advisor: false,
    tool_provenance: false,
  },
  /** Per-turn effort: effort changes mid-conversation go through the genuine
   *  per-turn control message so the cached prefix stays intact (lib/per-turn-effort.mjs).
   *  Only models whose catalogue entry declares `per_turn_effort` take part. */
  per_turn_effort: {
    enabled: true,
    /** Send effort "low" for a short typed question (this turn only). */
    auto_low_short_questions: true,
    /** Longest question (characters) that counts as short. */
    short_question_max_chars: 280,
  },
  /** Host system-prompt handling. */
  system_prompt: {
    /** "off" | "power" | "research" | "max" | array of block ids
     *  (ownership, depth, tool_power, persistence, recommendations, proof,
     *  research, context_economy, communication, initiative). */
    empowerment: "max",
    /** Start the stable system block with the genuine opening sentence. */
    genuine_opening: true,
    /** Split the host block into a stable and a volatile (env, project
     *  instruction files) block so the stable part keeps its cache. */
    split_stable_volatile: true,
    /** "base": the OpenCode -> Claude Code rewrite applies only to the base
     *  prompt and the env header. "all": legacy, rewrite everywhere. */
    rewrite_scope: "base",
  },
};

export const VALID_STRATEGIES = ["sticky", "round-robin", "hybrid", "single"];

/** The OAuth client ID for Anthropic auth flows.
 *  Re-exported from ./oauth-constants.mjs so there is exactly one literal in
 *  the repository; this alias exists for the call sites that already import it
 *  from here. */
export const CLIENT_ID = OAUTH_CLIENT_ID;

/**
 * Build a deep-cloned config object from defaults.
 * @returns {AnthropicAuthConfig}
 */
function createDefaultConfig() {
  return {
    ...DEFAULT_CONFIG,
    signature_emulation: { ...DEFAULT_CONFIG.signature_emulation },
    anti_verbosity: { ...DEFAULT_CONFIG.anti_verbosity },
    account_affinity: { ...DEFAULT_CONFIG.account_affinity },
    account_features: { ...DEFAULT_CONFIG.account_features },
    per_turn_effort: { ...DEFAULT_CONFIG.per_turn_effort },
    system_prompt: { ...DEFAULT_CONFIG.system_prompt },
    override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...DEFAULT_CONFIG.custom_betas],
    health_score: { ...DEFAULT_CONFIG.health_score },
    token_bucket: { ...DEFAULT_CONFIG.token_bucket },
    toasts: { ...DEFAULT_CONFIG.toasts },
    idle_refresh: { ...DEFAULT_CONFIG.idle_refresh },
    cache_policy: { ...DEFAULT_CONFIG.cache_policy },
    fast_mode: DEFAULT_CONFIG.fast_mode,
    telemetry: { ...DEFAULT_CONFIG.telemetry },
    headers: { ...DEFAULT_CONFIG.headers, overrides: {}, disable: [] },
    cc_credential_reuse: { ...DEFAULT_CONFIG.cc_credential_reuse },
    adaptive_context: { ...DEFAULT_CONFIG.adaptive_context },
    willow_mode: { ...DEFAULT_CONFIG.willow_mode },
    token_economy: { ...DEFAULT_CONFIG.token_economy },
    token_economy_strategies: { ...DEFAULT_CONFIG.token_economy_strategies },
    output_cap: { ...DEFAULT_CONFIG.output_cap },
    preconnect: { ...DEFAULT_CONFIG.preconnect },
    overflow_recovery: { ...DEFAULT_CONFIG.overflow_recovery },
    cache_break_detection: { ...DEFAULT_CONFIG.cache_break_detection },
    request_classification: { ...DEFAULT_CONFIG.request_classification },
    token_budget: { ...DEFAULT_CONFIG.token_budget },
    microcompact: { ...DEFAULT_CONFIG.microcompact },
    overload_recovery: { ...DEFAULT_CONFIG.overload_recovery },
    account_management: { ...DEFAULT_CONFIG.account_management },
    oauth: { ...DEFAULT_CONFIG.oauth, project_scopes: [...DEFAULT_CONFIG.oauth.project_scopes] },
  };
}

/**
 * Get the OpenCode config directory (XDG-compliant).
 * @returns {string}
 */
export function getConfigDir() {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get the path to the config file.
 * @returns {string}
 */
export function getConfigPath() {
  return join(getConfigDir(), "anthropic-auth.json");
}

/**
 * Clamp a number to a range.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Validate and merge a partial config with defaults.
 * @param {Record<string, unknown>} raw
 * @returns {AnthropicAuthConfig}
 */
/**
 * One-shot latch for the `token_economy.context_hint` deprecation warning, so a
 * long-running session does not repeat it on every config reload.
 * @type {boolean}
 */
let contextHintDeprecationWarned = false;

/** One-time latch for the `oauth.sdk_token_useragent` deprecation warning. */
let sdkTokenUserAgentDeprecationWarned = false;

/** One-time latch for the deprecated `oauth.project_scopes` warning. */
let projectScopesDeprecationWarned = false;

/** One-time latch for the `oauth.plugins_scope: false` divergence warning. */
let pluginsScopeOptOutWarned = false;

/** One-time latch for the unknown `system_prompt.empowerment` warning. */
let empowermentInvalidWarned = false;

/** One-time latch for the dropped `system_prompt.empowerment` block-id warning. */
let empowermentDroppedWarned = false;

/**
 * Normalise `system_prompt.empowerment`. Unknown values fall back to the
 * default with a one-time warning; unknown block ids in the array form are
 * dropped (also with a one-time warning). Duplicates are removed, order kept.
 * @param {unknown} value
 * @returns {'off' | 'power' | 'research' | 'max' | string[]}
 */
function normalizeEmpowerment(value) {
  const fallback = DEFAULT_CONFIG.system_prompt.empowerment;
  if (value === undefined) return fallback;

  if (typeof value === "string") {
    const name = value.trim().toLowerCase();
    if (Object.hasOwn(EMPOWERMENT_PACKAGES, name)) {
      return /** @type {'off' | 'power' | 'research' | 'max'} */ (name);
    }
  } else if (Array.isArray(value)) {
    const requested = value.filter((id) => typeof id === "string").map((id) => id.trim().toLowerCase());
    const known = [...new Set(requested.filter((id) => EMPOWERMENT_BLOCK_IDS.includes(id)))];
    const dropped = value.filter(
      (id) => typeof id !== "string" || !EMPOWERMENT_BLOCK_IDS.includes(id.trim().toLowerCase()),
    );
    if (dropped.length > 0 && !empowermentDroppedWarned) {
      empowermentDroppedWarned = true;
      console.warn(
        `[anthropic-auth] system_prompt.empowerment contains unknown block ids that were dropped: ` +
          `${dropped.map(String).join(", ")}. Known ids are: ${EMPOWERMENT_BLOCK_IDS.join(", ")}.`,
      );
    }
    return known;
  }

  if (!empowermentInvalidWarned) {
    empowermentInvalidWarned = true;
    console.warn(
      `[anthropic-auth] system_prompt.empowerment has an unknown value; using "${fallback}". ` +
        `Accepted: ${Object.keys(EMPOWERMENT_PACKAGES).join(", ")}, or an array of block ids.`,
    );
  }
  return fallback;
}

function validateConfig(raw) {
  const config = createDefaultConfig();

  if (typeof raw.account_selection_strategy === "string" && VALID_STRATEGIES.includes(raw.account_selection_strategy)) {
    config.account_selection_strategy = /** @type {AccountSelectionStrategy} */ (raw.account_selection_strategy);
  }

  config.failure_ttl_seconds = clampNumber(raw.failure_ttl_seconds, 60, 7200, DEFAULT_CONFIG.failure_ttl_seconds);

  if (typeof raw.debug === "boolean") {
    config.debug = raw.debug;
  }

  // Default effort: unknown values fall back to the default rather than throwing,
  // so an existing config file keeps loading.
  if (typeof raw.default_effort === "string") {
    const effort = raw.default_effort.trim().toLowerCase();
    if (VALID_DEFAULT_EFFORTS.includes(effort)) {
      config.default_effort = /** @type {DefaultEffort} */ (effort);
    }
  }

  config.fast_mode_legacy_models =
    typeof raw.fast_mode_legacy_models === "boolean"
      ? raw.fast_mode_legacy_models
      : DEFAULT_CONFIG.fast_mode_legacy_models;

  // Signature emulation sub-config
  if (raw.signature_emulation && typeof raw.signature_emulation === "object") {
    const se = /** @type {Record<string, unknown>} */ (raw.signature_emulation);
    config.signature_emulation = {
      enabled: typeof se.enabled === "boolean" ? se.enabled : DEFAULT_CONFIG.signature_emulation.enabled,
      fetch_claude_code_version_on_startup:
        typeof se.fetch_claude_code_version_on_startup === "boolean"
          ? se.fetch_claude_code_version_on_startup
          : DEFAULT_CONFIG.signature_emulation.fetch_claude_code_version_on_startup,
      prompt_compaction:
        se.prompt_compaction === "off" || se.prompt_compaction === "minimal"
          ? se.prompt_compaction
          : DEFAULT_CONFIG.signature_emulation.prompt_compaction,
      workload: typeof se.workload === "string" ? se.workload.trim() : DEFAULT_CONFIG.signature_emulation.workload,
      session_correlation:
        typeof se.session_correlation === "boolean"
          ? se.session_correlation
          : DEFAULT_CONFIG.signature_emulation.session_correlation,
    };
  }

  // Override model limits sub-config
  if (raw.override_model_limits && typeof raw.override_model_limits === "object") {
    const oml = /** @type {Record<string, unknown>} */ (raw.override_model_limits);
    config.override_model_limits = {
      enabled: typeof oml.enabled === "boolean" ? oml.enabled : DEFAULT_CONFIG.override_model_limits.enabled,
      context: clampNumber(oml.context, 200_000, 2_000_000, DEFAULT_CONFIG.override_model_limits.context),
      output: clampNumber(oml.output, 0, 128_000, DEFAULT_CONFIG.override_model_limits.output),
    };
  }

  // Custom betas
  if (Array.isArray(raw.custom_betas)) {
    config.custom_betas = raw.custom_betas.filter((b) => typeof b === "string" && b.trim()).map((b) => b.trim());
  }

  // Health score sub-config
  if (raw.health_score && typeof raw.health_score === "object") {
    const hs = /** @type {Record<string, unknown>} */ (raw.health_score);
    config.health_score = {
      initial: clampNumber(hs.initial, 0, 100, DEFAULT_CONFIG.health_score.initial),
      success_reward: clampNumber(hs.success_reward, 0, 10, DEFAULT_CONFIG.health_score.success_reward),
      rate_limit_penalty: clampNumber(hs.rate_limit_penalty, -50, 0, DEFAULT_CONFIG.health_score.rate_limit_penalty),
      failure_penalty: clampNumber(hs.failure_penalty, -100, 0, DEFAULT_CONFIG.health_score.failure_penalty),
      recovery_rate_per_hour: clampNumber(
        hs.recovery_rate_per_hour,
        0,
        20,
        DEFAULT_CONFIG.health_score.recovery_rate_per_hour,
      ),
      min_usable: clampNumber(hs.min_usable, 0, 100, DEFAULT_CONFIG.health_score.min_usable),
      max_score: clampNumber(hs.max_score, 50, 100, DEFAULT_CONFIG.health_score.max_score),
    };
  }

  // Toast sub-config
  if (raw.toasts && typeof raw.toasts === "object") {
    const t = /** @type {Record<string, unknown>} */ (raw.toasts);
    config.toasts = {
      quiet: typeof t.quiet === "boolean" ? t.quiet : DEFAULT_CONFIG.toasts.quiet,
      debounce_seconds: clampNumber(t.debounce_seconds, 0, 300, DEFAULT_CONFIG.toasts.debounce_seconds),
    };
  }

  // Token bucket sub-config
  if (raw.token_bucket && typeof raw.token_bucket === "object") {
    const tb = /** @type {Record<string, unknown>} */ (raw.token_bucket);
    config.token_bucket = {
      max_tokens: clampNumber(tb.max_tokens, 1, 1000, DEFAULT_CONFIG.token_bucket.max_tokens),
      regeneration_rate_per_minute: clampNumber(
        tb.regeneration_rate_per_minute,
        0.1,
        60,
        DEFAULT_CONFIG.token_bucket.regeneration_rate_per_minute,
      ),
      initial_tokens: clampNumber(tb.initial_tokens, 1, 1000, DEFAULT_CONFIG.token_bucket.initial_tokens),
    };
  }

  if (raw.headers && typeof raw.headers === "object") {
    const h = /** @type {Record<string, unknown>} */ (raw.headers);

    if (typeof h.emulation_profile === "string" && h.emulation_profile.trim()) {
      config.headers.emulation_profile = h.emulation_profile.trim();
    }

    if (h.overrides && typeof h.overrides === "object" && !Array.isArray(h.overrides)) {
      /** @type {Record<string, string>} */
      const overrides = {};
      for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (h.overrides))) {
        if (!key) continue;
        if (typeof value === "string") {
          overrides[key] = value;
        }
      }
      config.headers.overrides = overrides;
    }

    if (Array.isArray(h.disable)) {
      config.headers.disable = h.disable
        .filter((v) => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    }

    if (typeof h.billing_header === "boolean") {
      config.headers.billing_header = h.billing_header;
    }
  }

  if (raw.idle_refresh && typeof raw.idle_refresh === "object") {
    const ir = /** @type {Record<string, unknown>} */ (raw.idle_refresh);
    config.idle_refresh = {
      enabled: typeof ir.enabled === "boolean" ? ir.enabled : DEFAULT_CONFIG.idle_refresh.enabled,
      window_minutes: clampNumber(ir.window_minutes, 1, 24 * 60, DEFAULT_CONFIG.idle_refresh.window_minutes),
      min_interval_minutes: clampNumber(
        ir.min_interval_minutes,
        1,
        24 * 60,
        DEFAULT_CONFIG.idle_refresh.min_interval_minutes,
      ),
    };
  }

  // Cache policy sub-config
  if (raw.cache_policy && typeof raw.cache_policy === "object") {
    const cp = /** @type {Record<string, unknown>} */ (raw.cache_policy);
    const validTtls = ["1h", "5m", "off"];
    config.cache_policy = {
      ttl: typeof cp.ttl === "string" && validTtls.includes(cp.ttl) ? cp.ttl : DEFAULT_CONFIG.cache_policy.ttl,
      ttl_supported:
        typeof cp.ttl_supported === "boolean" ? cp.ttl_supported : DEFAULT_CONFIG.cache_policy.ttl_supported,
      boundary_marker:
        typeof cp.boundary_marker === "boolean" ? cp.boundary_marker : DEFAULT_CONFIG.cache_policy.boundary_marker,
      hit_rate_warning_threshold:
        typeof cp.hit_rate_warning_threshold === "number" && Number.isFinite(cp.hit_rate_warning_threshold)
          ? Math.max(0, Math.min(1, cp.hit_rate_warning_threshold))
          : DEFAULT_CONFIG.cache_policy.hit_rate_warning_threshold,
    };
  }

  // Fast mode
  config.fast_mode = typeof raw.fast_mode === "boolean" ? raw.fast_mode : false;

  // Telemetry
  config.telemetry = config.telemetry || {};
  config.telemetry.emulate_minimal =
    typeof raw.telemetry?.emulate_minimal === "boolean"
      ? raw.telemetry.emulate_minimal
      : DEFAULT_CONFIG.telemetry.emulate_minimal;

  // Usage toast
  config.usage_toast = typeof raw.usage_toast === "boolean" ? raw.usage_toast : DEFAULT_CONFIG.usage_toast;

  // CC credential reuse sub-config
  if (raw.cc_credential_reuse && typeof raw.cc_credential_reuse === "object") {
    const cc = /** @type {Record<string, unknown>} */ (raw.cc_credential_reuse);
    config.cc_credential_reuse = {
      enabled: typeof cc.enabled === "boolean" ? cc.enabled : DEFAULT_CONFIG.cc_credential_reuse.enabled,
      auto_detect:
        typeof cc.auto_detect === "boolean" ? cc.auto_detect : DEFAULT_CONFIG.cc_credential_reuse.auto_detect,
      prefer_over_oauth:
        typeof cc.prefer_over_oauth === "boolean"
          ? cc.prefer_over_oauth
          : DEFAULT_CONFIG.cc_credential_reuse.prefer_over_oauth,
    };
  }

  // Adaptive context sub-config
  if (raw.adaptive_context && typeof raw.adaptive_context === "object") {
    const ac = /** @type {Record<string, unknown>} */ (raw.adaptive_context);
    config.adaptive_context = {
      enabled: typeof ac.enabled === "boolean" ? ac.enabled : DEFAULT_CONFIG.adaptive_context.enabled,
      escalation_threshold: clampNumber(
        ac.escalation_threshold,
        50_000,
        500_000,
        DEFAULT_CONFIG.adaptive_context.escalation_threshold,
      ),
      deescalation_threshold: clampNumber(
        ac.deescalation_threshold,
        20_000,
        400_000,
        DEFAULT_CONFIG.adaptive_context.deescalation_threshold,
      ),
    };
    // Cross-validate: deescalation must be strictly less than escalation to maintain hysteresis gap
    if (config.adaptive_context.deescalation_threshold >= config.adaptive_context.escalation_threshold) {
      config.adaptive_context.deescalation_threshold = Math.max(
        20_000,
        config.adaptive_context.escalation_threshold - 50_000,
      );
    }
  }

  // Willow mode sub-config
  if (raw.willow_mode && typeof raw.willow_mode === "object") {
    const wm = /** @type {Record<string, unknown>} */ (raw.willow_mode);
    config.willow_mode = {
      enabled: typeof wm.enabled === "boolean" ? wm.enabled : DEFAULT_CONFIG.willow_mode.enabled,
      idle_threshold_minutes: clampNumber(
        wm.idle_threshold_minutes,
        1,
        24 * 60,
        DEFAULT_CONFIG.willow_mode.idle_threshold_minutes,
      ),
      cooldown_minutes: clampNumber(wm.cooldown_minutes, 1, 24 * 60, DEFAULT_CONFIG.willow_mode.cooldown_minutes),
      min_turns_before_suggest: clampNumber(
        wm.min_turns_before_suggest,
        0,
        50,
        DEFAULT_CONFIG.willow_mode.min_turns_before_suggest,
      ),
    };
  }

  // Token economy sub-config
  if (raw.token_economy && typeof raw.token_economy === "object") {
    const te = /** @type {Record<string, unknown>} */ (raw.token_economy);

    // Non-silent deprecation. Only an explicit `true` warns: the `false` default
    // costs the user nothing and must stay quiet. See the DEFAULT_CONFIG comment
    // on token_economy.context_hint for why the effect cannot be restored.
    if (te.context_hint === true && !contextHintDeprecationWarned) {
      contextHintDeprecationWarned = true;

      console.warn(
        "[anthropic-auth] token_economy.context_hint is deprecated and has no effect: " +
          "the context-hint-2026-04-09 beta and the context_hint body field are no longer sent on any " +
          "request path, because the genuine Claude Code client does not send them and emitting them " +
          "would make requests fingerprintable. Remove the setting from your config to silence this warning.",
      );
    }

    config.token_economy = {
      token_efficient_tools:
        typeof te.token_efficient_tools === "boolean"
          ? te.token_efficient_tools
          : DEFAULT_CONFIG.token_economy.token_efficient_tools,
      redact_thinking:
        typeof te.redact_thinking === "boolean" ? te.redact_thinking : DEFAULT_CONFIG.token_economy.redact_thinking,
      // DEPRECATED: the value is still normalized so an existing config file
      // keeps loading, but nothing reads it any more — the context-hint beta and
      // body field were removed from every request path because the genuine
      // Claude Code 2.1.195 client does not send them. A user switch that turns
      // into a silent no-op is not acceptable, so an explicit opt-in warns once.
      context_hint: typeof te.context_hint === "boolean" ? te.context_hint : DEFAULT_CONFIG.token_economy.context_hint,
      conservative: typeof te.conservative === "boolean" ? te.conservative : DEFAULT_CONFIG.token_economy.conservative,
      debug_dump_bodies:
        typeof te.debug_dump_bodies === "boolean"
          ? te.debug_dump_bodies
          : DEFAULT_CONFIG.token_economy.debug_dump_bodies,
      ttl_thinking_strip:
        typeof te.ttl_thinking_strip === "boolean"
          ? te.ttl_thinking_strip
          : DEFAULT_CONFIG.token_economy.ttl_thinking_strip,
      proactive_microcompact:
        typeof te.proactive_microcompact === "boolean"
          ? te.proactive_microcompact
          : DEFAULT_CONFIG.token_economy.proactive_microcompact,
      microcompact_percent: clampNumber(
        te.microcompact_percent,
        30,
        95,
        DEFAULT_CONFIG.token_economy.microcompact_percent,
      ),
      microcompact_keep_recent: clampNumber(
        te.microcompact_keep_recent,
        1,
        64,
        DEFAULT_CONFIG.token_economy.microcompact_keep_recent,
      ),
      stable_tool_ordering:
        typeof te.stable_tool_ordering === "boolean"
          ? te.stable_tool_ordering
          : DEFAULT_CONFIG.token_economy.stable_tool_ordering,
      deferred_tool_names: Array.isArray(te.deferred_tool_names)
        ? te.deferred_tool_names.filter((n) => typeof n === "string")
        : DEFAULT_CONFIG.token_economy.deferred_tool_names,
      adaptive_thinking_zero_simple:
        typeof te.adaptive_thinking_zero_simple === "boolean"
          ? te.adaptive_thinking_zero_simple
          : DEFAULT_CONFIG.token_economy.adaptive_thinking_zero_simple,
      tool_result_dedupe:
        typeof te.tool_result_dedupe === "boolean"
          ? te.tool_result_dedupe
          : DEFAULT_CONFIG.token_economy.tool_result_dedupe,
      fast_mode_auto:
        typeof te.fast_mode_auto === "boolean" ? te.fast_mode_auto : DEFAULT_CONFIG.token_economy.fast_mode_auto,
      trailing_summary_trim:
        typeof te.trailing_summary_trim === "boolean"
          ? te.trailing_summary_trim
          : DEFAULT_CONFIG.token_economy.trailing_summary_trim,
      role_scoped_cache_ttl:
        typeof te.role_scoped_cache_ttl === "boolean"
          ? te.role_scoped_cache_ttl
          : DEFAULT_CONFIG.token_economy.role_scoped_cache_ttl,
      lean_system_non_main:
        typeof te.lean_system_non_main === "boolean"
          ? te.lean_system_non_main
          : DEFAULT_CONFIG.token_economy.lean_system_non_main,
      simple_system_prompt:
        typeof te.simple_system_prompt === "boolean"
          ? te.simple_system_prompt
          : DEFAULT_CONFIG.token_economy.simple_system_prompt,
      cold_cache_only:
        typeof te.cold_cache_only === "boolean" ? te.cold_cache_only : DEFAULT_CONFIG.token_economy.cold_cache_only,
      idle_tool_result_clearing:
        typeof te.idle_tool_result_clearing === "boolean"
          ? te.idle_tool_result_clearing
          : DEFAULT_CONFIG.token_economy.idle_tool_result_clearing,
      idle_compaction:
        typeof te.idle_compaction === "boolean" ? te.idle_compaction : DEFAULT_CONFIG.token_economy.idle_compaction,
      idle_compaction_min_tokens: clampNumber(
        te.idle_compaction_min_tokens,
        100_000,
        2_000_000,
        DEFAULT_CONFIG.token_economy.idle_compaction_min_tokens,
      ),
    };
  }

  // Token-economy strategies sub-config (A2: default-off advanced knobs)
  if (raw.token_economy_strategies && typeof raw.token_economy_strategies === "object") {
    const tes = /** @type {Record<string, unknown>} */ (raw.token_economy_strategies);
    config.token_economy_strategies = {
      system_prompt_tailing:
        typeof tes.system_prompt_tailing === "boolean"
          ? tes.system_prompt_tailing
          : DEFAULT_CONFIG.token_economy_strategies.system_prompt_tailing,
      system_prompt_tail_turns: clampNumber(
        tes.system_prompt_tail_turns,
        1,
        1000,
        DEFAULT_CONFIG.token_economy_strategies.system_prompt_tail_turns,
      ),
      system_prompt_tail_max_chars: clampNumber(
        tes.system_prompt_tail_max_chars,
        100,
        50_000,
        DEFAULT_CONFIG.token_economy_strategies.system_prompt_tail_max_chars,
      ),
      tool_deferral:
        typeof tes.tool_deferral === "boolean"
          ? tes.tool_deferral
          : DEFAULT_CONFIG.token_economy_strategies.tool_deferral,
      tool_description_compaction:
        typeof tes.tool_description_compaction === "boolean"
          ? tes.tool_description_compaction
          : DEFAULT_CONFIG.token_economy_strategies.tool_description_compaction,
      adaptive_tool_set:
        typeof tes.adaptive_tool_set === "boolean"
          ? tes.adaptive_tool_set
          : DEFAULT_CONFIG.token_economy_strategies.adaptive_tool_set,
      tool_result_dedupe_session_wide:
        typeof tes.tool_result_dedupe_session_wide === "boolean"
          ? tes.tool_result_dedupe_session_wide
          : DEFAULT_CONFIG.token_economy_strategies.tool_result_dedupe_session_wide,
      haiku_rolling_summary:
        typeof tes.haiku_rolling_summary === "boolean"
          ? tes.haiku_rolling_summary
          : DEFAULT_CONFIG.token_economy_strategies.haiku_rolling_summary,
      stale_read_eviction:
        typeof tes.stale_read_eviction === "boolean"
          ? tes.stale_read_eviction
          : DEFAULT_CONFIG.token_economy_strategies.stale_read_eviction,
      per_tool_class_prune:
        typeof tes.per_tool_class_prune === "boolean"
          ? tes.per_tool_class_prune
          : DEFAULT_CONFIG.token_economy_strategies.per_tool_class_prune,
    };
  }

  // Output cap sub-config
  if (raw.output_cap && typeof raw.output_cap === "object") {
    const oc = /** @type {Record<string, unknown>} */ (raw.output_cap);
    config.output_cap = {
      enabled: typeof oc.enabled === "boolean" ? oc.enabled : DEFAULT_CONFIG.output_cap.enabled,
      default_max_tokens: clampNumber(
        oc.default_max_tokens,
        256,
        200_000,
        DEFAULT_CONFIG.output_cap.default_max_tokens,
      ),
      escalated_max_tokens: clampNumber(
        oc.escalated_max_tokens,
        1_000,
        200_000,
        DEFAULT_CONFIG.output_cap.escalated_max_tokens,
      ),
    };
  }

  // Preconnect sub-config
  if (raw.preconnect && typeof raw.preconnect === "object") {
    const pc = /** @type {Record<string, unknown>} */ (raw.preconnect);
    config.preconnect = {
      enabled: typeof pc.enabled === "boolean" ? pc.enabled : DEFAULT_CONFIG.preconnect.enabled,
      timeout_ms: clampNumber(pc.timeout_ms, 100, 60_000, DEFAULT_CONFIG.preconnect.timeout_ms),
    };
  }

  // Overflow recovery sub-config
  if (raw.overflow_recovery && typeof raw.overflow_recovery === "object") {
    const ovf = /** @type {Record<string, unknown>} */ (raw.overflow_recovery);
    config.overflow_recovery = {
      enabled: typeof ovf.enabled === "boolean" ? ovf.enabled : DEFAULT_CONFIG.overflow_recovery.enabled,
      safety_margin: clampNumber(ovf.safety_margin, 0, 10_000, DEFAULT_CONFIG.overflow_recovery.safety_margin),
    };
  }

  // Cache break detection sub-config
  if (raw.cache_break_detection && typeof raw.cache_break_detection === "object") {
    const cbd = /** @type {Record<string, unknown>} */ (raw.cache_break_detection);
    config.cache_break_detection = {
      enabled: typeof cbd.enabled === "boolean" ? cbd.enabled : DEFAULT_CONFIG.cache_break_detection.enabled,
      alert_threshold: clampNumber(
        cbd.alert_threshold,
        0,
        1_000_000,
        DEFAULT_CONFIG.cache_break_detection.alert_threshold,
      ),
      adaptive_breakpoint:
        typeof cbd.adaptive_breakpoint === "boolean"
          ? cbd.adaptive_breakpoint
          : DEFAULT_CONFIG.cache_break_detection.adaptive_breakpoint,
    };
  }

  // Request classification sub-config
  if (raw.request_classification && typeof raw.request_classification === "object") {
    const rc = /** @type {Record<string, unknown>} */ (raw.request_classification);
    config.request_classification = {
      enabled: typeof rc.enabled === "boolean" ? rc.enabled : DEFAULT_CONFIG.request_classification.enabled,
      background_max_service_retries: clampNumber(
        rc.background_max_service_retries,
        0,
        10,
        DEFAULT_CONFIG.request_classification.background_max_service_retries,
      ),
      background_max_should_retries: clampNumber(
        rc.background_max_should_retries,
        0,
        10,
        DEFAULT_CONFIG.request_classification.background_max_should_retries,
      ),
    };
  }

  // Token budget sub-config
  if (raw.token_budget && typeof raw.token_budget === "object") {
    const tbg = /** @type {Record<string, unknown>} */ (raw.token_budget);
    config.token_budget = {
      enabled: typeof tbg.enabled === "boolean" ? tbg.enabled : DEFAULT_CONFIG.token_budget.enabled,
      default: clampNumber(tbg.default, 0, 1_000_000, DEFAULT_CONFIG.token_budget.default),
      completion_threshold: clampNumber(
        tbg.completion_threshold,
        0,
        1,
        DEFAULT_CONFIG.token_budget.completion_threshold,
      ),
    };
  }

  // Microcompact sub-config
  if (raw.microcompact && typeof raw.microcompact === "object") {
    const mc = /** @type {Record<string, unknown>} */ (raw.microcompact);
    config.microcompact = {
      enabled: typeof mc.enabled === "boolean" ? mc.enabled : DEFAULT_CONFIG.microcompact.enabled,
      threshold_percent: clampNumber(mc.threshold_percent, 0, 100, DEFAULT_CONFIG.microcompact.threshold_percent),
    };
  }

  // Overload recovery sub-config
  if (raw.overload_recovery && typeof raw.overload_recovery === "object") {
    const ovl = /** @type {Record<string, unknown>} */ (raw.overload_recovery);
    config.overload_recovery = {
      enabled: typeof ovl.enabled === "boolean" ? ovl.enabled : DEFAULT_CONFIG.overload_recovery.enabled,
      default_cooldown_ms: clampNumber(
        ovl.default_cooldown_ms,
        1_000,
        3_600_000,
        DEFAULT_CONFIG.overload_recovery.default_cooldown_ms,
      ),
      poll_quota_on_overload:
        typeof ovl.poll_quota_on_overload === "boolean"
          ? ovl.poll_quota_on_overload
          : DEFAULT_CONFIG.overload_recovery.poll_quota_on_overload,
    };
  }

  // Account management sub-config
  if (raw.account_management && typeof raw.account_management === "object") {
    const am = /** @type {Record<string, unknown>} */ (raw.account_management);
    config.account_management = {
      proactive_disabled:
        typeof am.proactive_disabled === "boolean"
          ? am.proactive_disabled
          : DEFAULT_CONFIG.account_management.proactive_disabled,
    };
  }

  // Anti-verbosity sub-config
  if (raw.anti_verbosity && typeof raw.anti_verbosity === "object") {
    const av = /** @type {Record<string, unknown>} */ (raw.anti_verbosity);
    config.anti_verbosity = {
      enabled: typeof av.enabled === "boolean" ? av.enabled : DEFAULT_CONFIG.anti_verbosity.enabled,
    };
  }

  // OAuth token-endpoint fingerprint sub-config
  if (raw.oauth && typeof raw.oauth === "object") {
    const o = /** @type {Record<string, unknown>} */ (raw.oauth);

    // Non-silent deprecation. Any explicit value warns, because both values now
    // produce the same request: a user who set `false` deliberately is relying
    // on behaviour that no longer exists and deserves to be told, and a user who
    // set `true` is carrying a setting that no longer means anything.
    if (typeof o.sdk_token_useragent === "boolean" && !sdkTokenUserAgentDeprecationWarned) {
      sdkTokenUserAgentDeprecationWarned = true;

      // The message deliberately carries no `2.1.<NN>` literal. A version string
      // in production source is exactly what the version-literals conformance
      // guard exists to forbid, and weakening that guard for a log line would
      // trade a real invariant for a cosmetic one.
      console.warn(
        "[anthropic-auth] oauth.sdk_token_useragent is deprecated and has no effect: " +
          "token requests send the genuine axios fingerprint regardless of this setting. " +
          "Remove the setting from your config to silence this warning.",
      );
    }

    // `plugins_scope: false` is a deliberate divergence: the genuine client
    // requests `user:plugins`. Honour it, but say so once.
    if (o.plugins_scope === false && !pluginsScopeOptOutWarned) {
      pluginsScopeOptOutWarned = true;
      console.warn(
        "[anthropic-auth] oauth.plugins_scope is false: the authorize request will omit user:plugins, " +
          "which diverges from the genuine client (it requests that scope). " +
          "Remove the setting to follow the genuine client.",
      );
    }

    // `project_scopes` is deprecated: the genuine client never sends project
    // scopes, so the value is ignored and the resolved list is always empty.
    if (Array.isArray(o.project_scopes) && o.project_scopes.length > 0 && !projectScopesDeprecationWarned) {
      projectScopesDeprecationWarned = true;
      console.warn(
        "[anthropic-auth] oauth.project_scopes is deprecated and has no effect: " +
          "the genuine client never requests project scopes, so none are sent. " +
          "Remove the setting from your config to silence this warning.",
      );
    }

    config.oauth = {
      sdk_token_useragent:
        typeof o.sdk_token_useragent === "boolean" ? o.sdk_token_useragent : DEFAULT_CONFIG.oauth.sdk_token_useragent,
      revoke_on_logout:
        typeof o.revoke_on_logout === "boolean" ? o.revoke_on_logout : DEFAULT_CONFIG.oauth.revoke_on_logout,
      plugins_scope: typeof o.plugins_scope === "boolean" ? o.plugins_scope : DEFAULT_CONFIG.oauth.plugins_scope,
      project_scopes: [],
    };
  }

  // Organization affinity sub-config
  if (raw.account_affinity && typeof raw.account_affinity === "object") {
    const aa = /** @type {Record<string, unknown>} */ (raw.account_affinity);
    config.account_affinity = {
      org_locked_thinking:
        typeof aa.org_locked_thinking === "boolean"
          ? aa.org_locked_thinking
          : DEFAULT_CONFIG.account_affinity.org_locked_thinking,
      strip_thinking_on_org_switch:
        typeof aa.strip_thinking_on_org_switch === "boolean"
          ? aa.strip_thinking_on_org_switch
          : DEFAULT_CONFIG.account_affinity.strip_thinking_on_org_switch,
    };
  }

  // Account features sub-config (all opt-in)
  if (raw.account_features && typeof raw.account_features === "object") {
    const af = /** @type {Record<string, unknown>} */ (raw.account_features);
    config.account_features = {
      dispatch_id: typeof af.dispatch_id === "boolean" ? af.dispatch_id : DEFAULT_CONFIG.account_features.dispatch_id,
      message_threads:
        typeof af.message_threads === "boolean" ? af.message_threads : DEFAULT_CONFIG.account_features.message_threads,
      inline_tools:
        typeof af.inline_tools === "boolean" ? af.inline_tools : DEFAULT_CONFIG.account_features.inline_tools,
      advisor: typeof af.advisor === "boolean" ? af.advisor : DEFAULT_CONFIG.account_features.advisor,
      tool_provenance:
        typeof af.tool_provenance === "boolean" ? af.tool_provenance : DEFAULT_CONFIG.account_features.tool_provenance,
    };
  }

  // Per-turn effort sub-config
  if (raw.per_turn_effort && typeof raw.per_turn_effort === "object") {
    const pt = /** @type {Record<string, unknown>} */ (raw.per_turn_effort);
    config.per_turn_effort = {
      enabled: typeof pt.enabled === "boolean" ? pt.enabled : DEFAULT_CONFIG.per_turn_effort.enabled,
      auto_low_short_questions:
        typeof pt.auto_low_short_questions === "boolean"
          ? pt.auto_low_short_questions
          : DEFAULT_CONFIG.per_turn_effort.auto_low_short_questions,
      short_question_max_chars: Math.round(
        clampNumber(pt.short_question_max_chars, 20, 4_000, DEFAULT_CONFIG.per_turn_effort.short_question_max_chars),
      ),
    };
  }

  // System prompt sub-config
  if (raw.system_prompt && typeof raw.system_prompt === "object" && !Array.isArray(raw.system_prompt)) {
    const sp = /** @type {Record<string, unknown>} */ (raw.system_prompt);
    config.system_prompt = {
      empowerment: normalizeEmpowerment(sp.empowerment),
      genuine_opening:
        typeof sp.genuine_opening === "boolean" ? sp.genuine_opening : DEFAULT_CONFIG.system_prompt.genuine_opening,
      split_stable_volatile:
        typeof sp.split_stable_volatile === "boolean"
          ? sp.split_stable_volatile
          : DEFAULT_CONFIG.system_prompt.split_stable_volatile,
      rewrite_scope:
        sp.rewrite_scope === "base" || sp.rewrite_scope === "all"
          ? sp.rewrite_scope
          : DEFAULT_CONFIG.system_prompt.rewrite_scope,
    };
  }

  return config;
}

/**
 * Apply environment variable overrides.
 * @param {AnthropicAuthConfig} config
 * @returns {AnthropicAuthConfig}
 */
function applyEnvOverrides(config) {
  const env = process.env;

  if (env.OPENCODE_ANTHROPIC_STRATEGY && VALID_STRATEGIES.includes(env.OPENCODE_ANTHROPIC_STRATEGY)) {
    config.account_selection_strategy = /** @type {AccountSelectionStrategy} */ (env.OPENCODE_ANTHROPIC_STRATEGY);
  }

  if (env.OPENCODE_ANTHROPIC_DEBUG === "1" || env.OPENCODE_ANTHROPIC_DEBUG === "true") {
    config.debug = true;
  }
  if (env.OPENCODE_ANTHROPIC_DEBUG === "0" || env.OPENCODE_ANTHROPIC_DEBUG === "false") {
    config.debug = false;
  }

  if (env.OPENCODE_ANTHROPIC_QUIET === "1" || env.OPENCODE_ANTHROPIC_QUIET === "true") {
    config.toasts.quiet = true;
  }
  if (env.OPENCODE_ANTHROPIC_QUIET === "0" || env.OPENCODE_ANTHROPIC_QUIET === "false") {
    config.toasts.quiet = false;
  }

  if (
    env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "1" ||
    env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "true"
  ) {
    config.signature_emulation.enabled = true;
  }
  if (
    env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "0" ||
    env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "false"
  ) {
    config.signature_emulation.enabled = false;
  }

  if (
    env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "1" ||
    env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "true"
  ) {
    config.signature_emulation.fetch_claude_code_version_on_startup = true;
  }
  if (
    env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "0" ||
    env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "false"
  ) {
    config.signature_emulation.fetch_claude_code_version_on_startup = false;
  }

  if (env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION === "off") {
    config.signature_emulation.prompt_compaction = "off";
  }
  if (env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION === "minimal") {
    config.signature_emulation.prompt_compaction = "minimal";
  }

  if (env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "1" || env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "true") {
    config.override_model_limits.enabled = true;
  }
  if (
    env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "0" ||
    env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "false"
  ) {
    config.override_model_limits.enabled = false;
  }

  if (env.OPENCODE_ANTHROPIC_CC_CREDENTIALS === "1" || env.OPENCODE_ANTHROPIC_CC_CREDENTIALS === "true") {
    config.cc_credential_reuse.enabled = true;
  }
  if (env.OPENCODE_ANTHROPIC_CC_CREDENTIALS === "0" || env.OPENCODE_ANTHROPIC_CC_CREDENTIALS === "false") {
    config.cc_credential_reuse.enabled = false;
  }

  if (env.OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT === "1" || env.OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT === "true") {
    config.adaptive_context.enabled = true;
  }
  if (env.OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT === "0" || env.OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT === "false") {
    config.adaptive_context.enabled = false;
  }

  // Account management: env override for proactive penalties / predictive switch.
  // Set to 1/true to disable all proactive account management (matches default).
  // Set to 0/false to re-enable the legacy proactive behavior.
  if (env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "1" || env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "true") {
    config.account_management.proactive_disabled = true;
  }
  if (env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "0" || env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "false") {
    config.account_management.proactive_disabled = false;
  }

  // Anti-verbosity: env override for conciseness injection.
  if (env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "1" || env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "true") {
    config.anti_verbosity.enabled = true;
  }
  if (env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "0" || env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "false") {
    config.anti_verbosity.enabled = false;
  }
  return config;
}

/**
 * Load config from disk, validate, apply env overrides.
 * @returns {AnthropicAuthConfig}
 */
export function loadConfig() {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return applyEnvOverrides(createDefaultConfig());
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const raw = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return applyEnvOverrides(createDefaultConfig());
    }
    const config = validateConfig(raw);
    return applyEnvOverrides(config);
  } catch {
    return applyEnvOverrides(createDefaultConfig());
  }
}

/**
 * Load the raw config JSON from disk (without validation or env overrides).
 * Returns an empty object if the file doesn't exist or is invalid.
 * @returns {Record<string, unknown>}
 */
export function loadRawConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    const content = readFileSync(configPath, "utf-8");
    const raw = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

/**
 * Save a partial config update to disk (read-modify-write).
 * Only writes the keys you provide; other keys are preserved.
 * Uses atomic write (temp + rename) for safety.
 * @param {Record<string, unknown>} updates - Keys to merge into the config file
 */
/**
 * Deep merge source into target (one level deep for objects, replace for arrays/primitives).
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function deepMergeConfig(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] &&
      !Array.isArray(result[key])
    ) {
      result[key] = {
        .../** @type {Record<string, unknown>} */ (result[key]),
        .../** @type {Record<string, unknown>} */ (value),
      };
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function saveConfig(updates) {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });

  // Re-read from disk to avoid clobbering concurrent writes
  const existing = loadRawConfig();

  // Deep merge (one level) so sub-config objects are merged, not replaced
  const merged = deepMergeConfig(existing, updates);

  // Atomic write: temp file + rename
  // QA fix M16: use random bytes to avoid collision with same-process concurrent calls
  const tmpPath = configPath + `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, configPath);
}

/**
 * Load config fresh from disk (bypassing any startup cache).
 * Useful for slash commands that need current on-disk state.
 * @returns {AnthropicAuthConfig}
 */
export function loadConfigFresh() {
  return loadConfig();
}
