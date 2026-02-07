import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: "module",
      globals: {
        // Node.js globals
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        globalThis: "readonly",
        structuredClone: "readonly",
        btoa: "readonly",
        atob: "readonly",
        crypto: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      // Relax for our codebase style
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off", // CLI tool — console is expected
      "no-constant-condition": ["error", { checkLoops: false }], // while(true) is intentional
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"], // allow == null
    },
  },
  {
    // Test files get additional globals from vitest
    files: ["**/*.test.mjs"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        vi: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
    rules: {
      // Tests often have unused vars from destructuring mocks
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", ".mitm/"],
  },
];
