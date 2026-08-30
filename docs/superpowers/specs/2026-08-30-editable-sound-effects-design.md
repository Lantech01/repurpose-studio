# Editable Sound Effects Design

**Date:** 2026-08-30
**Status:** User-approved design, pending implementation plan

## Goal

Replace the generated, full-length SFX bed with independently editable sound
effect clips. A user can keep automatic placement, reject or replace individual
choices, import personal audio, and place any effect at an exact output time.

The feature must support direct timeline editing, overlapping effects, Undo/Redo,
save/reopen, and matching preview/export audio. Regeneration must replace only
automatic effects and must never remove manually placed effects.

## Current Behavior

`SfxPanel` calls `planSfxEvents`, sends the resulting placements to the local
Python renderer, and stores one duration-length `SfxTrack` WAV. The timeline can
only display that full bed, and the user can only change its global gain,
regenerate it, or remove it. Individual effects no longer exist as editable
entities after rendering.

The existing internal library contains these 12 effects:

- Mouse Click
- Double Click
- Keyboard
- Whoosh
- Air Hit
- Correct Ding
- Notification
- Camera Shutter
- Digital Shutter
- Riser
- Impact
- Digital Readout

## Non-Goals

- Downloading or searching third-party sound services.
- Recording audio from a microphone.
- Pitch shifting, time stretching, equalization, or arbitrary audio plug-ins.
- Audio keyframes or automation curves.
- Changing background-music editing.
- Making imported effects available across every project.
- Automatically reflowing SFX when video clips or transcript words move. SFX
  remains authored in output time; the user may regenerate after structural
  edits.
- Redesigning the general Files panel. Imported SFX is managed by the SFX panel.

## User Experience

### Sound Effects panel

The panel has three functions:

1. **Automatic effects.** `Generate SFX` creates separate editable blocks.
   `Regenerate SFX` atomically replaces automatic blocks while preserving every
   manual block.
2. **Import sound.** A file picker accepts `.wav`, `.mp3`, and `.m4a`. A picked
   sound is saved to the project SFX inventory and inserted at the current
   playhead. The same formats can be dropped directly onto the SFX timeline row;
   the horizontal drop position determines the insertion time.
3. **Library.** Built-in and project-imported sounds appear in a searchable,
   categorized list. Each item has an audition control and can be added at the
   playhead or dragged to an exact timeline time.

Starting a library audition stops the previous audition. Audition playback is
panel-only and is never persisted or exported.

### Timeline

Each effect is a distinct focusable block on the SFX row. The block shows its
name, waveform when available, automatic/manual origin, mute state, and selected
state. Blocks are ordered by output start time.

Effects may overlap and play simultaneously. Overlaps are assigned to compact
visual mini-lanes by a pure interval-packing function. Lane assignment is derived
from clip intervals and is not persisted. Moving a clip never changes its audio
because it happened to occupy a different visual mini-lane.

The timeline supports:

- Horizontal drag to move an effect.
- Left and right trim handles to change source in/out points.
- Existing timeline snapping when `snapEnabled` is on.
- File and library-item drops at the pointer's output time.
- Selection by pointer or keyboard focus.
- Delete/Backspace for the selected effect when an editable text control does not
  own the keystroke.
- The existing duplication shortcut for the selected effect.

A move or trim drag has an activation threshold, renders transiently, and commits
once on release. Pointer cancellation restores the persisted value. One completed
gesture creates exactly one Undo entry.

Left trim follows standard slip-aware timeline semantics: moving the left handle
changes `sourceStart` and `timelineStart` by the same delta, preserving the
output-time right edge. Right trim changes `sourceEnd` while keeping
`timelineStart` fixed. Neither handle can reveal audio outside the source or move
the effective block outside the reel.

