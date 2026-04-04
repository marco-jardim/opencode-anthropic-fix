/**
 * Cloudflare Worker entry point for the upstream sync watcher.
 *
 * Scheduled trigger (every 15 min): polls npm registry for new Claude Code
 * versions, extracts mimese-critical constants, diffs against baseline, and
 * either auto-creates a PR (LLM: safe, confidence ≥ 0.85) or an issue.
 *
 * Fetch handler: health check only.
 *
 * @module index
 */

import { fetchRegistryMetadata } from "./registry.mjs";
import { downloadAndExtractCli, buildTarballUrl } from "./tarball.mjs";
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
   * HTTP fetch handler — health check and manual trigger.
   *
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Response}
   */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", ts: Date.now() }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/run") {
      const runId = crypto.randomUUID().slice(0, 8);
      const log = makeLogger(env, runId);
      const logs = [];
      const capturingLog = (severity, message, data = {}) => {
        log(severity, message, data);
        logs.push({ severity, message, ...data, ts: new Date().toISOString() });
      };
      const locked = await acquireLock(env.UPSTREAM_KV, CRON_LOCK_NAME);
      if (!locked) {
        return new Response(JSON.stringify({ status: "locked", runId }), {
          headers: { "content-type": "application/json" },
        });
      }
      try {
        await runPipeline(env, capturingLog);
      } catch (err) {
        capturingLog("error", "unhandled pipeline error", { error: err.message, stack: err.stack });
      } finally {
        await releaseLock(env.UPSTREAM_KV, CRON_LOCK_NAME);
      }
      return new Response(JSON.stringify({ status: "done", runId, logs }, null, 2), {
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
    log("info", "no baseline found, seeding from v2.1.92");
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

  // ── Download & extract NEW tarball ─────────────────────────────────────────
  log("info", "stage:tarball:url", { version: upstreamVersion, tarballUrl: registryMeta.tarballUrl });
  let cliText;
  try {
    const { result, duration_ms } = await timed(() => downloadAndExtractCli(registryMeta.tarballUrl));
    cliText = result;
    log("info", "stage:tarball:new", { version: upstreamVersion, duration_ms });
  } catch (err) {
    log("error", "tarball extraction failed", { version: upstreamVersion, error: err.message, stack: err.stack });
    await transition(kv, upstreamVersion, STATES.FAILED_RETRYABLE, { error: err.message });
    return;
  }

  const extracted = extractContract(cliText);

  // ── Version mismatch guard ────────────────────────────────────────────────
  // If the version embedded in the bundle doesn't match what the registry reported,
  // the tarball is stale or malformed. Skip delivery to avoid creating phantom issues.
  if (extracted.version && extracted.version !== upstreamVersion) {
    log("error", "version mismatch: extracted version does not match registry version", {
      registryVersion: upstreamVersion,
      extractedVersion: extracted.version,
      tarballUrl: registryMeta.tarballUrl,
    });
    await transition(kv, upstreamVersion, STATES.FAILED_RETRYABLE, {
      error: `version mismatch: registry=${upstreamVersion} extracted=${extracted.version}`,
    });
    return;
  }
  const extractedHash = await computeHash(extracted);

  // ── Download & extract OLD tarball (A/B comparison) ───────────────────────
  // To avoid false positives from extractor bugs, we re-extract the baseline
  // version's contract from its tarball using the same extractor logic.
  // This way, any extractor quirks cancel out — both contracts pass through
  // the same extraction pipeline.
  const baselineVersion = baselineData.contract.version;
  let baselineContract = baselineData.contract; // fallback to KV baseline
  if (baselineVersion && baselineVersion !== upstreamVersion) {
    const oldTarballUrl = buildTarballUrl(packageName, baselineVersion);
    try {
      const { result: oldCliText, duration_ms } = await timed(() => downloadAndExtractCli(oldTarballUrl));
      const freshBaseline = extractContract(oldCliText);
      // Verify the re-extracted baseline version matches
      if (freshBaseline.version === baselineVersion) {
        baselineContract = freshBaseline;
        log("info", "stage:tarball:old", { version: baselineVersion, duration_ms, source: "re-extracted" });
      } else {
        log("warn", "old tarball version mismatch, using KV baseline", {
          expected: baselineVersion,
          got: freshBaseline.version,
        });
      }
    } catch (err) {
      // Old tarball may be unavailable (unpublished, CDN purged, etc.)
      // Fall back to KV baseline — this is the pre-existing behavior.
      log("warn", "old tarball download failed, using KV baseline", {
        version: baselineVersion,
        error: err.message,
      });
    }
  }

  // ── Diff against baseline ─────────────────────────────────────────────────
  const diff = diffContracts(baselineContract, extracted);
  if (!diff.changed) {
    log("info", "contract unchanged", { version: upstreamVersion, duration_ms: Date.now() - pipelineStart });
    // Only write baseline when the upstream version advanced (avoids a no-op KV write
    // on every cron cycle for the same version with the same contract content).
    if (extracted.version && extracted.version !== baselineData.contract.version) {
      await setBaseline(kv, extracted, extractedHash);
    }
    return;
  }

  const baselineSource = baselineContract === baselineData.contract ? "kv" : "re-extracted";
  log("info", "contract diff detected", {
    version: upstreamVersion,
    severity: diff.severity,
    fields: Object.keys(diff.fields),
    baseline_source: baselineSource,
    baseline_version: baselineContract.version,
  });

  // ── Transition to DETECTED (idempotent if already there from retry) ────────
  await transition(kv, upstreamVersion, STATES.DETECTED);

  // ── Analyze ───────────────────────────────────────────────────────────────
  let analysis;
  try {
    const { result, duration_ms } = await timed(() =>
      analyzeContractDiff(env, baselineContract, extracted, diff, { baselineSource }),
    );
    analysis = result;

    // Estimate LLM cost when the LLM was invoked
    // Workers AI doesn't return token counts; approximate from prompt character length
    // (~4 chars per token is a rough heuristic)
    if (analysis.llmInvoked) {
      const approxInputTokens = Math.ceil(
        (buildSystemPrompt().length + buildUserPrompt(baselineContract, extracted, diff, { baselineSource }).length) /
          4,
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
    const { result, duration_ms } = await timed(() => deliver(env, baselineContract, extracted, analysis));
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
