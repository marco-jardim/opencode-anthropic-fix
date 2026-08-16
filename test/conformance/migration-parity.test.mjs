// MIGRATION PARITY HARNESS (Wave 0, task 0.1.4 of
// docs/plans/wire-compat-consolidation-migration.md).
//
// PURPOSE — this file pins the BYTES the plugin's interceptor puts on the wire
// TODAY, across a matrix of representative requests, so that every phase of the
// wire-compat consolidation migration can be proven wire-neutral. It is the
// central regression instrument for the migration: it must run green after
// EACH phase, unchanged. If a phase moves the wire, this suite fails first and
// loudest, naming the exact JSON paths that moved.
//
// WHAT IT PINS, per vector: the outgoing URL, the full outgoing header set
// (as an alphabetically ordered [name, value] pair list) and the outgoing body
// with the REAL wire key order preserved. Key order matters for mimicry —
// `golden-outgoing.test.mjs` and `shared-package-parity.test.mjs` already pin
// body key order, and this harness follows the same approach: fixtures are
// written with `JSON.stringify(value, null, 2)`, which emits object keys in
// insertion order, and `JSON.parse` preserves the wire's insertion order when
// reading the captured body back. So the fixture file itself is the record of
// the real key sequence, and a reordering shows up as a textual fixture diff
// (and, for values, as a `differingPaths()` entry).
//
// DETERMINISM — every vector is driven through the real interceptor TWICE per
// run and the two captures must be byte-identical AFTER normalization. The
// normalization allowlist is deliberately minimal (see NORMALIZED_PATHS) and
// covers only per-run generated identifiers, the bearer token, and
// host-derived Stainless headers. Normalization is applied BEFORE the fixture
// is written, so the fixture stores the placeholder values and the
// fixture comparison is strict equality with no further exemptions.
//
// RE-SEALING — run with `UPDATE_MIGRATION_BASELINE=1` to rewrite every fixture:
//
//     $env:UPDATE_MIGRATION_BASELINE=1; npx vitest run migration-parity
//
// Re-sealing during the migration means one of two things:
//   (a) a LEGITIMATE wire change (e.g. a deliberate legacy bugfix, or an
//       approved fidelity correction adopted from the shared package). Re-seal,
//       and justify the exact fixture diff in the commit message.
//   (b) an accidental regression. Do NOT re-seal — fix the code.
// Absent `UPDATE_MIGRATION_BASELINE`, the suite compares byte for byte and
// fails with the list of differing paths.
//
// After re-sealing, run `npx prettier --write test/fixtures/migration-baseline`:
// fixtures are written with `JSON.stringify(value, null, 2)`, whose line breaking
// differs from Prettier's, and `prettier --check .` runs on pre-push. This is
// safe because the comparison below reads fixtures through `JSON.parse` — the
// pinned content is the parsed value and the key ORDER, neither of which
// Prettier touches.
//
// LIFECYCLE — this harness is temporary-by-intent for Waves 1-3 and becomes a
// PERMANENT conformance suite at Phase 4.1, at which point the fixtures stop
// being "the legacy output" and start being "the contract".
//
// Infrastructure (module mocks, `driveRequest`, `differingPaths`, the
// generated-path allowlist and the Stainless normalization) is lifted from
// `test/conformance/golden-outgoing.test.mjs` on purpose — no new test infra.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    lockPath: "/tmp/opencode-migration-parity-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

// Per-vector config knobs. `signature_emulation.enabled` is the `_useAdapter`
// switch in index.mjs (adapter path vs legacy forge); `fast_mode` and
// `custom_betas` are the two runtime flags that change the outgoing beta set
// from outside the request body. See docs/plans/wire-compat-migration-baseline.md §1.
// `adaptive_context` is OFF for every vector but 15. That is not cosmetic: with
// `adaptive_context.enabled === false`, `resolveAdaptiveContext` (index.mjs:5165)
// short-circuits to the pure `hasOneMillionContext(model)` predicate and never
// reads or writes the module-level `adaptiveContextState`. So the sticky
// escalation state vector 15 leaves behind cannot reach any other vector, in
// either direction, regardless of execution order.
const testConfig = vi.hoisted(() => ({
  signatureEmulation: true,
  fastMode: false,
  customBetas: [],
  adaptiveContextOverride: {},
}));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      enabled: testConfig.signatureEmulation,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...testConfig.customBetas],
    fast_mode: testConfig.fastMode,
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: {
      ...original.DEFAULT_CONFIG.adaptive_context,
      enabled: false,
      ...testConfig.adaptiveContextOverride,
    },
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

