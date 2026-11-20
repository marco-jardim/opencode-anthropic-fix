import {
  buildSystemPromptBlocks,
  normalizeSystemTextBlocks,
  compactToolDescription,
  tailSystemBlock,
  isTitleGeneratorSystemBlocks,
} from "./system-prompt.mjs";
import {
  applyTtlThinkingStrip,
  applyIdleToolResultClearing,
  applySessionToolResultDedupe,
  applyProactiveMicrocompact,
  applyTrailingSummaryTrim,
  applyToolResultDedupe,
  applyStableToolOrdering,
  applyToolSchemaDeferral,
  applyAdaptiveThinkingZero,
  estimatePromptTokensFromParsed,
  parseNaturalLanguageBudget,
  injectTokenBudgetBlock,
} from "../token-economy/transforms.mjs";
import { isCacheCold, resolveCacheTtl, resolveMessagesCacheTtl, shouldPlaceToolBreakpoint, ttlToMs } from "./cache.mjs";
import {
  catalogueDefaultEffortWire,
  catalogueDefaultMaxTokensWire,
  isAdaptiveThinkingModel,
  isClaude3Model,
  isFastModeEligibleWire,
  supportsEffortLevelWire,
  supportsEffortWire,
  supportsPerTurnEffortWire,
} from "./wire-compat.mjs";
import { applyPerTurnEffort } from "../per-turn-effort.mjs";
import {
  resolveMaxTokens,
  extractFirstUserMessageText,
  buildRequestMetadata,
  stripSlashCommandMessages,
  repairOrphanedToolUseBlocks,
} from "./request-helpers.mjs";
import { isTruthyEnv } from "../env.mjs";
import { sessionMetrics as legacySessionMetrics } from "../session-metrics.mjs";

const THINKING_DISPLAYS = new Set(["summarized", "omitted"]);

/**
 * Outgoing tool-name sanitization: opencode's lowercase core tool names to the
 * Claude Code PascalCase ones (Anthropic's server blocklists known non-CC names).
 * Exported so the session correlation reports the SAME names the wire carries.
 * Must stay in sync with `CC_TO_OC_TOOL_NAMES` in response-stream.mjs.
 */
export const OC_TO_CC_TOOL_NAMES = new Map(
  Object.entries({
    bash: "Bash",
    read: "Read",
    glob: "Glob",
    grep: "Grep",
    edit: "Edit",
    write: "Write",
    webfetch: "WebFetch",
    todowrite: "TodoWrite",
    skill: "Skill",
    task: "Task",
    compress: "Compress",
  }),
);

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * When the last MAIN-thread request of each session went out, for the
 * cold-cache decision. Module-level because `transformRequestBody` is a plain
 * function called once per request; bounded so a long-lived host cannot grow it
 * without limit (oldest session evicted first, insertion order).
 *
 * @type {Map<string, number>}
 */
const lastMainRequestAtBySession = new Map();
const MAX_TRACKED_SESSIONS = 256;

/**
 * Sessions in which a `cold_cache_only` request actually rewrote the history or
 * the tool array. The host resends its ORIGINAL history every turn, so a warm
 * request that stopped rewriting would restore what the cold one removed and
 * miss the prefix that request just cached. Once a session has rewritten cold it
 * keeps applying the same (deterministic) rewrites, warm or cold. Bounded like
 * the map above (oldest session evicted first).
 *
 * @type {Set<string>}
 */
const rewrittenColdBySession = new Set();

/** @param {string} sessionKey */
function noteColdRewrite(sessionKey) {
  rewrittenColdBySession.delete(sessionKey);
  rewrittenColdBySession.add(sessionKey);
  while (rewrittenColdBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = rewrittenColdBySession.values().next().value;
    if (oldest === undefined) break;
    rewrittenColdBySession.delete(oldest);
  }
}

/** @param {string} sessionKey @param {number} now */
function noteMainRequest(sessionKey, now) {
  lastMainRequestAtBySession.delete(sessionKey);
  lastMainRequestAtBySession.set(sessionKey, now);
  while (lastMainRequestAtBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = lastMainRequestAtBySession.keys().next().value;
    if (oldest === undefined) break;
    lastMainRequestAtBySession.delete(oldest);
  }
}

/**
 * Effort to inject when the host sent none, for a model that is adaptive and
 * takes effort.
 *
 * Precedence: `CLAUDE_CODE_EFFORT_LEVEL` (a valid level, or `auto`) >
 * `config.default_effort` (default "medium") > for `auto`, the catalogue's
 * `defaultEffort` > "high". A level the model's catalogue entry does not carry
 * (`xhigh` / `max` on a model without them) is clamped to "high".
 *
 * @param {string} model
 * @param {{default_effort?: string} | undefined} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveDefaultEffort(model, config, env) {
  const normalize = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
  const isValid = (value) => EFFORT_LEVELS.has(value) || value === "auto";
  const fromEnv = normalize(env.CLAUDE_CODE_EFFORT_LEVEL);
  const fromConfig = normalize(config?.default_effort);
  let level = "medium";
  if (isValid(fromEnv)) level = fromEnv;
  else if (isValid(fromConfig)) level = fromConfig;
  if (level === "auto") level = catalogueDefaultEffortWire(model) ?? "high";
  return supportsEffortLevelWire(model, level) ? level : "high";
}

/**
 * Coerce an incoming `thinking` block to the shape the model actually accepts.
 *
 * Lives here rather than in a model module because it is a BODY transform, not
 * a model query: the only model knowledge it needs is `isAdaptiveThinkingModel`,
 * which now comes from the wire-compat seam. This module is its sole caller.
 *
 * @param {any} thinking
 * @param {string} model
 * @returns {any}
 */
