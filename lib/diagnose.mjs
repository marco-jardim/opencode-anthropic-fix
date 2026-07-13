import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfigDir, loadConfig } from "./config.mjs";
import { redactSecrets } from "./redact.mjs";
import { FALLBACK_CLAUDE_CLI_VERSION } from "./request-headers.mjs";
import { loadAccounts } from "./storage.mjs";

const ENV_KEYS = [
  "OPENCODE_ANTHROPIC_STRATEGY",
  "OPENCODE_ANTHROPIC_DEBUG",
  "OPENCODE_ANTHROPIC_MAX_BUDGET_USD",
  "INITIAL_ACCOUNT",
  "TELEMETRY_EMULATE",
  "IGNORE_BUDGET",
  "SIGNATURE_USER_ID",
  "DISABLE_ADAPTIVE_THINKING",
  "DISABLE_FAST_MODE",
  "STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "DISABLE_1M_CONTEXT",
  "ORGANIZATION_UUID",
  "ENTRYPOINT",
  "USE_BEDROCK",
  "USE_FOUNDRY",
  "USE_ANTHROPIC_AWS",
  "USE_MANTLE",
  "USE_VERTEX",
  "ACCOUNT_UUID",
  "EXTRA_METADATA",
  "ATTRIBUTION_HEADER",
  "WORKLOAD",
  "FORCE_GLOBAL_CACHE",
  "BACKGROUND",
  "CONTAINER_ID",
  "REMOTE_SESSION_ID",
  "ADDITIONAL_PROTECTION",
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

/**
 * Build a shareable diagnostic snapshot without exposing credentials.
 *
 * @returns {Promise<object>}
 */
export async function buildDiagnosticBundle() {
  const bundle = {
    meta: {
      generatedAt: new Date().toISOString(),
      pluginVersion: getPluginVersion(),
      nodeVersion: process.version,
      platform: process.platform,
      mimicryBaseline: FALLBACK_CLAUDE_CLI_VERSION,
    },
    config: redactSecrets(loadConfig()),
    env: getRuntimeEnv(),
    accounts: await getAccountSummary(),
    artifacts: getArtifactSummary(),
  };

  return redactSecrets(bundle);
}
