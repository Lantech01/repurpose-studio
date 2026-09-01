# Transcript-Free Playback Design

## Problem

Source video imports already expose inspected media durations, but the editor's
timeline duration is derived only from clips. A new project with both Screen and
Face footage therefore remains at zero duration until a raw transcript creates
clips.

Changing only the Play guard is unsafe because preview, trimming, audio, export,
history, and persistence all use clips for timeline-to-source mapping.

## Product Contract

- A project with no raw transcript becomes playable automatically after both
  Screen and Face footage are ready.
- A single source remains insufficient because the current preview and export
  model requires both sources.
- The initial timeline contains one kept clip from source time zero to the
  shorter positive duration of Screen and Face.
- Importing a raw transcript later replaces the initial full-span clip through
  the existing transcript ingest flow.
- A new transcript-free project derives its name from imported source footage
  when transcript words are unavailable.
- Existing media overlays survive automatic timeline initialization.

## Design

Add a dedicated store action for synchronizing an empty or pristine video
timeline from the two inspected source durations. The action creates one ordinary
full-span clip with a stable bootstrap id and reuses the normal duration
derivation and source-time mapping. It is a no-op when either source is missing,
either duration is invalid, transcript words exist, or the timeline has been
structurally or temporally edited.

The bootstrap is pristine only while all of these remain true: words are empty,
there is exactly one kept clip with the bootstrap id, and its source/timeline span
still matches the previous effective source duration. On source re-import, a
pristine bootstrap is resized to the new shorter duration. A trimmed, split,
duplicated, deleted, reordered, or transcript-derived timeline is not replaced.
Non-temporal clip styling can survive a safe resize.

Initialization is baseline hydration, not a user edit. It must not call
`setClips`, clear overlays, or add an undo step. Existing empty-clip snapshots in
both history branches receive the same bootstrap clip. Re-import similarly
updates only snapshots carrying a pristine bootstrap for the previous duration.
This prevents Undo or Redo from restoring a zero-duration timeline while keeping
the overlay state in every snapshot untouched.

The source import flow invokes this action after both source records are ready.
It passes the previous effective source duration so pristine re-import can be
distinguished from an edited timeline.

Playback checks source availability and media loading/error before timeline
duration. A project with one or no source therefore asks for both source videos,
not for a transcript. Once both paths are present, a missing synthesized timeline
is reported as a duration problem. Source onboarding considers both ready paths
sufficient and describes the transcript as an optional automatic edit path.

Project persistence uses one shared title resolver at both provisional creation
gates. Transcript-derived title wins. Otherwise Screen filename wins, then Face.
The fallback takes `VideoSourceRecord.originalName`, removes its final extension,
strips path/control characters, collapses whitespace, and feeds the result into
the existing dated-slug flow.

Legacy demo word backfill first loads the staged manifest and applies demo words
only when both current footage paths match that manifest. Demo auto-load also
rechecks, immediately before writing, that no source import owner is active and
no footage metadata or clips have appeared. This prevents manual transcript-free
imports from receiving demo words.

## Error Handling

- Before both sources are ready, Play remains disabled with the existing source
  readiness guidance.
- If a source has no positive inspected duration, no timeline is synthesized and
  the existing media error state remains authoritative.
- Re-importing a source resizes only a structurally pristine bootstrap timeline;
  it must not replace an edited or transcript-derived timeline.

## Verification

- Add failing regression tests proving two ready sources initialize one clip with
  the shorter duration while one source and invalid durations do not.
- Prove overlays survive and overlay Undo/Redo cannot restore an empty timeline.
- Cover both duration orderings, pristine source re-import, edited-timeline
  preservation, and later transcript replacement.
- Update transport and onboarding assertions for optional transcripts and source-
  first guidance.
- Prove legacy demo backfill matches staged paths and in-flight manual imports
  cannot be overwritten by demo auto-load.
- Prove a provisional project with empty words derives a sanitized Screen-first
  title, creates, persists, and reopens with its synthesized clip.
- Exercise a new project in Chrome: import Screen and Face without a transcript,
  confirm Play advances, save/reopen, then delete the disposable project.
- Run `npm run verify` and confirm existing projects remain unchanged.