const baselineDir = fileURLToPath(new URL("../fixtures/migration-baseline/", import.meta.url));
const UPDATE_BASELINE = process.env.UPDATE_MIGRATION_BASELINE === "1";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

// Values that legitimately change between two runs of the same input, or that
// must never reach a committed fixture. Each entry is `path -> placeholder`.
// Keep this list minimal: every entry is coverage surrendered.
const NORMALIZED_PATHS = {
  // Per-request generated identifiers (calibrated exactly as in
  // golden-outgoing.test.mjs:65-72 — user_id embeds account/device/session ids).
  "body.metadata.user_id": "<generated>",
  "headers.x-claude-code-session-id": "<generated>",
  "headers.x-client-request-id": "<generated>",
  // Secret material. The suite uses a mock OAuth account ("test-access"), but
  // the placeholder guarantees no token can ever be committed here.
  "headers.authorization": "<redacted>",
  // Host-derived: these encode the machine running the suite, so pinning them
  // literally would make the baseline platform-specific.
  "headers.x-stainless-arch": "<host-arch>",
  "headers.x-stainless-os": "<host-os>",
  "headers.x-stainless-runtime-version": "<host-runtime-version>",
};

function makeClient() {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    session: { prompt: vi.fn().mockResolvedValue(undefined) },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeProvider() {
  const makeModel = (id, input, output, cacheRead, cacheWrite) => ({
    id,
    cost: { input, output, cache: { read: cacheRead, write: cacheWrite } },
    limit: { context: 200_000, output: 32_000 },
  });

  return {
    models: {
      "claude-sonnet-4-5": makeModel("claude-sonnet-4-5", 3, 15, 0.3, 3.75),
      "claude-haiku-4-5": makeModel("claude-haiku-4-5", 1, 5, 0.1, 1.25),
      "claude-opus-4-6": makeModel("claude-opus-4-6", 15, 75, 1.5, 18.75),
      "claude-fable-5": makeModel("claude-fable-5", 3, 15, 0.3, 3.75),
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
  // Truthy here would make `resolveAdaptiveContext` bail before the predicate
  // (index.mjs:5170) and strip experimental betas — pinned explicitly so the
  // baseline never depends on the developer's ambient environment.
  vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
}

function resetTestConfig() {
  testConfig.signatureEmulation = true;
  testConfig.fastMode = false;
  testConfig.customBetas = [];
  testConfig.adaptiveContextOverride = {};
}

/**
 * Drives ONE request through the real plugin interceptor and returns the
 * outgoing wire triple. Mirrors `driveForegroundRequest` in
 * golden-outgoing.test.mjs, parameterized by vector.
 */
async function driveRequest(vector) {
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

  const response = await fetchFn(vector.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(vector.body),
  });
  await response.text();

  const isCountTokens = vector.url.includes("count_tokens");
  const calls = mockFetch.mock.calls.filter(([input]) => {
    const url = String(input);
    return isCountTokens ? url.includes("count_tokens") : url.includes("/messages") && !url.includes("count_tokens");
  });

  if (calls.length !== 1) {
    throw new Error(`Vector "${vector.name}" produced ${calls.length} matching outgoing calls, expected exactly 1`);
  }

  const [input, init] = calls[0];
  if (!init || typeof init.body !== "string") {
    throw new TypeError(`Vector "${vector.name}": expected the interceptor to send a JSON request body`);
  }

  return {
    url: String(input),
    // `Headers` lowercases and alphabetically orders its entries; the explicit
    // sort documents that the fixture ordering is intentional, not incidental.
    headers: Object.fromEntries(
      [...new Headers(init.headers).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    body: JSON.parse(init.body),
  };
}

/** Deep path diff, verbatim from golden-outgoing.test.mjs:145. */
function differingPaths(left, right, path = "") {
  if (Object.is(left, right)) return [];

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) => differingPaths(left[index], right[index], `${path}[${index}]`)).flat();
  }

  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => differingPaths(left[key], right[key], path ? `${path}.${key}` : key));
  }

  return [path];
}

/**
 * Replaces every present normalized path with its stable placeholder. Paths
 * that are absent are skipped rather than asserted: the emulation-off vector
 * legitimately emits only [anthropic-beta, authorization, content-type,
 * user-agent] (docs/plans/wire-compat-migration-baseline.md §1), and count_tokens
 * carries no `metadata`. The absence itself is still pinned by the fixture.
 */
