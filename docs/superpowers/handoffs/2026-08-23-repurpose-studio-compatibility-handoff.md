# Repurpose Studio stabilization handoff — 2026-08-23

## Resume command

Open PowerShell in:

```powershell
cd "C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor"
```

Then tell the next Codex session:

```text
continue pelo handoff de 2026-08-23
```

## Safety and workspace

- Worktree: `C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor`
- Branch: `fix/stabilize-editor`
- Do not clean, reset, delete, merge, push, or remove this worktree without separate authorization.
- Do not overwrite `C:\Users\oslan\Downloads\IMG_6849.MOV`.
- Port 3000 belongs to another process and must remain untouched.
- The Repurpose Studio preview was healthy on port 3001 at `http://localhost:3001/repurpose-studio` (HTTP 200). If the terminal/session closes, start it again only after confirming port 3001 is free:

```powershell
npm run dev -- --port 3001
```

- Do not run `next build` while the 3001 dev server is active. Stop only that server before a build gate, then restart it and confirm HTTP 200.
- Follow `AGENTS.md`, the stabilization plan, TDD, systematic debugging, subagent-driven implementation, spec review, quality review, and verification-before-completion.

## Completed work

- Task 1: baseline and deterministic media fixtures — complete.
- Task 2: PreviewCanvas transport/media lifecycle — complete and approved.
- Task 3: immutable streamed local originals — complete and approved. Final simplification commit: `1e496eb fix: make original publication atomic`.
- Task 4: ffprobe inspection and browser decodability probe — complete and approved. Commits:
  - `7b22b4d feat: inspect codecs and verify browser decodability`
  - `bab2224 fix: harden media inspection boundaries`
- Task 5 core implementation — committed:
  - `631e94e feat: create reusable H264 compatibility masters`
  - `33bda906591fee5ed8f97bd24b94dab51a3a34cf fix: harden compatibility master lifecycle`

Latest verified Task 5 evidence before the final re-review:

- Focused compatibility tests: 43/43 passed.
- Full suite: 153/153 passed.
- Typecheck passed.
- Focused ESLint passed.
- `git diff --check` passed.
- Real HEVC smoke: HEVC -> H.264/yuv420p, 320x180, 30 fps, AAC, 3 seconds; cache reuse passed.
- Real 90-degree Display Matrix smoke preserved coded dimensions and rotation.
- Port 3001 returned HTTP 200; port 3000 was untouched.

## Current task and exact resume point

Task 5 is still **in progress** because the final quality re-review of `33bda906` found four candidate Important lifecycle gaps. The reviewer had confirmed 43/43 focused tests, typecheck, diff-check, and a clean worktree, then reported these issues:

1. `compatibility-cache.server.ts:588-595`: `get()` consults only the local in-memory `Map`. A fresh HMR/worker instance receiving only GET returns `none` during or after another instance's job. It must reconcile filesystem lock/final state on GET.
2. `compatibility-cache.server.ts:528-529,482-489`: cancellation can arrive while `publish()` awaits `ownsLock()` after the last signal check and still publish. Recheck the job signal immediately before the atomic final link/publication, with a deterministic barrier test.
3. `compatibility-cache.server.ts:319-327`: `reapLock` validates token/PID but does not revalidate staleness after acquiring the reaper claim. If the owner heartbeat renews in that window, the live lock can still be reaped. Re-read owner heartbeat/staleness under the claim before retiring it.
4. `compatibility-cache.server.ts:434-437`: sweep treats any non-terminal lock as active, including dead/stale locks, so a crashed owner can pin a final beyond TTL/20 GiB. Active protection must require a valid live/fresh owner; dead/stale locks need safe recovery before eviction.

The reviewer had not yet delivered the final formatted report when this handoff was written. On resume, obtain/confirm that final report if available, then send all confirmed Important findings back to the same Task 5 implementer (or a replacement if unavailable). Add RED tests first, apply minimal fixes, run focused/full/typecheck/focused lint/diff-check and the real HEVC/rotation smokes, commit separately, and repeat quality review until there are no Critical/Important issues.

Do not start Task 6 until Task 5 receives both spec and quality approval. Task 5 spec review already passed at `631e94e`; rerun/reconfirm spec only if the lifecycle fixes alter the public contract.

## Remaining plan

- Task 6: orchestrate import and persist original/working/preview identities.
- Task 7: use the compatibility pipeline in every video entry point.
- Task 8: generalize and harden the 540p preview proxy.
- Task 9: harden the rendering/export engine.
- Task 10: deterministic rendering/export coverage.
- Task 11: dependency and application gates.
- Task 12: complete quality gate and real HEVC end-to-end audit.

At final completion, follow `verification-before-completion`, stop only the 3001 server for build/verify when required, restart it, confirm HTTP 200, and do not merge/push/delete the worktree without separate authorization.
