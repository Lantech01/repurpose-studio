# Full-Range Face/Screen Split Divider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the scene divider move from Face full-frame (`0`) through split-screen to Screen full-frame (`1`) with matching preview, export, interaction, persistence, and thumbnails.

**Architecture:** Centralize ratio normalization, pointer snapping, and pixel-effective rounding in one browser/server-safe module. Keep persisted ratios as plain numbers, keep gesture state transient, and make all render and interaction consumers use the same effective split. Extend the existing shared compositor and scene-specific store actions instead of adding separate display modes.

**Tech Stack:** TypeScript, React 19, Zustand, Canvas 2D, Vitest, Testing Library, Next.js 15, Playwright.

---

## File Map

- `lib/repurpose/split-ratio.ts`: one source of truth for clamp, pointer snap, persisted parsing, and pixel-effective split.
- `lib/repurpose/store.ts`: full-range global/per-clip actions and gesture-scoped history transaction.
- `lib/repurpose/time-map.ts`: endpoint-safe per-scene resolution/interpolation.
- `lib/repurpose/compositor.ts`: zero-band base/overlay rendering and divider omission.
- `lib/repurpose/overlay-geometry.ts`: mirrored Screen/Face rotated-AABB seam constraints.
- `lib/repurpose/captions.ts`: vertical visual-bounds placement for split-pinned captions.
- `app/repurpose-studio/_components/PreviewCanvas.tsx`: pointer gesture, endpoint snapping, transient direct manipulation, ARIA, keyboard input.
- `app/repurpose-studio/_components/useObjectSelection.ts`: frame-effective base/overlay routing.
- `app/repurpose-studio/_components/SelectionOverlay.tsx`: hide chrome for overlays in hidden bands.
- `app/repurpose-studio/_components/GhostOverflowLayer.tsx`: hide ghost media for zero-height bands.
- `app/repurpose-studio/_components/SelectionToolbar.tsx`: hide controls for hidden overlays and pass the effective split to geometry actions.
- `app/repurpose-studio/_components/useProjectPersistence.ts`: strict ratio hydration.
- `app/api/repurpose/thumb/route.ts`: endpoint-safe thumbnail rendering.
- Existing export code remains a consumer of `splitRatioAt` + `drawFrame`; change it only if tests expose a separate clamp.

## Task 1: Central Ratio Contract and Store Mutations

**Files:**
- Create: `lib/repurpose/split-ratio.ts`
- Create: `tests/unit/split-ratio.test.ts`
- Modify: `lib/repurpose/store.ts:952,1585-1595,2187-2205,2580-2610,2883-2888`
- Modify: `lib/repurpose/time-map.ts:39-55,231-267`
- Modify: `lib/repurpose/types.ts:190-215`
- Modify: `tests/unit/time-map.smoke.test.ts`
- Modify: `tests/unit/video-timeline-bootstrap.test.ts`

- [ ] **Step 1: Write failing pure ratio tests**

Define the target API:

```ts
export function clampSplitRatio(value: number): number | null;
export function parsePersistedSplitRatio(value: unknown, fallback: number): number;
export function snapPointerSplitRatio(value: number): number;
export function effectiveSplitRatio(value: number, height: number): number;
```

Cover finite clamp to `[0,1]`, non-finite `null`, persisted fallback, no hydration snapping, exact pointer thresholds `0.0199/0.02/0.0201/0.9799/0.98/0.9801`, and rounded-zero/rounded-full bands at small, 1080p, and 4K heights.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/unit/split-ratio.test.ts
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the pure helpers**

Clamp before pointer snapping. `effectiveSplitRatio` returns `round(height * clamp) / height`, with a safe `0.5` fallback for invalid values/heights.

- [ ] **Step 4: Add failing store/time-map tests**

Prove:

- global and per-clip setters accept exact `0/1`, clamp finite out-of-range values, and ignore non-finite values without history/subscriber notification;
- copy/paste attributes, duplication, split, restore, reset, Undo, and Redo never apply the old `0.4-0.6` clamp;
- `splitRatioAt` resolves and interpolates endpoint overrides while clamping malformed runtime input;
- a gesture longer than 700 ms creates one history entry, a no-op creates none, and one gesture cannot change target clips.
- gesture re-entry cancels the previous transaction; `resetProject`, `setClips`, Undo, Redo, and project replacement cancel it before changing document state.

Target store API:

```ts
beginSplitRatioGesture(target: { kind: "clip"; id: string } | { kind: "global" }): void;
updateSplitRatioGesture(ratio: number): void;
endSplitRatioGesture(): void;
cancelSplitRatioGesture(): void;
```

The store factory keeps the active transaction private; it captures history only on the first effective update and never switches target. Regular global/per-clip setters use discrete unkeyed history, so rapid keyboard presses inside 700 ms remain individually undoable. Only the gesture API coalesces pointer moves.

- [ ] **Step 5: Run store/time-map RED**

```powershell
npm test -- tests/unit/split-ratio.test.ts tests/unit/time-map.smoke.test.ts tests/unit/video-timeline-bootstrap.test.ts
```

Expected: FAIL on old clamps and missing gesture API.

- [ ] **Step 6: Implement minimal store/time-map changes**

Use the shared helpers everywhere a ratio is written or resolved. Preserve existing split/duplicate inheritance. Update stale type comments.

- [ ] **Step 7: Run GREEN and inspect diff**

Run the Step 5 command, then `npm run typecheck` and `git diff --check`. Expected: PASS. Do not commit.

## Task 2: Zero-Band Compositor and Overlay Geometry

**Files:**
- Create: `tests/unit/compositor-split.test.ts`
- Create: `tests/unit/overlay-band-geometry.test.ts`
- Modify: `lib/repurpose/compositor.ts:366-420,556-614`
- Modify: `lib/repurpose/overlay-geometry.ts:777-801`
- Modify: `lib/repurpose/store.ts:2370-2415,2480-2560,2810-2865`
- Modify: `app/repurpose-studio/_components/useObjectSelection.ts:220-510`
- Modify: `app/repurpose-studio/_components/SelectionOverlay.tsx`
- Modify: `app/repurpose-studio/_components/GhostOverflowLayer.tsx`
- Modify: `app/repurpose-studio/_components/SelectionToolbar.tsx`
- Create: `tests/components/SelectionOverlay.test.tsx`
- Create: `tests/components/GhostOverflowLayer.test.tsx`
- Create: `tests/components/SelectionToolbar.test.tsx`

- [ ] **Step 1: Write failing compositor tests**

Use a recording 2D-context stub. At effective `0`, assert no Screen placeholder/cover/draw call, Face draws full-frame, Screen overlays do not draw, Free/Face overlays do, and no divider is drawn. Mirror at `1`. Repeat with tiny ratios that round to zero and at 1080p/4K.

- [ ] **Step 2: Run compositor RED**

```powershell
npm test -- tests/unit/compositor-split.test.ts
```

Expected: FAIL because zero-height regions/dividers/overlays are still processed.

- [ ] **Step 3: Implement zero-band rendering**

Compute integer `topH/bottomH` once. Call `drawRegion` only for positive bands. Skip band-bound overlays whose band height is zero. Draw the divider only when both heights are positive. Do not stop Face media/audio clocks outside this pure compositor.

- [ ] **Step 4: Write failing overlay geometry tests**

Replace the top-only contract with:

```ts
export function clampOverlayToBand(
  overlay: Pick<Overlay, "naturalWidth" | "naturalHeight" | "band">,
  transform: OverlayTransform,
  previewRect: PreviewRect,
  splitRatio: number,
): OverlayTransform;
```

The helper computes the current rotated AABB internally from the proposed transform, intrinsic dimensions, and preview rect, preventing stale-box callers. Cover Screen `AABB.maxY <= split`, Face `AABB.minY >= split`, Free unchanged, rotated boxes, oversized boxes, hidden bands, and mirrored behavior. Add interaction tests proving hidden overlays cannot hit-test, render ghost overflow, show selection/toolbar chrome, act as snap targets, or participate in alignment/distribution; their transforms remain unchanged. If filtering leaves fewer than the operation's required participants, alignment/distribution is a no-op with no history entry. Frame-effective `0/1` routes all base pointer/wheel input to Face/Screen respectively.

- [ ] **Step 5: Run overlay RED**

```powershell
npm test -- tests/unit/overlay-band-geometry.test.ts tests/components/PreviewCanvas.transport.test.tsx tests/components/SelectionOverlay.test.tsx tests/components/GhostOverflowLayer.test.tsx tests/components/SelectionToolbar.test.tsx
```

Expected: FAIL on the top-only helper/global-ratio routing.

- [ ] **Step 6: Implement one geometry/routing contract**

