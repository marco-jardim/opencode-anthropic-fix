import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildAdapterTransport,
  buildAdapterUserAgent,
  resolveAdapterEnv,
  ADAPTER_ENV_KEYS,
  ADAPTER_SKIP_SIGNATURE_DISABLED,
  ADAPTER_SKIP_NON_ANTHROPIC_PROVIDER,
  ADAPTER_STRIPPED_HOST_HEADERS,
  MAX_ADDITIONAL_BETAS,
  SESSION_ID_FALLBACK,
  PROFILE_CLI_VERSION,
  PROFILE_USER_AGENT,
} from "./adapter-input.mjs";
import { buildWireCompatibleRequest } from "./wire-compat.mjs";
import { BETA_SHORTCUTS, buildExtendedUserAgent } from "../request-headers.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "2".repeat(64);
const ACCOUNT_UUID = "33333333-3333-4333-8333-333333333333";
const CLIENT_REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bodyFor(overrides = {}) {
  return JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  });
}

function makeState(overrides = {}) {
  return {
    input: undefined,
    requestInit: {},
    accessToken: "host-access-token",
    requestUrl: new URL("https://api.anthropic.com/v1/messages"),
    provider: "anthropic",
    clientRequestId: CLIENT_REQUEST_ID,
    signature: {
      enabled: true,
      claudeCliVersion: PROFILE_CLI_VERSION,
      customBetas: [],
      strategy: "default",
      sessionId: SESSION_ID,
    },
    identity: { persistentUserId: DEVICE_ID, accountId: ACCOUNT_UUID },
    adaptiveOverride: undefined,
    tokenEconomy: {},
    body: bodyFor(),
    env: {},
    platform: "win32",
    arch: "x64",
    nodeVersion: "v22.11.0",
    ...overrides,
  };
}

