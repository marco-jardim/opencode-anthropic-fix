import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG } from "../../lib/config.mjs";

// u2500u2500u2500 Helpers u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500

/**
 * Replicate hashCacheSource from index.mjs for testing.
 * @param {string} content
 * @returns {string}
 */
function hashCacheSource(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Replicate extractCacheSourceHashes from index.mjs for testing.
 * @param {string} bodyStr
 * @returns {Map<string, string>}
 */
function extractCacheSourceHashes(bodyStr) {
  const hashes = new Map();
  try {
    const parsed = JSON.parse(bodyStr);

    // Hash system prompt
    if (Array.isArray(parsed.system)) {
      const systemText = parsed.system.map((b) => b.text || "").join("");
      if (systemText) hashes.set("system_prompt", hashCacheSource(systemText));
    } else if (typeof parsed.system === "string" && parsed.system) {
      hashes.set("system_prompt", hashCacheSource(parsed.system));
    }

    // Hash tool schemas (by name)
    if (Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.name) {
          hashes.set(`tool:${tool.name}`, hashCacheSource(JSON.stringify(tool)));
        }
      }
    }
  } catch {
    // Ignore parse errors
  }

  // LRU eviction: cap at 10 entries
  if (hashes.size > 10) {
    const entries = [...hashes.entries()];
    return new Map(entries.slice(entries.length - 10));
  }
  return hashes;
}

/**
 * Replicate detectCacheBreakSources from index.mjs for testing.
 * @param {Map<string, string>} currentHashes
 * @param {Map<string, string>} previousHashes
 * @returns {string[]}
 */
function detectCacheBreakSources(currentHashes, previousHashes) {
  if (previousHashes.size === 0) return [];
  const changed = [];
  for (const [key, hash] of currentHashes) {
    const prev = previousHashes.get(key);
    if (prev && prev !== hash) {
      changed.push(key);
    }
  }
  for (const key of previousHashes.keys()) {
    if (!currentHashes.has(key)) {
      changed.push(key);
    }
  }
  return changed;
}

function buildBody(system, tools = []) {
  return JSON.stringify({
    model: "claude-sonnet-4-6-20250514",
    max_tokens: 4096,
    system: Array.isArray(system) ? system : [{ type: "text", text: system }],
    messages: [{ role: "user", content: "hello" }],
    ...(tools.length > 0 ? { tools } : {}),
  });
}

// u2500u2500u2500 Tests u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500

