import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { exchange, refreshToken, revoke } from "./oauth.mjs";

const mockFetch = vi.fn();

describe("oauth headers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Claude Code user-agent on token exchange", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "",
    });

    await exchange("code#state", "verifier");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("axios/1.13.6");
  });

  it("sends Claude Code user-agent on token refresh", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("axios/1.13.6");
  });

  it("sends Claude Code user-agent on token revoke", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await revoke("refresh-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("axios/1.13.6");
  });

  it("parses Anthropic nested error payloads on exchange failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { type: "invalid_grant", message: "Bad auth code." } }),
    });

    const result = await exchange("code#state", "verifier");
    expect(result.type).toBe("failed");
    expect(result.status).toBe(400);
    expect(result.code).toBe("invalid_grant");
    expect(result.reason).toBe("Bad auth code.");
  });

  it("retries token exchange on 429 before succeeding", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key) => (key === "retry-after-ms" ? "1" : null) },
        text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: "retry" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          account: { email_address: "retry@example.com" },
        }),
      });

    const result = await exchange("code#state", "verifier");
    expect(result.type).toBe("success");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries token refresh on 429 before succeeding", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key) => (key === "retry-after-ms" ? "1" : null) },
        text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: "retry" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
      });

    const result = await refreshToken("refresh-token");
    expect(result.access_token).toBe("a");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses nested error type as refresh error code", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { type: "invalid_grant", message: "Bad refresh token." } }),
    });

    await expect(refreshToken("refresh-token")).rejects.toMatchObject({
      status: 400,
      code: "invalid_grant",
    });
  });

  it("returns cooldown hint on exchange 429 without Retry-After headers", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited" } }),
      });

      const promise = exchange("code#state", "verifier");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toMatchObject({
        type: "failed",
        status: 429,
        code: "rate_limit_error",
        retryAfterMs: 30_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws 30s cooldown hint on refresh 429 without Retry-After headers", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited" } }),
      });

      const assertion = expect(refreshToken("refresh-token")).rejects.toMatchObject({
        status: 429,
        code: "rate_limit_error",
        retryAfterMs: 30_000,
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
