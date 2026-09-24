import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  applyOAuthCredentials,
  resetAccountTracking,
  adjustActiveIndexAfterRemoval,
  isTokenExpired,
  isTokenUsable,
  TOKEN_EXPIRY_SKEW_MS,
} from "./account-state.mjs";

describe("token expiry predicate", () => {
  it("T-5.1 skew boundary", () => {
    const expires = 1_000_000;
    expect(isTokenExpired(expires, 0, expires - 31_000)).toBe(false);
    expect(isTokenExpired(expires, 0, expires - 30_000)).toBe(true);
    expect(isTokenExpired(expires, 0, expires - 29_000)).toBe(true);
    expect(isTokenExpired(expires, 0, expires)).toBe(true);
    expect(isTokenExpired(expires, 0, expires + 1)).toBe(true);
  });

  it("T-5.1b leadMs is a floor", () => {
    const expires = 1_000_000;
    expect(isTokenExpired(expires, 10_000, expires - 20_000)).toBe(true);
    expect(isTokenExpired(expires, 300_000, expires - 200_000)).toBe(true);
    expect(isTokenExpired(expires, 300_000, expires - 400_000)).toBe(false);
    expect(isTokenExpired(expires, 0, expires - 31_000)).toBe(false);
  });

  it.each([undefined, null, NaN, Infinity, "123"])("T-5.1c unknown expiry %s is expired", (expires) => {
    expect(isTokenExpired(expires)).toBe(true);
  });

  it("T-5.1d isTokenUsable is the exact inverse", () => {
    const expires = 1_000_000;
    for (const now of [expires - 31_000, expires - 30_000, expires - 29_000, expires, expires + 1]) {
      expect(isTokenUsable(expires, 0, now)).toBe(!isTokenExpired(expires, 0, now));
    }
  });

  it("T-5.1e pins the attested skew in milliseconds", () => {
    expect(TOKEN_EXPIRY_SKEW_MS).toBe(30000);
  });

  it("T-5.2 one predicate only", () => {
    const libDirectory = new URL("./", import.meta.url);
    const sources = [
      new URL("../index.mjs", import.meta.url),
      new URL("../cli.mjs", import.meta.url),
      ...readdirSync(libDirectory)
        .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "account-state.mjs")
        .map((name) => new URL(name, libDirectory)),
    ];
    // Guard against a second expiry predicate in both operand orders.
    const rawExpiryComparison = /(?:\.expires|\.expiresAt|\bexpires\b)\s*(?:<|<=|>|>=)\s*(?:Date\.now\(\)|now\b)/;
    const reversedExpiryComparison = /(?:Date\.now\(\)|\bnow\b)\s*(?:<|<=|>|>=)\s*[A-Za-z_$][\w$.]*\.expires(?:At)?\b/;
    for (const source of sources) {
      const lines = readFileSync(source, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .split("\n")
        // Fresher-of-two compares expiries, not expiry against the clock.
        .filter((line) => !line.includes("cc.expiresAt > (existing.expires || 0)"))
        // Sorting orders expiries; it does not decide token usability.
        .filter((line) => !line.includes(".sort("));
      expect(
        lines.filter((line) => rawExpiryComparison.test(line) || reversedExpiryComparison.test(line)),
        source.pathname,
      ).toEqual([]);
    }
  });
});

describe("resetAccountTracking", () => {
  it("resets rate-limit and failure fields", () => {
    const account = {
      rateLimitResetTimes: { anthropic: Date.now() + 60_000 },
      consecutiveFailures: 7,
      lastFailureTime: Date.now(),
    };

    resetAccountTracking(account);

    expect(account.rateLimitResetTimes).toEqual({});
    expect(account.consecutiveFailures).toBe(0);
    expect(account.lastFailureTime).toBeNull();
  });
});

describe("applyOAuthCredentials", () => {
  it("applies refresh/access/expiry and optional email", () => {
    const account = {
      refreshToken: "old-refresh",
      access: "old-access",
      expires: 1,
      email: "old@example.com",
    };

    applyOAuthCredentials(account, {
      refresh: "new-refresh",
      access: "new-access",
      expires: 123,
      email: "new@example.com",
    });

    expect(account).toEqual({
      refreshToken: "new-refresh",
      access: "new-access",
      expires: 123,
      token_updated_at: expect.any(Number),
      email: "new@example.com",
    });
  });

  it("preserves existing email when credentials omit email", () => {
    const account = {
      refreshToken: "old-refresh",
      access: "old-access",
      expires: 1,
      email: "old@example.com",
    };

    applyOAuthCredentials(account, {
      refresh: "new-refresh",
      access: "new-access",
      expires: 456,
    });

    expect(account.email).toBe("old@example.com");
    expect(account.refreshToken).toBe("new-refresh");
    expect(account.access).toBe("new-access");
    expect(account.expires).toBe(456);
    expect(account.token_updated_at).toEqual(expect.any(Number));
  });
});

describe("adjustActiveIndexAfterRemoval", () => {
  it("resets activeIndex to 0 when no accounts remain", () => {
    const storage = { accounts: [], activeIndex: 3 };
    adjustActiveIndexAfterRemoval(storage, 0);
    expect(storage.activeIndex).toBe(0);
  });

  it("clamps activeIndex when it falls out of range", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }],
      activeIndex: 2,
    };
    adjustActiveIndexAfterRemoval(storage, 0);
    expect(storage.activeIndex).toBe(1);
  });

  it("decrements activeIndex when removed index is before active", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      activeIndex: 2,
    };
    adjustActiveIndexAfterRemoval(storage, 0);
    expect(storage.activeIndex).toBe(1);
  });

  it("keeps activeIndex when removed index is after active", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      activeIndex: 0,
    };
    adjustActiveIndexAfterRemoval(storage, 2);
    expect(storage.activeIndex).toBe(0);
  });

  it("keeps activeIndex when removed index was the active slot", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      activeIndex: 1,
    };
    adjustActiveIndexAfterRemoval(storage, 1);
    expect(storage.activeIndex).toBe(1);
  });
});
