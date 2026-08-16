/**
 * Drift guard for the header-ownership lists the plugin MIRRORS from the shared
 * package.
 *
 * WHY THESE MIRRORS EXIST. `ClaudeCodeCountTokensInput` is a sixteen-key
 * `Pick<ClaudeCodeRequestInput, ...>` and `extraHeaderPolicy` is NOT one of the
 * sixteen. `validateCountTokensInput` runs `assertExactKeys`, so passing the
 * policy is `INVALID_INPUT` rather than an ignored key. The count surface
 * therefore always resolves extra headers under `strict`, where the first host
 * header the package owns raises `DUPLICATE_HEADER` (a canonical name) or
 * `FORBIDDEN_HEADER` (a hop-by-hop or credential name) and nothing reaches the
 * wire at all. The main turn opts out of that with
 * `extraHeaderPolicy: "dropConflicting"`; the count turn cannot, so
 * `dropConflictingExtraHeaders` in lib/mimicry/wire-compat.mjs reproduces the
 * policy plugin-side against three mirrored lists.
 *
 * A mirror is a liability the moment it stops matching its source. These tests
 * assert the lists against the package's REAL behaviour rather than against the
 * package's source text, so a package release that renames, adds or removes an
 * owned header fails here instead of failing in production as a count turn that
 * throws (over-narrow mirror) or a count turn that silently drops a host header
 * it should have forwarded (over-broad mirror).
 */

import { describe, it, expect } from "vitest";
import { buildClaudeCodeCountTokensRequest, ClaudeCodeWireError } from "@tormentalabs/claude-code-wire-compat";
import {
  PACKAGE_CANONICAL_HEADER_NAMES,
  PACKAGE_FORBIDDEN_HEADER_NAMES,
  PACKAGE_FORBIDDEN_HEADER_PREFIXES,
  toClaudeCodeCountTokensInput,
} from "../../lib/mimicry/wire-compat.mjs";

const RUNTIME = Object.freeze({
  sessionId: "11111111-1111-4111-8111-111111111111",
  deviceId: "2".repeat(64),
  accountUuid: "33333333-3333-4333-8333-333333333333",
  runtime: "node",
  runtimeVersion: "v20.0.0",
  // The package validates this against a closed set: "Windows" | "Linux" |
  // "macOS". Fixed rather than derived from `process.platform` so the vector is
  // identical on every machine that runs the suite.
  os: "Linux",
  arch: "x64",
});

const BASE_INPUT = Object.freeze({
  accessToken: "sk-ant-oat01-conformance",
  model: "claude-sonnet-4-5-20250929",
  messages: [{ role: "user", content: "hi" }],
  runtime: RUNTIME,
  clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
});

/**
 * Build a count request carrying exactly one extra header and report the wire
 * error code, or `null` when the package accepted it.
 *
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function conflictCodeFor(name) {
  try {
    await buildClaudeCodeCountTokensRequest({ ...BASE_INPUT, extraHeaders: [[name, "probe-value"]] });
    return null;
  } catch (error) {
    if (!(error instanceof ClaudeCodeWireError)) throw error;
    return error.code;
  }
}

describe("count-tokens extra-header policy mirrors the package", () => {
  it("rejects every mirrored canonical name with DUPLICATE_HEADER", async () => {
    const observed = await Promise.all(
      [...PACKAGE_CANONICAL_HEADER_NAMES].map(async (name) => [name, await conflictCodeFor(name)]),
    );

    // OVER-BROAD guard. A name the plugin drops but the package would have
    // accepted is a host header silently withheld from the wire.
    expect(Object.fromEntries(observed)).toEqual(
      Object.fromEntries([...PACKAGE_CANONICAL_HEADER_NAMES].map((name) => [name, "DUPLICATE_HEADER"])),
    );
  });

  it("rejects every mirrored forbidden name and prefix", async () => {
    const names = [
      ...PACKAGE_FORBIDDEN_HEADER_NAMES,
      ...PACKAGE_FORBIDDEN_HEADER_PREFIXES.map((prefix) => `${prefix}probe`),
    ];
    const observed = await Promise.all(names.map(async (name) => [name, await conflictCodeFor(name)]));

    // `x-api-key` is both denylisted package-side and stripped plugin-side by
    // `ADAPTER_STRIPPED_HOST_HEADERS`, so it is covered twice on purpose.
    expect(Object.fromEntries(observed)).toEqual(Object.fromEntries(names.map((name) => [name, "FORBIDDEN_HEADER"])));
  });

  it("covers every header the package actually emits on a count build", async () => {
    // OVER-NARROW guard, and the one that catches a package release ADDING a
    // canonical header: whatever the package composes for itself is a name the
    // plugin must never forward.
    const built = await buildClaudeCodeCountTokensRequest(BASE_INPUT);
    const emitted = [...built.headers].map(([name]) => name.toLowerCase());

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.filter((name) => !PACKAGE_CANONICAL_HEADER_NAMES.has(name))).toEqual([]);
  });

  it("forwards a host header the package does not own", async () => {
    // The mirrors must not degrade into "drop everything". `accept` is sent by
    // the opencode SDK and is neither canonical nor denylisted.
    expect(await conflictCodeFor("accept")).toBeNull();

    const input = toClaudeCodeCountTokensInput(
      { model: BASE_INPUT.model, messages: BASE_INPUT.messages },
      {
        accessToken: BASE_INPUT.accessToken,
        clientRequestId: BASE_INPUT.clientRequestId,
        runtime: RUNTIME,
        extraHeaders: [
          ["accept", "application/json"],
          ["content-type", "application/json"],
          ["x-forwarded-for", "10.0.0.1"],
          ["host", "proxy.internal"],
        ],
      },
    );

    expect(input.extraHeaders).toEqual([["accept", "application/json"]]);
  });

  it("omits extraHeaders entirely when every host header is dropped", async () => {
    // `undefined` rather than `[]`: the package's own default is an empty list,
    // and emitting the key with an empty array would be a gratuitous divergence
    // from the input a consumer that forwards nothing would produce.
    const input = toClaudeCodeCountTokensInput(
      { model: BASE_INPUT.model, messages: BASE_INPUT.messages },
      {
        accessToken: BASE_INPUT.accessToken,
        clientRequestId: BASE_INPUT.clientRequestId,
        runtime: RUNTIME,
        extraHeaders: [["content-type", "application/json"]],
      },
    );

    expect(input).not.toHaveProperty("extraHeaders");
    await expect(buildClaudeCodeCountTokensRequest(input)).resolves.toBeDefined();
  });
});
