import { generatePKCE } from "@openauthjs/openauth/pkce";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AccountManager } from "./lib/accounts.mjs";
import { loadConfig } from "./lib/config.mjs";
import { loadAccounts, clearAccounts } from "./lib/storage.mjs";
import {
  isRetryableStatus,
  parseRateLimitReason,
  parseRetryAfterHeader,
} from "./lib/backoff.mjs";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const MAX_RETRIES = 3;

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
      const label = acc.email || `Account ${acc.index + 1}`;
      const active = acc.index === currentIndex ? " (active)" : "";
      const disabled = !acc.enabled ? " [disabled]" : "";
      console.log(`  ${acc.index + 1}. ${label}${active}${disabled}`);
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
      const label = acc.email || `Account ${acc.index + 1}`;
      const status = acc.enabled ? "enabled" : "disabled";
      console.log(`  ${acc.index + 1}. ${label} [${status}]`);
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
 * Wrap a response body stream to strip mcp_ prefix from tool names.
 * Preserves behaviors G1-G5.
 *
 * @param {Response} response
 * @returns {Response}
 */
function transformResponse(response) {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      let text = decoder.decode(value, { stream: true });
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
    throw new Error(`Token refresh failed: ${response.status}`);
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

              let lastError = null;

              for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                // Select account
                const account = accountManager
                  ? accountManager.getCurrentAccount()
                  : null;

                // Determine access token
                let accessToken;
                if (account) {
                  // Per-account token refresh
                  if (
                    !account.access ||
                    !account.expires ||
                    account.expires < Date.now()
                  ) {
                    try {
                      accessToken = await refreshAccountToken(account, client);
                      // Persist updated tokens (especially if refresh token rotated)
                      if (accountManager) {
                        accountManager.requestSaveToDisk();
                      }
                    } catch (err) {
                      // Token refresh failed — mark account as failed
                      if (accountManager) {
                        accountManager.markFailure(account);
                        // Disable account on invalid_grant (revoked)
                        const msg =
                          err instanceof Error ? err.message : String(err);
                        if (msg.includes("401") || msg.includes("403")) {
                          account.enabled = false;
                          accountManager.requestSaveToDisk();
                        }
                      }
                      lastError = err;
                      continue; // Try next account
                    }
                  } else {
                    accessToken = account.access;
                  }
                } else {
                  // Fallback: use OpenCode's auth directly (single-account mode)
                  if (
                    !currentAuth.access ||
                    currentAuth.expires < Date.now()
                  ) {
                    const response = await fetch(
                      "https://console.anthropic.com/v1/oauth/token",
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          grant_type: "refresh_token",
                          refresh_token: currentAuth.refresh,
                          client_id: CLIENT_ID,
                        }),
                      },
                    );
                    if (!response.ok) {
                      throw new Error(
                        `Token refresh failed: ${response.status}`,
                      );
                    }
                    const json = await response.json();
                    await client.auth.set({
                      path: { id: "anthropic" },
                      body: {
                        type: "oauth",
                        refresh: json.refresh_token,
                        access: json.access_token,
                        expires: Date.now() + json.expires_in * 1000,
                      },
                    });
                    currentAuth.access = json.access_token;
                  }
                  accessToken = currentAuth.access;
                }

                // Build headers with the selected account's token
                const requestHeaders = buildRequestHeaders(
                  input,
                  requestInit,
                  accessToken,
                );

                // Execute the request
                const response = await fetch(requestInput, {
                  ...requestInit,
                  body,
                  headers: requestHeaders,
                });

                // Check for retryable errors
                if (
                  isRetryableStatus(response.status) &&
                  accountManager &&
                  account &&
                  attempt < MAX_RETRIES
                ) {
                  // Read the error body for reason parsing
                  let errorBody = null;
                  try {
                    errorBody = await response.clone().text();
                  } catch {
                    // Ignore read errors
                  }

                  const reason = parseRateLimitReason(
                    response.status,
                    errorBody,
                  );
                  const retryAfterMs = parseRetryAfterHeader(response);
                  const backoffMs = accountManager.markRateLimited(
                    account,
                    reason,
                    retryAfterMs,
                  );

                  // If all accounts are exhausted, wait for the shortest backoff
                  const minWait = accountManager.getMinWaitTime();
                  if (minWait > 0) {
                    const maxWait =
                      config.max_rate_limit_wait_seconds * 1000;
                    if (minWait <= maxWait) {
                      await new Promise((resolve) =>
                        setTimeout(resolve, minWait),
                      );
                    } else {
                      // Exceeded max wait — return the error response
                      return transformResponse(response);
                    }
                  }

                  continue; // Retry with next account
                }

                // Success or non-retryable error
                if (account && accountManager) {
                  if (response.ok) {
                    accountManager.markSuccess(account);
                  }
                }

                return transformResponse(response);
              }

              // All retries exhausted
              if (lastError) throw lastError;
              throw new Error(
                "All accounts exhausted after maximum retries",
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
                accountManager.addAccount(
                  credentials.refresh,
                  credentials.access,
                  credentials.expires,
                );
                await accountManager.saveToDisk();

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
