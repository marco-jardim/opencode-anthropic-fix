import { describe, it, expect } from "vitest";
import {
  computeServiceRetrySleepMs,
  selectFallbackModel,
  shouldServiceRetry,
  isTransientRateLimit,
} from "./overload-loop.mjs";
import {
  SERVICE_RETRY_BASE_DELAY_SEC,
  SERVICE_RETRY_MAX_DELAY_SEC,
  SERVICE_RETRY_JITTER_FRACTION,
} from "../tuning.mjs";

describe("overload-loop: computeServiceRetrySleepMs", () => {
  const noJitter = () => 0; // jitter factor = 1 (no reduction)
  const maxJitter = () => 1; // jitter factor = 1 - jitterFraction

  it("applies capped exponential backoff with zero jitter", () => {
    expect(computeServiceRetrySleepMs(0, {}, noJitter)).toBe(500);
    expect(computeServiceRetrySleepMs(1, {}, noJitter)).toBe(1000);
    expect(computeServiceRetrySleepMs(2, {}, noJitter)).toBe(2000);
  });

  it("caps the base delay at the configured maximum", () => {
    // 0.5 * 2^3 = 4s, capped to SERVICE_RETRY_MAX_DELAY_SEC (3s) -> 3000ms
    expect(SERVICE_RETRY_MAX_DELAY_SEC).toBe(3);
    expect(computeServiceRetrySleepMs(3, {}, noJitter)).toBe(3000);
    expect(computeServiceRetrySleepMs(10, {}, noJitter)).toBe(3000);
  });

  it("applies maximum downward jitter", () => {
    // n=0: base 500ms * (1 - 0.25) = 375ms
    expect(SERVICE_RETRY_JITTER_FRACTION).toBe(0.25);
    expect(computeServiceRetrySleepMs(0, {}, maxJitter)).toBe(375);
  });

  it("honors option overrides", () => {
    const ms = computeServiceRetrySleepMs(
      1,
      { baseDelaySec: 1, backoffMultiplier: 3, maxDelaySec: 100, jitterFraction: 0 },
      maxJitter,
    );
    // 1 * 3^1 = 3s, jitter 1 - 1*0 = 1 -> 3000ms
    expect(ms).toBe(3000);
  });

  it("defaults to the tuning base delay for the first attempt", () => {
    expect(computeServiceRetrySleepMs(0, {}, noJitter)).toBe(SERVICE_RETRY_BASE_DELAY_SEC * 1000);
  });
});

describe("overload-loop: selectFallbackModel", () => {
  it("steps opus -> sonnet", () => {
    expect(selectFallbackModel("claude-opus-4-6")).toBe("claude-sonnet-4-6");
    expect(selectFallbackModel("claude-opus-4")).toBe("claude-sonnet-4");
  });

  it("steps sonnet -> haiku", () => {
    expect(selectFallbackModel("claude-sonnet-4-6")).toBe("claude-haiku-4-6");
    expect(selectFallbackModel("claude-sonnet-4-5")).toBe("claude-haiku-4-5");
  });

  it("returns null for haiku (bottom of the chain)", () => {
    expect(selectFallbackModel("claude-haiku-4-5")).toBeNull();
  });

  it("returns null for empty or unknown models", () => {
    expect(selectFallbackModel("")).toBeNull();
    expect(selectFallbackModel(null)).toBeNull();
    expect(selectFallbackModel(undefined)).toBeNull();
    expect(selectFallbackModel("gpt-4o")).toBeNull();
  });
});

describe("overload-loop: shouldServiceRetry", () => {
  it("retries 529/503 while under the budget", () => {
    expect(shouldServiceRetry(529, 0, 2)).toBe(true);
    expect(shouldServiceRetry(503, 1, 2)).toBe(true);
  });

  it("stops at the budget", () => {
    expect(shouldServiceRetry(529, 2, 2)).toBe(false);
  });

  it("ignores non-overload statuses", () => {
    expect(shouldServiceRetry(500, 0, 2)).toBe(false);
    expect(shouldServiceRetry(429, 0, 2)).toBe(false);
    expect(shouldServiceRetry(200, 0, 2)).toBe(false);
  });
});

describe("overload-loop: isTransientRateLimit", () => {
  const T = 10000;
  it("is true for a short-retry-after RATE_LIMIT_EXCEEDED 429", () => {
    expect(isTransientRateLimit(429, "RATE_LIMIT_EXCEEDED", 5000, T)).toBe(true);
    expect(isTransientRateLimit(429, "RATE_LIMIT_EXCEEDED", T, T)).toBe(true);
  });

  it("is false when any condition is not met", () => {
    expect(isTransientRateLimit(529, "RATE_LIMIT_EXCEEDED", 5000, T)).toBe(false);
    expect(isTransientRateLimit(429, "QUOTA_EXHAUSTED", 5000, T)).toBe(false);
    expect(isTransientRateLimit(429, "RATE_LIMIT_EXCEEDED", null, T)).toBe(false);
    expect(isTransientRateLimit(429, "RATE_LIMIT_EXCEEDED", undefined, T)).toBe(false);
    expect(isTransientRateLimit(429, "RATE_LIMIT_EXCEEDED", 0, T)).toBe(false);
    expect(isTransientRateLimit(429, "RATE_LIMIT_EXCEEDED", 15000, T)).toBe(false);
  });
});
