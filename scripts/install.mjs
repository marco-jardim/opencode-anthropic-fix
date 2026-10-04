#!/usr/bin/env node

/**
 * Installation script for opencode-anthropic-auth.
 *
 * Installs two things:
 *   1. Plugin  → ~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js
 *   2. CLI     → ~/.local/bin/opencode-anthropic-auth
 *
 * Usage:
 *   node scripts/install.mjs link        Symlink both (development)
 *   node scripts/install.mjs copy        Copy both (stable deployment)
 *   node scripts/install.mjs uninstall   Remove both
 *   node scripts/install.mjs link --host=v2  Link the dual-host package
 *   node scripts/install.mjs copy --host=v2  Copy the bundled dual-host package
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import {
  mkdir,
  symlink,
  unlink,
  rm,
  copyFile,
  chmod,
  readFile,
  writeFile,
  readdir,
  lstat,
  rmdir,
} from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";

import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), "..");
const PLUGIN_NAME = "opencode-anthropic-auth";
const PLUGIN_ENTRY = "opencode-anthropic-auth-plugin.js";
const CLI_BIN_NAME = "opencode-anthropic-auth";

/**
 * Get the OpenCode plugin directory, respecting XDG_CONFIG_HOME.
 * @returns {string}
 */
function getPluginDir() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "opencode", "plugin");
}

/**
 * Get the user bin directory (~/.local/bin).
 * @returns {string}
 */
function getBinDir() {
  return join(homedir(), ".local", "bin");
}