export function normalizeThinkingBlock(thinking, model) {
  // If thinking is absent or not an object, pass through
  if (!thinking || typeof thinking !== "object") {
    return thinking;
  }

  // Adaptive thinking models always get { type: "adaptive" }
  // regardless of what format the incoming thinking block has
  if (isAdaptiveThinkingModel(model)) {
    // Check for env-var override to force budget_tokens fallback
    if (isTruthyEnv(process.env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING)) {
      // Fallback: return as-is if already budget_tokens shape, otherwise default
      if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
        return thinking;
      }
      const parsedBudget = parseInt(process.env.MAX_THINKING_TOKENS, 10);
      return { type: "enabled", budget_tokens: Number.isNaN(parsedBudget) ? 16000 : parsedBudget };
    }
    // Keep the caller's display: dropping it makes the wire builder fall back to "updates",
    // which returns empty thinking text on models that default to "omitted" (Opus 5.5, Fable 5.1).
    // Only the values the wire builder honors are kept.
    return THINKING_DISPLAYS.has(thinking.display)
      ? { type: "adaptive", display: thinking.display }
      : { type: "adaptive" };
  }

  // Non-adaptive models: pass through unchanged
  return thinking;
}

// Core tool names (CC PascalCase) that are always eager-loaded.
export const CORE_TOOL_NAMES = new Set([
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "WebFetch",
  "TodoWrite",
  "Skill",
  "Task",
  "Compress",
]);

/**
 * True for a text block that holds only an opencode-model-router turn-state tail
 * (`<router-state>…</router-state>`): per-request state the host never persists.
 *
 * @param {unknown} block
 * @returns {boolean}
 */
function isRouterStateBlock(block) {
  if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return false;
  const text = block.text.trim();
  return text.startsWith("<router-state>") && text.endsWith("</router-state>");
}

/**
 * Put the one message cache breakpoint on the last block of the last user
 * message (real CC behaviour). When that block is a trailing `<router-state>`
 * tail, the breakpoint goes on the nearest earlier block instead, so the cache
 * entry ends on content the next request repeats; thinking, redacted thinking
 * and blank text blocks are never marked. Without a tail, behaviour is unchanged.
 *
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @param {{type: string, ttl?: string}} marker
 */
function placeMessageBreakpoint(messages, marker) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) continue;
    const lastBlock = msg.content[msg.content.length - 1];
    if (!isRouterStateBlock(lastBlock)) {
      if (lastBlock && typeof lastBlock === "object") lastBlock.cache_control = marker;
      return;
    }
    for (let m = i; m >= 0; m--) {
      const content = messages[m].content;
      if (typeof content === "string") {
        // Anthropic's string shorthand is one text block; normalize it so the
        // breakpoint can sit on it (same tokens, so the cached prefix is unchanged).
        if (content.trim() === "" || isRouterStateBlock({ type: "text", text: content })) continue;
        messages[m].content = [{ type: "text", text: content, cache_control: marker }];
        return;
      }
      if (!Array.isArray(content)) continue;
      const start = m === i ? content.length - 2 : content.length - 1;
      for (let b = start; b >= 0; b--) {
        const block = content[b];
        if (!block || typeof block !== "object" || isRouterStateBlock(block)) continue;
        if (block.type === "thinking" || block.type === "redacted_thinking") continue;
        if (block.type === "text" && (typeof block.text !== "string" || block.text.trim() === "")) continue;
        block.cache_control = marker;
        return;
      }
    }
    return;
  }
}

/**
 * Transform the request body: system prompt sanitization and tool prefixing.
 * Preserves behaviors E1-E7.
 *
 * @param {string | undefined} body
 * @param {{enabled: boolean, claudeCliVersion: string, promptCompactionMode: 'minimal' | 'off', provider?: string, useAdapter?: boolean}} signature
 * @param {{persistentUserId: string, sessionId: string, accountId: string, turns?: number, usedTools?: Set<string>}} runtime
 * @param {boolean} [taskBudgetsActive] - Whether `task-budgets-2026-03-13` is active for this
 *   request. Derived by the caller from the same gates the adapter applies to a custom beta
 *   (signature emulation, shortcut resolution, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`); this
 *   used to be the full pre-computed `anthropic-beta` header string, substring-tested here.
 * @param {import('../config.mjs').AnthropicAuthConfig} [config] - Plugin configuration for output cap
 * @returns {string | undefined}
 */
