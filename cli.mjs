#!/usr/bin/env node

/**
 * CLI for managing Anthropic multi-account OAuth configuration.
 *
 * Usage:
 *   opencode-anthropic-auth [command] [args]
 *
 * Commands:
 *   list              Show all accounts with status (default)
 *   status            Compact one-liner for scripts/prompts
 *   switch <N>        Set account N as active
 *   enable <N>        Enable a disabled account
 *   disable <N>       Disable an account (skipped in rotation)
 *   remove <N>        Remove an account permanently
 *   reset <N|all>     Clear rate-limit / failure tracking
 *   stats             Show per-account usage statistics
 *   reset-stats [N|all] Reset usage statistics
 *   strategy [name]   Show or change account selection strategy
 *   config            Show current configuration and file paths
 *   manage            Interactive account management menu
 *   help              Show this help message
 */

import { loadAccounts, saveAccounts, getStoragePath, createDefaultStats } from "./lib/storage.mjs";
import { loadConfig, saveConfig, getConfigPath, VALID_STRATEGIES, CLIENT_ID } from "./lib/config.mjs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ---------------------------------------------------------------------------
// Color helpers — zero dependencies, respects NO_COLOR / TTY
// ---------------------------------------------------------------------------

let USE_COLOR =
  !process.env.NO_COLOR &&
  process.stdout.isTTY !== false;

/** @param {string} code @param {string} text @returns {string} */
const ansi = (code, text) => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);