/** @param {object} overrides */
function transportOf(overrides = {}) {
  const result = buildAdapterTransport(makeState(overrides));
  if (!result.applicable) throw new Error(`expected applicable transport, got skip: ${result.reason}`);
  return result.transport;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Step 2 — core mappings
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — core mappings", () => {
  it("maps the host access token when ANTHROPIC_AUTH_TOKEN is unset", () => {
    expect(transportOf().accessToken).toBe("host-access-token");
  });

  it("prefers ANTHROPIC_AUTH_TOKEN over the account access token", () => {
    expect(transportOf({ env: { ANTHROPIC_AUTH_TOKEN: "  env-token  " } }).accessToken).toBe("env-token");
  });

  it("ignores a blank ANTHROPIC_AUTH_TOKEN", () => {
    expect(transportOf({ env: { ANTHROPIC_AUTH_TOKEN: "   " } }).accessToken).toBe("host-access-token");
  });

  it("passes the caller-supplied clientRequestId through verbatim", () => {
    expect(transportOf().clientRequestId).toBe(CLIENT_REQUEST_ID);
  });

  it("maps signature.sessionId onto runtime.sessionId", () => {
    expect(transportOf().runtime.sessionId).toBe(SESSION_ID);
  });

  it("substitutes the documented fallback when sessionId is absent", () => {
    expect(transportOf({ signature: { ...makeState().signature, sessionId: "" } }).runtime.sessionId).toBe(
      SESSION_ID_FALLBACK,
    );
    expect(transportOf({ signature: { ...makeState().signature, sessionId: undefined } }).runtime.sessionId).toBe(
      SESSION_ID_FALLBACK,
    );
  });

  it("maps the correlation triple onto runtime", () => {
    const runtime = transportOf().runtime;
    expect(runtime.deviceId).toBe(DEVICE_ID);
    expect(runtime.accountUuid).toBe(ACCOUNT_UUID);
  });

  it("maps arch and os through the stainless normalizers", () => {
    expect(transportOf({ platform: "win32", arch: "x64" }).runtime.os).toBe("Windows");
    expect(transportOf({ platform: "darwin", arch: "arm64" }).runtime.os).toBe("macOS");
    expect(transportOf({ platform: "linux" }).runtime.os).toBe("Linux");
    expect(transportOf({ arch: "arm64" }).runtime.arch).toBe("arm64");
  });

  it("pins the runtime to node and carries the node version", () => {
    const runtime = transportOf({ nodeVersion: "v22.11.0" }).runtime;
    expect(runtime.runtime).toBe("node");
    expect(runtime.runtimeVersion).toBe("v22.11.0");
  });

  it("selects cli or cli-bg from CLAUDE_CODE_BACKGROUND", () => {
    expect(transportOf().app).toBe("cli");
    expect(transportOf({ env: { CLAUDE_CODE_BACKGROUND: "1" } }).app).toBe("cli-bg");
    expect(transportOf({ env: { CLAUDE_CODE_BACKGROUND: "0" } }).app).toBe("cli");
  });

  it("maps the homonymous env-gated seams", () => {
    const transport = transportOf({
      env: {
        CLAUDE_CODE_CONTAINER_ID: "container-7",
        CLAUDE_CODE_REMOTE_SESSION_ID: "remote-9",
        CLAUDE_AGENT_SDK_CLIENT_APP: "vscode",
        CLAUDE_CODE_ADDITIONAL_PROTECTION: "true",
      },
    });
    expect(transport.claudeRemoteContainerId).toBe("container-7");
    expect(transport.claudeRemoteSessionId).toBe("remote-9");
    expect(transport.clientApp).toBe("vscode");
    expect(transport.anthropicAdditionalProtection).toBe("true");
  });

  it("omits the env-gated seams when their gates are off", () => {
    const transport = transportOf({ env: { CLAUDE_CODE_ADDITIONAL_PROTECTION: "0" } });
    expect(transport.claudeRemoteContainerId).toBeUndefined();
    expect(transport.claudeRemoteSessionId).toBeUndefined();
    expect(transport.clientApp).toBeUndefined();
    expect(transport.anthropicAdditionalProtection).toBeUndefined();
  });

  it("never emits cacheControl — the plugin keeps its own breakpoint placement", () => {
    expect(transportOf()).not.toHaveProperty("cacheControl");
  });

  it("selects dropConflicting as the extra-header policy", () => {
    expect(transportOf().extraHeaderPolicy).toBe("dropConflicting");
  });
});

