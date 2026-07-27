# CCH Attestation Resolution

## Question

Does the plugin emit the `cch` segment of the outbound `x-anthropic-billing-header` as the static literal `00000`, or does it replace that value with a computed xxHash64 attestation?

## Method

1. Search the entire tracked worktree, excluding `node_modules/`, `coverage/`, `dist/`, and `.git/`, for `cch=`, the word `cch`, and case-insensitive CCH references in executable source and tests.
2. Search exhaustively for `_xxh64Raw` and `_xxhashReady`, then trace the body passed to the actual fetch call.
3. Run the golden outgoing-request conformance test and the regression conformance test. The golden test captures the real body passed to the mocked outbound fetch at `test/conformance/golden-outgoing.test.mjs:208-211` and compares the complete normalized captured request with the checked-in fixture at `test/conformance/golden-outgoing.test.mjs:217-219`.
4. Read the exact expected value from `test/fixtures/golden/outgoing-foreground.json:27`. Because the captured request's complete normalized body must equal that fixture, a passing golden test is runtime evidence of the emitted value rather than an inference from product comments.

No temporary probe or source modification was used.

## CCH write and assertion inventory

### Product code

- `lib/mimicry/system-prompt.mjs:93-96` computes the three-character SHA-256 billing fingerprint. Despite the function's historical name and comment at line 87, this value is appended to `cc_version`; it is not the five-character `cch` value.
- `lib/mimicry/system-prompt.mjs:122`, `lib/mimicry/system-prompt.mjs:125`, `lib/mimicry/system-prompt.mjs:145`, and `lib/mimicry/system-prompt.mjs:146` state that the `cch` value is static.
- `lib/mimicry/system-prompt.mjs:147-148` is the only executable product-code write of a `cch` value: eligible providers receive the literal `" cch=00000;"`; Bedrock, Anthropic AWS, and Mantle receive an empty segment.
- `lib/mimicry/system-prompt.mjs:159` interpolates that already-resolved segment into the billing header.
- `index.mjs:3141-3146` leaves the serialized request body unchanged with `const finalBody = body`.
- `index.mjs:3200` passes `finalBody` to the actual outbound fetch request.
- `index.mjs:5569-5577` contains contradictory historical comments plus the xxHash initialization declarations, but no CCH replacement function and no read of the initialized hash function.

Non-value mentions found by the search are `lib/config.mjs:123`, `lib/mimicry/request-body.mjs:294`, and `lib/mimicry/system-prompt.mjs:87`, `lib/mimicry/system-prompt.mjs:153`, and `lib/mimicry/system-prompt.mjs:155`.

### Tests

- `index.test.mjs:3737-3738` contains an outdated computed-value comment and asserts only the broad shape `/cch=[0-9a-f]{5};/`. The static value `00000` satisfies this assertion, so it does not prove computation.
- `index.test.mjs:4095` and `index.test.mjs:4123` assert that the literal is omitted for provider-gated requests.
- `test/conformance/regression.test.mjs:1223-1226` asserts the exact static literal `cch=00000;` in the captured outbound body.
- `test/conformance/golden-outgoing.test.mjs:208-219` captures two actual outbound calls and compares both complete normalized requests to the golden fixture.

### Fixtures

- `test/fixtures/golden/outgoing-foreground.json:27` records `x-anthropic-billing-header: cc_version=2.1.195.325; cc_entrypoint=cli; cch=00000;`.
- `test/fixtures/requests/plugin-001-messages.json:39` records an older computed capture ending in `cch=d728b;`; it is not the fixture used by the current golden outgoing test.

### Documentation

The exhaustive lowercase search found the following documentation assertions, examples, historical notes, and mentions. They are not executable write sites:

- `README.md:47`, `README.md:710`
- `CHANGELOG.md:86`, `CHANGELOG.md:87`, `CHANGELOG.md:247`, `CHANGELOG.md:250`, `CHANGELOG.md:252`, `CHANGELOG.md:259`, `CHANGELOG.md:263`, `CHANGELOG.md:267`, `CHANGELOG.md:271`, `CHANGELOG.md:279`, `CHANGELOG.md:284`, `CHANGELOG.md:359`, `CHANGELOG.md:361`, `CHANGELOG.md:362`, `CHANGELOG.md:568`, `CHANGELOG.md:571`, `CHANGELOG.md:598`, `CHANGELOG.md:603`, `CHANGELOG.md:604`, `CHANGELOG.md:615`, `CHANGELOG.md:645`, `CHANGELOG.md:649`, `CHANGELOG.md:673`
- `docs/claude-code-2.1.133-analysis.md:95`, `docs/claude-code-2.1.133-analysis.md:96`
- `docs/claude-code-2.1.143-analysis.md:40`, `docs/claude-code-2.1.143-analysis.md:293`, `docs/claude-code-2.1.143-analysis.md:299`, `docs/claude-code-2.1.143-analysis.md:575`
- `docs/claude-code-2.1.150-analysis.md:128`
- `docs/claude-code-2.1.195-analysis.md:102`
- `docs/claude-code-reverse-engineering.md:395`, `docs/claude-code-reverse-engineering.md:397`, `docs/claude-code-reverse-engineering.md:419`, `docs/claude-code-reverse-engineering.md:420`, `docs/claude-code-reverse-engineering.md:442`, `docs/claude-code-reverse-engineering.md:450`, `docs/claude-code-reverse-engineering.md:452`, `docs/claude-code-reverse-engineering.md:1634`, `docs/claude-code-reverse-engineering.md:1635`, `docs/claude-code-reverse-engineering.md:1636`, `docs/claude-code-reverse-engineering.md:1673`, `docs/claude-code-reverse-engineering.md:1812`, `docs/claude-code-reverse-engineering.md:1816`, `docs/claude-code-reverse-engineering.md:1818`, `docs/claude-code-reverse-engineering.md:1820`, `docs/claude-code-reverse-engineering.md:1832`, `docs/claude-code-reverse-engineering.md:1988`, `docs/claude-code-reverse-engineering.md:1991`, `docs/claude-code-reverse-engineering.md:2025`, `docs/claude-code-reverse-engineering.md:2101`, `docs/claude-code-reverse-engineering.md:2146`, `docs/claude-code-reverse-engineering.md:2178`, `docs/claude-code-reverse-engineering.md:2294`, `docs/claude-code-reverse-engineering.md:2298`, `docs/claude-code-reverse-engineering.md:2299`, `docs/claude-code-reverse-engineering.md:2303`
- `docs/CODE_COMPARISON_REFERENCE.md:55`, `docs/CODE_COMPARISON_REFERENCE.md:72`, `docs/CODE_COMPARISON_REFERENCE.md:73`, `docs/CODE_COMPARISON_REFERENCE.md:77`, `docs/CODE_COMPARISON_REFERENCE.md:82`, `docs/CODE_COMPARISON_REFERENCE.md:350`, `docs/CODE_COMPARISON_REFERENCE.md:351`, `docs/CODE_COMPARISON_REFERENCE.md:355`
- `docs/DIVERGENCE_ANALYSIS.md:264`, `docs/DIVERGENCE_ANALYSIS.md:265`, `docs/DIVERGENCE_ANALYSIS.md:268`, `docs/DIVERGENCE_ANALYSIS.md:277`, `docs/DIVERGENCE_ANALYSIS.md:291`, `docs/DIVERGENCE_ANALYSIS.md:293`, `docs/DIVERGENCE_ANALYSIS.md:309`, `docs/DIVERGENCE_ANALYSIS.md:453`, `docs/DIVERGENCE_ANALYSIS.md:456`, `docs/DIVERGENCE_ANALYSIS.md:470`
- `docs/EXECUTIVE_SUMMARY.md:98`, `docs/EXECUTIVE_SUMMARY.md:99`, `docs/EXECUTIVE_SUMMARY.md:100`, `docs/EXECUTIVE_SUMMARY.md:120`, `docs/EXECUTIVE_SUMMARY.md:149`
- `docs/future-improvements.md:233`, `docs/future-improvements.md:288`, `docs/future-improvements.md:290`, `docs/future-improvements.md:297`
- `docs/mimese-http-header-system-prompt.md:242`, `docs/mimese-http-header-system-prompt.md:744`, `docs/mimese-http-header-system-prompt.md:749`, `docs/mimese-http-header-system-prompt.md:752`, `docs/mimese-http-header-system-prompt.md:763`, `docs/mimese-http-header-system-prompt.md:767`, `docs/mimese-http-header-system-prompt.md:775`, `docs/mimese-http-header-system-prompt.md:781`, `docs/mimese-http-header-system-prompt.md:782`, `docs/mimese-http-header-system-prompt.md:786`
- `docs/MIMESE_FINGERPRINT_EXTRACTION.md:7`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:34`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:178`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:181`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:198`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:199`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:203`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:219`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:220`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:223`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:235`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:240`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:241`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:245`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:252`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:253`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:255`, `docs/MIMESE_FINGERPRINT_EXTRACTION.md:824`
- `docs/SEARCH_RESULTS_SUMMARY.md:118`, `docs/SEARCH_RESULTS_SUMMARY.md:125`
- `docs/plans/implementation-plan-v2.md:103`, `docs/plans/implementation-plan-v2.md:219`, `docs/plans/implementation-plan-v2.md:834`, `docs/plans/implementation-plan-v2.md:841`, `docs/plans/implementation-plan-v2.md:1489`

