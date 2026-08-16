# Baseline da migração wire-compat (Wave 0 / Task 0.1.1-0.1.2)

> Congelado em 2026-08-16. Plugin HEAD `06f72ad` (master), pacote HEAD
> `0085ee5` (main, pós-fix do drift verifier). Suites verdes nos dois repos
> (plugin: 86 files / 1716 pass; pacote: 103 files / 2861 pass,
> `drift:check` exit 0). Números de linha referem-se a esses SHAs —
> **re-validar por grep antes de cada edit** (regra §6.5 do handover).
>
> Pré-flight resolvido antes deste baseline: o verificador de drift do pacote
> foi reancorado para o profile 2.1.233 e a asserção de sdkVersion passou a
> resolver via `CLI_TO_SDK_VERSION` com fallback (commit `0085ee5`, decisão em
> `MEMORY.md` do pacote). Próxima release do pacote = **0.5.0** (corte da
> prosa anti-verbosity NÃO saiu; CHANGELOG topo = 0.4.0).

## 1. Flags de config (nomes reais) e semântica de emulação-OFF

| Flag                                                       | Default     | Onde                                                                                                 |
| ---------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `signature_emulation.enabled`                              | `true`      | `lib/config.mjs:116` (default), `:556` (parse), `:1087/1093` (setters)                               |
| `signature_emulation.fetch_claude_code_version_on_startup` | `true`      | `lib/config.mjs:117`, `:560-561`, `:1100/1106`                                                       |
| `signature_emulation.prompt_compaction`                    | `"minimal"` | `lib/config.mjs:118`, `:564-565`, `:1110/1113`                                                       |
| `signature_emulation.workload`                             | `""`        | `:566` (parse)                                                                                       |
| `headers.emulation_profile`                                | `""`        | `lib/config.mjs:169`, `:631-632` — escolhe QUAL versão CC emular quando ON; não afeta o gate binário |

Env var: `OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE=0` desliga
(`lib/config.test.mjs:464-482`). O gate é **estritamente binário** — não há
modo intermediário configurável.

### Semântica REAL de emulação-OFF hoje (meia-mimicry, NÃO passthrough)

Com `signature_emulation.enabled=false`, `_useAdapter` é sempre false e o
request cai no caminho legacy (`index.mjs:3140+`, `buildRequestHeaders` em
`:3192`):

- **Sobrevivem 2 vetores de mimicry incondicionais**:
  1. `user-agent: claude-cli/2.1.233 (external, cli)` forjado sempre
     (`headers.mjs:452`, fora do gate `if (signature.enabled)` de `:453-508`);
  2. `anthropic-beta` mínimo forjado `oauth-2025-04-20,interleaved-thinking-2025-05-14`
     (+`token-counting-2024-11-01` em count_tokens) que **substitui** o header
     do host (early-return em `headers.mjs:190-199`).
- Header set final com OFF = exatamente `[anthropic-beta, authorization,
content-type, user-agent]` (pinado em
  `test/conformance/shared-package-parity.test.mjs:775-788`).
- Desligados de fato: `x-stainless-*`, `x-app`, `X-Claude-Code-Session-Id`,
  `anthropic-dangerous-direct-browser-access`, `x-client-request-id`,
  `metadata.user_id`, cache breakpoints, bloco billing/identity CC do system
  prompt (`system-prompt.mjs:516`, early-return `:570-572`).
- Beta latch (`index.mjs:2931-2992`) roda mas é **inerte** no path legacy:
  `buildRequestHeaders` computa seu próprio `mergedBetas`
  (`headers.mjs:433-445`) sem ler `computedBetaHeader`.
- `transformRequestBody` roda SEMPRE (`index.mjs:3039`) — com OFF pula
  `metadata.user_id` e cache breakpoints, mas mantém normalizações
  estruturais não-gateadas: output cap, strip de `betas`, normalização de
  `thinking`, `effort`→`output_config.effort` (+default `high`),
  `sanitizeSystemText`/`compactSystemText` (`request-body.mjs:87-138`,
  `system-prompt.mjs:500-502`).

**Consequência para a Phase 2.2**: redefinir OFF como passthrough puro é
**BREAKING** em ≥2 pontos testados (UA forjado, anthropic-beta substituído) e
exige reescrever `shared-package-parity.test.mjs:761-886`. CHANGELOG do
plugin deve marcar como breaking.

