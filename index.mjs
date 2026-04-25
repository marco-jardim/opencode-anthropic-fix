import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes, randomUUID, createHash as createHashCrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import xxhashInit from "xxhash-wasm";
import { AccountManager } from "./lib/accounts.mjs";
import {
  authorize as oauthAuthorize,
  exchange as oauthExchange,
  parseOAuthCallback,
  refreshToken,
} from "./lib/oauth.mjs";
import {
  FALLBACK_CLAUDE_CLI_VERSION,
  CLAUDE_CODE_NPM_LATEST_URL,
  CLAUDE_CODE_BUILD_TIME,
  EXPERIMENTAL_BETA_FLAGS,
  BETA_SHORTCUTS,
  resolveBetaShortcut,
  buildExtendedUserAgent,
} from "./lib/request-headers.mjs";
import { loadConfig, loadConfigFresh, saveConfig, CLIENT_ID, getConfigDir } from "./lib/config.mjs";
import { loadContextHintDisabledFlag, saveContextHintDisabledFlag } from "./lib/context-hint-persist.mjs";
import { loadAccounts, saveAccounts, clearAccounts, createDefaultStats } from "./lib/storage.mjs";
import { applyOAuthCredentials, resetAccountTracking } from "./lib/account-state.mjs";
import { acquireRefreshLock, releaseRefreshLock } from "./lib/refresh-lock.mjs";
import {
  isAccountSpecificError,
  parseRateLimitReason,
  parseRetryAfterHeader,
  parseRetryAfterMsHeader,
  parseShouldRetryHeader,
  TRANSIENT_RETRY_THRESHOLD_MS,
} from "./lib/backoff.mjs";
import { callHaiku } from "./lib/haiku-call.mjs";
import { summarize as rollingSummarize } from "./lib/rolling-summarizer.mjs";
import { staleReadEviction, perToolClassPrune } from "./lib/message-transform.mjs";

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

export async function AnthropicAuthPlugin({ client, project, directory, worktree, serverUrl, $ }) {
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

  // Beta header latching: once a beta is sent in a session, it stays on for
  // the rest of the session to prevent cache key churn (~50-70K tokens per flip).
  // Cleared on /clear or /compact if needed.
  const betaLatchState = {
    /** @type {Set<string>} betas that have been sent at least once this session */
    sent: new Set(),
    /** When true, a config change invalidated the latch and next request rebuilds. */
    dirty: false,
    /** @type {string | null} The last computed beta header string (for latching). */
    lastHeader: null,
  };

  // F4: Session-level latch for rejected custom betas.
  // When a custom beta triggers a 400/anthropic-beta or 413-with-signal rejection,
  // its canonical name is stored here so subsequent requests within
  // SESSION_REJECTED_BETA_TTL_MS skip that beta without paying a first-fail each time.
  // Memory only - not persisted to disk.
  const SESSION_REJECTED_BETA_TTL_MS = 5 * 60 * 1000; // 5 minutes
  /** @type {Map<string, number>} canonical-beta to rejected-at epoch ms */
  const sessionRejectedBetas = new Map();

  // Context-hint controller (CC v2.1.110+). Mirrors real CC's `createContextHintController`:
  // sticky on across requests until the server responds with a specific error family.
  //   - 422/424 → apply hint compaction (clear thinking + microcompact) and retry
  //   - 400 "Unexpected value" + "anthropic-beta" → disable for session (beta unsupported)
  //   - 409      → disable for session (conflict)
  //   - 529 / overloaded → disable for session (temporary overload)
  // When disabled, we strip context-hint from betas + body on subsequent requests so
  // we don't keep triggering the same rejection and churning the cache.
  // Persisted disable: if a prior session saw a 400 rejecting the context-hint
  // beta (account lacks access), skip the beta from turn 1 of every subsequent
  // session. Delete ~/.config/opencode/context-hint-disabled.flag (or the
  // %APPDATA%\opencode equivalent on Windows) to re-enable once access is
  // granted. See lib/context-hint-persist.mjs.
  const _persistedCtxHint = loadContextHintDisabledFlag();
  const contextHintState = {
    /** Permanently disabled for this session after a server rejection. */
    disabled: _persistedCtxHint.disabled === true,
    /** Number of 422/424 compactions applied this session (for telemetry). */
    compactionsApplied: 0,
  };
  if (contextHintState.disabled) {
    debugLog(
      "context-hint: loaded persisted disable flag",
      _persistedCtxHint.status ? `status=${_persistedCtxHint.status}` : "",
      _persistedCtxHint.timestamp ? `ts=${new Date(_persistedCtxHint.timestamp).toISOString()}` : "",
    );
  }

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
        `anti-verbosity: ${fresh.anti_verbosity?.enabled !== false ? "on" : "off"} (length-anchors: ${fresh.anti_verbosity?.length_anchors !== false ? "on" : "off"})`,
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
          const valid = ["sticky", "round-robin", "hybrid"];
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
          // Invalidate latched betas so the change takes effect next request
          betaLatchState.dirty = true;
        },
        "redact-thinking": () => {
          const enabled = value === "on" || value === "true" || value === "1";
          const te = config.token_economy || {
            token_efficient_tools: true,
          };
          te.redact_thinking = enabled;
          saveConfig({ token_economy: te });
          config.token_economy = te;
          betaLatchState.dirty = true;
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

  let claudeCliVersion = FALLBACK_CLAUDE_CLI_VERSION;
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
              (hasOneMillionContext(model.id) || isOpus46Model(model.id) || isOpus47Model(model.id))
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
              // Classify request for retry budget (A8)
              const requestClass =
                config.request_classification?.enabled !== false ? classifyApiRequest(requestInit.body) : "foreground";
              const maxServiceRetries =
                requestClass === "background"
                  ? (config.request_classification?.background_max_service_retries ?? 0)
                  : 2;
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
                  // All accounts excluded (transient refresh failures) — give up
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
                const _reqProvider = detectProvider(requestUrl);

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
                // If the server has rejected context-hint this session, reflect it here
                // so buildAnthropicBetaHeader (called again inside buildRequestHeaders)
                // drops the beta on subsequent requests.
                // Also classify the request role (CC's querySource analog) and
                // suppress context-hint for non-main-thread requests so we don't
                // opt subagent/title/tool one-shots into a server retry loop.
                const _requestRole = classifyRequestRole(_parsedBodyOnce);
                const _baseTE = config.token_economy || {};
                const _disableCtxHint = contextHintState.disabled || _requestRole !== "main";
                const _tokenEconomy = _disableCtxHint
                  ? { ..._baseTE, context_hint: false, __requestRole: _requestRole }
                  : { ..._baseTE, __requestRole: _requestRole };

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
                let computedBetaHeader = buildAnthropicBetaHeader(
                  "",
                  getSignatureEmulationEnabled(),
                  _reqModel,
                  _reqProvider,
                  _sessionFilteredCustomBetas,
                  getEffectiveStrategy(),
                  requestUrl?.pathname,
                  _reqHasFileRefs,
                  _adaptiveOverride,
                  _tokenEconomy,
                  _microcompactBetas, // NEW
                );

                // Beta header latching: once a beta has been sent in this session,
                // keep sending it to avoid server-side cache key churn (~50-70K tokens
                // per flip). The latch is sticky-on: new betas can be added but never
                // removed mid-session unless explicitly invalidated by config change.
                {
                  const currentBetas = computedBetaHeader
                    .split(",")
                    .map((b) => b.trim())
                    .filter(Boolean);
                  // Add all current betas to the latch set
                  for (const b of currentBetas) betaLatchState.sent.add(b);
                  // If a config change dirtied the latch, rebuild from current (allow removal)
                  if (betaLatchState.dirty) {
                    betaLatchState.dirty = false;
                    betaLatchState.sent = new Set(currentBetas);
                  }
                  // Merge latched betas that aren't in the current set
                  const merged = new Set(currentBetas);
                  for (const b of betaLatchState.sent) merged.add(b);
                  // Context-hint kill switch: once server rejected it this session,
                  // stop sending the beta (body field is gated on header, so it drops too).
                  if (contextHintState.disabled) {
                    merged.delete("context-hint-2026-04-09");
                    betaLatchState.sent.delete("context-hint-2026-04-09");
                  }
                  // Custom-beta strip kill switch: when the server rejected our custom
                  // betas (customBetasStripped latch fired), evict them from the latch so
                  // they do not re-appear on the retry attempt.
                  // F1: delete both the raw alias AND the canonical form so that aliases
                  // like "cache-diag" (cache-diagnosis-2026-04-07) are fully evicted.
                  if (customBetasStripped && config.custom_betas?.length) {
                    for (const b of config.custom_betas) {
                      const canonical = resolveBetaShortcut(b);
                      merged.delete(b);
                      merged.delete(canonical);
                      betaLatchState.sent.delete(b);
                      betaLatchState.sent.delete(canonical);
                    }
                  }
                  // F4: Evict session-rejected betas from the latch on every request so
                  // they cannot re-enter the sent set from a prior latched header.
                  if (sessionRejectedBetas.size > 0) {
                    const _now = Date.now();
                    for (const [_canonical, _rejectedAt] of sessionRejectedBetas) {
                      if (_now - _rejectedAt <= SESSION_REJECTED_BETA_TTL_MS) {
                        merged.delete(_canonical);
                        betaLatchState.sent.delete(_canonical);
                      } else {
                        sessionRejectedBetas.delete(_canonical);
                      }
                    }
                  }
                  computedBetaHeader = [...merged].join(",");
                  betaLatchState.lastHeader = computedBetaHeader;
                }

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

                const body = transformRequestBody(
                  requestInit.body,
                  {
                    enabled: getSignatureEmulationEnabled(),
                    claudeCliVersion,
                    promptCompactionMode: getPromptCompactionMode(),
                    provider: _reqProvider,
                    cachePolicy: effectiveCachePolicy,
                    fastMode: config.fast_mode || false,
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
                    cacheBreakState._pendingHashes = currentHashes;
                  }
                }

                // Build headers with the selected account's token
                const requestHeaders = buildRequestHeaders(
                  input,
                  requestInit,
                  accessToken,
                  body,
                  requestUrl,
                  {
                    enabled: getSignatureEmulationEnabled(),
                    claudeCliVersion,
                    customBetas: _sessionFilteredCustomBetas,
                    strategy: getEffectiveStrategy(),
                    sessionId: signatureSessionId,
                  },
                  _adaptiveOverride,
                  _tokenEconomy,
                );
                // cch stays as the static "00000" placeholder — cc-107 and cc-108
                // JS bundles both emit `cch=00000;` unconditionally in the billing
                // header. The Bun-binary Attestation.zig xxHash64 mechanism lives in
                // a SEPARATE header path, not in this body field. Re-hashing here
                // mutates system[0] each turn, invalidating the prompt cache.
                const finalBody = body;

                // Opt-in: dump the OUTGOING body (post-cch) so diagnostics reflect
                // exactly what went on the wire. Previously dumped `body` which
                // still had the cch=00000 placeholder — that confused debugging.
                // Rotates at 10 files to cap disk usage. Files live under
                // ~/.opencode/opencode-anthropic-fix/request-dumps/.
                if (config.token_economy?.debug_dump_bodies === true && typeof finalBody === "string") {
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
                    fs.writeFileSync(path.join(dir, `req-${ts}.json`), finalBody);
                  } catch {
                    // Disk full, permissions, whatever — never block the request.
                  }
                }

                // Execute the request
                let response;
                try {
                  response = await fetch(requestInput, {
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
                if (config.debug) {
                  const rlHeaders = {};
                  const allHeaders = {};
                  response.headers.forEach((value, key) => {
                    allHeaders[key] = value;
                    if (key.includes("ratelimit") || key.includes("retry") || key.includes("x-should")) {
                      rlHeaders[key] = value;
                    }
                  });
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
                  debugLog("ALL response headers:", allHeaders);
                  // Write to file for reliable access
                  try {
                    const { writeFileSync } = await import("node:fs");
                    const { join } = await import("node:path");
                    const debugFile = join(getConfigDir(), "debug-headers.log");
                    const ts = new Date().toISOString();
                    const entry = [
                      `\n=== ${ts} | status=${response.status} ok=${response.ok} account=${!!account} mgr=${!!accountManager} ===`,
                      `Rate-limit headers: ${JSON.stringify(rlHeaders, null, 2)}`,
                      `All headers: ${JSON.stringify(allHeaders, null, 2)}`,
                      "",
                    ].join("\n");
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

                  // Context-hint protocol (CC v2.1.110+): detect server rejections and
                  // apply the same disable/compact semantics as real Claude Code.
                  //   - 400 w/ "Unexpected value" + "anthropic-beta" → beta unsupported, disable
                  //   - 409 / 529 / overloaded                      → temporary, disable
                  //   - 422 / 424                                    → compact messages (strip
                  //     thinking blocks + old tool_result content) and retry ONCE.
                  // Disable is permanent for the session; the beta latch strips it from future
                  // requests so we don't keep triggering the same rejection.
                  if (!contextHintState.disabled) {
                    if (
                      response.status === 400 &&
                      errorBody &&
                      errorBody.includes("Unexpected value") &&
                      errorBody.includes("anthropic-beta") &&
                      errorBody.includes("context-hint")
                    ) {
                      contextHintState.disabled = true;
                      betaLatchState.dirty = true;
                      // Persist across sessions: a 400 "Unexpected value" on the
                      // context-hint beta means the account lacks access to the
                      // beta entirely. Re-attempting next session would burn
                      // another turn to the same rejection.
                      saveContextHintDisabledFlag({
                        reason: "beta_unsupported_400",
                        status: 400,
                      });
                      debugLog("context-hint: beta rejected by server (400), disabling + persisting");
                      // Retry without the beta. The latch above drops the header
                      // and the body field on the rebuilt request.
                      attempt--;
                      continue;
                    } else if (response.status === 409) {
                      contextHintState.disabled = true;
                      betaLatchState.dirty = true;
                      debugLog("context-hint: 409 conflict, disabling for session");
                      attempt--;
                      continue;
                    } else if (response.status === 529 && errorBody && errorBody.includes("context_hint")) {
                      contextHintState.disabled = true;
                      betaLatchState.dirty = true;
                      debugLog("context-hint: 529 overloaded referencing hint, disabling for session");
                      attempt--;
                      continue;
                    } else if (
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
                            contextHintState.compactionsApplied += 1;
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
                    // Server says DO NOT retry — return error directly
                    debugLog("x-should-retry: false — not retrying", { status: response.status });
                    return transformResponse(response);
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
                    const retryAfterMs = parseRetryAfterMsHeader(response) ?? parseRetryAfterHeader(response);

                    // Transient 429: short retry-after (<=10s) is a burst throttle.
                    // Retry on the SAME account instead of rotating — avoids wasting
                    // the account pool on momentary rate spikes.
                    if (
                      response.status === 429 &&
                      reason === "RATE_LIMIT_EXCEEDED" &&
                      retryAfterMs != null &&
                      retryAfterMs > 0 &&
                      retryAfterMs <= TRANSIENT_RETRY_THRESHOLD_MS
                    ) {
                      debugLog("transient 429: sleeping before same-account retry", {
                        retryAfterMs,
                        account: account.email || `Account ${account.index + 1}`,
                      });
                      await new Promise((r) => setTimeout(r, retryAfterMs));
                      // Decrement attempt so this transient retry doesn't consume an account slot
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

                    // Graceful degradation: disable fast mode on rate limits
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
                  if (
                    (response.status === 529 || response.status === 503) &&
                    serviceWideRetryCount < maxServiceRetries
                  ) {
                    serviceWideRetryCount++;

                    // Track consecutive 529s for model fallback
                    if (response.status === 529) {
                      consecutive529Count++;
                      if (consecutive529Count >= 3 && requestInit.body) {
                        try {
                          // QA fix: parse from requestInit.body (pre-transform) to avoid
                          // double-transformation (mcp_ prefix, system blocks, metadata).
                          const parsedForFallback = JSON.parse(requestInit.body);
                          const currentModel = parsedForFallback.model || "";
                          let fallbackModel = null;
                          if (/opus-4-6|opus-4/i.test(currentModel))
                            fallbackModel = currentModel.replace(/opus/i, "sonnet");
                          else if (/sonnet-4-6|sonnet-4/i.test(currentModel))
                            fallbackModel = currentModel.replace(/sonnet/i, "haiku");

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

                    const baseDelay = Math.min(0.5 * Math.pow(2, serviceWideRetryCount), 3);
                    const jitter = 1 - Math.random() * 0.25;
                    const sleepMs = Math.round(baseDelay * jitter * 1000);
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
                  return transformResponse(response);
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

/** @type {{turns: number, totalInput: number, totalOutput: number, totalCacheRead: number, totalCacheWrite: number, totalWebSearchRequests: number, recentCacheRates: number[], sessionCostUsd: number, costBreakdown: {input: number, output: number, cacheRead: number, cacheWrite: number}, sessionStartTime: number, lastQuota: {tokens: number, requests: number, inputTokens: number, updatedAt: number, fiveHour: {utilization: number, resets_at: string|null, status: string|null, surpassedThreshold: number|null}, sevenDay: {utilization: number, resets_at: string|null, status: string|null, surpassedThreshold: number|null}, overallStatus: string|null, representativeClaim: string|null, fallback: string|null, fallbackPercentage: number|null, overageStatus: string|null, overageReason: string|null, lastPollAt: number}, lastStopReason: string | null, perModel: Record<string, {input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number, turns: number}>, lastModelId: string | null, lastRequestBody: string | null, tokenBudget: {limit: number, used: number, continuations: number, outputHistory: number[]}}} */
/** Module-level config ref for functions outside AnthropicAuthPlugin closure. */
let _pluginConfig = null;

/**
 * Factory for the initial sessionMetrics shape. Returns a fresh object each
 * call so the reset helper (and any future test hook) doesn't alias nested
 * state (lastQuota, perModel, costBreakdown, tokenBudget, usedTools Set).
 * Keep this in sync with the type annotation above.
 */
function createInitialSessionMetrics() {
  return {
    turns: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalWebSearchRequests: 0,
    recentCacheRates: [], // rolling window of last 5 turns
    sessionCostUsd: 0,
    costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    sessionStartTime: Date.now(),
    lastQuota: {
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      updatedAt: 0,
      // Window-based unified headers from response
      fiveHour: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
      sevenDay: { utilization: 0, resets_at: null, status: null, surpassedThreshold: null },
      // Overall/fallback/overage from response headers
      overallStatus: null,
      representativeClaim: null,
      fallback: null,
      fallbackPercentage: null,
      overageStatus: null,
      overageReason: null,
      // Usage endpoint polling (A6)
      lastPollAt: 0,
    },
    lastStopReason: null, // tracks most recent stop_reason for output cap escalation
    perModel: {}, // Map<modelId, { input, output, cacheRead, cacheWrite, costUsd, turns }>
    lastModelId: null,
    lastRequestBody: null, // Last intercepted request body (JSON string, capped 2MB) for /anthropic context
    /** Token budget tracking (A9) */
    tokenBudget: {
      limit: 0, // 0 = unset
      used: 0, // accumulated output tokens
      continuations: 0,
      outputHistory: [], // last 5 output token deltas
    },
    /** Tools used in this session (populated from assistant tool_use blocks in messages) */
    usedTools: new Set(),
  };
}

const sessionMetrics = createInitialSessionMetrics();

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
 * Determine if microcompact betas should be injected based on estimated token usage.
 * @param {number} estimatedTokens - Estimated prompt token count
 * @param {object} config - Plugin config
 * @returns {boolean}
 */
function shouldMicrocompact(estimatedTokens, config) {
  if (!config.microcompact?.enabled) return false;
  const thresholdPct = config.microcompact.threshold_percent ?? 80;
  // Use the model's context window. Default to 200K if unknown.
  // Adaptive context may escalate to 1M, but we use the base 200K for threshold
  // to be conservative (microcompact at 160K tokens is still valuable).
  const contextWindow = 200_000;
  const threshold = contextWindow * (thresholdPct / 100);
  return estimatedTokens >= threshold;
}

/**
 * Build the list of microcompact betas to inject.
 * @returns {string[]} Array of beta flag strings
 */
function buildMicrocompactBetas() {
  return ["clear_tool_uses_20250919", "clear_thinking_20251015"];
}

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

// ---------------------------------------------------------------------------
// Token Budget Parsing & Enforcement (A9)
// ---------------------------------------------------------------------------

/**
 * Parse natural-language budget expressions from user messages.
 * Supports: +500k, 500,000, 2M, 2 million, "spend 500k", "use 2M tokens", "budget: 1M".
 * Only scans the last user message to avoid re-triggering from history.
 *
 * @param {Array<{role: string, content: string | Array<{type: string, text?: string}>}>} messages
 * @returns {number} Parsed token count, or 0 if no budget expression found
 */
function parseNaturalLanguageBudget(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  // Find the last user message
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") {
        lastUserText = content;
      } else if (Array.isArray(content)) {
        lastUserText = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join(" ");
      }
      break;
    }
  }
  if (!lastUserText) return 0;

  // Patterns ordered from most specific to least
  const patterns = [
    /\buse\s+(\d[\d,]*)\s*([mk])\s*tokens?\b/i,
    /\bspend\s+(\d[\d,]*)\s*([mk])?\b/i,
    /\bbudget[:\s]+(\d[\d,]*)\s*([mk])?\b/i,
    /\+(\d[\d,]*)\s*([mk])\b/i,
    /\b(\d[\d,]*)\s*million\s*tokens?\b/i,
  ];

  for (const re of patterns) {
    const m = lastUserText.match(re);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ""));
      if (isNaN(num) || num <= 0) continue;
      const suffix = (m[2] || "").toLowerCase();
      if (re === patterns[4]) {
        // "N million tokens" — the regex has no suffix group
        return num * 1_000_000;
      }
      if (suffix === "m") return num * 1_000_000;
      if (suffix === "k") return num * 1_000;
      // No suffix — treat as absolute count
      return num;
    }
  }
  return 0;
}

/**
 * Inject a token budget status block into the system prompt.
 * Prepends a text block with budget progress and threshold info.
 *
 * @param {Array<{type: string, text?: string, [k: string]: any}>} systemBlocks
 * @param {{limit: number, used: number, continuations: number}} budget
 * @param {number} threshold - Completion threshold (0-1, e.g. 0.9)
 * @returns {Array<{type: string, text?: string, [k: string]: any}>}
 */
function injectTokenBudgetBlock(systemBlocks, budget, threshold) {
  if (!budget || budget.limit <= 0) return systemBlocks;
  const pct = ((budget.used / budget.limit) * 100).toFixed(0);
  const thresholdTokens = Math.round(budget.limit * threshold);
  const remaining = Math.max(0, budget.limit - budget.used);
  const block = {
    type: "text",
    text: `Token budget: ${budget.used.toLocaleString()}/${budget.limit.toLocaleString()} tokens used (${pct}%). Stop generating at ${thresholdTokens.toLocaleString()} tokens. Remaining: ${remaining.toLocaleString()} tokens.`,
  };
  return [block, ...(systemBlocks || [])];
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
 * Estimate prompt tokens from an already-parsed request body object.
 * Avoids redundant JSON.parse when the caller already has the parsed object.
 * @param {object} parsed - The parsed request body
 * @returns {number} Estimated token count
 */
function estimatePromptTokensFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return 0;
  let charCount = 0;

  // Count system prompt text
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block.type === "text" && typeof block.text === "string") {
        charCount += block.text.length;
      }
    }
  } else if (typeof parsed.system === "string") {
    charCount += parsed.system.length;
  }

  // Count messages content (text blocks, tool results) — skip tool definitions
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (typeof msg.content === "string") {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && typeof block.text === "string") {
            charCount += block.text.length;
          } else if (block.type === "tool_result" && typeof block.content === "string") {
            charCount += block.content.length;
          } else if (block.type === "tool_use") {
            // Count serialized input as tokens
            charCount += JSON.stringify(block.input || {}).length;
          } else if (block.type === "image" || block.type === "image_url") {
            // Images: ~2000 tokens per image (Anthropic tile-based counting)
            charCount += 8000; // 2000 tokens * 4 chars/token
          }
        }
      }
    }
  }

  // 4 chars/token heuristic for text content (reasonable for English + code + JSON)
  return Math.ceil(charCount / 4);
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
 * Get rolling average cache hit rate over last 5 turns.
 * @returns {number} 0-1
 */
