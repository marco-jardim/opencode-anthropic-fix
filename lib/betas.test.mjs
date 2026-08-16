/**
 * Smoke tests for lib/betas.mjs — the host beta policy tables and resolver.
 * Moved verbatim from the retired lib/request-headers.test.mjs.
 */
import { describe, it, expect } from "vitest";
import { BETA_SHORTCUTS, EXPERIMENTAL_BETA_FLAGS, resolveBetaShortcut } from "./betas.mjs";
// Through the seam, never the package directly: `lib/mimicry/wire-compat.mjs`
// is the single import point for `@tormentalabs/claude-code-wire-compat` and
// `test/conformance/package-dependency-policy.test.mjs` enforces that.
import { BETA_REGISTRY_2_1_233 } from "./mimicry/wire-compat.mjs";

describe("BETA_SHORTCUTS", () => {
  it("is a Map", () => {
    expect(BETA_SHORTCUTS).toBeInstanceOf(Map);
  });

  it("has cache-diagnosis shortcut resolving to cache-diagnosis-2026-04-07", () => {
    expect(BETA_SHORTCUTS.get("cache-diagnosis")).toBe("cache-diagnosis-2026-04-07");
  });

  it("has a cache-diag alias for cache-diagnosis-2026-04-07", () => {
    expect(BETA_SHORTCUTS.get("cache-diag")).toBe("cache-diagnosis-2026-04-07");
  });

  it("has server-side-fallback / fallback aliases for server-side-fallback-2026-06-01", () => {
    expect(BETA_SHORTCUTS.get("server-side-fallback")).toBe("server-side-fallback-2026-06-01");
    expect(BETA_SHORTCUTS.get("fallback")).toBe("server-side-fallback-2026-06-01");
  });

  it("has a fallback-credit alias for fallback-credit-2026-06-01", () => {
    expect(BETA_SHORTCUTS.get("fallback-credit")).toBe("fallback-credit-2026-06-01");
  });
});

describe("EXPERIMENTAL_BETA_FLAGS", () => {
  it("is a Set", () => {
    expect(EXPERIMENTAL_BETA_FLAGS).toBeInstanceOf(Set);
  });

  it("includes the 2.1.195 refusal-fallback registry betas", () => {
    expect(EXPERIMENTAL_BETA_FLAGS.has("server-side-fallback-2026-06-01")).toBe(true);
    expect(EXPERIMENTAL_BETA_FLAGS.has("fallback-credit-2026-06-01")).toBe(true);
  });
});

describe("resolveBetaShortcut", () => {
  it("expands cache-diagnosis shortcut", () => {
    expect(resolveBetaShortcut("cache-diagnosis")).toBe("cache-diagnosis-2026-04-07");
  });

  it("expands cache-diag alias", () => {
    expect(resolveBetaShortcut("cache-diag")).toBe("cache-diagnosis-2026-04-07");
  });

  it("expands 1m shortcut", () => {
    expect(resolveBetaShortcut("1m")).toBe("context-1m-2025-08-07");
  });

  it("expands fast shortcut", () => {
    expect(resolveBetaShortcut("fast")).toBe("fast-mode-2026-02-01");
  });

  it("expands server-side-fallback / fallback shortcuts", () => {
    expect(resolveBetaShortcut("server-side-fallback")).toBe("server-side-fallback-2026-06-01");
    expect(resolveBetaShortcut("fallback")).toBe("server-side-fallback-2026-06-01");
  });

  it("expands fallback-credit shortcut", () => {
    expect(resolveBetaShortcut("fallback-credit")).toBe("fallback-credit-2026-06-01");
  });

  it("returns the input unchanged when no alias matches", () => {
    expect(resolveBetaShortcut("context-hint-2026-04-09")).toBe("context-hint-2026-04-09");
    expect(resolveBetaShortcut("no-such-beta")).toBe("no-such-beta");
  });

  it("returns empty string for falsy/empty input", () => {
    expect(resolveBetaShortcut(undefined)).toBe("");
    expect(resolveBetaShortcut("")).toBe("");
    expect(resolveBetaShortcut(null)).toBe("");
  });
});

/**
 * RECONCILIATION AGAINST THE GENUINE CLIENT'S REGISTRY.
 *
 * `lib/betas.mjs` names beta headers as literal strings, and a literal is
 * exactly the thing that rots when upstream bumps a beta's date. Before this
 * suite existed nothing noticed: the plugin would keep filtering, aliasing and
 * suppressing a header the real client had stopped sending, and the divergence
 * would only surface on the wire.
 *
 * These tests read the package's own 2.1.233 registry through the seam and
 * assert three things: known betas are BYTE-equal to upstream, betas upstream
 * does not have are an explicitly enumerated and justified list rather than an
 * accident, and every user-facing alias resolves to a real upstream header.
 */
const REGISTRY_HEADERS = new Set(Object.values(BETA_REGISTRY_2_1_233).map((entry) => entry.header));

