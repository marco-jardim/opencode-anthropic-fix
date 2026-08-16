// Guard against the single most repeated failure mode of this migration: the
// shared package (`@tormentalabs/claude-code-wire-compat`) grows a new field on
// `ClaudeCodeRequestInput`, and nobody adds it to the EXPLICIT field list in
// `toClaudeCodeRequestInput`. Nothing throws, nothing warns — the seam simply
// has no effect, and the plugin silently keeps emitting the old wire shape.
// That has already happened three times.
//
// The test derives BOTH sides mechanically:
//   * the package side from `dist/contracts.d.ts` of the INSTALLED package, so a
//     dependency bump that adds a field immediately shows up here;
//   * the plugin side by CALLING the translator with a maximal fixture and
//     reading `Object.keys` of the result, because the translator drops
//     `undefined` values, so anything not populated by the fixture is invisible.
//
// Neither side may be hardcoded: a hardcoded package list would defeat the only
// purpose of the test.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { toClaudeCodeRequestInput } from "../../lib/mimicry/wire-compat.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const contractsPath = resolve(repositoryRoot, "node_modules/@tormentalabs/claude-code-wire-compat/dist/contracts.d.ts");

/**
 * Fields of `ClaudeCodeRequestInput` the translator deliberately does NOT pass
 * through. Every entry needs a reason: an omission without one is
 * indistinguishable from the bug this test exists to catch.
 *
 * The allowlist is checked in BOTH directions — an entry naming a field the
 * package no longer declares fails the test too, so this cannot rot into a
 * graveyard of stale names.
 */
const deliberateOmissions = new Map([
  [
    "crypto",
    // Injects the Web Crypto provider the package uses to hash the request body.
    // The plugin runs on Node >= 18 / Bun, where `globalThis.crypto.subtle` is
    // always present, which is exactly the default the package falls back to.
    // Forwarding it would mean the plugin picking an implementation it has no
    // reason to override; the seam exists for hosts without global Web Crypto.
    "test-only/host-only injection seam; the plugin's runtimes always provide global `crypto.subtle`, which is the package default",
  ],
  [
    "previousRequestId",
    // Feeds the `cc_prev_req` segment of the billing block, new in the 2.1.233
    // profile (the 2.1.195 profile has no such segment and ignores the field).
    // The value is the `request-id` the SERVER returned on the preceding turn.
    // The plugin's fetch interceptor does not thread response ids back into the
    // next outgoing request: it has no per-conversation store keyed by anything
    // the host gives it, and the host body carries no such id either.
    //
    // This is a KNOWN, OBSERVABLE DIVERGENCE, not a no-op: from turn 2 onward a
    // genuine 2.1.233 client emits `cc_prev_req=req_...;` and the plugin does
    // not. Recorded in docs/mimicry/wire-compat-divergences.md; closing it needs
    // response-id capture plumbed through the interceptor, which is a follow-up.
    "the plugin does not track server-returned request ids, so it cannot supply `cc_prev_req`; known turn-2+ divergence from the 2.1.233 profile, tracked as a follow-up",
  ],
  [
    "promptId",
    // Feeds the `cc_prompt_id` segment of the same 2.1.233-only billing block.
    // Upstream reads a host-side prompt UUID; the package cannot derive one and
    // neither can the plugin — nothing in the intercepted request identifies a
    // prompt, and inventing a UUID would emit a segment whose value is
    // meaningless rather than matching genuine traffic.
    //
    // Same class of divergence as `previousRequestId`, same follow-up.
    "no host-side prompt UUID reaches the interceptor; synthesising one would emit a fabricated `cc_prompt_id`, so the segment is omitted — known 2.1.233 divergence, tracked as a follow-up",
  ],
]);