const c = {
  bold:    (/** @type {string} */ t) => ansi("1", t),
  dim:     (/** @type {string} */ t) => ansi("2", t),
  green:   (/** @type {string} */ t) => ansi("32", t),
  yellow:  (/** @type {string} */ t) => ansi("33", t),
  cyan:    (/** @type {string} */ t) => ansi("36", t),
  red:     (/** @type {string} */ t) => ansi("31", t),
  gray:    (/** @type {string} */ t) => ansi("90", t),
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format milliseconds as a human-readable duration.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms <= 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m ${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

/**
 * Format a timestamp as relative time ago.
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimeAgo(timestamp) {
  if (!timestamp || timestamp === 0) return "never";
  const ms = Date.now() - timestamp;
  if (ms < 0) return "just now";
  return `${formatDuration(ms)} ago`;
}

/**
 * Shorten a path by replacing home directory with ~.
 * @param {string} p
 * @returns {string}
 */
function shortPath(p) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/**
 * Strip ANSI escape codes from a string to get its visible content.
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Left-pad a string to a fixed visible width, accounting for ANSI escape codes.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function pad(str, width) {
  const diff = width - stripAnsi(str).length;
  return diff > 0 ? str + " ".repeat(diff) : str;
}

/**
 * Right-align a string to a fixed visible width, accounting for ANSI escape codes.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function rpad(str, width) {
  const diff = width - stripAnsi(str).length;
  return diff > 0 ? " ".repeat(diff) + str : str;
}

// ---------------------------------------------------------------------------
// Usage quota helpers
// ---------------------------------------------------------------------------

/**
 * Refresh an account's OAuth access token.
 * Mutates the account object in-place and returns the new access token.
 * @param {{ refreshToken: string, access?: string, expires?: number }} account
 * @returns {Promise<string | null>}
 */
export async function refreshAccessToken(account) {
  try {
    const resp = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    account.access = json.access_token;
    account.expires = Date.now() + json.expires_in * 1000;
    if (json.refresh_token) account.refreshToken = json.refresh_token;
    return json.access_token;
  } catch {
    return null;
  }
}

/**
 * Fetch usage quotas from the Anthropic OAuth usage endpoint.
 * @param {string} accessToken
 * @returns {Promise<Record<string, any> | null>}
 */
export async function fetchUsage(accessToken) {
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

/**
 * Ensure an account has a valid access token and fetch its usage data.
 * @param {{ refreshToken: string, access?: string, expires?: number, enabled: boolean }} account
 * @returns {Promise<{ usage: Record<string, any> | null, tokenRefreshed: boolean }>}
 */
export async function ensureTokenAndFetchUsage(account) {
  if (!account.enabled) return { usage: null, tokenRefreshed: false };

  let token = account.access;
  let tokenRefreshed = false;

  if (!token || !account.expires || account.expires < Date.now()) {
    token = await refreshAccessToken(account);
    tokenRefreshed = !!token;
    if (!token) return { usage: null, tokenRefreshed: false };
  }

  const usage = await fetchUsage(token);
  return { usage, tokenRefreshed };
}

/**
 * Render a progress bar of a given width for a utilization percentage (0–100).
 * @param {number} utilization - percentage (0 to 100)
 * @param {number} [width=10] - bar character width
 * @returns {string}
 */
export function renderBar(utilization, width = 10) {
  const pct = Math.max(0, Math.min(100, utilization));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;

  let bar;
  if (pct >= 90) {
    bar = c.red("█".repeat(filled)) + c.dim("░".repeat(empty));
  } else if (pct >= 70) {
    bar = c.yellow("█".repeat(filled)) + c.dim("░".repeat(empty));
  } else {
    bar = c.green("█".repeat(filled)) + c.dim("░".repeat(empty));
  }
  return bar;
}

/**
 * Format an ISO 8601 reset timestamp as a relative duration from now.
 * @param {string} isoString
 * @returns {string}
 */
export function formatResetTime(isoString) {
  const resetMs = new Date(isoString).getTime();
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return "now";
  return formatDuration(remaining);
}

/**
 * Known usage quota buckets and their display labels.
 * Order determines display order.
 */
const QUOTA_BUCKETS = [
  { key: "five_hour", label: "5h" },
  { key: "seven_day", label: "7d" },
  { key: "seven_day_sonnet", label: "Sonnet 7d" },
  { key: "seven_day_opus", label: "Opus 7d" },
  { key: "seven_day_oauth_apps", label: "OAuth Apps 7d" },
  { key: "seven_day_cowork", label: "Cowork 7d" },
];

const USAGE_INDENT = "       ";
const USAGE_LABEL_WIDTH = 13;

/**
 * Render usage quota lines for an account.
 * Returns an array of pre-formatted strings (one per non-null bucket).
 * @param {Record<string, any>} usage
 * @returns {string[]}
 */
export function renderUsageLines(usage) {
  const lines = [];
  for (const { key, label } of QUOTA_BUCKETS) {
    const bucket = usage[key];
    if (!bucket || bucket.utilization == null) continue;

    const pct = bucket.utilization;
    const bar = renderBar(pct);
    const pctStr = pad(String(Math.round(pct)) + "%", 4);
    const reset = bucket.resets_at ? c.dim(`resets in ${formatResetTime(bucket.resets_at)}`) : "";

    lines.push(`${USAGE_INDENT}${pad(label, USAGE_LABEL_WIDTH)} ${bar} ${pctStr}${reset ? ` ${reset}` : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List all accounts with full status table and live usage quotas.
 * @returns {Promise<number>} exit code
 */
export async function cmdList() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    console.log(c.dim(`Storage: ${shortPath(getStoragePath())}`));
    console.log(c.dim("\nRun 'opencode auth login' and select 'Claude Pro/Max' to add accounts."));
    return 1;
  }

  const config = loadConfig();
  const now = Date.now();

  // Fetch usage quotas for all enabled accounts in parallel
  const usageResults = await Promise.allSettled(
    stored.accounts.map((acc) => ensureTokenAndFetchUsage(acc)),
  );

  // If any tokens were refreshed, persist them back to disk
  let anyRefreshed = false;
  for (const result of usageResults) {
    if (result.status === "fulfilled" && result.value.tokenRefreshed) {
      anyRefreshed = true;
    }
  }
  if (anyRefreshed) {
    await saveAccounts(stored).catch(() => {});
  }

  console.log(c.bold("Anthropic Multi-Account Status"));

  // Header
  console.log(
    "  " +
    pad(c.dim("#"), 5) +
    pad(c.dim("Account"), 22) +
    pad(c.dim("Status"), 14) +
    pad(c.dim("Failures"), 11) +
    c.dim("Rate Limit"),
  );
  console.log(c.dim("  " + "─".repeat(62)));

  for (let i = 0; i < stored.accounts.length; i++) {
    const acc = stored.accounts[i];
    const isActive = i === stored.activeIndex;
    const num = String(i + 1);

    // Label
    const label = acc.email || `Account ${i + 1}`;

    // Status
    let status;
    if (!acc.enabled) {
      status = c.gray("○ disabled");
    } else if (isActive) {
      status = c.green("● active");
    } else {
      status = c.cyan("● ready");
    }

    // Failures
    let failures;
    if (!acc.enabled) {
      failures = c.dim("—");
    } else if (acc.consecutiveFailures > 0) {
      failures = c.yellow(String(acc.consecutiveFailures));
    } else {
      failures = c.dim("0");
    }

    // Rate limit
    let rateLimit;
    if (!acc.enabled) {
      rateLimit = c.dim("—");
    } else {
      const resetTimes = acc.rateLimitResetTimes || {};
      const maxReset = Math.max(0, ...Object.values(resetTimes));
      if (maxReset > now) {
        rateLimit = c.yellow(`\u26A0 ${formatDuration(maxReset - now)}`);
      } else {
        rateLimit = c.dim("—");
      }
    }

    // Render account header line
    console.log(
      "  " +
      pad(c.bold(num), 5) +
      pad(label, 22) +
      pad(status, 14) +
      pad(failures, 11) +
      rateLimit,
    );

    // Render usage quota lines for enabled accounts
    if (acc.enabled) {
      const result = usageResults[i];
      const usage = result.status === "fulfilled" ? result.value.usage : null;
      if (usage) {
        const lines = renderUsageLines(usage);
        for (const line of lines) {
          console.log(line);
        }
      } else {
        console.log(c.dim(`${USAGE_INDENT}quotas: unavailable`));
      }
    }

    if (i < stored.accounts.length - 1) {
      console.log("");
    }
  }

  console.log("");

  const enabled = stored.accounts.filter((a) => a.enabled).length;
  const disabled = stored.accounts.length - enabled;

  const parts = [
    `Strategy: ${c.cyan(config.account_selection_strategy)}`,
    `${c.bold(String(enabled))} of ${stored.accounts.length} enabled`,
  ];
  if (disabled > 0) {
    parts.push(`${c.yellow(String(disabled))} disabled`);
  }
  console.log(parts.join(c.dim(" | ")));
  console.log(c.dim(`Storage: ${shortPath(getStoragePath())}`));

  return 0;
}

/**
 * Show compact one-liner status.
 * @returns {Promise<number>} exit code
 */
export async function cmdStatus() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log("anthropic: no accounts configured");
    return 1;
  }

  const config = loadConfig();
  const total = stored.accounts.length;
  const enabled = stored.accounts.filter((a) => a.enabled).length;
  const now = Date.now();

  // Count rate-limited accounts
  let rateLimited = 0;
  for (const acc of stored.accounts) {
    if (!acc.enabled) continue;
    const resetTimes = acc.rateLimitResetTimes || {};
    const maxReset = Math.max(0, ...Object.values(resetTimes));
    if (maxReset > now) rateLimited++;
  }

  let line = `anthropic: ${total} account${total !== 1 ? "s" : ""} (${enabled} active)`;
  line += `, strategy: ${config.account_selection_strategy}`;
  line += `, next: #${stored.activeIndex + 1}`;
  if (rateLimited > 0) {
    line += `, ${rateLimited} rate-limited`;
  }

  console.log(line);
  return 0;
}

/**
 * Switch active account.
 * @param {string} arg
 * @returns {Promise<number>} exit code
 */
export async function cmdSwitch(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'switch 2')"));
    return 1;
  }

  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }

  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`));
    return 1;
  }

  if (!stored.accounts[idx].enabled) {
    console.error(c.yellow(`Warning: account ${n} is disabled. Enable it first with 'enable ${n}'.`));
    return 1;
  }

  stored.activeIndex = idx;
  await saveAccounts(stored);

  const label = stored.accounts[idx].email || `Account ${n}`;
  console.log(c.green(`Switched active account to #${n} (${label}).`));
  return 0;
}

/**
 * Enable a disabled account.
 * @param {string} arg
 * @returns {Promise<number>} exit code
 */
export async function cmdEnable(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'enable 3')"));
    return 1;
  }

  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }

  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }

  if (stored.accounts[idx].enabled) {
    console.log(c.dim(`Account ${n} is already enabled.`));
    return 0;
  }

  stored.accounts[idx].enabled = true;
  await saveAccounts(stored);

  const label = stored.accounts[idx].email || `Account ${n}`;
  console.log(c.green(`Enabled account #${n} (${label}).`));
  return 0;
}

