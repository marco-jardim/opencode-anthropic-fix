import { describe, it, expect } from "vitest";
import { storeDeadLetterAlert, getDeadLetterAlert, estimateCost } from "../src/observability.mjs";
import { STATES } from "../src/types.mjs";

function makeKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const DEAD_RECORD = {
  state: STATES.DEAD_LETTER,
  version: "2.1.92",
  retries: 6,
  error: "GitHub 500 after 6 attempts",
  updatedAt: "2026-04-03T10:00:00Z",
  lastEvent: "FAILED_RETRYABLE → DEAD_LETTER",
  createdAt: "2026-04-03T09:00:00Z",
  prNumber: null,
  issueNumber: null,
  branchName: null,
};

describe("storeDeadLetterAlert / getDeadLetterAlert", () => {
  it("stores and retrieves a DEAD_LETTER alert", async () => {
    const kv = makeKV();
    await storeDeadLetterAlert(kv, "2.1.92", DEAD_RECORD);
    const alert = await getDeadLetterAlert(kv, "2.1.92");
    expect(alert).not.toBeNull();
    expect(alert.version).toBe("2.1.92");
    expect(alert.retries).toBe(6);
    expect(alert.error).toContain("GitHub 500");
    expect(alert.alertedAt).toBeTruthy();
  });

  it("returns null when no alert exists", async () => {
    const kv = makeKV();
    expect(await getDeadLetterAlert(kv, "9.9.9")).toBeNull();
  });

  it("overwrites previous alert for the same version", async () => {
    const kv = makeKV();
    await storeDeadLetterAlert(kv, "2.1.92", DEAD_RECORD);
    const updated = { ...DEAD_RECORD, error: "New error" };
    await storeDeadLetterAlert(kv, "2.1.92", updated);
    const alert = await getDeadLetterAlert(kv, "2.1.92");
    expect(alert.error).toBe("New error");
  });
});

describe("estimateCost", () => {
  it("calculates cost for 50K input + 2K output tokens", () => {
    const cost = estimateCost({ input: 50_000, output: 2_000 });
    // $0.60/M * 50K = $0.030
    // $3.00/M * 2K  = $0.006
    // Total         = $0.036
    expect(cost).toBeCloseTo(0.036, 4);
  });

  it("calculates zero cost for zero tokens", () => {
    expect(estimateCost({ input: 0, output: 0 })).toBe(0);
  });

  it("pure output cost: 1M output tokens = $3.00", () => {
    const cost = estimateCost({ input: 0, output: 1_000_000 });
    expect(cost).toBeCloseTo(3.0, 4);
  });

  it("pure input cost: 1M input tokens = $0.60", () => {
    const cost = estimateCost({ input: 1_000_000, output: 0 });
    expect(cost).toBeCloseTo(0.6, 4);
  });
});
