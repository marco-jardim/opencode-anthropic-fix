/**
 * The adapter bifurcation: three conditional surgeries that must fire ONLY on
 * the adapter path (first-party Anthropic + signature emulation on) and must
 * leave every legacy path byte-identical.
 *
 * The legacy-parity cases here are the anti-regression guarantee for the swap:
 * dropping any of the three unconditionally would break Bedrock/Vertex silently
 * — no error, just a wrong request on the wire.
 */

import { describe, it, expect } from "vitest";
import { buildSystemPromptBlocks, CLAUDE_CODE_IDENTITY_STRING, BILLING_HEADER_PREFIX } from "./system-prompt.mjs";
import { transformRequestBody } from "./request-body.mjs";

const CLI_VERSION = "2.1.195";

function systemSignature(overrides = {}) {
  return {
    enabled: true,
    claudeCliVersion: CLI_VERSION,
    promptCompactionMode: "minimal",
    provider: "anthropic",
    cachePolicy: { ttl: "1h", ttl_supported: true },
    modelId: "claude-sonnet-4-5",
    firstUserMessage: "hello",
    workload: "",
    ...overrides,
  };
}

const SYSTEM_INPUT = [{ type: "text", text: "You are an interactive CLI tool that helps users." }];

function isBilling(block) {
  return typeof block.text === "string" && block.text.startsWith(BILLING_HEADER_PREFIX);
}
function isIdentity(block) {
  return block.text === CLAUDE_CODE_IDENTITY_STRING;
}

// ---------------------------------------------------------------------------
// Surgery 1 — canonical system blocks
// ---------------------------------------------------------------------------

describe("buildSystemPromptBlocks — canonical prefix suppression", () => {
  it("emits the billing and identity blocks on the legacy path", () => {
    const blocks = buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature());
    expect(blocks.filter(isBilling)).toHaveLength(1);
    expect(blocks.filter(isIdentity)).toHaveLength(1);
    expect(isBilling(blocks[0])).toBe(true);
    expect(isIdentity(blocks[1])).toBe(true);
  });

  it("drops exactly the two canonical blocks on the adapter path", () => {
    const legacy = buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature());
    const adapter = buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature({ suppressCanonicalBlocks: true }));

    expect(adapter.filter(isBilling)).toHaveLength(0);
    expect(adapter.filter(isIdentity)).toHaveLength(0);
    expect(adapter).toHaveLength(legacy.length - 2);
    // Everything that is not canonical survives untouched, cache_control included.
    expect(adapter).toEqual(legacy.filter((b) => !isBilling(b) && !isIdentity(b)));
  });

  it("keeps the rest of the system pipeline running on the adapter path", () => {
    // Anti-verbosity fires for Opus 4.6; it must survive the suppression.
    const signature = systemSignature({ modelId: "claude-opus-4-6", suppressCanonicalBlocks: true });
    const adapter = buildSystemPromptBlocks(SYSTEM_INPUT, signature);
    const legacy = buildSystemPromptBlocks(SYSTEM_INPUT, { ...signature, suppressCanonicalBlocks: false });
    expect(adapter.length).toBeGreaterThan(0);
    expect(adapter).toEqual(legacy.filter((b) => !isBilling(b) && !isIdentity(b)));
  });

  it("is a no-op when the flag is absent or false", () => {
    const base = buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature());
    expect(buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature({ suppressCanonicalBlocks: false }))).toEqual(base);
    expect(buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature({ suppressCanonicalBlocks: undefined }))).toEqual(
      base,
    );
  });

  it("never suppresses anything when signature emulation is off", () => {
    // The canonical blocks are not emitted at all in this mode, so the flag
    // cannot change the result. Guards against the suppression leaking.
    const off = systemSignature({ enabled: false });
    expect(buildSystemPromptBlocks(SYSTEM_INPUT, { ...off, suppressCanonicalBlocks: true })).toEqual(
      buildSystemPromptBlocks(SYSTEM_INPUT, off),
    );
  });
});

// ---------------------------------------------------------------------------
// Surgeries 2 and 3 — metadata and context_hint
// ---------------------------------------------------------------------------

