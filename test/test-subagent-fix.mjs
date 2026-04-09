// Standalone test for the subagent CC-prefix cache/inject fix.
//
// The fix lives inside buildSystemPromptBlocks (NOT the transform hook).
// This test exercises buildSystemPromptBlocks directly across the known
// scenarios to prove: (a) main-agent calls cache the CC prefix, (b) subagent
// calls inject it, and (c) non-Anthropic requests are never touched.
//
// Run: node test-subagent-fix.mjs

import { __testing__ } from "./index.mjs";

const { buildSystemPromptBlocks, SUBAGENT_CC_ANCHOR, resetCachedCCPrompt } = __testing__;

// Typical main-agent sanitized text (starts with the anchor by virtue of
// sanitizeSystemText stripping opencode's "You are OpenCode..." preamble).
const MAIN_AGENT_SANITIZED =
  "You are an interactive CLI tool that helps users with software engineering tasks. " +
  "Use the instructions below and the tools available to you to assist the user.\n\n" +
  "IMPORTANT: You must NEVER generate or guess URLs...\n\n" +
  "# Tone and style\n- Be concise.";

// Specialist subagent prompts (do NOT start with "You are an interactive").
const EXPLORE_PROMPT =
  "You are a file search specialist. You excel at thoroughly navigating and exploring codebases to find exactly what the user needs.\n" +
  "Use grep, glob, and read tools to answer questions about the codebase.";

const SUMMARY_PROMPT =
  "Summarize what was done in this conversation. Write like a pull request description.\n\nRules:\n- 2-3 sentences max";

const TITLE_PROMPT = "You are a title generator. You output ONLY a thread title. Nothing else.";

const SIGNATURE_ON = {
  enabled: true,
  claudeCliVersion: "2.1.97",
  promptCompactionMode: "minimal",
  cachePolicy: { ttl: "1h", ttl_supported: true },
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  firstUserMessage: "hello",
};

const SIGNATURE_OFF = { ...SIGNATURE_ON, enabled: false };

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

function build(blocks, signature = SIGNATURE_ON) {
  // buildSystemPromptBlocks expects objects with {type, text}.
  return buildSystemPromptBlocks(
    blocks.map((b) => (typeof b === "string" ? { type: "text", text: b } : b)),
    signature,
  );
}

function findBlockContainingAnchor(out) {
  return out.find((b) => typeof b.text === "string" && b.text.includes(SUBAGENT_CC_ANCHOR));
}

// ---------------------------------------------------------------------------
console.log("\n=== Scenario 1: Main agent call primes the cache ===");
{
  resetCachedCCPrompt();
  const out = build([MAIN_AGENT_SANITIZED]);
  check("signature-enabled output is non-empty", out.length > 0);
  const rest = findBlockContainingAnchor(out);
  check("output contains CC anchor block", !!rest);
  check("cachedCCPrompt populated", __testing__.cachedCCPrompt !== null);
  check(
    "cachedCCPrompt starts with anchor",
    typeof __testing__.cachedCCPrompt === "string" && __testing__.cachedCCPrompt.startsWith(SUBAGENT_CC_ANCHOR),
  );
}

console.log("\n=== Scenario 2: Subagent call after main injects cached prefix ===");
{
  // Cache is still populated from Scenario 1.
  const out = build([EXPLORE_PROMPT]);
  const rest = findBlockContainingAnchor(out);
  check("subagent output contains CC anchor block", !!rest);
  check(
    "subagent output also contains specialist text",
    out.some((b) => typeof b.text === "string" && b.text.includes("file search specialist")),
  );
}

console.log("\n=== Scenario 3: Subagent call BEFORE any main is a no-op (cache empty) ===");
{
  resetCachedCCPrompt();
  const out = build([EXPLORE_PROMPT]);
  const rest = findBlockContainingAnchor(out);
  check("no CC anchor block (cache was empty)", !rest);
  check(
    "specialist text still present",
    out.some((b) => typeof b.text === "string" && b.text.includes("file search specialist")),
  );
  check("cachedCCPrompt still null", __testing__.cachedCCPrompt === null);
}

console.log("\n=== Scenario 4: Title generator path is NOT touched by A5 ===");
{
  resetCachedCCPrompt();
  const out = build([TITLE_PROMPT]);
  // isTitleGeneratorSystemBlocks replaces the whole input with COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT.
  // Our A5 logic short-circuits on titleGeneratorRequest so no prefix gets cached.
  check("cachedCCPrompt still null after title request", __testing__.cachedCCPrompt === null);
}

console.log("\n=== Scenario 5: Summary agent after main reuses cache ===");
{
  resetCachedCCPrompt();
  build([MAIN_AGENT_SANITIZED]); // prime
  const out = build([SUMMARY_PROMPT]);
  const rest = findBlockContainingAnchor(out);
  check("summary output contains CC anchor block", !!rest);
  check(
    "summary output contains summary text",
    out.some((b) => typeof b.text === "string" && b.text.includes("Summarize")),
  );
}

console.log("\n=== Scenario 6: Non-Anthropic (signature.enabled=false) is untouched ===");
{
  resetCachedCCPrompt();
  const out = build([EXPLORE_PROMPT], SIGNATURE_OFF);
  // With signature.enabled=false, buildSystemPromptBlocks returns sanitized as-is
  // BEFORE hitting the billing header / splitSysPromptPrefix path. A5 also
  // short-circuits on !signature.enabled so no injection happens.
  check("no CC anchor injected", !findBlockContainingAnchor(out));
  check("cachedCCPrompt still null", __testing__.cachedCCPrompt === null);
}

console.log("\n=== Scenario 7: Main-agent call with object-format block primes cache ===");
{
  resetCachedCCPrompt();
  const objectBlock = { type: "text", text: MAIN_AGENT_SANITIZED };
  const out = build([objectBlock]);
  check("cache populated from object-format block", __testing__.cachedCCPrompt !== null);
  check("output contains CC anchor", !!findBlockContainingAnchor(out));
}

console.log("\n=== Scenario 8: Second main-agent call does not overwrite cache ===");
{
  // Cache is populated from Scenario 7.
  const firstCache = __testing__.cachedCCPrompt;
  const differentPrompt = MAIN_AGENT_SANITIZED + "\n\n# Later edit";
  build([differentPrompt]);
  check("cachedCCPrompt stayed identical to first-seen value", __testing__.cachedCCPrompt === firstCache);
}

console.log(`\n===== Summary: ${pass} passed, ${fail} failed =====`);
process.exit(fail > 0 ? 1 : 0);
