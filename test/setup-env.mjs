/**
 * Strip OAuth environment variables before every test file.
 *
 * `AccountManager.load(config, authFallback, env = process.env)` and the
 * `CLAUDE_CODE_CUSTOM_OAUTH_URL` guard inside `authorize()` both fall back to the
 * real process environment. Most suites call them with fewer arguments, so a
 * developer or CI runner that happens to export one of these variables would
 * silently change what the suite exercises: an extra seeded account breaks every
 * account-count assertion, and an unapproved custom URL makes `authorize()` throw
 * across the board.
 *
 * Clearing them here makes the suite hermetic without forcing every call site to
 * thread an explicit `env` through. Tests that exercise these variables pass an
 * explicit object instead of mutating the global environment.
 *
 * @see docs/oauth-2.1.280-contract.md §5
 */
import { beforeEach } from "vitest";

const OAUTH_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE",
  "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
];

for (const key of OAUTH_ENV_KEYS) delete process.env[key];

beforeEach(() => {
  for (const key of OAUTH_ENV_KEYS) delete process.env[key];
});
