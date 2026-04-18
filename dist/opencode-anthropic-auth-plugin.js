var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// lib/config.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
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
    const t2 = (
      /** @type {Record<string, unknown>} */
      raw.toasts
    );
    config.toasts = {
      quiet: typeof t2.quiet === "boolean" ? t2.quiet : DEFAULT_CONFIG.toasts.quiet,
      debounce_seconds: clampNumber(t2.debounce_seconds, 0, 300, DEFAULT_CONFIG.toasts.debounce_seconds)
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
      adaptive_tool_set: typeof tes.adaptive_tool_set === "boolean" ? tes.adaptive_tool_set : DEFAULT_CONFIG.token_economy_strategies.adaptive_tool_set,
      tool_result_dedupe_session_wide: typeof tes.tool_result_dedupe_session_wide === "boolean" ? tes.tool_result_dedupe_session_wide : DEFAULT_CONFIG.token_economy_strategies.tool_result_dedupe_session_wide,
      haiku_rolling_summary: typeof tes.haiku_rolling_summary === "boolean" ? tes.haiku_rolling_summary : DEFAULT_CONFIG.token_economy_strategies.haiku_rolling_summary,
      stale_read_eviction: typeof tes.stale_read_eviction === "boolean" ? tes.stale_read_eviction : DEFAULT_CONFIG.token_economy_strategies.stale_read_eviction,
      per_tool_class_prune: typeof tes.per_tool_class_prune === "boolean" ? tes.per_tool_class_prune : DEFAULT_CONFIG.token_economy_strategies.per_tool_class_prune
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
function loadConfigFresh() {
  return loadConfig();
}
var DEFAULT_CONFIG, VALID_STRATEGIES, CLIENT_ID;
var init_config = __esm({
  "lib/config.mjs"() {
    DEFAULT_CONFIG = {
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
         *  Default ON (Phase C2). Server-side gating + contextHintState.disabled
         *  latching means compatible servers use it and incompatible ones fall
         *  back cleanly via the 400/409/529 error paths. Explicit opt-out via
         *  `token_economy.context_hint: false` is respected. Even when on, the
         *  beta is only sent for requests classified as "main-thread" (see
         *  classifyRequestRole). */
        context_hint: true,
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
        per_tool_class_prune: false
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
    VALID_STRATEGIES = ["sticky", "round-robin", "hybrid"];
    CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  }
});

// lib/storage.mjs
import { promises as fs } from "node:fs";
import { existsSync as existsSync2, readFileSync as readFileSync2, appendFileSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { randomBytes as randomBytes2, createHash } from "node:crypto";
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
async function clearAccounts() {
  const storagePath = getStoragePath();
  try {
    await fs.unlink(storagePath);
  } catch (error) {
    const code = (
      /** @type {NodeJS.ErrnoException} */
      error.code
    );
    if (code !== "ENOENT") throw error;
  }
}
var CURRENT_VERSION, GITIGNORE_ENTRIES;
var init_storage = __esm({
  "lib/storage.mjs"() {
    init_config();
    CURRENT_VERSION = 1;
    GITIGNORE_ENTRIES = [".gitignore", "anthropic-accounts.json", "anthropic-accounts.json.*.tmp"];
  }
});

// lib/backoff.mjs
function parseRetryAfterMsHeader(response) {
  const header = response.headers.get("retry-after-ms");
  if (!header) return null;
  const ms = parseFloat(header);
  return !isNaN(ms) && ms > 0 ? ms : null;
}
function parseShouldRetryHeader(response) {
  const header = response.headers.get("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  return null;
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
function extractErrorSignals(body) {
  let errorType = "";
  let message = "";
  let text = "";
  if (body == null) {
    return { errorType, message, text };
  }
  if (typeof body === "string") {
    text = body.toLowerCase();
    try {
      const parsed = JSON.parse(body);
      errorType = String(parsed?.error?.type || "").toLowerCase();
      message = String(parsed?.error?.message || "").toLowerCase();
    } catch {
    }
    return { errorType, message, text };
  }
  if (typeof body === "object") {
    errorType = String(body?.error?.type || "").toLowerCase();
    message = String(body?.error?.message || "").toLowerCase();
    try {
      text = JSON.stringify(body).toLowerCase();
    } catch {
      text = "";
    }
  }
  return { errorType, message, text };
}
function bodyHasAccountError(body) {
  const { errorType, message, text } = extractErrorSignals(body);
  const typeSignals = [
    "rate_limit",
    "quota",
    "billing",
    "permission",
    "authentication",
    "invalid_api_key",
    "insufficient_permissions",
    "invalid_grant"
  ];
  const messageSignals = [
    "rate limit",
    "would exceed",
    "quota",
    "exhausted",
    "credit balance",
    "billing",
    "permission",
    "forbidden",
    "unauthorized",
    "authentication",
    "not authorized"
  ];
  return typeSignals.some((signal) => errorType.includes(signal)) || messageSignals.some((signal) => message.includes(signal));
}
function isAccountSpecificError(status, body) {
  if (status === 429) return true;
  if (status === 401) return true;
  if ((status === 400 || status === 403) && body) {
    return bodyHasAccountError(body);
  }
  return false;
}
function parseRateLimitReason(status, body) {
  const { errorType, message, text } = extractErrorSignals(body);
  const authSignals = [
    "authentication",
    "invalid_api_key",
    "invalid api key",
    "invalid_grant",
    "unauthorized",
    "invalid access token",
    "expired token"
  ];
  const isAuthFailure = status === 401 || authSignals.some((signal) => errorType.includes(signal)) || authSignals.some((signal) => message.includes(signal)) || authSignals.some((signal) => text.includes(signal));
  if (isAuthFailure) {
    return "AUTH_FAILED";
  }
  if (errorType.includes("quota") || errorType.includes("billing") || errorType.includes("permission") || errorType.includes("insufficient_permissions") || message.includes("quota") || message.includes("exhausted") || message.includes("credit balance") || message.includes("billing") || message.includes("permission") || message.includes("forbidden") || text.includes("permission")) {
    return "QUOTA_EXHAUSTED";
  }
  return "RATE_LIMIT_EXCEEDED";
}
function calculateBackoffMs(reason, consecutiveFailures, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, MIN_BACKOFF_MS), MAX_COOLDOWN_FROM_RESET_MS);
  }
  switch (reason) {
    case "AUTH_FAILED":
      return AUTH_FAILED_BACKOFF;
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
      return QUOTA_EXHAUSTED_BACKOFFS[index];
    }
    case "RATE_LIMIT_EXCEEDED":
    default:
      return RATE_LIMIT_EXCEEDED_BACKOFF;
  }
}
var QUOTA_EXHAUSTED_BACKOFFS, AUTH_FAILED_BACKOFF, RATE_LIMIT_EXCEEDED_BACKOFF, MIN_BACKOFF_MS, MAX_COOLDOWN_FROM_RESET_MS, TRANSIENT_RETRY_THRESHOLD_MS;
var init_backoff = __esm({
  "lib/backoff.mjs"() {
    QUOTA_EXHAUSTED_BACKOFFS = [6e4, 3e5, 18e5, 72e5];
    AUTH_FAILED_BACKOFF = 5e3;
    RATE_LIMIT_EXCEEDED_BACKOFF = 3e4;
    MIN_BACKOFF_MS = 2e3;
    MAX_COOLDOWN_FROM_RESET_MS = 3e5;
    TRANSIENT_RETRY_THRESHOLD_MS = 1e4;
  }
});

// lib/cc-credentials.mjs
var cc_credentials_exports = {};
__export(cc_credentials_exports, {
  parseCCCredentialData: () => parseCCCredentialData,
  readCCCredentials: () => readCCCredentials,
  readCCCredentialsFromFile: () => readCCCredentialsFromFile,
  readCCCredentialsFromKeychain: () => readCCCredentialsFromKeychain
});
import { execSync, execFileSync } from "node:child_process";
import { readFileSync as readFileSync3, existsSync as existsSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";
function listKeychainServices() {
  if (process.platform !== "darwin") return [];
  try {
    const dump = execSync("security dump-keychain", {
      timeout: 5e3,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const services = [];
    const regex = /"svce"<blob>="(Claude Code-credentials[^"]*)"/g;
    let match;
    while ((match = regex.exec(dump)) !== null) {
      const svc = match[1];
      if (!services.includes(svc)) services.push(svc);
    }
    return services;
  } catch {
    return [];
  }
}
function readKeychainService(service) {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      timeout: 5e3,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return parseCCCredentialData(raw, "cc-keychain", `keychain:${service}`);
  } catch (err) {
    return null;
  }
}
function readCCCredentialsFromKeychain() {
  const services = listKeychainServices();
  const credentials = [];
  for (const svc of services) {
    const cred = readKeychainService(svc);
    if (cred) credentials.push(cred);
  }
  return credentials;
}
function readCCCredentialsFromFile() {
  const credPath = join3(homedir2(), ".claude", ".credentials.json");
  if (!existsSync3(credPath)) return [];
  try {
    const raw = readFileSync3(credPath, "utf-8");
    const parsed = JSON.parse(raw);
    const results = [];
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== "object") continue;
      const data = entry.claudeAiOauth && typeof entry.claudeAiOauth === "object" ? entry.claudeAiOauth : entry;
      if (data.scope === "mcp") continue;
      const cred = shapeToCCCredential(data, "cc-file", `file:entry-${i}`);
      if (cred) results.push(cred);
    }
    return results;
  } catch {
    return [];
  }
}
function readCCCredentials() {
  const all = [];
  all.push(...readCCCredentialsFromKeychain());
  all.push(...readCCCredentialsFromFile());
  const seen = /* @__PURE__ */ new Map();
  for (const cred of all) {
    const existing = seen.get(cred.refreshToken);
    if (!existing || cred.source === "cc-keychain" && existing.source === "cc-file") {
      seen.set(cred.refreshToken, cred);
    }
  }
  return [...seen.values()];
}
function parseCCCredentialData(jsonStr, source, label) {
  try {
    const data = JSON.parse(jsonStr);
    if (!data || typeof data !== "object") return null;
    const inner = data.claudeAiOauth && typeof data.claudeAiOauth === "object" ? data.claudeAiOauth : data;
    return shapeToCCCredential(inner, source, label);
  } catch {
    return null;
  }
}
function shapeToCCCredential(data, source, label) {
  if (data.scope === "mcp") return null;
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : null;
  const refreshToken2 = typeof data.refreshToken === "string" ? data.refreshToken : null;
  if (!accessToken || !refreshToken2) return null;
  let expiresAt = 0;
  if (typeof data.expiresAt === "number") {
    expiresAt = data.expiresAt;
  } else if (typeof data.expiresAt === "string") {
    const parsed = Date.parse(data.expiresAt);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof data.expires_at === "number") {
    expiresAt = data.expires_at;
  }
  return {
    accessToken,
    refreshToken: refreshToken2,
    expiresAt,
    subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : void 0,
    source,
    label
  };
}
var init_cc_credentials = __esm({
  "lib/cc-credentials.mjs"() {
  }
});

// lib/oauth.mjs
import { createHash as createHash3, randomBytes as randomBytes3 } from "node:crypto";
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}
function generatePKCE() {
  const verifier = base64url(randomBytes3(32));
  const challenge = base64url(createHash3("sha256").update(verifier).digest());
  const state = base64url(randomBytes3(32));
  return { verifier, challenge, state };
}
function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve2) => setTimeout(resolve2, ms));
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
async function revoke(refreshToken2) {
  try {
    const resp = await fetch(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: {
        Accept: OAUTH_ACCEPT,
        "Content-Type": "application/json",
        "User-Agent": OAUTH_USER_AGENT
      },
      body: JSON.stringify({
        token: refreshToken2,
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
async function refreshToken(refreshTokenValue, options = {}) {
  const signal = options.signal ?? AbortSignal.timeout(3e4);
  for (let attempt = 0; attempt <= OAUTH_MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: OAUTH_ACCEPT,
          "Content-Type": "application/json",
          "User-Agent": OAUTH_USER_AGENT
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
          client_id: CLIENT_ID,
          scope: options.scopes ? options.scopes.join(" ") : CLAUDE_AI_SCOPES.join(" ")
        }),
        signal
      });
    } catch (err) {
      if (attempt < OAUTH_MAX_RETRIES) {
        await sleep(Math.min(500 * 2 ** attempt, 2e3));
        continue;
      }
      throw err;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const retryAfterMs = getRetryDelayMs(resp, attempt);
      if (attempt < OAUTH_MAX_RETRIES && isRetryableTokenStatus(resp.status)) {
        await sleep(retryAfterMs);
        continue;
      }
      const error = new Error(`Token refresh failed (HTTP ${resp.status}): ${text}`);
      error.status = resp.status;
      const cooldownHint = getCooldownHint(resp, resp.status);
      error.retryAfterMs = Number.isFinite(cooldownHint.retryAfterMs) && cooldownHint.retryAfterMs > 0 ? cooldownHint.retryAfterMs : retryAfterMs;
      if (cooldownHint.retryAfterSource) {
        error.retryAfterSource = cooldownHint.retryAfterSource;
      }
      const parsed = parseOAuthErrorBody(text);
      if (parsed.errorCode) error.code = parsed.errorCode;
      throw error;
    }
    return resp.json();
  }
}
var OAUTH_CONSOLE_HOST, OAUTH_MAX_HOST, OAUTH_REDIRECT_URI, OAUTH_TOKEN_URL, OAUTH_REVOKE_URL, OAUTH_AXIOS_VERSION, OAUTH_USER_AGENT, OAUTH_ACCEPT, OAUTH_MAX_RETRIES, OAUTH_MAX_RETRY_DELAY_MS, OAUTH_RATE_LIMIT_COOLDOWN_MS, OAUTH_RETRY_AFTER_SOURCE_HEADER_MS, OAUTH_RETRY_AFTER_SOURCE_HEADER, OAUTH_RETRY_AFTER_SOURCE_FALLBACK_429, CLAUDE_AI_SCOPES, CONSOLE_SCOPES;
var init_oauth = __esm({
  "lib/oauth.mjs"() {
    init_config();
    init_backoff();
    OAUTH_CONSOLE_HOST = "platform.claude.com";
    OAUTH_MAX_HOST = "claude.ai";
    OAUTH_REDIRECT_URI = `https://${OAUTH_CONSOLE_HOST}/oauth/code/callback`;
    OAUTH_TOKEN_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/token`;
    OAUTH_REVOKE_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/revoke`;
    OAUTH_AXIOS_VERSION = "1.13.6";
    OAUTH_USER_AGENT = `axios/${OAUTH_AXIOS_VERSION}`;
    OAUTH_ACCEPT = "application/json, text/plain, */*";
    OAUTH_MAX_RETRIES = 2;
    OAUTH_MAX_RETRY_DELAY_MS = 3e4;
    OAUTH_RATE_LIMIT_COOLDOWN_MS = 3e4;
    OAUTH_RETRY_AFTER_SOURCE_HEADER_MS = "retry-after-ms";
    OAUTH_RETRY_AFTER_SOURCE_HEADER = "retry-after";
    OAUTH_RETRY_AFTER_SOURCE_FALLBACK_429 = "fallback-429";
    CLAUDE_AI_SCOPES = [
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload"
    ];
    CONSOLE_SCOPES = ["org:create_api_key", "user:profile"];
  }
});

// cli.mjs
var cli_exports = {};
__export(cli_exports, {
  cmdConfig: () => cmdConfig,
  cmdDisable: () => cmdDisable,
  cmdEnable: () => cmdEnable,
  cmdHelp: () => cmdHelp,
  cmdList: () => cmdList,
  cmdLogin: () => cmdLogin,
  cmdLogout: () => cmdLogout,
  cmdManage: () => cmdManage,
  cmdReauth: () => cmdReauth,
  cmdRefresh: () => cmdRefresh,
  cmdRemove: () => cmdRemove,
  cmdReset: () => cmdReset,
  cmdResetStats: () => cmdResetStats,
  cmdStats: () => cmdStats,
  cmdStatus: () => cmdStatus,
  cmdStrategy: () => cmdStrategy,
  cmdSwitch: () => cmdSwitch,
  ensureTokenAndFetchUsage: () => ensureTokenAndFetchUsage,
  fetchUsage: () => fetchUsage,
  formatDuration: () => formatDuration,
  formatResetTime: () => formatResetTime,
  formatTimeAgo: () => formatTimeAgo,
  main: () => main,
  refreshAccessToken: () => refreshAccessToken,
  renderBar: () => renderBar,
  renderUsageLines: () => renderUsageLines
});
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { exec } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
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
var USE_COLOR, ansi, c, QUOTA_BUCKETS, USAGE_INDENT, USAGE_LABEL_WIDTH, ioContext, nativeConsoleLog, nativeConsoleError, consoleRouterUsers;
var init_cli = __esm({
  async "cli.mjs"() {
    init_storage();
    init_config();
    init_oauth();
    USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
    ansi = (code, text) => USE_COLOR ? `\x1B[${code}m${text}\x1B[0m` : text;
    c = {
      bold: (t2) => ansi("1", t2),
      dim: (t2) => ansi("2", t2),
      green: (t2) => ansi("32", t2),
      yellow: (t2) => ansi("33", t2),
      cyan: (t2) => ansi("36", t2),
      red: (t2) => ansi("31", t2),
      gray: (t2) => ansi("90", t2)
    };
    QUOTA_BUCKETS = [
      { key: "five_hour", label: "5h" },
      { key: "seven_day", label: "7d" },
      { key: "seven_day_sonnet", label: "Sonnet 7d" },
      { key: "seven_day_opus", label: "Opus 7d" },
      { key: "seven_day_oauth_apps", label: "OAuth Apps 7d" },
      { key: "seven_day_cowork", label: "Cowork 7d" }
    ];
    USAGE_INDENT = "       ";
    USAGE_LABEL_WIDTH = 13;
    ioContext = new AsyncLocalStorage();
    nativeConsoleLog = console.log.bind(console);
    nativeConsoleError = console.error.bind(console);
    consoleRouterUsers = 0;
    if (await detectMain()) {
      main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
        console.error(c.red(`Fatal: ${err.message}`));
        process.exit(1);
      });
    }
  }
});

// index.mjs
import { createInterface as createInterface2 } from "node:readline/promises";
import { stdin as stdin2, stdout as stdout2 } from "node:process";
import { randomBytes as randomBytes5, randomUUID, createHash as createHashCrypto } from "node:crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync3, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join6, resolve, basename } from "node:path";

// node_modules/xxhash-wasm/esm/xxhash-wasm.js
var t = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 48, 8, 96, 3, 127, 127, 127, 1, 127, 96, 3, 127, 127, 127, 0, 96, 2, 127, 127, 0, 96, 1, 127, 1, 127, 96, 3, 127, 127, 126, 1, 126, 96, 3, 126, 127, 127, 1, 126, 96, 2, 127, 126, 0, 96, 1, 127, 1, 126, 3, 11, 10, 0, 0, 2, 1, 3, 4, 5, 6, 1, 7, 5, 3, 1, 0, 1, 7, 85, 9, 3, 109, 101, 109, 2, 0, 5, 120, 120, 104, 51, 50, 0, 0, 6, 105, 110, 105, 116, 51, 50, 0, 2, 8, 117, 112, 100, 97, 116, 101, 51, 50, 0, 3, 8, 100, 105, 103, 101, 115, 116, 51, 50, 0, 4, 5, 120, 120, 104, 54, 52, 0, 5, 6, 105, 110, 105, 116, 54, 52, 0, 7, 8, 117, 112, 100, 97, 116, 101, 54, 52, 0, 8, 8, 100, 105, 103, 101, 115, 116, 54, 52, 0, 9, 10, 251, 22, 10, 242, 1, 1, 4, 127, 32, 0, 32, 1, 106, 33, 3, 32, 1, 65, 16, 79, 4, 127, 32, 3, 65, 16, 107, 33, 6, 32, 2, 65, 168, 136, 141, 161, 2, 106, 33, 3, 32, 2, 65, 137, 235, 208, 208, 7, 107, 33, 4, 32, 2, 65, 207, 140, 162, 142, 6, 106, 33, 5, 3, 64, 32, 3, 32, 0, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 3, 32, 4, 32, 0, 65, 4, 106, 34, 0, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 4, 32, 2, 32, 0, 65, 4, 106, 34, 0, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 2, 32, 5, 32, 0, 65, 4, 106, 34, 0, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 5, 32, 6, 32, 0, 65, 4, 106, 34, 0, 79, 13, 0, 11, 32, 2, 65, 12, 119, 32, 5, 65, 18, 119, 106, 32, 4, 65, 7, 119, 106, 32, 3, 65, 1, 119, 106, 5, 32, 2, 65, 177, 207, 217, 178, 1, 106, 11, 32, 1, 106, 32, 0, 32, 1, 65, 15, 113, 16, 1, 11, 146, 1, 0, 32, 1, 32, 2, 106, 33, 2, 3, 64, 32, 1, 65, 4, 106, 32, 2, 75, 69, 4, 64, 32, 0, 32, 1, 40, 2, 0, 65, 189, 220, 202, 149, 124, 108, 106, 65, 17, 119, 65, 175, 214, 211, 190, 2, 108, 33, 0, 32, 1, 65, 4, 106, 33, 1, 12, 1, 11, 11, 3, 64, 32, 1, 32, 2, 79, 69, 4, 64, 32, 0, 32, 1, 45, 0, 0, 65, 177, 207, 217, 178, 1, 108, 106, 65, 11, 119, 65, 177, 243, 221, 241, 121, 108, 33, 0, 32, 1, 65, 1, 106, 33, 1, 12, 1, 11, 11, 32, 0, 32, 0, 65, 15, 118, 115, 65, 247, 148, 175, 175, 120, 108, 34, 0, 65, 13, 118, 32, 0, 115, 65, 189, 220, 202, 149, 124, 108, 34, 0, 65, 16, 118, 32, 0, 115, 11, 63, 0, 32, 0, 65, 8, 106, 32, 1, 65, 168, 136, 141, 161, 2, 106, 54, 2, 0, 32, 0, 65, 12, 106, 32, 1, 65, 137, 235, 208, 208, 7, 107, 54, 2, 0, 32, 0, 65, 16, 106, 32, 1, 54, 2, 0, 32, 0, 65, 20, 106, 32, 1, 65, 207, 140, 162, 142, 6, 106, 54, 2, 0, 11, 195, 4, 1, 6, 127, 32, 1, 32, 2, 106, 33, 6, 32, 0, 65, 24, 106, 33, 4, 32, 0, 65, 40, 106, 40, 2, 0, 33, 3, 32, 0, 32, 0, 40, 2, 0, 32, 2, 106, 54, 2, 0, 32, 0, 65, 4, 106, 34, 5, 32, 5, 40, 2, 0, 32, 2, 65, 16, 79, 32, 0, 40, 2, 0, 65, 16, 79, 114, 114, 54, 2, 0, 32, 2, 32, 3, 106, 65, 16, 73, 4, 64, 32, 3, 32, 4, 106, 32, 1, 32, 2, 252, 10, 0, 0, 32, 0, 65, 40, 106, 32, 2, 32, 3, 106, 54, 2, 0, 15, 11, 32, 3, 4, 64, 32, 3, 32, 4, 106, 32, 1, 65, 16, 32, 3, 107, 34, 2, 252, 10, 0, 0, 32, 0, 65, 8, 106, 34, 3, 32, 3, 40, 2, 0, 32, 4, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 54, 2, 0, 32, 0, 65, 12, 106, 34, 3, 32, 3, 40, 2, 0, 32, 4, 65, 4, 106, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 54, 2, 0, 32, 0, 65, 16, 106, 34, 3, 32, 3, 40, 2, 0, 32, 4, 65, 8, 106, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 54, 2, 0, 32, 0, 65, 20, 106, 34, 3, 32, 3, 40, 2, 0, 32, 4, 65, 12, 106, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 54, 2, 0, 32, 0, 65, 40, 106, 65, 0, 54, 2, 0, 32, 1, 32, 2, 106, 33, 1, 11, 32, 1, 32, 6, 65, 16, 107, 77, 4, 64, 32, 6, 65, 16, 107, 33, 8, 32, 0, 65, 8, 106, 40, 2, 0, 33, 2, 32, 0, 65, 12, 106, 40, 2, 0, 33, 3, 32, 0, 65, 16, 106, 40, 2, 0, 33, 5, 32, 0, 65, 20, 106, 40, 2, 0, 33, 7, 3, 64, 32, 2, 32, 1, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 2, 32, 3, 32, 1, 65, 4, 106, 34, 1, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 3, 32, 5, 32, 1, 65, 4, 106, 34, 1, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 5, 32, 7, 32, 1, 65, 4, 106, 34, 1, 40, 2, 0, 65, 247, 148, 175, 175, 120, 108, 106, 65, 13, 119, 65, 177, 243, 221, 241, 121, 108, 33, 7, 32, 8, 32, 1, 65, 4, 106, 34, 1, 79, 13, 0, 11, 32, 0, 65, 8, 106, 32, 2, 54, 2, 0, 32, 0, 65, 12, 106, 32, 3, 54, 2, 0, 32, 0, 65, 16, 106, 32, 5, 54, 2, 0, 32, 0, 65, 20, 106, 32, 7, 54, 2, 0, 11, 32, 1, 32, 6, 73, 4, 64, 32, 4, 32, 1, 32, 6, 32, 1, 107, 34, 1, 252, 10, 0, 0, 32, 0, 65, 40, 106, 32, 1, 54, 2, 0, 11, 11, 97, 1, 1, 127, 32, 0, 65, 16, 106, 40, 2, 0, 33, 1, 32, 0, 65, 4, 106, 40, 2, 0, 4, 127, 32, 1, 65, 12, 119, 32, 0, 65, 20, 106, 40, 2, 0, 65, 18, 119, 106, 32, 0, 65, 12, 106, 40, 2, 0, 65, 7, 119, 106, 32, 0, 65, 8, 106, 40, 2, 0, 65, 1, 119, 106, 5, 32, 1, 65, 177, 207, 217, 178, 1, 106, 11, 32, 0, 40, 2, 0, 106, 32, 0, 65, 24, 106, 32, 0, 65, 40, 106, 40, 2, 0, 16, 1, 11, 255, 3, 2, 3, 126, 1, 127, 32, 0, 32, 1, 106, 33, 6, 32, 1, 65, 32, 79, 4, 126, 32, 6, 65, 32, 107, 33, 6, 32, 2, 66, 214, 235, 130, 238, 234, 253, 137, 245, 224, 0, 124, 33, 3, 32, 2, 66, 177, 169, 172, 193, 173, 184, 212, 166, 61, 125, 33, 4, 32, 2, 66, 249, 234, 208, 208, 231, 201, 161, 228, 225, 0, 124, 33, 5, 3, 64, 32, 3, 32, 0, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 3, 32, 4, 32, 0, 65, 8, 106, 34, 0, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 4, 32, 2, 32, 0, 65, 8, 106, 34, 0, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 2, 32, 5, 32, 0, 65, 8, 106, 34, 0, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 5, 32, 6, 32, 0, 65, 8, 106, 34, 0, 79, 13, 0, 11, 32, 2, 66, 12, 137, 32, 5, 66, 18, 137, 124, 32, 4, 66, 7, 137, 124, 32, 3, 66, 1, 137, 124, 32, 3, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 32, 4, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 32, 2, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 32, 5, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 5, 32, 2, 66, 197, 207, 217, 178, 241, 229, 186, 234, 39, 124, 11, 32, 1, 173, 124, 32, 0, 32, 1, 65, 31, 113, 16, 6, 11, 134, 2, 0, 32, 1, 32, 2, 106, 33, 2, 3, 64, 32, 2, 32, 1, 65, 8, 106, 79, 4, 64, 32, 1, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 32, 0, 133, 66, 27, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 33, 0, 32, 1, 65, 8, 106, 33, 1, 12, 1, 11, 11, 32, 1, 65, 4, 106, 32, 2, 77, 4, 64, 32, 0, 32, 1, 53, 2, 0, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 23, 137, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 249, 243, 221, 241, 153, 246, 153, 171, 22, 124, 33, 0, 32, 1, 65, 4, 106, 33, 1, 11, 3, 64, 32, 1, 32, 2, 73, 4, 64, 32, 0, 32, 1, 49, 0, 0, 66, 197, 207, 217, 178, 241, 229, 186, 234, 39, 126, 133, 66, 11, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 0, 32, 1, 65, 1, 106, 33, 1, 12, 1, 11, 11, 32, 0, 32, 0, 66, 33, 136, 133, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 34, 0, 32, 0, 66, 29, 136, 133, 66, 249, 243, 221, 241, 153, 246, 153, 171, 22, 126, 34, 0, 32, 0, 66, 32, 136, 133, 11, 77, 0, 32, 0, 65, 8, 106, 32, 1, 66, 214, 235, 130, 238, 234, 253, 137, 245, 224, 0, 124, 55, 3, 0, 32, 0, 65, 16, 106, 32, 1, 66, 177, 169, 172, 193, 173, 184, 212, 166, 61, 125, 55, 3, 0, 32, 0, 65, 24, 106, 32, 1, 55, 3, 0, 32, 0, 65, 32, 106, 32, 1, 66, 249, 234, 208, 208, 231, 201, 161, 228, 225, 0, 124, 55, 3, 0, 11, 244, 4, 2, 3, 127, 4, 126, 32, 1, 32, 2, 106, 33, 5, 32, 0, 65, 40, 106, 33, 4, 32, 0, 65, 200, 0, 106, 40, 2, 0, 33, 3, 32, 0, 32, 0, 41, 3, 0, 32, 2, 173, 124, 55, 3, 0, 32, 2, 32, 3, 106, 65, 32, 73, 4, 64, 32, 3, 32, 4, 106, 32, 1, 32, 2, 252, 10, 0, 0, 32, 0, 65, 200, 0, 106, 32, 2, 32, 3, 106, 54, 2, 0, 15, 11, 32, 3, 4, 64, 32, 3, 32, 4, 106, 32, 1, 65, 32, 32, 3, 107, 34, 2, 252, 10, 0, 0, 32, 0, 65, 8, 106, 34, 3, 32, 3, 41, 3, 0, 32, 4, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 55, 3, 0, 32, 0, 65, 16, 106, 34, 3, 32, 3, 41, 3, 0, 32, 4, 65, 8, 106, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 55, 3, 0, 32, 0, 65, 24, 106, 34, 3, 32, 3, 41, 3, 0, 32, 4, 65, 16, 106, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 55, 3, 0, 32, 0, 65, 32, 106, 34, 3, 32, 3, 41, 3, 0, 32, 4, 65, 24, 106, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 55, 3, 0, 32, 0, 65, 200, 0, 106, 65, 0, 54, 2, 0, 32, 1, 32, 2, 106, 33, 1, 11, 32, 1, 65, 32, 106, 32, 5, 77, 4, 64, 32, 5, 65, 32, 107, 33, 2, 32, 0, 65, 8, 106, 41, 3, 0, 33, 6, 32, 0, 65, 16, 106, 41, 3, 0, 33, 7, 32, 0, 65, 24, 106, 41, 3, 0, 33, 8, 32, 0, 65, 32, 106, 41, 3, 0, 33, 9, 3, 64, 32, 6, 32, 1, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 6, 32, 7, 32, 1, 65, 8, 106, 34, 1, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 7, 32, 8, 32, 1, 65, 8, 106, 34, 1, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 8, 32, 9, 32, 1, 65, 8, 106, 34, 1, 41, 3, 0, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 124, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 33, 9, 32, 2, 32, 1, 65, 8, 106, 34, 1, 79, 13, 0, 11, 32, 0, 65, 8, 106, 32, 6, 55, 3, 0, 32, 0, 65, 16, 106, 32, 7, 55, 3, 0, 32, 0, 65, 24, 106, 32, 8, 55, 3, 0, 32, 0, 65, 32, 106, 32, 9, 55, 3, 0, 11, 32, 1, 32, 5, 73, 4, 64, 32, 4, 32, 1, 32, 5, 32, 1, 107, 34, 1, 252, 10, 0, 0, 32, 0, 65, 200, 0, 106, 32, 1, 54, 2, 0, 11, 11, 188, 2, 1, 5, 126, 32, 0, 65, 24, 106, 41, 3, 0, 33, 1, 32, 0, 41, 3, 0, 34, 2, 66, 32, 90, 4, 126, 32, 0, 65, 8, 106, 41, 3, 0, 34, 3, 66, 1, 137, 32, 0, 65, 16, 106, 41, 3, 0, 34, 4, 66, 7, 137, 124, 32, 1, 66, 12, 137, 32, 0, 65, 32, 106, 41, 3, 0, 34, 5, 66, 18, 137, 124, 124, 32, 3, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 32, 4, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 32, 1, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 32, 5, 66, 207, 214, 211, 190, 210, 199, 171, 217, 66, 126, 66, 31, 137, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 133, 66, 135, 149, 175, 175, 152, 182, 222, 155, 158, 127, 126, 66, 157, 163, 181, 234, 131, 177, 141, 138, 250, 0, 125, 5, 32, 1, 66, 197, 207, 217, 178, 241, 229, 186, 234, 39, 124, 11, 32, 2, 124, 32, 0, 65, 40, 106, 32, 2, 66, 31, 131, 167, 16, 6, 11]);
async function e() {
  return (function(t2) {
    const { exports: { mem: e2, xxh32: n, xxh64: r, init32: i, update32: a, digest32: o, init64: s, update64: u, digest64: c2 } } = t2;
    let h = new Uint8Array(e2.buffer);
    function g(t3, n2) {
      if (e2.buffer.byteLength < t3 + n2) {
        const r2 = Math.ceil((t3 + n2 - e2.buffer.byteLength) / 65536);
        e2.grow(r2), h = new Uint8Array(e2.buffer);
      }
    }
    function f(t3, e3, n2, r2, i2, a2) {
      g(t3);
      const o2 = new Uint8Array(t3);
      return h.set(o2), n2(0, e3), o2.set(h.subarray(0, t3)), { update(e4) {
        let n3;
        return h.set(o2), "string" == typeof e4 ? (g(3 * e4.length, t3), n3 = w.encodeInto(e4, h.subarray(t3)).written) : (g(e4.byteLength, t3), h.set(e4, t3), n3 = e4.byteLength), r2(0, t3, n3), o2.set(h.subarray(0, t3)), this;
      }, digest: () => (h.set(o2), a2(i2(0))) };
    }
    function y(t3) {
      return t3 >>> 0;
    }
    const b = 2n ** 64n - 1n;
    function d(t3) {
      return t3 & b;
    }
    const w = new TextEncoder(), l = 0, p = 0n;
    function x(t3, e3 = l) {
      return g(3 * t3.length, 0), y(n(0, w.encodeInto(t3, h).written, e3));
    }
    function L(t3, e3 = p) {
      return g(3 * t3.length, 0), d(r(0, w.encodeInto(t3, h).written, e3));
    }
    return { h32: x, h32ToString: (t3, e3 = l) => x(t3, e3).toString(16).padStart(8, "0"), h32Raw: (t3, e3 = l) => (g(t3.byteLength, 0), h.set(t3), y(n(0, t3.byteLength, e3))), create32: (t3 = l) => f(48, t3, i, a, o, y), h64: L, h64ToString: (t3, e3 = p) => L(t3, e3).toString(16).padStart(16, "0"), h64Raw: (t3, e3 = p) => (g(t3.byteLength, 0), h.set(t3), d(r(0, t3.byteLength, e3))), create64: (t3 = p) => f(88, t3, s, u, c2, d) };
  })((await WebAssembly.instantiate(t)).instance);
}

// lib/accounts.mjs
init_storage();
import { createHash as createHash2 } from "node:crypto";

