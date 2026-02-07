import { promises as fs } from "node:fs";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfigDir } from "./config.mjs";

/**
 * @typedef {object} AccountStats
 * @property {number} requests
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} lastReset
 */

/**
 * @typedef {object} AccountMetadata
 * @property {string} id
 * @property {string} [email]
 * @property {string} refreshToken
 * @property {string} [access]
 * @property {number} [expires]
 * @property {number} addedAt
 * @property {number} lastUsed
 * @property {boolean} enabled
 * @property {Record<string, number>} rateLimitResetTimes
 * @property {number} consecutiveFailures
 * @property {number | null} lastFailureTime
 * @property {string} [lastSwitchReason]
 * @property {AccountStats} stats
 */

/**
 * @typedef {object} AccountStorage
 * @property {number} version
 * @property {AccountMetadata[]} accounts
 * @property {number} activeIndex
 */

const CURRENT_VERSION = 1;

/**
 * Create a fresh stats object.
 * @param {number} [now]
 * @returns {AccountStats}
 */
export function createDefaultStats(now) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastReset: now ?? Date.now(),
  };
}

/**
 * Validate and normalise a stats object, filling in missing fields.
 * @param {unknown} raw
 * @param {number} now
 * @returns {AccountStats}
 */
function validateStats(raw, now) {
  if (!raw || typeof raw !== "object") return createDefaultStats(now);
  const s = /** @type {Record<string, unknown>} */ (raw);
  const safeNum = (/** @type {unknown} */ v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  return {
    requests: safeNum(s.requests),
    inputTokens: safeNum(s.inputTokens),
    outputTokens: safeNum(s.outputTokens),
    cacheReadTokens: safeNum(s.cacheReadTokens),
    cacheWriteTokens: safeNum(s.cacheWriteTokens),
    lastReset: typeof s.lastReset === "number" && Number.isFinite(s.lastReset) ? s.lastReset : now,
  };
}

const GITIGNORE_ENTRIES = [".gitignore", "anthropic-accounts.json", "anthropic-accounts.json.*.tmp"];

/**
 * Get the path to the accounts storage file.
 * @returns {string}
 */
export function getStoragePath() {
  return join(getConfigDir(), "anthropic-accounts.json");
}

/**
 * Ensure .gitignore in the config directory includes our files.
 * @param {string} configDir
 */
export function ensureGitignore(configDir) {
  const gitignorePath = join(configDir, ".gitignore");
  try {
    let content = "";
    /** @type {string[]} */
    let existingLines = [];

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    }

    const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));

    if (missingEntries.length === 0) return;

    if (content === "") {
      writeFileSync(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, suffix + missingEntries.join("\n") + "\n", "utf-8");
    }
  } catch {
    // Ignore gitignore errors
  }
}

/**
 * Deduplicate accounts by refresh token, keeping the most recently used.
 * @param {AccountMetadata[]} accounts
 * @returns {AccountMetadata[]}
 */
export function deduplicateByRefreshToken(accounts) {
  /** @type {Map<string, AccountMetadata>} */
  const tokenMap = new Map();

  for (const acc of accounts) {
    if (!acc.refreshToken) continue;
    const existing = tokenMap.get(acc.refreshToken);
    if (!existing || (acc.lastUsed || 0) > (existing.lastUsed || 0)) {
      tokenMap.set(acc.refreshToken, acc);
    }
  }

  return Array.from(tokenMap.values());
}

/**
 * Validate a single account entry.
 * @param {unknown} raw
 * @param {number} now
 * @returns {AccountMetadata | null}
 */
function validateAccount(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const acc = /** @type {Record<string, unknown>} */ (raw);

  if (typeof acc.refreshToken !== "string" || !acc.refreshToken) return null;

  const addedAt = typeof acc.addedAt === "number" && Number.isFinite(acc.addedAt) ? acc.addedAt : now;

  const id = typeof acc.id === "string" && acc.id ? acc.id : `${addedAt}:${acc.refreshToken.slice(0, 12)}`;

  return {
    id,
    email: typeof acc.email === "string" ? acc.email : undefined,
    refreshToken: acc.refreshToken,
    access: typeof acc.access === "string" ? acc.access : undefined,
    expires: typeof acc.expires === "number" && Number.isFinite(acc.expires) ? acc.expires : undefined,
    addedAt,
    lastUsed: typeof acc.lastUsed === "number" && Number.isFinite(acc.lastUsed) ? acc.lastUsed : 0,
    enabled: acc.enabled !== false,
    rateLimitResetTimes:
      acc.rateLimitResetTimes && typeof acc.rateLimitResetTimes === "object" && !Array.isArray(acc.rateLimitResetTimes)
        ? /** @type {Record<string, number>} */ (acc.rateLimitResetTimes)
        : {},
    consecutiveFailures:
      typeof acc.consecutiveFailures === "number" ? Math.max(0, Math.floor(acc.consecutiveFailures)) : 0,
    lastFailureTime: typeof acc.lastFailureTime === "number" ? acc.lastFailureTime : null,
    lastSwitchReason: typeof acc.lastSwitchReason === "string" ? acc.lastSwitchReason : undefined,
    stats: validateStats(acc.stats, now),
  };
}

/**
 * Load accounts from disk.
 * @returns {Promise<AccountStorage | null>}
 */
export async function loadAccounts() {
  const storagePath = getStoragePath();

  try {
    const content = await fs.readFile(storagePath, "utf-8");
    const data = JSON.parse(content);

    if (!data || typeof data !== "object" || !Array.isArray(data.accounts)) {
      return null;
    }

    if (data.version !== CURRENT_VERSION) {
      // Future: handle migrations here
      return null;
    }

    const now = Date.now();
    const accounts = data.accounts
      .map((raw) => validateAccount(raw, now))
      .filter(/** @returns {acc is AccountMetadata} */ (acc) => acc !== null);

    const deduped = deduplicateByRefreshToken(accounts);

    let activeIndex = typeof data.activeIndex === "number" && Number.isFinite(data.activeIndex) ? data.activeIndex : 0;

    if (deduped.length > 0) {
      activeIndex = Math.max(0, Math.min(activeIndex, deduped.length - 1));
    } else {
      activeIndex = 0;
    }

    return {
      version: CURRENT_VERSION,
      accounts: deduped,
      activeIndex,
    };
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

/**
 * Save accounts to disk atomically.
 * @param {AccountStorage} storage
 * @returns {Promise<void>}
 */
export async function saveAccounts(storage) {
  const storagePath = getStoragePath();
  const configDir = dirname(storagePath);

  await fs.mkdir(configDir, { recursive: true });
  ensureGitignore(configDir);

  const tempPath = `${storagePath}.${randomBytes(6).toString("hex")}.tmp`;
  const content = JSON.stringify(storage, null, 2);

  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tempPath, storagePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Clear all accounts from disk.
 * @returns {Promise<void>}
 */
export async function clearAccounts() {
  const storagePath = getStoragePath();
  try {
    await fs.unlink(storagePath);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== "ENOENT") throw error;
  }
}