function normalizeOutgoing(outgoing) {
  const normalized = structuredClone(outgoing);

  for (const [path, placeholder] of Object.entries(NORMALIZED_PATHS)) {
    const segments = path.split(".");
    const leaf = segments.pop();
    let cursor = normalized;
    for (const segment of segments) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = cursor[segment];
    }
    if (!cursor || typeof cursor !== "object" || !leaf || !Object.hasOwn(cursor, leaf)) continue;
    cursor[leaf] = placeholder;
  }

  return normalized;
}

/**
 * Replaces any string longer than `limit` with `<large-text:LENGTH:SHA256-16>`.
 *
 * Only vector 15 opts in (`redactStringsLongerThan`). Its payload is ~640 KB of
 * deterministic padding — needed to cross the 150K-token escalation threshold —
 * and writing it verbatim would produce a 640 KB fixture that no reviewer can
 * diff. The redaction does NOT weaken the comparison: the length and a SHA-256
 * prefix are pinned, so any change to the padding (a single character, a
 * truncation, a re-encode) changes the placeholder and fails the fixture. It is
 * also applied strictly AFTER the two-drive determinism gate, which runs on the
 * unredacted captures — so nondeterminism inside the large string still fails.
 */
function redactLongStrings(value, limit) {
  if (typeof value === "string") {
    if (value.length <= limit) return value;
    const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
    return `<large-text:${value.length}:${digest}>`;
  }
  if (Array.isArray(value)) return value.map((entry) => redactLongStrings(entry, limit));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactLongStrings(entry, limit)]));
  }
  return value;
}

/** Fixture-on-disk shape: headers become an ordered pair list. */
function toFixture(normalized) {
  return {
    url: normalized.url,
    headers: Object.entries(normalized.headers),
    body: normalized.body,
  };
}

/** Inverse of `toFixture`, so diffs report `headers.<name>` instead of `headers[7][1]`. */
function fromFixture(fixture) {
  return {
    url: fixture.url,
    headers: Object.fromEntries(fixture.headers),
    body: fixture.body,
  };
}

function fixturePath(name) {
  return `${baselineDir}${name}.json`;
}