/**
 * Strip the trailing `-YYYY-MM-DD` version stamp, leaving the beta's family
 * name. This is what makes a DATE BUMP distinguishable from a beta the host
 * invented: same family, different stamp.
 *
 * @param {string} header
 * @returns {string}
 */
const betaFamilyOf = (header) => header.replace(/-\d{4}-\d{2}-\d{2}$/, "");

/** family -> the header(s) upstream ships for it. */
const REGISTRY_FAMILIES = new Map();
for (const header of REGISTRY_HEADERS) {
  const family = betaFamilyOf(header);
  if (!REGISTRY_FAMILIES.has(family)) REGISTRY_FAMILIES.set(family, new Set());
  REGISTRY_FAMILIES.get(family).add(header);
}

/**
 * Betas the HOST tracks that the 2.1.233 registry has no entry for.
 *
 * Every member is deliberate, and the list is pinned rather than derived so
 * that a beta silently FALLING OUT of the registry — which is how an upstream
 * removal reaches us — fails here instead of passing unnoticed.
 *
 *  - `adaptive-thinking-2026-01-28` — the adaptive-thinking body shape is
 *    composed by the package from the model catalogue, not from a registry
 *    beta; the host keeps the header only so the disable-experimental guard can
 *    strip it if a caller supplies it by hand.
 *  - `code-execution-2025-08-25` — a first-party API beta the plugin never
 *    emits on `/v1/messages`; listed for the disable-experimental guard.
 *  - `compact-2026-01-12` — conversation-compaction beta, same story.
 *  - `summarize-connector-text-2026-03-13` — carried by the 2.1.195 registry as
 *    `NARRATION_SUMMARIES` and REMOVED by upstream in 2.1.222+. The package
 *    documents the removal explicitly at the slot it used to occupy. The host
 *    retains it for the disable-experimental guard and manual opt-in only; it
 *    is never auto-emitted, so retaining it costs no wire fidelity.
 *  - `user-profiles-2026-03-24` — SDK admin-route beta for `/v1/user_profiles*`,
 *    an endpoint the plugin does not proxy.
 */
const HOST_ONLY_EXPERIMENTAL_BETAS = [
  "adaptive-thinking-2026-01-28",
  "code-execution-2025-08-25",
  "compact-2026-01-12",
  "summarize-connector-text-2026-03-13",
  "user-profiles-2026-03-24",
];

describe("host beta tables reconciled with the wire package registry", () => {
  it("keeps every shared experimental beta byte-equal to the upstream header", () => {
    // A host flag whose FAMILY upstream ships but whose exact header upstream
    // does not is a date bump we failed to follow — the one failure this test
    // exists for. Reported as a pair so the fix is a copy-paste.
    const drifted = [...EXPERIMENTAL_BETA_FLAGS]
      .filter((header) => !REGISTRY_HEADERS.has(header) && REGISTRY_FAMILIES.has(betaFamilyOf(header)))
      .map((header) => ({ host: header, upstream: [...REGISTRY_FAMILIES.get(betaFamilyOf(header))] }));

    expect(drifted, "EXPERIMENTAL_BETA_FLAGS has stale date stamps against BETA_REGISTRY_2_1_233").toEqual([]);
  });

  it("enumerates the host-only experimental betas instead of accumulating them", () => {
    const hostOnly = [...EXPERIMENTAL_BETA_FLAGS].filter((header) => !REGISTRY_HEADERS.has(header)).sort();

    expect(hostOnly).toEqual([...HOST_ONLY_EXPERIMENTAL_BETAS].sort());
  });

  it("does not list a host-only beta that upstream actually ships", () => {
    // The inverse guard: once upstream adopts one of these, the justification
    // above is obsolete and the entry must move out of the pinned list.
    expect(HOST_ONLY_EXPERIMENTAL_BETAS.filter((header) => REGISTRY_HEADERS.has(header))).toEqual([]);
  });

  it("resolves every shortcut alias to a header upstream still ships, or to a justified host-only one", () => {
    const targets = [...new Set(BETA_SHORTCUTS.values())];
    const unknown = targets.filter(
      (header) => !REGISTRY_HEADERS.has(header) && !HOST_ONLY_EXPERIMENTAL_BETAS.includes(header),
    );

    expect(unknown, "BETA_SHORTCUTS points at headers that are in neither the registry nor the host-only list").toEqual(
      [],
    );
  });

  it("keeps every shortcut target byte-equal to the upstream header for its family", () => {
    const drifted = targetsWithFamilyDrift([...new Set(BETA_SHORTCUTS.values())]);

    expect(drifted, "BETA_SHORTCUTS has stale date stamps against BETA_REGISTRY_2_1_233").toEqual([]);
  });
});

/**
 * @param {readonly string[]} headers
 * @returns {{ host: string, upstream: string[] }[]}
 */
function targetsWithFamilyDrift(headers) {
  return headers
    .filter((header) => !REGISTRY_HEADERS.has(header) && REGISTRY_FAMILIES.has(betaFamilyOf(header)))
    .map((header) => ({ host: header, upstream: [...REGISTRY_FAMILIES.get(betaFamilyOf(header))] }));
}
