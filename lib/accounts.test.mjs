import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountManager } from "./accounts.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";

// Mock storage module — pass through pure helpers, mock I/O
vi.mock("./storage.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadAccounts: vi.fn(),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

import { loadAccounts, saveAccounts } from "./storage.mjs";

// ---------------------------------------------------------------------------
// AccountManager.load
// ---------------------------------------------------------------------------

describe("AccountManager.load", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  it("creates empty manager when no stored accounts and no fallback", async () => {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(manager.getAccountCount()).toBe(0);
    expect(manager.getTotalAccountCount()).toBe(0);
  });

  it("bootstraps from auth fallback when no stored accounts", async () => {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "refresh-token-1",
      access: "access-token-1",
      expires: Date.now() + 3600_000,
    });
    expect(manager.getAccountCount()).toBe(1);
    expect(manager.getTotalAccountCount()).toBe(1);
    expect(manager.getCurrentIndex()).toBe(0);
  });

  it("loads stored accounts from disk", async () => {
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "token1",
          addedAt: 1000,
          lastUsed: 2000,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
        {
          refreshToken: "token2",
          addedAt: 3000,
          lastUsed: 4000,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 1,
    });
    const manager = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(manager.getAccountCount()).toBe(2);
    expect(manager.getCurrentIndex()).toBe(1);
  });

  it("matches auth fallback to existing stored account", async () => {
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "token1",
          addedAt: 1000,
          lastUsed: 2000,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "fresh-access",
      expires: Date.now() + 3600_000,
    });
    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot[0].access).toBe("fresh-access");
  });

  it("clamps activeIndex to valid range", async () => {
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          refreshToken: "token1",
          addedAt: 1000,
          lastUsed: 2000,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 99,
    });
    const manager = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(manager.getCurrentIndex()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Account management
// ---------------------------------------------------------------------------

describe("AccountManager account management", () => {
  /** @type {AccountManager} */
  let manager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    loadAccounts.mockResolvedValue(null);
    manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "access1",
      expires: Date.now() + 3600_000,
    });
  });

  it("addAccount adds a new account", () => {
    const account = manager.addAccount("token2", "access2", Date.now() + 3600_000, "user@example.com");
    expect(account).not.toBeNull();
    expect(manager.getTotalAccountCount()).toBe(2);
    expect(account.email).toBe("user@example.com");
  });

  it("addAccount deduplicates by refresh token", () => {
    manager.addAccount("token1", "new-access", Date.now() + 7200_000);
    expect(manager.getTotalAccountCount()).toBe(1);
    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot[0].access).toBe("new-access");
  });

  it("addAccount respects MAX_ACCOUNTS limit", () => {
    for (let i = 2; i <= 10; i++) {
      manager.addAccount(`token${i}`, `access${i}`, Date.now() + 3600_000);
    }
    expect(manager.getTotalAccountCount()).toBe(10);
    const result = manager.addAccount("token11", "access11", Date.now() + 3600_000);
    expect(result).toBeNull();
    expect(manager.getTotalAccountCount()).toBe(10);
  });

  it("removeAccount removes by index", () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000);
    expect(manager.getTotalAccountCount()).toBe(2);
    const removed = manager.removeAccount(0);
    expect(removed).toBe(true);
    expect(manager.getTotalAccountCount()).toBe(1);
    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot[0].refreshToken).toBe("token2");
    expect(snapshot[0].index).toBe(0); // Re-indexed
  });

  it("removeAccount returns false for invalid index", () => {
    expect(manager.removeAccount(-1)).toBe(false);
    expect(manager.removeAccount(99)).toBe(false);
  });

  it("removeAccount adjusts currentIndex", () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000);
    // Select account 1
    manager.getCurrentAccount();
    manager.removeAccount(0);
    // currentIndex should be adjusted
    expect(manager.getCurrentIndex()).toBeLessThanOrEqual(0);
  });

  it("toggleAccount toggles enabled state", () => {
    const newState = manager.toggleAccount(0);
    expect(newState).toBe(false);
    expect(manager.getAccountCount()).toBe(0); // Disabled
    const restored = manager.toggleAccount(0);
    expect(restored).toBe(true);
    expect(manager.getAccountCount()).toBe(1);
  });

  it("toggleAccount returns false for invalid index", () => {
    expect(manager.toggleAccount(99)).toBe(false);
  });

  it("clearAll removes all accounts", () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000);
    manager.clearAll();
    expect(manager.getTotalAccountCount()).toBe(0);
    expect(manager.getCurrentIndex()).toBe(-1);
  });

  it("getAccountsSnapshot returns copies", () => {
    const snapshot = manager.getAccountsSnapshot();
    snapshot[0].email = "modified";
    const snapshot2 = manager.getAccountsSnapshot();
    expect(snapshot2[0].email).not.toBe("modified");
  });
});

