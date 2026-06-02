import { describe, it, expect } from "vitest";
import { AnthropicAuthPlugin } from "../index.mjs";

// __cacheInternals is attached as a property of the plugin function (not a bare
// named export) so Opencode's plugin loader — which requires every module export
// to be a function — still accepts the module. See index.mjs near __cacheInternals.
const { resolveCacheTtl, shouldPlaceToolBreakpoint, updateBoundaryStability } = AnthropicAuthPlugin.__cacheInternals;

describe("resolveCacheTtl — mirrors decompiled CC 2.1.154 REH()", () => {
  const base = { configuredTtl: "1h", roleScopedTtl: true, isMainForCache: true };

  it("main interactive role keeps configured 1h", () => {
    expect(resolveCacheTtl({ ...base, env: {} })).toBe("1h");
  });

  it("non-main (side-query) role downgrades to 5m when role-scoping on", () => {
    expect(resolveCacheTtl({ ...base, isMainForCache: false, env: {} })).toBe("5m");
  });

  it("non-main stays at configured TTL when role-scoping disabled", () => {
    expect(resolveCacheTtl({ ...base, isMainForCache: false, roleScopedTtl: false, env: {} })).toBe("1h");
  });

  it("FORCE_PROMPT_CACHING_5M wins over everything (even main role)", () => {
    expect(resolveCacheTtl({ ...base, env: { FORCE_PROMPT_CACHING_5M: "1" } })).toBe("5m");
  });

  it("ENABLE_PROMPT_CACHING_1H forces 1h even for non-main role", () => {
    expect(resolveCacheTtl({ ...base, isMainForCache: false, env: { ENABLE_PROMPT_CACHING_1H: "1" } })).toBe("1h");
  });

  it("FORCE_PROMPT_CACHING_5M takes precedence over ENABLE_PROMPT_CACHING_1H", () => {
    expect(
      resolveCacheTtl({
        ...base,
        env: { FORCE_PROMPT_CACHING_5M: "true", ENABLE_PROMPT_CACHING_1H: "true" },
      }),
    ).toBe("5m");
  });

  it("honors a custom configured TTL for the main role", () => {
    expect(resolveCacheTtl({ ...base, configuredTtl: "5m", env: {} })).toBe("5m");
  });
});

describe("resolveCacheTtl — subagent one-shot 5m downgrade (x-parent-session-id)", () => {
  const base = { configuredTtl: "1h", roleScopedTtl: true, isMainForCache: true };

  it("forces 5m for a subagent even when it classifies as main role", () => {
    // opencode subagents look like "main" (real messages + large max_tokens) but
    // carry x-parent-session-id → isSubagent true → cheap 5m write tier.
    expect(resolveCacheTtl({ ...base, isSubagent: true, env: {} })).toBe("5m");
  });

  it("keeps configured 1h for a non-subagent main request", () => {
    expect(resolveCacheTtl({ ...base, isSubagent: false, env: {} })).toBe("1h");
  });

  it("defaults isSubagent to false (omitted) → main keeps 1h", () => {
    expect(resolveCacheTtl({ ...base, env: {} })).toBe("1h");
  });

  it("respects the role-scoped master switch (no subagent downgrade when off)", () => {
    expect(resolveCacheTtl({ ...base, isSubagent: true, roleScopedTtl: false, env: {} })).toBe("1h");
  });

  it("ENABLE_PROMPT_CACHING_1H override beats the subagent 5m downgrade", () => {
    expect(resolveCacheTtl({ ...base, isSubagent: true, env: { ENABLE_PROMPT_CACHING_1H: "1" } })).toBe("1h");
  });

  it("FORCE_PROMPT_CACHING_5M still wins (consistent with non-subagent)", () => {
    expect(resolveCacheTtl({ ...base, isSubagent: true, env: { FORCE_PROMPT_CACHING_5M: "1" } })).toBe("5m");
  });
});

