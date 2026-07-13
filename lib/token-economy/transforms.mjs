/**
 * Parse natural-language budget expressions from user messages.
 * Supports: +500k, 500,000, 2M, 2 million, "spend 500k", "use 2M tokens", "budget: 1M".
 * Only scans the last user message to avoid re-triggering from history.
 *
 * @param {Array<{role: string, content: string | Array<{type: string, text?: string}>}>} messages
 * @returns {number} Parsed token count, or 0 if no budget expression found
 */
function parseNaturalLanguageBudget(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  // Find the last user message
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") {
        lastUserText = content;
      } else if (Array.isArray(content)) {
        lastUserText = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join(" ");
      }
      break;
    }
  }
  if (!lastUserText) return 0;

  // Patterns ordered from most specific to least
  const patterns = [
    /\buse\s+(\d[\d,]*)\s*([mk])\s*tokens?\b/i,
    /\bspend\s+(\d[\d,]*)\s*([mk])?\b/i,
    /\bbudget[:\s]+(\d[\d,]*)\s*([mk])?\b/i,
    /\+(\d[\d,]*)\s*([mk])\b/i,
    /\b(\d[\d,]*)\s*million\s*tokens?\b/i,
  ];

  for (const re of patterns) {
    const m = lastUserText.match(re);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ""));
      if (isNaN(num) || num <= 0) continue;
      const suffix = (m[2] || "").toLowerCase();
      if (re === patterns[4]) {
        // "N million tokens" — the regex has no suffix group
        return num * 1_000_000;
      }
      if (suffix === "m") return num * 1_000_000;
      if (suffix === "k") return num * 1_000;
      // No suffix — treat as absolute count
      return num;
    }
  }
  return 0;
}

/**
 * Inject a token budget status block into the system prompt.
 * Prepends a text block with budget progress and threshold info.
 *
 * @param {Array<{type: string, text?: string, [k: string]: any}>} systemBlocks
 * @param {{limit: number, used: number, continuations: number}} budget
 * @param {number} threshold - Completion threshold (0-1, e.g. 0.9)
 * @returns {Array<{type: string, text?: string, [k: string]: any}>}
 */
function injectTokenBudgetBlock(systemBlocks, budget, threshold) {
  if (!budget || budget.limit <= 0) return systemBlocks;
  const pct = ((budget.used / budget.limit) * 100).toFixed(0);
  const thresholdTokens = Math.round(budget.limit * threshold);
  const remaining = Math.max(0, budget.limit - budget.used);
  const block = {
    type: "text",
    text: `Token budget: ${budget.used.toLocaleString()}/${budget.limit.toLocaleString()} tokens used (${pct}%). Stop generating at ${thresholdTokens.toLocaleString()} tokens. Remaining: ${remaining.toLocaleString()} tokens.`,
  };
  return [block, ...(systemBlocks || [])];
}

/**
 * Estimate prompt tokens from an already-parsed request body object.
 * Avoids redundant JSON.parse when the caller already has the parsed object.
 * @param {object} parsed - The parsed request body
 * @returns {number} Estimated token count
 */
function estimatePromptTokensFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return 0;
  let charCount = 0;

  // Count system prompt text
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block.type === "text" && typeof block.text === "string") {
        charCount += block.text.length;
      }
    }
  } else if (typeof parsed.system === "string") {
    charCount += parsed.system.length;
  }

  // Count messages content (text blocks, tool results) — skip tool definitions
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (typeof msg.content === "string") {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && typeof block.text === "string") {
            charCount += block.text.length;
          } else if (block.type === "tool_result" && typeof block.content === "string") {
            charCount += block.content.length;
          } else if (block.type === "tool_use") {
            // Count serialized input as tokens
            charCount += JSON.stringify(block.input || {}).length;
          } else if (block.type === "image" || block.type === "image_url") {
            // Images: ~2000 tokens per image (Anthropic tile-based counting)
            charCount += 8000; // 2000 tokens * 4 chars/token
          }
        }
      }
    }
  }

  // 4 chars/token heuristic for text content (reasonable for English + code + JSON)
  return Math.ceil(charCount / 4);
}

