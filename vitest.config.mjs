import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["lib/**/*.mjs", "index.mjs", "cli.mjs"],
      exclude: [
        "**/*.test.mjs",
        "worker/**",
        "scripts/**",
        "docs/**",
        "dist/**",
        "test/**",
        "node_modules/**",
        ".opencode/**",
      ],
      thresholds: {
        "lib/**": {
          statements: 85,
          branches: 75,
        },
        "index.mjs": {
          statements: 56,
          branches: 52,
        },
        "cli.mjs": {
          statements: 69,
          branches: 60,
        },
      },
    },
  },
});
