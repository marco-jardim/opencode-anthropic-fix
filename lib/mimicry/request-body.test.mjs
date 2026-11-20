import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_TOOL_NAMES, normalizeThinkingBlock, transformRequestBody } from "./request-body.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeThinkingBlock", () => {
  it("passes absent and non-object values through", () => {
    expect(normalizeThinkingBlock(undefined, "claude-opus-4-8")).toBeUndefined();
    expect(normalizeThinkingBlock("enabled", "claude-opus-4-8")).toBe("enabled");
  });

  it("passes a non-adaptive model's block through unchanged", () => {
    const thinking = { type: "enabled", budget_tokens: 8000 };

    expect(normalizeThinkingBlock(thinking, "claude-sonnet-4-5")).toBe(thinking);
  });

  it("normalizes adaptive models to adaptive thinking", () => {
    expect(normalizeThinkingBlock({ type: "enabled", budget_tokens: 8000 }, "claude-opus-4-8")).toEqual({
      type: "adaptive",
    });
  });

  it.each(["summarized", "omitted"])("keeps the caller's %s display on adaptive models", (display) => {
    expect(normalizeThinkingBlock({ type: "adaptive", display }, "claude-opus-5-5")).toEqual({
      type: "adaptive",
      display,
    });
    expect(normalizeThinkingBlock({ type: "enabled", budget_tokens: 8000, display }, "claude-fable-5-1")).toEqual({
      type: "adaptive",
      display,
    });
  });

  it("drops display values the wire builder does not accept", () => {
    expect(normalizeThinkingBlock({ type: "adaptive", display: "verbose" }, "claude-opus-5-5")).toEqual({
      type: "adaptive",
    });
    expect(normalizeThinkingBlock({ type: "adaptive", display: 1 }, "claude-opus-5-5")).toEqual({ type: "adaptive" });
  });

  it("preserves an enabled block when adaptive thinking is disabled", () => {
    vi.stubEnv("OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING", "1");
    const thinking = { type: "enabled", budget_tokens: 12000 };

    expect(normalizeThinkingBlock(thinking, "claude-opus-4-8")).toBe(thinking);
  });

  it("uses the configured fallback budget when adaptive thinking is disabled", () => {
    vi.stubEnv("OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING", "true");
    vi.stubEnv("MAX_THINKING_TOKENS", "24000");

    expect(normalizeThinkingBlock({ type: "adaptive" }, "claude-sonnet-4-6")).toEqual({
      type: "enabled",
      budget_tokens: 24000,
    });
  });

  it("uses the default fallback budget when the configured value is invalid", () => {
    vi.stubEnv("OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING", "yes");
    vi.stubEnv("MAX_THINKING_TOKENS", "invalid");

    expect(normalizeThinkingBlock({}, "claude-fable-5")).toEqual({
      type: "enabled",
      budget_tokens: 16000,
    });
  });
});

