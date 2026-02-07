#!/usr/bin/env node

/**
 * Bundle plugin and CLI into self-contained single files.
 *
 *   dist/opencode-anthropic-auth-plugin.js  — plugin (no external deps)
 *   dist/opencode-anthropic-auth-cli.mjs    — CLI    (no external deps)
 */

import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Node builtins stay as imports
  external: ["node:*"],
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
