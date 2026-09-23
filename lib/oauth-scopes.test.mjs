import { describe, expect, it } from "vitest";
import * as scopes from "./oauth-scopes.mjs";
import {
  CONSOLE_BASE_SCOPES,
  CLAUDE_AI_BASE_SCOPES,
  PLUGINS_SCOPE,
  PROJECT_SCOPES,
  claudeAiScopes,
  requestedProjectScopes,
  composeScopes,
  serializeScopes,
} from "./oauth-scopes.mjs";

describe("OAuth scope contract", () => {
  it("pins the exact exports", () => {
    expect(Object.keys(scopes).sort()).toEqual([
      "CLAUDE_AI_BASE_SCOPES",
      "CONSOLE_BASE_SCOPES",
      "PLUGINS_SCOPE",
      "PROJECT_SCOPES",
      "claudeAiScopes",
      "composeScopes",
      "requestedProjectScopes",
      "serializeScopes",
    ]);
  });

  it("pins the frozen base sets and conditional extensions in attested order", () => {
    expect(CONSOLE_BASE_SCOPES).toEqual(["org:create_api_key", "user:profile"]);
    expect(CLAUDE_AI_BASE_SCOPES).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
    expect(PLUGINS_SCOPE).toBe("user:plugins");
    expect(PROJECT_SCOPES).toEqual(["user:projects:read", "user:projects:write"]);
    expect(Object.isFrozen(CONSOLE_BASE_SCOPES)).toBe(true);
    expect(Object.isFrozen(CLAUDE_AI_BASE_SCOPES)).toBe(true);
    expect(Object.isFrozen(PROJECT_SCOPES)).toBe(true);
  });

  it("rejects mutation of frozen arrays", () => {
    expect(() => CONSOLE_BASE_SCOPES.push("unknown")).toThrow();
    expect(() => CLAUDE_AI_BASE_SCOPES.push("unknown")).toThrow();
    expect(() => PROJECT_SCOPES.push("unknown")).toThrow();
  });

  it("keeps the plugins gate off unless it is literally true", () => {
    for (const pluginsRegistered of [undefined, false, "yes"]) {
      const result = claudeAiScopes({ pluginsRegistered });
      expect(result).toEqual([
        "user:profile",
        "user:inference",
        "user:sessions:claude_code",
        "user:mcp_servers",
        "user:file_upload",
      ]);
      expect(result).toHaveLength(5);
      expect(result).not.toContain("user:plugins");
    }
  });

  it("appends the enabled plugins scope last", () => {
    expect(claudeAiScopes({ pluginsRegistered: true })).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
      "user:plugins",
    ]);
    expect(claudeAiScopes({ pluginsRegistered: true })).toHaveLength(6);
  });

  it("returns fresh arrays without leaking mutations into later calls", () => {
    const first = claudeAiScopes();
    const second = claudeAiScopes();
    expect(first === second).toBe(false);
    first.push("unknown");
    expect(claudeAiScopes()).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
  });

  it("selects project scopes in PROJECT_SCOPES order, not caller order", () => {
    expect(requestedProjectScopes(["user:projects:write", "user:projects:read"])).toEqual([
      "user:projects:read",
      "user:projects:write",
    ]);
  });

  it("silently drops unknown project scopes", () => {
    expect(() => requestedProjectScopes(["unknown", "user:projects:read"])).not.toThrow();
    expect(requestedProjectScopes(["unknown", "user:projects:read"])).toEqual(["user:projects:read"]);
  });

  it("does not duplicate project scopes", () => {
    expect(requestedProjectScopes(["user:projects:read", "user:projects:read"])).toEqual(["user:projects:read"]);
  });

  it("treats missing, null, empty and non-array project requests as empty", () => {
    for (const requested of [undefined, null, [], "user:projects:read"]) {
      expect(requestedProjectScopes(requested)).toEqual([]);
    }
  });

  it("defaults composition to the five-scope claude.ai list", () => {
    expect(composeScopes()).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
  });

  it("composes only the console base scopes in console mode", () => {
    expect(composeScopes({ mode: "console" })).toEqual(["org:create_api_key", "user:profile"]);
  });

  it("never leaks plugin or project scopes into console authorize URLs", () => {
    expect(composeScopes({ mode: "console", pluginsRegistered: true, projectScopes: ["user:projects:read"] })).toEqual([
      "org:create_api_key",
      "user:profile",
    ]);
  });

  it("appends plugins then projects in attested order", () => {
    expect(
      composeScopes({ pluginsRegistered: true, projectScopes: ["user:projects:write", "user:projects:read"] }),
    ).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
      "user:plugins",
      "user:projects:read",
      "user:projects:write",
    ]);
  });

  it("keeps the first project occurrence at its earlier composed position", () => {
    expect(
      composeScopes({ projectScopes: ["user:projects:read", "user:projects:write", "user:projects:read"] }),
    ).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
      "user:projects:read",
      "user:projects:write",
    ]);
  });

  it("serializes without leading, trailing or double spaces", () => {
    expect(serializeScopes(["user:profile", "user:inference"])).toBe("user:profile user:inference");
    expect(serializeScopes(composeScopes())).toBe(
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
  });

  it("serializes empty, missing and null lists as the empty string", () => {
    expect(serializeScopes([])).toBe("");
    expect(serializeScopes(undefined)).toBe("");
    expect(serializeScopes(null)).toBe("");
  });
});
