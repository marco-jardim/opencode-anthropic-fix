# Wire-compat consolidation migration — final report (2026-08-16)

Terminal deliverable of `docs/plans/wire-compat-consolidation-migration.md` (Global DoD:
"critérios 1-9 verificados com evidência (comando + output registrados no relatório final em
`docs/plans/wire-compat-migration-report.md`)").

## Summary

The entire Claude Code wire-mimicry domain has been migrated out of this repository and into
`@tormentalabs/claude-code-wire-compat@0.5.0`. Headers, body shape, the canonical system prefix,
beta registries, the request URL, model queries and protocol constants are all composed by the
package, and the plugin consumes them exclusively through one seam, `lib/mimicry/wire-compat.mjs`,
which is enforced by an import-seam governance test. The plugin previously carried a second,
independent implementation of the same protocol and chose between the two per request; that fork is
gone — `lib/request-headers.mjs` and `lib/mimicry/models.mjs` were deleted, the legacy header forge
is frozen as a documented compat exception for endpoints the package does not model, and the
plugin-as-oracle drift verifier was retired package-side as tautological once both sides ran the
same code. The plugin was released as **1.0.0** (major): `signature_emulation.enabled: false` is now
transparent passthrough plus an auth envelope instead of half-mimicry, the URL is left untouched
with the switch off, and the public model predicates narrowed to the package's catalogue. What
remains host-side is host policy by design and is enumerated in
`docs/mimicry/wire-compat-divergences.md`.

## Commit ledger

Ranges are `migration-baseline..HEAD` (plugin, `D:\git\opencode-anthropic-fix`) and
`migration-baseline..main` (package, `D:\git\claude-code-wire-compat`). The plugin's
`migration-baseline` tag is `de92d13`; the package's is `0085ee5`.

### Package — `D:\git\claude-code-wire-compat`

| SHA       | Subject                                                                             | Wave / phase        |
| --------- | ----------------------------------------------------------------------------------- | ------------------- |
| `136c072` | docs: add upstream tracking plan draft (2.1.222->2.1.233)                           | Wave 0 (pre-flight) |
| `0085ee5` | fix: re-anchor drift verifier to 2.1.233 and resolve sdkVersion via the CLI map     | Wave 0 (= tag)      |
| `c3d4577` | feat: accept dotted model version ids in normalizeModelId                           | Wave 1              |
| `e1bab32` | feat: add model-query module with catalogue capability query and family predicates  | Wave 1              |
| `8e583fd` | feat: export the model-query surface from the package entry point                   | Wave 1              |
| `418e5f3` | feat: export the transcribed beta registries and the count-tokens beta              | Wave 1              |
| `e94663c` | docs: pin the endpoint URL contract and record three Phase 1.2 decisions            | Wave 1              |
| `02958bc` | chore: release 0.5.0                                                                | Wave 1 (release)    |
| `1cc4d53` | chore: retire the external drift verifier (plugin ceases to be the protocol oracle) | Phase 2.3           |
| `3c24a70` | Merge pull request #19 from marco-jardim/release/0.5.0-main-sync                    | Wave 1 (main sync)  |

`136c072` and `0085ee5` are at or below the `migration-baseline` tag — they are the Wave-0
pre-flight re-anchor, listed here because the migration's version claim (2.1.233) rests on them.

### Plugin — `D:\git\opencode-anthropic-fix`

