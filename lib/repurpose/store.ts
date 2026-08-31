import { create } from "zustand";
import { clipForSourceTime, coalesceWordSpans } from "./word-clip-map";
import { applyGapTighten } from "./gap-tighten";
import {
  clampSplitRatio,
  parsePersistedSplitRatio,
} from "./split-ratio";
import { VIDEO_TIMELINE_CLIP_ID } from "./types";
import {
  effectiveVideoTimelineDuration,
  isUntouchedVideoTimeline,
} from "./transcript-application";
import type {
  AttributeClipboard,
  Clip,
  ClipPunch,
  ClipTransition,
  FaceFraming,
  FootageMeta,
  Marker,
  MediaAsset,
  MusicTrack,
  Overlay,
  OverlayEffect,
  OverlayTransform,
  SelectedObject,
  SfxAsset,
  SfxClip,
  SfxClipSource,
  VideoSourceRecord,
  VideoSourceTarget,
  Word,
} from "./types";
import { defaultBuiltInDuration } from "./sfx-effects";
import {
  clampSfxSourceEnd,
  constrainSfxClipsToDuration,
  duplicateSfxClip as duplicateSfxClipValue,
  moveSfxClip as moveSfxClipValue,
  placeSfxClip,
  replaceAutomaticSfxClips as mergeAutomaticSfxClips,
  replaceSfxClipSource as replaceSfxClipSourceValue,
  sfxSourceDuration,
  trimSfxClipLeft as trimSfxClipLeftValue,
  trimSfxClipRight as trimSfxClipRightValue,
} from "./sfx-clips";
import type { EditStats } from "./ingest";
import { DEFAULT_SMART_TRANSITION, footageUrlForPath } from "./ingest";
import type {
  SnapGuide,
  PreviewRect,
  AlignEdge,
  DistributeAxis,
} from "./overlay-geometry";
import {
  applyVisualTransformDeltaToPersisted,
  alignOverlays as computeAlignOverlays,
  distributeOverlays as computeDistributeOverlays,
  clampOverlayToBand,
  isOverlayBandVisible,
  resolveOverlayTransformForFrame,
} from "./overlay-geometry";
import {
  CAPTION_TEMPLATES,
  DEFAULT_CAPTION_STYLE,
  chunkWordsIntoBlocks,
  resolveBlockStyle,
  type CaptionStyle,
  type CaptionBlock,
  type CaptionTemplateId,
} from "./captions";
import { normalizeOverlayAppearance } from "./overlay-effects";

// ===========================================================================
// REPURPOSE STUDIO -- editor store
// ===========================================================================
// Zustand 5 store modeling the full Repurpose Studio editor: the ordered
// clip timeline (retakes clipped out of a raw face-cam + screen recording),
// the split-screen ratio between the two tracks, and per-clip static pan/zoom
// framing for each region (screen + face). Follows the pattern in
// lib/store/editor-store.ts (plain `create<State>((set, get) => ({...}))`, no
// middleware).
//
// Ripple behavior: `timelineStart`/`timelineEnd` are DERIVED, never hand-set.
// `recomputeTimeline` walks `clips` in array order and lays out kept clips
// back-to-back starting at 0; deleted clips collapse to zero width but keep
// their array position (and their last timelineStart as an anchor) so they
// can be restored back into the same place in the sequence. Every mutating
// action ends by calling `recomputeTimeline` on the updated array.
// ===========================================================================

const MIN_CLIP_DURATION = 1 / 30; // seconds; never let a trim invert a clip

export type MediaReadiness = "idle" | "loading" | "ready" | "error";
export type SourceImportRole = "screen" | "face";

const MEDIA_LOADING_REASON = "Media is still loading.";
const MEDIA_ERROR_REASON = "Media could not be loaded.";

type PlaybackPrerequisites = {
  clips: Clip[];
  duration: number;
  footageMeta: FootageMeta | null;
  mediaReadiness: MediaReadiness;
  playbackBlockedReason: string | null;
};

/** One shared playback gate for the store action and every transport UI. */
export function getPlaybackBlockedReason(
  state: PlaybackPrerequisites
): string | null {
  if (
    !state.footageMeta?.faceCamPath.trim() ||
    !state.footageMeta.screenPath.trim()
  ) {
    return "Choose both source videos before playing.";
  }
  if (state.mediaReadiness === "loading") {
    return state.playbackBlockedReason ?? MEDIA_LOADING_REASON;
  }
  if (state.mediaReadiness === "error") {
    return state.playbackBlockedReason ?? MEDIA_ERROR_REASON;
  }
  if (state.clips.length === 0 || state.duration <= 0) {
    return "This project has no playable duration.";
  }
  return null;
}

/**
 * Default filler words removeFillerWords strips (lowercase, punctuation-free).
 * The usual verbal-tic set for a talking-head reel -- hesitation sounds, never
 * real content words. Callers can pass their own set to override.
 */
const DEFAULT_FILLER_WORDS = [
  "um",
  "uh",
  "umm",
  "uhh",
  "er",
  "erm",
  "hmm",
  "mmm",
  "ah",
] as const;

/**
 * Normalize a transcript word for filler matching: lowercase + strip leading/
 * trailing punctuation and whitespace (so "Um," / "uh." / " uh " all reduce to
 * their bare token). Interior characters are untouched. Uses a Unicode-aware
 * class so it works regardless of the transcriber's punctuation style.
 */
function normalizeFillerToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\s\p{P}\p{S}]+/u, "")
    .replace(/[\s\p{P}\p{S}]+$/u, "");
}

// How many undo steps to retain. Old snapshots past this drop off the bottom of
// the `past` stack so a long editing session can't grow history unbounded.
const HISTORY_LIMIT = 100;

// While the SAME continuous gesture (identified by a coalesceKey) keeps
// committing within this window, only its first commit pushes a snapshot -- so a
// trim drag / split drag / slider scrub collapses to ONE undo step. A gap longer
// than this (a new, separate gesture) starts a fresh step even with the same key.
const COALESCE_WINDOW_MS = 700;

// Module-level coalescing cursor: the key + timestamp of the last commit. Lives
// outside the store state (it's bookkeeping, not part of the document) so it
// never lands in a snapshot or triggers a subscriber. Reset whenever a distinct
// commit lands or history is applied/undone.
let lastCommitKey: string | null = null;
let lastCommitAt = 0;

// Monotonic, process-unique clip id source for clips MINTED at runtime (a manual
// split). Ingest clips get deterministic `short-N` ids; a split can happen
// repeatedly (and on an already-split half), so its new ids must be globally
// unique and collision-proof, not derived from the parent's id.
let splitClipCounter = 0;
function nextSplitClipId(): string {
  splitClipCounter += 1;
  return `split-${splitClipCounter}`;
}

// Monotonic, process-unique marker id source: a stable id independent of the
// (t-sorted) markers array so a rename/delete always targets the right pin.
let markerIdCounter = 0;
function nextMarkerId(): string {
  markerIdCounter += 1;
  return `mk-${markerIdCounter}`;
}

let sourceImportToken = 0;

// Monotonic, process-unique overlay id source. Overlays are a separate top-level
// concept (never a Clip); like markers they need a stable id independent of
// their array position so a move/trim/z-reorder always targets the right layer.
let overlayIdCounter = 0;
function nextOverlayId(): string {
  overlayIdCounter += 1;
  return `ovl-${overlayIdCounter}`;
}

// Monotonic, process-unique media-bin id source. A MediaAsset (Files panel entry)
// is a passive inventory item, never a Clip -- like overlays/markers it needs a
// stable id independent of its array position so a remove always targets the right
// row and a placed instance can trace back to it.
let mediaAssetIdCounter = 0;
function nextMediaAssetId(): string {
  mediaAssetIdCounter += 1;
  return `asset-${mediaAssetIdCounter}`;
}

const SFX_ID_SUFFIX_CEILING = 1_000_000_000;

function safeIdSuffix(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) return null;
  const raw = id.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const suffix = Number(raw);
  return Number.isSafeInteger(suffix) && suffix >= 0 && suffix < SFX_ID_SUFFIX_CEILING
    ? suffix
    : null;
}

function nextAvailableSfxId(
  prefix: "sfx-clip-" | "sfx-asset-",
  counter: number,
  usedIds: ReadonlySet<string>
): { id: string; suffix: number } {
  const occupied = new Set<number>();
  for (const id of usedIds) {
    const suffix = safeIdSuffix(id, prefix);
    if (suffix !== null && suffix > 0) occupied.add(suffix);
  }
  const safeCounter = Number.isSafeInteger(counter)
    && counter >= 0
    && counter < SFX_ID_SUFFIX_CEILING
    ? counter
    : 0;
  let suffix = safeCounter >= SFX_ID_SUFFIX_CEILING - 1 ? 1 : safeCounter + 1;
  for (let attempts = 0; attempts <= occupied.size; attempts += 1) {
    if (!occupied.has(suffix)) return { id: `${prefix}${suffix}`, suffix };
    suffix = suffix >= SFX_ID_SUFFIX_CEILING - 1 ? 1 : suffix + 1;
  }
  throw new Error("No safe SFX IDs are available");
}

let sfxClipIdCounter = 0;

function nextAvailableSfxClipId(usedIds: ReadonlySet<string>): string {
  const allocation = nextAvailableSfxId("sfx-clip-", sfxClipIdCounter, usedIds);
  sfxClipIdCounter = allocation.suffix;
  return allocation.id;
}

let sfxAssetIdCounter = 0;

function nextAvailableSfxAssetId(usedIds: ReadonlySet<string>): string {
  const allocation = nextAvailableSfxId("sfx-asset-", sfxAssetIdCounter, usedIds);
  sfxAssetIdCounter = allocation.suffix;
  return allocation.id;
}

// Sane default visible window (output seconds) for a freshly-added overlay: a
// still image gets a 4s window; a video gets its own duration capped at 6s so a
// long clip doesn't drop a wall of timeline. Both are clamped to the project end.
const DEFAULT_IMAGE_OVERLAY_DURATION = 4;
const MAX_DEFAULT_VIDEO_OVERLAY_DURATION = 6;
// Never let an overlay window collapse below the minimum a clip uses.
const MIN_OVERLAY_DURATION = MIN_CLIP_DURATION;

// The 9:16 output aspect (OUTPUT_W / OUTPUT_H = 1080 / 1920). Used to convert an
// overlay's WIDTH-normalized scale into a HEIGHT-normalized extent when placing a
// new overlay in the screen band without a preview rect (the store is pure TS and
// has no getBoundingClientRect). Matches the compositor's 1080x1920 canvas.
const OUTPUT_RATIO = 1080 / 1920; // = 0.5625

/**
 * Cover-scale for an overlay filling the SCREEN (top) band. Returns the
 * WIDTH-normalized `scale` (fraction of output width) at which a source of the
 * given intrinsic size fully COVERS the band `width x (splitRatio*height)`,
 * cropping whatever overflows -- exactly like the screen recording's cover-fit.
 *
 * drawOverlay draws destW = scale*W, destH = destW*(natH/natW). Cover needs
 * destW >= W (scale >= 1) AND destH >= bandH (scale >= (bandH/W)*(natW/natH)).
 * bandH/W = (splitRatio*H)/W = splitRatio / OUTPUT_RATIO. So:
 *   scaleCover = max(1, (splitRatio / OUTPUT_RATIO) * (natW/natH))
 * Independent of absolute pixel size (only aspect + splitRatio matter), so it is
 * correct at 1080p and 4K alike. The overlay is then centered in the top band
 * (x 0.5, y splitRatio/2) and CLIPPED to that band by the compositor.
 */
function screenCoverScale(
  naturalWidth: number,
  naturalHeight: number,
  splitRatio: number
): number {
  const natW = naturalWidth > 0 ? naturalWidth : 1;
  const natH = naturalHeight > 0 ? naturalHeight : 1;
  return Math.max(1, (splitRatio / OUTPUT_RATIO) * (natW / natH));
}

/**
 * Dense-pack overlay `zIndex` to 0..N-1 in ascending z order, preserving relative
 * stacking. Returns a NEW array of NEW overlay objects (only those whose zIndex
 * actually changed are replaced; unchanged ones keep their reference). Overlays
 * stack among THEMSELVES only -- the base face+screen composite is always below.
 */
function densePackOverlayZ(overlays: Overlay[]): Overlay[] {
  const order = [...overlays].sort((a, b) => a.zIndex - b.zIndex);
  const rank = new Map<string, number>();
  order.forEach((o, i) => rank.set(o.id, i));
  return overlays.map((o) => {
    const z = rank.get(o.id) ?? o.zIndex;
    return z === o.zIndex ? o : { ...o, zIndex: z };
  });
}

/** Largest numeric suffix among ids like `<prefix>N`, or 0 if none. */
function maxIdSuffix(ids: (string | undefined)[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const suffix = safeIdSuffix(id, prefix);
    if (suffix !== null && suffix > max) max = suffix;
  }
  return max;
}

/**
 * Advance the module id counters past the highest ids in a RESTORED project, so
 * a freshly-minted id can never collide with a rehydrated one.
 *
 * WHY: the counters live at module scope and reset to 0 on every page reload
 * (module re-eval). A session-restored project (useProjectPersistence) brings
 * back clips/markers with old ids (`split-1`, `mk-1`). Without reseeding, the
 * next mint starts from 0 again and re-issues an id that a rehydrated item
 * already carries -- a DUPLICATE, which React flags as a duplicate `key` and
 * which breaks drag/selection. Call this once, right after a restore lays the
 * state back in, with the restored clips/markers. Idempotent: it only ever
 * raises a counter, never lowers it, so calling it when nothing was restored is
 * a no-op.
 */
export function reseedIdCounters(state: {
  clips?: Clip[];
  markers?: Marker[];
  overlays?: Overlay[];
  mediaAssets?: MediaAsset[];
  sfxClips?: SfxClip[];
  sfxAssets?: SfxAsset[];
}): void {
  splitClipCounter = Math.max(
    splitClipCounter,
    maxIdSuffix((state.clips ?? []).map((c) => c.id), "split-")
  );
  markerIdCounter = Math.max(
    markerIdCounter,
    maxIdSuffix((state.markers ?? []).map((m) => m.id), "mk-")
  );
  overlayIdCounter = Math.max(
    overlayIdCounter,
    maxIdSuffix((state.overlays ?? []).map((o) => o.id), "ovl-")
  );
  mediaAssetIdCounter = Math.max(
    mediaAssetIdCounter,
    maxIdSuffix((state.mediaAssets ?? []).map((a) => a.id), "asset-")
  );
  sfxClipIdCounter = Math.max(
    sfxClipIdCounter,
    maxIdSuffix((state.sfxClips ?? []).map((clip) => clip.id), "sfx-clip-")
  );
  sfxAssetIdCounter = Math.max(
    sfxAssetIdCounter,
    maxIdSuffix((state.sfxAssets ?? []).map((asset) => asset.id), "sfx-asset-")
  );
}

function sfxSourceEqual(a: SfxClipSource, b: SfxClipSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "built-in" && b.kind === "built-in") return a.key === b.key;
  if (a.kind === "imported" && b.kind === "imported") {
    return a.assetId === b.assetId && a.srcDuration === b.srcDuration;
  }
  if (a.kind === "legacy" && b.kind === "legacy") {
    return a.sourcePath === b.sourcePath && a.srcDuration === b.srcDuration;
  }
  return false;
}

function sfxClipEqual(a: SfxClip, b: SfxClip): boolean {
  return a === b || (
    a.id === b.id
    && a.name === b.name
    && sfxSourceEqual(a.source, b.source)
    && a.origin === b.origin
    && a.timelineStart === b.timelineStart
    && a.sourceStart === b.sourceStart
    && a.sourceEnd === b.sourceEnd
    && a.gain === b.gain
    && a.fadeInSec === b.fadeInSec
    && a.fadeOutSec === b.fadeOutSec
    && a.muted === b.muted
  );
}

function sfxDocumentEqual(a: readonly SfxClip[], b: readonly SfxClip[]): boolean {
  return a === b || (
    a.length === b.length && a.every((clip, index) => sfxClipEqual(clip, b[index]))
  );
}

function sfxClipContentEqual(a: SfxClip, b: SfxClip): boolean {
  return sfxClipEqual(
    { ...a, id: b.id, origin: b.origin },
    b
  );
}

function recomputeTimeline(clips: Clip[]): Clip[] {
  let cursor = 0;
  return clips.map((clip) => {
    if (!clip.kept) {
      // Deleted clips contribute no duration; collapse to a zero-width
      // marker anchored at the current cursor so restoring it re-inserts
      // it exactly where playback currently is in the sequence.
      return { ...clip, timelineStart: cursor, timelineEnd: cursor };
    }
    const duration = Math.max(0, clip.srcEnd - clip.srcStart);
    const timelineStart = cursor;
    const timelineEnd = cursor + duration;
    cursor = timelineEnd;
    return { ...clip, timelineStart, timelineEnd };
  });
}

function deriveDuration(clips: Clip[]): number {
  const kept = clips.filter((c) => c.kept);
  if (kept.length === 0) return 0;
  return kept.reduce((max, c) => Math.max(max, c.timelineEnd), 0);
}

function overlayEffectEqual(a: OverlayEffect, b: OverlayEffect): boolean {
  return (
    a.type === b.type &&
    a.durationSec === b.durationSec &&
    a.direction === b.direction
  );
}

function normalizeClipSplitRatio(clip: Clip): Clip {
  if (clip.splitRatio === undefined) return clip;
  const splitRatio = clampSplitRatio(clip.splitRatio);
  if (splitRatio === null) {
    const { splitRatio: _invalidSplitRatio, ...rest } = clip;
    return rest;
  }
  return splitRatio === clip.splitRatio ? clip : { ...clip, splitRatio };
}

function normalizeClipSplitRatios(clips: Clip[]): Clip[] {
  let changed = false;
  const normalized = clips.map((clip) => {
    const next = normalizeClipSplitRatio(clip);
    if (next !== clip) changed = true;
    return next;
  });
  return changed ? normalized : clips;
}

function videoTimelineClip(duration: number): Clip {
  return {
    id: VIDEO_TIMELINE_CLIP_ID,
    kind: "take",
    label: "Full video",
    srcStart: 0,
    srcEnd: duration,
    timelineStart: 0,
    timelineEnd: duration,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 0, end: duration }],
    keeperIndex: 0,
  };
}

function synchronizeVideoTimelineClips(
  clips: Clip[],
  words: Word[],
  previousDuration: number | null,
  nextDuration: number
): Clip[] {
  if (words.length > 0) return clips;
  if (clips.length === 0) return [videoTimelineClip(nextDuration)];
  if (
    !isUntouchedVideoTimeline({
      clips,
      words,
      effectiveDuration: previousDuration,
    }) ||
    Math.abs(nextDuration - previousDuration!) <= 1e-6
  ) {
    return clips;
  }
  return recomputeTimeline([
    {
      ...clips[0],
      srcEnd: nextDuration,
      occurrences: [{ start: 0, end: nextDuration }],
    },
  ]);
}

/**
 * Ripple free-floating overlays across a scene DELETE.
 *
 * Overlays are normally hand-placed and never ripple with clip edits -- BUT when
 * a whole scene (a kept clip) is deleted, the timeline collapses that scene's
 * output window `[winStart, winEnd)` and shifts everything after it LEFT by the
 * scene's duration `d = winEnd - winStart`. An overlay that sat OVER that scene
 * belonged to it (that's how FCPXML B-roll is imported -- anchored to the words
 * it covers), so leaving it floating orphans it over the wrong content (the bug
 * Manthan flagged). This re-anchors overlays to match the collapse:
 *   - fully BEFORE the deleted window  -> unchanged.
 *   - fully AFTER  (start >= winEnd)   -> shifted left by `d`.
 *   - fully INSIDE the deleted window  -> removed (its scene is gone).
 *   - STRADDLING the window            -> the portion inside the window is cut,
 *     the surviving portion (before and/or after) is kept: the before-part stays,
 *     the after-part is pulled to winStart (its content moved there). If nothing
 *     survives >= MIN_OVERLAY_AFTER_DELETE, the overlay is dropped.
 *
 * This is applied ONLY on deleteClip (restoreClip re-inserts the overlays the
 * ripple removed, via overlayDeleteStash below), never on a free overlay drag --
 * overlays stay free-floating everywhere else.
 */
const MIN_OVERLAY_AFTER_DELETE = 0.15; // drop a slice thinner than this (seconds)
function rippleOverlaysAfterDelete(
  overlays: Overlay[],
  winStart: number,
  winEnd: number
): Overlay[] {
  const d = winEnd - winStart;
  if (d <= 0) return overlays;
  const out: Overlay[] = [];
  for (const o of overlays) {
    // Clip the overlay window against the deleted window -> a "before" slice
    // [start, min(end, winStart)) and an "after" slice [max(start, winEnd), end)
    // shifted left by d. Any part strictly inside [winStart, winEnd) is removed.
    const beforeEnd = Math.min(o.timelineEnd, winStart);
    const afterStart = Math.max(o.timelineStart, winEnd);

    const hasBefore = beforeEnd - o.timelineStart >= MIN_OVERLAY_AFTER_DELETE;
    const hasAfter = o.timelineEnd - afterStart >= MIN_OVERLAY_AFTER_DELETE;

    if (!hasBefore && !hasAfter) {
      // Entirely inside the deleted scene (or only sub-threshold slivers survive).
      continue;
    }

    // The surviving window after collapse: keep the before part as-is, and pull
    // the after part left by d. When both exist (overlay straddles the whole
    // scene), they become contiguous at winStart, so we merge into one window
    // [origStart, (beforeLen) + (afterLen)] anchored at the original start.
    let newStart: number;
    let newEnd: number;
    let srcDelta = 0; // shift into the overlay's OWN media for a trimmed-front video
    if (hasBefore && hasAfter) {
      const beforeLen = beforeEnd - o.timelineStart;
      const afterLen = o.timelineEnd - afterStart;
      newStart = o.timelineStart;
      newEnd = o.timelineStart + beforeLen + afterLen;
    } else if (hasBefore) {
      newStart = o.timelineStart;
      newEnd = beforeEnd;
    } else {
      // after-only: its content moved left by d. Front of the overlay was trimmed
      // by (afterStart - o.timelineStart), so advance the video's own srcStart too.
      srcDelta = afterStart - o.timelineStart;
      newStart = afterStart - d;
      newEnd = o.timelineEnd - d;
    }
    out.push({
      ...o,
      timelineStart: newStart,
      timelineEnd: newEnd,
      srcStart: o.kind === "video" ? o.srcStart + srcDelta : o.srcStart,
    });
  }
  return densePackOverlayZ(out);
}

/**
 * Overlays rippleOverlaysAfterDelete REMOVED, keyed by the deleted clip's id, so
 * restoreClip can bring them back (delete scene -> restore scene must round-trip
 * without losing its B-roll). Session-only by design: not in the project
 * snapshot and not in undo history (undo already restores overlays via its own
 * snapshot). Timings are stashed in the delete-time timeline; restore re-anchors
 * them by the delta between the old and new window start. Straddling overlays
 * that survived truncated are NOT stashed -- only fully-removed ones.
 */
const overlayDeleteStash = new Map<
  string,
  { winStart: number; removed: Overlay[] }
>();

/**
 * Stage-3 auto-merge (word delete/restore tail): collapse ARRAY-ADJACENT kept
 * fragments that descend from ONE continuous take back into a single clip, so a
 * long editing session of word deletes/restores never leaves the timeline
 * fragmented into dozens of source-contiguous slivers.
 *
 * Two clips `prev` (at i) and `next` (at i+1) merge IFF ALL hold:
 *   - both kept === true and both kind === "take"
 *   - same lineage: (prev.originId ?? prev.id) === (next.originId ?? next.id)
 *   - source-contiguous: |prev.srcEnd - next.srcStart| < 1e-6 (next resumes the
 *     source exactly where prev left off -- one uncut take, not two clips that
 *     merely share a lineage id)
 *   - same split: prev.splitRatio === next.splitRatio (both undefined is equal)
 *   - next.transitionIn is a plain internal cut: undefined, or type "none" (a
 *     real user-set transition is a boundary we must NOT dissolve)
 *
 * The merged clip is { ...prev, srcEnd: next.srcEnd, single-occurrence range,
 * keeperIndex: 0 } -- it keeps prev's id + transitionIn + splitRatio + originId
 * and DROPS next. We re-scan from the merged clip (don't advance i) so a chain
 * of >2 source-contiguous fragments collapses in one pass.
 *
 * CRITICAL GUARD -- never collapse across a fresh delete: a word delete parks
 * the cut footage in a kept:false GHOST clip of the SAME originId that sits
 * BETWEEN the two surviving kept fragments in the array. Because we only ever
 * merge fragments that are ARRAY-ADJACENT (prev at i, next at i+1), that ghost
 * physically separates them (prev, ghost, next), so array-adjacency ALONE
 * already prevents a merge across a ghost -- there is no extra guard needed and
 * no risk of swallowing a restorable deleted-word span. Only truly adjacent
 * kept fragments (nothing between them) ever merge.
 *
 * Pure: never mutates the input; returns a NEW array (same length if no merge).
 */
/**
 * True when two clips carry the same per-scene FRAMING override (both absent
 * counts). Shared by the face + screen guards below -- a FaceFraming is the same
 * shape for both regions, so one comparator serves both.
 */
