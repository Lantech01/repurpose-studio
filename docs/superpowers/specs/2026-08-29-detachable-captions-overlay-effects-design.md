# Detachable Captions and Overlay Appearance Design

**Date:** 2026-08-29
**Status:** User-approved design, pending implementation plan

## Goal

Add two editing capabilities without breaking preview/export parity or existing
projects:

1. A caption block starts pinned to the Face/Screen seam, can be dragged
   vertically into an independent position for that block only, and can snap or
   be explicitly attached back to the seam.
2. Every image or video overlay can have independent entrance and exit effects
   plus a uniform corner radius.

The feature must remain deterministic while paused or scrubbing, persist across
save/reopen, support Undo/Redo, and render identically in preview and export.

## Non-Goals

- Horizontal caption dragging.
- A general keyframe editor or arbitrary animation curves.
- Per-corner radius controls.
- A visible border, stroke, or shadow around overlays.
- Overlay audio.
- Changes to scene-level Face/Screen transitions.
- Redesigning the existing server-generated project thumbnail, which currently
  represents base media rather than the full overlay/caption composite.

## User Experience

### Detachable caption blocks

- Caption blocks continue to inherit the current global pinned-to-split style.
- Hovering the active caption in the preview exposes a vertical-move cursor.
- Pointer-down pauses playback and freezes the active caption block and settled
  frame split at that moment.
- Vertical movement previews an absolute output-space position. Horizontal
  pointer movement is ignored.
- Moving away from the seam detaches only the active block. Other caption blocks
  continue following the Face/Screen split.
- A coral guide shows the seam attachment target. Releasing within a 12 CSS px
  snap zone attaches the block; releasing outside saves an absolute vertical
  position.
- The selected block's editor includes a `Fixar na divisao` action. It sets a
  per-block `pinToSplit: true` override, clears absolute position and per-block
  seam-offset values, and therefore follows later changes to the global seam
  offset. Explicit attachment survives a later global `pinToSplit` change.
- The panel is the keyboard-accessible alternative to direct canvas dragging.
  An attached block exposes `Soltar legenda`; activating it freezes the block at
  its current resolved absolute Y. A detached block exposes the existing
  position slider over the complete valid output range plus `Fixar na divisao`.
  The slider itself does not auto-snap; keyboard users reattach explicitly.
- The complete visual caption bounds, including box, stroke, shadow, animation
  overshoot, and decoration, remain inside the output frame.

### Overlay appearance controls

The selected overlay toolbar adds compact `Entrada`, `Saida`, and `Cantos`
groups:

- Entrance and exit are configured independently.
- Effect choices are `Nenhum`, `Zoom`, `Slide`, `Pop`, and `Fade`.
- Duration is independently adjustable from `0.1s` through `2s`; the default is
  `0.35s`.
- Slide exposes `Esquerda`, `Direita`, `Cima`, and `Baixo`. Direction is hidden
  for every other effect.
- Corner radius is one `0%` through `50%` control for all four corners.
- Radius presets are `Quadrado` (`0%`), `Suave` (`4%`), `Redondo` (`16%`), and
  `Maximo` (`50%`).
- Controls update the current preview immediately and each discrete change is
  undoable. Slider pointer/keyboard gestures use explicit begin/update/end
  transactions rather than the existing time-window coalescing heuristic, so a
  long drag still creates exactly one history entry.
- In a multi-selection, appearance controls target the same effective visible
  primary overlay used by selection chrome and existing scalar controls.

All form controls have visible labels, keyboard focus, and meaningful accessible
names. Numeric values remain visible next to sliders.

## Data Model

```ts
export type OverlayEffectType = "none" | "zoom" | "slide" | "pop" | "fade";

export type OverlaySlideDirection = "left" | "right" | "up" | "down";

export interface OverlayEffect {
  type: OverlayEffectType;
  durationSec: number;
  direction?: OverlaySlideDirection;
}

export interface Overlay {
  // Existing fields omitted.
  entranceEffect?: OverlayEffect;
  exitEffect?: OverlayEffect;
  cornerRadius?: number; // 0..0.5 of the shorter rendered side
}
```

Optional fields preserve compatibility with saved projects. Missing or invalid
values normalize to:

```ts
entranceEffect = { type: "none", durationSec: 0.35 }
exitEffect = { type: "none", durationSec: 0.35 }
cornerRadius = 0
```

Durations clamp to `[0.1, 2]`, radius clamps to `[0, 0.5]`, and an invalid Slide
direction becomes `left`. Effects other than Slide discard/ignore `direction`.
Serialization writes normalized values. Hydration, duplication, and project
replacement must never retain transient animation or caption-drag state.

The overlay attribute clipboard expands to include normalized entrance, exit,
and corner-radius values. Attribute paste continues to affect visible selected
overlays only. Duplicating an overlay preserves all appearance settings.

Caption detachment uses the existing per-block `CaptionStyle` override:

