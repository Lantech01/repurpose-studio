# ADR: One authoritative process per compatibility cache

- **Status:** Accepted
- **Date:** 2026-08-24
- **Approved by:** User on 2026-08-24

## Context

Task 5 attempted to make compatibility-cache publication, release, and eviction safe across independent Node processes. On Node v24.14.1 on Windows, a check of a lock token or file identity followed by `rm(path)` has an unavoidable pathname ABA window: the checked pathname can be replaced before deletion. Node exposes no unlink-by-handle, `unlinkat`, `renameat`, or `flock` primitive with which to close that window.

Four deterministic regressions exposed one supported-topology defect and three unsupported-topology races:

1. a malformed lock causes a busy spin (fixed; the regression is enabled);
2. an old owner release removes a replacement lock;
3. in-flight eviction removes a replacement final;
4. a scan-time orphan becomes active and is then deleted.

The malformed-lock regression remains enabled to protect bounded local recovery. Only the final three REDs remain skipped as evidence that multiprocess and external-writer cache ownership is unsupported; they must not be silently weakened into a claim of cross-process safety.

## Decision

The supported topology is exactly one authoritative Repurpose Studio Node server process per normalized compatibility cache directory.

- Concurrent server processes sharing one cache directory are unsupported.
- Shared or network compatibility-cache directories and external writers are unsupported.
- HMR or module reload within the authoritative process must reuse one process-global cache instance and active-job registry. Reload must not create competing owners or a duplicate ffmpeg conversion.
- "One job per fingerprint" and cancellation by any observer cancelling the shared job are guaranteed within that authoritative process and cache instance only.
- A lock whose owner PID is alive is never preempted solely because its heartbeat timestamp exceeded a threshold. Return an actionable cache-busy/restart state and permit temporary cache overage rather than perform a destructive takeover.
- Dead-process artifacts are recovered at startup or the next cache operation. A partial or final is never exposed as Ready without validation.
- Validated output is atomically published. Immutable originals are never modified or deleted by compatibility-cache work.
- GET, project reopen reconciliation, and export preparation must detect a missing final. Task 6 rebuilds a missing converted master from its existing original; Task 10 verifies reopen and export behavior.
- The 30-day TTL and 20 GiB cap remain policy, but maintenance defers while a live owner blocks safe mutation.
- The implementation makes no claim of linearizable cross-process release, publication, reuse, or eviction.

This ADR supersedes the cross-process locking and fencing invariants in the historical [2026-08-23 compatibility locking handoff](../handoffs/2026-08-23-repurpose-studio-compatibility-locking-handoff.md), including pathname-based PID/token release and eviction fencing. The handoff remains unchanged as a historical checkpoint.

## Alternatives considered

- **Native Win32 Node-API addon:** Native handle-based fencing could close the Windows pathname race, but adds ABI, build, signing, packaging, and platform-specific maintenance costs. It is deferred while the single-process local topology meets the product need.
- **Immutable generation protocol:** Unique generation paths plus an immutable manifest could avoid replacement ABA, but require a broader persistence, migration, garbage-collection, and recovery redesign. It is deferred beyond stabilization.
- **Dedicated coordinator:** A separate process could serialize conversion and maintenance for all clients, but adds IPC, coordinator lifecycle, crash recovery, and deployment complexity. It is unnecessary for the approved local topology.

If multiprocess or shared-cache support, desktop worker processes, or a field incident requires a wider topology later, reopen this ADR and choose native handle fencing, immutable generation paths, or a dedicated coordinator before implementation.

## Consequences and safety boundary

- Cache correctness guarantees are process-scoped. Operators must use distinct normalized cache directories for independent server processes.
- A live but wedged owner can require a server restart, and safe maintenance may temporarily exceed TTL or capacity targets.
- Dead owners remain recoverable, and validated atomic publication preserves usable cache entries without risking immutable originals.
- Unsupported topology is rejected or deferred safely rather than approximated with stale-timeout takeover.

## Implementation acceptance criteria

- Task 5 installs one process-global cache instance and active-job registry per normalized cache directory and proves HMR/module reload cannot duplicate ffmpeg work.
- Task 5 proves global observer cancellation and one job per fingerprint within that instance.
- Task 5 never reaps a live PID due only to heartbeat age, fails or defers safely when another live owner is present, and recovers dead or malformed artifacts at startup or the next operation.
- Every Ready response validates that the expected final still exists and satisfies the media contract; successful output is atomically published from a validated partial.
- Eviction preserves the 30-day/20 GiB policy but defers mutation when live ownership makes it unsafe.
- Tests cover live-owner busy/restart behavior, dead-owner recovery, invalid and missing finals, atomic publication, HMR singleton reuse, de-duplication, cancellation, and maintenance deferral under the supported topology.

## Downstream impact

- **Task 6:** Reconciliation treats a missing converted master as rebuildable when the immutable original remains, and blocks Ready until the replacement is validated.
- **Task 8:** Proxy orchestration must not introduce a second server or external cache writer; any process-level job registry follows the same HMR singleton lifetime.
- **Task 10:** Reopen and export tests exercise missing-final detection and prove export preparation uses a present, validated full-quality working source rather than a proxy or stale Ready state.
- **Task 12:** QA records the one-process topology, verifies the real HEVC workflow under it, and reports multiprocess/shared-cache operation as unsupported rather than unverified safety.