/**
 * Disable an account.
 * @param {string} arg
 * @returns {Promise<number>} exit code
 */
export async function cmdDisable(arg) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'disable 3')"));
    return 1;
  }

  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }

  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }

  if (!stored.accounts[idx].enabled) {
    console.log(c.dim(`Account ${n} is already disabled.`));
    return 0;
  }

  // Don't allow disabling the last enabled account
  const enabledCount = stored.accounts.filter((a) => a.enabled).length;
  if (enabledCount <= 1) {
    console.error(c.red("Error: cannot disable the last enabled account."));
    return 1;
  }

  stored.accounts[idx].enabled = false;

  const label = stored.accounts[idx].email || `Account ${n}`;
  let switchedTo = null;

  // If we disabled the active account, switch to the next enabled one
  // (adjust before saving to avoid a TOCTOU race with the running plugin)
  if (idx === stored.activeIndex) {
    const nextEnabled = stored.accounts.findIndex((a) => a.enabled);
    if (nextEnabled >= 0) {
      stored.activeIndex = nextEnabled;
      switchedTo = nextEnabled;
    }
  }

  await saveAccounts(stored);

  console.log(c.yellow(`Disabled account #${n} (${label}).`));
  if (switchedTo !== null) {
    const nextLabel = stored.accounts[switchedTo].email || `Account ${switchedTo + 1}`;
    console.log(c.dim(`Active account switched to #${switchedTo + 1} (${nextLabel}).`));
  }

  return 0;
}

