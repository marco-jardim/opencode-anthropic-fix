import { describe, it, expect } from "vitest";
import { parseRateLimitReason, calculateBackoffMs, parseRetryAfterHeader, isAccountSpecificError } from "./backoff.mjs";

// ---------------------------------------------------------------------------
// isAccountSpecificError
// ---------------------------------------------------------------------------

describe("isAccountSpecificError", () => {
  it("returns true for 429 (always account-specific)", () => {
    expect(isAccountSpecificError(429, null)).toBe(true);
  });

  it("returns true for 429 even without body", () => {
    expect(isAccountSpecificError(429)).toBe(true);
  });

  it("returns true for 401 (always account-specific)", () => {
    expect(isAccountSpecificError(401, null)).toBe(true);
  });

  it("returns true for 400 with rate limit language in body", () => {
    expect(isAccountSpecificError(400, "This request would exceed your account's rate limit")).toBe(true);
  });

  it("returns true for 400 with quota language in body", () => {
    expect(isAccountSpecificError(400, "Your quota has been exhausted")).toBe(true);
  });

  it("returns true for 400 with credit balance language in body", () => {
    expect(isAccountSpecificError(400, "Your credit balance is too low to complete this request")).toBe(true);
  });

  it("returns true for 400 with billing language in body", () => {
    expect(isAccountSpecificError(400, "Billing issue on your account")).toBe(true);
  });

  it("returns true for 403 with permission language in body", () => {
    expect(isAccountSpecificError(403, "You do not have permission to access this model")).toBe(true);
  });

  it("returns true for 403 permission_error type in JSON body", () => {
    expect(
      isAccountSpecificError(403, JSON.stringify({ error: { type: "permission_error", message: "Forbidden" } })),
    ).toBe(true);
  });

  it("returns true for 403 authentication_error type in JSON body", () => {
    expect(
      isAccountSpecificError(403, JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } })),
    ).toBe(true);
  });

  it("returns true for object body with account-specific error type", () => {
    expect(
      isAccountSpecificError(400, {
        error: { type: "rate_limit_error", message: "too many requests" },
      }),
    ).toBe(true);
  });

  it("returns false for 400 without account-specific language", () => {
    expect(isAccountSpecificError(400, "Invalid request body")).toBe(false);
  });

  it("returns false for 400 with no body", () => {
    expect(isAccountSpecificError(400, null)).toBe(false);
  });

  it("returns false for 403 with no body", () => {
    expect(isAccountSpecificError(403, null)).toBe(false);
  });

  it("returns false for 500 (service-wide)", () => {
    expect(isAccountSpecificError(500, null)).toBe(false);
  });

  it("returns false for 503 (service-wide)", () => {
    expect(isAccountSpecificError(503, null)).toBe(false);
  });

  it("returns false for 529 (service-wide)", () => {
    expect(isAccountSpecificError(529, null)).toBe(false);
  });

  it("returns false for 200", () => {
    expect(isAccountSpecificError(200, null)).toBe(false);
  });

  it("is case-insensitive for body matching", () => {
    expect(isAccountSpecificError(400, "RATE LIMIT exceeded")).toBe(true);
    expect(isAccountSpecificError(400, "QUOTA Exhausted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseRateLimitReason
// ---------------------------------------------------------------------------

describe("parseRateLimitReason", () => {
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

  it("returns QUOTA_EXHAUSTED for credit balance message", () => {
    const body = JSON.stringify({
      error: { message: "Your credit balance is too low" },
    });
    expect(parseRateLimitReason(429, body)).toBe("QUOTA_EXHAUSTED");
  });

  it("returns QUOTA_EXHAUSTED for billing message", () => {
    const body = JSON.stringify({
      error: { message: "Billing issue on account" },
    });
    expect(parseRateLimitReason(429, body)).toBe("QUOTA_EXHAUSTED");
  });

  it("returns AUTH_FAILED for 401 status", () => {
    expect(parseRateLimitReason(401, null)).toBe("AUTH_FAILED");
  });

  it("returns QUOTA_EXHAUSTED for permission_error type", () => {
    const body = JSON.stringify({
      error: { type: "permission_error", message: "Forbidden" },
    });
    expect(parseRateLimitReason(403, body)).toBe("QUOTA_EXHAUSTED");
  });

  it("returns AUTH_FAILED for authentication_error type", () => {
    const body = JSON.stringify({
      error: { type: "authentication_error", message: "Unauthorized" },
    });
    expect(parseRateLimitReason(403, body)).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED for invalid_api_key message", () => {
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: "Invalid API key" },
    });
    expect(parseRateLimitReason(400, body)).toBe("AUTH_FAILED");
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

  it("defaults to RATE_LIMIT_EXCEEDED for 429 with no body", () => {
    expect(parseRateLimitReason(429, null)).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("defaults to RATE_LIMIT_EXCEEDED for 429 with unparseable body", () => {
    expect(parseRateLimitReason(429, "not json")).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("defaults to RATE_LIMIT_EXCEEDED for unrecognized status", () => {
    expect(parseRateLimitReason(418, null)).toBe("RATE_LIMIT_EXCEEDED");
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

  it("returns short fixed backoff for AUTH_FAILED", () => {
    expect(calculateBackoffMs("AUTH_FAILED", 0)).toBe(5_000);
    expect(calculateBackoffMs("AUTH_FAILED", 5)).toBe(5_000);
  });

  it("uses default (RATE_LIMIT_EXCEEDED) for unknown reason", () => {
    expect(calculateBackoffMs("SOMETHING_ELSE", 0)).toBe(30_000);
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