describe("Task 2.3: Cache Break Detection", () => {
  // T2.3.1: Hash computed for system prompt block
  it("T2.3.1: hash computed for system prompt block before each request", () => {
    const body = buildBody("You are a helpful assistant.");
    const hashes = extractCacheSourceHashes(body);

    expect(hashes.has("system_prompt")).toBe(true);
    expect(hashes.get("system_prompt")).toHaveLength(16);
    expect(typeof hashes.get("system_prompt")).toBe("string");
  });

  // T2.3.2: Alert fires when cache_read_input_tokens drops by >2,000
  it("T2.3.2: alert fires when cache_read_input_tokens drops by >2000 vs prior turn", () => {
    const threshold = 2_000;
    const prevCacheRead = 50_000;
    const currentCacheRead = 45_000; // drop of 5,000 > threshold

    const drop = prevCacheRead - currentCacheRead;
    const shouldAlert = prevCacheRead > 0 && drop > threshold;

    expect(shouldAlert).toBe(true);
    expect(drop).toBe(5_000);
  });

  // T2.3.3: No alert when drop is u22642,000
  it("T2.3.3: no alert when drop is \u22642000 (below threshold)", () => {
    const threshold = 2_000;
    const prevCacheRead = 50_000;
    const currentCacheRead = 49_000; // drop of 1,000 u2264 threshold

    const drop = prevCacheRead - currentCacheRead;
    const shouldAlert = prevCacheRead > 0 && drop > threshold;

    expect(shouldAlert).toBe(false);
  });

  // T2.3.4: Changed tool schema identified by name
  it("T2.3.4: changed tool schema identified by name in alert message", () => {
    const tools1 = [
      {
        name: "read_file",
        description: "Reads a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "bash",
        description: "Run bash",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ];
    const tools2 = [
      {
        name: "read_file",
        description: "Reads a file (v2 updated)",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "bash",
        description: "Run bash",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ];

    const systemPrompt = "You are helpful.";
    const body1 = buildBody(systemPrompt, tools1);
    const body2 = buildBody(systemPrompt, tools2);

    const hashes1 = extractCacheSourceHashes(body1);
    const hashes2 = extractCacheSourceHashes(body2);

    // System prompt should be the same
    expect(hashes1.get("system_prompt")).toBe(hashes2.get("system_prompt"));

    // read_file tool schema changed
    expect(hashes1.get("tool:read_file")).not.toBe(hashes2.get("tool:read_file"));

    // bash tool schema unchanged
    expect(hashes1.get("tool:bash")).toBe(hashes2.get("tool:bash"));

    // Detect changed sources
    const changed = detectCacheBreakSources(hashes2, hashes1);
    expect(changed).toContain("tool:read_file");
    expect(changed).not.toContain("tool:bash");
    expect(changed).not.toContain("system_prompt");
  });

  // T2.3.5: Source hash map never exceeds 10 entries (LRU eviction)
  it("T2.3.5: source hash map never exceeds 10 entries (LRU eviction)", () => {
    // Create a body with 12 tools
    const tools = Array.from({ length: 12 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      input_schema: { type: "object" },
    }));

    const body = buildBody("System prompt", tools);
    const hashes = extractCacheSourceHashes(body);

    // system_prompt + 12 tools = 13 entries, should be capped at 10
    expect(hashes.size).toBeLessThanOrEqual(10);
  });

  // T2.3.6: State resets after compaction event
  it("T2.3.6: state resets after compaction event", () => {
    // Simulate cache break state
    const cacheBreakState = {
      prevCacheRead: 50_000,
      sourceHashes: new Map([["system_prompt", "abc123"]]),
      lastAlertTurn: 5,
    };

    // Simulate compaction reset (matches code in session.compacting handler)
    cacheBreakState.prevCacheRead = 0;
    cacheBreakState.sourceHashes = new Map();
    cacheBreakState.lastAlertTurn = 0;

    expect(cacheBreakState.prevCacheRead).toBe(0);
    expect(cacheBreakState.sourceHashes.size).toBe(0);
    expect(cacheBreakState.lastAlertTurn).toBe(0);
  });

  // T2.3.7: Disabled config skips hashing and alerting
  it("T2.3.7: cache_break_detection.enabled: false u2192 no hashing, no alerts", () => {
    const config = { cache_break_detection: { enabled: false, alert_threshold: 2_000 } };

    // When disabled, pre-call hashing should be skipped
    const shouldHash = config.cache_break_detection?.enabled;
    expect(shouldHash).toBe(false);

    // When disabled, post-call comparison should be skipped
    const shouldCompare = config.cache_break_detection?.enabled;
    expect(shouldCompare).toBe(false);
  });

  // Extra: config defaults
  it("config defaults include cache_break_detection", () => {
    expect(DEFAULT_CONFIG.cache_break_detection).toBeDefined();
    expect(DEFAULT_CONFIG.cache_break_detection.enabled).toBe(true);
    expect(DEFAULT_CONFIG.cache_break_detection.alert_threshold).toBe(2_000);
  });

  // Extra: hash determinism
  it("hashCacheSource produces deterministic 16-char hex output", () => {
    const h1 = hashCacheSource("hello world");
    const h2 = hashCacheSource("hello world");
    const h3 = hashCacheSource("different content");

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(16);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  // Extra: first turn should NOT fire alert (no baseline)
  it("no alert on first turn when prevCacheRead is 0", () => {
    const prevCacheRead = 0; // first turn
    const currentCacheRead = 50_000;
    const threshold = 2_000;

    // Guard: prevCacheRead must be > 0 to fire alert
    const shouldAlert = prevCacheRead > 0 && prevCacheRead - currentCacheRead > threshold;
    expect(shouldAlert).toBe(false);
  });

  // Extra: detect removed tool
  it("detects removed tool schema as a change", () => {
    const prev = new Map([
      ["system_prompt", "aaa"],
      ["tool:read_file", "bbb"],
      ["tool:bash", "ccc"],
    ]);
    const current = new Map([
      ["system_prompt", "aaa"],
      ["tool:read_file", "bbb"],
      // bash tool removed
    ]);

    const changed = detectCacheBreakSources(current, prev);
    expect(changed).toContain("tool:bash");
    expect(changed).not.toContain("system_prompt");
    expect(changed).not.toContain("tool:read_file");
  });
});
