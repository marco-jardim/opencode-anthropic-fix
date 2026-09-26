#!/usr/bin/env node

/**
 * Move @tormentalabs/claude-code-wire-compat to the version currently behind
 * the registry `latest` dist-tag, and immediately run the wire-sensitive test
 * surface against the new install, so a routine sync cannot leave a
 * regression undetected.
 *
 * package.json pins the dependency to the `latest` dist-tag (see
 * docs/shared-package-provenance.md); reproducibility lives entirely in
 * package-lock.json. This script is the supported way to move that lock
 * forward -- prefer it over a bare `npm update` so the wire-sensitive tests
 * always run in the same breath as the version bump.
 *
 * Usage: npm run sync:wire-compat
 *
 * Steps:
 *   1. Read the version package-lock.json currently resolves.
 *   2. Run `npm update @tormentalabs/claude-code-wire-compat`. This rewrites
 *      package-lock.json only -- package.json keeps the `latest` specifier.
 *   3. Read the version the lockfile resolves after the update and print
 *      old -> new.
 *   4. Run the wire-sensitive targeted tests
 *      (`vitest run wire-baseline test/conformance`).
 *
 * Exits non-zero if either child process fails, without swallowing its exit
 * code. Does not commit anything -- review the package-lock.json diff (and
 * docs/shared-package-provenance.md, if the package's DEFAULT_PROFILE moved)
 * before committing, per docs/mimicry/wire-compat-divergences.md.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@tormentalabs/claude-code-wire-compat";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

/**
 * Resolve a command for spawnSync so it runs on both platforms without the
 * `shell: true` + argument-array combination Node deprecates (DEP0190). `npm`
 * and `npx` are `.cmd` shims on Windows, which CreateProcess cannot exec
 * directly, so route them through `cmd.exe /c` there; POSIX runs the binary
 * as-is. Every argument passed through this script is a static, hardcoded
 * literal (never host- or user-controlled), so cmd.exe's own command-line
 * join is safe here.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
function forPlatform(command, args) {
  if (!isWindows) return { command, args };
  return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
}

/**
 * @param {string} repoRootPath
 * @returns {string | null}
 */
function readLockedVersion(repoRootPath) {
  const lockPath = path.join(repoRootPath, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    return lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Run a command, streaming its output, and exit this process on failure.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} description
 */
function run(command, args, description) {
  console.log(`> ${description}`);
  const resolved = forPlatform(command, args);
  const result = spawnSync(resolved.command, resolved.args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) {
    console.error(`${description} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${description} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const before = readLockedVersion(repoRoot);

run("npm", ["update", PACKAGE_NAME], `npm update ${PACKAGE_NAME}`);

const after = readLockedVersion(repoRoot);
console.log(`${PACKAGE_NAME}: ${before ?? "(unresolved)"} -> ${after ?? "(unresolved)"}`);

run("npx", ["vitest", "run", "wire-baseline", "test/conformance"], "vitest run wire-baseline test/conformance");

console.log("Sync complete. Review the package-lock.json diff before committing.");
