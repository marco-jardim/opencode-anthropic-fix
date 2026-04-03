import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { deliver } from "../src/delivery.mjs";
import { diffContracts } from "../src/differ.mjs";

// Import internal patchFiles-exercising helpers via deliver with controlled mocks

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock github.mjs functions
vi.mock("../src/github.mjs", () => ({
  findExistingPR: vi.fn(),
  findExistingIssue: vi.fn(),
  getBranchSha: vi.fn().mockResolvedValue("abc123sha"),
  createBranch: vi.fn().mockResolvedValue(undefined),
  getFileContent: vi.fn().mockResolvedValue({ content: "// placeholder", sha: "file-sha" }),
  updateFile: vi.fn().mockResolvedValue(undefined),
  createPR: vi.fn().mockResolvedValue({ number: 42, html_url: "https://github.com/example/pr/42" }),
  updatePRBody: vi.fn().mockResolvedValue(undefined),
  createIssue: vi.fn().mockResolvedValue({ number: 7, html_url: "https://github.com/example/issues/7" }),
  updateIssueBody: vi.fn().mockResolvedValue(undefined),
}));

import {
  findExistingPR,
  findExistingIssue,
  createPR,
  updatePRBody,
  createIssue,
  updateIssueBody,
} from "../src/github.mjs";

const ENV = { GITHUB_TOKEN: "test-token", GITHUB_REPO: "owner/repo" };

const BASE = {
  version: "2.1.90",
  buildTime: "2026-04-01T22:53:10Z",
  sdkVersion: "0.208.0",
  sdkToken: "sdk-abc",
  billingSalt: "59cf53e54c78",
  clientId: "uuid-1",
  allBetaFlags: ["oauth-2025-04-20"],
  alwaysOnBetas: ["oauth-2025-04-20"],
  experimentalBetas: [],
  bedrockUnsupported: [],
  claudeAiScopes: ["user:profile"],
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

function makeTrivialAnalysis(extracted) {
  const diff = diffContracts(BASE, extracted);
  return { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };
}

function makeNonTrivialAnalysis(extracted, llmAnalysis = null, llmError = null) {
  const diff = diffContracts(BASE, extracted);
  return {
    action: "create-issue",
    llmAnalysis,
    llmInvoked: true,
    llmError,
    diff,
  };
}

// ─── Auto-PR path ─────────────────────────────────────────────────────────────

describe("deliver — auto-PR path", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null); // No existing PR
  });

  it("creates a new PR when none exists", async () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);

    const result = await deliver(ENV, BASE, extracted, analysis);

    expect(result.type).toBe("pr");
    expect(result.number).toBe(42);
    expect(result.created).toBe(true);
    expect(createPR).toHaveBeenCalledWith(
      "test-token",
      "owner/repo",
      expect.objectContaining({ title: "chore: sync emulation to Claude Code v2.1.91" }),
    );
  });

  it("PR title and body contain correct version", async () => {
    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);

    await deliver(ENV, BASE, extracted, analysis);

    const call = createPR.mock.calls[0];
    expect(call[2].title).toContain("2.1.91");
    expect(call[2].body).toContain("2.1.91");
    expect(call[2].body).toContain("2.1.90"); // shows previous version
  });

  it("updates existing PR body when PR already exists", async () => {
    findExistingPR.mockResolvedValue({ number: 99, html_url: "https://github.com/pr/99" });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);

    const result = await deliver(ENV, BASE, extracted, analysis);

    expect(result.type).toBe("pr");
    expect(result.number).toBe(99);
    expect(result.created).toBe(false);
    expect(createPR).not.toHaveBeenCalled();
    expect(updatePRBody).toHaveBeenCalledWith("test-token", "owner/repo", 99, expect.any(String));
  });
});

// ─── Issue path ───────────────────────────────────────────────────────────────

