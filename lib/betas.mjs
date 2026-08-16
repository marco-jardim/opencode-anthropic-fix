/**
 * Host beta policy.
 *
 * Three things live here, and none of them is wire construction:
 *  - `EXPERIMENTAL_BETA_FLAGS`: the betas the HOST treats as experimental, i.e.
 *    the set it filters out when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is on;
 *  - `BETA_SHORTCUTS`: CLI UX aliases for `/anthropic betas` and
 *    `config.custom_betas`;
 *  - `resolveBetaShortcut`: the resolver behind those aliases.
 *
 * The betas that actually go on the wire are the shared package's business
 * (`lib/mimicry/wire-compat.mjs`); this module only decides what the plugin
 * ADDS or SUPPRESSES on top of them.
 *
 * RECONCILIATION IS ENFORCED BY TEST, not by convention. Every literal header
 * below is checked against the package's `BETA_REGISTRY_2_1_233` — the genuine
 * client's own registry — by `lib/betas.test.mjs`, which fails on a stale date
 * stamp and requires the host-only entries (the ones upstream has no registry
 * slot for) to be enumerated and justified rather than merely accumulated. Add
 * a beta here that upstream does not ship and the test will tell you to say why.
 */

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
