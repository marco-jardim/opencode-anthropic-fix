import { AsyncLocalStorage } from "node:async_hooks";
import { createAnthropicRuntime } from "./runtime.mjs";
import { registerAnthropicCommandRpc, registerAnthropicServerCommand } from "./command-rpc.mjs";
import { setupV2Transport } from "./v2-transport.mjs";
import { prepareV2Tools } from "./tool-names.mjs";
import { applyV2MessagePolicies, assertPortableV2History } from "./v2-context.mjs";
import { isTruthyEnv } from "../env.mjs";
import { hasOneMillionContext, isOpus46Model, isOpus47Model, isOpus48Model } from "../mimicry/wire-compat.mjs";

export const OAUTH_METHOD_ID = "opencode-anthropic-fix";
// The host rewrites the unversioned SDK name to its native provider. A pinned
// package spec keeps the public AI SDK route and its dynamic loader resolvable.
export const V2_MODEL_PACKAGE = "aisdk:@ai-sdk/anthropic@3.0.111";

/** @param {object} auth */
function credential(auth) {
  if (!auth?.access || !auth?.refresh) throw new Error("No enabled Anthropic OAuth account. Use /anthropic login.");
  return {
    type: "oauth",
    methodID: OAUTH_METHOD_ID,
    access: auth.access,
    refresh: auth.refresh,
    expires: auth.expires,
  };
}

/**
 * v2 owns registration and presentation; the shared runtime owns credentials,
 * request construction and retries. No v1 hooks are returned to the v2 host.
 * @param {import('@opencode/plugin').Plugin.Context} context
 * @param {{createRuntime?: typeof createAnthropicRuntime, setupTransport?: typeof setupV2Transport}} [dependencies]
 */
