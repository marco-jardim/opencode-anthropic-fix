/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isTruthyEnv(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isFalsyEnv(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}
