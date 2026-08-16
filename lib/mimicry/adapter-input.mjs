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
 * WIRED INTO PRODUCTION. `index.mjs` calls this and hands the result to
 * `buildWireCompatibleRequest`, falling back to `buildRequestHeaders` only when
 * the translation declines (`applicable: false`) or the request has no body.
 */

import { isTruthyEnv, isFalsyEnv } from "../env.mjs";
import { CLAUDE_3_MODEL_RE, hasOneMillionContext } from "./models.mjs";
import { BETA_SHORTCUTS, EXPERIMENTAL_BETA_FLAGS } from "../request-headers.mjs";
import { resolveCacheTtl } from "./cache.mjs";
import {
  CLAUDE_CODE_BETA_FLAG,
  HOST_SDK_BETAS_BLOCKLIST,
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
 * The pathnames the shared package has a surface for. `/v1/messages` and
 * `/messages` go to `buildClaudeCodeRequest`; the count pair goes to
 * `buildClaudeCodeCountTokensRequest`. Every other pathname (files, models,
 * a gateway-prefixed route) is passed through untouched by the interceptor.
 */
export const ADAPTER_MESSAGES_PATHNAMES = new Set(["/v1/messages", "/messages"]);

/** @see ADAPTER_MESSAGES_PATHNAMES */
export const ADAPTER_COUNT_TOKENS_PATHNAMES = new Set(["/v1/messages/count_tokens", "/messages/count_tokens"]);

/**
 * Reject a request the adapter is REQUIRED to handle but cannot.
 *
 * WHY THIS THROWS INSTEAD OF DEGRADING. Since Phase 2.2 the adapter is
 * unconditional: with signature emulation on, a messages/count_tokens turn has
 * exactly one construction path. A body the package cannot consume used to fall
 * back to the legacy forge, which meant a malformed or bodiless request quietly
 * went on the wire with a different fingerprint than every other turn in the
 * session — the failure mode the migration exists to remove. Failing loudly
 * here keeps the path single, and the message names the endpoint and the exact
 * defect so the caller can fix its request.
 *
 * The check is deliberately structural (a JSON object), not semantic: `model`,
 * `max_tokens` and `messages` validation belongs to the package, which already
 * reports it as `INVALID_INPUT` with `safeDetails`.
 *
 * @param {unknown} body The body the host handed the interceptor.
 * @param {string | undefined} pathname The outgoing pathname, for the message.
 * @returns {void}
 * @throws {Error} When the body is absent, unparsable, or not a JSON object.
 */
export function assertAdapterBodyUsable(body, pathname) {
  const where = `${pathname ?? "the messages endpoint"} with signature emulation on`;
  if (typeof body !== "string" || body.length === 0) {
    throw new Error(
      `opencode-anthropic-fix: ${where} requires a JSON request body, but the request carried ` +
        `${typeof body === "string" ? "an empty string" : `no usable body (${typeof body})`}. ` +
        `The Claude Code wire adapter cannot construct this request.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `opencode-anthropic-fix: ${where} requires a JSON request body, but the body could not be ` +
        `parsed as JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `The Claude Code wire adapter cannot construct this request.`,
      { cause: error },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `opencode-anthropic-fix: ${where} requires a JSON OBJECT request body, but the body parsed ` +
        `as ${Array.isArray(parsed) ? "an array" : String(parsed === null ? "null" : typeof parsed)}. ` +
        `The Claude Code wire adapter cannot construct this request.`,
    );
  }
}

/**
 * `additionalBetas` accepts at most 32 entries; overflow is `INVALID_INPUT`,
 * a hard failure rather than a degradation. Exported so the test suite can
 * assert the realistic worst case stays under it. Deliberately NOT enforced
 * here by truncation: silently dropping a user-configured beta would be a
 * worse failure mode than a loud one.
 */
export const MAX_ADDITIONAL_BETAS = 32;

/**
 * `suppressBetas` has the same 32-entry ceiling as `additionalBetas`. The
 * realistic worst case is `EXPERIMENTAL_BETA_FLAGS` (28) plus the round-robin
 * prompt-caching-scope suppression (1) = 29, so the cap is never reached; the
 * constant exists so `adapter-input.test.mjs` can pin that arithmetic.
 */
export const MAX_SUPPRESS_BETAS = 32;

/**
 * Composed by the package unconditionally, but suppressed by the plugin under
 * the round-robin strategy: rotating accounts means the cache scope marker
 * points at a prompt cache the next account cannot read, so paying the beta's
 * bookkeeping buys nothing.
 */
export const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";

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
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_BACKGROUND",
  "CLAUDE_CODE_CONTAINER_ID",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXTRA_METADATA",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  // Read by `resolveCacheTtl`; snapshotted here so the identity-block ttl this
  // module emits is resolved from the SAME inputs as the body's cache_control
  // markers (request-body.mjs) instead of silently ignoring the two overrides.
  "ENABLE_PROMPT_CACHING_1H",
  "FORCE_PROMPT_CACHING_5M",
  "OPENCODE_ANTHROPIC_SIGNATURE_USER_ID",
  // Read here rather than through `process.env` (see the PURITY CONTRACT at the
  // top of this file) so the capability downgrade is resolved from the same
  // snapshot as everything else this module emits.
  "OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING",
]);

