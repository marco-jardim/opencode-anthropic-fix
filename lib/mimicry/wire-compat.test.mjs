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
  getWireCompatPackageVersion,
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
