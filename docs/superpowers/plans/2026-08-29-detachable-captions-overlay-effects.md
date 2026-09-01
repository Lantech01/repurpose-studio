# Detachable Captions and Overlay Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one caption block detach vertically from the Face/Screen seam and add deterministic entrance/exit effects plus uniform rounded corners to image and video overlays.

**Architecture:** Pure shared layout/appearance resolvers separate persisted authoring values from frame-time visual values. Preview, selection geometry, hit-testing, and export consume the same resolvers; direct-manipulation transients remain outside persisted project state. Store actions own normalization, explicit gesture transactions, history, migration, duplication, and attribute clipboard behavior.

**Tech Stack:** Next.js 15, React 19, TypeScript, Zustand, Canvas 2D, Vitest, Testing Library, Playwright, existing WebCodecs/FFmpeg export pipeline.

**Specification:** `docs/superpowers/specs/2026-08-29-detachable-captions-overlay-effects-design.md`

**Session constraint:** Do not commit, push, deploy externally, or touch port `3000`. Preserve the current dirty worktree and run browser/Playwright work only on port `3001`.

---

## File Structure

### New files

- `lib/repurpose/overlay-effects.ts`: normalization, easing, effect-window allocation, and frame-time overlay appearance resolution.
- `tests/unit/overlay-effects.test.ts`: exhaustive pure resolver and normalization tests.
- `tests/components/CaptionDragLayer.test.tsx` only if the caption hit target is extracted from `PreviewCanvas`; otherwise keep the tests in `PreviewCanvas.transport.test.tsx` and do not create this file.

### Existing files with focused changes

- `lib/repurpose/types.ts`: optional persisted overlay effect/radius fields and appearance-aware attribute clipboard.
- `lib/repurpose/overlay-geometry.ts`: visual-to-persisted transform delta mapping that tolerates animated scale/position.
- `lib/repurpose/store.ts`: appearance mutations/transactions, caption attach/detach transactions, cancellation, history, duplicate/copy/paste behavior.
- `lib/repurpose/compositor.ts`: normalized corner-radius input and local rounded media clip.
- `lib/repurpose/captions.ts`: shared caption layout result consumed by drawing and hit-testing.
- `lib/repurpose/export-short.ts`: frame-time overlay resolver before compositor descriptors.
- `app/repurpose-studio/_components/useProjectPersistence.ts`: legacy overlay normalization and appearance round-trip.
- `app/repurpose-studio/_components/PreviewCanvas.tsx`: animated overlay descriptors and detachable-caption direct manipulation.
- `app/repurpose-studio/_components/useObjectSelection.ts`: animated visual hit-testing with persisted-delta writes.
- `app/repurpose-studio/_components/SelectionOverlay.tsx`: frame-time animated selection geometry.
- `app/repurpose-studio/_components/GhostOverflowLayer.tsx`: frame-time animated ghost geometry and rounded clipping.
- `app/repurpose-studio/_components/SelectionToolbar.tsx`: entrance, exit, direction, duration, radius, and preset controls.
- `app/repurpose-studio/_components/CaptionPanel.tsx`: explicit detach/attach controls and detached full-range position slider.
- Existing focused unit/component/E2E suites listed in each task.

---

### Task 0: Capture the dirty-worktree baseline

**Files:**
- Do not modify repository files.
- Create external evidence only under `C:\Users\oslan\AppData\Local\Temp\opencode`.

- [ ] **Step 1: Record repository identity and current changes**

Run: `git rev-parse HEAD`, `git branch --show-current`, `git status --short`, and `git diff --stat`.

Expected: branch `fix/stabilize-editor`; existing modified/untracked work is documented and must not be reverted.

- [ ] **Step 2: Save a binary patch of all current tracked and untracked changes outside the worktree**

First verify `C:\Users\oslan\AppData\Local\Temp\opencode` exists. Use a
temporary Git index so untracked files are included without touching the real
index or worktree:

```powershell
$env:GIT_INDEX_FILE = 'C:\Users\oslan\AppData\Local\Temp\opencode\repurpose-baseline.index'
git read-tree HEAD
git add -A
git diff --cached --binary --output=C:\Users\oslan\AppData\Local\Temp\opencode\repurpose-before-caption-overlay.patch HEAD
Remove-Item Env:\GIT_INDEX_FILE
```

Expected: the real `git status --short` is byte-for-byte unchanged, while the
external patch contains all non-ignored tracked and untracked baseline content.
Never apply this patch automatically and never use it to revert user work.

---

### Task 1: Overlay appearance contract and pure resolver

**Files:**
- Create: `lib/repurpose/overlay-effects.ts`
- Create: `tests/unit/overlay-effects.test.ts`
- Modify: `lib/repurpose/types.ts:288-399`

- [ ] **Step 1: Write failing normalization tests**

Cover missing legacy fields, malformed objects, all five effect types, duration clamp `[0.1, 2]`, Slide direction fallback `left`, ignored direction for non-Slide effects, and radius clamp `[0, 0.5]`.

```ts
expect(normalizeOverlayAppearance({})).toEqual({
  entranceEffect: { type: "none", durationSec: 0.35 },
  exitEffect: { type: "none", durationSec: 0.35 },
  cornerRadius: 0,
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run tests/unit/overlay-effects.test.ts`

Expected: FAIL because the module/types do not exist.

- [ ] **Step 3: Add the persisted types and normalization API**

Add `OverlayEffectType`, `OverlaySlideDirection`, `OverlayEffect`, optional `Overlay.entranceEffect`, `Overlay.exitEffect`, and `Overlay.cornerRadius`. Keep fields optional at the persistence boundary; normalize before authoring/rendering.

- [ ] **Step 4: Write failing effect-window and easing tests, then verify RED**

Test exact start/mid/end values for None, Fade, Zoom, Pop, and four Slide directions. Include one-sided effects, proportional scaling when requested durations exceed overlay life, zero/negative lifetime with no effect math, half-open `timelineEnd`, repeated paused calls, rotated AABB clearance, Screen/Face/Free overlays, and no mutation of input.

```ts
const atStart = resolveOverlayAppearanceAt(overlay, overlay.timelineStart, rect, 0.5);
expect(atStart.opacityMultiplier).toBe(0);
expect(atStart.transform.scale).toBeCloseTo(overlay.transform.scale * 0.75);
expect(overlay.transform).toEqual(originalTransform);
```

Run: `npx vitest run tests/unit/overlay-effects.test.ts`

Expected: FAIL on unresolved effect behavior before implementation.

- [ ] **Step 5: Implement the pure resolver minimally**

Implement the exact curves and proportional window allocation from the spec. Resolve the persisted transform against the frame-effective seam first, then apply ephemeral effect scale/translation. Return normalized radius and `interactive: false` when the band is hidden, the overlay is inactive, or opacity multiplier is `<= 0.01`.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npx vitest run tests/unit/overlay-effects.test.ts tests/unit/overlay-band-geometry.test.ts`

Run: `npm run typecheck`

Expected: all pass.

---

### Task 2: Overlay persistence, authoring actions, and history transactions

**Files:**
- Modify: `lib/repurpose/store.ts:867-940,1540-1625,2454-2852`
- Modify: `lib/repurpose/types.ts:295-312`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts:150-233,865-1072`
- Modify: `tests/unit/video-timeline-bootstrap.test.ts`
- Modify: `tests/components/project-persistence.test.tsx`
- Modify: `tests/components/useProjectPersistence.test.tsx`

- [ ] **Step 1: Write failing store tests for defaults and discrete setters**

New overlays must receive normalized defaults. Add typed actions for entrance, exit, and radius. Assert clamping, no-op suppression, one Undo step for dropdown changes, and restoration by Undo/Redo.

- [ ] **Step 2: Write failing explicit slider-transaction tests**

Model the split gesture token pattern rather than the 700 ms coalescing window:

```ts
const token = useRepurposeStore
  .getState()
  .beginOverlayAppearanceGesture(id, "cornerRadius");
useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.04);
useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.16);
useRepurposeStore.getState().endOverlayAppearanceGesture(token);
expect(useRepurposeStore.getState().past).toHaveLength(1);
```