/**
 * Remove an account permanently.
 * @param {string} arg
 * @param {object} [opts]
 * @param {boolean} [opts.force] Skip confirmation prompt
 * @returns {Promise<number>} exit code
 */
export async function cmdRemove(arg, opts = {}) {
  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number (e.g., 'remove 2')"));
    return 1;
  }

  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }

  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }

  const label = stored.accounts[idx].email || `Account ${n}`;

  // Confirm unless --force
  if (!opts.force) {
    if (!process.stdin.isTTY) {
      console.error(c.red("Error: use --force to remove accounts in non-interactive mode."));
      return 1;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(
        `Remove account #${n} (${label})? This cannot be undone. [y/N]: `,
      );
      if (answer.trim().toLowerCase() !== "y") {
        console.log(c.dim("Cancelled."));
        return 0;
      }
    } finally {
      rl.close();
    }
  }

  stored.accounts.splice(idx, 1);

  // Adjust active index
  if (stored.accounts.length === 0) {
    stored.activeIndex = 0;
  } else if (stored.activeIndex >= stored.accounts.length) {
    stored.activeIndex = stored.accounts.length - 1;
  } else if (stored.activeIndex > idx) {
    stored.activeIndex--;
  }

  await saveAccounts(stored);
  console.log(c.green(`Removed account #${n} (${label}).`));

  if (stored.accounts.length > 0) {
    console.log(c.dim(`${stored.accounts.length} account(s) remaining.`));
  } else {
    console.log(c.dim("No accounts remaining. Run 'opencode auth login' to add one."));
  }

  return 0;
}

/**
 * Reset rate-limit and failure tracking.
 * @param {string} arg - Account number or "all"
 * @returns {Promise<number>} exit code
 */
export async function cmdReset(arg) {
  if (!arg) {
    console.error(c.red("Error: provide an account number or 'all' (e.g., 'reset 1' or 'reset all')"));
    return 1;
  }

  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.error(c.red("Error: no accounts configured."));
    return 1;
  }

  if (arg.toLowerCase() === "all") {
    let count = 0;
    for (const acc of stored.accounts) {
      acc.rateLimitResetTimes = {};
      acc.consecutiveFailures = 0;
      acc.lastFailureTime = null;
      count++;
    }
    await saveAccounts(stored);
    console.log(c.green(`Reset tracking for all ${count} account(s).`));
    return 0;
  }

  const n = parseInt(arg, 10);
  if (isNaN(n) || n < 1) {
    console.error(c.red("Error: provide a valid account number or 'all'."));
    return 1;
  }

  const idx = n - 1;
  if (idx >= stored.accounts.length) {
    console.error(c.red(`Error: account ${n} does not exist.`));
    return 1;
  }

  stored.accounts[idx].rateLimitResetTimes = {};
  stored.accounts[idx].consecutiveFailures = 0;
  stored.accounts[idx].lastFailureTime = null;
  await saveAccounts(stored);

  const label = stored.accounts[idx].email || `Account ${n}`;
  console.log(c.green(`Reset tracking for account #${n} (${label}).`));
  return 0;
}

/**
 * Show current configuration.
 * @returns {Promise<number>} exit code
 */
