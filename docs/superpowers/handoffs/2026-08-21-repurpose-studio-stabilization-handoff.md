# Repurpose Studio — Documento de Retomada

Data: 2026-08-21
Status: trabalho pausado com segurança porque o usuário vai mudar de rede

## Objetivo atual

Estabilizar o Repurpose Studio local de ponta a ponta:

- importar H.264 e HEVC/H.265 em MP4/MOV;
- corrigir Play, Pause, seek, scrub e sincronismo;
- preservar o original e usar um master H.264 compatível quando necessário;
- usar proxy 540p somente na prévia;
- persistir e reabrir projetos;
- integrar o engine SFX offline;
- exportar MP4 válido com vídeo, narração, música e SFX;
- verificar tudo no Chrome e com ffprobe, inclusive com o arquivo real `IMG_6849.MOV`.

Não adicionar API externa, Whisper/OpenAI, cloud, redesign ou as seis skills do repositório `leadgenman-video-skills` nesta fase.

## Repositórios e branch

Repositório principal, que deve permanecer em `main`:

```text
C:\Users\oslan\Projects\repurpose-studio
```

Worktree isolado onde todo o trabalho deve continuar:

```text
C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor
```

Branch:

```text
fix/stabilize-editor
```

Servidor original:

```text
http://localhost:3000
```

Esse servidor foi iniciado a partir do repositório principal. Não encerrá-lo nem usá-lo para os testes do worktree. Playwright e desenvolvimento do worktree usam a porta `3001`.

## Documentos autoritativos

- Design aprovado: `docs/superpowers/specs/2026-08-21-repurpose-studio-stabilization-design.md`
- Plano aprovado: `docs/superpowers/plans/2026-08-21-repurpose-studio-stabilization.md`
- Este handoff: `docs/superpowers/handoffs/2026-08-21-repurpose-studio-stabilization-handoff.md`

O plano recebeu revisão documental independente e foi aprovado depois de corrigir:

- recuperação de compatibility master removido pelo cache;
- proxy para footage, Files e overlays;
- teste de `currentTime` real em seek/cortes;
- prova por PCM de que música e SFX entram no export.

## Decisões do usuário

- Escopo recomendado A: estabilizar o app existente.
- Execução local, sem API externa nesta fase.
- Conversão inteligente: usar original quando Chrome realmente decodifica; converter HEVC somente quando necessário.
- Worktree global isolado.
- Execução recomendada por subagentes, com revisão de especificação e de qualidade após cada tarefa.
- Colocar para funcionar primeiro; melhorias com API ficam para depois.

## Arquivo real de aceitação

```text
C:\Users\oslan\Downloads\IMG_6849.MOV
```

Já verificado:

- arquivo saudável;
- HEVC/H.265;
- 3840x2160;
- aproximadamente 60 fps;
- Chrome lê duração/cabeçalho, mas retorna dimensões 0x0 e não decodifica;
- H.264 de controle funciona.

Esse arquivo deve ser usado novamente na Task 12.

## Histórico de commits relevante

```text
c183390 docs: design editor stabilization
370dfa0 docs: plan editor stabilization implementation
995193b test: bootstrap studio verification harness
c02cb84 fix/test config: serialize Playwright with workers: 1
b0ea9a0 fix/test runtime: pin Node-20-compatible jest-dom and engine contract
3c3e840 fix/test metadata: reject unsupported Node 23
```

Use `git log --oneline -8` para confirmar os hashes/mensagens exatos. Os três últimos commits são correções de revisão da Task 1.

## Progresso do plano

### Task 1 — concluída e aprovada

Infraestrutura criada:

- Vitest + jsdom + Testing Library;
- Playwright com Chrome instalado, porta 3001 e `workers: 1`;
- fixtures determinísticos H.264, HEVC, vídeo sem áudio, overlay em vídeo/PNG, música WAV, mídia inválida e SRT;
- smoke test real de `timelineToSourceTime`;
- scripts `typecheck`, `test`, `test:e2e`, `fixtures:media` e `verify`;
- documentação `TESTING.md` e `AGENTS.md`;
- workflow Ubuntu com ffmpeg/libx265;
- artefatos gerados ignorados pelo Git.

Verificações aprovadas:

- `npm run fixtures:media`;
- hashes idênticos em duas gerações locais;
- ffprobe: fixture MOV = HEVC, 320x180, 30 fps, 3 s;
- ffprobe: fixture MP4 = H.264/AAC, 320x180, 30 fps, 3 s;
- smoke test: 1/1 PASS;
- `npm run typecheck`: PASS;
- `npm run build`: PASS;
- `git diff --check`: PASS;
- `npm install --engine-strict`: PASS;
- revisão de especificação: aprovada;
- revisão de qualidade: aprovada, sem Critical/Important.

