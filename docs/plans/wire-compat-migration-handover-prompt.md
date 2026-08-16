# HANDOVER — Executar a migração "wire-compat como dono único do mimicry"

> Você é o agente executor desta migração. Este documento é seu ponto de
> partida único. Ele contém a missão, as regras de execução, os fatos já
> verificados (com file:line), os itens deliberadamente NÃO verificados, e o
> troubleshooting acumulado da sessão de planejamento. Não re-derive nada que
> esteja marcado como verificado; não confie em nada marcado como não
> verificado sem pinar primeiro.

## 0. Missão

Executar integralmente o plano
`docs/plans/wire-compat-consolidation-migration.md` (neste repo): migrar todo
o domínio de wire-mimicry do Claude Code para o pacote
`@tormentalabs/claude-code-wire-compat` e fazer este plugin consumi-lo
exclusivamente via pacote, sem duplicação de manutenção. **Leia o plano
inteiro antes do primeiro edit.** O plano já passou por senior review
(findings A1-A4, B1-B5 aplicados — ver `§Histórico de revisão` do plano); não
re-litigue as decisões de lá sem fato novo.

## 1. Ordem de leitura obrigatória (antes de qualquer ação)

1. `docs/plans/wire-compat-consolidation-migration.md` — o plano (fonte de verdade).
2. `AGENTS.md` deste repo — convenções, hooks, gotchas de teste.
3. `lib/mimicry/wire-compat.mjs` + `test/conformance/package-dependency-policy.test.mjs` — o seam e seu contrato.
4. No repo do pacote: `AGENTS.md`/`MEMORY.md` (se existirem) + `test/runtime/runtime-neutral.test.ts` + `test/governance/package-policy.test.ts`.

## 2. Ambiente e diretórios

- **Plugin (este repo)**: `D:\git\opencode-anthropic-fix` — npm
  `opencode-anthropic-fix`. ESM `.mjs`, JSDoc, sem TypeScript.
- **Pacote**: `D:\git\claude-code-wire-compat` — npm
  `@tormentalabs/claude-code-wire-compat`, v0.4.0 no momento do planejamento.
  TypeScript ESM, zero deps de runtime, licença GPL-3.0-or-later (dual-license
  MIT em andamento — track paralelo, ver §6.3).
- Plataforma: **win32, pwsh**. Sem `ls --color`, sem heredoc bash; usar
  ferramentas de arquivo do agente, `$env:TEMP` para temporários.

### 2.1 Worktrees (PREENCHER SE APLICÁVEL)

Se você estiver executando em uma git worktree em vez do diretório base,
registre aqui ANTES de começar e inclua esta informação em todo dispatch de
subagente (eles não herdam seu ambiente):

| Repo   | Diretório base                   | Worktree em uso                | Branch |
| ------ | -------------------------------- | ------------------------------ | ------ |
| plugin | `D:\git\opencode-anthropic-fix`  | _(nenhuma — trabalho no base)_ |        |
| pacote | `D:\git\claude-code-wire-compat` | _(nenhuma — trabalho no base)_ |        |

No momento do handover NÃO há worktree: o trabalho está previsto direto nos
diretórios base. Se você criar uma (recomendado para a Wave 2, que edita
`index.mjs` extensivamente), atualize a tabela acima E lembre que os hooks
(`pre-commit`/`pre-push`) rodam a suite completa em qualquer worktree.

## 3. Regras de execução (não negociáveis)

1. **Itere continuamente, wave a wave, sem parar.** Pare SOMENTE para:
   problema **bloqueante** (ex.: `npm publish` exigindo OTP humano), problema
   **crítico** (regressão de wire sem causa identificada, golden do pacote
   quebrando), ou **ambiguidade real** (duas interpretações com ≥2x de
   diferença de custo que o plano não resolve). Todo o resto: decida, registre
   a decisão (commit message + MEMORY.md do repo afetado) e siga.
