import { describe, it, expect } from "vitest";
import { getState, transition, nextRetryState, isTerminal } from "../src/state.mjs";
import { STATES, MAX_RETRIES } from "../src/types.mjs";

/** Simple in-memory KV mock */
function makeKV() {
  const store = new Map();
  return {
    async get(key, _opts) {
      return store.get(key) ?? null;
    },
    async put(key, value, _opts) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe("getState", () => {
  it("returns null for unknown version", async () => {
    const kv = makeKV();
    expect(await getState(kv, "9.9.9")).toBeNull();
  });

  it("returns stored state record", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    const record = await getState(kv, "2.1.91");
    expect(record).not.toBeNull();
    expect(record.state).toBe(STATES.DETECTED);
    expect(record.version).toBe("2.1.91");
  });
});

describe("transition", () => {
  it("IDLE → DETECTED: creates record with state DETECTED", async () => {
    const kv = makeKV();
    const record = await transition(kv, "2.1.91", STATES.DETECTED);
    expect(record.state).toBe(STATES.DETECTED);
    expect(record.retries).toBe(0);
    expect(record.version).toBe("2.1.91");
    expect(record.createdAt).toBeTruthy();
  });

  it("DETECTED → PR_CREATED on trivial diff", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    const record = await transition(kv, "2.1.91", STATES.PR_CREATED, {
      prNumber: 42,
      branchName: "auto/sync-2.1.91",
    });
    expect(record.state).toBe(STATES.PR_CREATED);
    expect(record.prNumber).toBe(42);
    expect(record.branchName).toBe("auto/sync-2.1.91");
  });

  it("DETECTED → ANALYZING on non-trivial diff", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    const record = await transition(kv, "2.1.91", STATES.ANALYZING);
    expect(record.state).toBe(STATES.ANALYZING);
  });

  it("ANALYZING → ISSUE_CREATED", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    await transition(kv, "2.1.91", STATES.ANALYZING);
    const record = await transition(kv, "2.1.91", STATES.ISSUE_CREATED, {
      issueNumber: 7,
    });
    expect(record.state).toBe(STATES.ISSUE_CREATED);
    expect(record.issueNumber).toBe(7);
  });

  it("PR_CREATED → DELIVERED", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    await transition(kv, "2.1.91", STATES.PR_CREATED);
    const record = await transition(kv, "2.1.91", STATES.DELIVERED);
    expect(record.state).toBe(STATES.DELIVERED);
  });

  it("ISSUE_CREATED → DELIVERED", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    await transition(kv, "2.1.91", STATES.ANALYZING);
    await transition(kv, "2.1.91", STATES.ISSUE_CREATED);
    const record = await transition(kv, "2.1.91", STATES.DELIVERED);
    expect(record.state).toBe(STATES.DELIVERED);
  });

  it("any state → FAILED_RETRYABLE: increments retry counter", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    const record = await transition(kv, "2.1.91", STATES.FAILED_RETRYABLE, {
      error: "GitHub 500",
    });
    expect(record.state).toBe(STATES.FAILED_RETRYABLE);
    expect(record.retries).toBe(1);
    expect(record.error).toBe("GitHub 500");
  });

  it("FAILED_RETRYABLE → DETECTED (retry)", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    await transition(kv, "2.1.91", STATES.FAILED_RETRYABLE);
    const record = await transition(kv, "2.1.91", STATES.DETECTED);
    expect(record.state).toBe(STATES.DETECTED);
    // Retry count should be preserved (1)
    expect(record.retries).toBe(1);
  });

  it("FAILED_RETRYABLE → DEAD_LETTER after max retries", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);

    // Simulate MAX_RETRIES failures
    for (let i = 0; i < MAX_RETRIES; i++) {
      await transition(kv, "2.1.91", STATES.FAILED_RETRYABLE);
      const next = nextRetryState(await getState(kv, "2.1.91"));
      if (next === STATES.DEAD_LETTER) {
        await transition(kv, "2.1.91", STATES.DEAD_LETTER);
        break;
      }
      await transition(kv, "2.1.91", STATES.DETECTED);
    }

    const final = await getState(kv, "2.1.91");
    expect(final.state).toBe(STATES.DEAD_LETTER);
  });

  it("throws on invalid transition IDLE → PR_CREATED", async () => {
    const kv = makeKV();
    await expect(transition(kv, "2.1.91", STATES.PR_CREATED)).rejects.toThrow("Invalid state transition");
  });

  it("throws on invalid transition DELIVERED → DETECTED", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    await transition(kv, "2.1.91", STATES.PR_CREATED);
    await transition(kv, "2.1.91", STATES.DELIVERED);
    await expect(transition(kv, "2.1.91", STATES.DETECTED)).rejects.toThrow("Invalid state transition");
  });

  it("idempotent: transitioning to same state returns existing record", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    const r1 = await transition(kv, "2.1.91", STATES.DETECTED);
    const r2 = await transition(kv, "2.1.91", STATES.DETECTED);
    expect(r1.state).toBe(STATES.DETECTED);
    expect(r2.state).toBe(STATES.DETECTED);
    // Should not have incremented retries
    expect(r2.retries).toBe(0);
  });

  it("preserves prNumber and branchName through subsequent transitions", async () => {
    const kv = makeKV();
    await transition(kv, "2.1.91", STATES.DETECTED);
    await transition(kv, "2.1.91", STATES.PR_CREATED, {
      prNumber: 99,
      branchName: "auto/sync-2.1.91",
    });
    const record = await transition(kv, "2.1.91", STATES.DELIVERED);
    expect(record.prNumber).toBe(99);
    expect(record.branchName).toBe("auto/sync-2.1.91");
  });
});

describe("nextRetryState", () => {
  it("returns DETECTED when retries < MAX_RETRIES", () => {
    const record = { retries: 0, state: STATES.FAILED_RETRYABLE };
    expect(nextRetryState(record)).toBe(STATES.DETECTED);
  });

  it("returns DETECTED at MAX_RETRIES - 1", () => {
    const record = { retries: MAX_RETRIES - 1, state: STATES.FAILED_RETRYABLE };
    expect(nextRetryState(record)).toBe(STATES.DETECTED);
  });

  it("returns DEAD_LETTER when retries === MAX_RETRIES", () => {
    const record = { retries: MAX_RETRIES, state: STATES.FAILED_RETRYABLE };
    expect(nextRetryState(record)).toBe(STATES.DEAD_LETTER);
  });

  it("returns DEAD_LETTER when retries > MAX_RETRIES", () => {
    const record = { retries: MAX_RETRIES + 5, state: STATES.FAILED_RETRYABLE };
    expect(nextRetryState(record)).toBe(STATES.DEAD_LETTER);
  });
});

describe("isTerminal", () => {
  it("DELIVERED is terminal", () => {
    expect(isTerminal(STATES.DELIVERED)).toBe(true);
  });

  it("DEAD_LETTER is terminal", () => {
    expect(isTerminal(STATES.DEAD_LETTER)).toBe(true);
  });

  it("IDLE is not terminal", () => {
    expect(isTerminal(STATES.IDLE)).toBe(false);
  });

  it("DETECTED is not terminal", () => {
    expect(isTerminal(STATES.DETECTED)).toBe(false);
  });

  it("FAILED_RETRYABLE is not terminal", () => {
    expect(isTerminal(STATES.FAILED_RETRYABLE)).toBe(false);
  });
});
