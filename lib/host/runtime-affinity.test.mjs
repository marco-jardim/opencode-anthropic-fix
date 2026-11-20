import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "", config: null, orgLocked: false }));

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
// Under the pinned wire profile no model is organization-locked, so the
// capability predicate is stubbed; everything else is the real module.
vi.mock("../mimicry/wire-compat.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isOrgLockedThinkingModelWire: () => state.orgLocked };
});

import { DEFAULT_CONFIG } from "../config.mjs";
import { loadAccounts, saveAccounts } from "../storage.mjs";
import { createAnthropicRuntime } from "./runtime.mjs";

const HOUR = 60 * 60 * 1000;
const url = "https://api.anthropic.com/v1/messages";
const runtimes = [];
const auth = () => ({ type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + HOUR });

function makeClient({ summarize = true } = {}) {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      ...(summarize ? { summarize: vi.fn().mockResolvedValue(undefined) } : {}),
    },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function streamResponse(inputTokens = 20, extraHeaders = {}) {
  return new Response(
    `data: {"type":"message_start","message":{"usage":{"input_tokens":${inputTokens}}}}\n\n` +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
      'data: {"type":"message_stop"}\n\n',
    { headers: { "content-type": "text/event-stream", ...extraHeaders } },
  );
}

const V2_SESSION_HEADER = "x-opencode-anthropic-fix-session";

function requestInit({ session, v2Session, messages } = {}) {
  return {
    method: "POST",
    headers: {
      ...(session ? { "x-opencode-session": session } : {}),
      ...(v2Session ? { [V2_SESSION_HEADER]: v2Session } : {}),
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 32_000,
      messages: messages ?? [{ role: "user", content: "Hello" }],
    }),
  };
}

async function boot({ client = makeClient(), ...options } = {}) {
  const runtime = createAnthropicRuntime(options);
  runtimes.push(runtime);
  const hooks = await runtime.initialize({ client });
  const transport = await hooks.auth.loader(async () => auth(), { models: {} });
  runtime.getMetrics().lastQuota.lastPollAt = Date.now();
  return { runtime, hooks, transport, client };
}

async function send(transport, init) {
  const result = await transport.fetch(url, init);
  await result.text();
  return result;
}

const bearer = (call) => new Headers(call[1].headers).get("authorization");

