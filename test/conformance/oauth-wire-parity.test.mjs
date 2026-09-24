/**
 * Executable half of docs/oauth-2.1.280-contract.md §2: every attested row
 * has exactly one assertion here, and the meta-test fails for an unmapped row.
 * §2.2 (exchange) is exempt under divergence D8; §2.4 (federation) is exempt
 * under divergence D12. Both exemptions are declared in the contract itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mockLoadConfig = vi.fn(() => ({}));
vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: () => mockLoadConfig() };
});

const { authorize, refreshToken } = await import("../../lib/oauth.mjs");
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
  mockLoadConfig.mockReset();
  mockLoadConfig.mockReturnValue({});
});

it("contract §2.1 URL (consumer)", async () => {
  const { url } = await authorize("max");
  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://claude.com");
  expect(parsed.pathname).toBe("/cai/oauth/authorize");
  expect(url).not.toContain("claude.ai/oauth");
});

it("contract §2.1 URL (console)", async () => {
  const { url } = await authorize("console");
  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://platform.claude.com");
  expect(parsed.pathname).toBe("/oauth/authorize");
});

it("contract §2.3 Method", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token");
  const [url, init] = mockFetch.mock.calls[0];
  expect(init.method).toBe("POST");
  expect(url).toBe("https://platform.claude.com/v1/oauth/token");
});

it("contract §2.3 Header 1", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token");
  const [, init] = mockFetch.mock.calls[0];
  expect(init.headers["Content-Type"]).toBe("application/json");
  // Closed-set check: legal ONLY because `init` is the object this code builds
  // and hands to fetch. It must never be applied to a wire capture — §13.8
  // enumerates what it found, not a closed set, so asserting absence there would
  // pin an artefact of the evidence rather than the client.
  expect(Object.keys(init.headers)).toEqual(["Content-Type", "anthropic-beta", "User-Agent"]);
});

it("contract §2.3 Header 2", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token");
  const [, init] = mockFetch.mock.calls[0];
  expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
});

it("contract §2.3 Header 3", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token");
  const [, init] = mockFetch.mock.calls[0];
  expect(init.headers["User-Agent"]).toBe("anthropic-sdk-typescript/0.112.1 userOAuthProvider");
});

it("contract §2.3 Body keys", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token");
  const [, init] = mockFetch.mock.calls[0];
  const body = JSON.parse(init.body);
  expect(Object.keys(body)).toEqual(["grant_type", "refresh_token", "client_id"]);
  expect(body.grant_type).toBe("refresh_token");
  expect("scope" in body).toBe(false);
  expect(init.body).toBe(
    JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: "refresh-token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    }),
  );
});

it("guard: ignored refresh options never reach the wire", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token", {
    scopes: ["user:profile", "user:inference"],
    sdkTokenUserAgent: false,
    // clientId is honoured for headless accounts, not ignored; pin only its empty-string fallback.
    clientId: "",
  });
  const [, init] = mockFetch.mock.calls[0];
  const body = JSON.parse(init.body);
  expect(body).toEqual({
    grant_type: "refresh_token",
    refresh_token: "refresh-token",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  });
  expect("scope" in body).toBe(false);
  expect(init.headers["User-Agent"]).toBe("anthropic-sdk-typescript/0.112.1 userOAuthProvider");
});

it("guard: a supplied clientId is honoured, and only in client_id", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token", { clientId: "custom-client-id" });
  const [, init] = mockFetch.mock.calls[0];
  const body = JSON.parse(init.body);
  expect(body).toEqual({
    grant_type: "refresh_token",
    refresh_token: "refresh-token",
    client_id: "custom-client-id",
  });
  expect(Object.keys(body)).toEqual(["grant_type", "refresh_token", "client_id"]);
  expect(init.headers).toEqual({
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "anthropic-sdk-typescript/0.112.1 userOAuthProvider",
  });
});

it("guard: the token endpoint host is never changed", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
  });
  await refreshToken("refresh-token");
  // Divergence D6: the SDK path is relative and BASE_API_URL is a different host.
  expect(mockFetch.mock.calls[0][0]).toBe("https://platform.claude.com/v1/oauth/token");
});

describe("meta", () => {
  it("meta: the assertion checker rejects empty blocks and string or comment decoys", () => {
    const fixture = `
      /* "empty" */
      const titles = ["empty"];
      it("asserted", () => { expect(true).toBe(true); });
      // "empty"
      it("empty", () => {});
        it("following", () => { expect(true).toBe(true); });
    `;
    const blocks = blocksWithAssertions(fixture);
    expect(blocks.get("asserted")).toBe(true);
    expect(blocks.get("empty")).toBe(false);
    for (const boundary of ["test", "it.skip", "it.each", "describe"]) {
      const decoys = `
        it("decoy", () => {
          // expect(true).toBe(true);
          /* expect(true).toBe(true); */
          const text = "expect(";
          const template = \`expect(\`;
        });
          ${boundary}("following", () => { expect(true).toBe(true); });
      `;
      expect(blocksWithAssertions(decoys).get("decoy"), boundary).toBe(false);
    }
    expect(blocksWithAssertions('\nit.skip("not a plain it", () => { expect(true); });').has("not a plain it")).toBe(
      false,
    );
  });

  it("meta: every attested contract §2 row has exactly one assertion", () => {
    const contractSource = readFileSync(new URL("../../docs/oauth-2.1.280-contract.md", import.meta.url), "utf8");
    const testSource = readFileSync(new URL("./oauth-wire-parity.test.mjs", import.meta.url), "utf8");
    const exemptSections = new Set();
    for (const match of contractSource.matchAll(/^###\s+(2\.\d+)\)[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/gm)) {
      if (/meta-test/i.test(match[2]) && /\b(?:exempt|excluded)\b/i.test(match[2])) {
        exemptSections.add(match[1]);
      }
    }
    expect(exemptSections).toEqual(new Set(["2.2", "2.4"]));
    const ids = [];
    let section = null;
    for (const line of contractSource.split(/\r?\n/)) {
      if (/^#{1,3}\s/.test(line)) {
        section = line.match(/^###\s+(2\.\d+)\)/)?.[1] ?? null;
      }
      if (!section || exemptSections.has(section)) continue;
      const row = line.match(/^\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$/);
      if (!row) continue;
      const field = row[1].trim();
      const status = row[3].trim();
      if (field === "Field" || /^:?-+:?$/.test(field)) continue;
      if (status.includes("[unattested") || status === "—") continue;
      ids.push(`contract §${section} ${field}`);
    }

    // Without this, the doc-to-test mapping rots on the first added row.
    // Template literals keep the expected list out of the exact quoted-title count.
    expect(ids).toEqual([
      `contract §2.1 URL (consumer)`,
      `contract §2.1 URL (console)`,
      `contract §2.3 Method`,
      `contract §2.3 Header 1`,
      `contract §2.3 Header 2`,
      `contract §2.3 Header 3`,
      `contract §2.3 Body keys`,
    ]);
    const blocks = blocksWithAssertions(testSource);
    for (const id of ids) {
      expect(testSource.split(`"${id}"`).length - 1, id).toBe(1);
      // A title that maps to an empty body maps to nothing.
      expect(blocks.has(id), id).toBe(true);
      expect(blocks.get(id), id).toBe(true);
    }
  });

  it("meta: the exemptions are declared in the contract, not here", () => {
    const contractSource = readFileSync(new URL("../../docs/oauth-2.1.280-contract.md", import.meta.url), "utf8");
    const normalized = contractSource.replace(/\s+/g, " ");
    // The exemptions must live in the document, so they cannot be quietly widened inside this test file.
    expect(normalized).toContain("excluded from the §8 meta-test");
    expect(normalized).toContain("exempt from the §8 conformance meta-test");
  });
});

function blocksWithAssertions(source) {
  const literals = [];
  // Tokenize strings together with comments so URL slashes are not mistaken for comments.
  // Replace string contents with inert tokens, retaining only their titles for lookup.
  const stripped = source.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token) => {
      if (token.startsWith("/")) return token.replace(/[^\r\n]/g, " ");
      literals.push(token.slice(1, -1));
      return `"${literals.length - 1}"`;
    },
  );
  const boundary = /\n\s*(?:it|test|describe)(?:\.\w+)*\s*\(/g;
  const working = `\n${stripped}`;
  const openers = [...working.matchAll(boundary)];
  const blocks = working.split(boundary).slice(1);
  const assertions = new Map();
  for (const [index, block] of blocks.entries()) {
    if (!/^\s*it\s*\($/.test(openers[index][0])) continue;
    const title = block.match(/^\s*["'`](.+?)["'`]/);
    if (title) assertions.set(literals[Number(title[1])], /\bexpect\s*\(/.test(block));
  }
  return assertions;
}
