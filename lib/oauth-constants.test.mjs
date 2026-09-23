import { describe, it, expect } from "vitest";
import * as oauthConstants from "./oauth-constants.mjs";
import {
  OAUTH_CLIENT_ID,
  OAUTH_CONSOLE_AUTHORIZE_URL,
  OAUTH_CLAUDE_AI_AUTHORIZE_URL,
  OAUTH_CLAUDE_AI_ORIGIN,
  OAUTH_TOKEN_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_API_KEY_URL,
  OAUTH_SDK_VERSION,
  OAUTH_SDK_USER_AGENT,
  OAUTH_BETA,
  OAUTH_EXPIRY_SKEW_SECONDS,
  OAUTH_CUSTOM_URL_ALLOWLIST,
  OAUTH_LOCAL_APPS_BASE_DEFAULT,
  OAUTH_LOCAL_CONSOLE_BASE_DEFAULT,
  OAUTH_CUSTOM_URL_REJECTION_MESSAGE,
} from "./oauth-constants.mjs";

describe("oauth-constants", () => {
  it("pins OAUTH_CLIENT_ID", () => {
    expect(OAUTH_CLIENT_ID).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  it("pins OAUTH_CONSOLE_AUTHORIZE_URL", () => {
    expect(OAUTH_CONSOLE_AUTHORIZE_URL).toBe("https://platform.claude.com/oauth/authorize");
  });

  it("pins OAUTH_CLAUDE_AI_AUTHORIZE_URL separately from the consumer origin", () => {
    expect(OAUTH_CLAUDE_AI_AUTHORIZE_URL).toBe("https://claude.com/cai/oauth/authorize");
    expect(OAUTH_CLAUDE_AI_AUTHORIZE_URL).not.toBe("https://claude.ai");
  });

  it("never collapses the consumer authorize URL into the consumer origin", () => {
    // Deliberately an identity comparison between the two imports: the literal
    // assertions above prove each value in isolation, but only this one proves
    // the module does not alias one constant to the other.
    expect(OAUTH_CLAUDE_AI_AUTHORIZE_URL).not.toBe(OAUTH_CLAUDE_AI_ORIGIN);
    expect(OAUTH_CLAUDE_AI_AUTHORIZE_URL.startsWith(OAUTH_CLAUDE_AI_ORIGIN)).toBe(false);
  });

  it("pins OAUTH_CLAUDE_AI_ORIGIN", () => {
    expect(OAUTH_CLAUDE_AI_ORIGIN).toBe("https://claude.ai");
    expect(OAUTH_CLAUDE_AI_ORIGIN).not.toBe("https://claude.com/cai/oauth/authorize");
  });

  it("pins OAUTH_TOKEN_URL without changing its unattested host binding", () => {
    expect(OAUTH_TOKEN_URL).toBe("https://platform.claude.com/v1/oauth/token");
  });

  it("pins OAUTH_REDIRECT_URI", () => {
    expect(OAUTH_REDIRECT_URI).toBe("https://platform.claude.com/oauth/code/callback");
  });

  it("pins OAUTH_API_KEY_URL", () => {
    expect(OAUTH_API_KEY_URL).toBe("https://api.anthropic.com/api/oauth/claude_cli/create_api_key");
  });

  it("pins OAUTH_SDK_VERSION", () => {
    expect(OAUTH_SDK_VERSION).toBe("0.112.1");
  });

  it("pins OAUTH_SDK_USER_AGENT and excludes obsolete clients", () => {
    expect(OAUTH_SDK_USER_AGENT).toBe("anthropic-sdk-typescript/0.112.1 userOAuthProvider");
    expect(OAUTH_SDK_USER_AGENT).not.toContain("0.94.0");
    expect(OAUTH_SDK_USER_AGENT).not.toContain("axios");
  });

  it("pins OAUTH_BETA", () => {
    expect(OAUTH_BETA).toBe("oauth-2025-04-20");
  });

  it("pins OAUTH_EXPIRY_SKEW_SECONDS", () => {
    expect(OAUTH_EXPIRY_SKEW_SECONDS).toBe(30);
  });

  it("pins OAUTH_CUSTOM_URL_ALLOWLIST entries and order", () => {
    expect(OAUTH_CUSTOM_URL_ALLOWLIST).toEqual([
      "https://beacon.claude-ai.staging.ant.dev",
      "https://claude.fedstart.com",
      "https://claude-staging.fedstart.com",
    ]);
    expect(OAUTH_CUSTOM_URL_ALLOWLIST).toHaveLength(3);
  });

  it("freezes the custom URL allowlist", () => {
    expect(Object.isFrozen(OAUTH_CUSTOM_URL_ALLOWLIST)).toBe(true);
  });

  it("rejects mutation of the custom URL allowlist", () => {
    expect(() => {
      OAUTH_CUSTOM_URL_ALLOWLIST.push("x");
    }).toThrow();
  });

  it("pins OAUTH_LOCAL_APPS_BASE_DEFAULT", () => {
    expect(OAUTH_LOCAL_APPS_BASE_DEFAULT).toBe("http://localhost:4000");
  });

  it("pins OAUTH_LOCAL_CONSOLE_BASE_DEFAULT", () => {
    expect(OAUTH_LOCAL_CONSOLE_BASE_DEFAULT).toBe("http://localhost:3000");
  });

  it("pins OAUTH_CUSTOM_URL_REJECTION_MESSAGE including exactly one trailing full stop", () => {
    expect(OAUTH_CUSTOM_URL_REJECTION_MESSAGE).toBe("CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.");
    expect(OAUTH_CUSTOM_URL_REJECTION_MESSAGE.trim()).toBe("CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.");
  });

  it("keeps every URL free of trailing slashes and placeholder residue", () => {
    for (const url of [
      OAUTH_CONSOLE_AUTHORIZE_URL,
      OAUTH_CLAUDE_AI_AUTHORIZE_URL,
      OAUTH_CLAUDE_AI_ORIGIN,
      OAUTH_TOKEN_URL,
      OAUTH_REDIRECT_URI,
      OAUTH_API_KEY_URL,
      ...OAUTH_CUSTOM_URL_ALLOWLIST,
      OAUTH_LOCAL_APPS_BASE_DEFAULT,
      OAUTH_LOCAL_CONSOLE_BASE_DEFAULT,
    ]) {
      expect(url.endsWith("/")).toBe(false);
      expect(url).not.toContain("${");
      expect(url).not.toContain("{");
    }
  });

  it("exports exactly the constants this plugin emits, and no OIDC federation surface", () => {
    // Divergence D12: the contract records the OIDC federation grant, but this
    // plugin does not implement it. An unused exported constant is an invitation
    // to wire one up, so the module must carry none. This assertion also fails
    // when a constant is added without a pinning test above.
    expect(Object.keys(oauthConstants).sort()).toEqual([
      "OAUTH_API_KEY_URL",
      "OAUTH_BETA",
      "OAUTH_CLAUDE_AI_AUTHORIZE_URL",
      "OAUTH_CLAUDE_AI_ORIGIN",
      "OAUTH_CLIENT_ID",
      "OAUTH_CONSOLE_AUTHORIZE_URL",
      "OAUTH_CUSTOM_URL_ALLOWLIST",
      "OAUTH_CUSTOM_URL_REJECTION_MESSAGE",
      "OAUTH_EXPIRY_SKEW_SECONDS",
      "OAUTH_LOCAL_APPS_BASE_DEFAULT",
      "OAUTH_LOCAL_CONSOLE_BASE_DEFAULT",
      "OAUTH_REDIRECT_URI",
      "OAUTH_SDK_USER_AGENT",
      "OAUTH_SDK_VERSION",
      "OAUTH_TOKEN_URL",
    ]);
    expect(Object.keys(oauthConstants).filter((key) => key.startsWith("OIDC_"))).toEqual([]);
  });
});