const RUNTIME = {
  persistentUserId: "d".repeat(64),
  sessionId: "11111111-1111-4111-8111-111111111111",
  accountId: "33333333-3333-4333-8333-333333333333",
  turns: 0,
  usedTools: new Set(),
};

const CONTEXT_HINT_BETA = "oauth-2025-04-20,context-hint-2026-04-09";

/**
 * context_hint is only injected when clearing old tool results would reclaim at
 * least ~20K tokens, so the fixture carries several large tool_result blocks
 * followed by a final user turn.
 */
function contextHintMessages() {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: {} }] });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(40000) }],
    });
  }
  messages.push({ role: "user", content: "and now summarise" });
  return messages;
}

function hostBody(overrides = {}) {
  return JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: "You are an interactive CLI tool that helps users.",
    messages: contextHintMessages(),
    ...overrides,
  });
}

function bodySignature(overrides = {}) {
  return {
    enabled: true,
    claudeCliVersion: CLI_VERSION,
    promptCompactionMode: "minimal",
    provider: "anthropic",
    cachePolicy: { ttl: "1h", ttl_supported: true },
    ...overrides,
  };
}

function transform(signatureOverrides = {}, betaHeader = CONTEXT_HINT_BETA, body = hostBody()) {
  const out = transformRequestBody(body, bodySignature(signatureOverrides), RUNTIME, betaHeader, {});
  return JSON.parse(out);
}

describe("transformRequestBody — metadata bifurcation", () => {
  it("writes metadata.user_id on the legacy anthropic path", () => {
    const parsed = transform();
    expect(typeof parsed.metadata?.user_id).toBe("string");
    expect(JSON.parse(parsed.metadata.user_id).session_id).toBe(RUNTIME.sessionId);
  });

  it("omits metadata on the adapter path, leaving it to the package", () => {
    expect(transform({ useAdapter: true }).metadata).toBeUndefined();
  });

  it("still writes metadata for a non-anthropic provider", () => {
    // Bedrock/Vertex never reach the adapter, so useAdapter is false for them
    // and buildRequestMetadata must keep running.
    for (const provider of ["bedrock", "vertex"]) {
      const parsed = transform({ provider });
      expect(typeof parsed.metadata?.user_id).toBe("string");
    }
  });

  it("writes no metadata when signature emulation is off, adapter flag notwithstanding", () => {
    expect(transform({ enabled: false }).metadata).toBeUndefined();
  });
});

describe("transformRequestBody — context_hint bifurcation", () => {
  it("injects context_hint on the legacy path when the beta is present", () => {
    const parsed = transform();
    expect(parsed.context_hint).toEqual({ enabled: true });
  });

  it("does not inject context_hint on the adapter path", () => {
    expect(transform({ useAdapter: true }).context_hint).toBeUndefined();
  });

  it("still injects context_hint for a non-anthropic provider", () => {
    expect(transform({ provider: "bedrock" }).context_hint).toEqual({ enabled: true });
  });

  it("does not inject context_hint when the beta is absent, on either path", () => {
    expect(transform({}, "oauth-2025-04-20").context_hint).toBeUndefined();
    expect(transform({ useAdapter: true }, "oauth-2025-04-20").context_hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Legacy byte-identity — the anti-regression guarantee
// ---------------------------------------------------------------------------

describe("transformRequestBody — legacy paths are byte-identical", () => {
  const cases = [
    ["anthropic with mimicry on", {}],
    ["bedrock", { provider: "bedrock" }],
    ["vertex", { provider: "vertex" }],
    ["foundry", { provider: "foundry" }],
    ["mantle", { provider: "mantle" }],
    ["mimicry off", { enabled: false }],
  ];

  for (const [label, overrides] of cases) {
    it(`is unchanged for ${label} when useAdapter is absent vs explicitly false`, () => {
      const absent = transformRequestBody(hostBody(), bodySignature(overrides), RUNTIME, CONTEXT_HINT_BETA, {});
      const explicitFalse = transformRequestBody(
        hostBody(),
        bodySignature({ ...overrides, useAdapter: false }),
        RUNTIME,
        CONTEXT_HINT_BETA,
        {},
      );
      expect(explicitFalse).toBe(absent);
    });
  }
});
