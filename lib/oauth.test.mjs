import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The revoke gate reads live config. Mocking it keeps these tests independent
// of whatever `~/.config/opencode/anthropic-auth.json` the developer happens to
// have on disk; `{}` reproduces the shipped default (`revoke_on_logout: false`).
const mockLoadConfig = vi.fn(() => ({}));
vi.mock("./config.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: () => mockLoadConfig() };
});

const { authorize, CLAUDE_AI_SCOPES, exchange, parseOAuthCallback, refreshToken, revoke } = await import("./oauth.mjs");

// The attested base union (what `composeScopes` yields with no extras).
const BASE_UNION_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";
// What `authorize` sends by default: the base union plus the emulated profile's
// `oauthAuthorizeScopes` (the genuine 2.1.329 authorize URL, nine scopes).
const UNION_SCOPE = `${BASE_UNION_SCOPE} user:privacy_consents:write org:desktop_config`;

describe("exchange cancellation deadlines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps a fresh per-attempt timeout when a caller signal is supplied", async () => {
    vi.useFakeTimers();
    const deadlines = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(15_000);
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    const caller = new AbortController();
    const signals = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, { signal }) => {
        signals.push(signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }),
    );
    const pending = exchange("code", "verifier", { state: "state", signal: caller.signal });
    const rejected = expect(pending).rejects.toThrow("caller cancelled");
    try {
      expect(deadlines).toHaveLength(1);
      deadlines[0].abort(new globalThis.DOMException("attempt timed out", "TimeoutError"));
      await vi.advanceTimersByTimeAsync(500);
      expect(deadlines).toHaveLength(2);
      expect(signals[1].aborted).toBe(false);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      caller.abort(new Error("caller cancelled"));
      await rejected;
    }
    expect(signals.at(-1).aborted).toBe(true);
  });
});

