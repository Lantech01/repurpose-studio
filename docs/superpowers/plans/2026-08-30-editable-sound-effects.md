# Editable Sound Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generated full-length SFX bed with editable automatic and manual SFX clips that support import, overlap, timeline editing, persistence, synchronized preview, and deterministic export.

**Architecture:** A versioned catalog and pure `sfx-clips` domain module become the shared authority for source identity, timing, trim, gain, and fades. The Zustand document stores independent clips while project inventory stores imported assets; timeline, preview, and export consume the same normalized model. Existing `SfxTrack` snapshots migrate to one legacy clip, and new generation maps planner events directly to built-in clips without rendering a bed.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Zustand, Web Audio API, Canvas timeline, Mediabunny export, Vitest, Testing Library, Playwright, Python/pydub legacy SFX renderer.

---

## File Structure

### New files

- `scripts/sfx-engine/sfx-catalog.json`: shared, versioned metadata for the 12 vendored sounds.
- `lib/repurpose/sfx-clips.ts`: pure clip normalization, placement, timing, fades, replacement, duplication, regeneration, and migration.
- `lib/repurpose/sfx-source.ts`: resolve built-in, imported, and legacy sources to stable identities and URLs.
- `lib/repurpose/sfx-audio.ts`: shared cancellable source loading, decoded-buffer peak analysis, and sample-boundary helpers.
- `lib/repurpose/sfx-ingest-client.ts`: cancellable project-owned SFX upload and duration probe.
- `app/repurpose-studio/_components/SfxClipBlock.tsx`: one accessible timeline SFX block.
- `tests/unit/sfx-clips.test.ts`: pure document and timing contracts.
- `tests/unit/sfx-store.test.ts`: SFX actions, history, selection, and gesture ownership.
- `tests/unit/sfx-audio.test.ts`: PCM normalization and sample-boundary contracts.
- `tests/components/SfxClipBlock.test.tsx`: block accessibility and direct controls.
- `tests/components/useSfxPreview.test.tsx`: scheduler, cache, overlap, rate, and cancellation.
- `tests/unit/export-short-sfx.test.ts`: deterministic per-clip export mixing.
- `tests/integration/sfx-catalog.test.ts`: JSON, TypeScript, Python, and on-disk asset agreement.
- `tests/e2e/editable-sfx.spec.ts`: complete editor, persistence, regeneration, and export acceptance.

### Existing files to modify

- `lib/repurpose/types.ts`: add `SfxClip`/`SfxAsset`; retain `SfxTrack` only for migration.
- `lib/repurpose/sfx-effects.ts`: derive approved keys and helpers from the catalog.
- `lib/repurpose/store.ts`: editable SFX document, inventory, selection, actions, and gestures.
- `lib/repurpose/projects.ts`: protect migrated legacy WAV references.
- `lib/repurpose/export-short.ts`: mix independent SFX clips.
- `lib/repurpose/sfx-placement.ts`: keep planner output aligned with catalog keys.
- `scripts/sfx-engine/build_sfx_track.py`: read the shared catalog for retained legacy rendering.
- `app/api/repurpose/sfx/route.ts`: serve built-ins by allow-listed key while retaining legacy paths.
- `app/repurpose-studio/_components/SfxPanel.tsx`: generation, import, library, audition, and inspector.
- `app/repurpose-studio/_components/Timeline.tsx`: overlapping blocks, drops, move/trim gestures, and shortcuts.
- `app/repurpose-studio/_components/timeline-utils.ts`: SFX mini-lane packing constants/helpers.
- `app/repurpose-studio/_components/useSfxPreview.ts`: replace single-bed playback with clip scheduling.
- `app/repurpose-studio/_components/PreviewCanvas.tsx`: pass clips/assets and surface source errors.
- `app/repurpose-studio/_components/useProjectPersistence.ts`: serialize, hydrate, and migrate SFX.
- `app/repurpose-studio/_components/RepurposeEditor.tsx`: own import cancellation and pass export inputs.
- `SETUP.md`: document that editable built-ins do not require Python rendering.
- Existing SFX, persistence, timeline, transcript, editor, integration, and E2E tests listed below.

## Shared Invariants

