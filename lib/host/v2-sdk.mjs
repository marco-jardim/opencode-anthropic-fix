// OpenCode's built-in dynamic SDK hook runs before external plugin hooks.
// Its file:// loader uses this shipped, pinned factory without an npm install.
// Keep this a separate entry in the standalone package as well.
export { createAnthropic } from "@ai-sdk/anthropic";
