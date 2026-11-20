import { isTruthyEnv } from "../env.mjs";

/**
 * Every environment variable the cache-TTL resolution reads. Callers that
 * snapshot an env subset (the adapter) must carry all of them, or the TTL the
 * identity block resolves would disagree with the one the body resolves.
 */
export const CACHE_TTL_ENV_KEYS = Object.freeze([
  "FORCE_PROMPT_CACHING_5M",
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
  "ENABLE_PROMPT_CACHING_1H",
  "CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL",
]);

const TTL_MS = Object.freeze({ "5m": 5 * 60 * 1000, "1h": 60 * 60 * 1000 });

/**
 * Accept only the two TTLs the API knows. Anything else is ignored, never
 * coerced: a typo in an env var must not turn into a rejected request.
 *
 * @param {unknown} value
 * @returns {"5m" | "1h" | null}
 */
function parseExplicitTtl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "5m" || trimmed === "1h" ? trimmed : null;
}

/**
 * Resolve the prompt-cache TTL for the current request role and overrides.
 *
 * Precedence mirrors the genuine client's TTL selection (the `YGn`
 * precedence in the current upstream release):
 *
 *  1. `FORCE_PROMPT_CACHING_5M` (truthy)               -> 5m
 *  2. the thread's explicit TTL env var, 5m/1h only    -> that value
 *     - main thread (`isMainForCache && !isSubagent`): `CLAUDE_CODE_PROMPT_CACHE_TTL`
 *     - every other request:                           `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`
 *  3. `ENABLE_PROMPT_CACHING_1H` (truthy)              -> 1h
 *  4. role-scoped downgrade (subagent / side query)    -> 5m
 *  5. the configured TTL
 *
 * The genuine client has two more slots between 2 and 3 (settings
 * `promptCacheTtl` / `subagentPromptCacheTtl`, agent frontmatter). The plugin
 * has no equivalent source for them, so they do not exist here.
 *
 * @param {{configuredTtl: string, roleScopedTtl: boolean, isMainForCache: boolean, isSubagent?: boolean, env?: NodeJS.ProcessEnv}} options
 * @returns {string}
 */
export function resolveCacheTtl({
  configuredTtl,
  roleScopedTtl,
  isMainForCache,
  isSubagent = false,
  env = process.env,
}) {
  if (isTruthyEnv(env.FORCE_PROMPT_CACHING_5M)) return "5m";
  const isMainThread = isMainForCache && !isSubagent;
  const explicit = parseExplicitTtl(
    isMainThread ? env.CLAUDE_CODE_PROMPT_CACHE_TTL : env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL,
  );
  if (explicit !== null) return explicit;
  if (isTruthyEnv(env.ENABLE_PROMPT_CACHING_1H)) return "1h";
  if (roleScopedTtl && isSubagent) return "5m";
  if (roleScopedTtl && !isMainForCache) return "5m";
  return configuredTtl;
}

/**
 * TTL for the MESSAGES breakpoint. The system and tools breakpoints keep the
 * TTL from `resolveCacheTtl`; only the message marker can drop to 5m, and only
 * on the exact value `5m` in `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL` (genuine:
 * `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL==="5m"?"5m":e`).
 *
 * Ordering is safe by construction: the API rejects a 1h marker AFTER a 5m one,
 * and this can only ever lower the LAST marker. When the system TTL is already
 * 5m the result is 5m either way.
 *
 * @param {string} systemTtl - The TTL the system and tools breakpoints carry.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveMessagesCacheTtl(systemTtl, env = process.env) {
  return env.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL === "5m" ? "5m" : systemTtl;
}

/**
 * Milliseconds a prompt-cache entry written with this TTL lives.
 *
 * @param {unknown} ttl
 * @returns {number | null} null for anything but "5m" / "1h".
 */
export function ttlToMs(ttl) {
  return typeof ttl === "string" && Object.hasOwn(TTL_MS, ttl) ? TTL_MS[/** @type {"5m" | "1h"} */ (ttl)] : null;
}

/**
 * Has the prompt cache for a conversation gone cold? True only when the last
 * request is known to be older than the TTL, or when there never was one (no
 * cache exists, so nothing a rewrite could invalidate). An unknown TTL is never
 * reported cold: rewriting history is the risky direction.
 *
 * @param {{ lastRequestMs?: number | null, now: number, ttl: unknown }} options
 * @returns {boolean}
 */
export function isCacheCold({ lastRequestMs, now, ttl }) {
  const ttlMs = ttlToMs(ttl);
  if (ttlMs === null) return false;
  if (typeof lastRequestMs !== "number" || !Number.isFinite(lastRequestMs) || lastRequestMs <= 0) return true;
  return now - lastRequestMs > ttlMs;
}

/**
 * Decide whether the tools cache breakpoint should be placed for this turn.
 *
 * @param {Map<string, number> | null | undefined} stability
 * @returns {boolean}
 */
export function shouldPlaceToolBreakpoint(stability) {
  if (!stability || stability.size === 0) return true;
  const STABLE_TURNS = 2;
  const systemStability = stability.get("system_prompt");
  const systemIsStable = typeof systemStability === "number" && systemStability >= STABLE_TURNS;
  if (!systemIsStable) return true;
  for (const [source, turns] of stability) {
    if (source.startsWith("tool:") && turns === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Update consecutive-unchanged counters on the supplied stability map.
 *
 * @param {Map<string, string>} current
 * @param {Map<string, string>} previous
 * @param {Map<string, number>} stability
 * @returns {void}
 */
export function updateBoundaryStability(current, previous, stability) {
  for (const [source, hash] of current) {
    if (previous.get(source) === hash) {
      stability.set(source, (stability.get(source) || 0) + 1);
    } else {
      stability.set(source, 0);
    }
  }
  for (const source of [...stability.keys()]) {
    if (!current.has(source)) stability.delete(source);
  }
}