- SFX is authored in output time and does not ripple when scenes move; duration reductions remove or destructively trim out-of-range clips in the same Undo transaction.
- `sfxClips` is editable history; `sfxAssets` is passive project inventory outside Undo history.
- Derived URLs, lanes, waveforms, decoded buffers, audition, selection, generation, and gesture state are never persisted.
- All SFX document mutations invalidate pending automatic generation.
- Preview and export use the same source identities, source range, target normalization, fade math, and `Math.round(seconds * sampleRate)` sample boundaries.
- Port `3001` is used for Playwright and local verification; port `3000` is never disturbed.
- Run `npm run fixtures:media` before media-consuming tests and `npm run verify` before completion.

### Task 1: Shared Catalog and Pure Clip Model

**Files:**
- Create: `scripts/sfx-engine/sfx-catalog.json`
- Create: `lib/repurpose/sfx-clips.ts`
- Modify: `lib/repurpose/sfx-effects.ts`
- Modify: `lib/repurpose/types.ts:451-482,593-643`
- Modify: `scripts/sfx-engine/build_sfx_track.py:16-30,89-101`
- Create: `tests/unit/sfx-clips.test.ts`
- Create: `tests/integration/sfx-catalog.test.ts`
- Modify: `tests/integration/sfx-engine.test.ts`
- Modify: `tests/integration/sfx-planner-contract.test.ts`

- [ ] **Step 1: Write failing catalog and type tests**

Assert all 12 keys, categories, filenames, measured durations, first-second usable durations, and target amplitudes. Assert planner and Python engine keys exactly match the JSON catalog.

Place `// @vitest-environment node` at the top of the Node-only catalog integration test.

```ts
expect(SFX_CATALOG.whoosh).toMatchObject({
  category: "Transition",
  sourceDuration: 2.188479167,
  targetAmplitude: 0.3,
});
expect(defaultBuiltInDuration("whoosh")).toBe(1);
```

- [ ] **Step 2: Run the catalog tests and verify RED**

Run: `npm test -- tests/integration/sfx-catalog.test.ts tests/integration/sfx-engine.test.ts tests/integration/sfx-planner-contract.test.ts`

Expected: FAIL because the shared catalog and helpers do not exist.

- [ ] **Step 3: Add the catalog and derive existing key contracts from it**

Store `displayName`, `category`, `filename`, `sourceDuration`, and `targetAmplitude` for every built-in. Load the same JSON in TypeScript and Python; remove duplicate filename and click/whoosh gain maps while preserving the Python renderer's one-second truncation and peak normalization.

- [ ] **Step 4: Add failing pure clip tests**

Cover valid/invalid normalization, start-inclusive/end-exclusive resolution, source trim, left/right trim semantics, placement at the reel end, move clamping, duration shrink, replacement, duplication fallback, automatic/manual partitioning, proportional fades, mute, and legacy migration.

```ts
expect(resolveSfxClipAt(clip, 3.5, 10, 1, 0.4)).toMatchObject({
  active: true,
  sourceTime: 0.5,
  effectiveGain: 0.4,
});
```

- [ ] **Step 5: Run the pure tests and verify RED**

Run: `npm test -- tests/unit/sfx-clips.test.ts`

Expected: FAIL because `SfxClip`, `SfxAsset`, and the pure helpers do not exist.

- [ ] **Step 6: Implement the approved types and pure helpers**

