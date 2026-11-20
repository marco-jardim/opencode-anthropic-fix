import { describe, expect, it } from "vitest";

import {
  CACHE_TTL_ENV_KEYS,
  isCacheCold,
  resolveCacheTtl,
  resolveMessagesCacheTtl,
  shouldPlaceToolBreakpoint,
  ttlToMs,
  updateBoundaryStability,
} from "./cache.mjs";

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

  describe("genuine env precedence", () => {
    const MAIN_VAR = "CLAUDE_CODE_PROMPT_CACHE_TTL";
    const SUBAGENT_VAR = "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL";

    it("lets the main-thread TTL variable override the configured and role-scoped values", () => {
      expect(resolveCacheTtl({ ...base, configuredTtl: "5m", env: { [MAIN_VAR]: "1h" } })).toBe("1h");
      expect(resolveCacheTtl({ ...base, env: { [MAIN_VAR]: "5m" } })).toBe("5m");
    });

    it("reads the subagent variable for subagents and side queries, not the main-thread one", () => {
      const env = { [MAIN_VAR]: "5m", [SUBAGENT_VAR]: "1h" };
      expect(resolveCacheTtl({ ...base, isSubagent: true, env })).toBe("1h");
      expect(resolveCacheTtl({ ...base, isMainForCache: false, env })).toBe("1h");
      expect(resolveCacheTtl({ ...base, env })).toBe("5m");
    });

    it("ignores the main-thread variable on a subagent and the subagent variable on the main thread", () => {
      expect(resolveCacheTtl({ ...base, isSubagent: true, env: { [MAIN_VAR]: "1h" } })).toBe("5m");
      expect(resolveCacheTtl({ ...base, configuredTtl: "5m", env: { [SUBAGENT_VAR]: "1h" } })).toBe("5m");
    });

    it("ignores any value other than 5m or 1h", () => {
      for (const value of ["10m", "1H", "true", "", "0", "24h"]) {
        const env = { [MAIN_VAR]: value };
        expect(resolveCacheTtl({ ...base, env })).toBe("1h");
        expect(resolveCacheTtl({ ...base, configuredTtl: "5m", env })).toBe("5m");
      }
    });

    it("lets FORCE_PROMPT_CACHING_5M beat the explicit variable, which beats ENABLE_PROMPT_CACHING_1H", () => {
      const forced = { FORCE_PROMPT_CACHING_5M: "1", [MAIN_VAR]: "1h" };
      const explicit = { ENABLE_PROMPT_CACHING_1H: "1", [MAIN_VAR]: "5m" };
      expect(resolveCacheTtl({ ...base, env: forced })).toBe("5m");
      expect(resolveCacheTtl({ ...base, env: explicit })).toBe("5m");
    });
  });
});

describe("resolveMessagesCacheTtl", () => {
  it("drops only the messages TTL to 5m, and only for the exact value 5m", () => {
    expect(resolveMessagesCacheTtl("1h", { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: "5m" })).toBe("5m");
    expect(resolveMessagesCacheTtl("1h", { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: "1h" })).toBe("1h");
    expect(resolveMessagesCacheTtl("1h", { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: " 5m" })).toBe("1h");
    expect(resolveMessagesCacheTtl("1h", {})).toBe("1h");
  });

  it("never raises the TTL: a 5m system stays 5m, so a 1h marker never follows a 5m one", () => {
    expect(resolveMessagesCacheTtl("5m", { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: "1h" })).toBe("5m");
    expect(resolveMessagesCacheTtl("5m", {})).toBe("5m");
  });
});

describe("CACHE_TTL_ENV_KEYS and ttlToMs", () => {
  it("lists every variable the TTL resolution reads", () => {
    const expected = [
      "CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL",
      "CLAUDE_CODE_PROMPT_CACHE_TTL",
      "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
      "ENABLE_PROMPT_CACHING_1H",
      "FORCE_PROMPT_CACHING_5M",
    ];
    expect([...CACHE_TTL_ENV_KEYS].sort()).toEqual(expected);
  });

  it("converts the two known TTLs and rejects the rest", () => {
    expect(ttlToMs("5m")).toBe(300_000);
    expect(ttlToMs("1h")).toBe(3_600_000);
    expect(ttlToMs("off")).toBeNull();
    expect(ttlToMs(undefined)).toBeNull();
    expect(ttlToMs("toString")).toBeNull();
  });
});

describe("isCacheCold", () => {
  const now = 10_000_000;

  it("is cold only once the last request is older than the TTL", () => {
    expect(isCacheCold({ lastRequestMs: now - 3_600_000, now, ttl: "1h" })).toBe(false);
    expect(isCacheCold({ lastRequestMs: now - 3_600_001, now, ttl: "1h" })).toBe(true);
    expect(isCacheCold({ lastRequestMs: now - 400_000, now, ttl: "5m" })).toBe(true);
    expect(isCacheCold({ lastRequestMs: now - 400_000, now, ttl: "1h" })).toBe(false);
  });

  it("is cold when no request was ever made, and never cold for an unknown TTL", () => {
    expect(isCacheCold({ lastRequestMs: undefined, now, ttl: "1h" })).toBe(true);
    expect(isCacheCold({ lastRequestMs: 0, now, ttl: "5m" })).toBe(true);
    expect(isCacheCold({ lastRequestMs: now - 99_999_999, now, ttl: "off" })).toBe(false);
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