describe("T-2 scope negotiation", () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue({});
  });

  it("T-2.1 sends the nine-scope profile union by default", async () => {
    const { url } = await authorize("max");
    expect(new URL(url).searchParams.get("scope")).toBe(UNION_SCOPE);
  });

  it("T-2.2 sends the same union in console mode", async () => {
    const { url } = await authorize("console");
    expect(new URL(url).searchParams.get("scope")).toBe(UNION_SCOPE);
  });

  it("T-2.3 an explicit plugins_scope true changes no other authorize parameter", async () => {
    const baseline = new URL((await authorize("max")).url);
    mockLoadConfig.mockReturnValue({ oauth: { plugins_scope: true } });
    const enabled = new URL((await authorize("max")).url);
    expect(enabled.searchParams.get("scope")).toBe(UNION_SCOPE);
    for (const url of [baseline, enabled]) {
      for (const param of ["scope", "code_challenge", "state"]) url.searchParams.delete(param);
    }
    expect(enabled.searchParams.toString()).toBe(baseline.searchParams.toString());
    expect(enabled.origin).toBe(baseline.origin);
    expect(enabled.pathname).toBe(baseline.pathname);
    expect(mockLoadConfig).toHaveBeenCalled();
  });

  it("T-2.3b a configured plugins_scope false removes only user:plugins", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { plugins_scope: false } });
    const { url } = await authorize("max");
    expect(new URL(url).searchParams.get("scope")).toBe(UNION_SCOPE.replace(" user:plugins", ""));
  });

  it("T-2.4 never sends project scopes, even when the deprecated config key is set", async () => {
    mockLoadConfig.mockReturnValue({
      oauth: { plugins_scope: true, project_scopes: ["user:projects:write", "user:projects:read"] },
    });
    for (const mode of ["max", "console"]) {
      const { url } = await authorize(mode, { projectScopes: ["user:projects:read"] });
      const scope = new URL(url).searchParams.get("scope");
      expect(scope).toBe(UNION_SCOPE);
      expect(scope).not.toContain("projects");
    }
  });

  it("T-2.5 console and max carry an identical scope parameter", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { plugins_scope: true } });
    const max = new URL((await authorize("max")).url).searchParams.get("scope");
    const consoleScope = new URL((await authorize("console")).url).searchParams.get("scope");
    expect(consoleScope).toBe(max);
  });

  it("T-2.5b extraScopes are appended after user:plugins in both modes", async () => {
    for (const mode of ["max", "console"]) {
      const { url } = await authorize(mode, {
        extraScopes: ["user:privacy_consents:write", "org:desktop_config"],
      });
      expect(new URL(url).searchParams.get("scope")).toBe(
        `${BASE_UNION_SCOPE} user:privacy_consents:write org:desktop_config`,
      );
    }
  });

  it("T-2.6 preserves PKCE and fresh verifier generation", async () => {
    const first = await authorize("max");
    const second = await authorize("max");
    for (const { url, verifier, state } of [first, second]) {
      const params = new URL(url).searchParams;
      expect(params.get("code_challenge")).toBe(
        Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url"),
      );
      expect(params.get("code_challenge_method")).toBe("S256");
      for (const value of [verifier, state]) {
        expect(value).toHaveLength(43);
        expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    }
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
  });

  it("T-2.7 retains the frozen five-scope compatibility export", () => {
    expect(Array.isArray(CLAUDE_AI_SCOPES)).toBe(true);
    expect(CLAUDE_AI_SCOPES).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
    expect(Object.isFrozen(CLAUDE_AI_SCOPES)).toBe(true);
  });

  it("T-2.8 explicit options beat config in both directions", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { plugins_scope: true } });
    const disabled = await authorize("max", { pluginsRegistered: false });
    expect(new URL(disabled.url).searchParams.get("scope")).toBe(UNION_SCOPE.replace(" user:plugins", ""));
    mockLoadConfig.mockReturnValue({ oauth: { plugins_scope: false } });
    const enabled = await authorize("max", { pluginsRegistered: true });
    expect(new URL(enabled.url).searchParams.get("scope")).toBe(UNION_SCOPE);
  });

  it("rejects a non-boolean explicit pluginsRegistered option", async () => {
    await expect(authorize("max", { pluginsRegistered: "true" })).rejects.toThrow(TypeError);
  });

  it("accepts null authorize options with default scopes", async () => {
    const { url } = await authorize("max", null);
    expect(new URL(url).searchParams.get("scope")).toBe(UNION_SCOPE);
  });

  it("T-2.9 falls back to the full union when config throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockLoadConfig.mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const { url } = await authorize("max");
      expect(new URL(url).searchParams.get("scope")).toBe(UNION_SCOPE);
    } finally {
      warn.mockRestore();
    }
  });
  it("T-2.9b a config read failure warns", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { url } = await authorize("max");
      expect(new URL(url).searchParams.get("scope")).toBe(UNION_SCOPE);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[anthropic-auth\].*scope/));
    } finally {
      warn.mockRestore();
    }
  });

  it("T-2.10 authorize parameter order is unchanged", async () => {
    // The previous order test deleted scope before comparing, so moving the
    // set("scope", ...) line was invisible.
    for (const mode of ["max", "console"]) {
      const { url } = await authorize(mode);
      expect([...new URL(url).searchParams.keys()]).toEqual([
        "code",
        "client_id",
        "response_type",
        "redirect_uri",
        "scope",
        "code_challenge",
        "code_challenge_method",
        "state",
      ]);
    }
  });
});

const mockFetch = vi.fn();

/** The genuine axios header set the plugin controls, re-typed as literals (live capture of the genuine client). */
const EXPECTED_HEADER_ORDER = ["Accept", "Content-Type", "User-Agent", "Accept-Encoding"];
const EXPECTED_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent": "axios/1.15.2",
  "Accept-Encoding": "gzip, compress, deflate, br",
};
const EXPECTED_USER_AGENT = "axios/1.15.2";
const STORED_DEFAULT_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";

const ACKNOWLEDGED = { ok: true, status: 200, headers: new Headers({ "request-id": "req_test" }) };

function okRefreshResponse(extra = {}) {
  return { ok: true, json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600, ...extra }) };
}

function parsedRequest([url, init]) {
  // Compare request content, not the per-request timeout signal's identity.
  return [url, { method: init.method, headers: init.headers, body: JSON.parse(init.body) }];
}

