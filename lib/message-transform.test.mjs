import { describe, expect, it } from "vitest";
import { staleReadEviction, perToolClassPrune, STALE_READ_TOOLS, REPRODUCIBLE_TOOLS } from "./message-transform.mjs";

/** Build a message with a single tool part. */
function toolMsg(tool, output, { compacted = false, attachments } = {}) {
  return {
    info: { role: "assistant", id: `msg-${Math.random()}` },
    parts: [
      {
        type: "tool",
        callID: "c1",
        tool,
        state: {
          status: "completed",
          input: {},
          output,
          title: "t",
          metadata: {},
          time: { start: 0, end: 1, ...(compacted ? { compacted: 1 } : {}) },
          ...(attachments ? { attachments } : {}),
        },
      },
    ],
  };
}

describe("staleReadEviction", () => {
  it("is a no-op when messages <= threshold", () => {
    const msgs = [toolMsg("read", "content")];
    const { evicted } = staleReadEviction({ messages: msgs, threshold: 10 });
    expect(evicted).toBe(0);
    expect(msgs[0].parts[0].state.output).toBe("content");
  });

  it("replaces read output older than threshold with placeholder", () => {
    const msgs = Array.from({ length: 15 }, (_, i) => toolMsg("read", `file ${i} content`));
    const { evicted } = staleReadEviction({ messages: msgs, threshold: 10 });
    expect(evicted).toBe(5);
    expect(msgs[0].parts[0].state.output).toMatch(/re-read if you need/);
    expect(msgs[4].parts[0].state.output).toMatch(/re-read if you need/);
    expect(msgs[5].parts[0].state.output).toBe("file 5 content");
    expect(msgs[14].parts[0].state.output).toBe("file 14 content");
  });

  it("leaves non-read tools untouched", () => {
    const msgs = Array.from({ length: 15 }, (_, i) => toolMsg("bash", `cmd ${i} output`));
    const { evicted } = staleReadEviction({ messages: msgs, threshold: 10 });
    expect(evicted).toBe(0);
    expect(msgs[0].parts[0].state.output).toBe("cmd 0 output");
  });

  it("skips already-compacted tool parts", () => {
    const msgs = [
      toolMsg("read", "stale but compacted", { compacted: true }),
      ...Array.from({ length: 11 }, (_, i) => toolMsg("read", `x${i}`)),
    ];
    const { evicted } = staleReadEviction({ messages: msgs, threshold: 10 });
    expect(evicted).toBe(1);
    expect(msgs[0].parts[0].state.output).toBe("stale but compacted");
    expect(msgs[1].parts[0].state.output).toMatch(/re-read if you need/);
  });

  it("strips attachments when evicting", () => {
    const msgs = Array.from({ length: 15 }, (_, i) =>
      toolMsg("read", `file ${i}`, {
        attachments: [{ type: "file", mime: "image/png", url: "x" }],
      }),
    );
    staleReadEviction({ messages: msgs, threshold: 10 });
    expect(msgs[0].parts[0].state.attachments).toEqual([]);
    expect(msgs[14].parts[0].state.attachments).toHaveLength(1);
  });

  it("accepts `view` as a read-class tool", () => {
    expect(STALE_READ_TOOLS.has("view")).toBe(true);
    const msgs = Array.from({ length: 15 }, (_, i) => toolMsg("view", `content ${i}`));
    const { evicted } = staleReadEviction({ messages: msgs, threshold: 10 });
    expect(evicted).toBe(5);
  });

  it("handles empty/missing messages gracefully", () => {
    expect(staleReadEviction({ messages: [] }).evicted).toBe(0);
    expect(staleReadEviction({ messages: null }).evicted).toBe(0);
  });
});

describe("perToolClassPrune", () => {
  it("prunes old reproducible outputs over the 10k threshold", () => {
    const output = "x".repeat(30_000); // ~7_500 tokens (chars/4)
    const msgs = Array.from({ length: 3 }, () => toolMsg("read", output));
    const { pruned, tokensSaved } = perToolClassPrune({
      messages: msgs,
      reproducibleThreshold: 10_000,
    });
    // Walk backward: newest (7_500) fits under 10k, older 2 push total over → pruned.
    expect(pruned).toBe(2);
    expect(tokensSaved).toBeGreaterThan(10_000);
    expect(msgs[2].parts[0].state.output).toBe(output); // newest kept
    expect(msgs[0].parts[0].state.output).toBe("");
    expect(msgs[1].parts[0].state.output).toBe("");
  });

  it("uses higher threshold for stateful tools (bash)", () => {
    const mid = "x".repeat(50_000); // ~12_500 tokens
    const msgs = Array.from({ length: 3 }, () => toolMsg("bash", mid));
    const { pruned } = perToolClassPrune({
      messages: msgs,
      statefulThreshold: 40_000,
    });
    // 3 × 12_500 = 37_500 < 40_000 → nothing pruned
    expect(pruned).toBe(0);
  });

  it("never prunes protected tools (skill)", () => {
    const big = "x".repeat(500_000); // ~125_000 tokens — would bust any threshold
    const msgs = Array.from({ length: 3 }, () => toolMsg("skill", big));
    const { pruned } = perToolClassPrune({ messages: msgs });
    expect(pruned).toBe(0);
    expect(msgs[0].parts[0].state.output).toBe(big);
  });

  it("stops walking back when it hits a compacted part", () => {
    const big = "x".repeat(50_000);
    const msgs = [
      toolMsg("read", "must-not-prune-old", { compacted: true }),
      ...Array.from({ length: 3 }, () => toolMsg("read", big)),
    ];
    perToolClassPrune({ messages: msgs, reproducibleThreshold: 10_000 });
    // Compacted sentinel preserved; walk terminates before reaching it.
    expect(msgs[0].parts[0].state.output).toBe("must-not-prune-old");
  });

  it("tracks reproducible and stateful budgets independently", () => {
    const output = "x".repeat(30_000); // ~7_500 tokens each
    // interleave: read, bash, read, bash, read, bash (oldest to newest)
    const msgs = [
      toolMsg("read", output),
      toolMsg("bash", output),
      toolMsg("read", output),
      toolMsg("bash", output),
      toolMsg("read", output),
      toolMsg("bash", output),
    ];
    const { pruned } = perToolClassPrune({
      messages: msgs,
      reproducibleThreshold: 10_000,
      statefulThreshold: 40_000,
    });
    // reads: 7_500, 15_000 → over → prune; 22_500 → prune. 2 old reads pruned.
    // bash:  7_500, 15_000, 22_500 → all under 40k → 0 pruned.
    expect(pruned).toBe(2);
    expect(msgs[4].parts[0].state.output).toBe(output); // newest read kept
    expect(msgs[5].parts[0].state.output).toBe(output); // newest bash kept
    expect(msgs[0].parts[0].state.output).toBe(""); // oldest read pruned
    expect(msgs[2].parts[0].state.output).toBe(""); // middle read pruned
  });

  it("normalizes tool name case when classifying", () => {
    expect(REPRODUCIBLE_TOOLS.has("read")).toBe(true);
    const output = "x".repeat(30_000); // ~7_500 tokens
    const msgs = Array.from({ length: 3 }, () => toolMsg("READ", output));
    const { pruned } = perToolClassPrune({
      messages: msgs,
      reproducibleThreshold: 10_000,
    });
    expect(pruned).toBe(2);
  });

  it("handles empty/missing messages gracefully", () => {
    expect(perToolClassPrune({ messages: [] }).pruned).toBe(0);
    expect(perToolClassPrune({ messages: null }).pruned).toBe(0);
  });
});
