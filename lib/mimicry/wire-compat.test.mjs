import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getWireCompatPackageVersion, WIRE_PROFILE } from "./wire-compat.mjs";

describe("getWireCompatPackageVersion", () => {
  it("matches the version actually installed in node_modules", () => {
    const installedPackageJsonPath = path.join(
      path.dirname(fileURLToPath(import.meta.resolve("@tormentalabs/claude-code-wire-compat"))),
      "..",
      "package.json",
    );
    const installed = JSON.parse(readFileSync(installedPackageJsonPath, "utf8"));

    expect(installed.name).toBe("@tormentalabs/claude-code-wire-compat");
    expect(getWireCompatPackageVersion()).toBe(installed.version);
  });

  it("returns a non-empty string, never throwing, even in the worst case", () => {
    const version = getWireCompatPackageVersion();

    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });
});

describe("WIRE_PROFILE", () => {
  it("carries the id and cliVersion the diagnostic bundle reads", () => {
    expect(typeof WIRE_PROFILE.id).toBe("string");
    expect(WIRE_PROFILE.id).toContain(WIRE_PROFILE.cliVersion);
  });
});