describe("request body mimicry", () => {
  it("exports core tools and renames opencode tool names", () => {
    expect(CORE_TOOL_NAMES).toBeInstanceOf(Set);
    expect(CORE_TOOL_NAMES.has("Bash")).toBe(true);
    expect(CORE_TOOL_NAMES.has("Read")).toBe(true);
    expect(CORE_TOOL_NAMES.has("Task")).toBe(true);

    const body = {
      model: "claude-opus-4-1",
      max_tokens: 8000,
      system: [{ type: "text", text: "You are opencode" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
    };
    const signature = { enabled: false };
    const runtime = {
      turns: 1,
      usedTools: new Set(),
      tokenEconomySession: null,
      cacheBoundaryStability: new Map(),
      persistentUserId: "d",
      accountId: "a",
      sessionId: "s",
    };

    const result = transformRequestBody(JSON.stringify(body), signature, runtime, false, {});

    expect(typeof result).toBe("string");
    expect(JSON.parse(result).tools[0].name).toBe("Bash");
  });
});

// ---------------------------------------------------------------------------
// Catalogue-driven composition (expected values are the 2.1.280 catalogue, the
// profile WIRE_PROFILE is bound to).
// ---------------------------------------------------------------------------

function makeRuntime(extra = {}) {
  return {
    turns: 1,
    usedTools: new Set(),
    tokenEconomySession: null,
    cacheBoundaryStability: new Map(),
    persistentUserId: "d",
    accountId: "a",
    sessionId: "s",
    ...extra,
  };
}

function run(bodyFields, { config = {}, signature = { enabled: false }, runtime = makeRuntime() } = {}) {
  const body = JSON.stringify({
    model: "claude-opus-5-5",
    max_tokens: 8000,
    system: [{ type: "text", text: "You are opencode" }],
    messages: [{ role: "user", content: "hi" }],
    ...bodyFields,
  });
  return JSON.parse(transformRequestBody(body, signature, runtime, false, config));
}

describe("default effort", () => {
  it("injects medium by default on adaptive models that take effort", () => {
    expect(run({ model: "claude-opus-5-5" }).output_config).toEqual({ effort: "medium" });
    expect(run({ model: "claude-opus-4-7" }).output_config).toEqual({ effort: "medium" });
    expect(run({ model: "claude-sonnet-5" }).output_config).toEqual({ effort: "medium" });
  });

  it("follows the catalogue default when default_effort is auto", () => {
    const config = { default_effort: "auto" };
    expect(run({ model: "claude-opus-5-5" }, { config }).output_config).toEqual({ effort: "medium" });
    expect(run({ model: "claude-opus-4-7" }, { config }).output_config).toEqual({ effort: "xhigh" });
    // No catalogue default recorded: falls back to high.
    expect(run({ model: "claude-opus-4-6" }, { config }).output_config).toEqual({ effort: "high" });
  });

  it("lets CLAUDE_CODE_EFFORT_LEVEL win over the config", () => {
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", " LOW ");
    expect(run({}, { config: { default_effort: "high" } }).output_config).toEqual({ effort: "low" });
  });

  it("accepts auto from the environment and ignores an invalid value", () => {
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "auto");
    expect(run({ model: "claude-opus-4-7" }, { config: { default_effort: "low" } }).output_config).toEqual({
      effort: "xhigh",
    });
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "turbo");
    expect(run({}, { config: { default_effort: "low" } }).output_config).toEqual({ effort: "low" });
  });

  it("clamps xhigh to high where the model lacks it, and keeps it where supported", () => {
    const config = { default_effort: "xhigh" };
    expect(run({ model: "claude-opus-4-6" }, { config }).output_config).toEqual({ effort: "high" });
    expect(run({ model: "claude-opus-4-7" }, { config }).output_config).toEqual({ effort: "xhigh" });
    expect(run({ model: "claude-opus-4-6" }, { config: { default_effort: "max" } }).output_config).toEqual({
      effort: "max",
    });
  });

  it("lets the host's effort win, top-level or nested", () => {
    expect(run({ effort: "max" }, { config: { default_effort: "low" } }).output_config).toEqual({ effort: "max" });
    const nested = run({ output_config: { effort: "high" } }, { config: { default_effort: "low" } });
    expect(nested.output_config).toEqual({ effort: "high" });
    expect(nested.effort).toBeUndefined();
  });
});

