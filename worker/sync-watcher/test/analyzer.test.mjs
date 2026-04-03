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

// ─── Trivial diff ─────────────────────────────────────────────────────────────

describe("analyzeContractDiff — trivial diff", () => {
  it("version-only change → auto-pr without LLM", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({});

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(false);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("version + buildTime change → auto-pr without LLM", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    extracted.buildTime = "2026-04-02T21:58:41Z";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({});

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(false);
  });

  it("sdkVersion change → auto-pr without LLM (auto-patchable)", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    extracted.sdkVersion = "0.209.0";
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({});

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(false);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("experimentalBetas change → auto-pr without LLM (auto-patchable)", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.version = "2.1.91";
    extracted.experimentalBetas = ["new-feature-2026-05-01"];
    const diff = diffContracts(BASE_CONTRACT, extracted);
    const env = makeEnvWithAI({});

    const result = await analyzeContractDiff(env, BASE_CONTRACT, extracted, diff);

    expect(result.action).toBe("auto-pr");
    expect(result.llmInvoked).toBe(false);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

// ─── Non-trivial diff — LLM invoked ──────────────────────────────────────────
// NOTE: sdkVersion and beta flag changes are now auto-patchable and bypass the LLM.
// These tests must use fields that are NOT auto-patchable (critical fields like
// oauthTokenUrl, billingSalt, identityStrings) to exercise the LLM path.

describe("analyzeContractDiff — non-trivial diff, LLM safe", () => {
  it("LLM says safe + confidence >= 0.8 → auto-pr", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.oauthTokenUrl = "https://api.anthropic.com/v1/oauth/token"; // critical — triggers LLM
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

  it("LLM says safe but confidence < 0.8 → create-issue", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.oauthTokenUrl = "https://api.anthropic.com/v1/oauth/token"; // critical — triggers LLM
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
// Use critical fields (billingSalt, oauthTokenUrl) to force the LLM path.

describe("analyzeContractDiff — LLM failure fallback", () => {
  it("LLM throws → create-issue with error captured", async () => {
    const extracted = clone(BASE_CONTRACT);
    extracted.billingSalt = "aabbccddeeff"; // critical — triggers LLM
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
    extracted.billingSalt = "aabbccddeeff"; // critical — triggers LLM
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
    extracted.billingSalt = "aabbccddeeff"; // critical — triggers LLM
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
