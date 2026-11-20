import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfigDir, loadConfig } from "./config.mjs";
import { redactSecrets } from "./redact.mjs";
import { getWireCompatPackageVersion, WIRE_PROFILE } from "./mimicry/wire-compat.mjs";
import { loadAccounts } from "./storage.mjs";

const ENV_KEYS = [
  "OPENCODE_ANTHROPIC_STRATEGY",
  "OPENCODE_ANTHROPIC_DEBUG",
  "OPENCODE_ANTHROPIC_MAX_BUDGET_USD",
  "OPENCODE_ANTHROPIC_INITIAL_ACCOUNT",
  "OPENCODE_ANTHROPIC_TELEMETRY_EMULATE",
  "OPENCODE_ANTHROPIC_IGNORE_BUDGET",
  "OPENCODE_ANTHROPIC_SIGNATURE_USER_ID",
  "OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING",
  "OPENCODE_ANTHROPIC_DISABLE_FAST_MODE",
  "OPENCODE_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_EXTRA_METADATA",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_WORKLOAD",
  "CLAUDE_CODE_FORCE_GLOBAL_CACHE",
  "CLAUDE_CODE_BACKGROUND",
  "CLAUDE_CODE_CONTAINER_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_ADDITIONAL_PROTECTION",
];

function getPluginVersion() {
  try {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function getRuntimeEnv() {
  const env = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return redactSecrets(env);
}

async function getAccountSummary() {
  try {
    const stored = await loadAccounts();
    if (!stored || !Array.isArray(stored.accounts)) return { count: 0, items: [] };

    const items = stored.accounts.map((account, index) => {
      const item = { index };
      for (const key of ["email", "disabled", "enabled", "consecutiveFailures", "rateLimitResetTimes"]) {
        if (Object.hasOwn(account, key)) item[key] = account[key];
      }
      return item;
    });

    return redactSecrets({ count: items.length, items });
  } catch {
    return { count: 0, items: [] };
  }
}

function sortedArtifactFiles(directory, prefix, extension) {
  try {
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((file) => file.startsWith(prefix) && file.endsWith(extension))
      .sort()
      .slice(-10);
  } catch {
    return [];
  }
}

function requestDumpMetadata(directory) {
  return sortedArtifactFiles(directory, "req-", ".json").map((file) => {
    try {
      const filePath = path.join(directory, file);
      const envelope = JSON.parse(readFileSync(filePath, "utf8"));
      return {
        file,
        correlationId: envelope.correlationId,
        timestamp: envelope.timestamp,
        bytes: statSync(filePath).size,
      };
    } catch {
      return { file, error: "unparseable" };
    }
  });
}

function correlationIdFromResponseFile(file) {
  const stem = file.slice("res-".length, -".sse".length);
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)$/i.exec(stem);
  if (isoTimestamp) return isoTimestamp[1];

  const numericTimestamp = /^\d{10,}-(.+)$/.exec(stem);
  if (numericTimestamp) return numericTimestamp[1];

  const uuid = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(stem);
  return uuid?.[1] ?? stem;
}

function responseDumpMetadata(directory) {
  const items = [];
  for (const file of sortedArtifactFiles(directory, "res-", ".sse")) {
    try {
      items.push({
        file,
        correlationId: correlationIdFromResponseFile(file),
        bytes: statSync(path.join(directory, file)).size,
      });
    } catch {
      // A file can disappear between directory enumeration and stat; omit it rather than abort diagnostics.
    }
  }
  return items;
}

function debugHeadersMetadata() {
  try {
    const filePath = path.join(getConfigDir(), "debug-headers.log");
    if (!existsSync(filePath)) return { exists: false, sizeBytes: 0 };
    return { exists: true, sizeBytes: statSync(filePath).size };
  } catch {
    return { exists: false, sizeBytes: 0 };
  }
}

function getArtifactSummary() {
  try {
    const dumpsDirectory = path.join(os.homedir(), ".opencode", "opencode-anthropic-fix", "request-dumps");
    return {
      requestDumps: requestDumpMetadata(dumpsDirectory),
      responseDumps: responseDumpMetadata(dumpsDirectory),
      debugHeadersLog: debugHeadersMetadata(),
    };
  } catch {
    return {
      requestDumps: [],
      responseDumps: [],
      debugHeadersLog: { exists: false, sizeBytes: 0 },
    };
  }
}

// Latest upstream claude-code release seen on npm by this process. Purely
// informational: the emulated version is always the pinned wire profile's.
let recordedLatestUpstreamClaudeCodeVersion = null;

/**
 * Record the latest upstream claude-code version the runtime fetched from npm,
 * so the diagnostic bundle can show "emulating X; upstream latest Y". Never
 * feeds the wire path.
 *
 * @param {string | null | undefined} version
 * @returns {void}
 */
export function recordLatestUpstreamClaudeCodeVersion(version) {
  recordedLatestUpstreamClaudeCodeVersion = typeof version === "string" && version ? version : null;
}

/**
 * Build a shareable diagnostic snapshot without exposing credentials.
 *
 * @param {{ latestUpstreamClaudeCodeVersion?: string | null }} [options]
 * @returns {Promise<object>}
 */
export async function buildDiagnosticBundle(options = {}) {
  const latestUpstream = options.latestUpstreamClaudeCodeVersion ?? recordedLatestUpstreamClaudeCodeVersion ?? null;
  const bundle = {
    meta: {
      generatedAt: new Date().toISOString(),
      pluginVersion: getPluginVersion(),
      nodeVersion: process.version,
      platform: process.platform,
      // Static baseline on purpose: the CLI version the wire package's profile
      // declares, NOT the (possibly npm-updated) version of the running session.
      mimicryBaseline: WIRE_PROFILE.cliVersion,
      // Informational only (null when not fetched): the newest upstream release
      // seen on npm. The wire never adopts it.
      latestUpstreamClaudeCodeVersion: latestUpstream,
      mimicryVersionNote: `emulating ${WIRE_PROFILE.cliVersion}; upstream latest ${latestUpstream ?? "unknown"}`,
      // The full profile id (e.g. "claude-code-2.1.280-sdk-0.112.1"), same
      // baseline caveat as mimicryBaseline above.
      mimicryProfileId: WIRE_PROFILE.id,
      // What's ACTUALLY loaded in node_modules right now -- see
      // getWireCompatPackageVersion's own doc comment for why this can differ
      // from what a future `npm ci` would install.
      wireCompatPackageVersion: getWireCompatPackageVersion(),
    },
    config: redactSecrets(loadConfig()),
    env: getRuntimeEnv(),
    accounts: await getAccountSummary(),
    artifacts: getArtifactSummary(),
  };

  return redactSecrets(bundle);
}
