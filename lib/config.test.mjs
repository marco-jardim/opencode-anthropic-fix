import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, loadRawConfig, DEFAULT_CONFIG, getConfigDir, getConfigPath } from "./config.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

  it("enables signature emulation defaults", () => {
    expect(DEFAULT_CONFIG.signature_emulation.enabled).toBe(true);
    expect(DEFAULT_CONFIG.signature_emulation.fetch_claude_code_version_on_startup).toBe(true);
    expect(DEFAULT_CONFIG.signature_emulation.prompt_compaction).toBe("off");
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

  it("uses APPDATA on Windows", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const originalAppData = process.env.APPDATA;
    process.env.APPDATA = "appdata-root";

    expect(getConfigDir()).toBe(join("appdata-root", "opencode"));

    platform.mockRestore();
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  });

  it("uses XDG_CONFIG_HOME on non-Windows platforms", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "xdg-config-root";

    expect(getConfigDir()).toBe(join("xdg-config-root", "opencode"));

    platform.mockRestore();
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
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
    delete process.env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE;
    delete process.env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION;
    delete process.env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION;
    delete process.env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS;
    delete process.env.OPENCODE_ANTHROPIC_CC_CREDENTIALS;
    delete process.env.OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT;
    delete process.env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED;
    delete process.env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY;
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

  it("accepts 'single' strategy from config file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ account_selection_strategy: "single" }));
    const config = loadConfig();
    expect(config.account_selection_strategy).toBe("single");
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

  it("merges signature emulation sub-config", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        signature_emulation: {
          enabled: false,
          fetch_claude_code_version_on_startup: false,
          prompt_compaction: "off",
        },
      }),
    );
    const config = loadConfig();
    expect(config.signature_emulation.enabled).toBe(false);
    expect(config.signature_emulation.fetch_claude_code_version_on_startup).toBe(false);
    expect(config.signature_emulation.prompt_compaction).toBe("off");
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

  it("validates and merges every supported nested config section", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        failure_ttl_seconds: 9_000,
        signature_emulation: {
          enabled: false,
          fetch_claude_code_version_on_startup: false,
          prompt_compaction: "off",
          workload: "  nightly-agent  ",
        },
        override_model_limits: { enabled: true, context: 3_000_000, output: -1 },
        custom_betas: [" beta-one ", "", 42, "beta-two"],
        health_score: {
          initial: 80,
          success_reward: 5,
          rate_limit_penalty: -15,
          failure_penalty: -30,
          recovery_rate_per_hour: 4,
          min_usable: 60,
          max_score: 90,
        },
        token_bucket: { max_tokens: 75, regeneration_rate_per_minute: 8, initial_tokens: 70 },
        toasts: { quiet: true, debounce_seconds: 12 },
        headers: {
          emulation_profile: "  2.1.0  ",
          overrides: { "x-test": "value", ignored: 7, "": "empty-key" },
          disable: [" X-REMOVE ", 10, "", "X-OTHER"],
          billing_header: false,
        },
        idle_refresh: { enabled: false, window_minutes: 90, min_interval_minutes: 45 },
        cache_policy: {
          ttl: "5m",
          ttl_supported: false,
          boundary_marker: true,
          hit_rate_warning_threshold: 2,
        },
        fast_mode: true,
        telemetry: { emulate_minimal: true },
        usage_toast: true,
        cc_credential_reuse: { enabled: true, auto_detect: false, prefer_over_oauth: true },
        adaptive_context: { enabled: false, escalation_threshold: 200_000, deescalation_threshold: 220_000 },
        willow_mode: { enabled: false, idle_threshold_minutes: 45, cooldown_minutes: 90, min_turns_before_suggest: 5 },
        token_economy: {
          token_efficient_tools: true,
          redact_thinking: false,
          context_hint: false,
          conservative: false,
          debug_dump_bodies: true,
          ttl_thinking_strip: false,
          proactive_microcompact: false,
          microcompact_percent: 20,
          microcompact_keep_recent: 100,
          stable_tool_ordering: false,
          deferred_tool_names: ["read", 12, "grep"],
          adaptive_thinking_zero_simple: false,
          tool_result_dedupe: true,
          fast_mode_auto: true,
          trailing_summary_trim: true,
          role_scoped_cache_ttl: false,
          lean_system_non_main: false,
          simple_system_prompt: false,
        },
        token_economy_strategies: {
          system_prompt_tailing: true,
          system_prompt_tail_turns: 0,
          system_prompt_tail_max_chars: 100_000,
          tool_deferral: true,
          tool_description_compaction: true,
          adaptive_tool_set: true,
          tool_result_dedupe_session_wide: true,
          haiku_rolling_summary: true,
          stale_read_eviction: true,
          per_tool_class_prune: true,
        },
        output_cap: { enabled: false, default_max_tokens: 100, escalated_max_tokens: 300_000 },
        preconnect: { enabled: false, timeout_ms: 50 },
        overflow_recovery: { enabled: false, safety_margin: 20_000 },
        cache_break_detection: { enabled: false, alert_threshold: 1_500, adaptive_breakpoint: false },
        request_classification: {
          enabled: false,
          background_max_service_retries: 3,
          background_max_should_retries: 4,
        },
        token_budget: { enabled: true, default: 25_000, completion_threshold: 2 },
        microcompact: { enabled: false, threshold_percent: 120 },
        overload_recovery: { enabled: false, default_cooldown_ms: 500, poll_quota_on_overload: false },
        account_management: { proactive_disabled: false },
        anti_verbosity: { enabled: false },
        oauth: { sdk_token_useragent: false },
      }),
    );

    const config = loadConfig();

    expect(config.failure_ttl_seconds).toBe(7_200);
    expect(config.signature_emulation).toEqual({
      enabled: false,
      fetch_claude_code_version_on_startup: false,
      prompt_compaction: "off",
      workload: "nightly-agent",
      session_correlation: true,
    });
    expect(config.override_model_limits).toEqual({ enabled: true, context: 2_000_000, output: 0 });
    expect(config.custom_betas).toEqual(["beta-one", "beta-two"]);
    expect(config.health_score).toEqual({
      initial: 80,
      success_reward: 5,
      rate_limit_penalty: -15,
      failure_penalty: -30,
      recovery_rate_per_hour: 4,
      min_usable: 60,
      max_score: 90,
    });
    expect(config.token_bucket).toEqual({ max_tokens: 75, regeneration_rate_per_minute: 8, initial_tokens: 70 });
    expect(config.toasts).toEqual({ quiet: true, debounce_seconds: 12 });
    expect(config.headers).toEqual({
      emulation_profile: "2.1.0",
      overrides: { "x-test": "value" },
      disable: ["x-remove", "x-other"],
      billing_header: false,
    });
    expect(config.idle_refresh).toEqual({ enabled: false, window_minutes: 90, min_interval_minutes: 45 });
    expect(config.cache_policy).toEqual({
      ttl: "5m",
      ttl_supported: false,
      boundary_marker: true,
      hit_rate_warning_threshold: 1,
    });
    expect(config.fast_mode).toBe(true);
    expect(config.telemetry.emulate_minimal).toBe(true);
    expect(config.usage_toast).toBe(true);
    expect(config.cc_credential_reuse).toEqual({ enabled: true, auto_detect: false, prefer_over_oauth: true });
    expect(config.adaptive_context).toEqual({
      enabled: false,
      escalation_threshold: 200_000,
      deescalation_threshold: 150_000,
    });
    expect(config.willow_mode).toEqual({
      enabled: false,
      idle_threshold_minutes: 45,
      cooldown_minutes: 90,
      min_turns_before_suggest: 5,
    });
    expect(config.token_economy).toEqual({
      token_efficient_tools: true,
      redact_thinking: false,
      context_hint: false,
      conservative: false,
      debug_dump_bodies: true,
      ttl_thinking_strip: false,
      proactive_microcompact: false,
      microcompact_percent: 30,
      microcompact_keep_recent: 64,
      stable_tool_ordering: false,
      deferred_tool_names: ["read", "grep"],
      adaptive_thinking_zero_simple: false,
      tool_result_dedupe: true,
      fast_mode_auto: true,
      trailing_summary_trim: true,
      role_scoped_cache_ttl: false,
      lean_system_non_main: false,
      simple_system_prompt: false,
      cold_cache_only: false,
      idle_tool_result_clearing: false,
      idle_compaction: false,
      idle_compaction_min_tokens: 200_000,
    });
    expect(config.token_economy_strategies).toEqual({
      system_prompt_tailing: true,
      system_prompt_tail_turns: 1,
      system_prompt_tail_max_chars: 50_000,
      tool_deferral: true,
      tool_description_compaction: true,
      adaptive_tool_set: true,
      tool_result_dedupe_session_wide: true,
      haiku_rolling_summary: true,
      stale_read_eviction: true,
      per_tool_class_prune: true,
    });
    expect(config.output_cap).toEqual({ enabled: false, default_max_tokens: 256, escalated_max_tokens: 200_000 });
    expect(config.preconnect).toEqual({ enabled: false, timeout_ms: 100 });
    expect(config.overflow_recovery).toEqual({ enabled: false, safety_margin: 10_000 });
    expect(config.cache_break_detection).toEqual({
      enabled: false,
      alert_threshold: 1_500,
      adaptive_breakpoint: false,
    });
    expect(config.request_classification).toEqual({
      enabled: false,
      background_max_service_retries: 3,
      background_max_should_retries: 4,
    });
    expect(config.token_budget).toEqual({ enabled: true, default: 25_000, completion_threshold: 1 });
    expect(config.microcompact).toEqual({ enabled: false, threshold_percent: 100 });
    expect(config.overload_recovery).toEqual({
      enabled: false,
      default_cooldown_ms: 1_000,
      poll_quota_on_overload: false,
    });
    expect(config.account_management.proactive_disabled).toBe(false);
    expect(config.anti_verbosity).toEqual({ enabled: false });
    expect(config.oauth.sdk_token_useragent).toBe(false);
  });

  // T-1.6 — the retired flag warns, and warns once per process rather than once
  // per config load. A per-load warning would spam a long-running plugin.
  it("T-1.6 warns exactly once per process for the deprecated oauth.sdk_token_useragent", async () => {
    // The latch is module-level, so a sibling test in this file may already have
    // tripped it. Reset the module registry to get a genuinely fresh latch —
    // otherwise this test asserts nothing but its own position in the file.
    vi.resetModules();
    const fresh = await import("./config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { sdk_token_useragent: false } }));

      fresh.loadConfig();
      fresh.loadConfig();
      fresh.loadConfig();

      const hits = warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("oauth.sdk_token_useragent"));
      expect(hits).toHaveLength(1);
      expect(hits[0][0]).toContain("has no effect");
      // The message states the actual behaviour and carries no version literal: the
      // conformance guard in test/conformance/version-literals-retired.test.mjs forbids a
      // 2.1.<NN> literal in production source.
      expect(hits[0][0]).toContain("token requests send the genuine axios fingerprint");
      expect(hits[0][0]).not.toMatch(/2\.1\.\d{2,}/);
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("T-1.6b the deprecated key stays recognised so existing configs keep loading", async () => {
    vi.resetModules();
    const fresh = await import("./config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { sdk_token_useragent: false } }));
      const config = fresh.loadConfig();
      expect(config.oauth.sdk_token_useragent).toBe(false);
      expect(config.oauth.revoke_on_logout).toBe(false);
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("defaults oauth.revoke_on_logout to false and warns for neither default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(false);
      const config = loadConfig();
      expect(config.oauth.revoke_on_logout).toBe(false);
      expect(warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("oauth."))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("honours an explicit oauth.revoke_on_logout opt-in", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { revoke_on_logout: true } }));
      expect(loadConfig().oauth.revoke_on_logout).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("defaults OAuth scope gates for an empty config", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({}));
    const config = loadConfig();
    expect(config.oauth.plugins_scope).toBe(true);
    expect(config.oauth.project_scopes).toEqual([]);
  });

  it("an existing on-disk oauth block without the new keys defaults plugins_scope to on", () => {
    // The validateConfig oauth branch only runs when raw.oauth is an object;
    // without this test a flipped fallback ships a different scope string to
    // every existing user with the whole suite green.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { revoke_on_logout: false } }));
      const config = loadConfig();
      expect(config.oauth.plugins_scope).toBe(true);
      expect(config.oauth.project_scopes).toEqual([]);
      expect(config.oauth.project_scopes).not.toBe(DEFAULT_CONFIG.oauth.project_scopes);
      expect(warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("oauth."))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once across two loads for an explicit oauth.plugins_scope false and still honours it", async () => {
    vi.resetModules();
    const fresh = await import("./config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { plugins_scope: false } }));
      expect(fresh.loadConfig().oauth.plugins_scope).toBe(false);
      expect(fresh.loadConfig().oauth.plugins_scope).toBe(false);
      const hits = warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("oauth.plugins_scope"));
      expect(hits).toHaveLength(1);
      expect(hits[0][0]).toContain("diverges from the genuine client");
      expect(hits[0][0]).not.toMatch(/2\.1\.\d{2,}/);
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("does not warn for an explicit oauth.plugins_scope true", async () => {
    vi.resetModules();
    const fresh = await import("./config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { plugins_scope: true } }));
      expect(fresh.loadConfig().oauth.plugins_scope).toBe(true);
      expect(warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("oauth.plugins_scope"))).toHaveLength(
        0,
      );
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("deprecates oauth.project_scopes: ignored, resolves to empty, warns once when non-empty", async () => {
    vi.resetModules();
    const fresh = await import("./config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(
        JSON.stringify({ oauth: { project_scopes: ["user:projects:read", "user:project:read", "nonsense"] } }),
      );
      expect(fresh.loadConfig().oauth.project_scopes).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("oauth.project_scopes"));
      expect(warn.mock.calls[0][0]).toContain("deprecated");
      fresh.loadConfig();
      fresh.loadConfig();
      expect(warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("oauth.project_scopes"))).toHaveLength(
        1,
      );
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("does not warn for an empty or non-array oauth.project_scopes", async () => {
    vi.resetModules();
    const fresh = await import("./config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { project_scopes: [] } }));
      expect(fresh.loadConfig().oauth.project_scopes).toEqual([]);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { project_scopes: "user:projects:read" } }));
      expect(fresh.loadConfig().oauth.project_scopes).toEqual([]);
      expect(warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("oauth.project_scopes"))).toHaveLength(
        0,
      );
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("does not share default project scope arrays between configs", () => {
    existsSync.mockReturnValue(false);
    const first = loadConfig();
    const second = loadConfig();
    first.oauth.project_scopes.push("user:projects:read");
    expect(second.oauth.project_scopes).toEqual([]);
    expect(DEFAULT_CONFIG.oauth.project_scopes).toEqual([]);
    expect(first.oauth.project_scopes).not.toBe(DEFAULT_CONFIG.oauth.project_scopes);
  });

  it("ignores non-string OAuth project scope entries at the config boundary", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { project_scopes: ["user:projects:read", 42, null] } }));
      expect(loadConfig().oauth.project_scopes).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("honours oauth.plugins_scope without a deprecated user-agent warning", async () => {
    vi.resetModules();
    const fresh = await import("./config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { plugins_scope: true } }));
      expect(fresh.loadConfig().oauth.plugins_scope).toBe(true);
      expect(warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("sdk_token_useragent"))).toHaveLength(
        0,
      );
      // Positive control: the same channel and substring must detect deprecation.
      vi.resetModules();
      const control = await import("./config.mjs");
      readFileSync.mockReturnValue(JSON.stringify({ oauth: { sdk_token_useragent: true } }));
      control.loadConfig();
      expect(warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("sdk_token_useragent"))).toHaveLength(
        1,
      );
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
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

  it("disables signature emulation from OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE=0", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE = "0";
    const config = loadConfig();
    expect(config.signature_emulation.enabled).toBe(false);
  });

  it("disables version fetch from OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION=0", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION = "0";
    const config = loadConfig();
    expect(config.signature_emulation.fetch_claude_code_version_on_startup).toBe(false);
  });

  it("disables prompt compaction from OPENCODE_ANTHROPIC_PROMPT_COMPACTION=off", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION = "off";
    const config = loadConfig();
    expect(config.signature_emulation.prompt_compaction).toBe("off");
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

  // --- adaptive_context config tests ---

  it("has adaptive_context defaults (enabled)", () => {
    existsSync.mockReturnValue(false);
    const config = loadConfig();
    expect(config.adaptive_context).toEqual({
      enabled: true,
      escalation_threshold: 150_000,
      deescalation_threshold: 100_000,
    });
  });

  it("merges adaptive_context from config file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({ adaptive_context: { enabled: true, escalation_threshold: 200_000 } }),
    );
    const config = loadConfig();
    expect(config.adaptive_context.enabled).toBe(true);
    expect(config.adaptive_context.escalation_threshold).toBe(200_000);
    expect(config.adaptive_context.deescalation_threshold).toBe(100_000); // default preserved
  });

  it("clamps adaptive_context thresholds to valid ranges", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        adaptive_context: {
          enabled: true,
          escalation_threshold: 999_999, // above 500K max → clamped
          deescalation_threshold: 1, // below 20K min → clamped
        },
      }),
    );
    const config = loadConfig();
    expect(config.adaptive_context.escalation_threshold).toBe(500_000);
    expect(config.adaptive_context.deescalation_threshold).toBe(20_000);
  });

  it("ignores non-boolean adaptive_context.enabled", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ adaptive_context: { enabled: "yes" } }));
    const config = loadConfig();
    expect(config.adaptive_context.enabled).toBe(true);
  });

  it("ignores non-number adaptive_context thresholds", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        adaptive_context: { escalation_threshold: "high", deescalation_threshold: null },
      }),
    );
    const config = loadConfig();
    expect(config.adaptive_context.escalation_threshold).toBe(150_000);
    expect(config.adaptive_context.deescalation_threshold).toBe(100_000);
  });

  it("enables adaptive context from OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT=1", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT = "1";
    const config = loadConfig();
    expect(config.adaptive_context.enabled).toBe(true);
  });

  it("disables adaptive context from OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT=0", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ adaptive_context: { enabled: true } }));
    process.env.OPENCODE_ANTHROPIC_ADAPTIVE_CONTEXT = "0";
    const config = loadConfig();
    expect(config.adaptive_context.enabled).toBe(false);
  });

  it("applies true-form environment overrides for feature switches", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        signature_emulation: { enabled: false, fetch_claude_code_version_on_startup: false, prompt_compaction: "off" },
        override_model_limits: { enabled: false },
        cc_credential_reuse: { enabled: false },
        account_management: { proactive_disabled: false },
        anti_verbosity: { enabled: false },
      }),
    );
    process.env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE = "true";
    process.env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION = "true";
    process.env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION = "minimal";
    process.env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS = "true";
    process.env.OPENCODE_ANTHROPIC_CC_CREDENTIALS = "true";
    process.env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED = "true";
    process.env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY = "true";

    const config = loadConfig();

    expect(config.signature_emulation).toMatchObject({
      enabled: true,
      fetch_claude_code_version_on_startup: true,
      prompt_compaction: "minimal",
    });
    expect(config.override_model_limits.enabled).toBe(true);
    expect(config.cc_credential_reuse.enabled).toBe(true);
    expect(config.account_management.proactive_disabled).toBe(true);
    expect(config.anti_verbosity.enabled).toBe(true);
  });

  it("applies false-form environment overrides for feature switches", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS = "false";
    process.env.OPENCODE_ANTHROPIC_CC_CREDENTIALS = "false";
    process.env.OPENCODE_ANTHROPIC_PROACTIVE_DISABLED = "false";
    process.env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY = "false";

    const config = loadConfig();

    expect(config.override_model_limits.enabled).toBe(false);
    expect(config.cc_credential_reuse.enabled).toBe(false);
    expect(config.account_management.proactive_disabled).toBe(false);
    expect(config.anti_verbosity).toEqual({ enabled: false });
  });
});

