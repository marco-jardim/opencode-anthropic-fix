/**
 * Adapter from the plugin's host request shape to the shared wire constructor.
 * The logical canonical header order is tested, but order on the fetch wire is
 * NOT promised because the returned HeaderPair array is converted to Headers.
 */

import {
  buildClaudeCodeRequest,
  buildClaudeCodeCountTokensRequest,
  CLAUDE_CODE_2_1_233_PROFILE,
  hasOneMillionContext,
  isAdaptiveThinkingModel,
  isClaude3Model,
  isEligibleFor1MContext,
  isFable5Model,
  isMythos5Model,
  isOpus46Model,
  isOpus47Model,
  isOpus48Model,
} from "@tormentalabs/claude-code-wire-compat";
import { stripStainlessHelperMarkers } from "./headers.mjs";

/**
 * Model-family predicates, re-exported so the rest of the tree classifies models
 * through the SAME catalogue the request builder classifies them with.
 *
 * These used to be hand-written regexes in `lib/mimicry/models.mjs`, maintained
 * in parallel with the package's model catalogue and therefore free to drift
 * from it: a request could be composed as an adaptive-thinking model by the
 * package while the plugin's own gating said otherwise. Sourcing both sides from
 * one place removes that whole class of divergence. The behavioural differences
 * this migration introduces are pinned, row by row, in
 * `test/conformance/model-predicates-parity.test.mjs`.
 *
 * `isEligibleFor1MContext` is deliberately NOT re-exported raw — see
 * `isEligibleFor1MContextWire` below.
 */
export {
  hasOneMillionContext,
  isAdaptiveThinkingModel,
  isClaude3Model,
  isFable5Model,
  isMythos5Model,
  isOpus46Model,
  isOpus47Model,
  isOpus48Model,
};

/**
 * 1M-context eligibility under the profile the plugin actually emulates.
 *
 * Unlike its siblings, the package's `isEligibleFor1MContext` is
 * PROFILE-DEPENDENT: its second parameter selects the model catalogue, and it
 * defaults to the package's own baseline (2.1.195), not to ours. The two
 * disagree in practice — `claude-mythos-5` is ineligible under 2.1.195 and
 * eligible under 2.1.233 — so calling it bare would gate the plugin's context
 * decisions on a profile the plugin does not emulate anywhere else.
 *
 * This wrapper binds `WIRE_PROFILE`, so eligibility follows the emulated
 * profile automatically if that baseline is ever bumped.
 *
 * @param {string | undefined} model
 * @returns {boolean}
 */
export function isEligibleFor1MContextWire(model) {
  return isEligibleFor1MContext(model, WIRE_PROFILE);
}

/**
 * The protocol profile the plugin composes against, re-exported so the rest of
 * the tree can read the baseline CLI version WITHOUT importing the package.
 *
 * This module is the single seam through which
 * `@tormentalabs/claude-code-wire-compat` enters the plugin (pinned by
 * `test/conformance/package-dependency-policy.test.mjs`), so a consumer that
 * needs `cliVersion` — the startup value of `claudeCliVersion` in index.mjs, the
 * `mimicryBaseline` reported by `lib/diagnose.mjs` — reads it from here instead
 * of re-declaring a hand-maintained copy.
 *
 * NOTE: this is a BASELINE, not the profile the request path uses. The
 * composition path deliberately passes no explicit `profile` so it inherits the
 * package's `DEFAULT_PROFILE` (see `lib/mimicry/adapter-input.mjs`); naming a
 * profile here only pins what the plugin reports about itself.
 *
 * @type {import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProtocolProfile}
 */
export const WIRE_PROFILE = CLAUDE_CODE_2_1_233_PROFILE;

const PROFILE_OVERRIDE_ENV = "OPENCODE_ANTHROPIC_PROFILE_OVERRIDE";

const BODY_FIELD_NAMES = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "tools",
  "thinking",
  "effort",
  "metadata",
  "context_management",
  "output_config",
  "speed",
  "service_tier",
  "output_format",
  "tool_choice",
  "top_p",
  "top_k",
  "stop_sequences",
  "stream",
  "temperature",
]);

/**
 * @param {Record<string, import('@tormentalabs/claude-code-wire-compat').JsonValue>} body
 * @returns {Record<string, import('@tormentalabs/claude-code-wire-compat').JsonValue> | undefined}
 */