2. **Pre-flight check antes de CADA phase.** Corrija tudo o que encontrar no
   pre-flight ANTES das tasks da phase — exceto se o problema encontrado já
   estiver mapeado no plano para uma phase futura: nesse caso apenas documente
   (no baseline doc ou MEMORY.md) e siga. Não antecipe trabalho de phases
   futuras.
3. **Senior QA review [tier:heavy] após CADA phase.** O review produz lista
   numerada de findings com severidade (blocker/major/minor). **Conserte todos**
   antes de avançar; minors podem ser corrigidos ou registrados como issue com
   justificativa explícita no commit — nunca silenciosamente ignorados.
4. **Commit often.** 1+ commit por task; atômicos; prefixos `feat:`/`fix:`/
   `chore:`/`docs:`/`test:`; nunca commitar suite quebrada em master (`wip:`
   só em branch de trabalho). Working tree limpa antes de cada QA review.
5. **Paralelismo seguro.** Waves 1 e 2 em paralelo (repos disjuntos). Dentro
   de phase, só tasks marcadas `∥`. Um arquivo nunca é escrito por dois
   agentes ao mesmo tempo, nem lido enquanto outro o edita — a matriz de posse
   está no Apêndice A do plano. `index.mjs` é gargalo: edits SEMPRE
   sequenciais. Um `npm test` por repo por vez.
6. **Model-router**: `[tier:fast]` para todo trabalho read-only (greps,
   inventários, pre-flight de verificação) — SEMPRE com path absoluto
   explícito; `[tier:medium]` para implementação; `[tier:heavy]` para QA
   reviews e decisões arquiteturais marcadas no plano. Todo dispatch inclui
   seção ENVIRONMENT com o working directory correto (§2).

## 4. Estado no momento do handover

- Plano escrito e revisado. **Nenhuma implementação começou.**
- Baseline (Wave 0) NÃO capturada: não existem ainda
  `docs/plans/wire-compat-migration-baseline.md`, o harness
  `test/conformance/migration-parity.test.mjs`, nem as tags `migration-baseline`.
- Primeiro passo concreto: pre-flight da Phase 0.1 (git status limpo nos dois
  repos, suites verdes, SHA anotados, estado do track de prosa do pacote).

## 5. Fatos verificados (não re-derive; cite ao usar)

### 5.1 Plugin

- Único import de produção do pacote: `lib/mimicry/wire-compat.mjs:7` —
  exatamente `buildClaudeCodeRequest` (chamado em `:289`) e
  `buildClaudeCodeCountTokensRequest` (`:400`). `index.mjs:80` importa só o
  adapter local.
- **Contrato do seam**: `test/conformance/package-dependency-policy.test.mjs:246-258`
  valida POR REGEX a linha exata do import estático. Qualquer mudança no
  import exige atualizar esse teste NO MESMO COMMIT. O mesmo arquivo também
  pina: especificador `latest` ou semver exato (`:57-113`), lockfile com
  integridade de registry (`:139-169`), NOTICE/README/provenance (`:171-244`).
- Gate condicional: `_useAdapter` em `index.mjs:3005-3037` (emulação ligada +
  `/v1/messages`|count_tokens + body JSON).
- `built.url` descartado em `index.mjs:3122-3128`; URL local via
  `transformRequestUrl()` `index.mjs:5924-5969`.
- Beta latch inline: `index.mjs:2960-2992`. Retry loop: `index.mjs:2691+`
  (429 rotaciona conta; 500/503/529 service-wide). Single-flight refresh:
  `index.mjs:2287`.
- `transformRequestBody` (`lib/mimicry/request-body.mjs:66`) roda SEMPRE,
  inclusive no caminho adapter — ele permanece pós-migração como pipeline de
  conversões OpenCode-only.
