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

export const FALLBACK_CLAUDE_CLI_VERSION = "2.1.195";
export const CLAUDE_CODE_NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
// Real build markers extracted from the 2.1.195 native binary
// (Bun-embedded JS): `BUILD_TIME:"2026-06-26T01:00:56Z"`,
// `GIT_SHA:"4603aa3f2ea164bd0974f82eb413ae7acc99a7ee"`.
// (Prior 2.1.159 linux-x64: BUILD_TIME 2026-05-31T16:22:50Z,
//  GIT_SHA dd8c11fc8d05cea0b2b9fc8f5a99a5c5c5dffc9b.)
export const CLAUDE_CODE_BUILD_TIME = "2026-06-26T01:00:56Z";
export const CLAUDE_CODE_GIT_SHA = "4603aa3f2ea164bd0974f82eb413ae7acc99a7ee";

// The @anthropic-ai/sdk version bundled with Claude Code.
// This is distinct from the CLI version and goes in X-Stainless-Package-Version.
// v2.1.107 switched from @anthropic-ai/sdk v0.208.0 to v0.81.0 (confirmed via bundle var x$H="0.81.0").
// Still 0.81.0 in v2.1.143 (verified by binary string extraction of win32-x64 native binary:
// 2.1.134-2.1.143 are telemetry / subagent-header / mid-conversation-system additions with
// no SDK version bump; mid-conversation-system-2026-04-07 registered in 2.1.143 but not
// auto-emitted; two new conditional x- headers x-claude-code-agent-id /
// x-claude-code-parent-agent-id are only emitted in subagent dispatch contexts).
export const ANTHROPIC_SDK_VERSION = "0.94.0";

// Map of CLI version to bundled SDK version (update when CLI version changes)
export const CLI_TO_SDK_VERSION = new Map([
  // 2.1.160-2.1.195: refusal-fallback feature (server-side-fallback /
  // fallback-credit betas) is opt-in/GrowthBook-gated and never emitted on a
  // default /v1/messages turn; no wire SDK bump (binary-verified:
  // x-stainless-package-version still "0.94.0" in 2.1.195).
  ["2.1.195", "0.94.0"],
  ["2.1.194", "0.94.0"],
  ["2.1.193", "0.94.0"],
  ["2.1.192", "0.94.0"],
  ["2.1.191", "0.94.0"],
  ["2.1.190", "0.94.0"],
  ["2.1.189", "0.94.0"],
  ["2.1.188", "0.94.0"],
  ["2.1.187", "0.94.0"],
  ["2.1.186", "0.94.0"],
  ["2.1.185", "0.94.0"],
  ["2.1.184", "0.94.0"],
  ["2.1.183", "0.94.0"],
  ["2.1.182", "0.94.0"],
  ["2.1.181", "0.94.0"],
  ["2.1.180", "0.94.0"],
  ["2.1.179", "0.94.0"],
  ["2.1.178", "0.94.0"],
  ["2.1.177", "0.94.0"],
  ["2.1.176", "0.94.0"],
  ["2.1.175", "0.94.0"],
  ["2.1.174", "0.94.0"],
  ["2.1.173", "0.94.0"],
  ["2.1.172", "0.94.0"],
  ["2.1.171", "0.94.0"],
  ["2.1.170", "0.94.0"],
  ["2.1.169", "0.94.0"],
  ["2.1.168", "0.94.0"],
  ["2.1.167", "0.94.0"],
  ["2.1.166", "0.94.0"],
  ["2.1.165", "0.94.0"],
  ["2.1.164", "0.94.0"],
  ["2.1.163", "0.94.0"],
  ["2.1.162", "0.94.0"],
  ["2.1.161", "0.94.0"],
  ["2.1.160", "0.94.0"],
  // 2.1.155-2.1.159: only wire change is the revival of
  // summarize-connector-text-2026-03-13 (label narration_summaries), gated by
  // GrowthBook pewter_owl_header (default-off) — not always-on. SDK still 0.94.0
  // (binary-verified: x-stainless-package-version NQ="0.94.0" in 2.1.159).
  ["2.1.159", "0.94.0"],
  ["2.1.158", "0.94.0"],
  ["2.1.157", "0.94.0"],
  ["2.1.156", "0.94.0"],
  ["2.1.155", "0.94.0"],
  // 2.1.151-2.1.154: Opus 4.8 launch (2026-05-28). npm now ships a native
  // binary (no JS bundle), so the bundled SDK version can't be string-extracted;
  // no SDK bump was observed across 2.1.150->2.1.154, so we carry 0.94.0 forward.
  ["2.1.154", "0.94.0"],
  ["2.1.153", "0.94.0"],
  ["2.1.152", "0.94.0"],
  ["2.1.151", "0.94.0"],
  ["2.1.150", "0.94.0"],
  ["2.1.143", "0.81.0"],
  ["2.1.142", "0.81.0"],
  ["2.1.141", "0.81.0"],
  ["2.1.140", "0.81.0"],
  ["2.1.139", "0.81.0"],
  ["2.1.138", "0.81.0"],
  ["2.1.137", "0.81.0"],
  ["2.1.136", "0.81.0"],
  ["2.1.134", "0.81.0"],
  ["2.1.133", "0.81.0"],
  ["2.1.132", "0.81.0"],
  ["2.1.131", "0.81.0"],
  ["2.1.130", "0.81.0"],
  ["2.1.129", "0.81.0"],
  ["2.1.128", "0.81.0"],
  ["2.1.127", "0.81.0"],
  ["2.1.126", "0.81.0"],
  ["2.1.125", "0.81.0"],
  ["2.1.124", "0.81.0"],
  ["2.1.123", "0.81.0"],
  ["2.1.122", "0.81.0"],
  ["2.1.121", "0.81.0"],
  ["2.1.120", "0.81.0"],
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
  // CCR bring-your-own-cloud beta. Registered in the 2.1.154 binary's _W() table
  // but not emitted on /v1/messages; kept here for the disable-experimental guard.
  "ccr-byoc-2025-07-29",
  "code-execution-2025-08-25",
  "compact-2026-01-12",
  "context-1m-2025-08-07",
  "context-hint-2026-04-09",
  "context-management-2025-06-27",
  "environments-2025-11-01",
  "extended-cache-ttl-2025-04-11",
  // Refusal-fallback credit beta from the upstream Udd registry (CC 2.1.195).
  // Opt-in/GrowthBook-gated; never auto-emitted on a default /v1/messages turn.
  // Listed here for the disable-experimental guard + manual opt-in ONLY.
  "fallback-credit-2026-06-01",
  "fast-mode-2026-02-01",
  "files-api-2025-04-14",
  "interleaved-thinking-2025-05-14",
  // Registered in the 2.1.154 binary's _W() table (mcp_servers label). Plugin
  // proxies MCP tool calls inline and does not emit this on chat completions.
  "mcp-servers-2025-12-04",
  // Registered in CC v2.1.143 but NOT in real CC's always-on emission set
  // (master registry only, not in the always-on subset). Likely GrowthBook-gated
  // pending server rollout. Paired telemetry: tengu_mid_conv_system_fallback_retry.
  "mid-conversation-system-2026-04-07",
  "prompt-caching-scope-2026-01-05",
  "redact-thinking-2026-02-12",
  // Server-side refusal-fallback beta from the upstream Udd registry (CC 2.1.195).
  // Opt-in/GrowthBook-gated; never auto-emitted on a default /v1/messages turn.
  // Listed here for the disable-experimental guard + manual opt-in ONLY.
  "server-side-fallback-2026-06-01",
  "structured-outputs-2025-12-15",
  // Revived in CC 2.1.159 as registry label `narration_summaries` (it was a dead
  // slot from v2.1.90-2.1.154). Real CC emits it only when GrowthBook flag
  // `pewter_owl_header` is on (default-off), first-party, and NOT in fast-mode.
  // Listed here for the disable-guard + manual opt-in ONLY; never emitted always-on.
  "summarize-connector-text-2026-03-13",
  "task-budgets-2026-03-13",
  "tool-search-tool-2025-10-19",
  // SDK admin route beta (used for /v1/user_profiles* endpoints). Registered for
  // forward-compat; the plugin proxies /v1/messages only and does NOT emit this
  // on chat completions.
  "user-profiles-2026-03-24",
  "web-search-2025-03-05",
]);