export async function cmdConfig() {
  const config = loadConfig();
  const stored = await loadAccounts();

  console.log(c.bold("Anthropic Auth Configuration"));
  console.log(c.dim("─".repeat(45)));
  console.log("");

  console.log(c.dim("Strategy:          ") + c.cyan(config.account_selection_strategy));
  console.log(c.dim("Failure TTL:       ") + `${config.failure_ttl_seconds}s`);
  console.log(c.dim("Debug:             ") + (config.debug ? c.yellow("on") : c.dim("off")));
  console.log("");

  console.log(c.dim("Health Score"));
  console.log(c.dim("  Initial:         ") + `${config.health_score.initial}`);
  console.log(c.dim("  Success reward:  ") + `+${config.health_score.success_reward}`);
  console.log(c.dim("  Rate limit:      ") + `${config.health_score.rate_limit_penalty}`);
  console.log(c.dim("  Failure:         ") + `${config.health_score.failure_penalty}`);
  console.log(c.dim("  Recovery/hour:   ") + `+${config.health_score.recovery_rate_per_hour}`);
  console.log(c.dim("  Min usable:      ") + `${config.health_score.min_usable}`);
  console.log("");

  console.log(c.dim("Token Bucket"));
  console.log(c.dim("  Max tokens:      ") + `${config.token_bucket.max_tokens}`);
  console.log(c.dim("  Regen/min:       ") + `${config.token_bucket.regeneration_rate_per_minute}`);
  console.log(c.dim("  Initial:         ") + `${config.token_bucket.initial_tokens}`);
  console.log("");

  console.log(c.dim("Files"));
  console.log(c.dim("  Config:          ") + shortPath(getConfigPath()));
  console.log(c.dim("  Accounts:        ") + shortPath(getStoragePath()));

  if (stored) {
    const enabled = stored.accounts.filter((a) => a.enabled).length;
    console.log(c.dim("  Accounts total:  ") + `${stored.accounts.length} (${enabled} enabled)`);
  } else {
    console.log(c.dim("  Accounts total:  ") + c.dim("none"));
  }

  console.log("");

  // Show env var overrides if active
  const envOverrides = [];
  if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    envOverrides.push(`OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY}`);
  }
  if (process.env.OPENCODE_ANTHROPIC_DEBUG) {
    envOverrides.push(`OPENCODE_ANTHROPIC_DEBUG=${process.env.OPENCODE_ANTHROPIC_DEBUG}`);
  }
  if (envOverrides.length > 0) {
    console.log(c.dim("Environment overrides:"));
    for (const ov of envOverrides) {
      console.log(c.dim("  ") + c.yellow(ov));
    }
  }

  return 0;
}

/**
 * Show or change the account selection strategy.
 * @param {string} [arg] - New strategy name, or undefined to show current
 * @returns {Promise<number>} exit code
 */
export async function cmdStrategy(arg) {
  const config = loadConfig();

  if (!arg) {
    // Show current strategy with descriptions
    console.log(c.bold("Account Selection Strategy"));
    console.log(c.dim("─".repeat(45)));
    console.log("");

    const descriptions = {
      sticky: "Stay on one account until it fails or is rate-limited",
      "round-robin": "Rotate through accounts on every request",
      hybrid: "Prefer healthy accounts, rotate when degraded",
    };

    for (const s of VALID_STRATEGIES) {
      const current = s === config.account_selection_strategy;
      const marker = current ? c.green("▸ ") : "  ";
      const name = current ? c.bold(c.cyan(s)) : c.dim(s);
      const desc = current ? descriptions[s] : c.dim(descriptions[s]);
      console.log(`${marker}${pad(name, 16)}${desc}`);
    }

    console.log("");
    console.log(c.dim(`Change with: opencode-anthropic-auth strategy <${VALID_STRATEGIES.join("|")}>`));

    if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
      console.log(c.yellow(`\nNote: OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} overrides config file at runtime.`));
    }

    return 0;
  }

  // Normalize input
  const normalized = arg.toLowerCase().trim();

  if (!VALID_STRATEGIES.includes(normalized)) {
    console.error(c.red(`Error: invalid strategy '${arg}'.`));
    console.error(c.dim(`Valid strategies: ${VALID_STRATEGIES.join(", ")}`));
    return 1;
  }

  if (normalized === config.account_selection_strategy && !process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    console.log(c.dim(`Strategy is already '${normalized}'.`));
    return 0;
  }

  saveConfig({ account_selection_strategy: normalized });
  console.log(c.green(`Strategy changed to '${normalized}'.`));

  if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    console.log(c.yellow(`Note: OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} will override this at runtime.`));
  }

  return 0;
}

/**
 * Format a token count for display. Uses K/M suffixes for readability.
 * @param {number} n
 * @returns {string}
 */
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/**
 * Show per-account usage statistics.
 * @returns {Promise<number>} exit code
 */