Cover long gestures, stale tokens, no movement, pointer cancel restoring the initial value, Undo/Redo cancellation, project reset, and exactly one cancellation signal. Cancellation must restore the complete pre-gesture document value, `past`, and `future` arrays so a provisional first update neither leaves a phantom Undo entry nor destroys the prior Redo branch.

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts`

Expected: FAIL because the explicit transaction API is absent.

- [ ] **Step 3: Run store tests and verify RED**

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts`

Expected: FAIL on missing actions/defaults.

- [ ] **Step 4: Implement appearance actions and transaction lifecycle**

Keep closure-owned gesture tokens/listeners outside snapshots. Capture the
pre-gesture document value plus exact `past` and `future` arrays. Capture one
history entry on first effective update, not begin-time. Normal completion keeps
that entry; cancellation atomically restores the value and both history arrays,
including any prior Redo branch. Ensure every terminal path clears the token.
Project replacement, hydration, Undo/Redo, and a newer appearance gesture cancel
the old gesture before their own operation.

- [ ] **Step 5: Write failing duplicate and attribute clipboard tests**

Extend overlay clipboard data with normalized entrance, exit, radius, transform, and opacity. Assert duplicate preserves all values and paste affects visible selected overlays only without phantom history.

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts`

Expected: FAIL because clipboard/duplicate do not preserve appearance.

- [ ] **Step 6: Implement duplicate/copy/paste behavior**

Preserve current effective-primary and hidden-band rules. Deep-copy nested effect objects so duplicate/clipboard state cannot alias the source overlay.

- [ ] **Step 7: Write failing legacy hydration and round-trip tests**

Cover snapshots with no new fields, malformed values, valid authored values, save/reopen, and project replacement during an active slider gesture.

Run: `npx vitest run tests/components/project-persistence.test.tsx tests/components/useProjectPersistence.test.tsx`

Expected: FAIL on missing normalization and round-trip fields.

- [ ] **Step 8: Normalize in restore and snapshot paths**

`restoreOverlay` is the migration seam. Ensure persisted snapshots serialize normalized values while old snapshots retain their prior visual appearance: None, square corners.

- [ ] **Step 9: Run focused persistence/store suites**

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts tests/components/project-persistence.test.tsx tests/components/useProjectPersistence.test.tsx`

Expected: all pass.

---

### Task 3: Rounded compositor and preview/export effect parity

**Files:**
- Modify: `lib/repurpose/compositor.ts:217-240,495-539`
- Modify: `app/repurpose-studio/_components/PreviewCanvas.tsx:1339-1420`
- Modify: `lib/repurpose/export-short.ts:674-705,937-1004`
- Modify: `tests/unit/compositor-split.test.ts`
- Modify: `tests/unit/export-short-split.test.ts`
- Modify: `tests/components/PreviewCanvas.transport.test.tsx`

- [ ] **Step 1: Write failing compositor clipping tests**

Extend `OverlayDraw` with normalized corner radius. Record Canvas calls and assert:

- Radius `0` preserves the current draw path.
- Radius uses `cornerRadius * min(destW, destH)` and clamps to half the short side.
- Local rounded clip rotates/scales with media.
- Output-space Screen/Face clip still intersects it.
- `save`/`restore`, alpha, and transform remain balanced across multiple overlays and captions.

- [ ] **Step 2: Run compositor tests and verify RED**

Run: `npx vitest run tests/unit/compositor-split.test.ts`

Expected: FAIL because rounded clipping is absent.

- [ ] **Step 3: Implement the minimal rounded clip**

Do not allocate temporary canvases. Use a local rounded path before `drawImage`; retain the current output-space band clip and layer order.

- [ ] **Step 4: Write failing preview/export descriptor parity tests**

At entrance midpoint, settled time, exit midpoint, and end, assert PreviewCanvas and export pass identical resolved transform, opacity, radius, band, and source-time mapping. Include image/video, 1080p/4K, short overlays, scene transitions, and split endpoints.

