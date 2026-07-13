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
          statements: 50,
          branches: 47,
        },
        "cli.mjs": {
          statements: 70,
          branches: 61,
        },
      },
    },
  },
});
