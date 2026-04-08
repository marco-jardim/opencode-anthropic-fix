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
 * Note: oauthRevokeUrl is NOT present as a full URL in the bundle since v2.1.91+.
 * The CLI uses MCP server metadata discovery (revocation_endpoint) or constructs
 * it from TOKEN_URL by replacing the path. We derive it from oauthTokenUrl.
 *
 * @param {string} cliText
 * @returns {{ oauthTokenUrl: string|null, oauthRevokeUrl: string|null,
 *             oauthRedirectUri: string|null, oauthConsoleHost: string|null,
 *             claudeAiScopes: string[], consoleScopes: string[] }}
 */
export function extractOAuthConfig(cliText) {
  const tokenUrl = extractOAuthUrl(cliText, "/v1/oauth/token");
  // Try extracting revoke URL directly; if not found, derive from token URL
  let revokeUrl = extractOAuthUrl(cliText, "/v1/oauth/revoke");
  if (!revokeUrl && tokenUrl) {
    revokeUrl = tokenUrl.replace("/v1/oauth/token", "/v1/oauth/revoke");
  }

  return {
    oauthTokenUrl: tokenUrl,
    oauthRevokeUrl: revokeUrl,
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
 * Anchored to known context to avoid matching bundled dependency versions
 * (e.g. @aws-sdk/nested-clients "3.936.0" appears before "2.1.92" in the bundle).
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractCliVersion(text) {
  try {
    // Primary: VERSION field adjacent to the @anthropic-ai/claude-code package name
    // e.g. PACKAGE_URL:"@anthropic-ai/claude-code",...,VERSION:"2.1.92"
    // Allow optional whitespace after VERSION: (fixtures may have spaces)
    const anchored = text.match(/@anthropic-ai\/claude-code[^}]{0,200}VERSION:\s*["']([^"']+)["']/s);
    if (anchored) return anchored[1];

    // Secondary: VERSION:"x.y.z" field anywhere (avoids unanchored first-match)
    const versionField = text.match(/\bVERSION:["']([2-9]\.\d+\.\d+)["']/);
    if (versionField) return versionField[1];

    // Tertiary: unquoted version comment "// Version: x.y.z"
    const comment = text.match(/\/\/ Version:\s*([2-9]\.\d+\.\d+)/);
    if (comment) return comment[1];

    // Fallback (synthetic fixtures / future formats): first quoted 2-9.x.x string
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
 * Real bundle pattern: `.VERSION="0.208.0"` (SDK class export at ~7.4M offset).
 * Bug fix: the old regex grabbed the first 0.x.x string (e.g. "0.80.0" from
 * Stainless platform-detection code at offset ~53K). Now we anchor to the
 * `.VERSION=` export pattern which is how the SDK exposes its version.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractSdkVersion(text) {
  try {
    // Primary: .VERSION="0.x.x" — SDK class prototype exports version this way.
    // e.g. En4.VERSION="0.208.0" or Anthropic.VERSION="0.208.0"
    const versionExport = text.match(/\.VERSION\s*=\s*["'](0\.\d+\.\d+)["']/);
    if (versionExport) return versionExport[1];

    // Secondary: near "@anthropic-ai/sdk" package name
    const nearSdk = text.match(/@anthropic-ai\/sdk[^"']{0,100}["'](0\.\d+\.\d+)["']/s);
    if (nearSdk) return nearSdk[1];

    // Tertiary: VERSION:"0.x.x" field pattern (fixtures use this)
    const versionField = text.match(/\bVERSION\s*[:=]\s*["'](0\.\d+\.\d+)["']/);
    if (versionField) return versionField[1];

    // Last resort: first 0.x.x (unreliable in real bundles — may grab wrong dep)
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
 * Real bundles contain BOTH local-dev and production CLIENT_ID values.
 * We must prefer production (`OAUTH_FILE_SUFFIX:""`) over local
 * (`OAUTH_FILE_SUFFIX:"-local-oauth"`) when both are present.
 *
 * Historical pitfalls:
 * - First UUID in bundle may be uuid lib template (`10000000-1000-4000-8000-100000000000`)
 * - First CLIENT_ID in bundle may be local-dev, not production
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractClientId(text) {
  try {
    // Collect all CLIENT_ID assignments first.
    const clientIdPattern =
      /CLIENT_ID\s*[:=]\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/g;
    const matches = [];
    let m;
    while ((m = clientIdPattern.exec(text)) !== null) {
      matches.push({ id: m[1], index: m.index });
    }

    if (matches.length === 1) return matches[0].id;

    // Prefer the CLIENT_ID whose nearby config has OAUTH_FILE_SUFFIX:"" (production).
    for (const match of matches) {
      const nearby = text.slice(match.index, match.index + 500);
      const suffixMatch = nearby.match(/OAUTH_FILE_SUFFIX\s*[:=]\s*["']([^"']*)["']/);
      if (suffixMatch && suffixMatch[1] === "") {
        return match.id;
      }
    }

    // Secondary preference: near BASE_API_URL:"https://api.anthropic.com".
    for (const match of matches) {
      const start = Math.max(0, match.index - 350);
      const end = Math.min(text.length, match.index + 350);
      const nearby = text.slice(start, end);
      if (/BASE_API_URL\s*[:=]\s*["']https:\/\/api\.anthropic\.com["']/.test(nearby)) {
        return match.id;
      }
    }

    // If we found CLIENT_ID assignments but couldn't classify, return first match.
    if (matches.length > 0) return matches[0].id;

    // Fallback: first UUID (less reliable — may grab uuid lib template)
    const anyUuid = text.match(/["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/);
    return anyUuid ? anyUuid[1] : null;
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
 *
 * Real bundle pattern: scopes are standalone variables (`ZS5="org:create_api_key"`)
 * assembled into arrays via variable refs (`Lh7=[ZS5,jz6]`). The old regex
 * searched for array literals containing quoted "org:..." strings, which never
 * matched in real bundles. Now we extract all "org:*" scope strings individually
 * and pair them with any "user:profile" scope that appears near the OAuth config.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractConsoleScopes(text) {
  try {
    const found = new Set();

    // Strategy 1: array literal with quoted org: scopes (works in fixtures)
    const arrayPattern = /\[([^\]]*["']org:[a-z_]+["'][^\]]*)\]/g;
    let m;
    while ((m = arrayPattern.exec(text)) !== null) {
      const inner = m[1];
      const strPattern = /["']([^"']+)["']/g;
      let s;
      while ((s = strPattern.exec(inner)) !== null) {
        found.add(s[1]);
      }
    }
    if (found.size > 0) return [...found].sort();

    // Strategy 2: extract standalone "org:*" scope strings (real bundles)
    // In minified bundles, scopes are assigned to variables: ZS5="org:create_api_key"
    const orgPattern = /["'](org:[a-z_]+)["']/g;
    while ((m = orgPattern.exec(text)) !== null) {
      found.add(m[1]);
    }

    // Also grab "user:profile" since it's always in consoleScopes alongside org scopes.
    // We differentiate from claudeAiScopes by only including user:profile (not other user:* scopes).
    if (found.size > 0 && text.includes('"user:profile"')) {
      found.add("user:profile");
    }

    return [...found].sort();
  } catch {
    return [];
  }
}

/**
 * Known identity string prefixes used by the Claude Code CLI.
 * Only strings matching these prefixes are actual system prompt identity strings.
 * The bundle also contains "You are ..." strings in SDK docs, UI messages,
 * tool prompts, and billing info — those are NOT identity strings.
 */
const IDENTITY_PREFIXES = ["You are Claude Code", "You are a Claude agent"];

/**
 * Extract identity strings ("You are Claude Code..." / "You are a Claude agent..." patterns).
 *
 * Bug fix: the old regex matched ALL "You are ..." strings (17+ matches in real bundles),
 * including SDK examples ("You are a helpful assistant"), UI messages ("You are currently
 * using your subscription"), and tool prompts. Now we filter to known identity prefixes.
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
      if (IDENTITY_PREFIXES.some((p) => m[1].startsWith(p))) {
        found.add(m[1]);
      }
    }
    // Match single-quoted identity strings (content may not contain single quotes)
    const sq = /['](You are [^']{10,300})[']/g;
    while ((m = sq.exec(text)) !== null) {
      if (IDENTITY_PREFIXES.some((p) => m[1].startsWith(p))) {
        found.add(m[1]);
      }
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
