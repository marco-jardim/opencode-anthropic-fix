/**
 * COM-466 §12.3 — what the header transport actually guarantees.
 *
 * The shared package emits an ORDERED `readonly HeaderPair[]`, because the
 * genuine Claude Code client puts its headers on the wire in a specific
 * sequence and the package reproduces it. `buildWireCompatibleRequest`
 * (lib/mimicry/wire-compat.mjs:304) then converts that array with
 * `new Headers(built.headers)` before handing it to `fetch`.
 *
 * That conversion is lossy in exactly two ways, and both are load-bearing
 * facts that the file header of wire-compat.mjs claims but nothing tested:
 *
 *   - ORDER IS DISCARDED. `Headers` iteration is sorted by name per the Fetch
 *     spec, so the package's canonical sequence is not observable downstream.
 *     The plugin therefore does NOT promise wire order, and no test elsewhere
 *     may be read as promising it.
 *   - NAMES ARE CASE-NORMALIZED, and repeated names are MERGED into one
 *     comma-joined value.
 *
 * What IS guaranteed is set equivalence: name (lowercased) -> value, nothing
 * dropped, nothing invented. This file pins the guarantee and the two losses
 * separately, so a future change cannot quietly convert "we happen to be
 * ordered" into "we promise ordering".
 */

import { describe, expect, it } from "vitest";
import { buildClaudeCodeRequest } from "@tormentalabs/claude-code-wire-compat";
import { buildWireCompatibleRequest, toClaudeCodeRequestInput } from "../../lib/mimicry/wire-compat.mjs";

const HOST_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

const TRANSPORT = {
  accessToken: "test-access",
  clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  runtime: {
    sessionId: "11111111-1111-4111-8111-111111111111",
    deviceId: "2".repeat(64),
    accountUuid: "33333333-3333-4333-8333-333333333333",
    runtime: "node",
    runtimeVersion: process.version,
    os: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
    arch: process.arch,
  },
  cacheControl: { enabled: true, ttl: "1h", systemBreakpoint: true },
};

/**
 * The two sides of the conversion, derived mechanically from the same input
 * rather than hardcoded: `pairs` is what the package emits, `headers` is what
 * the plugin hands to `fetch`.
 */
async function bothSides() {
  const bare = await buildClaudeCodeRequest(toClaudeCodeRequestInput(HOST_BODY, TRANSPORT));
  const built = await buildWireCompatibleRequest(JSON.stringify(HOST_BODY), TRANSPORT);
  return { pairs: bare.headers, headers: built.headers };
}

describe("header transport — the shape on each side of the conversion", () => {
  it("takes an ordered pair array in and yields a Headers out", async () => {
    const { pairs, headers } = await bothSides();

    expect(Array.isArray(pairs)).toBe(true);
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(Array.isArray(pair)).toBe(true);
      expect(pair).toHaveLength(2);
      expect(typeof pair[0]).toBe("string");
      expect(typeof pair[1]).toBe("string");
    }

    expect(headers).toBeInstanceOf(Headers);
  });
});

describe("header transport — the SET is preserved (this is the guarantee)", () => {
  it("carries every pair across with no loss, no addition, no value drift", async () => {
    const { pairs, headers } = await bothSides();

    const expected = Object.fromEntries(pairs.map(([name, value]) => [name.toLowerCase(), value]));
    expect(Object.fromEntries(headers.entries())).toEqual(expected);
  });

  it("preserves the count, so a silent merge cannot hide a header", async () => {
    const { pairs, headers } = await bothSides();

    // Only holds while the pair list has no repeated name; the next test is
    // what pins that precondition.
    expect([...headers.keys()]).toHaveLength(pairs.length);
  });

  it("emits no repeated header name today, so the merge below never fires in production", async () => {
    const { pairs } = await bothSides();

    const names = pairs.map(([name]) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("lowercases names, so a lookup must not assume the package's casing", async () => {
    const { pairs, headers } = await bothSides();

    for (const [name, value] of pairs) {
      expect(headers.get(name)).toBe(value);
      expect(headers.get(name.toUpperCase())).toBe(value);
    }
    expect([...headers.keys()].every((name) => name === name.toLowerCase())).toBe(true);
  });
});

describe("header transport — ORDER IS NOT A GUARANTEE", () => {
  it("re-sorts a deliberately shuffled pair list instead of preserving it", async () => {
    const { pairs } = await bothSides();

    // Reverse the package's sequence. If `Headers` preserved order this would
    // come back reversed; per the Fetch spec it comes back sorted, which is
    // precisely why the plugin cannot promise wire order.
    const shuffled = [...pairs].reverse();
    const roundTripped = [...new Headers(shuffled).keys()];

    expect(roundTripped).not.toEqual(shuffled.map(([name]) => name.toLowerCase()));
    expect(roundTripped).toEqual([...roundTripped].sort());
    // The SET still survives the shuffle — order is the only casualty.
    expect(new Set(roundTripped)).toEqual(new Set(pairs.map(([name]) => name.toLowerCase())));
  });

  it("only looks order-preserving because the package's canonical order is already sorted", async () => {
    const { pairs, headers } = await bothSides();

    const packageOrder = pairs.map(([name]) => name.toLowerCase());
    // Pinned deliberately. The day the package adopts a canonical order that is
    // NOT alphabetical, this fails — and that failure is the warning that the
    // `Headers` conversion has started silently reordering the wire, which no
    // parity or golden test would catch, because both compare sets.
    expect(packageOrder).toEqual([...packageOrder].sort());
    expect([...headers.keys()]).toEqual(packageOrder);
  });
});

describe("header transport — repeated names merge rather than duplicate", () => {
  it("comma-joins a repeated name into a single entry", async () => {
    // Synthetic, because the package emits no repeated name today (pinned
    // above). This pins the semantics that WOULD apply if it ever did, so the
    // behaviour is a documented consequence rather than a surprise.
    const merged = new Headers([
      ["anthropic-beta", "alpha-2025-01-01"],
      ["anthropic-beta", "beta-2025-02-02"],
      ["anthropic-version", "2023-06-01"],
    ]);

    expect([...merged.keys()]).toEqual(["anthropic-beta", "anthropic-version"]);
    expect(merged.get("anthropic-beta")).toBe("alpha-2025-01-01, beta-2025-02-02");
    // The three pairs that went in are observable as two entries coming out:
    // count equivalence is conditional on uniqueness, set equivalence is not.
    expect([...merged.entries()]).toHaveLength(2);
  });
});
