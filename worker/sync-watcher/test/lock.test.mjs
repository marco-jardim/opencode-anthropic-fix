import { describe, it, expect, vi, afterEach } from "vitest";
import { acquireLock, releaseLock } from "../src/lock.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

/** In-memory KV mock with TTL support */
function makeKV() {
  const store = new Map(); // key → { value: string, expiresAt: number|null }
  return {
    async get(key, opts) {
      const entry = store.get(key);
      if (!entry) return null;
      // Simulate expiry
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      if (opts?.type === "json") return JSON.parse(entry.value);
      return entry.value;
    },
    async put(key, value, opts) {
      const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
      store.set(key, { value: typeof value === "string" ? value : JSON.stringify(value), expiresAt });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe("acquireLock", () => {
  it("acquires lock when no lock exists", async () => {
    const kv = makeKV();
    const acquired = await acquireLock(kv, "cron", 120_000);
    expect(acquired).toBe(true);
  });

  it("fails to acquire when fresh lock is held", async () => {
    const kv = makeKV();
    await acquireLock(kv, "cron", 120_000);
    const second = await acquireLock(kv, "cron", 120_000);
    expect(second).toBe(false);
  });

  it("reclaims stale lock (age > TTL)", async () => {
    const kv = makeKV();
    // Inject a lock that appears to have been acquired 3 minutes ago
    const staleEntry = JSON.stringify({
      acquiredAt: new Date(Date.now() - 180_000).toISOString(),
      ttlMs: 120_000,
    });
    await kv.put("lock:cron", staleEntry);

    const acquired = await acquireLock(kv, "cron", 120_000);
    expect(acquired).toBe(true);
  });

  it("does not reclaim fresh lock", async () => {
    const kv = makeKV();
    const freshEntry = JSON.stringify({
      acquiredAt: new Date(Date.now() - 30_000).toISOString(), // 30 seconds ago
      ttlMs: 120_000,
    });
    await kv.put("lock:cron", freshEntry);

    const acquired = await acquireLock(kv, "cron", 120_000);
    expect(acquired).toBe(false);
  });

  it("uses different keys for different lock names", async () => {
    const kv = makeKV();
    await acquireLock(kv, "cron", 120_000);

    // Different lock name — should succeed
    const acquired = await acquireLock(kv, "other-lock", 120_000);
    expect(acquired).toBe(true);
  });
});

describe("releaseLock", () => {
  it("releases a held lock (acquire → release → acquire succeeds)", async () => {
    const kv = makeKV();
    await acquireLock(kv, "cron", 120_000);
    await releaseLock(kv, "cron");
    const reacquired = await acquireLock(kv, "cron", 120_000);
    expect(reacquired).toBe(true);
  });

  it("releasing a non-existent lock is a no-op", async () => {
    const kv = makeKV();
    await expect(releaseLock(kv, "nonexistent")).resolves.not.toThrow();
  });
});
