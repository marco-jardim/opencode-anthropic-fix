# Plano de Migração — Consolidar todo o domínio de mimicry no wire-compat

> Status: PLANEJADO. Criado em 2026-08-16. Revisão senior (regressão +
> dono-único-do-mimicry) aplicada em 2026-08-16 — ver §Histórico de revisão.
> Repositórios: plugin `D:\git\opencode-anthropic-fix` (este repo) e pacote
> `D:\git\claude-code-wire-compat` (`@tormentalabs/claude-code-wire-compat`).
> Plataforma de execução: win32, pwsh.

## 1. Objetivo

Migrar tudo que é **domínio de wire-mimicry do Claude Code** para o pacote
`@tormentalabs/claude-code-wire-compat`, e fazer o plugin consumir esse domínio
exclusivamente via pacote. Ao final, o plugin fica com: transporte, OAuth,
contas/rotação, política de token economy, sanitização, anti-verbosidade,
transform de resposta e CLI — **zero conhecimento de versão do Claude Code
fora do pacote**.

`transformRequestBody` (`lib/mimicry/request-body.mjs:66`) **continua
existindo**: ele é o pipeline de conversões específicas do OpenCode
(repair de tool_use órfão, token economy, sanitização, anti-verbosidade,
metadata do host). O que sai dele/do redor é apenas o que o cliente CC genuíno
faz — o envelope canônico (headers, betas, URL, versões CLI/SDK, classificação
de modelo).

### Critério de fronteira (aplicar em toda decisão deste plano)

> "O cliente Claude Code genuíno faz isso?" → wire-compat.
> "É comportamento específico do OpenCode?" → plugin.

## 2. Não-objetivos (explícitos, com razão)

| Item                                                                                         | Fica onde está | Razão                                                                                        |
| -------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| Token economy (`lib/token-economy/`, microcompact, tool deferral)                            | plugin         | Política do host, CC não faz                                                                 |
| Sanitização "OpenCode → Claude Code" (`lib/mimicry/system-prompt.mjs`)                       | plugin         | Específico do host                                                                           |
| Prosa/injeção de anti-verbosidade (`system-prompt.mjs:34-47`, gate `lib/config.mjs:309-315`) | plugin         | Política do host; prosa própria; o pacote está removendo prosa (dual-license MIT)            |
| Transform SSE de resposta (`lib/mimicry/response-stream.mjs`, mapa `CC_TO_OC_TOOL_NAMES`)    | plugin         | Tradução para nomes de tool do OpenCode = domínio do host; pacote é request-only por decisão |
| Tuning próprio de cache (`updateBoundaryStability`, TTL por config do host)                  | plugin         | Heurística do OpenCode, não comportamento do CC                                              |
| Rolling summarizer, haiku-call, message-transform, session-metrics                           | plugin         | Operação do host                                                                             |

> Atenção (revisão senior): `lib/mimicry/system-prompt.mjs` e
> `lib/mimicry/cache.mjs` são MISTOS. As partes de host policy acima ficam;
> as partes que reproduzem o CC (prefixo canônico/billing/âncoras em
> `system-prompt.mjs`; posicionamento canônico de breakpoints em `cache.mjs`)
> ESTÃO no escopo da migração — ver Phases 1.2, 2.3 e 3.3. "Expose, let the
> caller decide" significa lógica canônica NO PACOTE e decisão no plugin, não
> lógica canônica no plugin.

## 3. Diretivas globais de execução

### 3.1 Autonomia entre waves

**Execute o plano iterando wave a wave, sem interrupções.** Pare e consulte o
humano SOMENTE se: (a) surgir ambiguidade que altere o desenho (duas
interpretações com custo ≥2x de diferença); (b) problema crítico/bloqueante
(teste golden quebrando sem causa identificada, publish do npm exigindo OTP,
regressão de wire detectada em conformance); (c) qualquer necessidade de
alterar contrato público do pacote além do previsto aqui. Fora isso, decida e
registre a decisão no commit message e no `MEMORY.md` do repo afetado.

### 3.2 Paralelismo seguro (orquestração)

- **Entre repositórios**: Wave 1 (pacote) e Wave 2 (plugin) tocam repositórios
  diferentes com conjuntos de arquivos 100% disjuntos → **execute em paralelo**.
- **Dentro de uma phase**: tasks marcadas com `∥` podem rodar em paralelo;
  tasks numeradas em sequência têm dependência.
- **Regra de posse de arquivo**: cada task declara os arquivos que ESCREVE.
  Um arquivo só pode estar em UMA task em execução por vez. Nenhum agente lê um
  arquivo listado como "em escrita" por outra task em andamento — leia antes de
  despachar ou aguarde a task dona terminar. A matriz de posse por phase está
  no Apêndice A.
- **Testes**: `npm test` roda serializado por repositório (nunca dois `npm test`
  simultâneos no mesmo repo; vitest compete por portas/tmp).

### 3.3 Commit often