function sameFraming(
  a: FaceFraming | undefined,
  b: FaceFraming | undefined
): boolean {
  if (a === b) return true; // same ref, or both undefined (the common case)
  if (!a || !b) return false; // one frozen, one unfrozen -> different
  return a.x === b.x && a.y === b.y && a.scale === b.scale;
}

/** True when two clips carry the same per-scene face framing (both absent counts). */
function sameFaceFraming(
  a: FaceFraming | undefined,
  b: FaceFraming | undefined
): boolean {
  return sameFraming(a, b);
}

/** True when two clips carry the same per-scene SCREEN framing (both absent counts). */
function sameScreenFraming(
  a: FaceFraming | undefined,
  b: FaceFraming | undefined
): boolean {
  return sameFraming(a, b);
}

/**
 * True when two clips carry the same zoom PUNCH (both absent counts). A punch is
 * a per-scene render-time decorator exactly like the framing overrides, so it
 * needs the same merge guard: a fragment carrying its own punch must not be
 * folded away (which would keep only prev's punch and silently drop this one).
 */
function samePunch(a: ClipPunch | undefined, b: ClipPunch | undefined): boolean {
  if (a === b) return true; // same ref, or both undefined (the common case)
  if (!a || !b) return false; // one punched, one not -> different
  return (
    a.atSrc === b.atSrc &&
    a.amount === b.amount &&
    a.holdSec === b.holdSec &&
    a.ease === b.ease
  );
}

function mergeAdjacentKeptFragments(clips: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const clip of clips) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.kept &&
      clip.kept &&
      prev.kind === "take" &&
      clip.kind === "take" &&
      (prev.originId ?? prev.id) === (clip.originId ?? clip.id) &&
      Math.abs(prev.srcEnd - clip.srcStart) < 1e-6 &&
      prev.splitRatio === clip.splitRatio &&
      // Same per-scene face framing on both pieces, else a merge would silently
      // drop the second piece's override (the merged clip keeps prev's framing).
      // A scene the user UNFROZE + reframed on only one half of a split must stay
      // its own clip. Same guard as splitRatio above.
      sameFaceFraming(prev.faceFraming, clip.faceFraming) &&
      // SCREEN framing is the exact structural twin of faceFraming (per-scene
      // pan/zoom of the top region), so it needs the identical guard: without it
      // a reframe applied to only one half of a delete/restore split is silently
      // dropped when the fragments re-merge. Same reasoning as faceFraming above.
      sameScreenFraming(prev.screenFraming, clip.screenFraming) &&
      // Zoom PUNCH is another per-scene render-time decorator (screenPunch /
      // facePunch), so it needs the same guard: without it a punch added to only
      // one half of a delete/restore split is silently dropped on re-merge, the
      // same data-loss class the framing guards above prevent.
      samePunch(prev.screenPunch, clip.screenPunch) &&
      samePunch(prev.facePunch, clip.facePunch) &&
      (clip.transitionIn === undefined || clip.transitionIn.type === "none")
    ) {
      // Fold `clip` into `prev`: extend prev's source out point over clip,
      // keeping prev's id + transitionIn + splitRatio + faceFraming + originId.
      // Re-scanning from the merged clip is automatic -- it stays
      // `out[out.length - 1]`, so the NEXT iteration compares it against
      // clip[i+2], collapsing a chain.
      out[out.length - 1] = {
        ...prev,
        srcEnd: clip.srcEnd,
        occurrences: [{ start: prev.srcStart, end: clip.srcEnd }],
        keeperIndex: 0,
      };
      continue;
    }
    out.push(clip);
  }
  return out;
}

/**
 * Forward cut for the WORD-DELETE path: soft-delete the source span [s0, s1)
 * out of the CURRENT clips by replacing the single KEPT clip that owns the span
 * start with up to three pieces -- a kept left remainder, a `kept:false` GHOST
 * carrier over the cut (the restorable unit), and a kept right remainder.
 *
 * WHY a split + soft-delete rather than a trim: a trim discards footage with no
 * restorable handle. The ghost clip IS the restore handle -- flipping it back to
 * `kept:true` (restoreWords) puts the deleted words straight back. Every deleted
 * word therefore always leaves a `kept:false` clip behind, never raw lost time.
 *
 * Containment + clamping (mirrors sourceToTimelineTime's half-open contract):
 *   - Find the FIRST kept clip whose [srcStart, srcEnd) contains `s0` (`<` on the
 *     right edge, no epsilon, zero/negative-width skipped). We anchor on the SPAN
 *     START so one straddling word can never cut two clips.
 *   - CLAMP the cut to that clip: cutStart = max(s0, srcStart),
 *     cutEnd = min(s1, srcEnd). A span that runs past the clip's end only removes
 *     up to this clip's out point (the next word's own delete handles its clip).
 *   - Whole-clip case (the clamped cut covers the entire clip) -> just flip that
 *     clip `kept:false` in place (no split, keeps its id + transition).
 *
 * MIN_CLIP_DURATION snapping: a kept remainder shorter than the minimum would be
 * a degenerate sliver, so it is FOLDED INTO THE GHOST -- a tiny left remainder
 * extends cutStart DOWN to srcStart (the whole left edge joins the ghost); a tiny
 * right remainder extends cutEnd UP to srcEnd. This can only ever GROW the ghost
 * and shrink/remove a kept piece, so no kept piece is ever left below the minimum.
 *
 * Pieces (all inherit `originId = clip.originId ?? clip.id`, so Stage-3 auto-merge
 * can rejoin the surviving remainders that came from one continuous take):
 *   - left  [srcStart .. cutStart]  kept:true, KEEPS the original id + transitionIn
 *   - ghost [cutStart .. cutEnd]    kept:false, FRESH split id, no transition,
 *                                   isKeeperTake false, single-occurrence range
 *   - right [cutEnd .. srcEnd]      kept:true, FRESH split id, no transition
 *
 * Returns the clips array with that one clip replaced in place (order preserved),
 * or the ORIGINAL array unchanged when no kept clip contains `s0`. Timeline layout
 * is NOT recomputed here -- the caller folds every span through first, then runs
 * recomputeTimeline once. Pure: never mutates the input clips.
 */
function cutSourceSpanFromClips(clips: Clip[], s0: number, s1: number): Clip[] {
  // First kept clip whose half-open [srcStart, srcEnd) contains the span start.
  // Same guard/comparisons as sourceToTimelineTime: skip zero/negative-width,
  // `<` on the right edge, no epsilon.
  const index = clips.findIndex(
    (c) => c.kept && c.srcEnd > c.srcStart && s0 >= c.srcStart && s0 < c.srcEnd
  );
  if (index === -1) return clips; // span start isn't inside any kept clip -- no-op

  const clip = clips[index];
  const originId = clip.originId ?? clip.id;

  // Clamp the cut to THIS clip so a straddling word never bleeds into a neighbor.
  let cutStart = Math.max(s0, clip.srcStart);
  let cutEnd = Math.min(s1, clip.srcEnd);

  // Fold an undersized kept remainder into the ghost so no kept sliver survives.
  if (cutStart - clip.srcStart < MIN_CLIP_DURATION) cutStart = clip.srcStart;
  if (clip.srcEnd - cutEnd < MIN_CLIP_DURATION) cutEnd = clip.srcEnd;

  const next = [...clips];

  // Whole-clip soft delete: the (snapped) cut now spans the entire clip. Flip it
  // in place -- keep its id + transition so a restore returns it verbatim.
  if (cutStart <= clip.srcStart && cutEnd >= clip.srcEnd) {
    next.splice(index, 1, { ...clip, kept: false });
    return next;
  }

  const pieces: Clip[] = [];
  const hasLeft = cutStart > clip.srcStart;
  const hasRight = cutEnd < clip.srcEnd;

  // Left remainder: keeps the original id + incoming transition (it still enters
  // at the original boundary) and its own single-occurrence source range.
  if (hasLeft) {
    pieces.push({
      ...clip,
      srcEnd: cutStart,
      occurrences: [{ start: clip.srcStart, end: cutStart }],
      keeperIndex: 0,
      isKeeperTake: false,
      originId,
    });
  }

  // Ghost: the restorable deleted-word carrier. Fresh split id, no transition,
  // kept:false. If there's no left remainder it inherits the original id so the
  // slot still carries a stable, non-colliding id (the original id is now free).
  pieces.push({
    ...clip,
    id: hasLeft ? nextSplitClipId() : clip.id,
    srcStart: cutStart,
    srcEnd: cutEnd,
    occurrences: [{ start: cutStart, end: cutEnd }],
    keeperIndex: 0,
    isKeeperTake: false,
    kept: false,
    transitionIn: hasLeft ? undefined : clip.transitionIn,
    originId,
  });

  // Right remainder: the clip resumes AFTER the deleted words, so on the output
  // timeline it's a REAL visible cut (the removed span leaves a source jump), not
  // a silent continuation -- so it earns the default Smart transition (a subtle
  // Descript-feel settle, never a pop; DEFAULT_SMART_TRANSITION is amount:0.025).
  // Fresh split id, own single-occurrence range.
  if (hasRight) {
    pieces.push({
      ...clip,
      id: nextSplitClipId(),
      srcStart: cutEnd,
      occurrences: [{ start: cutEnd, end: clip.srcEnd }],
      keeperIndex: 0,
      isKeeperTake: false,
      transitionIn: { ...DEFAULT_SMART_TRANSITION },
      originId,
    });
  }

  next.splice(index, 1, ...pieces);
  return next;
}

/**
 * The manual per-block customizations chunkWordsIntoBlocks throws away on every
 * re-chunk (it re-derives ids + freshly slices words). We stash these off the
 * CURRENT blocks before a rebuild and re-attach them onto the freshly-chunked
 * blocks by matching on the block's FIRST-word source start (the one anchor a
 * re-chunk preserves for a block that still begins at the same word).
 */
interface CaptionOverrides {
  overrideStyle?: Partial<CaptionStyle>;
  keywordIndex?: number;
  textOverride?: string[];
}

/** Remove contradictory persisted position keys for explicit attachment modes. */
export function normalizeCaptionBlockPlacement(block: CaptionBlock): CaptionBlock {
  const override = block.overrideStyle;
  if (!override || typeof override !== "object") return block;
  if (override.pinToSplit === true) {
    if (!("positionYPct" in override) && !("splitOffsetPct" in override)) {
      return block;
    }
    const {
      positionYPct: _positionYPct,
      splitOffsetPct: _splitOffsetPct,
      ...rest
    } = override;
    return { ...block, overrideStyle: { ...rest, pinToSplit: true } };
  }
  if (override.pinToSplit !== false) return block;

  const rawPosition = override.positionYPct;
  const positionYPct = Number.isFinite(rawPosition)
    ? Math.max(0, Math.min(1, rawPosition as number))
    : undefined;
  const hasStaleOffset = "splitOffsetPct" in override;
  const hasInvalidPosition =
    "positionYPct" in override && positionYPct === undefined;
  if (
    !hasStaleOffset &&
    !hasInvalidPosition &&
    positionYPct === rawPosition
  ) {
    return block;
  }
  const {
    splitOffsetPct: _splitOffsetPct,
    positionYPct: _positionYPct,
    ...rest
  } = override;
  return {
    ...block,
    overrideStyle: {
      ...rest,
      pinToSplit: false,
      ...(positionYPct !== undefined ? { positionYPct } : {}),
    },
  };
}

/**
 * A block's id is namespaced `${clipId}--${b.id}` (see rebuildCaptionBlocks).
 * Clip ids are `clip-N-ms` / `split-N` and never contain `--`, so the clip id
 * is exactly the prefix before the FIRST `--`. Returns null when the id carries
 * no namespace (e.g. a legacy/global block), in which case the block can't be
 * keyed to a specific clip and we fall back to first-word start alone.
 */
function clipIdFromBlockId(blockId: string): string | null {
  const sep = blockId.indexOf("--");
  return sep === -1 ? null : blockId.slice(0, sep);
}

/**
 * Build the composite override-lookup key for a block: `${clipId}:${startMs}`.
 * Keying by clip id (not just start ms) keeps two DIFFERENT kept clips that
 * reuse the SAME source span (duplicated / retake footage) from collapsing to
 * one override entry -- each clip's manual override stays with its own clip.
 * Falls back to a bare `:${startMs}` when the block id has no clip namespace.
 */
function overrideKey(block: CaptionBlock): string | null {
  const first = block.words[0];
  if (!first) return null;
  const startMs = Math.round(first.start * 1000);
  const clipId = clipIdFromBlockId(block.id);
  return `${clipId ?? ""}:${startMs}`;
}

interface CaptionOverrideIndex {
  exact: Map<string, CaptionOverrides>;
  legacyByStart: Map<number, CaptionOverrides[]>;
}

/**
 * Index namespaced overrides by their exact `${clipId}:${startMs}` key. Legacy
 * unnamespaced overrides are queued by start in persisted order so each can be
 * consumed at most once when multiple clips reuse the same source anchor.
 */
function indexOverridesByFirstWordStart(
  blocks: CaptionBlock[]
): CaptionOverrideIndex {
  const exact = new Map<string, CaptionOverrides>();
  const legacyByStart = new Map<number, CaptionOverrides[]>();
  for (const b of blocks) {
    const normalized = normalizeCaptionBlockPlacement(b);
    const hasOverride =
      normalized.overrideStyle !== undefined ||
      normalized.keywordIndex !== undefined ||
      normalized.textOverride !== undefined;
    if (!hasOverride) continue;
    const first = normalized.words[0];
    if (!first) continue;
    const saved = {
      overrideStyle: normalized.overrideStyle,
      keywordIndex: normalized.keywordIndex,
      textOverride: normalized.textOverride,
    };
    const clipId = clipIdFromBlockId(normalized.id);
    if (clipId !== null) {
      exact.set(`${clipId}:${Math.round(first.start * 1000)}`, saved);
      continue;
    }
    const startMs = Math.round(first.start * 1000);
    const queue = legacyByStart.get(startMs) ?? [];
    queue.push(saved);
    legacyByStart.set(startMs, queue);
  }
  return { exact, legacyByStart };
}

/**
 * Re-attach an exact namespaced override when available, otherwise consume the
 * next legacy override at the same first-word start. Exact matches never consume
 * the fallback queue, and fallback entries never duplicate across clips.
 * Mutates + returns the same array (throwaway locals).
 *
 * textOverride is length-sensitive (it's positional per word). A re-chunk can
 * change a block's word count (density/budget change), so only re-attach a
 * stashed textOverride when its length still matches the new block's word count;
 * otherwise drop it (the positional mapping is no longer valid).
 */
function reattachOverrides(
  clipBlocks: CaptionBlock[],
  previous: CaptionOverrideIndex
): CaptionBlock[] {
  if (previous.exact.size === 0 && previous.legacyByStart.size === 0) {
    return clipBlocks;
  }
  for (const b of clipBlocks) {
    const key = overrideKey(b);
    if (key === null) continue;
    let saved = previous.exact.get(key);
    if (saved) {
      previous.exact.delete(key);
    } else {
      const first = b.words[0];
      const queue = first
        ? previous.legacyByStart.get(Math.round(first.start * 1000))
        : undefined;
      saved = queue?.shift();
      if (queue?.length === 0 && first) {
        previous.legacyByStart.delete(Math.round(first.start * 1000));
      }
    }
    if (!saved) continue;
    if (saved.overrideStyle !== undefined) b.overrideStyle = saved.overrideStyle;
    if (saved.keywordIndex !== undefined) b.keywordIndex = saved.keywordIndex;
    if (
      saved.textOverride !== undefined &&
      saved.textOverride.length === b.words.length
    ) {
      b.textOverride = saved.textOverride;
    }
  }
  return clipBlocks;
}

function buildCaptionBlocksForState(input: {
  words: Word[];
  clips: Clip[];
  deletedWordIndices: number[];
  style: CaptionStyle;
  previousBlocks?: CaptionBlock[];
}): CaptionBlock[] {
  const previousOverrides = indexOverridesByFirstWordStart(
    input.previousBlocks ?? []
  );
  const deleted = new Set(input.deletedWordIndices);
  const kept = input.clips
    .filter((clip) => clip.kept)
    .sort((a, b) => a.timelineStart - b.timelineStart);
  const blocks: CaptionBlock[] = [];

  for (const clip of kept) {
    const words = input.words.filter(
      (word, index) =>
        !deleted.has(index) &&
        word.start >= clip.srcStart &&
        word.start < clip.srcEnd
    );
    if (words.length === 0) continue;
    const clipBlocks = chunkWordsIntoBlocks(words, input.style).map((block) => ({
      ...block,
      id: `${clip.id}--${block.id}`,
    }));
    reattachOverrides(clipBlocks, previousOverrides);
    blocks.push(...clipBlocks);
  }

  return blocks;
}

/**
 * Capture the current editable slice as an undo snapshot. Every store action
 * replaces (never mutates) these arrays/objects, so copying the references is a
 * faithful, cheap snapshot -- no deep clone needed.
 */
function captureSnapshot(state: RepurposeState): EditableSnapshot {
  return {
    clips: state.clips,
    splitRatio: state.splitRatio,
    screenGrade: state.screenGrade,
    faceGrade: state.faceGrade,
    words: state.words,
    captionsEnabled: state.captionsEnabled,
    captionStyle: state.captionStyle,
    captionBlocks: state.captionBlocks,
    markers: state.markers,
    overlays: state.overlays,
    sfxClips: state.sfxClips,
    deletedWordIndices: state.deletedWordIndices,
  };
}

/**
 * Turn a restored snapshot back into a store patch, re-deriving `duration` from
 * the restored clips (duration is derived, never stored in history).
 */
function snapshotToPatch(snap: EditableSnapshot): Partial<RepurposeState> {
  const clips = normalizeClipSplitRatios(snap.clips);
  const duration = deriveDuration(clips);
  const sfxClips = constrainSfxClipsToDuration(snap.sfxClips, duration);
  return {
    ...snap,
    clips,
    splitRatio: parsePersistedSplitRatio(snap.splitRatio, 0.5),
    duration,
    sfxClips,
  };
}

function exclusiveSfxSelection(selectedSfxClipId: string) {
  return {
    selectedSfxClipId,
    selectedClipId: null,
    selectedOverlayId: null,
    selectedOverlayIds: [],
    selectedWordRange: null,
    selectedCaptionBlockId: null,
  };
}

/**
 * The exact slice of the store that undo/redo tracks -- the "document", i.e.
 * everything an edit changes and that should be restored on undo. Transient
 * playback/selection state (playhead, isPlaying, selectedClipId,
 * selectedOverlayId), the loaded footageMeta, and the loop-region marks are
 * DELIBERATELY excluded: undo should
 * restore the edit, not yank the playhead around or reload footage. `duration`
 * is derived from `clips`, so it's recomputed on restore rather than stored.
 *
 * Everything here is plain JSON (arrays/objects of numbers/strings/booleans),
 * so a structuredClone-free shallow copy of the arrays is a faithful snapshot:
 * every store action produces NEW array/object references (never mutates in
 * place), so holding the old reference in history keeps the old value intact.
 */
interface EditableSnapshot {
  clips: Clip[];
  splitRatio: number;
  screenGrade: string;
  faceGrade: string;
  words: Word[];
  captionsEnabled: boolean;
  captionStyle: CaptionStyle;
  captionBlocks: CaptionBlock[];
  markers: Marker[];
  /**
   * Free-floating external media overlays. Part of undo history (an overlay
   * add/move/trim/transform/delete is a document edit that undo restores) --
   * unlike the transient `selectedOverlayId` which stays out of history. Overlays
   * never ripple with clip/word edits.
   */
  overlays: Overlay[];
  /** Independent output-time SFX clips. Assets and transient audio state stay out. */
  sfxClips: SfxClip[];
  /**
   * Raw word indices the user has explicitly deleted from the short (sorted
   * plain number[]). The AUTHORITY for word deletion -- the clip cut is a derived
   * consequence. Tracked in history so undo/redo restores the strikethrough set
   * in lockstep with the clip surgery it drove.
   */
  deletedWordIndices: number[];
}

export type CaptionGestureCompletion =
  | { kind: "attach" }
  | { kind: "detach"; positionYPct: number };

function synchronizeVideoTimelineSnapshot(
  snapshot: EditableSnapshot,
  previousDuration: number | null,
  nextDuration: number
): EditableSnapshot {
  const clips = synchronizeVideoTimelineClips(
    snapshot.clips,
    snapshot.words,
    previousDuration,
    nextDuration
  );
  const sfxClips = constrainSfxClipsToDuration(snapshot.sfxClips, deriveDuration(clips));
  return clips === snapshot.clips && sfxDocumentEqual(sfxClips, snapshot.sfxClips)
    ? snapshot
    : { ...snapshot, clips, sfxClips };
}

export type SfxGestureKind =
  | "move"
  | "left-trim"
  | "right-trim"
  | "source-in"
  | "source-out"
  | "gain"
  | "fade-in"
  | "fade-out";

export interface AddSfxClipInput {
  name: string;
  source: SfxClipSource;
  atTime: number;
  origin?: SfxClip["origin"];
  sourceStart?: number;
  sourceEnd?: number;
  gain?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  muted?: boolean;
}

export interface AddImportedSfxInput {
  name: string;
  sourcePath: string;
  srcDuration: number;
  atTime: number;
}

interface RepurposeState {
  clips: Clip[];
  duration: number;

  // --- undo / redo ----------------------------------------------------------
  /** Past editable snapshots, oldest first; the last entry is the state before the most recent edit. */
  past: EditableSnapshot[];
  /** Redo stack: snapshots undone off `past`, most-recently-undone last. */
  future: EditableSnapshot[];
  /** Step backward one edit. No-op when `past` is empty. */
  undo: () => void;
  /** Re-apply the last undone edit. No-op when `future` is empty. */
  redo: () => void;
  /**
   * INTERNAL: push the current editable state onto `past` and clear `future`.
   * Every user-facing mutating action calls this BEFORE it mutates, so `undo`
   * can restore the pre-edit state. Not meant to be called from the UI directly
   * (use the mutating actions); exposed on the store only so actions can reach
   * it via `get()`.
   *
   * `coalesceKey` collapses a burst of the same continuous gesture (a trim
   * drag, a split drag, a slider scrub -- each fires the action dozens of times
   * per second) into ONE undo step: while the same key keeps arriving inside
   * COALESCE_WINDOW_MS, only the FIRST call pushes a snapshot (the pre-gesture
   * state); the rest are folded in. Discrete edits (delete, reorder, template
   * pick) pass no key and always create their own step.
   */
  commitHistory: (coalesceKey?: string) => void;

  splitRatio: number; // 0 - 1, fraction of frame height given to Screen (top)

  /**
   * Descript-style color-grade preset ids per track (see
   * lib/repurpose/color-grade.ts). Default "none" (untouched). Applied
   * identically in the live preview (PreviewCanvas passes gradeFilter(id) as
   * the RegionSource.filter) and the MP4 export (export-short forwards the
   * same ids through the same drawFrame), so what you see is what you get.
   */
  screenGrade: string;
  faceGrade: string;

  /**
   * Raw face-cam word-level transcript (SOURCE seconds). Populated at ingest
   * alongside setClips; captions chunk this into on-screen blocks. Empty until
   * a transcript is loaded. Kept in the store so captions and persistence can
   * both read it (the take list only ever saw the derived Clip[] before).
   */
  words: Word[];
  setWords: (words: Word[]) => void;
  applyTranscript: (input: {
    words: Word[];
    mode: "preserve-cuts" | "rebuild";
    rebuiltClips?: Clip[];
    editStats?: EditStats | null;
  }) => void;

  // --- sound effects ---------------------------------------------------------
  /** Editable output-time sound-effect document. */
  sfxClips: SfxClip[];
  /** Passive imported SFX inventory; deliberately outside Undo history. */
  sfxAssets: SfxAsset[];
  /** Transient selected SFX block. */
  selectedSfxClipId: string | null;
  /** Monotonic stale-generation guard; never restored from history. */
  sfxDocumentRevision: number;
  /** True while the SFX engine is rendering the track (drives the button spinner). */
  sfxGenerating: boolean;
  /** Toggle the generating flag around a render call. */
  setSfxGenerating: (generating: boolean) => void;
  addSfxAsset: (asset: Omit<SfxAsset, "id">) => string;
  addImportedSfxClip: (input: AddImportedSfxInput) => { assetId: string; clipId: string } | null;
  addSfxClip: (input: AddSfxClipInput) => string | null;
  replaceAutomaticSfxClips: (clips: readonly SfxClip[]) => void;
  selectSfxClip: (id: string | null) => void;
  moveSfxClip: (id: string, timelineStart: number) => void;
  trimSfxClipLeft: (id: string, timelineStart: number) => void;
  trimSfxClipRight: (id: string, timelineEnd: number) => void;
  setSfxClipSourceStart: (id: string, sourceStart: number) => void;
  setSfxClipSourceEnd: (id: string, sourceEnd: number) => void;
  setSfxClipGain: (id: string, gain: number) => void;
  setSfxClipFadeIn: (id: string, seconds: number) => void;
  setSfxClipFadeOut: (id: string, seconds: number) => void;
  setSfxClipMuted: (id: string, muted: boolean) => void;
  replaceSfxClipSource: (
    id: string,
    replacement: { name: string; source: SfxClipSource }
  ) => void;
  duplicateSfxClip: (id: string) => string | null;
  removeSfxClip: (id: string) => void;
  beginSfxGesture: (id: string, kind: SfxGestureKind) => string | null;
  updateSfxGesture: (token: string, value: number) => void;
  endSfxGesture: (token: string) => void;
  cancelSfxGesture: (token: string) => void;
  subscribeSfxGestureCancellation: (listener: () => void) => () => void;

