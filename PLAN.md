# Compatibilidade do plugin com OpenCode v1 e v2

Data do diagnóstico: 30/09/2026, America/Sao_Paulo. Estado: implementação concluída neste worktree, com testes automatizados e smokes dos quatro hosts aprovados no Windows. OAuth/Anthropic reais e TUI interativa ainda exigem validação manual antes de release. O diagnóstico abaixo descreve a base anterior à implementação; a arquitetura final e a matriz de evidências estão em `docs/opencode-v2.md`.

## Parecer e escopo

**O plugin atual não é compatível com o OpenCode v2.0.21.** A incompatibilidade começa no carregamento e também afeta autenticação, transporte e comandos. Trocar apenas o nome da configuração ou envolver a função existente em `setup` não resolve.

Base inspecionada: `opencode-anthropic-fix` 2.1.1, commit `2a7ebc3`, no worktree desta tarefa. O código exporta `AnthropicAuthPlugin({ client })`, uma função que retorna hooks v1 (`index.mjs:255`, `index.mjs:2454`, `index.mjs:6584`). O carregador v2 exige `default` com `id` e uma função `setup` ou `effect`; a mensagem de rejeição definida no código é `Plugin must export a default definition with an id and an effect or setup function.` [S1]

Em 30/09/2026, a consulta direta ao npm retornou `@opencode/cli` e `@opencode/plugin` **2.0.21**, e `opencode-ai` e `@opencode-ai/plugin` **1.18.34**. Essas são versões consultadas, não garantias sobre futuras versões de `latest`. O lock deste plugin contém `@opencode-ai/plugin` e SDK **1.2.27**, além de wire-compat **0.7.1**. A versão da dependência de desenvolvimento, isoladamente, não determina compatibilidade do host.

Objetivo: um pacote que preserve o caminho v1 e acrescente uma implementação v2, compartilhando contas, configuração, OAuth e comportamento wire. A implementação ocorre no worktree desta tarefa. Não altera o checkout ativo em `D:\git\opencode-anthropic-fix`, instalações, credenciais ou configurações do usuário.

### Contrato de versões proposto

| Linha      | Alvo de validação inicial                   | Política                                                                                                 |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| V1 recente | 1.18.29 e 1.18.34                           | Validar entrada de objeto dual; 1.18.29 é o piso documentado para esse formato. [S2]                     |
| V1 legado  | 1.2.27 como caso de regressão do carregador | Preservar `index.mjs` e testar a rota antiga; não declarar todas as versões 1.x certificadas.            |
| V2         | 2.0.21                                      | Primeira versão a certificar integralmente; versões anteriores ou posteriores exigem execução da matriz. |
| Forks v1   | Recursos opcionais existentes               | Preservar comportamento condicionado à capacidade do fork, separado do suporte upstream.                 |

## Evidências e limites da verificação

- Leitura do carregador v2 no tag `v2.0.21`, commit `8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72`, e do carregador v1 no tag `v1.18.34`, commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.
- Sonda Node em memória avaliou somente a declaração da fábrica local, sem executá-la nem carregar suas dependências. Resultado: `type=function`, `id=undefined`, `setup=undefined`, `effect=undefined`; o predicado dos campos obrigatórios do v2 resulta em `false`. Não foi um teste de inicialização do host.
- Sonda do módulo real `lib/mimicry/response-stream.mjs`: o shim fica ativo para `ai-sdk/anthropic/3.0.111`, inativo para `4.0.0` e **ativo** para um User-Agent contendo somente `opencode/2.0.21`. Isso evidencia o risco de aplicar a política antiga ao transporte novo; não comprova como uma sessão v2 responderia.
- A suíte existente usa mocks de hooks/client. A CI varia Node 20/22/24, mas não versões do OpenCode (`.github/workflows/ci.yml`).
- `node_modules` está ausente neste worktree. Não houve instalação, execução de Vitest, build, login, chamada Anthropic ou ensaio de ponta a ponta. O parecer negativo decorre do contrato de entrada incompatível, não de uma falha observada em sessão autenticada.

## Inventário de capacidades