export async function setupV2(context, dependencies = {}) {
  const runtime = (dependencies.createRuntime ?? createAnthropicRuntime)({
    interactiveOAuth: false,
    hostCompatShim: true, // @ai-sdk/anthropic 3.0.111 is pinned, even when the host omits its UA.
    prepareRequest: prepareV2Tools,
  });
  const commands = new AsyncLocalStorage();
  const registrations = [];
  let disposed = false;
  let managed = false;
  let poolAvailable = false;
  let ownedConnection = false;
  const knownOwnedConnections = new Set();
  let fetchPromise;
  let connection;
  let config;
  let transport;
  let refreshStatePromise;
  let stateSignature;
  let warnedAboutHaikuSummary = false;

  function assertActive() {
    if (disposed) throw new Error("Anthropic plugin is disposed");
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    const failures = [];
    for (const resource of [transport, ...registrations.reverse(), runtime]) {
      try {
        await resource?.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Failed to dispose Anthropic plugin resources");
  }

  async function refreshState() {
    assertActive();
    if (refreshStatePromise) return refreshStatePromise;
    refreshStatePromise = (async () => {
      runtime.reloadConfig();
      poolAvailable = Boolean(await runtime.getCurrentAuth({ allowExpired: true }));
      assertActive();
      connection = await context.integration.connection.active("anthropic");
      assertActive();
      // An explicitly selected API key/environment connection remains native.
      // Existing pools can be used before connecting a v2 credential.
      const connectionKey = JSON.stringify(connection);
      ownedConnection = knownOwnedConnections.has(connectionKey);
      if (connection?.type === "credential" && connection.method === "oauth") {
        try {
          const activeCredential = await context.integration.connection.resolve(connection);
          assertActive();
          ownedConnection = activeCredential?.methodID === OAUTH_METHOD_ID;
          if (ownedConnection) knownOwnedConnections.add(connectionKey);
          else knownOwnedConnections.delete(connectionKey);
        } catch (error) {
          if (disposed) throw error;
          // The host may attempt to refresh an expired credential after its
          // account was removed. Keep administration available and preserve a
          // known owned connection's disabled state; never print token errors.
          console.warn(
            "[anthropic] The selected OAuth connection could not be resolved. Reconnect through /anthropic login.",
          );
        }
      }
      managed = poolAvailable && (!connection || ownedConnection);
      config = structuredClone(runtime.getConfig());
      if (managed && config.token_economy_strategies.haiku_rolling_summary && !warnedAboutHaikuSummary) {
        warnedAboutHaikuSummary = true;
        console.warn(
          "[anthropic] haiku_rolling_summary requires a v1 fork hook; OpenCode v2 uses summary compaction instead.",
        );
      }
      const nextSignature = JSON.stringify({
        managed,
        ownedConnection,
        connection,
        limits: config.override_model_limits,
      });
      if (nextSignature !== stateSignature) {
        stateSignature = nextSignature;
        fetchPromise = undefined;
        await context.provider.reload();
      }
    })().finally(() => {
      refreshStatePromise = undefined;
    });
    return refreshStatePromise;
  }

  try {
    const hooks = await runtime.initialize({
      client: {
        // The runtime persists the rotated token under its cross-process lock.
        // v2 persists the returned credential only through its OAuth callbacks;
        // there is deliberately no invented credential-update API here.
        auth: {
          async set() {
            return undefined;
          },
        },
        session: {
          async prompt({ body }) {
            const output = commands.getStore();
            if (!output) throw new Error("Administrative output requires an Anthropic command invocation");
            output.push(...body.parts.filter((part) => part.type === "text").map((part) => part.text));
          },
        },
        tui: {
          async showToast({ body }) {
            const output = commands.getStore();
            if (output) output.push(body.message);
          },
        },
      },
    });

    const isManagedModel = (model) => managed && model?.providerID === "anthropic";
    transport = await (dependencies.setupTransport ?? setupV2Transport)(context, {
      isManagedModel,
      async fetch(input, init) {
        if (disposed) throw new Error("Anthropic plugin is disposed");
        if (!managed) throw new Error("The Anthropic OAuth connection changed. Retry with the selected connection.");
        fetchPromise ??= hooks.auth.loader(
          async () => (await runtime.getCurrentAuth({ allowExpired: true })) ?? { type: "none" },
          { models: {} },
        );
        const executor = await fetchPromise;
        if (typeof executor.fetch !== "function") {
          fetchPromise = undefined;
          throw new Error("No enabled Anthropic OAuth account. Use /anthropic login.");
        }
        return executor.fetch(input, init);
      },
    });

    registrations.push(
      await context.integration.transform((editor) => {
        editor.method.update({
          integrationID: "anthropic",
          method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Claude Pro/Max (multi-account)" },
          async authorize() {
            const flow = await runtime.authorizeOAuth();
            return {
              url: flow.url,
              instructions: flow.instructions,
              mode: "code",
              async callback(code) {
                const result = await flow.callback(code);
                if (result.type !== "success") throw new Error("Anthropic authorization failed. Start login again.");
                fetchPromise = undefined;
                await refreshState();
                return credential(result);
              },
            };
          },
          async refresh() {
            // Disk stays authoritative after logout/removal and cross-process refresh.
            return credential(await runtime.getCurrentAuth({ refresh: true }));
          },
          label: () => "Claude Pro/Max account pool",
        });
      }),
    );

    registrations.push(
      await context.provider.transform((editor) => {
        if ((!managed && !ownedConnection) || !editor.get("anthropic")) return;
        editor.update("anthropic", (provider) => {
          if (!poolAvailable) {
            // A stale host credential must not resurrect an account removed
            // from the authoritative pool by silently reverting to native.
            provider.activation = "disabled";
            return;
          }
          provider.activation = "enabled";
          provider.package = V2_MODEL_PACKAGE;
          provider.settings = { ...provider.settings, apiKey: "opencode-managed-oauth" };
          // The compatibility route uses the host's summary compaction instead.
          provider.settings.compaction = { type: "summary" };
        });
      }),
    );
    registrations.push(
      await context.model.transform((editor) => {
        if (!managed) return;
        for (const candidate of editor.list("anthropic")) {
          editor.update(candidate.providerID, candidate.id, (model) => {
            model.package = V2_MODEL_PACKAGE;
            model.settings = { ...model.settings };
            model.settings.compaction = { type: "summary" };
            // The host merges a selected variant after the base model settings.
            for (const variant of model.variants ?? []) {
              variant.settings = { ...variant.settings, compaction: { type: "summary" } };
            }
            model.cost = model.cost.map((tier) => ({ ...tier, input: 0, output: 0, cache: { read: 0, write: 0 } }));
            if (
              config.override_model_limits.enabled &&
              !isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT) &&
              (hasOneMillionContext(model.id) ||
                isOpus46Model(model.id) ||
                isOpus47Model(model.id) ||
                isOpus48Model(model.id))
            ) {
              model.limit.context = config.override_model_limits.context;
              if (config.override_model_limits.output > 0) model.limit.output = config.override_model_limits.output;
            }
          });
        }
      }),
    );

    for (const name of ["context", "compaction", "generate", "title"]) {
      registrations.push(
        await context.session.hook(
          name,
          async (event) => {
            await refreshState();
            if (!isManagedModel(event.model)) return;
            assertPortableV2History(event.messages);
            applyV2MessagePolicies(event.messages, runtime.getConfig().token_economy_strategies);
            await hooks["experimental.chat.system.transform"]({ model: event.model }, { system: event.system });
            for (let i = 0; i < event.system.length; i++) {
              if (typeof event.system[i] === "string") event.system[i] = { type: "text", text: event.system[i] };
            }
            if (name === "compaction") {
              const output = { context: [] };
              await hooks["experimental.session.compacting"]({ sessionID: event.sessionID }, output);
              event.system.push(...output.context.map((text) => ({ type: "text", text })));
            }
          },
          { providerID: "anthropic" },
        ),
      );
    }

    registrations.push(await registerAnthropicServerCommand(context));
    registrations.push(
      await registerAnthropicCommandRpc(context, async (input) => {
        const output = [];
        await commands.run(output, () => runtime.executeCommand(input));
        fetchPromise = undefined;
        await refreshState();
        return output.join("\n\n");
      }),
    );
    await refreshState();
    return dispose;
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Anthropic v2 initialization and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