describe("deliver — issue path", () => {
  beforeEach(() => {
    findExistingIssue.mockResolvedValue(null);
  });

  it("creates issue for non-trivial change", async () => {
    const extracted = clone(BASE);
    extracted.oauthTokenUrl = "https://new.anthropic.com/v1/oauth/token";
    const analysis = makeNonTrivialAnalysis(extracted, {
      safe_for_auto_pr: false,
      risk_level: "critical",
      summary: "OAuth endpoint changed.",
      changes: [
        { field: "oauthTokenUrl", description: "changed", impact: "breaking", action_required: "update lib/oauth.mjs" },
      ],
      confidence: 0.99,
    });

    const result = await deliver(ENV, BASE, extracted, analysis);

    expect(result.type).toBe("issue");
    expect(result.number).toBe(7);
    expect(result.created).toBe(true);
    expect(createIssue).toHaveBeenCalledWith(
      "test-token",
      "owner/repo",
      expect.objectContaining({
        title: expect.stringContaining("Claude Code v"),
        labels: expect.arrayContaining(["upstream-sync", "needs-review"]),
      }),
    );
  });

  it("issue body contains LLM analysis when available", async () => {
    const extracted = clone(BASE);
    extracted.oauthTokenUrl = "https://new.anthropic.com/v1/oauth/token";
    const llmAnalysis = {
      safe_for_auto_pr: false,
      risk_level: "critical",
      summary: "Critical OAuth change detected.",
      changes: [],
      recommended_file_changes: [{ file: "lib/oauth.mjs", description: "Update token URL" }],
      confidence: 0.97,
    };
    const analysis = makeNonTrivialAnalysis(extracted, llmAnalysis);

    await deliver(ENV, BASE, extracted, analysis);

    const body = createIssue.mock.lastCall[2].body;
    expect(body).toContain("Critical OAuth change detected.");
    expect(body).toContain("lib/oauth.mjs");
    expect(body).toContain("97%");
  });

  it("issue body contains fallback note when LLM failed", async () => {
    const extracted = clone(BASE);
    extracted.sdkVersion = "0.209.0";
    const analysis = makeNonTrivialAnalysis(extracted, null, "Workers AI service unavailable");

    await deliver(ENV, BASE, extracted, analysis);

    const body = createIssue.mock.lastCall[2].body;
    expect(body).toContain("unavailable");
    expect(body).toContain("Manual review required");
  });

  it("updates existing issue body when issue already exists", async () => {
    findExistingIssue.mockResolvedValue({ number: 15, html_url: "https://github.com/issues/15" });
    const extracted = clone(BASE);
    extracted.sdkVersion = "0.209.0";
    const analysis = makeNonTrivialAnalysis(extracted);

    const result = await deliver(ENV, BASE, extracted, analysis);

    expect(result.number).toBe(15);
    expect(result.created).toBe(false);
    expect(createIssue).not.toHaveBeenCalled();
    expect(updateIssueBody).toHaveBeenCalled();
  });
});

// ─── File patching logic ──────────────────────────────────────────────────────
// These tests verify that patchFiles applies correct regex substitutions by
// giving getFileContent realistic content and inspecting what updateFile receives.

import { getFileContent, updateFile } from "../src/github.mjs";

describe("patchFiles — index.mjs content", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("replaces FALLBACK_CLAUDE_CLI_VERSION", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content: 'const FALLBACK_CLAUDE_CLI_VERSION = "2.1.90";',
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);
    await deliver(ENV, BASE, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall).toBeTruthy();
    expect(indexCall[4]).toContain('"2.1.91"');
    expect(indexCall[4]).not.toContain('"2.1.90"');
  });

  it("replaces CLAUDE_CODE_BUILD_TIME", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content: 'const CLAUDE_CODE_BUILD_TIME = "2026-04-01T22:53:10Z";',
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.buildTime = "2026-04-02T21:58:41Z";
    const baseWithTime = { ...BASE, buildTime: "2026-04-01T22:53:10Z" };
    const diff = diffContracts(baseWithTime, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseWithTime, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall[4]).toContain('"2026-04-02T21:58:41Z"');
    expect(indexCall[4]).not.toContain('"2026-04-01T22:53:10Z"');
  });

  it("inserts new CLI→SDK map entry", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content: 'const CLI_TO_SDK_VERSION = new Map([\n  ["2.1.90", "0.208.0"],\n]);',
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);
    await deliver(ENV, BASE, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall[4]).toContain('["2.1.91", "0.208.0"]');
  });

  it("does not insert duplicate map entry if already present", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content: 'const CLI_TO_SDK_VERSION = new Map([\n  ["2.1.91", "0.208.0"],\n  ["2.1.90", "0.208.0"],\n]);',
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);
    await deliver(ENV, BASE, extracted, analysis);

    // updateFile should NOT be called for index.mjs (no change)
    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall).toBeUndefined();
  });
});

