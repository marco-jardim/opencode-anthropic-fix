import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "", config: null }));

vi.mock("../config.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => state.config,
    loadConfigFresh: () => state.config,
    getConfigDir: () => state.directory,
    saveConfig: vi.fn(),
  };
});
vi.mock("../storage.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadAccounts: vi.fn().mockResolvedValue(null),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    clearAccounts: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../refresh-lock.mjs", () => ({
  acquireRefreshLock: vi.fn().mockResolvedValue({ acquired: true, lockPath: null }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

import { DEFAULT_CONFIG } from "../config.mjs";
import { loadAccounts, saveAccounts } from "../storage.mjs";
import { createInterface } from "node:readline/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { AccountManager } from "../accounts.mjs";
import { createAnthropicRuntime } from "./runtime.mjs";
import { AnthropicAuthPlugin } from "../../index.mjs";

const runtimes = [];
const auth = () => ({ type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600_000 });
const client = () => ({
  auth: { set: vi.fn().mockResolvedValue(undefined) },
  session: { prompt: vi.fn().mockResolvedValue(undefined) },
  tui: { showToast: vi.fn().mockResolvedValue(undefined) },
});
const requestInit = (signal) => ({
  method: "POST",
  signal,
  body: JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  }),
});
const url = "https://api.anthropic.com/v1/messages";
function response() {
  return new Response(
    'data: {"type":"message_start","message":{"usage":{"input_tokens":20}}}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
      'data: {"type":"message_stop"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function boot(options = {}, credentials = auth()) {
  const runtime = createAnthropicRuntime(options);
  runtimes.push(runtime);
  const hooks = await runtime.initialize({ client: client() });
  const transport = await hooks.auth.loader(async () => credentials, { models: {} });
  runtime.getMetrics().lastQuota.lastPollAt = Date.now();
  return { runtime, transport };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadAccounts.mockResolvedValue(null);
  saveAccounts.mockResolvedValue(undefined);
  state.directory = mkdtempSync(join(tmpdir(), "anthropic-runtime-test-"));
  state.config = structuredClone(DEFAULT_CONFIG);
  state.config.signature_emulation.fetch_claude_code_version_on_startup = false;
  state.config.idle_refresh.enabled = false;
  state.config.preconnect.enabled = false;
  state.config.adaptive_context.enabled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected external request"))),
  );
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(state.directory, { recursive: true, force: true });
});

describe("host runtime lifecycle", () => {
  it("does not revive a disposed runtime when deferred auth resolves", async () => {
    const baseline = process.listenerCount("beforeExit");
    state.config.telemetry.emulate_minimal = true;
    const runtime = createAnthropicRuntime();
    runtimes.push(runtime);
    const hooks = await runtime.initialize({ client: client() });
    let resolveAuth;
    const pending = hooks.auth.loader(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
      { models: {} },
    );
    const rejected = expect(pending).rejects.toThrow("runtime disposed");
    await runtime.dispose();
    resolveAuth(auth());
    await rejected;
    await runtime.dispose();
    expect(loadAccounts).not.toHaveBeenCalled();
    expect(saveAccounts).not.toHaveBeenCalled();
    expect(process.listenerCount("beforeExit")).toBe(baseline);
  });

  it("disposes a manager acquired after disposal without saving it", async () => {
    const runtime = createAnthropicRuntime();
    runtimes.push(runtime);
    const hooks = await runtime.initialize({ client: client() });
    let resolveManager;
    const late = { dispose: vi.fn().mockResolvedValue(undefined), saveToDisk: vi.fn(), getAccountCount: () => 1 };
    vi.spyOn(AccountManager, "load").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveManager = resolve;
        }),
    );
    const pending = hooks.auth.loader(async () => auth(), { models: {} });
    const rejected = expect(pending).rejects.toThrow("runtime disposed");
    await vi.waitFor(() => expect(resolveManager).toBeTypeOf("function"));
    await runtime.dispose();
    resolveManager(late);
    await rejected;
    expect(late.dispose).toHaveBeenCalledWith({ flush: false });
    expect(late.saveToDisk).not.toHaveBeenCalled();
  });

  it("disposes a manager acquired late during disk reload without publishing it", async () => {
    const { runtime } = await boot();
    let resolveManager;
    const late = { dispose: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(AccountManager, "load").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveManager = resolve;
        }),
    );
    const pending = runtime.__testing__.reloadAccountManagerFromDisk();
    const rejected = expect(pending).rejects.toThrow("runtime disposed");
    await vi.waitFor(() => expect(resolveManager).toBeTypeOf("function"));
    await runtime.dispose();
    resolveManager(late);
    await rejected;
    expect(late.dispose).toHaveBeenCalledWith({ flush: false });
  });

  it("shares disposal completion and disables request context only after cleanup", async () => {
    const { runtime } = await boot();
    let finish;
    vi.spyOn(AccountManager.prototype, "dispose").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const disable = vi.spyOn(AsyncLocalStorage.prototype, "disable");
    const first = runtime.dispose();
    const second = runtime.dispose();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(disable).not.toHaveBeenCalled();
    finish();
    await first;
    expect(second).toBe(first);
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("handles repeated v1 event-dispose cycles without leaking telemetry listeners", async () => {
    const baseline = process.listenerCount("beforeExit");
    state.config.telemetry.emulate_minimal = true;
    for (let i = 0; i < 3; i++) {
      const hooks = await AnthropicAuthPlugin({ client: client(), directory: "project-a" });
      await hooks.auth.loader(async () => auth(), { models: {} });
      expect(process.listenerCount("beforeExit")).toBe(baseline + 1);
      await hooks.event({ event: { type: "server.instance.disposed", properties: { directory: "project-b" } } });
      expect(process.listenerCount("beforeExit")).toBe(baseline + 1);
      await hooks.event({ event: { type: "server.instance.disposed", properties: { directory: "project-a" } } });
      try {
        expect(process.listenerCount("beforeExit")).toBe(baseline);
      } finally {
        await hooks.dispose();
      }
    }
  });

  it("exposes idempotent cleanup to the modern v1 loader", async () => {
    const hooks = await AnthropicAuthPlugin({ client: client() });
    await hooks.dispose();
    await hooks.dispose();
    await expect(hooks.auth.loader(async () => auth(), { models: {} })).rejects.toThrow("runtime disposed");
  });

  it("returns OAuth model policy through the public modern v1 provider hook", async () => {
    state.config.override_model_limits.enabled = true;
    vi.stubEnv("CLAUDE_CODE_DISABLE_1M_CONTEXT", "0");
    const runtime = createAnthropicRuntime();
    runtimes.push(runtime);
    const hooks = await runtime.initialize({ client: client() });
    const provider = {
      models: {
        "claude-opus-4-6": {
          id: "claude-opus-4-6",
          cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
          limit: { context: 200000, output: 32000 },
        },
      },
    };
    const baseline = structuredClone(provider);
    expect(await hooks.provider.models(provider, { auth: { type: "api", key: "fake" } })).toEqual(baseline.models);
    const models = await hooks.provider.models(provider, { auth: auth() });
    expect(models["claude-opus-4-6"].cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } });
    expect(models["claude-opus-4-6"].limit.context).toBe(runtime.getConfig().override_model_limits.context);
  });

  function storedPool() {
    return {
      version: 1,
      activeIndex: 0,
      accounts: [0, 1].map((index) => ({
        id: `account-${index}`,
        access: `access-${index}`,
        refreshToken: `refresh-${index}`,
        expires: Date.now() + 3600_000,
        addedAt: index + 1,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      })),
    };
  }

  it.each([false, true])(
    "preserves debounced usage across reload without restoring removed accounts (membership change: %s)",
    async (membershipChange) => {
      let pool = storedPool();
      loadAccounts.mockImplementation(async () => structuredClone(pool));
      saveAccounts.mockImplementation(async (stored) => {
        pool = structuredClone(stored);
      });
      const { runtime, transport } = await boot({ fetch: async () => response() });
      await (await transport.fetch(url, requestInit())).text();
      if (membershipChange) {
        pool.accounts.pop();
        pool.accounts[0].enabled = false;
      }
      await runtime.__testing__.reloadAccountManagerFromDisk();
      await runtime.dispose();
      const saved = pool;
      expect(saved.accounts).toHaveLength(membershipChange ? 1 : 2);
      expect(saved.accounts[0]).toMatchObject({
        enabled: !membershipChange,
        stats: { requests: 1, inputTokens: 20, outputTokens: 5 },
      });
    },
  );

  it("returns only enabled credentials without advancing the rotation strategy", async () => {
    const pool = storedPool();
    pool.accounts[0].enabled = false;
    loadAccounts.mockResolvedValue(pool);
    state.config.account_selection_strategy = "round-robin";
    const runtime = createAnthropicRuntime();
    runtimes.push(runtime);
    await runtime.initialize({ client: client() });
    expect(await runtime.getCurrentAuth({ allowExpired: true })).toMatchObject({ access: "access-1" });
    expect(await runtime.getCurrentAuth({ allowExpired: true })).toMatchObject({ access: "access-1" });
  });

  it("honors the initial account pin before the transport is loaded and across config refresh", async () => {
    loadAccounts.mockResolvedValue(storedPool());
    vi.stubEnv("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT", "2");
    state.config.account_selection_strategy = "round-robin";
    const runtime = createAnthropicRuntime();
    runtimes.push(runtime);
    await runtime.initialize({ client: client() });
    expect(await runtime.getCurrentAuth({ allowExpired: true })).toMatchObject({ access: "access-1" });
    runtime.reloadConfig();
    expect(runtime.getConfig().account_selection_strategy).toBe("sticky");
    expect(await runtime.getCurrentAuth({ allowExpired: true })).toMatchObject({ access: "access-1" });
  });

  it("keeps config and streaming metrics isolated across simultaneous hosts", async () => {
    const a = await boot({ fetch: vi.fn().mockImplementation(async () => response()) });
    const b = await boot({ fetch: vi.fn().mockImplementation(async () => response()) });
    a.runtime.getConfig().fast_mode = true;
    expect(b.runtime.getConfig().fast_mode).toBe(false);
    expect(state.config.fast_mode).toBe(false);
    const result = await a.transport.fetch(url, requestInit());
    await result.text();
    expect(a.runtime.getMetrics()).toMatchObject({ turns: 1, totalInput: 20, totalOutput: 5 });
    expect(b.runtime.getMetrics()).toMatchObject({ turns: 0, totalInput: 0, totalOutput: 0 });
    expect(a.runtime.getMetrics().usedTools).not.toBe(b.runtime.getMetrics().usedTools);
  });

  it("refreshes config in place without leaking nested settings between hosts", async () => {
    const a = await boot();
    const b = await boot();
    const reference = a.runtime.getConfig();
    state.config.fast_mode = true;
    state.config.custom_betas = ["test-beta"];
    expect(a.runtime.reloadConfig()).toBe(reference);
    expect(reference.fast_mode).toBe(true);
    expect(b.runtime.getConfig().fast_mode).toBe(false);
    reference.custom_betas.push("instance-only");
    expect(state.config.custom_betas).toEqual(["test-beta"]);
  });

  it("aborts retry backoff without a second network call", async () => {
    const send = vi.fn().mockImplementation(
      async () =>
        new Response('{"error":{"type":"overloaded_error","message":"overloaded"}}', {
          status: 529,
          headers: { "content-type": "application/json", "retry-after": "10" },
        }),
    );
    const { transport } = await boot({ fetch: send });
    const abort = new AbortController();
    const pending = transport.fetch(url, requestInit(abort.signal));
    const rejected = expect(pending).rejects.toThrow("cancelled by host");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    abort.abort(new Error("cancelled by host"));
    await rejected;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("disposes its own fetch and telemetry listener without affecting another host", async () => {
    const baseline = process.listenerCount("beforeExit");
    state.config.telemetry.emulate_minimal = true;
    const stalled = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );
    const a = await boot({ fetch: stalled });
    const b = await boot({ fetch: vi.fn().mockImplementation(async () => response()) });
    expect(process.listenerCount("beforeExit")).toBe(baseline + 2);
    const pending = a.transport.fetch(url, requestInit());
    const rejected = expect(pending).rejects.toThrow("runtime disposed");
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledTimes(1));
    await a.runtime.dispose();
    await rejected;
    await a.runtime.dispose();
    expect(process.listenerCount("beforeExit")).toBe(baseline + 1);
    expect((await b.transport.fetch(url, requestInit())).status).toBe(200);
    await b.runtime.dispose();
    expect(process.listenerCount("beforeExit")).toBe(baseline);
  });

  it("flushes and cancels delayed persistence on dispose", async () => {
    vi.useFakeTimers();
    const { runtime, transport } = await boot({ fetch: vi.fn().mockImplementation(async () => response()) });
    await (await transport.fetch(url, requestInit())).text();
    await runtime.dispose();
    const writes = saveAccounts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveAccounts).toHaveBeenCalledTimes(writes);
  });

  it("starts OAuth for existing pools without opening a terminal prompt", async () => {
    const { runtime } = await boot({ interactiveOAuth: false });
    const result = await runtime.authorizeOAuth();
    expect(result.method).toBe("code");
    expect(new URL(result.url).protocol).toBe("https:");
    expect(createInterface).not.toHaveBeenCalled();
  });

  it("cancels a refresh request through the host signal before retrying", async () => {
    const send = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", send);
    const { transport } = await boot({}, { ...auth(), expires: 1 });
    const abort = new AbortController();
    const pending = transport.fetch(url, requestInit(abort.signal));
    const rejected = expect(pending).rejects.toThrow("refresh cancelled");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    abort.abort(new Error("refresh cancelled"));
    await rejected;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not abort a shared refresh while another request still needs it", async () => {
    let completeRefresh;
    let refreshSignal;
    const exchange = vi.fn((_input, init) => {
      refreshSignal = init.signal;
      return new Promise((resolve, reject) => {
        completeRefresh = resolve;
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", exchange);
    const { transport } = await boot(
      { fetch: vi.fn().mockImplementation(async () => response()) },
      { ...auth(), expires: 1 },
    );
    const first = new AbortController();
    const cancelled = transport.fetch(url, requestInit(first.signal));
    const rejected = expect(cancelled).rejects.toThrow("first caller cancelled");
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(1));
    const active = transport.fetch(url, requestInit());
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.abort(new Error("first caller cancelled"));
    await rejected;
    expect(refreshSignal.aborted).toBe(false);
    completeRefresh(
      new Response(JSON.stringify({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 })),
    );
    expect((await active).status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("persists rotated tokens after all waiters cancel (late caller: %s)", async (lateCaller) => {
    let completeRefresh;
    let signal;
    const exchange = vi.fn((_input, init) => {
      signal = init.signal;
      return new Promise((resolve, reject) => {
        completeRefresh = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", exchange);
    const send = vi.fn(async () => response());
    const { runtime, transport } = await boot({ fetch: send }, { ...auth(), expires: 1 });
    const controller = new AbortController();
    const cancelled = transport.fetch(url, requestInit(controller.signal));
    const rejected = expect(cancelled).rejects.toThrow("caller left");
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(1));
    controller.abort(new Error("caller left"));
    await rejected;
    expect(signal.aborted).toBe(false);
    const second = lateCaller ? transport.fetch(url, requestInit()) : null;
    const lateResult = second ? expect(second).resolves.toHaveProperty("status", 200) : null;
    if (second) {
      // Let the late caller reach the still-pending refresh through the real
      // transport, without inspecting or mutating the single-flight map.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    }
    completeRefresh(
      new Response(JSON.stringify({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 })),
    );
    if (lateResult) await lateResult;
    await vi.waitFor(() =>
      expect(saveAccounts.mock.calls.map(([stored]) => stored.accounts).flat()).toContainEqual(
        expect.objectContaining({ refreshToken: "rotated", consecutiveFailures: 0 }),
      ),
    );
    expect(await runtime.getCurrentAuth()).toMatchObject({ refresh: "rotated", access: "refreshed" });
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});