// ---------------------------------------------------------------------------
// stainlessRetryCount + stainlessHelper
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — stainless seams", () => {
  it("defaults the retry count to 0 when the host sends no header", () => {
    expect(transportOf().stainlessRetryCount).toBe(0);
  });

  it("converts the host retry-count header from string to number", () => {
    const input = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-stainless-retry-count": "3" },
    });
    expect(transportOf({ input }).stainlessRetryCount).toBe(3);
  });

  it("replicates the isFalsyEnv guard on the retry-count header", () => {
    for (const falsy of ["0", "false", "no"]) {
      const input = new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-stainless-retry-count": falsy },
      });
      expect(transportOf({ input }).stainlessRetryCount).toBe(0);
    }
  });

  it("falls back to 0 for a non-numeric retry-count header", () => {
    const input = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-stainless-retry-count": "not-a-number" },
    });
    expect(transportOf({ input }).stainlessRetryCount).toBe(0);
  });

  it("derives stainlessHelper from tools and messages", () => {
    const body = bodyFor({
      tools: [{ name: "t", x_stainless_helper: "helper-a" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", "x-stainless-helper": "helper-b" }] }],
    });
    expect(transportOf({ body }).stainlessHelper).toBe("helper-a, helper-b");
  });

  it("omits stainlessHelper when no helper markers are present", () => {
    expect(transportOf().stainlessHelper).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step 3 — additionalBetas
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — additionalBetas", () => {
  it("expands BETA_SHORTCUTS on the plugin side", () => {
    const signature = { ...makeState().signature, customBetas: ["afk-mode", "1m", "fast"] };
    const betas = transportOf({ signature }).additionalBetas;
    expect(betas).toContain("afk-mode-2026-01-31");
    expect(betas).toContain("context-1m-2025-08-07");
    expect(betas).toContain("fast-mode-2026-02-01");
    expect(betas).not.toContain("afk-mode");
    expect(betas).not.toContain("1m");
    expect(betas).not.toContain("fast");
  });

  it("passes an unknown custom beta through unchanged", () => {
    const signature = { ...makeState().signature, customBetas: ["future-beta-2027-01-01"] };
    expect(transportOf({ signature }).additionalBetas).toContain("future-beta-2027-01-01");
  });

  it("orders custom betas before the orphan betas", () => {
    const signature = { ...makeState().signature, customBetas: ["afk-mode"] };
    const betas = transportOf({ signature }).additionalBetas;
    expect(betas.indexOf("afk-mode-2026-01-31")).toBeLessThan(betas.indexOf("web-search-2025-03-05"));
  });

  it("emits web-search only for models that support it", () => {
    expect(transportOf().additionalBetas).toContain("web-search-2025-03-05");
    expect(transportOf({ body: bodyFor({ model: "mistral-large" }) }).additionalBetas).not.toContain(
      "web-search-2025-03-05",
    );
  });

  it("emits advisor-tool for non-claude-3 models only", () => {
    expect(transportOf().additionalBetas).toContain("advisor-tool-2026-03-01");
    expect(transportOf({ body: bodyFor({ model: "claude-3-5-sonnet-20241022" }) }).additionalBetas).not.toContain(
      "advisor-tool-2026-03-01",
    );
  });

  it("emits files-api on the files endpoint", () => {
    expect(transportOf().additionalBetas).not.toContain("files-api-2025-04-14");
    expect(transportOf({ requestUrl: new URL("https://api.anthropic.com/v1/files") }).additionalBetas).toContain(
      "files-api-2025-04-14",
    );
  });

  it("emits files-api when the body carries a file reference", () => {
    const body = bodyFor({
      messages: [{ role: "user", content: [{ type: "document", source: { file_id: "file_123" } }] }],
    });
    expect(transportOf({ body }).additionalBetas).toContain("files-api-2025-04-14");
  });

  it("emits extended-cache-ttl by default and drops it on opt-out or round-robin", () => {
    expect(transportOf().additionalBetas).toContain("extended-cache-ttl-2025-04-11");
    expect(transportOf({ tokenEconomy: { extended_cache_ttl: false } }).additionalBetas).not.toContain(
      "extended-cache-ttl-2025-04-11",
    );
    const signature = { ...makeState().signature, strategy: "round-robin" };
    expect(transportOf({ signature }).additionalBetas).not.toContain("extended-cache-ttl-2025-04-11");
  });

  it("emits structured-outputs only when opted in on a supporting model", () => {
    expect(transportOf().additionalBetas).not.toContain("structured-outputs-2025-12-15");
    expect(transportOf({ tokenEconomy: { structured_outputs: true } }).additionalBetas).toContain(
      "structured-outputs-2025-12-15",
    );
    expect(
      transportOf({ tokenEconomy: { structured_outputs: true }, body: bodyFor({ model: "claude-haiku-4-5" }) })
        .additionalBetas,
    ).not.toContain("structured-outputs-2025-12-15");
  });

  it("re-adds claude-code-20250219 for Haiku, which the package excludes", () => {
    expect(transportOf({ body: bodyFor({ model: "claude-haiku-4-5" }) }).additionalBetas).toContain(
      "claude-code-20250219",
    );
    expect(transportOf().additionalBetas).not.toContain("claude-code-20250219");
  });

  it("applies the CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS filter plugin-side", () => {
    const state = {
      body: bodyFor({ model: "claude-haiku-4-5" }),
      env: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" },
      signature: { ...makeState().signature, customBetas: ["afk-mode"] },
    };
    const betas = transportOf(state).additionalBetas;
    expect(betas).not.toContain("web-search-2025-03-05");
    expect(betas).not.toContain("advisor-tool-2026-03-01");
    expect(betas).not.toContain("extended-cache-ttl-2025-04-11");
    expect(betas).not.toContain("afk-mode-2026-01-31");
    expect(betas).toEqual(["claude-code-20250219"]);
  });

  it("dedupes while preserving first-seen order", () => {
    const signature = {
      ...makeState().signature,
      customBetas: ["web-search", "web-search-2025-03-05", "cache-ttl", "extended-cache-ttl"],
    };
    const betas = transportOf({ signature }).additionalBetas;
    expect(betas.filter((b) => b === "web-search-2025-03-05")).toHaveLength(1);
    expect(betas.filter((b) => b === "extended-cache-ttl-2025-04-11")).toHaveLength(1);
    expect(betas[0]).toBe("web-search-2025-03-05");
  });

  it("omits additionalBetas entirely when the list resolves empty", () => {
    // A non-Claude model drops web-search and claude-code-20250219; the
    // experimental filter then removes advisor-tool and extended-cache-ttl.
    const transport = transportOf({
      body: bodyFor({ model: "mistral-large" }),
      env: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" },
    });
    expect(transport.additionalBetas).toBeUndefined();
  });

  it("stays under the hard 32-entry ceiling in the realistic worst case", () => {
    // Worst realistic case: the user enables EVERY known shortcut alias, on a
    // Haiku model, on the files endpoint, with structured outputs opted in.
    // Overflow past 32 is INVALID_INPUT in the package — a hard failure.
    const signature = { ...makeState().signature, customBetas: [...BETA_SHORTCUTS.keys()] };
    const betas = transportOf({
      signature,
      body: bodyFor({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: [{ type: "document", source: { file_id: "file_1" } }] }],
      }),
      requestUrl: new URL("https://api.anthropic.com/v1/files"),
      tokenEconomy: { structured_outputs: true },
    }).additionalBetas;
    expect(betas.length).toBeLessThanOrEqual(MAX_ADDITIONAL_BETAS);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — betaOverrides.use1MContext
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — betaOverrides.use1MContext", () => {
  it("is always explicit, never omitted", () => {
    expect(transportOf().betaOverrides).toEqual({ use1MContext: false });
  });

  it("falls back to the plugin's hasOneMillionContext regex when no override exists", () => {
    expect(transportOf({ body: bodyFor({ model: "claude-sonnet-4-5-1m" }) }).betaOverrides.use1MContext).toBe(true);
    expect(transportOf({ body: bodyFor({ model: "claude-sonnet-4-5" }) }).betaOverrides.use1MContext).toBe(false);
  });

  it("lets an explicit adaptive override win in both directions", () => {
    expect(
      transportOf({ adaptiveOverride: { use1MContext: true }, body: bodyFor({ model: "claude-sonnet-4-5" }) })
        .betaOverrides.use1MContext,
    ).toBe(true);
    expect(
      transportOf({ adaptiveOverride: { use1MContext: false }, body: bodyFor({ model: "claude-sonnet-4-5-1m" }) })
        .betaOverrides.use1MContext,
    ).toBe(false);
  });

  it("ignores a non-boolean adaptive override", () => {
    expect(
      transportOf({ adaptiveOverride: { use1MContext: "yes" }, body: bodyFor({ model: "claude-sonnet-4-5-1m" }) })
        .betaOverrides.use1MContext,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 5 — metadataOverrides
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — metadataOverrides", () => {
  it("is omitted when neither env feature is set", () => {
    expect(transportOf().metadataOverrides).toBeUndefined();
  });

  it("maps OPENCODE_ANTHROPIC_SIGNATURE_USER_ID to userId verbatim", () => {
    const overrides = transportOf({
      env: { OPENCODE_ANTHROPIC_SIGNATURE_USER_ID: "  raw-user-id  " },
    }).metadataOverrides;
    expect(overrides).toEqual({ userId: "raw-user-id" });
  });

  it("maps CLAUDE_CODE_EXTRA_METADATA to userIdFields", () => {
    const overrides = transportOf({ env: { CLAUDE_CODE_EXTRA_METADATA: '{"org":"acme","tier":2}' } }).metadataOverrides;
    expect(overrides).toEqual({ userIdFields: { org: "acme", tier: 2 } });
  });

  it("keeps the two members mutually exclusive, with userId winning", () => {
    const overrides = transportOf({
      env: {
        OPENCODE_ANTHROPIC_SIGNATURE_USER_ID: "raw-user-id",
        CLAUDE_CODE_EXTRA_METADATA: '{"org":"acme"}',
      },
    }).metadataOverrides;
    expect(overrides).toEqual({ userId: "raw-user-id" });
    expect(overrides).not.toHaveProperty("userIdFields");
  });

  it("filters the three correlation keys the package rejects", () => {
    const overrides = transportOf({
      env: {
        CLAUDE_CODE_EXTRA_METADATA: '{"org":"acme","device_id":"spoof","account_uuid":"spoof","session_id":"spoof"}',
      },
    }).metadataOverrides;
    expect(overrides).toEqual({ userIdFields: { org: "acme" } });
  });

  it("omits metadataOverrides when every extra key was a correlation key", () => {
    expect(
      transportOf({ env: { CLAUDE_CODE_EXTRA_METADATA: '{"device_id":"spoof","session_id":"spoof"}' } })
        .metadataOverrides,
    ).toBeUndefined();
  });

  it("ignores malformed or non-object CLAUDE_CODE_EXTRA_METADATA", () => {
    expect(transportOf({ env: { CLAUDE_CODE_EXTRA_METADATA: "not json" } }).metadataOverrides).toBeUndefined();
    expect(transportOf({ env: { CLAUDE_CODE_EXTRA_METADATA: "[1,2]" } }).metadataOverrides).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step 6 — host headers
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — extraHeaders", () => {
  const headerMap = (transport) => new Map(transport.extraHeaders.map(([name, value]) => [name, value]));

  it("collects headers from the original Request", () => {
    const input = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-host-marker": "from-request" },
    });
    expect(headerMap(transportOf({ input })).get("x-host-marker")).toBe("from-request");
  });

  it("collects requestInit headers supplied as a Headers instance", () => {
    const requestInit = { headers: new Headers({ "x-host-marker": "from-headers" }) };
    expect(headerMap(transportOf({ requestInit })).get("x-host-marker")).toBe("from-headers");
  });

  it("collects requestInit headers supplied as an array of pairs", () => {
    const requestInit = { headers: [["x-host-marker", "from-array"]] };
    expect(headerMap(transportOf({ requestInit })).get("x-host-marker")).toBe("from-array");
  });

  it("collects requestInit headers supplied as a plain object", () => {
    const requestInit = { headers: { "x-host-marker": "from-object" } };
    expect(headerMap(transportOf({ requestInit })).get("x-host-marker")).toBe("from-object");
  });

  it("lets requestInit headers override the Request headers", () => {
    const input = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-host-marker": "from-request" },
    });
    const requestInit = { headers: { "x-host-marker": "from-init" } };
    expect(headerMap(transportOf({ input, requestInit })).get("x-host-marker")).toBe("from-init");
  });

  it("skips undefined values in object and array header forms", () => {
    const requestInit = { headers: { "x-defined": "yes", "x-undefined": undefined } };
    const map = headerMap(transportOf({ requestInit }));
    expect(map.get("x-defined")).toBe("yes");
    expect(map.has("x-undefined")).toBe(false);
  });

  it("strips x-session-affinity, which dropConflicting would otherwise leak", () => {
    const requestInit = { headers: { "x-session-affinity": "sticky-42", "x-host-marker": "keep" } };
    const map = headerMap(transportOf({ requestInit }));
    expect(map.has("x-session-affinity")).toBe(false);
    expect(map.get("x-host-marker")).toBe("keep");
  });

  it("strips x-api-key so a host API key never reaches the wire", () => {
    const requestInit = { headers: { "x-api-key": "sk-ant-leak", "x-host-marker": "keep" } };
    const map = headerMap(transportOf({ requestInit }));
    expect(map.has("x-api-key")).toBe(false);
    expect(map.get("x-host-marker")).toBe("keep");
    expect(ADAPTER_STRIPPED_HOST_HEADERS.has("x-api-key")).toBe(true);
  });

  it("omits extraHeaders when every collected header was stripped", () => {
    const requestInit = { headers: { "x-api-key": "sk-ant-leak", "x-session-affinity": "sticky" } };
    expect(transportOf({ requestInit }).extraHeaders).toBeUndefined();
  });

  it("lets ANTHROPIC_CUSTOM_HEADERS win over the host headers", () => {
    const requestInit = { headers: { "x-host-marker": "from-host" } };
    const env = { ANTHROPIC_CUSTOM_HEADERS: "x-host-marker: from-env\nx-extra: added" };
    const map = headerMap(transportOf({ requestInit, env }));
    expect(map.get("x-host-marker")).toBe("from-env");
    expect(map.get("x-extra")).toBe("added");
  });

  it("omits extraHeaders when nothing survives collection", () => {
    expect(transportOf().extraHeaders).toBeUndefined();
  });

  it("forwards the host content-length so the package can drop and audit it", () => {
    const requestInit = { headers: { "content-length": "999999" } };
    expect(headerMap(transportOf({ requestInit })).get("content-length")).toBe("999999");
  });
});

// ---------------------------------------------------------------------------
// Step 7 — user-agent / profileOverride
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — profileOverride", () => {
  it("converges with the pinned profile in the common case, so no override is passed", () => {
    expect(buildAdapterUserAgent(PROFILE_CLI_VERSION, {})).toBe(PROFILE_USER_AGENT);
    expect(transportOf().profileOverride).toBeUndefined();
  });

  it("agrees with buildExtendedUserAgent under a clean environment", () => {
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", undefined);
    vi.stubEnv("CLAUDE_AGENT_SDK_VERSION", undefined);
    vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", undefined);
    expect(buildExtendedUserAgent(PROFILE_CLI_VERSION)).toBe(buildAdapterUserAgent(PROFILE_CLI_VERSION, {}));
  });

  it("emits a coupled userAgent + cliVersion override when the entrypoint diverges", () => {
    const transport = transportOf({ env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } });
    expect(transport.profileOverride).toEqual({
      userAgent: "claude-cli/2.1.195 (external, sdk-ts)",
      cliVersion: PROFILE_CLI_VERSION,
    });
  });

  it("emits a coupled override when the agent SDK version or client app is present", () => {
    expect(transportOf({ env: { CLAUDE_AGENT_SDK_VERSION: "1.2.3" } }).profileOverride).toEqual({
      userAgent: "claude-cli/2.1.195 (external, cli, agent-sdk/1.2.3)",
      cliVersion: PROFILE_CLI_VERSION,
    });
    expect(transportOf({ env: { CLAUDE_AGENT_SDK_CLIENT_APP: "vscode" } }).profileOverride).toEqual({
      userAgent: "claude-cli/2.1.195 (external, cli, client-app/vscode)",
      cliVersion: PROFILE_CLI_VERSION,
    });
  });

  it("emits a coupled override when the detected CLI version diverges from the profile", () => {
    const signature = { ...makeState().signature, claudeCliVersion: "2.1.200" };
    expect(transportOf({ signature }).profileOverride).toEqual({
      userAgent: "claude-cli/2.1.200 (external, cli)",
      cliVersion: "2.1.200",
    });
  });
});

