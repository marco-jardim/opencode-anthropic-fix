import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes, randomUUID, createHash as createHashCrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { AccountManager, RATE_LIMIT_KEY_FAST } from "./lib/accounts.mjs";
import {
  authorize as oauthAuthorize,
  exchange as oauthExchange,
  parseOAuthCallback,
  refreshToken,
} from "./lib/oauth.mjs";
import { resolveBetaShortcut } from "./lib/betas.mjs";
import { loadConfig, loadConfigFresh, saveConfig, getConfigDir } from "./lib/config.mjs";
import { loadAccounts, saveAccounts, clearAccounts, createDefaultStats } from "./lib/storage.mjs";
import { acquireRefreshLock, releaseRefreshLock } from "./lib/refresh-lock.mjs";
import {
  isAccountSpecificError,
  parseRateLimitReason,
  parseRetryAfterHeader,
  parseRetryAfterMsHeader,
  parseUnifiedResetMsHeader,
  parseShouldRetryHeader,
  TRANSIENT_RETRY_THRESHOLD_MS,
} from "./lib/backoff.mjs";
import { callHaiku } from "./lib/haiku-call.mjs";
import { summarize as rollingSummarize } from "./lib/rolling-summarizer.mjs";
import { staleReadEviction, perToolClassPrune } from "./lib/message-transform.mjs";
import {
  estimatePromptTokensFromParsed,
  applySessionToolResultDedupe,
  maybeApplySessionToolResultDedupe,
  applyContextHintCompaction,
} from "./lib/token-economy/transforms.mjs";
import { shouldMicrocompact, buildMicrocompactBetas } from "./lib/token-economy/microcompact.mjs";
import { redactSecrets, redactString } from "./lib/redact.mjs";
import {
  createTransformedSSEStream,
  resolveStreamIdleTimeoutMs,
  stripMcpPrefixFromParsedEvent,
} from "./lib/mimicry/response-stream.mjs";
import { transformRequestBody, CORE_TOOL_NAMES } from "./lib/mimicry/request-body.mjs";
import { isTruthyEnv } from "./lib/env.mjs";
import { sessionMetrics, createInitialSessionMetrics, getAverageCacheHitRate } from "./lib/session-metrics.mjs";
import { repairOrphanedToolUseBlocks } from "./lib/mimicry/request-helpers.mjs";
import { resolveCacheTtl, shouldPlaceToolBreakpoint, updateBoundaryStability } from "./lib/mimicry/cache.mjs";
import { SERVICE_WIDE_MAX_RETRIES, CONSECUTIVE_529_FALLBACK_THRESHOLD } from "./lib/tuning.mjs";
import {
  computeServiceRetrySleepMs,
  selectFallbackModel,
  shouldServiceRetry,
  isTransientRateLimit,
} from "./lib/retry/overload-loop.mjs";
import {
  buildRequestHeaders,
  buildAnthropicBetaHeader,
  parseRequestBodyMetadata,
  extractFileIds,
  stripStainlessHelperMarkers,
} from "./lib/mimicry/headers.mjs";
import {
  buildSystemPromptBlocks,
  compactSystemText,
  compactToolDescription,
  dedupeSystemBlocks,
  isTitleGeneratorSystemBlocks,
  normalizeSystemTextBlocks,
  sanitizeSystemText,
  CLAUDE_CODE_IDENTITY_STRING,
} from "./lib/mimicry/system-prompt.mjs";
import {
  ADAPTER_COUNT_TOKENS_PATHNAMES,
  ADAPTER_MESSAGES_PATHNAMES,
  assertAdapterBodyUsable,
  buildAdapterTransport,
  resolveAdapterEnv,
} from "./lib/mimicry/adapter-input.mjs";
import { buildPassthroughHeaders, stripNonApiBodyFields } from "./lib/passthrough-headers.mjs";
import {
  buildWireCompatibleRequest,
  buildWireCompatibleCountTokensRequest,
  WIRE_PROFILE,
} from "./lib/mimicry/wire-compat.mjs";
import {
  hasOneMillionContext,
  isEligibleFor1MContext,
  isOpus46Model,
  isOpus47Model,
  isOpus48Model,
} from "./lib/mimicry/models.mjs";

export { isFable5Model, isMythos5Model, isAdaptiveThinkingModel } from "./lib/mimicry/models.mjs";

// Max times a single logical request may fall back from fast->standard speed on
// the same account before giving up the fast attempt entirely. 1 is enough: one
// fast 429 => one standard retry on the same account.
const MAX_FAST_FALLBACKS = 1;

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
  // QA fix M6: re-snapshot after each mutation to avoid stale index references
  let accounts = accountManager.getAccountsSnapshot();
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
        accounts = accountManager.getAccountsSnapshot(); // re-snapshot after toggle
        continue;
      }

      console.log("Invalid input.");
    }
  } finally {
    rl.close();
  }
}

/**
 * Pure driver for experimental.session.summarize. Extracted from the handler
 * closure so it can be unit-tested without bootstrapping the full plugin.
 * All external dependencies are injected.
 *
 * @param {object} deps
 * @param {object|null} deps.config - Plugin config; handler no-ops if config.token_economy_strategies.haiku_rolling_summary is not true.
 * @param {() => Promise<string>} deps.getAccessToken - Resolves to a Bearer OAuth token (or throws).
 * @param {typeof globalThis.fetch} deps.fetchFn - HTTP transport.
 * @param {typeof callHaiku} deps.callHaikuFn - Haiku API caller.
 * @param {typeof rollingSummarize} deps.rollingSummarizeFn - Deterministic summarizer.
 * @param {{warn: (msg: string) => void}} [deps.logger] - For fall-through warnings.
 * @param {{sessionID: string, messages: unknown[], model: unknown}} input
 * @param {{summary?: string, modelID?: string, providerID?: string, tokens?: {input: number, output: number}, cost?: number}} output
 */
async function runHaikuSessionSummarize(
  { config, getAccessToken, fetchFn, callHaikuFn, rollingSummarizeFn, logger },
  input,
  output,
) {
  if (!config?.token_economy_strategies?.haiku_rolling_summary) return;

  try {
    let capturedTokens = { input: 0, output: 0 };
    let capturedCost = 0;
    const haikuCall = async (request) => {
      const r = await callHaikuFn({
        prompt: request.prompt,
        fetch: fetchFn,
        getAccessToken,
      });
      capturedTokens = r.tokens;
      capturedCost = r.cost;
      return r.text;
    };

    const summaryText = await rollingSummarizeFn(input.messages, { haikuCall });
    if (typeof summaryText !== "string" || summaryText.length === 0) return;

    output.summary = summaryText;
    output.modelID = "claude-haiku-4-5-20251001";
    output.providerID = "anthropic";
    output.tokens = capturedTokens;
    output.cost = capturedCost;
  } catch (err) {
    if (logger && typeof logger.warn === "function") {
      const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
      logger.warn(`[opencode-anthropic-fix] haiku rolling summary failed; falling back to default compaction: ${msg}`);
    }
  }
}

