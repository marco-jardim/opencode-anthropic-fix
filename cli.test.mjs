/**
 * Tests for the CLI account management tool.
 *
 * We mock storage and config to control what the CLI sees,
 * and capture console output to verify formatting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./lib/storage.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadAccounts: vi.fn().mockResolvedValue(null),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    clearAccounts: vi.fn().mockResolvedValue(undefined),
    getStoragePath: vi.fn(() => "/home/user/.config/opencode/anthropic-accounts.json"),
  };
});

vi.mock("./lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadConfig: vi.fn(() => ({ ...original.DEFAULT_CONFIG })),
    getConfigPath: vi.fn(() => "/home/user/.config/opencode/anthropic-auth.json"),
    getConfigDir: vi.fn(() => "/home/user/.config/opencode"),
  };
});

vi.mock("./lib/oauth.mjs", () => ({
  authorize: vi.fn(async () => ({ url: "https://auth.example/authorize", verifier: "pkce-verifier" })),
  exchange: vi.fn(async () => ({
    type: "success",
    refresh: "refresh-new",
    access: "access-new",
    expires: Date.now() + 3600_000,
    email: "new@example.com",
  })),
  revoke: vi.fn(async () => true),
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Mock readline for interactive commands
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("n"),
    close: vi.fn(),
  })),
}));

import {
  formatDuration,
  formatTimeAgo,
  renderBar,
  formatResetTime,
  renderUsageLines,
  refreshAccessToken,
  fetchUsage,
  ensureTokenAndFetchUsage,
  cmdList,
  cmdStatus,
  cmdSwitch,
  cmdEnable,
  cmdDisable,
  cmdLogin,
  cmdLogout,
  cmdRemove,
  cmdReauth,
  cmdRefresh,
  cmdReset,
  cmdStats,
  cmdResetStats,
  cmdConfig,
  cmdHelp,
  main,
} from "./cli.mjs";
import { loadAccounts, saveAccounts } from "./lib/storage.mjs";
import { authorize, exchange, revoke } from "./lib/oauth.mjs";
import { createInterface } from "node:readline/promises";
import { exec } from "node:child_process";

// ---------------------------------------------------------------------------
// Global fetch mock — prevents real HTTP calls and speeds up tests
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  // Default: all fetches fail gracefully (usage endpoints return null)
  mockFetch.mockResolvedValue({ ok: false, status: 500 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture console.log and console.error output */
function captureOutput() {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;

  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  return {
    logs,
    errors,
    /** Get all log output as a single string (ANSI stripped) */
    text: () => logs.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), // eslint-disable-line no-control-regex
    /** Get all error output as a single string (ANSI stripped) */
    errorText: () => errors.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), // eslint-disable-line no-control-regex
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

/** Temporarily set process.stdin.isTTY for interactive command tests. */
function setStdinTTY(value) {
  const previous = process.stdin.isTTY;
  process.stdin.isTTY = value;
  return () => {
    if (typeof previous === "undefined") {
      delete process.stdin.isTTY;
    } else {
      process.stdin.isTTY = previous;
    }
  };
}

/** Configure mocked readline to return a specific answer. */
function mockReadlineAnswer(answer) {
  const rl = {
    question: vi.fn().mockResolvedValue(answer),
    close: vi.fn(),
  };
  vi.mocked(createInterface).mockReturnValue(rl);
  return rl;
}

/** Make a standard test account storage object */
function makeStorage(overrides = {}) {
  return {
    version: 1,
    accounts: [
      {
        email: "alice@example.com",
        refreshToken: "refresh-alice",
        addedAt: 1000,
        lastUsed: 5000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
      {
        refreshToken: "refresh-bob",
        addedAt: 2000,
        lastUsed: 3000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
      {
        email: "charlie@example.com",
        refreshToken: "refresh-charlie",
        addedAt: 3000,
        lastUsed: 1000,
        enabled: false,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
    ],
    activeIndex: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("returns 'now' for zero or negative", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-100)).toBe("now");
  });

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  it("formats long durations as days", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(112 * 3_600_000)).toBe("4d 16h");
  });
});

describe("formatTimeAgo", () => {
  it("returns 'never' for zero or falsy", () => {
    expect(formatTimeAgo(0)).toBe("never");
    expect(formatTimeAgo(null)).toBe("never");
    expect(formatTimeAgo(undefined)).toBe("never");
  });

  it("returns relative time for past timestamps", () => {
    const fiveMinAgo = Date.now() - 300_000;
    expect(formatTimeAgo(fiveMinAgo)).toBe("5m ago");
  });

  it("returns 'just now' for future timestamps", () => {
    expect(formatTimeAgo(Date.now() + 10_000)).toBe("just now");
  });
});