describe("org affinity for org-locked thinking", () => {
  let pool;
  const makePool = (orgs) => ({
    version: 1,
    activeIndex: 0,
    accounts: orgs.map((organizationUuid, index) => ({
      id: `account-${index}`,
      access: `access-${index}`,
      refreshToken: `refresh-${index}`,
      expires: Date.now() + HOUR,
      addedAt: index + 1,
      lastUsed: 0,
      enabled: true,
      organizationUuid,
      rateLimitResetTimes: {},
      consecutiveFailures: 0,
      lastFailureTime: null,
    })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.orgLocked = true;
    pool = makePool(["org-a", "org-b", "org-b"]);
    loadAccounts.mockImplementation(async () => structuredClone(pool));
    saveAccounts.mockResolvedValue(undefined);
    state.directory = mkdtempSync(join(tmpdir(), "anthropic-affinity-test-"));
    state.config = structuredClone(DEFAULT_CONFIG);
    state.config.signature_emulation.fetch_claude_code_version_on_startup = false;
    state.config.idle_refresh.enabled = false;
    state.config.preconnect.enabled = false;
    state.config.adaptive_context.enabled = false;
    state.config.account_selection_strategy = "round-robin";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Unexpected external request"))),
    );
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(state.directory, { recursive: true, force: true });
  });

  async function servedAccounts(count, init) {
    const fetcher = vi.fn().mockImplementation(async () => streamResponse());
    const { transport } = await boot({ fetch: fetcher });
    for (let i = 0; i < count; i++) await send(transport, init());
    return fetcher.mock.calls.map(bearer);
  }

  it("rotates across organizations when the model is not org-locked (control)", async () => {
    state.orgLocked = false;
    const tokens = await servedAccounts(3, () => requestInit({ session: "ses-1" }));
    expect(new Set(tokens).size).toBeGreaterThan(1);
  });

  it("keeps a conversation on the organization that served it", async () => {
    const tokens = await servedAccounts(4, () => requestInit({ session: "ses-1" }));
    expect(new Set(tokens).size).toBe(1);
  });

  it("does nothing when account_affinity.org_locked_thinking is false", async () => {
    state.config.account_affinity.org_locked_thinking = false;
    const tokens = await servedAccounts(3, () => requestInit({ session: "ses-1" }));
    expect(new Set(tokens).size).toBeGreaterThan(1);
  });

  describe("session identity carried by the v2 transport", () => {
    // The v2 transport labels each request with its own session id (an internal
    // header) because the host sends neither `x-opencode-session` nor
    // `x-session-id`. Without it every headerless request shared one plugin-wide key.
    const REQUEST_ID = "req_011CAbc123";
    const sentBody = (call) => call[1].body;
    const sentHeaders = (call) => new Headers(call[1].headers);
    const orgOf = (call) => pool.accounts[Number(bearer(call).replace("Bearer access-", ""))].organizationUuid;
    const servedBy = () => vi.fn().mockImplementation(async () => streamResponse(20, { "request-id": REQUEST_ID }));

    it("never hands one session's previous ids, prompt id or organization to another", async () => {
      const fetcher = servedBy();
      const { transport } = await boot({ fetch: fetcher });
      await send(transport, requestInit({ v2Session: "ses-A" }));
      await send(transport, requestInit({ v2Session: "ses-A" }));
      await send(transport, requestInit({ v2Session: "ses-B" }));
      const [a1, a2, b1] = fetcher.mock.calls;

      // Control: the same session does carry its own previous request id and org.
      expect(sentBody(a1)).not.toContain(REQUEST_ID);
      expect(sentBody(a2)).toContain(REQUEST_ID);
      expect(orgOf(a2)).toBe(orgOf(a1));
      // Another session starts from nothing.
      expect(sentBody(b1)).not.toContain(REQUEST_ID);
      expect(sentBody(b1)).toContain("cc_prompt_index=1");
      expect(sentHeaders(b1).get("x-claude-code-prompt-id")).toBeTruthy();
      expect(sentHeaders(b1).get("x-claude-code-prompt-id")).not.toBe(sentHeaders(a1).get("x-claude-code-prompt-id"));
      expect(sentHeaders(b1).get("x-claude-code-prompt-id")).not.toBe(sentHeaders(a2).get("x-claude-code-prompt-id"));
      expect(orgOf(b1)).not.toBe(orgOf(a1));
      // The internal label is never sent.
      for (const call of fetcher.mock.calls) {
        expect([...sentHeaders(call).keys()].filter((name) => name.startsWith("x-opencode-"))).toEqual([]);
      }
    });

    it("lets the explicit session headers win over the transport's label", async () => {
      const fetcher = servedBy();
      const { transport } = await boot({ fetch: fetcher });
      await send(transport, requestInit({ session: "ses-explicit", v2Session: "ses-X" }));
      await send(transport, requestInit({ session: "ses-explicit", v2Session: "ses-Y" }));
      expect(sentBody(fetcher.mock.calls[1])).toContain(REQUEST_ID);
    });
  });

  it("falls back to normal selection and toasts once when no same-org account is available", async () => {
    const fetcher = vi.fn().mockImplementation(async () => streamResponse());
    const { runtime, transport, client } = await boot({ fetch: fetcher });
    await send(transport, requestInit({ session: "ses-1" }));
    const first = bearer(fetcher.mock.calls[0]);
    const servedIndex = Number(first.replace("Bearer access-", ""));
    const servedOrg = pool.accounts[servedIndex].organizationUuid;

    // Take every account of that organization away; the other org remains.
    for (const account of pool.accounts) if (account.organizationUuid === servedOrg) account.enabled = false;
    await runtime.__testing__.reloadAccountManagerFromDisk();
    await send(transport, requestInit({ session: "ses-1" }));
    const second = bearer(fetcher.mock.calls[1]);
    expect(second).not.toBe(first);
    const toasts = () =>
      client.tui.showToast.mock.calls
        .map(([arg]) => arg.body.message)
        .filter((message) => /organization/.test(message));
    expect(toasts()).toHaveLength(1);

    // The conversation now lives on the new org; bring the old org back and
    // take the new one away: a second mismatch must NOT toast again.
    for (const account of pool.accounts) account.enabled = account.organizationUuid === servedOrg;
    await runtime.__testing__.reloadAccountManagerFromDisk();
    await send(transport, requestInit({ session: "ses-1" }));
    expect(toasts()).toHaveLength(1);
  });

  describe("stripping prior thinking on an org switch", () => {
    const history = [
      { role: "user", content: "one" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning", signature: "sig-old" },
          { type: "text", text: "first answer" },
        ],
      },
      { role: "user", content: "two" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest reasoning", signature: "sig-latest" },
          { type: "text", text: "second answer" },
        ],
      },
      { role: "user", content: "three" },
    ];
    const thinkingTexts = (call) =>
      JSON.parse(call[1].body)
        .messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === "thinking")
        .map((b) => b.thinking);

    async function switchOrgs(strip) {
      state.config.account_affinity.strip_thinking_on_org_switch = strip;
      const fetcher = vi.fn().mockImplementation(async () => streamResponse());
      const { runtime, transport } = await boot({ fetch: fetcher });
      await send(transport, requestInit({ session: "ses-1", messages: history }));
      const servedIndex = Number(bearer(fetcher.mock.calls[0]).replace("Bearer access-", ""));
      const servedOrg = pool.accounts[servedIndex].organizationUuid;
      for (const account of pool.accounts) if (account.organizationUuid === servedOrg) account.enabled = false;
      await runtime.__testing__.reloadAccountManagerFromDisk();
      await send(transport, requestInit({ session: "ses-1", messages: history }));
      return fetcher.mock.calls;
    }

    it("keeps prior thinking by default (stickiness only)", async () => {
      const calls = await switchOrgs(false);
      expect(thinkingTexts(calls[1])).toEqual(thinkingTexts(calls[0]));
      expect(thinkingTexts(calls[1])).toContain("old reasoning");
    });

    it("strips prior thinking, keeping the latest assistant turn, only when opted in", async () => {
      const calls = await switchOrgs(true);
      expect(thinkingTexts(calls[0])).toContain("old reasoning");
      expect(thinkingTexts(calls[1])).not.toContain("old reasoning");
      expect(thinkingTexts(calls[1])).toContain("latest reasoning");
    });
  });
});

