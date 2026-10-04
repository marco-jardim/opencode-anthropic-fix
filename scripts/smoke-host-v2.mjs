import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { createHostProbe, hostLogTail } from "./host-smoke-probes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2];
if (!binary) throw new Error("Usage: node scripts/smoke-host-v2.mjs <OpenCode-2.0.21-binary>");
async function waitFor(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
let hold = false;
let disconnected = 0;
const requests = [];
const mock = createHttpServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method !== "POST" || chunks.length === 0) {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push({ headers: request.headers, body });
  if (hold) {
    response.once("close", () => disconnected++);
    return;
  }
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_smoke",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Smoke response" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const scratchRoot = process.env.OPENCODE_HOST_SMOKE_DIR ?? join(root, "node_modules", ".host-smoke-artifacts");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "anthropic-v2-host-smoke-"));
console.log(`Smoke artifacts: ${scratch}`);
const workspace = join(scratch, "config", "opencode");
const roaming = join(scratch, "roaming");
const pluginConfigDirectory = process.platform === "win32" ? join(roaming, "opencode") : workspace;
const networkGuard = join(scratch, "network-guard");
await Promise.all(
  [workspace, networkGuard, join(roaming, "opencode"), join(scratch, "home"), join(scratch, "tmp")].map((path) =>
    mkdir(path, { recursive: true }),
  ),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|LANG|LC_ALL|TERM|NO_COLOR)$/i.test(key),
  ),
);
Object.assign(env, {
  HOME: join(scratch, "home"),
  USERPROFILE: join(scratch, "home"),
  APPDATA: roaming,
  LOCALAPPDATA: join(scratch, "local"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_DATA_HOME: join(scratch, "data"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  XDG_STATE_HOME: join(scratch, "state"),
  OPENCODE_PASSWORD: "local-host-smoke-password",
  OPENCODE_CONFIG_DIR: workspace,
  OPENCODE_TEST_HOME: join(scratch, "home"),
  OPENCODE_MITM_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
  TEMP: join(scratch, "tmp"),
  TMP: join(scratch, "tmp"),
});
// Only the fixture host receives this guard. Background quota probes use a
// hardcoded Anthropic URL; refuse them locally instead of sending fake tokens.
// Registry/host catalog downloads can still occur during a first cold start.
await writeFile(join(networkGuard, "package.json"), JSON.stringify({ type: "module", main: "server.mjs" }));
await writeFile(
  join(networkGuard, "server.mjs"),
  `
export default {
  id: "smoke-anthropic-network-guard",
  setup() {
    const original = globalThis.fetch;
    const guarded = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "anthropic.com" || url.hostname.endsWith(".anthropic.com")) {
        return Promise.resolve(new Response('{"error":{"type":"api_error","message":"Blocked by isolated smoke fixture"}}', { status: 503, headers: { "content-type": "application/json" } }));
      }
      return original(input, init);
    };
    globalThis.fetch = guarded;
    return () => { if (globalThis.fetch === guarded) globalThis.fetch = original; };
  },
};
`,
);
await writeFile(join(workspace, "opencode.json"), JSON.stringify({ plugins: [networkGuard, root] }));
await writeFile(
  join(pluginConfigDirectory, "anthropic-auth.json"),
  JSON.stringify({
    signature_emulation: { fetch_claude_code_version_on_startup: false },
    idle_refresh: { enabled: false },
    preconnect: { enabled: false },
    telemetry: { emulate_minimal: false },
    cc_credential_reuse: { enabled: false, auto_detect: false },
    overload_recovery: { poll_quota_on_overload: false },
  }),
);
const now = Date.now();
await writeFile(
  join(pluginConfigDirectory, "anthropic-accounts.json"),
  JSON.stringify({
    version: 1,
    activeIndex: 0,
    accounts: [
      {
        id: "smoke-account",
        email: "fake@example.invalid",
        access: "sk-ant-oat01-local-smoke-fake",
        refreshToken: "local-smoke-fake-refresh",
        expires: now + 86400000,
        token_updated_at: now,
        addedAt: now,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          lastReset: now,
        },
      },
    ],
  }),
);
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
let logs = "";
const child = spawn(
  binary,
  ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "debug", "--print-logs"],
  { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (chunk) => (logs += chunk));
child.stderr.on("data", (chunk) => (logs += chunk));
let exit;
child.on("exit", (code) => (exit = code));
let initializationProbe;
const client = OpenCode.make({
  baseUrl: `http://127.0.0.1:${port}`,
  headers: { authorization: "Basic " + Buffer.from("opencode:local-host-smoke-password").toString("base64") },
  fetch: async (input, init) =>
    initializationProbe
      ? Response.json(await initializationProbe("plugin initialization", input, init))
      : fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(90000) }),
});
const location = { directory: workspace };
let stage = "boot";
const started = Date.now();
let failed = false;
try {
  const deadline = Date.now() + 45000;
  let info;
  while (Date.now() < deadline) {
    try {
      info = await client.server.info({ signal: AbortSignal.timeout(1000) });
      break;
    } catch (error) {
      if (exit !== undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.ok(info, "Host did not become ready");
  assert.equal(info.version, "2.0.21", "This smoke certifies the pinned OpenCode host version");
  stage = "plugin initialization";
  initializationProbe = createHostProbe();
  const plugins = await client.plugin.list({ location });
  initializationProbe = undefined;
  console.log(JSON.stringify({ scratch, version: info.version, initialPluginCount: plugins.data.length }));
  const integrations = await client.integration.list({ location });
  const providers = await client.provider.list({ location });
  assert.ok(providers.data.some((item) => item.id === "anthropic" && item.activation === "enabled"));
  const models = await client.model.list({ location });
  const finalPlugins = await client.plugin.list({ location });
  const plugin = finalPlugins.data.find((item) => item.id === "opencode-anthropic-fix");
  assert.ok(plugin, "Plugin absent from final inventory");
  const integration = integrations.data.find((item) => item.id === "anthropic");
  assert.ok(integration.methods.some((item) => item.id === "opencode-anthropic-fix"));
  const anthropicModels = models.data.filter((item) => item.providerID === "anthropic");
  assert.ok(anthropicModels.length > 0);
  assert.ok(anthropicModels.every((item) => item.package === "aisdk:@ai-sdk/anthropic@3.0.111"));
  assert.ok(anthropicModels.every((item) => item.cost.every((tier) => tier.input === 0 && tier.output === 0)));
  const session = await client.session.create({
    location,
    title: "Local plugin smoke",
    model: { providerID: "anthropic", id: anthropicModels[0].id },
  });
  const rpc = await client.rpc.call({
    location,
    rpcID: "opencode-anthropic-fix",
    method: "execute",
    input: { sessionID: session.id, arguments: "help" },
  });
  assert.equal(typeof rpc.output?.output, "string", "Administrative RPC must return its command output");
  assert.equal(requests.length, 0, "Administrative RPC must not call a model");
  stage = "primary generation (including a cold SDK install)";
  await client.session.prompt({ sessionID: session.id, text: "Hello." });
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(90000) });
  const history = await client.session.context({ sessionID: session.id });
  assert.ok(JSON.stringify(history).includes("Smoke response"), "Host did not consume the mock SSE reply");
  assert.ok(requests.length > 0, "No request reached the mock upstream");
  assert.ok(requests.every((item) => item.headers["x-opencode-anthropic-fix-request"] === undefined));
  assert.ok(requests.every((item) => item.headers.authorization === "Bearer sk-ant-oat01-local-smoke-fake"));
  assert.ok(requests.every((item) => item.headers["anthropic-beta"].includes("oauth-2025-04-20")));
  stage = "auxiliary generation";
  const generated = await client.session.generate({ sessionID: session.id, prompt: "Write a short answer." });
  assert.equal(generated.text, "Smoke response", "Auxiliary generation did not consume the mock stream");
  const beforeCompaction = requests.length;
  stage = "summary compaction";
  await client.session.compact({ sessionID: session.id });
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30000) });
  assert.ok(requests.length > beforeCompaction, "Summary compaction made no request");
  const beforeTitle = requests.length;
  stage = "title generation";
  const untitled = await client.session.create({
    location,
    model: { providerID: "anthropic", id: anthropicModels[0].id },
  });
  await client.session.prompt({ sessionID: untitled.id, text: "Hello from the title smoke." });
  await client.session.wait({ sessionID: untitled.id }, { signal: AbortSignal.timeout(30000) });
  await waitFor(() => requests.length >= beforeTitle + 2, "primary and title requests", 10000);
  assert.equal(
    (await client.session.get({ sessionID: untitled.id })).title,
    "Smoke response",
    "Title generation did not update the session",
  );
  hold = true;
  stage = "session interruption";
  const before = requests.length;
  const stopping = await client.session.create({
    location,
    title: "Cancellation smoke",
    model: { providerID: "anthropic", id: anthropicModels[0].id },
  });
  await client.session.prompt({ sessionID: stopping.id, text: "Hold this request until interrupted." });
  await waitFor(() => requests.length > before, "pending upstream request", 30000);
  await client.session.interrupt({ sessionID: stopping.id });
  await waitFor(() => disconnected > 0, "upstream cancellation after real session interrupt");
  stage = "reload";
  await client.location.reload();
  await waitFor(async () => {
    const reloaded = await client.plugin.list({ location });
    return reloaded.data.find((item) => item.id === "opencode-anthropic-fix")?.state.status === "active";
  }, "plugin after location reload");
  const reloadedModels = await client.model.list({ location });
  assert.equal(reloadedModels.data.filter((item) => item.providerID === "anthropic").length, anthropicModels.length);
  const report = {
    version: info.version,
    plugin,
    oauthRegistered: true,
    modelCount: anthropicModels.length,
    modelPackage: anthropicModels[0].package,
    administrativeRpcWithoutModel: true,
    generation: true,
    title: true,
    summaryCompaction: true,
    upstreamRequests: requests.length,
    interruptedBeforeHeaders: true,
    reloaded: true,
  };
  await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  failed = true;
  const report = {
    failedStage: stage,
    elapsedMs: Date.now() - started,
    upstreamRequests: requests.length,
    error: String(error),
  };
  await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report));
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await writeFile(join(scratch, "host.log"), logs);
  if (failed) console.error(`Host stdout/stderr/log tail (v2):\n${hostLogTail(logs)}`);
  console.log(`Host log: ${join(scratch, "host.log")}`);
}
