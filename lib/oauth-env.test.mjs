import { describe, expect, it } from "vitest";
import * as oauthEnv from "./oauth-env.mjs";
import {
  assertApprovedOAuthUrl,
  isLocalOAuthDevMode,
  resolveAppsBase,
  resolveConsoleBase,
  resolveCustomOAuthUrl,
} from "./oauth-env.mjs";

describe("assertApprovedOAuthUrl rejection guard", () => {
  it.each([
    "https://claude.fedstart.com/",
    "https://CLAUDE.fedstart.com",
    "http://claude.fedstart.com",
    " https://claude.fedstart.com",
    "https://claude.fedstart.com ",
    "https://claude.fedstart.com/path",
    "https://claude.fedstart.com?query=value",
    "https://evil.example.com",
    "",
    "   ",
    undefined,
    null,
  ])("rejects %s with the byte-exact message", (url) => {
    expect(() => assertApprovedOAuthUrl(url)).toThrowError(
      new Error("CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint."),
    );
  });
});

describe("custom OAuth URL", () => {
  it.each([
    "https://beacon.claude-ai.staging.ant.dev",
    "https://claude.fedstart.com",
    "https://claude-staging.fedstart.com",
  ])("accepts the exact approved endpoint %s through both entry points", (url) => {
    expect(assertApprovedOAuthUrl(url)).toBe(url);
    expect(resolveCustomOAuthUrl({ CLAUDE_CODE_CUSTOM_OAUTH_URL: url })).toBe(url);
  });

  it.each([
    "https://claude.fedstart.com/",
    "https://CLAUDE.fedstart.com",
    "http://claude.fedstart.com",
    " https://claude.fedstart.com",
    "https://claude.fedstart.com ",
    "https://claude.fedstart.com/path",
    "https://claude.fedstart.com?query=value",
    "https://evil.example.com",
  ])("rejects the raw unapproved value %s", (url) => {
    expect(() => resolveCustomOAuthUrl({ CLAUDE_CODE_CUSTOM_OAUTH_URL: url })).toThrowError(
      new Error("CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint."),
    );
  });

  it.each([{}, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "" }, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "   " }])(
    "treats an absent or blank custom URL as unconfigured: %j",
    (env) => {
      expect(resolveCustomOAuthUrl(env)).toBeUndefined();
    },
  );
});

describe("local OAuth development opt-in", () => {
  it.each([
    {},
    { CLAUDE_LOCAL_OAUTH_APPS_BASE: "" },
    { CLAUDE_LOCAL_OAUTH_APPS_BASE: "  " },
    { CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "" },
    { CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "  " },
    { CLAUDE_LOCAL_OAUTH_APPS_BASE: "  ", CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "" },
  ])("production safety: unset or blank variables never activate localhost defaults: %j", (env) => {
    expect(isLocalOAuthDevMode(env)).toBe(false);
    expect(resolveAppsBase(env)).toBeUndefined();
    expect(resolveConsoleBase(env)).toBeUndefined();
  });

  it("activates with only the console base and uses the documented apps default", () => {
    const env = { CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "http://localhost:5000" };
    expect(isLocalOAuthDevMode(env)).toBe(true);
    expect(resolveConsoleBase(env)).toBe("http://localhost:5000");
    expect(resolveAppsBase(env)).toBe("http://localhost:4000");
  });

  it("activates with only the apps base and uses the documented console default", () => {
    const env = { CLAUDE_LOCAL_OAUTH_APPS_BASE: "http://localhost:6000" };
    expect(isLocalOAuthDevMode(env)).toBe(true);
    expect(resolveAppsBase(env)).toBe("http://localhost:6000");
    expect(resolveConsoleBase(env)).toBe("http://localhost:3000");
  });

  it("uses both configured values", () => {
    const env = {
      CLAUDE_LOCAL_OAUTH_APPS_BASE: "http://localhost:6000",
      CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "http://localhost:5000",
    };
    expect(isLocalOAuthDevMode(env)).toBe(true);
    expect(resolveAppsBase(env)).toBe("http://localhost:6000");
    expect(resolveConsoleBase(env)).toBe("http://localhost:5000");
  });

  it("trims local bases but never trims the custom URL allowlist comparison", () => {
    const env = {
      CLAUDE_LOCAL_OAUTH_APPS_BASE: "  http://localhost:6000 \t",
      CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "\n http://localhost:5000  ",
      CLAUDE_CODE_CUSTOM_OAUTH_URL: " https://claude.fedstart.com ",
    };
    expect(isLocalOAuthDevMode(env)).toBe(true);
    expect(resolveAppsBase(env)).toBe("http://localhost:6000");
    expect(resolveConsoleBase(env)).toBe("http://localhost:5000");
    expect(() => resolveCustomOAuthUrl(env)).toThrowError(
      new Error("CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint."),
    );
  });

  it("uses defaults for blank values only after the other base activates the mode", () => {
    expect(
      resolveAppsBase({ CLAUDE_LOCAL_OAUTH_APPS_BASE: "  ", CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "http://localhost:5000" }),
    ).toBe("http://localhost:4000");
    expect(
      resolveConsoleBase({
        CLAUDE_LOCAL_OAUTH_APPS_BASE: "http://localhost:6000",
        CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "",
      }),
    ).toBe("http://localhost:3000");
  });
});

it("exports exactly the intended OAuth environment surface", () => {
  expect(Object.keys(oauthEnv).sort()).toEqual([
    "assertApprovedOAuthUrl",
    "isLocalOAuthDevMode",
    "resolveAppsBase",
    "resolveConsoleBase",
    "resolveCustomOAuthUrl",
  ]);
});
