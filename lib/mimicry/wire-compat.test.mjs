import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: wraps the two request-building entry points in a `vi.fn` spy
// that still calls straight through to the real implementation, so every
// other test in this file (and every non-spy assertion below) observes the
// package's genuine behaviour. This is what lets the M5 tests below assert
// on the exact `profile` argument `wire-compat.mjs` passes without having to
// re-implement the package's own request construction to observe it.
vi.mock("@tormentalabs/claude-code-wire-compat", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    buildClaudeCodeRequest: vi.fn((input, profile) => original.buildClaudeCodeRequest(input, profile)),
    buildClaudeCodeCountTokensRequest: vi.fn((input, profile) =>
      original.buildClaudeCodeCountTokensRequest(input, profile),
    ),
  };
});

import { buildClaudeCodeCountTokensRequest, buildClaudeCodeRequest } from "@tormentalabs/claude-code-wire-compat";
import {
  buildWireCompatibleCountTokensRequest,
  buildWireCompatibleRequest,
  catalogueDefaultEffortWire,
  catalogueDefaultMaxTokensWire,
  catalogueEntryForWire,
  getWireCompatPackageVersion,
  isAdaptiveThinkingModel,
  isNativeOneMillionContextWire,
  isOrgLockedThinkingModelWire,
  supportsEffortLevelWire,
  supportsEffortWire,
  supportsFastModeWire,
  isFastModeEligibleWire,
  describeFastModeEligibility,
  toClaudeCodeCountTokensInput,
  toClaudeCodeRequestInput,
  WIRE_PROFILE,
} from "./wire-compat.mjs";

describe("getWireCompatPackageVersion", () => {
  it("matches the version actually installed in node_modules", () => {
    const installedPackageJsonPath = path.join(
      path.dirname(fileURLToPath(import.meta.resolve("@tormentalabs/claude-code-wire-compat"))),
      "..",
      "package.json",
    );
    const installed = JSON.parse(readFileSync(installedPackageJsonPath, "utf8"));

    expect(installed.name).toBe("@tormentalabs/claude-code-wire-compat");
    expect(getWireCompatPackageVersion()).toBe(installed.version);
  });

  it("returns a non-empty string, never throwing, even in the worst case", () => {
    const version = getWireCompatPackageVersion();

    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });
});

describe("WIRE_PROFILE", () => {
  it("carries the id and cliVersion the diagnostic bundle reads", () => {
    expect(typeof WIRE_PROFILE.id).toBe("string");
    expect(WIRE_PROFILE.id).toContain(WIRE_PROFILE.cliVersion);
  });
});

// M5 — the request path used to omit the `profile` argument entirely and
// inherit whatever the installed package declared as its `DEFAULT_PROFILE`.
// A future package release moving that default (precedent: 0.6.0 moved it in
// a minor release and broke 48 plugin tests) would have silently changed the
// wire for every fresh install tracking `latest`. These tests pin the fix:
// `WIRE_PROFILE` is now passed explicitly on every package entry point this
// module calls, and doing so is proven to change nothing about the bytes
// produced today (WIRE_PROFILE currently equals the package's own
// DEFAULT_PROFILE).
describe("explicit profile pinning", () => {
  const transport = {
    accessToken: "test-access",
    clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runtime: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceId: "2".repeat(64),
      accountUuid: "33333333-3333-4333-8333-333333333333",
      runtime: "node",
      runtimeVersion: process.version,
      os: "Linux",
      arch: "x64",
    },
  };
  const hostBody = {
    model: "claude-sonnet-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  };

  beforeEach(() => {
    buildClaudeCodeRequest.mockClear();
    buildClaudeCodeCountTokensRequest.mockClear();
  });

  it("passes WIRE_PROFILE as the explicit `profile` argument to buildClaudeCodeRequest", async () => {
    await buildWireCompatibleRequest(JSON.stringify(hostBody), transport);

    expect(buildClaudeCodeRequest).toHaveBeenCalledTimes(1);
    const [, profileArgument] = buildClaudeCodeRequest.mock.calls[0];
    expect(profileArgument).toBe(WIRE_PROFILE);
  });

  it("passes WIRE_PROFILE as the explicit `profile` argument to buildClaudeCodeCountTokensRequest", async () => {
    await buildWireCompatibleCountTokensRequest(JSON.stringify(hostBody), transport);

    expect(buildClaudeCodeCountTokensRequest).toHaveBeenCalledTimes(1);
    const [, profileArgument] = buildClaudeCodeCountTokensRequest.mock.calls[0];
    expect(profileArgument).toBe(WIRE_PROFILE);
  });

  it("produces byte-identical output to omitting the profile argument (today's package default)", async () => {
    const original = await vi.importActual("@tormentalabs/claude-code-wire-compat");
    const input = toClaudeCodeRequestInput(hostBody, transport);

    const withExplicitProfile = await original.buildClaudeCodeRequest(input, WIRE_PROFILE);
    const withOmittedProfile = await original.buildClaudeCodeRequest(input);

    expect(withExplicitProfile).toEqual(withOmittedProfile);
  });

  it("produces byte-identical count-tokens output to omitting the profile argument", async () => {
    const original = await vi.importActual("@tormentalabs/claude-code-wire-compat");
    const input = toClaudeCodeCountTokensInput(hostBody, transport);

    const withExplicitProfile = await original.buildClaudeCodeCountTokensRequest(input, WIRE_PROFILE);
    const withOmittedProfile = await original.buildClaudeCodeCountTokensRequest(input);

    expect(withExplicitProfile).toEqual(withOmittedProfile);
  });
});

