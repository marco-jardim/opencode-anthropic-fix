import { promises as fs } from "node:fs";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
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
 * @property {number} token_updated_at
 * @property {number} addedAt
 * @property {number} lastUsed
 * @property {boolean} enabled
 * @property {Record<string, number>} rateLimitResetTimes
 * @property {number} consecutiveFailures
 * @property {number | null} lastFailureTime
 * @property {string} [lastSwitchReason]
 * @property {AccountStats} stats
 * @property {import('./accounts.mjs').AccountSource} [source] - Origin of the account ('oauth' | 'cc-keychain' | 'cc-file').
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

  // QA fix M12: hash token fragment instead of leaking raw prefix
  const id =
    typeof acc.id === "string" && acc.id
      ? acc.id
      : `${addedAt}:${createHash("sha256").update(acc.refreshToken).digest("hex").slice(0, 12)}`;

  return {
    id,
    email: typeof acc.email === "string" ? acc.email : undefined,
    accountUuid: typeof acc.accountUuid === "string" ? acc.accountUuid : undefined,
    organizationUuid: typeof acc.organizationUuid === "string" ? acc.organizationUuid : undefined,
    refreshToken: acc.refreshToken,
    access: typeof acc.access === "string" ? acc.access : undefined,
    expires: typeof acc.expires === "number" && Number.isFinite(acc.expires) ? acc.expires : undefined,
    token_updated_at:
      typeof acc.token_updated_at === "number" && Number.isFinite(acc.token_updated_at)
        ? acc.token_updated_at
        : typeof acc.tokenUpdatedAt === "number" && Number.isFinite(acc.tokenUpdatedAt)
          ? acc.tokenUpdatedAt
          : addedAt,
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
    source:
      typeof acc.source === "string" && ["oauth", "cc-keychain", "cc-file"].includes(acc.source)
        ? acc.source
        : undefined,
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
      // QA fix H12: warn about version mismatch but attempt best-effort load
      // rather than silently discarding all accounts
      if (typeof data.version === "number" && data.version > CURRENT_VERSION) {
        // Forward-compat: newer versions likely only add fields

        console.warn(
          `[anthropic-auth] accounts file version ${data.version} is newer than expected ${CURRENT_VERSION}; loading with best effort`,
        );
      } else {
        // Unknown/older version — still try to load

        console.warn(
          `[anthropic-auth] accounts file version mismatch (${data.version} vs ${CURRENT_VERSION}); attempting load`,
        );
      }
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
    // QA fix H11: only swallow ENOENT and JSON parse errors; throw for real I/O failures
    if (error instanceof SyntaxError) {
      // Corrupted JSON file — treat as empty
      return null;
    }
    throw error;
  }
}

/**
 * Save accounts to disk atomically.
 * @param {AccountStorage} storage
 * @returns {Promise<void>}
 */
export async function saveAccounts(storage, storageOrDiskData = undefined) {
  const storagePath = getStoragePath();
  const configDir = dirname(storagePath);

  await fs.mkdir(configDir, { recursive: true });
  ensureGitignore(configDir);

  /** @type {AccountStorage} */
  let storageToWrite = storage;

  // QA fix M15: Accept pre-loaded disk data to avoid double-read (TOCTOU mitigation).
  // Callers can pass diskData from their own loadAccounts() call.
  // Merge auth fields against disk by freshness to avoid stale-process clobber.
  // We do not resurrect removed accounts; only merge for accounts present in
  // the incoming storage payload.
  // QA fix: declare diskData param explicitly instead of hidden arguments[1].
  try {
    const disk = storageOrDiskData ?? (await loadAccounts());
    if (disk && storage.accounts.length > 0) {
      const diskById = new Map(disk.accounts.map((a) => [a.id, a]));
      /** @type {Map<number, AccountMetadata[]>} */
      const diskByAddedAt = new Map();
      const diskByToken = new Map(disk.accounts.map((a) => [a.refreshToken, a]));
      for (const d of disk.accounts) {
        const bucket = diskByAddedAt.get(d.addedAt) || [];
        bucket.push(d);
        diskByAddedAt.set(d.addedAt, bucket);
      }

      const findDiskMatch = (/** @type {AccountMetadata} */ acc) => {
        const byId = diskById.get(acc.id);
        if (byId) return byId;

        const byAddedAt = diskByAddedAt.get(acc.addedAt);
        if (byAddedAt?.length === 1) return byAddedAt[0];

        const byToken = diskByToken.get(acc.refreshToken);
        if (byToken) return byToken;

        if (byAddedAt && byAddedAt.length > 0) return byAddedAt[0];
        return null;
      };

      const mergedAccounts = storage.accounts.map((acc) => {
        const diskAcc = findDiskMatch(acc);
        const memTs =
          typeof acc.token_updated_at === "number" && Number.isFinite(acc.token_updated_at)
            ? acc.token_updated_at
            : acc.addedAt;
        const diskTs = diskAcc?.token_updated_at || 0;
        const useDiskAuth = !!diskAcc && diskTs > memTs;

        return {
          ...acc,
          refreshToken: useDiskAuth ? diskAcc.refreshToken : acc.refreshToken,
          access: useDiskAuth ? diskAcc.access : acc.access,
          expires: useDiskAuth ? diskAcc.expires : acc.expires,
          token_updated_at: useDiskAuth ? diskTs : memTs,
        };
      });

      let activeIndex = storage.activeIndex;
      if (mergedAccounts.length > 0) {
        activeIndex = Math.max(0, Math.min(activeIndex, mergedAccounts.length - 1));
      } else {
        activeIndex = 0;
      }

      storageToWrite = {
        ...storage,
        accounts: mergedAccounts,
        activeIndex,
      };
    }
  } catch {
    // If merge read fails, continue with caller-provided storage payload.
  }

  const tempPath = `${storagePath}.${randomBytes(6).toString("hex")}.tmp`;
  const content = JSON.stringify(storageToWrite, null, 2);

  try {
    // QA note H9: mode 0o600 (owner-only read/write) is enforced on Linux/macOS.
    // On Windows, POSIX mode is silently ignored by Node.js — ACLs govern permissions.
    // Windows file inherits parent directory ACLs, which typically restrict access
    // to the current user on per-user directories (%APPDATA%).
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
