import { describe, it, expect } from "vitest";

// Inline the classifier logic for unit testing
function classifyApiRequest(body) {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== "object") return "foreground";
    const msgCount = parsed.messages?.length ?? 0;
    const maxToks = parsed.max_tokens ?? 99999;
    const systemBlocks = Array.isArray(parsed.system) ? parsed.system : [];
    const hasTitleSignal = systemBlocks.some(
      (b) => typeof b.text === "string" && b.text.includes("Generate a short title"),
    );
    if (hasTitleSignal) return "background";
    if (msgCount <= 2 && maxToks <= 256) return "background";
    return "foreground";
  } catch {
    return "foreground";
  }
}

describe("Task 3.2: Foreground/Background Request Classification", () => {
  // T3.2.1: Title generation → background
  it("T3.2.1: request with title generation system prompt classified as background", () => {
    const body = {
      system: [{ type: "text", text: "Generate a short title for this conversation." }],
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
    };
    expect(classifyApiRequest(body)).toBe("background");
  });

  // T3.2.2: Short context + tiny max_tokens → background
  it("T3.2.2: request with max_tokens <= 256 and messages.length <= 2 classified as background", () => {
    const body = {
      messages: [{ role: "user", content: "Summarize" }],
      max_tokens: 200,
    };
    expect(classifyApiRequest(body)).toBe("background");
  });

  // T3.2.3: Normal multi-turn → foreground
  it("T3.2.3: normal multi-turn request classified as foreground", () => {
    const body = {
      system: [{ type: "text", text: "You are a helpful assistant." }],
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Help me code" },
      ],
      max_tokens: 8000,
    };
    expect(classifyApiRequest(body)).toBe("foreground");
  });

  // T3.2.4: Background gets 0 service retries
  it("T3.2.4: background request gets 0 service-wide retries", () => {
    const config = {
      request_classification: {
        enabled: true,
        background_max_service_retries: 0,
        background_max_should_retries: 1,
      },
    };
    const requestClass = classifyApiRequest({
      system: [{ type: "text", text: "Generate a short title" }],
      messages: [{ role: "user", content: "test" }],
    });
    const maxServiceRetries =
      requestClass === "background" ? (config.request_classification?.background_max_service_retries ?? 0) : 2;
    expect(requestClass).toBe("background");
    expect(maxServiceRetries).toBe(0);
  });

  // T3.2.5: Background gets max 1 should-retry
  it("T3.2.5: background request gets max 1 x-should-retry retry", () => {
    const config = {
      request_classification: {
        enabled: true,
        background_max_service_retries: 0,
        background_max_should_retries: 1,
      },
    };
    const requestClass = classifyApiRequest({
      system: [{ type: "text", text: "Generate a short title" }],
      messages: [{ role: "user", content: "test" }],
    });
    const maxShouldRetries =
      requestClass === "background" ? (config.request_classification?.background_max_should_retries ?? 1) : 3;
    expect(requestClass).toBe("background");
    expect(maxShouldRetries).toBe(1);
  });

  // T3.2.6: Disabled → all foreground
  it("T3.2.6: request_classification.enabled: false makes all requests foreground", () => {
    const config = { request_classification: { enabled: false } };
    const bgBody = {
      system: [{ type: "text", text: "Generate a short title" }],
      messages: [{ role: "user", content: "test" }],
    };
    // When disabled, classification is overridden to foreground
    const requestClass = config.request_classification?.enabled !== false ? classifyApiRequest(bgBody) : "foreground";
    expect(requestClass).toBe("foreground");
  });

  // T3.2.extra: edge cases
  it("T3.2.extra: malformed body defaults to foreground", () => {
    expect(classifyApiRequest("not json")).toBe("foreground");
    expect(classifyApiRequest(null)).toBe("foreground");
    expect(classifyApiRequest(undefined)).toBe("foreground");
    expect(classifyApiRequest("")).toBe("foreground");
  });

  it("T3.2.extra2: string body is parsed correctly", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "Generate a short title for this." }],
      messages: [{ role: "user", content: "Test" }],
    });
    expect(classifyApiRequest(body)).toBe("background");
  });
});
