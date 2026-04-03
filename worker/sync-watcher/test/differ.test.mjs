import { describe, it, expect } from "vitest";
import { diffContracts, isTrivialDiff, isAutoPatchableDiff, summarizeDiff } from "../src/differ.mjs";

/** Minimal valid contract for tests */
const BASE = {
  version: "2.1.90",
  buildTime: "2026-04-01T22:53:10Z",
  sdkVersion: "0.208.0",
  sdkToken: "sdk-abc",
  billingSalt: "59cf53e54c78",
  clientId: "uuid-1",
  allBetaFlags: ["oauth-2025-04-20", "claude-code-20250219"],
  alwaysOnBetas: ["oauth-2025-04-20", "claude-code-20250219"],
  experimentalBetas: [],
  bedrockUnsupported: ["oauth-2025-04-20"],
  claudeAiScopes: ["user:profile", "user:inference"],
  consoleScopes: ["org:create_api_key"],
  oauthTokenUrl: "https://platform.claude.com/v1/oauth/token",
  oauthRevokeUrl: "https://platform.claude.com/v1/oauth/revoke",
  oauthRedirectUri: "https://platform.claude.com/oauth/code/callback",
  oauthConsoleHost: "platform.claude.com",
  identityStrings: ["You are Claude Code, Anthropic's official CLI for Claude."],
  systemPromptBoundary: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

describe("diffContracts", () => {
  it("returns changed: false for identical contracts", () => {
    const diff = diffContracts(BASE, clone(BASE));
    expect(diff.changed).toBe(false);
    expect(diff.severity).toBe("none");
    expect(Object.keys(diff.fields)).toHaveLength(0);
  });

  it("version-only change → severity: trivial", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE, extracted);
    expect(diff.changed).toBe(true);
    expect(diff.severity).toBe("trivial");
    expect(diff.fields.version).toEqual({ from: "2.1.90", to: "2.1.91" });
  });

  it("version + buildTime change → severity: trivial", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.buildTime = "2026-04-02T21:58:41Z";
    const diff = diffContracts(BASE, extracted);
    expect(diff.changed).toBe(true);
    expect(diff.severity).toBe("trivial");
  });

  it("sdkVersion change → severity: medium", () => {
    const extracted = clone(BASE);
    extracted.sdkVersion = "0.209.0";
    const diff = diffContracts(BASE, extracted);
    expect(diff.changed).toBe(true);
    expect(diff.severity).toBe("medium");
  });

  it("sdkToken change → severity: medium", () => {
    const extracted = clone(BASE);
    extracted.sdkToken = "sdk-xyz";
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("medium");
  });

  it("beta flag added → severity: high", () => {
    const extracted = clone(BASE);
    extracted.allBetaFlags = [...BASE.allBetaFlags, "new-feature-2026-05-01"];
    const diff = diffContracts(BASE, extracted);
    expect(diff.changed).toBe(true);
    expect(diff.severity).toBe("high");
  });

  it("beta flag removed → severity: high", () => {
    const extracted = clone(BASE);
    extracted.alwaysOnBetas = ["oauth-2025-04-20"]; // removed claude-code-20250219
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("high");
  });

  it("OAuth endpoint changed → severity: critical", () => {
    const extracted = clone(BASE);
    extracted.oauthTokenUrl = "https://new.anthropic.com/v1/oauth/token";
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("critical");
  });

  it("identityStrings changed → severity: critical", () => {
    const extracted = clone(BASE);
    extracted.identityStrings = ["You are a new assistant."];
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("critical");
  });

  it("billingSalt changed → severity: critical", () => {
    const extracted = clone(BASE);
    extracted.billingSalt = "aabbccddeeff";
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("critical");
  });

  it("clientId changed → severity: critical", () => {
    const extracted = clone(BASE);
    extracted.clientId = "uuid-2";
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("critical");
  });

  it("unknown field in extracted → severity: medium", () => {
    const extracted = clone(BASE);
    extracted.unknownNewField = "some-value";
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("medium");
    expect(diff.fields.unknownNewField).toEqual({ from: null, to: "some-value" });
  });

  it("max severity wins when multiple fields change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91"; // trivial
    extracted.sdkVersion = "0.209.0"; // medium
    extracted.oauthTokenUrl = "https://new.example.com/token"; // critical
    const diff = diffContracts(BASE, extracted);
    expect(diff.severity).toBe("critical");
    expect(Object.keys(diff.fields)).toHaveLength(3);
  });

  it("array comparison is order-independent", () => {
    const extracted = clone(BASE);
    // Same flags in different order
    extracted.allBetaFlags = ["claude-code-20250219", "oauth-2025-04-20"];
    const diff = diffContracts(BASE, extracted);
    expect(diff.changed).toBe(false);
  });
});

