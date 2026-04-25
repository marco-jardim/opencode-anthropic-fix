import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { exchange, parseOAuthCallback, refreshToken, revoke } from "./oauth.mjs";

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

describe("parseOAuthCallback", () => {
  it("returns empty code and null state for empty/falsy input", () => {
    expect(parseOAuthCallback("")).toEqual({ code: "", state: null });
    expect(parseOAuthCallback("   ")).toEqual({ code: "", state: null });
    expect(parseOAuthCallback(null)).toEqual({ code: "", state: null });
  });

  it("handles plain authorization code (no state)", () => {
    expect(parseOAuthCallback("myplaincode123")).toEqual({ code: "myplaincode123", state: null });
  });

  it("trims surrounding whitespace from plain code", () => {
    expect(parseOAuthCallback("  abc123  ")).toEqual({ code: "abc123", state: null });
  });

  it("parses legacy code#state bare format", () => {
    expect(parseOAuthCallback("authcode#statetoken")).toEqual({ code: "authcode", state: "statetoken" });
  });

  it("returns null state when # present but empty state segment", () => {
    expect(parseOAuthCallback("authcode#")).toEqual({ code: "authcode", state: null });
  });

  it("parses full redirect URL with query params", () => {
    expect(parseOAuthCallback("https://example.com/callback?code=MYCODE&state=MYSTATE")).toEqual({
      code: "MYCODE",
      state: "MYSTATE",
    });
  });

  it("parses full redirect URL with only code param", () => {
    expect(parseOAuthCallback("https://example.com/callback?code=ONLYCODE")).toEqual({
      code: "ONLYCODE",
      state: null,
    });
  });

  it("parses query string with leading ?", () => {
    expect(parseOAuthCallback("?code=QS_CODE&state=QS_STATE")).toEqual({
      code: "QS_CODE",
      state: "QS_STATE",
    });
  });

  it("parses bare query string without leading ?", () => {
    expect(parseOAuthCallback("code=BARE_CODE&state=BARE_STATE")).toEqual({
      code: "BARE_CODE",
      state: "BARE_STATE",
    });
  });

  it("parses hash fragment URL (OAuth implicit / SPA flows)", () => {
    expect(parseOAuthCallback("https://example.com/callback#code=HASH_CODE&state=HASH_STATE")).toEqual({
      code: "HASH_CODE",
      state: "HASH_STATE",
    });
  });

  it("parses bare hash fragment string", () => {
    expect(parseOAuthCallback("#code=HFRAG_CODE&state=HFRAG_STATE")).toEqual({
      code: "HFRAG_CODE",
      state: "HFRAG_STATE",
    });
  });

  it("URL-decodes percent-encoded code and state values", () => {
    expect(parseOAuthCallback("?code=hello%20world&state=foo%2Bbar")).toEqual({
      code: "hello world",
      state: "foo+bar",
    });
  });

  it("returns empty string (not null) when state query param is present but empty", () => {
    // state= is explicitly present with an empty value; URLSearchParams.get() returns ""
    // for keys that exist with no value, so state is "" not null.
    expect(parseOAuthCallback("?code=CODE&state=")).toEqual({ code: "CODE", state: "" });
  });

  it("exchange function uses parseOAuthCallback internally (code#state still works)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ access_token: "test_token", token_type: "bearer" }),
      text: async () => '{"access_token":"test_token","token_type":"bearer"}',
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      await exchange("CODE_VALUE#STATE_VALUE", "verifier123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const bodyStr = mockFetch.mock.calls[0][1].body;
      const body = JSON.parse(bodyStr);
      expect(body.code).toBe("CODE_VALUE");
      expect(body.state).toBe("STATE_VALUE");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exchange omits state field in body when input is a plain code", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      await exchange("PLAINCODE", "verifier456");
      const bodyStr = mockFetch.mock.calls[0][1].body;
      const body = JSON.parse(bodyStr);
      expect(body.code).toBe("PLAINCODE");
      expect(Object.prototype.hasOwnProperty.call(body, "state")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
