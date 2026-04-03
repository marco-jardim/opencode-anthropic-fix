/**
 * Canonical hashing for extracted contracts.
 * Produces deterministic JSON (sorted keys, sorted arrays)
 * and a SHA-256 hash (first 16 hex chars) for change detection.
 */

/**
 * Produce a deterministic canonical JSON string from any value.
 *
 * Rules:
 *  - Object keys are sorted alphabetically (recursively at every depth)
 *  - Array elements are sorted by their own canonical string representation
 *    (lexicographic on the serialised form — correct for string[] payloads;
 *     objects are compared by their canonical JSON)
 *  - `null` is serialised as `"null"`
 *  - Primitive scalars (string, number, boolean) delegate to JSON.stringify
 *  - No whitespace in output
 *
 * @param {any} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null || value === undefined) {
    return "null";
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    items.sort(); // lexicographic on canonical form
    return "[" + items.join(",") + "]";
  }

  if (typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const pairs = sortedKeys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]));
    return "{" + pairs.join(",") + "}";
  }

  // string | number | boolean | undefined — let JSON.stringify handle quoting/escaping
  return JSON.stringify(value);
}

/**
 * Compute SHA-256 hash of a contract and return the first 16 hex chars.
 * Uses the Web Crypto API so it runs in Cloudflare Workers without Node built-ins.
 *
 * @param {import('./types.mjs').ExtractedContract} contract
 * @returns {Promise<string>} 16-character lowercase hex string
 */
export async function hashContract(contract) {
  const json = canonicalize(contract);
  const encoder = new TextEncoder();
  const data = encoder.encode(json);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
