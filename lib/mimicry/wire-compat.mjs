/**
 * Adapter from the plugin's host request shape to the shared wire constructor.
 * The logical canonical header order is tested, but order on the fetch wire is
 * NOT promised because the returned HeaderPair array is converted to Headers.
 */

import { buildClaudeCodeRequest } from "@tormentalabs/claude-code-wire-compat";

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
 *   betaOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeBetaOverrides,
 *   metadataOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeMetadataOverrides,
 *   cacheControl?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeCacheControlInput,
 *   profileOverride?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProfileOverride,
 * }} transport
 * @returns {import('@tormentalabs/claude-code-wire-compat').ClaudeCodeRequestInput}
 */
function toClaudeCodeRequestInput(body, transport) {
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
    model: body.model,
    maxTokens: body.max_tokens,
    messages: body.messages,
    runtime: transport.runtime,
    clientRequestId: transport.clientRequestId,
    system,
    tools: normalizeTools(body.tools),
    thinking,
    cacheControl: transport.cacheControl,
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
 *   betaOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeBetaOverrides,
 *   metadataOverrides?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeMetadataOverrides,
 *   cacheControl?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeCacheControlInput,
 *   profileOverride?: import('@tormentalabs/claude-code-wire-compat').ClaudeCodeProfileOverride,
 * }} transport
 * @returns {Promise<Omit<import('@tormentalabs/claude-code-wire-compat').BuiltClaudeCodeRequest, 'headers'> & {headers: Headers}>}
 */
export async function buildWireCompatibleRequest(body, transport) {
  if (!body || typeof body !== "string") throw new TypeError("Expected a JSON request body");
  const parsed = JSON.parse(body);
  const built = await buildClaudeCodeRequest(toClaudeCodeRequestInput(parsed, transport));
  return { ...built, headers: new Headers(built.headers) };
}
