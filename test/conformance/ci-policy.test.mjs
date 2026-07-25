import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const ciPath = resolve(repositoryRoot, ".github/workflows/ci.yml");
const publishPath = resolve(repositoryRoot, ".github/workflows/publish.yml");
const ciExists = existsSync(ciPath);
const ci = ciExists ? readFileSync(ciPath, "utf8") : "";

describe("CI workflow policy", () => {
  it("is present and structurally well-formed YAML", () => {
    expect(ciExists).toBe(true);
    expect(ci).not.toContain("\t");
    expect(ci).toMatch(/^name:\s+ci$/m);
    expect(ci).toMatch(/^on:$/m);
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(ci).toMatch(/^jobs:$/m);

    for (const line of ci.split("\n")) {
      const indentation = line.match(/^ */)?.[0].length ?? 0;
      expect(indentation % 2, `odd indentation in: ${line}`).toBe(0);
    }
  });

  it("runs for pull requests and pushes to master", () => {
    expect(ci).toMatch(/^on:\n {2}pull_request:\s*\n {2}push:\n {4}branches: \[master\]$/m);
  });

  it("defines the quality job on the required Node versions", () => {
    expect(ci).toMatch(/^ {2}quality:\n {4}runs-on: ubuntu-latest$/m);

    const nodeMatrix = ci.match(/^ {8}node: \[([^\]]+)\]$/m);
    expect(nodeMatrix).not.toBeNull();
    expect(nodeMatrix?.[1].split(",").map((version) => version.trim())).toEqual(["20", "22", "24"]);
  });

  it("runs every quality command in order", () => {
    const commands = [
      "npm ci",
      "npm run lint",
      "npm run format:check",
      "npm run check:invariants",
      "npm test",
      "npm run coverage",
      "npm run build",
    ];
    const positions = commands.map((command) => ci.indexOf(command));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("enforces the frozen passing-test floor", () => {
    expect(ci).toMatch(/name: Enforce passing-test floor/);
    expect(ci).toMatch(/if \(\( passed < 1414 \)\); then/);
    expect(ci).toMatch(/passed/);
    expect(ci).toMatch(/exit 1/);
  });

  it("does not expose repository secrets to pull requests", () => {
    // Pull-request workflows using repository secrets enable credential exfiltration from forks.
    expect(ci).not.toContain("secrets.");
  });

  it("pins every action to an immutable commit", () => {
    const actionReferences = [...ci.matchAll(/^\s*- uses: (\S+)$/gm)].map((match) => match[1]);

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  it("leaves the publish workflow present", () => {
    expect(existsSync(publishPath)).toBe(true);
  });
});
