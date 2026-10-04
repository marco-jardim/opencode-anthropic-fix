#!/usr/bin/env node

/**
 * Bundle plugin and CLI into self-contained single files.
 *
 *   dist/opencode-anthropic-auth-plugin.js  — plugin (no external deps)
 *   dist/opencode-anthropic-auth-cli.mjs    — CLI    (no external deps)
 *   dist/opencode-anthropic-fix/           — dual-host package, including TUI
 */

import { build } from "esbuild";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputOption = process.argv.slice(2).find((value) => value.startsWith("--outdir="));
const outputRoot = resolve(outputOption ? outputOption.slice("--outdir=".length) : join(projectRoot, "dist"));
const packageRoot = join(outputRoot, "opencode-anthropic-fix");
const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  absWorkingDir: projectRoot,
  metafile: true,
  // Node builtins stay as imports
  external: ["node:*"],
  define: {
    __WIRE_COMPAT_PACKAGE_VERSION__: JSON.stringify(wireCompatPackageVersion),
  },
};

const bundles = await Promise.all([
  build({
    ...shared,
    entryPoints: ["index.mjs"],
    outfile: join(outputRoot, "opencode-anthropic-auth-plugin.js"),
  }),
  build({
    ...shared,
    entryPoints: ["cli.mjs"],
    outfile: join(outputRoot, "opencode-anthropic-auth-cli.mjs"),
  }),
  ...Object.entries({
    index: "index.mjs",
    server: "server.mjs",
    tui: "tui.mjs",
    cli: "cli.mjs",
    rpc: "lib/host/command-rpc.mjs",
  }).map(([name, entry]) => build({ ...shared, entryPoints: [entry], outfile: join(packageRoot, `${name}.mjs`) })),
]);

await mkdir(packageRoot, { recursive: true });
await writeFile(
  join(packageRoot, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      type: "module",
      main: "./index.mjs",
      exports: {
        ".": "./index.mjs",
        "./server": "./server.mjs",
        "./tui": "./tui.mjs",
        "./rpc": "./rpc.mjs",
        "./index.mjs": "./index.mjs",
        "./cli.mjs": "./cli.mjs",
        "./package.json": "./package.json",
      },
      opencodeAnthropicInstaller: 1,
    },
    null,
    2,
  ) + "\n",
);
await Promise.all(["LICENSE", "NOTICE"].map((name) => copyFile(join(projectRoot, name), join(packageRoot, name))));

// Read the licenses of actual bundled inputs instead of maintaining a second,
// inevitably stale dependency list. Dependencies that remain unused are absent
// from the notice; nested node_modules packages retain their own versions.
const packageDirectories = new Set();
for (const bundle of bundles) {
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const normalized = input.replaceAll("\\", "/");
    const matches = [...normalized.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    const match = matches.at(-1);
    if (match) packageDirectories.add(resolve(projectRoot, normalized.slice(0, match.index + match[0].length)));
  }
}
const notices = ["THIRD-PARTY SOFTWARE INCLUDED IN THE STANDALONE BUILDS\n"];
async function dependencyLicenseFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...(await dependencyLicenseFiles(directory, name)));
    } else if (entry.isFile() && /^(?:licen[cs]e|notice)(?:\.[\w.-]+)?$/i.test(entry.name)) {
      files.push(name);
    }
  }
  return files.sort();
}
let includesApache = false;
for (const directory of [...packageDirectories].sort()) {
  const dependency = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const files = await dependencyLicenseFiles(directory);
  includesApache ||= dependency.license === "Apache-2.0";
  if (!files.length && dependency.license !== "Apache-2.0") {
    throw new Error(`Bundled dependency has no license file: ${dependency.name}`);
  }
  notices.push(
    `\n${"=".repeat(72)}\n${dependency.name} ${dependency.version}\nLicense: ${dependency.license ?? "See below"}\n`,
  );
  for (const name of files) {
    notices.push(`\n--- ${name} ---\n${await readFile(join(directory, name), "utf8")}\n`);
  }
}
if (includesApache) {
  notices.push(
    `\n--- Complete Apache-2.0 license text ---\n${await readFile(join(projectRoot, "licenses/Apache-2.0.txt"), "utf8")}\n`,
  );
}
const thirdPartyNotices = notices.join("");
await writeFile(join(packageRoot, "THIRD_PARTY_NOTICES"), thirdPartyNotices);
await writeFile(join(outputRoot, "THIRD_PARTY_NOTICES"), thirdPartyNotices);
const embeddedNotices = `\n${thirdPartyNotices
  .split(/\r?\n/)
  .map((line) => `// ${line}`)
  .join("\n")}\n`;
await Promise.all(
  bundles.flatMap((bundle) =>
    Object.keys(bundle.metafile.outputs).map((output) => appendFile(resolve(projectRoot, output), embeddedNotices)),
  ),
);

console.log(`Built legacy plugin/CLI and dual-host package in ${outputRoot}`);