function collectExperimentalBodyFields(body) {
  const fields = Object.fromEntries(Object.entries(body).filter(([name]) => !BODY_FIELD_NAMES.has(name)));
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * The shared contract accepts `system` as an array of strings or text blocks.
 * A host may send a bare string instead, which must be wrapped rather than
 * dropped: silently discarding it would lose caller intent with no error.
 *
 * @param {import('@tormentalabs/claude-code-wire-compat').JsonValue | undefined} system
 * @returns {readonly import('@tormentalabs/claude-code-wire-compat').SystemInput[] | undefined}
 */
function normalizeSystem(system) {
  if (system === undefined) return undefined;
  if (typeof system === "string") return [system];
  if (Array.isArray(system)) return system;
  throw new TypeError("Expected request system to be a string or an array");
}

/**
 * Rewrite DOTTED model version separators to DASHED ones before the id reaches
 * the shared package.
 *
 * WHY THIS EXISTS. The package classifies models by dashed id ONLY:
 * `normalizeModelId` (dist/model-identity.js) tests `includes("claude-opus-4-7")`
 * and never the dotted spelling, because the genuine Claude Code client emits
 * dashed ids. The plugin, by contrast, deliberately TOLERATES dotted ids
 * throughout — the package's own family predicates re-exported above accept
 * `claude-opus-4.7` — so a host can legitimately hand us that spelling.
 *
 * WHY IT SURVIVED THE PACKAGE MIGRATION. The consolidation plan predicted this
 * rewrite could be deleted once the family predicates came from the package,
 * on the premise that the package normalizes the id for us. Measured against
 * the installed package, that premise is WRONG, and the distinction is:
 *
 *   - DECISIONS are dotted-tolerant. The package's own predicates classify
 *     `claude-opus-4.7` correctly (pinned as data in
 *     `test/conformance/model-predicates-parity.test.mjs`).
 *   - The BODY is not normalized. The package copies the caller's model
 *     through VERBATIM apart from stripping `[1m]`-style markers, so feeding
 *     it `claude-opus-4.7` bare yields `body.model === "claude-opus-4.7"`.
 *
 * The real API only accepts the dashed spelling, so dropping this rewrite
 * would put an id on the wire that Anthropic rejects. The tolerance therefore
 * belongs to the plugin, is spent here, and the package receives the dashed id
 * it is built for. The rewrite is deliberately narrow:
 * a dot is only replaced when it FOLLOWS a letter or digit and PRECEDES a
 * digit, i.e. when it is a version separator (`claude-opus-4.7`,
 * `claude-3.5-sonnet`). A dot before a letter is left alone, so vendor
 * prefixes such as `anthropic.claude-opus-4-6` in a Bedrock ARN survive
 * untouched.
 *
 * NOTE: `wireId = stripModelMarkers(model)` derives from this same string, so
 * the `model` sent on the wire also becomes dashed. That is intended — the
 * real API only accepts the dashed spelling — and is pinned by a test.
 *
 * @param {import('@tormentalabs/claude-code-wire-compat').JsonValue | undefined} model
 * @returns {import('@tormentalabs/claude-code-wire-compat').JsonValue | undefined}
 */
function normalizeModelVersionSeparators(model) {
  if (typeof model !== "string") return model;
  return model.replace(/([A-Za-z0-9])\.(?=\d)/g, "$1-");
}

/**
 * Reject a malformed `tools` value instead of dropping it, so a host mistake
 * surfaces as an error rather than as a silently toolless request.
 *
 * @param {import('@tormentalabs/claude-code-wire-compat').JsonValue | undefined} tools
 * @returns {readonly import('@tormentalabs/claude-code-wire-compat').ToolDefinition[] | undefined}
 */
function normalizeTools(tools) {
  if (tools === undefined) return undefined;
  if (Array.isArray(tools)) return tools;
  throw new TypeError("Expected request tools to be an array");
}

/**
 * Resolve the emergency protocol-profile override. Explicit plugin
 * configuration wins over the environment; an absent override leaves the
 * shared package's pinned profile untouched. JSON and package validation
 * errors intentionally propagate so an emergency override cannot fail open.
 *
 * @param {import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProfileOverride | undefined} configuredOverride
 * @returns {import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProfileOverride | undefined}
 */
function resolveProfileOverride(configuredOverride) {
  if (configuredOverride !== undefined) return configuredOverride;

  const serializedOverride = process.env[PROFILE_OVERRIDE_ENV];
  if (serializedOverride === undefined || serializedOverride === "") return undefined;

  const parsed = JSON.parse(serializedOverride);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${PROFILE_OVERRIDE_ENV} must contain a JSON object`);
  }
  return parsed;
}

/**
 * @param {Record<string, import('@tormentalabs/claude-code-wire-compat').JsonValue>} body
 * @param {{
 *   accessToken: string,
 *   clientRequestId: string,
 *   runtime: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeRuntimeIdentity,
 *   app?: 'cli' | 'cli-bg',
 *   stainlessRetryCount?: number,
 *   stainlessHelper?: string,
 *   claudeRemoteContainerId?: string,
 *   claudeRemoteSessionId?: string,
 *   clientApp?: string,
 *   anthropicAdditionalProtection?: string,
 *   extraHeaders?: readonly import('@tormentalabs/claude-code-wire-compat').HeaderPair[],
 *   extraHeaderPolicy?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeExtraHeaderPolicy,
 *   additionalBetas?: readonly string[],
 *   suppressBetas?: readonly string[],
 *   suppressBillingBlock?: boolean,
 *   suppressIdentityBlock?: boolean,
 *   betaOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeBetaOverrides,
 *   metadataOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeMetadataOverrides,
 *   cacheControl?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeCacheControlInput,
 *   capabilities?: Partial<import('@tormentalabs/claude-code-wire-compat').ClaudeCodeCapabilities>,
 *   profileOverride?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProfileOverride,
 * }} transport
 * @returns {import('@tormentalabs/claude-code-wire-compat').ClaudeCodeRequestInput}
 */
export function toClaudeCodeRequestInput(body, transport) {
  const system = normalizeSystem(body.system);
  const profileOverride = resolveProfileOverride(transport.profileOverride);
  const thinking =
    body.thinking === undefined
      ? undefined
      : {
          type: body.thinking.type,
          ...(body.thinking.budget_tokens === undefined ? {} : { budgetTokens: body.thinking.budget_tokens }),
          ...(body.thinking.display === undefined ? {} : { display: body.thinking.display }),
        };
  const outputConfig =
    body.output_config === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(body.output_config).map(([name, value]) => [
            name === "max_output_tokens" ? "maxOutputTokens" : name,
            value,
          ]),
        );
  const input = {
    accessToken: transport.accessToken,
    model: normalizeModelVersionSeparators(body.model),
    maxTokens: body.max_tokens,
    messages: body.messages,
    runtime: transport.runtime,
    clientRequestId: transport.clientRequestId,
    system,
    tools: normalizeTools(body.tools),
    thinking,
    cacheControl: transport.cacheControl,
    // WHY: the package derives model capabilities from the normalized model id
    // alone. This seam is the only way a consumer can DOWNGRADE one of them
    // (`build-request.js` rejects an UPGRADE with `UNSUPPORTED_CAPABILITY`, but
    // allows `true -> false`). The plugin needs it so
    // `OPENCODE_ANTHROPIC_DISABLE_ADAPTIVE_THINKING` can turn `adaptiveThinking`
    // off and push `resolveThinking` down its `else` branch, emitting
    // `{budget_tokens, type: "enabled"}` instead of `{type: "adaptive"}`.
    // Omitted entirely when the transport does not set it, so a consumer that
    // downgrades nothing stays byte-identical to the genuine client.
    capabilities: transport.capabilities,
    effort: body.effort,
    metadata: body.metadata,
    experimentalBodyFields: collectExperimentalBodyFields(body),
    contextManagement: body.context_management,
    outputConfig,
    speed: body.speed,
    serviceTier: body.service_tier,
    outputFormat: body.output_format,
    toolChoice: body.tool_choice,
    topP: body.top_p,
    topK: body.top_k,
    stopSequences: body.stop_sequences,
    stream: body.stream,
    temperature: body.temperature,
    app: transport.app,
    stainlessRetryCount: transport.stainlessRetryCount,
    stainlessHelper: transport.stainlessHelper,
    claudeRemoteContainerId: transport.claudeRemoteContainerId,
    claudeRemoteSessionId: transport.claudeRemoteSessionId,
    clientApp: transport.clientApp,
    anthropicAdditionalProtection: transport.anthropicAdditionalProtection,
    extraHeaders: transport.extraHeaders,
    extraHeaderPolicy: transport.extraHeaderPolicy,
    additionalBetas: transport.additionalBetas,
    suppressBetas: transport.suppressBetas,
    suppressBillingBlock: transport.suppressBillingBlock,
    // Sibling of `suppressBillingBlock` at the ROOT of the package input — NOT
    // `cacheControl.suppressIdentityBlock`, which only drops the block's
    // `cache_control` marker and keeps the block itself. This one omits the
    // whole identity block, which is what the lean-system-prompt feature needs
    // now that the adapter path delegates canonical block composition to the
    // package (`suppressCanonicalBlocks` in request-body.mjs).
    suppressIdentityBlock: transport.suppressIdentityBlock,
    // UNCONDITIONAL on purpose. `lib/mimicry/request-body.mjs` never touches
    // `cache_control` on `thinking`/`redacted_thinking` blocks because ANY
    // mutation of those blocks — including deleting the key — makes the real
    // API answer 400 "thinking or redacted_thinking blocks in the latest
    // assistant message cannot be modified". The plugin therefore ALWAYS needs
    // the package to accept and pass the key through verbatim; the need is a
    // property of the API round-trip contract, not of a given request. Gating
    // it on "does some block actually carry the key" would add a scan and a
    // second state to get wrong for zero behavioural gain: with the flag on and
    // no such key present, the package output is byte-identical.
    preserveThinkingBlockCacheControl: true,
    betaOverrides: transport.betaOverrides,
    metadataOverrides: transport.metadataOverrides,
    ...(profileOverride === undefined ? {} : { profileOverride }),
  };
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/**
 * Build a Claude Code request from the JSON body received from the host.
 *
 * @param {string | undefined} body
 * @param {{
 *   accessToken: string,
 *   clientRequestId: string,
 *   runtime: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeRuntimeIdentity,
 *   app?: 'cli' | 'cli-bg',
 *   stainlessRetryCount?: number,
 *   stainlessHelper?: string,
 *   claudeRemoteContainerId?: string,
 *   claudeRemoteSessionId?: string,
 *   clientApp?: string,
 *   anthropicAdditionalProtection?: string,
 *   extraHeaders?: readonly import('@tormentalabs/claude-code-wire-compat').HeaderPair[],
 *   extraHeaderPolicy?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeExtraHeaderPolicy,
 *   additionalBetas?: readonly string[],
 *   suppressBetas?: readonly string[],
 *   suppressBillingBlock?: boolean,
 *   suppressIdentityBlock?: boolean,
 *   betaOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeBetaOverrides,
 *   metadataOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeMetadataOverrides,
 *   cacheControl?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeCacheControlInput,
 *   capabilities?: Partial<import('@tormentalabs/claude-code-wire-compat').ClaudeCodeCapabilities>,
 *   profileOverride?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProfileOverride,
 * }} transport
 * @returns {Promise<Omit<import('@tormentalabs/claude-code-wire-compat').BuiltClaudeCodeRequest, 'headers'> & {headers: Headers}>}
 */
export async function buildWireCompatibleRequest(body, transport) {
  if (!body || typeof body !== "string") throw new TypeError("Expected a JSON request body");
  const parsed = JSON.parse(body);
  // The stainless helper markers are an internal signal: buildAdapterTransport
  // already derived `transport.stainlessHelper` from them, and the API has never
  // known those keys — the package rejects them with INVALID_INPUT. `parsed` is
  // a local object owned by this call, so the strip is in place.
  stripStainlessHelperMarkers(parsed?.tools, parsed?.messages);
  let built;
  try {
    built = await buildClaudeCodeRequest(toClaudeCodeRequestInput(parsed, transport));
  } catch (error) {
    throw foldSafeDetailsIntoMessage(error);
  }
  return { ...built, headers: new Headers(built.headers) };
}

/**
 * The subset of `ClaudeCodeRequestInput` keys that `ClaudeCodeCountTokensInput`
 * picks. Kept as data so the pick below stays a single source of truth.
 */
const COUNT_TOKENS_INPUT_FIELDS = new Set([
  "accessToken",
  "model",
  "messages",
  "tools",
  "runtime",
  "clientRequestId",
  "profileOverride",
  "crypto",
  "app",
  "stainlessRetryCount",
  "stainlessHelper",
  "claudeRemoteContainerId",
  "claudeRemoteSessionId",
  "clientApp",
  "anthropicAdditionalProtection",
  "extraHeaders",
  "extraHeaderPolicy",
]);

/**
 * Map the host body to the shared package's count-tokens input.
 *
 * WHY THIS DELEGATES TO THE FULL MAPPER AND PICKS. The package declares
 * `ClaudeCodeCountTokensInput = Pick<ClaudeCodeRequestInput, ...>` — literally
 * the same field names carrying the same types — so every value the full mapper
 * produces for a retained key is already built under the exact contract the
 * count-tokens surface expects. Picking is therefore safe by construction, and
 * it keeps the host tolerances that DO apply in one place instead of forking
 * them: the dotted->dashed model rewrite, `tools` raising on a malformed value
 * instead of silently dropping it, the stainless marker/transport passthrough,
 * and the profile-override resolution all carry over unchanged.
 *
 * The tolerances that do NOT apply are dropped by the pick rather than reaching
 * the package: upstream derives the count-tokens beta set from the model alone
 * and the count body carries no `system`, `metadata` or `max_tokens`. `system`
 * is stripped BEFORE delegating, because `normalizeSystem` throws on a
 * malformed value and a field that is contractually absent from the count body
 * must not be able to fail the build.
 *
 * EXTRA HEADERS. The count surface takes `extraHeaderPolicy` since wire-compat
 * 0.4.0, so the policy is set here exactly as the main turn sets it on the
 * transport (`buildAdapterTransport`). Under the package default (`strict`) the
 * first host header the package owns raises `DUPLICATE_HEADER` (canonical name)
 * or `FORBIDDEN_HEADER` (hop-by-hop / credential name) and nothing reaches the
 * wire — and the plugin forwards a heterogeneous host header map, the opencode
 * SDK alone sending `content-type` and `accept`. `dropConflicting` drops only
 * OWNERSHIP conflicts: header syntax is still validated package-side and a
 * caller duplicating one of its OWN extra headers still raises
 * `DUPLICATE_HEADER`, because that is a caller bug and not ours to paper over.
 * The names the package drops are reported back as
 * `evidence.droppedExtraHeaderNames`.
 *
 * @param {Record<string, import('@tormentalabs/claude-code-wire-compat').JsonValue>} body
 * @param {{
 *   accessToken: string,
 *   clientRequestId: string,
 *   runtime: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeRuntimeIdentity,
 *   app?: 'cli' | 'cli-bg',
 *   stainlessRetryCount?: number,
 *   stainlessHelper?: string,
 *   claudeRemoteContainerId?: string,
 *   claudeRemoteSessionId?: string,
 *   clientApp?: string,
 *   anthropicAdditionalProtection?: string,
 *   extraHeaders?: readonly import('@tormentalabs/claude-code-wire-compat').HeaderPair[],
 *   crypto?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeRequestInput['crypto'],
 *   profileOverride?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProfileOverride,
 * }} transport
 * @returns {import('@tormentalabs/claude-code-wire-compat').ClaudeCodeCountTokensInput}
 */
export function toClaudeCodeCountTokensInput(body, transport) {
  const { system: _system, ...bodyWithoutSystem } = body;
  const full = toClaudeCodeRequestInput(bodyWithoutSystem, transport);
  const input = Object.fromEntries(Object.entries(full).filter(([name]) => COUNT_TOKENS_INPUT_FIELDS.has(name)));
  input.extraHeaderPolicy = "dropConflicting";
  if (transport.crypto !== undefined) input.crypto = transport.crypto;
  return input;
}

/**
 * Build a Claude Code `/v1/messages/count_tokens` request from the JSON body
 * received from the host. Mirrors `buildWireCompatibleRequest`, including the
 * deliberate absence of an explicit `profile` argument so the count turn
 * inherits the package's `DEFAULT_PROFILE` exactly like the main turn does.
 *
 * @param {string | undefined} body
 * @param {Parameters<typeof toClaudeCodeCountTokensInput>[1]} transport
 * @returns {Promise<Omit<import('@tormentalabs/claude-code-wire-compat').BuiltClaudeCodeCountTokensRequest, 'headers'> & {headers: Headers}>}
 */
export async function buildWireCompatibleCountTokensRequest(body, transport) {
  if (!body || typeof body !== "string") throw new TypeError("Expected a JSON request body");
  const parsed = JSON.parse(body);
  // Same rationale as the main turn: `buildAdapterTransport` already derived
  // `transport.stainlessHelper` from these markers, the API has never known the
  // keys, and the package rejects them with INVALID_INPUT. `parsed` is a local
  // object owned by this call, so the strip is in place.
  stripStainlessHelperMarkers(parsed?.tools, parsed?.messages);
  let built;
  try {
    built = await buildClaudeCodeCountTokensRequest(toClaudeCodeCountTokensInput(parsed, transport));
  } catch (error) {
    throw foldSafeDetailsIntoMessage(error);
  }
  return { ...built, headers: new Headers(built.headers) };
}

/**
 * The package deliberately sanitizes its errors down to a bare code, and carries
 * the useful part in `safeDetails`, which nothing surfaces. Fold it into the
 * message so a rejection is diagnosable from a stack trace alone. The error
 * object itself is preserved, so `code`, `safeDetails` and `instanceof` all
 * still hold for callers that inspect them.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
function foldSafeDetailsIntoMessage(error) {
  if (error instanceof Error && "safeDetails" in error) {
    const detail = Object.entries(error.safeDetails ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    if (detail) error.message = `${error.message} (${detail})`;
  }
  return error;
}
