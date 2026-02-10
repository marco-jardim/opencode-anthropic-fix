# CLI Enhancements: Full Account Management

**Status:** Complete
**Created:** 2026-02-09
**Completed:** 2026-02-09

---

## Problem Statement

The plugin CLI (`opencode-anthropic-auth`) can **manage** existing accounts (enable, disable, remove, switch, reset) but cannot **authenticate** new ones or re-authenticate broken ones. The only way to add an account is through `opencode auth login` → selecting "Claude Pro/Max" → browser OAuth flow inside the OpenCode TUI.

This creates friction in several scenarios:

1. **Disabled account recovery** — Account #1 was disabled due to a token refresh failure. To fix it, you'd have to `remove` it via CLI, then re-login via `opencode auth login`, which is the exact workflow we want to avoid.
2. **No re-authentication** — There's no way to get fresh tokens for an existing broken account without deleting and re-adding it.
3. **No proper logout** — The `remove` command just deletes local data without revoking tokens server-side.
4. **Incomplete standalone tool** — The CLI should be a self-contained account management tool that doesn't depend on the OpenCode TUI for any operation.

## Solution Overview

Add four new commands to `cli.mjs` that give full account lifecycle management:

| Command        | Alias | Description                                        |
| -------------- | ----- | -------------------------------------------------- |
| `login`        | `ln`  | Add a new account via browser OAuth flow           |
| `logout <N>`   | `lo`  | Revoke tokens + remove a specific account          |
| `logout --all` | —     | Revoke all tokens + clear all accounts             |
| `reauth <N>`   | `ra`  | Re-authenticate an account with fresh OAuth tokens |
| `refresh <N>`  | `rf`  | Attempt token refresh without browser (quick fix)  |

### Architecture Change

Extract the OAuth `authorize()` and `exchange()` functions from `index.mjs` into a new shared module `lib/oauth.mjs`, plus add a new `revoke()` function. Both `index.mjs` (plugin) and `cli.mjs` (standalone) import from this shared module.

```
lib/oauth.mjs (NEW)
  ├── authorize(mode)          — Generate PKCE + build auth URL
  ├── exchange(code, verifier) — Exchange auth code for tokens
  └── revoke(refreshToken)     — Revoke a refresh token (best-effort)
```

## Design Decisions

| Decision              | Choice               | Rationale                                                               |
| --------------------- | -------------------- | ----------------------------------------------------------------------- |
| Reauth matching       | Replace at index     | Simpler UX; user explicitly chooses which slot to replace               |
| Logout behavior       | Revoke + remove      | Clean break; user can re-add via `login`                                |
| Token refresh command | Yes, add `refresh`   | Quick fix for expired access tokens without browser round-trip          |
| Browser opening       | Auto-open + show URL | Best UX: tries `open`/`xdg-open`/`start`, always prints URL as fallback |

## Detailed Command Specifications

### `login` (alias: `ln`)

**Flow:**

1. Call `authorize("max")` to get PKCE URL + verifier
2. Auto-open the URL in the user's default browser
3. Print the URL to terminal as fallback
4. Prompt user to paste the authorization code (readline)
5. Call `exchange(code, verifier)` to get tokens
6. Deduplicate: check if an account with the same refresh token already exists
7. Add the account to `anthropic-accounts.json`, save, print confirmation

**Edge cases:**

- If exchange fails, print error and exit with code 1
- If max accounts (10) reached, print error
- If duplicate refresh token, update existing account instead of adding

### `logout <N>` (alias: `lo <N>`)

**Flow:**

1. Validate index N exists
2. Attempt `revoke(account.refreshToken)` — best-effort, won't block on failure
3. Remove the account from array (splice)
4. Adjust `activeIndex` if needed (same logic as existing `remove` command)
5. Save + print confirmation

**Flags:**

- `--force` — Skip confirmation prompt (same as `remove`)
- `--all` — Logout all accounts

### `logout --all`

**Flow:**

1. Iterate all accounts, attempt `revoke()` for each
2. Write explicit empty storage `{ version: 1, accounts: [], activeIndex: 0 }`
3. Print confirmation with count of revoked accounts

**Important behavior:** empty storage is treated as authoritative by `AccountManager.load()`, so plugin instances stay logged out and do not re-bootstrap from fallback auth when the accounts file explicitly contains zero accounts.

### `reauth <N>` (alias: `ra <N>`)

**Flow:**

1. Validate index N exists
2. Run full OAuth flow (same as `login` steps 1-5)
3. Replace the account at index N with the new tokens
4. Preserve: `id`, `addedAt`, `stats`
5. Reset: `enabled=true`, `consecutiveFailures=0`, `lastFailureTime=null`, `rateLimitResetTimes={}`
6. Save + print confirmation

**Key detail:** Replaces whatever's at index N with whatever the user logs in with, regardless of email matching.

### `refresh <N>` (alias: `rf <N>`)

**Flow:**

1. Validate index N exists
2. Call the existing `refreshAccessToken(account)` function
3. If success: update account, re-enable if disabled, save + print new token expiry
4. If failure: print error and suggest `reauth <N>` instead