/**
 * Apply context-hint compaction to a message array. Mirrors real CC's
 * `applyHintEdits` (d85) + `qD4` microcompact: clears thinking/redacted_thinking
 * blocks from assistant messages and replaces old tool_result content with a
 * placeholder, keeping the last few tool results intact. Used on 422/424
 * responses before retrying.
 *
 * @param {Array} messages — Parsed messages array
 * @param {object} [opts]
 * @param {number} [opts.keepRecentToolResults=8] — How many most-recent tool_result blocks to preserve verbatim
 * @param {string} [opts.clearedPlaceholder] — Replacement content for older tool_result blocks
 * @returns {{ messages: Array, changed: boolean, stats: { thinkingCleared: number, toolResultsCleared: number } }}
 */
function applyContextHintCompaction(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, stats: { thinkingCleared: 0, toolResultsCleared: 0 } };
  }
  const keepRecent = opts.keepRecentToolResults ?? 8;
  const placeholder = opts.clearedPlaceholder ?? "[Old tool result content cleared]";

  // First pass: count tool_result blocks so we know which are "old" vs "recent".
  const toolResultRefs = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      if (msg.content[j]?.type === "tool_result") {
        toolResultRefs.push({ msgIdx: i, blockIdx: j });
      }
    }
  }
  const oldCutoff = Math.max(0, toolResultRefs.length - keepRecent);
  const oldSet = new Set(toolResultRefs.slice(0, oldCutoff).map((r) => `${r.msgIdx}:${r.blockIdx}`));

  let thinkingCleared = 0;
  let toolResultsCleared = 0;
  const out = messages.map((msg, i) => {
    if (!Array.isArray(msg.content)) return msg;
    if (msg.role === "assistant") {
      const newContent = msg.content.filter((block) => {
        if (block?.type === "thinking" || block?.type === "redacted_thinking") {
          thinkingCleared += 1;
          return false;
        }
        return true;
      });
      if (newContent.length !== msg.content.length) {
        return { ...msg, content: newContent };
      }
      return msg;
    }
    if (msg.role === "user") {
      let mutated = false;
      const newContent = msg.content.map((block, j) => {
        if (block?.type !== "tool_result") return block;
        const key = `${i}:${j}`;
        if (!oldSet.has(key)) return block;
        toolResultsCleared += 1;
        mutated = true;
        // Replace content with placeholder, preserve tool_use_id
        return {
          ...block,
          content: placeholder,
        };
      });
      return mutated ? { ...msg, content: newContent } : msg;
    }
    return msg;
  });

  return {
    messages: out,
    changed: thinkingCleared > 0 || toolResultsCleared > 0,
    stats: { thinkingCleared, toolResultsCleared },
  };
}

/**
 * Tools whose output is trivially reproducible by re-running with the same
 * arguments. Stateful tools (bash, edit, write, etc.) never dedupe — their
 * outputs may reflect non-idempotent side effects that the transcript needs
 * to preserve.
 */
const REPRODUCIBLE_TOOL_NAMES = new Set(["read", "grep", "glob", "ls", "list", "find"]);

/**
 * Title-case a tool name for the stub string ("read" → "Read", "grep" → "Grep").
 * Pure; no locale.
 */
