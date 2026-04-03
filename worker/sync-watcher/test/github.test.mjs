/**
 * Unit tests for github.mjs — GitHub REST API client.
 *
 * All tests stub the global `fetch` to avoid real network calls.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  githubRequest,
  getFileContent,
  updateFile,
  getBranchSha,
  findExistingPR,
  findExistingIssue,
} from "../src/github.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = "ghp_test_token";
const REPO = "owner/repo";

// ─── githubRequest ────────────────────────────────────────────────────────────

describe("githubRequest", () => {
  it("sends Bearer auth header and User-Agent", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({}),
      json: async () => ({ number: 1, html_url: "https://github.com/pr/1" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await githubRequest(TOKEN, "GET", "/repos/owner/repo/pulls");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("api.github.com");
    expect(opts.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(opts.headers["User-Agent"]).toMatch(/sync-watcher/);
  });

  it("returns { status, data } on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ id: 42 }),
      }),
    );

    const result = await githubRequest(TOKEN, "GET", "/repos/owner/repo/pulls");
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ id: 42 });
  });

  it("returns { status: 204, data: null } on 204 No Content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 204,
        headers: new Headers({}),
        json: async () => {
          throw new Error("no body");
        },
      }),
    );

    const result = await githubRequest(TOKEN, "DELETE", "/repos/owner/repo/git/refs/heads/test");
    expect(result.status).toBe(204);
    expect(result.data).toBeNull();
  });

  it("throws on rate limit (403 + x-ratelimit-remaining: 0)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 403,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1800000000",
        }),
        json: async () => ({}),
      }),
    );

    await expect(githubRequest(TOKEN, "GET", "/repos/owner/repo")).rejects.toThrow("rate limit");
  });

  it("throws on auth failure (403 without rate limit)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 403,
        headers: new Headers({ "x-ratelimit-remaining": "59" }),
        json: async () => ({ message: "Resource not accessible by integration" }),
      }),
    );

    await expect(githubRequest(TOKEN, "GET", "/repos/owner/repo")).rejects.toThrow("auth/permission error");
  });

  it("throws on 429 rate limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 429,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1800000000",
        }),
        json: async () => ({}),
      }),
    );

    await expect(githubRequest(TOKEN, "POST", "/repos/owner/repo/issues")).rejects.toThrow("rate limit");
  });

  it("retries once on 5xx and succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 503,
          headers: new Headers({}),
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          status: 201,
          headers: new Headers({}),
          json: async () => ({ number: 5, html_url: "https://github.com/pr/5" }),
        }),
    );

    const result = await githubRequest(TOKEN, "POST", "/repos/owner/repo/pulls", { title: "test" });
    expect(result.status).toBe(201);
  });

  it("throws after exhausting 5xx retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 500,
        headers: new Headers({}),
        json: async () => ({}),
      }),
    );

    await expect(githubRequest(TOKEN, "POST", "/repos/owner/repo/pulls", {})).rejects.toThrow("server error 500");
  });

  it("throws on AbortError (timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }),
    );

    await expect(githubRequest(TOKEN, "GET", "/repos/owner/repo")).rejects.toThrow("timed out");
  });
});

// ─── Base64 UTF-8 roundtrip ───────────────────────────────────────────────────

describe("getFileContent / updateFile — UTF-8 roundtrip", () => {
  it("decodes ASCII content correctly", async () => {
    const original = 'const x = "hello world";';
    const encoded = btoa(original);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ content: encoded, sha: "abc" }),
      }),
    );

    const { content } = await getFileContent(TOKEN, REPO, "index.mjs", "master");
    expect(content).toBe(original);
  });

  it("decodes UTF-8 multi-byte content (emoji) correctly", async () => {
    const original = "// 🚀 launch\nconst x = 1;";
    // Encode properly: UTF-8 bytes → base64
    const bytes = new TextEncoder().encode(original);
    const encoded = btoa(String.fromCharCode(...bytes));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ content: encoded, sha: "abc" }),
      }),
    );

    const { content } = await getFileContent(TOKEN, REPO, "index.mjs", "master");
    expect(content).toBe(original);
  });

  it("decodes content with embedded newlines in base64 (GitHub response style)", async () => {
    const original = "line1\nline2\n";
    const bytes = new TextEncoder().encode(original);
    const rawB64 = btoa(String.fromCharCode(...bytes));
    // GitHub adds newlines every 60 chars
    const chunked = rawB64.match(/.{1,60}/g)?.join("\n") ?? rawB64;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ content: chunked, sha: "sha1" }),
      }),
    );

    const { content } = await getFileContent(TOKEN, REPO, "index.mjs", "master");
    expect(content).toBe(original);
  });

  it("encodes UTF-8 content correctly via updateFile", async () => {
    const content = "const msg = 'héllo wörld 中文';";
    let capturedBody;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          status: 200,
          headers: new Headers({}),
          json: async () => ({ content: {}, commit: {} }),
        };
      }),
    );

    await updateFile(TOKEN, REPO, "index.mjs", "main", content, "sha1", "chore: update");

    // Decode the transmitted base64 back to string
    const transmitted = capturedBody.content;
    const binaryStr = atob(transmitted);
    const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe(content);
  });

  it("roundtrip: encode then decode produces identical content", async () => {
    const original = "// Copyright © 2026 Anthropic 🤖\nconst x = 1;";
    let encodedForTransmit;

    // Capture what updateFile would send
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url, opts) => {
        encodedForTransmit = JSON.parse(opts.body).content;
        return { status: 200, headers: new Headers({}), json: async () => ({}) };
      }),
    );
    await updateFile(TOKEN, REPO, "file.mjs", "main", original, "sha", "msg");

    // Now simulate getFileContent receiving that same base64
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ content: encodedForTransmit, sha: "sha" }),
      }),
    );
    const { content } = await getFileContent(TOKEN, REPO, "file.mjs", "main");
    expect(content).toBe(original);
  });
});

// ─── getBranchSha ─────────────────────────────────────────────────────────────

describe("getBranchSha", () => {
  it("returns commit SHA from ref response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ object: { sha: "deadbeef1234" } }),
      }),
    );

    const sha = await getBranchSha(TOKEN, REPO, "master");
    expect(sha).toBe("deadbeef1234");
  });
});

// ─── findExistingPR / findExistingIssue ───────────────────────────────────────

describe("findExistingPR", () => {
  it("returns PR info when a matching PR exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => [{ number: 42, html_url: "https://github.com/pr/42" }],
      }),
    );

    const result = await findExistingPR(TOKEN, REPO, "auto/sync-2.1.91");
    expect(result).toEqual({ number: 42, html_url: "https://github.com/pr/42" });
  });

  it("returns null when no matching PR exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => [],
      }),
    );

    const result = await findExistingPR(TOKEN, REPO, "auto/sync-2.1.91");
    expect(result).toBeNull();
  });
});

describe("findExistingIssue", () => {
  it("returns issue info when a matching issue exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({
          items: [{ number: 7, html_url: "https://github.com/issues/7" }],
        }),
      }),
    );

    const result = await findExistingIssue(TOKEN, REPO, "Claude Code v2.1.91");
    expect(result).toEqual({ number: 7, html_url: "https://github.com/issues/7" });
  });

  it("returns null when no matching issue exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ items: [] }),
      }),
    );

    const result = await findExistingIssue(TOKEN, REPO, "Claude Code v2.1.91");
    expect(result).toBeNull();
  });
});
