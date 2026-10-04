import { describe, expect, it } from "vitest";
import { parseCommandArgs } from "./command-args.mjs";

describe("shared slash command tokenizer", () => {
  it.each(["", " \t "])("returns no tokens for blank input %s", (raw) => {
    expect(parseCommandArgs(raw)).toEqual([]);
  });
  it("handles whitespace, both quote styles, and escaped quotes and backslashes", () => {
    expect(parseCommandArgs('a b "c d"')).toEqual(["a", "b", "c d"]);
    expect(parseCommandArgs("a 'c d'")).toEqual(["a", "c d"]);
    expect(parseCommandArgs(String.raw`"login" 'complete' "code\"quote\\slash"`)).toEqual([
      "login",
      "complete",
      'code"quote\\slash',
    ]);
  });
});
