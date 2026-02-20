# agents.md

This repository is OAuth-first and optimized for Claude Code request mimese.

## Operating rules

- Use OAuth login flows (`opencode-anthropic-auth login` / `reauth`) for all accounts.
- Treat direct API-key auth as out of scope for normal operation.
- Keep Claude signature emulation enabled by default unless debugging a regression.

## Request-shaping expectations

- Always include OAuth beta behavior: `oauth-2025-04-20` must be present in `anthropic-beta` when authenticated via OAuth.
- Preserve model/provider-aware beta composition logic in `index.mjs`.
- Preserve Claude-style system prompt shaping (identity block + billing header block rules).
- Keep `metadata.user_id` composition stable across account/session context.

## Change policy for contributors and agents

- Prefer minimal diffs that keep existing runtime behavior intact.
- When updating beta/header logic, update docs in `docs/mimese-http-header-system-prompt.md` and `README.md` together.
- Add or adjust tests in `index.test.mjs` for any header/system/body mimicry change.
