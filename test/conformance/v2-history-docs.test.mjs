import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each(["opencode-v2.md", "opencode-v2-architecture.md"])(
  "%s describes native checkpoint re-expansion rather than requiring a new session",
  (name) => {
    // packages/core/src/session/history.ts@v2.0.21:23-26,99-107 filters
    // incompatible checkpoints; the original transcript remains available.
    const document = readFileSync(new URL(`../../docs/${name}`, import.meta.url), "utf8");
    expect(document).toMatch(/re-expands the\s+original transcript/);
    expect(document).toMatch(/new session\s+is not required/);
    expect(document).toMatch(/context (?:may|can) grow substantially/);
  },
);