export async function AnthropicAuthPlugin({ client }) {
  const config = loadConfig();
  _pluginConfig = config; // expose to module-level functions (cache stats, response headers)
  // QA fix H6: read emulation settings live from config instead of stale const capture
  // so that runtime toggles via `/anthropic set emulation` take effect immediately
  const getSignatureEmulationEnabled = () => config.signature_emulation.enabled;
  const getPromptCompactionMode = () => (config.signature_emulation.prompt_compaction === "off" ? "off" : "minimal");
  const shouldFetchClaudeCodeVersion =
    getSignatureEmulationEnabled() && config.signature_emulation.fetch_claude_code_version_on_startup;

  // Per-instance strategy state (moved from module-level for test isolation)
  const strategyState = {
    mode: "CONFIGURED", // "CONFIGURED" | "DEGRADED"
    rateLimitEvents: [], // timestamps of rate limit events in current window
    windowMs: 5 * 60 * 1000, // 5-minute sliding window
    thresholdCount: 3, // rate limits needed to trigger DEGRADED
    recoveryMs: 5 * 60 * 1000, // 5 minutes clean to recover
    lastRateLimitTime: 0,
    manualOverride: false, // user explicitly set strategy — disable auto-adaptation
    originalStrategy: null, // the user's configured strategy before DEGRADED override
  };

  /** @type {AccountManager | null} */
  let accountManager = null;

  /** Track account usage toasts; show once per account change (including first use). */
  let lastToastedIndex = -1;
  /** @type {Map<string, number>} */
  const debouncedToastTimestamps = new Map();

  /** @type {Map<string, { promise: Promise<string>, source: "foreground" | "idle" }>} */
  const refreshInFlight = new Map();

  /** @type {Map<string, number>} */
  const idleRefreshLastAttempt = new Map();
  /** @type {Set<string>} */
  const idleRefreshInFlight = new Set();

  // QA fix H3: use getter functions so /anthropic set toggles take effect at runtime
  // (same pattern as getSignatureEmulationEnabled at line 113).
  const getIdleRefreshEnabled = () => config.idle_refresh.enabled;
  const getIdleRefreshWindowMs = () => config.idle_refresh.window_minutes * 60 * 1000;
  const getIdleRefreshMinIntervalMs = () => config.idle_refresh.min_interval_minutes * 60 * 1000;

  /**
   * Previous state of all anthropic-ratelimit-unified-* headers.
   * Used to detect changes and emit toasts when status values transition.
   * Keys mirror the header names (minus the "anthropic-ratelimit-unified-" prefix).
   * @type {Record<string, string | null>}
   */
  const previousUnifiedStatus = {};

  // Willow Mode: detect inactivity and suggest context reset.
  // Named after the willow tree — when idle, the session "droops" and a gentle
  // nudge suggests starting fresh rather than accumulating stale context.
  const getWillowEnabled = () => config.willow_mode?.enabled ?? true;
  const getWillowIdleThresholdMs = () => (config.willow_mode?.idle_threshold_minutes ?? 30) * 60 * 1000;
  const getWillowCooldownMs = () => (config.willow_mode?.cooldown_minutes ?? 60) * 60 * 1000;
  const getWillowMinTurns = () => config.willow_mode?.min_turns_before_suggest ?? 3;
  let willowLastRequestTime = Date.now();
  let willowLastSuggestionTime = 0;
  let _lastOAuthPruneTime = 0; // QA fix L-oauthPrune: throttle for periodic prune

  // F4: Session-level latch for rejected custom betas.
  // When a custom beta triggers a 400/anthropic-beta or 413-with-signal rejection,
  // its canonical name is stored here so subsequent requests within
  // SESSION_REJECTED_BETA_TTL_MS skip that beta without paying a first-fail each time.
  // Memory only - not persisted to disk.
  const SESSION_REJECTED_BETA_TTL_MS = 5 * 60 * 1000; // 5 minutes
  /** @type {Map<string, number>} canonical-beta to rejected-at epoch ms */
  const sessionRejectedBetas = new Map();

  // Token economy — session state for layered compaction strategies.
  const tokenEconomySession = {
    /** When thinking was last stripped (TTL-based strategy). 0 = never. */
    lastThinkingStripMs: 0,
    /** When proactive microcompact was last run (threshold-based). 0 = never. */
    lastMicrocompactMs: 0,
    /** Running count of tool_results client-compacted this session. */
    toolResultsCompacted: 0,
    /** Running count of thinking blocks stripped this session. */
    thinkingStripped: 0,
    /** Map of content-hash → first-seen tool_use_id for cross-turn dedupe. */
    seenContentHashes: new Map(),
  };

  // Cache TTL session latching: latch the cache policy at session start
  // so mid-session toggles don't bust the server-side prompt cache.
  let sessionCachePolicyLatched = false;
  /** @type {{ttl: string, ttl_supported: boolean, boundary_marker?: boolean} | null} */
  let latchedCachePolicy = null;

  /**
   * Whether OPENCODE_ANTHROPIC_INITIAL_ACCOUNT env var pinned this session to a
   * specific account. When true, syncActiveIndexFromDisk is skipped and strategy
   * is forced to sticky and disables
   * syncActiveIndexFromDisk so other sessions can't override this one.
   * Use case: terminal 1 with INITIAL_ACCOUNT=1, terminal 2 with =2.
   */
  let initialAccountPinned = false;

  /**
   * Pending slash-command OAuth flows keyed by session ID.
   * @type {Map<string, { mode: "login" | "reauth", verifier: string, targetIndex?: number, createdAt: number }>}
   */
  const pendingSlashOAuth = new Map();

  /**
   * Cooldown for slash OAuth token exchange after 429 responses, keyed by session ID.
   * @type {Map<string, number>}
   */
  const slashOAuthExchangeCooldownUntil = new Map();

  /**
   * In-memory mapping of file_id → account index for file-ID account pinning.
   * Populated by /anthropic files commands, consumed by the fetch interceptor
   * to route Messages API requests referencing file_ids to the correct account.
   * QA fix M1: bounded to prevent unbounded growth; evicts oldest entries when full.
   * @type {Map<string, number>}
   */
  const FILE_ACCOUNT_MAP_MAX = 1000;
  const fileAccountMap = new Map();
  /** QA fix M1: bounded set — evicts oldest entries when map exceeds max size */
  function fileAccountMapSet(fileId, accountIndex) {
    fileAccountMap.set(fileId, accountIndex);
    if (fileAccountMap.size > FILE_ACCOUNT_MAP_MAX) {
      // Delete oldest entries (Map iterates in insertion order)
      const excess = fileAccountMap.size - FILE_ACCOUNT_MAP_MAX;
      let deleted = 0;
      for (const key of fileAccountMap.keys()) {
        if (deleted >= excess) break;
        fileAccountMap.delete(key);
        deleted++;
      }
    }
  }

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

    for (const [sessionID, until] of slashOAuthExchangeCooldownUntil.entries()) {
      if (!pendingSlashOAuth.has(sessionID) || until <= now) {
        slashOAuthExchangeCooldownUntil.delete(sessionID);
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
   * Start a pending slash-command OAuth flow and store verifier in-memory.
   * @param {string} sessionID
   * @param {"login" | "reauth"} mode
   * @param {number} [targetIndex]
   */
  async function startSlashOAuth(sessionID, mode, targetIndex) {
    pruneExpiredPendingOAuth();
    const { url, verifier, state } = await oauthAuthorize("max");
    pendingSlashOAuth.set(sessionID, {
      mode,
      verifier,
      state,
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
      slashOAuthExchangeCooldownUntil.delete(sessionID);
      return {
        ok: false,
        message: "Pending OAuth flow expired. Start again with /anthropic login or /anthropic reauth <N>.",
      };
    }

    const now = Date.now();
    const cooldownUntil = slashOAuthExchangeCooldownUntil.get(sessionID) || 0;
    if (cooldownUntil > now) {
      const remainingSec = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
      return {
        ok: false,
        message: `OAuth token exchange is still rate-limited. Wait about ${remainingSec}s and retry /anthropic ${pending.mode} complete <code#state>.`,
      };
    }
    slashOAuthExchangeCooldownUntil.delete(sessionID);

    // Validate CSRF state parameter (RFC 6749 §10.12)
    // If we stored a state, the returned code MUST include a matching state (QA fix C2)
    // parseOAuthCallback splits "code#state" or a full callback URL into parts.
    // _parsedCode is unused after F3 fix (exchange() re-parses internally); kept
    // only to extract returnedState for the CSRF check below.
    const { code: _parsedCode, state: returnedState } = parseOAuthCallback(code);
    // F3: `exchange()` calls parseOAuthCallback() internally; pass the original
    // user input so it can forward `state` to the token endpoint.
    // CSRF validation already done above via returnedState === pending.state.
    if (pending.state) {
      if (!returnedState || returnedState !== pending.state) {
        pendingSlashOAuth.delete(sessionID);
        slashOAuthExchangeCooldownUntil.delete(sessionID);
        return {
          ok: false,
          message: "OAuth state mismatch or missing — possible CSRF attack. Please start a new login flow.",
        };
      }
    }

    const credentials = await oauthExchange(code, pending.verifier);
    if (credentials.type === "failed") {
      if (credentials.status === 429) {
        const retryAfterMs =
          typeof credentials.retryAfterMs === "number" && Number.isFinite(credentials.retryAfterMs)
            ? Math.max(1000, credentials.retryAfterMs)
            : 30_000;
        const retryAfterSource =
          typeof credentials.retryAfterSource === "string" && credentials.retryAfterSource
            ? credentials.retryAfterSource
            : "unknown";
        slashOAuthExchangeCooldownUntil.set(sessionID, Date.now() + retryAfterMs);
        const waitSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
        debugLog("slash oauth exchange rate limited", {
          sessionID,
          retryAfterMs,
          retryAfterSource,
        });

        return {
          ok: false,
          message: credentials.details
            ? `Token exchange failed (${credentials.details}).\n\nAnthropic OAuth is rate-limited. Wait about ${waitSec}s and retry /anthropic ${pending.mode} complete <code#state>.`
            : `Token exchange failed due to rate limiting. Wait about ${waitSec}s and retry /anthropic ${pending.mode} complete <code#state>.`,
        };
      }

      return {
        ok: false,
        message: credentials.details
          ? `Token exchange failed (${credentials.details}).`
          : "Token exchange failed. The code may be invalid or expired.",
      };
    }

    const stored = (await loadAccounts()) || { version: 1, accounts: [], activeIndex: 0 };

    if (pending.mode === "login") {
      const existingIdx = stored.accounts.findIndex((acc) => acc.refreshToken === credentials.refresh);
      if (existingIdx >= 0) {
        const acc = stored.accounts[existingIdx];
        acc.access = credentials.access;
        acc.expires = credentials.expires;
        if (credentials.email) acc.email = credentials.email;
        if (credentials.accountUuid) acc.accountUuid = credentials.accountUuid;
        if (credentials.organizationUuid) acc.organizationUuid = credentials.organizationUuid;
        acc.enabled = true;
        acc.consecutiveFailures = 0;
        acc.lastFailureTime = null;
        acc.rateLimitResetTimes = {};
        await saveAccounts(stored);
        await persistOpenCodeAuth(acc.refreshToken, acc.access, acc.expires);
        await reloadAccountManagerFromDisk();
        pendingSlashOAuth.delete(sessionID);
        slashOAuthExchangeCooldownUntil.delete(sessionID);
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
        accountUuid: credentials.accountUuid,
        organizationUuid: credentials.organizationUuid,
        refreshToken: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
        token_updated_at: now,
        addedAt: now,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: createDefaultStats(now),
      });
      // If accountUuid wasn't in the token exchange response, fetch from profile API
      const newAccount = stored.accounts[stored.accounts.length - 1];
      if (!newAccount.accountUuid && newAccount.access) {
        try {
          const profileResp = await globalThis.fetch("https://api.anthropic.com/api/oauth/profile", {
            method: "GET",
            headers: { Authorization: `Bearer ${newAccount.access}`, "Content-Type": "application/json" },
            signal: AbortSignal.timeout(10_000),
          });
          if (profileResp.ok) {
            const profile = await profileResp.json();
            if (profile.account?.uuid) newAccount.accountUuid = profile.account.uuid;
            if (profile.organization?.uuid) newAccount.organizationUuid = profile.organization.uuid;
          }
        } catch {
          /* Best-effort — don't fail account creation */
        }
      }
      await saveAccounts(stored);
      await persistOpenCodeAuth(newAccount.refreshToken, newAccount.access, newAccount.expires);
      await reloadAccountManagerFromDisk();
      pendingSlashOAuth.delete(sessionID);
      slashOAuthExchangeCooldownUntil.delete(sessionID);
      const label = credentials.email || `Account ${stored.accounts.length}`;
      return { ok: true, message: `Added account #${stored.accounts.length} (${label}).` };
    }

    // reauth flow
    const idx = pending.targetIndex ?? -1;
    if (idx < 0 || idx >= stored.accounts.length) {
      pendingSlashOAuth.delete(sessionID);
      slashOAuthExchangeCooldownUntil.delete(sessionID);
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
    slashOAuthExchangeCooldownUntil.delete(sessionID);
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

    // /anthropic config — show effective config
    if (primary === "config") {
      const fresh = loadConfigFresh();
      const lines = [
        "▣ Anthropic Config",
        "",
        `strategy: ${fresh.account_selection_strategy}`,
        `strategy-state: ${strategyState.mode}${strategyState.manualOverride ? " (manual override)" : ""}`,
        `emulation: ${fresh.signature_emulation.enabled ? "on" : "off"}`,
        `compaction: ${fresh.signature_emulation.prompt_compaction}`,
        `1m-context: ${fresh.override_model_limits.enabled ? "on" : "off"}`,
        `idle-refresh: ${fresh.idle_refresh.enabled ? "on" : "off"}`,
        `debug: ${fresh.debug ? "on" : "off"}`,
        `quiet: ${fresh.toasts.quiet ? "on" : "off"}`,
        `custom_betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
        `cache-boundary: ${fresh.cache_policy?.boundary_marker ? "on" : "off"}`,
        `cache-ttl: ${fresh.cache_policy?.ttl ?? "1h"}${fresh.cache_policy?.ttl_supported === false ? " (auto-disabled)" : ""}`,
        `fast-mode: ${fresh.fast_mode ? "on" : "off"}`,
        `telemetry-emulation: ${fresh.telemetry?.emulate_minimal ? "on (silent observer)" : "off"}`,
        `usage-toast: ${fresh.usage_toast ? "on" : "off"}`,
        `adaptive-context: ${fresh.adaptive_context?.enabled ? `on (↑${Math.round((fresh.adaptive_context.escalation_threshold || 150000) / 1000)}K ↓${Math.round((fresh.adaptive_context.deescalation_threshold || 100000) / 1000)}K)${adaptiveContextState.active ? " [ACTIVE]" : ""}` : "off"}`,
        `anti-verbosity: ${fresh.anti_verbosity?.enabled !== false ? "on" : "off"}`,
      ];
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }

    // /anthropic stats — show enhanced session statistics
    if (primary === "stats") {
      // Handle reset subcommand
      const secondary = (args[1] || "").toLowerCase();
      if (secondary === "reset") {
        sessionMetrics.turns = 0;
        sessionMetrics.usedTools.clear();
        sessionMetrics.totalInput = 0;
        sessionMetrics.totalOutput = 0;
        sessionMetrics.totalCacheRead = 0;
        sessionMetrics.totalCacheWrite = 0;
        sessionMetrics.totalWebSearchRequests = 0;
        sessionMetrics.recentCacheRates = [];
        sessionMetrics.sessionCostUsd = 0;
        sessionMetrics.costBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        sessionMetrics.sessionStartTime = Date.now();
        sessionMetrics.lastQuota = {
          tokens: 0,
          requests: 0,
          inputTokens: 0,
          updatedAt: 0,
          fiveHour: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
          sevenDay: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
          overallStatus: null,
          representativeClaim: null,
          fallback: null,
          fallbackPercentage: null,
          overageStatus: null,
          overageReason: null,
          lastPollAt: 0,
        };
        sessionMetrics.lastStopReason = null;
        sessionMetrics.perModel = {};
        sessionMetrics.lastModelId = null;
        sessionMetrics.lastRequestBody = null;
        sessionMetrics.tokenBudget = { limit: 0, used: 0, continuations: 0, outputHistory: [] };
        await sendCommandMessage(input.sessionID, "\u25a3 Anthropic\n\nStats reset.");
        return;
      }

      const avgRate = getAverageCacheHitRate();
      const totalTokens =
        sessionMetrics.totalInput +
        sessionMetrics.totalOutput +
        sessionMetrics.totalCacheRead +
        sessionMetrics.totalCacheWrite;
      const avgPerTurn = sessionMetrics.turns > 0 ? Math.round(totalTokens / sessionMetrics.turns) : 0;
      const elapsedMin = (Date.now() - sessionMetrics.sessionStartTime) / 60_000;
      const burnRate = elapsedMin > 0 ? sessionMetrics.sessionCostUsd / elapsedMin : 0;

      // Cache savings estimate: difference between what cache reads would cost at full input price vs cache read price
      const pricing = getModelPricing("claude-sonnet-4-6");
      const cacheSavings =
        sessionMetrics.totalCacheRead > 0
          ? (sessionMetrics.totalCacheRead / 1_000_000) * (pricing.input - pricing.cacheRead)
          : 0;

      const lines = [
        "▣ Anthropic Session Stats",
        "",
        `Turns: ${sessionMetrics.turns} (${elapsedMin.toFixed(0)} min)`,
        `Avg tokens/turn: ${avgPerTurn.toLocaleString()}`,
        "",
        "Tokens:",
        `  Input:       ${sessionMetrics.totalInput.toLocaleString()}`,
        `  Output:      ${sessionMetrics.totalOutput.toLocaleString()}`,
        `  Cache read:  ${sessionMetrics.totalCacheRead.toLocaleString()}`,
        `  Cache write: ${sessionMetrics.totalCacheWrite.toLocaleString()}`,
        `  Total:       ${totalTokens.toLocaleString()}`,
      ];
      if (sessionMetrics.totalWebSearchRequests > 0) {
        lines.push(`  Web searches: ${sessionMetrics.totalWebSearchRequests}`);
      }
      lines.push(
        "",
        `Cache efficiency: ${(avgRate * 100).toFixed(1)}% (last ${sessionMetrics.recentCacheRates.length} turns)`,
      );
      if (cacheSavings > 0) {
        lines.push(`Cache savings:  ~$${cacheSavings.toFixed(4)} saved vs uncached`);
      }
      lines.push(
        "",
        "Cost breakdown:",
        `  Input:       $${sessionMetrics.costBreakdown.input.toFixed(4)}`,
        `  Output:      $${sessionMetrics.costBreakdown.output.toFixed(4)}`,
        `  Cache read:  $${sessionMetrics.costBreakdown.cacheRead.toFixed(4)}`,
        `  Cache write: $${sessionMetrics.costBreakdown.cacheWrite.toFixed(4)}`,
        `  Total:       $${sessionMetrics.sessionCostUsd.toFixed(4)}`,
      );
      if (burnRate > 0) {
        lines.push(`Burn rate: $${(burnRate * 60).toFixed(2)}/hr`);
      }

      // Per-model breakdown (only show when multiple models used)
      const modelIds = Object.keys(sessionMetrics.perModel);
      if (modelIds.length > 1) {
        lines.push("", "Per-model breakdown:");
        for (const mid of modelIds) {
          const pm = sessionMetrics.perModel[mid];
          const totalTk = pm.input + pm.output + pm.cacheRead + pm.cacheWrite;
          lines.push(`  ${mid}: ${totalTk.toLocaleString()} tokens, $${pm.costUsd.toFixed(4)} (${pm.turns} turns)`);
        }
      }

      const maxBudget = parseFloat(process.env.OPENCODE_ANTHROPIC_MAX_BUDGET_USD || "0");
      if (maxBudget > 0) {
        const pct = (sessionMetrics.sessionCostUsd / maxBudget) * 100;
        const remaining = maxBudget - sessionMetrics.sessionCostUsd;
        lines.push(
          `Budget: $${sessionMetrics.sessionCostUsd.toFixed(2)} / $${maxBudget.toFixed(2)} (${pct.toFixed(0)}%)`,
        );
        if (burnRate > 0 && remaining > 0) {
          const minsLeft = remaining / burnRate;
          lines.push(
            `  Est. time remaining: ${minsLeft < 60 ? `${minsLeft.toFixed(0)} min` : `${(minsLeft / 60).toFixed(1)} hr`}`,
          );
        }
      }

      // Quota info (if available from rate-limit headers)
      if (sessionMetrics.lastQuota.updatedAt > 0) {
        const q = sessionMetrics.lastQuota;
        const q5h = q.fiveHour;
        const q7d = q.sevenDay;
        lines.push("", `Rate limit utilization:`);
        lines.push(
          `  5-hour: ${q5h.utilization.toFixed(0)}% used${q5h.status ? ` [${q5h.status}]` : ""}${q5h.resets_at ? ` (resets ${q5h.resets_at})` : ""}`,
        );
        lines.push(
          `  7-day:  ${q7d.utilization.toFixed(0)}% used${q7d.status ? ` [${q7d.status}]` : ""}${q7d.resets_at ? ` (resets ${q7d.resets_at})` : ""}`,
        );
        if (q.overallStatus)
          lines.push(
            `  Status: ${q.overallStatus}${q.representativeClaim ? ` (claim: ${q.representativeClaim})` : ""}`,
          );
        if (q.fallback)
          lines.push(
            `  Fallback: ${q.fallback}${q.fallbackPercentage != null ? ` (${(q.fallbackPercentage * 100).toFixed(0)}%)` : ""}`,
          );
        if (q.overageStatus)
          lines.push(`  Overage: ${q.overageStatus}${q.overageReason ? ` (${q.overageReason})` : ""}`);
      }

      // Token budget display (A9)
      const tb = sessionMetrics.tokenBudget;
      if (tb.limit > 0) {
        const pct = ((tb.used / tb.limit) * 100).toFixed(0);
        lines.push("", `Token budget: ${tb.used.toLocaleString()} / ${tb.limit.toLocaleString()} (${pct}%)`);
        lines.push(`  Continuations: ${tb.continuations}`);
        if (detectDiminishingReturns(tb.outputHistory)) {
          lines.push(`  Warning: Diminishing returns detected (last 3 outputs < 500 tokens)`);
        }
      }

      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }

    // /anthropic quota — show rate limit utilization
    if (primary === "quota") {
      const q = sessionMetrics.lastQuota;
      if (q.updatedAt === 0) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic Quota\n\nNo rate-limit data yet. Make at least one API request first.",
        );
        return;
      }
      const agoSec = Math.round((Date.now() - q.updatedAt) / 1000);
      const agoStr = agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`;
      const bar = (/** @type {number} */ pct) => {
        const filled = Math.max(0, Math.min(20, Math.round(pct * 20)));
        return "[" + "█".repeat(filled) + "░".repeat(20 - filled) + "]";
      };
      const q5h = q.fiveHour;
      const q7d = q.sevenDay;
      const lines = [
        "▣ Anthropic Rate Limit Quota",
        "",
        `5-hour window:`,
        `  ${bar(q5h.utilization / 100)} ${q5h.utilization.toFixed(0)}%${q5h.status ? `  [${q5h.status}]` : ""}`,
        q5h.resets_at ? `  Resets: ${q5h.resets_at}` : null,
        q5h.surpassedThreshold != null ? `  Surpassed threshold: ${(q5h.surpassedThreshold * 100).toFixed(0)}%` : null,
        "",
        `7-day window:`,
        `  ${bar(q7d.utilization / 100)} ${q7d.utilization.toFixed(0)}%${q7d.status ? `  [${q7d.status}]` : ""}`,
        q7d.resets_at ? `  Resets: ${q7d.resets_at}` : null,
        q7d.surpassedThreshold != null ? `  Surpassed threshold: ${(q7d.surpassedThreshold * 100).toFixed(0)}%` : null,
        "",
      ].filter(Boolean);

      if (q.overallStatus) {
        lines.push(
          `Overall status: ${q.overallStatus}${q.representativeClaim ? ` (claim: ${q.representativeClaim})` : ""}`,
        );
      }
      if (q.fallback) {
        lines.push(
          `Fallback: ${q.fallback}${q.fallbackPercentage != null ? ` (${(q.fallbackPercentage * 100).toFixed(0)}% capacity)` : ""}`,
        );
      }
      if (q.overageStatus) {
        lines.push(`Overage: ${q.overageStatus}${q.overageReason ? ` (${q.overageReason})` : ""}`);
      }
      lines.push("", `Last updated: ${agoStr}`);

      const maxUtil = Math.max(q5h.utilization, q7d.utilization) / 100;
      if (maxUtil >= 0.9) {
        lines.push("", "⚠ High utilization — consider slowing request rate or rotating accounts");
      } else if (maxUtil >= 0.7) {
        lines.push("", "Utilization is moderate. Consider monitoring if sustained.");
      }
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }

    // /anthropic context — show token breakdown of last request
    if (primary === "context") {
      if (!sessionMetrics.lastRequestBody) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic Context\n\nNo request captured yet. Make at least one API request first.",
        );
        return;
      }

      const analysis = analyzeRequestContext(sessionMetrics.lastRequestBody);
      const lines = [
        "▣ Anthropic Context Breakdown (estimated)",
        "",
        `System:          ${analysis.systemTokens.toLocaleString()} tokens`,
        `User messages:   ${analysis.userTokens.toLocaleString()} tokens`,
      ];

      if (analysis.toolResultTokens > 0) {
        lines.push(`  tool_result:   ${analysis.toolResultTokens.toLocaleString()} tokens`);
        const toolNames = Object.keys(analysis.toolBreakdown).sort(
          (a, b) => analysis.toolBreakdown[b].tokens - analysis.toolBreakdown[a].tokens,
        );
        for (const name of toolNames) {
          const tb = analysis.toolBreakdown[name];
          lines.push(`    ${name}: ${tb.tokens.toLocaleString()} tokens  (${tb.count} blocks)`);
        }
      }

      lines.push(`Assistant:       ${analysis.assistantTokens.toLocaleString()} tokens`);
      lines.push(`Total:           ${analysis.totalTokens.toLocaleString()} tokens`);

      if (analysis.duplicates.count > 0) {
        lines.push(
          "",
          `\u26a0 ${analysis.duplicates.count} duplicate file contents detected (~${analysis.duplicates.wastedTokens.toLocaleString()} tokens wasted)`,
        );
      }

      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }

    // /anthropic accounts — show per-account stats and health
    if (primary === "accounts") {
      if (!accountManager || accountManager.getAccountCount() === 0) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic Accounts\n\nNo accounts configured. Use /anthropic login first.",
        );
        return;
      }
      const accounts = accountManager.getEnabledAccounts();
      const lines = ["▣ Anthropic Account Stats", ""];

      for (const acc of accounts) {
        const s = acc.stats;
        const totalTok = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
        const label = acc.email || `Account #${acc.index + 1}`;
        const isActive = accountManager.getCurrentIndex?.() === acc.index || false;
        const statusBadge = isActive ? " ◄ active" : "";
        const healthScore = accountManager.getHealthScore?.(acc.index) ?? "N/A";

        // Cost estimate (use sonnet as default)
        const cost = calculateCostUsd(
          {
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheReadTokens: s.cacheReadTokens,
            cacheWriteTokens: s.cacheWriteTokens,
          },
          "claude-sonnet-4-6",
        );

        lines.push(
          `[${acc.index + 1}] ${label}${statusBadge}`,
          `  Requests: ${s.requests}  |  Tokens: ${totalTok.toLocaleString()}  |  Health: ${healthScore}`,
          `  Input: ${s.inputTokens.toLocaleString()}  Output: ${s.outputTokens.toLocaleString()}`,
          `  Cache R: ${s.cacheReadTokens.toLocaleString()}  Cache W: ${s.cacheWriteTokens.toLocaleString()}`,
          `  Est. cost: $${cost.toFixed(4)}`,
          "",
        );
      }

      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }

    // /anthropic set <key> <value> — toggle features at runtime
    if (primary === "set") {
      const key = (args[1] || "").toLowerCase();
      const value = (args[2] || "").toLowerCase();
      /** @type {Record<string, () => void>} */
      const setters = {
        emulation: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ signature_emulation: { enabled } });
          config.signature_emulation.enabled = enabled;
        },
        compaction: () => {
          const mode = value === "off" ? "off" : "minimal";
          saveConfig({ signature_emulation: { prompt_compaction: mode } });
          config.signature_emulation.prompt_compaction = mode;
        },
        "1m-context": () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ override_model_limits: { enabled } });
          if (!config.override_model_limits) config.override_model_limits = { enabled: false };
          config.override_model_limits.enabled = enabled;
        },
        "idle-refresh": () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ idle_refresh: { enabled } });
          if (!config.idle_refresh) config.idle_refresh = { enabled: false };
          config.idle_refresh.enabled = enabled;
        },
        debug: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ debug: enabled });
          config.debug = enabled;
        },
        quiet: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ toasts: { quiet: enabled } });
          config.toasts.quiet = enabled;
        },
        strategy: () => {
          const valid = ["sticky", "round-robin", "hybrid", "single"];
          if (valid.includes(value)) {
            saveConfig({ account_selection_strategy: value });
            strategyState.manualOverride = true;
            strategyState.mode = "CONFIGURED";
          } else throw new Error(`Invalid strategy. Valid: ${valid.join(", ")}`);
        },
        boundary: () => {
          const enabled = value === "on" || value === "1" || value === "true";
          saveConfig({ cache_policy: { boundary_marker: enabled } });
          if (!config.cache_policy) config.cache_policy = {};
          config.cache_policy.boundary_marker = enabled;
        },
        "cache-ttl": () => {
          const valid = ["1h", "5m", "off"];
          if (!valid.includes(value)) throw new Error(`Invalid TTL. Valid: ${valid.join(", ")}`);
          saveConfig({ cache_policy: { ttl: value } });
          if (!config.cache_policy) config.cache_policy = {};
          config.cache_policy.ttl = value;
        },
        fast: () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ fast_mode: enabled });
          config.fast_mode = enabled;
          _fastModeAppliedToast = false; // reset so next application toasts
          toast(enabled ? "⚡ Fast mode ON (Opus 4.6 only)" : "⚡ Fast mode OFF", enabled ? "info" : "success", {
            debounceKey: "fast-mode-toggle",
          }).catch(() => {});
        },
        "fast-mode": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ fast_mode: enabled });
          config.fast_mode = enabled;
          _fastModeAppliedToast = false;
          toast(enabled ? "⚡ Fast mode ON (Opus 4.6 only)" : "⚡ Fast mode OFF", enabled ? "info" : "success", {
            debounceKey: "fast-mode-toggle",
          }).catch(() => {});
        },
        telemetry: () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ telemetry: { emulate_minimal: enabled } });
          config.telemetry = config.telemetry || {};
          config.telemetry.emulate_minimal = enabled;
        },
        "telemetry-emulation": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ telemetry: { emulate_minimal: enabled } });
          config.telemetry = config.telemetry || {};
          config.telemetry.emulate_minimal = enabled;
        },
        "usage-toast": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ usage_toast: enabled });
          config.usage_toast = enabled;
        },
        "adaptive-context": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ adaptive_context: { ...config.adaptive_context, enabled } });
          if (!config.adaptive_context)
            config.adaptive_context = {
              enabled: false,
              escalation_threshold: 150_000,
              deescalation_threshold: 100_000,
            };
          config.adaptive_context.enabled = enabled;
          // Reset state when toggled off
          if (!enabled) {
            adaptiveContextState.active = false;
            adaptiveContextState.escalatedByError = false;
            adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
          }
          toast(enabled ? "⬡ Adaptive 1M context ON" : "⬡ Adaptive 1M context OFF", enabled ? "info" : "success", {
            debounceKey: "adaptive-ctx-toggle",
          }).catch(() => {});
        },
        "token-efficient-tools": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          const te = config.token_economy || {
            token_efficient_tools: true,
          };
          te.token_efficient_tools = enabled;
          saveConfig({ token_economy: te });
          config.token_economy = te;
        },
        "redact-thinking": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          const te = config.token_economy || {
            token_efficient_tools: true,
          };
          te.redact_thinking = enabled;
          saveConfig({ token_economy: te });
          config.token_economy = te;
        },
        "tool-deferral": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { tool_deferral: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.tool_deferral = enabled;
        },
        "tool-compaction": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { tool_description_compaction: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.tool_description_compaction = enabled;
        },
        "adaptive-tools": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { adaptive_tool_set: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.adaptive_tool_set = enabled;
        },
        "prompt-tailing": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          saveConfig({ token_economy_strategies: { system_prompt_tailing: enabled } });
          if (!config.token_economy_strategies) config.token_economy_strategies = {};
          config.token_economy_strategies.system_prompt_tailing = enabled;
        },
      };

      if (!key || !setters[key]) {
        const keys = Object.keys(setters).join(", ");
        await sendCommandMessage(
          input.sessionID,
          `▣ Anthropic Set\n\nUsage: /anthropic set <key> <value>\nKeys: ${keys}\nValues: on/off (or specific values for strategy/compaction)`,
        );
        return;
      }
      if (!value) {
        await sendCommandMessage(input.sessionID, `▣ Anthropic Set\n\nMissing value for "${key}".`);
        return;
      }
      setters[key]();
      // Reload config into runtime
      Object.assign(config, loadConfigFresh());
      await sendCommandMessage(input.sessionID, `▣ Anthropic Set\n\n${key} = ${value}`);
      return;
    }

    // /anthropic betas [add|remove <beta>] — show/manage custom betas
    if (primary === "betas") {
      const action = (args[1] || "").toLowerCase();

      if (!action || action === "list") {
        const fresh = loadConfigFresh();
        const strategy = fresh.account_selection_strategy || config.account_selection_strategy;
        const lines = [
          "▣ Anthropic Betas",
          "",
          "Preset betas (auto-computed per model/provider):",
          "  oauth-2025-04-20, claude-code-20250219,",
          "  advanced-tool-use-2025-11-20, fast-mode-2026-02-01,",
          "  interleaved-thinking-2025-05-14 (non-Opus 4.6) OR effort-2025-11-24 (Opus 4.6),",
          "  files-api-2025-04-14 (only /v1/files and requests with file_id),",
          "  token-counting-2024-11-01 (only /v1/messages/count_tokens),",
          `  prompt-caching-scope-2026-01-05 (non-interactive${strategy === "round-robin" ? ", skipped in round-robin" : ""})`,
          "",
          `Experimental betas: ${isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) ? "disabled (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1)" : "enabled"}`,
          `Strategy: ${strategy}${initialAccountPinned ? " (pinned via OPENCODE_ANTHROPIC_INITIAL_ACCOUNT)" : ""}`,
          `Custom betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
          "",
          "Toggleable presets:",
          "  /anthropic betas add structured-outputs-2025-12-15",
          "  /anthropic betas add context-management-2025-06-27",
          "  /anthropic betas add task-budgets-2026-03-13",
          "  /anthropic betas add web-search-2025-03-05",
          "  /anthropic betas add compact-2026-01-12",
          "  /anthropic betas add mcp-servers-2025-12-04",
          "  /anthropic betas add redact-thinking-2026-02-12",
          "  /anthropic betas add 1m   (shortcut for context-1m-2025-08-07)",
          "",
          "Remove: /anthropic betas remove <beta>",
        ];
        await sendCommandMessage(input.sessionID, lines.join("\n"));
        return;
      }

      if (action === "add") {
        const betaInput = args[2]?.trim();
        if (!betaInput) {
          await sendCommandMessage(input.sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas add <beta-name>");
          return;
        }
        const beta = resolveBetaShortcut(betaInput);
        const fresh = loadConfigFresh();
        const current = fresh.custom_betas || [];
        if (current.includes(beta)) {
          await sendCommandMessage(input.sessionID, `▣ Anthropic Betas\n\n"${beta}" already added.`);
          return;
        }
        saveConfig({ custom_betas: [...current, beta] });
        Object.assign(config, loadConfigFresh());
        const fromShortcut = beta !== betaInput;
        await sendCommandMessage(
          input.sessionID,
          `▣ Anthropic Betas\n\nAdded: ${beta}${fromShortcut ? ` (from shortcut: ${betaInput})` : ""}`,
        );
        return;
      }

      if (action === "remove" || action === "rm") {
        const betaInput = args[2]?.trim();
        if (!betaInput) {
          await sendCommandMessage(input.sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas remove <beta-name>");
          return;
        }
        const beta = resolveBetaShortcut(betaInput);
        const fresh = loadConfigFresh();
        const current = fresh.custom_betas || [];
        if (!current.includes(beta)) {
          await sendCommandMessage(input.sessionID, `▣ Anthropic Betas\n\n"${beta}" not in custom betas.`);
          return;
        }
        saveConfig({ custom_betas: current.filter((b) => b !== beta) });
        Object.assign(config, loadConfigFresh());
        await sendCommandMessage(input.sessionID, `▣ Anthropic Betas\n\nRemoved: ${beta}`);
        return;
      }

      await sendCommandMessage(input.sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas [add|remove <beta>]");
      return;
    }

    // /anthropic files [list|upload|get|delete|download] — Files API management
    // Supports --account <email|index> to target a specific account.
    // Without --account, list aggregates from ALL accounts; other actions use the current account.
    if (primary === "files") {
      // Parse --account flag from args
      let targetAccountId = null;
      const filteredArgs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--account" && i + 1 < args.length) {
          targetAccountId = args[i + 1];
          i++;
        } else {
          filteredArgs.push(args[i]);
        }
      }
      const action = (filteredArgs[1] || "").toLowerCase();

      if (!accountManager || accountManager.getAccountCount() === 0) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic Files (error)\n\nNo accounts configured. Use /anthropic login first.",
        );
        return;
      }

      /**
       * Resolve a single account by email or 1-based index.
       * If identifier is null, falls back to the current account.
       * @param {string | null} identifier
       * @returns {{ account: import('./lib/accounts.mjs').ManagedAccount, label: string } | null}
       */
      function resolveTargetAccount(identifier) {
        const accounts = accountManager.getEnabledAccounts();
        if (identifier) {
          // Try by email
          const byEmail = accounts.find((a) => a.email === identifier);
          if (byEmail) return { account: byEmail, label: byEmail.email || `Account ${byEmail.index + 1}` };
          // Try by 1-based index
          const idx = parseInt(identifier, 10);
          if (!isNaN(idx) && idx >= 1) {
            const byIdx = accounts.find((a) => a.index === idx - 1);
            if (byIdx) return { account: byIdx, label: byIdx.email || `Account ${byIdx.index + 1}` };
          }
          return null;
        }
        // Default to current
        const current = accountManager.getCurrentAccount();
        if (!current) return null;
        return { account: current, label: current.email || `Account ${current.index + 1}` };
      }

      /**
       * Get authenticated headers for a specific account, refreshing token if needed.
       * @param {import('./lib/accounts.mjs').ManagedAccount} acct
       */
      async function getFilesAuth(acct) {
        let tok = acct.access;
        if (!tok || !acct.expires || acct.expires < Date.now()) {
          tok = await refreshAccountTokenSingleFlight(acct);
        }
        return {
          authorization: `Bearer ${tok}`,
          "anthropic-beta": "oauth-2025-04-20,files-api-2025-04-14",
        };
      }

      const apiBase = "https://api.anthropic.com";

      try {
        // /anthropic files list — list uploaded files
        if (!action || action === "list") {
          if (targetAccountId) {
            // List for a specific account
            const resolved = resolveTargetAccount(targetAccountId);
            if (!resolved) {
              await sendCommandMessage(
                input.sessionID,
                `▣ Anthropic Files (error)\n\nAccount not found: ${targetAccountId}`,
              );
              return;
            }
            const { account, label } = resolved;
            const headers = await getFilesAuth(account);
            const res = await fetch(`${apiBase}/v1/files`, { headers });
            if (!res.ok) {
              const errBody = await res.text();
              await sendCommandMessage(
                input.sessionID,
                `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
              );
              return;
            }
            const data = await res.json();
            const files = data.data || [];
            for (const f of files) fileAccountMapSet(f.id, account.index);
            if (files.length === 0) {
              await sendCommandMessage(input.sessionID, `▣ Anthropic Files [${label}]\n\nNo files uploaded.`);
              return;
            }
            const lines = [`▣ Anthropic Files [${label}]`, "", `${files.length} file(s):`, ""];
            for (const f of files) {
              const sizeKB = ((f.size || 0) / 1024).toFixed(1);
              lines.push(`  ${f.id}  ${f.filename}  (${sizeKB} KB, ${f.purpose})`);
            }
            await sendCommandMessage(input.sessionID, lines.join("\n"));
            return;
          }

          // List files from ALL enabled accounts
          const accounts = accountManager.getEnabledAccounts();
          const allLines = ["▣ Anthropic Files (all accounts)", ""];
          let totalFiles = 0;
          for (const acct of accounts) {
            const label = acct.email || `Account ${acct.index + 1}`;
            try {
              const headers = await getFilesAuth(acct);
              const res = await fetch(`${apiBase}/v1/files`, { headers });
              if (!res.ok) {
                allLines.push(`[${label}] Error: HTTP ${res.status}`);
                allLines.push("");
                continue;
              }
              const data = await res.json();
              const files = data.data || [];
              for (const f of files) fileAccountMapSet(f.id, acct.index);
              totalFiles += files.length;
              if (files.length === 0) {
                allLines.push(`[${label}] No files`);
              } else {
                allLines.push(`[${label}] ${files.length} file(s):`);
                for (const f of files) {
                  const sizeKB = ((f.size || 0) / 1024).toFixed(1);
                  allLines.push(`  ${f.id}  ${f.filename}  (${sizeKB} KB, ${f.purpose})`);
                }
              }
              allLines.push("");
            } catch (err) {
              allLines.push(`[${label}] Error: ${err.message}`);
              allLines.push("");
            }
          }
          if (totalFiles === 0 && accounts.length > 0) {
            allLines.push(`Total: No files across ${accounts.length} account(s).`);
          } else {
            allLines.push(`Total: ${totalFiles} file(s) across ${accounts.length} account(s).`);
          }
          if (accounts.length > 1) {
            allLines.push("", "Tip: Use --account <email> to target a specific account.");
          }
          await sendCommandMessage(input.sessionID, allLines.join("\n"));
          return;
        }

        // For all non-list actions, resolve to a single account
        const resolved = resolveTargetAccount(targetAccountId);
        if (!resolved) {
          const errMsg = targetAccountId ? `Account not found: ${targetAccountId}` : "No accounts available.";
          await sendCommandMessage(input.sessionID, `▣ Anthropic Files (error)\n\n${errMsg}`);
          return;
        }
        const { account, label } = resolved;
        const authHeaders = await getFilesAuth(account);

        // /anthropic files upload <path> — upload a file
        if (action === "upload") {
          const filePath = filteredArgs.slice(2).join(" ").trim();
          if (!filePath) {
            await sendCommandMessage(
              input.sessionID,
              "▣ Anthropic Files\n\nUsage: /anthropic files upload <path> [--account <email>]",
            );
            return;
          }
          const resolvedPath = resolve(filePath);
          if (!existsSync(resolvedPath)) {
            await sendCommandMessage(input.sessionID, `▣ Anthropic Files (error)\n\nFile not found: ${resolvedPath}`);
            return;
          }
          const content = readFileSync(resolvedPath);
          const filename = basename(resolvedPath);
          const blob = new Blob([content]);
          const form = new FormData();
          form.append("file", blob, filename);
          form.append("purpose", "assistants");

          const res = await fetch(`${apiBase}/v1/files`, {
            method: "POST",
            headers: {
              authorization: authHeaders.authorization,
              "anthropic-beta": "oauth-2025-04-20,files-api-2025-04-14",
            },
            body: form,
          });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Files (error) [${label}]\n\nUpload failed (HTTP ${res.status}): ${errBody}`,
            );
            return;
          }
          const file = await res.json();
          const sizeKB = ((file.size || 0) / 1024).toFixed(1);
          // Cache file_id → account mapping for auto-pinning
          fileAccountMapSet(file.id, account.index);
          await sendCommandMessage(
            input.sessionID,
            `▣ Anthropic Files [${label}]\n\nUploaded: ${file.id}\n  Filename: ${file.filename}\n  Size: ${sizeKB} KB`,
          );
          return;
        }

        // /anthropic files get <file_id> — get file metadata
        if (action === "get" || action === "info") {
          const fileId = filteredArgs[2]?.trim();
          if (!fileId) {
            await sendCommandMessage(
              input.sessionID,
              "▣ Anthropic Files\n\nUsage: /anthropic files get <file_id> [--account <email>]",
            );
            return;
          }
          const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, { headers: authHeaders });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
            );
            return;
          }
          const file = await res.json();
          fileAccountMapSet(file.id, account.index);
          const lines = [
            `▣ Anthropic Files [${label}]`,
            "",
            `  ID:       ${file.id}`,
            `  Filename: ${file.filename}`,
            `  Purpose:  ${file.purpose}`,
            `  Size:     ${((file.size || 0) / 1024).toFixed(1)} KB`,
            `  Type:     ${file.mime_type || "unknown"}`,
            `  Created:  ${file.created_at || "unknown"}`,
          ];
          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }

        // /anthropic files delete <file_id> — delete a file
        if (action === "delete" || action === "rm") {
          const fileId = filteredArgs[2]?.trim();
          if (!fileId) {
            await sendCommandMessage(
              input.sessionID,
              "▣ Anthropic Files\n\nUsage: /anthropic files delete <file_id> [--account <email>]",
            );
            return;
          }
          const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, {
            method: "DELETE",
            headers: authHeaders,
          });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
            );
            return;
          }
          fileAccountMap.delete(fileId);
          await sendCommandMessage(input.sessionID, `▣ Anthropic Files [${label}]\n\nDeleted: ${fileId}`);
          return;
        }

        // /anthropic files download <file_id> [output_path] — download file content
        if (action === "download" || action === "dl") {
          const fileId = filteredArgs[2]?.trim();
          if (!fileId) {
            await sendCommandMessage(
              input.sessionID,
              "▣ Anthropic Files\n\nUsage: /anthropic files download <file_id> [output_path] [--account <email>]",
            );
            return;
          }
          const outputPath = filteredArgs.slice(3).join(" ").trim();

          // Get file metadata first for the filename
          const metaRes = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, {
            headers: authHeaders,
          });
          if (!metaRes.ok) {
            const errBody = await metaRes.text();
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Files (error) [${label}]\n\nHTTP ${metaRes.status}: ${errBody}`,
            );
            return;
          }
          const meta = await metaRes.json();
          const savePath = outputPath ? resolve(outputPath) : resolve(meta.filename);

          // Download file content
          const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}/content`, {
            headers: authHeaders,
          });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Files (error) [${label}]\n\nDownload failed (HTTP ${res.status}): ${errBody}`,
            );
            return;
          }
          const buffer = Buffer.from(await res.arrayBuffer());
          writeFileSync(savePath, buffer);
          const sizeKB = (buffer.length / 1024).toFixed(1);
          await sendCommandMessage(
            input.sessionID,
            `▣ Anthropic Files [${label}]\n\nDownloaded: ${meta.filename}\n  Saved to: ${savePath}\n  Size: ${sizeKB} KB`,
          );
          return;
        }

        // Unknown action — show help
        const helpLines = [
          "▣ Anthropic Files",
          "",
          "Usage: /anthropic files <action> [--account <email|index>]",
          "",
          "Actions:",
          "  list                          List uploaded files (all accounts if no --account)",
          "  upload <path>                 Upload a file (max 350MB)",
          "  get <file_id>                 Get file metadata",
          "  delete <file_id>              Delete a file",
          "  download <file_id> [path]     Download file content",
          "",
          "Options:",
          "  --account <email|index>       Target a specific account (1-based index)",
          "",
          "Supported formats: PDF, DOCX, TXT, CSV, Excel, Markdown, images",
          "Files can be referenced by file_id in Messages API requests.",
          "",
          "When using round-robin, file_ids are automatically pinned to the",
          "account that owns them for Messages API requests.",
        ];
        await sendCommandMessage(input.sessionID, helpLines.join("\n"));
        return;
      } catch (err) {
        await sendCommandMessage(input.sessionID, `▣ Anthropic Files (error)\n\n${err.message}`);
        return;
      }
    }

    // /anthropic review [pr <number>|branch <name>|status] — Claude Code Review (Bughunter) results
    if (primary === "review") {
      const action = (args[1] || "").toLowerCase();

      /**
       * Execute a shell command and return { stdout, stderr, code }.
       * @param {string} cmd
       * @param {string[]} cmdArgs
       * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
       */
      async function execShell(cmd, cmdArgs) {
        const { execFile } = await import("node:child_process");
        return new Promise((resolve) => {
          execFile(cmd, cmdArgs, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
              stdout: (stdout || "").trim(),
              stderr: (stderr || "").trim(),
              code: err ? err.code || 1 : 0,
            });
          });
        });
      }

      /**
       * Parse bughunter severity from check run output text.
       * @param {string} text
       * @returns {{ normal: number, nit: number, pre_existing: number } | null}
       */
      function parseBughunterSeverity(text) {
        const m = text.match(/bughunter-severity:\s*(\{[^}]+\})/);
        if (!m) return null;
        try {
          return JSON.parse(m[1]);
        } catch {
          return null;
        }
      }

      /**
       * Format a severity object into a human-readable string.
       * @param {{ normal: number, nit: number, pre_existing: number }} sev
       */
      function formatSeverity(sev) {
        const parts = [];
        if (sev.normal > 0) parts.push(`🔴 Important: ${sev.normal}`);
        if (sev.nit > 0) parts.push(`🟡 Nit: ${sev.nit}`);
        if (sev.pre_existing > 0) parts.push(`🟣 Pre-existing: ${sev.pre_existing}`);
        if (parts.length === 0) parts.push("No issues found");
        return parts.join("  |  ");
      }

      // Check gh CLI availability
      const ghCheck = await execShell("gh", ["--version"]);
      if (ghCheck.code !== 0) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic Review (error)\n\nGitHub CLI (gh) not found. Install it from https://cli.github.com/",
        );
        return;
      }

      // Detect current repo
      const repoResult = await execShell("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
      if (repoResult.code !== 0 || !repoResult.stdout) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic Review (error)\n\nCould not detect GitHub repository. Ensure you are in a git repo with a GitHub remote.",
        );
        return;
      }
      const repo = repoResult.stdout.trim();

      try {
        // /anthropic review status — check if code review is set up for this repo
        if (action === "status") {
          // Check for recent check runs named "Claude Code Review"
          const checkResult = await execShell("gh", [
            "api",
            `repos/${repo}/commits/HEAD/check-runs`,
            "--jq",
            '.check_runs[] | select(.name | test("claude|bughunter"; "i")) | .name + " — " + .status + " (" + .conclusion + ")"',
          ]);
          const lines = ["▣ Anthropic Review — Status", "", `Repository: ${repo}`, ""];
          if (checkResult.stdout) {
            lines.push("Recent Claude check runs:", checkResult.stdout);
          } else {
            lines.push(
              "No Claude Code Review check runs found on HEAD.",
              "",
              "Code Review must be enabled by an admin at claude.ai/admin-settings.",
              "It requires a Teams or Enterprise subscription.",
            );
          }
          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }

        // /anthropic review pr [<number>] — get review results for a PR
        if (!action || action === "pr") {
          const prNumber = args[2] ? parseInt(args[2], 10) : null;

          // If no PR number, find the current branch's PR
          let prRef;
          if (prNumber) {
            prRef = String(prNumber);
          } else {
            const branchResult = await execShell("git", ["branch", "--show-current"]);
            const currentBranch = branchResult.stdout.trim();
            if (!currentBranch) {
              await sendCommandMessage(
                input.sessionID,
                "▣ Anthropic Review (error)\n\nDetached HEAD — specify a PR number: /anthropic review pr <number>",
              );
              return;
            }
            // Find PR for current branch
            const prLookup = await execShell("gh", [
              "pr",
              "list",
              "--head",
              currentBranch,
              "--json",
              "number,title,state",
              "--limit",
              "1",
            ]);
            if (prLookup.code !== 0 || !prLookup.stdout || prLookup.stdout === "[]") {
              await sendCommandMessage(
                input.sessionID,
                `▣ Anthropic Review (error)\n\nNo PR found for branch "${currentBranch}".\nUse: /anthropic review pr <number>`,
              );
              return;
            }
            const prs = JSON.parse(prLookup.stdout);
            if (!prs.length) {
              await sendCommandMessage(
                input.sessionID,
                `▣ Anthropic Review (error)\n\nNo PR found for branch "${currentBranch}".`,
              );
              return;
            }
            prRef = String(prs[0].number);
          }

          // Get check runs for the PR's head SHA
          const prData = await execShell("gh", ["pr", "view", prRef, "--json", "number,title,headRefOid,state,url"]);
          if (prData.code !== 0) {
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Review (error)\n\nCould not fetch PR #${prRef}: ${prData.stderr}`,
            );
            return;
          }
          const pr = JSON.parse(prData.stdout);
          const sha = pr.headRefOid;

          // Fetch check runs for this SHA
          const checksResult = await execShell("gh", [
            "api",
            `repos/${repo}/commits/${sha}/check-runs`,
            "--jq",
            '.check_runs[] | select(.name | test("claude|bughunter"; "i"))',
          ]);

          const lines = [
            "▣ Anthropic Review",
            "",
            `PR #${pr.number}: ${pr.title}`,
            `State: ${pr.state}  |  Commit: ${sha.slice(0, 8)}`,
            `URL: ${pr.url}`,
            "",
          ];

          if (!checksResult.stdout) {
            lines.push(
              "No Claude Code Review check runs found for this PR.",
              "",
              "Possible reasons:",
              "  • Code Review not enabled for this repository",
              "  • Review still in progress (avg ~20 min)",
              "  • PR is a draft (drafts are not auto-reviewed)",
            );
            await sendCommandMessage(input.sessionID, lines.join("\n"));
            return;
          }

          // Parse all check runs (could be multiple)
          const checkRunsRaw = `[${checksResult.stdout.split("\n}\n").join("},\n")}]`
            .replace(/,\s*]$/, "]")
            .replace(/}\s*{/g, "},{");
          let checkRuns;
          try {
            checkRuns = JSON.parse(checkRunsRaw);
            if (!Array.isArray(checkRuns)) checkRuns = [checkRuns];
          } catch {
            // Single object
            try {
              checkRuns = [JSON.parse(checksResult.stdout)];
            } catch {
              lines.push(
                "Found check run(s) but could not parse output.",
                "",
                "Raw:",
                checksResult.stdout.slice(0, 500),
              );
              await sendCommandMessage(input.sessionID, lines.join("\n"));
              return;
            }
          }

          for (const run of checkRuns) {
            lines.push(`Check: ${run.name}`);
            lines.push(`  Status: ${run.status}  |  Conclusion: ${run.conclusion || "pending"}`);
            if (run.html_url) lines.push(`  Details: ${run.html_url}`);

            // Parse bughunter severity
            const outputText = run.output?.text || "";
            const severity = parseBughunterSeverity(outputText);
            if (severity) {
              lines.push(`  Findings: ${formatSeverity(severity)}`);
              const total = severity.normal + severity.nit + severity.pre_existing;
              lines.push(`  Total: ${total} issue${total !== 1 ? "s" : ""}`);
            } else if (run.status === "completed") {
              lines.push("  Findings: No bughunter-severity data in output");
            } else {
              lines.push("  Review is still in progress...");
            }
            lines.push("");
          }

          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }

        // /anthropic review branch [<name>] — find PR for branch and show review
        if (action === "branch") {
          const branchName = args[2] || (await execShell("git", ["branch", "--show-current"])).stdout.trim();
          if (!branchName) {
            await sendCommandMessage(
              input.sessionID,
              "▣ Anthropic Review (error)\n\nNo branch specified and HEAD is detached.",
            );
            return;
          }

          const prLookup = await execShell("gh", [
            "pr",
            "list",
            "--head",
            branchName,
            "--json",
            "number,title,state,headRefOid,url",
            "--limit",
            "5",
          ]);
          if (prLookup.code !== 0 || !prLookup.stdout || prLookup.stdout === "[]") {
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Review (error)\n\nNo PRs found for branch "${branchName}".`,
            );
            return;
          }
          const prs = JSON.parse(prLookup.stdout);
          if (!prs.length) {
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Review (error)\n\nNo PRs found for branch "${branchName}".`,
            );
            return;
          }

          const lines = ["▣ Anthropic Review — Branch", "", `Branch: ${branchName}`, ""];

          for (const pr of prs) {
            lines.push(`PR #${pr.number}: ${pr.title} (${pr.state})`);

            // Fetch check runs
            const checksResult = await execShell("gh", [
              "api",
              `repos/${repo}/commits/${pr.headRefOid}/check-runs`,
              "--jq",
              '.check_runs[] | select(.name | test("claude|bughunter"; "i"))',
            ]);

            if (!checksResult.stdout) {
              lines.push("  No Claude Code Review check runs found.", "");
              continue;
            }

            // Try to parse individual run
            let checkRuns;
            try {
              const raw = `[${checksResult.stdout.split("\n}\n").join("},\n")}]`
                .replace(/,\s*]$/, "]")
                .replace(/}\s*{/g, "},{");
              checkRuns = JSON.parse(raw);
              if (!Array.isArray(checkRuns)) checkRuns = [checkRuns];
            } catch {
              try {
                checkRuns = [JSON.parse(checksResult.stdout)];
              } catch {
                lines.push("  Could not parse check run output.", "");
                continue;
              }
            }

            for (const run of checkRuns) {
              lines.push(`  Check: ${run.name} — ${run.status} (${run.conclusion || "pending"})`);
              const outputText = run.output?.text || "";
              const severity = parseBughunterSeverity(outputText);
              if (severity) {
                lines.push(`  ${formatSeverity(severity)}`);
              }
            }
            lines.push("");
          }

          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }

        // /anthropic review help
        const helpLines = [
          "▣ Anthropic Review (Claude Code Review / Bughunter)",
          "",
          "Fetch and display code review results from Claude's automated PR reviewer.",
          "",
          "Usage:",
          "  /anthropic review                    Review for current branch's PR",
          "  /anthropic review pr <number>        Review for a specific PR",
          "  /anthropic review branch [<name>]    Review for PRs on a branch",
          "  /anthropic review status             Check if review is configured",
          "",
          "Severity levels:",
          "  🔴 Important — bugs that should be fixed before merge",
          "  🟡 Nit — minor issues, worth fixing but not blocking",
          "  🟣 Pre-existing — bugs in codebase not introduced by this PR",
          "",
          "Requirements:",
          "  • GitHub CLI (gh) must be installed and authenticated",
          "  • Code Review must be enabled at claude.ai/admin-settings",
          "  • Requires Teams or Enterprise subscription",
          "",
          "Machine-readable severity from check runs:",
          '  gh api repos/OWNER/REPO/check-runs/ID --jq \'.output.text | split("bughunter-severity: ")[1] | split(" -->")[0] | fromjson\'',
        ];
        await sendCommandMessage(input.sessionID, helpLines.join("\n"));
        return;
      } catch (err) {
        await sendCommandMessage(
          input.sessionID,
          `▣ Anthropic Review (error)\n\n${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
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

    // Normalize variant to values OpenCode TUI supports (success, error, info).
    // "warning" is not a supported variant and causes silent failures.
    const normalizedVariant = variant === "warning" ? "info" : variant;

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
        // QA fix M2: prune stale entries to prevent unbounded growth
        // QA fix L-debounce: use fixed 5-minute cutoff instead of config-dependent minGapMs*2
        // to avoid entries surviving longer than intended if debounce_seconds changes at runtime
        if (debouncedToastTimestamps.size > 200) {
          const cutoff = now - 300_000; // 5 minutes — generous for any realistic debounce window
          for (const [k, ts] of debouncedToastTimestamps) {
            if (ts < cutoff) debouncedToastTimestamps.delete(k);
          }
        }
      }
    }

    try {
      await client.tui?.showToast({ body: { message, variant: normalizedVariant } });
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

  function recordRateLimitForStrategy() {
    const now = Date.now();
    strategyState.rateLimitEvents.push(now);
    strategyState.lastRateLimitTime = now;

    // Prune events outside window
    const cutoff = now - strategyState.windowMs;
    strategyState.rateLimitEvents = strategyState.rateLimitEvents.filter((t) => t > cutoff);

    // Check transition to DEGRADED
    if (strategyState.mode === "CONFIGURED" && !strategyState.manualOverride) {
      if (strategyState.rateLimitEvents.length >= strategyState.thresholdCount) {
        strategyState.originalStrategy = config.account_selection_strategy;
        strategyState.mode = "DEGRADED";
        debugLog("auto-strategy: transitioning to DEGRADED mode", {
          rateLimitsInWindow: strategyState.rateLimitEvents.length,
        });
        toast("Multiple rate limits detected, temporarily rotating accounts more aggressively", "warning", {
          debounceKey: "strategy-degraded",
        }).catch(() => {});
      }
    }
  }

  function checkStrategyRecovery() {
    if (strategyState.mode !== "DEGRADED" || strategyState.manualOverride) return;

    const now = Date.now();
    if (now - strategyState.lastRateLimitTime >= strategyState.recoveryMs) {
      strategyState.mode = "CONFIGURED";
      strategyState.rateLimitEvents = [];
      debugLog("auto-strategy: recovered to CONFIGURED mode");
      toast("Rate limit pressure relieved, restoring normal account selection", "info", {
        debounceKey: "strategy-recovered",
      }).catch(() => {});
    }
  }

  function getEffectiveStrategy() {
    if (strategyState.mode === "DEGRADED") return "hybrid";
    return config.account_selection_strategy;
  }

  // Baseline CLI version, read from the wire package's profile through the
  // adapter seam. `fetchLatestClaudeCodeVersion` may raise it at runtime.
  let claudeCliVersion = WIRE_PROFILE.cliVersion;
  const signatureSessionId = randomUUID();
  const signatureUserId = getOrCreateDeviceId();
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
   * Parse refresh error details for retry/disable decisions.
   * @param {unknown} refreshError
   * @returns {{
   *   message: string,
   *   status: number,
   *   errorCode: string,
   *   retryAfterMs: number | null,
   *   retryAfterSource: string,
   *   isInvalidGrant: boolean,
   *   isTerminalStatus: boolean,
   *   isRateLimitStatus: boolean
   * }}
   */
  function parseRefreshFailure(refreshError) {
    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
    const status =
      typeof refreshError === "object" && refreshError && "status" in refreshError ? Number(refreshError.status) : NaN;
    const errorCode =
      typeof refreshError === "object" && refreshError && ("errorCode" in refreshError || "code" in refreshError)
        ? String(refreshError.errorCode || refreshError.code || "")
        : "";
    const retryAfterMs =
      typeof refreshError === "object" && refreshError && "retryAfterMs" in refreshError
        ? Number(refreshError.retryAfterMs)
        : NaN;
    const retryAfterSource =
      typeof refreshError === "object" && refreshError && "retryAfterSource" in refreshError
        ? String(refreshError.retryAfterSource || "")
        : "";
    const msgLower = message.toLowerCase();
    const isInvalidGrant =
      errorCode === "invalid_grant" || errorCode === "invalid_request" || msgLower.includes("invalid_grant");
    const isTerminalStatus = status === 400 || status === 401 || status === 403;
    const isRateLimitStatus = status === 429;
    return {
      message,
      status,
      errorCode,
      retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null,
      retryAfterSource: retryAfterSource || "unknown",
      isInvalidGrant,
      isTerminalStatus,
      isRateLimitStatus,
    };
  }

  /**
   * Refresh a specific account token with single-flight protection.
   * Prevents concurrent refresh races from disabling healthy accounts.
   * @param {import('./lib/accounts.mjs').ManagedAccount} account
   * @param {"foreground" | "idle"} [source]
   * @returns {Promise<string>}
   */
  async function refreshAccountTokenSingleFlight(account, source = "foreground") {
    const key = account.id;
    const existing = refreshInFlight.get(key);
    if (existing) {
      // Foreground requests should not directly inherit idle refresh failures.
      // Wait for idle maintenance to finish, then re-evaluate token state.
      if (source === "foreground" && existing.source === "idle") {
        try {
          await existing.promise;
        } catch {
          // Ignore idle failure here; foreground path handles refresh decisions.
        }

        if (account.access && account.expires && account.expires > Date.now()) {
          return account.access;
        }
      } else {
        return existing.promise;
      }
    }

    /** @type {{ promise: Promise<string>, source: "foreground" | "idle" }} */
    const entry = { source, promise: Promise.resolve("") };
    const p = (async () => {
      try {
        return await refreshAccountToken(account, client, source, {
          onTokensUpdated: async () => {
            try {
              await accountManager.saveToDisk();
            } catch {
              // Synchronous save failed (disk full, permissions, etc.).
              // Schedule a debounced retry so the rotated token eventually
              // reaches disk.  Another process may hit invalid_grant in the
              // interim, but its retry-from-disk logic can recover once this
              // save lands.
              accountManager.requestSaveToDisk();
              throw new Error("save failed, debounced retry scheduled");
            }
          },
        });
      } finally {
        if (refreshInFlight.get(key) === entry) {
          refreshInFlight.delete(key);
        }
      }
    })();

    entry.promise = p;
    refreshInFlight.set(key, entry);
    return p;
  }

  /**
   * Refresh one idle (non-active) account in the background.
   * Best-effort only: never disables accounts from background maintenance.
   * @param {import('./lib/accounts.mjs').ManagedAccount} account
   * @returns {Promise<void>}
   */
  async function refreshIdleAccount(account) {
    if (!accountManager) return;
    if (idleRefreshInFlight.has(account.id)) return;
    // CC-sourced accounts don't use OAuth idle refresh
    if (account.source === "cc-keychain" || account.source === "cc-file") return;

    idleRefreshInFlight.add(account.id);
    const attemptedRefreshToken = account.refreshToken;

    try {
      try {
        await refreshAccountTokenSingleFlight(account, "idle");
        return;
      } catch (err) {
        let details = parseRefreshFailure(err);

        if (!(details.isInvalidGrant || details.isTerminalStatus)) {
          debugLog("idle refresh skipped after transient failure", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message,
          });
          return;
        }

        const diskAuth = await readDiskAccountAuth(account.id);
        const retryToken = diskAuth?.refreshToken;
        if (retryToken && retryToken !== attemptedRefreshToken && account.refreshToken === attemptedRefreshToken) {
          account.refreshToken = retryToken;
          if (diskAuth?.tokenUpdatedAt) {
            account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
          } else {
            markTokenStateUpdated(account);
          }
        }

        try {
          await refreshAccountTokenSingleFlight(account, "idle");
          return;
        } catch (retryErr) {
          details = parseRefreshFailure(retryErr);
          debugLog("idle refresh retry failed", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message,
          });
          return;
        }
      }
    } finally {
      idleRefreshInFlight.delete(account.id);
    }
  }

  /**
   * Opportunistically refresh one near-expiry idle account in background.
   * Runs during normal requests so inactive accounts stay healthy.
   * @param {import('./lib/accounts.mjs').ManagedAccount} activeAccount
   */
  function maybeRefreshIdleAccounts(activeAccount) {
    if (!getIdleRefreshEnabled() || !accountManager) return;

    const now = Date.now();
    const excluded = new Set([activeAccount.index]);
    const candidates = accountManager
      .getEnabledAccounts(excluded)
      .filter((acc) => !acc.expires || acc.expires <= now + getIdleRefreshWindowMs())
      .filter((acc) => {
        const last = idleRefreshLastAttempt.get(acc.id) ?? 0;
        return now - last >= getIdleRefreshMinIntervalMs();
      })
      .sort((a, b) => (a.expires ?? 0) - (b.expires ?? 0));

    const target = candidates[0];
    if (!target) return;

    idleRefreshLastAttempt.set(target.id, now);
    // QA fix L5: prune stale entries for accounts that no longer exist
    const allKnown = accountManager.getAccountsSnapshot();
    if (idleRefreshLastAttempt.size > allKnown.length + 10) {
      const validIds = new Set(allKnown.map((a) => a.id));
      for (const key of idleRefreshLastAttempt.keys()) {
        if (!validIds.has(key)) idleRefreshLastAttempt.delete(key);
      }
    }
    void refreshIdleAccount(target);
  }

  return {
    // A1-A4: System prompt transform (unchanged)
    "experimental.chat.system.transform": (input, output) => {
      const prefix = CLAUDE_CODE_IDENTITY_STRING;
      if (!getSignatureEmulationEnabled() && input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        // QA fix H7: handle object-format system blocks (e.g. {type:"text", text:"..."})
        if (output.system[1]) {
          if (typeof output.system[1] === "string") {
            output.system[1] = prefix + "\n\n" + output.system[1];
          } else if (output.system[1] && typeof output.system[1] === "object" && output.system[1].text) {
            output.system[1] = { ...output.system[1], text: prefix + "\n\n" + output.system[1].text };
          }
        }
      }
    },
    config: async (input) => {
      // OpenCode v1.x: input is a Config object with optional command property
      if (!input.command) input.command = {};
      input.command["anthropic"] = {
        template: "/anthropic",
        description: "Manage Anthropic auth, config, betas, review (usage, login, config, set, betas, review, switch)",
      };
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "anthropic") return;

      // Signal that this command is fully handled by the plugin —
      // do NOT forward it to the agent for further processing.
      output.noReply = true;

      try {
        await handleAnthropicSlashCommand(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sendCommandMessage(input.sessionID, `▣ Anthropic (error)\n\n${message}`);
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          // B1-B2: Zero out cost for max plan and optionally override context limits.
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            };

            // Override context limits for 1M-window models so OpenCode
            // triggers compaction at the right threshold instead of relying
            // on potentially stale models.dev data.
            if (
              config.override_model_limits.enabled &&
              !isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT) &&
              (hasOneMillionContext(model.id) ||
                isOpus46Model(model.id) ||
                isOpus47Model(model.id) ||
                isOpus48Model(model.id))
            ) {
              model.limit = {
                ...(model.limit ?? {}),
                context: config.override_model_limits.context,
                ...(config.override_model_limits.output > 0 ? { output: config.override_model_limits.output } : {}),
              };
            }
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

          // OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: pin this session to a specific account.
          // Accepts 1-based index or email. Overrides strategy to sticky and disables
          // syncActiveIndexFromDisk so other sessions can't override this one.
          // Use case: terminal 1 with INITIAL_ACCOUNT=1, terminal 2 with =2.
          const initialAccountEnv = process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT?.trim();
          if (initialAccountEnv && accountManager.getAccountCount() > 1) {
            const accounts = accountManager.getEnabledAccounts();
            let target = null;

            // Try as 1-based index (use logical index, not array position — QA fix H5)
            const asIndex = parseInt(initialAccountEnv, 10);
            if (!isNaN(asIndex) && asIndex >= 1) {
              target = accounts.find((a) => a.index === asIndex - 1) ?? null;
            }

            // Try as email
            if (!target) {
              target = accounts.find((a) => a.email && a.email.toLowerCase() === initialAccountEnv.toLowerCase());
            }

            if (target && accountManager.forceCurrentIndex(target.index)) {
              config.account_selection_strategy = "sticky";
              initialAccountPinned = true;
              debugLog("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: pinned to account", {
                index: target.index + 1,
                email: target.email,
                strategy: "sticky (overridden)",
              });
            } else {
              debugLog("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: could not resolve account", initialAccountEnv);
            }
          }

          // Initialize telemetry emitter
          const telemetryEnabled =
            config.telemetry?.emulate_minimal || isTruthyEnv(process.env.OPENCODE_ANTHROPIC_TELEMETRY_EMULATE);
          const firstAccount = accountManager.getEnabledAccounts()[0];
          telemetryEmitter.init({
            enabled: telemetryEnabled,
            deviceId: getOrCreateDeviceId(),
            cliVersion: claudeCliVersion,
            accountUuid: getAccountIdentifier(firstAccount),
            orgUuid: process.env.CLAUDE_CODE_ORGANIZATION_UUID || "",
            sessionId: signatureSessionId,
          });

          // Pre-warm TCP+TLS connection to Anthropic API (fire-and-forget)
          preconnectApi(config);

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
              // The emulation flag decides whether the URL may be reshaped at
              // all (`?beta=true`, `/messages` -> `/v1/messages`). Read here,
              // live, because `/anthropic set` can flip it between requests.
              const { requestInput, requestUrl } = transformRequestUrl(input, getSignatureEmulationEnabled());

              // A host may hand us a `Request` carrying the body, with the init
              // empty — `fetchFn(new Request(url, {body}), {})`. Every body-aware
              // stage downstream (`_parsedBodyOnce`, `transformRequestBody`, the
              // adapter, the retry-loop rewrites) reads `requestInit.body` and
              // would silently see nothing, so the body is lifted onto the init
              // once, here. `clone()` keeps the original Request readable, which
              // matters because `requestInput` is still what gets sent when no
              // adapter URL is adopted.
              if (requestInit.body == null && input instanceof Request && input.body != null) {
                try {
                  requestInit.body = await input.clone().text();
                } catch (error) {
                  debugLog(`could not read the body off the host Request: ${error.message}`);
                }
              }
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
              // Skip when OPENCODE_ANTHROPIC_INITIAL_ACCOUNT pinned this session —
              // other sessions' CLI changes must not override the pinned account.
              if (accountManager && !initialAccountPinned) {
                await accountManager.syncActiveIndexFromDisk();
              }

              // QA fix L-oauthPrune: periodically prune expired pending OAuth flows on API requests
              // (throttled to at most once per 60 seconds) to avoid PKCE verifiers living in memory indefinitely.
              {
                const _now = Date.now();
                if (_now - _lastOAuthPruneTime > 60_000) {
                  _lastOAuthPruneTime = _now;
                  pruneExpiredPendingOAuth();
                }
              }

              // Willow Mode: if the session has been idle for longer than the
              // configured threshold and has enough turns, show a gentle toast
              // suggesting the user consider starting a fresh context.
              if (getWillowEnabled() && showUsageToast) {
                const now = Date.now();
                const idleMs = now - willowLastRequestTime;
                const cooldownOk = now - willowLastSuggestionTime >= getWillowCooldownMs();
                if (idleMs >= getWillowIdleThresholdMs() && cooldownOk && sessionMetrics.turns >= getWillowMinTurns()) {
                  const idleMin = Math.round(idleMs / 60_000);
                  willowLastSuggestionTime = now;
                  toast(
                    `🌿 Idle for ${idleMin}m with ${sessionMetrics.turns} turns of context. Consider /clear for a fresh start.`,
                    "info",
                    { debounceKey: "willow-idle" },
                  ).catch(() => {});
                  debugLog("willow mode: idle return detected", { idleMin, turns: sessionMetrics.turns });
                }
                willowLastRequestTime = now;
              }

              // Try each account at most once. If the error is account-specific,
              // switch to the next account. If it's service-wide, return immediately.
              // QA fix M9: use enabled account count, not total (disabled accounts can't serve requests)
              const maxAttempts = Math.max(1, accountManager.getAccountCount());

              // File-ID account pinning: if the request body references file_ids
              // that we've mapped to a specific account (via /anthropic files),
              // pin the first attempt to that account so files are accessible.
              // Without this, round-robin could route to an account that doesn't
              // have the referenced files, causing file_not_found errors.
              // Parse body ONCE before the retry loop and reuse for all downstream logic.
              // This eliminates 4-5 redundant JSON.parse calls per turn (file pinning,
              // parseRequestBodyMetadata, adaptive context, toast, microcompact).
              let _parsedBodyOnce = null;
              if (typeof requestInit.body === "string") {
                try {
                  _parsedBodyOnce = JSON.parse(requestInit.body);
                } catch {
                  // Non-JSON body — downstream code handles gracefully
                }
              }

              let pinnedAccount = null;
              if (_parsedBodyOnce && fileAccountMap.size > 0) {
                const fileIds = extractFileIds(_parsedBodyOnce);
                for (const fid of fileIds) {
                  const pinnedIndex = fileAccountMap.get(fid);
                  if (pinnedIndex !== undefined) {
                    const candidates = accountManager.getEnabledAccounts();
                    pinnedAccount = candidates.find((a) => a.index === pinnedIndex) ?? null;
                    if (pinnedAccount) {
                      debugLog("file-id pinning: routing to account", {
                        fileId: fid,
                        accountIndex: pinnedIndex,
                        email: pinnedAccount.email,
                      });
                      break;
                    }
                  }
                }
              }

              let serviceWideRetryCount = 0; // Track 529/503 retries (max 2 per RE doc §5.5)
              let shouldRetryCount = 0; // Track x-should-retry forced retries (cap at 3)
              let consecutive529Count = 0;
              let fastFallbackCount = 0; // Track fast->standard same-account fallbacks (cap below)
              // Classify request for retry budget (A8)
              const requestClass =
                config.request_classification?.enabled !== false ? classifyApiRequest(requestInit.body) : "foreground";
              const maxServiceRetries =
                requestClass === "background"
                  ? (config.request_classification?.background_max_service_retries ?? 0)
                  : SERVICE_WIDE_MAX_RETRIES;
              const maxShouldRetries =
                requestClass === "background" ? (config.request_classification?.background_max_should_retries ?? 1) : 3;
              let _adaptiveDecisionMade = false; // Ensure adaptive context decision is made only once per logical request
              let _adaptiveOverrideForRequest; // Cached adaptive override for all retry attempts
              let _overloadRecoveryAttempted = false; // Guard: only one quota-aware switch per request
              let _connectionResetRetries = 0; // Cap ECONNRESET/EPIPE retries to prevent infinite loop
              let customBetasStripped = false; // One-shot latch: strip config.custom_betas once per logical request
              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                // Select account — use pinned account on first attempt if available
                const account =
                  attempt === 0 && pinnedAccount && !transientRefreshSkips.has(pinnedAccount.index)
                    ? pinnedAccount
                    : accountManager.getCurrentAccount(transientRefreshSkips);

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
                  // All accounts excluded (transient refresh failures) — give up.
                  // Diagnostic: surface WHICH accounts were skipped and why, so the
                  // "No available account" symptom is debuggable (e.g. it can be a
                  // downstream effect of an OAuth refresh failure, not a true
                  // exhaustion). transientRefreshSkips holds account indices that
                  // failed/were-rate-limited during refresh this request.
                  debugLog("No available account — all candidates transiently skipped", {
                    enabledCount,
                    transientRefreshSkips: Array.from(transientRefreshSkips),
                    attempt,
                  });
                  throw new Error("No available Anthropic account for request.");
                }

                // Determine access token
                let accessToken;
                // Per-account token refresh
                // Refresh 5 minutes before expiry to avoid mid-request token expiration (RE doc §1.10)
                if (!account.access || !account.expires || account.expires < Date.now() + 300_000) {
                  const attemptedRefreshToken = account.refreshToken;
                  try {
                    accessToken = await refreshAccountTokenSingleFlight(account);
                    // Tokens are now saved under the refresh lock (inside
                    // refreshAccountToken) so no debounced save needed here.
                  } catch (err) {
                    // Token refresh failed — check if another instance rotated the
                    // refresh token and persisted it between attempts.
                    let finalError = err;
                    let details = parseRefreshFailure(err);

                    // Belt-and-suspenders retry: on terminal/invalid_grant failures,
                    // always re-read disk token and retry once before disabling.
                    if (details.isInvalidGrant || details.isTerminalStatus) {
                      const diskAuth = await readDiskAccountAuth(account.id);
                      const retryToken = diskAuth?.refreshToken;
                      if (
                        retryToken &&
                        retryToken !== attemptedRefreshToken &&
                        account.refreshToken === attemptedRefreshToken
                      ) {
                        debugLog("refresh token on disk differs from in-memory, retrying with disk token", {
                          accountIndex: account.index,
                        });
                        account.refreshToken = retryToken;
                        if (diskAuth?.tokenUpdatedAt) {
                          account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
                        } else {
                          markTokenStateUpdated(account);
                        }
                      } else if (retryToken && retryToken !== attemptedRefreshToken) {
                        debugLog("skipping disk token adoption because in-memory token already changed", {
                          accountIndex: account.index,
                        });
                      }

                      try {
                        accessToken = await refreshAccountTokenSingleFlight(account);
                      } catch (retryErr) {
                        finalError = retryErr;
                        details = parseRefreshFailure(retryErr);
                        debugLog("retry refresh failed", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message,
                        });
                      }
                    }

                    if (!accessToken) {
                      if (details.isRateLimitStatus) {
                        const backoffMs = accountManager.markRateLimited(
                          account,
                          "RATE_LIMIT_EXCEEDED",
                          details.retryAfterMs,
                        );
                        debugLog("oauth refresh rate limited", {
                          accountIndex: account.index,
                          retryAfterMs: details.retryAfterMs,
                          retryAfterSource: details.retryAfterSource,
                        });
                        transientRefreshSkips.add(account.index);
                        const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                        await toast(
                          `${name} OAuth refresh rate-limited; pausing ${Math.ceil(backoffMs / 1000)}s`,
                          "warning",
                        );
                      } else {
                        accountManager.markFailure(account);
                      }

                      if (details.isInvalidGrant || details.isTerminalStatus) {
                        const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                        debugLog("disabling account after terminal refresh failure", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message,
                        });
                        account.enabled = false;
                        accountManager.requestSaveToDisk();
                        const statusLabel = Number.isFinite(details.status)
                          ? `HTTP ${details.status}`
                          : "unknown status";
                        await toast(
                          `Disabled ${name} (token refresh failed: ${details.errorCode || statusLabel})`,
                          "error",
                        );
                      } else if (!details.isRateLimitStatus) {
                        // Skip this account for the remainder of this request.
                        transientRefreshSkips.add(account.index);
                      }
                      lastError = finalError;
                      continue; // Try next account
                    }
                  }
                } else {
                  accessToken = account.access;
                }

                // Store live token for exit telemetry
                if (accessToken) liveTokenRef.token = accessToken;

                // Keep non-active accounts warm without blocking the request.
                maybeRefreshIdleAccounts(account);

                // Pre-compute the beta header so it can be injected into both the
                // request body (betas field) and the anthropic-beta header.
                // Reuse _parsedBodyOnce to avoid redundant JSON.parse.
                const { model: _reqModel, hasFileReferences: _reqHasFileRefs } = parseRequestBodyMetadata(
                  requestInit.body,
                  _parsedBodyOnce,
                );

                // --- Adaptive 1M context decision (once per logical request, not per retry) ---
                if (!_adaptiveDecisionMade) {
                  _adaptiveDecisionMade = true;
                  const _prevAdaptiveState = adaptiveContextState.active;
                  const _use1MContext = resolveAdaptiveContext(
                    requestInit.body,
                    _reqModel,
                    config.adaptive_context || {
                      enabled: true,
                      escalation_threshold: 150_000,
                      deescalation_threshold: 100_000,
                    },
                    _parsedBodyOnce,
                  );
                  // Emit visual cue on state transitions (only when adaptive mode is on)
                  if (config.adaptive_context?.enabled && _prevAdaptiveState !== adaptiveContextState.active) {
                    const label = adaptiveContextState.active ? "1M context ON" : "1M context OFF";
                    const variant = adaptiveContextState.active ? "info" : "success";
                    const est = _parsedBodyOnce
                      ? estimatePromptTokensFromParsed(_parsedBodyOnce)
                      : estimatePromptTokens(requestInit.body);
                    toast(`⬡ ${label} (est. ${Math.round(est / 1000)}K tokens)`, variant, {
                      debounceKey: "adaptive-ctx",
                    }).catch(() => {});
                  }
                  _adaptiveOverrideForRequest = config.adaptive_context?.enabled
                    ? { use1MContext: _use1MContext }
                    : undefined;
                }

                const _adaptiveOverride = _adaptiveOverrideForRequest;

                // Token economy config (resolved once, passed to beta builder).
                // Also classify the request role (CC's querySource analog).
                const _requestRole = classifyRequestRole(_parsedBodyOnce);
                // opencode tags subagent requests with the x-parent-session-id header
                // (set in its request builder only when a parent session exists).
                // This is a reliable subagent signal; body-shape classification alone
                // sees subagents as "main" (real messages + large max_tokens). Used
                // only to pick the cheaper 5m cache tier for one-shot subagents.
                const _isSubagent = getIncomingHeader(input, requestInit, "x-parent-session-id") != null;
                const _baseTE = config.token_economy || {};
                const _tokenEconomy = { ..._baseTE, __requestRole: _requestRole };

                // Microcompact: inject clear betas at high context utilization
                let _microcompactBetas = null;
                if (requestInit.body) {
                  const estimatedTokens = _parsedBodyOnce
                    ? estimatePromptTokensFromParsed(_parsedBodyOnce)
                    : estimatePromptTokens(requestInit.body);
                  if (shouldMicrocompact(estimatedTokens, config)) {
                    _microcompactBetas = buildMicrocompactBetas();
                    if (!microcompactState.active) {
                      microcompactState.active = true;
                      microcompactState.lastActivatedTurn = sessionMetrics.turns;
                      toast(`Microcompact activated at ~${Math.round(estimatedTokens / 1000)}K tokens`, "info", {
                        debounceKey: "microcompact",
                      }).catch(() => {});
                    }
                  } else if (microcompactState.active) {
                    // Deactivate if tokens dropped below threshold
                    microcompactState.active = false;
                  }
                }

                // F4: filter out session-rejected custom betas before building the header.
                // This means the second+ request in the same plugin instance already omits
                // a rejected beta without needing to pay a first-fail again.
                const _sessionFilteredCustomBetas = customBetasStripped
                  ? []
                  : (config.custom_betas ?? []).filter((b) => {
                      const canonical = resolveBetaShortcut(b);
                      const rejectedAt = sessionRejectedBetas.get(canonical);
                      if (rejectedAt == null) return true;
                      if (Date.now() - rejectedAt > SESSION_REJECTED_BETA_TTL_MS) {
                        sessionRejectedBetas.delete(canonical);
                        return true;
                      }
                      return false;
                    });
                // PHASE 2.2.3 — THE BETA LATCH IS GONE. It used to merge every
                // beta ever sent this session back into this value, to avoid
                // server-side cache-key churn from a beta flipping mid-session.
                // It was INERT on both live paths: `buildRequestHeaders`
                // recomputes its own `mergedBetas` from the incoming header, and
                // the adapter has the package compose the list from
                // `customBetas`. Neither ever read the latched value, so the only
                // thing it reached was the `task-budgets-2026-03-13` check in
                // `transformRequestBody` below.
                //
                // The two evictions the latch carried are not lost: both act on
                // `_sessionFilteredCustomBetas` above, BEFORE the header is
                // composed — `customBetasStripped` empties the custom set, and
                // `sessionRejectedBetas` filters the individual betas the API
                // rejected. That is the mechanism that actually reaches the wire.
                const computedBetaHeader = buildAnthropicBetaHeader(
                  "",
                  getSignatureEmulationEnabled(),
                  _reqModel,
                  _sessionFilteredCustomBetas,
                  getEffectiveStrategy(),
                  requestUrl?.pathname,
                  _reqHasFileRefs,
                  _adaptiveOverride,
                  _tokenEconomy,
                  _microcompactBetas, // NEW
                );

                // Cache TTL session latching: latch the cache policy at session start
                // so mid-session toggles don't bust the server-side prompt cache.
                if (!sessionCachePolicyLatched) {
                  sessionCachePolicyLatched = true;
                  latchedCachePolicy = config.cache_policy
                    ? { ...config.cache_policy }
                    : { ttl: "1h", ttl_supported: true };
                }
                const effectiveCachePolicy = latchedCachePolicy ||
                  config.cache_policy || { ttl: "1h", ttl_supported: true };

                // Single decision point for the whole request: does this turn go
                // through the shared wire package?
                //
                // PHASE 2.2 — THE ADAPTER IS UNCONDITIONAL. Two conditions, and
                // neither of them is about the body any more:
                //  1. signature emulation on — with it off the plugin does not
                //     forge a Claude Code fingerprint at all, so there is
                //     nothing for the package to build;
                //  2. a messages endpoint the package has a surface for:
                //     `buildClaudeCodeRequest` for /v1/messages and
                //     `buildClaudeCodeCountTokensRequest` for
                //     /v1/messages/count_tokens, each pinning its OWN endpoint.
                //
                // The former first-party check is now structural: the plugin only
                // speaks to first-party Anthropic, so it is always satisfied.
                //
                // THE BODY IS NO LONGER A ROUTING INPUT. It used to be: a
                // bodiless or unparsable body silently fell back to the legacy
                // forge, which put a REQUEST WITH A DIFFERENT FINGERPRINT on the
                // wire mid-session. That dual path is what this phase removes.
                // A body the package cannot consume is now a hard error
                // (`assertAdapterBodyUsable`), never a quiet downgrade.
                // Endpoints outside the set above still pass through untouched.
                const _adapterPathname = requestUrl?.pathname;
                const _isCountTokens = ADAPTER_COUNT_TOKENS_PATHNAMES.has(_adapterPathname);
                // Read ONCE per attempt. The config is runtime-mutable
                // (`/anthropic set`), and a flip between the routing decision,
                // the body transform and the header construction would emit a
                // half-emulated request.
                const _emulationEnabled = getSignatureEmulationEnabled();
                const _useAdapter =
                  _emulationEnabled && (ADAPTER_MESSAGES_PATHNAMES.has(_adapterPathname) || _isCountTokens);
                if (_useAdapter) {
                  // Validated against the INCOMING body, before transformRequestBody
                  // gets a chance to normalize it: the diagnostic has to name what
                  // the host actually sent. `_parsedBodyOnce` is not usable as the
                  // signal — the retry paths below null it out after rewriting a
                  // perfectly valid body.
                  assertAdapterBodyUsable(requestInit.body, _adapterPathname);
                }

                // PHASE 2.2 — EMULATION OFF DOES NOT TRANSFORM THE BODY AT ALL.
                // `transformRequestBody` used to run on every request and apply
                // its non-gated structural normalizations (output cap, thinking,
                // effort -> output_config, system sanitize/compact) even with
                // emulation off. That is policy the host never asked for. The
                // only exceptions are the fields the first-party API rejects
                // outright (`betas`, the stainless-helper markers) — see
                // stripNonApiBodyFields.
                const body = !_emulationEnabled
                  ? stripNonApiBodyFields(requestInit.body)
                  : transformRequestBody(
                      requestInit.body,
                      {
                        enabled: _emulationEnabled,
                        claudeCliVersion,
                        promptCompactionMode: getPromptCompactionMode(),
                        useAdapter: _useAdapter,
                        cachePolicy: effectiveCachePolicy,
                        fastMode: config.fast_mode || false,
                        // When the account's fast pool is cooling down, suppress
                        // speed:"fast" so this turn runs at standard speed on the same
                        // account instead of re-hitting the exhausted fast pool.
                        fastRateLimited: accountManager.isFastRateLimited(account),
                        strategy: getEffectiveStrategy(),
                        toolDeferral: config.token_economy_strategies?.tool_deferral,
                        toolDescriptionCompaction: config.token_economy_strategies?.tool_description_compaction,
                        adaptiveToolSet: config.token_economy_strategies?.adaptive_tool_set,
                        systemPromptTailing: config.token_economy_strategies?.system_prompt_tailing,
                        systemPromptTailTurns: config.token_economy_strategies?.system_prompt_tail_turns,
                        systemPromptTailMaxChars: config.token_economy_strategies?.system_prompt_tail_max_chars,
                      },
                      {
                        persistentUserId: signatureUserId,
                        sessionId: signatureSessionId,
                        accountId: getAccountIdentifier(account),
                        turns: sessionMetrics.turns,
                        usedTools: sessionMetrics.usedTools,
                        tokenEconomySession,
                        requestRole: _requestRole,
                        isSubagent: _isSubagent,
                        // Adaptive cache-breakpoint placement: pass the per-boundary
                        // stability snapshot so transformRequestBody can anchor the
                        // cache_control marker on the most-stable boundary instead of
                        // the (possibly thrashing) last tool. Only populated once the
                        // detector is enabled and has a baseline.
                        cacheBoundaryStability: config.cache_break_detection?.adaptive_breakpoint
                          ? cacheBreakState.boundaryStability
                          : null,
                      },
                      computedBetaHeader,
                      config,
                    );
                logTransformedSystemPrompt(body);

                // Toast on first fast-mode application in session (reset on toggle)
                if (!_fastModeAppliedToast && typeof body === "string" && body.includes('"speed":"fast"')) {
                  _fastModeAppliedToast = true;
                  toast("⚡ Fast mode active", "info", { debounceKey: "fast-mode-active" }).catch(() => {});
                }

                // Capture request body for /anthropic context (2MB cap)
                if (typeof body === "string" && body.length <= 2_000_000) {
                  sessionMetrics.lastRequestBody = body;
                } else if (typeof body === "string") {
                  sessionMetrics.lastRequestBody = body.slice(0, 2_000_000);
                }

                // Pre-call: extract cache source hashes for cache break detection
                if (config.cache_break_detection?.enabled && typeof body === "string") {
                  const currentHashes = extractCacheSourceHashes(body);
                  if (currentHashes.size > 0) {
                    // Update per-boundary structural stability BEFORE staging the
                    // new hashes, diffing against the prior turn's baseline. This
                    // feeds the adaptive breakpoint placer on the NEXT turn.
                    if (cacheBreakState.sourceHashes.size > 0) {
                      updateBoundaryStability(
                        currentHashes,
                        cacheBreakState.sourceHashes,
                        cacheBreakState.boundaryStability,
                      );
                    }
                    cacheBreakState._pendingHashes = currentHashes;
                  }
                }

                // Build headers with the selected account's token.
                //
                // Adapter path: the shared package composes the headers AND
                // rebuilds the body (canonical system prefix, metadata, beta
                // header). On the count-tokens surface it composes headers and a
                // body that deliberately carries NO system, metadata or
                // max_tokens. Legacy path: unchanged, byte for byte.
                //
                // The URL is assembled from BOTH sources: origin from the host,
                // path and query from the package. `built.url` is the pinned
                // endpoint the headers and body were composed for
                // (`https://api.anthropic.com/v1/messages?beta=true`, or
                // `.../v1/messages/count_tokens?beta=true` on the count surface),
                // so the package stays the owner of the envelope — canonical path
                // plus `?beta=true` — and cannot drift from the body it built.
                // The ORIGIN, though, belongs to whoever the host addressed: a
                // custom provider baseURL (gateway, LiteLLM, corporate proxy)
                // arrives on `requestUrl`, and so does OPENCODE_MITM_BASE_URL,
                // which transformRequestUrl already applied. Taking the package's
                // origin as well would silently redirect those deployments to
                // api.anthropic.com.
                //
                // No gateway path PREFIX can be lost this way: the `_useAdapter`
                // gate only admits pathnames in {/v1/messages, /messages,
                // /v1/messages/count_tokens, /messages/count_tokens}, so a
                // prefixed endpoint never reaches the adapter in the first place.
                //
                // transformRequestUrl still owns the URL outright on the legacy /
                // emulation-off path.
                const _adapterSignature = {
                  enabled: getSignatureEmulationEnabled(),
                  claudeCliVersion,
                  customBetas: _sessionFilteredCustomBetas,
                  strategy: getEffectiveStrategy(),
                  sessionId: signatureSessionId,
                };

                let requestHeaders;
                let adapterBody;
                let adapterRequestInput;
                let legacyStrippedBody;
                if (_useAdapter) {
                  const _adapterResult = buildAdapterTransport({
                    input,
                    requestInit,
                    accessToken,
                    requestUrl,
                    provider: "anthropic",
                    clientRequestId: randomUUID(),
                    signature: _adapterSignature,
                    identity: {
                      persistentUserId: signatureUserId,
                      accountId: getAccountIdentifier(account),
                    },
                    adaptiveOverride: _adaptiveOverride,
                    tokenEconomy: _tokenEconomy,
                    // Role inputs for the identity-block cache ttl: the adapter
                    // re-runs the same resolveCacheTtl the body transform used,
                    // so system[1] cannot carry a ttl the rest of the request
                    // does not.
                    cachePolicy: effectiveCachePolicy,
                    requestRole: _requestRole,
                    isSubagent: _isSubagent,
                    // Derived from the PRE-transform body on purpose: the lean
                    // gate in buildSystemPromptBlocks tests the incoming system
                    // blocks, and by now the title-generator swap has already
                    // rewritten them in `body`.
                    isTitleGenerator: _parsedBodyOnce
                      ? isTitleGeneratorSystemBlocks(normalizeSystemTextBlocks(_parsedBodyOnce.system))
                      : false,
                    body,
                    env: resolveAdapterEnv(process.env),
                    platform: process.platform,
                    arch: process.arch,
                    nodeVersion: process.version,
                  });
                  if (_adapterResult.applicable) {
                    // Two package surfaces, one transport: the count-tokens
                    // builder consumes a strict subset of the same input, so the
                    // transport object needs no count-specific mode.
                    const built = _isCountTokens
                      ? await buildWireCompatibleCountTokensRequest(body, _adapterResult.transport)
                      : await buildWireCompatibleRequest(body, _adapterResult.transport);
                    requestHeaders = built.headers;
                    adapterBody = built.body;
                    try {
                      // Origin from the HOST, path+query from the PACKAGE.
                      // `requestUrl` already carries the provider's configured
                      // baseURL and already had OPENCODE_MITM_BASE_URL applied by
                      // transformRequestUrl, so copying its origin is what keeps a
                      // gateway / LiteLLM / proxy deployment reachable. With no
                      // usable `requestUrl` the package's own origin stands.
                      const _adapterUrl = new URL(built.url);
                      if (requestUrl) {
                        _adapterUrl.protocol = requestUrl.protocol;
                        _adapterUrl.hostname = requestUrl.hostname;
                        _adapterUrl.port = requestUrl.port;
                      }
                      adapterRequestInput =
                        input instanceof Request ? new Request(_adapterUrl.toString(), input) : _adapterUrl;
                    } catch (error) {
                      // Unparsable package URL — fall back to the transformed URL.
                      debugLog(`adapter url adoption skipped (${error.message}); keeping the transformed url`);
                    }
                  } else {
                    // Unreachable by construction, and it must STAY unreachable:
                    // `buildAdapterTransport` declines on exactly two conditions,
                    // a non-anthropic provider and signature emulation off, and
                    // the call site above pins `provider: "anthropic"` while
                    // `_useAdapter` already required emulation on. Falling back to
                    // the legacy forge here would silently restore the dual path
                    // Phase 2.2 removed, so a decline is an error instead.
                    throw new Error(
                      `opencode-anthropic-fix: the Claude Code wire adapter declined a request it must handle ` +
                        `(${_adapterResult.reason}) on ${_adapterPathname}. This is a plugin bug — ` +
                        `the legacy request path is no longer reachable with signature emulation on.`,
                    );
                  }
                }

                if (!requestHeaders && !_emulationEnabled) {
                  // PHASE 2.2 — EMULATION OFF IS PURE PASSTHROUGH PLUS THE AUTH
                  // ENVELOPE. No mimicry function composes these headers: the
                  // host's set goes out as it arrived, minus the two credentials
                  // that must not travel with our bearer, plus `authorization`
                  // and an ADDITIVE `oauth-2025-04-20`. The forged claude-cli
                  // user-agent and the substituted beta list — the two mimicry
                  // vectors that used to survive with emulation off — are gone.
                  // See lib/passthrough-headers.mjs for why the envelope is not
                  // mimicry.
                  requestHeaders = buildPassthroughHeaders(input, requestInit, accessToken);
                }

                if (!requestHeaders) {
                  // Emulation ON, on an endpoint the package has no surface for
                  // (files, models, a gateway-prefixed route). Unchanged, and the
                  // only caller of the legacy forge left: on a messages or
                  // count_tokens turn the adapter above always produced headers,
                  // which `test/conformance/adapter-unconditional.test.mjs`
                  // observes directly.
                  requestHeaders = buildRequestHeaders(
                    input,
                    requestInit,
                    accessToken,
                    body,
                    requestUrl,
                    _adapterSignature,
                    _adaptiveOverride,
                    _tokenEconomy,
                  );
                  // buildRequestHeaders just derived x-stainless-helper from the
                  // markers. They are an internal signal — the Anthropic API has
                  // never known those keys — so they are dropped from the body now
                  // that the header exists. The adapter path does the same strip in
                  // buildWireCompatibleRequest; this is the legacy half of it.
                  if (typeof body === "string" && body.length > 0) {
                    try {
                      const _strippable = JSON.parse(body);
                      if (stripStainlessHelperMarkers(_strippable?.tools, _strippable?.messages) > 0) {
                        legacyStrippedBody = JSON.stringify(_strippable);
                      }
                    } catch (error) {
                      // A non-JSON body carries no markers to strip; forward it untouched.
                      debugLog(`stainless-helper strip skipped (unparsable body): ${error.message}`);
                    }
                  }
                }
                // cch stays as the static "00000" placeholder — cc-107 and cc-108
                // JS bundles both emit `cch=00000;` unconditionally in the billing
                // header. The Bun-binary Attestation.zig xxHash64 mechanism lives in
                // a SEPARATE header path, not in this body field. Re-hashing here
                // mutates system[0] each turn, invalidating the prompt cache.
                const finalBody = adapterBody ?? legacyStrippedBody ?? body;

                const correlationId = createDebugCorrelationId();

                // Opt-in: dump the OUTGOING body (post-cch) so diagnostics reflect
                // exactly what went on the wire. Previously dumped `body` which
                // still had the cch=00000 placeholder — that confused debugging.
                // Rotates at 10 files to cap disk usage. Files live under
                // ~/.opencode/opencode-anthropic-fix/request-dumps/.
                if (isDebugSinkEnabled(config, "body") && typeof finalBody === "string") {
                  try {
                    const fs = await import("node:fs");
                    const path = await import("node:path");
                    const os = await import("node:os");
                    const dir = path.join(os.homedir(), ".opencode", "opencode-anthropic-fix", "request-dumps");
                    fs.mkdirSync(dir, { recursive: true });
                    // Rotate: keep last 10
                    const existing = fs
                      .readdirSync(dir)
                      .filter((f) => f.startsWith("req-") && f.endsWith(".json"))
                      .sort();
                    while (existing.length >= 10) {
                      fs.unlinkSync(path.join(dir, existing.shift()));
                    }
                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    const dump = createDebugRequestDump(correlationId, ts, finalBody);
                    fs.writeFileSync(path.join(dir, dump.filename), dump.content);
                  } catch {
                    // Disk full, permissions, whatever — never block the request.
                  }
                }

                // Execute the request
                let response;
                try {
                  if (isDebugSinkEnabled(config, "headers")) {
                    try {
                      const { existsSync, renameSync, statSync, unlinkSync, writeFileSync } = await import("node:fs");
                      const { join } = await import("node:path");
                      const debugFile = join(getConfigDir(), "debug-headers.log");
                      const rotatedFile = `${debugFile}.1`;
                      if (existsSync(debugFile) && statSync(debugFile).size > 2 * 1024 * 1024) {
                        if (existsSync(rotatedFile)) unlinkSync(rotatedFile);
                        renameSync(debugFile, rotatedFile);
                      }
                      const ts = new Date().toISOString();
                      const entry = createDebugOutgoingHeadersEntry(correlationId, ts, requestHeaders);
                      writeFileSync(debugFile, entry, { flag: "a" });
                    } catch (e) {
                      debugLog("failed to write outgoing request headers to debug-headers.log", e);
                    }
                  }
                  response = await fetch(adapterRequestInput ?? requestInput, {
                    ...requestInit,
                    body: finalBody,
                    headers: requestHeaders,
                    // Disable keepalive when a previous ECONNRESET/EPIPE was detected
                    // to force a fresh TCP connection and avoid stale socket reuse.
                    ...(requestInit._disableKeepalive ? { keepalive: false, agent: false } : {}),
                  });
                } catch (err) {
                  const fetchError = err instanceof Error ? err : new Error(String(err));
                  const errMsg = fetchError.message || "";
                  const errCode = /** @type {any} */ (fetchError).code || "";

                  // ECONNRESET/EPIPE recovery: these indicate a stale TCP connection
                  // (server closed it while we were writing/reading). Disable keepalive
                  // on the next attempt to force a fresh connection.
                  const isConnectionReset =
                    errCode === "ECONNRESET" ||
                    errCode === "EPIPE" ||
                    errCode === "ECONNABORTED" ||
                    errMsg.includes("ECONNRESET") ||
                    errMsg.includes("EPIPE") ||
                    errMsg.includes("socket hang up") ||
                    errMsg.includes("network socket disconnected");

                  if (isConnectionReset && _connectionResetRetries < 3) {
                    _connectionResetRetries++;
                    requestInit._disableKeepalive = true;
                    debugLog("connection reset detected, disabling keepalive for retry", {
                      code: errCode,
                      message: errMsg,
                      retryCount: _connectionResetRetries,
                    });
                    // Don't mark the account as failed — this is a transport issue, not auth.
                    // Retry the same account with keepalive disabled.
                    if (accountManager && account) {
                      lastError = fetchError;
                      attempt--; // Don't consume an account slot
                      continue;
                    }
                  }

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

                // Debug: log all response headers to file for diagnosis
                // Placed BEFORE the response.ok guard so we capture headers on ALL responses
                if (isDebugSinkEnabled(config, "headers")) {
                  const rlHeaders = {};
                  const allHeaders = {};
                  response.headers.forEach((value, key) => {
                    allHeaders[key] = value;
                    if (key.includes("ratelimit") || key.includes("retry") || key.includes("x-should")) {
                      rlHeaders[key] = value;
                    }
                  });
                  const redactedRlHeaders = redactSecrets(rlHeaders);
                  const redactedAllHeaders = redactSecrets(allHeaders);
                  debugLog(
                    "response status:",
                    response.status,
                    "ok:",
                    response.ok,
                    "account:",
                    !!account,
                    "accountManager:",
                    !!accountManager,
                  );
                  debugLog("ALL response headers:", redactedAllHeaders);
                  // Write to file for reliable access
                  try {
                    const { existsSync, renameSync, statSync, unlinkSync, writeFileSync } = await import("node:fs");
                    const { join } = await import("node:path");
                    const debugFile = join(getConfigDir(), "debug-headers.log");
                    const rotatedFile = `${debugFile}.1`;
                    if (existsSync(debugFile) && statSync(debugFile).size > 2 * 1024 * 1024) {
                      if (existsSync(rotatedFile)) unlinkSync(rotatedFile);
                      renameSync(debugFile, rotatedFile);
                    }
                    const ts = new Date().toISOString();
                    const entry = createDebugResponseHeadersEntry(correlationId, ts, response, {
                      account: !!account,
                      accountManager: !!accountManager,
                      rateLimitHeaders: redactedRlHeaders,
                      allHeaders: redactedAllHeaders,
                    });
                    writeFileSync(debugFile, entry, { flag: "a" });
                  } catch (e) {
                    debugLog("failed to write debug-headers.log", e);
                  }
                }

                // Proactive rate limit detection from response headers
                // Anthropic sends window-based unified headers: 5h and 7d windows
                if (response.ok && account && accountManager) {
                  const RATE_LIMIT_WINDOWS = [
                    { key: "5h", field: "fiveHour", windowMs: 5 * 3600 * 1000 },
                    { key: "7d", field: "sevenDay", windowMs: 7 * 24 * 3600 * 1000 },
                  ];
                  let maxUtilization = 0;
                  let maxUtilizationWindow = "";
                  let anySurpassed = false;
                  let surpassedResetAt = null;

                  // Also capture overall status and fallback info
                  const overallStatus = response.headers.get("anthropic-ratelimit-unified-status");
                  const representativeClaim = response.headers.get("anthropic-ratelimit-unified-representative-claim");
                  const fallbackStatus = response.headers.get("anthropic-ratelimit-unified-fallback");
                  const fallbackPct = response.headers.get("anthropic-ratelimit-unified-fallback-percentage");
                  const overageStatus = response.headers.get("anthropic-ratelimit-unified-overage-status");
                  const overageReason = response.headers.get("anthropic-ratelimit-unified-overage-disabled-reason");

                  for (const win of RATE_LIMIT_WINDOWS) {
                    const utilizationStr = response.headers.get(`anthropic-ratelimit-unified-${win.key}-utilization`);
                    const status = response.headers.get(`anthropic-ratelimit-unified-${win.key}-status`);
                    const surpassed = response.headers.get(
                      `anthropic-ratelimit-unified-${win.key}-surpassed-threshold`,
                    );
                    const resetAt = response.headers.get(`anthropic-ratelimit-unified-${win.key}-reset`);

                    if (utilizationStr) {
                      const utilization = parseFloat(utilizationStr);
                      if (!isNaN(utilization)) {
                        // Store per-window quota for user display
                        const resetDate = resetAt ? new Date(parseInt(resetAt) * 1000).toISOString() : null;
                        sessionMetrics.lastQuota[win.field] = {
                          utilization: utilization * 100, // store as percentage 0-100
                          resets_at: resetDate,
                          status: status || null,
                          surpassedThreshold: surpassed ? parseFloat(surpassed) : null,
                        };
                        sessionMetrics.lastQuota.updatedAt = Date.now();

                        if (utilization > maxUtilization) {
                          maxUtilization = utilization;
                          maxUtilizationWindow = win.key;
                        }
                      }
                    }

                    if (surpassed) {
                      anySurpassed = true;
                      surpassedResetAt = surpassedResetAt || resetAt;
                    }
                  }

                  // Store overall/fallback/overage info
                  if (overallStatus) {
                    sessionMetrics.lastQuota.overallStatus = overallStatus;
                    sessionMetrics.lastQuota.representativeClaim = representativeClaim;
                    sessionMetrics.lastQuota.fallback = fallbackStatus;
                    sessionMetrics.lastQuota.fallbackPercentage = fallbackPct ? parseFloat(fallbackPct) : null;
                    sessionMetrics.lastQuota.overageStatus = overageStatus;
                    sessionMetrics.lastQuota.overageReason = overageReason;
                  }

                  // Detect changes in any anthropic-ratelimit-unified-* status headers and toast
                  if (!config.toasts?.quiet) {
                    /** @type {Array<[string, string | null]>} header-suffix → current value */
                    const unifiedStatusHeaders = [
                      ["status", overallStatus],
                      ["representative-claim", representativeClaim],
                      ["fallback", fallbackStatus],
                      ["fallback-percentage", fallbackPct],
                      ["overage-status", overageStatus],
                      ["overage-disabled-reason", overageReason],
                    ];
                    // Add per-window status headers
                    for (const win of RATE_LIMIT_WINDOWS) {
                      unifiedStatusHeaders.push([
                        `${win.key}-status`,
                        response.headers.get(`anthropic-ratelimit-unified-${win.key}-status`),
                      ]);
                    }

                    for (const [key, current] of unifiedStatusHeaders) {
                      if (current == null) continue; // header absent — skip
                      const prev = previousUnifiedStatus[key];
                      if (prev !== undefined && prev !== current) {
                        // Value changed — emit a toast
                        const label = key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                        toast(`Quota ${label}: ${prev ?? "—"} → ${current}`, "info", {
                          debounceKey: `unified-status-${key}`,
                        }).catch(() => {});
                        debugLog("anthropic-ratelimit-unified status change", { key, prev, current });
                      }
                      previousUnifiedStatus[key] = current;
                    }
                  }

                  // Back-compat: also update tokens/requests/inputTokens from the highest window
                  // so existing code that reads these fields still works
                  if (maxUtilization > 0) {
                    sessionMetrics.lastQuota.tokens = maxUtilization;
                    sessionMetrics.lastQuota.requests = maxUtilization;
                    sessionMetrics.lastQuota.inputTokens = maxUtilization;
                  }

                  // Proactive account management is gated on config. When
                  // account_management.proactive_disabled is true (default),
                  // we never apply penalties on a 200 OK response — those
                  // penalties were locking out single-account users whose
                  // server-side quota was still in `allowed_warning` state.
                  // The reactive 429 path below is unaffected.
                  const proactiveDisabled = config.account_management?.proactive_disabled !== false;

                  if (!proactiveDisabled && maxUtilization > 0.8) {
                    const penalty = Math.round((maxUtilization - 0.8) * 50); // 0-10 points
                    accountManager.applyUtilizationPenalty(account, penalty);
                    debugLog("high rate limit utilization", {
                      accountIndex: account.index,
                      window: maxUtilizationWindow,
                      utilization: (maxUtilization * 100).toFixed(1) + "%",
                      penalty,
                    });
                  }

                  if (!proactiveDisabled && anySurpassed) {
                    accountManager.applySurpassedThreshold(account, surpassedResetAt);
                    debugLog("rate limit threshold surpassed", {
                      accountIndex: account.index,
                      resetAt: surpassedResetAt,
                    });
                  }

                  // Toast at 90%+ utilization to warn user before rate limit hits
                  if (maxUtilization >= 0.9 && !config.toasts?.quiet) {
                    toast(
                      `Rate limit ${maxUtilizationWindow} window: ${(maxUtilization * 100).toFixed(0)}% utilized`,
                      "warning",
                      { debounceKey: "quota-warn" },
                    ).catch(() => {});
                  }

                  // Predictive rate limit avoidance: switch account BEFORE hitting 429
                  // Parse reset timestamps to compute time-weighted risk.
                  // Gated on proactive_disabled — when true (default), no automatic
                  // switches happen on 200 OK responses (fully manual rotation).
                  if (!proactiveDisabled && maxUtilization > 0.6 && accountManager.getAccountCount() > 1) {
                    let highestRisk = 0;
                    for (const win of RATE_LIMIT_WINDOWS) {
                      const utilizationStr = response.headers.get(`anthropic-ratelimit-unified-${win.key}-utilization`);
                      const resetAtStr = response.headers.get(`anthropic-ratelimit-unified-${win.key}-reset`);
                      if (!utilizationStr || !resetAtStr) continue;

                      const utilization = parseFloat(utilizationStr);
                      const resetEpoch = parseInt(resetAtStr) * 1000; // unix epoch seconds → ms
                      if (isNaN(utilization) || isNaN(resetEpoch)) continue;

                      const timeUntilReset = Math.max(0, resetEpoch - Date.now());
                      // Risk formula: how fast we're burning through the quota
                      // Higher utilization + less time remaining = higher risk
                      const timeRemainingFraction = Math.max(0.01, timeUntilReset / win.windowMs);
                      const risk = utilization / timeRemainingFraction;
                      if (risk > highestRisk) highestRisk = risk;
                    }

                    // Preemptive switch threshold
                    if (highestRisk > 0.85 && accountManager.getAccountCount() > 1) {
                      const currentName = account.email || `Account ${account.index + 1}`;
                      const nextAccount = accountManager.peekNextAccount?.();
                      const nextName = nextAccount?.email || "next account";
                      // QA fix L-predictive: use markPreemptiveSwitch instead of markRateLimited
                      // — the request succeeded (200), so don't penalise consecutiveFailures or health.
                      accountManager.markPreemptiveSwitch(account);
                      toast(
                        `Predictive switch: ${currentName} at high burn rate, switching to ${nextName}`,
                        "warning",
                        { debounceKey: "predictive-switch" },
                      ).catch(() => {});
                      debugLog("predictive rate limit switch", {
                        accountIndex: account.index,
                        risk: highestRisk.toFixed(2),
                      });
                    }
                  }
                }

                // On error, check if it's account-specific or service-wide
                if (!response.ok && accountManager && account) {
                  let errorBody = null;
                  try {
                    // QA fix L-errorBody: size-bound the read (16 KB) to avoid OOM on large error responses,
                    // and add a 5s timeout so streaming error bodies don't stall the retry logic.
                    const cloned = response.clone();
                    const reader = cloned.body?.getReader();
                    if (reader) {
                      const chunks = [];
                      let totalLen = 0;
                      const maxLen = 16_384;
                      const deadline = Date.now() + 5_000;
                      while (totalLen < maxLen && Date.now() < deadline) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        totalLen += value.byteLength;
                      }
                      reader.cancel().catch(() => {});
                      errorBody = new TextDecoder()
                        .decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks))
                        .slice(0, maxLen);
                    } else {
                      errorBody = await cloned.text();
                    }
                  } catch {
                    // Ignore read errors in debug logging path.
                  }

                  // Compact-and-retry on 422/424: strip thinking blocks + old tool_result
                  // content and retry ONCE. This reacts to the response status alone, so it
                  // stays live even though the plugin no longer announces the
                  // context-hint-2026-04-09 beta nor the paired body field.
                  if (
                    (response.status === 422 || response.status === 424) &&
                    !requestInit._contextHintCompactAttempted
                  ) {
                    try {
                      const hintBody = JSON.parse(requestInit.body);
                      if (Array.isArray(hintBody.messages)) {
                        const compacted = applyContextHintCompaction(hintBody.messages);
                        if (compacted.changed) {
                          hintBody.messages = compacted.messages;
                          requestInit.body = JSON.stringify(hintBody);
                          _parsedBodyOnce = null;
                          requestInit._contextHintCompactAttempted = true;
                          attempt--;
                          toast(
                            `⚙ Context hint compaction (${response.status}) — cleared ${compacted.stats.thinkingCleared} thinking / ${compacted.stats.toolResultsCleared} tool results`,
                            "info",
                            { debounceKey: "context-hint-compact" },
                          ).catch(() => {});
                          debugLog("context-hint: applied compaction on status", response.status, compacted.stats);
                          continue;
                        }
                      }
                    } catch {
                      // fall through to normal error handling
                    }
                  }

                  // Selective custom-beta retry: if the server rejects the request citing an
                  // anthropic-beta issue not caught by the context-hint handler above, strip
                  // config.custom_betas once and retry.
                  // F2: 413 only triggers this path when the body contains an explicit signal
                  // keyword (anthropic-beta, beta header, unsupported/unknown/invalid beta,
                  // context_window, long context, 1m/million context) to avoid false positives
                  // on generic 413s (e.g. plain upload-size limits with an empty body).
                  // One retry per logical request (latch prevents loop).
                  if (
                    !customBetasStripped &&
                    (config.custom_betas?.length ?? 0) > 0 &&
                    ((response.status === 400 &&
                      errorBody &&
                      errorBody.includes("anthropic-beta") &&
                      !errorBody.includes("context-hint")) ||
                      (response.status === 413 &&
                        errorBody &&
                        /anthropic-beta|beta header|unsupported beta|unknown beta|invalid beta|context_window|long context|1m context|million context/i.test(
                          errorBody,
                        )))
                  ) {
                    customBetasStripped = true;
                    // F4: record rejection in session latch so next logical request already
                    // omits the rejected beta without needing a first-fail.
                    // Only record betas explicitly mentioned in the error body (raw or canonical);
                    // fall back to recording all custom betas if the body names none specifically.
                    {
                      const _allCustom = config.custom_betas ?? [];
                      const _mentioned = _allCustom.filter((_sb) => {
                        const _rawLc = _sb.toLowerCase();
                        const _canLc = resolveBetaShortcut(_sb).toLowerCase();
                        const _bodyLc = (errorBody || "").toLowerCase();
                        return _bodyLc.includes(_rawLc) || _bodyLc.includes(_canLc);
                      });
                      const _toRecord = _mentioned.length > 0 ? _mentioned : _allCustom;
                      const _recordedAt = Date.now();
                      for (const _sb of _toRecord) {
                        sessionRejectedBetas.set(resolveBetaShortcut(_sb), _recordedAt);
                      }
                    }
                    attempt--;
                    debugLog("custom beta/context rejection - retrying without custom betas");
                    continue;
                  }

                  // Reactive compaction: on "prompt too long" error, trim oldest messages and retry once
                  if (
                    response.status === 400 &&
                    errorBody &&
                    (errorBody.includes("prompt is too long") || errorBody.includes("prompt_too_long")) &&
                    !requestInit._reactiveCompactAttempted
                  ) {
                    debugLog("prompt too long — attempting reactive message trimming");

                    // --- Overflow recovery: parse structured error and reduce max_tokens ---
                    // This is attempted BEFORE message trimming. If we can parse the exact
                    // numbers from the error, we reduce max_tokens to fit and retry without
                    // losing any conversation history.
                    if (config.overflow_recovery?.enabled && !requestInit._overflowRecoveryAttempted) {
                      const overflow = parseContextLimitError(errorBody);
                      if (overflow) {
                        const margin = config.overflow_recovery.safety_margin ?? 1_000;
                        const safeMaxTokens = computeSafeMaxTokens(overflow.input, overflow.limit, margin);
                        if (safeMaxTokens > 0) {
                          debugLog("overflow recovery: reducing max_tokens", {
                            original: overflow.maxTokens,
                            safe: safeMaxTokens,
                            input: overflow.input,
                            limit: overflow.limit,
                            margin,
                          });
                          try {
                            // QA fix: parse from requestInit.body (pre-transform) to avoid
                            // double-transformation (mcp_ prefix, system blocks, metadata).
                            const recoveryBody = JSON.parse(requestInit.body);
                            recoveryBody.max_tokens = safeMaxTokens;
                            requestInit.body = JSON.stringify(recoveryBody);
                            _parsedBodyOnce = null; // Invalidate stale parsed cache
                            requestInit._overflowRecoveryAttempted = true;
                            attempt--;
                            toast(
                              `Context overflow: reduced max_tokens ${overflow.maxTokens.toLocaleString()} → ${safeMaxTokens.toLocaleString()}`,
                              "warning",
                              { debounceKey: "overflow-recovery" },
                            ).catch(() => {});
                            continue;
                          } catch {
                            // Body parse failed, fall through to message trimming
                          }
                        }
                      }
                    }

                    // Auto-escalate adaptive context on prompt_too_long so the retry
                    // includes the 1M beta header (if model supports it).
                    if (config.adaptive_context?.enabled) {
                      const stateChanged = forceEscalateAdaptiveContext();
                      if (stateChanged) {
                        // Invalidate cached adaptive decision so the retry loop
                        // re-evaluates with the new active=true state.
                        _adaptiveDecisionMade = false;
                        toast("⬡ 1M context force-activated (prompt too long)", "warning", {
                          debounceKey: "adaptive-ctx",
                        }).catch(() => {});
                      }
                    }
                    try {
                      // QA fix: parse from requestInit.body (pre-transform) to avoid
                      // double-transformation (mcp_ prefix, system blocks, metadata).
                      const parsedBody = JSON.parse(requestInit.body);
                      if (Array.isArray(parsedBody.messages) && parsedBody.messages.length > 4) {
                        // Keep first 2 messages (initial context) and last 2 messages (recent work).
                        // Ensure the trimmed array never ends with an assistant message (prefill),
                        // which would cause "does not support assistant message prefill" errors.
                        const msgs = parsedBody.messages;
                        const tail = msgs.slice(-2);
                        // If tail ends with assistant, append a user message to fix the prefill issue.
                        // Check if the assistant's last content block is tool_use — if so, synthesize
                        // a tool_result instead of bare "Continue." to respect the tool protocol.
                        if (tail.length > 0 && tail[tail.length - 1]?.role === "assistant") {
                          const lastAssistant = tail[tail.length - 1];
                          const lastContent = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
                          const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");
                          if (toolUseBlocks.length > 0) {
                            // Synthesize tool_result for each pending tool_use
                            tail.push({
                              role: "user",
                              content: toolUseBlocks.map((tu) => ({
                                type: "tool_result",
                                tool_use_id: tu.id,
                                content: "[Context trimmed — previous result unavailable]",
                              })),
                            });
                          } else {
                            tail.push({
                              role: "user",
                              content: [{ type: "text", text: "Continue." }],
                            });
                          }
                        }
                        const trimmed = [
                          ...msgs.slice(0, 2),
                          {
                            role: "user",
                            content: [
                              {
                                type: "text",
                                text: "[Earlier conversation was trimmed due to context limits. Continue from the most recent context.]",
                              },
                            ],
                          },
                          ...tail,
                        ];
                        // Repair any orphaned tool_use blocks created by the trim boundary
                        // (e.g. first 2 messages include an assistant tool_use whose
                        // tool_result was in a trimmed middle message).
                        parsedBody.messages = repairOrphanedToolUseBlocks(trimmed);
                        requestInit.body = JSON.stringify(parsedBody);
                        _parsedBodyOnce = null; // Invalidate stale parsed cache
                        requestInit._reactiveCompactAttempted = true;
                        // Retry with trimmed messages (decrement attempt to not consume account slot)
                        attempt--;
                        toast("Context trimmed — retrying with shortened history", "warning", {
                          debounceKey: "compact-retry",
                        }).catch(() => {});
                        continue;
                      }
                    } catch {
                      // If body parse fails, fall through to normal error handling
                    }
                  }

                  // Auto-disable extended cache TTL ONLY if the API explicitly says TTL is
                  // not supported. Do NOT disable on TTL ordering errors (which are fixable).
                  if (
                    response.status === 400 &&
                    errorBody &&
                    errorBody.includes("cache_control") &&
                    !errorBody.includes("must not come after") &&
                    !errorBody.includes("maximum of")
                  ) {
                    if (config.cache_policy && config.cache_policy.ttl_supported !== false) {
                      config.cache_policy.ttl_supported = false;
                      saveConfig({ cache_policy: { ttl_supported: false } });
                      debugLog("cache TTL not supported by API, auto-disabled");
                    }
                  }

                  // Auto-disable fast mode if the API rejects speed parameter
                  if (response.status === 400 && errorBody && errorBody.includes("speed")) {
                    if (config.fast_mode) {
                      config.fast_mode = false;
                      _fastModeAppliedToast = false;
                      saveConfig({ fast_mode: false });
                      toast("⚡ Fast mode OFF — not supported by API", "warning", {
                        debounceKey: "fast-mode-off",
                      }).catch(() => {});
                      debugLog("fast mode not supported by API, auto-disabled");
                    }
                  }

                  // Check x-should-retry header first — server override
                  const shouldRetry = parseShouldRetryHeader(response);
                  if (shouldRetry === false) {
                    // Server says DO NOT retry — return error directly.
                    // Include a snippet of the error body so 4xx causes (e.g. the
                    // thinking-block "cannot be modified" 400, or an unsupported
                    // manual-thinking 400 on adaptive models) are visible in debug.
                    debugLog("x-should-retry: false — not retrying", {
                      status: response.status,
                      errorBody: typeof errorBody === "string" ? errorBody.slice(0, 600) : errorBody,
                    });
                    return transformResponse(response, undefined, undefined, correlationId);
                  }

                  const accountSpecific = isAccountSpecificError(response.status, errorBody);

                  // x-should-retry: true forces a retry for service-wide errors (RE doc §5.5)
                  // Capped at maxShouldRetries to prevent infinite loops (QA fix C1)
                  if (shouldRetry === true && !accountSpecific && shouldRetryCount < maxShouldRetries) {
                    shouldRetryCount++;
                    const retryDelay = parseRetryAfterMsHeader(response) ?? parseRetryAfterHeader(response) ?? 2000;
                    debugLog("x-should-retry: true on service-wide error, sleeping before retry", {
                      status: response.status,
                      retryDelay,
                      shouldRetryCount,
                    });
                    await new Promise((r) => setTimeout(r, retryDelay));
                    // Decrement attempt so this retry doesn't consume an account slot
                    attempt--;
                    continue;
                  }

                  // Account-specific errors (429/401/billing/permission)
                  if (accountSpecific) {
                    const reason = parseRateLimitReason(response.status, errorBody);
                    const retryAfterMs =
                      parseRetryAfterMsHeader(response) ??
                      parseRetryAfterHeader(response) ??
                      parseUnifiedResetMsHeader(response);

                    // Transient 429: short retry-after (<=10s) is a burst throttle.
                    // Retry on the SAME account instead of rotating — avoids wasting
                    // the account pool on momentary rate spikes.
                    if (isTransientRateLimit(response.status, reason, retryAfterMs, TRANSIENT_RETRY_THRESHOLD_MS)) {
                      debugLog("transient 429: sleeping before same-account retry", {
                        retryAfterMs,
                        account: account.email || `Account ${account.index + 1}`,
                      });
                      await new Promise((r) => setTimeout(r, retryAfterMs));
                      // Decrement attempt so this transient retry doesn't consume an account slot
                      attempt--;
                      continue;
                    }

                    // Fast-mode pool isolation: if THIS request used speed:"fast"
                    // and the limit is a plain rate limit, the FAST pool was
                    // exhausted — not the account's standard quota. Per Anthropic,
                    // fast has a separate pool and should fall back to standard
                    // speed, NOT block the account. So: cool down only the fast
                    // bucket, then retry on the SAME account at standard speed
                    // (the next transformRequestBody omits speed:"fast" because
                    // isFastRateLimited(account) is now true). We do NOT flip the
                    // global config.fast_mode flag — other accounts/turns can still
                    // use fast mode.
                    const requestWasFast = typeof body === "string" && body.includes('"speed":"fast"');
                    if (
                      requestWasFast &&
                      response.status === 429 &&
                      reason === "RATE_LIMIT_EXCEEDED" &&
                      fastFallbackCount < MAX_FAST_FALLBACKS
                    ) {
                      fastFallbackCount++;
                      const fastBackoff = accountManager.markRateLimited(
                        account,
                        reason,
                        retryAfterMs,
                        RATE_LIMIT_KEY_FAST,
                      );
                      _fastModeAppliedToast = false;
                      toast("⚡ Fast pool limited — falling back to standard speed", "info", {
                        debounceKey: "fast-fallback",
                      }).catch(() => {});
                      debugLog("fast pool rate-limited; falling back to standard on same account", {
                        account: account.email || `Account ${account.index + 1}`,
                        fastBackoffMs: fastBackoff,
                        fastFallbackCount,
                      });
                      // Retry same account at standard speed without consuming a slot.
                      attempt--;
                      continue;
                    }

                    accountManager.markRateLimited(account, reason, retryAfterMs);

                    // On auth failures, clear token so next selection forces refresh
                    if (reason === "AUTH_FAILED") {
                      account.access = "";
                      account.expires = 0;
                    }

                    // Strategy adaptation: record account-specific throttling signal
                    recordRateLimitForStrategy();

                    // Graceful degradation: disable fast mode on rate limits.
                    // Note: a fast-pool-only 429 is handled by the fast-fallback
                    // branch above and never reaches here, so this global disable
                    // only fires for standard-pool limits or 529 overloads.
                    if (config.fast_mode && (response.status === 429 || response.status === 529)) {
                      config.fast_mode = false;
                      _fastModeAppliedToast = false;
                      toast("⚡ Fast mode OFF — rate limited", "warning", {
                        debounceKey: "fast-mode-off",
                      }).catch(() => {});
                      debugLog("auto-disabled fast mode after rate limit");
                    }

                    const accountName = account.email || `Account ${account.index + 1}`;
                    const lowerBody = String(errorBody || "").toLowerCase();
                    const switchMsg =
                      response.status === 403 || lowerBody.includes("permission")
                        ? `permission denied on ${accountName}; switching account`
                        : reason === "AUTH_FAILED"
                          ? `authentication failed on ${accountName}; switching account`
                          : reason === "QUOTA_EXHAUSTED"
                            ? `quota exhausted on ${accountName}; switching account`
                            : `Rate limited on ${accountName}; switching account`;
                    toast(switchMsg, "warning", {
                      debounceKey: "switch-account",
                    }).catch(() => {});
                    continue;
                  }

                  // 529 (overloaded) and 503 (service unavailable) — brief sleep-and-retry
                  // per RE doc u00a75.5 (Stainless SDK retries 500+ codes up to maxServiceRetries times)
                  if (shouldServiceRetry(response.status, serviceWideRetryCount, maxServiceRetries)) {
                    serviceWideRetryCount++;

                    // Track consecutive 529s for model fallback
                    if (response.status === 529) {
                      consecutive529Count++;
                      if (consecutive529Count >= CONSECUTIVE_529_FALLBACK_THRESHOLD && requestInit.body) {
                        try {
                          // QA fix: parse from requestInit.body (pre-transform) to avoid
                          // double-transformation (mcp_ prefix, system blocks, metadata).
                          const parsedForFallback = JSON.parse(requestInit.body);
                          const currentModel = parsedForFallback.model || "";
                          const fallbackModel = selectFallbackModel(currentModel);

                          if (fallbackModel) {
                            parsedForFallback.model = fallbackModel;
                            requestInit.body = JSON.stringify(parsedForFallback);
                            _parsedBodyOnce = null; // Invalidate stale parsed cache
                            toast(
                              `Model fallback: ${currentModel} → ${fallbackModel} after ${consecutive529Count} overloads`,
                              "warning",
                              { debounceKey: "model-fallback" },
                            ).catch(() => {});
                            debugLog("model fallback on consecutive 529", {
                              from: currentModel,
                              to: fallbackModel,
                              count: consecutive529Count,
                            });
                          }
                        } catch {
                          /* ignore parse errors */
                        }
                      }
                    } else {
                      consecutive529Count = 0;
                    }

                    const sleepMs = computeServiceRetrySleepMs(serviceWideRetryCount);
                    const retryLabel = response.status === 529 ? "overloaded" : "unavailable";
                    debugLog(`service-wide ${retryLabel} error, sleeping before retry`, {
                      status: response.status,
                      attempt: serviceWideRetryCount,
                      maxRetries: maxServiceRetries,
                      sleepMs,
                    });
                    toast(
                      `API ${retryLabel} (${response.status}): retry ${serviceWideRetryCount}/${maxServiceRetries} in ${(sleepMs / 1000).toFixed(1)}s`,
                      "warning",
                      { debounceKey: "service-retry" },
                    ).catch(() => {});
                    await new Promise((r) => setTimeout(r, sleepMs));
                    // Decrement attempt so this retry doesn't consume an account slot
                    attempt--;
                    continue;
                  }

                  // Non-retryable service-wide error — attempt quota-aware account switch for 529
                  if (
                    response.status === 529 &&
                    accountManager &&
                    account &&
                    config.overload_recovery?.enabled !== false &&
                    !_overloadRecoveryAttempted
                  ) {
                    _overloadRecoveryAttempted = true;
                    const recovery = tryQuotaAwareAccountSwitch(account, accountManager, config);
                    if (recovery.switched && recovery.nextAccount) {
                      // Fire-and-forget: poll quota for the overloaded account in background
                      if (config.overload_recovery?.poll_quota_on_overload && account?.access) {
                        pollOAuthUsage(config, account.access).catch(() => {});
                      }
                      const fromName = account.email || `Account ${account.index + 1}`;
                      const toName = recovery.nextAccount.email || `Account ${recovery.nextAccount.index + 1}`;
                      const cooldownMin = Math.ceil(recovery.cooldownMs / 60_000);
                      toast(`529 overloaded: ${fromName} → ${toName} (cooldown ${cooldownMin}m)`, "warning", {
                        debounceKey: "overload-switch",
                      }).catch(() => {});
                      debugLog("overload recovery: retrying with new account", {
                        from: account.index,
                        to: recovery.nextAccount.index,
                        cooldownMs: recovery.cooldownMs,
                      });
                      // Don't consume an attempt slot — this is a recovery switch
                      attempt--;
                      continue;
                    }

                    // Could not switch — build comprehensive error message and toast
                    const errorMsg = buildOverloadErrorMessage(
                      account,
                      accountManager,
                      serviceWideRetryCount,
                      maxServiceRetries,
                    );
                    toast(errorMsg, "error", { debounceKey: "overload-exhausted" }).catch(() => {});
                    debugLog("overload recovery: all accounts exhausted", {
                      errorMsg,
                    });
                  } else {
                    debugLog("service-wide response error, returning directly", {
                      status: response.status,
                    });
                  }
                  return transformResponse(response, undefined, undefined, correlationId);
                }

                // Success
                if (account && accountManager) {
                  if (response.ok) {
                    accountManager.markSuccess(account);
                    checkStrategyRecovery();

                    // Fire startup telemetry (once per session, after first success)
                    if (telemetryEmitter.enabled && account?.access) {
                      telemetryEmitter.sendStartupEvents(account.access).catch(() => {});
                    }
                  }
                }

                // Wire usage tracking and mid-stream error detection for SSE responses only.
                const shouldInspectStream = response.ok && account && accountManager && isEventStreamResponse(response);

                const usageCallback = shouldInspectStream
                  ? (/** @type {UsageStats} */ usage) => {
                      accountManager.recordUsage(account.index, usage);
                      // Phase 4: session metrics
                      updateSessionMetrics(usage, _reqModel);
                      // Cache hit rate warning
                      if (sessionMetrics.turns >= 3) {
                        const avgRate = getAverageCacheHitRate();
                        const threshold = config.cache_policy?.hit_rate_warning_threshold ?? 0.3;
                        if (avgRate < threshold) {
                          debugLog("low cache hit rate", {
                            avgRate: (avgRate * 100).toFixed(1) + "%",
                            turns: sessionMetrics.turns,
                          });
                        }
                      }
                      // Budget warning
                      const maxBudget = parseFloat(process.env.OPENCODE_ANTHROPIC_MAX_BUDGET_USD || "0");
                      if (maxBudget > 0) {
                        const pct = sessionMetrics.sessionCostUsd / maxBudget;
                        if (pct >= 1.0 && !isTruthyEnv(process.env.OPENCODE_ANTHROPIC_IGNORE_BUDGET)) {
                          toast(
                            `Session budget exceeded ($${sessionMetrics.sessionCostUsd.toFixed(2)} / $${maxBudget.toFixed(2)})`,
                            "warning",
                            { debounceKey: "budget" },
                          ).catch(() => {});
                        } else if (pct >= 0.8) {
                          toast(
                            `Session at ${(pct * 100).toFixed(0)}% of budget ($${sessionMetrics.sessionCostUsd.toFixed(2)} / $${maxBudget.toFixed(2)})`,
                            "warning",
                            { debounceKey: "budget" },
                          ).catch(() => {});
                        }
                      }
                      // Per-turn usage toast (opt-in via /anthropic set usage-toast on)
                      if (config.usage_toast) {
                        const turnCost = calculateCostUsd(usage, _reqModel);
                        const totalTok =
                          usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
                        const parts = [`${totalTok.toLocaleString()} tok`];
                        if (usage.cacheReadTokens > 0) {
                          const cacheHit =
                            totalTok > 0
                              ? (
                                  (usage.cacheReadTokens /
                                    (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)) *
                                  100
                                ).toFixed(0)
                              : "0";
                          parts.push(`${cacheHit}% cache`);
                        }
                        if (usage.webSearchRequests > 0) parts.push(`${usage.webSearchRequests} search`);
                        parts.push(`$${turnCost.toFixed(4)}`);
                        toast(parts.join(" | "), "info", { debounceKey: `usage-turn-${sessionMetrics.turns}` }).catch(
                          () => {},
                        );
                      }

                      // Cache break detection (post-call)
                      if (config.cache_break_detection?.enabled) {
                        const cacheRead = usage.cacheReadTokens || 0;
                        const threshold = config.cache_break_detection.alert_threshold ?? 2_000;

                        // Only alert after the first turn (need a baseline)
                        if (
                          cacheBreakState.prevCacheRead > 0 &&
                          cacheBreakState.prevCacheRead - cacheRead > threshold &&
                          cacheBreakState.lastAlertTurn !== sessionMetrics.turns
                        ) {
                          const drop = cacheBreakState.prevCacheRead - cacheRead;
                          let alertMsg = `Cache break detected (−${drop.toLocaleString()} tokens)`;

                          // Identify changed sources if we have pending hashes
                          if (cacheBreakState._pendingHashes && cacheBreakState.sourceHashes.size > 0) {
                            const changedSources = detectCacheBreakSources(
                              cacheBreakState._pendingHashes,
                              cacheBreakState.sourceHashes,
                            );
                            if (changedSources.length > 0) {
                              alertMsg += `: ${changedSources.join(", ")} changed`;
                            }
                          }

                          toast(alertMsg, "warning", { debounceKey: "cache-break" }).catch(() => {});
                          cacheBreakState.lastAlertTurn = sessionMetrics.turns;
                        }

                        cacheBreakState.prevCacheRead = cacheRead;
                        // Store current hashes as baseline for next comparison
                        if (cacheBreakState._pendingHashes) {
                          cacheBreakState.sourceHashes = cacheBreakState._pendingHashes;
                          delete cacheBreakState._pendingHashes;
                        }
                      }

                      // Rate limit awareness: periodic usage endpoint polling (A6)
                      const shouldPollUsage =
                        sessionMetrics.turns % 10 === 0 ||
                        Date.now() - sessionMetrics.lastQuota.lastPollAt > 5 * 60_000;
                      if (shouldPollUsage && accessToken) {
                        pollOAuthUsage(config, accessToken)
                          .then(() => {
                            // Check warning levels after poll
                            const level5h = computeQuotaWarningLevel(sessionMetrics.lastQuota.fiveHour);
                            const level7d = computeQuotaWarningLevel(sessionMetrics.lastQuota.sevenDay);
                            const highestLevel =
                              level5h === "danger" || level7d === "danger"
                                ? "danger"
                                : level5h === "warning" || level7d === "warning"
                                  ? "warning"
                                  : level5h === "caution" || level7d === "caution"
                                    ? "caution"
                                    : null;

                            if (highestLevel === "danger") {
                              toast(
                                `Usage limit: \u226425% remaining (5h: ${sessionMetrics.lastQuota.fiveHour.utilization.toFixed(0)}%, 7d: ${sessionMetrics.lastQuota.sevenDay.utilization.toFixed(0)}%)`,
                                "warning",
                                { debounceKey: "usage-danger" },
                              ).catch(() => {});
                            } else if (highestLevel === "warning") {
                              toast(
                                `Usage limit: \u226450% remaining (5h: ${sessionMetrics.lastQuota.fiveHour.utilization.toFixed(0)}%, 7d: ${sessionMetrics.lastQuota.sevenDay.utilization.toFixed(0)}%)`,
                                "warning",
                                { debounceKey: "usage-warning" },
                              ).catch(() => {});
                            } else if (highestLevel === "caution" && !quotaWarningState.cautionShown) {
                              quotaWarningState.cautionShown = true;
                              toast(
                                `Usage limit: \u226475% remaining (5h: ${sessionMetrics.lastQuota.fiveHour.utilization.toFixed(0)}%, 7d: ${sessionMetrics.lastQuota.sevenDay.utilization.toFixed(0)}%)`,
                                "info",
                                { debounceKey: "usage-caution" },
                              ).catch(() => {});
                            }
                          })
                          .catch(() => {});
                      }
                    }
                  : null;

                const accountErrorCallback = shouldInspectStream
                  ? (details) => {
                      // details already come from getMidStreamAccountError(), which filters
                      // service-wide errors and returns only account-specific cases.

                      // Mark the account for the NEXT request
                      accountManager.markRateLimited(account, details.reason, null);

                      // Mid-stream auth errors must invalidate current token so next turn refreshes.
                      if (details.invalidateToken) {
                        account.access = "";
                        account.expires = 0;
                      }

                      const name = account.email || `Account ${account.index + 1}`;
                      const switchMsg =
                        details.reason === "AUTH_FAILED"
                          ? `authentication failed on ${name}; switching account`
                          : details.reason === "QUOTA_EXHAUSTED"
                            ? `quota exhausted on ${name}; switching account`
                            : `Rate limited on ${name}; switching account`;
                      toast(switchMsg, "warning", {
                        debounceKey: "switch-account",
                      }).catch(() => {});
                    }
                  : null;

                return transformResponse(
                  response,
                  usageCallback
                    ? (stats) => {
                        usageCallback(stats);
                        if (stats.lastStopReason) sessionMetrics.lastStopReason = stats.lastStopReason;
                      }
                    : null,
                  accountErrorCallback,
                  correlationId,
                );
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

            const { url, verifier } = await oauthAuthorize("max");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await oauthExchange(code, verifier);
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
            const { url, verifier } = await oauthAuthorize("console");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await oauthExchange(code, verifier);
                if (credentials.type === "success") {
                  const result = await fetch(`https://api.anthropic.com/api/oauth/claude_cli/create_api_key`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  }).then((r) => r.json());
                  return { type: "success", key: result.raw_key };
                }
                return credentials;
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
    /**
     * Stateless message-list transforms. Previously fork-only patches
     * (4c3f4fc19 stale-read eviction, 797ae24d8 per-tool-class prune)
     * now live here and apply on the cloned request messages. Hook
     * input is `{}` — no sessionID, so these are global policies.
     */
    "experimental.chat.messages.transform": async (_input, output) => {
      const strategies = config?.token_economy_strategies;
      if (!strategies) return;
      if (!output?.messages) return;

      if (strategies.stale_read_eviction) {
        staleReadEviction({ messages: output.messages });
      }
      if (strategies.per_tool_class_prune) {
        perToolClassPrune({ messages: output.messages });
      }
    },
    "experimental.session.compacting": async (input, output) => {
      // Reset adaptive context state on session compaction (new conversation boundary).
      // This prevents sticky escalation from leaking across conversations.
      adaptiveContextState.active = false;
      adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
      adaptiveContextState.escalatedByError = false;

      // Reset cache break detection state on compaction
      cacheBreakState.prevCacheRead = 0;
      cacheBreakState.sourceHashes = new Map();
      cacheBreakState.lastAlertTurn = 0;

      microcompactState.active = false;
      microcompactState.lastActivatedTurn = 0;

      // Inject Anthropic-specific context into compaction
      if (!accountManager) return;
      const account = accountManager.getCurrentAccount();
      const name = account?.email || "unknown";
      const q = sessionMetrics.lastQuota;
      const contextParts = [];

      contextParts.push(`## Anthropic Account State
- Active account: ${name}
- Session cost: $${sessionMetrics.sessionCostUsd.toFixed(4)}
- Turns: ${sessionMetrics.turns}
- Cache hit rate: ${(getAverageCacheHitRate() * 100).toFixed(0)}%`);

      if (q.updatedAt > 0) {
        contextParts.push(
          `- Rate limit utilization: tokens=${(q.tokens * 100).toFixed(0)}%, requests=${(q.requests * 100).toFixed(0)}%`,
        );
      }

      output.context.push(contextParts.join("\n"));

      // TODO(B3): wire rolling-summarizer once per-session message capture exists
      // (requires chat.messages.transform accumulator). Module exists at
      // lib/rolling-summarizer.mjs — call summarize(messages, {haikuCall}) here
      // behind config.token_economy.rolling_summarizer when messages are available.
    },
    /**
     * B3 L2 Option C: Plugin-generated compaction summary via Haiku.
     * Gated on token_economy_strategies.haiku_rolling_summary. See
     * runHaikuSessionSummarize at the top of this file for the full driver
     * — the closure here only binds account/token/config state.
     */
    "experimental.session.summarize": async (input, output) => {
      if (!config?.token_economy_strategies?.haiku_rolling_summary) return;
      if (!accountManager) return;

      const account = accountManager.getCurrentAccount();
      if (!account) return;

      const getAccessToken = async () => {
        let tok = account.access;
        if (!tok || !account.expires || account.expires < Date.now()) {
          tok = await refreshAccountTokenSingleFlight(account);
        }
        if (!tok) throw new Error("no access token available for Haiku call");
        return tok;
      };

      await runHaikuSessionSummarize(
        {
          config,
          getAccessToken,
          fetchFn: globalThis.fetch,
          callHaikuFn: callHaiku,
          rollingSummarizeFn: rollingSummarize,
          logger: typeof console !== "undefined" ? console : undefined,
        },
        input,
        output,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Session-level cache & cost tracking (Phase 4)
// ---------------------------------------------------------------------------

/** Module-level config ref for functions outside AnthropicAuthPlugin closure. */
let _pluginConfig = null;

const _debugSessionId = randomUUID().slice(0, 8);
let _debugReqSeq = 0;

export function createDebugCorrelationId() {
  return `${_debugSessionId}-${(++_debugReqSeq).toString(36).padStart(4, "0")}`;
}

export function isDebugSinkEnabled(config, sink) {
  return sink === "body" ? config.token_economy?.debug_dump_bodies === true : Boolean(config.debug);
}

export function createDebugRequestDump(correlationId, timestamp, finalBody) {
  return {
    filename: `req-${timestamp}-${correlationId}.json`,
    content: JSON.stringify({ correlationId, timestamp, bodyRedacted: redactString(finalBody) }),
  };
}

async function writeSseCapture(correlationId, buf, truncated) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = path.join(os.homedir(), ".opencode", "opencode-anthropic-fix", "request-dumps");
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("res-") && f.endsWith(".sse"))
    .sort();
  while (existing.length >= 10) {
    fs.unlinkSync(path.join(dir, existing.shift()));
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(dir, `res-${ts}-${correlationId}.sse`),
    redactString(buf) + (truncated ? "\n[capture truncated at 256KB]" : ""),
  );
}

