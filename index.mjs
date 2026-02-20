import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AccountManager } from "./lib/accounts.mjs";
import { authorize, exchange } from "./lib/oauth.mjs";
import { loadConfig, CLIENT_ID, getConfigDir } from "./lib/config.mjs";
import { loadAccounts, saveAccounts, clearAccounts, createDefaultStats } from "./lib/storage.mjs";
import { isAccountSpecificError, parseRateLimitReason, parseRetryAfterHeader } from "./lib/backoff.mjs";

// ---------------------------------------------------------------------------
// Account management CLI prompts
// ---------------------------------------------------------------------------

/**
 * @param {import('./lib/accounts.mjs').AccountManager} accountManager
 * @returns {Promise<'add' | 'fresh' | 'manage' | 'cancel'>}
 */
async function promptAccountMenu(accountManager) {
  const accounts = accountManager.getAccountsSnapshot();
  const currentIndex = accountManager.getCurrentIndex();
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log(`\n${accounts.length} account(s) configured:`);
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

/**
 * @param {import('./lib/accounts.mjs').AccountManager} accountManager
 * @returns {Promise<void>}
 */
async function promptManageAccounts(accountManager) {
  const accounts = accountManager.getAccountsSnapshot();
  const rl = createInterface({ input: stdin, output: stdout });

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

      // Delete: d1, d2, etc.
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

      // Toggle: just the number
      const num = parseInt(normalized, 10);
      if (!isNaN(num) && num >= 1 && num <= accounts.length) {
        const newState = accountManager.toggleAccount(num - 1);
        console.log(`Account ${num} is now ${newState ? "enabled" : "disabled"}.`);
        continue;
      }

      console.log("Invalid input.");
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Request building helpers (extracted from original fetch interceptor)
// ---------------------------------------------------------------------------

const FALLBACK_CLAUDE_CLI_VERSION = "2.1.2";
const CLAUDE_CODE_NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
const CLAUDE_CODE_BETA_FLAG = "claude-code-20250219";
const BILLING_HASH_SALT = "59cf53e54c78";
const BILLING_HASH_POSITIONS = [4, 7, 20];
const CLAUDE_CODE_IDENTITY_STRING = "You are Claude Code, Anthropic's official CLI for Claude.";
const KNOWN_IDENTITY_STRINGS = new Set([
  CLAUDE_CODE_IDENTITY_STRING,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);
const BEDROCK_UNSUPPORTED_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
  "tool-search-tool-2025-10-19",
  "tool-examples-2025-10-29",
]);
const STAINLESS_HELPER_KEYS = [
  "x_stainless_helper",
  "x-stainless-helper",
  "stainless_helper",
  "stainlessHelper",
  "_stainless_helper",
];
const USER_ID_STORAGE_FILE = "anthropic-signature-user-id";

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isTruthyEnv(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isFalsyEnv(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

/**
 * @returns {boolean}
 */
function isNonInteractiveMode() {
  if (isTruthyEnv(process.env.CI)) return true;
  return !process.stdout.isTTY;
}

/**
 * @returns {string}
 */
function getClaudeEntrypoint() {
  return process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
}

/**
 * @param {string} claudeCliVersion
 * @returns {string}
 */
function buildUserAgent(claudeCliVersion) {
  const sdkSuffix = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : "";
  const appSuffix = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : "";
  return `claude-cli/${claudeCliVersion} (external, ${getClaudeEntrypoint()}${sdkSuffix}${appSuffix})`;
}

/**
 * @returns {Record<string, string>}
 */
function parseAnthropicCustomHeaders() {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return {};

  /** @type {Record<string, string>} */
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

/**
 * @returns {string}
 */
function getOrCreateSignatureUserId() {
  const envUserId = process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID?.trim();
  if (envUserId) return envUserId;

  const configDir = getConfigDir();
  const userIdPath = join(configDir, USER_ID_STORAGE_FILE);

  try {
    if (existsSync(userIdPath)) {
      const existing = readFileSync(userIdPath, "utf-8").trim();
      if (existing) return existing;
    }
  } catch {
    // fall through and generate a new id
  }

  const generated = randomUUID();
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(userIdPath, `${generated}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Ignore filesystem errors; caller still gets generated ID for this runtime.
  }
  return generated;
}

/**
 * @param {string} model
 * @returns {boolean}
 */
function isHaikuModel(model) {
  return /haiku/i.test(model);
}

/**
 * @param {string} model
 * @returns {boolean}
 */
function supportsThinking(model) {
  if (!model) return true;
  return /claude|sonnet|opus|haiku/i.test(model);
}

/**
 * @param {string} model
 * @returns {boolean}
 */
function hasOneMillionContext(model) {
  return /(^|[-_ ])1m($|[-_ ])|context[-_]?1m/i.test(model);
}

/**
 * @param {string} model
 * @returns {boolean}
 */
function supportsStructuredOutputs(model) {
  if (!/claude|sonnet|opus|haiku/i.test(model)) return false;
  return !isHaikuModel(model);
}

/**
 * @param {string} model
 * @returns {boolean}
 */
function supportsWebSearch(model) {
  return /claude|sonnet|opus|haiku|gpt|gemini/i.test(model);
}

/**
 * @param {URL | null} requestUrl
 * @returns {"anthropic" | "bedrock" | "vertex" | "foundry"}
 */
function detectProvider(requestUrl) {
  if (!requestUrl) return "anthropic";
  const host = requestUrl.hostname.toLowerCase();
  if (host.includes("bedrock") || host.includes("amazonaws.com")) return "bedrock";
  if (host.includes("aiplatform") || host.includes("vertex")) return "vertex";
  if (host.includes("foundry") || host.includes("azure")) return "foundry";
  return "anthropic";
}

/**
 * @param {string | undefined} body
 * @returns {{model: string, tools: any[], messages: any[]}}
 */
function parseRequestBodyMetadata(body) {
  if (!body || typeof body !== "string") {
    return { model: "", tools: [], messages: [] };
  }

  try {
    const parsed = JSON.parse(body);
    const model = typeof parsed?.model === "string" ? parsed.model : "";
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return { model, tools, messages };
  } catch {
    return { model: "", tools: [], messages: [] };
  }
}

/**
 * @param {any[]} tools
 * @param {any[]} messages
 * @returns {string}
 */
function buildStainlessHelperHeader(tools, messages) {
  const helpers = new Set();

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

/**
 * @param {any} content
 * @returns {string}
 */
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * @param {any[]} messages
 * @returns {string}
 */
function getFirstUserText(messages) {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user") continue;

    const text = extractTextContent(message.content);
    if (text) return text;
  }
  return "";
}

/**
 * @param {{id?: string, accountUuid?: string} | null | undefined} account
 * @returns {string}
 */
function getAccountIdentifier(account) {
  if (account?.accountUuid && typeof account.accountUuid === "string") {
    return account.accountUuid;
  }
  if (account?.id && typeof account.id === "string") {
    return account.id;
  }
  return "";
}

/**
 * @param {{persistentUserId: string, accountId: string, sessionId: string}} input
 * @returns {{user_id: string}}
 */
function buildRequestMetadata(input) {
  return {
    user_id: `user_${input.persistentUserId}_account_${input.accountId}_session_${input.sessionId}`,
  };
}

/**
 * @param {string} claudeCliVersion
 * @param {any[]} messages
 * @returns {string}
 */
function buildAnthropicBillingHeader(claudeCliVersion, messages) {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";

  const firstUserText = getFirstUserText(messages);
  const sampled = BILLING_HASH_POSITIONS.map((position) => firstUserText[position] || "0").join("");
  const hash = createHash("sha256")
    .update(`${BILLING_HASH_SALT}${sampled}${claudeCliVersion}`)
    .digest("hex")
    .slice(0, 3);

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "unknown";
  return `x-anthropic-billing-header: cc_version=${claudeCliVersion}.${hash}; cc_entrypoint=${entrypoint}; cch=00000;`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function sanitizeSystemText(text) {
  return text
    .replace(/OpenCode/g, "Claude Code")
    .replace(/opencode/gi, (match, offset, source) => (offset > 0 && source[offset - 1] === "/" ? match : "Claude"));
}

/**
 * @param {any[] | undefined} system
 * @returns {Array<{type: string, text: string, cacheScope?: string | null}>}
 */
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

    output.push({
      type: typeof item.type === "string" ? item.type : "text",
      text: item.text,
      cacheScope: Object.prototype.hasOwnProperty.call(item, "cacheScope") ? item.cacheScope : undefined,
    });
  }

  return output;
}

/**
 * @param {Array<{type: string, text: string, cacheScope?: string | null}>} system
 * @param {{enabled: boolean, claudeCliVersion: string}} signature
 * @param {any[]} messages
 * @returns {Array<{type: string, text: string, cacheScope?: string | null}>}
 */
function buildSystemPromptBlocks(system, signature, messages) {
  const sanitized = system.map((item) => ({ ...item, text: sanitizeSystemText(item.text) }));

  if (!signature.enabled) {
    return sanitized;
  }

  const filtered = sanitized.filter(
    (item) => !item.text.startsWith("x-anthropic-billing-header:") && !KNOWN_IDENTITY_STRINGS.has(item.text),
  );

  const blocks = [];
  const billingHeader = buildAnthropicBillingHeader(signature.claudeCliVersion, messages);
  if (billingHeader) {
    blocks.push({ type: "text", text: billingHeader, cacheScope: null });
  }

  blocks.push({ type: "text", text: CLAUDE_CODE_IDENTITY_STRING, cacheScope: "org" });
  blocks.push(...filtered);

  return blocks;
}

/**
 * @param {string} incomingBeta
 * @param {boolean} signatureEnabled
 * @param {string} model
 * @param {"anthropic" | "bedrock" | "vertex" | "foundry"} provider
 * @returns {string}
 */
function buildAnthropicBetaHeader(incomingBeta, signatureEnabled, model, provider) {
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const betas = ["oauth-2025-04-20"];

  if (!signatureEnabled) {
    betas.push("interleaved-thinking-2025-05-14");
    return [...new Set([...betas, ...incomingBetasList])].join(",");
  }

  const nonInteractive = isNonInteractiveMode();
  const haiku = isHaikuModel(model);

  if (!haiku) {
    betas.push(CLAUDE_CODE_BETA_FLAG);
  }

  if (!isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING) && supportsThinking(model)) {
    betas.push("interleaved-thinking-2025-05-14");
  }

  if (hasOneMillionContext(model)) {
    betas.push("context-1m-2025-08-07");
  }

  if (
    nonInteractive &&
    (isTruthyEnv(process.env.USE_API_CONTEXT_MANAGEMENT) || isTruthyEnv(process.env.TENGU_MARBLE_ANVIL))
  ) {
    betas.push("context-management-2025-06-27");
  }

  if (supportsStructuredOutputs(model) && isTruthyEnv(process.env.TENGU_TOOL_PEAR)) {
    betas.push("structured-outputs-2025-12-15");
  }

  if (nonInteractive && isTruthyEnv(process.env.TENGU_SCARF_COFFEE)) {
    betas.push("tool-examples-2025-10-29");
  }

  if ((provider === "vertex" || provider === "foundry") && supportsWebSearch(model)) {
    betas.push("web-search-2025-03-05");
  }

  if (nonInteractive) {
    betas.push("prompt-caching-scope-2026-01-05");
  }

  if (process.env.ANTHROPIC_BETAS && !haiku) {
    const envBetas = process.env.ANTHROPIC_BETAS.split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    betas.push(...envBetas);
  }

  betas.push("fine-grained-tool-streaming-2025-05-14");

  const mergedBetas = [...new Set([...betas, ...incomingBetasList])];
  if (provider === "bedrock") {
    return mergedBetas.filter((beta) => !BEDROCK_UNSUPPORTED_BETAS.has(beta)).join(",");
  }
  return mergedBetas.join(",");
}

/**
 * Map Node.js platform to Stainless OS header value.
 * @param {NodeJS.Platform} value
 * @returns {string}
 */
function getStainlessOs(value) {
  if (value === "darwin") return "MacOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}

/**
 * Normalize Node.js arch to Stainless arch header value.
 * @param {string} value
 * @returns {string}
 */
function getStainlessArch(value) {
  if (value === "x64") return "x64";
  if (value === "arm64") return "arm64";
  return value;
}

/**
 * Resolve latest claude-code package version from npm registry.
 * Returns null on timeout/network/parse failures.
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
async function fetchLatestClaudeCodeVersion(timeoutMs = 1200) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CLAUDE_CODE_NPM_LATEST_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
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

/**
 * Build request headers from input and init, applying OAuth requirements.
 * Preserves behaviors D1-D7.
 *
 * @param {any} input
 * @param {Record<string, any>} requestInit
 * @param {string} accessToken
 * @param {string | undefined} requestBody
 * @param {URL | null} requestUrl
 * @param {{enabled: boolean, claudeCliVersion: string}} signature
 * @returns {Headers}
 */
function buildRequestHeaders(input, requestInit, accessToken, requestBody, requestUrl, signature) {
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

  // Preserve all incoming beta headers while ensuring OAuth requirements
  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const { model, tools, messages } = parseRequestBodyMetadata(requestBody);
  const provider = detectProvider(requestUrl);
  const mergedBetas = buildAnthropicBetaHeader(incomingBeta, signature.enabled, model, provider);

  const authTokenOverride = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const bearerToken = authTokenOverride || accessToken;

  requestHeaders.set("authorization", `Bearer ${bearerToken}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", buildUserAgent(signature.claudeCliVersion));
  if (signature.enabled) {
    requestHeaders.set("anthropic-version", "2023-06-01");
    requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
    requestHeaders.set("x-app", "cli");
    requestHeaders.set("x-stainless-arch", getStainlessArch(process.arch));
    requestHeaders.set("x-stainless-lang", "js");
    requestHeaders.set("x-stainless-os", getStainlessOs(process.platform));
    requestHeaders.set("x-stainless-package-version", signature.claudeCliVersion);
    requestHeaders.set("x-stainless-runtime", "node");
    requestHeaders.set("x-stainless-runtime-version", process.version);
    requestHeaders.set("x-stainless-helper-method", "stream");
    const incomingRetryCount = requestHeaders.get("x-stainless-retry-count");
    requestHeaders.set(
      "x-stainless-retry-count",
      incomingRetryCount && !isFalsyEnv(incomingRetryCount) ? incomingRetryCount : "0",
    );
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

  return requestHeaders;
}

/**
 * Transform the request body: system prompt sanitization and tool prefixing.
 * Preserves behaviors E1-E7.
 *
 * @param {string | undefined} body
 * @param {{enabled: boolean, claudeCliVersion: string}} signature
 * @param {{persistentUserId: string, sessionId: string, accountId: string}} runtime
 * @returns {string | undefined}
 */
function transformRequestBody(body, signature, runtime) {
  if (!body || typeof body !== "string") return body;

  const TOOL_PREFIX = "mcp_";

  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

    // Sanitize system prompt and optionally inject Claude Code identity/billing blocks.
    parsed.system = buildSystemPromptBlocks(normalizeSystemTextBlocks(parsed.system), signature, messages);

    if (signature.enabled) {
      const currentMetadata =
        parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
          ? parsed.metadata
          : {};
      parsed.metadata = {
        ...currentMetadata,
        ...buildRequestMetadata({
          persistentUserId: runtime.persistentUserId,
          accountId: runtime.accountId,
          sessionId: runtime.sessionId,
        }),
      };
    }

    // Add prefix to tools definitions
    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }));
    }
    // Add prefix to tool_use blocks in messages
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === "tool_use" && block.name) {
              return {
                ...block,
                name: `${TOOL_PREFIX}${block.name}`,
              };
            }
            return block;
          });
        }
        return msg;
      });
    }
    return JSON.stringify(parsed);
  } catch {
    // ignore parse errors
    return body;
  }
}

