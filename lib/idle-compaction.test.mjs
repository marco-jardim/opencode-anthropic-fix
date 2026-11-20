import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_COMPACT_FRACTION,
  IDLE_COMPACT_MAX_LATE_MS,
  computeIdleCompactionDeadline,
  createIdleCompactionScheduler,
  resolveIdleCompactMinTokens,
  shouldIdleCompact,
} from "./idle-compaction.mjs";

const HOUR = 3_600_000;

describe("computeIdleCompactionDeadline", () => {
  it("is 0.9 x the one-hour cache life after the last activity", () => {
    expect(IDLE_COMPACT_FRACTION).toBe(0.9);
    expect(computeIdleCompactionDeadline({ lastActivityAt: 1_000, ttl: "1h" })).toBe(1_000 + 0.9 * HOUR);
  });

  it("is null unless the TTL is exactly 1h", () => {
    expect(computeIdleCompactionDeadline({ lastActivityAt: 1_000, ttl: "5m" })).toBeNull();
    expect(computeIdleCompactionDeadline({ lastActivityAt: 1_000, ttl: undefined })).toBeNull();
    expect(computeIdleCompactionDeadline({ lastActivityAt: Number.NaN, ttl: "1h" })).toBeNull();
  });
});

describe("resolveIdleCompactMinTokens", () => {
  it("defaults to 200000", () => {
    expect(resolveIdleCompactMinTokens({ env: {} })).toBe(200_000);
  });

  it("prefers the env value over the configured one", () => {
    const env = { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "300000" };
    expect(resolveIdleCompactMinTokens({ env, configured: 250_000 })).toBe(300_000);
    expect(resolveIdleCompactMinTokens({ env: {}, configured: 250_000 })).toBe(250_000);
  });

  it("floors the result at 100000, whichever source set it", () => {
    const env = { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "5" };
    expect(resolveIdleCompactMinTokens({ env, configured: 500_000 })).toBe(100_000);
    expect(resolveIdleCompactMinTokens({ env: {}, configured: 1 })).toBe(100_000);
  });

  it("ignores malformed or non-positive env values", () => {
    for (const value of ["abc", "", "-5", "0"]) {
      const env = { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: value };
      expect(resolveIdleCompactMinTokens({ env, configured: 400_000 })).toBe(400_000);
    }
  });
});

describe("shouldIdleCompact", () => {
  const ok = { now: 5_000_000, deadline: 5_000_000, estimatedTokens: 250_000, minTokens: 200_000 };

  it("fires on time with a big enough context", () => {
    expect(shouldIdleCompact(ok)).toBe(true);
    expect(shouldIdleCompact({ ...ok, estimatedTokens: 200_000 })).toBe(true);
  });

  it("refuses a timer that fired more than 60 s late, accepts one exactly 60 s late", () => {
    expect(IDLE_COMPACT_MAX_LATE_MS).toBe(60_000);
    expect(shouldIdleCompact({ ...ok, now: ok.deadline + 60_000 })).toBe(true);
    expect(shouldIdleCompact({ ...ok, now: ok.deadline + 60_001 })).toBe(false);
  });

  it("refuses when usage is limited, the context is small or there is no deadline", () => {
    expect(shouldIdleCompact({ ...ok, usageLimited: true })).toBe(false);
    expect(shouldIdleCompact({ ...ok, estimatedTokens: 199_999 })).toBe(false);
    expect(shouldIdleCompact({ ...ok, deadline: null })).toBe(false);
    expect(shouldIdleCompact({ ...ok, estimatedTokens: Number.NaN })).toBe(false);
  });
});