export function createDebugOutgoingHeadersEntry(correlationId, timestamp, requestHeaders) {
  return [
    `\n=== ${timestamp} | corr=${correlationId} | OUTGOING request headers ===`,
    JSON.stringify(redactSecrets(requestHeaders), null, 2),
    "",
  ].join("\n");
}

export function createDebugResponseHeadersEntry(correlationId, timestamp, response, debugHeaders) {
  return [
    `\n=== ${timestamp} | corr=${correlationId} | status=${response.status} ok=${response.ok} account=${debugHeaders.account} mgr=${debugHeaders.accountManager} ===`,
    `Rate-limit headers: ${JSON.stringify(debugHeaders.rateLimitHeaders, null, 2)}`,
    `All headers: ${JSON.stringify(debugHeaders.allHeaders, null, 2)}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Adaptive 1M context state
// ---------------------------------------------------------------------------

/**
 * Tracks whether the 1M context beta is currently active for adaptive mode.
 * When adaptive_context.enabled is true, the context-1m-2025-08-07 beta is
 * toggled per-request based on estimated prompt size.
 *
 * @type {{ active: boolean, lastTransitionTurn: number, escalatedByError: boolean }}
 */
const adaptiveContextState = {
  /** Whether 1M context beta is currently being sent. */
  active: false,
  /** Turn number of the last transition (to avoid flapping). */
  lastTransitionTurn: 0,
  /** Set when escalation was triggered by a prompt_too_long error. */
  escalatedByError: false,
};

/** Track whether we've already toasted about fast mode being applied this session.
 *  Resets when fast mode is toggled off/on so the user gets fresh feedback. */
let _fastModeAppliedToast = false;

// ---------------------------------------------------------------------------
// Cache break detection state (Phase 2, Task 2.3)
// ---------------------------------------------------------------------------

/**
 * Tracks cache source hashes and previous cache_read_input_tokens to detect
 * cache breaks (e.g. system prompt or tool schema changes).
 *
 * @type {{ prevCacheRead: number, sourceHashes: Map<string, string>, lastAlertTurn: number }}
 */
const cacheBreakState = {
  prevCacheRead: 0,
  sourceHashes: new Map(),
  lastAlertTurn: 0,
  /**
   * Per-boundary structural stability: how many consecutive turns each cache
   * source ("system_prompt", "tools", "messages_prefix") has been unchanged.
   * Used by the adaptive breakpoint placer to anchor the cache_control marker
   * on the most-stable boundary instead of blindly on the last tool (which
   * thrashes when the host reorders/adds tools between turns).
   * @type {Map<string, number>}
   */
  boundaryStability: new Map(),
};

// ---------------------------------------------------------------------------
// Microcompact state (Phase 3, Task 3.4)
// ---------------------------------------------------------------------------

/**
 * Tracks whether microcompact betas are currently active.
 * @type {{ active: boolean, lastActivatedTurn: number }}
 */
const microcompactState = {
  active: false,
  lastActivatedTurn: 0,
};

/**
 * Hash a string for cache source fingerprinting.
 * @param {string} content
 * @returns {string} 16-char hex hash
 */
function hashCacheSource(content) {
  return createHashCrypto("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// OAuth usage endpoint polling (A6)
// ---------------------------------------------------------------------------

/**
 * Poll the /api/oauth/usage endpoint for session/weekly utilization.
 * Fire-and-forget: non-2xx responses are silently ignored.
 * @param {object} config
 * @param {string} accessToken
 */
async function pollOAuthUsage(config, accessToken) {
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      return;
    }
    const data = await resp.json();
    if (data.five_hour) {
      sessionMetrics.lastQuota.fiveHour = {
        ...sessionMetrics.lastQuota.fiveHour,
        utilization: data.five_hour.utilization ?? 0,
        resets_at: data.five_hour.resets_at ?? null,
      };
    }
    if (data.seven_day) {
      sessionMetrics.lastQuota.sevenDay = {
        ...sessionMetrics.lastQuota.sevenDay,
        utilization: data.seven_day.utilization ?? 0,
        resets_at: data.seven_day.resets_at ?? null,
      };
    }
    sessionMetrics.lastQuota.lastPollAt = Date.now();
  } catch {
    // Polling is fire-and-forget; errors are silently swallowed.
  }
}

/** @type {{ cautionShown: boolean }} */
const quotaWarningState = { cautionShown: false };

/**
 * Compute warning level based on utilization percentage.
 * @param {{ utilization: number }} quota - utilization is 0-100
 * @returns {"danger" | "warning" | "caution" | null}
 */
function computeQuotaWarningLevel(quota) {
  if (!quota || typeof quota.utilization !== "number") return null;
  const remaining = 100 - quota.utilization;
  if (remaining <= 25) return "danger";
  if (remaining <= 50) return "warning";
  if (remaining <= 75) return "caution";
  return null;
}

// ---------------------------------------------------------------------------
// Overload recovery: quota-aware account switching on 529 exhaustion (3.5)
// ---------------------------------------------------------------------------

/**
 * Build a comprehensive error message for 529/overloaded errors.
 * Includes quota info, account status, and reset times.
 *
 * @param {object} account - Current account
 * @param {object} accountManager - Account manager instance
 * @param {number} serviceWideRetryCount - How many 529 retries were attempted
 * @param {number} maxServiceRetries - Max allowed retries
 * @returns {string}
 */
function buildOverloadErrorMessage(account, accountManager, serviceWideRetryCount, maxServiceRetries) {
  const accountName = account?.email || `Account ${(account?.index ?? 0) + 1}`;
  const totalAccounts = accountManager?.getAccountCount() ?? 1;
  const parts = [
    `Anthropic API overloaded (529).`,
    `Retried ${serviceWideRetryCount}/${maxServiceRetries} times on ${accountName}.`,
  ];

  // Add quota information if available
  const fh = sessionMetrics.lastQuota.fiveHour;
  const sd = sessionMetrics.lastQuota.sevenDay;
  if (fh?.utilization > 0 || sd?.utilization > 0) {
    parts.push(
      `Quota: 5h=${fh?.utilization?.toFixed(0) ?? "?"}%` +
        (fh?.resets_at ? ` (resets ${formatResetTime(fh.resets_at)})` : "") +
        `, 7d=${sd?.utilization?.toFixed(0) ?? "?"}%` +
        (sd?.resets_at ? ` (resets ${formatResetTime(sd.resets_at)})` : ""),
    );
  }

  if (totalAccounts > 1) {
    parts.push(`Tried switching across ${totalAccounts} accounts — all exhausted or overloaded.`);
  } else {
    parts.push(`Only 1 account configured. Add more accounts with '/anthropic login' for automatic failover.`);
  }

  parts.push(`Wait a few minutes or switch models with a smaller context window.`);
  return parts.join(" ");
}

/**
 * Format a reset timestamp into a human-readable relative string.
 * @param {string | null} isoTimestamp
 * @returns {string}
 */
function formatResetTime(isoTimestamp) {
  if (!isoTimestamp) return "unknown";
  try {
    const resetMs = new Date(isoTimestamp).getTime();
    if (isNaN(resetMs)) return "unknown";
    const diffMs = resetMs - Date.now();
    if (diffMs <= 0) return "now";
    const mins = Math.ceil(diffMs / 60_000);
    if (mins < 60) return `~${mins}m`;
    const hours = Math.round(mins / 60);
    return `~${hours}h`;
  } catch {
    return "unknown";
  }
}

/**
 * Attempt quota-aware account switch after 529 retries are exhausted.
 * Polls quota, marks current account with cooldown, tries to switch.
 *
 * @param {object} account - Current (overloaded) account
 * @param {object} accountManager - Account manager
 * @param {object} config - Plugin config
 * @returns {{ switched: boolean, nextAccount: object | null, cooldownMs: number }}
 */
function tryQuotaAwareAccountSwitch(account, accountManager, config) {
  const result = { switched: false, nextAccount: null, cooldownMs: 0 };
  if (!config.overload_recovery?.enabled) return result;

  const defaultCooldown = config.overload_recovery.default_cooldown_ms ?? 60_000;

  // Use cached quota data for smarter cooldown (no HTTP calls in retry path)
  let cooldownMs = defaultCooldown;
  const fh = sessionMetrics.lastQuota.fiveHour;
  if (fh?.resets_at) {
    try {
      const resetMs = new Date(fh.resets_at).getTime();
      if (!isNaN(resetMs) && resetMs > Date.now()) {
        // Set cooldown to last until quota resets (capped at 30 min)
        cooldownMs = Math.min(resetMs - Date.now(), 30 * 60_000);
      }
    } catch {
      // Date parse failed, use default cooldown
    }
  }

  // Mark current account with cooldown
  if (account && accountManager) {
    accountManager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", cooldownMs);
    result.cooldownMs = cooldownMs;
  }

  // Try to get a different account
  if (accountManager && accountManager.getAccountCount() > 0) {
    const nextAccount = accountManager.getCurrentAccount();
    if (nextAccount && nextAccount.index !== account?.index) {
      result.switched = true;
      result.nextAccount = nextAccount;
    }
  }

  return result;
}

/**
 * Extract cache source hashes from a request body.
 * Hashes system prompt blocks and tool schemas to identify what changed.
 *
 * @param {string} bodyStr - JSON request body
 * @returns {Map<string, string>} source_id → hash
 */
/**
 * Read a single incoming request header by name (case-insensitive) from either a
 * `Request` input or a fetch `init.headers` (Headers | array | plain object).
 * Returns the trimmed value or null. Used to detect opencode's subagent marker
 * `x-parent-session-id` without consuming/normalizing the full header set.
 * @param {any} input
 * @param {any} requestInit
 * @param {string} name
 * @returns {string | null}
 */
function getIncomingHeader(input, requestInit, name) {
  const lower = name.toLowerCase();
  const pick = (v) => (v != null && String(v).trim() !== "" ? String(v).trim() : null);
  try {
    if (input && typeof input === "object" && input.headers && typeof input.headers.get === "function") {
      const v = pick(input.headers.get(name));
      if (v) return v;
    }
  } catch {
    // malformed Request — fall through to init.headers
  }
  const h = requestInit?.headers;
  if (!h) return null;
  try {
    if (typeof h.get === "function") return pick(h.get(name));
    if (Array.isArray(h)) {
      for (const pair of h) {
        if (Array.isArray(pair) && String(pair[0]).toLowerCase() === lower) return pick(pair[1]);
      }
      return null;
    }
    for (const [k, v] of Object.entries(h)) {
      if (k.toLowerCase() === lower) return pick(v);
    }
  } catch {
    // unexpected header shape — treat as absent
  }
  return null;
}

function extractCacheSourceHashes(bodyStr, parsedBody = undefined) {
  const hashes = new Map();
  try {
    const parsed = parsedBody ?? JSON.parse(bodyStr);

    // Hash system prompt (excluding token budget blocks injected by injectTokenBudgetBlock)
    if (Array.isArray(parsed.system)) {
      const systemText = parsed.system
        .filter((b) => !(b.text && b.text.startsWith("Token budget:")))
        .map((b) => b.text || "")
        .join("");
      if (systemText) hashes.set("system_prompt", hashCacheSource(systemText));
    } else if (typeof parsed.system === "string" && parsed.system) {
      hashes.set("system_prompt", hashCacheSource(parsed.system));
    }

    // Hash tool schemas (by name)
    if (Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.name) {
          hashes.set(`tool:${tool.name}`, hashCacheSource(JSON.stringify(tool)));
        }
      }
    }

    // Hash messages prefix (everything except the last message) so we can
    // detect when the conversation history prefix changes byte-for-byte
    // between turns — a common cause of prompt-cache invalidation that
    // system_prompt/tool hashes alone don't explain.
    if (Array.isArray(parsed.messages) && parsed.messages.length > 1) {
      const prefix = parsed.messages.slice(0, -1);
      // Strip cache_control markers before hashing — they're legitimately
      // re-stamped each turn and shouldn't trigger a false positive.
      const normalized = prefix.map((m) => {
        if (!Array.isArray(m.content)) return m;
        return {
          ...m,
          content: m.content.map((b) => {
            if (b && typeof b === "object" && b.cache_control) {
              const { cache_control: _cc, ...rest } = b;
              return rest;
            }
            return b;
          }),
        };
      });
      hashes.set("messages_prefix", hashCacheSource(JSON.stringify(normalized)));
    }
  } catch {
    // Ignore parse errors
  }

  // LRU eviction: cap at 10 entries
  if (hashes.size > 10) {
    const entries = [...hashes.entries()];
    return new Map(entries.slice(entries.length - 10));
  }
  return hashes;
}

/**
 * Detect cache break by comparing current vs previous source hashes.
 * @param {Map<string, string>} currentHashes
 * @param {Map<string, string>} previousHashes
 * @returns {string[]} Names of changed sources, or empty array
 */
function detectCacheBreakSources(currentHashes, previousHashes) {
  if (previousHashes.size === 0) return []; // No baseline yet
  const changed = [];
  for (const [key, hash] of currentHashes) {
    const prev = previousHashes.get(key);
    if (prev && prev !== hash) {
      changed.push(key);
    }
  }
  // Check for removed sources
  for (const key of previousHashes.keys()) {
    if (!currentHashes.has(key)) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Parse the structured context limit error message from the Anthropic API.
 * @param {string | null | undefined} msg - Error body text
 * @returns {{ input: number, maxTokens: number, limit: number } | null}
 */
function parseContextLimitError(msg) {
  if (!msg || typeof msg !== "string") return null;
  const m = msg.match(/input length and `max_tokens` exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
  if (!m) return null;
  return { input: +m[1], maxTokens: +m[2], limit: +m[3] };
}

/**
 * Compute a safe max_tokens value that fits within the context limit.
 * @param {number} input - Input token count from error
 * @param {number} limit - Context window limit from error
 * @param {number} [margin=1000] - Safety margin to subtract
 * @returns {number}
 */
function computeSafeMaxTokens(input, limit, margin = 1000) {
  return Math.max(1, limit - input - margin);
}

/**
 * Detect whether the environment uses a proxy or custom mTLS configuration.
 * Pure predicate — no side effects.
 * @returns {boolean}
 */
function isProxyOrMtlsEnvironment() {
  const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"];
  const mtlsVars = ["NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE"];
  for (const v of proxyVars) {
    if (process.env[v]) return true;
  }
  for (const v of mtlsVars) {
    if (process.env[v]) return true;
  }
  return false;
}

/**
 * Fire-and-forget HEAD request to pre-warm TCP+TLS connection pool.
 * Skips in proxy/mTLS environments where the HEAD may be intercepted.
 * @param {import('./lib/config.mjs').AnthropicAuthConfig} config
 */
async function preconnectApi(config) {
  if (!config.preconnect?.enabled) return;
  if (isProxyOrMtlsEnvironment()) return;
  try {
    await Promise.race([
      globalThis.fetch("https://api.anthropic.com", { method: "HEAD" }),
      new Promise((_, r) =>
        setTimeout(() => r(new Error("preconnect timeout")), config.preconnect.timeout_ms ?? 10_000),
      ),
    ]);
  } catch {
    /* fire-and-forget — never throws */
  }
}

/**
 * Classify an API request as foreground (user-initiated) or background
 * (title generation, speculation). Background requests receive a reduced
 * retry budget to preserve quota for user-facing work.
 *
 * @param {object|string} body - Parsed request body (or raw string to parse)
 * @returns {"foreground" | "background"}
 */
function classifyApiRequest(body) {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== "object") return "foreground";

    const msgCount = parsed.messages?.length ?? 0;
    const maxToks = parsed.max_tokens ?? 99999;

    // Title generation signal: system prompt contains "Generate a short title"
    const systemBlocks = Array.isArray(parsed.system) ? parsed.system : [];
    const hasTitleSignal = systemBlocks.some(
      (b) => typeof b.text === "string" && b.text.includes("Generate a short title"),
    );

    // Background: title generation OR very short context with tiny output
    if (hasTitleSignal) return "background";
    if (msgCount <= 2 && maxToks <= 256) return "background";

    return "foreground";
  } catch {
    return "foreground"; // Parse error → safe default
  }
}

/**
 * Detect diminishing returns: ≥3 continuations AND last 3 output deltas all < 500 tokens.
 *
 * @param {number[]} outputHistory - Recent output token deltas
 * @returns {boolean}
 */
function detectDiminishingReturns(outputHistory) {
  if (!Array.isArray(outputHistory) || outputHistory.length < 3) return false;
  const last3 = outputHistory.slice(-3);
  return last3.every((d) => d < 500);
}

/**
 * Estimate prompt token count from the raw request body string.
 * Uses a 4-character-per-token heuristic (conservative for English + code).
 * @param {string} bodyString - JSON string of the request body
 * @returns {number} Estimated token count
 */
function estimatePromptTokens(bodyString) {
  if (!bodyString || typeof bodyString !== "string") return 0;
  try {
    const parsed = JSON.parse(bodyString);
    return estimatePromptTokensFromParsed(parsed);
  } catch {
    // Fallback: raw body length / 4 if JSON parsing fails
    return Math.ceil(bodyString.length / 4);
  }
}

/**
 * Analyze a request body to produce a token breakdown by role and tool.
 * Used by `/anthropic context` command.
 *
 * @param {string} bodyStr - JSON request body string
 * @returns {{ systemTokens: number, userTokens: number, assistantTokens: number, toolResultTokens: number, toolBreakdown: Record<string, { tokens: number, count: number }>, totalTokens: number, duplicates: { count: number, wastedTokens: number } }}
 */
function analyzeRequestContext(bodyStr) {
  const result = {
    systemTokens: 0,
    userTokens: 0,
    assistantTokens: 0,
    toolResultTokens: 0,
    toolBreakdown: /** @type {Record<string, { tokens: number, count: number }>} */ ({}),
    totalTokens: 0,
    duplicates: { count: 0, wastedTokens: 0 },
  };

  if (!bodyStr || typeof bodyStr !== "string") return result;

  try {
    const parsed = JSON.parse(bodyStr);
    const contentHashes = new Map(); // hash → { tokens, count }

    // Estimate tokens from a string (4 chars/token heuristic)
    const estimateTokens = (/** @type {string} */ s) => Math.ceil((s || "").length / 4);

    // System prompt
    if (Array.isArray(parsed.system)) {
      for (const block of parsed.system) {
        if (block.type === "text" && typeof block.text === "string") {
          result.systemTokens += estimateTokens(block.text);
        }
      }
    } else if (typeof parsed.system === "string") {
      result.systemTokens += estimateTokens(parsed.system);
    }

    // Messages
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        const role = msg.role || "unknown";
        const blocks =
          typeof msg.content === "string"
            ? [{ type: "text", text: msg.content }]
            : Array.isArray(msg.content)
              ? msg.content
              : [];

        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            const tokens = estimateTokens(block.text);
            if (role === "user") result.userTokens += tokens;
            else if (role === "assistant") result.assistantTokens += tokens;
          } else if (block.type === "tool_result") {
            // tool_result content can be string or array of content blocks
            let content = "";
            if (typeof block.content === "string") {
              content = block.content;
            } else if (Array.isArray(block.content)) {
              content = block.content.map((b) => b.text || "").join("");
            }
            const tokens = estimateTokens(content);
            result.toolResultTokens += tokens;
            result.userTokens += tokens; // tool_result is part of user turn

            // Group by tool_name (may be on the block or need to look up from tool_use_id)
            const toolName = block.tool_name || block.name || "unknown_tool";
            if (!result.toolBreakdown[toolName]) {
              result.toolBreakdown[toolName] = { tokens: 0, count: 0 };
            }
            result.toolBreakdown[toolName].tokens += tokens;
            result.toolBreakdown[toolName].count += 1;

            // Duplicate detection via content hash
            if (content.length > 0) {
              const hash = createHashCrypto("sha256").update(content).digest("hex").slice(0, 16);
              const existing = contentHashes.get(hash);
              if (existing) {
                existing.count += 1;
                result.duplicates.count += 1;
                result.duplicates.wastedTokens += tokens;
              } else {
                contentHashes.set(hash, { tokens, count: 1 });
              }
            }
          } else if (block.type === "tool_use") {
            const tokens = estimateTokens(JSON.stringify(block.input || {}));
            if (role === "assistant") result.assistantTokens += tokens;
          }
        }
      }
    }

    result.totalTokens = result.systemTokens + result.userTokens + result.assistantTokens;
  } catch {
    // Malformed JSON — return zeroes
  }

  return result;
}

/**
 * Decide whether to include the context-1m beta for this request.
 * Returns true if 1M context should be activated.
 *
 * Decision logic:
 *   - If adaptive_context is disabled, defer to hasOneMillionContext(model) as before.
 *   - If model does not support 1M context, always false.
 *   - Escalate when estimated prompt tokens exceed escalation_threshold.
 *   - De-escalate when estimated prompt tokens drop below deescalation_threshold.
 *   - Never de-escalate if escalation was triggered by a prompt_too_long error
 *     (sticky until session compacts or drops far below threshold).
 *   - Hysteresis: require at least 2 turns between transitions to avoid flapping.
 *
 * @param {string} bodyString - JSON request body
 * @param {string} model - Model ID
 * @param {import('./lib/config.mjs').AdaptiveContextConfig} adaptiveConfig
 * @returns {boolean}
 */
function resolveAdaptiveContext(bodyString, model, adaptiveConfig, parsedBody) {
  // Non-adaptive: use static check (only explicit "1m" models)
  if (!adaptiveConfig.enabled) {
    return hasOneMillionContext(model);
  }

  // If experimental betas are disabled, context-1m will be stripped anyway — skip adaptive logic
  if (isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return false;
  }

  // Model must be eligible for 1M context at all (includes Opus 4.6)
  if (!isEligibleFor1MContext(model)) {
    return false;
  }

  const estimatedTokens = parsedBody ? estimatePromptTokensFromParsed(parsedBody) : estimatePromptTokens(bodyString);
  const turnsSinceTransition = sessionMetrics.turns - adaptiveContextState.lastTransitionTurn;

  if (adaptiveContextState.active) {
    // Currently active — consider de-escalation

    // Error-escalated: sticky for ERROR_STICKY_TURNS turns, then allow de-escalation
    // if prompt has dropped well below threshold (prevents permanent 1M lock-in).
    const ERROR_STICKY_TURNS = 5;
    if (adaptiveContextState.escalatedByError) {
      if (turnsSinceTransition < ERROR_STICKY_TURNS) {
        return true; // Still within sticky window
      }
      // Past sticky window: allow de-escalation if tokens dropped significantly
      // (below 75% of deescalation threshold to avoid flapping)
      if (estimatedTokens < adaptiveConfig.deescalation_threshold * 0.75) {
        adaptiveContextState.active = false;
        adaptiveContextState.escalatedByError = false;
        adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
        return false;
      }
      return true; // Still high enough to keep 1M
    }

    // Hysteresis: require at least 2 turns before considering de-escalation
    if (turnsSinceTransition < 2) {
      return true;
    }
    if (estimatedTokens < adaptiveConfig.deescalation_threshold) {
      // De-escalate
      adaptiveContextState.active = false;
      adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
      return false;
    }
    return true;
  } else {
    // Currently inactive — consider escalation
    // Symmetric hysteresis: require at least 2 turns before re-escalation too
    if (turnsSinceTransition < 2 && adaptiveContextState.lastTransitionTurn > 0) {
      return false;
    }
    if (estimatedTokens > adaptiveConfig.escalation_threshold) {
      // Escalate
      adaptiveContextState.active = true;
      adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
      return true;
    }
    return false;
  }
}

/**
 * Force-escalate adaptive context (e.g. after prompt_too_long error).
 * Returns true so callers can invalidate cached decisions.
 * @returns {boolean}
 */
function forceEscalateAdaptiveContext() {
  const wasActive = adaptiveContextState.active;
  if (!adaptiveContextState.active) {
    adaptiveContextState.active = true;
    adaptiveContextState.lastTransitionTurn = sessionMetrics.turns;
  }
  adaptiveContextState.escalatedByError = true;
  return !wasActive; // true if state actually changed
}

const MODEL_PRICING = {
  // Opus 4.8 (launched 2026-05-28): $5/$25 per 1M (input/output), notably
  // cheaper than 4.6/4.7. cacheRead = 0.1x input, cacheWrite = 1.25x input
  // (Anthropic's standard 5m-write ratio).
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
};
const DEFAULT_PRICING = MODEL_PRICING["claude-sonnet-4-6"];

/**
 * Get pricing for a model, falling back to sonnet pricing for unknown models.
 * @param {string} model
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}}
 */
function getModelPricing(model) {
  if (!model) return DEFAULT_PRICING;
  // Prefix match: "claude-opus-4-6-20260101" matches "claude-opus-4-6"
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return DEFAULT_PRICING;
}

/**
 * Calculate the cost in USD for a set of token counts.
 * @param {UsageStats} usage
 * @param {string} model
 * @returns {number}
 */
function calculateCostUsd(usage, model) {
  const p = getModelPricing(model);
  return (
    ((usage.inputTokens || 0) / 1_000_000) * p.input +
    ((usage.outputTokens || 0) / 1_000_000) * p.output +
    ((usage.cacheReadTokens || 0) / 1_000_000) * p.cacheRead +
    ((usage.cacheWriteTokens || 0) / 1_000_000) * p.cacheWrite
  );
}

/**
 * Calculate cost breakdown by category.
 * @param {UsageStats} usage
 * @param {string} model
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}}
 */
function calculateCostBreakdown(usage, model) {
  const p = getModelPricing(model);
  return {
    input: ((usage.inputTokens || 0) / 1_000_000) * p.input,
    output: ((usage.outputTokens || 0) / 1_000_000) * p.output,
    cacheRead: ((usage.cacheReadTokens || 0) / 1_000_000) * p.cacheRead,
    cacheWrite: ((usage.cacheWriteTokens || 0) / 1_000_000) * p.cacheWrite,
  };
}

/**
 * Update session metrics after a completed turn.
 * @param {UsageStats} usage
 * @param {string} model
 */
function updateSessionMetrics(usage, model) {
  sessionMetrics.turns += 1;
  sessionMetrics.totalInput += usage.inputTokens;
  sessionMetrics.totalOutput += usage.outputTokens;
  sessionMetrics.totalCacheRead += usage.cacheReadTokens;
  sessionMetrics.totalCacheWrite += usage.cacheWriteTokens;
  sessionMetrics.totalWebSearchRequests += usage.webSearchRequests || 0;

  // Cache hit rate for this turn
  const totalPrompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const hitRate = totalPrompt > 0 ? usage.cacheReadTokens / totalPrompt : 0;
  sessionMetrics.recentCacheRates.push(hitRate);
  if (sessionMetrics.recentCacheRates.length > 5) {
    sessionMetrics.recentCacheRates.shift();
  }

  // Cost breakdown
  const breakdown = calculateCostBreakdown(usage, model);
  sessionMetrics.costBreakdown.input += breakdown.input;
  sessionMetrics.costBreakdown.output += breakdown.output;
  sessionMetrics.costBreakdown.cacheRead += breakdown.cacheRead;
  sessionMetrics.costBreakdown.cacheWrite += breakdown.cacheWrite;

  // Total cost
  sessionMetrics.sessionCostUsd += calculateCostUsd(usage, model);

  // Per-model breakdown
  if (model) {
    if (!sessionMetrics.perModel[model]) {
      sessionMetrics.perModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 };
    }
    const pm = sessionMetrics.perModel[model];
    pm.input += usage.inputTokens;
    pm.output += usage.outputTokens;
    pm.cacheRead += usage.cacheReadTokens;
    pm.cacheWrite += usage.cacheWriteTokens;
    pm.costUsd += calculateCostUsd(usage, model);
    pm.turns += 1;
    sessionMetrics.lastModelId = model;
  }

  // Write cache transparency stats to disk for TUI consumption.
  writeCacheStatsFile(usage, model, hitRate);

  // Token budget tracking (A9)
  if (sessionMetrics.tokenBudget.limit > 0) {
    sessionMetrics.tokenBudget.used += usage.outputTokens;
    sessionMetrics.tokenBudget.continuations += 1;
    sessionMetrics.tokenBudget.outputHistory.push(usage.outputTokens);
    if (sessionMetrics.tokenBudget.outputHistory.length > 5) {
      sessionMetrics.tokenBudget.outputHistory.shift();
    }
  }
}

/**
 * Write cache transparency stats to a well-known JSON file for TUI consumption.
 * The OpenCode TUI watches this file to display cache metrics in the status bar.
 * @param {UsageStats} usage - Current turn usage
 * @param {string} model - Model used
 * @param {number} hitRate - Cache hit rate for this turn (0-1)
 */
function writeCacheStatsFile(usage, model, hitRate) {
  try {
    const statsPath = join(getConfigDir(), "cache-stats.json");
    const avgHitRate = getAverageCacheHitRate();
    const totalPrompt = sessionMetrics.totalInput + sessionMetrics.totalCacheRead + sessionMetrics.totalCacheWrite;
    const sessionHitRate = totalPrompt > 0 ? sessionMetrics.totalCacheRead / totalPrompt : 0;

    // Calculate cache savings in USD
    const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-opus-4-6"] || { input: 15, cacheRead: 1.5 };
    const savedPerMToken = pricing.input - (pricing.cacheRead || pricing.input * 0.1);
    const sessionSavingsUsd = (sessionMetrics.totalCacheRead / 1_000_000) * savedPerMToken;

    const stats = {
      // Per-turn stats (latest request)
      turn: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        cache_hit_rate: Math.round(hitRate * 1000) / 1000,
        model,
      },
      // Session-level stats
      session: {
        turns: sessionMetrics.turns,
        total_input: sessionMetrics.totalInput,
        total_output: sessionMetrics.totalOutput,
        total_cache_read: sessionMetrics.totalCacheRead,
        total_cache_write: sessionMetrics.totalCacheWrite,
        session_hit_rate: Math.round(sessionHitRate * 1000) / 1000,
        avg_recent_hit_rate: Math.round(avgHitRate * 1000) / 1000,
        cost_usd: Math.round(sessionMetrics.sessionCostUsd * 10000) / 10000,
        cache_savings_usd: Math.round(sessionSavingsUsd * 10000) / 10000,
      },
      // Config state
      config: {
        cache_ttl: _pluginConfig?.cache_policy?.ttl ?? "1h",
        boundary_marker: _pluginConfig?.cache_policy?.boundary_marker ?? false,
        anti_verbosity: _pluginConfig?.anti_verbosity?.enabled !== false,
      },
      timestamp: new Date().toISOString(),
    };

    writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  } catch {
    // Non-critical — silently ignore write failures
  }
}

// --- Phase 5: Auto-strategy adaptation ---
// strategyState is created per-plugin instance inside AnthropicAuthPlugin() to avoid
// cross-instance pollution (critical for test isolation and multi-instance scenarios).
// See createStrategyState() below.

// --- Phase 5: Minimal telemetry emulation ("Silent Observer") ---

// Host telemetry payload only (ClaudeCodeInternalEvent env block) — never sent
// on /v1/messages, so it is not part of the wire-compat surface.
// Real build markers extracted from the 2.1.195 native binary (Bun-embedded JS):
// `BUILD_TIME:"2026-06-26T01:00:56Z"`.
const CLAUDE_CODE_BUILD_TIME = "2026-06-26T01:00:56Z";

class TelemetryEmitter {
  #enabled = false;
  #sent = false;
  #disabled = false; // permanently disabled for this session (on auth failure)
  #deviceId = null;
  #sessionId = null;
  #cliVersion = null;
  #accountUuid = "";
  #orgUuid = "";

  constructor() {
    this.#sessionId = randomUUID();
  }

  /**
   * Initialize with session context. Call once config and accounts are ready.
   * @param {object} opts
   * @param {boolean} opts.enabled
   * @param {string} opts.deviceId
   * @param {string} opts.cliVersion
   * @param {string} [opts.accountUuid]
   * @param {string} [opts.orgUuid]
   * @param {string} [opts.sessionId] - Must match signatureSessionId for correlation
   */
  init({ enabled, deviceId, cliVersion, accountUuid, orgUuid, sessionId }) {
    this.#enabled = enabled;
    this.#deviceId = deviceId;
    this.#cliVersion = cliVersion;
    this.#accountUuid = accountUuid || "";
    this.#orgUuid = orgUuid || "";
    if (sessionId) this.#sessionId = sessionId;
  }

  /**
   * Build a ClaudeCodeInternalEvent matching the schema from reverse-engineering.
   * @param {string} eventName
   * @param {object} [extras]
   * @returns {object}
   */
  #buildEvent(eventName, extras = {}) {
    return {
      event_type: "ClaudeCodeInternalEvent",
      event_data: {
        event_id: randomUUID(),
        event_name: eventName,
        client_timestamp: new Date().toISOString(),
        device_id: this.#deviceId,
        email: "", // RE doc §7.2 — present but empty (privacy: don't leak email in telemetry)
        auth: {
          account_uuid: this.#accountUuid,
          organization_uuid: this.#orgUuid,
        },
        core: {
          session_id: this.#sessionId,
          model: "", // empty — don't reveal model choice
          user_type: "consumer", // RE doc §7.2 — default consumer for Claude.ai OAuth
          client_type: "cli", // RE doc §7.2 — always cli
          betas: [], // RE doc §7.2 — populated at send time if needed
          is_interactive: true,
          entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || "cli",
        },
        env: {
          platform: process.platform,
          arch: process.arch,
          node_version: process.version,
          terminal: process.env.TERM_PROGRAM || process.env.TERM || "",
          version: this.#cliVersion,
          build_time: CLAUDE_CODE_BUILD_TIME,
          is_ci: false,
        },
        ...extras,
      },
    };
  }

  /**
   * Send a batch of events to the telemetry endpoint.
   * @param {object[]} events
   * @param {string} accessToken
   * @returns {Promise<boolean>}
   */
  async #sendBatch(events, accessToken) {
    if (!accessToken || events.length === 0) return false;

    try {
      const response = await fetch("https://api.anthropic.com/api/event_logging/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "anthropic-version": "2023-06-01",
          "User-Agent": `claude-code/${this.#cliVersion}`,
          "x-service-name": "claude-code",
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (response.status === 401 || response.status === 403) {
        this.#disabled = true;
        return false;
      }
      if (response.status === 400) {
        this.#disabled = true;
        return false;
      }
      return response.ok;
    } catch {
      // Network error — don't retry, don't disable
      return false;
    }
  }

  /**
   * Send startup events after first successful API response.
   * Called once per session with random jitter.
   * @param {string} accessToken
   */
  async sendStartupEvents(accessToken) {
    if (!this.#enabled || this.#sent || this.#disabled) return;
    this.#sent = true;

    // Random jitter: 500ms - 2000ms after first successful response
    const jitter = 500 + Math.random() * 1500;
    await new Promise((resolve) => setTimeout(resolve, jitter));

    if (this.#disabled) return;

    const startedEvent = this.#buildEvent("tengu_started");
    const startupTelemetryEvent = this.#buildEvent("tengu_startup_telemetry", {
      is_git: true,
      sandbox_enabled: false,
    });

    await this.#sendBatch([startedEvent, startupTelemetryEvent], accessToken);
  }

  /**
   * Send exit event on shutdown. Best-effort, no retry.
   * @param {string} accessToken
   * @param {number} sessionDurationMs
   */
  async sendExitEvent(accessToken, sessionDurationMs) {
    if (!this.#enabled || !this.#sent || this.#disabled) return;

    const exitEvent = this.#buildEvent("tengu_exit", {
      last_session_duration: sessionDurationMs,
      last_session_id: this.#sessionId,
    });

    // Best-effort, short timeout
    await this.#sendBatch([exitEvent], accessToken).catch(() => {});
  }

  get sessionId() {
    return this.#sessionId;
  }
  get enabled() {
    return this.#enabled && !this.#disabled;
  }
}