// lib/rotation.mjs
init_config();
var HealthScoreTracker = class {
  /** @type {Map<number, {score: number, lastUpdated: number, consecutiveFailures: number}>} */
  #scores = /* @__PURE__ */ new Map();
  /** @type {HealthScoreConfig} */
  #config;
  /**
   * @param {Partial<HealthScoreConfig>} [config]
   */
  constructor(config = {}) {
    this.#config = { ...DEFAULT_CONFIG.health_score, ...config };
  }
  /**
   * Get the current health score for an account, including passive recovery.
   * @param {number} accountIndex
   * @returns {number}
   */
  getScore(accountIndex) {
    const state = this.#scores.get(accountIndex);
    if (!state) return this.#config.initial;
    const hoursSinceUpdate = (Date.now() - state.lastUpdated) / (1e3 * 60 * 60);
    const recoveredPoints = Math.floor(hoursSinceUpdate * this.#config.recovery_rate_per_hour);
    return Math.min(this.#config.max_score, state.score + recoveredPoints);
  }
  /**
   * Record a successful request.
   * @param {number} accountIndex
   */
  recordSuccess(accountIndex) {
    const current = this.getScore(accountIndex);
    this.#scores.set(accountIndex, {
      score: Math.min(this.#config.max_score, current + this.#config.success_reward),
      lastUpdated: Date.now(),
      consecutiveFailures: 0
    });
  }
  /**
   * Record a rate limit event.
   * @param {number} accountIndex
   */
  recordRateLimit(accountIndex) {
    const current = this.getScore(accountIndex);
    const state = this.#scores.get(accountIndex);
    this.#scores.set(accountIndex, {
      score: Math.max(0, current + this.#config.rate_limit_penalty),
      lastUpdated: Date.now(),
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1
    });
  }
  /**
   * Apply a direct penalty to an account's health score.
   * @param {number} accountIndex
   * @param {number} penalty - Points to deduct
   */
  applyPenalty(accountIndex, penalty) {
    const state = this.#scores.get(accountIndex);
    if (!state) {
      this.#scores.set(accountIndex, {
        score: Math.max(0, this.#config.initial - penalty),
        lastUpdated: Date.now(),
        consecutiveFailures: 0
      });
    } else {
      state.score = Math.max(0, this.getScore(accountIndex) - penalty);
      state.lastUpdated = Date.now();
    }
  }
  /**
   * Record a general failure.
   * @param {number} accountIndex
   */
  recordFailure(accountIndex) {
    const current = this.getScore(accountIndex);
    const state = this.#scores.get(accountIndex);
    this.#scores.set(accountIndex, {
      score: Math.max(0, current + this.#config.failure_penalty),
      lastUpdated: Date.now(),
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1
    });
  }
  /**
   * Check if an account is usable (score above minimum).
   * @param {number} accountIndex
   * @returns {boolean}
   */
  isUsable(accountIndex) {
    return this.getScore(accountIndex) >= this.#config.min_usable;
  }
  /**
   * Reset tracking for an account.
   * @param {number} accountIndex
   */
  reset(accountIndex) {
    this.#scores.delete(accountIndex);
  }
};
var TokenBucketTracker = class {
  /** @type {Map<number, {tokens: number, lastUpdated: number}>} */
  #buckets = /* @__PURE__ */ new Map();
  /** @type {TokenBucketConfig} */
  #config;
  /**
   * @param {Partial<TokenBucketConfig>} [config]
   */
  constructor(config = {}) {
    this.#config = { ...DEFAULT_CONFIG.token_bucket, ...config };
  }
  /**
   * Get current token count for an account, including regeneration.
   * @param {number} accountIndex
   * @returns {number}
   */
  getTokens(accountIndex) {
    const state = this.#buckets.get(accountIndex);
    if (!state) return this.#config.initial_tokens;
    const minutesSinceUpdate = (Date.now() - state.lastUpdated) / (1e3 * 60);
    const recoveredTokens = minutesSinceUpdate * this.#config.regeneration_rate_per_minute;
    return Math.min(this.#config.max_tokens, state.tokens + recoveredTokens);
  }
  /**
   * Check if an account has enough tokens.
   * @param {number} accountIndex
   * @param {number} [cost=1]
   * @returns {boolean}
   */
  hasTokens(accountIndex, cost = 1) {
    return this.getTokens(accountIndex) >= cost;
  }
  /**
   * Consume tokens for a request.
   * @param {number} accountIndex
   * @param {number} [cost=1]
   * @returns {boolean} Whether tokens were available and consumed
   */
  consume(accountIndex, cost = 1) {
    const current = this.getTokens(accountIndex);
    if (current < cost) return false;
    this.#buckets.set(accountIndex, {
      tokens: current - cost,
      lastUpdated: Date.now()
    });
    return true;
  }
  /**
   * Refund tokens (e.g., on non-rate-limit failure).
   * @param {number} accountIndex
   * @param {number} [amount=1]
   */
  refund(accountIndex, amount = 1) {
    const current = this.getTokens(accountIndex);
    this.#buckets.set(accountIndex, {
      tokens: Math.min(this.#config.max_tokens, current + amount),
      lastUpdated: Date.now()
    });
  }
  /**
   * Get the max tokens value (for scoring calculations).
   * @returns {number}
   */
  getMaxTokens() {
    return this.#config.max_tokens;
  }
};
var STICKINESS_BONUS = 150;
var SWITCH_THRESHOLD = 100;
function calculateHybridScore(account, maxTokens) {
  const healthComponent = account.healthScore * 2;
  const tokenComponent = account.tokens / maxTokens * 100 * 5;
  const secondsSinceUsed = account.lastUsed > 0 ? (Date.now() - account.lastUsed) / 1e3 : 3600;
  const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1;
  return Math.max(0, healthComponent + tokenComponent + freshnessComponent);
}
function selectAccount(candidates, strategy, currentIndex, healthTracker, tokenTracker, cursor) {
  const available = candidates.filter((acc) => acc.enabled && !acc.isRateLimited);
  if (available.length === 0) return null;
  switch (strategy) {
    case "sticky": {
      if (currentIndex !== null) {
        const current = available.find((acc) => acc.index === currentIndex);
        if (current) {
          return { index: current.index, cursor };
        }
      }
      const next = available[cursor % available.length];
      return next ? { index: next.index, cursor: cursor + 1 } : null;
    }
    case "round-robin": {
      const next = available[cursor % available.length];
      return next ? { index: next.index, cursor: cursor + 1 } : null;
    }
    case "hybrid": {
      const scoredCandidates = available.filter((acc) => healthTracker.isUsable(acc.index) && tokenTracker.hasTokens(acc.index)).map((acc) => ({
        ...acc,
        tokens: tokenTracker.getTokens(acc.index)
      }));
      if (scoredCandidates.length === 0) {
        const fallback = available[0];
        return fallback ? { index: fallback.index, cursor } : null;
      }
      const maxTokens = tokenTracker.getMaxTokens();
      const scored = scoredCandidates.map((acc) => {
        const baseScore = calculateHybridScore(acc, maxTokens);
        const stickinessBonus = acc.index === currentIndex ? STICKINESS_BONUS : 0;
        return {
          index: acc.index,
          baseScore,
          score: baseScore + stickinessBonus,
          isCurrent: acc.index === currentIndex
        };
      }).sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best) return null;
      const currentCandidate = scored.find((s) => s.isCurrent);
      if (currentCandidate && !best.isCurrent) {
        const advantage = best.baseScore - currentCandidate.baseScore;
        if (advantage < SWITCH_THRESHOLD) {
          return { index: currentCandidate.index, cursor };
        }
      }
      return { index: best.index, cursor };
    }
    default:
      return available[0] ? { index: available[0].index, cursor } : null;
  }
}

// lib/accounts.mjs
init_backoff();
init_cc_credentials();
function hashTokenFragment(token) {
  return createHash2("sha256").update(token).digest("hex").slice(0, 12);
}
var MAX_ACCOUNTS = 10;
var RATE_LIMIT_KEY = "anthropic";
var AccountManager = class _AccountManager {
  /** @type {ManagedAccount[]} */
  #accounts = [];
  /** @type {number} */
  #cursor = 0;
  /** @type {number} */
  #currentIndex = -1;
  /** @type {HealthScoreTracker} */
  #healthTracker;
  /** @type {TokenBucketTracker} */
  #tokenTracker;
  /** @type {AnthropicAuthConfig} */
  #config;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #saveTimeout = null;
  /**
   * Pending stats deltas per account id, merged into disk values on save.
   * @type {Map<string, StatsDelta>}
   */
  #statsDeltas = /* @__PURE__ */ new Map();
  /**
   * @param {AnthropicAuthConfig} config
   */
  constructor(config) {
    this.#config = config;
    this.#healthTracker = new HealthScoreTracker(config.health_score);
    this.#tokenTracker = new TokenBucketTracker(config.token_bucket);
  }
  /**
   * Load accounts from disk, optionally merging with an OpenCode auth fallback.
   * @param {AnthropicAuthConfig} config
   * @param {{refresh: string, access?: string, expires?: number} | null} [authFallback]
   * @returns {Promise<AccountManager>}
   */
  static async load(config, authFallback) {
    const manager = new _AccountManager(config);
    const stored = await loadAccounts();
    if (stored) {
      manager.#accounts = stored.accounts.map((acc, index) => ({
        id: acc.id || `${acc.addedAt}:${hashTokenFragment(acc.refreshToken)}`,
        index,
        email: acc.email,
        accountUuid: acc.accountUuid,
        organizationUuid: acc.organizationUuid,
        refreshToken: acc.refreshToken,
        access: acc.access,
        expires: acc.expires,
        tokenUpdatedAt: acc.token_updated_at,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        enabled: acc.enabled,
        rateLimitResetTimes: acc.rateLimitResetTimes,
        consecutiveFailures: acc.consecutiveFailures,
        lastFailureTime: acc.lastFailureTime,
        lastSwitchReason: acc.lastSwitchReason,
        stats: acc.stats ?? createDefaultStats(acc.addedAt),
        source: acc.source || "oauth"
      }));
      manager.#currentIndex = manager.#accounts.length > 0 ? Math.min(stored.activeIndex, manager.#accounts.length - 1) : -1;
      if (authFallback && manager.#accounts.length > 0) {
        const match = manager.#accounts.find((acc) => acc.refreshToken === authFallback.refresh);
        if (match) {
          const fallbackHasAccess = typeof authFallback.access === "string" && authFallback.access.length > 0;
          const fallbackExpires = typeof authFallback.expires === "number" ? authFallback.expires : 0;
          const matchExpires = typeof match.expires === "number" ? match.expires : 0;
          const fallbackLooksFresh = fallbackHasAccess && fallbackExpires > Date.now();
          const shouldAdoptFallback = fallbackLooksFresh && (!match.access || !match.expires || fallbackExpires > matchExpires);
          if (shouldAdoptFallback) {
            match.access = authFallback.access;
            match.expires = authFallback.expires;
            match.tokenUpdatedAt = Math.max(match.tokenUpdatedAt || 0, fallbackExpires);
          }
        }
      }
      manager.#mergeCC(config);
      return manager;
    }
    if (authFallback && authFallback.refresh) {
      const now = Date.now();
      manager.#accounts = [
        {
          id: `${now}:${hashTokenFragment(authFallback.refresh)}`,
          index: 0,
          email: void 0,
          refreshToken: authFallback.refresh,
          access: authFallback.access,
          expires: authFallback.expires,
          tokenUpdatedAt: now,
          addedAt: now,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
          lastSwitchReason: "initial",
          stats: createDefaultStats(now),
          source: "oauth"
        }
      ];
      manager.#currentIndex = 0;
    }
    manager.#mergeCC(config);
    return manager;
  }
  /**
   * Merge Claude Code credentials into the account pool.
   * CC accounts are matched by refreshToken to avoid duplicates.
   *
   * @param {AnthropicAuthConfig} config
   */
  #mergeCC(config) {
    if (!config.cc_credential_reuse?.enabled || !config.cc_credential_reuse?.auto_detect) return;
    let ccCreds;
    try {
      ccCreds = readCCCredentials();
    } catch {
      return;
    }
    if (!ccCreds.length) return;
    for (const cc of ccCreds) {
      const existing = this.#accounts.find((a) => a.refreshToken === cc.refreshToken);
      if (existing) {
        if (cc.expiresAt > (existing.expires || 0)) {
          existing.access = cc.accessToken;
          existing.expires = cc.expiresAt;
          existing.tokenUpdatedAt = Date.now();
        }
        if (!existing.source || existing.source === "oauth") {
          existing.source = cc.source;
        }
        continue;
      }
      if (this.#accounts.length >= MAX_ACCOUNTS) break;
      const now = Date.now();
      const account = {
        id: `cc:${now}:${hashTokenFragment(cc.refreshToken)}`,
        index: this.#accounts.length,
        email: void 0,
        refreshToken: cc.refreshToken,
        access: cc.accessToken,
        expires: cc.expiresAt,
        tokenUpdatedAt: now,
        addedAt: now,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        lastSwitchReason: "cc-auto-detect",
        stats: createDefaultStats(now),
        source: cc.source
      };
      if (config.cc_credential_reuse.prefer_over_oauth) {
        this.#accounts.unshift(account);
        this.#accounts.forEach((a, i) => {
          a.index = i;
        });
        if (this.#currentIndex >= 0) this.#currentIndex++;
      } else {
        this.#accounts.push(account);
      }
      if (this.#accounts.length === 1) {
        this.#currentIndex = 0;
      }
    }
  }
  /**
   * Get the number of enabled accounts.
   * @returns {number}
   */
  getAccountCount() {
    return this.#accounts.filter((acc) => acc.enabled).length;
  }
  /**
   * Get the total number of accounts (including disabled).
   * @returns {number}
   */
  getTotalAccountCount() {
    return this.#accounts.length;
  }
  /**
   * Get a snapshot of all accounts (for display/management).
   * @returns {ManagedAccount[]}
   */
  getAccountsSnapshot() {
    return this.#accounts.map((acc) => ({ ...acc }));
  }
  /**
   * Get the current active account index.
   * @returns {number}
   */
  getCurrentIndex() {
    return this.#currentIndex;
  }
  /**
   * Get the health score for a specific account.
   * @param {number} accountIndex
   * @returns {number}
   */
  getHealthScore(accountIndex) {
    return this.#healthTracker.getScore(accountIndex);
  }
  /**
   * Force the active account to a specific index.
   * Used by OPENCODE_ANTHROPIC_INITIAL_ACCOUNT to pin a session to one account.
   * @param {number} index
   * @returns {boolean} Whether the index was valid and set
   */
  forceCurrentIndex(index) {
    const account = this.#accounts[index];
    if (!account || !account.enabled) return false;
    this.#currentIndex = index;
    this.#cursor = index;
    return true;
  }
  /**
   * Peek at the next account that would be selected without actually switching.
   * Used for predictive rate limit avoidance messaging.
   * @returns {ManagedAccount | null}
   */
  peekNextAccount() {
    const enabled = this.#accounts.filter((acc) => acc.enabled && acc.index !== this.#currentIndex);
    if (enabled.length === 0) return null;
    return enabled[0] ?? null;
  }
  /**
   * Get enabled account references for internal plugin operations.
   * Returned objects are mutable managed accounts.
   * @param {Set<number>} [excludedIndices]
   * @returns {ManagedAccount[]}
   */
  getEnabledAccounts(excludedIndices) {
    return this.#accounts.filter((acc) => acc.enabled && !excludedIndices?.has(acc.index));
  }
  /**
   * Clear expired rate limits for an account.
   * @param {ManagedAccount} account
   */
  #clearExpiredRateLimits(account) {
    const now = Date.now();
    for (const key of Object.keys(account.rateLimitResetTimes)) {
      if (account.rateLimitResetTimes[key] <= now) {
        delete account.rateLimitResetTimes[key];
      }
    }
  }
  /**
   * Check if an account is currently rate-limited.
   * @param {ManagedAccount} account
   * @returns {boolean}
   */
  #isRateLimited(account) {
    this.#clearExpiredRateLimits(account);
    const resetTime = account.rateLimitResetTimes[RATE_LIMIT_KEY];
    return resetTime !== void 0 && Date.now() < resetTime;
  }
  /**
   * Select the best account for the current request.
   * @param {Set<number>} [excludedIndices] - Temporary per-request exclusions
   * @returns {ManagedAccount | null}
   */
  getCurrentAccount(excludedIndices) {
    if (this.#accounts.length === 0) return null;
    const candidates = this.#accounts.filter((acc) => acc.enabled && !excludedIndices?.has(acc.index)).map((acc) => {
      this.#clearExpiredRateLimits(acc);
      return {
        index: acc.index,
        lastUsed: acc.lastUsed,
        healthScore: this.#healthTracker.getScore(acc.index),
        isRateLimited: this.#isRateLimited(acc),
        enabled: acc.enabled
      };
    });
    const result = selectAccount(
      candidates,
      this.#config.account_selection_strategy,
      this.#currentIndex >= 0 ? this.#currentIndex : null,
      this.#healthTracker,
      this.#tokenTracker,
      this.#cursor
    );
    if (!result) return null;
    this.#cursor = result.cursor;
    this.#currentIndex = result.index;
    const account = this.#accounts[result.index];
    if (account) {
      account.lastUsed = Date.now();
      this.#tokenTracker.consume(account.index);
    }
    return account ?? null;
  }
  /**
   * Mark an account as rate-limited.
   * @param {ManagedAccount} account
   * @param {RateLimitReason} reason
   * @param {number | null} [retryAfterMs]
   * @returns {number} The backoff duration in ms
   */
  markRateLimited(account, reason, retryAfterMs) {
    const now = Date.now();
    if (account.lastFailureTime !== null && now - account.lastFailureTime > this.#config.failure_ttl_seconds * 1e3) {
      account.consecutiveFailures = 0;
    }
    account.consecutiveFailures += 1;
    account.lastFailureTime = now;
    const backoffMs = calculateBackoffMs(reason, account.consecutiveFailures - 1, retryAfterMs);
    account.rateLimitResetTimes[RATE_LIMIT_KEY] = now + backoffMs;
    this.#healthTracker.recordRateLimit(account.index);
    this.requestSaveToDisk();
    return backoffMs;
  }
  /**
   * Mark an account for preemptive switching (quota burn rate high, but request succeeded).
   * Unlike markRateLimited, this does NOT increment consecutiveFailures or record a health penalty.
   * It only applies a short cooldown to encourage the rotation strategy to pick a different account.
   * @param {ManagedAccount} account
   * @param {number|null} [cooldownMs] - Optional cooldown in ms; defaults to 60s
   */
  markPreemptiveSwitch(account, cooldownMs = 6e4) {
    const now = Date.now();
    account.rateLimitResetTimes[RATE_LIMIT_KEY] = now + (cooldownMs ?? 6e4);
    this.requestSaveToDisk();
  }
  /**
   * Mark a successful request for an account.
   * @param {ManagedAccount} account
   */
  markSuccess(account) {
    account.consecutiveFailures = 0;
    account.lastFailureTime = null;
    this.#healthTracker.recordSuccess(account.index);
  }
  /**
   * Mark a general failure (not rate limit) for an account.
   * @param {ManagedAccount} account
   */
  markFailure(account) {
    this.#healthTracker.recordFailure(account.index);
    this.#tokenTracker.refund(account.index);
  }
  /**
   * Apply a utilization-based health penalty (proactive, before actual rate limit).
   * @param {ManagedAccount} account
   * @param {number} penalty - Points to deduct (0-10 typical)
   */
  applyUtilizationPenalty(account, penalty) {
    if (penalty > 0) {
      this.#healthTracker.applyPenalty(account.index, penalty);
    }
  }
  /**
   * Handle surpassed rate limit threshold — aggressive penalty and soft cooldown.
   * @param {ManagedAccount} account
   * @param {string | null} resetAt - ISO timestamp or null
   */
  applySurpassedThreshold(account, resetAt) {
    this.#healthTracker.applyPenalty(account.index, 15);
    if (resetAt) {
      const resetTime = new Date(resetAt).getTime();
      if (!isNaN(resetTime) && resetTime > Date.now()) {
        const SOFT_COOLDOWN_KEY = "soft_cooldown";
        account.rateLimitResetTimes[SOFT_COOLDOWN_KEY] = resetTime;
      }
    }
  }
  /**
   * Add a new account to the pool.
   * @param {string} refreshToken
   * @param {string} accessToken
   * @param {number} expires
   * @param {string} [email]
   * @returns {ManagedAccount | null} The new account, or null if at capacity
   */
  addAccount(refreshToken2, accessToken, expires, email) {
    if (this.#accounts.length >= MAX_ACCOUNTS) return null;
    const existing = this.#accounts.find((acc) => acc.refreshToken === refreshToken2);
    if (existing) {
      existing.access = accessToken;
      existing.expires = expires;
      existing.tokenUpdatedAt = Date.now();
      if (email) existing.email = email;
      existing.enabled = true;
      return existing;
    }
    const now = Date.now();
    const account = {
      id: `${now}:${hashTokenFragment(refreshToken2)}`,
      index: this.#accounts.length,
      email,
      refreshToken: refreshToken2,
      access: accessToken,
      expires,
      tokenUpdatedAt: now,
      addedAt: now,
      lastUsed: 0,
      enabled: true,
      rateLimitResetTimes: {},
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSwitchReason: "initial",
      stats: createDefaultStats(now)
    };
    this.#accounts.push(account);
    if (this.#accounts.length === 1) {
      this.#currentIndex = 0;
    }
    this.requestSaveToDisk();
    return account;
  }
  /**
   * Remove an account by index.
   * @param {number} index
   * @returns {boolean}
   */
  removeAccount(index) {
    if (index < 0 || index >= this.#accounts.length) return false;
    this.#accounts.splice(index, 1);
    this.#accounts.forEach((acc, i) => {
      acc.index = i;
    });
    if (this.#accounts.length === 0) {
      this.#currentIndex = -1;
      this.#cursor = 0;
    } else {
      if (this.#currentIndex >= this.#accounts.length) {
        this.#currentIndex = this.#accounts.length - 1;
      }
      if (this.#cursor > 0) {
        this.#cursor = this.#accounts.length > 0 ? this.#cursor % this.#accounts.length : 0;
      }
    }
    this.#healthTracker = new HealthScoreTracker(this.#config.health_score);
    this.#tokenTracker = new TokenBucketTracker(this.#config.token_bucket);
    this.requestSaveToDisk();
    return true;
  }
  /**
   * Toggle an account's enabled state.
   * @param {number} index
   * @returns {boolean} New enabled state
   */
  toggleAccount(index) {
    const account = this.#accounts[index];
    if (!account) return false;
    account.enabled = !account.enabled;
    this.requestSaveToDisk();
    return account.enabled;
  }
  /**
   * Clear all accounts and reset state.
   */
  clearAll() {
    this.#accounts = [];
    this.#currentIndex = -1;
    this.#cursor = 0;
    this.#healthTracker = new HealthScoreTracker(this.#config.health_score);
    this.#tokenTracker = new TokenBucketTracker(this.#config.token_bucket);
    this.#statsDeltas.clear();
  }
  /**
   * Request a debounced save to disk.
   * Each call resets the debounce timer so the latest state is always persisted.
   */
  requestSaveToDisk() {
    if (this.#saveTimeout) clearTimeout(this.#saveTimeout);
    this.#saveTimeout = setTimeout(() => {
      this.#saveTimeout = null;
      this.saveToDisk().catch(() => {
      });
    }, 1e3);
  }
  /**
   * Persist current state to disk immediately.
   * Stats use merge-on-save: read disk values, add this instance's deltas,
   * write merged result. This prevents concurrent instances from clobbering
   * each other's stats.
   * @returns {Promise<void>}
   */
  async saveToDisk() {
    let diskAccountsById = null;
    let diskAccountsByAddedAt = null;
    let diskAccountsByRefreshToken = null;
    try {
      const diskData = await loadAccounts();
      if (diskData) {
        diskAccountsById = new Map(diskData.accounts.map((a) => [a.id, a]));
        diskAccountsByAddedAt = /* @__PURE__ */ new Map();
        diskAccountsByRefreshToken = /* @__PURE__ */ new Map();
        for (const diskAcc of diskData.accounts) {
          const bucket = diskAccountsByAddedAt.get(diskAcc.addedAt) || [];
          bucket.push(diskAcc);
          diskAccountsByAddedAt.set(diskAcc.addedAt, bucket);
          diskAccountsByRefreshToken.set(diskAcc.refreshToken, diskAcc);
        }
      }
    } catch {
    }
    const findDiskAccount = (account) => {
      const byId = diskAccountsById?.get(account.id);
      if (byId) return byId;
      const byAddedAt = diskAccountsByAddedAt?.get(account.addedAt);
      if (byAddedAt?.length === 1) return byAddedAt[0];
      const byToken = diskAccountsByRefreshToken?.get(account.refreshToken);
      if (byToken) return byToken;
      if (byAddedAt && byAddedAt.length > 0) return byAddedAt[0];
      return null;
    };
    const storage = {
      version: 1,
      accounts: this.#accounts.map((acc) => {
        const delta = this.#statsDeltas.get(acc.id);
        let mergedStats = acc.stats;
        const diskAcc = findDiskAccount(acc);
        if (delta) {
          const diskStats = diskAcc?.stats;
          if (delta.isReset) {
            mergedStats = {
              requests: delta.requests,
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              cacheReadTokens: delta.cacheReadTokens,
              cacheWriteTokens: delta.cacheWriteTokens,
              lastReset: delta.resetTimestamp ?? acc.stats.lastReset
            };
          } else if (diskStats) {
            mergedStats = {
              requests: diskStats.requests + delta.requests,
              inputTokens: diskStats.inputTokens + delta.inputTokens,
              outputTokens: diskStats.outputTokens + delta.outputTokens,
              cacheReadTokens: diskStats.cacheReadTokens + delta.cacheReadTokens,
              cacheWriteTokens: diskStats.cacheWriteTokens + delta.cacheWriteTokens,
              lastReset: diskStats.lastReset
            };
          }
        }
        const memTokenUpdatedAt = acc.tokenUpdatedAt || 0;
        const diskTokenUpdatedAt = diskAcc?.token_updated_at || 0;
        const freshestAuth = diskAcc && diskTokenUpdatedAt > memTokenUpdatedAt ? {
          refreshToken: diskAcc.refreshToken,
          access: diskAcc.access,
          expires: diskAcc.expires,
          tokenUpdatedAt: diskTokenUpdatedAt
        } : {
          refreshToken: acc.refreshToken,
          access: acc.access,
          expires: acc.expires,
          tokenUpdatedAt: memTokenUpdatedAt
        };
        acc.refreshToken = freshestAuth.refreshToken;
        acc.access = freshestAuth.access;
        acc.expires = freshestAuth.expires;
        acc.tokenUpdatedAt = freshestAuth.tokenUpdatedAt;
        return {
          id: acc.id,
          email: acc.email,
          accountUuid: acc.accountUuid,
          organizationUuid: acc.organizationUuid,
          refreshToken: freshestAuth.refreshToken,
          access: freshestAuth.access,
          expires: freshestAuth.expires,
          token_updated_at: freshestAuth.tokenUpdatedAt,
          addedAt: acc.addedAt,
          lastUsed: acc.lastUsed,
          enabled: acc.enabled,
          rateLimitResetTimes: Object.keys(acc.rateLimitResetTimes).length > 0 ? acc.rateLimitResetTimes : {},
          consecutiveFailures: acc.consecutiveFailures,
          lastFailureTime: acc.lastFailureTime,
          lastSwitchReason: acc.lastSwitchReason,
          stats: mergedStats,
          source: acc.source
        };
      }),
      activeIndex: Math.max(0, this.#currentIndex)
    };
    const capturedDeltaKeys = new Set(this.#statsDeltas.keys());
    const preloadedDiskData = diskAccountsById ? { version: 1, accounts: [...diskAccountsById.values()] } : null;
    await saveAccounts(storage, preloadedDiskData);
    for (const key of capturedDeltaKeys) {
      this.#statsDeltas.delete(key);
    }
    for (const saved of storage.accounts) {
      const acc = this.#accounts.find((a) => a.id === saved.id);
      if (acc) {
        acc.stats = saved.stats;
      }
    }
  }
  /**
   * Sync activeIndex from disk (picks up CLI changes while OpenCode is running).
   * Only switches if the disk value differs and the target account is enabled.
   * @returns {Promise<void>}
   */
  async syncActiveIndexFromDisk() {
    const stored = await loadAccounts();
    if (!stored) return;
    const existingByTokenForSnapshot = new Map(this.#accounts.map((acc) => [acc.refreshToken, acc]));
    const memSnapshot = this.#accounts.map((acc) => `${acc.id}:${acc.refreshToken}:${acc.enabled ? 1 : 0}`).join("|");
    const diskSnapshot = stored.accounts.map((acc) => {
      const resolvedId = acc.id || existingByTokenForSnapshot.get(acc.refreshToken)?.id || acc.refreshToken;
      return `${resolvedId}:${acc.refreshToken}:${acc.enabled ? 1 : 0}`;
    }).join("|");
    if (diskSnapshot !== memSnapshot) {
      const existingById = new Map(this.#accounts.map((acc) => [acc.id, acc]));
      const existingByToken = new Map(this.#accounts.map((acc) => [acc.refreshToken, acc]));
      this.#accounts = stored.accounts.map((acc, index) => {
        const existing = acc.id && existingById.get(acc.id) || (!acc.id ? existingByToken.get(acc.refreshToken) : null);
        return {
          id: acc.id || existing?.id || `${acc.addedAt}:${hashTokenFragment(acc.refreshToken)}`,
          index,
          email: acc.email ?? existing?.email,
          refreshToken: acc.refreshToken,
          access: acc.access ?? existing?.access,
          expires: acc.expires ?? existing?.expires,
          tokenUpdatedAt: acc.token_updated_at ?? existing?.tokenUpdatedAt ?? acc.addedAt,
          addedAt: acc.addedAt,
          lastUsed: acc.lastUsed,
          enabled: acc.enabled,
          rateLimitResetTimes: acc.rateLimitResetTimes,
          consecutiveFailures: acc.consecutiveFailures,
          lastFailureTime: acc.lastFailureTime,
          lastSwitchReason: acc.lastSwitchReason || existing?.lastSwitchReason || "initial",
          stats: acc.stats ?? existing?.stats ?? createDefaultStats(),
          source: acc.source || existing?.source || "oauth"
        };
      });
      this.#healthTracker = new HealthScoreTracker(this.#config.health_score);
      this.#tokenTracker = new TokenBucketTracker(this.#config.token_bucket);
      const currentIds = new Set(this.#accounts.map((a) => a.id));
      for (const id of this.#statsDeltas.keys()) {
        if (!currentIds.has(id)) this.#statsDeltas.delete(id);
      }
      if (this.#accounts.length === 0) {
        this.#currentIndex = -1;
        this.#cursor = 0;
        return;
      }
    }
    const diskIndex = Math.min(stored.activeIndex, this.#accounts.length - 1);
    if (diskIndex >= 0 && diskIndex !== this.#currentIndex) {
      const diskAccount = stored.accounts[diskIndex];
      if (!diskAccount || !diskAccount.enabled) return;
      const account = this.#accounts[diskIndex];
      if (account && account.enabled) {
        this.#currentIndex = diskIndex;
        this.#cursor = diskIndex;
        this.#healthTracker.reset(diskIndex);
      }
    }
  }
  /**
   * Record token usage for an account after a successful API response.
   * @param {number} index
   * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage
   */
  recordUsage(index, usage) {
    const account = this.#accounts[index];
    if (!account) return;
    const inTok = usage.inputTokens || 0;
    const outTok = usage.outputTokens || 0;
    const crTok = usage.cacheReadTokens || 0;
    const cwTok = usage.cacheWriteTokens || 0;
    account.stats.requests += 1;
    account.stats.inputTokens += inTok;
    account.stats.outputTokens += outTok;
    account.stats.cacheReadTokens += crTok;
    account.stats.cacheWriteTokens += cwTok;
    const delta = this.#statsDeltas.get(account.id);
    if (delta) {
      delta.requests += 1;
      delta.inputTokens += inTok;
      delta.outputTokens += outTok;
      delta.cacheReadTokens += crTok;
      delta.cacheWriteTokens += cwTok;
    } else {
      this.#statsDeltas.set(account.id, {
        requests: 1,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: crTok,
        cacheWriteTokens: cwTok,
        isReset: false
      });
    }
    this.requestSaveToDisk();
  }
  /**
   * Reset stats for a specific account or all accounts.
   * @param {number | "all"} target - Account index or "all"
   */
  resetStats(target) {
    const now = Date.now();
    const resetAccount = (acc) => {
      acc.stats = createDefaultStats(now);
      this.#statsDeltas.set(acc.id, {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        isReset: true,
        resetTimestamp: now
      });
    };
    if (target === "all") {
      for (const acc of this.#accounts) {
        resetAccount(acc);
      }
    } else {
      const account = this.#accounts[target];
      if (account) {
        resetAccount(account);
      }
    }
    this.requestSaveToDisk();
  }
  /**
   * Convert a managed account to the format expected by OpenCode's auth.json.
   * @param {ManagedAccount} account
   * @returns {{type: 'oauth', refresh: string, access: string | undefined, expires: number | undefined}}
   */
  toAuthDetails(account) {
    return {
      type: "oauth",
      refresh: account.refreshToken,
      access: account.access,
      expires: account.expires
    };
  }
};

// index.mjs
init_oauth();
init_config();

// lib/context-hint-persist.mjs
init_config();
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
var FLAG_FILENAME = "context-hint-disabled.flag";
var FLAG_VERSION = 1;
function getContextHintFlagPath() {
  return join4(getConfigDir(), FLAG_FILENAME);
}
function loadContextHintDisabledFlag() {
  const p = getContextHintFlagPath();
  if (!existsSync4(p)) return { disabled: false };
  try {
    const raw = readFileSync4(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.disabled === true) {
      return {
        disabled: true,
        reason: typeof parsed.reason === "string" ? parsed.reason : void 0,
        status: typeof parsed.status === "number" ? parsed.status : void 0,
        timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : void 0
      };
    }
  } catch {
  }
  return { disabled: false };
}
function saveContextHintDisabledFlag({ reason, status }) {
  const p = getContextHintFlagPath();
  try {
    mkdirSync2(dirname3(p), { recursive: true });
    const payload = {
      disabled: true,
      reason,
      status,
      timestamp: Date.now(),
      version: FLAG_VERSION
    };
    writeFileSync3(p, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
  }
}

// index.mjs
init_storage();

// lib/refresh-lock.mjs
init_storage();
import { promises as fs2 } from "node:fs";
import { createHash as createHash4, randomBytes as randomBytes4 } from "node:crypto";
import { dirname as dirname4, join as join5 } from "node:path";
var DEFAULT_LOCK_TIMEOUT_MS = 2e3;
var DEFAULT_LOCK_BACKOFF_MS = 50;
var DEFAULT_STALE_LOCK_MS = 2e4;
function delay(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function getLockPath(accountId) {
  const hash = createHash4("sha1").update(accountId).digest("hex").slice(0, 24);
  return join5(dirname4(getStoragePath()), "locks", `refresh-${hash}.lock`);
}
async function acquireRefreshLock(accountId, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_LOCK_BACKOFF_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const lockPath = getLockPath(accountId);
  const lockDir = dirname4(lockPath);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const owner = randomBytes4(12).toString("hex");
  await fs2.mkdir(lockDir, { recursive: true });
  while (Date.now() <= deadline) {
    try {
      const handle = await fs2.open(lockPath, "wx", 384);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), owner }), "utf-8");
        const stat = await handle.stat();
        return { acquired: true, lockPath, owner, lockInode: stat.ino };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (
        /** @type {NodeJS.ErrnoException} */
        error.code
      );
      if (code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await fs2.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try {
            const reStat = await fs2.stat(lockPath);
            if (Date.now() - reStat.mtimeMs > staleMs) {
              await fs2.unlink(lockPath);
            }
          } catch {
          }
          continue;
        }
      } catch {
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const jitter = Math.floor(Math.random() * 25);
      await delay(Math.min(remaining, backoffMs + jitter));
    }
  }
  return { acquired: false, lockPath: null, owner: null, lockInode: null };
}
async function releaseRefreshLock(lock) {
  const lockPath = typeof lock === "string" || lock === null ? lock : lock.lockPath;
  const owner = typeof lock === "object" && lock ? lock.owner || null : null;
  const lockInode = typeof lock === "object" && lock ? lock.lockInode || null : null;
  if (!lockPath) return;
  if (owner) {
    try {
      const content = await fs2.readFile(lockPath, "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || parsed.owner !== owner) {
        return;
      }
      if (lockInode) {
        const stat = await fs2.stat(lockPath);
        if (stat.ino !== lockInode) {
          return;
        }
      }
    } catch (error) {
      const code = (
        /** @type {NodeJS.ErrnoException} */
        error.code
      );
      if (code === "ENOENT") return;
      return;
    }
  }
  try {
    await fs2.unlink(lockPath);
  } catch (error) {
    const code = (
      /** @type {NodeJS.ErrnoException} */
      error.code
    );
    if (code !== "ENOENT") throw error;
  }
}

// index.mjs
init_backoff();

