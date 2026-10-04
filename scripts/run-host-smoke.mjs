import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Download only the official platform package, verify npm integrity and extract
// its executable. No lifecycle scripts, global install or host config is used.
const version = process.argv[2];
assert.match(version ?? "", /^1\.\d+\.\d+$/, "Usage: node scripts/run-host-smoke.mjs <exact-v1-host-version>");
const platform = process.platform === "win32" ? "windows" : process.platform;
assert.ok(["windows", "linux", "darwin"].includes(platform), `Unsupported host platform: ${platform}`);
assert.ok(["x64", "arm64"].includes(process.arch), `Unsupported host architecture: ${process.arch}`);
const packageName = `opencode-${platform}-${process.arch}`;
const scratchRoot = process.env.OPENCODE_HOST_SMOKE_DIR ?? tmpdir();
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, `anthropic-host-${version}-`));
const metadataResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`, {
  signal: AbortSignal.timeout(30_000),
});
assert.ok(metadataResponse.ok, `npm metadata HTTP ${metadataResponse.status}`);
const metadata = await metadataResponse.json();
const tarballResponse = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(180_000) });
assert.ok(tarballResponse.ok, `npm tarball HTTP ${tarballResponse.status}`);
const archive = Buffer.from(await tarballResponse.arrayBuffer());
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
assert.equal(integrity, metadata.dist.integrity, "Official host package integrity mismatch");
const archivePath = join(scratch, "official.tgz");
const executable = process.platform === "win32" ? "opencode.exe" : "opencode";
await writeFile(archivePath, archive);
await promisify(execFile)("tar", ["-xzf", archivePath, "-C", scratch, `package/bin/${executable}`], {
  windowsHide: true,
});
await writeFile(
  join(scratch, "provenance.json"),
  JSON.stringify({ packageName, version, tarball: metadata.dist.tarball, integrity }, null, 2),
);
console.log(`Official host: ${packageName}@${version}; integrity verified; artifacts: ${scratch}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(
  process.execPath,
  [join(root, "scripts", "smoke-host-v1.mjs"), join(scratch, "package", "bin", executable), version],
  { cwd: root, windowsHide: true, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
