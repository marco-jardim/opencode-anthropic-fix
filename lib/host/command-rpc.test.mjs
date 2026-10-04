import { describe, it, expect, vi } from "vitest";
import { Schema, SchemaRepresentation } from "effect";
import {
  anthropicCommandRpc,
  registerAnthropicCommandRpc,
  registerAnthropicServerCommand,
  sanitizeCommandOutput,
  validateCommandArguments,
} from "./command-rpc.mjs";

const sessionID = "ses_test";

async function harness(runCommand = vi.fn().mockResolvedValue("Account ready")) {
  let handlers;
  const registration = { dispose: vi.fn().mockResolvedValue(undefined) };
  const context = {
    rpc: {
      register: vi.fn(async (_definition, next) => {
        handlers = next;
        return registration;
      }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ id: sessionID }),
      prompt: vi.fn(() => {
        throw new Error("Administrative commands must never prompt the model");
      }),
      synthetic: vi.fn(() => {
        throw new Error("Administrative output must never enter the transcript");
      }),
    },
  };
  const rpc = await registerAnthropicCommandRpc(context, runCommand);
  const controller = new AbortController();
  const call = { signal: controller.signal, error: (type, message, data) => ({ type, message, data }) };
  return { context, registration, handlers, rpc, controller, call, runCommand };
}

