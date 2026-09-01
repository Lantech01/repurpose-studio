# Full-Range Face/Screen Split Divider

## Goal

Allow the existing preview divider to move through the full frame so either
Screen or Face can occupy 100% of the output. The behavior must remain
scene-specific and identical in preview, persistence, and export.

## Interaction

- `splitRatio` keeps its existing meaning: the fraction of frame height assigned
  to Screen at the top.
- `splitRatio = 0` hides Screen and makes Face full-frame.
- `splitRatio = 1` hides Face and makes Screen full-frame.
- Pointer dragging accepts the full `[0, 1]` range.
- Pointer values are clamped first, then values `<= 0.02` snap to `0` and values
  `>= 0.98` snap to `1`. Programmatic setters and hydration clamp but do not
  snap.
- The divider hit target remains centered on the edge at `0` and `1`, leaving
  half of its 16 px hit area inside the canvas so the user can restore a split.
- Pointer-down pauses playback and freezes ownership to the scene under the
  playhead at that instant. Crossing a cut while dragging cannot edit another
  scene. The global ratio changes only when no scene was active at pointer-down.
- A gesture transaction captures history on the first effective movement, not
  on a timer. Any drag duration produces exactly one Undo entry; a no-op drag
  produces none. Pointer-up and pointer-cancel both close the transaction.
- During a gesture, a transient direct-manipulation ratio drives the handle,
  compositor, overlays, captions, and hit-testing without transition easing.
  Pointer-up or pointer-cancel clears it immediately; the paused frame then
  returns to its normal frame-resolved interpolation and may settle away from the
  pointer when the playhead is inside a transition. Undo/Redo, keyboard edits,
  paste/reset, hydration, project replacement, and export therefore never see or
  retain a transient ratio.
- The divider is a keyboard-operable horizontal separator with `tabIndex=0`, an
  accessible name, `aria-valuemin=0`, `aria-valuemax=100`, and
  `aria-valuenow=screenPercent`. Arrow Up/Left decreases Screen by 1%; Arrow
  Down/Right increases it by 1%; Home selects Face full-frame (`0`); End selects
  Screen full-frame (`1`). One key press is one Undo step.

## Rendering

- Preview and export continue to share `drawFrame` and `splitRatioAt`.
- A band is hidden whenever its rounded pixel height is zero, including tiny
  nonzero ratios on small/custom canvases. Define the frame-effective split as
  `round(height * clamp(ratio, 0, 1)) / height`; rendering, pointer/wheel routing,
  overlay visibility/hit-testing, captions, and selection chrome use this same
  effective split for that surface. A hidden band performs no placeholder,
  cover-fit, base `drawImage`, or band-overlay `drawImage` work.
- The rendered divider line is omitted whenever either rounded band height is
  zero. The DOM drag target remains available in preview and is never exported.
- Per-scene transitions continue interpolating between ratios, including
  transitions to or from full-frame, except for the explicit transient gesture
  override described above.
- Screen-bound overlays disappear when Screen has zero height; Face-bound
  overlays disappear when Face has zero height. Hidden-band overlays are also
  excluded from hit-testing, selection chrome, snapping, alignment, and
  distribution, but retain their persisted transforms for when the band returns.
  Free overlays remain visible and interactive.
- Overlay geometry uses the frame-effective split. For Screen, translate the
  complete rotated AABB only as needed to keep its seam-facing edge
  `AABB.maxY <= split`; overflow beyond the outer top/left/right frame edges
  remains allowed and is cropped. Face mirrors this rule with
  `AABB.minY >= split`, allowing outer bottom/left/right overflow. If an overlay
  is larger than its band, this seam-edge rule still wins and compositor clipping
  determines the visible portion. Free overlays receive no band clamp and retain
  existing frame behavior. Move, resize, paste, snapping, alignment, and
  distribution use this same invariant rather than center-only clamping.
- Every base-region pointer and wheel decision uses the same frame-resolved or
  transient gesture ratio as rendering, never the global fallback alone. At `0`
  all base interaction routes to Face; at `1` it routes to Screen.
- Split-pinned captions are measured before placement. Their complete visual
  bounds, including stroke, box, shadow, active animation overshoot, and mascot
  decoration, are translated vertically into the output bounds. This applies to
  every caption template at both endpoints; captions remain visible rather than
  following the seam off-canvas.
- Face remains loaded, synchronized, and authoritative for narration when Screen
  occupies 100%. Preview and export audio behavior does not depend on Face's
  visual band height.
- Project thumbnails use the same full-range ratio and zero-band rules as the
  editor/export, so endpoint projects are not represented as split frames.

## Data Compatibility

- No schema or migration is required. `splitRatio` remains a finite number.
- Existing finite in-range project values retain their saved ratios unchanged,
  including values such as `0.2` and `0.79` that were outside the old editor
  clamp.
- Global and per-clip setters clamp finite values to `[0, 1]`. Non-finite values
  are ignored without history or subscriber notification.
- Hydration clamps finite values to `[0, 1]`; an invalid/non-numeric global ratio
  falls back to `0.5`, while an invalid per-clip ratio drops that override.
  Exact endpoint values round-trip unchanged.
- Attribute copy/paste, clip duplication, splitting, restore, reset, Undo, and
  Redo preserve or clamp ratios with the same contract. No mutation path may
  retain the old `0.4-0.6` clamp.

## Scope

Included:

- global and per-scene split setters;
- preview drag and edge hit target;
- time-map interpolation;
- shared compositor behavior used by preview/export;
- base and overlay hit-testing/geometry at hidden bands;
- caption endpoint placement;
- project thumbnail rendering;
- persistence and Undo/Redo regression coverage.

Excluded:

- separate full-screen mode buttons;
- global keyboard shortcuts outside the focused divider;
- independent source visibility tracks;
- changes to framing controls or project schema.

## Verification

Tests must prove:

- global and per-scene setters accept exact `0` and `1`, clamp outside values,
  ignore non-finite values, and retain one-step Undo/Redo behavior;
- pointer snap cases cover `0.0199`, `0.02`, `0.0201`, `0.9799`, `0.98`, and
  `0.9801`; setters/hydration do not snap nearby values;
- a drag lasting longer than 700 ms still creates one Undo entry; a drag crossing
  a cut edits only the pointer-down scene; pointer-cancel closes the gesture;
- dragging inside a transition uses the direct transient ratio only until
  pointer-up/cancel, then returns to normal interpolation; every non-pointer
  mutation and export ignores transient state;
- keyboard arrows and Home/End update the ratio and expose correct ARIA values;
- `splitRatioAt` preserves/interpolates endpoint overrides outside a gesture;
- `drawFrame` skips all work for rounded-zero bands and omits the divider while
  drawing the visible region full-frame;
- preview and export at 1080p and 4K have no hidden-band/divider pixels and share
  source coverage, overlays, and captions for plain, natural, and bounce cuts;
- Screen/Face/free overlays follow endpoint render, interaction, selection, and
  geometry rules during static frames and transitions, including rotated AABBs,
  oversized overlays, and tiny ratios that round to a hidden band;
- every caption template's complete visual bounds stay inside the output at both
  endpoints;
- Screen-full preview/export retains synchronized Face narration;
- save/reopen preserves `0` and `1` exactly and handles malformed/non-finite data
  with the specified fallback;
- attribute copy/paste, duplication, splitting, restore, reset, Undo, and Redo do
  not reintroduce the old clamp;
- thumbnails represent the same full-frame source selected in the editor;
- existing non-endpoint projects and split behavior remain unchanged.