describe("patchFiles — index.test.mjs content", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("replaces user-agent version in test file", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.test.mjs") {
        return {
          content: 'expect(headers.get("user-agent")).toContain("claude-cli/2.1.90");',
          sha: "sha-test",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);
    await deliver(ENV, BASE, extracted, analysis);

    const testCall = updateFile.mock.calls.find((c) => c[2] === "index.test.mjs");
    expect(testCall).toBeTruthy();
    expect(testCall[4]).toContain("claude-cli/2.1.91");
    expect(testCall[4]).not.toContain("claude-cli/2.1.90");
  });
});

describe("patchFiles — CHANGELOG.md content", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("inserts new entry before the first ## heading", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "CHANGELOG.md") {
        return {
          content: "# Changelog\n\nAll notable changes.\n\n## [0.0.44] — 2026-04-01\n\n- prev entry\n",
          sha: "sha-cl",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);
    await deliver(ENV, BASE, extracted, analysis);

    const clCall = updateFile.mock.calls.find((c) => c[2] === "CHANGELOG.md");
    expect(clCall).toBeTruthy();
    const body = clCall[4];
    // New entry should appear before the existing ## heading
    const newIdx = body.indexOf("## [sync-2.1.91]");
    const oldIdx = body.indexOf("## [0.0.44]");
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });
});

describe("patchFiles — sdkVersion change", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("replaces ANTHROPIC_SDK_VERSION when sdkVersion changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content: 'const ANTHROPIC_SDK_VERSION = "0.208.0";',
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.sdkVersion = "0.209.0";
    const baseNew = { ...BASE, version: "2.1.91" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall).toBeTruthy();
    expect(indexCall[4]).toContain('"0.209.0"');
    expect(indexCall[4]).not.toContain('"0.208.0"');
  });
});

describe("patchFiles — experimentalBetas change", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("replaces EXPERIMENTAL_BETA_FLAGS set when experimentalBetas changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content:
            'const EXPERIMENTAL_BETA_FLAGS = new Set([\n  "web-search-2025-03-05",\n  "fast-mode-2026-02-01",\n]);',
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.experimentalBetas = ["fast-mode-2026-02-01", "new-feature-2026-05-01", "web-search-2025-03-05"];
    const baseNew = { ...BASE, version: "2.1.91" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall).toBeTruthy();
    expect(indexCall[4]).toContain('"new-feature-2026-05-01"');
    expect(indexCall[4]).toContain("EXPERIMENTAL_BETA_FLAGS");
  });

  it("replaces BEDROCK_UNSUPPORTED_BETAS set when bedrockUnsupported changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content:
            'const BEDROCK_UNSUPPORTED_BETAS = new Set([\n  "files-api-2025-04-14",\n  "interleaved-thinking-2025-05-14",\n]);',
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.bedrockUnsupported = ["files-api-2025-04-14", "new-bedrock-flag-2026-06-01"];
    const baseNew = { ...BASE, version: "2.1.91" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall).toBeTruthy();
    expect(indexCall[4]).toContain('"new-bedrock-flag-2026-06-01"');
    expect(indexCall[4]).not.toContain('"interleaved-thinking-2025-05-14"');
  });
});