Add `SfxClipOrigin`, the three-way `SfxClipSource` union, `SfxAsset`, `SfxClip`, and optional snapshot arrays. Implement `sfxClipTimelineEnd`, `effectiveSfxFadeDurations`, `resolveSfxClipAt`, normalization, move/trim, placement, replacement, duplication, duration constraint, generated-event mapping, automatic replacement, and legacy migration in `sfx-clips.ts`.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `npm test -- tests/unit/sfx-clips.test.ts tests/integration/sfx-catalog.test.ts tests/integration/sfx-engine.test.ts tests/integration/sfx-planner-contract.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the domain foundation**

```bash
git add scripts/sfx-engine/sfx-catalog.json scripts/sfx-engine/build_sfx_track.py lib/repurpose/sfx-effects.ts lib/repurpose/sfx-clips.ts lib/repurpose/types.ts tests/unit/sfx-clips.test.ts tests/integration/sfx-catalog.test.ts tests/integration/sfx-engine.test.ts tests/integration/sfx-planner-contract.test.ts
git commit -m "feat: define editable sfx clip model"
```

### Task 2: Source Resolution and Secure Built-In Serving

**Files:**
- Create: `lib/repurpose/sfx-source.ts`
- Create: `lib/repurpose/sfx-audio.ts`
- Modify: `app/api/repurpose/sfx/route.ts:30-65,227-268,630-778`
- Create: `tests/unit/sfx-audio.test.ts`
- Modify: `tests/server/sfx-route.test.ts`

- [ ] **Step 1: Write failing source and route tests**

Cover built-in/imported/legacy identity and URL resolution, missing imported inventory, all approved key requests, HEAD, full GET, prefix/open/suffix ranges, `416`, unknown keys, mixed `key`+`path`, path traversal, realpath containment, and no installation-path disclosure. Keep `// @vitest-environment node` at the top of the route test.

Also cover PCM peak analysis over all channels, silent/non-finite rejection,
target/base gain, imported/legacy base gain `1`, and
`secondsToSample(seconds, rate) = Math.round(seconds * rate)`.

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm test -- tests/server/sfx-route.test.ts tests/unit/sfx-audio.test.ts`

Expected: FAIL because `?key=` and the shared audio loader do not exist.

- [ ] **Step 3: Implement pure source resolution**

Return `{ identity, url, sourceDuration, targetAmplitude, missing }`. Built-ins use `built-in:<key>` and `/api/repurpose/sfx?key=...`; imported sources require the exact matching inventory item; legacy sources retain generated-path semantics.

- [ ] **Step 4: Implement cancellable source loading and analysis**

Add a shared browser helper that fetches the resolved stable URL with an
`AbortSignal`, decodes it through an injected `BaseAudioContext`, analyzes the
usable built-in excerpt, and returns `{ buffer, sourceBaseGain }`. It must reject
HTTP, decode, silent, and non-finite failures. Keep caching policy outside this
primitive so generation can validate operation ownership while preview can cache
by source identity.

- [ ] **Step 5: Extend the GET/HEAD route without weakening legacy security**

Require exactly one of `key` or `path`. Resolve built-in filenames only through the catalog and prove realpath containment under `ENGINE_DIR/sfx`. Reuse byte-range response logic, but do not register built-ins in generated-file leases or cache sweeps. Keep POST rendering and generated `?path=` behavior for legacy compatibility.

- [ ] **Step 6: Run route, audio, engine, and type tests**

Run: `npm test -- tests/server/sfx-route.test.ts tests/unit/sfx-audio.test.ts tests/integration/sfx-engine.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit secure source serving**

```bash
git add lib/repurpose/sfx-source.ts lib/repurpose/sfx-audio.ts app/api/repurpose/sfx/route.ts tests/unit/sfx-audio.test.ts tests/server/sfx-route.test.ts
git commit -m "feat: serve built-in sound effects"
```

### Task 3: Editable Store, Selection, and History

**Files:**
- Modify: `lib/repurpose/store.ts:145-302,951-1120,1833-2180,2265-3029,3359-3821,4491-4515`
- Create: `tests/unit/sfx-store.test.ts`
- Modify: `tests/unit/transcript-application.test.ts`

- [ ] **Step 1: Write failing store document tests**

Test IDs, add/move/trim/gain/fade/mute/replace/duplicate/delete, automatic replacement preserving manual clips, asset inventory outside history, selection mutual exclusion, no-op behavior, and duration shrink in the same Undo snapshot.

- [ ] **Step 2: Write failing gesture ownership tests**

Test begin/update/end/cancel for move, trim, gain, and fades; one history entry per long gesture; no history below threshold/no-op; cancellation restoring clips plus history; stale token rejection; and Undo/Redo/project replacement cancelling active gestures.

- [ ] **Step 3: Run store tests and verify RED**

Run: `npm test -- tests/unit/sfx-store.test.ts tests/unit/transcript-application.test.ts`

Expected: FAIL because the store still exposes a single `sfxTrack` outside history.

- [ ] **Step 4: Add SFX document and inventory state with a temporary bridge**

