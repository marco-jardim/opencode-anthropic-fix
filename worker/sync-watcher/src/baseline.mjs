/**
 * KV-backed baseline contract store.
 *
 * Stores and retrieves the current "known good" extracted contract from
 * Cloudflare KV. The baseline is used as the reference for detecting
 * upstream changes.
 *
 * KV key layout:
 *   baseline:contract  → JSON-serialized ExtractedContract
 *   baseline:hash      → 16-char hex hash of the canonical contract
 *   registry:etag      → ETag from last npm registry fetch
 *
 * @module baseline
 */

const KEY_CONTRACT = "baseline:contract";
const KEY_HASH = "baseline:hash";
const KEY_ETAG = "registry:etag";

/**
 * @typedef {import('./types.mjs').ExtractedContract} ExtractedContract
 */

/**
 * Retrieve the stored baseline contract from KV.
 *
 * @param {KVNamespace} kv
 * @returns {Promise<{contract: ExtractedContract, hash: string}|null>} null if no baseline exists
 */
export async function getBaseline(kv) {
  const [contractJson, hash] = await Promise.all([kv.get(KEY_CONTRACT), kv.get(KEY_HASH)]);

  if (!contractJson || !hash) return null;

  try {
    const contract = JSON.parse(contractJson);
    return { contract, hash };
  } catch {
    return null;
  }
}

/**
 * Store a new baseline contract in KV.
 *
 * @param {KVNamespace} kv
 * @param {ExtractedContract} contract
 * @param {string} hash - 16-char hex hash from hashContract()
 * @returns {Promise<void>}
 */
export async function setBaseline(kv, contract, hash) {
  await Promise.all([kv.put(KEY_CONTRACT, JSON.stringify(contract)), kv.put(KEY_HASH, hash)]);
}

/**
 * Get the stored ETag for npm registry caching.
 *
 * @param {KVNamespace} kv
 * @returns {Promise<string|null>}
 */
export async function getEtag(kv) {
  return kv.get(KEY_ETAG);
}

/**
 * Store the ETag from the latest npm registry response.
 *
 * @param {KVNamespace} kv
 * @param {string} etag
 * @returns {Promise<void>}
 */
export async function setEtag(kv, etag) {
  return kv.put(KEY_ETAG, etag);
}
