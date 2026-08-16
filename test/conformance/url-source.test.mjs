// WHERE THE OUTGOING URL COMES FROM.
//
// There are two answers, and which one applies is decided by the same
// `_useAdapter` gate that decides where the headers and body come from:
//
//   * ADAPTER PATH (signature emulation on, eligible request): the URL is
//     `built.url` from `@tormentalabs/claude-code-wire-compat` — the endpoint the
//     package composed those headers and that body FOR. Adopting it is what makes
//     the whole request come from one source; the alternative was deriving the
//     URL locally and hoping it kept agreeing with the package's pinned endpoint
//     across releases. The single local override is the MITM origin.
//
//   * LEGACY PATH (emulation off, non-eligible endpoint, non-string body, or an
//     adapter that declined): `transformRequestUrl` still owns the URL, exactly
//     as before. Nothing about that path moved.
//
// The default base makes the two agree byte for byte, which is precisely why
// this file exists: without an assertion that names the SOURCE, a regression that
// silently reverted to the local derivation would pass every other suite. The
// MITM case below is the one that can actually tell them apart, because it pins
// that path and query survive an origin rewrite — the local derivation reaches
// the same result by a different route, so the count_tokens case (where the
// package's path is its own pinned constant) is the discriminating one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("a"),
    close: vi.fn(),
  })),
}));