- Detached: `pinToSplit: false` plus absolute `positionYPct`.
- Attached: a per-block `pinToSplit: true` override with no per-block
  `splitOffsetPct`; the resolved block therefore inherits future global seam
  offset changes while remaining explicitly attached even if global
  `pinToSplit` later becomes false.
- Reattaching removes per-block `positionYPct` and `splitOffsetPct` before setting
  `pinToSplit: true`, so only one position model is authoritative.

## Shared Overlay Appearance Resolver

A pure resolver is the only source of time-varying overlay appearance. Its
transform and corner-radius outputs remain normalized; pixel conversion occurs
only inside a renderer for that renderer's dimensions:

```ts
resolveOverlayAppearanceAt(overlay, outputTime, frameRect, splitRatio)
  -> {
    transform: OverlayTransform;
    opacityMultiplier: number;
    cornerRadius: number;
    interactive: boolean;
  }
```

It is shared by preview, export, selection chrome, ghost overflow, and
hit-testing. Persisted transforms are inputs and are never modified by the
resolver.

### Effective effect windows

An overlay is active on its existing `[timelineStart, timelineEnd)` interval.
`none` requests zero animation duration. For active effects:

1. Clamp each requested duration to `[0.1, 2]`.
2. Let `life = timelineEnd - timelineStart`.
3. If requested entrance plus exit duration exceeds `life`, multiply both by
   `life / requestedTotal`.

This preserves the user's relative timing while ensuring the two windows never
overlap. A single active effect may consume the overlay's complete lifetime.
Trimming changes only the effective windows; it does not overwrite the user's
saved duration settings.

The resolver uses a settled-progress value `p` where `0` is the invisible
boundary and `1` is the normal persisted appearance. Entrance moves `0 -> 1`;
exit moves `1 -> 0`. Scrubbing directly to any output time produces the same
result without depending on prior frames.

The standard easing is defined exactly as:

```ts
easeInOutCubic(p) = p < 0.5
  ? 4 * p * p * p
  : 1 - Math.pow(-2 * p + 2, 3) / 2
```

### Effect semantics

- **None:** identity transform and opacity multiplier `1`.
- **Fade:** identity transform; opacity is `easeInOutCubic(p)`.
- **Zoom:** scale multiplier is
  `0.75 + 0.25 * easeInOutCubic(p)`; opacity is `easeInOutCubic(p)`.
- **Pop:** for `p <= 0.7`, scale interpolates from `0.6` to `1.08` using
  `easeOutCubic(p / 0.7)`, where `easeOutCubic(x) = 1 - (1 - x)^3`. For
  `p > 0.7`, scale interpolates from `1.08` to `1` using
  `easeInOutCubic((p - 0.7) / 0.3)`. Exit evaluates the same function while `p`
  moves from `1` to `0`, exactly reversing the path. Opacity is
  `easeInOutCubic(p)`.
- **Slide:** `left` means entrance originates fully beyond the left frame edge
  and exit travels fully beyond that same edge. `right`, `up`, and `down` mirror
  that side-based meaning. The overlay center interpolates between the persisted
  position and the selected off-frame position with `easeInOutCubic(p)`. The
  complete rotated AABB determines the distance required to clear the frame.
  Opacity is `easeInOutCubic(p)`.

Pop is bounded by the authored `1.08` overshoot and never produces negative
scale. The final opacity is `overlay.opacity * opacityMultiplier`.

### Transform ordering and split bands

1. Resolve the persisted base transform against the current frame-effective
   Screen/Face seam.
2. Apply the time-varying entrance/exit transform ephemerally.
3. Apply local rounded clipping.
4. Apply the existing output-space Screen/Face band clip.

Animation is intentionally not re-clamped to the seam after step 2; doing so
would prevent Slide and Pop from moving naturally. The existing band clip remains
authoritative and prevents cross-band bleed.

Selection chrome, ghost overflow, and pointer hit-testing use the animated visual
transform. An overlay with opacity multiplier at or below `0.01` is not
interactive. Mutations map user deltas back onto the persisted base transform,
using the same visual-versus-persisted discipline as dynamic seam correction, so
editing during an effect never bakes animation offsets or scale into the project.

## Rounded-Corner Rendering

The compositor computes:

```ts
radiusPx = cornerRadius * Math.min(renderedWidth, renderedHeight)
```

The value is clamped to half the shorter rendered side. A local rounded rectangle
clip is established before `drawImage`, so it rotates and scales with the media.
It applies to both image and video overlays. The existing Screen/Face clip is
then applied in output space. Balanced `save`/`restore` calls guarantee no clip,
alpha, or transform leaks to later overlays or captions.

No per-frame temporary canvas, bitmap copy, or shadow blur is introduced.

## Caption Layout and Gesture Architecture

Caption drawing and interaction must not maintain duplicate geometry formulas.
A shared pure caption-layout result exposes the full visual bounds and anchor for
the active block; drawing consumes that layout, and preview hit-testing consumes
the same bounds.

The caption gesture freezes:

- Pointer id.
- Caption block id.
- Starting pointer Y.
- Starting resolved absolute anchor Y.
- Settled frame-effective split and inherited seam offset.
- One history transaction token.

