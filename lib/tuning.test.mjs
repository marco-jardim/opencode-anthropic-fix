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

  it("wires the service retry budget and fallback threshold to tuning constants", () => {
    // Wave 3 P3.2 replaced the inline literals with imported constant references.
    expect(indexSource).toMatch(
      /const\s+maxServiceRetries\s*=\s*requestClass\s*===\s*"background"[\s\S]*?:\s*SERVICE_WIDE_MAX_RETRIES\s*;/,
    );
    expect(indexSource).toMatch(/consecutive529Count\s*>=\s*CONSECUTIVE_529_FALLBACK_THRESHOLD/);
    expect(indexSource).toMatch(
      /import\s*\{[^}]*\bSERVICE_WIDE_MAX_RETRIES\b[^}]*\bCONSECUTIVE_529_FALLBACK_THRESHOLD\b[^}]*\}\s*from\s*"\.\/lib\/tuning\.mjs"/,
    );
  });

  it("consumes the service retry delay constants in the overload-loop helper", () => {
    // The Math.min/jitter delay formula moved out of index.mjs into this helper (P3.2).
    const overloadSource = readFileSync(new URL("./retry/overload-loop.mjs", import.meta.url), "utf8");
    for (const name of [
      "SERVICE_RETRY_BASE_DELAY_SEC",
      "SERVICE_RETRY_BACKOFF_MULTIPLIER",
      "SERVICE_RETRY_MAX_DELAY_SEC",
      "SERVICE_RETRY_JITTER_FRACTION",
    ]) {
      expect(overloadSource, `overload-loop.mjs must consume ${name}`).toContain(name);
    }
    expect(overloadSource).toMatch(/from\s*"\.\.\/tuning\.mjs"/);
    // The inline delay formula must no longer live in index.mjs.
    expect(indexSource).not.toMatch(/1\s*-\s*Math\.random\(\)\s*\*\s*0\.25/);
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
