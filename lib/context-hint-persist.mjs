import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./config.mjs";

const FLAG_FILENAME = "context-hint-disabled.flag";
const FLAG_VERSION = 1;

/**
 * @typedef {object} ContextHintFlag
 * @property {true} disabled
 * @property {string} [reason]
 * @property {number} [status]
 * @property {number} [timestamp]
 * @property {number} [version]
 */

/**
 * @returns {string}
 */
export function getContextHintFlagPath() {
  return join(getConfigDir(), FLAG_FILENAME);
}

/**
 * @returns {{ disabled: boolean, reason?: string, status?: number, timestamp?: number }}
 */
export function loadContextHintDisabledFlag() {
  const p = getContextHintFlagPath();
  if (!existsSync(p)) return { disabled: false };
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.disabled === true) {
      return {
        disabled: true,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        status: typeof parsed.status === "number" ? parsed.status : undefined,
        timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined,
      };
    }
  } catch {
    // Corrupted or unreadable — treat as not disabled.
  }
  return { disabled: false };
}

/**
 * Persist a permanent disable flag for the context-hint beta. Best-effort;
 * disk failures are swallowed so they never abort a session.
 * @param {{ reason: string, status: number }} params
 */
export function saveContextHintDisabledFlag({ reason, status }) {
  const p = getContextHintFlagPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    /** @type {ContextHintFlag} */
    const payload = {
      disabled: true,
      reason,
      status,
      timestamp: Date.now(),
      version: FLAG_VERSION,
    };
    writeFileSync(p, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Best-effort.
  }
}