// Catalogue seam helpers. Expected values are the 2.1.280 catalogue (the
// profile WIRE_PROFILE is bound to); they move with it when the profile does.
describe("fast mode eligibility helpers", () => {
  it("isFastModeEligibleWire follows the catalogue, and Opus 4.6/4.7 only with legacyModels", () => {
    expect(isFastModeEligibleWire("claude-opus-4-8")).toBe(true);
    expect(isFastModeEligibleWire("claude-opus-4-7")).toBe(false);
    expect(isFastModeEligibleWire("claude-opus-4-6", { legacyModels: false })).toBe(false);
    expect(isFastModeEligibleWire("claude-opus-4-7", { legacyModels: true })).toBe(true);
    expect(isFastModeEligibleWire("claude-opus-4-6", { legacyModels: true })).toBe(true);
    expect(isFastModeEligibleWire("claude-sonnet-5", { legacyModels: true })).toBe(false);
    expect(isFastModeEligibleWire(undefined, { legacyModels: true })).toBe(false);
  });

  it("describeFastModeEligibility lists exactly the catalogue's fast_mode ids", () => {
    const ids = Object.entries(WIRE_PROFILE.supportedModels)
      .filter(([, entry]) => entry.capabilities?.includes("fast_mode"))
      .map(([id]) => id.replace(/^claude-/, ""));
    expect(ids.length).toBeGreaterThan(0);

    const off = describeFastModeEligibility();
    for (const id of ids) expect(off).toContain(id);
    expect(off).toContain("only with fast_mode_legacy_models");
    expect(off).not.toContain("opus-4-7 (");

    const on = describeFastModeEligibility({ legacyModels: true });
    for (const id of [...ids, "opus-4-6", "opus-4-7"]) expect(on).toContain(id);
    expect(on).not.toContain("only with");
  });
});

describe("catalogueEntryForWire", () => {
  it("finds a catalogued id and tolerates case, dots, markers and a date suffix", () => {
    const entry = WIRE_PROFILE.supportedModels["claude-opus-4-7"];
    expect(catalogueEntryForWire("claude-opus-4-7")).toBe(entry);
    expect(catalogueEntryForWire("Claude-Opus-4-7")).toBe(entry);
    expect(catalogueEntryForWire("claude-opus-4.7")).toBe(entry);
    expect(catalogueEntryForWire("claude-opus-4-7[1m]")).toBe(entry);
    expect(catalogueEntryForWire("claude-opus-4-7-20260101")).toBe(entry);
  });

  it("does NOT fold an unknown id onto the nearest catalogued one", () => {
    // Uncatalogued under 2.1.329: the package's ladder would fold it onto
    // `claude-mythos-5`, an exact-key lookup must not.
    expect(catalogueEntryForWire("claude-mythos-5-3")).toBeUndefined();
    expect(catalogueEntryForWire("claude-opus-5-5-1")).toBeUndefined();
    expect(catalogueEntryForWire("anthropic.claude-opus-4-6-v1:0")).toBeUndefined();
    expect(catalogueEntryForWire("claude-opus-4-7-1m")).toBeUndefined();
  });

  it("is safe on prototype keys and non-strings", () => {
    expect(catalogueEntryForWire("constructor")).toBeUndefined();
    expect(catalogueEntryForWire("__proto__")).toBeUndefined();
    expect(catalogueEntryForWire("")).toBeUndefined();
    expect(catalogueEntryForWire(undefined)).toBeUndefined();
    expect(catalogueEntryForWire(42)).toBeUndefined();
  });
});

