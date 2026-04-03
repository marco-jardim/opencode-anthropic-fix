/**
 * Contract extractor for Claude Code cli.js bundles.
 *
 * All extraction is regex-based, anchored to VALUE patterns (not variable names).
 * Minified bundles use obfuscated variable names (e.g., aB1, cD2, jL3) — we never
 * rely on var names. Returns null for fields that cannot be extracted; never throws.
 *
 * @module extractor
 */

// ---------------------------------------------------------------------------
// Known constant sets (used for classification of extracted values)
// ---------------------------------------------------------------------------

const KNOWN_ALWAYS_ON_BETAS = new Set([
  "claude-code-20250219", // YYYYMMDD format — note no dashes in date
  "effort-2025-11-24",
  "advanced-tool-use-2025-11-20",
  "fast-mode-2026-02-01",
  "oauth-2025-04-20",
]);

const KNOWN_BEDROCK_UNSUPPORTED = new Set([
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
  "tool-search-tool-2025-10-19",
  "code-execution-2025-08-25",
  "files-api-2025-04-14",
  "fine-grained-tool-streaming-2025-05-14",
]);

const KNOWN_EXPERIMENTAL = new Set([
  "adaptive-thinking-2026-01-28",
  "advanced-tool-use-2025-11-20",
  "afk-mode-2026-01-31",
  "code-execution-2025-08-25",
  "context-1m-2025-08-07",
  "context-management-2025-06-27",
  "fast-mode-2026-02-01",
  "files-api-2025-04-14",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "redact-thinking-2026-02-12",
  "structured-outputs-2025-12-15",
  "tool-search-tool-2025-10-19",
  "web-search-2025-03-05",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all mimese-critical constants from a minified cli.js bundle text.
 * Composes all sub-extractors into a single ExtractedContract object.
 *
 * @param {string} cliText - Full text of the cli.js bundle
 * @returns {import('./types.mjs').ExtractedContract}
 */
export function extractContract(cliText) {
  return {
    ...extractScalars(cliText),
    ...extractBetas(cliText),
    ...extractOAuthConfig(cliText),
    ...extractIdentity(cliText),
  };
}

/**
 * Extract scalar constants: version, buildTime, sdkVersion, sdkToken, billingSalt, clientId.
 *
 * @param {string} cliText
 * @returns {{ version: string|null, buildTime: string|null, sdkVersion: string|null,
 *             sdkToken: string|null, billingSalt: string|null, clientId: string|null }}
 */
export function extractScalars(cliText) {
  return {
    version: extractCliVersion(cliText),
    buildTime: extractBuildTime(cliText),
    sdkVersion: extractSdkVersion(cliText),
    sdkToken: extractSdkToken(cliText),
    billingSalt: extractBillingSalt(cliText),
    clientId: extractClientId(cliText),
  };
}

/**
 * Extract beta flag collections.
 *
 * @param {string} cliText
 * @returns {{ allBetaFlags: string[], alwaysOnBetas: string[],
 *             experimentalBetas: string[], bedrockUnsupported: string[] }}
 */
export function extractBetas(cliText) {
  // Match all date-versioned beta flag strings.
  // Two formats exist in the wild:
  //   YYYY-MM-DD  (most flags, e.g. "advanced-tool-use-2025-11-20")
  //   YYYYMMDD    (legacy format, e.g. "claude-code-20250219")
  const betaPattern = /["']([a-z][a-z0-9-]*-(?:\d{4}-\d{2}-\d{2}|\d{8}))["']/g;
  const found = new Set();
  let m;
  while ((m = betaPattern.exec(cliText)) !== null) {
    found.add(m[1]);
  }

  const allBetaFlags = [...found].sort();

  // Classify into known sets; unknown flags fall into allBetaFlags only
  const alwaysOnBetas = allBetaFlags.filter((f) => KNOWN_ALWAYS_ON_BETAS.has(f));
  const experimentalBetas = allBetaFlags.filter((f) => KNOWN_EXPERIMENTAL.has(f));
  const bedrockUnsupported = allBetaFlags.filter((f) => KNOWN_BEDROCK_UNSUPPORTED.has(f));

  return { allBetaFlags, alwaysOnBetas, experimentalBetas, bedrockUnsupported };
}

/**
 * Extract OAuth configuration: endpoints and scopes.
 *
 * @param {string} cliText
 * @returns {{ oauthTokenUrl: string|null, oauthRevokeUrl: string|null,
 *             oauthRedirectUri: string|null, oauthConsoleHost: string|null,
 *             claudeAiScopes: string[], consoleScopes: string[] }}
 */
export function extractOAuthConfig(cliText) {
  return {
    oauthTokenUrl: extractOAuthUrl(cliText, "/v1/oauth/token"),
    oauthRevokeUrl: extractOAuthUrl(cliText, "/v1/oauth/revoke"),
    oauthRedirectUri: extractOAuthUrl(cliText, "/oauth/code/callback"),
    oauthConsoleHost: extractOAuthHost(cliText),
    claudeAiScopes: extractClaudeAiScopes(cliText),
    consoleScopes: extractConsoleScopes(cliText),
  };
}

/**
 * Extract identity strings and system prompt boundary.
 *
 * @param {string} cliText
 * @returns {{ identityStrings: string[], systemPromptBoundary: string|null }}
 */
export function extractIdentity(cliText) {
  return {
    identityStrings: extractIdentityStrings(cliText),
    systemPromptBoundary: extractSystemPromptBoundary(cliText),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the CLI version string (e.g. "2.1.91").
 * The CLI version is always a "2.x.x" semver. We look for the FIRST match
 * of a "2.x.x" pattern to avoid confusing it with "0.x.x" SDK versions.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractCliVersion(text) {
  try {
    // CLI version is a semver with major >= 2 (handles future 3.x, 4.x, etc.)
    const m = text.match(/["']([2-9]\.\d+\.\d+)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract the build timestamp (ISO 8601, e.g. "2026-04-02T21:58:41Z").
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractBuildTime(text) {
  try {
    const m = text.match(/["'](\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract the SDK version string (e.g. "0.208.0").
 * SDK versions are always "0.x.x" format.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractSdkVersion(text) {
  try {
    // Prefer the version near "@anthropic-ai/sdk" to avoid matching other 0.x.x deps.
    // The /s flag allows . to match newlines in case of multi-line minification.
    const nearSdk = text.match(/@anthropic-ai\/sdk[^"']{0,100}["'](0\.\d+\.\d+)["']/s);
    if (nearSdk) return nearSdk[1];
    // Fallback: first 0.x.x string in the bundle
    const m = text.match(/["'](0\.\d+\.\d+)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract the SDK token string (e.g. "sdk-zAZezfDKGoZuXXKe").
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractSdkToken(text) {
  try {
    const m = text.match(/["'](sdk-[A-Za-z0-9]{16})["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract the billing hash salt (12 lowercase hex chars, e.g. "59cf53e54c78").
 * Searches for a 12-char hex string that is NOT part of a UUID (which has hyphens).
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractBillingSalt(text) {
  try {
    // Match 12 lowercase hex chars surrounded by quotes.
    // The billing salt is a standalone 12-hex string (e.g. "59cf53e54c78").
    // A UUID has segments separated by hyphens: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
    // We reject a candidate if the surrounding raw text (±3 chars outside the quotes)
    // contains a hyphen immediately adjacent to a hex run — reliable UUID detection
    // that does NOT depend on knowing any specific UUID value.
    const pattern = /["']([0-9a-f]{12})["']/g;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const candidate = m[1];
      const idx = m.index;
      // Grab the char just before the opening quote and just after the closing quote
      const charBefore = idx > 0 ? text[idx - 1] : "";
      const charAfter = text[idx + m[0].length] ?? "";
      // If the 12-hex string is immediately adjacent to a hyphen it's a UUID segment
      if (charBefore === "-" || charAfter === "-") continue;
      // Also skip if the wider window contains a UUID-like pattern (8hex-4hex-)
      const window = text.slice(Math.max(0, idx - 10), idx + m[0].length + 10);
      if (/[0-9a-f]{8}-[0-9a-f]{4}-/.test(window)) continue;
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the OAuth client ID (UUID format).
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractClientId(text) {
  try {
    const m = text.match(/["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract a specific OAuth URL containing the given path segment.
 *
 * @param {string} text
 * @param {string} pathSegment
 * @returns {string|null}
 */
function extractOAuthUrl(text, pathSegment) {
  try {
    // Escape special regex chars in pathSegment
    const escaped = pathSegment.replace(/[/]/g, "\\/");
    const pattern = new RegExp(`["'](https:\\/\\/[^"']*${escaped}[^"']*)["']`);
    const m = text.match(pattern);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract the OAuth console host (e.g. "platform.claude.com").
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractOAuthHost(text) {
  try {
    // Look for the standalone host string (not a full URL)
    const m = text.match(/["'](platform\.claude\.com)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Extract Claude AI OAuth scopes (user:* pattern).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractClaudeAiScopes(text) {
  try {
    const pattern = /["'](user:[a-z_:]+)["']/g;
    const found = new Set();
    let m;
    while ((m = pattern.exec(text)) !== null) {
      found.add(m[1]);
    }
    return [...found].sort();
  } catch {
    return [];
  }
}

/**
 * Extract console OAuth scopes.
 * Console scopes always contain at least one "org:*" scope.
 * We find the array literal containing "org:create_api_key" and extract all strings from it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractConsoleScopes(text) {
  try {
    // Find an array literal that contains an org: scope
    // e.g. ["org:create_api_key","user:profile"]
    const arrayPattern = /\[([^\]]*"org:[a-z_]+"[^\]]*)\]/g;
    const found = new Set();
    let m;
    while ((m = arrayPattern.exec(text)) !== null) {
      const inner = m[1];
      const strPattern = /["']([^"']+)["']/g;
      let s;
      while ((s = strPattern.exec(inner)) !== null) {
        found.add(s[1]);
      }
    }
    return [...found].sort();
  } catch {
    return [];
  }
}

/**
 * Extract identity strings ("You are Claude..." patterns).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractIdentityStrings(text) {
  try {
    const found = new Set();
    // Match double-quoted identity strings (content may contain apostrophes)
    const dq = /["](You are [^"]{10,300})["]/g;
    let m;
    while ((m = dq.exec(text)) !== null) {
      found.add(m[1]);
    }
    // Match single-quoted identity strings (content may not contain single quotes)
    const sq = /['](You are [^']{10,300})[']/g;
    while ((m = sq.exec(text)) !== null) {
      found.add(m[1]);
    }
    return [...found].sort();
  } catch {
    return [];
  }
}

/**
 * Extract the system prompt dynamic boundary marker.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractSystemPromptBoundary(text) {
  try {
    const m = text.match(/["'](__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__)["']/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
