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

export function hostLogTail(logs) {
  return logs.trimEnd().split(/\r?\n/).slice(-80).join("\n");
}
