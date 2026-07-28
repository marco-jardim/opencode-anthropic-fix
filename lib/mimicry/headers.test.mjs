import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicBetaHeader, buildRequestHeaders, isHaikuModel } from "./headers.mjs";

describe("mimicry headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("places the OAuth beta first when signature emulation is enabled", () => {
    const header = buildAnthropicBetaHeader("", true, "claude-sonnet-4-6");

    expect(header.split(",")[0]).toBe("oauth-2025-04-20");
  });

  it("requires explicit context-hint opt-in", () => {
    const withoutOptIn = buildAnthropicBetaHeader(
      "",
      true,
      "claude-sonnet-4-6",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      {},
    );
    const withOptIn = buildAnthropicBetaHeader(
      "",
      true,
      "claude-sonnet-4-6",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { context_hint: true, __requestRole: "main" },
    );

    expect(withoutOptIn).not.toContain("context-hint-2026-04-09");
    expect(withOptIn).toContain("context-hint-2026-04-09");
  });

  it("detects Haiku model IDs", () => {
    expect(isHaikuModel("claude-3-5-haiku-20241022")).toBe(true);
    expect(isHaikuModel("claude-sonnet-4-6")).toBe(false);
  });

  it("no longer resolves a provider: the plugin is first-party OAuth only", async () => {
    // detectProvider and the five CLAUDE_CODE_USE_* env vars went away with
    // multi-provider support. The export must stay gone so the request path
    // cannot silently regrow a provider branch.
    const headersModule = await import("./headers.mjs");
    expect(headersModule.detectProvider).toBeUndefined();
    expect(headersModule.BEDROCK_UNSUPPORTED_BETAS).toBeUndefined();
  });

  it("builds foreground request headers with a user agent and beta header", () => {
    vi.stubEnv("CLAUDE_CODE_BACKGROUND", "");
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello" }],
    });

    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "oauth-token",
      body,
      new URL("https://api.anthropic.com/v1/messages"),
      { enabled: true, claudeCliVersion: "2.1.195" },
    );

    expect(headers.get("user-agent")).toBeTruthy();
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("x-app")).toBe("cli");
  });
});
