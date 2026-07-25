import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("a"),
    close: vi.fn(),
  })),
}));

vi.mock("../../lib/storage.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadAccounts: vi.fn().mockResolvedValue(null),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    clearAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../lib/refresh-lock.mjs", () => ({
  acquireRefreshLock: vi.fn().mockResolvedValue({
    acquired: true,
    lockPath: "/tmp/opencode-retry-injection-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    account_selection_strategy: "sticky",
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
    preconnect: { ...original.DEFAULT_CONFIG.preconnect, enabled: false },
  });

  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";
import { loadAccounts, saveAccounts } from "../../lib/storage.mjs";
import { createFakeAnthropic, createViFetch, toSSEFrames } from "../helpers/fake-anthropic.mjs";

function makeClient() {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    session: { prompt: vi.fn().mockResolvedValue(undefined) },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeProvider() {
  return {
    models: {
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        cost: { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
        limit: { context: 200_000, output: 32_000 },
      },
      "claude-sonnet": {
        id: "claude-sonnet",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 8192 },
      },
    },
  };
}

function makeAccount(index, access, overrides = {}) {
  return {
    index,
    email: `account-${index}@example.com`,
    access,
    refreshToken: `refresh-${index}`,
    expires: Date.now() + 3_600_000,
    addedAt: (index + 1) * 1000,
    lastUsed: 0,
    enabled: true,
    disabled: false,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    ...overrides,
  };
}

function makeAccountsData(accounts) {
  return { version: 1, accounts, activeIndex: 0 };
}

function enqueueSuccess(fake) {
  const messageStart = {
    type: "message_start",
    message: {
      id: "msg_retry_injection",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };
  fake.enqueueSSE(
    toSSEFrames([`data: ${JSON.stringify(messageStart)}`, `data: ${JSON.stringify({ type: "message_stop" })}`]),
  );
}

function enqueueError(fake, status, type, message) {
  fake.enqueue({
    status,
    headers: {},
    json: { error: { type, message } },
  });
}

function driveRequest(fetchFn, bodyOverrides = {}) {
  return fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet",
      max_tokens: 64,
      stream: true,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      ...bodyOverrides,
    }),
  });
}

function driveForegroundRequest(fetchFn) {
  return driveRequest(fetchFn, {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8000,
    system: [{ type: "text", text: "You are a helpful assistant." }],
    messages: [{ role: "user", content: "Please help me implement a multi-step feature." }],
  });
}

function authorizationAt(fake, index) {
  return new Headers(fake.calls[index].init.headers).get("authorization");
}

function toastMessages(client, variant) {
  return client.tui.showToast.mock.calls
    .map(([toast]) => toast?.body)
    .filter((body) => !variant || body?.variant === variant)
    .map((body) => body?.message || "");
}

async function setup(accounts) {
  loadAccounts.mockResolvedValue(makeAccountsData(accounts));
  saveAccounts.mockResolvedValue(undefined);

  const fake = createFakeAnthropic();
  vi.stubGlobal("fetch", createViFetch(vi, fake));

  const client = makeClient();
  const first = accounts[0];
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: first.refreshToken,
    access: first.access,
    expires: first.expires,
  });
  const { fetch: fetchFn } = await (await AnthropicAuthPlugin({ client })).auth.loader(getAuth, makeProvider());
  return { client, fake, fetchFn };
}

describe("retry and rotation injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("switches account on an account-specific quota error", async () => {
    const { client, fake, fetchFn } = await setup([makeAccount(0, "access-A"), makeAccount(1, "access-B")]);
    enqueueError(fake, 429, "quota_exhausted", "Account quota exhausted");
    enqueueSuccess(fake);

    const response = await driveRequest(fetchFn);

    expect(fake.calls).toHaveLength(2);
    expect(authorizationAt(fake, 0)).toBe("Bearer access-A");
    expect(authorizationAt(fake, 1)).toBe("Bearer access-B");
    expect(response.status).toBe(200);
    expect(toastMessages(client).some((message) => /quota|switching account/i.test(message))).toBe(true);
  });

  it("switches account on AUTH_FAILED", async () => {
    const { client, fake, fetchFn } = await setup([makeAccount(0, "access-A"), makeAccount(1, "access-B")]);
    enqueueError(fake, 401, "authentication_error", "Invalid authentication credentials");
    enqueueSuccess(fake);

    const response = await driveRequest(fetchFn);

    expect(fake.calls).toHaveLength(2);
    expect(authorizationAt(fake, 0)).toBe("Bearer access-A");
    expect(authorizationAt(fake, 1)).toBe("Bearer access-B");
    expect(response.status).toBe(200);
    expect(toastMessages(client).some((message) => /authentication|switching account/i.test(message))).toBe(true);
  });

  it("retries a 529 on the same account and then succeeds", async () => {
    const { fake, fetchFn } = await setup([makeAccount(0, "access-A")]);
    enqueueError(fake, 529, "overloaded_error", "Overloaded");
    enqueueError(fake, 529, "overloaded_error", "Overloaded");
    enqueueSuccess(fake);
    vi.useFakeTimers();

    const responsePromise = driveForegroundRequest(fetchFn);
    await vi.advanceTimersByTimeAsync(4000);
    const response = await responsePromise;

    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.map((_, index) => authorizationAt(fake, index))).toEqual([
      "Bearer access-A",
      "Bearer access-A",
      "Bearer access-A",
    ]);
    expect(response.status).toBe(200);
  });

  it("surfaces a user-facing overload message when 529s exhaust with no account to switch to", async () => {
    const { client, fake, fetchFn } = await setup([makeAccount(0, "access-A")]);
    enqueueError(fake, 529, "overloaded_error", "Overloaded");
    enqueueError(fake, 529, "overloaded_error", "Overloaded");
    enqueueError(fake, 529, "overloaded_error", "Overloaded");
    vi.useFakeTimers();

    const responsePromise = driveForegroundRequest(fetchFn);
    await vi.advanceTimersByTimeAsync(4000);
    const response = await responsePromise;

    expect(fake.calls).toHaveLength(3);
    expect(response.status).toBe(529);
    expect(toastMessages(client, "error").some((message) => /overload|exhaust/i.test(message))).toBe(true);
  });

  // Pure-529 model fallback is unreachable in the public interceptor because
  // the two service-wide retries are exhausted before its third-529 gate.
  // Wave 3 covers that branch at the extracted overload-loop unit level.
});
