import { isTruthyEnv } from "../env.mjs";
import { isOpus46Model, isOpus47Model, isOpus48Model } from "./wire-compat.mjs";
import { truncateGraphemes } from "../unicode-text.mjs";
import { buildEmpowermentText, resolveSystemPromptSettings } from "../system-prompt-empowerment.mjs";

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
/**
 * The first sentence of the genuine client's static system prompt (current
 * upstream release). It opens the stable host block; the canonical identity block still
 * precedes it on the wire, composed by the package.
 */
export const GENUINE_OPENING_SENTENCE =
  "You are an agent working with the user toward their goals, using your own judgment along the way.";
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
 * v2.1.133+ under GrowthBook flag `tengu_velvet_tide` (or forced via
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

// ---------------------------------------------------------------------------
// Structure of the host system text
//
// opencode joins its system segments with "\n" into one text, in this order:
//   base prompt, environment ("You are powered by ..." + the env header +
//   `<env>...</env>`), [project references], instruction files (each one
//   "Instructions from: <path-or-url>" followed by the file content), [MCP
//   instructions], [skills], [extra agent text].
// The segmenter below recovers that structure from the text alone. It exists for
// two decisions: WHERE the OpenCode -> Claude Code rewrite may apply, and which
// segments are stable enough to share a cached prefix. Both fail safe: an
// unrecognised line stays with the segment before it (never lost, never
// rewritten if that segment is not rewritable), and an unclassifiable segment is
// treated as volatile.
//
// Invariant: `segments.map((s) => s.text).join("\n") === text`, byte for byte.
// ---------------------------------------------------------------------------

const INSTRUCTIONS_PREFIX = "Instructions from: ";
const POWERED_BY_PREFIX = "You are powered by the model named ";
const SKILLS_INTRO = "Skills provide specialized instructions and workflows for specific tasks.";
const REFERENCES_INTRO = "Project references provide additional directories";
/** Opening tag of the closed regions. Inside one, no marker starts a new segment. */
const REGION_OPEN = {
  env: "<env>",
  skills: "<available_skills>",
  mcp: "<mcp_instructions>",
  refs: "<available_references>",
};
const REGION_CLOSE = {
  env: "</env>",
  skills: "</available_skills>",
  mcp: "</mcp_instructions>",
  refs: "</available_references>",
};
/** Segment kinds whose text is the plugin's/host's own prose, where the branding rewrite applies. */
const REWRITABLE_KINDS = new Set(["base", "env", "other"]);

/**
 * @param {string} line - A line without a trailing carriage return.
 * @returns {"instructions" | "env" | "skills" | "mcp" | "refs" | null}
 */
function detectSegmentStart(line) {
  if (line.startsWith(INSTRUCTIONS_PREFIX)) return "instructions";
  if (
    line.startsWith(POWERED_BY_PREFIX) ||
    line === OPENCODE_ENV_CONTEXT_PREFIX ||
    line === CC_ENV_CONTEXT_PREFIX ||
    line === REGION_OPEN.env
  ) {
    return "env";
  }
  if (line === SKILLS_INTRO || line === REGION_OPEN.skills) return "skills";
  if (line === REGION_OPEN.mcp) return "mcp";
  if (line.startsWith(REFERENCES_INTRO) || line === REGION_OPEN.refs) return "refs";
  return null;
}

/**
 * Split a host system text into typed segments.
 *
 * @param {string} text
 * @param {{ leading?: boolean }} [options] `leading: false` marks text that is not the first system block, so
 *   its unmarked opening lines are "other" rather than the base prompt.
 * @returns {Array<{ kind: "base" | "env" | "instructions" | "skills" | "mcp" | "refs" | "other", text: string, path?: string }>}
 */
export function segmentSystemText(text, { leading = true } = {}) {
  const segments = [];
  /** @type {{ kind: string, lines: string[], path?: string, open: boolean, ended: boolean } | null} */
  let current = null;
  const begin = (kind, path) => {
    current = { kind, lines: [], ...(path === undefined ? {} : { path }), open: false, ended: false };
    segments.push(current);
  };

  const allLines = String(text).split("\n");
  const stripCr = (value) => (value.endsWith("\r") ? value.slice(0, -1) : value);
  for (let index = 0; index < allLines.length; index += 1) {
    const line = allLines[index];
    const bare = stripCr(line);
    if (current?.open) {
      current.lines.push(line);
      if (bare === REGION_CLOSE[current.kind]) {
        current.open = false;
        current.ended = true;
      }
      continue;
    }
    let kind = detectSegmentStart(bare);
    // An environment-looking line inside an instruction file is that file's own
    // text (say, a doc quoting the sentence), not a new segment. The exception is
    // the host's own env header: the phrase on a line of its own, directly followed
    // by the `<env>` opening tag, is host scaffolding wherever it sits (a host may
    // emit the environment AFTER the instruction files), and it carries the phrase
    // the server reads as a third-party marker, so it must open an env segment.
    if (kind === "env" && current?.kind === "instructions") {
      const isEnvHeader =
        (bare === OPENCODE_ENV_CONTEXT_PREFIX || bare === CC_ENV_CONTEXT_PREFIX) &&
        stripCr(allLines[index + 1] ?? "") === REGION_OPEN.env;
      if (!isEnvHeader) kind = null;
    }
    if (kind === "instructions") {
      begin("instructions", bare.slice(INSTRUCTIONS_PREFIX.length).trim());
    } else if (kind !== null) {
      // A region's intro line and its opening tag belong to ONE segment.
      if (!(current && current.kind === kind && !current.ended)) begin(kind);
    } else if (!current || current.ended) {
      begin(segments.length === 0 && leading ? "base" : "other");
    }
    current.lines.push(line);
    if (Object.hasOwn(REGION_OPEN, current.kind) && bare === REGION_OPEN[current.kind]) current.open = true;
  }

  return segments.map((seg) => ({
    kind: seg.kind,
    text: seg.lines.join("\n"),
    ...(seg.path === undefined ? {} : { path: seg.path }),
  }));
}

/** The legacy two-step branding rewrite (QA fix M4: word boundaries, so identifiers survive). */
function rewriteBranding(text) {
  return text.replace(/\bOpenCode\b/g, "Claude Code").replace(/\bopencode\b/gi, "Claude");
}

/**
 * Does this whitespace-delimited token look like a filesystem path or a URL?
 * A path separator (`/` or `\`) covers every shape that matters: `/a/b`,
 * `C:\a\b`, `D:/a/b`, `~/a`, `./a`, `../a` and `scheme://host/...`.
 */
function isPathOrUrlToken(token) {
  return token.includes("/") || token.includes("\\");
}

/**
 * Branding rewrite that leaves path-like and URL-like tokens alone. Rewriting
 * `D:\git\opencode-anthropic-fix` into `D:\git\Claude-anthropic-fix` points the
 * model at a directory that does not exist (it answered with the corrupted
 * path in a live capture), so a path must reach the model exactly as written.
 * Whitespace is preserved byte for byte.
 */
function rewriteBrandingKeepingPaths(text) {
  return text.replace(/\S+/g, (token) => (isPathOrUrlToken(token) ? token : rewriteBranding(token)));
}

/**
 * Apply the OpenCode -> Claude Code rewrite.
 *
 * `rewriteScope: "base"` (the default) rewrites the prose of the base prompt,
 * the environment segment and unrecognised host text, and leaves instruction
 * files (the `Instructions from: <path>` line AND the file content under it),
 * skills, MCP instructions and project references byte-for-byte. In every
 * segment, path-like and URL-like tokens are never rewritten (see
 * `isPathOrUrlToken`), including the environment's working directory.
 * `"all"` restores the legacy behaviour everywhere: a plain rewrite of the whole
 * text, paths included.
 *
 * There is no cut of text before a mid-text match any more (the old
 * "You are an interactive" prefix cut was obsolete for current Claude Code and
 * silently dropped everything before a match).
 *
 * @param {string} text
 * @param {{ rewriteScope?: "base" | "all" }} [options]
 * @returns {string}
 */
export function sanitizeSystemText(text, { rewriteScope = "base" } = {}) {
  // NOTE: truncation removed — real CC v2.1.107 sends 26K+ char system prompts.
  // The server checks for CC identity/billing markers, not exact prompt length.
  if (rewriteScope === "all") return rewriteBranding(text);
  return segmentSystemText(text)
    .map((seg) => (REWRITABLE_KINDS.has(seg.kind) ? rewriteBrandingKeepingPaths(seg.text) : seg.text))
    .join("\n");
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
  return (
    text
      .replace(/<example[\s\S]*?<\/example>/gi, "")
      .replace(/\|[\s|:-]+\|/g, "")
      .replace(/^\|.*\|$/gm, "")
      // Budget is 200 UTF-16 units on the matched line itself; the "..." suffix
      // is NOT counted against that budget (legacy contract: it is appended
      // unconditionally after the cut). truncateGraphemes only ever cuts on a
      // grapheme boundary, so a surrogate pair or combining sequence sitting
      // across unit 200 is excluded whole rather than split — for ASCII text
      // (single-unit graphemes) this is byte-for-byte identical to the old
      // `m.slice(0, 200)`.
      .replace(/^(?:\s*[-*]\s+.{200,})$/gm, (m) => truncateGraphemes(m, 200) + "...")
      .replace(/^(#{1,3}\s+)/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
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
  // The single exception to the "never rewrite instruction files" rule (approved
  // by the maintainer): this one exact, case-sensitive literal makes the server
  // bill the request as third-party usage wherever it appears, so it is replaced
  // in every segment, instruction files and skills included. Nothing else changes.
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
 * `scopeRefused` mirrors the genuine client (`scope: scopeRefused ? undefined :
 * cacheScope`): once the prompt-caching-scope beta is latched off for the
 * account, the scope field is dropped and the block carries the plain
 * `{type, ttl}` marker. Key order, when the scope IS emitted, is type, ttl, scope.
 *
 * @param {'global' | 'org' | null} cacheScope
 * @param {{ttl: string, ttl_supported: boolean}} cachePolicy
 * @param {{ scopeRefused?: boolean }} [options]
 * @returns {{type: string, ttl?: string, scope?: string} | null} null means "no cache_control"
 */
export function getCacheControlForScope(cacheScope, cachePolicy, { scopeRefused = false } = {}) {
  if (cacheScope === null) return null; // no cache_control for this block

  const hasTtl = cachePolicy.ttl !== "off" && cachePolicy.ttl_supported !== false;
  const result = { type: "ephemeral" };
  if (hasTtl) result.ttl = cachePolicy.ttl;
  // Only 'global' scope is emitted on the wire; 'org' is internal-only
  if (cacheScope === "global" && scopeRefused !== true) result.scope = "global";
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
 * Stable/volatile mode (`options.splitStableVolatile`, outside boundary mode):
 * blocks flagged `stable` and the stable segments of the host text (base prompt,
 * global instruction files, skills) form the first block and take the org-scope
 * breakpoint; the volatile segments (environment with date and cwd, project
 * instruction files, MCP instructions, references, anything unclassified) form
 * a second block with NO breakpoint. The volatile block is deliberately left
 * unmarked: the package joins adjacent caller blocks that carry an equal
 * `cache_control`, so a second identical marker would silently merge the two
 * blocks back into one and lose the split. The messages breakpoint covers it.
 *
 * @param {Array<{text: string, stable?: boolean}>} blocks - Already sanitized/filtered text blocks
 * @param {boolean} useBoundaryMode
 * @param {{ splitStableVolatile?: boolean }} [options]
 * @returns {Array<{text: string, cacheScope: 'global' | 'org' | null}>}
 */
export function splitSystemCacheScopes(blocks, useBoundaryMode, { splitStableVolatile = false } = {}) {
  const isDroppedBlock = isDroppedSystemText;

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

  if (splitStableVolatile) {
    const split = splitStableAndVolatile(blocks.filter((block) => !isDroppedBlock(block.text)));
    if (split !== null) return split;
  }

  const rest = [];
  for (const block of blocks) {
    if (isDroppedBlock(block.text)) continue;
    rest.push(block.text);
  }
  const restJoined = rest.join("\n");
  return restJoined ? [{ text: restJoined, cacheScope: "org" }] : [];
}

/** Text the host pipeline never forwards: empty, a canonical prefix block, the boundary marker. */
function isDroppedSystemText(text) {
  return (
    !text ||
    text.startsWith(BILLING_HEADER_PREFIX) ||
    KNOWN_IDENTITY_STRINGS.has(text) ||
    text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY
  );
}

// Global (per-user) configuration directories, as path-part sequences under the
// user's home. An instruction file inside one is the same for every project, so
// it can share a cached prefix. Deliberately closed: anything not listed is
// treated as project-level (volatile).
const GLOBAL_CONFIG_DIRS = [
  [".config", "opencode"],
  [".config", "claude"],
  [".claude"],
  [".opencode"],
  ["appdata", "roaming", "opencode"],
  ["appdata", "roaming", "claude"],
];

/** Lower-case, forward-slash, no duplicate or trailing slashes. */
function normalizePathForMatch(path) {
  const slashed = String(path).replace(/\\/g, "/");
  return slashed
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * Is this instruction path a per-user global config file (`~/.config/opencode/AGENTS.md`,
 * `~/.claude/CLAUDE.md`, `C:\Users\<name>\.config\opencode\AGENTS.md`)?
 * URLs and relative paths are not.
 */
function isGlobalInstructionPath(path) {
  const normalized = normalizePathForMatch(path);
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(normalized)) return false;
  const parts = normalized
    .replace(/^[a-z]:/, "")
    .split("/")
    .filter(Boolean);
  let rest;
  if ((parts[0] === "users" || parts[0] === "home") && parts.length > 2) rest = parts.slice(2);
  else if (parts[0] === "root" || parts[0] === "~") rest = parts.slice(1);
  else return false;
  const insideDir = (dir) => rest.length > dir.length && dir.every((part, index) => rest[index] === part);
  return GLOBAL_CONFIG_DIRS.some(insideDir);
}

/** Project roots (working directory, workspace root) announced by the environment segments. */
function collectProjectRoots(segments) {
  const roots = [];
  for (const seg of segments) {
    if (seg.kind !== "env") continue;
    for (const line of seg.text.split("\n")) {
      const trimmed = line.trim();
      for (const label of ["Working directory:", "Workspace root folder:"]) {
        if (!trimmed.startsWith(label)) continue;
        const root = normalizePathForMatch(trimmed.slice(label.length).trim());
        // A short root ("/", "c:") would swallow everything; refuse to use it.
        if (root.length > 3 && !roots.includes(root)) roots.push(root);
      }
    }
  }
  return roots;
}

function isUnderRoot(normalizedPath, roots) {
  return roots.some((root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`));
}

/**
 * Stable or volatile? Structure decides, and doubt means volatile:
 *  - the base prompt is stable;
 *  - an instruction file is stable only when it is provably a per-user global
 *    config file AND not inside a project root the environment announced;
 *  - skills are stable unless they mention a project root;
 *  - environment, MCP instructions, references and unrecognised text are volatile.
 */
function isStableSegment(seg, roots) {
  switch (seg.kind) {
    case "base":
      return true;
    case "instructions":
      return isGlobalInstructionPath(seg.path ?? "") && !isUnderRoot(normalizePathForMatch(seg.path ?? ""), roots);
    case "skills": {
      const normalized = normalizePathForMatch(seg.text);
      return !roots.some((root) => normalized.includes(root));
    }
    default:
      return false;
  }
}

/**
 * Partition host blocks into a stable block and a volatile block, preserving the
 * original relative order inside each and every byte of every segment.
 *
 * @param {Array<{text: string, stable?: boolean}>} blocks - Non-dropped blocks.
 * @returns {Array<{text: string, cacheScope: 'org' | null}> | null} null when one side is empty
 *   (nothing to split: the caller falls back to a single block).
 */
function splitStableAndVolatile(blocks) {
  // Only the first host block opens with the base prompt; a later block's
  // unmarked opening lines are extra host text (volatile).
  const firstHostIndex = blocks.findIndex((block) => block.stable !== true);
  const parsed = blocks.map((block, index) => ({
    block,
    segments: block.stable === true ? null : segmentSystemText(block.text, { leading: index === firstHostIndex }),
  }));
  const roots = collectProjectRoots(parsed.flatMap((entry) => entry.segments ?? []));

  const stableParts = [];
  const volatileParts = [];
  for (const { block, segments } of parsed) {
    if (segments === null) {
      stableParts.push(block.text);
      continue;
    }
    for (const seg of segments) {
      (isStableSegment(seg, roots) ? stableParts : volatileParts).push(seg.text);
    }
  }
  if (stableParts.length === 0 || volatileParts.length === 0) return null;
  // Breakpoint budget (API maximum 4): tools 1 + identity block 1 (its marker is
  // composed by the wire package, which WP3 owns) + this stable block 1 +
  // messages 1. The volatile block is left unmarked on purpose: the messages
  // breakpoint covers it, and a change confined to it (date, cwd, project files)
  // still reads the cached stable prefix. A second equal marker would also be
  // merged back into one block by the package's run-joining.
  return [
    { text: stableParts.join("\n"), cacheScope: "org" },
    { text: volatileParts.join("\n"), cacheScope: null },
  ];
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
 *  1. sanitize (OpenCode -> Claude Code, base prompt and env header only by
 *     default) + compaction
 *  2. title-generator swap, or dedupe of near-identical blocks
 *  3. opening sentence + empowerment blocks, ahead of everything else
 *  4. anti-verbosity injection (opt-in; Opus 4.6/4.7, unless simple-system-prompt mode)
 *  5. host prompt-cache breakpoint placement, with the stable/volatile split
 *
 * The `system_prompt` settings arrive as `signature.systemPrompt` (the config
 * block of the same name); absent or partial, the config defaults apply. The
 * breakpoint budget is unchanged: with the split, the host system carries ONE
 * breakpoint (the stable block); the identity block's marker is the package's.
 *
 * @param {Array<{type: string, text: string, cache_control?: {type: string}}>} system
 * @param {{promptCompactionMode: 'minimal' | 'off', modelId?: string, simpleSystemPrompt?: boolean, antiVerbosity?: {enabled?: boolean}, cachePolicy?: {ttl: string, ttl_supported: boolean, boundary_marker?: boolean}, systemPrompt?: {empowerment?: unknown, genuine_opening?: boolean, split_stable_volatile?: boolean, rewrite_scope?: 'base' | 'all'}, cacheScopeRefused?: boolean}} signature
 * @returns {Array<{type: string, text: string, cache_control?: {type: string}}>}
 */
export function buildSystemPromptBlocks(system, signature) {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);
  const settings = resolveSystemPromptSettings(signature.systemPrompt);

  const rewriteScope = settings.rewrite_scope;
  let sanitized = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text, { rewriteScope }), signature.promptCompactionMode),
  }));

  if (titleGeneratorRequest) {
    sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
  } else if (signature.promptCompactionMode !== "off") {
    sanitized = dedupeSystemBlocks(sanitized);
  }

  // Opening sentence + empowerment blocks. First in the host text, so the
  // instruction files that follow keep the last word. Byte-stable (no dates, ids
  // or config-dependent wording): it is part of the cached prefix. Only added
  // when there is host text to carry it; a request with no system content of
  // its own stays without one.
  if (!titleGeneratorRequest && sanitized.some((block) => !isDroppedSystemText(block.text))) {
    const opening = settings.genuine_opening ? GENUINE_OPENING_SENTENCE : "";
    const empowerment = buildEmpowermentText(settings.empowerment);
    const prefix = [opening, empowerment].filter(Boolean).join("\n\n");
    // The trailing newline plus the "\n" the blocks are joined with leaves one blank line.
    if (prefix) sanitized.unshift({ type: "text", text: `${prefix}\n`, stable: true });
  }

  // Anti-verbosity injection (CC v2.1.100 quiet_salted_ember equivalent).
  // Applies to Opus 4.6 / 4.7 for non-title-generator requests. Strictly opt-in
  // (`anti_verbosity.enabled: true`); the text itself is unchanged.
  //
  // Simple-system-prompt gate (CC v2.1.133+ `tengu_velvet_tide` equivalent):
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
    if (avConfig?.enabled === true) {
      sanitized.push({ type: "text", text: ANTI_VERBOSITY_SYSTEM_PROMPT, stable: true });
    }
  }

  // Host prompt-cache breakpoint. The canonical prefix is NOT built here — the
  // package prepends its own billing + identity blocks and drops a caller block
  // equal to the identity text, so the prefix lands on the wire exactly once.
  const effectiveCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };
  const useBoundaryMode =
    effectiveCachePolicy.boundary_marker || isTruthyEnv(process.env.CLAUDE_CODE_FORCE_GLOBAL_CACHE);

  const splitStableVolatile = settings.split_stable_volatile === true && !titleGeneratorRequest;
  const scopeRefused = signature.cacheScopeRefused === true;

  return splitSystemCacheScopes(sanitized, useBoundaryMode, { splitStableVolatile }).map((block) => {
    const cc = getCacheControlForScope(block.cacheScope, effectiveCachePolicy, { scopeRefused });
    return {
      type: "text",
      text: block.text,
      ...(cc !== null && { cache_control: cc }),
    };
  });
}