### Scripts

- `scripts/README.md:61-62` describes a historical `cch.mjs` script and states the static result.
- At this commit, `scripts/bisect/`, `scripts/verify/`, and `scripts/cch.mjs` do not exist. `rg -ni "xxhash|h64Raw" scripts` returned no matches. Therefore there are no executable script write/assert sites or script reads of the hash machinery in this worktree.

## xxHash machinery trace

- `index.mjs:6` imports `xxhash-wasm` as `xxhashInit`.
- `index.mjs:5575` declares `_xxh64Raw` with the value `null`.
- `index.mjs:5576` declares `_xxhashReady` as the promise returned by `xxhashInit().then(...)`.
- `index.mjs:5577` writes `h.h64Raw` to `_xxh64Raw` when initialization resolves.
- There are **no executable read sites** for either `_xxhashReady` or `_xxh64Raw`. The exhaustive identifier search found no other occurrence in product code, tests, fixtures, or scripts. The declarations and assignment therefore initialize dead state and are not on the outbound request path.
- `docs/MIMESE_FINGERPRINT_EXTRACTION.md:229-231` reproduces the declarations in a documentation snippet. Its only identifier read sites are `docs/MIMESE_FINGERPRINT_EXTRACTION.md:236` (`await _xxhashReady`), `docs/MIMESE_FINGERPRINT_EXTRACTION.md:237` (null check of `_xxh64Raw`), and `docs/MIMESE_FINGERPRINT_EXTRACTION.md:239` (call of `_xxh64Raw`). These are inert documentation, not request-path code.
- There are no read sites in `scripts/`.
- On the real request path, `index.mjs:3146` assigns the unmodified serialized `body` to `finalBody`, and `index.mjs:3200` sends that exact string. Neither hash identifier participates.

## Runtime observation

Observed outbound billing header:

```text
x-anthropic-billing-header: cc_version=2.1.195.325; cc_entrypoint=cli; cch=00000;
```

This value was obtained from the golden fixture at `test/fixtures/golden/outgoing-foreground.json:27` and validated against the body captured from the actual mocked outbound fetch by the passing equality checks at `test/conformance/golden-outgoing.test.mjs:208-219`. The independent regression assertion at `test/conformance/regression.test.mjs:1226` also passed.

## Commands and observed output

### Exhaustive searches

```powershell
rg -n --hidden -g '!node_modules/**' -g '!coverage/**' -g '!dist/**' -g '!.git/**' "cch=|\bcch\b" .
rg -n --hidden -g '!node_modules/**' -g '!coverage/**' -g '!dist/**' -g '!.git/**' "_xxh64Raw|_xxhashReady" .
```

The first command produced the locations classified in the inventory above. The second command produced exactly:

```text
index.mjs:5575:let _xxh64Raw = null;
index.mjs:5576:const _xxhashReady = xxhashInit().then((h) => {
index.mjs:5577:  _xxh64Raw = h.h64Raw;
docs/MIMESE_FINGERPRINT_EXTRACTION.md:229:let _xxh64Raw = null;
docs/MIMESE_FINGERPRINT_EXTRACTION.md:230:const _xxhashReady = xxhashInit().then((h) => {
docs/MIMESE_FINGERPRINT_EXTRACTION.md:231:  _xxh64Raw = h.h64Raw;
docs/MIMESE_FINGERPRINT_EXTRACTION.md:236:  await _xxhashReady;
docs/MIMESE_FINGERPRINT_EXTRACTION.md:237:  if (!_xxh64Raw) return body;
docs/MIMESE_FINGERPRINT_EXTRACTION.md:239:  const hash = _xxh64Raw(bodyBytes, CCH_SEED);
```

