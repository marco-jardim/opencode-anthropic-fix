#!/usr/bin/env node

/**
 * Plugin installation script for opencode-anthropic-auth.
 *
 * Usage:
 *   node scripts/install.mjs link        Symlink plugin into OpenCode (development)
 *   node scripts/install.mjs copy        Copy plugin into OpenCode (stable deployment)
 *   node scripts/install.mjs uninstall   Remove plugin from OpenCode (symlink or copy)
 */

import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import {
  mkdir,
  symlink,
  unlink,
  rm,
  copyFile,
  readdir,
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
const ENTRY_FILE = `${PLUGIN_NAME}.js`;

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

function shortPath(p) {
  const home = homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/**
 * Check what currently exists at the entry point path.
 * @param {string} entryPath
 * @returns {{ exists: boolean, isSymlink: boolean, target: string | null, isDir: boolean }}
 */
function checkExisting(entryPath) {
  if (!existsSync(entryPath)) {
    return { exists: false, isSymlink: false, target: null, isDir: false };
  }
  const stat = lstatSync(entryPath);
  const isSymlink = stat.isSymbolicLink();
  let target = null;
  if (isSymlink) {
    try {
      target = readlinkSync(entryPath);
    } catch {
      // ignore
    }
  }
  return { exists: true, isSymlink, target, isDir: stat.isDirectory() };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Symlink the plugin for development.
 */
async function cmdLink() {
  const pluginDir = getPluginDir();
  const entryPath = join(pluginDir, ENTRY_FILE);
  const targetPath = join(PROJECT_ROOT, "index.mjs");

  // Ensure plugin directory exists
  await mkdir(pluginDir, { recursive: true });

  const existing = checkExisting(entryPath);

  if (existing.exists) {
    if (existing.isSymlink && existing.target === targetPath) {
      console.log(green("Already linked."));
      console.log(dim(`  ${shortPath(entryPath)} -> ${shortPath(targetPath)}`));
      return;
    }

    if (existing.isSymlink) {
      console.log(yellow(`Replacing existing symlink (was -> ${existing.target})`));
      await unlink(entryPath);
    } else {
      console.log(yellow("Replacing existing file at entry point."));
      await unlink(entryPath);
    }
  }

  await symlink(targetPath, entryPath);

  console.log(green("Plugin linked."));
  console.log(dim(`  ${shortPath(entryPath)} -> ${shortPath(targetPath)}`));
  console.log(dim("  Edits to source files take effect immediately."));
}

/**
 * Copy the plugin for stable deployment.
 */
async function cmdCopy() {
  const pluginDir = getPluginDir();
  const entryPath = join(pluginDir, ENTRY_FILE);
  const copyDir = join(pluginDir, PLUGIN_NAME);

  // Ensure plugin directory exists
  await mkdir(pluginDir, { recursive: true });

  // Remove old copy if present
  if (existsSync(copyDir)) {
    console.log(dim("Removing previous copy..."));
    await rm(copyDir, { recursive: true, force: true });
  }

  // Remove old entry symlink/file if present
  if (existsSync(entryPath)) {
    await unlink(entryPath);
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

  console.log(dim(`Copied ${filesToCopy.length} files.`));

  // Install production dependencies in the copy
  console.log(dim("Installing production dependencies..."));
  try {
    execSync("npm install --omit=dev --ignore-scripts", {
      cwd: copyDir,
      stdio: "pipe",
    });
  } catch (err) {
    console.error(red("Failed to install dependencies:"));
    console.error(err.stderr?.toString() || err.message);
    // Clean up on failure
    await rm(copyDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Create entry point symlink
  await symlink(join(PLUGIN_NAME, "index.mjs"), entryPath);

  console.log(green("Plugin copied."));
  console.log(dim(`  ${shortPath(copyDir)}/`));
  console.log(dim(`  ${shortPath(entryPath)} -> ${PLUGIN_NAME}/index.mjs`));
  console.log(dim("  This is a snapshot. Re-run to update."));
}

/**
 * Remove the plugin (symlink or copy).
 */
async function cmdUninstall() {
  const pluginDir = getPluginDir();
  const entryPath = join(pluginDir, ENTRY_FILE);
  const copyDir = join(pluginDir, PLUGIN_NAME);

  let removed = false;

  // Remove entry point (symlink or file)
  if (existsSync(entryPath)) {
    const existing = checkExisting(entryPath);
    await unlink(entryPath);
    if (existing.isSymlink) {
      console.log(green(`Removed symlink: ${shortPath(entryPath)}`));
    } else {
      console.log(green(`Removed file: ${shortPath(entryPath)}`));
    }
    removed = true;
  }

  // Remove copied directory
  if (existsSync(copyDir)) {
    await rm(copyDir, { recursive: true, force: true });
    console.log(green(`Removed directory: ${shortPath(copyDir)}/`));
    removed = true;
  }

  if (!removed) {
    console.log(dim("Nothing to remove. Plugin is not installed."));
  } else {
    console.log(dim("Plugin uninstalled from OpenCode."));
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
    console.log(`${bold("Plugin installer for opencode-anthropic-auth")}

${dim("Usage:")}
  node scripts/install.mjs ${bold("link")}         Symlink plugin (development)
  node scripts/install.mjs ${bold("copy")}         Copy plugin (stable deployment)
  node scripts/install.mjs ${bold("uninstall")}    Remove plugin from OpenCode
`);
    process.exit(command ? 1 : 0);
}
