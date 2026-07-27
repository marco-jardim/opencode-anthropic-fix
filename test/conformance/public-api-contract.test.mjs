/**
 * These model helpers are published API because package.json `main` is
 * `./index.mjs`. This contract freezes their behavior across the upcoming
 * request-construction refactor. Any intentional change to these results is a
 * BREAKING CHANGE requiring a major version decision.
 */
import { describe, it, expect } from "vitest";

import { isFable5Model, isMythos5Model, isAdaptiveThinkingModel } from "../../index.mjs";

const separators = [".", "_", "-"];

const fableCases = ["claude-fable-5", ...separators.map((separator) => `fable${separator}5`)].map((identifier) => ({
  label: identifier,
  identifier,
  expectedFable: true,
  expectedMythos: false,
  expectedAdaptive: true,
}));

const mythosCases = ["claude-mythos-5", ...separators.map((separator) => `mythos${separator}5`)].map((identifier) => ({
  label: identifier,
  identifier,
  expectedFable: false,
  expectedMythos: true,
  expectedAdaptive: true,
}));

const opusCases = [6, 7, 8].flatMap((version) => [
  ...separators.map((separator) => `claude-opus-4${separator}${version}`),
  ...separators.flatMap((firstSeparator) =>
    separators.map((secondSeparator) => `opus${firstSeparator}4${secondSeparator}${version}`),
  ),
]);

const sonnetCases = [
  ...separators.map((separator) => `claude-sonnet-4${separator}6`),
  ...separators.flatMap((firstSeparator) =>
    separators.map((secondSeparator) => `sonnet${firstSeparator}4${secondSeparator}6`),
  ),
];

const adaptiveOnlyCases = [...opusCases, ...sonnetCases].map((identifier) => ({
  label: identifier,
  identifier,
  expectedFable: false,
  expectedMythos: false,
  expectedAdaptive: true,
}));

const behaviorCases = [
  ...fableCases,
  ...mythosCases,
  ...adaptiveOnlyCases,
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
