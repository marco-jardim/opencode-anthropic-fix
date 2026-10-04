import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Strips OAuth environment variables so a developer's or CI runner's shell
    // cannot change what the suite exercises. See test/setup-env.mjs.
    setupFiles: ["./test/setup-env.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["lib/**/*.mjs", "index.mjs", "cli.mjs"],
      exclude: ["**/*.test.mjs", "scripts/**", "docs/**", "dist/**", "test/**", "node_modules/**", ".opencode/**"],
      thresholds: {
        // Glob thresholds overlap, so explicitly keep the extracted entry out
        // of the library aggregate (without excluding it from instrumentation).
        "lib/**/!(runtime).mjs": {
          statements: 85,
          branches: 75,
        },
        "lib/host/runtime.mjs": {
          statements: 50,
          branches: 47,
        },
        "index.mjs": {
          statements: 90,
          branches: 90,
        },
        "cli.mjs": {
          statements: 70,
          branches: 61,
        },
      },
    },
  },
});