  // --- background music (manual) --------------------------------------------
  /**
   * The reel's manually-added background-music track, or null. Sits on the Music
   * row between the clips and the SFX row. Baked into preview + export audio.
   * NOT part of undo history, but IS persisted across reload.
   */
  musicTrack: MusicTrack | null;
  /** Set/replace the background-music track (called after the user picks a file). */
  setMusicTrack: (track: MusicTrack | null) => void;
  /** Remove the music track (the block's delete affordance). */
  clearMusicTrack: () => void;
  /** Adjust the music bed's playback gain (0..2, 1 = as added). */
  setMusicGain: (gain: number) => void;
  /** Move where the music starts on the OUTPUT timeline (seconds, clamped >= 0). */
  setMusicStart: (startAtSec: number) => void;

  // --- captions -------------------------------------------------------------
  /** Master on/off for burned-in captions. */
  captionsEnabled: boolean;
  /** Global caption style (a template preset + edits); per-block overrides live on the block. */
  captionStyle: CaptionStyle;
  /** On-screen caption blocks, chunked from `words` by the active style. */
  captionBlocks: CaptionBlock[];
  setCaptionsEnabled: (on: boolean) => void;
  /** Switch template: swaps the global style AND re-chunks blocks (density may change). */
  setCaptionTemplate: (id: CaptionTemplateId) => void;
  /** Patch the global style (color/size/position/font/anim edits). Re-chunks if density/budgets changed. */
  patchCaptionStyle: (patch: Partial<CaptionStyle>) => void;
  /** Set/clear per-block style overrides (the "adjustable per scene" edit). */
  patchCaptionBlock: (id: string, patch: Partial<CaptionBlock>) => void;
  /** Explicitly pin one block to the split while inheriting the global offset. */
  attachCaptionBlock: (id: string) => void;
  /** Explicitly detach one block at an absolute requested output position. */
  detachCaptionBlock: (
    id: string,
    positionYPct: number,
    options?: { discrete?: boolean }
  ) => void;
  beginCaptionGesture: (blockId: string) => string | null;
  completeCaptionGesture: (
    token: string,
    completion: CaptionGestureCompletion
  ) => void;
  cancelCaptionGesture: (token: string) => void;
  beginCaptionPositionGesture: (blockId: string) => string | null;
  updateCaptionPositionGesture: (token: string, positionYPct: number) => void;
  endCaptionPositionGesture: (token: string) => void;
  cancelCaptionPositionGesture: (token: string) => void;
  subscribeCaptionGestureCancellation: (listener: () => void) => () => void;
  /**
   * Set this ONE block's vertical position as a per-scene override (the "put
   * captions higher/lower for this scene" edit). Writes into the block's
   * overrideStyle without disturbing the global style, so every other scene
   * keeps following the global Position. Nudges whichever anchor the block's
   * resolved style uses: `splitOffsetPct` when pinned to the split seam, else
   * the absolute `positionYPct`.
   */
  setBlockPosition: (
    id: string,
    positionYPct: number,
    effectiveSplitRatio?: number
  ) => void;
  /** Clear a block's per-scene position override (revert this scene to global). */
  clearBlockPosition: (id: string) => void;
  /** Rebuild caption blocks from the current words + style (called after ingest / template change). */
  rebuildCaptionBlocks: () => void;
  /**
   * Self-repair: rebuild caption blocks ONLY if they're empty while words exist
   * (a project loaded/restored via a path that never chunked). Idempotent and
   * cheap when blocks already exist, so it's safe to call defensively -- this is
   * what keeps captions from ever being "enabled but empty" without every caller
   * having to remember to rebuild.
   */
  ensureCaptionBlocks: () => void;
  /**
   * Edit ONLY the on-screen CAPTION TEXT for the raw word at `wordIndex` (fix a
   * transcription typo). This writes the block's positional `textOverride` channel
   * -- footage, timing, and `words[]` are untouched, so the cut/timeline never
   * moves. Finds the caption block containing that word by matching source time
   * (block.words has a word whose start equals words[wordIndex].start), sets the
   * override at that word's local position, and patches just that one block (no
   * re-chunk). An empty/whitespace `newText` reverts that position to the original
   * transcript word. Coalesced into one undo step per word. No-op if the word
   * isn't in any current block.
   */
  editWordText: (wordIndex: number, newText: string) => void;

  /**
   * Per-scene FACE framing (pan/zoom of the bottom face-cam region). Passing a
   * framing gives THIS clip its own face crop (writes `Clip.faceFraming`);
   * passing null clears the override so the scene frames as shot. Render-time
   * only -- never ripples the timeline, never changes duration. The cut into a
   * reframed scene eases between framings via the Smart transition (see
   * faceFramingAt in ./time-map.ts). Coalesced per clip so the whole drag/scroll
   * gesture folds into one undo step.
   */
  setClipFaceFraming: (id: string, framing: FaceFraming | null) => void;
  /**
   * Per-scene SCREEN framing (pan/zoom of the top region). Writes/clears
   * `Clip.screenFraming`. `null` clears the override (scene frames as shot).
   * Render-time only -- no ripple, no timeline change. The whole drag/scroll
   * gesture coalesces into one undo step.
   */
  setClipScreenFraming: (id: string, framing: FaceFraming | null) => void;
  /**
   * Set (or clear, with null) a clip's mid-clip ZOOM PUNCH-IN for a region -- a
   * transient scale envelope (ease in / hold / ease out) layered on the resolved
   * framing WITHOUT splitting the clip. Writes `Clip.screenPunch` / `facePunch`.
   * Render-time only -- does NOT change srcStart/srcEnd, so it never ripples the
   * timeline. Coalesces per (clip, region) so a future amount/hold slider drag
   * folds into ONE undo step; the one-click add is its own discrete step.
   */
  setClipPunch: (
    id: string,
    region: "screen" | "face",
    punch: ClipPunch | null
  ) => void;

  playhead: number;
  selectedClipId: string | null;

  // --- media bin (Files panel) ----------------------------------------------
  /**
   * The project's imported-media inventory -- the "Files" panel. Every asset
   * brought in (overlay image/video, music, SFX, voice) is registered here once
   * so it can be RE-USED without re-importing: a click in the bin drops a fresh
   * instance (image/video -> overlay at the playhead; audio -> the music track).
   * A passive top-level array like `markers` -- it never draws to the canvas and
   * never ripples with clip edits. NOT part of undo history (an inventory list,
   * like musicTrack) but IS persisted in the project snapshot.
   */
  mediaAssets: MediaAsset[];
  /**
   * Register an imported asset in the bin. `id` is minted (`asset-N`). Dedupes on
   * `sourcePath`: re-importing the same on-disk file returns the existing entry's
   * id instead of adding a duplicate row. Returns the (new or existing) asset id.
   */
  addMediaAsset: (asset: Omit<MediaAsset, "id">) => string;
  /** Remove an asset from the bin by id (the row's delete affordance). No-op if absent. */
  removeMediaAsset: (id: string) => void;

  /**
   * Free-floating external media overlays composited on top of the base
   * face+screen composite. A separate top-level array (like `markers`): overlays
   * carry their own media, overlap freely with a dense `zIndex`, and NEVER
   * ripple with clip/word edits. Part of undo history (see EditableSnapshot).
   */
  overlays: Overlay[];
  /**
   * The currently-selected canvas OVERLAY (its id), or null. Transient like
   * `selectedClipId` -- NOT in undo history. Mutually exclusive with
   * `selectedClipId`: selecting an overlay clears the clip selection and vice
   * versa, so the canvas/timeline only ever highlight one object at a time. Read
   * the unified target via `getSelectedObject()`.
   */
  selectedOverlayId: string | null;

  /**
   * The FULL canvas overlay multi-selection (superset of selectedOverlayId).
   * selectedOverlayId is the PRIMARY member (the last one added -- the anchor for
   * single-overlay chrome + keyboard nudge); this array is every selected overlay
   * for align/distribute. Invariant: when non-empty its last element ===
   * selectedOverlayId, and selectedOverlayId===null <=> this is []. Transient --
   * NOT in undo history, exactly like selectedOverlayId. A plain single select
   * leaves this as a 1-element array so every existing single path keeps working.
   */
  selectedOverlayIds: string[];
  /**
   * Toggle an overlay in/out of the multi-selection (shift-click). Adds it (and
   * makes it primary) if absent; removes it if present (promoting the new last
   * member to primary, or clearing to null when it was the only one). Clears any
   * clip selection (mutual exclusion) whenever the result is non-empty. Transient.
   */
  toggleOverlaySelected: (id: string) => void;
  /**
   * Align every selected overlay's AABB to a shared edge/center of the combined
   * selection bounds. Needs the preview rect (pure geometry; the store has no
   * DOM). No-op with < 2 selected. One undo step (discrete). Each result is
   * re-clamped to its own band so it can't cross the seam.
   */
  alignOverlays: (edge: AlignEdge, rect: PreviewRect, effectiveSplitRatio: number) => void;
  /**
   * Distribute the selected overlays so gaps are equal along the axis, holding
   * the two outermost fixed. Needs the preview rect. No-op with < 3 selected. One
   * undo step. Each moved overlay is re-clamped to its own band.
   */
  distributeOverlays: (
    axis: DistributeAxis,
    rect: PreviewRect,
    effectiveSplitRatio: number
  ) => void;

  /**
   * Attribute clipboard for "copy position" (Cmd/Ctrl+C) -> "paste attributes"
   * (Cmd/Ctrl+Shift+V), Descript-parity. Holds the RESOLVED visual attributes
   * of the copied canvas object: a scene's framing set (face + screen + split
   * ratio) or an overlay's transform + opacity. TRANSIENT -- a clipboard, not
   * an edit: never in undo history, never persisted in a snapshot.
   */
  attributeClipboard: AttributeClipboard | null;
  /**
   * Copy the selected canvas object's visual attributes into
   * `attributeClipboard`. Overlay selection and clip selection are mutually
   * exclusive, so whichever is set is the source. Returns true when something
   * was copied so the key handler only preventDefaults a copy that was ours
   * (a plain text copy elsewhere keeps the native behavior).
   */
  copySelectedAttributes: (overlayId?: string) => boolean;
  /**
   * Apply `attributeClipboard` onto the current SAME-KIND selection: clip
   * attributes onto the selected scene (face framing through the syncFaceCam
   * contract, screen framing + split ratio onto the target only), overlay
   * attributes onto EVERY selected overlay. One discrete undo step. Returns
   * true when anything was applied.
   */
  pasteAttributesToSelection: (
    rect?: PreviewRect,
    effectiveSplitRatio?: number
  ) => boolean;

  /**
   * The currently-selected CAPTION BLOCK (its id), or null. TRANSIENT like
   * `selectedOverlayId` / `selectedClipId` -- deliberately NOT in undo history
   * and NOT in EditableSnapshot (undo restores an EDIT, never yanks the caption
   * selection around). Drives the Inspector's per-block edit UI (text fix +
   * position nudge). Set from CaptionPanel by picking the block on screen at the
   * playhead; auto-cleared whenever the blocks are rebuilt (a re-chunk mints new
   * block ids, so a stale id would dangle). Independent of the canvas object
   * selection -- selecting a caption block does NOT disturb selectedClipId /
   * selectedOverlayId, and vice versa (captions are edited in the Inspector rail,
   * not manipulated on the canvas).
   */
  selectedCaptionBlockId: string | null;
  /** Select a caption block for per-block editing (or clear with null). Transient. */
  selectCaptionBlock: (id: string | null) => void;

  /**
   * The alignment guide lines to draw for the IN-PROGRESS overlay move gesture
   *. Set every pointermove while an overlay drags and a snap is active;
   * cleared to [] on pointer-up / cancel. TRANSIENT -- like `selectedOverlayId`
   * it is NOT part of undo history, and (crucially) it NEVER bakes into the
   * export: PreviewCanvas draws these as pointer-events:none DOM guides above the
   * canvas, exactly like the alignment grid. Held here rather than in a
   * hook ref so PreviewCanvas can subscribe and re-render on change. Empty when
   * nothing is snapping / no gesture is live.
   */
  activeSnapGuides: SnapGuide[];
  /** Replace the active snap guides (the move gesture sets them; pointer-up clears to []). */
  setActiveSnapGuides: (guides: SnapGuide[]) => void;

  /**
   * Whether an overlay MOVE drag is live. Transient editor
   * chrome -- NOT in undo history, never exported. Flipped true at the start of a
   * move gesture and false on pointer-up / cancel. The SelectionOverlay reads it
   * to LIFT the selected media (brighten outline + soft shadow + a hair of scale)
   * while it is being carried, and PreviewCanvas / the interaction layer read it
   * to show a `grabbing` cursor. Purely visual -- the drag math never touches it.
   */
  overlayDragging: boolean;
  /** Set the live overlay-drag flag (true on move-gesture start, false on pointer-up). */
  setOverlayDragging: (dragging: boolean) => void;

  /**
   * Whether the preview is playing. The store owns this flag; PreviewCanvas's
   * transport clock advances the output `playhead`, which is the authoritative
   * timeline clock. Source <video> elements follow that clock and are corrected
   * back to mapped source time when they drift. Playback halts automatically at
   * the timeline end, which flips this back to false.
   */
  isPlaying: boolean;
  /**
   * Playback speed multiplier (1 = real time). Applied by PreviewCanvas to the
   * source <video>s' `playbackRate` (the video-clock path) AND to the wall-clock
   * fallback delta, so both playback modes honor it. Driven by the J/K/L shuttle
   * and the transport rate selector. Kept > 0 -- reverse video playback isn't
   * reliable in browsers, so the shuttle floors at pause rather than going
   * negative.
   */
  playbackRate: number;
  /** Set the playback speed multiplier (clamped to a sane forward range). */
  setPlaybackRate: (rate: number) => void;
  /**
   * J/K/L transport shuttle. `shuttle(1)` (L) steps UP the forward rate ladder
   * (and starts playback); `shuttle(-1)` (J) steps DOWN it, pausing at the
   * bottom; `shuttle(0)` (K) stops and resets to 1x. The ladder is the shared
   * PLAYBACK_RATES (0.5x .. 2.5x). Mirrors how Premiere/Descript treat J/K/L for
   * review.
   */
  shuttle: (direction: -1 | 0 | 1) => void;
  /** Output-timeline seconds marking a loop/export region. null = whole timeline. */
  inPoint: number | null;
  outPoint: number | null;
  /** When true, playback loops the in/out region (or whole timeline) instead of stopping at the end. */
  loopPlayback: boolean;

  /**
   * Timeline snapping master toggle (the "magnet"). When true (default), clip
   * edges / playhead drags snap to neighbor edges + the playhead; when false,
   * drags move freely. A UI preference, NOT part of undo history.
   */
  snapEnabled: boolean;
  toggleSnap: () => void;
  setSnapEnabled: (on: boolean) => void;

  /**
   * Face-cam SYNC master toggle. When true (default), the face cam is a locked
   * camera showing the same speaker in the same spot for the whole recording,
   * so a drag/scroll reframe on the face region writes ONE framing to every
   * kept clip at once (matches the `FaceFraming` doc's "single GLOBAL framing"
   * intent in ./types.ts). When false, a reframe targets only the active clip
   * under the playhead, letting a scene "unfreeze" with its own override --
   * the original per-scene behavior. A UI preference, NOT part of undo history.
   */
  syncFaceCam: boolean;
  toggleSyncFaceCam: () => void;

  /**
   * Alignment grid on the preview (rule-of-thirds + center crosshair), to
   * eyeball-center an overlay. Off by default; toggled from the top bar. A UI
   * preference, NOT part of undo history, and never drawn into the export
   * (the grid is a DOM overlay in PreviewCanvas).
   */
  showGrid: boolean;
  toggleGrid: () => void;

  /**
   * True while a saved project is being loaded from disk (the async fetch in
   * useProjectPersistence): set the instant a load starts and cleared once the
   * snapshot is applied. Transient UI/loading state, NOT persisted, NOT part of
   * undo history. SourcesPanel's demo auto-load gates on this so the brief
   * empty-store window during hydration can't inject demo footage into a project
   * that is about to be filled from disk. For a brand-new "new-*" project (no
   * fetch) it stays false, so the demo/manual ingest path still runs.
   */
  hydrating: boolean;
  setHydrating: (hydrating: boolean) => void;
  /** Monotonic transient identity for the in-memory project lifecycle. */
  projectEpoch: number;

  /**
   * Reset the ENTIRE editor to the empty-project baseline: no clips/words/footage,
   * no overlays/sfx/music/media-bin/markers, default split/grades/captions, a
   * CLEARED undo history, and all transient selection/playback state at defaults.
   * Used when switching projects in one session (the router moves between
   * /[projectId] slugs without a full page reload, so the in-memory store must be
   * wiped before the next project hydrates) and by the provisional "new-*" route.
   * Does NOT touch the module id counters -- the hydrate path calls
   * reseedIdCounters AFTER loading the target snapshot.
   */
  resetProject: () => void;

  /**
   * Ruler markers -- labeled pins at OUTPUT-timeline times (a beat / chapter /
   * "fix this" note). Part of undo history; NOT rippled with clip edits (they
   * mark a moment in the assembled short, not source footage).
   */
  markers: Marker[];
  /** Add a marker at `t` (defaults to the current playhead). Returns the new id. */
  addMarker: (t?: number) => string;
  /** Remove a marker by id. */
  removeMarker: (id: string) => void;
  /** Patch a marker (rename / recolor / retime) by id. */
  updateMarker: (id: string, patch: Partial<Omit<Marker, "id">>) => void;
  /**
   * Seek the playhead to the FIRST marker strictly AFTER the current playhead
   * (clamped to the timeline). No-op when there are no markers or the playhead
   * is already at/after the last one. A transport nav like seekToStart/End --
   * it moves the play mark only, never edits the document (no history), and
   * never touches markers themselves.
   */
  nextMarker: () => void;
  /**
   * Seek the playhead to the LAST marker strictly BEFORE the current playhead.
   * No-op when there are no markers or the playhead is already at/before the
   * first one. Transport nav only (no history), the mirror of nextMarker.
   */
  prevMarker: () => void;

  /** Raw dual-track source metadata (paths, fps, dims, duration). Null until footage is loaded/imported. */
  footageMeta: FootageMeta | null;
  setFootageMeta: (meta: FootageMeta | null) => void;
  syncVideoTimeline: (previousMeta: FootageMeta | null) => void;
  setVideoSourceRecord: (
    target: VideoSourceTarget,
    source: VideoSourceRecord
  ) => void;
  /** Transient readiness of the two preview media elements. Never persisted or captured in history. */
  mediaReadiness: MediaReadiness;
  /** Short user-facing explanation when playback cannot start. Transient UI state. */
  playbackBlockedReason: string | null;
  setMediaReadiness: (
    state: MediaReadiness,
    reason?: string | null
  ) => void;
  /** Active source import tokens. Transient coordination for preview readiness. */
  sourceImportOwners: Record<SourceImportRole, number | null>;
  beginSourceImport: (role: SourceImportRole) => number;
  endSourceImport: (role: SourceImportRole, token: number) => void;


  /**
   * Auto-cut savings summary for the loaded short (retakes removed / silences
   * trimmed / seconds saved), computed at ingest. Null until a short is built
   * from a final transcript (the full-cut fallback has no meaningful "short
   * savings" number). Surfaced in the transcript rail so the tool's payoff --
   * "we cut X seconds of retakes + dead air for you" -- is visible, not silent.
   */
  editStats: EditStats | null;
  setEditStats: (stats: EditStats | null) => void;

  /**
   * Raw word indices the user has explicitly deleted from the short. The SOURCE
   * OF TRUTH for word deletion (see EditableSnapshot). Kept sorted + JSON
   * serializable. `words[i]` is deleted iff `i` is in this list. The transcript
   * panel reads this to strike/dim a word; deleteWords/restoreWords are the only
   * writers. Reset to [] by both setClips and setWords (a fresh ingest must never
   * inherit a prior recording's strikethroughs).
   */
  deletedWordIndices: number[];
  /**
   * The currently-selected RAW word range [lo, hi] (inclusive, lo <= hi), shared
   * by BOTH word surfaces -- the transcript panel and the timeline clip's word
   * cells. TRANSIENT (not in undo history / EditableSnapshot), exactly like
   * `selectedClipId`. This is the ONE source of truth for "which word(s) are
   * selected" so a Delete keypress removes the SELECTED WORD from either surface
   * (transcript OR timeline), instead of the whole carrier scene. null = no word
   * selection. Mutually exclusive with a clip/overlay selection at the call
   * sites: selecting a word clears `selectedClipId` (see `selectWords`), so the
   * two Delete paths (word-delete vs scene-delete) never both fire.
   */
  selectedWordRange: { lo: number; hi: number } | null;
  /**
   * Select a raw word range (inclusive) as the active word selection, or clear
   * it with null. Passing a range also CLEARS `selectedClipId` / `selectedOverlayId`
   * (mutual exclusion) so a Delete acts on the word, not a scene/overlay. The two
   * indices are normalized (min/max) so callers may pass them in any order.
   */
  selectWords: (from: number | null, to?: number) => void;
  /**
   * Delete the raw words in the INCLUSIVE index range [fromWordIndex,
   * toWordIndex] (order-independent) from the short: a forward cut that splits +
   * soft-deletes a `kept:false` ghost carrier around each contiguous span, so
   * every deletion stays restorable. Only currently-KEPT words in the range are
   * affected (already-deleted / outside words are skipped). One undo step per
   * call. No-op (no history) when the range contains no kept word.
   */
  deleteWords: (fromWordIndex: number, toWordIndex: number) => void;
  /**
   * Restore the raw words in the INCLUSIVE index range [fromWordIndex,
   * toWordIndex] (order-independent): drop them from `deletedWordIndices` and
   * flip the covering `kept:false` ghost clip(s) back to `kept:true`, then
   * auto-merge adjacent same-lineage survivors back into one clip. One undo
   * step per call.
   */
  restoreWords: (fromWordIndex: number, toWordIndex: number) => void;
  /**
   * Remove every filler word ("um", "uh", ...) still KEPT in the short in ONE
   * batch (one undo step) and return how many were removed. Each word is
   * normalized (lowercased, surrounding punctuation/whitespace stripped) before
   * matching the filler set; a word already deleted or with no kept clip is
   * skipped. Returns 0 (and pushes no history) when nothing matches. Every
   * removed filler stays individually restorable (it becomes its own ghost or
   * is unioned into `deletedWordIndices`), exactly like a manual word delete.
   * Pass a custom `fillers` set to override the default list.
   */
  removeFillerWords: (fillers?: readonly string[]) => number;
  /**
   * Batch "Shorten Word Gaps" (Descript's most-used everyday op): shrink every
   * kept take so it leaves at most `maxGapSec` of silence at each end, hugging
   * the spoken words. ONE undo step; ripples the whole reel tighter. Returns how
   * many takes actually moved (0 = no-op, no history). Fully reversible via undo,
   * or by running again with a larger `maxGapSec` (edges snap to absolute word
   * times, so re-running is stable and can grow a breath back). Non-destructive:
   * silence/non-kept clips and takes with no interior speech are left as-is.
   */
  tightenWordGaps: (maxGapSec: number) => number;

  // --- clip actions --------------------------------------------------------
  setClips: (clips: Clip[]) => void;
  deleteClip: (id: string) => void;
  restoreClip: (id: string) => void;
  /**
   * Duplicate a clip: insert a kept copy immediately AFTER it in the array
   * (fresh id, same source range + occurrences, no keeper flag, no transition),
   * ripple the timeline, and select the copy. The standard NLE
   * Cmd/Ctrl+D. No-op for a clip that doesn't exist.
   */
  duplicateClip: (id: string) => void;
  /**
   * Set the given edge of a clip to an ABSOLUTE source-time target (seconds
   * in the raw source file). Callers pass the intended `srcStart`/`srcEnd`
   * directly, not a delta -- so a live-drag that recomputes its target from a
   * frozen anchor each move can never compound onto an already-mutated value.
   * The target is clamped so the clip can never invert (min duration enforced).
   */
  trimClip: (id: string, edge: "start" | "end", target: number) => void;
  reorderClips: (id: string, toIndex: number) => void;
  /**
   * Set (or clear, with null) a clip's incoming motion transition. Render-time
   * only -- does NOT change srcStart/srcEnd, so it never ripples the timeline.
   */
  setClipTransition: (id: string, transition: ClipTransition | null) => void;
  /**
   * Set (or clear, with null) a clip's PER-SCENE split ratio -- the fraction of
   * height given to the Screen (top) band for just this clip. Clamped to [0, 1].
   * null reverts the clip to the global default. Render-time only -- does NOT
   * change srcStart/srcEnd, so it never ripples the timeline. This is what the
   * coral split handle writes when dragged over a
   * scene: only that scene's split changes, and the cut into it eases from the
   * previous scene's split (see splitRatioAt in ./time-map.ts). Each regular
   * call is a discrete undo step; pointer drags use the gesture actions below.
   */
  setClipSplitRatio: (id: string, ratio: number | null) => void;
  /**
   * Split the kept clip under `timelineT` (defaults to the current playhead) into
   * two adjacent clips at that point. The clip is cut at the SOURCE time the
   * playhead maps to, replaced in place by [srcStart..splitSrc] +
   * [splitSrc..srcEnd] (both kept). Total duration is unchanged, so downstream
   * clips don't move. No-op when the playhead isn't strictly inside a kept clip
   * or either half would fall below the minimum clip length. The first half
   * keeps the original incoming transition; the second half is tagged
   * `manualScene` and glides in on an eased default transition so the reframed
   * sub-scene animates in. Selects the second half so the next edit targets it.
   */
  splitClipAtPlayhead: (timelineT?: number) => void;