The gesture has a 3 CSS px activation threshold. Before activation it creates no
history. After activation, pointer movement updates a PreviewCanvas-local
transient absolute Y only. The store is updated once on completion:

- Inside the 12 CSS px attachment zone: attach the block and restore its inherited
  seam offset.
- Outside the zone: save `pinToSplit: false` and the clamped absolute
  `positionYPct`.

Pointer-up and pointer-cancel both remove listeners and clear the transient.
Pointer-cancel restores persisted state. Undo/Redo, hydration, project
replacement, caption rebuild, and a new split gesture cancel any active caption
gesture and clear its local transient before applying their own operation.
Export and persistence never observe transient caption position.

At split endpoints, the snap target is the shared layout's already-clamped visual
anchor, not an unclamped raw seam coordinate. This keeps all caption templates
fully visible at `0%` and `100%`.

## Preview and Export Parity

- Preview and export pass the same output time, frame-effective split, normalized
  overlay appearance, and caption style into shared pure resolvers.
- Video overlay source-time mapping remains unchanged. Appearance effects alter
  only compositing, never media seek, playback rate, trim, or audio.
- Captions remain the final canvas layer above every overlay.
- DOM-only handles, guides, toolbar controls, and caption snap affordances are
  never exported.

## History and Persistence

- One completed caption drag produces exactly one Undo entry.
- A click, sub-threshold movement, or cancel produces none.
- Effect select changes are discrete Undo entries.
- Duration and radius sliders use explicit begin/update/end transactions and
  create one entry per drag regardless of gesture length.
- Reattaching an already attached caption or applying an unchanged overlay value
  is a no-op with no history entry.
- Undo/Redo during any direct-manipulation gesture clears all local transient
  state before restoring the snapshot.
- Save/reopen preserves detached caption overrides and normalized overlay
  appearance settings.

## Failure and Edge Cases

- Missing media sources retain their appearance settings and existing failure
  placeholder behavior.
- Zero/negative overlay lifetime renders nothing and runs no effect math.
- Extremely short overlays proportionally scale effect windows without NaN,
  division by zero, or overlap.
- Full-frame, Screen-bound, Face-bound, Free, rotated, oversized, and partially
  off-frame overlays follow the same resolver.
- A hidden-band overlay remains non-interactive regardless of effect state.
- If the active caption block disappears during rebuild or project replacement,
  the drag cancels safely without writing a dangling override.
- Playback cannot advance the frozen caption-drag frame until the gesture ends.

## Test Strategy

### Pure unit tests

- Normalize every valid and invalid effect, duration, direction, and radius.
- Resolve start, midpoint, settled, exit midpoint, and end for every effect.
- Verify four Slide directions and complete rotated-AABB frame clearance.
- Verify proportional window scaling for short overlays and one-sided effects.
- Prove persisted transforms remain unchanged while resolved transforms animate.
- Verify radius math at `0`, presets, `0.5`, rotation, and extreme aspect ratios.
- Resolve pinned, detached, snapped, and endpoint-clamped caption layouts for every
  caption template.

### Store and component tests

- Toolbar visibility, labels, conditional direction control, presets, keyboard
  operation, primary-overlay targeting, and explicit slider transactions.
- Caption hover, vertical-only drag, activation threshold, transient preview,
  snap guide, release, cancel, explicit attach, and one-step Undo/Redo.
- Cancellation on hydration, replacement, rebuild, Undo/Redo, and competing split
  gestures.
- Duplicate and copy/paste appearance behavior; hidden selections remain excluded.
- Selection chrome, ghost overflow, and hit-testing follow animated visuals while
  mutations update only persisted base geometry.

### Integration and E2E tests

- Image and video overlays with each effect in Screen, Face, and Free bands.
- Natural and bounce scene transitions while overlay effects are active.
- Rounded, rotated, oversized overlays at `0%`, intermediate, and `100%` split.
- Pixel comparison between preview and 1080p/4K export at animation
  boundary and midpoint frames, including transparent rounded corners.
- Save, reload, reopen, trim, duplicate, and export projects containing detached
  captions and animated rounded overlays.
- Confirm overlay audio remains absent and base Face audio remains unchanged.

## Acceptance Criteria

1. Dragging the active caption vertically detaches only that block; moving the
   split no longer moves the detached block.
2. Releasing near the seam or choosing `Fixar na divisao` reattaches the block,
   after which it follows the split again.
3. Every caption template remains fully in frame at both split endpoints.
4. Images and videos support independent entrance/exit effects from the approved
   five-effect library, independent durations, and four Slide directions.
5. Uniform corner radius works from `0%` through `50%` with the approved presets.
6. Preview, selection geometry, and export agree at every sampled
   frame.
7. No transient animation or caption gesture value is persisted or exported.
8. Existing projects reopen without visual changes.
9. Undo/Redo, save/reopen, duplication, copy/paste, trimming, and full-range split
   behavior remain deterministic.
10. The complete project verification gate passes.