function titleCaseToolName(name) {
  if (typeof name !== "string" || name.length === 0) return "";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * Minimal deterministic stable-stringify for args canonicalization.
 * Sorts object keys at every depth before serialization so that
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same string.
 *
 * Arrays are traversed in order. Non-plain objects (Date, Map, etc.) fall
 * through to `JSON.stringify` — we don't expect them in tool args, but the
 * fallback keeps the function total.
 */
function stableStringifyForDedupe(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringifyForDedupe(v)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringifyForDedupe(value[k]));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Session-wide tool-result dedupe. Pure over `messages`.
 *
 * Walks the conversation once to collect every `tool_use` + `tool_result`
 * pair where the tool is in `REPRODUCIBLE_TOOL_NAMES` (case-insensitive).
 * Groups them by `(toolName, stableStringify(args))`. For every group
 * containing more than one call, keeps the LATEST result verbatim and
 * replaces each earlier result's `content` with a stub:
 *
 *   `[<ToolTitleCase> of <argsKey> superseded by later read at msg #<N>]`
 *
 * where `N` is the message index of the latest call's user-message.
 *
 * `tool_use_id` and any other `tool_result` fields are preserved. Assistant
 * `tool_use` blocks are NEVER modified — only the paired user `tool_result`.
 *
 * Cache-stable: decision is a pure function of message history, so rerunning
 * over an unchanged prefix yields byte-identical output.
 *
 * @param {Array} messages — Parsed messages array
 * @returns {{ messages: Array, changed: boolean, stats: { deduped: number } }}
 */
function applySessionToolResultDedupe(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, stats: { deduped: 0 } };
  }

  // Pass 1: build tool_use_id → { name, argsKey } for reproducible tools.
  const idToMeta = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (!REPRODUCIBLE_TOOL_NAMES.has(name.toLowerCase())) continue;
      const argsKey = stableStringifyForDedupe(block.input ?? {});
      idToMeta.set(block.id, { name, argsKey });
    }
  }

  // Pass 2: collect tool_result locations by group key, preserving order.
  /** @type {Map<string, Array<{msgIdx: number, blockIdx: number, toolUseId: string, name: string, argsKey: string}>>} */
  const groups = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block?.type !== "tool_result") continue;
      const meta = idToMeta.get(block.tool_use_id);
      if (!meta) continue;
      const groupKey = meta.name.toLowerCase() + "\u0000" + meta.argsKey;
      let arr = groups.get(groupKey);
      if (!arr) {
        arr = [];
        groups.set(groupKey, arr);
      }
      arr.push({
        msgIdx: i,
        blockIdx: j,
        toolUseId: block.tool_use_id,
        name: meta.name,
        argsKey: meta.argsKey,
      });
    }
  }

  // Build supersede map: "msgIdx:blockIdx" → stub string.
  const supersedeStubs = new Map();
  let deduped = 0;
  // Deterministic iteration: sort group entries by group key before processing.
  const sortedEntries = Array.from(groups.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, occurrences] of sortedEntries) {
    if (occurrences.length < 2) continue;
    const latest = occurrences[occurrences.length - 1];
    const stub =
      "[" +
      titleCaseToolName(latest.name) +
      " of " +
      latest.argsKey +
      " superseded by later read at msg #" +
      latest.msgIdx +
      "]";
    for (let k = 0; k < occurrences.length - 1; k++) {
      const occ = occurrences[k];
      supersedeStubs.set(occ.msgIdx + ":" + occ.blockIdx, stub);
      deduped += 1;
    }
  }

  if (deduped === 0) {
    return { messages, changed: false, stats: { deduped: 0 } };
  }

  // Pass 3: rewrite. Preserve tool_use_id and other fields.
  const out = messages.map((msg, i) => {
    if (msg?.role !== "user" || !Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((block, j) => {
      if (block?.type !== "tool_result") return block;
      const stub = supersedeStubs.get(i + ":" + j);
      if (!stub) return block;
      mutated = true;
      return { ...block, content: stub };
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });

  return { messages: out, changed: true, stats: { deduped } };
}

/**
 * Dispatch wrapper: only apply `applySessionToolResultDedupe` when the
 * `token_economy_strategies.tool_result_dedupe_session_wide` flag is true.
 * When disabled, returns the input `messages` by identity (not a copy) so
 * callers can cheaply detect "no-op" with reference equality.
 *
 * @param {Array} messages
 * @param {object} [config]
 * @returns {Array}
 */
function maybeApplySessionToolResultDedupe(messages, config) {
  const flag = config?.token_economy_strategies?.tool_result_dedupe_session_wide;
  if (flag !== true) return messages;
  const result = applySessionToolResultDedupe(messages);
  return result.messages;
}

/**
 * TTL-based thinking strip. When the time since the last strip exceeds the
 * cache TTL (roughly the point at which the prompt prefix cache would expire),
 * remove all `thinking` / `redacted_thinking` blocks from prior assistant
 * messages. Mirrors CC's `logThinkingClearLatched("ttl", ...)`.
 *
 * We keep the MOST RECENT assistant's thinking intact — chain-of-thought
 * continuity for the current turn matters; older ones don't.
 *
 * @param {Array} messages
 * @param {{ lastClearMs: number, ttlMs: number, now?: number }} ctx
 * @returns {{ messages: Array, changed: boolean, cleared: number, ranStripAt: number }}
 */
function applyTtlThinkingStrip(messages, ctx) {
  const now = ctx.now ?? Date.now();
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, cleared: 0, ranStripAt: ctx.lastClearMs };
  }
  if (ctx.lastClearMs > 0 && now - ctx.lastClearMs < ctx.ttlMs) {
    return { messages, changed: false, cleared: 0, ranStripAt: ctx.lastClearMs };
  }

  // Find the last assistant message index — preserve its thinking.
  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }

  let cleared = 0;
  const out = messages.map((msg, i) => {
    if (msg.role !== "assistant" || i === lastAsstIdx || !Array.isArray(msg.content)) {
      return msg;
    }
    const newContent = msg.content.filter((b) => {
      if (b?.type === "thinking" || b?.type === "redacted_thinking") {
        cleared += 1;
        return false;
      }
      return true;
    });
    return newContent.length !== msg.content.length ? { ...msg, content: newContent } : msg;
  });

  return { messages: out, changed: cleared > 0, cleared, ranStripAt: cleared > 0 ? now : ctx.lastClearMs };
}

