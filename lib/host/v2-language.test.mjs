import { describe, expect, it, vi } from "vitest";
import { adaptV2Language, V2_SDK_PACKAGE } from "./v2-language.mjs";

describe("v2 language boundary", () => {
  it("maps non-streaming finish and reasoning metadata and leaves foreign options intact", async () => {
    const key = V2_SDK_PACKAGE.slice("@ai-sdk/".length);
    const language = {
      specificationVersion: "v3",
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5",
      supportedUrls: {},
      doGenerate: vi.fn(async () => ({
        content: [
          {
            type: "reasoning",
            text: "think",
            providerMetadata: { anthropic: { signature: "sig" }, other: { keep: true } },
          },
          { type: "text", text: "answer" },
        ],
        providerMetadata: { anthropic: { usage: "metadata" } },
      })),
    };
    const wrapped = adaptV2Language(language);
    const result = await wrapped.doGenerate({
      prompt: [
        { role: "system", content: "system", providerOptions: { [key]: { cacheControl: { type: "ephemeral" } } } },
      ],
      providerOptions: { [key]: { effort: "high" }, other: { keep: true } },
    });
    expect(language.doGenerate.mock.calls[0][0]).toMatchObject({
      providerOptions: { anthropic: { effort: "high" }, other: { keep: true } },
      prompt: [{ providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }],
    });
    expect(result.providerMetadata[key]).toEqual({ usage: "metadata" });
    expect(result.content[0].providerMetadata).toEqual({ [key]: { signature: "sig" }, other: { keep: true } });
    expect(result.content[1]).toEqual({ type: "text", text: "answer" });
    expect(wrapped.modelId).toBe(language.modelId);
  });
});
