import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ stdout: "", throwMessage: null }));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    if (state.throwMessage !== null) {
      throw new Error(state.throwMessage);
    }
    return state.stdout;
  }),
}));

import {
  evaluateDrift,
  fetchRegistryLatest,
  PACKAGE_NAME,
  readInstalledVersion,
  readLockedVersion,
} from "./check-wire-compat-drift.mjs";

/**
 * @returns {string}
 */
function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wire-compat-drift-"));
}

describe("readLockedVersion", () => {
  it("reads the resolved version from package-lock.json", () => {
    const fixturePath = makeFixtureDir();
    try {
      fs.writeFileSync(
        path.join(fixturePath, "package-lock.json"),
        JSON.stringify({ packages: { [`node_modules/${PACKAGE_NAME}`]: { version: "0.7.0" } } }),
      );
      expect(readLockedVersion(fixturePath)).toBe("0.7.0");
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("returns null when the lockfile is missing", () => {
    const fixturePath = makeFixtureDir();
    try {
      expect(readLockedVersion(fixturePath)).toBeNull();
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("returns null when the lockfile has no entry for the package", () => {
    const fixturePath = makeFixtureDir();
    try {
      fs.writeFileSync(path.join(fixturePath, "package-lock.json"), JSON.stringify({ packages: {} }));
      expect(readLockedVersion(fixturePath)).toBeNull();
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("readInstalledVersion", () => {
  it("reads the version from the installed package's package.json", () => {
    const fixturePath = makeFixtureDir();
    try {
      const packageDir = path.join(fixturePath, "node_modules", ...PACKAGE_NAME.split("/"));
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "0.7.0" }));
      expect(readInstalledVersion(fixturePath)).toBe("0.7.0");
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("returns null when the package is not installed", () => {
    const fixturePath = makeFixtureDir();
    try {
      expect(readInstalledVersion(fixturePath)).toBeNull();
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("fetchRegistryLatest", () => {
  it("parses a bare dist-tag string reported by npm view", () => {
    state.throwMessage = null;
    state.stdout = '"0.7.0"\n';
    expect(fetchRegistryLatest(process.cwd())).toEqual({ version: "0.7.0" });
  });

  it("parses a single-element array, the shape npm 12 actually prints", () => {
    state.throwMessage = null;
    state.stdout = '[\n  "0.7.0"\n]\n';
    expect(fetchRegistryLatest(process.cwd())).toEqual({ version: "0.7.0" });
  });

  it("reports an error when npm view returns an empty array", () => {
    state.throwMessage = null;
    state.stdout = "[]\n";
    const result = fetchRegistryLatest(process.cwd());
    expect(result).toHaveProperty("error");
  });

  it("reports an error when npm view returns more than one element", () => {
    state.throwMessage = null;
    state.stdout = '["0.6.0", "0.7.0"]\n';
    const result = fetchRegistryLatest(process.cwd());
    expect(result).toHaveProperty("error");
  });

  it("reports an error when npm view fails (offline, registry down)", () => {
    state.throwMessage = "network timeout";
    const result = fetchRegistryLatest(process.cwd());
    expect(result).toHaveProperty("error");
    expect(result.error).toContain("network timeout");
  });

  it("reports an error when npm view returns unparseable output", () => {
    state.throwMessage = null;
    state.stdout = "not json";
    const result = fetchRegistryLatest(process.cwd());
    expect(result).toHaveProperty("error");
  });

  it("reports an error when npm view returns valid JSON that is not a version string", () => {
    state.throwMessage = null;
    state.stdout = "42\n";
    const result = fetchRegistryLatest(process.cwd());
    expect(result).toHaveProperty("error");
  });
});

describe("evaluateDrift", () => {
  it("passes when the lock, node_modules, and the registry all agree", () => {
    const result = evaluateDrift({
      lockedVersion: "0.7.0",
      installedVersion: "0.7.0",
      registryResult: { version: "0.7.0" },
      allowOffline: false,
    });
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("fails, naming the sync command, when the lock is behind the registry", () => {
    const result = evaluateDrift({
      lockedVersion: "0.6.0",
      installedVersion: "0.6.0",
      registryResult: { version: "0.7.0" },
      allowOffline: false,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("npm run sync:wire-compat"))).toBe(true);
  });

  it("fails, naming npm install, when node_modules disagrees with the lock", () => {
    const result = evaluateDrift({
      lockedVersion: "0.7.0",
      installedVersion: "0.6.0",
      registryResult: { version: "0.7.0" },
      allowOffline: false,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("npm install"))).toBe(true);
  });

  it("fails when the package is not installed at all", () => {
    const result = evaluateDrift({
      lockedVersion: "0.7.0",
      installedVersion: null,
      registryResult: { version: "0.7.0" },
      allowOffline: false,
    });
    expect(result.ok).toBe(false);
  });

  it("fails when the lockfile has no resolved entry", () => {
    const result = evaluateDrift({
      lockedVersion: null,
      installedVersion: "0.7.0",
      registryResult: { version: "0.7.0" },
      allowOffline: false,
    });
    expect(result.ok).toBe(false);
  });

  it("fails when the registry is unreachable and --allow-offline was not passed", () => {
    const result = evaluateDrift({
      lockedVersion: "0.7.0",
      installedVersion: "0.7.0",
      registryResult: { error: "getaddrinfo ENOTFOUND registry.npmjs.org" },
      allowOffline: false,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("registry.npmjs.org"))).toBe(true);
  });

  it("warns instead of failing when the registry is unreachable and --allow-offline was passed", () => {
    const result = evaluateDrift({
      lockedVersion: "0.7.0",
      installedVersion: "0.7.0",
      registryResult: { error: "getaddrinfo ENOTFOUND registry.npmjs.org" },
      allowOffline: true,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