| Capacidade              | Implementação atual                                                                  | Destino e condição no v2                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entrada do plugin       | Named/default são a mesma fábrica; testes exigem somente funções                     | Nova entrada com `id`/`setup`, preservando `index.mjs` para v1.                                                                                              |
| OAuth e persistência    | `auth.methods`, `auth.loader`, `client.auth.set`; `index.mjs:436`, `:2492`, `:4547`  | `ctx.integration.transform`, registro de método OAuth e APIs de conexão/credencial. Credencial v2 inclui `methodID`. [S5]                                    |
| Interceptação HTTP      | `auth.loader` retorna `apiKey: ""` e `fetch`; `index.mjs:2586`                       | Hooks `http.request`/`http.response`; não há callback `next` nem substituição direta de fetch nessa superfície. Prova de viabilidade obrigatória. [S6, S7]   |
| Rotação/retries         | Executor controla conta, refresh, erros HTTP e fallback de body/betas                | Reutilizar decisões existentes; definir um único dono de cada retry entre plugin e host.                                                                     |
| Modelos e custos        | Muta `provider.models[*].cost/limit`; `index.mjs:2498`                               | `ctx.model.transform`; custo v2 é array de faixas. Alterar todas as faixas pertinentes, somente para OAuth gerenciado. [S16]                                 |
| `/anthropic`            | `config.command`, `command.execute.before`, `output.noReply`; `index.mjs:2470`       | `execute` no servidor retorna `void`; exibição interativa requer TUI + RPC. Não presumir retorno de texto no comando. [S8, S15]                              |
| Resposta e notificações | SDK v1 `{ path, body }`, `session.prompt`, `tui.showToast`; `index.mjs:412`, `:2177` | Adaptar APIs de sessão; UI v2 tem ciclo separado. Não presumir que `ctx.client` ou `ctx.tui` existam.                                                        |
| Prompt e mensagens      | `experimental.chat.*`; `index.mjs:2456`, `:4628`                                     | Adaptar os formatos reais no hook `context`; registrar `compaction`, `generate` e `title` quando a transformação for necessária nesses fluxos.               |
| Compactação             | `experimental.session.compacting`; `index.mjs:4640`                                  | Hook `compaction`, preservando limites e sem tratar checkpoints/partes v2 como mensagens v1.                                                                 |
| Resumo Haiku opcional   | `experimental.session.summarize`; `index.mjs:4687`                                   | Recurso dependente de fork, desligado por padrão (`lib/config.mjs:348`). Não é requisito obrigatório de upstream v1/v2; diagnosticar ausência da capacidade. |
| SSE e ferramentas       | Remove `mcp_`, converte nomes PascalCase, extrai usage e aplica shim SDK v1          | Preservar protocolo/usage, mas selecionar política pelo parser real. O provider nativo v2 e o caminho AI SDK são consumidores diferentes.                    |
| Arquivos e CLI          | Config/contas e `cliMain` locais, independentes do SDK                               | Compartilhar módulos; manter caminhos, schema, permissões e execução do CLI em processo.                                                                     |

## Arquitetura recomendada

### Entradas separadas, núcleo compartilhado

Manter `index.mjs` como entrada v1, exportando exclusivamente `AnthropicAuthPlugin` e `default` como hoje. Adicionar `server.mjs` com um único default contendo `id`, `server` para v1 recente e `setup` para v2. A inicialização de cada implementação deve ser preguiçosa: carregar um host não inicializa a outra implementação.

O carregador v2 procura `server` antes da raiz; o v1 recente também consulta `exports["./server"]`. [S3, S4] Propor no manifesto:

```json
{
  "main": "./index.mjs",
  "exports": {
    ".": "./index.mjs",
    "./server": "./server.mjs"
  }
}
```

Adicionar a nova entrada a `files`. Validar resolução do pacote npm, diretório absoluto, `file:` e bundle instalado antes de consolidar esse manifesto. A inclusão de `exports` pode restringir subpaths antigos; inventariar usos documentados e preservar os necessários. O v1.2.27 importa a raiz e deduplica a fábrica named/default por identidade. Já o v1.18.34 pode encontrar o manifesto e redirecionar até um caminho explícito de arquivo para `./server`: apontar `index.mjs` não é um bypass universal. [S4, S20]

Os testes atuais de exportação de `index.mjs` continuam válidos; acrescentar testes separados para `server.mjs`. Evitar exportar helpers de qualquer entrada. O ID proposto é `opencode-anthropic-fix`, constante em reinstalações e reloads.

Extrair apenas as fronteiras necessárias do fechamento atual para módulos `.mjs` em `lib/host/` e um executor de transporte compartilhado: leitura/persistência de credenciais, envio de saída local, notificações e capacidades do host. Não duplicar o interceptador de aproximadamente duas mil linhas de código nem reescrever os módulos wire, rotação ou backoff.