| SHA       | Subject                                                                                       | Wave / phase                     |
| --------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| `4ffb773` | test: add byte-exact migration parity harness (wave 0)                                        | Wave 0                           |
| `00ad7c0` | test: cover natural 1M adaptive escalation in migration parity harness (QA 0.1 finding 1)     | Wave 0                           |
| `83a98e0` | docs: record phase 0.1 QA findings and disposition in migration baseline                      | Wave 0                           |
| `a1c1984` | feat: adopt the shared package's built.url on the adapter path                                | Wave 2                           |
| `5d72e44` | test: pin the adapter path's URL source to the shared package                                 | Wave 2                           |
| `8be74e9` | fix: preserve host origin when adopting the package url on the adapter path                   | Wave 2                           |
| `3d5ddae` | feat: route every emulated messages turn through the wire adapter                             | Wave 2                           |
| `d5885c8` | feat!: make signature emulation off a pure passthrough                                        | Wave 2                           |
| `6a4026c` | refactor: remove the beta latch                                                               | Wave 2                           |
| `d07896b` | docs: describe emulation-off as passthrough plus the auth envelope                            | Wave 2                           |
| `5df5248` | fix: stop rewriting the request url when signature emulation is off                           | Wave 2                           |
| `72078da` | refactor: source the cli version from the wire package profile                                | Wave 2                           |
| `cd9fc23` | refactor: move host beta policy and the legacy user-agent out of request-headers              | Wave 2                           |
| `cd5364b` | refactor!: delete lib/request-headers.mjs                                                     | Wave 2                           |
| `96d9ce4` | refactor!: strip the cc prompt mimicry from system-prompt (package owns the canonical prefix) | Wave 2                           |
| `afcd70e` | chore: fix phase 2.3 qa finding (dangling leanNonMain comment reference)                      | Wave 2                           |
| `9e653bc` | chore: resolve wire-compat 0.5.0 from the registry (phase 3.0 gate)                           | Phase 3.0                        |
| `c0ae771` | refactor: source model predicates from the wire package                                       | Phase 3.1                        |
| `daa4347` | test: record that the seam keeps the dotted-id rewrite                                        | Phase 3.1                        |
| `469894d` | test: add governance guard against local model-family regexes                                 | Phase 3.1                        |
| `e559810` | refactor: source adapter capability predicates from the wire package                          | Phase 3.2                        |
| `1732316` | test: reconcile host beta tables with the package registry                                    | Phase 3.2                        |
| `5519de5` | docs: freeze the legacy header forge as a compat exception                                    | Phase 3.2                        |
| `5fa4ea3` | test: pin adapter-path beta composition end-to-end                                            | Phase 3.2                        |
| `0c05b4f` | refactor: source adapter protocol constants from the wire profile                             | Phase 3.3                        |
| `22c60c0` | test: prove profile changes propagate to the transport                                        | Phase 3.3                        |
| `cb3bbd9` | test: add governance guard against cc version literals                                        | Phase 3.3                        |
| `5db80ad` | refactor: derive the task-budgets signal without the legacy beta forge                        | Phase 4.1                        |
| `9eb0fab` | test: retire the tautological package-vs-plugin differential                                  | Phase 4.1                        |
| `143b45d` | test: guard the package import seam                                                           | Phase 4.1                        |
| `3cc3c73` | test: promote the migration parity harness to the permanent wire baseline                     | Phase 4.1                        |
| `685052f` | docs: sync architecture docs with the post-migration wire pipeline                            | Phase 4.1                        |
| `29a6605` | docs: record the wave decisions in MEMORY                                                     | Phase 4.1                        |
| `b9eb441` | chore: release 1.0.0                                                                          | Phase 4.1                        |
| `9d12e07` | refactor: source orphan beta names from the package registry                                  | Phase 4.2 (global QA finding F1) |
| _(this)_  | docs: add the wire-compat migration final report                                              | Phase 4.2                        |

Waves 1 and 2 ran in parallel across the two repositories (disjoint file ownership, Appendix A of
the plan); Phase 3.0 is the gate where the plugin stopped resolving the package from a local link
and pinned the published 0.5.0.

## Architect decisions (D1-D7)

Recorded in full in `MEMORY.md` (`29a6605`); one line each:

- **D1 — Model API shape: generic capability query + named predicates, both package-side.** The
  plugin re-exports the named predicates and keeps no regexes; a host-side regex is how the model
  surface drifted before.
- **D2 — `built.url` adopted, with a host-origin strategy.** Path and query come from the package's
  built request, the ORIGIN from the plugin's own `requestUrl` — origin is host routing (proxies,
  gateways, per-account bases), not protocol.
- **D3 — Emulation off is transparent passthrough plus an auth envelope.** Host headers verbatim
  minus `x-api-key`/`x-session-affinity`, plus `authorization` and an ADDITIVE `oauth-2025-04-20`,
  URL untouched. Breaking, deliberately.
