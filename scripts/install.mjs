#!/usr/bin/env node

/**
 * Installation script for opencode-anthropic-auth.
 *
 * Installs two things:
 *   1. Plugin  → ~/.config/opencode/plugin/opencode-anthropic-auth.js
 *   2. CLI     → ~/.local/bin/opencode-anthropic-auth
 *
 * Usage:
 *   node scripts/install.mjs link        Symlink both (development)
 *   node scripts/install.mjs copy        Copy both (stable deployment)
 *   node scripts/install.mjs uninstall   Remove both
 */

import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import {
  mkdir,
  symlink,
  unlink,
  rm,
  copyFile,
  chmod,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), "..");
const PLUGIN_NAME = "opencode-anthropic-auth";
const PLUGIN_ENTRY = `${PLUGIN_NAME}.js`;
const CLI_BIN_NAME = "opencode-anthropic-auth";

/**
 * Get the OpenCode plugin directory, respecting XDG_CONFIG_HOME.
 * @returns {string}
 */
function getPluginDir() {
  const configHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "opencode", "plugin");
}

/**
 * Get the user bin directory (~/.local/bin).
 * @returns {string}
 */
function getBinDir() {
  return join(homedir(), ".local", "bin");
}

/**
 * Files to copy in copy mode (relative to PROJECT_ROOT).
 * Excludes tests, scripts, and dev config.
 */
const COPY_FILES = ["index.mjs", "cli.mjs", "package.json"];

/**
 * Get lib source files (skip tests).
 * @returns {string[]} Relative paths like "lib/accounts.mjs"
 */
function getLibFiles() {
  const libDir = join(PROJECT_ROOT, "lib");
  if (!existsSync(libDir)) return [];
  return readdirSync(libDir)
    .filter((f) => f.endsWith(".mjs") && !f.includes(".test."))
    .map((f) => join("lib", f));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bold = (t) => `\x1b[1m${t}\x1b[0m`;
const green = (t) => `\x1b[32m${t}\x1b[0m`;
const yellow = (t) => `\x1b[33m${t}\x1b[0m`;
const red = (t) => `\x1b[31m${t}\x1b[0m`;
const dim = (t) => `\x1b[2m${t}\x1b[0m`;

function printEnvReminder() {
  console.log(yellow("\nRequired: set OPENCODE_DISABLE_DEFAULT_PLUGINS=1 in your environment."));
  console.log(dim("Without this, OpenCode's built-in auth plugin will conflict with this one."));
  console.log(dim(`  export OPENCODE_DISABLE_DEFAULT_PLUGINS=1`));
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
 * Copy both plugin and CLI for stable deployment.
 */
async function cmdCopy() {
  console.log(bold("Copying opencode-anthropic-auth...\n"));

  // --- Plugin ---
  const pluginDir = getPluginDir();
  const pluginEntry = join(pluginDir, PLUGIN_ENTRY);
  const copyDir = join(pluginDir, PLUGIN_NAME);

  await mkdir(pluginDir, { recursive: true });

  // Remove old copy if present
  if (existsSync(copyDir)) {
    console.log(dim("Plugin: removing previous copy..."));
    await rm(copyDir, { recursive: true, force: true });
  }

  // Remove old entry symlink/file if present
  if (existsSync(pluginEntry)) {
    await unlink(pluginEntry);
  }

  // Create copy directory structure
  await mkdir(join(copyDir, "lib"), { recursive: true });

  // Copy files
  const filesToCopy = [...COPY_FILES, ...getLibFiles()];
  for (const file of filesToCopy) {
    const src = join(PROJECT_ROOT, file);
    const dest = join(copyDir, file);
    await copyFile(src, dest);
  }

  console.log(dim(`Plugin: copied ${filesToCopy.length} files.`));

  // Install production dependencies in the copy
  console.log(dim("Plugin: installing production dependencies..."));
  try {
    execSync("npm install --omit=dev --ignore-scripts", {
      cwd: copyDir,
      stdio: "pipe",
    });
  } catch (err) {
    console.error(red("Plugin: failed to install dependencies:"));
    console.error(err.stderr?.toString() || err.message);
    await rm(copyDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Create entry point symlink (relative)
  await symlink(join(PLUGIN_NAME, "index.mjs"), pluginEntry);

  console.log(green("Plugin: copied."));
  console.log(dim(`  ${shortPath(copyDir)}/`));
  console.log(dim(`  ${shortPath(pluginEntry)} -> ${PLUGIN_NAME}/index.mjs`));

  // --- CLI ---
  const binDir = getBinDir();
  const cliBin = join(binDir, CLI_BIN_NAME);

  await mkdir(binDir, { recursive: true });

  // Copy cli.mjs as the binary
  // The copied CLI needs to resolve imports from the copied plugin dir
  // So we symlink to the copy's cli.mjs instead of copying standalone
  const cliTarget = join(copyDir, "cli.mjs");

  if (existsSync(cliBin)) {
    await unlink(cliBin);
  }
  await symlink(cliTarget, cliBin);

  console.log(green("CLI: installed."));
  console.log(dim(`  ${shortPath(cliBin)} -> ${shortPath(cliTarget)}`));

  console.log(dim("\nThis is a snapshot. Re-run to update."));

  // Check if ~/.local/bin is on PATH
  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(binDir)) {
    console.log(yellow(`\nNote: ${shortPath(binDir)} is not on your PATH.`));
    console.log(dim(`Add to your shell profile:  export PATH="${shortPath(binDir)}:$PATH"`));
  }

  printEnvReminder();
}

/**
 * Remove both plugin and CLI.
 */
async function cmdUninstall() {
  console.log(bold("Uninstalling opencode-anthropic-auth...\n"));

  let removed = false;

  // Plugin entry point
  const pluginDir = getPluginDir();
  const pluginEntry = join(pluginDir, PLUGIN_ENTRY);
  if (await removePath(pluginEntry, "Plugin")) removed = true;

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

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
`);
    process.exit(command ? 1 : 0);
}
