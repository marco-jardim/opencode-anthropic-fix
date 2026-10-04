import { CC_TO_OC_TOOL_NAMES } from "../mimicry/response-stream.mjs";

const ALIASES = new Map([
  ["shell", "bash"],
  ["subagent", "task"],
]);
const TO_WIRE = new Map([...CC_TO_OC_TOOL_NAMES].map(([wire, host]) => [host, wire]));

/**
 * Adapt renamed v2 tools before the shared v1 wire policy, retaining a reverse
 * map for this request only. Custom tools occupying a legacy name win: in that
 * case the v2 name stays intact rather than being aliased ambiguously.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
export async function prepareV2Tools(input, init = {}) {
  const body = init.body ?? (input instanceof Request && input.body ? await input.clone().text() : undefined);
  if (typeof body !== "string") return { input, init };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // The shared executor owns request validation and its error diagnostics.
    return { input, init };
  }
  if (!Array.isArray(parsed?.tools)) return { input, init };
  const names = new Set(parsed.tools.map((tool) => tool.name).filter((name) => typeof name === "string"));
  const aliases = new Map();
  const toolNameMap = new Map();
  for (const name of names) {
    const alias = ALIASES.get(name);
    if (alias && !names.has(alias) && !names.has(TO_WIRE.get(alias))) aliases.set(name, alias);
    const normalized = aliases.get(name) ?? name;
    const wire = TO_WIRE.get(normalized) ?? normalized;
    const restored = CC_TO_OC_TOOL_NAMES.get(wire) ?? (wire.startsWith("mcp_") ? wire.slice(4) : wire);
    if (toolNameMap.has(restored) && toolNameMap.get(restored) !== name) {
      throw new Error(`Anthropic tool names collide after wire normalization: ${name}`);
    }
    toolNameMap.set(restored, name);
  }
  const rename = (object, key) => {
    if (typeof object?.[key] === "string" && aliases.has(object[key])) object[key] = aliases.get(object[key]);
  };
  const renameReference = (object, key) => {
    rename(object, key);
    if (typeof object?.[key] === "string") object[key] = TO_WIRE.get(object[key]) ?? object[key];
  };
  const visit = (block) => {
    if (block?.type === "tool_use") rename(block, "name");
    if (block?.type === "tool_reference") {
      renameReference(block, "tool_name");
      renameReference(block, "name");
    }
    if (block?.type === "tool_result" && Array.isArray(block.content)) block.content.forEach(visit);
  };
  for (const tool of parsed.tools) rename(tool, "name");
  if (parsed.tool_choice?.type === "tool") renameReference(parsed.tool_choice, "name");
  for (const message of parsed.messages ?? []) {
    if (Array.isArray(message.content)) message.content.forEach(visit);
  }
  return { input, init: { ...init, body: JSON.stringify(parsed) }, toolNameMap };
}
