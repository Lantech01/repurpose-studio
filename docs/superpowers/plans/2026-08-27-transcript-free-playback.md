# Transcript-Free Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a new project playable and persistable after both Screen and Face videos are imported, without requiring a transcript.

**Architecture:** Represent transcript-free footage with one normal full-span bootstrap clip, using the shorter inspected source duration. Synchronize only an empty or structurally pristine bootstrap timeline, preserve overlay history, and let the existing transcript ingest replace that baseline. Extend existing onboarding, demo guards, and project naming rather than introducing a second clipless playback mode.

**Tech Stack:** Next.js 15, React, TypeScript, Zustand, Vitest, Testing Library, Playwright.

---

### Task 1: Bootstrap A Real Video Timeline

**Files:**
- Create: `tests/unit/video-timeline-bootstrap.test.ts`
- Modify: `lib/repurpose/store.ts:80-99, 801-825, 1342-1361, 1685-1712`

- [ ] **Step 1: Write failing store tests**

Cover these observable behaviors through `setFootageMeta` and store actions:

```ts
expect(oneSourceState.clips).toEqual([]);
expect(twoSourceState.clips).toMatchObject([
  {
    id: "video-full-span",
    srcStart: 0,
    srcEnd: 8,
    timelineStart: 0,
    timelineEnd: 8,
    kept: true,
  },
]);
expect(twoSourceState.duration).toBe(8);
```

Use source durations `12` and `8` to prove the shorter duration wins, then reverse their roles. Add cases for zero/invalid duration, transcript/existing timeline preservation, pristine re-import resizing, overlay preservation, and Undo/Redo snapshots retaining the bootstrap timeline. Exercise trim, split, duplicate, delete, and reorder independently to prove a structurally or temporally edited timeline is not resized. Exercise `setClipSplitRatio` to prove a non-temporal style survives safe resize in both current clips and pristine history snapshots.

- [ ] **Step 2: Run the new test and observe RED**

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts`

Expected: FAIL because `setFootageMeta` stores source durations but leaves `clips=[]` and `duration=0`.

- [ ] **Step 3: Add the minimal store synchronization**

In `store.ts`:

- Add a stable `video-full-span` bootstrap clip builder.
- Derive an effective duration only when both `faceCamSource` and `screenSource` have finite positive inspected durations.
- Add `syncVideoTimeline(previousMeta)` to the store contract and invoke it after normalized footage metadata is installed.
- Initialize only when `words` and `clips` are empty.
- Resize only when the current clip and history snapshot have the bootstrap id and still span the previous effective duration.
- Map empty/pristine `past` and `future` snapshots to the synchronized clip without creating a history entry or changing overlays.
- Keep `setClips` unchanged so later transcript ingest remains the authoritative replacement path.

- [ ] **Step 4: Run store tests GREEN**

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts`

Expected: all bootstrap, history, re-import, and edit-protection tests pass.

### Task 2: Make Source Setup Transcript-Optional

**Files:**
- Modify: `app/repurpose-studio/_components/SourcesPanel.tsx:209-346, 398-525, 548-620`
- Modify: `tests/components/SourcesPanel.test.tsx:86-318`
- Modify: `tests/components/TransportBar.test.tsx:164-179`

- [ ] **Step 1: Write failing component tests**

Add assertions that:

- Empty and one-source projects ask for both Screen and Face rather than a transcript.
- Playback reason precedence is missing source paths, then media loading/error, then timeline duration.
- Onboarding says the transcript is optional.
- Source setup collapses after both usable paths exist even when `words=[]`.
- Importing Screen and Face creates the shorter full-span clip.
- Existing transcript-derived clips are not replaced.
- Importing a raw transcript after bootstrap replaces `video-full-span` with transcript-derived clips and words.
- Demo backfill applies only when current paths match the staged manifest.
- An in-flight source import prevents delayed demo auto-load from writing words, clips, or footage.

- [ ] **Step 2: Run component tests and observe RED**

Run: `npx vitest run tests/components/SourcesPanel.test.tsx tests/components/TransportBar.test.tsx`

Expected: FAIL on transcript-first copy/readiness and permissive demo guards.

- [ ] **Step 3: Implement source-first guidance and demo guards**

In `SourcesPanel.tsx`:

- Remove `words.length > 0` from `footageReady`.
- Replace transcript-first onboarding with copy that asks for Screen and Face and describes raw transcript as optional automatic editing.
- For legacy word backfill, fetch the staged manifest and require exact Screen and Face path matches before applying staged words.
- Immediately before demo auto-load writes, abort if clips, footage metadata, or either source import owner is present.
- Preserve project-epoch and stale-import guards already in place.

In `store.ts`, reorder `getPlaybackBlockedReason` to check missing source paths first, media loading/error second, and timeline duration last. Update `TransportBar.test.tsx` so an empty timeline without sources exposes the source-selection reason, loading/error wins over zero duration when both paths exist, and two ready paths with no valid timeline return the duration reason.

- [ ] **Step 4: Run component tests GREEN**

Run: `npx vitest run tests/components/SourcesPanel.test.tsx tests/components/TransportBar.test.tsx`

Expected: all tests pass.

### Task 3: Persist And Reopen A Transcript-Free Project

**Files:**
- Modify: `app/repurpose-studio/_components/naming.ts:38-80`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts:73, 2084-2109, 2467-2469`
- Modify: `tests/components/project-persistence.test.tsx:966-1000, 1923-1944`

- [ ] **Step 1: Write failing naming and creation tests**

In the persistence suite, create a provisional state with empty words, a synthesized clip, and both source records. Assert that one create POST occurs with a title based on Screen `originalName`, strips only the final extension, removes path/control characters, collapses whitespace, and routes to the dated slug. Assert the create/save snapshot contains `video-full-span`, its nonzero duration, and `words=[]`.

Add a Face-first-then-Screen case proving no create occurs after Face alone and Screen still supplies the final title. Add a Face fallback case where both sources and the bootstrap are ready but Screen has no usable sanitized title. Retain a no-title/no-source case that does not retry. Finally hydrate the created transcript-free snapshot and assert its bootstrap clip, duration, source records, and empty words are restored unchanged.

- [ ] **Step 2: Run the persistence test and observe RED**

Run: `npx vitest run tests/components/project-persistence.test.tsx`

Expected: FAIL because both creation gates call only `deriveShortTitle(words)`.

- [ ] **Step 3: Implement one shared title resolver**

Add a shared title resolver in `naming.ts` with transcript-first and Screen-then-Face filename precedence. At both creation gates, allow its source-derived branch only when both sources and the `video-full-span` bootstrap timeline are present; this prevents the first Face import from permanently naming the project before Screen arrives.

```ts
return deriveShortTitle(words) ?? (
  hasPlayableVideoBootstrap(clips, footageMeta)
    ? titleFromOriginalName(footageMeta?.screenSource?.originalName)
      ?? titleFromOriginalName(footageMeta?.faceCamSource?.originalName)
    : null
);
```

Use it in both `createProjectFromStore` and `attemptCreate`. Keep `datedSlug` and collision handling unchanged.

- [ ] **Step 4: Run persistence tests GREEN**

Run: `npx vitest run tests/components/project-persistence.test.tsx`

Expected: all tests pass, including provisional no-content deferral and existing save conflict behavior.

### Task 4: End-To-End Verification

**Files:**
- Modify only if a failure exposes a requirement gap.

- [ ] **Step 1: Run fixture generation required by `AGENTS.md`**

Run: `npm run fixtures:media`

- [ ] **Step 2: Run focused regression suites**

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts tests/components/SourcesPanel.test.tsx tests/components/TransportBar.test.tsx tests/components/project-persistence.test.tsx`

- [ ] **Step 3: Verify the real browser flow on port 3001**

Create a disposable provisional project, import Screen and Face without a transcript, assert the project receives a nonzero timeline, Play advances, and the route becomes a persisted filename-derived project. Reopen that route, assert `words=[]`, the synthesized duration remains nonzero, and Play advances again. Delete only that disposable project afterward.

- [ ] **Step 4: Run the complete gate without a conflicting dev server**

Stop only this worktree's listener on port `3001`, leave port `3000` untouched, and run: `npm run verify`.

Expected: typecheck, Vitest, Playwright, and production build all pass.

- [ ] **Step 5: Restore and inspect local state**

Restart `npm run dev -- --port 3001`, confirm the app returns HTTP 200, confirm only the protected original and showcase projects remain, run `git diff --check`, and report all uncommitted files. Do not commit or deploy unless explicitly requested.
