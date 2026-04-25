/**
 * Smoke tests for lib/request-headers.mjs exports.
 * Verifies version constants, beta shortcuts, and user-agent builder.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  FALLBACK_CLAUDE_CLI_VERSION,
  ANTHROPIC_SDK_VERSION,
  getSdkVersion,
  BETA_SHORTCUTS,
  resolveBetaShortcut,
  buildExtendedUserAgent,
} from "./request-headers.mjs";

describe("request-headers constants", () => {
  it("FALLBACK_CLAUDE_CLI_VERSION is 2.1.119", () => {
    expect(FALLBACK_CLAUDE_CLI_VERSION).toBe("2.1.119");
  });

  it("ANTHROPIC_SDK_VERSION matches expected value", () => {
    expect(typeof ANTHROPIC_SDK_VERSION).toBe("string");
    expect(ANTHROPIC_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("getSdkVersion", () => {
  it("returns known SDK version for CLI version 2.1.119", () => {
    // 2.1.119 is in the VERSION_TO_SDK_MAP
    const v = getSdkVersion("2.1.119");
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("falls back to ANTHROPIC_SDK_VERSION for an unknown CLI version", () => {
    expect(getSdkVersion("9.99.999")).toBe(ANTHROPIC_SDK_VERSION);
  });

  it("falls back for undefined/null input", () => {
    expect(getSdkVersion(undefined)).toBe(ANTHROPIC_SDK_VERSION);
    expect(getSdkVersion(null)).toBe(ANTHROPIC_SDK_VERSION);
  });
});

describe("BETA_SHORTCUTS", () => {
  it("is a Map", () => {
    expect(BETA_SHORTCUTS).toBeInstanceOf(Map);
  });

  it("has cache-diagnosis shortcut resolving to cache-diagnosis-2026-04-07", () => {
    expect(BETA_SHORTCUTS.get("cache-diagnosis")).toBe("cache-diagnosis-2026-04-07");
  });

  it("has a cache-diag alias for cache-diagnosis-2026-04-07", () => {
    expect(BETA_SHORTCUTS.get("cache-diag")).toBe("cache-diagnosis-2026-04-07");
  });
});

describe("resolveBetaShortcut", () => {
  it("expands cache-diagnosis shortcut", () => {
    expect(resolveBetaShortcut("cache-diagnosis")).toBe("cache-diagnosis-2026-04-07");
  });

  it("expands cache-diag alias", () => {
    expect(resolveBetaShortcut("cache-diag")).toBe("cache-diagnosis-2026-04-07");
  });

  it("expands 1m shortcut", () => {
    expect(resolveBetaShortcut("1m")).toBe("context-1m-2025-08-07");
  });

  it("expands fast shortcut", () => {
    expect(resolveBetaShortcut("fast")).toBe("fast-mode-2026-02-01");
  });

  it("returns the input unchanged when no alias matches", () => {
    expect(resolveBetaShortcut("context-hint-2026-04-09")).toBe("context-hint-2026-04-09");
    expect(resolveBetaShortcut("no-such-beta")).toBe("no-such-beta");
  });

  it("returns empty string for falsy/empty input", () => {
    expect(resolveBetaShortcut(undefined)).toBe("");
    expect(resolveBetaShortcut("")).toBe("");
    expect(resolveBetaShortcut(null)).toBe("");
  });
});

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
    const ua = buildExtendedUserAgent("2.1.119");
    expect(ua).toBe("claude-cli/2.1.119 (external, cli)");
  });

  it("uses CLAUDE_CODE_ENTRYPOINT when set", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "vscode";
    const ua = buildExtendedUserAgent("2.1.119");
    expect(ua).toBe("claude-cli/2.1.119 (external, vscode)");
  });

  it("appends agent-sdk suffix when CLAUDE_AGENT_SDK_VERSION is set", () => {
    process.env.CLAUDE_AGENT_SDK_VERSION = "1.2.3";
    const ua = buildExtendedUserAgent("2.1.119");
    expect(ua).toContain("agent-sdk/1.2.3");
    expect(ua).toMatch(/^claude-cli\/2\.1\.119/);
  });

  it("appends client-app suffix when CLAUDE_AGENT_SDK_CLIENT_APP is set", () => {
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = "myapp";
    const ua = buildExtendedUserAgent("2.1.119");
    expect(ua).toContain("client-app/myapp");
  });

  it("uses FALLBACK_CLAUDE_CLI_VERSION when explicitly passed as the version", () => {
    const ua = buildExtendedUserAgent(FALLBACK_CLAUDE_CLI_VERSION);
    expect(ua).toContain(FALLBACK_CLAUDE_CLI_VERSION);
  });
});
