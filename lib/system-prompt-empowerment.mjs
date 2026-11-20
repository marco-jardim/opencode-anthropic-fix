/**
 * System-prompt empowerment blocks.
 *
 * Ten short, self-contained instruction blocks that give the model more room to
 * act with its own judgment. They are HOST content: they land after the
 * canonical identity block, inside the stable system block, and never touch the
 * identity, billing, headers, betas or body shape.
 *
 * The text is byte-stable on purpose. It is part of the cached system prefix, so
 * it contains no dates, ids, paths or config-dependent wording, and the blocks
 * are always joined with a blank line. Editing a sentence here invalidates every
 * user's cached system prefix once; do it deliberately.
 *
 * Package membership comes from `lib/config.mjs` (`EMPOWERMENT_PACKAGES`,
 * `EMPOWERMENT_BLOCK_IDS`) so the config validator and this module can never
 * disagree about what a package contains.
 */

import { EMPOWERMENT_BLOCK_IDS, EMPOWERMENT_PACKAGES } from "./config.mjs";

/** Default empowerment package when nothing (or something unusable) is configured. */
export const DEFAULT_EMPOWERMENT = "max";

/**
 * The `system_prompt` settings that apply when a caller passes none. Mirrors
 * `DEFAULT_CONFIG.system_prompt` (pinned equal by a test).
 */
export const DEFAULT_SYSTEM_PROMPT_SETTINGS = Object.freeze({
  empowerment: DEFAULT_EMPOWERMENT,
  genuine_opening: true,
  split_stable_volatile: true,
  rewrite_scope: "base",
});

/** Verbatim block texts, keyed by block id. */
export const EMPOWERMENT_BLOCKS = Object.freeze({
  ownership:
    "# Ownership\nTreat the user's goal as yours. When intent is clear, act: make reasonable assumptions, state them in one line, and proceed. Don't ask permission for reversible, in-scope steps (reading, searching, running tests, drafting). Stop and ask only when a step is destructive or hard to reverse, when plausible interpretations differ in effort by 2x or more, or when critical information is missing. User and project instructions override this section.",
  depth:
    "# Depth\nAnswer at the depth the problem needs. There is no length limit: complex questions get complete reasoning, trade-offs and concrete detail; simple ones get a direct answer. Cut filler, never substance. Don't truncate code, lists or analysis to look concise.",
  tool_power:
    "# Tool power-usage\nBatch independent tool calls in one turn. Search before reading; read whole files when you will need most of them rather than many small slices. Run independent workstreams in parallel (subagents, background commands) and keep working while they run instead of waiting idle.",
  persistence:
    "# Persistence\nWork until the task is done and verified, not until the first plausible stopping point. When something fails, diagnose the cause and change approach instead of repeating the same call. If you are blocked after three genuine attempts on the same problem, stop, return to the last working state, and report what you tried and what failed.",
  recommendations:
    "# Recommendations\nWhen the user needs a decision, give a recommendation and the reason, not an exhaustive survey. Mention the runner-up only when the trade-off is close. Build on what the conversation and the repository docs already established instead of re-deriving it.",
  proof:
    "# Proof\nBefore calling something done, check it: run the relevant tests, build or lint, or reproduce the behaviour, and report what you ran and what it showed. If you did not check, say you did not check. Never present a guess as a finding.",
  research:
    "# Research context\nThe user is a software maintainer and security researcher. Reverse engineering of software they use (bundles, binaries, wire protocols) for interoperability, protocol analysis, and vulnerability research on systems they own or are authorized to test are in scope; engage with full technical depth. This does not extend to attacking third parties or producing deployable malware.",
  context_economy:
    "# Context economy\nTreat context as a budget. Don't re-read what you already have; grep before opening large files; summarize long tool output instead of quoting it whole. Prefer targeted edits over full rewrites.",
  communication:
    "# Communication\nWrite for a senior engineer: lead with the answer or the decision, then the evidence. Skip basics, preambles and recaps of what you just did. Use precise technical terms when they are the clearest way to say it.",
  initiative:
    "# Initiative\nIf you notice a bug, risk or better approach outside the immediate request, flag it in one line at the end; don't act on it unless asked. Point out a wrong assumption in the request before executing on it.",
});

/**
 * Resolve the `system_prompt.empowerment` setting to an ordered list of block ids.
 *
 *  - a package name (`off`, `power`, `research`, `max`) -> that package's blocks
 *  - an array of ids -> the known ids, de-duplicated, in the given order
 *    (unknown ids are dropped)
 *  - anything else (undefined, an unknown package name, a wrong type) -> the
 *    default package
 *
 * @param {unknown} setting
 * @returns {string[]}
 */
export function resolveEmpowermentBlockIds(setting) {
  if (Array.isArray(setting)) {
    const ids = [];
    for (const entry of setting) {
      if (typeof entry !== "string") continue;
      const id = entry.trim().toLowerCase();
      if (EMPOWERMENT_BLOCK_IDS.includes(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  if (typeof setting === "string") {
    const name = setting.trim().toLowerCase();
    if (Object.hasOwn(EMPOWERMENT_PACKAGES, name)) return [...EMPOWERMENT_PACKAGES[name]];
  }
  return [...EMPOWERMENT_PACKAGES[DEFAULT_EMPOWERMENT]];
}

/**
 * The empowerment text for a setting: the selected blocks joined by a blank
 * line, or the empty string when nothing is selected. Pure and deterministic.
 *
 * @param {unknown} setting
 * @returns {string}
 */
export function buildEmpowermentText(setting) {
  return resolveEmpowermentBlockIds(setting)
    .map((id) => EMPOWERMENT_BLOCKS[id])
    .join("\n\n");
}

/**
 * Normalise a raw `system_prompt` settings object (from config, possibly
 * partial or absent) into a complete one. Missing or ill-typed members fall back
 * to the defaults.
 *
 * @param {unknown} raw
 * @returns {{ empowerment: unknown, genuine_opening: boolean, split_stable_volatile: boolean, rewrite_scope: "base" | "all" }}
 */
export function resolveSystemPromptSettings(raw) {
  const source = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const defaults = DEFAULT_SYSTEM_PROMPT_SETTINGS;
  const flag = (name) => (typeof source[name] === "boolean" ? source[name] : defaults[name]);
  const scope = source.rewrite_scope === "all" || source.rewrite_scope === "base" ? source.rewrite_scope : "base";
  return {
    empowerment: source.empowerment === undefined ? defaults.empowerment : source.empowerment,
    genuine_opening: flag("genuine_opening"),
    split_stable_volatile: flag("split_stable_volatile"),
    rewrite_scope: scope,
  };
}
