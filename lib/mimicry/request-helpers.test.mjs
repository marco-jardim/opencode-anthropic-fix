import { describe, it, expect, beforeEach } from "vitest";
import {
  repairOrphanedToolUseBlocks,
  stripSlashCommandMessages,
  extractFirstUserMessageText,
  buildRequestMetadata,
  resolveMaxTokens,
} from "./request-helpers.mjs";
import { sessionMetrics } from "../session-metrics.mjs";

describe("repairOrphanedToolUseBlocks", () => {
  it("injects placeholder tool_result into the following user message when missing", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "text", text: "no result here" }] },
    ];
    const out = repairOrphanedToolUseBlocks(messages);
    const userBlocks = out[1].content;
    expect(userBlocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(userBlocks[0].content).toContain("interrupted");
    // original text block preserved after the injected result
    expect(userBlocks.some((b) => b.type === "text")).toBe(true);
  });

  it("synthesizes a user tool_result message when the assistant is the last message", () => {
    const messages = [{ role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] }];
    const out = repairOrphanedToolUseBlocks(messages);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: "user" });
    expect(out[1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t9" });
  });

  it("leaves already-paired tool_use/tool_result untouched", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    const out = repairOrphanedToolUseBlocks(messages);
    expect(out).toEqual(messages);
  });

  it("passes non-array / empty through", () => {
    expect(repairOrphanedToolUseBlocks([])).toEqual([]);
    expect(repairOrphanedToolUseBlocks(null)).toBe(null);
  });
});

describe("stripSlashCommandMessages", () => {
  it("drops a /anthropic command and its ▣ Anthropic response", () => {
    const messages = [
      { role: "user", content: "/anthropic status" },
      { role: "assistant", content: "▣ Anthropic — account 1 active" },
      { role: "user", content: "real question" },
    ];
    const out = stripSlashCommandMessages(messages);
    expect(out).toEqual([{ role: "user", content: "real question" }]);
  });

  it("drops orphaned ▣ Anthropic responses", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "▣ Anthropic done" }] },
      { role: "user", content: "hi" },
    ];
    const out = stripSlashCommandMessages(messages);
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("returns the original array when filtering would remove everything", () => {
    const messages = [{ role: "user", content: "/anthropic login" }];
    expect(stripSlashCommandMessages(messages)).toBe(messages);
  });
});

describe("extractFirstUserMessageText", () => {
  it("returns string content of the first user message", () => {
    expect(extractFirstUserMessageText([{ role: "user", content: "hello" }])).toBe("hello");
  });

  it("returns first text block for array content", () => {
    expect(
      extractFirstUserMessageText([
        { role: "assistant", content: "ignored" },
        { role: "user", content: [{ type: "image" }, { type: "text", text: "found" }] },
      ]),
    ).toBe("found");
  });

  it("returns empty string when no user message", () => {
    expect(extractFirstUserMessageText([{ role: "assistant", content: "x" }])).toBe("");
    expect(extractFirstUserMessageText(null)).toBe("");
  });
});

describe("buildRequestMetadata", () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    delete process.env.CLAUDE_CODE_EXTRA_METADATA;
    process.env = { ...ORIG };
    delete process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID;
    delete process.env.CLAUDE_CODE_EXTRA_METADATA;
  });

  it("encodes device/account/session ids as JSON user_id", () => {
    const md = buildRequestMetadata({ persistentUserId: "dev", accountId: "acct", sessionId: "sess" });
    expect(JSON.parse(md.user_id)).toEqual({ device_id: "dev", account_uuid: "acct", session_id: "sess" });
  });

  it("honors the raw OPENCODE_ANTHROPIC_SIGNATURE_USER_ID override verbatim", () => {
    process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID = "raw-id";
    expect(buildRequestMetadata({ persistentUserId: "d", accountId: "a", sessionId: "s" })).toEqual({
      user_id: "raw-id",
    });
  });

  it("merges CLAUDE_CODE_EXTRA_METADATA object into the encoded user_id", () => {
    process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({ org: "acme" });
    const md = buildRequestMetadata({ persistentUserId: "d", accountId: "a", sessionId: "s" });
    expect(JSON.parse(md.user_id)).toMatchObject({ org: "acme", device_id: "d" });
  });

  it("ignores malformed extra metadata JSON", () => {
    process.env.CLAUDE_CODE_EXTRA_METADATA = "{not json";
    const md = buildRequestMetadata({ persistentUserId: "d", accountId: "a", sessionId: "s" });
    expect(JSON.parse(md.user_id)).toEqual({ device_id: "d", account_uuid: "a", session_id: "s" });
  });
});

describe("resolveMaxTokens", () => {
  beforeEach(() => {
    sessionMetrics.lastStopReason = null;
  });

  it("passes through when output_cap disabled", () => {
    expect(resolveMaxTokens({ max_tokens: 123 }, {})).toBe(123);
  });

  it("honors caller-specified max_tokens even when cap enabled", () => {
    expect(resolveMaxTokens({ max_tokens: 500 }, { output_cap: { enabled: true } })).toBe(500);
  });

  it("uses default_max_tokens when unset and not escalating", () => {
    expect(resolveMaxTokens({}, { output_cap: { enabled: true, default_max_tokens: 8000 } })).toBe(8000);
    expect(resolveMaxTokens({}, { output_cap: { enabled: true } })).toBe(8000);
  });

  it("escalates for exactly one turn after a max_tokens stop, then resets", () => {
    sessionMetrics.lastStopReason = "max_tokens";
    const cfg = { output_cap: { enabled: true, default_max_tokens: 8000, escalated_max_tokens: 64000 } };
    expect(resolveMaxTokens({}, cfg)).toBe(64000);
    // sticky for one turn only
    expect(sessionMetrics.lastStopReason).toBe(null);
    expect(resolveMaxTokens({}, cfg)).toBe(8000);
  });
});