Há estado em escopo de módulo em `index.mjs`: `_pluginConfig:4724`, `adaptiveContextState:4757`, `cacheBreakState:4780`, `microcompactState:4803`, `telemetryEmitter:5795`, `liveTokenRef:5798` e listener `beforeExit:5806`. A extração deve colocar o estado necessário em uma fábrica de runtime por instância, com descarte explícito. Importar a entrada v1 como núcleo da v2 deixaria risco de configuração, métricas e tokens cruzados entre instâncias/reloads.

Usar JSDoc com os contratos v1/v2. `Plugin.define` no v2.0.21 retorna o objeto recebido, portanto uma definição estrutural tipada é uma opção para evitar dependência de runtime apenas por esse helper. Se a solução usar outros exports em execução, declarar `@opencode/plugin` compatível em produção e justificar o custo; não depender acidentalmente de uma devDependency no pacote publicado. [S14]

### Opções consideradas

| Opção                                                           | Vantagem                                             | Custo/decisão                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Entradas acima + adaptadores e núcleo compartilhado             | Preserva contrato legado e permite uma distribuição  | **Recomendada**, condicionada ao ensaio de resolução.                                             |
| Substituir diretamente o default de `index.mjs` por objeto dual | Menos arquivos                                       | Impõe piso v1 recente e quebra os invariantes legados do repo; não escolher.                      |
| Pacote ou linha de releases exclusivos para v2                  | Isola dependências e carregadores                    | Alternativa se resolução ou transporte inviabilizar um pacote único; aumenta manutenção.          |
| Trocar o provider nativo v2 pelo caminho AI SDK                 | Pode oferecer custom fetch próximo do contrato atual | Plano alternativo: exige validar SDK, dependências, recursos nativos e regressões de compactação. |

## Decisões técnicas que precisam de prova

### Transporte, rotação e cancelamento

No v2.0.21, o host converte o pedido para `Request`, dispara `http.request`, envia pelo handler e então dispara `http.response`. A resposta recebe a mesma referência `before.request`. Isso permite estudar um `WeakMap<Request, EstadoDaTentativa>` sem adicionar cabeçalhos internos ao wire. Falha de transporte antes da resposta pula `http.response`. Esses detalhes são evidência do tag analisado, não uma promessa de estabilidade futura. [S7]

Prova inicial proposta:

1. `http.request` seleciona a conta e prepara uma requisição Anthropic através do mesmo construtor wire; o host realiza o primeiro envio.
2. `http.response` recebe esse primeiro resultado, conduz somente as tentativas adicionais necessárias e substitui `event.response` pelo resultado final, transformando o SSE uma única vez.
3. O hook `retry` do host cobre os erros de transporte que não chegam ao hook de resposta. A política precisa evitar multiplicação das tentativas já consumidas pelo plugin e preservar limites/backoff por conta.
4. Estado de tentativa, configuração e conta ficam associados ao pedido correto; não usar um único slot por sessão para chamadas paralelas de título, subagente e geração.

**Gate de arquitetura:** provar abort durante espera, refresh, fetch e consumo SSE. A callback pública Promise não recebe um sinal explícito de cancelamento; não assumir que `request.signal` propaga o cancelamento de toda a operação. O host limita a dez retries, e o evento de retry não contém `kind` nem ID do pedido. [S17] Se essas restrições impedirem preservar o comportamento, testar a alternativa AI SDK com custom fetch; se ambas falharem, registrar a extensão pública necessária no upstream e manter v2 como não suportado. Não publicar suporte parcial como completo.

No caminho nativo, `Provider.nativeSettings` remove `fetch`; adicionar `settings.fetch` não resolve. No caminho AI SDK, `core/aisdk.ts` aceita esse executor. [S18] Em qualquer rota, descartar corpos de respostas rejeitadas, preservar o pedido original por tentativa e impedir dupla sanitização/prefixação de ferramentas.

### Autenticação e estado

