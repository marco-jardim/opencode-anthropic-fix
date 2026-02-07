import { generatePKCE } from "@openauthjs/openauth/pkce";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AccountManager } from "./lib/accounts.mjs";
import { loadConfig } from "./lib/config.mjs";
import { loadAccounts, clearAccounts } from "./lib/storage.mjs";
import {
  isAccountSpecificError,
  parseRateLimitReason,
  parseRetryAfterHeader,
} from "./lib/backoff.mjs";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// ---------------------------------------------------------------------------
// OAuth helpers (unchanged from original)
// ---------------------------------------------------------------------------

/**
 * @param {"max" | "console"} mode
 */
async function authorize(mode) {
  const pkce = await generatePKCE();

  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

/**
 * @param {string} code
 * @param {string} verifier
 */
async function exchange(code, verifier) {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok)
    return {
      type: "failed",
    };
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
    email: json.account?.email_address || undefined,
  };
}

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
      const answer = await rl.question(
        "(a)dd new, (f)resh start, (m)anage, (c)ancel? [a/f/m/c]: ",
      );
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
      const answer = await rl.question(
        "Enter account number to toggle, (d)N to delete (e.g. d1), or (b)ack: ",
      );
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
        console.log(
          `Account ${num} is now ${newState ? "enabled" : "disabled"}.`,
        );
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

/**
 * Build request headers from input and init, applying OAuth requirements.
 * Preserves behaviors D1-D7.
 *
 * @param {any} input
 * @param {Record<string, any>} requestInit
 * @param {string} accessToken
 * @returns {Headers}
 */
function buildRequestHeaders(input, requestInit, accessToken) {
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
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const requiredBetas = [
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
  ];
  const mergedBetas = [
    ...new Set([...requiredBetas, ...incomingBetasList]),
  ].join(",");

  requestHeaders.set("authorization", `Bearer ${accessToken}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");
  requestHeaders.delete("x-api-key");

  return requestHeaders;
}

/**
 * Transform the request body: system prompt sanitization and tool prefixing.
 * Preserves behaviors E1-E7.
 *
 * @param {string | undefined} body
 * @returns {string | undefined}
 */
function transformRequestBody(body) {
  if (!body || typeof body !== "string") return body;

  const TOOL_PREFIX = "mcp_";

  try {
    const parsed = JSON.parse(body);

    // Sanitize system prompt - server blocks "OpenCode" string
    // Note: (?<!\/) preserves paths like /path/to/opencode-foo
    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((item) => {
        if (item.type === "text" && item.text) {
          return {
            ...item,
            text: item.text
              .replace(/OpenCode/g, "Claude Code")
              .replace(/(?<!\/)opencode/gi, "Claude"),
          };
        }
        return item;
      });
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
  } catch (e) {
    // ignore parse errors
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

  if (
    requestUrl &&
    requestUrl.pathname === "/v1/messages" &&
    !requestUrl.searchParams.has("beta")
  ) {
    requestUrl.searchParams.set("beta", "true");
    requestInput =
      input instanceof Request
        ? new Request(requestUrl.toString(), input)
        : requestUrl;
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
          (stats.inputTokens > 0 ||
            stats.outputTokens > 0 ||
            stats.cacheReadTokens > 0 ||
            stats.cacheWriteTokens > 0)
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
  const response = await fetch(
    "https://console.anthropic.com/v1/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: CLIENT_ID,
      }),
    },
  );

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

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  const config = loadConfig();

  /** @type {AccountManager | null} */
  let accountManager = null;

  /** Track account usage toasts; show once per account change (including first use). */
  let lastToastedIndex = -1;
  /** @type {Map<string, number>} */
  const debouncedToastTimestamps = new Map();

  /** @type {Map<string, Promise<string>>} */
  const refreshInFlight = new Map();

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
      const prefix =
        "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1])
          output.system[1] = prefix + "\n\n" + output.system[1];
      }
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

              // Transform body and URL once (shared across retries)
              const requestInit = init ?? {};
              const body = transformRequestBody(requestInit.body);
              const { requestInput, requestUrl } = transformRequestUrl(input);
              const requestMethod = String(
                requestInit.method ||
                (requestInput instanceof Request ? requestInput.method : "POST"),
              ).toUpperCase();
              let showUsageToast = false;
              try {
                showUsageToast =
                  new URL(requestUrl).pathname === "/v1/messages" &&
                  requestMethod === "POST";
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
                    const msg = total > 1
                      ? `Claude: ${name} (${currentIndex + 1}/${total})`
                      : `Claude: ${name}`;
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
                if (
                  !account.access ||
                  !account.expires ||
                  account.expires < Date.now()
                ) {
                  try {
                    accessToken = await refreshAccountTokenSingleFlight(account);
                    // Persist updated tokens (especially if refresh token rotated)
                    accountManager.requestSaveToDisk();
                  } catch (err) {
                    // Token refresh failed — mark account as failed
                    accountManager.markFailure(account);
                    // Disable account on terminal refresh errors
                    const msg = err instanceof Error ? err.message : String(err);
                    const status =
                      typeof err === "object" && err && "status" in err
                        ? Number(err.status)
                        : NaN;
                    const errorCode =
                      typeof err === "object" && err && "errorCode" in err
                        ? String(err.errorCode || "")
                        : "";
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

                // Build headers with the selected account's token
                const requestHeaders = buildRequestHeaders(
                  input,
                  requestInit,
                  accessToken,
                );

                // Execute the request
                let response;
                try {
                  response = await fetch(requestInput, {
                    ...requestInit,
                    body,
                    headers: requestHeaders,
                  });
                } catch (err) {
                  const fetchError = err instanceof Error
                    ? err
                    : new Error(String(err));

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
                    const reason = parseRateLimitReason(
                      response.status,
                      errorBody,
                    );
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

                    accountManager.markRateLimited(
                      account,
                      reason,
                      authOrPermissionIssue ? null : retryAfterMs,
                    );

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
                const shouldInspectStream =
                  response.ok &&
                  account &&
                  accountManager &&
                  isEventStreamResponse(response);

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
              throw new Error(
                "All accounts exhausted — no account could serve this request",
              );
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
            if (
              stored &&
              stored.accounts.length > 0 &&
              accountManager
            ) {
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
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json());
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
