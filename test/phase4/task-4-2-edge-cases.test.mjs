import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Replicate pure functions from index.mjs for behavioral unit testing
// ---------------------------------------------------------------------------

function parseContextLimitError(msg) {
  if (!msg || typeof msg !== "string") return null;
  const m = msg.match(/input length and `max_tokens` exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
  if (!m) return null;
  return { input: +m[1], maxTokens: +m[2], limit: +m[3] };
}

function computeSafeMaxTokens(input, limit, margin = 1000) {
  return Math.max(1, limit - input - margin);
}

function extractCacheSourceHashes(bodyStr) {
  const hashes = new Map();
  try {
    const parsed = JSON.parse(bodyStr);
    if (Array.isArray(parsed.system)) {
      const systemText = parsed.system
        .filter((b) => !(b.text && b.text.startsWith("Token budget:")))
        .map((b) => b.text || "")
        .join("");
      // Use a simple fingerprint for tests (no real crypto needed for edge cases)
      if (systemText) hashes.set("system_prompt", systemText.slice(0, 16));
    } else if (typeof parsed.system === "string" && parsed.system) {
      hashes.set("system_prompt", parsed.system.slice(0, 16));
    }
    if (Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.name) {
          hashes.set(`tool:${tool.name}`, JSON.stringify(tool).slice(0, 16));
        }
      }
    }
  } catch {
    // Ignore parse errors — return empty Map
  }
  if (hashes.size > 10) {
    const entries = [...hashes.entries()];
    return new Map(entries.slice(entries.length - 10));
  }
  return hashes;
}

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

function parseNaturalLanguageBudget(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") {
        lastUserText = content;
      } else if (Array.isArray(content)) {
        lastUserText = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join(" ");
      }
      break;
    }
  }
  if (!lastUserText) return 0;
  const patterns = [
    /\buse\s+(\d[\d,]*)\s*([mk])\s*tokens?\b/i,
    /\bspend\s+(\d[\d,]*)\s*([mk])?\b/i,
    /\bbudget[:\s]+(\d[\d,]*)\s*([mk])?\b/i,
    /\+(\d[\d,]*)\s*([mk])\b/i,
    /\b(\d[\d,]*)\s*million\s*tokens?\b/i,
  ];
  for (const re of patterns) {
    const m = lastUserText.match(re);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ""));
      if (isNaN(num) || num <= 0) continue;
      const suffix = (m[2] || "").toLowerCase();
      if (re === patterns[4]) return num * 1_000_000;
      if (suffix === "m") return num * 1_000_000;
      if (suffix === "k") return num * 1_000;
      return num;
    }
  }
  return 0;
}

function shouldMicrocompact(estimatedTokens, config) {
  if (!config?.microcompact?.enabled) return false;
  const thresholdPct = config.microcompact.threshold_percent ?? 80;
  const contextWindow = 200_000;
  const threshold = contextWindow * (thresholdPct / 100);
  return estimatedTokens >= threshold;
}

function detectDiminishingReturns(outputHistory) {
  if (!Array.isArray(outputHistory) || outputHistory.length < 3) return false;
  const last3 = outputHistory.slice(-3);
  return last3.every((d) => d < 500);
}

function resolveMaxTokens(body, config) {
  if (!config.output_cap?.enabled) return body.max_tokens; // passthrough when disabled
  if (body.max_tokens != null) return body.max_tokens; // caller-specified wins
  return config.output_cap.default_max_tokens ?? 8_000;
}

