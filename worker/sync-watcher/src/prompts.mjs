/**
 * LLM prompts and structured output schema for Kimi K2.5 contract analysis.
 *
 * Prompt version: 1.0 (2026-04-03)
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
        "True if the changes are safe to auto-apply via PR without human review. Only true for low-risk changes (version bump, timestamp, same SDK version, no behavioral changes).",
    },
    risk_level: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
      description:
        "Overall risk level. low=cosmetic only, medium=minor behavioral, high=feature flag or auth change, critical=security or auth endpoint change.",
    },
    summary: {
      type: "string",
      description: "One paragraph (max 400 chars) summarizing what changed and why it matters.",
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", description: "Contract field name e.g. 'allBetaFlags'" },
          description: {
            type: "string",
            description: "What changed in this field",
          },
          impact: {
            type: "string",
            enum: ["none", "cosmetic", "functional", "breaking"],
            description: "Impact on opencode-anthropic-fix behavior",
          },
          action_required: {
            type: "string",
            description: "What the maintainer needs to do (or 'none' if auto-patchable)",
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
          description: {
            type: "string",
            description: "What to change and why",
          },
        },
        required: ["file", "description"],
      },
      description: "Files that need to be updated and what to change in them",
    },
    confidence: {
      type: "number",
      description: "Confidence score 0-1. Low confidence (<0.6) means the diff is ambiguous or the model is unsure.",
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
  return `You are a senior engineer maintaining "opencode-anthropic-fix", an npm package that acts as an OpenCode plugin to authenticate requests against Anthropic's API using OAuth.

The package precisely mimics the HTTP behavior of Claude Code (the official @anthropic-ai/claude-code CLI):
- It sends identical headers: User-Agent, anthropic-beta, x-app, x-stainless-*, x-anthropic-billing-header
- It uses the same OAuth flow: same client ID, same scopes, same token endpoints
- It shapes system prompts identically: same identity strings, same billing block, same boundary marker
- It tracks the exact same beta flags (always-on, experimental, bedrock-unsupported sets)

When Anthropic releases a new version of @anthropic-ai/claude-code, the package must be synced. Your job is to analyze a contract diff (extracted constants from the bundle) and determine:
1. Whether the changes are safe to auto-apply (trivial: version/timestamp bumps only)
2. The risk level of any non-trivial changes
3. What files in the codebase need to be updated and how

Key files in the codebase:
- index.mjs: FALLBACK_CLAUDE_CLI_VERSION, CLAUDE_CODE_BUILD_TIME, CLI_TO_SDK_VERSION map, beta flag constants
- lib/oauth.mjs: OAuth endpoints, scopes
- lib/config.mjs: CLIENT_ID
- index.test.mjs, test/conformance/regression.test.mjs: version/beta assertions

You must produce a JSON response matching the provided schema exactly. Be conservative: when in doubt, set safe_for_auto_pr: false and confidence below 0.7.`;
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
