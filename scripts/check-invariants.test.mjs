import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { extractChangelogVersion, runChecks } from "./check-invariants.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("check-invariants", () => {
  it("passes the current tree", () => {
    const result = runChecks({ cwd: repoRoot });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails a fabricated mismatch", () => {
    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "check-invariants-"));

    try {
      fs.writeFileSync(path.join(fixturePath, "package.json"), '{"version":"0.1.0"}\n');
      fs.writeFileSync(path.join(fixturePath, "CHANGELOG.md"), "## [0.2.0]\n");

      const result = runChecks({ cwd: fixturePath });

      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it.each(["## [0.1.27] — 2026-05-16", "## [0.1.27]"])("extracts the newest version from %s", (heading) => {
    expect(extractChangelogVersion(heading)).toBe("0.1.27");
  });
});
