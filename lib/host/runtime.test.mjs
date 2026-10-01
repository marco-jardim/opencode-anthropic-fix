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
import { createAnthropicRuntime } from "./runtime.mjs";
import { prepareV2Tools } from "./tool-names.mjs";
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(state.directory, { recursive: true, force: true });
});

describe("host runtime lifecycle", () => {
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

  it("keeps a forced v2 tool choice aligned with the actual outgoing definition", async () => {
    const send = vi.fn().mockImplementation(async () => response());
    const { transport } = await boot({ fetch: send, prepareRequest: prepareV2Tools });
    await transport.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Use shell" }],
        tools: [{ name: "shell", description: "Run command", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "tool", name: "shell" },
      }),
    });
    const body = JSON.parse(send.mock.calls[0][1].body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "Bash" });
    expect(body.tools[0].name).toBe(body.tool_choice.name);
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

  it("maps tool names and usage in a non-streaming v2 response", async () => {
    const prepareRequest = vi.fn(prepareV2Tools);
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "message",
            content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 12, output_tokens: 7 },
          }),
          { headers: { "content-type": "application/json", "content-length": "999", "content-encoding": "gzip" } },
        ),
    );
    const { runtime, transport } = await boot({ prepareRequest, fetch: send });
    const init = requestInit();
    init.body = JSON.stringify({
      ...JSON.parse(init.body),
      tools: [{ name: "shell", description: "Run a shell command", input_schema: { type: "object", properties: {} } }],
    });
    const result = await transport.fetch(url, init);
    expect((await result.json()).content[0]).toMatchObject({ name: "shell", id: "tool-1" });
    expect(result.headers.has("content-length")).toBe(false);
    expect(result.headers.has("content-encoding")).toBe(false);
    expect(runtime.getMetrics()).toMatchObject({ totalInput: 12, totalOutput: 7, turns: 1 });
    expect(prepareRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][1].body).tools[0].name).toBe("Bash");
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
});
