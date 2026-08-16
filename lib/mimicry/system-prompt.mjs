import { isTruthyEnv } from "../env.mjs";
import { isOpus46Model, isOpus47Model, isOpus48Model } from "./wire-compat.mjs";

/**
 * The canonical Claude Code identity text.
 *
 * The PLUGIN NO LONGER EMITS IT. `@tormentalabs/claude-code-wire-compat`
 * composes the canonical prefix (billing block + identity block) itself and
 * drops any caller block byte-equal to the identity text, so the prefix lands
 * on the wire exactly once. The constant survives here as a host-policy probe:
 * `compactSystemText` strips a duplicated identity prefix a host prompt may
 * carry, before the array ever reaches the package.
 */
export const CLAUDE_CODE_IDENTITY_STRING = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Marker that identifies a canonical billing block inside a system array. */
export const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
/**
 * Every canonical identity text the wire recognises.
 *
 * The package drops a caller block byte-equal to its own `IDENTITY_TEXT`, but
 * only that one, and only when the block stands alone. The host pipeline joins
 * blocks before the package sees them, so a host-supplied identity block has to
 * be dropped HERE or it would end up embedded mid-string in the joined run and
 * put the canonical prefix on the wire twice.
 */
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

// Perf: module-scope regexes reused across per-request hot paths. None use the
// `/g` flag and all are consumed via `.test()`, so a single shared instance is
// stateless and safe (no `lastIndex` to reset between calls).
const TAIL_IMPORTANT_RE = /\b(MUST|NEVER|CRITICAL|IMPORTANT|REQUIRED|DO NOT|ALWAYS|FORBIDDEN)\b/i;
const TAIL_HEADER_RE = /^#{1,4}\s/;
const TAIL_LIST_ITEM_RE = /^\s*[-*]\s/;

const OPENCODE_ENV_CONTEXT_PREFIX = "Here is some useful information about the environment you are running in:";
const CC_ENV_CONTEXT_PREFIX = "Here is useful information about the environment you are running in:";

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
 * Compute the cache_control object for a given cache scope and policy.
 *
 * HOST cache policy: the ttl is the one `request-body.mjs` resolved for this
 * request (role-scoped / subagent-aware), not a fixed CC value.
 *
 * - scope 'global' → {type: 'ephemeral', scope: 'global', ttl?: <resolved>}
 * - scope 'org'    → {type: 'ephemeral', ttl?: <resolved>} (org is internal, NOT on wire)
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
 * Place the host prompt-cache breakpoints over the sanitized system blocks.
 *
 * This is the cache half of what used to be `splitSysPromptPrefix`. The prefix
 * half (billing block + identity block) is gone: the shared package composes
 * the canonical prefix itself. What remains is host policy the package cannot
 * infer — WHERE the cache breakpoint goes and which ttl/scope it carries.
 *
 * The blocks are joined here, not left loose, because the package joins a run
 * of caller blocks that share a `cache_control` anyway. Joining first is what
 * makes the breakpoint land on one deterministic block.
 *
 * Boundary mode (`cache_policy.boundary_marker`, or
 * `CLAUDE_CODE_FORCE_GLOBAL_CACHE`): everything before the marker is the static
 * half and takes a `scope: 'global'` breakpoint; everything after is the
 * dynamic half and takes none.
 *
 * @param {Array<{text: string}>} blocks - Already sanitized/filtered text blocks
 * @param {boolean} useBoundaryMode
 * @returns {Array<{text: string, cacheScope: 'global' | 'org' | null}>}
 */
export function splitSystemCacheScopes(blocks, useBoundaryMode) {
  const isDroppedBlock = (text) =>
    !text ||
    text.startsWith(BILLING_HEADER_PREFIX) ||
    KNOWN_IDENTITY_STRINGS.has(text) ||
    text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY;

  if (useBoundaryMode) {
    const boundaryIndex = blocks.findIndex((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    if (boundaryIndex !== -1) {
      const staticBlocks = [];
      const dynamicBlocks = [];
      for (let i = 0; i < blocks.length; i++) {
        const text = blocks[i].text;
        if (isDroppedBlock(text)) continue;
        if (i < boundaryIndex) {
          staticBlocks.push(text);
        } else {
          dynamicBlocks.push(text);
        }
      }

      const result = [];
      const staticJoined = staticBlocks.join("\n");
      if (staticJoined) result.push({ text: staticJoined, cacheScope: "global" });
      const dynamicJoined = dynamicBlocks.join("\n");
      if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null });
      return result;
    }
    // Boundary marker not found — fall through to the single-breakpoint shape.
  }

  const rest = [];
  for (const block of blocks) {
    if (isDroppedBlock(block.text)) continue;
    rest.push(block.text);
  }
  const restJoined = rest.join("\n");
  return restJoined ? [{ text: restJoined, cacheScope: "org" }] : [];
}

/**
 * Apply the HOST system-prompt policy to an already-normalized block array.
 *
 * This is host policy ONLY. The Claude Code canonical prefix (billing block +
 * identity block) is composed by `@tormentalabs/claude-code-wire-compat`, which
 * also drops any caller block byte-equal to the identity text — so the prefix
 * reaches the wire exactly once and the plugin never emits it.
 *
 * What stays here, in order:
 *  1. sanitize (OpenCode -> Claude Code) + compaction
 *  2. title-generator swap, or dedupe of near-identical blocks
 *  3. anti-verbosity injection (Opus 4.6/4.7, unless simple-system-prompt mode)
 *  4. host prompt-cache breakpoint placement
 *
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @param {{promptCompactionMode: 'minimal' | 'off', modelId?: string, simpleSystemPrompt?: boolean, antiVerbosity?: {enabled?: boolean}, cachePolicy?: {ttl: string, ttl_supported: boolean, boundary_marker?: boolean}}} signature
 * @returns {Array<{type: string, text: string, cache_control?: {type: string}}>}
 */
export function buildSystemPromptBlocks(system, signature) {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);

  let sanitized = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text), signature.promptCompactionMode),
  }));

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

  // Host prompt-cache breakpoint. The canonical prefix is NOT built here — the
  // package prepends its own billing + identity blocks and drops a caller block
  // equal to the identity text, so the prefix lands on the wire exactly once.
  const effectiveCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };
  const useBoundaryMode =
    effectiveCachePolicy.boundary_marker || isTruthyEnv(process.env.CLAUDE_CODE_FORCE_GLOBAL_CACHE);

  return splitSystemCacheScopes(sanitized, useBoundaryMode).map((block) => {
    const cc = getCacheControlForScope(block.cacheScope, effectiveCachePolicy);
    return {
      type: "text",
      text: block.text,
      ...(cc !== null && { cache_control: cc }),
    };
  });
}