describe("Anthropic command RPC", () => {
  it("compiles its portable schema with the host's real Effect JSON Schema converter", () => {
    const input = SchemaRepresentation.fromJsonSchemaDocument({
      dialect: "draft-2020-12",
      schema: anthropicCommandRpc.methods.execute.input,
      definitions: {},
    });
    const output = SchemaRepresentation.fromJsonSchemaDocument({
      dialect: "draft-2020-12",
      schema: anthropicCommandRpc.methods.execute.output,
      definitions: {},
    });
    expect(Schema.decodeUnknownSync(input)({ sessionID, arguments: "usage" })).toEqual({
      sessionID,
      arguments: "usage",
    });
    expect(Schema.decodeUnknownSync(output)({ output: "ok" })).toEqual({ output: "ok" });
    expect(() => Schema.decodeUnknownSync(input)({ sessionID, arguments: 42 })).toThrow();
  });

  it("executes the local command after validating its session, without a model or transcript write", async () => {
    const test = await harness();
    expect(test.context.rpc.register).toHaveBeenCalledWith(anthropicCommandRpc, expect.any(Object));
    expect(await test.handlers.execute({ sessionID, arguments: "usage" }, test.call)).toEqual({
      output: "Account ready",
    });
    expect(test.context.session.get).toHaveBeenCalledWith({ sessionID }, { signal: expect.any(AbortSignal) });
    expect(test.runCommand).toHaveBeenCalledWith({ sessionID, arguments: "usage", signal: expect.any(AbortSignal) });
    expect(test.context.session.prompt).not.toHaveBeenCalled();
    expect(test.context.session.synthetic).not.toHaveBeenCalled();
  });

  it.each([null, 42, "a".repeat(8193), "usage\nlogin", "usage\u0000"])(
    "rejects invalid command arguments before executing (%s)",
    async (args) => {
      const test = await harness();
      const result = await test.handlers.execute({ sessionID, arguments: args }, test.call);
      expect(result.type).toBe("command_failed");
      expect(test.runCommand).not.toHaveBeenCalled();
      expect(test.context.session.get).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid or unavailable session before invoking the CLI", async () => {
    const test = await harness();
    expect((await test.handlers.execute({ sessionID: "../private", arguments: "usage" }, test.call)).type).toBe(
      "invalid_session",
    );
    test.context.session.get.mockResolvedValue({ id: "ses_other" });
    expect((await test.handlers.execute({ sessionID, arguments: "usage" }, test.call)).type).toBe("invalid_session");
    expect(test.runCommand).not.toHaveBeenCalled();
  });

  it("sanitizes successful output and command errors including unlabelled OAuth completion codes", async () => {
    const run = vi.fn().mockResolvedValue("Authorization: Bearer secret-token\naccessToken: opaque-access");
    const test = await harness(run);
    const result = await test.handlers.execute({ sessionID, arguments: "usage" }, test.call);
    expect(result.output).not.toContain("secret-token");
    expect(result.output).not.toContain("opaque-access");
    run.mockRejectedValue(new Error("Cannot exchange short-secret#state-123 (short-secret)"));
    const error = await test.handlers.execute(
      { sessionID, arguments: "login complete short-secret#state-123" },
      test.call,
    );
    expect(error.type).toBe("command_failed");
    expect(error.message).not.toContain("short-secret");
  });

  it("does not serialize invalid command return values", async () => {
    const test = await harness(vi.fn().mockResolvedValue({ accessToken: "opaque-secret" }));
    const result = await test.handlers.execute({ sessionID, arguments: "usage" }, test.call);
    expect(result.type).toBe("command_failed");
    expect(JSON.stringify(result)).not.toContain("opaque-secret");
  });

  it("passes cancellation to the executor and disposes in-flight work once", async () => {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const run = vi.fn(({ signal }) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const test = await harness(run);
    const executing = test.handlers.execute({ sessionID, arguments: "usage" }, test.call);
    await ready;
    await test.rpc.dispose();
    await test.rpc.dispose();
    expect(await executing).toMatchObject({ type: "command_failed", message: "Anthropic command cancelled." });
    expect(run.mock.calls[0][0].signal.aborted).toBe(true);
    expect(test.registration.dispose).toHaveBeenCalledTimes(1);
    expect((await test.handlers.execute({ sessionID, arguments: "usage" }, test.call)).type).toBe("command_failed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-cancelled call before reading session state", async () => {
    const test = await harness();
    test.controller.abort();
    expect((await test.handlers.execute({ sessionID, arguments: "usage" }, test.call)).message).toBe(
      "Anthropic command cancelled.",
    );
    expect(test.context.session.get).not.toHaveBeenCalled();
    expect(test.runCommand).not.toHaveBeenCalled();
  });

  it("relays client cancellation before starting the executor", async () => {
    const test = await harness();
    test.context.session.get.mockImplementation(async (_input, { signal }) => {
      test.controller.abort();
      expect(signal.aborted).toBe(true);
      return { id: sessionID };
    });
    expect((await test.handlers.execute({ sessionID, arguments: "usage" }, test.call)).message).toBe(
      "Anthropic command cancelled.",
    );
    expect(test.runCommand).not.toHaveBeenCalled();
  });
});

describe("command output boundary", () => {
  it.each([
    '"login" complete short-secret#state-123',
    "'reauth' complete short-secret#state-123",
    'login "complete" "short-secret#state-123"',
    "reauth 'complete' 'short-secret#state-123'",
    '"login" "complete" "https://example.test/callback?code=short%2Dsecret&state=state-123"',
    "'reauth' 'complete' 'https://example.test/callback?code=short-secret&state=state-123'",
  ])("redacts parsed OAuth completion credentials in %s", (args) => {
    const result = sanitizeCommandOutput(`Cannot exchange short-secret#state-123 (short-secret); ${args}`, args);
    expect(result).not.toContain("short-secret");
    expect(result).not.toContain("short%2Dsecret");
  });

  it("retains authorization URLs and quoted CLI arguments", () => {
    const url = "https://claude.ai/oauth/authorize?state=state123&code_challenge=pkce123";
    expect(sanitizeCommandOutput(url)).toBe(url);
    expect(validateCommandArguments('set label "Personal account"')).toBe('set label "Personal account"');
  });

  it("strips ANSI controls and masks credentials with no dependency on token prefixes", () => {
    const result = sanitizeCommandOutput('\u001b[31mrefresh_token="secret"\u001b[0m\ncode_verifier: opaque');
    expect(result).toBe("refresh_token=[redacted]\ncode_verifier: [redacted]");
    expect(sanitizeCommandOutput('{"access":"opaque-token","refresh":"opaque-refresh"}')).toBe(
      '{"access":[redacted],"refresh":[redacted]}',
    );
  });

  it("bounds output without splitting graphemes", () => {
    const result = sanitizeCommandOutput("a".repeat(65_510) + "👩🏽‍💻".repeat(20));
    expect(result.length).toBeLessThanOrEqual(65_536);
    expect(result.endsWith("\n[output truncated]")).toBe(true);
    expect(result).not.toMatch(/[\ud800-\udbff]$/u);
  });
});

describe("server slash-command reservation", () => {
  it("reserves /anthropic and fails with fixed RPC guidance without echoing prompt arguments", async () => {
    let command;
    const registration = { dispose: vi.fn() };
    const context = {
      command: {
        transform: vi.fn(async (edit) => {
          edit({
            add: (definition) => {
              command = definition;
            },
          });
          return registration;
        }),
      },
      session: { prompt: vi.fn(), synthetic: vi.fn() },
    };
    expect(await registerAnthropicServerCommand(context)).toBe(registration);
    expect(command.name).toBe("anthropic");
    await expect(command.execute({ sessionID, prompt: { text: "login complete private-code#state" } })).rejects.toThrow(
      "call the opencode-anthropic-fix RPC execute method",
    );
    expect(context.session.prompt).not.toHaveBeenCalled();
    expect(context.session.synthetic).not.toHaveBeenCalled();
  });
});
