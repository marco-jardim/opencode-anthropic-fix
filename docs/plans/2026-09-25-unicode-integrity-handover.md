# Handover: implementar integridade Unicode

Prompt redigido em 2026-09-25. Somente o envio/invocacao deste prompt pelo usuario como instrucao inicia a execucao; leitura como referencia nao concede autorizacao. Estado futuro: consultar o registro de execucao previsto no plano, nao assumir que o snapshot de planejamento ainda e atual.

---

Inicie a implementacao de `D:\git\opencode-anthropic-fix\docs\plans\2026-09-25-unicode-integrity-fix-plan.md`. Nao entregue apenas outro plano: execute, teste, delegue QA heavy adversarial, corrija os achados e faca commits locais frequentes. Itere continuamente ate concluir ou encontrar bloqueio real/risco critico.

Ambiente: Windows (win32), PowerShell 7 (pwsh). Repositorio do plugin: `D:\git\opencode-anthropic-fix`. Biblioteca: `D:\git\claude-code-wire-compat`. Use paths absolutos nos dispatches. Comandos com paths relativos exigem CWD explicito. Um caminho `Claude-anthropic-fix` pode vir de sanitizacao de prompt: confirme os caminhos canonicos acima, nao renomeie o repositorio.

Paths canonicos sao defaults sujeitos ao gate zero do plano (1.1). Antes de editar/instalar/construir, verificar read-only se o host vivo carrega esses diretorios por junction ou resolucao da dependencia. Isso e UNVERIFIED. Se houver vinculo, preferir isolamento sem mudar junction/config vivos; WIP vivo exige consentimento especifico informado. Resolver ambos os repositorios e paths reais da dependencia. Registrar primeiro na sessao a decisao de isolamento e paths/HEAD exatos; depois de comprovar destino seguro, provisionar a worktree e persistir nela o adendo que mapeia TODOS os paths/CWDs/owners/logs antes das escritas seguintes. Nao criar o execution log no checkout vivo antes dessa decisao. Sem isolamento confirmado ou consentimento, BLOCKED.

## 1. Autoridade e limites

- Este prompt, quando enviado como instrucao pelo usuario, autoriza implementar o plano e fazer commits LOCAIS frequentes nos repositorios previstos.
- NAO autoriza publicacao npm, push, tags, deploy, probes autenticados/pagos, instalacao global, mudanca de junction/config global ou edicao do host externo. Cada acao exige autorizacao individual: repo/branch de push, tag, workflow/trigger, `package@version`, dist-tag, endpoint/corpus/budget de probe e cada acao no host. Inventarie no boot e solicite em lote quando os alvos forem concretos; alvos desconhecidos ficam PENDENTE enquanto P1 independente prossegue. "Publicar" nao implica push/tag; nao invente versao nem presuma credenciais/permissoes.
- Entre os dois documentos, o plano e a fonte de verdade. Ambos respeitam instrucoes de maior prioridade e o protocolo autoritativo do router. Registre divergencias; leitura de um arquivo nao e autorizacao autonoma.
- A sessao de redacao de 2026-09-25 alterou somente documentacao. Naquele snapshot, as correcoes de runtime ainda NAO estavam implementadas. Confira o estado atual e o registro de execucao; resultados historicos nao sao PASS desta execucao.
- Nao transforme investigacao em refatoracao geral. Plugin continua ESM `.mjs` + JSDoc; biblioteca continua TypeScript, pura e I/O-free. Nao altere schema de contas, perfil de cliente ou dependencias por conveniencia.

## 2. Primeiros passos

Leituras de contexto podem preceder o gate zero, mas nenhuma mutacao de runtime, install, build, formatter, coverage, pack ou commit deve anteceder a decisao segura de isolamento. Todos os passos abaixo respeitam o mapeamento vinculante de paths do plano 1.1.

