# Repurpose Studio — Task 6 reliability handoff — 2026-08-25

## Retomada rápida

Abra o PowerShell e entre exatamente neste worktree:

```powershell
cd "C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor"
```

Depois use exatamente este prompt:

```text
continue pelo handoff Task 6 reliability de 2026-08-25 e finalize tudo até a Task 12
```

## Identidade do checkpoint

- Worktree: `C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor`
- Branch: `fix/stabilize-editor`
- HEAD/base do WIP: `200f2a40643c48aea9f4a686f6dfc0243991c2c5`
- Plano autoritativo: `docs/superpowers/plans/2026-08-21-repurpose-studio-stabilization.md`
- Tarefa 6: em andamento, ainda não aprovada nem commitada.
- Tarefas 7–12: não iniciadas.
- Porta 3001: livre na verificação deste handoff.

## Regras de segurança que não podem ser quebradas

- Preserve integralmente o WIP atual. Não use `reset`, `restore`, `clean`, `stash`, checkout destrutivo nem reescrita em massa para tentar voltar a um estado anterior.
- Não faça merge, push, deploy, remoção do worktree ou alteração de outra branch sem autorização adicional do usuário.
- A porta 3000 pertence a outro servidor/projeto. Não pare, reinicie nem perturbe o processo da porta 3000.
- Use a porta 3001 para desenvolvimento e Playwright neste worktree, conforme `AGENTS.md`.
- Preserve o arquivo real `C:\Users\oslan\Downloads\IMG_6849.MOV`: não sobrescreva, mova, renomeie nem apague. Ele será usado na aceitação real da Tarefa 12.
- Execute `npm run fixtures:media` antes de testes que consomem fixtures locais de mídia.
- Todo teste Node-only em `tests/server/*.test.ts` deve manter `// @vitest-environment node` no topo.
- Antes de declarar o plano completo, execute `npm run verify`, além dos gates e da QA definidos no plano.

## Estado exato do WIP

Antes da criação deste próprio documento, o checkpoint da Tarefa 6 tinha **6 arquivos modificados + 4 arquivos não rastreados**:

```text
 M app/api/repurpose/projects/route.ts
 M app/repurpose-studio/_components/useProjectPersistence.ts
 M lib/repurpose/ingest.ts
 M lib/repurpose/projects.ts
 M lib/repurpose/store.ts
 M lib/repurpose/types.ts
?? lib/repurpose/video-import-client.ts
?? tests/components/project-persistence.test.tsx
?? tests/server/projects-route.test.ts
?? tests/unit/video-import-client.test.ts
```

O diff stat dos seis arquivos rastreados é:

```text
app/api/repurpose/projects/route.ts                |  252 +++-
app/repurpose-studio/_components/useProjectPersistence.ts | 1395 ++++++++++++++++++--
lib/repurpose/ingest.ts                            |   52 +-
lib/repurpose/projects.ts                          |  242 +++-
lib/repurpose/store.ts                             |   50 +-
lib/repurpose/types.ts                             |   27 +
6 files changed, 1875 insertions(+), 143 deletions(-)
```

Depois de criado, este handoff aparece como um quinto arquivo não rastreado. Ele é documentação do checkpoint e não altera a contagem do WIP de código/testes acima.

## Invariantes de mídia da Tarefa 6

- `originalPath` identifica a cópia local original, imutável. O original nunca pode ser modificado ou apagado por conversão, proxy ou exportação.
- `workingPath` é a fonte full-quality autoritativa: igual ao original quando o arquivo é compatível nativamente, ou igual ao master H.264 validado quando conversão é necessária.
- `previewPath` é opcional e aponta apenas para o proxy de edição. Um preview ausente deve ser limpo/reconstruído em background e nunca bloquear playback full-quality.
- `faceCamPath`, `screenPath`, `src` e o legado `sourcePath` para vídeo devem ser rederivados do `workingPath`, mantendo compatibilidade com consumidores existentes.
- Um master convertido ausente deve ser reconstruído a partir do `originalPath` imutável quando o original ainda existe.
- Se original e working desaparecerem, o projeto deve pedir reconexão e não aparentar que playback está disponível.
- Exportação sempre lê `workingPath` full-quality. Nunca exporta a partir de `previewPath`.
- Snapshots persistem identidades original/working/preview, mas nunca progresso transitório de importação.

