// ADAPTER-PATH BETA COMPOSITION, END TO END (Phase 3.2 of
// docs/plans/wire-compat-consolidation-migration.md).
//
// PURPOSE — `lib/mimicry/adapter-input.test.mjs` unit-tests `buildAdditionalBetas`
// and `buildSuppressBetas` in isolation: it proves the plugin hands the right
// ADDITIONS and SUPPRESSIONS to `@tormentalabs/claude-code-wire-compat`. It says
// nothing about what the package then DOES with them, because it never runs the
// package. This file closes that gap: every assertion below is made on the
// `anthropic-beta` header captured off the real interceptor's outgoing `fetch`,
// after the package has composed its own beta list and merged the plugin's
// contribution into it.
//
// WHY IT IS SEPARATE FROM migration-parity.test.mjs — that harness pins whole
// wire snapshots to fixture files on disk, and its failure mode is "something
// moved, re-seal or fix". This suite pins named PROPERTIES of the merge
// (additive, deduplicating, suppressible, capped) as inline literals, so a
// failure names the broken property rather than a JSON path. It must never be
// re-sealable: there is no `UPDATE_*` escape hatch here by design.
//
// The module mocks, `makeClient`/`makeProvider`/`makeSuccessResponse`,
// `stubRequestEnv` and `driveRequest` are lifted from
// `test/conformance/migration-parity.test.mjs` on purpose — no new test infra,
// and the two suites therefore drive the interceptor identically.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    lockPath: "/tmp/opencode-adapter-beta-composition-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

// The two knobs this suite varies, and nothing else. `signature_emulation` is
// pinned ON for every case: with it off the interceptor takes the legacy forge
// (lib/mimicry/headers.mjs) and the package never composes anything, which is
// the opposite of what this file exists to cover.
//
// `account_selection_strategy` is the account-rotation setting
// (lib/config.mjs:112, default "sticky"); the adapter reads it as
// `signature.strategy` and derives `isRoundRobin` from it
// (lib/mimicry/adapter-input.mjs:620).
const testConfig = vi.hoisted(() => ({
  customBetas: [],
  strategy: "sticky",
}));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      enabled: true,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...testConfig.customBetas],
    account_selection_strategy: testConfig.strategy,
    fast_mode: false,
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
    token_economy: { ...original.DEFAULT_CONFIG.token_economy, context_hint: false },
  });

  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";
import { MAX_ADDITIONAL_BETAS } from "../../lib/mimicry/adapter-input.mjs";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const REQUEST_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello" }],
};

// The beta set the package composes for the request above, with default config.
//
// PINNED AS AN INLINE LITERAL, DELIBERATELY — not a fixture file. A fixture is
// re-sealable in one command, and the whole value of this constant is that
// changing it requires editing the test and justifying it in review. Order is
// the composer's own emission order and is pinned with it: `anthropic-beta` is
// a list header whose order is part of the fingerprint claim.
const DEFAULT_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "extended-cache-ttl-2025-04-11",
  "web-search-2025-03-05",
  "advisor-tool-2026-03-01",
].join(",");

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
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
    },
  };
}

function makeSuccessResponse() {
  return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function stubRequestEnv() {
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "");
  vi.stubEnv("CLAUDE_CODE_ADDITIONAL_PROTECTION", "");
  vi.stubEnv("CLAUDE_CODE_BACKGROUND", "");
  vi.stubEnv("CLAUDE_CODE_CONTAINER_ID", "");
  vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "");
  // Truthy here would suppress every EXPERIMENTAL_BETA_FLAGS entry
  // (buildSuppressBetas, adapter-input.mjs:500) and silently gut the pinned
  // default set — stubbed empty so the suite never depends on the developer's
  // ambient environment.
  vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
}

function resetTestConfig() {
  testConfig.customBetas = [];
  testConfig.strategy = "sticky";
}

/** Drives ONE request through the real interceptor; returns the outgoing `anthropic-beta`. */
async function driveBetaHeader() {
  const mockFetch = vi.fn(() => Promise.resolve(makeSuccessResponse()));
  vi.stubGlobal("fetch", mockFetch);

  const plugin = await AnthropicAuthPlugin({ client: makeClient() });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 3_600_000,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());

  const response = await fetchFn(MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(REQUEST_BODY),
  });
  await response.text();

  const calls = mockFetch.mock.calls.filter(([input]) => {
    const url = String(input);
    return url.includes("/messages") && !url.includes("count_tokens");
  });
  if (calls.length !== 1) {
    throw new Error(`expected exactly 1 outgoing /v1/messages call, got ${calls.length}`);
  }

  const header = new Headers(calls[0][1].headers).get("anthropic-beta");
  if (typeof header !== "string" || header.length === 0) {
    throw new Error("the adapter path must emit a non-empty anthropic-beta header");
  }
  return header;
}

/** `anthropic-beta` is comma-separated; the package emits ", " but parse defensively. */
function betaList(header) {
  return header.split(",").map((entry) => entry.trim());
}

