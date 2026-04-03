import { describe, it, expect } from "vitest";
import { getBaseline, setBaseline, getEtag, setEtag } from "../src/baseline.mjs";

/** Simple in-memory KV mock */
function makeKV() {
  const store = new Map();
  return {
    async get(key, opts) {
      const val = store.get(key) ?? null;
      if (opts?.type === "json" && val !== null) return JSON.parse(val);
      return val;
    },
    async put(key, value, _opts) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const SAMPLE_CONTRACT = {
  version: "2.1.91",
  buildTime: "2026-04-02T21:58:41Z",
  sdkVersion: "0.208.0",
  sdkToken: "sdk-abc",
  billingSalt: "59cf53e54c78",
  clientId: "uuid-1",
  allBetaFlags: ["oauth-2025-04-20"],
  alwaysOnBetas: ["oauth-2025-04-20"],
  experimentalBetas: [],
  bedrockUnsupported: [],
  claudeAiScopes: ["user:profile"],
  consoleScopes: ["org:create_api_key"],
  oauthTokenUrl: "https://platform.claude.com/v1/oauth/token",
  oauthRevokeUrl: "https://platform.claude.com/v1/oauth/revoke",
  oauthRedirectUri: "https://platform.claude.com/oauth/code/callback",
  oauthConsoleHost: "platform.claude.com",
  identityStrings: ["You are Claude Code, Anthropic's official CLI for Claude."],
  systemPromptBoundary: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
};

describe("getBaseline / setBaseline", () => {
  it("returns null when no baseline exists", async () => {
    const kv = makeKV();
    const result = await getBaseline(kv);
    expect(result).toBeNull();
  });

  it("returns null when contract exists but hash is missing", async () => {
    const kv = makeKV();
    await kv.put("baseline:contract", JSON.stringify(SAMPLE_CONTRACT));
    const result = await getBaseline(kv);
    expect(result).toBeNull();
  });

  it("returns null when hash exists but contract is missing", async () => {
    const kv = makeKV();
    await kv.put("baseline:hash", "abc123def456abcd");
    const result = await getBaseline(kv);
    expect(result).toBeNull();
  });

  it("round-trips contract and hash correctly", async () => {
    const kv = makeKV();
    const hash = "abcd1234abcd1234";
    await setBaseline(kv, SAMPLE_CONTRACT, hash);

    const result = await getBaseline(kv);
    expect(result).not.toBeNull();
    expect(result.hash).toBe(hash);
    expect(result.contract.version).toBe("2.1.91");
    expect(result.contract.allBetaFlags).toEqual(["oauth-2025-04-20"]);
  });

  it("overwrites previous baseline on second setBaseline", async () => {
    const kv = makeKV();
    await setBaseline(kv, SAMPLE_CONTRACT, "hash1");

    const updated = { ...SAMPLE_CONTRACT, version: "2.1.92" };
    await setBaseline(kv, updated, "hash2");

    const result = await getBaseline(kv);
    expect(result.contract.version).toBe("2.1.92");
    expect(result.hash).toBe("hash2");
  });

  it("handles invalid JSON in contract gracefully (returns null)", async () => {
    const kv = makeKV();
    await kv.put("baseline:contract", "not-valid-json{{{");
    await kv.put("baseline:hash", "abcd1234abcd1234");
    const result = await getBaseline(kv);
    expect(result).toBeNull();
  });
});

describe("getEtag / setEtag", () => {
  it("returns null when no ETag stored", async () => {
    const kv = makeKV();
    expect(await getEtag(kv)).toBeNull();
  });

  it("round-trips ETag correctly", async () => {
    const kv = makeKV();
    await setEtag(kv, '"W/abc123"');
    expect(await getEtag(kv)).toBe('"W/abc123"');
  });

  it("overwrites previous ETag", async () => {
    const kv = makeKV();
    await setEtag(kv, '"old-etag"');
    await setEtag(kv, '"new-etag"');
    expect(await getEtag(kv)).toBe('"new-etag"');
  });
});