export async function cmdStats() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    return 1;
  }

  // Column widths: marker(1) + gap(1) + num(2) + gap(2) + name(20) + gap(2) + 5 numeric cols(10 each)
  const W = { num: 4, name: 22, val: 10 };

  const RULE = c.dim("  " + "─".repeat(74));

  console.log(c.bold("Anthropic Account Usage"));
  console.log(
    "  " +
    pad(c.dim("#"), W.num) +
    pad(c.dim("Account"), W.name) +
    rpad(c.dim("Requests"), W.val) +
    rpad(c.dim("Input"), W.val) +
    rpad(c.dim("Output"), W.val) +
    rpad(c.dim("Cache R"), W.val) +
    rpad(c.dim("Cache W"), W.val),
  );
  console.log(RULE);

  let totReq = 0, totIn = 0, totOut = 0, totCR = 0, totCW = 0;
  let oldestReset = Infinity;

  for (let i = 0; i < stored.accounts.length; i++) {
    const acc = stored.accounts[i];
    const s = acc.stats || createDefaultStats();
    const isActive = i === stored.activeIndex;
    const marker = isActive ? c.green("●") : " ";
    const num = `${marker} ${i + 1}`;
    const name = acc.email || `Account ${i + 1}`;

    console.log(
      "  " +
      pad(num, W.num) +
      pad(name, W.name) +
      rpad(String(s.requests), W.val) +
      rpad(fmtTokens(s.inputTokens), W.val) +
      rpad(fmtTokens(s.outputTokens), W.val) +
      rpad(fmtTokens(s.cacheReadTokens), W.val) +
      rpad(fmtTokens(s.cacheWriteTokens), W.val),
    );

    totReq += s.requests;
    totIn += s.inputTokens;
    totOut += s.outputTokens;
    totCR += s.cacheReadTokens;
    totCW += s.cacheWriteTokens;
    if (s.lastReset < oldestReset) oldestReset = s.lastReset;
  }

  if (stored.accounts.length > 1) {
    console.log(RULE);
    console.log(c.bold(
      "  " +
      pad("", W.num) +
      pad("Total", W.name) +
      rpad(String(totReq), W.val) +
      rpad(fmtTokens(totIn), W.val) +
      rpad(fmtTokens(totOut), W.val) +
      rpad(fmtTokens(totCR), W.val) +
      rpad(fmtTokens(totCW), W.val),
    ));
  }

  console.log("");
  if (oldestReset < Infinity) {
    console.log(c.dim(`Tracking since: ${new Date(oldestReset).toLocaleString()} (${formatTimeAgo(oldestReset)})`));
  }

  return 0;
}

/**
 * Reset usage statistics for one or all accounts.
 * @param {string} [arg] - Account number or "all"
 * @returns {Promise<number>} exit code
 */
export async function cmdResetStats(arg) {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    return 1;
  }

  const now = Date.now();

  if (!arg || arg === "all") {
    for (const acc of stored.accounts) {
      acc.stats = createDefaultStats(now);
    }
    await saveAccounts(stored);
    console.log(c.green("Reset usage statistics for all accounts."));
    return 0;
  }

  const idx = parseInt(arg, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= stored.accounts.length) {
    console.log(c.red(`Invalid account number. Use 1-${stored.accounts.length} or 'all'.`));
    return 1;
  }

  stored.accounts[idx].stats = createDefaultStats(now);
  await saveAccounts(stored);
  const name = stored.accounts[idx].email || `Account ${idx + 1}`;
  console.log(c.green(`Reset usage statistics for ${name}.`));
  return 0;
}

/**
 * Interactive account management menu.
 *
 * Operates on raw storage (not AccountManager) to avoid stale-state issues.
 * Each mutation is saved atomically before the next prompt.
 *
 * @returns {Promise<number>} exit code
 */