describe("effort and thinking guards", () => {
  it("sends no adaptive thinking and no effort to an id the catalogue does not mark", () => {
    for (const model of ["claude-mythos-5", "claude-haiku-4-5", "claude-unknown-9"]) {
      const parsed = run({ model, effort: "high" });
      expect(parsed.thinking, model).toBeUndefined();
      expect(parsed.effort, model).toBeUndefined();
      expect(parsed.output_config, model).toBeUndefined();
    }
  });

  it("claude-mythos-5-2 is adaptive and carries the catalogue default effort (medium) under 2.1.329", () => {
    const parsed = run({ model: "claude-mythos-5-2" });
    expect(parsed.thinking).toEqual({ type: "adaptive" });
    expect(parsed.output_config).toEqual({ effort: "medium" });
    expect(parsed.effort).toBeUndefined();
  });

  it("keeps nested max_output_tokens and drops effort only where the catalogue has none", () => {
    const parsed = run({ model: "claude-mythos-5", output_config: { effort: "high", max_output_tokens: 4096 } });
    expect(parsed.output_config).toEqual({ max_output_tokens: 4096 });
    const adaptive = run({ model: "claude-mythos-5-2", output_config: { effort: "high", max_output_tokens: 4096 } });
    expect(adaptive.output_config).toEqual({ effort: "high", max_output_tokens: 4096 });
  });

  it("turns disabled thinking into adaptive on adaptive models, including the rejects_disabled_thinking ones", () => {
    for (const model of [
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-mythos-5-2",
      "claude-fable-5-2",
    ]) {
      expect(run({ model, thinking: { type: "disabled" } }).thinking, model).toEqual({ type: "adaptive" });
    }
  });

  it("leaves disabled thinking on catalogued non-adaptive ids and no longer drops it for unknown ids", () => {
    expect(run({ model: "claude-haiku-4-5", thinking: { type: "disabled" } }).thinking).toEqual({ type: "disabled" });
    // The WP3 interim guard (delete disabled thinking for uncatalogued ids) is
    // gone: the 2.1.329 catalogue covers the models it protected.
    expect(run({ model: "claude-future-88", thinking: { type: "disabled" } }).thinking).toEqual({ type: "disabled" });
    expect(run({ model: "claude-future-88", thinking: { type: "enabled", budget_tokens: 2000 } }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 2000,
    });
  });
});

describe("max_tokens", () => {
  it("fills the catalogue default when the host omitted it", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    const parsed = JSON.parse(transformRequestBody(body, { enabled: false }, makeRuntime(), false, {}));
    expect(parsed.max_tokens).toBe(64000);
  });

  it("keeps the host's value and leaves an uncatalogued id alone", () => {
    expect(run({ max_tokens: 123 }).max_tokens).toBe(123);
    const body = JSON.stringify({ model: "claude-unknown-9", messages: [{ role: "user", content: "hi" }] });
    const parsed = JSON.parse(transformRequestBody(body, { enabled: false }, makeRuntime(), false, {}));
    expect(parsed.max_tokens).toBeUndefined();
  });
});

describe("fast mode eligibility", () => {
  const signature = { enabled: false, fastMode: true };

  it("is granted by the catalogue capability", () => {
    expect(run({ model: "claude-opus-4-8" }, { signature }).speed).toBe("fast");
    expect(run({ model: "claude-opus-5-5" }, { signature }).speed).toBe("fast");
  });

  it("is not granted to ids without the capability", () => {
    for (const model of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(run({ model }, { signature }).speed, model).toBeUndefined();
    }
  });

  it("fast_mode_legacy_models re-admits Opus 4.6 and 4.7 only", () => {
    const config = { fast_mode_legacy_models: true };
    expect(run({ model: "claude-opus-4-7" }, { signature, config }).speed).toBe("fast");
    expect(run({ model: "claude-opus-4-6" }, { signature, config }).speed).toBe("fast");
    expect(run({ model: "claude-sonnet-5" }, { signature, config }).speed).toBeUndefined();
  });

  it("is suppressed while the fast pool is cooling down", () => {
    const limited = { ...signature, fastRateLimited: true };
    expect(run({ model: "claude-opus-4-8" }, { signature: limited }).speed).toBeUndefined();
    expect(
      run({ model: "claude-opus-4-7" }, { signature: limited, config: { fast_mode_legacy_models: true } }).speed,
    ).toBeUndefined();
  });
});