1. Leia o plano inteiro em blocos de aproximadamente 100 linhas. Tabelas longas podem truncar o retorno; continue pelo offset, sem supor que o trecho omitido inexiste.
2. Leia as instrucoes atuais: `D:\git\opencode-anthropic-fix\AGENTS.md`, `D:\git\opencode-anthropic-fix\CLAUDE.md`, `D:\git\opencode-anthropic-fix\CONTRIBUTING.md`, `D:\git\claude-code-wire-compat\AGENTS.md` e `D:\git\claude-code-wire-compat\MEMORY.md`. Inspecione scripts, configs e arquivos analogos antes de editar.
3. Verifique separadamente status staged/unstaged/untracked, branch, HEAD e log dos dois repositorios. Preserve trabalho externo; nao descarte mudancas para obter uma arvore limpa.
4. Na ultima checagem anterior a criacao deste handover, apenas o plano estava untracked no plugin, e a biblioteca estava limpa. Agora ha tambem este documento: revalide o estado. Nao inclua arquivos em commits por acidente.
5. Registre manifesto, lockfile, pacote realmente instalado, bundle carregado e versoes dos runtimes. Historico: plugin `1.0.0`, specifier da biblioteca `latest`, lock/install da biblioteca `0.5.0`, fonte irma `0.6.0`, registry `latest=0.6.0`. Esses numeros precisam ser confirmados, nao copiados como estado atual.
6. A biblioteca exige Node >=20 apesar de guia antigo mencionar Node 18. Registre Node/npm/Bun/workerd quando aplicavel, ICU e `Intl.Segmenter`. Confirme a matriz Node 20/22/24 da biblioteca nas instrucoes/CI atuais.
7. Obtenha apenas projecao segura (plano 1.3): descubra as chaves em `D:\git\opencode-anthropic-fix\lib\config.mjs`; parser/helper local emite somente booleans allowlisted, entrada relevante/path resolvido do plugin e erros enumerados. Nao abra config bruta, ecoe excecoes/conteudo, URLs com query/credenciais ou arquivos de contas. Se as ferramentas nao permitirem projecao sem exposicao integral, peca projecao ao usuario ou autorizacao para helper estreito. Respeite permissoes de acesso externo; nao habilite flags na instalacao real.
8. Crie o registro `D:\git\opencode-anthropic-fix\docs\plans\qa\unicode-integrity-execution.md`, dono unico orquestrador, verificando o diretorio pai antes. Registre baseline, leases, tarefas, comandos/CWD/exit code, hashes, QA, autorizacoes e bloqueios.
9. Rode pre-flight e baseline de P1 antes de escrever codigo. Use corpus sintetico e probes offline; investigacoes anteriores nao fizeram chamadas reais a Anthropic.
10. Depois da baseline e QA heavy documental, faca primeiro commit `docs:` dedicado incluindo intencionalmente plano/handover sob os paths mapeados, sem mudancas externas nao relacionadas. Registre snapshots sanitizados do execution log nas fronteiras de fase sob freeze.

## 3. Continuidade e recuperacao do router

- Siga continuamente, sem pedir confirmacao entre tarefas/fases. Pare somente por bloqueio real, risco critico ou decisao humana indispensavel; continue trabalho independente seguro se existir.
- Com P2 BLOCKED, trabalho independente no plugin e apenas preparacao read-only, evidencia de protocolo e probes offline isolados; sem runtime/testes/commits de P3 contornando T0. P1 independente segue sob seu pre-flight.
- `SCOPE GROWTH`, `NEED CONTEXT` ou `ESCALATE` estruturado com lacuna concreta e resposta legitima: reuna contexto limitado via fast e redespache com escopo adequado. Heavy pedindo contexto nao esta indisponivel.
- Antes de retry/substituicao/takeover que possa escrever, confirme que o writer anterior terminou (revogar lease nao interrompe processo), inspecione diff parcial, HEAD/hashes e registre transferencia dos leases. Estado desconhecido => BLOCKED nos paths afetados, sem escritor concorrente.
- Roteamento normal: fast coleta contexto/roda comandos; medium implementa/testa/documenta; heavy decide contratos complexos e faz QA adversarial. Siga o router autoritativo da sessao.
- Se um dispatch realmente falhar, registre a falha e tente recuperacao uma vez pelo tier/provedor alternativo previsto pelo router. Exemplos: erro de transporte, recusa falsa, prolixiedade com saida truncada/inutilizavel que nao entrega o solicitado.
- Se a recuperacao tambem falhar, assuma temporariamente APENAS a leitura/implementacao bloqueada. Registre motivo/evidencia, obtenha verificacao independente depois e retorne ao roteamento na tarefa seguinte. Nao repita indefinidamente o mesmo dispatch sem progresso.
- Busca vazia valida, resposta curta adequada ou aviso CAP/budget nao justificam takeover. Respeite o budget, ajuste o escopo e nao confunda falta de contexto com ferramenta quebrada.
- O fallback operacional nunca substitui QA heavy, nunca autoriza autoaprovacao e nunca contorna seguranca/permissoes.
- Apos tres falhas tecnicas consecutivas no mesmo problema, pare as tentativas, preserve evidencia, consulte RCA heavy e recupere somente alteracoes proprias com patch revisado. Nao use reset destrutivo nem apague teste falhando.
- Comunique bloqueios com evidencia, impacto e uma pergunta objetiva. Nao marque uma fase dependente como concluida para seguir adiante.