/**
 * @param {string | undefined} body
 * @param {Headers} requestHeaders
 * @param {boolean} signatureEnabled
 * @returns {string | undefined}
 */
function syncBodyBetasFromHeader(body, requestHeaders, signatureEnabled) {
  if (!signatureEnabled || !body || typeof body !== "string") return body;

  const betaHeader = requestHeaders.get("anthropic-beta");
  if (!betaHeader) return body;

  try {
    const parsed = JSON.parse(body);
    parsed.betas = betaHeader
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Transform the request URL: add ?beta=true to /v1/messages.
 * Preserves behaviors F1-F3.
 *
 * @param {any} input
 * @returns {{requestInput: any, requestUrl: URL | null}}
 */
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

  if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
    requestUrl.searchParams.set("beta", "true");
    requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
  }

  return { requestInput, requestUrl };
}

/**
 * @typedef {object} UsageStats
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 */

/**
 * Update running usage stats from a parsed SSE event.
 * @param {any} parsed
 * @param {UsageStats} stats
 */
function extractUsageFromSSEEvent(parsed, stats) {
  // message_delta: cumulative usage (preferred, overwrites)
  if (parsed?.type === "message_delta" && parsed.usage) {
    const u = parsed.usage;
    if (typeof u.input_tokens === "number") stats.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") stats.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") stats.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") stats.cacheWriteTokens = u.cache_creation_input_tokens;
    return;
  }

  // message_start: initial usage (only set if we haven't seen message_delta yet)
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