## 2. Inventário de consumidores (por alvo de migração)

Formato: símbolo → [prod] [test]. `(ref)` = menção em comentário, não call.

### A) `lib/request-headers.mjs` — DELETAR na Phase 2.3

Exports (11): `FALLBACK_CLAUDE_CLI_VERSION`(:22), `CLAUDE_CODE_NPM_LATEST_URL`(:23),
`CLAUDE_CODE_BUILD_TIME`(:29), `CLAUDE_CODE_GIT_SHA`(:30),
`ANTHROPIC_SDK_VERSION`(:40), `CLI_TO_SDK_VERSION`(:43), `getSdkVersion`(:167),
`EXPERIMENTAL_BETA_FLAGS`(:181), `BETA_SHORTCUTS`(:233),
`resolveBetaShortcut`(:282), `buildExtendedUserAgent`(:296).

Importadores do módulo: `index.mjs:13-18`, `lib/diagnose.mjs:8`,
`lib/mimicry/adapter-input.mjs:27`, `lib/mimicry/headers.mjs:3`,
`lib/request-headers.test.mjs`, `lib/mimicry/adapter-input.test.mjs:16`.

| Símbolo                       | Prod                                                    | Test                                                                         |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `FALLBACK_CLAUDE_CLI_VERSION` | `index.mjs:14,2218`; `lib/diagnose.mjs:8,175`           | `lib/request-headers.test.mjs:7,17,18,38,164-166`                            |
| `CLAUDE_CODE_NPM_LATEST_URL`  | `index.mjs:15,5878`                                     | —                                                                            |
| `CLAUDE_CODE_BUILD_TIME`      | `index.mjs:16,5493`                                     | —                                                                            |
| `CLAUDE_CODE_GIT_SHA`         | **morto** (só definição)                                | —                                                                            |
| `ANTHROPIC_SDK_VERSION`       | interno `:168`; `lib/oauth.mjs:26` (ref)                | `lib/request-headers.test.mjs:8,21-25,48-54`                                 |
| `CLI_TO_SDK_VERSION`          | interno `:168`                                          | indireto via getSdkVersion                                                   |
| `getSdkVersion`               | **sem caller de prod**                                  | `lib/request-headers.test.mjs:9,29-54`                                       |
| `EXPERIMENTAL_BETA_FLAGS`     | `adapter-input.mjs:27,404,428`; `headers.mjs:3,197,367` | `request-headers.test.mjs:11,81-88`; refs em regression/index tests          |
| `BETA_SHORTCUTS`              | `adapter-input.mjs:27,381`; `headers.mjs:3,354`         | `adapter-input.test.mjs:16,230,346,658`; `request-headers.test.mjs:10,58-77` |
| `resolveBetaShortcut`         | `index.mjs:17` → calls `:1345,1368,2922,2970,3657,3664` | `request-headers.test.mjs:12,92-126`                                         |
| `buildExtendedUserAgent`      | `headers.mjs:3,452`; `adapter-input.mjs:180` (ref)      | `request-headers.test.mjs:13,130-166`; `adapter-input.test.mjs:16,541,545`   |

### B) `lib/mimicry/models.mjs` — DELETAR na Phase 3.1

Exports: `CLAUDE_3_MODEL_RE`(:6), `isOpus46Model`(:15), `isOpus47Model`(:28),
`isOpus48Model`(:42), `isEligibleFor1MContext`(:54), `hasOneMillionContext`(:69),
`isSonnet46Model`(:78), `isFable5Model`(:87), `isMythos5Model`(:96),
`isAdaptiveThinkingModel`(:107), `normalizeThinkingBlock`(:123).

> Nota: `isHaikuModel`/`supportsStructuredOutputs`/`supportsWebSearch` vivem
> em `headers.mjs` (item C), não aqui — o plano original os listava errado.