## Files Modified

| File                | Change                                                               | Status |
| ------------------- | -------------------------------------------------------------------- | ------ |
| `lib/oauth.mjs`     | **NEW** — Extracted `authorize()`, `exchange()`, plus new `revoke()` | Done   |
| `index.mjs`         | Replace inline OAuth functions with imports from `lib/oauth.mjs`     | Done   |
| `cli.mjs`           | Add 5 new commands + browser opener utility                          | Done   |
| `scripts/build.mjs` | No change needed — esbuild follows imports automatically             | N/A    |

## Task List

- [x] **Task 1:** Create `lib/oauth.mjs` — extract `authorize()` and `exchange()` from `index.mjs`, add `revoke()`
- [x] **Task 2:** Update `index.mjs` — replace inline functions with imports from `lib/oauth.mjs`
- [x] **Task 3:** Add `openBrowser()` utility to `cli.mjs`
- [x] **Task 4:** Implement `cmdLogin` in `cli.mjs`
- [x] **Task 5:** Implement `cmdLogout` and `cmdLogoutAll` in `cli.mjs`
- [x] **Task 6:** Implement `cmdReauth` in `cli.mjs`
- [x] **Task 7:** Implement `cmdRefresh` in `cli.mjs`
- [x] **Task 8:** Wire new commands into `main()` dispatcher and update `cmdHelp()`
- [x] **Task 9:** Build — passes (esbuild picks up `lib/oauth.mjs` automatically)
- [x] **Task 10:** Tests — all 349 tests pass across 7 test files, zero failures
- [x] **Task 11:** Lint — eslint passes cleanly
- [x] **Task 12:** Live verification — `refresh 1` correctly fails (broken token), `refresh 2` succeeds (7h 59m expiry)
- [x] **Task 13:** Update this document with completion status

## Token Revocation Notes

Anthropic's OAuth implementation may or may not support RFC 7009 token revocation at `POST /v1/oauth/revoke`. The `revoke()` function is implemented as best-effort:

- Attempts `POST https://console.anthropic.com/v1/oauth/revoke` with `{ token: refreshToken, token_type_hint: "refresh_token", client_id: CLIENT_ID }`
- Returns `true` if 2xx response, `false` otherwise
- `logout` proceeds with local cleanup regardless of revocation result
- No error is surfaced to the user if revocation fails — only a dim note

## Immediate Use Case

To fix the disabled account #1:

```bash
# Option A: Try a token refresh first (no browser)
opencode-anthropic-auth refresh 1
# Tested: correctly fails with "token refresh failed" and suggests reauth

# Option B: If refresh fails, do a full re-auth
opencode-anthropic-auth reauth 1

# Option C: Full nuke and re-login
opencode-anthropic-auth logout 1
opencode-anthropic-auth login
```

**Verified:** `refresh 2` (healthy account) succeeds and reports "Token refreshed, expires in 7h 59m".

## Updated Help Text (Preview)

```
Anthropic Multi-Account Auth CLI

Usage:
  opencode-anthropic-auth [command] [args]

Commands:
  list              Show all accounts with status (default)
  status            Compact one-liner for scripts/prompts
  login             Add a new account via browser OAuth flow
  logout <N>        Revoke tokens and remove account N
  logout --all      Revoke all tokens and clear all accounts
  reauth <N>        Re-authenticate account N with fresh OAuth tokens
  refresh <N>       Attempt token refresh (no browser needed)
  switch <N>        Set account N as active
  enable <N>        Enable a disabled account
  disable <N>       Disable an account (skipped in rotation)
  remove <N>        Remove an account permanently
  reset <N|all>     Clear rate-limit / failure tracking
  stats             Show per-account usage statistics
  reset-stats [N|all] Reset usage statistics
  strategy [name]   Show or change selection strategy
  config            Show configuration and file paths
  manage            Interactive account management menu
  help              Show this help message
```

## Post-Review Remediations

Following delegated code review, the following fixes were applied:

1. **Logout-all semantics hardened**
   - `cmdLogoutAll` now writes explicit empty account storage instead of deleting the accounts file.
   - `AccountManager.load` now treats existing storage (including empty storage) as authoritative, preventing fallback re-bootstrap when users explicitly logout-all.

2. **Windows browser launch fixed**
   - `openBrowser` now uses `cmd /c start "" <url>` on Windows for correct URL handling.

3. **Reauth state message bug fixed**
   - `cmdReauth` now captures prior disabled state (`wasDisabled`) before mutation and correctly prints "re-enabled" message when applicable.

4. **Login dedupe ordering corrected**
   - `cmdLogin` now performs duplicate-token update path before applying max-account rejection, so existing accounts can still be refreshed when at capacity.

5. **Unit test coverage expanded for new auth commands**
   - Added direct CLI unit tests for `cmdLogin`, `cmdLogout` (single + `--all`), `cmdReauth`, and `cmdRefresh`.
   - Added main routing tests for new aliases/paths: `ln`, `lo --all --force`, `ra`, and `rf`.
   - Added help text assertions for new commands/examples.
