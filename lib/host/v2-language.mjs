import { TransformStream } from "node:stream/web";

// Core derives both option and persisted metadata keys from the full package
// name (aisdk.ts:providerOptionKey), including its version. Keep the pin: the
// unversioned name is rewritten to a native route by aisdk-native.ts:resolve.
export const V2_SDK_PACKAGE = "@ai-sdk/anthropic@3.0.111";
const HOST_KEY = V2_SDK_PACKAGE.slice("@ai-sdk/".length);

function sdkOptions(options) {
  if (!options?.[HOST_KEY]) return options;
  const { [HOST_KEY]: anthropic, ...rest } = options;
  return { ...rest, anthropic: { ...rest.anthropic, ...anthropic } };
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