## Implementações já GREEN nesta rodada

As seguintes correções/findings já foram implementadas e tiveram evidência focada verde:

- Lock de projeto no servidor e replay idempotente de criação: `tests/server/projects-route.test.ts`, **18/18 GREEN**.
- Cancelamento local quando o `DELETE` de compatibilidade não responde: suíte do cliente de importação, **40/40 GREEN**.
- Estado explícito `loadError` e ação `retryLoad`, mantendo hidratação bloqueada até retry deliberado.
- Probe real de browser e conversão de caminho HEVC legado antes de marcar a mídia como compatível.
- Retry de autosave com backoff após falha recuperável.
- Tratamento recuperável de conflito com salvar cópia e recarregar o projeto autoritativo.
- Hot path de persistência com materialização adiada de snapshot; o teste `materializes one debounced snapshot instead of deep-cloning every playhead tick` agora está **GREEN**.

Importante: **nenhum patch para os dois findings de `sendBeacon`/`keepalive` foi aplicado**. Não suponha que esses casos foram parcialmente resolvidos. O hot path, por outro lado, já foi corrigido e está GREEN.

## Quatro REDs restantes, exatamente

Ainda faltam exatamente estes quatro findings determinísticos em `tests/components/project-persistence.test.tsx`:

1. Create replay após reload de URL provisória: `replays the same create attempt after reloading a provisional new URL`.
2. Catch-up da revisão local emitida: `catch-up saves an emitted local revision after reopening an older same-writer disk revision`.
3. Beacon aceito deve continuar pendente até a página voltar a visible e um POST normal confirmar: `keeps a true sendBeacon pending until visibility resumes and a POST confirms it`.
4. Falha de keepalive por payload grande deve refazer POST normal ao voltar a visible: `retries a large keepalive failure normally when the page becomes visible`.

Comandos focados exatos, um por vez:

```powershell
npm test -- tests/components/project-persistence.test.tsx -t "replays the same create attempt after reloading a provisional new URL" --reporter=verbose --testTimeout=10000 --hookTimeout=10000
```

```powershell
npm test -- tests/components/project-persistence.test.tsx -t "catch-up saves an emitted local revision after reopening an older same-writer disk revision" --reporter=verbose --testTimeout=10000 --hookTimeout=10000
```

```powershell
npm test -- tests/components/project-persistence.test.tsx -t "keeps a true sendBeacon pending until visibility resumes and a POST confirms it" --reporter=verbose --testTimeout=10000 --hookTimeout=10000
```

```powershell
npm test -- tests/components/project-persistence.test.tsx -t "retries a large keepalive failure normally when the page becomes visible" --reporter=verbose --testTimeout=10000 --hookTimeout=10000
```

Mantenha cada RED como contrato. Investigue a causa, escreva o menor patch coerente e não enfraqueça assertions, timeouts ou semântica para obter verde.

## Gates exatos da Tarefa 6

Quando os quatro REDs estiverem verdes, rode primeiro a suíte consolidada da Tarefa 6 — cliente de importação, persistência nova, rota de projetos e hook legado:

```powershell
npm test -- tests/unit/video-import-client.test.ts tests/components/project-persistence.test.tsx tests/server/projects-route.test.ts tests/components/useProjectPersistence.test.tsx --reporter=verbose --testTimeout=10000 --hookTimeout=10000
```

Typecheck:

```powershell
npm run typecheck
```

ESLint isolado no WIP da Tarefa 6:

```powershell
npx eslint app/api/repurpose/projects/route.ts app/repurpose-studio/_components/useProjectPersistence.ts lib/repurpose/ingest.ts lib/repurpose/projects.ts lib/repurpose/store.ts lib/repurpose/types.ts lib/repurpose/video-import-client.ts tests/components/project-persistence.test.tsx tests/components/useProjectPersistence.test.tsx tests/server/projects-route.test.ts tests/unit/video-import-client.test.ts
```

Gates amplos e diff-check:

```powershell
npm run fixtures:media
npm test
npm run build
git diff --check
```

A suíte completa teve **279/279 testes GREEN** e `npm run build` passou antes da rodada atual de findings. Esses resultados agora são **stale**: não servem como prova após as alterações desta rodada e precisam ser gerados novamente.

## Revisão e commit obrigatórios antes da Tarefa 7

Depois de todos os testes/gates verdes:

1. Faça uma revisão de aderência à Tarefa 6 e aos contratos original/working/preview/export.
2. Faça verification independente com outputs frescos; não conclua por memória ou ausência aparente de erros.
3. Faça revisão de anti-patterns, especialmente loops de autosave, snapshots em hot path, timers/listeners não limpos, retries concorrentes, beacon tratado como confirmação e reload/provisional URL.
4. Faça revisão formal de qualidade do diff completo, incluindo concorrência e idempotência server-side.
5. Corrija e repita testes/revisões até haver **zero findings Critical/Important**.
6. Só então crie o commit da Tarefa 6. Não misture Tarefas 7–12 nesse commit.
7. Após o commit aprovado da Tarefa 6, implemente as Tarefas 7–12 em ordem, com os testes, commits e evidências exigidos pelo plano.

Ao terminar a Tarefa 12, rode a aceitação completa com `IMG_6849.MOV`, E2E/QA do editor, paridade visual de export, `npm run verify`, revisão final e evidência fresca. Deixe a branch pronta para integração, mas não faça merge, push ou deploy sem autorização adicional.

## Latência observada das ferramentas

Alguns comandos/patches desta rodada demoraram aproximadamente 15–25 minutos para retornar. Isso é uma característica operacional observada, **não um blocker** e não autoriza cancelar processos saudáveis, repetir comandos destrutivamente ou descartar WIP. Use timeouts focados para testes suspeitos, inspecione processos/porta antes de repetir e continue de forma normal quando houver progresso.

## Sequência exata de retomada

1. Entre no worktree com o comando `cd` do início deste documento.
2. Leia completamente `AGENTS.md`, este handoff e a Tarefa 6 do plano.
3. Confirme branch `fix/stabilize-editor`, HEAD `200f2a40643c48aea9f4a686f6dfc0243991c2c5`, status e diff; preserve os 10 arquivos de WIP.
4. Confirme que a porta 3000 permanece intocada, que a porta 3001 está disponível e que `IMG_6849.MOV` permanece no local original.
5. Rode separadamente os quatro comandos RED, na ordem listada, para restabelecer o baseline atual.
6. Resolva os quatro findings com systematic debugging e TDD RED→GREEN, sem enfraquecer contratos; lembre que nenhum patch beacon foi aplicado ainda.
7. Rode a suíte consolidada da Tarefa 6, typecheck, ESLint isolado, fixtures, suíte completa, build e `git diff --check` usando os comandos exatos acima.
8. Execute revisão de aderência/verification, anti-patterns e qualidade; corrija e repita até zero Critical/Important.
9. Somente com evidência fresca e aprovação, faça o commit isolado da Tarefa 6.
10. Execute e verifique as Tarefas 7–12 em ordem, preservando os invariantes de mídia e criando commits isolados conforme o plano.
11. Na Tarefa 12, faça a aceitação real com `C:\Users\oslan\Downloads\IMG_6849.MOV`, QA E2E, export full-quality, `npm run verify` e auditoria final de conclusão.
12. Deixe `fix/stabilize-editor` pronta para integração e pare antes de merge, push ou deploy até receber autorização adicional.

Prompt exato para retomar:

```text
continue pelo handoff Task 6 reliability de 2026-08-25 e finalize tudo até a Task 12
```
