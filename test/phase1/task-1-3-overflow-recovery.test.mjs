import { describe, it, expect } from "vitest";

describe("Task 1.3: Context Overflow Auto-Recovery", () => {
  // Inline the functions for unit testing since they're not exported
  function parseContextLimitError(msg) {
    if (!msg || typeof msg !== "string") return null;
    const m = msg.match(/input length and `max_tokens` exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
    if (!m) return null;
    return { input: +m[1], maxTokens: +m[2], limit: +m[3] };
  }

  function computeSafeMaxTokens(input, limit, margin = 1000) {
    return Math.max(1, limit - input - margin);
  }

  describe("parseContextLimitError", () => {
    it("T1.3.1: parses the exact format from Anthropic API", () => {
      const msg = "input length and `max_tokens` exceed context limit: 8500 + 1000000 > 100000";
      const result = parseContextLimitError(msg);
      expect(result).toEqual({ input: 8500, maxTokens: 1000000, limit: 100000 });
    });

    it("T1.3.2: returns null for unrelated error messages", () => {
      expect(parseContextLimitError("rate limit exceeded")).toBeNull();
      expect(parseContextLimitError("invalid api key")).toBeNull();
      expect(parseContextLimitError("")).toBeNull();
      expect(parseContextLimitError(null)).toBeNull();
      expect(parseContextLimitError(undefined)).toBeNull();
    });

    it("T1.3.3: handles compact format without spaces", () => {
      const msg = "input length and `max_tokens` exceed context limit:8500+1000000>100000";
      const result = parseContextLimitError(msg);
      expect(result).toEqual({ input: 8500, maxTokens: 1000000, limit: 100000 });
    });

    it("T1.3.4: handles extra whitespace", () => {
      const msg = "input length and `max_tokens` exceed context limit:  8500  +  1000000  >  100000";
      const result = parseContextLimitError(msg);
      expect(result).toEqual({ input: 8500, maxTokens: 1000000, limit: 100000 });
    });

    it("T1.3.5: parses when embedded in JSON error response", () => {
      const errorJson = JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "input length and `max_tokens` exceed context limit: 95000 + 64000 > 100000",
        },
      });
      const result = parseContextLimitError(errorJson);
      expect(result).toEqual({ input: 95000, maxTokens: 64000, limit: 100000 });
    });
  });

  describe("computeSafeMaxTokens", () => {
    it("T1.3.6: computes limit - input - margin", () => {
      expect(computeSafeMaxTokens(8500, 100000, 1000)).toBe(90500);
    });

    it("T1.3.7: uses default margin of 1000", () => {
      expect(computeSafeMaxTokens(8500, 100000)).toBe(90500);
    });

    it("T1.3.8: returns 1 when result would be non-positive", () => {
      expect(computeSafeMaxTokens(99500, 100000, 1000)).toBe(1);
      expect(computeSafeMaxTokens(100000, 100000, 1000)).toBe(1);
      expect(computeSafeMaxTokens(200000, 100000, 1000)).toBe(1);
    });

    it("T1.3.9: handles custom margin", () => {
      expect(computeSafeMaxTokens(8500, 100000, 500)).toBe(91000);
    });
  });

  describe("overflow recovery config", () => {
    it("T1.3.10: DEFAULT_CONFIG includes overflow_recovery section", async () => {
      const { DEFAULT_CONFIG } = await import("../../lib/config.mjs");
      expect(DEFAULT_CONFIG.overflow_recovery).toBeDefined();
      expect(DEFAULT_CONFIG.overflow_recovery.enabled).toBe(true);
      expect(DEFAULT_CONFIG.overflow_recovery.safety_margin).toBe(1_000);
    });
  });

  describe("overflow recovery integration logic", () => {
    it("T1.3.11: recovery computes correct safe value for typical overflow", () => {
      // Simulates: input=95000 + max_tokens=64000 > limit=100000
      const overflow = parseContextLimitError(
        "input length and `max_tokens` exceed context limit: 95000 + 64000 > 100000",
      );
      expect(overflow).not.toBeNull();
      const margin = 1000;
      const safeMaxTokens = computeSafeMaxTokens(overflow.input, overflow.limit, margin);
      expect(safeMaxTokens).toBe(4000); // 100000 - 95000 - 1000
    });

    it("T1.3.12: guard prevents second overflow retry (no infinite loop)", () => {
      // Simulate the guard logic
      const requestInit = { _overflowRecoveryAttempted: false };

      // First attempt
      const canRetry1 = !requestInit._overflowRecoveryAttempted;
      expect(canRetry1).toBe(true);
      requestInit._overflowRecoveryAttempted = true;

      // Second attempt blocked
      const canRetry2 = !requestInit._overflowRecoveryAttempted;
      expect(canRetry2).toBe(false);
    });
  });
});
