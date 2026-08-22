# Repurpose Studio - Handoff da estabilizacao do transporte

Data: 2026-08-22
Motivo da pausa: o terminal pode cair; preservar integralmente o trabalho em andamento
Branch: `fix/stabilize-editor`
Worktree: `C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor`

## Estado resumido

- Task 1 concluida e aprovada.
- Task 2 passou pelo review de especificacao e chegou ao review de qualidade.
- O codigo aprovado/commitado da Task 2 esta em `92740a0` (`fix: make playback follow one transport clock`).
- A primeira rodada de qualidade ja foi incorporada nesse commit: hidratacao volta por `setFootageMeta`, Play bloqueado mostra razao acessivel, e store/TransportBar compartilham um unico resolvedor de bloqueio.
- A segunda rodada de qualidade esta preservada como diff nao commitado em exatamente dois arquivos.
- Nao descartar, restaurar, sobrescrever ou fazer checkout desses dois arquivos.

## Estado esperado ao retomar

```powershell
Set-Location 'C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor'
git branch --show-current
git log --oneline -8
git status --short
git diff --check
```

Esperado:

```text
fix/stabilize-editor
 M app/repurpose-studio/_components/PreviewCanvas.tsx
 M tests/components/PreviewCanvas.transport.test.tsx
```

`git diff --check` estava limpo no momento deste handoff.

## Commits relevantes

```text
92740a0 fix: make playback follow one transport clock
9f138d2 docs: add stabilization session handoff
3c3e840 test: exclude unsupported Node releases
b0ea9a0 test: align harness Node runtime
c02cb84 test: serialize Playwright workers
995193b test: bootstrap studio verification harness
370dfa0 docs: plan editor stabilization implementation
c183390 docs: design editor stabilization
```

Este novo handoff deve ser commitado separadamente, sem incluir os dois arquivos modificados acima.

## Verificacoes ja aprovadas antes da segunda rodada de qualidade

No commit `92740a0`:

- suite completa: 28/28 testes;
- typecheck: PASS;
- build: PASS;
- `git diff --check`: PASS;
- review de especificacao: aprovado;
- worktree estava limpa antes de iniciar a segunda rodada de qualidade.

## Por que a segunda rodada existe

O review de qualidade encontrou os seguintes Important:

1. `StandbySeeker` podia permanecer armado depois que um slot standby virava ativo.
2. promises antigas de `play()` podiam envenenar uma sessao nova, Pause ou unmount.
3. readiness global aceitava eventos atrasados de slots standby e usava metadata insuficiente.
4. hidratacao contornava o estado `loading`.
5. bloqueios por paths ausentes nao apareciam no TransportBar.
6. falhas de overlay ativo eram silenciosas.

Os itens 4 e 5 ja foram corrigidos e commitados em `92740a0`.

Os itens 1, 2, 3 e 6, mais a remocao do sync duplicado de overlay, estao nos dois arquivos modificados e nao commitados.

## Estado exato dos testes nao commitados

Comando executado imediatamente antes deste handoff:

```powershell
npm test -- tests/components/PreviewCanvas.transport.test.tsx --reporter=verbose
```

Resultado:

```text
Test Files  1 failed (1)
Tests       2 failed | 15 passed (17)
```

Passando no arquivo completo:

- playhead nao avanca enquanto os dois `play()` base estao pendentes;
- AbortError tardio apos Play/Pause e ignorado;
- rejeicao obsoleta apos nova sessao e ignorada;
- resultados obsoletos apos unmount/troca de source sao ignorados;
- readiness exige future data e dimensoes positivas no par ativo;
- erro de standby nao bloqueia par ativo saudavel;
- erro do par ativo fica sticky contra metadata tardia;
- troca de source inicia novo ciclo loading -> ready;
- erros reais de screen e face pausam e mostram razao;
- erro/rejeicao de overlay ativo pausa e mostra razao;
- overlay fora da janela nao bloqueia;
- overlay ativo sincroniza exatamente uma vez por frame;
- rejeicao atual real de base continua visivel.