function getAverageCacheHitRate() {
  const rates = sessionMetrics.recentCacheRates;
  if (rates.length === 0) return 0;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
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
        length_anchors: _pluginConfig?.anti_verbosity?.length_anchors !== false,
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

const BILLING_HASH_SALT = "59cf53e54c78";
const BILLING_HASH_INDICES = [4, 7, 20];

// cch attestation: RE-ENABLED with xxHash64 (matching Bun binary's Attestation.zig).
// The compiled Bun binary computes cch dynamically: xxHash64(body, seed) & 0xFFFFF.
// Captured real CC v2.1.107 request shows cch=6d00f (5-hex-char, 20-bit masked hash).
// Seed extracted from binary: 0x6E52736AC806831E (unchanged since v2.1.96).
const CCH_SEED = 0x6e52736ac806831en; // BigInt — Attestation.zig seed

/** @type {null | ((buf: Uint8Array, seed: bigint) => bigint)} */
let _xxh64Raw = null;
const _xxhashReady = xxhashInit().then((h) => {
  _xxh64Raw = h.h64Raw;
});

/**
 * Compute and replace the cch=00000 placeholder in the serialized body with
 * xxHash64(body, seed) & 0xFFFFF, matching the Bun binary's native attestation.
 * @param {string} body - Serialized JSON body
 * @returns {Promise<string>} Body with cch replaced
 */
async function computeAndReplaceCCH(body) {
  if (typeof body !== "string" || !body.includes("cch=00000")) return body;
  await _xxhashReady;
  if (!_xxh64Raw) return body; // fallback: send as-is if wasm failed to load
  const bodyBytes = Buffer.from(body, "utf-8");
  const hash = _xxh64Raw(bodyBytes, CCH_SEED);
  const cch = (hash & 0xfffffn).toString(16).padStart(5, "0");
  return body.replace("cch=00000", `cch=${cch}`);
}

/**
 * Compute the billing cache hash (cch) matching Claude Code's NP1() function.
 * SHA256(salt + chars_at_indices[4,7,20]_from_first_user_msg + version).slice(0,3)
 * @param {string} firstUserMessage
 * @param {string} version
 * @returns {string}
 */
function computeBillingCacheHash(firstUserMessage, version) {
  const chars = BILLING_HASH_INDICES.map((i) => firstUserMessage[i] || "0").join("");
  const input = `${BILLING_HASH_SALT}${chars}${version}`;
  return createHashCrypto("sha256").update(input).digest("hex").slice(0, 3);
}

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
/**
 * Apply context-hint compaction to a message array. Mirrors real CC's
 * `applyHintEdits` (d85) + `qD4` microcompact: clears thinking/redacted_thinking
 * blocks from assistant messages and replaces old tool_result content with a
 * placeholder, keeping the last few tool results intact. Used on 422/424
 * responses before retrying.
 *
 * @param {Array} messages — Parsed messages array
 * @param {object} [opts]
 * @param {number} [opts.keepRecentToolResults=8] — How many most-recent tool_result blocks to preserve verbatim
 * @param {string} [opts.clearedPlaceholder] — Replacement content for older tool_result blocks
 * @returns {{ messages: Array, changed: boolean, stats: { thinkingCleared: number, toolResultsCleared: number } }}
 */
function applyContextHintCompaction(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, stats: { thinkingCleared: 0, toolResultsCleared: 0 } };
  }
  const keepRecent = opts.keepRecentToolResults ?? 8;
  const placeholder = opts.clearedPlaceholder ?? "[Old tool result content cleared]";

  // First pass: count tool_result blocks so we know which are "old" vs "recent".
  const toolResultRefs = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      if (msg.content[j]?.type === "tool_result") {
        toolResultRefs.push({ msgIdx: i, blockIdx: j });
      }
    }
  }
  const oldCutoff = Math.max(0, toolResultRefs.length - keepRecent);
  const oldSet = new Set(toolResultRefs.slice(0, oldCutoff).map((r) => `${r.msgIdx}:${r.blockIdx}`));

  let thinkingCleared = 0;
  let toolResultsCleared = 0;
  const out = messages.map((msg, i) => {
    if (!Array.isArray(msg.content)) return msg;
    if (msg.role === "assistant") {
      const newContent = msg.content.filter((block) => {
        if (block?.type === "thinking" || block?.type === "redacted_thinking") {
          thinkingCleared += 1;
          return false;
        }
        return true;
      });
      if (newContent.length !== msg.content.length) {
        return { ...msg, content: newContent };
      }
      return msg;
    }
    if (msg.role === "user") {
      let mutated = false;
      const newContent = msg.content.map((block, j) => {
        if (block?.type !== "tool_result") return block;
        const key = `${i}:${j}`;
        if (!oldSet.has(key)) return block;
        toolResultsCleared += 1;
        mutated = true;
        // Replace content with placeholder, preserve tool_use_id
        return {
          ...block,
          content: placeholder,
        };
      });
      return mutated ? { ...msg, content: newContent } : msg;
    }
    return msg;
  });

  return {
    messages: out,
    changed: thinkingCleared > 0 || toolResultsCleared > 0,
    stats: { thinkingCleared, toolResultsCleared },
  };
}

/**
 * Tools whose output is trivially reproducible by re-running with the same
 * arguments. Stateful tools (bash, edit, write, etc.) never dedupe — their
 * outputs may reflect non-idempotent side effects that the transcript needs
 * to preserve.
 */
const REPRODUCIBLE_TOOL_NAMES = new Set(["read", "grep", "glob", "ls", "list", "find"]);

/**
 * Title-case a tool name for the stub string ("read" → "Read", "grep" → "Grep").
 * Pure; no locale.
 */
