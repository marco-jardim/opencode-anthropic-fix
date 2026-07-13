import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import * as tuning from "./tuning.mjs";

const indexSource = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");

const expectedValues = {
  SERVICE_WIDE_MAX_RETRIES: 2,
  CONSECUTIVE_529_FALLBACK_THRESHOLD: 3,
  SERVICE_RETRY_BASE_DELAY_SEC: 0.5,
  SERVICE_RETRY_BACKOFF_MULTIPLIER: 2,
  SERVICE_RETRY_MAX_DELAY_SEC: 3,
  SERVICE_RETRY_JITTER_FRACTION: 0.25,
  TOKEN_REFRESH_TIMEOUT_MS: 15000,
  FOREGROUND_REFRESH_EXPIRY_BUFFER_MS: 300000,
};

/**
 * @param {RegExp} pattern
 * @param {number} [group]
 * @returns {number}
 */
function extractNumber(pattern, group = 1) {
  const match = indexSource.match(pattern);
  expect(match, `Expected index.mjs to match ${pattern}`).not.toBeNull();
  return Number(match[group].replaceAll("_", ""));
}

describe("tuning constants", () => {
  it("exports every documented numeric value", () => {
    for (const [name, expected] of Object.entries(expectedValues)) {
      expect(tuning).toHaveProperty(name);
      expect(typeof tuning[name]).toBe("number");
      expect(tuning[name]).toBe(expected);
    }
  });

  it("matches the inline service retry budget and fallback threshold", () => {
    const maxServiceRetries = extractNumber(
      /const\s+maxServiceRetries\s*=\s*requestClass\s*===\s*"background"[\s\S]*?\?[^:;]+:\s*(\d+)\s*;/,
    );
    const fallbackThreshold = extractNumber(/consecutive529Count\s*>=\s*(\d+)/);

    expect(maxServiceRetries).toBe(tuning.SERVICE_WIDE_MAX_RETRIES);
    expect(fallbackThreshold).toBe(tuning.CONSECUTIVE_529_FALLBACK_THRESHOLD);
  });

  it("matches every component of the inline service retry delay", () => {
    const delayExpression = indexSource.match(
      /Math\.min\(\s*(\d+(?:\.\d+)?)\s*\*\s*Math\.pow\(\s*(\d+(?:\.\d+)?)\s*,\s*serviceWideRetryCount\s*\)\s*,\s*(\d+(?:\.\d+)?)\s*\)/,
    );
    expect(delayExpression, "Expected to find the service retry delay in index.mjs").not.toBeNull();

    const jitterFraction = extractNumber(/const\s+jitter\s*=\s*1\s*-\s*Math\.random\(\)\s*\*\s*(\d+(?:\.\d+)?)/);

    expect(Number(delayExpression[1])).toBe(tuning.SERVICE_RETRY_BASE_DELAY_SEC);
    expect(Number(delayExpression[2])).toBe(tuning.SERVICE_RETRY_BACKOFF_MULTIPLIER);
    expect(Number(delayExpression[3])).toBe(tuning.SERVICE_RETRY_MAX_DELAY_SEC);
    expect(jitterFraction).toBe(tuning.SERVICE_RETRY_JITTER_FRACTION);
  });

  it("matches the inline token refresh timeout and foreground expiry buffer", () => {
    const tokenRefreshTimeout = extractNumber(
      /refreshToken\(\s*account\.refreshToken\s*,\s*\{\s*signal:\s*AbortSignal\.timeout\(\s*(\d[\d_]*)\s*\)\s*\}\s*\)/,
    );
    const foregroundExpiryBuffer = extractNumber(/account\.expires\s*<\s*Date\.now\(\)\s*\+\s*(\d[\d_]*)/);

    expect(tokenRefreshTimeout).toBe(tuning.TOKEN_REFRESH_TIMEOUT_MS);
    expect(foregroundExpiryBuffer).toBe(tuning.FOREGROUND_REFRESH_EXPIRY_BUFFER_MS);
  });

  it("gives every exported constant an adjacent JSDoc @see tag", () => {
    const tuningSource = readFileSync(new URL("./tuning.mjs", import.meta.url), "utf8");
    const exports = [...tuningSource.matchAll(/export const\s+([A-Z0-9_]+)\s*=/g)];

    expect(exports.map((match) => match[1])).toEqual(Object.keys(expectedValues));
    for (const exported of exports) {
      const prefix = tuningSource.slice(0, exported.index);
      const adjacentJSDoc = prefix.slice(prefix.lastIndexOf("/**"));
      expect(adjacentJSDoc, `${exported[1]} must have an adjacent JSDoc @see tag`).toMatch(
        /^\/\*\*[\s\S]*?@see\s+\S[^\n]*[\s\S]*?\*\/\s*$/,
      );
    }
  });
});
