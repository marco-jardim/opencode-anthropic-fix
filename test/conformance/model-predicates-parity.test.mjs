import { describe, expect, it } from "vitest";

import {
  hasOneMillionContext,
  isAdaptiveThinkingModel,
  isClaude3Model,
  isEligibleFor1MContextWire,
  isFable5Model,
  isMythos5Model,
  isOpus46Model,
  isOpus47Model,
  isOpus48Model,
  buildWireCompatibleRequest,
} from "../../lib/mimicry/wire-compat.mjs";
import { buildAdapterTransport, PROFILE_CLI_VERSION } from "../../lib/mimicry/adapter-input.mjs";

/**
 * PARITY TABLE for the model-family predicates.
 *
 * `lib/mimicry/models.mjs` used to answer these questions with hand-written
 * regexes maintained in parallel with the wire package's model catalogue. It is
 * deleted; every predicate below now resolves through the wire-compat seam to
 * the package, which is the SAME source the request builder classifies with.
 * This table exists so the migration's semantics are pinned as data rather than
 * inferred from callers, and so any future catalogue bump shows up here first.
 *
 * FOUR ROWS DELIBERATELY DIVERGE from the deleted plugin code. They are marked
 * `DIVERGENCE (n)` inline. All four are legacy bugs in the retired regexes, not
 * regressions: the canonical catalogue wins (QA 1.1 disposition). Concretely,
 * the plugin used to under-report Claude 3 for dotted ids and under-report 1M
 * eligibility for two model families, and it used to over-report every family
 * for bare version fragments carrying no `claude-` prefix.
 *
 * Every expected value below was verified empirically against the installed
 * package before being written down.
 */

/** @type {Record<string, (model: string) => boolean>} */
const PREDICATES = {
  hasOneMillionContext,
  isAdaptiveThinkingModel,
  isClaude3Model,
  isEligibleFor1MContextWire,
  isFable5Model,
  isMythos5Model,
  isOpus46Model,
  isOpus47Model,
  isOpus48Model,
};

/**
 * Rows are `[model, expectedTruePredicateNames]`. Any predicate NOT listed for a
 * row is asserted `false`, so adding a predicate to the seam without extending
 * this table fails loudly instead of going unpinned.
 *
 * @type {ReadonlyArray<readonly [string, readonly string[]]>}
 */
