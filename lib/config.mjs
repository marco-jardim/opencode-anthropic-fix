import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

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
 * @typedef {object} AnthropicAuthConfig
 * @property {AccountSelectionStrategy} account_selection_strategy
 * @property {number} failure_ttl_seconds
 * @property {boolean} debug
 * @property {HealthScoreConfig} health_score
 * @property {TokenBucketConfig} token_bucket
 * @property {ToastConfig} toasts
 */

/** @type {AnthropicAuthConfig} */
export const DEFAULT_CONFIG = {
  account_selection_strategy: "sticky",
  failure_ttl_seconds: 3600,
  debug: false,
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
};

export const VALID_STRATEGIES = ["sticky", "round-robin", "hybrid"];

/** OpenCode's OAuth client ID for Anthropic console auth flows. */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Get the OpenCode config directory (XDG-compliant).
 * @returns {string}
 */
export function getConfigDir() {
  const platform = process.platform;
  if (platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "opencode",
    );
  }
  const xdgConfig =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
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
  const config = {
    ...DEFAULT_CONFIG,
    health_score: { ...DEFAULT_CONFIG.health_score },
    token_bucket: { ...DEFAULT_CONFIG.token_bucket },
    toasts: { ...DEFAULT_CONFIG.toasts },
  };

  if (
    typeof raw.account_selection_strategy === "string" &&
    VALID_STRATEGIES.includes(raw.account_selection_strategy)
  ) {
    config.account_selection_strategy =
      /** @type {AccountSelectionStrategy} */ (
        raw.account_selection_strategy
      );
  }

  config.failure_ttl_seconds = clampNumber(
    raw.failure_ttl_seconds,
    60,
    7200,
    DEFAULT_CONFIG.failure_ttl_seconds,
  );

  if (typeof raw.debug === "boolean") {
    config.debug = raw.debug;
  }

  // Health score sub-config
  if (raw.health_score && typeof raw.health_score === "object") {
    const hs = /** @type {Record<string, unknown>} */ (raw.health_score);
    config.health_score = {
      initial: clampNumber(hs.initial, 0, 100, DEFAULT_CONFIG.health_score.initial),
      success_reward: clampNumber(hs.success_reward, 0, 10, DEFAULT_CONFIG.health_score.success_reward),
      rate_limit_penalty: clampNumber(hs.rate_limit_penalty, -50, 0, DEFAULT_CONFIG.health_score.rate_limit_penalty),
      failure_penalty: clampNumber(hs.failure_penalty, -100, 0, DEFAULT_CONFIG.health_score.failure_penalty),
      recovery_rate_per_hour: clampNumber(hs.recovery_rate_per_hour, 0, 20, DEFAULT_CONFIG.health_score.recovery_rate_per_hour),
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
      regeneration_rate_per_minute: clampNumber(tb.regeneration_rate_per_minute, 0.1, 60, DEFAULT_CONFIG.token_bucket.regeneration_rate_per_minute),
      initial_tokens: clampNumber(tb.initial_tokens, 1, 1000, DEFAULT_CONFIG.token_bucket.initial_tokens),
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

  if (
    env.OPENCODE_ANTHROPIC_STRATEGY &&
    VALID_STRATEGIES.includes(env.OPENCODE_ANTHROPIC_STRATEGY)
  ) {
    config.account_selection_strategy =
      /** @type {AccountSelectionStrategy} */ (
        env.OPENCODE_ANTHROPIC_STRATEGY
      );
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

  return config;
}

/**
 * Load config from disk, validate, apply env overrides.
 * @returns {AnthropicAuthConfig}
 */
export function loadConfig() {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return applyEnvOverrides({ ...DEFAULT_CONFIG });
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const raw = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return applyEnvOverrides({ ...DEFAULT_CONFIG });
    }
    const config = validateConfig(raw);
    return applyEnvOverrides(config);
  } catch {
    return applyEnvOverrides({ ...DEFAULT_CONFIG });
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
export function saveConfig(updates) {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });

  // Read existing raw config
  const existing = loadRawConfig();

  // Merge updates
  const merged = { ...existing, ...updates };

  // Atomic write: temp file + rename
  const tmpPath = configPath + `.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, configPath);
}