const DIST_DIR = join(PROJECT_ROOT, "dist");
const PACKAGE_NAME = "opencode-anthropic-fix";
const PACKAGE_FILES = [
  "index.mjs",
  "server.mjs",
  "tui.mjs",
  "cli.mjs",
  "rpc.mjs",
  "package.json",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bold = (t) => `\x1b[1m${t}\x1b[0m`;
const green = (t) => `\x1b[32m${t}\x1b[0m`;
const yellow = (t) => `\x1b[33m${t}\x1b[0m`;
const red = (t) => `\x1b[31m${t}\x1b[0m`;
const dim = (t) => `\x1b[2m${t}\x1b[0m`;

function printEnvReminder() {
  console.log(yellow("\nNote: if using OpenCode v1.1.52 or earlier, set OPENCODE_DISABLE_DEFAULT_PLUGINS=1"));
  console.log(dim("This is not needed on newer versions where user plugins take priority."));
}

function shortPath(p) {
  const home = homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/**
 * Check what currently exists at a path.
 * @param {string} path
 * @returns {{ exists: boolean, isSymlink: boolean, target: string | null, isDir: boolean }}
 */
function checkExisting(path) {
  if (!existsSync(path)) {
    return { exists: false, isSymlink: false, target: null, isDir: false };
  }
  const stat = lstatSync(path);
  const isSymlink = stat.isSymbolicLink();
  let target = null;
  if (isSymlink) {
    try {
      target = readlinkSync(path);
    } catch {
      // ignore
    }
  }
  return { exists: true, isSymlink, target, isDir: stat.isDirectory() };
}

/**
 * Create or replace a symlink.
 * @param {string} target - What the symlink points to
 * @param {string} linkPath - Where the symlink lives
 * @param {string} label - Human-readable name for logging
 * @returns {Promise<boolean>} true if created, false if already correct
 */
async function ensureSymlink(target, linkPath, label) {
  await mkdir(dirname(linkPath), { recursive: true });

  const existing = checkExisting(linkPath);

  if (existing.exists) {
    if (existing.isSymlink && existing.target === target) {
      console.log(green(`${label}: already linked.`));
      console.log(dim(`  ${shortPath(linkPath)} -> ${shortPath(target)}`));
      return false;
    }

    if (existing.isSymlink) {
      console.log(yellow(`${label}: replacing symlink (was -> ${existing.target})`));
    } else if (existing.isDir) {
      console.log(yellow(`${label}: replacing directory`));
      await rm(linkPath, { recursive: true, force: true });
    } else {
      console.log(yellow(`${label}: replacing existing file`));
    }
    if (!existing.isDir) await unlink(linkPath);
  }

  await symlink(target, linkPath);
  console.log(green(`${label}: linked.`));
  console.log(dim(`  ${shortPath(linkPath)} -> ${shortPath(target)}`));
  return true;
}

/**
 * Remove a path (symlink, file, or directory).
 * @param {string} path
 * @param {string} label
 * @returns {Promise<boolean>} true if something was removed
 */
async function removePath(path, label) {
  // Use lstatSync to detect broken symlinks (existsSync returns false for them)
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }

  if (stat.isDirectory()) {
    await rm(path, { recursive: true, force: true });
    console.log(green(`${label}: removed directory ${shortPath(path)}/`));
  } else {
    await unlink(path);
    const kind = stat.isSymbolicLink() ? "symlink" : "file";
    console.log(green(`${label}: removed ${kind} ${shortPath(path)}`));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Symlink both plugin and CLI for development.
 */
async function cmdLink() {
  console.log(bold("Linking opencode-anthropic-auth...\n"));

  // Plugin: symlink entry point
  const pluginDir = getPluginDir();
  const pluginEntry = join(pluginDir, PLUGIN_ENTRY);
  const pluginTarget = join(PROJECT_ROOT, "index.mjs");

  // Clean up old-named entry if present
  const oldEntry = join(pluginDir, "opencode-anthropic-auth.js");
  if (existsSync(oldEntry) && oldEntry !== pluginEntry) {
    await unlink(oldEntry);
    console.log(dim("Plugin: removed old opencode-anthropic-auth.js"));
  }

  await ensureSymlink(pluginTarget, pluginEntry, "Plugin");

  // CLI: symlink to cli.mjs
  const binDir = getBinDir();
  const cliBin = join(binDir, CLI_BIN_NAME);
  const cliTarget = join(PROJECT_ROOT, "cli.mjs");
  await ensureSymlink(cliTarget, cliBin, "CLI");

  console.log(dim("\nEdits to source files take effect immediately."));

  // Check if ~/.local/bin is on PATH
  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(binDir)) {
    console.log(yellow(`\nNote: ${shortPath(binDir)} is not on your PATH.`));
    console.log(dim(`Add to your shell profile:  export PATH="${shortPath(binDir)}:$PATH"`));
  }

  printEnvReminder();
}

/**
 * Copy bundled plugin and CLI for stable deployment.
 * Requires `npm run build` first (install:copy runs it automatically).
 */
async function cmdCopy() {
  console.log(bold("Copying opencode-anthropic-auth...\n"));

  const pluginSrc = join(DIST_DIR, "opencode-anthropic-auth-plugin.js");
  const cliSrc = join(DIST_DIR, "opencode-anthropic-auth-cli.mjs");

  if (!existsSync(pluginSrc) || !existsSync(cliSrc)) {
    console.error(red("dist/ not found. Run `npm run build` first."));
    process.exit(1);
  }

  // --- Plugin: single file copy ---
  const pluginDir = getPluginDir();
  const pluginDest = join(pluginDir, PLUGIN_ENTRY);

  await mkdir(pluginDir, { recursive: true });

  // Clean up old multi-file copy directory if present
  const oldCopyDir = join(pluginDir, PLUGIN_NAME);
  if (existsSync(oldCopyDir)) {
    await rm(oldCopyDir, { recursive: true, force: true });
    console.log(dim("Plugin: removed old copy directory."));
  }

  if (existsSync(pluginDest)) await unlink(pluginDest);
  await copyFile(pluginSrc, pluginDest);

  console.log(green("Plugin: copied."));
  console.log(dim(`  ${shortPath(pluginDest)}`));

  // --- CLI: single file copy ---
  const binDir = getBinDir();
  const cliBin = join(binDir, CLI_BIN_NAME);

  await mkdir(binDir, { recursive: true });
  if (existsSync(cliBin)) await unlink(cliBin);
  await copyFile(cliSrc, cliBin);
  await chmod(cliBin, 0o755);

  console.log(green("CLI: copied."));
  console.log(dim(`  ${shortPath(cliBin)}`));

  console.log(dim("\nThis is a snapshot. Re-run to update."));

  // Check if ~/.local/bin is on PATH
  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(binDir)) {
    console.log(yellow(`\nNote: ${shortPath(binDir)} is not on your PATH.`));
    console.log(dim(`Add to your shell profile:  export PATH="${shortPath(binDir)}:$PATH"`));
  }
}

/**
 * Remove both plugin and CLI.
 */
async function cmdUninstall() {
  console.log(bold("Uninstalling opencode-anthropic-auth...\n"));

  let removed = false;

  // Plugin entry point (current and old name)
  const pluginDir = getPluginDir();
  const pluginEntry = join(pluginDir, PLUGIN_ENTRY);
  if (await removePath(pluginEntry, "Plugin")) removed = true;
  const oldEntry = join(pluginDir, "opencode-anthropic-auth.js");
  if (await removePath(oldEntry, "Plugin (old name)")) removed = true;

  // Plugin copy directory
  const copyDir = join(pluginDir, PLUGIN_NAME);
  if (await removePath(copyDir, "Plugin")) removed = true;

  // CLI binary
  const binDir = getBinDir();
  const cliBin = join(binDir, CLI_BIN_NAME);
  if (await removePath(cliBin, "CLI")) removed = true;

  // Also clean up any old npm link global install
  const npmGlobal = join("/opt/homebrew/bin", "anthropic-auth");
  if (await removePath(npmGlobal, "CLI (old npm link)")) removed = true;

  if (!removed) {
    console.log(dim("Nothing to remove. Not installed."));
  } else {
    console.log(dim("\nUninstalled."));
  }
}

// The explicit v2 mode installs a package, never files in the automatic plugin
// discovery directory. A helper export discovered as a plugin breaks both
// loaders, and the server and TUI have separate entrypoints.
function getPackageDir() {
  return join(dirname(getPluginDir()), "node_modules", PACKAGE_NAME);
}

async function pathStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Refuse to recursively replace an npm install or an unrelated directory. */
async function managedPackageState() {
  const destination = getPackageDir();
  const stat = await pathStat(destination);
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "link";
  if (!stat.isDirectory()) throw new Error(`Refusing to replace a non-directory package: ${destination}`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`Package directory is not managed by this installer: ${destination}`, { cause: error });
  }
  if (manifest.name !== PACKAGE_NAME || manifest.opencodeAnthropicInstaller !== 1) {
    throw new Error(`Package directory is not managed by this installer: ${destination}`);
  }
  const names = await readdir(destination);
  for (const name of names) {
    const child = await lstat(join(destination, name));
    if (!PACKAGE_FILES.includes(name) || !child.isFile() || child.isSymbolicLink()) {
      throw new Error(`Package directory contains an unmanaged entry: ${join(destination, name)}`);
    }
  }
  return "copy";
}

