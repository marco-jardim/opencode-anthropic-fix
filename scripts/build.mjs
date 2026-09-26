#!/usr/bin/env node

/**
 * Bundle plugin and CLI into self-contained single files.
 *
 *   dist/opencode-anthropic-auth-plugin.js  — plugin (no external deps)
 *   dist/opencode-anthropic-auth-cli.mjs    — CLI    (no external deps)
 */

import { build } from "esbuild";

import { getWireCompatPackageVersion } from "../lib/mimicry/wire-compat.mjs";

// Baked into both bundles as `__WIRE_COMPAT_PACKAGE_VERSION__` via esbuild's
// `define` below. esbuild INLINES @tormentalabs/claude-code-wire-compat's
// source into the bundle, so the runtime `import.meta.resolve` in
// `lib/mimicry/wire-compat.mjs`'s `getWireCompatPackageVersion` can no longer
// find a separate node_modules entry to read a version off of once bundled --
// calling the SAME function here, unbundled, while `node_modules` still
// exists as a real resolvable install, is how the actually-installed version
// gets captured before that information disappears into the bundle. Never
// throws: worst case this resolves to "unknown", exactly like the runtime
// fallback would.
const wireCompatPackageVersion = getWireCompatPackageVersion();

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Node builtins stay as imports
  external: ["node:*"],
  define: {
    __WIRE_COMPAT_PACKAGE_VERSION__: JSON.stringify(wireCompatPackageVersion),
  },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["index.mjs"],
    outfile: "dist/opencode-anthropic-auth-plugin.js",
  }),
  build({
    ...shared,
    entryPoints: ["cli.mjs"],
    outfile: "dist/opencode-anthropic-auth-cli.mjs",
  }),
]);

console.log("Built dist/opencode-anthropic-auth-plugin.js and dist/opencode-anthropic-auth-cli.mjs");
