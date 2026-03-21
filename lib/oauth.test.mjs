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
    expect(init.headers["User-Agent"]).toBe("claude-code/2.1.80");
  });

  it("sends Claude Code user-agent on token refresh", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("claude-code/2.1.80");
  });

  it("sends Claude Code user-agent on token revoke", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await revoke("refresh-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("claude-code/2.1.80");
  });
});
