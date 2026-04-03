/**
 * npm registry metadata fetcher with ETag-based caching.
 *
 * Polls registry.npmjs.org for the latest version of a package and returns
 * the tarball URL. Uses KV to persist ETag so we only download when something
 * actually changed.
 *
 * @module registry
 */

const REGISTRY_BASE = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

/**
 * @typedef {Object} RegistryMetadata
 * @property {string} version - Latest version string e.g. "2.1.91"
 * @property {string} tarballUrl - URL to the .tgz tarball
 * @property {string|null} etag - ETag from registry response (for caching)
 * @property {boolean} notModified - True if 304 response (ETag matched, no change)
 */

/**
 * Fetch the latest npm registry metadata for a package.
 * Uses ETag caching: if the registry returns 304 Not Modified, returns
 * `{ notModified: true }` without re-downloading.
 *
 * @param {string} packageName - e.g. "@anthropic-ai/claude-code"
 * @param {string|null} cachedEtag - ETag from previous fetch (stored in KV)
 * @returns {Promise<RegistryMetadata>}
 * @throws {Error} on non-retryable error after MAX_RETRIES attempts
 */
export async function fetchRegistryMetadata(packageName, cachedEtag = null) {
  // Encode scoped package names: @scope/name → @scope%2Fname
  const encodedName = encodePackageName(packageName);
  const url = `${REGISTRY_BASE}/${encodedName}/latest`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s
      await sleep(1000 * attempt);
    }

    try {
      const headers = { Accept: "application/json" };
      if (cachedEtag) {
        headers["If-None-Match"] = cachedEtag;
      }

      const response = await fetchWithTimeout(url, { headers }, FETCH_TIMEOUT_MS);

      if (response.status === 304) {
        return { version: "", tarballUrl: "", etag: cachedEtag, notModified: true };
      }

      if (response.status === 200) {
        const data = await response.json();
        const version = data.version;
        const tarballUrl = data.dist?.tarball;

        if (!version || !tarballUrl) {
          throw new Error(`Registry response missing version or tarball URL for ${packageName}`);
        }

        const etag = response.headers.get("etag") ?? null;
        return { version, tarballUrl, etag, notModified: false };
      }

      // Non-retryable client errors
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Registry returned ${response.status} for ${packageName}`);
      }

      // Server errors — retryable
      lastError = new Error(`Registry returned ${response.status} for ${packageName}`);
    } catch (err) {
      if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
        lastError = new Error(`Registry request timed out for ${packageName}`);
      } else if (err.message?.includes("Registry returned 4") || err.message?.includes("missing version or tarball")) {
        // Non-retryable — data error or client error, rethrow immediately
        throw err;
      } else {
        lastError = err;
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch registry metadata for ${packageName}`);
}

/**
 * Encode a package name for use in a URL path.
 * Scoped packages: @scope/name → @scope%2Fname
 *
 * @param {string} name
 * @returns {string}
 */
export function encodePackageName(name) {
  if (name.startsWith("@")) {
    // Encode the slash between scope and package name only
    const slashIdx = name.indexOf("/");
    if (slashIdx !== -1) {
      return name.slice(0, slashIdx) + "%2F" + name.slice(slashIdx + 1);
    }
  }
  return name;
}

/**
 * Fetch with an explicit timeout.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      timeoutErr.name = "TimeoutError";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