- Registrar método próprio na integração `anthropic`, com ID estável, mapeando `authorize`, retorno `mode: "code"` e `refresh`; não retornar o objeto OAuth v1 sem conversão. [S5]
- Preservar `AccountManager` como dono da seleção do pool. O adaptador mantém a credencial da conexão gerenciada coerente com a conta selecionada, sem sobrescrever conexões alheias.
- A superfície do plugin oferece `integration.connection.active/resolve/status`, mas não `ctx.credential`. O endpoint público `credential.update` altera apenas o rótulo. Não planejar um setter arbitrário de tokens inexistente. A ponte via autorização/refresh e o comportamento após switch/remoção devem ser demonstrados na etapa 1; avaliar uma credencial lógica do pool sem duplicar todas as contas no host. [S5, S19]
- Definir o caminho único de refresh para que o callback do host e o executor compartilhem o mecanismo existente de refresh em voo único e lock. Testar renovação simultânea por v1, v2 e CLI.
- Inicialização sem contas deve permitir login. Login, reauth, switch, disable/remove e logout precisam atualizar ativação e inventário do provider, sem capturar token expirado em transforms.
- Não migrar silenciosamente `anthropic-accounts.json` para `ctx.storage`: manter schemas e caminhos. No Windows, o código usa `%APPDATA%\opencode`; em outras plataformas usa XDG. A pasta de instalação do plugin é outra preocupação.
- Preservar escrita atômica, permissões `0600` onde suportadas, limite de 10 contas, debounce e `.gitignore`. Testar concorrência entre processos para detectar sobrescrita de refresh/estado; qualquer correção de persistência necessária deve manter compatibilidade dos arquivos.

### Modelos, ferramentas, streaming e comandos

- Tratar transforms como callbacks síncronas e repetíveis. Carregar dados externos fora delas e usar `reload()` quando configuração ou conta mudar. `/anthropic set` precisa surtir efeito na próxima requisição.
- Aplicar política wire em todos os tipos necessários de chamada, não apenas no chat principal: chat, título, compactação, generate e chamadas auxiliares controladas pelo plugin, inclusive contagem de tokens.
- Manter o ponto único de import de wire-compat, `WIRE_PROFILE`, betas OAuth, identidade/sanitização apenas no system prompt, caminhos literais e Unicode intactos.
- Auditar nomes reais de ferramentas: o v2 adota, entre outros, `shell` e `subagent`, enquanto o mapa reverso atual contém `Bash → bash` e `Task → task`. Criar tradução reversível a partir das ferramentas anunciadas no pedido; testar colisões, MCP e histórico. Não aplicar uma tabela v1 incondicional ao v2. [S11]
- Separar a política SSE do protocolo Anthropic: o shim de `@ai-sdk/anthropic@3.0.111` não é automaticamente adequado ao provider nativo `@opencode/ai/providers/anthropic`. Testar eventos desconhecidos, thinking, citations, ferramentas, usage e erros após emissão parcial; nunca repetir uma geração já parcialmente entregue como se nada tivesse ocorrido.
- Compartilhar parsing e `cliMain(argv, { io })` em um executor servidor. Para `/anthropic` interativo, prever `tui.mjs` e `exports["./tui"]`, registrar `keymap.layer` com `slash: { name: "anthropic", arguments: true }`, chamar o executor por RPC e exibir resultado em `ui.dialog.alert`/`ui.toast.show`. Validar a assinatura da entrada TUI e seu comportamento em v1 recente; o recurso adicional não pode impedir o carregamento v1. [S15]
- `ctx.command.transform` permite execução sem LLM, mas `execute` não retorna texto à UI. `ctx.session.synthetic` não deve ser usado como equivalente de `noReply`: seu conteúdo entra na conversa. Testar precedência antes de registrar o mesmo slash no servidor e na TUI. A apresentação em diálogo, em vez de inserir texto no histórico, é uma diferença de interface a documentar.
- RPC deve validar argumentos e devolver apenas saída sanitizada, sem tokens; provar **zero chamadas ao modelo** em comandos administrativos. Códigos OAuth não podem virar prompt. Login, transporte e CLI continuam operacionais sem TUI; outros clientes usam a interface programática documentada.
- Retornar cleanup em `setup`: encerrar timers, fluxos OAuth pendentes, assinaturas e requisições próprias; descarregar/recarregar não pode duplicar handlers ou gravar estado depois do encerramento.

## Etapas de implementação e critérios de saída

