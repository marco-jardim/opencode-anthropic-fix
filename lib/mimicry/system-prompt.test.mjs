import { describe, expect, it } from "vitest";
import { EMPOWERMENT_BLOCKS } from "../system-prompt-empowerment.mjs";
import {
  CLAUDE_CODE_IDENTITY_STRING,
  GENUINE_OPENING_SENTENCE,
  buildSystemPromptBlocks,
  compactToolDescription,
  dedupeSystemBlocks,
  getCacheControlForScope,
  isSimpleSystemPromptEligible,
  isTitleGeneratorSystemBlocks,
  normalizeSystemTextBlocks,
  sanitizeSystemText,
  segmentSystemText,
  tailSystemBlock,
} from "./system-prompt.mjs";

// A grinning-face emoji: one grapheme cluster, 2 UTF-16 units (surrogate pair).
const GRIN = "😀";

// The pre-WP2 shape: no opening sentence, no empowerment, no split.
const LEGACY = { empowerment: "off", genuine_opening: false, split_stable_volatile: false };

describe("system prompt host policy", () => {
  it("sanitizes OpenCode branding with the existing case rules", () => {
    expect(sanitizeSystemText("OpenCode opencode openCode opencode_helper")).toBe(
      "Claude Code Claude Claude opencode_helper",
    );
  });

  it("removes duplicate normalized text blocks", () => {
    const first = { type: "text", text: "First line\nSecond line" };
    const duplicate = { type: "text", text: " First line \r\n Second line " };
    const unique = { type: "text", text: "Unique" };

    expect(dedupeSystemBlocks([first, duplicate, unique])).toEqual([first, unique]);
  });

  it("tails a system block while retaining key constraints", () => {
    expect(tailSystemBlock("Identity\n\ndiscard this\n# Keep\nMUST remain", 200, 3)).toBe(
      "Identity\n\n# Keep\nMUST remain\n\n[Verbose instructions trimmed after turn 3. Key constraints preserved above.]",
    );
  });

  it("detects title-generator system blocks", () => {
    expect(isTitleGeneratorSystemBlocks([{ type: "text", text: "You are a title generator." }])).toBe(true);
    expect(isTitleGeneratorSystemBlocks([{ type: "text", text: "You are a coding assistant." }])).toBe(false);
  });

  it("builds cache-control wire shapes for each scope", () => {
    const policy = { ttl: "1h", ttl_supported: true };

    expect(getCacheControlForScope("global", policy)).toEqual({ type: "ephemeral", ttl: "1h", scope: "global" });
    expect(getCacheControlForScope("org", policy)).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(getCacheControlForScope(null, policy)).toBeNull();
    expect(getCacheControlForScope("org", { ttl: "off", ttl_supported: true })).toEqual({ type: "ephemeral" });
  });

  it("emits the scope last, after type and ttl", () => {
    const cc = getCacheControlForScope("global", { ttl: "1h", ttl_supported: true });
    expect(Object.keys(cc)).toEqual(["type", "ttl", "scope"]);
    expect(JSON.stringify(cc)).toBe('{"type":"ephemeral","ttl":"1h","scope":"global"}');
  });

  it("omits the scope when it is refused, keeping type and ttl", () => {
    const policy = { ttl: "1h", ttl_supported: true };
    expect(getCacheControlForScope("global", policy, { scopeRefused: true })).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(getCacheControlForScope("global", policy, { scopeRefused: false })).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    });
    expect(getCacheControlForScope(null, policy, { scopeRefused: true })).toBeNull();
  });

  it("threads cacheScopeRefused into the boundary-mode static block", () => {
    const system = [
      { type: "text", text: "Static half" },
      { type: "text", text: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" },
      { type: "text", text: "Dynamic half" },
    ];
    const signature = {
      promptCompactionMode: "off",
      systemPrompt: LEGACY,
      cachePolicy: { ttl: "1h", ttl_supported: true, boundary_marker: true },
    };

    expect(buildSystemPromptBlocks(system, signature)[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    });
    expect(buildSystemPromptBlocks(system, { ...signature, cacheScopeRefused: true })[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("builds system prompt blocks from a minimal prompt and signature", () => {
    expect(
      buildSystemPromptBlocks([{ type: "text", text: "OpenCode assistant" }], {
        promptCompactionMode: "off",
        systemPrompt: LEGACY,
      }),
    ).toEqual([{ type: "text", text: "Claude Code assistant", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("uses the Claude Code 2.1.195 anti-verbosity heading when opted in", () => {
    const blocks = buildSystemPromptBlocks([{ type: "text", text: "Base prompt" }], {
      promptCompactionMode: "off",
      systemPrompt: LEGACY,
      modelId: "claude-opus-4-6",
      antiVerbosity: { enabled: true },
    });

    // The host blocks are joined onto ONE cache breakpoint before the package
    // sees them, so the anti-verbosity text lands inside the joined block.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.startsWith("Base prompt\n# Text output (does not apply to tool calls)\n")).toBe(true);
  });

  it("does not inject anti-verbosity unless it is explicitly enabled", () => {
    for (const antiVerbosity of [undefined, {}, { enabled: false }]) {
      const blocks = buildSystemPromptBlocks([{ type: "text", text: "Base prompt" }], {
        promptCompactionMode: "off",
        systemPrompt: LEGACY,
        modelId: "claude-opus-4-6",
        ...(antiVerbosity === undefined ? {} : { antiVerbosity }),
      });
      expect(blocks.map((b) => b.text)).toEqual(["Base prompt"]);
    }
  });

  it("never injects the non-native numeric length anchors prompt", () => {
    const blocks = buildSystemPromptBlocks([{ type: "text", text: "Base prompt" }], {
      promptCompactionMode: "off",
      systemPrompt: LEGACY,
      modelId: "claude-opus-4-6",
      antiVerbosity: { enabled: true },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toMatch(/numeric length anchor/i);
  });

  it("places the host cache breakpoint with the resolved ttl", () => {
    const blocks = buildSystemPromptBlocks([{ type: "text", text: "Base prompt" }], {
      promptCompactionMode: "off",
      systemPrompt: LEGACY,
      cachePolicy: { ttl: "5m", ttl_supported: true },
    });

    expect(blocks).toEqual([{ type: "text", text: "Base prompt", cache_control: { type: "ephemeral", ttl: "5m" } }]);
  });

  it("splits static and dynamic halves when the boundary marker is enabled", () => {
    const blocks = buildSystemPromptBlocks(
      [
        { type: "text", text: "Static half" },
        { type: "text", text: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" },
        { type: "text", text: "Dynamic half" },
      ],
      {
        promptCompactionMode: "off",
        systemPrompt: LEGACY,
        cachePolicy: { ttl: "1h", ttl_supported: true, boundary_marker: true },
      },
    );

    expect(blocks).toEqual([
      { type: "text", text: "Static half", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } },
      { type: "text", text: "Dynamic half" },
    ]);
  });

  it("does not treat a trailing -eap- segment as simple-system-prompt eligible", () => {
    expect(isSimpleSystemPromptEligible("claude-sonnet-4-6-eap-preview")).toBe(false);
    expect(isSimpleSystemPromptEligible("claude-sonnet-4-6-eap")).toBe(true);
    expect(isSimpleSystemPromptEligible("claude-sonnet-4-6-eap[1m]")).toBe(true);
  });
});

// --- A realistic host system text, in the order opencode joins it -----------

const CWD = "D:\\git\\opencode-anthropic-fix";
const BASE_PROMPT =
  "You are OpenCode, an interactive CLI tool that helps users. See https://opencode.ai/docs and github.com/anomalyco/opencode";
const envSegment = (date = "Thu Nov 19 2026") =>
  [
    "You are powered by the model named claude-sonnet-5-5. The exact model ID is anthropic/claude-sonnet-5-5",
    "Here is useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${CWD}`,
    `  Workspace root folder: ${CWD}`,
    "  Is directory a git repo: yes",
    "  Platform: win32",
    `  Today's date: ${date}`,
    "</env>",
  ].join("\n");
const GLOBAL_INSTRUCTIONS = [
  "Instructions from: C:\\Users\\x\\.config\\opencode\\AGENTS.md",
  "OpenCode v2 delegates to subagents.",
  "Edit /path/to/opencode-foo and see https://opencode.ai/docs/rules before you start.",
].join("\n");
const PROJECT_INSTRUCTIONS = `Instructions from: ${CWD}\\AGENTS.md\nProject rule: run npm test. OpenCode lives here.`;
const SKILLS = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <name>review</name>",
  "    <description>Review code for OpenCode plugins</description>",
  "  </skill>",
  "</available_skills>",
].join("\n");

const hostText = (date) =>
  [BASE_PROMPT, envSegment(date), GLOBAL_INSTRUCTIONS, PROJECT_INSTRUCTIONS, SKILLS].join("\n");
const rejoin = (text) => {
  const texts = segmentSystemText(text).map((s) => s.text);
  return texts.join("\n");
};
const hostSystem = (date) => [{ type: "text", text: hostText(date) }];
const signature = (overrides = {}) => ({
  promptCompactionMode: "off",
  cachePolicy: { ttl: "1h", ttl_supported: true },
  ...overrides,
});
const countBreakpoints = (blocks) => blocks.filter((b) => b.cache_control !== undefined).length;
const build = (text, overrides) => buildSystemPromptBlocks([{ type: "text", text }], signature(overrides));
const joinedText = (blocks) => blocks.map((b) => b.text).join("\n");
const NO_SPLIT = { systemPrompt: { split_stable_volatile: false } };

describe("segmentSystemText", () => {
  it("recovers the opencode structure and round-trips byte for byte", () => {
    const text = hostText();
    const segments = segmentSystemText(text);

    expect(segments.map((s) => s.kind)).toEqual(["base", "env", "instructions", "instructions", "skills"]);
    expect(segments[2].path).toBe("C:\\Users\\x\\.config\\opencode\\AGENTS.md");
    expect(rejoin(text)).toBe(text);
  });

  it("round-trips arbitrary text, CRLF included", () => {
    for (const text of ["", "\n", "a\r\nb\r\n", `${GLOBAL_INSTRUCTIONS}\n\n\n${SKILLS}\n`, "<env>\nno close"]) {
      expect(rejoin(text)).toBe(text);
    }
  });

  it("does not let a marker inside a closed region start a new segment", () => {
    const text = SKILLS.replace("</available_skills>", "Instructions from: /not/a/file\n</available_skills>");
    expect(segmentSystemText(text).map((s) => s.kind)).toEqual(["skills"]);
  });

  it("marks unmarked opening lines of a later block as other, not base", () => {
    expect(segmentSystemText("extra text", { leading: false })[0].kind).toBe("other");
    expect(segmentSystemText("extra text")[0].kind).toBe("base");
  });
});

describe("sanitizeSystemText — rewrite scope", () => {
  it("rewrites the base prompt prose but never a path or URL token, in any segment", () => {
    const out = sanitizeSystemText(hostText());

    expect(out).toContain("You are Claude Code, an interactive CLI tool that helps users.");
    expect(out).toContain("https://opencode.ai/docs and github.com/anomalyco/opencode");
    // The environment's working directory is untouched.
    expect(out).toContain(`Working directory: ${CWD}`);
    expect(out).toContain(`Workspace root folder: ${CWD}`);
    expect(out).not.toContain("Claude-anthropic-fix");
  });

  it("never touches instruction files: the header line, paths, URLs and prose all survive", () => {
    const out = sanitizeSystemText(hostText());

    expect(out).toContain(GLOBAL_INSTRUCTIONS);
    expect(out).toContain("Instructions from: C:\\Users\\x\\.config\\opencode\\AGENTS.md");
    expect(out).toContain("OpenCode v2 delegates to subagents.");
    expect(out).toContain(PROJECT_INSTRUCTIONS);
    expect(out).toContain(SKILLS);
  });

  it("keeps the legacy rewrite, paths included, under rewrite_scope all", () => {
    const out = sanitizeSystemText(hostText(), { rewriteScope: "all" });

    expect(out).toContain("Working directory: D:\\git\\Claude-anthropic-fix");
    expect(out).toContain("Instructions from: C:\\Users\\x\\.config\\Claude\\AGENTS.md");
    expect(out).toContain("Claude Code v2 delegates to subagents.");
    expect(out).not.toMatch(/opencode/i);
  });

  it("preserves path shapes: drive letters, ~/ ./ ../ and scheme:// tokens", () => {
    const text = "Look at C:\\opencode\\a D:/opencode/b ~/opencode ./opencode ../opencode ftp://opencode.example/x";
    expect(sanitizeSystemText(text)).toBe(text);
    expect(sanitizeSystemText("OpenCode/Claude and opencode")).toBe("OpenCode/Claude and Claude");
  });

  it("no longer cuts text before a mid-text 'You are an interactive' match", () => {
    const text = "Custom prefix that must survive.\nYou are an interactive CLI tool.";
    expect(sanitizeSystemText(text)).toBe(text);
    expect(sanitizeSystemText(text, { rewriteScope: "all" })).toBe(text);
  });

  it("only rewrites the OpenCode env phrasing in host prose, not inside an instruction file", () => {
    const phrase = "Here is some useful information about the environment you are running in:";
    const quoted = `${GLOBAL_INSTRUCTIONS}\n${phrase}\nx`;
    const [block] = normalizeSystemTextBlocks([{ type: "text", text: `${phrase}\n${quoted}` }]);
    const [head, ...rest] = block.text.split("\n");

    expect(head).toBe("Here is useful information about the environment you are running in:");
    expect(rest.join("\n")).toBe(quoted);
  });
});

describe("buildSystemPromptBlocks — genuine opening and empowerment", () => {
  it("opens the host block with the genuine sentence, then the max empowerment package, then the host text", () => {
    const [stable] = buildSystemPromptBlocks(hostSystem(), signature());
    const allBlocks = Object.values(EMPOWERMENT_BLOCKS).join("\n\n");

    expect(GENUINE_OPENING_SENTENCE).toBe(
      "You are an agent working with the user toward their goals, using your own judgment along the way.",
    );
    expect(stable.text.startsWith(`${GENUINE_OPENING_SENTENCE}\n\n${EMPOWERMENT_BLOCKS.ownership}\n\n`)).toBe(true);
    expect(stable.text).toContain(allBlocks);
    expect(stable.text).toContain(`${allBlocks}\n\nYou are Claude Code, an interactive CLI tool`);
  });

  it("places the empowerment before every instruction file, so user instructions keep the last word", () => {
    const [stable, volatile] = buildSystemPromptBlocks(hostSystem(), signature());
    const empowermentEnd = stable.text.indexOf(EMPOWERMENT_BLOCKS.initiative) + EMPOWERMENT_BLOCKS.initiative.length;

    expect(stable.text.indexOf("Instructions from:")).toBeGreaterThan(empowermentEnd);
    expect(volatile.text.indexOf("Instructions from:")).toBeGreaterThan(-1);
    expect(volatile.text).not.toContain(GENUINE_OPENING_SENTENCE);
  });

  it("is byte-stable across builds", () => {
    const first = buildSystemPromptBlocks(hostSystem(), signature());
    const second = buildSystemPromptBlocks(hostSystem(), signature());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("honours the empowerment package and the opening switch", () => {
    const off = buildSystemPromptBlocks(hostSystem(), signature({ systemPrompt: { empowerment: "off" } }));
    expect(off[0].text.startsWith(`${GENUINE_OPENING_SENTENCE}\n\nYou are Claude Code, an interactive`)).toBe(true);
    expect(off[0].text).not.toContain("# Ownership");

    const bareSettings = { empowerment: "off", genuine_opening: false };
    const bare = buildSystemPromptBlocks(hostSystem(), signature({ systemPrompt: bareSettings }));
    expect(bare[0].text.startsWith("You are Claude Code, an interactive")).toBe(true);

    const power = buildSystemPromptBlocks(hostSystem(), signature({ systemPrompt: { empowerment: "power" } }));
    expect(power[0].text).toContain("# Persistence");
    expect(power[0].text).not.toContain("# Proof");
  });

  it("adds nothing to a request with no host system text, and nothing to a title generator", () => {
    expect(buildSystemPromptBlocks([{ type: "text", text: CLAUDE_CODE_IDENTITY_STRING }], signature())).toEqual([]);

    const title = build("You are a title generator. Output a title.");
    expect(title).toHaveLength(1);
    expect(title[0].text).toContain("You are a title generator.");
    expect(title[0].text).not.toContain(GENUINE_OPENING_SENTENCE);
    expect(title[0].text).not.toContain("# Ownership");
  });

  it("puts the opening and empowerment ahead of the single block when the split is off", () => {
    const blocks = buildSystemPromptBlocks(hostSystem(), signature(NO_SPLIT));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.startsWith(`${GENUINE_OPENING_SENTENCE}\n\n# Ownership`)).toBe(true);
    expect(blocks[0].text).toContain("Today's date: Thu Nov 19 2026");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("buildSystemPromptBlocks — stable/volatile split", () => {
  it("produces a stable and a volatile block; only the stable one carries a breakpoint", () => {
    const [stable, volatile, ...extra] = buildSystemPromptBlocks(hostSystem(), signature());

    expect(extra).toEqual([]);
    expect(stable.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(volatile).not.toHaveProperty("cache_control");
    // Never the global scope for user or host content.
    expect(JSON.stringify([stable, volatile])).not.toContain("global");
  });

  it("stays within the 4-breakpoint budget: system 1 + identity 1 + tools 1 + messages 1", () => {
    const blocks = buildSystemPromptBlocks(hostSystem(), signature());
    const identityMarker = 1; // composed by the wire package
    const toolsMarker = 1;
    const messagesMarker = 1;
    expect(countBreakpoints(blocks) + identityMarker + toolsMarker + messagesMarker).toBeLessThanOrEqual(4);
    expect(blocks.some((b) => b.text === CLAUDE_CODE_IDENTITY_STRING)).toBe(false);
  });

  it("classifies by structure: base, global instructions and skills are stable; env and project files volatile", () => {
    const [stable, volatile] = buildSystemPromptBlocks(hostSystem(), signature());

    for (const piece of ["You are Claude Code, an interactive CLI tool", GLOBAL_INSTRUCTIONS, SKILLS]) {
      expect(stable.text).toContain(piece);
      expect(volatile.text).not.toContain(piece);
    }
    for (const piece of [envSegment(), PROJECT_INSTRUCTIONS]) {
      expect(volatile.text).toContain(piece);
      expect(stable.text).not.toContain(piece);
    }
  });

  it("a date change alters only the volatile block's bytes", () => {
    const monday = buildSystemPromptBlocks(hostSystem("Mon Nov 16 2026"), signature());
    const thursday = buildSystemPromptBlocks(hostSystem("Thu Nov 19 2026"), signature());

    expect(thursday[0]).toEqual(monday[0]);
    expect(thursday[1].text).not.toBe(monday[1].text);
    expect(thursday[1].text.replace("Thu Nov 19 2026", "Mon Nov 16 2026")).toBe(monday[1].text);
  });

  it("loses no byte of instruction text: every non-base segment survives, split or not", () => {
    const split = buildSystemPromptBlocks(hostSystem(), signature());
    const joined = joinedText(split);
    const single = joinedText(buildSystemPromptBlocks(hostSystem(), signature(NO_SPLIT)));

    for (const piece of [GLOBAL_INSTRUCTIONS, PROJECT_INSTRUCTIONS, SKILLS, envSegment()]) {
      expect(joined).toContain(piece);
      expect(single).toContain(piece);
    }
    // Same bytes either way, only the order of the segments differs.
    expect([...joined.split("\n")].sort()).toEqual([...single.split("\n")].sort());
  });

  it("keeps instruction text intact with an Instructions-from path and 'OpenCode v2 delegates' inside the file", () => {
    const all = joinedText(buildSystemPromptBlocks(hostSystem(), signature()));
    const header = "Instructions from: C:\\Users\\x\\.config\\opencode\\AGENTS.md";

    expect(all).toContain(`${header}\nOpenCode v2 delegates to subagents.`);
    expect(all).toContain(`Working directory: ${CWD}`);
  });

  it("treats a global file as volatile when it lies inside the announced project root", () => {
    const home = "C:\\Users\\x";
    const env = envSegment().replaceAll(CWD, home);
    const text = [BASE_PROMPT, env, `Instructions from: ${home}\\.claude\\CLAUDE.md\nbody`].join("\n");
    const [stable, volatile] = build(text);

    expect(volatile.text).toContain("Instructions from: C:\\Users\\x\\.claude\\CLAUDE.md");
    expect(stable.text).not.toContain("CLAUDE.md");
  });

  it("treats unknown locations, relative paths and URLs as volatile (doubt means volatile)", () => {
    const unknown = [
      "Instructions from: /etc/team/AGENTS.md\nteam",
      "Instructions from: https://example.com/rules.md\nremote",
      "Instructions from: AGENTS.md\nrelative",
      "Instructions from: C:\\Users\\x\\Documents\\AGENTS.md\ndocs",
      "Instructions from: C:\\Users\\x\\proj\\.claude\\CLAUDE.md\nproject .claude",
    ];
    const [stable, volatile] = build([BASE_PROMPT, ...unknown].join("\n"));

    for (const entry of unknown) {
      expect(volatile.text).toContain(entry);
      expect(stable.text).not.toContain(entry);
    }
  });

  it("recognises the other global config locations", () => {
    const globals = [
      "Instructions from: /home/u/.config/opencode/AGENTS.md\na",
      "Instructions from: /home/u/.claude/CLAUDE.md\nb",
      "Instructions from: C:\\Users\\x\\AppData\\Roaming\\opencode\\AGENTS.md\nc",
      "Instructions from: ~/.config/opencode/AGENTS.md\nd",
    ];
    const [stable, ...rest] = build([BASE_PROMPT, envSegment(), ...globals].join("\n"));

    for (const entry of globals) expect(stable.text).toContain(entry);
    expect(rest).toHaveLength(1);
    expect(rest[0].text).toBe(envSegment());
  });

  it("keeps skills volatile when they mention the project root", () => {
    const location = `    <location>${CWD}\\.claude\\skills\\review</location>`;
    const projectSkills = SKILLS.replace("<name>review</name>", `<name>review</name>\n${location}`);
    const [stable, volatile] = build([BASE_PROMPT, envSegment(), projectSkills].join("\n"));

    expect(volatile.text).toContain(projectSkills);
    expect(stable.text).not.toContain("<available_skills>");
  });

  it("falls back to one marked block when everything is stable, or nothing is", () => {
    const onlyBase = build("Plain host prompt");
    expect(onlyBase).toHaveLength(1);
    expect(onlyBase[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    const noPrefix = { systemPrompt: { genuine_opening: false, empowerment: "off" } };
    const onlyVolatile = build(envSegment(), noPrefix);
    expect(onlyVolatile).toHaveLength(1);
    expect(onlyVolatile[0].text).toBe(envSegment());
    expect(onlyVolatile[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("treats a second host block's unmarked text as volatile and keeps the anti-verbosity text stable", () => {
    const system = [
      { type: "text", text: BASE_PROMPT },
      { type: "text", text: "Extra text from another plugin" },
    ];
    const optIn = signature({ modelId: "claude-opus-4-6", antiVerbosity: { enabled: true } });
    const blocks = buildSystemPromptBlocks(system, optIn);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("# Text output (does not apply to tool calls)");
    expect(blocks[0].text).not.toContain("Extra text from another plugin");
    expect(blocks[1].text).toBe("Extra text from another plugin");
  });

  it("keeps the legacy path redaction when the config selects rewrite_scope all", () => {
    const input = "Working dir: /Users/rmk/projects/opencode-auth";
    const legacy = joinedText(build(input, { systemPrompt: { rewrite_scope: "all" } }));

    expect(legacy).toContain("Working dir: /Users/rmk/projects/Claude-auth");
    expect(legacy).not.toMatch(/opencode/i);
    expect(joinedText(build(input))).toContain(input);
  });

  it("emits no scope on the split block, with or without cacheScopeRefused", () => {
    const refused = buildSystemPromptBlocks(hostSystem(), signature({ cacheScopeRefused: true }));
    expect(refused[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("compactToolDescription — grapheme-safe bullet truncation (U1)", () => {
  it("preserves ASCII output byte-for-byte versus the legacy slice(0, 200) + '...' behavior", () => {
    const bullet = "- " + "a".repeat(300);
    const text = `Intro line.\n${bullet}\nOutro line.`;

    const legacyLine = bullet.slice(0, 200) + "...";
    const result = compactToolDescription(text);
    const resultLine = result.split("\n").find((l) => l.startsWith("- "));

    expect(resultLine).toBe(legacyLine);
    expect(resultLine.length).toBe(203);
  });

  it("excludes an emoji straddling the 200-unit cut whole, instead of splitting its surrogate pair", () => {
    // Bullet marker "- " (2 units) + 197 'a's + GRIN (2 units) + 1 trailing
    // 'a' = 200 content units (satisfies the >=200 regex gate), 202 total
    // line units. The emoji's high surrogate lands at absolute index 199 and
    // its low surrogate at 200 — exactly the shape a bare slice(0, 200)
    // would cut in half.
    const bullet = "- " + "a".repeat(197) + GRIN + "a";
    expect(bullet.length).toBe(202);
    const text = `Intro line.\n${bullet}\nOutro line.`;

    // Negative control: this is what the OLD implementation produced.
    const legacyLine = bullet.slice(0, 200) + "...";
    expect(legacyLine.isWellFormed()).toBe(false);

    const result = compactToolDescription(text);
    const resultLine = result.split("\n").find((l) => l.startsWith("- "));

    expect(resultLine.isWellFormed()).toBe(true);
    expect(resultLine).toBe("- " + "a".repeat(197) + "...");
    expect(resultLine).not.toBe(legacyLine);
    expect(result).toContain("Intro line.");
    expect(result).toContain("Outro line.");
  });

  it("keeps an emoji that fits entirely within the budget intact", () => {
    // Every matched bullet line has at least 202 units (200-char content
    // minimum + the 2-unit marker), so the 200-unit cut always removes some
    // tail. Placing the emoji early and padding the tail with plain 'a's
    // means the cut lands inside the ASCII padding, well past the emoji.
    const bullet = "- " + GRIN + "a".repeat(300);
    const text = `Intro.\n${bullet}\nOutro.`;
    const result = compactToolDescription(text);
    const resultLine = result.split("\n").find((l) => l.startsWith("- "));

    expect(resultLine.isWellFormed()).toBe(true);
    expect(resultLine).toBe("- " + GRIN + "a".repeat(196) + "...");
    expect(resultLine.length).toBe(203);
  });

  it("never emits a lone surrogate for any emoji position around the boundary (199/200/201)", () => {
    for (const padding of [196, 197, 198]) {
      const bullet = "- " + "a".repeat(padding) + GRIN + "a".repeat(200 - padding - 2);
      const text = `Intro.\n${bullet}\nOutro.`;
      const result = compactToolDescription(text);
      const resultLine = result.split("\n").find((l) => l.startsWith("- "));
      expect(resultLine.isWellFormed()).toBe(true);
      expect(resultLine.length).toBeLessThanOrEqual(203);
    }
  });

  it("leaves short text without a >=200-char bullet untouched", () => {
    const short = "Runs the given bash command in a shell.";
    expect(compactToolDescription(short)).toBe(short);
  });
});