// lib/haiku-call.mjs
var MODEL = "claude-haiku-4-5-20251001";
var TEMPERATURE = 0;
var MAX_TOKENS = 2048;
var ANTHROPIC_VERSION = "2023-06-01";
var API_URL = "https://api.anthropic.com/v1/messages";
var PRICE_INPUT_PER_MTOK = 1;
var PRICE_OUTPUT_PER_MTOK = 5;
async function callHaiku({ prompt, fetch: fetch2, getAccessToken }) {
  const token = await getAccessToken();
  const res = await fetch2(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Haiku call failed: HTTP ${res.status} ${body}`);
  }
  const json = await res.json();
  const textBlock = (json.content ?? []).find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string" || textBlock.text.length === 0) {
    throw new Error("Haiku response has no text content");
  }
  const input = json.usage?.input_tokens ?? 0;
  const output = json.usage?.output_tokens ?? 0;
  const cost = input / 1e6 * PRICE_INPUT_PER_MTOK + output / 1e6 * PRICE_OUTPUT_PER_MTOK;
  return { text: textBlock.text, tokens: { input, output }, cost };
}

// lib/rolling-summarizer.mjs
var MODEL2 = "claude-haiku-4-5-20251001";
var TEMPERATURE2 = 0;
var DEFAULT_MAX_CHARS = 2e3;
var TEMPLATE = [
  "<session-summary>",
  "Previous conversation summarized for context efficiency.",
  "",
  "Key topics covered:",
  "{topics}",
  "",
  "Outstanding state:",
  "{outstanding}",
  "",
  "Files touched:",
  "{files}",
  "</session-summary>"
].join("\n");
var SECTIONS = ["TOPICS", "OUTSTANDING", "FILES"];
var EMPTY_SECTION = "(none)";
function stableStringify(obj) {
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(obj[k]));
  return "{" + parts.join(",") + "}";
}
function buildPrompt(messages, maxChars) {
  const rendered = messages.map((m) => {
    const norm = stableStringify({ role: String(m.role ?? ""), content: String(m.content ?? "") });
    const parsed = JSON.parse(norm);
    return `${parsed.role}: ${parsed.content}`;
  });
  let body = rendered.join("\n");
  let dropped = 0;
  while (body.length > maxChars && rendered.length - dropped > 1) {
    dropped += 1;
    body = rendered.slice(dropped).join("\n");
  }
  const header = [
    "Summarize the conversation below for context compaction.",
    "Respond with EXACTLY these three sections, in this order:",
    "TOPICS:",
    "- <bullet per topic>",
    "OUTSTANDING:",
    "- <bullet per outstanding item, or (none)>",
    "FILES:",
    "- <bullet per touched file, or (none)>",
    "Do not include dates, times, IDs, greetings, or apologies.",
    "---"
  ].join("\n");
  return `${header}
${body}`;
}
function parseHaikuResponse(raw) {
  const buckets = {};
  for (const name of SECTIONS) buckets[name] = [];
  let current = (
    /** @type {string | null} */
    null
  );
  const lines = String(raw ?? "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z]+)\s*:\s*$/);
    if (match && SECTIONS.includes(match[1])) {
      current = match[1];
      continue;
    }
    if (current && line.trim() !== "") {
      buckets[current].push(line);
    }
  }
  const pick = (name) => {
    const arr = buckets[name];
    if (!arr || arr.length === 0) return EMPTY_SECTION;
    return arr.join("\n");
  };
  return {
    topics: pick("TOPICS"),
    outstanding: pick("OUTSTANDING"),
    files: pick("FILES")
  };
}
function formatTemplate(parsed, maxChars) {
  let current = {
    topics: parsed.topics || EMPTY_SECTION,
    outstanding: parsed.outstanding || EMPTY_SECTION,
    files: parsed.files || EMPTY_SECTION
  };
  const render = (sec) => TEMPLATE.replace("{topics}", sec.topics).replace("{outstanding}", sec.outstanding).replace("{files}", sec.files);
  let out = render(current);
  let guard = 0;
  while (out.length > maxChars && guard < 1e3) {
    guard += 1;
    const names = (
      /** @type {(keyof ParsedSections)[]} */
      ["topics", "outstanding", "files"]
    );
    let longestName = names[0];
    for (const n of names) {
      if (current[n].length > current[longestName].length) longestName = n;
    }
    const longest = current[longestName];
    if (longest.length <= EMPTY_SECTION.length) break;
    const chop = Math.max(8, Math.floor(longest.length * 0.1));
    current = { ...current, [longestName]: longest.slice(0, Math.max(EMPTY_SECTION.length, longest.length - chop)) };
    out = render(current);
  }
  if (out.length > maxChars) {
    const closing = "\n</session-summary>";
    const head = out.slice(0, Math.max(0, maxChars - closing.length));
    out = head + closing;
  }
  return out;
}
async function summarize(messages, opts) {
  if (!opts || typeof opts.haikuCall !== "function") {
    throw new Error("summarize() requires opts.haikuCall");
  }
  const maxChars = typeof opts.maxChars === "number" ? opts.maxChars : DEFAULT_MAX_CHARS;
  const prompt = buildPrompt(Array.isArray(messages) ? messages : [], maxChars);
  const request = { model: MODEL2, prompt, temperature: TEMPERATURE2 };
  const raw = await opts.haikuCall(request);
  const parsed = parseHaikuResponse(String(raw ?? ""));
  return formatTemplate(parsed, maxChars);
}

// lib/message-transform.mjs
var STALE_READ_TOOLS = /* @__PURE__ */ new Set(["read", "view"]);
var REPRODUCIBLE_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "list",
  "find"
]);
var PRUNE_PROTECTED_TOOLS = /* @__PURE__ */ new Set(["skill"]);
var STALE_READ_PLACEHOLDER = "[File was read earlier in this session \u2014 re-read if you need the current contents]";
function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
function staleReadEviction({
  messages,
  threshold = 10,
  tools = STALE_READ_TOOLS
}) {
  if (!Array.isArray(messages) || messages.length <= threshold) {
    return { evicted: 0 };
  }
  const cutoff = messages.length - threshold;
  let evicted = 0;
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (!msg?.parts) continue;
    for (const part of msg.parts) {
      if (part?.type !== "tool") continue;
      if (part.state?.status !== "completed") continue;
      if (part.state.time?.compacted) continue;
      if (!tools.has(part.tool)) continue;
      part.state.output = STALE_READ_PLACEHOLDER;
      if (part.state.attachments) {
        part.state.attachments = [];
      }
      evicted++;
    }
  }
  return { evicted };
}
function perToolClassPrune({
  messages,
  reproducibleThreshold = 1e4,
  statefulThreshold = 4e4,
  reproducibleTools = REPRODUCIBLE_TOOLS
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { pruned: 0, tokensSaved: 0 };
  }
  let totalReproducible = 0;
  let totalStateful = 0;
  let pruned = 0;
  let tokensSaved = 0;
  outer: for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg?.parts?.length) continue;
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j];
      if (part?.type !== "tool") continue;
      if (part.state?.status !== "completed") continue;
      if (PRUNE_PROTECTED_TOOLS.has(part.tool)) continue;
      if (part.state.time?.compacted) break outer;
      const estimate = estimateTokens(part.state.output);
      const isReproducible = reproducibleTools.has(part.tool.toLowerCase());
      if (isReproducible) {
        totalReproducible += estimate;
        if (totalReproducible > reproducibleThreshold) {
          part.state.output = "";
          if (part.state.attachments) part.state.attachments = [];
          pruned++;
          tokensSaved += estimate;
        }
      } else {
        totalStateful += estimate;
        if (totalStateful > statefulThreshold) {
          part.state.output = "";
          if (part.state.attachments) part.state.attachments = [];
          pruned++;
          tokensSaved += estimate;
        }
      }
    }
  }
  return { pruned, tokensSaved };
}

// index.mjs
async function promptAccountMenu(accountManager) {
  const accounts = accountManager.getAccountsSnapshot();
  const currentIndex = accountManager.getCurrentIndex();
  const rl = createInterface2({ input: stdin2, output: stdout2 });
  try {
    console.log(`
${accounts.length} account(s) configured:`);
    for (const acc of accounts) {
      const name = acc.email || `Account ${acc.index + 1}`;
      const active = acc.index === currentIndex ? " (active)" : "";
      const disabled = !acc.enabled ? " [disabled]" : "";
      console.log(`  ${acc.index + 1}. ${name}${active}${disabled}`);
    }
    console.log("");
    while (true) {
      const answer = await rl.question("(a)dd new, (f)resh start, (m)anage, (c)ancel? [a/f/m/c]: ");
      const normalized = answer.trim().toLowerCase();
      if (normalized === "a" || normalized === "add") return "add";
      if (normalized === "f" || normalized === "fresh") return "fresh";
      if (normalized === "m" || normalized === "manage") return "manage";
      if (normalized === "c" || normalized === "cancel") return "cancel";
      console.log("Please enter 'a', 'f', 'm', or 'c'.");
    }
  } finally {
    rl.close();
  }
}
async function promptManageAccounts(accountManager) {
  let accounts = accountManager.getAccountsSnapshot();
  const rl = createInterface2({ input: stdin2, output: stdout2 });
  try {
    console.log("\nManage accounts:");
    for (const acc of accounts) {
      const name = acc.email || `Account ${acc.index + 1}`;
      const status = acc.enabled ? "enabled" : "disabled";
      console.log(`  ${acc.index + 1}. ${name} [${status}]`);
    }
    console.log("");
    while (true) {
      const answer = await rl.question("Enter account number to toggle, (d)N to delete (e.g. d1), or (b)ack: ");
      const normalized = answer.trim().toLowerCase();
      if (normalized === "b" || normalized === "back") return;
      const deleteMatch = normalized.match(/^d(\d+)$/);
      if (deleteMatch) {
        const idx = parseInt(deleteMatch[1], 10) - 1;
        if (idx >= 0 && idx < accounts.length) {
          accountManager.removeAccount(idx);
          console.log(`Removed account ${idx + 1}.`);
          return;
        }
        console.log("Invalid account number.");
        continue;
      }
      const num = parseInt(normalized, 10);
      if (!isNaN(num) && num >= 1 && num <= accounts.length) {
        const newState = accountManager.toggleAccount(num - 1);
        console.log(`Account ${num} is now ${newState ? "enabled" : "disabled"}.`);
        accounts = accountManager.getAccountsSnapshot();
        continue;
      }
      console.log("Invalid input.");
    }
  } finally {
    rl.close();
  }
}
async function runHaikuSessionSummarize({ config, getAccessToken, fetchFn, callHaikuFn, rollingSummarizeFn, logger }, input, output) {
  if (!config?.token_economy_strategies?.haiku_rolling_summary) return;
  try {
    let capturedTokens = { input: 0, output: 0 };
    let capturedCost = 0;
    const haikuCall = async (request) => {
      const r = await callHaikuFn({
        prompt: request.prompt,
        fetch: fetchFn,
        getAccessToken
      });
      capturedTokens = r.tokens;
      capturedCost = r.cost;
      return r.text;
    };
    const summaryText = await rollingSummarizeFn(input.messages, { haikuCall });
    if (typeof summaryText !== "string" || summaryText.length === 0) return;
    output.summary = summaryText;
    output.modelID = "claude-haiku-4-5-20251001";
    output.providerID = "anthropic";
    output.tokens = capturedTokens;
    output.cost = capturedCost;
  } catch (err) {
    if (logger && typeof logger.warn === "function") {
      const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
      logger.warn(`[opencode-anthropic-fix] haiku rolling summary failed; falling back to default compaction: ${msg}`);
    }
  }
}
async function AnthropicAuthPlugin({ client, project, directory, worktree, serverUrl, $ }) {
  const config = loadConfig();
  _pluginConfig = config;
  const getSignatureEmulationEnabled = () => config.signature_emulation.enabled;
  const getPromptCompactionMode = () => config.signature_emulation.prompt_compaction === "off" ? "off" : "minimal";
  const shouldFetchClaudeCodeVersion = getSignatureEmulationEnabled() && config.signature_emulation.fetch_claude_code_version_on_startup;
  const strategyState = {
    mode: "CONFIGURED",
    // "CONFIGURED" | "DEGRADED"
    rateLimitEvents: [],
    // timestamps of rate limit events in current window
    windowMs: 5 * 60 * 1e3,
    // 5-minute sliding window
    thresholdCount: 3,
    // rate limits needed to trigger DEGRADED
    recoveryMs: 5 * 60 * 1e3,
    // 5 minutes clean to recover
    lastRateLimitTime: 0,
    manualOverride: false,
    // user explicitly set strategy — disable auto-adaptation
    originalStrategy: null
    // the user's configured strategy before DEGRADED override
  };
  let accountManager = null;
  let lastToastedIndex = -1;
  const debouncedToastTimestamps = /* @__PURE__ */ new Map();
  const refreshInFlight = /* @__PURE__ */ new Map();
  const idleRefreshLastAttempt = /* @__PURE__ */ new Map();
  const idleRefreshInFlight = /* @__PURE__ */ new Set();
  const getIdleRefreshEnabled = () => config.idle_refresh.enabled;
  const getIdleRefreshWindowMs = () => config.idle_refresh.window_minutes * 60 * 1e3;
  const getIdleRefreshMinIntervalMs = () => config.idle_refresh.min_interval_minutes * 60 * 1e3;
  const previousUnifiedStatus = {};
  const getWillowEnabled = () => config.willow_mode?.enabled ?? true;
  const getWillowIdleThresholdMs = () => (config.willow_mode?.idle_threshold_minutes ?? 30) * 60 * 1e3;
  const getWillowCooldownMs = () => (config.willow_mode?.cooldown_minutes ?? 60) * 60 * 1e3;
  const getWillowMinTurns = () => config.willow_mode?.min_turns_before_suggest ?? 3;
  let willowLastRequestTime = Date.now();
  let willowLastSuggestionTime = 0;
  let _lastOAuthPruneTime = 0;
  const betaLatchState = {
    /** @type {Set<string>} betas that have been sent at least once this session */
    sent: /* @__PURE__ */ new Set(),
    /** When true, a config change invalidated the latch and next request rebuilds. */
    dirty: false,
    /** @type {string | null} The last computed beta header string (for latching). */
    lastHeader: null
  };
  const _persistedCtxHint = loadContextHintDisabledFlag();
  const contextHintState = {
    /** Permanently disabled for this session after a server rejection. */
    disabled: _persistedCtxHint.disabled === true,
    /** Number of 422/424 compactions applied this session (for telemetry). */
    compactionsApplied: 0
  };
  if (contextHintState.disabled) {
    debugLog(
      "context-hint: loaded persisted disable flag",
      _persistedCtxHint.status ? `status=${_persistedCtxHint.status}` : "",
      _persistedCtxHint.timestamp ? `ts=${new Date(_persistedCtxHint.timestamp).toISOString()}` : ""
    );
  }
  const tokenEconomySession = {
    /** When thinking was last stripped (TTL-based strategy). 0 = never. */
    lastThinkingStripMs: 0,
    /** When proactive microcompact was last run (threshold-based). 0 = never. */
    lastMicrocompactMs: 0,
    /** Running count of tool_results client-compacted this session. */
    toolResultsCompacted: 0,
    /** Running count of thinking blocks stripped this session. */
    thinkingStripped: 0,
    /** Map of content-hash → first-seen tool_use_id for cross-turn dedupe. */
    seenContentHashes: /* @__PURE__ */ new Map()
  };
  let sessionCachePolicyLatched = false;
  let latchedCachePolicy = null;
  let initialAccountPinned = false;
  const pendingSlashOAuth = /* @__PURE__ */ new Map();
  const slashOAuthExchangeCooldownUntil = /* @__PURE__ */ new Map();
  const FILE_ACCOUNT_MAP_MAX = 1e3;
  const fileAccountMap = /* @__PURE__ */ new Map();
  function fileAccountMapSet(fileId, accountIndex) {
    fileAccountMap.set(fileId, accountIndex);
    if (fileAccountMap.size > FILE_ACCOUNT_MAP_MAX) {
      const excess = fileAccountMap.size - FILE_ACCOUNT_MAP_MAX;
      let deleted = 0;
      for (const key of fileAccountMap.keys()) {
        if (deleted >= excess) break;
        fileAccountMap.delete(key);
        deleted++;
      }
    }
  }
  async function sendCommandMessage(sessionID, text) {
    await client.session?.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text, ignored: true }]
      }
    });
  }
  async function reloadAccountManagerFromDisk() {
    if (!accountManager) return;
    accountManager = await AccountManager.load(config, null);
  }
  async function persistOpenCodeAuth(refresh, access, expires) {
    await client.auth.set({
      path: { id: "anthropic" },
      body: { type: "oauth", refresh, access, expires }
    });
  }
  function pruneExpiredPendingOAuth() {
    const now = Date.now();
    for (const [sessionID, pending] of pendingSlashOAuth.entries()) {
      if (now - pending.createdAt > PENDING_OAUTH_TTL_MS) {
        pendingSlashOAuth.delete(sessionID);
      }
    }
    for (const [sessionID, until] of slashOAuthExchangeCooldownUntil.entries()) {
      if (!pendingSlashOAuth.has(sessionID) || until <= now) {
        slashOAuthExchangeCooldownUntil.delete(sessionID);
      }
    }
  }
  async function runCliCommand(argv) {
    const logs = [];
    const errors = [];
    let code = 1;
    try {
      const { main: cliMain } = await init_cli().then(() => cli_exports);
      code = await cliMain(argv, {
        io: {
          log: (...args) => logs.push(args.join(" ")),
          error: (...args) => errors.push(args.join(" "))
        }
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return {
      code,
      stdout: stripAnsi2(logs.join("\n")).trim(),
      stderr: stripAnsi2(errors.join("\n")).trim()
    };
  }
  async function startSlashOAuth(sessionID, mode, targetIndex) {
    pruneExpiredPendingOAuth();
    const { url, verifier, state } = await authorize("max");
    pendingSlashOAuth.set(sessionID, {
      mode,
      verifier,
      state,
      targetIndex,
      createdAt: Date.now()
    });
    const action = mode === "login" ? "login" : `reauth ${targetIndex + 1}`;
    const followup = mode === "login" ? "/anthropic login complete <code#state>" : "/anthropic reauth complete <code#state>";
    await sendCommandMessage(
      sessionID,
      [
        "\u25A3 Anthropic OAuth",
        "",
        `Started ${action} flow.`,
        "Open this URL in your browser:",
        url,
        "",
        `Then run: ${followup}`,
        "(Paste the full authorization code, including #state)"
      ].join("\n")
    );
  }
  async function completeSlashOAuth(sessionID, code) {
    const pending = pendingSlashOAuth.get(sessionID);
    if (!pending) {
      pruneExpiredPendingOAuth();
      return {
        ok: false,
        message: "No pending OAuth flow. Start with /anthropic login or /anthropic reauth <N>."
      };
    }
    if (Date.now() - pending.createdAt > PENDING_OAUTH_TTL_MS) {
      pendingSlashOAuth.delete(sessionID);
      slashOAuthExchangeCooldownUntil.delete(sessionID);
      return {
        ok: false,
        message: "Pending OAuth flow expired. Start again with /anthropic login or /anthropic reauth <N>."
      };
    }
    const now = Date.now();
    const cooldownUntil = slashOAuthExchangeCooldownUntil.get(sessionID) || 0;
    if (cooldownUntil > now) {
      const remainingSec = Math.max(1, Math.ceil((cooldownUntil - now) / 1e3));
      return {
        ok: false,
        message: `OAuth token exchange is still rate-limited. Wait about ${remainingSec}s and retry /anthropic ${pending.mode} complete <code#state>.`
      };
    }
    slashOAuthExchangeCooldownUntil.delete(sessionID);
    const codeParts = code.split("#");
    const returnedState = codeParts[1];
    if (pending.state) {
      if (!returnedState || returnedState !== pending.state) {
        pendingSlashOAuth.delete(sessionID);
        slashOAuthExchangeCooldownUntil.delete(sessionID);
        return {
          ok: false,
          message: "OAuth state mismatch or missing \u2014 possible CSRF attack. Please start a new login flow."
        };
      }
    }
    const credentials = await exchange(code, pending.verifier);
    if (credentials.type === "failed") {
      if (credentials.status === 429) {
        const retryAfterMs = typeof credentials.retryAfterMs === "number" && Number.isFinite(credentials.retryAfterMs) ? Math.max(1e3, credentials.retryAfterMs) : 3e4;
        const retryAfterSource = typeof credentials.retryAfterSource === "string" && credentials.retryAfterSource ? credentials.retryAfterSource : "unknown";
        slashOAuthExchangeCooldownUntil.set(sessionID, Date.now() + retryAfterMs);
        const waitSec = Math.max(1, Math.ceil(retryAfterMs / 1e3));
        debugLog("slash oauth exchange rate limited", {
          sessionID,
          retryAfterMs,
          retryAfterSource
        });
        return {
          ok: false,
          message: credentials.details ? `Token exchange failed (${credentials.details}).

Anthropic OAuth is rate-limited. Wait about ${waitSec}s and retry /anthropic ${pending.mode} complete <code#state>.` : `Token exchange failed due to rate limiting. Wait about ${waitSec}s and retry /anthropic ${pending.mode} complete <code#state>.`
        };
      }
      return {
        ok: false,
        message: credentials.details ? `Token exchange failed (${credentials.details}).` : "Token exchange failed. The code may be invalid or expired."
      };
    }
    const stored = await loadAccounts() || { version: 1, accounts: [], activeIndex: 0 };
    if (pending.mode === "login") {
      const existingIdx = stored.accounts.findIndex((acc) => acc.refreshToken === credentials.refresh);
      if (existingIdx >= 0) {
        const acc = stored.accounts[existingIdx];
        acc.access = credentials.access;
        acc.expires = credentials.expires;
        if (credentials.email) acc.email = credentials.email;
        if (credentials.accountUuid) acc.accountUuid = credentials.accountUuid;
        if (credentials.organizationUuid) acc.organizationUuid = credentials.organizationUuid;
        acc.enabled = true;
        acc.consecutiveFailures = 0;
        acc.lastFailureTime = null;
        acc.rateLimitResetTimes = {};
        await saveAccounts(stored);
        await persistOpenCodeAuth(acc.refreshToken, acc.access, acc.expires);
        await reloadAccountManagerFromDisk();
        pendingSlashOAuth.delete(sessionID);
        slashOAuthExchangeCooldownUntil.delete(sessionID);
        const name2 = acc.email || `Account ${existingIdx + 1}`;
        return { ok: true, message: `Updated existing account #${existingIdx + 1} (${name2}).` };
      }
      if (stored.accounts.length >= 10) {
        return { ok: false, message: "Maximum of 10 accounts reached. Remove one first." };
      }
      const now2 = Date.now();
      stored.accounts.push({
        id: `${now2}:${credentials.refresh.slice(0, 12)}`,
        email: credentials.email,
        accountUuid: credentials.accountUuid,
        organizationUuid: credentials.organizationUuid,
        refreshToken: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
        token_updated_at: now2,
        addedAt: now2,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: createDefaultStats(now2)
      });
      const newAccount = stored.accounts[stored.accounts.length - 1];
      if (!newAccount.accountUuid && newAccount.access) {
        try {
          const profileResp = await globalThis.fetch("https://api.anthropic.com/api/oauth/profile", {
            method: "GET",
            headers: { Authorization: `Bearer ${newAccount.access}`, "Content-Type": "application/json" },
            signal: AbortSignal.timeout(1e4)
          });
          if (profileResp.ok) {
            const profile = await profileResp.json();
            if (profile.account?.uuid) newAccount.accountUuid = profile.account.uuid;
            if (profile.organization?.uuid) newAccount.organizationUuid = profile.organization.uuid;
          }
        } catch {
        }
      }
      await saveAccounts(stored);
      await persistOpenCodeAuth(newAccount.refreshToken, newAccount.access, newAccount.expires);
      await reloadAccountManagerFromDisk();
      pendingSlashOAuth.delete(sessionID);
      slashOAuthExchangeCooldownUntil.delete(sessionID);
      const label = credentials.email || `Account ${stored.accounts.length}`;
      return { ok: true, message: `Added account #${stored.accounts.length} (${label}).` };
    }
    const idx = pending.targetIndex ?? -1;
    if (idx < 0 || idx >= stored.accounts.length) {
      pendingSlashOAuth.delete(sessionID);
      slashOAuthExchangeCooldownUntil.delete(sessionID);
      return { ok: false, message: "Target account no longer exists. Start reauth again." };
    }
    const existing = stored.accounts[idx];
    existing.refreshToken = credentials.refresh;
    existing.access = credentials.access;
    existing.expires = credentials.expires;
    if (credentials.email) existing.email = credentials.email;
    existing.enabled = true;
    existing.consecutiveFailures = 0;
    existing.lastFailureTime = null;
    existing.rateLimitResetTimes = {};
    await saveAccounts(stored);
    await persistOpenCodeAuth(existing.refreshToken, existing.access, existing.expires);
    await reloadAccountManagerFromDisk();
    pendingSlashOAuth.delete(sessionID);
    slashOAuthExchangeCooldownUntil.delete(sessionID);
    const name = existing.email || `Account ${idx + 1}`;
    return { ok: true, message: `Re-authenticated account #${idx + 1} (${name}).` };
  }
  async function handleAnthropicSlashCommand(input) {
    const args = parseCommandArgs(input.arguments || "");
    const primary = (args[0] || "list").toLowerCase();
    if (primary === "usage") {
      const result2 = await runCliCommand(["list"]);
      const heading2 = result2.code === 0 ? "\u25A3 Anthropic" : "\u25A3 Anthropic (error)";
      const body2 = result2.stdout || result2.stderr || "No output.";
      await sendCommandMessage(input.sessionID, [heading2, "", body2].join("\n"));
      await reloadAccountManagerFromDisk();
      return;
    }
    if (primary === "login") {
      if ((args[1] || "").toLowerCase() === "complete") {
        const code = args.slice(2).join(" ").trim();
        if (!code) {
          await sendCommandMessage(
            input.sessionID,
            "\u25A3 Anthropic OAuth\n\nMissing code. Use: /anthropic login complete <code#state>"
          );
          return;
        }
        const result2 = await completeSlashOAuth(input.sessionID, code);
        const heading2 = result2.ok ? "\u25A3 Anthropic OAuth" : "\u25A3 Anthropic OAuth (error)";
        await sendCommandMessage(input.sessionID, `${heading2}

${result2.message}`);
        return;
      }
      await startSlashOAuth(input.sessionID, "login");
      return;
    }
    if (primary === "reauth") {
      if ((args[1] || "").toLowerCase() === "complete") {
        const code = args.slice(2).join(" ").trim();
        if (!code) {
          await sendCommandMessage(
            input.sessionID,
            "\u25A3 Anthropic OAuth\n\nMissing code. Use: /anthropic reauth complete <code#state>"
          );
          return;
        }
        const result2 = await completeSlashOAuth(input.sessionID, code);
        const heading2 = result2.ok ? "\u25A3 Anthropic OAuth" : "\u25A3 Anthropic OAuth (error)";
        await sendCommandMessage(input.sessionID, `${heading2}

${result2.message}`);
        return;
      }
      const n = parseInt(args[1], 10);
      if (Number.isNaN(n) || n < 1) {
        await sendCommandMessage(
          input.sessionID,
          "\u25A3 Anthropic OAuth\n\nProvide an account number. Example: /anthropic reauth 1"
        );
        return;
      }
      const stored = await loadAccounts();
      if (!stored || stored.accounts.length === 0) {
        await sendCommandMessage(input.sessionID, "\u25A3 Anthropic OAuth (error)\n\nNo accounts configured.");
        return;
      }
      const idx = n - 1;
      if (idx >= stored.accounts.length) {
        await sendCommandMessage(
          input.sessionID,
          `\u25A3 Anthropic OAuth (error)

Account ${n} does not exist. You have ${stored.accounts.length} account(s).`
        );
        return;
      }
      await startSlashOAuth(input.sessionID, "reauth", idx);
      return;
    }
    if (primary === "config") {
      const fresh = loadConfigFresh();
      const lines = [
        "\u25A3 Anthropic Config",
        "",
        `strategy: ${fresh.account_selection_strategy}`,
        `strategy-state: ${strategyState.mode}${strategyState.manualOverride ? " (manual override)" : ""}`,
        `emulation: ${fresh.signature_emulation.enabled ? "on" : "off"}`,
        `compaction: ${fresh.signature_emulation.prompt_compaction}`,
        `1m-context: ${fresh.override_model_limits.enabled ? "on" : "off"}`,
        `idle-refresh: ${fresh.idle_refresh.enabled ? "on" : "off"}`,
        `debug: ${fresh.debug ? "on" : "off"}`,
        `quiet: ${fresh.toasts.quiet ? "on" : "off"}`,
        `custom_betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
        `cache-boundary: ${fresh.cache_policy?.boundary_marker ? "on" : "off"}`,
        `cache-ttl: ${fresh.cache_policy?.ttl ?? "1h"}${fresh.cache_policy?.ttl_supported === false ? " (auto-disabled)" : ""}`,
        `fast-mode: ${fresh.fast_mode ? "on" : "off"}`,
        `telemetry-emulation: ${fresh.telemetry?.emulate_minimal ? "on (silent observer)" : "off"}`,
        `usage-toast: ${fresh.usage_toast ? "on" : "off"}`,
        `adaptive-context: ${fresh.adaptive_context?.enabled ? `on (\u2191${Math.round((fresh.adaptive_context.escalation_threshold || 15e4) / 1e3)}K \u2193${Math.round((fresh.adaptive_context.deescalation_threshold || 1e5) / 1e3)}K)${adaptiveContextState.active ? " [ACTIVE]" : ""}` : "off"}`,
        `anti-verbosity: ${fresh.anti_verbosity?.enabled !== false ? "on" : "off"} (length-anchors: ${fresh.anti_verbosity?.length_anchors !== false ? "on" : "off"})`
      ];
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }
    if (primary === "stats") {
      const secondary = (args[1] || "").toLowerCase();
      if (secondary === "reset") {
        sessionMetrics.turns = 0;
        sessionMetrics.usedTools.clear();
        sessionMetrics.totalInput = 0;
        sessionMetrics.totalOutput = 0;
        sessionMetrics.totalCacheRead = 0;
        sessionMetrics.totalCacheWrite = 0;
        sessionMetrics.totalWebSearchRequests = 0;
        sessionMetrics.recentCacheRates = [];
        sessionMetrics.sessionCostUsd = 0;
        sessionMetrics.costBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        sessionMetrics.sessionStartTime = Date.now();
        sessionMetrics.lastQuota = {
          tokens: 0,
          requests: 0,
          inputTokens: 0,
          updatedAt: 0,
          fiveHour: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
          sevenDay: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
          overallStatus: null,
          representativeClaim: null,
          fallback: null,
          fallbackPercentage: null,
          overageStatus: null,
          overageReason: null,
          lastPollAt: 0
        };
        sessionMetrics.lastStopReason = null;
        sessionMetrics.perModel = {};
        sessionMetrics.lastModelId = null;
        sessionMetrics.lastRequestBody = null;
        sessionMetrics.tokenBudget = { limit: 0, used: 0, continuations: 0, outputHistory: [] };
        await sendCommandMessage(input.sessionID, "\u25A3 Anthropic\n\nStats reset.");
        return;
      }
      const avgRate = getAverageCacheHitRate();
      const totalTokens = sessionMetrics.totalInput + sessionMetrics.totalOutput + sessionMetrics.totalCacheRead + sessionMetrics.totalCacheWrite;
      const avgPerTurn = sessionMetrics.turns > 0 ? Math.round(totalTokens / sessionMetrics.turns) : 0;
      const elapsedMin = (Date.now() - sessionMetrics.sessionStartTime) / 6e4;
      const burnRate = elapsedMin > 0 ? sessionMetrics.sessionCostUsd / elapsedMin : 0;
      const pricing = getModelPricing("claude-sonnet-4-6");
      const cacheSavings = sessionMetrics.totalCacheRead > 0 ? sessionMetrics.totalCacheRead / 1e6 * (pricing.input - pricing.cacheRead) : 0;
      const lines = [
        "\u25A3 Anthropic Session Stats",
        "",
        `Turns: ${sessionMetrics.turns} (${elapsedMin.toFixed(0)} min)`,
        `Avg tokens/turn: ${avgPerTurn.toLocaleString()}`,
        "",
        "Tokens:",
        `  Input:       ${sessionMetrics.totalInput.toLocaleString()}`,
        `  Output:      ${sessionMetrics.totalOutput.toLocaleString()}`,
        `  Cache read:  ${sessionMetrics.totalCacheRead.toLocaleString()}`,
        `  Cache write: ${sessionMetrics.totalCacheWrite.toLocaleString()}`,
        `  Total:       ${totalTokens.toLocaleString()}`
      ];
      if (sessionMetrics.totalWebSearchRequests > 0) {
        lines.push(`  Web searches: ${sessionMetrics.totalWebSearchRequests}`);
      }
      lines.push(
        "",
        `Cache efficiency: ${(avgRate * 100).toFixed(1)}% (last ${sessionMetrics.recentCacheRates.length} turns)`
      );
      if (cacheSavings > 0) {
        lines.push(`Cache savings:  ~$${cacheSavings.toFixed(4)} saved vs uncached`);
      }
      lines.push(
        "",
        "Cost breakdown:",
        `  Input:       $${sessionMetrics.costBreakdown.input.toFixed(4)}`,
        `  Output:      $${sessionMetrics.costBreakdown.output.toFixed(4)}`,
        `  Cache read:  $${sessionMetrics.costBreakdown.cacheRead.toFixed(4)}`,
        `  Cache write: $${sessionMetrics.costBreakdown.cacheWrite.toFixed(4)}`,
        `  Total:       $${sessionMetrics.sessionCostUsd.toFixed(4)}`
      );
      if (burnRate > 0) {
        lines.push(`Burn rate: $${(burnRate * 60).toFixed(2)}/hr`);
      }
      const modelIds = Object.keys(sessionMetrics.perModel);
      if (modelIds.length > 1) {
        lines.push("", "Per-model breakdown:");
        for (const mid of modelIds) {
          const pm = sessionMetrics.perModel[mid];
          const totalTk = pm.input + pm.output + pm.cacheRead + pm.cacheWrite;
          lines.push(`  ${mid}: ${totalTk.toLocaleString()} tokens, $${pm.costUsd.toFixed(4)} (${pm.turns} turns)`);
        }
      }
      const maxBudget = parseFloat(process.env.OPENCODE_ANTHROPIC_MAX_BUDGET_USD || "0");
      if (maxBudget > 0) {
        const pct = sessionMetrics.sessionCostUsd / maxBudget * 100;
        const remaining = maxBudget - sessionMetrics.sessionCostUsd;
        lines.push(
          `Budget: $${sessionMetrics.sessionCostUsd.toFixed(2)} / $${maxBudget.toFixed(2)} (${pct.toFixed(0)}%)`
        );
        if (burnRate > 0 && remaining > 0) {
          const minsLeft = remaining / burnRate;
          lines.push(
            `  Est. time remaining: ${minsLeft < 60 ? `${minsLeft.toFixed(0)} min` : `${(minsLeft / 60).toFixed(1)} hr`}`
          );
        }
      }
      if (sessionMetrics.lastQuota.updatedAt > 0) {
        const q = sessionMetrics.lastQuota;
        const q5h = q.fiveHour;
        const q7d = q.sevenDay;
        lines.push("", `Rate limit utilization:`);
        lines.push(
          `  5-hour: ${q5h.utilization.toFixed(0)}% used${q5h.status ? ` [${q5h.status}]` : ""}${q5h.resets_at ? ` (resets ${q5h.resets_at})` : ""}`
        );
        lines.push(
          `  7-day:  ${q7d.utilization.toFixed(0)}% used${q7d.status ? ` [${q7d.status}]` : ""}${q7d.resets_at ? ` (resets ${q7d.resets_at})` : ""}`
        );
        if (q.overallStatus)
          lines.push(
            `  Status: ${q.overallStatus}${q.representativeClaim ? ` (claim: ${q.representativeClaim})` : ""}`
          );
        if (q.fallback)
          lines.push(
            `  Fallback: ${q.fallback}${q.fallbackPercentage != null ? ` (${(q.fallbackPercentage * 100).toFixed(0)}%)` : ""}`
          );
        if (q.overageStatus)
          lines.push(`  Overage: ${q.overageStatus}${q.overageReason ? ` (${q.overageReason})` : ""}`);
      }
      const tb = sessionMetrics.tokenBudget;
      if (tb.limit > 0) {
        const pct = (tb.used / tb.limit * 100).toFixed(0);
        lines.push("", `Token budget: ${tb.used.toLocaleString()} / ${tb.limit.toLocaleString()} (${pct}%)`);
        lines.push(`  Continuations: ${tb.continuations}`);
        if (detectDiminishingReturns(tb.outputHistory)) {
          lines.push(`  Warning: Diminishing returns detected (last 3 outputs < 500 tokens)`);
        }
      }
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }
    if (primary === "quota") {
      const q = sessionMetrics.lastQuota;
      if (q.updatedAt === 0) {
        await sendCommandMessage(
          input.sessionID,
          "\u25A3 Anthropic Quota\n\nNo rate-limit data yet. Make at least one API request first."
        );
        return;
      }
      const agoSec = Math.round((Date.now() - q.updatedAt) / 1e3);
      const agoStr = agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`;
      const bar = (pct) => {
        const filled = Math.max(0, Math.min(20, Math.round(pct * 20)));
        return "[" + "\u2588".repeat(filled) + "\u2591".repeat(20 - filled) + "]";
      };
      const q5h = q.fiveHour;
      const q7d = q.sevenDay;
      const lines = [
        "\u25A3 Anthropic Rate Limit Quota",
        "",
        `5-hour window:`,
        `  ${bar(q5h.utilization / 100)} ${q5h.utilization.toFixed(0)}%${q5h.status ? `  [${q5h.status}]` : ""}`,
        q5h.resets_at ? `  Resets: ${q5h.resets_at}` : null,
        q5h.surpassedThreshold != null ? `  Surpassed threshold: ${(q5h.surpassedThreshold * 100).toFixed(0)}%` : null,
        "",
        `7-day window:`,
        `  ${bar(q7d.utilization / 100)} ${q7d.utilization.toFixed(0)}%${q7d.status ? `  [${q7d.status}]` : ""}`,
        q7d.resets_at ? `  Resets: ${q7d.resets_at}` : null,
        q7d.surpassedThreshold != null ? `  Surpassed threshold: ${(q7d.surpassedThreshold * 100).toFixed(0)}%` : null,
        ""
      ].filter(Boolean);
      if (q.overallStatus) {
        lines.push(
          `Overall status: ${q.overallStatus}${q.representativeClaim ? ` (claim: ${q.representativeClaim})` : ""}`
        );
      }
      if (q.fallback) {
        lines.push(
          `Fallback: ${q.fallback}${q.fallbackPercentage != null ? ` (${(q.fallbackPercentage * 100).toFixed(0)}% capacity)` : ""}`
        );
      }
      if (q.overageStatus) {
        lines.push(`Overage: ${q.overageStatus}${q.overageReason ? ` (${q.overageReason})` : ""}`);
      }
      lines.push("", `Last updated: ${agoStr}`);
      const maxUtil = Math.max(q5h.utilization, q7d.utilization) / 100;
      if (maxUtil >= 0.9) {
        lines.push("", "\u26A0 High utilization \u2014 consider slowing request rate or rotating accounts");
      } else if (maxUtil >= 0.7) {
        lines.push("", "Utilization is moderate. Consider monitoring if sustained.");
      }
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }
    if (primary === "context") {
      if (!sessionMetrics.lastRequestBody) {
        await sendCommandMessage(
          input.sessionID,
          "\u25A3 Anthropic Context\n\nNo request captured yet. Make at least one API request first."
        );
        return;
      }
      const analysis = analyzeRequestContext(sessionMetrics.lastRequestBody);
      const lines = [
        "\u25A3 Anthropic Context Breakdown (estimated)",
        "",
        `System:          ${analysis.systemTokens.toLocaleString()} tokens`,
        `User messages:   ${analysis.userTokens.toLocaleString()} tokens`
      ];
      if (analysis.toolResultTokens > 0) {
        lines.push(`  tool_result:   ${analysis.toolResultTokens.toLocaleString()} tokens`);
        const toolNames = Object.keys(analysis.toolBreakdown).sort(
          (a, b) => analysis.toolBreakdown[b].tokens - analysis.toolBreakdown[a].tokens
        );
        for (const name of toolNames) {
          const tb = analysis.toolBreakdown[name];
          lines.push(`    ${name}: ${tb.tokens.toLocaleString()} tokens  (${tb.count} blocks)`);
        }
      }
      lines.push(`Assistant:       ${analysis.assistantTokens.toLocaleString()} tokens`);
      lines.push(`Total:           ${analysis.totalTokens.toLocaleString()} tokens`);
      if (analysis.duplicates.count > 0) {
        lines.push(
          "",
          `\u26A0 ${analysis.duplicates.count} duplicate file contents detected (~${analysis.duplicates.wastedTokens.toLocaleString()} tokens wasted)`
        );
      }
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }
    if (primary === "accounts") {
      if (!accountManager || accountManager.getAccountCount() === 0) {
        await sendCommandMessage(
          input.sessionID,
          "\u25A3 Anthropic Accounts\n\nNo accounts configured. Use /anthropic login first."
        );
        return;
      }
      const accounts = accountManager.getEnabledAccounts();
      const lines = ["\u25A3 Anthropic Account Stats", ""];
      for (const acc of accounts) {
        const s = acc.stats;
        const totalTok = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
        const label = acc.email || `Account #${acc.index + 1}`;
        const isActive = accountManager.getCurrentIndex?.() === acc.index || false;
        const statusBadge = isActive ? " \u25C4 active" : "";
        const healthScore = accountManager.getHealthScore?.(acc.index) ?? "N/A";
        const cost = calculateCostUsd(
          {
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheReadTokens: s.cacheReadTokens,
            cacheWriteTokens: s.cacheWriteTokens
          },
          "claude-sonnet-4-6"
        );
        lines.push(
          `[${acc.index + 1}] ${label}${statusBadge}`,
          `  Requests: ${s.requests}  |  Tokens: ${totalTok.toLocaleString()}  |  Health: ${healthScore}`,
          `  Input: ${s.inputTokens.toLocaleString()}  Output: ${s.outputTokens.toLocaleString()}`,
          `  Cache R: ${s.cacheReadTokens.toLocaleString()}  Cache W: ${s.cacheWriteTokens.toLocaleString()}`,
          `  Est. cost: $${cost.toFixed(4)}`,
          ""
        );
      }
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }
    if (primary === "set") {
      const key = (args[1] || "").toLowerCase();
      const value = (args[2] || "").toLowerCase();
      const setters = {
        emulation: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ signature_emulation: { enabled } });
          config.signature_emulation.enabled = enabled;
        },
        compaction: () => {
          const mode = value === "off" ? "off" : "minimal";
          saveConfig({ signature_emulation: { prompt_compaction: mode } });
          config.signature_emulation.prompt_compaction = mode;
        },
        "1m-context": () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ override_model_limits: { enabled } });
          if (!config.override_model_limits) config.override_model_limits = { enabled: false };
          config.override_model_limits.enabled = enabled;
        },
        "idle-refresh": () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ idle_refresh: { enabled } });
          if (!config.idle_refresh) config.idle_refresh = { enabled: false };
          config.idle_refresh.enabled = enabled;
        },
        debug: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ debug: enabled });
          config.debug = enabled;
        },
        quiet: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ toasts: { quiet: enabled } });
          config.toasts.quiet = enabled;
        },
        strategy: () => {
          const valid = ["sticky", "round-robin", "hybrid"];
          if (valid.includes(value)) {
            saveConfig({ account_selection_strategy: value });
            strategyState.manualOverride = true;
            strategyState.mode = "CONFIGURED";
          } else throw new Error(`Invalid strategy. Valid: ${valid.join(", ")}`);
        },
        boundary: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ cache_policy: { boundary_marker: enabled } });
          if (!config.cache_policy) config.cache_policy = {};
          config.cache_policy.boundary_marker = enabled;
        },
        "cache-ttl": () => {
          const valid = ["1h", "5m", "off"];
          if (!valid.includes(value)) throw new Error(`Invalid TTL. Valid: ${valid.join(", ")}`);
          saveConfig({ cache_policy: { ttl: value } });
          if (!config.cache_policy) config.cache_policy = {};
          config.cache_policy.ttl = value;
        },
        fast: () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ fast_mode: enabled });
          config.fast_mode = enabled;
          _fastModeAppliedToast = false;
          toast(enabled ? "\u26A1 Fast mode ON (Opus 4.6 only)" : "\u26A1 Fast mode OFF", enabled ? "info" : "success", {
            debounceKey: "fast-mode-toggle"
          }).catch(() => {
          });
        },
        "fast-mode": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ fast_mode: enabled });
          config.fast_mode = enabled;
          _fastModeAppliedToast = false;
          toast(enabled ? "\u26A1 Fast mode ON (Opus 4.6 only)" : "\u26A1 Fast mode OFF", enabled ? "info" : "success", {
            debounceKey: "fast-mode-toggle"
          }).catch(() => {
          });
        },
        telemetry: () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ telemetry: { emulate_minimal: enabled } });
          config.telemetry = config.telemetry || {};
          config.telemetry.emulate_minimal = enabled;
        },
        "telemetry-emulation": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ telemetry: { emulate_minimal: enabled } });
          config.telemetry = config.telemetry || {};
          config.telemetry.emulate_minimal = enabled;
        },
        "usage-toast": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ usage_toast: enabled });
          config.usage_toast = enabled;
        },
        "adaptive-context": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ adaptive_context: { ...config.adaptive_context, enabled } });
          if (!config.adaptive_context)
            config.adaptive_context = {
              enabled: false,
              escalation_threshold: 15e4,
              deescalation_threshold: 1e5
            };
          config.adaptive_context.enabled = enabled;
          if (!enabled) {
            adaptiveContextState.active = false;
            adaptiveContextState.escalatedByError = false;
            adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
          }
          toast(enabled ? "\u2B21 Adaptive 1M context ON" : "\u2B21 Adaptive 1M context OFF", enabled ? "info" : "success", {
            debounceKey: "adaptive-ctx-toggle"
          }).catch(() => {
          });
        },
        "token-efficient-tools": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          const te = config.token_economy || {
            token_efficient_tools: true
          };
          te.token_efficient_tools = enabled;
          saveConfig({ token_economy: te });
          config.token_economy = te;
          betaLatchState.dirty = true;
        },
        "redact-thinking": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          const te = config.token_economy || {
            token_efficient_tools: true
          };
          te.redact_thinking = enabled;
          saveConfig({ token_economy: te });
          config.token_economy = te;
          betaLatchState.dirty = true;
        },
        "tool-deferral": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { tool_deferral: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.tool_deferral = enabled;
        },
        "tool-compaction": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { tool_description_compaction: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.tool_description_compaction = enabled;
        },
        "adaptive-tools": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { adaptive_tool_set: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.adaptive_tool_set = enabled;
        },
        "prompt-tailing": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { system_prompt_tailing: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.system_prompt_tailing = enabled;
        }
      };
      if (!key || !setters[key]) {
        const keys = Object.keys(setters).join(", ");
        await sendCommandMessage(
          input.sessionID,
          `\u25A3 Anthropic Set

Usage: /anthropic set <key> <value>
Keys: ${keys}
Values: on/off (or specific values for strategy/compaction)`
        );
        return;
      }
      if (!value) {
        await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Set

Missing value for "${key}".`);
        return;
      }
      setters[key]();
      Object.assign(config, loadConfigFresh());
      await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Set

${key} = ${value}`);
      return;
    }
    if (primary === "betas") {
      const action = (args[1] || "").toLowerCase();
      if (!action || action === "list") {
        const fresh = loadConfigFresh();
        const strategy = fresh.account_selection_strategy || config.account_selection_strategy;
        const lines = [
          "\u25A3 Anthropic Betas",
          "",
          "Preset betas (auto-computed per model/provider):",
          "  oauth-2025-04-20, claude-code-20250219,",
          "  advanced-tool-use-2025-11-20, fast-mode-2026-02-01,",
          "  interleaved-thinking-2025-05-14 (non-Opus 4.6) OR effort-2025-11-24 (Opus 4.6),",
          "  files-api-2025-04-14 (only /v1/files and requests with file_id),",
          "  token-counting-2024-11-01 (only /v1/messages/count_tokens),",
          `  prompt-caching-scope-2026-01-05 (non-interactive${strategy === "round-robin" ? ", skipped in round-robin" : ""})`,
          "",
          `Experimental betas: ${isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) ? "disabled (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1)" : "enabled"}`,
          `Strategy: ${strategy}${initialAccountPinned ? " (pinned via OPENCODE_ANTHROPIC_INITIAL_ACCOUNT)" : ""}`,
          `Custom betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
          "",
          "Toggleable presets:",
          "  /anthropic betas add structured-outputs-2025-12-15",
          "  /anthropic betas add context-management-2025-06-27",
          "  /anthropic betas add task-budgets-2026-03-13",
          "  /anthropic betas add web-search-2025-03-05",
          "  /anthropic betas add compact-2026-01-12",
          "  /anthropic betas add mcp-servers-2025-12-04",
          "  /anthropic betas add redact-thinking-2026-02-12",
          "  /anthropic betas add 1m   (shortcut for context-1m-2025-08-07)",
          "",
          "Remove: /anthropic betas remove <beta>"
        ];
        await sendCommandMessage(input.sessionID, lines.join("\n"));
        return;
      }
      if (action === "add") {
        const betaInput = args[2]?.trim();
        if (!betaInput) {
          await sendCommandMessage(input.sessionID, "\u25A3 Anthropic Betas\n\nUsage: /anthropic betas add <beta-name>");
          return;
        }
        const beta = resolveBetaShortcut(betaInput);
        const fresh = loadConfigFresh();
        const current = fresh.custom_betas || [];
        if (current.includes(beta)) {
          await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Betas

"${beta}" already added.`);
          return;
        }
        saveConfig({ custom_betas: [...current, beta] });
        Object.assign(config, loadConfigFresh());
        const fromShortcut = beta !== betaInput;
        await sendCommandMessage(
          input.sessionID,
          `\u25A3 Anthropic Betas

Added: ${beta}${fromShortcut ? ` (from shortcut: ${betaInput})` : ""}`
        );
        return;
      }
      if (action === "remove" || action === "rm") {
        const betaInput = args[2]?.trim();
        if (!betaInput) {
          await sendCommandMessage(input.sessionID, "\u25A3 Anthropic Betas\n\nUsage: /anthropic betas remove <beta-name>");
          return;
        }
        const beta = resolveBetaShortcut(betaInput);
        const fresh = loadConfigFresh();
        const current = fresh.custom_betas || [];
        if (!current.includes(beta)) {
          await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Betas

"${beta}" not in custom betas.`);
          return;
        }
        saveConfig({ custom_betas: current.filter((b) => b !== beta) });
        Object.assign(config, loadConfigFresh());
        await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Betas

Removed: ${beta}`);
        return;
      }
      await sendCommandMessage(input.sessionID, "\u25A3 Anthropic Betas\n\nUsage: /anthropic betas [add|remove <beta>]");
      return;
    }
    if (primary === "files") {
      let resolveTargetAccount = function(identifier) {
        const accounts = accountManager.getEnabledAccounts();
        if (identifier) {
          const byEmail = accounts.find((a) => a.email === identifier);
          if (byEmail) return { account: byEmail, label: byEmail.email || `Account ${byEmail.index + 1}` };
          const idx = parseInt(identifier, 10);
          if (!isNaN(idx) && idx >= 1) {
            const byIdx = accounts.find((a) => a.index === idx - 1);
            if (byIdx) return { account: byIdx, label: byIdx.email || `Account ${byIdx.index + 1}` };
          }
          return null;
        }
        const current = accountManager.getCurrentAccount();
        if (!current) return null;
        return { account: current, label: current.email || `Account ${current.index + 1}` };
      };
      let targetAccountId = null;
      const filteredArgs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--account" && i + 1 < args.length) {
          targetAccountId = args[i + 1];
          i++;
        } else {
          filteredArgs.push(args[i]);
        }
      }
      const action = (filteredArgs[1] || "").toLowerCase();
      if (!accountManager || accountManager.getAccountCount() === 0) {
        await sendCommandMessage(
          input.sessionID,
          "\u25A3 Anthropic Files (error)\n\nNo accounts configured. Use /anthropic login first."
        );
        return;
      }
      async function getFilesAuth(acct) {
        let tok = acct.access;
        if (!tok || !acct.expires || acct.expires < Date.now()) {
          tok = await refreshAccountTokenSingleFlight(acct);
        }
        return {
          authorization: `Bearer ${tok}`,
          "anthropic-beta": "oauth-2025-04-20,files-api-2025-04-14"
        };
      }
      const apiBase = "https://api.anthropic.com";
      try {
        if (!action || action === "list") {
          if (targetAccountId) {
            const resolved2 = resolveTargetAccount(targetAccountId);
            if (!resolved2) {
              await sendCommandMessage(
                input.sessionID,
                `\u25A3 Anthropic Files (error)

Account not found: ${targetAccountId}`
              );
              return;
            }
            const { account: account2, label: label2 } = resolved2;
            const headers = await getFilesAuth(account2);
            const res = await fetch(`${apiBase}/v1/files`, { headers });
            if (!res.ok) {
              const errBody = await res.text();
              await sendCommandMessage(
                input.sessionID,
                `\u25A3 Anthropic Files (error) [${label2}]

HTTP ${res.status}: ${errBody}`
              );
              return;
            }
            const data = await res.json();
            const files = data.data || [];
            for (const f of files) fileAccountMapSet(f.id, account2.index);
            if (files.length === 0) {
              await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Files [${label2}]

No files uploaded.`);
              return;
            }
            const lines = [`\u25A3 Anthropic Files [${label2}]`, "", `${files.length} file(s):`, ""];
            for (const f of files) {
              const sizeKB = ((f.size || 0) / 1024).toFixed(1);
              lines.push(`  ${f.id}  ${f.filename}  (${sizeKB} KB, ${f.purpose})`);
            }
            await sendCommandMessage(input.sessionID, lines.join("\n"));
            return;
          }
          const accounts = accountManager.getEnabledAccounts();
          const allLines = ["\u25A3 Anthropic Files (all accounts)", ""];
          let totalFiles = 0;
          for (const acct of accounts) {
            const label2 = acct.email || `Account ${acct.index + 1}`;
            try {
              const headers = await getFilesAuth(acct);
              const res = await fetch(`${apiBase}/v1/files`, { headers });
              if (!res.ok) {
                allLines.push(`[${label2}] Error: HTTP ${res.status}`);
                allLines.push("");
                continue;
              }
              const data = await res.json();
              const files = data.data || [];
              for (const f of files) fileAccountMapSet(f.id, acct.index);
              totalFiles += files.length;
              if (files.length === 0) {
                allLines.push(`[${label2}] No files`);
              } else {
                allLines.push(`[${label2}] ${files.length} file(s):`);
                for (const f of files) {
                  const sizeKB = ((f.size || 0) / 1024).toFixed(1);
                  allLines.push(`  ${f.id}  ${f.filename}  (${sizeKB} KB, ${f.purpose})`);
                }
              }
              allLines.push("");
            } catch (err) {
              allLines.push(`[${label2}] Error: ${err.message}`);
              allLines.push("");
            }
          }
          if (totalFiles === 0 && accounts.length > 0) {
            allLines.push(`Total: No files across ${accounts.length} account(s).`);
          } else {
            allLines.push(`Total: ${totalFiles} file(s) across ${accounts.length} account(s).`);
          }
          if (accounts.length > 1) {
            allLines.push("", "Tip: Use --account <email> to target a specific account.");
          }
          await sendCommandMessage(input.sessionID, allLines.join("\n"));
          return;
        }
        const resolved = resolveTargetAccount(targetAccountId);
        if (!resolved) {
          const errMsg = targetAccountId ? `Account not found: ${targetAccountId}` : "No accounts available.";
          await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Files (error)

${errMsg}`);
          return;
        }
        const { account, label } = resolved;
        const authHeaders = await getFilesAuth(account);
        if (action === "upload") {
          const filePath = filteredArgs.slice(2).join(" ").trim();
          if (!filePath) {
            await sendCommandMessage(
              input.sessionID,
              "\u25A3 Anthropic Files\n\nUsage: /anthropic files upload <path> [--account <email>]"
            );
            return;
          }
          const resolvedPath = resolve(filePath);
          if (!existsSync5(resolvedPath)) {
            await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Files (error)

File not found: ${resolvedPath}`);
            return;
          }
          const content = readFileSync5(resolvedPath);
          const filename = basename(resolvedPath);
          const blob = new Blob([content]);
          const form = new FormData();
          form.append("file", blob, filename);
          form.append("purpose", "assistants");
          const res = await fetch(`${apiBase}/v1/files`, {
            method: "POST",
            headers: {
              authorization: authHeaders.authorization,
              "anthropic-beta": "oauth-2025-04-20,files-api-2025-04-14"
            },
            body: form
          });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Files (error) [${label}]

Upload failed (HTTP ${res.status}): ${errBody}`
            );
            return;
          }
          const file = await res.json();
          const sizeKB = ((file.size || 0) / 1024).toFixed(1);
          fileAccountMapSet(file.id, account.index);
          await sendCommandMessage(
            input.sessionID,
            `\u25A3 Anthropic Files [${label}]

Uploaded: ${file.id}
  Filename: ${file.filename}
  Size: ${sizeKB} KB`
          );
          return;
        }
        if (action === "get" || action === "info") {
          const fileId = filteredArgs[2]?.trim();
          if (!fileId) {
            await sendCommandMessage(
              input.sessionID,
              "\u25A3 Anthropic Files\n\nUsage: /anthropic files get <file_id> [--account <email>]"
            );
            return;
          }
          const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, { headers: authHeaders });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Files (error) [${label}]

HTTP ${res.status}: ${errBody}`
            );
            return;
          }
          const file = await res.json();
          fileAccountMapSet(file.id, account.index);
          const lines = [
            `\u25A3 Anthropic Files [${label}]`,
            "",
            `  ID:       ${file.id}`,
            `  Filename: ${file.filename}`,
            `  Purpose:  ${file.purpose}`,
            `  Size:     ${((file.size || 0) / 1024).toFixed(1)} KB`,
            `  Type:     ${file.mime_type || "unknown"}`,
            `  Created:  ${file.created_at || "unknown"}`
          ];
          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }
        if (action === "delete" || action === "rm") {
          const fileId = filteredArgs[2]?.trim();
          if (!fileId) {
            await sendCommandMessage(
              input.sessionID,
              "\u25A3 Anthropic Files\n\nUsage: /anthropic files delete <file_id> [--account <email>]"
            );
            return;
          }
          const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, {
            method: "DELETE",
            headers: authHeaders
          });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Files (error) [${label}]

HTTP ${res.status}: ${errBody}`
            );
            return;
          }
          fileAccountMap.delete(fileId);
          await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Files [${label}]

