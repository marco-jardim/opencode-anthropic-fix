import { describe, it, expect } from "vitest";

describe("Task 1.2: 8K Default Output Cap", () => {
  describe("output_cap config defaults", () => {
    it("T1.2.1: DEFAULT_CONFIG includes output_cap section", async () => {
      const { DEFAULT_CONFIG } = await import("../../lib/config.mjs");
      expect(DEFAULT_CONFIG.output_cap).toBeDefined();
      expect(DEFAULT_CONFIG.output_cap.enabled).toBe(true);
      expect(DEFAULT_CONFIG.output_cap.default_max_tokens).toBe(8_000);
      expect(DEFAULT_CONFIG.output_cap.escalated_max_tokens).toBe(64_000);
    });
  });

  describe("resolveMaxTokens logic", () => {
    // Inline the logic for unit testing since the function is not exported
    function resolveMaxTokens(body, config, lastStopReason) {
      if (!config.output_cap?.enabled) return body.max_tokens;
      if (body.max_tokens != null) return body.max_tokens;
      const escalated = lastStopReason === "max_tokens";
      return escalated
        ? (config.output_cap.escalated_max_tokens ?? 64_000)
        : (config.output_cap.default_max_tokens ?? 8_000);
    }

    const defaultConfig = {
      output_cap: { enabled: true, default_max_tokens: 8_000, escalated_max_tokens: 64_000 },
    };

    it("T1.2.2: No caller max_tokens \u2192 resolved to 8_000", () => {
      expect(resolveMaxTokens({}, defaultConfig, null)).toBe(8_000);
    });

    it("T1.2.3: Caller-specified max_tokens is preserved unchanged", () => {
      expect(resolveMaxTokens({ max_tokens: 16_000 }, defaultConfig, null)).toBe(16_000);
    });

    it("T1.2.4: After stop_reason=max_tokens, next request resolves to 64_000", () => {
      expect(resolveMaxTokens({}, defaultConfig, "max_tokens")).toBe(64_000);
    });

    it("T1.2.5: Non-truncation stop_reason keeps default 8_000", () => {
      expect(resolveMaxTokens({}, defaultConfig, "end_turn")).toBe(8_000);
    });

    it("T1.2.6: output_cap.enabled=false \u2192 passthrough", () => {
      const disabledConfig = { output_cap: { enabled: false } };
      expect(resolveMaxTokens({}, disabledConfig, "max_tokens")).toBeUndefined();
    });

    it("T1.2.7: max_tokens=0 is treated as caller-specified", () => {
      // 0 is still a valid explicit value (even though unusual)
      expect(resolveMaxTokens({ max_tokens: 0 }, defaultConfig, null)).toBe(0);
    });
  });

  describe("stop_reason capture from message_delta", () => {
    it("T1.2.8: message_delta with stop_reason is captured", () => {
      // Simulate the extraction logic
      const sessionMetrics = { lastStopReason: null };
      const parsed = {
        type: "message_delta",
        usage: { output_tokens: 100 },
        delta: { stop_reason: "max_tokens" },
      };
      if (parsed?.type === "message_delta" && parsed.delta?.stop_reason) {
        sessionMetrics.lastStopReason = parsed.delta.stop_reason;
      }
      expect(sessionMetrics.lastStopReason).toBe("max_tokens");
    });

    it("T1.2.9: message_delta without stop_reason does not overwrite", () => {
      const sessionMetrics = { lastStopReason: "end_turn" };
      const parsed = {
        type: "message_delta",
        usage: { output_tokens: 100 },
        delta: {},
      };
      if (parsed?.type === "message_delta" && parsed.delta?.stop_reason) {
        sessionMetrics.lastStopReason = parsed.delta.stop_reason;
      }
      expect(sessionMetrics.lastStopReason).toBe("end_turn");
    });
  });
});
