import { describe, expect, it } from "vitest";

import * as indexModule from "../../index.mjs";

/**
 * opencode's plugin loader treats every export of the plugin entry module
 * (`index.mjs`, per package.json `main`) as a plugin factory: it iterates
 * `Object.values(mod)` and calls each one with the plugin input object
 * (`{ client, ... }`). A non-function export throws "Plugin export is not a
 * function"; a function export that isn't actually a plugin factory (e.g. a
 * debug-dump helper expecting a `Response`) gets invoked anyway and throws
 * from inside its own body (this is exactly how the regression this test
 * guards against was discovered: `createDebugResponseHeadersEntry` was
 * exported alongside the plugin, opencode called it as a factory, and it
 * crashed on `undefined is not an object (evaluating 'response.status')`
 * because the plugin input has no `response` field) — either way, EVERY
 * export of this module must be safe to invoke as `factory(pluginInput)`,
 * and in practice that means `index.mjs` must export ONLY the plugin.
 *
 * Any helper `index.mjs` needs to share with other modules (debug-dump
 * helpers, model predicates, etc.) belongs in `lib/**`, imported by
 * `index.mjs` and by its other consumers alike — never re-exported here.
 *
 * If this test starts failing because you added a new export to `index.mjs`,
 * the fix is almost always to move that export to a `lib/*.mjs` module
 * instead, not to widen the expected set below.
 */
describe("plugin entry module export surface", () => {
  it("exports exactly AnthropicAuthPlugin (named + default) from index.mjs", () => {
    expect(new Set(Object.keys(indexModule))).toEqual(new Set(["AnthropicAuthPlugin", "default"]));
  });

  it("exports only functions, as the opencode plugin loader requires", () => {
    for (const [name, value] of Object.entries(indexModule)) {
      expect(typeof value, `export "${name}" must be a function`).toBe("function");
    }
  });

  it("exports the same function as both the named export and the default export", () => {
    expect(indexModule.default).toBe(indexModule.AnthropicAuthPlugin);
  });
});