Deleted: ${fileId}`);
          return;
        }
        if (action === "download" || action === "dl") {
          const fileId = filteredArgs[2]?.trim();
          if (!fileId) {
            await sendCommandMessage(
              input.sessionID,
              "\u25A3 Anthropic Files\n\nUsage: /anthropic files download <file_id> [output_path] [--account <email>]"
            );
            return;
          }
          const outputPath = filteredArgs.slice(3).join(" ").trim();
          const metaRes = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, {
            headers: authHeaders
          });
          if (!metaRes.ok) {
            const errBody = await metaRes.text();
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Files (error) [${label}]

HTTP ${metaRes.status}: ${errBody}`
            );
            return;
          }
          const meta = await metaRes.json();
          const savePath = outputPath ? resolve(outputPath) : resolve(meta.filename);
          const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}/content`, {
            headers: authHeaders
          });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Files (error) [${label}]

Download failed (HTTP ${res.status}): ${errBody}`
            );
            return;
          }
          const buffer = Buffer.from(await res.arrayBuffer());
          writeFileSync4(savePath, buffer);
          const sizeKB = (buffer.length / 1024).toFixed(1);
          await sendCommandMessage(
            input.sessionID,
            `\u25A3 Anthropic Files [${label}]

Downloaded: ${meta.filename}
  Saved to: ${savePath}
  Size: ${sizeKB} KB`
          );
          return;
        }
        const helpLines = [
          "\u25A3 Anthropic Files",
          "",
          "Usage: /anthropic files <action> [--account <email|index>]",
          "",
          "Actions:",
          "  list                          List uploaded files (all accounts if no --account)",
          "  upload <path>                 Upload a file (max 350MB)",
          "  get <file_id>                 Get file metadata",
          "  delete <file_id>              Delete a file",
          "  download <file_id> [path]     Download file content",
          "",
          "Options:",
          "  --account <email|index>       Target a specific account (1-based index)",
          "",
          "Supported formats: PDF, DOCX, TXT, CSV, Excel, Markdown, images",
          "Files can be referenced by file_id in Messages API requests.",
          "",
          "When using round-robin, file_ids are automatically pinned to the",
          "account that owns them for Messages API requests."
        ];
        await sendCommandMessage(input.sessionID, helpLines.join("\n"));
        return;
      } catch (err) {
        await sendCommandMessage(input.sessionID, `\u25A3 Anthropic Files (error)

${err.message}`);
        return;
      }
    }
    if (primary === "review") {
      let parseBughunterSeverity = function(text) {
        const m = text.match(/bughunter-severity:\s*(\{[^}]+\})/);
        if (!m) return null;
        try {
          return JSON.parse(m[1]);
        } catch {
          return null;
        }
      }, formatSeverity = function(sev) {
        const parts = [];
        if (sev.normal > 0) parts.push(`\u{1F534} Important: ${sev.normal}`);
        if (sev.nit > 0) parts.push(`\u{1F7E1} Nit: ${sev.nit}`);
        if (sev.pre_existing > 0) parts.push(`\u{1F7E3} Pre-existing: ${sev.pre_existing}`);
        if (parts.length === 0) parts.push("No issues found");
        return parts.join("  |  ");
      };
      const action = (args[1] || "").toLowerCase();
      async function execShell(cmd, cmdArgs) {
        const { execFile } = await import("node:child_process");
        return new Promise((resolve2) => {
          execFile(cmd, cmdArgs, { timeout: 3e4, maxBuffer: 2 * 1024 * 1024 }, (err, stdout3, stderr) => {
            resolve2({
              stdout: (stdout3 || "").trim(),
              stderr: (stderr || "").trim(),
              code: err ? err.code || 1 : 0
            });
          });
        });
      }
      const ghCheck = await execShell("gh", ["--version"]);
      if (ghCheck.code !== 0) {
        await sendCommandMessage(
          input.sessionID,
          "\u25A3 Anthropic Review (error)\n\nGitHub CLI (gh) not found. Install it from https://cli.github.com/"
        );
        return;
      }
      const repoResult = await execShell("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
      if (repoResult.code !== 0 || !repoResult.stdout) {
        await sendCommandMessage(
          input.sessionID,
          "\u25A3 Anthropic Review (error)\n\nCould not detect GitHub repository. Ensure you are in a git repo with a GitHub remote."
        );
        return;
      }
      const repo = repoResult.stdout.trim();
      try {
        if (action === "status") {
          const checkResult = await execShell("gh", [
            "api",
            `repos/${repo}/commits/HEAD/check-runs`,
            "--jq",
            '.check_runs[] | select(.name | test("claude|bughunter"; "i")) | .name + " \u2014 " + .status + " (" + .conclusion + ")"'
          ]);
          const lines = ["\u25A3 Anthropic Review \u2014 Status", "", `Repository: ${repo}`, ""];
          if (checkResult.stdout) {
            lines.push("Recent Claude check runs:", checkResult.stdout);
          } else {
            lines.push(
              "No Claude Code Review check runs found on HEAD.",
              "",
              "Code Review must be enabled by an admin at claude.ai/admin-settings.",
              "It requires a Teams or Enterprise subscription."
            );
          }
          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }
        if (!action || action === "pr") {
          const prNumber = args[2] ? parseInt(args[2], 10) : null;
          let prRef;
          if (prNumber) {
            prRef = String(prNumber);
          } else {
            const branchResult = await execShell("git", ["branch", "--show-current"]);
            const currentBranch = branchResult.stdout.trim();
            if (!currentBranch) {
              await sendCommandMessage(
                input.sessionID,
                "\u25A3 Anthropic Review (error)\n\nDetached HEAD \u2014 specify a PR number: /anthropic review pr <number>"
              );
              return;
            }
            const prLookup = await execShell("gh", [
              "pr",
              "list",
              "--head",
              currentBranch,
              "--json",
              "number,title,state",
              "--limit",
              "1"
            ]);
            if (prLookup.code !== 0 || !prLookup.stdout || prLookup.stdout === "[]") {
              await sendCommandMessage(
                input.sessionID,
                `\u25A3 Anthropic Review (error)

No PR found for branch "${currentBranch}".
Use: /anthropic review pr <number>`
              );
              return;
            }
            const prs = JSON.parse(prLookup.stdout);
            if (!prs.length) {
              await sendCommandMessage(
                input.sessionID,
                `\u25A3 Anthropic Review (error)

No PR found for branch "${currentBranch}".`
              );
              return;
            }
            prRef = String(prs[0].number);
          }
          const prData = await execShell("gh", ["pr", "view", prRef, "--json", "number,title,headRefOid,state,url"]);
          if (prData.code !== 0) {
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Review (error)

Could not fetch PR #${prRef}: ${prData.stderr}`
            );
            return;
          }
          const pr = JSON.parse(prData.stdout);
          const sha = pr.headRefOid;
          const checksResult = await execShell("gh", [
            "api",
            `repos/${repo}/commits/${sha}/check-runs`,
            "--jq",
            '.check_runs[] | select(.name | test("claude|bughunter"; "i"))'
          ]);
          const lines = [
            "\u25A3 Anthropic Review",
            "",
            `PR #${pr.number}: ${pr.title}`,
            `State: ${pr.state}  |  Commit: ${sha.slice(0, 8)}`,
            `URL: ${pr.url}`,
            ""
          ];
          if (!checksResult.stdout) {
            lines.push(
              "No Claude Code Review check runs found for this PR.",
              "",
              "Possible reasons:",
              "  \u2022 Code Review not enabled for this repository",
              "  \u2022 Review still in progress (avg ~20 min)",
              "  \u2022 PR is a draft (drafts are not auto-reviewed)"
            );
            await sendCommandMessage(input.sessionID, lines.join("\n"));
            return;
          }
          const checkRunsRaw = `[${checksResult.stdout.split("\n}\n").join("},\n")}]`.replace(/,\s*]$/, "]").replace(/}\s*{/g, "},{");
          let checkRuns;
          try {
            checkRuns = JSON.parse(checkRunsRaw);
            if (!Array.isArray(checkRuns)) checkRuns = [checkRuns];
          } catch {
            try {
              checkRuns = [JSON.parse(checksResult.stdout)];
            } catch {
              lines.push(
                "Found check run(s) but could not parse output.",
                "",
                "Raw:",
                checksResult.stdout.slice(0, 500)
              );
              await sendCommandMessage(input.sessionID, lines.join("\n"));
              return;
            }
          }
          for (const run of checkRuns) {
            lines.push(`Check: ${run.name}`);
            lines.push(`  Status: ${run.status}  |  Conclusion: ${run.conclusion || "pending"}`);
            if (run.html_url) lines.push(`  Details: ${run.html_url}`);
            const outputText = run.output?.text || "";
            const severity = parseBughunterSeverity(outputText);
            if (severity) {
              lines.push(`  Findings: ${formatSeverity(severity)}`);
              const total = severity.normal + severity.nit + severity.pre_existing;
              lines.push(`  Total: ${total} issue${total !== 1 ? "s" : ""}`);
            } else if (run.status === "completed") {
              lines.push("  Findings: No bughunter-severity data in output");
            } else {
              lines.push("  Review is still in progress...");
            }
            lines.push("");
          }
          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }
        if (action === "branch") {
          const branchName = args[2] || (await execShell("git", ["branch", "--show-current"])).stdout.trim();
          if (!branchName) {
            await sendCommandMessage(
              input.sessionID,
              "\u25A3 Anthropic Review (error)\n\nNo branch specified and HEAD is detached."
            );
            return;
          }
          const prLookup = await execShell("gh", [
            "pr",
            "list",
            "--head",
            branchName,
            "--json",
            "number,title,state,headRefOid,url",
            "--limit",
            "5"
          ]);
          if (prLookup.code !== 0 || !prLookup.stdout || prLookup.stdout === "[]") {
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Review (error)

No PRs found for branch "${branchName}".`
            );
            return;
          }
          const prs = JSON.parse(prLookup.stdout);
          if (!prs.length) {
            await sendCommandMessage(
              input.sessionID,
              `\u25A3 Anthropic Review (error)

No PRs found for branch "${branchName}".`
            );
            return;
          }
          const lines = ["\u25A3 Anthropic Review \u2014 Branch", "", `Branch: ${branchName}`, ""];
          for (const pr of prs) {
            lines.push(`PR #${pr.number}: ${pr.title} (${pr.state})`);
            const checksResult = await execShell("gh", [
              "api",
              `repos/${repo}/commits/${pr.headRefOid}/check-runs`,
              "--jq",
              '.check_runs[] | select(.name | test("claude|bughunter"; "i"))'
            ]);
            if (!checksResult.stdout) {
              lines.push("  No Claude Code Review check runs found.", "");
              continue;
            }
            let checkRuns;
            try {
              const raw = `[${checksResult.stdout.split("\n}\n").join("},\n")}]`.replace(/,\s*]$/, "]").replace(/}\s*{/g, "},{");
              checkRuns = JSON.parse(raw);
              if (!Array.isArray(checkRuns)) checkRuns = [checkRuns];
            } catch {
              try {
                checkRuns = [JSON.parse(checksResult.stdout)];
              } catch {
                lines.push("  Could not parse check run output.", "");
                continue;
              }
            }
            for (const run of checkRuns) {
              lines.push(`  Check: ${run.name} \u2014 ${run.status} (${run.conclusion || "pending"})`);
              const outputText = run.output?.text || "";
              const severity = parseBughunterSeverity(outputText);
              if (severity) {
                lines.push(`  ${formatSeverity(severity)}`);
              }
            }
            lines.push("");
          }
          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }
        const helpLines = [
          "\u25A3 Anthropic Review (Claude Code Review / Bughunter)",
          "",
          "Fetch and display code review results from Claude's automated PR reviewer.",
          "",
          "Usage:",
          "  /anthropic review                    Review for current branch's PR",
          "  /anthropic review pr <number>        Review for a specific PR",
          "  /anthropic review branch [<name>]    Review for PRs on a branch",
          "  /anthropic review status             Check if review is configured",
          "",
          "Severity levels:",
          "  \u{1F534} Important \u2014 bugs that should be fixed before merge",
          "  \u{1F7E1} Nit \u2014 minor issues, worth fixing but not blocking",
          "  \u{1F7E3} Pre-existing \u2014 bugs in codebase not introduced by this PR",
          "",
          "Requirements:",
          "  \u2022 GitHub CLI (gh) must be installed and authenticated",
          "  \u2022 Code Review must be enabled at claude.ai/admin-settings",
          "  \u2022 Requires Teams or Enterprise subscription",
          "",
          "Machine-readable severity from check runs:",
          `  gh api repos/OWNER/REPO/check-runs/ID --jq '.output.text | split("bughunter-severity: ")[1] | split(" -->")[0] | fromjson'`
        ];
        await sendCommandMessage(input.sessionID, helpLines.join("\n"));
        return;
      } catch (err) {
        await sendCommandMessage(
          input.sessionID,
          `\u25A3 Anthropic Review (error)

${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
    }
    if (primary === "manage" || primary === "mg") {
      await sendCommandMessage(
        input.sessionID,
        "\u25A3 Anthropic\n\n`manage` is interactive-only. Use granular slash commands (switch/enable/disable/remove/reset) or run `opencode-anthropic-auth manage` in a terminal."
      );
      return;
    }
    const cliArgs = [...args];
    if (cliArgs.length === 0) cliArgs.push("list");
    if ((primary === "remove" || primary === "rm" || primary === "logout" || primary === "lo") && !cliArgs.includes("--force")) {
      cliArgs.push("--force");
    }
    const result = await runCliCommand(cliArgs);
    const heading = result.code === 0 ? "\u25A3 Anthropic" : "\u25A3 Anthropic (error)";
    const body = result.stdout || result.stderr || "No output.";
    await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
    await reloadAccountManagerFromDisk();
  }
  async function toast(message, variant = "info", options = {}) {
    if (config.toasts.quiet && variant !== "error") return;
    const normalizedVariant = variant === "warning" ? "info" : variant;
    if (variant !== "error" && options.debounceKey) {
      const minGapMs = Math.max(0, config.toasts.debounce_seconds) * 1e3;
      if (minGapMs > 0) {
        const now = Date.now();
        const lastAt = debouncedToastTimestamps.get(options.debounceKey) ?? 0;
        if (now - lastAt < minGapMs) {
          return;
        }
        debouncedToastTimestamps.set(options.debounceKey, now);
        if (debouncedToastTimestamps.size > 200) {
          const cutoff = now - 3e5;
          for (const [k, ts] of debouncedToastTimestamps) {
            if (ts < cutoff) debouncedToastTimestamps.delete(k);
          }
        }
      }
    }
    try {
      await client.tui?.showToast({ body: { message, variant: normalizedVariant } });
    } catch {
    }
  }
  function debugLog(...args) {
    if (!config.debug) return;
    console.error("[opencode-anthropic-auth]", ...args);
  }
  function recordRateLimitForStrategy() {
    const now = Date.now();
    strategyState.rateLimitEvents.push(now);
    strategyState.lastRateLimitTime = now;
    const cutoff = now - strategyState.windowMs;
    strategyState.rateLimitEvents = strategyState.rateLimitEvents.filter((t2) => t2 > cutoff);
    if (strategyState.mode === "CONFIGURED" && !strategyState.manualOverride) {
      if (strategyState.rateLimitEvents.length >= strategyState.thresholdCount) {
        strategyState.originalStrategy = config.account_selection_strategy;
        strategyState.mode = "DEGRADED";
        debugLog("auto-strategy: transitioning to DEGRADED mode", {
          rateLimitsInWindow: strategyState.rateLimitEvents.length
        });
        toast("Multiple rate limits detected, temporarily rotating accounts more aggressively", "warning", {
          debounceKey: "strategy-degraded"
        }).catch(() => {
        });
      }
    }
  }
  function checkStrategyRecovery() {
    if (strategyState.mode !== "DEGRADED" || strategyState.manualOverride) return;
    const now = Date.now();
    if (now - strategyState.lastRateLimitTime >= strategyState.recoveryMs) {
      strategyState.mode = "CONFIGURED";
      strategyState.rateLimitEvents = [];
      debugLog("auto-strategy: recovered to CONFIGURED mode");
      toast("Rate limit pressure relieved, restoring normal account selection", "info", {
        debounceKey: "strategy-recovered"
      }).catch(() => {
      });
    }
  }
  function getEffectiveStrategy() {
    if (strategyState.mode === "DEGRADED") return "hybrid";
    return config.account_selection_strategy;
  }
  let claudeCliVersion = FALLBACK_CLAUDE_CLI_VERSION;
  const signatureSessionId = randomUUID();
  const signatureUserId = getOrCreateDeviceId();
  if (shouldFetchClaudeCodeVersion) {
    fetchLatestClaudeCodeVersion().then((version) => {
      if (!version) return;
      claudeCliVersion = version;
      debugLog("resolved claude-code version from npm", version);
    }).catch(() => {
    });
  }
  function parseRefreshFailure(refreshError) {
    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
    const status = typeof refreshError === "object" && refreshError && "status" in refreshError ? Number(refreshError.status) : NaN;
    const errorCode = typeof refreshError === "object" && refreshError && ("errorCode" in refreshError || "code" in refreshError) ? String(refreshError.errorCode || refreshError.code || "") : "";
    const retryAfterMs = typeof refreshError === "object" && refreshError && "retryAfterMs" in refreshError ? Number(refreshError.retryAfterMs) : NaN;
    const retryAfterSource = typeof refreshError === "object" && refreshError && "retryAfterSource" in refreshError ? String(refreshError.retryAfterSource || "") : "";
    const msgLower = message.toLowerCase();
    const isInvalidGrant = errorCode === "invalid_grant" || errorCode === "invalid_request" || msgLower.includes("invalid_grant");
    const isTerminalStatus = status === 400 || status === 401 || status === 403;
    const isRateLimitStatus = status === 429;
    return {
      message,
      status,
      errorCode,
      retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null,
      retryAfterSource: retryAfterSource || "unknown",
      isInvalidGrant,
      isTerminalStatus,
      isRateLimitStatus
    };
  }
  async function refreshAccountTokenSingleFlight(account, source = "foreground") {
    const key = account.id;
    const existing = refreshInFlight.get(key);
    if (existing) {
      if (source === "foreground" && existing.source === "idle") {
        try {
          await existing.promise;
        } catch {
        }
        if (account.access && account.expires && account.expires > Date.now()) {
          return account.access;
        }
      } else {
        return existing.promise;
      }
    }
    const entry = { source, promise: Promise.resolve("") };
    const p = (async () => {
      try {
        return await refreshAccountToken(account, client, source, {
          onTokensUpdated: async () => {
            try {
              await accountManager.saveToDisk();
            } catch {
              accountManager.requestSaveToDisk();
              throw new Error("save failed, debounced retry scheduled");
            }
          }
        });
      } finally {
        if (refreshInFlight.get(key) === entry) {
          refreshInFlight.delete(key);
        }
      }
    })();
    entry.promise = p;
    refreshInFlight.set(key, entry);
    return p;
  }
  async function refreshIdleAccount(account) {
    if (!accountManager) return;
    if (idleRefreshInFlight.has(account.id)) return;
    if (account.source === "cc-keychain" || account.source === "cc-file") return;
    idleRefreshInFlight.add(account.id);
    const attemptedRefreshToken = account.refreshToken;
    try {
      try {
        await refreshAccountTokenSingleFlight(account, "idle");
        return;
      } catch (err) {
        let details = parseRefreshFailure(err);
        if (!(details.isInvalidGrant || details.isTerminalStatus)) {
          debugLog("idle refresh skipped after transient failure", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message
          });
          return;
        }
        const diskAuth = await readDiskAccountAuth(account.id);
        const retryToken = diskAuth?.refreshToken;
        if (retryToken && retryToken !== attemptedRefreshToken && account.refreshToken === attemptedRefreshToken) {
          account.refreshToken = retryToken;
          if (diskAuth?.tokenUpdatedAt) {
            account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
          } else {
            markTokenStateUpdated(account);
          }
        }
        try {
          await refreshAccountTokenSingleFlight(account, "idle");
          return;
        } catch (retryErr) {
          details = parseRefreshFailure(retryErr);
          debugLog("idle refresh retry failed", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message
          });
          return;
        }
      }
    } finally {
      idleRefreshInFlight.delete(account.id);
    }
  }
  function maybeRefreshIdleAccounts(activeAccount) {
    if (!getIdleRefreshEnabled() || !accountManager) return;
    const now = Date.now();
    const excluded = /* @__PURE__ */ new Set([activeAccount.index]);
    const candidates = accountManager.getEnabledAccounts(excluded).filter((acc) => !acc.expires || acc.expires <= now + getIdleRefreshWindowMs()).filter((acc) => {
      const last = idleRefreshLastAttempt.get(acc.id) ?? 0;
      return now - last >= getIdleRefreshMinIntervalMs();
    }).sort((a, b) => (a.expires ?? 0) - (b.expires ?? 0));
    const target = candidates[0];
    if (!target) return;
    idleRefreshLastAttempt.set(target.id, now);
    const allKnown = accountManager.getAccountsSnapshot();
    if (idleRefreshLastAttempt.size > allKnown.length + 10) {
      const validIds = new Set(allKnown.map((a) => a.id));
      for (const key of idleRefreshLastAttempt.keys()) {
        if (!validIds.has(key)) idleRefreshLastAttempt.delete(key);
      }
    }
    void refreshIdleAccount(target);
  }
  return {
    // A1-A4: System prompt transform (unchanged)
    "experimental.chat.system.transform": (input, output) => {
      const prefix = CLAUDE_CODE_IDENTITY_STRING;
      if (!getSignatureEmulationEnabled() && input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1]) {
          if (typeof output.system[1] === "string") {
            output.system[1] = prefix + "\n\n" + output.system[1];
          } else if (output.system[1] && typeof output.system[1] === "object" && output.system[1].text) {
            output.system[1] = { ...output.system[1], text: prefix + "\n\n" + output.system[1].text };
          }
        }
      }
    },
    config: async (input) => {
      if (!input.command) input.command = {};
      input.command["anthropic"] = {
        template: "/anthropic",
        description: "Manage Anthropic auth, config, betas, review (usage, login, config, set, betas, review, switch)"
      };
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "anthropic") return;
      output.noReply = true;
      try {
        await handleAnthropicSlashCommand(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sendCommandMessage(input.sessionID, `\u25A3 Anthropic (error)

${message}`);
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 }
            };
            if (config.override_model_limits.enabled && !isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT) && (hasOneMillionContext(model.id) || isOpus46Model(model.id) || isOpus47Model(model.id))) {
              model.limit = {
                ...model.limit ?? {},
                context: config.override_model_limits.context,
                ...config.override_model_limits.output > 0 ? { output: config.override_model_limits.output } : {}
              };
            }
          }
          accountManager = await AccountManager.load(config, {
            refresh: auth.refresh,
            access: auth.access,
            expires: auth.expires
          });
          if (accountManager.getAccountCount() > 0) {
            await accountManager.saveToDisk();
          }
          const initialAccountEnv = process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT?.trim();
          if (initialAccountEnv && accountManager.getAccountCount() > 1) {
            const accounts = accountManager.getEnabledAccounts();
            let target = null;
            const asIndex = parseInt(initialAccountEnv, 10);
            if (!isNaN(asIndex) && asIndex >= 1) {
              target = accounts.find((a) => a.index === asIndex - 1) ?? null;
            }
            if (!target) {
              target = accounts.find((a) => a.email && a.email.toLowerCase() === initialAccountEnv.toLowerCase());
            }
            if (target && accountManager.forceCurrentIndex(target.index)) {
              config.account_selection_strategy = "sticky";
              initialAccountPinned = true;
              debugLog("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: pinned to account", {
                index: target.index + 1,
                email: target.email,
                strategy: "sticky (overridden)"
              });
            } else {
              debugLog("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: could not resolve account", initialAccountEnv);
            }
          }
          const telemetryEnabled = config.telemetry?.emulate_minimal || isTruthyEnv(process.env.OPENCODE_ANTHROPIC_TELEMETRY_EMULATE);
          const firstAccount = accountManager.getEnabledAccounts()[0];
          telemetryEmitter.init({
            enabled: telemetryEnabled,
            deviceId: getOrCreateDeviceId(),
            cliVersion: claudeCliVersion,
            accountUuid: getAccountIdentifier(firstAccount),
            orgUuid: process.env.CLAUDE_CODE_ORGANIZATION_UUID || "",
            sessionId: signatureSessionId
          });
          preconnectApi(config);
          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              const currentAuth = await getAuth();
              if (currentAuth.type !== "oauth") return fetch(input, init);
              const requestInit = init ?? {};
              const { requestInput, requestUrl } = transformRequestUrl(input);
              const requestMethod = String(
                requestInit.method || (requestInput instanceof Request ? requestInput.method : "POST")
              ).toUpperCase();
              let showUsageToast;
              try {
                showUsageToast = new URL(requestUrl).pathname === "/v1/messages" && requestMethod === "POST";
              } catch {
                showUsageToast = false;
              }
              let lastError = null;
              const transientRefreshSkips = /* @__PURE__ */ new Set();
              if (accountManager && !initialAccountPinned) {
                await accountManager.syncActiveIndexFromDisk();
              }
              {
                const _now = Date.now();
                if (_now - _lastOAuthPruneTime > 6e4) {
                  _lastOAuthPruneTime = _now;
                  pruneExpiredPendingOAuth();
                }
              }
              if (getWillowEnabled() && showUsageToast) {
                const now = Date.now();
                const idleMs = now - willowLastRequestTime;
                const cooldownOk = now - willowLastSuggestionTime >= getWillowCooldownMs();
                if (idleMs >= getWillowIdleThresholdMs() && cooldownOk && sessionMetrics.turns >= getWillowMinTurns()) {
                  const idleMin = Math.round(idleMs / 6e4);
                  willowLastSuggestionTime = now;
                  toast(
                    `\u{1F33F} Idle for ${idleMin}m with ${sessionMetrics.turns} turns of context. Consider /clear for a fresh start.`,
                    "info",
                    { debounceKey: "willow-idle" }
                  ).catch(() => {
                  });
                  debugLog("willow mode: idle return detected", { idleMin, turns: sessionMetrics.turns });
                }
                willowLastRequestTime = now;
              }
              const maxAttempts = Math.max(1, accountManager.getAccountCount());
              let _parsedBodyOnce = null;
              if (typeof requestInit.body === "string") {
                try {
                  _parsedBodyOnce = JSON.parse(requestInit.body);
                } catch {
                }
              }
              let pinnedAccount = null;
              if (_parsedBodyOnce && fileAccountMap.size > 0) {
                const fileIds = extractFileIds(_parsedBodyOnce);
                for (const fid of fileIds) {
                  const pinnedIndex = fileAccountMap.get(fid);
                  if (pinnedIndex !== void 0) {
                    const candidates = accountManager.getEnabledAccounts();
                    pinnedAccount = candidates.find((a) => a.index === pinnedIndex) ?? null;
                    if (pinnedAccount) {
                      debugLog("file-id pinning: routing to account", {
                        fileId: fid,
                        accountIndex: pinnedIndex,
                        email: pinnedAccount.email
                      });
                      break;
                    }
                  }
                }
              }
              let serviceWideRetryCount = 0;
              let shouldRetryCount = 0;
              let consecutive529Count = 0;
              const requestClass = config.request_classification?.enabled !== false ? classifyApiRequest(requestInit.body) : "foreground";
              const maxServiceRetries = requestClass === "background" ? config.request_classification?.background_max_service_retries ?? 0 : 2;
              const maxShouldRetries = requestClass === "background" ? config.request_classification?.background_max_should_retries ?? 1 : 3;
              let _adaptiveDecisionMade = false;
              let _adaptiveOverrideForRequest;
              let _overloadRecoveryAttempted = false;
              let _connectionResetRetries = 0;
              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const account = attempt === 0 && pinnedAccount && !transientRefreshSkips.has(pinnedAccount.index) ? pinnedAccount : accountManager.getCurrentAccount(transientRefreshSkips);
                if (showUsageToast && account && accountManager) {
                  const currentIndex = accountManager.getCurrentIndex();
                  if (currentIndex !== lastToastedIndex) {
                    const name = account.email || `Account ${currentIndex + 1}`;
                    const total = accountManager.getAccountCount();
                    const msg = total > 1 ? `Claude: ${name} (${currentIndex + 1}/${total})` : `Claude: ${name}`;
                    await toast(msg, "info", { debounceKey: "account-usage" });
                    lastToastedIndex = currentIndex;
                  }
                }
                if (!account) {
                  const enabledCount = accountManager.getAccountCount();
                  if (enabledCount === 0) {
                    throw new Error(
                      "No enabled Anthropic accounts available. Enable one with 'opencode-anthropic-auth enable <N>'."
                    );
                  }
                  throw new Error("No available Anthropic account for request.");
                }
                let accessToken;
                if (!account.access || !account.expires || account.expires < Date.now() + 3e5) {
                  const attemptedRefreshToken = account.refreshToken;
                  try {
                    accessToken = await refreshAccountTokenSingleFlight(account);
                  } catch (err) {
                    let finalError = err;
                    let details = parseRefreshFailure(err);
                    if (details.isInvalidGrant || details.isTerminalStatus) {
                      const diskAuth = await readDiskAccountAuth(account.id);
                      const retryToken = diskAuth?.refreshToken;
                      if (retryToken && retryToken !== attemptedRefreshToken && account.refreshToken === attemptedRefreshToken) {
                        debugLog("refresh token on disk differs from in-memory, retrying with disk token", {
                          accountIndex: account.index
                        });
                        account.refreshToken = retryToken;
                        if (diskAuth?.tokenUpdatedAt) {
                          account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
                        } else {
                          markTokenStateUpdated(account);
                        }
                      } else if (retryToken && retryToken !== attemptedRefreshToken) {
                        debugLog("skipping disk token adoption because in-memory token already changed", {
                          accountIndex: account.index
                        });
                      }
                      try {
                        accessToken = await refreshAccountTokenSingleFlight(account);
                      } catch (retryErr) {
                        finalError = retryErr;
                        details = parseRefreshFailure(retryErr);
                        debugLog("retry refresh failed", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message
                        });
                      }
                    }
                    if (!accessToken) {
                      if (details.isRateLimitStatus) {
                        const backoffMs = accountManager.markRateLimited(
                          account,
                          "RATE_LIMIT_EXCEEDED",
                          details.retryAfterMs
                        );
                        debugLog("oauth refresh rate limited", {
                          accountIndex: account.index,
                          retryAfterMs: details.retryAfterMs,
                          retryAfterSource: details.retryAfterSource
                        });
                        transientRefreshSkips.add(account.index);
                        const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                        await toast(
                          `${name} OAuth refresh rate-limited; pausing ${Math.ceil(backoffMs / 1e3)}s`,
                          "warning"
                        );
                      } else {
                        accountManager.markFailure(account);
                      }
                      if (details.isInvalidGrant || details.isTerminalStatus) {
                        const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                        debugLog("disabling account after terminal refresh failure", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message
                        });
                        account.enabled = false;
                        accountManager.requestSaveToDisk();
                        const statusLabel = Number.isFinite(details.status) ? `HTTP ${details.status}` : "unknown status";
                        await toast(
                          `Disabled ${name} (token refresh failed: ${details.errorCode || statusLabel})`,
                          "error"
                        );
                      } else if (!details.isRateLimitStatus) {
                        transientRefreshSkips.add(account.index);
                      }
                      lastError = finalError;
                      continue;
                    }
                  }
                } else {
                  accessToken = account.access;
                }
                if (accessToken) liveTokenRef.token = accessToken;
                maybeRefreshIdleAccounts(account);
                const { model: _reqModel, hasFileReferences: _reqHasFileRefs } = parseRequestBodyMetadata(
                  requestInit.body,
                  _parsedBodyOnce
                );
                const _reqProvider = detectProvider(requestUrl);
                if (!_adaptiveDecisionMade) {
                  _adaptiveDecisionMade = true;
                  const _prevAdaptiveState = adaptiveContextState.active;
                  const _use1MContext = resolveAdaptiveContext(
                    requestInit.body,
                    _reqModel,
                    config.adaptive_context || {
                      enabled: true,
                      escalation_threshold: 15e4,
                      deescalation_threshold: 1e5
                    },
                    _parsedBodyOnce
                  );
                  if (config.adaptive_context?.enabled && _prevAdaptiveState !== adaptiveContextState.active) {
                    const label = adaptiveContextState.active ? "1M context ON" : "1M context OFF";
                    const variant = adaptiveContextState.active ? "info" : "success";
                    const est = _parsedBodyOnce ? estimatePromptTokensFromParsed(_parsedBodyOnce) : estimatePromptTokens(requestInit.body);
                    toast(`\u2B21 ${label} (est. ${Math.round(est / 1e3)}K tokens)`, variant, {
                      debounceKey: "adaptive-ctx"
                    }).catch(() => {
                    });
                  }
                  _adaptiveOverrideForRequest = config.adaptive_context?.enabled ? { use1MContext: _use1MContext } : void 0;
                }
                const _adaptiveOverride = _adaptiveOverrideForRequest;
                const _requestRole = classifyRequestRole(_parsedBodyOnce);
                const _baseTE = config.token_economy || {};
                const _disableCtxHint = contextHintState.disabled || _requestRole !== "main";
                const _tokenEconomy = _disableCtxHint ? { ..._baseTE, context_hint: false, __requestRole: _requestRole } : { ..._baseTE, __requestRole: _requestRole };
                let _microcompactBetas = null;
                if (requestInit.body) {
                  const estimatedTokens = _parsedBodyOnce ? estimatePromptTokensFromParsed(_parsedBodyOnce) : estimatePromptTokens(requestInit.body);
                  if (shouldMicrocompact(estimatedTokens, config)) {
                    _microcompactBetas = buildMicrocompactBetas();
                    if (!microcompactState.active) {
                      microcompactState.active = true;
                      microcompactState.lastActivatedTurn = sessionMetrics.turns;
                      toast(`Microcompact activated at ~${Math.round(estimatedTokens / 1e3)}K tokens`, "info", {
                        debounceKey: "microcompact"
                      }).catch(() => {
                      });
                    }
                  } else if (microcompactState.active) {
                    microcompactState.active = false;
                  }
                }
                let computedBetaHeader = buildAnthropicBetaHeader(
                  "",
                  getSignatureEmulationEnabled(),
                  _reqModel,
                  _reqProvider,
                  config.custom_betas,
                  getEffectiveStrategy(),
                  requestUrl?.pathname,
                  _reqHasFileRefs,
                  _adaptiveOverride,
                  _tokenEconomy,
                  _microcompactBetas
                  // NEW
                );
                {
                  const currentBetas = computedBetaHeader.split(",").map((b) => b.trim()).filter(Boolean);
                  for (const b of currentBetas) betaLatchState.sent.add(b);
                  if (betaLatchState.dirty) {
                    betaLatchState.dirty = false;
                    betaLatchState.sent = new Set(currentBetas);
                  }
                  const merged = new Set(currentBetas);
                  for (const b of betaLatchState.sent) merged.add(b);
                  if (contextHintState.disabled) {
                    merged.delete("context-hint-2026-04-09");
                    betaLatchState.sent.delete("context-hint-2026-04-09");
                  }
                  computedBetaHeader = [...merged].join(",");
                  betaLatchState.lastHeader = computedBetaHeader;
                }
                if (!sessionCachePolicyLatched) {
                  sessionCachePolicyLatched = true;
                  latchedCachePolicy = config.cache_policy ? { ...config.cache_policy } : { ttl: "1h", ttl_supported: true };
                }
                const effectiveCachePolicy = latchedCachePolicy || config.cache_policy || { ttl: "1h", ttl_supported: true };
                const body = transformRequestBody(
                  requestInit.body,
                  {
                    enabled: getSignatureEmulationEnabled(),
                    claudeCliVersion,
                    promptCompactionMode: getPromptCompactionMode(),
                    provider: _reqProvider,
                    cachePolicy: effectiveCachePolicy,
                    fastMode: config.fast_mode || false,
                    strategy: getEffectiveStrategy(),
                    toolDeferral: config.token_economy_strategies?.tool_deferral,
                    toolDescriptionCompaction: config.token_economy_strategies?.tool_description_compaction,
                    adaptiveToolSet: config.token_economy_strategies?.adaptive_tool_set,
                    systemPromptTailing: config.token_economy_strategies?.system_prompt_tailing,
                    systemPromptTailTurns: config.token_economy_strategies?.system_prompt_tail_turns,
                    systemPromptTailMaxChars: config.token_economy_strategies?.system_prompt_tail_max_chars
                  },
                  {
                    persistentUserId: signatureUserId,
                    sessionId: signatureSessionId,
                    accountId: getAccountIdentifier(account),
                    turns: sessionMetrics.turns,
                    usedTools: sessionMetrics.usedTools,
                    tokenEconomySession,
                    requestRole: _requestRole
                  },
                  computedBetaHeader,
                  config
                );
                logTransformedSystemPrompt(body);
                if (!_fastModeAppliedToast && typeof body === "string" && body.includes('"speed":"fast"')) {
                  _fastModeAppliedToast = true;
                  toast("\u26A1 Fast mode active", "info", { debounceKey: "fast-mode-active" }).catch(() => {
                  });
                }
                if (typeof body === "string" && body.length <= 2e6) {
                  sessionMetrics.lastRequestBody = body;
                } else if (typeof body === "string") {
                  sessionMetrics.lastRequestBody = body.slice(0, 2e6);
                }
                if (config.cache_break_detection?.enabled && typeof body === "string") {
                  const currentHashes = extractCacheSourceHashes(body);
                  if (currentHashes.size > 0) {
                    cacheBreakState._pendingHashes = currentHashes;
                  }
                }
                const requestHeaders = buildRequestHeaders(
                  input,
                  requestInit,
                  accessToken,
                  body,
                  requestUrl,
                  {
                    enabled: getSignatureEmulationEnabled(),
                    claudeCliVersion,
                    customBetas: config.custom_betas,
                    strategy: getEffectiveStrategy(),
                    sessionId: signatureSessionId
                  },
                  _adaptiveOverride,
                  _tokenEconomy
                );
                const finalBody = body;
                if (config.token_economy?.debug_dump_bodies === true && typeof finalBody === "string") {
                  try {
                    const fs3 = await import("node:fs");
                    const path = await import("node:path");
                    const os = await import("node:os");
                    const dir = path.join(os.homedir(), ".opencode", "opencode-anthropic-fix", "request-dumps");
                    fs3.mkdirSync(dir, { recursive: true });
                    const existing = fs3.readdirSync(dir).filter((f) => f.startsWith("req-") && f.endsWith(".json")).sort();
                    while (existing.length >= 10) {
                      fs3.unlinkSync(path.join(dir, existing.shift()));
                    }
                    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
                    fs3.writeFileSync(path.join(dir, `req-${ts}.json`), finalBody);
                  } catch {
                  }
                }
                let response;
                try {
                  response = await fetch(requestInput, {
                    ...requestInit,
                    body: finalBody,
                    headers: requestHeaders,
                    // Disable keepalive when a previous ECONNRESET/EPIPE was detected
                    // to force a fresh TCP connection and avoid stale socket reuse.
                    ...requestInit._disableKeepalive ? { keepalive: false, agent: false } : {}
                  });
                } catch (err) {
                  const fetchError = err instanceof Error ? err : new Error(String(err));
                  const errMsg = fetchError.message || "";
                  const errCode = (
                    /** @type {any} */
                    fetchError.code || ""
                  );
                  const isConnectionReset = errCode === "ECONNRESET" || errCode === "EPIPE" || errCode === "ECONNABORTED" || errMsg.includes("ECONNRESET") || errMsg.includes("EPIPE") || errMsg.includes("socket hang up") || errMsg.includes("network socket disconnected");
                  if (isConnectionReset && _connectionResetRetries < 3) {
                    _connectionResetRetries++;
                    requestInit._disableKeepalive = true;
                    debugLog("connection reset detected, disabling keepalive for retry", {
                      code: errCode,
                      message: errMsg,
                      retryCount: _connectionResetRetries
                    });
                    if (accountManager && account) {
                      lastError = fetchError;
                      attempt--;
                      continue;
                    }
                  }
                  if (accountManager && account) {
                    accountManager.markFailure(account);
                    transientRefreshSkips.add(account.index);
                    lastError = fetchError;
                    debugLog("request fetch threw, trying next account", {
                      accountIndex: account.index,
                      message: fetchError.message
                    });
                    continue;
                  }
                  throw fetchError;
                }
                if (config.debug) {
                  const rlHeaders = {};
                  const allHeaders = {};
                  response.headers.forEach((value, key) => {
                    allHeaders[key] = value;
                    if (key.includes("ratelimit") || key.includes("retry") || key.includes("x-should")) {
                      rlHeaders[key] = value;
                    }
                  });
                  debugLog(
                    "response status:",
                    response.status,
                    "ok:",
                    response.ok,
                    "account:",
                    !!account,
                    "accountManager:",
                    !!accountManager
                  );
                  debugLog("ALL response headers:", allHeaders);
                  try {
                    const { writeFileSync: writeFileSync5 } = await import("node:fs");
                    const { join: join7 } = await import("node:path");
                    const debugFile = join7(getConfigDir(), "debug-headers.log");
                    const ts = (/* @__PURE__ */ new Date()).toISOString();
                    const entry = [
                      `
=== ${ts} | status=${response.status} ok=${response.ok} account=${!!account} mgr=${!!accountManager} ===`,
                      `Rate-limit headers: ${JSON.stringify(rlHeaders, null, 2)}`,
                      `All headers: ${JSON.stringify(allHeaders, null, 2)}`,
                      ""
                    ].join("\n");
                    writeFileSync5(debugFile, entry, { flag: "a" });
                  } catch (e2) {
                    debugLog("failed to write debug-headers.log", e2);
                  }
                }
                if (response.ok && account && accountManager) {
                  const RATE_LIMIT_WINDOWS = [
                    { key: "5h", field: "fiveHour", windowMs: 5 * 3600 * 1e3 },
                    { key: "7d", field: "sevenDay", windowMs: 7 * 24 * 3600 * 1e3 }
                  ];
                  let maxUtilization = 0;
                  let maxUtilizationWindow = "";
                  let anySurpassed = false;
                  let surpassedResetAt = null;
                  const overallStatus = response.headers.get("anthropic-ratelimit-unified-status");
                  const representativeClaim = response.headers.get("anthropic-ratelimit-unified-representative-claim");
                  const fallbackStatus = response.headers.get("anthropic-ratelimit-unified-fallback");
                  const fallbackPct = response.headers.get("anthropic-ratelimit-unified-fallback-percentage");
                  const overageStatus = response.headers.get("anthropic-ratelimit-unified-overage-status");
                  const overageReason = response.headers.get("anthropic-ratelimit-unified-overage-disabled-reason");
                  for (const win of RATE_LIMIT_WINDOWS) {
                    const utilizationStr = response.headers.get(`anthropic-ratelimit-unified-${win.key}-utilization`);
                    const status = response.headers.get(`anthropic-ratelimit-unified-${win.key}-status`);
                    const surpassed = response.headers.get(
                      `anthropic-ratelimit-unified-${win.key}-surpassed-threshold`
                    );
                    const resetAt = response.headers.get(`anthropic-ratelimit-unified-${win.key}-reset`);
                    if (utilizationStr) {
                      const utilization = parseFloat(utilizationStr);
                      if (!isNaN(utilization)) {
                        const resetDate = resetAt ? new Date(parseInt(resetAt) * 1e3).toISOString() : null;
                        sessionMetrics.lastQuota[win.field] = {
                          utilization: utilization * 100,
                          // store as percentage 0-100
                          resets_at: resetDate,
                          status: status || null,
                          surpassedThreshold: surpassed ? parseFloat(surpassed) : null
                        };
                        sessionMetrics.lastQuota.updatedAt = Date.now();
                        if (utilization > maxUtilization) {
                          maxUtilization = utilization;
                          maxUtilizationWindow = win.key;
                        }
                      }
                    }
                    if (surpassed) {
                      anySurpassed = true;
                      surpassedResetAt = surpassedResetAt || resetAt;
                    }
                  }
                  if (overallStatus) {
                    sessionMetrics.lastQuota.overallStatus = overallStatus;
                    sessionMetrics.lastQuota.representativeClaim = representativeClaim;
                    sessionMetrics.lastQuota.fallback = fallbackStatus;
                    sessionMetrics.lastQuota.fallbackPercentage = fallbackPct ? parseFloat(fallbackPct) : null;
                    sessionMetrics.lastQuota.overageStatus = overageStatus;
                    sessionMetrics.lastQuota.overageReason = overageReason;
                  }
                  if (!config.toasts?.quiet) {
                    const unifiedStatusHeaders = [
                      ["status", overallStatus],
                      ["representative-claim", representativeClaim],
                      ["fallback", fallbackStatus],
                      ["fallback-percentage", fallbackPct],
                      ["overage-status", overageStatus],
                      ["overage-disabled-reason", overageReason]
                    ];
                    for (const win of RATE_LIMIT_WINDOWS) {
                      unifiedStatusHeaders.push([
                        `${win.key}-status`,
                        response.headers.get(`anthropic-ratelimit-unified-${win.key}-status`)
                      ]);
                    }
                    for (const [key, current] of unifiedStatusHeaders) {
                      if (current == null) continue;
                      const prev = previousUnifiedStatus[key];
                      if (prev !== void 0 && prev !== current) {
                        const label = key.replace(/-/g, " ").replace(/\b\w/g, (c2) => c2.toUpperCase());
                        toast(`Quota ${label}: ${prev ?? "\u2014"} \u2192 ${current}`, "info", {
                          debounceKey: `unified-status-${key}`
                        }).catch(() => {
                        });
                        debugLog("anthropic-ratelimit-unified status change", { key, prev, current });
                      }
                      previousUnifiedStatus[key] = current;
                    }
                  }
                  if (maxUtilization > 0) {
                    sessionMetrics.lastQuota.tokens = maxUtilization;
                    sessionMetrics.lastQuota.requests = maxUtilization;
                    sessionMetrics.lastQuota.inputTokens = maxUtilization;
                  }
                  const proactiveDisabled = config.account_management?.proactive_disabled !== false;
                  if (!proactiveDisabled && maxUtilization > 0.8) {
                    const penalty = Math.round((maxUtilization - 0.8) * 50);
                    accountManager.applyUtilizationPenalty(account, penalty);
                    debugLog("high rate limit utilization", {
                      accountIndex: account.index,
                      window: maxUtilizationWindow,
                      utilization: (maxUtilization * 100).toFixed(1) + "%",
                      penalty
                    });
                  }
                  if (!proactiveDisabled && anySurpassed) {
                    accountManager.applySurpassedThreshold(account, surpassedResetAt);
                    debugLog("rate limit threshold surpassed", {
                      accountIndex: account.index,
                      resetAt: surpassedResetAt
                    });
                  }
                  if (maxUtilization >= 0.9 && !config.toasts?.quiet) {
                    toast(
                      `Rate limit ${maxUtilizationWindow} window: ${(maxUtilization * 100).toFixed(0)}% utilized`,
                      "warning",
                      { debounceKey: "quota-warn" }
                    ).catch(() => {
                    });
                  }
                  if (!proactiveDisabled && maxUtilization > 0.6 && accountManager.getAccountCount() > 1) {
                    let highestRisk = 0;
                    for (const win of RATE_LIMIT_WINDOWS) {
                      const utilizationStr = response.headers.get(`anthropic-ratelimit-unified-${win.key}-utilization`);
                      const resetAtStr = response.headers.get(`anthropic-ratelimit-unified-${win.key}-reset`);
                      if (!utilizationStr || !resetAtStr) continue;
                      const utilization = parseFloat(utilizationStr);
                      const resetEpoch = parseInt(resetAtStr) * 1e3;
                      if (isNaN(utilization) || isNaN(resetEpoch)) continue;
                      const timeUntilReset = Math.max(0, resetEpoch - Date.now());
                      const timeRemainingFraction = Math.max(0.01, timeUntilReset / win.windowMs);
                      const risk = utilization / timeRemainingFraction;
                      if (risk > highestRisk) highestRisk = risk;
                    }
                    if (highestRisk > 0.85 && accountManager.getAccountCount() > 1) {
                      const currentName = account.email || `Account ${account.index + 1}`;
                      const nextAccount = accountManager.peekNextAccount?.();
                      const nextName = nextAccount?.email || "next account";
                      accountManager.markPreemptiveSwitch(account);
                      toast(
                        `Predictive switch: ${currentName} at high burn rate, switching to ${nextName}`,
                        "warning",
                        { debounceKey: "predictive-switch" }
                      ).catch(() => {
                      });
                      debugLog("predictive rate limit switch", {
                        accountIndex: account.index,
                        risk: highestRisk.toFixed(2)
                      });
                    }
                  }
                }
                if (!response.ok && accountManager && account) {
                  let errorBody = null;
                  try {
                    const cloned = response.clone();
                    const reader = cloned.body?.getReader();
                    if (reader) {
                      const chunks = [];
                      let totalLen = 0;
                      const maxLen = 16384;
                      const deadline = Date.now() + 5e3;
                      while (totalLen < maxLen && Date.now() < deadline) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        totalLen += value.byteLength;
                      }
                      reader.cancel().catch(() => {
                      });
                      errorBody = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)).slice(0, maxLen);
                    } else {
                      errorBody = await cloned.text();
                    }
                  } catch {
                  }
                  if (!contextHintState.disabled) {
                    if (response.status === 400 && errorBody && errorBody.includes("Unexpected value") && errorBody.includes("anthropic-beta") && errorBody.includes("context-hint")) {
                      contextHintState.disabled = true;
                      betaLatchState.dirty = true;
                      saveContextHintDisabledFlag({
                        reason: "beta_unsupported_400",
                        status: 400
                      });
                      debugLog("context-hint: beta rejected by server (400), disabling + persisting");
                      attempt--;
                      continue;
                    } else if (response.status === 409) {
                      contextHintState.disabled = true;
                      betaLatchState.dirty = true;
                      debugLog("context-hint: 409 conflict, disabling for session");
                      attempt--;
                      continue;
                    } else if (response.status === 529 && errorBody && errorBody.includes("context_hint")) {
                      contextHintState.disabled = true;
                      betaLatchState.dirty = true;
                      debugLog("context-hint: 529 overloaded referencing hint, disabling for session");
                      attempt--;
                      continue;
                    } else if ((response.status === 422 || response.status === 424) && !requestInit._contextHintCompactAttempted) {
                      try {
                        const hintBody = JSON.parse(requestInit.body);
                        if (Array.isArray(hintBody.messages)) {
                          const compacted = applyContextHintCompaction(hintBody.messages);
                          if (compacted.changed) {
                            hintBody.messages = compacted.messages;
                            requestInit.body = JSON.stringify(hintBody);
                            _parsedBodyOnce = null;
                            requestInit._contextHintCompactAttempted = true;
                            contextHintState.compactionsApplied += 1;
                            attempt--;
                            toast(
                              `\u2699 Context hint compaction (${response.status}) \u2014 cleared ${compacted.stats.thinkingCleared} thinking / ${compacted.stats.toolResultsCleared} tool results`,
                              "info",
                              { debounceKey: "context-hint-compact" }
                            ).catch(() => {
                            });
                            debugLog("context-hint: applied compaction on status", response.status, compacted.stats);
                            continue;
                          }
                        }
                      } catch {
                      }
                    }
                  }
                  if (response.status === 400 && errorBody && (errorBody.includes("prompt is too long") || errorBody.includes("prompt_too_long")) && !requestInit._reactiveCompactAttempted) {
                    debugLog("prompt too long \u2014 attempting reactive message trimming");
                    if (config.overflow_recovery?.enabled && !requestInit._overflowRecoveryAttempted) {
                      const overflow = parseContextLimitError(errorBody);
                      if (overflow) {
                        const margin = config.overflow_recovery.safety_margin ?? 1e3;
                        const safeMaxTokens = computeSafeMaxTokens(overflow.input, overflow.limit, margin);
                        if (safeMaxTokens > 0) {
                          debugLog("overflow recovery: reducing max_tokens", {
                            original: overflow.maxTokens,
                            safe: safeMaxTokens,
                            input: overflow.input,
                            limit: overflow.limit,
                            margin
                          });
                          try {
                            const recoveryBody = JSON.parse(requestInit.body);
                            recoveryBody.max_tokens = safeMaxTokens;
                            requestInit.body = JSON.stringify(recoveryBody);
                            _parsedBodyOnce = null;
                            requestInit._overflowRecoveryAttempted = true;
                            attempt--;
                            toast(
                              `Context overflow: reduced max_tokens ${overflow.maxTokens.toLocaleString()} \u2192 ${safeMaxTokens.toLocaleString()}`,
                              "warning",
                              { debounceKey: "overflow-recovery" }
                            ).catch(() => {
                            });
                            continue;
                          } catch {
                          }
                        }
                      }
                    }
                    if (config.adaptive_context?.enabled) {
                      const stateChanged = forceEscalateAdaptiveContext();
                      if (stateChanged) {
                        _adaptiveDecisionMade = false;
                        toast("\u2B21 1M context force-activated (prompt too long)", "warning", {
                          debounceKey: "adaptive-ctx"
                        }).catch(() => {
                        });
                      }
                    }
                    try {
                      const parsedBody = JSON.parse(requestInit.body);
                      if (Array.isArray(parsedBody.messages) && parsedBody.messages.length > 4) {
                        const msgs = parsedBody.messages;
                        const tail = msgs.slice(-2);
                        if (tail.length > 0 && tail[tail.length - 1]?.role === "assistant") {
                          const lastAssistant = tail[tail.length - 1];
                          const lastContent = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
                          const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");
                          if (toolUseBlocks.length > 0) {
                            tail.push({
                              role: "user",
                              content: toolUseBlocks.map((tu) => ({
                                type: "tool_result",
                                tool_use_id: tu.id,
                                content: "[Context trimmed \u2014 previous result unavailable]"
                              }))
                            });
                          } else {
                            tail.push({
                              role: "user",
                              content: [{ type: "text", text: "Continue." }]
                            });
                          }
                        }
                        const trimmed = [
                          ...msgs.slice(0, 2),
                          {
                            role: "user",
                            content: [
                              {
                                type: "text",
                                text: "[Earlier conversation was trimmed due to context limits. Continue from the most recent context.]"
                              }
                            ]
                          },
                          ...tail
                        ];
                        parsedBody.messages = repairOrphanedToolUseBlocks(trimmed);
                        requestInit.body = JSON.stringify(parsedBody);
                        _parsedBodyOnce = null;
                        requestInit._reactiveCompactAttempted = true;
                        attempt--;
                        toast("Context trimmed \u2014 retrying with shortened history", "warning", {
                          debounceKey: "compact-retry"
                        }).catch(() => {
                        });
                        continue;
                      }
                    } catch {
                    }
                  }
                  if (response.status === 400 && errorBody && errorBody.includes("cache_control") && !errorBody.includes("must not come after") && !errorBody.includes("maximum of")) {
                    if (config.cache_policy && config.cache_policy.ttl_supported !== false) {
                      config.cache_policy.ttl_supported = false;
                      saveConfig({ cache_policy: { ttl_supported: false } });
                      debugLog("cache TTL not supported by API, auto-disabled");
                    }
                  }
                  if (response.status === 400 && errorBody && errorBody.includes("speed")) {
                    if (config.fast_mode) {
                      config.fast_mode = false;
                      _fastModeAppliedToast = false;
                      saveConfig({ fast_mode: false });
                      toast("\u26A1 Fast mode OFF \u2014 not supported by API", "warning", {
                        debounceKey: "fast-mode-off"
                      }).catch(() => {
                      });
                      debugLog("fast mode not supported by API, auto-disabled");
                    }
                  }
                  const shouldRetry = parseShouldRetryHeader(response);
                  if (shouldRetry === false) {
                    debugLog("x-should-retry: false \u2014 not retrying", { status: response.status });
                    return transformResponse(response);
                  }
                  const accountSpecific = isAccountSpecificError(response.status, errorBody);
                  if (shouldRetry === true && !accountSpecific && shouldRetryCount < maxShouldRetries) {
                    shouldRetryCount++;
                    const retryDelay = parseRetryAfterMsHeader(response) ?? parseRetryAfterHeader(response) ?? 2e3;
                    debugLog("x-should-retry: true on service-wide error, sleeping before retry", {
                      status: response.status,
                      retryDelay,
                      shouldRetryCount
                    });
                    await new Promise((r) => setTimeout(r, retryDelay));
                    attempt--;
                    continue;
                  }
                  if (accountSpecific) {
                    const reason = parseRateLimitReason(response.status, errorBody);
                    const retryAfterMs = parseRetryAfterMsHeader(response) ?? parseRetryAfterHeader(response);
                    if (response.status === 429 && reason === "RATE_LIMIT_EXCEEDED" && retryAfterMs != null && retryAfterMs > 0 && retryAfterMs <= TRANSIENT_RETRY_THRESHOLD_MS) {
                      debugLog("transient 429: sleeping before same-account retry", {
                        retryAfterMs,
                        account: account.email || `Account ${account.index + 1}`
                      });
                      await new Promise((r) => setTimeout(r, retryAfterMs));
                      attempt--;
                      continue;
                    }
                    accountManager.markRateLimited(account, reason, retryAfterMs);
                    if (reason === "AUTH_FAILED") {
                      account.access = "";
                      account.expires = 0;
                    }
                    recordRateLimitForStrategy();
                    if (config.fast_mode && (response.status === 429 || response.status === 529)) {
                      config.fast_mode = false;
                      _fastModeAppliedToast = false;
                      toast("\u26A1 Fast mode OFF \u2014 rate limited", "warning", {
                        debounceKey: "fast-mode-off"
                      }).catch(() => {
                      });
                      debugLog("auto-disabled fast mode after rate limit");
                    }
                    const accountName = account.email || `Account ${account.index + 1}`;
                    const lowerBody = String(errorBody || "").toLowerCase();
                    const switchMsg = response.status === 403 || lowerBody.includes("permission") ? `permission denied on ${accountName}; switching account` : reason === "AUTH_FAILED" ? `authentication failed on ${accountName}; switching account` : reason === "QUOTA_EXHAUSTED" ? `quota exhausted on ${accountName}; switching account` : `Rate limited on ${accountName}; switching account`;
                    toast(switchMsg, "warning", {
                      debounceKey: "switch-account"
                    }).catch(() => {
                    });
                    continue;
                  }
                  if ((response.status === 529 || response.status === 503) && serviceWideRetryCount < maxServiceRetries) {
                    serviceWideRetryCount++;
                    if (response.status === 529) {
                      consecutive529Count++;
                      if (consecutive529Count >= 3 && requestInit.body) {
                        try {
                          const parsedForFallback = JSON.parse(requestInit.body);
                          const currentModel = parsedForFallback.model || "";
                          let fallbackModel = null;
                          if (/opus-4-6|opus-4/i.test(currentModel))
                            fallbackModel = currentModel.replace(/opus/i, "sonnet");
                          else if (/sonnet-4-6|sonnet-4/i.test(currentModel))
                            fallbackModel = currentModel.replace(/sonnet/i, "haiku");
                          if (fallbackModel) {
                            parsedForFallback.model = fallbackModel;
                            requestInit.body = JSON.stringify(parsedForFallback);
                            _parsedBodyOnce = null;
                            toast(
                              `Model fallback: ${currentModel} \u2192 ${fallbackModel} after ${consecutive529Count} overloads`,
                              "warning",
                              { debounceKey: "model-fallback" }
                            ).catch(() => {
                            });
                            debugLog("model fallback on consecutive 529", {
                              from: currentModel,
                              to: fallbackModel,
                              count: consecutive529Count
                            });
                          }
                        } catch {
                        }
                      }
                    } else {
                      consecutive529Count = 0;
                    }
                    const baseDelay = Math.min(0.5 * Math.pow(2, serviceWideRetryCount), 3);
                    const jitter = 1 - Math.random() * 0.25;
                    const sleepMs = Math.round(baseDelay * jitter * 1e3);
                    const retryLabel = response.status === 529 ? "overloaded" : "unavailable";
                    debugLog(`service-wide ${retryLabel} error, sleeping before retry`, {
                      status: response.status,
                      attempt: serviceWideRetryCount,
                      maxRetries: maxServiceRetries,
                      sleepMs
                    });
                    toast(
                      `API ${retryLabel} (${response.status}): retry ${serviceWideRetryCount}/${maxServiceRetries} in ${(sleepMs / 1e3).toFixed(1)}s`,
                      "warning",
                      { debounceKey: "service-retry" }
                    ).catch(() => {
                    });
                    await new Promise((r) => setTimeout(r, sleepMs));
                    attempt--;
                    continue;
                  }
                  if (response.status === 529 && accountManager && account && config.overload_recovery?.enabled !== false && !_overloadRecoveryAttempted) {
                    _overloadRecoveryAttempted = true;
                    const recovery = tryQuotaAwareAccountSwitch(account, accountManager, config);
                    if (recovery.switched && recovery.nextAccount) {
                      if (config.overload_recovery?.poll_quota_on_overload && account?.access) {
                        pollOAuthUsage(config, account.access).catch(() => {
                        });
                      }
                      const fromName = account.email || `Account ${account.index + 1}`;
                      const toName = recovery.nextAccount.email || `Account ${recovery.nextAccount.index + 1}`;
                      const cooldownMin = Math.ceil(recovery.cooldownMs / 6e4);
                      toast(`529 overloaded: ${fromName} \u2192 ${toName} (cooldown ${cooldownMin}m)`, "warning", {
                        debounceKey: "overload-switch"
                      }).catch(() => {
                      });
                      debugLog("overload recovery: retrying with new account", {
                        from: account.index,
                        to: recovery.nextAccount.index,
                        cooldownMs: recovery.cooldownMs
                      });
                      attempt--;
                      continue;
                    }
                    const errorMsg = buildOverloadErrorMessage(
                      account,
                      accountManager,
                      serviceWideRetryCount,
                      maxServiceRetries
                    );
                    toast(errorMsg, "error", { debounceKey: "overload-exhausted" }).catch(() => {
                    });
                    debugLog("overload recovery: all accounts exhausted", {
                      errorMsg
                    });
                  } else {
                    debugLog("service-wide response error, returning directly", {
                      status: response.status
                    });
                  }
                  return transformResponse(response);
                }
                if (account && accountManager) {
                  if (response.ok) {
                    accountManager.markSuccess(account);
                    checkStrategyRecovery();
                    if (telemetryEmitter.enabled && account?.access) {
                      telemetryEmitter.sendStartupEvents(account.access).catch(() => {
                      });
                    }
                  }
                }
                const shouldInspectStream = response.ok && account && accountManager && isEventStreamResponse(response);
                const usageCallback = shouldInspectStream ? (usage) => {
                  accountManager.recordUsage(account.index, usage);
                  updateSessionMetrics(usage, _reqModel);
                  if (sessionMetrics.turns >= 3) {
                    const avgRate = getAverageCacheHitRate();
                    const threshold = config.cache_policy?.hit_rate_warning_threshold ?? 0.3;
                    if (avgRate < threshold) {
                      debugLog("low cache hit rate", {
                        avgRate: (avgRate * 100).toFixed(1) + "%",
                        turns: sessionMetrics.turns
                      });
                    }
                  }
                  const maxBudget = parseFloat(process.env.OPENCODE_ANTHROPIC_MAX_BUDGET_USD || "0");
                  if (maxBudget > 0) {
                    const pct = sessionMetrics.sessionCostUsd / maxBudget;
                    if (pct >= 1 && !isTruthyEnv(process.env.OPENCODE_ANTHROPIC_IGNORE_BUDGET)) {
                      toast(
                        `Session budget exceeded ($${sessionMetrics.sessionCostUsd.toFixed(2)} / $${maxBudget.toFixed(2)})`,
                        "warning",
                        { debounceKey: "budget" }
                      ).catch(() => {
                      });
                    } else if (pct >= 0.8) {
                      toast(
                        `Session at ${(pct * 100).toFixed(0)}% of budget ($${sessionMetrics.sessionCostUsd.toFixed(2)} / $${maxBudget.toFixed(2)})`,
                        "warning",
                        { debounceKey: "budget" }
                      ).catch(() => {
                      });
                    }
                  }
                  if (config.usage_toast) {
                    const turnCost = calculateCostUsd(usage, _reqModel);
                    const totalTok = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
                    const parts = [`${totalTok.toLocaleString()} tok`];
                    if (usage.cacheReadTokens > 0) {
                      const cacheHit = totalTok > 0 ? (usage.cacheReadTokens / (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) * 100).toFixed(0) : "0";
                      parts.push(`${cacheHit}% cache`);
                    }
                    if (usage.webSearchRequests > 0) parts.push(`${usage.webSearchRequests} search`);
                    parts.push(`$${turnCost.toFixed(4)}`);
                    toast(parts.join(" | "), "info", { debounceKey: `usage-turn-${sessionMetrics.turns}` }).catch(
                      () => {
                      }
                    );
                  }
                  if (config.cache_break_detection?.enabled) {
                    const cacheRead = usage.cacheReadTokens || 0;
                    const threshold = config.cache_break_detection.alert_threshold ?? 2e3;
                    if (cacheBreakState.prevCacheRead > 0 && cacheBreakState.prevCacheRead - cacheRead > threshold && cacheBreakState.lastAlertTurn !== sessionMetrics.turns) {
                      const drop = cacheBreakState.prevCacheRead - cacheRead;
                      let alertMsg = `Cache break detected (\u2212${drop.toLocaleString()} tokens)`;
                      if (cacheBreakState._pendingHashes && cacheBreakState.sourceHashes.size > 0) {
                        const changedSources = detectCacheBreakSources(
                          cacheBreakState._pendingHashes,
                          cacheBreakState.sourceHashes
                        );
                        if (changedSources.length > 0) {
                          alertMsg += `: ${changedSources.join(", ")} changed`;
                        }
                      }
                      toast(alertMsg, "warning", { debounceKey: "cache-break" }).catch(() => {
                      });
                      cacheBreakState.lastAlertTurn = sessionMetrics.turns;
                    }
                    cacheBreakState.prevCacheRead = cacheRead;
                    if (cacheBreakState._pendingHashes) {
                      cacheBreakState.sourceHashes = cacheBreakState._pendingHashes;
                      delete cacheBreakState._pendingHashes;
                    }
                  }
                  const shouldPollUsage = sessionMetrics.turns % 10 === 0 || Date.now() - sessionMetrics.lastQuota.lastPollAt > 5 * 6e4;
                  if (shouldPollUsage && accessToken) {
                    pollOAuthUsage(config, accessToken).then(() => {
                      const level5h = computeQuotaWarningLevel(sessionMetrics.lastQuota.fiveHour);
                      const level7d = computeQuotaWarningLevel(sessionMetrics.lastQuota.sevenDay);
                      const highestLevel = level5h === "danger" || level7d === "danger" ? "danger" : level5h === "warning" || level7d === "warning" ? "warning" : level5h === "caution" || level7d === "caution" ? "caution" : null;
                      if (highestLevel === "danger") {
                        toast(
                          `Usage limit: \u226425% remaining (5h: ${sessionMetrics.lastQuota.fiveHour.utilization.toFixed(0)}%, 7d: ${sessionMetrics.lastQuota.sevenDay.utilization.toFixed(0)}%)`,
                          "warning",
                          { debounceKey: "usage-danger" }
                        ).catch(() => {
                        });
                      } else if (highestLevel === "warning") {
                        toast(
                          `Usage limit: \u226450% remaining (5h: ${sessionMetrics.lastQuota.fiveHour.utilization.toFixed(0)}%, 7d: ${sessionMetrics.lastQuota.sevenDay.utilization.toFixed(0)}%)`,
                          "warning",
                          { debounceKey: "usage-warning" }
                        ).catch(() => {
                        });
                      } else if (highestLevel === "caution" && !quotaWarningState.cautionShown) {
                        quotaWarningState.cautionShown = true;
                        toast(
                          `Usage limit: \u226475% remaining (5h: ${sessionMetrics.lastQuota.fiveHour.utilization.toFixed(0)}%, 7d: ${sessionMetrics.lastQuota.sevenDay.utilization.toFixed(0)}%)`,
                          "info",
                          { debounceKey: "usage-caution" }
                        ).catch(() => {
                        });
                      }
                    }).catch(() => {
                    });
                  }
                } : null;
                const accountErrorCallback = shouldInspectStream ? (details) => {
                  accountManager.markRateLimited(account, details.reason, null);
                  if (details.invalidateToken) {
                    account.access = "";
                    account.expires = 0;
                  }
                  const name = account.email || `Account ${account.index + 1}`;
                  const switchMsg = details.reason === "AUTH_FAILED" ? `authentication failed on ${name}; switching account` : details.reason === "QUOTA_EXHAUSTED" ? `quota exhausted on ${name}; switching account` : `Rate limited on ${name}; switching account`;
                  toast(switchMsg, "warning", {
                    debounceKey: "switch-account"
                  }).catch(() => {
                  });
                } : null;
                return transformResponse(response, usageCallback, accountErrorCallback);
              }
              if (lastError) throw lastError;
              throw new Error("All accounts exhausted \u2014 no account could serve this request");
            }
          };
        }
        return {};
      },
      methods: [
        {
          // H1: Claude Pro/Max OAuth — now with multi-account support
          label: "Claude Pro/Max (multi-account)",
          type: "oauth",
          authorize: async () => {
            const stored = await loadAccounts();
            if (stored && stored.accounts.length > 0 && accountManager) {
              const action = await promptAccountMenu(accountManager);
              if (action === "cancel") {
                return {
                  url: "about:blank",
                  instructions: "Cancelled.",
                  method: "code",
                  callback: async () => ({ type: "failed" })
                };
              }
              if (action === "manage") {
                await promptManageAccounts(accountManager);
                await accountManager.saveToDisk();
                return {
                  url: "about:blank",
                  instructions: "Account management complete. Re-run auth to add accounts.",
                  method: "code",
                  callback: async () => ({ type: "failed" })
                };
              }
              if (action === "fresh") {
                await clearAccounts();
                accountManager.clearAll();
              }
            }
            const { url, verifier } = await authorize("max");
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                if (!accountManager) {
                  accountManager = await AccountManager.load(config, null);
                }
                const countBefore = accountManager.getAccountCount();
                accountManager.addAccount(
                  credentials.refresh,
                  credentials.access,
                  credentials.expires,
                  credentials.email
                );
                await accountManager.saveToDisk();
                const total = accountManager.getAccountCount();
                const name = credentials.email || "account";
                if (countBefore > 0) {
                  await toast(`Added ${name} \u2014 ${total} accounts`, "success");
                } else {
                  await toast(`Authenticated (${name})`, "success");
                }
                return credentials;
              }
            };
          }
        },
        {
          // H2: Create an API Key (unchanged)
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "success") {
                  const result = await fetch(`https://api.anthropic.com/api/oauth/claude_cli/create_api_key`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`
                    }
                  }).then((r) => r.json());
                  return { type: "success", key: result.raw_key };
                }
                return credentials;
              }
            };
          }
        },
        {
          // H3: Manual API Key (unchanged)
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api"
        }
      ]
    },
    /**
     * Stateless message-list transforms. Previously fork-only patches
     * (4c3f4fc19 stale-read eviction, 797ae24d8 per-tool-class prune)
     * now live here and apply on the cloned request messages. Hook
     * input is `{}` — no sessionID, so these are global policies.
     */
    "experimental.chat.messages.transform": async (_input, output) => {
      const strategies = config?.token_economy_strategies;
      if (!strategies) return;
      if (!output?.messages) return;
      if (strategies.stale_read_eviction) {
        staleReadEviction({ messages: output.messages });
      }
      if (strategies.per_tool_class_prune) {
        perToolClassPrune({ messages: output.messages });
      }
    },
    "experimental.session.compacting": async (input, output) => {
      adaptiveContextState.active = false;
      adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
      adaptiveContextState.escalatedByError = false;
      cacheBreakState.prevCacheRead = 0;
      cacheBreakState.sourceHashes = /* @__PURE__ */ new Map();
      cacheBreakState.lastAlertTurn = 0;
      microcompactState.active = false;
      microcompactState.lastActivatedTurn = 0;
      if (!accountManager) return;
      const account = accountManager.getCurrentAccount();
      const name = account?.email || "unknown";
      const q = sessionMetrics.lastQuota;
      const contextParts = [];
      contextParts.push(`## Anthropic Account State
- Active account: ${name}
- Session cost: $${sessionMetrics.sessionCostUsd.toFixed(4)}
- Turns: ${sessionMetrics.turns}
- Cache hit rate: ${(getAverageCacheHitRate() * 100).toFixed(0)}%`);
      if (q.updatedAt > 0) {
        contextParts.push(
          `- Rate limit utilization: tokens=${(q.tokens * 100).toFixed(0)}%, requests=${(q.requests * 100).toFixed(0)}%`
        );
      }
      output.context.push(contextParts.join("\n"));
    },
    /**
     * B3 L2 Option C: Plugin-generated compaction summary via Haiku.
     * Gated on token_economy_strategies.haiku_rolling_summary. See
     * runHaikuSessionSummarize at the top of this file for the full driver
     * — the closure here only binds account/token/config state.
     */
    "experimental.session.summarize": async (input, output) => {
      if (!config?.token_economy_strategies?.haiku_rolling_summary) return;
      if (!accountManager) return;
      const account = accountManager.getCurrentAccount();
      if (!account) return;
      const getAccessToken = async () => {
        let tok = account.access;
        if (!tok || !account.expires || account.expires < Date.now()) {
          tok = await refreshAccountTokenSingleFlight(account);
        }
        if (!tok) throw new Error("no access token available for Haiku call");
        return tok;
      };
      await runHaikuSessionSummarize(
        {
          config,
          getAccessToken,
          fetchFn: globalThis.fetch,
          callHaikuFn: callHaiku,
          rollingSummarizeFn: summarize,
          logger: typeof console !== "undefined" ? console : void 0
        },
        input,
        output
      );
    }
  };
}
var _pluginConfig = null;
function createInitialSessionMetrics() {
  return {
    turns: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalWebSearchRequests: 0,
    recentCacheRates: [],
    // rolling window of last 5 turns
    sessionCostUsd: 0,
    costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    sessionStartTime: Date.now(),
    lastQuota: {
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      updatedAt: 0,
      // Window-based unified headers from response
      fiveHour: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
      sevenDay: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
      // Overall/fallback/overage from response headers
      overallStatus: null,
      representativeClaim: null,
      fallback: null,
      fallbackPercentage: null,
      overageStatus: null,
      overageReason: null,
      // Usage endpoint polling (A6)
      lastPollAt: 0
    },
    lastStopReason: null,
    // tracks most recent stop_reason for output cap escalation
    perModel: {},
    // Map<modelId, { input, output, cacheRead, cacheWrite, costUsd, turns }>
    lastModelId: null,
    lastRequestBody: null,
    // Last intercepted request body (JSON string, capped 2MB) for /anthropic context
    /** Token budget tracking (A9) */
    tokenBudget: {
      limit: 0,
      // 0 = unset
      used: 0,
      // accumulated output tokens
      continuations: 0,
      outputHistory: []
      // last 5 output token deltas
    },
    /** Tools used in this session (populated from assistant tool_use blocks in messages) */
    usedTools: /* @__PURE__ */ new Set()
  };
}
var sessionMetrics = createInitialSessionMetrics();
var adaptiveContextState = {
  /** Whether 1M context beta is currently being sent. */
  active: false,
  /** Turn number of the last transition (to avoid flapping). */
  lastTransitionTurn: 0,
  /** Set when escalation was triggered by a prompt_too_long error. */
  escalatedByError: false
};
var _fastModeAppliedToast = false;
var cacheBreakState = {
  prevCacheRead: 0,
  sourceHashes: /* @__PURE__ */ new Map(),
  lastAlertTurn: 0
};
var microcompactState = {
  active: false,
  lastActivatedTurn: 0
};
function shouldMicrocompact(estimatedTokens, config) {
  if (!config.microcompact?.enabled) return false;
  const thresholdPct = config.microcompact.threshold_percent ?? 80;
  const contextWindow = 2e5;
  const threshold = contextWindow * (thresholdPct / 100);
  return estimatedTokens >= threshold;
}
function buildMicrocompactBetas() {
  return ["clear_tool_uses_20250919", "clear_thinking_20251015"];
}
function hashCacheSource(content) {
  return createHashCrypto("sha256").update(content).digest("hex").slice(0, 16);
}
async function pollOAuthUsage(config, accessToken) {
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json"
      },
      signal: AbortSignal.timeout(5e3)
    });
    if (!resp.ok) {
      return;
    }
    const data = await resp.json();
    if (data.five_hour) {
      sessionMetrics.lastQuota.fiveHour = {
        ...sessionMetrics.lastQuota.fiveHour,
        utilization: data.five_hour.utilization ?? 0,
        resets_at: data.five_hour.resets_at ?? null
      };
    }
    if (data.seven_day) {
      sessionMetrics.lastQuota.sevenDay = {
        ...sessionMetrics.lastQuota.sevenDay,
        utilization: data.seven_day.utilization ?? 0,
        resets_at: data.seven_day.resets_at ?? null
      };
    }
    sessionMetrics.lastQuota.lastPollAt = Date.now();
  } catch {
  }
}
var quotaWarningState = { cautionShown: false };
function computeQuotaWarningLevel(quota) {
  if (!quota || typeof quota.utilization !== "number") return null;
  const remaining = 100 - quota.utilization;
  if (remaining <= 25) return "danger";
  if (remaining <= 50) return "warning";
  if (remaining <= 75) return "caution";
  return null;
}
function buildOverloadErrorMessage(account, accountManager, serviceWideRetryCount, maxServiceRetries) {
  const accountName = account?.email || `Account ${(account?.index ?? 0) + 1}`;
  const totalAccounts = accountManager?.getAccountCount() ?? 1;
  const parts = [
    `Anthropic API overloaded (529).`,
    `Retried ${serviceWideRetryCount}/${maxServiceRetries} times on ${accountName}.`
  ];
  const fh = sessionMetrics.lastQuota.fiveHour;
  const sd = sessionMetrics.lastQuota.sevenDay;
  if (fh?.utilization > 0 || sd?.utilization > 0) {
    parts.push(
      `Quota: 5h=${fh?.utilization?.toFixed(0) ?? "?"}%` + (fh?.resets_at ? ` (resets ${formatResetTime2(fh.resets_at)})` : "") + `, 7d=${sd?.utilization?.toFixed(0) ?? "?"}%` + (sd?.resets_at ? ` (resets ${formatResetTime2(sd.resets_at)})` : "")
    );
  }
  if (totalAccounts > 1) {
    parts.push(`Tried switching across ${totalAccounts} accounts \u2014 all exhausted or overloaded.`);
  } else {
    parts.push(`Only 1 account configured. Add more accounts with '/anthropic login' for automatic failover.`);
  }
  parts.push(`Wait a few minutes or switch models with a smaller context window.`);
  return parts.join(" ");
}
function formatResetTime2(isoTimestamp) {
  if (!isoTimestamp) return "unknown";
  try {
    const resetMs = new Date(isoTimestamp).getTime();
    if (isNaN(resetMs)) return "unknown";
    const diffMs = resetMs - Date.now();
    if (diffMs <= 0) return "now";
    const mins = Math.ceil(diffMs / 6e4);
    if (mins < 60) return `~${mins}m`;
    const hours = Math.round(mins / 60);
    return `~${hours}h`;
  } catch {
    return "unknown";
  }
}
function tryQuotaAwareAccountSwitch(account, accountManager, config) {
  const result = { switched: false, nextAccount: null, cooldownMs: 0 };
  if (!config.overload_recovery?.enabled) return result;
  const defaultCooldown = config.overload_recovery.default_cooldown_ms ?? 6e4;
  let cooldownMs = defaultCooldown;
  const fh = sessionMetrics.lastQuota.fiveHour;
  if (fh?.resets_at) {
    try {
      const resetMs = new Date(fh.resets_at).getTime();
      if (!isNaN(resetMs) && resetMs > Date.now()) {
        cooldownMs = Math.min(resetMs - Date.now(), 30 * 6e4);
      }
    } catch {
    }
  }
  if (account && accountManager) {
    accountManager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", cooldownMs);
    result.cooldownMs = cooldownMs;
  }
  if (accountManager && accountManager.getAccountCount() > 0) {
    const nextAccount = accountManager.getCurrentAccount();
    if (nextAccount && nextAccount.index !== account?.index) {
      result.switched = true;
      result.nextAccount = nextAccount;
    }
  }
  return result;
}
function extractCacheSourceHashes(bodyStr, parsedBody = void 0) {
  const hashes = /* @__PURE__ */ new Map();
  try {
    const parsed = parsedBody ?? JSON.parse(bodyStr);
    if (Array.isArray(parsed.system)) {
      const systemText = parsed.system.filter((b) => !(b.text && b.text.startsWith("Token budget:"))).map((b) => b.text || "").join("");
      if (systemText) hashes.set("system_prompt", hashCacheSource(systemText));
    } else if (typeof parsed.system === "string" && parsed.system) {
      hashes.set("system_prompt", hashCacheSource(parsed.system));
    }
    if (Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.name) {
          hashes.set(`tool:${tool.name}`, hashCacheSource(JSON.stringify(tool)));
        }
      }
    }
    if (Array.isArray(parsed.messages) && parsed.messages.length > 1) {
      const prefix = parsed.messages.slice(0, -1);
      const normalized = prefix.map((m) => {
        if (!Array.isArray(m.content)) return m;
        return {
          ...m,
          content: m.content.map((b) => {
            if (b && typeof b === "object" && b.cache_control) {
              const { cache_control: _cc, ...rest } = b;
              return rest;
            }
            return b;
          })
        };
      });
      hashes.set("messages_prefix", hashCacheSource(JSON.stringify(normalized)));
    }
  } catch {
  }
  if (hashes.size > 10) {
    const entries = [...hashes.entries()];
    return new Map(entries.slice(entries.length - 10));
  }
  return hashes;
}
function detectCacheBreakSources(currentHashes, previousHashes) {
  if (previousHashes.size === 0) return [];
  const changed = [];
  for (const [key, hash] of currentHashes) {
    const prev = previousHashes.get(key);
    if (prev && prev !== hash) {
      changed.push(key);
    }
  }
  for (const key of previousHashes.keys()) {
    if (!currentHashes.has(key)) {
      changed.push(key);
    }
  }
  return changed;
}
function parseContextLimitError(msg) {
  if (!msg || typeof msg !== "string") return null;
  const m = msg.match(/input length and `max_tokens` exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
  if (!m) return null;
  return { input: +m[1], maxTokens: +m[2], limit: +m[3] };
}
function computeSafeMaxTokens(input, limit, margin = 1e3) {
  return Math.max(1, limit - input - margin);
}
function isProxyOrMtlsEnvironment() {
  const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"];
  const mtlsVars = ["NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE"];
  for (const v of proxyVars) {
    if (process.env[v]) return true;
  }
  for (const v of mtlsVars) {
    if (process.env[v]) return true;
  }
  return false;
}
async function preconnectApi(config) {
  if (!config.preconnect?.enabled) return;
  if (isProxyOrMtlsEnvironment()) return;
  try {
    await Promise.race([
      globalThis.fetch("https://api.anthropic.com", { method: "HEAD" }),
      new Promise(
        (_, r) => setTimeout(() => r(new Error("preconnect timeout")), config.preconnect.timeout_ms ?? 1e4)
      )
    ]);
  } catch {
  }
}
function classifyApiRequest(body) {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== "object") return "foreground";
    const msgCount = parsed.messages?.length ?? 0;
    const maxToks = parsed.max_tokens ?? 99999;
    const systemBlocks = Array.isArray(parsed.system) ? parsed.system : [];
    const hasTitleSignal = systemBlocks.some(
      (b) => typeof b.text === "string" && b.text.includes("Generate a short title")
    );
    if (hasTitleSignal) return "background";
    if (msgCount <= 2 && maxToks <= 256) return "background";
    return "foreground";
  } catch {
    return "foreground";
  }
}
function parseNaturalLanguageBudget(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") {
        lastUserText = content;
      } else if (Array.isArray(content)) {
        lastUserText = content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
      }
      break;
    }
  }
  if (!lastUserText) return 0;
  const patterns = [
    /\buse\s+(\d[\d,]*)\s*([mk])\s*tokens?\b/i,
    /\bspend\s+(\d[\d,]*)\s*([mk])?\b/i,
    /\bbudget[:\s]+(\d[\d,]*)\s*([mk])?\b/i,
    /\+(\d[\d,]*)\s*([mk])\b/i,
    /\b(\d[\d,]*)\s*million\s*tokens?\b/i
  ];
  for (const re of patterns) {
    const m = lastUserText.match(re);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ""));
      if (isNaN(num) || num <= 0) continue;
      const suffix = (m[2] || "").toLowerCase();
      if (re === patterns[4]) {
        return num * 1e6;
      }
      if (suffix === "m") return num * 1e6;
      if (suffix === "k") return num * 1e3;
      return num;
    }
  }
  return 0;
}
function injectTokenBudgetBlock(systemBlocks, budget, threshold) {
  if (!budget || budget.limit <= 0) return systemBlocks;
  const pct = (budget.used / budget.limit * 100).toFixed(0);
  const thresholdTokens = Math.round(budget.limit * threshold);
  const remaining = Math.max(0, budget.limit - budget.used);
  const block = {
    type: "text",
    text: `Token budget: ${budget.used.toLocaleString()}/${budget.limit.toLocaleString()} tokens used (${pct}%). Stop generating at ${thresholdTokens.toLocaleString()} tokens. Remaining: ${remaining.toLocaleString()} tokens.`
  };
  return [block, ...systemBlocks || []];
}
function detectDiminishingReturns(outputHistory) {
  if (!Array.isArray(outputHistory) || outputHistory.length < 3) return false;
  const last3 = outputHistory.slice(-3);
  return last3.every((d) => d < 500);
}
function estimatePromptTokens(bodyString) {
  if (!bodyString || typeof bodyString !== "string") return 0;
  try {
    const parsed = JSON.parse(bodyString);
    return estimatePromptTokensFromParsed(parsed);
  } catch {
    return Math.ceil(bodyString.length / 4);
  }
}
function estimatePromptTokensFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return 0;
  let charCount = 0;
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block.type === "text" && typeof block.text === "string") {
        charCount += block.text.length;
      }
    }
  } else if (typeof parsed.system === "string") {
    charCount += parsed.system.length;
  }
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (typeof msg.content === "string") {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && typeof block.text === "string") {
            charCount += block.text.length;
          } else if (block.type === "tool_result" && typeof block.content === "string") {
            charCount += block.content.length;
          } else if (block.type === "tool_use") {
            charCount += JSON.stringify(block.input || {}).length;
          } else if (block.type === "image" || block.type === "image_url") {
            charCount += 8e3;
          }
        }
      }
    }
  }
  return Math.ceil(charCount / 4);
}
function analyzeRequestContext(bodyStr) {
  const result = {
    systemTokens: 0,
    userTokens: 0,
    assistantTokens: 0,
    toolResultTokens: 0,
    toolBreakdown: (
      /** @type {Record<string, { tokens: number, count: number }>} */
      {}
    ),
    totalTokens: 0,
    duplicates: { count: 0, wastedTokens: 0 }
  };
  if (!bodyStr || typeof bodyStr !== "string") return result;
  try {
    const parsed = JSON.parse(bodyStr);
    const contentHashes = /* @__PURE__ */ new Map();
    const estimateTokens2 = (s) => Math.ceil((s || "").length / 4);
    if (Array.isArray(parsed.system)) {
      for (const block of parsed.system) {
        if (block.type === "text" && typeof block.text === "string") {
          result.systemTokens += estimateTokens2(block.text);
        }
      }
    } else if (typeof parsed.system === "string") {
      result.systemTokens += estimateTokens2(parsed.system);
    }
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        const role = msg.role || "unknown";
        const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            const tokens = estimateTokens2(block.text);
            if (role === "user") result.userTokens += tokens;
            else if (role === "assistant") result.assistantTokens += tokens;
          } else if (block.type === "tool_result") {
            let content = "";
            if (typeof block.content === "string") {
              content = block.content;
            } else if (Array.isArray(block.content)) {
              content = block.content.map((b) => b.text || "").join("");
            }
            const tokens = estimateTokens2(content);
            result.toolResultTokens += tokens;
            result.userTokens += tokens;
            const toolName = block.tool_name || block.name || "unknown_tool";
            if (!result.toolBreakdown[toolName]) {
              result.toolBreakdown[toolName] = { tokens: 0, count: 0 };
            }
            result.toolBreakdown[toolName].tokens += tokens;
            result.toolBreakdown[toolName].count += 1;
            if (content.length > 0) {
              const hash = createHashCrypto("sha256").update(content).digest("hex").slice(0, 16);
              const existing = contentHashes.get(hash);
              if (existing) {
                existing.count += 1;
                result.duplicates.count += 1;
                result.duplicates.wastedTokens += tokens;
              } else {
                contentHashes.set(hash, { tokens, count: 1 });
              }
            }
          } else if (block.type === "tool_use") {
            const tokens = estimateTokens2(JSON.stringify(block.input || {}));
            if (role === "assistant") result.assistantTokens += tokens;
          }
        }
      }
    }
    result.totalTokens = result.systemTokens + result.userTokens + result.assistantTokens;
  } catch {
  }
  return result;
}
function resolveAdaptiveContext(bodyString, model, adaptiveConfig, parsedBody) {
  if (!adaptiveConfig.enabled) {
    return hasOneMillionContext(model);
  }
  if (isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return false;
  }
  if (!isEligibleFor1MContext(model)) {
    return false;
  }
  const estimatedTokens = parsedBody ? estimatePromptTokensFromParsed(parsedBody) : estimatePromptTokens(bodyString);
  const turnsSinceTransition = sessionMetrics.turns - adaptiveContextState.lastTransitionTurn;
  if (adaptiveContextState.active) {
    const ERROR_STICKY_TURNS = 5;
    if (adaptiveContextState.escalatedByError) {
      if (turnsSinceTransition < ERROR_STICKY_TURNS) {
        return true;
      }
      if (estimatedTokens < adaptiveConfig.deescalation_threshold * 0.75) {
        adaptiveContextState.active = false;
        adaptiveContextState.escalatedByError = false;
        adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
        return false;
      }
      return true;
    }
    if (turnsSinceTransition < 2) {
      return true;
    }
    if (estimatedTokens < adaptiveConfig.deescalation_threshold) {
      adaptiveContextState.active = false;
      adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
      return false;
    }
    return true;
  } else {
    if (turnsSinceTransition < 2 && adaptiveContextState.lastTransitionTurn > 0) {
      return false;
    }
    if (estimatedTokens > adaptiveConfig.escalation_threshold) {
      adaptiveContextState.active = true;
      adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
      return true;
    }
    return false;
  }
}
function forceEscalateAdaptiveContext() {
  const wasActive = adaptiveContextState.active;
  if (!adaptiveContextState.active) {
    adaptiveContextState.active = true;
    adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
  }
  adaptiveContextState.escalatedByError = true;
  return !wasActive;
}
var MODEL_PRICING = {
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }
};
var DEFAULT_PRICING = MODEL_PRICING["claude-sonnet-4-6"];
function getModelPricing(model) {
  if (!model) return DEFAULT_PRICING;
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return DEFAULT_PRICING;
}
function calculateCostUsd(usage, model) {
  const p = getModelPricing(model);
  return (usage.inputTokens || 0) / 1e6 * p.input + (usage.outputTokens || 0) / 1e6 * p.output + (usage.cacheReadTokens || 0) / 1e6 * p.cacheRead + (usage.cacheWriteTokens || 0) / 1e6 * p.cacheWrite;
}
function calculateCostBreakdown(usage, model) {
  const p = getModelPricing(model);
  return {
    input: (usage.inputTokens || 0) / 1e6 * p.input,
    output: (usage.outputTokens || 0) / 1e6 * p.output,
    cacheRead: (usage.cacheReadTokens || 0) / 1e6 * p.cacheRead,
    cacheWrite: (usage.cacheWriteTokens || 0) / 1e6 * p.cacheWrite
  };
}
function updateSessionMetrics(usage, model) {
  sessionMetrics.turns += 1;
  sessionMetrics.totalInput += usage.inputTokens;
  sessionMetrics.totalOutput += usage.outputTokens;
  sessionMetrics.totalCacheRead += usage.cacheReadTokens;
  sessionMetrics.totalCacheWrite += usage.cacheWriteTokens;
  sessionMetrics.totalWebSearchRequests += usage.webSearchRequests || 0;
  const totalPrompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const hitRate = totalPrompt > 0 ? usage.cacheReadTokens / totalPrompt : 0;
  sessionMetrics.recentCacheRates.push(hitRate);
  if (sessionMetrics.recentCacheRates.length > 5) {
    sessionMetrics.recentCacheRates.shift();
  }
  const breakdown = calculateCostBreakdown(usage, model);
  sessionMetrics.costBreakdown.input += breakdown.input;
  sessionMetrics.costBreakdown.output += breakdown.output;
  sessionMetrics.costBreakdown.cacheRead += breakdown.cacheRead;
  sessionMetrics.costBreakdown.cacheWrite += breakdown.cacheWrite;
  sessionMetrics.sessionCostUsd += calculateCostUsd(usage, model);
  if (model) {
    if (!sessionMetrics.perModel[model]) {
      sessionMetrics.perModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 };
    }
    const pm = sessionMetrics.perModel[model];
    pm.input += usage.inputTokens;
    pm.output += usage.outputTokens;
    pm.cacheRead += usage.cacheReadTokens;
    pm.cacheWrite += usage.cacheWriteTokens;
    pm.costUsd += calculateCostUsd(usage, model);
    pm.turns += 1;
    sessionMetrics.lastModelId = model;
  }
  writeCacheStatsFile(usage, model, hitRate);
  if (sessionMetrics.tokenBudget.limit > 0) {
    sessionMetrics.tokenBudget.used += usage.outputTokens;
    sessionMetrics.tokenBudget.continuations += 1;
    sessionMetrics.tokenBudget.outputHistory.push(usage.outputTokens);
    if (sessionMetrics.tokenBudget.outputHistory.length > 5) {
      sessionMetrics.tokenBudget.outputHistory.shift();
    }
  }
}
function getAverageCacheHitRate() {
  const rates = sessionMetrics.recentCacheRates;
  if (rates.length === 0) return 0;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}
