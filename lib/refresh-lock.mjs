import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getStoragePath } from "./storage.mjs";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_BACKOFF_MS = 50;
const DEFAULT_STALE_LOCK_MS = 20_000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} accountId
 * @returns {string}
 */
function getLockPath(accountId) {
  const hash = createHash("sha1").update(accountId).digest("hex").slice(0, 24);
  return join(dirname(getStoragePath()), "locks", `refresh-${hash}.lock`);
}

/**
 * Try to acquire a per-account cross-process lock.
 * @param {string} accountId
 * @param {{ timeoutMs?: number, backoffMs?: number, staleMs?: number }} [options]
 * @returns {Promise<{ acquired: boolean, lockPath: string | null, owner: string | null, lockInode: number | null }>}
 */
export async function acquireRefreshLock(accountId, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_LOCK_BACKOFF_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const lockPath = getLockPath(accountId);
  const lockDir = dirname(lockPath);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const owner = randomBytes(12).toString("hex");

  await fs.mkdir(lockDir, { recursive: true });

  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), owner }), "utf-8");
        const stat = await handle.stat();
        return { acquired: true, lockPath, owner, lockInode: stat.ino };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== "EEXIST") {
        throw error;
      }

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // Lock may have been released concurrently; retry.
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const jitter = Math.floor(Math.random() * 25);
      await delay(Math.min(remaining, backoffMs + jitter));
    }
  }

  return { acquired: false, lockPath: null, owner: null, lockInode: null };
}

/**
 * Release a lock acquired by acquireRefreshLock.
 * @param {{ lockPath: string | null, owner?: string | null, lockInode?: number | null } | string | null} lock
 * @returns {Promise<void>}
 */
export async function releaseRefreshLock(lock) {
  const lockPath = typeof lock === "string" || lock === null ? lock : lock.lockPath;
  const owner = typeof lock === "object" && lock ? lock.owner || null : null;
  const lockInode = typeof lock === "object" && lock ? lock.lockInode || null : null;

  if (!lockPath) return;

  // Ownership-safe release: avoid deleting a lock that another process
  // acquired after ours became stale.
  if (owner) {
    try {
      const content = await fs.readFile(lockPath, "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || parsed.owner !== owner) {
        return;
      }

      if (lockInode) {
        const stat = await fs.stat(lockPath);
        if (stat.ino !== lockInode) {
          return;
        }
      }
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === "ENOENT") return;
      // If unreadable/corrupt, fail closed to avoid deleting another
      // process's lock when ownership cannot be verified.
      return;
    }
  }

  try {
    await fs.unlink(lockPath);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== "ENOENT") throw error;
  }
}