describe("createIdleCompactionScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const onFire = vi.fn();
    const scheduler = createIdleCompactionScheduler({ onFire, now: () => Date.now() });
    return { onFire, scheduler };
  }

  it("fires once at 0.9 x the TTL after the last activity, with the firing details", () => {
    const { onFire, scheduler } = setup();
    const context = { lastActivityAt: Date.now(), ttl: "1h", estimatedTokens: 300_000, modelID: "m" };

    expect(scheduler.arm("s1", context)).toBe(true);
    expect(scheduler.pending).toBe(1);

    vi.advanceTimersByTime(0.9 * HOUR - 1);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onFire).toHaveBeenCalledTimes(1);
    const [key, fire] = onFire.mock.calls[0];
    expect(key).toBe("s1");
    const deadline = 1_000_000 + 0.9 * HOUR;
    expect(fire).toMatchObject({ deadline, firedAt: deadline, lateMs: 0, late: false });
    expect(fire.context).toBe(context);
    expect(scheduler.pending).toBe(0);
  });

  it("does not arm for a 5m cache and clears a previous timer for the key", () => {
    const { onFire, scheduler } = setup();
    scheduler.arm("s1", { lastActivityAt: Date.now(), ttl: "1h" });
    expect(scheduler.arm("s1", { lastActivityAt: Date.now(), ttl: "5m" })).toBe(false);
    expect(scheduler.pending).toBe(0);
    vi.advanceTimersByTime(2 * HOUR);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("re-arming replaces the timer: only the latest deadline fires", () => {
    const { onFire, scheduler } = setup();
    scheduler.arm("s1", { lastActivityAt: Date.now(), ttl: "1h" });
    vi.advanceTimersByTime(0.5 * HOUR);
    scheduler.arm("s1", { lastActivityAt: Date.now(), ttl: "1h" });
    vi.advanceTimersByTime(0.9 * HOUR - 1);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("cancel stops one key and leaves the others", () => {
    const { onFire, scheduler } = setup();
    scheduler.arm("a", { lastActivityAt: Date.now(), ttl: "1h" });
    scheduler.arm("b", { lastActivityAt: Date.now(), ttl: "1h" });
    expect(scheduler.cancel("a")).toBe(true);
    expect(scheduler.cancel("a")).toBe(false);
    vi.advanceTimersByTime(HOUR);
    expect(onFire.mock.calls.map(([key]) => key)).toEqual(["b"]);
  });

  it("dispose clears every timer and refuses further arming", () => {
    const { onFire, scheduler } = setup();
    scheduler.arm("a", { lastActivityAt: Date.now(), ttl: "1h" });
    scheduler.arm("b", { lastActivityAt: Date.now(), ttl: "1h" });
    scheduler.dispose();
    expect(scheduler.pending).toBe(0);
    expect(scheduler.arm("c", { lastActivityAt: Date.now(), ttl: "1h" })).toBe(false);
    vi.advanceTimersByTime(2 * HOUR);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("reports a late fire (the machine slept) so the host can refuse it", () => {
    const { onFire, scheduler } = setup();
    scheduler.arm("s1", { lastActivityAt: Date.now(), ttl: "1h" });
    // The clock jumps well past the deadline before the timer callback runs.
    vi.setSystemTime(1_000_000 + 0.9 * HOUR + 5 * 60_000);
    vi.advanceTimersByTime(0.9 * HOUR);

    const [, fire] = onFire.mock.calls[0];
    expect(fire.late).toBe(true);
    expect(fire.lateMs).toBeGreaterThan(IDLE_COMPACT_MAX_LATE_MS);
    const { firedAt: now, deadline } = fire;
    expect(shouldIdleCompact({ now, deadline, estimatedTokens: 999_999, minTokens: 1 })).toBe(false);
  });

  it("unrefs its timers so a pending compaction never keeps the process alive", () => {
    const unref = vi.fn();
    const clear = vi.fn();
    const scheduler = createIdleCompactionScheduler({
      onFire: () => {},
      now: () => 0,
      setTimeout: () => ({ unref }),
      clearTimeout: clear,
    });
    scheduler.arm("s1", { lastActivityAt: 0, ttl: "1h" });
    expect(unref).toHaveBeenCalledTimes(1);
    scheduler.cancel("s1");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing or rejecting onFire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const throwing = createIdleCompactionScheduler({
      onFire: () => {
        throw new Error("boom");
      },
    });
    const rejecting = createIdleCompactionScheduler({ onFire: () => Promise.reject(new Error("nope")) });
    throwing.arm("a", { lastActivityAt: 0, ttl: "1h" });
    rejecting.arm("a", { lastActivityAt: 0, ttl: "1h" });
    expect(() => vi.advanceTimersByTime(HOUR)).not.toThrow();
    await Promise.resolve();
  });
});
