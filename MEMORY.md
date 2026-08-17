# MEMORY

Append-only decision log, newest entry first. Each entry records decisions whose
_reasoning_ is not reconstructable from the code — what was decided, and why the
alternative was rejected. Code-level detail belongs in the source; contracts belong
in `docs/`. This file exists so a later session does not re-litigate a settled call.

Do not edit past entries. Add a new one instead.

---

## 2026-08-16 — Wire-compat consolidation migration (Waves 0-4)

The plugin stopped carrying its own implementation of Claude Code protocol
composition. Headers, body shape, system prefix, beta lists, URL, model queries and
protocol constants now come from `@tormentalabs/claude-code-wire-compat` through a
single seam. Decisions taken along the way, and what each one closes off:

- **D1 — Model API shape: generic capability + named predicates, both package-side.**
  The package exports a generic `modelCapability`-style query _and_ named predicates
  (`isOpus46Model`, `isFable5Model`, ...). The plugin re-exports the named ones; it
  does not re-derive them from the generic query, and it does not keep regexes. A
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
  `isEligibleFor1MContextWire` passes `WIRE_PROFILE` (the 2.1.233 catalogue) rather
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
