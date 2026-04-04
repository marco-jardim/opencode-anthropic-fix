import { describe, it, expect, vi, afterEach } from "vitest";
import { analyzeContractDiff } from "../src/analyzer.mjs";
import { diffContracts } from "../src/differ.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE_CONTRACT = {
  version: "2.1.90",
  buildTime: "2026-04-01T22:53:10Z",
  sdkVersion: "0.208.0",
  sdkToken: "sdk-abc",
  billingSalt: "59cf53e54c78",
  clientId: "uuid-1",
  allBetaFlags: ["oauth-2025-04-20", "claude-code-20250219"],
  alwaysOnBetas: ["oauth-2025-04-20", "claude-code-20250219"],
  experimentalBetas: [],
  bedrockUnsupported: ["oauth-2025-04-20"],
  claudeAiScopes: ["user:profile", "user:inference"],
  consoleScopes: ["org:create_api_key"],
  oauthTokenUrl: "https://platform.claude.com/v1/oauth/token",
  oauthRevokeUrl: "https://platform.claude.com/v1/oauth/revoke",
  oauthRedirectUri: "https://platform.claude.com/oauth/code/callback",
  oauthConsoleHost: "platform.claude.com",
  identityStrings: ["You are Claude Code, Anthropic's official CLI for Claude."],
  systemPromptBoundary: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeEnvWithAI(aiResponse) {
  return {
    AI_MODEL: "@cf/moonshotai/kimi-k2.5",
    AI: {
      run: vi.fn().mockResolvedValue({ response: JSON.stringify(aiResponse) }),
    },
  };
}

// ─── No change ───────────────────────────────────────────────────────────────