function countOccurrences(header, beta) {
  return betaList(header).filter((entry) => entry === beta).length;
}

describe("adapter-path beta composition (end to end)", () => {
  beforeAll(async () => {
    // Warm-up drive: the interceptor holds module-level singletons (cached CC
    // system prompt, fast-mode toast latch). Settling them once up front makes
    // the first real drive equal to every later one.
    stubRequestEnv();
    resetTestConfig();
    await driveBetaHeader();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetTestConfig();
    stubRequestEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("composes the pinned default beta set, deterministically", async () => {
    const first = await driveBetaHeader();
    const second = await driveBetaHeader();

    // Determinism first: a header that varies between two identical drives is a
    // bug regardless of what the literal below says.
    expect(second).toBe(first);
    expect(first).toBe(DEFAULT_BETAS);
  });

  it("merges a custom beta additively, keeping the whole default set", async () => {
    // Both are BETA_SHORTCUTS aliases (lib/betas.mjs:85-90), so shortcut
    // resolution is under test too. They are chosen for opposite reasons:
    // `cache-diagnosis` resolves to a beta the package does NOT compose by
    // default, which is what actually proves the merge is additive;
    // `cache-ttl` resolves to one it DOES, so the pair also shows an alias
    // colliding with a composed beta is harmless.
    testConfig.customBetas = ["cache-diagnosis", "cache-ttl"];

    const header = await driveBetaHeader();

    expect(betaList(DEFAULT_BETAS), "precondition: cache-diagnosis must be absent by default").not.toContain(
      "cache-diagnosis-2026-04-07",
    );
    expect(betaList(header)).toContain("cache-diagnosis-2026-04-07");
    expect(betaList(header)).toContain("extended-cache-ttl-2025-04-11");
    // Additive, not replacing: nothing the package composed by default may be
    // dropped just because the user asked for one more.
    for (const beta of betaList(DEFAULT_BETAS)) {
      expect(betaList(header), `custom beta dropped ${beta} from the default set`).toContain(beta);
    }
  });

  it("does not duplicate a custom beta the package already composed", async () => {
    const alreadyComposed = "interleaved-thinking-2025-05-14";
    expect(betaList(DEFAULT_BETAS), "precondition: the default set must already carry this beta").toContain(
      alreadyComposed,
    );

    testConfig.customBetas = [alreadyComposed];

    const header = await driveBetaHeader();

    expect(countOccurrences(header, alreadyComposed)).toBe(1);
  });

  it("suppresses prompt-caching-scope under the round-robin strategy", async () => {
    const suppressed = "prompt-caching-scope-2026-01-05";
    // The pair is the point: suppression is only meaningful if the beta is
    // otherwise present. If this precondition ever fails, the test below would
    // pass vacuously.
    expect(betaList(DEFAULT_BETAS), "precondition: the default set must carry the beta being suppressed").toContain(
      suppressed,
    );

    testConfig.strategy = "round-robin";

    const header = await driveBetaHeader();

    expect(betaList(header)).not.toContain(suppressed);
  });

  // Syntactically valid, semantically meaningless: the cap is a COUNT limit, so
  // it must hold on shape alone without the plugin recognizing any of these.
  const syntheticBetas = (count) =>
    Array.from({ length: count }, (_, index) => `beta-test-${String(index).padStart(2, "0")}-2026-01-01`);

  it("forwards every custom beta while the additional-beta budget has headroom", async () => {
    // Half the ceiling, so the adapter's own `additionalBetas` contribution
    // cannot push the total over it however that contribution changes.
    const customBetas = syntheticBetas(MAX_ADDITIONAL_BETAS / 2);
    testConfig.customBetas = customBetas;

    const header = await driveBetaHeader();

    for (const beta of customBetas) {
      expect(betaList(header), `custom beta ${beta} was silently dropped below the cap`).toContain(beta);
    }
    for (const beta of betaList(DEFAULT_BETAS)) {
      expect(betaList(header), `custom betas dropped ${beta} from the default set`).toContain(beta);
    }
  });

  it("fails loudly rather than silently truncating past the additional-beta cap", async () => {
    // `additionalBetas` accepts at most MAX_ADDITIONAL_BETAS entries and
    // overflow is a hard `INVALID_INPUT` from the package. The plugin
    // deliberately does NOT pre-truncate (lib/mimicry/adapter-input.mjs:123-130):
    // silently discarding a user-configured beta would send a request the user
    // did not ask for, which is a worse failure than refusing to send one.
    //
    // This test exists to keep that decision honest. If someone "fixes" the
    // overflow by clamping the list, this fails — and that is the intended
    // review trigger, not a nuisance.
    expect(syntheticBetas(40).length).toBeGreaterThan(MAX_ADDITIONAL_BETAS);
    testConfig.customBetas = syntheticBetas(40);

    await expect(driveBetaHeader()).rejects.toThrow(/INVALID_INPUT/);
  });
});
