import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  extractContract,
  extractScalars,
  extractBetas,
  extractOAuthConfig,
  extractIdentity,
} from "../src/extractor.mjs";
import { SEED_CONTRACT } from "../src/seed.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const v91 = readFileSync(join(__dirname, "../fixtures/v2.1.91.snippet.js"), "utf-8");
const v90 = readFileSync(join(__dirname, "../fixtures/v2.1.90.snippet.js"), "utf-8");
const v92r = readFileSync(join(__dirname, "../fixtures/v2.1.92-realistic.snippet.js"), "utf-8");

// ---------------------------------------------------------------------------
// Scalar extraction
// ---------------------------------------------------------------------------

describe("extractScalars — v2.1.91", () => {
  it("T1.1: extracts correct version, buildTime, sdkVersion for v2.1.91", () => {
    const s = extractScalars(v91);
    expect(s.version).toBe("2.1.91");
    expect(s.buildTime).toBe("2026-04-02T21:58:41Z");
    expect(s.sdkVersion).toBe("0.208.0");
  });

  it("T1.2: extracts correct version, buildTime for v2.1.90", () => {
    const s = extractScalars(v90);
    expect(s.version).toBe("2.1.90");
    expect(s.buildTime).toBe("2026-04-01T22:53:10Z");
    expect(s.sdkVersion).toBe("0.208.0");
  });

  it("T1.3: returns null fields for garbage input", () => {
    const s = extractScalars("hello world this is not a bundle");
    expect(s.version).toBeNull();
    expect(s.buildTime).toBeNull();
    expect(s.sdkVersion).toBeNull();
    expect(s.sdkToken).toBeNull();
    expect(s.billingSalt).toBeNull();
    expect(s.clientId).toBeNull();
  });

  it("T1.4: handles ultra-minified input (no whitespace)", () => {
    const minified = v91.replace(/\s+/g, "");
    const s = extractScalars(minified);
    expect(s.version).toBe("2.1.91");
  });

  it("T1.12: distinguishes CLI version (2.x.x) from SDK version (0.x.x)", () => {
    const text = `var aC1={PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"2.1.91"};var b="0.208.0";`;
    const s = extractScalars(text);
    expect(s.version).toBe("2.1.91");
    expect(s.sdkVersion).toBe("0.208.0");
  });

  it("T1.16: ignores AWS SDK bundled dependency version before CLI version", () => {
    // Simulates real bundle layout: @aws-sdk package appears before @anthropic-ai/claude-code
    const text = [
      `var x={name:"@aws-sdk/nested-clients",version:"3.936.0"};`,
      `var aC1={PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"2.1.92",BUILD_TIME:"2026-04-03T00:00:00Z"};`,
    ].join("\n");
    const s = extractScalars(text);
    expect(s.version).toBe("2.1.92");
  });

  it("T1.14: extracts UUID clientId", () => {
    const s = extractScalars(v91);
    expect(s.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  it("T1.15: extracts SDK token", () => {
    const s = extractScalars(v91);
    expect(s.sdkToken).toBe("sdk-zAZezfDKGoZuXXKe");
  });
});

// ---------------------------------------------------------------------------
// Beta extraction
// ---------------------------------------------------------------------------

describe("extractBetas", () => {
  it("T1.5: returns sorted arrays matching known v2.1.91 beta sets", () => {
    const b = extractBetas(v91);
    expect(b.alwaysOnBetas).toContain("oauth-2025-04-20");
    expect(b.alwaysOnBetas).toContain("claude-code-20250219");
    expect(b.alwaysOnBetas).toContain("advanced-tool-use-2025-11-20");
    expect(b.alwaysOnBetas).toContain("fast-mode-2026-02-01");
    // All arrays should be sorted
    expect(b.allBetaFlags).toEqual([...b.allBetaFlags].sort());
    expect(b.alwaysOnBetas).toEqual([...b.alwaysOnBetas].sort());
    expect(b.experimentalBetas).toEqual([...b.experimentalBetas].sort());
    expect(b.bedrockUnsupported).toEqual([...b.bedrockUnsupported].sort());
  });

  it("T1.6: detects difference between v90 and v91 (afk-mode only in v91)", () => {
    const b91 = extractBetas(v91);
    const b90 = extractBetas(v90);
    expect(b91.experimentalBetas).toContain("afk-mode-2026-01-31");
    expect(b90.experimentalBetas).not.toContain("afk-mode-2026-01-31");
    expect(b91.allBetaFlags.length).toBeGreaterThan(b90.allBetaFlags.length);
  });

  it("T1.13: returns empty arrays for input with no beta flags", () => {
    const b = extractBetas("var x=42;");
    expect(b.allBetaFlags).toEqual([]);
    expect(b.alwaysOnBetas).toEqual([]);
    expect(b.experimentalBetas).toEqual([]);
    expect(b.bedrockUnsupported).toEqual([]);
  });

  it("bedrockUnsupported contains the 6 known flags", () => {
    const b = extractBetas(v91);
    expect(b.bedrockUnsupported).toHaveLength(6);
    expect(b.bedrockUnsupported).toContain("interleaved-thinking-2025-05-14");
    expect(b.bedrockUnsupported).toContain("files-api-2025-04-14");
  });

  it("experimentalBetas contains afk-mode in v91", () => {
    const b = extractBetas(v91);
    expect(b.experimentalBetas).toContain("afk-mode-2026-01-31");
    expect(b.experimentalBetas.length).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// OAuth config extraction
// ---------------------------------------------------------------------------

describe("extractOAuthConfig", () => {
  it("T1.7: claudeAiScopes returns exactly 5 scopes", () => {
    const o = extractOAuthConfig(v91);
    expect(o.claudeAiScopes).toHaveLength(5);
    expect(o.claudeAiScopes).toContain("user:profile");
    expect(o.claudeAiScopes).toContain("user:inference");
    expect(o.claudeAiScopes).toContain("user:sessions:claude_code");
    expect(o.claudeAiScopes).toContain("user:mcp_servers");
    expect(o.claudeAiScopes).toContain("user:file_upload");
  });

  it("T1.16: consoleScopes returns exactly 2 scopes", () => {
    const o = extractOAuthConfig(v91);
    expect(o.consoleScopes).toHaveLength(2);
    expect(o.consoleScopes).toContain("org:create_api_key");
    expect(o.consoleScopes).toContain("user:profile");
  });

  it("T1.8: returns all 3 OAuth URLs", () => {
    const o = extractOAuthConfig(v91);
    expect(o.oauthTokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(o.oauthRevokeUrl).toBe("https://platform.claude.com/v1/oauth/revoke");
    expect(o.oauthRedirectUri).toBe("https://platform.claude.com/oauth/code/callback");
  });

  it("extracts oauthConsoleHost correctly", () => {
    const o = extractOAuthConfig(v91);
    expect(o.oauthConsoleHost).toBe("platform.claude.com");
  });

  it("returns empty arrays for text with no OAuth content", () => {
    const o = extractOAuthConfig("var x=42;");
    expect(o.claudeAiScopes).toEqual([]);
    expect(o.consoleScopes).toEqual([]);
    expect(o.oauthTokenUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Identity extraction
// ---------------------------------------------------------------------------

describe("extractIdentity", () => {
  it("T1.9: identityStrings returns 3 known strings", () => {
    const id = extractIdentity(v91);
    expect(id.identityStrings).toHaveLength(3);
    expect(id.identityStrings).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(id.identityStrings).toContain(
      "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    );
    expect(id.identityStrings).toContain("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  });

  it("extracts systemPromptBoundary", () => {
    const id = extractIdentity(v91);
    expect(id.systemPromptBoundary).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
  });

  it("returns empty arrays for text with no identity content", () => {
    const id = extractIdentity("var x=42;");
    expect(id.identityStrings).toEqual([]);
    expect(id.systemPromptBoundary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full contract extraction
// ---------------------------------------------------------------------------

describe("extractContract", () => {
  it("T1.10: composes all sub-extractors correctly", () => {
    const c = extractContract(v91);
    // Scalars
    expect(c.version).toBe("2.1.91");
    expect(c.buildTime).toBe("2026-04-02T21:58:41Z");
    expect(c.sdkVersion).toBe("0.208.0");
    expect(c.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    // Betas
    expect(c.allBetaFlags.length).toBeGreaterThan(0);
    expect(c.alwaysOnBetas).toContain("oauth-2025-04-20");
    // OAuth
    expect(c.oauthTokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(c.claudeAiScopes).toHaveLength(5);
    // Identity
    expect(c.identityStrings).toHaveLength(3);
    expect(c.systemPromptBoundary).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
  });

  it("T1.11: extraction completes in < 500ms for large input", () => {
    // Build a ~1MB input by repeating the fixture
    const large = v91.repeat(100);
    const start = Date.now();
    extractContract(large);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Seed contract consistency (#12)
// ---------------------------------------------------------------------------

describe("seed contract consistency with extractor", () => {
  it("SEED_CONTRACT.alwaysOnBetas matches what extractBetas produces from v2.1.91 fixture", () => {
    const { alwaysOnBetas } = extractBetas(v91);
    expect([...alwaysOnBetas].sort()).toEqual([...SEED_CONTRACT.alwaysOnBetas].sort());
  });

  it("SEED_CONTRACT.experimentalBetas matches what extractBetas produces from v2.1.91 fixture", () => {
    const { experimentalBetas } = extractBetas(v91);
    expect([...experimentalBetas].sort()).toEqual([...SEED_CONTRACT.experimentalBetas].sort());
  });

  it("SEED_CONTRACT.bedrockUnsupported matches what extractBetas produces from v2.1.91 fixture", () => {
    const { bedrockUnsupported } = extractBetas(v91);
    expect([...bedrockUnsupported].sort()).toEqual([...SEED_CONTRACT.bedrockUnsupported].sort());
  });

  it("SEED_CONTRACT version-independent scalar fields match extractScalars output from v2.1.91 fixture", () => {
    // version and buildTime are inherently version-specific — they won't match
    // the seed (which tracks the latest synced version). The other scalars
    // (sdkVersion, sdkToken, billingSalt, clientId) should be stable across
    // minor version bumps.
    const scalars = extractScalars(v91);
    expect(scalars.sdkVersion).toBe(SEED_CONTRACT.sdkVersion);
    expect(scalars.sdkToken).toBe(SEED_CONTRACT.sdkToken);
    expect(scalars.billingSalt).toBe(SEED_CONTRACT.billingSalt);
    expect(scalars.clientId).toBe(SEED_CONTRACT.clientId);
  });

  it("SEED_CONTRACT OAuth endpoints match extractOAuthConfig output from v2.1.91 fixture", () => {
    const oauth = extractOAuthConfig(v91);
    expect(oauth.oauthTokenUrl).toBe(SEED_CONTRACT.oauthTokenUrl);
    expect(oauth.oauthRevokeUrl).toBe(SEED_CONTRACT.oauthRevokeUrl);
    expect(oauth.oauthRedirectUri).toBe(SEED_CONTRACT.oauthRedirectUri);
    expect(oauth.oauthConsoleHost).toBe(SEED_CONTRACT.oauthConsoleHost);
    expect([...oauth.claudeAiScopes].sort()).toEqual([...SEED_CONTRACT.claudeAiScopes].sort());
    expect([...oauth.consoleScopes].sort()).toEqual([...SEED_CONTRACT.consoleScopes].sort());
  });

  it("SEED_CONTRACT identity matches extractIdentity output from v2.1.91 fixture", () => {
    const identity = extractIdentity(v91);
    expect([...identity.identityStrings].sort()).toEqual([...SEED_CONTRACT.identityStrings].sort());
    expect(identity.systemPromptBoundary).toBe(SEED_CONTRACT.systemPromptBoundary);
  });
});

// ---------------------------------------------------------------------------
// Realistic bundle extraction (v2.1.92 fixture with real-world pitfalls)
// ---------------------------------------------------------------------------

describe("extractContract — realistic v2.1.92 fixture", () => {
  it("extracts correct CLI version despite AWS SDK version appearing first", () => {
    const c = extractContract(v92r);
    expect(c.version).toBe("2.1.92");
  });

  it("extracts correct SDK version (0.208.0) despite misleading 0.80.0 appearing first", () => {
    const c = extractContract(v92r);
    expect(c.sdkVersion).toBe("0.208.0");
  });

  it("extracts real CLIENT_ID despite uuid template UUID appearing first", () => {
    const c = extractContract(v92r);
    expect(c.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    // Must NOT grab the uuid library template
    expect(c.clientId).not.toBe("10000000-1000-4000-8000-100000000000");
  });

  it("extracts console scopes from standalone variables (no array literal)", () => {
    const c = extractContract(v92r);
    expect(c.consoleScopes).toContain("org:create_api_key");
    expect(c.consoleScopes).toContain("user:profile");
    expect(c.consoleScopes).toHaveLength(2);
  });

  it("derives revoke URL from token URL when not present in bundle", () => {
    const c = extractContract(v92r);
    expect(c.oauthRevokeUrl).toBe("https://platform.claude.com/v1/oauth/revoke");
    expect(c.oauthTokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
  });

  it("extracts only 3 real identity strings (filters out SDK docs/UI strings)", () => {
    const c = extractContract(v92r);
    expect(c.identityStrings).toHaveLength(3);
    expect(c.identityStrings).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(c.identityStrings).toContain(
      "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    );
    expect(c.identityStrings).toContain("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    // Must NOT contain non-identity strings
    expect(c.identityStrings).not.toContain("You are a helpful assistant that answers questions.");
    expect(c.identityStrings).not.toContain("You are currently using your free plan subscription.");
  });

  it("extracts all other fields correctly", () => {
    const c = extractContract(v92r);
    expect(c.buildTime).toBe("2026-04-03T23:25:15Z");
    expect(c.sdkToken).toBe("sdk-zAZezfDKGoZuXXKe");
    expect(c.billingSalt).toBe("59cf53e54c78");
    expect(c.oauthRedirectUri).toBe("https://platform.claude.com/oauth/code/callback");
    expect(c.oauthConsoleHost).toBe("platform.claude.com");
    expect(c.systemPromptBoundary).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
    expect(c.claudeAiScopes).toHaveLength(5);
    expect(c.allBetaFlags.length).toBeGreaterThan(0);
  });

  it("realistic fixture produces identical contract to simple fixture (except version/buildTime)", () => {
    const c91 = extractContract(v91);
    const c92 = extractContract(v92r);
    // These SHOULD differ (version bump):
    expect(c92.version).not.toBe(c91.version);
    expect(c92.buildTime).not.toBe(c91.buildTime);
    // These SHOULD be identical (no real change):
    expect(c92.sdkVersion).toBe(c91.sdkVersion);
    expect(c92.clientId).toBe(c91.clientId);
    expect(c92.billingSalt).toBe(c91.billingSalt);
    expect(c92.sdkToken).toBe(c91.sdkToken);
    expect(c92.oauthTokenUrl).toBe(c91.oauthTokenUrl);
    expect(c92.oauthRevokeUrl).toBe(c91.oauthRevokeUrl);
    expect(c92.oauthRedirectUri).toBe(c91.oauthRedirectUri);
    expect([...c92.identityStrings].sort()).toEqual([...c91.identityStrings].sort());
    expect([...c92.consoleScopes].sort()).toEqual([...c91.consoleScopes].sort());
  });
});
