import { createHash } from "node:crypto";

const HASH_MASK_PATTERN = /^\[redacted sha256:[0-9a-f]{12}\]$/;
const AUTH_HASH_MASK_PATTERN = /^[A-Za-z][A-Za-z0-9_-]* \[redacted sha256:[0-9a-f]{12}\]$/;
const WHOLE_VALUE_KEYS = new Set(["cookie", "set-cookie", "x-api-key", "api-key"]);
const SECRET_KEYS = new Set(["access", "refreshtoken", "refresh_token", "token", "client_secret", "code", "id_token"]);

function safeString(value) {
  try {
    return String(value);
  } catch {
    return "[unprintable secret]";
  }
}

function hashMask(value) {
  const stringValue = safeString(value);
  if (HASH_MASK_PATTERN.test(stringValue)) return stringValue;

  try {
    const hash = createHash("sha256").update(stringValue).digest("hex").slice(0, 12);
    return `[redacted sha256:${hash}]`;
  } catch {
    return "[redacted]";
  }
}

function redactAuthorization(value) {
  const stringValue = safeString(value);
  if (AUTH_HASH_MASK_PATTERN.test(stringValue) || HASH_MASK_PATTERN.test(stringValue)) return stringValue;

  const scheme = stringValue.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+/)?.[1];
  const mask = hashMask(stringValue);
  return scheme ? `${scheme} ${mask}` : mask;
}

function redactEmail(value) {
  const stringValue = safeString(value);
  if (/^a\*\*\*@[^@]+$/.test(stringValue)) return stringValue;

  const separator = stringValue.lastIndexOf("@");
  if (separator <= 0 || separator === stringValue.length - 1) return hashMask(stringValue);
  return `a***${stringValue.slice(separator)}`;
}

function redactValueForKey(key, value) {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "authorization" || normalizedKey === "proxy-authorization") {
    return redactAuthorization(value);
  }
  if (WHOLE_VALUE_KEYS.has(normalizedKey) || SECRET_KEYS.has(normalizedKey)) return hashMask(value);
  if (normalizedKey === "email") return redactEmail(value);
  return undefined;
}

/**
 * Return a deep-cloned, logging-safe copy of a value.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSecrets(value) {
  try {
    const seen = new WeakMap();

    const clone = (current) => {
      if (current === null || typeof current !== "object") return current;
      if (seen.has(current)) return seen.get(current);

      let output;
      try {
        if (current instanceof Date) return new Date(current.getTime());
        if (current instanceof RegExp) return new RegExp(current.source, current.flags);
        output = Array.isArray(current) ? [] : {};
      } catch {
        return "[unavailable object]";
      }

      seen.set(current, output);

      let keys;
      try {
        keys = Object.keys(current);
      } catch {
        return output;
      }

      for (const key of keys) {
        let child;
        try {
          child = current[key];
        } catch {
          child = "[unavailable value]";
        }

        const redacted = redactValueForKey(key, child);
        const clonedValue = redacted === undefined ? clone(child) : redacted;
        try {
          Object.defineProperty(output, key, {
            value: clonedValue,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } catch {
          // A hostile object key must not prevent the remaining values from being redacted.
        }
      }

      return output;
    };

    return clone(value);
  } catch {
    return "[redaction failed]";
  }
}

/**
 * Redact a plain request or response header map.
 *
 * @param {Record<string, unknown>} headersObj
 * @returns {unknown}
 */
export function redactHeaders(headersObj) {
  return redactSecrets(headersObj);
}

/**
 * Scrub token-shaped values from a free-form diagnostic string.
 *
 * @param {unknown} str
 * @returns {string}
 */
export function redactString(str) {
  try {
    return safeString(str)
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
      .replace(/sk-ant-[A-Za-z0-9._-]+/gi, "[redacted]")
      .replace(/\boat01[A-Za-z0-9._-]{8,}\b/gi, "[redacted]");
  } catch {
    return "[redaction failed]";
  }
}
