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
 * A dependency specifier is acceptable only when a RESOLVED INSTALL of it is
 * reproducible and integrity-checked. Two shapes qualify:
 *
 *   * the literal `latest` dist-tag — the wire shape of this plugin is the
 *     package's own `DEFAULT_PROFILE`, so tracking `latest` is how the plugin
 *     inherits a newer genuine-client profile without a code change. The tag
 *     itself is mutable, which is precisely why reproducibility is delegated to
 *     `package-lock.json`: the lock records the resolved version, the registry
 *     tarball URL, and its `sha512` integrity, and `npm ci` installs exactly
 *     that. Moving the tag therefore still requires a reviewed lockfile diff.
 *   * an exact registry version — retained because emergency rollback pins one
 *     (see docs/shared-package-provenance.md).
 *
 * The tagged release tarball remains classified for the historical 0.1.0-rc pins.
 *
 * Everything else is rejected. Semver RANGES (`^`, `~`, `>=`) are rejected even
 * though they too are lock-backed: a range silently widens what a fresh
 * `npm install` may pick, without naming the intent. `latest` is a deliberate,
 * greppable statement of "track the package"; `^0.3.0` is an accident waiting to
 * resolve. Non-`latest` dist-tags (`next`, `beta`) are rejected for the same
 * reason plus the obvious one: they publish unreviewed prereleases.
 *
 * @param {string} specifier
 * @returns {{ kind: "dist-tag" | "registry" | "tarball" | "rejected", tag?: string, reason?: string }}
 */
function classifyDependencySpecifier(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    return { kind: "rejected", reason: "missing specifier" };
  }
  if (specifier === "latest") {
    return { kind: "dist-tag", tag: "latest" };
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
  // Bare word: a dist-tag. Only `latest` is sanctioned, and it was accepted
  // above; anything else here is `next` / `beta` / a one-off publish tag.
  if (/^[A-Za-z][\w.-]*$/.test(specifier)) {
    return { kind: "rejected", reason: "dist-tag other than `latest`" };
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
    { specifier: "~0.3.0", reason: "non-exact version range" },
    { specifier: ">=0.3.0", reason: "non-exact version range" },
    { specifier: "0.3.x", reason: "non-exact version range" },
    { specifier: "*", reason: "non-exact version range" },
    { specifier: "next", reason: "dist-tag other than `latest`" },
    { specifier: "beta", reason: "dist-tag other than `latest`" },
    { specifier: "", reason: "missing specifier" },
  ])("rejects $specifier", ({ specifier, reason }) => {
    expect(classifyDependencySpecifier(specifier)).toEqual({ kind: "rejected", reason });
  });

  it("accepts the `latest` dist-tag, which is how the plugin inherits the package's default profile", () => {
    expect(classifyDependencySpecifier("latest")).toEqual({ kind: "dist-tag", tag: "latest" });
  });

  it("accepts an exact registry version, which is the emergency-rollback pin", () => {
    expect(classifyDependencySpecifier("0.1.0")).toEqual({ kind: "registry" });
    expect(classifyDependencySpecifier("0.3.0")).toEqual({ kind: "registry" });
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

  it("records a lockfile integrity hash for the resolved artifact", () => {
    const specifier = manifest.dependencies?.[packageName];
    const entry = lockfile.packages?.[`node_modules/${packageName}`];

    expect(entry).toBeDefined();
    expect(entry.version).toMatch(exactVersion);
    expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    expect(entry.license).toBe(packageLicense);

    // The lockfile, not the specifier, is what makes the install reproducible —
    // that is the whole basis for allowing a `latest` dist-tag. So `resolved` is
    // checked against the lock's OWN `version`: it must be the registry tarball
    // for exactly the version the lock claims, which catches a lock pointing at
    // a different version or at a non-registry mirror.
    const classification = classifyDependencySpecifier(specifier);
    if (classification.kind === "tarball") {
      // A tarball specifier IS the resolved artifact, so the two are byte-identical.
      expect(entry.resolved).toBe(specifier);
      return;
    }

    expect(entry.resolved).toBe(
      `https://registry.npmjs.org/${packageName}/-/claude-code-wire-compat-${entry.version}.tgz`,
    );

    // An exact pin additionally has to agree with the lock; a dist-tag has
    // nothing to agree with, by construction.
    if (classification.kind === "registry") {
      expect(entry.version).toBe(specifier);
    }
  });

  it("documents the specifier policy actually in force", () => {
    const specifier = manifest.dependencies?.[packageName];
    const classification = classifyDependencySpecifier(specifier);
    const entry = lockfile.packages?.[`node_modules/${packageName}`];

    if (classification.kind === "tarball") {
      expect(provenance).toContain(classification.tag);
      expect(provenance).toContain(entry?.integrity);
      expect(provenance).toMatch(/npm registry|registry version|from npm/i);
      return;
    }

    if (classification.kind === "dist-tag") {
      // Deliberately NOT a literal-version assertion. Requiring the doc to name
      // the resolved version would re-pin by the back door: the version moves on
      // every `npm update`, and a doc that has to be edited in lockstep would
      // either rot or push people back to an exact pin. What must be documented
      // is the POLICY and where reproducibility actually lives.
      expect(provenance).toContain("latest");
      expect(provenance).toContain("package-lock.json");
      expect(provenance).toMatch(/npm ci/);
      expect(provenance).toMatch(/npm registry|registry version|from npm/i);
      return;
    }

    expect(provenance).toContain(entry?.version);
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

  it("pins real commit identifiers instead of placeholders", () => {
    // A runbook that says `<sha-of-something>` is useless at the moment it is
    // needed, which is the exact improvisation this document argues against.
    expect(provenance).not.toMatch(/<\s*sha/i);
    expect(provenance).not.toMatch(/<[^>\n]*commit[^>\n]*>/i);
    expect(provenance).not.toMatch(/<[^>\n]*sha[^>\n]*>/i);

    const commitIdentifiers = new Set([...provenance.matchAll(/\b[0-9a-f]{7,40}\b/g)].map((match) => match[0]));
    expect(commitIdentifiers.size).toBeGreaterThanOrEqual(2);
    expect(provenance).toMatch(/git revert --no-edit [0-9a-f]{7,40}/);
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
