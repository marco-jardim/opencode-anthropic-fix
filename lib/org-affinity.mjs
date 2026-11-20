/**
 * Org-affinity primitives for organization-locked thinking.
 *
 * For models with the `org_locked_thinking` capability, thinking blocks written
 * under one organization cannot be replayed under another. The genuine client
 * never switches organization mid-conversation, so the faithful behaviour is to
 * keep a conversation on one organization (stickiness). Stripping prior thinking
 * is an opt-in fallback when no same-organization account is usable.
 *
 * Everything here is pure: no I/O and no module-level state. The only state is
 * the tracker instance returned by `createOrgAffinityTracker`.
 */

/**
 * @typedef {object} OrgAffinityAccount
 * @property {string} [organizationUuid]
 * @property {boolean} [enabled]
 */

/**
 * @typedef {object} OrgAffinityTracker
 * @property {(sessionKey: string, organizationUuid: string) => void} note
 * @property {(sessionKey: string) => string | null} preferredOrganization
 * @property {(sessionKey: string) => void} forget
 */

const DEFAULT_MAX_SESSIONS = 256;

/**
 * Create a bounded, least-recently-noted map of session key -> organization.
 * @param {{ maxSessions?: number }} [options]
 * @returns {OrgAffinityTracker}
 */
export function createOrgAffinityTracker({ maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
  const limit = Number.isFinite(maxSessions) && maxSessions >= 1 ? Math.floor(maxSessions) : DEFAULT_MAX_SESSIONS;
  /** @type {Map<string, string>} insertion order == recency order (oldest first) */
  const sessions = new Map();

  return {
    /**
     * Record the organization that served a session. Refreshes recency.
     * @param {string} sessionKey
     * @param {string} organizationUuid
     */
    note(sessionKey, organizationUuid) {
      if (!sessionKey || !organizationUuid) return;
      sessions.delete(sessionKey);
      sessions.set(sessionKey, organizationUuid);
      while (sessions.size > limit) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
    },

    /**
     * @param {string} sessionKey
     * @returns {string | null}
     */
    preferredOrganization(sessionKey) {
      if (!sessionKey) return null;
      return sessions.get(sessionKey) ?? null;
    },

    /**
     * @param {string} sessionKey
     */
    forget(sessionKey) {
      sessions.delete(sessionKey);
    },
  };
}

/**
 * Choose an account in the preferred organization.
 * Returns `current` when it already belongs to the preferred org, else the first
 * usable account in that org, else null (caller decides how to degrade).
 * @template {OrgAffinityAccount} T
 * @param {{
 *   accounts: readonly T[],
 *   preferredOrg: string | null | undefined,
 *   current?: T | null,
 *   isUsable?: (account: T) => boolean,
 * }} params
 * @returns {T | null}
 */
export function pickOrgAffinityAccount({ accounts, preferredOrg, current = null, isUsable = () => true }) {
  if (!preferredOrg) return null;
  if (current && current.organizationUuid === preferredOrg) return current;
  for (const account of accounts) {
    if (account.organizationUuid === preferredOrg && isUsable(account)) return account;
  }
  return null;
}

/**
 * @param {unknown} block
 * @returns {boolean}
 */
function isThinkingBlock(block) {
  if (!block || typeof block !== "object") return false;
  const type = /** @type {{ type?: unknown }} */ (block).type;
  return type === "thinking" || type === "redacted_thinking";
}

/**
 * Remove `thinking` / `redacted_thinking` blocks from every assistant message
 * except the latest one. Never mutates the input. An assistant message is
 * dropped only when stripping leaves it with no content.
 * @template {{ role?: string, content?: unknown }} M
 * @param {readonly M[]} messages
 * @returns {M[]}
 */
export function stripPriorThinking(messages) {
  if (!Array.isArray(messages)) return /** @type {M[]} */ (messages);

  let latestAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      latestAssistant = i;
      break;
    }
  }

  /** @type {M[]} */
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (i === latestAssistant || message?.role !== "assistant" || !Array.isArray(message.content)) {
      result.push(message);
      continue;
    }
    if (!message.content.some(isThinkingBlock)) {
      result.push(message);
      continue;
    }
    const content = message.content.filter((block) => !isThinkingBlock(block));
    if (content.length === 0) continue;
    result.push({ ...message, content });
  }
  return result;
}