function assertCommonAuthorizeParams(parsedUrl) {
  expect(parsedUrl.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  expect(parsedUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(parsedUrl.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
}

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
  it("T-1.1 exchange sends the genuine axios header set, in order, with no beta", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "",
    });

    await exchange("code#state", "verifier");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    // Order is part of the fingerprint, so assert the key sequence, not membership.
    // This closed-set check is valid only for the code-controlled init object, never a real
    // wire capture: the runtime adds its own headers (Content-Length, Host, Connection).
    expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
    expect(init.headers).toEqual(EXPECTED_HEADERS);
    expect("anthropic-beta" in init.headers).toBe(false);
    expect(init.headers["User-Agent"]).toBe(EXPECTED_USER_AGENT);
    expect(JSON.parse(init.body)).toEqual({
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code_verifier: "verifier",
      state: "state",
    });
  });

  it("T-1.1b exchange always sends state: the pasted callback's, else options.state", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => "" });
    await exchange("code#pasted-state", "verifier");
    await exchange("code", "verifier", { state: "option-state" });
    await exchange("code#same", "verifier", { state: "same" });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const states = mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body).state);
    expect(states).toEqual(["pasted-state", "option-state", "same"]);
    for (const [, init] of mockFetch.mock.calls) {
      expect(Object.keys(JSON.parse(init.body))).toEqual([
        "grant_type",
        "code",
        "redirect_uri",
        "client_id",
        "code_verifier",
        "state",
      ]);
    }
  });

  it("T-1.1c a state mismatch is refused before any request", async () => {
    const result = await exchange("code#attacker-state", "verifier", { state: "expected-state" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "failed", code: "state_mismatch" });
    expect(JSON.stringify(result)).not.toContain("attacker-state");
  });

  it("T-1.1d a bare code with no state falls back to the legacy body and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => "" });
      await exchange("code", "verifier");
      await exchange("code", "verifier");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(Object.keys(body)).toEqual(["grant_type", "code", "redirect_uri", "client_id", "code_verifier"]);
      expect("state" in body).toBe(false);
      const stateWarnings = warn.mock.calls.filter(([message]) => String(message).includes("no OAuth state"));
      expect(stateWarnings.length).toBeLessThan(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("T-1.1e exchange reports the granted scopes", async () => {
    mockFetch.mockResolvedValueOnce(okRefreshResponse({ scope: "user:profile user:inference" }));

    const result = await exchange("code#state", "verifier");

    expect(result).toMatchObject({ type: "success", scopes: ["user:profile", "user:inference"] });
  });

  it("T-1.1f exchange omits scopes when the response carries none", async () => {
    mockFetch.mockResolvedValueOnce(okRefreshResponse());

    const result = await exchange("code#state", "verifier");

    expect(result.type).toBe("success");
    expect("scopes" in result).toBe(false);
  });

  it("T-1.1g a redirect response is a failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 302, text: async () => "" });

    const result = await exchange("code#state", "verifier");

    expect(result).toMatchObject({ type: "failed", status: 302 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // T-1.2 — the refresh body always carries `scope`, last, after the three genuine keys.
  it("T-1.2 refresh body carries the default scope list when no grant is stored", async () => {
    mockFetch.mockResolvedValueOnce(okRefreshResponse());

    await refreshToken("refresh-token");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(["grant_type", "refresh_token", "client_id", "scope"]);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(body.scope).toBe(STORED_DEFAULT_SCOPE);
    expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
    expect(init.headers["User-Agent"]).toBe(EXPECTED_USER_AGENT);
  });

  // T-1.2b — the stored grant is what a refresh requests.
  it("T-1.2b refresh sends the stored scopes", async () => {
    mockFetch.mockResolvedValueOnce(okRefreshResponse());

    await refreshToken("refresh-token", { scopes: ["user:profile", "user:inference"] });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.scope).toBe("user:profile user:inference");
    expect(Object.keys(body)).toEqual(["grant_type", "refresh_token", "client_id", "scope"]);
  });

  it.each([[[]], [undefined], [["", 42]], ["user:profile"]])(
    "T-1.2c refresh falls back to the default list for unusable scopes %j",
    async (scopes) => {
      mockFetch.mockResolvedValueOnce(okRefreshResponse());

      await refreshToken("refresh-token", { scopes });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body).scope).toBe(STORED_DEFAULT_SCOPE);
    },
  );

  it("T-1.2d refresh returns the granted scopes as a list", async () => {
    mockFetch.mockResolvedValueOnce(okRefreshResponse({ scope: "user:profile user:inference" }));

    const json = await refreshToken("refresh-token");

    expect(json.scopes).toEqual(["user:profile", "user:inference"]);
    expect(json.access_token).toBe("a");
  });

  it("T-1.2e invalid_scope is retried once without scope", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: "invalid_scope", error_description: "narrower grant" }),
      })
      .mockResolvedValueOnce(okRefreshResponse({ scope: "user:profile user:inference" }));

    const json = await refreshToken("refresh-token", { scopes: ["user:profile", "user:inference", "user:plugins"] });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [first, second] = mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(Object.keys(first)).toEqual(["grant_type", "refresh_token", "client_id", "scope"]);
    expect(Object.keys(second)).toEqual(["grant_type", "refresh_token", "client_id"]);
    expect(json.scopes).toEqual(["user:profile", "user:inference"]);
  });

  it("T-1.2f invalid_scope is retried only once", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: "invalid_scope" }),
    });

    await expect(refreshToken("refresh-token")).rejects.toMatchObject({ status: 400, code: "invalid_scope" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("T-1.2g a redirect response to a refresh is a failure", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 307, headers: { get: () => null }, text: async () => "" });

    await expect(refreshToken("refresh-token")).rejects.toMatchObject({ status: 307 });
  });

  // T-1.5 — the retired flag must be byte-inert, in both directions.
  it("T-1.5 sdk_token_useragent produces identical requests to the key being absent", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => "" });

    await exchange("code#state", "verifier");
    await exchange("code#state", "verifier", { sdkTokenUserAgent: false });
    await exchange("code#state", "verifier", { sdkTokenUserAgent: true });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [absent, off, on] = mockFetch.mock.calls.map(parsedRequest);
    expect(off).toEqual(absent);
    expect(on).toEqual(absent);
  });

  // T-1.5b — the same inertness on refresh.
  it("T-1.5b sdk_token_useragent is inert on refresh", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-token");
    await refreshToken("refresh-token", { sdkTokenUserAgent: false });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [absent, off] = mockFetch.mock.calls.map(parsedRequest);
    expect(off).toEqual(absent);
  });

  // T-1.7 — assert both the skipped outcome and zero network requests.
  it("T-1.7 revoke with the gate off performs zero fetches", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: false } });

    const result = await revoke("refresh-token");

    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ attempted: false, ok: false });
  });

  it("T-1.7b revoke with no oauth config at all performs zero fetches", async () => {
    mockLoadConfig.mockReturnValue({});

    await expect(revoke("refresh-token")).resolves.toEqual({ attempted: false, ok: false });

    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it("T-1.7c revoke performs zero fetches when loadConfig throws", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("unreadable config");
    });

    await expect(revoke("refresh-token")).resolves.toEqual({ attempted: false, ok: false });
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  // T-1.8 — opting in sends the genuine axios fingerprint to `${TOKEN_URL}/revoke`.
  it("T-1.8 revoke with the gate on sends the axios fingerprint to the token revoke URL", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });
    mockFetch.mockResolvedValueOnce(ACKNOWLEDGED);

    const result = await revoke("refresh-token");

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token/revoke");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
    expect(init.headers).toEqual(EXPECTED_HEADERS);
    expect(JSON.parse(init.body)).toEqual({
      token: "refresh-token",
      token_type_hint: "refresh_token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
  });

  it("T-1.8a a 2xx revoke without a request-id header is not an acknowledgement", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() });

    const result = await revoke("refresh-token");

    expect(result).toMatchObject({ attempted: true, ok: false, status: 200 });
    expect(result.error).toContain("request-id");
  });

  it("T-1.8a2 a non-2xx revoke is not an acknowledgement even with a request-id", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 302, headers: new Headers({ "request-id": "req_x" }) });

    await expect(revoke("refresh-token")).resolves.toEqual({ attempted: true, ok: false, status: 302 });
  });

  it("T-1.8b an explicit revokeOnLogout override beats the config", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: false } });
    mockFetch.mockResolvedValueOnce(ACKNOWLEDGED);

    await expect(revoke("refresh-token", { revokeOnLogout: true })).resolves.toEqual({
      attempted: true,
      ok: true,
      status: 200,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("T-1.8c an explicit false revokeOnLogout override disables configured revocation", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });

    await expect(revoke("refresh-token", { revokeOnLogout: false })).resolves.toEqual({
      attempted: false,
      ok: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  // T-1.9 — the genuine token requests carry no anthropic-beta.
  it("T-1.9 anthropic-beta is absent on exchange, refresh and revoke", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "" });
    await exchange("code#state", "verifier");
    mockFetch.mockResolvedValueOnce(okRefreshResponse());
    await refreshToken("refresh-token");
    mockFetch.mockResolvedValueOnce(ACKNOWLEDGED);
    await revoke("refresh-token");

    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (const [, init] of mockFetch.mock.calls) {
      expect(Object.keys(init.headers).map((name) => name.toLowerCase())).not.toContain("anthropic-beta");
    }
  });

  // T-1.10 — pin the complete code-controlled header map for all three requests.
  it("T-1.10 exchange, refresh and enabled revoke send exactly the axios header set", async () => {
    mockLoadConfig.mockReturnValue({ oauth: { revoke_on_logout: true } });
    mockFetch.mockResolvedValue({ ...okRefreshResponse(), headers: new Headers({ "request-id": "req_x" }) });

    await refreshToken("refresh-token");
    await revoke("refresh-token");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "" });
    await exchange("code#state", "verifier");

    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (const [, init] of mockFetch.mock.calls) {
      expect(init.headers).toEqual(EXPECTED_HEADERS);
      expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
      expect(init.redirect).toBe("manual");
    }
  });

  it("T-1.11 matches the structure of the genuine 2.1.329 exchange fixture", async () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../test/fixtures/oauth/genuine-2.1.329-exchange.json", import.meta.url), "utf8"),
    );
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "" });

    await exchange("code#state", "verifier");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(fixture.url);
    expect(init.method).toBe(fixture.method);
    // The fixture lists every header on the wire; the runtime adds Content-Length, Host and
    // Connection, so the plugin-controlled names must be the fixture's names in the fixture's order.
    expect(fixture.requestHeaderNames.filter((name) => name in init.headers)).toEqual(Object.keys(init.headers));
    expect(Object.keys(init.headers)).toEqual(fixture.pluginControlledHeaderNames);
    expect(Object.keys(JSON.parse(init.body))).toEqual(fixture.requestBodyKeys);
    for (const name of fixture.absentHeaderNames) expect(name in init.headers).toBe(false);
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
    // Parameter set/order, code=true, S256, redirect_uri and URLSearchParams encoding are
    // implementation pins, not evidence: §13.8 records no authorize query string,
    // redirect URI or PKCE material.
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
    assertCommonAuthorizeParams(parsed);
  });

  // T-1.4 — the console host is unchanged; assert it did not move with the other.
  it("T-1.4 console mode uses the platform authorize endpoint and common OAuth parameters", async () => {
    const { url } = await authorize("console");
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://platform.claude.com");
    expect(parsed.pathname).toBe("/oauth/authorize");
    expect(parsed.searchParams.get("scope")).toBe(UNION_SCOPE);
    assertCommonAuthorizeParams(parsed);
    // Parameter set/order, code=true, S256, redirect_uri and URLSearchParams encoding are
    // implementation pins, not evidence: §13.8 records no authorize query string,
    // redirect URI or PKCE material.
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
  it("T-1.3b claude.ai scope string is the nine-scope 2.1.329 LIVE string in order", async () => {
    const { url } = await authorize("max");
    expect(new URL(url).searchParams.get("scope")).toBe(
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins user:privacy_consents:write org:desktop_config",
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
    const expectedChallenge = createHash("sha256")
      .update(first.verifier)
      .digest()
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expectedChallenge);
    expect(first.state).not.toBe(first.verifier);
    expect(first.url).not.toContain(first.verifier);
    expect(second.verifier).not.toBe(first.verifier);
  });

  it("rejects unknown OAuth modes", async () => {
    await expect(authorize("bogus")).rejects.toThrow(/Unknown OAuth mode/);
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

describe("T-3 headless refresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLoadConfig.mockReturnValue({});
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("T-3.5b sends the custom client ID and the declared scopes", async () => {
    mockFetch.mockResolvedValue(okRefreshResponse());

    await refreshToken("rt-abc", {
      clientId: "custom-client-id",
      scopes: ["user:inference"],
      signal: new AbortController().signal,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-abc",
      client_id: "custom-client-id",
      scope: "user:inference",
    });
  });

  it.each([{}, { clientId: "" }, { clientId: 42 }])(
    "T-3.5c defaults an absent or invalid client ID with the four genuine body keys: %j",
    async (options) => {
      mockFetch.mockResolvedValue(okRefreshResponse());

      await refreshToken("rt-abc", options);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      expect(Object.keys(body)).toEqual(["grant_type", "refresh_token", "client_id", "scope"]);
    },
  );

  it("T-3.5d preserves the axios header set with a custom client ID", async () => {
    mockFetch.mockResolvedValue(okRefreshResponse());

    await refreshToken("rt-abc", { clientId: "custom-client-id" });

    const [, init] = mockFetch.mock.calls[0];
    // This closed-set Object.keys check targets only the code-controlled init object, never a wire capture.
    expect(Object.keys(init.headers)).toEqual(EXPECTED_HEADER_ORDER);
    expect(init.headers["User-Agent"]).toBe(EXPECTED_USER_AGENT);
  });
});

describe("T-3 custom OAuth URL guard (B5)", () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue({});
  });

  it.each(["max", "console"])("guards unapproved endpoints in %s mode", async (mode) => {
    await expect(authorize(mode, { env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://evil.example" } })).rejects.toThrow(
      "CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.",
    );
  });

  it.each([
    "https://beacon.claude-ai.staging.ant.dev",
    "https://claude.fedstart.com",
    "https://claude-staging.fedstart.com",
  ])("rejects approved %s that the plugin cannot honour", async (customUrl) => {
    await expect(authorize("max", { env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: customUrl } })).rejects.toThrow(
      /cannot honour it/,
    );
  });

  it.each([{}, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "" }, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "   " }])(
    "accepts an unconfigured URL: %j",
    async (env) => {
      const { url } = await authorize("max", { env });
      expect(new URL(url).origin).toBe("https://claude.com");
      expect(new URL(url).pathname).toBe("/cai/oauth/authorize");
    },
  );

  it.each(["https://claude.fedstart.com/", "https://CLAUDE.fedstart.com"])(
    "does not normalise near-miss %s",
    async (customUrl) => {
      await expect(authorize("max", { env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: customUrl } })).rejects.toThrow(
        "CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.",
      );
    },
  );
});

describe("T-3 process.env fallback (M4)", () => {
  let previousCustomOAuthUrl;

  beforeEach(() => {
    previousCustomOAuthUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue({});
  });

  afterEach(() => {
    if (previousCustomOAuthUrl === undefined) {
      delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
    } else {
      process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = previousCustomOAuthUrl;
    }
  });

  it("rejects an unapproved process.env endpoint without an env option", async () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://evil.example";
    await expect(authorize("max")).rejects.toMatchObject({
      message: "CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.",
    });
  });

  it("rejects an approved process.env endpoint that it cannot honour", async () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://claude.fedstart.com";
    await expect(authorize("max")).rejects.toThrow(/cannot honour it/);
  });

  it("uses the consumer authorize URL when the variable is absent", async () => {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
    const { url } = await authorize("max");
    expect(new URL(url).origin).toBe("https://claude.com");
    expect(new URL(url).pathname).toBe("/cai/oauth/authorize");
  });

  it("lets an explicit empty env override a hostile process.env", async () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://evil.example";
    const { url } = await authorize("max", { env: {} });
    expect(new URL(url).origin).toBe("https://claude.com");
    expect(new URL(url).pathname).toBe("/cai/oauth/authorize");
  });
});
