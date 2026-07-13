import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { AnthropicAuthPlugin } from "../index.mjs";
import { loadAccounts } from "../lib/storage.mjs";

export async function runLiveProbe() {
  if (process.env.RUN_LIVE_PROBE !== "1") {
    return { skipped: true, reason: "RUN_LIVE_PROBE is not set" };
  }

  try {
    const stored = await loadAccounts();
    const account = stored?.accounts[stored.activeIndex];
    const access = account?.access;
    const refresh = account?.refreshToken;
    const expires = account?.expires;

    if (!access || !refresh) {
      return { skipped: true, reason: "no OAuth account configured" };
    }

    const client = {
      auth: { set() {} },
      session: {},
      tui: { showToast() {} },
    };
    const provider = {
      models: {
        "claude-haiku-4-5": {
          id: "claude-haiku-4-5",
          cost: { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
          limit: { context: 200_000, output: 32_000 },
        },
      },
    };
    const plugin = await AnthropicAuthPlugin({ client });
    const getAuth = async () => ({ type: "oauth", access, refresh, expires });
    const { fetch: fetchFn } = await plugin.auth.loader(getAuth, provider);

    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    let sample;
    try {
      sample = (await response.text()).slice(0, 500);
    } catch (error) {
      sample = `response body unavailable: ${String(error)}`;
    }

    return { skipped: false, status: response.status, ok: response.ok, sample };
  } catch (error) {
    return { skipped: true, reason: String(error) };
  }
}

const isCliEntry = process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url));

if (isCliEntry) {
  runLiveProbe().then((result) => {
    console.log(JSON.stringify(result));
    process.exit(result.skipped ? 0 : result.status === 200 ? 0 : 1);
  });
}
