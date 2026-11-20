import { describe, expect, it } from "vitest";
import { MAX_TOOLS_USED, createSessionCorrelation, lastTypedPromptText } from "./session-correlation.mjs";

const typed = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistantUsing = (...names) => ({
  role: "assistant",
  content: names.map((name, i) => ({ type: "tool_use", id: `toolu_${name}_${i}`, name, input: {} })),
});
const toolResult = (id = "toolu_x_0") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

function makeCorrelation() {
  let n = 0;
  return createSessionCorrelation({ randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
}

describe("lastTypedPromptText", () => {
  it("returns the text of a typed last user message, string or blocks", () => {
    expect(lastTypedPromptText([{ role: "user", content: "hello" }])).toBe("hello");
    expect(lastTypedPromptText([typed("a"), assistantUsing("Bash"), typed("b")])).toBe("b");
  });

  it("returns null for tool results, blank text and non-arrays", () => {
    expect(lastTypedPromptText([typed("a"), assistantUsing("Bash"), toolResult()])).toBeNull();
    expect(lastTypedPromptText([{ role: "user", content: "   " }])).toBeNull();
    expect(lastTypedPromptText(undefined)).toBeNull();
    expect(lastTypedPromptText([])).toBeNull();
  });
});

describe("createSessionCorrelation", () => {
  it("starts the first prompt at index 0 / turn 1 with no previous ids and no tools", () => {
    const snapshot = makeCorrelation().begin("s", { messages: [typed("hi")] });
    expect(snapshot).toEqual({
      promptId: "00000000-0000-4000-8000-000000000001",
      promptIndex: 1,
      turnIndex: 1,
      previousRequestId: undefined,
      previousMessageId: undefined,
      toolsUsed: [],
    });
  });

  it("counts tool-result continuations as further turns of the same prompt", () => {
    const c = makeCorrelation();
    const first = c.begin("s", { messages: [typed("do it")] });
    const second = c.begin("s", { messages: [typed("do it"), assistantUsing("Bash"), toolResult()] });
    const third = c.begin("s", {
      messages: [typed("do it"), assistantUsing("Bash"), toolResult(), assistantUsing("Read"), toolResult()],
    });
    expect([first.promptIndex, second.promptIndex, third.promptIndex]).toEqual([1, 1, 1]);
    expect([first.turnIndex, second.turnIndex, third.turnIndex]).toEqual([1, 2, 3]);
    expect(new Set([first.promptId, second.promptId, third.promptId]).size).toBe(1);
  });

  it("starts a new prompt on new typed text: fresh uuid, promptIndex++, turnIndex back to 1", () => {
    const c = makeCorrelation();
    const first = c.begin("s", { messages: [typed("one")] });
    c.begin("s", { messages: [typed("one"), assistantUsing("Bash"), toolResult()] });
    const next = c.begin("s", {
      messages: [typed("one"), assistantUsing("Bash"), toolResult(), assistantUsing(), typed("two")],
    });
    expect(next.promptIndex).toBe(2);
    expect(next.turnIndex).toBe(1);
    expect(next.promptId).not.toBe(first.promptId);
  });

  it("treats a re-send of the same prompt (retry, regenerate) as another turn, not a new prompt", () => {
    const c = makeCorrelation();
    const messages = [typed("same")];
    const first = c.begin("s", { messages });
    const again = c.begin("s", { messages });
    expect(again.promptId).toBe(first.promptId);
    expect(again.promptIndex).toBe(1);
    expect(again.turnIndex).toBe(2);
  });

  it("opens a prompt on the first request even when it is a tool result (resumed conversation)", () => {
    const snapshot = makeCorrelation().begin("s", { messages: [typed("x"), assistantUsing("Bash"), toolResult()] });
    expect(snapshot.promptIndex).toBe(1);
    expect(snapshot.turnIndex).toBe(1);
    expect(snapshot.toolsUsed).toEqual([{ name: "Bash" }]);
  });

  it("keeps sessions independent", () => {
    const c = makeCorrelation();
    c.begin("a", { messages: [typed("one")] });
    c.begin("a", { messages: [typed("one"), assistantUsing("Bash"), toolResult()] });
    const other = c.begin("b", { messages: [typed("hi")] });
    expect(other.promptIndex).toBe(1);
    expect(other.turnIndex).toBe(1);
  });

  it("records distinct tool_use names in first-seen order, flagging mcp__ names, and maps names", () => {
    const c = makeCorrelation();
    const snapshot = c.begin("s", {
      messages: [
        typed("go"),
        assistantUsing("bash", "mcp__srv__lookup", "bash", "read"),
        toolResult(),
        assistantUsing("mcp__srv__lookup", "grep"),
        toolResult(),
      ],
      mapToolName: (name) => ({ bash: "Bash", read: "Read", grep: "Grep" })[name] ?? name,
    });
    expect(snapshot.toolsUsed).toEqual([
      { name: "Bash" },
      { name: "mcp__srv__lookup", mcp: true },
      { name: "Read" },
      { name: "Grep" },
    ]);
  });

  it("keeps tools seen earlier even when the history no longer carries them", () => {
    const c = makeCorrelation();
    c.begin("s", { messages: [typed("a"), assistantUsing("Bash"), toolResult()] });
    const later = c.begin("s", { messages: [typed("b")] });
    expect(later.toolsUsed).toEqual([{ name: "Bash" }]);
  });

  it("bounds toolsUsed and skips names the library would reject", () => {
    const c = makeCorrelation();
    const many = Array.from({ length: MAX_TOOLS_USED + 10 }, (_, i) => `tool_${i}`);
    const snapshot = c.begin("s", {
      messages: [typed("a"), assistantUsing(...many, "x".repeat(300), "caf\u00e9"), toolResult()],
    });
    expect(snapshot.toolsUsed).toHaveLength(MAX_TOOLS_USED);
    expect(snapshot.toolsUsed.map((tool) => tool.name)).not.toContain("x".repeat(300));
    expect(snapshot.toolsUsed.map((tool) => tool.name)).not.toContain("caf\u00e9");
  });

  it("carries the previous request id and message id into the next snapshot", () => {
    const c = makeCorrelation();
    c.begin("s", { messages: [typed("a")] });
    c.recordResponse("s", { requestId: "req_011CAbc123", messageId: "msg_01Xyz789" });
    const next = c.begin("s", { messages: [typed("a"), assistantUsing("Bash"), toolResult()] });
    expect(next.previousRequestId).toBe("req_011CAbc123");
    expect(next.previousMessageId).toBe("msg_01Xyz789");
  });

  it("ignores ids outside the shapes the library accepts", () => {
    const c = makeCorrelation();
    c.begin("s", { messages: [typed("a")] });
    c.recordResponse("s", { requestId: "not-a-request-id", messageId: "bad id" });
    c.recordResponse("s", { requestId: null, messageId: undefined });
    c.recordResponse("never-seen", { requestId: "req_01", messageId: "msg_01" });
    const next = c.begin("s", { messages: [typed("b")] });
    expect(next.previousRequestId).toBeUndefined();
    expect(next.previousMessageId).toBeUndefined();
  });

  it("evicts the least recently used session beyond maxSessions, and forgets on request", () => {
    const c = createSessionCorrelation({ maxSessions: 2 });
    c.begin("a", { messages: [typed("a")] });
    c.begin("b", { messages: [typed("b")] });
    c.begin("a", { messages: [typed("a")] });
    c.begin("c", { messages: [typed("c")] });
    expect(c.size).toBe(2);
    expect(c.begin("b", { messages: [typed("b")] }).promptIndex).toBe(1);
    c.forget("c");
    expect(c.size).toBeLessThanOrEqual(2);
  });
});
