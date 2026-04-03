/**
 * Cloudflare Worker entry point for the upstream sync watcher.
 *
 * Scheduled trigger (every 15 min): polls npm registry for new Claude Code
 * versions, extracts mimese-critical constants, diffs against baseline, and
 * either auto-creates a PR (trivial changes) or an issue (non-trivial changes).
 *
 * Fetch handler: health check only.
 *
 * @module index
 */

import { fetchRegistryMetadata } from "./registry.mjs";
import { downloadAndExtractCli } from "./tarball.mjs";
import { extractContract } from "./extractor.mjs";
import { diffContracts } from "./differ.mjs";
import { getBaseline, setBaseline, getEtag, setEtag } from "./baseline.mjs";
import { getState, transition, nextRetryState, isTerminal } from "./state.mjs";
import { acquireLock, releaseLock } from "./lock.mjs";
import { analyzeContractDiff } from "./analyzer.mjs";
import { deliver } from "./delivery.mjs";
import { STATES } from "./types.mjs";
import { SEED_CONTRACT } from "./seed.mjs";
import { hashContract as computeHash } from "./hasher.mjs";
import { storeDeadLetterAlert, estimateCost } from "./observability.mjs";
import { buildSystemPrompt, buildUserPrompt } from "./prompts.mjs";

const CRON_LOCK_NAME = "cron";

/**
 * Wrap an async operation and return { result, duration_ms }.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ result: T, duration_ms: number }>}
 */
async function timed(fn) {
  const t0 = Date.now();
  const result = await fn();
  return { result, duration_ms: Date.now() - t0 };
}