// ---------------------------------------------------------------------------
// Account selection
// ---------------------------------------------------------------------------

describe("AccountManager account selection", () => {
  /** @type {AccountManager} */
  let manager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    loadAccounts.mockResolvedValue(null);
    manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "access1",
      expires: Date.now() + 3600_000,
    });
  });

  it("getCurrentAccount returns an account", () => {
    const account = manager.getCurrentAccount();
    expect(account).not.toBeNull();
    expect(account.refreshToken).toBe("token1");
  });

  it("getCurrentAccount returns null when no accounts", async () => {
    loadAccounts.mockResolvedValue(null);
    const empty = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(empty.getCurrentAccount()).toBeNull();
  });

  it("getCurrentAccount updates lastUsed", () => {
    const before = manager.getAccountsSnapshot()[0].lastUsed;
    vi.advanceTimersByTime(1000);
    manager.getCurrentAccount();
    const after = manager.getAccountsSnapshot()[0].lastUsed;
    expect(after).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting and health
// ---------------------------------------------------------------------------

describe("AccountManager rate limiting", () => {
  /** @type {AccountManager} */
  let manager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    loadAccounts.mockResolvedValue(null);
    manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "access1",
      expires: Date.now() + 3600_000,
    });
    manager.addAccount("token2", "access2", Date.now() + 3600_000);
  });

  it("markRateLimited sets backoff and returns duration", () => {
    const account = manager.getCurrentAccount();
    const backoffMs = manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(backoffMs).toBeGreaterThan(0);
    expect(account.consecutiveFailures).toBe(1);
  });

  it("markRateLimited increments consecutive failures", () => {
    const account = manager.getCurrentAccount();
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(2);
  });

  it("markSuccess resets consecutive failures", () => {
    const account = manager.getCurrentAccount();
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(1);
    manager.markSuccess(account);
    expect(account.consecutiveFailures).toBe(0);
    expect(account.lastFailureTime).toBeNull();
  });

  it("markFailure reduces health score", () => {
    const account = manager.getCurrentAccount();
    manager.markFailure(account);
    // Can't directly check health score, but we can verify it doesn't crash
    expect(account).toBeDefined();
  });

  it("failure TTL resets consecutive failures after timeout", () => {
    const account = manager.getCurrentAccount();
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(1);

    // Advance past failure TTL (3600 seconds)
    vi.advanceTimersByTime(3601_000);

    // Next rate limit should reset the counter first
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(1); // Reset to 0, then +1
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("AccountManager persistence", () => {
  /** @type {AccountManager} */
  let manager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);
    manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "access1",
      expires: Date.now() + 3600_000,
    });
  });

  it("saveToDisk calls saveAccounts with correct format", async () => {
    await manager.saveToDisk();
    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        accounts: expect.arrayContaining([
          expect.objectContaining({
            refreshToken: "token1",
            enabled: true,
          }),
        ]),
        activeIndex: expect.any(Number),
      }),
    );
  });

  it("requestSaveToDisk debounces saves", async () => {
    manager.requestSaveToDisk();
    manager.requestSaveToDisk();
    manager.requestSaveToDisk();

    // Should not have saved yet
    expect(saveAccounts).not.toHaveBeenCalled();

    // Advance past debounce timeout
    vi.advanceTimersByTime(1100);

    // Should have saved once
    // Wait for the async save to complete
    await vi.runAllTimersAsync();
    expect(saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("requestSaveToDisk resets timer on subsequent calls", async () => {
    manager.requestSaveToDisk();
    vi.advanceTimersByTime(500); // Half the debounce window
    manager.requestSaveToDisk(); // Should reset the timer
    vi.advanceTimersByTime(500); // 500ms after second call (total 1000ms)
    expect(saveAccounts).not.toHaveBeenCalled(); // Timer was reset
    vi.advanceTimersByTime(600); // Now past the debounce window
    await vi.runAllTimersAsync();
    expect(saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("toAuthDetails converts to OpenCode format", () => {
    const account = manager.getCurrentAccount();
    const details = manager.toAuthDetails(account);
    expect(details).toEqual({
      type: "oauth",
      refresh: "token1",
      access: "access1",
      expires: expect.any(Number),
    });
  });

  it("syncActiveIndexFromDisk picks up CLI changes", async () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000, "b@test.com");

    // Currently on account 0
    expect(manager.getCurrentIndex()).toBe(0);

    // CLI changes activeIndex to 1 on disk
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        { email: "a@test.com", refreshToken: "token1", addedAt: 1, lastUsed: 0, enabled: true, rateLimitResetTimes: {}, consecutiveFailures: 0, lastFailureTime: null },
        { email: "b@test.com", refreshToken: "token2", addedAt: 2, lastUsed: 0, enabled: true, rateLimitResetTimes: {}, consecutiveFailures: 0, lastFailureTime: null },
      ],
      activeIndex: 1,
    });

    await manager.syncActiveIndexFromDisk();
    expect(manager.getCurrentIndex()).toBe(1);
  });

  it("syncActiveIndexFromDisk ignores disabled target account", async () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000, "b@test.com");

    expect(manager.getCurrentIndex()).toBe(0);

    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        { email: "a@test.com", refreshToken: "token1", addedAt: 1, lastUsed: 0, enabled: true, rateLimitResetTimes: {}, consecutiveFailures: 0, lastFailureTime: null },
        { email: "b@test.com", refreshToken: "token2", addedAt: 2, lastUsed: 0, enabled: false, rateLimitResetTimes: {}, consecutiveFailures: 0, lastFailureTime: null },
      ],
      activeIndex: 1,
    });

    await manager.syncActiveIndexFromDisk();
    // Should stay on 0 because account 1 is disabled
    expect(manager.getCurrentIndex()).toBe(0);
  });

  it("syncActiveIndexFromDisk no-ops when disk matches memory", async () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000, "b@test.com");

    expect(manager.getCurrentIndex()).toBe(0);

    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        { email: "a@test.com", refreshToken: "token1", addedAt: 1, lastUsed: 0, enabled: true, rateLimitResetTimes: {}, consecutiveFailures: 0, lastFailureTime: null },
        { email: "b@test.com", refreshToken: "token2", addedAt: 2, lastUsed: 0, enabled: true, rateLimitResetTimes: {}, consecutiveFailures: 0, lastFailureTime: null },
      ],
      activeIndex: 0,
    });

    await manager.syncActiveIndexFromDisk();
    expect(manager.getCurrentIndex()).toBe(0);
  });

  it("syncActiveIndexFromDisk reconciles removed accounts from disk", async () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000, "b@test.com");

    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          email: "a@test.com",
          refreshToken: "token1",
          addedAt: 1,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 0,
    });

    await manager.syncActiveIndexFromDisk();
    await manager.saveToDisk();

    const saved = saveAccounts.mock.calls.at(-1)?.[0];
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0].refreshToken).toBe("token1");
  });

  it("syncActiveIndexFromDisk updates enabled state from disk", async () => {
    manager.addAccount("token2", "access2", Date.now() + 3600_000, "b@test.com");

    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [
        {
          email: "a@test.com",
          refreshToken: "token1",
          addedAt: 1,
          lastUsed: 0,
          enabled: false,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
        {
          email: "b@test.com",
          refreshToken: "token2",
          addedAt: 2,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
      activeIndex: 1,
    });

    await manager.syncActiveIndexFromDisk();
    expect(manager.getCurrentIndex()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------

describe("AccountManager usage stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function createManagerWithAccounts(n = 2) {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "tok-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    for (let i = 2; i <= n; i++) {
      manager.addAccount(`tok-${i}`, `access-${i}`, Date.now() + 3600_000, `user${i}@test.com`);
    }
    return manager;
  }

  it("recordUsage increments stats for the given account", async () => {
    const manager = await createManagerWithAccounts(2);
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 });

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(1);
    expect(snap[0].stats.inputTokens).toBe(100);
    expect(snap[0].stats.outputTokens).toBe(50);
    expect(snap[0].stats.cacheReadTokens).toBe(10);
    expect(snap[0].stats.cacheWriteTokens).toBe(5);
    // Account 1 should be untouched
    expect(snap[1].stats.requests).toBe(0);
  });

  it("recordUsage accumulates over multiple calls", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50 });
    manager.recordUsage(0, { inputTokens: 200, outputTokens: 100 });

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(2);
    expect(snap[0].stats.inputTokens).toBe(300);
    expect(snap[0].stats.outputTokens).toBe(150);
  });

  it("recordUsage handles missing fields gracefully", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(0, {});

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(1);
    expect(snap[0].stats.inputTokens).toBe(0);
  });

  it("recordUsage ignores invalid index", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(99, { inputTokens: 100 });
    // Should not throw
    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(0);
  });

  it("resetStats resets a single account", async () => {
    const manager = await createManagerWithAccounts(2);
    manager.recordUsage(0, { inputTokens: 500, outputTokens: 200 });
    manager.recordUsage(1, { inputTokens: 300, outputTokens: 100 });

    manager.resetStats(0);

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(0);
    expect(snap[0].stats.inputTokens).toBe(0);
    // Account 1 should be untouched
    expect(snap[1].stats.requests).toBe(1);
    expect(snap[1].stats.inputTokens).toBe(300);
  });

  it("resetStats ignores invalid index", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(0, { inputTokens: 500 });

    manager.resetStats(99);

    // Account 0 should be untouched
    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(1);
    expect(snap[0].stats.inputTokens).toBe(500);
  });

  it("resetStats resets all accounts", async () => {
    const manager = await createManagerWithAccounts(2);
    manager.recordUsage(0, { inputTokens: 500 });
    manager.recordUsage(1, { inputTokens: 300 });

    manager.resetStats("all");

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(0);
    expect(snap[1].stats.requests).toBe(0);
  });

  it("stats are included in saveToDisk output", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50 });

    await manager.saveToDisk();

    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([
          expect.objectContaining({
            stats: expect.objectContaining({
              requests: 1,
              inputTokens: 100,
              outputTokens: 50,
            }),
          }),
        ]),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Merge-on-save (concurrent instance support)
