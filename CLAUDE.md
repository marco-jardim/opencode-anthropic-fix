# Agent Entry Point

For deeper architecture and contributor guidance, see [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this repo is

This repository contains an `opencode` plugin and standalone CLI that let Claude Pro/Max subscribers authenticate via OAuth, rotate multiple accounts, and mimic Anthropic's official Claude Code CLI on the wire so the API accepts requests. `opencode` is the host agent, while Claude Code is the distinct mimicry target; see the [agent-native audit](docs/agent-native-audit.md).

## Golden rules

- **Docs are the contract:** any wire change to headers, betas, system prompt, or body shape requires matching updates to [the HTTP mimicry contract](docs/mimese-http-header-system-prompt.md) **and** [the conformance regression suite](test/conformance/regression.test.mjs).
- **OAuth first:** under OAuth, `oauth-2025-04-20` is always present in `anthropic-beta`.
- **No TypeScript:** use `.mjs` and JSDoc only.
- Do not add another heavy production dependency. The two production dependencies are `@openauthjs/openauth` and `xxhash-wasm`.
- Changes to `rateLimitResetTimes` or `consecutiveFailures` in `anthropic-accounts.json` require a migration path.
- The system-prompt sanitization `OpenCode → Claude Code` applies **only** to the system prompt sent to Anthropic—never to code, docs, or paths.

## Decision tables index

- [Beta decision table](docs/mimicry/beta-decision-table.md)
- [Rotation strategy decision table](docs/mimicry/strategy-decision-table.md)

Syncing a new Claude Code version → consult beta-decision-table.md + `docs/mimese-http-header-system-prompt.md` + `test/conformance/regression.test.mjs`.

For a rotation-strategy change, consult [strategy-decision-table.md](docs/mimicry/strategy-decision-table.md) before editing the rotation or retry paths.

## Release ritual

Follow this exact order (source: [AGENTS.md, “Release flow”](AGENTS.md#release-flow)):

1. Run `npm run check:invariants` (the sources-of-truth guard added in W0·P0.4).
2. Run `npm version patch --no-git-tag-version`.
3. Create a separate `chore: bump version to X.Y.Z` commit.
4. Create the matching git tag `vX.Y.Z`.
5. Run `npm run build`.
6. Push to `master`; `.github/workflows/publish.yml` auto-publishes to npm only when `package.json` changed versus `HEAD~1`.

## Parallel-safety & commit-often

For multi-agent work, respect file-ownership locks and treat `index.mjs` as one global write-lock. Commit each subtask separately with a conventional prefix; see [§A2 (parallelism/write-safety) and §A3 (commit-often)](docs/plans/agent-native-remediation-plan.md).

## Where things live

Use `node cli.mjs diagnose` (or `dg`) to create a redacted diagnostic bundle; pass `--stdout` to print it.

| Subsystem                                                                                                                    | Location                               |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| OAuth, fetch interceptor, retry/overload loop, request/response mimicry, and token-economy state machines                    | `index.mjs`                            |
| Standalone CLI; `/anthropic` dispatches in-process                                                                           | `cli.mjs`                              |
| OAuth, accounts, rotation, backoff, config, storage, refresh-lock, cc-credentials, account-state, redact, and tuning modules | `lib/*.mjs`                            |
| Separate Cloudflare Workers subproject and upstream Claude Code version watcher                                              | `worker/sync-watcher/`                 |
| Research and the mimicry contract                                                                                            | `docs/`                                |
| Mimicry regression oracle                                                                                                    | `test/conformance/regression.test.mjs` |
