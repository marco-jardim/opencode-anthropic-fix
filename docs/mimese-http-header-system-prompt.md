# Mimese detalhada de HTTP headers e system prompt

Este documento descreve, em nivel de implementacao, como o plugin emula o comportamento de assinatura do Claude Code para requests Anthropic, com foco em:

- composicao de headers HTTP
- composicao de `system` no body
- campos auxiliares relacionados (`metadata`, `betas`, URL e toggles)

Referencias principais de codigo:

- `index.mjs`
- `lib/config.mjs`

## 1) Chave de controle (liga/desliga)

A mimese e controlada por `signature_emulation`:

```jsonc
{
  "signature_emulation": {
    "enabled": true,
    "fetch_claude_code_version_on_startup": true,
  },
}
```

Overrides por env (em `lib/config.mjs`):

- `OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE`
  - `1/true` => ativa
  - `0/false` => desativa
- `OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION`
  - `1/true` => busca versao mais recente do `@anthropic-ai/claude-code` no startup
  - `0/false` => usa fallback interno

Quando `signature_emulation.enabled=false`, o plugin cai para comportamento legado do transform de system prompt (prefixo Claude Code no hook `experimental.chat.system.transform`) e nao aplica o bloco completo de mimese de headers/system descrito abaixo.

## 2) Versao do Claude CLI usada na assinatura

Em `AnthropicAuthPlugin`:

- fallback inicial: `2.1.2`
- se `fetch_claude_code_version_on_startup=true`, faz GET em:
  - `https://registry.npmjs.org/@anthropic-ai/claude-code/latest`
- timeout curto (AbortController), falhas sao silenciosas e mantem fallback

Essa versao alimenta:

- `user-agent`
- `x-stainless-package-version`
- hash do bloco `x-anthropic-billing-header` no system

## 3) Fluxo de request onde a mimese acontece

No `auth.loader().fetch(...)`:

1. transforma URL (`transformRequestUrl`)
2. seleciona conta e resolve token (com refresh se necessario)
3. transforma body (`transformRequestBody`) com contexto runtime
4. monta headers (`buildRequestHeaders`)
5. sincroniza `body.betas` a partir do header `anthropic-beta` (`syncBodyBetasFromHeader`)
6. executa `fetch`

Importante: o body e transformado por tentativa/conta (nao apenas uma vez), para que `metadata.user_id` inclua o `accountId` real da conta em uso naquela tentativa.

## 4) Mimese de HTTP headers

### 4.1 Headers sempre aplicados

`buildRequestHeaders(...)` sempre garante:

- `authorization: Bearer <token>`
  - token padrao: access token OAuth da conta
  - override opcional: `ANTHROPIC_AUTH_TOKEN` (se definido, tem precedencia)
- `anthropic-beta: <lista final de betas>`
- `user-agent: claude-cli/<version> (external, <entrypoint>[, agent-sdk/<v>][, client-app/<app>])`
  - `entrypoint`: `CLAUDE_CODE_ENTRYPOINT` ou `cli`
  - sufixos opcionais:
    - `CLAUDE_AGENT_SDK_VERSION`
    - `CLAUDE_AGENT_SDK_CLIENT_APP`
- remove sempre `x-api-key`

### 4.2 Headers extras quando mimese esta ativa

Com `signature.enabled=true`, adiciona:

- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true`
- `x-app: cli`
- `x-stainless-arch: <x64|arm64|...>`
- `x-stainless-lang: js`
- `x-stainless-os: <MacOS|Windows|Linux|...>`
- `x-stainless-package-version: <claudeCliVersion>`
- `x-stainless-runtime: node`
- `x-stainless-runtime-version: <process.version>`
- `x-stainless-helper-method: stream`
- `x-stainless-retry-count`
  - preserva valor de entrada se existir e nao for falsy explicitamente
  - senao define `0`
- `x-stainless-helper`
  - extraido dinamicamente de `tools`/`messages` no body
  - coleta chaves: `x_stainless_helper`, `x-stainless-helper`, `stainless_helper`, `stainlessHelper`, `_stainless_helper`
  - agrega sem duplicatas, separado por virgula

Tambem injeta headers opcionais por env:

- `ANTHROPIC_CUSTOM_HEADERS` (multilinha `Header-Name: value`)
  - cada linha valida vira header
- `CLAUDE_CODE_CONTAINER_ID` => `x-claude-remote-container-id`
- `CLAUDE_CODE_REMOTE_SESSION_ID` => `x-claude-remote-session-id`
- `CLAUDE_AGENT_SDK_CLIENT_APP` => `x-client-app`
- `CLAUDE_CODE_ADDITIONAL_PROTECTION=1/true/yes` => `x-anthropic-additional-protection: true`

## 5) Catalogo de beta headers (referencia Claude Code vs estado atual)

### 5.1 Regra de composicao no plugin

A funcao `buildAnthropicBetaHeader(incomingBeta, signatureEnabled, model, provider)`:

- inicia com `oauth-2025-04-20`
- preserva betas de entrada (`incomingBeta`) e remove duplicados no merge

Quando `signatureEnabled=false`:

- adiciona `interleaved-thinking-2025-05-14` (alem de oauth)

Quando `signatureEnabled=true`, no estado atual pode adicionar dinamicamente:

- `claude-code-20250219` (nao adiciona para modelos haiku)
- `interleaved-thinking-2025-05-14` (se modelo suporta e nao desativado por `DISABLE_INTERLEAVED_THINKING`)
- `context-1m-2025-08-07` (se modelo indica 1M context)
- `context-management-2025-06-27` (modo nao interativo + flags)
- `structured-outputs-2025-12-15` (modelo suporta + `TENGU_TOOL_PEAR`)
- `tool-examples-2025-10-29` (modo nao interativo + `TENGU_SCARF_COFFEE`)
- `web-search-2025-03-05` (provider `vertex`/`foundry` + modelo com suporte)
- `prompt-caching-scope-2026-01-05` (modo nao interativo)
- betas adicionais de `ANTHROPIC_BETAS` (exceto haiku)
- `fine-grained-tool-streaming-2025-05-14` (observacao: ver nota em 5.4)

Filtro por provider:

- se provider detectado for `bedrock`, remove betas em `BEDROCK_UNSUPPORTED_BETAS`.

Deteccao de provider e por hostname da URL (`anthropic`, `bedrock`, `vertex`, `foundry`).

### 5.2 Betas de referencia do Claude Code (lista consolidada)

Betas ativados automaticamente pelo Claude Code (conforme levantamento funcional):

- `claude-code-20250219`
- `interleaved-thinking-2025-05-14`
- `context-1m-2025-08-07`
- `context-management-2025-06-27`
- `structured-outputs-2025-12-15`
- `tool-examples-2025-10-29`
- `prompt-caching-scope-2026-01-05`
- `adaptive-thinking-2026-01-28`
- `effort-2025-11-24`
- `fast-mode-2026-02-01`
- `oauth-2025-04-20`
- `token-counting-2024-11-01` (preflight `/v1/messages/count_tokens`)

Betas considerados uteis em integracoes especificas:

- `files-api-2025-04-14`
- `message-batches-2024-09-24`
- `code-execution-2025-08-25`
- `compact-2026-01-12`
- `mcp-servers-2025-12-04`

Betas de plataforma (nao usar diretamente como comportamento cross-provider):

- `bedrock-2023-05-31`
- `vertex-2023-10-16`
- `oauth-2025-04-20`
- `ccr-byoc-2025-07-29`

### 5.3 Gap atual do plugin em relacao a referencia

Ainda nao ha composicao automatica dedicada para:

- `adaptive-thinking-2026-01-28`
- `effort-2025-11-24`
- `fast-mode-2026-02-01`
- `token-counting-2024-11-01` (fluxo de preflight)

Esses betas ainda podem ser injetados manualmente via `ANTHROPIC_BETAS` quando fizer sentido operacional.

### 5.4 Nota importante sobre fine-grained tool streaming

`fine-grained-tool-streaming` no Claude Code e modelado primariamente por campo de tool (`eager_input_streaming=true`) e feature flag/env, nao como dependencia obrigatoria de beta header.

No estado atual deste plugin, ele ainda pode aparecer na lista de betas montada automaticamente. Isso foi mantido para compatibilidade com o comportamento ja implementado, mas deve ser tratado como area de ajuste fino para alinhamento estrito com o CLI de referencia.

## 6) Mimese de system prompt

### 6.1 Normalizacao de blocos

`normalizeSystemTextBlocks(system)` converte `system` para array de objetos:

- strings viram `{ type: "text", text: "..." }`
- objetos com `text` string sao mantidos
- preserva `cacheScope` quando presente

### 6.2 Sanitizacao de texto

`sanitizeSystemText(text)` aplica:

- `OpenCode` => `Claude Code`
- `opencode`/`OpenCode` variantes => `Claude`
  - com excecao de ocorrencia precedida por `/` (preserva paths)

### 6.3 Blocos injetados quando mimese ativa

`buildSystemPromptBlocks(...)` faz:

1. sanitiza todos os blocos
2. remove blocos pre-existentes que ja sejam:
   - `x-anthropic-billing-header: ...`
   - strings de identidade conhecidas (`KNOWN_IDENTITY_STRINGS`)
3. cria lista final com ordem:
   - (opcional) billing header block com `cacheScope: null`
   - identity block oficial com `cacheScope: "org"`
   - blocos originais filtrados/sanitizados

Identity canonical usada:

- `You are Claude Code, Anthropic's official CLI for Claude.`

