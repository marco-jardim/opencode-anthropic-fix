import { describe, expect, it } from "vitest";
import * as scopes from "./oauth-scopes.mjs";
import {
  CONSOLE_BASE_SCOPES,
  CLAUDE_AI_BASE_SCOPES,
  DEFAULT_REFRESH_SCOPES,
  DESKTOP_CONFIG_SCOPE,
  PLUGINS_SCOPE,
  PRIVACY_CONSENTS_SCOPE,
  claudeAiScopes,
  composeScopes,
  missingBaseScopes,
  serializeScopes,
} from "./oauth-scopes.mjs";

const UNION =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";

describe("missingBaseScopes", () => {
  it("returns no missing scopes for the full set", () => {
    expect(
      missingBaseScopes([
        "user:profile",
        "user:inference",
        "user:sessions:claude_code",
        "user:mcp_servers",
        "user:file_upload",
      ]),
    ).toEqual([]);
  });

  it.each([[], undefined, null, "not-an-array"])("treats %j as an empty declaration", (input) => {
    expect(missingBaseScopes(input)).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
  });

  it("returns the other four scopes for profile only", () => {
    expect(missingBaseScopes(["user:profile"])).toEqual([
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
  });

  it("uses base order rather than caller order", () => {
    expect(missingBaseScopes(["user:file_upload", "user:profile"])).toEqual([
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
    ]);
  });
});

describe("OAuth scope contract", () => {
  it("pins the exact exports", () => {
    expect(Object.keys(scopes).sort()).toEqual([
      "CLAUDE_AI_BASE_SCOPES",
      "CONSOLE_BASE_SCOPES",
      "DEFAULT_REFRESH_SCOPES",
      "DESKTOP_CONFIG_SCOPE",
      "PLUGINS_SCOPE",
      "PRIVACY_CONSENTS_SCOPE",
      "claudeAiScopes",
      "composeScopes",
      "missingBaseScopes",
      "serializeScopes",
    ]);
  });

  it("exports no project scope surface", () => {
    expect("PROJECT_SCOPES" in scopes).toBe(false);
    expect("requestedProjectScopes" in scopes).toBe(false);
  });

  it("pins the frozen base sets and named scopes in attested order", () => {
    expect(CONSOLE_BASE_SCOPES).toEqual(["org:create_api_key", "user:profile"]);
    expect(CLAUDE_AI_BASE_SCOPES).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
    expect(PLUGINS_SCOPE).toBe("user:plugins");
    expect(PRIVACY_CONSENTS_SCOPE).toBe("user:privacy_consents:write");
    expect(DESKTOP_CONFIG_SCOPE).toBe("org:desktop_config");
    expect(Object.isFrozen(CONSOLE_BASE_SCOPES)).toBe(true);
    expect(Object.isFrozen(CLAUDE_AI_BASE_SCOPES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REFRESH_SCOPES)).toBe(true);
  });

  it("defaults the refresh scopes to the claude.ai base set plus user:plugins", () => {
    expect(DEFAULT_REFRESH_SCOPES).toEqual([...CLAUDE_AI_BASE_SCOPES, "user:plugins"]);
  });

  it("rejects typo'd modes while accepting max, console and omitted modes", () => {
    expect(() => composeScopes({ mode: "consol" })).toThrow();
    expect(() => composeScopes({ mode: "max" })).not.toThrow();
    expect(() => composeScopes({ mode: "console" })).not.toThrow();
    expect(() => composeScopes({})).not.toThrow();
  });

  it("defaults null and missing options to the seven-scope union", () => {
    for (const result of [composeScopes(null), composeScopes(), composeScopes({})]) {
      expect(serializeScopes(result)).toBe(UNION);
    }
  });

  it("composes the same union for max and console", () => {
    expect(composeScopes({ mode: "max" })).toEqual(composeScopes({ mode: "console" }));
    expect(serializeScopes(composeScopes({ mode: "console" }))).toBe(UNION);
  });

  it("removes user:plugins only when pluginsRegistered is exactly false", () => {
    for (const pluginsRegistered of [undefined, true, "yes", null]) {
      expect(composeScopes({ pluginsRegistered })).toContain("user:plugins");
    }
    const without = composeScopes({ pluginsRegistered: false });
    expect(without).not.toContain("user:plugins");
    expect(without).toHaveLength(6);
  });

  it("never emits project scopes, whatever the caller passes", () => {
    const result = composeScopes({
      mode: "max",
      pluginsRegistered: true,
      projectScopes: ["user:projects:read", "user:projects:write"],
    });
    expect(serializeScopes(result)).toBe(UNION);
    expect(result.some((scope) => scope.includes("projects"))).toBe(false);
  });

  it("appends extraScopes after user:plugins, deduplicated and filtered", () => {
    const result = composeScopes({
      extraScopes: [PRIVACY_CONSENTS_SCOPE, DESKTOP_CONFIG_SCOPE, "user:plugins", "", 42, PRIVACY_CONSENTS_SCOPE],
    });
    expect(serializeScopes(result)).toBe(`${UNION} user:privacy_consents:write org:desktop_config`);
  });

  it("ignores a non-array extraScopes", () => {
    expect(serializeScopes(composeScopes({ extraScopes: "org:desktop_config" }))).toBe(UNION);
  });

  it("rejects mutation of frozen arrays", () => {
    expect(() => CONSOLE_BASE_SCOPES.push("unknown")).toThrow();
    expect(() => CLAUDE_AI_BASE_SCOPES.push("unknown")).toThrow();
    expect(() => DEFAULT_REFRESH_SCOPES.push("unknown")).toThrow();
  });

  it("keeps the claudeAiScopes plugins gate off unless it is literally true", () => {
    for (const pluginsRegistered of [undefined, false, "yes"]) {
      const result = claudeAiScopes({ pluginsRegistered });
      expect(result).toEqual([...CLAUDE_AI_BASE_SCOPES]);
      expect(result).not.toContain("user:plugins");
    }
    expect(claudeAiScopes({ pluginsRegistered: true })).toEqual([...CLAUDE_AI_BASE_SCOPES, "user:plugins"]);
  });

  it("returns fresh arrays without leaking mutations into later calls", () => {
    const first = claudeAiScopes();
    const second = claudeAiScopes();
    expect(first === second).toBe(false);
    first.push("unknown");
    expect(claudeAiScopes()).toEqual([...CLAUDE_AI_BASE_SCOPES]);
    const composed = composeScopes();
    composed.push("unknown");
    expect(composeScopes()).toHaveLength(7);
  });

  it("serializes without leading, trailing or double spaces", () => {
    expect(serializeScopes(["user:profile", "user:inference"])).toBe("user:profile user:inference");
    expect(serializeScopes(composeScopes())).toBe(UNION);
  });

  it("serializes empty, missing and null lists as the empty string", () => {
    expect(serializeScopes([])).toBe("");
    expect(serializeScopes(undefined)).toBe("");
    expect(serializeScopes(null)).toBe("");
  });
});
