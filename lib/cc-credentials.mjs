/**
 * CC (Claude Code) credential reader.
 *
 * Reads OAuth tokens that Claude Code has already obtained and stored,
 * allowing opencode-anthropic-fix to piggy-back on those tokens instead
 * of maintaining its own OAuth flow.
 *
 * Two sources are supported:
 *   1. macOS Keychain – `security find-generic-password` for services
 *      matching "Claude Code-credentials*"
 *   2. File-based – `~/.claude/.credentials.json`
 *
 * CC accounts MUST NEVER enter the normal OAuth HTTP token-refresh path
 * because the client_id would mismatch and corrupt CC's stored tokens.
 *
 * @module cc-credentials
 */

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * @typedef {'cc-keychain' | 'cc-file'} CCCredentialSource
 */

/**
 * @typedef {object} CCCredential
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt - ms-epoch
 * @property {string} [subscriptionType] - e.g. "claude_pro"
 * @property {CCCredentialSource} source
 * @property {string} label - human-readable label for logging/toasts
 */

// ---------------------------------------------------------------------------
// Keychain reader (macOS only)
// ---------------------------------------------------------------------------

/**
 * List all keychain services matching the CC credential pattern.
 * Returns an array of service names (e.g. "Claude Code-credentials-0").
 *
 * @returns {string[]}
 */
function listKeychainServices() {
  if (process.platform !== "darwin") return [];

  try {
    const dump = execSync("security dump-keychain", {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    /** @type {string[]} */
    const services = [];
    const regex = /"svce"<blob>="(Claude Code-credentials[^"]*)"/g;
    let match;
    while ((match = regex.exec(dump)) !== null) {
      const svc = match[1];
      if (!services.includes(svc)) services.push(svc);
    }
    return services;
  } catch {
    return [];
  }
}

/**
 * Read a single CC credential from macOS Keychain by service name.
 *
 * @param {string} service
 * @returns {CCCredential | null}
 */
function readKeychainService(service) {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return parseCCCredentialData(raw, "cc-keychain", `keychain:${service}`);
  } catch (err) {
    // Exit code 36 = user denied, 44 = not found, 128 = killed
    return null;
  }
}

/**
 * Read all CC credentials stored in the macOS Keychain.
 *
 * @returns {CCCredential[]}
 */
export function readCCCredentialsFromKeychain() {
  const services = listKeychainServices();
  /** @type {CCCredential[]} */
  const credentials = [];

  for (const svc of services) {
    const cred = readKeychainService(svc);
    if (cred) credentials.push(cred);
  }

  return credentials;
}

// ---------------------------------------------------------------------------
// File reader (~/.claude/.credentials.json)
// ---------------------------------------------------------------------------

/**
 * Read CC credentials from the file-based store.
 *
 * The file can have two shapes:
 *   - Wrapped: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }`
 *   - Flat:    `{ accessToken, refreshToken, expiresAt, ... }`
 *
 * Additionally it may be an array of such objects.
 *
 * Entries with `scope: "mcp"` or missing accessToken/refreshToken are filtered.
 *
 * @returns {CCCredential[]}
 */
export function readCCCredentialsFromFile() {
  const credPath = join(homedir(), ".claude", ".credentials.json");

  if (!existsSync(credPath)) return [];

  try {
    const raw = readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw);

    /** @type {CCCredential[]} */
    const results = [];

    const entries = Array.isArray(parsed) ? parsed : [parsed];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== "object") continue;

      // Unwrap "claudeAiOauth" wrapper if present
      const data = entry.claudeAiOauth && typeof entry.claudeAiOauth === "object" ? entry.claudeAiOauth : entry;

      // Skip MCP-only entries
      if (data.scope === "mcp") continue;

      const cred = shapeToCCCredential(data, "cc-file", `file:entry-${i}`);
      if (cred) results.push(cred);
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Unified reader
// ---------------------------------------------------------------------------

/**
 * Read all discoverable CC credentials from all sources.
 *
 * @returns {CCCredential[]}
 */
export function readCCCredentials() {
  /** @type {CCCredential[]} */
  const all = [];

  // Keychain (macOS only)
  all.push(...readCCCredentialsFromKeychain());

  // File-based (cross-platform)
  all.push(...readCCCredentialsFromFile());

  // De-duplicate by refreshToken (prefer keychain over file)
  /** @type {Map<string, CCCredential>} */
  const seen = new Map();
  for (const cred of all) {
    const existing = seen.get(cred.refreshToken);
    if (!existing || (cred.source === "cc-keychain" && existing.source === "cc-file")) {
      seen.set(cred.refreshToken, cred);
    }
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a CCCredential.
 *
 * @param {string} jsonStr
 * @param {CCCredentialSource} source
 * @param {string} label
 * @returns {CCCredential | null}
 */
export function parseCCCredentialData(jsonStr, source, label) {
  try {
    const data = JSON.parse(jsonStr);
    if (!data || typeof data !== "object") return null;

    // Handle wrapped format
    const inner = data.claudeAiOauth && typeof data.claudeAiOauth === "object" ? data.claudeAiOauth : data;

    return shapeToCCCredential(inner, source, label);
  } catch {
    return null;
  }
}

/**
 * Validate and shape an object into a CCCredential.
 *
 * @param {Record<string, unknown>} data
 * @param {CCCredentialSource} source
 * @param {string} label
 * @returns {CCCredential | null}
 */
function shapeToCCCredential(data, source, label) {
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : null;
  const refreshToken = typeof data.refreshToken === "string" ? data.refreshToken : null;

  if (!accessToken || !refreshToken) return null;

  // expiresAt can be number (ms-epoch) or ISO string
  let expiresAt = 0;
  if (typeof data.expiresAt === "number") {
    expiresAt = data.expiresAt;
  } else if (typeof data.expiresAt === "string") {
    const parsed = Date.parse(data.expiresAt);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof data.expires_at === "number") {
    expiresAt = data.expires_at;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : undefined,
    source,
    label,
  };
}