/** Strip ANSI escape codes for test assertions. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex
}

// ---------------------------------------------------------------------------
// Usage formatting helpers
// ---------------------------------------------------------------------------

describe("renderBar", () => {
  it("renders empty bar at 0%", () => {
    const bar = stripAnsi(renderBar(0, 10));
    expect(bar).toBe("░".repeat(10));
  });

  it("renders full bar at 100%", () => {
    const bar = stripAnsi(renderBar(100, 10));
    expect(bar).toBe("█".repeat(10));
  });

  it("renders proportional fill at 50%", () => {
    const bar = stripAnsi(renderBar(50, 10));
    expect(bar).toBe("█████░░░░░");
  });

  it("clamps above 100%", () => {
    const bar = stripAnsi(renderBar(150, 10));
    expect(bar).toBe("█".repeat(10));
  });

  it("clamps below 0%", () => {
    const bar = stripAnsi(renderBar(-10, 10));
    expect(bar).toBe("░".repeat(10));
  });
});

describe("formatResetTime", () => {
  it("returns relative duration for future timestamps", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(formatResetTime(future)).toMatch(/59m|1h/);
  });

  it("returns 'now' for past timestamps", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(formatResetTime(past)).toBe("now");
  });
});

describe("renderUsageLines", () => {
  it("renders lines for non-null buckets only", () => {
    const usage = {
      five_hour: { utilization: 10.0, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      seven_day: { utilization: 67.0, resets_at: new Date(Date.now() + 86400_000).toISOString() },
      seven_day_sonnet: null,
      seven_day_opus: null,
    };
    const lines = renderUsageLines(usage);
    expect(lines).toHaveLength(2);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("5h");
    expect(text).toContain("10%");
    expect(text).toContain("7d");
    expect(text).toContain("67%");
  });

  it("returns empty array when all buckets are null", () => {
    const usage = { five_hour: null, seven_day: null };
    expect(renderUsageLines(usage)).toHaveLength(0);
  });

  it("includes model-specific buckets when present", () => {
    const usage = {
      five_hour: { utilization: 5.0, resets_at: new Date(Date.now() + 1000).toISOString() },
      seven_day: { utilization: 30.0, resets_at: new Date(Date.now() + 1000).toISOString() },
      seven_day_sonnet: { utilization: 11.0, resets_at: new Date(Date.now() + 1000).toISOString() },
      seven_day_opus: { utilization: 22.0, resets_at: new Date(Date.now() + 1000).toISOString() },
    };
    const lines = renderUsageLines(usage);
    expect(lines).toHaveLength(4);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Sonnet 7d");
    expect(text).toContain("11%");
    expect(text).toContain("Opus 7d");
    expect(text).toContain("22%");
  });
});

// ---------------------------------------------------------------------------
// Usage fetch helpers
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  it("refreshes token and updates account object", async () => {
    const account = { refreshToken: "old-refresh", access: undefined, expires: undefined };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
    });

    const token = await refreshAccessToken(account);
    expect(token).toBe("new-access");
    expect(account.access).toBe("new-access");
    expect(account.refreshToken).toBe("new-refresh");
    expect(account.expires).toBeGreaterThan(Date.now());
  });

  it("returns null on failure", async () => {
    const account = { refreshToken: "bad-refresh" };
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const token = await refreshAccessToken(account);
    expect(token).toBeNull();
  });

  it("returns null on network error", async () => {
    const account = { refreshToken: "refresh" };
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const token = await refreshAccessToken(account);
    expect(token).toBeNull();
  });
});

describe("fetchUsage", () => {
  it("returns usage data on success", async () => {
    const usageData = {
      five_hour: { utilization: 10.0, resets_at: "2026-02-07T06:00:00Z" },
      seven_day: { utilization: 67.0, resets_at: "2026-02-08T01:00:00Z" },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => usageData,
    });

    const result = await fetchUsage("valid-token");
    expect(result).toEqual(usageData);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(opts.headers.authorization).toBe("Bearer valid-token");
    expect(opts.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("returns null on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await fetchUsage("bad-token")).toBeNull();
  });
});

describe("ensureTokenAndFetchUsage", () => {
  it("skips disabled accounts", async () => {
    const result = await ensureTokenAndFetchUsage({ enabled: false, refreshToken: "x" });
    expect(result).toEqual({ usage: null, tokenRefreshed: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses existing valid token without refreshing", async () => {
    const account = {
      enabled: true,
      refreshToken: "refresh",
      access: "valid-access",
      expires: Date.now() + 3600_000,
    };
    const usageData = { five_hour: { utilization: 5.0, resets_at: "2026-01-01T00:00:00Z" } };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => usageData });

    const result = await ensureTokenAndFetchUsage(account);
    expect(result.usage).toEqual(usageData);
    expect(result.tokenRefreshed).toBe(false);
    // Only 1 fetch call (usage), no token refresh
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired token before fetching usage", async () => {
    const account = {
      enabled: true,
      refreshToken: "refresh",
      access: "expired-access",
      expires: Date.now() - 1000, // expired
    };
    // First call: token refresh
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
    });
    // Second call: usage fetch
    const usageData = { five_hour: { utilization: 20.0, resets_at: "2026-01-01T00:00:00Z" } };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => usageData });

    const result = await ensureTokenAndFetchUsage(account);
    expect(result.usage).toEqual(usageData);
    expect(result.tokenRefreshed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns null usage when token refresh fails", async () => {
    const account = {
      enabled: true,
      refreshToken: "bad-refresh",
      access: undefined,
      expires: undefined,
    };
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await ensureTokenAndFetchUsage(account);
    expect(result.usage).toBeNull();
    expect(result.tokenRefreshed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cmdList
// ---------------------------------------------------------------------------

/** Helper to mock usage fetch for cmdList tests. */
function mockUsageForAccounts(...usages) {
  const queue = [...usages];
  const usageByToken = new Map();
  let tokenCounter = 0;

  mockFetch.mockImplementation((url, opts = {}) => {
    const target = String(url);

    if (target.includes("/v1/oauth/token")) {
      if (queue.length === 0) return Promise.resolve({ ok: false, status: 500 });

      const usage = queue.shift();
      if (usage === null) {
        return Promise.resolve({ ok: false, status: 401 });
      }

      tokenCounter += 1;
      const token = `access-${tokenCounter}`;
      usageByToken.set(token, usage);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: token,
          refresh_token: `refresh-${tokenCounter}`,
          expires_in: 3600,
        }),
      });
    }

    if (target.includes("/api/oauth/usage")) {
      const auth = opts.headers?.authorization || opts.headers?.Authorization;
      const token = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";

      if (!usageByToken.has(token)) {
        return Promise.resolve({ ok: false, status: 401 });
      }

      const usage = usageByToken.get(token);
      return Promise.resolve({ ok: true, json: async () => usage });
    }

    return Promise.resolve({ ok: false, status: 500 });
  });
}

