import { describe, expect, it, vi } from "vitest";
import { setupV2, OAUTH_METHOD_ID, V2_MODEL_PACKAGE } from "./v2.mjs";
import { DEFAULT_CONFIG } from "../config.mjs";

function harness() {
  const state = {
    auth: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 9999999999999 },
    connection: undefined,
    credential: undefined,
    config: structuredClone(DEFAULT_CONFIG),
  };
  const callbacks = {};
  const resources = [];
  const register = (name) =>
    vi.fn(async (callback) => {
      callbacks[name] = callback;
      const resource = { dispose: vi.fn(async () => {}) };
      resources.push(resource);
      return resource;
    });
  let bridge;
  const executor = { fetch: vi.fn(async () => new Response("ok")) };
  const runtime = {
    initialize: vi.fn(async ({ client }) => {
      bridge = client;
      return {
        auth: {
          loader: vi.fn(async (getAuth) => {
            await getAuth();
            return executor;
          }),
        },
        "experimental.chat.system.transform": vi.fn((_input, output) => {
          output.system.unshift("identity");
        }),
        "experimental.session.compacting": vi.fn(async (_input, output) => {
          output.context.push("pool state");
        }),
      };
    }),
    getCurrentAuth: vi.fn(async () => state.auth),
    reloadConfig: vi.fn(),
    getConfig: () => state.config,
    dispose: vi.fn(async () => {}),
    executeCommand: vi.fn(async (input) => {
      await bridge.session.prompt({ body: { parts: [{ type: "text", text: `Executed ${input.arguments}` }] } });
    }),
    authorizeOAuth: vi.fn(async () => ({
      url: "https://example.test/oauth",
      instructions: "Paste code",
      callback: async () => ({ ...state.auth, type: "success" }),
    })),
  };
  const context = {
    app: { version: "2.0.22" },
    integration: {
      transform: register("integration"),
      connection: { active: vi.fn(async () => state.connection), resolve: vi.fn(async () => state.credential) },
    },
    provider: { transform: register("provider"), reload: vi.fn(async () => {}) },
    model: { transform: register("model") },
    command: { transform: register("command") },
    session: {
      hook: vi.fn(async (name, callback) => register(name)(callback)),
      get: vi.fn(async ({ sessionID }) => ({ id: sessionID })),
    },
    rpc: { register: vi.fn(async (_definition, handlers) => register("rpc")(handlers)) },
  };
  const transport = { fetch: vi.fn(), dispose: vi.fn(async () => {}) };
  let transportOptions;
  const dependencies = {
    createRuntime: vi.fn(() => runtime),
    setupTransport: vi.fn(async (_context, options) => {
      transportOptions = options;
      return transport;
    }),
  };
  function provider() {
    const value = { settings: { compaction: { type: "native" }, custom: true } };
    callbacks.provider({ get: () => value, update: (_id, update) => update(value) });
    return value;
  }
  function model() {
    const value = {
      providerID: "anthropic",
      id: "claude-sonnet-4-6",
      settings: { compaction: { type: "native" } },
      limit: { context: 200000, output: 64000 },
      variants: [{ id: "high", settings: { compaction: { type: "native" }, effort: "high" } }],
      cost: [
        { input: 3, output: 15, cache: { read: 0.3, write: 3.75 }, context: 200000 },
        { input: 6, output: 30 },
      ],
    };
    callbacks.model({ list: () => [value], update: (_providerID, _id, update) => update(value) });
    return value;
  }
  const event = () => ({
    sessionID: "s1",
    model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
    system: [{ type: "text", text: "host" }],
    messages: [],
  });
  return {
    state,
    callbacks,
    context,
    runtime,
    dependencies,
    resources,
    transport,
    executor,
    provider,
    model,
    event,
    options: () => transportOptions,
  };
}

