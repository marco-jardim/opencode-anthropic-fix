// Realistic fixture simulating real minified Claude Code v2.1.92 cli.js bundle.
// Tests extractor robustness against real-world patterns:
//   - UUID template from uuid library appearing BEFORE the real CLIENT_ID
//   - SDK platform-detection version ("0.80.0") appearing BEFORE real SDK VERSION
//   - Console scopes as standalone variables (not array literals)
//   - No hardcoded revoke URL (derived from token URL)
//   - "You are ..." strings from SDK docs/UI mixed with real identity strings

// --- AWS SDK dependency (appears early in bundle) ---
var x = { name: "@aws-sdk/nested-clients", version: "3.936.0" };

// --- Stainless SDK platform detection (misleading 0.80.0) ---
var Be = "0.80.0";
function detectPlatform() {
  if (typeof Deno !== "undefined") return "deno";
  if (typeof EdgeRuntime !== "undefined") return "edge";
}

// --- UUID library template (misleading UUID, appears before real CLIENT_ID) ---
function uuidv4() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );
}

// --- Package metadata ---
var aC1 = {
  PACKAGE_URL: "@anthropic-ai/claude-code",
  README_URL: "https://code.claude.com/docs/en/overview",
  VERSION: "2.1.92",
  FEEDBACK_CHANNEL: "https://github.com/anthropics/claude-code/issues",
  BUILD_TIME: "2026-04-03T23:25:15Z",
};

// --- Build time ---
var cD2 = "2026-04-03T23:25:15Z";

// --- SDK token ---
var gH4 = "sdk-zAZezfDKGoZuXXKe";

// --- Billing salt ---
var kL6 = "59cf53e54c78";

// --- OAuth config object (no revoke URL!) ---
var PROD_CONFIG = {
  CLAUDE_AI_AUTHORIZE_URL: "https://claude.ai/oauth/authorize",
  CLAUDE_AI_ORIGIN: "https://claude.ai",
  TOKEN_URL: "https://platform.claude.com/v1/oauth/token",
  API_KEY_URL: "https://api.anthropic.com/v1/organizations/api_keys",
  MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback",
  CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  OAUTH_FILE_SUFFIX: "",
  MCP_PROXY_URL: "https://mcp-proxy.anthropic.com",
};
var CUSTOM_CONFIG = { OAUTH_FILE_SUFFIX: "-custom-oauth" };

// --- Console scopes as standalone variables (NOT array literals) ---
var qS = "user:inference",
  jz6 = "user:profile",
  ZS5 = "org:create_api_key";
var fJ = "oauth-2025-04-20";
var Lh7;
E$8;
N51;
yh7;

// --- Claude AI scopes (these ARE in an array literal) ---
var uV1 = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];

// --- OAuth console host ---
var sT0 = "platform.claude.com";

// --- Identity strings (3 real) ---
var EE1 = "You are Claude Code, Anthropic's official CLI for Claude.";
var Rsq = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
var Ssq = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// --- NON-identity "You are" strings (should be filtered out) ---
var helpMsg = "You are a helpful assistant that answers questions.";
var billingMsg = "You are currently using your free plan subscription.";
var toolPrompt = "You are an assistant for performing a web search query.";
var sdkDoc = "You are using the Anthropic SDK for Python.";

// --- System prompt boundary ---
var cE6 = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

// --- Beta flags (same set as v91, just with different variable names) ---
var dF7 = "claude-code-20250219";
var eG8 = "effort-2025-11-24";
var fH9 = "advanced-tool-use-2025-11-20";
var gI0 = "fast-mode-2026-02-01";
var hJ1 = "oauth-2025-04-20";
var iK2 = new Set([
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
  "tool-search-tool-2025-10-19",
  "code-execution-2025-08-25",
  "files-api-2025-04-14",
  "fine-grained-tool-streaming-2025-05-14",
]);
var jL3 = new Set([
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
]);
var kM4 = [
  "token-counting-2024-11-01",
  "context-management-2025-06-27",
  "task-budgets-2026-03-13",
  "structured-outputs-2025-12-15",
  "web-search-2025-03-05",
  "files-api-2025-04-14",
  "code-execution-2025-08-25",
  "fine-grained-tool-streaming-2025-05-14",
];

// --- SDK VERSION export (real pattern, appears late in bundle) ---
var En4 = {};
En4.VERSION = "0.208.0";