export async function cmdManage() {
  let stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    console.log(c.dim("Run 'opencode auth login' and select 'Claude Pro/Max' to add accounts."));
    return 1;
  }

  if (!process.stdin.isTTY) {
    console.error(c.red("Error: 'manage' requires an interactive terminal."));
    console.error(c.dim("Use 'enable', 'disable', 'remove', 'switch' for non-interactive use."));
    return 1;
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      // Re-read from disk each iteration to stay in sync
      stored = await loadAccounts();
      if (!stored || stored.accounts.length === 0) {
        console.log(c.dim("No accounts remaining."));
        break;
      }

      const accounts = stored.accounts;

      console.log("");
      console.log(c.bold(`${accounts.length} account(s):`));
      for (let i = 0; i < accounts.length; i++) {
        const num = i + 1;
        const label = accounts[i].email || `Account ${num}`;
        const active = i === stored.activeIndex ? c.green(" (active)") : "";
        const disabled = !accounts[i].enabled ? c.yellow(" [disabled]") : "";
        console.log(`  ${c.bold(String(num))}. ${label}${active}${disabled}`);
      }
      console.log("");
      const currentStrategy = loadConfig().account_selection_strategy;
      console.log(c.dim(`Strategy: ${currentStrategy}`));
      console.log(c.dim("Commands: (s)witch N, (e)nable N, (d)isable N, (r)emove N, (R)eset N, s(t)rategy, (q)uit"));

      const answer = await rl.question(c.dim("> "));
      const trimmed = answer.trim();

      // Handle quit (case-insensitive)
      if (trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "quit") break;

      // Parse command + number. Keep original case for 'R' detection.
      const match = trimmed.match(/^([a-zA-Z]+)\s*(\d+)?$/);
      if (!match) {
        console.log(c.red("Invalid input. Try 's 2', 'e 3', 'd 1', 'r 2', 'R 1', or 'q'."));
        continue;
      }

      const [, rawCmd, numStr] = match;
      const cmd = rawCmd.toLowerCase();
      const num = numStr ? parseInt(numStr, 10) : NaN;
      const idx = num - 1;

      if (numStr && (isNaN(num) || num < 1 || idx >= accounts.length)) {
        console.log(c.red(`Invalid account number. Valid range: 1-${accounts.length}.`));
        continue;
      }

      // Detect uppercase R for reset (since lowercase 'r' is remove)
      const isReset = rawCmd === "R" || cmd === "reset";

      if (isReset) {
        if (isNaN(num)) { console.log(c.red("Usage: R <number>")); continue; }
        stored.accounts[idx].rateLimitResetTimes = {};
        stored.accounts[idx].consecutiveFailures = 0;
        stored.accounts[idx].lastFailureTime = null;
        await saveAccounts(stored);
        console.log(c.green(`Reset tracking for account #${num}.`));
        continue;
      }

      switch (cmd) {
        case "s":
        case "switch": {
          if (isNaN(num)) { console.log(c.red("Usage: s <number>")); break; }
          if (!accounts[idx].enabled) {
            console.log(c.yellow(`Account ${num} is disabled. Enable it first.`));
            break;
          }
          stored.activeIndex = idx;
          await saveAccounts(stored);
          const switchLabel = accounts[idx].email || `Account ${num}`;
          console.log(c.green(`Switched to #${num} (${switchLabel}).`));
          break;
        }
        case "e":
        case "enable": {
          if (isNaN(num)) { console.log(c.red("Usage: e <number>")); break; }
          if (accounts[idx].enabled) {
            console.log(c.dim(`Account ${num} is already enabled.`));
            break;
          }
          stored.accounts[idx].enabled = true;
          await saveAccounts(stored);
          console.log(c.green(`Enabled account #${num}.`));
          break;
        }
        case "d":
        case "disable": {
          if (isNaN(num)) { console.log(c.red("Usage: d <number>")); break; }
          if (!accounts[idx].enabled) {
            console.log(c.dim(`Account ${num} is already disabled.`));
            break;
          }
          const enabledCount = accounts.filter((a) => a.enabled).length;
          if (enabledCount <= 1) {
            console.log(c.red("Cannot disable the last enabled account."));
            break;
          }
          stored.accounts[idx].enabled = false;
          // Adjust active index if needed
          if (idx === stored.activeIndex) {
            const nextEnabled = accounts.findIndex((a) => a.enabled && accounts.indexOf(a) !== idx);
            if (nextEnabled >= 0) stored.activeIndex = nextEnabled;
          }
          await saveAccounts(stored);
          console.log(c.yellow(`Disabled account #${num}.`));
          break;
        }
        case "r":
        case "remove": {
          if (isNaN(num)) { console.log(c.red("Usage: r <number>")); break; }
          const removeLabel = accounts[idx].email || `Account ${num}`;
          const confirm = await rl.question(`Remove #${num} (${removeLabel})? [y/N]: `);
          if (confirm.trim().toLowerCase() === "y") {
            stored.accounts.splice(idx, 1);
            // Adjust active index
            if (stored.accounts.length === 0) {
              stored.activeIndex = 0;
            } else if (stored.activeIndex >= stored.accounts.length) {
              stored.activeIndex = stored.accounts.length - 1;
            } else if (stored.activeIndex > idx) {
              stored.activeIndex--;
            }
            await saveAccounts(stored);
            console.log(c.green(`Removed account #${num}.`));
          } else {
            console.log(c.dim("Cancelled."));
          }
          break;
        }
        case "t":
        case "strategy": {
          console.log(c.dim(`Current: ${loadConfig().account_selection_strategy}`));
          console.log(c.dim(`Options: ${VALID_STRATEGIES.join(", ")}`));
          const stratAnswer = await rl.question(c.dim("New strategy: "));
          const strat = stratAnswer.trim().toLowerCase();
          if (!strat) {
            console.log(c.dim("Cancelled."));
            break;
          }
          if (!VALID_STRATEGIES.includes(strat)) {
            console.log(c.red(`Invalid strategy. Choose: ${VALID_STRATEGIES.join(", ")}`));
            break;
          }
          saveConfig({ account_selection_strategy: strat });
          console.log(c.green(`Strategy changed to '${strat}'.`));
          break;
        }
        default:
          console.log(c.red("Unknown command. Try 's', 'e', 'd', 'r', 'R', 't', or 'q'."));
      }
    }
  } finally {
    rl.close();
  }

  return 0;
}