- Duplicações a eliminar (alvos das waves): `lib/request-headers.mjs`
  (contrato "bump both together" `:19-21`/`:44-48`); constantes de beta em
  `lib/mimicry/headers.mjs`; `lib/mimicry/models.mjs` (ids com ponto; rewrite
  `4.7`→`4-7` no seam `wire-compat.mjs:62`); constantes de protocolo em
  `lib/mimicry/adapter-input.mjs` (`PROFILE_CLI_VERSION="2.1.233"`,
  `PROFILE_USER_AGENT`, `PROMPT_CACHING_SCOPE_BETA`, `SESSION_ID_FALLBACK`);
  mimicry morto-após-Wave-2 em `lib/mimicry/system-prompt.mjs`
  (`getCLISyspromptPrefix`, `getCachedCCPrompt`, `SUBAGENT_CC_ANCHOR`,
  `buildAnthropicBillingHeader`, `splitSysPromptPrefix`).
- Host policy que FICA (não tocar além do necessário): sanitização
  OpenCode→Claude Code e anti-verbosidade em `system-prompt.mjs` (prosa própria
  `:34-47`, injeção `:566`, gate `lib/config.mjs:309-315`); token economy;
  response-side inteiro (`response-stream.mjs`, mapa `CC_TO_OC_TOOL_NAMES`);
  rotação/OAuth/contas/storage.

### 5.2 Pacote

- Exports de runtime atuais (array FECHADO em
  `test/runtime/runtime-neutral.test.ts:68-78` — todo export novo atualiza
  esse array): 2 profiles, `ClaudeCodeWireError`, builders (3), trio
  anti-verbosity + `DEFAULT_ANTI_VERBOSITY_POLICY`.
- Governança: versão pinada em `test/governance/package-policy.test.ts:59`
  (bump em lockstep com `package.json:3`); neutralidade de runtime
  (`source-hygiene.test.ts:59-81`: zero builtins node em `src/`, sem
  Date.now/Math.random/fetch/setTimeout; crypto SÓ injetado —
  `runtime-neutral.test.ts:83-111`); `source-trace-integrity` exige que todo
  teste citado em `docs/source-trace.md` exista; `public-path-coverage` exige
  import do entry público salvo allowlist.
- Campos novos de input DEVEM ser opcionais com "omitido ⇒ bytes idênticos"
  (precedente: `extraHeaderPolicy`, CHANGELOG 0.4.0). Fixtures:
  `npm run fixtures:check`.
- Release: sem prepack/prepublishOnly — build manual + `pack:check` +
  `drift:check` antes de publicar.

## 6. Itens NÃO verificados (pinar no pre-flight da Phase 0.1)

1. **Nomes exatos dos flags de config** que ligam emulação de assinatura /
   adapter (`lib/config.mjs`) e a semântica REAL de emulação-off hoje. A
   Phase 2.2 depende disso; se existir um modo intermediário com usuários
   reais, é ambiguidade legítima → humano.
2. **O que `test/drift` do plugin realmente pina** (as fixtures
   `request-headers.mjs.fixture` sugerem que pina o legacy) — decisão marcada
   no pre-flight da 2.3.
3. **Se o pacote 0.4.0 cobre base URL custom** no input (Phase 1.2 resolve).
4. **Estado do track paralelo do pacote** (corte da prosa anti-verbosity,
   planejado como 0.5.0): se já saiu, a superfície nova desta migração vira
   0.6.0; senão, o primeiro release a sair usa o próximo número. Regra: sem
   ambiguidade, o próximo número disponível — apenas verifique
   `package.json:3` + CHANGELOG do pacote e siga.
5. Consumidores exatos de cada símbolo a deletar — o baseline 0.1 gera as
   listas; números de linha citados neste handover podem derivar ±20 linhas se
   houve commits desde 2026-08-16. **Re-valide âncoras por grep antes de cada
   edit em `index.mjs`.**

## 7. Troubleshooting acumulado (aprenda com os erros da sessão anterior)