| Símbolo                   | Prod                                                                                           | Test                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `isOpus46Model`           | `index.mjs:84,2493`; `request-body.mjs:24,609`; `system-prompt.mjs:3,562`; interno `:58,109`   | `models.test.mjs:10,28-30`                                                            |
| `isOpus47Model`           | `index.mjs:85,2494`; `request-body.mjs:25,609`; `system-prompt.mjs:3,109,562`                  | `models.test.mjs:11,34-36`                                                            |
| `isOpus48Model`           | `index.mjs:86,2495`; `request-body.mjs:26,609`; `system-prompt.mjs:3,109`                      | `models.test.mjs:12,40-42`                                                            |
| `isEligibleFor1MContext`  | `index.mjs:83,5175`                                                                            | `models.test.mjs:7,52-53`                                                             |
| `hasOneMillionContext`    | `index.mjs:82,2492,5166`; `adapter-input.mjs:26,571`; `headers.mjs:2,234`                      | `models.test.mjs:5,54-56`; `adapter-input.test.mjs:369`                               |
| `isSonnet46Model`         | interno `:112` (**sem caller externo**)                                                        | `models.test.mjs:13,46-48`                                                            |
| `isFable5Model`           | `index.mjs:89` (re-export); interno `:113`                                                     | `adaptive-thinking-models.test.mjs:3,6-14`; `public-api-contract.test.mjs:9,136,142`  |
| `isMythos5Model`          | `index.mjs:89`; interno `:114`                                                                 | `adaptive-thinking-models.test.mjs:3,17-24`; `public-api-contract.test.mjs:9,137,143` |
| `isAdaptiveThinkingModel` | `index.mjs:89`; `request-body.mjs:23,80,103,114,131`                                           | `adaptive-thinking-models.test.mjs:3,27-28`; `public-api-contract.test.mjs:9,138,144` |
| `normalizeThinkingBlock`  | `request-body.mjs:27,102`                                                                      | `models.test.mjs:14,88-127`                                                           |
| `CLAUDE_3_MODEL_RE`       | `adapter-input.mjs:26,389`; `headers.mjs:2,163,225,260,287,313,319`; `request-body.mjs:28,160` | `models.test.mjs:4,23-24`                                                             |

> `index.mjs:89` re-exporta `isFable5Model`/`isMythos5Model`/`isAdaptiveThinkingModel`
> como API pública do plugin (pinada por `test/conformance/public-api-contract.test.mjs`)
> — a Phase 3.1 precisa manter esses re-exports funcionando (redirecionar para
> o pacote), não pode simplesmente deletá-los.

### C) `lib/mimicry/headers.mjs` — constantes de beta na Phase 3.2

Exports (21): `CLAUDE_CODE_BETA_FLAG`(:6), `_EFFORT_BETA_FLAG`(:7),
`FAST_MODE_BETA_FLAG`(:8), `TOKEN_COUNTING_BETA_FLAG`(:9),
`HOST_SDK_BETAS_BLOCKLIST`(:10), `STAINLESS_HELPER_KEYS`(:14),
`_EFFORT_EXCLUDED_MODELS`(:21), `isNonInteractiveMode`(:29),
`parseAnthropicCustomHeaders`(:34), `isHaikuModel`(:54),
`supportsStructuredOutputs`(:58), `supportsWebSearch`(:63),
`parseRequestBodyMetadata`(:67), `buildStainlessHelperHeader`(:118),
`stripStainlessHelperMarkers`(:146), `isEffortCapableModel`(:161),
`buildAnthropicBetaHeader`(:167), `getStainlessOs`(:373),
`getStainlessArch`(:380), `buildRequestHeaders`(:386), `extractFileIds`(:516).

Consumidores-chave:

- `CLAUDE_CODE_BETA_FLAG` → `adapter-input.mjs:30,396`; interno `:210`
- `FAST_MODE_BETA_FLAG`, `TOKEN_COUNTING_BETA_FLAG`, `STAINLESS_HELPER_KEYS`,
  `isNonInteractiveMode`, `isEffortCapableModel` → **internos/mortos** (sem
  importador externo de prod)
- `HOST_SDK_BETAS_BLOCKLIST` → `adapter-input.mjs:31,278`; interno `:348` (host policy — FICA)
- `isHaikuModel` → `adapter-input.mjs:35,396`; `supportsStructuredOutputs` → `:37,392`; `supportsWebSearch` → `:38,388`
- `parseRequestBodyMetadata` → `index.mjs:62,2846`; `adapter-input.mjs:36,541`
- `buildStainlessHelperHeader` → `adapter-input.mjs:32,550`
- `stripStainlessHelperMarkers` → `index.mjs:64,3210`; `wire-compat.mjs:8,286,397`
- `buildAnthropicBetaHeader` → `index.mjs:61,2931`; interno `:433`
- `getStainlessOs`/`getStainlessArch` → `adapter-input.mjs:33-34,603-604`; golden tests
- `buildRequestHeaders` → `index.mjs:60,3192` (só caminho legacy)
- `extractFileIds` → `index.mjs:63,2655`

