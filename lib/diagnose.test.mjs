import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accounts: null,
  config: {},
  configDir: "/diagnose/config",
  debugHeadersExists: false,
  directoryExists: false,
  entries: [],
  fileContents: new Map(),
  home: "/diagnose/home",
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn((filePath) => {
    const value = String(filePath);
    if (value.endsWith("debug-headers.log")) return state.debugHeadersExists;
    if (value.endsWith("request-dumps")) return state.directoryExists;
    return false;
  }),
  readFileSync: vi.fn((filePath) => {
    const value = String(filePath);
    if (value.endsWith("package.json")) return JSON.stringify({ version: "1.2.3-test" });
    const file = value.split(/[\\/]/).at(-1);
    if (!state.fileContents.has(file)) throw new Error(`Missing fixture: ${file}`);
    return state.fileContents.get(file);
  }),
  readdirSync: vi.fn(() => [...state.entries]),
  statSync: vi.fn((filePath) => {
    const file = String(filePath).split(/[\\/]/).at(-1);
    const contents = state.fileContents.get(file) ?? "";
    return { size: Buffer.byteLength(contents) };
  }),
}));

vi.mock("node:os", () => ({
  default: { homedir: vi.fn(() => state.home) },
}));

vi.mock("./config.mjs", () => ({
  getConfigDir: vi.fn(() => state.configDir),
  loadConfig: vi.fn(() => state.config),
}));

vi.mock("./storage.mjs", () => ({
  loadAccounts: vi.fn(async () => state.accounts),
}));

import { buildDiagnosticBundle } from "./diagnose.mjs";

describe("buildDiagnosticBundle", () => {
  beforeEach(() => {
    state.accounts = null;
    state.config = {};
    state.debugHeadersExists = false;
    state.directoryExists = false;
    state.entries = [];
    state.fileContents.clear();
  });

  it("returns all sections without leaking seeded secrets", async () => {
    const bearer = "Bearer diagnoseBearerToken123";
    const apiKey = "sk-ant-diagnoseSecret123";
    const oauthToken = "oat01DiagnoseSecret123";
    const refreshToken = "literal-refresh-secret";
    const access = "literal-access-secret";

    state.config = {
      authorization: bearer,
      apiKey,
      metadata: oauthToken,
      refreshToken,
    };
    state.accounts = {
      accounts: [
        {
          email: "alice@example.com",
          enabled: true,
          consecutiveFailures: 2,
          rateLimitResetTimes: { primary: 1234 },
          access,
          refreshToken,
        },
      ],
    };

    const bundle = await buildDiagnosticBundle();
    const serialized = JSON.stringify(bundle);

    expect(Object.keys(bundle)).toEqual(["meta", "config", "env", "accounts", "artifacts"]);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/sk-ant-[A-Za-z0-9]{4,}/);
    expect(serialized).not.toMatch(/\boat01[A-Za-z0-9]{8,}/);
    for (const secret of [bearer, apiKey, oauthToken, refreshToken, access]) {
      expect(serialized).not.toContain(secret);
    }
    expect(bundle.accounts.items[0].email).toBe("a***@example.com");
    expect(bundle.accounts.items[0]).not.toHaveProperty("access");
    expect(bundle.accounts.items[0]).not.toHaveProperty("refreshToken");
  });

  it("degrades gracefully when accounts and artifact directories are absent", async () => {
    const bundle = await buildDiagnosticBundle();

    expect(bundle.accounts).toEqual({ count: 0, items: [] });
    expect(bundle.artifacts.requestDumps).toEqual([]);
    expect(bundle.artifacts.responseDumps).toEqual([]);
    expect(bundle.artifacts.debugHeadersLog).toEqual({ exists: false, sizeBytes: 0 });
  });

  it("records a corrupted request dump and continues", async () => {
    const corruptFile = "req-2026-04-10T12-00-00-000Z-correlation.json";
    state.directoryExists = true;
    state.entries = [corruptFile];
    state.fileContents.set(corruptFile, "{not-json");

    const bundle = await buildDiagnosticBundle();

    expect(bundle.artifacts.requestDumps).toEqual([{ file: corruptFile, error: "unparseable" }]);
    expect(bundle.artifacts.responseDumps).toEqual([]);
  });
});
