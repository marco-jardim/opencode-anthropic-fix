import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];
const packageName = "opencode-anthropic-fix";
const fixtureFiles = [
  "index.mjs",
  "server.mjs",
  "tui.mjs",
  "cli.mjs",
  "rpc.mjs",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES",
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anthropic-install-test-"));
  roots.push(root);
  const project = join(root, "source");
  const home = join(root, "home");
  const config = join(root, "config");
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(config, { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/install.mjs"), join(project, "scripts/install.mjs"));
  await writeFile(join(project, "package.json"), JSON.stringify({ name: packageName }));
  await writeFile(join(project, "cli.mjs"), "// source CLI\n");
  await writeFile(join(project, "index.mjs"), "// source plugin\n");
  const bundle = join(project, "dist", packageName);
  await mkdir(bundle, { recursive: true });
  for (const name of fixtureFiles) await writeFile(join(bundle, name), `// bundled ${name}\n`);
  await writeFile(
    join(bundle, "package.json"),
    JSON.stringify({
      name: packageName,
      type: "module",
      exports: { ".": "./index.mjs", "./server": "./server.mjs", "./tui": "./tui.mjs" },
      opencodeAnthropicInstaller: 1,
    }),
  );
  await writeFile(join(project, "dist/opencode-anthropic-auth-plugin.js"), "// legacy plugin\n");
  await writeFile(join(project, "dist/opencode-anthropic-auth-cli.mjs"), "// legacy CLI\n");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const run = (...args) =>
    execFileSync(process.execPath, [join(project, "scripts/install.mjs"), ...args], {
      cwd: project,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  return { root, project, home, config, run, destination: join(config, "opencode/node_modules", packageName) };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Only the unique mkdtemp roots created by this test are ever removed.
    expect(dirname(root)).toBe(resolve(tmpdir()));
    expect(root.startsWith(join(tmpdir(), "anthropic-install-test-"))).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});

describe("isolated installer", () => {
  it("preserves the default v1 standalone copy", async () => {
    const test = await fixture();
    test.run("copy");
    expect(await readFile(join(test.config, "opencode/plugin/opencode-anthropic-auth-plugin.js"), "utf8")).toBe(
      "// legacy plugin\n",
    );
    expect(await readFile(join(test.home, ".local/bin/opencode-anthropic-auth"), "utf8")).toBe("// legacy CLI\n");
    await expect(lstat(test.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies a self-contained v2 package and reports stale discovery entries without deleting them", async () => {
    const test = await fixture();
    const discovery = join(test.config, "opencode/plugin");
    await mkdir(discovery, { recursive: true });
    const stale = join(discovery, "opencode-anthropic-auth-plugin.js");
    await writeFile(stale, "// keep old install\n");
    const configPath = join(test.config, "opencode/opencode.json");
    await writeFile(configPath, '{"existing":"configuration"}\n');
    const output = test.run("copy", "--host=v2");
    const manifest = JSON.parse(await readFile(join(test.destination, "package.json"), "utf8"));
    expect(manifest.exports["./server"]).toBe("./server.mjs");
    expect(manifest.exports["./tui"]).toBe("./tui.mjs");
    expect(await readFile(join(test.destination, "server.mjs"), "utf8")).toBe("// bundled server.mjs\n");
    expect(await readFile(stale, "utf8")).toBe("// keep old install\n");
    expect(await readFile(configPath, "utf8")).toBe('{"existing":"configuration"}\n');
    expect(output).toContain("avoid duplicate loading");
    expect(output).toContain('"plugins"');
    expect(output).toContain("did not change your configuration");
    test.run("copy", "--host=v2");
    test.run("uninstall", "--host=v2");
    await expect(lstat(test.destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(stale, "utf8")).toBe("// keep old install\n");
  });

  it("links the package as a directory junction on Windows and can remove it without deleting source", async () => {
    const test = await fixture();
    test.run("link", "--host=v2");
    expect((await lstat(test.destination)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(test.destination, "index.mjs"), "utf8")).toBe("// source plugin\n");
    test.run("uninstall", "--host=v2");
    await expect(lstat(test.destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(test.project, "index.mjs"), "utf8")).toBe("// source plugin\n");
  });

  it("refuses to replace an npm-owned package directory or delete added files", async () => {
    const test = await fixture();
    await mkdir(test.destination, { recursive: true });
    await writeFile(join(test.destination, "package.json"), JSON.stringify({ name: packageName }));
    await writeFile(join(test.destination, "private.txt"), "keep me");
    expect(() => test.run("copy", "--host=v2")).toThrow(/not managed by this installer/);
    expect(await readFile(join(test.destination, "private.txt"), "utf8")).toBe("keep me");
    await writeFile(
      join(test.destination, "package.json"),
      JSON.stringify({ name: packageName, opencodeAnthropicInstaller: 1 }),
    );
    expect(() => test.run("uninstall", "--host=v2")).toThrow(/unmanaged entry/);
    expect(await readFile(join(test.destination, "private.txt"), "utf8")).toBe("keep me");
  });

  it("rejects unknown host flags before touching installation paths", async () => {
    const test = await fixture();
    expect(() => test.run("copy", "--host=v3")).toThrow(/Expected at most one host option/);
    await expect(lstat(test.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