## 4. QA sempre heavy

- QA e SEMPRE delegado a heavy independente, com papel de senior QA engineer adversarial: tentar refutar o comportamento com contraexemplos, nao apenas ratificar testes verdes.
- Isso vale apos CADA fase, na pre-promocao global e no fechamento pos-release. Corrija TODOS os achados validos e repita testes/review ate PASS. Nao mova achados para backlog para fechar o gate.
- O produtor nunca e o grader, inclusive quando o orquestrador implementa diretamente. Fast prepara fontes/diffs/evidencias congeladas; heavy raciocina sobre elas, nao e usado para executar a suite.
- Resultado de transporte/grader com timeout, verdict nao parseavel, `INVALID_UNICODE` ou resultado rejeitado NAO e QA aprovado. Nao confunda badge do router com evidencia de review concluido.
- Para falha operacional de QA: uma chamada heavy inicial + no maximo uma recuperacao heavy-class pelo provedor alternativo permitido pelo router; persistindo falha, BLOCKED. Nunca rebaixe nem autoaprove. Esse limite nao limita remediacao de achados ou coleta legitima de contexto.
- Reviewer independente nao escreveu nem assumiu a implementacao; pode reavaliar correcoes na mesma sessao de review. Falso positivo exige evidencia registrada e concordancia dele, nunca descarte unilateral pelo produtor.
- Dispatches incluem TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT, owns/reads, tier, budget e acceptance checks disponiveis. ENVIRONMENT sempre traz paths reais, win32 e pwsh.

## 5. Leases e commits frequentes

- Um writer por arquivo; nenhum OUTRO agente le arquivo sob escrita. Congele contexto em snapshots antes do fan-out. Normalize case/junctions para nao conceder dois leases ao mesmo arquivo.
- A biblioteca permite somente UMA writing task por worktree, mesmo para arquivos disjuntos. `D:\git\opencode-anthropic-fix\index.mjs` e lock integral. Novos arquivos, testes, docs e helpers tambem precisam de owner.
- Freeze antes de suite, build, formatter, coverage, install, QA e commit: esses processos tambem leem/escrevem. Nunca execute hooks enquanto outro agente edita a arvore.
- Nao paralelize P2 runtime/testes com P1: P2 espera o candidato aprovado e o gate T0. Dentro de P2, compactacao/resumo podem paralelizar somente depois do helper congelado e com leases disjuntos.
- Faca commit por unidade coerente e verde (correcao + testes), sem acumular a wave inteira nem commitar testes vermelhos.
- Antes de cada commit: `git status`, `git diff`, `git log --oneline -10` no repo correto. Stage apenas paths pretendidos; nunca `git add -A`. Use Conventional Commits com W/P/T e `git commit -s` onde exigido.
- Respeite hooks, nao use amend/force/skip-hooks nem altere identidade Git. Nao inclua capturas, tokens, tarballs, outputs de build ou mudancas alheias.
- Use `apply_patch` para edicoes manuais, conforme instrucao de maior prioridade. Delegado sem essa ferramenta trabalha patch-only sob READ, sem WRITE: devolve proposta e encerra leituras; o orquestrador assume como unico writer para aplicar/verificar. Nao e excecao para escrita concorrente nem bypass geral do router. Formatter pode formatar arquivos autorizados.
- Commit local nao autoriza push, tag ou publicacao.

## 6. Sequencia que nao deve ser invertida

### P1: contrato e biblioteca

Congele a matriz de texto de corpo versus headers/identificadores com evidencia. Corrija validacao compartilhada e diagnostico `safeDetails` ponta a ponta. Prepare candidato `X.Y.Z-rc.N`, metadados/guards, tarball/digest e gates completos; obtenha QA heavy. Nenhuma publicacao nesta fase.

No pre-flight P1, leia `D:\git\claude-code-wire-compat\.github\workflows\publish.yml`: confirme capacidade de comparar o manifesto rebuilt ANTES de publicar e tag explicita nao-latest. Essa capacidade ainda e UNVERIFIED. Se ausente, BLOCKED ou mudanca minima de CI previamente autorizada com release owner/lease e QA heavy antes de publicacao. Nao presumir permissao para alterar CI pela permissao de publish.