Run: `npx vitest run tests/unit/export-short-split.test.ts tests/components/PreviewCanvas.transport.test.tsx`

Expected: FAIL because descriptors still use static authored appearance.

- [ ] **Step 5: Route preview and export through the shared resolver**

Resolve with output timeline time every frame. Do not alter video seek, playback rate, trim, source identity, or overlay muting.

- [ ] **Step 6: Verify focused rendering suites**

Run: `npx vitest run tests/unit/overlay-effects.test.ts tests/unit/compositor-split.test.ts tests/unit/export-short-split.test.ts tests/components/PreviewCanvas.transport.test.tsx`

Expected: all pass.

---

### Task 4: Animated overlay selection geometry and toolbar controls

**Files:**
- Modify: `lib/repurpose/overlay-geometry.ts:824-879`
- Modify: `app/repurpose-studio/_components/useObjectSelection.ts:227-575`
- Modify: `app/repurpose-studio/_components/SelectionOverlay.tsx:120-204`
- Modify: `app/repurpose-studio/_components/GhostOverflowLayer.tsx:111-202`
- Modify: `app/repurpose-studio/_components/SelectionToolbar.tsx:186-370,593-764`
- Modify: `tests/unit/overlay-band-geometry.test.ts`
- Modify: `tests/components/useObjectSelection.test.tsx`
- Modify: `tests/components/SelectionOverlay.test.tsx`
- Modify: `tests/components/GhostOverflowLayer.test.tsx`
- Modify: `tests/components/SelectionToolbar.test.tsx`

- [ ] **Step 1: Write failing visual-to-persisted mapping tests**

Freeze persisted and animated visual transforms at gesture start. Assert move/resize/rotate deltas update authored values without baking Slide offset, Zoom/Pop scale, dynamic seam correction, or effect opacity.

Use ratio-based scale mapping:

```ts
persistedScaleNext = persistedScaleStart *
  (desiredVisualScale / visualScaleAtGestureStart);
```

Run: `npx vitest run tests/unit/overlay-band-geometry.test.ts tests/components/useObjectSelection.test.tsx`

Expected: FAIL because animated scale/offset are not separated from authored deltas.

- [ ] **Step 2: Implement generalized delta mapping**

Preserve existing seam-only behavior and add zero/NaN guards. Keep keyboard nudges authored/settled rather than animation-derived.

- [ ] **Step 3: Write failing chrome, ghost, and hit-test tests**

Assert selection handles, toolbar target, rounded ghost, overlap preference, and pointer hit-testing follow the animated visual AABB. At opacity multiplier `<= 0.01`, the overlay is not interactive. Hidden-band rules still win.

Run: `npx vitest run tests/components/SelectionOverlay.test.tsx tests/components/GhostOverflowLayer.test.tsx tests/components/useObjectSelection.test.tsx`

Expected: FAIL because these surfaces still resolve only the static transform.

- [ ] **Step 4: Apply the shared frame-time appearance resolver**

Pass the current output time into the affected components/hooks. Keep toolbar field values bound to authored settings while rail position and handles follow visual geometry.

- [ ] **Step 5: Write failing toolbar control tests**

Cover accessible labels, five effects, conditional four-direction selector, duration limits/defaults, four radius presets, slider transaction begin/end/cancel, effective-primary targeting, hidden-only no-op, and Undo/Redo.

Run: `npx vitest run tests/components/SelectionToolbar.test.tsx`

Expected: FAIL because the appearance controls and transaction wiring are absent.

- [ ] **Step 6: Add compact toolbar groups**

Follow the existing dark vertical rail. Do not create a second inspector or general animation editor. Use `Entrada`, `Saida`, and `Cantos`; hide dormant controls that do not apply.

- [ ] **Step 7: Run focused interaction/UI suites**

Run: `npx vitest run tests/unit/overlay-band-geometry.test.ts tests/components/useObjectSelection.test.tsx tests/components/SelectionOverlay.test.tsx tests/components/GhostOverflowLayer.test.tsx tests/components/SelectionToolbar.test.tsx`

