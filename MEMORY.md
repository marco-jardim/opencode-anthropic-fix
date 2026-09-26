# MEMORY

Append-only decision log, newest entry first. Each entry records decisions whose
_reasoning_ is not reconstructable from the code — what was decided, and why the
alternative was rejected. Code-level detail belongs in the source; contracts belong
in `docs/`. This file exists so a later session does not re-litigate a settled call.

Do not edit past entries. Add a new one instead.

---

## 2026-09-26 — INVALID_UNICODE / INPUT_TOO_LARGE incident, 2.1.280 port (plugin 2.1.0-2.1.1)

**What the user saw.** opencode sessions and subagents died with `INVALID_UNICODE`, then long Opus 5.5 sessions died
with `INPUT_TOO_LARGE (maximumSize=1000000)`. Both were `ClaudeCodeWireError`s thrown by the wire package **before
fetch**. The API never saw those requests.

**Root causes.**

1. Wire package 0.5.0 rejected every C0 control except TAB/LF/CR in body text. Any tool output carrying ANSI colour
   codes (`ESC`), NUL, BEL or FF killed the session. The rule was a library-local defensive choice with no upstream
   provenance. 0.7.0 relaxed body prose to "every well-formed string"; lone surrogates are still rejected.
2. The package capped every request at a ~1 MB aggregate budget (since library v0.1.0). The API accepts 32 MB, and a
   1M-token session is ~4 MB+. It did not bite earlier because, until 2026-08-16 (`3d5ddae`), not every turn went
   through the package builder. 0.7.1 raised the ceiling to 32 MiB.
3. Neither fix reached the user for a while, for three separate reasons:
   - (a) the dependency was pinned to exactly 0.5.0 until the 2.1.280 port landed;
   - (b) with a `latest` specifier, `npm install` keeps whatever the lockfile resolves, and a plain `npm update`
     answered from npm's cached packument while reporting success;
   - (c) a running opencode keeps the modules it loaded at start, so the user had to restart after every update. Two
     "it still fails" reports were in fact the old process.

**Decisions.**

- **D8 — Local validation must never be stricter than the real API.** When the library refuses something the API
  accepts, fix the library and release it. Do not catch, bypass or pre-sanitize in the plugin. Headers, identifiers
  and metadata keep their strict rules; body text and total size follow the API.
- **D9 — Dependency on `latest`, emulated profile pinned in the plugin.** `package.json` tracks `latest` so library
  fixes arrive with an install. `WIRE_PROFILE` is passed explicitly to every builder, so a library release that moves
  its `DEFAULT_PROFILE` cannot move the emulated client by itself (0.6.0 did exactly that in a minor). Moving to a new
  Claude Code version is a deliberate one-line change at the seam, plus docs and the regression suite.
  `sync:wire-compat` (`--prefer-online` plus drift check) and `check:wire-compat-drift` (also in the publish
  workflow) keep the lock honest.
- **D10 — Claude Code 2.1.280 is the emulated client** (plugin 2.1.0). Per the binary extraction in the library, when
  thinking is active with no caller display, `thinking-display-updates-2026-08-18` replaces
  `redact-thinking-2026-02-12` and the body carries `thinking.display: "updates"`. `thinking-binding-controls` and
  `cache-diagnosis` are sent by default. The plugin must not re-add `redact-thinking`: that combination is never sent
  by the real client. `token_economy.redact_thinking` only affects the legacy forge.
- **D11 — The beta-rejection latch is narrow.** It latches only betas that the API's "Unexpected value(s) … for the
  `anthropic-beta` header" message names **and** that were actually sent.
  - At most 2 per rejection; per account; 5-minute TTL.
  - One retry, pinned to the same account, and dropped if that retry fails too.
  - Never `oauth-2025-04-20` or `claude-code-20250219`, never body-coupled betas (`BODY_COUPLED_BETAS`), never on
    `count_tokens`, and never an account penalty.
  - Each of these limits closed a real failure found in QA: stripping `context-1m` and silently losing context,
    invalid body/header pairs, and a retry landing on another account.
