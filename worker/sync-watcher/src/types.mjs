// Pipeline state constants
export const STATES = /** @type {const} */ ({
  IDLE: "IDLE",
  DETECTED: "DETECTED",
  ANALYZING: "ANALYZING",
  PR_CREATED: "PR_CREATED",
  ISSUE_CREATED: "ISSUE_CREATED",
  DELIVERED: "DELIVERED",
  FAILED_RETRYABLE: "FAILED_RETRYABLE",
  DEAD_LETTER: "DEAD_LETTER",
});

export const SEVERITY = /** @type {const} */ ({
  NONE: "none",
  TRIVIAL: "trivial",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
});

export const MAX_RETRIES = 6;
export const LOCK_TTL_MS = 120_000;

/** @typedef {"IDLE"|"DETECTED"|"ANALYZING"|"PR_CREATED"|"ISSUE_CREATED"|"DELIVERED"|"FAILED_RETRYABLE"|"DEAD_LETTER"} State */
/** @typedef {"none"|"trivial"|"medium"|"high"|"critical"} Severity */
/**
 * @typedef {Object} ContractDiff
 * @property {boolean} changed
 * @property {Severity} severity
 * @property {Record<string, {from: any, to: any}>} fields
 */
/**
 * @typedef {Object} StateRecord
 * @property {State} state
 * @property {number} retries
 * @property {string} version
 * @property {string} lastEvent
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number|null} prNumber
 * @property {number|null} issueNumber
 * @property {string|null} branchName
 * @property {string|null} error
 */
/**
 * @typedef {Object} ExtractedContract
 * @property {string|null} version
 * @property {string|null} buildTime
 * @property {string|null} sdkVersion
 * @property {string|null} sdkToken
 * @property {string|null} billingSalt
 * @property {string|null} clientId
 * @property {string[]} allBetaFlags
 * @property {string[]} alwaysOnBetas
 * @property {string[]} experimentalBetas
 * @property {string[]} bedrockUnsupported
 * @property {string[]} claudeAiScopes
 * @property {string[]} consoleScopes
 * @property {string|null} oauthTokenUrl
 * @property {string|null} oauthRevokeUrl
 * @property {string|null} oauthRedirectUri
 * @property {string|null} oauthConsoleHost
 * @property {string[]} identityStrings
 * @property {string|null} systemPromptBoundary
 */
