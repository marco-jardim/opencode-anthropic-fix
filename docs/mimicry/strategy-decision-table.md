# Account Selection Strategy Decision Table

Account selection is controlled by `account_selection_strategy`. The CLI persists that key with `saveConfig`
(`cli.mjs:1208-1214`), while `OPENCODE_ANTHROPIC_STRATEGY` overrides the saved value at runtime
(`cli.mjs:1188-1193`). Valid values are `sticky`, `round-robin`, and `hybrid` (`lib/config.mjs:7`,
`lib/config.mjs:452`).

## Strategy behavior

| Strategy      | Selection rule                                                                                       | Switch behavior                                                                                                             | Configuration                                                                  | Source-of-truth file:line                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sticky`      | Stay on the current usable account.                                                                  | Switch when that account fails, is rate-limited, or otherwise leaves the candidate set.                                     | `account_selection_strategy: "sticky"` (the default)                           | `lib/rotation.mjs:239-255`; behavior: `cli.mjs:1171-1174`; default: `lib/config.mjs:112`                                                            |
| `round-robin` | Advance through usable accounts on every request.                                                    | Every selection advances the cursor; unavailable accounts are excluded before selection.                                    | `account_selection_strategy: "round-robin"`                                    | `lib/rotation.mjs:257-260`; behavior: `cli.mjs:1171-1174`                                                                                           |
| `hybrid`      | Prefer healthy accounts using health, token availability, freshness, and current-account stickiness. | Keep the current account unless another account's score has the required advantage; rotate as the current account degrades. | `account_selection_strategy: "hybrid"`; tune `health_score` and `token_bucket` | `lib/rotation.mjs:207-225`, `lib/rotation.mjs:262-302`; behavior: `cli.mjs:1171-1174`; tuning: `lib/rotation.mjs:20-31`, `lib/rotation.mjs:128-139` |

## Hybrid score and switching threshold

For each usable candidate, hybrid selection computes these components before applying account stickiness:

| Component          | Formula                                | Effect                                                          | Source-of-truth file:line                      |
| ------------------ | -------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Health             | `healthScore × 2`                      | Rewards accounts with better recent outcomes.                   | `lib/rotation.mjs:217`                         |
| Token availability | `tokenAvailability × 5`                | Strongly favors accounts with available request capacity.       | `lib/rotation.mjs:218`                         |
| Freshness          | `min(secondsSinceLastUse, 3600) × 0.1` | Gradually favors accounts that have rested, capped at one hour. | `lib/rotation.mjs:219-222`                     |
| Stickiness         | `+150` for the current account         | Avoids needless account churn.                                  | `lib/rotation.mjs:207`, `lib/rotation.mjs:280` |

`SWITCH_THRESHOLD` is `100` (`lib/rotation.mjs:208`). Hybrid switches only when the best alternative's advantage
over the current account reaches that threshold (`lib/rotation.mjs:293-302`). The health and token trackers merge
their tuning with `DEFAULT_CONFIG.health_score` and `DEFAULT_CONFIG.token_bucket` respectively
(`lib/rotation.mjs:20-31`, `lib/rotation.mjs:128-139`); the default configuration blocks are defined at
`lib/config.mjs:133-149`.

## Symptom-to-strategy guide

| Workload or symptom                                                         | Choose        | Why                                                                           | Source-of-truth file:line                                                                                       |
| --------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| One heavy sequential user; continuity and cache locality matter most        | `sticky`      | It stays on one account until that account fails or is rate-limited.          | `cli.mjs:1171-1174`, `lib/rotation.mjs:239-255`                                                                 |
| Many parallel, light requests; even distribution matters more than locality | `round-robin` | It rotates on every request instead of waiting for degradation.               | `cli.mjs:1171-1174`, `lib/rotation.mjs:257-260`                                                                 |
| Mixed load; resilience and health-aware routing matter                      | `hybrid`      | It scores health, capacity, and rest time, but resists unnecessary switching. | `lib/rotation.mjs:207-225`, `lib/rotation.mjs:262-302`                                                          |
| Frequent rate limits or quota exhaustion on otherwise valid accounts        | `hybrid`      | Health/capacity scoring can move work toward a healthier usable candidate.    | `lib/rotation.mjs:217-224`, `lib/rotation.mjs:262-302`; reasons: `lib/backoff.mjs:2`, `lib/backoff.mjs:244-247` |
| Strict per-request account alternation is required                          | `round-robin` | Cursor advancement is deterministic among the usable candidates.              | `lib/rotation.mjs:257-260`                                                                                      |

## Switch triggers and configuration precedence

Rate-limit processing classifies account-level failure signals as `QUOTA_EXHAUSTED`, `AUTH_FAILED`, or
`RATE_LIMIT_EXCEEDED` (`lib/backoff.mjs:2`, `lib/backoff.mjs:228-247`). Those quota, authentication, and rate-limit
failures can remove or degrade the current account and cause the next selection to choose another candidate. Sticky
waits for that failure/unavailability boundary, round-robin rotates regardless, and hybrid can switch earlier when a
healthy candidate clears its score threshold (`lib/rotation.mjs:239-302`).

Use either configuration surface:

| Surface      | Example                                | Precedence                                            | Source-of-truth file:line                               |
| ------------ | -------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Saved config | `account_selection_strategy: "hybrid"` | Base setting; the CLI writes it through `saveConfig`. | `cli.mjs:1208-1214`                                     |
| Environment  | `OPENCODE_ANTHROPIC_STRATEGY=hybrid`   | Runtime override of the saved config.                 | `cli.mjs:1188-1193`; application: `lib/config.mjs:1040` |

For hybrid tuning, edit the `health_score` and `token_bucket` config sections rather than changing scoring constants.
The trackers overlay those sections on the defaults (`lib/rotation.mjs:20-31`, `lib/rotation.mjs:128-139`).
