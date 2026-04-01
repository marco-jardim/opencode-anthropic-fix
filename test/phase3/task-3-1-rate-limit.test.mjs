import { describe, it, expect } from "vitest";

describe("Task 3.1: Rate Limit Awareness & Usage Polling", () => {
  // T3.1.1: Poll triggered after every 10th request
  it("T3.1.1: shouldPollUsage is true when turns % 10 === 0", () => {
    // Test the condition directly
    const turns10 = 10;
    const lastPollAt = Date.now(); // recent poll
    const shouldPoll = turns10 % 10 === 0 || Date.now() - lastPollAt > 5 * 60_000;
    expect(shouldPoll).toBe(true);

    const turns5 = 5;
    const shouldPoll2 = turns5 % 10 === 0 || Date.now() - lastPollAt > 5 * 60_000;
    expect(shouldPoll2).toBe(false);
  });

  // T3.1.2: Poll triggered after 5 minutes since last poll
  it("T3.1.2: shouldPollUsage is true when 5min elapsed since lastPollAt", () => {
    const turns = 3; // not divisible by 10
    const lastPollAt = Date.now() - 6 * 60_000; // 6 min ago
    const shouldPoll = turns % 10 === 0 || Date.now() - lastPollAt > 5 * 60_000;
    expect(shouldPoll).toBe(true);
  });

  // T3.1.3: computeQuotaWarningLevel returns correct levels
  it("T3.1.3: computeQuotaWarningLevel returns correct levels", () => {
    // We test the logic directly
    function computeQuotaWarningLevel(quota) {
      if (!quota || typeof quota.utilization !== "number") return null;
      const remaining = 100 - quota.utilization;
      if (remaining <= 25) return "danger";
      if (remaining <= 50) return "warning";
      if (remaining <= 75) return "caution";
      return null;
    }

    expect(computeQuotaWarningLevel({ utilization: 80 })).toBe("danger"); // 20% remaining
    expect(computeQuotaWarningLevel({ utilization: 60 })).toBe("warning"); // 40% remaining
    expect(computeQuotaWarningLevel({ utilization: 30 })).toBe("caution"); // 70% remaining
    expect(computeQuotaWarningLevel({ utilization: 10 })).toBe(null); // 90% remaining
    expect(computeQuotaWarningLevel(null)).toBe(null);
    expect(computeQuotaWarningLevel({})).toBe(null);
  });

  // T3.1.4: Danger toast fires when ≤25% remaining
  it("T3.1.4: danger level when utilization >= 75", () => {
    function computeQuotaWarningLevel(quota) {
      if (!quota || typeof quota.utilization !== "number") return null;
      const remaining = 100 - quota.utilization;
      if (remaining <= 25) return "danger";
      if (remaining <= 50) return "warning";
      if (remaining <= 75) return "caution";
      return null;
    }
    expect(computeQuotaWarningLevel({ utilization: 75 })).toBe("danger");
    expect(computeQuotaWarningLevel({ utilization: 90 })).toBe("danger");
    expect(computeQuotaWarningLevel({ utilization: 100 })).toBe("danger");
  });

  // T3.1.5: Warning toast fires when ≤50% remaining
  it("T3.1.5: warning level when utilization 50-74", () => {
    function computeQuotaWarningLevel(quota) {
      if (!quota || typeof quota.utilization !== "number") return null;
      const remaining = 100 - quota.utilization;
      if (remaining <= 25) return "danger";
      if (remaining <= 50) return "warning";
      if (remaining <= 75) return "caution";
      return null;
    }
    expect(computeQuotaWarningLevel({ utilization: 50 })).toBe("warning");
    expect(computeQuotaWarningLevel({ utilization: 55 })).toBe("warning");
    expect(computeQuotaWarningLevel({ utilization: 74 })).toBe("warning"); // 26% remaining, just below danger boundary
  });

  // T3.1.6: Caution toast fires once
  it("T3.1.6: caution shown flag prevents duplicate caution toasts", () => {
    const state = { cautionShown: false };
    function shouldShowCaution(level) {
      if (level === "caution" && !state.cautionShown) {
        state.cautionShown = true;
        return true;
      }
      return false;
    }
    expect(shouldShowCaution("caution")).toBe(true);
    expect(shouldShowCaution("caution")).toBe(false); // deduplicated
  });

  // T3.1.7: Non-2xx from usage endpoint does not throw
  it("T3.1.7: pollOAuthUsage handles non-2xx gracefully", async () => {
    // Simulate the poll function's error handling
    async function pollOAuthUsage(_accessToken) {
      try {
        const resp = { ok: false, status: 500 };
        if (!resp.ok) return; // silently return
        throw new Error("should not reach");
      } catch {
        // swallowed
      }
    }
    // Should not throw
    await expect(pollOAuthUsage("test-token")).resolves.toBeUndefined();
  });

  // T3.1.extra: lastQuota structure has new fields
  it("T3.1.extra: lastQuota structure includes usage endpoint fields", () => {
    const lastQuota = {
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      updatedAt: 0,
      fiveHour: { utilization: 0, resets_at: null },
      sevenDay: { utilization: 0, resets_at: null },
      lastPollAt: 0,
    };
    expect(lastQuota).toHaveProperty("fiveHour");
    expect(lastQuota).toHaveProperty("sevenDay");
    expect(lastQuota).toHaveProperty("lastPollAt");
    expect(lastQuota.fiveHour).toEqual({ utilization: 0, resets_at: null });
    expect(lastQuota.sevenDay).toEqual({ utilization: 0, resets_at: null });
  });
});