describe("patchFiles — extractor.mjs KNOWN_* sets", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("patches KNOWN_EXPERIMENTAL in extractor.mjs when experimentalBetas changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/extractor.mjs") {
        return {
          content: 'const KNOWN_EXPERIMENTAL = new Set([\n  "web-search-2025-03-05",\n]);',
          sha: "sha-extractor",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.experimentalBetas = ["new-feature-2026-05-01", "web-search-2025-03-05"];
    const baseNew = { ...BASE, version: "2.1.91" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const extractorCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/extractor.mjs");
    expect(extractorCall).toBeTruthy();
    expect(extractorCall[4]).toContain('"new-feature-2026-05-01"');
    expect(extractorCall[4]).toContain("KNOWN_EXPERIMENTAL");
  });

  it("patches KNOWN_ALWAYS_ON_BETAS in extractor.mjs when alwaysOnBetas changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/extractor.mjs") {
        return {
          content:
            'const KNOWN_ALWAYS_ON_BETAS = new Set([\n  "oauth-2025-04-20", // YYYYMMDD or YYYY-MM-DD format\n]);',
          sha: "sha-extractor",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.alwaysOnBetas = ["fast-mode-2026-02-01", "oauth-2025-04-20"];
    const baseNew = { ...BASE, version: "2.1.91", alwaysOnBetas: ["oauth-2025-04-20"] };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const extractorCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/extractor.mjs");
    expect(extractorCall).toBeTruthy();
    expect(extractorCall[4]).toContain('"fast-mode-2026-02-01"');
    expect(extractorCall[4]).toContain("KNOWN_ALWAYS_ON_BETAS");
  });

  it("patches KNOWN_BEDROCK_UNSUPPORTED in extractor.mjs when bedrockUnsupported changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/extractor.mjs") {
        return {
          content: 'const KNOWN_BEDROCK_UNSUPPORTED = new Set([\n  "files-api-2025-04-14",\n]);',
          sha: "sha-extractor",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.bedrockUnsupported = ["files-api-2025-04-14", "new-bedrock-flag-2026-06-01"];
    const baseNew = { ...BASE, version: "2.1.91", bedrockUnsupported: ["files-api-2025-04-14"] };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const extractorCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/extractor.mjs");
    expect(extractorCall).toBeTruthy();
    expect(extractorCall[4]).toContain('"new-bedrock-flag-2026-06-01"');
    expect(extractorCall[4]).toContain("KNOWN_BEDROCK_UNSUPPORTED");
  });
});

describe("patchFiles — alwaysOnBetas constant insertion", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("inserts new SCREAMING_SNAKE_CASE _BETA_FLAG constant when a new always-on beta is added", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content: [
            'const OAUTH_BETA_FLAG = "oauth-2025-04-20";',
            'const CLAUDE_CODE_BETA_FLAG = "claude-code-20250219";',
            "// some other code",
          ].join("\n"),
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    // Add a new always-on beta not already present in the file
    extracted.alwaysOnBetas = ["fast-mode-2026-02-01", "oauth-2025-04-20", "claude-code-20250219"];
    const baseNew = { ...BASE, version: "2.1.91" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    expect(indexCall).toBeTruthy();
    // Derived name: "fast-mode-2026-02-01" → strip date → "fast-mode" → "FAST_MODE" + "_BETA_FLAG"
    expect(indexCall[4]).toContain("FAST_MODE_BETA_FLAG");
    expect(indexCall[4]).toContain('"fast-mode-2026-02-01"');
  });

  it("does not insert a duplicate constant when the flag value is already present in the file", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "index.mjs") {
        return {
          content: [
            'const OAUTH_BETA_FLAG = "oauth-2025-04-20";',
            // fast-mode is already there
            'const FAST_MODE_BETA_FLAG = "fast-mode-2026-02-01";',
          ].join("\n"),
          sha: "sha-index",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.alwaysOnBetas = ["fast-mode-2026-02-01", "oauth-2025-04-20"];
    const baseNew = { ...BASE, version: "2.1.91", alwaysOnBetas: ["oauth-2025-04-20"] };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const indexCall = updateFile.mock.calls.find((c) => c[2] === "index.mjs");
    // No duplicate insertion — content may or may not change for other reasons (version bump etc.)
    // But FAST_MODE_BETA_FLAG should appear exactly once
    if (indexCall) {
      const matches = (indexCall[4].match(/FAST_MODE_BETA_FLAG/g) ?? []).length;
      expect(matches).toBe(1);
    }
  });
});

