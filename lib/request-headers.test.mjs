/**
 * Smoke tests for the residual lib/request-headers.mjs exports.
 *
 * The beta registries moved to lib/betas.test.mjs and the user-agent builder to
 * lib/mimicry/headers.test.mjs; only the version/SDK constants are still tested
 * from here.
 */
import { describe, it, expect } from "vitest";
import { FALLBACK_CLAUDE_CLI_VERSION, ANTHROPIC_SDK_VERSION, getSdkVersion } from "./request-headers.mjs";

describe("request-headers constants", () => {
  it("FALLBACK_CLAUDE_CLI_VERSION tracks the wire-compat default profile (2.1.233)", () => {
    expect(FALLBACK_CLAUDE_CLI_VERSION).toBe("2.1.233");
  });

  it("ANTHROPIC_SDK_VERSION matches expected value", () => {
    expect(typeof ANTHROPIC_SDK_VERSION).toBe("string");
    expect(ANTHROPIC_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // The wire SDK version did NOT bump for 2.1.195.
    expect(ANTHROPIC_SDK_VERSION).toBe("0.94.0");
  });
});

describe("getSdkVersion", () => {
  it("returns known SDK version for CLI version 2.1.143", () => {
    // 2.1.143 is in the VERSION_TO_SDK_MAP
    const v = getSdkVersion("2.1.143");
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("resolves the 2.1.233 profile baseline to the SDK it bundles (0.112.1)", () => {
    expect(getSdkVersion(FALLBACK_CLAUDE_CLI_VERSION)).toBe("0.112.1");
    expect(getSdkVersion("2.1.233")).toBe("0.112.1");
  });

  it("resolves 2.1.195 (and the 2.1.160-2.1.194 range) to 0.94.0", () => {
    expect(getSdkVersion("2.1.195")).toBe("0.94.0");
    expect(getSdkVersion("2.1.160")).toBe("0.94.0");
    expect(getSdkVersion("2.1.180")).toBe("0.94.0");
  });

  it("falls back to ANTHROPIC_SDK_VERSION for an unknown CLI version", () => {
    expect(getSdkVersion("9.99.999")).toBe(ANTHROPIC_SDK_VERSION);
  });

  it("falls back for undefined/null input", () => {
    expect(getSdkVersion(undefined)).toBe(ANTHROPIC_SDK_VERSION);
    expect(getSdkVersion(null)).toBe(ANTHROPIC_SDK_VERSION);
  });
});
