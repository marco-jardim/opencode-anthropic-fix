/**
 * Baseline seed — initial contract for v2.1.92.
 *
 * This is the "known good" contract derived from extractor output against
 * the Claude Code v2.1.92 bundle. The Worker seeds KV with this contract
 * on first run so we have a baseline to compare against.
 *
 * Update this object whenever a sync is performed and merged.
 *
 * @module seed
 */

/**
 * @typedef {import('./types.mjs').ExtractedContract} ExtractedContract
 */

/**
 * The seeded baseline contract matching Claude Code v2.1.92.
 *
 * @type {ExtractedContract}
 */
export const SEED_CONTRACT = {
  version: "2.1.92",
  buildTime: "2026-04-03T23:25:15Z",
  sdkVersion: "0.208.0",
  sdkToken: "sdk-zAZezfDKGoZuXXKe",
  billingSalt: "59cf53e54c78",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",

  // Beta flags — derived from extractor.mjs KNOWN_* sets applied to the v2.1.91 bundle.
  // allBetaFlags: every date-versioned beta string present in the bundle (sorted).
  // alwaysOnBetas:    intersection of allBetaFlags with KNOWN_ALWAYS_ON_BETAS
  // experimentalBetas: intersection of allBetaFlags with KNOWN_EXPERIMENTAL
  // bedrockUnsupported: intersection of allBetaFlags with KNOWN_BEDROCK_UNSUPPORTED
  allBetaFlags: [
    "adaptive-thinking-2026-01-28",
    "advanced-tool-use-2025-11-20",
    "afk-mode-2026-01-31",
    "claude-code-20250219",
    "code-execution-2025-08-25",
    "context-1m-2025-08-07",
    "context-management-2025-06-27",
    "effort-2025-11-24",
    "fast-mode-2026-02-01",
    "files-api-2025-04-14",
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
    "oauth-2025-04-20",
    "prompt-caching-scope-2026-01-05",
    "redact-thinking-2026-02-12",
    "structured-outputs-2025-12-15",
    "tool-search-tool-2025-10-19",
    "web-search-2025-03-05",
  ],
  alwaysOnBetas: [
    "advanced-tool-use-2025-11-20",
    "claude-code-20250219",
    "effort-2025-11-24",
    "fast-mode-2026-02-01",
    "oauth-2025-04-20",
  ],
  experimentalBetas: [
    "adaptive-thinking-2026-01-28",
    "advanced-tool-use-2025-11-20",
    "afk-mode-2026-01-31",
    "code-execution-2025-08-25",
    "context-1m-2025-08-07",
    "context-management-2025-06-27",
    "fast-mode-2026-02-01",
    "files-api-2025-04-14",
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "redact-thinking-2026-02-12",
    "structured-outputs-2025-12-15",
    "tool-search-tool-2025-10-19",
    "web-search-2025-03-05",
  ],
  bedrockUnsupported: [
    "code-execution-2025-08-25",
    "context-1m-2025-08-07",
    "files-api-2025-04-14",
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
    "tool-search-tool-2025-10-19",
  ],

  // OAuth scopes
  claudeAiScopes: [
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ],
  consoleScopes: ["org:create_api_key", "user:profile"],

  // OAuth endpoints
  oauthTokenUrl: "https://platform.claude.com/v1/oauth/token",
  oauthRevokeUrl: "https://platform.claude.com/v1/oauth/revoke",
  oauthRedirectUri: "https://platform.claude.com/oauth/code/callback",
  oauthConsoleHost: "platform.claude.com",

  // Identity
  identityStrings: [
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  ],
  systemPromptBoundary: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
};