describe("patchFiles — seed.mjs baseline", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("updates version and buildTime in seed.mjs", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/seed.mjs") {
        return {
          content: 'const SEED = { version: "2.1.90", buildTime: "2026-04-01T22:53:10Z" };',
          sha: "sha-seed",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    extracted.buildTime = "2026-04-02T21:58:41Z";
    const baseNew = { ...BASE, version: "2.1.90", buildTime: "2026-04-01T22:53:10Z" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const seedCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/seed.mjs");
    expect(seedCall).toBeTruthy();
    expect(seedCall[4]).toContain('"2.1.91"');
    expect(seedCall[4]).toContain('"2026-04-02T21:58:41Z"');
    expect(seedCall[4]).not.toContain('"2.1.90"');
  });

  it("updates sdkVersion in seed.mjs when sdkVersion changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/seed.mjs") {
        return {
          content: 'const SEED = { version: "2.1.91", sdkVersion: "0.208.0" };',
          sha: "sha-seed",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.sdkVersion = "0.209.0";
    const baseNew = { ...BASE, version: "2.1.91" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const seedCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/seed.mjs");
    expect(seedCall).toBeTruthy();
    expect(seedCall[4]).toContain('"0.209.0"');
    expect(seedCall[4]).not.toContain('"0.208.0"');
  });

  it("updates experimentalBetas array in seed.mjs when experimentalBetas changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/seed.mjs") {
        return {
          content: 'const SEED = { version: "2.1.91", experimentalBetas: ["web-search-2025-03-05"] };',
          sha: "sha-seed",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.experimentalBetas = ["new-feature-2026-05-01", "web-search-2025-03-05"];
    const baseNew = { ...BASE, version: "2.1.91" };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const seedCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/seed.mjs");
    expect(seedCall).toBeTruthy();
    expect(seedCall[4]).toContain('"new-feature-2026-05-01"');
    expect(seedCall[4]).toContain("experimentalBetas");
  });

  it("updates bedrockUnsupported array in seed.mjs when bedrockUnsupported changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/seed.mjs") {
        return {
          content: 'const SEED = { version: "2.1.91", bedrockUnsupported: ["files-api-2025-04-14"] };',
          sha: "sha-seed",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.bedrockUnsupported = ["files-api-2025-04-14", "new-bedrock-flag-2026-06-01"];
    const baseNew = { ...BASE, version: "2.1.91", bedrockUnsupported: ["files-api-2025-04-14"] };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const seedCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/seed.mjs");
    expect(seedCall).toBeTruthy();
    expect(seedCall[4]).toContain('"new-bedrock-flag-2026-06-01"');
    expect(seedCall[4]).toContain("bedrockUnsupported");
  });

  it("updates alwaysOnBetas array in seed.mjs when alwaysOnBetas changes", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "worker/sync-watcher/src/seed.mjs") {
        return {
          content: 'const SEED = { version: "2.1.91", alwaysOnBetas: ["oauth-2025-04-20"] };',
          sha: "sha-seed",
        };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.92";
    extracted.alwaysOnBetas = ["fast-mode-2026-02-01", "oauth-2025-04-20"];
    const baseNew = { ...BASE, version: "2.1.91", alwaysOnBetas: ["oauth-2025-04-20"] };
    const diff = diffContracts(baseNew, extracted);
    const analysis = { action: "auto-pr", llmAnalysis: null, llmInvoked: false, llmError: null, diff };

    await deliver(ENV, baseNew, extracted, analysis);

    const seedCall = updateFile.mock.calls.find((c) => c[2] === "worker/sync-watcher/src/seed.mjs");
    expect(seedCall).toBeTruthy();
    expect(seedCall[4]).toContain('"fast-mode-2026-02-01"');
    expect(seedCall[4]).toContain("alwaysOnBetas");
  });
});

describe("patchFiles — package.json version bump", () => {
  beforeEach(() => {
    findExistingPR.mockResolvedValue(null);
  });

  it("increments patch version", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "package.json") {
        return { content: '{"name":"opencode-anthropic-fix","version":"0.0.44"}', sha: "sha-pkg" };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);
    await deliver(ENV, BASE, extracted, analysis);

    const pkgCall = updateFile.mock.calls.find((c) => c[2] === "package.json");
    expect(pkgCall).toBeTruthy();
    // JSON output preserves the space from the regex replacement: "version": "X.Y.Z"
    expect(pkgCall[4]).toContain('"version": "0.0.45"');
  });

  it("skips version bump when version string is malformed (NaN guard)", async () => {
    getFileContent.mockImplementation(async (token, repo, filePath) => {
      if (filePath === "package.json") {
        return { content: '{"name":"test","version":"1.0"}', sha: "sha-pkg" };
      }
      return { content: "", sha: "sha-other" };
    });

    const extracted = clone(BASE);
    extracted.version = "2.1.91";
    const analysis = makeTrivialAnalysis(extracted);
    await deliver(ENV, BASE, extracted, analysis);

    // The match won't even fire for "1.0" since our regex requires [\d.]+ with exactly a version
    // patchFile returns early if content is unchanged — so updateFile is not called
    const pkgCall = updateFile.mock.calls.find((c) => c[2] === "package.json");
    // Either not called (no change) or content unchanged — no "NaN" in output
    if (pkgCall) {
      expect(pkgCall[4]).not.toContain("NaN");
    }
  });
});
