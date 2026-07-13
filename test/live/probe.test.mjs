import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

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
    lockPath: "/tmp/opencode-replay-test.lock",
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
import { createFakeAnthropic, createViFetch } from "../helpers/fake-anthropic.mjs";
import { loadFixture, replayThroughInterceptor } from "../helpers/replay.mjs";

const fixturePath = fileURLToPath(new URL("../fixtures/requests/plugin-001-messages.json", import.meta.url));

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

describe("live-probe smoke test", () => {
  let fake;
  let fetchFn;

  beforeEach(async () => {
    vi.clearAllMocks();
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);

    fake = createFakeAnthropic();
    vi.stubGlobal("fetch", createViFetch(vi, fake));

    const plugin = await AnthropicAuthPlugin({ client: makeClient() });
    const getAuth = vi.fn().mockResolvedValue({
      type: "oauth",
      refresh: "test-refresh",
      access: "test-access",
      expires: Date.now() + 3_600_000,
    });
    ({ fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider()));
  });

  afterEach(() => {
    fake.reset();
    vi.unstubAllGlobals();
  });

  it("DEFAULT: replays a recorded response through the extracted mimicry (no creds needed)", async () => {
    const out = await replayThroughInterceptor(loadFixture(fixturePath), { fetchFn, fake });

    expect(out.response.status).toBe(200);
    expect(out.response.text).toContain("write_file");
    expect(out.response.text).not.toContain("mcp_write_file");
    expect(out.outgoing.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(out.outgoing.headers.authorization).toBe("Bearer test-access");
  });

  it.skipIf(!process.env.RUN_LIVE_PROBE)("LIVE: sends one real request and asserts 200", async () => {
    vi.unstubAllGlobals();
    vi.doUnmock("../../lib/storage.mjs");
    const { runLiveProbe } = await import("../../scripts/live-probe.mjs");
    const res = await runLiveProbe();

    if (res.skipped) {
      console.warn("live probe skipped:", res.reason);
      return;
    }

    expect(res.status).toBe(200);
  });
});
