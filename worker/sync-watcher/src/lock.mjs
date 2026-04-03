/**
 * Distributed lock using Cloudflare KV.
 *
 * Prevents concurrent cron invocations from racing. Uses KV with a TTL
 * to ensure stale locks are automatically reclaimed.
 *
 * Note: KV is eventually consistent, so this lock provides best-effort
 * mutual exclusion — sufficient for cron deduplication (not for strict
 * distributed transactions). The Workers cron scheduler fires at most once
 * per 15 minutes, making races extremely unlikely in practice.
 *
 * KV key: lock:<name>
 * KV value: JSON { acquiredAt: ISO string, ttlMs: number }
 *
 * @module lock
 */

import { LOCK_TTL_MS } from "./types.mjs";

const LOCK_KEY_PREFIX = "lock:";

/**
 * Attempt to acquire a named lock.
 *
 * Returns true if the lock was acquired (or a stale lock was reclaimed).
 * Returns false if the lock is currently held by another invocation.
 *
 * @param {KVNamespace} kv
 * @param {string} name - Lock name (e.g. "cron")
 * @param {number} [ttlMs] - Lock TTL in milliseconds (default: LOCK_TTL_MS)
 * @returns {Promise<boolean>}
 */
export async function acquireLock(kv, name, ttlMs = LOCK_TTL_MS) {
  const key = lockKey(name);
  const existing = await kv.get(key, { type: "json" });

  if (existing) {
    // Check if lock is stale
    const age = Date.now() - new Date(existing.acquiredAt).getTime();
    if (age < existing.ttlMs) {
      // Lock is fresh — cannot acquire
      return false;
    }
    // Lock is stale — fall through to acquire
  }

  const value = { acquiredAt: new Date().toISOString(), ttlMs };
  // Store with KV TTL slightly longer than logical TTL to ensure cleanup
  const kvTtlSeconds = Math.ceil(ttlMs / 1000) + 30;
  await kv.put(key, JSON.stringify(value), { expirationTtl: kvTtlSeconds });
  return true;
}

/**
 * Release a named lock.
 *
 * @param {KVNamespace} kv
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function releaseLock(kv, name) {
  await kv.delete(lockKey(name));
}

/**
 * KV key for a named lock.
 *
 * @param {string} name
 * @returns {string}
 */
function lockKey(name) {
  return `${LOCK_KEY_PREFIX}${name}`;
}
