import { expect, it } from "vitest";
import picomatch from "picomatch";
import { glob } from "tinyglobby";
import config from "../../vitest.config.mjs";

it("instruments runtime separately without diluting the library coverage baseline", async () => {
  const { coverage } = config.test;
  const runtime = "lib/host/runtime.mjs";
  const libraryPattern = "lib/**/!(runtime).mjs";
  expect(coverage.thresholds[libraryPattern]).toEqual({ statements: 85, branches: 75 });
  expect(coverage.thresholds[runtime]).toEqual({ statements: 50, branches: 47 });
  expect(coverage.thresholds["index.mjs"]).toEqual({ statements: 90, branches: 90 });
  expect(picomatch(coverage.include)(runtime)).toBe(true);
  expect(picomatch(coverage.exclude)(runtime)).toBe(false);
  for (const file of await glob("lib/**/*.mjs", { ignore: ["**/*.test.mjs"] })) {
    expect(picomatch(libraryPattern)(file), file).toBe(file !== runtime);
  }
});
