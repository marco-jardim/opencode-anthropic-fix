import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpRoot;
let originalAppdata;
let originalXdg;

vi.mock("../lib/config.mjs", async () => {
  return {
    getConfigDir: () => globalThis.__TEST_CFG_DIR__,
  };
});

// Import AFTER the mock is declared.
const { loadContextHintDisabledFlag, saveContextHintDisabledFlag, getContextHintFlagPath } =
  await import("../lib/context-hint-persist.mjs");

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ctx-hint-persist-"));
  globalThis.__TEST_CFG_DIR__ = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete globalThis.__TEST_CFG_DIR__;
});

describe("context-hint-persist", () => {
  it("returns { disabled: false } when the flag file does not exist", () => {
    expect(loadContextHintDisabledFlag()).toEqual({ disabled: false });
  });

  it("writes the flag file with reason + status + timestamp", () => {
    saveContextHintDisabledFlag({ reason: "beta_unsupported_400", status: 400 });
    const p = getContextHintFlagPath();
    expect(existsSync(p)).toBe(true);
    const body = JSON.parse(readFileSync(p, "utf-8"));
    expect(body.disabled).toBe(true);
    expect(body.reason).toBe("beta_unsupported_400");
    expect(body.status).toBe(400);
    expect(typeof body.timestamp).toBe("number");
    expect(body.version).toBe(1);
  });

  it("loads a previously written flag file", () => {
    saveContextHintDisabledFlag({ reason: "beta_unsupported_400", status: 400 });
    const loaded = loadContextHintDisabledFlag();
    expect(loaded.disabled).toBe(true);
    expect(loaded.reason).toBe("beta_unsupported_400");
    expect(loaded.status).toBe(400);
    expect(typeof loaded.timestamp).toBe("number");
  });

  it("treats a corrupted flag file as not disabled (never crashes)", () => {
    writeFileSync(getContextHintFlagPath(), "{not valid json", "utf-8");
    expect(loadContextHintDisabledFlag()).toEqual({ disabled: false });
  });

  it("ignores a flag file whose disabled field is not strictly true", () => {
    writeFileSync(getContextHintFlagPath(), JSON.stringify({ disabled: "yes" }), "utf-8");
    expect(loadContextHintDisabledFlag()).toEqual({ disabled: false });
  });

  it("is idempotent — repeat saves overwrite cleanly", () => {
    saveContextHintDisabledFlag({ reason: "first", status: 400 });
    saveContextHintDisabledFlag({ reason: "second", status: 409 });
    const loaded = loadContextHintDisabledFlag();
    expect(loaded.reason).toBe("second");
    expect(loaded.status).toBe(409);
  });
});