/**
 * Protocol identity of the profile this adapter composes against
 * (`claude-code-2.1.233-sdk-0.112.1`). Used to decide whether a
 * `profileOverride` is needed at all — see `resolveProfileOverride` for the
 * user-agent convergence argument.
 *
 * PROFILE INHERITANCE POLICY. The adapter never passes an explicit `profile`
 * argument to the package's entry points; omitting it IS the mechanism by which
 * the plugin inherits whatever `DEFAULT_PROFILE` the installed
 * `@tormentalabs/claude-code-wire-compat` declares. The dependency is tracked at
 * the `latest` dist-tag, so each package release can advance the default profile
 * and the plugin follows without a code change to the composition path.
 *
 * These two constants are the ONLY thing that has to move in lockstep: they
 * mirror the default profile's `cliVersion` / `userAgent` so that
 * `resolveProfileOverride` stays silent in the common case. Keep them in sync
 * with `FALLBACK_CLAUDE_CLI_VERSION` (lib/request-headers.mjs) on every package
 * bump that changes the default profile.
 */
export const PROFILE_CLI_VERSION = "2.1.233";
export const PROFILE_USER_AGENT = "claude-cli/2.1.233 (external, cli)";

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
 * The inherited default profile carries a FIXED `userAgent`
 * (`"claude-cli/2.1.233 (external, cli)"`) while the plugin builds one
 * dynamically from entrypoint / agent-sdk version / client-app. In the common
 * case — no `CLAUDE_CODE_ENTRYPOINT`, no `CLAUDE_AGENT_SDK_VERSION`, no
 * `CLAUDE_AGENT_SDK_CLIENT_APP`, detected CLI version `2.1.233` — both sides
 * produce the byte-identical `"claude-cli/2.1.233 (external, cli)"`, so no
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
 * The collected `anthropic-beta` is NOT forwarded as a header — it is canonical,
 * so `extraHeaderPolicy: "dropConflicting"` discards it and the package's own
 * composition governs the wire value. Its CONTENT is still meaningful (a host
 * SDK asking for a beta), so it is split out here and merged into
 * `additionalBetas` by the caller. Dropping the header while keeping the intent
 * is the whole point.
 *
 * @param {Request | undefined} input
 * @param {RequestInit} requestInit
 * @param {Record<string, string | undefined>} env
 * @returns {{pairs: readonly (readonly [string, string])[] | undefined, incomingBetas: readonly string[]}}
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

  // `Headers` normalises names to lower case, so this lookup is already
  // case-insensitive over whatever the host sent, and it joins repeated
  // occurrences with ", " before we split.
  const incomingBetas = (collected.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta.length > 0 && !HOST_SDK_BETAS_BLOCKLIST.has(beta));

  /** @type {(readonly [string, string])[]} */
  const pairs = [];
  collected.forEach((value, key) => {
    pairs.push([key, value]);
  });
  return { pairs: pairs.length > 0 ? pairs : undefined, incomingBetas };
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
 * Betas arriving on the host's own `anthropic-beta` header are appended LAST:
 * the header itself is dropped as conflicting, so this is the only path that
 * keeps a host SDK's request alive, and config-declared betas keep precedence
 * in the emitted order.
 *
 * @param {{
 *   customBetas: readonly string[] | undefined,
 *   strategy: string | undefined,
 *   model: string,
 *   tokenEconomy: Record<string, unknown>,
 *   isFilesEndpoint: boolean,
 *   hasFileReferences: boolean,
 *   disableExperimentalBetas: boolean,
 *   incomingBetas: readonly string[],
 * }} args
 * @returns {readonly string[] | undefined}
 */
