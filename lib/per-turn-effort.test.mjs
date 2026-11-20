import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TRACKED_SESSIONS,
  applyPerTurnEffort,
  resetPerTurnEffortState,
  trackedPerTurnEffortSessions,
} from "./per-turn-effort.mjs";
import { transformRequestBody } from "./mimicry/request-body.mjs";
import { buildAdapterTransport } from "./mimicry/adapter-input.mjs";
import {
  WIRE_PROFILE,
  buildWireCompatibleCountTokensRequest,
  buildWireCompatibleRequest,
  supportsPerTurnEffortWire,
} from "./mimicry/wire-compat.mjs";

const PER_TURN_BETA = "per-turn-control-2026-07-01";
const CAPABLE_MODEL = "claude-opus-5-5";
const INCAPABLE_MODEL = "claude-opus-4-8";
const SETTINGS = { enabled: true, auto_low_short_questions: true, short_question_max_chars: 280 };

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const control = (effort) => ({ role: "system", content: [], output_config: { effort } });
const LONG = `${"This is a longer request that spells out the task in detail. ".repeat(6)}Thanks.`;

/** Serialized messages without the cache markers that legitimately move each turn. */
const stripMarkers = (messages) =>
  JSON.stringify(messages, (key, value) => (key === "cache_control" ? undefined : value));

/** Roles of a conversation with a short question followed by a long one. */
const SHORT_THEN_LONG = ["user", "assistant", "system", "user", "assistant", "system", "user"];

let sessionCounter = 0;
const freshSession = () => {
  sessionCounter += 1;
  return `per-turn-${sessionCounter}`;
};

beforeEach(() => {
  resetPerTurnEffortState();
});

afterEach(() => {
  resetPerTurnEffortState();
});

function apply(messages, overrides = {}) {
  return applyPerTurnEffort({
    messages,
    sessionKey: "s",
    model: CAPABLE_MODEL,
    effort: "medium",
    settings: SETTINGS,
    capable: true,
    ...overrides,
  });
}

