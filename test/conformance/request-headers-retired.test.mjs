/**
 * Guard: lib/request-headers.mjs is retired.
 *
 * Phase 2.3 of the wire-compat migration deleted the module. Its wire-facing
 * content now comes from the shared package through lib/mimicry/wire-compat.mjs
 * (`WIRE_PROFILE`), the host beta policy lives in lib/betas.mjs, and the
 * remaining host-only constants are locals in index.mjs.
 *
 * This test fails if the module — or any of the symbols that only ever existed
 * to shadow the package profile — comes back into live source.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const selfPath = resolve(import.meta.dirname, "request-headers-retired.test.mjs");

const RETIRED_PATTERN = /FALLBACK_CLAUDE_CLI_VERSION|CLI_TO_SDK_VERSION|getSdkVersion|request-headers\.mjs/;

/**
 * Collect every .mjs file under a directory, recursively.
 * @param {string} dir
 * @returns {string[]}
 */
function collectMjs(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectMjs(full));
    } else if (entry.endsWith(".mjs")) {
      found.push(full);
    }
  }
  return found;
}

describe("request-headers retirement", () => {
  it("has no lib/request-headers.mjs on disk", () => {
    expect(existsSync(resolve(repositoryRoot, "lib/request-headers.mjs"))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "lib/request-headers.test.mjs"))).toBe(false);
  });

  it("has no live reference to the retired module or its shadow constants", () => {
    const files = [
      resolve(repositoryRoot, "index.mjs"),
      resolve(repositoryRoot, "cli.mjs"),
      ...collectMjs(resolve(repositoryRoot, "lib")),
    ];

    const offenders = files
      .filter((file) => file !== selfPath)
      .filter((file) => RETIRED_PATTERN.test(readFileSync(file, "utf8")))
      .map((file) => relative(repositoryRoot, file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });
});