describe("cmdList", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    saveAccounts.mockResolvedValue(undefined);
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it("shows 'no accounts' message when storage is empty", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdList();
    expect(code).toBe(1);
    expect(output.text()).toContain("No accounts configured");
  });

  it("displays account table with correct columns", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdList();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("Anthropic Multi-Account Status");
    expect(text).toContain("alice@example.com");
    expect(text).toContain("Account 2");
    expect(text).toContain("charlie@example.com");
    expect(text).toContain("active");
    expect(text).toContain("ready");
    expect(text).toContain("disabled");
  });

  it("shows enabled/disabled counts", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdList();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("2 of 3 enabled");
    expect(text).toContain("1 disabled");
  });

  it("shows rate limit countdown for rate-limited accounts", async () => {
    const storage = makeStorage();
    storage.accounts[1].rateLimitResetTimes = {
      anthropic: Date.now() + 150_000, // 2m 30s from now
    };
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdList();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toMatch(/2m\s+30s/);
  });

  it("shows consecutive failure count", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 5;
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdList();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("5");
  });

  it("shows strategy name", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdList();
    expect(code).toBe(0);
    expect(output.text()).toContain("sticky");
  });

  it("shows live usage quotas for enabled accounts", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const usage = {
      five_hour: { utilization: 9.0, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      seven_day: { utilization: 67.0, resets_at: new Date(Date.now() + 86400_000).toISOString() },
      seven_day_sonnet: { utilization: 11.0, resets_at: new Date(Date.now() + 172800_000).toISOString() },
      seven_day_opus: null,
    };
    // Only 2 enabled accounts need mocking (account 3 is disabled, skips fetch)
    mockUsageForAccounts(usage, usage);

    const code = await cmdList();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("5h");
    expect(text).toContain("9%");
    expect(text).toContain("7d");
    expect(text).toContain("67%");
    expect(text).toContain("Sonnet 7d");
    expect(text).toContain("11%");
    // Opus 7d should NOT appear (null)
    expect(text).not.toContain("Opus 7d");
  });

  it("shows 'quotas: unavailable' when usage fetch fails", async () => {
    const storage = makeStorage();
    storage.accounts[2].enabled = true; // enable all 3
    loadAccounts.mockResolvedValue(storage);
    // All three accounts: token refresh fails
    mockUsageForAccounts(null, null, null);

    const code = await cmdList();
    expect(code).toBe(0);
    expect(output.text()).toContain("quotas: unavailable");
  });

  it("does not show quota lines for disabled accounts", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    // Account 1 and 2 (enabled) get usage; account 3 is disabled and skips fetch entirely
    mockUsageForAccounts(
      { five_hour: { utilization: 5.0, resets_at: new Date(Date.now() + 1000).toISOString() } },
      { five_hour: { utilization: 15.0, resets_at: new Date(Date.now() + 1000).toISOString() } },
    );

    const code = await cmdList();
    expect(code).toBe(0);
    const text = output.text();
    // Should see quota lines for enabled accounts
    expect(text).toContain("5%");
    expect(text).toContain("15%");
    // Disabled account (charlie) should not have quota lines — just the status row
    const lines = text.split("\n");
    const charlieIdx = lines.findIndex((l) => l.includes("charlie@example.com"));
    expect(charlieIdx).toBeGreaterThan(-1);
    // Next line after charlie should NOT be a quota line
    const nextLine = lines[charlieIdx + 1] || "";
    expect(nextLine).not.toContain("5h");
    expect(nextLine).not.toContain("quotas:");
  });

  it("persists refreshed tokens back to disk", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    saveAccounts.mockResolvedValue(undefined);
    // Only 2 enabled accounts need mocking (account 3 is disabled)
    mockUsageForAccounts(
      { five_hour: { utilization: 1.0, resets_at: new Date(Date.now() + 1000).toISOString() } },
      { five_hour: { utilization: 2.0, resets_at: new Date(Date.now() + 1000).toISOString() } },
    );

    await cmdList();
    // saveAccounts should be called to persist the refreshed tokens
    expect(saveAccounts).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cmdStatus
// ---------------------------------------------------------------------------

describe("cmdStatus", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it("shows 'no accounts' for empty storage", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdStatus();
    expect(code).toBe(1);
    expect(output.text()).toContain("no accounts configured");
  });

  it("shows compact one-liner with account count", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdStatus();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("anthropic:");
    expect(text).toContain("3 accounts");
    expect(text).toContain("2 active");
    expect(text).toContain("strategy: sticky");
    expect(text).toContain("next: #1");
  });

  it("includes rate-limited count when accounts are rate-limited", async () => {
    const storage = makeStorage();
    storage.accounts[0].rateLimitResetTimes = {
      anthropic: Date.now() + 60_000,
    };
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdStatus();
    expect(code).toBe(0);
    expect(output.text()).toContain("1 rate-limited");
  });
});