describe("getIncomingHeader — subagent marker extraction (all header shapes)", () => {
  const { getIncomingHeader } = AnthropicAuthPlugin.__testing__;
  const NAME = "x-parent-session-id";

  it("reads from a fetch init Headers object (case-insensitive)", () => {
    const init = { headers: new Headers({ "X-Parent-Session-Id": "ses_parent_1" }) };
    expect(getIncomingHeader(undefined, init, NAME)).toBe("ses_parent_1");
  });

  it("reads from an init.headers plain object", () => {
    const init = { headers: { "x-parent-session-id": "ses_parent_2" } };
    expect(getIncomingHeader(undefined, init, NAME)).toBe("ses_parent_2");
  });

  it("reads from an init.headers array of pairs (case-insensitive key)", () => {
    const init = { headers: [["X-PARENT-SESSION-ID", "ses_parent_3"]] };
    expect(getIncomingHeader(undefined, init, NAME)).toBe("ses_parent_3");
  });

  it("reads from a Request input's headers", () => {
    const req = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-parent-session-id": "ses_parent_4" },
    });
    expect(getIncomingHeader(req, {}, NAME)).toBe("ses_parent_4");
  });

  it("returns null when the header is absent (main-thread request)", () => {
    expect(getIncomingHeader(undefined, { headers: { "x-session-affinity": "ses_main" } }, NAME)).toBeNull();
    expect(getIncomingHeader(undefined, {}, NAME)).toBeNull();
    expect(getIncomingHeader(undefined, undefined, NAME)).toBeNull();
  });

  it("treats empty/whitespace header value as absent", () => {
    expect(getIncomingHeader(undefined, { headers: { "x-parent-session-id": "  " } }, NAME)).toBeNull();
  });
});

describe("shouldPlaceToolBreakpoint — adaptive anchor decision", () => {
  it("returns true (CC behavior) with no stability data", () => {
    expect(shouldPlaceToolBreakpoint(null)).toBe(true);
    expect(shouldPlaceToolBreakpoint(undefined)).toBe(true);
    expect(shouldPlaceToolBreakpoint(new Map())).toBe(true);
  });

  it("returns true when system prompt is not proven stable yet", () => {
    const stability = new Map([
      ["system_prompt", 1], // < STABLE_TURNS (2)
      ["tool:read", 0],
    ]);
    expect(shouldPlaceToolBreakpoint(stability)).toBe(true);
  });

  it("returns false (skip volatile tool breakpoint) when tools thrash AND system is stable", () => {
    const stability = new Map([
      ["system_prompt", 5],
      ["tool:read", 0], // changed this turn
      ["tool:write", 3],
    ]);
    expect(shouldPlaceToolBreakpoint(stability)).toBe(false);
  });

  it("returns true when system is stable but tools are ALSO stable (no thrash)", () => {
    const stability = new Map([
      ["system_prompt", 5],
      ["tool:read", 4],
      ["tool:write", 4],
    ]);
    expect(shouldPlaceToolBreakpoint(stability)).toBe(true);
  });
});

describe("updateBoundaryStability — per-boundary consecutive-unchanged counter", () => {
  it("increments counters for unchanged boundaries", () => {
    const prev = new Map([
      ["system_prompt", "h1"],
      ["tool:read", "h2"],
    ]);
    const cur = new Map([
      ["system_prompt", "h1"],
      ["tool:read", "h2"],
    ]);
    const stability = new Map([
      ["system_prompt", 1],
      ["tool:read", 1],
    ]);
    updateBoundaryStability(cur, prev, stability);
    expect(stability.get("system_prompt")).toBe(2);
    expect(stability.get("tool:read")).toBe(2);
  });

  it("resets a changed boundary to 0", () => {
    const prev = new Map([["system_prompt", "h1"]]);
    const cur = new Map([["system_prompt", "h2"]]); // changed
    const stability = new Map([["system_prompt", 5]]);
    updateBoundaryStability(cur, prev, stability);
    expect(stability.get("system_prompt")).toBe(0);
  });

  it("starts a newly-appeared boundary at 0", () => {
    const prev = new Map([["system_prompt", "h1"]]);
    const cur = new Map([
      ["system_prompt", "h1"],
      ["tool:new", "h9"],
    ]);
    const stability = new Map([["system_prompt", 2]]);
    updateBoundaryStability(cur, prev, stability);
    expect(stability.get("system_prompt")).toBe(3);
    expect(stability.get("tool:new")).toBe(0);
  });

  it("drops boundaries that no longer appear", () => {
    const prev = new Map([
      ["system_prompt", "h1"],
      ["tool:gone", "h2"],
    ]);
    const cur = new Map([["system_prompt", "h1"]]);
    const stability = new Map([
      ["system_prompt", 1],
      ["tool:gone", 4],
    ]);
    updateBoundaryStability(cur, prev, stability);
    expect(stability.get("system_prompt")).toBe(2);
    expect(stability.has("tool:gone")).toBe(false);
  });
});
