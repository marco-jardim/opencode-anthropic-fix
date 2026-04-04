/**
 * LLM prompts and structured output schema for Kimi K2.5 contract analysis.
 *
 * Prompt version: 2.0 (2026-04-04) — LLM is now the sole decision maker.
 * Model: @cf/moonshotai/kimi-k2.5
 *
 * @module prompts
 */

/**
 * JSON schema for structured analysis output.
 * Kimi K2.5 supports structured outputs via response_format.
 */
export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    safe_for_auto_pr: {
      type: "boolean",
      description:
        "True ONLY if ALL changed fields are in the auto-patchable set (version, buildTime, sdkVersion, allBetaFlags, alwaysOnBetas, experimentalBetas, bedrockUnsupported) AND the changes are purely additive or cosmetic. False for ANY change to oauth endpoints, identity strings, billingSalt, clientId, scopes, or systemPromptBoundary.",
    },
    risk_level: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
      description:
        "low=version/timestamp only, medium=SDK or beta flags, high=behavioral or feature change, critical=security/auth/identity change.",
    },
    summary: {
      type: "string",
      description:
        "One paragraph (max 400 chars) summarizing what changed and why it matters for the opencode-anthropic-fix package.",
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", description: "Contract field name e.g. 'allBetaFlags'" },
          description: { type: "string", description: "What changed in this field" },
          impact: {
            type: "string",
            enum: ["none", "cosmetic", "functional", "breaking"],
            description: "Impact on opencode-anthropic-fix behavior",
          },
          action_required: {
            type: "string",
            description: "What the maintainer needs to do, or 'auto-patched by worker' if mechanical",
          },
        },
        required: ["field", "description", "impact", "action_required"],
      },
      description: "Per-field change analysis",
    },
    recommended_file_changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "Relative file path e.g. 'index.mjs'" },
          description: { type: "string", description: "What to change and why" },
        },
        required: ["file", "description"],
      },
      description: "Files that need manual updates (omit files the worker patches automatically)",
    },
    confidence: {
      type: "number",
      description:
        "Confidence score 0.0–1.0. Set below 0.85 if the diff is ambiguous, unexpected, or you are unsure about any field. Must be >= 0.85 for safe_for_auto_pr: true to result in an auto-PR.",
    },
  },
  required: ["safe_for_auto_pr", "risk_level", "summary", "changes", "confidence"],
};

/**
 * Build the system prompt for contract analysis.
 *
 * @returns {string}
 */
export function buildSystemPrompt() {
  return `You are a senior engineer maintaining "opencode-anthropic-fix", an npm package (OpenCode plugin) that authenticates API requests against Anthropic's Claude API using OAuth — precisely mimicking the HTTP behavior of the official @anthropic-ai/claude-code CLI.

The package must stay bit-for-bit identical to Claude Code in:
- HTTP headers: User-Agent (claude-cli/<version>), anthropic-beta, x-app, x-stainless-*, x-anthropic-billing-header
- OAuth flow: same client_id, same scopes, same token/revoke endpoints, same redirect URI
- System prompt shaping: same identity strings, same billing block, same __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ marker
- Beta flags: always-on set, experimental set, bedrock-unsupported set

When a new @anthropic-ai/claude-code is released, a worker extracts key constants ("the contract") and diffs them against the baseline. You receive that diff and must decide:

1. Is this safe to auto-PR? (worker patches files automatically)
2. Or does it need a human issue?

AUTO-PR RULES — safe_for_auto_pr: true ONLY when ALL of the following hold:
- Every changed field is in: version, buildTime, sdkVersion, allBetaFlags, alwaysOnBetas, experimentalBetas, bedrockUnsupported
- No field in the CRITICAL set changed: billingSalt, clientId, oauthTokenUrl, oauthRevokeUrl, oauthRedirectUri, oauthConsoleHost, claudeAiScopes, consoleScopes, identityStrings, systemPromptBoundary
- confidence >= 0.85

For a pure version+buildTime bump, safe_for_auto_pr: true, risk_level: "low", confidence: 0.95.
For sdkVersion or beta flag changes (but nothing critical), safe_for_auto_pr: true, risk_level: "medium", confidence: 0.90.
For any CRITICAL field change, safe_for_auto_pr: false regardless of confidence.

Key files the auto-patcher updates:
- index.mjs: FALLBACK_CLAUDE_CLI_VERSION, CLAUDE_CODE_BUILD_TIME, CLI_TO_SDK_VERSION map, ANTHROPIC_SDK_VERSION, EXPERIMENTAL_BETA_FLAGS set, BEDROCK_UNSUPPORTED_BETAS set, always-on beta flag constants
- index.test.mjs: user-agent version assertion
- test/conformance/regression.test.mjs: version assertions
- CHANGELOG.md: new entry prepended
- package.json: patch version bump
- worker/sync-watcher/src/extractor.mjs: KNOWN_* beta sets
- worker/sync-watcher/src/seed.mjs: baseline seed

Files the auto-patcher does NOT touch: lib/oauth.mjs, lib/config.mjs (those need human review for CRITICAL changes).

Produce a JSON response matching the schema exactly. Be conservative — when in doubt, set safe_for_auto_pr: false.`;
}

/**
 * Build the user prompt for a specific contract diff.
 *
 * @param {import('./types.mjs').ExtractedContract} baseline - Current known contract
 * @param {import('./types.mjs').ExtractedContract} extracted - Newly extracted contract
 * @param {import('./types.mjs').ContractDiff} diff - Structured diff object
 * @returns {string}
 */
export function buildUserPrompt(baseline, extracted, diff) {
  const diffLines = [];
  for (const [field, { from, to }] of Object.entries(diff.fields)) {
    diffLines.push(`  ${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  }

  return `A new version of @anthropic-ai/claude-code has been detected.

## Diff Summary
Severity: ${diff.severity}
Changed fields (${Object.keys(diff.fields).length}):
${diffLines.length > 0 ? diffLines.join("\n") : "  (none)"}

## Baseline Contract (current v${baseline.version})
\`\`\`json
${JSON.stringify(baseline, null, 2)}
\`\`\`

## Extracted Contract (new v${extracted.version ?? "unknown"})
\`\`\`json
${JSON.stringify(extracted, null, 2)}
\`\`\`

Analyze this diff and return a structured JSON response. Focus on what the maintainer needs to do to keep opencode-anthropic-fix in sync.`;
}
