/**
 * Tests for tarball.mjs — tar parser and cli.js extraction.
 *
 * Because Cloudflare's DecompressionStream is not available in Node vitest,
 * we test extractFromTar directly (the pure-JS ustar parser) using
 * hand-crafted tar buffers. The downloadAndExtractCli integration path
 * is covered separately by mocking fetch and decompressGzip.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { extractFromTar, downloadAndExtractCli } from "../src/tarball.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid ustar tar archive containing one file.
 * Header is 512 bytes; content is padded to the next 512-byte boundary.
 *
 * @param {string} filename - file path inside archive (max 99 chars)
 * @param {string} content  - file content (UTF-8)
 * @returns {Uint8Array}
 */
function buildTar(filename, content) {
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content);
  const size = contentBytes.length;

  // 512-byte header
  const header = new Uint8Array(512);

  // Filename (bytes 0-99)
  const nameBytes = encoder.encode(filename);
  header.set(nameBytes.slice(0, 100), 0);

  // File mode (bytes 100-107) — "0000644\0"
  const mode = encoder.encode("0000644\0");
  header.set(mode, 100);

  // UID (bytes 108-115) — "0000000\0"
  const uid = encoder.encode("0000000\0");
  header.set(uid, 108);

  // GID (bytes 116-123) — "0000000\0"
  header.set(uid, 116);

  // File size in octal (bytes 124-135), padded to 11 chars + null
  const sizeStr = size.toString(8).padStart(11, "0") + "\0";
  header.set(encoder.encode(sizeStr), 124);

  // Mtime (bytes 136-147) — zeros OK for test
  // Typeflag (bytes 156) — '0' = regular file
  header[156] = 0x30; // '0'

  // Compute checksum (bytes 148-155) — sum of all bytes with checksum field as spaces
  header.fill(0x20, 148, 156); // fill checksum with spaces first
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  const checksumStr = checksum.toString(8).padStart(6, "0") + "\0 ";
  header.set(encoder.encode(checksumStr), 148);

  // Content block (padded to 512-byte boundary)
  const contentBlockSize = Math.ceil(size / 512) * 512;
  const contentBlock = new Uint8Array(contentBlockSize);
  contentBlock.set(contentBytes, 0);

  // Two 512-byte zero blocks = end-of-archive
  const eoa = new Uint8Array(1024);

  // Combine
  const total = new Uint8Array(512 + contentBlockSize + 1024);
  total.set(header, 0);
  total.set(contentBlock, 512);
  total.set(eoa, 512 + contentBlockSize);
  return total;
}

/**
 * Build a tar with multiple files.
 */
function buildMultiFileTar(files) {
  const parts = files.map(({ filename, content }) => buildTar(filename, content));
  // Remove the two trailing EOA blocks from all but last
  const blocks = parts.map((p, i) => (i < parts.length - 1 ? p.slice(0, -1024) : p));
  const totalLen = blocks.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const b of blocks) {
    result.set(b, off);
    off += b.length;
  }
  return result;
}

// ─── extractFromTar ───────────────────────────────────────────────────────────