function buildAdditionalBetas(args) {
  const {
    customBetas,
    strategy,
    model,
    tokenEconomy,
    isFilesEndpoint,
    hasFileReferences,
    disableExperimentalBetas,
    incomingBetas,
  } = args;

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

  // (c) betas rescued from the host's dropped `anthropic-beta` header, already
  // blocklist-filtered by `collectExtraHeaders`. Last, so the dedup below keeps
  // the config-declared order for anything both sides ask for.
  for (const incoming of incomingBetas) betas.push(incoming);

  let deduped = [...new Set(betas)];
  if (disableExperimentalBetas) deduped = deduped.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));

  return deduped.length > 0 ? deduped : undefined;
}

/**
 * Build `suppressBetas`: the FINAL filter, applied by the package after its own
 * composition and after the `additionalBetas` merge. This is the only seam that
 * can reach a beta the package composes on its own — filtering `additionalBetas`
 * cannot, which is exactly why both user-facing switches below used to be
 * silent no-ops once the adapter owned the request.
 *
 * A non-composed identifier is a silent no-op package-side, so passing the whole
 * `EXPERIMENTAL_BETA_FLAGS` set is safe and avoids depending on which of them the
 * package happens to compose for a given model.
 *
 * @param {{isRoundRobin: boolean, disableExperimentalBetas: boolean}} args
 * @returns {readonly string[] | undefined}
 */
