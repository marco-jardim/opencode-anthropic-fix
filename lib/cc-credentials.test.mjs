import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  readCCCredentialsFromKeychain,
  readCCCredentialsFromFile,
  readCCCredentials,
  parseCCCredentialData,
} from "./cc-credentials.mjs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_CRED = {
  accessToken: "acc-123",
  refreshToken: "ref-456",
  expiresAt: Date.now() + 3_600_000,
  subscriptionType: "claude_pro",
};

const VALID_CRED_2 = {
  accessToken: "acc-789",
  refreshToken: "ref-012",
  expiresAt: Date.now() + 7_200_000,
};

const MCP_ONLY_CRED = {
  accessToken: "mcp-acc",
  refreshToken: "mcp-ref",
  expiresAt: Date.now() + 3_600_000,
  scope: "mcp",
};

const KEYCHAIN_DUMP_SINGLE = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
    0x00000007 <blob>="Claude Code-credentials"
    "svce"<blob>="Claude Code-credentials"
`;

const KEYCHAIN_DUMP_MULTI = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
    "svce"<blob>="Claude Code-credentials-0"
    "svce"<blob>="Claude Code-credentials-1"
    "svce"<blob>="Claude Code-credentials-0"
`;

// ---------------------------------------------------------------------------
// parseCCCredentialData
// ---------------------------------------------------------------------------

describe("parseCCCredentialData", () => {
  it("parses valid flat JSON", () => {
    const result = parseCCCredentialData(JSON.stringify(VALID_CRED), "cc-file", "test");
    expect(result).not.toBeNull();
    expect(result.accessToken).toBe("acc-123");
    expect(result.refreshToken).toBe("ref-456");
    expect(result.subscriptionType).toBe("claude_pro");
    expect(result.source).toBe("cc-file");
    expect(result.label).toBe("test");
  });

  it("parses wrapped claudeAiOauth format", () => {
    const wrapped = { claudeAiOauth: VALID_CRED };
    const result = parseCCCredentialData(JSON.stringify(wrapped), "cc-keychain", "kc");
    expect(result).not.toBeNull();
    expect(result.accessToken).toBe("acc-123");
    expect(result.source).toBe("cc-keychain");
  });

  it("returns null for invalid JSON", () => {
    expect(parseCCCredentialData("not json", "cc-file", "x")).toBeNull();
  });

  it("returns null for missing accessToken", () => {
    const data = { refreshToken: "ref" };
    expect(parseCCCredentialData(JSON.stringify(data), "cc-file", "x")).toBeNull();
  });

  it("returns null for missing refreshToken", () => {
    const data = { accessToken: "acc" };
    expect(parseCCCredentialData(JSON.stringify(data), "cc-file", "x")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseCCCredentialData('"hello"', "cc-file", "x")).toBeNull();
    expect(parseCCCredentialData("42", "cc-file", "x")).toBeNull();
    expect(parseCCCredentialData("null", "cc-file", "x")).toBeNull();
  });

  it("handles expiresAt as ISO string", () => {
    const data = { ...VALID_CRED, expiresAt: "2026-06-15T12:00:00Z" };
    const result = parseCCCredentialData(JSON.stringify(data), "cc-file", "x");
    expect(result).not.toBeNull();
    expect(result.expiresAt).toBe(Date.parse("2026-06-15T12:00:00Z"));
  });

  it("handles expires_at fallback field", () => {
    const data = { accessToken: "a", refreshToken: "r", expires_at: 999999 };
    const result = parseCCCredentialData(JSON.stringify(data), "cc-file", "x");
    expect(result).not.toBeNull();
    expect(result.expiresAt).toBe(999999);
  });

  it("defaults expiresAt to 0 when missing", () => {
    const data = { accessToken: "a", refreshToken: "r" };
    const result = parseCCCredentialData(JSON.stringify(data), "cc-file", "x");
    expect(result.expiresAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readCCCredentialsFromKeychain
// ---------------------------------------------------------------------------

describe("readCCCredentialsFromKeychain", () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform });
    vi.resetAllMocks();
  });

  it("returns empty on non-darwin platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(readCCCredentialsFromKeychain()).toEqual([]);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("reads single keychain service on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    execSync.mockImplementation((cmd) => {
      if (cmd === "security dump-keychain") return KEYCHAIN_DUMP_SINGLE;
      if (cmd.includes("find-generic-password")) return JSON.stringify(VALID_CRED);
      throw new Error("unexpected cmd");
    });

    const result = readCCCredentialsFromKeychain();
    expect(result).toHaveLength(1);
    expect(result[0].accessToken).toBe("acc-123");
    expect(result[0].source).toBe("cc-keychain");
    expect(result[0].label).toContain("keychain:");
  });

  it("reads multiple keychain services and deduplicates service names", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    let callIdx = 0;
    execSync.mockImplementation((cmd) => {
      if (cmd === "security dump-keychain") return KEYCHAIN_DUMP_MULTI;
      if (cmd.includes("find-generic-password")) {
        callIdx++;
        const cred = callIdx === 1 ? VALID_CRED : VALID_CRED_2;
        return JSON.stringify(cred);
      }
      throw new Error("unexpected cmd");
    });

    const result = readCCCredentialsFromKeychain();
    // KEYCHAIN_DUMP_MULTI has credentials-0 twice, but should be deduped to 2 services
    expect(result).toHaveLength(2);
    expect(result[0].accessToken).toBe("acc-123");
    expect(result[1].accessToken).toBe("acc-789");
  });

  it("returns empty when dump-keychain throws", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    execSync.mockImplementation(() => {
      throw new Error("no keychain");
    });

    expect(readCCCredentialsFromKeychain()).toEqual([]);
  });

  it("skips services where find-generic-password fails (exit 44)", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    execSync.mockImplementation((cmd) => {
      if (cmd === "security dump-keychain") return KEYCHAIN_DUMP_SINGLE;
      if (cmd.includes("find-generic-password")) {
        const err = new Error("not found");
        err.status = 44;
        throw err;
      }
      throw new Error("unexpected");
    });

    expect(readCCCredentialsFromKeychain()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readCCCredentialsFromFile
// ---------------------------------------------------------------------------

describe("readCCCredentialsFromFile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    homedir.mockReturnValue("/home/testuser");
  });

  it("returns empty when credentials file does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(readCCCredentialsFromFile()).toEqual([]);
  });

  it("reads flat credential object", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(VALID_CRED));

    const result = readCCCredentialsFromFile();
    expect(result).toHaveLength(1);
    expect(result[0].accessToken).toBe("acc-123");
    expect(result[0].source).toBe("cc-file");
    expect(result[0].label).toBe("file:entry-0");
  });

  it("reads wrapped claudeAiOauth format", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: VALID_CRED }));

    const result = readCCCredentialsFromFile();
    expect(result).toHaveLength(1);
    expect(result[0].accessToken).toBe("acc-123");
  });

  it("reads array of credentials", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify([VALID_CRED, VALID_CRED_2]));

    const result = readCCCredentialsFromFile();
    expect(result).toHaveLength(2);
    expect(result[0].accessToken).toBe("acc-123");
    expect(result[1].accessToken).toBe("acc-789");
  });

  it("filters MCP-only entries", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify([VALID_CRED, MCP_ONLY_CRED]));

    const result = readCCCredentialsFromFile();
    expect(result).toHaveLength(1);
    expect(result[0].accessToken).toBe("acc-123");
  });

  it("skips non-object entries in array", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify([null, 42, "hello", VALID_CRED]));

    const result = readCCCredentialsFromFile();
    expect(result).toHaveLength(1);
    expect(result[0].accessToken).toBe("acc-123");
  });

  it("returns empty on invalid JSON", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("not json at all");

    expect(readCCCredentialsFromFile()).toEqual([]);
  });

  it("returns empty on read error", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(readCCCredentialsFromFile()).toEqual([]);
  });

  it("handles entries missing required fields gracefully", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify([{ accessToken: "only-access" }, VALID_CRED]));

    const result = readCCCredentialsFromFile();
    expect(result).toHaveLength(1);
    expect(result[0].accessToken).toBe("acc-123");
  });
});