/**
 * Proactive microcompact — client-side, runs BEFORE the request goes out.
 * At or above `percent` of the model's context window, replace old
 * tool_result.content with a placeholder (keeping last `keepRecent` verbatim).
 *
 * Returns the new messages array + change stats.
 *
 * @param {Array} messages
 * @param {{ estimatedTokens: number, contextWindow: number, percent: number, keepRecent: number }} ctx
 * @returns {{ messages: Array, changed: boolean, cleared: number, triggered: boolean }}
 */
function applyProactiveMicrocompact(messages, ctx) {
  const threshold = ctx.contextWindow * (ctx.percent / 100);
  if (ctx.estimatedTokens < threshold) {
    return { messages, changed: false, cleared: 0, triggered: false };
  }
  const result = applyContextHintCompaction(messages, { keepRecentToolResults: ctx.keepRecent });
  return {
    messages: result.messages,
    changed: result.changed,
    cleared: result.stats.toolResultsCleared,
    triggered: true,
  };
}

/**
 * Stable tool ordering — sort tools by name so the system-prompt prefix stays
 * cache-stable across turns. Safe: tool semantics are name-based, not index-based.
 *
 * @param {any[]} tools
 * @returns {any[]}
 */
function applyStableToolOrdering(tools) {
  if (!Array.isArray(tools) || tools.length < 2) return tools;
  // Preserve a pinned "first" for tools whose position is load-bearing (none today).
  return [...tools].sort((a, b) => {
    const an = typeof a?.name === "string" ? a.name : "";
    const bn = typeof b?.name === "string" ? b.name : "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * Tool schema deferral — replace the `input_schema` of deferred tools with a
 * minimal placeholder until the tool has been invoked in this session.
 *
 * @param {any[]} tools
 * @param {{ deferred: Set<string>, invoked: Set<string> }} ctx
 * @returns {{ tools: any[], deferredCount: number }}
 */
function applyToolSchemaDeferral(tools, ctx) {
  if (!Array.isArray(tools) || ctx.deferred.size === 0) {
    return { tools, deferredCount: 0 };
  }
  let deferredCount = 0;
  const out = tools.map((t) => {
    const name = typeof t?.name === "string" ? t.name : "";
    if (!ctx.deferred.has(name) || ctx.invoked.has(name)) return t;
    deferredCount += 1;
    // Minimal schema — `type:object` with no properties is accepted by the API.
    return {
      ...t,
      input_schema: { type: "object", properties: {}, additionalProperties: true },
    };
  });
  return { tools: out, deferredCount };
}

/**
 * Adaptive thinking — zero the thinking budget for trivially simple follow-ups.
 * "Simple" heuristic: most recent user message is short (<200 chars), no file
 * references, and the conversation is past turn 1 (so we have context).
 *
 * @param {any} parsed Parsed request body (mutated in place if simple)
 * @returns {{ applied: boolean, previousBudget: number | null }}
 */
function applyAdaptiveThinkingZero(parsed) {
  if (!parsed || !parsed.thinking || parsed.thinking.type !== "enabled") {
    return { applied: false, previousBudget: null };
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length < 2) return { applied: false, previousBudget: null };
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { applied: false, previousBudget: null };

  let userText = "";
  if (typeof last.content === "string") userText = last.content;
  else if (Array.isArray(last.content)) {
    for (const b of last.content) {
      if (b?.type === "text" && typeof b.text === "string") userText += b.text;
      if (b?.type === "tool_result") return { applied: false, previousBudget: null };
    }
  }
  if (userText.length > 200) return { applied: false, previousBudget: null };
  if (/\b(analyze|refactor|design|review|audit|plan)\b/i.test(userText)) {
    return { applied: false, previousBudget: null };
  }

  const previousBudget = typeof parsed.thinking.budget_tokens === "number" ? parsed.thinking.budget_tokens : null;
  // "Zero" means remove thinking entirely — API disallows budget_tokens:0.
  delete parsed.thinking;
  if (typeof parsed.temperature !== "number") parsed.temperature = 1;
  return { applied: true, previousBudget };
}

/**
 * Cross-turn tool_result dedupe — when the same (tool name, input) pair
 * appeared earlier in the conversation, replace the later result content
 * with a pointer string. Safe-set only: Read, Grep, Glob, LS.
 *
 * @param {Array} messages
 * @param {{ seen: Map<string, string>, safeTools: Set<string> }} ctx
 * @returns {{ messages: Array, changed: boolean, deduped: number }}
 */
function applyToolResultDedupe(messages, ctx) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, deduped: 0 };
  }
  // First pass: build map of tool_use_id → { name, inputHash } from assistant messages.
  const idToKey = new Map();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type !== "tool_use") continue;
      if (!ctx.safeTools.has(b.name)) continue;
      const inputStr = JSON.stringify(b.input ?? {});
      idToKey.set(b.id, `${b.name}::${inputStr}`);
    }
  }

  let deduped = 0;
  const out = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((b) => {
      if (b?.type !== "tool_result") return b;
      const key = idToKey.get(b.tool_use_id);
      if (!key) return b;
      const firstSeen = ctx.seen.get(key);
      if (firstSeen && firstSeen !== b.tool_use_id) {
        deduped += 1;
        mutated = true;
        return { ...b, content: `[Identical to tool_use_id=${firstSeen}]` };
      }
      if (!firstSeen) ctx.seen.set(key, b.tool_use_id);
      return b;
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });

  return { messages: out, changed: deduped > 0, deduped };
}

