#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHANGELOG_VERSION_PATTERN = /^##\s*\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/m;
const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ANALYSIS_FILENAME_PATTERN = /^claude-code-(\d+\.\d+\.\d+)-analysis\.md$/;

/**
 * Extract the newest version heading from a reverse-chronological changelog.
 *
 * @param {string} contents
 * @returns {string | null}
 */
export function extractChangelogVersion(contents) {
  return contents.match(CHANGELOG_VERSION_PATTERN)?.[1] ?? null;
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersions(left, right) {
  const [leftRelease, leftPrerelease = ""] = splitPrerelease(left);
  const [rightRelease, rightPrerelease = ""] = splitPrerelease(right);
  const leftParts = leftRelease.split(".").map(Number);
  const rightParts = rightRelease.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }

  // Semver: a release outranks any prerelease of the same three-part version, so
  // a `0.3.0` changelog head is AHEAD of a `0.3.0-beta.0` package version rather
  // than equal to it. Equal prerelease strings compare equal, which is the case
  // this project actually ships (`## [0.3.0-beta.0]` against `0.3.0-beta.0`).
  if (leftPrerelease === rightPrerelease) {
    return 0;
  }
  if (leftPrerelease === "") {
    return 1;
  }
  if (rightPrerelease === "") {
    return -1;
  }
  return leftPrerelease < rightPrerelease ? -1 : 1;
}

/**
 * Split a semver string into its three-part release and its prerelease suffix.
 *
 * @param {string} version
 * @returns {[string, string]}
 */
function splitPrerelease(version) {
  const separator = version.indexOf("-");
  return separator === -1 ? [version, ""] : [version.slice(0, separator), version.slice(separator + 1)];
}

/**
 * @param {string} filePath
 * @param {string} label
 * @param {string[]} warnings
 * @param {string[]} errors
 * @returns {string | null}
 */
function readOptionalFile(filePath, label, warnings, errors) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      warnings.push(`${label} is missing; check skipped`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`could not read ${label}: ${message}`);
    }
    return null;
  }
}

/**
 * Check release, mimicry, naming, and workspace invariants.
 * Missing source-of-truth files produce warnings so partial fixtures remain usable.
 *
 * @param {{ cwd: string }} options
 * @returns {{ ok: boolean, warnings: string[], errors: string[] }}
 */