/**
 * Extract the combined SSE data payload from one event block.
 * @param {string} eventBlock
 * @returns {string | null}
 */
function getSSEDataPayload(eventBlock) {
  if (!eventBlock) return null;

  const dataLines = [];
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

/**
 * Parse one SSE event payload and return account-error details if present.
 * @param {any} parsed
 * @returns {{reason: import('./lib/backoff.mjs').RateLimitReason, invalidateToken: boolean} | null}
 */
function getMidStreamAccountError(parsed) {
  if (!parsed || parsed.type !== "error" || !parsed.error) {
    return null;
  }

  const errorBody = {
    error: {
      type: String(parsed.error.type || ""),
      message: String(parsed.error.message || ""),
    },
  };

  // Mid-stream errors do not include a reliable HTTP status. Use 400-style
  // body parsing to identify account-specific errors.
  if (!isAccountSpecificError(400, errorBody)) {
    return null;
  }

  const reason = parseRateLimitReason(400, errorBody);

  return {
    reason,
    invalidateToken: reason === "AUTH_FAILED",
  };
}

/**
 * Wrap a response body stream to strip mcp_ prefix from tool names,
 * extract token usage stats from SSE events, and detect mid-stream
 * account-specific errors (so the account can be marked for the NEXT request).
 * Preserves behaviors G1-G5.
 *
 * @param {Response} response
 * @param {((stats: UsageStats) => void) | null} [onUsage] - Called when stream ends with final usage
 * @param {((details: {reason: import('./lib/backoff.mjs').RateLimitReason, invalidateToken: boolean}) => void) | null} [onAccountError]
 *   Called if a mid-stream error looks account-specific
 * @returns {Response}
 */
function transformResponse(response, onUsage, onAccountError) {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  /** @type {UsageStats} */
  const stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let sseBuffer = "";
  let accountErrorHandled = false;

  /**
   * Process buffered SSE event blocks.
   * @param {boolean} flush
   */
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
        // Ignore malformed event payloads.
      }

      if (boundary === -1) return;
    }
  }

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        processSSEBuffer(true);

        if (
          onUsage &&
          (stats.inputTokens > 0 || stats.outputTokens > 0 || stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0)
        ) {
          onUsage(stats);
        }
        controller.close();
        return;
      }

      let text = decoder.decode(value, { stream: true });

      if (onUsage || onAccountError) {
        // Normalize CRLF for parser only; preserve original bytes for passthrough.
        sseBuffer += text.replace(/\r\n/g, "\n");
        processSSEBuffer(false);
      }

      text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
      controller.enqueue(encoder.encode(text));
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Check whether a response is an SSE event stream.
 * @param {Response} response
 * @returns {boolean}
 */
function isEventStreamResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * Build user-facing switch reason text for account-specific errors.
 * @param {number} status
 * @param {import('./lib/backoff.mjs').RateLimitReason} reason
 * @returns {string}
 */
function formatSwitchReason(status, reason) {
  if (reason === "AUTH_FAILED") return "auth failed";
  if (status === 403 && reason === "QUOTA_EXHAUSTED") return "permission denied";
  if (reason === "QUOTA_EXHAUSTED") return "quota exhausted";
  return "rate-limited";
}

// ---------------------------------------------------------------------------
// Token refresh (per-account)
// ---------------------------------------------------------------------------

/**
 * Refresh an account's access token.
 * @param {import('./lib/accounts.mjs').ManagedAccount} account
 * @param {ReturnType<typeof import('@opencode-ai/sdk').createOpencodeClient>} client
 * @returns {Promise<string>} The new access token
 * @throws {Error} If refresh fails
 */
async function refreshAccountToken(account, client) {
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    let errorCode = "";
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed.error === "string") {
          errorCode = parsed.error;
        }
      } catch {
        // body may be non-JSON
      }
    }

    const err = new Error(`Token refresh failed: ${response.status}${errorCode ? ` (${errorCode})` : ""}`);
    // @ts-ignore JS runtime property bag
    err.status = response.status;
    // @ts-ignore JS runtime property bag
    err.errorCode = errorCode;
    // @ts-ignore JS runtime property bag
    err.body = bodyText;
    throw err;
  }

  const json = await response.json();
  account.access = json.access_token;
  account.expires = Date.now() + json.expires_in * 1000;
  if (json.refresh_token) {
    account.refreshToken = json.refresh_token;
  }

  // Also persist to OpenCode's auth.json for compatibility
  await client.auth.set({
    path: { id: "anthropic" },
    body: {
      type: "oauth",
      refresh: account.refreshToken,
      access: account.access,
      expires: account.expires,
    },
  });

  return json.access_token;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const ANTHROPIC_COMMAND_HANDLED = "__ANTHROPIC_COMMAND_HANDLED__";
const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;

/**
 * Remove ANSI color/control codes from output text.
 * @param {string} value
 * @returns {string}
 */
function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex
}