Falhas restantes:

### 1. Rapid double cut

```text
PreviewCanvas transport > disarms promoted standby seekers across a rapid double cut
tests/components/PreviewCanvas.transport.test.tsx:271
expected screen slot 2, received screen slot 0
```

Nao corrigir o teste por conveniencia. Investigar se a rotacao real deveria chegar ao slot 2 no timestamp controlado ou se o scheduler/teste nao executou o segundo cut na ordem correta. Confirmar a semantica half-open e a identidade do slot desenhado.

### 2. Monotonic swap

```text
PreviewCanvas transport > uses one monotonic clock through play, seek, and a discontinuous swap
tests/components/PreviewCanvas.transport.test.tsx:560
playImpl.mock.contexts nao contem media.screen[1]
```

Investigar a ordem das promises e do hot swap. O teste deve provar que os dois elementos promovidos recebem `play()`; nao enfraquecer para verificar apenas `currentTime`.

Observacao: no checkpoint anterior havia uma terceira falha agregada de overlay rejection, mas a ultima execucao completa mostrou esse teste passando. Restam somente as duas falhas acima.

## Como continuar

1. Ler integralmente este handoff e o handoff de 2026-08-21.
2. Ler o design e o plano autoritativos.
3. Usar `subagent-driven-development`, `systematic-debugging` e TDD.
4. Despachar um implementador focado somente nos dois testes restantes e nos dois arquivos modificados.
5. Encontrar a causa de cada falha agregada antes de alterar producao ou expectativa.
6. Rodar o arquivo Preview inteiro ate 17/17 PASS.
7. Rodar:

```powershell
npm test -- tests/unit/transport-clock.test.ts tests/unit/media-sync.test.ts tests/components/TransportBar.test.tsx tests/components/PreviewCanvas.transport.test.tsx tests/components/useProjectPersistence.test.tsx
npm test
npm run typecheck
npm run build
git diff --check
```

8. Como este handoff foi commitado depois de `92740a0`, nao usar `git commit --amend` no commit de transporte. Criar um commit focado para os dois arquivos:

```powershell
git add -- app/repurpose-studio/_components/PreviewCanvas.tsx tests/components/PreviewCanvas.transport.test.tsx
git commit -m "fix: harden transport media lifecycle"
```

9. Repetir primeiro review de especificacao e depois review de qualidade sobre todo o range desde `9f138d2` ate o novo HEAD. Corrigir e revisar novamente qualquer Critical/Important.
10. Somente apos aprovacao, marcar Task 2 concluida e iniciar Task 3.

## Servidores e URL

- O servidor original na porta 3000 nao foi encerrado nem alterado.
- A worktree foi iniciada temporariamente na porta 3001, mas o dev server foi encerrado porque `npm run build` e `next dev` compartilham `.next` e causaram HTTP 500 por `routes-manifest.json` ausente.
- Depois de concluir todos os builds da Task 2, iniciar novamente:

```powershell
npm run dev -- --port 3001
```

- Confirmar HTTP 200 antes de entregar ao usuario:

```text
http://localhost:3001/repurpose-studio
```

- Nao rodar `npm run build` enquanto o dev server da mesma worktree estiver ativo.

## Regras de seguranca

- Nao trabalhar em `main`.
- Nao descartar os dois arquivos modificados.
- Nao usar `git reset --hard`, `git checkout --` ou `npm audit fix --force`.
- Nao encerrar o servidor original da porta 3000.
- Nao sobrescrever `C:\Users\oslan\Downloads\IMG_6849.MOV`.
- Preservar originals; proxy/compatibility sao derivados.
- Export nunca usa previewPath.

## Proxima tarefa depois da Task 2

Task 3: `Stream selected videos into immutable local originals`.

Nao inicia-la antes dos dois reviews finais da Task 2 estarem aprovados.
