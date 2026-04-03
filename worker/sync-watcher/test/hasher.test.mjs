import { describe, it, expect } from "vitest";
import { canonicalize, hashContract } from "../src/hasher.mjs";

// ---------------------------------------------------------------------------
// Minimal ExtractedContract factory — only sets the fields needed per test.
// ---------------------------------------------------------------------------
function makeContract(overrides = {}) {
  return {
    version: "2.1.90",
    buildTime: null,
    sdkVersion: "0.50.0",
    sdkToken: null,
    billingSalt: null,
    clientId: null,
    allBetaFlags: ["oauth-2025-04-20", "files-api-2025-04-14"],
    alwaysOnBetas: ["oauth-2025-04-20"],
    experimentalBetas: [],
    bedrockUnsupported: [],
    claudeAiScopes: [],
    consoleScopes: [],
    oauthTokenUrl: "https://auth.example.com/oauth/token",
    oauthRevokeUrl: null,
    oauthRedirectUri: null,
    oauthConsoleHost: null,
    identityStrings: ["Claude Code", "claude-code"],
    systemPromptBoundary: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalize — synchronous unit tests
// ---------------------------------------------------------------------------
describe("canonicalize", () => {
  it("sorts top-level keys alphabetically", () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("sorts array elements lexicographically by canonical form", () => {
    const result = canonicalize({ nums: [3, 1, 2] });
    expect(result).toBe('{"nums":[1,2,3]}');
  });

  it("sorts string arrays lexicographically", () => {
    const result = canonicalize(["banana", "apple", "cherry"]);
    expect(result).toBe('["apple","banana","cherry"]');
  });

  it("handles nested objects recursively — inner keys also sorted", () => {
    const result = canonicalize({
      b: [3, 1, 2],
      a: null,
      c: { z: "x", a: "y" },
    });
    expect(result).toBe('{"a":null,"b":[1,2,3],"c":{"a":"y","z":"x"}}');
  });

  it("preserves null values", () => {
    const result = canonicalize({ x: null, y: "hello" });
    expect(result).toBe('{"x":null,"y":"hello"}');
  });

  it("produces identical output regardless of key insertion order", () => {
    const obj1 = { a: 1, b: 2, c: 3 };
    const obj2 = { c: 3, a: 1, b: 2 };
    const obj3 = { b: 2, c: 3, a: 1 };
    const canonical1 = canonicalize(obj1);
    expect(canonicalize(obj2)).toBe(canonical1);
    expect(canonicalize(obj3)).toBe(canonical1);
  });

  it("serialises an ExtractedContract-shaped object deterministically", () => {
    const c = makeContract();
    // Should not throw and should start/end with braces
    const out = canonicalize(c);
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
    // Keys must appear in sorted order — "allBetaFlags" before "alwaysOnBetas"
    expect(out.indexOf('"allBetaFlags"')).toBeLessThan(out.indexOf('"alwaysOnBetas"'));
  });
});

// ---------------------------------------------------------------------------
// hashContract — async tests (Web Crypto)
// ---------------------------------------------------------------------------
describe("hashContract", () => {
  it("returns a 16-character lowercase hex string", async () => {
    const hash = await hashContract(makeContract());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable — same contract produces the same hash on successive calls", async () => {
    const contract = makeContract();
    const h1 = await hashContract(contract);
    const h2 = await hashContract(contract);
    expect(h1).toBe(h2);
  });

  it("produces a different hash when version changes (v2.1.90 → v2.1.91)", async () => {
    const h90 = await hashContract(makeContract({ version: "2.1.90" }));
    const h91 = await hashContract(makeContract({ version: "2.1.91" }));
    expect(h90).not.toBe(h91);
  });

  it("produces a different hash when a beta flag is added", async () => {
    const base = makeContract({ allBetaFlags: ["oauth-2025-04-20"] });
    const extended = makeContract({
      allBetaFlags: ["oauth-2025-04-20", "new-flag-2025-05-01"],
    });
    const hBase = await hashContract(base);
    const hExtended = await hashContract(extended);
    expect(hBase).not.toBe(hExtended);
  });

  it("produces a different hash when a beta flag is removed", async () => {
    const withFlag = makeContract({ alwaysOnBetas: ["oauth-2025-04-20"] });
    const withoutFlag = makeContract({ alwaysOnBetas: [] });
    const h1 = await hashContract(withFlag);
    const h2 = await hashContract(withoutFlag);
    expect(h1).not.toBe(h2);
  });

  it("produces a different hash for a minor field change (sdkVersion patch bump)", async () => {
    const h1 = await hashContract(makeContract({ sdkVersion: "0.50.0" }));
    const h2 = await hashContract(makeContract({ sdkVersion: "0.50.1" }));
    expect(h1).not.toBe(h2);
  });

  it("produces the same hash regardless of allBetaFlags insertion order", async () => {
    const h1 = await hashContract(makeContract({ allBetaFlags: ["oauth-2025-04-20", "files-api-2025-04-14"] }));
    const h2 = await hashContract(makeContract({ allBetaFlags: ["files-api-2025-04-14", "oauth-2025-04-20"] }));
    // canonicalize sorts arrays → both should produce identical hash
    expect(h1).toBe(h2);
  });
});
