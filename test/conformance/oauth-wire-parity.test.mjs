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
});

describe("meta", () => {
  it("meta: every attested contract §2 row has exactly one assertion", () => {
    const contractSource = readFileSync(new URL("../../docs/oauth-2.1.280-contract.md", import.meta.url), "utf8");
    const testSource = readFileSync(new URL("./oauth-wire-parity.test.mjs", import.meta.url), "utf8");
    const ids = [];
    let section = null;
    for (const line of contractSource.split(/\r?\n/)) {
      if (/^#{1,3}\s/.test(line)) {
        section = line.match(/^###\s+(2\.\d+)\)/)?.[1] ?? null;
      }
      if (!section || section === "2.2" || section === "2.4") continue;
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
    for (const id of ids) {
      expect(testSource.split(`"${id}"`).length - 1, id).toBe(1);
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