Expected: all pass with no React act warnings introduced.

---

### Task 5: Shared caption layout result

**Files:**
- Modify: `lib/repurpose/captions.ts:567-595,768-866,1166-1689`
- Modify: `tests/unit/caption-split-placement.test.ts`

- [ ] **Step 1: Write failing layout-result tests**

For every caption template, assert the shared result exposes:

- Active block and resolved style.
- Requested and final clamped anchor.
- Final translated full visual bounds.
- Valid anchor range.
- Attached candidate target at split `0`, intermediate split, and split `1`.
- Detached position independence from later split movement.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/unit/caption-split-placement.test.ts`

Expected: FAIL because layout geometry is private and drawing duplicates active-block resolution.

- [ ] **Step 3: Extract `resolveCaptionLayout` without changing pixels**

Use `activeCaptionBlockAt` as the single active-block lookup. Move existing private metrics/bounds/anchor calculations behind one exported result. Keep Canvas measurement as an injected context dependency, but perform no drawing in the resolver.

- [ ] **Step 4: Make `drawCaptions` consume and return the layout**

Existing callers may ignore the return. PreviewCanvas will retain the returned current-frame layout; export still invokes the same drawing function. Verify old pixel/placement tests remain byte-for-byte equivalent.

- [ ] **Step 5: Add transient block-position input**

Allow PreviewCanvas to provide one local `{ blockId, positionYPct }` override to layout/drawing without modifying blocks or store state. Export and persistence never pass this value.

- [ ] **Step 6: Run all caption unit suites**

Run: `npx vitest run tests/unit/caption-split-placement.test.ts tests/unit/export-short-split.test.ts tests/components/CaptionPanel.test.tsx`

Expected: all existing and new tests pass.

---

### Task 6: Caption attach/detach store contract and inspector

**Files:**
- Modify: `lib/repurpose/store.ts:1060-1080,1703-1735,2072-2098,3440-3519`
- Modify: `app/repurpose-studio/_components/CaptionPanel.tsx:95-204,503-690`
- Modify: `tests/components/CaptionPanel.test.tsx`
- Modify: `tests/unit/transcript-application.test.ts`
- Modify: `tests/components/useProjectPersistence.test.tsx`

- [ ] **Step 1: Write failing attach/detach action tests**

Add actions with exact semantics:

```ts
attachCaptionBlock(id)
// remove positionYPct/splitOffsetPct, set pinToSplit:true