/**
 * Extract the top-level property names of an interface from a `.d.ts` source.
 *
 * Handles what the real file actually contains: JSDoc blocks between fields,
 * `readonly` modifiers, optional `?` markers, and INLINE OBJECT TYPES (e.g.
 * `thinking?: { readonly type: ...; }`) whose members must NOT be mistaken for
 * fields of the interface itself — hence the brace-depth tracking.
 *
 * @param {string} source
 * @param {string} interfaceName
 * @returns {string[]}
 */
function extractInterfaceFieldNames(source, interfaceName) {
  const header = new RegExp(`export interface ${interfaceName}\\s*\\{`, "u");
  const headerMatch = header.exec(source);
  if (headerMatch === null) {
    throw new Error(
      `Could not find \`export interface ${interfaceName}\` in ${contractsPath}. ` +
        `The package layout changed: update this test's extractor, do not delete the test.`,
    );
  }

  const bodyStart = headerMatch.index + headerMatch[0].length;
  let depth = 1;
  let end = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`Unbalanced braces while reading \`${interfaceName}\` from ${contractsPath}.`);
  }

  const body = source.slice(bodyStart, end);
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//gu, "\n").replace(/\/\/[^\n]*/gu, "");

  const names = [];
  let nesting = 0;
  for (const rawLine of withoutComments.split("\n")) {
    const line = rawLine.trim();
    if (nesting === 0) {
      const field = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/u.exec(line);
      if (field !== null) names.push(field[1]);
    }
    for (const character of line) {
      if (character === "{") nesting += 1;
      else if (character === "}") nesting -= 1;
    }
  }

  if (names.length === 0) {
    throw new Error(
      `Extracted zero fields from \`${interfaceName}\` in ${contractsPath}. ` +
        `The extractor is broken — a passing test with an empty package side would guard nothing.`,
    );
  }
  return names;
}

/**
 * A body that populates every field the translator can read from the host body.
 * Maximal ON PURPOSE: the translator filters `undefined` out of its result, so a
 * field left unset here would look like a field the translator never forwards,
 * and the test would report a false positive.
 *
 * @returns {Record<string, unknown>}
 */
function maximalBody() {
  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8192,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    system: [{ type: "text", text: "system prompt" }],
    tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: {} } }],
    thinking: { type: "enabled", budget_tokens: 4096, display: "full" },
    effort: "high",
    metadata: { user_id: "user-1" },
    context_management: { edits: [] },
    output_config: { max_output_tokens: 4096 },
    speed: "standard",
    service_tier: "auto",
    output_format: { type: "json_schema", schema: { type: "object" } },
    tool_choice: { type: "auto" },
    top_p: 0.9,
    top_k: 10,
    stop_sequences: ["STOP"],
    stream: true,
    temperature: 1,
  };
}

/**
 * A transport that populates every field the translator can read from the
 * transport side. Same reasoning as `maximalBody`.
 *
 * @returns {Record<string, unknown>}
 */
function maximalTransport() {
  return {
    accessToken: "sk-ant-oat01-test",
    clientRequestId: "req-0000",
    runtime: { platform: "linux", arch: "x64", nodeVersion: "v22.0.0", claudeCodeVersion: "2.0.0" },
    app: "cli",
    stainlessRetryCount: 0,
    stainlessHelper: "helper",
    claudeRemoteContainerId: "container-1",
    claudeRemoteSessionId: "session-1",
    clientApp: "opencode",
    anthropicAdditionalProtection: "true",
    extraHeaders: [{ name: "x-test", value: "1" }],
    extraHeaderPolicy: "dropConflicting",
    additionalBetas: ["extra-beta-2025-01-01"],
    suppressBetas: ["some-beta-2025-01-01"],
    suppressBillingBlock: true,
    suppressIdentityBlock: true,
    betaOverrides: {},
    metadataOverrides: {},
    cacheControl: {},
    capabilities: { adaptiveThinking: false },
    profileOverride: { userAgent: "claude-cli/2.0.0 (external, cli)" },
  };
}