const telemetryEmitter = new TelemetryEmitter();
const SESSION_START_TIME = Date.now();
/** @type {{ token: string }} Mutable ref to latest live access token for exit telemetry */
const liveTokenRef = { token: "" };

// Best-effort exit telemetry (QA fix M10: use 'once' to prevent listener stacking on re-import)
// QA fix L-beforeExit: store handler reference for cleanup; prevents leaked refs to telemetryEmitter
const _beforeExitHandler = () => {
  const duration = Date.now() - SESSION_START_TIME;
  telemetryEmitter.sendExitEvent(liveTokenRef.token, duration).catch(() => {});
};
process.once("beforeExit", _beforeExitHandler);

// ---------------------------------------------------------------------------
// Request building helpers (extracted from original fetch interceptor)
// ---------------------------------------------------------------------------

/**
 * Extract the text content of the first user message for billing hash computation.
 * @param {any[] | undefined} messages
 * @returns {string}
 */
/**
 * Strip leaked /anthropic slash command messages from conversation history.
 *
 * When a user runs `/anthropic <subcommand>`, OpenCode may still include the
 * command text as a user message and the sendCommandMessage output as an
 * assistant message in the API request. This function removes those messages
 * so the model never sees internal plugin commands in its context.
 *
 * Detection heuristics:
 * - User messages that start with `/anthropic` (with optional leading whitespace)
 * - User messages where the ONLY text content is a `/anthropic` command
 * - Assistant messages that start with the `▣ Anthropic` prefix used by sendCommandMessage
 *
 * After filtering, if the last remaining message is an assistant message, drop it
 * to maintain the user→assistant alternation required by the API.
 *
 * @param {Array} messages — The messages array from the parsed request body
 * @returns {Array} — Filtered messages array
 */

