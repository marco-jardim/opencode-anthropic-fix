import { isTruthyEnv } from "../env.mjs";

/**
 * Resolve the prompt-cache TTL for the current request role and overrides.
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
  if (isTruthyEnv(env.ENABLE_PROMPT_CACHING_1H)) return "1h";
  if (roleScopedTtl && isSubagent) return "5m";
  if (roleScopedTtl && !isMainForCache) return "5m";
  return configuredTtl;
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
