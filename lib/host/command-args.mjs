/**
 * Parse command arguments with minimal quote support.
 * Examples: a b "c d" -> ["a", "b", "c d"]; a 'c d' -> ["a", "c d"].
 * Shared by slash dispatch and RPC credential redaction.
 * @param {string} raw
 * @returns {string[]}
 */
export function parseCommandArgs(raw) {
  if (!raw || !raw.trim()) return [];
  const parts = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    parts.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return parts;
}