/**
 * Show help text.
 */
export function cmdHelp() {
  const bin = "opencode-anthropic-auth";
  console.log(`
${c.bold("Anthropic Multi-Account Auth CLI")}

${c.dim("Usage:")}
  ${bin} [command] [args]

${c.dim("Commands:")}
  ${pad(c.cyan("list"), 22)}Show all accounts with status ${c.dim("(default)")}
  ${pad(c.cyan("status"), 22)}Compact one-liner for scripts/prompts
  ${pad(c.cyan("switch") + " <N>", 22)}Set account N as active
  ${pad(c.cyan("enable") + " <N>", 22)}Enable a disabled account
  ${pad(c.cyan("disable") + " <N>", 22)}Disable an account (skipped in rotation)
  ${pad(c.cyan("remove") + " <N>", 22)}Remove an account permanently
  ${pad(c.cyan("reset") + " <N|all>", 22)}Clear rate-limit / failure tracking
  ${pad(c.cyan("stats"), 22)}Show per-account usage statistics
  ${pad(c.cyan("reset-stats") + " [N|all]", 22)}Reset usage statistics
  ${pad(c.cyan("strategy") + " [name]", 22)}Show or change selection strategy
  ${pad(c.cyan("config"), 22)}Show configuration and file paths
  ${pad(c.cyan("manage"), 22)}Interactive account management menu
  ${pad(c.cyan("help"), 22)}Show this help message

${c.dim("Options:")}
  --force           Skip confirmation prompts
  --no-color        Disable colored output

${c.dim("Examples:")}
  ${bin} list              ${c.dim("# Show all accounts")}
  ${bin} switch 2          ${c.dim("# Make account 2 active")}
  ${bin} disable 3         ${c.dim("# Temporarily disable account 3")}
  ${bin} reset all         ${c.dim("# Clear all rate-limit tracking")}
  ${bin} strategy           ${c.dim("# Show current strategy")}
  ${bin} strategy sticky    ${c.dim("# Switch to sticky mode")}
  ${bin} stats             ${c.dim("# Show token usage per account")}
  ${bin} reset-stats all   ${c.dim("# Zero all usage counters")}
  ${bin} status            ${c.dim("# One-liner for shell prompt")}

${c.dim("Files:")}
  Config:   ${shortPath(getConfigPath())}
  Accounts: ${shortPath(getStoragePath())}
`);
  return 0;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse argv and route to the appropriate command.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));

  // Handle global flags
  if (flags.includes("--no-color")) USE_COLOR = false;
  if (flags.includes("--help")) return cmdHelp();

  const command = args[0] || "list";
  const arg = args[1];

  const force = flags.includes("--force");

  switch (command) {
    case "list":
    case "ls":
      return cmdList();
    case "status":
    case "st":
      return cmdStatus();
    case "switch":
    case "sw":
      return cmdSwitch(arg);
    case "enable":
    case "en":
      return cmdEnable(arg);
    case "disable":
    case "dis":
      return cmdDisable(arg);
    case "remove":
    case "rm":
      return cmdRemove(arg, { force });
    case "reset":
      return cmdReset(arg);
    case "stats":
      return cmdStats();
    case "reset-stats":
      return cmdResetStats(arg);
    case "strategy":
    case "strat":
      return cmdStrategy(arg);
    case "config":
    case "cfg":
      return cmdConfig();
    case "manage":
    case "mg":
      return cmdManage();
    case "help":
    case "-h":
    case "--help":
      return cmdHelp();
    default:
      console.error(c.red(`Unknown command: ${command}`));
      console.error(c.dim("Run 'opencode-anthropic-auth help' for usage."));
      return 1;
  }
}

// Run if executed directly (not imported)
async function detectMain() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  // Handle symlinks (e.g., ~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js → index.mjs)
  try {
    const { realpath } = await import("node:fs/promises");
    const resolved = await realpath(process.argv[1]);
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    return false;
  }
}

if (await detectMain()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(c.red(`Fatal: ${err.message}`));
      process.exit(1);
    });
}
