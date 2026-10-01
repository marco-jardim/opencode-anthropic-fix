import { createAnthropicRuntime } from "./lib/host/runtime.mjs";

// Legacy hosts invoke every export as a factory and deduplicate by identity.
// Keep helper exports in lib/host; test helpers remain properties of this function.
let testRuntime = createAnthropicRuntime();

export async function AnthropicAuthPlugin(input) {
  const runtime = createAnthropicRuntime();
  testRuntime = runtime;
  const hooks = await runtime.initialize(input);
  return { ...hooks, dispose: () => runtime.dispose() };
}

Object.defineProperties(AnthropicAuthPlugin, {
  __testing__: { get: () => testRuntime.__testing__ },
  __cacheInternals: { get: () => testRuntime.__cacheInternals },
});

export default AnthropicAuthPlugin;
