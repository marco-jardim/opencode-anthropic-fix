import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const itPosix = process.platform === "win32" ? it.skip : it;
const baseDir = join(tmpdir(), `opencode-refresh-lock-test-${process.pid}`);
const storagePath = join(baseDir, "anthropic-accounts.json");

vi.mock("./storage.mjs", () => ({
  getStoragePath: () => storagePath,
}));

import { acquireRefreshLock, releaseRefreshLock } from "./refresh-lock.mjs";

describe("refresh-lock", () => {
  beforeEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("acquires the lock on the first attempt", async () => {
    const lock = await acquireRefreshLock("acc-first-acquire");

    expect(lock.acquired).toBe(true);
    expect(lock.lockPath).toMatch(/[\\/]locks[\\/]refresh-[0-9a-f]{24}\.lock$/);
    expect(lock.owner).toMatch(/^[0-9a-f]{24}$/);
    expect(lock.lockInode).toEqual(expect.any(Number));

    await releaseRefreshLock(lock);
  });

  it("allows exactly one concurrent caller to acquire the lock", async () => {
    const attempts = await Promise.all([
      acquireRefreshLock("acc-concurrent", { timeoutMs: 150, backoffMs: 5, staleMs: 60_000 }),
      acquireRefreshLock("acc-concurrent", { timeoutMs: 150, backoffMs: 5, staleMs: 60_000 }),
    ]);
    const winners = attempts.filter((attempt) => attempt.acquired);
    const losers = attempts.filter((attempt) => !attempt.acquired);

    expect(winners).toHaveLength(1);
    expect(losers).toEqual([{ acquired: false, lockPath: null, owner: null, lockInode: null }]);

    await releaseRefreshLock(winners[0]);

    const reacquired = await acquireRefreshLock("acc-concurrent", { timeoutMs: 50 });
    expect(reacquired.acquired).toBe(true);
    await releaseRefreshLock(reacquired);
  });

  it("rejects when opening the lock file fails with a non-contention error", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const openSpy = vi.spyOn(fs, "open").mockRejectedValueOnce(error);

    try {
      await expect(acquireRefreshLock("acc-io-failure")).rejects.toMatchObject({ code: "EACCES" });
      expect(openSpy).toHaveBeenCalledWith(expect.stringMatching(/refresh-[0-9a-f]{24}\.lock$/), "wx", 0o600);
    } finally {
      openSpy.mockRestore();
    }
  });

  itPosix("creates the lock file with owner-only POSIX permissions", async () => {
    const lock = await acquireRefreshLock("acc-posix-permissions");

    expect(lock.acquired).toBe(true);
    const stat = await fs.stat(lock.lockPath);
    expect(stat.mode & 0o777).toBe(0o600);

    await releaseRefreshLock(lock);
  });

  it("does not release lock with mismatched owner", async () => {
    const lock = await acquireRefreshLock("acc-1");
    expect(lock.acquired).toBe(true);
    expect(lock.lockPath).toBeTruthy();

    await releaseRefreshLock({ lockPath: lock.lockPath, owner: "wrong-owner" });

    await expect(fs.stat(lock.lockPath)).resolves.toBeTruthy();

    await releaseRefreshLock(lock);
    await expect(fs.stat(lock.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("acquires a new lock after stale lock timeout", async () => {
    const first = await acquireRefreshLock("acc-2", { timeoutMs: 50, staleMs: 10_000 });
    expect(first.acquired).toBe(true);

    const old = Date.now() / 1000 - 120;
    await fs.utimes(first.lockPath, old, old);

    const second = await acquireRefreshLock("acc-2", { timeoutMs: 200, backoffMs: 5, staleMs: 20 });
    expect(second.acquired).toBe(true);
    expect(second.owner).not.toBe(first.owner);

    await releaseRefreshLock(second);
  });

  it("returns not acquired when lock remains busy", async () => {
    const first = await acquireRefreshLock("acc-3", { timeoutMs: 50 });
    expect(first.acquired).toBe(true);

    const second = await acquireRefreshLock("acc-3", { timeoutMs: 30, backoffMs: 5, staleMs: 60_000 });
    expect(second.acquired).toBe(false);

    await releaseRefreshLock(first);
  });

  it("does not release when inode changed even if owner matches", async () => {
    const first = await acquireRefreshLock("acc-4");
    expect(first.acquired).toBe(true);

    // Replace lock file with a new inode that reuses owner text.
    await fs.unlink(first.lockPath);
    await fs.writeFile(first.lockPath, JSON.stringify({ owner: first.owner, createdAt: Date.now() }), {
      encoding: "utf-8",
      mode: 0o600,
    });

    await releaseRefreshLock(first);

    await expect(fs.stat(first.lockPath)).resolves.toBeTruthy();

    await fs.unlink(first.lockPath);
  });
});
