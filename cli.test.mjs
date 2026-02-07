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
  cmdList,
  cmdStatus,
  cmdSwitch,
  cmdEnable,
  cmdDisable,
  cmdRemove,
  cmdReset,
  cmdStats,
  cmdResetStats,
  cmdConfig,
  cmdHelp,
  main,
} from "./cli.mjs";
import { loadAccounts, saveAccounts } from "./lib/storage.mjs";

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
    text: () => logs.join("\n").replace(/\x1b\[[0-9;]*m/g, ""),
    /** Get all error output as a single string (ANSI stripped) */
    errorText: () => errors.join("\n").replace(/\x1b\[[0-9;]*m/g, ""),
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
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

// ---------------------------------------------------------------------------
// cmdList
// ---------------------------------------------------------------------------

describe("cmdList", () => {
  let output;

  beforeEach(() => {
    vi.resetAllMocks();
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
    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ activeIndex: 1 }),
    );
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
          stats: {
            requests: 142,
            inputTokens: 1_200_000,
            outputTokens: 380_000,
            cacheReadTokens: 890_000,
            cacheWriteTokens: 45_000,
            lastReset: Date.now() - 86400_000,
          },
        },
        {
          email: "bob@example.com",
          refreshToken: "refresh-bob",
          addedAt: 2000,
          lastUsed: 3000,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
          stats: {
            requests: 87,
            inputTokens: 720_000,
            outputTokens: 210_000,
            cacheReadTokens: 540_000,
            cacheWriteTokens: 32_000,
            lastReset: Date.now() - 86400_000,
          },
        },
      ],
      activeIndex: 0,
    };
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
    loadAccounts.mockResolvedValue({
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
          // No stats field
        },
      ],
      activeIndex: 0,
    });
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
    const storage = {
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
          stats: { requests: 100, inputTokens: 50000, outputTokens: 20000, cacheReadTokens: 0, cacheWriteTokens: 0, lastReset: 1000 },
        },
      ],
      activeIndex: 0,
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
    const storage = {
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
          stats: { requests: 100, inputTokens: 50000, outputTokens: 20000, cacheReadTokens: 0, cacheWriteTokens: 0, lastReset: 1000 },
        },
      ],
      activeIndex: 0,
    };
    loadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats("1");
    expect(code).toBe(0);
    const text = output.text();
    expect(text).toContain("Reset usage statistics for alice@example.com");
  });

  it("returns 1 for invalid account number", async () => {
    loadAccounts.mockResolvedValue({
      version: 1,
      accounts: [{ refreshToken: "tok1", email: "a@b.com", addedAt: 1000, lastUsed: 0, enabled: true, rateLimitResetTimes: {}, consecutiveFailures: 0, lastFailureTime: null }],
      activeIndex: 0,
    });

    const code = await cmdResetStats("99");
    expect(code).toBe(1);
  });

  it("resets all accounts when no argument given", async () => {
    const storage = {
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
          stats: { requests: 50, inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, lastReset: 1000 },
        },
      ],
      activeIndex: 0,
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