function writeCacheStatsFile(usage, model, hitRate) {
  try {
    const statsPath = join6(getConfigDir(), "cache-stats.json");
    const avgHitRate = getAverageCacheHitRate();
    const totalPrompt = sessionMetrics.totalInput + sessionMetrics.totalCacheRead + sessionMetrics.totalCacheWrite;
    const sessionHitRate = totalPrompt > 0 ? sessionMetrics.totalCacheRead / totalPrompt : 0;
    const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-opus-4-6"] || { input: 15, cacheRead: 1.5 };
    const savedPerMToken = pricing.input - (pricing.cacheRead || pricing.input * 0.1);
    const sessionSavingsUsd = sessionMetrics.totalCacheRead / 1e6 * savedPerMToken;
    const stats = {
      // Per-turn stats (latest request)
      turn: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        cache_hit_rate: Math.round(hitRate * 1e3) / 1e3,
        model
      },
      // Session-level stats
      session: {
        turns: sessionMetrics.turns,
        total_input: sessionMetrics.totalInput,
        total_output: sessionMetrics.totalOutput,
        total_cache_read: sessionMetrics.totalCacheRead,
        total_cache_write: sessionMetrics.totalCacheWrite,
        session_hit_rate: Math.round(sessionHitRate * 1e3) / 1e3,
        avg_recent_hit_rate: Math.round(avgHitRate * 1e3) / 1e3,
        cost_usd: Math.round(sessionMetrics.sessionCostUsd * 1e4) / 1e4,
        cache_savings_usd: Math.round(sessionSavingsUsd * 1e4) / 1e4
      },
      // Config state
      config: {
        cache_ttl: _pluginConfig?.cache_policy?.ttl ?? "1h",
        boundary_marker: _pluginConfig?.cache_policy?.boundary_marker ?? false,
        anti_verbosity: _pluginConfig?.anti_verbosity?.enabled !== false,
        length_anchors: _pluginConfig?.anti_verbosity?.length_anchors !== false
      },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    writeFileSync4(statsPath, JSON.stringify(stats, null, 2));
  } catch {
  }
}
var TelemetryEmitter = class {
  #enabled = false;
  #sent = false;
  #disabled = false;
  // permanently disabled for this session (on auth failure)
  #deviceId = null;
  #sessionId = null;
  #cliVersion = null;
  #accountUuid = "";
  #orgUuid = "";
  constructor() {
    this.#sessionId = randomUUID();
  }
  /**
   * Initialize with session context. Call once config and accounts are ready.
   * @param {object} opts
   * @param {boolean} opts.enabled
   * @param {string} opts.deviceId
   * @param {string} opts.cliVersion
   * @param {string} [opts.accountUuid]
   * @param {string} [opts.orgUuid]
   * @param {string} [opts.sessionId] - Must match signatureSessionId for correlation
   */
  init({ enabled, deviceId, cliVersion, accountUuid, orgUuid, sessionId }) {
    this.#enabled = enabled;
    this.#deviceId = deviceId;
    this.#cliVersion = cliVersion;
    this.#accountUuid = accountUuid || "";
    this.#orgUuid = orgUuid || "";
    if (sessionId) this.#sessionId = sessionId;
  }
  /**
   * Build a ClaudeCodeInternalEvent matching the schema from reverse-engineering.
   * @param {string} eventName
   * @param {object} [extras]
   * @returns {object}
   */
  #buildEvent(eventName, extras = {}) {
    return {
      event_type: "ClaudeCodeInternalEvent",
      event_data: {
        event_id: randomUUID(),
        event_name: eventName,
        client_timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        device_id: this.#deviceId,
        email: "",
        // RE doc §7.2 — present but empty (privacy: don't leak email in telemetry)
        auth: {
          account_uuid: this.#accountUuid,
          organization_uuid: this.#orgUuid
        },
        core: {
          session_id: this.#sessionId,
          model: "",
          // empty — don't reveal model choice
          user_type: "consumer",
          // RE doc §7.2 — default consumer for Claude.ai OAuth
          client_type: "cli",
          // RE doc §7.2 — always cli
          betas: [],
          // RE doc §7.2 — populated at send time if needed
          is_interactive: true,
          entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || "cli"
        },
        env: {
          platform: process.platform,
          arch: process.arch,
          node_version: process.version,
          terminal: process.env.TERM_PROGRAM || process.env.TERM || "",
          version: this.#cliVersion,
          build_time: CLAUDE_CODE_BUILD_TIME,
          is_ci: false
        },
        ...extras
      }
    };
  }
  /**
   * Send a batch of events to the telemetry endpoint.
   * @param {object[]} events
   * @param {string} accessToken
   * @returns {Promise<boolean>}
   */
  async #sendBatch(events, accessToken) {
    if (!accessToken || events.length === 0) return false;
    try {
      const response = await fetch("https://api.anthropic.com/api/event_logging/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "anthropic-version": "2023-06-01",
          "User-Agent": `claude-code/${this.#cliVersion}`,
          "x-service-name": "claude-code"
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(1e4)
        // 10s timeout
      });
      if (response.status === 401 || response.status === 403) {
        this.#disabled = true;
        return false;
      }
      if (response.status === 400) {
        this.#disabled = true;
        return false;
      }
      return response.ok;
    } catch {
      return false;
    }
  }
  /**
   * Send startup events after first successful API response.
   * Called once per session with random jitter.
   * @param {string} accessToken
   */
  async sendStartupEvents(accessToken) {
    if (!this.#enabled || this.#sent || this.#disabled) return;
    this.#sent = true;
    const jitter = 500 + Math.random() * 1500;
    await new Promise((resolve2) => setTimeout(resolve2, jitter));
    if (this.#disabled) return;
    const startedEvent = this.#buildEvent("tengu_started");
    const startupTelemetryEvent = this.#buildEvent("tengu_startup_telemetry", {
      is_git: true,
      sandbox_enabled: false
    });
    await this.#sendBatch([startedEvent, startupTelemetryEvent], accessToken);
  }
  /**
   * Send exit event on shutdown. Best-effort, no retry.
   * @param {string} accessToken
   * @param {number} sessionDurationMs
   */
  async sendExitEvent(accessToken, sessionDurationMs) {
    if (!this.#enabled || !this.#sent || this.#disabled) return;
    const exitEvent = this.#buildEvent("tengu_exit", {
      last_session_duration: sessionDurationMs,
      last_session_id: this.#sessionId
    });
    await this.#sendBatch([exitEvent], accessToken).catch(() => {
    });
  }
  get sessionId() {
    return this.#sessionId;
  }
  get enabled() {
    return this.#enabled && !this.#disabled;
  }
};
var telemetryEmitter = new TelemetryEmitter();
var SESSION_START_TIME = Date.now();
var liveTokenRef = { token: "" };
var _beforeExitHandler = () => {
  const duration = Date.now() - SESSION_START_TIME;
  telemetryEmitter.sendExitEvent(liveTokenRef.token, duration).catch(() => {
  });
};
process.once("beforeExit", _beforeExitHandler);
var FALLBACK_CLAUDE_CLI_VERSION = "2.1.114";
var CLAUDE_CODE_NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
var CLAUDE_CODE_BUILD_TIME = "2026-04-17T22:37:24Z";
var BILLING_HASH_SALT = "59cf53e54c78";
var BILLING_HASH_INDICES = [4, 7, 20];
var _xxh64Raw = null;
var _xxhashReady = e().then((h) => {
  _xxh64Raw = h.h64Raw;
});
function computeBillingCacheHash(firstUserMessage, version) {
  const chars = BILLING_HASH_INDICES.map((i) => firstUserMessage[i] || "0").join("");
  const input = `${BILLING_HASH_SALT}${chars}${version}`;
  return createHashCrypto("sha256").update(input).digest("hex").slice(0, 3);
}
function applyContextHintCompaction(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, stats: { thinkingCleared: 0, toolResultsCleared: 0 } };
  }
  const keepRecent = opts.keepRecentToolResults ?? 8;
  const placeholder = opts.clearedPlaceholder ?? "[Old tool result content cleared]";
  const toolResultRefs = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      if (msg.content[j]?.type === "tool_result") {
        toolResultRefs.push({ msgIdx: i, blockIdx: j });
      }
    }
  }
  const oldCutoff = Math.max(0, toolResultRefs.length - keepRecent);
  const oldSet = new Set(toolResultRefs.slice(0, oldCutoff).map((r) => `${r.msgIdx}:${r.blockIdx}`));
  let thinkingCleared = 0;
  let toolResultsCleared = 0;
  const out = messages.map((msg, i) => {
    if (!Array.isArray(msg.content)) return msg;
    if (msg.role === "assistant") {
      const newContent = msg.content.filter((block) => {
        if (block?.type === "thinking" || block?.type === "redacted_thinking") {
          thinkingCleared += 1;
          return false;
        }
        return true;
      });
      if (newContent.length !== msg.content.length) {
        return { ...msg, content: newContent };
      }
      return msg;
    }
    if (msg.role === "user") {
      let mutated = false;
      const newContent = msg.content.map((block, j) => {
        if (block?.type !== "tool_result") return block;
        const key = `${i}:${j}`;
        if (!oldSet.has(key)) return block;
        toolResultsCleared += 1;
        mutated = true;
        return {
          ...block,
          content: placeholder
        };
      });
      return mutated ? { ...msg, content: newContent } : msg;
    }
    return msg;
  });
  return {
    messages: out,
    changed: thinkingCleared > 0 || toolResultsCleared > 0,
    stats: { thinkingCleared, toolResultsCleared }
  };
}
var REPRODUCIBLE_TOOL_NAMES = /* @__PURE__ */ new Set(["read", "grep", "glob", "ls", "list", "find"]);
function titleCaseToolName(name) {
  if (typeof name !== "string" || name.length === 0) return "";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}