- 1 commit por task concluída (mínimo); commits atômicos, prefixos
  convencionais do repo (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Nunca committar com teste quebrado, EXCETO commits `wip:` em branch de
  trabalho — proibido em `master`.
- Plugin: lembrar que `pre-commit` roda `npm test` + lint-staged (~13s+) e
  `pre-push` roda suite completa — orçar tempo.
- Antes de cada QA review de phase: working tree limpa.

### 3.4 Model-router (anotação de tiers)

- `[tier:fast]` — buscas, leituras, greps, inventários, verificação de
  pre-flight. Sempre com `path` absoluto explícito (greps sem path já
  resolveram para repo errado nesta base).
- `[tier:medium]` — implementação: edits, testes novos, refactors, fixes de QA.
- `[tier:heavy]` — pre-flight de decisão arquitetural, senior QA review de cada
  phase, QA global, análise de regressão golden.
- Despachos de implementação devem receber: arquivos de posse, padrão do
  codebase, comando de verificação, working directory explícito.

## 4. Estado atual (baseline factual, verificado em 2026-08-16)

- Único import de produção do pacote: `lib/mimicry/wire-compat.mjs:7`
  (`buildClaudeCodeRequest` chamado em `:289`,
  `buildClaudeCodeCountTokensRequest` em `:400`), travado por regex em
  `test/conformance/package-dependency-policy.test.mjs:246-258`.
- Gate condicional `_useAdapter` em `index.mjs:3005-3037` (emulação ligada +
  endpoint `/v1/messages`|count_tokens + body JSON). Caminho legacy completo
  existe como fallback.
- `built.url` do pacote é **descartado** (`index.mjs:3122-3128`); URL sempre
  local via `transformRequestUrl()` (`index.mjs:5924-5969`).
- Duplicações de manutenção dual:
  - `lib/request-headers.mjs` (303 linhas): `FALLBACK_CLAUDE_CLI_VERSION="2.1.233"`,
    `CLI_TO_SDK_VERSION`, `buildExtendedUserAgent`, beta shortcuts — contrato
    manual "bump both together" (`:19-21`, `:44-48`).
  - Beta latch inline `index.mjs:2960-2992` + constantes em
    `lib/mimicry/headers.mjs` (`CLAUDE_CODE_BETA_FLAG`, `FAST_MODE_BETA_FLAG`,
    `TOKEN_COUNTING_BETA_FLAG`, blocklist, predicados de capability).
  - `lib/mimicry/models.mjs` (ids com ponto) vs `normalizeModelId` do pacote
    (ids com traço); rewrite `4.7`→`4-7` no seam (`wire-compat.mjs:62`).
  - `lib/mimicry/adapter-input.mjs` hardcoda constantes de protocolo:
    `PROFILE_CLI_VERSION="2.1.233"`, `PROFILE_USER_AGENT="claude-cli/2.1.233
(external, cli)"`, `PROMPT_CACHING_SCOPE_BETA`, `SESSION_ID_FALLBACK` —
    mesmo contrato "bump both together" do request-headers.mjs, só que no seam.
    O pacote já exporta os profiles com `cliVersion`; o plugin deve ler de lá
    (Phase 3.3).
  - `lib/mimicry/system-prompt.mjs` carrega mimicry puro além da host policy:
    `getCLISyspromptPrefix`, `getCachedCCPrompt`/`resetCachedCCPrompt`,
    `SUBAGENT_CC_ANCHOR`, `buildAnthropicBillingHeader`, `splitSysPromptPrefix`
    — no caminho adapter o pacote já compõe prefixo canônico + billing
    (`index.mjs:3116-3120`); vira código morto após a Wave 2 (Phase 2.3).
- Pacote em 0.4.0; dependência do plugin: `"latest"` (`package.json:58`),
  lockfile resolve 0.4.0 com integridade de registry (política em
  `package-dependency-policy.test.mjs:57-169`).
- Pacote tem governança rígida: array FECHADO de exports
  (`test/runtime/runtime-neutral.test.ts:68-78`), versão pinada
  (`test/governance/package-policy.test.ts:59`), neutralidade de runtime
  (`source-hygiene.test.ts:59-81`), source-trace, public-path-coverage.
- Track paralelo já decidido no pacote: corte da prosa anti-verbosity
  (release 0.5.0). **Este plano assume que a nova superfície entra em 0.6.0**
  (ou 0.5.0 se o corte da prosa ainda não tiver sido feito — resolver no
  pre-flight da Phase 1.1, sem ambiguidade: o primeiro release a sair usa o
  próximo número disponível).

## 5. Estrutura do plano

```
WAVE 0  Baseline e guardrails                       (ambos os repos)
WAVE 1  Pacote: expor a superfície que falta        (claude-code-wire-compat)   ∥ com WAVE 2
WAVE 2  Plugin: adapter incondicional + built.url   (opencode-anthropic-fix)    ∥ com WAVE 1
WAVE 3  Plugin: consumir a nova superfície          (depende de W1 publicada + W2)
WAVE 4  Consolidação, docs, QA global               (ambos)
```

Cada phase segue o ciclo obrigatório:

```
PRE-FLIGHT → TASKS → NOVOS TESTES → CRITÉRIOS DE ACEITAÇÃO → DoD →
SENIOR QA REVIEW [tier:heavy] → FIX de TODOS os apontamentos [tier:medium] →
re-run da suite → COMMIT final da phase
```

O QA review de phase produz uma lista numerada de findings com severidade
(blocker/major/minor). **Todos** são corrigidos antes de avançar — minor pode
ser corrigido ou registrado como issue com justificativa explícita no commit.

---

## WAVE 0 — Baseline e guardrails

### Phase 0.1 — Congelar baseline verificável

**Pre-flight** `[tier:fast]`:

- [ ] `git status` limpo nos dois repos; anotar SHA de HEAD de cada um.
- [ ] Plugin: `npm test` verde; pacote: `npm test && npm run typecheck && npm run lint && npm run pack:check` verdes.
- [ ] Confirmar versão publicada atual do pacote no lockfile do plugin.
- [ ] Confirmar se o corte da prosa anti-verbosity já saiu no pacote (define numeração 0.5.0/0.6.0).

**Tasks**:

1. `[tier:fast]` ∥ Inventário de consumidores exatos (grep com path absoluto), gravado em `docs/plans/wire-compat-migration-baseline.md` no plugin:
   - todos os call sites de `lib/request-headers.mjs` (imports em `index.mjs`, `cli.mjs`, testes);
   - todos os call sites de `lib/mimicry/models.mjs`;
   - todos os call sites das constantes de beta de `lib/mimicry/headers.mjs`;
   - consumidores de `transformRequestUrl` e do beta latch (`index.mjs:2960-2992`);
   - nomes exatos dos flags de config que ligam emulação/adapter (`lib/config.mjs`) e a semântica de emulação-OFF hoje.
2. `[tier:fast]` ∥ Capturar amostras golden atuais: rodar os testes de conformance do plugin que diffam adapter vs legacy (`test/conformance/golden-outgoing.test.mjs`, `shared-package-parity.test.mjs`, `wire-compat-input-coverage.test.mjs`, `header-transport.test.mjs`, `count-tokens-header-policy.test.mjs`) e registrar o que cada um pina.
3. `[tier:medium]` Criar tag/branch de baseline em cada repo (`migration-baseline`).
4. `[tier:medium]` **Harness de paridade byte-exata** (`test/conformance/migration-parity.test.mjs`
   - fixtures em `test/fixtures/migration-baseline/`): gravar, para uma matriz
     de ≥12 requests representativos, o output REAL do interceptor de hoje —
     URL + headers ordenados + body canônico (JSON estável) — usando harness
     determinístico (crypto injetado, session/device ids fixos, mesmo padrão dos
     conformance tests existentes). Matriz mínima: simple, tools, streaming,
     count_tokens (com/sem betas), 1M context, fast-mode, betas custom do
     usuário, emulação-off, e cobertura de famílias (haiku/sonnet/opus/fable).
     Este teste roda verde após CADA phase de TODAS as waves; divergência
     legítima (bugfix de legado) atualiza a fixture com justificativa no commit.

**Novos testes**: `migration-parity.test.mjs` (o harness acima). É o
instrumento central de prevenção de regressão do plano — e é PERMANENTE
(ver Phase 4.1): após a migração ele passa a proteger contra release quebrada
do pacote.

**Critérios de aceitação**:

- Baseline doc existe com file:line de cada consumidor e nomes reais de flags.
- Harness verde e fixtures commitadas; re-rodar duas vezes produz bytes
  idênticos (determinismo provado).
- Suites verdes registradas com SHA.

**DoD**: baseline commitada nos dois repos; harness determinístico verde;
nenhuma pergunta em aberto sobre "quem consome o quê" — qualquer lacuna
encontrada aqui atualiza este plano ANTES da Wave 1.

**Senior QA review** `[tier:heavy]`: validar completude do inventário por
amostragem (3 greps independentes); confirmar que a semântica de emulação-OFF
está documentada sem ambiguidade. Corrigir apontamentos.

---

## WAVE 1 — Pacote: expor a superfície que falta

> Repo: `D:\git\claude-code-wire-compat`. Governança: cada export novo exige
> atualizar `src/index.ts`, o array fechado de
> `test/runtime/runtime-neutral.test.ts:68-78`, testes de validação com import
> do entry público (`test/governance/public-path-coverage.test.ts`), e
> `docs/source-trace.md` quando citar teste novo. Neutralidade de runtime:
> nenhum builtin de node em `src/` (crypto só injetado).

### Phase 1.1 — API de identidade de modelo e capabilities

**Pre-flight** `[tier:fast]`:

- [ ] Resolver numeração de release (0.5.0 vs 0.6.0) conforme estado do corte da prosa.
- [ ] Ler `src/model-identity.ts` e mapear o que `normalizeModelId` já cobre; verificar se aceita ids com ponto (`4.7`) — hoje NÃO (rewrite vive no plugin, `wire-compat.mjs:62`).
- [ ] Listar todos os predicados do plugin a cobrir: `isOpus46/47/48Model`, `isSonnet46Model`, `isFable5Model`, `isEligibleFor1MContext`, `hasOneMillionContext`, `isHaikuModel`, `supportsStructuredOutputs`, `supportsWebSearch` (baseline 0.1 fornece call sites).
- [ ] `[tier:heavy]` Decisão de desenho: predicados nomeados 1-a-1 vs API genérica `modelCapability(rawModel, capability, profile?)` orientada pelos arrays `capabilities` dos profiles. Default recomendado: **API genérica + meia dúzia de predicados nomeados para famílias** (regex de família não é capability de catálogo). Registrar decisão no MEMORY.md.

**Tasks**:

1. `[tier:medium]` `src/model-identity.ts`: aceitar ids com ponto (`claude-opus-4.7` → normaliza para `4-7`), preservando comportamento atual para todos os inputs já aceitos. Posse: `src/model-identity.ts`.
2. `[tier:medium]` Novo módulo `src/model-queries.ts` (nome final a critério do executor): predicados de família + query de capability contra o profile default/injetado, seguindo o padrão default-parameter-singleton do repo (`CLAUDE_CODE_2_1_195_PROFILE` ou o pinado atual). Posse: `src/model-queries.ts`, `src/contracts.ts` (tipos novos).
3. `[tier:medium]` Exportar no barrel `src/index.ts` + atualizar array fechado `runtime-neutral.test.ts:68-78` + `public-path-coverage` se houver teste interno novo. Posse: `src/index.ts`, `test/runtime/runtime-neutral.test.ts`, `test/governance/public-path-coverage.test.ts`.

**Novos testes** `[tier:medium]` (`test/validation/model-queries.test.ts`):

- ids com ponto vs traço (equivalência byte-a-byte da classificação);
- sufixo de data (`-20250929`), sufixo `-eap` cru (`-eap`, `-eap[foo]`, case-insensitive);
- modelos desconhecidos (`gpt-4o`, string vazia → `INVALID_INPUT`);
- capability ausente vs presente no catálogo (reusar o padrão `withCapabilities` de `test/validation/anti-verbosity.test.ts:14-29` — profile reconstruído);
- paridade com o profile 2.1.233 além do default;
- 1M context: fronteiras exatas das famílias elegíveis.

**Critérios de aceitação**:

- Toda classificação que o plugin faz hoje em `models.mjs`/`headers.mjs` tem
  equivalente exportado no pacote com resultado idêntico (tabela de paridade no
  PR: input → resultado plugin → resultado pacote).
- Golden fixtures do pacote inalteradas (`npm run fixtures:check` verde) — a
  superfície nova não muda um byte do wire.

**DoD**: typecheck/lint/test/pack:check verdes; source-trace atualizado;
MEMORY.md registra a decisão de desenho; commit atômico por task.

**Senior QA review** `[tier:heavy]`: revisar assinatura da API nova contra o
risco de acoplamento (o pacote não pode importar noção de "OpenCode");
verificar edge cases de normalização com ponto; conferir array fechado de
exports. Corrigir tudo.

### Phase 1.2 — Contrato de URL e lacunas de count_tokens/betas

**Pre-flight** `[tier:fast]`:

- [ ] Diffar `transformRequestUrl()` do plugin (`index.mjs:5924-5969`) contra o `built.url` do pacote para TODOS os casos: `/v1/messages`, `/v1/messages/count_tokens`, sufixo `?beta=true`, base URL custom do host.
- [ ] Verificar se o pacote expõe controle de base URL no input; se não, decidir `[tier:heavy]`: adicionar `baseUrl` opcional ao input OU documentar que o host substitui host/origin mantendo path+query do pacote. Recomendado: opção no input (URL é parte do envelope).

**Tasks**:

1. `[tier:medium]` Implementar a lacuna de URL decidida no pre-flight (com golden fixtures novas se o input ganhar campo — campos novos opcionais não podem alterar fixtures existentes; seguir o precedente de `extraHeaderPolicy` no CHANGELOG 0.4.0: omitir campo = bytes idênticos). Posse: `src/` conforme decisão + fixtures.
2. `[tier:fast]` ∥ Auditar se alguma constante de beta consumida pelo plugin fora do builder (ex.: `TOKEN_COUNTING_BETA_FLAG` usado em código de UI/status) precisa virar export — só exportar o que tiver consumidor real na Wave 3; nada especulativo. Critério: mesmo quando a DECISÃO de ligar uma feature é do host, a CONSTANTE do protocolo (string do beta flag) pertence ao pacote.
3. `[tier:medium]` Exports de beta que a auditoria 2 justificar (mesmo ritual de barrel + array fechado).
4. `[tier:heavy]` Avaliar migração da lógica CANÔNICA de posicionamento de
   cache breakpoints (`lib/mimicry/cache.mjs:shouldPlaceToolBreakpoint`) para
   export do pacote. Critério objetivo: se o algoritmo reproduz posicionamento
   observado do cliente CC, a computação migra (pacote expõe, plugin decide
   aplicar); se for heurística própria do OpenCode (`updateBoundaryStability`,
   TTL por config), fica no plugin com comentário de fronteira. Registrar a
   classificação função a função no MEMORY.md do pacote; implementação
   `[tier:medium]` se houver migração.

**Novos testes**: paridade de URL byte-exata para os 4 casos acima (com e sem
base custom); campo novo omitido ⇒ fixtures existentes intactas (o repo já tem
esse padrão de teste de compat).

**Critérios de aceitação**: para todo request que o plugin monta hoje, existe
um caminho no pacote que produz URL byte-idêntica; zero mudança nas fixtures
existentes quando os campos novos são omitidos.

**DoD**: suites verdes; CHANGELOG do pacote com seção da release nova
(Added, sem breaking); commit por task.

**Senior QA review** `[tier:heavy]`: foco em compat — algum caller existente do
pacote pode observar diferença? Fixtures re-seladas são idênticas? Corrigir.

### Phase 1.3 — Release do pacote

**Pre-flight** `[tier:fast]`:

- [ ] Working tree limpa; `npm run pack:check`, `npm run drift:check`, `npm run fixtures:check`, `npm test` verdes.
- [ ] `package.json:3` + `test/governance/package-policy.test.ts:59` bumpados em lockstep.
- [ ] Tarball inspecionado (`npm pack` + extração em `$env:TEMP`): superfície nova presente em `dist/`.

**Tasks**:

1. `[tier:medium]` Bump de versão + CHANGELOG + commit `chore: release X.Y.Z`.
2. `[tier:medium]` `npm publish` — **ponto de possível interrupção humana**
   (OTP/token). Se bloquear, este é um caso legítimo da diretiva 3.1(b):
   pausar Wave 3, prosseguir com o que restar da Wave 2.
3. `[tier:fast]` Verificar disponibilidade no registry e integridade.

**Critérios de aceitação / DoD**: versão pública instalável; CI do pacote verde
no commit de release.

**Senior QA review** `[tier:heavy]`: checklist de release (conteúdo do tarball,
CHANGELOG fiel, sem arquivo extra publicado). Corrigir antes do publish se
qualquer item falhar.

---

## WAVE 2 — Plugin: adapter incondicional + built.url (∥ com Wave 1)

> Repo: `D:\git\opencode-anthropic-fix`. Nenhuma task desta wave depende de
> release novo do pacote — tudo funciona contra a versão do lockfile atual.

### Phase 2.1 — Adotar `built.url`

**Pre-flight** `[tier:fast]`:

- [ ] Confirmar no baseline 0.1 todos os consumidores de `transformRequestUrl` (`index.mjs:5924-5969`).
- [ ] Confirmar o motivo documentado do descarte em `index.mjs:3122-3128` e se há caso de base URL custom que o pacote 0.4.0 não cobre (se houver e a Phase 1.2 ainda não publicou: adotar `built.url` com override local SÓ de origin, mantendo path/query do pacote — remove o grosso da duplicação sem esperar a release).

**Tasks**:

1. `[tier:medium]` No caminho adapter, usar `built.url` (com a estratégia de origin decidida acima). `transformRequestUrl` fica apenas para o caminho passthrough/emulação-off. Posse: `index.mjs` (janela do fetch/adapter), `docs/mimese-http-header-system-prompt.md` (sync obrigatório por AGENTS.md).
2. `[tier:medium]` ∥ Testes: atualizar os testes de URL em `index.test.mjs`/conformance que assumem URL local no caminho adapter.

**Novos testes**: caminho adapter usa URL do pacote (messages e count_tokens,
com/sem `?beta=true`, com base custom); caminho emulação-off preserva
comportamento anterior byte-a-byte.

**Critérios de aceitação**: zero diff nos golden de headers/body; diff de URL
apenas onde o legacy divergia do pacote (se divergir, isso é BUG do legacy —
documentar no commit).

**DoD**: suite verde; doc de mimicry sincronizada; commits atômicos.

**Senior QA review** `[tier:heavy]`: revisar a estratégia de origin custom
contra proxies/gateways que usuários usam; conferir que emulação-off não mudou.
Corrigir.

### Phase 2.2 — Adapter incondicional (emulação ligada)

**Pre-flight** `[tier:fast]` + `[tier:heavy]` (decisão):

- [ ] Enumerar TODAS as condições atuais de `_useAdapter` (`index.mjs:3005-3037`) e o que cai no legacy hoje: emulação-off, body não-JSON, endpoints fora de messages/count_tokens.
- [ ] Decisão de semântica: **emulação-on ⇒ adapter sempre** (messages/count_tokens com body JSON); **emulação-off ⇒ passthrough puro** (headers mínimos de auth, sem meia-mimicry). Endpoints fora dos dois continuam passthrough. Se o baseline 0.1 revelar um modo intermediário com usuários reais, isso é ambiguidade 3.1(a) → humano.

**Tasks**:

1. `[tier:medium]` Remover as condições que roteiam requests elegíveis para o legacy quando emulação está ligada; o legacy de mimicry deixa de ser alcançável para messages/count_tokens.
2. `[tier:medium]` Redefinir emulação-off como passthrough puro (sem beta latch, sem UA fake) — comportamento documentado no README/CONTRIBUTING.
3. `[tier:medium]` ∥ Remover o beta latch inline (`index.mjs:2960-2992`) do caminho de messages; se o count_tokens legacy o usava, morre junto.

**Novos testes** (com bons edge cases):

- emulação-on + body JSON inválido/vazio (o que o adapter faz — erro claro, não fallback silencioso para legacy);
- emulação-on + endpoint não coberto (models list, etc.) ⇒ passthrough;
- emulação-off ⇒ nenhuma header de mimicry presente (asserção negativa lista as headers proibidas);
- streaming vs non-streaming; count_tokens com e sem betas;
- retry/rotação continuam funcionando no caminho adapter (429 rotaciona, 529 service-wide) — smoke com mocks;
- **smoke de integração ponta a ponta** (não só unitário): fetch mockado
  devolvendo 429→sucesso provando rotação de conta através do caminho adapter;
  e um SSE gravado atravessando interceptor→adapter→`transformResponse`
  (strip de `mcp_`, usage, headers `x-opencode-*`) — o retry loop
  (`index.mjs:2691+`) interage com o adapter e testes unitários mock-heavy não
  provam essa interação.

**Critérios de aceitação**: nenhum request de messages/count_tokens com
emulação ligada passa pelo código legacy (provar com teste que instrumenta o
caminho); conformance golden verde.

**DoD**: suite completa verde; `CHANGELOG.md` do plugin com entrada de
comportamento; docs sync.

**Senior QA review** `[tier:heavy]`: caçar fallbacks silenciosos remanescentes
(grep por chamadas aos helpers legacy); revisar semântica emulação-off contra
expectativas de usuários (breaking? anotar no CHANGELOG como breaking se sim).
Corrigir tudo.

### Phase 2.3 — Deletar o legacy de headers E de system-prompt mimicry

**Pre-flight** `[tier:fast]`:

- [ ] Grep: consumidores restantes de `lib/request-headers.mjs` e de cada export dele (`FALLBACK_CLAUDE_CLI_VERSION`, `CLI_TO_SDK_VERSION`, `buildExtendedUserAgent`, `EXPERIMENTAL_BETA_FLAGS`, `BETA_SHORTCUTS`, `resolveBetaShortcut`, `CLAUDE_CODE_BUILD_TIME`, `CLAUDE_CODE_GIT_SHA`). Esperado após 2.2: só testes e talvez UI de status/diagnose.
- [ ] Grep: consumidores restantes das funções de mimicry de `lib/mimicry/system-prompt.mjs`: `getCLISyspromptPrefix`, `getCachedCCPrompt`, `resetCachedCCPrompt`, `SUBAGENT_CC_ANCHOR`, `buildAnthropicBillingHeader`, `splitSysPromptPrefix`, `tailSystemBlock`. Classificar cada uma: morta após 2.2 (deletar) vs consumida pela host policy (fica com justificativa).
- [ ] Para cada consumidor remanescente: classificar pela fronteira (§1). Diagnóstico/status que REPORTA versão CLI pode ler do pacote (Wave 3) ou do transport do adapter.
- [ ] **Decisão sobre `test/drift` do plugin** `[tier:heavy]`: o mecanismo de drift-check local pinava o legacy — decidir explicitamente se ele morre (drift vira responsabilidade exclusiva do pacote, que já tem `drift:check` próprio) ou se é reapontado. Registrar no MEMORY.md.

**Tasks**:

1. `[tier:medium]` Migrar consumidores remanescentes legítimos para fontes do adapter/pacote.
2. `[tier:medium]` Deletar `lib/request-headers.mjs` + `lib/request-headers.test.mjs`; executar a decisão de drift do pre-flight (deletar ou reapontar `test/drift/fixtures/**/request-headers.mjs.fixture`).
3. `[tier:medium]` Deletar as funções de mimicry mortas de `lib/mimicry/system-prompt.mjs` e seus testes; `buildSystemPromptBlocks` fica contendo SOMENTE host policy (sanitização, anti-verbosidade, dedupe, cache-control por escopo do host).
4. `[tier:medium]` ∥ Varredura de comentários/docs que citavam o contrato "bump both together" — remover a instrução de manutenção dual.

**Novos testes**: teste de regressão que falha se alguém reintroduzir um
mapa local CLI→SDK (grep-test no estilo dos governance tests do repo:
proibir `CLI_TO_SDK_VERSION` fora de `node_modules`); asserção de que o
system prompt final no caminho adapter contém o prefixo canônico EXATAMENTE
uma vez (proveniente do pacote — pega tanto duplicação quanto perda).

**Critérios de aceitação**: `git grep request-headers` (fora de CHANGELOG e
docs históricos) = zero; nenhuma função de composição de prefixo CC/billing
viva em `system-prompt.mjs`; suite verde; harness de paridade (0.1.4) verde;
nenhuma header de request muda (golden conformance).

**DoD**: arquivos/funções deletados; teste-guarda novo verde; docs sync; commit.

**Senior QA review** `[tier:heavy]`: confirmar que nada de diagnose/CLI perdeu
informação de versão; revisar se algum teste ficou pinando comportamento morto;
conferir a classificação função a função de `system-prompt.mjs`. Corrigir.

---

## WAVE 3 — Plugin: consumir a nova superfície (depende de W1 publicada + W2)

### Phase 3.0 — Gate de dependência

**Pre-flight** `[tier:fast]`:

- [ ] Release da Wave 1 disponível no registry; `npm update @tormentalabs/claude-code-wire-compat` no plugin; lockfile resolve a versão nova com integridade de registry (política `package-dependency-policy.test.mjs:139-169`).
- [ ] Suite do plugin verde com a versão nova ANTES de qualquer edit (detecta breaking acidental do pacote).
- [ ] **Harness de paridade (0.1.4) verde contra a release nova** — é o teste
      de que o bump do pacote, sozinho, não mudou um byte do wire do plugin.

### Phase 3.1 — Substituir `lib/mimicry/models.mjs`

**Pre-flight** `[tier:fast]`: lista de call sites de cada predicado (baseline
0.1 + re-grep, o código mudou nas waves anteriores).

**Tasks**:

1. `[tier:medium]` Atualizar `lib/mimicry/wire-compat.mjs:7` para importar também a API de modelo — **junto, no mesmo commit**, atualizar a regex de `test/conformance/package-dependency-policy.test.mjs:246-258` para o novo conjunto de símbolos (o teste é o contrato do seam; manter o formato de import estático em linha única, ou evoluir o teste para validar uma lista de símbolos permitidos).
2. `[tier:medium]` Trocar call sites de `models.mjs` pelos equivalentes do pacote; deletar o rewrite dotted→dashed do seam (`wire-compat.mjs:62` região) — o pacote agora normaliza.
3. `[tier:medium]` Deletar `lib/mimicry/models.mjs` + teste; adicionar guarda estilo governance proibindo regex local de família de modelo fora de `node_modules` (exceção: response-side se houver).

**Novos testes**: paridade byte-a-byte da decisão para a matriz de modelos do
baseline (dotted, dashed, datado, -eap, desconhecido) — tabela `it.each`
comparando decisão antiga (fixture registrada na 0.1) vs nova.

**Critérios de aceitação**: adaptive thinking, 1M context e gating de features
inalterados para toda a matriz; zero regex de modelo no plugin (request-side).

**DoD**: suite verde; dependency-policy test atualizado e verde; commit por task.

**Senior QA review** `[tier:heavy]`: revisar diferenças de semântica sutis
(ex.: predicado do plugin aceitava prefixos que o pacote rejeita); conferir a
regex do dependency-policy contra import real. Corrigir.

### Phase 3.2 — Substituir constantes/predicados de beta de `lib/mimicry/headers.mjs`

**Pre-flight** `[tier:fast]`: para cada constante/predicado de
`headers.mjs`, classificar: (a) já coberto pelo builder do pacote no caminho
adapter ⇒ deletar; (b) consumido fora do request (status/UI/config parsing) ⇒
migrar para export do pacote (feito na 1.2) ou manter se for política do host;
(c) política do host (`HOST_SDK_BETASBLOCKLIST`, parsing de headers custom do
usuário) ⇒ fica.

**Tasks**:

1. `[tier:medium]` Executar a classificação: deletar (a), redirecionar (b), documentar (c) com comentário de fronteira.
2. `[tier:medium]` ∥ Atualizar testes de `headers.mjs` para a superfície restante.

**Novos testes**: asserção de que o header `anthropic-beta` final no caminho
adapter vem exclusivamente do pacote + betas extras do usuário (aditivos), com
edge cases: beta duplicado usuário-vs-pacote, beta suprimido, limite
`MAX_ADDITIONAL_BETAS`.

**Critérios de aceitação**: nenhuma constante de beta do CC hardcoded no plugin
(fora de política de host explicitamente comentada); golden verde.

**DoD**: suite verde; docs sync; commit.

**Senior QA review** `[tier:heavy]`: verificar que betas de features do host
(fast-mode etc.) continuam acionáveis; revisar fronteira (c) item a item.
Corrigir.

### Phase 3.3 — Eliminar constantes de protocolo do seam (`adapter-input.mjs`)

**Pre-flight** `[tier:fast]`:

- [ ] Confirmar quais constantes de `lib/mimicry/adapter-input.mjs` são
      deriváveis do profile exportado pelo pacote: `PROFILE_CLI_VERSION` e
      `PROFILE_USER_AGENT` ⇐ `CLAUDE_CODE_2_1_233_PROFILE.cliVersion`/template de
      UA do profile; `PROMPT_CACHING_SCOPE_BETA` ⇐ export de beta da Phase 1.2 (se
      a auditoria 1.2.2 a incluiu; senão, tratar como lacuna e voltar um patch do
      pacote — caso legítimo de iteração, não de interrupção).
- [ ] `SESSION_ID_FALLBACK`: classificar — se o CC genuíno tem placeholder
      equivalente, pertence ao pacote; se é invenção do plugin, fica documentado
      como host policy.

**Tasks**:

1. `[tier:medium]` Substituir as constantes locais por leitura do profile/
   exports do pacote; atualizar o import do seam + regex de
   `package-dependency-policy.test.mjs` (mesmo ritual da 3.1.1).
2. `[tier:medium]` ∥ Guarda de governance: proibir literais `claude-cli/` e
   `2\.1\.\d+` em `lib/**` e `index.mjs` fora do seam (allowlist explícita),
   excluindo CHANGELOG/docs.

**Novos testes**: com profile 2.1.233 injetado, o transport resultante carrega
cliVersion/UA vindos DO PACOTE (asserção de igualdade referencial com o
profile export, não com literal); bump simulado de profile (profile fake com
cliVersion diferente) propaga sem edit no plugin.

**Critérios de aceitação**: zero literais de versão CC/UA no plugin (guarda
verde); harness de paridade byte-idêntico (a fonte mudou, os bytes não).

**DoD**: suite verde; guarda nova verde; commit.

**Senior QA review** `[tier:heavy]`: procurar literais de protocolo
remanescentes por grep amplo (`anthropic-beta` strings, UUIDs fixos, datas de
beta flags); validar que o fallback de session id não vazou para o wire de
forma diferente da baseline. Corrigir.

---

## WAVE 4 — Consolidação, docs e QA global

### Phase 4.1 — Consolidar testes de conformance e docs

**Pre-flight** `[tier:fast]`: listar testes de conformance que existiam para
diffar legacy vs adapter — com o legacy morto, alguns pinam código inexistente.

**Tasks**:

1. `[tier:medium]` Reclassificar conformance: manter os que validam
   plugin+pacote contra o CONTRATO (docs/golden), deletar os que comparavam
   legacy vs adapter, converter os aproveitáveis em testes do caminho único.
2. `[tier:medium]` ∥ Docs: `docs/mimese-http-header-system-prompt.md`,
   `CONTRIBUTING.md`, `README.md`, `AGENTS.md` (seções de arquitetura: o
   caminho único via pacote), `docs/mimicry/wire-compat-divergences.md`
   (divergências restantes devem tender a zero — o que sobrar é política do
   host, não divergência).
3. `[tier:medium]` CHANGELOG do plugin: entrada consolidada da migração;
   `MEMORY.md`: decisões tomadas nas waves.
4. `[tier:medium]` Version bump do plugin (minor ou major conforme o QA da 2.2
   tiver classificado emulação-off como breaking).

**Novos testes**: teste-guarda global: os únicos imports de
`@tormentalabs/claude-code-wire-compat` no plugin são os do seam
(`wire-compat.mjs`) e testes; nenhuma constante de protocolo CC
(versão CLI, beta flag, UA template, UUID placeholder de sessão) hardcoded
fora de `node_modules` — grep-test de governance consolidando as guardas das
Phases 2.3, 3.1 e 3.3.

**Promoção do harness a permanente**: `migration-parity.test.mjs` (0.1.4) é
renomeado/reposicionado como teste de conformance permanente do plugin. Depois
que o legacy morre, os testes plugin-vs-pacote são tautológicos (comparam o
pacote com ele mesmo); a ÚNICA proteção contra uma release quebrada do pacote
é este pin de bytes absolutos no lado do plugin, re-validado a cada
`npm update` (gate 3.0 institucionalizado como pre-flight de qualquer bump
futuro — registrar no CONTRIBUTING).

**Critérios de aceitação**: `npm test` verde; documentação sem referência ao
caminho legacy como existente; divergences doc reflete o estado final.

**DoD**: commits atômicos; working tree limpa.

**Senior QA review** `[tier:heavy]`: leitura crítica das docs novas
(um dev novo entenderia o caminho único?); amostragem de 5 fluxos de request
ponta a ponta nos testes. Corrigir.

### Phase 4.2 — QA GLOBAL e aceitação final

**Pre-flight** `[tier:fast]`: ambos os repos com working tree limpa e suites
verdes; lockfile do plugin na release final do pacote.

**Tasks**:

1. `[tier:heavy]` **Senior QA review GLOBAL** cobrindo:
   - Fronteira §1 respeitada em 100% dos arquivos de `lib/mimicry/` restantes
     (ler cada um e classificar);
   - matriz de paridade wire: para N requests representativos (simple, tools,
     streaming, count_tokens, 1M context, fast-mode, betas custom), o output é
     byte-idêntico ao baseline da Wave 0 OU a diferença está documentada como
     correção de bug do legacy;
   - rotação/retry/OAuth intactos (rodar os testes de fase 1-4 do plugin);
   - segurança: nenhum segredo em fixture nova; redact intacto.
2. `[tier:medium]` Corrigir TODOS os findings (blockers/majors obrigatórios;
   minors corrigidos ou registrados como issues com aceite explícito).
3. `[tier:medium]` Re-run completo: plugin `npm test` + lint + format:check;
   pacote `npm test` + typecheck + lint + pack:check + drift:check.

**Critérios de aceitação GLOBAIS** (o plano só está completo com todos):

1. Único ponto de conhecimento de protocolo CC no plugin é o pacote; provado
   por teste-guarda de governance (Phase 4.1).
2. `lib/request-headers.mjs`, `lib/mimicry/models.mjs` e as constantes de beta
   duplicadas não existem mais; zero contrato "bump both together".
3. `built.url` consumido; `transformRequestUrl` só existe para passthrough.
4. `transformRequestBody` permanece, contendo SOMENTE conversões do OpenCode
   (auditado item a item no QA global).
5. Toda a matriz de paridade wire byte-idêntica ao baseline (ou divergência
   documentada como bugfix).
6. Suites 100% verdes nos dois repos; CI verde nos dois.
7. Pacote publicado com a superfície nova; lockfile do plugin apontando para
   ela com integridade de registry.
8. Docs sincronizadas (mimese doc, CONTRIBUTING, README, AGENTS, divergences,
   CHANGELOGs, MEMORY).
9. Zero manutenção dual residual: nenhuma constante de protocolo CC
   (versão CLI, UA, beta flag, âncora de prompt, UUID placeholder) em
   `lib/**`/`index.mjs` fora do seam — provado pelas guardas de governance
   (2.3, 3.1, 3.3, 4.1) rodando na CI; e o harness de paridade permanente
   protege contra regressão vinda do próprio pacote.

**DoD GLOBAL**: critérios 1-9 verificados com evidência (comando + output
registrados no relatório final em `docs/plans/wire-compat-migration-report.md`);
QA global sem findings abertos de severidade ≥ major; tags de release criadas.

---

## Riscos e rollback

| Risco                                                   | Mitigação                                               | Rollback                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pacote novo quebra byte-parity                          | Golden fixtures no pacote + matriz de paridade na 3.x   | `npm install` da versão anterior (lockfile pin); reverter commits do seam                              |
| Emulação-off era usada como "meia-mimicry" por usuários | Decisão explícita na 2.2 + CHANGELOG breaking           | Flag de config restaurando latch é PROIBIDO (reintroduz dual path); reverter a wave inteira se crítico |
| Publish npm bloqueado (OTP)                             | Interrupção humana prevista (3.1b); Wave 2 prossegue    | n/a                                                                                                    |
| Drift fixtures do plugin pinavam o legacy               | Auditoria na 2.3 antes de deletar                       | Restaurar do baseline tag                                                                              |
| Divergência sutil de classificação de modelo            | Tabela de paridade `it.each` na 3.1 com matriz completa | Reverter Phase 3.1 (models.mjs volta do baseline tag)                                                  |

## Apêndice A — Matriz de posse de arquivos (paralelismo)

Regra: um arquivo aparece em NO MÁXIMO uma task em execução. `index.mjs` é o
gargalo do plugin — tasks que o editam são SEMPRE sequenciais entre si (2.1.1 →
2.2.1-3). Editar `index.mjs` em janelas disjuntas por task, nunca em paralelo.

| Task    | Escreve                                                                    | Pode paralelizar com                                                  |
| ------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1.1.1   | `src/model-identity.ts` (pacote)                                           | 2.1.x, 2.2.x (repo diferente)                                         |
| 1.1.2   | `src/model-queries.ts`, `src/contracts.ts` (pacote)                        | 1.1.1 NÃO (contracts pode ser tocado por ambos — sequenciar), 2.x sim |
| 1.1.3   | `src/index.ts`, testes de governance (pacote)                              | após 1.1.1-2                                                          |
| 2.1.1   | `index.mjs` (plugin)                                                       | 1.x (repo diferente)                                                  |
| 2.1.2   | `index.test.mjs`, conformance de URL                                       | 2.1.1 NÃO (depende)                                                   |
| 2.2.1-3 | `index.mjs`                                                                | sequencial entre si e após 2.1.1                                      |
| 2.3.2   | `lib/request-headers.mjs` (delete), drift fixtures                         | após 2.2                                                              |
| 2.3.3   | `lib/mimicry/system-prompt.mjs` + teste                                    | ∥ 2.3.2 (arquivos disjuntos), após 2.2                                |
| 3.1.1   | `lib/mimicry/wire-compat.mjs`, `package-dependency-policy.test.mjs`        | 3.2/3.3 NÃO (mesmos arquivos no seam)                                 |
| 3.2.1   | `lib/mimicry/headers.mjs`                                                  | após 3.1                                                              |
| 3.3.1   | `lib/mimicry/adapter-input.mjs`, `wire-compat.mjs`, dependency-policy test | após 3.1 (mesmos arquivos do seam — sequencial)                       |
| 4.1.1-4 | testes conformance, docs, CHANGELOG                                        | docs ∥ testes (arquivos disjuntos)                                    |

## Histórico de revisão

**2026-08-16 — Senior review (regressão + dono único do mimicry).** Findings
aplicados: (B1, blocker) criado o harness de paridade byte-exata na Wave 0
(task 0.1.4), obrigatório após cada phase e promovido a permanente na 4.1;
(B2, major) gate 3.0 roda o harness contra release nova — pós-legacy os testes
plugin-vs-pacote são tautológicos e o pin de bytes no plugin é a única defesa
contra release quebrada do pacote; (A1, major) nova Phase 3.3 elimina as
constantes de protocolo de `adapter-input.mjs` (`PROFILE_CLI_VERSION`,
`PROFILE_USER_AGENT`, `PROMPT_CACHING_SCOPE_BETA`, `SESSION_ID_FALLBACK`)
lendo do profile exportado; (A2, major) Phase 2.3 expandida para deletar o
mimicry morto de `system-prompt.mjs` (prefixo CC, billing, âncoras);
(A3, medium) cache breakpoints reclassificado: computação canônica avaliada
para o pacote na 1.2.4, só tuning do host fica; (B3, medium) smoke de
integração retry×adapter×SSE na 2.2; (A4/B4/B5, minor) critério de constante
vs decisão nos betas, guardas de literais (`claude-cli/`, `2.1.x`, UUID) e
decisão explícita sobre `test/drift` no pre-flight da 2.3; critério global 9
adicionado.

## Apêndice B — Comandos de verificação padrão

Plugin (`D:\git\opencode-anthropic-fix`):

```
npm test            # suite completa (~13s+, inclui worker/sync-watcher)
npx vitest run <nome>
npm run lint ; npm run format:check
```

Pacote (`D:\git\claude-code-wire-compat`):

```
npm test ; npm run typecheck ; npm run lint
npm run pack:check ; npm run drift:check ; npm run fixtures:check
```

Greps de aceitação (sempre com path absoluto; exemplos):

```
rg "CLI_TO_SDK_VERSION|FALLBACK_CLAUDE_CLI_VERSION" D:\git\opencode-anthropic-fix --glob '!node_modules' --glob '!CHANGELOG.md'
rg "from \"@tormentalabs/claude-code-wire-compat\"" D:\git\opencode-anthropic-fix --glob '!node_modules'
```