Add `sfxClips`, `sfxAssets`, `selectedSfxClipId`, `sfxGenerating`, and a
monotonic `sfxDocumentRevision`. Add `sfxClips` to `EditableSnapshot`; keep
assets and transient state out. Retain deprecated runtime `sfxTrack` and its
three actions temporarily so the not-yet-migrated panel, timeline, preview, and
export continue to typecheck and play existing beds between tasks. During this
bridge only, `setSfxTrack` must also replace the automatic legacy clip while
preserving manual clips, `setSfxGain` must mirror gain into that legacy clip, and
`clearSfxTrack` must remove the mirrored automatic legacy clip. This keeps old
panel writes and new document state equivalent before the atomic consumer
migration begins. New clip actions do not attempt to render a reverse
compatibility WAV. Extend ID reseeding with independent clip/asset counters.
Task 8 removes the bridge after every consumer has migrated.

- [ ] **Step 5: Implement discrete actions and selection ownership**

Every effective SFX edit commits history and increments `sfxDocumentRevision`. Selecting SFX clears clip, overlay, multi-overlay, caption, and word selections; selecting any real competing object clears SFX selection. Clear dangling SFX selection after Undo/Redo.

- [ ] **Step 6: Implement explicit SFX gestures**

Follow overlay gesture rollback patterns. `closeActiveHistoryGestures` must cancel SFX. A new SFX gesture cancels competing gestures, snapshots original clips and history, and accepts updates only from its owner token.

- [ ] **Step 7: Integrate duration constraints**

Call the pure duration constraint in every transaction that changes output duration, including clip edits, word edits, timeline synchronization, and transcript rebuild. Stop unconditionally clearing SFX on rebuild; preserve output-time clips except for deterministic end trimming/removal.

- [ ] **Step 8: Run store regression tests and typecheck**

Run: `npm test -- tests/unit/sfx-store.test.ts tests/unit/transcript-application.test.ts tests/unit/overlay-transform-gesture.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit editable state**

```bash
git add lib/repurpose/store.ts tests/unit/sfx-store.test.ts tests/unit/transcript-application.test.ts
git commit -m "feat: add editable sfx history"
```

### Task 4: Persistence, Migration, and Cache Retention

**Files:**
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts:185-249,873-1008,1288-1330`
- Modify: `lib/repurpose/projects.ts:409-449`
- Modify: `tests/components/project-persistence.test.tsx`
- Modify: `tests/server/sfx-project-references.test.ts`

- [ ] **Step 1: Write failing serialization and migration tests**

Assert new snapshots write normalized `sfxClips`/`sfxAssets` and omit `sfxTrack`; `sfxClips: []` is authoritative; malformed entries are isolated; missing imported inventory remains visible as unavailable; IDs reseed; and old tracks migrate with identical duration/gain.

- [ ] **Step 2: Write failing project-reference tests**

Assert both old `snapshot.sfxTrack.sourcePath` and migrated `source.kind === "legacy"` paths protect generated WAVs. Cover dedupe, malformed fail-closed behavior, and save/sweep races.

- [ ] **Step 3: Run persistence tests and verify RED**

Run: `npm test -- tests/components/project-persistence.test.tsx tests/server/sfx-project-references.test.ts`

Expected: FAIL because snapshots and reference scans only understand `sfxTrack`.

- [ ] **Step 4: Implement serialization and hydration**

Persist plain source references only. Normalize built-ins from catalog duration and imported/legacy clips from persisted structural duration. Derive URLs at use time. Migrate only when `sfxClips === undefined`; preserve old gain and create one automatic legacy block. During the temporary bridge, serialize a non-null runtime `sfxTrack` as that legacy clip when `sfxClips` is still empty, and rehydrate `sfxTrack` only from a sole automatic legacy clip so old consumers remain functional. Delete this adapter in Task 8 after panel, timeline, preview, and export use clips.

- [ ] **Step 5: Protect migrated legacy cache files**

Extend project reference scanning before new snapshots stop writing `sfxTrack`. Imported and built-in sources must not enter generated-cache path protection. Preserve the current reference lock and fail-closed semantics.

- [ ] **Step 6: Run persistence and server tests**