SFX has one transient `selectedSfxClipId`. Selecting an SFX block clears selected
scene, overlay, word/caption, and other timeline-object selections; selecting any
of those objects clears SFX selection. Editable form controls retain first
keyboard priority. Otherwise Delete/Backspace and duplicate target only the one
selected object, so an SFX command cannot also mutate a scene, word, or overlay.

### Selected-effect controls

Selecting an SFX block exposes:

- Individual volume from `0%` through `200%`.
- Source in and out controls, mirrored by timeline trim handles.
- Fade-in and fade-out from `0s` through `2s`, limited by audible clip length.
- Mute/unmute.
- Duplicate.
- Replace from the built-in or imported library.
- Delete.

Replacement preserves output start, gain, mute, and requested fades. It resets
source-in to `0` and source-out to the replacement's default usable duration,
then clamps the result to the reel. The replacement is a manual decision, so a
replaced automatic clip becomes `manual` and survives later regeneration.

Duplicating any clip creates a `manual` clip, even when the source clip was
automatic. If the duplicate's complete audible duration fits immediately after
the source, it starts there. Otherwise it starts at the source's current
`timelineStart`, intentionally overlapping it. Duplication never shortens the new
clip merely to force it after the source.

## Data Model

The editable source of truth becomes `sfxClips` plus a project-scoped inventory
of imported assets. The old `sfxTrack` field remains read-only migration input.

```ts
export type SfxClipOrigin = "automatic" | "manual";

export type SfxClipSource =
  | { kind: "built-in"; key: ApprovedSfxKey }
  | { kind: "imported"; assetId: string; srcDuration: number }
  | { kind: "legacy"; sourcePath: string; srcDuration: number };

export interface SfxAsset {
  id: string;
  name: string;
  sourcePath: string;
  srcDuration: number;
}

export interface SfxClip {
  id: string;
  name: string;
  source: SfxClipSource;
  origin: SfxClipOrigin;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
  gain: number;
  fadeInSec: number;
  fadeOutSec: number;
  muted: boolean;
}
```

`timelineEnd` is derived as:

```ts
timelineStart + (sourceEnd - sourceStart)
```

Persisted clips reference a built-in key, an imported asset id, or a legacy
absolute path. Browser URLs are derived from those authoritative references on
load; stale `blob:` URLs are never persisted.

Imported clip sources repeat the asset's validated duration so a clip remains
structurally normalizable and visible as missing media even if its inventory
entry is malformed or absent. The inventory remains authoritative for the file
path; the repeated duration is not permission to resolve a different file.

The normalized model enforces:

- `timelineStart` in `[0, projectDuration)`.
- `sourceStart >= 0`.
- `sourceEnd > sourceStart` and no later than decoded source duration.
- A user edit that moves or trims a clip commits a range no longer than the
  remaining project duration.
- `gain` clamped to `[0, 2]`.
- Fades clamped individually to `[0, 2]`.
- If requested fades overlap, both effective fades are scaled proportionally so
  their sum equals the audible clip duration. Requested values remain stored.
- Missing imported assets retain their clip metadata and render as unavailable;
  hydration never silently substitutes another sound.

New built-in clips use the same maximum first-second excerpt, peak normalization,
and default target amplitudes as the current Python renderer: clicks `0.5`,
Whoosh `0.3`, and all other built-ins `0.2`. For a built-in source, preview and
export measure the maximum absolute PCM sample in the usable first-second excerpt
and apply `targetAmplitude / sourcePeak` before the user's clip gain. A silent or
non-finite source is unavailable rather than divided by zero. `gain = 1` therefore
matches the current normalized engine result. Imported clips use their decoded
amplitude directly with `gain = 1` and default to their complete source duration,
clamped to the reel.

## Library and Asset Ingest

A shared built-in catalog is the single mapping from `ApprovedSfxKey` to display
name, category, file identity, known source duration, and default target
amplitude. Categories are `Interaction` (Mouse Click, Double Click, Keyboard),
`Transition` (Whoosh, Air Hit, Riser, Impact), `UI` (Correct Ding,
Notification), `Camera` (Camera Shutter, Digital Shutter), and `Signature`
(Digital Readout). Placement, panel search, preview, and export consume that
catalog rather than maintaining separate filename maps.

