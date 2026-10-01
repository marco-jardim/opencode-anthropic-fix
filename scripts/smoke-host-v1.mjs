import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Real, official v1 host processes. This intentionally performs no inference:
// all OAuth credentials are fake and all state lives below the printed scratch
// directory. HTTP probes exercise plugin loading, provider auth and commands.
const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versions = process.argv.slice(2);
const suppliedBinary = versions[0] && !/^1\.\d+\.\d+$/.test(versions[0]) ? resolve(versions.shift()) : null;
if (versions.length === 0) versions.push("1.2.27", "1.18.29", "1.18.34");
for (const version of versions) assert.match(version, /^1\.\d+\.\d+$/, "Pass exact v1 release versions");
const scratch = await mkdtemp(join(tmpdir(), "anthropic-v1-host-smoke-"));
const results = [];
console.log(`Smoke artifacts: ${scratch}`);

async function download(version) {
  if (suppliedBinary) return { binary: suppliedBinary };
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const executable = process.platform === "win32" ? "opencode.exe" : "opencode";
  const metadataUrl = `https://registry.npmjs.org/opencode-${platform}-${process.arch}/${version}`;
  const metadataResponse = await fetch(metadataUrl, { signal: AbortSignal.timeout(30_000) });
  assert.equal(metadataResponse.ok, true, `Registry metadata: ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const archiveResponse = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(180_000) });
  assert.equal(archiveResponse.ok, true, `Registry archive: ${archiveResponse.status}`);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(integrity, metadata.dist.integrity, "Official binary archive integrity differs from npm metadata");
  const target = join(scratch, version, "binary");
  await mkdir(target, { recursive: true });
  const archivePath = join(target, "official.tgz");
  await writeFile(archivePath, archive);
  await execFileAsync("tar", ["-xzf", archivePath, "-C", target, `package/bin/${executable}`], { windowsHide: true });
  return { binary: join(target, "package", "bin", executable), metadataUrl, integrity };
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function smoke(version) {
  const downloaded = await download(version);
  const state = join(scratch, version, "state");
  const home = join(state, "home");
  const workspace = join(state, "workspace");
  const config = join(state, "config", "opencode");
  const roaming = join(state, "roaming");
  const pluginConfigDirectory = process.platform === "win32" ? join(roaming, "opencode") : config;
  const data = join(state, "data");
  const temporary = join(state, "tmp");
  await Promise.all(
    [home, workspace, config, join(roaming, "opencode"), join(data, "opencode"), temporary].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|LANG|LC_ALL|TERM|NO_COLOR)$/i.test(key),
    ),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: parse(home).root.replace(/[\\/]+$/, ""),
    HOMEPATH: home.slice(parse(home).root.length - 1),
    APPDATA: roaming,
    LOCALAPPDATA: join(state, "local"),
    XDG_CONFIG_HOME: join(state, "config"),
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: join(state, "cache"),
    XDG_STATE_HOME: join(state, "xdg-state"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG: join(config, "opencode.json"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    OPENCODE_SERVER_PASSWORD: "local-v1-smoke-password",
    TEMP: temporary,
    TMP: temporary,
  });
  const plugin = pathToFileURL(root).href;
  await writeFile(
    join(config, "opencode.json"),
    JSON.stringify({ plugin: [plugin], autoupdate: false, share: "disabled" }),
  );
  const pluginConfig = {
    signature_emulation: { fetch_claude_code_version_on_startup: false },
    preconnect: { enabled: false },
    idle_refresh: { enabled: false },
    telemetry: { emulate_minimal: false },
  };
  await writeFile(join(pluginConfigDirectory, "anthropic-auth.json"), JSON.stringify(pluginConfig));
  const now = Date.now();
  const auth = {
    type: "oauth",
    access: "sk-ant-oat01-local-smoke-fake",
    refresh: "local-smoke-fake-refresh",
    expires: now + 86400_000,
  };
  await writeFile(join(data, "opencode", "auth.json"), JSON.stringify({ anthropic: auth }));
  await writeFile(
    join(pluginConfigDirectory, "anthropic-accounts.json"),
    JSON.stringify({
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          id: "local-smoke-account",
          email: "fake@example.invalid",
          access: auth.access,
          refreshToken: auth.refresh,
          expires: auth.expires,
          token_updated_at: now,
          addedAt: now,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
        },
      ],
    }),
  );
  const reported = await execFileAsync(downloaded.binary, ["--version"], {
    cwd: workspace,
    env,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(reported.stdout.trim(), version, "Downloaded executable reports a different release");
  const port = await freePort();
  const child = spawn(
    downloaded.binary,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "DEBUG", "--print-logs"],
    { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  let exit;
  let spawnError;
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("exit", (code) => {
    exit = code;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const authorization = `Basic ${Buffer.from("opencode:local-v1-smoke-password").toString("base64")}`;
  async function get(path) {
    const result = await fetch(
      `${baseUrl}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(workspace)}`,
      { headers: { authorization }, signal: AbortSignal.timeout(30_000) },
    );
    const text = await result.text();
    assert.equal(result.ok, true, `${path}: HTTP ${result.status} ${text.slice(0, 1000)}`);
    return JSON.parse(text);
  }
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    let readinessDetail = "no response";
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exit !== undefined) throw new Error(`Host exited ${exit}: ${logs.slice(-5000)}`);
      try {
        const ping = await fetch(`${baseUrl}/global/health`, {
          headers: { authorization },
          signal: AbortSignal.timeout(1000),
        });
        readinessDetail = `HTTP ${ping.status}`;
        if (ping.ok || ping.status === 404) {
          ready = true;
          break;
        }
      } catch (error) {
        readinessDetail = String(error);
        if (Date.now() >= deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, `Host did not become ready: ${readinessDetail}`);
    const loadedConfig = await get("/config");
    const methods = await get("/provider/auth");
    const providers = await get("/provider");
    const commands = await get("/command");
    await writeFile(
      join(state, "probes.json"),
      JSON.stringify({ config: loadedConfig, methods, providers, commands }, null, 2),
    );
    assert.ok(loadedConfig.command?.anthropic, "Plugin config hook did not register /anthropic");
    assert.ok(
      methods.anthropic?.some((method) => method.label === "Claude Pro/Max (multi-account)"),
      "Managed OAuth method was not registered",
    );
    const matches = commands.filter((command) => command.name === "anthropic");
    assert.equal(matches.length, 1, "The plugin command must load exactly once");
    const provider = providers.all?.find((candidate) => candidate.id === "anthropic");
    assert.ok(provider, "Anthropic provider was not listed");
    const models = Object.values(provider.models ?? {});
    assert.ok(models.length > 0, "No Anthropic model was listed");
    assert.ok(
      models.every((model) => model.cost?.input === 0 && model.cost?.output === 0),
      "OAuth loader did not zero model costs",
    );
    assert.equal(/failed to (?:load|install) plugin/i.test(logs), false, "Host reported a plugin load failure");
    const report = {
      version,
      binaryVersion: reported.stdout.trim(),
      plugin,
      metadataUrl: downloaded.metadataUrl,
      binaryIntegrity: downloaded.integrity,
      modelCount: models.length,
      commandCount: matches.length,
      oauthMethod: methods.anthropic.find((method) => method.label === "Claude Pro/Max (multi-account)"),
      model: { id: models[0].id, cost: models[0].cost },
      inferenceRequests: 0,
      state,
      loaderLog: logs
        .split(/\r?\n/)
        .filter((line) => /plugin/i.test(line) && /anthropic-fix|loading plugin|loaded plugin/.test(line)),
    };
    await writeFile(join(state, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (exit === undefined && !spawnError) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await writeFile(join(state, "host.log"), logs);
  }
}

for (const version of versions) {
  try {
    const report = await smoke(version);
    results.push({ version, passed: true, ...report });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    results.push({ version, passed: false, error: String(error) });
    console.error(`${version}: ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}
await writeFile(join(scratch, "matrix.json"), JSON.stringify(results, null, 2));