// ---------------------------------------------------------------------------
// cmdSwitch
// ---------------------------------------------------------------------------

describe("cmdSwitch", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("switches active account", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdSwitch("2");
    expect(code).toBe(0);
    expect(output.text()).toContain("Switched");
    expect(output.text()).toContain("#2");

    // Verify saveAccounts was called with updated activeIndex
    expect(saveAccounts).toHaveBeenCalledWith(expect.objectContaining({ activeIndex: 1 }));
  });

  it("rejects invalid account number", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdSwitch("99");
    expect(code).toBe(1);
    expect(output.errorText()).toContain("does not exist");
  });

  it("rejects switching to disabled account", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdSwitch("3"); // charlie is disabled
    expect(code).toBe(1);
    expect(output.errorText()).toContain("disabled");
  });

  it("rejects non-numeric input", async () => {
    const code = await cmdSwitch("abc");
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });

  it("rejects when no accounts exist", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdSwitch("1");
    expect(code).toBe(1);
    expect(output.errorText()).toContain("no accounts");
  });
});

// ---------------------------------------------------------------------------
// cmdEnable
// ---------------------------------------------------------------------------

describe("cmdEnable", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("enables a disabled account", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdEnable("3"); // charlie is disabled
    expect(code).toBe(0);
    expect(output.text()).toContain("Enabled");
    expect(output.text()).toContain("charlie@example.com");

    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([
          expect.objectContaining({
            email: "charlie@example.com",
            enabled: true,
          }),
        ]),
      }),
    );
  });

  it("is a no-op for already enabled account", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdEnable("1");
    expect(code).toBe(0);
    expect(output.text()).toContain("already enabled");
    expect(saveAccounts).not.toHaveBeenCalled();
  });

  it("rejects invalid account number", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdEnable("99");
    expect(code).toBe(1);
    expect(output.errorText()).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// cmdDisable
// ---------------------------------------------------------------------------

describe("cmdDisable", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("disables an enabled account", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdDisable("2");
    expect(code).toBe(0);
    expect(output.text()).toContain("Disabled");
    expect(output.text()).toContain("Account 2");
  });

  it("is a no-op for already disabled account", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdDisable("3");
    expect(code).toBe(0);
    expect(output.text()).toContain("already disabled");
  });

  it("prevents disabling the last enabled account", async () => {
    const storage = makeStorage();
    // Only one enabled account
    storage.accounts = [storage.accounts[0]];
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdDisable("1");
    expect(code).toBe(1);
    expect(output.errorText()).toContain("last enabled");
  });

  it("switches active account when disabling the active one (single atomic save)", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdDisable("1"); // alice is active
    expect(code).toBe(0);

    // Should save exactly once (disable + activeIndex adjustment in one write)
    expect(saveAccounts).toHaveBeenCalledTimes(1);
    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].enabled).toBe(false);
    expect(saved.activeIndex).toBe(1); // switched to bob (next enabled)
  });
});

// ---------------------------------------------------------------------------
// Auth commands
// ---------------------------------------------------------------------------