describe("catalogue capability helpers", () => {
  it("gates adaptive thinking on the catalogue capability, not just the package union", () => {
    expect(isAdaptiveThinkingModel("claude-opus-5-5")).toBe(true);
    expect(isAdaptiveThinkingModel("claude-sonnet-5")).toBe(true);
    // Catalogued with an empty capability list under 2.1.280.
    expect(isAdaptiveThinkingModel("claude-mythos-5")).toBe(false);
    expect(isAdaptiveThinkingModel("claude-haiku-4-5")).toBe(false);
    expect(isAdaptiveThinkingModel(undefined)).toBe(false);
  });

  it("answers effort support from the entry", () => {
    expect(supportsEffortWire("claude-opus-4-6")).toBe(true);
    expect(supportsEffortWire("claude-haiku-4-5")).toBe(false);
    expect(supportsEffortWire("claude-mythos-5")).toBe(false);
    // New at 2.1.329: effort and adaptive thinking.
    expect(supportsEffortWire("claude-mythos-5-2")).toBe(true);
    expect(supportsEffortWire("claude-unknown-9")).toBe(false);
  });

  it("maps max and xhigh to their own capabilities", () => {
    expect(supportsEffortLevelWire("claude-opus-4-6", "max")).toBe(true);
    expect(supportsEffortLevelWire("claude-opus-4-6", "xhigh")).toBe(false);
    expect(supportsEffortLevelWire("claude-opus-4-7", "xhigh")).toBe(true);
    expect(supportsEffortLevelWire("claude-opus-4-7", "medium")).toBe(true);
    expect(supportsEffortLevelWire("claude-opus-4-7", "bogus")).toBe(false);
    expect(supportsEffortLevelWire("claude-haiku-4-5", "low")).toBe(false);
  });

  it("answers fast mode from the catalogue", () => {
    expect(supportsFastModeWire("claude-opus-4-8")).toBe(true);
    expect(supportsFastModeWire("claude-opus-5-5")).toBe(true);
    expect(supportsFastModeWire("claude-opus-4-7")).toBe(false);
    expect(supportsFastModeWire("claude-opus-4-6")).toBe(false);
    expect(supportsFastModeWire("claude-sonnet-5")).toBe(false);
  });

  it("reads org-locked thinking from the catalogue capability", () => {
    for (const model of ["claude-sonnet-5-5", "claude-mythos-5-2", "claude-fable-5-2", "claude-haiku-5-5"]) {
      expect(isOrgLockedThinkingModelWire(model), model).toBe(true);
    }
    for (const model of ["claude-opus-5-5", "claude-opus-4-7", "claude-mythos-5", "claude-unknown-9"]) {
      expect(isOrgLockedThinkingModelWire(model), model).toBe(false);
    }
  });

  it("reads the default effort", () => {
    expect(catalogueDefaultEffortWire("claude-opus-5-5")).toBe("medium");
    expect(catalogueDefaultEffortWire("claude-opus-4-7")).toBe("xhigh");
    expect(catalogueDefaultEffortWire("claude-opus-4-6")).toBeUndefined();
    expect(catalogueDefaultEffortWire("nope")).toBeUndefined();
  });

  it("reads native 1M context from the catalogue entry", () => {
    expect(isNativeOneMillionContextWire("claude-opus-4-7")).toBe(true);
    expect(isNativeOneMillionContextWire("claude-opus-4-6")).toBe(false);
    expect(isNativeOneMillionContextWire("claude-haiku-4-5")).toBe(false);
    expect(isNativeOneMillionContextWire("nope")).toBe(false);
  });

  it("reads the default output-token limit", () => {
    expect(catalogueDefaultMaxTokensWire("claude-opus-5-5")).toBe(128000);
    expect(catalogueDefaultMaxTokensWire("claude-haiku-4-5")).toBe(32000);
    expect(catalogueDefaultMaxTokensWire("nope")).toBeUndefined();
  });
});