function stableStringifyForDedupe(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringifyForDedupe(v)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringifyForDedupe(value[k]));
  }
  return "{" + parts.join(",") + "}";
}
function applySessionToolResultDedupe(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, stats: { deduped: 0 } };
  }
  const idToMeta = /* @__PURE__ */ new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (!REPRODUCIBLE_TOOL_NAMES.has(name.toLowerCase())) continue;
      const argsKey = stableStringifyForDedupe(block.input ?? {});
      idToMeta.set(block.id, { name, argsKey });
    }
  }
  const groups = /* @__PURE__ */ new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block?.type !== "tool_result") continue;
      const meta = idToMeta.get(block.tool_use_id);
      if (!meta) continue;
      const groupKey = meta.name.toLowerCase() + "\0" + meta.argsKey;
      let arr = groups.get(groupKey);
      if (!arr) {
        arr = [];
        groups.set(groupKey, arr);
      }
      arr.push({
        msgIdx: i,
        blockIdx: j,
        toolUseId: block.tool_use_id,
        name: meta.name,
        argsKey: meta.argsKey
      });
    }
  }
  const supersedeStubs = /* @__PURE__ */ new Map();
  let deduped = 0;
  const sortedEntries = Array.from(groups.entries()).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  for (const [, occurrences] of sortedEntries) {
    if (occurrences.length < 2) continue;
    const latest = occurrences[occurrences.length - 1];
    const stub = "[" + titleCaseToolName(latest.name) + " of " + latest.argsKey + " superseded by later read at msg #" + latest.msgIdx + "]";
    for (let k = 0; k < occurrences.length - 1; k++) {
      const occ = occurrences[k];
      supersedeStubs.set(occ.msgIdx + ":" + occ.blockIdx, stub);
      deduped += 1;
    }
  }
  if (deduped === 0) {
    return { messages, changed: false, stats: { deduped: 0 } };
  }
  const out = messages.map((msg, i) => {
    if (msg?.role !== "user" || !Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((block, j) => {
      if (block?.type !== "tool_result") return block;
      const stub = supersedeStubs.get(i + ":" + j);
      if (!stub) return block;
      mutated = true;
      return { ...block, content: stub };
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });
  return { messages: out, changed: true, stats: { deduped } };
}
function maybeApplySessionToolResultDedupe(messages, config) {
  const flag = config?.token_economy_strategies?.tool_result_dedupe_session_wide;
  if (flag !== true) return messages;
  const result = applySessionToolResultDedupe(messages);
  return result.messages;
}
function applyTtlThinkingStrip(messages, ctx) {
  const now = ctx.now ?? Date.now();
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, cleared: 0, ranStripAt: ctx.lastClearMs };
  }
  if (ctx.lastClearMs > 0 && now - ctx.lastClearMs < ctx.ttlMs) {
    return { messages, changed: false, cleared: 0, ranStripAt: ctx.lastClearMs };
  }
  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }
  let cleared = 0;
  const out = messages.map((msg, i) => {
    if (msg.role !== "assistant" || i === lastAsstIdx || !Array.isArray(msg.content)) {
      return msg;
    }
    const newContent = msg.content.filter((b) => {
      if (b?.type === "thinking" || b?.type === "redacted_thinking") {
        cleared += 1;
        return false;
      }
      return true;
    });
    return newContent.length !== msg.content.length ? { ...msg, content: newContent } : msg;
  });
  return { messages: out, changed: cleared > 0, cleared, ranStripAt: cleared > 0 ? now : ctx.lastClearMs };
}
function applyProactiveMicrocompact(messages, ctx) {
  const threshold = ctx.contextWindow * (ctx.percent / 100);
  if (ctx.estimatedTokens < threshold) {
    return { messages, changed: false, cleared: 0, triggered: false };
  }
  const result = applyContextHintCompaction(messages, { keepRecentToolResults: ctx.keepRecent });
  return {
    messages: result.messages,
    changed: result.changed,
    cleared: result.stats.toolResultsCleared,
    triggered: true
  };
}
function applyStableToolOrdering(tools) {
  if (!Array.isArray(tools) || tools.length < 2) return tools;
  return [...tools].sort((a, b) => {
    const an = typeof a?.name === "string" ? a.name : "";
    const bn = typeof b?.name === "string" ? b.name : "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}
function applyToolSchemaDeferral(tools, ctx) {
  if (!Array.isArray(tools) || ctx.deferred.size === 0) {
    return { tools, deferredCount: 0 };
  }
  let deferredCount = 0;
  const out = tools.map((t2) => {
    const name = typeof t2?.name === "string" ? t2.name : "";
    if (!ctx.deferred.has(name) || ctx.invoked.has(name)) return t2;
    deferredCount += 1;
    return {
      ...t2,
      input_schema: { type: "object", properties: {}, additionalProperties: true }
    };
  });
  return { tools: out, deferredCount };
}
function applyAdaptiveThinkingZero(parsed) {
  if (!parsed || !parsed.thinking || parsed.thinking.type !== "enabled") {
    return { applied: false, previousBudget: null };
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length < 2) return { applied: false, previousBudget: null };
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { applied: false, previousBudget: null };
  let userText = "";
  if (typeof last.content === "string") userText = last.content;
  else if (Array.isArray(last.content)) {
    for (const b of last.content) {
      if (b?.type === "text" && typeof b.text === "string") userText += b.text;
      if (b?.type === "tool_result") return { applied: false, previousBudget: null };
    }
  }
  if (userText.length > 200) return { applied: false, previousBudget: null };
  if (/\b(analyze|refactor|design|review|audit|plan)\b/i.test(userText)) {
    return { applied: false, previousBudget: null };
  }
  const previousBudget = typeof parsed.thinking.budget_tokens === "number" ? parsed.thinking.budget_tokens : null;
  delete parsed.thinking;
  if (typeof parsed.temperature !== "number") parsed.temperature = 1;
  return { applied: true, previousBudget };
}
function applyToolResultDedupe(messages, ctx) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, deduped: 0 };
  }
  const idToKey = /* @__PURE__ */ new Map();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type !== "tool_use") continue;
      if (!ctx.safeTools.has(b.name)) continue;
      const inputStr = JSON.stringify(b.input ?? {});
      idToKey.set(b.id, `${b.name}::${inputStr}`);
    }
  }
  let deduped = 0;
  const out = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((b) => {
      if (b?.type !== "tool_result") return b;
      const key = idToKey.get(b.tool_use_id);
      if (!key) return b;
      const firstSeen = ctx.seen.get(key);
      if (firstSeen && firstSeen !== b.tool_use_id) {
        deduped += 1;
        mutated = true;
        return { ...b, content: `[Identical to tool_use_id=${firstSeen}]` };
      }
      if (!firstSeen) ctx.seen.set(key, b.tool_use_id);
      return b;
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });
  return { messages: out, changed: deduped > 0, deduped };
}
function applyTrailingSummaryTrim(messages) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { messages, changed: false, trimmed: 0 };
  }
  const SUMMARY_PATTERNS = [
    /\b(summary|summar(y|ised|ized)):/i,
    /\bto summari[sz]e\b/i,
    /^\s*in (summary|short|brief)/im,
    /\bi['']ve (done|completed|implemented|added|updated|fixed) /i,
    /\bthat's it\b/i
  ];
  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }
  let trimmed = 0;
  const out = messages.map((msg, i) => {
    if (msg.role !== "assistant" || i === lastAsstIdx) return msg;
    if (!Array.isArray(msg.content)) return msg;
    const last = msg.content[msg.content.length - 1];
    if (!last || last.type !== "text" || typeof last.text !== "string") return msg;
    const text = last.text;
    if (text.length < 80) return msg;
    const isSummary = SUMMARY_PATTERNS.some((p) => p.test(text));
    if (!isSummary) return msg;
    trimmed += 1;
    const newContent = msg.content.slice(0, -1);
    if (newContent.length === 0) return msg;
    return { ...msg, content: newContent };
  });
  return { messages: out, changed: trimmed > 0, trimmed };
}
function repairOrphanedToolUseBlocks(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const repaired = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    repaired.push(msg);
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const toolUseIds = [];
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;
    const next = messages[i + 1];
    if (next && next.role === "user" && Array.isArray(next.content)) {
      const resultIds = /* @__PURE__ */ new Set();
      for (const block of next.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          resultIds.add(block.tool_use_id);
        }
      }
      const missingIds = toolUseIds.filter((id) => !resultIds.has(id));
      if (missingIds.length === 0) continue;
      const patchedNext = {
        ...next,
        content: [
          ...missingIds.map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: "[Result unavailable \u2014 tool execution was interrupted]"
          })),
          ...next.content
        ]
      };
      i++;
      repaired.push(patchedNext);
    } else {
      repaired.push({
        role: "user",
        content: toolUseIds.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          content: "[Result unavailable \u2014 tool execution was interrupted]"
        }))
      });
    }
  }
  return repaired;
}
function stripSlashCommandMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const CMD_RE = /^\s*\/anthropic\b/i;
  const RESP_RE = /^▣\s*Anthropic/;
  function getFirstText(msg) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") return block.text;
      }
    }
    return "";
  }
  function isCommandMessage(msg) {
    if (msg.role !== "user") return false;
    const text = getFirstText(msg);
    return CMD_RE.test(text);
  }
  function isCommandResponse(msg) {
    if (msg.role !== "assistant") return false;
    const text = getFirstText(msg);
    return RESP_RE.test(text);
  }
  const filtered = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isCommandMessage(msg)) {
      if (i + 1 < messages.length && isCommandResponse(messages[i + 1])) {
        i++;
      }
      continue;
    }
    if (isCommandResponse(msg)) {
      continue;
    }
    filtered.push(msg);
  }
  if (filtered.length === 0) return messages;
  return filtered;
}
function extractFirstUserMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") return block.text;
      }
    }
    return "";
  }
  return "";
}
var CLAUDE_CODE_BETA_FLAG = "claude-code-20250219";
var EFFORT_BETA_FLAG = "effort-2025-11-24";
var ADVANCED_TOOL_USE_BETA_FLAG = "advanced-tool-use-2025-11-20";
var FAST_MODE_BETA_FLAG = "fast-mode-2026-02-01";
var TOKEN_COUNTING_BETA_FLAG = "token-counting-2024-11-01";
var CLAUDE_CODE_IDENTITY_STRING = "You are Claude Code, Anthropic's official CLI for Claude.";
var KNOWN_IDENTITY_STRINGS = /* @__PURE__ */ new Set([
  CLAUDE_CODE_IDENTITY_STRING,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."
]);
var BEDROCK_UNSUPPORTED_BETAS = /* @__PURE__ */ new Set([
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
  "tool-search-tool-2025-10-19"
]);
var CORE_TOOL_NAMES = /* @__PURE__ */ new Set([
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "WebFetch",
  "TodoWrite",
  "Skill",
  "Task",
  "Compress"
]);
var HOST_SDK_BETAS_BLOCKLIST = /* @__PURE__ */ new Set(["fine-grained-tool-streaming-2025-05-14", "structured-outputs-2025-11-13"]);
var EXPERIMENTAL_BETA_FLAGS = /* @__PURE__ */ new Set([
  "adaptive-thinking-2026-01-28",
  "advanced-tool-use-2025-11-20",
  "advisor-tool-2026-03-01",
  "afk-mode-2026-01-31",
  "code-execution-2025-08-25",
  "compact-2026-01-12",
  "context-1m-2025-08-07",
  "context-hint-2026-04-09",
  "context-management-2025-06-27",
  "fast-mode-2026-02-01",
  "files-api-2025-04-14",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "redact-thinking-2026-02-12",
  "structured-outputs-2025-12-15",
  "task-budgets-2026-03-13",
  "tool-search-tool-2025-10-19",
  "web-search-2025-03-05"
]);
var BETA_SHORTCUTS = /* @__PURE__ */ new Map([
  ["1m", "context-1m-2025-08-07"],
  ["1m-context", "context-1m-2025-08-07"],
  ["context-1m", "context-1m-2025-08-07"],
  ["context-hint", "context-hint-2026-04-09"],
  ["hint", "context-hint-2026-04-09"],
  ["fast", "fast-mode-2026-02-01"],
  ["fast-mode", "fast-mode-2026-02-01"],
  ["opus-fast", "fast-mode-2026-02-01"],
  ["task-budgets", "task-budgets-2026-03-13"],
  ["budgets", "task-budgets-2026-03-13"],
  ["redact-thinking", "redact-thinking-2026-02-12"]
]);
var STAINLESS_HELPER_KEYS = [
  "x_stainless_helper",
  "x-stainless-helper",
  "stainless_helper",
  "stainlessHelper",
  "_stainless_helper"
];
var USER_ID_STORAGE_FILE = "anthropic-signature-user-id";
var DEBUG_SYSTEM_PROMPT_ENV = "OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT";
var SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
var COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT = [
  "You are a title generator. You output ONLY a thread title. Nothing else.",
  "",
  "Rules:",
  "- Use the same language as the user message.",
  "- Output exactly one line.",
  "- Keep the title at or below 50 characters.",
  "- No explanations, prefixes, or suffixes.",
  "- Keep important technical terms, numbers, and filenames when present."
].join("\n");
var ANTI_VERBOSITY_SYSTEM_PROMPT = [
  "# Communication style",
  "Assume users can't see most tool calls or thinking \u2014 only your text output. Before your first tool call, state in one sentence what you're about to do. While working, give short updates at key moments: when you find something, when you change direction, or when you hit a blocker. Brief is good \u2014 silent is not. One sentence per update is almost always enough.",
  "",
  "Don't narrate your internal deliberation. User-facing text should be relevant communication to the user, not a running commentary on your thought process. State results and decisions directly, and focus user-facing text on relevant updates for the user.",
  "",
  "When you do write updates, write so the reader can pick up cold: complete sentences, no unexplained jargon or shorthand from earlier in the session. But keep it tight \u2014 a clear sentence is better than a clear paragraph.",
  "",
  "End-of-turn summary: one or two sentences. What changed and what's next. Nothing else.",
  "",
  "Match responses to the task: a simple question gets a direct answer, not headers and sections.",
  "",
  "In code: default to writing no comments. Never write multi-paragraph docstrings or multi-line comment blocks \u2014 one short line max. Don't create planning, decision, or analysis documents unless the user asks for them \u2014 work from conversation context, not intermediate files."
].join("\n");
var NUMERIC_LENGTH_ANCHORS_PROMPT = "Length limits: keep text between tool calls to \u226425 words. Keep final responses to \u2264100 words unless the task requires more detail.";
function getOrCreateDeviceId() {
  const configDir = getConfigDir();
  const userIdPath = join6(configDir, USER_ID_STORAGE_FILE);
  try {
    if (existsSync5(userIdPath)) {
      const existing = readFileSync5(userIdPath, "utf-8").trim();
      if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
    }
  } catch {
  }
  const generated = randomBytes5(32).toString("hex");
  try {
    mkdirSync3(configDir, { recursive: true });
    writeFileSync4(userIdPath, `${generated}
`, { encoding: "utf-8", mode: 384 });
  } catch {
  }
  return generated;
}
function shouldDebugSystemPrompt() {
  return isTruthyEnv(process.env[DEBUG_SYSTEM_PROMPT_ENV]);
}
function isTruthyEnv(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
function isFalsyEnv(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}
function resolveBetaShortcut(value) {
  if (!value) return "";
  const trimmed = value.trim();
  const mapped = BETA_SHORTCUTS.get(trimmed.toLowerCase());
  return mapped || trimmed;
}
function isNonInteractiveMode() {
  if (isTruthyEnv(process.env.CI)) return true;
  return !process.stdout.isTTY;
}
function buildExtendedUserAgent(version) {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli";
  const sdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : "";
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}` : "";
  return `claude-cli/${version} (external, ${entrypoint}${sdkVersion}${clientApp})`;
}
function parseAnthropicCustomHeaders() {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return {};
  const headers = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!key || !value) continue;
    headers[key] = value;
  }
  return headers;
}
function logTransformedSystemPrompt(body) {
  if (!shouldDebugSystemPrompt()) return;
  if (!body || typeof body !== "string") return;
  try {
    const parsed = JSON.parse(body);
    if (!Object.prototype.hasOwnProperty.call(parsed, "system")) return;
    if (isTitleGeneratorSystemBlocks(normalizeSystemTextBlocks(parsed.system))) return;
    console.error(
      "[opencode-anthropic-auth][system-debug] transformed system:",
      JSON.stringify(parsed.system, null, 2)
    );
  } catch {
  }
}
function isHaikuModel(model) {
  return /haiku/i.test(model);
}
function isOpus46Model(model) {
  if (!model) return false;
  return /claude-opus-4[._-]6|opus[._-]4[._-]6/i.test(model);
}
function isOpus47Model(model) {
  if (!model) return false;
  return /claude-opus-4[._-]7|opus[._-]4[._-]7/i.test(model);
}
function isSonnet46Model(model) {
  if (!model) return false;
  return /claude-sonnet-4[._-]6|sonnet[._-]4[._-]6/i.test(model);
}
function isAdaptiveThinkingModel(model) {
  return isOpus46Model(model) || isOpus47Model(model) || isSonnet46Model(model);
}
function isEligibleFor1MContext(model) {
  if (!model) return false;
  if (/(^|[-_ ])1m($|[-_ ])|context[-_]?1m|\[1m\]/i.test(model)) return true;
  return /claude-sonnet-4|sonnet[._-]4/i.test(model) || isOpus46Model(model) || isOpus47Model(model);
}
function hasOneMillionContext(model) {
  return /(^|[-_ ])1m($|[-_ ])|context[-_]?1m/i.test(model);
}
function supportsStructuredOutputs(model) {
  if (!/claude|sonnet|opus|haiku/i.test(model)) return false;
  return !isHaikuModel(model);
}
function supportsWebSearch(model) {
  return /claude|sonnet|opus|haiku|gpt|gemini/i.test(model);
}
function detectProvider(requestUrl) {
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)) return "anthropicAws";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_MANTLE)) return "mantle";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (!requestUrl) return "anthropic";
  const host = requestUrl.hostname.toLowerCase();
  if (host.includes("mantle")) return "mantle";
  if (host.includes("anthropicaws")) return "anthropicAws";
  if (host.includes("bedrock") || host.includes("amazonaws.com")) return "bedrock";
  if (host.includes("aiplatform") || host.includes("vertex")) return "vertex";
  if (host.includes("foundry") || host.includes("azure")) return "foundry";
  return "anthropic";
}
function classifyRequestRole(parsed) {
  if (!parsed || typeof parsed !== "object") return "unknown";
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const maxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : null;
  if (messages.length === 0) return "empty";
  if (maxTokens != null) {
    if (maxTokens <= 256 && messages.length <= 2) return "title";
    if (maxTokens <= 1024) return "small";
  }
  let sysLen = 0;
  if (typeof parsed.system === "string") {
    sysLen = parsed.system.length;
  } else if (Array.isArray(parsed.system)) {
    for (const s of parsed.system) {
      if (s && typeof s.text === "string") sysLen += s.text.length;
    }
  }
  if (sysLen < 200 && messages.length <= 2 && (maxTokens == null || maxTokens <= 2048)) {
    return "small";
  }
  return "main";
}
function parseRequestBodyMetadata(body, parsedBody) {
  const parsed = parsedBody || (typeof body === "string" ? (() => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })() : null);
  if (!parsed) {
    return { model: "", tools: [], messages: [], hasFileReferences: false };
  }
  const model = typeof parsed?.model === "string" ? parsed.model : "";
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const hasFileReferences = extractFileIds(parsed).length > 0;
  return { model, tools, messages, hasFileReferences };
}
function buildStainlessHelperHeader(tools, messages) {
  const helpers = /* @__PURE__ */ new Set();
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const key of STAINLESS_HELPER_KEYS) {
      if (typeof value[key] === "string" && value[key]) {
        helpers.add(value[key]);
      }
    }
    if (Array.isArray(value.content)) {
      for (const contentBlock of value.content) {
        collect(contentBlock);
      }
    }
  };
  for (const tool of tools) collect(tool);
  for (const message of messages) collect(message);
  return Array.from(helpers).join(", ");
}
function getAccountIdentifier(account) {
  const envUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID?.trim();
  if (envUuid) return envUuid;
  if (account?.accountUuid && typeof account.accountUuid === "string") {
    return account.accountUuid;
  }
  if (account?.id && typeof account.id === "string") {
    return account.id;
  }
  return "";
}
function buildRequestMetadata(input) {
  const envUserId = process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID?.trim();
  if (envUserId) return { user_id: envUserId };
  const extraMetadataEnv = process.env.CLAUDE_CODE_EXTRA_METADATA?.trim();
  let extraMetadata = {};
  if (extraMetadataEnv) {
    try {
      const parsed = JSON.parse(extraMetadataEnv);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extraMetadata = parsed;
      }
    } catch {
    }
  }
  return {
    user_id: JSON.stringify({
      ...extraMetadata,
      device_id: input.persistentUserId,
      account_uuid: input.accountId,
      session_id: input.sessionId
    })
  };
}
function buildAnthropicBillingHeader(version, firstUserMessage, provider) {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
  const fingerprint = computeBillingCacheHash(firstUserMessage || "", version);
  const ccVersion = `${version}.${fingerprint}`;
  const cchDisabled = provider === "bedrock" || provider === "anthropicAws" || provider === "mantle";
  const cchPart = cchDisabled ? "" : " cch=00000;";
  let workloadPart = "";
  const workload = process.env.CLAUDE_CODE_WORKLOAD;
  if (workload) {
    const safeWorkload = workload.replace(/[;\s\r\n]/g, "_");
    workloadPart = ` cc_workload=${safeWorkload};`;
  }
  return `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${entrypoint};${cchPart}${workloadPart}`;
}
var MAX_SAFE_SYSTEM_TEXT_LENGTH = 5e3;
var MAX_SUBAGENT_CC_PREFIX = MAX_SAFE_SYSTEM_TEXT_LENGTH;
var SUBAGENT_CC_ANCHOR = "You are an interactive";
var cachedCCPrompt = null;
function sanitizeSystemText(text) {
  let sanitized = text.replace(/\bOpenCode\b/g, "Claude Code").replace(/\bopencode\b/gi, "Claude");
  const ccStandardStart = sanitized.indexOf("You are an interactive");
  if (ccStandardStart > 0) {
    sanitized = sanitized.slice(ccStandardStart);
  }
  return sanitized;
}
function tailSystemBlock(text, maxChars, turnThreshold) {
  const lines = text.split("\n");
  const kept = [];
  let charCount = 0;
  const importantRe = /\b(MUST|NEVER|CRITICAL|IMPORTANT|REQUIRED|DO NOT|ALWAYS|FORBIDDEN)\b/i;
  const headerRe = /^#{1,4}\s/;
  const listItemRe = /^\s*[-*]\s/;
  let firstParaEnd = 0;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].trim() === "" && j > 0) {
      firstParaEnd = j;
      break;
    }
  }
  if (firstParaEnd === 0) firstParaEnd = Math.min(5, lines.length);
  for (let j = 0; j <= firstParaEnd; j++) {
    kept.push(lines[j]);
    charCount += (lines[j]?.length || 0) + 1;
  }
  for (let j = firstParaEnd + 1; j < lines.length; j++) {
    const line = lines[j];
    const isHeader = headerRe.test(line);
    const isImportant = importantRe.test(line);
    const isShortListItem = listItemRe.test(line) && line.length < 120;
    if (isHeader || isImportant || isShortListItem) {
      if (charCount + line.length + 1 > maxChars) break;
      kept.push(line);
      charCount += line.length + 1;
    }
  }
  kept.push("", "[Verbose instructions trimmed after turn " + turnThreshold + ". Key constraints preserved above.]");
  return kept.join("\n");
}
function compactToolDescription(text) {
  return text.replace(/<example[\s\S]*?<\/example>/gi, "").replace(/\|[\s|:-]+\|/g, "").replace(/^\|.*\|$/gm, "").replace(/^(?:\s*[-*]\s+.{200,})$/gm, (m) => m.slice(0, 200) + "...").replace(/^(#{1,3}\s+)/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\n{3,}/g, "\n\n").trim();
}
function compactSystemText(text, mode) {
  const withoutDuplicateIdentityPrefix = text.startsWith(`${CLAUDE_CODE_IDENTITY_STRING}
`) ? text.slice(CLAUDE_CODE_IDENTITY_STRING.length).trimStart() : text;
  if (mode === "off") {
    return withoutDuplicateIdentityPrefix.trim();
  }
  const compacted = withoutDuplicateIdentityPrefix.replace(/<example>[\s\S]*?<\/example>/gi, "\n");
  const dedupedLines = [];
  let prevNormalized = "";
  for (const line of compacted.split("\n")) {
    const normalized = line.trim();
    if (normalized && normalized === prevNormalized) continue;
    dedupedLines.push(line);
    prevNormalized = normalized;
  }
  return dedupedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function normalizeSystemTextForComparison(text) {
  return text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function dedupeSystemBlocks(system) {
  const exactSeen = /* @__PURE__ */ new Set();
  const exactDeduped = [];
  for (const item of system) {
    const normalized = normalizeSystemTextForComparison(item.text);
    const key = `${item.type}:${normalized}`;
    if (exactSeen.has(key)) continue;
    exactSeen.add(key);
    exactDeduped.push(item);
  }
  const normalizedBlocks = exactDeduped.map((item) => normalizeSystemTextForComparison(item.text));
  return exactDeduped.filter((_, index) => {
    const current = normalizedBlocks[index];
    if (current.length < 80) return true;
    for (let otherIndex = 0; otherIndex < normalizedBlocks.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = normalizedBlocks[otherIndex];
      if (other.length <= current.length + 20) continue;
      if (other.includes(current)) return false;
    }
    return true;
  });
}
function isTitleGeneratorSystemText(text) {
  const normalized = text.trim().toLowerCase();
  return normalized.includes("you are a title generator") || normalized.includes("generate a brief title");
}
function isTitleGeneratorSystemBlocks(system) {
  return system.some(
    (item) => item.type === "text" && typeof item.text === "string" && isTitleGeneratorSystemText(item.text)
  );
}
function normalizeSystemTextBlocks(system) {
  const output = [];
  if (!Array.isArray(system)) return output;
  for (const item of system) {
    if (typeof item === "string") {
      output.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (typeof item.text !== "string") continue;
    const normalized = {
      type: typeof item.type === "string" ? item.type : "text",
      text: item.text
    };
    output.push(normalized);
  }
  return output;
}
function getCLISyspromptPrefix() {
  if (isTruthyEnv(process.env.CLAUDE_AGENT_SDK_VERSION) && isTruthyEnv(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "";
    if (entrypoint === "agent-sdk" || entrypoint === "sdk") {
      return "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
    }
  }
  if (isTruthyEnv(process.env.CLAUDE_AGENT_SDK_VERSION) && !isTruthyEnv(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    return "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  }
  return CLAUDE_CODE_IDENTITY_STRING;
}
function getCacheControlForScope(cacheScope, cachePolicy) {
  if (cacheScope === null) return null;
  const hasTtl = cachePolicy.ttl !== "off" && cachePolicy.ttl_supported !== false;
  const result = { type: "ephemeral" };
  if (hasTtl) result.ttl = cachePolicy.ttl;
  if (cacheScope === "global") result.scope = "global";
  return result;
}
function splitSysPromptPrefix(blocks, attributionHeader, identityString, useBoundaryMode) {
  const rest = [];
  for (const block of blocks) {
    if (!block.text) continue;
    if (block.text.startsWith("x-anthropic-billing-header:")) continue;
    if (KNOWN_IDENTITY_STRINGS.has(block.text)) continue;
    if (block.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
    rest.push(block.text);
  }
  if (useBoundaryMode) {
    const boundaryIndex = blocks.findIndex((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    if (boundaryIndex !== -1) {
      const staticBlocks = [];
      const dynamicBlocks = [];
      for (let i = 0; i < blocks.length; i++) {
        const text = blocks[i].text;
        if (!text) continue;
        if (text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
        if (text.startsWith("x-anthropic-billing-header:")) continue;
        if (KNOWN_IDENTITY_STRINGS.has(text)) continue;
        if (i < boundaryIndex) {
          staticBlocks.push(text);
        } else {
          dynamicBlocks.push(text);
        }
      }
      const result2 = [];
      if (attributionHeader) result2.push({ text: attributionHeader, cacheScope: null });
      result2.push({ text: identityString, cacheScope: null });
      const staticJoined = staticBlocks.join("\n");
      if (staticJoined) result2.push({ text: staticJoined, cacheScope: "global" });
      const dynamicJoined = dynamicBlocks.join("\n");
      if (dynamicJoined) result2.push({ text: dynamicJoined, cacheScope: null });
      return result2;
    }
  }
  const result = [];
  if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
  result.push({ text: identityString, cacheScope: "org" });
  const restJoined = rest.join("\n");
  if (restJoined) result.push({ text: restJoined, cacheScope: "org" });
  return result;
}
function buildSystemPromptBlocks(system, signature) {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);
  let sanitized = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text), signature.promptCompactionMode)
  }));
  if (signature.enabled && !titleGeneratorRequest && sanitized.length > 0) {
    const firstText = typeof sanitized[0]?.text === "string" ? sanitized[0].text : "";
    const hasCcAnchor = firstText.startsWith(SUBAGENT_CC_ANCHOR);
    if (hasCcAnchor) {
      if (!cachedCCPrompt) {
        cachedCCPrompt = firstText.slice(0, MAX_SUBAGENT_CC_PREFIX);
      }
    } else if (cachedCCPrompt) {
      sanitized = [{ type: "text", text: cachedCCPrompt }, ...sanitized];
    }
  }
  if (titleGeneratorRequest) {
    sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
  } else if (signature.promptCompactionMode !== "off") {
    sanitized = dedupeSystemBlocks(sanitized);
  }
  if (!titleGeneratorRequest && signature.modelId && (isOpus46Model(signature.modelId) || isOpus47Model(signature.modelId))) {
    const avConfig = signature.antiVerbosity;
    if (avConfig?.enabled !== false) {
      sanitized.push({ type: "text", text: ANTI_VERBOSITY_SYSTEM_PROMPT });
    }
    if (avConfig?.length_anchors !== false) {
      sanitized.push({ type: "text", text: NUMERIC_LENGTH_ANCHORS_PROMPT });
    }
  }
  if (!signature.enabled) {
    return sanitized;
  }
  const leanNonMain = signature.leanNonMain === true && (signature.requestRole === "title" || signature.requestRole === "small") && !titleGeneratorRequest;
  if (leanNonMain) {
    return sanitized;
  }
  const billingHeader = buildAnthropicBillingHeader(
    signature.claudeCliVersion,
    signature.firstUserMessage,
    signature.provider
  );
  const identityString = getCLISyspromptPrefix();
  const effectiveCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };
  const useBoundaryMode = effectiveCachePolicy.boundary_marker || isTruthyEnv(process.env.CLAUDE_CODE_FORCE_GLOBAL_CACHE);
  const scopedBlocks = splitSysPromptPrefix(sanitized, billingHeader || void 0, identityString, useBoundaryMode);
  return scopedBlocks.map((block) => {
    const cc = getCacheControlForScope(block.cacheScope, effectiveCachePolicy);
    return {
      type: "text",
      text: block.text,
      ...cc !== null && { cache_control: cc }
    };
  });
}
function buildAnthropicBetaHeader(incomingBeta, signatureEnabled, model, provider, customBetas, strategy, requestPath, hasFileReferences, adaptiveOverride, tokenEconomy, microcompactBetas) {
  const incomingBetasList = incomingBeta.split(",").map((b) => b.trim()).filter(Boolean);
  const betas = ["oauth-2025-04-20"];
  const disableExperimentalBetas = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const isMessagesCountTokensPath = requestPath === "/v1/messages/count_tokens";
  const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;
  if (!signatureEnabled) {
    betas.push("interleaved-thinking-2025-05-14");
    if (isMessagesCountTokensPath) {
      betas.push(TOKEN_COUNTING_BETA_FLAG);
    }
    let mergedBetas2 = [.../* @__PURE__ */ new Set([...betas, ...incomingBetasList])];
    if (disableExperimentalBetas) {
      mergedBetas2 = mergedBetas2.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
    }
    return mergedBetas2.join(",");
  }
  const nonInteractive = isNonInteractiveMode();
  const haiku = isHaikuModel(model);
  const isRoundRobin = strategy === "round-robin";
  const te = tokenEconomy || {};
  betas.push(CLAUDE_CODE_BETA_FLAG);
  if (provider === "vertex" || provider === "bedrock" || provider === "mantle") {
    betas.push("tool-search-tool-2025-10-19");
  } else {
    betas.push(ADVANCED_TOOL_USE_BETA_FLAG);
  }
  betas.push(FAST_MODE_BETA_FLAG);
  if (isAdaptiveThinkingModel(model)) {
    betas.push(EFFORT_BETA_FLAG);
  }
  if (!isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING) && !/claude-3-/i.test(model)) {
    betas.push("interleaved-thinking-2025-05-14");
  }
  {
    const use1M = adaptiveOverride && typeof adaptiveOverride.use1MContext === "boolean" ? adaptiveOverride.use1MContext : hasOneMillionContext(model);
    if (use1M) {
      betas.push("context-1m-2025-08-07");
    }
  }
  if (!isRoundRobin) {
    betas.push("prompt-caching-scope-2026-01-05");
  }
  if (!/claude-3-/i.test(model)) {
    betas.push("context-management-2025-06-27");
  }
  if (supportsStructuredOutputs(model)) {
    betas.push("structured-outputs-2025-12-15");
  }
  if (supportsWebSearch(model)) {
    betas.push("web-search-2025-03-05");
  }
  if (!/claude-3-/i.test(model)) {
    betas.push("advisor-tool-2026-03-01");
  }
  const isFirstPartyProvider = provider !== "vertex" && provider !== "bedrock" && provider !== "mantle";
  const _isMainThread = te.__requestRole == null || te.__requestRole === "main";
  if (isFirstPartyProvider && !/claude-3-/i.test(model) && te.context_hint !== false && _isMainThread) {
    betas.push("context-hint-2026-04-09");
  }
  if (isFilesEndpoint || hasFileReferences) {
    betas.push("files-api-2025-04-14");
  }
  if (isMessagesCountTokensPath) {
    betas.push(TOKEN_COUNTING_BETA_FLAG);
  }
  if (te.redact_thinking && !disableExperimentalBetas) {
    betas.push("redact-thinking-2026-02-12");
  }
  if (microcompactBetas?.length) {
    for (const mb of microcompactBetas) {
      if (!betas.includes(mb)) betas.push(mb);
    }
  }
  const filteredIncoming = incomingBetasList.filter((b) => !HOST_SDK_BETAS_BLOCKLIST.has(b));
  let mergedBetas = [.../* @__PURE__ */ new Set([...betas, ...filteredIncoming])];
  if (customBetas?.length) {
    for (const custom of customBetas) {
      const resolved = BETA_SHORTCUTS.get(custom) || custom;
      if (resolved && !mergedBetas.includes(resolved)) {
        mergedBetas.push(resolved);
      }
    }
  }
  if (disableExperimentalBetas) {
    mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
  }
  if (provider === "bedrock") {
    mergedBetas = mergedBetas.filter((beta) => !BEDROCK_UNSUPPORTED_BETAS.has(beta));
  }
  return mergedBetas.join(",");
}
function normalizeThinkingBlock(thinking, model) {
  if (!thinking || typeof thinking !== "object") {
    return thinking;
  }
  if (isAdaptiveThinkingModel(model)) {
    if (isTruthyEnv(process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING)) {
      if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
        return thinking;
      }
      const parsedBudget = parseInt(process.env.MAX_THINKING_TOKENS, 10);
      return { type: "enabled", budget_tokens: Number.isNaN(parsedBudget) ? 16e3 : parsedBudget };
    }
    return { type: "adaptive" };
  }
  return thinking;
}
function getStainlessOs(value) {
  if (value === "darwin") return "macOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}
function getStainlessArch(value) {
  if (value === "x64") return "x64";
  if (value === "arm64") return "arm64";
  return value;
}
async function fetchLatestClaudeCodeVersion(timeoutMs = 1200) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CLAUDE_CODE_NPM_LATEST_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || typeof data !== "object") return null;
    return typeof data.version === "string" && data.version ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
function buildRequestHeaders(input, requestInit, accessToken, requestBody, requestUrl, signature, adaptiveOverride, tokenEconomy) {
  const requestHeaders = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }
  if (requestInit.headers) {
    if (requestInit.headers instanceof Headers) {
      requestInit.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    } else if (Array.isArray(requestInit.headers)) {
      for (const [key, value] of requestInit.headers) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    } else {
      for (const [key, value] of Object.entries(requestInit.headers)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    }
  }
  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const { model, tools, messages, hasFileReferences } = parseRequestBodyMetadata(requestBody);
  const provider = detectProvider(requestUrl);
  const mergedBetas = buildAnthropicBetaHeader(
    incomingBeta,
    signature.enabled,
    model,
    provider,
    signature.customBetas,
    signature.strategy,
    requestUrl?.pathname,
    hasFileReferences,
    adaptiveOverride,
    tokenEconomy
  );
  const authTokenOverride = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const bearerToken = authTokenOverride || accessToken;
  requestHeaders.set("authorization", `Bearer ${bearerToken}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", buildExtendedUserAgent(signature.claudeCliVersion));
  if (signature.enabled) {
    requestHeaders.set("anthropic-version", "2023-06-01");
    requestHeaders.set("x-app", isTruthyEnv(process.env.CLAUDE_CODE_BACKGROUND) ? "cli-bg" : "cli");
    if (signature.sessionId) {
      requestHeaders.set("X-Claude-Code-Session-Id", signature.sessionId);
    }
    requestHeaders.set("x-stainless-arch", getStainlessArch(process.arch));
    requestHeaders.set("x-stainless-lang", "js");
    requestHeaders.set("x-stainless-os", getStainlessOs(process.platform));
    requestHeaders.set("x-stainless-package-version", "0.81.0");
    requestHeaders.set("x-stainless-runtime", "node");
    requestHeaders.set("x-stainless-runtime-version", process.version);
    const incomingRetryCount = requestHeaders.get("x-stainless-retry-count");
    requestHeaders.set(
      "x-stainless-retry-count",
      incomingRetryCount && !isFalsyEnv(incomingRetryCount) ? incomingRetryCount : "0"
    );
    requestHeaders.set("x-stainless-timeout", "600");
    requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
    const stainlessHelpers = buildStainlessHelperHeader(tools, messages);
    if (stainlessHelpers) {
      requestHeaders.set("x-stainless-helper", stainlessHelpers);
    }
    for (const [key, value] of Object.entries(parseAnthropicCustomHeaders())) {
      requestHeaders.set(key, value);
    }
    if (process.env.CLAUDE_CODE_CONTAINER_ID) {
      requestHeaders.set("x-claude-remote-container-id", process.env.CLAUDE_CODE_CONTAINER_ID);
    }
    if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) {
      requestHeaders.set("x-claude-remote-session-id", process.env.CLAUDE_CODE_REMOTE_SESSION_ID);
    }
    if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
      requestHeaders.set("x-client-app", process.env.CLAUDE_AGENT_SDK_CLIENT_APP);
    }
    if (isTruthyEnv(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) {
      requestHeaders.set("x-anthropic-additional-protection", "true");
    }
  }
  requestHeaders.delete("x-api-key");
  requestHeaders.delete("x-session-affinity");
  return requestHeaders;
}
function resolveMaxTokens(body, config) {
  if (!config.output_cap?.enabled) return body.max_tokens;
  if (body.max_tokens != null) return body.max_tokens;
  const escalated = sessionMetrics.lastStopReason === "max_tokens";
  const result = escalated ? config.output_cap.escalated_max_tokens ?? 64e3 : config.output_cap.default_max_tokens ?? 8e3;
  if (escalated) {
    sessionMetrics.lastStopReason = null;
  }
  return result;
}
function transformRequestBody(body, signature, runtime, betaHeader, config) {
  if (!body || typeof body !== "string") return body;
  const TOOL_PREFIX = "mcp_";
  try {
    const parsed = JSON.parse(body);
    if (config?.output_cap?.enabled) {
      parsed.max_tokens = resolveMaxTokens(parsed, config);
    }
    if (signature.enabled && betaHeader && signature.provider === "bedrock") {
      const betaArray = betaHeader.split(",").map((b) => b.trim()).filter(Boolean).filter((b) => b !== "oauth-2025-04-20");
      parsed.anthropic_beta = betaArray;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "betas")) {
      delete parsed.betas;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "thinking")) {
      parsed.thinking = normalizeThinkingBlock(parsed.thinking, parsed.model || "");
    } else if (parsed.model && isAdaptiveThinkingModel(parsed.model)) {
      parsed.thinking = { type: "adaptive" };
    }
    if (typeof parsed.effort === "string" && parsed.model && isAdaptiveThinkingModel(parsed.model)) {
      if (!parsed.output_config || typeof parsed.output_config !== "object") {
        parsed.output_config = {};
      }
      if (!("effort" in parsed.output_config)) {
        parsed.output_config.effort = parsed.effort;
      }
      delete parsed.effort;
    } else if (Object.prototype.hasOwnProperty.call(parsed, "effort")) {
      delete parsed.effort;
    }
    const thinkingActive = parsed.thinking && typeof parsed.thinking === "object" && (parsed.thinking.type === "adaptive" || parsed.thinking.type === "enabled");
    if (thinkingActive) {
      delete parsed.temperature;
      if (!parsed.context_management) {
        parsed.context_management = {
          edits: [{ type: "clear_thinking_20251015", keep: "all" }]
        };
      }
    } else {
      parsed.temperature = 1;
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = stripSlashCommandMessages(parsed.messages);
    }
    const te = config?.token_economy || {};
    const tes = runtime?.tokenEconomySession;
    const isMainRole = runtime?.requestRole === "main" || runtime?.requestRole == null;
    const conservative = te.conservative !== false;
    if (!conservative && isMainRole && Array.isArray(parsed.messages) && tes) {
      if (te.ttl_thinking_strip !== false) {
        const ttlMs = signature?.cachePolicy?.ttl === "5m" ? 5 * 6e4 : 60 * 6e4;
        const res = applyTtlThinkingStrip(parsed.messages, {
          lastClearMs: tes.lastThinkingStripMs,
          ttlMs
        });
        if (res.changed) {
          parsed.messages = res.messages;
          tes.lastThinkingStripMs = res.ranStripAt;
          tes.thinkingStripped += res.cleared;
        }
      }
      if (config?.token_economy_strategies?.tool_result_dedupe_session_wide === true) {
        const res = applySessionToolResultDedupe(parsed.messages);
        if (res.changed) parsed.messages = res.messages;
      }
      if (te.proactive_microcompact !== false) {
        const estimated = estimatePromptTokensFromParsed(parsed);
        const cw = 2e5;
        const res = applyProactiveMicrocompact(parsed.messages, {
          estimatedTokens: estimated,
          contextWindow: cw,
          percent: te.microcompact_percent ?? 70,
          keepRecent: te.microcompact_keep_recent ?? 8
        });
        if (res.changed) {
          parsed.messages = res.messages;
          tes.lastMicrocompactMs = Date.now();
          tes.toolResultsCompacted += res.cleared;
        }
      }
      if (te.trailing_summary_trim === true) {
        const res = applyTrailingSummaryTrim(parsed.messages);
        if (res.changed) parsed.messages = res.messages;
      }
      if (te.tool_result_dedupe === true) {
        const SAFE_READ_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob", "LS", "BashOutput"]);
        const res = applyToolResultDedupe(parsed.messages, {
          seen: tes.seenContentHashes,
          safeTools: SAFE_READ_TOOLS
        });
        if (res.changed) parsed.messages = res.messages;
      }
    }
    if (!conservative && isMainRole && Array.isArray(parsed.tools)) {
      if (te.stable_tool_ordering !== false) {
        parsed.tools = applyStableToolOrdering(parsed.tools);
      }
      if (Array.isArray(te.deferred_tool_names) && te.deferred_tool_names.length > 0) {
        const invoked = /* @__PURE__ */ new Set();
        if (Array.isArray(parsed.messages)) {
          for (const m of parsed.messages) {
            if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
            for (const b of m.content) {
              if (b?.type === "tool_use" && typeof b.name === "string") invoked.add(b.name);
            }
          }
        }
        const res = applyToolSchemaDeferral(parsed.tools, {
          deferred: new Set(te.deferred_tool_names),
          invoked
        });
        parsed.tools = res.tools;
      }
    }
    if (isMainRole && te.adaptive_thinking_zero_simple !== false) {
      applyAdaptiveThinkingZero(parsed);
    }
    const modelId = parsed.model || "";
    const firstUserMessage = extractFirstUserMessageText(parsed.messages);
    const signatureWithModel = {
      ...signature,
      modelId,
      firstUserMessage,
      antiVerbosity: config?.anti_verbosity,
      // Role-aware system-prompt leaning: for non-main-thread requests (title,
      // small, empty shapes) strip billing identity + CC identity injection.
      // Title-gen path is handled separately by isTitleGeneratorSystemBlocks().
      // Default off — opt-in via `token_economy.lean_system_non_main: true`.
      requestRole: runtime?.requestRole,
      leanNonMain: config?.token_economy?.lean_system_non_main === true
    };
    parsed.system = buildSystemPromptBlocks(normalizeSystemTextBlocks(parsed.system), signatureWithModel);
    const tailThreshold = signature.systemPromptTailTurns ?? 6;
    if (signature.systemPromptTailing === true && runtime.turns >= tailThreshold && Array.isArray(parsed.system)) {
      const maxChars = signature.systemPromptTailMaxChars ?? 2e3;
      for (let i = 0; i < parsed.system.length; i++) {
        const block = parsed.system[i];
        if (block.type === "text" && block.text && block.text.length > maxChars * 2) {
          block.text = tailSystemBlock(block.text, maxChars, tailThreshold);
        }
      }
    }
    if (config?.token_budget?.enabled && Array.isArray(parsed.messages)) {
      const budgetExpr = parseNaturalLanguageBudget(parsed.messages);
      if (budgetExpr > 0) {
        sessionMetrics.tokenBudget.limit = budgetExpr;
      } else if (config.token_budget.default > 0 && sessionMetrics.tokenBudget.limit === 0) {
        sessionMetrics.tokenBudget.limit = config.token_budget.default;
      }
      if (sessionMetrics.tokenBudget.limit > 0) {
        const threshold = config.token_budget.completion_threshold ?? 0.9;
        parsed.system = injectTokenBudgetBlock(parsed.system, sessionMetrics.tokenBudget, threshold);
        if (sessionMetrics.tokenBudget.used >= sessionMetrics.tokenBudget.limit * threshold) {
          parsed.max_tokens = 1;
        }
      }
    }
    if (signature.enabled) {
      const currentMetadata = parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata : {};
      parsed.metadata = {
        ...currentMetadata,
        ...buildRequestMetadata({
          persistentUserId: runtime.persistentUserId,
          accountId: runtime.accountId,
          sessionId: runtime.sessionId
        })
      };
    }
    const isTitleGen = isTitleGeneratorSystemBlocks(parsed.system || []);
    if (signature.enabled && signature.cachePolicy?.ttl !== "off" && signature.cachePolicy?.ttl_supported !== false && !isTitleGen) {
      const configuredTtl = signature.cachePolicy?.ttl || "1h";
      const roleScopedTtl = config?.token_economy?.role_scoped_cache_ttl !== false;
      const isMainForCache = runtime?.requestRole === "main" || runtime?.requestRole == null;
      const ccTtl = roleScopedTtl && !isMainForCache ? "5m" : configuredTtl;
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        for (const tool of parsed.tools) {
          if (tool.cache_control) delete tool.cache_control;
        }
        parsed.tools[parsed.tools.length - 1].cache_control = { type: "ephemeral", ttl: ccTtl };
      }
      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.cache_control) delete block.cache_control;
            }
          }
        }
        for (let i = parsed.messages.length - 1; i >= 0; i--) {
          const msg = parsed.messages[i];
          if (msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) continue;
          const lastBlock = msg.content[msg.content.length - 1];
          if (lastBlock && typeof lastBlock === "object") {
            lastBlock.cache_control = { type: "ephemeral", ttl: ccTtl };
          }
          break;
        }
      }
    }
    const OC_TO_CC_TOOL_NAMES = {
      bash: "Bash",
      read: "Read",
      glob: "Glob",
      grep: "Grep",
      edit: "Edit",
      write: "Write",
      webfetch: "WebFetch",
      todowrite: "TodoWrite",
      skill: "Skill",
      task: "Task",
      compress: "Compress"
    };
    if (Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.name && OC_TO_CC_TOOL_NAMES[tool.name]) {
          tool.name = OC_TO_CC_TOOL_NAMES[tool.name];
        }
      }
    }
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.name && OC_TO_CC_TOOL_NAMES[block.name]) {
            block.name = OC_TO_CC_TOOL_NAMES[block.name];
          }
        }
      }
    }
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.name) {
              runtime.usedTools.add(block.name);
            }
          }
        }
      }
    }
    if (Array.isArray(parsed.tools) && signature.adaptiveToolSet !== false && runtime.turns >= 3 && parsed.model && !/claude-3-|haiku/i.test(parsed.model)) {
      const used = runtime.usedTools;
      for (const tool of parsed.tools) {
        if (tool.name && !used.has(tool.name) && !CORE_TOOL_NAMES.has(tool.name)) {
          tool.defer_loading = true;
        }
      }
    }
    if (Array.isArray(parsed.tools) && signature.toolDescriptionCompaction !== false) {
      for (const tool of parsed.tools) {
        if (tool.description && tool.description.length > 500) {
          tool.description = compactToolDescription(tool.description);
        }
      }
    }
    if (Array.isArray(parsed.tools) && signature.toolDeferral !== false && parsed.model && !/claude-3-|haiku/i.test(parsed.model)) {
      const coreToolNames = new Set(Object.values(OC_TO_CC_TOOL_NAMES));
      for (const tool of parsed.tools) {
        if (tool.name && !coreToolNames.has(tool.name)) {
          tool.defer_loading = true;
        }
      }
    }
    if (betaHeader && betaHeader.includes("task-budgets-2026-03-13")) {
      if (!parsed.output_config) {
        parsed.output_config = { max_output_tokens: 16384 };
      }
    }
    if (betaHeader && betaHeader.includes("context-hint-2026-04-09") && !parsed.context_hint) {
      parsed.context_hint = { enabled: true };
    }
    const fastModeEnabled = signature.fastMode && !isFalsyEnv(process.env.OPENCODE_ANTHROPIC_DISABLE_FAST_MODE);
    let fastModeAutoApplied = false;
    if (!fastModeEnabled && te.fast_mode_auto === true && isMainRole && parsed.model && isOpus46Model(parsed.model) && Array.isArray(parsed.messages) && parsed.messages.length >= 2) {
      const last = parsed.messages[parsed.messages.length - 1];
      if (last && last.role === "user") {
        let txt = "";
        let hasToolResult = false;
        if (typeof last.content === "string") txt = last.content;
        else if (Array.isArray(last.content)) {
          for (const b of last.content) {
            if (b?.type === "tool_result") hasToolResult = true;
            if (b?.type === "text" && typeof b.text === "string") txt += b.text;
          }
        }
        if (!hasToolResult && txt.length < 240 && !/\bfile:|\.md\b|\.mjs\b|\.ts\b/i.test(txt)) {
          fastModeAutoApplied = true;
        }
      }
    }
    if ((fastModeEnabled || fastModeAutoApplied) && parsed.model && isOpus46Model(parsed.model)) {
      parsed.speed = "fast";
    }
    if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      parsed.messages = repairOrphanedToolUseBlocks(parsed.messages);
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");
        if (toolUseBlocks.length > 0) {
          parsed.messages.push({
            role: "user",
            content: toolUseBlocks.map((tu) => ({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "[Result unavailable \u2014 conversation was restructured]"
            }))
          });
        } else {
          parsed.messages.push({
            role: "user",
            content: [{ type: "text", text: "Continue." }]
          });
        }
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
function transformRequestUrl(input) {
  let requestInput = input;
  let requestUrl = null;
  try {
    if (typeof input === "string" || input instanceof URL) {
      requestUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url);
    }
  } catch {
    requestUrl = null;
  }
  if (requestUrl && !requestUrl.searchParams.has("beta")) {
    const p = requestUrl.pathname;
    const isMessages = p === "/v1/messages" || p === "/messages" || p === "/v1/messages/count_tokens" || p === "/messages/count_tokens";
    if (isMessages) {
      if (!p.startsWith("/v1/")) {
        requestUrl.pathname = "/v1" + p;
      }
      requestUrl.searchParams.set("beta", "true");
      requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
    }
  }
  const mitmBase = process.env.OPENCODE_MITM_BASE_URL;
  if (mitmBase && requestUrl) {
    try {
      const mitmUrl = new URL(mitmBase);
      requestUrl.protocol = mitmUrl.protocol;
      requestUrl.hostname = mitmUrl.hostname;
      requestUrl.port = mitmUrl.port;
      requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
    } catch {
    }
  }
  return { requestInput, requestUrl };
}
function extractUsageFromSSEEvent(parsed, stats) {
  if (parsed?.type === "message_delta" && parsed.usage) {
    const u = parsed.usage;
    if (typeof u.input_tokens === "number") stats.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") stats.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") stats.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") stats.cacheWriteTokens = u.cache_creation_input_tokens;
    if (typeof u.server_tool_use?.web_search_requests === "number") {
      stats.webSearchRequests = u.server_tool_use.web_search_requests;
    }
    if (parsed.delta?.stop_reason) {
      sessionMetrics.lastStopReason = parsed.delta.stop_reason;
    }
    return;
  }
  if (parsed?.type === "message_start" && parsed.message?.usage) {
    const u = parsed.message.usage;
    if (stats.inputTokens === 0 && typeof u.input_tokens === "number") {
      stats.inputTokens = u.input_tokens;
    }
    if (stats.cacheReadTokens === 0 && typeof u.cache_read_input_tokens === "number") {
      stats.cacheReadTokens = u.cache_read_input_tokens;
    }
    if (stats.cacheWriteTokens === 0 && typeof u.cache_creation_input_tokens === "number") {
      stats.cacheWriteTokens = u.cache_creation_input_tokens;
    }
  }
}
function getSSEDataPayload(eventBlock) {
  if (!eventBlock) return null;
  const dataLines = [];
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5);
    dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (!payload || payload === "[DONE]") return null;
  return payload;
}
function getMidStreamAccountError(parsed) {
  if (!parsed || parsed.type !== "error" || !parsed.error) {
    return null;
  }
  const errorBody = {
    error: {
      type: String(parsed.error.type || ""),
      message: String(parsed.error.message || "")
    }
  };
  if (!isAccountSpecificError(400, errorBody)) {
    return null;
  }
  const reason = parseRateLimitReason(400, errorBody);
  return {
    reason,
    invalidateToken: reason === "AUTH_FAILED"
  };
}
function stripMcpPrefixFromSSE(text) {
  return text.replace(/^data:\s*(.+)$/gm, (_match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (stripMcpPrefixFromParsedEvent(parsed)) {
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
    }
    return _match;
  });
}
var CC_TO_OC_TOOL_NAMES = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Skill: "skill",
  Task: "task",
  Compress: "compress"
};
function reverseMapToolName(name) {
  if (CC_TO_OC_TOOL_NAMES[name]) return CC_TO_OC_TOOL_NAMES[name];
  if (name.startsWith("mcp_")) return name.slice(4);
  return name;
}
function stripMcpPrefixFromParsedEvent(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  let modified = false;
  if (parsed.content_block && (parsed.content_block.type === "tool_use" || parsed.content_block.type === "tool_reference") && typeof parsed.content_block.name === "string") {
    const mapped = reverseMapToolName(parsed.content_block.name);
    if (mapped !== parsed.content_block.name) {
      parsed.content_block.name = mapped;
      modified = true;
    }
  }
  if (parsed.message && Array.isArray(parsed.message.content)) {
    for (const block of parsed.message.content) {
      if ((block.type === "tool_use" || block.type === "tool_reference") && typeof block.name === "string") {
        const mapped = reverseMapToolName(block.name);
        if (mapped !== block.name) {
          block.name = mapped;
          modified = true;
        }
      }
    }
  }
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if ((block.type === "tool_use" || block.type === "tool_reference") && typeof block.name === "string") {
        const mapped = reverseMapToolName(block.name);
        if (mapped !== block.name) {
          block.name = mapped;
          modified = true;
        }
      }
    }
  }
  return modified;
}
function transformResponse(response, onUsage, onAccountError) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const EMPTY_CHUNK = new Uint8Array();
  const stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let sseBuffer = "";
  let sseRewriteBuffer = "";
  let accountErrorHandled = false;
  function processSSEBuffer(flush = false) {
    while (true) {
      const boundary = sseBuffer.indexOf("\n\n");
      if (boundary === -1) {
        if (!flush) return;
        if (!sseBuffer.trim()) {
          sseBuffer = "";
          return;
        }
      }
      const eventBlock = boundary === -1 ? sseBuffer : sseBuffer.slice(0, boundary);
      sseBuffer = boundary === -1 ? "" : sseBuffer.slice(boundary + 2);
      const payload = getSSEDataPayload(eventBlock);
      if (!payload) {
        if (boundary === -1) return;
        continue;
      }
      try {
        const parsed = JSON.parse(payload);
        if (onUsage) {
          extractUsageFromSSEEvent(parsed, stats);
        }
        if (onAccountError && !accountErrorHandled) {
          const details = getMidStreamAccountError(parsed);
          if (details) {
            accountErrorHandled = true;
            onAccountError(details);
          }
        }
      } catch {
      }
      if (boundary === -1) return;
    }
  }
  function rewriteSSEChunk(chunk, flush = false) {
    sseRewriteBuffer += chunk;
    if (!flush) {
      const boundary = sseRewriteBuffer.lastIndexOf("\n");
      if (boundary === -1) return "";
      const complete = sseRewriteBuffer.slice(0, boundary + 1);
      sseRewriteBuffer = sseRewriteBuffer.slice(boundary + 1);
      return stripMcpPrefixFromSSE(complete);
    }
    if (!sseRewriteBuffer) return "";
    const finalText = stripMcpPrefixFromSSE(sseRewriteBuffer);
    sseRewriteBuffer = "";
    return finalText;
  }
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        processSSEBuffer(true);
        const rewrittenTail = rewriteSSEChunk("", true);
        if (rewrittenTail) {
          controller.enqueue(encoder.encode(rewrittenTail));
        }
        if (onUsage && (stats.inputTokens > 0 || stats.outputTokens > 0 || stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0)) {
          onUsage(stats);
        }
        controller.close();
        return;
      }
      const text = decoder.decode(value, { stream: true });
      if (onUsage || onAccountError) {
        sseBuffer += text.replace(/\r\n/g, "\n");
        processSSEBuffer(false);
      }
      const rewrittenText = rewriteSSEChunk(text, false);
      if (rewrittenText) {
        controller.enqueue(encoder.encode(rewrittenText));
      } else {
        controller.enqueue(EMPTY_CHUNK);
      }
    }
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("x-opencode-cache-hit-rate", String(Math.round(getAverageCacheHitRate() * 1e3) / 1e3));
  responseHeaders.set("x-opencode-cache-read-total", String(sessionMetrics.totalCacheRead));
  responseHeaders.set("x-opencode-session-cost", String(Math.round(sessionMetrics.sessionCostUsd * 1e4) / 1e4));
  responseHeaders.set("x-opencode-turns", String(sessionMetrics.turns));
  responseHeaders.set("x-opencode-anti-verbosity", _pluginConfig?.anti_verbosity?.enabled !== false ? "on" : "off");
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}
function isEventStreamResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}
async function readDiskAccountAuth(accountId) {
  try {
    const diskData = await loadAccounts();
    if (!diskData) return null;
    const diskAccount = diskData.accounts.find((a) => a.id === accountId);
    if (!diskAccount) return null;
    return {
      refreshToken: diskAccount.refreshToken,
      access: diskAccount.access,
      expires: diskAccount.expires,
      tokenUpdatedAt: diskAccount.token_updated_at
    };
  } catch {
    return null;
  }
}
function markTokenStateUpdated(account, now = Date.now()) {
  account.tokenUpdatedAt = now;
}
function applyDiskAuthIfFresher(account, diskAuth, options = {}) {
  if (!diskAuth) return false;
  const diskTokenUpdatedAt = diskAuth.tokenUpdatedAt || 0;
  const memTokenUpdatedAt = account.tokenUpdatedAt || 0;
  const diskHasDifferentAuth = diskAuth.refreshToken !== account.refreshToken || diskAuth.access !== account.access;
  const memAuthExpired = !account.expires || account.expires <= Date.now();
  const allowExpiredFallback = options.allowExpiredFallback === true;
  if (diskTokenUpdatedAt <= memTokenUpdatedAt && !(allowExpiredFallback && diskHasDifferentAuth && memAuthExpired)) {
    return false;
  }
  account.refreshToken = diskAuth.refreshToken;
  account.access = diskAuth.access;
  account.expires = diskAuth.expires;
  account.tokenUpdatedAt = Math.max(memTokenUpdatedAt, diskTokenUpdatedAt);
  return true;
}
async function refreshAccountToken(account, client, source = "foreground", { onTokensUpdated } = {}) {
  if (account.source === "cc-keychain" || account.source === "cc-file") {
    const { readCCCredentials: readCCCredentials2 } = await Promise.resolve().then(() => (init_cc_credentials(), cc_credentials_exports));
    const ccCreds = readCCCredentials2();
    const match = ccCreds.find((c2) => c2.refreshToken === account.refreshToken);
    if (match && (match.expiresAt === 0 || match.expiresAt > Date.now())) {
      account.access = match.accessToken;
      account.expires = match.expiresAt || Date.now() + 36e5;
      markTokenStateUpdated(account);
      if (onTokensUpdated) {
        try {
          await onTokensUpdated();
        } catch {
        }
      }
      return account.access;
    }
    throw new Error(`CC credential expired (source: ${account.source})`);
  }
  const lockResult = await acquireRefreshLock(account.id, {
    timeoutMs: 2e3,
    backoffMs: 60,
    staleMs: 2e4
  });
  const lock = lockResult && typeof lockResult === "object" ? lockResult : {
    acquired: true,
    lockPath: null,
    owner: null,
    lockInode: null
  };
  if (!lock.acquired) {
    const diskAuth = await readDiskAccountAuth(account.id);
    const adopted = applyDiskAuthIfFresher(account, diskAuth, { allowExpiredFallback: true });
    if (adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
    }
    throw new Error("Refresh lock busy");
  }
  try {
    const diskAuthBeforeRefresh = await readDiskAccountAuth(account.id);
    const adopted = applyDiskAuthIfFresher(account, diskAuthBeforeRefresh);
    if (source === "foreground" && adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
    }
    const json = await refreshToken(account.refreshToken, { signal: AbortSignal.timeout(15e3) });
    account.access = json.access_token;
    account.expires = Date.now() + json.expires_in * 1e3;
    if (json.refresh_token) {
      account.refreshToken = json.refresh_token;
    }
    if (json.account?.uuid) {
      account.accountUuid = json.account.uuid;
    }
    if (json.organization?.uuid) {
      account.organizationUuid = json.organization.uuid;
    }
    markTokenStateUpdated(account);
    if (onTokensUpdated) {
      try {
        await onTokensUpdated();
      } catch {
      }
    }
    try {
      await client.auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          refresh: account.refreshToken,
          access: account.access,
          expires: account.expires
        }
      });
    } catch {
    }
    return json.access_token;
  } finally {
    await releaseRefreshLock(lock);
  }
}
var PENDING_OAUTH_TTL_MS = 10 * 60 * 1e3;
function stripAnsi2(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
function parseCommandArgs(raw) {
  if (!raw || !raw.trim()) return [];
  const parts = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    parts.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return parts;
}
function extractFileIds(body) {
  const ids = [];
  if (!body || typeof body !== "object") return ids;
  const MAX_DEPTH = 20;
  function walk(obj, depth) {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
    } else if (obj && typeof obj === "object") {
      if (obj.source?.file_id) ids.push(obj.source.file_id);
      for (const val of Object.values(obj)) {
        if (val && typeof val === "object") walk(val, depth + 1);
      }
    }
  }
  walk(body.messages, 0);
  walk(body.system, 0);
  return ids;
}
AnthropicAuthPlugin.__testing__ = {
  sanitizeSystemText,
  compactSystemText,
  compactToolDescription,
  dedupeSystemBlocks,
  normalizeSystemTextBlocks,
  buildSystemPromptBlocks,
  stripMcpPrefixFromParsedEvent,
  CORE_TOOL_NAMES,
  // exposed for determinism regression tests (phase C1)
  applyContextHintCompaction,
  // exposed for session-dedupe regression tests (phase C3)
  applySessionToolResultDedupe,
  maybeApplySessionToolResultDedupe,
  // exposed for experimental.session.summarize integration tests
  runHaikuSessionSummarize,
  get cachedCCPrompt() {
    return cachedCCPrompt;
  },
  resetCachedCCPrompt() {
    cachedCCPrompt = null;
  },
  SUBAGENT_CC_ANCHOR,
  CLAUDE_CODE_IDENTITY_STRING,
  /** Test-only: drive the session turn counter so code paths gated on
   *  `sessionMetrics.turns >= N` can be exercised without a real SSE stream. */
  setSessionTurnsForTest(n) {
    sessionMetrics.turns = n;
  },
  /** Test-only: reset session metrics between tests.
   *  Uses createInitialSessionMetrics() so every tracked field — including
   *  nested objects (lastQuota, perModel, costBreakdown, tokenBudget) and the
   *  usedTools Set — is restored to its initial value. Mutates the existing
   *  sessionMetrics object in place because many module-level references
   *  close over it. */
  resetSessionMetricsForTest() {
    const fresh = createInitialSessionMetrics();
    for (const key of Object.keys(sessionMetrics)) {
      delete sessionMetrics[key];
    }
    Object.assign(sessionMetrics, fresh);
  }
};
var index_default = AnthropicAuthPlugin;
export {
  AnthropicAuthPlugin,
  index_default as default
};