/**
 * Repair orphaned tool_use blocks in the message array.
 *
 * The Anthropic API requires that every assistant message containing `tool_use`
 * blocks is immediately followed by a user message with `tool_result` blocks
 * for each tool_use ID. When OpenCode crashes or hangs mid-tool-execution, the
 * conversation may be persisted with assistant tool_use blocks that lack
 * corresponding tool_result responses, causing:
 *
 *   "messages.N: `tool_use` ids were found without `tool_result` blocks
 *    immediately after: toolu_XXXXX"
 *
 * This function scans the entire message array and inserts synthetic
 * tool_result user messages wherever they are missing.
 *
 * @param {Array} messages — The messages array from the parsed request body
 * @returns {Array} — Repaired messages array
 */

const _ADVANCED_TOOL_USE_BETA_FLAG = "advanced-tool-use-2025-11-20";
// OpenCode SDK betas that leak through the host's Anthropic SDK but are NOT
// part of CC's beta vocabulary. Filtered out when signature emulation is on.
const USER_ID_STORAGE_FILE = "anthropic-signature-user-id";
const DEBUG_SYSTEM_PROMPT_ENV = "OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT";
/**
 * Returns the persistent device ID (64-char hex string).
 * Migrates legacy UUID-format values to the new 64-hex format automatically.
 * @returns {string}
 */