| Etapa                          | Trabalho                                                                                                           | Critério para avançar                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Provas do contrato          | Fixar versões; reproduzir carregadores, ponte de credenciais, TUI/RPC e transporte com servidor Anthropic simulado | Entrada dual resolve uma vez; switch/refresh têm API viável; saída administrativa não vira prompt; retries, concorrência e abort são preserváveis. Escolher rota nativa ou AI SDK com evidência. |
| 2. Fronteiras comuns           | Extrair adaptador do host e executor reutilizável, mantendo v1 como primeiro consumidor                            | Testes v1 e snapshots wire não mudam semanticamente; nenhuma API v2 exigida no caminho legado.                                                                                                   |
| 3. Entrada, OAuth e modelos v2 | Adicionar `server.mjs`, adaptador v2, método OAuth, conexão e transforms                                           | Login/refresh/switch funcionam; custos e limites atualizam com OAuth e config; v1 continua carregando.                                                                                           |
| 4. Transporte e contexto v2    | Implementar opção aprovada, políticas SSE/tool map e hooks de contexto                                             | Chat e chamadas auxiliares passam matriz de erros, streaming, ferramentas e cancelamento sem duplicação.                                                                                         |
| 5. Comandos e ciclo de vida    | Portar `/anthropic`, RPC, entrada TUI, saída local, notificações e cleanup                                         | Comandos administrativos não invocam LLM; interfaces documentadas funcionam sem TUI; reload não vaza recursos.                                                                                   |
| 6. Distribuição e documentação | Ajustar `files`/`exports`, build, instalador, README e contrato de mimicry                                         | Pacote empacotado e instalação link/copy passam nos hosts alvo, inclusive Windows. Instruções preservam rollback para v1.                                                                        |
| 7. Certificação                | Executar matriz completa e ensaio OAuth real controlado                                                            | Evidências anexadas por versão; nenhuma lacuna obrigatória; só então declarar suporte e seguir release por PR.                                                                                   |

Arquivos previstos: `server.mjs`, `tui.mjs` e contrato RPC conforme a API do host, novos módulos `lib/host/*.mjs`, extrações pontuais de `index.mjs`, `lib/mimicry/response-stream.mjs`, testes e fixtures dos adaptadores, `package.json`/lock, `scripts/build.mjs`, `scripts/install.mjs`, CI, README, CONTRIBUTING e `docs/mimese-http-header-system-prompt.md`. Preservar os testes de conformance; ampliar a cobertura, não substituí-la por mocks do novo wrapper.

## Estratégia de testes

### Matriz de hosts e distribuição

- v1.2.27: entrada legada e regressão de resolução; ampliar a certificação funcional somente se esse piso for mantido como promessa de suporte.
- v1.18.29 e v1.18.34: carregamento, OAuth, fetch, comando e entrada dual.
- v2.0.21: mesmos comportamentos pelo adaptador v2, inclusive operação sem TUI.
- Node 20/22/24 para os checks atuais; incluir Linux e Windows no ensaio do pacote/instalador. Usar o runtime próprio de cada release do host, sem confundir testes Node com testes OpenCode.
- Testar tarball publicado localmente com `npm pack`, além do checkout vinculado, diretório absoluto, configuração por pacote e bundles. Manter homes/config/data temporários isolados e impedir leitura de credenciais reais pelos testes.

### Casos de aceitação

1. Fábrica/definição carregada exatamente uma vez; helper nunca chamado como plugin; provider e comando aparecem nas APIs públicas. Testar instalação antiga standalone coexistindo com pacote, para diagnosticar duplicidade sem inicializar dois pools.
2. Sem credencial, login, código expirado/inválido, reauth, refresh único, conta desativada/removida, pool esgotado e troca com sessão em andamento.
3. Requests como URL/init e `Request` com body; mensagens grandes, Unicode, streaming, contagem de tokens, custom baseURL e provedores não Anthropic intactos.
4. 401 com refresh, 403 específico da conta, 429 e `Retry-After`, 529, rejeição de beta, fallback fast/standard, erro de rede e orçamento máximo de tentativas.
5. Cancelamento em todas as fases, backpressure, primeiro token, erro no meio do SSE, cancelamento do reader e ausência de replay após saída parcial.
6. Ferramentas nativas/MCP/subagentes: nomes de ida/volta e `tool_use`/`tool_result` correspondentes; thinking/citations/usage e eventos desconhecidos tratados pelo consumidor correto.
7. Config mutável, custos/limites OAuth, título/compactação/generate, duas sessões simultâneas e concorrência v1/v2/CLI sobre arquivos existentes.
8. Comandos administrativos sem LLM; textos/códigos de autenticação não viram prompt. Cleanup repetido, reload e remoção sem duplicação de timers/conexões.