describe("config surface: new keys and defaults", () => {
  const originalEnv = { ...process.env };

  /** Load through a fresh module registry so the one-time warning latches start clear. */
  async function freshLoader(raw) {
    vi.resetModules();
    const fresh = await import("./config.mjs");
    existsSync.mockReturnValue(raw !== undefined);
    if (raw !== undefined) readFileSync.mockReturnValue(JSON.stringify(raw));
    return fresh;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY;
    delete process.env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("pins the new default blocks", () => {
    expect(DEFAULT_CONFIG.default_effort).toBe("medium");
    expect(DEFAULT_CONFIG.fast_mode_legacy_models).toBe(false);
    expect(DEFAULT_CONFIG.signature_emulation.session_correlation).toBe(true);
    expect(DEFAULT_CONFIG.account_affinity).toEqual({ org_locked_thinking: true, strip_thinking_on_org_switch: false });
    expect(DEFAULT_CONFIG.account_features).toEqual({
      dispatch_id: false,
      message_threads: false,
      inline_tools: false,
      advisor: false,
      tool_provenance: false,
    });
    expect(DEFAULT_CONFIG.per_turn_effort).toEqual({
      enabled: true,
      auto_low_short_questions: true,
      short_question_max_chars: 280,
    });
    expect(DEFAULT_CONFIG.system_prompt).toEqual({
      empowerment: "max",
      genuine_opening: true,
      split_stable_volatile: true,
      rewrite_scope: "base",
    });
    expect(DEFAULT_CONFIG.token_economy.cold_cache_only).toBe(false);
    expect(DEFAULT_CONFIG.token_economy.idle_tool_result_clearing).toBe(false);
    expect(DEFAULT_CONFIG.token_economy.idle_compaction).toBe(false);
    expect(DEFAULT_CONFIG.token_economy.idle_compaction_min_tokens).toBe(200_000);
  });

  it("pins the changed defaults in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.oauth.plugins_scope).toBe(true);
    expect(DEFAULT_CONFIG.oauth.project_scopes).toEqual([]);
    expect(DEFAULT_CONFIG.token_economy.lean_system_non_main).toBe(false);
    expect(DEFAULT_CONFIG.output_cap.enabled).toBe(false);
    expect(DEFAULT_CONFIG.signature_emulation.prompt_compaction).toBe("off");
    expect(DEFAULT_CONFIG.anti_verbosity.enabled).toBe(false);
    expect(DEFAULT_CONFIG.token_economy.adaptive_thinking_zero_simple).toBe(false);
  });

  it("applies every new default when the config file is absent or empty", () => {
    existsSync.mockReturnValue(false);
    const absent = loadConfig();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("{}");
    const empty = loadConfig();
    for (const config of [absent, empty]) {
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(config.default_effort).toBe("medium");
      expect(config.anti_verbosity.enabled).toBe(false);
      expect(config.output_cap.enabled).toBe(false);
      expect(config.token_economy.lean_system_non_main).toBe(false);
      expect(config.token_economy.adaptive_thinking_zero_simple).toBe(false);
      expect(config.signature_emulation.prompt_compaction).toBe("off");
    }
  });

  it("applies the changed defaults inside partially specified sub-sections", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        signature_emulation: {},
        token_economy: {},
        output_cap: {},
        anti_verbosity: {},
      }),
    );
    const config = loadConfig();
    expect(config.signature_emulation.prompt_compaction).toBe("off");
    expect(config.signature_emulation.session_correlation).toBe(true);
    expect(config.token_economy.lean_system_non_main).toBe(false);
    expect(config.token_economy.adaptive_thinking_zero_simple).toBe(false);
    expect(config.output_cap.enabled).toBe(false);
    expect(config.anti_verbosity.enabled).toBe(false);
  });

  it("keeps every old default reachable as an explicit opt-in", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        signature_emulation: { prompt_compaction: "minimal" },
        token_economy: { lean_system_non_main: true, adaptive_thinking_zero_simple: true },
        output_cap: { enabled: true },
        anti_verbosity: { enabled: true },
      }),
    );
    const config = loadConfig();
    expect(config.signature_emulation.prompt_compaction).toBe("minimal");
    expect(config.token_economy.lean_system_non_main).toBe(true);
    expect(config.token_economy.adaptive_thinking_zero_simple).toBe(true);
    expect(config.output_cap.enabled).toBe(true);
    expect(config.output_cap.default_max_tokens).toBe(8_000);
    expect(config.anti_verbosity.enabled).toBe(true);
  });

  it("keeps the anti-verbosity and prompt-compaction environment opt-ins working", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY = "1";
    process.env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION = "minimal";
    const config = loadConfig();
    expect(config.anti_verbosity.enabled).toBe(true);
    expect(config.signature_emulation.prompt_compaction).toBe("minimal");
  });

  it("does not let an environment override mutate DEFAULT_CONFIG.anti_verbosity", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_ANTI_VERBOSITY = "true";
    expect(loadConfig().anti_verbosity.enabled).toBe(true);
    expect(DEFAULT_CONFIG.anti_verbosity.enabled).toBe(false);
  });

  it("accepts every default_effort value and normalises case and whitespace", () => {
    for (const effort of ["auto", "low", "medium", "high", "xhigh", "max"]) {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({ default_effort: effort }));
      expect(loadConfig().default_effort).toBe(effort);
    }
    readFileSync.mockReturnValue(JSON.stringify({ default_effort: "  XHigh " }));
    expect(loadConfig().default_effort).toBe("xhigh");
  });

  it("falls back to medium for an invalid default_effort", () => {
    existsSync.mockReturnValue(true);
    for (const bad of ["extreme", "", 3, null, true, ["high"], {}]) {
      readFileSync.mockReturnValue(JSON.stringify({ default_effort: bad }));
      expect(loadConfig().default_effort).toBe("medium");
    }
  });

  it("validates fast_mode_legacy_models as a boolean", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ fast_mode_legacy_models: true }));
    expect(loadConfig().fast_mode_legacy_models).toBe(true);
    readFileSync.mockReturnValue(JSON.stringify({ fast_mode_legacy_models: "yes" }));
    expect(loadConfig().fast_mode_legacy_models).toBe(false);
  });

  it("validates the new token_economy keys and clamps idle_compaction_min_tokens", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        token_economy: {
          cold_cache_only: true,
          idle_tool_result_clearing: true,
          idle_compaction: true,
          idle_compaction_min_tokens: 1,
        },
      }),
    );
    const te = loadConfig().token_economy;
    expect(te.cold_cache_only).toBe(true);
    expect(te.idle_tool_result_clearing).toBe(true);
    expect(te.idle_compaction).toBe(true);
    expect(te.idle_compaction_min_tokens).toBe(100_000);

    readFileSync.mockReturnValue(JSON.stringify({ token_economy: { idle_compaction_min_tokens: 99_999_999 } }));
    expect(loadConfig().token_economy.idle_compaction_min_tokens).toBe(2_000_000);
    readFileSync.mockReturnValue(JSON.stringify({ token_economy: { idle_compaction_min_tokens: 350_000 } }));
    expect(loadConfig().token_economy.idle_compaction_min_tokens).toBe(350_000);
    readFileSync.mockReturnValue(
      JSON.stringify({
        token_economy: {
          cold_cache_only: "yes",
          idle_tool_result_clearing: 1,
          idle_compaction: null,
          idle_compaction_min_tokens: "lots",
        },
      }),
    );
    expect(loadConfig().token_economy).toMatchObject({
      cold_cache_only: false,
      idle_tool_result_clearing: false,
      idle_compaction: false,
      idle_compaction_min_tokens: 200_000,
    });
  });

  it("validates signature_emulation.session_correlation", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ signature_emulation: { session_correlation: false } }));
    expect(loadConfig().signature_emulation.session_correlation).toBe(false);
    readFileSync.mockReturnValue(JSON.stringify({ signature_emulation: { session_correlation: "no" } }));
    expect(loadConfig().signature_emulation.session_correlation).toBe(true);
  });

  it("validates account_affinity and account_features, tolerating partial and malformed sections", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        account_affinity: { org_locked_thinking: false, strip_thinking_on_org_switch: true },
        account_features: {
          dispatch_id: true,
          message_threads: true,
          inline_tools: true,
          advisor: true,
          tool_provenance: true,
        },
      }),
    );
    let config = loadConfig();
    expect(config.account_affinity).toEqual({ org_locked_thinking: false, strip_thinking_on_org_switch: true });
    expect(config.account_features).toEqual({
      dispatch_id: true,
      message_threads: true,
      inline_tools: true,
      advisor: true,
      tool_provenance: true,
    });

    readFileSync.mockReturnValue(
      JSON.stringify({ account_affinity: { org_locked_thinking: "no" }, account_features: { tool_provenance: true } }),
    );
    config = loadConfig();
    expect(config.account_affinity).toEqual({ org_locked_thinking: true, strip_thinking_on_org_switch: false });
    expect(config.account_features).toEqual({ ...DEFAULT_CONFIG.account_features, tool_provenance: true });

    readFileSync.mockReturnValue(JSON.stringify({ account_affinity: "on", account_features: 7, per_turn_effort: [] }));
    config = loadConfig();
    expect(config.account_affinity).toEqual(DEFAULT_CONFIG.account_affinity);
    expect(config.account_features).toEqual(DEFAULT_CONFIG.account_features);
  });

  it("validates per_turn_effort and clamps short_question_max_chars", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        per_turn_effort: { enabled: false, auto_low_short_questions: false, short_question_max_chars: 500.4 },
      }),
    );
    expect(loadConfig().per_turn_effort).toEqual({
      enabled: false,
      auto_low_short_questions: false,
      short_question_max_chars: 500,
    });
    readFileSync.mockReturnValue(JSON.stringify({ per_turn_effort: { short_question_max_chars: 1 } }));
    expect(loadConfig().per_turn_effort.short_question_max_chars).toBe(20);
    readFileSync.mockReturnValue(JSON.stringify({ per_turn_effort: { short_question_max_chars: 1e9 } }));
    expect(loadConfig().per_turn_effort.short_question_max_chars).toBe(4_000);
    readFileSync.mockReturnValue(JSON.stringify({ per_turn_effort: { short_question_max_chars: "long" } }));
    expect(loadConfig().per_turn_effort).toEqual(DEFAULT_CONFIG.per_turn_effort);
  });

  it("validates system_prompt flags and rewrite_scope", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        system_prompt: {
          genuine_opening: false,
          split_stable_volatile: false,
          rewrite_scope: "all",
        },
      }),
    );
    expect(loadConfig().system_prompt).toEqual({
      empowerment: "max",
      genuine_opening: false,
      split_stable_volatile: false,
      rewrite_scope: "all",
    });
    readFileSync.mockReturnValue(
      JSON.stringify({
        system_prompt: { genuine_opening: "no", split_stable_volatile: 0, rewrite_scope: "everywhere" },
      }),
    );
    expect(loadConfig().system_prompt).toEqual(DEFAULT_CONFIG.system_prompt);
  });

  it("accepts every empowerment package name without a warning", async () => {
    const fresh = await freshLoader({ system_prompt: { empowerment: "off" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const name of ["off", "power", "research", "max"]) {
        readFileSync.mockReturnValue(JSON.stringify({ system_prompt: { empowerment: name } }));
        expect(fresh.loadConfig().system_prompt.empowerment).toBe(name);
      }
      readFileSync.mockReturnValue(JSON.stringify({ system_prompt: { empowerment: " Power " } }));
      expect(fresh.loadConfig().system_prompt.empowerment).toBe("power");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to max with a one-time warning for an unknown empowerment package", async () => {
    const fresh = await freshLoader({ system_prompt: { empowerment: "ultra" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(fresh.loadConfig().system_prompt.empowerment).toBe("max");
      expect(fresh.loadConfig().system_prompt.empowerment).toBe("max");
      readFileSync.mockReturnValue(JSON.stringify({ system_prompt: { empowerment: 42 } }));
      expect(fresh.loadConfig().system_prompt.empowerment).toBe("max");
      const hits = warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("system_prompt.empowerment"));
      expect(hits).toHaveLength(1);
      expect(hits[0][0]).not.toMatch(/2\.1\.\d{2,}/);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps known empowerment ids in order, dedupes, and warns once about unknown ones", async () => {
    const fresh = await freshLoader({
      system_prompt: { empowerment: ["proof", "Ownership", "bogus", "proof", 7, "initiative"] },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(fresh.loadConfig().system_prompt.empowerment).toEqual(["proof", "ownership", "initiative"]);
      expect(fresh.loadConfig().system_prompt.empowerment).toEqual(["proof", "ownership", "initiative"]);
      const hits = warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes("system_prompt.empowerment"));
      expect(hits).toHaveLength(1);
      expect(hits[0][0]).toContain("bogus");
      expect(fresh.EMPOWERMENT_BLOCK_IDS).toEqual([
        "ownership",
        "depth",
        "tool_power",
        "persistence",
        "recommendations",
        "proof",
        "research",
        "context_economy",
        "communication",
        "initiative",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts an empty empowerment array and an array of all valid ids silently", async () => {
    const fresh = await freshLoader({ system_prompt: { empowerment: [] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(fresh.loadConfig().system_prompt.empowerment).toEqual([]);
      readFileSync.mockReturnValue(JSON.stringify({ system_prompt: { empowerment: ["depth", "research"] } }));
      expect(fresh.loadConfig().system_prompt.empowerment).toEqual(["depth", "research"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("defines the empowerment packages: max is all ten blocks, research is power plus research", async () => {
    const fresh = await freshLoader();
    const { EMPOWERMENT_PACKAGES, EMPOWERMENT_BLOCK_IDS } = fresh;
    expect(EMPOWERMENT_PACKAGES.off).toEqual([]);
    expect(EMPOWERMENT_PACKAGES.power).toEqual([
      "ownership",
      "depth",
      "persistence",
      "recommendations",
      "context_economy",
      "initiative",
    ]);
    expect(EMPOWERMENT_PACKAGES.research).toEqual([...EMPOWERMENT_PACKAGES.power, "research"]);
    expect(EMPOWERMENT_PACKAGES.max).toEqual(EMPOWERMENT_BLOCK_IDS);
    expect(EMPOWERMENT_BLOCK_IDS).toHaveLength(10);
  });

  it("does not share the new default sub-objects between configs", () => {
    existsSync.mockReturnValue(false);
    const first = loadConfig();
    first.account_affinity.org_locked_thinking = false;
    first.account_features.advisor = true;
    first.per_turn_effort.enabled = false;
    first.system_prompt.rewrite_scope = "all";
    const second = loadConfig();
    expect(second.account_affinity.org_locked_thinking).toBe(true);
    expect(second.account_features.advisor).toBe(false);
    expect(second.per_turn_effort.enabled).toBe(true);
    expect(second.system_prompt.rewrite_scope).toBe("base");
    expect(DEFAULT_CONFIG.account_affinity.org_locked_thinking).toBe(true);
  });

  it("still loads an existing config file that carries unknown or legacy keys", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        account_selection_strategy: "round-robin",
        some_future_key: { nested: true },
        token_economy: { context_hint: false, conservative: false },
        oauth: { revoke_on_logout: true },
      }),
    );
    const config = loadConfig();
    expect(config.account_selection_strategy).toBe("round-robin");
    expect(config.token_economy.conservative).toBe(false);
    expect(config.oauth.revoke_on_logout).toBe(true);
    expect(config.oauth.plugins_scope).toBe(true);
    expect(config.default_effort).toBe("medium");
  });
});

describe("loadRawConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns parsed values without applying validation", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ failure_ttl_seconds: -10, custom_key: "preserved" }));

    expect(loadRawConfig()).toEqual({ failure_ttl_seconds: -10, custom_key: "preserved" });
  });

  it("returns an empty object for missing, malformed, or non-object config", () => {
    existsSync.mockReturnValueOnce(false).mockReturnValue(true);
    readFileSync.mockReturnValueOnce("invalid json").mockReturnValueOnce("[]");

    expect(loadRawConfig()).toEqual({});
    expect(loadRawConfig()).toEqual({});
    expect(loadRawConfig()).toEqual({});
  });
});

describe("token_economy_strategies.haiku_rolling_summary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("defaults to false in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.token_economy_strategies.haiku_rolling_summary).toBe(false);
  });

  it("defaults to false when config file omits the flag", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({}));
    const cfg = loadConfig();
    expect(cfg.token_economy_strategies.haiku_rolling_summary).toBe(false);
  });

  it("accepts true when explicitly set in config file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ token_economy_strategies: { haiku_rolling_summary: true } }));
    const cfg = loadConfig();
    expect(cfg.token_economy_strategies.haiku_rolling_summary).toBe(true);
  });

  it("falls back to default on non-boolean value (graceful, does not throw)", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ token_economy_strategies: { haiku_rolling_summary: "yes" } }));
    const cfg = loadConfig();
    expect(cfg.token_economy_strategies.haiku_rolling_summary).toBe(false);
  });
});

describe("token_economy_strategies.stale_read_eviction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("defaults to false in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.token_economy_strategies.stale_read_eviction).toBe(false);
  });

  it("accepts true when explicitly set", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ token_economy_strategies: { stale_read_eviction: true } }));
    const cfg = loadConfig();
    expect(cfg.token_economy_strategies.stale_read_eviction).toBe(true);
  });

  it("falls back to default on non-boolean value", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ token_economy_strategies: { stale_read_eviction: 1 } }));
    const cfg = loadConfig();
    expect(cfg.token_economy_strategies.stale_read_eviction).toBe(false);
  });
});

describe("token_economy_strategies.per_tool_class_prune", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("defaults to false in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.token_economy_strategies.per_tool_class_prune).toBe(false);
  });

  it("accepts true when explicitly set", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ token_economy_strategies: { per_tool_class_prune: true } }));
    const cfg = loadConfig();
    expect(cfg.token_economy_strategies.per_tool_class_prune).toBe(true);
  });

  it("falls back to default on non-boolean value", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ token_economy_strategies: { per_tool_class_prune: "on" } }));
    const cfg = loadConfig();
    expect(cfg.token_economy_strategies.per_tool_class_prune).toBe(false);
  });
});