// ---------------------------------------------------------------------------
// readCCCredentials (unified)
// ---------------------------------------------------------------------------

describe("readCCCredentials", () => {
  const origPlatform = process.platform;

  beforeEach(() => {
    vi.resetAllMocks();
    homedir.mockReturnValue("/home/testuser");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform });
  });

  it("combines keychain and file sources on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    // Keychain returns one credential
    execSync.mockImplementation((cmd) => {
      if (cmd === "security dump-keychain") return KEYCHAIN_DUMP_SINGLE;
      if (cmd.includes("find-generic-password")) return JSON.stringify(VALID_CRED);
      throw new Error("unexpected");
    });

    // File returns a different credential
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(VALID_CRED_2));

    const result = readCCCredentials();
    expect(result).toHaveLength(2);
    expect(result.some((c) => c.source === "cc-keychain")).toBe(true);
    expect(result.some((c) => c.source === "cc-file")).toBe(true);
  });

  it("deduplicates by refreshToken, preferring keychain", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    // Both sources return same refreshToken
    const keychainCred = { ...VALID_CRED, accessToken: "keychain-token" };
    const fileCred = { ...VALID_CRED, accessToken: "file-token" };

    execSync.mockImplementation((cmd) => {
      if (cmd === "security dump-keychain") return KEYCHAIN_DUMP_SINGLE;
      if (cmd.includes("find-generic-password")) return JSON.stringify(keychainCred);
      throw new Error("unexpected");
    });

    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(fileCred));

    const result = readCCCredentials();
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("cc-keychain");
    expect(result[0].accessToken).toBe("keychain-token");
  });

  it("returns only file credentials on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(VALID_CRED));

    const result = readCCCredentials();
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("cc-file");
    expect(execSync).not.toHaveBeenCalled();
  });

  it("returns empty when no sources available", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    existsSync.mockReturnValue(false);

    expect(readCCCredentials()).toEqual([]);
  });
});
