import { describe, it, expect } from "vitest";

import { createOrgAffinityTracker, pickOrgAffinityAccount, stripPriorThinking } from "./org-affinity.mjs";

describe("createOrgAffinityTracker", () => {
  it("returns null for unknown sessions and remembers noted ones", () => {
    const tracker = createOrgAffinityTracker();
    expect(tracker.preferredOrganization("s1")).toBeNull();
    tracker.note("s1", "org-a");
    expect(tracker.preferredOrganization("s1")).toBe("org-a");
    tracker.note("s1", "org-b");
    expect(tracker.preferredOrganization("s1")).toBe("org-b");
  });

  it("ignores empty keys and organizations", () => {
    const tracker = createOrgAffinityTracker();
    tracker.note("", "org-a");
    tracker.note("s1", "");
    expect(tracker.preferredOrganization("")).toBeNull();
    expect(tracker.preferredOrganization("s1")).toBeNull();
  });

  it("evicts the least recently noted session at maxSessions", () => {
    const tracker = createOrgAffinityTracker({ maxSessions: 2 });
    tracker.note("s1", "org-a");
    tracker.note("s2", "org-b");
    tracker.note("s1", "org-a"); // refresh s1; s2 is now oldest
    tracker.note("s3", "org-c");
    expect(tracker.preferredOrganization("s2")).toBeNull();
    expect(tracker.preferredOrganization("s1")).toBe("org-a");
    expect(tracker.preferredOrganization("s3")).toBe("org-c");
  });

  it("falls back to the default bound for invalid maxSessions", () => {
    const tracker = createOrgAffinityTracker({ maxSessions: 0 });
    tracker.note("s1", "org-a");
    expect(tracker.preferredOrganization("s1")).toBe("org-a");
  });

  it("forget removes the entry", () => {
    const tracker = createOrgAffinityTracker();
    tracker.note("s1", "org-a");
    tracker.forget("s1");
    expect(tracker.preferredOrganization("s1")).toBeNull();
    expect(() => tracker.forget("missing")).not.toThrow();
  });
});

describe("pickOrgAffinityAccount", () => {
  const a = { index: 0, organizationUuid: "org-a", enabled: true };
  const b = { index: 1, organizationUuid: "org-b", enabled: true };
  const b2 = { index: 2, organizationUuid: "org-b", enabled: true };
  const accounts = [a, b, b2];

  it("prefers a same-org usable account", () => {
    expect(pickOrgAffinityAccount({ accounts, preferredOrg: "org-b", current: a, isUsable: () => true })).toBe(b);
  });

  it("skips unusable same-org accounts", () => {
    const picked = pickOrgAffinityAccount({
      accounts,
      preferredOrg: "org-b",
      current: a,
      isUsable: (acc) => acc.index !== 1,
    });
    expect(picked).toBe(b2);
  });

  it("keeps the current account when it is already in the org", () => {
    expect(pickOrgAffinityAccount({ accounts, preferredOrg: "org-b", current: b2, isUsable: () => true })).toBe(b2);
  });

  it("returns null when no same-org account is usable", () => {
    expect(pickOrgAffinityAccount({ accounts, preferredOrg: "org-b", current: a, isUsable: () => false })).toBeNull();
    expect(pickOrgAffinityAccount({ accounts, preferredOrg: "org-z", current: a, isUsable: () => true })).toBeNull();
  });

  it("returns null without a preferred organization", () => {
    expect(pickOrgAffinityAccount({ accounts, preferredOrg: null, current: a })).toBeNull();
  });
});

describe("stripPriorThinking", () => {
  const think = (text) => ({ type: "thinking", thinking: text, signature: "sig" });
  const redacted = { type: "redacted_thinking", data: "x" };
  const text = (t) => ({ type: "text", text: t });

  it("strips earlier assistant thinking and keeps the latest intact", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [think("one"), redacted, text("a1")] },
      { role: "user", content: [text("more")] },
      { role: "assistant", content: [think("two"), text("a2")] },
    ];
    const out = stripPriorThinking(messages);
    expect(out).toHaveLength(4);
    expect(out[1].content).toEqual([text("a1")]);
    expect(out[3].content).toEqual([think("two"), text("a2")]);
  });

  it("does not mutate its input", () => {
    const messages = [
      { role: "assistant", content: [think("one"), text("a1")] },
      { role: "user", content: "next" },
      { role: "assistant", content: [think("two"), text("a2")] },
    ];
    const snapshot = structuredClone(messages);
    const out = stripPriorThinking(messages);
    expect(messages).toEqual(snapshot);
    expect(out).not.toBe(messages);
    expect(out[0]).not.toBe(messages[0]);
  });

  it("drops an assistant message only when stripping empties it", () => {
    const messages = [
      { role: "assistant", content: [think("only")] },
      { role: "user", content: "next" },
      { role: "assistant", content: [text("latest")] },
    ];
    const out = stripPriorThinking(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("leaves string content and non-assistant messages alone", () => {
    const messages = [
      { role: "user", content: [think("odd")] },
      { role: "assistant", content: "plain" },
      { role: "assistant", content: [text("latest")] },
    ];
    const out = stripPriorThinking(messages);
    expect(out).toEqual(messages);
  });

  it("handles empty input", () => {
    expect(stripPriorThinking([])).toEqual([]);
  });
});