describe("extractFromTar", () => {
  it("extracts a file that matches the first candidate path", () => {
    const tar = buildTar("package/cli.js", "console.log('hello');");
    const result = extractFromTar(tar, ["package/cli.js", "package/cli.mjs"]);
    expect(result).toBe("console.log('hello');");
  });

  it("falls back to second candidate path when first is not present", () => {
    const tar = buildTar("package/cli.mjs", "export default {};");
    const result = extractFromTar(tar, ["package/cli.js", "package/cli.mjs"]);
    expect(result).toBe("export default {};");
  });

  it("returns null when no candidate path matches", () => {
    const tar = buildTar("package/index.js", "// unrelated");
    const result = extractFromTar(tar, ["package/cli.js", "package/cli.mjs"]);
    expect(result).toBeNull();
  });

  it("returns null for an empty tar archive (all zeros)", () => {
    const empty = new Uint8Array(1024); // two zero blocks = end-of-archive
    const result = extractFromTar(empty, ["package/cli.js"]);
    expect(result).toBeNull();
  });

  it("returns null for a tar shorter than one header (< 512 bytes)", () => {
    const short = new Uint8Array(100);
    const result = extractFromTar(short, ["package/cli.js"]);
    expect(result).toBeNull();
  });

  it("strips leading ./ from filename before matching", () => {
    // Manually build a tar where filename starts with "./"
    const tar = buildTar("./package/cli.js", "stripped");
    const result = extractFromTar(tar, ["package/cli.js"]);
    expect(result).toBe("stripped");
  });

  it("handles multi-file tar and finds the correct file", () => {
    const tar = buildMultiFileTar([
      { filename: "package/README.md", content: "# readme" },
      { filename: "package/cli.js", content: "var version='2.1.91'" },
      { filename: "package/package.json", content: '{"name":"test"}' },
    ]);
    const result = extractFromTar(tar, ["package/cli.js"]);
    expect(result).toBe("var version='2.1.91'");
  });

  it("handles a file with size exactly at 512-byte block boundary", () => {
    const content = "x".repeat(512);
    const tar = buildTar("package/cli.js", content);
    const result = extractFromTar(tar, ["package/cli.js"]);
    expect(result).toBe(content);
  });

  it("handles a file with size of 1 byte (minimum non-empty file)", () => {
    const tar = buildTar("package/cli.js", "!");
    const result = extractFromTar(tar, ["package/cli.js"]);
    expect(result).toBe("!");
  });

  it("stops at end-of-archive (all-zero header block) and returns null for file after it", () => {
    // Build: valid file then EOA then another file — the second file must not be found
    const first = buildTar("package/other.js", "first");
    // Remove the EOA from first, add a second file entry after EOA
    // The EOA is the last 1024 bytes of first
    const secondEntry = buildTar("package/cli.js", "unreachable");
    const combined = new Uint8Array(first.length + secondEntry.length);
    combined.set(first, 0);
    combined.set(secondEntry, first.length);
    // "first" already has EOA, so extractFromTar should stop there
    const result = extractFromTar(combined, ["package/cli.js"]);
    expect(result).toBeNull();
  });

  it("returns null on corrupted header (NaN size)", () => {
    const tar = new Uint8Array(512 + 512 + 1024); // header + one content block + EOA
    const encoder = new TextEncoder();
    // Write garbage in size field (bytes 124-135)
    tar.set(encoder.encode("XXXXXXXX\0\0\0"), 124);
    // Give it a filename so it tries to parse
    tar.set(encoder.encode("package/cli.js\0"), 0);
    // Result: size is NaN → should break and return null
    const result = extractFromTar(tar, ["package/cli.js"]);
    expect(result).toBeNull();
  });
});

// ─── downloadAndExtractCli ────────────────────────────────────────────────────

// Use an allowlisted host for download tests
const ALLOWED_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.91.tgz";
const DISALLOWED_URL = "https://evil.example.com/pkg.tgz";

describe("downloadAndExtractCli", () => {
  it("throws when tarball download returns non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({}),
      }),
    );

    await expect(downloadAndExtractCli(ALLOWED_URL)).rejects.toThrow("404");
  });

  it("throws when content-length header exceeds MAX_BUNDLE_SIZE", async () => {
    const oversizeBytes = (11 * 1024 * 1024).toString(); // 11 MB
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": oversizeBytes }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    );

    await expect(downloadAndExtractCli(ALLOWED_URL)).rejects.toThrow("size limit");
  });

  it("throws on request timeout (AbortError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }),
    );

    await expect(downloadAndExtractCli(ALLOWED_URL)).rejects.toThrow("timed out");
  });

  it("throws when tarball URL host is not allowlisted (SSRF protection)", async () => {
    await expect(downloadAndExtractCli(DISALLOWED_URL)).rejects.toThrow("allowlisted");
  });

  it("throws on invalid tarball URL", async () => {
    await expect(downloadAndExtractCli("not-a-url")).rejects.toThrow("Invalid tarball URL");
  });

  // Note: The gzip decompression failure test is omitted here because Node's
  // DecompressionStream emits errors asynchronously in a way that differs from
  // the Cloudflare Workers runtime (where it throws synchronously). The behavior
  // is covered by the tarball error handling in production; extractFromTar itself
  // is tested comprehensively above.
});