Contrato Node atual:

```text
^20.19.0 || ^22.13.0 || >=24.0.0
```

Observação menor da revisão: `TESTING.md` diz “Node 22.13.x”, embora `^22.13.0` permita versões posteriores do Node 22. É apenas documentação conservadora e não bloqueia.

### Tasks 2–12 — pendentes

Próxima tarefa:

```text
Task 2 — Replace playback timing with one tested transport clock
```

Depois:

1. upload local em streaming;
2. inspeção ffprobe e probe real do Chrome;
3. compatibility masters H.264 canceláveis;
4. orquestração/persistência de original, working e preview;
5. pipeline em todos os imports;
6. proxies 540p para todos os vídeos;
7. engine SFX offline;
8. reopen/export em qualidade integral;
9. atualizações de segurança;
10. QA exaustivo e aceite com `IMG_6849.MOV`.

## Como retomar em uma nova sessão

Começar com:

```powershell
Set-Location 'C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor'
git status --short
git branch --show-current
git log --oneline -8
```

Resultado esperado:

- branch `fix/stabilize-editor`;
- worktree limpo depois do commit deste handoff;
- HEAD contendo `3c3e840` e o commit do handoff.

Ler integralmente, nesta ordem:

1. `docs/superpowers/handoffs/2026-08-21-repurpose-studio-stabilization-handoff.md`
2. `docs/superpowers/specs/2026-08-21-repurpose-studio-stabilization-design.md`
3. `docs/superpowers/plans/2026-08-21-repurpose-studio-stabilization.md`
4. `C:\Users\oslan\.agents\skills\subagent-driven-development\SKILL.md`
5. `C:\Users\oslan\.agents\skills\test-driven-development\SKILL.md`

Atualizar o plano de execução marcando Task 1 como concluída e Task 2 como em andamento. Despachar um implementador novo somente para a Task 2, fornecendo o texto completo da tarefa no prompt. Não mandar o subagente ler o arquivo do plano. Após o commit:

1. revisão de conformidade com a especificação;
2. corrigir e revisar novamente se necessário;
3. revisão de qualidade;
4. corrigir Critical/Important e revisar novamente;
5. somente então iniciar Task 3.

## Estado conhecido do ambiente

- Windows + PowerShell.
- Node atual funciona com o contrato acima.
- Python 3.12 disponível.
- `uv` 0.11.2 disponível.
- ffmpeg e ffprobe disponíveis.
- Google Chrome instalado.
- `npm install` concluído no worktree.
- build inicial e build da Task 1 passaram.
- dependências ainda apresentam advisories altos preexistentes; resolver apenas na Task 11 sem usar `npm audit fix --force`.

## Repositórios externos analisados

`leadgenman-video-skills`:

- contém seis workflows/skills para agente;
- não está integrado ao app;
- permanece fora do escopo desta estabilização.

`soundeffects-claude-code`:

- contém 12 WAVs e um mixer Python/pydub;
- o script original não aceita `--events-json`;
- a Task 9 copiará somente os 12 WAVs, a licença MIT e uma adaptação mínima do mixer;
- não copiar Whisper nem adicionar OpenAI.

## Regras de segurança/escopo

- Não trabalhar em `main`.
- Não apagar o worktree.
- Não encerrar o servidor da porta 3000.
- Não sobrescrever `IMG_6849.MOV` nem qualquer mídia original.
- Não usar `git reset --hard`, `git checkout --`, `npm audit fix --force` ou remoções amplas.
- Compatibility master e proxy são caches derivados e publicados atomicamente.
- Export sempre usa `workingPath` de qualidade integral, nunca `previewPath`.
- Preservar qualquer mudança do usuário que apareça no worktree.

## Critério de término

Não considerar o trabalho concluído até:

- H.264 importar sem transcode;
- `IMG_6849.MOV` converter e tocar;
- Play/Pause/seek/cortes funcionarem repetidamente;
- captions, overlays, music e SFX aparecerem na prévia e no export;
- projeto salvar/reabrir;
- export abrir no Chrome;
- ffprobe confirmar vídeo/áudio/duração;
- análise PCM provar narração + música + SFX;
- testes, typecheck, build e QA passarem sem erros inesperados no console;
- relatório final existir em `.gstack/qa-reports/repurpose-studio-stabilization-2026-08-21/`.