export default {
  /**
   * Cron trigger handler — runs every 15 minutes.
   *
   * @param {ScheduledEvent} event
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, _ctx) {
    const runId = crypto.randomUUID().slice(0, 8);
    const log = makeLogger(env, runId);
    log("info", "cron triggered", { ts: new Date(event.scheduledTime).toISOString() });

    // Acquire distributed lock to prevent concurrent runs
    const locked = await acquireLock(env.UPSTREAM_KV, CRON_LOCK_NAME);
    if (!locked) {
      log("info", "lock held by another invocation, skipping");
      return;
    }

    try {
      await runPipeline(env, log);
    } catch (err) {
      log("error", "unhandled pipeline error", { error: err.message, stack: err.stack });
    } finally {
      await releaseLock(env.UPSTREAM_KV, CRON_LOCK_NAME);
    }
  },

  /**
   * HTTP fetch handler — health check only.
   *
   * @param {Request} request
   * @param {Env} env
   * @returns {Response}
   */
  async fetch(request, _env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", ts: Date.now() }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Main pipeline: poll → extract → diff → analyze → deliver → update state.
 *
 * @param {Env} env
 * @param {function} log
 */
async function runPipeline(env, log) {
  const kv = env.UPSTREAM_KV;
  const packageName = env.NPM_PACKAGE ?? "@anthropic-ai/claude-code";
  const pipelineStart = Date.now();

  // ── Ensure baseline exists (seed on first run) ────────────────────────────
  let baselineData = await getBaseline(kv);
  if (!baselineData) {
    log("info", "no baseline found, seeding from v2.1.91");
    const seedHash = await computeHash(SEED_CONTRACT);
    await setBaseline(kv, SEED_CONTRACT, seedHash);
    baselineData = { contract: SEED_CONTRACT, hash: seedHash };
  }

  // ── Poll registry ─────────────────────────────────────────────────────────
  const cachedEtag = await getEtag(kv);
  let registryMeta;
  try {
    const { result, duration_ms } = await timed(() => fetchRegistryMetadata(packageName, cachedEtag));
    registryMeta = result;
    log("info", "stage:registry", { duration_ms });
  } catch (err) {
    log("error", "registry poll failed", {
      error: err.message,
      stack: err.stack,
      duration_ms: Date.now() - pipelineStart,
    });
    return;
  }

  if (registryMeta.notModified) {
    log("info", "registry not modified (ETag match), nothing to do", { duration_ms: Date.now() - pipelineStart });
    return;
  }

  if (registryMeta.etag) {
    await setEtag(kv, registryMeta.etag);
  }

  const upstreamVersion = registryMeta.version;
  log("info", "registry returned version", { version: upstreamVersion });

  // ── Check if already processed ────────────────────────────────────────────
  const existingState = await getState(kv, upstreamVersion);
  if (existingState && isTerminal(existingState.state)) {
    log("info", "version already in terminal state", {
      version: upstreamVersion,
      state: existingState.state,
    });
    return;
  }

  // ── DEAD_LETTER gate: check retry limit before re-entering pipeline ────────
  if (existingState?.state === STATES.FAILED_RETRYABLE) {
    const next = nextRetryState(existingState);
    if (next === STATES.DEAD_LETTER) {
      await transition(kv, upstreamVersion, STATES.DEAD_LETTER, { error: existingState.error });
      await storeDeadLetterAlert(kv, upstreamVersion, existingState);
      log("error", "max retries exceeded, version dead-lettered", {
        version: upstreamVersion,
        retries: existingState.retries,
      });
      return;
    }
    // Retry is allowed — reset back to DETECTED so the pipeline can run
    await transition(kv, upstreamVersion, STATES.DETECTED);
  }

  // ── Crash recovery: stuck intermediate states → FAILED_RETRYABLE ──────────
  if (existingState) {
    const s = existingState.state;
    if (s === STATES.ANALYZING || s === STATES.PR_CREATED || s === STATES.ISSUE_CREATED) {
      log("warn", "recovering stuck intermediate state", { version: upstreamVersion, state: s });
      await transition(kv, upstreamVersion, STATES.FAILED_RETRYABLE, {
        error: `stuck-state recovery from ${s}`,
      });
      return; // Will retry on next cron cycle
    }
  }

  // ── Download & extract ────────────────────────────────────────────────────
  let cliText;
  try {
    const { result, duration_ms } = await timed(() => downloadAndExtractCli(registryMeta.tarballUrl));
    cliText = result;
    log("info", "stage:tarball", { version: upstreamVersion, duration_ms });
  } catch (err) {
    log("error", "tarball extraction failed", { version: upstreamVersion, error: err.message, stack: err.stack });
    await transition(kv, upstreamVersion, STATES.FAILED_RETRYABLE, { error: err.message });
    return;
  }

  const extracted = extractContract(cliText);
  const extractedHash = await computeHash(extracted);

  // ── Diff against baseline ─────────────────────────────────────────────────
  const diff = diffContracts(baselineData.contract, extracted);
  if (!diff.changed) {
    log("info", "contract unchanged", { version: upstreamVersion, duration_ms: Date.now() - pipelineStart });
    // Only write baseline when the upstream version advanced (avoids a no-op KV write
    // on every cron cycle for the same version with the same contract content).
    if (extracted.version && extracted.version !== baselineData.contract.version) {
      await setBaseline(kv, extracted, extractedHash);
    }
    return;
  }

  log("info", "contract diff detected", {
    version: upstreamVersion,
    severity: diff.severity,
    fields: Object.keys(diff.fields),
  });

  // ── Transition to DETECTED (idempotent if already there from retry) ────────
  await transition(kv, upstreamVersion, STATES.DETECTED);

  // ── Analyze ───────────────────────────────────────────────────────────────
  let analysis;
  try {
    const { result, duration_ms } = await timed(() => analyzeContractDiff(env, baselineData.contract, extracted, diff));
    analysis = result;

    // Estimate LLM cost when the LLM was invoked
    // Workers AI doesn't return token counts; approximate from prompt character length
    // (~4 chars per token is a rough heuristic)
    if (analysis.llmInvoked) {
      const approxInputTokens = Math.ceil(
        (buildSystemPrompt().length + buildUserPrompt(baselineData.contract, extracted, diff).length) / 4,
      );
      const approxOutputTokens = 500; // typical structured response
      const cost_usd = estimateCost({ input: approxInputTokens, output: approxOutputTokens });
      log("info", "stage:analyze", {
        version: upstreamVersion,
        duration_ms,
        llm_invoked: true,
        approx_input_tokens: approxInputTokens,
        approx_output_tokens: approxOutputTokens,
        cost_usd: cost_usd.toFixed(5),
      });
    } else {
      log("info", "stage:analyze", { version: upstreamVersion, duration_ms, llm_invoked: false, cost_usd: "0.00000" });
    }
  } catch (err) {
    log("error", "analysis failed", { version: upstreamVersion, error: err.message, stack: err.stack });
    await transition(kv, upstreamVersion, STATES.FAILED_RETRYABLE, { error: err.message });
    return;
  }

  // Transition to ANALYZING whenever the LLM was invoked (regardless of final action)
  if (analysis.llmInvoked) {
    await transition(kv, upstreamVersion, STATES.ANALYZING);
  }

  // ── Deliver ───────────────────────────────────────────────────────────────
  let deliveryResult;
  try {
    const { result, duration_ms } = await timed(() => deliver(env, baselineData.contract, extracted, analysis));
    deliveryResult = result;
    log("info", "stage:deliver", { version: upstreamVersion, duration_ms, action: analysis.action });
  } catch (err) {
    log("error", "delivery failed", { version: upstreamVersion, error: err.message, stack: err.stack });
    await transition(kv, upstreamVersion, STATES.FAILED_RETRYABLE, { error: err.message });
    return;
  }

  // ── Update state ──────────────────────────────────────────────────────────
  if (deliveryResult.type === "pr") {
    await transition(kv, upstreamVersion, STATES.PR_CREATED, {
      prNumber: deliveryResult.number,
      branchName: `auto/sync-${upstreamVersion}`,
    });
  } else {
    await transition(kv, upstreamVersion, STATES.ISSUE_CREATED, {
      issueNumber: deliveryResult.number,
    });
  }

  // ── Update baseline BEFORE marking DELIVERED ─────────────────────────────
  // Order matters: if the Worker is evicted between baseline write and DELIVERED
  // transition, crash recovery sees PR_CREATED/ISSUE_CREATED, retries the pipeline,
  // delivery is idempotent (finds existing PR/issue), and DELIVERED is reached with
  // the baseline already correct. Reversing the order would leave a permanently
  // stale baseline with no recovery path.
  await setBaseline(kv, extracted, extractedHash);
  await transition(kv, upstreamVersion, STATES.DELIVERED);

  log("info", "pipeline complete", {
    version: upstreamVersion,
    action: deliveryResult.type,
    number: deliveryResult.number,
    url: deliveryResult.url,
    total_duration_ms: Date.now() - pipelineStart,
  });
}

/** Numeric severity ordering — lower = more severe */
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Create a structured logger with level filtering and run correlation.
 *
 * @param {Env} env
 * @param {string} [runId] - Short UUID prefix for correlating logs within one cron run
 * @returns {function(string, string, object=): void}
 */
function makeLogger(env, runId) {
  const configuredLevel = LOG_LEVELS[env.LOG_LEVEL ?? "info"] ?? LOG_LEVELS.info;
  return (severity, message, data = {}) => {
    if ((LOG_LEVELS[severity] ?? LOG_LEVELS.info) > configuredLevel) return;
    console.log(JSON.stringify({ severity, message, runId, ...data, ts: new Date().toISOString() }));
  };
}