describe("auth commands", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
    loadAccounts.mockResolvedValue(makeStorage());
    vi.mocked(authorize).mockResolvedValue({ url: "https://auth.example/authorize", verifier: "pkce-verifier" });
    vi.mocked(exchange).mockResolvedValue({
      type: "success",
      refresh: "refresh-new",
      access: "access-new",
      expires: Date.now() + 3600_000,
      email: "new@example.com",
    });
    vi.mocked(revoke).mockResolvedValue(true);
  });

  afterEach(() => {
    output.restore();
  });

  it("cmdLogin rejects non-interactive terminals", async () => {
    const restoreTTY = setStdinTTY(false);
    try {
      const code = await cmdLogin();
      expect(code).toBe(1);
      expect(output.errorText()).toContain("requires an interactive terminal");
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogin adds a new account via OAuth", async () => {
    loadAccounts.mockResolvedValue(null);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");

    try {
      const code = await cmdLogin();
      expect(code).toBe(0);
      expect(authorize).toHaveBeenCalledWith("max");
      expect(exchange).toHaveBeenCalledWith("auth-code#state", "pkce-verifier");
      expect(exec).toHaveBeenCalled();
      expect(saveAccounts).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
          activeIndex: 0,
          accounts: expect.arrayContaining([
            expect.objectContaining({
              refreshToken: "refresh-new",
              access: "access-new",
              enabled: true,
              email: "new@example.com",
            }),
          ]),
        }),
      );
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogin updates duplicate account even when at max capacity", async () => {
    const fullStorage = {
      version: 1,
      activeIndex: 0,
      accounts: Array.from({ length: 10 }, (_, i) => ({
        refreshToken: i === 4 ? "refresh-new" : `refresh-${i}`,
        access: `access-${i}`,
        expires: Date.now() + 1000,
        addedAt: 1000 + i,
        lastUsed: 0,
        enabled: i === 4 ? false : true,
        rateLimitResetTimes: {},
        consecutiveFailures: 2,
        lastFailureTime: Date.now(),
      })),
    };
    loadAccounts.mockResolvedValue(fullStorage);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");

    try {
      const code = await cmdLogin();
      expect(code).toBe(0);
      const saved = saveAccounts.mock.calls[0][0];
      expect(saved.accounts).toHaveLength(10);
      expect(saved.accounts[4].refreshToken).toBe("refresh-new");
      expect(saved.accounts[4].access).toBe("access-new");
      expect(saved.accounts[4].enabled).toBe(true);
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogin rejects adding new account when at max capacity", async () => {
    const fullStorage = {
      version: 1,
      activeIndex: 0,
      accounts: Array.from({ length: 10 }, (_, i) => ({
        refreshToken: `refresh-${i}`,
        access: `access-${i}`,
        expires: Date.now() + 1000,
        addedAt: 1000 + i,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      })),
    };
    loadAccounts.mockResolvedValue(fullStorage);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");

    try {
      const code = await cmdLogin();
      expect(code).toBe(1);
      expect(output.errorText()).toContain("maximum of 10 accounts reached");
      expect(saveAccounts).not.toHaveBeenCalled();
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogout removes one account and revokes token", async () => {
    loadAccounts.mockResolvedValue(makeStorage());

    const code = await cmdLogout("2", { force: true });
    expect(code).toBe(0);
    expect(revoke).toHaveBeenCalledWith("refresh-bob");
    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts).toHaveLength(2);
    expect(saved.accounts.find((a) => a.refreshToken === "refresh-bob")).toBeUndefined();
  });

  it("cmdLogout --all revokes all accounts and writes explicit empty storage", async () => {
    loadAccounts.mockResolvedValue(makeStorage());

    const code = await cmdLogout(undefined, { all: true, force: true });
    expect(code).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(saveAccounts).toHaveBeenCalledWith({ version: 1, accounts: [], activeIndex: 0 });
  });

  it("cmdReauth refreshes credentials and resets account failure state", async () => {
    const storage = makeStorage();
    storage.accounts[0].enabled = false;
    storage.accounts[0].consecutiveFailures = 5;
    storage.accounts[0].lastFailureTime = Date.now();
    storage.accounts[0].rateLimitResetTimes = { anthropic: Date.now() + 60_000 };
    loadAccounts.mockResolvedValue(storage);
    vi.mocked(exchange).mockResolvedValueOnce({
      type: "success",
      refresh: "refresh-reauth",
      access: "access-reauth",
      expires: Date.now() + 7200_000,
      email: "alice+reauth@example.com",
    });

    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("reauth-code#state");

    try {
      const code = await cmdReauth("1");
      expect(code).toBe(0);
      const saved = saveAccounts.mock.calls[0][0];
      expect(saved.accounts[0]).toEqual(
        expect.objectContaining({
          refreshToken: "refresh-reauth",
          access: "access-reauth",
          email: "alice+reauth@example.com",
          enabled: true,
          consecutiveFailures: 0,
          lastFailureTime: null,
          rateLimitResetTimes: {},
        }),
      );
      expect(output.text()).toContain("re-enabled");
    } finally {
      restoreTTY();
    }
  });

  it("cmdRefresh updates tokens and re-enables account", async () => {
    const storage = makeStorage();
    storage.accounts[2].enabled = false;
    storage.accounts[2].consecutiveFailures = 4;
    storage.accounts[2].lastFailureTime = Date.now();
    storage.accounts[2].rateLimitResetTimes = { anthropic: Date.now() + 30_000 };
    loadAccounts.mockResolvedValue(storage);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
    });

    const code = await cmdRefresh("3");
    expect(code).toBe(0);
    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts[2]).toEqual(
      expect.objectContaining({
        access: "fresh-access",
        refreshToken: "fresh-refresh",
        enabled: true,
        consecutiveFailures: 0,
        lastFailureTime: null,
        rateLimitResetTimes: {},
      }),
    );
    expect(output.text()).toContain("Token refreshed");
    expect(output.text()).toContain("re-enabled");
  });

  it("cmdRefresh suggests reauth when refresh fails", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const code = await cmdRefresh("1");
    expect(code).toBe(1);
    expect(output.errorText()).toContain("Try: opencode-anthropic-auth reauth 1");
    expect(saveAccounts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cmdRemove
// ---------------------------------------------------------------------------

describe("cmdRemove", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("removes account with --force (no confirmation)", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdRemove("2", { force: true });
    expect(code).toBe(0);
    expect(output.text()).toContain("Removed");
    expect(output.text()).toContain("Account 2");

    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([
          expect.objectContaining({ email: "alice@example.com" }),
          expect.objectContaining({ email: "charlie@example.com" }),
        ]),
      }),
    );
    // Should have 2 accounts remaining (alice + charlie)
    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts).toHaveLength(2);
  });

  it("adjusts activeIndex when removing account before active", async () => {
    const storage = makeStorage({ activeIndex: 2 }); // charlie is active
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdRemove("1", { force: true }); // remove alice (before active)
    expect(code).toBe(0);

    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.activeIndex).toBe(1); // shifted down by 1
  });

  it("resets activeIndex when removing last account", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.activeIndex = 0;
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdRemove("1", { force: true });
    expect(code).toBe(0);

    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts).toHaveLength(0);
    expect(saved.activeIndex).toBe(0);
    expect(output.text()).toContain("No accounts remaining");
  });

  it("rejects invalid account number", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdRemove("99", { force: true });
    expect(code).toBe(1);
    expect(output.errorText()).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// cmdReset
// ---------------------------------------------------------------------------

describe("cmdReset", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("resets tracking for a single account", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 5;
    storage.accounts[0].lastFailureTime = Date.now();
    storage.accounts[0].rateLimitResetTimes = { anthropic: Date.now() + 60_000 };
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("1");
    expect(code).toBe(0);
    expect(output.text()).toContain("Reset tracking");
    expect(output.text()).toContain("alice@example.com");

    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].consecutiveFailures).toBe(0);
    expect(saved.accounts[0].lastFailureTime).toBeNull();
    expect(saved.accounts[0].rateLimitResetTimes).toEqual({});
  });

  it("resets tracking for all accounts", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 3;
    storage.accounts[1].consecutiveFailures = 7;
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("all");
    expect(code).toBe(0);
    expect(output.text()).toContain("all 3 account(s)");

    const saved = saveAccounts.mock.calls[0][0];
    for (const acc of saved.accounts) {
      expect(acc.consecutiveFailures).toBe(0);
      expect(acc.lastFailureTime).toBeNull();
      expect(acc.rateLimitResetTimes).toEqual({});
    }
  });

  it("rejects missing argument", async () => {
    const code = await cmdReset(undefined);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("provide an account number");
  });

  it("rejects invalid account number", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdReset("99");
    expect(code).toBe(1);
    expect(output.errorText()).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// cmdConfig
// ---------------------------------------------------------------------------

describe("cmdConfig", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it("displays configuration values", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdConfig();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("Anthropic Auth Configuration");
    expect(text).toContain("sticky");
    expect(text).toContain("3600s");
    expect(text).toContain("off"); // debug
  });

  it("shows health score config", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("Health Score");
    expect(text).toContain("70"); // initial
    expect(text).toContain("+1"); // success_reward
    expect(text).toContain("-10"); // rate_limit_penalty
  });

  it("shows token bucket config", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("Token Bucket");
    expect(text).toContain("50"); // max_tokens
  });

  it("shows file paths", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("anthropic-auth.json");
    expect(text).toContain("anthropic-accounts.json");
  });

  it("shows account count when accounts exist", async () => {
    loadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdConfig();
    expect(code).toBe(0);
    expect(output.text()).toContain("3 (2 enabled)");
  });

  it("shows 'none' when no accounts exist", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);
    expect(output.text()).toContain("none");
  });
});