  // --- overlay actions ------------------------------------------------------
  // Free-floating media overlays. Every action produces NEW array/object refs
  // (never mutates) so the undo snapshot invariant holds, and NONE of them call
  // recomputeTimeline -- overlays never ripple. Continuous gestures coalesce via
  // commitHistory keys exactly like the clip trim/move/framing actions.
  /**
   * Add a free-floating overlay from a descriptor. Discrete (its own undo step).
   * Stacks on TOP (`zIndex` = current max + 1), clamps `timelineStart` to
   * [0, duration], gives a sane default visible window (image 4s, video its own
   * duration capped at 6s) also clamped to the project end, and a default
   * centered transform ({ x:0.5, y:0.5, scale:1, rotation:0 }, opacity 1) unless
   * the descriptor overrides x/y/scale. Selects the new overlay. Returns its id.
   */
  addOverlay: (
    descriptor: {
      kind: "image" | "video";
      src: string;
      sourcePath?: string;
      videoSource?: VideoSourceRecord;
      naturalWidth: number;
      naturalHeight: number;
      /** Playhead / drop time -> timelineStart (clamped to [0, duration]). */
      atTime: number;
      /** For video: full source duration (seconds) -> srcDuration + default window. */
      srcDuration?: number;
      /** Normalized drop-point center override (defaults to 0.5, 0.5). */
      atPoint?: { x: number; y: number };
      /** Initial scale (fraction of output width) override (defaults to 1). */
      scale?: number;
      /** Split band to publish into (new editor overlays default to Screen). */
      band?: Overlay["band"];
    },
    previewRect?: PreviewRect,
    effectiveSplitRatio?: number
  ) => string;
  /**
   * Patch an overlay's transform (x/y/scale/rotation). The whole continuous
   * gesture (a canvas drag-move / resize / rotate) coalesces into ONE undo step
   * via the `ovxform:${id}` key. Render-time only -- no ripple.
   */
  updateOverlayTransform: (id: string, patch: Partial<OverlayTransform>) => void;
  beginOverlayTransformGesture: (id: string) => string | null;
  updateOverlayTransformGesture: (
    token: string,
    patch: Partial<OverlayTransform>
  ) => void;
  endOverlayTransformGesture: (token: string) => void;
  cancelOverlayTransformGesture: (token: string) => void;
  subscribeOverlayTransformGestureCancellation: (
    listener: () => void
  ) => () => void;
  /**
   * Set an overlay's static `opacity` (0..1, clamped). Coalesces the whole
   * slider drag into ONE undo step via the `ovopacity:${id}` key -- the same
   * gesture-coalescing discipline as {@link updateOverlayTransform}. Render-time
   * only, no ripple. Opacity is a constant asset property (never tweened at a
   * cut), so the no-fade convention is preserved.
   */
  setOverlayOpacity: (id: string, opacity: number) => void;
  setOverlayEntranceEffect: (id: string, effect: OverlayEffect) => void;
  setOverlayExitEffect: (id: string, effect: OverlayEffect) => void;
  setOverlayCornerRadius: (id: string, radius: number) => void;
  beginOverlayAppearanceGesture: (
    id: string,
    field: "entranceDuration" | "exitDuration" | "cornerRadius"
  ) => string | null;
  updateOverlayAppearanceGesture: (token: string, value: number) => void;
  endOverlayAppearanceGesture: (token: string) => void;
  cancelOverlayAppearanceGesture: (token: string) => void;
  subscribeOverlayAppearanceGestureCancellation: (
    listener: () => void
  ) => () => void;
  /**
   * Slide an overlay in OUTPUT time, preserving its length. `timelineStart` is
   * clamped to [0, duration - length]. The whole drag coalesces (`ovmove:${id}`).
   * NO recomputeTimeline -- overlays are independent of the reel length.
   */
  moveOverlay: (id: string, timelineStart: number) => void;
  /**
   * Set one EDGE of an overlay to an ABSOLUTE output-time target (like trimClip):
   * callers pass the intended timeline time, not a delta, so a live drag off a
   * frozen anchor never compounds. A start-trim advances the video `srcStart` by
   * the same amount (so the shown frame stays put), clamped against `srcDuration`
   * so it can't run past the available footage; both edges keep the window at
   * least MIN_OVERLAY_DURATION and inside [0, duration]. Coalesces per edge
   * (`ovtrim:${id}:${edge}`). NO ripple.
   */
  trimOverlay: (id: string, edge: "start" | "end", timelineTarget: number) => void;
  /**
   * Remove an overlay. Discrete. Clears `selectedOverlayId` if it pointed at the
   * removed overlay, and re-dense-packs the remaining overlays' `zIndex` to
   * 0..N-1 so gaps never grow.
   */
  removeOverlay: (id: string) => void;
  /**
   * Duplicate an overlay: a fresh id, the SAME src/media, nudged transform
   * clamped to its frame-effective band, stacked on top (`zIndex` = max + 1).
   * Discrete.
   * Selects the copy. Returns the NEW overlay's id (or null for an unknown id) so
   * a caller like the Cmd/Ctrl-drag clone gesture can immediately grab + drag it.
   */
  duplicateOverlay: (
    id: string,
    rect: PreviewRect,
    effectiveSplitRatio: number
  ) => string | null;
  /**
   * Re-stack an overlay among overlays only: bring to front / forward one /
   * backward one / send to back. Re-dense-packs `zIndex` to 0..N-1. Discrete.
   */
  setOverlayZ: (id: string, dir: "front" | "forward" | "backward" | "back") => void;
  /**
   * Select an overlay (or clear with null). TRANSIENT -- not in undo history.
   * Clears `selectedClipId` (mutual exclusion) so only one canvas object is
   * selected at a time.
   */
  selectOverlay: (id: string | null) => void;
  /**
   * Derived unified canvas-object selection: the selected overlay, else the
   * selected clip, else null. The one place UI reads "what is selected on the
   * canvas" without caring which of the two id fields holds it.
   */
  getSelectedObject: () => SelectedObject | null;

  // --- split / pan-zoom -----------------------------------------------------
  setSplitRatio: (ratio: number) => void;
  beginSplitRatioGesture: (
    target: { kind: "clip"; id: string } | { kind: "global" }
  ) => string | null;
  updateSplitRatioGesture: (token: string, ratio: number) => void;
  endSplitRatioGesture: (token: string) => void;
  cancelSplitRatioGesture: (token: string) => void;
  /** Transient signal only; publishes no Zustand state and cannot trigger persistence. */
  subscribeSplitRatioGestureCancellation: (
    listener: () => void
  ) => () => void;
  /** Set a track's color-grade preset id (see lib/repurpose/color-grade.ts). */
  setGrade: (track: "screen" | "face", gradeId: string) => void;
  /**
   * Reset every scene's framing: strip all per-clip `screenFraming`,
   * `faceFraming`, and `splitRatio` overrides. No-op (no history entry) when
   * there is nothing to reset. No ripple/remap (nothing moves in time).
   */
  resetAllFraming: () => void;
  /**
   * Set the reel's DEFAULT transition style: apply `transition` to every REAL
   * cut at once (every non-opening kept clip that already carries a
   * `transitionIn`). Continuous same-take joins (which correctly have no
   * transition) are left untouched -- this never FORCES motion onto a clean cut,
   * it only restyles the cuts that already have one. Passing a type sets that
   * type's preset; `null` strips the transition from every real cut (all hard
   * cuts). No-op (no history) when nothing would change. Render-time only.
   */
  setDefaultTransition: (transition: ClipTransition | null) => void;

  // --- playback / selection --------------------------------------------------
  selectClip: (id: string | null) => void;
  setPlayhead: (t: number) => void;

  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  /** Nudge the playhead by ±1 frame (uses footageMeta.fps, defaulting to 30). Pauses if playing. */
  stepFrame: (direction: 1 | -1) => void;
  /** Jump the playhead to the start (0) or end (duration) of the timeline. */
  seekToStart: () => void;
  seekToEnd: () => void;
  /** Set the loop-region in/out points to the current playhead. Passing null clears that edge. */
  setInPoint: (t: number | null) => void;
  setOutPoint: (t: number | null) => void;
  clearInOut: () => void;
  toggleLoop: () => void;
}

/** Frames-per-second used for frame-stepping when no footage is loaded yet. */
const FALLBACK_FPS = 30;

/**
 * Playback-rate ladder for the J/K/L shuttle and the transport rate selector.
 * Matches Descript's speed menu: half-speed review up to 2.5x fast-scan (no 3x
 * -- past ~2.5x a talking-head reel is unreadable). Browsers can't play <video>
 * in reverse smoothly, so the ladder stays forward-only; the shuttle floors at
 * pause rather than going negative.
 */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5] as const;
const MIN_PLAYBACK_RATE = PLAYBACK_RATES[0];
const MAX_PLAYBACK_RATE = PLAYBACK_RATES[PLAYBACK_RATES.length - 1];

