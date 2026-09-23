/**
 * Every value here is transcribed from docs/oauth-2.1.280-contract.md, the local
 * contract for the genuine Claude Code 2.1.280 OAuth surface, recorded from
 * section 13.8 of the bundle analysis. No value may be guessed or interpolated
 * from another release.
 *
 * Scope: this module holds only the constants this plugin actually emits. The
 * contract also records the OIDC federation surface (contract §2.4, §3), which
 * this plugin deliberately does not implement — see divergence D12. Its
 * constants are intentionally absent here rather than exported unused, so that
 * every export in this file has a live consumer and a conformance assertion.
 */

/**
 * Genuine OAuth client identifier.
 * @see docs/oauth-2.1.280-contract.md §1.1
 */
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Console authorization endpoint.
 * @see docs/oauth-2.1.280-contract.md §1
 */
export const OAUTH_CONSOLE_AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize";

/**
 * Genuine consumer authorize page on claude.com/cai/, not claude.ai.
 * This URL and OAUTH_CLAUDE_AI_ORIGIN are different and must never be collapsed.
 * @see docs/oauth-2.1.280-contract.md §1
 */
export const OAUTH_CLAUDE_AI_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";

/**
 * Consumer origin, distinct from the consumer authorize page on claude.com/cai/.
 * This origin and OAUTH_CLAUDE_AI_AUTHORIZE_URL must never be collapsed.
 * @see docs/oauth-2.1.280-contract.md §1
 */
export const OAUTH_CLAUDE_AI_ORIGIN = "https://claude.ai";

/**
 * Attested absolute token URL. The contract marks the host binding
 * [unattested-bind]: which request uses this URL is not attested. Do not fix the host.
 * @see docs/oauth-2.1.280-contract.md §1, §2.6
 */
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * OAuth code callback URI.
 * @see docs/oauth-2.1.280-contract.md §1.1
 */
export const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

/**
 * OAuth API key creation endpoint.
 * @see docs/oauth-2.1.280-contract.md §1
 */
export const OAUTH_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";

/**
 * SDK version embedded in the genuine release.
 * @see docs/oauth-2.1.280-contract.md §3
 */
export const OAUTH_SDK_VERSION = "0.112.1";

/**
 * User OAuth provider SDK user agent.
 * @see docs/oauth-2.1.280-contract.md §3
 */
export const OAUTH_SDK_USER_AGENT = `anthropic-sdk-typescript/${OAUTH_SDK_VERSION} userOAuthProvider`;

/**
 * OAuth beta identifier. Sent on every token request.
 * @see docs/oauth-2.1.280-contract.md §3
 */
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * OAuth expiry skew in seconds.
 * @see docs/oauth-2.1.280-contract.md §3
 */
export const OAUTH_EXPIRY_SKEW_SECONDS = 30;

/**
 * Approved custom OAuth endpoints, frozen to preserve the attested allowlist.
 * @see docs/oauth-2.1.280-contract.md §5.1
 */
export const OAUTH_CUSTOM_URL_ALLOWLIST = Object.freeze([
  "https://beacon.claude-ai.staging.ant.dev",
  "https://claude.fedstart.com",
  "https://claude-staging.fedstart.com",
]);

/**
 * Default local apps base URL.
 * @see docs/oauth-2.1.280-contract.md §5
 */
export const OAUTH_LOCAL_APPS_BASE_DEFAULT = "http://localhost:4000";

/**
 * Default local console base URL.
 * @see docs/oauth-2.1.280-contract.md §5
 */
export const OAUTH_LOCAL_CONSOLE_BASE_DEFAULT = "http://localhost:3000";

/**
 * Must match the genuine rejection string byte-for-byte, including its trailing full stop.
 * @see docs/oauth-2.1.280-contract.md §5.1
 */
export const OAUTH_CUSTOM_URL_REJECTION_MESSAGE = "CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.";