### D) `transformRequestUrl` — Phase 2.1

Definição `index.mjs:5924` (privada, não exportada nem testada diretamente).
Único call site: `index.mjs:2580`. Refs em comentários: `:3019,3122,3127`,
`shared-package-parity.test.mjs:851`.

### E) Beta latch — Phase 2.2

Região `index.mjs:2955-2992`. Estado `betaLatchState` definido `:304`,
dirtied `:1244,1254`, alimenta `computedBetaHeader` (build em `:2931`).
`sessionRejectedBetas` populado `:3657,3664`. Privado — exercitado só por
testes comportamentais de `index.test.mjs`. **No caminho legacy é inerte**
(ver §1); no caminho adapter alimenta os betas extras passados ao pacote.

### F) `lib/mimicry/system-prompt.mjs` — mimicry morto na Phase 2.3

| Símbolo                       | Prod                                                | Test                                                                                |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `getCLISyspromptPrefix`       | interno `:597`                                      | —                                                                                   |
| `getCachedCCPrompt`           | `index.mjs:71,6298`                                 | `system-prompt.test.mjs:6,92,101,103`                                               |
| `resetCachedCCPrompt`         | `index.mjs:74,6300-6301` (`__testing__`)            | `system-prompt.test.mjs:9,91,102`; `test-subagent-fix.mjs`; `test-pipeline-e2e.mjs` |
| `SUBAGENT_CC_ANCHOR`          | `index.mjs:77,6303` (`__testing__`); interno `:518` | `test-subagent-fix.mjs:12,65,79`; `test-pipeline-e2e.mjs:20,158-251`                |
| `buildAnthropicBillingHeader` | interno `:590` (via `buildSystemPromptBlocks`)      | —                                                                                   |
| `splitSysPromptPrefix`        | interno `:609`                                      | —                                                                                   |
| `tailSystemBlock`             | `request-body.mjs:5,354`                            | `system-prompt.test.mjs:11,30`                                                      |

### G) `lib/mimicry/adapter-input.mjs` — constantes de protocolo na Phase 3.3

Todos os 4 símbolos são internal-only em prod; consumidores externos só em teste:

- `PROFILE_CLI_VERSION` → interno `:212,214` | `adapter-input.test.mjs:12,42,537-563`
- `PROFILE_USER_AGENT` → interno `:214` | `adapter-input.test.mjs:13,537`
- `PROMPT_CACHING_SCOPE_BETA` → interno `:427` | —
- `SESSION_ID_FALLBACK` → interno `:598` | `adapter-input.test.mjs:11,97,100`

### H) Gate `_useAdapter` — Phase 2.2

`index.mjs:3033-3037`:

```js
const _useAdapter =
  getSignatureEmulationEnabled() &&
  (_adapterPathname === "/v1/messages" || _adapterPathname === "/messages" || _isCountTokens) &&
  typeof requestInit.body === "string" &&
  requestInit.body.length > 0;
```

(`_isCountTokens` = pathname ∈ `{/v1/messages/count_tokens, /messages/count_tokens}`,
`:3031-3032`.) Consumido em `:3045` (diagnostics) e `:3140` (branch adapter
vs legacy). Refs em comentários de shared-package-parity/usage tests.

### I) `lib/mimicry/cache.mjs` — avaliação na Phase 1.2.4

Exports: `resolveCacheTtl`(:9), `shouldPlaceToolBreakpoint`(:29),
`updateBoundaryStability`(:51).

- `shouldPlaceToolBreakpoint` → `index.mjs:51,6336` (`__cacheInternals`);
  `request-body.mjs:21,441` | `cache.test.mjs:3,46-76`; `cache-adaptive.test.mjs:7,114-144`
- `updateBoundaryStability` → `index.mjs:51,3104,6337` | `cache.test.mjs:3,86-104`;
  `cache-adaptive.test.mjs:7,148-197`

