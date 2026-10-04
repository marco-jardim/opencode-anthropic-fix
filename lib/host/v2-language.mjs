import { TransformStream } from "node:stream/web";

// A local factory avoids the host's redundant npm install before our SDK hook.
// It also avoids the unversioned package's native-route rewrite. Core uses the
// provider ID as the option/metadata key for file:// factories.
export const V2_SDK_PACKAGE = new URL("./v2-sdk.mjs", import.meta.url).href;
const HOST_KEY = "anthropic";
const LEGACY_KEY = "anthropic@3.0.111";

function sdkOptions(options) {
  // Preserve signed reasoning from sessions persisted under the old package key.
  if (!options?.[LEGACY_KEY]) return options;
  const { [LEGACY_KEY]: anthropic, ...rest } = options;
  return { ...rest, anthropic: { ...anthropic, ...rest.anthropic } };
}

function callOptions(options) {
  return {
    ...options,
    providerOptions: sdkOptions(options.providerOptions),
    prompt: options.prompt.map((message) => ({
      ...message,
      providerOptions: sdkOptions(message.providerOptions),
      ...(Array.isArray(message.content)
        ? { content: message.content.map((part) => ({ ...part, providerOptions: sdkOptions(part.providerOptions) })) }
        : {}),
    })),
  };
}

function hostMetadata(part) {
  if (!part.providerMetadata?.anthropic) return part;
  const { anthropic, ...rest } = part.providerMetadata;
  return { ...part, providerMetadata: { ...rest, [HOST_KEY]: anthropic } };
}

/** @param {import('@ai-sdk/provider').LanguageModelV3} language */
export function adaptV2Language(language) {
  return {
    specificationVersion: language.specificationVersion,
    provider: language.provider,
    modelId: language.modelId,
    supportedUrls: language.supportedUrls,
    async doGenerate(options) {
      const result = await language.doGenerate(callOptions(options));
      return { ...hostMetadata(result), content: result.content.map(hostMetadata) };
    },
    async doStream(options) {
      const result = await language.doStream(callOptions(options));
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({ transform: (part, controller) => controller.enqueue(hostMetadata(part)) }),
        ),
      };
    },
  };
}
