import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let temporaryRoot;
let bundle;
let environment;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "anthropic-bundle-test-"));
  const home = join(temporaryRoot, "home");
  environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(temporaryRoot, "appdata"),
    LOCALAPPDATA: join(temporaryRoot, "localappdata"),
    XDG_CONFIG_HOME: join(temporaryRoot, "config"),
    XDG_DATA_HOME: join(temporaryRoot, "data"),
    XDG_CACHE_HOME: join(temporaryRoot, "cache"),
    XDG_STATE_HOME: join(temporaryRoot, "state"),
  };
  const output = join(temporaryRoot, "dist");
  execFileSync(process.execPath, [join(repositoryRoot, "scripts/build.mjs"), `--outdir=${output}`], {
    cwd: temporaryRoot,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  bundle = join(output, "opencode-anthropic-fix");
}, 40_000);

afterAll(async () => {
  if (!temporaryRoot) return;
  expect(dirname(temporaryRoot)).toBe(resolve(tmpdir()));
  expect(temporaryRoot.startsWith(join(tmpdir(), "anthropic-bundle-test-"))).toBe(true);
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("dual-host distribution", () => {
  it("resolves every previously published top-level and library path", async () => {
    const inventory = JSON.parse(await readFile(join(repositoryRoot, "test/fixtures/published-v2.1.1.json"), "utf8"));
    expect(inventory.files).toHaveLength(41);
    for (const path of inventory.files) {
      expect(import.meta.resolve(`opencode-anthropic-fix/${path}`)).toBe(
        pathToFileURL(join(repositoryRoot, path)).href,
      );
      await expect(readFile(join(repositoryRoot, path))).resolves.toBeInstanceOf(Buffer);
    }
  });

  it("resolves public source entrypoints while preserving existing library subpaths", () => {
    for (const [specifier, path] of Object.entries({
      "opencode-anthropic-fix": "index.mjs",
      "opencode-anthropic-fix/server": "server.mjs",
      "opencode-anthropic-fix/tui": "tui.mjs",
      "opencode-anthropic-fix/rpc": "lib/host/command-rpc.mjs",
      "opencode-anthropic-fix/index.mjs": "index.mjs",
      "opencode-anthropic-fix/cli.mjs": "cli.mjs",
      "opencode-anthropic-fix/lib/config.mjs": "lib/config.mjs",
      "opencode-anthropic-fix/package.json": "package.json",
    })) {
      expect(import.meta.resolve(specifier)).toBe(pathToFileURL(join(repositoryRoot, path)).href);
    }
  });

  it("builds an isolated package with complete metadata, license notices and no external dependencies", async () => {
    const names = await readdir(bundle);
    expect(names.sort()).toEqual(
      [
        "index.mjs",
        "server.mjs",
        "tui.mjs",
        "cli.mjs",
        "rpc.mjs",
        "package.json",
        "LICENSE",
        "NOTICE",
        "THIRD_PARTY_NOTICES",
      ].sort(),
    );
    const manifest = JSON.parse(await readFile(join(bundle, "package.json"), "utf8"));
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./index.mjs");
    expect(manifest.exports).toMatchObject({
      ".": "./index.mjs",
      "./server": "./server.mjs",
      "./tui": "./tui.mjs",
      "./rpc": "./rpc.mjs",
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(await readFile(join(bundle, "NOTICE"), "utf8")).toContain("@tormentalabs/claude-code-wire-compat");
    const thirdParty = await readFile(join(bundle, "THIRD_PARTY_NOTICES"), "utf8");
    expect(thirdParty).toContain("@ai-sdk/anthropic 3.0.111");
    expect(thirdParty).toContain("@ai-sdk/provider ");
    expect(thirdParty).toContain("@ai-sdk/provider-utils ");
    expect(thirdParty).toContain("Apache License");
    expect(thirdParty).toContain("GNU GENERAL PUBLIC LICENSE");
    const legacy = await readFile(join(temporaryRoot, "dist/opencode-anthropic-auth-plugin.js"), "utf8");
    expect(legacy).toContain("// THIRD-PARTY SOFTWARE INCLUDED IN THE STANDALONE BUILDS");
  });

  it("loads the built legacy/server/TUI/RPC entries outside the repository and its node_modules", () => {
    const urls = Object.fromEntries(
      ["index", "server", "tui", "rpc", "cli"].map((name) => [name, pathToFileURL(join(bundle, `${name}.mjs`)).href]),
    );
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const urls = ${JSON.stringify(urls)};
         const modules = Object.fromEntries(await Promise.all(Object.entries(urls).map(async ([name,url]) => [name, await import(url)])));
         console.log(JSON.stringify({
           legacy: Object.keys(modules.index).sort(),
           sameFactory: modules.index.default === modules.index.AnthropicAuthPlugin,
           server: Object.keys(modules.server),
           dualServer: [typeof modules.server.default.server, typeof modules.server.default.setup],
           dualTui: [typeof modules.tui.default.tui, typeof modules.tui.default.setup],
           rpc: modules.rpc.anthropicCommandRpc.id,
         }));`,
      ],
      { cwd: temporaryRoot, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual({
      legacy: ["AnthropicAuthPlugin", "default"],
      sameFactory: true,
      server: ["default"],
      dualServer: ["function", "function"],
      dualTui: ["function", "function"],
      rpc: "opencode-anthropic-fix",
    });
  });
});