## 3. O que os conformance tests pinam hoje (Task 0.1.2)

Execução: 6 arquivos, 96/96 verdes (1.22s).

| Teste                                 | Pina                                                                                                                                             | Mecanismo                                                                                                                                                                                                                                                  | Tautológico pós-legacy?                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `golden-outgoing.test.mjs`            | Byte-shape literal de 1 request `/v1/messages` real do plugin (URL+headers+body)                                                                 | Fixture `test/fixtures/golden/outgoing-foreground.json` + deep-diff custom (`differingPaths()`); determinismo por auto-comparação de 2 runs com allowlist `GENERATED_PATHS` (`:72`: `metadata.user_id`, `x-claude-code-session-id`, `x-client-request-id`) | Não (adapter vs fixture)                                                  |
| `shared-package-parity.test.mjs`      | (1) golden do output do pacote (`:711+`); (2) pacote-bare vs plugin-wrapped, 13 vetores (`:583+`); (3) legacy path com emulação off (`:761-886`) | Diff byte-a-byte; transport fixo com UUIDs determinísticos (`:556-570`)                                                                                                                                                                                    | (2) já auto-flagged como "spent"; (3) vira morto quando 2.2 redefinir OFF |
| `wire-compat-input-coverage.test.mjs` | Todo campo de `ClaudeCodeRequestInput` (parseado do `.d.ts` instalado) é forwarded OU listado em `deliberateOmissions` com razão (bidirecional)  | Set-membership sobre fixture maximal inline (`:149-203`)                                                                                                                                                                                                   | Não                                                                       |
| `header-transport.test.mjs`           | Contrato de conversão `HeaderPair[]`→`Headers` (set-equivalence; ordem NÃO garantida — Headers ordena alfabeticamente)                           | Derivação mecânica dos dois lados (`bothSides()` `:57`); transport fixo `:37-50`                                                                                                                                                                           | Não                                                                       |
| `count-tokens-header-policy.test.mjs` | Delegação de `extraHeaderPolicy:"dropConflicting"` ao pacote em count_tokens; headers proibidos dropados                                         | Chamada direta ao pacote + `built.evidence.droppedExtraHeaderNames`; `RUNTIME` fixo com `os:"Linux"` hardcoded (`:32-43`) — determinismo mais forte da suite                                                                                               | Não                                                                       |
| `package-dependency-policy.test.mjs`  | Contrato do seam (ver abaixo)                                                                                                                    | Regex/leitura de manifest+lockfile+docs                                                                                                                                                                                                                    | Não                                                                       |
| `regression.test.mjs`                 | ~40 asserções de mimicry contra `docs/claude-code-reverse-engineering.md`; backoff 529 (sleeps 2-3s)                                             | Vários                                                                                                                                                                                                                                                     | Auditar na 4.1                                                            |

### Contrato do seam (`package-dependency-policy.test.mjs`, lido integralmente)

- **Specifier** (`:57-113`): só `latest` (dist-tag deliberado), semver exato
  (rollback de emergência), ou tarball de release RC histórico. Ranges,
  outros dist-tags, git/file/workspace = rejeitados.
- **Lockfile** (`:139-169`): entry com `version` exato, `integrity` sha512,
  `license: "GPL-3.0-or-later"`, `resolved` = tarball do registry npm para
  exatamente a versão do lock.
- **Provenance/NOTICE/README** (`:171-244`): `docs/shared-package-provenance.md`
  documenta política `latest`+lockfile+`npm ci`; NOTICE nomeia pacote, licença
  GPL e upstream; README aponta para ambos; runbook de rollback com SHAs reais
  (`git revert --no-edit <sha>`), sem placeholders, e afirma "no runtime
  kill-switch".
- **Import estático** (`:246-258`): regex EXATA
  `^import \{ buildClaudeCodeRequest, buildClaudeCodeCountTokensRequest \} from "@tormentalabs/claude-code-wire-compat";$`
  (multiline) contra `lib/mimicry/wire-compat.mjs`. **Qualquer mudança no
  import do seam (Phases 3.1/3.3) atualiza esta regex no MESMO commit.**

### Padrão de determinismo a replicar no harness 0.1.4

