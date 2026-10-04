import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostProbe, hostLogTail } from "./host-smoke-probes.mjs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("host smoke initialization probes", () => {
  it("retries a cold host beyond 30 seconds while keeping per-request deadlines", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        throw new globalThis.DOMException("cold dependency cache", "TimeoutError");
      })
      .mockResolvedValue(new Response('{"ready":true}'));
    const pending = createHostProbe({ fetch: send })("/config", "http://host/config");
    const result = expect(pending).resolves.toEqual({ ready: true });
    // Attach immediately so negative controls also report an assertion rather
    // than an unrelated unhandled rejection while the clock advances.
    result.catch(() => {});
    await vi.advanceTimersByTimeAsync(30_200);
    await result;
    expect(send).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
  });

  it("honors the configurable total deadline and names the failing probe and elapsed time", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCODE_HOST_SMOKE_INIT_TIMEOUT_MS", "35000");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const send = vi.fn(async () => {
      const ms = timeout.mock.calls.at(-1)[0];
      await new Promise((resolve) => setTimeout(resolve, ms));
      throw new globalThis.DOMException("still initializing", "TimeoutError");
    });
    const pending = createHostProbe({ fetch: send })("/provider/auth", "http://host/provider/auth");
    const rejected = expect(pending).rejects.toThrow(
      "Probe /provider/auth failed after 35000ms (initialization deadline 35000ms)",
    );
    await vi.advanceTimersByTimeAsync(35000);
    await rejected;
    expect(timeout.mock.calls).toEqual([[30000], [4800]]);
  });

  it("reports HTTP failures without hiding them behind initialization retries", async () => {
    const send = vi.fn().mockResolvedValue(new Response("broken plugin", { status: 500 }));
    await expect(createHostProbe({ fetch: send })("/command", "http://host/command")).rejects.toThrow(
      "HTTP 500: broken plugin",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("prints only the last 80 captured stdout/stderr log lines", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `log ${index}`);
    expect(hostLogTail(lines.join("\r\n") + "\r\n")).toBe(lines.slice(20).join("\n"));
  });
});