### P2: adocao do candidato e plugin

P2.T0 ocorre apos P1 QA PASS e autorizacao especifica de publicacao: publique RC imutavel no registry FORA de `latest`. O publisher pode usar canal `beta`, mas o specifier do plugin e a versao EXATA `X.Y.Z-rc.N`, nunca `beta`.

Atualize provenance `D:\git\opencode-anthropic-fix\docs\shared-package-provenance.md`, confira version/resolved/integrity e rode suite preexistente completa + `npx vitest run wire-baseline` ANTES de editar runtime/testes. O classificador aceita versao exata prerelease; confirme a regra atual, nao a enfraqueca. Nao use `file:`/`link:` ou excecao historica GitHub para contornar registry.

Identidade do RC: P1 registra sha512 local e manifesto descompactado/hash por arquivo. Workflow compara manifesto rebuilt com o candidato aprovado antes de publicar, sem mudanca de fonte/runtime, e confirma tag nao-latest. Depois compare manifesto do registry e registre hashes de container e integrity; container reconstruido pode diferir sem diferenca de arquivos. Nao exija igualdade bruta dos tarballs para aprovar conteudo nem ignore drift de arquivos.

E-BASE e referencia congelada separada, com path/HEAD registrados. E-CAND e a worktree aprovada pelo gate zero: default `D:\git\opencode-anthropic-fix` somente se nao-live ou com consentimento informado; senao, a worktree isolada registrada. Edits, suite completa, novos testes, coverage e hooks usam o candidato real. Isso evita commits com testes novos contra a biblioteca antiga. Sem autorizacao para RC, P2 fica BLOCKED.

Corrija compactacao de descricoes e resumo por grafemas; integre fallback localizado e builder REAL. Nenhum mock substitui o gate composto. Nao adicione compatibilidade retroativa apenas para sustentar dois ambientes de teste.

### P3: stream e diagnosticos

Implemente UTF-8 estrito com flush, framing incremental CR/LF, estado terminal semantico e usage parcial separado de sucesso. Corrija captura por bytes, cortes de diagnostico e seguranca de display. Prove cancelamento/cleanup e ausencia de replay. QA heavy obrigatorio.

### P4: host, artefato e release

Reutilize o RC imutavel aprovado. Correcao da biblioteca exige novo RC e reabertura dos gates afetados. Valide pacote/bundle, tool loop e renderer real em ambiente autorizado.

ANTES da publicacao estavel: prepare o tarball final, compare manifestos descompactados com o candidato, audite allowlist arquivo/campo de metadados e teste comportamentos sensiveis a versao. QA heavy da fase e GLOBAL de pre-promocao revisam candidato, E2E, artefato final e diff permitido. Diferenca de runtime nao aprovada exige novo candidato e reteste completo.

Somente entao publique, se autorizado, o artefato estavel revisado. Compare registry com o ESTAVEL PREPARADO, nao exija igualdade bruta RC-versus-tgz. Rebuild do workflow precisa ser comparado antes da publicacao. Adote no plugin via registry, rode gates completos/clean install/bundle e smoke isolado antes de adocao real autorizada. Feche com QA heavy pos-release.

Falha pos-release: preserve lock/runtime conhecidos-bons do host, pare adocao, solicite autorizacao para rollback de canal se necessario. Corrija em NOVA versao imutavel, nunca sobrescreva versao publicada nem reexecute tool calls parciais.

## 7. Troubleshooting: o que ja foi demonstrado

### Validacao e diagnosticos

- Controles sao escalares Unicode validos, nao UTF-16 malformado. A politica local rejeita C0 exceto TAB/LF/CR, alem de DEL; system tambem rejeita C1. U+0085 passou em mensagem e falhou em system.
- ESC, NUL, FF e DEL foram rejeitados localmente. As fontes de `0.6.0` ainda mantinham a politica; atualizar apenas a dependencia nao resolve os bugs do plugin.
- Aceitacao remota desses controles NAO foi demonstrada. Obtenha evidencia first-party ou solicite autorizacao para probe sintetico; nao apresente teste local como prova da API. Headers/metadata/identificadores continuam estritos.
- O builder falha antes do fetch em `D:\git\opencode-anthropic-fix\lib\mimicry\wire-compat.mjs`. Nao rotacione contas, incremente cooldown nem repita rede para erro local deterministico.
- `ClaudeCodeWireError` aceita detalhes primitivos, mas `sanitizeError` passa por `toSafeErrorDetails` em `D:\git\claude-code-wire-compat\src\redaction.ts`, cuja allowlist descarta campos novos. Atualizar so o throw nao basta.
- Caminhos de erro devem usar estrutura validada + indices/offset/motivo, nunca nomes arbitrarios de chaves de tool input, prompts, tokens ou snippets sensiveis. Teste a cadeia completa ate a mensagem do plugin.
- Body dumps atuais ficam depois do builder: nao capturam a entrada rejeitada. Adicione diagnostico estrutural seguro antes desse ponto, nao dump bruto de historico.

