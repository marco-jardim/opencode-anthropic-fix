import { describe, it, expect } from "vitest";
import { shouldMicrocompact, buildMicrocompactBetas } from "./microcompact.mjs";

describe("shouldMicrocompact", () => {
  it("returns false when microcompact is disabled or unconfigured", () => {
    expect(shouldMicrocompact(1_000_000, {})).toBe(false);
    expect(shouldMicrocompact(1_000_000, { microcompact: { enabled: false } })).toBe(false);
  });

  it("uses the default 80% threshold of a 200K window (=160K)", () => {
    const config = { microcompact: { enabled: true } };
    expect(shouldMicrocompact(159_999, config)).toBe(false);
    expect(shouldMicrocompact(160_000, config)).toBe(true);
    expect(shouldMicrocompact(200_000, config)).toBe(true);
  });

  it("honors a custom threshold_percent", () => {
    const config = { microcompact: { enabled: true, threshold_percent: 50 } };
    expect(shouldMicrocompact(99_999, config)).toBe(false);
    expect(shouldMicrocompact(100_000, config)).toBe(true);
  });
});

describe("buildMicrocompactBetas", () => {
  it("returns the fixed microcompact beta flag list", () => {
    expect(buildMicrocompactBetas()).toEqual(["clear_tool_uses_20250919", "clear_thinking_20251015"]);
  });
});