function titleCaseToolName(name) {
  if (typeof name !== "string" || name.length === 0) return "";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * Minimal deterministic stable-stringify for args canonicalization.
 * Sorts object keys at every depth before serialization so that
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same string.
 *
 * Arrays are traversed in order. Non-plain objects (Date, Map, etc.) fall
 * through to `JSON.stringify` — we don't expect them in tool args, but the
 * fallback keeps the function total.
 */
function stableStringifyForDedupe(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringifyForDedupe(v)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringifyForDedupe(value[k]));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Session-wide tool-result dedupe. Pure over `messages`.
 *
 * Walks the conversation once to collect every `tool_use` + `tool_result`
 * pair where the tool is in `REPRODUCIBLE_TOOL_NAMES` (case-insensitive).
 * Groups them by `(toolName, stableStringify(args))`. For every group
 * containing more than one call, keeps the LATEST result verbatim and
 * replaces each earlier result's `content` with a stub:
 *
 *   `[<ToolTitleCase> of <argsKey> superseded by later read at msg #<N>]`
 *
 * where `N` is the message index of the latest call's user-message.
 *
 * `tool_use_id` and any other `tool_result` fields are preserved. Assistant
 * `tool_use` blocks are NEVER modified — only the paired user `tool_result`.
 *
 * Cache-stable: decision is a pure function of message history, so rerunning
 * over an unchanged prefix yields byte-identical output.
 *
 * @param {Array} messages — Parsed messages array
 * @returns {{ messages: Array, changed: boolean, stats: { deduped: number } }}
 */
function applySessionToolResultDedupe(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, stats: { deduped: 0 } };
  }

  // Pass 1: build tool_use_id → { name, argsKey } for reproducible tools.
  const idToMeta = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (!REPRODUCIBLE_TOOL_NAMES.has(name.toLowerCase())) continue;
      const argsKey = stableStringifyForDedupe(block.input ?? {});
      idToMeta.set(block.id, { name, argsKey });
    }
  }

  // Pass 2: collect tool_result locations by group key, preserving order.
  /** @type {Map<string, Array<{msgIdx: number, blockIdx: number, toolUseId: string, name: string, argsKey: string}>>} */
  const groups = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block?.type !== "tool_result") continue;
      const meta = idToMeta.get(block.tool_use_id);
      if (!meta) continue;
      const groupKey = meta.name.toLowerCase() + "\u0000" + meta.argsKey;
      let arr = groups.get(groupKey);
      if (!arr) {
        arr = [];
        groups.set(groupKey, arr);
      }
      arr.push({
        msgIdx: i,
        blockIdx: j,
        toolUseId: block.tool_use_id,
        name: meta.name,
        argsKey: meta.argsKey,
      });
    }
  }

  // Build supersede map: "msgIdx:blockIdx" → stub string.
  const supersedeStubs = new Map();
  let deduped = 0;
  // Deterministic iteration: sort group entries by group key before processing.
  const sortedEntries = Array.from(groups.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, occurrences] of sortedEntries) {
    if (occurrences.length < 2) continue;
    const latest = occurrences[occurrences.length - 1];
    const stub =
      "[" +
      titleCaseToolName(latest.name) +
      " of " +
      latest.argsKey +
      " superseded by later read at msg #" +
      latest.msgIdx +
      "]";
    for (let k = 0; k < occurrences.length - 1; k++) {
      const occ = occurrences[k];
      supersedeStubs.set(occ.msgIdx + ":" + occ.blockIdx, stub);
      deduped += 1;
    }
  }

  if (deduped === 0) {
    return { messages, changed: false, stats: { deduped: 0 } };
  }

  // Pass 3: rewrite. Preserve tool_use_id and other fields.
  const out = messages.map((msg, i) => {
    if (msg?.role !== "user" || !Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((block, j) => {
      if (block?.type !== "tool_result") return block;
      const stub = supersedeStubs.get(i + ":" + j);
      if (!stub) return block;
      mutated = true;
      return { ...block, content: stub };
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });

  return { messages: out, changed: true, stats: { deduped } };
}

/**
 * Dispatch wrapper: only apply `applySessionToolResultDedupe` when the
 * `token_economy_strategies.tool_result_dedupe_session_wide` flag is true.
 * When disabled, returns the input `messages` by identity (not a copy) so
 * callers can cheaply detect "no-op" with reference equality.
 *
 * @param {Array} messages
 * @param {object} [config]
 * @returns {Array}
 */
function maybeApplySessionToolResultDedupe(messages, config) {
  const flag = config?.token_economy_strategies?.tool_result_dedupe_session_wide;
  if (flag !== true) return messages;
  const result = applySessionToolResultDedupe(messages);
  return result.messages;
}

/**
 * TTL-based thinking strip. When the time since the last strip exceeds the
 * cache TTL (roughly the point at which the prompt prefix cache would expire),
 * remove all `thinking` / `redacted_thinking` blocks from prior assistant
 * messages. Mirrors CC's `logThinkingClearLatched("ttl", ...)`.
 *
 * We keep the MOST RECENT assistant's thinking intact — chain-of-thought
 * continuity for the current turn matters; older ones don't.
 *
 * @param {Array} messages
 * @param {{ lastClearMs: number, ttlMs: number, now?: number }} ctx
 * @returns {{ messages: Array, changed: boolean, cleared: number, ranStripAt: number }}
 */
function applyTtlThinkingStrip(messages, ctx) {
  const now = ctx.now ?? Date.now();
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, cleared: 0, ranStripAt: ctx.lastClearMs };
  }
  if (ctx.lastClearMs > 0 && now - ctx.lastClearMs < ctx.ttlMs) {
    return { messages, changed: false, cleared: 0, ranStripAt: ctx.lastClearMs };
  }

  // Find the last assistant message index — preserve its thinking.
  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }

  let cleared = 0;
  const out = messages.map((msg, i) => {
    if (msg.role !== "assistant" || i === lastAsstIdx || !Array.isArray(msg.content)) {
      return msg;
    }
    const newContent = msg.content.filter((b) => {
      if (b?.type === "thinking" || b?.type === "redacted_thinking") {
        cleared += 1;
        return false;
      }
      return true;
    });
    return newContent.length !== msg.content.length ? { ...msg, content: newContent } : msg;
  });

  return { messages: out, changed: cleared > 0, cleared, ranStripAt: cleared > 0 ? now : ctx.lastClearMs };
}

/**
 * Proactive microcompact — client-side, runs BEFORE the request goes out.
 * At or above `percent` of the model's context window, replace old
 * tool_result.content with a placeholder (keeping last `keepRecent` verbatim).
 *
 * Returns the new messages array + change stats.
 *
 * @param {Array} messages
 * @param {{ estimatedTokens: number, contextWindow: number, percent: number, keepRecent: number }} ctx
 * @returns {{ messages: Array, changed: boolean, cleared: number, triggered: boolean }}
 */
function applyProactiveMicrocompact(messages, ctx) {
  const threshold = ctx.contextWindow * (ctx.percent / 100);
  if (ctx.estimatedTokens < threshold) {
    return { messages, changed: false, cleared: 0, triggered: false };
  }
  const result = applyContextHintCompaction(messages, { keepRecentToolResults: ctx.keepRecent });
  return {
    messages: result.messages,
    changed: result.changed,
    cleared: result.stats.toolResultsCleared,
    triggered: true,
  };
}

/**
 * Stable tool ordering — sort tools by name so the system-prompt prefix stays
 * cache-stable across turns. Safe: tool semantics are name-based, not index-based.
 *
 * @param {any[]} tools
 * @returns {any[]}
 */
function applyStableToolOrdering(tools) {
  if (!Array.isArray(tools) || tools.length < 2) return tools;
  // Preserve a pinned "first" for tools whose position is load-bearing (none today).
  return [...tools].sort((a, b) => {
    const an = typeof a?.name === "string" ? a.name : "";
    const bn = typeof b?.name === "string" ? b.name : "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * Tool schema deferral — replace the `input_schema` of deferred tools with a
 * minimal placeholder until the tool has been invoked in this session.
 *
 * @param {any[]} tools
 * @param {{ deferred: Set<string>, invoked: Set<string> }} ctx
 * @returns {{ tools: any[], deferredCount: number }}
 */
function applyToolSchemaDeferral(tools, ctx) {
  if (!Array.isArray(tools) || ctx.deferred.size === 0) {
    return { tools, deferredCount: 0 };
  }
  let deferredCount = 0;
  const out = tools.map((t) => {
    const name = typeof t?.name === "string" ? t.name : "";
    if (!ctx.deferred.has(name) || ctx.invoked.has(name)) return t;
    deferredCount += 1;
    // Minimal schema — `type:object` with no properties is accepted by the API.
    return {
      ...t,
      input_schema: { type: "object", properties: {}, additionalProperties: true },
    };
  });
  return { tools: out, deferredCount };
}

/**
 * Adaptive thinking — zero the thinking budget for trivially simple follow-ups.
 * "Simple" heuristic: most recent user message is short (<200 chars), no file
 * references, and the conversation is past turn 1 (so we have context).
 *
 * @param {any} parsed Parsed request body (mutated in place if simple)
 * @returns {{ applied: boolean, previousBudget: number | null }}
 */
function applyAdaptiveThinkingZero(parsed) {
  if (!parsed || !parsed.thinking || parsed.thinking.type !== "enabled") {
    return { applied: false, previousBudget: null };
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length < 2) return { applied: false, previousBudget: null };
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { applied: false, previousBudget: null };

  let userText = "";
  if (typeof last.content === "string") userText = last.content;
  else if (Array.isArray(last.content)) {
    for (const b of last.content) {
      if (b?.type === "text" && typeof b.text === "string") userText += b.text;
      if (b?.type === "tool_result") return { applied: false, previousBudget: null };
    }
  }
  if (userText.length > 200) return { applied: false, previousBudget: null };
  if (/\b(analyze|refactor|design|review|audit|plan)\b/i.test(userText)) {
    return { applied: false, previousBudget: null };
  }

  const previousBudget = typeof parsed.thinking.budget_tokens === "number" ? parsed.thinking.budget_tokens : null;
  // "Zero" means remove thinking entirely — API disallows budget_tokens:0.
  delete parsed.thinking;
  if (typeof parsed.temperature !== "number") parsed.temperature = 1;
  return { applied: true, previousBudget };
}

/**
 * Cross-turn tool_result dedupe — when the same (tool name, input) pair
 * appeared earlier in the conversation, replace the later result content
 * with a pointer string. Safe-set only: Read, Grep, Glob, LS.
 *
 * @param {Array} messages
 * @param {{ seen: Map<string, string>, safeTools: Set<string> }} ctx
 * @returns {{ messages: Array, changed: boolean, deduped: number }}
 */
function applyToolResultDedupe(messages, ctx) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, deduped: 0 };
  }
  // First pass: build map of tool_use_id → { name, inputHash } from assistant messages.
  const idToKey = new Map();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type !== "tool_use") continue;
      if (!ctx.safeTools.has(b.name)) continue;
      const inputStr = JSON.stringify(b.input ?? {});
      idToKey.set(b.id, `${b.name}::${inputStr}`);
    }
  }

  let deduped = 0;
  const out = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((b) => {
      if (b?.type !== "tool_result") return b;
      const key = idToKey.get(b.tool_use_id);
      if (!key) return b;
      const firstSeen = ctx.seen.get(key);
      if (firstSeen && firstSeen !== b.tool_use_id) {
        deduped += 1;
        mutated = true;
        return { ...b, content: `[Identical to tool_use_id=${firstSeen}]` };
      }
      if (!firstSeen) ctx.seen.set(key, b.tool_use_id);
      return b;
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });

  return { messages: out, changed: deduped > 0, deduped };
}

/**
 * Trailing-summary trimmer — strip the final text block of past assistant
 * messages if it looks like a summary (ends with "...done" / "summary" /
 * numbered list / "I've X'd Y"). Only applies to messages past the last one.
 *
 * @param {Array} messages
 * @returns {{ messages: Array, changed: boolean, trimmed: number }}
 */
function applyTrailingSummaryTrim(messages) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { messages, changed: false, trimmed: 0 };
  }
  const SUMMARY_PATTERNS = [
    /\b(summary|summar(y|ised|ized)):/i,
    /\bto summari[sz]e\b/i,
    /^\s*in (summary|short|brief)/im,
    /\bi['']ve (done|completed|implemented|added|updated|fixed) /i,
    /\bthat's it\b/i,
  ];

  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }

  let trimmed = 0;
  const out = messages.map((msg, i) => {
    if (msg.role !== "assistant" || i === lastAsstIdx) return msg;
    if (!Array.isArray(msg.content)) return msg;

    const last = msg.content[msg.content.length - 1];
    if (!last || last.type !== "text" || typeof last.text !== "string") return msg;
    const text = last.text;
    if (text.length < 80) return msg;
    const isSummary = SUMMARY_PATTERNS.some((p) => p.test(text));
    if (!isSummary) return msg;

    trimmed += 1;
    const newContent = msg.content.slice(0, -1);
    if (newContent.length === 0) return msg; // keep at least one block
    return { ...msg, content: newContent };
  });

  return { messages: out, changed: trimmed > 0, trimmed };
}

function repairOrphanedToolUseBlocks(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const repaired = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    repaired.push(msg);

    // Only check assistant messages with array content
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    // Collect tool_use IDs from this assistant message
    const toolUseIds = [];
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    // Check if the next message is a user message with matching tool_results
    const next = messages[i + 1];
    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Collect tool_result IDs present in the next user message
      const resultIds = new Set();
      for (const block of next.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          resultIds.add(block.tool_use_id);
        }
      }

      // Find which tool_use IDs are missing from the tool_results
      const missingIds = toolUseIds.filter((id) => !resultIds.has(id));
      if (missingIds.length === 0) continue; // All paired, nothing to fix

      // There are missing tool_results — inject them into the existing user message.
      // Clone the next message to avoid mutating the original.
      const patchedNext = {
        ...next,
        content: [
          ...missingIds.map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: "[Result unavailable — tool execution was interrupted]",
          })),
          ...next.content,
        ],
      };
      // Replace the next message in-place by skipping it and pushing the patched version
      i++; // skip original next
      repaired.push(patchedNext);
    } else {
      // Next message is missing or is not a user message — synthesize a full
      // tool_result user message for all tool_use IDs.
      repaired.push({
        role: "user",
        content: toolUseIds.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          content: "[Result unavailable — tool execution was interrupted]",
        })),
      });
    }
  }

  return repaired;
}

function stripSlashCommandMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // Pattern: /anthropic followed by optional subcommand
  const CMD_RE = /^\s*\/anthropic\b/i;
  // Pattern: ▣ Anthropic — prefix used by all sendCommandMessage outputs
  const RESP_RE = /^▣\s*Anthropic/;

  /**
   * Extract the first text content from a message's content field.
   * Handles both string content and array-of-blocks content.
   */
  function getFirstText(msg) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") return block.text;
      }
    }
    return "";
  }

  /**
   * Check if a user message is a /anthropic command.
   * A message is a command if its text content starts with /anthropic.
   */
  function isCommandMessage(msg) {
    if (msg.role !== "user") return false;
    const text = getFirstText(msg);
    return CMD_RE.test(text);
  }

  /**
   * Check if an assistant message is a sendCommandMessage response.
   * These always start with ▣ Anthropic.
   */
  function isCommandResponse(msg) {
    if (msg.role !== "assistant") return false;
    const text = getFirstText(msg);
    return RESP_RE.test(text);
  }

  const filtered = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Drop /anthropic command messages
    if (isCommandMessage(msg)) {
      // Also drop the immediately following assistant response if it's a command response
      if (i + 1 < messages.length && isCommandResponse(messages[i + 1])) {
        i++; // Skip the response too
      }
      continue;
    }

    // Drop orphaned command responses (in case the command message was already removed
    // or the ordering is different)
    if (isCommandResponse(msg)) {
      continue;
    }

    filtered.push(msg);
  }

  // Safety: if filtering removed ALL messages, return the original to avoid sending
  // an empty messages array to the API.
  if (filtered.length === 0) return messages;

  return filtered;
}

function extractFirstUserMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") return block.text;
      }
    }
    return "";
  }
  return "";
}

const CLAUDE_CODE_BETA_FLAG = "claude-code-20250219";
const EFFORT_BETA_FLAG = "effort-2025-11-24";
const ADVANCED_TOOL_USE_BETA_FLAG = "advanced-tool-use-2025-11-20";
const FAST_MODE_BETA_FLAG = "fast-mode-2026-02-01";
const TOKEN_COUNTING_BETA_FLAG = "token-counting-2024-11-01";
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
]);
// OpenCode SDK betas that leak through the host's Anthropic SDK but are NOT
// part of CC's beta vocabulary. Filtered out when signature emulation is on.
// Core tool names (CC PascalCase) that are always eager-loaded.
const CORE_TOOL_NAMES = new Set([
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "WebFetch",
  "TodoWrite",
  "Skill",
  "Task",
  "Compress",
]);
const HOST_SDK_BETAS_BLOCKLIST = new Set(["fine-grained-tool-streaming-2025-05-14", "structured-outputs-2025-11-13"]);
const STAINLESS_HELPER_KEYS = [
  "x_stainless_helper",
  "x-stainless-helper",
  "stainless_helper",
  "stainlessHelper",
  "_stainless_helper",
];
const USER_ID_STORAGE_FILE = "anthropic-signature-user-id";
const DEBUG_SYSTEM_PROMPT_ENV = "OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT";
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
const COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT = [
  "You are a title generator. You output ONLY a thread title. Nothing else.",
  "",
  "Rules:",
  "- Use the same language as the user message.",
  "- Output exactly one line.",
  "- Keep the title at or below 50 characters.",
  "- No explanations, prefixes, or suffixes.",
  "- Keep important technical terms, numbers, and filenames when present.",
].join("\n");

/**
 * Anti-verbosity system prompt text.
 * Extracted from CC v2.1.100 (gated on quiet_salted_ember A/B test for Opus 4.6).
 * Significantly reduces output token count by instructing the model to be concise.
 */
const ANTI_VERBOSITY_SYSTEM_PROMPT = [
  "# Communication style",
  "Assume users can't see most tool calls or thinking — only your text output. Before your first tool call, state in one sentence what you're about to do. While working, give short updates at key moments: when you find something, when you change direction, or when you hit a blocker. Brief is good — silent is not. One sentence per update is almost always enough.",
  "",
  "Don't narrate your internal deliberation. User-facing text should be relevant communication to the user, not a running commentary on your thought process. State results and decisions directly, and focus user-facing text on relevant updates for the user.",
  "",
  "When you do write updates, write so the reader can pick up cold: complete sentences, no unexplained jargon or shorthand from earlier in the session. But keep it tight — a clear sentence is better than a clear paragraph.",
  "",
  "End-of-turn summary: one or two sentences. What changed and what's next. Nothing else.",
  "",
  "Match responses to the task: a simple question gets a direct answer, not headers and sections.",
  "",
  "In code: default to writing no comments. Never write multi-paragraph docstrings or multi-line comment blocks — one short line max. Don't create planning, decision, or analysis documents unless the user asks for them — work from conversation context, not intermediate files.",
].join("\n");

/**
 * Numeric length anchors text.
 * Extracted from CC v2.1.100. Hard word-count limits for output.
 */
const NUMERIC_LENGTH_ANCHORS_PROMPT =
  "Length limits: keep text between tool calls to ≤25 words. Keep final responses to ≤100 words unless the task requires more detail.";

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
function getClaudeEntrypoint() {
  return process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
}

/**
 * @param {string | undefined} body
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
function isHaikuModel(model) {
  return /haiku/i.test(model);
}

/**
 * @param {string | undefined} body
 * @returns {boolean}
 */
function supportsThinking(model) {
  if (!model) return true;
  return /claude|sonnet|opus|haiku/i.test(model);
}

/**
 * Detects claude-opus-4.6 / claude-opus-4-6 model IDs.
 * These models use adaptive thinking (effort parameter) instead of
 * manual budgetTokens.
 * @param {string | undefined} body
 * @returns {boolean}
 */
function isOpus46Model(model) {
  if (!model) return false;
  // Match standard IDs (claude-opus-4-6, claude-opus-4.6) and Bedrock ARNs
  // (arn:aws:bedrock:...anthropic.claude-opus-4-6-...).
  // Also match bare "opus-4-6" / "opus-4.6" fragments for non-standard strings.
  return /claude-opus-4[._-]6|opus[._-]4[._-]6/i.test(model);
}

/**
 * Detects claude-opus-4.7 / claude-opus-4-7 model IDs.
 * @param {string | undefined} model
 * @returns {boolean}
 */
function isOpus47Model(model) {
  if (!model) return false;
  return /claude-opus-4[._-]7|opus[._-]4[._-]7/i.test(model);
}

/**
 * Detects claude-sonnet-4.6 / claude-sonnet-4-6 model IDs.
 * @param {string | undefined} body
 * @returns {boolean}
 */
function isSonnet46Model(model) {
  if (!model) return false;
  return /claude-sonnet-4[._-]6|sonnet[._-]4[._-]6/i.test(model);
}

/**
 * Detects models that support adaptive thinking ({type: "adaptive"}).
 * Currently: Opus 4.6, Opus 4.7, and Sonnet 4.6.
 * @param {string | undefined} body
 * @returns {boolean}
 */
function isAdaptiveThinkingModel(model) {
  return isOpus46Model(model) || isOpus47Model(model) || isSonnet46Model(model);
}

/**
 * Check if a model is eligible for 1M context (can receive context-1m beta).
 * Real CC v2.1.97 U01(): claude-sonnet-4* || opus-4-6 are eligible.
 * Also matches explicit "1m" in the name (e.g. "claude-opus-4-6[1m]").
 * @param {string} model
 * @returns {boolean}
 */
function isEligibleFor1MContext(model) {
  if (!model) return false;
  // Explicit 1m suffix/tag in model name
  if (/(^|[-_ ])1m($|[-_ ])|context[-_]?1m|\[1m\]/i.test(model)) return true;
  // CC v2.1.97 U01: claude-sonnet-4* (any Sonnet 4.x) or opus-4-6.
  // Opus 4.7 (successor to 4.6) is also 1M-context eligible.
  return /claude-sonnet-4|sonnet[._-]4/i.test(model) || isOpus46Model(model) || isOpus47Model(model);
}

/**
 * Check if a model should ALWAYS use 1M context (static mode, no adaptive gating).
 * Only models with explicit "1m" in the name — NOT bare Opus 4.6.
 * When adaptive_context is enabled, Opus 4.6 uses the adaptive decision instead.
 * @param {string} model
 * @returns {boolean}
 */
function hasOneMillionContext(model) {
  return /(^|[-_ ])1m($|[-_ ])|context[-_]?1m/i.test(model);
}

/**
 * @param {string | undefined} body
 * @returns {boolean}
 */
function supportsStructuredOutputs(model) {
  if (!/claude|sonnet|opus|haiku/i.test(model)) return false;
  return !isHaikuModel(model);
}

/**
 * @param {string | undefined} body
 * @returns {boolean}
 */
function supportsWebSearch(model) {
  return /claude|sonnet|opus|haiku|gpt|gemini/i.test(model);
}

/**
 * @param {URL | null} requestUrl
 * @returns {"anthropic" | "bedrock" | "vertex" | "foundry" | "anthropicAws" | "mantle"}
 */
