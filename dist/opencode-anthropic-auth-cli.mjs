// lib/storage.mjs
import { promises as fs } from "node:fs";
import { existsSync as existsSync2, readFileSync as readFileSync2, appendFileSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { randomBytes as randomBytes2, createHash } from "node:crypto";

// lib/config.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
var DEFAULT_CONFIG = {
  account_selection_strategy: "sticky",
  failure_ttl_seconds: 3600,
  debug: false,
  signature_emulation: {
    enabled: true,
    fetch_claude_code_version_on_startup: true,
    prompt_compaction: "minimal"
  },
  override_model_limits: {
    enabled: false,
    context: 1e6,
    output: 0
  },
  custom_betas: [],
  health_score: {
    initial: 70,
    success_reward: 1,
    rate_limit_penalty: -10,
    failure_penalty: -20,
    recovery_rate_per_hour: 2,
    min_usable: 50,
    max_score: 100
  },
  token_bucket: {
    max_tokens: 50,
    regeneration_rate_per_minute: 6,
    initial_tokens: 50
  },
  toasts: {
    quiet: false,
    debounce_seconds: 30
  },
  idle_refresh: {
    enabled: true,
    window_minutes: 60,
    min_interval_minutes: 30
  },
  cache_policy: {
    ttl: "1h",
    ttl_supported: true,
    boundary_marker: false,
    hit_rate_warning_threshold: 0.3
  },
  fast_mode: false,
  telemetry: {
    emulate_minimal: false
  },
  usage_toast: false,
  headers: {
    emulation_profile: "",
    overrides: {},
    disable: [],
    billing_header: true
  },
  cc_credential_reuse: {
    enabled: false,
    auto_detect: true,
    prefer_over_oauth: false
  },
  adaptive_context: {
    enabled: true,
    escalation_threshold: 15e4,
    deescalation_threshold: 1e5
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
    min_turns_before_suggest: 3
  },
  /** Token economy optimizations. */
  token_economy: {
    /** [DEPRECATED] token-efficient-tools-2026-03-28 was removed in CC v2.1.90.
     *  This flag is retained for config backward compatibility but has no effect. */
    token_efficient_tools: false,
    /** Enable redact-thinking-2026-02-12 beta (suppresses thinking summaries
     *  server-side for lower bandwidth). Off by default so thinking stays
     *  visible. Opt in via `/anthropic set redact-thinking on`. */
    redact_thinking: false,
    /** Enable context-hint-2026-04-09 beta (CC v2.1.110+). When on, the server
     *  MAY reject 422/424 and trigger client-side compaction retries.
     *  Server-side rollout is partial — many accounts 400-reject the beta.
     *  Off by default; the plugin still mimics CC's error-handling semantics
     *  when a user opts in. Even when on, the beta is only sent for requests
     *  classified as "main-thread" (see classifyRequestRole). */
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
     *  assistant turn). Reduces thinking tokens on trivial exchanges. */
    adaptive_thinking_zero_simple: true,
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
     *  whatever signature.cachePolicy.ttl is configured as), else → 5m. */
    role_scoped_cache_ttl: false,
    /** Lean system prompt for non-main requests. For title-gen / small /
     *  subagent-shaped requests, strip billing identity + CC identity
     *  injection. Saves ~1-2kB per request. Opt-in: changes the system-prompt
     *  shape that downstream observers (billing/telemetry) may rely on, so
     *  enable deliberately rather than by default. */
    lean_system_non_main: false
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
    system_prompt_tail_max_chars: 2e3,
    /** Tool deferral (send sparse schemas until first use). Default OFF. */
    tool_deferral: false,
    /** Tool description compaction (strip example output). Default OFF. */
    tool_description_compaction: false,
    /** Adaptive tool set (main vs subagent roles). Default OFF. */
    adaptive_tool_set: false
  },
  /** Output cap: default max_tokens to save context window. */
  output_cap: {
    enabled: true,
    default_max_tokens: 8e3,
    escalated_max_tokens: 64e3
  },
  /** API preconnect: fire-and-forget HEAD to pre-warm TCP+TLS. */
  preconnect: {
    enabled: true,
    timeout_ms: 1e4
  },
  /** Context overflow auto-recovery: parse error, reduce max_tokens, retry once. */
  overflow_recovery: {
    enabled: true,
    safety_margin: 1e3
  },
  /** Cache break detection: alert when cache_read_input_tokens drops significantly. */
  cache_break_detection: {
    enabled: true,
    alert_threshold: 2e3
  },
  /** Request classification: reduced retry budget for background requests. */
  request_classification: {
    enabled: true,
    background_max_service_retries: 0,
    background_max_should_retries: 1
  },
  /** Token budget: parse NL budget expressions, track output, enforce limits. */
  token_budget: {
    enabled: false,
    default: 0,
    completion_threshold: 0.9
  },
  /** Microcompact: inject clear_tool_uses/clear_thinking betas at high context utilization. */
  microcompact: {
    enabled: true,
    threshold_percent: 80
  },
  /** Overload recovery: quota-aware account switching on 529 exhaustion. */
  overload_recovery: {
    enabled: true,
    /** Cooldown (ms) applied to overloaded accounts when no quota data available. */
    default_cooldown_ms: 6e4,
    /** Whether to poll /api/oauth/usage on 529 exhaustion for smarter cooldowns. */
    poll_quota_on_overload: true
  },
  /** Account management: control automatic account penalties and switching.
   *  When proactive_disabled is true (default), the plugin will NOT apply
   *  utilization penalties, surpassed-threshold penalties, or predictive
   *  switches based on response headers (200 OK responses). Reactive 429
   *  handling still works. This makes account switching fully manual and
   *  prevents single-account users from being locally locked out by warning
   *  thresholds the server still allows. */
  account_management: {
    proactive_disabled: true
  },
  /** Anti-verbosity: inject conciseness instructions into system prompt for Opus 4.6.
   *  Mirrors CC v2.1.100 anti_verbosity + numeric_length_anchors sections (gated on
   *  quiet_salted_ember A/B test in CC; unconditional here since we always want savings).
   *  Only activates when model is opus-4-6. */
  anti_verbosity: {
    /** Master switch: inject anti-verbosity communication style instructions. */
    enabled: true,
    /** Also inject numeric length anchors (≤25 words between tool calls, ≤100 words final). */
    length_anchors: true
  }
};
var VALID_STRATEGIES = ["sticky", "round-robin", "hybrid"];
var CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
function createDefaultConfig() {
  return {
    ...DEFAULT_CONFIG,
    signature_emulation: { ...DEFAULT_CONFIG.signature_emulation },
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
    account_management: { ...DEFAULT_CONFIG.account_management }
  };
}
function getConfigDir() {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}
function getConfigPath() {
  return join(getConfigDir(), "anthropic-auth.json");
}
function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
function validateConfig(raw) {
  const config = createDefaultConfig();
  if (typeof raw.account_selection_strategy === "string" && VALID_STRATEGIES.includes(raw.account_selection_strategy)) {
    config.account_selection_strategy = /** @type {AccountSelectionStrategy} */
    raw.account_selection_strategy;
  }
  config.failure_ttl_seconds = clampNumber(raw.failure_ttl_seconds, 60, 7200, DEFAULT_CONFIG.failure_ttl_seconds);
  if (typeof raw.debug === "boolean") {
    config.debug = raw.debug;
  }
  if (raw.signature_emulation && typeof raw.signature_emulation === "object") {
    const se = (
      /** @type {Record<string, unknown>} */
      raw.signature_emulation
    );
    config.signature_emulation = {
      enabled: typeof se.enabled === "boolean" ? se.enabled : DEFAULT_CONFIG.signature_emulation.enabled,
      fetch_claude_code_version_on_startup: typeof se.fetch_claude_code_version_on_startup === "boolean" ? se.fetch_claude_code_version_on_startup : DEFAULT_CONFIG.signature_emulation.fetch_claude_code_version_on_startup,
      prompt_compaction: se.prompt_compaction === "off" || se.prompt_compaction === "minimal" ? se.prompt_compaction : DEFAULT_CONFIG.signature_emulation.prompt_compaction
    };
  }
  if (raw.override_model_limits && typeof raw.override_model_limits === "object") {
    const oml = (
      /** @type {Record<string, unknown>} */
      raw.override_model_limits
    );
    config.override_model_limits = {
      enabled: typeof oml.enabled === "boolean" ? oml.enabled : DEFAULT_CONFIG.override_model_limits.enabled,
      context: clampNumber(oml.context, 2e5, 2e6, DEFAULT_CONFIG.override_model_limits.context),
      output: clampNumber(oml.output, 0, 128e3, DEFAULT_CONFIG.override_model_limits.output)
    };
  }
  if (Array.isArray(raw.custom_betas)) {
    config.custom_betas = raw.custom_betas.filter((b) => typeof b === "string" && b.trim()).map((b) => b.trim());
  }
  if (raw.health_score && typeof raw.health_score === "object") {
    const hs = (
      /** @type {Record<string, unknown>} */
      raw.health_score
    );
    config.health_score = {
      initial: clampNumber(hs.initial, 0, 100, DEFAULT_CONFIG.health_score.initial),
      success_reward: clampNumber(hs.success_reward, 0, 10, DEFAULT_CONFIG.health_score.success_reward),
      rate_limit_penalty: clampNumber(hs.rate_limit_penalty, -50, 0, DEFAULT_CONFIG.health_score.rate_limit_penalty),
      failure_penalty: clampNumber(hs.failure_penalty, -100, 0, DEFAULT_CONFIG.health_score.failure_penalty),
      recovery_rate_per_hour: clampNumber(
        hs.recovery_rate_per_hour,
        0,
        20,
        DEFAULT_CONFIG.health_score.recovery_rate_per_hour
      ),
      min_usable: clampNumber(hs.min_usable, 0, 100, DEFAULT_CONFIG.health_score.min_usable),
      max_score: clampNumber(hs.max_score, 50, 100, DEFAULT_CONFIG.health_score.max_score)
    };
  }
  if (raw.toasts && typeof raw.toasts === "object") {
    const t = (
      /** @type {Record<string, unknown>} */
      raw.toasts
    );
    config.toasts = {
      quiet: typeof t.quiet === "boolean" ? t.quiet : DEFAULT_CONFIG.toasts.quiet,
      debounce_seconds: clampNumber(t.debounce_seconds, 0, 300, DEFAULT_CONFIG.toasts.debounce_seconds)
    };
  }
  if (raw.token_bucket && typeof raw.token_bucket === "object") {
    const tb = (
      /** @type {Record<string, unknown>} */
      raw.token_bucket
    );
    config.token_bucket = {
      max_tokens: clampNumber(tb.max_tokens, 1, 1e3, DEFAULT_CONFIG.token_bucket.max_tokens),
      regeneration_rate_per_minute: clampNumber(
        tb.regeneration_rate_per_minute,
        0.1,
        60,
        DEFAULT_CONFIG.token_bucket.regeneration_rate_per_minute
      ),
      initial_tokens: clampNumber(tb.initial_tokens, 1, 1e3, DEFAULT_CONFIG.token_bucket.initial_tokens)
    };
  }
  if (raw.headers && typeof raw.headers === "object") {
    const h = (
      /** @type {Record<string, unknown>} */
      raw.headers
    );
    if (typeof h.emulation_profile === "string" && h.emulation_profile.trim()) {
      config.headers.emulation_profile = h.emulation_profile.trim();
    }
    if (h.overrides && typeof h.overrides === "object" && !Array.isArray(h.overrides)) {
      const overrides = {};
      for (const [key, value] of Object.entries(
        /** @type {Record<string, unknown>} */
        h.overrides
      )) {
        if (!key) continue;
        if (typeof value === "string") {
          overrides[key] = value;
        }
      }
      config.headers.overrides = overrides;
    }
    if (Array.isArray(h.disable)) {
      config.headers.disable = h.disable.filter((v) => typeof v === "string").map((v) => v.trim().toLowerCase()).filter(Boolean);
    }
    if (typeof h.billing_header === "boolean") {
      config.headers.billing_header = h.billing_header;
    }
  }
  if (raw.idle_refresh && typeof raw.idle_refresh === "object") {
    const ir = (
      /** @type {Record<string, unknown>} */
      raw.idle_refresh
    );
    config.idle_refresh = {
      enabled: typeof ir.enabled === "boolean" ? ir.enabled : DEFAULT_CONFIG.idle_refresh.enabled,
      window_minutes: clampNumber(ir.window_minutes, 1, 24 * 60, DEFAULT_CONFIG.idle_refresh.window_minutes),
      min_interval_minutes: clampNumber(
        ir.min_interval_minutes,
        1,
        24 * 60,
        DEFAULT_CONFIG.idle_refresh.min_interval_minutes
      )
    };
  }
  if (raw.cache_policy && typeof raw.cache_policy === "object") {
    const cp = (
      /** @type {Record<string, unknown>} */
      raw.cache_policy
    );
    const validTtls = ["1h", "5m", "off"];
    config.cache_policy = {
      ttl: typeof cp.ttl === "string" && validTtls.includes(cp.ttl) ? cp.ttl : DEFAULT_CONFIG.cache_policy.ttl,
      ttl_supported: typeof cp.ttl_supported === "boolean" ? cp.ttl_supported : DEFAULT_CONFIG.cache_policy.ttl_supported,
      boundary_marker: typeof cp.boundary_marker === "boolean" ? cp.boundary_marker : DEFAULT_CONFIG.cache_policy.boundary_marker,
      hit_rate_warning_threshold: typeof cp.hit_rate_warning_threshold === "number" && Number.isFinite(cp.hit_rate_warning_threshold) ? Math.max(0, Math.min(1, cp.hit_rate_warning_threshold)) : DEFAULT_CONFIG.cache_policy.hit_rate_warning_threshold
    };
  }
  config.fast_mode = typeof raw.fast_mode === "boolean" ? raw.fast_mode : false;
  config.telemetry = config.telemetry || {};
  config.telemetry.emulate_minimal = typeof raw.telemetry?.emulate_minimal === "boolean" ? raw.telemetry.emulate_minimal : DEFAULT_CONFIG.telemetry.emulate_minimal;
  config.usage_toast = typeof raw.usage_toast === "boolean" ? raw.usage_toast : DEFAULT_CONFIG.usage_toast;
  if (raw.cc_credential_reuse && typeof raw.cc_credential_reuse === "object") {
    const cc = (
      /** @type {Record<string, unknown>} */
      raw.cc_credential_reuse
    );
    config.cc_credential_reuse = {
      enabled: typeof cc.enabled === "boolean" ? cc.enabled : DEFAULT_CONFIG.cc_credential_reuse.enabled,
      auto_detect: typeof cc.auto_detect === "boolean" ? cc.auto_detect : DEFAULT_CONFIG.cc_credential_reuse.auto_detect,
      prefer_over_oauth: typeof cc.prefer_over_oauth === "boolean" ? cc.prefer_over_oauth : DEFAULT_CONFIG.cc_credential_reuse.prefer_over_oauth
    };
  }
  if (raw.adaptive_context && typeof raw.adaptive_context === "object") {
    const ac = (
      /** @type {Record<string, unknown>} */
      raw.adaptive_context
    );
    config.adaptive_context = {
      enabled: typeof ac.enabled === "boolean" ? ac.enabled : DEFAULT_CONFIG.adaptive_context.enabled,
      escalation_threshold: clampNumber(
        ac.escalation_threshold,
        5e4,
        5e5,
        DEFAULT_CONFIG.adaptive_context.escalation_threshold
      ),
      deescalation_threshold: clampNumber(
        ac.deescalation_threshold,
        2e4,
        4e5,
        DEFAULT_CONFIG.adaptive_context.deescalation_threshold
      )
    };
    if (config.adaptive_context.deescalation_threshold >= config.adaptive_context.escalation_threshold) {
      config.adaptive_context.deescalation_threshold = Math.max(
        2e4,
        config.adaptive_context.escalation_threshold - 5e4
      );
    }
  }
  if (raw.willow_mode && typeof raw.willow_mode === "object") {
    const wm = (
      /** @type {Record<string, unknown>} */
      raw.willow_mode
    );
    config.willow_mode = {
      enabled: typeof wm.enabled === "boolean" ? wm.enabled : DEFAULT_CONFIG.willow_mode.enabled,
      idle_threshold_minutes: clampNumber(
        wm.idle_threshold_minutes,
        1,
        24 * 60,
        DEFAULT_CONFIG.willow_mode.idle_threshold_minutes
      ),
      cooldown_minutes: clampNumber(wm.cooldown_minutes, 1, 24 * 60, DEFAULT_CONFIG.willow_mode.cooldown_minutes),
      min_turns_before_suggest: clampNumber(
        wm.min_turns_before_suggest,
        0,
        50,
        DEFAULT_CONFIG.willow_mode.min_turns_before_suggest
      )
    };
  }
  if (raw.token_economy && typeof raw.token_economy === "object") {
    const te = (
      /** @type {Record<string, unknown>} */
      raw.token_economy
    );
    config.token_economy = {
      token_efficient_tools: typeof te.token_efficient_tools === "boolean" ? te.token_efficient_tools : DEFAULT_CONFIG.token_economy.token_efficient_tools,
      redact_thinking: typeof te.redact_thinking === "boolean" ? te.redact_thinking : DEFAULT_CONFIG.token_economy.redact_thinking,
      context_hint: typeof te.context_hint === "boolean" ? te.context_hint : DEFAULT_CONFIG.token_economy.context_hint,
      conservative: typeof te.conservative === "boolean" ? te.conservative : DEFAULT_CONFIG.token_economy.conservative,
      debug_dump_bodies: typeof te.debug_dump_bodies === "boolean" ? te.debug_dump_bodies : DEFAULT_CONFIG.token_economy.debug_dump_bodies,
      ttl_thinking_strip: typeof te.ttl_thinking_strip === "boolean" ? te.ttl_thinking_strip : DEFAULT_CONFIG.token_economy.ttl_thinking_strip,
      proactive_microcompact: typeof te.proactive_microcompact === "boolean" ? te.proactive_microcompact : DEFAULT_CONFIG.token_economy.proactive_microcompact,
      microcompact_percent: clampNumber(
        te.microcompact_percent,
        30,
        95,
        DEFAULT_CONFIG.token_economy.microcompact_percent
      ),
      microcompact_keep_recent: clampNumber(
        te.microcompact_keep_recent,
        1,
        64,
        DEFAULT_CONFIG.token_economy.microcompact_keep_recent
      ),
      stable_tool_ordering: typeof te.stable_tool_ordering === "boolean" ? te.stable_tool_ordering : DEFAULT_CONFIG.token_economy.stable_tool_ordering,
      deferred_tool_names: Array.isArray(te.deferred_tool_names) ? te.deferred_tool_names.filter((n) => typeof n === "string") : DEFAULT_CONFIG.token_economy.deferred_tool_names,
      adaptive_thinking_zero_simple: typeof te.adaptive_thinking_zero_simple === "boolean" ? te.adaptive_thinking_zero_simple : DEFAULT_CONFIG.token_economy.adaptive_thinking_zero_simple,
      tool_result_dedupe: typeof te.tool_result_dedupe === "boolean" ? te.tool_result_dedupe : DEFAULT_CONFIG.token_economy.tool_result_dedupe,
      fast_mode_auto: typeof te.fast_mode_auto === "boolean" ? te.fast_mode_auto : DEFAULT_CONFIG.token_economy.fast_mode_auto,
      trailing_summary_trim: typeof te.trailing_summary_trim === "boolean" ? te.trailing_summary_trim : DEFAULT_CONFIG.token_economy.trailing_summary_trim,
      role_scoped_cache_ttl: typeof te.role_scoped_cache_ttl === "boolean" ? te.role_scoped_cache_ttl : DEFAULT_CONFIG.token_economy.role_scoped_cache_ttl,
      lean_system_non_main: typeof te.lean_system_non_main === "boolean" ? te.lean_system_non_main : DEFAULT_CONFIG.token_economy.lean_system_non_main
    };
  }
  if (raw.token_economy_strategies && typeof raw.token_economy_strategies === "object") {
    const tes = (
      /** @type {Record<string, unknown>} */
      raw.token_economy_strategies
    );
    config.token_economy_strategies = {
      system_prompt_tailing: typeof tes.system_prompt_tailing === "boolean" ? tes.system_prompt_tailing : DEFAULT_CONFIG.token_economy_strategies.system_prompt_tailing,
      system_prompt_tail_turns: clampNumber(
        tes.system_prompt_tail_turns,
        1,
        1e3,
        DEFAULT_CONFIG.token_economy_strategies.system_prompt_tail_turns
      ),
      system_prompt_tail_max_chars: clampNumber(
        tes.system_prompt_tail_max_chars,
        100,
        5e4,
        DEFAULT_CONFIG.token_economy_strategies.system_prompt_tail_max_chars
      ),
      tool_deferral: typeof tes.tool_deferral === "boolean" ? tes.tool_deferral : DEFAULT_CONFIG.token_economy_strategies.tool_deferral,
      tool_description_compaction: typeof tes.tool_description_compaction === "boolean" ? tes.tool_description_compaction : DEFAULT_CONFIG.token_economy_strategies.tool_description_compaction,
      adaptive_tool_set: typeof tes.adaptive_tool_set === "boolean" ? tes.adaptive_tool_set : DEFAULT_CONFIG.token_economy_strategies.adaptive_tool_set
    };
  }
  if (raw.output_cap && typeof raw.output_cap === "object") {
    const oc = (
      /** @type {Record<string, unknown>} */
      raw.output_cap
    );
    config.output_cap = {
      enabled: typeof oc.enabled === "boolean" ? oc.enabled : DEFAULT_CONFIG.output_cap.enabled,
      default_max_tokens: clampNumber(
        oc.default_max_tokens,
        256,
        2e5,
        DEFAULT_CONFIG.output_cap.default_max_tokens
      ),
      escalated_max_tokens: clampNumber(
        oc.escalated_max_tokens,
        1e3,
        2e5,
        DEFAULT_CONFIG.output_cap.escalated_max_tokens
      )
    };
  }
  if (raw.preconnect && typeof raw.preconnect === "object") {
    const pc = (
      /** @type {Record<string, unknown>} */
      raw.preconnect
    );
    config.preconnect = {
      enabled: typeof pc.enabled === "boolean" ? pc.enabled : DEFAULT_CONFIG.preconnect.enabled,
      timeout_ms: clampNumber(pc.timeout_ms, 100, 6e4, DEFAULT_CONFIG.preconnect.timeout_ms)
    };
  }
  if (raw.overflow_recovery && typeof raw.overflow_recovery === "object") {
    const ovf = (
      /** @type {Record<string, unknown>} */
      raw.overflow_recovery
    );
    config.overflow_recovery = {
      enabled: typeof ovf.enabled === "boolean" ? ovf.enabled : DEFAULT_CONFIG.overflow_recovery.enabled,
      safety_margin: clampNumber(ovf.safety_margin, 0, 1e4, DEFAULT_CONFIG.overflow_recovery.safety_margin)
    };
  }
  if (raw.cache_break_detection && typeof raw.cache_break_detection === "object") {
    const cbd = (
      /** @type {Record<string, unknown>} */
      raw.cache_break_detection
    );
    config.cache_break_detection = {
      enabled: typeof cbd.enabled === "boolean" ? cbd.enabled : DEFAULT_CONFIG.cache_break_detection.enabled,
      alert_threshold: clampNumber(
        cbd.alert_threshold,
        0,
        1e6,
        DEFAULT_CONFIG.cache_break_detection.alert_threshold
      )
    };
  }
  if (raw.request_classification && typeof raw.request_classification === "object") {
    const rc = (
      /** @type {Record<string, unknown>} */
      raw.request_classification
    );
    config.request_classification = {
      enabled: typeof rc.enabled === "boolean" ? rc.enabled : DEFAULT_CONFIG.request_classification.enabled,
      background_max_service_retries: clampNumber(
        rc.background_max_service_retries,
        0,
        10,
        DEFAULT_CONFIG.request_classification.background_max_service_retries
      ),
      background_max_should_retries: clampNumber(
        rc.background_max_should_retries,
        0,
        10,
        DEFAULT_CONFIG.request_classification.background_max_should_retries
      )
    };
  }
  if (raw.token_budget && typeof raw.token_budget === "object") {
    const tbg = (
      /** @type {Record<string, unknown>} */
      raw.token_budget
    );
    config.token_budget = {
      enabled: typeof tbg.enabled === "boolean" ? tbg.enabled : DEFAULT_CONFIG.token_budget.enabled,
      default: clampNumber(tbg.default, 0, 1e6, DEFAULT_CONFIG.token_budget.default),
      completion_threshold: clampNumber(
        tbg.completion_threshold,
        0,
        1,
        DEFAULT_CONFIG.token_budget.completion_threshold
      )
    };
  }
  if (raw.microcompact && typeof raw.microcompact === "object") {
    const mc = (
      /** @type {Record<string, unknown>} */
      raw.microcompact
    );
    config.microcompact = {
      enabled: typeof mc.enabled === "boolean" ? mc.enabled : DEFAULT_CONFIG.microcompact.enabled,
      threshold_percent: clampNumber(mc.threshold_percent, 0, 100, DEFAULT_CONFIG.microcompact.threshold_percent)
    };
  }
  if (raw.overload_recovery && typeof raw.overload_recovery === "object") {
    const ovl = (
      /** @type {Record<string, unknown>} */
      raw.overload_recovery
    );
    config.overload_recovery = {
      enabled: typeof ovl.enabled === "boolean" ? ovl.enabled : DEFAULT_CONFIG.overload_recovery.enabled,
      default_cooldown_ms: clampNumber(
        ovl.default_cooldown_ms,
        1e3,
        36e5,
        DEFAULT_CONFIG.overload_recovery.default_cooldown_ms
      ),
      poll_quota_on_overload: typeof ovl.poll_quota_on_overload === "boolean" ? ovl.poll_quota_on_overload : DEFAULT_CONFIG.overload_recovery.poll_quota_on_overload
    };
  }
  if (raw.account_management && typeof raw.account_management === "object") {
    const am = (
      /** @type {Record<string, unknown>} */
      raw.account_management
    );
    config.account_management = {
      proactive_disabled: typeof am.proactive_disabled === "boolean" ? am.proactive_disabled : DEFAULT_CONFIG.account_management.proactive_disabled
    };
  }
  if (raw.anti_verbosity && typeof raw.anti_verbosity === "object") {
    const av = (
      /** @type {Record<string, unknown>} */
      raw.anti_verbosity
    );
    config.anti_verbosity = {
      enabled: typeof av.enabled === "boolean" ? av.enabled : DEFAULT_CONFIG.anti_verbosity.enabled,
      length_anchors: typeof av.length_anchors === "boolean" ? av.length_anchors : DEFAULT_CONFIG.anti_verbosity.length_anchors
    };
  }
  return config;
}
function applyEnvOverrides(config) {
  const env = process.env;
  if (env.OPENCODE_ANTHROPIC_STRATEGY && VALID_STRATEGIES.includes(env.OPENCODE_ANTHROPIC_STRATEGY)) {
    config.account_selection_strategy = /** @type {AccountSelectionStrategy} */
    env.OPENCODE_ANTHROPIC_STRATEGY;
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
  if (env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "1" || env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "true") {
    config.signature_emulation.enabled = true;
  }
  if (env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "0" || env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "false") {
    config.signature_emulation.enabled = false;
  }
  if (env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "1" || env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "true") {
    config.signature_emulation.fetch_claude_code_version_on_startup = true;
  }
  if (env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "0" || env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "false") {
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
  if (env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "0" || env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "false") {
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
  if (env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "1" || env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "true") {
    config.account_management.proactive_disabled = true;
  }
  if (env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "0" || env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED === "false") {
    config.account_management.proactive_disabled = false;
  }
  if (env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "1" || env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "true") {
    config.anti_verbosity.enabled = true;
  }
  if (env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "0" || env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY === "false") {
    config.anti_verbosity.enabled = false;
  }
  if (env.OPENCODE_ANTHROPIC_LENGTH_ANCHORS === "0" || env.OPENCODE_ANTHROPIC_LENGTH_ANCHORS === "false") {
    config.anti_verbosity.length_anchors = false;
  }
  return config;
}
function loadConfig() {
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
function loadRawConfig() {
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
function deepMergeConfig(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof result[key] === "object" && result[key] && !Array.isArray(result[key])) {
      result[key] = {
        .../** @type {Record<string, unknown>} */
        result[key],
        .../** @type {Record<string, unknown>} */
        value
      };
    } else {
      result[key] = value;
    }
  }
  return result;
}
function saveConfig(updates) {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  const existing = loadRawConfig();
  const merged = deepMergeConfig(existing, updates);
  const tmpPath = configPath + `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf-8", mode: 384 });
  renameSync(tmpPath, configPath);
}

// lib/storage.mjs
var CURRENT_VERSION = 1;
function createDefaultStats(now) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastReset: now ?? Date.now()
  };
}
function validateStats(raw, now) {
  if (!raw || typeof raw !== "object") return createDefaultStats(now);
  const s = (
    /** @type {Record<string, unknown>} */
    raw
  );
  const safeNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  return {
    requests: safeNum(s.requests),
    inputTokens: safeNum(s.inputTokens),
    outputTokens: safeNum(s.outputTokens),
    cacheReadTokens: safeNum(s.cacheReadTokens),
    cacheWriteTokens: safeNum(s.cacheWriteTokens),
    lastReset: typeof s.lastReset === "number" && Number.isFinite(s.lastReset) ? s.lastReset : now
  };
}
var GITIGNORE_ENTRIES = [".gitignore", "anthropic-accounts.json", "anthropic-accounts.json.*.tmp"];
function getStoragePath() {
  return join2(getConfigDir(), "anthropic-accounts.json");
}
function ensureGitignore(configDir) {
  const gitignorePath = join2(configDir, ".gitignore");
  try {
    let content = "";
    let existingLines = [];
    if (existsSync2(gitignorePath)) {
      content = readFileSync2(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    }
    const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));
    if (missingEntries.length === 0) return;
    if (content === "") {
      writeFileSync2(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, suffix + missingEntries.join("\n") + "\n", "utf-8");
    }
  } catch {
  }
}
function deduplicateByRefreshToken(accounts) {
  const tokenMap = /* @__PURE__ */ new Map();
  for (const acc of accounts) {
    if (!acc.refreshToken) continue;
    const existing = tokenMap.get(acc.refreshToken);
    if (!existing || (acc.lastUsed || 0) > (existing.lastUsed || 0)) {
      tokenMap.set(acc.refreshToken, acc);
    }
  }
  return Array.from(tokenMap.values());
}
function validateAccount(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const acc = (
    /** @type {Record<string, unknown>} */
    raw
  );
  if (typeof acc.refreshToken !== "string" || !acc.refreshToken) return null;
  const addedAt = typeof acc.addedAt === "number" && Number.isFinite(acc.addedAt) ? acc.addedAt : now;
  const id = typeof acc.id === "string" && acc.id ? acc.id : `${addedAt}:${createHash("sha256").update(acc.refreshToken).digest("hex").slice(0, 12)}`;
  return {
    id,
    email: typeof acc.email === "string" ? acc.email : void 0,
    accountUuid: typeof acc.accountUuid === "string" ? acc.accountUuid : void 0,
    organizationUuid: typeof acc.organizationUuid === "string" ? acc.organizationUuid : void 0,
    refreshToken: acc.refreshToken,
    access: typeof acc.access === "string" ? acc.access : void 0,
    expires: typeof acc.expires === "number" && Number.isFinite(acc.expires) ? acc.expires : void 0,
    token_updated_at: typeof acc.token_updated_at === "number" && Number.isFinite(acc.token_updated_at) ? acc.token_updated_at : typeof acc.tokenUpdatedAt === "number" && Number.isFinite(acc.tokenUpdatedAt) ? acc.tokenUpdatedAt : addedAt,
    addedAt,
    lastUsed: typeof acc.lastUsed === "number" && Number.isFinite(acc.lastUsed) ? acc.lastUsed : 0,
    enabled: acc.enabled !== false,
    rateLimitResetTimes: acc.rateLimitResetTimes && typeof acc.rateLimitResetTimes === "object" && !Array.isArray(acc.rateLimitResetTimes) ? (
      /** @type {Record<string, number>} */
      acc.rateLimitResetTimes
    ) : {},
    consecutiveFailures: typeof acc.consecutiveFailures === "number" ? Math.max(0, Math.floor(acc.consecutiveFailures)) : 0,
    lastFailureTime: typeof acc.lastFailureTime === "number" ? acc.lastFailureTime : null,
    lastSwitchReason: typeof acc.lastSwitchReason === "string" ? acc.lastSwitchReason : void 0,
    source: typeof acc.source === "string" && ["oauth", "cc-keychain", "cc-file"].includes(acc.source) ? acc.source : void 0,
    stats: validateStats(acc.stats, now)
  };
}
async function loadAccounts() {
  const storagePath = getStoragePath();
  try {
    const content = await fs.readFile(storagePath, "utf-8");
    const data = JSON.parse(content);
    if (!data || typeof data !== "object" || !Array.isArray(data.accounts)) {
      return null;
    }
    if (data.version !== CURRENT_VERSION) {
      if (typeof data.version === "number" && data.version > CURRENT_VERSION) {
        console.warn(
          `[anthropic-auth] accounts file version ${data.version} is newer than expected ${CURRENT_VERSION}; loading with best effort`
        );
      } else {
        console.warn(
          `[anthropic-auth] accounts file version mismatch (${data.version} vs ${CURRENT_VERSION}); attempting load`
        );
      }
    }
    const now = Date.now();
    const accounts = data.accounts.map((raw) => validateAccount(raw, now)).filter(
      /** @returns {acc is AccountMetadata} */
      (acc) => acc !== null
    );
    const deduped = deduplicateByRefreshToken(accounts);
    let activeIndex = typeof data.activeIndex === "number" && Number.isFinite(data.activeIndex) ? data.activeIndex : 0;
    if (deduped.length > 0) {
      activeIndex = Math.max(0, Math.min(activeIndex, deduped.length - 1));
    } else {
      activeIndex = 0;
    }
    return {
      version: CURRENT_VERSION,
      accounts: deduped,
      activeIndex
    };
  } catch (error) {
    const code = (
      /** @type {NodeJS.ErrnoException} */
      error.code
    );
    if (code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}
async function saveAccounts(storage, storageOrDiskData = void 0) {
  const storagePath = getStoragePath();
  const configDir = dirname2(storagePath);
  await fs.mkdir(configDir, { recursive: true });
  ensureGitignore(configDir);
  let storageToWrite = storage;
  try {
    const disk = storageOrDiskData ?? await loadAccounts();
    if (disk && storage.accounts.length > 0) {
      const diskById = new Map(disk.accounts.map((a) => [a.id, a]));
      const diskByAddedAt = /* @__PURE__ */ new Map();
      const diskByToken = new Map(disk.accounts.map((a) => [a.refreshToken, a]));
      for (const d of disk.accounts) {
        const bucket = diskByAddedAt.get(d.addedAt) || [];
        bucket.push(d);
        diskByAddedAt.set(d.addedAt, bucket);
      }
      const findDiskMatch = (acc) => {
        const byId = diskById.get(acc.id);
        if (byId) return byId;
        const byAddedAt = diskByAddedAt.get(acc.addedAt);
        if (byAddedAt?.length === 1) return byAddedAt[0];
        const byToken = diskByToken.get(acc.refreshToken);
        if (byToken) return byToken;
        if (byAddedAt && byAddedAt.length > 0) return byAddedAt[0];
        return null;
      };
      const mergedAccounts = storage.accounts.map((acc) => {
        const diskAcc = findDiskMatch(acc);
        const memTs = typeof acc.token_updated_at === "number" && Number.isFinite(acc.token_updated_at) ? acc.token_updated_at : acc.addedAt;
        const diskTs = diskAcc?.token_updated_at || 0;
        const useDiskAuth = !!diskAcc && diskTs > memTs;
        return {
          ...acc,
          refreshToken: useDiskAuth ? diskAcc.refreshToken : acc.refreshToken,
          access: useDiskAuth ? diskAcc.access : acc.access,
          expires: useDiskAuth ? diskAcc.expires : acc.expires,
          token_updated_at: useDiskAuth ? diskTs : memTs
        };
      });
      let activeIndex = storage.activeIndex;
      if (mergedAccounts.length > 0) {
        activeIndex = Math.max(0, Math.min(activeIndex, mergedAccounts.length - 1));
      } else {
        activeIndex = 0;
      }
      storageToWrite = {
        ...storage,
        accounts: mergedAccounts,
        activeIndex
      };
    }
  } catch {
  }
  const tempPath = `${storagePath}.${randomBytes2(6).toString("hex")}.tmp`;
  const content = JSON.stringify(storageToWrite, null, 2);
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 384 });
    await fs.rename(tempPath, storagePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
    }
    throw error;
  }
}

// lib/oauth.mjs
import { createHash as createHash2, randomBytes as randomBytes3 } from "node:crypto";

// lib/backoff.mjs
function parseRetryAfterMsHeader(response) {
  const header = response.headers.get("retry-after-ms");
  if (!header) return null;
  const ms = parseFloat(header);
  return !isNaN(ms) && ms > 0 ? ms : null;
}
function parseRetryAfterHeader(response) {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1e3;
  }
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : null;
  }
  return null;
}

// lib/oauth.mjs
var OAUTH_CONSOLE_HOST = "platform.claude.com";
var OAUTH_MAX_HOST = "claude.ai";
var OAUTH_REDIRECT_URI = `https://${OAUTH_CONSOLE_HOST}/oauth/code/callback`;
var OAUTH_TOKEN_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/token`;
var OAUTH_REVOKE_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/revoke`;
var OAUTH_AXIOS_VERSION = "1.13.6";
var OAUTH_USER_AGENT = `axios/${OAUTH_AXIOS_VERSION}`;
var OAUTH_ACCEPT = "application/json, text/plain, */*";
var OAUTH_MAX_RETRIES = 2;
var OAUTH_MAX_RETRY_DELAY_MS = 3e4;
var OAUTH_RATE_LIMIT_COOLDOWN_MS = 3e4;
var OAUTH_RETRY_AFTER_SOURCE_HEADER_MS = "retry-after-ms";
var OAUTH_RETRY_AFTER_SOURCE_HEADER = "retry-after";
var OAUTH_RETRY_AFTER_SOURCE_FALLBACK_429 = "fallback-429";
var CLAUDE_AI_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload"
];
var CONSOLE_SCOPES = ["org:create_api_key", "user:profile"];
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}
function generatePKCE() {
  const verifier = base64url(randomBytes3(32));
  const challenge = base64url(createHash2("sha256").update(verifier).digest());
  const state = base64url(randomBytes3(32));
  return { verifier, challenge, state };
}
function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRetryableTokenStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
function getRetryDelayMs(resp, attempt) {
  if (!resp || !resp.headers || typeof resp.headers.get !== "function") {
    return Math.min(1e3 * 2 ** attempt, 8e3);
  }
  const headerMs = parseRetryAfterMsHeader(resp);
  const retryAfterMs = parseRetryAfterHeader(resp);
  const fallback = Math.min(1e3 * 2 ** attempt, 8e3);
  const resolved = headerMs ?? retryAfterMs ?? fallback;
  return Math.max(250, Math.min(resolved, OAUTH_MAX_RETRY_DELAY_MS));
}
function getCooldownHint(resp, status) {
  if (resp && resp.headers && typeof resp.headers.get === "function") {
    const headerMs = parseRetryAfterMsHeader(resp);
    if (Number.isFinite(headerMs) && headerMs > 0) {
      return {
        retryAfterMs: Math.max(250, Math.min(headerMs, OAUTH_MAX_RETRY_DELAY_MS)),
        retryAfterSource: OAUTH_RETRY_AFTER_SOURCE_HEADER_MS
      };
    }
    const retryAfterMs = parseRetryAfterHeader(resp);
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return {
        retryAfterMs: Math.max(250, Math.min(retryAfterMs, OAUTH_MAX_RETRY_DELAY_MS)),
        retryAfterSource: OAUTH_RETRY_AFTER_SOURCE_HEADER
      };
    }
  }
  if (status === 429) {
    return {
      retryAfterMs: OAUTH_RATE_LIMIT_COOLDOWN_MS,
      retryAfterSource: OAUTH_RETRY_AFTER_SOURCE_FALLBACK_429
    };
  }
  return { retryAfterMs: null };
}
function parseOAuthErrorBody(rawText) {
  if (!rawText) return {};
  try {
    const parsed = JSON.parse(rawText);
    let errorCode;
    let reason;
    if (typeof parsed.error === "string" && parsed.error) {
      errorCode = parsed.error;
    } else if (parsed.error && typeof parsed.error === "object") {
      if (typeof parsed.error.type === "string" && parsed.error.type) {
        errorCode = parsed.error.type;
      }
      if (typeof parsed.error.message === "string" && parsed.error.message) {
        reason = parsed.error.message;
      }
    }
    if (!reason) {
      if (typeof parsed.error_description === "string" && parsed.error_description) {
        reason = parsed.error_description;
      } else if (typeof parsed.message === "string" && parsed.message) {
        reason = parsed.message;
      }
    }
    return {
      ...errorCode ? { errorCode } : {},
      ...reason ? { reason } : {}
    };
  } catch {
    const trimmed = rawText.trim();
    return trimmed ? { reason: trimmed } : {};
  }
}
async function authorize(mode) {
  const pkce = generatePKCE();
  const url = new URL(`https://${mode === "console" ? OAUTH_CONSOLE_HOST : OAUTH_MAX_HOST}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  const scopes = mode === "console" ? CONSOLE_SCOPES : CLAUDE_AI_SCOPES;
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.state);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state: pkce.state
  };
}
async function exchange(code, verifier) {
  const fail = (status, rawText = "", cooldownHint = { retryAfterMs: null }) => {
    const { errorCode, reason } = parseOAuthErrorBody(rawText);
    const retryAfterMs = Number.isFinite(cooldownHint?.retryAfterMs) && cooldownHint.retryAfterMs > 0 ? Number(cooldownHint.retryAfterMs) : null;
    const detailsParts = [];
    if (typeof status === "number") detailsParts.push(`HTTP ${status}`);
    if (errorCode) detailsParts.push(errorCode);
    if (reason) detailsParts.push(reason);
    return {
      type: "failed",
      ...typeof status === "number" ? { status } : {},
      ...errorCode ? { code: errorCode } : {},
      ...reason ? { reason } : {},
      ...detailsParts.length ? { details: detailsParts.join(" \xB7 ") } : {},
      ...retryAfterMs ? { retryAfterMs } : {},
      ...cooldownHint?.retryAfterSource ? { retryAfterSource: cooldownHint.retryAfterSource } : {}
    };
  };
  const splits = code.split("#");
  let result;
  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    try {
      result = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: OAUTH_ACCEPT,
          "Content-Type": "application/json",
          "User-Agent": OAUTH_USER_AGENT
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: splits[0],
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
          state: splits[1]
        }),
        signal: AbortSignal.timeout(15e3)
      });
    } catch (err) {
      if (attempt < OAUTH_MAX_RETRIES) {
        await sleep(Math.min(500 * 2 ** attempt, 2e3));
        continue;
      }
      return fail(void 0, err instanceof Error ? err.message : String(err));
    }
    if (!result.ok) {
      const raw = typeof result.text === "function" ? await result.text().then((value) => typeof value === "string" ? value : "").catch(() => "") : "";
      if (attempt < OAUTH_MAX_RETRIES && isRetryableTokenStatus(result.status)) {
        await sleep(getRetryDelayMs(result, attempt));
        continue;
      }
      return fail(result.status, raw, getCooldownHint(result, result.status));
    }
    break;
  }
  if (!result) {
    return fail(void 0, "Token exchange request did not complete");
  }
  let json;
  try {
    json = await result.json();
  } catch {
    return fail(result.status, "Invalid JSON in token response");
  }
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    return fail(result.status, "Missing required fields in token response");
  }
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1e3,
    email: json.account?.email_address || void 0,
    // Real CC extracts account UUID from token response (oauth/client.ts:253)
    // and uses it in metadata.user_id.account_uuid for billing correlation.
    accountUuid: json.account?.uuid || void 0,
    organizationUuid: json.organization?.uuid || void 0
  };
}
async function revoke(refreshToken) {
  try {
    const resp = await fetch(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: {
        Accept: OAUTH_ACCEPT,
        "Content-Type": "application/json",
        "User-Agent": OAUTH_USER_AGENT
      },
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID
      }),
      signal: AbortSignal.timeout(5e3)
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// cli.mjs
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { exec } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
var USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
var ansi = (code, text) => USE_COLOR ? `\x1B[${code}m${text}\x1B[0m` : text;
var c = {
  bold: (t) => ansi("1", t),
  dim: (t) => ansi("2", t),
  green: (t) => ansi("32", t),
  yellow: (t) => ansi("33", t),
  cyan: (t) => ansi("36", t),
  red: (t) => ansi("31", t),
  gray: (t) => ansi("90", t)
};
function formatDuration(ms) {
  if (ms <= 0) return "now";
  const seconds = Math.floor(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m ${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}
function formatTimeAgo(timestamp) {
  if (!timestamp || timestamp === 0) return "never";
  const ms = Date.now() - timestamp;
  if (ms < 0) return "just now";
  return `${formatDuration(ms)} ago`;
}
function shortPath(p) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
function pad(str, width) {
  const diff = width - stripAnsi(str).length;
  return diff > 0 ? str + " ".repeat(diff) : str;
}
function rpad(str, width) {
  const diff = width - stripAnsi(str).length;
  return diff > 0 ? " ".repeat(diff) + str : str;
}
async function refreshAccessToken(account) {
  try {
    const resp = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: CLIENT_ID
      }),
      signal: AbortSignal.timeout(5e3)
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    account.access = json.access_token;
    account.expires = Date.now() + json.expires_in * 1e3;
    if (json.refresh_token) account.refreshToken = json.refresh_token;
    account.token_updated_at = Date.now();
    return json.access_token;
  } catch {
    return null;
  }
}
async function fetchUsage(accessToken) {
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json"
      },
      signal: AbortSignal.timeout(5e3)
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}
async function ensureTokenAndFetchUsage(account) {
  if (!account.enabled) return { usage: null, tokenRefreshed: false };
  let token = account.access;
  let tokenRefreshed = false;
  if (!token || !account.expires || account.expires < Date.now()) {
    token = await refreshAccessToken(account);
    tokenRefreshed = !!token;
    if (!token) return { usage: null, tokenRefreshed: false };
  }
  const usage = await fetchUsage(token);
  return { usage, tokenRefreshed };
}
function renderBar(utilization, width = 10) {
  const pct = Math.max(0, Math.min(100, utilization));
  const filled = Math.round(pct / 100 * width);
  const empty = width - filled;
  let bar;
  if (pct >= 90) {
    bar = c.red("\u2588".repeat(filled)) + c.dim("\u2591".repeat(empty));
  } else if (pct >= 70) {
    bar = c.yellow("\u2588".repeat(filled)) + c.dim("\u2591".repeat(empty));
  } else {
    bar = c.green("\u2588".repeat(filled)) + c.dim("\u2591".repeat(empty));
  }
  return bar;
}
function formatResetTime(isoString) {
  const resetMs = new Date(isoString).getTime();
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return "now";
  return formatDuration(remaining);
}
var QUOTA_BUCKETS = [
  { key: "five_hour", label: "5h" },
  { key: "seven_day", label: "7d" },
  { key: "seven_day_sonnet", label: "Sonnet 7d" },
  { key: "seven_day_opus", label: "Opus 7d" },
  { key: "seven_day_oauth_apps", label: "OAuth Apps 7d" },
  { key: "seven_day_cowork", label: "Cowork 7d" }
];
var USAGE_INDENT = "       ";
var USAGE_LABEL_WIDTH = 13;
function renderUsageLines(usage) {
  const lines = [];
  for (const { key, label } of QUOTA_BUCKETS) {
    const bucket = usage[key];
    if (!bucket || bucket.utilization == null) continue;
    const pct = bucket.utilization;
    const bar = renderBar(pct);
    const pctStr = pad(String(Math.round(pct)) + "%", 4);
    const reset = bucket.resets_at ? c.dim(`resets in ${formatResetTime(bucket.resets_at)}`) : "";
    lines.push(`${USAGE_INDENT}${pad(label, USAGE_LABEL_WIDTH)} ${bar} ${pctStr}${reset ? ` ${reset}` : ""}`);
  }
  return lines;
}
function openBrowser(url) {
  if (process.platform === "win32") {
    exec(`cmd /c start "" ${JSON.stringify(url)}`);
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`);
}
async function runOAuthFlow() {
  const { url, verifier } = await authorize("max");
  console.log("");
  console.log(c.bold("Opening browser for Anthropic OAuth login..."));
  console.log("");
  console.log(c.dim("If your browser didn't open, visit this URL:"));
  console.log(c.cyan(url));
  console.log("");
  openBrowser(url);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const code = await rl.question("Paste the authorization code here: ");
    const trimmed = code.trim();
    if (!trimmed) {
      console.error(c.red("Error: no authorization code provided."));
      return null;
    }
    const credentials = await exchange(trimmed, verifier);
    if (credentials.type === "failed") {
      if (credentials.details) {
        console.error(c.red(`Error: token exchange failed (${credentials.details}).`));
      } else {
        console.error(c.red("Error: token exchange failed. The code may be invalid or expired."));
      }
      return null;
    }
    return {
      refresh: credentials.refresh,
      access: credentials.access,
      expires: credentials.expires,
      email: credentials.email
    };
  } finally {
    rl.close();
  }
}
async function cmdLogin() {
  if (!process.stdin.isTTY) {
    console.error(c.red("Error: 'login' requires an interactive terminal."));
    return 1;
  }
  const stored = await loadAccounts();
  const credentials = await runOAuthFlow();
  if (!credentials) return 1;
  const storage = stored || { version: 1, accounts: [], activeIndex: 0 };
  const existingIdx = storage.accounts.findIndex((acc) => acc.refreshToken === credentials.refresh);
  if (existingIdx >= 0) {
    storage.accounts[existingIdx].access = credentials.access;
    storage.accounts[existingIdx].expires = credentials.expires;
    if (credentials.email) storage.accounts[existingIdx].email = credentials.email;
    storage.accounts[existingIdx].enabled = true;
    await saveAccounts(storage);
    const label2 = credentials.email || `Account ${existingIdx + 1}`;
    console.log(c.green(`Updated existing account #${existingIdx + 1} (${label2}).`));
    return 0;
  }
  if (storage.accounts.length >= 10) {
    console.error(c.red("Error: maximum of 10 accounts reached. Remove one first."));
    return 1;
  }
  const now = Date.now();
  storage.accounts.push({
    id: `${now}:${credentials.refresh.slice(0, 12)}`,
    email: credentials.email,
    refreshToken: credentials.refresh,
    access: credentials.access,
    expires: credentials.expires,
    token_updated_at: now,
    addedAt: now,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    stats: createDefaultStats(now)
  });
  await saveAccounts(storage);
  const label = credentials.email || `Account ${storage.accounts.length}`;
  console.log(c.green(`Added account #${storage.accounts.length} (${label}).`));
  console.log(c.dim(`${storage.accounts.length} account(s) total.`));
  return 0;
}
async function cmdLogout(arg, opts = {}) {
  if (opts.all) {
    return cmdLogoutAll(opts);
  }
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'logout 2') or --all."));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`));
    return 1;
  }
  const label = stored.accounts[idx].email || `Account ${n}`;
  if (!opts.force) {
    if (!process.stdin.isTTY) {
      console.error(c.red("Error: use --force to logout in non-interactive mode."));
      return 1;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(
        `Logout account #${n} (${label})? This will revoke tokens and remove the account. [y/N]: `
      );
      if (answer.trim().toLowerCase() !== "y") {
        console.log(c.dim("Cancelled."));
        return 0;
      }
    } finally {
      rl.close();
    }
  }
  const revoked = await revoke(stored.accounts[idx].refreshToken);
  if (revoked) {
    console.log(c.dim("Token revoked server-side."));
  } else {
    console.log(c.dim("Token revocation skipped (server may not support it)."));
  }
  stored.accounts.splice(idx, 1);
  if (stored.accounts.length === 0) {
    stored.activeIndex = 0;
  } else if (stored.activeIndex >= stored.accounts.length) {
    stored.activeIndex = stored.accounts.length - 1;
  } else if (stored.activeIndex > idx) {
    stored.activeIndex--;
  }
  await saveAccounts(stored);
  console.log(c.green(`Logged out account #${n} (${label}).`));
  if (stored.accounts.length > 0) {
    console.log(c.dim(`${stored.accounts.length} account(s) remaining.`));
  } else {
    console.log(c.dim("No accounts remaining. Run 'login' to add one."));
  }
  return 0;
}
async function cmdLogoutAll(opts = {}) {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.dim("No accounts to logout."));
    return 0;
  }
  const count = stored.accounts.length;
  if (!opts.force) {
    if (!process.stdin.isTTY) {
      console.error(c.red("Error: use --force to logout all in non-interactive mode."));
      return 1;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(
        `Logout all ${count} account(s)? This will revoke tokens and remove all accounts. [y/N]: `
      );
      if (answer.trim().toLowerCase() !== "y") {
        console.log(c.dim("Cancelled."));
        return 0;
      }
    } finally {
      rl.close();
    }
  }
  const results = await Promise.allSettled(stored.accounts.map((acc) => revoke(acc.refreshToken)));
  const revokedCount = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
  if (revokedCount > 0) {
    console.log(c.dim(`Revoked ${revokedCount} of ${count} token(s) server-side.`));
  }
  await saveAccounts({ version: 1, accounts: [], activeIndex: 0 });
  console.log(c.green(`Logged out all ${count} account(s).`));
  return 0;
}
async function cmdReauth(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'reauth 1')"));
    return 1;
  }
  if (!process.stdin.isTTY) {
    console.error(c.red("Error: 'reauth' requires an interactive terminal."));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`));
    return 1;
  }
  const existing = stored.accounts[idx];
  const wasDisabled = !existing.enabled;
  const oldLabel = existing.email || `Account ${n}`;
  console.log(c.bold(`Re-authenticating account #${n} (${oldLabel})...`));
  const credentials = await runOAuthFlow();
  if (!credentials) return 1;
  existing.refreshToken = credentials.refresh;
  existing.access = credentials.access;
  existing.expires = credentials.expires;
  if (credentials.email) existing.email = credentials.email;
  existing.enabled = true;
  existing.consecutiveFailures = 0;
  existing.lastFailureTime = null;
  existing.rateLimitResetTimes = {};
  await saveAccounts(stored);
  const newLabel = credentials.email || `Account ${n}`;
  console.log(c.green(`Re-authenticated account #${n} (${newLabel}).`));
  if (wasDisabled) {
    console.log(c.dim("Account has been re-enabled."));
  }
  return 0;
}
async function cmdRefresh(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'refresh 1')"));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`));
    return 1;
  }
  const account = stored.accounts[idx];
  const label = account.email || `Account ${n}`;
  console.log(c.dim(`Refreshing token for account #${n} (${label})...`));
  const token = await refreshAccessToken(account);
  if (!token) {
    console.error(c.red(`Error: token refresh failed for account #${n}.`));
    console.error(c.dim("The refresh token may be invalid or expired."));
    console.error(c.dim(`Try: opencode-anthropic-auth reauth ${n}`));
    return 1;
  }
  const wasDisabled = !account.enabled;
  account.enabled = true;
  account.consecutiveFailures = 0;
  account.lastFailureTime = null;
  account.rateLimitResetTimes = {};
  await saveAccounts(stored);
  const expiresIn = account.expires ? formatDuration(account.expires - Date.now()) : "unknown";
  console.log(c.green(`Token refreshed for account #${n} (${label}).`));
  console.log(c.dim(`New token expires in ${expiresIn}.`));
  if (wasDisabled) {
    console.log(c.dim("Account has been re-enabled."));
  }
  return 0;
}
async function cmdList() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    console.log(c.dim(`Storage: ${shortPath(getStoragePath())}`));
    console.log(c.dim("\nRun 'opencode auth login' and select 'Claude Pro/Max' to add accounts."));
    return 1;
  }
  const config = loadConfig();
  const now = Date.now();
  const usageResults = await Promise.allSettled(stored.accounts.map((acc) => ensureTokenAndFetchUsage(acc)));
  let anyRefreshed = false;
  for (const result of usageResults) {
    if (result.status === "fulfilled" && result.value.tokenRefreshed) {
      anyRefreshed = true;
    }
  }
  if (anyRefreshed) {
    await saveAccounts(stored).catch(() => {
    });
  }
  console.log(c.bold("Anthropic Multi-Account Status"));
  console.log(
    "  " + pad(c.dim("#"), 5) + pad(c.dim("Account"), 22) + pad(c.dim("Status"), 14) + pad(c.dim("Failures"), 11) + c.dim("Rate Limit")
  );
  console.log(c.dim("  " + "\u2500".repeat(62)));
  for (let i = 0; i < stored.accounts.length; i++) {
    const acc = stored.accounts[i];
    const isActive = i === stored.activeIndex;
    const num = String(i + 1);
    const label = acc.email || `Account ${i + 1}`;
    let status;
    if (!acc.enabled) {
      status = c.gray("\u25CB disabled");
    } else if (isActive) {
      status = c.green("\u25CF active");
    } else {
      status = c.cyan("\u25CF ready");
    }
    let failures;
    if (!acc.enabled) {
      failures = c.dim("\u2014");
    } else if (acc.consecutiveFailures > 0) {
      failures = c.yellow(String(acc.consecutiveFailures));
    } else {
      failures = c.dim("0");
    }
    let rateLimit;
    if (!acc.enabled) {
      rateLimit = c.dim("\u2014");
    } else {
      const resetTimes = acc.rateLimitResetTimes || {};
      const maxReset = Math.max(0, ...Object.values(resetTimes));
      if (maxReset > now) {
        rateLimit = c.yellow(`\u26A0 ${formatDuration(maxReset - now)}`);
      } else {
        rateLimit = c.dim("\u2014");
      }
    }
    console.log("  " + pad(c.bold(num), 5) + pad(label, 22) + pad(status, 14) + pad(failures, 11) + rateLimit);
    if (acc.enabled) {
      const result = usageResults[i];
      const usage = result.status === "fulfilled" ? result.value.usage : null;
      if (usage) {
        const lines = renderUsageLines(usage);
        for (const line of lines) {
          console.log(line);
        }
      } else {
        console.log(c.dim(`${USAGE_INDENT}quotas: unavailable`));
      }
    }
    if (i < stored.accounts.length - 1) {
      console.log("");
    }
  }
  console.log("");
  const enabled = stored.accounts.filter((a) => a.enabled).length;
  const disabled = stored.accounts.length - enabled;
  const parts = [
    `Strategy: ${c.cyan(config.account_selection_strategy)}`,
    `${c.bold(String(enabled))} of ${stored.accounts.length} enabled`
  ];
  if (disabled > 0) {
    parts.push(`${c.yellow(String(disabled))} disabled`);
  }
  console.log(parts.join(c.dim(" | ")));
  console.log(c.dim(`Storage: ${shortPath(getStoragePath())}`));
  return 0;
}
async function cmdStatus() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log("anthropic: no accounts configured");
    return 1;
  }
  const config = loadConfig();
  const total = stored.accounts.length;
  const enabled = stored.accounts.filter((a) => a.enabled).length;
  const now = Date.now();
  let rateLimited = 0;
  for (const acc of stored.accounts) {
    if (!acc.enabled) continue;
    const resetTimes = acc.rateLimitResetTimes || {};
    const maxReset = Math.max(0, ...Object.values(resetTimes));
    if (maxReset > now) rateLimited++;
  }
  let line = `anthropic: ${total} account${total !== 1 ? "s" : ""} (${enabled} active)`;
  line += `, strategy: ${config.account_selection_strategy}`;
  line += `, next: #${stored.activeIndex + 1}`;
  if (rateLimited > 0) {
    line += `, ${rateLimited} rate-limited`;
  }
  console.log(line);
  return 0;
}
async function cmdSwitch(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'switch 2')"));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`));
    return 1;
  }
  if (!stored.accounts[idx].enabled) {
    console.error(c.yellow(`Warning: account ${n} is disabled. Enable it first with 'enable ${n}'.`));
    return 1;
  }
  stored.activeIndex = idx;
  await saveAccounts(stored);
  const label = stored.accounts[idx].email || `Account ${n}`;
  console.log(c.green(`Switched active account to #${n} (${label}).`));
  return 0;
}
async function cmdEnable(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'enable 3')"));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }
  if (stored.accounts[idx].enabled) {
    console.log(c.dim(`Account ${n} is already enabled.`));
    return 0;
  }
  stored.accounts[idx].enabled = true;
  await saveAccounts(stored);
  const label = stored.accounts[idx].email || `Account ${n}`;
  console.log(c.green(`Enabled account #${n} (${label}).`));
  return 0;
}
async function cmdDisable(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'disable 3')"));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }
  if (!stored.accounts[idx].enabled) {
    console.log(c.dim(`Account ${n} is already disabled.`));
    return 0;
  }
  const enabledCount = stored.accounts.filter((a) => a.enabled).length;
  if (enabledCount <= 1) {
    console.error(c.red("Error: cannot disable the last enabled account."));
    return 1;
  }
  stored.accounts[idx].enabled = false;
  const label = stored.accounts[idx].email || `Account ${n}`;
  let switchedTo = null;
  if (idx === stored.activeIndex) {
    const nextEnabled = stored.accounts.findIndex((a) => a.enabled);
    if (nextEnabled >= 0) {
      stored.activeIndex = nextEnabled;
      switchedTo = nextEnabled;
    }
  }
  await saveAccounts(stored);
  console.log(c.yellow(`Disabled account #${n} (${label}).`));
  if (switchedTo !== null) {
    const nextLabel = stored.accounts[switchedTo].email || `Account ${switchedTo + 1}`;
    console.log(c.dim(`Active account switched to #${switchedTo + 1} (${nextLabel}).`));
  }
  return 0;
}
async function cmdRemove(arg, opts = {}) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'remove 2')"));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }
  const label = stored.accounts[idx].email || `Account ${n}`;
  if (!opts.force) {
    if (!process.stdin.isTTY) {
      console.error(c.red("Error: use --force to remove accounts in non-interactive mode."));
      return 1;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`Remove account #${n} (${label})? This cannot be undone. [y/N]: `);
      if (answer.trim().toLowerCase() !== "y") {
        console.log(c.dim("Cancelled."));
        return 0;
      }
    } finally {
      rl.close();
    }
  }
  stored.accounts.splice(idx, 1);
  if (stored.accounts.length === 0) {
    stored.activeIndex = 0;
  } else if (stored.activeIndex >= stored.accounts.length) {
    stored.activeIndex = stored.accounts.length - 1;
  } else if (stored.activeIndex > idx) {
    stored.activeIndex--;
  }
  await saveAccounts(stored);
  console.log(c.green(`Removed account #${n} (${label}).`));
  if (stored.accounts.length > 0) {
    console.log(c.dim(`${stored.accounts.length} account(s) remaining.`));
  } else {
    console.log(c.dim("No accounts remaining. Run 'opencode auth login' to add one."));
  }
  return 0;
}
async function cmdReset(arg) {
  if (!arg) {
    console.error(c.red("Error: provide an account number or 'all' (e.g., 'reset 1' or 'reset all')"));
    return 1;
  }
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }
  if (arg.toLowerCase() === "all") {
    let count = 0;
    for (const acc of stored.accounts) {
      acc.rateLimitResetTimes = {};
      acc.consecutiveFailures = 0;
      acc.lastFailureTime = null;
      count++;
    }
    await saveAccounts(stored);
    console.log(c.green(`Reset tracking for all ${count} account(s).`));
    return 0;
  }
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number or 'all'."));
    return 1;
  }
  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }
  stored.accounts[idx].rateLimitResetTimes = {};
  stored.accounts[idx].consecutiveFailures = 0;
  stored.accounts[idx].lastFailureTime = null;
  await saveAccounts(stored);
  const label = stored.accounts[idx].email || `Account ${n}`;
  console.log(c.green(`Reset tracking for account #${n} (${label}).`));
  return 0;
}
async function cmdConfig() {
  const config = loadConfig();
  const stored = await loadAccounts();
  console.log(c.bold("Anthropic Auth Configuration"));
  console.log(c.dim("\u2500".repeat(45)));
  console.log("");
  console.log(c.dim("Strategy:          ") + c.cyan(config.account_selection_strategy));
  console.log(c.dim("Failure TTL:       ") + `${config.failure_ttl_seconds}s`);
  console.log(c.dim("Debug:             ") + (config.debug ? c.yellow("on") : c.dim("off")));
  console.log("");
  console.log(c.dim("Health Score"));
  console.log(c.dim("  Initial:         ") + `${config.health_score.initial}`);
  console.log(c.dim("  Success reward:  ") + `+${config.health_score.success_reward}`);
  console.log(c.dim("  Rate limit:      ") + `${config.health_score.rate_limit_penalty}`);
  console.log(c.dim("  Failure:         ") + `${config.health_score.failure_penalty}`);
  console.log(c.dim("  Recovery/hour:   ") + `+${config.health_score.recovery_rate_per_hour}`);
  console.log(c.dim("  Min usable:      ") + `${config.health_score.min_usable}`);
  console.log("");
  console.log(c.dim("Token Bucket"));
  console.log(c.dim("  Max tokens:      ") + `${config.token_bucket.max_tokens}`);
  console.log(c.dim("  Regen/min:       ") + `${config.token_bucket.regeneration_rate_per_minute}`);
  console.log(c.dim("  Initial:         ") + `${config.token_bucket.initial_tokens}`);
  console.log("");
  console.log(c.dim("Files"));
  console.log(c.dim("  Config:          ") + shortPath(getConfigPath()));
  console.log(c.dim("  Accounts:        ") + shortPath(getStoragePath()));
  if (stored) {
    const enabled = stored.accounts.filter((a) => a.enabled).length;
    console.log(c.dim("  Accounts total:  ") + `${stored.accounts.length} (${enabled} enabled)`);
  } else {
    console.log(c.dim("  Accounts total:  ") + c.dim("none"));
  }
  console.log("");
  const envOverrides = [];
  if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    envOverrides.push(`OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY}`);
  }
  if (process.env.OPENCODE_ANTHROPIC_DEBUG) {
    envOverrides.push(`OPENCODE_ANTHROPIC_DEBUG=${process.env.OPENCODE_ANTHROPIC_DEBUG}`);
  }
  if (envOverrides.length > 0) {
    console.log(c.dim("Environment overrides:"));
    for (const ov of envOverrides) {
      console.log(c.dim("  ") + c.yellow(ov));
    }
  }
  return 0;
}
async function cmdStrategy(arg) {
  const config = loadConfig();
  if (!arg) {
    console.log(c.bold("Account Selection Strategy"));
    console.log(c.dim("\u2500".repeat(45)));
    console.log("");
    const descriptions = {
      sticky: "Stay on one account until it fails or is rate-limited",
      "round-robin": "Rotate through accounts on every request",
      hybrid: "Prefer healthy accounts, rotate when degraded"
    };
    for (const s of VALID_STRATEGIES) {
      const current = s === config.account_selection_strategy;
      const marker = current ? c.green("\u25B8 ") : "  ";
      const name = current ? c.bold(c.cyan(s)) : c.dim(s);
      const desc = current ? descriptions[s] : c.dim(descriptions[s]);
      console.log(`${marker}${pad(name, 16)}${desc}`);
    }
    console.log("");
    console.log(c.dim(`Change with: opencode-anthropic-auth strategy <${VALID_STRATEGIES.join("|")}>`));
    if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
      console.log(
        c.yellow(
          `
Note: OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} overrides config file at runtime.`
        )
      );
    }
    return 0;
  }
  const normalized = arg.toLowerCase().trim();
  if (!VALID_STRATEGIES.includes(normalized)) {
    console.error(c.red(`Error: invalid strategy '${arg}'.`));
    console.error(c.dim(`Valid strategies: ${VALID_STRATEGIES.join(", ")}`));
    return 1;
  }
  if (normalized === config.account_selection_strategy && !process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    console.log(c.dim(`Strategy is already '${normalized}'.`));
    return 0;
  }
  saveConfig({ account_selection_strategy: normalized });
  console.log(c.green(`Strategy changed to '${normalized}'.`));
  if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    console.log(
      c.yellow(
        `Note: OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} will override this at runtime.`
      )
    );
  }
  return 0;
}
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
async function cmdStats() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    return 1;
  }
  const W = { num: 4, name: 22, val: 10 };
  const RULE = c.dim("  " + "\u2500".repeat(74));
  console.log(c.bold("Anthropic Account Usage"));
  console.log(
    "  " + pad(c.dim("#"), W.num) + pad(c.dim("Account"), W.name) + rpad(c.dim("Requests"), W.val) + rpad(c.dim("Input"), W.val) + rpad(c.dim("Output"), W.val) + rpad(c.dim("Cache R"), W.val) + rpad(c.dim("Cache W"), W.val)
  );
  console.log(RULE);
  let totReq = 0, totIn = 0, totOut = 0, totCR = 0, totCW = 0;
  let oldestReset = Infinity;
  for (let i = 0; i < stored.accounts.length; i++) {
    const acc = stored.accounts[i];
    const s = acc.stats || createDefaultStats();
    const isActive = i === stored.activeIndex;
    const marker = isActive ? c.green("\u25CF") : " ";
    const num = `${marker} ${i + 1}`;
    const name = acc.email || `Account ${i + 1}`;
    console.log(
      "  " + pad(num, W.num) + pad(name, W.name) + rpad(String(s.requests), W.val) + rpad(fmtTokens(s.inputTokens), W.val) + rpad(fmtTokens(s.outputTokens), W.val) + rpad(fmtTokens(s.cacheReadTokens), W.val) + rpad(fmtTokens(s.cacheWriteTokens), W.val)
    );
    totReq += s.requests;
    totIn += s.inputTokens;
    totOut += s.outputTokens;
    totCR += s.cacheReadTokens;
    totCW += s.cacheWriteTokens;
    if (s.lastReset < oldestReset) oldestReset = s.lastReset;
  }
  if (stored.accounts.length > 1) {
    console.log(RULE);
    console.log(
      c.bold(
        "  " + pad("", W.num) + pad("Total", W.name) + rpad(String(totReq), W.val) + rpad(fmtTokens(totIn), W.val) + rpad(fmtTokens(totOut), W.val) + rpad(fmtTokens(totCR), W.val) + rpad(fmtTokens(totCW), W.val)
      )
    );
  }
  console.log("");
  if (oldestReset < Infinity) {
    console.log(c.dim(`Tracking since: ${new Date(oldestReset).toLocaleString()} (${formatTimeAgo(oldestReset)})`));
  }
  return 0;
}
async function cmdResetStats(arg) {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    return 1;
  }
  const now = Date.now();
  if (!arg || arg === "all") {
    for (const acc of stored.accounts) {
      acc.stats = createDefaultStats(now);
    }
    await saveAccounts(stored);
    console.log(c.green("Reset usage statistics for all accounts."));
    return 0;
  }
  const idx = parseInt(arg, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= stored.accounts.length) {
    console.log(c.red(`Invalid account number. Use 1-${stored.accounts.length} or 'all'.`));
    return 1;
  }
  stored.accounts[idx].stats = createDefaultStats(now);
  await saveAccounts(stored);
  const name = stored.accounts[idx].email || `Account ${idx + 1}`;
  console.log(c.green(`Reset usage statistics for ${name}.`));
  return 0;
}
async function cmdManage() {
  let stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    console.log(c.dim("Run 'opencode auth login' and select 'Claude Pro/Max' to add accounts."));
    return 1;
  }
  if (!process.stdin.isTTY) {
    console.error(c.red("Error: 'manage' requires an interactive terminal."));
    console.error(c.dim("Use 'enable', 'disable', 'remove', 'switch' for non-interactive use."));
    return 1;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      stored = await loadAccounts();
      if (!stored || stored.accounts.length === 0) {
        console.log(c.dim("No accounts remaining."));
        break;
      }
      const accounts = stored.accounts;
      console.log("");
      console.log(c.bold(`${accounts.length} account(s):`));
      for (let i = 0; i < accounts.length; i++) {
        const num2 = i + 1;
        const label = accounts[i].email || `Account ${num2}`;
        const active = i === stored.activeIndex ? c.green(" (active)") : "";
        const disabled = !accounts[i].enabled ? c.yellow(" [disabled]") : "";
        console.log(`  ${c.bold(String(num2))}. ${label}${active}${disabled}`);
      }
      console.log("");
      const currentStrategy = loadConfig().account_selection_strategy;
      console.log(c.dim(`Strategy: ${currentStrategy}`));
      console.log(c.dim("Commands: (s)witch N, (e)nable N, (d)isable N, (r)emove N, (R)eset N, s(t)rategy, (q)uit"));
      const answer = await rl.question(c.dim("> "));
      const trimmed = answer.trim();
      if (trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "quit") break;
      const match = trimmed.match(/^([a-zA-Z]+)\s*(\d+)?$/);
      if (!match) {
        console.log(c.red("Invalid input. Try 's 2', 'e 3', 'd 1', 'r 2', 'R 1', or 'q'."));
        continue;
      }
      const [, rawCmd, numStr] = match;
      const cmd = rawCmd.toLowerCase();
      const num = numStr ? parseInt(numStr, 10) : NaN;
      const idx = num - 1;
      if (numStr && (isNaN(num) || num < 1 || idx >= accounts.length)) {
        console.log(c.red(`Invalid account number. Valid range: 1-${accounts.length}.`));
        continue;
      }
      const isReset = rawCmd === "R" || cmd === "reset";
      if (isReset) {
        if (isNaN(num)) {
          console.log(c.red("Usage: R <number>"));
          continue;
        }
        stored.accounts[idx].rateLimitResetTimes = {};
        stored.accounts[idx].consecutiveFailures = 0;
        stored.accounts[idx].lastFailureTime = null;
        await saveAccounts(stored);
        console.log(c.green(`Reset tracking for account #${num}.`));
        continue;
      }
      switch (cmd) {
        case "s":
        case "switch": {
          if (isNaN(num)) {
            console.log(c.red("Usage: s <number>"));
            break;
          }
          if (!accounts[idx].enabled) {
            console.log(c.yellow(`Account ${num} is disabled. Enable it first.`));
            break;
          }
          stored.activeIndex = idx;
          await saveAccounts(stored);
          const switchLabel = accounts[idx].email || `Account ${num}`;
          console.log(c.green(`Switched to #${num} (${switchLabel}).`));
          break;
        }
        case "e":
        case "enable": {
          if (isNaN(num)) {
            console.log(c.red("Usage: e <number>"));
            break;
          }
          if (accounts[idx].enabled) {
            console.log(c.dim(`Account ${num} is already enabled.`));
            break;
          }
          stored.accounts[idx].enabled = true;
          await saveAccounts(stored);
          console.log(c.green(`Enabled account #${num}.`));
          break;
        }
        case "d":
        case "disable": {
          if (isNaN(num)) {
            console.log(c.red("Usage: d <number>"));
            break;
          }
          if (!accounts[idx].enabled) {
            console.log(c.dim(`Account ${num} is already disabled.`));
            break;
          }
          const enabledCount = accounts.filter((a) => a.enabled).length;
          if (enabledCount <= 1) {
            console.log(c.red("Cannot disable the last enabled account."));
            break;
          }
          stored.accounts[idx].enabled = false;
          if (idx === stored.activeIndex) {
            const nextEnabled = accounts.findIndex((a) => a.enabled && accounts.indexOf(a) !== idx);
            if (nextEnabled >= 0) stored.activeIndex = nextEnabled;
          }
          await saveAccounts(stored);
          console.log(c.yellow(`Disabled account #${num}.`));
          break;
        }
        case "r":
        case "remove": {
          if (isNaN(num)) {
            console.log(c.red("Usage: r <number>"));
            break;
          }
          const removeLabel = accounts[idx].email || `Account ${num}`;
          const confirm = await rl.question(`Remove #${num} (${removeLabel})? [y/N]: `);
          if (confirm.trim().toLowerCase() === "y") {
            stored.accounts.splice(idx, 1);
            if (stored.accounts.length === 0) {
              stored.activeIndex = 0;
            } else if (stored.activeIndex >= stored.accounts.length) {
              stored.activeIndex = stored.accounts.length - 1;
            } else if (stored.activeIndex > idx) {
              stored.activeIndex--;
            }
            await saveAccounts(stored);
            console.log(c.green(`Removed account #${num}.`));
          } else {
            console.log(c.dim("Cancelled."));
          }
          break;
        }
        case "t":
        case "strategy": {
          console.log(c.dim(`Current: ${loadConfig().account_selection_strategy}`));
          console.log(c.dim(`Options: ${VALID_STRATEGIES.join(", ")}`));
          const stratAnswer = await rl.question(c.dim("New strategy: "));
          const strat = stratAnswer.trim().toLowerCase();
          if (!strat) {
            console.log(c.dim("Cancelled."));
            break;
          }
          if (!VALID_STRATEGIES.includes(strat)) {
            console.log(c.red(`Invalid strategy. Choose: ${VALID_STRATEGIES.join(", ")}`));
            break;
          }
          saveConfig({ account_selection_strategy: strat });
          console.log(c.green(`Strategy changed to '${strat}'.`));
          break;
        }
        default:
          console.log(c.red("Unknown command. Try 's', 'e', 'd', 'r', 'R', 't', or 'q'."));
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}
function cmdHelp() {
  const bin = "opencode-anthropic-auth";
  console.log(`
${c.bold("Anthropic Multi-Account Auth CLI")}

${c.dim("Usage:")}
  ${bin} [command] [args]

${c.dim("Auth Commands:")}
  ${pad(c.cyan("login"), 22)}Add a new account via browser OAuth flow
  ${pad(c.cyan("logout") + " <N>", 22)}Revoke tokens and remove account N
  ${pad(c.cyan("logout") + " --all", 22)}Revoke all tokens and clear all accounts
  ${pad(c.cyan("reauth") + " <N>", 22)}Re-authenticate account N with fresh tokens
  ${pad(c.cyan("refresh") + " <N>", 22)}Attempt token refresh (no browser needed)

${c.dim("Account Commands:")}
  ${pad(c.cyan("list"), 22)}Show all accounts with status ${c.dim("(default)")}
  ${pad(c.cyan("status"), 22)}Compact one-liner for scripts/prompts
  ${pad(c.cyan("switch") + " <N>", 22)}Set account N as active
  ${pad(c.cyan("enable") + " <N>", 22)}Enable a disabled account
  ${pad(c.cyan("disable") + " <N>", 22)}Disable an account (skipped in rotation)
  ${pad(c.cyan("remove") + " <N>", 22)}Remove an account permanently
  ${pad(c.cyan("reset") + " <N|all>", 22)}Clear rate-limit / failure tracking
  ${pad(c.cyan("stats"), 22)}Show per-account usage statistics
  ${pad(c.cyan("reset-stats") + " [N|all]", 22)}Reset usage statistics
  ${pad(c.cyan("strategy") + " [name]", 22)}Show or change selection strategy
  ${pad(c.cyan("config"), 22)}Show configuration and file paths
  ${pad(c.cyan("manage"), 22)}Interactive account management menu
  ${pad(c.cyan("help"), 22)}Show this help message

${c.dim("Options:")}
  --force           Skip confirmation prompts
  --all             Target all accounts (for logout)
  --no-color        Disable colored output

${c.dim("Examples:")}
  ${bin} login             ${c.dim("# Add a new account via browser")}
  ${bin} logout 2          ${c.dim("# Revoke tokens & remove account 2")}
  ${bin} logout --all      ${c.dim("# Logout all accounts")}
  ${bin} reauth 1          ${c.dim("# Re-authenticate account 1")}
  ${bin} refresh 1         ${c.dim("# Quick token refresh for account 1")}
  ${bin} list              ${c.dim("# Show all accounts")}
  ${bin} switch 2          ${c.dim("# Make account 2 active")}
  ${bin} disable 3         ${c.dim("# Temporarily disable account 3")}
  ${bin} reset all         ${c.dim("# Clear all rate-limit tracking")}
  ${bin} strategy sticky   ${c.dim("# Switch to sticky mode")}
  ${bin} stats             ${c.dim("# Show token usage per account")}
  ${bin} status            ${c.dim("# One-liner for shell prompt")}

${c.dim("Files:")}
  Config:   ${shortPath(getConfigPath())}
  Accounts: ${shortPath(getStoragePath())}
`);
  return 0;
}
var ioContext = new AsyncLocalStorage();
var nativeConsoleLog = console.log.bind(console);
var nativeConsoleError = console.error.bind(console);
var consoleRouterUsers = 0;
function installConsoleRouter() {
  if (consoleRouterUsers === 0) {
    console.log = (...args) => {
      const io = ioContext.getStore();
      if (io?.log) return io.log(...args);
      return nativeConsoleLog(...args);
    };
    console.error = (...args) => {
      const io = ioContext.getStore();
      if (io?.error) return io.error(...args);
      return nativeConsoleError(...args);
    };
  }
  consoleRouterUsers++;
}
function uninstallConsoleRouter() {
  consoleRouterUsers = Math.max(0, consoleRouterUsers - 1);
  if (consoleRouterUsers === 0) {
    console.log = nativeConsoleLog;
    console.error = nativeConsoleError;
  }
}
async function runWithIoContext(io, fn) {
  installConsoleRouter();
  try {
    return await ioContext.run(io, fn);
  } finally {
    uninstallConsoleRouter();
  }
}
async function dispatch(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));
  if (flags.includes("--no-color")) USE_COLOR = false;
  if (flags.includes("--help")) return cmdHelp();
  const command = args[0] || "list";
  const arg = args[1];
  const force = flags.includes("--force");
  const all = flags.includes("--all");
  switch (command) {
    // Auth commands
    case "login":
    case "ln":
      return cmdLogin();
    case "logout":
    case "lo":
      return cmdLogout(arg, { force, all });
    case "reauth":
    case "ra":
      return cmdReauth(arg);
    case "refresh":
    case "rf":
      return cmdRefresh(arg);
    // Account management commands
    case "list":
    case "ls":
      return cmdList();
    case "status":
    case "st":
      return cmdStatus();
    case "switch":
    case "sw":
      return cmdSwitch(arg);
    case "enable":
    case "en":
      return cmdEnable(arg);
    case "disable":
    case "dis":
      return cmdDisable(arg);
    case "remove":
    case "rm":
      return cmdRemove(arg, { force });
    case "reset":
      return cmdReset(arg);
    case "stats":
      return cmdStats();
    case "reset-stats":
      return cmdResetStats(arg);
    case "strategy":
    case "strat":
      return cmdStrategy(arg);
    case "config":
    case "cfg":
      return cmdConfig();
    case "manage":
    case "mg":
      return cmdManage();
    case "help":
    case "-h":
    case "--help":
      return cmdHelp();
    default:
      console.error(c.red(`Unknown command: ${command}`));
      console.error(c.dim("Run 'opencode-anthropic-auth help' for usage."));
      return 1;
  }
}
async function main(argv, options = {}) {
  if (options.io) {
    return runWithIoContext(options.io, () => dispatch(argv));
  }
  return dispatch(argv);
}
async function detectMain() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    const { realpath } = await import("node:fs/promises");
    const resolved = await realpath(process.argv[1]);
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    return false;
  }
}
if (await detectMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error(c.red(`Fatal: ${err.message}`));
    process.exit(1);
  });
}
export {
  cmdConfig,
  cmdDisable,
  cmdEnable,
  cmdHelp,
  cmdList,
  cmdLogin,
  cmdLogout,
  cmdManage,
  cmdReauth,
  cmdRefresh,
  cmdRemove,
  cmdReset,
  cmdResetStats,
  cmdStats,
  cmdStatus,
  cmdStrategy,
  cmdSwitch,
  ensureTokenAndFetchUsage,
  fetchUsage,
  formatDuration,
  formatResetTime,
  formatTimeAgo,
  main,
  refreshAccessToken,
  renderBar,
  renderUsageLines
};
