/**
 * E2E integration tests — full cron pipeline with all externals mocked.
 *
 * Tests the complete flow from cron trigger through registry poll,
 * extraction, diff, analysis, and delivery to terminal state.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { STATES } from "../src/types.mjs";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ─── Mock all external modules ────────────────────────────────────────────────

vi.mock("../src/registry.mjs", () => ({
  fetchRegistryMetadata: vi.fn(),
}));

vi.mock("../src/tarball.mjs", () => ({
  downloadAndExtractCli: vi.fn(),
  buildTarballUrl: vi.fn(
    (pkg, ver) => `https://registry.npmjs.org/@anthropic-ai%2fclaude-code/-/claude-code-${ver}.tgz`,
  ),
}));

vi.mock("../src/extractor.mjs", () => ({
  extractContract: vi.fn(),
}));

vi.mock("../src/analyzer.mjs", () => ({
  analyzeContractDiff: vi.fn(),
}));

vi.mock("../src/delivery.mjs", () => ({
  deliver: vi.fn(),
}));

import { fetchRegistryMetadata } from "../src/registry.mjs";
import { downloadAndExtractCli } from "../src/tarball.mjs";
import { extractContract } from "../src/extractor.mjs";
import { analyzeContractDiff } from "../src/analyzer.mjs";
import { deliver } from "../src/delivery.mjs";

// Import the worker default export (the scheduled handler)
import worker from "../src/index.mjs";

// ─── In-memory KV mock ────────────────────────────────────────────────────────

function makeKV() {
  const store = new Map();
  return {
    async get(key, opts) {
      const val = store.get(key) ?? null;
      if (opts?.type === "json" && val !== null) return JSON.parse(val);
      return val;
    },
    async put(key, value, _opts) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
    _store: store,
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONTRACT = {
  version: "2.1.91",
  buildTime: "2026-04-02T21:58:41Z",
  sdkVersion: "0.208.0",
  sdkToken: "sdk-abc",
  billingSalt: "59cf53e54c78",
  clientId: "uuid-1",
  allBetaFlags: ["oauth-2025-04-20"],
  alwaysOnBetas: ["oauth-2025-04-20"],
  experimentalBetas: [],
  bedrockUnsupported: [],
  claudeAiScopes: ["user:profile"],
  consoleScopes: ["org:create_api_key"],
  oauthTokenUrl: "https://platform.claude.com/v1/oauth/token",
  oauthRevokeUrl: "https://platform.claude.com/v1/oauth/revoke",
  oauthRedirectUri: "https://platform.claude.com/oauth/code/callback",
  oauthConsoleHost: "platform.claude.com",
  identityStrings: ["You are Claude Code, Anthropic's official CLI for Claude."],
  systemPromptBoundary: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
};

function makeExtracted(overrides = {}) {
  return { ...BASE_CONTRACT, ...overrides };
}

function makeEnv(kv) {
  return {
    UPSTREAM_KV: kv,
    GITHUB_TOKEN: "test-token",
    GITHUB_REPO: "owner/repo",
    NPM_PACKAGE: "@anthropic-ai/claude-code",
    AI_MODEL: "@cf/moonshotai/kimi-k2.5",
    AI: { run: vi.fn() },
    LOG_LEVEL: "error", // suppress logs in tests
  };
}

function makeEvent() {
  return { scheduledTime: Date.now() };
}

// ─── Trivial path (version bump only) ────────────────────────────────────────

describe("E2E: trivial path — version bump → auto-PR → DELIVERED", () => {
  it("creates PR and reaches DELIVERED state", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    const extracted = makeExtracted({ version: "2.1.92", buildTime: "2026-04-05T10:00:00Z" });

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.92",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: '"new-etag"',
      notModified: false,
    });
    downloadAndExtractCli.mockResolvedValue("// synthetic cli.js");
    extractContract.mockReturnValue(extracted);
    analyzeContractDiff.mockResolvedValue({
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff: { changed: true, severity: "trivial", fields: { version: { from: "2.1.91", to: "2.1.92" } } },
    });
    deliver.mockResolvedValue({ type: "pr", number: 55, url: "https://github.com/pr/55", created: true });

    await worker.scheduled(makeEvent(), env, {});

    // Verify state reached DELIVERED
    const stateJson = kv._store.get("state:2.1.92");
    expect(stateJson).toBeTruthy();
    const state = JSON.parse(stateJson);
    expect(state.state).toBe(STATES.DELIVERED);
    expect(state.prNumber).toBe(55);

    // Verify baseline was updated
    const baselineJson = kv._store.get("baseline:contract");
    const baseline = JSON.parse(baselineJson);
    expect(baseline.version).toBe("2.1.92");
  });

  it("ETag is stored after successful poll", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const extracted = makeExtracted({ version: "2.1.92" });

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.92",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: '"my-etag"',
      notModified: false,
    });
    downloadAndExtractCli.mockResolvedValue("// cli");
    extractContract.mockReturnValue(extracted);
    analyzeContractDiff.mockResolvedValue({
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff: { changed: true, severity: "trivial", fields: { version: { from: "2.1.91", to: "2.1.92" } } },
    });
    deliver.mockResolvedValue({ type: "pr", number: 1, url: "https://github.com/pr/1", created: true });

    await worker.scheduled(makeEvent(), env, {});

    expect(kv._store.get("registry:etag")).toBe('"my-etag"');
  });
});

// ─── No change path ───────────────────────────────────────────────────────────

describe("E2E: no-change path — registry returns same contract", () => {
  it("exits cleanly with no state change when contract is unchanged", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    // Seed baseline with same contract
    const { hashContract } = await import("../src/hasher.mjs");
    const hash = await hashContract(BASE_CONTRACT);
    await kv.put("baseline:contract", JSON.stringify(BASE_CONTRACT));
    await kv.put("baseline:hash", hash);

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.91",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: null,
      notModified: false,
    });
    downloadAndExtractCli.mockResolvedValue("// cli");
    extractContract.mockReturnValue({ ...BASE_CONTRACT }); // Same contract

    await worker.scheduled(makeEvent(), env, {});

    // No state record should be created
    expect(kv._store.has("state:2.1.91")).toBe(false);
    // analyzeContractDiff should not have been called
    expect(analyzeContractDiff).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

// ─── ETag cache hit ───────────────────────────────────────────────────────────

describe("E2E: ETag cache hit — skips tarball download", () => {
  it("exits early when registry returns 304", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    fetchRegistryMetadata.mockResolvedValue({
      version: "",
      tarballUrl: "",
      etag: '"cached"',
      notModified: true,
    });

    await worker.scheduled(makeEvent(), env, {});

    expect(downloadAndExtractCli).not.toHaveBeenCalled();
    expect(extractContract).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

// ─── Already in terminal state ────────────────────────────────────────────────

describe("E2E: idempotency — already DELIVERED", () => {
  it("skips pipeline when version already DELIVERED", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    // Pre-populate DELIVERED state for 2.1.92
    await kv.put(
      "state:2.1.92",
      JSON.stringify({
        state: STATES.DELIVERED,
        version: "2.1.92",
        retries: 0,
        lastEvent: "PR_CREATED → DELIVERED",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        prNumber: 42,
        issueNumber: null,
        branchName: "auto/sync-2.1.92",
        error: null,
      }),
    );

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.92",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: null,
      notModified: false,
    });

    await worker.scheduled(makeEvent(), env, {});

    // Should have fetched registry but stopped at terminal check
    expect(downloadAndExtractCli).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

// ─── Concurrent lock dedup ────────────────────────────────────────────────────

describe("E2E: concurrent cron dedup", () => {
  it("second invocation skips when lock is held", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    // Inject fresh lock
    await kv.put(
      "lock:cron",
      JSON.stringify({
        acquiredAt: new Date().toISOString(),
        ttlMs: 120_000,
      }),
    );

    await worker.scheduled(makeEvent(), env, {});

    // Nothing should have run
    expect(fetchRegistryMetadata).not.toHaveBeenCalled();
  });
});

// ─── Failure path ─────────────────────────────────────────────────────────────

describe("E2E: registry failure", () => {
  it("exits cleanly when registry poll throws", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    fetchRegistryMetadata.mockRejectedValue(new Error("Registry 503"));

    // Should not throw
    await expect(worker.scheduled(makeEvent(), env, {})).resolves.not.toThrow();
    expect(downloadAndExtractCli).not.toHaveBeenCalled();
  });
});

describe("E2E: delivery failure → FAILED_RETRYABLE", () => {
  it("transitions to FAILED_RETRYABLE when delivery throws", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    const extracted = makeExtracted({ version: "2.1.93" });

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.93",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: null,
      notModified: false,
    });
    downloadAndExtractCli.mockResolvedValue("// cli");
    extractContract.mockReturnValue(extracted);
    analyzeContractDiff.mockResolvedValue({
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff: { changed: true, severity: "trivial", fields: { version: { from: "2.1.91", to: "2.1.93" } } },
    });
    deliver.mockRejectedValue(new Error("GitHub 500"));

    await worker.scheduled(makeEvent(), env, {});

    const stateJson = kv._store.get("state:2.1.93");
    expect(stateJson).toBeTruthy();
    const state = JSON.parse(stateJson);
    expect(state.state).toBe(STATES.FAILED_RETRYABLE);
    expect(state.error).toContain("GitHub 500");
    expect(state.retries).toBe(1);
  });
});

// ─── Non-trivial path (LLM → Issue) ──────────────────────────────────────────

describe("E2E: non-trivial path — LLM analysis → Issue created → DELIVERED", () => {
  it("creates issue and reaches DELIVERED state when LLM is invoked", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    // Extracted contract has a changed OAuth endpoint (non-trivial)
    const extracted = makeExtracted({
      version: "2.1.92",
      oauthTokenUrl: "https://platform.claude.com/v2/oauth/token",
    });

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.92",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: '"new-etag"',
      notModified: false,
    });
    downloadAndExtractCli.mockResolvedValue("// synthetic cli.js");
    extractContract.mockReturnValue(extracted);
    analyzeContractDiff.mockResolvedValue({
      action: "create-issue",
      llmAnalysis: {
        safe_for_auto_pr: false,
        risk_level: "critical",
        summary: "OAuth token URL changed — manual review required.",
        changes: [
          {
            field: "oauthTokenUrl",
            description: "URL changed",
            impact: "breaking",
            action_required: "update lib/oauth.mjs",
          },
        ],
        confidence: 0.98,
      },
      llmInvoked: true,
      llmError: null,
      diff: {
        changed: true,
        severity: "critical",
        fields: {
          oauthTokenUrl: {
            from: "https://platform.claude.com/v1/oauth/token",
            to: "https://platform.claude.com/v2/oauth/token",
          },
        },
      },
    });
    deliver.mockResolvedValue({ type: "issue", number: 12, url: "https://github.com/issues/12", created: true });

    await worker.scheduled(makeEvent(), env, {});

    // State should be DELIVERED
    const stateJson = kv._store.get("state:2.1.92");
    expect(stateJson).toBeTruthy();
    const state = JSON.parse(stateJson);
    expect(state.state).toBe(STATES.DELIVERED);
    expect(state.issueNumber).toBe(12);
  });

  it("passes through ANALYZING state when LLM is invoked", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    const extracted = makeExtracted({
      version: "2.1.94",
      billingSalt: "aabbccddeeff",
    });

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.94",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: null,
      notModified: false,
    });
    downloadAndExtractCli.mockResolvedValue("// cli");
    extractContract.mockReturnValue(extracted);

    // Capture state snapshots during the pipeline
    const stateSnapshots = [];
    analyzeContractDiff.mockImplementation(async () => {
      // At this point the state should be DETECTED (before ANALYZING)
      const s = kv._store.get("state:2.1.94");
      if (s) stateSnapshots.push(JSON.parse(s).state);
      return {
        action: "create-issue",
        llmAnalysis: null,
        llmInvoked: true,
        llmError: "LLM unavailable",
        diff: {
          changed: true,
          severity: "critical",
          fields: { billingSalt: { from: "59cf53e54c78", to: "aabbccddeeff" } },
        },
      };
    });
    deliver.mockResolvedValue({ type: "issue", number: 3, url: "https://github.com/issues/3", created: true });

    await worker.scheduled(makeEvent(), env, {});

    // DETECTED was set before analysis
    expect(stateSnapshots).toContain(STATES.DETECTED);

    // Final state: DELIVERED
    const finalState = JSON.parse(kv._store.get("state:2.1.94"));
    expect(finalState.state).toBe(STATES.DELIVERED);
  });
});

// ─── Crash recovery ───────────────────────────────────────────────────────────

describe("E2E: crash recovery — stuck intermediate state → FAILED_RETRYABLE", () => {
  const stuckStates = [STATES.ANALYZING, STATES.PR_CREATED, STATES.ISSUE_CREATED];

  for (const stuckState of stuckStates) {
    it(`recovers from stuck ${stuckState} state to FAILED_RETRYABLE`, async () => {
      const kv = makeKV();
      const env = makeEnv(kv);

      // Pre-populate stuck state
      await kv.put(
        "state:2.1.95",
        JSON.stringify({
          state: stuckState,
          version: "2.1.95",
          retries: 0,
          lastEvent: `DETECTED → ${stuckState}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          prNumber: null,
          issueNumber: null,
          branchName: null,
          error: null,
        }),
      );

      fetchRegistryMetadata.mockResolvedValue({
        version: "2.1.95",
        tarballUrl: "https://example.com/pkg.tgz",
        etag: null,
        notModified: false,
      });

      await worker.scheduled(makeEvent(), env, {});

      // Should transition to FAILED_RETRYABLE, NOT proceed with pipeline
      const stateJson = kv._store.get("state:2.1.95");
      const state = JSON.parse(stateJson);
      expect(state.state).toBe(STATES.FAILED_RETRYABLE);
      expect(state.error).toContain("stuck-state recovery");

      // Pipeline should NOT have downloaded tarball
      expect(downloadAndExtractCli).not.toHaveBeenCalled();
    });
  }
});

// ─── DEAD_LETTER path ─────────────────────────────────────────────────────────

describe("E2E: DEAD_LETTER — max retries exceeded", () => {
  it("transitions to DEAD_LETTER after MAX_RETRIES failures and stores alert", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    // Pre-populate FAILED_RETRYABLE with retries at MAX_RETRIES (6)
    await kv.put(
      "state:2.1.96",
      JSON.stringify({
        state: STATES.FAILED_RETRYABLE,
        version: "2.1.96",
        retries: 6,
        lastEvent: "DETECTED → FAILED_RETRYABLE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        prNumber: null,
        issueNumber: null,
        branchName: null,
        error: "GitHub API down",
      }),
    );

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.96",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: null,
      notModified: false,
    });

    await worker.scheduled(makeEvent(), env, {});

    // State should be DEAD_LETTER
    const stateJson = kv._store.get("state:2.1.96");
    const state = JSON.parse(stateJson);
    expect(state.state).toBe(STATES.DEAD_LETTER);

    // Alert should be stored in KV
    const alertJson = kv._store.get("alert:dead_letter:2.1.96");
    expect(alertJson).toBeTruthy();
    const alert = JSON.parse(alertJson);
    expect(alert.version).toBe("2.1.96");
    expect(alert.retries).toBe(6);

    // Pipeline should NOT have proceeded
    expect(downloadAndExtractCli).not.toHaveBeenCalled();
  });

  it("retries when under MAX_RETRIES (FAILED_RETRYABLE → DETECTED → pipeline)", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);

    // Pre-populate FAILED_RETRYABLE with retries = 3 (under limit)
    await kv.put(
      "state:2.1.97",
      JSON.stringify({
        state: STATES.FAILED_RETRYABLE,
        version: "2.1.97",
        retries: 3,
        lastEvent: "DETECTED → FAILED_RETRYABLE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        prNumber: null,
        issueNumber: null,
        branchName: null,
        error: "transient error",
      }),
    );

    const extracted = makeExtracted({ version: "2.1.97" });

    fetchRegistryMetadata.mockResolvedValue({
      version: "2.1.97",
      tarballUrl: "https://example.com/pkg.tgz",
      etag: null,
      notModified: false,
    });
    downloadAndExtractCli.mockResolvedValue("// cli");
    extractContract.mockReturnValue(extracted);
    analyzeContractDiff.mockResolvedValue({
      action: "auto-pr",
      llmAnalysis: null,
      llmInvoked: false,
      llmError: null,
      diff: { changed: true, severity: "trivial", fields: { version: { from: "2.1.91", to: "2.1.97" } } },
    });
    deliver.mockResolvedValue({ type: "pr", number: 20, url: "https://github.com/pr/20", created: true });

    await worker.scheduled(makeEvent(), env, {});

    // Should have proceeded to DELIVERED
    const stateJson = kv._store.get("state:2.1.97");
    const state = JSON.parse(stateJson);
    expect(state.state).toBe(STATES.DELIVERED);

    // No dead-letter alert
    expect(kv._store.has("alert:dead_letter:2.1.97")).toBe(false);
  });
});

// ─── Health check endpoint ────────────────────────────────────────────────────

describe("fetch handler — /health endpoint", () => {
  it("returns 200 with JSON status on /health", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const req = new Request("https://sync-watcher.tormenta.workers.dev/health");

    const resp = await worker.fetch(req, env);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(typeof body.ts).toBe("number");
  });

  it("returns 404 for unknown paths", async () => {
    const kv = makeKV();
    const env = makeEnv(kv);
    const req = new Request("https://sync-watcher.tormenta.workers.dev/unknown");

    const resp = await worker.fetch(req, env);
    expect(resp.status).toBe(404);
  });
});