Transport fixo com UUIDs injetados (sem mock de crypto):
`shared-package-parity.test.mjs:556-570` — `sessionId:
"11111111-1111-4111-8111-111111111111"`, `deviceId: "2".repeat(64)`,
`accountUuid: "33333333-...`, `clientRequestId: "aaaaaaaa-...")`. Espelhado em
`header-transport.test.mjs:37-50` e `count-tokens-header-policy.test.mjs:32-43`
(este com `os: "Linux"` hardcoded — adotar no harness para independência de
plataforma). Para o caminho que atravessa o plugin real
(`driveForegroundRequest`), a normalização é a allowlist `GENERATED_PATHS` de
`golden-outgoing.test.mjs:72` + normalização stainless os/arch `:73-77`.

## 4. Descobertas que afetam waves futuras

1. **Acoplamento cross-repo do drift verifier do PACOTE**: `scripts/verify-drift.mjs`
   do pacote usa `D:\git\opencode-anthropic-fix\lib\request-headers.mjs` como
   oráculo (DEFAULT_SOURCE). Quando a Phase 2.3 deletar esse arquivo, o
   verificador do pacote perde o source real. **A Phase 2.3 deve incluir:
   decidir/reapontar o oráculo do drift do pacote** (opções: apontar para
   outro consumidor, congelar em fixtures, ou aceitar skip quando source
   ausente — o teste já skipa se o diretório não existir, mas o arquivo
   sumindo com o diretório presente provavelmente ERRA em vez de skipar).
2. **Exports mortos/internos** (candidatos a deleção simples sem migração):
   plugin — `CLAUDE_CODE_GIT_SHA`, `getSdkVersion` (sem caller prod),
   `FAST_MODE_BETA_FLAG`, `TOKEN_COUNTING_BETA_FLAG`, `STAINLESS_HELPER_KEYS`,
   `isNonInteractiveMode`, `isEffortCapableModel`, `getCLISyspromptPrefix`,
   `buildAnthropicBillingHeader`, `splitSysPromptPrefix`, `isSonnet46Model`
   (sem caller externo).
3. **API pública do plugin** re-exporta predicados de modelo
   (`index.mjs:89`, pinado por `public-api-contract.test.mjs`) — Phase 3.1
   mantém os re-exports redirecionando ao pacote.
4. **Emulação-off é meia-mimicry** (ver §1) — Phase 2.2 é breaking;
   CHANGELOG major bump provável (plugin está em 0.6.0).
5. **`transformRequestBody` não é passthrough nem com emulação off** —
   normalizações estruturais (effort/thinking/output-cap/strip betas) rodam
   sempre. O redesenho da 2.2 deve decidir explicitamente se passthrough puro
   também desliga essas normalizações (recomendação: sim para mimicry, mas
   output-cap/effort são host policy legítima — fronteira §1 do plano).
6. **Beta latch é inerte no caminho legacy** — só o caminho adapter consome
   `computedBetaHeader`. Simplifica a Phase 2.2: remover o latch do caminho
   de messages não muda o wire legacy.

## 5. QA review da Phase 0.1 — findings e disposição

1. **(major, CORRIGIDO em `00ad7c0`)** Vetor 06 do harness pinava 1M só via
   `custom_betas`; adicionado vetor 15 exercitando a escalação natural por
   `resolveAdaptiveContext` (threshold rebaixado a 20k — config de host, não
   predicado; o literal 150k default não é alvo da migração). Beta
   `context-1m-2025-08-07` comprovadamente vindo do predicado (posição 3 vs 9).
2. **(minor, aceito)** `PROMPT_CACHING_SCOPE_BETA` sem teste direto; efeito no
   wire coberto pelas fixtures do harness. Phase 3.3 o substitui.
3. **(minor, aceito)** Branches de de-escalação (`index.mjs:5204-5213`) e
   error-sticky (`:5188-5201`) do adaptive context não cobertos pelo harness
   (exigem estado multi-turno). São host policy fora do escopo da migração —
   as phases só tocam os predicados, cobertos pelos vetores 06/15.
4. Inventário validado por 3 greps independentes (resolveBetaShortcut,
   hasOneMillionContext, PROMPT_CACHING_SCOPE_BETA/SESSION_ID_FALLBACK):
   zero divergências. Fixtures sem segredos (authorization `<redacted>`).