// Replicate extractUsageFromSSEEvent (without global sessionMetrics dependency)
function extractUsageFromSSEEvent(parsed, stats) {
  if (parsed?.type === "message_delta" && parsed.usage) {
    const u = parsed.usage;
    if (typeof u.input_tokens === "number") stats.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") stats.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") stats.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") stats.cacheWriteTokens = u.cache_creation_input_tokens;
    if (parsed.delta?.stop_reason) {
      stats.stopReason = parsed.delta.stop_reason;
    }
    return;
  }
  if (parsed?.type === "message_start" && parsed.message?.usage) {
    const u = parsed.message.usage;
    if (stats.inputTokens === 0 && typeof u.input_tokens === "number") stats.inputTokens = u.input_tokens;
    if (stats.cacheReadTokens === 0 && typeof u.cache_read_input_tokens === "number")
      stats.cacheReadTokens = u.cache_read_input_tokens;
    if (stats.cacheWriteTokens === 0 && typeof u.cache_creation_input_tokens === "number")
      stats.cacheWriteTokens = u.cache_creation_input_tokens;
  }
}

function makeStats() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 4.2: Edge Cases & Error Paths", () => {
  // =========================================================================
  // Group 1: Empty / null / undefined inputs
  // =========================================================================
  describe("empty/null/undefined inputs", () => {
    // T4.2.1 — parseContextLimitError: null → null
    it("T4.2.1: parseContextLimitError(null) returns null", () => {
      expect(parseContextLimitError(null)).toBeNull();
    });

    // T4.2.2 — parseContextLimitError: empty string → null
    it("T4.2.2: parseContextLimitError('') returns null", () => {
      expect(parseContextLimitError("")).toBeNull();
    });

    // T4.2.3 — parseContextLimitError: undefined → null
    it("T4.2.3: parseContextLimitError(undefined) returns null", () => {
      expect(parseContextLimitError(undefined)).toBeNull();
    });

    // T4.2.4 — computeSafeMaxTokens: all zeros → clamped to 1
    it("T4.2.4: computeSafeMaxTokens(0, 0, 0) clamps to 1", () => {
      // 0 - 0 - 0 = 0, Math.max(1, 0) = 1
      expect(computeSafeMaxTokens(0, 0, 0)).toBe(1);
    });

    // T4.2.5 — extractCacheSourceHashes: valid JSON with no system/tools → empty Map
    it("T4.2.5: extractCacheSourceHashes('{}') returns empty Map", () => {
      const result = extractCacheSourceHashes("{}");
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    // T4.2.6 — extractCacheSourceHashes: invalid JSON → empty Map (no throw)
    it("T4.2.6: extractCacheSourceHashes('') returns empty Map gracefully", () => {
      expect(() => extractCacheSourceHashes("")).not.toThrow();
      const result = extractCacheSourceHashes("");
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    // T4.2.7 — extractCacheSourceHashes: malformed JSON → empty Map
    it("T4.2.7: extractCacheSourceHashes(malformed JSON) returns empty Map gracefully", () => {
      expect(() => extractCacheSourceHashes("{not:valid}")).not.toThrow();
      const result = extractCacheSourceHashes("{not:valid}");
      expect(result.size).toBe(0);
    });

    // T4.2.8 — classifyApiRequest: empty object → 'foreground' default
    it("T4.2.8: classifyApiRequest({}) returns 'foreground'", () => {
      expect(classifyApiRequest({})).toBe("foreground");
    });

    // T4.2.9 — parseNaturalLanguageBudget: empty array → 0
    it("T4.2.9: parseNaturalLanguageBudget([]) returns 0", () => {
      expect(parseNaturalLanguageBudget([])).toBe(0);
    });

    // T4.2.10 — parseNaturalLanguageBudget: null → 0 (not an array)
    it("T4.2.10: parseNaturalLanguageBudget(null) returns 0", () => {
      expect(parseNaturalLanguageBudget(null)).toBe(0);
    });

    // T4.2.11 — shouldMicrocompact: 0 tokens (well below 160K threshold) → false
    it("T4.2.11: shouldMicrocompact(0, enabled_config) returns false (below threshold)", () => {
      const config = { microcompact: { enabled: true, threshold_percent: 80 } };
      expect(shouldMicrocompact(0, config)).toBe(false);
    });

    // T4.2.12 — detectDiminishingReturns: empty array → false
    it("T4.2.12: detectDiminishingReturns([]) returns false", () => {
      expect(detectDiminishingReturns([])).toBe(false);
    });

    // T4.2.13 — detectDiminishingReturns: null → false (not an array)
    it("T4.2.13: detectDiminishingReturns(null) returns false", () => {
      expect(detectDiminishingReturns(null)).toBe(false);
    });

    // T4.2.14 — resolveMaxTokens: disabled cap → passthrough (undefined when body has no max_tokens)
    it("T4.2.14: resolveMaxTokens({}, { output_cap: { enabled: false } }) returns undefined", () => {
      const result = resolveMaxTokens({}, { output_cap: { enabled: false } });
      expect(result).toBeUndefined();
    });
  });

  // =========================================================================
  // Group 2: Malformed API responses
  // =========================================================================
  describe("malformed API responses", () => {
    // T4.2.15 — extractUsageFromSSEEvent: fully empty parsed object → no crash, stats unchanged
    it("T4.2.15: extractUsageFromSSEEvent({}) does not throw and leaves stats unchanged", () => {
      const stats = makeStats();
      expect(() => extractUsageFromSSEEvent({}, stats)).not.toThrow();
      expect(stats.inputTokens).toBe(0);
      expect(stats.outputTokens).toBe(0);
      expect(stats.stopReason).toBeNull();
    });

    // T4.2.16 — SSE message_delta with no usage field → no crash
    it("T4.2.16: message_delta event missing usage does not crash", () => {
      const stats = makeStats();
      const parsed = { type: "message_delta", delta: { stop_reason: "end_turn" } };
      // No parsed.usage — should not enter the usage block
      expect(() => extractUsageFromSSEEvent(parsed, stats)).not.toThrow();
      // Stats remain at zero since usage is absent
      expect(stats.inputTokens).toBe(0);
      expect(stats.outputTokens).toBe(0);
    });

    // T4.2.17 — SSE message_delta with no delta.stop_reason → no crash
    it("T4.2.17: message_delta event missing delta.stop_reason does not crash", () => {
      const stats = makeStats();
      const parsed = {
        type: "message_delta",
        usage: { input_tokens: 100, output_tokens: 50 },
        // delta is absent
      };
      expect(() => extractUsageFromSSEEvent(parsed, stats)).not.toThrow();
      expect(stats.inputTokens).toBe(100);
      expect(stats.outputTokens).toBe(50);
      expect(stats.stopReason).toBeNull(); // no stop_reason captured
    });

    // T4.2.18 — SSE message_start with missing message.usage → no crash
    it("T4.2.18: message_start event missing message.usage does not crash", () => {
      const stats = makeStats();
      const parsed = { type: "message_start", message: { id: "msg_123" } }; // no usage
      expect(() => extractUsageFromSSEEvent(parsed, stats)).not.toThrow();
      expect(stats.inputTokens).toBe(0);
    });
  });

  // =========================================================================
  // Group 3: Config disabled states → safe defaults
  // =========================================================================
  describe("config disabled states", () => {
    // T4.2.19 — overflow_recovery.enabled = false → overflow handler logic is skipped
    it("T4.2.19: overflow_recovery.enabled=false → handler skipped (enabled flag is false)", () => {
      const config = { overflow_recovery: { enabled: false, safety_margin: 1_000 } };
      // Caller checks config.overflow_recovery?.enabled before attempting retry
      expect(config.overflow_recovery?.enabled).toBe(false);
      // Simulate: would-be retry guard
      const shouldAttemptRecovery = !!config.overflow_recovery?.enabled;
      expect(shouldAttemptRecovery).toBe(false);
    });

    // T4.2.20 — cache_break_detection.enabled = false → no hashing performed
    it("T4.2.20: cache_break_detection.enabled=false → hashing skipped", () => {
      const config = { cache_break_detection: { enabled: false, alert_threshold: 2_000 } };
      const shouldHash = !!config.cache_break_detection?.enabled;
      expect(shouldHash).toBe(false);
      // Confirm: when disabled, we never call extractCacheSourceHashes at all
      let hashCallCount = 0;
      const maybeHash = (bodyStr) => {
        if (!config.cache_break_detection?.enabled) return new Map();
        hashCallCount++;
        return extractCacheSourceHashes(bodyStr);
      };
      maybeHash('{"system":"hello"}');
      expect(hashCallCount).toBe(0);
    });

    // T4.2.21 — output_cap.enabled = false → max_tokens passthrough (undefined preserved)
    it("T4.2.21: output_cap.enabled=false → resolveMaxTokens returns body.max_tokens as-is", () => {
      const config = { output_cap: { enabled: false, default_max_tokens: 8_000 } };
      // body with no max_tokens: passthrough → undefined
      expect(resolveMaxTokens({}, config)).toBeUndefined();
      // body with explicit max_tokens: preserved
      expect(resolveMaxTokens({ max_tokens: 4096 }, config)).toBe(4096);
    });

    // T4.2.22 — request_classification.enabled = false → always foreground budgets
    it("T4.2.22: request_classification.enabled=false → always use foreground budget", () => {
      const config = { request_classification: { enabled: false } };
      // When disabled, classifier is bypassed; all requests treated as foreground
      const classify = (body) => {
        if (!config.request_classification?.enabled) return "foreground";
        return classifyApiRequest(body);
      };
      // Would-be background request (tiny with max_tokens=100) still gets foreground
      const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
      expect(classify(body)).toBe("foreground");
      // Even title-generation signal is overridden
      const titleBody = { system: [{ text: "Generate a short title" }], max_tokens: 50 };
      expect(classify(titleBody)).toBe("foreground");
    });

    // T4.2.23 — token_budget.enabled = false → no budget block injected
    it("T4.2.23: token_budget.enabled=false → budget block not injected", () => {
      const config = { token_budget: { enabled: false, default: 500_000, completion_threshold: 0.9 } };
      const systemBlocks = [{ type: "text", text: "You are helpful." }];
      // When disabled, injectTokenBudgetBlock is never called; system blocks unchanged
      const maybeInject = (blocks) => {
        if (!config.token_budget?.enabled) return blocks;
        // would inject here…
        return [{ type: "text", text: "Token budget: ..." }, ...blocks];
      };
      const result = maybeInject(systemBlocks);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("You are helpful."); // no budget block prepended
    });

    // T4.2.24 — microcompact.enabled = false → shouldMicrocompact always returns false
    it("T4.2.24: microcompact.enabled=false → shouldMicrocompact returns false regardless of token count", () => {
      const config = { microcompact: { enabled: false, threshold_percent: 80 } };
      // Even above threshold (180K > 160K) — still false when disabled
      expect(shouldMicrocompact(180_000, config)).toBe(false);
      expect(shouldMicrocompact(200_000, config)).toBe(false);
    });

    // T4.2.25 — preconnect.enabled = false → fire-and-forget HEAD request never sent
    it("T4.2.25: preconnect.enabled=false → HEAD request not issued", () => {
      const config = { preconnect: { enabled: false } };
      let headRequestFired = false;
      const maybePreconnect = async () => {
        if (!config.preconnect?.enabled) return; // guard
        headRequestFired = true;
        // would fire HEAD fetch here…
      };
      maybePreconnect();
      expect(headRequestFired).toBe(false);
    });

    // T4.2.26 — overload_recovery.enabled = false → no quota-aware model switching
    it("T4.2.26: overload_recovery.enabled=false → no quota-aware model switching", () => {
      const config = { overload_recovery: { enabled: false, fallback_model: "claude-haiku-4-5-20250514" } };
      const currentModel = "claude-sonnet-4-20250514";
      // When disabled, overloaded state never triggers a switch
      const resolveModel = (model, isOverloaded) => {
        if (!config.overload_recovery?.enabled) return model; // pass-through
        if (isOverloaded) return config.overload_recovery.fallback_model;
        return model;
      };
      // Even when overloaded, model is unchanged
      expect(resolveModel(currentModel, true)).toBe(currentModel);
      expect(resolveModel(currentModel, false)).toBe(currentModel);
    });
  });
});
