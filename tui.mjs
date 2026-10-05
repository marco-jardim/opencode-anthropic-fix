import { anthropicCommandRpc, sanitizeCommandOutput, validateCommandArguments } from "./lib/host/command-rpc.mjs";

/**
 * V1 keeps its existing server slash-command hook. V2 consumes setup(), while
 * modern v1 consumes tui(); neither path loads a different host's SDK.
 */
export default {
  id: "opencode-anthropic-fix",
  async tui() {
    // The v1 server already owns /anthropic and its noReply presentation.
  },
  setup(context) {
    const rpc = context.client.rpc(anthropicCommandRpc);
    const pending = new Set();
    let disposed = false;
    let creatingSession;

    async function sessionForCommand(signal) {
      const route = context.ui.router.current();
      if (route.type === "session") return route.sessionID;
      // The home screen has no session yet. Creating an empty session provides
      // stable state for two-step OAuth without creating a model prompt.
      creatingSession ??= context.client.session.create({ location: context.location }, { signal }).finally(() => {
        creatingSession = undefined;
      });
      const session = await creatingSession;
      signal.throwIfAborted();
      if (!session?.id) throw new Error("OpenCode could not create a session for the Anthropic command.");
      context.ui.router.navigate({ type: "session", sessionID: session.id });
      return session.id;
    }

    const commandLayer = () => ({
      enabled: () => !disposed,
      commands: [
        {
          id: "anthropic.manage",
          title: "Manage Anthropic accounts",
          description: "Authentication, account selection, usage and configuration",
          group: "Anthropic",
          palette: true,
          slash: { name: "anthropic", arguments: true },
          async run(input = "") {
            if (disposed) return;
            const controller = new AbortController();
            pending.add(controller);
            try {
              const args = validateCommandArguments(input);
              const sessionID = await sessionForCommand(controller.signal);
              const result = await rpc.execute(
                { sessionID, arguments: args },
                { signal: controller.signal, location: context.location },
              );
              if (disposed || controller.signal.aborted) return;
              if (typeof result?.output !== "string") throw new Error("Invalid Anthropic command response.");
              await context.ui.dialog.alert({
                title: "Anthropic",
                message: sanitizeCommandOutput(result.output, args) || "Command completed.",
              });
            } catch (error) {
              if (disposed || controller.signal.aborted) return;
              context.ui.toast.show({
                title: "Anthropic",
                variant: "error",
                message: sanitizeCommandOutput(error?.message || "Anthropic command failed.", input),
              });
            } finally {
              pending.delete(controller);
            }
          },
        },
      ],
    });

    // OpenCode 2.0.21/2.0.22 calls setup outside the Solid provider owner.
    // Register from the app slot so Keymap.Provider is available and the
    // layer's reactive lifetime follows the mounted plugin contribution.
    const removeSlot = context.ui.slot({
      append: "app",
      render() {
        if (disposed) return null;
        context.keymap.layer(commandLayer);
        return null;
      },
    });

    return () => {
      disposed = true;
      removeSlot();
      for (const controller of pending) controller.abort();
    };
  },
};