describe("isTrivialDiff", () => {
  it("returns false for unchanged contract", () => {
    const diff = diffContracts(BASE, clone(BASE));
    expect(isTrivialDiff(diff)).toBe(false);
  });

  it("returns true for version-only change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE, extracted);
    expect(isTrivialDiff(diff)).toBe(true);
  });

  it("returns true for version + buildTime change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.buildTime = "2026-04-02T21:58:41Z";
    const diff = diffContracts(BASE, extracted);
    expect(isTrivialDiff(diff)).toBe(true);
  });

  it("returns false when sdkVersion also changes", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.sdkVersion = "0.209.0";
    const diff = diffContracts(BASE, extracted);
    expect(isTrivialDiff(diff)).toBe(false);
  });

  it("returns false for beta flag change", () => {
    const extracted = clone(BASE);
    extracted.allBetaFlags = [...BASE.allBetaFlags, "new-2026-01-01"];
    const diff = diffContracts(BASE, extracted);
    expect(isTrivialDiff(diff)).toBe(false);
  });
});

describe("summarizeDiff", () => {
  it("returns 'No changes detected.' for unchanged contract", () => {
    const diff = diffContracts(BASE, clone(BASE));
    expect(summarizeDiff(diff)).toBe("No changes detected.");
  });

  it("includes severity and changed fields for a real diff", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE, extracted);
    const summary = summarizeDiff(diff);
    expect(summary).toContain("trivial");
    expect(summary).toContain("version");
    expect(summary).toContain("2.1.90");
    expect(summary).toContain("2.1.91");
  });
});

describe("isAutoPatchableDiff", () => {
  it("returns false for unchanged contract", () => {
    const diff = diffContracts(BASE, clone(BASE));
    expect(isAutoPatchableDiff(diff)).toBe(false);
  });

  it("returns true for version-only change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(true);
  });

  it("returns true for version + buildTime + sdkVersion change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.buildTime = "2026-04-02T21:58:41Z";
    extracted.sdkVersion = "0.209.0";
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(true);
  });

  it("returns true for version + experimentalBetas change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.experimentalBetas = ["new-feature-2026-05-01"];
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(true);
  });

  it("returns true for version + bedrockUnsupported change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.bedrockUnsupported = ["new-bedrock-flag-2026-06-01"];
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(true);
  });

  it("returns true for version + alwaysOnBetas change", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.alwaysOnBetas = [...BASE.alwaysOnBetas, "new-always-on-2026-07-01"];
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(true);
  });

  it("returns false when oauthTokenUrl changes (critical — not auto-patchable)", () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.oauthTokenUrl = "https://api.anthropic.com/v1/oauth/token";
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(false);
  });

  it("returns false when billingSalt changes (critical — not auto-patchable)", () => {
    const extracted = clone(BASE);
    extracted.billingSalt = "aabbccddeeff";
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(false);
  });

  it("returns false when identityStrings change (critical — not auto-patchable)", () => {
    const extracted = clone(BASE);
    extracted.identityStrings = ["You are a new assistant."];
    const diff = diffContracts(BASE, extracted);
    expect(isAutoPatchableDiff(diff)).toBe(false);
  });
});
