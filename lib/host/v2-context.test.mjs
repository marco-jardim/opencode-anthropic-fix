import { describe, expect, it } from "vitest";
import { applyV2MessagePolicies, assertPortableV2History } from "./v2-context.mjs";

const result = (name, value) => ({
  type: "tool-result",
  name,
  id: "call-id",
  result: { type: "text", value },
  metadata: { keep: true },
});
describe("v2 context policies", () => {
  it("preserves complete messages by default, including unknown metadata and typed content", () => {
    const messages = [{ role: "tool", content: [result("read", "original")], metadata: { custom: 42 } }];
    const original = structuredClone(messages);
    applyV2MessagePolicies(messages);
    expect(messages).toEqual(original);
  });

  it("evicts only stale reads while retaining call identity and recent multimodal results", () => {
    const old = result("read", "old output");
    const recent = {
      ...result("read", ""),
      result: {
        type: "content",
        value: [
          { type: "text", text: "text" },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
      },
    };
    const messages = [
      { role: "tool", content: [old] },
      ...Array.from({ length: 10 }, () => ({ role: "user", content: [{ type: "text", text: "next" }] })),
      { role: "tool", content: [recent] },
    ];
    const originalRecent = recent.result;
    applyV2MessagePolicies(messages, { stale_read_eviction: true });
    expect(old.result.value).toContain("re-read");
    expect(old).toMatchObject({ id: "call-id", name: "read", metadata: { keep: true } });
    expect(recent.result).toBe(originalRecent);
  });

  it("keeps protected skills and errors when per-class pruning removes older reproducible output", () => {
    const old = result("read", "old");
    const skill = result("skill", "important");
    const failure = { ...result("read", ""), result: { type: "error", value: "failed" } };
    const messages = [
      { role: "tool", content: [old, skill, failure] },
      { role: "tool", content: [result("read", "x".repeat(40000))] },
    ];
    applyV2MessagePolicies(messages, { per_tool_class_prune: true });
    expect(old.result.value).toBe("");
    expect(skill.result.value).toBe("important");
    expect(failure.result).toEqual({ type: "error", value: "failed" });
  });

  it("refuses opaque native checkpoints without mutating history", () => {
    const messages = [{ role: "assistant", content: [{ type: "compaction", encrypted: "opaque" }] }];
    const original = structuredClone(messages);
    expect(() => assertPortableV2History(messages)).toThrow("native provider compaction");
    expect(messages).toEqual(original);
  });
});
