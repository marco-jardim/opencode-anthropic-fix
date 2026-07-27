import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const packageName = "@tormentalabs/claude-code-wire-compat";
const packageLicense = "GPL-3.0-or-later";
const upstreamRepository = "https://github.com/marco-jardim/claude-code-wire-compat";

const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"));

const noticePath = resolve(repositoryRoot, "NOTICE");
const readmePath = resolve(repositoryRoot, "README.md");
const provenancePath = resolve(repositoryRoot, "docs/shared-package-provenance.md");
const adapterPath = resolve(repositoryRoot, "lib/mimicry/wire-compat.mjs");

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

const notice = readIfPresent(noticePath);
const readme = readIfPresent(readmePath);
const provenance = readIfPresent(provenancePath);
const adapter = readIfPresent(adapterPath);

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const releaseTarball =
  /^https:\/\/github\.com\/marco-jardim\/claude-code-wire-compat\/releases\/download\/(v\d+\.\d+\.\d+-rc\.\d+)\/tormentalabs-claude-code-wire-compat-\d+\.\d+\.\d+-rc\.\d+\.tgz$/;

/**
 * A dependency specifier is acceptable only when it names an immutable artifact:
 * an exact registry version, or a tagged release tarball whose release candidate
 * tag is recorded in the provenance documentation. Mutable references such as
 * `file:`, `link:`, git branches, semver ranges, or an untagged URL are rejected
 * because they let the built request change without a reviewed dependency bump.
 *
 * @param {string} specifier
 * @returns {{ kind: "registry" | "tarball" | "rejected", tag?: string, reason?: string }}
 */
function classifyDependencySpecifier(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    return { kind: "rejected", reason: "missing specifier" };
  }
  if (exactVersion.test(specifier)) {
    return { kind: "registry" };
  }
  if (/^(?:file|link|portal|workspace|git|git\+\w+|github|gitlab|bitbucket):/.test(specifier)) {
    return { kind: "rejected", reason: "mutable local, workspace, or git reference" };
  }

  const tarball = specifier.match(releaseTarball);
  if (tarball) {
    return { kind: "tarball", tag: tarball[1] };
  }
  if (specifier.startsWith("http://") || specifier.startsWith("https://")) {
    return { kind: "rejected", reason: "URL without a recorded release-candidate tag" };
  }

  return { kind: "rejected", reason: "non-exact version range" };
}

describe("shared wire package dependency specifier policy", () => {
  it.each([
    { specifier: "file:../claude-code-wire-compat", reason: "mutable local, workspace, or git reference" },
    { specifier: "link:../claude-code-wire-compat", reason: "mutable local, workspace, or git reference" },
    {
      specifier: "git+https://github.com/marco-jardim/claude-code-wire-compat.git#master",
      reason: "mutable local, workspace, or git reference",
    },
    {
      specifier: "github:marco-jardim/claude-code-wire-compat",
      reason: "mutable local, workspace, or git reference",
    },
    {
      specifier: "https://github.com/marco-jardim/claude-code-wire-compat/archive/refs/heads/master.tar.gz",
      reason: "URL without a recorded release-candidate tag",
    },
    { specifier: "^0.1.0", reason: "non-exact version range" },
    { specifier: "", reason: "missing specifier" },
  ])("rejects $specifier", ({ specifier, reason }) => {
    expect(classifyDependencySpecifier(specifier)).toEqual({ kind: "rejected", reason });
  });

  it("accepts an exact registry version, which is the Phase 9 target", () => {
    expect(classifyDependencySpecifier("0.1.0")).toEqual({ kind: "registry" });
  });

  it("accepts the tagged release tarball and reports its tag", () => {
    expect(
      classifyDependencySpecifier(
        "https://github.com/marco-jardim/claude-code-wire-compat/releases/download/v0.1.0-rc.11/tormentalabs-claude-code-wire-compat-0.1.0-rc.11.tgz",
      ),
    ).toEqual({ kind: "tarball", tag: "v0.1.0-rc.11" });
  });

  it("pins the shared package to an immutable artifact", () => {
    const specifier = manifest.dependencies?.[packageName];
    const classification = classifyDependencySpecifier(specifier);

    expect(classification.kind, `rejected specifier ${specifier}: ${classification.reason}`).not.toBe("rejected");
  });

  it("records a lockfile integrity hash for the pinned artifact", () => {
    const entry = lockfile.packages?.[`node_modules/${packageName}`];

    expect(entry).toBeDefined();
    expect(entry.version).toMatch(exactVersion);
    expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    expect(entry.resolved).toBe(manifest.dependencies?.[packageName]);
    expect(entry.license).toBe(packageLicense);
  });

  it("documents the exact pinned tag and integrity hash while the pin is a tarball", () => {
    const specifier = manifest.dependencies?.[packageName];
    const classification = classifyDependencySpecifier(specifier);

    if (classification.kind !== "tarball") {
      expect(provenance).toContain(lockfile.packages?.[`node_modules/${packageName}`]?.version);
      return;
    }

    expect(provenance).toContain(classification.tag);
    expect(provenance).toContain(lockfile.packages?.[`node_modules/${packageName}`]?.integrity);
    expect(provenance).toMatch(/Phase 9[\s\S]{0,400}`0\.1\.0`/);
    expect(provenance).toMatch(/npm registry|registry version|from npm/i);
  });
});

describe("shared wire package license attribution", () => {
  it("ships a NOTICE naming the dependency, its license, and its upstream", () => {
    expect(existsSync(noticePath), "NOTICE is required for third-party attribution").toBe(true);
    expect(notice).toContain(packageName);
    expect(notice).toContain(packageLicense);
    expect(notice).toContain(upstreamRepository);
  });

  it("keeps the plugin's own GPL notice alongside the dependency attribution", () => {
    expect(notice).toContain("GNU General Public License");
    expect(notice).toContain("opencode-anthropic-fix");
  });

  it("points the README at the attribution and provenance documents", () => {
    expect(readme).toContain("NOTICE");
    expect(readme).toContain("docs/shared-package-provenance.md");
    expect(readme).toContain(packageName);
  });
});

describe("shared wire package rollback documentation", () => {
  it("documents a revert-based rollback that never removes GPL notices", () => {
    expect(existsSync(provenancePath), "rollback documentation is required").toBe(true);
    expect(provenance).toContain("git revert");
    expect(provenance).toMatch(/never remove[^\n]*GPL/i);
  });

  it("states that no runtime kill-switch exists", () => {
    expect(provenance).toMatch(/no runtime kill-switch/i);
    expect(provenance).toContain("OPENCODE_ANTHROPIC_PROFILE_OVERRIDE");
    expect(provenance).toMatch(/not[^\n]*disable/i);
  });

  it("matches the adapter's actual static, unconditional import", () => {
    // The rollback procedure is code-revert only precisely because this import
    // cannot be switched off at runtime. If the import ever becomes conditional,
    // this assertion fails and the documented procedure must be rewritten.
    expect(adapter).toMatch(/^import \{ buildClaudeCodeRequest \} from "@tormentalabs\/claude-code-wire-compat";$/m);
    expect(provenance).toMatch(/static[^\n]*import|import[^\n]*static/i);
  });
});
