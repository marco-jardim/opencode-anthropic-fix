import { describe, expect, it } from "vitest";

import { isFalsyEnv, isTruthyEnv } from "./env.mjs";

describe("environment value parsers", () => {
  describe("isTruthyEnv", () => {
    it.each(["1", "true", "yes", " TRUE ", "Yes"])("accepts %j", (value) => {
      expect(isTruthyEnv(value)).toBe(true);
    });

    it.each([undefined, "", "0", "false", "no", "on", "off", "anything"])("rejects %j", (value) => {
      expect(isTruthyEnv(value)).toBe(false);
    });
  });

  describe("isFalsyEnv", () => {
    it.each(["0", "false", "no", " FALSE ", "No"])("accepts %j", (value) => {
      expect(isFalsyEnv(value)).toBe(true);
    });

    it.each([undefined, "", "1", "true", "yes", "on", "off", "anything"])("rejects %j", (value) => {
      expect(isFalsyEnv(value)).toBe(false);
    });
  });
});
