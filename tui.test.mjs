import { describe, it, expect, vi } from "vitest";
import plugin from "./tui.mjs";
import { anthropicCommandRpc } from "./lib/host/command-rpc.mjs";

function harness() {
  let layer;
  const execute = vi.fn().mockResolvedValue({ output: "Account ready" });
  const context = {
    location: { type: "local", directory: "/project" },
    client: {
      rpc: vi.fn(() => ({ execute })),
      session: {
        create: vi.fn().mockResolvedValue({ id: "ses_new" }),
        prompt: vi.fn(() => {
          throw new Error("Unexpected model request");
        }),
        synthetic: vi.fn(() => {
          throw new Error("Unexpected transcript write");
        }),
        command: vi.fn(() => {
          throw new Error("TUI command must use RPC, not server slash dispatch");
        }),
      },
    },
    keymap: {
      layer: vi.fn((get) => {
        layer = get();
      }),
    },
    ui: {
      router: {
        current: vi.fn(() => ({ type: "session", sessionID: "ses_current" })),
        navigate: vi.fn(),
      },
      dialog: { alert: vi.fn().mockResolvedValue(undefined) },
      toast: { show: vi.fn() },
    },
  };
  const dispose = plugin.setup(context);
  return { context, execute, layer, dispose, command: layer.commands[0] };
}

describe("dual TUI entry", () => {
  it("leaves v1 slash-command handling to the existing server hook", async () => {
    expect(plugin.id).toBe("opencode-anthropic-fix");
    const context = { client: {}, keymap: {} };
    await expect(plugin.tui(context)).resolves.toBeUndefined();
  });

  it("registers an argument-taking slash command and displays RPC output without a model call", async () => {
    const test = harness();
    expect(test.command.slash).toEqual({ name: "anthropic", arguments: true });
    await test.command.run("usage");
    expect(test.context.client.rpc).toHaveBeenCalledWith(anthropicCommandRpc);
    expect(test.execute).toHaveBeenCalledWith(
      { sessionID: "ses_current", arguments: "usage" },
      { signal: expect.any(AbortSignal), location: test.context.location },
    );
    expect(test.context.ui.dialog.alert).toHaveBeenCalledWith({ title: "Anthropic", message: "Account ready" });
    expect(test.context.client.session.prompt).not.toHaveBeenCalled();
    expect(test.context.client.session.synthetic).not.toHaveBeenCalled();
    expect(test.context.client.session.command).not.toHaveBeenCalled();
  });

  it("creates only an empty session for a command on the home screen", async () => {
    const test = harness();
    test.context.ui.router.current.mockReturnValue({ type: "home" });
    await test.command.run("login");
    expect(test.context.client.session.create).toHaveBeenCalledWith(
      { location: test.context.location },
      { signal: expect.any(AbortSignal) },
    );
    expect(test.context.ui.router.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "ses_new" });
    expect(test.execute.mock.calls[0][0]).toEqual({ sessionID: "ses_new", arguments: "login" });
    expect(test.context.client.session.prompt).not.toHaveBeenCalled();
  });

  it("redacts OAuth completion codes in transport errors before showing a toast", async () => {
    const test = harness();
    test.execute.mockRejectedValue({ message: "Cannot complete oauth-secret#state-123" });
    await test.command.run("login complete oauth-secret#state-123");
    expect(test.context.ui.toast.show).toHaveBeenCalledWith({
      title: "Anthropic",
      variant: "error",
      message: "Cannot complete [redacted]",
    });
    expect(test.context.ui.dialog.alert).not.toHaveBeenCalled();
    expect(test.context.client.session.prompt).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments locally before creating a session or making an RPC request", async () => {
    const test = harness();
    await test.command.run("usage\nlogin");
    expect(test.context.ui.toast.show).toHaveBeenCalled();
    expect(test.context.client.session.create).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("cancels in-flight RPC on cleanup and suppresses output after unload", async () => {
    const test = harness();
    let finish;
    const response = new Promise((resolve) => {
      finish = resolve;
    });
    let start;
    const started = new Promise((resolve) => {
      start = resolve;
    });
    test.execute.mockImplementation(() => {
      start();
      return response;
    });
    const running = test.command.run("usage");
    await started;
    test.dispose();
    expect(test.execute.mock.calls[0][1].signal.aborted).toBe(true);
    finish({ output: "Late output" });
    await running;
    expect(test.layer.enabled()).toBe(false);
    expect(test.context.ui.dialog.alert).not.toHaveBeenCalled();
    expect(test.context.ui.toast.show).not.toHaveBeenCalled();
    await test.command.run("usage");
    expect(test.execute).toHaveBeenCalledTimes(1);
  });
});
