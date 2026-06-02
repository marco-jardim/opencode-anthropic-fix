import { describe, it, expect } from "vitest";

/**
 * Opencode's plugin loader (packages/opencode/src/plugin/index.ts) iterates
 * `Object.values(mod)` of the loaded plugin module and throws
 * "Plugin export is not a function" if ANY export is not a function. A single
 * non-function export (e.g. `export const __cacheInternals = {...}`) silently
 * disables the ENTIRE plugin at load time — no slash command, no OAuth provider,
 * no fetch interceptor — and the unit suite cannot catch it because `import`
 * happily tolerates extra named exports.
 *
 * This test reproduces the loader's contract directly. If it fails, the plugin
 * will not load in Opencode. Attach test-only internals as PROPERTIES of the
 * exported function (see `AnthropicAuthPlugin.__testing__` / `.__cacheInternals`
 * in index.mjs) instead of adding named exports.
 */
describe("Opencode plugin export contract", () => {
  it("every export of index.mjs is a function", async () => {
    const mod = await import("../index.mjs");
    const offenders = Object.entries(mod).filter(([, value]) => typeof value !== "function");
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it("exposes the AnthropicAuthPlugin factory and a default export", async () => {
    const mod = await import("../index.mjs");
    expect(typeof mod.AnthropicAuthPlugin).toBe("function");
    expect(typeof mod.default).toBe("function");
  });
});