/** Friendly shortcut aliases for config.custom_betas values. */
export const BETA_SHORTCUTS = new Map([
  ["1m", "context-1m-2025-08-07"],
  ["1m-context", "context-1m-2025-08-07"],
  ["context-1m", "context-1m-2025-08-07"],
  ["cache-diagnosis", "cache-diagnosis-2026-04-07"],
  ["cache-diag", "cache-diagnosis-2026-04-07"],
  ["cache-ttl", "extended-cache-ttl-2025-04-11"],
  ["context-hint", "context-hint-2026-04-09"],
  ["environments", "environments-2025-11-01"],
  ["extended-cache-ttl", "extended-cache-ttl-2025-04-11"],
  ["hint", "context-hint-2026-04-09"],
  ["fast", "fast-mode-2026-02-01"],
  ["fast-mode", "fast-mode-2026-02-01"],
  ["opus-fast", "fast-mode-2026-02-01"],
  ["task-budgets", "task-budgets-2026-03-13"],
  ["budgets", "task-budgets-2026-03-13"],
  ["redact-thinking", "redact-thinking-2026-02-12"],
  ["mid-conv-system", "mid-conversation-system-2026-04-07"],
  ["mid-system", "mid-conversation-system-2026-04-07"],
  ["context-management", "context-management-2025-06-27"],
  ["structured-outputs", "structured-outputs-2025-12-15"],
  ["web-search", "web-search-2025-03-05"],
  ["advanced-tool-use", "advanced-tool-use-2025-11-20"],
  ["tool-search-tool", "tool-search-tool-2025-10-19"],
  ["effort", "effort-2025-11-24"],
  ["prompt-caching-scope", "prompt-caching-scope-2026-01-05"],
  ["thinking-token-count", "thinking-token-count-2026-05-13"],
  ["afk-mode", "afk-mode-2026-01-31"],
  ["advisor-tool", "advisor-tool-2026-03-01"],
  ["mcp-servers", "mcp-servers-2025-12-04"],
  ["ccr-byoc", "ccr-byoc-2025-07-29"],
  ["connector-text", "summarize-connector-text-2026-03-13"],
  ["narration-summaries", "summarize-connector-text-2026-03-13"],
  ["summarize-connector-text", "summarize-connector-text-2026-03-13"],
  ["server-side-fallback", "server-side-fallback-2026-06-01"],
  ["fallback", "server-side-fallback-2026-06-01"],
  ["fallback-credit", "fallback-credit-2026-06-01"],
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
