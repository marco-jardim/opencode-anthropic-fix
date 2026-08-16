/**
 * Pass-through guard for the count-tokens extra-header policy.
 *
 * WHAT THIS PINS. `ClaudeCodeCountTokensInput` accepts `extraHeaderPolicy`
 * since wire-compat 0.4.0, so the plugin no longer reproduces the package's
 * `dropConflicting` policy against mirrored header-ownership lists — it asks
 * the package for it, exactly like the main turn does through
 * `buildAdapterTransport`. The three mirrors and their drift guards died with
 * that seam; what survives is the seam itself:
 *
 *   (a) `toClaudeCodeCountTokensInput` emits
 *       `extraHeaderPolicy: "dropConflicting"`;
 *   (b) the installed package ACCEPTS that key — `validateCountTokensInput`
 *       runs `assertExactKeys`, so a package that dropped the key from the pick
 *       would fail here with `INVALID_INPUT` instead of failing in production
 *       as a count turn that throws on the first host header;
 *   (c) end to end: a host header the package owns does not reach the wire
 *       twice, a header it does not own is forwarded verbatim, and a forbidden
 *       (hop-by-hop / credential) name is dropped rather than raising.
 *
 * Under the package default (`strict`) the first owned host header raises
 * `DUPLICATE_HEADER` or `FORBIDDEN_HEADER` and nothing reaches the wire at all.
 * The plugin forwards a heterogeneous host header map — the opencode SDK alone
 * sends `content-type` and `accept` — so (b) and (c) are the difference between
 * a working count turn and none.
 */

import { describe, it, expect } from "vitest";
import { buildClaudeCodeCountTokensRequest } from "@tormentalabs/claude-code-wire-compat";
import { toClaudeCodeCountTokensInput } from "../../lib/mimicry/wire-compat.mjs";

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
 * The package emits headers as an ordered pair list, not a `Headers`. Kept as
 * pairs here so a duplicate emission is observable rather than collapsed.
 *
 * @param {readonly (readonly [string, string])[]} headers
 * @param {string} name
 */
function headerValues(headers, name) {
  return [...headers].filter(([header]) => header.toLowerCase() === name).map(([, value]) => value);
}

/**
 * Map a host body + host header map through the plugin's count mapper.
 *
 * @param {readonly (readonly [string, string])[]} extraHeaders
 */
function mapCountInput(extraHeaders) {
  return toClaudeCodeCountTokensInput(
    { model: BASE_INPUT.model, messages: BASE_INPUT.messages },
    {
      accessToken: BASE_INPUT.accessToken,
      clientRequestId: BASE_INPUT.clientRequestId,
      runtime: RUNTIME,
      extraHeaders,
    },
  );
}

describe("count-tokens extra-header policy is delegated to the package", () => {
  it("asks the package for the dropConflicting policy", () => {
    const input = mapCountInput([["accept", "application/json"]]);

    expect(input.extraHeaderPolicy).toBe("dropConflicting");
  });

  it("is accepted by the installed package rather than rejected as an unknown key", async () => {
    // `assertExactKeys` guard: a package release that removed `extraHeaderPolicy`
    // from the count pick would raise INVALID_INPUT here.
    const built = await buildClaudeCodeCountTokensRequest(mapCountInput([["accept", "application/json"]]));

    expect(headerValues(built.headers, "accept")).toEqual(["application/json"]);
  });

  it("forwards a host header the package does not own", async () => {
    // The policy must not degrade into "drop everything". `accept` is sent by
    // the opencode SDK and is neither canonical nor denylisted.
    const built = await buildClaudeCodeCountTokensRequest(
      mapCountInput([
        ["accept", "application/json"],
        ["content-type", "application/json"],
        ["x-forwarded-for", "10.0.0.1"],
        ["host", "proxy.internal"],
      ]),
    );

    expect(headerValues(built.headers, "accept")).toEqual(["application/json"]);
    // The canonical name the package owns is emitted exactly once, with the
    // package's own value — the host copy did not duplicate or override it.
    expect(headerValues(built.headers, "content-type")).toEqual(["application/json"]);
    // Forbidden names are dropped, not raised on, and never reach the wire.
    expect(headerValues(built.headers, "host")).toEqual([]);
    expect(headerValues(built.headers, "x-forwarded-for")).toEqual([]);
  });

  it("reports the dropped names in the build evidence", async () => {
    const built = await buildClaudeCodeCountTokensRequest(
      mapCountInput([
        ["accept", "application/json"],
        ["content-type", "application/json"],
        ["host", "proxy.internal"],
      ]),
    );

    expect(built.evidence.droppedExtraHeaderNames).toEqual(["content-type", "host"]);
  });

  it("builds when every host header is dropped", async () => {
    // The all-dropped case used to be special-cased plugin-side by omitting the
    // key entirely; under the seam the package resolves it to an empty set and
    // the build still succeeds.
    const built = await buildClaudeCodeCountTokensRequest(mapCountInput([["content-type", "application/json"]]));

    expect(built.evidence.droppedExtraHeaderNames).toEqual(["content-type"]);
    expect(headerValues(built.headers, "content-type")).toEqual(["application/json"]);
  });
});
