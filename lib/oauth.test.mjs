import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The revoke gate reads live config. Mocking it keeps these tests independent
// of whatever `~/.config/opencode/anthropic-auth.json` the developer happens to
// have on disk; `{}` reproduces the shipped default (`revoke_on_logout: false`).
const mockLoadConfig = vi.fn(() => ({}));
vi.mock("./config.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: () => mockLoadConfig() };
});

const { authorize, exchange, parseOAuthCallback, refreshToken, revoke } = await import("./oauth.mjs");

const mockFetch = vi.fn();

/** The genuine 2.1.280 token-request header triple, re-typed as literals. */
const EXPECTED_HEADER_ORDER = ["Content-Type", "anthropic-beta", "User-Agent"];
const EXPECTED_USER_AGENT = "anthropic-sdk-typescript/0.112.1 userOAuthProvider";

describe("oauth headers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLoadConfig.mockReturnValue({});
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // T-1.1 — exchange request: URL, method, header set AND ORDER, body key set.
  it("T-1.1 exchange sends the 2.1.280 fingerprint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "",
    });

    await exchange("code#state", "verifier");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    // Order is part of the fingerprint, so assert the key sequence, not membership.
    expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(init.headers["User-Agent"]).toBe(EXPECTED_USER_AGENT);
    expect(Object.keys(JSON.parse(init.body))).toEqual([
      "grant_type",
      "code",
      "redirect_uri",
      "client_id",
      "code_verifier",
      "state",
    ]);
  });

  // T-1.2 — refresh body is exactly three keys. `scope` is the point of the test:
  // a snapshot would pass with the key present, so assert its absence directly.
  it("T-1.2 refresh body has exactly three keys and no scope", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-token");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(["grant_type", "refresh_token", "client_id"]);
    expect("scope" in body).toBe(false);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
    expect(init.headers["User-Agent"]).toBe(EXPECTED_USER_AGENT);
  });

  // T-1.2b — a caller passing `scopes` must not be able to reintroduce the key.
  it("T-1.2b refresh ignores a caller-supplied scopes option", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-token", { scopes: ["user:profile", "user:inference"] });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect("scope" in body).toBe(false);
    expect(Object.keys(body)).toHaveLength(3);
  });

  // T-1.5 — the retired flag must be byte-inert, in both directions.
  it("T-1.5 sdk_token_useragent:false produces identical headers to the key being absent", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => "" });

    await exchange("code#state", "verifier");
    await exchange("code#state", "verifier", { sdkTokenUserAgent: false });
    await exchange("code#state", "verifier", { sdkTokenUserAgent: true });

    const [absent, off, on] = mockFetch.mock.calls.map(([, init]) => init.headers);
    expect(off).toEqual(absent);
    expect(on).toEqual(absent);
    expect(Object.keys(off)).toEqual(Object.keys(absent));
    expect(Object.keys(on)).toEqual(Object.keys(absent));
  });

  // T-1.5b — the same inertness on refresh.
  it("T-1.5b sdk_token_useragent is inert on refresh", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-token");
    await refreshToken("refresh-token", { sdkTokenUserAgent: false });

    const [absent, off] = mockFetch.mock.calls.map(([, init]) => init.headers);
    expect(off).toEqual(absent);
  });

  // T-1.7 — assert on the CALL COUNT, not the return value: a `false` return
  // would also be produced by a request that was made and failed.
  it("T-1.7 revoke with the gate off performs zero fetches", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: false } });

    const result = await revoke("refresh-token");

    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(result).toBe(false);
  });

  it("T-1.7b revoke with no oauth config at all performs zero fetches", async () => {
    mockLoadConfig.mockReturnValue({});

    await revoke("refresh-token");

    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it("T-1.7c revoke performs zero fetches when loadConfig throws", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("unreadable config");
    });

    await expect(revoke("refresh-token")).resolves.toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  // T-1.8 — opting in still sends the SDK fingerprint, never the retired axios one.
  it("T-1.8 revoke with the gate on sends the SDK fingerprint", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await revoke("refresh-token");

    expect(result).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/revoke");
    expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
    expect(init.headers["User-Agent"]).toBe(EXPECTED_USER_AGENT);
    expect(JSON.parse(init.body).client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  it("T-1.8b an explicit revokeOnLogout override beats the config", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: false } });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await revoke("refresh-token", { revokeOnLogout: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // T-1.9 — anthropic-beta survives on both grants.
  it("T-1.9 anthropic-beta is present on exchange and refresh", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "" });
    await exchange("code", "verifier");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });
    await refreshToken("refresh-token");

    for (const [, init] of mockFetch.mock.calls) {
      expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    }
  });

  // T-1.10 — scan the WHOLE header map, not just User-Agent: an axios string
  // reintroduced under any other header name is the same fingerprint.
  it("T-1.10 no axios signal appears in any outbound header", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-token");
    await revoke("refresh-token");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "" });
    await exchange("code", "verifier");

    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of mockFetch.mock.calls) {
      const serialized = Object.entries(init.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      expect(serialized).not.toContain("axios/");
      expect(serialized).not.toContain("0.94.0");
      expect(serialized).not.toContain("text/plain");
    }
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

describe("authorize URL", () => {
  // T-1.3 — the consumer authorize page moved to claude.com/cai/ in 2.1.280.
  it("T-1.3 claude.ai mode targets https://claude.com/cai/oauth/authorize", async () => {
    const { url } = await authorize("max");
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://claude.com");
    expect(parsed.pathname).toBe("/cai/oauth/authorize");
    expect(url.startsWith("https://claude.com/cai/oauth/authorize?")).toBe(true);
    // The old host must not survive anywhere in the URL, including as a param.
    expect(url).not.toContain("claude.ai");
    // Parameter order is wire-visible.
    expect([...parsed.searchParams.keys()]).toEqual([
      "code",
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "state",
    ]);
    expect(parsed.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
  });

  // T-1.4 — the console host is unchanged; assert it did not move with the other.
  it("T-1.4 console mode is unchanged", async () => {
    const { url } = await authorize("console");
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://platform.claude.com");
    expect(parsed.pathname).toBe("/oauth/authorize");
    expect(parsed.searchParams.get("scope")).toBe("org:create_api_key user:profile");
    expect([...parsed.searchParams.keys()]).toEqual([
      "code",
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "state",
    ]);
  });

  // T-2.1 pre-check: the scope string must not drift while the host changes.
  it("T-1.3b claude.ai scope string is the five-scope base set in order", async () => {
    const { url } = await authorize("max");
    expect(new URL(url).searchParams.get("scope")).toBe(
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
  });

  // T-2.6 regression: PKCE material is untouched by the host change.
  it("T-1.3c PKCE verifier, challenge and state keep their shape", async () => {
    const first = await authorize("max");
    const second = await authorize("max");
    const challenge = new URL(first.url).searchParams.get("code_challenge");

    for (const value of [first.verifier, first.state, challenge]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(value.length).toBe(43);
    }
    expect(new URL(first.url).searchParams.get("state")).toBe(first.state);
    expect(second.verifier).not.toBe(first.verifier);
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
