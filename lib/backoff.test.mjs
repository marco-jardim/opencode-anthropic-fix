import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseRateLimitReason,
  calculateBackoffMs,
  parseRetryAfterHeader,
  isRetryableStatus,
} from "./backoff.mjs";

// ---------------------------------------------------------------------------
// parseRateLimitReason
// ---------------------------------------------------------------------------

describe("parseRateLimitReason", () => {
  it("returns OVERLOADED for 529", () => {
    expect(parseRateLimitReason(529, null)).toBe("OVERLOADED");
  });

  it("returns OVERLOADED for 503", () => {
    expect(parseRateLimitReason(503, null)).toBe("OVERLOADED");
  });

  it("returns UNKNOWN for 500 (not retryable)", () => {
    expect(parseRateLimitReason(500, null)).toBe("UNKNOWN");
  });

  it("returns QUOTA_EXHAUSTED for 429 with quota in error type", () => {
    const body = JSON.stringify({
      error: { type: "quota_exceeded", message: "You have exceeded your quota" },
    });
    expect(parseRateLimitReason(429, body)).toBe("QUOTA_EXHAUSTED");
  });

  it("returns QUOTA_EXHAUSTED for 429 with exhausted in message", () => {
    const body = JSON.stringify({
      error: { type: "rate_error", message: "Token quota exhausted" },
    });
    expect(parseRateLimitReason(429, body)).toBe("QUOTA_EXHAUSTED");
  });

  it("returns RATE_LIMIT_EXCEEDED for 429 with rate limit message", () => {
    const body = JSON.stringify({
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    });
    expect(parseRateLimitReason(429, body)).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns RATE_LIMIT_EXCEEDED for 429 with too many requests", () => {
    const body = JSON.stringify({
      error: { message: "Too many requests" },
    });
    expect(parseRateLimitReason(429, body)).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns RATE_LIMIT_EXCEEDED for 429 with per minute message", () => {
    const body = JSON.stringify({
      error: { message: "Exceeded 60 requests per minute" },
    });
    expect(parseRateLimitReason(429, body)).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns OVERLOADED for 429 with overloaded message", () => {
    const body = JSON.stringify({
      error: { message: "Server is overloaded" },
    });
    expect(parseRateLimitReason(429, body)).toBe("OVERLOADED");
  });

  it("returns OVERLOADED for 429 with capacity message", () => {
    const body = JSON.stringify({
      error: { message: "At capacity" },
    });
    expect(parseRateLimitReason(429, body)).toBe("OVERLOADED");
  });

  it("defaults to RATE_LIMIT_EXCEEDED for 429 with no body", () => {
    expect(parseRateLimitReason(429, null)).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("defaults to RATE_LIMIT_EXCEEDED for 429 with unparseable body", () => {
    expect(parseRateLimitReason(429, "not json")).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns UNKNOWN for unrecognized status", () => {
    expect(parseRateLimitReason(418, null)).toBe("UNKNOWN");
  });

  it("handles body as object (not string)", () => {
    const body = { error: { type: "quota_exceeded", message: "quota" } };
    expect(parseRateLimitReason(429, body)).toBe("QUOTA_EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// calculateBackoffMs
// ---------------------------------------------------------------------------

describe("calculateBackoffMs", () => {
  it("uses Retry-After header when provided", () => {
    expect(calculateBackoffMs("RATE_LIMIT_EXCEEDED", 0, 5000)).toBe(5000);
  });

  it("enforces minimum backoff for Retry-After", () => {
    expect(calculateBackoffMs("RATE_LIMIT_EXCEEDED", 0, 500)).toBe(2000);
  });

  it("ignores null Retry-After", () => {
    const result = calculateBackoffMs("RATE_LIMIT_EXCEEDED", 0, null);
    expect(result).toBe(30_000);
  });

  it("ignores zero Retry-After", () => {
    const result = calculateBackoffMs("RATE_LIMIT_EXCEEDED", 0, 0);
    expect(result).toBe(30_000);
  });

  it("escalates QUOTA_EXHAUSTED backoffs", () => {
    expect(calculateBackoffMs("QUOTA_EXHAUSTED", 0)).toBe(60_000);
    expect(calculateBackoffMs("QUOTA_EXHAUSTED", 1)).toBe(300_000);
    expect(calculateBackoffMs("QUOTA_EXHAUSTED", 2)).toBe(1_800_000);
    expect(calculateBackoffMs("QUOTA_EXHAUSTED", 3)).toBe(7_200_000);
  });

  it("caps QUOTA_EXHAUSTED at max tier", () => {
    expect(calculateBackoffMs("QUOTA_EXHAUSTED", 100)).toBe(7_200_000);
  });

  it("returns fixed backoff for RATE_LIMIT_EXCEEDED", () => {
    expect(calculateBackoffMs("RATE_LIMIT_EXCEEDED", 0)).toBe(30_000);
    expect(calculateBackoffMs("RATE_LIMIT_EXCEEDED", 5)).toBe(30_000);
  });

  it("returns backoff with jitter for OVERLOADED", () => {
    const results = new Set();
    for (let i = 0; i < 20; i++) {
      results.add(calculateBackoffMs("OVERLOADED", 0));
    }
    // Should have some variation due to jitter
    // Base is 45_000, jitter range is [-15_000, +15_000], clamped to MIN_BACKOFF_MS
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(2_000); // MIN_BACKOFF_MS
      expect(r).toBeLessThanOrEqual(60_000);
    }
  });

  it("returns fixed backoff for UNKNOWN", () => {
    expect(calculateBackoffMs("UNKNOWN", 0)).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfterHeader
// ---------------------------------------------------------------------------

describe("parseRetryAfterHeader", () => {
  it("returns null when no header present", () => {
    const response = new Response(null, { headers: {} });
    expect(parseRetryAfterHeader(response)).toBeNull();
  });

  it("parses integer seconds", () => {
    const response = new Response(null, {
      headers: { "retry-after": "30" },
    });
    expect(parseRetryAfterHeader(response)).toBe(30_000);
  });

  it("parses HTTP-date format", () => {
    const futureDate = new Date(Date.now() + 60_000);
    const response = new Response(null, {
      headers: { "retry-after": futureDate.toUTCString() },
    });
    const result = parseRetryAfterHeader(response);
    expect(result).toBeGreaterThan(50_000);
    expect(result).toBeLessThanOrEqual(61_000);
  });

  it("returns null for past HTTP-date", () => {
    const pastDate = new Date(Date.now() - 60_000);
    const response = new Response(null, {
      headers: { "retry-after": pastDate.toUTCString() },
    });
    expect(parseRetryAfterHeader(response)).toBeNull();
  });

  it("returns null for invalid header value", () => {
    const response = new Response(null, {
      headers: { "retry-after": "not-a-number-or-date" },
    });
    expect(parseRetryAfterHeader(response)).toBeNull();
  });

  it("returns null for zero seconds", () => {
    const response = new Response(null, {
      headers: { "retry-after": "0" },
    });
    expect(parseRetryAfterHeader(response)).toBeNull();
  });

  it("returns null for negative seconds", () => {
    const response = new Response(null, {
      headers: { "retry-after": "-5" },
    });
    expect(parseRetryAfterHeader(response)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRetryableStatus
// ---------------------------------------------------------------------------

describe("isRetryableStatus", () => {
  it("returns true for 429", () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("returns true for 529", () => {
    expect(isRetryableStatus(529)).toBe(true);
  });

  it("returns true for 503", () => {
    expect(isRetryableStatus(503)).toBe(true);
  });

  it("returns false for 200", () => {
    expect(isRetryableStatus(200)).toBe(false);
  });

  it("returns false for 500", () => {
    expect(isRetryableStatus(500)).toBe(false);
  });

  it("returns false for 401", () => {
    expect(isRetryableStatus(401)).toBe(false);
  });

  it("returns false for 403", () => {
    expect(isRetryableStatus(403)).toBe(false);
  });
});