Update move, resize, paste, snapping, alignment, and distribution call sites. Pass a `getEffectiveSplitRatio()` callback from `PreviewCanvas` into object selection, ghost layer, selection chrome, and toolbar so render and interaction read one frame value. Extend store alignment/distribution actions to accept the caller's effective split rather than reading the global ratio. Filter hidden-band overlays before snap-target and alignment/distribution participant/cardinality/history logic. Preserve their stored transforms and make hidden selection/toolbar surfaces return `null`.

- [ ] **Step 7: Run GREEN and regressions**

Run Steps 2 and 5, then existing overlay/export unit tests. Expected: PASS. Run `git diff --check`. Do not commit.

## Task 3: Endpoint-Safe Captions, Persistence, and Thumbnails

**Files:**
- Create: `tests/unit/caption-split-placement.test.ts`
- Create: `tests/server/thumb-route.test.ts`
- Modify: `lib/repurpose/captions.ts:1160-1245`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts:850-970,1010-1060`
- Modify: `tests/components/useProjectPersistence.test.tsx`
- Modify: `tests/components/project-persistence.test.tsx`
- Modify: `app/api/repurpose/thumb/route.ts:80-110`

- [ ] **Step 1: Write failing caption placement tests**

For every caption template and its materially distinct decoration/animation path, render split-pinned blocks at effective `0` and `1`. Assert the complete recorded visual bounds, including stroke, box, shadow, animation overshoot, and mascot, stay within `[0,width] x [0,height]`.

- [ ] **Step 2: Run caption RED**

```powershell
npm test -- tests/unit/caption-split-placement.test.ts
```

Expected: FAIL because vertical placement is not clamped.

- [ ] **Step 3: Implement measured vertical translation**

After layout/effect extents are known, translate the whole caption composition vertically by the minimum amount required to keep all visual bounds inside the frame. Do not alter saved style offsets.

- [ ] **Step 4: Write failing hydration/round-trip tests**

Prove global and per-clip `0/1` save/reopen exactly, finite out-of-range values clamp, invalid global values become `0.5`, invalid clip values drop their override, and values `0.2/0.79` remain unchanged.

- [ ] **Step 5: Write failing thumbnail tests**

Start `tests/server/thumb-route.test.ts` with `// @vitest-environment node`. Mock `execFile` and inspection. Assert the generated FFmpeg filter uses only the Face source when `topH === 0`, only Screen when `bottomH === 0`, and never emits zero-height `scale`, `crop`, or `vstack` inputs. Cover exact endpoints, tiny ratios that round to zero at the route's 480 px height, normal split filters, invalid fallback, and removal of the old `0.4-0.6` clamp.

- [ ] **Step 6: Run persistence/thumbnail RED**

```powershell
npm test -- tests/components/useProjectPersistence.test.tsx tests/components/project-persistence.test.tsx tests/server/thumb-route.test.ts
```

Expected: FAIL on permissive hydration and thumbnail clamp.

- [ ] **Step 7: Implement persistence and thumbnail normalization**

Use `parsePersistedSplitRatio`; validate every clip override during hydration. Keep schema unchanged. Use the central helper in the thumbnail route and branch before constructing FFmpeg filters: direct single-source scale/crop for a hidden band, existing two-source `vstack` only when both pixel heights are positive.

- [ ] **Step 8: Run GREEN**

Run Steps 2 and 6, `npm run typecheck`, and `git diff --check`. Expected: PASS. Do not commit.

## Task 4: Full-Range Pointer and Keyboard Divider