// ---------------------------------------------------------------------------
// Skip signalling
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — skip signalling", () => {
  it("signals signature-disabled instead of returning a transport", () => {
    const result = buildAdapterTransport(makeState({ signature: { ...makeState().signature, enabled: false } }));
    expect(result).toEqual({ applicable: false, reason: ADAPTER_SKIP_SIGNATURE_DISABLED });
  });

  it("signals a non-anthropic provider for every non-first-party route", () => {
    for (const provider of ["bedrock", "vertex", "foundry", "mantle", "anthropicAws"]) {
      const result = buildAdapterTransport(makeState({ provider }));
      expect(result).toEqual({ applicable: false, reason: ADAPTER_SKIP_NON_ANTHROPIC_PROVIDER });
    }
  });

  it("reports the provider skip even when the signature is also disabled", () => {
    const result = buildAdapterTransport(
      makeState({ provider: "bedrock", signature: { ...makeState().signature, enabled: false } }),
    );
    expect(result.applicable).toBe(false);
    expect(result.reason).toBe(ADAPTER_SKIP_NON_ANTHROPIC_PROVIDER);
  });
});

// ---------------------------------------------------------------------------
// resolveAdapterEnv
// ---------------------------------------------------------------------------

describe("resolveAdapterEnv", () => {
  it("snapshots exactly the documented env keys", () => {
    const source = Object.fromEntries(ADAPTER_ENV_KEYS.map((key) => [key, `v-${key}`]));
    source.UNRELATED = "nope";
    const snapshot = resolveAdapterEnv(source);
    expect(Object.keys(snapshot).sort()).toEqual([...ADAPTER_ENV_KEYS].sort());
    expect(snapshot).not.toHaveProperty("UNRELATED");
  });

  it("keeps absent keys absent rather than turning them into empty strings", () => {
    expect(resolveAdapterEnv({}).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the produced transport must be accepted by the package
// ---------------------------------------------------------------------------

describe("buildAdapterTransport — accepted by buildWireCompatibleRequest", () => {
  it("builds a request and drops the host content-length under dropConflicting", async () => {
    const requestInit = {
      headers: {
        "content-length": "999999",
        "anthropic-beta": "some-host-beta-2020-01-01",
        "x-host-marker": "kept",
      },
    };
    const transport = transportOf({ requestInit });
    const built = await buildWireCompatibleRequest(bodyFor(), transport);

    expect(built.headers.get("content-length")).toBeNull();
    expect(built.evidence.droppedExtraHeaderNames).toContain("content-length");
    expect(built.headers.get("x-host-marker")).toBe("kept");
    expect(built.headers.get("x-client-request-id")).toBe(CLIENT_REQUEST_ID);
    expect(built.headers.get("x-app")).toBe("cli");
  });

  it("carries the plugin betas and metadata overrides onto the wire", async () => {
    const signature = { ...makeState().signature, customBetas: ["afk-mode"] };
    const transport = transportOf({ signature, env: { CLAUDE_CODE_EXTRA_METADATA: '{"org":"acme"}' } });
    const built = await buildWireCompatibleRequest(bodyFor(), transport);

    const betas = built.headers.get("anthropic-beta").split(",");
    expect(betas).toContain("afk-mode-2026-01-31");
    expect(betas).toContain("web-search-2025-03-05");

    const userId = JSON.parse(JSON.parse(built.body).metadata.user_id);
    expect(userId.org).toBe("acme");
    expect(userId.session_id).toBe(SESSION_ID);
  });

  it("accepts the realistic worst-case beta set without INVALID_INPUT", async () => {
    const signature = { ...makeState().signature, customBetas: [...BETA_SHORTCUTS.keys()] };
    const transport = transportOf({
      signature,
      body: bodyFor({ model: "claude-haiku-4-5" }),
      tokenEconomy: { structured_outputs: true },
    });
    await expect(buildWireCompatibleRequest(bodyFor({ model: "claude-haiku-4-5" }), transport)).resolves.toBeDefined();
  });
});