- **D12 — Response-side host compatibility is a shim, not a wire change.** opencode's embedded `@ai-sdk/anthropic`
  (3.0.111) rejects unknown SSE block, delta and event types. `response-stream.mjs` turns unknown blocks into the
  SDK's `fallback` no-op for that SDK version or older, and only dry-runs and logs for newer SDKs. The request stays
  byte-identical to the real client. The alternative (supplying `thinking.display` explicitly) would be a detectable
  fingerprint.
- **D13 — Text cuts are grapheme-safe; response decoding is strict.** Any deliberate truncation of text sent to the
  API uses `truncateGraphemes`, because a split emoji leaves a lone surrogate that the library still rejects. SSE is
  decoded strictly with a flush at EOF. Non-SSE bodies pass through byte for byte.
- **D14 — `index.mjs` exports only the plugin.** opencode invokes every entry export as a plugin factory.

**How it was debugged (reuse this).** Grep `~/.local/share/opencode/log/opencode.log` for the session id. Read the
`stack=`: `sanitizeError` inside `claude-code-wire-compat/dist/build-request.js` means a local library rejection.
Compare the error timestamp and the `run=` start with the install mtime to know which code was loaded. Reproduce
offline with `buildClaudeCodeRequest(input, WIRE_PROFILE)` using `\u`-escaped input. AGENTS.md → "Debugging
runtime failures in opencode" has the checklist.

### Follow-ups (open)

1. **Live probe of `thinking.display: "updates"`.** The response shape has not been captured live. Anthropic's docs
   say Opus 5.5 returns progress notes as `thinking` blocks, which the SDK accepts, so the shim is defence in depth.
   Run `RUN_LIVE_PROBE=1 node scripts/live-probe.mjs` only with the owner's authorization, because it uses a real
   account.
2. **web-search / advisor-tool over-send.** The plugin adds `web-search-2025-03-05` and `advisor-tool-2026-03-01` on
   the first-party path, and the genuine 2.1.280 default path does not send them. This is recorded in
   `docs/mimicry/wire-compat-divergences.md` and awaits an owner decision.
3. **Library performance with pathological bodies.** More than 1M tiny content blocks (~25-30 MiB) take about 11-14 s
   to build, mostly in `TextEncoder.encode` used for measuring. Measure UTF-8 length without allocating (a code-unit
   loop) in the library.
4. **`check:invariants` warning.** The reverse-engineering baseline (2.1.119) lags the newest analysis doc (2.1.280).
   It predates this work and is harmless, but it is noise in every run.

---

## 2026-08-16 — Wire-compat consolidation migration (Waves 0-4)

The plugin stopped carrying its own implementation of Claude Code protocol
composition. Headers, body shape, system prefix, beta lists, URL, model queries and
protocol constants now come from `@tormentalabs/claude-code-wire-compat` through a
single seam. Decisions taken along the way, and what each one closes off:

- **D1 — Model API shape: generic capability + named predicates, both package-side.**
  The package exports a generic `modelCapability`-style query _and_ named predicates
  (`isOpus46Model`, `isFable5Model`, ...). The plugin imports the named ones through
  `lib/mimicry/wire-compat.mjs` (the plugin entry no longer re-exports them: opencode calls every entry export
  as a plugin); it does not re-derive them from the generic query, and it does not keep regexes. A
  host-side regex was how the model surface drifted before — `test/conformance/model-regex-retired.test.mjs`
  now forbids it.

- **D2 — `built.url` adopted, with a host-origin strategy.** The plugin takes the
  path and query from the package's built request and the ORIGIN from its own
  `requestUrl`. The package deliberately has no `baseUrl` input: origin is host
  routing (proxies, gateways, per-account bases), not protocol. Splitting it this way
  keeps the package authoritative over everything that is part of the CC wire claim
  while leaving deployment concerns where they belong.

- **D3 — Emulation off is transparent passthrough plus an auth envelope.** Previously
  `signature_emulation: false` was half-mimicry: it still forged a user agent,
  replaced the host's beta list and normalized the body. That is the worst of both
  worlds — it does not pass as the real client and it does not pass through the
  caller's intent. It is now: host headers verbatim, minus `x-api-key` and
  `x-session-affinity`, plus `authorization` and an ADDITIVE `oauth-2025-04-20`, and
  the URL is left untouched. Breaking, deliberately.

