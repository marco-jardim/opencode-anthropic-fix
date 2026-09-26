#!/usr/bin/env node

/**
 * Detect drift between the @tormentalabs/claude-code-wire-compat version
 * package-lock.json resolves, the version actually installed in
 * node_modules, and the version currently published under the npm `latest`
 * dist-tag.
 *
 * package.json pins the dependency to the `latest` dist-tag (see
 * docs/shared-package-provenance.md), so all reproducibility lives in
 * package-lock.json. A fresh `npm install` does not re-resolve a dist-tag
 * that is already locked -- it just installs what the lock already names --
 * so a lockfile generated before a package release silently keeps this
 * plugin on a stale wire profile until someone remembers to run
 * `npm update`. This script makes that check mechanical instead of relying
 * on memory, both locally (`npm run check:wire-compat-drift`) and in CI.
 *
 * Usage: node scripts/check-wire-compat-drift.mjs [--allow-offline]
 *
 * Exit codes:
 *   0  the lock matches node_modules, and matches the registry's `latest`
 *      dist-tag -- or the registry could not be reached and --allow-offline
 *      was passed (a warning is still printed).
 *   1  drift was detected, or the registry could not be reached and
 *      --allow-offline was not passed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_NAME = "@tormentalabs/claude-code-wire-compat";

/**
 * The version package-lock.json resolves for the dependency, or null if the
 * lockfile is missing or has no entry for it.
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function readLockedVersion(repoRoot) {
  const lockPath = path.join(repoRoot, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  return lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.version ?? null;
}

/**
 * The version actually installed in node_modules, or null if the package is
 * not installed. This is what npm install (not npm ci) can leave stale
 * relative to the lock.
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function readInstalledVersion(repoRoot) {
  const installedPackagePath = path.join(repoRoot, "node_modules", ...PACKAGE_NAME.split("/"), "package.json");
  if (!existsSync(installedPackagePath)) return null;
  const installed = JSON.parse(readFileSync(installedPackagePath, "utf8"));
  return typeof installed.version === "string" ? installed.version : null;
}

/**
 * Query the npm registry for the package's current `latest` dist-tag.
 * Shells out to `npm view` rather than adding an HTTP client dependency --
 * CLAUDE.md forbids a new heavy production dependency, and this is a dev
 * script that already has npm on PATH by construction.
 *
 * @param {string} repoRoot
 * @returns {{ version: string } | { error: string }}
 */
export function fetchRegistryLatest(repoRoot) {
  // npm on Windows is a .cmd shim, which CreateProcess cannot exec directly.
  // Route it through cmd.exe /c there instead of `shell: true`, which Node
  // deprecates (DEP0190) for the argument-array form used below; POSIX runs
  // the binary as-is. The argument list is entirely static and hardcoded,
  // never host- or user-controlled, so cmd.exe's own command-line join is
  // safe here.
  const isWindows = process.platform === "win32";
  const viewArgs = ["view", PACKAGE_NAME, "dist-tags.latest", "--json"];
  const command = isWindows ? "cmd.exe" : "npm";
  const args = isWindows ? ["/d", "/s", "/c", "npm", ...viewArgs] : viewArgs;
  try {
    const stdout = execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return { error: `unexpected npm view output: ${stdout.trim()}` };
    }
    // `npm view <pkg> dist-tags.latest --json` wraps the value in a
    // single-element array on some npm versions (observed on npm 12) and
    // returns the bare value on others. Accept either shape; anything else
    // (no elements, or more than one -- which should not happen for a single
    // dist-tag) is unexpected.
    const value = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : undefined) : parsed;
    if (typeof value !== "string" || value.length === 0) {
      return { error: `unexpected npm view output: ${stdout.trim()}` };
    }
    return { version: value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

/**
 * Pure decision logic, kept free of I/O so it is directly unit-testable.
 *
 * @param {{
 *   lockedVersion: string | null,
 *   installedVersion: string | null,
 *   registryResult: { version: string } | { error: string },
 *   allowOffline: boolean,
 * }} input
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function evaluateDrift({ lockedVersion, installedVersion, registryResult, allowOffline }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (lockedVersion === null) {
    errors.push(`package-lock.json has no resolved entry for ${PACKAGE_NAME}; run npm install`);
  }

  if (installedVersion === null) {
    errors.push(`${PACKAGE_NAME} is not installed in node_modules; run npm install`);
  } else if (lockedVersion !== null && installedVersion !== lockedVersion) {
    errors.push(
      `node_modules has ${PACKAGE_NAME}@${installedVersion} but package-lock.json resolves ${lockedVersion}; run npm install`,
    );
  }

  if ("error" in registryResult) {
    const message = `could not reach the npm registry for ${PACKAGE_NAME}: ${registryResult.error}`;
    if (allowOffline) {
      warnings.push(`${message} (--allow-offline: not treated as drift)`);
    } else {
      errors.push(message);
    }
  } else if (lockedVersion !== null && lockedVersion !== registryResult.version) {
    errors.push(
      `package-lock.json resolves ${PACKAGE_NAME}@${lockedVersion} but the registry's latest dist-tag is ` +
        `${registryResult.version}; run npm run sync:wire-compat`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * @param {{ ok: boolean, errors: string[], warnings: string[] }} result
 * @param {{ lockedVersion: string | null, installedVersion: string | null, registryResult: { version: string } | { error: string } }} readings
 */
function printReport(result, { lockedVersion, installedVersion, registryResult }) {
  console.log(`locked version:    ${lockedVersion ?? "(none)"}`);
  console.log(`installed version: ${installedVersion ?? "(none)"}`);
  console.log(
    `registry latest:   ${"version" in registryResult ? registryResult.version : `(unreachable: ${registryResult.error})`}`,
  );

  for (const warning of result.warnings) console.log(`WARN: ${warning}`);
  for (const error of result.errors) console.log(`FAIL: ${error}`);

  console.log(result.ok ? "OK: no wire-compat drift detected" : "FAIL: wire-compat drift detected");
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const allowOffline = process.argv.includes("--allow-offline");

  const lockedVersion = readLockedVersion(repoRoot);
  const installedVersion = readInstalledVersion(repoRoot);
  const registryResult = fetchRegistryLatest(repoRoot);

  const result = evaluateDrift({ lockedVersion, installedVersion, registryResult, allowOffline });
  printReport(result, { lockedVersion, installedVersion, registryResult });

  process.exit(result.ok ? 0 : 1);
}