### 6.4 Como o billing header e gerado

`buildAnthropicBillingHeader(claudeCliVersion, messages)`:

- pode ser desativado por `CLAUDE_CODE_ATTRIBUTION_HEADER=0/false/no`
- pega o primeiro texto de mensagem `user`
- amostra caracteres nas posicoes `[4, 7, 20]` (fallback `"0"` se faltar)
- calcula `sha256(BILLING_HASH_SALT + sampled + claudeCliVersion)`
  - `BILLING_HASH_SALT = "59cf53e54c78"`
- usa os 3 primeiros hex chars como sufixo de hash
- monta string:

```text
x-anthropic-billing-header: cc_version=<claudeCliVersion>.<hash3>; cc_entrypoint=<entrypoint>; cch=00000;
```

Detalhe: `cc_entrypoint` aqui usa `CLAUDE_CODE_ENTRYPOINT` ou `unknown` (diferente do user-agent, cujo default e `cli`).

## 7) Campos de body relacionados a mimese

Quando mimese ativa, `transformRequestBody(...)` adiciona/atualiza:

- `metadata.user_id` no formato:
  - `user_<persistentUserId>_account_<accountId>_session_<sessionId>`

Onde:

- `persistentUserId`:
  - override opcional por `OPENCODE_ANTHROPIC_SIGNATURE_USER_ID`
  - senao, carregado de arquivo persistente em `getConfigDir()/anthropic-signature-user-id`
  - se nao existir, gera UUID e persiste
- `sessionId`: UUID gerado uma vez por inicializacao do plugin
- `accountId`: `account.accountUuid` se existir; fallback para `account.id`

Depois de montar headers, `syncBodyBetasFromHeader(...)` garante:

- `body.betas = anthropic-beta.split(",")` (trim/filter)

Assim o body carrega a mesma lista efetiva de betas enviada no header.

## 8) Ajustes de URL relacionados

`transformRequestUrl(input)` adiciona `?beta=true` para requests em `/v1/messages` quando o parametro ainda nao existe.

## 9) Compatibilidade e fallback

- Mimese ativa por padrao (config default)
- Se desativada, o plugin mantem operacao de auth/rotacao e usa caminho legado de system transform
- Falhas em parsing JSON do body nao derrubam request (retorna body original)
- Falhas de IO ao persistir `persistentUserId` nao derrubam request (UUID runtime continua valendo)
- Falha na busca de versao no npm nao derruba startup (usa fallback)

## 10) Checklist rapido de verificacao

Para auditar se a mimese esta ativa em runtime:

1. confirmar `signature_emulation.enabled=true` (config ou env)
2. inspecionar request headers e verificar presenca de `x-stainless-*`, `x-app`, `anthropic-version`
3. verificar `anthropic-beta` com flags esperadas para modelo/provider
4. inspecionar body e confirmar:
   - `system[0..]` contendo identity block (e billing block se nao desativado)
   - `metadata.user_id` no formato composto
   - `betas` alinhado com header