The existing asset upload boundary persists imported audio under the local media
root. Before adding an inventory item, the client confirms the response is
playable and reads finite positive duration metadata. Each successful import
creates one inventory entry. Re-importing the same local file is allowed to create
another entry because the existing upload boundary intentionally publishes a new
path; display names are not treated as file identity.

Built-in audio is served by `GET /api/repurpose/sfx?key=<ApprovedSfxKey>` through
the catalog allow-list, with the same GET byte-range behavior required by browser
audio decoding. The client never sends or receives the installation path of a
built-in asset. Existing `GET /api/repurpose/sfx?path=...` remains limited to
generated legacy WAVs. Imported audio keeps using the asset path endpoint with its
realpath and media-root checks. Export reads authoritative sources, never
preview-only blob URLs.

## Automatic Generation

`planSfxEvents(words, clips, duration)` remains the deterministic placement
authority. Each planned event maps to one built-in `SfxClip` instead of being
baked immediately into a full-track WAV.

Generation follows this transaction:

1. Capture project id, project epoch, clips, words, duration, and current SFX
   collection.
2. Plan events in output time.
3. Validate all referenced built-in catalog entries and resolve their durations.
4. Build a complete replacement automatic set in memory.
5. Re-check operation ownership and current project identity.
6. Commit one history entry that retains all current `manual` clips and replaces
   every current `automatic` clip with the new set.

An empty plan or any validation/load failure leaves the complete current
collection unchanged and shows an actionable panel error. Starting another
generation, switching projects, hydration, or unmount cancels stale ownership so
an old request cannot mutate the current project.

Every SFX document edit also invalidates an in-flight generation operation. A
result planned against an older SFX collection cannot overwrite a move, trim,
gain, fade, mute, add, replace, duplicate, or delete that happened while it was
pending.

Generating and regenerating are each one Undo step. Undo restores the prior
automatic collection and leaves the corresponding manual collection exactly as
it was at that historical point.

## Editing and History

`sfxClips` belongs to the editable document snapshot. Add, move, trim, gain, fade,
mute, replace, duplicate, delete, generate, and regenerate are undoable.
`sfxAssets` is passive project inventory and follows the existing media-inventory
rule: importing the asset itself is persisted but is not removed by undoing a
placement.

Selection, audition state, drag transients, decoded buffers, generated waveforms,
and visual mini-lanes are transient. They are not persisted, exported, or stored
in Undo history.

Discrete commands make one history entry. Sliders and pointer drags use explicit
begin/update/end transactions so an arbitrarily long gesture still makes one
entry. No-op commands make none. Undo/Redo, project replacement, hydration, and a
competing timeline gesture cancel active SFX gestures before restoring state.

## Shared Audio Resolution

A pure resolver is the timing authority for both preview and export:

```ts
resolveSfxClipAt(
  clip,
  outputTime,
  projectDuration,
  sourceDuration,
  sourceBaseGain,
)
  -> {
    active: boolean;
    sourceTime: number;
    effectiveGain: number;
    audibleStart: number;
    audibleEnd: number;
  }
```

For an active, unmuted clip:

```ts
localTime = outputTime - timelineStart
sourceTime = sourceStart + localTime
effectiveGain = sourceBaseGain * clip.gain * fadeEnvelope(localTime)
```

Source loading and PCM analysis happen outside this pure resolver. For a built-in
source, callers pass `sourceBaseGain` as
`catalogTargetAmplitude / firstSecondSourcePeak`. Imported and legacy sources use
`sourceBaseGain = 1`. The fade envelope is linear: fade-in moves `0 -> 1`,
fade-out moves `1 -> 0`, and the settled region is `1`. Effective proportional
fade lengths are used when requested fades overlap. Boundary intervals are
start-inclusive and end-exclusive.