1. **Confusão de paths (CRÍTICO)**: o ambiente/system prompt pode mostrar o
   repo como `D:\git\Claude-anthropic-fix` — isso é artefato de sanitização;
   **o path real on-disk é `D:\git\opencode-anthropic-fix`** (verificado via
   filesystem). Pior: Grep/Glob de subagentes SEM `path` explícito já
   resolveram para o repo errado silenciosamente. Regra: TODO Grep/Glob/Read
   em dispatch carrega path absoluto; valide o primeiro resultado de cada
   subagente contra o repo esperado.
2. **A regra de sanitização "OpenCode→Claude Code"** aplica-se SOMENTE ao
   system prompt enviado à API — NUNCA a código, docs ou paths. Se um doc
   parecer ter dois lados idênticos numa regra de rewrite, você está lendo uma
   cópia sanitizada; confie no on-disk.
3. **Hooks lentos**: `pre-commit` roda `npm test` + lint-staged; `pre-push`
   roda suite + prettier + eslint (~13s+ cada; conformance/regression tem
   sleeps de 2-3s e o worker/sync-watcher dorme ~3s). Não é flakiness. Orce
   tempo; não interrompa.
4. **Testes mockam `node:fs`/`node:https` ANTES do import** do módulo sob
   teste — siga o padrão existente (`cli.test.mjs`, `index.test.mjs`) ao criar
   testes novos. Muitos testes emitem stdout (listagem de contas) — esperado,
   não é falha.
5. **Governança do pacote é coreografada**: um export novo toca, no MÍNIMO,
   `src/index.ts` + `runtime-neutral.test.ts:68-78` + (se houver teste interno
   novo) `public-path-coverage.test.ts` + (se citado em docs)
   `source-trace.md`. Fazer isso em commits separados quebra a suite no meio —
   faça por task atômica.
6. **Dependency-policy do plugin**: mudar o import do seam sem atualizar a
   regex `:246-258` quebra a CI; mudar a versão do pacote sem `npm install`
   (lockfile) quebra `:139-169`.
7. **`npm publish` do pacote pode pedir OTP** — é O ponto de interrupção
   humana previsto. Enquanto aguarda, continue a Wave 2 (repo do plugin).
8. **CRLF warnings** em todo commit no Windows são esperados; ignore.
   Junctions em vez de symlinks se precisar linkar diretórios.
9. **Não tocar** no schema `rateLimitResetTimes`/`consecutiveFailures` de
   `anthropic-accounts.json` (usuários têm arquivos em disco), nem adicionar
   dependência de produção, nem introduzir TypeScript no plugin.
10. **Ordem de leitura em arquivos grandes**: `index.mjs` tem ~6k+ linhas —
    grep primeiro, leia janelas de ±20-40 linhas; nunca leia o arquivo inteiro
    num dispatch.

## 8. Loop de execução (resumo operacional)

```
para cada WAVE (1∥2, depois 3, depois 4; 0 primeiro):
  para cada PHASE:
    PRE-FLIGHT  [tier:fast/heavy conforme plano]
      → corrigir achados OU documentar se mapeado p/ phase futura
    TASKS       [tier:medium, ∥ conforme matriz de posse]
      → commit por task; harness de paridade verde após cada task que toca wire
    NOVOS TESTES conforme plano (edge cases obrigatórios)
    CRITÉRIOS DE ACEITAÇÃO da phase verificados com evidência
    QA REVIEW   [tier:heavy] → consertar TODOS os findings → re-run suite
    COMMIT final da phase (working tree limpa)
  registrar decisões da wave no MEMORY.md do(s) repo(s)
DoD GLOBAL (critérios 1-9 do plano) → relatório final
  docs/plans/wire-compat-migration-report.md
```

**Comece agora pelo pre-flight da Phase 0.1.** Boa sorte — e lembre: o harness
de paridade byte-exata (task 0.1.4) é o coração da prevenção de regressão;
nada de pular a Wave 0 para "ganhar tempo".