// ---------------------------------------------------------------------------
// cmdHelp
// ---------------------------------------------------------------------------

describe("cmdHelp", () => {
  let output;

  beforeEach(() => {
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it("shows all commands", () => {
    cmdHelp();
    const text = output.text();
    expect(text).toContain("login");
    expect(text).toContain("logout");
    expect(text).toContain("reauth");
    expect(text).toContain("refresh");
    expect(text).toContain("list");
    expect(text).toContain("status");
    expect(text).toContain("switch");
    expect(text).toContain("enable");
    expect(text).toContain("disable");
    expect(text).toContain("remove");
    expect(text).toContain("reset");
    expect(text).toContain("config");
    expect(text).toContain("manage");
    expect(text).toContain("help");
  });

  it("shows examples", () => {
    cmdHelp();
    const text = output.text();
    expect(text).toContain("logout --all");
    expect(text).toContain("reauth 1");
    expect(text).toContain("switch 2");
    expect(text).toContain("disable 3");
    expect(text).toContain("reset all");
  });
});

// ---------------------------------------------------------------------------
// main() routing
// ---------------------------------------------------------------------------

describe("main routing", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    loadAccounts.mockResolvedValue(makeStorage());
    saveAccounts.mockResolvedValue(undefined);
    vi.mocked(authorize).mockResolvedValue({ url: "https://auth.example/authorize", verifier: "pkce-verifier" });
    vi.mocked(exchange).mockResolvedValue({
      type: "success",
      refresh: "refresh-new",
      access: "access-new",
      expires: Date.now() + 3600_000,
      email: "new@example.com",
    });
    vi.mocked(revoke).mockResolvedValue(true);
  });

  afterEach(() => {
    output.restore();
  });

  it("defaults to list when no command given", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Status");
  });

  it("routes 'ls' alias to list", async () => {
    const code = await main(["ls"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Status");
  });

  it("routes 'st' alias to status", async () => {
    const code = await main(["st"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("anthropic:");
  });

  it("routes 'sw' alias to switch", async () => {
    const code = await main(["sw", "2"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Switched");
  });

  it("routes 'en' alias to enable", async () => {
    const code = await main(["en", "3"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Enabled");
  });

  it("routes 'rm' alias to remove with --force", async () => {
    const code = await main(["rm", "2", "--force"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Removed");
  });

  it("routes 'cfg' alias to config", async () => {
    const code = await main(["cfg"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Auth Configuration");
  });

  it("returns error for unknown command", async () => {
    const code = await main(["foobar"]);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("Unknown command");
  });

  it("routes -h to help", async () => {
    const code = await main(["-h"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Auth CLI");
  });

  it("routes --help to help", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Auth CLI");
  });

  it("strips --flags from args before routing", async () => {
    const code = await main(["switch", "1", "--force", "--no-color"]);
    expect(code).toBe(0);
    // Should have routed to switch with arg "1", not "--force"
    expect(output.text()).toContain("Switched");
  });

  it("routes 'dis' alias to disable", async () => {
    const code = await main(["dis", "2"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Disabled");
  });

  it("routes 'ln' alias to login", async () => {
    loadAccounts.mockResolvedValue(null);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");
    try {
      const code = await main(["ln"]);
      expect(code).toBe(0);
      expect(authorize).toHaveBeenCalledWith("max");
      expect(exchange).toHaveBeenCalled();
    } finally {
      restoreTTY();
    }
  });

  it("routes 'lo --all --force' alias to logout all", async () => {
    const code = await main(["lo", "--all", "--force"]);
    expect(code).toBe(0);
    expect(revoke).toHaveBeenCalled();
    expect(saveAccounts).toHaveBeenCalledWith({ version: 1, accounts: [], activeIndex: 0 });
  });

  it("routes 'ra' alias to reauth", async () => {
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("reauth-code#state");
    try {
      const code = await main(["ra", "1"]);
      expect(code).toBe(0);
      expect(exchange).toHaveBeenCalled();
      expect(output.text()).toContain("Re-authenticated");
    } finally {
      restoreTTY();
    }
  });

  it("routes 'rf' alias to refresh", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
    });
    const code = await main(["rf", "1"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Token refreshed");
  });

  it("supports integration io capture option", async () => {
    // This test validates IO redirection itself, so disable outer capture hook.
    output.restore();

    const logs = [];
    const errors = [];
    const code = await main(["status"], {
      io: {
        log: (...args) => logs.push(args.join(" ")),
        error: (...args) => errors.push(args.join(" ")),
      },
    });

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(logs.join("\n")).toContain("anthropic:");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: missing arguments
// ---------------------------------------------------------------------------

describe("missing argument handling", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    loadAccounts.mockResolvedValue(makeStorage());
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("cmdSwitch rejects undefined arg", async () => {
    const code = await cmdSwitch(undefined);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });

  it("cmdEnable rejects undefined arg", async () => {
    const code = await cmdEnable(undefined);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });

  it("cmdDisable rejects undefined arg", async () => {
    const code = await cmdDisable(undefined);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });

  it("cmdRemove rejects undefined arg", async () => {
    const code = await cmdRemove(undefined, { force: true });
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });
});

// ---------------------------------------------------------------------------
// Case insensitivity
// ---------------------------------------------------------------------------

describe("case insensitivity", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("cmdReset accepts 'ALL' (uppercase)", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 3;
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("ALL");
    expect(code).toBe(0);
    expect(output.text()).toContain("all 3 account(s)");
  });

  it("cmdReset accepts 'All' (mixed case)", async () => {
    const storage = makeStorage();
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("All");
    expect(code).toBe(0);
    expect(output.text()).toContain("all 3 account(s)");
  });
});

// ---------------------------------------------------------------------------
// cmdRemove: active account removal
// ---------------------------------------------------------------------------

describe("cmdRemove active account", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
    output = captureOutput();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("adjusts activeIndex when removing the active account", async () => {
    const storage = makeStorage({ activeIndex: 1 }); // bob is active
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdRemove("2", { force: true }); // remove bob
    expect(code).toBe(0);

    const saved = saveAccounts.mock.calls[0][0];
    // activeIndex was 1, we removed index 1, so it should clamp to length-1 = 1
    // (now pointing to charlie, the new index 1)
    expect(saved.activeIndex).toBe(1);
    expect(saved.accounts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// cmdStats
// ---------------------------------------------------------------------------

describe("cmdStats", () => {
  let output;

  beforeEach(() => {
    output = captureOutput();
    vi.clearAllMocks();
  });

  afterEach(() => {
    output.restore();
  });

  function makeStatsStorage() {
    const storage = makeStorage();
    storage.accounts[0].stats = {
      requests: 142,
      inputTokens: 1_200_000,
      outputTokens: 380_000,
      cacheReadTokens: 890_000,
      cacheWriteTokens: 45_000,
      lastReset: Date.now() - 86400_000,
    };
    storage.accounts[1].email = "bob@example.com";
    storage.accounts[1].stats = {
      requests: 87,
      inputTokens: 720_000,
      outputTokens: 210_000,
      cacheReadTokens: 540_000,
      cacheWriteTokens: 32_000,
      lastReset: Date.now() - 86400_000,
    };
    return storage;
  }

  it("displays per-account usage statistics", async () => {
    loadAccounts.mockResolvedValue(makeStatsStorage());
    const code = await cmdStats();
    expect(code).toBe(0);
    const text = output.text();
    expect(text).toContain("alice@example.com");
    expect(text).toContain("bob@example.com");
    expect(text).toContain("142");
    expect(text).toContain("87");
    expect(text).toContain("1.2M");
    expect(text).toContain("Total");
  });

  it("returns 1 when no accounts configured", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdStats();
    expect(code).toBe(1);
    const text = output.text();
    expect(text).toContain("No accounts");
  });

  it("handles accounts with no stats (defaults)", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]]; // single account, no stats field
    loadAccounts.mockResolvedValue(storage);
    const code = await cmdStats();
    expect(code).toBe(0);
    const text = output.text();
    expect(text).toContain("alice@example.com");
    expect(text).toContain("0");
  });
});

// ---------------------------------------------------------------------------
// cmdResetStats
// ---------------------------------------------------------------------------

describe("cmdResetStats", () => {
  let output;

  beforeEach(() => {
    output = captureOutput();
    vi.clearAllMocks();
    saveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("resets stats for all accounts", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.accounts[0].stats = {
      requests: 100,
      inputTokens: 50000,
      outputTokens: 20000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: 1000,
    };
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats("all");
    expect(code).toBe(0);
    const text = output.text();
    expect(text).toContain("Reset usage statistics for all");

    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].stats.requests).toBe(0);
    expect(saved.accounts[0].stats.inputTokens).toBe(0);
  });

  it("resets stats for a single account", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.accounts[0].stats = {
      requests: 100,
      inputTokens: 50000,
      outputTokens: 20000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: 1000,
    };
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats("1");
    expect(code).toBe(0);
    const text = output.text();
    expect(text).toContain("Reset usage statistics for alice@example.com");
  });

  it("returns 1 for invalid account number", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats("99");
    expect(code).toBe(1);
  });

  it("resets all accounts when no argument given", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.accounts[0].stats = {
      requests: 50,
      inputTokens: 10000,
      outputTokens: 5000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: 1000,
    };
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats();
    expect(code).toBe(0);
    const text = output.text();
    expect(text).toContain("Reset usage statistics for all");

    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].stats.requests).toBe(0);
  });

  it("returns 1 when no accounts configured", async () => {
    loadAccounts.mockResolvedValue(null);
    const code = await cmdResetStats("all");
    expect(code).toBe(1);
  });
});
