/**
 * Tarball downloader and cli.js extractor.
 *
 * Downloads a .tgz tarball from a URL and extracts the cli.js bundle
 * from it using pure-JS gzip + tar parsing (Workers-compatible, no Node builtins).
 *
 * @module tarball
 */

const MAX_BUNDLE_SIZE = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Candidate paths for the cli.js bundle inside the tarball, in priority order.
 */
const CLI_PATHS = ["package/cli.js", "package/cli.mjs", "package/dist/cli.js", "package/dist/cli.mjs"];

/**
 * Download a tarball and extract the cli.js content.
 *
 * @param {string} tarballUrl - URL to the .tgz tarball
 * @returns {Promise<string>} The text content of cli.js
 * @throws {Error} if download fails, bundle too large, or cli.js not found
 */
/** Allowlisted tarball hostnames — prevents SSRF from compromised registry responses */
const ALLOWED_TARBALL_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

export async function downloadAndExtractCli(tarballUrl) {
  // Validate host before fetching to prevent SSRF
  try {
    const { hostname } = new URL(tarballUrl);
    if (!ALLOWED_TARBALL_HOSTS.has(hostname)) {
      throw new Error(`Tarball host not allowlisted: ${hostname}`);
    }
  } catch (err) {
    if (err.message.includes("allowlisted")) throw err;
    throw new Error(`Invalid tarball URL: ${tarballUrl}`, { cause: err });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let arrayBuffer;
  try {
    const response = await fetch(tarballUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Tarball download failed with status ${response.status}: ${tarballUrl}`);
    }

    // Check content-length before downloading
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BUNDLE_SIZE) {
      throw new Error(`Tarball exceeds size limit (${contentLength} > ${MAX_BUNDLE_SIZE} bytes)`);
    }

    arrayBuffer = await response.arrayBuffer();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Tarball download timed out after ${FETCH_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (arrayBuffer.byteLength > MAX_BUNDLE_SIZE) {
    throw new Error(`Tarball exceeds size limit (${arrayBuffer.byteLength} > ${MAX_BUNDLE_SIZE} bytes)`);
  }

  // Decompress gzip
  let tarData;
  try {
    tarData = await decompressGzip(new Uint8Array(arrayBuffer));
  } catch (err) {
    throw new Error(`Failed to decompress tarball gzip: ${err.message}`, { cause: err });
  }

  // Extract cli.js from tar
  const cliContent = extractFromTar(tarData, CLI_PATHS);
  if (cliContent === null) {
    throw new Error(`cli.js not found in tarball. Tried: ${CLI_PATHS.join(", ")}`);
  }

  return cliContent;
}

/**
 * Decompress gzip data using the Web Streams Decompress API (Workers-compatible).
 *
 * @param {Uint8Array} compressed
 * @returns {Promise<Uint8Array>}
 */
async function decompressGzip(compressed) {
  /* global DecompressionStream */
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed);
  writer.close();

  const chunks = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Extract a specific file from a tar archive (ustar format).
 * Returns the file content as a string, or null if not found.
 *
 * @param {Uint8Array} tarData - Decompressed tar data
 * @param {string[]} candidatePaths - File paths to search for, in priority order
 * @returns {string|null}
 */
export function extractFromTar(tarData, candidatePaths) {
  const decoder = new TextDecoder("utf-8");
  let offset = 0;

  while (offset + 512 <= tarData.length) {
    const header = tarData.slice(offset, offset + 512);

    // Check for end-of-archive (two 512-byte zero blocks)
    if (isZeroBlock(header)) break;

    // Parse filename from header (bytes 0–99, null-terminated)
    const nameBytes = header.slice(0, 100);
    const prefixBytes = header.slice(345, 500); // ustar prefix field
    let name = decoder.decode(nameBytes).replace(/\0.*$/, "");
    const prefix = decoder.decode(prefixBytes).replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;

    // Parse file size (bytes 124–135, octal string)
    const sizeStr = decoder.decode(header.slice(124, 136)).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8);

    if (isNaN(size)) {
      // Corrupted header — skip
      break;
    }

    offset += 512; // Move past header

    // Check if this file matches any candidate path
    const normalizedName = name.replace(/^\.\//, "");
    if (candidatePaths.includes(normalizedName)) {
      // Extract file content
      const content = decoder.decode(tarData.slice(offset, offset + size));
      return content;
    }

    // Skip to next header (align to 512-byte boundary)
    offset += Math.ceil(size / 512) * 512;
  }

  return null;
}

/**
 * Check if a 512-byte block is all zeros (end-of-archive marker).
 *
 * @param {Uint8Array} block
 * @returns {boolean}
 */
function isZeroBlock(block) {
  for (let i = 0; i < 512; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}