Run: `npm test -- tests/components/project-persistence.test.tsx tests/server/sfx-project-references.test.ts tests/server/sfx-route.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit persistence and migration**

```bash
git add app/repurpose-studio/_components/useProjectPersistence.ts lib/repurpose/projects.ts tests/components/project-persistence.test.tsx tests/server/sfx-project-references.test.ts
git commit -m "feat: persist and migrate editable sfx"
```

## Atomic Consumer Migration Gate

Tasks 5 through 8 are one atomic vertical migration. They must be executed
consecutively in the same worktree without running the app for user work and
without committing Tasks 5, 6, or 7 separately. Their focused tests provide
incremental feedback, but the only Git checkpoint is Task 8 after panel,
timeline, preview, export, persistence, and store all consume `sfxClips` and the
temporary `sfxTrack` bridge is removed. This avoids any committed state where a
user can edit clips while preview or export still reads a stale bed.

### Task 5: Project-Owned Import and SFX Workspace Panel

**Files:**
- Create: `lib/repurpose/sfx-ingest-client.ts`
- Rewrite: `app/repurpose-studio/_components/SfxPanel.tsx`
- Modify: `app/repurpose-studio/_components/RepurposeEditor.tsx:180-225,500-550`
- Modify: `tests/components/SfxPanel.test.tsx`
- Modify: `tests/components/RepurposeEditor.test.tsx`

- [ ] **Step 1: Write failing import and panel tests**

Cover `.wav`/`.mp3`/`.m4a`, rejected extensions, upload/probe failure with no partial state, stale project cancellation, add at playhead/end clamp, categories/search, one-at-a-time audition, unmount cleanup, add built-in/imported, and missing media.

- [ ] **Step 2: Write failing generation ownership tests**

Assert planner events become separate automatic clips, regeneration preserves manual clips, automatic replacements become manual, empty/failure is atomic, missing/corrupt/silent/undecodable built-ins commit nothing, and any intervening SFX revision invalidates a pending generation even after edit-then-Undo.

- [ ] **Step 3: Run panel tests and verify RED**

Run: `npm test -- tests/components/SfxPanel.test.tsx tests/components/RepurposeEditor.test.tsx`

Expected: FAIL because the panel only renders and controls one bed.

- [ ] **Step 4: Implement cancellable ingest**

Reuse the existing stable `/api/repurpose/asset` upload and metadata probe pattern. Capture project id/epoch and requested placement before awaiting. On success, add one inventory item and one manual clip; on any failure/cancel, add neither. Re-imports remain distinct.

- [ ] **Step 5: Implement generation without POST rendering**

Use `planSfxEvents` plus catalog metadata to build clips in memory. Resolve the
unique planned built-ins and validate each through the cancellable
`sfx-audio.ts` fetch/decode/peak helper before one
`replaceAutomaticSfxClips` commit. This asynchronous preflight is the ownership
boundary: abort it on project/panel lifecycle changes, and compare operation
token plus `sfxDocumentRevision` after every awaited load. Keep the old
automatic collection unchanged until all sources validate.

- [ ] **Step 6: Build the library and selected-effect inspector**

Add import, search, category groups, audition, add-at-playhead, and draggable entries. Add gain, source in/out, fade in/out, mute, duplicate, replace, and delete for the selected clip. Slider gestures use explicit store transactions.

- [ ] **Step 7: Run panel/editor tests and typecheck**

Run: `npm test -- tests/components/SfxPanel.test.tsx tests/components/RepurposeEditor.test.tsx`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Keep the panel migration uncommitted and continue immediately**

Do not run the application for user work and do not commit this partial state.
Continue directly to Task 6; timeline, preview, and export have not all migrated
yet.

### Task 6: Timeline Blocks, Mini-Lanes, Drops, and Gestures

**Files:**
- Create: `app/repurpose-studio/_components/SfxClipBlock.tsx`
- Modify: `app/repurpose-studio/_components/Timeline.tsx:150-330,930-1030,1060-1100,1505-1562`
- Modify: `app/repurpose-studio/_components/timeline-utils.ts:90-150`
- Create: `tests/components/SfxClipBlock.test.tsx`
- Modify: `tests/components/Timeline.primary-actions.test.tsx`
- Create: `tests/unit/timeline-utils.test.ts`

- [ ] **Step 1: Write failing block and lane tests**

Test focus, `aria-selected`, accessible name with origin/range/mute, waveform slice, missing state, trim handles, and deterministic `packLanes` for touching/overlapping/tied intervals.

- [ ] **Step 2: Write failing timeline interaction tests**

Test body move, left/right trim, 4px activation threshold, snapping, one release commit, pointer cancellation rollback, dynamic row height, internal library drop, external file drop at captured time, and empty-row selection clearing.

- [ ] **Step 3: Write failing keyboard precedence tests**

Prove Delete/Backspace and Ctrl/Cmd+D target only SFX when SFX is selected, never also a scene/word/overlay, and never fire from an editable control. Verify focus after replace/duplicate/delete.

- [ ] **Step 4: Run timeline tests and verify RED**

Run: `npm test -- tests/components/SfxClipBlock.test.tsx tests/components/Timeline.primary-actions.test.tsx`

Expected: FAIL because the timeline renders one full-width bed.

- [ ] **Step 5: Implement presentational blocks and mini-lanes**

Use derived `[timelineStart, timelineEnd)` intervals and existing `packLanes`; do not store lanes. Resolve each source URL for waveform/missing state. Make row height depend on lane count.

- [ ] **Step 6: Implement move/trim gestures and snapping**

Freeze clip id, source range, timeline start, pointer id, and snap anchors. Start a store gesture only after threshold, update transiently, end once on pointer-up, and cancel on pointer-cancel/unmount/store signal.

- [ ] **Step 7: Implement internal/external drops and keyboard ownership**

Custom drag payloads carry only a built-in key or imported asset id, never paths. External files use the shared ingest owner. Add SFX edges to snap targets without changing overlay/video drop behavior.

- [ ] **Step 8: Run timeline regressions and typecheck**

Run: `npm test -- tests/components/SfxClipBlock.test.tsx tests/components/Timeline.primary-actions.test.tsx tests/unit/timeline-utils.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Keep timeline changes uncommitted and continue immediately**

