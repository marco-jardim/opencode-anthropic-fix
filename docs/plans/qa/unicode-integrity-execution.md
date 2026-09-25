# Registro de execucao: integridade Unicode

Inicio: 2026-09-25. Plano: `docs\plans\2026-09-25-unicode-integrity-fix-plan.md` (nesta worktree). Handover: `docs\plans\2026-09-25-unicode-integrity-handover.md`.

## Gate zero (plano 1.1) — PASS com isolamento

Verificacao read-only executada antes de qualquer mutacao:

- `C:\Users\Marquinho\.config\opencode\opencode.json`, campo `plugin` (projecao segura, somente esta chave): contem `"D:\git\opencode-anthropic-fix"` como path direto. O host vivo carrega o checkout CANONICO do plugin.
- Junction `...\opencode\node_modules\opencode-anthropic-fix`: inexistente. Carregamento e por path direto, nao por junction.
- `...\opencode\node_modules\@tormentalabs\claude-code-wire-compat`: inexistente nesse nivel; a dependencia resolve dentro de `D:\git\opencode-anthropic-fix\node_modules` (registry `0.5.0`, nao link local).
- Outros plugins vivos (`D:\git\opencode-model-router`, `D:\git\opencode-telegram-plugin`): sem dependencia `file:`/`link:` para wire-compat.
- Biblioteca `D:\git\claude-code-wire-compat`: NAO carregada pelo host vivo. P1 pode executar no repo canonico da biblioteca.
- Sessao atual provavelmente executa atraves do plugin vivo (evidencia de sanitizacao de prompt). Nenhuma mutacao de runtime/install/build/commit no checkout canonico do plugin.

Decisao: E-CAND isolado. Sem consentimento para WIP vivo; sem alteracao de junction/config vivos.

## Adendo de mapeamento canonico -> isolado (vinculante)

| Canonico (default do plano)                                                              | Efetivo nesta execucao                                                                              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `D:\git\opencode-anthropic-fix` (E-CAND, CWDs de gates, owners, novos arquivos de teste) | `D:\git\opencode-anthropic-fix-unicode`                                                             |
| `D:\git\opencode-anthropic-fix\docs\plans\qa\unicode-integrity-execution.md`             | `D:\git\opencode-anthropic-fix-unicode\docs\plans\qa\unicode-integrity-execution.md` (este arquivo) |
| `D:\git\claude-code-wire-compat` (P1, biblioteca)                                        | `D:\git\claude-code-wire-compat` (inalterado; nao-live)                                             |

- E-CAND: worktree git `D:\git\opencode-anthropic-fix-unicode`, branch `fix/unicode-integrity`, base `57c9583` (master HEAD na criacao).
- E-BASE: referencia congelada = checkout canonico `D:\git\opencode-anthropic-fix` em `57c9583`, somente leitura; nenhum write/commit la.
- Transferencia de documentos untracked: plano e handover copiados do canonico para E-CAND com SHA256 identicos (verificado via Get-FileHash em 2026-09-25). Originais preservados no canonico, untracked, sem modificacao.

## Baseline registrada

- Plugin canonico: branch `master`, HEAD `57c9583`, versao `1.0.0`, specifier da dependencia `latest`, lock/install `wire-compat 0.5.0`.
- Biblioteca: branch `port/claude-code-2.1.280`, HEAD `9c9dd6f`, versao `0.6.0`. Worktrees existentes: `-release` (`release/0.6.0`), `-tool-choice`.
- Runtimes: Node `v24.15.0`, npm `12.0.2`. Biblioteca exige Node >=20: OK.
- `Intl.Segmenter`: verificar na primeira tarefa de implementacao P2 (Node 24 tem ICU completo por default; registrar confirmacao).

## Leases ativos

| Recurso                                                    | Modo                                             | Dono                            |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| `D:\git\opencode-anthropic-fix-unicode` (worktree inteira) | WRITE serializado                                | orquestrador (ate delegacao P2) |
| `D:\git\claude-code-wire-compat` (worktree inteira)        | WRITE unico por vez (regra AGENTS da biblioteca) | orquestrador (ate delegacao P1) |
| `D:\git\opencode-anthropic-fix` (canonico)                 | READ apenas                                      | qualquer agente, sem WRITE      |

## Autorizacoes PENDENTE (plano 1.2)

- Publicacao RC `X.Y.Z-rc.N` no npm registry fora de `latest` (P2.T0): repo/branch de push, tag, workflow trigger, `package@version`, dist-tag. Versao ainda nao decidida (depende de P1).
- Probe live sintetico para politica remota de controles de corpo (endpoint/corpus/budget): necessario somente se a evidencia first-party em P1.T1 for insuficiente.
- Publicacao estavel `X.Y.Z` (P4.T7), adocao no host real, eventuais edicoes de host/renderer.
- Alteracao minima de CI (`publish.yml`) somente se o gate de identidade de RC estiver ausente — verificar read-only no pre-flight P1.

## Log de fases

(Preencher por fase: pre-flight, comandos/CWD/exit code, QA heavy verdict, commits, bloqueios.)

- 2026-09-25: gate zero PASS com isolamento; adendo de mapeamento registrado; baseline coletada. Proximo: npm ci + baseline suite em E-CAND; commit docs:; pre-flight P1 na biblioteca.
