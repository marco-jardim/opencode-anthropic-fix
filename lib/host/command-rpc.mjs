import { stripVTControlCharacters } from "node:util";
import { redactString } from "../redact.mjs";
import { truncateGraphemes } from "../unicode-text.mjs";

const MAX_ARGUMENT_LENGTH = 8_192;
const MAX_OUTPUT_LENGTH = 65_536;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Portable RPC definition for OpenCode 2.0.21. JSON Schema is a public schema
 * format; Rpc.define() is an identity helper, so no runtime SDK is required.
 * Keep this module importable by both the server and the TUI.
 */
export const anthropicCommandRpc = {
  id: "opencode-anthropic-fix",
  methods: {
    execute: {
      input: {
        type: "object",
        properties: {
          // Core's portable JSON Schema converter rejects regex patterns;
          // validate the identifier's alphabet in the handler instead.
          sessionID: { type: "string", minLength: 1, maxLength: 128 },
          arguments: { type: "string", maxLength: MAX_ARGUMENT_LENGTH },
        },
        required: ["sessionID", "arguments"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { output: { type: "string", maxLength: MAX_OUTPUT_LENGTH } },
        required: ["output"],
        additionalProperties: false,
      },
      errors: {
        command_failed: { type: "null" },
        invalid_session: { type: "null" },
      },
    },
  },
  events: {},
};

/** @param {unknown} input @returns {string} */
export function validateCommandArguments(input) {
  if (typeof input !== "string" || input.length > MAX_ARGUMENT_LENGTH) {
    throw new Error("Anthropic command arguments must be a string of at most 8192 characters.");
  }
  // Commands are a single CLI-style line. Reject control characters without
  // echoing the input: login completion arguments may contain an OAuth code.
  if ([...input].some((character) => character < " " && character !== "\t") || input.includes("\u007f")) {
    throw new Error("Anthropic command arguments must not contain control characters.");
  }
  return input;
}

/**
 * Remove credentials and terminal escape sequences before crossing the RPC/UI
 * boundary. OAuth authorization URLs remain usable; submitted completion codes
 * must not be echoed, even when an upstream error embeds the original input.
 * @param {unknown} value
 * @param {string} [args]
 * @returns {string}
 */
export function sanitizeCommandOutput(value, args = "") {
  let output = stripVTControlCharacters(redactString(value));
  const completion =
    typeof args === "string" ? args.match(/^\s*(?:login|reauth)\s+complete\s+(.+?)\s*$/i)?.[1] : undefined;
  if (completion) {
    const code = completion.replace(/^(["'])(.*)\1$/, "$2");
    for (const secret of new Set([completion, code, code.split("#")[0]])) {
      if (secret) output = output.split(secret).join("[redacted]");
    }
  }
  output = output.replace(
    /(["']?(?:access_?token|refresh_?token|access|refresh|client_secret|code_verifier|authorization_code)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    "$1[redacted]",
  );
  return truncateGraphemes(output, MAX_OUTPUT_LENGTH, { suffix: "\n[output truncated]" });
}

/**
 * Reserve the server-side slash name for clients without the TUI extension.
 * The v2 command API returns no output; running login here would lose its URL
 * and pending-flow instructions. A fixed error directs callers to the RPC and
 * prevents OAuth completion arguments from falling through to a model prompt.
 *
 * @param {{command: {transform: Function}}} context
 * @returns {Promise<{dispose: () => Promise<void>}>}
 */
export function registerAnthropicServerCommand(context) {
  return context.command.transform((editor) => {
    editor.add({
      name: "anthropic",
      description: "Manage Anthropic accounts through the TUI or the plugin RPC",
      async execute() {
        throw new Error(
          "Run /anthropic in the OpenCode TUI, or call the opencode-anthropic-fix RPC execute method. " +
            "The server command API cannot display administrative output.",
        );
      },
    });
  });
}

/**
 * Register the administrative command transport. Session lookup uses the
 * server's scoped API, and no prompt/synthetic/message endpoint is called.
 *
 * @param {{rpc: {register: Function}, session: {get: Function}} context
 * @param {(input: {sessionID: string, arguments: string, signal: AbortSignal}) => Promise<string>} runCommand
 * @returns {Promise<{dispose: () => Promise<void>}>}
 */
export async function registerAnthropicCommandRpc(context, runCommand) {
  let disposed = false;
  const pending = new Set();
  const registration = await context.rpc.register(anthropicCommandRpc, {
    execute: async (input, call) => {
      if (disposed) return call.error("command_failed", "Anthropic command service is closed.", null);
      let args;
      try {
        args = validateCommandArguments(input?.arguments);
      } catch (error) {
        return call.error("command_failed", error.message, null);
      }
      if (typeof input.sessionID !== "string" || !SESSION_ID.test(input.sessionID)) {
        return call.error("invalid_session", "A valid OpenCode session is required.", null);
      }

      const controller = new AbortController();
      const abort = () => controller.abort(call.signal.reason);
      if (call.signal.aborted) abort();
      else call.signal.addEventListener("abort", abort, { once: true });
      pending.add(controller);
      try {
        controller.signal.throwIfAborted();
        const session = await context.session.get({ sessionID: input.sessionID }, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (session?.id !== input.sessionID) {
          return call.error("invalid_session", "The OpenCode session is unavailable.", null);
        }
        const output = await runCommand({ sessionID: input.sessionID, arguments: args, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (typeof output !== "string") {
          return call.error("command_failed", "The Anthropic command returned an invalid response.", null);
        }
        return { output: sanitizeCommandOutput(output, args) };
      } catch (error) {
        if (controller.signal.aborted) {
          return call.error("command_failed", "Anthropic command cancelled.", null);
        }
        return call.error(
          "command_failed",
          sanitizeCommandOutput(error?.message || "Anthropic command failed.", args),
          null,
        );
      } finally {
        pending.delete(controller);
        call.signal.removeEventListener("abort", abort);
      }
    },
  });
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of pending) controller.abort();
      await registration.dispose();
    },
  };
}
