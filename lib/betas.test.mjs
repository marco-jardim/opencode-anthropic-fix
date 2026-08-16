/**
 * Smoke tests for lib/betas.mjs — the host beta policy tables and resolver.
 * Moved verbatim from the retired lib/request-headers.test.mjs.
 */
import { describe, it, expect } from "vitest";
import { BETA_SHORTCUTS, EXPERIMENTAL_BETA_FLAGS, resolveBetaShortcut } from "./betas.mjs";

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
