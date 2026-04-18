import { describe, expect, it, vi } from "vitest";
import { callHaiku } from "./haiku-call.mjs";

describe("callHaiku", () => {
  it("returns text + tokens + cost on 200 response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "summary body here" }],
        usage: { input_tokens: 100, output_tokens: 30 },
      }),
    }));
    const getAccessToken = vi.fn(async () => "oauth-token-abc");

    const result = await callHaiku({
      prompt: "summarize this",
      fetch: fetchMock,
      getAccessToken,
    });

    expect(result.text).toBe("summary body here");
    expect(result.tokens).toEqual({ input: 100, output: 30 });
    // Haiku 4.5 pricing: $1/MTok input, $5/MTok output (2026-04-18)
    // cost = 100/1e6 * 1 + 30/1e6 * 5 = 0.0001 + 0.00015 = 0.00025
    expect(result.cost).toBeCloseTo(0.00025, 8);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.method).toBe("POST");
    expect(opts.headers.authorization).toBe("Bearer oauth-token-abc");
    expect(opts.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "summarize this" }] }]);
  });

  it("throws on non-2xx HTTP response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    const getAccessToken = vi.fn(async () => "oauth-token-abc");

    await expect(callHaiku({ prompt: "x", fetch: fetchMock, getAccessToken })).rejects.toThrow(/HTTP 429/);
  });

  it("throws when response content is missing or not text", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }),
    }));
    const getAccessToken = vi.fn(async () => "oauth-token-abc");

    await expect(callHaiku({ prompt: "x", fetch: fetchMock, getAccessToken })).rejects.toThrow(/no text content/i);
  });

  it("throws when getAccessToken rejects", async () => {
    const fetchMock = vi.fn();
    const getAccessToken = vi.fn(async () => {
      throw new Error("oauth expired");
    });

    await expect(callHaiku({ prompt: "x", fetch: fetchMock, getAccessToken })).rejects.toThrow(/oauth expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
