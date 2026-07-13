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
