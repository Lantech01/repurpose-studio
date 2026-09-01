# Repurpose Studio compatibility locking handoff — 2026-08-23

## Resume command

Open PowerShell in:

```powershell
cd "C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor"
```

Then tell Codex:

```text
continue pelo handoff de compatibility locking de 2026-08-23
```

## Safety and workspace

- Worktree: `C:\Users\oslan\.config\superpowers\worktrees\repurpose-studio\fix-stabilize-editor`
- Branch: `fix/stabilize-editor`
- WIP base HEAD: `95328627755db883aee822dcbf1aef6011cd048e` (`docs: checkpoint compatibility stabilization`).
- This handoff is committed separately from the WIP. The two code/test files below must remain uncommitted and must not be cleaned or reset.
- Do not clean, reset, restore, stash, delete, merge, push, or remove this worktree without separate authorization.
- Do not overwrite `C:\Users\oslan\Downloads\IMG_6849.MOV`.
- Port 3000 belongs to another process and must remain untouched.
- Port 3001 was free when this handoff was created.
- No recent Node process from this worktree remained after the interrupted test/subagent turn.
- Follow `AGENTS.md`, the stabilization plan, TDD, systematic debugging, subagent-driven implementation, spec review, quality review, and verification-before-completion.

## Worktree state at checkpoint

The worktree intentionally contains an incomplete, uncommitted Task 5 locking revision:

```text
 M lib/repurpose/compatibility-cache.server.ts
 M tests/server/compatibility-cache.test.ts
```

Diff against the WIP base when the handoff was created:

```text
lib/repurpose/compatibility-cache.server.ts | 184 +++++++++++++--
tests/server/compatibility-cache.test.ts     | 341 +++++++++++++++++++++++++++-
2 files changed, 506 insertions(+), 19 deletions(-)
```

`git diff --check` produced no whitespace errors; it printed only the existing LF-to-CRLF warnings.

Do not treat this diff as approved or green. It contains work from several RED→GREEN review loops plus a final architectural locking round that is not finished.

## Task 5 review history completed before the current partial round

The original four Important findings from the previous handoff were confirmed and fixed with deterministic tests:

1. fresh GET/HMR instance reconciles shared lock/final state;
2. cancellation in the `ownsLock()` to hard-link window cannot publish;
3. reaper revalidates heartbeat/staleness under its claim;
4. sweep recovers dead/stale locks before eviction.

A later anti-pattern review found and the implementer addressed three more issues:

1. local jobs short-circuit before shared synchronous filesystem reads;
2. GET-only instances do not report dead/stale locks as `building` and trigger safe reaping;
3. replacement publication waits behind an eviction maintenance owner.

At that earlier point, evidence was:

- focused compatibility tests: 50/50 passed;
- full Vitest suite: 160/160 passed;
- typecheck, focused ESLint, `git diff --check`, and build passed;
- real HEVC conversion/cache-reuse smoke passed;
- real Display Matrix rotation smoke passed;
- `npm run verify` still exited 1 only because `playwright.config.ts` points at the not-yet-created `tests/e2e` directory from Task 10 (`Error: No tests found`).

Those results are stale after the current architectural WIP and must be rerun.

## Why Task 5 is still in progress

Re-reviews found three further lifecycle/coordination risks:

### A. Valid reuse during eviction

`evictFinal()` could revalidate an old final, then pause before `rm`. In that window another instance could validate/reuse the same final and return `ready`; the sweep would then delete it.

Read-only reproduction from the spec reviewer:

```text
reusedStatus: ready
finalExists: false
stateAfterSweep: none
```

The current WIP introduces lock-first shared-state/reuse behavior. Test currently present:

```text
does not expose or reuse a valid final while an eviction claim can still delete it
```

The first version of this test hung because its barrier was not released from `finally`; an assertion failure left a 2 ms polling timer alive. That harness bug was diagnosed. There was no residual Node/npm process afterward.

The rerun with strict timeouts terminated in about 0.33 seconds with exit 1 and no hang. The functional assertion already observed `building` during the claim. The remaining failure was temporary trace instrumentation recording operations after the `finally` released the barrier.

At interruption, the trace appeared to have been removed from the file, but the test had not been rerun to establish formal GREEN. Start here.

Exact first command:

```powershell
npm test -- tests/server/compatibility-cache.test.ts -t "does not expose or reuse" --reporter=verbose --testTimeout=5000 --teardownTimeout=1000
```

The test must finish promptly and pass without diagnostic-only assertions or leaked handles. A hang is not a RED or GREEN.

### B. Maintenance lease expiry / ABA

Confirmed by architectural tracing but no RED was written in the interrupted final round:

- a maintenance owner can exceed `2 * lockStaleMs` without heartbeat;
- another process can reap it and acquire the shared lock;
- an old unconditional `releaseLock(lockPath)` can remove the new owner's lock;
- eviction must not remove a final after losing ownership.

Required next work:

1. write a deterministic RED that expires/reaps the maintenance claim, installs a new owner, and reaches the old `finally`;
2. prove the old owner cannot remove the new owner lock or mutate the final after losing ownership;
3. implement/verify maintenance heartbeat plus PID/token-safe release/fencing as one coherent invariant;
4. ensure all heartbeat handles are cleared in `finally` and no test leaks timers.

### C. GET-only polling containment

Confirmed as a real performance/availability concern, but no RED was written in the interrupted final round:

- the local-job short-circuit is green;
- GET without a local job can still perform repeated synchronous filesystem reads on every poll;
- a fresh GET-only instance must nevertheless reconcile another worker's lock/final state.

Proposed invariant from the interrupted architecture review:

- memoize only `building` for a short, bounded TTL;
- never memoize `ready` in a way that hides eviction/publication changes;
- keep reconciliation bounded and ensure one bad/large internal file cannot block indefinitely;
- preserve the public synchronous `get()` contract unless a wider design review explicitly approves changing it.

Required next work: write the smallest deterministic RED proving repeated GET-only polling is bounded/memoized while fresh reconciliation still works, then implement the minimal coherent behavior.

## Architectural invariants agreed before interruption

- Lock-first for shared state that may be concurrently evicted or published.
- Reuse participates in the same ownership/claim protocol as publishers and the sweeper.
- Publisher and sweeper mutate only while their PID/token lease remains valid.
- Maintenance work has heartbeat when it can outlive the stale threshold.
- Release is conditional on the current PID/token; never unlink a shared lock by pathname alone after ownership can change.
- Eviction is fenced to the scanned file identity (`dev`, `ino`, `size`, `mtime`) while ownership is valid.
- A replacement waits for eviction and publishes only after the maintenance claim is released.
- Short memoization may reduce GET-only polling I/O only for `building`; do not cache `ready` across filesystem changes.

If these invariants cannot be satisfied without a larger redesign, stop as `BLOCKED` and request an architecture decision instead of stacking another local fix.

## Exact resume sequence

1. Read this handoff and `AGENTS.md` completely.
2. Confirm branch, HEAD, worktree status, and diff. Preserve both modified files exactly; do not reset or clean.
3. Confirm no worktree-owned test process remains and port 3001 is free.
4. Inspect the current test at `tests/server/compatibility-cache.test.ts` around `does not expose or reuse a valid final...`.
5. Run the strict-timeout A command above. Fix only the test harness if diagnostic instrumentation remains; establish a real GREEN without weakening the behavioral assertions.
6. Execute B with systematic debugging and TDD RED→GREEN.
7. Execute C with systematic debugging and TDD RED→GREEN.
8. Self-review the full cumulative diff for deadlocks, ABA, heartbeat cleanup, token-safe release, sync I/O containment, public contract stability, and test-only instrumentation.
9. Run focused compatibility tests, full suite, typecheck, focused ESLint, `git diff --check`, build, real HEVC/cache-reuse smoke, and real Display Matrix smoke.
10. Repeat spec review, anti-pattern check, independent verification, then formal code-quality review. Fix and re-review until no Critical/Important findings remain.
11. Only after all approvals, delegate the Task 5 commit. Do not start Task 6 before Task 5 has spec and quality approval.

## Remaining stabilization plan

- Task 5: still in progress at locking/fencing review.
- Tasks 6–12: not started in this resumed session.
- Final scope remains the plan in `docs/superpowers/plans/2026-08-21-repurpose-studio-stabilization.md`.

Do not merge, push, delete the worktree, or touch the port-3000 process without separate authorization.
