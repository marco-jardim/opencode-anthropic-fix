// CANONICAL PREFIX — EXACTLY ONCE (Phase 2.3 gate).
//
// Phase 2.3 deleted the Claude Code prompt mimicry from
// `lib/mimicry/system-prompt.mjs`: the plugin no longer builds the billing
// block, no longer selects an identity string, and no longer caches/injects a
// CC prefix for subagent turns. `@tormentalabs/claude-code-wire-compat` is the
// single source of the canonical prefix on the adapter path.
//
// This file is the gate for that claim. It drives the REAL interceptor and
// asserts the property the deletion has to preserve: the canonical Claude Code
// identity text reaches the wire EXACTLY ONCE, whatever the host sent.
//
// The double-injection cases matter because the package's own de-duplication is
// narrow by design (dist/system-prompt.js:164): it drops a caller block only
// when the block is BYTE-EQUAL to `IDENTITY_TEXT` and still standing alone. The
// plugin joins the host blocks onto one cache breakpoint before the package
// sees them, so a host-supplied identity block has to be dropped plugin-side —
// otherwise it survives embedded mid-string and the prefix ships twice.

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
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
    lockPath: "/tmp/opencode-canonical-prefix-once-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      // Emulation ON is the adapter path: the package composes headers + body.
      enabled: true,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: { ...original.DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...(original.DEFAULT_CONFIG.custom_betas || [])],
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
    token_economy: {
      ...original.DEFAULT_CONFIG.token_economy,
      context_hint: false,
      // The lean gate (`adapter-input.mjs:716`) suppresses BOTH canonical blocks
      // for a `title`/`small` turn. A synthetic one-line request classifies as
      // non-main, so leaving it on would make every assertion below vacuous:
      // there would be no prefix to count. This file is about the ordinary turn.
      lean_system_non_main: false,
    },
  });

  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

// PINNED LITERAL, deliberately not imported.
//
// The package owns this string (`IDENTITY_TEXT`, dist/system-prompt.js), but its
// export map does not expose the subpath and the root entry does not re-export
// the constant. Importing it would also make the assertion vacuous: a package
// that silently changed the prefix would still "match itself". Pinning the
// bytes here makes this file an INDEPENDENT oracle — a package-side rename
// fails loudly, right here.
const CANONICAL_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

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

/** Drives one `/v1/messages` request through the real interceptor. */
async function captureOutgoingBody(system) {
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
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: "What is 2+2?" }],
    }),
  });
  await response.text();

  const calls = mockFetch.mock.calls.filter(([input]) => String(input).includes("/v1/messages"));
  if (calls.length !== 1) {
    throw new Error(`expected exactly 1 outgoing /v1/messages call, got ${calls.length}`);
  }
  const [, init] = calls[0];
  return JSON.parse(init.body);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the canonical prefix comes from the package and lands exactly once", () => {
  it("no longer composes the prefix in the plugin", () => {
    // The plugin source must not compose the prefix any more. `system-prompt.mjs`
    // keeps the literal ONLY as a host-policy probe (it strips a duplicated
    // prefix), never as something it emits — so the mimicry entry points are
    // gone from the file entirely.
    //
    // Comments are stripped first, deliberately: the surviving doc comments
    // NAME the deleted functions to explain what replaced them, and that prose
    // is worth keeping. What must not come back is executable code.
    const source = readFileSync(fileURLToPath(new URL("../../lib/mimicry/system-prompt.mjs", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const dead of [
      "getCLISyspromptPrefix",
      "buildAnthropicBillingHeader",
      "computeBillingCacheHash",
      "getCachedCCPrompt",
      "resetCachedCCPrompt",
      "SUBAGENT_CC_ANCHOR",
      "splitSysPromptPrefix",
    ]) {
      expect(source, `${dead} must not survive in system-prompt.mjs`).not.toContain(dead);
    }
  });

  it("emits the prefix exactly once for an ordinary host system prompt", async () => {
    const body = await captureOutgoingBody([{ type: "text", text: "You are a helpful assistant. Be terse." }]);

    const texts = body.system.map((block) => block.text);
    expect(texts.filter((text) => text === CANONICAL_PREFIX)).toHaveLength(1);
    expect(countOccurrences(texts.join("\n"), CANONICAL_PREFIX)).toBe(1);
    // Position is part of the contract: billing block, then identity, then host.
    expect(body.system[1].text).toBe(CANONICAL_PREFIX);
  });

  it("still emits it exactly once when the host already sent the prefix as its own block", async () => {
    const body = await captureOutgoingBody([
      { type: "text", text: CANONICAL_PREFIX },
      { type: "text", text: "You are a helpful assistant. Be terse." },
    ]);

    const texts = body.system.map((block) => block.text);
    expect(texts.filter((text) => text === CANONICAL_PREFIX)).toHaveLength(1);
    expect(countOccurrences(texts.join("\n"), CANONICAL_PREFIX)).toBe(1);
    expect(body.system[1].text).toBe(CANONICAL_PREFIX);
  });

  it("still emits it exactly once when the host block LEADS with the prefix", async () => {
    // The nastier shape: not byte-equal, so the package's own drop cannot see
    // it. `compactSystemText` is what strips it, before the join.
    const body = await captureOutgoingBody([
      { type: "text", text: `${CANONICAL_PREFIX}\nYou are a helpful assistant. Be terse.` },
    ]);

    const texts = body.system.map((block) => block.text);
    expect(texts.filter((text) => text === CANONICAL_PREFIX)).toHaveLength(1);
    expect(countOccurrences(texts.join("\n"), CANONICAL_PREFIX)).toBe(1);
    expect(texts.join("\n")).toContain("You are a helpful assistant. Be terse.");
  });
});