Do not run the application for user work and do not commit this partial state.
Continue directly to Task 7; export still reads the legacy bed.

### Task 7: Shared Audio Analysis and Preview Scheduler

**Files:**
- Modify: `lib/repurpose/sfx-audio.ts`
- Rewrite SFX portion: `app/repurpose-studio/_components/useSfxPreview.ts:1-224`
- Modify: `app/repurpose-studio/_components/PreviewCanvas.tsx:540-550`
- Modify: `tests/unit/sfx-audio.test.ts`
- Create: `tests/components/useSfxPreview.test.tsx`

- [ ] **Step 1: Extend audio tests for preview cache behavior**

Retain the source-load, peak, and sample-boundary tests from Task 2. Add cache
tests proving repeated identities share one pending/decoded result while a
failed or aborted load is not retained as a successful entry.

- [ ] **Step 2: Write failing scheduler tests**

Mock Web Audio and test decode dedupe, already-active source offsets, future start delay `(timelineStart - playhead) / playbackRate`, source-node playback rate, fade automation scaled by rate, overlaps, pause/seek/rate/edit cancellation, stale decode suppression, and node disconnect cleanup.

- [ ] **Step 3: Run audio tests and verify RED**

Run: `npm test -- tests/unit/sfx-audio.test.ts tests/components/useSfxPreview.test.tsx`

Expected: FAIL because preview still accepts one `SfxTrack` and has no scheduler
cache.

- [ ] **Step 4: Implement shared decode analysis**

Build a preview-owned cache around the Task 2 loading primitive, keyed by
authoritative identity. Analyze built-ins over their usable first second and
return `targetAmplitude / peak`; use `1` for imported/legacy. Keep asynchronous
state outside persistence and Undo.

- [ ] **Step 5: Implement the clip scheduler**

Create independent source/gain nodes per active/future clip, apply source trim and linear fades, permit overlap, and tear down obsolete schedules on every transport/document ownership boundary. Leave `useMusicPreview` behavior unchanged.

- [ ] **Step 6: Wire preview errors without mutating document state**

Pass `sfxClips` and `sfxAssets` from `PreviewCanvas`. Surface unavailable names non-destructively; do not silently substitute sources.