The resolver has no playback state and returns the same result when playing,
paused, seeking, or exporting a frame range.

## Preview

Preview replaces the single-track SFX hook with a scheduler for active clips.
Decoded buffers are cached by source identity so ten uses of Whoosh decode once.
The scheduler starts every clip intersecting the current playback interval with
the resolved source offset, gain, and fade envelope. Overlapping clips use
independent gain nodes and therefore mix simultaneously.

Play, pause, seek, rate changes, project switches, source replacement, Undo/Redo,
and SFX edits cancel obsolete scheduled nodes before rescheduling. Muting or gain
changes update immediately. Repeated seeking must not leak AudioBufferSourceNodes
or allow a stale source to continue playing.

## Export

Export consumes normalized `sfxClips`, not a separately rendered preview bed. It
decodes each distinct source once, resamples to the assembled output buffer, and
mixes each clip at its resolved output sample offset with source trim, catalog
default gain, user gain, mute, and fade envelopes.

Sample boundaries derive from the same normalized seconds-to-sample rounding
policy for every clip. Clips that overlap are summed. Existing output limiting or
clamping remains authoritative after voice, music, and all SFX are combined.

Export failure identifies the unavailable SFX by name and aborts atomically. It
must not silently omit a selected effect or fall back to the preview proxy.

## Persistence and Legacy Migration

New snapshots write `sfxClips` and `sfxAssets`; they no longer write a new
`sfxTrack`. Built-in duration comes from the versioned catalog; imported and
legacy clips carry validated duration in their source unions. Hydration can
therefore normalize numeric ranges synchronously without decoding audio, even
when an imported inventory entry is missing. Source URLs are then re-derived. A
missing inventory entry or later decode failure marks the source unavailable but
does not rewrite or discard the normalized clip.

When an old snapshot has `sfxTrack` but no `sfxClips`, hydration creates one
automatic legacy clip:

- Source points to the existing rendered WAV path.
- Persisted source duration comes from the old track's `durationSec`.
- Timeline start and source start are `0`.
- Source end is the smaller of stored track duration and project duration.
- Gain preserves the old whole-bed gain.
- Fades are `0` and mute is false.

The legacy clip continues to preview and export exactly as the old bed. It can be
moved, trimmed, faded, muted, duplicated, replaced, or deleted as one block, but
its baked internal effects cannot be separated. Regeneration removes that
automatic legacy block and replaces it with independent automatic clips while
preserving all manual clips.

After a migrated project is saved, `sfxClips` is authoritative. The old field is
not written again. This migration preserves the existing projects without
requiring the original generation events, which were never persisted.

Project-reference scanning and SFX cache retention must treat every legacy
`sfxClips[].source.sourcePath` as a live reference before new snapshots stop
writing `sfxTrack`. A cache sweep cannot delete a migrated legacy WAV while any
saved project references it.

## Failure and Edge Cases

- Unsupported, empty, zero-duration, undecodable, or non-finite-duration imports
  show an error and create neither an asset nor a clip.
- A failed direct drop creates no partial timeline block.
- Adding at a playhead or drop time at/beyond the reel end moves the new clip
  earlier to `max(0, projectDuration - defaultAudibleDuration)` so its default
  range ends at the reel boundary. A zero-duration project rejects placement.
- A failed replacement leaves the original clip selected and unchanged.
- A failed or cancelled regeneration leaves automatic and manual clips unchanged.
- If project duration shrinks, the same document transaction removes clips wholly
  after the new end and destructively shortens `sourceEnd` for clips crossing the
  new end. Undo restores both project duration and the previous complete SFX
  ranges. Growing duration later without Undo does not restore previously removed
  or trimmed audio.
- If a source becomes unavailable after reload, its block remains visible with a
  missing-media state. Preview skips only that unavailable source and reports the
  problem; export fails rather than silently changing the soundtrack.
