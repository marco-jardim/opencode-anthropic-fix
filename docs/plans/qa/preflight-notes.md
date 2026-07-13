# Pre-flight notes

Issues surfaced during a phase's pre-flight that are **explicitly scoped to a later phase**
are recorded here (per plan §A5.1) instead of being fixed early. Format:

| Phase found | Issue | file:line | Owning future phase |
| ----------- | ----- | --------- | ------------------- |

## Wave 0

| Phase found | Issue                                                                                                                                                                                 | file:line                                   | Owning future phase                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| W0·P0.4     | Sources-of-truth drift (C2): `CHANGELOG.md` head `0.1.27` is behind `package.json` `0.1.32`; git tags stop at `v0.1.27`. Surfaced as a non-failing warning by `check:invariants`.     | `CHANGELOG.md:5`, `package.json:3`          | Global DoD (§C, C2 reconciliation) |
| W0·P0.4     | Reverse-engineering baseline drift (C2): `docs/claude-code-reverse-engineering.md` pinned at `2.1.119` while newest analysis is `2.1.195`. Non-failing warning by `check:invariants`. | `docs/claude-code-reverse-engineering.md:3` | Global DoD (§C, C2 reconciliation) |

## Wave 1

| Phase found | Issue                                                                                                                                                                                                                                                              | file:line               | Owning future phase                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------- |
| W1·P1.3     | Flaky test: `TokenBucketTracker > tracks accounts independently` failed once under full-suite parallel load (husky), passed 36/36 in isolation twice. Time/refill-based, timing-sensitive. NOT introduced by W1 (P1.3 doesn't touch rotation). Workaround: re-run. | `lib/rotation.test.mjs` | W2·P2.4 (timing hardening) or opportunistic; see W1-review.md F1 |

## Wave 3

| Phase found | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                       | file:line                               | Owning future phase                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------- |
| W3·P3.4     | `formatResetTime` deliberately **not** merged: the `index.mjs` and `cli.mjs` versions are intentionally different formatters (index rounds to `~2m`/`~3h` with `unknown`/error fallback; cli gives precise `2m 30s` via `formatDuration`). Merging would change user-visible output, violating the no-behavior-change refactor rule. Deliberate non-action; `lib/format.mjs` not created.                                                   | `index.mjs:4720`, `cli.mjs:244`         | none (closed by decision)             |
| W3·P3.3     | Stateful token-economy cluster **deferred**: `resolveAdaptiveContext`, `cacheBreakState`, `microcompactState`, `quotaWarningState` are module-mutable state machines entangled with the interceptor and feeding the mimicry beta-assembly surface. G4 (`index.mjs` < 6000) already met at 5915 LOC; threading their state out risks the #1 regression surface for negligible structural gain. Leaf-pure helpers were extracted (`347c20b`). | `index.mjs:4547-4655`, `index.mjs:5156` | Deferred post-plan (see W3-review.md) |
