/**
 * Pure translation from the plugin's per-request state to the `transport`
 * object `buildWireCompatibleRequest` (lib/mimicry/wire-compat.mjs) expects.
 *
 * PURITY CONTRACT
 * ---------------
 * Nothing in this module performs I/O, and nothing reads `process.env`,
 * `process.arch`, `process.platform`, `process.version` or a random source.
 * Every ambient value is resolved by the CALLER and handed in:
 *
 *  - environment  -> `state.env` (build it with `resolveAdapterEnv(process.env)`)
 *  - provider     -> `state.provider` (from `detectProvider`, which reads env)
 *  - clientRequestId -> `state.clientRequestId` (the caller calls `randomUUID()`;
 *    the plugin owns generation now, the package only consumes the value)
 *  - platform/arch/node version -> `state.platform` / `state.arch` /
 *    `state.nodeVersion`
 *
 * That makes the whole mapping deterministic and directly testable.
 *
 * NOT WIRED INTO PRODUCTION YET. `index.mjs` still calls `buildRequestHeaders`.
 * This module only builds and validates the input the future call site will use.
 */

import { isTruthyEnv, isFalsyEnv } from "../env.mjs";
import { CLAUDE_3_MODEL_RE, hasOneMillionContext } from "./models.mjs";
import { BETA_SHORTCUTS, EXPERIMENTAL_BETA_FLAGS } from "../request-headers.mjs";
import {
  CLAUDE_CODE_BETA_FLAG,
  buildStainlessHelperHeader,
  getStainlessArch,
  getStainlessOs,
  isHaikuModel,
  parseRequestBodyMetadata,
  supportsStructuredOutputs,
  supportsWebSearch,
} from "./headers.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `signature.enabled === false` puts the plugin in minimal-header mode. */
export const ADAPTER_SKIP_SIGNATURE_DISABLED = "signature-disabled";

/** The shared package pins the Anthropic first-party URL and rejects any other. */
export const ADAPTER_SKIP_NON_ANTHROPIC_PROVIDER = "non-anthropic-provider";

/**
 * `additionalBetas` accepts at most 32 entries; overflow is `INVALID_INPUT`,
 * a hard failure rather than a degradation. Exported so the test suite can
 * assert the realistic worst case stays under it. Deliberately NOT enforced
 * here by truncation: silently dropping a user-configured beta would be a
 * worse failure mode than a loud one.
 */
export const MAX_ADDITIONAL_BETAS = 32;

/**
 * `runtime.sessionId` is REQUIRED by the package (`requiredString`), while the
 * plugin historically OMITTED `X-Claude-Code-Session-Id` when it had no session
 * identifier. Omission is not expressible through the seam, so a blank session
 * id resolves to this fixed placeholder instead of raising `INVALID_INPUT` at
 * request time. It is a syntactically valid v4 UUID so it survives the
 * package's own correlation checks; in practice `signatureSessionId` is always
 * populated when signature emulation is enabled, so this is a safety net rather
 * than a routine path.
 */
export const SESSION_ID_FALLBACK = "00000000-0000-4000-8000-000000000000";

/**
 * Host headers that must never be forwarded through `extraHeaders`.
 *
 * - `x-session-affinity` is set by the opencode SDK but never by real Claude
 *   Code. It is neither canonical nor denylisted in the package, so
 *   `dropConflicting` would happily pass it straight to the wire.
 * - `x-api-key` is deleted by `buildRequestHeaders` today; forwarding it would
 *   leak a host API key alongside the OAuth bearer.
 */
export const ADAPTER_STRIPPED_HOST_HEADERS = new Set(["x-session-affinity", "x-api-key"]);

/**
 * Correlation keys the package REJECTS inside `metadataOverrides.userIdFields`
 * (`INVALID_INPUT`). The plugin used to let them be overwritten silently by
 * spread order, so they are filtered out here to preserve today's outcome —
 * correlation always wins — without the hard failure.
 */
export const METADATA_CORRELATION_KEYS = new Set(["device_id", "account_uuid", "session_id"]);

/** Every environment variable this translation reads, resolved by the caller. */
export const ADAPTER_ENV_KEYS = Object.freeze([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ADDITIONAL_PROTECTION",
  "CLAUDE_CODE_BACKGROUND",
  "CLAUDE_CODE_CONTAINER_ID",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXTRA_METADATA",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "OPENCODE_ANTHROPIC_SIGNATURE_USER_ID",
]);

/**
 * Protocol identity of the pinned profile (`claude-code-2.1.195`). Used to
 * decide whether a `profileOverride` is needed at all — see
 * `resolveProfileOverride` for the user-agent convergence argument.
 */
export const PROFILE_CLI_VERSION = "2.1.195";
export const PROFILE_USER_AGENT = "claude-cli/2.1.195 (external, cli)";