function readFixture(name) {
  const path = fixturePath(name);
  if (!existsSync(path)) {
    throw new Error(
      `Missing migration baseline fixture: ${path}\n` +
        `Seal it with: $env:UPDATE_MIGRATION_BASELINE=1; npx vitest run migration-parity`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeFixture(name, fixture) {
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(fixturePath(name), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

const SIMPLE_MESSAGES = [{ role: "user", content: "Hello" }];
const SIMPLE_SYSTEM = "You are a helpful assistant.";

// Deterministic padding for the adaptive-escalation vector (15).
//
// The estimator is a flat 4-chars-per-token heuristic over system + message text
// (lib/token-economy/transforms.mjs:85-125), so crossing the DEFAULT 150_000
// `escalation_threshold` would need >600_000 chars of prompt. That is not
// viable: the shared package rejects the request outright with
// `ClaudeCodeWireError: INPUT_TOO_LARGE (maximumSize=1000000)` before any wire
// is produced (measured — a 640_000-char body fails). So vector 15 lowers
// `escalation_threshold` to 20_000 instead (a user-facing setting; 20_000 is
// exactly the floor `parseConfig` clamps to, lib/config.test.mjs:581) and sends
// ~100_000 chars ≈ 25_000 estimated tokens.
//
// The DECISION CODE exercised is identical either way — `resolveAdaptiveContext`
// runs `isEligibleFor1MContext(model)` and the `estimatedTokens > threshold`
// comparison regardless of the threshold's value. What this vector does not pin
// is the literal 150_000 default, which is config policy, not a models.mjs
// predicate, and therefore outside what Phase 3.1 can break.
//
// Fixed unit, fixed repeat count: nothing here is random or time-dependent.
const ESCALATION_PADDING_UNIT = "The quick brown fox jumps over the lazy dog while auditing the request log.\n";
const ESCALATION_PADDING = ESCALATION_PADDING_UNIT.repeat(Math.ceil(100_000 / ESCALATION_PADDING_UNIT.length));

/**
 * The matrix. One entry == one fixture file. Adding a vector requires re-sealing
 * only that fixture (unsealed fixtures fail loudly rather than silently pass).
 */
const VECTORS = [
  {
    name: "01-simple-sonnet",
    url: MESSAGES_URL,
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    name: "02-tools-sonnet",
    url: MESSAGES_URL,
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: [{ role: "user", content: "Read package.json" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file from disk.",
          input_schema: {
            type: "object",
            properties: { path: { type: "string", description: "Absolute path." } },
            required: ["path"],
          },
        },
        {
          name: "list_dir",
          description: "List a directory.",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "auto" },
    },
  },
  {
    name: "03-streaming-sonnet",
    url: MESSAGES_URL,
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      stream: true,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    name: "04-count-tokens-plain",
    url: COUNT_TOKENS_URL,
    body: {
      model: "claude-sonnet-4-5",
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    // As sealed, this is byte-identical to 04-count-tokens-plain: the
    // count_tokens path does NOT merge `custom_betas` into `anthropic-beta`.
    // That drop is the pinned invariant — if a phase starts forwarding user
    // betas to count_tokens, this fixture fails while 04 stays green.
    name: "05-count-tokens-custom-betas",
    url: COUNT_TOKENS_URL,
    config: { customBetas: ["cache-diagnosis-2026-04-07"] },
    body: {
      model: "claude-sonnet-4-5",
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    // 1M-context path. `context-1m-2025-08-07` is the beta the plugin emits for
    // 1M-eligible models; driving it through `custom_betas` is the only
    // externally actionable trigger that does not require mutating lib/**.
    name: "06-context-1m-sonnet",
    url: MESSAGES_URL,
    config: { customBetas: ["context-1m-2025-08-07"] },
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 64000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    // fast-mode is externally SETTABLE (`config.fast_mode`, forwarded to the
    // adapter as `fastMode` at index.mjs:3047, which is what would emit
    // FAST_MODE_BETA_FLAG per lib/mimicry/headers.mjs:8) — but as sealed it
    // produces ZERO wire delta on sonnet-4-5: this fixture is byte-identical to
    // 01-simple-sonnet. That equality IS the pinned property. If a migration
    // phase starts (or stops) emitting `fast-mode-2026-02-01` for this input,
    // this fixture fails, which is exactly the signal we want. Vector 14 below
    // carries the extra behavioural coverage the matrix would otherwise lose.
    name: "07-fast-mode-sonnet",
    url: MESSAGES_URL,
    config: { fastMode: true },
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    name: "08-custom-betas-sonnet",
    url: MESSAGES_URL,
    config: { customBetas: ["cache-diagnosis-2026-04-07", "interleaved-thinking-2025-05-14"] },
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    // Emulation OFF == the LEGACY forge (`_useAdapter` false). This pins today's
    // half-mimicry: forged claude-cli UA + minimal forged anthropic-beta, and a
    // 4-header set. See docs/plans/wire-compat-migration-baseline.md §1 — Phase 2.2
    // redefining OFF as pure passthrough is a BREAKING change and will require an
    // explicitly justified re-seal of this fixture.
    name: "09-emulation-off-sonnet",
    url: MESSAGES_URL,
    config: { signatureEmulation: false },
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    name: "10-model-haiku",
    url: MESSAGES_URL,
    body: {
      model: "claude-haiku-4-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    name: "11-model-opus",
    url: MESSAGES_URL,
    body: {
      model: "claude-opus-4-6",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    name: "12-model-fable",
    url: MESSAGES_URL,
    body: {
      model: "claude-fable-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    // opencode's real host shape: `system` as an array of text blocks, plus a
    // multi-turn conversation with an assistant turn.
    name: "13-system-array-multiturn-sonnet",
    url: MESSAGES_URL,
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: [
        { type: "text", text: "You are a helpful assistant." },
        { type: "text", text: "Answer concisely." },
      ],
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hi." }] },
        { role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
      ],
      temperature: 1,
    },
  },
  {
    // Extended thinking on an effort-capable model. Exercises
    // `normalizeThinkingBlock` (a Phase 3.1 migration target) and the
    // `effort` -> `output_config.effort` mapping `transformRequestBody` applies
    // on EVERY path (baseline doc §1). As sealed this is byte-identical to
    // 11-model-opus: opus-4-6 already receives a canonical `thinking` block and
    // `output_config.effort: "high"` even when the host sends neither, and an
    // explicit host-supplied `thinking` normalizes onto that same canonical
    // value. That NORMALIZATION-TO-CANONICAL is the pinned property; if a phase
    // starts honouring the host's `budget_tokens` verbatim, this fixture fails
    // while 11 stays green, which localizes the change immediately.
    name: "14-thinking-opus",
    url: MESSAGES_URL,
    body: {
      model: "claude-opus-4-6",
      max_tokens: 8000,
      thinking: { budget_tokens: 4000, type: "enabled" },
      system: SIMPLE_SYSTEM,
      messages: SIMPLE_MESSAGES,
    },
  },
  {
    // NATURAL 1M escalation — the path vector 06 does NOT reach. Vector 06 pins
    // the beta arriving via `custom_betas`, which bypasses the decision entirely.
    // This one drives `resolveAdaptiveContext` (index.mjs:5163-5228, called at
    // :2855) for real: `adaptive_context.enabled`, an eligible model
    // (`isEligibleFor1MContext`), and a prompt over `escalation_threshold`.
    // Cold start (`lastTransitionTurn === 0`, index.mjs:5217) skips the 2-turn
    // hysteresis, so a single large request escalates within that same request.
    //
    // This covers the predicates Phase 3.1 deletes from lib/mimicry/models.mjs
    // (`isEligibleFor1MContext`, `hasOneMillionContext`) through their real
    // caller rather than through a config shortcut.
    //
    // MUST STAY LAST: escalation flips the module-level `adaptiveContextState`
    // to `active: true` and it is never reset between drives. Other vectors are
    // additionally immunized by `adaptive_context.enabled === false` (see the
    // `testConfig` comment), so this is belt-and-braces — but the ordering makes
    // the intent obvious to whoever adds vector 16.
    name: "15-context-1m-adaptive-escalation",
    url: MESSAGES_URL,
    config: {
      adaptiveContextOverride: { enabled: true, escalation_threshold: 20_000, deescalation_threshold: 10_000 },
    },
    redactStringsLongerThan: 4096,
    expectBetaContains: "context-1m-2025-08-07",
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: SIMPLE_SYSTEM,
      messages: [{ role: "user", content: ESCALATION_PADDING }],
    },
  },
];

describe("migration parity baseline", () => {
  beforeAll(async () => {
    // Warm-up drive: the plugin holds module-level singletons (cached CC system
    // prompt, beta latch, fast-mode toast latch). Settling them once up front
    // makes every vector's first drive equal to its second.
    stubRequestEnv();
    resetTestConfig();
    await driveRequest(VECTORS[0]);
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

  it("seals a fixture for every vector (no vector is silently skipped)", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(VECTORS.map((vector) => vector.name)).size).toBe(VECTORS.length);
  });

  for (const vector of VECTORS) {
    it(`pins the outgoing wire for ${vector.name}`, async () => {
      Object.assign(testConfig, vector.config ?? {});

      const first = normalizeOutgoing(await driveRequest(vector));
      const second = normalizeOutgoing(await driveRequest(vector));

      // Determinism gate: after normalization the two drives must be identical.
      // Anything that slips through is a non-deterministic field that either
      // needs a NORMALIZED_PATHS entry (with justification) or is a real bug.
      const nondeterministic = differingPaths(first, second);
      expect(nondeterministic, `non-deterministic outgoing fields in ${vector.name}`).toEqual([]);

      const fixture = toFixture(
        vector.redactStringsLongerThan ? redactLongStrings(first, vector.redactStringsLongerThan) : first,
      );

      if (vector.expectBetaContains) {
        const beta = fixture.headers.find(([name]) => name === "anthropic-beta")?.[1];
        // Proves the beta came from the escalation DECISION, not from
        // `custom_betas` — this vector sends none.
        expect(beta, `${vector.name} must emit ${vector.expectBetaContains}`).toContain(vector.expectBetaContains);
      }

      // Header pairs must be alphabetically ordered so the fixture diff is stable.
      const names = fixture.headers.map(([name]) => name);
      expect(names).toEqual([...names].sort());
      // No secret may reach disk.
      expect(JSON.stringify(fixture)).not.toContain("test-access");
      expect(JSON.stringify(fixture)).not.toContain("test-refresh");

      if (UPDATE_BASELINE) {
        writeFixture(vector.name, fixture);
        return;
      }

      const expected = readFixture(vector.name);
      const drift = differingPaths(fromFixture(expected), fromFixture(fixture));
      expect(drift, `wire drift in ${vector.name} (re-seal only with justification)`).toEqual([]);
      expect(fixture).toEqual(expected);
    });
  }
});