- **D4 — Beta registries come from the package; cache heuristics stay host-side.** Which betas exist
  is protocol; the turn-stability heuristic and TTL/scope selection depend on plugin `cache_policy`
  and role resolution the package cannot see.
- **D5 — Plugin-as-oracle drift verification retired package-side.** Once the plugin consumes the
  package for the same bytes the differential compares the package with itself; replaced by
  wire-baseline fixtures that pin BYTES rather than agreement between two expressions of one path.
- **D6 — One seam: `lib/mimicry/wire-compat.mjs`.** Every package import goes through it, guarded by
  a test; it also BINDS `WIRE_PROFILE` into `isEligibleFor1MContextWire` so a package bump cannot
  silently move the emulated identity.
- **D7 — The legacy forge is frozen, not deleted.** `buildRequestHeaders` survives as a compat
  exception for files/models/gateway-prefixed routes; frozen, and it does not compete for
  `/v1/messages`.

## Breaking changes shipped (plugin 1.0.0)

From the `CHANGELOG.md` `[1.0.0]` entry:

1. **`signature_emulation.enabled: false` is pure passthrough plus the auth envelope.** The forged
   `user-agent: claude-cli/2.1.233 (external, cli)` and the substitutive `anthropic-beta` list are
   gone. What goes out is the host's own request plus `authorization: Bearer <token>`, an ADDITIVE
   `oauth-2025-04-20` (contract of the OAuth token, not a fingerprint), and with `x-api-key` /
   `x-session-affinity` removed. `anthropic-version`, `x-app`, `x-claude-code-session-id`,
   `x-client-request-id`, `anthropic-dangerous-direct-browser-access` and the whole `x-stainless-*`
   family are no longer sent with the switch off. New envelope lives in `lib/passthrough-headers.mjs`,
   deliberately outside `lib/mimicry/`.
2. **The request URL is left alone with emulation off.** `?beta=true` and the `/messages` →
   `/v1/messages` normalization are both Claude Code client shape, so both follow the switch.
   `OPENCODE_MITM_BASE_URL` still applies either way.
3. **`transformRequestBody` no longer runs with emulation off.** The body goes out byte for byte,
   with two validity-preserving exceptions (body-level `betas`, stainless helper markers).
4. **Every emulated messages turn goes through the shared package.** A bodiless/unparsable body used
   to fall back to the legacy forge — a DIFFERENT fingerprint mid-session; it is now a hard error.
5. **Public model predicate re-exports answer from the package catalogue.** `isFable5Model`,
   `isMythos5Model`, `isAdaptiveThinkingModel` match model IDENTIFIERS; prefix-less fragments
   (`"opus-4-7"`) and underscore separators no longer match. Intended narrowing.

**Three latent bugs fixed as a side effect of change 3 (Phase 2.2).** With emulation off, the old
code path (a) EMPTIED the host's `system` prompt, (b) injected a `temperature: 1` the host never
sent, and (c) forged a user agent and replaced the host's betas. All three were unrequested policy
applied under a switch whose documented meaning was "do not mimic".

## Global acceptance criteria

All commands below were run fresh from `D:\git\opencode-anthropic-fix` on 2026-08-16; output is
verbatim, trimmed to the summary lines.

