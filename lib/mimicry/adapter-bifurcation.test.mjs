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

describe("buildSystemPromptBlocks — the plugin never composes the canonical prefix", () => {
  it("emits no billing and no identity block", () => {
    const blocks = buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature());
    expect(blocks.filter(isBilling)).toHaveLength(0);
    expect(blocks.filter(isIdentity)).toHaveLength(0);
  });

  it("keeps the rest of the system pipeline running", () => {
    // Anti-verbosity fires for Opus 4.6; it must survive the prefix removal.
    const blocks = buildSystemPromptBlocks(SYSTEM_INPUT, systemSignature({ modelId: "claude-opus-4-6" }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("# Text output (does not apply to tool calls)");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("drops a host block that repeats a canonical prefix text", () => {
    // The package only drops a caller block byte-equal to its identity text,
    // and only while the block stands alone. The host pipeline joins blocks
    // first, so the drop has to happen here or the prefix ships twice.
    const blocks = buildSystemPromptBlocks(
      [
        { type: "text", text: CLAUDE_CODE_IDENTITY_STRING },
        { type: "text", text: `${BILLING_HEADER_PREFIX} cc_version=9.9.9;` },
        ...SYSTEM_INPUT,
      ],
      systemSignature(),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(SYSTEM_INPUT[0].text);
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

/**
 * context_hint used to be injected only when clearing old tool results would
 * reclaim at least ~20K tokens, so the fixture carries several large tool_result
 * blocks followed by a final user turn. The injection is gone, but the fixture
 * is kept exactly as it was: it is the transcript shape that used to trigger it,
 * which makes it the sharpest probe for a regression.
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

function transform(signatureOverrides = {}, taskBudgetsActive = false, body = hostBody()) {
  const out = transformRequestBody(body, bodySignature(signatureOverrides), RUNTIME, taskBudgetsActive, {});
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

// There is no context_hint bifurcation any more: the field is injected on NO
// path. Every input dimension that used to select a branch (legacy vs adapter,
// anthropic vs bedrock, beta present vs absent) is kept, because each one is
// still discriminating as an INPUT even though they now share one expectation —
// a regression would show up on exactly one of them.
describe("transformRequestBody — context_hint is never injected", () => {
  it("does not inject context_hint on the legacy path even with the beta present", () => {
    // The strongest case: the fixture transcript is far above the old 20K-token
    // reclaim threshold, so this is precisely where the field used to appear.
    expect(transform().context_hint).toBeUndefined();
  });

  it("does not inject context_hint on the adapter path", () => {
    expect(transform({ useAdapter: true }).context_hint).toBeUndefined();
  });

  it("does not inject context_hint for a non-anthropic provider", () => {
    expect(transform({ provider: "bedrock" }).context_hint).toBeUndefined();
  });

  it("does not inject context_hint regardless of the task-budgets signal, on either path", () => {
    expect(transform({}, true).context_hint).toBeUndefined();
    expect(transform({ useAdapter: true }, true).context_hint).toBeUndefined();
  });

  it("leaves a caller-supplied context_hint alone rather than overwriting it", () => {
    // Nothing in the plugin writes the field now, so a host that sends its own
    // must still see it untouched — proving removal, not inversion.
    const parsed = transform({}, false, hostBody({ context_hint: { enabled: false } }));
    expect(parsed.context_hint).toEqual({ enabled: false });
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
      const absent = transformRequestBody(hostBody(), bodySignature(overrides), RUNTIME, false, {});
      const explicitFalse = transformRequestBody(
        hostBody(),
        bodySignature({ ...overrides, useAdapter: false }),
        RUNTIME,
        false,
        {},
      );
      expect(explicitFalse).toBe(absent);
    });
  }
});
