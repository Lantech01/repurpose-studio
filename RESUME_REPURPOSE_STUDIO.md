# Retomada exata — Repurpose Studio

> **Checkpoint atual (2026-08-26):** as Tarefas 6–11 foram concluídas, revisadas e
> commitadas. As seções abaixo preservam o histórico da retomada anterior e não
> representam mais o próximo passo.

## Estado atual

- Branch: `fix/stabilize-editor`.
- Tarefa 6: `2b8654e` — persistência e identidades original/working.
- Tarefa 7: `d9d23c8` — pipeline HEVC em todas as entradas de vídeo.
- Tarefa 8: `84272ee` — proxies 540p; flake corrigida em `8c93364`.
- Tarefa 9: `7950333` — motor SFX offline.
- Tarefa 10: `ae7501d` — reabertura, exportação e E2E real.
- Tarefa 11: `910440c` — dependências compatíveis, auditorias zeradas.
- Últimos gates: 547 testes passaram, 3 foram ignorados; 3/3 Playwright passaram;
  build passou; `npm audit` e `npm audit --omit=dev` retornaram zero vulnerabilidades.
- Próximo passo: executar a Tarefa 12, incluindo QA exaustivo e aceitação do arquivo
  `C:\Users\oslan\Downloads\IMG_6849.MOV`, sem modificar o original.
- Encerramento: rodar `npm run verify`, revisão final e deixar a branch pronta para
  integração. Não fazer merge, push nem deploy sem autorização.

Atualizado em 2026-08-25. Este arquivo e o estado não commitado da árvore de trabalho são o ponto oficial de retomada.

## Como retomar

Abra o terminal e execute:

```powershell
cd C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor
codex
```

Na nova sessão, envie exatamente:

```text
Leia RESUME_REPURPOSE_STUDIO.md por inteiro e continue autonomamente do ponto exato, sem me fazer perguntas. Conclua a Tarefa 6 e depois as Tarefas 7–12, execute todos os gates e deixe a branch pronta para integração. Não faça merge, push nem deploy.
```

## Objetivo ativo

Concluir integralmente a estabilização do Repurpose Studio no worktree `fix/stabilize-editor`, preservando o WIP atual da Tarefa 6, implementar e verificar as Tarefas 6–12 do plano, resolver findings, obter todos os gates verdes e deixar a branch pronta para integração. Não fazer merge, push ou deploy sem nova autorização.

O usuário pediu explicitamente para trabalhar sem perguntar. Prossiga com suposições seguras dentro do escopo; só interrompa por um bloqueio externo real ou por uma ação fora do escopo.

## Local e branch

- Worktree: `C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor`
- Branch: `fix/stabilize-editor`
- Base/HEAD ao iniciar este ciclo: `200f2a40643c48aea9f4a686f6dfc0243991c2c5`
- Aplicação: `http://localhost:3001/repurpose-studio`
- Não tocar na porta 3000.
- Não modificar nem apagar `C:\Users\oslan\Downloads\IMG_6849.MOV`.

## Plano restante

1. Tarefa 6 — corrigir e revalidar os findings finais de confiabilidade.
2. Tarefa 7 — pipeline de compatibilidade para todas as entradas de vídeo.
3. Tarefa 8 — proxy 540p.
4. Tarefa 9 — efeitos sonoros.
5. Tarefa 10 — reabertura, exportação e E2E.
6. Tarefa 11 — dependências e segurança.
7. Tarefa 12 — QA exaustivo, incluindo HEVC real.
8. Revisão final, todos os gates verdes e branch pronta para integração.

## Estado exato da Tarefa 6

O trabalho anterior já implementou a base de persistência/confiabilidade: identidades original/working/preview, importação, concorrência otimista, create idempotente, migração/reconciliação, lock de servidor, cancelamento e testes associados. A rodada final de revisão encontrou lacunas adicionais.

Neste momento foram escritos cinco testes RED em `tests/server/projects-route.test.ts`:

- create aguarda o lock do ID final;
- delete usa o mesmo lock de mutação;
- lock antigo sem `owner.json` é recuperado;
- autosave sobre arquivo corrompido retorna conflito em vez de criar sufixo;
- IDs com sufixo continuam limitados a 100 caracteres.

RED comprovado antes das correções: 18 testes existentes passaram e os cinco novos falharam pelos motivos esperados.

As correções de produção já foram aplicadas e revalidadas:

- `lib/repurpose/projects.ts`: recuperação com grace period de lock órfão/malformado, `projectFileExists()` e truncamento seguro em `uniqueId()`;
- `app/api/repurpose/projects/route.ts`: create adquire lock global e lock do ID final, rejeita o ID reservado `project-create-lock` e retorna `PROJECT_FILE_CORRUPT` no autosave sobre arquivo corrompido;
- `app/api/repurpose/projects/[id]/route.ts`: DELETE agora usa `withProjectMutationLock()` e retorna 503 em timeout.

O patch do DELETE foi confirmado presente. Em 2026-08-25, o teste focado do servidor terminou verde:

```powershell
npm test -- tests/server/projects-route.test.ts --reporter=verbose
```

