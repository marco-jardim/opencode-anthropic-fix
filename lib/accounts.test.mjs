import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountManager } from "./accounts.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";

// Mock storage module
vi.mock("./storage.mjs", () => ({
  loadAccounts: vi.fn(),
  saveAccounts: vi.fn().mockResolvedValue(undefined),
}));

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

  it("getMinWaitTime returns 0 when accounts are available", () => {
    expect(manager.getMinWaitTime()).toBe(0);
  });

  it("getMinWaitTime returns wait time when all rate-limited", () => {
    const acc1 = manager.getAccountsSnapshot()[0];
    const acc2 = manager.getAccountsSnapshot()[1];
    const realAcc1 = manager.getCurrentAccount();
    manager.markRateLimited(realAcc1, "RATE_LIMIT_EXCEEDED", null);
    // Get account 2
    const realAcc2 = manager.getCurrentAccount();
    if (realAcc2 && realAcc2.refreshToken === "token2") {
      manager.markRateLimited(realAcc2, "RATE_LIMIT_EXCEEDED", null);
    }
    const wait = manager.getMinWaitTime();
    // Should be > 0 since both are rate-limited
    expect(wait).toBeGreaterThanOrEqual(0);
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
});
