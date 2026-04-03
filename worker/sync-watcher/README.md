# sync-watcher

Cloudflare Worker that automatically detects new `@anthropic-ai/claude-code` releases and either opens a PR (trivial changes) or a GitHub Issue with LLM analysis (non-trivial changes).

## How it works

```
Every 15 min (Cron Trigger)
  │
  ├─ Poll npm registry (ETag cache → skip if unchanged)
  ├─ Download tarball → extract cli.js
  ├─ Regex-extract ~20 mimese-critical constants (version, betas, OAuth, identity…)
  ├─ Diff against baseline stored in KV
  │
  ├─ No change → update baseline, done
  │
  ├─ Trivial (version + buildTime only)
  │    └─ Auto-PR: patches 5 files, opens PR on GitHub
  │
  └─ Non-trivial (betas, OAuth, identity, billing salt…)
       └─ Invoke Kimi K2.5 (Workers AI) for semantic analysis
            ├─ LLM says safe + confidence ≥ 0.8 → Auto-PR
            └─ Otherwise → GitHub Issue with full analysis
```

State machine per upstream version: `IDLE → DETECTED → ANALYZING/PR_CREATED → ISSUE_CREATED → DELIVERED`. Failures transition to `FAILED_RETRYABLE` (up to 6 retries) then `DEAD_LETTER`.

## Setup

### Prerequisites

- Cloudflare account (paid tier) with Workers, KV, and Workers AI enabled
- `wrangler` CLI: `npm install -g wrangler && wrangler login`
- GitHub PAT with `repo` scope (or Fine-grained: Contents + Pull requests + Issues read/write)

### First-time deploy

```bash
cd worker/sync-watcher

# 1. Create KV namespace (already done — IDs in wrangler.toml)
#    npx wrangler kv namespace create UPSTREAM_KV

# 2. Set GitHub token secret
npx wrangler secret put GITHUB_TOKEN

# 3. Deploy
npx wrangler deploy
```

### Configuration (`wrangler.toml`)

| Variable       | Default                               | Description                                |
| -------------- | ------------------------------------- | ------------------------------------------ |
| `GITHUB_REPO`  | `marco-jardim/opencode-anthropic-fix` | Target repo for PRs/Issues                 |
| `NPM_PACKAGE`  | `@anthropic-ai/claude-code`           | Package to watch                           |
| `AI_MODEL`     | `@cf/moonshotai/kimi-k2.5`            | Workers AI model for non-trivial analysis  |
| `LOG_LEVEL`    | `info`                                | `info` or `error`                          |
| `GITHUB_TOKEN` | _(secret)_                            | GitHub PAT — set via `wrangler secret put` |

## Development

```bash
# Install deps
npm install

# Run tests
npm test

# Watch mode
npm run test:watch

# Local dev (simulates cron + fetch handler)
npx wrangler dev
```

## Observability

Tail logs in real time:

```bash
npx wrangler tail --format pretty
```

Each pipeline run emits structured JSON logs:

```json
{ "severity": "info", "message": "stage:registry",  "duration_ms": 312 }
{ "severity": "info", "message": "stage:tarball",    "duration_ms": 1840, "version": "2.1.92" }
{ "severity": "info", "message": "stage:analyze",    "duration_ms": 4200, "llm_invoked": true,
  "approx_input_tokens": 12500, "cost_usd": "0.00803" }
{ "severity": "info", "message": "stage:deliver",    "duration_ms": 620,  "action": "create-issue" }
{ "severity": "info", "message": "pipeline complete","version": "2.1.92", "action": "create-issue",
  "number": 42, "total_duration_ms": 7210 }
```

### DEAD_LETTER alerts

If a version fails 6 times, it is dead-lettered. The alert is stored in KV under `alert:dead_letter:<version>`:

```bash
npx wrangler kv key get "alert:dead_letter:2.1.92" --namespace-id=bfc51187f2014042a882e6d6764c9cc7
```

## Troubleshooting

| Symptom                               | Check                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| No PR/Issue after new release         | `wrangler tail` — look for registry/tarball errors; check ETag (`wrangler kv key get "registry:etag"`)              |
| Duplicate PRs                         | Branch `auto/sync-<version>` already exists — idempotent check should have caught it; inspect `findExistingPR` logs |
| LLM not invoked for non-trivial diff  | Diff severity must be > trivial; check `stage:analyze` log for `llm_invoked: false`                                 |
| Version stuck in ANALYZING/PR_CREATED | Crash recovery kicks in on next cron — transitions to FAILED_RETRYABLE automatically                                |
| DEAD_LETTER state                     | Check KV alert, fix root cause, then reset: `wrangler kv key delete "state:2.1.92"`                                 |
| Wrong baseline on first run           | Seed is hardcoded in `src/seed.mjs` — update after each manual sync                                                 |

### Manual cron trigger

Via Cloudflare dashboard: **Workers → sync-watcher → Triggers → Cron Triggers → Run**.

Or force re-detection by deleting the ETag:

```bash
npx wrangler kv key delete "registry:etag" --namespace-id=bfc51187f2014042a882e6d6764c9cc7
```

## Files

```
src/
  index.mjs         Entry point — cron + fetch handlers
  types.mjs         Constants (STATES, SEVERITY, MAX_RETRIES) + JSDoc typedefs
  extractor.mjs     Regex extraction of ~20 constants from minified cli.js
  hasher.mjs        Deterministic canonical JSON + SHA-256 (Web Crypto)
  differ.mjs        Contract diff with severity classification
  registry.mjs      npm registry poller with ETag caching + retry
  tarball.mjs       .tgz downloader + pure-JS ustar tar parser
  baseline.mjs      KV-backed baseline contract storage
  state.mjs         Per-version state machine
  lock.mjs          Distributed lock (KV CAS) for cron dedup
  seed.mjs          Hardcoded v2.1.91 baseline for first-run seeding
  prompts.mjs       Kimi K2.5 system/user prompts + JSON schema
  llm.mjs           Workers AI client wrapper
  analyzer.mjs      Diff → LLM → auto-pr/create-issue decision
  github.mjs        GitHub REST API client
  delivery.mjs      Idempotent PR/Issue creation + 5-file regex patching
  observability.mjs DEAD_LETTER alerting + LLM cost estimation

test/               175 tests across 12 files
fixtures/           Synthetic cli.js snippets for v2.1.90 and v2.1.91
```

## Cost estimate

| Component                 | Frequency                       | Cost              |
| ------------------------- | ------------------------------- | ----------------- |
| Worker invocations (cron) | ~2880/month                     | Free tier         |
| KV reads/writes           | ~5760/month                     | Free tier         |
| Workers AI (Kimi K2.5)    | ~2 calls/month (on new release) | ~$0.04/call       |
| **Total**                 |                                 | **< $0.10/month** |
