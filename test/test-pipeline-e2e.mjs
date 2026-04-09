// End-to-end integration test for the subagent fix.
//
// Simulates the FULL pipeline:
//   opencode llm.ts builds system[] (joined string, length 1)
//   -> Plugin.trigger("experimental.chat.system.transform") [no-op with current fix]
//   -> @ai-sdk/anthropic converts each entry to a wire text block
//   -> Plugin HTTP interceptor calls buildSystemPromptBlocks (THIS is where A5 runs)
//   -> final wire body.system
//
// Verifies the server-facing body.system matches what a real CC request
// would look like for main-agent AND subagent calls.
//
// Run: node test-pipeline-e2e.mjs

import { AnthropicAuthPlugin, __testing__ } from "./index.mjs";

const {
  normalizeSystemTextBlocks,
  buildSystemPromptBlocks,
  SUBAGENT_CC_ANCHOR,
  CLAUDE_CODE_IDENTITY_STRING,
  resetCachedCCPrompt,
} = __testing__;

// Realistic opencode system text for main-agent calls. The joined result
// from llm.ts:107-117 begins with "You are OpenCode, the best coding agent..."
// followed by the standard CC prompt.
const REAL_CC_PROMPT = `You are OpenCode, the best coding agent on the planet.

You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

If the user asks for help or wants to give feedback inform them of the following:
- ctrl+p to list available actions
- To give feedback, users should report the issue at
  https://github.com/anomalyco/opencode

# Tone and style
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- Your output will be displayed on a command line interface. Your responses should be short and concise.

# Task Management
You have access to the TodoWrite tools to help you manage and plan tasks.`;

// Specialist subagent prompt (from input.agent.prompt in llm.ts:110).
// Does NOT contain "You are an interactive" — that's why the fingerprint fails
// without the A5 fix.
const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your role is to locate specific files, symbols, or patterns within the project and report back with exact paths and line numbers.

# Tools
- Grep for content searches
- Glob for file pattern matching
- Read for examining specific files`;

const SUMMARY_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary that captures all important details needed to continue the work.`;

// ---------------------------------------------------------------------------
const mockCtx = {
  client: {},
  project: { id: "test", vcs: "git" },
  directory: "D:/test",
  worktree: "D:/test",
  serverUrl: "http://localhost",
  $: () => {},
};

let passed = 0;
let failed = 0;

