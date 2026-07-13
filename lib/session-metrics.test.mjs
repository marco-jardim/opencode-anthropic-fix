import { describe, it, expect } from "vitest";
import { createInitialSessionMetrics, sessionMetrics, getAverageCacheHitRate } from "./session-metrics.mjs";

describe("session-metrics", () => {
  describe("createInitialSessionMetrics", () => {
    it("returns a fresh object with the documented zeroed shape", () => {
      const m = createInitialSessionMetrics();
      expect(m.turns).toBe(0);
      expect(m.totalInput).toBe(0);
      expect(m.totalOutput).toBe(0);
      expect(m.totalCacheRead).toBe(0);
      expect(m.totalCacheWrite).toBe(0);
      expect(m.recentCacheRates).toEqual([]);
      expect(m.sessionCostUsd).toBe(0);
      expect(m.costBreakdown).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(m.lastStopReason).toBeNull();
      expect(m.perModel).toEqual({});
      expect(m.lastModelId).toBeNull();
      expect(m.lastRequestBody).toBeNull();
      expect(m.tokenBudget).toEqual({ limit: 0, used: 0, continuations: 0, outputHistory: [] });
      expect(m.usedTools).toBeInstanceOf(Set);
      expect(m.usedTools.size).toBe(0);
      expect(m.lastQuota.fiveHour).toEqual({
        utilization: 0,
        resets_at: null,
        status: null,
        surpassedThreshold: null,
      });
    });

    it("does not alias nested state between calls (fresh Set/objects/arrays)", () => {
      const a = createInitialSessionMetrics();
      const b = createInitialSessionMetrics();
      expect(a.usedTools).not.toBe(b.usedTools);
      expect(a.lastQuota).not.toBe(b.lastQuota);
      expect(a.tokenBudget).not.toBe(b.tokenBudget);
      expect(a.recentCacheRates).not.toBe(b.recentCacheRates);
      a.usedTools.add("Bash");
      expect(b.usedTools.size).toBe(0);
    });
  });

  describe("sessionMetrics singleton", () => {
    it("is a shared object reference whose mutations persist", () => {
      const before = sessionMetrics.turns;
      sessionMetrics.turns = before + 1;
      expect(sessionMetrics.turns).toBe(before + 1);
      sessionMetrics.turns = before; // restore
    });
  });

  describe("getAverageCacheHitRate", () => {
    it("returns 0 when there are no recent rates", () => {
      const saved = sessionMetrics.recentCacheRates;
      sessionMetrics.recentCacheRates = [];
      expect(getAverageCacheHitRate()).toBe(0);
      sessionMetrics.recentCacheRates = saved;
    });

    it("returns the arithmetic mean of the rolling window", () => {
      const saved = sessionMetrics.recentCacheRates;
      sessionMetrics.recentCacheRates = [0.2, 0.4, 0.6];
      expect(getAverageCacheHitRate()).toBeCloseTo(0.4, 10);
      sessionMetrics.recentCacheRates = saved;
    });
  });
});
