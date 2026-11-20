// Health only means the listener is up. Cold hosts may still be installing
// plugin dependencies; allow that work a separate, bounded initialization window.
export function createHostProbe({
  initializationTimeoutMs = Number(process.env.OPENCODE_HOST_SMOKE_INIT_TIMEOUT_MS ?? 120_000),
  requestTimeoutMs = 30_000,
  fetch: send = globalThis.fetch,
} = {}) {
  if (!Number.isFinite(initializationTimeoutMs) || initializationTimeoutMs <= 0) {
    throw new Error("OPENCODE_HOST_SMOKE_INIT_TIMEOUT_MS must be a positive number");
  }
  const started = Date.now();
  const deadline = started + initializationTimeoutMs;
  return async function probe(name, url, init) {
    let lastError;
    while (Date.now() < deadline) {
      try {
        const response = await send(url, {
          ...init,
          signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(requestTimeoutMs, deadline - Date.now())))),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
        return JSON.parse(text);
      } catch (error) {
        lastError = error;
        // Retry transport timeouts while the host continues dependency setup.
        // A real HTTP/schema failure is not a readiness timeout; report it now.
        if (error.name !== "TimeoutError" && !(error instanceof TypeError)) break;
        const remaining = deadline - Date.now();
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
      }
    }
    throw new Error(
      `Probe ${name} failed after ${Date.now() - started}ms (initialization deadline ${initializationTimeoutMs}ms): ${lastError ?? "deadline exhausted"}`,
      { cause: lastError },
    );
  };
}

// The plugin never adds models: its v2 model transform only updates entries the
// host lists (lib/host/v2.mjs, `editor.update`). The host, however, refreshes its
// own provider catalog in the background (the smoke cannot block that download),
// so the set a location reload lists may legitimately grow between the baseline
// listing and the post-reload listing. A raw count cannot tell that apart from a
// plugin bug, so compare identities: nothing from the baseline may disappear,
// and every added entry is returned for the caller to hold to the same managed
// invariants as the baseline.
export function compareModelInventories(before, after) {
  const beforeIds = new Set(before.map((model) => model.id));
  const afterIds = new Set(after.map((model) => model.id));
  return {
    missing: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
    added: after.filter((model) => !beforeIds.has(model.id)),
  };
}

export function hostLogTail(logs) {
  return logs.trimEnd().split(/\r?\n/).slice(-80).join("\n");
}