/**
 * Trailing-summary trimmer — strip the final text block of past assistant
 * messages if it looks like a summary (ends with "...done" / "summary" /
 * numbered list / "I've X'd Y"). Only applies to messages past the last one.
 *
 * @param {Array} messages
 * @returns {{ messages: Array, changed: boolean, trimmed: number }}
 */
function applyTrailingSummaryTrim(messages) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { messages, changed: false, trimmed: 0 };
  }
  const SUMMARY_PATTERNS = [
    /\b(summary|summar(y|ised|ized)):/i,
    /\bto summari[sz]e\b/i,
    /^\s*in (summary|short|brief)/im,
    /\bi['']ve (done|completed|implemented|added|updated|fixed) /i,
    /\bthat's it\b/i,
  ];

  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAsstIdx = i;
      break;
    }
  }

  let trimmed = 0;
  const out = messages.map((msg, i) => {
    if (msg.role !== "assistant" || i === lastAsstIdx) return msg;
    if (!Array.isArray(msg.content)) return msg;

    const last = msg.content[msg.content.length - 1];
    if (!last || last.type !== "text" || typeof last.text !== "string") return msg;
    const text = last.text;
    if (text.length < 80) return msg;
    const isSummary = SUMMARY_PATTERNS.some((p) => p.test(text));
    if (!isSummary) return msg;

    trimmed += 1;
    const newContent = msg.content.slice(0, -1);
    if (newContent.length === 0) return msg; // keep at least one block
    return { ...msg, content: newContent };
  });

  return { messages: out, changed: trimmed > 0, trimmed };
}

export {
  applyAdaptiveThinkingZero,
  applyContextHintCompaction,
  applyProactiveMicrocompact,
  applySessionToolResultDedupe,
  applyStableToolOrdering,
  applyToolResultDedupe,
  applyToolSchemaDeferral,
  applyTrailingSummaryTrim,
  applyTtlThinkingStrip,
  estimatePromptTokensFromParsed,
  injectTokenBudgetBlock,
  maybeApplySessionToolResultDedupe,
  parseNaturalLanguageBudget,
};