describe("tool deferral model gate", () => {
  const tools = [
    { name: "bash", description: "run", input_schema: { type: "object" } },
    { name: "custom_tool", description: "x", input_schema: { type: "object" } },
  ];

  it("defers non-core tools for Haiku 4.x but not for Claude 3 ids", () => {
    const haiku = run({ model: "claude-haiku-4-5", tools });
    expect(haiku.tools.find((t) => t.name === "custom_tool").defer_loading).toBe(true);
    expect(haiku.tools.find((t) => t.name === "Bash").defer_loading).toBeUndefined();

    const claude3 = run({ model: "claude-3-5-sonnet", tools });
    expect(claude3.tools.find((t) => t.name === "custom_tool").defer_loading).toBeUndefined();
  });
});

describe("messages cache TTL", () => {
  const signature = {
    enabled: true,
    useAdapter: true,
    claudeCliVersion: "2.1.280",
    promptCompactionMode: "off",
    cachePolicy: { ttl: "1h", ttl_supported: true },
  };
  const tools = [{ name: "custom_tool", description: "x", input_schema: { type: "object" } }];
  const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

  it("keeps one TTL across tools, system and messages by default", () => {
    const parsed = run({ tools, messages }, { signature });
    expect(parsed.tools.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(parsed.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("lowers only the messages marker with CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m", () => {
    vi.stubEnv("CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL", "5m");
    const parsed = run({ tools, messages }, { signature });
    expect(parsed.tools.at(-1).cache_control.ttl).toBe("1h");
    expect(parsed.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    for (const block of parsed.system) {
      if (block.cache_control) expect(block.cache_control.ttl).toBe("1h");
    }
  });

  it("ignores any other value of the messages env var", () => {
    vi.stubEnv("CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL", "1h");
    const parsed = run({ tools, messages }, { signature });
    expect(parsed.messages.at(-1).content.at(-1).cache_control.ttl).toBe("1h");
  });
});

describe("cold-cache-only history rewrites", () => {
  const signature = {
    enabled: true,
    useAdapter: true,
    claudeCliVersion: "2.1.280",
    promptCompactionMode: "off",
    cachePolicy: { ttl: "1h", ttl_supported: true },
  };
  const thinkingMessages = () => [
    { role: "user", content: [{ type: "text", text: "one" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old", signature: "sig-1" },
        { type: "text", text: "a1" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "two" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "latest", signature: "sig-2" },
        { type: "text", text: "a2" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "three" }] },
  ];
  const makeTes = () => ({
    lastThinkingStripMs: 0,
    thinkingStripped: 0,
    lastMicrocompactMs: 0,
    toolResultsCompacted: 0,
    seenContentHashes: new Set(),
  });
  let sessionCounter = 0;
  const send = (sessionKey, te, extra = {}) =>
    run(
      { messages: thinkingMessages() },
      {
        signature,
        config: { token_economy: te },
        runtime: makeRuntime({ sessionKey, tokenEconomySession: makeTes(), ...extra }),
      },
    );
  const hasOldThinking = (parsed) => parsed.messages[1].content.some((b) => b.type === "thinking");
  const hasLatestThinking = (parsed) => parsed.messages[3].content.some((b) => b.type === "thinking");

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never rewrites under the default conservative mode, cold or not", () => {
    const parsed = send(`default-${(sessionCounter += 1)}`, {});
    expect(hasOldThinking(parsed)).toBe(true);
  });

  it("rewrites on a cold cache and not on a warm one when cold_cache_only is set", () => {
    const key = `cold-${(sessionCounter += 1)}`;
    const te = { cold_cache_only: true };
    // No previous main request: nothing cached, so rewriting is free.
    const first = send(key, te);
    expect(hasOldThinking(first)).toBe(false);
    expect(hasLatestThinking(first)).toBe(true);
    // Immediately after: the cache is warm.
    expect(hasOldThinking(send(key, te))).toBe(true);
  });

  it("goes cold again once the cache TTL has elapsed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T10:00:00Z"));
    const key = `ttl-${(sessionCounter += 1)}`;
    const te = { cold_cache_only: true };
    send(key, te);
    vi.setSystemTime(new Date("2026-11-19T10:30:00Z"));
    expect(hasOldThinking(send(key, te))).toBe(true);
    vi.setSystemTime(new Date("2026-11-19T11:45:00Z"));
    expect(hasOldThinking(send(key, te))).toBe(false);
  });

  it("only main-thread requests refresh the clock", () => {
    const key = `role-${(sessionCounter += 1)}`;
    const te = { cold_cache_only: true };
    send(key, te, { requestRole: "title" });
    // The title request wrote nothing the main cache depends on: still cold.
    expect(hasOldThinking(send(key, te))).toBe(false);
  });

  it("without cold_cache_only, opting out of conservative rewrites warm caches too", () => {
    const key = `warm-${(sessionCounter += 1)}`;
    const te = { conservative: false };
    send(key, te);
    expect(hasOldThinking(send(key, te))).toBe(false);
  });

  describe("idle tool-result clearing", () => {
    const PLACEHOLDER = "[Old tool result content cleared]";
    const toolMessages = () => {
      const out = [{ role: "user", content: [{ type: "text", text: "go" }] }];
      for (let i = 0; i < 30; i += 1) {
        out.push({
          role: "assistant",
          content: [{ type: "tool_use", id: `toolu_${i}`, name: "Read", input: {} }],
        });
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "x".repeat(6000) }],
        });
      }
      return out;
    };
    const sendTools = (key, te) =>
      run(
        { messages: toolMessages() },
        { signature, config: { token_economy: te }, runtime: makeRuntime({ sessionKey: key }) },
      );
    const cleared = (parsed) =>
      parsed.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.content === PLACEHOLDER).length;

    it("clears old results only after a long idle with the opt-in set", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-19T10:00:00Z"));
      const key = `idle-${(sessionCounter += 1)}`;
      const te = { idle_tool_result_clearing: true };
      // First request: no previous one to measure idle time from.
      expect(cleared(sendTools(key, te))).toBe(0);
      // Warm cache: untouched.
      vi.setSystemTime(new Date("2026-11-19T10:10:00Z"));
      expect(cleared(sendTools(key, te))).toBe(0);
      // Idle for two hours: the 18 results older than the newest 12 are cleared.
      vi.setSystemTime(new Date("2026-11-19T12:15:00Z"));
      expect(cleared(sendTools(key, te))).toBe(18);
    });

    it("does nothing without the opt-in", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-19T10:00:00Z"));
      const key = `idle-off-${(sessionCounter += 1)}`;
      sendTools(key, {});
      vi.setSystemTime(new Date("2026-11-19T12:15:00Z"));
      expect(cleared(sendTools(key, {}))).toBe(0);
    });
  });
});