Primeiro executar testes direcionados da etapa. Na conclusão da implementação: `npm test`, `npm run lint`, `npm run format:check`, `npm run build` e `npm run check:invariants`; antes de release, também `npm run check:wire-compat-drift`. Teste real autenticado valida login e resposta Anthropic, mas não substitui as falhas determinísticas do simulador. Não armazenar tokens em fixtures, logs ou CI.

## Riscos, rollback e decisões pendentes

| Risco                                                     | Mitigação/condição                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Retries nativos não oferecem o mesmo controle do fetch v1 | Etapa 1 antes da extração ampla; alternativa AI SDK explicitamente medida; bloquear anúncio de suporte se faltar capacidade pública. |
| Abort não alcança fetch próprio no hook Promise           | Prova com cancelamento real; recurso não pode ser considerado concluído apenas por testes de objetos mockados.                       |
| Shim ou nomes v1 corrompem resposta v2                    | Perfis explícitos por adaptador e testes através do parser/execução de ferramentas do host.                                          |
| Novo `exports`/bundle quebra v1                           | Preservar entrada antiga e seus testes; executar todos os modos de instalação e garantir uma única carga.                            |
| Duplo refresh ou perda de atualização entre processos     | Compartilhar locks e política de persistência; exercitar v1/v2/CLI em concorrência.                                                  |
| API evolui ou docs de beta divergem de stable             | Usar tags/SHAs e versões npm exatas; atualizar matriz antes de ampliar a declaração de suporte.                                      |

Rollback: reinstalar a versão anterior do plugin e selecionar a entrada/configuração v1 preservadas, sem migração destrutiva de arquivos. Manter backup antes de qualquer futura conversão de configuração do host. V1 e v2 usam os mesmos locais de configuração e o comando `opencode` na distribuição estável; testar lado a lado exige executáveis e diretórios isolados, não instalar um sobre o outro. [S11]

Decisões propostas para a implementação: começar por v2.0.21; preservar v1 recente com a entrada dual e o caminho legado `index.mjs`; não prometer equivalência do hook de fork `experimental.session.summarize`; usar TUI/RPC para saída interativa e escolher transporte após a prova da etapa 1. O piso final de suporte a v1 antigo e o alcance em clientes além da TUI dependem dos ensaios, sem impedir a investigação inicial. Nenhuma autorização de implementação, commit ou release é inferida deste plano.

## Fontes primárias

- **S1:** [Carregador v2.0.21: schema e rejeição da entrada](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/plugin/module.ts#L60).
- **S2:** [Guia oficial de migração de plugins: contrato dual e piso v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1/#support-v1-and-v2-from-one-package).
- **S3:** [Resolução de entradas v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/host.ts#L17).
- **S4:** [Resolução e validação v1.18.34](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/plugin/shared.ts#L103).
- **S5:** [API Promise de integrações/OAuth v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/integration.ts).
- **S6:** [Eventos de sessão e HTTP v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/session.ts#L63).
- **S7:** [Execução de hooks HTTP no host v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/session/model-request.ts#L334).
- **S8:** [Contrato de comandos v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/command.ts).
- **S9:** [Referência oficial de plugins](https://opencode.ai/v2/docs/build/plugins/).
- **S10:** [Hooks públicos AI SDK v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/aisdk.ts).
- **S11:** [Migração estável do host: configuração, ferramentas e instalação](https://opencode.ai/v2/docs/migrate-v1/).
- **S12:** [Manifesto npm @opencode/plugin 2.0.21](https://registry.npmjs.org/@opencode%2fplugin/2.0.21).
- **S13:** [Registro npm do CLI v2](https://registry.npmjs.org/@opencode%2fcli) e [registro npm do host v1](https://registry.npmjs.org/opencode-ai).
- **S14:** [Contexto, definição e helper Plugin.define v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/plugin.ts).
- **S15:** [Contexto público TUI v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/tui/context.ts).
- **S16:** [Schema de modelo/custos v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/schema/src/model.ts).
- **S17:** [Política de retry do host](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/session/runner/retry.ts) e [adaptador Promise dos hooks](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/plugin/src/promise/adapter.ts#L578).
- **S18:** [Settings do provider nativo](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/provider.ts#L135) e [custom fetch no AI SDK](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/aisdk.ts#L130).
- **S19:** [API de credenciais v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/protocol/src/groups/credential.ts).
- **S20:** [Carregador legado v1.2.27](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/plugin/index.ts).
- **S21:** [Parser Anthropic nativo v2.0.21](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/ai/src/protocols/anthropic-messages.ts#L1510).