const MATRIX = [
  // --- canonical dashed ids -------------------------------------------------
  ["claude-opus-4-6", ["isOpus46Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-opus-4-7", ["isOpus47Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-opus-4-8", ["isOpus48Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-sonnet-4-6", ["isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-sonnet-4-5", ["isEligibleFor1MContextWire"]],
  ["claude-haiku-4-5", []],
  // DIVERGENCE (2): the retired `isEligibleFor1MContext` gated on Sonnet 4 /
  // Opus 4.6-4.8 only, so Fable 5 came back false. The catalogue marks the
  // family `supports1mBeta`, so it is eligible.
  ["claude-fable-5", ["isFable5Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  // DIVERGENCE (3): same as (2) for Mythos 5 — and this row is ALSO why
  // `isEligibleFor1MContextWire` binds `WIRE_PROFILE` instead of calling the
  // package bare: under the package's default profile (2.1.195) this model is
  // NOT eligible; under the 2.1.233 profile the plugin emulates, it is.
  ["claude-mythos-5", ["isMythos5Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],

  // --- dotted version separators (host tolerance) ---------------------------
  ["claude-opus-4.7", ["isOpus47Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-opus-4.8", ["isOpus48Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-sonnet-4.6", ["isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],

  // --- dated / EAP suffixes -------------------------------------------------
  ["claude-opus-4-7-20250929", ["isOpus47Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-opus-4-8-20260528", ["isOpus48Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-opus-4.7-EAP[foo]", ["isOpus47Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-fable-5-20260101", ["isFable5Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  ["claude-mythos-5-20260101", ["isMythos5Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],

  // --- explicit 1M markers --------------------------------------------------
  // `hasOneMillionContext` is the STATIC "always 1M" answer and stays narrower
  // than eligibility: only a `-1m`-style suffix qualifies, never `[1m]`.
  [
    "claude-opus-4-6-1m",
    ["hasOneMillionContext", "isOpus46Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"],
  ],
  ["claude-opus-4-6[1m]", ["isOpus46Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],

  // --- Claude 3 -------------------------------------------------------------
  ["claude-3-5-sonnet", ["isClaude3Model"]],
  ["claude-3-opus-20240229", ["isClaude3Model"]],
  // DIVERGENCE (1): the retired `CLAUDE_3_MODEL_RE` was `/claude-3-/i` — dotted
  // ids never matched, so a Claude 3 model spelled with a dot was handed betas
  // (advisor-tool, interleaved-thinking, context-management) that Claude 3 does
  // not accept. The package tolerates the dot, so this is now true.
  ["claude-3.5-sonnet", ["isClaude3Model"]],

  // --- Bedrock-style vendor prefixes ----------------------------------------
  ["anthropic.claude-opus-4-6-v1:0", ["isOpus46Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"]],
  [
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7-v1:0",
    ["isOpus47Model", "isAdaptiveThinkingModel", "isEligibleFor1MContextWire"],
  ],

  // --- DIVERGENCE (4a): bare version fragments ------------------------------
  // The retired regexes carried an `|opus[._-]4[._-]6`-style alternation, so a
  // prefix-less fragment matched a family. The package requires the `claude-`
  // prefix (or a vendor-prefixed form of it), so these are now false across the
  // board. This tightens classification: a bare fragment is not a model id, and
  // the request builder would never have accepted it as one anyway.
  ["opus-4-6", []],
  ["opus-4.6", []],
  ["fable-5", []],
  ["mythos-5", []],

  // --- DIVERGENCE (4b): the underscore version separator --------------------
  // The retired regexes spelled the separator `[._-]`, accepting an underscore
  // Anthropic has never published. The catalogue accepts `-` and `.` only, so
  // these ids no longer resolve to a family.
  ["claude-opus-4_7", []],
  // Still 1M-eligible, but as a generic Sonnet 4 rather than as Sonnet 4.6:
  // the catalogue resolves the unrecognised `_6` suffix down to the family
  // base, which supports the 1M beta. Adaptive thinking, which is a 4.6-only
  // capability, is correctly withheld.
  ["claude-sonnet-4_6", ["isEligibleFor1MContextWire"]],

  // --- non-Anthropic / empty ------------------------------------------------
  ["gpt-4o", []],
  ["", []],
];

describe("model predicate parity after the models.mjs retirement", () => {
  it("pins every predicate the seam re-exports", () => {
    // Guards the "unlisted means false" contract above: a new seam export that
    // this table does not know about must not silently go unpinned.
    expect(Object.keys(PREDICATES).sort()).toEqual([
      "hasOneMillionContext",
      "isAdaptiveThinkingModel",
      "isClaude3Model",
      "isEligibleFor1MContextWire",
      "isFable5Model",
      "isMythos5Model",
      "isOpus46Model",
      "isOpus47Model",
      "isOpus48Model",
    ]);
  });

  it.each(MATRIX)("classifies %j", (model, expectedTrue) => {
    const unknown = expectedTrue.filter((name) => !(name in PREDICATES));
    expect(unknown).toEqual([]);

    const actual = Object.entries(PREDICATES)
      .filter(([, predicate]) => predicate(model) === true)
      .map(([name]) => name)
      .sort();

    expect(actual).toEqual([...expectedTrue].sort());
  });

  it("returns false for every predicate on a nullish model", () => {
    for (const [name, predicate] of Object.entries(PREDICATES)) {
      expect(predicate(undefined), name).toBe(false);
      expect(predicate(null), name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The seam still owes the wire a DASHED model id
// ---------------------------------------------------------------------------

/**
 * The migration plan assumed that once the predicates came from the package,
 * `normalizeModelVersionSeparators` in `lib/mimicry/wire-compat.mjs` could be
 * retired because the package would normalize the id itself. That premise is
 * WRONG, and this test is the pin.
 *
 * The package is dotted-TOLERANT in its DECISIONS only: the predicates above
 * classify `claude-opus-4.7` correctly. The request BODY is a separate matter —
 * the package copies the caller's model through verbatim apart from stripping
 * `[1m]`-style markers, so a bare call with `claude-opus-4.7` puts
 * `claude-opus-4.7` on the wire.
 *
 * The real API only accepts the dashed spelling, so the dotted-id rewrite stays
 * in the seam and the built body must be dashed. That is the invariant here.
 */
describe("seam — dotted model ids reach the wire dashed", () => {
  const SESSION_ID = "11111111-1111-4111-8111-111111111111";
  const DEVICE_ID = "2".repeat(64);
  const ACCOUNT_UUID = "33333333-3333-4333-8333-333333333333";
  const CLIENT_REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  /** @param {string} model */
  function transportFor(model) {
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    const result = buildAdapterTransport({
      input: undefined,
      requestInit: {},
      accessToken: "host-access-token",
      requestUrl: new URL("https://api.anthropic.com/v1/messages"),
      provider: "anthropic",
      clientRequestId: CLIENT_REQUEST_ID,
      signature: {
        enabled: true,
        claudeCliVersion: PROFILE_CLI_VERSION,
        customBetas: [],
        strategy: "default",
        sessionId: SESSION_ID,
      },
      identity: { persistentUserId: DEVICE_ID, accountId: ACCOUNT_UUID },
      adaptiveOverride: undefined,
      tokenEconomy: {},
      body,
      env: {},
      platform: "win32",
      arch: "x64",
      nodeVersion: "v22.11.0",
    });
    if (!result.applicable) throw new Error(`expected applicable transport, got skip: ${result.reason}`);
    return { body, transport: result.transport };
  }

  it("rewrites a dotted version separator in the built body", async () => {
    const { body, transport } = transportFor("claude-opus-4.7");
    const built = await buildWireCompatibleRequest(body, transport);

    expect(JSON.parse(built.body).model).toBe("claude-opus-4-7");
  });

  it("leaves an already dashed id untouched", async () => {
    const { body, transport } = transportFor("claude-opus-4-7");
    const built = await buildWireCompatibleRequest(body, transport);

    expect(JSON.parse(built.body).model).toBe("claude-opus-4-7");
  });
});