function buildSuppressBetas({ isRoundRobin, disableExperimentalBetas }) {
  /** @type {Set<string>} */
  const suppressed = new Set();

  if (isRoundRobin) suppressed.add(PROMPT_CACHING_SCOPE_BETA);
  if (disableExperimentalBetas) for (const beta of EXPERIMENTAL_BETA_FLAGS) suppressed.add(beta);

  if (suppressed.size === 0) return undefined;
  return [...suppressed];
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
 * @property {{ttl?: string, ttl_supported?: boolean} | undefined} [cachePolicy] Effective cache policy, same object request-body.mjs resolves from.
 * @property {string | undefined} [requestRole] From `classifyRequestRole`; absent means main.
 * @property {boolean | undefined} [isSubagent] True when the turn carries `x-parent-session-id`.
 * @property {boolean | undefined} [isTitleGenerator] True when the ORIGINAL system blocks are the
 *   title-generator prompt. Must be derived from the pre-transform body: by the time `body` is
 *   handed here the title-generator swap has already replaced those blocks.
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
 * `cacheControl` carries ONLY `ttl`: the plugin keeps its own breakpoint
 * placement and the stateful `cacheBoundaryStability` logic, and the omitted
 * `enabled` is what preserves that.
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

  const { pairs: extraHeaders, incomingBetas } = collectExtraHeaders(state.input, state.requestInit ?? {}, env);

  const disableExperimentalBetas = isTruthyEnv(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const isRoundRobin = signature.strategy === "round-robin";

  const stainlessHelper = buildStainlessHelperHeader(tools, messages);
  const additionalBetas = buildAdditionalBetas({
    customBetas: signature.customBetas,
    strategy: signature.strategy,
    model,
    tokenEconomy,
    isFilesEndpoint,
    hasFileReferences,
    disableExperimentalBetas,
    incomingBetas,
  });
  const suppressBetas = buildSuppressBetas({ isRoundRobin, disableExperimentalBetas });

  // 1M context is ALWAYS passed explicitly. The plugin's default is
  // `hasOneMillionContext(model)` (`/(^|[-_ ])1m($|[-_ ])|context[-_]?1m/i`)
  // while the package's default is `/\[1m\]/iu` over the raw model — literal
  // brackets. Omitting the member would silently hand the decision to the wrong
  // rule, so the tri-state is resolved here and stated outright.
  const use1MContext =
    state.adaptiveOverride && typeof state.adaptiveOverride.use1MContext === "boolean"
      ? state.adaptiveOverride.use1MContext
      : hasOneMillionContext(model);

  // Same resolution request-body.mjs runs before it stamps cache_control on the
  // system blocks, tools and messages, fed from the same state. Re-deriving it
  // (rather than eyeballing the body) keeps the identity-block marker pinned to
  // the same ttl the rest of the request already carries.
  const basePolicy = state.cachePolicy ?? { ttl: "1h", ttl_supported: true };
  const cachingEnabledForTtl = basePolicy.ttl !== "off" && basePolicy.ttl_supported !== false;
  const cacheTtl = cachingEnabledForTtl
    ? resolveCacheTtl({
        configuredTtl: basePolicy.ttl || "1h",
        roleScopedTtl: tokenEconomy.role_scoped_cache_ttl !== false,
        isMainForCache: state.requestRole === "main" || state.requestRole == null,
        isSubagent: state.isSubagent === true,
        env,
      })
    : basePolicy.ttl || "1h";

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
    // COUNTERINTUITIVE, DO NOT "COMPLETE" THIS OBJECT: `enabled` must stay
    // ABSENT. Its absence is what gates applyToolCacheControl and
    // applyMessageCacheControl package-side, so the plugin's own tool and
    // message cache_control markers survive untouched and placement stays
    // governed by resolveCacheTtl and cacheBoundaryStability here. Setting
    // `enabled: false` would not be equivalent, and `enabled: true` would hand
    // breakpoint placement to the package.
    //
    // `ttl` governs the marker on the identity block at index 1, which the
    // package would otherwise hardcode to "1h". Ahead of the plugin's
    // role-scoped 5m blocks that produced the [5m, 1h, 5m, 5m] sequence and
    // the "system.1.cache_control.ttl: a ttl='1h' cache_control block must not
    // come after a ttl='5m' cache_control block" rejection on subagent turns.
    // Passing the resolved ttl fixes the ordering WITHOUT suppressing the
    // block, so "Fix #3: Identity block has cache_control" — and the system
    // prompt cache hit that depends on it — is preserved.
    cacheControl: { ttl: cacheTtl },
    extraHeaderPolicy: "dropConflicting",
  };

  if (stainlessHelper) transport.stainlessHelper = stainlessHelper;
  if (env.CLAUDE_CODE_CONTAINER_ID) transport.claudeRemoteContainerId = env.CLAUDE_CODE_CONTAINER_ID;
  if (env.CLAUDE_CODE_REMOTE_SESSION_ID) transport.claudeRemoteSessionId = env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (env.CLAUDE_AGENT_SDK_CLIENT_APP) transport.clientApp = env.CLAUDE_AGENT_SDK_CLIENT_APP;
  if (isTruthyEnv(env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) transport.anthropicAdditionalProtection = "true";
  // Opt-OUT switch: only an explicitly falsy value disables the billing block,
  // matching how the plugin reads its other negative env flags. Unset means the
  // attribution stays, which is the default Claude Code behaviour.
  if (env.CLAUDE_CODE_ATTRIBUTION_HEADER !== undefined && isFalsyEnv(env.CLAUDE_CODE_ATTRIBUTION_HEADER)) {
    transport.suppressBillingBlock = true;
  }
  // Lean system prompt for non-main requests (`token_economy.lean_system_non_main`).
  //
  // On the LEGACY path this decision lives in `buildSystemPromptBlocks`
  // (`leanNonMain` in lib/mimicry/system-prompt.mjs), which returns the
  // sanitized blocks before the billing header and the identity prefix are
  // prepended. On the ADAPTER path those two blocks are no longer the plugin's
  // to withhold — `suppressCanonicalBlocks` hands their composition to the
  // package — so the same decision has to be re-expressed as the package's two
  // root seams, or the opt-in silently degrades to a no-op.
  //
  // The gate is the SAME conjunction as the legacy one: opt-in flag, a "title"
  // or "small" role, and not a title-generator turn (that shape gets its own
  // canonical system prompt swap and keeps the attribution).
  if (
    tokenEconomy.lean_system_non_main === true &&
    (state.requestRole === "title" || state.requestRole === "small") &&
    state.isTitleGenerator !== true
  ) {
    transport.suppressBillingBlock = true;
    // NOTE: the ROOT seam, sibling of `suppressBillingBlock`, which omits the
    // identity block entirely. NOT `cacheControl.suppressIdentityBlock`, which
    // only drops that block's `cache_control` marker and keeps its text.
    transport.suppressIdentityBlock = true;
  }
  // WHY: the package derives `adaptiveThinking` from the model id alone, so on
  // an adaptive model it always emits `thinking: {type: "adaptive"}` and the
  // user-facing `OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING` switch became a
  // silent no-op once the adapter owned the request. `capabilities` is the only
  // seam that can reach that decision; a `true -> false` DOWNGRADE is permitted
  // (an upgrade is `UNSUPPORTED_CAPABILITY`). Turning it off pushes
  // `resolveThinking` into its `else` branch, restoring the explicit
  // `{budget_tokens, type: "enabled"}` shape the plugin used to produce.
  //
  // The key is emitted ONLY when the switch is on: absent means "package
  // decides", which keeps the request byte-identical for everyone else.
  if (isTruthyEnv(env.OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING)) {
    transport.capabilities = { adaptiveThinking: false };
  }
  if (additionalBetas) transport.additionalBetas = additionalBetas;
  if (suppressBetas) transport.suppressBetas = suppressBetas;
  if (metadataOverrides) transport.metadataOverrides = metadataOverrides;
  if (extraHeaders) transport.extraHeaders = extraHeaders;
  if (profileOverride) transport.profileOverride = profileOverride;

  return { applicable: true, transport };
}
