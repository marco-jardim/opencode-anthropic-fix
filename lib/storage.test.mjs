import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deduplicateByRefreshToken,
  ensureGitignore,
  getStoragePath,
  loadAccounts,
  saveAccounts,
  clearAccounts,
} from "./storage.mjs";
import { promises as fs } from "node:fs";
import {
  existsSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";

// Mock fs modules
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    chmod: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({
    toString: () => "abcdef123456",
  })),
}));

// ---------------------------------------------------------------------------
// deduplicateByRefreshToken
// ---------------------------------------------------------------------------

describe("deduplicateByRefreshToken", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateByRefreshToken([])).toEqual([]);
  });

  it("returns single account unchanged", () => {
    const accounts = [
      {
        refreshToken: "token1",
        addedAt: 1000,
        lastUsed: 2000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
    ];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(1);
    expect(result[0].refreshToken).toBe("token1");
  });

  it("keeps most recently used when duplicates exist", () => {
    const accounts = [
      {
        refreshToken: "token1",
        addedAt: 1000,
        lastUsed: 1000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
      {
        refreshToken: "token1",
        addedAt: 2000,
        lastUsed: 5000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
    ];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(1);
    expect(result[0].lastUsed).toBe(5000);
  });

  it("keeps different tokens as separate accounts", () => {
    const accounts = [
      {
        refreshToken: "token1",
        addedAt: 1000,
        lastUsed: 1000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
      {
        refreshToken: "token2",
        addedAt: 2000,
        lastUsed: 2000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
    ];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(2);
  });

  it("skips accounts without refreshToken", () => {
    const accounts = [
      {
        refreshToken: "",
        addedAt: 1000,
        lastUsed: 1000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
    ];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ensureGitignore
// ---------------------------------------------------------------------------

describe("ensureGitignore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates new .gitignore when none exists", () => {
    existsSync.mockReturnValue(false);
    ensureGitignore("/config/dir");
    expect(writeFileSync).toHaveBeenCalledWith(
      "/config/dir/.gitignore",
      expect.stringContaining("anthropic-accounts.json"),
      "utf-8",
    );
  });

  it("appends missing entries to existing .gitignore", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("some-other-file\n");
    ensureGitignore("/config/dir");
    expect(appendFileSync).toHaveBeenCalledWith(
      "/config/dir/.gitignore",
      expect.stringContaining("anthropic-accounts.json"),
      "utf-8",
    );
  });

  it("does nothing when all entries already present", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      ".gitignore\nanthropic-accounts.json\nanthropic-accounts.json.*.tmp\n",
    );
    ensureGitignore("/config/dir");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("handles errors gracefully", () => {
    existsSync.mockImplementation(() => {
      throw new Error("permission denied");
    });
    // Should not throw
    expect(() => ensureGitignore("/config/dir")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getStoragePath
// ---------------------------------------------------------------------------

describe("getStoragePath", () => {
  it("returns path ending with anthropic-accounts.json", () => {
    const path = getStoragePath();
    expect(path.endsWith("anthropic-accounts.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadAccounts
// ---------------------------------------------------------------------------

describe("loadAccounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when file does not exist", async () => {
    fs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await loadAccounts();
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    fs.readFile.mockResolvedValue("not json");
    const result = await loadAccounts();
    expect(result).toBeNull();
  });

  it("returns null for wrong version", async () => {
    fs.readFile.mockResolvedValue(
      JSON.stringify({ version: 99, accounts: [] }),
    );
    const result = await loadAccounts();
    expect(result).toBeNull();
  });

  it("returns null when accounts is not an array", async () => {
    fs.readFile.mockResolvedValue(
      JSON.stringify({ version: 1, accounts: "not-array" }),
    );
    const result = await loadAccounts();
    expect(result).toBeNull();
  });

  it("loads valid accounts", async () => {
    fs.readFile.mockResolvedValue(
      JSON.stringify({
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
      }),
    );
    const result = await loadAccounts();
    expect(result).not.toBeNull();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].refreshToken).toBe("token1");
    expect(result.activeIndex).toBe(0);
  });

  it("filters out invalid accounts (missing refreshToken)", async () => {
    fs.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          { refreshToken: "valid", addedAt: 1000 },
          { email: "no-token" },
          null,
        ],
        activeIndex: 0,
      }),
    );
    const result = await loadAccounts();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].refreshToken).toBe("valid");
  });

  it("clamps activeIndex to valid range", async () => {
    fs.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [{ refreshToken: "token1" }],
        activeIndex: 99,
      }),
    );
    const result = await loadAccounts();
    expect(result.activeIndex).toBe(0);
  });

  it("deduplicates accounts by refresh token", async () => {
    fs.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          { refreshToken: "token1", lastUsed: 1000 },
          { refreshToken: "token1", lastUsed: 5000 },
        ],
        activeIndex: 0,
      }),
    );
    const result = await loadAccounts();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].lastUsed).toBe(5000);
  });

  it("applies defaults for missing fields", async () => {
    fs.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [{ refreshToken: "token1" }],
        activeIndex: 0,
      }),
    );
    const result = await loadAccounts();
    const acc = result.accounts[0];
    expect(acc.enabled).toBe(true);
    expect(acc.consecutiveFailures).toBe(0);
    expect(acc.lastFailureTime).toBeNull();
    expect(acc.rateLimitResetTimes).toEqual({});
    expect(acc.lastUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// saveAccounts
// ---------------------------------------------------------------------------

describe("saveAccounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      ".gitignore\nanthropic-accounts.json\nanthropic-accounts.json.*.tmp\n",
    );
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.rename.mockResolvedValue(undefined);
    fs.chmod.mockResolvedValue(undefined);
  });

  it("writes atomically via temp file + rename", async () => {
    const storage = {
      version: 1,
      accounts: [{ refreshToken: "token1" }],
      activeIndex: 0,
    };
    await saveAccounts(storage);

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.any(String),
      "utf-8",
    );
    expect(fs.rename).toHaveBeenCalled();
    expect(fs.chmod).toHaveBeenCalledWith(
      expect.any(String),
      0o600,
    );
  });

  it("creates config directory if needed", async () => {
    const storage = { version: 1, accounts: [], activeIndex: 0 };
    await saveAccounts(storage);
    expect(fs.mkdir).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
    });
  });

  it("cleans up temp file on write error", async () => {
    fs.writeFile.mockRejectedValue(new Error("disk full"));
    fs.unlink.mockResolvedValue(undefined);

    const storage = { version: 1, accounts: [], activeIndex: 0 };
    await expect(saveAccounts(storage)).rejects.toThrow("disk full");
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".tmp"));
  });
});

// ---------------------------------------------------------------------------
// clearAccounts
// ---------------------------------------------------------------------------

describe("clearAccounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("deletes the storage file", async () => {
    fs.unlink.mockResolvedValue(undefined);
    await clearAccounts();
    expect(fs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("anthropic-accounts.json"),
    );
  });

  it("ignores ENOENT errors", async () => {
    fs.unlink.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    await expect(clearAccounts()).resolves.toBeUndefined();
  });

  it("rethrows non-ENOENT errors", async () => {
    fs.unlink.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await expect(clearAccounts()).rejects.toThrow("permission denied");
  });
});
