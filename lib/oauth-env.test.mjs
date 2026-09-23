import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauthEnv from "./oauth-env.mjs";
import {
  HEADLESS_CLIENT_ID_VAR,
  HEADLESS_REFRESH_TOKEN_VAR,
  HEADLESS_SCOPES_VAR,
  assertApprovedOAuthUrl,
  isLocalOAuthDevMode,
  resolveAppsBase,
  resolveConsoleBase,
  resolveCustomOAuthUrl,
  resolveHeadlessLogin,
  resetHeadlessScopeWarning,
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

describe("local-dev base loopback guard (B4)", () => {
  describe.each([
    ["apps", resolveAppsBase, "CLAUDE_LOCAL_OAUTH_APPS_BASE"],
    ["console", resolveConsoleBase, "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE"],
  ])("%s base", (_name, resolve, variable) => {
    it.each(["http://localhost:4000", "http://127.0.0.1:9999", "http://[::1]:3000", "http://localhost"])(
      "accepts %s verbatim",
      (base) => {
        expect(resolve({ [variable]: base })).toBe(base);
      },
    );
    it.each(["https://attacker.example", "http://evil.com:4000", "http://localhost/path", "ftp://localhost:4000"])(
      "rejects %s",
      (base) => {
        expect(() => resolve({ [variable]: base })).toThrow(/must be a loopback origin/);
      },
    );
  });

  it("retains documented defaults when only the other variable opts in", () => {
    expect(resolveConsoleBase({ CLAUDE_LOCAL_OAUTH_APPS_BASE: "http://localhost:4000" })).toBe("http://localhost:3000");
    expect(resolveAppsBase({ CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: "http://localhost:3000" })).toBe("http://localhost:4000");
  });
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
    "HEADLESS_CLIENT_ID_VAR",
    "HEADLESS_REFRESH_TOKEN_VAR",
    "HEADLESS_SCOPES_VAR",
    "assertApprovedOAuthUrl",
    "isLocalOAuthDevMode",
    "resetHeadlessScopeWarning",
    "resolveAppsBase",
    "resolveConsoleBase",
    "resolveCustomOAuthUrl",
    "resolveHeadlessLogin",
  ]);
});

describe("resolveHeadlessLogin (T-3 headless login)", () => {
  beforeEach(() => {
    resetHeadlessScopeWarning();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {},
    { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "" },
    { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "   " },
    { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 42 },
    undefined,
  ])("T-3.2 ignores an absent or invalid refresh token: %j", (env) => {
    expect(() => resolveHeadlessLogin(env)).not.toThrow();
    expect(resolveHeadlessLogin(env)).toBeUndefined();
  });

  it.each([
    { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc" },
    { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc", CLAUDE_CODE_OAUTH_SCOPES: "" },
    { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc", CLAUDE_CODE_OAUTH_SCOPES: "   " },
  ])("T-3.2b requires a nonblank scope declaration: %j", (env) => {
    expect(() => resolveHeadlessLogin(env)).toThrow(/CLAUDE_CODE_OAUTH_SCOPES is missing/);
    expect(() => resolveHeadlessLogin(env)).toThrow(
      /^CLAUDE_CODE_OAUTH_REFRESH_TOKEN is set but CLAUDE_CODE_OAUTH_SCOPES is missing\./,
    );
    expect(() => resolveHeadlessLogin(env)).toThrow("Set CLAUDE_CODE_OAUTH_SCOPES to the space-separated scope list");
  });

  it("T-3.2c warns and returns incomplete scopes verbatim", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveHeadlessLogin({
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc",
      CLAUDE_CODE_OAUTH_SCOPES: "user:profile user:sessions:claude_code user:mcp_servers user:file_upload",
    });
    expect(result).toEqual(expect.any(Object));
    expect(result.scopes).toEqual([
      "user:profile",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Missing: user:inference"));
  });

  it("T-3.2c reports missing scopes in the five-scope base order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveHeadlessLogin({
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc",
      CLAUDE_CODE_OAUTH_SCOPES: "user:profile",
    });
    expect(result.scopes).toEqual(["user:profile"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "does not declare every scope this plugin normally requires. Missing: user:inference, user:sessions:claude_code, user:mcp_servers, user:file_upload",
      ),
    );
  });

  it("T-3.2d warns once until reset re-arms the latch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc", CLAUDE_CODE_OAUTH_SCOPES: "user:profile" };
    for (let i = 0; i < 3; i++) resolveHeadlessLogin(env);
    expect(warn).toHaveBeenCalledTimes(1);
    resetHeadlessScopeWarning();
    resolveHeadlessLogin(env);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("T-3.2e never warns for a complete declaration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveHeadlessLogin({
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc",
      CLAUDE_CODE_OAUTH_SCOPES:
        "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("T-3.3 returns the full headless login configuration", () => {
    expect(
      resolveHeadlessLogin({
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc",
        CLAUDE_CODE_OAUTH_SCOPES:
          "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      }),
    ).toEqual({
      refreshToken: "rt-abc",
      scopes: ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"],
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
  });

  it("T-3.5 accepts a custom client ID and defaults a blank client ID", () => {
    expect(
      resolveHeadlessLogin({
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc",
        CLAUDE_CODE_OAUTH_SCOPES:
          "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
        CLAUDE_CODE_OAUTH_CLIENT_ID: "custom-client-id",
      }).clientId,
    ).toBe("custom-client-id");
    expect(
      resolveHeadlessLogin({
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc",
        CLAUDE_CODE_OAUTH_SCOPES:
          "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
        CLAUDE_CODE_OAUTH_CLIENT_ID: "   ",
      }).clientId,
    ).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  it("T-3.6 trims the token and parses irregular scope whitespace without empty entries", () => {
    const result = resolveHeadlessLogin({
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "  rt-abc  ",
      CLAUDE_CODE_OAUTH_SCOPES:
        "  user:profile\t\tuser:inference \n user:sessions:claude_code   user:mcp_servers  user:file_upload  ",
    });
    expect(result.scopes).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
    expect(result.scopes.every((s) => s.length > 0)).toBe(true);
    expect(result.refreshToken).toBe("rt-abc");
  });

  it("T-3.6b preserves extra scopes verbatim in the caller's declared order", () => {
    const result = resolveHeadlessLogin({
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "rt-abc",
      CLAUDE_CODE_OAUTH_SCOPES:
        "user:plugins user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    });
    expect(result.scopes).toEqual([
      "user:plugins",
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
  });

  it("T-3.6c exports the literal headless environment variable names", () => {
    expect(HEADLESS_REFRESH_TOKEN_VAR).toBe("CLAUDE_CODE_OAUTH_REFRESH_TOKEN");
    expect(HEADLESS_SCOPES_VAR).toBe("CLAUDE_CODE_OAUTH_SCOPES");
    expect(HEADLESS_CLIENT_ID_VAR).toBe("CLAUDE_CODE_OAUTH_CLIENT_ID");
  });
});