describe("opt-in idle compaction", () => {
  const SESSION = "ses-idle";
  const idleEvent = (sessionID = SESSION) => ({ event: { type: "session.idle", properties: { sessionID } } });

  beforeEach(() => {
    vi.clearAllMocks();
    state.orgLocked = false;
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);
    state.directory = mkdtempSync(join(tmpdir(), "anthropic-idle-test-"));
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
    rmSync(state.directory, { recursive: true, force: true });
  });

  /** Timers must be faked BEFORE the runtime exists: the scheduler binds them at creation. */
  async function bootIdle({ enabled = true, summarize = true } = {}) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.config.token_economy.idle_compaction = enabled;
    const booted = await boot({
      client: makeClient({ summarize }),
      fetch: vi.fn().mockImplementation(async () => streamResponse(250_000)),
    });
    await send(booted.transport, requestInit({ session: SESSION }));
    return booted;
  }

  it("is off by default", () => {
    expect(DEFAULT_CONFIG.token_economy.idle_compaction).toBe(false);
  });

  it("makes no call when disabled", async () => {
    const { hooks, client } = await bootIdle({ enabled: false });
    await hooks.event(idleEvent());
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(client.session.summarize).not.toHaveBeenCalled();
  });

  it("compacts once at 0.9 x 1h, not before", async () => {
    const { hooks, client } = await bootIdle();
    await hooks.event(idleEvent());
    await vi.advanceTimersByTimeAsync(0.9 * HOUR - 1000);
    expect(client.session.summarize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.session.summarize).toHaveBeenCalledTimes(1);
    expect(client.session.summarize).toHaveBeenCalledWith({
      path: { id: SESSION },
      body: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    });
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { message: "Compacted while idle, before the prompt cache expired", variant: "info" },
    });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(client.session.summarize).toHaveBeenCalledTimes(1);
  });

  it("does not compact a context below the minimum size", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.config.token_economy.idle_compaction = true;
    const { hooks, transport, client } = await boot({
      client: makeClient(),
      fetch: vi.fn().mockImplementation(async () => streamResponse(5_000)),
    });
    await send(transport, requestInit({ session: SESSION }));
    await hooks.event(idleEvent());
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(client.session.summarize).not.toHaveBeenCalled();
  });

  it("is skipped when the host has no summarize API", async () => {
    const { hooks, client } = await bootIdle({ summarize: false });
    await hooks.event(idleEvent());
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(client.session.summarize).toBeUndefined();
    expect(client.tui.showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ message: expect.stringMatching(/Compacted/) }) }),
    );
  });

  it("is skipped when usage is limited", async () => {
    const { runtime, hooks, client } = await bootIdle();
    await hooks.event(idleEvent());
    runtime.getMetrics().lastQuota.overallStatus = "rejected";
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(client.session.summarize).not.toHaveBeenCalled();
  });

  it("re-reads the config when the timer fires", async () => {
    const { hooks, client } = await bootIdle();
    await hooks.event(idleEvent());
    state.config.token_economy.idle_compaction = false;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(client.session.summarize).not.toHaveBeenCalled();
  });

  it("is cancelled by a new request for the same session", async () => {
    const { hooks, transport, client } = await bootIdle();
    await hooks.event(idleEvent());
    await vi.advanceTimersByTimeAsync(0.5 * HOUR);
    await send(transport, requestInit({ session: SESSION }));
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(client.session.summarize).not.toHaveBeenCalled();
  });

  it("is not cancelled by a request for another session", async () => {
    const { hooks, transport, client } = await bootIdle();
    await hooks.event(idleEvent());
    await send(transport, requestInit({ session: "ses-other" }));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(client.session.summarize).toHaveBeenCalledTimes(1);
  });

  it("ignores an idle event for a session it has not seen", async () => {
    const { hooks, client } = await bootIdle();
    await hooks.event(idleEvent("ses-unknown"));
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(client.session.summarize).not.toHaveBeenCalled();
  });

  it("still disposes the runtime on server.instance.disposed, and cancels the timer", async () => {
    const { hooks, client } = await bootIdle();
    await hooks.event(idleEvent());
    await hooks.event({ event: { type: "server.instance.disposed", properties: {} } });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(client.session.summarize).not.toHaveBeenCalled();
    await expect(hooks.auth.loader(async () => auth(), { models: {} })).rejects.toThrow("runtime disposed");
  });
});