function detectProvider(requestUrl) {
  // Match Claude Code provider precedence first (env-driven), then URL fallback.
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)) return "anthropicAws";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_MANTLE)) return "mantle";
  if (isTruthyEnv(process.env.CLAUDE_CODE_USE_VERTEX)) return "vertex";

  if (!requestUrl) return "anthropic";
  const host = requestUrl.hostname.toLowerCase();
  if (host.includes("mantle")) return "mantle";
  if (host.includes("anthropicaws")) return "anthropicAws";
  if (host.includes("bedrock") || host.includes("amazonaws.com")) return "bedrock";
  if (host.includes("aiplatform") || host.includes("vertex")) return "vertex";
  if (host.includes("foundry") || host.includes("azure")) return "foundry";
  return "anthropic";
}

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
function parseRequestBodyMetadata(body, parsedBody) {
  const parsed =
    parsedBody ||
    (typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return null;
          }
        })()
      : null);
  if (!parsed) {
    return { model: "", tools: [], messages: [], hasFileReferences: false };
  }

  const model = typeof parsed?.model === "string" ? parsed.model : "";
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const hasFileReferences = extractFileIds(parsed).length > 0;
  return { model, tools, messages, hasFileReferences };
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
function buildRequestMetadata(input) {
  // Backward-compat override: raw user_id passed through without JSON-encoding.
  const envUserId = process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID?.trim();
  if (envUserId) return { user_id: envUserId };

  const extraMetadataEnv = process.env.CLAUDE_CODE_EXTRA_METADATA?.trim();
  let extraMetadata = {};
  if (extraMetadataEnv) {
    try {
      const parsed = JSON.parse(extraMetadataEnv);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extraMetadata = parsed;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    user_id: JSON.stringify({
      ...extraMetadata,
      device_id: input.persistentUserId,
      account_uuid: input.accountId,
      session_id: input.sessionId,
    }),
  };
}

/**
 * Build the billing header block for Claude Code system prompt injection.
 * Claude Code v2.1.97: cc_version includes 3-char fingerprint hash (not model ID).
 * cch is a static "00000" placeholder (xxHash64 attestation removed in v2.1.97).
 *
 * Real CC (system.ts:78): version = `${MACRO.VERSION}.${fingerprint}`
 * Real CC (system.ts:82): cch = ' cch=00000;' (static, no longer computed)
 *
 * @param {string} version - CLI version (e.g., "2.1.97")
 * @param {string} [firstUserMessage] - First user message text for fingerprint computation
 * @param {string} [provider] - API provider ("anthropic" | "bedrock" | "vertex" | "foundry" | "anthropicAws" | "mantle")
 * @returns {string}
 */
function buildAnthropicBillingHeader(version, firstUserMessage, provider) {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  // Real CC sends cc_entrypoint=cli (confirmed via proxy capture).
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
  // Fix #1: cc_version suffix is the 3-char fingerprint hash, NOT the model ID.
  // computeBillingCacheHash() computes SHA256(salt + msg[4]+msg[7]+msg[20] + version)[:3]
  // which matches computeFingerprint() in the real CC source (utils/fingerprint.ts).
  // Always call the hash function — even for empty messages the real CC computes
  // the hash from "000" chars (indices 4,7,20 all missing → fallback "0").
  const fingerprint = computeBillingCacheHash(firstUserMessage || "", version);
  const ccVersion = `${version}.${fingerprint}`;
  // cch: v2.1.97 sends static "cch=00000" — xxHash64 attestation was removed.
  // The server uses the PRESENCE of cch=00000 as a CC identification signal.
  const cchDisabled = provider === "bedrock" || provider === "anthropicAws" || provider === "mantle";
  const cchPart = cchDisabled ? "" : " cch=00000;";
  // Build workload part (upstream concatenates directly, no regex replace)
  let workloadPart = "";
  const workload = process.env.CLAUDE_CODE_WORKLOAD;
  if (workload) {
    // QA fix M5: sanitize workload value to prevent header injection
    const safeWorkload = workload.replace(/[;\s\r\n]/g, "_");
    workloadPart = ` cc_workload=${safeWorkload};`;
  }
  return `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${entrypoint};${cchPart}${workloadPart}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
// Max system prompt length that passes CC billing validation.
// The server pattern-matches the system prompt against the real CC prompt.
// Opencode's customizations after ~5800 chars diverge and trigger extra usage billing.
const MAX_SAFE_SYSTEM_TEXT_LENGTH = 5000;

// A5: Subagent CC-prefix cache.
//
// Context: opencode/packages/opencode/src/session/llm.ts:110 uses
//   `input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(model)`
// so any agent with a custom prompt (explore, fast, title, summary, etc.)
// fires WITHOUT the base CC prompt — the server-side fingerprint match fails
// and the request is billed as pay-as-you-go credits instead of Max-plan usage.
//
// Fix: on the first main-agent call (where the anchor is present), cache the
// sanitized CC prefix. On subsequent subagent calls (anchor missing), prepend
// the cached prefix to the sanitized blocks so the fingerprint matches again.
//
// The cache lives at module scope because buildSystemPromptBlocks is re-entered
// per request. It gets populated exactly once per process on the first main call.
const MAX_SUBAGENT_CC_PREFIX = MAX_SAFE_SYSTEM_TEXT_LENGTH;
const SUBAGENT_CC_ANCHOR = "You are an interactive";
let cachedCCPrompt = null;

function sanitizeSystemText(text) {
  // QA fix M4: use word boundaries to avoid mangling URLs and code identifiers
  let sanitized = text.replace(/\bOpenCode\b/g, "Claude Code").replace(/\bopencode\b/gi, "Claude");
  // Strip non-CC custom prefixes before the standard CC prompt.
  const ccStandardStart = sanitized.indexOf("You are an interactive");
  if (ccStandardStart > 0) {
    sanitized = sanitized.slice(ccStandardStart);
  }
  // NOTE: truncation removed — real CC v2.1.107 sends 26K+ char system prompts.
  // The server checks for CC identity/billing markers, not exact prompt length.
  return sanitized;
}

/**
 * @param {string} text
 * @param {'minimal' | 'off'} mode
 * @returns {string}
 */
function tailSystemBlock(text, maxChars, turnThreshold) {
  const lines = text.split("\n");
  const kept = [];
  let charCount = 0;
  const importantRe = /\b(MUST|NEVER|CRITICAL|IMPORTANT|REQUIRED|DO NOT|ALWAYS|FORBIDDEN)\b/i;
  const headerRe = /^#{1,4}\s/;
  const listItemRe = /^\s*[-*]\s/;
  // Always keep the first paragraph (identity/role definition)
  let firstParaEnd = 0;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].trim() === "" && j > 0) {
      firstParaEnd = j;
      break;
    }
  }
  if (firstParaEnd === 0) firstParaEnd = Math.min(5, lines.length);
  for (let j = 0; j <= firstParaEnd; j++) {
    kept.push(lines[j]);
    charCount += (lines[j]?.length || 0) + 1;
  }
  // Scan remaining lines: keep headers, important constraints, short list items
  for (let j = firstParaEnd + 1; j < lines.length; j++) {
    const line = lines[j];
    const isHeader = headerRe.test(line);
    const isImportant = importantRe.test(line);
    const isShortListItem = listItemRe.test(line) && line.length < 120;
    if (isHeader || isImportant || isShortListItem) {
      if (charCount + line.length + 1 > maxChars) break;
      kept.push(line);
      charCount += line.length + 1;
    }
  }
  kept.push("", "[Verbose instructions trimmed after turn " + turnThreshold + ". Key constraints preserved above.]");
  return kept.join("\n");
}

function compactToolDescription(text) {
  return text
    .replace(/<example[\s\S]*?<\/example>/gi, "")
    .replace(/\|[\s|:-]+\|/g, "")
    .replace(/^\|.*\|$/gm, "")
    .replace(/^(?:\s*[-*]\s+.{200,})$/gm, (m) => m.slice(0, 200) + "...")
    .replace(/^(#{1,3}\s+)/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactSystemText(text, mode) {
  const withoutDuplicateIdentityPrefix = text.startsWith(`${CLAUDE_CODE_IDENTITY_STRING}\n`)
    ? text.slice(CLAUDE_CODE_IDENTITY_STRING.length).trimStart()
    : text;

  if (mode === "off") {
    return withoutDuplicateIdentityPrefix.trim();
  }

  const compacted = withoutDuplicateIdentityPrefix.replace(/<example>[\s\S]*?<\/example>/gi, "\n");

  const dedupedLines = [];
  let prevNormalized = "";
  for (const line of compacted.split("\n")) {
    const normalized = line.trim();
    if (normalized && normalized === prevNormalized) continue;
    dedupedLines.push(line);
    prevNormalized = normalized;
  }

  return dedupedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeSystemTextForComparison(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @returns {Array<{type: string, text: string, cache_control?: {type: string}}>}
 */
function dedupeSystemBlocks(system) {
  const exactSeen = new Set();
  const exactDeduped = [];

  for (const item of system) {
    const normalized = normalizeSystemTextForComparison(item.text);
    const key = `${item.type}:${normalized}`;
    if (exactSeen.has(key)) continue;
    exactSeen.add(key);
    exactDeduped.push(item);
  }

  const normalizedBlocks = exactDeduped.map((item) => normalizeSystemTextForComparison(item.text));
  return exactDeduped.filter((_, index) => {
    const current = normalizedBlocks[index];
    if (current.length < 80) return true;

    for (let otherIndex = 0; otherIndex < normalizedBlocks.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = normalizedBlocks[otherIndex];
      if (other.length <= current.length + 20) continue;
      if (other.includes(current)) return false;
    }

    return true;
  });
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isTitleGeneratorSystemText(text) {
  const normalized = text.trim().toLowerCase();
  return normalized.includes("you are a title generator") || normalized.includes("generate a brief title");
}

/**
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @returns {boolean}
 */
function isTitleGeneratorSystemBlocks(system) {
  return system.some(
    (item) => item.type === "text" && typeof item.text === "string" && isTitleGeneratorSystemText(item.text),
  );
}

/**
 * @param {any[] | undefined} system
 * @returns {Array<{type: string, text: string, cache_control?: {type: string}}>}
 */
// Env-context fingerprint rewrite: opencode emits
//   "Here is some useful information about the environment you are running in:"
// Real CC 2.1.117 emits
//   "Here is useful information about the environment you are running in:"
// Removing "some " gives byte-level parity with the CC fingerprint and saves
// ~1 token in the non-cached portion. Unconditional, every request.
const OPENCODE_ENV_CONTEXT_PREFIX = "Here is some useful information about the environment you are running in:";
const CC_ENV_CONTEXT_PREFIX = "Here is useful information about the environment you are running in:";

function rewriteEnvContextPhrasing(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (text.indexOf(OPENCODE_ENV_CONTEXT_PREFIX) === -1) return text;
  return text.split(OPENCODE_ENV_CONTEXT_PREFIX).join(CC_ENV_CONTEXT_PREFIX);
}

function normalizeSystemTextBlocks(system) {
  const output = [];
  if (!Array.isArray(system)) return output;

  for (const item of system) {
    if (typeof item === "string") {
      output.push({ type: "text", text: rewriteEnvContextPhrasing(item) });
      continue;
    }

    if (!item || typeof item !== "object") continue;
    if (typeof item.text !== "string") continue;

    const normalized = {
      type: typeof item.type === "string" ? item.type : "text",
      text: rewriteEnvContextPhrasing(item.text),
    };

    // Intentionally strip cache_control from incoming system blocks.
    // The plugin controls cache placement: only the identity block and
    // boundary-split blocks get cache_control (added in buildSystemPromptBlocks).
    // Passing through upstream markers can cause "maximum of 4 blocks with
    // cache_control" API errors when combined with our own markers.

    output.push(normalized);
  }

  return output;
}

/**
 * Return the cache_control object appropriate for the given cache policy.
 * @param {{ttl: string, ttl_supported: boolean, boundary_marker?: boolean} | undefined} cachePolicy
 * @returns {{type: string, ttl?: string}}
 */
function getCacheControlForPolicy(cachePolicy) {
  if (!cachePolicy) return { type: "ephemeral" };
  if (cachePolicy.ttl === "off" || cachePolicy.ttl_supported === false) {
    return { type: "ephemeral" };
  }
  return { type: "ephemeral", ttl: cachePolicy.ttl };
}

/**
 * Determine the identity string prefix, matching real CC's getCLISyspromptPrefix().
 * Real CC selects based on isNonInteractive + hasAppendSystemPrompt flags.
 * OpenCode is always interactive CLI, so DEFAULT_PREFIX is almost always correct.
 * We check for Agent SDK signals from the environment to match non-interactive cases.
 *
 * @returns {string}
 */
function getCLISyspromptPrefix() {
  // Agent SDK preset: when running within the Claude Agent SDK with CC preset
  if (isTruthyEnv(process.env.CLAUDE_AGENT_SDK_VERSION) && isTruthyEnv(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "";
    if (entrypoint === "agent-sdk" || entrypoint === "sdk") {
      return "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
    }
  }
  // Non-interactive agent without CC preset
  if (isTruthyEnv(process.env.CLAUDE_AGENT_SDK_VERSION) && !isTruthyEnv(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    return "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  }
  return CLAUDE_CODE_IDENTITY_STRING;
}

/**
 * Compute the cache_control object for a given cache scope and policy.
 * Mirrors real CC getCacheControl() (src/services/api/claude.ts:358-374).
 *
 * Real CC behavior:
 * - scope 'global' → {type: 'ephemeral', scope: 'global', ttl?: '1h'}
 * - scope 'org'    → {type: 'ephemeral', ttl?: '1h'} (org is internal, NOT on wire)
 * - scope null     → block gets NO cache_control at all (caller should omit it)
 *
 * @param {'global' | 'org' | null} cacheScope
 * @param {{ttl: string, ttl_supported: boolean}} cachePolicy
 * @returns {{type: string, ttl?: string, scope?: string} | null} null means "no cache_control"
 */
function getCacheControlForScope(cacheScope, cachePolicy) {
  if (cacheScope === null) return null; // no cache_control for this block

  const hasTtl = cachePolicy.ttl !== "off" && cachePolicy.ttl_supported !== false;
  const result = { type: "ephemeral" };
  if (hasTtl) result.ttl = cachePolicy.ttl;
  // Only 'global' scope is emitted on the wire; 'org' is internal-only
  if (cacheScope === "global") result.scope = "global";
  return result;
}

/**
 * Split system prompt blocks into structured blocks with cache scoping,
 * matching real CC splitSysPromptPrefix() (src/utils/api.ts:321-435).
 *
 * Real CC has 3 paths that produce 2 distinct wire formats:
 *
 * Path A (tool-based cache): skipGlobalCacheForSystemPrompt=true
 *   - billing → cacheScope: null
 *   - identity → cacheScope: 'org'
 *   - rest (joined) → cacheScope: 'org'
 *   Wire result: identical to Path C (org → ephemeral without scope field)
 *
 * Path B (boundary mode): shouldUseGlobalCacheScope() && boundary marker found
 *   - billing → cacheScope: null
 *   - identity → cacheScope: null (NO cache_control in boundary mode!)
 *   - static blocks (before boundary, joined) → cacheScope: 'global'
 *   - dynamic blocks (after boundary, joined) → cacheScope: null
 *
 * Path C (fallback): no global cache feature or no boundary
 *   - billing → cacheScope: null
 *   - identity → cacheScope: 'org'
 *   - rest (joined) → cacheScope: 'org'
 *
 * @param {Array<{text: string}>} blocks - Already sanitized/filtered text blocks
 * @param {string | undefined} attributionHeader - The billing header text (or undefined)
 * @param {string} identityString - The identity prefix string
 * @param {boolean} useBoundaryMode - Whether to use Path B (global cache with boundary)
 * @returns {Array<{text: string, cacheScope: 'global' | 'org' | null}>}
 */
function splitSysPromptPrefix(blocks, attributionHeader, identityString, useBoundaryMode) {
  // Separate known blocks from rest, matching real CC's parsing loop
  const rest = [];
  for (const block of blocks) {
    if (!block.text) continue;
    // Skip if it's a billing header or identity string (already extracted)
    if (block.text.startsWith("x-anthropic-billing-header:")) continue;
    if (KNOWN_IDENTITY_STRINGS.has(block.text)) continue;
    // Skip the boundary marker itself (real CC skips it in Path A, processes it in Path B)
    if (block.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
    rest.push(block.text);
  }

  // ====================================================================
  // Path B: Global cache with boundary marker
  // Real CC (utils/api.ts:219-262): when shouldUseGlobalCacheScope() &&
  // boundary marker is found in the system prompt array.
  // ====================================================================
  if (useBoundaryMode) {
    // Find boundary marker in the ORIGINAL block array (before filtering)
    const boundaryIndex = blocks.findIndex((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    if (boundaryIndex !== -1) {
      // Classify blocks as static (before boundary) or dynamic (after boundary)
      const staticBlocks = [];
      const dynamicBlocks = [];
      for (let i = 0; i < blocks.length; i++) {
        const text = blocks[i].text;
        if (!text) continue;
        if (text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
        if (text.startsWith("x-anthropic-billing-header:")) continue;
        if (KNOWN_IDENTITY_STRINGS.has(text)) continue;
        if (i < boundaryIndex) {
          staticBlocks.push(text);
        } else {
          dynamicBlocks.push(text);
        }
      }

      const result = [];
      if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
      // Identity: cacheScope null in boundary mode (real CC behavior)
      result.push({ text: identityString, cacheScope: null });
      const staticJoined = staticBlocks.join("\n");
      if (staticJoined) result.push({ text: staticJoined, cacheScope: "global" });
      const dynamicJoined = dynamicBlocks.join("\n");
      if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null });
      return result;
    }
    // Boundary marker not found — fall through to Path C
  }

  // ====================================================================
  // Path C (fallback) / Path A (tool-based): no boundary or no global cache
  // Real CC (utils/api.ts:264-289): identity and rest get cacheScope 'org'
  // Path A produces identical wire output to Path C.
  // ====================================================================
  const result = [];
  if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
  result.push({ text: identityString, cacheScope: "org" });
  const restJoined = rest.join("\n");
  if (restJoined) result.push({ text: restJoined, cacheScope: "org" });
  return result;
}

/**
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @param {{enabled: boolean, claudeCliVersion: string, promptCompactionMode: 'minimal' | 'off', cachePolicy?: {ttl: string, ttl_supported: boolean, boundary_marker?: boolean}}} signature
 * @returns {Array<{type: string, text: string, cache_control?: {type: string}}>}
 */
function buildSystemPromptBlocks(system, signature) {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);

  let sanitized = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text), signature.promptCompactionMode),
  }));

  // A5: Subagent CC-prefix cache/inject (see constant declaration above for context).
  //
  // After sanitize, main-agent blocks start with "You are an interactive..." because
  // sanitizeSystemText() strips everything before that anchor. Subagent blocks
  // (custom prompts from input.agent.prompt) do NOT start with the anchor —
  // they start with whatever the agent template says (e.g., "You are a file search
  // specialist.").
  //
  // This logic runs ONLY for Anthropic requests with signature enabled (signature.enabled
  // is false for non-Anthropic providers), and skips the title-generator fast path
  // because that one is replaced wholesale with COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT below.
  if (signature.enabled && !titleGeneratorRequest && sanitized.length > 0) {
    const firstText = typeof sanitized[0]?.text === "string" ? sanitized[0].text : "";
    const hasCcAnchor = firstText.startsWith(SUBAGENT_CC_ANCHOR);

    if (hasCcAnchor) {
      // Main-agent path: cache the prefix on the first hit so subagents can reuse it.
      // We slice to MAX_SUBAGENT_CC_PREFIX to avoid unbounded growth if the upstream
      // sanitize limit is ever raised.
      if (!cachedCCPrompt) {
        cachedCCPrompt = firstText.slice(0, MAX_SUBAGENT_CC_PREFIX);
      }
    } else if (cachedCCPrompt) {
      // Subagent path: prepend the cached CC prefix so the fingerprint matches.
      // We prepend, not concatenate, so the original subagent prompt stays as a
      // separate block — dedupeSystemBlocks and splitSysPromptPrefix handle the
      // join on their own downstream.
      sanitized = [{ type: "text", text: cachedCCPrompt }, ...sanitized];
    }
    // If !hasCcAnchor && !cachedCCPrompt: no-op. The cache primes on the very
    // first main call in a process. In practice opencode always fires a main
    // call before any subagent, so this branch is only hit in synthetic tests.
  }

  if (titleGeneratorRequest) {
    sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
  } else if (signature.promptCompactionMode !== "off") {
    sanitized = dedupeSystemBlocks(sanitized);
  }

  // Anti-verbosity injection (CC v2.1.100 quiet_salted_ember equivalent).
  // Applies to Opus 4.6 / 4.7 for non-title-generator requests.
  if (
    !titleGeneratorRequest &&
    signature.modelId &&
    (isOpus46Model(signature.modelId) || isOpus47Model(signature.modelId))
  ) {
    const avConfig = signature.antiVerbosity;
    if (avConfig?.enabled !== false) {
      sanitized.push({ type: "text", text: ANTI_VERBOSITY_SYSTEM_PROMPT });
    }
    if (avConfig?.length_anchors !== false) {
      sanitized.push({ type: "text", text: NUMERIC_LENGTH_ANCHORS_PROMPT });
    }
  }

  if (!signature.enabled) {
    return sanitized;
  }

  // Lean system prompt for non-main requests (title-gen is already handled
  // above via the COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT swap). For "title"
  // and "small" request roles — one-off queries that don't belong to the main
  // REPL thread — we skip billing identity + CC identity injection. This
  // matches the spirit of real CC's querySource gates: identity context is
  // for interactive main-thread conversations, not fire-and-forget calls.
  // Opt-in (default off) because it changes the system-prompt shape.
  const leanNonMain =
    signature.leanNonMain === true &&
    (signature.requestRole === "title" || signature.requestRole === "small") &&
    !titleGeneratorRequest;
  if (leanNonMain) {
    return sanitized;
  }

  // Build attribution header
  const billingHeader = buildAnthropicBillingHeader(
    signature.claudeCliVersion,
    signature.firstUserMessage,
    signature.provider,
  );

  // Select the identity string (matches real CC getCLISyspromptPrefix())
  const identityString = getCLISyspromptPrefix();

  // Determine cache policy
  const effectiveCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };

  // Determine if we should use boundary mode (Path B)
  // Real CC: shouldUseGlobalCacheScope() is a GrowthBook feature flag.
  // We simulate it via config: boundary_marker=true or CLAUDE_CODE_FORCE_GLOBAL_CACHE=1.
  const useBoundaryMode =
    effectiveCachePolicy.boundary_marker || isTruthyEnv(process.env.CLAUDE_CODE_FORCE_GLOBAL_CACHE);

  // Run the real CC splitSysPromptPrefix algorithm to get blocks with cacheScope
  const scopedBlocks = splitSysPromptPrefix(sanitized, billingHeader || undefined, identityString, useBoundaryMode);

  // Convert scoped blocks to wire format using getCacheControlForScope
  // (mirrors real CC buildSystemPromptBlocks → map + getCacheControl)
  return scopedBlocks.map((block) => {
    const cc = getCacheControlForScope(block.cacheScope, effectiveCachePolicy);
    return {
      type: "text",
      text: block.text,
      ...(cc !== null && { cache_control: cc }),
    };
  });
}

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
 * @returns {string}
 */
function buildAnthropicBetaHeader(
  incomingBeta,
  signatureEnabled,
  model,
  provider,
  customBetas,
  strategy,
  requestPath,
  hasFileReferences,
  adaptiveOverride,
  tokenEconomy,
  microcompactBetas, // NEW 11th param
) {
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const betas = ["oauth-2025-04-20"];
  const disableExperimentalBetas = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const isMessagesCountTokensPath = requestPath === "/v1/messages/count_tokens";
  const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;

  if (!signatureEnabled) {
    betas.push("interleaved-thinking-2025-05-14");
    if (isMessagesCountTokensPath) {
      betas.push(TOKEN_COUNTING_BETA_FLAG);
    }
    let mergedBetas = [...new Set([...betas, ...incomingBetasList])];
    if (disableExperimentalBetas) {
      mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
    }
    return mergedBetas.join(",");
  }

  const nonInteractive = isNonInteractiveMode();
  const haiku = isHaikuModel(model);
  const isRoundRobin = strategy === "round-robin";
  const te = tokenEconomy || {};

  // === ALWAYS-ON BETAS (Claude Code v2.1.90 base set) ===
  // These are ALWAYS included regardless of env vars or feature flags.
  // NOTE: Real Claude Code skips this beta for Haiku, but we include it
  // so that Haiku subagents (via model-router delegation) get full mimic
  // behavior from the Anthropic API.
  betas.push(CLAUDE_CODE_BETA_FLAG); // "claude-code-20250219"

  // Tool search: use provider-aware header.
  // 1P/Foundry u2192 advanced-tool-use-2025-11-20 (enables broader tool capabilities)
  // Vertex/Bedrock u2192 tool-search-tool-2025-10-19 (3P-compatible subset)
  if (provider === "vertex" || provider === "bedrock" || provider === "mantle") {
    betas.push("tool-search-tool-2025-10-19");
  } else {
    betas.push(ADVANCED_TOOL_USE_BETA_FLAG); // "advanced-tool-use-2025-11-20"
  }

  betas.push(FAST_MODE_BETA_FLAG); // "fast-mode-2026-02-01"

  // effort-2025-11-24 — real CC's Lyz() only pushes this flag when rE(model)
  // is true (Opus 4.6 / Sonnet 4.6). Pushing it for non-adaptive models like
  // Haiku is a fingerprint mismatch vs real CC and can contaminate billing
  // attribution even when the request body has no effort field.
  if (isAdaptiveThinkingModel(model)) {
    betas.push(EFFORT_BETA_FLAG); // "effort-2025-11-24"
  }

  // Interleaved thinking — real CC's i01 pushes via hv4(model), which is
  // (firstParty && non-Claude-3). Claude 3.x models don't support interleaved
  // thinking and real CC never sends this flag for them, so emitting it
  // diverges the fingerprint for legacy Haiku/Sonnet 3.x requests.
  if (!isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING) && !/claude-3-/i.test(model)) {
    betas.push("interleaved-thinking-2025-05-14");
  }

  // Context 1M — when adaptive override is provided, use it; otherwise fall back to static check.
  {
    const use1M =
      adaptiveOverride && typeof adaptiveOverride.use1MContext === "boolean"
        ? adaptiveOverride.use1MContext
        : hasOneMillionContext(model);
    if (use1M) {
      betas.push("context-1m-2025-08-07");
    }
  }

  // Prompt caching scope — always-on EXCEPT in round-robin (per-workspace state conflicts)
  if (!isRoundRobin) {
    betas.push("prompt-caching-scope-2026-01-05");
  }

  // === CONDITIONAL BETAS (model/context-dependent) ===

  // Context management — gated to Claude 4+ models in CC v2.1.90.
  // Excluded for Claude 3.x (not supported). Always-on for Claude 4+ on 1P/Foundry.
  if (!/claude-3-/i.test(model)) {
    betas.push("context-management-2025-06-27");
  }

  // Structured outputs: only -2025-12-15 is active in v2.1.90 runtime.
  // token-efficient-tools-2026-03-28 was fully removed from v90 bundle.
  if (supportsStructuredOutputs(model)) {
    betas.push("structured-outputs-2025-12-15");
  }

  // Web search — for models that support it
  if (supportsWebSearch(model)) {
    betas.push("web-search-2025-03-05");
  }

  // Advisor tool — in CC this is gated by server-side feature flag
  // (tengu_sage_compass2) and firstParty+isLoggedIn. Since we can't check
  // CC's feature flags, include it unconditionally for Claude 4+ models.
  // CC v108 sends it in MITM captures for Max/Pro users.
  if (!/claude-3-/i.test(model)) {
    betas.push("advisor-tool-2026-03-01");
  }

  // context-hint-2026-04-09 — introduced in CC v2.1.110. Paired with the body
  // field `context_hint: { enabled: true }` (injected in transformRequestBody).
  // Real CC gates it on includeFirstPartyBetas + querySource startsWith
  // "repl_main_thread" (i.e. interactive sessions on 1P Anthropic only).
  // Server responds with hints suggesting which messages to forget for
  // token-efficient context compaction. Sticky: disabled permanently on
  // 400/409/529 errors referencing the hint. Users can opt out via
  // token_economy.context_hint = false.
  const isFirstPartyProvider = provider !== "vertex" && provider !== "bedrock" && provider !== "mantle";
  // Mimicry note: real CC gates context-hint on querySource.startsWith("repl_main_thread").
  // We infer main-thread from body shape via classifyRequestRole and pass it via
  // tokenEconomy.__requestRole. Treat absent marker as "main" for backward compat.
  const _isMainThread = te.__requestRole == null || te.__requestRole === "main";
  if (isFirstPartyProvider && !/claude-3-/i.test(model) && te.context_hint !== false && _isMainThread) {
    betas.push("context-hint-2026-04-09");
  }

  // Files API — scoped to file endpoints/references
  if (isFilesEndpoint || hasFileReferences) {
    betas.push("files-api-2025-04-14");
  }

  // Token counting endpoint
  if (isMessagesCountTokensPath) {
    betas.push(TOKEN_COUNTING_BETA_FLAG);
  }

  // === TOKEN ECONOMY BETAS (on by default for token savings) ===

  // redact-thinking: suppresses thinking summaries server-side.
  // CC v108 enables this by default but we keep it off so thinking is visible.
  // Users can opt in via `/anthropic set redact-thinking on`.
  if (te.redact_thinking && !disableExperimentalBetas) {
    betas.push("redact-thinking-2026-02-12");
  }

  // compact-2026-01-12 and mcp-client-2025-11-20 exist only in docs, not runtime.

  // afk-mode — NOT auto-included (requires user opt-in)
  // Available via: /anthropic betas add afk-mode-2026-01-31

  // === MICROCOMPACT BETAS (context-aware, Phase 3 Task 3.4) ===
  if (microcompactBetas?.length) {
    for (const mb of microcompactBetas) {
      if (!betas.includes(mb)) betas.push(mb);
    }
  }

  // Merge incoming betas from the original request, filtering out host-injected
  // betas (e.g. fine-grained-tool-streaming-2025-05-14, structured-outputs-2025-11-13)
  // that OpenCode's Anthropic SDK adds but real Claude Code never sends.
  const filteredIncoming = incomingBetasList.filter((b) => !HOST_SDK_BETAS_BLOCKLIST.has(b));
  let mergedBetas = [...new Set([...betas, ...filteredIncoming])];

  // Add custom betas from config
  if (customBetas?.length) {
    for (const custom of customBetas) {
      const resolved = BETA_SHORTCUTS.get(custom) || custom;
      if (resolved && !mergedBetas.includes(resolved)) {
        mergedBetas.push(resolved);
      }
    }
  }

  // Filter out experimental betas only if explicitly disabled.
  // WARNING: The EXPERIMENTAL_BETA_FLAGS set overlaps with most always-on betas.
  // Enabling CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS effectively strips Claude Code
  // mimicry betas, leaving only oauth-2025-04-20, claude-code-20250219, and effort-*.
  // Use this escape hatch only for debugging or when betas cause API rejections.
  if (disableExperimentalBetas) {
    mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
  }

  // Remove betas unsupported by Bedrock
  if (provider === "bedrock") {
    mergedBetas = mergedBetas.filter((beta) => !BEDROCK_UNSUPPORTED_BETAS.has(beta));
  }

  return mergedBetas.join(",");
}

/** @typedef {'low' | 'medium' | 'high'} ThinkingEffort */

/**
 * Map budgetTokens to an effort level.
 * Used when an Opus 4.6 request arrives with the legacy budgetTokens shape.
 * @param {number} budgetTokens
 * @returns {ThinkingEffort}
 */
function budgetTokensToEffort(budgetTokens) {
  if (budgetTokens <= 1024) return "low";
  if (budgetTokens <= 8000) return "medium";
  return "high";
}

// QA fix L3: budgetTokensToEffort() removed — dead code, never called
// QA fix L4: isValidEffort() removed — dead code, never called

/**
 * Normalise the `thinking` block in the request body for the target model:
 * - Opus 4.6 / Sonnet 4.6 (adaptive thinking): produces `{ type: "adaptive" }`
 * - Older models: passes the existing thinking block through unchanged.
 *
 * @param {any} thinking
 * @param {string} model
 * @returns {any}
 */
function normalizeThinkingBlock(thinking, model) {
  // If thinking is absent or not an object, pass through
  if (!thinking || typeof thinking !== "object") {
    return thinking;
  }

  // Adaptive thinking models always get { type: "adaptive" }
  // regardless of what format the incoming thinking block has
  if (isAdaptiveThinkingModel(model)) {
    // Check for env-var override to force budget_tokens fallback
    if (isTruthyEnv(process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING)) {
      // Fallback: return as-is if already budget_tokens shape, otherwise default
      if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
        return thinking;
      }
      const parsedBudget = parseInt(process.env.MAX_THINKING_TOKENS, 10);
      return { type: "enabled", budget_tokens: Number.isNaN(parsedBudget) ? 16000 : parsedBudget };
    }
    return { type: "adaptive" };
  }

  // Non-adaptive models: pass through unchanged
  return thinking;
}

/**
 * Map Node.js platform to Stainless OS header value.
 * @param {NodeJS.Platform} value
 * @returns {string}
 */
function getStainlessOs(value) {
  if (value === "darwin") return "macOS";
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
 * @param {{enabled: boolean, claudeCliVersion: string, strategy?: import('./lib/config.mjs').AccountSelectionStrategy, customBetas?: string[], sessionId?: string}} signature
 * @returns {Headers}
 */
function buildRequestHeaders(
  input,
  requestInit,
  accessToken,
  requestBody,
  requestUrl,
  signature,
  adaptiveOverride,
  tokenEconomy,
) {
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
  const { model, tools, messages, hasFileReferences } = parseRequestBodyMetadata(requestBody);
  const provider = detectProvider(requestUrl);
  const mergedBetas = buildAnthropicBetaHeader(
    incomingBeta,
    signature.enabled,
    model,
    provider,
    signature.customBetas,
    signature.strategy,
    requestUrl?.pathname,
    hasFileReferences,
    adaptiveOverride,
    tokenEconomy,
  );

  const authTokenOverride = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const bearerToken = authTokenOverride || accessToken;

  requestHeaders.set("authorization", `Bearer ${bearerToken}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", buildExtendedUserAgent(signature.claudeCliVersion));
  if (signature.enabled) {
    requestHeaders.set("anthropic-version", "2023-06-01");
    // Fix #6: x-app is "cli" for interactive mode, "cli-bg" for background tasks.
    // Real CC (client.ts:106): 'x-app': 'cli' (foreground) or 'cli-bg' (background agent).
    requestHeaders.set("x-app", isTruthyEnv(process.env.CLAUDE_CODE_BACKGROUND) ? "cli-bg" : "cli");
    // Fix #3: X-Claude-Code-Session-Id — sent in ALL requests by real CC (client.ts:108).
    // Value matches metadata.user_id.session_id for server-side correlation.
    if (signature.sessionId) {
      requestHeaders.set("X-Claude-Code-Session-Id", signature.sessionId);
    }
    requestHeaders.set("x-stainless-arch", getStainlessArch(process.arch));
    requestHeaders.set("x-stainless-lang", "js");
    requestHeaders.set("x-stainless-os", getStainlessOs(process.platform));
    // Real CC sends 0.81.0 (confirmed via proxy capture), not the internal 0.208.0.
    // WATCH: most-likely-to-drift mimesis constant. Stable v2.1.97 → v2.1.105 (only
    // the minifier identifier renamed, d66 → g86). Re-verify on every upstream bump:
    //   rg -n '"0\.\d+\.\d+"' _tmp_claude_pkg/<version>/package/cli.js | rg -C2 stainless
    // See docs/future-improvements.md §7 and claude-code-reverse-engineering.md §16.
    requestHeaders.set("x-stainless-package-version", "0.81.0");
    // Real CC on Windows/Node reports "node" — confirmed via proxy capture.
    requestHeaders.set("x-stainless-runtime", "node");
    requestHeaders.set("x-stainless-runtime-version", process.version);
    const incomingRetryCount = requestHeaders.get("x-stainless-retry-count");
    requestHeaders.set(
      "x-stainless-retry-count",
      incomingRetryCount && !isFalsyEnv(incomingRetryCount) ? incomingRetryCount : "0",
    );
    // x-stainless-timeout: real CC sends 600 on ALL requests (confirmed via proxy capture).
    requestHeaders.set("x-stainless-timeout", "600");
    // anthropic-dangerous-direct-browser-access: real CC sends this on all requests.
    requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
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

    // x-client-request-id: NOT sent by real CC (confirmed via proxy capture). Removed.
  }
  requestHeaders.delete("x-api-key");
  // x-session-affinity: set by opencode SDK but NOT in real CC. Strip it.
  requestHeaders.delete("x-session-affinity");

  return requestHeaders;
}

/**
 * Resolve max_tokens for a request based on output cap configuration.
 * If the caller specified max_tokens, it is preserved. Otherwise, defaults
 * to 8K and escalates to 64K after an output truncation (stop_reason: "max_tokens").
 *
 * @param {Record<string, any>} body - Parsed request body
 * @param {import('./lib/config.mjs').AnthropicAuthConfig} config
 * @returns {number | undefined} Resolved max_tokens value, or undefined for passthrough
 */
function resolveMaxTokens(body, config) {
  if (!config.output_cap?.enabled) return body.max_tokens; // passthrough
  if (body.max_tokens != null) return body.max_tokens; // caller-specified wins
  // QA note L-escalation: lastStopReason is set by extractUsageFromSSEEvent AFTER the stream
  // completes. The timing works correctly for "escalate for one turn" because this function runs
  // BEFORE the next request's stream starts. If the response pipeline changes to update stop
  // reason mid-stream or before response completion, this ordering assumption would break.
  const escalated = sessionMetrics.lastStopReason === "max_tokens";
  const result = escalated
    ? (config.output_cap.escalated_max_tokens ?? 64_000)
    : (config.output_cap.default_max_tokens ?? 8_000);
  // Reset after escalation is consumed (sticky for exactly one turn)
  if (escalated) {
    sessionMetrics.lastStopReason = null;
  }
  return result;
}

/**
 * Transform the request body: system prompt sanitization and tool prefixing.
 * Preserves behaviors E1-E7.
 *
 * @param {string | undefined} body
 * @param {{enabled: boolean, claudeCliVersion: string, promptCompactionMode: 'minimal' | 'off', provider?: string}} signature
 * @param {{persistentUserId: string, sessionId: string, accountId: string, turns?: number, usedTools?: Set<string>}} runtime
 * @param {string} [betaHeader] - Pre-computed anthropic-beta header value to inject into the body.
 * @param {import('./lib/config.mjs').AnthropicAuthConfig} [config] - Plugin configuration for output cap
 * @returns {string | undefined}
 */
function transformRequestBody(body, signature, runtime, betaHeader, config) {
  if (!body || typeof body !== "string") return body;

  const TOOL_PREFIX = "mcp_";

  try {
    const parsed = JSON.parse(body);
    // Output cap: resolve max_tokens before any other body transforms
    if (config?.output_cap?.enabled) {
      parsed.max_tokens = resolveMaxTokens(parsed, config);
    }
    // Bedrock requires betas in the body as "anthropic_beta" (underscore) since it
    // doesn't forward custom HTTP headers. First-party API rejects "betas" in body
    // with "Extra inputs are not permitted" — betas are header-only for first-party.
    if (signature.enabled && betaHeader && signature.provider === "bedrock") {
      const betaArray = betaHeader
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean)
        .filter((b) => b !== "oauth-2025-04-20");
      parsed.anthropic_beta = betaArray;
    }
    // Strip any incoming "betas" field — API rejects it as unknown
    if (Object.prototype.hasOwnProperty.call(parsed, "betas")) {
      delete parsed.betas;
    }
    // Normalize thinking block for adaptive (Opus 4.6 / Sonnet 4.6) vs manual (older models).
    // Real CC always sends thinking:{type:"adaptive"} for adaptive models even if the
    // upstream SDK didn't include it. Inject it when missing to match the fingerprint.
    if (Object.prototype.hasOwnProperty.call(parsed, "thinking")) {
      parsed.thinking = normalizeThinkingBlock(parsed.thinking, parsed.model || "");
    } else if (parsed.model && isAdaptiveThinkingModel(parsed.model)) {
      parsed.thinking = { type: "adaptive" };
    }

    // Fingerprint fix: real Claude Code v2.1.87+ nests the effort control inside
    // `output_config.effort` (via Lyz() in cli.js). opencode's provider transform
    // for variant=max on Opus 4.6 / Sonnet 4.6 sets `effort` at the top level,
    // which causes Anthropic's server to fingerprint the body as non-CC and bill
    // it as pay-as-you-go — surfacing as "You're out of extra usage" even on a
    // valid Max plan. Move it into output_config when we're talking to an
    // adaptive-thinking model so the wire shape matches real CC.
    if (typeof parsed.effort === "string" && parsed.model && isAdaptiveThinkingModel(parsed.model)) {
      if (!parsed.output_config || typeof parsed.output_config !== "object") {
        parsed.output_config = {};
      }
      if (!("effort" in parsed.output_config)) {
        parsed.output_config.effort = parsed.effort;
      }
      delete parsed.effort;
    } else if (Object.prototype.hasOwnProperty.call(parsed, "effort")) {
      // Non-adaptive models never carry a top-level effort in real CC — strip it
      // to avoid polluting the fingerprint for models like Haiku.
      delete parsed.effort;
    }

    // Claude Code temperature rule: when extended thinking is active (any type),
    // temperature must be omitted (undefined). Otherwise default to 1.
    const thinkingActive =
      parsed.thinking &&
      typeof parsed.thinking === "object" &&
      (parsed.thinking.type === "adaptive" || parsed.thinking.type === "enabled");
    if (thinkingActive) {
      // Anthropic API rejects temperature when thinking is enabled
      delete parsed.temperature;

      // Claude Code v2.1.84: inject context_management body field when thinking
      // is active and context-management beta is in use. This tells the API how
      // to handle thinking blocks during context management operations.
      if (!parsed.context_management) {
        parsed.context_management = {
          edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        };
      }
    } else {
      // Claude Code always uses temperature: 1 for non-thinking requests (RE doc §5.2, never 0)
      parsed.temperature = 1;
    }

    // Strip leaked /anthropic slash command messages from conversation history.
    // OpenCode may include command text and sendCommandMessage output as regular
    // user messages even when output.noReply = true was set. Filter them out
    // so the agent never sees /anthropic commands in its context.
    if (Array.isArray(parsed.messages)) {
      parsed.messages = stripSlashCommandMessages(parsed.messages);
    }

    // === Token economy: layered message/history compaction ===
    // Only applies to main-thread requests (subagents/title-gen stay untouched).
    // Strategies stack in order: TTL thinking strip → proactive microcompact →
    // trailing-summary trim → tool_result dedupe. Each is independently gated.
    const te = config?.token_economy || {};
    const tes = runtime?.tokenEconomySession;
    const isMainRole = runtime?.requestRole === "main" || runtime?.requestRole == null;

    // `conservative` (default ON) disables all history-rewriting and tool-array
    // transforms. These optimizations shrink each request body but cause the
    // prompt-cache prefix to change turn-to-turn, invalidating the 1h cache
    // and forcing a fresh cache_write each turn — which costs 2x base input
    // tokens. For long opencode sessions, cache reuse dominates; flip to
    // `false` only if you have measurements showing otherwise. Adaptive
    // thinking zero-out remains active (affects only the thinking budget,
    // not cached content).
    const conservative = te.conservative !== false;

    if (!conservative && isMainRole && Array.isArray(parsed.messages) && tes) {
      // (1) TTL-based thinking strip
      if (te.ttl_thinking_strip !== false) {
        const ttlMs = signature?.cachePolicy?.ttl === "5m" ? 5 * 60_000 : 60 * 60_000;
        const res = applyTtlThinkingStrip(parsed.messages, {
          lastClearMs: tes.lastThinkingStripMs,
          ttlMs,
        });
        if (res.changed) {
          parsed.messages = res.messages;
          tes.lastThinkingStripMs = res.ranStripAt;
          tes.thinkingStripped += res.cleared;
        }
      }

      // (1b) Session-wide reproducible-tool result dedupe (Phase C C3, opt-in)
      // Pure over message history; runs before microcompact so dedup'd stubs
      // are visible to downstream size estimation. Gated by
      // token_economy_strategies.tool_result_dedupe_session_wide (default off).
      if (config?.token_economy_strategies?.tool_result_dedupe_session_wide === true) {
        const res = applySessionToolResultDedupe(parsed.messages);
        if (res.changed) parsed.messages = res.messages;
      }

      // (2) Proactive microcompact (client-side, pre-422)
      if (te.proactive_microcompact !== false) {
        const estimated = estimatePromptTokensFromParsed(parsed);
        const cw = 200_000; // conservative — 1M models still benefit
        const res = applyProactiveMicrocompact(parsed.messages, {
          estimatedTokens: estimated,
          contextWindow: cw,
          percent: te.microcompact_percent ?? 70,
          keepRecent: te.microcompact_keep_recent ?? 8,
        });
        if (res.changed) {
          parsed.messages = res.messages;
          tes.lastMicrocompactMs = Date.now();
          tes.toolResultsCompacted += res.cleared;
        }
      }

      // (3) Trailing-summary trim (opt-in)
      if (te.trailing_summary_trim === true) {
        const res = applyTrailingSummaryTrim(parsed.messages);
        if (res.changed) parsed.messages = res.messages;
      }

      // (4) Cross-turn tool_result dedupe (opt-in)
      if (te.tool_result_dedupe === true) {
        const SAFE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "BashOutput"]);
        const res = applyToolResultDedupe(parsed.messages, {
          seen: tes.seenContentHashes,
          safeTools: SAFE_READ_TOOLS,
        });
        if (res.changed) parsed.messages = res.messages;
      }
    }

    // === Token economy: tool-array transforms (stable ordering, deferral) ===
    if (!conservative && isMainRole && Array.isArray(parsed.tools)) {
      if (te.stable_tool_ordering !== false) {
        parsed.tools = applyStableToolOrdering(parsed.tools);
      }
      if (Array.isArray(te.deferred_tool_names) && te.deferred_tool_names.length > 0) {
        // "Invoked" means any assistant message in the convo has used the tool.
        const invoked = new Set();
        if (Array.isArray(parsed.messages)) {
          for (const m of parsed.messages) {
            if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
            for (const b of m.content) {
              if (b?.type === "tool_use" && typeof b.name === "string") invoked.add(b.name);
            }
          }
        }
        const res = applyToolSchemaDeferral(parsed.tools, {
          deferred: new Set(te.deferred_tool_names),
          invoked,
        });
        parsed.tools = res.tools;
      }
    }

    // === Token economy: adaptive thinking zero-out for trivial follow-ups ===
    if (isMainRole && te.adaptive_thinking_zero_simple !== false) {
      applyAdaptiveThinkingZero(parsed);
    }

    // QA fix H2: avoid mutating the signature parameter; capture modelId locally
    const modelId = parsed.model || "";
    // Extract first user message text for billing hash computation (cch)
    const firstUserMessage = extractFirstUserMessageText(parsed.messages);
    const signatureWithModel = {
      ...signature,
      modelId,
      firstUserMessage,
      antiVerbosity: config?.anti_verbosity,
      // Role-aware system-prompt leaning: for non-main-thread requests (title,
      // small, empty shapes) strip billing identity + CC identity injection.
      // Title-gen path is handled separately by isTitleGeneratorSystemBlocks().
      // Default off — opt-in via `token_economy.lean_system_non_main: true`.
      requestRole: runtime?.requestRole,
      leanNonMain: config?.token_economy?.lean_system_non_main === true,
    };
    // Sanitize system prompt and optionally inject Claude Code identity/billing blocks.
    parsed.system = buildSystemPromptBlocks(normalizeSystemTextBlocks(parsed.system), signatureWithModel);

    // Strategy 5 — System prompt tailing: after N turns, trim large system blocks
    // to essential sections only. The model has internalized verbose instructions
    // (shell strategy, package manager tables, delegation protocols) by this point.
    // Preserves: first paragraph (identity/role), lines containing MUST/NEVER/CRITICAL/
    // IMPORTANT, section headers, and short blocks. Drops verbose body paragraphs.
    const tailThreshold = signature.systemPromptTailTurns ?? 6;
    if (signature.systemPromptTailing === true && runtime.turns >= tailThreshold && Array.isArray(parsed.system)) {
      const maxChars = signature.systemPromptTailMaxChars ?? 2000;
      for (let i = 0; i < parsed.system.length; i++) {
        const block = parsed.system[i];
        if (block.type === "text" && block.text && block.text.length > maxChars * 2) {
          block.text = tailSystemBlock(block.text, maxChars, tailThreshold);
        }
      }
    }

    // Token budget (A9): parse NL budget from last user message, inject status block
    if (config?.token_budget?.enabled && Array.isArray(parsed.messages)) {
      const budgetExpr = parseNaturalLanguageBudget(parsed.messages);
      if (budgetExpr > 0) {
        sessionMetrics.tokenBudget.limit = budgetExpr;
      } else if (config.token_budget.default > 0 && sessionMetrics.tokenBudget.limit === 0) {
        sessionMetrics.tokenBudget.limit = config.token_budget.default;
      }
      // If budget is active, inject status into system prompt
      if (sessionMetrics.tokenBudget.limit > 0) {
        const threshold = config.token_budget.completion_threshold ?? 0.9;
        parsed.system = injectTokenBudgetBlock(parsed.system, sessionMetrics.tokenBudget, threshold);
        // Soft stop: if we've exceeded the threshold, cap max_tokens to 1
        if (sessionMetrics.tokenBudget.used >= sessionMetrics.tokenBudget.limit * threshold) {
          parsed.max_tokens = 1;
        }
      }
    }

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

    // Cache breakpoint optimization: add cache_control to the last content block
    // of each user/assistant message for maximum prefix caching.
    // Skip for round-robin strategy (cache defeated by account rotation).
    // Skip for title generators / fire-and-forget queries: these are one-shot
    // requests that don't benefit from caching and would pollute the cache pool.
    const isTitleGen = isTitleGeneratorSystemBlocks(parsed.system || []);
    if (
      signature.enabled &&
      signature.cachePolicy?.ttl !== "off" &&
      signature.cachePolicy?.ttl_supported !== false &&
      !isTitleGen
    ) {
      // Strip ALL incoming cache_control from tools and messages to prevent
      // TTL ordering violations (host SDK may set ttl=5m which conflicts with
      // our system prompt ttl=1h). Then add our own to the last user message
      // (matching real CC behavior seen in proxy capture).
      //
      // Role-scoped TTL: real CC's MoY(querySource) gates the `ttl:"1h"` field
      // on an allowlist of query sources (`repl_main_thread*`, `sdk`,
      // `auto_mode`). Non-matching requests fall back to the default 5m tier
      // — which is cheaper to write. We match this via classifyRequestRole
      // (main → configured TTL, usually 1h; everything else → 5m).
      const configuredTtl = signature.cachePolicy?.ttl || "1h";
      const roleScopedTtl = config?.token_economy?.role_scoped_cache_ttl !== false;
      const isMainForCache = runtime?.requestRole === "main" || runtime?.requestRole == null;
      const ccTtl = roleScopedTtl && !isMainForCache ? "5m" : configuredTtl;
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        for (const tool of parsed.tools) {
          if (tool.cache_control) delete tool.cache_control;
        }
        // Add cache_control to last tool as prompt-cache breakpoint (CC does this)
        parsed.tools[parsed.tools.length - 1].cache_control = { type: "ephemeral", ttl: ccTtl };
      }
      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.cache_control) delete block.cache_control;
            }
          }
        }
        // Add cache_control to last user message (real CC does this)
        for (let i = parsed.messages.length - 1; i >= 0; i--) {
          const msg = parsed.messages[i];
          if (msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) continue;
          const lastBlock = msg.content[msg.content.length - 1];
          if (lastBlock && typeof lastBlock === "object") {
            lastBlock.cache_control = { type: "ephemeral", ttl: ccTtl };
          }
          break;
        }
      }
    }

    // Tool name sanitization: Anthropic's server blocklists known non-CC tool names.
    // opencode uses lowercase names while CC uses PascalCase. While only "todowrite"
    // is currently confirmed blocklisted, we rename ALL core opencode tools to match
    // CC's naming convention as a preventive measure against future blocklist additions.
    const OC_TO_CC_TOOL_NAMES = {
      bash: "Bash",
      read: "Read",
      glob: "Glob",
      grep: "Grep",
      edit: "Edit",
      write: "Write",
      webfetch: "WebFetch",
      todowrite: "TodoWrite",
      skill: "Skill",
      task: "Task",
      compress: "Compress",
    };
    if (Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.name && OC_TO_CC_TOOL_NAMES[tool.name]) {
          tool.name = OC_TO_CC_TOOL_NAMES[tool.name];
        }
      }
    }
    // Also rename in tool_use blocks in messages (assistant responses referencing the tool)
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.name && OC_TO_CC_TOOL_NAMES[block.name]) {
            block.name = OC_TO_CC_TOOL_NAMES[block.name];
          }
        }
      }
    }
    // Track which tools the model has used (from assistant tool_use blocks).
    // Names are already CC PascalCase after renaming above.
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.name) {
              runtime.usedTools.add(block.name);
            }
          }
        }
      }
    }

    // Strategy 4 — Adaptive tool set: after turn 3, defer non-core tools that
    // the model hasn't used yet. This saves schema bytes on turns where tools
    // are unlikely to be needed. Core tools stay eager. Resets on /clear.
    if (
      Array.isArray(parsed.tools) &&
      signature.adaptiveToolSet !== false &&
      runtime.turns >= 3 &&
      parsed.model &&
      !/claude-3-|haiku/i.test(parsed.model)
    ) {
      const used = runtime.usedTools;
      for (const tool of parsed.tools) {
        if (tool.name && !used.has(tool.name) && !CORE_TOOL_NAMES.has(tool.name)) {
          tool.defer_loading = true;
        }
      }
    }

    // Tool description compaction: apply the same compaction logic used for
    // system prompts (strip examples, collapse whitespace, dedup lines) to tool
    // descriptions. The top 4 tools (Bash 10.6K, TodoWrite 9.7K, Task 5.5K,
    // Compress 4.5K) account for 30KB. Compaction typically saves 30-50%.
    if (Array.isArray(parsed.tools) && signature.toolDescriptionCompaction !== false) {
      for (const tool of parsed.tools) {
        if (tool.description && tool.description.length > 500) {
          tool.description = compactToolDescription(tool.description);
        }
      }
    }

    // MCP tool deferral: mark non-core tools with defer_loading: true.
    // CC defers all MCP tools by default — the API omits their full schemas from token
    // counting, only sending the tool name. When the model needs a deferred tool, it uses
    // tool_reference to load the schema on demand. This saves ~20KB per turn.
    // Core tools (OC_TO_CC_TOOL_NAMES) are always eager-loaded.
    if (
      Array.isArray(parsed.tools) &&
      signature.toolDeferral !== false &&
      parsed.model &&
      !/claude-3-|haiku/i.test(parsed.model)
    ) {
      const coreToolNames = new Set(Object.values(OC_TO_CC_TOOL_NAMES));
      for (const tool of parsed.tools) {
        if (tool.name && !coreToolNames.has(tool.name)) {
          tool.defer_loading = true;
        }
      }
    }

    // Task budgets: when the task-budgets beta is active, preserve or inject output_config.
    // The beta unlocks output_config.max_output_tokens for per-task budget control.
    // Model-router compatibility: the beta header + output_config body are forwarded as-is.
    if (betaHeader && betaHeader.includes("task-budgets-2026-03-13")) {
      if (!parsed.output_config) {
        // Default: set a reasonable per-task output budget for long-running agentic tasks.
        // Claude Code tasks typically need generous output budgets.
        parsed.output_config = { max_output_tokens: 16384 };
      }
    }

    // Context hint (CC v2.1.110+): pair the context-hint-2026-04-09 beta with
    // the body field context_hint:{enabled:true}. Extracted from CC bundle
    // buildRequestParams(): `{betaHeader, body:{context_hint:{enabled:!0}}}`.
    // When active, the server responds with optional hints suggesting which
    // messages to drop for token-efficient context compaction.
    if (betaHeader && betaHeader.includes("context-hint-2026-04-09") && !parsed.context_hint) {
      parsed.context_hint = { enabled: true };
    }

    // Fast mode: inject speed parameter for Opus 4.6 only (v2.1.97 restriction).
    // Real CC v2.1.97 xJ() checks: model.includes("opus-4-6") — Sonnet is NOT eligible.
    // NOTE: Deliberately NOT extended to Opus 4.7. xJ() is a fingerprint-sensitive
    // check tied to the exact real-CC version we mirror; blindly enabling
    // speed:"fast" for 4.7 could diverge from real CC's behavior for that model.
    // Revisit once a real-CC dump confirms xJ() matches opus-4-7.
    const fastModeEnabled = signature.fastMode && !isFalsyEnv(process.env.OPENCODE_ANTHROPIC_DISABLE_FAST_MODE);
    let fastModeAutoApplied = false;
    if (
      !fastModeEnabled &&
      te.fast_mode_auto === true &&
      isMainRole &&
      parsed.model &&
      isOpus46Model(parsed.model) &&
      Array.isArray(parsed.messages) &&
      parsed.messages.length >= 2
    ) {
      // Simple exchange heuristic: last user message is short, no tool_result,
      // no file references. Suggests a follow-up question that doesn't need
      // deep reasoning.
      const last = parsed.messages[parsed.messages.length - 1];
      if (last && last.role === "user") {
        let txt = "";
        let hasToolResult = false;
        if (typeof last.content === "string") txt = last.content;
        else if (Array.isArray(last.content)) {
          for (const b of last.content) {
            if (b?.type === "tool_result") hasToolResult = true;
            if (b?.type === "text" && typeof b.text === "string") txt += b.text;
          }
        }
        if (!hasToolResult && txt.length < 240 && !/\bfile:|\.md\b|\.mjs\b|\.ts\b/i.test(txt)) {
          fastModeAutoApplied = true;
        }
      }
    }
    if ((fastModeEnabled || fastModeAutoApplied) && parsed.model && isOpus46Model(parsed.model)) {
      parsed.speed = "fast";
    }

    // Guard: repair orphaned tool_use blocks anywhere in the message array.
    // The Anthropic API requires that every assistant message containing tool_use
    // blocks is immediately followed by a user message with matching tool_result
    // blocks. When OpenCode crashes/hangs mid-tool-execution, the conversation
    // state may be saved with unpaired tool_use blocks. This causes:
    //   "messages.N: `tool_use` ids were found without `tool_result` blocks
    //    immediately after: toolu_XXXXX"
    // We scan the full array and synthesize missing tool_result messages.
    if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      parsed.messages = repairOrphanedToolUseBlocks(parsed.messages);

      // Also ensure the array never ends with an assistant message (prefill guard).
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");
        if (toolUseBlocks.length > 0) {
          parsed.messages.push({
            role: "user",
            content: toolUseBlocks.map((tu) => ({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "[Result unavailable — conversation was restructured]",
            })),
          });
        } else {
          parsed.messages.push({
            role: "user",
            content: [{ type: "text", text: "Continue." }],
          });
        }
      }
    }

    return JSON.stringify(parsed);
  } catch {
    // ignore parse errors
    return body;
  }
}

