import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * @typedef {'sticky' | 'round-robin' | 'hybrid'} AccountSelectionStrategy
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
 * @typedef {object} AnthropicAuthConfig
 * @property {AccountSelectionStrategy} account_selection_strategy
 * @property {number} failure_ttl_seconds
 * @property {boolean} debug
 * @property {{ enabled: boolean, fetch_claude_code_version_on_startup: boolean, prompt_compaction: 'minimal' | 'off' }} signature_emulation
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
 */

/** @type {AnthropicAuthConfig} */
export const DEFAULT_CONFIG = {
  account_selection_strategy: "sticky",
  failure_ttl_seconds: 3600,
  debug: false,
  signature_emulation: {
    enabled: true,
    fetch_claude_code_version_on_startup: true,
    prompt_compaction: "minimal",
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
};

export const VALID_STRATEGIES = ["sticky", "round-robin", "hybrid"];

/** OpenCode's OAuth client ID for Anthropic console auth flows. */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Build a deep-cloned config object from defaults.
 * @returns {AnthropicAuthConfig}
 */
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
function validateConfig(raw) {
  const config = createDefaultConfig();

  if (typeof raw.account_selection_strategy === "string" && VALID_STRATEGIES.includes(raw.account_selection_strategy)) {
    config.account_selection_strategy = /** @type {AccountSelectionStrategy} */ (raw.account_selection_strategy);
  }

  config.failure_ttl_seconds = clampNumber(raw.failure_ttl_seconds, 60, 7200, DEFAULT_CONFIG.failure_ttl_seconds);

  if (typeof raw.debug === "boolean") {
    config.debug = raw.debug;
  }

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