export function transformRequestBody(body, signature, runtime, taskBudgetsActive, config) {
  if (!body || typeof body !== "string") return body;
  const sessionMetrics = runtime?.sessionMetrics ?? legacySessionMetrics;

  try {
    const parsed = JSON.parse(body);
    // Diagnostic: log the incoming model + thinking/speed shape so model-routing
    // issues (e.g. an unrecognized fast variant, or "No available account"
    // symptoms tied to a specific model) are observable with /anthropic set debug on.
    // NOTE: transformRequestBody is a top-level function outside the plugin
    // closure where debugLog() lives, so we mirror debugLog's behaviour directly
    // (console.error + same prefix, gated on config.debug).
    if (config?.debug) {
      console.error("[opencode-anthropic-auth]", "transformRequestBody: incoming model", {
        model: parsed.model,
        adaptive: isAdaptiveThinkingModel(parsed.model || ""),
        thinkingType: parsed.thinking?.type,
        hasEffort: parsed.effort !== undefined || parsed.output_config?.effort !== undefined,
        speed: parsed.speed,
      });
    }
    // Output cap: resolve max_tokens before any other body transforms
    if (config?.output_cap?.enabled) {
      parsed.max_tokens = resolveMaxTokens(parsed, config, sessionMetrics);
    }
    // With the output cap off the host's max_tokens passes through untouched, and
    // the wire library rejects a body without one (INVALID_INPUT). opencode's
    // provider always sends it, so this is defensive: when the host omitted it,
    // send what the genuine client sends, the catalogue's default output limit.
    // Ids the catalogue does not know are left alone (no number to invent).
    if (typeof parsed.max_tokens !== "number" && parsed.model) {
      const catalogueDefault = catalogueDefaultMaxTokensWire(parsed.model);
      if (catalogueDefault !== undefined) parsed.max_tokens = catalogueDefault;
    }
    // The body-level `anthropic_beta` array existed only for Bedrock, which does
    // not forward custom HTTP headers. Multi-provider support was removed, and
    // the first-party API rejects betas in the body with "Extra inputs are not
    // permitted" — they are header-only here.
    // Strip any incoming "betas" field — API rejects it as unknown
    if (Object.prototype.hasOwnProperty.call(parsed, "betas")) {
      delete parsed.betas;
    }
    // Normalize thinking block for adaptive (Opus 4.6 / Sonnet 4.6) vs manual (older models).
    // Real CC always sends thinking:{type:"adaptive"} for adaptive models even if the
    // upstream SDK didn't include it. Inject it when missing to match the fingerprint.
    if (Object.prototype.hasOwnProperty.call(parsed, "thinking")) {
      // Models that REJECT `thinking: {type: "disabled"}` (catalogue capability
      // `rejects_disabled_thinking`: sonnet-5-5, opus-5-5, fable-5-x, mythos-5-x)
      // are all adaptive in the emulated catalogue, so normalizeThinkingBlock
      // already turned the host's "disabled" into adaptive for them.
      parsed.thinking = normalizeThinkingBlock(parsed.thinking, parsed.model || "");
    } else if (parsed.model && isAdaptiveThinkingModel(parsed.model)) {
      parsed.thinking = { type: "adaptive" };
    }

    // `output_config.effort` is only accepted by models whose catalogue entry
    // carries the `effort` capability, and the API REJECTS it elsewhere rather
    // than ignoring it. So effort (host-supplied or injected below) exists only
    // when the model is adaptive AND the catalogue marks effort; everywhere else
    // both the top-level and the nested spelling are removed.
    const effortModel =
      Boolean(parsed.model) && isAdaptiveThinkingModel(parsed.model) && supportsEffortWire(parsed.model);

    // Fingerprint fix: real Claude Code v2.1.87+ nests the effort control inside
    // `output_config.effort` (via Lyz() in cli.js). opencode's provider transform
    // for variant=max on Opus 4.6 / Sonnet 4.6 sets `effort` at the top level,
    // which causes Anthropic's server to fingerprint the body as non-CC and bill
    // it as pay-as-you-go — surfacing as "You're out of extra usage" even on a
    // valid Max plan. Move it into output_config when we're talking to an
    // adaptive-thinking model so the wire shape matches real CC.
    if (typeof parsed.effort === "string" && effortModel) {
      if (!parsed.output_config || typeof parsed.output_config !== "object") {
        parsed.output_config = {};
      }
      if (!("effort" in parsed.output_config)) {
        parsed.output_config.effort = parsed.effort;
      }
      delete parsed.effort;
    } else if (Object.prototype.hasOwnProperty.call(parsed, "effort")) {
      // Models without effort never carry a top-level effort in real CC — strip
      // it to avoid polluting the fingerprint for models like Haiku.
      delete parsed.effort;
    }
    if (!effortModel && parsed.output_config && typeof parsed.output_config === "object") {
      if (Object.prototype.hasOwnProperty.call(parsed.output_config, "effort")) {
        delete parsed.output_config.effort;
        if (Object.keys(parsed.output_config).length === 0) delete parsed.output_config;
      }
    }

    // Default effort when the host omits it entirely. The genuine client's
    // default depends on the model and plan; the plugin's maintainer-chosen
    // default is "medium" (`default_effort`), `auto` follows the catalogue, and
    // `CLAUDE_CODE_EFFORT_LEVEL` wins over both. See resolveDefaultEffort.
    if (effortModel) {
      if (!parsed.output_config || typeof parsed.output_config !== "object") {
        parsed.output_config = {};
      }
      if (!("effort" in parsed.output_config)) {
        parsed.output_config.effort = resolveDefaultEffort(parsed.model, config, process.env);
      }
    }

    // Claude Code temperature rule: when extended thinking is active (any type),
    // temperature must be omitted (undefined). Otherwise default to 1.
    const thinkingActive =
      parsed.thinking &&
      typeof parsed.thinking === "object" &&
      (parsed.thinking.type === "adaptive" || parsed.thinking.type === "enabled");
    if (thinkingActive) {
      // Anthropic API rejects temperature when thinking is enabled
      delete parsed.temperature;

      // Claude Code v2.1.84: inject the context_management body field ONLY when the
      // user has explicitly opted in via token_economy.context_management. Note: as of
      // v2.1.195 the context-management *beta header* is default-ON for first-party
      // non-claude-3 models (see buildAnthropicBetaHeader), but the body field stays
      // opt-in. A top-level context_management field WITHOUT the beta is rejected with
      // "context_management: Extra inputs are not permitted"; the beta being present
      // without the field is fine. Gating the field on explicit opt-in keeps the field
      // ⊆ beta invariant, so the 400 never fires.
      if (
        config?.token_economy?.context_management &&
        !isClaude3Model(parsed.model || "") &&
        !parsed.context_management
      ) {
        parsed.context_management = {
          edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        };
      }
    } else {
      // Claude Code always uses temperature: 1 for non-thinking requests (RE doc §5.2, never 0)
      parsed.temperature = 1;
    }

    // Strip leaked /anthropic slash command messages from conversation history.
    // OpenCode may include command text and sendCommandMessage output as regular
    // user messages even when output.noReply = true was set. Filter them out
    // so the agent never sees /anthropic commands in its context.
    if (Array.isArray(parsed.messages)) {
      parsed.messages = stripSlashCommandMessages(parsed.messages);
    }

    // === Token economy: layered message/history compaction ===
    // Only applies to main-thread requests (subagents/title-gen stay untouched).
    // Strategies stack in order: TTL thinking strip → proactive microcompact →
    // trailing-summary trim → tool_result dedupe. Each is independently gated.
    const te = config?.token_economy || {};
    const tes = runtime?.tokenEconomySession;
    const isMainRole = runtime?.requestRole === "main" || runtime?.requestRole == null;

    // `conservative` (default ON) disables all history-rewriting and tool-array
    // transforms. These optimizations shrink each request body but cause the
    // prompt-cache prefix to change turn-to-turn, invalidating the 1h cache
    // and forcing a fresh cache_write each turn — which costs 2x base input
    // tokens. For long opencode sessions, cache reuse dominates; flip to
    // `false` only if you have measurements showing otherwise, or set
    // `cold_cache_only` to allow the rewrites just when the cache is already cold.
    const conservative = te.conservative !== false;

    // Resolve the prompt-cache TTL ONCE so system blocks, tools, and messages
    // all share the SAME ttl. Anthropic processes cache_control blocks in the
    // order tools → system → messages and rejects any ttl='1h' block that comes
    // AFTER a ttl='5m' block. Before this fix the role-scoped 5m downgrade was
    // applied only to tools/messages (resolveCacheTtl in the breakpoint loop)
    // while the system blocks kept the configured 1h — so subagent requests
    // (5m tools, then 1h system) tripped:
    //   "system.1.cache_control.ttl: a ttl='1h' cache_control block must not
    //    come after a ttl='5m' cache_control block".
    // Threading it through buildSystemPromptBlocks keeps every cache_control ttl
    // consistent (real CC derives the ttl uniformly from querySource).
    // Resolved this early because the cold-cache decision below needs it.
    const baseCachePolicy = signature.cachePolicy || { ttl: "1h", ttl_supported: true };
    const cachingEnabledForTtl = baseCachePolicy.ttl !== "off" && baseCachePolicy.ttl_supported !== false;
    const resolvedCacheTtl = cachingEnabledForTtl
      ? resolveCacheTtl({
          configuredTtl: baseCachePolicy.ttl || "1h",
          roleScopedTtl: config?.token_economy?.role_scoped_cache_ttl !== false,
          isMainForCache: runtime?.requestRole === "main" || runtime?.requestRole == null,
          isSubagent: runtime?.isSubagent === true,
          env: process.env,
        })
      : baseCachePolicy.ttl;
    // The messages breakpoint may carry a shorter TTL than system/tools
    // (CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m). History is what rewrites
    // invalidate, so coldness is judged against the TTL the history was cached with.
    const resolvedMessagesTtl = cachingEnabledForTtl
      ? resolveMessagesCacheTtl(resolvedCacheTtl, process.env)
      : resolvedCacheTtl;

    // Cold-cache bookkeeping, per conversation. Only main-thread requests write
    // the cache that history rewrites would invalidate, so only they are noted.
    const sessionKey = runtime?.sessionKey ?? "default";
    const requestNow = Date.now();
    const lastMainRequestMs = lastMainRequestAtBySession.get(sessionKey);
    const cacheCold = isCacheCold({ lastRequestMs: lastMainRequestMs, now: requestNow, ttl: resolvedMessagesTtl });
    if (isMainRole) noteMainRequest(sessionKey, requestNow);
    const coldCacheOnly = te.cold_cache_only === true;
    // `conservative` (default) forbids history/tool rewrites outright; opting out
    // allows them always, UNLESS `cold_cache_only` narrows that to "only when the
    // cache is already cold" (and, being the more specific opt-in, also lifts
    // `conservative`, whose whole reason is protecting a warm cache). A session
    // that already rewrote cold keeps rewriting (see rewrittenColdBySession), so
    // a warm request reads the prefix the cold one cached instead of undoing it.
    const rewriteAllowed =
      (!conservative && !coldCacheOnly) || (coldCacheOnly && (cacheCold || rewrittenColdBySession.has(sessionKey)));
    // Whether any history/tool rewrite below changed the request, for the latch.
    let rewroteHistory = false;

    // Genuine-client idle clearing: after a long idle (cache cold by definition),
    // replace old tool results with the genuine placeholder. Opt-in; needs a
    // known previous request to measure the idle time from.
    if (
      isMainRole &&
      te.idle_tool_result_clearing === true &&
      cacheCold &&
      typeof lastMainRequestMs === "number" &&
      Array.isArray(parsed.messages)
    ) {
      const res = applyIdleToolResultClearing(parsed.messages, {
        idleMs: requestNow - lastMainRequestMs,
        ttlMs: ttlToMs(resolvedMessagesTtl) ?? undefined,
      });
      if (res.changed) parsed.messages = res.messages;
    }

    if (rewriteAllowed && isMainRole && Array.isArray(parsed.messages) && tes) {
      // (1) TTL-based thinking strip
      if (te.ttl_thinking_strip !== false) {
        // With cold_cache_only the coldness is already established above, so the
        // strip's own "ran within ttl" throttle must not veto it (ttlMs 0).
        const ttlMs = coldCacheOnly ? 0 : signature?.cachePolicy?.ttl === "5m" ? 5 * 60_000 : 60 * 60_000;
        const res = applyTtlThinkingStrip(parsed.messages, {
          lastClearMs: tes.lastThinkingStripMs,
          ttlMs,
        });
        if (res.changed) {
          rewroteHistory = true;
          parsed.messages = res.messages;
          tes.lastThinkingStripMs = res.ranStripAt;
          tes.thinkingStripped += res.cleared;
        }
      }

      // (1b) Session-wide reproducible-tool result dedupe (Phase C C3, opt-in)
      // Pure over message history; runs before microcompact so dedup'd stubs
      // are visible to downstream size estimation. Gated by
      // token_economy_strategies.tool_result_dedupe_session_wide (default off).
      if (config?.token_economy_strategies?.tool_result_dedupe_session_wide === true) {
        const res = applySessionToolResultDedupe(parsed.messages);
        if (res.changed) {
          rewroteHistory = true;
          parsed.messages = res.messages;
        }
      }

      // (2) Proactive microcompact (client-side, pre-422)
      if (te.proactive_microcompact !== false) {
        const estimated = estimatePromptTokensFromParsed(parsed);
        const cw = 200_000; // conservative — 1M models still benefit
        const res = applyProactiveMicrocompact(parsed.messages, {
          estimatedTokens: estimated,
          contextWindow: cw,
          percent: te.microcompact_percent ?? 70,
          keepRecent: te.microcompact_keep_recent ?? 8,
        });
        if (res.changed) {
          rewroteHistory = true;
          parsed.messages = res.messages;
          tes.lastMicrocompactMs = Date.now();
          tes.toolResultsCompacted += res.cleared;
        }
      }

      // (3) Trailing-summary trim (opt-in)
      if (te.trailing_summary_trim === true) {
        const res = applyTrailingSummaryTrim(parsed.messages);
        if (res.changed) {
          rewroteHistory = true;
          parsed.messages = res.messages;
        }
      }

      // (4) Cross-turn tool_result dedupe (opt-in)
      if (te.tool_result_dedupe === true) {
        const SAFE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "BashOutput"]);
        const res = applyToolResultDedupe(parsed.messages, {
          seen: tes.seenContentHashes,
          safeTools: SAFE_READ_TOOLS,
        });
        if (res.changed) {
          rewroteHistory = true;
          parsed.messages = res.messages;
        }
      }
    }

    // === Token economy: tool-array transforms (stable ordering, deferral) ===
    if (rewriteAllowed && isMainRole && Array.isArray(parsed.tools)) {
      if (te.stable_tool_ordering !== false) {
        const ordered = applyStableToolOrdering(parsed.tools);
        if (ordered.some((tool, index) => tool !== parsed.tools[index])) rewroteHistory = true;
        parsed.tools = ordered;
      }
      if (Array.isArray(te.deferred_tool_names) && te.deferred_tool_names.length > 0) {
        // "Invoked" means any assistant message in the convo has used the tool.
        const invoked = new Set();
        if (Array.isArray(parsed.messages)) {
          for (const m of parsed.messages) {
            if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
            for (const b of m.content) {
              if (b?.type === "tool_use" && typeof b.name === "string") invoked.add(b.name);
            }
          }
        }
        const res = applyToolSchemaDeferral(parsed.tools, {
          deferred: new Set(te.deferred_tool_names),
          invoked,
        });
        if (res.deferredCount > 0) rewroteHistory = true;
        parsed.tools = res.tools;
      }
    }
    // Remember a cold rewrite so the warm requests that follow replay it.
    if (coldCacheOnly && isMainRole && rewroteHistory) noteColdRewrite(sessionKey);

    // === Token economy: adaptive thinking zero-out for trivial follow-ups ===
    // Opt-in (default off): changing the thinking configuration between turns
    // invalidates the message cache, and current models reject disabled thinking.
    if (isMainRole && te.adaptive_thinking_zero_simple === true) {
      applyAdaptiveThinkingZero(parsed);
    }

    // QA fix H2: avoid mutating the signature parameter; capture modelId locally
    const modelId = parsed.model || "";
    // Extract first user message text for billing hash computation (cch)
    const firstUserMessage = extractFirstUserMessageText(parsed.messages);
    // `resolvedCacheTtl` / `baseCachePolicy` were resolved ONCE above, before
    // the token-economy block, so system blocks, tools and messages share the
    // same ttl (see the comment there).
    const signatureWithModel = {
      ...signature,
      modelId,
      // Override cachePolicy.ttl with the role/subagent-resolved ttl so the
      // system blocks match the tool/message breakpoint ttl (see comment above).
      cachePolicy: { ...baseCachePolicy, ttl: resolvedCacheTtl },
      firstUserMessage,
      antiVerbosity: config?.anti_verbosity,
      // The live `system_prompt` config (empowerment, opening, stable/volatile
      // split, rewrite scope). Without it buildSystemPromptBlocks always used the
      // defaults and the settings were dead. A caller-supplied
      // `signature.systemPrompt` still applies when the config carries none.
      ...(typeof config?.system_prompt === "object" && config.system_prompt !== null
        ? { systemPrompt: config.system_prompt }
        : {}),
      // Role-aware system-prompt leaning (title, small, empty shapes). OFF by
      // default (`token_economy.lean_system_non_main`, opt-in with `true`): the
      // main interactive thread is never lean, and a stripped identity/billing
      // block makes side requests differ from the genuine client. On the adapter
      // path the decision that actually removes the billing and identity blocks
      // is made in adapter-input.mjs (`suppressBillingBlock` /
      // `suppressIdentityBlock`); this flag only steers the host-block policy in
      // buildSystemPromptBlocks. Title-gen path is handled separately by
      // isTitleGeneratorSystemBlocks().
      requestRole: runtime?.requestRole,
      leanNonMain: config?.token_economy?.lean_system_non_main === true,
      // Simple-system-prompt mode for Opus 4.7+ (CC v2.1.133+ parity, gated by
      // GrowthBook `tengu_velvet_tide` in real CC). Plugin gate: model
      // eligibility + opt-in flag. See buildSystemPromptBlocks for what it
      // strips (anti-verbosity boilerplate only; identity/billing untouched).
      simpleSystemPrompt: config?.token_economy?.simple_system_prompt === true,
      // Workload tag for x-anthropic-billing-header `cc_workload=` segment.
      // Mirrors real CC's `--workload <tag>` CLI flag (process-scoped, used by
      // SDK daemon callers spawning cron subprocesses). Empty string -> omit.
      workload: typeof config?.signature_emulation?.workload === "string" ? config.signature_emulation.workload : "",
    };
    // Host system-prompt policy: sanitize, compact, dedupe, anti-verbosity, and
    // the prompt-cache breakpoint. The canonical billing + identity prefix is
    // NOT built here — the shared package composes it (see system-prompt.mjs).
    parsed.system = buildSystemPromptBlocks(normalizeSystemTextBlocks(parsed.system), signatureWithModel);

    // Strategy 5 — System prompt tailing: after N turns, trim large system blocks
    // to essential sections only. The model has internalized verbose instructions
    // (shell strategy, package manager tables, delegation protocols) by this point.
    // Preserves: first paragraph (identity/role), lines containing MUST/NEVER/CRITICAL/
    // IMPORTANT, section headers, and short blocks. Drops verbose body paragraphs.
    const tailThreshold = signature.systemPromptTailTurns ?? 6;
    if (signature.systemPromptTailing === true && runtime.turns >= tailThreshold && Array.isArray(parsed.system)) {
      const maxChars = signature.systemPromptTailMaxChars ?? 2000;
      for (let i = 0; i < parsed.system.length; i++) {
        const block = parsed.system[i];
        if (block.type === "text" && block.text && block.text.length > maxChars * 2) {
          block.text = tailSystemBlock(block.text, maxChars, tailThreshold);
        }
      }
    }

    // Token budget (A9): parse NL budget from last user message, inject status block
    if (config?.token_budget?.enabled && Array.isArray(parsed.messages)) {
      const budgetExpr = parseNaturalLanguageBudget(parsed.messages);
      if (budgetExpr > 0) {
        sessionMetrics.tokenBudget.limit = budgetExpr;
      } else if (config.token_budget.default > 0 && sessionMetrics.tokenBudget.limit === 0) {
        sessionMetrics.tokenBudget.limit = config.token_budget.default;
      }
      // If budget is active, inject status into system prompt
      if (sessionMetrics.tokenBudget.limit > 0) {
        const threshold = config.token_budget.completion_threshold ?? 0.9;
        parsed.system = injectTokenBudgetBlock(parsed.system, sessionMetrics.tokenBudget, threshold);
        // Soft stop: if we've exceeded the threshold, cap max_tokens to 1
        if (sessionMetrics.tokenBudget.used >= sessionMetrics.tokenBudget.limit * threshold) {
          parsed.max_tokens = 1;
        }
      }
    }

    // Adapter path only: the shared package composes `metadata.user_id` itself
    // from the runtime correlation triple, and the two env features become
    // `metadataOverrides` on the transport instead (see adapter-input.mjs).
    // Writing metadata here as well would collide with the package's own
    // composition. CONDITIONAL, never unconditional: the legacy path still
    // needs buildRequestMetadata.
    if (signature.enabled && signature.useAdapter !== true) {
      const currentMetadata =
        parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
          ? parsed.metadata
          : {};
      parsed.metadata = {
        ...currentMetadata,
        ...buildRequestMetadata({
          persistentUserId: runtime.persistentUserId,
          accountId: runtime.accountId,
          sessionId: runtime.sessionId,
        }),
      };
    }

    // Per-turn effort (adapter path, main thread, models with the
    // `per_turn_effort` capability): a changed effort for one turn (a host
    // variant switch, or auto-low for a short typed question) travels as the
    // genuine `role:"system"` control message right before that turn, and the
    // top-level `output_config.effort` stays the effort the session started
    // with, so the cached prefix is never rewritten. Placed after every history
    // transform above (they see the conversation without control messages) and
    // before the breakpoint placement below, which only ever marks user blocks.
    // Thinking is untouched.
    if (
      isMainRole &&
      signature.useAdapter === true &&
      runtime?.isSubagent !== true &&
      Array.isArray(parsed.messages) &&
      typeof parsed.output_config?.effort === "string"
    ) {
      const perTurn = applyPerTurnEffort({
        messages: parsed.messages,
        sessionKey,
        model: modelId,
        effort: parsed.output_config.effort,
        settings: config?.per_turn_effort,
        capable: supportsPerTurnEffortWire(modelId),
      });
      if (perTurn.active) {
        parsed.messages = perTurn.messages;
        parsed.output_config.effort = perTurn.effort;
      }
    }

    // Cache breakpoint optimization: add cache_control to the last content block
    // of each user/assistant message for maximum prefix caching.
    // Skip for round-robin strategy (cache defeated by account rotation).
    // Skip for title generators / fire-and-forget queries: these are one-shot
    // requests that don't benefit from caching and would pollute the cache pool.
    const isTitleGen = isTitleGeneratorSystemBlocks(parsed.system || []);
    if (
      signature.enabled &&
      signature.cachePolicy?.ttl !== "off" &&
      signature.cachePolicy?.ttl_supported !== false &&
      !isTitleGen
    ) {
      // Strip ALL incoming cache_control from tools and messages to prevent
      // TTL ordering violations (host SDK may set ttl=5m which conflicts with
      // our system prompt ttl=1h). Then add our own to the last user message
      // (matching real CC behavior seen in proxy capture).
      //
      // Role-scoped TTL: real CC's REH(querySource) decides the `ttl:"1h"` field.
      // Decompiled from CC 2.1.154 (function REH, offset 225174828), precedence:
      //   1. FORCE_PROMPT_CACHING_5M  => 5m (highest priority)
      //   2. ENABLE_PROMPT_CACHING_1H => 1h
      //   3. no tengu support / overage => 5m
      //   4. querySource ∈ allowlist [repl_main_thread*, sdk, auto_mode, ...] => 1h, else 5m
      // We map step 4 via classifyRequestRole: main (interactive/auto_mode thread)
      // → 1h; side-queries (title-gen, etc.) → 5m. The env vars are honored
      // exactly as CC does, giving the user a manual override + mimicry fidelity.
      // Reuse the request-wide resolved ttl (computed above where
      // signatureWithModel is built) so tools/messages match the system blocks
      // and never trip the 1h-after-5m ordering rule on subagent requests.
      const ccTtl = resolvedCacheTtl;
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        for (const tool of parsed.tools) {
          if (tool.cache_control) delete tool.cache_control;
        }
        // Adaptive breakpoint placement (opt-in, runtime-driven). Real CC always
        // pins the breakpoint on the last tool because CC controls a STABLE tool
        // array. opencode may reorder/add/remove tools between turns, which moves
        // the "last tool" and invalidates the cached prefix after it. When the
        // detector reports the tool boundary is thrashing while the system prompt
        // is stable, we SKIP the volatile last-tool breakpoint and let the stable
        // system-prompt breakpoint (added by buildSystemPromptBlocks) anchor the
        // cache. Falls back to exact CC behavior when no stability data exists.
        const placeToolBreakpoint = shouldPlaceToolBreakpoint(runtime?.cacheBoundaryStability);
        if (placeToolBreakpoint) {
          parsed.tools[parsed.tools.length - 1].cache_control = { type: "ephemeral", ttl: ccTtl };
        }
      }
      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              // CONTRACT GUARD: `thinking` / `redacted_thinking` blocks MUST be
              // round-tripped byte-identical to the model's original response
              // (Anthropic extended-thinking rules). ANY mutation — including
              // `delete block.cache_control` — triggers the 400 error
              // "thinking or redacted_thinking blocks in the latest assistant
              // message cannot be modified". `cache_control` is not even a valid
              // field on a thinking block, so we never strip nor add it here;
              // we leave the block exactly as received. This is required for
              // adaptive-thinking models (Opus 4.6/4.7/4.8, Sonnet 4.6) on
              // tool-continuation turns. See docs/mimese-http-header-system-prompt.md.
              if (!block || typeof block !== "object") continue;
              if (block.type === "thinking" || block.type === "redacted_thinking") {
                continue;
              }
              if (block.cache_control) delete block.cache_control;
            }
          }
        }
        // At most one message breakpoint (see placeMessageBreakpoint). Normally
        // it goes on the last block of the last user message with array
        // content (real CC does this). When that block is a per-request
        // `<router-state>` tail (opencode-model-router's turn state, never
        // persisted, so a breakpoint on it writes an entry the next request
        // cannot read), it walks back to the nearest earlier eligible block:
        // the rest of that message, then earlier messages of any role, newest
        // first, including assistant messages. The walk-back skips thinking,
        // redacted_thinking, blank text and other router-state blocks, so the
        // guard above still holds; earlier string content is normalized to one
        // text block. With no eligible block, no message breakpoint is placed.
        // Messages TTL: the one marker that may be shorter than system/tools
        // (CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m). Lowering only the LAST
        // marker cannot violate the "1h must not follow 5m" ordering rule.
        placeMessageBreakpoint(parsed.messages, { type: "ephemeral", ttl: resolvedMessagesTtl });
      }
    }

    // Tool name sanitization: Anthropic's server blocklists known non-CC tool names.
    // opencode uses lowercase names while CC uses PascalCase. While only "todowrite"
    // is currently confirmed blocklisted, we rename ALL core opencode tools to match
    // CC's naming convention as a preventive measure against future blocklist additions.
    if (Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.name && OC_TO_CC_TOOL_NAMES.has(tool.name)) {
          tool.name = OC_TO_CC_TOOL_NAMES.get(tool.name);
        }
      }
    }
    // Also rename in tool_use blocks in messages (assistant responses referencing the tool)
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.name && OC_TO_CC_TOOL_NAMES.has(block.name)) {
            block.name = OC_TO_CC_TOOL_NAMES.get(block.name);
          }
        }
      }
    }
    // Track which tools the model has used (from assistant tool_use blocks).
    // Names are already CC PascalCase after renaming above.
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.name) {
              runtime.usedTools.add(block.name);
            }
          }
        }
      }
    }

    // Strategy 4 — Adaptive tool set: after turn 3, defer non-core tools that
    // the model hasn't used yet. This saves schema bytes on turns where tools
    // are unlikely to be needed. Core tools stay eager. Resets on /clear.
    // Mimicry class (b), a plugin cost policy the genuine client does not
    // perform. Only Claude 3 ids opt out; Haiku 4.x supports tool use fine, so it
    // is no longer excluded by a name heuristic.
    if (
      Array.isArray(parsed.tools) &&
      signature.adaptiveToolSet !== false &&
      runtime.turns >= 3 &&
      parsed.model &&
      !isClaude3Model(parsed.model)
    ) {
      const used = runtime.usedTools;
      for (const tool of parsed.tools) {
        if (tool.name && !used.has(tool.name) && !CORE_TOOL_NAMES.has(tool.name)) {
          tool.defer_loading = true;
        }
      }
    }

    // Tool description compaction: apply the same compaction logic used for
    // system prompts (strip examples, collapse whitespace, dedup lines) to tool
    // descriptions. The top 4 tools (Bash 10.6K, TodoWrite 9.7K, Task 5.5K,
    // Compress 4.5K) account for 30KB. Compaction typically saves 30-50%.
    if (Array.isArray(parsed.tools) && signature.toolDescriptionCompaction !== false) {
      for (const tool of parsed.tools) {
        if (tool.description && tool.description.length > 500) {
          tool.description = compactToolDescription(tool.description);
        }
      }
    }

    // MCP tool deferral: mark non-core tools with defer_loading: true.
    // CC defers all MCP tools by default — the API omits their full schemas from token
    // counting, only sending the tool name. When the model needs a deferred tool, it uses
    // tool_reference to load the schema on demand. This saves ~20KB per turn.
    // Core tools (OC_TO_CC_TOOL_NAMES) are always eager-loaded.
    // Mimicry class (b); Claude 3 ids opt out, everything else (Haiku 4.x
    // included) follows the setting.
    if (
      Array.isArray(parsed.tools) &&
      signature.toolDeferral !== false &&
      parsed.model &&
      !isClaude3Model(parsed.model)
    ) {
      const coreToolNames = new Set(OC_TO_CC_TOOL_NAMES.values());
      for (const tool of parsed.tools) {
        if (tool.name && !coreToolNames.has(tool.name)) {
          tool.defer_loading = true;
        }
      }
    }

    // Task budgets: when the task-budgets beta is active, preserve or inject output_config.
    // The beta unlocks output_config.max_output_tokens for per-task budget control.
    // Model-router compatibility: the beta header + output_config body are forwarded as-is.
    // The signal is a boolean derived by the caller — this used to substring-test a
    // pre-computed `anthropic-beta` header string built solely for this line.
    if (taskBudgetsActive) {
      if (!parsed.output_config) {
        // Default: set a reasonable per-task output budget for long-running agentic tasks.
        // Claude Code tasks typically need generous output budgets.
        parsed.output_config = { max_output_tokens: 16384 };
      }
    }

    // The `context_hint` body field is never injected, on either path. The
    // profile derived from the real Claude Code 2.1.195 binary does not send it
    // (nor the paired context-hint-2026-04-09 beta), so emitting it would be a
    // fingerprint. `token_economy.context_hint` is deprecated in lib/config.mjs,
    // which warns on explicit opt-in rather than silently doing nothing.

    // Fast mode: inject speed parameter for fast-mode-eligible models.
    // Eligibility is the emulated catalogue's `fast_mode` capability (under the
    // current profile: Opus 4.8, Opus 5, Opus 5.5), not a hand-kept family list.
    // `fast_mode_legacy_models` (default off) additionally allows Opus 4.6 and
    // 4.7, which accepted `speed: "fast"` before the catalogue dropped them.
    // NOTE: switching speed invalidates system + message prompt caches (per
    // Anthropic fast-mode docs), so only flip it deliberately.
    // When the selected account's fast pool is cooling down (a prior fast 429),
    // suppress speed:"fast" entirely so this turn runs at standard speed on the
    // same account rather than re-hitting the exhausted fast pool.
    const fastPoolAvailable = !signature.fastRateLimited;
    const fastModeLegacyModels = config?.fast_mode_legacy_models === true;
    const isFastModeEligibleModel = (m) =>
      fastPoolAvailable && isFastModeEligibleWire(m, { legacyModels: fastModeLegacyModels });
    // `OPENCODE_ANTHROPIC_DISABLE_FAST_MODE` is a kill switch: a truthy value
    // (`1`/`true`/`yes`, case- and whitespace-insensitive) turns fast mode off
    // for every source of `speed` (the `fast_mode` setting, `fast_mode_auto`, and
    // a `speed: "fast"` the host itself sent). `0`/`false`/`no`/unset leave it on.
    const fastModeKilled = isTruthyEnv(process.env.OPENCODE_ANTHROPIC_DISABLE_FAST_MODE);
    const fastModeEnabled = Boolean(signature.fastMode) && !fastModeKilled;
    // A `speed: "fast"` that arrived from the host is subject to the same
    // eligibility as one the plugin would inject: wire-compat composes the
    // `fast-mode-2026-02-01` beta from `speed` with no per-model check, so a
    // host-sent value on an ineligible model (or while the kill switch is on, or
    // while the account's fast pool is cooling down) must be dropped here, which
    // also keeps the beta off the wire. Without a model there is nothing to judge.
    if (
      parsed.speed === "fast" &&
      (fastModeKilled || (typeof parsed.model === "string" && !isFastModeEligibleModel(parsed.model)))
    ) {
      delete parsed.speed;
    }
    let fastModeAutoApplied = false;
    if (
      !fastModeKilled &&
      !fastModeEnabled &&
      te.fast_mode_auto === true &&
      isMainRole &&
      parsed.model &&
      isFastModeEligibleModel(parsed.model) &&
      Array.isArray(parsed.messages) &&
      parsed.messages.length >= 2
    ) {
      // Simple exchange heuristic: last user message is short, no tool_result,
      // no file references. Suggests a follow-up question that doesn't need
      // deep reasoning.
      const last = parsed.messages[parsed.messages.length - 1];
      if (last && last.role === "user") {
        let txt = "";
        let hasToolResult = false;
        if (typeof last.content === "string") txt = last.content;
        else if (Array.isArray(last.content)) {
          for (const b of last.content) {
            if (b?.type === "tool_result") hasToolResult = true;
            if (b?.type === "text" && typeof b.text === "string") txt += b.text;
          }
        }
        if (!hasToolResult && txt.length < 240 && !/\bfile:|\.md\b|\.mjs\b|\.ts\b/i.test(txt)) {
          fastModeAutoApplied = true;
        }
      }
    }
    if ((fastModeEnabled || fastModeAutoApplied) && parsed.model && isFastModeEligibleModel(parsed.model)) {
      parsed.speed = "fast";
    }

    // Guard: repair orphaned tool_use blocks anywhere in the message array.
    // The Anthropic API requires that every assistant message containing tool_use
    // blocks is immediately followed by a user message with matching tool_result
    // blocks. When OpenCode crashes/hangs mid-tool-execution, the conversation
    // state may be saved with unpaired tool_use blocks. This causes:
    //   "messages.N: `tool_use` ids were found without `tool_result` blocks
    //    immediately after: toolu_XXXXX"
    // We scan the full array and synthesize missing tool_result messages.
    if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      parsed.messages = repairOrphanedToolUseBlocks(parsed.messages);

      // Also ensure the array never ends with an assistant message (prefill guard).
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        const toolUseBlocks = lastContent.filter((b) => b.type === "tool_use");
        if (toolUseBlocks.length > 0) {
          parsed.messages.push({
            role: "user",
            content: toolUseBlocks.map((tu) => ({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "[Result unavailable — conversation was restructured]",
            })),
          });
        } else {
          parsed.messages.push({
            role: "user",
            content: [{ type: "text", text: "Continue." }],
          });
        }
      }
    }

    return JSON.stringify(parsed);
  } catch {
    // ignore parse errors
    return body;
  }
}