### Cortes locais

- Emulacao e ligada por default; compactacao de descricoes e resumo Haiku sao opt-in, false por default. A configuracao efetiva e o campo original que abortou a sessao do usuario ainda NAO foram identificados.
- `compactToolDescription` em `D:\git\opencode-anthropic-fix\lib\mimicry\system-prompt.mjs` usa `slice(0, 200)`. A chamada real so compacta descricoes >500 unidades quando habilitada.
- Reproducao sintetica: `'- ' + 'a'.repeat(197) + String.fromCodePoint(0x1f600) + 'b'.repeat(350)`. Via transformacao + builder: off passou; on gerou surrogate high isolado no indice 199 e `INVALID_UNICODE`.
- Mesmo com UTF-16 valido, cortar `e\u0301` entre a letra e o acento quebra grafema. Iterar por code points sozinho nao resolve ZWJ, bandeiras, modificadores e variation selectors.
- `formatTemplate` em `D:\git\opencode-anthropic-fix\lib\rolling-summarizer.mjs` corta secoes/envelope com slices brutos. Reproducao: topics com 89 letras `a`, emoji e 9 letras `b`, outras secoes `(none)`, budget um abaixo do template integral; apareceu surrogate isolado no indice 185 da saida.
- O resumo original passou pelo builder, a versao cortada falhou. Cubra budgets menores que envelope, progresso em empates e grafema maior que teto; nao gere envelope quebrado nem loop.
- Fallback restaura apenas o original VALIDO da transformacao opcional, preservando sanitizacao obrigatoria, cache/prefixes e hard caps. Nunca restaure indiscriminadamente a request original inteira.
- Sem NFC/NFD global nem reparo indiscriminado com `toWellFormed`. `JSON.stringify` escapa surrogate isolado; `TextEncoder` sobre a string bruta o substitui por U+FFFD. U+FFFD originalmente legitimo deve ser preservado.
- A amostragem UTF-16 dos indices 4/7/20 em `D:\git\claude-code-wire-compat\src\fingerprint.ts` e intencional e fixada por vetores de conformidade. NAO transforme em indexacao por code point/grafema.

### Streaming e display

- `D:\git\opencode-anthropic-fix\lib\mimicry\response-stream.mjs` ja usa decoder incremental: o corpus valido passou em 160 cortes de dois chunks e byte a byte. Nao atribua toda falha a particionamento UTF-8 normal.
- Falta flush final: bytes finais incompletos `F0 9F` desapareceram no EOF. Decoder fatal + flush deve produzir erro, sem substituicao silenciosa; U+FFFD legitimo continua permitido.
- Normalizar CRLF por chunk perde o delimitador quando CR/LF se separam. Reproducao byte a byte preservou texto mas nao chamou usage. Parse com estado entre chunks, sem normalizar strings JSON.
- UTF-8 e frames completos nao provam conclusao da mensagem. EOF apos start/delta, durante tool input ou antes do terminal precisa falhar. Verifique regras do protocolo, incluindo `message_stop`, erro remoto, cancelamento e terminal duplicado.
- Usage ja recebido deve ser preservado e contabilizado uma vez, separado do resultado. Erro local nao penaliza conta, nao apaga usage e nao causa replay de resposta/tool calls.
- JSON.parse pode produzir surrogate isolado a partir de escape em bytes UTF-8 validos. Valide na fronteira semantica correta; fragmento de tool input ainda nao e documento JSON completo.
- Captura SSE com teto denominado 256 KiB mede `.length` UTF-16, nao bytes. Corrija budget UTF-8 e marca de truncamento; capture desligado nao pode acumular buffer. Grafemas repartidos entre chunks exigem estado e limite para clusters patologicos.
- Cortes diagnosticos no entry/CLI nao sao payload de inferencia. Redact antes de truncar; neutralize ANSI/OSC no display nao confiavel sem alterar texto enviado ao modelo ou remover RTL legitimo.
- TUI/renderer NAO foi validado pelos probes locais. Teste copia, reflow/resize, historico reaberto, deltas separados, fonte e largura. Nao compense bug visual mudando conteudo de inferencia.