describe("applyPerTurnEffort — turn decisions", () => {
  it("leaves the first turn alone, even a short one: it establishes the base effort", () => {
    const messages = [user("hi")];
    const result = apply(messages);
    expect(result.active).toBe(true);
    expect(result.messages).toEqual(messages);
    expect(result.effort).toBe("medium");
  });

  it("puts a low control right before a short question and returns to the base after it", () => {
    apply([user(LONG)]);
    const second = apply([user(LONG), assistant("done"), user("what does this do?")]);
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(second.messages[2]).toEqual(control("low"));

    const third = apply([...second.messages.filter((m) => m.role !== "system"), assistant("it does X"), user(LONG)]);
    expect(third.messages.map((m) => m.role)).toEqual(SHORT_THEN_LONG);
    expect(third.messages[2]).toEqual(control("low"));
    expect(third.messages[5]).toEqual(control("medium"));
    expect(third.effort).toBe("medium");
  });

  it("keeps a short question low for the rest of its tool loop, with no new control", () => {
    apply([user(LONG)]);
    const question = [user(LONG), assistant("done"), user("what does this do?")];
    const first = apply(question);
    const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] };
    const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] };
    const next = apply([...question, toolUse, toolResult]);
    expect(next.messages.filter((m) => m.role === "system")).toEqual([control("low")]);
    expect(stripMarkers(next.messages.slice(0, first.messages.length))).toBe(stripMarkers(first.messages));
  });

  it("never auto-lows a tool-result turn", () => {
    const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] };
    const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
    apply([user(LONG)]);
    const result = apply([user(LONG), toolUse, toolResult]);
    expect(result.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("does not insert before an interrupted tool call the orphan repair will fold into the turn", () => {
    const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] };
    apply([user(LONG)]);
    const result = apply([user(LONG), toolUse, user("never mind")]);
    expect(result.messages.some((m) => m.role === "system")).toBe(false);
  });

  it.each([
    ["a code fence", user("why does ```x``` fail?")],
    ["an image", { role: "user", content: [...user("what is this?").content, { type: "image", source: {} }] }],
    ["more than the maximum length", user("x".repeat(281))],
  ])("does not auto-low a question with %s", (_name, question) => {
    apply([user(LONG)]);
    const result = apply([user(LONG), assistant("ok"), question]);
    expect(result.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("auto-lows a question exactly at the maximum length", () => {
    apply([user(LONG)]);
    const result = apply([user(LONG), assistant("ok"), user("x".repeat(280))]);
    expect(result.messages.filter((m) => m.role === "system")).toEqual([control("low")]);
  });

  it("honours a configured maximum length and a disabled auto-low", () => {
    apply([user(LONG)], { sessionKey: "a" });
    const small = apply([user(LONG), assistant("ok"), user("x".repeat(60))], {
      sessionKey: "a",
      settings: { ...SETTINGS, short_question_max_chars: 40 },
    });
    expect(small.messages.some((m) => m.role === "system")).toBe(false);

    apply([user(LONG)], { sessionKey: "b" });
    const off = apply([user(LONG), assistant("ok"), user("short?")], {
      sessionKey: "b",
      settings: { ...SETTINGS, auto_low_short_questions: false },
    });
    expect(off.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("ignores a router-state tail for typing, length and identity", () => {
    const tail = { type: "text", text: "<router-state>\nmode: x\n</router-state>" };
    apply([user(LONG)]);
    const withTail = [user(LONG), assistant("ok"), { role: "user", content: [{ type: "text", text: "short?" }, tail] }];
    const first = apply(withTail);
    expect(first.messages.filter((m) => m.role === "system")).toEqual([control("low")]);
    // The tail is never persisted: the same turn without it is the same turn.
    const again = apply([user(LONG), assistant("ok"), user("short?"), assistant("a"), user(LONG)]);
    expect(again.messages[2]).toEqual(control("low"));
    expect(again.messages.filter((m) => m.role === "system")).toHaveLength(2);
  });

  it("expresses a host effort change as a control and keeps the base", () => {
    apply([user(LONG)], { effort: "medium" });
    const switched = apply([user(LONG), assistant("ok"), user(LONG)], { effort: "high" });
    expect(switched.effort).toBe("medium");
    expect(switched.messages[2]).toEqual(control("high"));

    // Still high on the next turn: already in force, nothing to say.
    const earlier = switched.messages.filter((m) => m.role !== "system");
    const stay = apply([...earlier, assistant("a"), user(LONG)], { effort: "high" });
    expect(stay.messages.filter((m) => m.role === "system")).toEqual([control("high")]);

    // Back to the base: the return is a control too.
    const history = stay.messages.filter((m) => m.role !== "system");
    const back = apply([...history, assistant("b"), user(`${LONG} again`)], { effort: "medium" });
    expect(back.messages.filter((m) => m.role === "system")).toEqual([control("high"), control("medium")]);
    expect(back.effort).toBe("medium");
  });

  it("attaches the statement to a system entry that already sits right before the turn", () => {
    apply([user(LONG)]);
    const host = { role: "system", content: [] };
    const result = apply([user(LONG), assistant("ok"), host, user("short?")]);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(result.messages[2]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
    expect(host).toEqual({ role: "system", content: [] });
  });

  it("starts over when the conversation's first message changes (cleared or compacted)", () => {
    apply([user(LONG)], { effort: "medium" });
    const fresh = apply([user("A different conversation entirely")], { effort: "high" });
    expect(fresh.effort).toBe("high");
    expect(fresh.messages).toHaveLength(1);
  });

  it("starts over when the model changes", () => {
    apply([user(LONG)], { effort: "medium" });
    const other = apply([user(LONG)], { effort: "high", model: "claude-fable-5-1" });
    expect(other.effort).toBe("high");
  });

  it("assumes the base for turns it never saw (a restart mid-conversation)", () => {
    const result = apply([user("first"), assistant("a"), user(LONG), assistant("b"), user(LONG)]);
    expect(result.messages.some((m) => m.role === "system")).toBe(false);
  });
});

describe("applyPerTurnEffort — off switches", () => {
  const conversation = [user(LONG), assistant("ok"), user("short?")];

  it.each([
    ["disabled by config", { settings: { ...SETTINGS, enabled: false } }],
    ["missing config", { settings: undefined }],
    ["a model without the capability", { capable: false }],
    ["an unknown effort", { effort: "turbo" }],
  ])("does nothing with %s", (_name, overrides) => {
    const result = apply(conversation, overrides);
    expect(result.active).toBe(false);
    expect(result.messages).toBe(conversation);
  });

  it("does nothing for an empty conversation or one without a typed turn", () => {
    expect(apply([]).active).toBe(false);
    expect(apply([assistant("only")]).active).toBe(false);
  });
});

describe("applyPerTurnEffort — memory", () => {
  it("bounds the remembered sessions", () => {
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 10; i++) apply([user(LONG)], { sessionKey: `bounded-${i}` });
    expect(trackedPerTurnEffortSessions()).toBe(MAX_TRACKED_SESSIONS);
  });

  it("keeps a recently used session when evicting", () => {
    apply([user(LONG)], { sessionKey: "keep", effort: "high" });
    for (let i = 0; i < MAX_TRACKED_SESSIONS - 1; i++) apply([user(LONG)], { sessionKey: `fill-${i}` });
    apply([user(LONG)], { sessionKey: "keep", effort: "high" });
    apply([user(LONG)], { sessionKey: "one-more" });
    // Still remembered: the base stays high although the host now says medium.
    const kept = apply([user(LONG), assistant("a"), user(LONG)], { sessionKey: "keep", effort: "medium" });
    expect(kept.effort).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// transformRequestBody integration
// ---------------------------------------------------------------------------

const RUNTIME_BASE = {
  turns: 1,
  usedTools: new Set(),
  tokenEconomySession: null,
  cacheBoundaryStability: new Map(),
  persistentUserId: "d",
  accountId: "a",
  sessionId: "s",
};

const ADAPTER_SIGNATURE = {
  enabled: true,
  useAdapter: true,
  claudeCliVersion: WIRE_PROFILE.cliVersion,
  promptCompactionMode: "minimal",
  cachePolicy: { ttl: "1h", ttl_supported: true },
};

function request(messages, { sessionKey, model = CAPABLE_MODEL, hostEffort, config, signature, runtime } = {}) {
  const body = {
    model,
    max_tokens: 8000,
    system: [{ type: "text", text: "You are opencode" }],
    messages,
    ...(hostEffort === undefined ? {} : { output_config: { effort: hostEffort } }),
  };
  const out = transformRequestBody(
    JSON.stringify(body),
    signature ?? ADAPTER_SIGNATURE,
    { ...RUNTIME_BASE, sessionKey, ...runtime },
    false,
    config ?? { per_turn_effort: SETTINGS },
  );
  return JSON.parse(out);
}

describe("transformRequestBody — per-turn effort", () => {
  it("first turn: no control message and the default effort at the top level", () => {
    const parsed = request([user("hi")], { sessionKey: freshSession() });
    expect(parsed.messages.map((m) => m.role)).toEqual(["user"]);
    expect(parsed.output_config).toEqual({ effort: "medium" });
  });

  it("short question gets a low control, the next long one returns to medium, the prefix is byte-stable", () => {
    const sessionKey = freshSession();
    const u1 = user(LONG);
    const a1 = assistant("done");
    const u2 = user("what does that do?");
    const a2 = assistant("it does X");
    const u3 = user(LONG);
    const a3 = assistant("ok");
    const u4 = user("and this one?");

    const r1 = request([u1], { sessionKey });
    const r2 = request([u1, a1, u2], { sessionKey });
    const r3 = request([u1, a1, u2, a2, u3], { sessionKey });
    const r4 = request([u1, a1, u2, a2, u3, a3, u4], { sessionKey });

    expect(r1.messages.map((m) => m.role)).toEqual(["user"]);
    expect(r2.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(r2.messages[2]).toEqual(control("low"));
    expect(r3.messages.map((m) => m.role)).toEqual(SHORT_THEN_LONG);
    expect(r3.messages[2]).toEqual(control("low"));
    expect(r3.messages[5]).toEqual(control("medium"));
    expect(r4.messages.filter((m) => m.role === "system")).toEqual([control("low"), control("medium"), control("low")]);

    // The top-level effort never moves, and thinking is whatever the request had.
    for (const parsed of [r1, r2, r3, r4]) expect(parsed.output_config).toEqual({ effort: "medium" });
    for (const parsed of [r1, r2, r3, r4]) expect(parsed.thinking).toEqual({ type: "adaptive" });

    // CACHE SAFETY: everything a request carried is, byte for byte, the prefix of
    // the next request (cache markers aside: they move to the newest user turn).
    const chain = [r1, r2, r3, r4].map((parsed) => parsed.messages);
    for (let i = 0; i < chain.length - 1; i++) {
      const earlier = chain[i];
      const later = chain[i + 1];
      expect(stripMarkers(later.slice(0, earlier.length))).toBe(stripMarkers(earlier));
    }
    // And the serialized request up to the newest user turn matches what the
    // feature-off conversation carries, once the control entries are removed.
    const off = request([u1, a1, u2, a2, u3, a3, u4], {
      sessionKey: freshSession(),
      config: { per_turn_effort: { ...SETTINGS, enabled: false } },
    });
    expect(stripMarkers(r4.messages.filter((m) => m.role !== "system"))).toBe(stripMarkers(off.messages));
    expect(r4.system).toEqual(off.system);
  });

  it("a host effort change mid-session becomes a control; the top-level effort does not move", () => {
    const sessionKey = freshSession();
    const u1 = user(LONG);
    const a1 = assistant("done");
    const u2 = user(`${LONG} second`);
    const a2 = assistant("ok");
    const u3 = user(`${LONG} third`);

    const r1 = request([u1], { sessionKey, hostEffort: "medium" });
    const r2 = request([u1, a1, u2], { sessionKey, hostEffort: "high" });
    const r3 = request([u1, a1, u2, a2, u3], { sessionKey, hostEffort: "high" });

    expect(r1.output_config.effort).toBe("medium");
    expect(r2.output_config.effort).toBe("medium");
    expect(r3.output_config.effort).toBe("medium");
    expect(r2.messages[2]).toEqual(control("high"));
    expect(r3.messages.filter((m) => m.role === "system")).toEqual([control("high")]);
  });

  it("a tool-result turn never triggers auto-low", () => {
    const sessionKey = freshSession();
    const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }] };
    const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] };
    request([user(LONG)], { sessionKey });
    const parsed = request([user(LONG), toolUse, toolResult], { sessionKey });
    expect(parsed.messages.some((m) => m.role === "system")).toBe(false);
  });

  it.each([
    ["disabled by config", CAPABLE_MODEL, { per_turn_effort: { ...SETTINGS, enabled: false } }],
    ["no per_turn_effort block", CAPABLE_MODEL, {}],
    ["a model without the capability", INCAPABLE_MODEL, { per_turn_effort: SETTINGS }],
  ])("adds no control message with %s", (_name, model, config) => {
    const sessionKey = freshSession();
    request([user(LONG)], { sessionKey, model, config });
    const parsed = request([user(LONG), assistant("ok"), user("short?")], { sessionKey, model, config });
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("adds none off the adapter path, for a subagent, or on a non-main role", () => {
    const messages = [user(LONG), assistant("ok"), user("short?")];
    for (const options of [
      { signature: { ...ADAPTER_SIGNATURE, useAdapter: false } },
      { runtime: { isSubagent: true } },
      { runtime: { requestRole: "title" } },
    ]) {
      const sessionKey = freshSession();
      request([user(LONG)], { sessionKey, ...options });
      const parsed = request(messages, { sessionKey, ...options });
      expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    }
  });

  it("the control message carries no cache_control and the breakpoint stays on the last user message", () => {
    const sessionKey = freshSession();
    request([user(LONG)], { sessionKey });
    const parsed = request([user(LONG), assistant("ok"), user("short?")], { sessionKey });
    const marked = [];
    parsed.messages.forEach((message, index) => {
      const blocks = Array.isArray(message.content) ? message.content : [];
      if (blocks.some((block) => block.cache_control)) marked.push(index);
    });
    expect(marked).toEqual([3]);
    expect(parsed.messages[2]).toEqual(control("low"));
    expect(JSON.stringify(parsed.messages[2])).not.toContain("cache_control");
  });

  it("the cache breakpoint survives a router-state tail next to a control message", () => {
    const sessionKey = freshSession();
    const tail = { type: "text", text: "<router-state>\nmode: x\n</router-state>" };
    request([user(LONG)], { sessionKey });
    const question = { role: "user", content: [{ type: "text", text: "short?" }, tail] };
    const parsed = request([user(LONG), assistant("ok"), question], { sessionKey });
    expect(parsed.messages[2]).toEqual(control("low"));
    expect(parsed.messages[3].content[0].cache_control).toBeDefined();
    expect(parsed.messages[3].content[1].cache_control).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The library builds the request
// ---------------------------------------------------------------------------

async function buildThroughLibrary(transformedBody) {
  const state = {
    input: undefined,
    requestInit: {},
    accessToken: "host-access-token",
    requestUrl: new URL("https://api.anthropic.com/v1/messages"),
    provider: "anthropic",
    clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    signature: {
      enabled: true,
      claudeCliVersion: WIRE_PROFILE.cliVersion,
      customBetas: [],
      strategy: "default",
      sessionId: "11111111-1111-4111-8111-111111111111",
    },
    identity: { persistentUserId: "2".repeat(64), accountId: "33333333-3333-4333-8333-333333333333" },
    adaptiveOverride: undefined,
    tokenEconomy: {},
    body: transformedBody,
    env: {},
    platform: "win32",
    arch: "x64",
    nodeVersion: "v22.11.0",
  };
  const result = buildAdapterTransport(state);
  if (!result.applicable) throw new Error(`adapter declined: ${result.reason}`);
  return { result, built: await buildWireCompatibleRequest(transformedBody, result.transport), state };
}

function transformedBody(messages, model, sessionKey) {
  return transformRequestBody(
    JSON.stringify({ model, max_tokens: 8000, system: [{ type: "text", text: "You are opencode" }], messages }),
    ADAPTER_SIGNATURE,
    { ...RUNTIME_BASE, sessionKey },
    false,
    { per_turn_effort: SETTINGS },
  );
}

describe("per-turn effort through the wire library", () => {
  it("the library validates the control messages and composes the per-turn beta", async () => {
    expect(supportsPerTurnEffortWire(CAPABLE_MODEL)).toBe(true);
    const sessionKey = freshSession();
    transformedBody([user(LONG)], CAPABLE_MODEL, sessionKey);
    const body = transformedBody([user(LONG), assistant("ok"), user("short?")], CAPABLE_MODEL, sessionKey);

    const { built } = await buildThroughLibrary(body);
    const sent = JSON.parse(built.body);
    expect(sent.messages[2]).toEqual(control("low"));
    expect(Object.keys(sent.messages[2])).toEqual(["role", "content", "output_config"]);
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(built.headers.get("anthropic-beta").split(",")).toContain(PER_TURN_BETA);
  });

  it("a model without the capability gets neither a control message nor the beta", async () => {
    expect(supportsPerTurnEffortWire(INCAPABLE_MODEL)).toBe(false);
    const sessionKey = freshSession();
    transformedBody([user(LONG)], INCAPABLE_MODEL, sessionKey);
    const body = transformedBody([user(LONG), assistant("ok"), user("short?")], INCAPABLE_MODEL, sessionKey);

    const { built } = await buildThroughLibrary(body);
    expect(JSON.parse(built.body).messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(built.headers.get("anthropic-beta").split(",")).not.toContain(PER_TURN_BETA);
  });

  it("the count-tokens surface drops the control messages instead of failing", async () => {
    const sessionKey = freshSession();
    transformedBody([user(LONG)], CAPABLE_MODEL, sessionKey);
    const body = transformedBody([user(LONG), assistant("ok"), user("short?")], CAPABLE_MODEL, sessionKey);
    const { result } = await buildThroughLibrary(body);

    const counted = await buildWireCompatibleCountTokensRequest(body, result.transport);
    expect(JSON.parse(counted.body).messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