describe("OpenCode v2 adapter", () => {
  it("uses the schema-compatible disabled chunk timeout on 2.0.21", async () => {
    const h = harness();
    h.context.app.version = "2.0.21";
    const dispose = await setupV2(h.context, h.dependencies);
    try {
      expect(h.provider().settings).toMatchObject({ timeout: false, headerTimeout: false, chunkTimeout: 0 });
    } finally {
      await dispose();
    }
  });

  it("disables host header, chunk and total timers so executor retries can exceed 300 seconds", async () => {
    const h = harness();
    const dispose = await setupV2(h.context, h.dependencies);
    try {
      // provider.ts@v2.0.22:156-165 applies 300_000 to unset header/chunk
      // settings. model-resolver.ts:373 strips model/variant timeout overrides,
      // so these must be provider settings, not model settings.
      const settings = h.provider().settings;
      const timeouts = {
        timeout: settings.timeout,
        headerTimeout: settings.headerTimeout ?? 300_000,
        chunkTimeout: settings.chunkTimeout ?? 300_000,
      };
      expect(timeouts).toEqual({ timeout: false, headerTimeout: false, chunkTimeout: false });
    } finally {
      await dispose();
    }
  });

  it("registers a managed provider and all cost tiers while retaining unrelated settings", async () => {
    const h = harness();
    const dispose = await setupV2(h.context, h.dependencies);
    expect(h.dependencies.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ interactiveOAuth: false, hostCompatShim: true }),
    );
    expect(h.provider()).toMatchObject({
      activation: "enabled",
      package: V2_MODEL_PACKAGE,
      settings: { custom: true, compaction: { type: "summary" } },
    });
    const model = h.model();
    expect(model.cost).toEqual([
      { input: 0, output: 0, cache: { read: 0, write: 0 }, context: 200000 },
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ]);
    expect(model.settings.compaction).toEqual({ type: "summary" });
    expect(model.variants[0].settings).toEqual({ effort: "high", compaction: { type: "summary" } });
    expect(h.provider().settings).not.toHaveProperty("fetch");
    expect(model.settings).not.toHaveProperty("fetch");
    await dispose();
  });

  it.each([{ type: "env" }, { type: "credential", method: "key" }, { type: "credential", method: "oauth" }])(
    "leaves foreign connections native: %j",
    async (connection) => {
      const h = harness();
      h.state.connection = connection;
      h.state.credential = { methodID: "another-plugin" };
      const dispose = await setupV2(h.context, h.dependencies);
      expect(h.provider().package).toBeUndefined();
      expect(h.model().cost[0].input).toBe(3);
      await dispose();
    },
  );

  it("accepts its own OAuth method and updates state only when the selected connection changes", async () => {
    const h = harness();
    h.state.connection = { type: "credential", method: "oauth" };
    h.state.credential = { methodID: OAUTH_METHOD_ID };
    const dispose = await setupV2(h.context, h.dependencies);
    await h.callbacks.context(h.event());
    await h.callbacks.title(h.event());
    expect(h.context.provider.reload).toHaveBeenCalledTimes(1);
    h.state.connection = { type: "env" };
    await h.callbacks.context(h.event());
    expect(h.context.provider.reload).toHaveBeenCalledTimes(2);
    expect(h.provider().package).toBeUndefined();
    await dispose();
  });

  it("uses current pool credentials once per executor and fails after removal", async () => {
    const h = harness();
    const dispose = await setupV2(h.context, h.dependencies);
    await h.options().fetch("https://example.test");
    expect(h.executor.fetch).toHaveBeenCalledOnce();
    h.state.auth = null;
    await h.callbacks.context(h.event());
    await expect(h.options().fetch("https://example.test")).rejects.toThrow("connection changed");
    await dispose();
  });

  it("disables its own stale host credential after the last pool account is removed", async () => {
    const h = harness();
    h.state.connection = { type: "credential", method: "oauth", id: "own" };
    h.state.credential = { methodID: OAUTH_METHOD_ID, access: "stale-host-copy" };
    const dispose = await setupV2(h.context, h.dependencies);
    h.state.auth = null;
    await h.callbacks.context(h.event());
    expect(h.provider().activation).toBe("disabled");
    expect(h.options().isManagedModel({ providerID: "anthropic" })).toBe(false);
    await dispose();
  });

  it("keeps administrative registration available when an owned expired credential cannot refresh", async () => {
    const h = harness();
    h.state.connection = { type: "credential", method: "oauth", id: "own" };
    h.state.credential = { methodID: OAUTH_METHOD_ID };
    const dispose = await setupV2(h.context, h.dependencies);
    h.state.auth = null;
    h.context.integration.connection.resolve.mockRejectedValue(new Error("refresh unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.callbacks.context(h.event());
      expect(h.provider().activation).toBe("disabled");
      expect(h.callbacks.rpc.execute).toBeTypeOf("function");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Reconnect"));
    } finally {
      warning.mockRestore();
      await dispose();
    }
  });

  it("disables an owned unexpired host credential on a fresh boot with an empty pool", async () => {
    const h = harness();
    h.state.connection = { type: "credential", method: "oauth", id: "own" };
    h.state.credential = { methodID: OAUTH_METHOD_ID };
    h.state.auth = null;
    const dispose = await setupV2(h.context, h.dependencies);
    expect(h.provider().activation).toBe("disabled");
    await dispose();
  });

  it("normalizes system parts and explicitly rejects native checkpoint histories", async () => {
    const h = harness();
    const dispose = await setupV2(h.context, h.dependencies);
    for (const name of ["context", "title", "generate", "compaction"]) {
      const event = h.event();
      await h.callbacks[name](event);
      expect(event.system[0]).toEqual({ type: "text", text: "identity" });
      if (name === "compaction") expect(event.system.at(-1)).toEqual({ type: "text", text: "pool state" });
    }
    const event = h.event();
    event.messages.push({ role: "assistant", content: [{ type: "compaction", text: "checkpoint" }] });
    await expect(h.callbacks.context(event)).rejects.toThrow("Start a new session");
    await dispose();
  });

  it("registers OAuth, persists callback shape and never restores removed accounts from host copies", async () => {
    const h = harness();
    const dispose = await setupV2(h.context, h.dependencies);
    let method;
    h.callbacks.integration({
      method: {
        update(value) {
          method = value;
        },
      },
    });
    const authorization = await method.authorize({});
    expect(authorization.mode).toBe("code");
    expect(await authorization.callback("fake-code")).toEqual({ ...h.state.auth, methodID: OAUTH_METHOD_ID });
    h.state.auth = null;
    await expect(method.refresh({ access: "stale", refresh: "stale" })).rejects.toThrow("No enabled");
    await dispose();
  });

  it("routes administrative output through RPC and cleans up exactly once", async () => {
    const h = harness();
    const dispose = await setupV2(h.context, h.dependencies);
    const call = { signal: new AbortController().signal, error: vi.fn() };
    expect(await h.callbacks.rpc.execute({ sessionID: "s1", arguments: "status" }, call)).toEqual({
      output: "Executed status",
    });
    expect(h.runtime.executeCommand).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await dispose();
    await dispose();
    expect(h.runtime.dispose).toHaveBeenCalledOnce();
    expect(h.transport.dispose).toHaveBeenCalledOnce();
    for (const resource of h.resources) expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it("rolls back registrations if initialization fails", async () => {
    const h = harness();
    h.context.model.transform.mockRejectedValue(new Error("registration failed"));
    await expect(setupV2(h.context, h.dependencies)).rejects.toThrow("registration failed");
    expect(h.runtime.dispose).toHaveBeenCalledOnce();
    expect(h.transport.dispose).toHaveBeenCalledOnce();
    for (const resource of h.resources) expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it("does not reload the host after disposal while a connection refresh is pending", async () => {
    const h = harness();
    const dispose = await setupV2(h.context, h.dependencies);
    let complete;
    h.runtime.getCurrentAuth.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = h.callbacks.context(h.event());
    const rejected = expect(pending).rejects.toThrow("disposed");
    await dispose();
    complete(h.state.auth);
    await rejected;
    expect(h.context.provider.reload).toHaveBeenCalledTimes(1);
  });
});
