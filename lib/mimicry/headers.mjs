import { isTruthyEnv, isFalsyEnv } from "../env.mjs";
import { hasOneMillionContext, isClaude3Model } from "./wire-compat.mjs";
import { EXPERIMENTAL_BETA_FLAGS, BETA_SHORTCUTS } from "../betas.mjs";
import { randomUUID } from "node:crypto";

/**
 * Build the extended User-Agent for API calls.
 * Real CC v96 sends "claude-cli/{version} (external, {entrypoint})" - confirmed via
 * proxy capture of real CC on Windows/Node.js.
 *
 * SCOPE: the legacy forge below is its only production caller, i.e. the
 * endpoints the shared wire package has no surface for. `buildAdapterUserAgent`
 * (lib/mimicry/adapter-input.mjs) is the pure mirror the adapter path uses, and
 * `adapter-input.test.mjs` pins the two to agree. Phase 3.3 of the wire-compat
 * migration may replace this with the package's own user-agent template.
 *
 * @param {string} version
 * @returns {string}
 */
export function buildExtendedUserAgent(version) {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli";
  const sdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : "";
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : "";
  return `claude-cli/${version} (external, ${entrypoint}${sdkVersion}${clientApp})`;
}

export const CLAUDE_CODE_BETA_FLAG = "claude-code-20250219";
export const _EFFORT_BETA_FLAG = "effort-2025-11-24";
export const FAST_MODE_BETA_FLAG = "fast-mode-2026-02-01";
export const TOKEN_COUNTING_BETA_FLAG = "token-counting-2024-11-01";
export const HOST_SDK_BETAS_BLOCKLIST = new Set([
  "fine-grained-tool-streaming-2025-05-14",
  "structured-outputs-2025-11-13",
]);
export const STAINLESS_HELPER_KEYS = [
  "x_stainless_helper",
  "x-stainless-helper",
  "stainless_helper",
  "stainlessHelper",
  "_stainless_helper",
];
export const _EFFORT_EXCLUDED_MODELS = [
  /claude-opus-4-0/i,
  /claude-opus-4-1/i,
  /claude-sonnet-4-0/i,
  /claude-sonnet-4-5/i,
  /claude-haiku-4-5/i,
];

export function isNonInteractiveMode() {
  if (isTruthyEnv(process.env.CI)) return true;
  return !process.stdout.isTTY;
}

export function parseAnthropicCustomHeaders() {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return {};

  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return headers;
}

export function isHaikuModel(model) {
  return /haiku/i.test(model);
}

export function supportsStructuredOutputs(model) {
  if (!/claude|sonnet|opus|haiku/i.test(model)) return false;
  return !isHaikuModel(model);
}

export function supportsWebSearch(model) {
  return /claude|sonnet|opus|haiku|gpt|gemini/i.test(model);
}

export function parseRequestBodyMetadata(body, parsedBody) {
  const parsed =
    parsedBody ||
    (typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return null;
          }
        })()
      : null);
  if (!parsed) {
    return { model: "", tools: [], messages: [], hasFileReferences: false };
  }

  const model = typeof parsed?.model === "string" ? parsed.model : "";
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const hasFileReferences = extractFileIds(parsed).length > 0;
  return { model, tools, messages, hasFileReferences };
}

/**
 * Walk every object that may carry a stainless helper marker: a tool object, a
 * message object, and each block nested under `.content`. Shared by the header
 * builder and the body stripper on purpose — what is READ to build
 * `x-stainless-helper` and what is REMOVED from the body must be the exact same
 * traversal, or the two would drift and a marker would leak to the wire.
 *
 * @param {unknown[]} tools
 * @param {unknown[]} messages
 * @param {(carrier: Record<string, unknown>) => void} visit
 */
function walkStainlessHelperCarriers(tools, messages, visit) {
  const walk = (value) => {
    if (!value || typeof value !== "object") return;

    visit(value);

    if (Array.isArray(value.content)) {
      for (const contentBlock of value.content) {
        walk(contentBlock);
      }
    }
  };

  if (Array.isArray(tools)) for (const tool of tools) walk(tool);
  if (Array.isArray(messages)) for (const message of messages) walk(message);
}

