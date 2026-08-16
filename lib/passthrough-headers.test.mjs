import { afterEach, describe, expect, it, vi } from "vitest";

import { OAUTH_BETA_FLAG, buildPassthroughHeaders, stripNonApiBodyFields } from "./passthrough-headers.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildPassthroughHeaders", () => {
  it("keeps the host's headers untouched and adds only the auth envelope", () => {
    const headers = buildPassthroughHeaders(
      undefined,
      { headers: { "content-type": "application/json", "user-agent": "opencode/1.2.3", "x-trace": "abc" } },
      "token-1",
    );

    expect([...headers.entries()]).toEqual([
      ["anthropic-beta", OAUTH_BETA_FLAG],
      ["authorization", "Bearer token-1"],
      ["content-type", "application/json"],
      ["user-agent", "opencode/1.2.3"],
      ["x-trace", "abc"],
    ]);
  });

  it("appends the OAuth beta to the host's list instead of replacing it", () => {
    const headers = buildPassthroughHeaders(
      undefined,
      { headers: { "anthropic-beta": "prompt-caching-2024-07-31, context-1m-2025-08-07" } },
      "token-1",
    );

    expect(headers.get("anthropic-beta")).toBe(`prompt-caching-2024-07-31,context-1m-2025-08-07,${OAUTH_BETA_FLAG}`);
  });

  it("does not duplicate the OAuth beta the host already sent", () => {
    const headers = buildPassthroughHeaders(
      undefined,
      { headers: { "anthropic-beta": `${OAUTH_BETA_FLAG},prompt-caching-2024-07-31` } },
      "token-1",
    );

    expect(headers.get("anthropic-beta")).toBe(`${OAUTH_BETA_FLAG},prompt-caching-2024-07-31`);
  });

  it("strips the competing credential and the session-affinity hint", () => {
    const headers = buildPassthroughHeaders(
      undefined,
      { headers: { "x-api-key": "sk-ant-nope", "x-session-affinity": "aff-1", accept: "text/event-stream" } },
      "token-1",
    );

    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-session-affinity")).toBeNull();
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  it("reads headers off a Request input, with the init taking precedence", () => {
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-from-request": "yes", "content-type": "application/json" },
    });

    const headers = buildPassthroughHeaders(request, { headers: { "content-type": "application/vnd.test" } }, "t");

    expect(headers.get("x-from-request")).toBe("yes");
    expect(headers.get("content-type")).toBe("application/vnd.test");
  });

  it("accepts every HeadersInit carrier the host may use", () => {
    const fromArray = buildPassthroughHeaders(undefined, { headers: [["x-a", "1"]] }, "t");
    const fromHeaders = buildPassthroughHeaders(undefined, { headers: new Headers({ "x-a": "1" }) }, "t");

    expect(fromArray.get("x-a")).toBe("1");
    expect(fromHeaders.get("x-a")).toBe("1");
  });

  it("prefers the ANTHROPIC_AUTH_TOKEN override for the bearer", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "  manual-token  ");

    expect(buildPassthroughHeaders(undefined, {}, "account-token").get("authorization")).toBe("Bearer manual-token");
  });
});

describe("stripNonApiBodyFields", () => {
  it("returns the original string when there is nothing to strip", () => {
    const body = JSON.stringify({ model: "claude-sonnet-4-5", messages: [] });

    // Identity, not equality: the passthrough claim is byte-level.
    expect(stripNonApiBodyFields(body)).toBe(body);
  });

  it("removes the body-level betas field", () => {
    const body = JSON.stringify({ model: "m", betas: ["prompt-caching-2024-07-31"], messages: [] });

    expect(JSON.parse(stripNonApiBodyFields(body)).betas).toBeUndefined();
    expect(Object.keys(JSON.parse(stripNonApiBodyFields(body)))).toEqual(["model", "messages"]);
  });

  it("removes the host's stainless-helper markers from tools and messages", () => {
    const body = JSON.stringify({
      model: "m",
      tools: [{ name: "read_file", stainlessHelper: "tool-helper" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", stainless_helper: "content-helper" }] }],
    });

    const stripped = stripNonApiBodyFields(body);

    expect(stripped).not.toContain("stainlessHelper");
    expect(stripped).not.toContain("stainless_helper");
    expect(JSON.parse(stripped).tools[0].name).toBe("read_file");
  });

  it("leaves a non-JSON or non-object body alone", () => {
    expect(stripNonApiBodyFields("not json")).toBe("not json");
    expect(stripNonApiBodyFields("[1,2]")).toBe("[1,2]");
    expect(stripNonApiBodyFields("")).toBe("");
    expect(stripNonApiBodyFields(undefined)).toBeUndefined();
  });
});
