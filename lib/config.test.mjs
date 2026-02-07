import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, DEFAULT_CONFIG, getConfigDir, getConfigPath } from "./config.mjs";
import { existsSync, readFileSync } from "node:fs";

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe("DEFAULT_CONFIG", () => {
  it("has expected default strategy", () => {
    expect(DEFAULT_CONFIG.account_selection_strategy).toBe("sticky");
  });

  it("has expected health score defaults", () => {
    expect(DEFAULT_CONFIG.health_score.initial).toBe(70);
    expect(DEFAULT_CONFIG.health_score.success_reward).toBe(1);
    expect(DEFAULT_CONFIG.health_score.rate_limit_penalty).toBe(-10);
    expect(DEFAULT_CONFIG.health_score.failure_penalty).toBe(-20);
    expect(DEFAULT_CONFIG.health_score.min_usable).toBe(50);
    expect(DEFAULT_CONFIG.health_score.max_score).toBe(100);
  });

  it("has expected token bucket defaults", () => {
    expect(DEFAULT_CONFIG.token_bucket.max_tokens).toBe(50);
    expect(DEFAULT_CONFIG.token_bucket.regeneration_rate_per_minute).toBe(6);
    expect(DEFAULT_CONFIG.token_bucket.initial_tokens).toBe(50);
  });

  it("has debug disabled by default", () => {
    expect(DEFAULT_CONFIG.debug).toBe(false);
  });

  it("has toast defaults", () => {
    expect(DEFAULT_CONFIG.toasts.quiet).toBe(false);
    expect(DEFAULT_CONFIG.toasts.debounce_seconds).toBe(30);
  });
});

describe("getConfigDir", () => {
  it("returns a path ending with opencode", () => {
    const dir = getConfigDir();
    expect(dir.endsWith("opencode")).toBe(true);
  });
});

describe("getConfigPath", () => {
  it("returns a path ending with anthropic-auth.json", () => {
    const path = getConfigPath();
    expect(path.endsWith("anthropic-auth.json")).toBe(true);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    // Clean env overrides
    delete process.env.OPENCODE_ANTHROPIC_STRATEGY;
    delete process.env.OPENCODE_ANTHROPIC_DEBUG;
    delete process.env.OPENCODE_ANTHROPIC_QUIET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when config file does not exist", () => {
    existsSync.mockReturnValue(false);
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults when config file is invalid JSON", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("not json {{{");
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults when config file is an array", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("[]");
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults when config file is null", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("null");
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges valid strategy from config file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ account_selection_strategy: "sticky" }));
    const config = loadConfig();
    expect(config.account_selection_strategy).toBe("sticky");
  });

  it("ignores invalid strategy", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ account_selection_strategy: "invalid" }));
    const config = loadConfig();
    expect(config.account_selection_strategy).toBe("sticky");
  });

  it("accepts boolean debug", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ debug: true }));
    const config = loadConfig();
    expect(config.debug).toBe(true);
  });

  it("merges health_score sub-config", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        health_score: {
          initial: 80,
          success_reward: 5,
        },
      }),
    );
    const config = loadConfig();
    expect(config.health_score.initial).toBe(80);
    expect(config.health_score.success_reward).toBe(5);
    // Other fields should be defaults
    expect(config.health_score.rate_limit_penalty).toBe(-10);
  });

  it("clamps health_score values to valid ranges", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        health_score: {
          initial: 200, // max 100
          rate_limit_penalty: -999, // min -50
        },
      }),
    );
    const config = loadConfig();
    expect(config.health_score.initial).toBe(100);
    expect(config.health_score.rate_limit_penalty).toBe(-50);
  });

  it("merges token_bucket sub-config", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        token_bucket: {
          max_tokens: 100,
        },
      }),
    );
    const config = loadConfig();
    expect(config.token_bucket.max_tokens).toBe(100);
    expect(config.token_bucket.regeneration_rate_per_minute).toBe(6);
  });

  // Environment variable overrides
  it("overrides strategy from OPENCODE_ANTHROPIC_STRATEGY", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_STRATEGY = "round-robin";
    const config = loadConfig();
    expect(config.account_selection_strategy).toBe("round-robin");
  });

  it("ignores invalid OPENCODE_ANTHROPIC_STRATEGY", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_STRATEGY = "invalid";
    const config = loadConfig();
    expect(config.account_selection_strategy).toBe("sticky");
  });

  it("enables debug from OPENCODE_ANTHROPIC_DEBUG=1", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_DEBUG = "1";
    const config = loadConfig();
    expect(config.debug).toBe(true);
  });

  it("enables debug from OPENCODE_ANTHROPIC_DEBUG=true", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_DEBUG = "true";
    const config = loadConfig();
    expect(config.debug).toBe(true);
  });

  it("disables debug from OPENCODE_ANTHROPIC_DEBUG=0", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ debug: true }));
    process.env.OPENCODE_ANTHROPIC_DEBUG = "0";
    const config = loadConfig();
    expect(config.debug).toBe(false);
  });

  it("env overrides take precedence over config file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ account_selection_strategy: "sticky" }));
    process.env.OPENCODE_ANTHROPIC_STRATEGY = "round-robin";
    const config = loadConfig();
    expect(config.account_selection_strategy).toBe("round-robin");
  });

  // Toast config
  it("has toast defaults", () => {
    existsSync.mockReturnValue(false);
    const config = loadConfig();
    expect(config.toasts.quiet).toBe(false);
    expect(config.toasts.debounce_seconds).toBe(30);
  });

  it("merges toasts sub-config", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ toasts: { quiet: true, debounce_seconds: 10 } }));
    const config = loadConfig();
    expect(config.toasts.quiet).toBe(true);
    expect(config.toasts.debounce_seconds).toBe(10);
  });

  it("clamps debounce_seconds to valid range", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ toasts: { debounce_seconds: 999 } }));
    const config = loadConfig();
    expect(config.toasts.debounce_seconds).toBe(300);
  });

  it("clamps negative debounce_seconds to 0", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ toasts: { debounce_seconds: -5 } }));
    const config = loadConfig();
    expect(config.toasts.debounce_seconds).toBe(0);
  });

  it("ignores non-boolean quiet", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ toasts: { quiet: "yes" } }));
    const config = loadConfig();
    expect(config.toasts.quiet).toBe(false);
  });

  it("enables quiet from OPENCODE_ANTHROPIC_QUIET=1", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_QUIET = "1";
    const config = loadConfig();
    expect(config.toasts.quiet).toBe(true);
  });

  it("disables quiet from OPENCODE_ANTHROPIC_QUIET=0", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ toasts: { quiet: true } }));
    process.env.OPENCODE_ANTHROPIC_QUIET = "0";
    const config = loadConfig();
    expect(config.toasts.quiet).toBe(false);
  });
});
