import { describe, expect, it } from "vitest";
import { prepareV2Tools } from "./tool-names.mjs";
import { createTransformedSSEStream } from "../mimicry/response-stream.mjs";

describe("v2 tool identity", () => {
  it("round-trips renamed tools through the real SSE transform without rewriting tool input", async () => {
    const body = {
      tools: [{ name: "shell" }, { name: "subagent" }, { name: "mcp_custom" }],
      tool_choice: { type: "tool", name: "shell" },
      messages: [{ role: "assistant", content: [{ type: "tool_use", name: "shell", input: { name: "shell" } }] }],
    };
    const prepared = await prepareV2Tools("https://api.anthropic.com/v1/messages", { body: JSON.stringify(body) });
    const result = JSON.parse(prepared.init.body);
    expect(result.tools.map((tool) => tool.name)).toEqual(["bash", "task", "mcp_custom"]);
    expect(result.tool_choice.name).toBe("Bash");
    expect(result.messages[0].content[0]).toEqual({ type: "tool_use", name: "bash", input: { name: "shell" } });
    const input = new Response(
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
    const stream = createTransformedSSEStream(input, { toolNameMap: prepared.toolNameMap, hostCompatShim: false });
    expect(await new Response(stream).text()).toContain('"name":"shell"');
  });

  it("keeps custom bash and task tools distinct from v2 shell and subagent", async () => {
    const result = await prepareV2Tools("https://example.test", {
      body: JSON.stringify({ tools: [{ name: "shell" }, { name: "bash" }, { name: "subagent" }, { name: "task" }] }),
    });
    expect(JSON.parse(result.init.body).tools.map((tool) => tool.name)).toEqual(["shell", "bash", "subagent", "task"]);
    expect(result.toolNameMap.get("bash")).toBe("bash");
  });

  it("rejects ambiguous native and PascalCase names instead of dispatching the wrong tool", async () => {
    await expect(
      prepareV2Tools("https://example.test", { body: JSON.stringify({ tools: [{ name: "bash" }, { name: "Bash" }] }) }),
    ).rejects.toThrow("collide");
  });

  it("lifts a Request body without consuming the caller's body or sharing maps", async () => {
    const request = new Request("https://example.test", { method: "POST", body: '{"tools":[{"name":"shell"}]}' });
    const prepared = await prepareV2Tools(request);
    expect(request.bodyUsed).toBe(false);
    expect(prepared.toolNameMap.get("bash")).toBe("shell");
    const next = await prepareV2Tools("https://example.test", { body: '{"tools":[{"name":"bash"}]}' });
    expect(next.toolNameMap.get("bash")).toBe("bash");
  });
});