async function removeManagedPackage() {
  const state = await managedPackageState();
  const destination = getPackageDir();
  if (state === "link") await unlink(destination);
  if (state === "copy") {
    // Only the inventoried flat bundle files are removed; never recursive rm.
    for (const name of await readdir(destination)) await unlink(join(destination, name));
    await rmdir(destination);
  }
  return state !== "missing";
}

function packageCliBin() {
  return join(getBinDir(), CLI_BIN_NAME + (process.platform === "win32" ? ".cmd" : ""));
}

/** Check ownership before changing either the package or its CLI entry. */
async function managedCliState() {
  const destination = packageCliBin();
  const stat = await pathStat(destination);
  if (!stat) return false;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error(`Refusing to replace a CLI directory: ${destination}`);
  }
  let managed = false;
  if (stat.isSymbolicLink()) {
    const target = resolve(dirname(destination), readlinkSync(destination));
    const within = relative(getPackageDir(), target);
    managed = within !== "" && !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`);
  } else if (stat.isFile()) {
    managed = /^(?:rem|#) opencode-anthropic-fix installer\r?$/m.test(await readFile(destination, "utf8"));
  }
  if (!managed && !force) {
    throw new Error(`CLI is not managed by this installer: ${destination}. Use --force to replace or remove it.`);
  }
  return true;
}

async function installPackageCli() {
  const destination = packageCliBin();
  const target = join(getPackageDir(), "cli.mjs");
  const existing = await managedCliState();
  await mkdir(dirname(destination), { recursive: true });
  if (existing) await unlink(destination);
  if (process.platform === "win32") {
    await writeFile(
      destination,
      `@echo off\r\nrem ${PACKAGE_NAME} installer\r\nnode "${target.replaceAll("%", "%%")}" %*\r\n`,
    );
  } else {
    await symlink(target, destination);
    await chmod(target, 0o755);
  }
  console.log(green(`CLI: installed ${shortPath(destination)}`));
}

async function reportPackageConfig() {
  const stale = [];
  for (const name of [PLUGIN_ENTRY, "opencode-anthropic-auth.js", PLUGIN_NAME]) {
    const path = join(getPluginDir(), name);
    if (await pathStat(path)) stale.push(path);
  }
  if (stale.length) {
    console.log(
      yellow("\nRemove these previous plugin entries before enabling the package to avoid duplicate loading:"),
    );
    for (const path of stale) console.log(`  ${path}`);
  }
  console.log("\nAdd this package to OpenCode v2 configuration (opencode.json / opencode.jsonc):");
  // An explicit path also works outside the config directory's module lookup
  // and makes the same package's ./server and ./tui exports discoverable.
  console.log(JSON.stringify({ plugins: [getPackageDir()] }, null, 2));
  console.log("The installer did not change your configuration. Restart OpenCode after installation.");
}

async function cmdPackage(command) {
  const destination = getPackageDir();
  const existingCli = await managedCliState();
  if (command === "uninstall") {
    const removed = await removeManagedPackage();
    const bin = packageCliBin();
    if (existingCli) await unlink(bin);
    console.log(removed ? "Dual-host package removed." : "Dual-host package is not installed.");
    console.log("Remove its plugins entry from your OpenCode configuration if present.");
    return;
  }

  await managedPackageState();
  if (command === "copy") {
    const source = join(DIST_DIR, PACKAGE_NAME);
    for (const name of PACKAGE_FILES) {
      if (!(await pathStat(join(source, name)))?.isFile()) {
        throw new Error("Dual-host bundle not found. Run `npm run build` first.");
      }
    }
    await removeManagedPackage();
    await mkdir(destination, { recursive: true });
    for (const name of PACKAGE_FILES) await copyFile(join(source, name), join(destination, name));
    console.log(green(`Dual-host package copied to ${shortPath(destination)}`));
  } else {
    await removeManagedPackage();
    await mkdir(dirname(destination), { recursive: true });
    await symlink(PROJECT_ROOT, destination, process.platform === "win32" ? "junction" : "dir");
    console.log(green(`Dual-host package linked: ${shortPath(destination)} -> ${PROJECT_ROOT}`));
  }
  await installPackageCli();
  await reportPackageConfig();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];
const options = process.argv.slice(3);
if (
  options.some((option) => !["--host=v1", "--host=v2", "--force"].includes(option)) ||
  options.filter((option) => option.startsWith("--host=")).length > 1
) {
  console.error("Expected at most one host option: --host=v1 or --host=v2, and optional --force.");
  process.exit(1);
}
const packageMode = options.includes("--host=v2");
const force = options.includes("--force");
if (force && !packageMode) {
  console.error("--force is only supported with --host=v2.");
  process.exit(1);
}

if (packageMode && ["link", "copy", "uninstall"].includes(command)) {
  try {
    await cmdPackage(command);
  } catch (error) {
    console.error(red(error.message));
    process.exitCode = 1;
  }
} else {
  switch (command) {
    case "link":
      await cmdLink();
      break;
    case "copy":
      await cmdCopy();
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    default:
      console.log(`${bold("Installer for opencode-anthropic-auth")}

${dim("Installs:")}
  Plugin  ${dim("->")}  ~/.config/opencode/plugin/${PLUGIN_ENTRY}
  CLI     ${dim("->")}  ~/.local/bin/${CLI_BIN_NAME}

${dim("Usage:")}
  node scripts/install.mjs ${bold("link")}         Symlink both (development)
  node scripts/install.mjs ${bold("copy")}         Copy both (stable deployment)
  node scripts/install.mjs ${bold("uninstall")}    Remove both

Add ${bold("--host=v2")} to install/remove the dual-host package under config/node_modules.
The v2 mode prints configuration instructions without editing your configuration.
Add ${bold("--force")} with --host=v2 to replace/remove a foreign CLI file or symlink.
CLI directories and unmanaged package directories are never force-deleted.
`);
      process.exit(command ? 1 : 0);
  }
}
