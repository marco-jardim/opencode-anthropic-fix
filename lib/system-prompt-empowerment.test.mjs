import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, EMPOWERMENT_BLOCK_IDS, EMPOWERMENT_PACKAGES } from "./config.mjs";
import {
  DEFAULT_EMPOWERMENT,
  DEFAULT_SYSTEM_PROMPT_SETTINGS,
  EMPOWERMENT_BLOCKS,
  buildEmpowermentText,
  resolveEmpowermentBlockIds,
  resolveSystemPromptSettings,
} from "./system-prompt-empowerment.mjs";

describe("empowerment blocks", () => {
  it("has exactly one text per config block id, each starting with its own heading", () => {
    expect(Object.keys(EMPOWERMENT_BLOCKS).sort()).toEqual([...EMPOWERMENT_BLOCK_IDS].sort());
    for (const text of Object.values(EMPOWERMENT_BLOCKS)) {
      expect(text.startsWith("# ")).toBe(true);
      expect(text.split("\n")).toHaveLength(2);
    }
  });

  it("is byte-stable: no dates, ids or paths in any block", () => {
    const all = Object.values(EMPOWERMENT_BLOCKS).join("\n\n");
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(all).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    expect(buildEmpowermentText("max")).toBe(buildEmpowermentText("max"));
  });

  it("keeps the verbatim texts of the plan (spot checks on the opening and closing sentences)", () => {
    expect(EMPOWERMENT_BLOCKS.ownership).toBe(
      "# Ownership\nTreat the user's goal as yours. When intent is clear, act: make reasonable assumptions, state them in one line, and proceed. Don't ask permission for reversible, in-scope steps (reading, searching, running tests, drafting). Stop and ask only when a step is destructive or hard to reverse, when plausible interpretations differ in effort by 2x or more, or when critical information is missing. User and project instructions override this section.",
    );
    expect(EMPOWERMENT_BLOCKS.initiative).toBe(
      "# Initiative\nIf you notice a bug, risk or better approach outside the immediate request, flag it in one line at the end; don't act on it unless asked. Point out a wrong assumption in the request before executing on it.",
    );
    expect(EMPOWERMENT_BLOCKS.tool_power.startsWith("# Tool power-usage\nBatch independent tool calls")).toBe(true);
    expect(EMPOWERMENT_BLOCKS.research.startsWith("# Research context\nThe user is a software maintainer")).toBe(true);
  });
});

describe("resolveEmpowermentBlockIds", () => {
  it("expands the named packages from the config definition", () => {
    expect(resolveEmpowermentBlockIds("off")).toEqual([]);
    expect(resolveEmpowermentBlockIds("power")).toEqual([
      "ownership",
      "depth",
      "persistence",
      "recommendations",
      "context_economy",
      "initiative",
    ]);
    expect(resolveEmpowermentBlockIds("research")).toEqual([...EMPOWERMENT_PACKAGES.power, "research"]);
    expect(resolveEmpowermentBlockIds("max")).toEqual([...EMPOWERMENT_BLOCK_IDS]);
    expect(resolveEmpowermentBlockIds("max")).toHaveLength(10);
  });

  it("defaults to max when unset, unknown or of the wrong type", () => {
    expect(DEFAULT_EMPOWERMENT).toBe("max");
    for (const value of [undefined, null, "nonsense", 7, {}, "__proto__", "constructor"]) {
      expect(resolveEmpowermentBlockIds(value)).toEqual([...EMPOWERMENT_BLOCK_IDS]);
    }
  });

  it("accepts an array of ids in the given order, drops unknown ids and duplicates", () => {
    expect(resolveEmpowermentBlockIds(["proof", "ownership", "bogus", " Depth ", "proof", 3])).toEqual([
      "proof",
      "ownership",
      "depth",
    ]);
    expect(resolveEmpowermentBlockIds([])).toEqual([]);
    expect(resolveEmpowermentBlockIds(["bogus"])).toEqual([]);
  });

  it("returns a copy: mutating the result never alters the shared package", () => {
    const ids = resolveEmpowermentBlockIds("power");
    ids.push("proof");
    expect(EMPOWERMENT_PACKAGES.power).not.toContain("proof");
  });
});

describe("buildEmpowermentText", () => {
  it("joins the selected blocks with a blank line, in package order", () => {
    expect(buildEmpowermentText(["depth", "proof"])).toBe(`${EMPOWERMENT_BLOCKS.depth}\n\n${EMPOWERMENT_BLOCKS.proof}`);
  });

  it("is empty for off and for an array with no known id", () => {
    expect(buildEmpowermentText("off")).toBe("");
    expect(buildEmpowermentText(["nope"])).toBe("");
  });

  it("max contains all ten headings, power omits proof, research and communication", () => {
    const max = buildEmpowermentText("max");
    for (const text of Object.values(EMPOWERMENT_BLOCKS)) expect(max).toContain(text);
    const power = buildEmpowermentText("power");
    expect(power).not.toContain(EMPOWERMENT_BLOCKS.proof);
    expect(power).not.toContain(EMPOWERMENT_BLOCKS.research);
    expect(power).not.toContain(EMPOWERMENT_BLOCKS.communication);
    expect(buildEmpowermentText("research")).toContain(EMPOWERMENT_BLOCKS.research);
  });
});

describe("resolveSystemPromptSettings", () => {
  it("mirrors DEFAULT_CONFIG.system_prompt so the two can never drift", () => {
    expect({ ...DEFAULT_SYSTEM_PROMPT_SETTINGS }).toEqual(DEFAULT_CONFIG.system_prompt);
    expect(resolveSystemPromptSettings(undefined)).toEqual(DEFAULT_CONFIG.system_prompt);
  });

  it("keeps valid members and falls back per member for the rest", () => {
    expect(
      resolveSystemPromptSettings({
        empowerment: "power",
        genuine_opening: false,
        split_stable_volatile: "yes",
        rewrite_scope: "everywhere",
      }),
    ).toEqual({ empowerment: "power", genuine_opening: false, split_stable_volatile: true, rewrite_scope: "base" });
    expect(resolveSystemPromptSettings({ rewrite_scope: "all" }).rewrite_scope).toBe("all");
    expect(resolveSystemPromptSettings(null)).toEqual(DEFAULT_CONFIG.system_prompt);
  });
});