describe("task budgets output_config", () => {
  const RUNTIME = {
    turns: 1,
    usedTools: new Set(),
    tokenEconomySession: null,
    cacheBoundaryStability: new Map(),
    persistentUserId: "d",
    accountId: "a",
    sessionId: "s",
  };

  function body(overrides = {}) {
    return JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: [{ type: "text", text: "You are opencode" }],
      messages: [{ role: "user", content: "hi" }],
      ...overrides,
    });
  }

  it("injects a default output_config when taskBudgetsActive is true", () => {
    const parsed = JSON.parse(transformRequestBody(body(), { enabled: false }, RUNTIME, true, {}));

    expect(parsed.output_config).toEqual({ max_output_tokens: 16384 });
  });

  it("leaves a caller-supplied output_config untouched when taskBudgetsActive is true", () => {
    const parsed = JSON.parse(
      transformRequestBody(body({ output_config: { max_output_tokens: 4096 } }), { enabled: false }, RUNTIME, true, {}),
    );

    expect(parsed.output_config).toEqual({ max_output_tokens: 4096 });
  });

  it("does not inject output_config when taskBudgetsActive is false", () => {
    const parsed = JSON.parse(transformRequestBody(body(), { enabled: false }, RUNTIME, false, {}));

    expect(parsed.output_config).toBeUndefined();
  });
});