/**
 * Extra top-level body keys that are not canonical Anthropic fields. Their only
 * job is to make `collectExperimentalBodyFields` return something, so the
 * `experimentalBodyFields` key actually shows up in the translator output.
 *
 * @returns {Record<string, unknown>}
 */
function experimentalBodyProbe() {
  return { some_unrecognized_beta_field: "probe-value" };
}

const contractsSource = readFileSync(contractsPath, "utf8");
const packageFields = extractInterfaceFieldNames(contractsSource, "ClaudeCodeRequestInput");

const translated = toClaudeCodeRequestInput({ ...maximalBody(), ...experimentalBodyProbe() }, maximalTransport());
const forwardedFields = Object.keys(translated);

describe("wire-compat request-input coverage", () => {
  it("extracts a plausible ClaudeCodeRequestInput shape from the installed package", () => {
    // Sanity floor for the extractor itself. If the parse silently degrades, the
    // coverage assertion below would pass while guarding nothing.
    expect(packageFields).toContain("accessToken");
    expect(packageFields).toContain("model");
    expect(packageFields).toContain("messages");
    expect(new Set(packageFields).size).toBe(packageFields.length);
    // Members of the inline `thinking` object type must not leak into the field
    // list; they are not fields of `ClaudeCodeRequestInput`.
    expect(packageFields).not.toContain("budgetTokens");
  });

  it("forwards every ClaudeCodeRequestInput field that is not a declared deliberate omission", () => {
    const forwarded = new Set(forwardedFields);
    const unhandled = packageFields.filter((field) => !forwarded.has(field) && !deliberateOmissions.has(field));

    if (unhandled.length > 0) {
      throw new Error(
        [
          `\`ClaudeCodeRequestInput\` field(s) not handled by \`toClaudeCodeRequestInput\`: ${unhandled.join(", ")}.`,
          "",
          "`toClaudeCodeRequestInput` (lib/mimicry/wire-compat.mjs) builds the package",
          "input from an EXPLICIT field list. A field the package declares but that list",
          "omits is silently dropped: the seam looks wired, nothing throws, and it has no",
          "effect on the emitted request. That is the exact bug this test exists to catch.",
          "",
          "Do ONE of the following, per field listed above:",
          "  1. forward it in `toClaudeCodeRequestInput` (and plumb it from the host body",
          "     or from `transport`, matching the neighbouring fields), or",
          "  2. add it to `deliberateOmissions` in this test WITH a reason explaining why",
          "     the plugin intentionally never sets it.",
          "",
          "Option 2 is not a way to silence this test — an unexplained entry there is the",
          "same silent no-op wearing a hat.",
        ].join("\n"),
      );
    }
  });

  it("keeps the deliberate-omission allowlist free of fields the package no longer declares", () => {
    const declared = new Set(packageFields);
    const stale = [...deliberateOmissions.keys()].filter((field) => !declared.has(field));

    if (stale.length > 0) {
      throw new Error(
        [
          `\`deliberateOmissions\` names field(s) that \`ClaudeCodeRequestInput\` no longer declares: ${stale.join(", ")}.`,
          "",
          "Remove them from the allowlist in this file. A stale entry is dead weight that",
          "would also mask a future field reintroduced under the same name.",
        ].join("\n"),
      );
    }
  });

  it("does not forward keys the package does not declare", () => {
    const declared = new Set(packageFields);
    const unknown = forwardedFields.filter((field) => !declared.has(field));

    if (unknown.length > 0) {
      throw new Error(
        [
          `\`toClaudeCodeRequestInput\` emits key(s) absent from \`ClaudeCodeRequestInput\`: ${unknown.join(", ")}.`,
          "",
          "Either the package dropped/renamed the field — in which case the translator is",
          "now setting a key the package ignores, another silent no-op — or the translator",
          "has a typo. Reconcile against",
          "node_modules/@tormentalabs/claude-code-wire-compat/dist/contracts.d.ts.",
        ].join("\n"),
      );
    }
  });
});