// ---------------------------------------------------------------------------
// Environment snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot the environment variables this module consumes. Pure with respect to
 * its argument; the caller passes `process.env`.
 *
 * @param {Record<string, string | undefined>} source
 * @returns {Record<string, string | undefined>}
 */
export function resolveAdapterEnv(source) {
  /** @type {Record<string, string | undefined>} */
  const snapshot = {};
  for (const key of ADAPTER_ENV_KEYS) {
    if (source?.[key] !== undefined) snapshot[key] = source[key];
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// User agent
// ---------------------------------------------------------------------------

/**
 * Pure mirror of `buildExtendedUserAgent` (lib/request-headers.mjs) with the
 * environment injected instead of read. The two are pinned to agree by
 * `adapter-input.test.mjs`.
 *
 * @param {string} version
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function buildAdapterUserAgent(version, env) {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? "cli";
  const sdkVersion = env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${env.CLAUDE_AGENT_SDK_VERSION}` : "";
  const clientApp = env.CLAUDE_AGENT_SDK_CLIENT_APP ? `, client-app/${env.CLAUDE_AGENT_SDK_CLIENT_APP}` : "";
  return `claude-cli/${version} (external, ${entrypoint}${sdkVersion}${clientApp})`;
}

/**
 * The pinned profile carries a FIXED `userAgent`
 * (`"claude-cli/2.1.195 (external, cli)"`) while the plugin builds one
 * dynamically from entrypoint / agent-sdk version / client-app. In the common
 * case — no `CLAUDE_CODE_ENTRYPOINT`, no `CLAUDE_AGENT_SDK_VERSION`, no
 * `CLAUDE_AGENT_SDK_CLIENT_APP`, detected CLI version `2.1.195` — both sides
 * produce the byte-identical `"claude-cli/2.1.195 (external, cli)"`, so no
 * override is emitted and the request stays byte-identical to the profile.
 *
 * When they diverge, `userAgent` and `cliVersion` are validated TOGETHER by the
 * package (`build-request.ts`), so both are always supplied as a coupled pair.
 *
 * @param {string} claudeCliVersion
 * @param {Record<string, string | undefined>} env
 * @returns {{userAgent: string, cliVersion: string} | undefined}
 */
function resolveProfileOverride(claudeCliVersion, env) {
  const cliVersion = claudeCliVersion || PROFILE_CLI_VERSION;
  const userAgent = buildAdapterUserAgent(cliVersion, env);
  if (cliVersion === PROFILE_CLI_VERSION && userAgent === PROFILE_USER_AGENT) return undefined;
  return { userAgent, cliVersion };
}

// ---------------------------------------------------------------------------
// Host headers
// ---------------------------------------------------------------------------

/**
 * Reproduce the three-shape header collection of `buildRequestHeaders`
 * (Request headers, then `requestInit.headers` as Headers / pair array / plain
 * object), then strip the names that must never reach the wire, then layer
 * `ANTHROPIC_CUSTOM_HEADERS` on top so it keeps overriding host values.
 *
 * @param {Request | undefined} input
 * @param {RequestInit} requestInit
 * @param {Record<string, string | undefined>} env
 * @returns {readonly (readonly [string, string])[] | undefined}
 */
function collectExtraHeaders(input, requestInit, env) {
  const collected = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      collected.set(key, value);
    });
  }

  const initHeaders = requestInit?.headers;
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        collected.set(key, value);
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) {
        if (typeof value !== "undefined") collected.set(key, String(value));
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== "undefined") collected.set(key, String(value));
      }
    }
  }

  for (const name of ADAPTER_STRIPPED_HOST_HEADERS) collected.delete(name);

  for (const [key, value] of Object.entries(parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS))) {
    collected.set(key, value);
  }

  /** @type {(readonly [string, string])[]} */
  const pairs = [];
  collected.forEach((value, key) => {
    pairs.push([key, value]);
  });
  return pairs.length > 0 ? pairs : undefined;
}

/**
 * Pure mirror of `parseAnthropicCustomHeaders` with the raw value injected.
 *
 * @param {string | undefined} raw
 * @returns {Record<string, string>}
 */