- [ ] **Step 7: Run preview tests and typecheck**

Run: `npm test -- tests/unit/sfx-audio.test.ts tests/components/useSfxPreview.test.tsx`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Keep preview changes uncommitted and continue immediately**

Do not run the application for user work and do not commit this partial state.
Continue directly to Task 8, which completes and commits the atomic migration.

### Task 8: Deterministic Per-Clip Export

**Files:**
- Modify: `lib/repurpose/export-short.ts:140-190,530-550,1110-1145,1380-1510`
- Modify: `lib/repurpose/store.ts:1100-1120,2100-2170,3800-3830`
- Modify: `app/repurpose-studio/_components/RepurposeEditor.tsx:528-545`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts:185-249,873-1008`
- Create: `tests/unit/export-short-sfx.test.ts`
- Modify: `tests/unit/sfx-store.test.ts`
- Modify: `tests/components/export-audio-fallback.test.ts`
- Modify: `tests/components/project-persistence.test.tsx`
- Modify: `tests/integration/export-contract.test.ts`

- [ ] **Step 1: Write failing mixer tests**

Cover built-in/imported/legacy authoritative resolution, one decode per identity, mono/stereo and 44.1/48kHz inputs, exact sample offsets, source trims, target normalization, user gain, mute, proportional fades, overlap summing, and final clamp.

- [ ] **Step 2: Write failing atomic-error tests**

Assert any missing/undecodable selected SFX aborts with its display name, publishes no partial output, never uses a blob/preview URL, and still runs existing cleanup `finally` paths.

Also assert the runtime store no longer exposes `sfxTrack`, `setSfxTrack`,
`setSfxGain`, or `clearSfxTrack`, while persistence still migrates the read-only
legacy `ProjectSnapshot.sfxTrack` shape.

- [ ] **Step 3: Run export tests and verify RED**

Run: `npm test -- tests/unit/export-short-sfx.test.ts tests/components/export-audio-fallback.test.ts tests/integration/export-contract.test.ts`

Expected: FAIL because export accepts one best-effort `sfxTrack`.

- [ ] **Step 4: Replace export inputs and bed mixing**

Pass `sfxClips`/`sfxAssets`. Resolve all sources before mutating output, fetch/decode/resample each identity once, use shared sample boundaries and base-gain analysis, mix every clip into the assembled buffer, then apply existing final clamp.

After `SfxPanel`, `Timeline`, `PreviewCanvas`, persistence, `RepurposeEditor`, and
export all consume the clip model, remove deprecated runtime `sfxTrack`, its
actions, and the temporary persistence adapter introduced in Tasks 3-4. Retain
only the `SfxTrack` type and snapshot field as read-only legacy migration input.

- [ ] **Step 5: Run all atomic-migration focused tests and typecheck**

Run: `npm test -- tests/unit/sfx-store.test.ts tests/unit/sfx-audio.test.ts tests/unit/export-short-sfx.test.ts tests/unit/timeline-utils.test.ts tests/components/SfxPanel.test.tsx tests/components/SfxClipBlock.test.tsx tests/components/Timeline.primary-actions.test.tsx tests/components/useSfxPreview.test.tsx tests/components/export-audio-fallback.test.ts tests/components/project-persistence.test.tsx tests/components/RepurposeEditor.test.tsx tests/integration/export-contract.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the complete atomic consumer migration**

```bash
git add lib/repurpose/sfx-ingest-client.ts lib/repurpose/sfx-audio.ts lib/repurpose/export-short.ts lib/repurpose/store.ts app/repurpose-studio/_components/SfxPanel.tsx app/repurpose-studio/_components/SfxClipBlock.tsx app/repurpose-studio/_components/Timeline.tsx app/repurpose-studio/_components/timeline-utils.ts app/repurpose-studio/_components/useSfxPreview.ts app/repurpose-studio/_components/PreviewCanvas.tsx app/repurpose-studio/_components/RepurposeEditor.tsx app/repurpose-studio/_components/useProjectPersistence.ts tests/unit/sfx-store.test.ts tests/unit/sfx-audio.test.ts tests/unit/export-short-sfx.test.ts tests/unit/timeline-utils.test.ts tests/components/SfxPanel.test.tsx tests/components/SfxClipBlock.test.tsx tests/components/Timeline.primary-actions.test.tsx tests/components/useSfxPreview.test.tsx tests/components/export-audio-fallback.test.ts tests/components/project-persistence.test.tsx tests/components/RepurposeEditor.test.tsx tests/integration/export-contract.test.ts
git commit -m "feat: add editable sound effects workflow"
```

