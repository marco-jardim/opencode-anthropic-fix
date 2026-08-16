/**
 * These model helpers are published API because package.json `main` is
 * `./index.mjs`. This contract freezes their behavior across the upcoming
 * request-construction refactor. Any intentional change to these results is a
 * BREAKING CHANGE requiring a major version decision.
 *
 * TIGHTENED when the hand-written regexes of `lib/mimicry/models.mjs` were
 * retired in favour of the wire package's model catalogue (see
 * `test/conformance/model-predicates-parity.test.mjs`). Two families of input
 * that the retired regexes accepted are now REJECTED, deliberately:
 *
 *   1. Prefix-less fragments (`opus-4-7`, `fable-5`, `sonnet.4.6`). The old
 *      alternation `|opus[._-]4[._-]7` matched a bare version fragment as if it
 *      were a model id. It is not one, and the request builder would reject it
 *      anyway, so treating it as a recognised family only ever produced gating
 *      that disagreed with the request actually sent.
 *   2. The UNDERSCORE version separator (`claude-opus-4_7`). Anthropic has
 *      never published an underscore-separated id; the catalogue accepts `-`
 *      and `.` only.
 *
 * Both are pinned below as explicit `false` rows rather than deleted, so the
 * narrowing stays visible and a silent re-widening fails this contract.
 */
import { describe, it, expect } from "vitest";

import { isFable5Model, isMythos5Model, isAdaptiveThinkingModel } from "../../index.mjs";

/** Version separators the model catalogue recognises. */
const separators = [".", "-"];

/** Version separator the catalogue does NOT recognise — see (2) above. */
const rejectedSeparators = ["_"];

const fableCases = ["claude-fable-5"].map((identifier) => ({
  label: identifier,
  identifier,
  expectedFable: true,
  expectedMythos: false,
  expectedAdaptive: true,
}));

const mythosCases = ["claude-mythos-5"].map((identifier) => ({
  label: identifier,
  identifier,
  expectedFable: false,
  expectedMythos: true,
  expectedAdaptive: true,
}));

const opusCases = [6, 7, 8].flatMap((version) => separators.map((separator) => `claude-opus-4${separator}${version}`));

const sonnetCases = separators.map((separator) => `claude-sonnet-4${separator}6`);

const adaptiveOnlyCases = [...opusCases, ...sonnetCases].map((identifier) => ({
  label: identifier,
  identifier,
  expectedFable: false,
  expectedMythos: false,
  expectedAdaptive: true,
}));

/** (1) above — a bare version fragment is not a model id. */
const prefixlessFragments = [
  ...[...separators, ...rejectedSeparators].flatMap((separator) => [`fable${separator}5`, `mythos${separator}5`]),
  ...[6, 7, 8].flatMap((version) =>
    [...separators, ...rejectedSeparators].flatMap((firstSeparator) =>
      [...separators, ...rejectedSeparators].map(
        (secondSeparator) => `opus${firstSeparator}4${secondSeparator}${version}`,
      ),
    ),
  ),
  ...[...separators, ...rejectedSeparators].flatMap((firstSeparator) =>
    [...separators, ...rejectedSeparators].map((secondSeparator) => `sonnet${firstSeparator}4${secondSeparator}6`),
  ),
];

/** (2) above — the underscore version separator is not a published spelling. */
const underscoreSeparated = [
  ...[6, 7, 8].flatMap((version) => rejectedSeparators.map((separator) => `claude-opus-4${separator}${version}`)),
  ...rejectedSeparators.map((separator) => `claude-sonnet-4${separator}6`),
];

const unrecognizedCases = [...prefixlessFragments, ...underscoreSeparated].map((identifier) => ({
  label: identifier,
  identifier,
  expectedFable: false,
  expectedMythos: false,
  expectedAdaptive: false,
}));

const behaviorCases = [
  ...fableCases,
  ...mythosCases,
  ...adaptiveOnlyCases,
  ...unrecognizedCases,
  {
    label: "unrelated identifier",
    identifier: "totally-unrelated-model",
    expectedFable: false,
    expectedMythos: false,
    expectedAdaptive: false,
  },
  {
    label: "prefixed identifier",
    identifier: "not-a-claude-fable-5",
    expectedFable: true,
    expectedMythos: false,
    expectedAdaptive: true,
  },
  {
    label: "suffixed identifier",
    identifier: "claude-fable-5-experimental",
    expectedFable: true,
    expectedMythos: false,
    expectedAdaptive: true,
  },
  {
    label: "embedded identifier",
    identifier: "before-claude-fable-5-after",
    expectedFable: true,
    expectedMythos: false,
    expectedAdaptive: true,
  },
  {
    label: "uppercase identifier",
    identifier: "CLAUDE-FABLE-5",
    expectedFable: true,
    expectedMythos: false,
    expectedAdaptive: true,
  },
  {
    label: "mixed-case identifier",
    identifier: "ClAuDe-FaBlE-5",
    expectedFable: true,
    expectedMythos: false,
    expectedAdaptive: true,
  },
  {
    label: "empty string",
    identifier: "",
    expectedFable: false,
    expectedMythos: false,
    expectedAdaptive: false,
  },
  {
    label: "undefined",
    identifier: undefined,
    expectedFable: false,
    expectedMythos: false,
    expectedAdaptive: false,
  },
  {
    label: "null",
    identifier: null,
    expectedFable: false,
    expectedMythos: false,
    expectedAdaptive: false,
  },
  {
    label: "number",
    identifier: 42,
    expectedFable: false,
    expectedMythos: false,
    expectedAdaptive: false,
  },
  {
    label: "object",
    identifier: { model: "claude-fable-5" },
    expectedFable: false,
    expectedMythos: false,
    expectedAdaptive: false,
  },
];

describe("published model helper contract", () => {
  it("publishes the model helpers as functions", () => {
    expect(typeof isFable5Model).toBe("function");
    expect(typeof isMythos5Model).toBe("function");
    expect(typeof isAdaptiveThinkingModel).toBe("function");
  });

  it.each(behaviorCases)("freezes $label", ({ identifier, expectedFable, expectedMythos, expectedAdaptive }) => {
    expect(isFable5Model(identifier)).toBe(expectedFable);
    expect(isMythos5Model(identifier)).toBe(expectedMythos);
    expect(isAdaptiveThinkingModel(identifier)).toBe(expectedAdaptive);
  });
});
