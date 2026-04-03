/**
 * Delivery: creates auto-PRs for trivial changes and issues for non-trivial.
 *
 * Handles idempotent delivery — checks for existing PR/Issue before creating.
 * For auto-PRs, generates file patches using regex replacement on current file content.
 *
 * @module delivery
 */

import {
  findExistingPR,
  findExistingIssue,
  getBranchSha,
  createBranch,
  getFileContent,
  updateFile,
  createPR,
  updatePRBody,
  createIssue,
  updateIssueBody,
} from "./github.mjs";
import { summarizeDiff } from "./differ.mjs";

/**
 * @typedef {import('./types.mjs').ExtractedContract} ExtractedContract
 * @typedef {import('./types.mjs').ContractDiff} ContractDiff
 * @typedef {import('./analyzer.mjs').AnalysisResult} AnalysisResult
 */

/**
 * @typedef {Object} DeliveryResult
 * @property {"pr"|"issue"} type
 * @property {number} number - PR or issue number
 * @property {string} url - HTML URL
 * @property {boolean} created - true if newly created, false if updated existing
 */

/**
 * Deliver a PR or Issue based on the analysis result.
 *
 * @param {object} env
 * @param {string} env.GITHUB_TOKEN
 * @param {string} env.GITHUB_REPO
 * @param {ExtractedContract} baseline
 * @param {ExtractedContract} extracted
 * @param {AnalysisResult} analysis
 * @returns {Promise<DeliveryResult>}
 */
export async function deliver(env, baseline, extracted, analysis) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  const version = extracted.version ?? "unknown";

  if (analysis.action === "auto-pr") {
    return createOrUpdateAutoPR(token, repo, version, baseline, extracted, analysis.diff);
  } else {
    return createOrUpdateIssue(token, repo, version, baseline, extracted, analysis);
  }
}

/**
 * Create or update an auto-PR for trivial version changes.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} version
 * @param {ExtractedContract} baseline
 * @param {ExtractedContract} extracted
 * @param {ContractDiff} diff
 * @returns {Promise<DeliveryResult>}
 */
async function createOrUpdateAutoPR(token, repo, version, baseline, extracted, diff) {
  const branchName = `auto/sync-${version}`;
  const prTitle = `chore: sync emulation to Claude Code v${version}`;

  // Check for existing PR
  const existing = await findExistingPR(token, repo, branchName);
  if (existing) {
    // Update PR body with latest diff summary
    const body = buildPRBody(version, baseline, extracted, diff);
    await updatePRBody(token, repo, existing.number, body);
    return { type: "pr", number: existing.number, url: existing.html_url, created: false };
  }

  // Get base branch SHA (master)
  const baseSha = await getBranchSha(token, repo, "master");

  // Create branch
  try {
    await createBranch(token, repo, branchName, baseSha);
  } catch (err) {
    // Branch may already exist from a previous failed attempt — continue
    if (!err.message?.includes("already exists") && !err.message?.includes("Reference already exists")) {
      throw err;
    }
  }

  // Patch files
  await patchFiles(token, repo, branchName, baseline, extracted);

  // Create PR
  const prBody = buildPRBody(version, baseline, extracted, diff);
  const { number, html_url } = await createPR(token, repo, {
    title: prTitle,
    body: prBody,
    head: branchName,
    base: "master",
  });

  return { type: "pr", number, url: html_url, created: true };
}

/**
 * Create or update a GitHub issue for non-trivial changes.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} version
 * @param {ExtractedContract} baseline
 * @param {ExtractedContract} extracted
 * @param {AnalysisResult} analysis
 * @returns {Promise<DeliveryResult>}
 */
async function createOrUpdateIssue(token, repo, version, baseline, extracted, analysis) {
  const titleSearch = `Claude Code v${version}`;

  // Check for existing issue
  const existing = await findExistingIssue(token, repo, titleSearch);
  if (existing) {
    const body = buildIssueBody(version, baseline, extracted, analysis);
    await updateIssueBody(token, repo, existing.number, body);
    return { type: "issue", number: existing.number, url: existing.html_url, created: false };
  }

  const title = `[Upstream] Claude Code v${version} — non-trivial changes detected`;
  const body = buildIssueBody(version, baseline, extracted, analysis);
  const { number, html_url } = await createIssue(token, repo, {
    title,
    body,
    labels: ["upstream-sync", "needs-review"],
  });

  return { type: "issue", number, url: html_url, created: true };
}

