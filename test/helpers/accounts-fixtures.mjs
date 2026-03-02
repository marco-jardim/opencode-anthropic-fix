/**
 * Build a stored account object with common defaults.
 * @param {Record<string, any>} [overrides]
 * @param {{
 *   index?: number,
 *   tokenFactory?: (index: number) => string,
 *   addedAtFactory?: (index: number) => number,
 * }} [options]
 */
export function makeStoredAccount(overrides = {}, options = {}) {
  const index = options.index ?? 0;
  const tokenFactory = options.tokenFactory || ((i) => `refresh-${i + 1}`);
  const addedAtFactory = options.addedAtFactory || ((i) => (i + 1) * 1000);
  const addedAt = addedAtFactory(index);

  return {
    refreshToken: tokenFactory(index),
    token_updated_at: addedAt,
    addedAt,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    ...overrides,
  };
}

/**
 * Build account storage payload from per-account overrides.
 * @param {Record<string, any>[]} [accountOverrides]
 * @param {Record<string, any>} [extra]
 * @param {{
 *   tokenFactory?: (index: number) => string,
 *   addedAtFactory?: (index: number) => number,
 * }} [options]
 */
export function makeAccountsData(accountOverrides = [{}], extra = {}, options = {}) {
  return {
    version: 1,
    accounts: accountOverrides.map((overrides, index) =>
      makeStoredAccount(overrides, {
        index,
        tokenFactory: options.tokenFactory,
        addedAtFactory: options.addedAtFactory,
      }),
    ),
    activeIndex: 0,
    ...extra,
  };
}