detachCaptionBlock(id, positionYPct)
// remove splitOffsetPct, set pinToSplit:false, set clamped positionYPct
```

Assert unrelated overrides survive, missing/unchanged blocks create no history, explicit attachment survives global pin changes, and later global offset changes are inherited.

Run: `npx vitest run tests/components/CaptionPanel.test.tsx tests/unit/transcript-application.test.ts`

Expected: FAIL because explicit attach/detach actions do not exist.

- [ ] **Step 2: Write failing caption gesture-token tests**

Add begin/complete/cancel/cancellation-subscription lifecycle. The store writes once on completion, not pointer movement. Cover stale tokens, no-op, pointer cancel, exactly one Undo entry, Undo/Redo cancellation with empty and unrelated history, rebuild, transcript application, hydration, project replacement, and competing split gestures.

Run: `npx vitest run tests/unit/video-timeline-bootstrap.test.ts tests/components/PreviewCanvas.transport.test.tsx`

Expected: FAIL because the caption gesture lifecycle is absent.

- [ ] **Step 3: Implement the minimal caption transaction API**

Keep token/listener state closure-owned and absent from snapshots. Ensure terminal paths are idempotent. Starting split and caption gestures must cancel each other before publishing new transient ownership.

- [ ] **Step 4: Write failing CaptionPanel tests**

Attached block shows `Soltar legenda` and no absolute slider. Detached block shows requested-position slider range `0..1` and `Fixar na divisao`. Test keyboard operation, accessible names, visual continuity on detach, explicit reattach, and no-op history. The panel must not duplicate template geometry: any requested `0..1` position is rendered through `resolveCaptionLayout`, which clamps complete visual bounds. Detaching uses the current raw attached anchor (`settledSplit + inheritedOffset`); before and after detachment the same shared layout clamp preserves visual continuity, including split endpoints.

Run: `npx vitest run tests/components/CaptionPanel.test.tsx`

Expected: FAIL because the panel still exposes pinned offset editing rather than explicit modes.

- [ ] **Step 5: Implement the inspector behavior**

Use settled `splitRatioAt`, never divider transient ratio. Preserve the existing selected-block text editor and unrelated style overrides. Redefine/reset positional override wording so it is unambiguous.

- [ ] **Step 6: Verify rebuild and persistence preservation**

Test detached `{ pinToSplit:false, positionYPct }`, attached `{ pinToSplit:true }`, removal of stale keys, normal caption rebuild preservation, and expected override loss when the first-word anchor disappears.

- [ ] **Step 7: Run focused store/panel suites**

Run: `npx vitest run tests/components/CaptionPanel.test.tsx tests/unit/transcript-application.test.ts tests/components/useProjectPersistence.test.tsx tests/components/project-persistence.test.tsx`

Expected: all pass.

---

### Task 7: Direct caption drag in PreviewCanvas

**Files:**
- Modify: `app/repurpose-studio/_components/PreviewCanvas.tsx:1529-1709,2231-2325`
- Modify: `tests/components/PreviewCanvas.transport.test.tsx`
- Optional create: `app/repurpose-studio/_components/CaptionDragLayer.tsx` only if extraction keeps `PreviewCanvas` materially smaller and avoids duplicating render-loop state.
- Optional create: `tests/components/CaptionDragLayer.test.tsx` only with the component above.

- [ ] **Step 1: Write failing pointer-precedence tests**

The active caption hit rectangle must sit above the split divider and overlay body hit layer but below selection handles/toolbars. Assert caption wins when it overlaps the seam, while clicks outside retain existing overlay/base routing. Hovering the active visual bounds exposes a vertical-resize cursor; leaving the bounds restores the normal cursor.

Run: `npx vitest run tests/components/PreviewCanvas.transport.test.tsx`

Expected: FAIL because there is no caption hit target, precedence, or hover cursor.

- [ ] **Step 2: Write failing gesture tests**

Cover:

- Pointer-down pauses playback and freezes block/split/frame.
- Horizontal-only movement does not activate.
- Vertical activation threshold is 3 CSS px.
- Movement updates only a PreviewCanvas-local transient.
- Full visual bounds clamp to frame.
- A 12 CSS px zone previews the clamped attached target and coral guide.
- Pointer-up outside detaches; inside attaches.
- Pointer-cancel, unmount, block disappearance, project replacement, rebuild, Undo/Redo, and competing split clear listeners/transient without stale moves.
- Exactly one history entry for completed movement and none for click/cancel.

Run: `npx vitest run tests/components/PreviewCanvas.transport.test.tsx`

Expected: FAIL because direct caption drag and snap behavior are absent.

- [ ] **Step 3: Add current-frame caption layout tracking**

Capture the layout returned by `drawCaptions` in the existing render loop. Update a bounds-sized transparent DOM hit target imperatively to avoid React state updates at 60 fps. Give it an accessible label and `cursor: ns-resize` only while an active caption is available. Convert CSS/output coordinates without DPR double-scaling.

- [ ] **Step 4: Implement local drag state and snap guide**

Freeze ownership at pointer-down. Pass local transient absolute Y into caption layout/drawing. Do not write Zustand during pointermove. On completion, call the tokenized attach/detach action once.

- [ ] **Step 5: Guard playback and gesture competition**

Playback/shuttle cannot advance while caption drag owns the frame. A new divider gesture cancels caption drag, and a caption drag cancels any active divider gesture.

- [ ] **Step 6: Run PreviewCanvas regression suite**

Run: `npx vitest run tests/components/PreviewCanvas.transport.test.tsx tests/components/useObjectSelection.test.tsx tests/unit/caption-split-placement.test.ts`

Expected: all pass with existing divider/overlay interaction behavior intact.

---

### Task 8: Integrated persistence, trim, export, and browser acceptance

**Files:**
- Modify: `tests/e2e/editor-surfaces.spec.ts`
- Modify: `tests/e2e/export.spec.ts`
- Modify: `tests/e2e/helpers/project.ts`
- Modify: `tests/unit/export-short-split.test.ts`
- Modify: relevant fixtures only if existing `overlay.png` and `overlay.mp4` are insufficient.

- [ ] **Step 1: Generate authoritative media fixtures once**

Run: `npm run fixtures:media`

Expected: generated overlay image/video and export fixtures are present. Do not use the preview proxy for export.

- [ ] **Step 2: Add failing end-to-end editor flow**

In one deterministic project:

- Detach one caption by vertical canvas drag.
- Confirm another block remains attached and follows split movement.
- Snap and explicitly attach the detached block.
- Add image and video overlays.
- Configure distinct entrance/exit effects, durations, Slide direction, and radius preset.
- Trim, duplicate, copy/paste attributes, Undo/Redo, save, reload, and reopen.
- Assert authored controls and interaction geometry persist.

Run: `npx playwright test tests/e2e/editor-surfaces.spec.ts`

Expected: FAIL on the newly asserted integrated flow before any Task 8 gap fixes.

- [ ] **Step 3: Add failing pixel/audio export assertions**

Sample entrance boundary/midpoint, settled frame, exit midpoint, and final
boundary. Compare preview to both 1080p and 4K exports for transform, alpha,
Slide side, Pop overshoot, and transparent rounded corners. Include Screen, Face,
Free, rotation, oversized media, and split `0/1`. Assert overlay audio remains
absent and Face audio measurements remain unchanged.

Run: `npx playwright test tests/e2e/export.spec.ts`

Expected: FAIL on the new animation/radius pixel samples until all shared-path integration gaps are fixed.

- [ ] **Step 4: Fix only integration gaps exposed by E2E**

Do not add browser-only branches. Any visual mismatch must be corrected in the shared resolver/compositor/layout path and covered by a focused regression test first.

- [ ] **Step 5: Run focused E2E on clean port `3001`**

Before starting, prove port ownership; stop only a process whose command line points to this worktree. Run:

`npx playwright test tests/e2e/editor-surfaces.spec.ts tests/e2e/export.spec.ts`

Expected: all selected Desktop Chrome tests pass.

---

### Task 9: Final verification and independent review

**Files:**
- Review all files changed by Tasks 1-8.
- Modify only files required by concrete review findings.

- [ ] **Step 1: Run focused lint and diff hygiene**

Compare `git status --short` and `git diff --stat` to Task 0's recorded baseline, then run ESLint on touched TypeScript/TSX files and `git diff --check`. Use the external binary patch only as review evidence; never apply or reverse it.

Expected: zero errors; existing non-blocking advisories may be reported explicitly.

- [ ] **Step 2: Run the complete verification gate**

Run: `npm run verify`

Expected:

- TypeScript passes.
- All Vitest suites pass.
- Playwright passes with only the existing opt-in actual-HEVC test skipped when its environment variable is absent.
- Production build succeeds.

- [ ] **Step 3: Dispatch spec-compliance review**

Review every acceptance criterion in the design spec, with special attention to transient isolation, visual-to-persisted transform mapping, caption pointer precedence, short overlay windows, rounded band clipping, history cardinality, and preview/export pixels.

- [ ] **Step 4: Dispatch code-quality review**

Review only high/medium correctness, data-loss, performance, accessibility, persistence, race, and false-positive-test risks. Fix concrete findings with a failing regression test first.

- [ ] **Step 5: Repeat the full gate after final corrections**

Run: `npm run verify`

Expected: complete pass after the final diff, not merely before review changes.

- [ ] **Step 6: Restart local production safely**

After a successful build, prove port `3001` is free or owned by this worktree, start `next start -H 127.0.0.1 -p 3001`, record launcher/listener PIDs, and verify HTTP `200` for the studio, a preserved project, and its project API. Never touch port `3000`.
