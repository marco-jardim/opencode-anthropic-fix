/**
 * The modern hosts resolve ./server. Older v1 releases still load index.mjs.
 * Keep each implementation lazy so neither host initializes the other runtime.
 */
export default {
  id: "opencode-anthropic-fix",
  async server(context) {
    const { AnthropicAuthPlugin } = await import("./index.mjs");
    return AnthropicAuthPlugin(context);
  },
  async setup(context) {
    const { setupV2 } = await import("./lib/host/v2.mjs");
    return setupV2(context);
  },
};