// ─── File patching ────────────────────────────────────────────────────────────

/**
 * Patch all relevant files for an auto-patchable change.
 * Covers: version, buildTime, sdkVersion, beta flag sets.
 * Reads current content, applies regex replacements, commits each file.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} branch
 * @param {ExtractedContract} baseline
 * @param {ExtractedContract} extracted
 */
async function patchFiles(token, repo, branch, baseline, extracted) {
  const oldVersion = baseline.version;
  const newVersion = extracted.version;
  const oldBuildTime = baseline.buildTime;
  const newBuildTime = extracted.buildTime;
  const oldSdkVersion = baseline.sdkVersion;
  const newSdkVersion = extracted.sdkVersion;

  if (!oldVersion || !newVersion) return;

  const sdkChanged = oldSdkVersion && newSdkVersion && oldSdkVersion !== newSdkVersion;
  const experimentalChanged =
    extracted.experimentalBetas &&
    JSON.stringify([...(baseline.experimentalBetas ?? [])].sort()) !==
      JSON.stringify([...(extracted.experimentalBetas ?? [])].sort());
  const bedrockChanged =
    extracted.bedrockUnsupported &&
    JSON.stringify([...(baseline.bedrockUnsupported ?? [])].sort()) !==
      JSON.stringify([...(extracted.bedrockUnsupported ?? [])].sort());
  const alwaysOnChanged =
    extracted.alwaysOnBetas &&
    JSON.stringify([...(baseline.alwaysOnBetas ?? [])].sort()) !==
      JSON.stringify([...(extracted.alwaysOnBetas ?? [])].sort());

  // ── index.mjs patches ──────────────────────────────────────────────────────
  await patchFile(
    token,
    repo,
    branch,
    "index.mjs",
    (content) => {
      let patched = content;

      // FALLBACK_CLAUDE_CLI_VERSION
      patched = patched.replace(
        new RegExp(`(FALLBACK_CLAUDE_CLI_VERSION\\s*=\\s*)"${escapeRegex(oldVersion)}"`, "g"),
        `$1"${newVersion}"`,
      );

      // CLAUDE_CODE_BUILD_TIME
      if (oldBuildTime && newBuildTime) {
        patched = patched.replace(
          new RegExp(`(CLAUDE_CODE_BUILD_TIME\\s*=\\s*)"${escapeRegex(oldBuildTime)}"`, "g"),
          `$1"${newBuildTime}"`,
        );
      }

      // SDK comment lines referencing the CLI version
      patched = patched.replace(/bundled with Claude Code v[\d.]+\./g, `bundled with Claude Code v${newVersion}.`);
      patched = patched.replace(
        /all versions \.[\d]+-\.[\d]+\./g,
        `all versions .${oldVersion.split(".")[2]}-.${newVersion.split(".")[2]}.`,
      );

      // Add new CLI→SDK map entry (if not already present)
      if (newSdkVersion && !content.includes(`["${newVersion}", "${newSdkVersion}"]`)) {
        patched = patched.replace(
          /const CLI_TO_SDK_VERSION = new Map\(\[/,
          `const CLI_TO_SDK_VERSION = new Map([\n  ["${newVersion}", "${newSdkVersion}"],`,
        );
      }

      // ANTHROPIC_SDK_VERSION constant — update when SDK version changes
      if (sdkChanged) {
        patched = patched.replace(
          new RegExp(`(ANTHROPIC_SDK_VERSION\\s*=\\s*)"${escapeRegex(oldSdkVersion)}"`, "g"),
          `$1"${newSdkVersion}"`,
        );
        // Also update the SDK version comment line
        patched = patched.replace(
          new RegExp(
            `(bundled with Claude Code v[\\d.]+\\.\\s*\\n.*Verified by extracting VERSION=)"${escapeRegex(oldSdkVersion)}"`,
            "gs",
          ),
          `$1"${newSdkVersion}"`,
        );
      }

      // EXPERIMENTAL_BETA_FLAGS set — replace entire set literal
      if (experimentalChanged) {
        const newFlags = [...(extracted.experimentalBetas ?? [])].sort();
        const newSetBody = newFlags.map((f) => `  "${f}",`).join("\n");
        patched = patched.replace(
          /const EXPERIMENTAL_BETA_FLAGS = new Set\(\[[\s\S]*?\]\);/,
          `const EXPERIMENTAL_BETA_FLAGS = new Set([\n${newSetBody}\n]);`,
        );
      }

      // BEDROCK_UNSUPPORTED_BETAS set — replace entire set literal
      if (bedrockChanged) {
        const newFlags = [...(extracted.bedrockUnsupported ?? [])].sort();
        const newSetBody = newFlags.map((f) => `  "${f}",`).join("\n");
        patched = patched.replace(
          /const BEDROCK_UNSUPPORTED_BETAS = new Set\(\[[\s\S]*?\]\);/,
          `const BEDROCK_UNSUPPORTED_BETAS = new Set([\n${newSetBody}\n]);`,
        );
      }

      // Always-on beta flag constants — add new named constants for added flags
      if (alwaysOnChanged) {
        const oldSet = new Set(baseline.alwaysOnBetas ?? []);
        const newSet = new Set(extracted.alwaysOnBetas ?? []);
        const added = [...newSet].filter((f) => !oldSet.has(f));
        for (const flag of added) {
          // Only add if not already present in the file
          if (!patched.includes(`"${flag}"`)) {
            // Derive a SCREAMING_SNAKE_CASE name: "fast-mode-2026-02-01" → FAST_MODE_BETA_FLAG
            const constName =
              flag
                .replace(/-\d{4}-\d{2}-\d{2}$/, "") // strip date suffix
                .toUpperCase()
                .replace(/-/g, "_") + "_BETA_FLAG";
            // Insert after the last existing _BETA_FLAG constant line
            patched = patched.replace(
              /(const \w+_BETA_FLAG = "[^"]+";)\n(?!const \w+_BETA_FLAG)/,
              `$1\nconst ${constName} = "${flag}";\n`,
            );
          }
        }
      }

      return patched;
    },
    `chore: update FALLBACK_CLAUDE_CLI_VERSION to ${newVersion}`,
  );

  // ── index.test.mjs patches ─────────────────────────────────────────────────
  await patchFile(
    token,
    repo,
    branch,
    "index.test.mjs",
    (content) => content.replaceAll(`claude-cli/${oldVersion}`, `claude-cli/${newVersion}`),
    `chore: update test user-agent assertion to ${newVersion}`,
  );

  // ── test/conformance/regression.test.mjs patches ──────────────────────────
  await patchFile(
    token,
    repo,
    branch,
    "test/conformance/regression.test.mjs",
    (content) => content.replaceAll(`v${oldVersion}`, `v${newVersion}`).replaceAll(oldVersion, newVersion),
    `chore: update regression test version assertions to ${newVersion}`,
  );

  // ── CHANGELOG.md — prepend new entry ──────────────────────────────────────
  await patchFile(
    token,
    repo,
    branch,
    "CHANGELOG.md",
    (content) => {
      const today = new Date().toISOString().slice(0, 10);
      const entry = buildChangelogEntry(newVersion, oldVersion, extracted, today);
      const firstHeading = content.match(/^## /m);
      if (firstHeading && firstHeading.index !== undefined) {
        return content.slice(0, firstHeading.index) + entry + content.slice(firstHeading.index);
      }
      return content + "\n" + entry;
    },
    `docs: add CHANGELOG entry for v${newVersion}`,
  );

  // ── package.json version bump (patch increment) ───────────────────────────
  await patchFile(
    token,
    repo,
    branch,
    "package.json",
    (content) => {
      return content.replace(/"version":\s*"[\d.]+"/, (match) => {
        const current = match.match(/"version":\s*"([\d.]+)"/)[1];
        const parts = current.split(".");
        if (parts.length !== 3) return match;
        const patch = parseInt(parts[2], 10);
        if (isNaN(patch)) return match;
        parts[2] = String(patch + 1);
        return `"version": "${parts.join(".")}"`;
      });
    },
    `chore: bump package version for ${newVersion} sync`,
  );

  // ── worker/sync-watcher/src/extractor.mjs — update KNOWN_* sets ───────────
  if (experimentalChanged || bedrockChanged || alwaysOnChanged) {
    await patchFile(
      token,
      repo,
      branch,
      "worker/sync-watcher/src/extractor.mjs",
      (content) => {
        let patched = content;

        if (alwaysOnChanged) {
          const newFlags = [...(extracted.alwaysOnBetas ?? [])].sort();
          const newSetBody = newFlags.map((f) => `  "${f}", // YYYYMMDD or YYYY-MM-DD format`).join("\n");
          patched = patched.replace(
            /const KNOWN_ALWAYS_ON_BETAS = new Set\(\[[\s\S]*?\]\);/,
            `const KNOWN_ALWAYS_ON_BETAS = new Set([\n${newSetBody}\n]);`,
          );
        }

        if (bedrockChanged) {
          const newFlags = [...(extracted.bedrockUnsupported ?? [])].sort();
          const newSetBody = newFlags.map((f) => `  "${f}",`).join("\n");
          patched = patched.replace(
            /const KNOWN_BEDROCK_UNSUPPORTED = new Set\(\[[\s\S]*?\]\);/,
            `const KNOWN_BEDROCK_UNSUPPORTED = new Set([\n${newSetBody}\n]);`,
          );
        }

        if (experimentalChanged) {
          const newFlags = [...(extracted.experimentalBetas ?? [])].sort();
          const newSetBody = newFlags.map((f) => `  "${f}",`).join("\n");
          patched = patched.replace(
            /const KNOWN_EXPERIMENTAL = new Set\(\[[\s\S]*?\]\);/,
            `const KNOWN_EXPERIMENTAL = new Set([\n${newSetBody}\n]);`,
          );
        }

        return patched;
      },
      `chore: sync KNOWN_* beta sets in extractor for v${newVersion}`,
    );
  }

  // ── worker/sync-watcher/src/seed.mjs — update baseline seed ───────────────
  // Update the version string in the seed so future worker restarts use the
  // correct baseline without requiring a manual re-seed.
  await patchFile(
    token,
    repo,
    branch,
    "worker/sync-watcher/src/seed.mjs",
    (content) => {
      let patched = content;

      // Version string in seed
      patched = patched.replace(new RegExp(`(version:\\s*)"${escapeRegex(oldVersion)}"`, "g"), `$1"${newVersion}"`);

      // buildTime in seed
      if (oldBuildTime && newBuildTime) {
        patched = patched.replace(
          new RegExp(`(buildTime:\\s*)"${escapeRegex(oldBuildTime)}"`, "g"),
          `$1"${newBuildTime}"`,
        );
      }

      // sdkVersion in seed
      if (sdkChanged) {
        patched = patched.replace(
          new RegExp(`(sdkVersion:\\s*)"${escapeRegex(oldSdkVersion)}"`, "g"),
          `$1"${newSdkVersion}"`,
        );
      }

      // Beta arrays in seed — replace array literals for changed sets
      if (experimentalChanged) {
        const newFlags = [...(extracted.experimentalBetas ?? [])].sort();
        const arrayLiteral = `[${newFlags.map((f) => `"${f}"`).join(", ")}]`;
        // Match the experimentalBetas array in the seed object
        patched = patched.replace(/experimentalBetas:\s*\[[^\]]*\]/, `experimentalBetas: ${arrayLiteral}`);
      }

      if (bedrockChanged) {
        const newFlags = [...(extracted.bedrockUnsupported ?? [])].sort();
        const arrayLiteral = `[${newFlags.map((f) => `"${f}"`).join(", ")}]`;
        patched = patched.replace(/bedrockUnsupported:\s*\[[^\]]*\]/, `bedrockUnsupported: ${arrayLiteral}`);
      }

      if (alwaysOnChanged) {
        const newFlags = [...(extracted.alwaysOnBetas ?? [])].sort();
        const arrayLiteral = `[${newFlags.map((f) => `"${f}"`).join(", ")}]`;
        patched = patched.replace(/alwaysOnBetas:\s*\[[^\]]*\]/, `alwaysOnBetas: ${arrayLiteral}`);
      }

      return patched;
    },
    `chore: update seed baseline to v${newVersion}`,
  );
}

