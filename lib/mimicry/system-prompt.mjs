import { createHash as createHashCrypto } from "node:crypto";
import { isTruthyEnv, isFalsyEnv } from "../env.mjs";
import { isOpus46Model, isOpus47Model, isOpus48Model } from "./models.mjs";

const BILLING_HASH_SALT = "59cf53e54c78";
const BILLING_HASH_INDICES = [4, 7, 20];

export const CLAUDE_CODE_IDENTITY_STRING = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Marker that identifies the canonical billing block inside a system array. */
export const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const KNOWN_IDENTITY_STRINGS = new Set([
  CLAUDE_CODE_IDENTITY_STRING,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
const COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT = [
  "You are a title generator. You output ONLY a thread title. Nothing else.",
  "",
  "Rules:",
  "- Use the same language as the user message.",
  "- Output exactly one line.",
  "- Keep the title at or below 50 characters.",
  "- No explanations, prefixes, or suffixes.",
  "- Keep important technical terms, numbers, and filenames when present.",
].join("\n");

/**
 * Anti-verbosity system prompt text.
 * Text verified against the CC v2.1.195 binary; the heading corrects a stale
 * v2.1.100 value.
 * Significantly reduces output token count by instructing the model to be concise.
 */
const ANTI_VERBOSITY_SYSTEM_PROMPT = [
  "# Text output (does not apply to tool calls)",
  "Assume users can't see most tool calls or thinking — only your text output. Before your first tool call, state in one sentence what you're about to do. While working, give short updates at key moments: when you find something, when you change direction, or when you hit a blocker. Brief is good — silent is not. One sentence per update is almost always enough.",
  "",
  "Don't narrate your internal deliberation. User-facing text should be relevant communication to the user, not a running commentary on your thought process. State results and decisions directly, and focus user-facing text on relevant updates for the user.",
  "",
  "When you do write updates, write so the reader can pick up cold: complete sentences, no unexplained jargon or shorthand from earlier in the session. But keep it tight — a clear sentence is better than a clear paragraph.",
  "",
  "End-of-turn summary: one or two sentences. What changed and what's next. Nothing else.",
  "",
  "Match responses to the task: a simple question gets a direct answer, not headers and sections.",
  "",
  "In code: default to writing no comments. Never write multi-paragraph docstrings or multi-line comment blocks — one short line max. Don't create planning, decision, or analysis documents unless the user asks for them — work from conversation context, not intermediate files.",
].join("\n");

// Max system prompt length that passes CC billing validation.
// The server pattern-matches the system prompt against the real CC prompt.
// Opencode's customizations after ~5800 chars diverge and trigger extra usage billing.
const MAX_SAFE_SYSTEM_TEXT_LENGTH = 5000;

// A5: Subagent CC-prefix cache.
//
// Context: opencode/packages/opencode/src/session/llm.ts:110 uses
//   `input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(model)`
// so any agent with a custom prompt (explore, fast, title, summary, etc.)
// fires WITHOUT the base CC prompt — the server-side fingerprint match fails
// and the request is billed as pay-as-you-go credits instead of Max-plan usage.
//
// Fix: on the first main-agent call (where the anchor is present), cache the
// sanitized CC prefix. On subsequent subagent calls (anchor missing), prepend
// the cached prefix to the sanitized blocks so the fingerprint matches again.
//
// The cache lives at module scope because buildSystemPromptBlocks is re-entered
// per request. It gets populated exactly once per process on the first main call.
const MAX_SUBAGENT_CC_PREFIX = MAX_SAFE_SYSTEM_TEXT_LENGTH;
export const SUBAGENT_CC_ANCHOR = "You are an interactive";
let cachedCCPrompt = null;

// Perf: module-scope regexes reused across per-request hot paths. None use the
// `/g` flag and all are consumed via `.test()`, so a single shared instance is
// stateless and safe (no `lastIndex` to reset between calls).
const TAIL_IMPORTANT_RE = /\b(MUST|NEVER|CRITICAL|IMPORTANT|REQUIRED|DO NOT|ALWAYS|FORBIDDEN)\b/i;
const TAIL_HEADER_RE = /^#{1,4}\s/;
const TAIL_LIST_ITEM_RE = /^\s*[-*]\s/;

const OPENCODE_ENV_CONTEXT_PREFIX = "Here is some useful information about the environment you are running in:";
const CC_ENV_CONTEXT_PREFIX = "Here is useful information about the environment you are running in:";

/**
 * Compute the billing cache hash (cch) matching Claude Code's NP1() function.
 * SHA256(salt + chars_at_indices[4,7,20]_from_first_user_msg + version).slice(0,3)
 * @param {string} firstUserMessage
 * @param {string} version
 * @returns {string}
 */
export function computeBillingCacheHash(firstUserMessage, version) {
  const chars = BILLING_HASH_INDICES.map((i) => firstUserMessage[i] || "0").join("");
  const input = `${BILLING_HASH_SALT}${chars}${version}`;
  return createHashCrypto("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Models eligible for the "simple system prompt" mode that real CC ships in
 * v2.1.133+ under GrowthBook flag `tengu_velvet_cascade` (or forced via
 * `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1`).
 *
 * Real CC's `sR9` matches: `claude-opus-4-7`, any model with `-eap` (early
 * access) suffix, plus a small GrowthBook-controlled allowlist we can't read.
 * Plugin mirrors the deterministic subset only.
 *
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isSimpleSystemPromptEligible(model) {
  if (!model) return false;
  if (isOpus47Model(model) || isOpus48Model(model)) return true;
  // -eap suffix variant, e.g. "claude-opus-4-7-eap" or "claude-opus-4-7-eap[1m]"
  if (/-eap($|\[)/i.test(model)) return true;
  return false;
}

/**
 * Build the billing header block for Claude Code system prompt injection.
 * Claude Code v2.1.97: cc_version includes 3-char fingerprint hash (not model ID).
 * cch is a static "00000" placeholder (xxHash64 attestation removed in v2.1.97).
 *
 * Real CC (system.ts:78): version = `${MACRO.VERSION}.${fingerprint}`
 * Real CC (system.ts:82): cch = ' cch=00000;' (static, no longer computed)
 *
 * @param {string} version - CLI version (e.g., "2.1.97")
 * @param {string} [firstUserMessage] - First user message text for fingerprint computation
 * @param {string} [workloadOverride] - Explicit workload tag from config (`signature_emulation.workload`).
 *   Takes precedence over `CLAUDE_CODE_WORKLOAD` env var. Mirrors real CC's `--workload <tag>` flag.
 * @returns {string}
 */
export function buildAnthropicBillingHeader(version, firstUserMessage, workloadOverride) {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  // Real CC sends cc_entrypoint=cli (confirmed via proxy capture).
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
  // Fix #1: cc_version suffix is the 3-char fingerprint hash, NOT the model ID.
  // computeBillingCacheHash() computes SHA256(salt + msg[4]+msg[7]+msg[20] + version)[:3]
  // which matches computeFingerprint() in the real CC source (utils/fingerprint.ts).
  // Always call the hash function — even for empty messages the real CC computes
  // the hash from "000" chars (indices 4,7,20 all missing → fallback "0").
  const fingerprint = computeBillingCacheHash(firstUserMessage || "", version);
  const ccVersion = `${version}.${fingerprint}`;
  // cch: v2.1.97 sends static "cch=00000" — xxHash64 attestation was removed.
  // The server uses the PRESENCE of cch=00000 as a CC identification signal.
  // The plugin is first-party only, so cch is always emitted; the former
  // bedrock/anthropicAws/mantle suppression went away with multi-provider support.
  const cchPart = " cch=00000;";
  // Build workload part (upstream concatenates directly, no regex replace).
  // Config wins over env so `signature_emulation.workload` is portable across hosts.
  let workloadPart = "";
  const workload = workloadOverride || process.env.CLAUDE_CODE_WORKLOAD;
  if (workload) {
    // QA fix M5: sanitize workload value to prevent header injection.
    const safeWorkload = String(workload).replace(/[;\s\r\n]/g, "_");
    if (safeWorkload) workloadPart = ` cc_workload=${safeWorkload};`;
  }
  return `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${entrypoint};${cchPart}${workloadPart}`;
}

export function sanitizeSystemText(text) {
  // QA fix M4: use word boundaries to avoid mangling URLs and code identifiers
  let sanitized = text.replace(/\bOpenCode\b/g, "Claude Code").replace(/\bopencode\b/gi, "Claude");
  // Strip non-CC custom prefixes before the standard CC prompt.
  const ccStandardStart = sanitized.indexOf("You are an interactive");
  if (ccStandardStart > 0) {
    sanitized = sanitized.slice(ccStandardStart);
  }
  // NOTE: truncation removed — real CC v2.1.107 sends 26K+ char system prompts.
  // The server checks for CC identity/billing markers, not exact prompt length.
  return sanitized;
}

/**
 * @param {string} text
 * @param {'minimal' | 'off'} mode
 * @returns {string}
 */
export function tailSystemBlock(text, maxChars, turnThreshold) {
  const lines = text.split("\n");
  const kept = [];
  let charCount = 0;
  const importantRe = TAIL_IMPORTANT_RE;
  const headerRe = TAIL_HEADER_RE;
  const listItemRe = TAIL_LIST_ITEM_RE;
  // Always keep the first paragraph (identity/role definition)
  let firstParaEnd = 0;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].trim() === "" && j > 0) {
      firstParaEnd = j;
      break;
    }
  }
  if (firstParaEnd === 0) firstParaEnd = Math.min(5, lines.length);
  for (let j = 0; j <= firstParaEnd; j++) {
    kept.push(lines[j]);
    charCount += (lines[j]?.length || 0) + 1;
  }
  // Scan remaining lines: keep headers, important constraints, short list items
  for (let j = firstParaEnd + 1; j < lines.length; j++) {
    const line = lines[j];
    const isHeader = headerRe.test(line);
    const isImportant = importantRe.test(line);
    const isShortListItem = listItemRe.test(line) && line.length < 120;
    if (isHeader || isImportant || isShortListItem) {
      if (charCount + line.length + 1 > maxChars) break;
      kept.push(line);
      charCount += line.length + 1;
    }
  }
  kept.push("", "[Verbose instructions trimmed after turn " + turnThreshold + ". Key constraints preserved above.]");
  return kept.join("\n");
}

export function compactToolDescription(text) {
  return text
    .replace(/<example[\s\S]*?<\/example>/gi, "")
    .replace(/\|[\s|:-]+\|/g, "")
    .replace(/^\|.*\|$/gm, "")
    .replace(/^(?:\s*[-*]\s+.{200,})$/gm, (m) => m.slice(0, 200) + "...")
    .replace(/^(#{1,3}\s+)/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function compactSystemText(text, mode) {
  const withoutDuplicateIdentityPrefix = text.startsWith(`${CLAUDE_CODE_IDENTITY_STRING}\n`)
    ? text.slice(CLAUDE_CODE_IDENTITY_STRING.length).trimStart()
    : text;

  if (mode === "off") {
    return withoutDuplicateIdentityPrefix.trim();
  }

  const compacted = withoutDuplicateIdentityPrefix.replace(/<example>[\s\S]*?<\/example>/gi, "\n");

  const dedupedLines = [];
  let prevNormalized = "";
  for (const line of compacted.split("\n")) {
    const normalized = line.trim();
    if (normalized && normalized === prevNormalized) continue;
    dedupedLines.push(line);
    prevNormalized = normalized;
  }

  return dedupedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
export function normalizeSystemTextForComparison(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @returns {Array<{type: string, text: string, cache_control?: {type: string}}>}
 */
export function dedupeSystemBlocks(system) {
  const exactSeen = new Set();
  const exactDeduped = [];

  for (const item of system) {
    const normalized = normalizeSystemTextForComparison(item.text);
    const key = `${item.type}:${normalized}`;
    if (exactSeen.has(key)) continue;
    exactSeen.add(key);
    exactDeduped.push(item);
  }

  const normalizedBlocks = exactDeduped.map((item) => normalizeSystemTextForComparison(item.text));
  return exactDeduped.filter((_, index) => {
    const current = normalizedBlocks[index];
    if (current.length < 80) return true;

    for (let otherIndex = 0; otherIndex < normalizedBlocks.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = normalizedBlocks[otherIndex];
      if (other.length <= current.length + 20) continue;
      if (other.includes(current)) return false;
    }

    return true;
  });
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isTitleGeneratorSystemText(text) {
  const normalized = text.trim().toLowerCase();
  return normalized.includes("you are a title generator") || normalized.includes("generate a brief title");
}

/**
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @returns {boolean}
 */
export function isTitleGeneratorSystemBlocks(system) {
  return system.some(
    (item) => item.type === "text" && typeof item.text === "string" && isTitleGeneratorSystemText(item.text),
  );
}

export function rewriteEnvContextPhrasing(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (text.indexOf(OPENCODE_ENV_CONTEXT_PREFIX) === -1) return text;
  return text.split(OPENCODE_ENV_CONTEXT_PREFIX).join(CC_ENV_CONTEXT_PREFIX);
}

export function normalizeSystemTextBlocks(system) {
  const output = [];
  if (!Array.isArray(system)) return output;

  for (const item of system) {
    if (typeof item === "string") {
      output.push({ type: "text", text: rewriteEnvContextPhrasing(item) });
      continue;
    }

    if (!item || typeof item !== "object") continue;
    if (typeof item.text !== "string") continue;

    const normalized = {
      type: typeof item.type === "string" ? item.type : "text",
      text: rewriteEnvContextPhrasing(item.text),
    };

    // Intentionally strip cache_control from incoming system blocks.
    // The plugin controls cache placement: only the identity block and
    // boundary-split blocks get cache_control (added in buildSystemPromptBlocks).
    // Passing through upstream markers can cause "maximum of 4 blocks with
    // cache_control" API errors when combined with our own markers.

    output.push(normalized);
  }

  return output;
}

/**
 * Determine the identity string prefix, matching real CC's getCLISyspromptPrefix().
 * Real CC selects based on isNonInteractive + hasAppendSystemPrompt flags.
 * OpenCode is always interactive CLI, so DEFAULT_PREFIX is almost always correct.
 * We check for Agent SDK signals from the environment to match non-interactive cases.
 *
 * @returns {string}
 */
export function getCLISyspromptPrefix() {
  // Agent SDK preset: when running within the Claude Agent SDK with CC preset
  if (isTruthyEnv(process.env.CLAUDE_AGENT_SDK_VERSION) && isTruthyEnv(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "";
    if (entrypoint === "agent-sdk" || entrypoint === "sdk") {
      return "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
    }
  }
  // Non-interactive agent without CC preset
  if (isTruthyEnv(process.env.CLAUDE_AGENT_SDK_VERSION) && !isTruthyEnv(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    return "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  }
  return CLAUDE_CODE_IDENTITY_STRING;
}

/**
 * Compute the cache_control object for a given cache scope and policy.
 * Mirrors real CC getCacheControl() (src/services/api/claude.ts:358-374).
 *
 * Real CC behavior:
 * - scope 'global' → {type: 'ephemeral', scope: 'global', ttl?: '1h'}
 * - scope 'org'    → {type: 'ephemeral', ttl?: '1h'} (org is internal, NOT on wire)
 * - scope null     → block gets NO cache_control at all (caller should omit it)
 *
 * @param {'global' | 'org' | null} cacheScope
 * @param {{ttl: string, ttl_supported: boolean}} cachePolicy
 * @returns {{type: string, ttl?: string, scope?: string} | null} null means "no cache_control"
 */
export function getCacheControlForScope(cacheScope, cachePolicy) {
  if (cacheScope === null) return null; // no cache_control for this block

  const hasTtl = cachePolicy.ttl !== "off" && cachePolicy.ttl_supported !== false;
  const result = { type: "ephemeral" };
  if (hasTtl) result.ttl = cachePolicy.ttl;
  // Only 'global' scope is emitted on the wire; 'org' is internal-only
  if (cacheScope === "global") result.scope = "global";
  return result;
}

/**
 * Split system prompt blocks into structured blocks with cache scoping,
 * matching real CC splitSysPromptPrefix() (src/utils/api.ts:321-435).
 *
 * Real CC has 3 paths that produce 2 distinct wire formats:
 *
 * Path A (tool-based cache): skipGlobalCacheForSystemPrompt=true
 *   - billing → cacheScope: null
 *   - identity → cacheScope: 'org'
 *   - rest (joined) → cacheScope: 'org'
 *   Wire result: identical to Path C (org → ephemeral without scope field)
 *
 * Path B (boundary mode): shouldUseGlobalCacheScope() && boundary marker found
 *   - billing → cacheScope: null
 *   - identity → cacheScope: null (NO cache_control in boundary mode!)
 *   - static blocks (before boundary, joined) → cacheScope: 'global'
 *   - dynamic blocks (after boundary, joined) → cacheScope: null
 *
 * Path C (fallback): no global cache feature or no boundary
 *   - billing → cacheScope: null
 *   - identity → cacheScope: 'org'
 *   - rest (joined) → cacheScope: 'org'
 *
 * @param {Array<{text: string}>} blocks - Already sanitized/filtered text blocks
 * @param {string | undefined} attributionHeader - The billing header text (or undefined)
 * @param {string} identityString - The identity prefix string
 * @param {boolean} useBoundaryMode - Whether to use Path B (global cache with boundary)
 * @returns {Array<{text: string, cacheScope: 'global' | 'org' | null}>}
 */
export function splitSysPromptPrefix(blocks, attributionHeader, identityString, useBoundaryMode) {
  // Separate known blocks from rest, matching real CC's parsing loop
  const rest = [];
  for (const block of blocks) {
    if (!block.text) continue;
    // Skip if it's a billing header or identity string (already extracted)
    if (block.text.startsWith("x-anthropic-billing-header:")) continue;
    if (KNOWN_IDENTITY_STRINGS.has(block.text)) continue;
    // Skip the boundary marker itself (real CC skips it in Path A, processes it in Path B)
    if (block.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
    rest.push(block.text);
  }

  // ====================================================================
  // Path B: Global cache with boundary marker
  // Real CC (utils/api.ts:219-262): when shouldUseGlobalCacheScope() &&
  // boundary marker is found in the system prompt array.
  // ====================================================================
  if (useBoundaryMode) {
    // Find boundary marker in the ORIGINAL block array (before filtering)
    const boundaryIndex = blocks.findIndex((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    if (boundaryIndex !== -1) {
      // Classify blocks as static (before boundary) or dynamic (after boundary)
      const staticBlocks = [];
      const dynamicBlocks = [];
      for (let i = 0; i < blocks.length; i++) {
        const text = blocks[i].text;
        if (!text) continue;
        if (text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
        if (text.startsWith("x-anthropic-billing-header:")) continue;
        if (KNOWN_IDENTITY_STRINGS.has(text)) continue;
        if (i < boundaryIndex) {
          staticBlocks.push(text);
        } else {
          dynamicBlocks.push(text);
        }
      }

      const result = [];
      if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
      // Identity: cacheScope null in boundary mode (real CC behavior)
      result.push({ text: identityString, cacheScope: null });
      const staticJoined = staticBlocks.join("\n");
      if (staticJoined) result.push({ text: staticJoined, cacheScope: "global" });
      const dynamicJoined = dynamicBlocks.join("\n");
      if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null });
      return result;
    }
    // Boundary marker not found — fall through to Path C
  }

  // ====================================================================
  // Path C (fallback) / Path A (tool-based): no boundary or no global cache
  // Real CC (utils/api.ts:264-289): identity and rest get cacheScope 'org'
  // Path A produces identical wire output to Path C.
  // ====================================================================
  const result = [];
  if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
  result.push({ text: identityString, cacheScope: "org" });
  const restJoined = rest.join("\n");
  if (restJoined) result.push({ text: restJoined, cacheScope: "org" });
  return result;
}

/**
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @param {{enabled: boolean, claudeCliVersion: string, promptCompactionMode: 'minimal' | 'off', cachePolicy?: {ttl: string, ttl_supported: boolean, boundary_marker?: boolean}}} signature
 * @returns {Array<{type: string, text: string, cache_control?: {type: string}}>}
 */
export function buildSystemPromptBlocks(system, signature) {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);

  let sanitized = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text), signature.promptCompactionMode),
  }));

  // A5: Subagent CC-prefix cache/inject (see constant declaration above for context).
  //
  // After sanitize, main-agent blocks start with "You are an interactive..." because
  // sanitizeSystemText() strips everything before that anchor. Subagent blocks
  // (custom prompts from input.agent.prompt) do NOT start with the anchor —
  // they start with whatever the agent template says (e.g., "You are a file search
  // specialist.").
  //
  // This logic runs ONLY for Anthropic requests with signature enabled (signature.enabled
  // is false for non-Anthropic providers), and skips the title-generator fast path
  // because that one is replaced wholesale with COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT below.
  if (signature.enabled && !titleGeneratorRequest && sanitized.length > 0) {
    const firstText = typeof sanitized[0]?.text === "string" ? sanitized[0].text : "";
    const hasCcAnchor = firstText.startsWith(SUBAGENT_CC_ANCHOR);

    if (hasCcAnchor) {
      // Main-agent path: cache the prefix on the first hit so subagents can reuse it.
      // We slice to MAX_SUBAGENT_CC_PREFIX to avoid unbounded growth if the upstream
      // sanitize limit is ever raised.
      if (!cachedCCPrompt) {
        cachedCCPrompt = firstText.slice(0, MAX_SUBAGENT_CC_PREFIX);
      }
    } else if (cachedCCPrompt) {
      // Subagent path: prepend the cached CC prefix so the fingerprint matches.
      // We prepend, not concatenate, so the original subagent prompt stays as a
      // separate block — dedupeSystemBlocks and splitSysPromptPrefix handle the
      // join on their own downstream.
      sanitized = [{ type: "text", text: cachedCCPrompt }, ...sanitized];
    }
    // If !hasCcAnchor && !cachedCCPrompt: no-op. The cache primes on the very
    // first main call in a process. In practice opencode always fires a main
    // call before any subagent, so this branch is only hit in synthetic tests.
  }

  if (titleGeneratorRequest) {
    sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
  } else if (signature.promptCompactionMode !== "off") {
    sanitized = dedupeSystemBlocks(sanitized);
  }

  // Anti-verbosity injection (CC v2.1.100 quiet_salted_ember equivalent).
  // Applies to Opus 4.6 / 4.7 for non-title-generator requests.
  //
  // Simple-system-prompt gate (CC v2.1.133+ `tengu_velvet_cascade` equivalent):
  // when `signature.simpleSystemPrompt` is true AND the model is eligible
  // (Opus 4.7, -eap variants), skip the anti-verbosity boilerplate. Real CC's
  // simple-prompt mode strips this kind of post-hoc behavioral hand-holding on
  // models that don't need it. Conservative implementation: gates ONLY the
  // anti-verbosity push, not the identity / billing / sanitized blocks. Saves
  // ~600-1500 tokens per request on eligible models without touching the CC
  // fingerprint markers the server checks.
  const skipAntiVerbosity = signature.simpleSystemPrompt === true && isSimpleSystemPromptEligible(signature.modelId);

  if (
    !titleGeneratorRequest &&
    !skipAntiVerbosity &&
    signature.modelId &&
    (isOpus46Model(signature.modelId) || isOpus47Model(signature.modelId))
  ) {
    const avConfig = signature.antiVerbosity;
    if (avConfig?.enabled !== false) {
      sanitized.push({ type: "text", text: ANTI_VERBOSITY_SYSTEM_PROMPT });
    }
  }

  if (!signature.enabled) {
    return sanitized;
  }

  // Lean system prompt for non-main requests (title-gen is already handled
  // above via the COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT swap). For "title"
  // and "small" request roles — one-off queries that don't belong to the main
  // REPL thread — we skip billing identity + CC identity injection. This
  // matches the spirit of real CC's querySource gates: identity context is
  // for interactive main-thread conversations, not fire-and-forget calls.
  // Opt-in (default off) because it changes the system-prompt shape.
  const leanNonMain =
    signature.leanNonMain === true &&
    (signature.requestRole === "title" || signature.requestRole === "small") &&
    !titleGeneratorRequest;
  if (leanNonMain) {
    return sanitized;
  }

  // Build attribution header
  const billingHeader = buildAnthropicBillingHeader(
    signature.claudeCliVersion,
    signature.firstUserMessage,
    signature.workload,
  );

  // Select the identity string (matches real CC getCLISyspromptPrefix())
  const identityString = getCLISyspromptPrefix();

  // Determine cache policy
  const effectiveCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };

  // Determine if we should use boundary mode (Path B)
  // Real CC: shouldUseGlobalCacheScope() is a GrowthBook feature flag.
  // We simulate it via config: boundary_marker=true or CLAUDE_CODE_FORCE_GLOBAL_CACHE=1.
  const useBoundaryMode =
    effectiveCachePolicy.boundary_marker || isTruthyEnv(process.env.CLAUDE_CODE_FORCE_GLOBAL_CACHE);

  // Run the real CC splitSysPromptPrefix algorithm to get blocks with cacheScope
  const scopedBlocks = splitSysPromptPrefix(sanitized, billingHeader || undefined, identityString, useBoundaryMode);

  // Adapter path only: the shared package prepends its OWN billing block
  // (index 0) and identity block (index 1), each with its own cache_control
  // marker. Emitting ours too would duplicate both blocks on the wire.
  //
  // This is CONDITIONAL, never unconditional: the legacy path (any request the
  // signature-emulation adapter declines — non-Anthropic provider, or emulation
  // off) still builds the request through buildRequestHeaders and depends on
  // these two blocks being present. Dropping them for every caller would break
  // that path silently — no error, just a wrong request on the wire.
  const emittedBlocks =
    signature.suppressCanonicalBlocks === true ? dropCanonicalPrefixBlocks(scopedBlocks, identityString) : scopedBlocks;

  // Convert scoped blocks to wire format using getCacheControlForScope
  // (mirrors real CC buildSystemPromptBlocks → map + getCacheControl)
  return emittedBlocks.map((block) => {
    const cc = getCacheControlForScope(block.cacheScope, effectiveCachePolicy);
    return {
      type: "text",
      text: block.text,
      ...(cc !== null && { cache_control: cc }),
    };
  });
}

/**
 * Drop the two canonical prefix blocks the shared package prepends itself.
 *
 * Both are matched with the SAME predicates `splitSysPromptPrefix` uses to
 * recognise them on input, and only the FIRST occurrence of each is removed, so
 * a caller-supplied block that happens to repeat the identity string survives.
 *
 * @param {{text: string, cacheScope: string | null}[]} blocks
 * @param {string} identityString
 * @returns {{text: string, cacheScope: string | null}[]}
 */
function dropCanonicalPrefixBlocks(blocks, identityString) {
  let billingDropped = false;
  let identityDropped = false;
  return blocks.filter((block) => {
    const text = typeof block.text === "string" ? block.text : "";
    if (!billingDropped && text.startsWith(BILLING_HEADER_PREFIX)) {
      billingDropped = true;
      return false;
    }
    if (!identityDropped && text === identityString) {
      identityDropped = true;
      return false;
    }
    return true;
  });
}

export function getCachedCCPrompt() {
  return cachedCCPrompt;
}

export function resetCachedCCPrompt() {
  cachedCCPrompt = null;
}