### Task 9: End-to-End Acceptance and Documentation

**Files:**
- Create: `tests/e2e/editable-sfx.spec.ts`
- Modify: `tests/e2e/editor-surfaces.spec.ts`
- Modify: `tests/e2e/export.spec.ts`
- Modify: `tests/e2e/helpers/audio-analysis.ts` if a new measurement helper is needed
- Modify: `tests/fixtures/generate-media.mjs` if deterministic impulse/tone audio is needed
- Modify: `SETUP.md`

- [ ] **Step 1: Generate deterministic media fixtures**

Run: `npm run fixtures:media`

Expected: fixture generation completes successfully before media tests.

- [ ] **Step 2: Write failing editor E2E acceptance**

Generate independent blocks; add/import/overlap; move/trim/fade/mute; replace/duplicate; regenerate while preserving manual clips; Undo/Redo; save/reload/hub-reopen; and assert new snapshots omit `sfxTrack`.

- [ ] **Step 3: Write failing legacy migration E2E**

Seed an old `sfxTrack`, reopen it as one legacy block with unchanged gain/timing, regenerate to separate clips, save, and reopen without the old field.

- [ ] **Step 4: Write failing export evidence**

Measure timing and amplitude for trim, fades, mute, overlap, and manual preservation. Confirm narration/music remain unchanged and SFX-only edits do not change 1080p/4K video pixels.

- [ ] **Step 5: Run focused E2E and fix only evidenced integration gaps**

Run: `npm run test:e2e -- tests/e2e/editable-sfx.spec.ts tests/e2e/editor-surfaces.spec.ts tests/e2e/export.spec.ts --workers=1`

Expected: PASS on port `3001`.

- [ ] **Step 6: Update setup documentation**

Document that Generate/Regenerate uses the built-in catalog directly and does not require `uv`; retain `uv sync --frozen --project scripts/sfx-engine` only for the legacy renderer/integration contract.

- [ ] **Step 7: Commit acceptance coverage**

```bash
git add tests/e2e/editable-sfx.spec.ts tests/e2e/editor-surfaces.spec.ts tests/e2e/export.spec.ts tests/e2e/helpers/audio-analysis.ts tests/fixtures/generate-media.mjs SETUP.md
git commit -m "test: verify editable sound effects workflow"
```

### Task 10: Full Regression Gate

**Files:**
- Modify only files implicated by failing evidence.

- [ ] **Step 1: Run focused SFX suites together**

Run: `npm test -- tests/unit/sfx-clips.test.ts tests/unit/sfx-store.test.ts tests/unit/sfx-audio.test.ts tests/unit/export-short-sfx.test.ts tests/components/SfxPanel.test.tsx tests/components/SfxClipBlock.test.tsx tests/components/useSfxPreview.test.tsx tests/components/Timeline.primary-actions.test.tsx tests/components/project-persistence.test.tsx tests/server/sfx-route.test.ts tests/server/sfx-project-references.test.ts tests/integration/sfx-catalog.test.ts tests/integration/sfx-engine.test.ts tests/integration/sfx-planner-contract.test.ts`

Expected: PASS.

- [ ] **Step 2: Run the complete verification gate**

Run: `npm run fixtures:media`

Run: `npm run verify`

Expected: TypeScript, all Vitest suites, all Playwright suites on port `3001`, and production build pass.

- [ ] **Step 3: Inspect the final diff and repository state**

Run: `git diff --check`

Run: `git status --short`

Run: `git log --oneline -10`

Expected: no whitespace errors; only intended files are modified; `.superpowers/` remains untracked and excluded.

- [ ] **Step 4: Commit any final evidence-based fixes**

```bash
git add <only-files-fixed-during-final-verification>
git commit -m "fix: complete editable sfx verification"
```

Skip this commit when Step 2 passes without additional changes.