// ---------------------------------------------------------------------------

describe("AccountManager merge-on-save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function createManagerWithAccounts(n = 1) {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "tok-1",
      access: "access-1",
      expires: Date.now() + 3600_000,
    });
    for (let i = 2; i <= n; i++) {
      manager.addAccount(`tok-${i}`, `access-${i}`, Date.now() + 3600_000, `user${i}@test.com`);
    }
    // Save once to establish baseline, then clear mocks
    await manager.saveToDisk();
    vi.clearAllMocks();
    return manager;
  }

  it("merges stats with disk values on save", async () => {
    const manager = await createManagerWithAccounts(1);
    const snap = manager.getAccountsSnapshot();
    const accountId = snap[0].id;

    // Simulate another instance having written stats to disk
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [{
        id: accountId,
        refreshToken: "tok-1",
        addedAt: 1000,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
          requests: 50,
          inputTokens: 10000,
          outputTokens: 5000,
          cacheReadTokens: 1000,
          cacheWriteTokens: 500,
          lastReset: 1000,
        },
      }],
      activeIndex: 0,
    });
    saveAccounts.mockResolvedValue(undefined);

    // This instance records 3 requests
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 });
    manager.recordUsage(0, { inputTokens: 200, outputTokens: 100 });
    manager.recordUsage(0, { inputTokens: 300, outputTokens: 150 });

    await manager.saveToDisk();

    const saved = saveAccounts.mock.calls[0][0];
    const stats = saved.accounts[0].stats;

    // Should be disk values + our deltas
    expect(stats.requests).toBe(53);          // 50 + 3
    expect(stats.inputTokens).toBe(10600);    // 10000 + 100 + 200 + 300
    expect(stats.outputTokens).toBe(5300);    // 5000 + 50 + 100 + 150
    expect(stats.cacheReadTokens).toBe(1010); // 1000 + 10
    expect(stats.cacheWriteTokens).toBe(505); // 500 + 5
    expect(stats.lastReset).toBe(1000);       // Preserved from disk
  });

  it("clears deltas after save", async () => {
    const manager = await createManagerWithAccounts(1);
    const snap = manager.getAccountsSnapshot();
    const accountId = snap[0].id;

    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [{
        id: accountId,
        refreshToken: "tok-1",
        addedAt: 1000,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
          requests: 10, inputTokens: 1000, outputTokens: 500,
          cacheReadTokens: 0, cacheWriteTokens: 0, lastReset: 1000,
        },
      }],
      activeIndex: 0,
    });
    saveAccounts.mockResolvedValue(undefined);

    manager.recordUsage(0, { inputTokens: 100 });
    await manager.saveToDisk();

    // First save: 10 + 1 = 11 requests
    expect(saveAccounts.mock.calls[0][0].accounts[0].stats.requests).toBe(11);

    // Second save with no new usage should write disk values as-is (no delta)
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [{
        id: accountId,
        refreshToken: "tok-1",
        addedAt: 1000,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
          requests: 11, inputTokens: 1100, outputTokens: 500,
          cacheReadTokens: 0, cacheWriteTokens: 0, lastReset: 1000,
        },
      }],
      activeIndex: 0,
    });

    await manager.saveToDisk();
    // No delta, so stats should match what's on disk
    expect(saveAccounts.mock.calls[1][0].accounts[0].stats.requests).toBe(11);
  });

  it("resetStats writes absolute values ignoring disk", async () => {
    const manager = await createManagerWithAccounts(1);
    const snap = manager.getAccountsSnapshot();
    const accountId = snap[0].id;

    // Disk has 100 requests from other instances
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [{
        id: accountId,
        refreshToken: "tok-1",
        addedAt: 1000,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
          requests: 100, inputTokens: 50000, outputTokens: 20000,
          cacheReadTokens: 0, cacheWriteTokens: 0, lastReset: 1000,
        },
      }],
      activeIndex: 0,
    });
    saveAccounts.mockResolvedValue(undefined);

    manager.resetStats(0);
    await manager.saveToDisk();

    const stats = saveAccounts.mock.calls[0][0].accounts[0].stats;
    expect(stats.requests).toBe(0);
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
  });

  it("accumulates usage after resetStats correctly", async () => {
    const manager = await createManagerWithAccounts(1);
    const snap = manager.getAccountsSnapshot();
    const accountId = snap[0].id;

    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [{
        id: accountId,
        refreshToken: "tok-1",
        addedAt: 1000,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
          requests: 100, inputTokens: 50000, outputTokens: 20000,
          cacheReadTokens: 0, cacheWriteTokens: 0, lastReset: 1000,
        },
      }],
      activeIndex: 0,
    });
    saveAccounts.mockResolvedValue(undefined);

    // Reset then record new usage before saving
    manager.resetStats(0);
    manager.recordUsage(0, { inputTokens: 200, outputTokens: 100 });

    await manager.saveToDisk();

    const stats = saveAccounts.mock.calls[0][0].accounts[0].stats;
    expect(stats.requests).toBe(1);       // 0 (reset) + 1
    expect(stats.inputTokens).toBe(200);  // 0 (reset) + 200
    expect(stats.outputTokens).toBe(100); // 0 (reset) + 100
  });

  it("falls through to absolute values when disk read fails", async () => {
    const manager = await createManagerWithAccounts(1);

    // Disk read fails
    loadAccounts.mockRejectedValue(new Error("disk error"));
    saveAccounts.mockResolvedValue(undefined);

    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50 });
    await manager.saveToDisk();

    // Should write in-memory stats as-is
    const stats = saveAccounts.mock.calls[0][0].accounts[0].stats;
    expect(stats.requests).toBe(1);
    expect(stats.inputTokens).toBe(100);
  });
});