describe("analyzeContractDiff — no change", () => {
  it("returns auto-pr without invoking LLM when diff.changed is false", async () => {
    const diff = diffContracts(BASE_CONTRACT, clone(BASE_CONTRACT));
    const env = makeEnvWithAI({});
    const result = await analyzeContractDiff(env, BASE_CONTRACT, clone(BASE_CONTRACT), diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(false);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

// ─── Auto-patchable diffs — LLM always invoked ───────────────────────────────
// version, buildTime, sdkVersion, experimentalBetas are auto-patchable fields,
// but the LLM is the sole decision maker — it is ALWAYS invoked for any changed diff.

describe("analyzeContractDiff — auto-patchable diff, LLM invoked", () => {
  it("version-only change → LLM invoked, auto-pr when LLM says safe + high confidence", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "low",
      summary: "Pure version bump with no other changes.",
      changes: [
        {
          field: "version",
          description: "bumped to 2.1.91",
          impact: "cosmetic",
          action_required: "auto-patched by worker",
        },
      ],
      confidence: 0.95,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(true);
    expect(env.AI.run).toHaveBeenCalledOnce();
    expect(result.llmError).toBeNull();
  });

  it("version + buildTime change → LLM invoked, auto-pr when LLM says safe", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    extracted.buildTime = "2026-04-02T21:58:41Z";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "low",
      summary: "Version and build timestamp bumped.",
      changes: [
        {
          field: "version",
          description: "bumped to 2.1.91",
          impact: "cosmetic",
          action_required: "auto-patched by worker",
        },
        {
          field: "buildTime",
          description: "timestamp updated",
          impact: "none",
          action_required: "auto-patched by worker",
        },
      ],
      confidence: 0.95,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(true);
    expect(env.AI.run).toHaveBeenCalledOnce();
  });

  it("sdkVersion change → LLM invoked, auto-pr when LLM says safe", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    extracted.sdkVersion = "0.209.0";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "medium",
      summary: "SDK version bumped, no auth or identity changes.",
      changes: [
        { field: "version", description: "bumped", impact: "cosmetic", action_required: "auto-patched by worker" },
        {
          field: "sdkVersion",
          description: "bumped to 0.209.0",
          impact: "functional",
          action_required: "auto-patched by worker",
        },
      ],
      confidence: 0.9,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(true);
    expect(env.AI.run).toHaveBeenCalledOnce();
  });

  it("experimentalBetas change → LLM invoked, auto-pr when LLM says safe", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    extracted.experimentalBetas = ["new-feature-2026-05-01"];
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "medium",
      summary: "New experimental beta flag added, no critical field changes.",
      changes: [
        { field: "version", description: "bumped", impact: "cosmetic", action_required: "auto-patched by worker" },
        {
          field: "experimentalBetas",
          description: "new flag added",
          impact: "functional",
          action_required: "auto-patched by worker",
        },
      ],
      confidence: 0.9,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(true);
    expect(env.AI.run).toHaveBeenCalledOnce();
  });
});

// ─── Changed diff — LLM decision gates ───────────────────────────────────────

describe("analyzeContractDiff — changed diff, LLM gates action", () => {
  it("LLM says safe + confidence >= 0.85 → auto-pr", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.oauthTokenUrl = "https://api.anthropic.com/v1/oauth/token";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "low",
      summary: "OAuth token URL domain changed but is still anthropic.com.",
      changes: [
        {
          field: "oauthTokenUrl",
          description: "domain updated",
          impact: "cosmetic",
          action_required: "update lib/oauth.mjs",
        },
      ],
      confidence: 0.95,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(true);
    expect(result.llmAnalysis.safe_for_auto_pr).toBe(true);
    expect(result.llmError).toBeNull();
  });

  it("LLM says safe but confidence < 0.85 → create-issue", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.oauthTokenUrl = "https://api.anthropic.com/v1/oauth/token";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "medium",
      summary: "Not sure about this change.",
      changes: [],
      confidence: 0.5,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("create-issue");
    expect(result.llmInvoked).toBe(true);
  });

  it("LLM says safe but confidence exactly at threshold (0.85) → auto-pr", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "low",
      summary: "Version bump at boundary confidence.",
      changes: [
        { field: "version", description: "bumped", impact: "cosmetic", action_required: "auto-patched by worker" },
      ],
      confidence: 0.85,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(true);
  });

  it("LLM says safe but confidence just below threshold (0.849) → create-issue", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: true,
      risk_level: "low",
      summary: "Version bump, borderline confidence.",
      changes: [
        { field: "version", description: "bumped", impact: "cosmetic", action_required: "auto-patched by worker" },
      ],
      confidence: 0.849,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("create-issue");
    expect(result.llmInvoked).toBe(true);
  });

  it("LLM says not safe → create-issue", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.oauthTokenUrl = "https://new.anthropic.com/v1/oauth/token";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      safe_for_auto_pr: false,
      risk_level: "critical",
      summary: "OAuth endpoint changed — requires careful review.",
      changes: [
        {
          field: "oauthTokenUrl",
          description: "Endpoint changed",
          impact: "breaking",
          action_required: "update lib/oauth.mjs",
        },
      ],
      confidence: 0.98,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("create-issue");
    expect(result.llmAnalysis.risk_level).toBe("critical");
  });
});

// ─── LLM failure fallback ────────────────────────────────────────────────────

describe("analyzeContractDiff — LLM failure fallback", () => {
  it("LLM throws → create-issue with error captured", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.billingSalt = "aabbccddeeff";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = {
      AI_MODEL: "@cf/moonshotai/kimi-k2.5",
      AI: {
        run: vi.fn().mockRejectedValue(new Error("Workers AI service unavailable")),
      },
    };

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("create-issue");
    expect(result.llmInvoked).toBe(true);
    expect(result.llmAnalysis).toBeNull();
    expect(result.llmError).toContain("unavailable");
  });

  it("LLM returns invalid JSON → create-issue", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.billingSalt = "aabbccddeeff";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = {
      AI_MODEL: "@cf/moonshotai/kimi-k2.5",
      AI: {
        run: vi.fn().mockResolvedValue({ response: "not-valid-json{{{" }),
      },
    };

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("create-issue");
    expect(result.llmError).toContain("invalid JSON");
  });

  it("LLM returns response missing required field → create-issue", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.billingSalt = "aabbccddeeff";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({
      // Missing safe_for_auto_pr
      risk_level: "low",
      summary: "...",
      changes: [],
      confidence: 0.9,
    });

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("create-issue");
    expect(result.llmError).toContain("safe_for_auto_pr");
  });
});