function getOrCreateDeviceId() {
  const configDir = getConfigDir();
  const userIdPath = join(configDir, USER_ID_STORAGE_FILE);

  try {
    if (existsSync(userIdPath)) {
      const existing = readFileSync(userIdPath, "utf-8").trim();
      if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
    }
  } catch {
    // fall through and generate a new id
  }

  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(userIdPath, `${generated}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Ignore filesystem errors; caller still gets generated ID for this runtime.
  }
  return generated;
}

/**
 * @returns {boolean}
 */
function shouldDebugSystemPrompt() {
  return isTruthyEnv(process.env[DEBUG_SYSTEM_PROMPT_ENV]);
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
/**
 * @returns {boolean}
 */

/**
 * @returns {Record<string, string>}
 */

/**
 * @param {string | undefined} model
 * @returns {string | undefined}
 */
function logTransformedSystemPrompt(body) {
  if (!shouldDebugSystemPrompt()) return;
  if (!body || typeof body !== "string") return;

  try {
    const parsed = JSON.parse(body);
    if (!Object.prototype.hasOwnProperty.call(parsed, "system")) return;
    if (isTitleGeneratorSystemBlocks(normalizeSystemTextBlocks(parsed.system))) return;
    console.error(
      "[opencode-anthropic-auth][system-debug] transformed system:",
      JSON.stringify(parsed.system, null, 2),
    );
  } catch {
    // Ignore parse errors in debug logging path.
  }
}

/**
 * @param {string | undefined} body
 * @returns {boolean}
 */

/**
 * @param {string | undefined} body
 * @returns {boolean}
 */

/**
 * @param {string | undefined} body
 * @returns {boolean}
 */

/**
 * @param {URL | null} requestUrl
 * @returns {"anthropic" | "bedrock" | "vertex" | "foundry" | "anthropicAws" | "mantle"}
 */

/**
 * Classify a request by inferred role, mirroring CC's `querySource` gate.
 * CC gates features like context-hint on `querySource.startsWith("repl_main_thread")`.
 * We don't have that string on the wire, so we infer from body shape.
 *
 * Returns one of:
 *   - "main"   → interactive main thread (long system, normal max_tokens, messages present)
 *   - "title"  → title / name generation (tiny max_tokens, 1 message)
 *   - "small"  → short background query (small max_tokens but not title)
 *   - "empty"  → pre-warm / no messages
 *   - "unknown" → treat as main for safety
 *
 * @param {any} parsed Parsed request body
 * @returns {"main"|"title"|"small"|"empty"|"unknown"}
 */
function classifyRequestRole(parsed) {
  if (!parsed || typeof parsed !== "object") return "unknown";
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const maxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : null;

  if (messages.length === 0) return "empty";
  if (maxTokens != null) {
    if (maxTokens <= 256 && messages.length <= 2) return "title";
    if (maxTokens <= 1024) return "small";
  }
  // System prompt length heuristic
  let sysLen = 0;
  if (typeof parsed.system === "string") {
    sysLen = parsed.system.length;
  } else if (Array.isArray(parsed.system)) {
    for (const s of parsed.system) {
      if (s && typeof s.text === "string") sysLen += s.text.length;
    }
  }
  if (sysLen < 200 && messages.length <= 2 && (maxTokens == null || maxTokens <= 2048)) {
    return "small";
  }
  return "main";
}

/**
 * @param {any} body
 * @returns {{model: string, tools: any[], messages: any[], hasFileReferences: boolean}}
 */

/**
 * @param {any[]} tools
 * @param {any[]} messages
 * @returns {string}
 */

/**
 * @param {{id?: string, accountUuid?: string} | null | undefined} account
 * @returns {string}
 */
function getAccountIdentifier(account) {
  // Prefer env-provided account UUID (v2.1.51+), then account record fields
  const envUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID?.trim();
  if (envUuid) return envUuid;
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

/**
 * @param {string} incomingBeta
 * @param {boolean} signatureEnabled
 * @param {string} model
 * @param {"anthropic" | "bedrock" | "vertex" | "foundry" | "anthropicAws" | "mantle"} provider
 * @param {string[]} [customBetas]
 * @param {import('./lib/config.mjs').AccountSelectionStrategy} [strategy]
 * @param {string} [requestPath]
 * @param {boolean} [hasFileReferences]
 * @param {{ use1MContext?: boolean }} [adaptiveOverride] - When set, overrides the static hasOneMillionContext() check.
 * @param {boolean} [fastModeActive] - When true, emits FAST_MODE_BETA_FLAG (fast-mode-2026-02-01).
 *   Must be derived structurally from the already-transformed outgoing body (body.includes('"speed":"fast"')).
 *   Only passed from the buildRequestHeaders call site (after body transform). The pre-transform
 *   `computedBetaHeader` call site leaves it undefined, which is correct: at that point the body
 *   transform has not run, so `speed:"fast"` cannot be present yet and the value would be a
 *   guess. That header value no longer reaches the wire in any case — it feeds only the
 *   `task-budgets-2026-03-13` check in transformRequestBody.
 * @returns {string}
 */
// Mirrors CC's Kw(model) effort eligibility: returns false for claude-3-* and the
// explicit older 4.x exclusion set (opus-4-0/4-1, sonnet-4-0/4-5, haiku-4-5), true
// for every other model (effort-capable: Opus 4.5/4.6/4.7/4.8, Sonnet 4.6, etc.).

/** @typedef {'low' | 'medium' | 'high'} ThinkingEffort */

// QA fix L3: budgetTokensToEffort() removed — dead code, never called
// QA fix L4: isValidEffort() removed — dead code, never called

/**
 * Normalise the `thinking` block in the request body for the target model:
 * - Opus 4.6 / 4.7 / 4.8 / Sonnet 4.6 (adaptive thinking): produces
 *   `{ type: "adaptive" }`. This is REQUIRED for Opus 4.7/4.8 — manual
 *   `{ type: "enabled", budget_tokens }` returns a 400 on those models.
 * - Older models: passes the existing thinking block through unchanged.
 *
 * @param {any} thinking
 * @param {string} model
 * @returns {any}
 */
/**
 * Map Node.js platform to Stainless OS header value.
 * @param {NodeJS.Platform} value
 * @returns {string}
 */

/**
 * Normalize Node.js arch to Stainless arch header value.
 * @param {string} value
 * @returns {string}
 */

// Host update polling only (npm registry lookup), not mimicry.
const CLAUDE_CODE_NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

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
 * @param {{enabled: boolean, claudeCliVersion: string, strategy?: import('./lib/config.mjs').AccountSelectionStrategy, customBetas?: string[], sessionId?: string}} signature
 * @returns {Headers}
 */

/**
 * Resolve max_tokens for a request based on output cap configuration.
 * If the caller specified max_tokens, it is preserved. Otherwise, defaults
 * to 8K and escalates to 64K after an output truncation (stop_reason: "max_tokens").
 *
 * @param {Record<string, any>} body - Parsed request body
 * @param {import('./lib/config.mjs').AnthropicAuthConfig} config
 * @returns {number | undefined} Resolved max_tokens value, or undefined for passthrough
 */

/**
 * Transform the request URL: add ?beta=true to /v1/messages and
 * /v1/messages/count_tokens, normalizing a `/messages` path to `/v1/messages`
 * on the way. Preserves behaviors F1-F3.
 *
 * Both of those are CLAUDE CODE SHAPE, so both are gated on `emulateSignature`.
 * The `OPENCODE_MITM_BASE_URL` rewrite is not, and applies either way.
 *
 * @param {any} input
 * @param {boolean} [emulateSignature] Whether signature emulation is on for this
 *   request. Read at the call site rather than here: the config is
 *   runtime-mutable and this function lives outside the plugin closure.
 * @returns {{requestInput: any, requestUrl: URL | null}}
 */
function transformRequestUrl(input, emulateSignature = true) {
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

  // PHASE 2.2 (QA finding 1) — THE URL REWRITE IS MIMICRY, SO IT IS GATED.
  // `?beta=true` is the endpoint the genuine Claude Code client pins, and
  // normalizing `/messages` to `/v1/messages` is the same kind of client-shape
  // assumption. With signature emulation off the plugin forges nothing, and
  // that has to include the URL: the host's URL goes out exactly as the host
  // wrote it. The MITM rewrite below stays unconditional — it is a debug and
  // conformance knob the operator asked for, not a disguise.
  if (emulateSignature && requestUrl && !requestUrl.searchParams.has("beta")) {
    const p = requestUrl.pathname;
    // SDK may send to /messages (base URL includes /v1) or /v1/messages (base URL is root)
    const isMessages =
      p === "/v1/messages" || p === "/messages" || p === "/v1/messages/count_tokens" || p === "/messages/count_tokens";
    if (isMessages) {
      // Normalize path to /v1/messages (required by API and proxies)
      if (!p.startsWith("/v1/")) {
        requestUrl.pathname = "/v1" + p;
      }
      requestUrl.searchParams.set("beta", "true");
      requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
    }
  }

  // MITM proxy redirect: rewrite host/port/protocol when OPENCODE_MITM_BASE_URL is set.
  // This allows capturing the exact over-the-wire request for conformance testing.
  // Example: OPENCODE_MITM_BASE_URL=http://localhost:9999
  const mitmBase = process.env.OPENCODE_MITM_BASE_URL;
  if (mitmBase && requestUrl) {
    try {
      const mitmUrl = new URL(mitmBase);
      requestUrl.protocol = mitmUrl.protocol;
      requestUrl.hostname = mitmUrl.hostname;
      requestUrl.port = mitmUrl.port;
      requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
    } catch {
      // Invalid MITM URL — ignore silently
    }
  }

  return { requestInput, requestUrl };
}

/**
 * @typedef {object} UsageStats
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} [webSearchRequests]
 * @property {string} [lastStopReason]
 */

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
 * @param {string} [correlationId]
 * @returns {Response}
 */
function transformResponse(response, onUsage, onAccountError, correlationId) {
  if (!response.body) return response;
  const idleTimeoutMs = resolveStreamIdleTimeoutMs(_pluginConfig);
  const captureEnabled = _pluginConfig?.token_economy?.debug_dump_bodies === true && Boolean(correlationId);
  const stream = createTransformedSSEStream(response, {
    onUsage,
    onAccountError,
    correlationId,
    idleTimeoutMs,
    captureEnabled,
    writeSseCapture,
  });

  // Inject cache transparency headers (session-level, available before stream completes).
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("x-opencode-cache-hit-rate", String(Math.round(getAverageCacheHitRate() * 1000) / 1000));
  responseHeaders.set("x-opencode-cache-read-total", String(sessionMetrics.totalCacheRead));
  responseHeaders.set("x-opencode-session-cost", String(Math.round(sessionMetrics.sessionCostUsd * 10000) / 10000));
  responseHeaders.set("x-opencode-turns", String(sessionMetrics.turns));
  responseHeaders.set("x-opencode-anti-verbosity", _pluginConfig?.anti_verbosity?.enabled !== false ? "on" : "off");

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
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

// ---------------------------------------------------------------------------
// Token refresh (per-account)
// ---------------------------------------------------------------------------

/**
 * Read the latest auth fields for an account from disk.
 * Another instance may have rotated tokens since we loaded into memory.
 * @param {string} accountId
 * @returns {Promise<{refreshToken: string, access?: string, expires?: number, tokenUpdatedAt: number} | null>}
 */
async function readDiskAccountAuth(accountId) {
  try {
    const diskData = await loadAccounts();
    if (!diskData) return null;
    const diskAccount = diskData.accounts.find((a) => a.id === accountId);
    if (!diskAccount) return null;
    return {
      refreshToken: diskAccount.refreshToken,
      access: diskAccount.access,
      expires: diskAccount.expires,
      tokenUpdatedAt: diskAccount.token_updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * @param {import('./lib/accounts.mjs').ManagedAccount} account
 * @param {number} [now]
 */
function markTokenStateUpdated(account, now = Date.now()) {
  account.tokenUpdatedAt = now;
}

/**
 * Adopt disk auth fields only when disk has fresher token state.
 * @param {import('./lib/accounts.mjs').ManagedAccount} account
 * @param {{refreshToken: string, access?: string, expires?: number, tokenUpdatedAt: number} | null} diskAuth
 * @param {{ allowExpiredFallback?: boolean }} [options]
 * @returns {boolean}
 */
function applyDiskAuthIfFresher(account, diskAuth, options = {}) {
  if (!diskAuth) return false;
  const diskTokenUpdatedAt = diskAuth.tokenUpdatedAt || 0;
  const memTokenUpdatedAt = account.tokenUpdatedAt || 0;
  const diskHasDifferentAuth = diskAuth.refreshToken !== account.refreshToken || diskAuth.access !== account.access;
  const memAuthExpired = !account.expires || account.expires <= Date.now();
  const allowExpiredFallback = options.allowExpiredFallback === true;
  if (diskTokenUpdatedAt <= memTokenUpdatedAt && !(allowExpiredFallback && diskHasDifferentAuth && memAuthExpired)) {
    return false;
  }
  account.refreshToken = diskAuth.refreshToken;
  account.access = diskAuth.access;
  account.expires = diskAuth.expires;
  account.tokenUpdatedAt = Math.max(memTokenUpdatedAt, diskTokenUpdatedAt);
  return true;
}

/**
 * Refresh an account's access token.
 *
 * @param {import('./lib/accounts.mjs').ManagedAccount} account
 * @param {ReturnType<typeof import('@opencode-ai/sdk').createOpencodeClient>} client
 * @param {"foreground" | "idle"} [source]
 * @param {{ onTokensUpdated?: () => Promise<void> }} [options] - If provided,
 *   called under the cross-process lock after token update to persist rotated
 *   tokens before the lock is released.  Omitting means tokens won't be saved
 *   to disk until the caller arranges it (risking the rotation race).
 * @returns {Promise<string>} The new access token
 * @throws {Error} If refresh fails
 */
async function refreshAccountToken(account, client, _source = "foreground", { onTokensUpdated } = {}) {
  // CC-sourced accounts must NEVER enter the OAuth HTTP refresh flow.
  // Instead, re-read credentials from the CC source.  If they're still
  // expired, let the caller handle it (the account will be skipped).
  if (account.source === "cc-keychain" || account.source === "cc-file") {
    const { readCCCredentials } = await import("./lib/cc-credentials.mjs");
    const ccCreds = readCCCredentials();
    const match = ccCreds.find((c) => c.refreshToken === account.refreshToken);
    // Accept CC credential if:
    //   - expiresAt is in the future (normal case), OR
    //   - expiresAt is 0/missing (CC didn't provide expiry — trust the token, let API 401 if stale)
    if (match && (match.expiresAt === 0 || match.expiresAt > Date.now())) {
      account.access = match.accessToken;
      account.expires = match.expiresAt || Date.now() + 3600_000; // default 1h if unknown
      markTokenStateUpdated(account);
      if (onTokensUpdated) {
        try {
          await onTokensUpdated();
        } catch {
          // best-effort
        }
      }
      return account.access;
    }
    // Could not refresh from CC source – token may be stale.
    // Throw so the caller falls through to the next account.
    throw new Error(`CC credential expired (source: ${account.source})`);
  }

  const lockResult = await acquireRefreshLock(account.id, {
    timeoutMs: 2_000,
    backoffMs: 60,
    staleMs: 20_000,
  });
  const lock =
    lockResult && typeof lockResult === "object"
      ? lockResult
      : {
          acquired: true,
          lockPath: null,
          owner: null,
          lockInode: null,
        };

  if (!lock.acquired) {
    const diskAuth = await readDiskAccountAuth(account.id);
    const adopted = applyDiskAuthIfFresher(account, diskAuth, { allowExpiredFallback: true });
    if (adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
    }
    throw new Error("Refresh lock busy");
  }

  try {
    const diskAuthBeforeRefresh = await readDiskAccountAuth(account.id);
    const adopted = applyDiskAuthIfFresher(account, diskAuthBeforeRefresh);
    // Apply fresher disk tokens for both foreground and idle paths — prevents an
    // unnecessary HTTP refresh when another process already rotated the token.
    if (adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
    }

    const json = await refreshToken(account.refreshToken, { signal: AbortSignal.timeout(15_000) });

    account.access = json.access_token;
    account.expires = Date.now() + json.expires_in * 1000;
    if (json.refresh_token) {
      account.refreshToken = json.refresh_token;
    }
    // Extract account UUID from token refresh response if present
    if (json.account?.uuid) {
      account.accountUuid = json.account.uuid;
    }
    if (json.organization?.uuid) {
      account.organizationUuid = json.organization.uuid;
    }
    markTokenStateUpdated(account);

    // Persist new tokens to disk BEFORE releasing the cross-process lock.
    // This is critical: if we release the lock first, another process can
    // acquire it and read the old (now-rotated) refresh token from disk,
    // leading to an invalid_grant failure.  The debounced requestSaveToDisk()
    // that callers used previously left a ~1 s window where this race could
    // (and did) happen.
    if (onTokensUpdated) {
      try {
        await onTokensUpdated();
      } catch {
        // Best-effort: in-memory tokens remain valid for this process.
        // The callback is responsible for scheduling its own fallback
        // (e.g. a debounced retry) if the synchronous save fails.
      }
    }

    // Also persist to OpenCode's auth.json for compatibility.
    // This should be best-effort: a persistence hiccup should not invalidate an
    // otherwise successful refresh token exchange.
    try {
      await client.auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          refresh: account.refreshToken,
          access: account.access,
          expires: account.expires,
        },
      });
    } catch {
      // Ignore persistence errors; in-memory tokens remain valid for this request.
    }

    return json.access_token;
  } finally {
    await releaseRefreshLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

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
 * Extract all file_id values from a parsed Messages API request body.
 * Walks messages and system arrays looking for file content blocks.
 * @param {any} body - Parsed JSON body
 * @returns {string[]}
 */

// Internals exposed for tests only. Do not consume from production code paths.
//
// IMPORTANT: do NOT add a new `export` declaration here. Opencode's plugin
// loader (opencode/packages/opencode/src/plugin/index.ts:74-79) iterates
// `Object.values(mod)` of the loaded module and throws "Plugin export is not
// a function" if ANY export is not a plugin function. A named `export const
// __testing__ = {...}` object would break plugin loading entirely.
//
// Instead, attach the test hooks as a PROPERTY of the exported function.
// Functions are objects in JS, so this is valid. The module surface still
// has only one exported value (the AnthropicAuthPlugin function), which is
// what the loader expects. Tests reach internals via
// `import { AnthropicAuthPlugin } from "./index.mjs"` then
// `AnthropicAuthPlugin.__testing__`.
AnthropicAuthPlugin.__testing__ = {
  sanitizeSystemText,
  compactSystemText,
  compactToolDescription,
  dedupeSystemBlocks,
  normalizeSystemTextBlocks,
  buildSystemPromptBlocks,
  stripMcpPrefixFromParsedEvent,
  CORE_TOOL_NAMES,
  // exposed for subagent-detection tests (x-parent-session-id header extraction)
  getIncomingHeader,
  // exposed for determinism regression tests (phase C1)
  applyContextHintCompaction,
  // exposed for session-dedupe regression tests (phase C3)
  applySessionToolResultDedupe,
  maybeApplySessionToolResultDedupe,
  // exposed for experimental.session.summarize integration tests
  runHaikuSessionSummarize,
  CLAUDE_CODE_IDENTITY_STRING,
  /** Test-only: drive the session turn counter so code paths gated on
   *  `sessionMetrics.turns >= N` can be exercised without a real SSE stream. */
  setSessionTurnsForTest(n) {
    sessionMetrics.turns = n;
  },
  /** Test-only: reset session metrics between tests.
   *  Uses createInitialSessionMetrics() so every tracked field — including
   *  nested objects (lastQuota, perModel, costBreakdown, tokenBudget) and the
   *  usedTools Set — is restored to its initial value. Mutates the existing
   *  sessionMetrics object in place because many module-level references
   *  close over it. */
  resetSessionMetricsForTest() {
    const fresh = createInitialSessionMetrics();
    for (const key of Object.keys(sessionMetrics)) {
      delete sessionMetrics[key];
    }
    Object.assign(sessionMetrics, fresh);
  },
};

/**
 * Internal cache helpers exposed for unit testing only. Not part of the public
 * plugin API. Attached as a PROPERTY of the function for the SAME reason as
 * `__testing__` above: a bare `export const __cacheInternals = {...}` object
 * export breaks Opencode's plugin loader, which iterates `Object.values(mod)`
 * and throws "Plugin export is not a function" on ANY non-function export —
 * silently disabling the whole plugin (no slash command, no OAuth). Tests reach
 * these via `AnthropicAuthPlugin.__cacheInternals`.
 */
AnthropicAuthPlugin.__cacheInternals = {
  resolveCacheTtl,
  shouldPlaceToolBreakpoint,
  updateBoundaryStability,
};

export default AnthropicAuthPlugin;
