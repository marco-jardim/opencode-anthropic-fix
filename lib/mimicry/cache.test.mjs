import { describe, expect, it } from "vitest";

import { resolveCacheTtl, shouldPlaceToolBreakpoint, updateBoundaryStability } from "./cache.mjs";

describe("resolveCacheTtl", () => {
  const base = {
    configuredTtl: "1h",
    roleScopedTtl: true,
    isMainForCache: true,
    env: {},
  };

  it("returns the configured TTL for the main role", () => {
    expect(resolveCacheTtl(base)).toBe("1h");
  });

  it("downgrades side-query and subagent roles when role scoping is enabled", () => {
    expect(resolveCacheTtl({ ...base, isMainForCache: false })).toBe("5m");
    expect(resolveCacheTtl({ ...base, isSubagent: true })).toBe("5m");
  });

  it("honors the 5m environment override first", () => {
    expect(
      resolveCacheTtl({
        ...base,
        env: { FORCE_PROMPT_CACHING_5M: "1", ENABLE_PROMPT_CACHING_1H: "1" },
      }),
    ).toBe("5m");
  });

  it("honors the 1h environment override before role scoping", () => {
    expect(
      resolveCacheTtl({
        ...base,
        isMainForCache: false,
        env: { ENABLE_PROMPT_CACHING_1H: "true" },
      }),
    ).toBe("1h");
  });

  it("keeps the configured TTL when role scoping is disabled", () => {
    expect(resolveCacheTtl({ ...base, configuredTtl: "5m", roleScopedTtl: false })).toBe("5m");
  });
});

describe("shouldPlaceToolBreakpoint", () => {
  it("places a breakpoint when stability data is unavailable", () => {
    expect(shouldPlaceToolBreakpoint(undefined)).toBe(true);
    expect(shouldPlaceToolBreakpoint(new Map())).toBe(true);
  });

  it("places a breakpoint below the stable-system boundary", () => {
    expect(
      shouldPlaceToolBreakpoint(
        new Map([
          ["system_prompt", 1],
          ["tool:read", 0],
        ]),
      ),
    ).toBe(true);
  });

  it("skips a volatile tool breakpoint once the system is stable", () => {
    expect(
      shouldPlaceToolBreakpoint(
        new Map([
          ["system_prompt", 2],
          ["tool:read", 0],
        ]),
      ),
    ).toBe(false);
  });

  it("places the breakpoint when both system and tools are stable", () => {
    expect(
      shouldPlaceToolBreakpoint(
        new Map([
          ["system_prompt", 2],
          ["tool:read", 1],
        ]),
      ),
    ).toBe(true);
  });
});

describe("updateBoundaryStability", () => {
  it("mutates only the passed stability map across boundary transitions", () => {
    const previous = new Map([
      ["system_prompt", "system-v1"],
      ["tool:read", "read-v1"],
      ["tool:gone", "gone-v1"],
    ]);
    const current = new Map([
      ["system_prompt", "system-v1"],
      ["tool:read", "read-v2"],
      ["tool:new", "new-v1"],
    ]);
    const stability = new Map([
      ["system_prompt", 1],
      ["tool:read", 4],
      ["tool:gone", 3],
    ]);

    expect(updateBoundaryStability(current, previous, stability)).toBeUndefined();

    expect([...stability]).toEqual([
      ["system_prompt", 2],
      ["tool:read", 0],
      ["tool:new", 0],
    ]);
  });
});