/**
 * Read, patch, and commit a single file.
 *
 * @param {string} token
 * @param {string} repo
 * @param {string} branch
 * @param {string} filePath
 * @param {function(string): string} patchFn
 * @param {string} commitMessage
 */
async function patchFile(token, repo, branch, filePath, patchFn, commitMessage) {
  let fileInfo;
  try {
    fileInfo = await getFileContent(token, repo, filePath, branch);
  } catch (err) {
    // File may not exist — skip silently
    if (err.message?.includes("404") || err.message?.includes("Not Found")) return;
    throw err;
  }

  const patched = patchFn(fileInfo.content);
  if (patched === fileInfo.content) return; // No change needed

  await updateFile(token, repo, filePath, branch, patched, fileInfo.sha, commitMessage);
}

// ─── Body builders ────────────────────────────────────────────────────────────

/**
 * Build PR body markdown.
 */
function buildPRBody(version, baseline, extracted, diff) {
  const diffSummary = summarizeDiff(diff);
  return `## Automated sync: Claude Code v${version}

This PR was auto-generated by the upstream sync watcher.

**Previous version:** ${baseline.version}
**New version:** ${version}
**Build time:** ${extracted.buildTime ?? "unknown"}
**SDK version:** ${extracted.sdkVersion ?? "unknown"}

### Changes

${diffSummary}

---

*Auto-generated by sync-watcher. Review and merge if tests pass.*`;
}

