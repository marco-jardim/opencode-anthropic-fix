# Coverage Baseline

- **Date:** 2026-07-13
- **Command:** `npm run coverage`
- **Provider:** V8 via Vitest

Coverage measures `lib/**/*.mjs`, `index.mjs`, and `cli.mjs`.

| Area        | Statements | Branches | Functions |  Lines |
| ----------- | ---------: | -------: | --------: | -----: |
| `lib/`      |     89.02% |   83.39% |    90.90% | 90.65% |
| `index.mjs` |     57.96% |   53.85% |    59.77% | 59.23% |
| `cli.mjs`   |     70.13% |   61.35% |    88.05% | 69.58% |

## Threshold Policy

| Scope       | Statements | Branches |
| ----------- | ---------: | -------: |
| `lib/**`    |        85% |      75% |
| `index.mjs` |        56% |      52% |
| `cli.mjs`   |        69% |      60% |

The `lib/**` thresholds are the required coverage floor. The entry-point thresholds are set one percentage point below
the floor of their measured baselines to avoid normal instrumentation variation. The `index.mjs` and `cli.mjs`
thresholds ratchet upward in Wave 3 as their test coverage improves. No global threshold is set.