```powershell
rg -ni --hidden -g '!node_modules/**' -g '!coverage/**' -g '!dist/**' -g '!.git/**' "cch" index.mjs lib test index.test.mjs scripts
rg -ni --hidden -g '!node_modules/**' -g '!coverage/**' -g '!dist/**' -g '!.git/**' "xxhash|h64Raw" scripts
rg -n "finalBody" index.mjs
```

The case-insensitive CCH output is classified above. The scripts search printed `NO_SCRIPT_XXHASH_MATCHES`. The request-path search produced:

```text
3146:                const finalBody = body;
3155:                if (isDebugSinkEnabled(config, "body") && typeof finalBody === "string") {
3171:                    const dump = createDebugRequestDump(correlationId, ts, finalBody);
3200:                    body: finalBody,
4464:export function createDebugRequestDump(correlationId, timestamp, finalBody) {
4467:    content: JSON.stringify({ correlationId, timestamp, bodyRedacted: redactString(finalBody) }),
```

### Targeted runtime tests

```powershell
npx vitest run test/conformance/golden-outgoing.test.mjs
```

```text
Test Files  1 passed (1)
Tests       1 passed (1)
GOLDEN_EXIT=0
```

```powershell
npx vitest run test/conformance/regression.test.mjs
```

```text
Test Files  1 passed (1)
Tests       68 passed (68)
REGRESSION_EXIT=0
```

## Verdict

**STATIC.** The actual captured outbound request contains `cch=00000;`. The golden equality test and the independent regression assertion both pass. Exhaustive identifier search proves that `_xxhashReady` and `_xxh64Raw` have no executable read site, and the outbound path sends the serialized body without replacement.

## Consequence

The shared package's static profile remains factually valid. Its governance test forbidding the string `xxHash` in package source remains valid because the plugin's xxHash initialization is dead with respect to the outbound billing-header path.

`xxhash-wasm` is currently a **production dependency** at `package.json:56-59`, imported at `index.mjs:6`. Any demotion or removal is explicitly deferred: changing `package.json` triggers this repository's publish workflow and is outside this resolution task.

## Complete plugin gate

The gates are run in the required order after this document is formatted. Their exit codes and summaries are recorded here before commit.

### 1. Lint

```powershell
npm run lint
```

```text
> opencode-anthropic-fix@0.2.1 lint
> eslint .

exit code: 0
```

### 2. Format check

```powershell
npm run format:check
```

```text
> opencode-anthropic-fix@0.2.1 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!
exit code: 0
```

### 3. Invariants

```powershell
npm run check:invariants
```

```text
> opencode-anthropic-fix@0.2.1 check:invariants
> node scripts/check-invariants.mjs

✓ Version vs CHANGELOG
✓ Mimicry baseline
⚠ Reverse-engineering baseline: reverse-engineering baseline 2.1.119 differs from newest analysis doc 2.1.195
✓ AGENTS.md naming guard
✓ Stray-file guard
Summary: PASS (0 errors, 1 warning)
exit code: 0
```

### 4. Tests

```powershell
npm test
```

```text
Test Files  76 passed (76)
Tests       1434 passed | 2 skipped (1436)
exit code: 0
```

### 5. Coverage

```powershell
npm run coverage
```

```text
Test Files  76 passed (76)
Tests       1434 passed | 2 skipped (1436)

Coverage summary
Statements : 70.36% (4415/6274)
Branches   : 66.09% (3569/5400)
Functions  : 76.01% (488/642)
Lines      : 71.23% (4051/5687)
exit code: 0
```

No coverage threshold error was emitted.

### 6. Build

```powershell
npm run build
```

```text
> opencode-anthropic-fix@0.2.1 build
> node scripts/build.mjs

Built dist/opencode-anthropic-auth-plugin.js and dist/opencode-anthropic-auth-cli.mjs
exit code: 0
```