export const useRepurposeStore = create<RepurposeState>((set, get) => {
  // A restored array has a distinct identity even when it is explicitly empty.
  let splitRatioGestureCounter = 0;
  const splitRatioGestureCancellationListeners = new Set<() => void>();
  let activeSplitRatioGesture: {
    token: string;
    target: { kind: "clip"; id: string } | { kind: "global" };
    historyCommitted: boolean;
  } | null = null;
  type OverlayAppearanceGestureField =
    | "entranceDuration"
    | "exitDuration"
    | "cornerRadius";
  let overlayAppearanceGestureCounter = 0;
  const overlayAppearanceGestureCancellationListeners = new Set<() => void>();
  let activeOverlayAppearanceGesture: {
    token: string;
    id: string;
    field: OverlayAppearanceGestureField;
    initialValue: OverlayEffect | number | undefined;
    past: EditableSnapshot[];
    future: EditableSnapshot[];
    historyCommitted: boolean;
  } | null = null;
  let overlayTransformGestureCounter = 0;
  const overlayTransformGestureCancellationListeners = new Set<() => void>();
  let activeOverlayTransformGesture: {
    token: string;
    id: string;
    initialTransform: OverlayTransform;
    past: EditableSnapshot[];
    future: EditableSnapshot[];
    historyCommitted: boolean;
  } | null = null;
  let captionGestureCounter = 0;
  const captionGestureCancellationListeners = new Set<() => void>();
  let activeCaptionGesture:
    | { kind: "completion"; token: string; blockId: string }
    | {
        kind: "position";
        token: string;
        blockId: string;
        captionBlocks: CaptionBlock[];
        past: EditableSnapshot[];
        future: EditableSnapshot[];
        historyCommitted: boolean;
      }
    | null = null;
  let sfxGestureCounter = 0;
  const sfxGestureCancellationListeners = new Set<() => void>();
  let activeSfxGesture: {
    token: string;
    id: string;
    kind: SfxGestureKind;
    sfxClips: SfxClip[];
    past: EditableSnapshot[];
    future: EditableSnapshot[];
    historyCommitted: boolean;
  } | null = null;
  const captionGestureOwnsFrame = (): boolean => activeCaptionGesture !== null;

  const cancelActiveSplitRatioGesture = (): boolean => {
    if (!activeSplitRatioGesture) return false;
    activeSplitRatioGesture = null;
    return true;
  };

  const signalSplitRatioGestureCancellation = (): void => {
    for (const listener of splitRatioGestureCancellationListeners) listener();
  };

  const cancelActiveSplitRatioGestureForClip = (id: string): void => {
    if (
      activeSplitRatioGesture?.target.kind === "clip" &&
      activeSplitRatioGesture.target.id === id
    ) {
      cancelActiveSplitRatioGesture();
      signalSplitRatioGestureCancellation();
    }
  };

  const closeSplitRatioGesture = (token: string, signal: boolean): void => {
    if (activeSplitRatioGesture?.token !== token) return;
    cancelActiveSplitRatioGesture();
    if (signal) signalSplitRatioGestureCancellation();
  };

  const signalOverlayAppearanceGestureCancellation = (): void => {
    for (const listener of overlayAppearanceGestureCancellationListeners) listener();
  };

  const signalOverlayTransformGestureCancellation = (): void => {
    for (const listener of overlayTransformGestureCancellationListeners) listener();
  };

  const restoreOverlayTransformGesture = (
    gesture: NonNullable<typeof activeOverlayTransformGesture>
  ): void => {
    set({
      overlays: get().overlays.map((overlay) =>
        overlay.id === gesture.id
          ? { ...overlay, transform: { ...gesture.initialTransform } }
          : overlay
      ),
      past: gesture.past,
      future: gesture.future,
    });
  };

  const cancelActiveOverlayTransformGesture = (signal = true): boolean => {
    const gesture = activeOverlayTransformGesture;
    if (!gesture) return false;
    activeOverlayTransformGesture = null;
    if (gesture.historyCommitted) restoreOverlayTransformGesture(gesture);
    if (signal) signalOverlayTransformGestureCancellation();
    return true;
  };

  const closeActiveOverlayTransformGestureForHistory = (): boolean => {
    if (!activeOverlayTransformGesture) return false;
    activeOverlayTransformGesture = null;
    signalOverlayTransformGestureCancellation();
    return true;
  };

  const restoreOverlayAppearanceGesture = (
    gesture: NonNullable<typeof activeOverlayAppearanceGesture>
  ): void => {
    const overlays = get().overlays.map((overlay) => {
      if (overlay.id !== gesture.id) return overlay;
      if (gesture.field === "cornerRadius") {
        if (gesture.initialValue === undefined) {
          const { cornerRadius: _cornerRadius, ...rest } = overlay;
          return rest as Overlay;
        }
        return { ...overlay, cornerRadius: gesture.initialValue as number };
      }
      const effectField =
        gesture.field === "entranceDuration" ? "entranceEffect" : "exitEffect";
      if (gesture.initialValue === undefined) {
        const next = { ...overlay };
        delete next[effectField];
        return next;
      }
      return {
        ...overlay,
        [effectField]: { ...(gesture.initialValue as OverlayEffect) },
      };
    });
    set({ overlays, past: gesture.past, future: gesture.future });
  };

  const cancelActiveOverlayAppearanceGesture = (
    signal = true
  ): boolean => {
    const gesture = activeOverlayAppearanceGesture;
    if (!gesture) return false;
    activeOverlayAppearanceGesture = null;
    if (gesture.historyCommitted) restoreOverlayAppearanceGesture(gesture);
    if (signal) signalOverlayAppearanceGestureCancellation();
    return true;
  };

  const cancelActiveOverlayAppearanceGestureForOverlay = (
    id: string
  ): boolean => {
    if (activeOverlayAppearanceGesture?.id !== id) return false;
    return cancelActiveOverlayAppearanceGesture();
  };

  const signalCaptionGestureCancellation = (): void => {
    for (const listener of captionGestureCancellationListeners) listener();
  };

  const cancelActiveCaptionGesture = (signal = true): boolean => {
    const gesture = activeCaptionGesture;
    if (!gesture) return false;
    activeCaptionGesture = null;
    if (gesture.kind === "position" && gesture.historyCommitted) {
      set({
        captionBlocks: gesture.captionBlocks,
        past: gesture.past,
        future: gesture.future,
      });
    }
    if (signal) signalCaptionGestureCancellation();
    return true;
  };

  const signalSfxGestureCancellation = (): void => {
    for (const listener of sfxGestureCancellationListeners) listener();
  };

  const restoreSfxGesture = (
    gesture: NonNullable<typeof activeSfxGesture>
  ): void => {
    const state = get();
    const documentChanged = !sfxDocumentEqual(state.sfxClips, gesture.sfxClips);
    set({
      sfxClips: gesture.sfxClips,
      past: gesture.past,
      future: gesture.future,
      sfxDocumentRevision: state.sfxDocumentRevision + (documentChanged ? 1 : 0),
      selectedSfxClipId: state.selectedSfxClipId !== null
        && gesture.sfxClips.some((clip) => clip.id === state.selectedSfxClipId)
        ? state.selectedSfxClipId
        : null,
    });
  };

  const cancelActiveSfxGesture = (signal = true): boolean => {
    const gesture = activeSfxGesture;
    if (!gesture) return false;
    activeSfxGesture = null;
    if (gesture.historyCommitted) restoreSfxGesture(gesture);
    if (signal) signalSfxGestureCancellation();
    return true;
  };

  const closeActiveSfxGestureForHistory = (): boolean => {
    if (!activeSfxGesture) return false;
    activeSfxGesture = null;
    signalSfxGestureCancellation();
    return true;
  };

  const closeActiveHistoryGestures = (): void => {
    cancelActiveSfxGesture();
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    cancelActiveOverlayAppearanceGesture();
    if (cancelActiveSplitRatioGesture()) {
      signalSplitRatioGestureCancellation();
    }
  };

  const constrainCurrentSfxToDuration = (
    duration: number,
    sourceClips = get().sfxClips
  ): Partial<RepurposeState> => {
    const state = get();
    const sfxClips = constrainSfxClipsToDuration(sourceClips, duration);
    const documentChanged = !sfxDocumentEqual(sfxClips, state.sfxClips);
    if (!documentChanged) return {};
    return {
      ...(documentChanged
        ? {
            sfxClips,
            sfxDocumentRevision: state.sfxDocumentRevision + 1,
            selectedSfxClipId: state.selectedSfxClipId !== null
              && sfxClips.some((clip) => clip.id === state.selectedSfxClipId)
              ? state.selectedSfxClipId
              : null,
          }
        : {}),
    };
  };

  const withAttachedCaptionOverride = (block: CaptionBlock): CaptionBlock => {
    const override = block.overrideStyle;
    if (
      override?.pinToSplit === true &&
      !("positionYPct" in override) &&
      !("splitOffsetPct" in override)
    ) {
      return block;
    }
    const {
      positionYPct: _positionYPct,
      splitOffsetPct: _splitOffsetPct,
      ...rest
    } = override ?? {};
    return { ...block, overrideStyle: { ...rest, pinToSplit: true } };
  };

  const withDetachedCaptionOverride = (
    block: CaptionBlock,
    positionYPct: number
  ): CaptionBlock => {
    if (!Number.isFinite(positionYPct)) return block;
    const clamped = Math.max(0, Math.min(1, positionYPct));
    const override = block.overrideStyle;
    if (
      override?.pinToSplit === false &&
      override.positionYPct === clamped &&
      !("splitOffsetPct" in override)
    ) {
      return block;
    }
    const { splitOffsetPct: _splitOffsetPct, ...rest } = override ?? {};
    return {
      ...block,
      overrideStyle: {
        ...rest,
        pinToSplit: false,
        positionYPct: clamped,
      },
    };
  };

  const captureHistoryEntry = (coalesceKey?: string): void => {
    const now = Date.now();
    if (
      coalesceKey !== undefined &&
      coalesceKey === lastCommitKey &&
      now - lastCommitAt < COALESCE_WINDOW_MS
    ) {
      lastCommitAt = now;
      if (get().future.length > 0) set({ future: [] });
      return;
    }
    lastCommitKey = coalesceKey ?? null;
    lastCommitAt = now;

    const state = get();
    const past = [...state.past, captureSnapshot(state)];
    if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
    set({ past, future: [] });
  };

  const commitSfxDocument = (
    sfxClips: SfxClip[]
  ): boolean => {
    const state = get();
    if (sfxDocumentEqual(sfxClips, state.sfxClips)) return false;
    captureHistoryEntry();
    set({
      sfxClips,
      sfxDocumentRevision: state.sfxDocumentRevision + 1,
      selectedSfxClipId: state.selectedSfxClipId !== null
        && sfxClips.some((clip) => clip.id === state.selectedSfxClipId)
        ? state.selectedSfxClipId
        : null,
    });
    return true;
  };

  const updateSfxClip = (
    id: string,
    update: (clip: SfxClip, duration: number) => SfxClip | null
  ): boolean => {
    closeActiveHistoryGestures();
    const state = get();
    const target = state.sfxClips.find((clip) => clip.id === id);
    if (!target) return false;
    const updated = update(target, state.duration);
    if (!updated || sfxClipEqual(updated, target)) return false;
    return commitSfxDocument(
      state.sfxClips.map((clip) => clip.id === id ? updated : clip)
    );
  };

  return {
  clips: [],
  duration: 0,

  past: [],
  future: [],

  splitRatio: 0.5,

  screenGrade: "none",
  // Facecam defaults to the Neutral grade (a light contrast/saturation lift) --
  // raw face footage reads flat, so this is the "always on" baseline look. The
  // screen recording stays untouched ("none"). Manthan can still pick any grade.
  faceGrade: "neutral",

  words: [],
  captionsEnabled: false,
  captionStyle: DEFAULT_CAPTION_STYLE,
  captionBlocks: [],

  sfxClips: [],
  sfxAssets: [],
  selectedSfxClipId: null,
  sfxGenerating: false,
  sfxDocumentRevision: 0,

  musicTrack: null,

  deletedWordIndices: [],
  selectedWordRange: null,

  playhead: 0,
  selectedClipId: null,

  mediaAssets: [],
  overlays: [],
  selectedOverlayId: null,
  selectedOverlayIds: [],
  attributeClipboard: null,
  selectedCaptionBlockId: null,

  isPlaying: false,
  playbackRate: 1,
  inPoint: null,
  outPoint: null,
  loopPlayback: false,

  snapEnabled: true,
  toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),
  setSnapEnabled: (on) => set({ snapEnabled: on }),

  syncFaceCam: true,
  toggleSyncFaceCam: () => set({ syncFaceCam: !get().syncFaceCam }),

  showGrid: false,
  toggleGrid: () => set({ showGrid: !get().showGrid }),

  hydrating: false,
  setHydrating: (hydrating) => {
    if (hydrating) {
      closeActiveHistoryGestures();
      set({ hydrating: true });
      return;
    }
    set({ hydrating: false });
  },
  projectEpoch: 0,

  // Wipe the whole editor back to the initial-state baseline (mirrors the literal
  // above, field for field, for everything the project snapshot touches + undo
  // history + transient selection/playback). Deliberately does NOT reset the
  // module id counters; the loader reseeds them after hydrating the target project.
  resetProject: () => {
    cancelActiveSfxGesture();
    const revision = get().sfxDocumentRevision
      + (get().sfxClips.length > 0 ? 1 : 0);
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    cancelActiveOverlayAppearanceGesture();
    cancelActiveSplitRatioGesture();
    overlayDeleteStash.clear();
    set({
      clips: [],
      duration: 0,
      past: [],
      future: [],
      splitRatio: 0.5,
      screenGrade: "none",
      faceGrade: "neutral",
      words: [],
      captionsEnabled: false,
      captionStyle: DEFAULT_CAPTION_STYLE,
      captionBlocks: [],
      sfxClips: [],
      sfxAssets: [],
      selectedSfxClipId: null,
      sfxGenerating: false,
      sfxDocumentRevision: revision,
      musicTrack: null,
      deletedWordIndices: [],
      selectedWordRange: null,
      playhead: 0,
      selectedClipId: null,
      mediaAssets: [],
      overlays: [],
      selectedOverlayId: null,
      selectedOverlayIds: [],
      selectedCaptionBlockId: null,
      isPlaying: false,
      playbackRate: 1,
      inPoint: null,
      outPoint: null,
      loopPlayback: false,
      snapEnabled: true,
      syncFaceCam: true,
      showGrid: false,
      activeSnapGuides: [],
      overlayDragging: false,
      markers: [],
      footageMeta: null,
      mediaReadiness: "idle",
      playbackBlockedReason: null,
      sourceImportOwners: { screen: null, face: null },
      projectEpoch: get().projectEpoch + 1,
      editStats: null,
    });
  },

  activeSnapGuides: [],
  // Cheap identity guard: skip the setState when the guide set is unchanged
  // (both empty is the common per-frame case while dragging with nothing snapped)
  // so a drag doesn't churn a render every frame just to re-publish [].
  setActiveSnapGuides: (guides) => {
    const cur = get().activeSnapGuides;
    if (cur.length === 0 && guides.length === 0) return;
    if (
      cur.length === guides.length &&
      cur.every(
        (g, i) =>
          g.orientation === guides[i].orientation && g.coord === guides[i].coord
      )
    ) {
      return;
    }
    set({ activeSnapGuides: guides });
  },

  markers: [],
  addMarker: (t) => {
    get().commitHistory();
    const at = t ?? get().playhead;
    const id = nextMarkerId();
    const next = [...get().markers, { id, t: at }].sort((a, b) => a.t - b.t);
    set({ markers: next });
    return id;
  },
  removeMarker: (id) => {
    if (!get().markers.some((m) => m.id === id)) return;
    get().commitHistory();
    set({ markers: get().markers.filter((m) => m.id !== id) });
  },
  updateMarker: (id, patch) => {
    if (!get().markers.some((m) => m.id === id)) return;
    get().commitHistory();
    const next = get()
      .markers.map((m) => (m.id === id ? { ...m, ...patch } : m))
      .sort((a, b) => a.t - b.t);
    set({ markers: next });
  },

  footageMeta: null,
  mediaReadiness: "idle",
  playbackBlockedReason: null,
  sourceImportOwners: { screen: null, face: null },
  setFootageMeta: (meta) => {
    const previousMeta = get().footageMeta;
    const normalizedMeta = meta
      ? {
          ...meta,
          faceCamPath: meta.faceCamSource
            ? footageUrlForPath(meta.faceCamSource.workingPath)
            : meta.faceCamPath,
          screenPath: meta.screenSource
            ? footageUrlForPath(meta.screenSource.workingPath)
            : meta.screenPath,
        }
      : null;
    const hasBothPaths = Boolean(
      normalizedMeta?.faceCamPath.trim() && normalizedMeta.screenPath.trim()
    );
    set({
      footageMeta: normalizedMeta,
      mediaReadiness: hasBothPaths ? "loading" : "idle",
      playbackBlockedReason: hasBothPaths ? MEDIA_LOADING_REASON : null,
      ...(hasBothPaths
        ? { isPlaying: false, playbackRate: 1 }
        : {}),
    });
    get().syncVideoTimeline(previousMeta);
  },
  syncVideoTimeline: (previousMeta) => {
    closeActiveHistoryGestures();
    const state = get();
    const nextDuration = effectiveVideoTimelineDuration(state.footageMeta);
    if (nextDuration === null) return;
    const previousDuration = effectiveVideoTimelineDuration(previousMeta);
    const clips = synchronizeVideoTimelineClips(
      state.clips,
      state.words,
      previousDuration,
      nextDuration
    );
    const past = state.past.map((snapshot) =>
      synchronizeVideoTimelineSnapshot(snapshot, previousDuration, nextDuration)
    );
    const future = state.future.map((snapshot) =>
      synchronizeVideoTimelineSnapshot(snapshot, previousDuration, nextDuration)
    );
    const duration = deriveDuration(clips);
    const sfxClips = constrainSfxClipsToDuration(state.sfxClips, duration);
    const sfxChanged = !sfxDocumentEqual(sfxClips, state.sfxClips);
    if (
      clips === state.clips &&
      !sfxChanged &&
      past.every((snapshot, index) => snapshot === state.past[index]) &&
      future.every((snapshot, index) => snapshot === state.future[index])
    ) {
      return;
    }
    set({
      clips,
      duration,
      past,
      future,
      ...(sfxChanged
        ? {
            sfxClips,
            sfxDocumentRevision: state.sfxDocumentRevision + 1,
            selectedSfxClipId: state.selectedSfxClipId !== null
              && sfxClips.some((clip) => clip.id === state.selectedSfxClipId)
              ? state.selectedSfxClipId
              : null,
          }
        : {}),
    });
  },
  setVideoSourceRecord: (target, source) => {
    if (target.kind === "footage") {
      const footageMeta = get().footageMeta;
      if (!footageMeta) return;
      set({
        footageMeta: {
          ...footageMeta,
          [target.role === "face" ? "faceCamSource" : "screenSource"]: source,
        },
      });
      return;
    }
    if (target.kind === "asset") {
      if (
        !get().mediaAssets.some(
          (asset) => asset.kind === "video" && asset.id === target.id
        )
      ) {
        return;
      }
      set((state) => ({
        mediaAssets: state.mediaAssets.map((asset) =>
          asset.kind === "video" && asset.id === target.id
            ? { ...asset, videoSource: source }
            : asset
        ),
      }));
      return;
    }
    if (
      !get().overlays.some(
        (overlay) => overlay.kind === "video" && overlay.id === target.id
      )
    ) {
      return;
    }
    set((state) => ({
      overlays: state.overlays.map((overlay) =>
        overlay.kind === "video" && overlay.id === target.id
          ? { ...overlay, videoSource: source }
          : overlay
      ),
    }));
  },
  setMediaReadiness: (mediaReadiness, reason) => {
    const playbackBlockedReason =
      mediaReadiness === "loading"
        ? reason ?? MEDIA_LOADING_REASON
        : mediaReadiness === "error"
          ? reason ?? MEDIA_ERROR_REASON
          : null;
    const current = get();
    const mustPause =
      mediaReadiness === "loading" || mediaReadiness === "error";
    const nextPlaying = mustPause ? false : current.isPlaying;
    const nextRate = mustPause ? 1 : current.playbackRate;

    if (
      current.mediaReadiness === mediaReadiness &&
      current.playbackBlockedReason === playbackBlockedReason &&
      current.isPlaying === nextPlaying &&
      current.playbackRate === nextRate
    ) {
      return;
    }

    set({
      mediaReadiness,
      playbackBlockedReason,
      isPlaying: nextPlaying,
      playbackRate: nextRate,
    });
  },
  beginSourceImport: (role) => {
    const token = ++sourceImportToken;
    set({
      sourceImportOwners: {
        ...get().sourceImportOwners,
        [role]: token,
      },
    });
    return token;
  },
  endSourceImport: (role, token) => {
    const owners = get().sourceImportOwners;
    if (owners[role] !== token) return;
    set({
      sourceImportOwners: {
        ...owners,
        [role]: null,
      },
    });
  },

  editStats: null,
  setEditStats: (stats) => set({ editStats: stats }),

  // --- undo / redo ----------------------------------------------------------
  commitHistory: (coalesceKey) => {
    closeActiveHistoryGestures();
    captureHistoryEntry(coalesceKey);
  },

  undo: () => {
    closeActiveSfxGestureForHistory();
    closeActiveOverlayTransformGestureForHistory();
    cancelActiveCaptionGesture();
    cancelActiveOverlayAppearanceGesture();
    const cancelledGesture = cancelActiveSplitRatioGesture();
    if (cancelledGesture) signalSplitRatioGestureCancellation();
    const state = get();
    if (state.past.length === 0) return;
    const past = state.past.slice(0, -1);
    const restore = state.past[state.past.length - 1];
    // Stash the CURRENT editable state onto `future` so redo can return to it.
    const future = [...state.future, captureSnapshot(state)];
    // Break coalescing: the next edit must start its own step, never fold into
    // the gesture that preceded this undo.
    lastCommitKey = null;
    const patch = snapshotToPatch(restore);
    const restoredSfxClips = patch.sfxClips as SfxClip[];
    const sfxChanged = !sfxDocumentEqual(restoredSfxClips, state.sfxClips);
    set({
      past,
      future,
      ...patch,
      sfxDocumentRevision: state.sfxDocumentRevision + (sfxChanged ? 1 : 0),
      selectedSfxClipId: state.selectedSfxClipId !== null
        && restoredSfxClips.some((clip) => clip.id === state.selectedSfxClipId)
        ? state.selectedSfxClipId
        : null,
    });
  },

  redo: () => {
    cancelActiveSfxGesture();
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    cancelActiveOverlayAppearanceGesture();
    const cancelledGesture = cancelActiveSplitRatioGesture();
    if (cancelledGesture) signalSplitRatioGestureCancellation();
    const state = get();
    if (state.future.length === 0) return;
    const future = state.future.slice(0, -1);
    const restore = state.future[state.future.length - 1];
    // Push the current state back onto `past` so undo works again after a redo.
    const past = [...state.past, captureSnapshot(state)];
    lastCommitKey = null;
    const patch = snapshotToPatch(restore);
    const restoredSfxClips = patch.sfxClips as SfxClip[];
    const sfxChanged = !sfxDocumentEqual(restoredSfxClips, state.sfxClips);
    set({
      past,
      future,
      ...patch,
      sfxDocumentRevision: state.sfxDocumentRevision + (sfxChanged ? 1 : 0),
      selectedSfxClipId: state.selectedSfxClipId !== null
        && restoredSfxClips.some((clip) => clip.id === state.selectedSfxClipId)
        ? state.selectedSfxClipId
        : null,
    });
  },

  setClips: (clips) => {
    cancelActiveSfxGesture();
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    cancelActiveOverlayAppearanceGesture();
    cancelActiveSplitRatioGesture();
    const laidOut = recomputeTimeline(normalizeClipSplitRatios(clips));
    // setClips establishes a fresh baseline (ingest / auto-load / session
    // restore), never an incremental user edit -- so it RESETS history rather
    // than committing. You should never be able to undo back into a previous
    // project's timeline or the moment before footage loaded. deletedWordIndices
    // resets too: a new short must never inherit a prior recording's word
    // strikethroughs (their indices point at DIFFERENT raw words now). overlays
    // resets too: a fresh ingest must not inherit the prior project's pasted/
    // dropped overlays (a session restore re-applies them AFTER this via the
    // restore path). Also drop any dangling overlay selection.
    lastCommitKey = null;
    overlayDeleteStash.clear();
    const duration = deriveDuration(laidOut);
    set({
      clips: laidOut,
      duration,
      past: [],
      future: [],
      deletedWordIndices: [],
      overlays: [],
      selectedOverlayId: null,
      selectedOverlayIds: [],
      ...constrainCurrentSfxToDuration(duration),
      selectedSfxClipId: null,
    });
  },

  deleteClip: (id) => {
    cancelActiveSplitRatioGestureForClip(id);
    const initial = get();
    const initialGone = initial.clips.find((clip) => clip.id === id && clip.kept);
    const projectedOverlays = initialGone
      ? rippleOverlaysAfterDelete(
          initial.overlays,
          initialGone.timelineStart,
          initialGone.timelineEnd
        )
      : initial.overlays;
    const activeTargetId = activeOverlayAppearanceGesture?.id;
    if (
      activeTargetId &&
      initial.overlays.some((overlay) => overlay.id === activeTargetId) &&
      !projectedOverlays.some((overlay) => overlay.id === activeTargetId)
    ) {
      cancelActiveOverlayAppearanceGestureForOverlay(activeTargetId);
    }

    get().commitHistory();
    const { clips, overlays } = get();
    // The scene's OUTPUT window BEFORE recompute -- the span that collapses. Any
    // overlay over it belonged to this scene: cascade-delete/ripple them
    // so a deleted scene never leaves orphan B-roll floating over shifted content.
    const gone = clips.find((c) => c.id === id && c.kept);
    const updated = clips.map((c) => (c.id === id ? { ...c, kept: false } : c));
    const laidOut = recomputeTimeline(updated);
    const nextOverlays = gone
      ? rippleOverlaysAfterDelete(overlays, gone.timelineStart, gone.timelineEnd)
      : overlays;
    if (gone) {
      // Stash the overlays the ripple fully removed so restoreClip can bring
      // them back. Overwrites any prior stash for this clip (a re-delete).
      const surviving = new Set(nextOverlays.map((o) => o.id));
      overlayDeleteStash.set(id, {
        winStart: gone.timelineStart,
        removed: overlays.filter((o) => !surviving.has(o.id)),
      });
    }
    const duration = deriveDuration(laidOut);
    set({
      clips: laidOut,
      duration,
      overlays: nextOverlays,
      // Drop a dangling overlay selection if that overlay was removed.
      selectedClipId: get().selectedClipId === id ? null : get().selectedClipId,
      selectedOverlayId:
        get().selectedOverlayId &&
        !nextOverlays.some((o) => o.id === get().selectedOverlayId)
          ? null
          : get().selectedOverlayId,
      ...constrainCurrentSfxToDuration(duration),
    });
  },

  restoreClip: (id) => {
    get().commitHistory();
    const { clips, overlays } = get();
    const wasDeleted = clips.some((c) => c.id === id && !c.kept);
    const updated = clips.map((c) =>
      c.id === id ? { ...normalizeClipSplitRatio(c), kept: true } : c
    );
    const laidOut = recomputeTimeline(updated);
    // Inverse of the deleteClip overlay ripple: the restored scene
    // re-opens its window, so overlays at/after it shift RIGHT by its duration,
    // and the B-roll the delete removed comes back from the stash, re-anchored
    // to the scene's new position. Without this, delete -> restore silently
    // loses/misplaces the scene's overlays (undo was the only safe path).
    let nextOverlays = overlays;
    const restored = laidOut.find((c) => c.id === id);
    if (wasDeleted && restored) {
      const winStart = restored.timelineStart;
      const d = restored.timelineEnd - restored.timelineStart;
      if (d > 0) {
        nextOverlays = overlays.map((o) =>
          o.timelineStart >= winStart - 1e-6
            ? { ...o, timelineStart: o.timelineStart + d, timelineEnd: o.timelineEnd + d }
            : o
        );
        const stash = overlayDeleteStash.get(id);
        if (stash) {
          overlayDeleteStash.delete(id);
          const delta = winStart - stash.winStart;
          const existing = new Set(nextOverlays.map((o) => o.id));
          for (const o of stash.removed) {
            if (existing.has(o.id)) continue; // already back (undo path)
            nextOverlays.push({
              ...o,
              timelineStart: o.timelineStart + delta,
              timelineEnd: o.timelineEnd + delta,
            });
          }
        }
        nextOverlays = densePackOverlayZ(nextOverlays);
      }
    }
    const duration = deriveDuration(laidOut);
    set({
      clips: laidOut,
      duration,
      overlays: nextOverlays,
      ...constrainCurrentSfxToDuration(duration),
    });
  },

  duplicateClip: (id) => {
    const { clips } = get();
    const index = clips.findIndex((c) => c.id === id);
    if (index === -1) return;
    get().commitHistory();
    const src = normalizeClipSplitRatio(clips[index]);
    // A clean, kept copy: fresh id, same source range + retake list, but not a
    // keeper sibling and no incoming transition (it's a manual dupe, an internal
    // cut). timelineStart/End are re-derived by recomputeTimeline.
    const copyId = nextSplitClipId();
    const copy: Clip = {
      ...src,
      id: copyId,
      kept: true,
      isKeeperTake: false,
      transitionIn: undefined,
      occurrences: [...src.occurrences],
      // A duplicate is a NEW lineage of its own -- it must never auto-merge back
      // into the clip it was copied from, so it origins on its own id.
      originId: copyId,
    };
    const next = [...clips];
    next.splice(index + 1, 0, copy);
    const laidOut = recomputeTimeline(next);
    const duration = deriveDuration(laidOut);
    set({
      clips: laidOut,
      duration,
      selectedClipId: copy.id,
      ...constrainCurrentSfxToDuration(duration),
      selectedSfxClipId: null,
    });
  },

  trimClip: (id, edge, target) => {
    // Coalesce the whole trim drag (one edge of one clip) into a single step.
    get().commitHistory(`trim:${id}:${edge}`);
    const { clips, past } = get();
    const sfxBaseline = past[past.length - 1]?.sfxClips ?? get().sfxClips;
    const updated = clips.map((c) => {
      if (c.id !== id) return c;
      if (edge === "start") {
        const maxStart = c.srcEnd - MIN_CLIP_DURATION;
        const nextStart = Math.min(maxStart, Math.max(0, target));
        return { ...c, srcStart: nextStart };
      }
      const minEnd = c.srcStart + MIN_CLIP_DURATION;
      const nextEnd = Math.max(minEnd, target);
      return { ...c, srcEnd: nextEnd };
    });
    const laidOut = recomputeTimeline(updated);
    const duration = deriveDuration(laidOut);
    set({
      clips: laidOut,
      duration,
      ...constrainCurrentSfxToDuration(duration, sfxBaseline),
    });
  },

  reorderClips: (id, toIndex) => {
    const { clips } = get();
    const fromIndex = clips.findIndex((c) => c.id === id);
    if (fromIndex === -1) return;
    const clamped = Math.max(0, Math.min(clips.length - 1, toIndex));
    if (clamped === fromIndex) return;
    // Commit only after the early-outs so a no-op reorder never adds a step.
    get().commitHistory(`reorder:${id}`);
    const next = [...clips];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(clamped, 0, moved);
    const laidOut = recomputeTimeline(next);
    set({
      clips: laidOut,
      duration: deriveDuration(laidOut),
    });
  },

  setClipTransition: (id, transition) => {
    get().commitHistory();
    const { clips } = get();
    const updated = clips.map((c) =>
      c.id === id
        ? transition === null
          ? { ...c, transitionIn: undefined }
          : { ...c, transitionIn: transition }
        : c
    );
    // Render-time overlay only -- no recomputeTimeline (nothing moves in time).
    set({ clips: updated });
  },

  setClipSplitRatio: (id, ratio) => {
    const { clips } = get();
    const target = clips.find((c) => c.id === id);
    if (!target) return;
    const next = ratio === null ? undefined : clampSplitRatio(ratio);
    if (next === null) return;
    // No-op if unchanged (a drag frame that didn't move past clamp): don't push
    // a redundant undo step or fire subscribers (which would re-arm a smooth
    // re-render for nothing).
    if (next === target.splitRatio) return;
    get().commitHistory();
    const updated = clips.map((c) =>
      c.id === id ? { ...c, splitRatio: next } : c
    );
    // Render-time overlay only -- no recomputeTimeline (the split is a draw-time
    // value, it doesn't move any footage in time).
    set({ clips: updated });
  },

  splitClipAtPlayhead: (timelineT) => {
    const { clips, playhead } = get();
    const at = timelineT ?? playhead;

    // Find the kept clip whose half-open [timelineStart, timelineEnd) contains
    // the split point. A point exactly on a boundary belongs to the NEXT clip
    // (same half-open contract as time-map), so it isn't an interior split of
    // the outgoing clip -- there's nothing to cut there.
    const index = clips.findIndex(
      (c) => c.kept && at > c.timelineStart && at < c.timelineEnd
    );
    if (index === -1) return; // playhead not strictly inside a kept clip

    const clip = normalizeClipSplitRatio(clips[index]);
    // Source time under the playhead within THIS clip (frame-locked timebase).
    const splitSrc = clip.srcStart + (at - clip.timelineStart);

    // Both halves must clear the minimum clip length, or the split would create
    // a degenerate sliver (and could invert on the next trim). Bail if too close
    // to either edge -- the user can nudge the playhead and try again.
    if (
      splitSrc - clip.srcStart < MIN_CLIP_DURATION ||
      clip.srcEnd - splitSrc < MIN_CLIP_DURATION
    ) {
      return;
    }

    get().commitHistory();

    // First half: keeps the incoming transition (it still enters at the original
    // boundary) and its own single-occurrence source range. Second half: the
    // user just carved this sub-scene out to reframe it, so it glides in on an
    // eased default transition (matches ingest.ts's DEFAULT_SMART_TRANSITION) and
    // is tagged `manualScene` so the timeline can color-code it. Both kept, both
    // plain cuts (isKeeperTake false). Both halves descend from the SAME take, so
    // they share one lineage id (the clip's own originId, or its id if it had
    // none) -- Stage-3 auto-merge can recombine them if the cut between them is
    // later deleted. The `...clip` spread carries over any per-scene screenFraming
    // / faceFraming / splitRatio override onto both halves, which is correct.
    const originId = clip.originId ?? clip.id;
    const firstHalf: Clip = {
      ...clip,
      srcEnd: splitSrc,
      occurrences: [{ start: clip.srcStart, end: splitSrc }],
      keeperIndex: 0,
      isKeeperTake: false,
      originId,
    };
    const secondHalf: Clip = {
      ...clip,
      id: nextSplitClipId(),
      srcStart: splitSrc,
      occurrences: [{ start: splitSrc, end: clip.srcEnd }],
      keeperIndex: 0,
      isKeeperTake: false,
      transitionIn: { ...DEFAULT_SMART_TRANSITION },
      manualScene: true,
      originId,
    };

    const next = [...clips];
    next.splice(index, 1, firstHalf, secondHalf);
    const laidOut = recomputeTimeline(next);
    set({
      clips: laidOut,
      duration: deriveDuration(laidOut),
      // Select the second half so a follow-up edit (delete/trim) targets the
      // piece after the cut -- the common "split then remove the tail" flow.
      selectedClipId: secondHalf.id,
      selectedSfxClipId: null,
    });
  },

  // --- media bin (Files panel) actions --------------------------------------
  addMediaAsset: (asset) => {
    const normalizedAsset =
      asset.kind === "video" && asset.videoSource
        ? {
            ...asset,
            src: footageUrlForPath(asset.videoSource.workingPath),
            sourcePath: asset.videoSource.workingPath,
          }
        : asset;
    // Dedupe on the on-disk path: re-importing the same file (or auto-registering
    // an already-registered overlay/music source) must not add a duplicate row.
    // Falls back to matching on `src` when no sourcePath is known (blob fallback).
    const existing = get().mediaAssets.find((a) =>
      normalizedAsset.sourcePath
        ? a.sourcePath === normalizedAsset.sourcePath
        : a.src === normalizedAsset.src
    );
    if (existing) return existing.id;
    const id = nextMediaAssetId();
    // Not part of undo history: this is passive inventory.
    set((s) => ({
      mediaAssets: [...s.mediaAssets, { ...normalizedAsset, id }],
    }));
    return id;
  },
  removeMediaAsset: (id) => {
    const initial = get();
    const asset = initial.mediaAssets.find((a) => a.id === id);
    if (!asset) return;

    // Deleting a Files-bin entry deletes the asset EVERYWHERE: the bin row AND
    // every placed instance that came from it (overlays dropped on the canvas, and
    // the Music track if it was set from this asset). A bin delete that left placed
    // copies behind reads as a no-op / half-delete. Identity is the on-disk
    // `sourcePath` (the stable key the bin dedupes on); fall back to `src` for a
    // transient blob-fallback asset that never got a disk path.
    const matches = (ref: { sourcePath?: string; src: string }): boolean =>
      asset.sourcePath && ref.sourcePath
        ? ref.sourcePath === asset.sourcePath
        : ref.src === asset.src;

    const activeTargetId = activeOverlayAppearanceGesture?.id;
    if (
      activeTargetId &&
      initial.overlays.some(
        (overlay) => overlay.id === activeTargetId && matches(overlay)
      )
    ) {
      cancelActiveOverlayAppearanceGestureForOverlay(activeTargetId);
    }

    const removesOverlay = initial.overlays.some(matches);
    if (removesOverlay) get().commitHistory();
    const s = get();
    const nextAssets = s.mediaAssets.filter((a) => a.id !== id);
    const remainingOverlays = s.overlays.filter((o) => !matches(o));
    const clearMusic = s.musicTrack ? matches(s.musicTrack) : false;

    // Only touch overlay state if something actually changed, so an image-asset
    // delete never needlessly re-packs/deselects overlays.
    const overlaysChanged = remainingOverlays.length !== s.overlays.length;

    set({
      mediaAssets: nextAssets,
      ...(overlaysChanged
        ? {
            overlays: densePackOverlayZ(remainingOverlays),
            selectedOverlayIds: s.selectedOverlayIds.filter((sid) =>
              remainingOverlays.some((o) => o.id === sid)
            ),
            selectedOverlayId: remainingOverlays.some((o) => o.id === s.selectedOverlayId)
              ? s.selectedOverlayId
              : null,
          }
        : {}),
      ...(clearMusic ? { musicTrack: null } : {}),
    });
  },

  // --- overlay actions ------------------------------------------------------
  addOverlay: (
    descriptor,
    previewRect = { left: 0, top: 0, width: 1080, height: 1920 },
    effectiveSplitRatio = get().splitRatio
  ) => {
    get().commitHistory();
    const { overlays, duration } = get();
    const id = nextOverlayId();
    const isVideo = descriptor.kind === "video";
    const srcDuration = isVideo ? Math.max(0, descriptor.srcDuration ?? 0) : 0;

    // Clamp the start into the project; give a sane default window (image 4s,
    // video its own length capped at 6s), then clamp the window to the project
    // end so an overlay never claims to extend past the reel.
    const timelineStart = Math.max(0, Math.min(duration, descriptor.atTime));
    const rawLength = isVideo
      ? Math.min(srcDuration || MAX_DEFAULT_VIDEO_OVERLAY_DURATION, MAX_DEFAULT_VIDEO_OVERLAY_DURATION)
      : DEFAULT_IMAGE_OVERLAY_DURATION;
    const maxLength = Math.max(MIN_OVERLAY_DURATION, duration - timelineStart);
    // When there IS a timeline, cap the window to what's left; a zero/short
    // duration project (overlay added before footage) keeps the raw default so
    // the block is still visible/editable once footage lands.
    const length = duration > 0 ? Math.min(rawLength, maxLength) : rawLength;

    // Stack on top: max existing z + 1 (0 for the first overlay).
    const maxZ = overlays.reduce((m, o) => Math.max(m, o.zIndex), -1);

    // Resolve all initial transforms against the caller's frame-effective split
    // and preview geometry before publishing them to rendering or hit testing.
    const splitRatio = parsePersistedSplitRatio(
      effectiveSplitRatio,
      get().splitRatio
    );
    const band = descriptor.band ?? "screen";
    // DEFAULT PLACEMENT = COVER THE SCREEN (top) BAND. Every overlay --
    // FCPXML B-roll AND a manually dropped image/video -- lands filling the screen
    // recording panel edge-to-edge (crop overflow), clipped to that band so it
    // never bleeds onto the face cam. The user can freely drag/resize/rotate after;
    // `band` only fixes the clip region, not the transform.
    //
    // When the caller passes an explicit `scale`/`atPoint` (a deliberate drop at a
    // point, e.g. a paste), honor it instead of cover -- but still clamp inside the
    // top band with the legacy keep-out so it doesn't straddle the seam.
    const explicit = descriptor.scale != null || descriptor.atPoint != null;
    let scale: number;
    let x: number;
    let y: number;
    if (!explicit) {
      const bandHeight =
        band === "screen" ? splitRatio : band === "face" ? 1 - splitRatio : 1;
      scale = screenCoverScale(
        descriptor.naturalWidth,
        descriptor.naturalHeight,
        bandHeight
      );
      x = 0.5;
      y =
        band === "screen"
          ? splitRatio / 2
          : band === "face"
            ? (1 + splitRatio) / 2
            : 0.5;
    } else {
      scale = descriptor.scale ?? 1;
      x = descriptor.atPoint?.x ?? 0.5;
      y =
        descriptor.atPoint?.y ??
        (band === "screen"
          ? splitRatio / 2
          : band === "face"
            ? (1 + splitRatio) / 2
            : 0.5);
    }

    const initialTransform: OverlayTransform = {
      x,
      y,
      scale,
      rotation: 0,
    };
    const overlayBase: Overlay = {
      id,
      kind: descriptor.kind,
      src:
        isVideo && descriptor.videoSource
          ? footageUrlForPath(descriptor.videoSource.workingPath)
          : descriptor.src,
      sourcePath:
        isVideo && descriptor.videoSource
          ? descriptor.videoSource.workingPath
          : descriptor.sourcePath,
      ...(isVideo && descriptor.videoSource
        ? { videoSource: descriptor.videoSource }
        : {}),
      naturalWidth: descriptor.naturalWidth,
      naturalHeight: descriptor.naturalHeight,
      timelineStart,
      timelineEnd: timelineStart + length,
      srcStart: 0,
      srcDuration,
      transform: initialTransform,
      // Band clipping and selection geometry share this same published transform.
      band,
      zIndex: maxZ + 1,
      opacity: 1,
      ...normalizeOverlayAppearance({}),
      ...(isVideo ? { muted: true as const } : {}),
    };
    const overlay: Overlay = {
      ...overlayBase,
      transform: clampOverlayToBand(
        overlayBase,
        initialTransform,
        previewRect,
        splitRatio
      ),
    };

    // Selecting the new overlay clears any clip selection (mutual exclusion) and
    // resets the multi-selection to just this fresh overlay.
    set({
      overlays: [...overlays, overlay],
      selectedOverlayId: id,
      selectedOverlayIds: [id],
      selectedClipId: null,
      selectedSfxClipId: null,
    });
    return id;
  },

  updateOverlayTransform: (id, patch) => {
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target) return;
    const next = { ...target.transform, ...patch };
    if (
      next.x === target.transform.x &&
      next.y === target.transform.y &&
      next.scale === target.transform.scale &&
      next.rotation === target.transform.rotation
    ) return;
    // Coalesce the whole canvas gesture (move/resize/rotate) into one undo step.
    get().commitHistory(`ovxform:${id}`);
    const overlays = get().overlays;
    set({
      overlays: overlays.map((o) =>
        o.id === id ? { ...o, transform: { ...o.transform, ...patch } } : o
      ),
    });
  },

  beginOverlayTransformGesture: (id) => {
    cancelActiveSfxGesture();
    cancelActiveCaptionGesture();
    cancelActiveOverlayAppearanceGesture();
    if (cancelActiveSplitRatioGesture()) signalSplitRatioGestureCancellation();
    cancelActiveOverlayTransformGesture();
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target) return null;
    const token = `overlay-transform-gesture-${++overlayTransformGestureCounter}`;
    activeOverlayTransformGesture = {
      token,
      id,
      initialTransform: { ...target.transform },
      past: get().past,
      future: get().future,
      historyCommitted: false,
    };
    return token;
  },

  updateOverlayTransformGesture: (token, patch) => {
    const gesture = activeOverlayTransformGesture;
    if (!gesture || gesture.token !== token) return;
    const overlays = get().overlays;
    const target = overlays.find((overlay) => overlay.id === gesture.id);
    if (!target) {
      cancelActiveOverlayTransformGesture();
      return;
    }
    const next: OverlayTransform = { ...target.transform };
    for (const field of ["x", "y", "scale", "rotation"] as const) {
      const value = patch[field];
      if (value !== undefined && Number.isFinite(value)) next[field] = value;
    }
    if (
      next.x === target.transform.x &&
      next.y === target.transform.y &&
      next.scale === target.transform.scale &&
      next.rotation === target.transform.rotation
    ) return;
    if (!gesture.historyCommitted) {
      captureHistoryEntry();
      gesture.historyCommitted = true;
    }
    set({
      overlays: overlays.map((overlay) =>
        overlay.id === gesture.id ? { ...overlay, transform: next } : overlay
      ),
    });
  },

  endOverlayTransformGesture: (token) => {
    if (activeOverlayTransformGesture?.token !== token) return;
    activeOverlayTransformGesture = null;
  },
  cancelOverlayTransformGesture: (token) => {
    if (activeOverlayTransformGesture?.token !== token) return;
    cancelActiveOverlayTransformGesture();
  },
  subscribeOverlayTransformGestureCancellation: (listener) => {
    overlayTransformGestureCancellationListeners.add(listener);
    return () => overlayTransformGestureCancellationListeners.delete(listener);
  },

  setOverlayOpacity: (id, opacity) => {
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target) return;
    const next = Math.max(0, Math.min(1, opacity));
    if (next === target.opacity) return; // no-op frame -- no step
    // Coalesce the whole slider drag into one undo step (own key namespace).
    get().commitHistory(`ovopacity:${id}`);
    const overlays = get().overlays;
    set({
      overlays: overlays.map((o) => (o.id === id ? { ...o, opacity: next } : o)),
    });
  },

  copySelectedAttributes: (overlayId) => {
    const { selectedOverlayId, overlays, selectedClipId, clips, splitRatio } =
      get();
    const targetOverlayId = overlayId ?? selectedOverlayId;
    if (targetOverlayId) {
      const o = overlays.find((x) => x.id === targetOverlayId);
      if (!o) return false;
      const appearance = normalizeOverlayAppearance(o);
      set({
        attributeClipboard: {
          kind: "overlay",
          transform: { ...o.transform },
          opacity: o.opacity,
          entranceEffect: { ...appearance.entranceEffect },
          exitEffect: { ...appearance.exitEffect },
          cornerRadius: appearance.cornerRadius,
        },
      });
      return true;
    }
    if (selectedClipId) {
      const index = clips.findIndex((c) => c.id === selectedClipId);
      if (index === -1 || !clips[index].kept) return false;
      // Framing preserves its existing backward-inheritance behavior. Split is
      // different: an absent scene override resolves directly to the global.
      const resolveFraming = <K extends "faceFraming" | "screenFraming">(
        field: K
      ): Clip[K] => {
        for (let i = index; i >= 0; i--) {
          const c = clips[i];
          if (c.kept && c[field] !== undefined) return c[field];
        }
        return undefined;
      };
      const face = resolveFraming("faceFraming");
      const screen = resolveFraming("screenFraming");
      set({
        attributeClipboard: {
          kind: "clip",
          faceFraming: face ? { ...face } : undefined,
          screenFraming: screen ? { ...screen } : undefined,
          splitRatio:
            clampSplitRatio(clips[index].splitRatio ?? Number.NaN) ??
            parsePersistedSplitRatio(splitRatio, 0.5),
        },
      });
      return true;
    }
    return false;
  },

  pasteAttributesToSelection: (
    rect = { left: 0, top: 0, width: 1080, height: 1920 },
    effectiveSplitRatio = get().splitRatio
  ) => {
    const cb = get().attributeClipboard;
    if (!cb) return false;

    if (cb.kind === "overlay") {
      const { selectedOverlayIds } = get();
      if (selectedOverlayIds.length === 0) return false;
      const targets = new Set(selectedOverlayIds);
      const apply = (overlays: Overlay[]) => {
        let changed = false;
        const next = overlays.map((overlay) => {
          if (!targets.has(overlay.id)) return overlay;
          if (!isOverlayBandVisible(overlay.band, effectiveSplitRatio)) {
            return overlay;
          }
          const transform = clampOverlayToBand(
            overlay,
            { ...cb.transform },
            rect,
            effectiveSplitRatio
          );
          const appearance = normalizeOverlayAppearance(overlay);
          if (
            overlay.opacity === cb.opacity &&
            overlay.transform.x === transform.x &&
            overlay.transform.y === transform.y &&
            overlay.transform.scale === transform.scale &&
            overlay.transform.rotation === transform.rotation &&
            overlayEffectEqual(appearance.entranceEffect, cb.entranceEffect) &&
            overlayEffectEqual(appearance.exitEffect, cb.exitEffect) &&
            appearance.cornerRadius === cb.cornerRadius
          ) {
            return overlay;
          }
          changed = true;
          return {
            ...overlay,
            transform,
            opacity: cb.opacity,
            entranceEffect: { ...cb.entranceEffect },
            exitEffect: { ...cb.exitEffect },
            cornerRadius: cb.cornerRadius,
          };
        });
        return { changed, next };
      };
      const initial = apply(get().overlays);
      // Nothing would actually change: no phantom history step (same no-op
      // discipline as updateOverlayTransform/setOverlayOpacity).
      if (!initial.changed) return false;
      cancelActiveOverlayAppearanceGesture();
      const fresh = apply(get().overlays);
      if (!fresh.changed) return false;
      get().commitHistory();
      set({ overlays: fresh.next });
      return true;
    }

    // kind === "clip": paste the framing set onto the selected scene. Face
    // framing honors the syncFaceCam locked-camera contract (one framing for
    // every kept clip, exactly like setClipFaceFraming); screen framing and
    // split ratio land on the target scene only. Whole paste = ONE undo step.
    const { selectedClipId, clips, syncFaceCam } = get();
    if (!selectedClipId) return false;
    const target = clips.find((c) => c.id === selectedClipId);
    if (!target || !target.kept) return false;

    const clampFraming = (f: FaceFraming): FaceFraming => ({
      x: Math.max(-1, Math.min(1, f.x)),
      y: Math.max(-1, Math.min(1, f.y)),
      scale: Math.max(1, Math.min(6, f.scale)),
    });
    const face = cb.faceFraming ? clampFraming(cb.faceFraming) : undefined;
    const screen = cb.screenFraming ? clampFraming(cb.screenFraming) : undefined;
    const ratio = clampSplitRatio(cb.splitRatio);
    const framingEq = (a: FaceFraming | undefined, b: FaceFraming): boolean =>
      !!a && a.x === b.x && a.y === b.y && a.scale === b.scale;

    let changed = false;
    const next = clips.map((c) => {
      if (!c.kept) return c;
      const isTarget = c.id === selectedClipId;
      const needFace =
        !!face && (isTarget || syncFaceCam) && !framingEq(c.faceFraming, face);
      const needScreen =
        isTarget && !!screen && !framingEq(c.screenFraming, screen);
      const needRatio = isTarget && ratio !== null && c.splitRatio !== ratio;
      if (!needFace && !needScreen && !needRatio) return c;
      changed = true;
      const nextClip = { ...c };
      if (needFace && face) nextClip.faceFraming = { ...face };
      if (needScreen && screen) nextClip.screenFraming = { ...screen };
      if (needRatio && ratio !== null) nextClip.splitRatio = ratio;
      return nextClip;
    });
    // Pasting attributes the selection already has: no phantom history step
    // (same no-op discipline as setClipFaceFraming/setClipSplitRatio).
    if (!changed) return false;
    get().commitHistory();
    set({ clips: next });
    return true;
  },

  moveOverlay: (id, timelineStart) => {
    const initial = get();
    const target = initial.overlays.find((overlay) => overlay.id === id);
    if (!target) return;
    const length = target.timelineEnd - target.timelineStart;
    // Preserve length; clamp so the whole window stays inside [0, duration].
    // With no timeline yet (duration 0) only the >= 0 floor applies.
    const maxStart = Math.max(
      0,
      initial.duration > 0 ? initial.duration - length : timelineStart
    );
    const nextStart = Math.max(0, Math.min(maxStart, timelineStart));
    if (nextStart === target.timelineStart) return; // no-op drag frame -- no step
    get().commitHistory(`ovmove:${id}`);
    const overlays = get().overlays;
    set({
      overlays: overlays.map((o) =>
        o.id === id
          ? { ...o, timelineStart: nextStart, timelineEnd: nextStart + length }
          : o
      ),
    });
    // NO recomputeTimeline: overlays are independent of the reel length.
  },

  trimOverlay: (id, edge, timelineTarget) => {
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target) return;
    get().commitHistory(`ovtrim:${id}:${edge}`);
    const { overlays, duration } = get();
    set({
      overlays: overlays.map((o) => {
        if (o.id !== id) return o;
        if (edge === "start") {
          // Absolute target, clamped: can't cross within MIN of the end, can't
          // go below 0. A start-trim advances the video srcStart by the same
          // delta so the shown frame stays put, clamped against available
          // footage (0..srcDuration) so it never seeks past the source.
          const maxStart = o.timelineEnd - MIN_OVERLAY_DURATION;
          const nextStart = Math.max(0, Math.min(maxStart, timelineTarget));
          const delta = nextStart - o.timelineStart;
          let srcStart = o.srcStart;
          if (o.kind === "video" && o.srcDuration > 0) {
            const maxSrcStart = Math.max(0, o.srcDuration - MIN_OVERLAY_DURATION);
            srcStart = Math.max(0, Math.min(maxSrcStart, o.srcStart + delta));
          }
          return { ...o, timelineStart: nextStart, srcStart };
        }
        // End edge: absolute target, clamped to at least MIN past the start and
        // to the project end. For a video, also cap the window so it can't run
        // past the footage remaining from srcStart.
        const minEnd = o.timelineStart + MIN_OVERLAY_DURATION;
        let maxEnd = duration > 0 ? duration : timelineTarget;
        if (o.kind === "video" && o.srcDuration > 0) {
          const srcRemaining = o.srcDuration - o.srcStart;
          maxEnd = Math.min(maxEnd, o.timelineStart + srcRemaining);
        }
        const nextEnd = Math.max(minEnd, Math.min(maxEnd, timelineTarget));
        return { ...o, timelineEnd: nextEnd };
      }),
    });
    // NO recomputeTimeline: overlays never ripple.
  },

  removeOverlay: (id) => {
    if (!get().overlays.some((overlay) => overlay.id === id)) return;
    cancelActiveOverlayAppearanceGestureForOverlay(id);
    get().commitHistory();
    const { overlays, selectedOverlayId } = get();
    // Dense-pack the survivors so z gaps never grow, and drop a dangling select.
    const remaining = densePackOverlayZ(overlays.filter((o) => o.id !== id));
    const nextIds = get().selectedOverlayIds.filter((sid) => sid !== id);
    set({
      overlays: remaining,
      selectedOverlayIds: nextIds,
      // Primary follows the multi-set's last member (or null); if the removed id
      // wasn't the primary the primary is unaffected.
      selectedOverlayId:
        selectedOverlayId === id ? (nextIds[nextIds.length - 1] ?? null) : selectedOverlayId,
    });
  },

  duplicateOverlay: (id, rect, effectiveSplitRatio) => {
    if (!get().overlays.some((overlay) => overlay.id === id)) return null;
    get().commitHistory();
    const overlays = get().overlays;
    const src = overlays.find((overlay) => overlay.id === id)!;
    const copyId = nextOverlayId();
    const maxZ = overlays.reduce((m, o) => Math.max(m, o.zIndex), -1);
    // Nudge the copy a hair down-right (normalized) so it's visibly offset, and
    // stack it on top. Same src/media -- a duplicate shares the on-disk asset.
    const transform = clampOverlayToBand(
      src,
      {
        ...src.transform,
        x: src.transform.x + 0.04,
        y: src.transform.y + 0.04,
      },
      rect,
      effectiveSplitRatio
    );
    const copy: Overlay = {
      ...src,
      id: copyId,
      transform,
      ...normalizeOverlayAppearance(src),
      entranceEffect: { ...normalizeOverlayAppearance(src).entranceEffect },
      exitEffect: { ...normalizeOverlayAppearance(src).exitEffect },
      zIndex: maxZ + 1,
    };
    set({
      overlays: [...overlays, copy],
      selectedOverlayId: copyId,
      selectedOverlayIds: [copyId],
      selectedClipId: null,
      selectedSfxClipId: null,
    });
    // Return the fresh id so a direct-manipulation caller (Cmd/Ctrl-drag clone)
    // can begin a move gesture on the COPY straight away.
    return copyId;
  },

  setOverlayZ: (id, dir) => {
    const initialOverlays = get().overlays;
    if (
      initialOverlays.length < 2 ||
      !initialOverlays.some((overlay) => overlay.id === id)
    ) return;
    // Work on a z-sorted view; move the target within it, then dense-pack back.
    const initialOrder = [...initialOverlays].sort((a, b) => a.zIndex - b.zIndex);
    const from = initialOrder.findIndex((overlay) => overlay.id === id);
    let to = from;
    if (dir === "front") to = initialOrder.length - 1;
    else if (dir === "back") to = 0;
    else if (dir === "forward") to = Math.min(initialOrder.length - 1, from + 1);
    else if (dir === "backward") to = Math.max(0, from - 1);
    if (to === from) return; // already at the requested end -- no step
    get().commitHistory();
    const overlays = get().overlays;
    const ordered = [...overlays].sort((a, b) => a.zIndex - b.zIndex);
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    // Assign dense 0..n-1 by the new order; map back onto the store array order.
    const rank = new Map<string, number>();
    ordered.forEach((o, i) => rank.set(o.id, i));
    set({
      overlays: overlays.map((o) => {
        const z = rank.get(o.id) ?? o.zIndex;
        return z === o.zIndex ? o : { ...o, zIndex: z };
      }),
    });
  },

  // Transient (no history). Selecting an overlay clears the clip selection so the
  // canvas + timeline only ever highlight one object at a time. A plain select
  // RESETS the multi-selection to just this id (or empty), so every existing
  // single-select path keeps working while multi-select stays a strict superset.
  selectOverlay: (id) =>
    set({
      selectedOverlayId: id,
      selectedOverlayIds: id === null ? [] : [id],
      selectedClipId: id === null ? get().selectedClipId : null,
      selectedSfxClipId: id === null ? get().selectedSfxClipId : null,
    }),

  // Caption-block selection is orthogonal to the canvas object selection (it
  // lives in the Inspector rail, not on the canvas), so it does NOT clear
  // selectedClipId / selectedOverlayId. Transient -- never enters history.
  selectCaptionBlock: (id) => set({
    selectedCaptionBlockId: id,
    selectedSfxClipId: id === null ? get().selectedSfxClipId : null,
  }),

  toggleOverlaySelected: (id) => {
    const { overlays, selectedOverlayIds } = get();
    if (!overlays.some((o) => o.id === id)) return; // guard a stale id
    const has = selectedOverlayIds.includes(id);
    // Remove -> drop it; the new PRIMARY is the resulting last member (or null).
    // Add -> append it and make it primary (last === primary invariant).
    const nextIds = has
      ? selectedOverlayIds.filter((sid) => sid !== id)
      : [...selectedOverlayIds, id];
    set({
      selectedOverlayIds: nextIds,
      selectedOverlayId: nextIds[nextIds.length - 1] ?? null,
      // A non-empty overlay selection is mutually exclusive with a clip selection.
      selectedClipId: nextIds.length > 0 ? null : get().selectedClipId,
      selectedSfxClipId: nextIds.length > 0 ? null : get().selectedSfxClipId,
    });
  },

  alignOverlays: (edge, rect, effectiveSplitRatio) => {
    const { overlays, selectedOverlayIds } = get();
    const selected = overlays.filter(
      (o) =>
        selectedOverlayIds.includes(o.id) &&
        isOverlayBandVisible(o.band, effectiveSplitRatio)
    );
    if (selected.length < 2) return; // nothing to align
    const visualById = new Map(
      selected.map((o) => [
        o.id,
        resolveOverlayTransformForFrame(o, rect, effectiveSplitRatio),
      ])
    );
    const moves = computeAlignOverlays(
      selected.map((o) => ({
        id: o.id,
        transform: visualById.get(o.id)!,
        naturalWidth: o.naturalWidth,
        naturalHeight: o.naturalHeight,
      })),
      edge,
      rect
    );
    if (moves.size === 0) return; // already aligned -- no step
    let changed = false;
    const next = overlays.map((o) => {
      const moved = moves.get(o.id);
      if (!moved) return o;
      const transform = applyVisualTransformDeltaToPersisted(
        o.transform,
        visualById.get(o.id)!,
        moved
      );
      if (
        transform.x === o.transform.x &&
        transform.y === o.transform.y &&
        transform.scale === o.transform.scale &&
        transform.rotation === o.transform.rotation
      ) return o;
      changed = true;
      return { ...o, transform };
    });
    if (!changed) return;
    get().commitHistory(); // discrete: one undo step
    set({
      overlays: get().overlays.map((overlay) => {
        const moved = moves.get(overlay.id);
        if (!moved) return overlay;
        const transform = applyVisualTransformDeltaToPersisted(
          overlay.transform,
          visualById.get(overlay.id)!,
          moved
        );
        return { ...overlay, transform };
      }),
    });
  },

  setOverlayEntranceEffect: (id, effect) => {
    cancelActiveOverlayAppearanceGesture();
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target) return;
    const current = normalizeOverlayAppearance(target).entranceEffect;
    const next = normalizeOverlayAppearance({ entranceEffect: effect }).entranceEffect;
    if (overlayEffectEqual(current, next)) return;
    get().commitHistory();
    const overlays = get().overlays;
    set({
      overlays: overlays.map((overlay) =>
        overlay.id === id ? { ...overlay, entranceEffect: { ...next } } : overlay
      ),
    });
  },

  setOverlayExitEffect: (id, effect) => {
    cancelActiveOverlayAppearanceGesture();
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target) return;
    const current = normalizeOverlayAppearance(target).exitEffect;
    const next = normalizeOverlayAppearance({ exitEffect: effect }).exitEffect;
    if (overlayEffectEqual(current, next)) return;
    get().commitHistory();
    const overlays = get().overlays;
    set({
      overlays: overlays.map((overlay) =>
        overlay.id === id ? { ...overlay, exitEffect: { ...next } } : overlay
      ),
    });
  },

  setOverlayCornerRadius: (id, radius) => {
    cancelActiveOverlayAppearanceGesture();
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target || !Number.isFinite(radius)) return;
    const current = normalizeOverlayAppearance(target).cornerRadius;
    const next = normalizeOverlayAppearance({ cornerRadius: radius }).cornerRadius;
    if (current === next) return;
    get().commitHistory();
    const overlays = get().overlays;
    set({
      overlays: overlays.map((overlay) =>
        overlay.id === id ? { ...overlay, cornerRadius: next } : overlay
      ),
    });
  },

  beginOverlayAppearanceGesture: (id, field) => {
    cancelActiveSfxGesture();
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    if (cancelActiveSplitRatioGesture()) {
      signalSplitRatioGestureCancellation();
    }
    cancelActiveOverlayAppearanceGesture();
    const target = get().overlays.find((overlay) => overlay.id === id);
    if (!target) return null;
    const initialValue =
      field === "cornerRadius"
        ? target.cornerRadius
        : field === "entranceDuration"
          ? target.entranceEffect
            ? { ...target.entranceEffect }
            : undefined
          : target.exitEffect
            ? { ...target.exitEffect }
            : undefined;
    const token = `overlay-appearance-gesture-${++overlayAppearanceGestureCounter}`;
    activeOverlayAppearanceGesture = {
      token,
      id,
      field,
      initialValue,
      past: get().past,
      future: get().future,
      historyCommitted: false,
    };
    return token;
  },

  updateOverlayAppearanceGesture: (token, value) => {
    const gesture = activeOverlayAppearanceGesture;
    if (!gesture || gesture.token !== token || !Number.isFinite(value)) return;
    const overlays = get().overlays;
    const target = overlays.find((overlay) => overlay.id === gesture.id);
    if (!target) {
      cancelActiveOverlayAppearanceGesture();
      return;
    }

    const appearance = normalizeOverlayAppearance(target);
    let nextOverlay: Overlay;
    if (gesture.field === "cornerRadius") {
      const cornerRadius = normalizeOverlayAppearance({ cornerRadius: value })
        .cornerRadius;
      if (cornerRadius === appearance.cornerRadius) return;
      nextOverlay = { ...target, cornerRadius };
    } else {
      const effectField =
        gesture.field === "entranceDuration" ? "entranceEffect" : "exitEffect";
      const current = appearance[effectField];
      const next = normalizeOverlayAppearance({
        [effectField]: { ...current, durationSec: value },
      })[effectField];
      if (overlayEffectEqual(current, next)) return;
      nextOverlay = { ...target, [effectField]: { ...next } };
    }

    if (!gesture.historyCommitted) {
      captureHistoryEntry();
      gesture.historyCommitted = true;
    }
    set({
      overlays: overlays.map((overlay) =>
        overlay.id === gesture.id ? nextOverlay : overlay
      ),
    });
  },

  endOverlayAppearanceGesture: (token) => {
    if (activeOverlayAppearanceGesture?.token !== token) return;
    activeOverlayAppearanceGesture = null;
  },
  cancelOverlayAppearanceGesture: (token) => {
    if (activeOverlayAppearanceGesture?.token !== token) return;
    cancelActiveOverlayAppearanceGesture();
  },
  subscribeOverlayAppearanceGestureCancellation: (listener) => {
    overlayAppearanceGestureCancellationListeners.add(listener);
    return () => overlayAppearanceGestureCancellationListeners.delete(listener);
  },

  distributeOverlays: (axis, rect, effectiveSplitRatio) => {
    const { overlays, selectedOverlayIds } = get();
    const selected = overlays.filter(
      (o) =>
        selectedOverlayIds.includes(o.id) &&
        isOverlayBandVisible(o.band, effectiveSplitRatio)
    );
    if (selected.length < 3) return; // need >= 3 to equalize interior gaps
    const visualById = new Map(
      selected.map((o) => [
        o.id,
        resolveOverlayTransformForFrame(o, rect, effectiveSplitRatio),
      ])
    );
    const moves = computeDistributeOverlays(
      selected.map((o) => ({
        id: o.id,
        transform: visualById.get(o.id)!,
        naturalWidth: o.naturalWidth,
        naturalHeight: o.naturalHeight,
      })),
      axis,
      rect
    );
    if (moves.size === 0) return;
    let changed = false;
    const next = overlays.map((o) => {
      const moved = moves.get(o.id);
      if (!moved) return o;
      const transform = applyVisualTransformDeltaToPersisted(
        o.transform,
        visualById.get(o.id)!,
        moved
      );
      if (
        transform.x === o.transform.x &&
        transform.y === o.transform.y &&
        transform.scale === o.transform.scale &&
        transform.rotation === o.transform.rotation
      ) return o;
      changed = true;
      return { ...o, transform };
    });
    if (!changed) return;
    get().commitHistory();
    set({
      overlays: get().overlays.map((overlay) => {
        const moved = moves.get(overlay.id);
        if (!moved) return overlay;
        const transform = applyVisualTransformDeltaToPersisted(
          overlay.transform,
          visualById.get(overlay.id)!,
          moved
        );
        return { ...overlay, transform };
      }),
    });
  },

  // Live overlay-move flag. Transient chrome -- no history,
  // never exported. The gesture flips it true on move-start / false on pointer-up
  // so the SelectionOverlay can lift the media and the cursor can read `grabbing`.
  // Identity-guarded so re-setting the same value never churns a render.
  overlayDragging: false,
  setOverlayDragging: (dragging) => {
    if (get().overlayDragging === dragging) return;
    set({ overlayDragging: dragging });
  },

  getSelectedObject: () => {
    const { selectedOverlayId, selectedClipId } = get();
    if (selectedOverlayId !== null) return { type: "overlay", id: selectedOverlayId };
    if (selectedClipId !== null) return { type: "clip", id: selectedClipId };
    return null;
  },

  setSplitRatio: (ratio) => {
    const clamped = clampSplitRatio(ratio);
    if (clamped === null) return;
    if (clamped === get().splitRatio) return; // no-op drag frame -- no history
    get().commitHistory();
    set({ splitRatio: clamped });
  },

  beginSplitRatioGesture: (target) => {
    cancelActiveSfxGesture();
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    cancelActiveOverlayAppearanceGesture();
    if (cancelActiveSplitRatioGesture()) {
      signalSplitRatioGestureCancellation();
    }
    if (
      target.kind === "clip" &&
      !get().clips.some((clip) => clip.id === target.id && clip.kept)
    ) {
      return null;
    }
    const token = `split-ratio-gesture-${++splitRatioGestureCounter}`;
    activeSplitRatioGesture = { token, target, historyCommitted: false };
    return token;
  },

  updateSplitRatioGesture: (token, ratio) => {
    const gesture = activeSplitRatioGesture;
    if (!gesture || gesture.token !== token) return;
    const clamped = clampSplitRatio(ratio);
    if (clamped === null) return;

    if (gesture.target.kind === "global") {
      if (clamped === get().splitRatio) return;
      if (!gesture.historyCommitted) {
        captureHistoryEntry();
        gesture.historyCommitted = true;
      }
      set({ splitRatio: clamped });
      return;
    }

    const targetId = gesture.target.id;
    const clips = get().clips;
    const target = clips.find((clip) => clip.id === targetId);
    if (!target || !target.kept) {
      cancelActiveSplitRatioGesture();
      signalSplitRatioGestureCancellation();
      return;
    }
    const currentRatio =
      target.splitRatio === undefined
        ? parsePersistedSplitRatio(get().splitRatio, 0.5)
        : clampSplitRatio(target.splitRatio) ??
          parsePersistedSplitRatio(get().splitRatio, 0.5);
    if (currentRatio === clamped) return;
    if (!gesture.historyCommitted) {
      captureHistoryEntry();
      gesture.historyCommitted = true;
    }
    set({
      clips: clips.map((clip) =>
        clip.id === targetId ? { ...clip, splitRatio: clamped } : clip
      ),
    });
  },

  endSplitRatioGesture: (token) => closeSplitRatioGesture(token, false),
  cancelSplitRatioGesture: (token) => closeSplitRatioGesture(token, true),
  subscribeSplitRatioGestureCancellation: (listener) => {
    splitRatioGestureCancellationListeners.add(listener);
    return () => splitRatioGestureCancellationListeners.delete(listener);
  },

  setGrade: (track, gradeId) => {
    const cur = track === "screen" ? get().screenGrade : get().faceGrade;
    if (cur === gradeId) return; // picking the already-active grade -- no step
    get().commitHistory();
    set(track === "screen" ? { screenGrade: gradeId } : { faceGrade: gradeId });
  },

  // --- words + captions ------------------------------------------------------
  setWords: (words) => {
    // A new transcript reindexes every word, so any prior strikethrough set is
    // meaningless (its indices point at different words now) -- clear it.
    set({ words, deletedWordIndices: [], selectedWordRange: null });
    // Keep caption blocks in sync with the new transcript.
    get().rebuildCaptionBlocks();
  },
  applyTranscript: (input) => {
    closeActiveHistoryGestures();
    const state = get();
    if (input.mode === "rebuild" && input.rebuiltClips === undefined) return;

    const clips =
      input.mode === "rebuild"
        ? recomputeTimeline(input.rebuiltClips!)
        : state.clips;
    const duration =
      input.mode === "rebuild" ? deriveDuration(clips) : state.duration;
    const captionBlocks = buildCaptionBlocksForState({
      words: input.words,
      clips,
      deletedWordIndices: [],
      style: state.captionStyle,
    });
    lastCommitKey = null;
    lastCommitAt = Date.now();
    const past = [...state.past, captureSnapshot(state)];
    if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
    const historyPatch = { past, future: [] as EditableSnapshot[] };

    if (input.mode === "preserve-cuts") {
      set({
        ...historyPatch,
        words: input.words,
        deletedWordIndices: [],
        selectedWordRange: null,
        selectedCaptionBlockId: null,
        captionsEnabled: true,
        captionBlocks,
      });
      return;
    }

    let inPoint =
      state.inPoint === null ? null : Math.max(0, Math.min(duration, state.inPoint));
    let outPoint =
      state.outPoint === null ? null : Math.max(0, Math.min(duration, state.outPoint));
    if (inPoint !== null && outPoint !== null && inPoint >= outPoint) {
      inPoint = null;
      outPoint = null;
    }
    overlayDeleteStash.clear();
    set({
      ...historyPatch,
      clips,
      duration,
      words: input.words,
      deletedWordIndices: [],
      selectedWordRange: null,
      selectedCaptionBlockId: null,
      selectedClipId: null,
      captionsEnabled: true,
      captionBlocks,
      ...constrainCurrentSfxToDuration(duration),
      editStats: input.editStats ?? null,
      playhead: Math.max(0, Math.min(duration, state.playhead)),
      inPoint,
      outPoint,
    });
  },

  // --- sound effects ---------------------------------------------------------
  addSfxAsset: (asset) => {
    const existing = get().sfxAssets.find(
      (candidate) => candidate.sourcePath === asset.sourcePath
    );
    if (existing) return existing.id;
    const id = nextAvailableSfxAssetId(new Set(get().sfxAssets.map((item) => item.id)));
    set({ sfxAssets: [...get().sfxAssets, { id, ...asset }] });
    return id;
  },

  addImportedSfxClip: (input) => {
    closeActiveHistoryGestures();
    if (
      !input.sourcePath
      || !Number.isFinite(input.srcDuration)
      || input.srcDuration <= 0
      || !Number.isFinite(input.atTime)
    ) return null;
    const state = get();
    const assetId = nextAvailableSfxAssetId(new Set(state.sfxAssets.map((asset) => asset.id)));
    const clipId = nextAvailableSfxClipId(new Set(state.sfxClips.map((clip) => clip.id)));
    const placed = placeSfxClip({
      id: clipId,
      name: input.name,
      source: { kind: "imported", assetId, srcDuration: input.srcDuration },
      origin: "manual",
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: input.srcDuration,
      gain: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      muted: false,
    }, input.atTime, state.duration);
    if (!placed) return null;
    captureHistoryEntry();
    set({
      sfxAssets: [...state.sfxAssets, {
        id: assetId,
        name: input.name,
        sourcePath: input.sourcePath,
        srcDuration: input.srcDuration,
      }],
      sfxClips: [...state.sfxClips, placed],
      ...exclusiveSfxSelection(clipId),
      sfxDocumentRevision: state.sfxDocumentRevision + 1,
    });
    return { assetId, clipId };
  },

  addSfxClip: (input) => {
    closeActiveHistoryGestures();
    const state = get();
    const sourceDuration = input.source.kind === "built-in"
      ? defaultBuiltInDuration(input.source.key)
      : sfxSourceDuration(input.source);
    const candidate: SfxClip = {
      id: nextAvailableSfxClipId(new Set(state.sfxClips.map((clip) => clip.id))),
      name: input.name,
      source: input.source,
      origin: input.origin ?? "manual",
      timelineStart: 0,
      sourceStart: input.sourceStart ?? 0,
      sourceEnd: input.sourceEnd ?? sourceDuration,
      gain: input.gain ?? 1,
      fadeInSec: input.fadeInSec ?? 0,
      fadeOutSec: input.fadeOutSec ?? 0,
      muted: input.muted ?? false,
    };
    const placed = placeSfxClip(candidate, input.atTime, state.duration);
    if (!placed) return null;
    commitSfxDocument([...state.sfxClips, placed]);
    return placed.id;
  },

  replaceAutomaticSfxClips: (automatic) => {
    closeActiveHistoryGestures();
    const state = get();
    const constrained = constrainSfxClipsToDuration(
      automatic.map((clip) => ({ ...clip, origin: "automatic" as const })),
      state.duration
    );
    const currentAutomatic = state.sfxClips.filter((clip) => clip.origin === "automatic");
    if (
      currentAutomatic.length === constrained.length
      && currentAutomatic.every((clip, index) =>
        sfxClipContentEqual(clip, constrained[index])
      )
    ) return;
    const usedIds = new Set(state.sfxClips.map((clip) => clip.id));
    const replacements = constrainSfxClipsToDuration(
      constrained.map((clip) => {
        const id = nextAvailableSfxClipId(usedIds);
        usedIds.add(id);
        return { ...clip, id, origin: "automatic" as const };
      }),
      state.duration
    );
    commitSfxDocument(mergeAutomaticSfxClips(state.sfxClips, replacements));
  },

  selectSfxClip: (id) => {
    if (id === null) {
      set({ selectedSfxClipId: null });
      return;
    }
    if (!get().sfxClips.some((clip) => clip.id === id)) return;
    set(exclusiveSfxSelection(id));
  },

  moveSfxClip: (id, timelineStart) => {
    updateSfxClip(id, (clip, duration) => moveSfxClipValue(clip, timelineStart, duration));
  },
  trimSfxClipLeft: (id, timelineStart) => {
    updateSfxClip(id, (clip) => trimSfxClipLeftValue(clip, timelineStart));
  },
  trimSfxClipRight: (id, timelineEnd) => {
    updateSfxClip(id, (clip, duration) =>
      trimSfxClipRightValue(clip, timelineEnd, duration, sfxSourceDuration(clip.source))
    );
  },
  setSfxClipSourceStart: (id, sourceStart) => {
    if (!Number.isFinite(sourceStart)) return;
    updateSfxClip(id, (clip) => ({
      ...clip,
      sourceStart: Math.max(0, Math.min(sourceStart, clip.sourceEnd - 1 / 1000)),
    }));
  },
  setSfxClipSourceEnd: (id, sourceEnd) => {
    if (!Number.isFinite(sourceEnd)) return;
    updateSfxClip(id, (clip, duration) => ({
      ...clip,
      sourceEnd: clampSfxSourceEnd(clip, sourceEnd, duration),
    }));
  },
  setSfxClipGain: (id, gain) => {
    if (!Number.isFinite(gain)) return;
    updateSfxClip(id, (clip) => ({ ...clip, gain: Math.max(0, Math.min(2, gain)) }));
  },
  setSfxClipFadeIn: (id, seconds) => {
    if (!Number.isFinite(seconds)) return;
    updateSfxClip(id, (clip) => ({
      ...clip,
      fadeInSec: Math.max(0, Math.min(2, seconds)),
    }));
  },
  setSfxClipFadeOut: (id, seconds) => {
    if (!Number.isFinite(seconds)) return;
    updateSfxClip(id, (clip) => ({
      ...clip,
      fadeOutSec: Math.max(0, Math.min(2, seconds)),
    }));
  },
  setSfxClipMuted: (id, muted) => {
    updateSfxClip(id, (clip) => ({ ...clip, muted }));
  },
  replaceSfxClipSource: (id, replacement) => {
    updateSfxClip(id, (clip, duration) =>
      replaceSfxClipSourceValue(clip, replacement, duration)
    );
  },
  duplicateSfxClip: (id) => {
    closeActiveHistoryGestures();
    const state = get();
    const target = state.sfxClips.find((clip) => clip.id === id);
    if (!target) return null;
    const duplicate = duplicateSfxClipValue(
      target,
      nextAvailableSfxClipId(new Set(state.sfxClips.map((clip) => clip.id))),
      state.duration
    );
    if (!duplicate) return null;
    commitSfxDocument([...state.sfxClips, duplicate]);
    return duplicate.id;
  },
  removeSfxClip: (id) => {
    closeActiveHistoryGestures();
    const state = get();
    if (!state.sfxClips.some((clip) => clip.id === id)) return;
    commitSfxDocument(state.sfxClips.filter((clip) => clip.id !== id));
  },

  beginSfxGesture: (id, kind) => {
    closeActiveHistoryGestures();
    const state = get();
    if (!state.sfxClips.some((clip) => clip.id === id)) return null;
    const token = `sfx-gesture-${++sfxGestureCounter}`;
    activeSfxGesture = {
      token,
      id,
      kind,
      sfxClips: state.sfxClips,
      past: state.past,
      future: state.future,
      historyCommitted: false,
    };
    return token;
  },
  updateSfxGesture: (token, value) => {
    const gesture = activeSfxGesture;
    if (!gesture || gesture.token !== token || !Number.isFinite(value)) return;
    const state = get();
    const target = state.sfxClips.find((clip) => clip.id === gesture.id);
    if (!target) {
      cancelActiveSfxGesture();
      return;
    }
    let updated: SfxClip = target;
    if (gesture.kind === "move") {
      updated = moveSfxClipValue(target, value, state.duration);
    } else if (gesture.kind === "left-trim") {
      updated = trimSfxClipLeftValue(target, value);
    } else if (gesture.kind === "right-trim") {
      updated = trimSfxClipRightValue(
        target,
        value,
        state.duration,
        sfxSourceDuration(target.source)
      );
    } else if (gesture.kind === "source-in") {
      updated = {
        ...target,
        sourceStart: Math.max(0, Math.min(value, target.sourceEnd - 1 / 1000)),
      };
    } else if (gesture.kind === "source-out") {
      updated = {
        ...target,
        sourceEnd: clampSfxSourceEnd(target, value, state.duration),
      };
    } else if (gesture.kind === "gain") {
      updated = { ...target, gain: Math.max(0, Math.min(2, value)) };
    } else if (gesture.kind === "fade-in") {
      updated = { ...target, fadeInSec: Math.max(0, Math.min(2, value)) };
    } else {
      updated = { ...target, fadeOutSec: Math.max(0, Math.min(2, value)) };
    }
    if (sfxClipEqual(updated, target)) return;
    if (!gesture.historyCommitted) {
      captureHistoryEntry();
      gesture.historyCommitted = true;
    }
    const sfxClips = state.sfxClips.map((clip) =>
      clip.id === gesture.id ? updated : clip
    );
    set({
      sfxClips,
      sfxDocumentRevision: state.sfxDocumentRevision + 1,
    });
  },
  endSfxGesture: (token) => {
    const gesture = activeSfxGesture;
    if (gesture?.token !== token) return;
    activeSfxGesture = null;
    if (
      gesture.historyCommitted
      && sfxDocumentEqual(get().sfxClips, gesture.sfxClips)
    ) {
      restoreSfxGesture(gesture);
    }
  },
  cancelSfxGesture: (token) => {
    if (activeSfxGesture?.token !== token) return;
    cancelActiveSfxGesture();
  },
  subscribeSfxGestureCancellation: (listener) => {
    sfxGestureCancellationListeners.add(listener);
    return () => sfxGestureCancellationListeners.delete(listener);
  },

  setSfxGenerating: (generating) => {
    if (generating) closeActiveHistoryGestures();
    set({ sfxGenerating: generating });
  },

  // --- background music (manual) --------------------------------------------
  // Direct set with no undo snapshot; persisted separately.
  setMusicTrack: (track) => set({ musicTrack: track }),
  clearMusicTrack: () => set({ musicTrack: null }),
  setMusicGain: (gain) => {
    const track = get().musicTrack;
    if (!track) return;
    const g = Math.max(0, Math.min(2, gain));
    set({ musicTrack: { ...track, gain: g } });
  },
  setMusicStart: (startAtSec) => {
    const track = get().musicTrack;
    if (!track) return;
    const start = Math.max(0, startAtSec);
    set({ musicTrack: { ...track, startAtSec: start } });
  },

  // --- word delete / restore -------------------------------------------------
  deleteWords: (fromWordIndex, toWordIndex) => {
    const lo = Math.min(fromWordIndex, toWordIndex);
    const hi = Math.max(fromWordIndex, toWordIndex);
    const { words, clips, deletedWordIndices } = get();

    // Only currently-KEPT words in the range become deletions. A word is kept
    // when a kept clip's half-open [srcStart, srcEnd) contains its start AND it
    // isn't already deleted. Skipping already-deleted / outside words means a
    // drag over a mixed selection deletes exactly the still-live words, and a
    // range that's entirely deleted/outside is a clean no-op (no history).
    const deletedSet = new Set(deletedWordIndices);
    const toDelete: number[] = [];
    for (let i = lo; i <= hi; i++) {
      const w = words[i];
      if (!w || deletedSet.has(i)) continue;
      // Mirror clipForSourceTime / sourceToTimelineTime containment exactly.
      const hit = clips.some(
        (c) => c.kept && c.srcEnd > c.srcStart && w.start >= c.srcStart && w.start < c.srcEnd
      );
      if (hit) toDelete.push(i);
    }
    if (toDelete.length === 0) return; // nothing live to delete -- no step

    // Turn the selected words into minimal contiguous SOURCE spans, then fold
    // each span through the forward cut. Operate on the RUNNING clips array (no
    // recompute between folds) so a multi-span delete is one atomic surgery.
    const spans = coalesceWordSpans(words, toDelete);
    get().commitHistory();
    let working = clips;
    for (const span of spans) {
      working = cutSourceSpanFromClips(working, span.start, span.end);
    }
    // Auto-merge same-lineage array-adjacent survivors BEFORE laying out the
    // timeline, so many deletes/restores never fragment the timeline into
    // slivers. A ghost sits between a fresh delete's two kept fragments, so
    // array-adjacency prevents merging across it (see mergeAdjacentKeptFragments).
    // Merge preserves source coverage, so the ripple remap below stays a no-op
    // for the survivors (their source moments are unchanged).
    const mergedClips = mergeAdjacentKeptFragments(working);
    const laidOut = recomputeTimeline(mergedClips);
    const duration = deriveDuration(laidOut);

    // Union the freshly-deleted indices into the sorted authority list.
    const mergedIndices = [...deletedSet];
    for (const i of toDelete) mergedIndices.push(i);
    const nextDeleted = mergedIndices.sort((a, b) => a - b);

    // If the selected clip was replaced by the split (its id no longer exists),
    // clear the selection so the timeline never points at a vanished clip.
    const selId = get().selectedClipId;
    const selStillExists = selId !== null && laidOut.some((c) => c.id === selId);

    set({
      clips: laidOut,
      duration,
      deletedWordIndices: nextDeleted,
      selectedClipId: selStillExists ? selId : null,
      // The just-deleted words are now ghosts; drop the shared word selection so
      // a second Delete doesn't sit on a stale range and the highlight clears.
      selectedWordRange: null,
      ...constrainCurrentSfxToDuration(duration),
    });
    // Re-chunk captions from the words that survive the delete: struck words drop
    // out of the caption stream. Reads fresh state (the clips/deletedWordIndices
    // we just set), and preserves surviving blocks' manual overrides.
    get().rebuildCaptionBlocks();
  },

  restoreWords: (fromWordIndex, toWordIndex) => {
    const lo = Math.min(fromWordIndex, toWordIndex);
    const hi = Math.max(fromWordIndex, toWordIndex);
    const { words, clips, deletedWordIndices } = get();

    // Which of the range's words are actually deleted right now (the only ones
    // there is anything to restore for).
    const deletedSet = new Set(deletedWordIndices);
    const toRestore: number[] = [];
    for (let i = lo; i <= hi; i++) {
      if (deletedSet.has(i)) toRestore.push(i);
    }
    if (toRestore.length === 0) return; // nothing deleted in range -- no step

    // Source spans of the words being restored. Flip any ghost (kept:false) clip
    // whose [srcStart, srcEnd) OVERLAPS a restore span back to kept:true -- that
    // ghost was the carrier the delete parked the footage in.
    const spans = coalesceWordSpans(words, toRestore);
    const overlapsRestore = (c: Clip): boolean =>
      spans.some((s) => c.srcStart < s.end && c.srcEnd > s.start);

    get().commitHistory();
    const updated = clips.map((c) =>
      !c.kept && overlapsRestore(c) ? { ...c, kept: true } : c
    );
    // Flipping a ghost back to kept:true can make it array-adjacent + source-
    // contiguous with its same-lineage neighbors again -- auto-merge them back
    // into one clip BEFORE laying out the timeline so a delete-then-restore
    // round-trips to the original single clip instead of leaving fragments.
    // Merge preserves source coverage, so the ripple remap below is a no-op.
    const mergedClips = mergeAdjacentKeptFragments(updated);
    const laidOut = recomputeTimeline(mergedClips);
    const duration = deriveDuration(laidOut);

    // Drop the restored indices from the authority list.
    const restoreSet = new Set(toRestore);
    const nextDeleted = deletedWordIndices.filter((i) => !restoreSet.has(i));

    set({
      clips: laidOut,
      duration,
      deletedWordIndices: nextDeleted,
      ...constrainCurrentSfxToDuration(duration),
    });
    // Restored words rejoin the caption stream: re-chunk from the fresh state.
    // Adjacent same-originId survivors were already auto-merged above.
    get().rebuildCaptionBlocks();
  },

  removeFillerWords: (fillers = DEFAULT_FILLER_WORDS) => {
    const { words, clips, deletedWordIndices } = get();

    // Match set of normalized filler tokens. Normalize the caller's set too so a
    // custom list with stray casing/punctuation still matches.
    const fillerSet = new Set(fillers.map((f) => normalizeFillerToken(f)));

    // Every currently-KEPT word whose normalized text is a filler. A word is kept
    // when it isn't already deleted AND a kept clip owns its source start (same
    // authority as deleteWords). clipForSourceTime mirrors the exporter's
    // containment, so we never mark a word that no footage actually shows.
    const deletedSet = new Set(deletedWordIndices);
    const toDelete: number[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w || deletedSet.has(i)) continue;
      if (!fillerSet.has(normalizeFillerToken(w.text))) continue;
      if (clipForSourceTime(clips, w.start)) toDelete.push(i);
    }
    if (toDelete.length === 0) return 0; // no live fillers -- no history, no-op

    // ONE undo step for the whole sweep: do the same surgery deleteWords does,
    // inline, under a single commitHistory (calling deleteWords per span would
    // create N undo steps). Each filler stays individually restorable -- it lands
    // in its own ghost carrier (or, for adjacent fillers, a shared span) and its
    // index is unioned into deletedWordIndices exactly like a manual delete.
    const spans = coalesceWordSpans(words, toDelete);
    get().commitHistory();
    let working = clips;
    for (const span of spans) {
      working = cutSourceSpanFromClips(working, span.start, span.end);
    }
    // Merge same-lineage array-adjacent survivors (ghosts separate fresh deletes,
    // so nothing merges across a restorable span); source coverage is preserved,
    // so the ripple remap stays a no-op for the survivors.
    const mergedClips = mergeAdjacentKeptFragments(working);
    const laidOut = recomputeTimeline(mergedClips);
    const duration = deriveDuration(laidOut);

    // Union the removed filler indices into the sorted authority list.
    const mergedIndices = [...deletedSet];
    for (const i of toDelete) mergedIndices.push(i);
    const nextDeleted = mergedIndices.sort((a, b) => a - b);

    // If the selected clip was replaced by the surgery, clear the selection so
    // the timeline never points at a vanished clip.
    const selId = get().selectedClipId;
    const selStillExists = selId !== null && laidOut.some((c) => c.id === selId);

    set({
      clips: laidOut,
      duration,
      deletedWordIndices: nextDeleted,
      selectedClipId: selStillExists ? selId : null,
      ...constrainCurrentSfxToDuration(duration),
    });
    // Struck fillers drop out of the caption stream: re-chunk from fresh state.
    get().rebuildCaptionBlocks();
    return toDelete.length;
  },

  tightenWordGaps: (maxGapSec) => {
    const { words, clips } = get();
    if (!(maxGapSec > 0) || words.length === 0) return 0;

    // Pure pass: snap each kept take's edges to hug its spoken words within
    // maxGapSec of breath (see lib/repurpose/gap-tighten.ts). It returns the
    // SAME clip reference for any clip it didn't move, so a plain identity diff
    // tells us how many takes actually tightened.
    const tightened = applyGapTighten(clips, words, maxGapSec);
    let moved = 0;
    for (let i = 0; i < clips.length; i++) {
      if (tightened[i] !== clips[i]) moved++;
    }
    if (moved === 0) return 0; // nothing to tighten -- no history, no-op

    // ONE undo step for the whole sweep. Edges only ever move inward toward
    // speech (source coverage of the kept words is preserved), so the ripple
    // remap of any output-anchored data stays well-defined -- recomputeTimeline
    // just lays the now-shorter takes back-to-back.
    get().commitHistory();
    const laidOut = recomputeTimeline(tightened);
    const duration = deriveDuration(laidOut);
    set({
      clips: laidOut,
      duration,
      ...constrainCurrentSfxToDuration(duration),
    });
    // Trimmed dead air can shift where caption words land: re-chunk from fresh
    // state so the caption stream matches the tightened runtime.
    get().rebuildCaptionBlocks();
    return moved;
  },

  setCaptionsEnabled: (on) => {
    if (on === get().captionsEnabled) return;
    get().commitHistory();
    set({ captionsEnabled: on });
    // SELF-REPAIR: turning captions on must always yield something drawable. If
    // we have a transcript but no blocks (a project loaded via a path that never
    // chunked, or a stale/empty blocks array), rebuild now so captions can never
    // be "on but invisible". Cheap + idempotent when blocks already exist.
    if (on) get().ensureCaptionBlocks();
  },

  setCaptionTemplate: (id) => {
    const preset = CAPTION_TEMPLATES[id];
    if (!preset) return;
    get().commitHistory();
    // Swap the whole style to the template preset, then re-chunk (density/budget
    // may have changed). Templates are the intended "start fresh" action, so we
    // do NOT preserve prior manual edits -- picking a template resets the look.
    set({ captionStyle: preset });
    get().rebuildCaptionBlocks();
  },

  patchCaptionStyle: (patch) => {
    const prev = get().captionStyle;
    // Coalesce by the set of fields being patched, so a single slider scrub
    // (same key repeated, e.g. `sizePct`) is one undo step, while moving to a
    // different control (a different key) starts a fresh step.
    get().commitHistory(`caption:${Object.keys(patch).sort().join(",")}`);
    const next = { ...prev, ...patch };
    set({ captionStyle: next });
    // Re-chunk only when a field that affects chunking changed (density or the
    // per-line/word/char budgets); pure look edits (color/stroke) skip it so
    // manual block splits/keywords survive a color tweak.
    const affectsChunking =
      ("density" in patch && patch.density !== prev.density) ||
      ("maxWordsPerLine" in patch && patch.maxWordsPerLine !== prev.maxWordsPerLine) ||
      ("maxCharsPerLine" in patch && patch.maxCharsPerLine !== prev.maxCharsPerLine) ||
      ("maxLines" in patch && patch.maxLines !== prev.maxLines);
    if (affectsChunking) get().rebuildCaptionBlocks();
  },

  patchCaptionBlock: (id, patch) => {
    get().commitHistory(`captionBlock:${id}:${Object.keys(patch).sort().join(",")}`);
    set({
      captionBlocks: get().captionBlocks.map((b) =>
        b.id === id ? { ...b, ...patch } : b
      ),
    });
  },

  attachCaptionBlock: (id) => {
    const block = get().captionBlocks.find((candidate) => candidate.id === id);
    if (!block) return;
    if (withAttachedCaptionOverride(block) === block) return;
    get().commitHistory();
    set({
      captionBlocks: get().captionBlocks.map((candidate) =>
        candidate.id === id ? withAttachedCaptionOverride(candidate) : candidate
      ),
    });
  },

  detachCaptionBlock: (id, positionYPct, options) => {
    const block = get().captionBlocks.find((candidate) => candidate.id === id);
    if (!block) return;
    if (withDetachedCaptionOverride(block, positionYPct) === block) return;
    get().commitHistory(
      !options?.discrete && block.overrideStyle?.pinToSplit === false
        ? `captionPosition:${id}`
        : undefined
    );
    set({
      captionBlocks: get().captionBlocks.map((candidate) =>
        candidate.id === id
          ? withDetachedCaptionOverride(candidate, positionYPct)
          : candidate
      ),
    });
  },

  beginCaptionGesture: (blockId) => {
    cancelActiveSfxGesture();
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    const cancelledSplit = cancelActiveSplitRatioGesture();
    if (cancelledSplit) signalSplitRatioGestureCancellation();
    cancelActiveOverlayAppearanceGesture();
    if (!get().captionBlocks.some((block) => block.id === blockId)) return null;
    const token = `caption-gesture-${++captionGestureCounter}`;
    activeCaptionGesture = { kind: "completion", token, blockId };
    return token;
  },

  completeCaptionGesture: (token, completion) => {
    const gesture = activeCaptionGesture;
    if (!gesture || gesture.kind !== "completion" || gesture.token !== token) {
      return;
    }
    activeCaptionGesture = null;
    const state = get();
    const target = state.captionBlocks.find(
      (block) => block.id === gesture.blockId
    );
    if (!target) return;
    const nextTarget =
      completion.kind === "attach"
        ? withAttachedCaptionOverride(target)
        : withDetachedCaptionOverride(target, completion.positionYPct);
    if (nextTarget === target) return;
    const captionBlocks = state.captionBlocks.map((block) =>
      block.id === gesture.blockId ? nextTarget : block
    );
    const past = [...state.past, captureSnapshot(state)];
    if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
    lastCommitKey = null;
    lastCommitAt = Date.now();
    set({ captionBlocks, past, future: [] });
  },

  cancelCaptionGesture: (token) => {
    if (activeCaptionGesture?.token !== token) return;
    cancelActiveCaptionGesture();
  },

  beginCaptionPositionGesture: (blockId) => {
    cancelActiveSfxGesture();
    cancelActiveOverlayTransformGesture();
    cancelActiveCaptionGesture();
    const cancelledSplit = cancelActiveSplitRatioGesture();
    if (cancelledSplit) signalSplitRatioGestureCancellation();
    cancelActiveOverlayAppearanceGesture();
    const state = get();
    const target = state.captionBlocks.find((block) => block.id === blockId);
    if (!target || resolveBlockStyle(state.captionStyle, target).pinToSplit) {
      return null;
    }
    const token = `caption-position-gesture-${++captionGestureCounter}`;
    activeCaptionGesture = {
      kind: "position",
      token,
      blockId,
      captionBlocks: state.captionBlocks,
      past: state.past,
      future: state.future,
      historyCommitted: false,
    };
    return token;
  },

  updateCaptionPositionGesture: (token, positionYPct) => {
    const gesture = activeCaptionGesture;
    if (!gesture || gesture.kind !== "position" || gesture.token !== token) return;
    const state = get();
    const target = state.captionBlocks.find(
      (block) => block.id === gesture.blockId
    );
    if (!target) {
      cancelActiveCaptionGesture();
      return;
    }
    const nextTarget = withDetachedCaptionOverride(target, positionYPct);
    if (nextTarget === target) return;
    if (!gesture.historyCommitted) {
      captureHistoryEntry();
      gesture.historyCommitted = true;
    }
    set({
      captionBlocks: get().captionBlocks.map((block) =>
        block.id === gesture.blockId ? nextTarget : block
      ),
    });
  },

  endCaptionPositionGesture: (token) => {
    if (
      activeCaptionGesture?.kind !== "position" ||
      activeCaptionGesture.token !== token
    ) {
      return;
    }
    activeCaptionGesture = null;
  },

  cancelCaptionPositionGesture: (token) => {
    if (
      activeCaptionGesture?.kind !== "position" ||
      activeCaptionGesture.token !== token
    ) {
      return;
    }
    cancelActiveCaptionGesture();
  },

  subscribeCaptionGestureCancellation: (listener) => {
    captionGestureCancellationListeners.add(listener);
    return () => captionGestureCancellationListeners.delete(listener);
  },

  setBlockPosition: (id, positionYPct, effectiveSplitRatio = get().splitRatio) => {
    // Per-scene position nudge -- coalesce the drag into one step per block.
    get().commitHistory(`blockPos:${id}`);
    const { captionStyle, captionBlocks } = get();
    set({
      captionBlocks: captionBlocks.map((b) => {
        if (b.id !== id) return b;
        // `positionYPct` is an ABSOLUTE fraction of output height (same units as
        // the global Position slider). Resolve this block's CURRENT effective
        // style so we nudge the anchor it actually draws with:
        //   - pinned block  -> on-screen Y = (splitRatio + splitOffsetPct); to
        //     land it at `positionYPct` we store splitOffsetPct = target - split.
        //   - unpinned block -> positionYPct is used directly.
        const eff = resolveBlockStyle(captionStyle, b);
        const patch: Partial<CaptionStyle> = eff.pinToSplit
          ? { splitOffsetPct: positionYPct - effectiveSplitRatio }
          : { positionYPct };
        return { ...b, overrideStyle: { ...b.overrideStyle, ...patch } };
      }),
    });
  },

  clearBlockPosition: (id) => {
    const block = get().captionBlocks.find((b) => b.id === id);
    if (!block || !block.overrideStyle) return; // nothing to clear -- no step
    get().commitHistory();
    set({
      captionBlocks: get().captionBlocks.map((b) => {
        if (b.id !== id || !b.overrideStyle) return b;
        // Strip only the position keys; keep any other per-block overrides.
        const {
          positionYPct: _p,
          splitOffsetPct: _s,
          ...rest
        } = b.overrideStyle;
        const next = Object.keys(rest).length > 0 ? rest : undefined;
        return { ...b, overrideStyle: next };
      }),
    });
  },

  rebuildCaptionBlocks: () => {
    cancelActiveCaptionGesture();
    const { words, captionStyle, clips, deletedWordIndices, captionBlocks } = get();
    const blocks = buildCaptionBlocksForState({
      words,
      clips,
      deletedWordIndices,
      style: captionStyle,
      previousBlocks: captionBlocks,
    });

    // A re-chunk mints brand-new block ids, so any held caption selection now
    // dangles -- clear it (only if a block was actually selected) so the
    // Inspector's per-block panel can't act on a vanished block. Cheap guard so
    // an ensureCaptionBlocks() self-repair with nothing selected is a no-op set.
    const patch: { captionBlocks: CaptionBlock[]; selectedCaptionBlockId?: null } =
      { captionBlocks: blocks };
    if (get().selectedCaptionBlockId !== null) patch.selectedCaptionBlockId = null;
    set(patch);
  },

  ensureCaptionBlocks: () => {
    const { words, captionBlocks } = get();
    if (words.length > 0 && captionBlocks.length === 0) {
      get().rebuildCaptionBlocks();
    }
  },

  editWordText: (wordIndex, newText) => {
    const { words, captionBlocks } = get();
    const word = words[wordIndex];
    if (!word) return; // no such raw word -- nothing to edit

    // Locate the caption block + local position holding this word by SOURCE time:
    // the block whose words contain one starting at word.start (exact, or within
    // a float epsilon). captionBlocks are chunked from the SAME words, so the
    // start times line up 1:1.
    let targetBlock: CaptionBlock | null = null;
    let localPos = -1;
    for (const b of captionBlocks) {
      const pos = b.words.findIndex(
        (w) => Math.abs(w.start - word.start) <= 1e-6
      );
      if (pos !== -1) {
        targetBlock = b;
        localPos = pos;
        break;
      }
    }
    if (!targetBlock || localPos === -1) return; // word isn't shown in any block

    // Empty / whitespace reverts this position to the original transcript word.
    const trimmed = newText.trim();
    const resolved = trimmed.length === 0 ? word.text : newText;

    // Coalesce successive edits to the SAME word into one undo step.
    get().commitHistory(`wordText:${wordIndex}`);

    const targetId = targetBlock.id;
    set({
      captionBlocks: captionBlocks.map((b) => {
        if (b.id !== targetId) return b;
        // Seed the positional override from the block's current per-word text so
        // untouched positions keep their existing (possibly already-overridden)
        // text; then write the one edited slot.
        const base =
          b.textOverride && b.textOverride.length === b.words.length
            ? [...b.textOverride]
            : b.words.map((w) => w.text);
        base[localPos] = resolved;
        return { ...b, textOverride: base };
      }),
    });
  },

  setClipFaceFraming: (id, framing) => {
    const { clips, syncFaceCam } = get();
    const clip = clips.find((c) => c.id === id);
    if (!clip) return;
    const next: FaceFraming | undefined =
      framing === null
        ? undefined
        : {
            x: Math.max(-1, Math.min(1, framing.x)),
            y: Math.max(-1, Math.min(1, framing.y)),
            scale: Math.max(1, Math.min(6, framing.scale)),
          };
    if (syncFaceCam) {
      // Locked-camera face cam: one framing for every kept clip at once, so a
      // drag on any scene repositions the face cam everywhere (see syncFaceCam
      // doc). No-op if nothing would actually change.
      const changed = clips.some((c) => c.kept && c.faceFraming !== next);
      if (!changed) return;
      get().commitHistory(`facefr:all`);
      set({
        clips: clips.map((c) => (c.kept ? { ...c, faceFraming: next } : c)),
      });
      return;
    }
    // Clearing an already-cleared clip is a no-op (no phantom history step).
    if (framing === null && clip.faceFraming === undefined) return;
    // The whole drag/scroll gesture on the face region = ONE undo step.
    get().commitHistory(`facefr:${id}`);
    // Render-time-only data: no ripple, no duration change.
    set({
      clips: clips.map((c) => (c.id === id ? { ...c, faceFraming: next } : c)),
    });
  },

  setClipScreenFraming: (id, framing) => {
    const { clips } = get();
    const clip = clips.find((c) => c.id === id);
    if (!clip) return;
    if (framing === null && clip.screenFraming === undefined) return;
    // The whole drag/scroll gesture on the screen region = ONE undo step.
    get().commitHistory(`screenfr:${id}`);
    const next: FaceFraming | undefined =
      framing === null
        ? undefined
        : {
            x: Math.max(-1, Math.min(1, framing.x)),
            y: Math.max(-1, Math.min(1, framing.y)),
            scale: Math.max(1, Math.min(6, framing.scale)),
          };
    // Render-time-only data: no ripple, no duration change.
    set({
      clips: clips.map((c) => (c.id === id ? { ...c, screenFraming: next } : c)),
    });
  },

  setClipPunch: (id, region, punch) => {
    const { clips } = get();
    const clip = clips.find((c) => c.id === id);
    if (!clip) return;
    const field = region === "screen" ? "screenPunch" : "facePunch";
    // Clearing an already-clear region is a no-op (no phantom history step).
    if (punch === null && clip[field] === undefined) return;
    // Coalesce the whole gesture on THIS clip+region into one undo step (a
    // future amount/hold slider drag); the one-click add still lands as its own
    // step because nothing else shares the key within the coalesce window.
    get().commitHistory(`punch:${region}:${id}`);
    const next: ClipPunch | undefined =
      punch === null
        ? undefined
        : {
            atSrc: punch.atSrc,
            // Keep amount sane: a small positive push (never a zoom-OUT here, and
            // capped so drawScale stays inside the framing scale band the crop
            // path expects). 1.0 = +100%, plenty for an emphasis punch.
            amount: Math.max(0, Math.min(1, punch.amount)),
            holdSec: Math.max(0, punch.holdSec),
            ...(punch.ease ? { ease: punch.ease } : {}),
          };
    // Render-time-only data: no recomputeTimeline, no duration change.
    set({
      clips: clips.map((c) => (c.id === id ? { ...c, [field]: next } : c)),
    });
  },

  setDefaultTransition: (transition) => {
    const { clips } = get();
    // A "real cut" = a non-opening kept clip that already carries a transition.
    // We restyle only those, never forcing motion onto a continuous same-take
    // join (which has transitionIn === undefined and must stay a clean cut).
    const isRealCut = (c: Clip) => c.kept && c.transitionIn !== undefined;
    const next = transition === undefined || transition === null ? undefined : transition;
    // No-op guard: nothing to restyle, or every real cut already matches.
    const willChange = clips.some((c) => {
      if (!isRealCut(c)) return false;
      if (next === undefined) return true; // clearing a cut that has one
      const t = c.transitionIn!;
      return (
        t.type !== next.type ||
        t.amount !== next.amount ||
        t.durationSec !== next.durationSec ||
        t.direction !== next.direction ||
        t.easing !== next.easing
      );
    });
    if (!willChange) return;
    get().commitHistory();
    set({
      clips: clips.map((c) =>
        isRealCut(c) ? { ...c, transitionIn: next ? { ...next } : undefined } : c
      ),
    });
  },

  resetAllFraming: () => {
    const { clips } = get();
    const hasOverrides = clips.some(
      (c) => c.screenFraming !== undefined || c.faceFraming !== undefined || c.splitRatio !== undefined
    );
    if (!hasOverrides) return;
    get().commitHistory();
    // None of this moves footage in time, so no ripple is needed.
    set({
      clips: clips.map((c) =>
        c.screenFraming !== undefined || c.faceFraming !== undefined || c.splitRatio !== undefined
          ? { ...c, screenFraming: undefined, faceFraming: undefined, splitRatio: undefined }
          : c
      ),
    });
  },

  // Selecting a timeline clip clears any canvas overlay selection: the two are
  // mutually exclusive so only one object is ever highlighted. Clearing (null)
  // clears the clip selection only (leaves an overlay selection alone would be
  // wrong here -- selectClip is the CLIP authority; use selectOverlay for that).
  selectClip: (id) =>
    set({
      selectedClipId: id,
      selectedOverlayId: id === null ? get().selectedOverlayId : null,
      selectedOverlayIds: id === null ? get().selectedOverlayIds : [],
      // Selecting an actual clip clears any word selection (mutual exclusion) so
      // Delete acts on the scene, not a lingering word. Clearing (null) leaves
      // the word selection alone -- callers that want a word selected pass the
      // range through selectWords, which itself clears selectedClipId.
      selectedWordRange: id === null ? get().selectedWordRange : null,
      selectedSfxClipId: id === null ? get().selectedSfxClipId : null,
    }),

  // Shared word selection (transcript + timeline word cells). Passing a range
  // clears the clip/overlay selection so the two Delete paths stay disjoint;
  // null clears the word selection. Indices are normalized so either order works.
  selectWords: (from, to) => {
    if (from === null) {
      set({ selectedWordRange: null });
      return;
    }
    const hiArg = to ?? from;
    const lo = Math.min(from, hiArg);
    const hi = Math.max(from, hiArg);
    set({
      selectedWordRange: { lo, hi },
      selectedClipId: null,
      selectedOverlayId: null,
      selectedOverlayIds: [],
      selectedSfxClipId: null,
    });
  },

  setPlayhead: (t) => {
    if (captionGestureOwnsFrame()) return;
    const clamped = Math.max(0, Math.min(get().duration, t));
    set({ playhead: clamped });
  },

  play: () => {
    if (captionGestureOwnsFrame()) return;
    // No-op if there's nothing to play. If the playhead sits at (or past) the
    // end of the region, rewind to the region start so pressing play from the
    // end restarts rather than doing nothing.
    const state = get();
    const { duration, isPlaying, playhead, inPoint, outPoint } = state;
    if (isPlaying) return;

    const blockedReason = getPlaybackBlockedReason(state);

    if (blockedReason !== null) {
      if (state.playbackBlockedReason !== blockedReason) {
        set({ playbackBlockedReason: blockedReason });
      }
      return;
    }

    const regionStart = inPoint ?? 0;
    const regionEnd = outPoint ?? duration;
    const atEnd = playhead >= regionEnd - 1e-3;
    set({
      isPlaying: true,
      playhead: atEnd ? regionStart : playhead,
      playbackBlockedReason: null,
    });
  },

  // Pausing ends the shuttle: reset to 1x so the next plain Play/Space is real
  // time, not whatever fast rate the last L-shuttle left behind.
  pause: () => {
    const { isPlaying, playbackRate } = get();
    if (!isPlaying && playbackRate === 1) return;
    set({ isPlaying: false, playbackRate: 1 });
  },

  togglePlay: () => {
    return get().isPlaying ? get().pause() : get().play();
  },

  stepFrame: (direction) => {
    if (captionGestureOwnsFrame()) return;
    const { playhead, duration, footageMeta } = get();
    const fps = footageMeta?.fps && footageMeta.fps > 0 ? footageMeta.fps : FALLBACK_FPS;
    const frame = Math.round(playhead * fps) + direction;
    const next = Math.max(0, Math.min(duration, frame / fps));
    // Frame-stepping is a paused, real-time action: stop and drop any fast rate.
    set({ isPlaying: false, playhead: next, playbackRate: 1 });
  },

  setPlaybackRate: (rate) => {
    const clamped = Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, rate));
    set({ playbackRate: clamped });
  },

  shuttle: (direction) => {
    // K (0): stop + reset. This is `pause()` (which already zeroes the rate).
    if (direction === 0) {
      get().pause();
      return;
    }
    if (captionGestureOwnsFrame()) return;
    const { duration, isPlaying, playbackRate } = get();
    if (duration <= 0) return;

    // Index of 1x on the ladder -- the neutral "real time" rung the shuttle
    // starts from when paused, so L begins at 1x (not the ladder's 0.5x floor)
    // and J begins by dropping BELOW 1x into slow review.
    const ONE_X = PLAYBACK_RATES.indexOf(1 as (typeof PLAYBACK_RATES)[number]);

    // Current rung on the ladder (nearest at-or-below rung so a selector-set
    // 1.75x still shuttles sensibly).
    let idx = PLAYBACK_RATES.findIndex((r) => r >= playbackRate);
    if (idx === -1) idx = PLAYBACK_RATES.length - 1;
    // From a stop, anchor to 1x: L (+1) lands on 1x, J (-1) lands one rung below.
    // The +direction step below moves off `idx`, so anchor one rung the OTHER
    // way: L starts at ONE_X-1 (steps up to 1x); J starts at ONE_X (steps down
    // to ONE_X-1 = 0.75x, one rung below 1x for slow review).
    if (!isPlaying) idx = direction > 0 ? ONE_X - 1 : ONE_X;

    const nextIdx = idx + direction;

    if (nextIdx < 0) {
      // J below the slowest rung -> stop (no reliable reverse video playback).
      get().pause();
      return;
    }
    const nextRate = PLAYBACK_RATES[Math.min(nextIdx, PLAYBACK_RATES.length - 1)];
    // Ensure we're playing (L from paused, or J while paused-at-1x is handled
    // above) and set the new rate. play() rewinds if parked at the region end.
    if (!isPlaying) get().play();
    set({ playbackRate: nextRate });
  },

  seekToStart: () => get().setPlayhead(0),
  seekToEnd: () => get().setPlayhead(get().duration),

  // Marker nav -- jump the play mark to the neighbouring marker relative to the
  // CURRENT playhead. `markers` is kept t-sorted (addMarker/updateMarker sort on
  // write), so a single linear scan finds the strictly-next / strictly-previous
  // pin. A small epsilon on the strict compare stops a repeated press from
  // sticking on a marker the playhead has effectively already reached (frame
  // jitter / a snap landing a hair off). Clamped to the timeline; pure seek, no
  // history (mirrors seekToStart/End).
  nextMarker: () => {
    const { markers, playhead, duration } = get();
    const target = markers.find((m) => m.t > playhead + 1e-4);
    if (!target) return;
    get().setPlayhead(Math.max(0, Math.min(duration, target.t)));
  },
  prevMarker: () => {
    const { markers, playhead, duration } = get();
    let target: Marker | undefined;
    for (const m of markers) {
      if (m.t < playhead - 1e-4) target = m;
      else break; // markers are ascending -- no later one can be before us
    }
    if (!target) return;
    get().setPlayhead(Math.max(0, Math.min(duration, target.t)));
  },

  setInPoint: (t) => {
    if (t === null) {
      set({ inPoint: null });
      return;
    }
    const { duration, outPoint } = get();
    const clamped = Math.max(0, Math.min(duration, t));
    // Keep in < out: if the new in-point crosses the out-point, drop the out.
    set({ inPoint: clamped, outPoint: outPoint !== null && outPoint <= clamped ? null : outPoint });
  },

  setOutPoint: (t) => {
    if (t === null) {
      set({ outPoint: null });
      return;
    }
    const { duration, inPoint } = get();
    const clamped = Math.max(0, Math.min(duration, t));
    set({ outPoint: clamped, inPoint: inPoint !== null && inPoint >= clamped ? null : inPoint });
  },

  clearInOut: () => set({ inPoint: null, outPoint: null }),

  toggleLoop: () => set({ loopPlayback: !get().loopPlayback }),
  };
});