Resultado: **23/23 testes passaram**, incluindo os cinco novos cenários. `npm run typecheck` e o ESLint focado nos arquivos do servidor também terminaram com exit code 0.

O trabalho do hook/cliente foi iniciado. A suíte existente foi executada antes das novas mudanças e terminou verde com **46/46 testes**. Em seguida foram adicionados dois novos testes TDD no fim de `tests/components/project-persistence.test.tsx`:

- `clears a recoverable save conflict when the route changes`;
- `treats a valid same-writer supersession as an autosave acknowledgement`.

Esses dois testes novos **ainda não foram executados**. O próximo passo exato é rodá-los para comprovar RED:

```powershell
npm test -- tests/components/project-persistence.test.tsx -t "clears a recoverable save conflict|treats a valid same-writer supersession" --reporter=verbose --testTimeout=10000 --hookTimeout=10000
```

Depois implementar no hook:

1. limpar `saveConflict`/`conflictedSaveRef` e estado relacionado quando `projectId` muda;
2. validar que a resolução assíncrona ainda pertence à rota e ao conflito originais depois do `await`;
3. no `runSave`, tratar somente um `SUPERSEDED_SAME_WRITER` bem formado (`saveWriterId` igual e revisão do servidor maior ou igual à enviada) como confirmação, avançando a revisão e sem bloquear;
4. remover o `flushSync` e fazer os testes aguardarem o estado React corretamente.

Depois deste lote, escrever e executar testes para retry idempotente automático de create e para conflito no fallback keepalive, antes de implementar outbox durável, snapshot malformado e cancelamento legacy.

Testes Vitest dentro do sandbox podem falhar com `spawn EPERM`; usar a execução escalada normal quando necessário.

## Findings ainda pendentes depois do servidor

### Hook/cliente

- conflito deve pertencer à rota/projeto e ser limpo em troca/reset;
- resolução assíncrona de conflito deve validar ownership depois do `await`;
- create com erro de rede/503 precisa retry automático idempotente com backoff;
- `SUPERSEDED_SAME_WRITER` no save normal deve confirmar a própria gravação;
- fallback keepalive 409 deve usar o handler comum de conflito recuperável;
- implementar outbox durável para snapshot grande/beacon não confirmado, sem persistir blobs/transientes e tolerando erro/quota de storage;
- snapshot malformado não pode deixar hidratação travada;
- abort da conversão legacy deve enviar DELETE best-effort com timeout;
- remover `flushSync` usado apenas para timing de teste;
- ajustar mock/teste de replay para a terceira tentativa de takeover.

### Interface

`RepurposeEditor.tsx` ainda precisa consumir `ready`, `loadError`, `retryLoad`, `saveConflict` e `resolveSaveConflict`: bloquear edição/play durante hidratação/erro, mostrar alerta em português com retry e oferecer recarregar/salvar cópia para conflitos, mantendo acessibilidade e `footageNeedsReimport`.

Use TDD em lotes pequenos: escrever o teste, comprovar RED, implementar e comprovar GREEN.

## Verificação da Tarefa 6

Quando os findings estiverem corrigidos, rodar:

```powershell
npm test -- tests/unit/video-import-client.test.ts tests/components/project-persistence.test.tsx tests/server/projects-route.test.ts tests/components/useProjectPersistence.test.tsx --reporter=verbose --testTimeout=10000 --hookTimeout=10000
npm run typecheck
npm test
npm run build
git diff --check
```

Também executar lint focado nos arquivos alterados e uma revisão final sem findings Critical/Important antes de considerar a Tarefa 6 concluída.

O `AGENTS.md` exige `npm run fixtures:media` antes de testes que usam fixtures e `npm run verify` antes de declarar o projeto concluído. Exportação deve sempre usar a mídia original/autoritativa, nunca o preview.

## Arquivos WIP conhecidos

```text
M  app/api/repurpose/projects/[id]/route.ts
M  app/api/repurpose/projects/route.ts
M  app/repurpose-studio/_components/useProjectPersistence.ts
M  lib/repurpose/ingest.ts
M  lib/repurpose/projects.ts
M  lib/repurpose/store.ts
M  lib/repurpose/types.ts
?? lib/repurpose/video-import-client.ts
?? tests/components/project-persistence.test.tsx
?? tests/server/projects-route.test.ts
?? tests/unit/video-import-client.test.ts
?? docs/superpowers/handoffs/2026-08-25-repurpose-studio-task6-reliability-handoff.md
?? RESUME_REPURPOSE_STUDIO.md
```

Não descartar nem sobrescrever mudanças existentes: todo esse WIP pertence ao trabalho atual.

## Evidência anterior útil

Antes da rodada final de findings, o conjunto focado chegou a 86/86, o Vitest completo a 279 passed e 3 skipped, e typecheck/build/lint focado estavam verdes. Esses resultados ficaram obsoletos após as correções mais recentes e devem ser executados novamente.

## Regra de encerramento

Somente marcar o objetivo como concluído quando as Tarefas 6–12 estiverem implementadas, a QA real tiver terminado, `npm run verify` e os demais gates estiverem verdes e não restar finding Critical/Important. Deixar a branch pronta, mas não fazer merge, push ou deploy.