- **D4 — Beta registries come from the package; cache heuristics stay host-side.**
  Which betas exist and what they mean is protocol, so the registries are exported by
  the package. The turn-stability cache heuristic and TTL/scope selection depend on
  plugin `cache_policy` config and role resolution the package cannot see, so they
  stay in `lib/mimicry/cache.mjs` / `lib/mimicry/system-prompt.mjs` as host policy.

- **D5 — Plugin-as-oracle drift verification retired package-side.** During migration
  the plugin's own output was the reference the package was diffed against. Once the
  plugin consumes the package for the same bytes, that differential compares the
  package with itself — it is circular and passes by construction. It was replaced by
  the wire-baseline fixtures, which pin BYTES rather than agreement between two
  expressions of the same code path.

- **D6 — One seam: `lib/mimicry/wire-compat.mjs`.** Every package import goes through
  it, guarded by an import-seam test. It also BINDS the profile:
  `isEligibleFor1MContextWire` passes `WIRE_PROFILE` (the 2.1.280 catalogue as of the
  2.1.280 port; the 2.1.233 catalogue at the time this decision was written) rather
  than letting the package fall back to its own `DEFAULT_PROFILE`. Eligibility must
  follow the client version being emulated, not whatever the package currently
  defaults to; a package bump should not silently move the emulated identity.

- **D7 — The legacy forge is frozen, not deleted.** `buildRequestHeaders`
  (`lib/mimicry/headers.mjs`) survives as a compatibility exception for endpoints the
  package has no surface for: files, models, gateway-prefixed routes. It is frozen —
  it gets no new features and does not compete for `/v1/messages` traffic. Deleting
  it would have broken those endpoints; leaving it unmarked would have invited a
  second implementation to grow back.

### Follow-ups (open)

1. **`_microcompactBetas` is provably dead** (`index.mjs:2902,2908`). Its only
   consumer was `computedBetaHeader`, which this migration deleted, so the value it
   computes has never reached the wire since. Decide between wiring it into the
   adapter input (if microcompact betas are actually wanted on the wire) or deleting
   it. Do not "fix" it by reconnecting it blindly — first establish whether the real
   client emits those betas at all.

   **Resolved by removal.** `_microcompactBetas` and `buildMicrocompactBetas`
   (`lib/token-economy/microcompact.mjs`) are deleted, along with their tests. The
   live half stays: `shouldMicrocompact`, the `microcompactState` toggle and the
   activation toast. Nothing on the wire changed — wire-baseline is unmoved — which
   is the point: the value had not reached the wire since the migration. If the real
   client turns out to emit `clear_tool_uses_*` / `clear_thinking_*`, that is a new
   decision routed through the adapter input, not a revert of this deletion.

2. **The `max_tokens 40000 → 32000` golden pin was retired with the tautological
   differential.** The clamp branch it covered is not unguarded: wire-baseline
   vector 06 pins the same `min()` clamp (`64000 → 32000`). Noted so nobody reads the
   deletion as lost coverage and re-adds a duplicate pin.

3. **`worker/sync-watcher` still auto-patches version literals this migration
   deleted.** Its patcher rewrites `FALLBACK_CLAUDE_CLI_VERSION` and the
   `CLI_TO_SDK_VERSION` map inside `index.mjs` (`src/delivery.mjs:194,196,218-219`,
   commit subject at `:284`, file map at `src/prompts.mjs:117`, and the fixtures in
   `test/delivery.test.mjs`). Those constants lived in the now-deleted
   `lib/request-headers.mjs`; the plugin derives the same values from `WIRE_PROFILE`
   today, so the regex replacements will silently match nothing and the watcher will
   open PRs that change no version. Stale, and out of this migration's scope — the
   watcher is a separate subproject with its own deploy and needs its own update.

   **Resolved by disable.** The cron trigger in `worker/sync-watcher/wrangler.toml`
   is now `crons = []`, so the watcher no longer wakes up to open no-op PRs. This
   defuses the symptom, not the cause: the patcher still targets deleted literals.
   Re-pointing it at `@tormentalabs/claude-code-wire-compat` (and re-enabling the
   cron) remains open work. The trigger also lives in Cloudflare's server-side
   state — the repo change only takes effect after a `wrangler deploy`.