| #   | Criterion                                                                                                                       | Verdict | Evidence                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Single point of CC-protocol knowledge in the plugin is the package, proven by governance guards                                 | PASS    | 5 governance suites, 44 tests green — §1 below                                                                 |
| 2   | `lib/request-headers.mjs`, `lib/mimicry/models.mjs` and the duplicated beta constants gone; zero "bump both together" contracts | PASS    | `Test-Path` → `False,False`; 0 matches outside `docs/plans` + `CHANGELOG.md` — §2                              |
| 3   | `built.url` consumed; `transformRequestUrl` exists only for passthrough                                                         | PASS    | `test/conformance/url-source.test.mjs`, 17 tests green — §3                                                    |
| 4   | `transformRequestBody` contains ONLY OpenCode conversions                                                                       | PASS    | `5db80ad` + `96d9ce4`, audited item by item in the global QA — §4                                              |
| 5   | Full wire parity matrix byte-identical to the Wave-0 baseline, or divergence documented as a bugfix                             | PASS    | `wire-baseline` 16/16; 14 of 15 vectors R100-identical, vector 09 re-sealed twice and documented breaking — §5 |
| 6   | Suites 100% green in both repos; CI green in both                                                                               | PASS    | plugin 95 files / 1818 passed; package 104 files / 2993 passed; PR #19 all 7 checks pass — §6                  |
| 7   | Package published with the new surface; plugin lockfile pinning it with registry integrity                                      | PASS    | `npm view` → `0.5.0`; lockfile `resolved` + `integrity` — §7                                                   |
| 8   | Docs synchronized (mimicry doc, CONTRIBUTING, README, AGENTS, divergences, CHANGELOGs, MEMORY)                                  | PASS    | doc commits both repos + `MEMORY.md` in each — §8                                                              |
| 9   | Zero residual dual maintenance                                                                                                  | PASS    | import-seam guard `143b45d`, orphan-beta registry sourcing `9d12e07`, permanent wire baseline `3cc3c73` — §9   |

### §1 — Single knowledge point (governance guards)

```
> npx vitest run version-literals-retired request-headers-retired model-regex-retired package-dependency-policy canonical-prefix-once

 Test Files  5 passed (5)
      Tests  44 passed (44)
```

The five guards: no CC version literals in `lib/**`/`index.mjs`, `lib/request-headers.mjs` cannot
grow back, no local model-family regexes, every package import goes through the seam, and the
canonical system prefix is composed exactly once (package-side).

### §2 — Duplicate modules gone, no "bump both together" contract

```
> Test-Path lib/request-headers.mjs, lib/mimicry/models.mjs
False
False

> git grep -n -i "bump both\|bump-both\|keep in sync with the package\|update both" -- . ':!docs/plans' ':!CHANGELOG.md' | Measure-Object -Line
Lines: 0
```

`docs/plans` and `CHANGELOG.md` are excluded because they are the historical record of the contract
being removed, not an instruction to maintain it.

### §3 — `built.url` consumed

```
> npx vitest run url-source

 Test Files  1 passed (1)
      Tests  17 passed (17)
```

`test/conformance/url-source.test.mjs` pins that the adapter path takes path + query from the
package's `built.url` and the origin from the host `requestUrl` (D2), and that with emulation off
the URL is not rewritten at all.

### §4 — `transformRequestBody` is host-only