- Zero-length normalized clips are rejected rather than scheduled.
- Overlapping clips may exceed one visually packed lane but do not alter z-order,
  gain, or mix order.
- Trim and move operations never change the underlying imported asset or another
  clip referencing it.
- Generated effects remain deterministic for unchanged clips, words, and
  duration; unique UI ids do not affect timing or export.

## Accessibility

- Every library audition, add, replace, mute, duplicate, and delete action has a
  visible label or meaningful accessible name.
- SFX blocks expose name, origin, timeline range, mute state, and selection state
  to assistive technology.
- All selected-effect controls are keyboard operable and display numeric values.
- Focus is preserved after replace and duplicate. After delete, focus moves to
  the nearest remaining SFX block or the SFX row.
- Drag-and-drop is never the only placement path; adding at the playhead is its
  keyboard-accessible equivalent.

## Test Strategy

### Pure unit tests

- Normalize valid, malformed, out-of-range, zero-length, and missing-source
  clips.
- Resolve source time, gain, boundaries, mute, trim, and proportional fades.
- Verify overlapping intervals receive deterministic visual mini-lanes.
- Map generated events to clips with current default excerpts and gain levels.
- Prove regeneration partitions automatic/manual clips correctly.
- Migrate a legacy `SfxTrack` without changing its effective timing or gain.

### Store and component tests

- Add, select, move, trim, gain, fade, mute, replace, duplicate, and delete.
- One Undo entry per discrete command or completed gesture; none for cancel/no-op.
- Generate and regenerate atomically, preserve manual clips, and reject stale
  project operations.
- Preserve manual additions and automatic-to-manual replacements made while a
  stale generation operation is pending; that operation must lose ownership and
  commit nothing.
- Import by picker, add at playhead, direct file drop, library drag, audition, and
  searchable categories.
- Replacement and duplication convert clips to manual origin.
- Keyboard ownership, focus restoration, accessible labels, and missing-media
  presentation.

### Integration and E2E tests

- Save, reload, and hub-reopen a project containing built-in, imported,
  overlapping, muted, trimmed, and faded effects.
- Open an old project with one generated bed, preserve playback, regenerate it
  into blocks, save, and reopen the migrated result.
- Seek and resume through effect boundaries without stale or duplicated audio.
- Compare preview and exported audio timing, amplitude, fades, source trims, and
  simultaneous mixes within deterministic tolerances.
- Verify imported SFX and automatic SFX coexist through regeneration.
- Export 1080p and 4K projects and prove SFX changes do not affect video pixels.
- Confirm voice and background music behavior remains unchanged.

## Acceptance Criteria

1. Automatic generation creates independently selectable SFX blocks rather than
   one full-length bed.
2. A user can import `.wav`, `.mp3`, or `.m4a` by picker or direct timeline drop
   and can reuse it from the project SFX library.
3. Built-in and imported effects can be auditioned, searched, added at the
   playhead, or dragged to an exact output time.
4. Each block supports move, source trim, `0%`-`200%` volume, `0s`-`2s` fades,
   mute, duplicate, replace, and delete.
5. Multiple effects can overlap, remain independently editable, and mix
   simultaneously.
6. Regeneration atomically replaces only automatic clips and always preserves
   manual clips.
7. Replacing or duplicating an automatic clip creates a manual clip that survives
   regeneration.
8. Every document edit has deterministic one-step Undo/Redo behavior, including
   long pointer and slider gestures.
9. Preview and export agree on source time, placement, volume, default catalog
   gain, mute, overlap, trim, and fades.
10. Existing projects with one generated `SfxTrack` reopen without an audible
    change and migrate safely when regenerated or saved.
11. Save/reopen uses stable local source references and never persists transient
    audition, drag, waveform, lane, or decoded-buffer state.
12. The complete project verification gate passes.
