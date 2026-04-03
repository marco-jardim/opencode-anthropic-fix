import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRegistryMetadata, encodePackageName } from "../src/registry.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── encodePackageName ───────────────────────────────────────────────────────

describe("encodePackageName", () => {
  it("encodes scoped package name", () => {
    expect(encodePackageName("@anthropic-ai/claude-code")).toBe("@anthropic-ai%2Fclaude-code");
  });

  it("leaves unscoped package name unchanged", () => {
    expect(encodePackageName("express")).toBe("express");
  });

  it("handles scope without package name part", () => {
    expect(encodePackageName("@scope")).toBe("@scope");
  });
});

// ─── fetchRegistryMetadata ───────────────────────────────────────────────────

describe("fetchRegistryMetadata", () => {
  it("returns version and tarball URL on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ etag: '"abc123"' }),
        json: async () => ({
          version: "2.1.91",
          dist: { tarball: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.91.tgz" },
        }),
      }),
    );

    const result = await fetchRegistryMetadata("@anthropic-ai/claude-code", null);
    expect(result.version).toBe("2.1.91");
    expect(result.tarballUrl).toContain("2.1.91");
    expect(result.etag).toBe('"abc123"');
    expect(result.notModified).toBe(false);
  });

  it("returns notModified: true on 304 (ETag match)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        status: 304,
        headers: new Headers({}),
        json: async () => ({}),
      }),
    );

    const result = await fetchRegistryMetadata("@anthropic-ai/claude-code", '"cached-etag"');
    expect(result.notModified).toBe(true);
    expect(result.etag).toBe('"cached-etag"');
  });

  it("sends If-None-Match header when cachedEtag is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 304,
      headers: new Headers({}),
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchRegistryMetadata("@anthropic-ai/claude-code", '"my-etag"');

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers["If-None-Match"]).toBe('"my-etag"');
  });

  it("does not send If-None-Match when no cached ETag", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      headers: new Headers({}),
      json: async () => ({
        version: "2.1.91",
        dist: { tarball: "https://example.com/pkg.tgz" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchRegistryMetadata("@anthropic-ai/claude-code", null);

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers["If-None-Match"]).toBeUndefined();
  });

  it("retries on 502 and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 502,
          headers: new Headers({}),
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers({}),
          json: async () => ({
            version: "2.1.91",
            dist: { tarball: "https://example.com/pkg.tgz" },
          }),
        }),
    );

    // Advance fake timers automatically as the promise chain progresses
    const resultPromise = fetchRegistryMetadata("@anthropic-ai/claude-code");
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();
    expect(result.version).toBe("2.1.91");
  });

  it("throws after exhausting retries on repeated 503", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 503,
        headers: new Headers({}),
        json: async () => ({}),
      }),
    );

    // Attach rejection handler before running timers to avoid unhandled rejection warning
    const rejectPromise = fetchRegistryMetadata("@anthropic-ai/claude-code").catch((e) => e);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const err = await rejectPromise;
    expect(err.message).toContain("503");
  });

  it("throws immediately on 404 (non-retryable client error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        status: 404,
        headers: new Headers({}),
        json: async () => ({}),
      }),
    );

    await expect(fetchRegistryMetadata("@anthropic-ai/claude-code")).rejects.toThrow("404");
  });

  it("throws when response is missing version field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({}),
        json: async () => ({ dist: { tarball: "https://example.com/pkg.tgz" } }),
      }),
    );

    await expect(fetchRegistryMetadata("@anthropic-ai/claude-code")).rejects.toThrow("missing version or tarball");
  });

  it("throws on request timeout (AbortError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }),
    );

    // Use very short timeout by mocking setTimeout to fire immediately
    await expect(fetchRegistryMetadata("@anthropic-ai/claude-code")).rejects.toThrow();
  });
});