export function buildStainlessHelperHeader(tools, messages) {
  const helpers = new Set();

  walkStainlessHelperCarriers(tools, messages, (value) => {
    for (const key of STAINLESS_HELPER_KEYS) {
      if (typeof value[key] === "string" && value[key]) {
        helpers.add(value[key]);
      }
    }
  });

  return Array.from(helpers).join(", ");
}

/**
 * Remove the stainless helper markers from the request body, in place.
 *
 * The marker is an INTERNAL signal whose only purpose is to compute the
 * `x-stainless-helper` header. It is not part of the Anthropic wire contract:
 * the API has never known these keys, and the shared wire-compat package
 * rejects the whole request with `INVALID_INPUT` when one reaches it. Call this
 * AFTER `buildStainlessHelperHeader` so the header is still derived from the
 * untouched body, and before the body is handed to the package or to `fetch`.
 *
 * @param {unknown[]} tools
 * @param {unknown[]} messages
 * @returns {number} how many marker keys were removed
 */
export function stripStainlessHelperMarkers(tools, messages) {
  let removed = 0;

  walkStainlessHelperCarriers(tools, messages, (value) => {
    for (const key of STAINLESS_HELPER_KEYS) {
      if (key in value) {
        delete value[key];
        removed += 1;
      }
    }
  });

  return removed;
}

export function isEffortCapableModel(model) {
  if (!model) return false;
  if (isClaude3Model(model)) return false;
  return !_EFFORT_EXCLUDED_MODELS.some((re) => re.test(model));
}