Two commits closed this: `5db80ad` ("refactor: derive the task-budgets signal without the legacy
beta forge") removed the last consumer that reached into the legacy beta forge from the body path,
reducing the signal to a boolean the host owns; `96d9ce4` ("refactor!: strip the cc prompt mimicry
from system-prompt") moved the canonical CC prefix, billing markers and anchors out, leaving the
package as the sole composer. What remains is enumerated and classified in
`docs/mimicry/wire-compat-divergences.md` and was audited file by file in the global QA (criterion
4 of the plan explicitly requires an item-by-item audit, not a test).

### §5 — Wire parity matrix

```
> npx vitest run wire-baseline

 Test Files  1 passed (1)
      Tests  16 passed (16)
```

15 vectors (simple, tools, streaming, count_tokens plain + custom betas, 1M context, fast mode,
custom betas, emulation off, haiku/opus/fable models, system-array multiturn, thinking, 1M adaptive
escalation) plus the determinism check.

All 15 vectors are byte-identical to the Wave-0 seal EXCEPT vector 09. Evidence — the promotion
commit renamed all 15 fixtures with **`R100`** (100 % similarity, zero content change):

```
> git log --oneline --name-status migration-baseline..HEAD -- test/fixtures/migration-baseline test/fixtures/wire-baseline

3cc3c73 test: promote the migration parity harness to the permanent wire baseline
R100    test/fixtures/migration-baseline/01-simple-sonnet.json  test/fixtures/wire-baseline/01-simple-sonnet.json
...     (all 15 vectors, R100)
5df5248 fix: stop rewriting the request url when signature emulation is off
M       test/fixtures/migration-baseline/09-emulation-off-sonnet.json
d5885c8 feat!: make signature emulation off a pure passthrough
M       test/fixtures/migration-baseline/09-emulation-off-sonnet.json
```

Only vector 09 was ever modified, and only by the two commits that deliberately changed
emulation-off semantics:

```
> git show --stat --oneline d5885c8 -- test/fixtures/
 test/fixtures/migration-baseline/09-emulation-off-sonnet.json | 10 ++++------
 1 file changed, 4 insertions(+), 6 deletions(-)

> git show --stat --oneline 5df5248 -- test/fixtures/
 test/fixtures/migration-baseline/09-emulation-off-sonnet.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

That divergence is the documented breaking change (D3 / CHANGELOG `[1.0.0]` BREAKING items 1-3),
not a regression.

### §6 — Suites and CI

```
> npm test                                    # plugin
 Test Files  95 passed (95)
      Tests  1818 passed | 2 skipped (1820)
   Duration  13.45s

> npm --prefix D:\git\claude-code-wire-compat test
 Test Files  104 passed (104)
      Tests  2993 passed (2993)
   Duration  6.39s
```

Package CI, via the merged release PR #19:

```
> gh pr checks 19 --repo marco-jardim/claude-code-wire-compat
GitGuardian Security Checks   pass  1s
bun                           pass  18s
node-20                       pass  28s
node-22                       pass  32s
node-24                       pass  28s
quality                       pass  1m12s
workerd                       pass  35s
```

### §7 — Package published, lockfile pinned with integrity

```
> npm view @tormentalabs/claude-code-wire-compat version
0.5.0
```

`package-lock.json:1122-1130`:

```json
"node_modules/@tormentalabs/claude-code-wire-compat": {
  "version": "0.5.0",
  "resolved": "https://registry.npmjs.org/@tormentalabs/claude-code-wire-compat/-/claude-code-wire-compat-0.5.0.tgz",
  "integrity": "sha512-El165ZJyvhn04TXzK15SFkPlMu/Bx16xcgfmMTNT4JtTF19kkl417LmG4ip+jJmcD7Y+Z4xQZsW41SSqIJWPyA==",
  "license": "GPL-3.0-or-later",
  "engines": { "node": ">=20" }
}
```

Resolved from the public registry (not a `file:` or `link:` spec) — Phase 3.0 gate `9e653bc`.

### §8 — Docs synchronized

Plugin: `685052f` (architecture docs synced with the post-migration wire pipeline), `29a6605`
(`MEMORY.md` wave decisions D1-D7), `d07896b` (emulation-off described as passthrough plus auth
envelope), `5519de5` (freeze banners on the legacy header forge), plus the `CHANGELOG.md` `[1.0.0]`
entry in `b9eb441`. Package: `e94663c` (endpoint URL contract pinned, three Phase 1.2 decisions
recorded), `1cc4d53` (drift-verifier retirement documented), and its own `MEMORY.md` / `CHANGELOG`.
Both repositories carry a `MEMORY.md` entry for this migration.

### §9 — Zero residual dual maintenance

- `143b45d` — import-seam guard: any `@tormentalabs/claude-code-wire-compat` import outside
  `lib/mimicry/wire-compat.mjs` fails the suite, so a second consumption path cannot appear.
- `9d12e07` — orphan beta names sourced from the package registry (global QA finding F1); the last
  protocol string literals in the host tables are gone.
- `3cc3c73` — the parity harness is permanent, not a migration scaffold: it pins BYTES, so a
  regression introduced by a future PACKAGE release fails here in the plugin (D5).

Combined with the governance guards of §1 (2.3, 3.1, 3.3, 4.1) running in CI, there is no
constant, table or code path in `lib/**` or `index.mjs` that has to be edited in lockstep with the
package.

## QA reviews

Every phase gate ran a `[tier:heavy]` senior QA review; a phase did not close with an open finding
of severity ≥ major.

| Gate         | Disposition                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1          | PASS after fixes — finding 1 (missing natural 1M adaptive-escalation coverage) fixed in `00ad7c0`; findings + disposition recorded in `83a98e0`.   |
| 1.1          | PASS — model-query API signature reviewed against the plan's contract; catalogue-vs-regex semantics accepted as the intended narrowing.            |
| 1.2          | PASS — beta registries and the count-tokens beta reviewed for compat; three endpoint/URL decisions recorded in `e94663c`.                          |
| 2.1          | PASS after fixes — host-origin loss on the adapter URL path caught and fixed in `8be74e9`; pinned by `5d72e44`.                                    |
| 2.2          | PASS — emulation-off semantics reviewed as a deliberate breaking change; the three latent bugs it fixes were identified here and documented.       |
| 2.3          | PASS after fixes — dangling `leanNonMain` comment reference fixed in `afcd70e`; drift-fixture disposition agreed before the delete.                |
| 3.1          | PASS — model-predicate migration reviewed for subtle semantic differences; dotted-id rewrite retention pinned by `daa4347`.                        |
| 3.2          | PASS — host-feature betas confirmed intact after sourcing capability predicates from the package; end-to-end beta composition pinned by `5fa4ea3`. |
| 3.3          | PASS — hunt for residual protocol literals in `adapter-input.mjs`; profile propagation to the transport proven by `22c60c0`.                       |
| 4.2 (global) | PASS — three findings, one fixed and two accepted with reasons (below).                                                                            |

**Global QA findings:**

- **F1 — orphan beta name literals in the host tables. FIXED** (`9d12e07`): the names are now read
  from the package's exported registry, closing the last dual-maintenance surface for beta strings.
- **F2 — `oauth-2025-04-20` appears in `lib/oauth.mjs` and in the passthrough envelope. ACCEPTED.**
  This is the auth-flow domain, not mimicry composition: the API rejects an OAuth bearer without
  that beta, so it is a contract of the token itself. It is deliberately independent of the mimicry
  package — a mimicry-package bump must not be able to move it, and OAuth must keep working with
  emulation off, where no mimicry code runs at all.
- **F3 — `lib/mimicry/context-hint-threshold.mjs` still holds ported behaviour. ACCEPTED.** It is a
  behavioural port (a threshold heuristic), not wire composition; nothing it computes is a protocol
  constant on the wire, and the boundary in §1 of the plan assigns host behaviour to the host.

## Follow-ups (out of migration scope)

Carried forward from `MEMORY.md`; none of these block the DoD.

1. **`_microcompactBetas` is provably dead** (`index.mjs:2902,2908`). Its only consumer,
   `computedBetaHeader`, was deleted by this migration, so the value has not reached the wire since.
   Decide between wiring it into the adapter input or deleting it — but establish first whether the
   real client emits those betas at all; do not reconnect it blindly.
2. **`worker/sync-watcher` still auto-patches version literals this migration deleted.** Its patcher
   rewrites `FALLBACK_CLAUDE_CLI_VERSION` and the `CLI_TO_SDK_VERSION` map inside `index.mjs`
   (`src/delivery.mjs:194,196,218-219`, commit subject at `:284`, file map at `src/prompts.mjs:117`,
   plus fixtures in `test/delivery.test.mjs`). Those constants now come from `WIRE_PROFILE`, so the
   regexes will silently match nothing and the watcher will open PRs that change no version. The
   watcher is a separate subproject with its own deploy and needs its own update.
3. **The `max_tokens 40000 → 32000` golden pin was retired with the tautological differential.** The
   clamp branch is not unguarded — wire-baseline vector 06 pins the same `min()` clamp
   (`64000 → 32000`). Noted so the deletion is not read as lost coverage and a duplicate pin re-added.

## Release state

| Artifact                                | State                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@tormentalabs/claude-code-wire-compat` | **0.5.0**, published to the npm registry; tag `v0.5.0`; PR #19 merged to `main`.                                    |
| `opencode-anthropic-fix`                | **1.0.0**, released in `b9eb441`; **unpushed at report time** — publish runs from the `master` workflow after push. |
| Tags                                    | `migration-baseline` in BOTH repositories (plugin `de92d13`, package `0085ee5`); `v0.5.0` on the package.           |
| Plugin `v1.0.0` tag                     | To be created at push time, alongside the `master` push that triggers the publish workflow.                         |