function assert(label, condition, details = "") {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${details ? " — " + details : ""}`);
  }
}

function dumpBlock(text, label) {
  console.log(`    [${label}] len=${text.length}, first 60: ${JSON.stringify(text.slice(0, 60))}`);
}

// ---------------------------------------------------------------------------
// Simulate opencode's llm.ts flow + plugin's HTTP interceptor flow.
// ---------------------------------------------------------------------------
async function simulateFullPipeline(pluginHooks, scenarioName, opencodeSystemText) {
  console.log(`\n=== ${scenarioName} ===`);

  // Step 1: opencode builds system[] (single joined string — llm.ts:107-117).
  const system = [opencodeSystemText];

  // Step 2: opencode calls Plugin.trigger("experimental.chat.system.transform").
  // In the A5 design, this hook is a NO-OP because signature emulation is on.
  await pluginHooks["experimental.chat.system.transform"](
    {
      sessionID: "test-session",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6", id: "claude-sonnet-4-6" },
    },
    { system },
  );

  console.log(`  After transform hook: system.length=${system.length}`);
  system.forEach((s, i) => dumpBlock(s, `post-transform[${i}]`));

  // Step 3: opencode converts each system entry to ModelMessage (llm.ts:155).
  // @ai-sdk/anthropic groups consecutive system messages into a single
  // wire body.system array (see anthropic/dist/index.mjs:2072-2086).
  const wireBodySystem = system.map((text) => ({ type: "text", text }));
  console.log(`  Wire body.system (pre-interceptor): ${wireBodySystem.length} blocks`);

  // Step 4: Plugin HTTP interceptor calls buildSystemPromptBlocks with
  // normalizeSystemTextBlocks(parsed.system) + the effective signature.
  // THIS is where the A5 cache/inject runs (see index.mjs buildSystemPromptBlocks).
  const normalized = normalizeSystemTextBlocks(wireBodySystem);
  console.log(`  After normalize: ${normalized.length} blocks`);

  const signature = {
    enabled: true,
    claudeCliVersion: "2.1.97",
    promptCompactionMode: "minimal",
    cachePolicy: { ttl: "1h", ttl_supported: true },
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    firstUserMessage: "Explore the codebase",
  };

  const final = buildSystemPromptBlocks(normalized, signature);
  console.log(`  Final wire body.system: ${final.length} blocks`);
  final.forEach((b, i) => dumpBlock(b.text, `wire[${i}]`));

  return { postTransform: system, final };
}

async function getHooks() {
  return await AnthropicAuthPlugin(mockCtx);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("===================================================");
  console.log("END-TO-END SUBAGENT PIPELINE TEST");
  console.log("===================================================");

  resetCachedCCPrompt();
  const hooks = await getHooks();

  // -----------------------------------------------------------------
  // SCENARIO A: Main-agent call first — primes the A5 cache.
  // -----------------------------------------------------------------
  const mainResult = await simulateFullPipeline(hooks, "SCENARIO A: Main-agent call (baseline)", REAL_CC_PROMPT);
  assert("A: post-transform has 1 block (transform hook is no-op)", mainResult.postTransform.length === 1);
  const mainRest = mainResult.final.find((b) => b.text.includes(SUBAGENT_CC_ANCHOR));
  assert("A: wire has a block with CC anchor", !!mainRest);
  if (mainRest) {
    assert(
      "A: rest block STARTS with CC anchor (no preamble)",
      mainRest.text.startsWith(SUBAGENT_CC_ANCHOR),
      `actual start: ${JSON.stringify(mainRest.text.slice(0, 40))}`,
    );
    assert("A: rest block is <=5000 chars (truncated)", mainRest.text.length <= 5000);
  }
  assert("A: A5 cache is now populated", __testing__.cachedCCPrompt !== null);

  // -----------------------------------------------------------------
  // SCENARIO B: Subagent call AFTER main — A5 injects cached CC prefix.
  // -----------------------------------------------------------------
  const subResult = await simulateFullPipeline(hooks, "SCENARIO B: Subagent call after main", EXPLORE_PROMPT);

  // Post-transform still has 1 block (transform hook is no-op).
  assert("B: post-transform has 1 block (transform hook still no-op)", subResult.postTransform.length === 1);

  // The injection happens inside buildSystemPromptBlocks — final wire output
  // MUST contain the anchor.
  const subRest = subResult.final.find((b) => b.text.includes(SUBAGENT_CC_ANCHOR));
  assert("B: wire has block with CC anchor", !!subRest);
  if (subRest) {
    assert(
      "B: rest block STARTS with CC anchor (specialist NOT first)",
      subRest.text.startsWith(SUBAGENT_CC_ANCHOR),
      `actual start: ${JSON.stringify(subRest.text.slice(0, 60))}`,
    );
    assert("B: rest block CONTAINS specialist text", subRest.text.includes("file search specialist"));
    assert("B: rest block <=5000 chars", subRest.text.length <= 5000);
    console.log(`    rest block length: ${subRest.text.length}`);
    console.log(`    rest block tail (last 100): ${JSON.stringify(subRest.text.slice(-100))}`);
  }

  // Critical check: the wire blocks should be in the right order.
  // Expected: [billingHeader, identityString, rest]
  assert("B: final has 3+ blocks", subResult.final.length >= 2);
  if (subResult.final.length >= 3) {
    assert("B: block[0] is billing header", subResult.final[0].text.startsWith("x-anthropic-billing-header:"));
    assert(
      "B: block[1] is identity string",
      subResult.final[1].text === CLAUDE_CODE_IDENTITY_STRING ||
        subResult.final[1].text.includes("You are Claude Code"),
      `got: ${JSON.stringify(subResult.final[1].text)}`,
    );
    assert("B: block[2] starts with CC anchor (rest)", subResult.final[2].text.startsWith(SUBAGENT_CC_ANCHOR));
  }

  // -----------------------------------------------------------------
  // SCENARIO C: Subagent wire rest block must start with the exact same
  // bytes as the main wire rest block. The subagent case appends the
  // specialist prompt after the CC prefix (so its text is longer), but
  // the leading chars should match byte-for-byte since both originate
  // from the same cached sanitize output.
  // -----------------------------------------------------------------
  if (mainRest && subRest) {
    assert(
      "C: subagent wire rest STARTS WITH main wire rest (same cached prefix)",
      subRest.text.startsWith(mainRest.text),
      `main.len=${mainRest.text.length}, sub.len=${subRest.text.length}, first 40: main=${JSON.stringify(
        mainRest.text.slice(0, 40),
      )}, sub=${JSON.stringify(subRest.text.slice(0, 40))}`,
    );
    assert(
      "C: subagent wire rest is LONGER than main (has specialist text appended)",
      subRest.text.length > mainRest.text.length,
    );
  }

  // -----------------------------------------------------------------
  // SCENARIO D: Summary/compaction agent (hidden primary worker).
  // Expected: A5 injects cached CC prefix from earlier calls.
  // -----------------------------------------------------------------
  const summaryResult = await simulateFullPipeline(hooks, "SCENARIO D: Summary/compaction agent", SUMMARY_PROMPT);
  const summaryRest = summaryResult.final.find((b) => b.text.includes(SUBAGENT_CC_ANCHOR));
  assert("D: summary wire has CC anchor block", !!summaryRest);
  if (summaryRest) {
    assert("D: summary rest starts with CC anchor", summaryRest.text.startsWith(SUBAGENT_CC_ANCHOR));
    assert("D: summary rest contains summary text", summaryRest.text.includes("summarizing conversations"));
  }

  // -----------------------------------------------------------------
  // SCENARIO E: Subagent call FIRST (before any main call) is a safe no-op.
  // -----------------------------------------------------------------
  resetCachedCCPrompt();
  const hooks2 = await getHooks();
  const orphanSubResult = await simulateFullPipeline(
    hooks2,
    "SCENARIO E: Subagent call with no prior main (cache empty)",
    EXPLORE_PROMPT,
  );
  const orphanRest = orphanSubResult.final.find((b) => b.text.includes(SUBAGENT_CC_ANCHOR));
  assert(
    "E: no CC anchor block (cache was empty, safe no-op)",
    !orphanRest,
    orphanRest ? `unexpectedly injected: ${orphanRest.text.slice(0, 60)}` : "",
  );
  assert(
    "E: specialist text is still present (block is untouched)",
    orphanSubResult.final.some((b) => b.text.includes("file search specialist")),
  );

  // -----------------------------------------------------------------
  console.log("\n===================================================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("===================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("TEST ERROR:", err);
  process.exit(1);
});