export function buildAnthropicBetaHeader(
  incomingBeta,
  signatureEnabled,
  model,
  customBetas,
  strategy,
  requestPath,
  hasFileReferences,
  adaptiveOverride,
  tokenEconomy,
  microcompactBetas, // NEW 11th param
  fastModeActive, // NEW 12th param — see @param above
) {
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const betas = ["oauth-2025-04-20"];
  const disableExperimentalBetas = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const isMessagesCountTokensPath = requestPath === "/v1/messages/count_tokens";
  const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;

  if (!signatureEnabled) {
    betas.push("interleaved-thinking-2025-05-14");
    if (isMessagesCountTokensPath) {
      betas.push(TOKEN_COUNTING_BETA_FLAG);
    }
    let mergedBetas = [...new Set([...betas, ...incomingBetasList])];
    if (disableExperimentalBetas) {
      mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
    }
    return mergedBetas.join(",");
  }

  const isRoundRobin = strategy === "round-robin";
  const te = tokenEconomy || {};

  // === ALWAYS-ON BETAS (Claude Code v2.1.90 base set) ===
  // These are ALWAYS included regardless of env vars or feature flags.
  // NOTE: Real Claude Code skips this beta for Haiku, but we include it
  // so that Haiku subagents (via model-router delegation) get full mimic
  // behavior from the Anthropic API.
  betas.push(CLAUDE_CODE_BETA_FLAG); // "claude-code-20250219"

  // v2.1.150: advanced-tool-use / tool-search-tool removed from always-on.
  // CC 2.1.150 D5q does not push these per-request. Available via custom betas.

  // v2.1.150: fast-mode-2026-02-01 removed from always-on (CC sends only when speed feature active).

  // v2.1.195: effort-2025-11-24 is no longer always-on; it is now a model-gated
  // default emitted in the conditional section below for effort-capable models
  // (mirrors CC's Kw(model)).

  // Interleaved thinking — real CC's i01 pushes via hv4(model), which is
  // (firstParty && non-Claude-3). Claude 3.x models don't support interleaved
  // thinking and real CC never sends this flag for them, so emitting it
  // diverges the fingerprint for legacy Haiku/Sonnet 3.x requests.
  if (!isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING) && !isClaude3Model(model)) {
    betas.push("interleaved-thinking-2025-05-14");
  }

  // Context 1M — when adaptive override is provided, use it; otherwise fall back to static check.
  {
    const use1M =
      adaptiveOverride && typeof adaptiveOverride.use1MContext === "boolean"
        ? adaptiveOverride.use1MContext
        : hasOneMillionContext(model);
    if (use1M) {
      betas.push("context-1m-2025-08-07");
    }
  }

  // Prompt caching scope — always-on EXCEPT in round-robin (per-workspace state conflicts)
  if (!isRoundRobin) {
    betas.push("prompt-caching-scope-2026-01-05");
  }
  // v2.1.150: extended-cache-ttl for better cache hit rates (opt-out via token_economy.extended_cache_ttl = false).
  if (te.extended_cache_ttl !== false && !isRoundRobin) {
    betas.push("extended-cache-ttl-2025-04-11");
  }

  // === CONDITIONAL BETAS (model/context-dependent) ===

  // The plugin is first-party OAuth only; Bedrock/Vertex/Foundry/Mantle support
  // was removed, so the former isFirstPartyProvider predicate is always true and
  // the gates below no longer test it.

  // v2.1.195: context-management-2025-06-27 is default-ON for first-party non-claude-3
  // models (incl. Haiku 4.5), mirroring CC's n0d(model) eligibility path. Earlier
  // analyses read only the separate USE_API_CONTEXT_MANAGEMENT env term (hardcoded
  // && false) and recorded it as off; 2.1.195 confirms it ships by default for modern
  // first-party models. Opt out via token_economy.context_management = false.
  if (te.context_management !== false && !isClaude3Model(model)) {
    betas.push("context-management-2025-06-27");
  }

  // v2.1.195: effort-2025-11-24 is a model-gated default for effort-capable models
  // (Opus 4.5/4.6/4.7/4.8, Sonnet 4.6), mirroring CC's Kw(model). Excluded for
  // claude-3-*, opus-4-0, opus-4-1, sonnet-4-0, sonnet-4-5, haiku-4-5. First-party
  // only; opt out via token_economy.effort = false.
  if (te.effort !== false && isEffortCapableModel(model)) {
    betas.push(_EFFORT_BETA_FLAG);
  }

  // structured-outputs is gated by the caller supplying an output format.
  // `tengu_tool_pear` instead gates `tool.strict = true` on the tool-schema path.
  if (te.structured_outputs && supportsStructuredOutputs(model)) {
    betas.push("structured-outputs-2025-12-15");
  }

  // Web search — for models that support it
  if (supportsWebSearch(model)) {
    betas.push("web-search-2025-03-05");
  }

  // Advisor tool — in CC this is gated by server-side feature flag
  // (tengu_sage_compass2) and firstParty+isLoggedIn. Since we can't check
  // CC's feature flags, include it unconditionally for Claude 4+ models.
  // CC v108 sends it in MITM captures for Max/Pro users.
  if (!isClaude3Model(model)) {
    betas.push("advisor-tool-2026-03-01");
  }

  // context-hint-2026-04-09 is NOT emitted, on any path, under any knob.
  // The profile derived from the real Claude Code 2.1.195 binary sends neither
  // this beta nor its paired `context_hint` body field. Emitting either makes
  // the request distinguishable from the genuine client — the exact opposite of
  // what this plugin exists to do. `token_economy.context_hint` is therefore
  // deprecated rather than honoured: validateConfig warns on explicit opt-in so
  // the switch is not a silent no-op. See lib/config.mjs.

  // Files API — scoped to file endpoints/references
  if (isFilesEndpoint || hasFileReferences) {
    betas.push("files-api-2025-04-14");
  }

  // Token counting endpoint
  if (isMessagesCountTokensPath) {
    betas.push(TOKEN_COUNTING_BETA_FLAG);
  }

  // === TOKEN ECONOMY BETAS (on by default for token savings) ===

  // v2.1.150: redact-thinking is default-ON in CC (first-party, non-SDK, thinking models).
  // Opt out via `/anthropic set redact-thinking off` to see thinking content.
  if (te.redact_thinking !== false && !disableExperimentalBetas && !isClaude3Model(model)) {
    betas.push("redact-thinking-2026-02-12");
  }

  // v2.1.150: thinking-token-count for token budget tracking (behind tengu_chert_bezel in CC).
  // Default ON for token economy visibility. Opt out via token_economy.thinking_token_count = false.
  if (te.thinking_token_count !== false && !disableExperimentalBetas && !isClaude3Model(model)) {
    betas.push("thinking-token-count-2026-05-13");
  }

  // compact-2026-01-12 and mcp-client-2025-11-20 exist only in docs, not runtime.

  // afk-mode — NOT auto-included (requires user opt-in)
  // Available via: /anthropic betas add afk-mode-2026-01-31

  // === MICROCOMPACT BETAS (context-aware, Phase 3 Task 3.4) ===
  if (microcompactBetas?.length) {
    for (const mb of microcompactBetas) {
      if (!betas.includes(mb)) betas.push(mb);
    }
  }

  // Fast-mode beta — the PLUGIN injects speed:"fast" into the body, not the host.
  // Because the host never sends speed:"fast", it also never sends the matching beta.
  // We must add it here, derived structurally from the already-transformed body so
  // it is always in lockstep with the speed field. Added BEFORE the dedupe merge so
  // any duplicate (e.g. via incoming passthrough) is collapsed without duplication.
  // Unlike effort-2025-11-24 / advanced-tool-use / tool-search-tool (which arrive via
  // incoming-header passthrough because the HOST sets those body features), fast-mode
  // is plugin-only and requires this explicit push.
  if (fastModeActive) betas.push(FAST_MODE_BETA_FLAG);

  // Merge incoming betas from the original request, filtering out host-injected
  // betas (e.g. fine-grained-tool-streaming-2025-05-14, structured-outputs-2025-11-13)
  // that OpenCode's Anthropic SDK adds but real Claude Code never sends.
  const filteredIncoming = incomingBetasList.filter((b) => !HOST_SDK_BETAS_BLOCKLIST.has(b));
  let mergedBetas = [...new Set([...betas, ...filteredIncoming])];

  // Add custom betas from config
  if (customBetas?.length) {
    for (const custom of customBetas) {
      const resolved = BETA_SHORTCUTS.get(custom) || custom;
      if (resolved && !mergedBetas.includes(resolved)) {
        mergedBetas.push(resolved);
      }
    }
  }

  // Filter out experimental betas only if explicitly disabled.
  // WARNING: The EXPERIMENTAL_BETA_FLAGS set overlaps with most always-on betas.
  // Enabling CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS effectively strips Claude Code
  // mimicry betas, leaving only oauth-2025-04-20, claude-code-20250219, and effort-*.
  // Use this escape hatch only for debugging or when betas cause API rejections.
  if (disableExperimentalBetas) {
    mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
  }

  return mergedBetas.join(",");
}