function parseCustomHeaders(raw) {
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

/**
 * `x-stainless-retry-count` is a STRING on the header and a NUMBER on the seam.
 * Replicates today's `isFalsyEnv` guard, then coerces. A non-numeric host value
 * (which today would be forwarded verbatim) degrades to 0 rather than pushing
 * `NaN` into the seam.
 *
 * @param {readonly (readonly [string, string])[] | undefined} extraHeaders
 * @returns {number}
 */
function resolveStainlessRetryCount(extraHeaders) {
  const pair = extraHeaders?.find(([name]) => name === "x-stainless-retry-count");
  const raw = pair?.[1];
  if (!raw || isFalsyEnv(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Betas
// ---------------------------------------------------------------------------

/**
 * Build `additionalBetas`: the betas the plugin emits that the package's own
 * `composeBetas` does not.
 *
 * Order is (a) user custom betas, already expanded through `BETA_SHORTCUTS`
 * because the package knows nothing about shortcuts and `validateAdditionalBetas`
 * would let a raw alias such as `afk` reach the wire; then (b) the orphan betas,
 * each under the SAME gate `buildAnthropicBetaHeader` uses today.
 *
 * `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is applied here because the package
 * does not filter `additionalBetas`.
 *
 * @param {{
 *   customBetas: readonly string[] | undefined,
 *   strategy: string | undefined,
 *   model: string,
 *   tokenEconomy: Record<string, unknown>,
 *   isFilesEndpoint: boolean,
 *   hasFileReferences: boolean,
 *   disableExperimentalBetas: boolean,
 * }} args
 * @returns {readonly string[] | undefined}
 */
function buildAdditionalBetas(args) {
  const { customBetas, strategy, model, tokenEconomy, isFilesEndpoint, hasFileReferences, disableExperimentalBetas } =
    args;

  /** @type {string[]} */
  const betas = [];

  // (a) user custom betas, shortcut-expanded plugin-side.
  for (const custom of customBetas ?? []) {
    if (typeof custom !== "string") continue;
    const trimmed = custom.trim();
    if (!trimmed) continue;
    betas.push(BETA_SHORTCUTS.get(trimmed.toLowerCase()) || trimmed);
  }

  // (b) orphan betas — emitted by the plugin, not by the package's composer.
  const isRoundRobin = strategy === "round-robin";
  const te = tokenEconomy || {};

  if (supportsWebSearch(model)) betas.push("web-search-2025-03-05");
  if (!CLAUDE_3_MODEL_RE.test(model)) betas.push("advisor-tool-2026-03-01");
  if (isFilesEndpoint || hasFileReferences) betas.push("files-api-2025-04-14");
  if (te.extended_cache_ttl !== false && !isRoundRobin) betas.push("extended-cache-ttl-2025-04-11");
  if (te.structured_outputs && supportsStructuredOutputs(model)) betas.push("structured-outputs-2025-12-15");
  // The package deliberately excludes Haiku from `claude-code-20250219`; the
  // plugin deliberately includes it so Haiku subagents reached through
  // model-router delegation still get full mimic behaviour.
  if (isHaikuModel(model)) betas.push(CLAUDE_CODE_BETA_FLAG);

  let deduped = [...new Set(betas)];
  if (disableExperimentalBetas) deduped = deduped.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));

  return deduped.length > 0 ? deduped : undefined;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * Translate the two metadata env features onto the mutually exclusive members
 * of `metadataOverrides`. They are structurally different intents:
 *
 *  - `OPENCODE_ANTHROPIC_SIGNATURE_USER_ID` replaces `user_id` verbatim with a
 *    raw string carrying no correlation triple -> `userId`.
 *  - `CLAUDE_CODE_EXTRA_METADATA` merges INTO the derived `user_id` JSON
 *    payload -> `userIdFields`.
 *
 * Supplying both is `INVALID_INPUT`, so today's precedence is preserved:
 * `buildRequestMetadata` early-returns on the signature user id, therefore it
 * wins and the extra-metadata merge is never reached.
 *
 * The three correlation keys are filtered because the package rejects them
 * outright, whereas the plugin used to let spread order overwrite them — same
 * observable outcome, no hard failure.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{userId?: string, userIdFields?: Record<string, unknown>} | undefined}
 */
function buildMetadataOverrides(env) {
  const envUserId = env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID?.trim();
  if (envUserId) return { userId: envUserId };

  const raw = env.CLAUDE_CODE_EXTRA_METADATA?.trim();
  if (!raw) return undefined;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const userIdFields = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !METADATA_CORRELATION_KEYS.has(key)),
  );
  return Object.keys(userIdFields).length > 0 ? { userIdFields } : undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AdapterTransportState
 * @property {Request | undefined} [input] The original host Request.
 * @property {RequestInit} [requestInit] The host request init.
 * @property {string} accessToken Access token of the selected account.
 * @property {URL | undefined} [requestUrl] Parsed outgoing URL.
 * @property {string} provider Result of `detectProvider(requestUrl)`.
 * @property {string} clientRequestId Caller-generated `randomUUID()`.
 * @property {{enabled: boolean, claudeCliVersion: string, customBetas?: readonly string[], strategy?: string, sessionId?: string}} signature
 * @property {{persistentUserId: string, accountId: string}} identity Correlation triple sources.
 * @property {{use1MContext?: unknown} | undefined} [adaptiveOverride]
 * @property {Record<string, unknown> | undefined} [tokenEconomy]
 * @property {string} body The already-transformed request body.
 * @property {Record<string, string | undefined>} env From `resolveAdapterEnv`.
 * @property {string} [platform] `process.platform`, injected.
 * @property {string} [arch] `process.arch`, injected.
 * @property {string} [nodeVersion] `process.version`, injected.
 */

/**
 * Translate the plugin's per-request state into the adapter `transport` object.
 *
 * Returns a discriminated result rather than throwing, so the future call site
 * can bifurcate explicitly:
 *
 *  - `{applicable: false, reason}` — the adapter MUST NOT be called. Either the
 *    signature emulation is off (the plugin emits 3 headers and a minimal beta
 *    set; the package always emits the full set), or the provider is not
 *    first-party Anthropic (the package pins the Anthropic URL and rejects any
 *    other on parse, so Bedrock/Vertex/Foundry/Mantle can never route here).
 *  - `{applicable: true, transport}` — safe to hand to
 *    `buildWireCompatibleRequest`.
 *
 * `cacheControl` is deliberately never emitted: the plugin keeps its own
 * breakpoint placement and the stateful `cacheBoundaryStability` logic.
 *
 * @param {AdapterTransportState} state
 * @returns {{applicable: false, reason: string} | {applicable: true, transport: Record<string, unknown>}}
 */
export function buildAdapterTransport(state) {
  if (state.provider !== "anthropic") {
    return { applicable: false, reason: ADAPTER_SKIP_NON_ANTHROPIC_PROVIDER };
  }
  if (!state.signature?.enabled) {
    return { applicable: false, reason: ADAPTER_SKIP_SIGNATURE_DISABLED };
  }

  const env = state.env ?? {};
  const signature = state.signature;
  const tokenEconomy = state.tokenEconomy ?? {};

  const { model, tools, messages, hasFileReferences } = parseRequestBodyMetadata(state.body);
  const requestPath = state.requestUrl?.pathname;
  const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;

  const extraHeaders = collectExtraHeaders(state.input, state.requestInit ?? {}, env);

  const stainlessHelper = buildStainlessHelperHeader(tools, messages);
  const additionalBetas = buildAdditionalBetas({
    customBetas: signature.customBetas,
    strategy: signature.strategy,
    model,
    tokenEconomy,
    isFilesEndpoint,
    hasFileReferences,
    disableExperimentalBetas: isTruthyEnv(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS),
  });

  // 1M context is ALWAYS passed explicitly. The plugin's default is
  // `hasOneMillionContext(model)` (`/(^|[-_ ])1m($|[-_ ])|context[-_]?1m/i`)
  // while the package's default is `/\[1m\]/iu` over the raw model — literal
  // brackets. Omitting the member would silently hand the decision to the wrong
  // rule, so the tri-state is resolved here and stated outright.
  const use1MContext =
    state.adaptiveOverride && typeof state.adaptiveOverride.use1MContext === "boolean"
      ? state.adaptiveOverride.use1MContext
      : hasOneMillionContext(model);

  const authTokenOverride = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const profileOverride = resolveProfileOverride(signature.claudeCliVersion, env);
  const metadataOverrides = buildMetadataOverrides(env);

  /** @type {Record<string, unknown>} */
  const transport = {
    accessToken: authTokenOverride || state.accessToken,
    clientRequestId: state.clientRequestId,
    runtime: {
      sessionId: signature.sessionId || SESSION_ID_FALLBACK,
      deviceId: state.identity.persistentUserId,
      accountUuid: state.identity.accountId,
      runtime: "node",
      runtimeVersion: state.nodeVersion,
      os: getStainlessOs(state.platform),
      arch: getStainlessArch(state.arch),
    },
    app: isTruthyEnv(env.CLAUDE_CODE_BACKGROUND) ? "cli-bg" : "cli",
    stainlessRetryCount: resolveStainlessRetryCount(extraHeaders),
    betaOverrides: { use1MContext },
    extraHeaderPolicy: "dropConflicting",
  };

  if (stainlessHelper) transport.stainlessHelper = stainlessHelper;
  if (env.CLAUDE_CODE_CONTAINER_ID) transport.claudeRemoteContainerId = env.CLAUDE_CODE_CONTAINER_ID;
  if (env.CLAUDE_CODE_REMOTE_SESSION_ID) transport.claudeRemoteSessionId = env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (env.CLAUDE_AGENT_SDK_CLIENT_APP) transport.clientApp = env.CLAUDE_AGENT_SDK_CLIENT_APP;
  if (isTruthyEnv(env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) transport.anthropicAdditionalProtection = "true";
  if (additionalBetas) transport.additionalBetas = additionalBetas;
  if (metadataOverrides) transport.metadataOverrides = metadataOverrides;
  if (extraHeaders) transport.extraHeaders = extraHeaders;
  if (profileOverride) transport.profileOverride = profileOverride;

  return { applicable: true, transport };
}