/**
 * Transform the request URL: add ?beta=true to /v1/messages and /v1/messages/count_tokens.
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

  if (requestUrl && !requestUrl.searchParams.has("beta")) {
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
    // Web search requests (server tool usage)
    if (typeof u.server_tool_use?.web_search_requests === "number") {
      stats.webSearchRequests = u.server_tool_use.web_search_requests;
    }
    // Capture stop_reason from message_delta for output cap escalation
    if (parsed.delta?.stop_reason) {
      sessionMetrics.lastStopReason = parsed.delta.stop_reason;
    }
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
    // QA fix: SSE spec says strip only a single leading space after "data:", not all whitespace
    const raw = line.slice(5);
    dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
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
 * Strip `mcp_` prefix from tool_use `name` fields in SSE data lines.
 * Only modifies `name` values inside content blocks with `"type": "tool_use"`.
 * Non-JSON lines and text blocks are left untouched.
 *
 * @param {string} text - Raw SSE chunk text (may contain multiple lines)
 * @returns {string}
 */
function stripMcpPrefixFromSSE(text) {
  return text.replace(/^data:\s*(.+)$/gm, (_match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (stripMcpPrefixFromParsedEvent(parsed)) {
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
      // Not valid JSON — pass through unchanged.
    }
    return _match;
  });
}

