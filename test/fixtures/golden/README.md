# Golden outgoing requests

Two byte-shape regression guards, one per outgoing surface. Each conformance test drives the real plugin interceptor and compares its normalized headers and parsed JSON body with the committed fixture.

| Fixture                    | Surface                     | Test                                              |
| -------------------------- | --------------------------- | ------------------------------------------------- |
| `outgoing-foreground.json` | `/v1/messages`              | `test/conformance/golden-outgoing.test.mjs`       |
| `outgoing-count.json`      | `/v1/messages/count_tokens` | `test/conformance/golden-outgoing-count.test.mjs` |

`outgoing-foreground.json` is the Wave 3 guard for extracting the outgoing request transforms from `index.mjs`. `outgoing-count.json` is the count-tokens guard added when the plugin adopted the shared package's `extraHeaderPolicy` seam; it is the single source of truth for the count wire's exact bytes, which is why `test/conformance/shared-package-parity.test.mjs` no longer re-pins them. Note that the two fixtures have different generated sets: the count body carries no `metadata.user_id`, so only the two request-scoped headers are normalized there.

To regenerate either one, run `npx vitest run golden-outgoing` (or `golden-outgoing-count`), capture the normalized object reported by the temporary calibration output, and replace the fixture only after reviewing every changed deterministic field. If a newly generated value appears, compare two fresh interceptor runs, add only the differing JSON path to that test's `NORMALIZED_PATHS` with an explanation, and store `"<normalized>"` at that path. Never normalize stable mimicry fields to make a drift pass.
