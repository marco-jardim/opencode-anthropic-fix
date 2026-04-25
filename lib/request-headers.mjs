/**
 * Pure header/mimicry helpers extracted from index.mjs.
 * No runtime state, no imports needed - all values are self-contained constants
 * or derive from process.env at call time.
 *
 * Exported:
 *  - Version/build/SDK constants and CLI_TO_SDK_VERSION map
 *  - getSdkVersion(cliVersion)
 *  - EXPERIMENTAL_BETA_FLAGS  (Set<string>)
 *  - BETA_SHORTCUTS            (Map<string, string>)
 *  - resolveBetaShortcut(value)
 *  - buildExtendedUserAgent(version)
 */

// ---------------------------------------------------------------------------
// Version / build / SDK constants
// ---------------------------------------------------------------------------

export const FALLBACK_CLAUDE_CLI_VERSION = "2.1.119";
export const CLAUDE_CODE_NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
export const CLAUDE_CODE_BUILD_TIME = "2026-04-23T19:08:52Z";

// The @anthropic-ai/sdk version bundled with Claude Code.
// This is distinct from the CLI version and goes in X-Stainless-Package-Version.
// v2.1.107 switched from @anthropic-ai/sdk v0.208.0 to v0.81.0 (confirmed via bundle var x$H="0.81.0").
// Still 0.81.0 in v2.1.119 (verified via strings extraction from native Bun binary;
// adds cache-diagnosis-2026-04-07 beta gated by GrowthBook tengu_prompt_cache_diagnostics;
// no other beta additions/removals vs 2.1.117; OAuth flow unchanged).
export const ANTHROPIC_SDK_VERSION = "0.81.0";

// Map of CLI version to bundled SDK version (update when CLI version changes)
export const CLI_TO_SDK_VERSION = new Map([
  ["2.1.119", "0.81.0"],
  ["2.1.117", "0.81.0"],
  ["2.1.116", "0.81.0"],
  ["2.1.115", "0.81.0"],
  ["2.1.114", "0.81.0"],
  ["2.1.113", "0.81.0"],
  ["2.1.112", "0.81.0"],
  ["2.1.111", "0.81.0"],
  ["2.1.110", "0.81.0"],
  ["2.1.109", "0.81.0"],
  ["2.1.108", "0.81.0"],
  ["2.1.107", "0.81.0"],
  ["2.1.105", "0.81.0"],
  ["2.1.97", "0.208.0"],
  ["2.1.96", "0.208.0"],
  ["2.1.95", "0.208.0"],
  ["2.1.94", "0.208.0"],
  ["2.1.93", "0.208.0"],
  ["2.1.92", "0.208.0"],
  ["2.1.91", "0.208.0"],
  ["2.1.90", "0.208.0"],
  ["2.1.89", "0.208.0"],
  ["2.1.88", "0.208.0"],
  ["2.1.87", "0.208.0"],
  ["2.1.86", "0.208.0"],
  ["2.1.85", "0.208.0"],
  ["2.1.84", "0.208.0"],
  ["2.1.83", "0.208.0"],
  ["2.1.81", "0.208.0"],
  ["2.1.80", "0.208.0"],
]);

/**
 * Get the SDK version corresponding to a CLI version.
 * Falls back to ANTHROPIC_SDK_VERSION constant.
 * @param {string | null | undefined} cliVersion
 * @returns {string}
 */
export function getSdkVersion(cliVersion) {
  return CLI_TO_SDK_VERSION.get(cliVersion) ?? ANTHROPIC_SDK_VERSION;
}

// ---------------------------------------------------------------------------
// Beta flag registries
// ---------------------------------------------------------------------------

/**
 * Set of all known experimental/optional beta flags.
 * Used to filter betas when CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1.
 * WARNING: this set intentionally overlaps with always-on betas - only use
 * it with the disable-experimental guard, never unconditionally.
 */
export const EXPERIMENTAL_BETA_FLAGS = new Set([
  "adaptive-thinking-2026-01-28",
  "advanced-tool-use-2025-11-20",
  "advisor-tool-2026-03-01",
  "afk-mode-2026-01-31",
  "cache-diagnosis-2026-04-07",
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
  "web-search-2025-03-05",
]);

/** Friendly shortcut aliases for config.custom_betas values. */
export const BETA_SHORTCUTS = new Map([
  ["1m", "context-1m-2025-08-07"],
  ["1m-context", "context-1m-2025-08-07"],
  ["context-1m", "context-1m-2025-08-07"],
  ["cache-diagnosis", "cache-diagnosis-2026-04-07"],
  ["cache-diag", "cache-diagnosis-2026-04-07"],
  ["context-hint", "context-hint-2026-04-09"],
  ["hint", "context-hint-2026-04-09"],
  ["fast", "fast-mode-2026-02-01"],
  ["fast-mode", "fast-mode-2026-02-01"],
  ["opus-fast", "fast-mode-2026-02-01"],
  ["task-budgets", "task-budgets-2026-03-13"],
  ["budgets", "task-budgets-2026-03-13"],
  ["redact-thinking", "redact-thinking-2026-02-12"],
]);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Resolve a beta shortcut alias to its canonical flag name.
 * Returns the value unchanged if no alias matches.
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function resolveBetaShortcut(value) {
  if (!value) return "";
  const trimmed = value.trim();
  const mapped = BETA_SHORTCUTS.get(trimmed.toLowerCase());
  return mapped || trimmed;
}

/**
 * Build the extended User-Agent for API calls.
 * Real CC v96 sends "claude-cli/{version} (external, {entrypoint})" - confirmed via
 * proxy capture of real CC on Windows/Node.js.
 * @param {string} version
 * @returns {string}
 */
export function buildExtendedUserAgent(version) {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli";
  const sdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : "";
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : "";
  return `claude-cli/${version} (external, ${entrypoint}${sdkVersion}${clientApp})`;
}