## 8. Ferramentas e falhas de sessao anteriores

- Task/delegacao falhou com `INVALID_UNICODE`; causa UNVERIFIED: builder local antes do fetch ou rejeicao do provedor/transporte. Procure stack segura e trace/status/request-id correlacionados ao mesmo request. Ausencia HTTP sozinha nao prova falha local (pode ser timeout); request-id alheio nao prova rejeicao remota. Nenhum caso prova ferramenta ausente ou identifica o campo original. Houve tambem timeout/erro de parsing do grader.
- Requisito rigido: envie exemplos malformados como escapes ASCII e offsets; nunca controles brutos ou surrogate isolado ao LLM. Produza caracteres somente em fixtures/probes locais e serialize a representacao de diagnostico.
- Essa precaucao e para o transporte das ferramentas: NAO e permissao para remover caracteres validos do runtime ou ocultar o bug.
- Ausencia de match em diretorio ignorado requer busca com `--no-ignore`; uma regiao diferente do arquivo nao e releitura redundante. Leia trechos necessarios, nao despeje arquivos grandes.
- Use pwsh, nao sintaxe bash. Paths de temp devem ser Windows. Nao crie symlink onde o projeto exige junction. Nao corrija instalacao global sem autorizacao.
- CodeRabbit nao estava no PATH na checagem anterior. Isso nao impede coleta/local tests e nao substitui nem rebaixa o QA heavy obrigatorio.

## 9. Testes e gates

Historico de investigacao, NAO resultado desta execucao: quatro suites do plugin passaram 41 testes; a suite multiline da biblioteca passou 34. Reexecute com a versao realmente carregada e registre os resultados novos.

Plugin, CWD `D:\git\opencode-anthropic-fix`:

```powershell
npx vitest run lib/mimicry/response-stream.test.mjs lib/mimicry/system-prompt.test.mjs test/rolling-summarizer.test.mjs test/rolling-summarizer-integration.test.mjs
```

Biblioteca, CWD `D:\git\claude-code-wire-compat`:

```powershell
npx vitest run test/validation/multiline-content.test.ts
```

- Gates completos do plugin, no CWD acima: `npm test`, `npm run lint`, `npm run build`, `npm run check:invariants`, `npm run format:check`, `npm run coverage`, `npx vitest run wire-baseline`.
- Gates completos da biblioteca, no respectivo CWD: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`, `npm run test:coverage`, `npm run pack:check`, `npm run test:pack`, `npm run fixtures:check`.
- Confira scripts/config atuais. Nao rode comandos globais concorrentes sobre os mesmos outputs; gates de repos distintos podem paralelizar somente apos freeze.
- Use thresholds executaveis, nao prosa antiga. Nao reduza cobertura, pule testes nem reseale golden/digests para esconder drift. Testes publicos e consumidores empacotados importam tanto quanto unit tests privados.
- Identidade byte a byte vale para caminhos NAO afetados. Mudancas intencionais em cortes defeituosos exigem entrada/antigo/novo/justificativa, escopo de flag/perfil/versao e oraculo independente. Fingerprint/golden upstream permanecem protegidos.
- Corpus inclui acentos NFC/NFD distintos, arabe, Devanagari, CJK suplementar, ZWJ/pele/bandeira/variation selector, controles, chaves, messages/count-tokens, limites e entradas malformadas. Seeds e mutantes precisam provar regressao, nao comparar a funcao contra ela mesma.

## 10. Quando encerrar

So declare conclusao apos cumprir o DoD completo do plano, com QA heavy de todas as fases e global, pacote efetivo verificado e host validado. Reporte commits por repositorio, comandos/resultados, versoes/artefatos e links para evidencias/QA.

Se houver bloqueio, entregue estado exato, tentativas, ultimo commit conhecido-bom, tarefas independentes concluidas, gates pendentes e autorizacao/pergunta minima para retomar. Itens UNVERIFIED continuam UNVERIFIED. Nao prometa corrigir todo Unicode em qualquer renderer: declare o contrato e os ambientes efetivamente provados.