/**
 * Build Issue body markdown with LLM analysis.
 */
function buildIssueBody(version, baseline, extracted, analysis) {
  const { diff, llmAnalysis, llmError } = analysis;
  const diffSummary = summarizeDiff(diff);

  let analysisSection = "";
  if (llmAnalysis) {
    analysisSection = `
### LLM Analysis (Kimi K2.5)

**Risk level:** ${llmAnalysis.risk_level}
**Safe for auto-PR:** ${llmAnalysis.safe_for_auto_pr ? "Yes" : "No"}
**Confidence:** ${(llmAnalysis.confidence * 100).toFixed(0)}%

**Summary:** ${llmAnalysis.summary}

#### Per-field analysis

${llmAnalysis.changes.map((c) => `- **${c.field}** (${c.impact}): ${c.description}\n  Action: ${c.action_required}`).join("\n")}

${
  llmAnalysis.recommended_file_changes?.length
    ? `#### Recommended file changes\n\n${llmAnalysis.recommended_file_changes.map((f) => `- \`${f.file}\`: ${f.description}`).join("\n")}`
    : ""
}`;
  } else if (llmError) {
    analysisSection = `\n### LLM Analysis\n\n⚠️ LLM analysis failed: ${llmError}\n\nManual review required.`;
  }

  return `## Upstream: Claude Code v${version} — Non-trivial Changes

This issue was auto-generated by the upstream sync watcher because non-trivial contract changes were detected.

**Previous version:** ${baseline.version}
**New version:** ${version}
**Build time:** ${extracted.buildTime ?? "unknown"}

### Contract Diff

${diffSummary}
${analysisSection}

---

*Auto-generated by sync-watcher. Assign to a maintainer for review.*`;
}

/**
 * Build CHANGELOG entry.
 */
function buildChangelogEntry(newVersion, oldVersion, extracted, date) {
  // Use the package version that will result after the bump — we don't know it here,
  // so we use a [sync-X.Y.Z] tag that follows keepachangelog format.
  return `## [sync-${newVersion}] — ${date}

### Emulation Sync — v${newVersion}

- **Bumped to Claude Code v${newVersion}** — version, build_time (${extracted.buildTime ?? "unknown"}), SDK ${extracted.sdkVersion ?? "unknown"}
- Synced from v${oldVersion}

`;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