export function getStainlessOs(value) {
  if (value === "darwin") return "macOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}

export function getStainlessArch(value) {
  if (value === "x64") return "x64";
  if (value === "arm64") return "arm64";
  return value;
}

export function buildRequestHeaders(
  input,
  requestInit,
  accessToken,
  requestBody,
  requestUrl,
  signature,
  adaptiveOverride,
  tokenEconomy,
) {
  const requestHeaders = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }
  if (requestInit.headers) {
    if (requestInit.headers instanceof Headers) {
      requestInit.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    } else if (Array.isArray(requestInit.headers)) {
      for (const [key, value] of requestInit.headers) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    } else {
      for (const [key, value] of Object.entries(requestInit.headers)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    }
  }

  // Preserve all incoming beta headers while ensuring OAuth requirements
  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const { model, tools, messages, hasFileReferences } = parseRequestBodyMetadata(requestBody);
  // Detect fast mode structurally from the already-transformed body string.
  // transformRequestBody runs before buildRequestHeaders (see index.mjs:2986 vs 3039),
  // so speed:"fast" is already present when fast mode fired. Same detection idiom as the
  // toast check (~line 3018). This is the correct call site for fast-mode: the
  // computedBetaHeader call at index.mjs:2905 runs BEFORE body transform, so fastModeActive
  // is always false/absent there, keeping the latch free of fast-mode. The
  // requestHeaders.set("anthropic-beta", mergedBetas) call below is what reaches the wire.
  const fastModeActive = typeof requestBody === "string" && requestBody.includes('"speed":"fast"');
  const mergedBetas = buildAnthropicBetaHeader(
    incomingBeta,
    signature.enabled,
    model,
    signature.customBetas,
    signature.strategy,
    requestUrl?.pathname,
    hasFileReferences,
    adaptiveOverride,
    tokenEconomy,
    undefined, // microcompactBetas: not available at this call site (handled via computedBetaHeader path at 2905)
    fastModeActive, // NEW 12th param: emit fast-mode-2026-02-01 beta when body contains speed:"fast"
  );

  const authTokenOverride = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const bearerToken = authTokenOverride || accessToken;

  requestHeaders.set("authorization", `Bearer ${bearerToken}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", buildExtendedUserAgent(signature.claudeCliVersion));
  if (signature.enabled) {
    requestHeaders.set("anthropic-version", "2023-06-01");
    // Fix #6: x-app is "cli" for interactive mode, "cli-bg" for background tasks.
    // Real CC (client.ts:106): 'x-app': 'cli' (foreground) or 'cli-bg' (background agent).
    requestHeaders.set("x-app", isTruthyEnv(process.env.CLAUDE_CODE_BACKGROUND) ? "cli-bg" : "cli");
    // Fix #3: X-Claude-Code-Session-Id — sent in ALL requests by real CC (client.ts:108).
    // Value matches metadata.user_id.session_id for server-side correlation.
    if (signature.sessionId) {
      requestHeaders.set("X-Claude-Code-Session-Id", signature.sessionId);
    }
    requestHeaders.set("x-stainless-arch", getStainlessArch(process.arch));
    requestHeaders.set("x-stainless-lang", "js");
    requestHeaders.set("x-stainless-os", getStainlessOs(process.platform));
    // Real CC sends 0.81.0 (confirmed via proxy capture), not the internal 0.208.0.
    // WATCH: most-likely-to-drift mimesis constant. Stable v2.1.97 → v2.1.105 (only
    // the minifier identifier renamed, d66 → g86). Re-verify on every upstream bump:
    //   rg -n '"0\.\d+\.\d+"' _tmp_claude_pkg/<version>/package/cli.js | rg -C2 stainless
    // See docs/future-improvements.md §7 and claude-code-reverse-engineering.md §16.
    requestHeaders.set("x-stainless-package-version", "0.94.0");
    // Real CC on Windows/Node reports "node" — confirmed via proxy capture.
    requestHeaders.set("x-stainless-runtime", "node");
    requestHeaders.set("x-stainless-runtime-version", process.version);
    const incomingRetryCount = requestHeaders.get("x-stainless-retry-count");
    requestHeaders.set(
      "x-stainless-retry-count",
      incomingRetryCount && !isFalsyEnv(incomingRetryCount) ? incomingRetryCount : "0",
    );
    // x-stainless-timeout: real CC sends 600 on ALL requests (confirmed via proxy capture).
    requestHeaders.set("x-stainless-timeout", "600");
    // anthropic-dangerous-direct-browser-access: real CC sends this on all requests.
    requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
    const stainlessHelpers = buildStainlessHelperHeader(tools, messages);
    if (stainlessHelpers) {
      requestHeaders.set("x-stainless-helper", stainlessHelpers);
    }

    for (const [key, value] of Object.entries(parseAnthropicCustomHeaders())) {
      requestHeaders.set(key, value);
    }
    if (process.env.CLAUDE_CODE_CONTAINER_ID) {
      requestHeaders.set("x-claude-remote-container-id", process.env.CLAUDE_CODE_CONTAINER_ID);
    }
    if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) {
      requestHeaders.set("x-claude-remote-session-id", process.env.CLAUDE_CODE_REMOTE_SESSION_ID);
    }
    if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
      requestHeaders.set("x-client-app", process.env.CLAUDE_AGENT_SDK_CLIENT_APP);
    }
    if (isTruthyEnv(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) {
      requestHeaders.set("x-anthropic-additional-protection", "true");
    }

    // x-client-request-id: real CC 2.1.195's first-party fetch middleware (Ukd) sets
    // this to crypto.randomUUID() on every first-party request. Re-emit a random uuid.
    requestHeaders.set("x-client-request-id", randomUUID());
  }
  requestHeaders.delete("x-api-key");
  // x-session-affinity: set by opencode SDK but NOT in real CC. Strip it.
  requestHeaders.delete("x-session-affinity");

  return requestHeaders;
}

export function extractFileIds(body) {
  const ids = [];
  if (!body || typeof body !== "object") return ids;
  // QA fix L-depth: cap recursion depth to prevent stack overflow on pathological payloads
  const MAX_DEPTH = 20;
  function walk(obj, depth) {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
    } else if (obj && typeof obj === "object") {
      if (obj.source?.file_id) ids.push(obj.source.file_id);
      for (const val of Object.values(obj)) {
        if (val && typeof val === "object") walk(val, depth + 1);
      }
    }
  }
  walk(body.messages, 0);
  walk(body.system, 0);
  return ids;
}