vi.mock("../../lib/storage.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadAccounts: vi.fn().mockResolvedValue(null),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    clearAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../lib/refresh-lock.mjs", () => ({
  acquireRefreshLock: vi.fn().mockResolvedValue({
    acquired: true,
    lockPath: "/tmp/opencode-url-source-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

// `signature` is the `_useAdapter` switch in index.mjs: with emulation off the
// plugin's legacy forge runs, and with it the legacy URL derivation.
const testPolicy = vi.hoisted(() => ({ signature: true }));

vi.mock("../../lib/config.mjs", async (importOriginal) => {
  const original = await importOriginal();
  const makeConfig = () => ({
    ...original.DEFAULT_CONFIG,
    signature_emulation: {
      ...original.DEFAULT_CONFIG.signature_emulation,
      enabled: testPolicy.signature,
      fetch_claude_code_version_on_startup: false,
    },
    idle_refresh: { ...original.DEFAULT_CONFIG.idle_refresh, enabled: false },
    adaptive_context: { ...original.DEFAULT_CONFIG.adaptive_context, enabled: false },
  });

  return {
    ...original,
    loadConfig: vi.fn(makeConfig),
    loadConfigFresh: vi.fn(makeConfig),
    saveConfig: vi.fn(),
  };
});

import { AnthropicAuthPlugin } from "../../index.mjs";

const HOST_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system: [{ type: "text", text: "You are a helpful assistant." }],
  messages: [{ role: "user", content: "What is 2+2?" }],
};

function makeClient() {
  return {
    auth: { set: vi.fn().mockResolvedValue(undefined) },
    session: { prompt: vi.fn().mockResolvedValue(undefined) },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeProvider() {
  return {
    models: {
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
    },
  };
}

function makeSuccessResponse() {
  return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Drive one request through the real interceptor and return the URL the plugin
 * handed to `fetch`. `requestPath` is what the HOST sends; the plugin decides
 * what actually goes on the wire, which is the whole point of the assertions.
 */
async function captureFetchedUrl(requestPath, hostBody = HOST_BODY, origin = "https://api.anthropic.com") {
  const mockFetch = vi.fn(() => Promise.resolve(makeSuccessResponse()));
  vi.stubGlobal("fetch", mockFetch);
  const plugin = await AnthropicAuthPlugin({ client: makeClient() });
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 3_600_000,
  });
  const { fetch: fetchFn } = await plugin.auth.loader(getAuth, makeProvider());
  const response = await fetchFn(`${origin}${requestPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(hostBody),
  });
  await response.text();

  expect(mockFetch).toHaveBeenCalled();
  return String(mockFetch.mock.calls[0][0]);
}

function stubCleanEnvironment() {
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "");
  vi.stubEnv("CLAUDE_CODE_ADDITIONAL_PROTECTION", "");
  vi.stubEnv("CLAUDE_CODE_BACKGROUND", "");
  vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "");
  vi.stubEnv("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE", "");
  vi.stubEnv("OPENCODE_MITM_BASE_URL", "");
}

beforeEach(() => {
  vi.clearAllMocks();
  testPolicy.signature = true;
  stubCleanEnvironment();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("adapter path takes its URL from the shared package", () => {
  it("uses the package's pinned messages endpoint", async () => {
    // `?beta=true` here is the PACKAGE's query, not transformRequestUrl's.
    expect(await captureFetchedUrl("/v1/messages")).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("uses the package's pinned count_tokens endpoint", async () => {
    expect(await captureFetchedUrl("/v1/messages/count_tokens")).toBe(
      "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
    );
  });

  it("normalizes a host-sent /messages to the package's /v1/messages", async () => {
    // The host may address the base URL with `/v1` already in it. The package's
    // endpoint is absolute, so the normalization is inherent rather than a
    // pathname rewrite the plugin has to remember to do.
    expect(await captureFetchedUrl("/messages")).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  // THE DISCRIMINATING CASES. Every assertion above is satisfied by the OLD
  // local derivation too — against the default base the package's endpoint and
  // transformRequestUrl's output are the same string, which is why the parity
  // harness needed no re-seal. What follows is where the two sources disagree.
  //
  // The custom-origin tests above are the OTHER half of the discrimination: they
  // fail if the adapter ever adopts the package's origin along with its path.

  it("keeps the host's origin while taking the package's path and query", async () => {
    // The origin belongs to whoever the host addressed. A custom provider
    // baseURL -- gateway, LiteLLM, corporate proxy -- arrives here, and adopting
    // the package's origin too would silently redirect it to api.anthropic.com
    // with an OAuth bearer attached. The package still supplies `?beta=true`.
    expect(await captureFetchedUrl("/v1/messages", HOST_BODY, "https://proxy.internal.example")).toBe(
      "https://proxy.internal.example/v1/messages?beta=true",
    );
  });

  it("keeps a host origin carrying an explicit port", async () => {
    expect(await captureFetchedUrl("/v1/messages", HOST_BODY, "http://gateway.internal:4000")).toBe(
      "http://gateway.internal:4000/v1/messages?beta=true",
    );
  });

  it("normalizes the path to the package's canonical one under a custom origin", async () => {
    // Both halves at once: the host's origin survives AND the package's
    // `/v1/messages` replaces the host-sent `/messages`.
    expect(await captureFetchedUrl("/messages", HOST_BODY, "https://proxy.internal.example")).toBe(
      "https://proxy.internal.example/v1/messages?beta=true",
    );
  });

  it("drops host-supplied query parameters the package's endpoint does not carry", async () => {
    // transformRequestUrl short-circuits when `beta` is already present, so it
    // would have forwarded `&trace=1` untouched. The package's endpoint is a
    // pinned literal with exactly one query parameter, and adopting it means
    // adopting that too.
    expect(await captureFetchedUrl("/v1/messages?beta=true&trace=1")).toBe(
      "https://api.anthropic.com/v1/messages?beta=true",
    );
  });
});

// The MITM redirect needs no adapter-specific handling: transformRequestUrl
// already applied it to `requestUrl`, and the adapter copies `requestUrl`'s
// origin. One code path serves the custom-baseURL case and the MITM case,
// which is why the dedicated origin-override helper was deleted.
describe("OPENCODE_MITM_BASE_URL overrides the origin only", () => {
  it("rewrites protocol, hostname and port but keeps the package's path and query", async () => {
    vi.stubEnv("OPENCODE_MITM_BASE_URL", "http://localhost:9999");
    expect(await captureFetchedUrl("/v1/messages")).toBe("http://localhost:9999/v1/messages?beta=true");
  });

  it("wins over a custom host origin", async () => {
    // MITM is a capture/debug redirect: it is applied last by
    // transformRequestUrl, so it outranks the provider's baseURL.
    vi.stubEnv("OPENCODE_MITM_BASE_URL", "http://localhost:9999");
    expect(await captureFetchedUrl("/v1/messages", HOST_BODY, "https://proxy.internal.example")).toBe(
      "http://localhost:9999/v1/messages?beta=true",
    );
  });

  it("keeps the package's count_tokens path under the MITM origin", async () => {
    vi.stubEnv("OPENCODE_MITM_BASE_URL", "http://127.0.0.1:8080");
    expect(await captureFetchedUrl("/v1/messages/count_tokens")).toBe(
      "http://127.0.0.1:8080/v1/messages/count_tokens?beta=true",
    );
  });

  it("ignores an unparsable MITM base and keeps the package endpoint intact", async () => {
    vi.stubEnv("OPENCODE_MITM_BASE_URL", "not a url");
    expect(await captureFetchedUrl("/v1/messages")).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });
});

describe("legacy path keeps transformRequestUrl as the URL source", () => {
  // Emulation off is the route where the package never runs. These pins are the
  // PRE-migration behaviour, unchanged: they fail if the adapter's URL adoption
  // ever leaks across the gate.
  it("appends ?beta=true locally when signature emulation is off", async () => {
    testPolicy.signature = false;
    expect(await captureFetchedUrl("/v1/messages")).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("normalizes /messages to /v1/messages locally when signature emulation is off", async () => {
    testPolicy.signature = false;
    expect(await captureFetchedUrl("/messages")).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("applies the MITM origin through transformRequestUrl when signature emulation is off", async () => {
    testPolicy.signature = false;
    vi.stubEnv("OPENCODE_MITM_BASE_URL", "http://localhost:9999");
    expect(await captureFetchedUrl("/v1/messages")).toBe("http://localhost:9999/v1/messages?beta=true");
  });

  // The mirror image of the discriminating cases above. With emulation off the
  // package never runs, so the extra query parameter survives -- exactly as it
  // did before the migration. This is the byte-level proof that the legacy path
  // was not touched. (The proxy origin survives on BOTH paths now, so it is no
  // longer a differential; it is asserted on the adapter side above.)
  it("keeps host-supplied query parameters when signature emulation is off", async () => {
    testPolicy.signature = false;
    expect(await captureFetchedUrl("/v1/messages?beta=true&trace=1")).toBe(
      "https://api.anthropic.com/v1/messages?beta=true&trace=1",
    );
  });

  it("leaves a non-eligible endpoint's URL alone on both paths", async () => {
    // Not /v1/messages and not count_tokens: the adapter is not applicable, and
    // transformRequestUrl adds nothing either. No `?beta=true`, no rewrite.
    expect(await captureFetchedUrl("/v1/models")).toBe("https://api.anthropic.com/v1/models");
  });
});