export function runChecks({ cwd }) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const errors = [];

  const packageContents = readOptionalFile(path.join(cwd, "package.json"), "package.json", warnings, errors);
  const changelogContents = readOptionalFile(path.join(cwd, "CHANGELOG.md"), "CHANGELOG.md", warnings, errors);

  /** @type {string | null} */
  let packageVersion = null;
  if (packageContents !== null) {
    try {
      const packageData = JSON.parse(packageContents);
      if (typeof packageData.version === "string" && PACKAGE_VERSION_PATTERN.test(packageData.version)) {
        packageVersion = packageData.version;
      } else {
        errors.push("package.json version is missing or is not a three-part version");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`could not parse package.json: ${message}`);
    }
  }

  const changelogVersion = changelogContents === null ? null : extractChangelogVersion(changelogContents);
  if (changelogContents !== null && changelogVersion === null) {
    errors.push("CHANGELOG.md has no version heading");
  }

  if (packageVersion !== null && changelogVersion !== null) {
    const comparison = compareVersions(changelogVersion, packageVersion);
    if (comparison < 0) {
      warnings.push(`CHANGELOG head ${changelogVersion} is behind package.json ${packageVersion}`);
    } else if (comparison > 0) {
      errors.push(`CHANGELOG head ${changelogVersion} is ahead of package.json ${packageVersion}`);
    }
  }

  /** @type {string | null} */
  let newestAnalysisVersion = null;
  const docsPath = path.join(cwd, "docs");
  try {
    const analysisVersions = fs
      .readdirSync(docsPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.match(ANALYSIS_FILENAME_PATTERN)?.[1] ?? null)
      .filter((version) => version !== null)
      .sort(compareVersions);

    newestAnalysisVersion = analysisVersions.at(-1) ?? null;
    if (newestAnalysisVersion === null) {
      warnings.push("no Claude Code analysis docs found; mimicry baseline check skipped");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      warnings.push("docs directory is missing; mimicry baseline checks skipped");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`could not enumerate Claude Code analysis docs: ${message}`);
    }
  }

  // The mimicry baseline lives in the wire package's profile, and the adapter
  // seam is the only place allowed to name it (see
  // test/conformance/package-dependency-policy.test.mjs). The profile symbol
  // encodes the CLI version, so the baseline is readable from the import alone.
  const wireCompatContents = readOptionalFile(
    path.join(cwd, "lib", "mimicry", "wire-compat.mjs"),
    "lib/mimicry/wire-compat.mjs",
    warnings,
    errors,
  );
  const profileSymbol = wireCompatContents?.match(/CLAUDE_CODE_(\d+)_(\d+)_(\d+)_PROFILE/);
  const pluginVersion = profileSymbol ? profileSymbol.slice(1).join(".") : null;
  if (wireCompatContents !== null && pluginVersion === null) {
    errors.push("no CLAUDE_CODE_<x>_<y>_<z>_PROFILE import was found in lib/mimicry/wire-compat.mjs");
  }

  if (pluginVersion !== null && newestAnalysisVersion !== null && pluginVersion !== newestAnalysisVersion) {
    errors.push(`plugin reports CC ${pluginVersion} but newest analysis doc is ${newestAnalysisVersion}`);
  }

  const reverseEngineeringContents = readOptionalFile(
    path.join(cwd, "docs", "claude-code-reverse-engineering.md"),
    "docs/claude-code-reverse-engineering.md",
    warnings,
    errors,
  );
  const reverseEngineeringVersion = reverseEngineeringContents?.match(/Current baseline:\s*([\d.]+)/)?.[1] ?? null;
  if (reverseEngineeringContents !== null && reverseEngineeringVersion === null) {
    errors.push("Current baseline was not found in docs/claude-code-reverse-engineering.md");
  }
  if (
    reverseEngineeringVersion !== null &&
    newestAnalysisVersion !== null &&
    reverseEngineeringVersion !== newestAnalysisVersion
  ) {
    warnings.push(
      `reverse-engineering baseline ${reverseEngineeringVersion} differs from newest analysis doc ${newestAnalysisVersion}`,
    );
  }

  const agentsContents = readOptionalFile(path.join(cwd, "AGENTS.md"), "AGENTS.md", warnings, errors);
  if (agentsContents !== null && /"Claude Code"\s*(?:->|→)\s*"Claude Code"/.test(agentsContents)) {
    errors.push("AGENTS.md contains the broken Claude Code naming artifact");
  }

  try {
    const hasStrayNul = fs
      .readdirSync(cwd, { withFileTypes: true })
      .some((entry) => entry.name === "nul" && entry.isFile());
    if (hasStrayNul) {
      errors.push("stray 'nul' file present");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`could not inspect working directory for stray 'nul' file: ${message}`);
  }

  return { ok: errors.length === 0, warnings, errors };
}

/**
 * @param {{ ok: boolean, warnings: string[], errors: string[] }} result
 */
function printReport(result) {
  const checks = [
    {
      name: "Version vs CHANGELOG",
      matches: (message) => /package\.json|CHANGELOG/.test(message),
    },
    {
      name: "Mimicry baseline",
      matches: (message) => /wire-compat|_PROFILE|analysis docs|plugin reports CC|docs directory/.test(message),
    },
    {
      name: "Reverse-engineering baseline",
      matches: (message) => /reverse-engineering|Current baseline|docs directory/.test(message),
    },
    { name: "AGENTS.md naming guard", matches: (message) => /AGENTS\.md/.test(message) },
    { name: "Stray-file guard", matches: (message) => /'nul'/.test(message) },
  ];

  for (const check of checks) {
    const checkErrors = result.errors.filter(check.matches);
    const checkWarnings = result.warnings.filter(check.matches);
    if (checkErrors.length > 0) {
      console.log(`✗ ${check.name}: ${checkErrors.join("; ")}`);
    } else if (checkWarnings.length > 0) {
      console.log(`⚠ ${check.name}: ${checkWarnings.join("; ")}`);
    } else {
      console.log(`✓ ${check.name}`);
    }
  }

  const status = result.ok ? "PASS" : "FAIL";
  console.log(
    `Summary: ${status} (${result.errors.length} error${result.errors.length === 1 ? "" : "s"}, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`,
  );
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const result = runChecks({ cwd: process.cwd() });
  printReport(result);
  process.exit(result.ok ? 0 : 1);
}