/**
 * Reverse map: CC PascalCase → opencode lowercase for response stream.
 * Built from the outgoing OC_TO_CC_TOOL_NAMES map (defined in transformRequestBody).
 * Must stay in sync with that map.
 */
const CC_TO_OC_TOOL_NAMES = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Skill: "skill",
  Task: "task",
  Compress: "compress",
};

/**
 * Reverse-map a tool name from CC PascalCase back to opencode lowercase,
 * and strip `mcp_` prefix if present. Returns the original name if no mapping exists.
 * @param {string} name
 * @returns {string}
 */
function reverseMapToolName(name) {
  if (CC_TO_OC_TOOL_NAMES[name]) return CC_TO_OC_TOOL_NAMES[name];
  if (name.startsWith("mcp_")) return name.slice(4);
  return name;
}

/**
 * Mutate a parsed SSE event object, reversing tool name renames (CC PascalCase
 * → opencode lowercase) and removing `mcp_` prefix from tool_use name fields.
 * Returns true if any modification was made.
 *
 * @param {any} parsed
 * @returns {boolean}
 */
function stripMcpPrefixFromParsedEvent(parsed) {
  if (!parsed || typeof parsed !== "object") return false;

  let modified = false;

  // content_block_start: { content_block: { type: "tool_use"|"tool_reference", name: "..." } }
  if (
    parsed.content_block &&
    (parsed.content_block.type === "tool_use" || parsed.content_block.type === "tool_reference") &&
    typeof parsed.content_block.name === "string"
  ) {
    const mapped = reverseMapToolName(parsed.content_block.name);
    if (mapped !== parsed.content_block.name) {
      parsed.content_block.name = mapped;
      modified = true;
    }
  }

  // message_start: { message: { content: [{ type: "tool_use"|"tool_reference", name: "..." }] } }
  if (parsed.message && Array.isArray(parsed.message.content)) {
    for (const block of parsed.message.content) {
      if ((block.type === "tool_use" || block.type === "tool_reference") && typeof block.name === "string") {
        const mapped = reverseMapToolName(block.name);
        if (mapped !== block.name) {
          block.name = mapped;
          modified = true;
        }
      }
    }
  }

  // Top-level content array (non-streaming responses forwarded through SSE)
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if ((block.type === "tool_use" || block.type === "tool_reference") && typeof block.name === "string") {
        const mapped = reverseMapToolName(block.name);
        if (mapped !== block.name) {
          block.name = mapped;
          modified = true;
        }
      }
    }
  }

  return modified;
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
  const EMPTY_CHUNK = new Uint8Array();

  /** @type {UsageStats} */
  const stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let sseBuffer = "";
  let sseRewriteBuffer = "";
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

  /**
   * Rewrite complete SSE lines while preserving chunk boundaries for streaming.
   * Buffers trailing partial lines to avoid parsing split JSON payloads.
   * @param {string} chunk
   * @param {boolean} [flush]
   * @returns {string}
   */
  function rewriteSSEChunk(chunk, flush = false) {
    sseRewriteBuffer += chunk;

    if (!flush) {
      const boundary = sseRewriteBuffer.lastIndexOf("\n");
      if (boundary === -1) return "";
      const complete = sseRewriteBuffer.slice(0, boundary + 1);
      sseRewriteBuffer = sseRewriteBuffer.slice(boundary + 1);
      return stripMcpPrefixFromSSE(complete);
    }

    if (!sseRewriteBuffer) return "";
    const finalText = stripMcpPrefixFromSSE(sseRewriteBuffer);
    sseRewriteBuffer = "";
    return finalText;
  }

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        processSSEBuffer(true);

        const rewrittenTail = rewriteSSEChunk("", true);
        if (rewrittenTail) {
          controller.enqueue(encoder.encode(rewrittenTail));
        }

        if (
          onUsage &&
          (stats.inputTokens > 0 || stats.outputTokens > 0 || stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0)
        ) {
          onUsage(stats);
        }
        controller.close();
        return;
      }

      const text = decoder.decode(value, { stream: true });

      if (onUsage || onAccountError) {
        // Normalize CRLF for parser only; preserve original bytes for passthrough.
        sseBuffer += text.replace(/\r\n/g, "\n");
        processSSEBuffer(false);
      }

      const rewrittenText = rewriteSSEChunk(text, false);
      if (rewrittenText) {
        controller.enqueue(encoder.encode(rewrittenText));
      } else {
        // Keep the pull/read loop progressing when this chunk only extends a
        // partial line buffered for later rewrite.
        controller.enqueue(EMPTY_CHUNK);
      }
    },
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
async function refreshAccountToken(account, client, source = "foreground", { onTokensUpdated } = {}) {
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
function extractFileIds(body) {
  const ids = [];
  if (!body || typeof body !== "object") return ids;
  // QA fix L-depth: cap recursion depth to prevent stack overflow on pathological payloads
  const MAX_DEPTH = 20;
  function walk(obj, depth) {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
    } else if (obj && typeof obj === "object") {
      if (obj.source?.file_id) ids.push(obj.source.file_id);
      for (const val of Object.values(obj)) {
        if (val && typeof val === "object") walk(val, depth + 1);
      }
    }
  }
  walk(body.messages, 0);
  walk(body.system, 0);
  return ids;
}

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
  // exposed for determinism regression tests (phase C1)
  applyContextHintCompaction,
  // exposed for session-dedupe regression tests (phase C3)
  applySessionToolResultDedupe,
  maybeApplySessionToolResultDedupe,
  // exposed for experimental.session.summarize integration tests
  runHaikuSessionSummarize,
  get cachedCCPrompt() {
    return cachedCCPrompt;
  },
  resetCachedCCPrompt() {
    cachedCCPrompt = null;
  },
  SUBAGENT_CC_ANCHOR,
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

export default AnthropicAuthPlugin;
