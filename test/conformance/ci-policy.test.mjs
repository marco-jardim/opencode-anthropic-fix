import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const ciPath = resolve(repositoryRoot, ".github/workflows/ci.yml");
const publishPath = resolve(repositoryRoot, ".github/workflows/publish.yml");
const operationsDocumentationPath = resolve(repositoryRoot, "docs/ci.md");
const ciExists = existsSync(ciPath);
const ci = ciExists ? readFileSync(ciPath, "utf8") : "";
const publishExists = existsSync(publishPath);
const publish = publishExists ? readFileSync(publishPath, "utf8") : "";
const operationsDocumentationExists = existsSync(operationsDocumentationPath);
const operationsDocumentation = operationsDocumentationExists ? readFileSync(operationsDocumentationPath, "utf8") : "";
const publishCondition =
  "if: steps.version_check.outputs.changed == 'true' || github.event_name == 'workflow_dispatch'";

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
    expect(publishExists).toBe(true);
  });
});

describe("npm publish workflow policy", () => {
  it("runs the complete quality gate before publication", () => {
    const commands = ["npm ci", "npm run lint", "npm run check:invariants", "npm test", "npm run build"];
    const positions = commands.map((command) => publish.indexOf(command));
    const firstPublish = publish.indexOf("npm publish");

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(firstPublish).toBeGreaterThan(Math.max(...positions));

    for (const position of [...positions, firstPublish]) {
      const stepStart = publish.lastIndexOf("\n      - ", position);
      const nextStep = publish.indexOf("\n      - ", position);
      const step = publish.slice(stepStart, nextStep < 0 ? undefined : nextStep);

      expect(step).toContain(publishCondition);
    }
  });

  it("gates the only publish step and selects an exhaustive dist-tag", () => {
    const publishCommands = [...publish.matchAll(/^\s*npm publish[^\n]+$/gm)].map((match) => match[0].trim());

    expect(publishCommands).toEqual([
      "npm publish --access public --tag beta",
      "npm publish --access public --tag latest",
    ]);
    expect(publish).toMatch(
      /- name: Publish package\n {8}if: steps\.version_check\.outputs\.changed == 'true' \|\| github\.event_name == 'workflow_dispatch'\n {8}shell: bash\n {8}run: \|\n {10}set -euo pipefail/,
    );
    expect(publish).toMatch(
      /version=\$\(node -p "require\('\.\/package\.json'\)\.version"\)[\s\S]*if \[\[ -z "\$version" \|\| "\$version" == "undefined" \|\| "\$version" == "null" \]\]; then[\s\S]*exit 1[\s\S]*if \[\[ "\$version" == \*-\* \]\]; then\n {12}npm publish --access public --tag beta\n {10}else\n {12}npm publish --access public --tag latest\n {10}fi/,
    );
  });

  it.each([
    { version: "0.3.0-beta.0", expectedTag: "beta" },
    { version: "0.2.1", expectedTag: "latest" },
    { version: "1.0.0", expectedTag: "latest" },
    { version: "1.0.0-rc.1", expectedTag: "beta" },
  ])("classifies $version as $expectedTag", ({ version, expectedTag }) => {
    const expression = publish.match(/version=\$\(node -p "([^"]+)"\)/)?.[1];
    expect(expression).toBe("require('./package.json').version");

    const fixtureDirectory = mkdtempSync(resolve(tmpdir(), "publish-policy-"));

    try {
      writeFileSync(resolve(fixtureDirectory, "package.json"), JSON.stringify({ version }));
      const parsedVersion = execFileSync(process.execPath, ["-p", expression], {
        cwd: fixtureDirectory,
        encoding: "utf8",
      }).trim();
      const tag = parsedVersion.includes("-") ? "beta" : "latest";

      expect(tag, version).toBe(expectedTag);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("pins every action to an immutable commit", () => {
    const actionReferences = [...publish.matchAll(/^\s*- uses: (\S+)$/gm)].map((match) => match[1]);

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});

describe("CI and prerelease documentation policy", () => {
  it("documents the quality gate and safe prerelease operations", () => {
    expect(operationsDocumentationExists).toBe(true);

    for (const command of [
      "npm ci",
      "npm run lint",
      "npm run format:check",
      "npm run check:invariants",
      "npm test",
      "npm run coverage",
      "npm run build",
    ]) {
      expect(operationsDocumentation).toContain(command);
    }

    expect(operationsDocumentation).toMatch(/passing-test floor[^\n]*1414/i);
    expect(operationsDocumentation).toMatch(/hyphenated version[^\n]*`beta`/i);
    expect(operationsDocumentation).toMatch(/prerelease[^\n]*must never[^\n]*`latest`/i);
    expect(operationsDocumentation).toMatch(/human[^\n]*approval/i);
  });
});
