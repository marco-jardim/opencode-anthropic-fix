import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicBetaHeader, buildExtendedUserAgent, buildRequestHeaders, isHaikuModel } from "./headers.mjs";
import { WIRE_PROFILE } from "./wire-compat.mjs";

describe("buildExtendedUserAgent", () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
  });

  it("returns default cli format without env vars", () => {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
    const ua = buildExtendedUserAgent("2.1.143");
    expect(ua).toBe("claude-cli/2.1.143 (external, cli)");
  });

  it("uses CLAUDE_CODE_ENTRYPOINT when set", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "vscode";
    const ua = buildExtendedUserAgent("2.1.143");
    expect(ua).toBe("claude-cli/2.1.143 (external, vscode)");
  });

  it("appends agent-sdk suffix when CLAUDE_AGENT_SDK_VERSION is set", () => {
    process.env.CLAUDE_AGENT_SDK_VERSION = "1.2.3";
    const ua = buildExtendedUserAgent("2.1.143");
    expect(ua).toContain("agent-sdk/1.2.3");
    expect(ua).toMatch(/^claude-cli\/2\.1\.143/);
  });

  it("appends client-app suffix when CLAUDE_AGENT_SDK_CLIENT_APP is set", () => {
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = "myapp";
    const ua = buildExtendedUserAgent("2.1.143");
    expect(ua).toContain("client-app/myapp");
  });

  it("uses the wire profile CLI version when explicitly passed as the version", () => {
    const ua = buildExtendedUserAgent(WIRE_PROFILE.cliVersion);
    expect(ua).toContain(WIRE_PROFILE.cliVersion);
    expect(ua).toBe("claude-cli/2.1.233 (external, cli)");
  });
});

describe("mimicry headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("places the OAuth beta first when signature emulation is enabled", () => {
    const header = buildAnthropicBetaHeader("", true, "claude-sonnet-4-6");

    expect(header.split(",")[0]).toBe("oauth-2025-04-20");
  });

  it("never emits the context-hint beta, opted in or not", () => {
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

    // The opt-in used to push the beta. It no longer does: the genuine Claude
    // Code 2.1.195 client does not send context-hint-2026-04-09, so emitting it
    // on a user knob was a fingerprint. token_economy.context_hint is now a
    // deprecated knob that warns from validateConfig instead of taking effect.
    expect(withoutOptIn).not.toContain("context-hint-2026-04-09");
    expect(withOptIn).not.toContain("context-hint-2026-04-09");
    // The rest of the header is unaffected by the deprecated knob — the two
    // calls differ only in that knob, so they must now agree exactly.
    expect(withOptIn).toBe(withoutOptIn);
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