/**
 * Parse command arguments with minimal quote support.
 *
 * Examples:
 *   a b "c d"  -> ["a", "b", "c d"]
 *   a 'c d'     -> ["a", "c d"]
 *
 * @param {string} raw
 * @returns {string[]}
 */
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

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  const config = loadConfig();
  const signatureEmulationEnabled = config.signature_emulation.enabled;
  const shouldFetchClaudeCodeVersion =
    signatureEmulationEnabled && config.signature_emulation.fetch_claude_code_version_on_startup;

  /** @type {AccountManager | null} */
  let accountManager = null;

  /** Track account usage toasts; show once per account change (including first use). */
  let lastToastedIndex = -1;
  /** @type {Map<string, number>} */
  const debouncedToastTimestamps = new Map();

  /** @type {Map<string, Promise<string>>} */
  const refreshInFlight = new Map();

  /**
   * Pending slash-command OAuth flows keyed by session ID.
   * @type {Map<string, { mode: "login" | "reauth", verifier: string, targetIndex?: number, createdAt: number }>}
   */
  const pendingSlashOAuth = new Map();

  /**
   * Send an informational message into the current session.
   * @param {string} sessionID
   * @param {string} text
   */
  async function sendCommandMessage(sessionID, text) {
    await client.session?.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text, ignored: true }],
      },
    });
  }

  /**
   * Keep in-memory AccountManager in sync with disk mutations made via slash commands.
   */
  async function reloadAccountManagerFromDisk() {
    if (!accountManager) return;
    accountManager = await AccountManager.load(config, null);
  }

  /**
   * Persist OAuth credentials into OpenCode auth storage for immediate compatibility.
   * @param {string} refresh
   * @param {string} access
   * @param {number} expires
   */
  async function persistOpenCodeAuth(refresh, access, expires) {
    await client.auth.set({
      path: { id: "anthropic" },
      body: { type: "oauth", refresh, access, expires },
    });
  }

  /**
   * Remove expired pending OAuth flows.
   */
  function pruneExpiredPendingOAuth() {
    const now = Date.now();
    for (const [sessionID, pending] of pendingSlashOAuth.entries()) {
      if (now - pending.createdAt > PENDING_OAUTH_TTL_MS) {
        pendingSlashOAuth.delete(sessionID);
      }
    }
  }

  /**
   * Execute CLI main(argv) in-process and capture console output.
   * @param {string[]} argv
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
   */
  async function runCliCommand(argv) {
    const logs = [];
    const errors = [];

    /** @type {number} */
    let code = 1;
    try {
      const { main: cliMain } = await import("./cli.mjs");
      code = await cliMain(argv, {
        io: {
          log: (...args) => logs.push(args.join(" ")),
          error: (...args) => errors.push(args.join(" ")),
        },
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      code,
      stdout: stripAnsi(logs.join("\n")).trim(),
      stderr: stripAnsi(errors.join("\n")).trim(),
    };
  }

  /**
   * Start a slash-command OAuth flow and store verifier in-memory.
   * @param {string} sessionID
   * @param {"login" | "reauth"} mode
   * @param {number} [targetIndex]
   */
  async function startSlashOAuth(sessionID, mode, targetIndex) {
    pruneExpiredPendingOAuth();
    const { url, verifier } = await authorize("max");
    pendingSlashOAuth.set(sessionID, {
      mode,
      verifier,
      targetIndex,
      createdAt: Date.now(),
    });

    const action = mode === "login" ? "login" : `reauth ${targetIndex + 1}`;
    const followup =
      mode === "login" ? "/anthropic login complete <code#state>" : "/anthropic reauth complete <code#state>";

    await sendCommandMessage(
      sessionID,
      [
        "▣ Anthropic OAuth",
        "",
        `Started ${action} flow.`,
        "Open this URL in your browser:",
        url,
        "",
        `Then run: ${followup}`,
        "(Paste the full authorization code, including #state)",
      ].join("\n"),
    );
  }

  /**
   * Complete a pending slash-command OAuth flow.
   * @param {string} sessionID
   * @param {string} code
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async function completeSlashOAuth(sessionID, code) {
    const pending = pendingSlashOAuth.get(sessionID);
    if (!pending) {
      pruneExpiredPendingOAuth();
      return {
        ok: false,
        message: "No pending OAuth flow. Start with /anthropic login or /anthropic reauth <N>.",
      };
    }

    if (Date.now() - pending.createdAt > PENDING_OAUTH_TTL_MS) {
      pendingSlashOAuth.delete(sessionID);
      return {
        ok: false,
        message: "Pending OAuth flow expired. Start again with /anthropic login or /anthropic reauth <N>.",
      };
    }

    const credentials = await exchange(code, pending.verifier);
    if (credentials.type === "failed") {
      return { ok: false, message: "Token exchange failed. The code may be invalid or expired." };
    }

    const stored = (await loadAccounts()) || { version: 1, accounts: [], activeIndex: 0 };

    if (pending.mode === "login") {
      const existingIdx = stored.accounts.findIndex((acc) => acc.refreshToken === credentials.refresh);
      if (existingIdx >= 0) {
        const acc = stored.accounts[existingIdx];
        acc.access = credentials.access;
        acc.expires = credentials.expires;
        if (credentials.email) acc.email = credentials.email;
        acc.enabled = true;
        acc.consecutiveFailures = 0;
        acc.lastFailureTime = null;
        acc.rateLimitResetTimes = {};
        await saveAccounts(stored);
        await persistOpenCodeAuth(acc.refreshToken, acc.access, acc.expires);
        await reloadAccountManagerFromDisk();
        pendingSlashOAuth.delete(sessionID);
        const name = acc.email || `Account ${existingIdx + 1}`;
        return { ok: true, message: `Updated existing account #${existingIdx + 1} (${name}).` };
      }

      if (stored.accounts.length >= 10) {
        return { ok: false, message: "Maximum of 10 accounts reached. Remove one first." };
      }

      const now = Date.now();
      stored.accounts.push({
        id: `${now}:${credentials.refresh.slice(0, 12)}`,
        email: credentials.email,
        refreshToken: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
        addedAt: now,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: createDefaultStats(now),
      });
      await saveAccounts(stored);
      const newAccount = stored.accounts[stored.accounts.length - 1];
      await persistOpenCodeAuth(newAccount.refreshToken, newAccount.access, newAccount.expires);
      await reloadAccountManagerFromDisk();
      pendingSlashOAuth.delete(sessionID);
      const label = credentials.email || `Account ${stored.accounts.length}`;
      return { ok: true, message: `Added account #${stored.accounts.length} (${label}).` };
    }

    // reauth flow
    const idx = pending.targetIndex ?? -1;
    if (idx < 0 || idx >= stored.accounts.length) {
      pendingSlashOAuth.delete(sessionID);
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
    const name = existing.email || `Account ${idx + 1}`;
    return { ok: true, message: `Re-authenticated account #${idx + 1} (${name}).` };
  }

  /**
   * Handle /anthropic slash commands.
   *
   * Supported examples:
   *   /anthropic
   *   /anthropic usage
   *   /anthropic switch 2
   *   /anthropic login
   *   /anthropic login complete <code#state>
   *   /anthropic reauth 1
   *   /anthropic reauth complete <code#state>
   *
   * @param {{ command: string, arguments?: string, sessionID: string }} input
   */
  async function handleAnthropicSlashCommand(input) {
    const args = parseCommandArgs(input.arguments || "");
    const primary = (args[0] || "list").toLowerCase();

    // Friendly alias: /anthropic usage -> list
    if (primary === "usage") {
      const result = await runCliCommand(["list"]);
      const heading = result.code === 0 ? "▣ Anthropic" : "▣ Anthropic (error)";
      const body = result.stdout || result.stderr || "No output.";
      await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
      await reloadAccountManagerFromDisk();
      return;
    }

    // Two-step login flow for slash commands
    if (primary === "login") {
      if ((args[1] || "").toLowerCase() === "complete") {
        const code = args.slice(2).join(" ").trim();
        if (!code) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic login complete <code#state>",
          );
          return;
        }
        const result = await completeSlashOAuth(input.sessionID, code);
        const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
        await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
        return;
      }

      await startSlashOAuth(input.sessionID, "login");
      return;
    }

    // Two-step reauth flow for slash commands
    if (primary === "reauth") {
      if ((args[1] || "").toLowerCase() === "complete") {
        const code = args.slice(2).join(" ").trim();
        if (!code) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic reauth complete <code#state>",
          );
          return;
        }
        const result = await completeSlashOAuth(input.sessionID, code);
        const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
        await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
        return;
      }

      const n = parseInt(args[1], 10);
      if (Number.isNaN(n) || n < 1) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic OAuth\n\nProvide an account number. Example: /anthropic reauth 1",
        );
        return;
      }
      const stored = await loadAccounts();
      if (!stored || stored.accounts.length === 0) {
        await sendCommandMessage(input.sessionID, "▣ Anthropic OAuth (error)\n\nNo accounts configured.");
        return;
      }
      const idx = n - 1;
      if (idx >= stored.accounts.length) {
        await sendCommandMessage(
          input.sessionID,
          `▣ Anthropic OAuth (error)\n\nAccount ${n} does not exist. You have ${stored.accounts.length} account(s).`,
        );
        return;
      }

      await startSlashOAuth(input.sessionID, "reauth", idx);
      return;
    }

    // Interactive CLI command is not compatible with slash flow.
    if (primary === "manage" || primary === "mg") {
      await sendCommandMessage(
        input.sessionID,
        "▣ Anthropic\n\n`manage` is interactive-only. Use granular slash commands (switch/enable/disable/remove/reset) or run `opencode-anthropic-auth manage` in a terminal.",
      );
      return;
    }

    // Route remaining commands through the CLI command surface.
    const cliArgs = [...args];
    if (cliArgs.length === 0) cliArgs.push("list");

    // Avoid readline prompts in slash mode.
    if (
      (primary === "remove" || primary === "rm" || primary === "logout" || primary === "lo") &&
      !cliArgs.includes("--force")
    ) {
      cliArgs.push("--force");
    }

    const result = await runCliCommand(cliArgs);
    const heading = result.code === 0 ? "▣ Anthropic" : "▣ Anthropic (error)";
    const body = result.stdout || result.stderr || "No output.";
    await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
    await reloadAccountManagerFromDisk();
  }

  /**
   * Show a toast in the TUI. Silently fails if TUI is not running.
   * @param {string} message
   * @param {"info" | "success" | "warning" | "error"} variant
   * @param {{debounceKey?: string}} [options]
   */
  async function toast(message, variant = "info", options = {}) {
    // Quiet mode suppresses non-error toasts
    if (config.toasts.quiet && variant !== "error") return;

    // Debounce configured toast categories to reduce chatter.
    if (variant !== "error" && options.debounceKey) {
      const minGapMs = Math.max(0, config.toasts.debounce_seconds) * 1000;
      if (minGapMs > 0) {
        const now = Date.now();
        const lastAt = debouncedToastTimestamps.get(options.debounceKey) ?? 0;
        if (now - lastAt < minGapMs) {
          return;
        }
        debouncedToastTimestamps.set(options.debounceKey, now);
      }
    }

    try {
      await client.tui?.showToast({ body: { message, variant } });
    } catch {
      // TUI may not be available
    }
  }

  /**
   * Emit debug logs when config.debug is enabled.
   * @param {...unknown} args
   */
  function debugLog(...args) {
    if (!config.debug) return;
    console.error("[opencode-anthropic-auth]", ...args);
  }

  let claudeCliVersion = FALLBACK_CLAUDE_CLI_VERSION;
  const signatureSessionId = randomUUID();
  const signatureUserId = getOrCreateSignatureUserId();
  if (shouldFetchClaudeCodeVersion) {
    fetchLatestClaudeCodeVersion()
      .then((version) => {
        if (!version) return;
        claudeCliVersion = version;
        debugLog("resolved claude-code version from npm", version);
      })
      .catch(() => {
        // Ignore fetch errors and keep fallback version.
      });
  }

  /**
   * Refresh a specific account token with single-flight protection.
   * Prevents concurrent refresh races from disabling healthy accounts.
   * @param {import('./lib/accounts.mjs').ManagedAccount} account
   * @returns {Promise<string>}
   */
  async function refreshAccountTokenSingleFlight(account) {
    const key = account.id;
    const existing = refreshInFlight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        return await refreshAccountToken(account, client);
      } finally {
        if (refreshInFlight.get(key) === p) {
          refreshInFlight.delete(key);
        }
      }
    })();

    refreshInFlight.set(key, p);
    return p;
  }

  return {
    // A1-A4: System prompt transform (unchanged)
    "experimental.chat.system.transform": (input, output) => {
      const prefix = CLAUDE_CODE_IDENTITY_STRING;
      if (!signatureEmulationEnabled && input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1]) output.system[1] = prefix + "\n\n" + output.system[1];
      }
    },
    config: async (input) => {
      input.command ??= {};
      input.command["anthropic"] = {
        template: "/anthropic",
        description: "Manage Anthropic multi-account auth (status, usage, switch, login, reauth, logout)",
      };
    },
    "command.execute.before": async (input) => {
      if (input.command !== "anthropic") return;

      try {
        await handleAnthropicSlashCommand(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sendCommandMessage(input.sessionID, `▣ Anthropic (error)\n\n${message}`);
      }

      throw new Error(ANTHROPIC_COMMAND_HANDLED);
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          // B1-B2: Zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }

          // Initialize AccountManager from disk + OpenCode auth fallback
          accountManager = await AccountManager.load(config, {
            refresh: auth.refresh,
            access: auth.access,
            expires: auth.expires,
          });

          // If we bootstrapped from auth.json and have no stored accounts file,
          // save immediately to create it (debounced save may not fire in time)
          if (accountManager.getAccountCount() > 0) {
            await accountManager.saveToDisk();
          }

          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              // Re-read auth for non-oauth fallback
              const currentAuth = await getAuth();
              if (currentAuth.type !== "oauth") return fetch(input, init);

              // Transform URL once (shared across retries)
              const requestInit = init ?? {};
              const { requestInput, requestUrl } = transformRequestUrl(input);
              const requestMethod = String(
                requestInit.method || (requestInput instanceof Request ? requestInput.method : "POST"),
              ).toUpperCase();
              let showUsageToast;
              try {
                showUsageToast = new URL(requestUrl).pathname === "/v1/messages" && requestMethod === "POST";
              } catch {
                showUsageToast = false;
              }

              let lastError = null;
              const transientRefreshSkips = new Set();

              // Sync with CLI changes at request start.
              if (accountManager) {
                await accountManager.syncActiveIndexFromDisk();
              }

              // Try each account at most once. If the error is account-specific,
              // switch to the next account. If it's service-wide, return immediately.
              const maxAttempts = accountManager.getTotalAccountCount();

              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                // Select account
                const account = accountManager.getCurrentAccount(transientRefreshSkips);

                // Toast account usage on first use and whenever the account changes
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
                      "No enabled Anthropic accounts available. Enable one with 'opencode-anthropic-auth enable <N>'.",
                    );
                  }
                  // All accounts excluded (transient refresh failures) — give up
                  throw new Error("No available Anthropic account for request.");
                }

                // Determine access token
                let accessToken;
                // Per-account token refresh
                if (!account.access || !account.expires || account.expires < Date.now()) {
                  try {
                    accessToken = await refreshAccountTokenSingleFlight(account);
                    // Persist updated tokens (especially if refresh token rotated)
                    accountManager.requestSaveToDisk();
                  } catch (err) {
                    // Token refresh failed — mark account as failed
                    accountManager.markFailure(account);
                    // Disable account on terminal refresh errors
                    const msg = err instanceof Error ? err.message : String(err);
                    const status = typeof err === "object" && err && "status" in err ? Number(err.status) : NaN;
                    const errorCode =
                      typeof err === "object" && err && "errorCode" in err ? String(err.errorCode || "") : "";
                    const shouldDisable =
                      status === 400 ||
                      status === 401 ||
                      status === 403 ||
                      errorCode === "invalid_grant" ||
                      errorCode === "invalid_request" ||
                      msg.includes("invalid_grant");

                    if (shouldDisable) {
                      account.enabled = false;
                      accountManager.requestSaveToDisk();
                      const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                      await toast(`Disabled ${name} (token refresh failed)`, "error");
                    } else {
                      // Skip this account for the remainder of this request.
                      transientRefreshSkips.add(account.index);
                    }
                    lastError = err;
                    continue; // Try next account
                  }
                } else {
                  accessToken = account.access;
                }

                let body = transformRequestBody(
                  requestInit.body,
                  {
                    enabled: signatureEmulationEnabled,
                    claudeCliVersion,
                  },
                  {
                    persistentUserId: signatureUserId,
                    sessionId: signatureSessionId,
                    accountId: getAccountIdentifier(account),
                  },
                );

                // Build headers with the selected account's token
                const requestHeaders = buildRequestHeaders(input, requestInit, accessToken, body, requestUrl, {
                  enabled: signatureEmulationEnabled,
                  claudeCliVersion,
                });
                body = syncBodyBetasFromHeader(body, requestHeaders, signatureEmulationEnabled);

                // Execute the request
                let response;
                try {
                  response = await fetch(requestInput, {
                    ...requestInit,
                    body,
                    headers: requestHeaders,
                  });
                } catch (err) {
                  const fetchError = err instanceof Error ? err : new Error(String(err));

                  if (accountManager && account) {
                    accountManager.markFailure(account);
                    transientRefreshSkips.add(account.index);
                    lastError = fetchError;
                    debugLog("request fetch threw, trying next account", {
                      accountIndex: account.index,
                      message: fetchError.message,
                    });
                    continue;
                  }

                  throw fetchError;
                }

                // On error, check if it's account-specific or service-wide
                if (!response.ok && accountManager && account) {
                  let errorBody = null;
                  try {
                    errorBody = await response.clone().text();
                  } catch {
                    // Ignore read errors
                  }

                  if (isAccountSpecificError(response.status, errorBody)) {
                    // Account-specific: mark this account, try the next one
                    const reason = parseRateLimitReason(response.status, errorBody);
                    const retryAfterMs = parseRetryAfterHeader(response);
                    const authOrPermissionIssue = reason === "AUTH_FAILED";

                    // Auth failures should force token refresh on next use.
                    if (reason === "AUTH_FAILED") {
                      account.access = undefined;
                      account.expires = undefined;
                    }

                    debugLog("account-specific error, switching account", {
                      accountIndex: account.index,
                      status: response.status,
                      reason,
                    });

                    accountManager.markRateLimited(account, reason, authOrPermissionIssue ? null : retryAfterMs);

                    const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                    const total = accountManager.getAccountCount();
                    if (total > 1) {
                      const switchReason = formatSwitchReason(response.status, reason);
                      await toast(`${name} ${switchReason}, switching account`, "warning", {
                        debounceKey: "account-switch",
                      });
                    }

                    continue; // Try next account immediately
                  }

                  // Service-wide error (529, 503, 500, etc.) — return to caller,
                  // switching accounts won't help
                  debugLog("service-wide response error, returning directly", {
                    status: response.status,
                  });
                  return transformResponse(response);
                }

                // Success
                if (account && accountManager) {
                  if (response.ok) {
                    accountManager.markSuccess(account);
                  }
                }

                // Wire usage tracking and mid-stream error detection for SSE responses only.
                const shouldInspectStream = response.ok && account && accountManager && isEventStreamResponse(response);

                const usageCallback = shouldInspectStream
                  ? (/** @type {UsageStats} */ usage) => {
                      accountManager.recordUsage(account.index, usage);
                    }
                  : null;

                const accountErrorCallback = shouldInspectStream
                  ? (details) => {
                      // Mid-stream account error: mark for NEXT request
                      if (details.invalidateToken) {
                        account.access = undefined;
                        account.expires = undefined;
                      }
                      accountManager.markRateLimited(account, details.reason, null);
                    }
                  : null;

                return transformResponse(response, usageCallback, accountErrorCallback);
              }

              // All accounts tried
              if (lastError) throw lastError;
              throw new Error("All accounts exhausted — no account could serve this request");
            },
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
            // Check for existing accounts
            const stored = await loadAccounts();
            if (stored && stored.accounts.length > 0 && accountManager) {
              const action = await promptAccountMenu(accountManager);

              if (action === "cancel") {
                return {
                  url: "about:blank",
                  instructions: "Cancelled.",
                  method: "code",
                  callback: async () => ({ type: "failed" }),
                };
              }

              if (action === "manage") {
                await promptManageAccounts(accountManager);
                await accountManager.saveToDisk();
                return {
                  url: "about:blank",
                  instructions: "Account management complete. Re-run auth to add accounts.",
                  method: "code",
                  callback: async () => ({ type: "failed" }),
                };
              }

              if (action === "fresh") {
                await clearAccounts();
                accountManager.clearAll();
              }

              // action === "add" or "fresh" — fall through to OAuth flow
            }

            const { url, verifier } = await authorize("max");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;

                // Initialize AccountManager if not yet loaded (first login —
                // loader() hasn't run yet because auth hasn't completed)
                if (!accountManager) {
                  accountManager = await AccountManager.load(config, null);
                }

                // Add to account pool and persist immediately
                const countBefore = accountManager.getAccountCount();
                accountManager.addAccount(
                  credentials.refresh,
                  credentials.access,
                  credentials.expires,
                  credentials.email,
                );
                await accountManager.saveToDisk();

                // Toast the result
                const total = accountManager.getAccountCount();
                const name = credentials.email || "account";
                if (countBefore > 0) {
                  await toast(`Added ${name} — ${total} accounts`, "success");
                } else {
                  await toast(`Authenticated (${name})`, "success");
                }

                return credentials;
              },
            };
          },
        },
        {
          // H2: Create an API Key (unchanged)
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                const result = await fetch(`https://api.anthropic.com/api/oauth/claude_cli/create_api_key`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${credentials.access}`,
                  },
                }).then((r) => r.json());
                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          // H3: Manual API Key (unchanged)
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}
