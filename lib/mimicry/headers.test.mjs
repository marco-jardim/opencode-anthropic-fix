import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicBetaHeader, buildRequestHeaders, detectProvider, isHaikuModel } from "./headers.mjs";

describe("mimicry headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("places the OAuth beta first when signature emulation is enabled", () => {
    const header = buildAnthropicBetaHeader("", true, "claude-sonnet-4-6", "anthropic");

    expect(header.split(",")[0]).toBe("oauth-2025-04-20");
  });

  it("detects Haiku model IDs", () => {
    expect(isHaikuModel("claude-3-5-haiku-20241022")).toBe(true);
    expect(isHaikuModel("claude-sonnet-4-6")).toBe(false);
  });

  it("detects the Anthropic provider from the API URL", () => {
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("CLAUDE_CODE_USE_FOUNDRY", "");
    vi.stubEnv("CLAUDE_CODE_USE_ANTHROPIC_AWS", "");
    vi.stubEnv("CLAUDE_CODE_USE_MANTLE", "");
    vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "");

    expect(detectProvider(new URL("https://api.anthropic.com/v1/messages"))).toBe("anthropic");
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
