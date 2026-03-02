import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