**Files:**
- Modify: `app/repurpose-studio/_components/PreviewCanvas.tsx:95-110,1330-1345,1546-1585,1690-1785,1920-1940,2107-2118`
- Modify: `tests/components/PreviewCanvas.transport.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Cover pointer snapping at every threshold, edge-to-middle recovery, scene frozen at pointer-down, no-op drag, slow drag one-step Undo, cut crossing, pointer-cancel cleanup, pause-on-drag, direct transient ratio during a transition, and return to frame-resolved interpolation after release. Also prove project epoch change, component unmount, gesture re-entry, `resetProject`, `setClips`, Undo, and Redo cancel listeners, local transient state, and the private store transaction before stale callbacks can mutate state.

- [ ] **Step 2: Write failing accessibility tests**

Require focused separator semantics, name, horizontal orientation, min/max/current percentage, 1% Arrow changes, Home=`0`, End=`1`, and endpoint hit target remaining partially inside the canvas. Fire several Arrow events within 700 ms and prove each is a separate Undo step.

- [ ] **Step 3: Run interaction RED**

```powershell
npm test -- tests/components/PreviewCanvas.transport.test.tsx
```

Expected: FAIL on old clamp, missing gesture transaction, and missing keyboard semantics.

- [ ] **Step 4: Implement the divider behavior**

At pointer-down pause, freeze the active clip/global target, start the store gesture, and capture the pointer. Each move computes clamped/snapped ratio and sets the local transient ratio plus store gesture update. Pointer-up/cancel clears listeners, capture, transient state, and transaction. Keyboard uses normal setters and never creates transient state.

Use the current canvas logical height with `effectiveSplitRatio` for handle position, render calls, captions, selection, and hit-testing.

- [ ] **Step 5: Run GREEN and component regressions**

Run Step 3 plus `tests/components/TransportBar.test.tsx` and relevant overlay tests. Expected: PASS. Run `npm run typecheck` and `git diff --check`. Do not commit.

## Task 5: Preview/Export Parity and Final Verification

**Files:**
- Create: `tests/e2e/full-range-split.spec.ts`
- Create: `tests/unit/export-short-split.test.ts`
- Modify: `lib/repurpose/export-short.ts:937-1022`
- Modify: `tests/e2e/helpers/project.ts` only for deterministic endpoint fixtures

- [ ] **Step 1: Generate media fixtures**

```powershell
npm run fixtures:media
```

Expected: exit 0 before media-consuming tests.

- [ ] **Step 2: Add deterministic parity tests**

At 1080p and 4K, cover plain scenes plus natural/bounce transitions at `0` and `1`. In export, compute `frameSplit = effectiveSplitRatio(splitRatioAt(...), outputHeight)` once and pass that same value to `drawFrame`, overlays, and `drawCaptions`. Assert no hidden-band/divider pixels, visible source cover, matching free/band overlays, bounded captions, and synchronized Face narration for Screen full-frame. `tests/unit/export-short-split.test.ts` must inspect compositor/caption arguments and audio assembly; use pixel checks only where observable calls cannot prove parity.

- [ ] **Step 3: Add browser flow**

Import Screen + Face, drag to Face full-frame, restore split, drag to Screen full-frame, use Home/End, Undo/Redo, save/reopen, and verify the project thumbnail represents the endpoint. Assert no console/request failures.

- [ ] **Step 4: Run focused suites**

```powershell
npm test -- tests/unit/split-ratio.test.ts tests/unit/time-map.smoke.test.ts tests/unit/compositor-split.test.ts tests/unit/overlay-band-geometry.test.ts tests/unit/caption-split-placement.test.ts
npm test -- tests/unit/export-short-split.test.ts tests/components/PreviewCanvas.transport.test.tsx tests/components/SelectionOverlay.test.tsx tests/components/GhostOverflowLayer.test.tsx tests/components/SelectionToolbar.test.tsx tests/components/useProjectPersistence.test.tsx tests/components/project-persistence.test.tsx tests/server/thumb-route.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Prepare port 3001 safely and run E2E**

First check port 3001. If it is free, proceed. If it is occupied and the current execution session has a PID previously captured from `Start-Process -PassThru`, stop only that tracked process tree and verify the port becomes free. If it is occupied and no trusted PID is available, stop and ask the user rather than inferring or terminating the listener. Never inspect, stop, or alter port 3000. Then let Playwright own its configured port-3001 lifecycle and run:

```powershell
npx playwright test tests/e2e/full-range-split.spec.ts
```

Expected: PASS in Desktop Chrome.

- [ ] **Step 6: Run full verification**

```powershell
npm run verify
```

Expected: typecheck, Vitest, Playwright, and production build exit 0.

- [ ] **Step 7: Rebuild and restart local production**

Run `npm run build`, then use `Start-Process -PassThru` to start this exact worktree on port `3001` and retain its returned PID for later ownership-safe shutdown. Request `/repurpose-studio`, verify HTTP 200, and use Chrome/Playwright to verify the divider is visible and keyboard operable. Do not stop or alter port 3000. Do not commit, push, or deploy elsewhere unless explicitly requested.

## Execution Notes

- Use `@test-driven-development` for every production change and observe RED before GREEN.
- Use `@systematic-debugging` for unexpected failures.
- Use `@verification-before-completion` before any completion claim.
- Preserve all unrelated dirty-worktree changes.
- Keep the current project schema and ratio meaning; do not add full-screen mode flags.
