"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  MonitorPlay,
  VideoCamera,
  Stack,
  ArrowsLeftRight,
  ArrowsOutLineHorizontal,
  FrameCorners,
  Magnet,
  MusicNotes,
  MusicNote,
  X,
} from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { DEFAULT_HEIGHT } from "@/lib/repurpose/compositor";
import {
  sourceToTimelineTime,
  splitRatioAt,
  timelineToSourceTime,
} from "@/lib/repurpose/time-map";
import { resolveEffectivePrimaryOverlay } from "@/lib/repurpose/overlay-geometry";
import { effectiveSplitRatio } from "@/lib/repurpose/split-ratio";
import type { Clip, Overlay, SfxAsset, SfxClip } from "@/lib/repurpose/types";
import { sfxClipTimelineEnd, sfxSourceDuration } from "@/lib/repurpose/sfx-clips";
import { resolveSfxSource } from "@/lib/repurpose/sfx-source";
import { isApprovedSfxKey, SFX_CATALOG } from "@/lib/repurpose/sfx-effects";
import { SFX_DRAG_MIME, type SfxDragPayload } from "@/lib/repurpose/sfx-drag";
import { importSfxFile, isAudioLikeFile, type SfxImportOwner } from "@/lib/repurpose/sfx-ingest-client";
import {
  ingestOverlayFiles,
  type OverlayImportOwner,
} from "@/lib/repurpose/overlay-ingest";
import { ClipBlock } from "./ClipBlock";
import { OverlayBlock, useOverlayThumbnails } from "./OverlayBlock";
import { SfxClipBlock } from "./SfxClipBlock";
import { useSfxWaveform } from "./useSfxWaveform";
import { TransportBar } from "./TransportBar";
import {
  useFaceWaveform,
  useAudioWaveform,
  sliceClipPeaks,
  type FaceWaveform,
} from "./useFaceWaveform";
import {
  DEFAULT_PPS,
  MIN_PPS,
  MAX_PPS,
  ZOOM_STEP,
  TRACK_HEIGHT,
  TRACK_GAP,
  OVERLAY_LANE_HEIGHT,
  OVERLAY_LANE_GAP,
  SFX_LANE_HEIGHT,
  SFX_LANE_GAP,
  RULER_HEIGHT,
  SNAP_PX,
  formatTimecode,
  pickTickInterval,
  packLanes,
  timeToPx,
  pxToTime,
  clamp,
  snapTime,
  snapMovedSpan,
} from "./timeline-utils";
import { focusSfxTimelineTarget } from "./sfx-focus";

export interface TimelineProps {
  /** Optional height override for the whole widget; defaults to fitting 3 tracks + ruler. */
  className?: string;
  overlayImportOwner?: OverlayImportOwner;
  sfxImportOwner?: SfxImportOwner;
}

/**
 * Stable snapshot of one non-dragged kept clip, taken at drag start. Reorder
 * target computation MUST run against these frozen centers, never the live
 * (rippling) layout: once a single reorder fires mid-drag the store re-lays-out
 * every clip, so re-reading live midpoints on the next move makes a multi-slot
 * drag stall one slot short (it can only ever advance one step per move, in
 * either direction). Frozen centers give one deterministic target index for any
 * drag distance.
 */
type ReorderSibling = { id: string; center: number };

type DragKind =
  | { type: "playhead" }
  | {
      type: "clip-body";
      clip: Clip;
      startClientX: number;
      startTimelineStart: number;
      /** every OTHER kept clip's center on the timeline at drag start, ascending */
      siblings: ReorderSibling[];
    }
  | { type: "clip-edge"; clip: Clip; edge: "start" | "end"; startClientX: number; startSrcStart: number; startSrcEnd: number }
  | {
      type: "overlay-body";
      overlay: Overlay;
      startClientX: number;
      startTimelineStart: number;
    }
  | {
      type: "overlay-edge";
      overlay: Overlay;
      edge: "start" | "end";
      startClientX: number;
      startTimelineStart: number;
      startTimelineEnd: number;
    }
  | {
      type: "sfx";
      clip: SfxClip;
      edge: "body" | "start" | "end";
      startClientX: number;
      token: string | null;
    };

// The Screen + Face recordings are FRAME-LOCKED -- one timeline drives both, so
// every scene is always the same source range on both tracks. Rendering two
// identical clip rows just hogged vertical space, so the timeline shows ONE
// unified "Clip" scene track (audio rides the face cam, so no separate audio
// track either). Each scene carries its own static pan/zoom framing for BOTH
// regions (Clip.screenFraming / Clip.faceFraming), edited in the preview by
// dragging/scrolling -- not on the timeline. There are no keyframes: the cut
// eases between adjacent scenes' framings via the Smart transition.
// Overlays get a second track row, ABOVE the clip track (a media layer sits on
// top of the base composite, so it reads top-to-bottom as it draws). The
// Overlays row is DYNAMIC height (one lane per concurrent overlap, no fixed cap);
// the clip row is a fixed TRACK_HEIGHT scene track. The label rail is rendered
// separately (it needs the live per-row heights), so this list is only the clip
// track.
const TRACK_LABELS: { key: "clip"; label: string; icon: typeof MonitorPlay }[] = [
  { key: "clip", label: "Clips", icon: VideoCamera },
];

/**
 * The Repurpose Studio timeline: two stacked tracks (Screen + Face), both
 * rendering clips (scenes), a scrubbable playhead, a draggable mm:ss ruler, and
 * zoom controls. Reads/writes useRepurposeStore.
 *
 * Each scene carries its own static per-region framing (Clip.screenFraming /
 * Clip.faceFraming) -- authored in the preview (drag to pan, scroll to zoom),
 * NOT on the timeline. There are no keyframes. Manual sub-scenes carved with `/`
 * are color-coded distinctly from the auto-cut scenes.
 *
 * Store actions used here (see lib/repurpose/store.ts):
 *   deleteClip, restoreClip, trimClip(id, edge, absTarget),
 *   reorderClips(id, toIndex), selectClip, setPlayhead.
 * trimClip takes an ABSOLUTE source target so a live drag recomputing from a
 * frozen anchor can never compound.
 */
export function Timeline({
  className,
  overlayImportOwner,
  sfxImportOwner,
}: TimelineProps) {
  const clips = useRepurposeStore((s) => s.clips);
  const playhead = useRepurposeStore((s) => s.playhead);
  const duration = useRepurposeStore((s) => s.duration);
  const selectedClipId = useRepurposeStore((s) => s.selectedClipId);
  const snapEnabled = useRepurposeStore((s) => s.snapEnabled);
  const toggleSnap = useRepurposeStore((s) => s.toggleSnap);
  const markers = useRepurposeStore((s) => s.markers);
  const removeMarker = useRepurposeStore((s) => s.removeMarker);
  const isPlaying = useRepurposeStore((s) => s.isPlaying);
  const footageMeta = useRepurposeStore((s) => s.footageMeta);

  // Raw whole-recording transcript (source seconds). Each ClipBlock slices the
  // words inside its own [srcStart, srcEnd) to draw per-word divider ticks.
  const words = useRepurposeStore((s) => s.words);

  const sfxClips = useRepurposeStore((s) => s.sfxClips);
  const sfxAssets = useRepurposeStore((s) => s.sfxAssets);
  const selectedSfxClipId = useRepurposeStore((s) => s.selectedSfxClipId);
  const projectEpoch = useRepurposeStore((s) => s.projectEpoch);
  const selectSfxClip = useRepurposeStore((s) => s.selectSfxClip);
  const removeSfxClip = useRepurposeStore((s) => s.removeSfxClip);
  const duplicateSfxClip = useRepurposeStore((s) => s.duplicateSfxClip);
  const beginSfxGesture = useRepurposeStore((s) => s.beginSfxGesture);
  const updateSfxGesture = useRepurposeStore((s) => s.updateSfxGesture);
  const endSfxGesture = useRepurposeStore((s) => s.endSfxGesture);
  const cancelSfxGesture = useRepurposeStore((s) => s.cancelSfxGesture);

  // Background music bed (a single indigo block on its own row between the clips
  // and the SFX row), or null when none has been loaded yet. Plays UNDER the
  // picture like the SFX bed. Non-draggable in v1 (setMusicStart exists for later).
  const musicTrack = useRepurposeStore((s) => s.musicTrack);
  const clearMusicTrack = useRepurposeStore((s) => s.clearMusicTrack);

  // Whole-source face-cam waveform peaks, decoded ONCE and shared by every clip
  // block on the Face track (each slices the portion for its own source range).
  // null while decoding / when audio is unavailable -> clips render no waveform.
  const faceWaveform = useFaceWaveform(footageMeta);

  // Whole-file peaks for the Music + SFX beds, so their track blocks draw a real
  // waveform (Descript-style) instead of a flat colored slab. Same shared decode
  // cache as the face clips; null while decoding -> the block renders plain.
  const musicWaveform = useAudioWaveform(musicTrack?.src ?? null);

  const deleteClip = useRepurposeStore((s) => s.deleteClip);
  const restoreClip = useRepurposeStore((s) => s.restoreClip);
  const duplicateClip = useRepurposeStore((s) => s.duplicateClip);
  const trimClip = useRepurposeStore((s) => s.trimClip);
  const reorderClips = useRepurposeStore((s) => s.reorderClips);
  const selectClip = useRepurposeStore((s) => s.selectClip);
  const setPlayhead = useRepurposeStore((s) => s.setPlayhead);

  // ---- shared word selection (transcript + clip word cells) -----------------
  const deleteWords = useRepurposeStore((s) => s.deleteWords);
  const selectWords = useRepurposeStore((s) => s.selectWords);
  const editWordText = useRepurposeStore((s) => s.editWordText);
  const selectedWordRange = useRepurposeStore((s) => s.selectedWordRange);
  // The single shared-selected word to highlight in the clip cells (we select
  // one word at a time from the timeline, so lo===hi; show the lo end).
  const selectedWordIndex =
    selectedWordRange && selectedWordRange.lo === selectedWordRange.hi
      ? selectedWordRange.lo
      : null;

  // The raw word index currently UNDER THE PLAYHEAD (Descript's karaoke word).
  // Map the output playhead -> source time (same forward map the exporter uses),
  // then find the word whose [start, end) contains it. This is the "now playing"
  // word, distinct from the selected word -- the clip cells highlight it as it
  // moves, mirroring the transcript's coral active word so the two surfaces
  // light up the same word during playback.
  const playheadWordIndex = useMemo(() => {
    const srcT = timelineToSourceTime(clips, playhead);
    if (srcT == null) return null;
    // Words are ascending by start; a linear scan with an early break is fine.
    // Only a word that CONTAINS srcT lights up -- during a pause between words no
    // cell is highlighted (a lingering highlight through silence would read wrong).
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.start > srcT) break;
      if (srcT < w.end) return i;
    }
    return null;
  }, [clips, playhead, words]);

  // Click a word cell on a clip -> select just that word: seek the playhead to
  // its source moment (mapped through the SAME forward map the exporter uses)
  // and set the shared word selection (which clears the clip selection). A
  // Delete keypress then cuts that word (see the keydown handler), never the
  // whole scene.
  const onWordCellClick = useCallback(
    (rawWordIndex: number) => {
      const w = words[rawWordIndex];
      if (!w) return;
      const outT = sourceToTimelineTime(clips, w.start);
      if (outT != null) setPlayhead(outT);
      selectWords(rawWordIndex);
    },
    [words, clips, setPlayhead, selectWords]
  );

  // Double-click a word cell on a clip -> commit new caption text for that word,
  // mirroring the transcript's double-click-to-edit. ClipBlock owns the inline
  // input + draft; here we just route the committed text to the SAME store action
  // the transcript uses (an empty string reverts to the raw word). Only the
  // on-screen caption changes -- footage, timing and words[] are untouched.
  const onWordCellDoubleClick = useCallback(
    (rawWordIndex: number, newText: string) => {
      editWordText(rawWordIndex, newText);
    },
    [editWordText]
  );

  // Drag across word cells (or shift-click to extend) on a clip -> select the
  // inclusive RANGE of words swept (Descript wordbar parity). from/to arrive in
  // sweep order; selectWords normalizes lo/hi (and clears the clip selection), so
  // a Delete then cuts the whole range (see the keydown handler's word branch).
  // Seek the playhead to the FIRST word in the range so the preview parks at the
  // start of the selection, mirroring onWordCellClick's single-word seek.
  const onWordRangeSelect = useCallback(
    (fromRawIndex: number, toRawIndex: number) => {
      const lo = Math.min(fromRawIndex, toRawIndex);
      const first = words[lo];
      if (first) {
        const outT = sourceToTimelineTime(clips, first.start);
        if (outT != null) setPlayhead(outT);
      }
      selectWords(fromRawIndex, toRawIndex);
    },
    [words, clips, setPlayhead, selectWords]
  );

  // ---- overlays (free-floating media layers) --------------------------------
  const overlays = useRepurposeStore((s) => s.overlays);
  const selectedOverlayId = useRepurposeStore((s) => s.selectedOverlayId);
  const moveOverlay = useRepurposeStore((s) => s.moveOverlay);
  const trimOverlay = useRepurposeStore((s) => s.trimOverlay);
  const removeOverlay = useRepurposeStore((s) => s.removeOverlay);
  const selectOverlay = useRepurposeStore((s) => s.selectOverlay);

  // UI-owned poster-frame cache (keyed by overlay id, re-derived on reload).
  const overlayThumbs = useOverlayThumbnails(overlays);

  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PPS);
  const [snapGuideX, setSnapGuideX] = useState<number | null>(null);
  const [sfxDropError, setSfxDropError] = useState<string | null>(null);
  // Content-space x of the coral drop indicator while dragging a media file over
  // the tracks (null = no drag in progress). Shows exactly where a dropped
  // image/video overlay would start.
  const [dropIndicatorX, setDropIndicatorX] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackAreaRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragKind | null>(null);
  const lastScrubClientXRef = useRef<number | null>(null);
  const lastScrubTsRef = useRef<number>(0);
  const scrubMomentumRef = useRef(0);
  const momentumRafRef = useRef<number | null>(null);
  // Live snapshots of the values the momentum coast needs, kept in refs so the
  // coast can read them without being a dep of any effect. See the coast driver
  // effect below (bug: the coast must survive normal re-renders).
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  pixelsPerSecondRef.current = pixelsPerSecond;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const safeDuration = Math.max(duration, 1);
  const contentWidth = timeToPx(safeDuration, pixelsPerSecond) + 240; // trailing runway to drop clips past the end

  // ---- neighbor snap targets (clip edges + playhead) ----------------------
  const snapTargets = useMemo(() => {
    const targets: number[] = [0, playhead, duration];
    for (const c of clips) {
      if (!c.kept) continue;
      targets.push(c.timelineStart, c.timelineEnd);
    }
    // Overlay edges are snap targets too, so moving/trimming a media layer clicks
    // to a scene cut, another overlay's edge, the playhead, or the reel bounds.
    for (const o of overlays) {
      targets.push(o.timelineStart, o.timelineEnd);
    }
    for (const clip of sfxClips) {
      targets.push(clip.timelineStart, sfxClipTimelineEnd(clip));
    }
    // Marker pins are snap targets too, so a clip/overlay edge or the playhead
    // clicks to a marked beat -- the drag-side complement to [ / ] marker nav.
    for (const m of markers) {
      targets.push(m.t);
    }
    return targets;
  }, [clips, overlays, sfxClips, markers, playhead, duration]);

  // Snap threshold in seconds -- or -1 (unreachable) when the magnet is OFF, so
  // snapTime never finds a target within range and returns the raw candidate.
  // This single gate disables snapping for playhead / clip-edge / clip-body /
  // keyframe drags at once, without touching each call site.
  const snapThresholdSeconds = snapEnabled ? SNAP_PX / pixelsPerSecond : -1;

  // ---- pointer helpers ------------------------------------------------------
  const clientXToTime = useCallback(
    (clientX: number): number => {
      const area = trackAreaRef.current;
      if (!area) return 0;
      // getBoundingClientRect() already reflects the CURRENT scrolled position of
      // the track area (it moves left as the container scrolls right), so
      // `clientX - rect.left` is ALREADY the content-space offset. Adding
      // scrollLeft on top double-counts the scroll -- the playhead lands ahead of
      // the click by exactly scrollLeft (worse the further you've scrolled). The
      // rect is measured against the same content origin the playhead is
      // positioned in (timeToPx from x=0 of this same div), so no scroll term.
      const rect = area.getBoundingClientRect();
      const px = clientX - rect.left;
      return Math.max(0, pxToTime(px, pixelsPerSecond));
    },
    [pixelsPerSecond]
  );

  // Live snapshot of everything the GLOBAL drag handlers read, so the window
  // pointermove/pointerup listeners subscribe ONCE instead of re-attaching every
  // frame during playback (playhead changes -> snapTargets identity changes ->
  // the drag effect would re-run ~60x/sec; a remove/add gap mid-drag can miss
  // the pointerup and leave dragRef stuck). Same ref pattern as the momentum
  // coast's pixelsPerSecondRef/durationRef above.
  const dragEnvRef = useRef({
    clientXToTime,
    clips,
    duration,
    pixelsPerSecond,
    playhead,
    snapTargets,
    snapThresholdSeconds,
  });
  dragEnvRef.current = {
    clientXToTime,
    clips,
    duration,
    pixelsPerSecond,
    playhead,
    snapTargets,
    snapThresholdSeconds,
  };

  // ---- drag-drop media overlays onto the tracks -----------------------------
  // Dragging an image/video file over the track content shows a coral drop line
  // at the snapped output time; dropping ingests each file as an overlay there
  // (copy-to-disk, then addOverlay). Only file drags are handled -- an internal
  // clip/marker drag never sets dataTransfer.files, so it's ignored here.
  const dragCarriesFiles = useCallback((e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    // Chrome exposes "Files" in types during a file drag (before the drop, the
    // file list itself is empty for security, so `types` is the reliable probe).
    return Array.from(types).includes("Files");
  }, []);

  const dragCarriesSfx = useCallback((e: React.DragEvent): boolean => (
    Array.from(e.dataTransfer?.types ?? []).includes(SFX_DRAG_MIME)
  ), []);

  const snappedDropTime = useCallback(
    (clientX: number): number => {
      const raw = clientXToTime(clientX);
      const { time } = snapTime(raw, snapTargets, snapThresholdSeconds);
      return Math.max(0, time);
    },
    [clientXToTime, snapTargets, snapThresholdSeconds]
  );

  const handleTrackDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!dragCarriesFiles(e) && !dragCarriesSfx(e)) return;
      // preventDefault marks this a valid drop target (without it the browser
      // navigates to the file / does nothing on drop).
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const t = snappedDropTime(e.clientX);
      setDropIndicatorX(timeToPx(t, pixelsPerSecond));
    },
    [dragCarriesFiles, dragCarriesSfx, snappedDropTime, pixelsPerSecond]
  );

  const handleTrackDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the track area, not when it
    // crosses onto a child block (relatedTarget still inside the area).
    const area = trackAreaRef.current;
    const next = e.relatedTarget;
    if (area && next instanceof Node && area.contains(next)) return;
    setDropIndicatorX(null);
  }, []);

  const handleTrackDrop = useCallback(
    (e: React.DragEvent) => {
      const carriesSfx = dragCarriesSfx(e);
      const carriesFiles = dragCarriesFiles(e);
      if (!carriesFiles && !carriesSfx) return;
      e.preventDefault();
      setDropIndicatorX(null);
      const atTime = snappedDropTime(e.clientX);
      if (carriesSfx) {
        try {
          const payload = JSON.parse(e.dataTransfer.getData(SFX_DRAG_MIME)) as SfxDragPayload;
          if ("builtInKey" in payload && isApprovedSfxKey(payload.builtInKey)) {
            const entry = SFX_CATALOG[payload.builtInKey];
            useRepurposeStore.getState().addSfxClip({
              name: entry.displayName,
              source: { kind: "built-in", key: payload.builtInKey },
              atTime,
            });
          } else if ("assetId" in payload) {
            const asset = useRepurposeStore.getState().sfxAssets.find((item) => item.id === payload.assetId);
            if (asset?.sourcePath) {
              useRepurposeStore.getState().addSfxClip({
                name: asset.name,
                source: { kind: "imported", assetId: asset.id, srcDuration: asset.srcDuration },
                atTime,
              });
            }
          }
        } catch {
          // Ignore malformed internal payloads; paths are never accepted here.
        }
        return;
      }
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      const audioFiles = files.filter(isAudioLikeFile);
      const overlayFiles = files.filter((file) => !isAudioLikeFile(file));
      if (audioFiles.length > 0 && sfxImportOwner) {
        setSfxDropError(null);
        void (async () => {
          for (const file of audioFiles) {
            try {
              await importSfxFile(file, atTime, sfxImportOwner);
            } catch (error) {
              if (error instanceof DOMException && error.name === "AbortError") return;
              const message = error instanceof Error ? error.message : "Sound-effect import failed.";
              setSfxDropError(`${file.name}: ${message}`);
              break;
            }
          }
        })();
      }
      if (overlayFiles.length > 0) {
        void ingestOverlayFiles(
          overlayFiles,
          atTime,
          undefined,
          overlayImportOwner
        ).catch(() => undefined);
      }
    },
    [dragCarriesFiles, dragCarriesSfx, overlayImportOwner, sfxImportOwner, snappedDropTime]
  );

  const deleteSfxClipAndRestoreFocus = useCallback((id: string) => {
    const state = useRepurposeStore.getState();
    const index = state.sfxClips.findIndex((clip) => clip.id === id);
    if (index < 0) return;
    const nearest = state.sfxClips[index + 1] ?? state.sfxClips[index - 1] ?? null;
    removeSfxClip(id);
    selectSfxClip(nearest?.id ?? null);
    focusSfxTimelineTarget(nearest?.id ?? null);
  }, [removeSfxClip, selectSfxClip]);

  const handleSfxKeyboardMove = useCallback((id: string, delta: number) => {
    const state = useRepurposeStore.getState();
    const clip = state.sfxClips.find((candidate) => candidate.id === id);
    if (clip) state.moveSfxClip(id, clip.timelineStart + delta);
  }, []);

  const handleSfxKeyboardTrim = useCallback((
    id: string,
    edge: "start" | "end",
    delta: number
  ) => {
    const state = useRepurposeStore.getState();
    const clip = state.sfxClips.find((candidate) => candidate.id === id);
    if (!clip) return;
    if (edge === "start") state.trimSfxClipLeft(id, clip.timelineStart + delta);
    else state.trimSfxClipRight(id, sfxClipTimelineEnd(clip) + delta);
  }, []);

  // ---- zoom -----------------------------------------------------------------
  // Zoom ANCHORED ON THE PLAYHEAD: the frame under the play mark must stay put on
  // screen while the scale changes, so zoom reads as "push in / pull out at the
  // play mark", never a random horizontal jump.
  //
  // The hard part is TIMING, not the algebra. The playhead's on-screen x is a
  // pure function of scale + scrollLeft:
  //   screenOffset = timeToPx(playhead, pps) - scrollLeft   (content-frame; the
  //   sticky rail is a constant on both sides, so it cancels)
  // To hold `screenOffset` across a scale change we want:
  //   scrollLeft_new = timeToPx(playhead, ppsNew) - screenOffset
  // BUT writing scrollLeft in the same tick as setPixelsPerSecond is wrong: the
  // content is still the OLD (narrower) width, so the browser CLAMPS the new
  // scrollLeft to the old `scrollWidth - clientWidth`. Zooming IN needs a LARGER
  // scrollLeft than the old width allows -> it clamps short -> the playhead
  // drifts left (the exact bug seen in testing: handle jumped ~300px). So we
  // instead RECORD the desired anchor (playhead time + its current screen
  // offset) synchronously, bump the scale, and apply the scroll in a
  // useLayoutEffect AFTER React has grown the content to the new width -- when
  // the target scrollLeft is finally reachable. pendingZoomAnchorRef carries the
  // intent across that commit; it's a ref so it never triggers a render.
  const pendingZoomAnchorRef = useRef<{ time: number; screenOffset: number } | null>(null);

  const zoomAnchored = useCallback((factor: number): number => {
    const el = scrollRef.current;
    const cur = pixelsPerSecondRef.current;
    const next = clamp(cur * factor, MIN_PPS, MAX_PPS);
    if (next === cur) return cur; // already at a zoom limit -- nothing to anchor
    if (el) {
      const livePlayhead = useRepurposeStore.getState().playhead;
      // Record where the playhead currently sits on screen (content frame). This
      // offset is what we hold constant; the layout effect below restores it once
      // the content has been re-laid-out at `next`.
      pendingZoomAnchorRef.current = {
        time: livePlayhead,
        screenOffset: timeToPx(livePlayhead, cur) - el.scrollLeft,
      };
    }
    setPixelsPerSecond(next);
    return next;
  }, []);

  // Apply the recorded playhead anchor AFTER the content has grown/shrunk to the
  // new scale, so the target scrollLeft is reachable (not clamped against the old
  // width). Runs synchronously post-DOM-mutation, pre-paint, so there's no
  // one-frame flash. Clears the pending anchor so a normal re-render (e.g. a
  // clip edit that also changes pixelsPerSecond deps) never re-applies a stale
  // scroll. clamp >= 0 guards an anchor near t=0.
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    if (!anchor) return;
    pendingZoomAnchorRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, timeToPx(anchor.time, pixelsPerSecond) - anchor.screenOffset);
  }, [pixelsPerSecond]);

  const zoomIn = useCallback(() => {
    zoomAnchored(ZOOM_STEP);
  }, [zoomAnchored]);
  const zoomOut = useCallback(() => {
    zoomAnchored(1 / ZOOM_STEP);
  }, [zoomAnchored]);

  // Usable timeline width = the scroll container minus the sticky ~80px label
  // rail and a small breathing margin, so a "fit" pass lands the whole thing
  // inside the visible track area rather than tucking the tail under the rail.
  const LABEL_RAIL_PX = 80; // matches the w-20 sticky rail
  const FIT_MARGIN_PX = 24;

  // ---- fit to window: zoom so the whole duration fills the viewport ----------
  const fitToWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const usable = el.clientWidth - LABEL_RAIL_PX - FIT_MARGIN_PX;
    if (usable <= 0) return;
    const next = clamp(usable / Math.max(duration, 1), MIN_PPS, MAX_PPS);
    setPixelsPerSecond(next);
    el.scrollLeft = 0;
  }, [duration]);

  // ---- zoom to selection: frame the selected clip at ~80% of the viewport ----
  const zoomToSelection = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      fitToWindow();
      return;
    }
    const clip = clips.find((c) => c.id === selectedClipId && c.kept);
    if (!clip) {
      fitToWindow();
      return;
    }
    const usable = el.clientWidth - LABEL_RAIL_PX - FIT_MARGIN_PX;
    const span = Math.max(clip.timelineEnd - clip.timelineStart, 0.001);
    // Fill ~80% of the usable width with the clip's span, then park the clip's
    // start ~10% in from the left of the track area (rail-adjusted). Route the
    // scroll through the SAME deferred-anchor mechanism the button/wheel zoom
    // uses: writing scrollLeft synchronously here clamps against the OLD (narrow)
    // content width, so zooming IN near the tail lands short. The layout effect
    // applies it after the content re-lays-out at `next`.
    const next = clamp((usable * 0.8) / span, MIN_PPS, MAX_PPS);
    pendingZoomAnchorRef.current = { time: clip.timelineStart, screenOffset: usable * 0.1 };
    setPixelsPerSecond(next);
  }, [clips, selectedClipId, fitToWindow]);

  // Attached NATIVELY with { passive: false } (see the effect below), NOT via
  // React's onWheel prop: React 17+ registers its delegated root 'wheel'
  // listener as PASSIVE, so an onWheel handler's preventDefault() is silently
  // ignored and ctrl/cmd+pinch zooms the BROWSER PAGE while also zooming the
  // timeline. Same pattern as PreviewCanvas's onLayerWheel.
  const handleWheelZoom = useCallback((e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return; // plain scroll = pan, ctrl/cmd+scroll = zoom
    e.preventDefault();
    // Zoom factor is CONTINUOUS in the pinch/scroll delta, not a fixed 1.25 per
    // event. A trackpad pinch emits a STREAM of ctrlKey wheel events; applying a
    // full ZOOM_STEP on each one compounds (1.25^N) and rockets from MIN_PPS to
    // MAX_PPS in a few frames -- the "too fast / jumpy" pinch. Instead map the
    // gesture's magnitude (deltaY) to an exponential factor so a small pinch
    // nudges the scale and a big pinch moves it more, smoothly, at any event
    // rate. exp() keeps zoom perceptually uniform (equal finger travel = equal
    // ratio) and is symmetric: pinch out then back returns to the same scale.
    // ZOOM_SENSITIVITY is tuned so a normal pinch reads as a gentle push-in;
    // the |deltaY| clamp guards against a rare single huge wheel delta (e.g. a
    // mouse notch reported as ~100) snapping the scale in one jump.
    const ZOOM_SENSITIVITY = 0.01;
    const delta = clamp(e.deltaY, -40, 40);
    // Same playhead-anchored zoom as the buttons, so a ctrl/cmd+scroll pushes in
    // at the play mark instead of drifting the content sideways.
    zoomAnchored(Math.exp(-delta * ZOOM_SENSITIVITY));
  }, [zoomAnchored]);

  // Bind the wheel-zoom handler as a NON-PASSIVE native listener so its
  // preventDefault() actually suppresses the browser's page zoom on ctrl/cmd+
  // wheel (a React onWheel prop is passive, so preventDefault there is a no-op).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => el.removeEventListener("wheel", handleWheelZoom);
  }, [handleWheelZoom]);

  // ---- ruler / playhead scrub -----------------------------------------------
  // The ONE entry point for starting a playhead scrub, shared by every surface
  // that should move the play mark: the ruler, the empty tracks background, and
  // the playhead handle itself. `seek` is true when the pointer-down should also
  // jump the playhead to the click (ruler + track background -- "click here to
  // move the play mark"); it's false when grabbing the existing playhead handle
  // (a drag from where it already is, no initial jump). Capture is taken on the
  // element the listener is bound to (currentTarget), NOT e.target: a child (a
  // ruler tick, the handle's inner diamond) would otherwise capture the pointer
  // and the first move could miss. All callers pass a container/handle as
  // currentTarget, so capture always lands on a stable element.
  // Cancel any in-flight release-coast rAF. Shared by startPlayheadScrub and the
  // three drag-start handlers so grabbing the playhead OR a clip/edge/keyframe
  // stops a coast that would otherwise keep drifting the play mark.
  const stopCoast = useCallback(() => {
    if (momentumRafRef.current) {
      cancelAnimationFrame(momentumRafRef.current);
      momentumRafRef.current = null;
    }
  }, []);

  const startPlayheadScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, seek: boolean) => {
      // Grabbing the playhead again stops any in-flight release coast so it can't
      // fight the fresh scrub, and clears leftover velocity so a plain click
      // (no movement) after a prior fling can't coast off the clicked frame.
      stopCoast();
      scrubMomentumRef.current = 0;
      if (seek) {
        const t = clientXToTime(e.clientX);
        setPlayhead(clamp(t, 0, duration));
      }
      dragRef.current = { type: "playhead" };
      lastScrubClientXRef.current = e.clientX;
      lastScrubTsRef.current = performance.now();
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [clientXToTime, setPlayhead, duration, stopCoast]
  );

  // Ruler + empty-track background: click/drag anywhere seeks the play mark to
  // the pointer, then scrubs. (Clips/keyframes/markers stopPropagation on their
  // own pointer-down, so a grab on one of them never reaches this and starts a
  // scrub instead of the intended clip/keyframe drag.)
  const handleScrubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only a primary (left / touch / pen) button starts a scrub -- a
      // right-click (context menu) or middle-click must not move the playhead.
      if (e.button !== 0) return;
      startPlayheadScrub(e, true);
    },
    [startPlayheadScrub]
  );

  // Playhead handle grab: drag from where the play mark already is, no jump.
  const handlePlayheadPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // don't also trigger the background scrub underneath
      startPlayheadScrub(e, false);
    },
    [startPlayheadScrub]
  );

  // ---- clip body drag (reorder) ---------------------------------------------
  const handleClipBodyDragStart = useCallback(
    (clip: Clip, clientX: number) => {
      stopCoast();
      // Freeze the OTHER kept clips' centers now, at drag start. The reorder
      // target is computed against this stable snapshot on every move so a
      // multi-slot drag lands correctly in one shot (see ReorderSibling).
      const siblings: ReorderSibling[] = clips
        .filter((c) => c.kept && c.id !== clip.id)
        .map((c) => ({ id: c.id, center: (c.timelineStart + c.timelineEnd) / 2 }))
        .sort((a, b) => a.center - b.center);
      dragRef.current = {
        type: "clip-body",
        clip,
        startClientX: clientX,
        startTimelineStart: clip.timelineStart,
        siblings,
      };
    },
    [clips, stopCoast]
  );

  // ---- clip edge drag (trim) -------------------------------------------------
  const handleClipEdgeDragStart = useCallback(
    (clip: Clip, edge: "start" | "end", clientX: number) => {
      stopCoast();
      dragRef.current = {
        type: "clip-edge",
        clip,
        edge,
        startClientX: clientX,
        startSrcStart: clip.srcStart,
        startSrcEnd: clip.srcEnd,
      };
    },
    [stopCoast]
  );

  // ---- overlay body drag (slide in output time -- NO ripple) -----------------
  const handleOverlayBodyDragStart = useCallback(
    (overlay: Overlay, clientX: number) => {
      stopCoast();
      dragRef.current = {
        type: "overlay-body",
        overlay,
        startClientX: clientX,
        startTimelineStart: overlay.timelineStart,
      };
    },
    [stopCoast]
  );

  // ---- overlay edge drag (trim one edge, frozen-anchor absolute target) -------
  const handleOverlayEdgeDragStart = useCallback(
    (overlay: Overlay, edge: "start" | "end", clientX: number) => {
      stopCoast();
      dragRef.current = {
        type: "overlay-edge",
        overlay,
        edge,
        startClientX: clientX,
        startTimelineStart: overlay.timelineStart,
        startTimelineEnd: overlay.timelineEnd,
      };
    },
    [stopCoast]
  );

  const handleSfxBodyDragStart = useCallback((clip: SfxClip, clientX: number) => {
    stopCoast();
    dragRef.current = { type: "sfx", clip, edge: "body", startClientX: clientX, token: null };
  }, [stopCoast]);

  const handleSfxEdgeDragStart = useCallback((clip: SfxClip, edge: "start" | "end", clientX: number) => {
    stopCoast();
    dragRef.current = { type: "sfx", clip, edge, startClientX: clientX, token: null };
  }, [stopCoast]);

  useEffect(() => useRepurposeStore.getState().subscribeSfxGestureCancellation(() => {
    if (dragRef.current?.type === "sfx") dragRef.current = null;
    setSnapGuideX(null);
  }), []);

  // ---- scrub-release momentum coast (self-driven) ---------------------------
  // Runs on its OWN rAF, reading pixelsPerSecond / duration from refs so it is
  // NOT tied to the drag effect's lifecycle. A physics-first glide on scrub
  // release, decaying to zero -- matching the project's animation defaults.
  // Stable identity (setPlayhead is a stable Zustand action) so it never
  // re-subscribes anything. The rAF is cancelled only on unmount (see below).
  const startMomentumCoast = useCallback(
    (initialVelocity: number) => {
      if (momentumRafRef.current) cancelAnimationFrame(momentumRafRef.current);
      if (Math.abs(initialVelocity) < 0.02) return;
      let velocity = initialVelocity;
      const step = () => {
        velocity *= 0.9;
        const current = useRepurposeStore.getState().playhead;
        const dur = durationRef.current;
        const deltaTime = pxToTime(velocity * 16, pixelsPerSecondRef.current);
        const next = clamp(current + deltaTime, 0, dur);
        setPlayhead(next);
        if (Math.abs(velocity) > 0.01 && next > 0 && next < dur) {
          momentumRafRef.current = requestAnimationFrame(step);
        } else {
          momentumRafRef.current = null;
        }
      };
      momentumRafRef.current = requestAnimationFrame(step);
    },
    [setPlayhead]
  );

  // The coast's rAF is cancelled ONLY when the component unmounts -- never on a
  // normal re-render -- so a routine render (e.g. the coast's own setPlayhead
  // bumping snapTargets) can't abort the glide mid-flight.
  useEffect(() => {
    return () => {
      if (momentumRafRef.current) cancelAnimationFrame(momentumRafRef.current);
    };
  }, []);

  // ---- global pointer move / up while any drag is active ---------------------
  // Handlers read live values via dragEnvRef (see its note) so this effect's
  // deps are ONLY the stable store actions -- it attaches once, never mid-drag.
  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const {
        clientXToTime,
        clips,
        duration,
        pixelsPerSecond,
        playhead,
        snapTargets,
        snapThresholdSeconds,
      } = dragEnvRef.current;

      if (drag.type === "playhead") {
        const t = clientXToTime(e.clientX);
        // Drop the current playhead from the snap targets: snapTargets includes
        // `playhead`, and every scrub move sets it, so leaving it in makes the
        // next candidate snap straight back to where it just landed (sticky,
        // worst at high zoom). Mirror the clip-body anchor filter below.
        const { time } = snapTime(
          t,
          snapTargets.filter((target) => Math.abs(target - playhead) > 0.001),
          snapThresholdSeconds
        );
        setPlayhead(clamp(time, 0, duration));

        const now = performance.now();
        if (lastScrubClientXRef.current !== null) {
          const dt = now - lastScrubTsRef.current;
          if (dt > 0) {
            scrubMomentumRef.current = (e.clientX - lastScrubClientXRef.current) / Math.max(dt, 1);
          }
        }
        lastScrubClientXRef.current = e.clientX;
        lastScrubTsRef.current = now;
        return;
      }

      if (drag.type === "sfx") {
        const deltaPx = e.clientX - drag.startClientX;
        if (!drag.token && Math.abs(deltaPx) < 4) return;
        if (!drag.token) {
          const kind = drag.edge === "body" ? "move" : drag.edge === "start" ? "left-trim" : "right-trim";
          drag.token = beginSfxGesture(drag.clip.id, kind);
        }
        if (!drag.token) return;
        const anchor = drag.edge === "end" ? sfxClipTimelineEnd(drag.clip) : drag.clip.timelineStart;
        const ownEnd = sfxClipTimelineEnd(drag.clip);
        const liveClip = useRepurposeStore.getState().sfxClips.find(
          (clip) => clip.id === drag.clip.id
        );
        const liveEnd = liveClip ? sfxClipTimelineEnd(liveClip) : ownEnd;
        const selfFilteredTargets = snapTargets.filter((target) => (
            Math.abs(target - drag.clip.timelineStart) > .001
            && Math.abs(target - ownEnd) > .001
            && Math.abs(target - (liveClip?.timelineStart ?? drag.clip.timelineStart)) > .001
            && Math.abs(target - liveEnd) > .001
        ));
        const candidate = anchor + pxToTime(deltaPx, pixelsPerSecond);
        if (drag.edge === "body") {
          const snappedMove = snapMovedSpan(
            candidate,
            drag.clip.sourceEnd - drag.clip.sourceStart,
            selfFilteredTargets,
            snapThresholdSeconds
          );
          setSnapGuideX(snappedMove.snapTarget === null
            ? null
            : timeToPx(snappedMove.snapTarget, pixelsPerSecond));
          updateSfxGesture(drag.token, snappedMove.start);
          return;
        }
        const { time, snapped } = snapTime(candidate, selfFilteredTargets, snapThresholdSeconds);
        setSnapGuideX(snapped ? timeToPx(time, pixelsPerSecond) : null);
        updateSfxGesture(drag.token, time);
        return;
      }

      if (drag.type === "clip-body") {
        const deltaPx = e.clientX - drag.startClientX;
        const deltaTime = pxToTime(deltaPx, pixelsPerSecond);
        const candidateStart = drag.startTimelineStart + deltaTime;
        const { time: snappedStart, snapped } = snapTime(
          candidateStart,
          snapTargets.filter((t) => Math.abs(t - drag.startTimelineStart) > 0.001),
          snapThresholdSeconds
        );
        setSnapGuideX(snapped ? timeToPx(snappedStart, pixelsPerSecond) : null);

        // Determine the target index in ONE shot from the dragged clip's
        // candidate center against the FROZEN sibling centers (drag.siblings).
        // `keptRank` = how many other kept clips the dragged clip now sits after
        // (i.e. whose frozen center is left of the candidate center). This is
        // direction-agnostic and independent of the live ripple layout, so a
        // drag of any distance -- left or right -- resolves to the correct slot
        // instead of creeping one step per move.
        const candidateCenter = snappedStart + (drag.clip.timelineEnd - drag.clip.timelineStart) / 2;
        let keptRank = 0;
        for (const sib of drag.siblings) {
          if (candidateCenter > sib.center) keptRank++;
          else break; // siblings are ascending by center; no later one can be left of us
        }
        // Translate keptRank -> absolute array index. Build the order of clips
        // WITHOUT the dragged one (its removal is what reorderClips splices out
        // first), then find the insert slot that places it after exactly
        // `keptRank` kept siblings, keeping deleted clips in their relative
        // order. Because we compute against the without-dragged array this index
        // is already post-splice-out correct -- passing it straight to
        // reorderClips lands the clip deterministically for any drag distance.
        const currentIdx = clips.findIndex((c) => c.id === drag.clip.id);
        const without = clips.filter((c) => c.id !== drag.clip.id);
        let seenKept = 0;
        let insertIdx = without.length; // default: past the end
        for (let i = 0; i < without.length; i++) {
          if (without[i].kept) {
            if (seenKept === keptRank) {
              insertIdx = i;
              break;
            }
            seenKept++;
          }
        }
        if (insertIdx !== currentIdx) {
          reorderClips(drag.clip.id, insertIdx);
        }
        return;
      }

      if (drag.type === "clip-edge") {
        const deltaPx = e.clientX - drag.startClientX;
        const deltaTime = pxToTime(deltaPx, pixelsPerSecond);
        if (drag.edge === "start") {
          // Snap in timeline space, then map the snapped timeline delta back
          // to an ABSOLUTE source target. deltaTime is 1:1 between timeline
          // and source space (a trim shifts the edge by the same amount in
          // both), so the source target is the frozen source anchor plus the
          // snapped timeline delta -- an absolute value, never a compounding
          // delta on the live store value.
          const { time: snapped } = snapTime(
            drag.clip.timelineStart + deltaTime,
            snapTargets,
            snapThresholdSeconds
          );
          const snappedDelta = snapped - drag.clip.timelineStart;
          trimClip(drag.clip.id, "start", drag.startSrcStart + snappedDelta);
        } else {
          const { time: snapped } = snapTime(
            drag.clip.timelineEnd + deltaTime,
            snapTargets,
            snapThresholdSeconds
          );
          const snappedDelta = snapped - drag.clip.timelineEnd;
          trimClip(drag.clip.id, "end", drag.startSrcEnd + snappedDelta);
        }
        return;
      }

      if (drag.type === "overlay-body") {
        // Free slide in output time -- overlays overlap freely, so NO reorder
        // logic (unlike clip-body). Snap the leading edge to neighbor targets,
        // filtering out this overlay's OWN start so it can't stick to itself.
        // moveOverlay preserves length + clamps to [0, duration] and does NOT
        // ripple (overlays are independent of the reel length).
        const deltaPx = e.clientX - drag.startClientX;
        const deltaTime = pxToTime(deltaPx, pixelsPerSecond);
        const candidateStart = drag.startTimelineStart + deltaTime;
        const { time: snappedStart, snapped } = snapTime(
          candidateStart,
          snapTargets.filter((t) => Math.abs(t - drag.startTimelineStart) > 0.001),
          snapThresholdSeconds
        );
        setSnapGuideX(snapped ? timeToPx(snappedStart, pixelsPerSecond) : null);
        moveOverlay(drag.overlay.id, snappedStart);
        return;
      }

      if (drag.type === "overlay-edge") {
        // Frozen-anchor absolute-target trim, mirroring clip-edge: snap the moved
        // edge in timeline space, then hand trimOverlay the ABSOLUTE target so a
        // live drag can never compound off the (updating) store value. trimOverlay
        // does NOT ripple and clamps to MIN_OVERLAY_DURATION + [0, duration] (and,
        // for a video, the available footage). A start-trim also advances srcStart.
        const deltaPx = e.clientX - drag.startClientX;
        const deltaTime = pxToTime(deltaPx, pixelsPerSecond);
        const anchor = drag.edge === "start" ? drag.startTimelineStart : drag.startTimelineEnd;
        const { time: snapped, snapped: didSnap } = snapTime(
          anchor + deltaTime,
          snapTargets.filter((t) => Math.abs(t - anchor) > 0.001),
          snapThresholdSeconds
        );
        setSnapGuideX(didSnap ? timeToPx(snapped, pixelsPerSecond) : null);
        trimOverlay(drag.overlay.id, drag.edge, snapped);
        return;
      }
    };

    const handleUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setSnapGuideX(null);
      if (drag?.type === "sfx" && drag.token) endSfxGesture(drag.token);
      if (drag?.type === "playhead") {
        lastScrubClientXRef.current = null;
        // Hand the release velocity to the standalone coast driver. The coast
        // MUST NOT run inside this effect: its setPlayhead changes playhead ->
        // snapTargets identity -> this effect re-runs -> its cleanup would
        // cancel the in-flight coast rAF, killing the glide after one frame.
        startMomentumCoast(scrubMomentumRef.current);
      }
    };

    const handleCancel = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setSnapGuideX(null);
      if (drag?.type === "sfx" && drag.token) cancelSfxGesture(drag.token);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      const drag = dragRef.current;
      if (drag?.type === "sfx" && drag.token) cancelSfxGesture(drag.token);
      // NOTE: do NOT cancel momentumRafRef here. The coast is owned by its own
      // unmount-only effect (see below); cancelling it on every re-render is
      // exactly the bug this fix removes.
    };
  }, [
    reorderClips,
    setPlayhead,
    startMomentumCoast,
    trimClip,
    moveOverlay,
    trimOverlay,
    beginSfxGesture,
    updateSfxGesture,
    endSfxGesture,
    cancelSfxGesture,
  ]);

  // ---- keyboard: delete selected clip -----------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // The transcript panel owns Delete/Backspace (word delete) via its own
      // focus-scoped handler. A word click also calls selectClip, so selectedClipId
      // is always set while editing there -- without this gate a Delete would fire
      // BOTH deleteWords (rail) AND deleteClip (here). Yield the whole keydown to
      // the panel when the event originates inside it.
      if (target?.closest("#transcript-panel")) return;
      const isEditable =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (isEditable) return;

      const sfxState = useRepurposeStore.getState();
      if ((e.key === "Delete" || e.key === "Backspace") && sfxState.selectedSfxClipId) {
        e.preventDefault();
        deleteSfxClipAndRestoreFocus(sfxState.selectedSfxClipId);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyD" && sfxState.selectedSfxClipId) {
        e.preventDefault();
        const id = duplicateSfxClip(sfxState.selectedSfxClipId);
        if (id) {
          selectSfxClip(id);
          focusSfxTimelineTarget(id);
        }
        return;
      }

      // Overlay first, and short-circuit: selecting an overlay clears
      // selectedClipId in the store (mutual exclusion), so an overlay-delete and
      // a clip-delete can never both fire. This early-return is the one-line
      // guard keeping the two Delete / Cmd+D paths disjoint even if a stray clip
      // id lingered -- a selected overlay is a media layer, never a scene.
      // PreviewCanvas owns its Cmd+D because only it has live frame geometry.
      const isDelete = e.key === "Delete" || e.key === "Backspace";
      if (isDelete) {
        const state = useRepurposeStore.getState();
        const hasOverlaySelection =
          state.selectedOverlayId !== null || state.selectedOverlayIds.length > 0;
        if (hasOverlaySelection) {
          const primary = resolveEffectivePrimaryOverlay(
            state.overlays,
            state.selectedOverlayIds,
            state.selectedOverlayId,
            effectiveSplitRatio(
              splitRatioAt(state.clips, state.playhead, state.splitRatio),
              DEFAULT_HEIGHT
            )
          );
          if (!primary) return;
          e.preventDefault();
          removeOverlay(primary.id);
          return;
        }
        // Any other key falls through to the Z-zoom shortcuts below.
      }

      // A SELECTED WORD (from a clip word-cell click) wins over the scene: Delete
      // cuts just that word, never the whole clip. selectWords already cleared
      // selectedClipId (mutual exclusion), so this branch and the clip branch are
      // disjoint -- but we check it first for clarity + safety.
      if ((e.key === "Delete" || e.key === "Backspace") && selectedWordRange) {
        e.preventDefault();
        deleteWords(selectedWordRange.lo, selectedWordRange.hi);
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedClipId) {
        e.preventDefault();
        deleteClip(selectedClipId);
        return;
      }
      // Cmd/Ctrl+D -- duplicate the selected clip (standard NLE dupe).
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyD" && selectedClipId) {
        e.preventDefault();
        duplicateClip(selectedClipId);
        return;
      }
      // Z zoom niceties. Plain Z = zoom to selection, Shift+Z = fit to window.
      // Cmd/Ctrl+Z is undo (owned by TransportBar) -- explicitly skipped here so
      // we never steal the undo chord.
      if (e.code === "KeyZ" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) fitToWindow();
        else zoomToSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedClipId,
    selectedWordRange,
    deleteWords,
    deleteClip,
    duplicateClip,
    removeOverlay,
    removeSfxClip,
    duplicateSfxClip,
    deleteSfxClipAndRestoreFocus,
    selectSfxClip,
    fitToWindow,
    zoomToSelection,
  ]);

  // Deselect only for a click that landed DIRECTLY on the wrapper -- a ruler /
  // empty-track scrub synthesizes a click that bubbles up here, and without this
  // guard it would clear the selected clip after every scrub.
  const handleBackgroundClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    selectClip(null);
    selectSfxClip(null);
  }, [selectClip, selectSfxClip]);

  // ---- ruler ticks ------------------------------------------------------------
  const tickInterval = pickTickInterval(pixelsPerSecond);
  const ticks = useMemo(() => {
    const list: number[] = [];
    for (let t = 0; t <= safeDuration + tickInterval; t += tickInterval) {
      list.push(t);
    }
    return list;
  }, [safeDuration, tickInterval]);

  const playheadPx = timeToPx(playhead, pixelsPerSecond);

  // ---- auto-scroll: keep the playhead in view during playback ---------------
  // Standard NLE behavior -- while playing, if the playhead drifts out of the
  // comfortable band of the scroll viewport, nudge scrollLeft so it sits ~15%
  // from the left. Only while PLAYING (paused = the user scrolls/scrubs freely),
  // and only when actually out of band, so there's no jitter or fight.
  useEffect(() => {
    if (!isPlaying) return;
    const el = scrollRef.current;
    if (!el) return;
    const margin = 40;
    const viewLeft = el.scrollLeft + margin;
    const viewRight = el.scrollLeft + el.clientWidth - margin;
    // Label rail is sticky ~80px wide; the playhead px is measured from content
    // origin, so compare against the scroll position directly (close enough for
    // "keep it visible"). Re-anchor to ~15% in when it leaves the band.
    if (playheadPx < viewLeft || playheadPx > viewRight) {
      el.scrollLeft = Math.max(0, playheadPx - el.clientWidth * 0.15);
    }
  }, [playheadPx, isPlaying]);

  // ---- overlay lane packing (dynamic row height) ----------------------------
  // Greedy calendar packing: one sub-lane per concurrent overlap, NO fixed cap.
  // The Overlay row's height grows with the max simultaneous overlap; the body
  // scrolls vertically once the whole stack is tall. Higher-z overlaps float to
  // the upper lanes (packLanes pre-sorts start ties by descending z). Each block
  // still shows its true z via a badge, independent of which lane it landed in.
  const { lanes: overlayLanes, laneCount: overlayLaneCount } = useMemo(
    // Map to the LaneSpan shape (start/end); packLanes returns lane indices in
    // this SAME order, so overlays[i] <-> overlayLanes[i].
    () =>
      packLanes(
        overlays.map((o) => ({ start: o.timelineStart, end: o.timelineEnd, zIndex: o.zIndex }))
      ),
    [overlays]
  );
  // The row is at least one lane tall so it's a visible drop target even when
  // empty (Step 4 drop/paste lands overlays here).
  const overlayRowLanes = Math.max(1, overlayLaneCount);
  const overlayRowHeight =
    overlayRowLanes * OVERLAY_LANE_HEIGHT + (overlayRowLanes - 1) * OVERLAY_LANE_GAP;
  const { lanes: sfxLanes, laneCount: sfxLaneCount } = useMemo(
    () => packLanes(sfxClips.map((clip) => ({
      start: clip.timelineStart,
      end: sfxClipTimelineEnd(clip),
    }))),
    [sfxClips]
  );
  const sfxRowLanes = Math.max(1, sfxLaneCount);
  const sfxRowHeight = sfxRowLanes * SFX_LANE_HEIGHT + (sfxRowLanes - 1) * SFX_LANE_GAP;

  // Vertical layout, top -> bottom: Overlays row (media ON TOP of the composite),
  // then the single unified clip track, then the Music row (background bed), then
  // the Audio row (SFX, which sits UNDER the picture) at the very bottom. Each row
  // separated by TRACK_GAP; the clip / music / audio rows keep the fixed
  // TRACK_HEIGHT. This order matches the draw stack: overlays draw last (top),
  // music + SFX play under all. Music sits between the clips and the SFX row; the
  // SFX (Audio) row stays LAST.
  const overlayRowTop = 0;
  const clipRowTop = overlayRowHeight + TRACK_GAP;
  const musicRowTop = clipRowTop + TRACK_HEIGHT + TRACK_GAP;
  const audioRowTop = musicRowTop + TRACK_HEIGHT + TRACK_GAP;
  const totalTracksHeight = audioRowTop + sfxRowHeight;

  return (
    <div className={`flex flex-col bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden ${className ?? ""}`}>
      {/* toolbar -- the transport controls (play/pause, step, jump, loop,
          in/out, big timecode readout + keyboard-shortcut help) live HERE in
          the timeline's near bar, not as a separate strip under the preview.
          TransportBar already renders its own timecode, so we don't duplicate
          it; we drop its top border (this toolbar owns the border-b) and keep
          the zoom cluster on the far right. */}
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/60 pr-3">
        <TransportBar className="min-w-0 flex-1 !border-t-0 !bg-transparent" />
        {/* snapping magnet toggle (N) -- coral when on. */}
        <div className="flex shrink-0 items-center border-l border-neutral-800 pl-3">
          <button
            type="button"
            onClick={toggleSnap}
            aria-pressed={snapEnabled}
            title={snapEnabled ? "Snapping on (N)" : "Snapping off (N)"}
            aria-label="Toggle snapping"
            className={`grid h-7 w-7 place-items-center rounded transition-colors ${
              snapEnabled
                ? "text-[#FF6B35] hover:bg-[#FF6B35]/10"
                : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            }`}
          >
            <Magnet size={15} weight={snapEnabled ? "fill" : "regular"} />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-neutral-800 pl-3">
          <button
            type="button"
            onClick={zoomOut}
            className="p-1.5 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
            title="Zoom out"
          >
            <MagnifyingGlassMinus size={14} weight="bold" />
          </button>
          <span className="text-[10px] text-neutral-500 w-10 text-center tabular-nums">
            {Math.round(pixelsPerSecond)}px/s
          </span>
          <button
            type="button"
            onClick={zoomIn}
            className="p-1.5 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
            title="Zoom in"
          >
            <MagnifyingGlassPlus size={14} weight="bold" />
          </button>
          <button
            type="button"
            onClick={fitToWindow}
            className="p-1.5 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
            title="Fit to window (Shift+Z)"
            aria-label="Fit timeline to window"
          >
            <ArrowsOutLineHorizontal size={14} weight="bold" />
          </button>
          <button
            type="button"
            onClick={zoomToSelection}
            className="p-1.5 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
            title="Zoom to selection (Z)"
            aria-label="Zoom to selection"
          >
            <FrameCorners size={14} weight="bold" />
          </button>
        </div>
      </div>

      {/* scrollable timeline body */}
      <div
        ref={scrollRef}
        className="relative flex-1 min-h-0 overflow-x-auto overflow-y-auto"
      >
        {/* min-h-full so the row (and the content column, via flex stretch)
            fills the whole body height -- the black slack under the last track
            is then part of the content column and seeks like any dead space. */}
        <div className="flex min-h-full">
          {/* track label rail (sticky). Overlays row on top (dynamic height =
              its lane stack), then the two fixed scene tracks. Each rail cell
              matches its row's exact height + TRACK_GAP so the labels line up
              with the tracks even as the overlay stack grows. */}
          <div className="sticky left-0 z-20 flex-shrink-0 w-20 bg-neutral-950 border-r border-neutral-800">
            <div style={{ height: RULER_HEIGHT }} className="border-b border-neutral-800" />
            {/* Overlays label (violet, media-layer accent) */}
            <div
              className="flex items-start gap-1.5 px-2 pt-1 text-[11px] text-[#c4b5fd] border-b border-neutral-800/60"
              style={{ height: overlayRowHeight + TRACK_GAP }}
              title="Free-floating media overlays (drop or paste image/video)"
            >
              <Stack size={13} weight="regular" className="shrink-0 translate-y-[1px]" />
              <span className="truncate">Overlays</span>
            </div>
            {/* Unified clip-track label (Screen + Face are frame-locked, so a
                single row represents both). Carries a trailing TRACK_GAP now that
                the Audio row sits beneath it. */}
            {TRACK_LABELS.map(({ key, label, icon: Icon }) => (
              <div
                key={key}
                className="flex items-center gap-1.5 px-2 text-[11px] text-neutral-400 border-b border-neutral-800/60"
                style={{ height: TRACK_HEIGHT + TRACK_GAP }}
              >
                <Icon size={13} weight="regular" className="shrink-0" />
                <span className="truncate">{label}</span>
              </div>
            ))}
            {/* Music label (indigo, background-bed accent) -- the background
                music row, sitting between the clips and the SFX row. Carries a
                trailing TRACK_GAP (the Audio/SFX row sits beneath it). */}
            <div
              className="flex items-center gap-1.5 px-2 text-[11px] text-indigo-300 border-b border-neutral-800/60"
              style={{ height: TRACK_HEIGHT + TRACK_GAP }}
              title="Background music bed (plays under the picture)"
            >
              <MusicNote size={13} weight="regular" className="shrink-0" />
              <span className="truncate">Music</span>
            </div>
            {/* Audio label (emerald, sound-layer accent) -- the SFX row that
                plays UNDER the picture. Last row, so it carries only TRACK_HEIGHT. */}
            <div
              className="flex items-center gap-1.5 px-2 text-[11px] text-emerald-300 border-b border-neutral-800/60"
               style={{ height: sfxRowHeight }}
              title="Sound effects (plays under the picture)"
            >
              <MusicNotes size={13} weight="regular" className="shrink-0" />
              <span className="truncate">Audio</span>
            </div>
          </div>

          {/* main scrollable content. The click-to-seek scrub handler lives
              HERE, on the whole column, so EVERY dead pixel in the timeline
              body seeks: the ruler, the gaps between rows, empty row space,
              and the slack under the last track. Clips, overlays, markers,
              and the playhead handle stopPropagation on their own
              pointer-down, so their drags are untouched. */}
          <div
            className="relative"
            style={{ width: contentWidth, minHeight: RULER_HEIGHT + totalTracksHeight }}
            onClick={handleBackgroundClick}
            onPointerDown={handleScrubPointerDown}
          >
            {/* ruler */}
            <div
              className="relative border-b border-neutral-800 bg-neutral-900/40"
              style={{ height: RULER_HEIGHT }}
            >
              {ticks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 h-full flex flex-col justify-end"
                  style={{ left: timeToPx(t, pixelsPerSecond) }}
                >
                  <div className="w-px h-2 bg-neutral-600" />
                  <span className="absolute bottom-2.5 left-1 text-[9px] text-neutral-500 tabular-nums whitespace-nowrap">
                    {formatTimecode(t)}
                  </span>
                </div>
              ))}

              {/* markers -- coral pins on the ruler. Click a pin to seek to it;
                  hover reveals an X to delete it. Rendered above the ticks so
                  they read at a glance (matches CapCut/Premiere marker pins). */}
              {markers.map((m) => (
                <div
                  key={m.id}
                  className="group absolute top-0 z-20 -translate-x-1/2"
                  style={{ left: timeToPx(m.t, pixelsPerSecond) }}
                  title={m.label ? `${m.label} (${formatTimecode(m.t)})` : `Marker ${formatTimecode(m.t)}`}
                >
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlayhead(m.t);
                    }}
                    aria-label={`Seek to marker at ${formatTimecode(m.t)}`}
                    className="block"
                  >
                    <div
                      className="h-2.5 w-2.5 rotate-45 rounded-[2px] border border-white/30 shadow-sm transition-transform group-hover:scale-125"
                      style={{ backgroundColor: m.color ?? "#FF6B35" }}
                    />
                  </button>
                  {/* delete affordance -- appears on hover */}
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeMarker(m.id);
                    }}
                    aria-label="Delete marker"
                    title="Delete marker"
                    className="absolute -right-3 -top-0.5 hidden h-3.5 w-3.5 place-items-center rounded-full bg-neutral-800 text-neutral-300 hover:bg-red-600/80 hover:text-white group-hover:grid"
                  >
                    <X size={9} weight="bold" />
                  </button>
                </div>
              ))}
            </div>

            {/* tracks -- pointer-down on empty track space bubbles to the
                content column's scrub handler above (click anywhere to move the
                play mark); this div only owns the media drag-drop targets. */}
            <div
              ref={trackAreaRef}
              className="relative"
              style={{ height: totalTracksHeight }}
              onDragOver={handleTrackDragOver}
              onDragLeave={handleTrackDragLeave}
              onDrop={handleTrackDrop}
            >
              {/* OVERLAYS row -- free-floating media layers, sitting ABOVE the
                  two scene tracks (an overlay draws on top of the base composite,
                  so it reads top-to-bottom). DYNAMIC height: one sub-lane per
                  concurrent overlap (no fixed cap), packed greedily. Each block
                  is positioned by its packed lane; its z-badge shows true stacking
                  order regardless of lane. The row's background is the drop target
                  (Step 4 wires onDrop on the track area). */}
              <div
                className="absolute left-0 right-0 border-b border-[#7c5cff]/25"
                style={{ top: overlayRowTop, height: overlayRowHeight }}
              >
                {overlays.map((overlay, i) => {
                  const lane = overlayLanes[i] ?? 0;
                  const laneTop = lane * (OVERLAY_LANE_HEIGHT + OVERLAY_LANE_GAP);
                  return (
                    <OverlayBlock
                      key={overlay.id}
                      overlay={overlay}
                      left={timeToPx(overlay.timelineStart, pixelsPerSecond)}
                      width={timeToPx(overlay.timelineEnd - overlay.timelineStart, pixelsPerSecond)}
                      trackTop={laneTop}
                      trackHeight={OVERLAY_LANE_HEIGHT}
                      isSelected={selectedOverlayId === overlay.id}
                      onSelect={selectOverlay}
                      onDragBodyStart={handleOverlayBodyDragStart}
                      onDragEdgeStart={handleOverlayEdgeDragStart}
                      onDelete={removeOverlay}
                      thumbUrl={overlayThumbs.get(overlay.id) ?? null}
                    />
                  );
                })}
              </div>

              {/* UNIFIED CLIP track -- one block per scene. Screen + Face are
                  frame-locked (one source range per scene), so a single row
                  represents both; the Screen row is intentionally NOT drawn (it
                  was an identical duplicate that only hogged timeline height).
                  Each scene still holds its own static framing for BOTH regions
                  (clip.screenFraming / clip.faceFraming), authored in the preview.
                  The face-cam waveform rides on this row. Per-scene framing chips
                  below flag scenes carrying a screen and/or face framing. */}
              <div
                className="absolute left-0 right-0 border-b border-neutral-800/60"
                style={{ top: clipRowTop, height: TRACK_HEIGHT }}
              >
                {clips.map((clip) => (
                  <ClipBlock
                    key={clip.id}
                    clip={clip}
                    left={timeToPx(clip.timelineStart, pixelsPerSecond)}
                    width={
                      clip.kept
                        ? timeToPx(clip.timelineEnd - clip.timelineStart, pixelsPerSecond)
                        : 26
                    }
                    trackTop={4}
                    trackHeight={TRACK_HEIGHT - 8}
                    isSelected={selectedClipId === clip.id}
                    onSelect={selectClip}
                    onDragBodyStart={handleClipBodyDragStart}
                    onDragEdgeStart={handleClipEdgeDragStart}
                    onDelete={deleteClip}
                    onRestore={restoreClip}
                    waveform={faceWaveform}
                    words={words}
                    onWordCellClick={onWordCellClick}
                    onWordCellDoubleClick={onWordCellDoubleClick}
                    onWordRangeSelect={onWordRangeSelect}
                    selectedWordIndex={selectedWordIndex}
                    selectedWordRange={selectedWordRange}
                    playheadWordIndex={playheadWordIndex}
                  />
                ))}
                {/* per-scene framing chips -- a scene carrying its own screen
                    and/or face pan/zoom. Now that Screen + Face share one row,
                    both chips live here: the screen chip (violet, MonitorPlay)
                    and the face chip (coral, VideoCamera), side by side so a
                    scene's custom framing on either region reads at a glance.
                    Click selects the scene (framing edited in the preview). */}
                {clips.map((clip) => {
                  if (!clip.kept) return null;
                  const chips: {
                    key: string;
                    icon: typeof MonitorPlay;
                    className: string;
                    title: string;
                  }[] = [];
                  if (clip.screenFraming) {
                    chips.push({
                      key: `screenfr-${clip.id}`,
                      icon: MonitorPlay,
                      className:
                        "bg-[#7c5cff] text-neutral-950 shadow-[0_0_6px_rgba(124,92,255,0.6)] ring-1 ring-[#7c5cff]/40",
                      title: "This scene has its own screen framing (pan/zoom)",
                    });
                  }
                  if (clip.faceFraming) {
                    chips.push({
                      key: `facefr-${clip.id}`,
                      icon: VideoCamera,
                      className:
                        "bg-[#FF6B35] text-neutral-950 shadow-[0_0_6px_rgba(255,107,53,0.6)] ring-1 ring-[#FF6B35]/40",
                      title: "This scene has its own face framing (pan/zoom)",
                    });
                  }
                  if (chips.length === 0) return null;
                  const baseLeft = timeToPx(clip.timelineStart, pixelsPerSecond) + 3;
                  return chips.map((chip, ci) => {
                    const Icon = chip.icon;
                    return (
                      <button
                        key={chip.key}
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          selectClip(clip.id);
                        }}
                        className={`absolute z-30 flex h-[15px] w-[15px] items-center justify-center rounded-full transition-transform hover:scale-110 ${chip.className}`}
                        style={{ left: baseLeft + ci * 17, top: 3 }}
                        title={chip.title}
                        aria-label={chip.title}
                      >
                        <Icon size={9} weight="bold" />
                      </button>
                    );
                  });
                })}
              </div>

              {/* MUSIC row -- the background music bed, sitting between the clip
                  track and the SFX row (music plays under the picture, above the
                  SFX in stacking order here). ONE locked INDIGO block starting at
                  musicTrack.startAtSec, clamped so it never runs past the reel
                  end. Not draggable in v1 (setMusicStart exists for later). Click
                  the X to remove it. Indigo so it reads distinctly from coral
                  clips, violet overlays, and emerald SFX. */}
              <div
                className="absolute left-0 right-0 border-b border-indigo-500/25"
                style={{ top: musicRowTop, height: TRACK_HEIGHT }}
              >
                {musicTrack && (() => {
                  // The audible slice of the file: source 0..N, cut short when
                  // the reel ends before the music does. Width doubles as the
                  // waveform canvas size, so compute once here.
                  const musicSrcEnd = Math.min(
                    musicTrack.srcDuration,
                    safeDuration - musicTrack.startAtSec
                  );
                  const musicBlockWidth = Math.max(
                    timeToPx(musicSrcEnd, pixelsPerSecond),
                    6
                  );
                  return (
                  <div
                    className="group absolute flex items-center gap-1.5 overflow-hidden rounded-md border border-indigo-400/50 bg-indigo-500/20 px-2 text-[11px] font-medium text-indigo-100 shadow-[0_0_10px_rgba(99,102,241,0.25)]"
                    style={{
                      left: timeToPx(musicTrack.startAtSec, pixelsPerSecond),
                      width: musicBlockWidth,
                      top: 4,
                      height: TRACK_HEIGHT - 8,
                    }}
                    title={`Background music: ${musicTrack.name}. Plays in preview + export.`}
                  >
                    {/* Real waveform inside the block (Descript-style): darker
                        indigo ink, bottom-anchored bars, behind the label. */}
                    <TrackWaveform
                      waveform={musicWaveform}
                      srcStart={0}
                      srcEnd={musicSrcEnd}
                      width={musicBlockWidth}
                      height={TRACK_HEIGHT - 8}
                      color="#0a0824"
                    />
                    <MusicNote size={13} weight="bold" className="relative shrink-0 text-indigo-300" />
                    <span className="relative truncate">{musicTrack.name}</span>
                    {/* delete affordance -- appears on hover */}
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        clearMusicTrack();
                      }}
                      aria-label="Remove background music"
                      title="Remove background music"
                      className="absolute right-1 top-1/2 hidden h-4 w-4 -translate-y-1/2 place-items-center rounded-full bg-neutral-900/80 text-indigo-200 hover:bg-red-600/80 hover:text-white group-hover:grid"
                    >
                      <X size={10} weight="bold" />
                    </button>
                  </div>
                  );
                })()}
              </div>

              {/* AUDIO row -- editable sound-effect clips packed into mini-lanes
                  below the picture and music tracks. */}
               <div
                 data-testid="sfx-row"
                 data-sfx-focus-fallback
                 role="region"
                 aria-label="Sound effects timeline"
                 tabIndex={0}
                 className="absolute left-0 right-0 border-b border-emerald-500/25"
                 style={{ top: audioRowTop, height: sfxRowHeight }}
               >
                 {sfxDropError && (
                   <p role="alert" className="absolute left-2 top-1 z-40 max-w-[28rem] rounded bg-red-950/90 px-2 py-1 text-[10px] text-red-200">
                     {sfxDropError}
                   </p>
                 )}
                 {sfxClips.map((clip, index) => (
                   <TimelineSfxBlock
                     key={clip.id}
                     clip={clip}
                     assets={sfxAssets}
                     left={timeToPx(clip.timelineStart, pixelsPerSecond)}
                     width={timeToPx(sfxClipTimelineEnd(clip) - clip.timelineStart, pixelsPerSecond)}
                     top={(sfxLanes[index] ?? 0) * (SFX_LANE_HEIGHT + SFX_LANE_GAP)}
                     height={SFX_LANE_HEIGHT}
                      selected={selectedSfxClipId === clip.id}
                      projectDuration={duration}
                      projectEpoch={projectEpoch}
                      sourceDuration={sfxSourceDuration(clip.source)}
                      timelineStep={1 / Math.max(1, Math.round(footageMeta?.fps || 30))}
                      onSelect={selectSfxClip}
                      onMoveBy={handleSfxKeyboardMove}
                      onTrimBy={handleSfxKeyboardTrim}
                     onBodyPointerDown={handleSfxBodyDragStart}
                     onEdgePointerDown={handleSfxEdgeDragStart}
                     onDelete={deleteSfxClipAndRestoreFocus}
                   />
                 ))}
               </div>

              {/* scene-cut dividers -- a vertical line at every clip boundary
                  so each cut in the assembled short reads at a glance (matches
                  the divider-per-scene look in Descript). One line per kept
                  clip's start; the boundary at 0 is the timeline edge, skipped.
                  When the incoming clip carries a Smart transition (the default
                  on every short-reel cut), a small coral badge sits on the
                  divider -- a glanceable "motion happens here" marker, matching
                  Descript's transition chips. Badge is pointer-events friendly:
                  clicking selects that incoming clip (safe, no editor wired). */}
              {clips.map((clip) => {
                if (!clip.kept || clip.timelineStart <= 0.001) return null;
                const left = timeToPx(clip.timelineStart, pixelsPerSecond);
                const hasTransition =
                  clip.transitionIn != null && clip.transitionIn.type !== "none";
                return (
                  <div key={`cut-${clip.id}`}>
                    <div
                      className="absolute top-0 bottom-0 w-px bg-neutral-600/70 pointer-events-none z-20"
                      style={{ left }}
                      title="Scene cut"
                    />
                    {hasTransition && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          selectClip(clip.id);
                        }}
                        className="absolute z-30 flex h-[15px] w-[15px] -translate-x-1/2 items-center justify-center rounded-full bg-[#FF6B35] text-neutral-950 shadow-[0_0_6px_rgba(255,107,53,0.6)] ring-1 ring-[#FF6B35]/40 transition-transform hover:scale-110"
                        style={{ left, top: 3 }}
                        title="Smart transition"
                        aria-label="Smart transition"
                      >
                        <ArrowsLeftRight size={9} weight="bold" />
                      </button>
                    )}
                  </div>
                );
              })}

              {/* marker guide lines -- a faint coral line down the tracks under
                  each ruler pin, so a marker is visible against the clips. */}
              {markers.map((m) => (
                <div
                  key={`mkline-${m.id}`}
                  className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
                  style={{
                    left: timeToPx(m.t, pixelsPerSecond),
                    backgroundColor: `${m.color ?? "#FF6B35"}55`,
                  }}
                />
              ))}

              {/* snap guide */}
              {snapGuideX !== null && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-[#34E8BB] pointer-events-none z-30"
                  style={{ left: snapGuideX }}
                />
              )}

              {/* media-drop indicator -- a coral line marking where a dragged
                  image/video overlay would start (snapped). Shown only while a
                  file is being dragged over the tracks. */}
              {dropIndicatorX !== null && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-40 w-0.5 -translate-x-1/2 bg-[#FF6B35] shadow-[0_0_8px_rgba(255,107,53,0.8)]"
                  style={{ left: dropIndicatorX }}
                >
                  <div className="absolute -top-0.5 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-[#FF6B35]" />
                </div>
              )}

              {/* playhead -- the LINE is pointer-events-none so it never blocks a
                  click on a clip beneath it, but the HANDLE (diamond + an
                  invisible wider hit strip) is grabbable: pointer-down on it drags
                  the play mark from its current spot (no jump). z-50 so the handle
                  sits above clips/keyframes and is always the thing you grab at the
                  play mark. */}
              <div
                className="absolute top-0 bottom-0 w-px bg-[#FF6B35] pointer-events-none z-40"
                style={{ left: playheadPx }}
              >
                {/* grab handle: the visible diamond + a padded transparent hit
                    area (easier to grab than a 1px line). Default cursor by
                    Manthan's call -- no per-element cursor morphing in the
                    timeline. touch-none so a touch/pen drag scrubs instead of
                    scrolling. */}
                <div
                  role="slider"
                  aria-label="Playhead"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration * 100) / 100}
                  aria-valuenow={Math.round(playhead * 100) / 100}
                  tabIndex={0}
                  onPointerDown={handlePlayheadPointerDown}
                  onClick={(e) => e.stopPropagation()}
                  className="pointer-events-auto absolute -top-1 -left-2 z-50 flex h-4 w-4 touch-none items-start justify-center"
                >
                  <div className="h-[11px] w-[11px] rotate-45 bg-[#FF6B35]" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineSfxBlock({
  clip,
  assets,
  ...props
}: {
  clip: SfxClip;
  assets: SfxAsset[];
  left: number;
  width: number;
  top: number;
  height: number;
  selected: boolean;
  projectDuration: number;
  projectEpoch: number;
  sourceDuration: number;
  timelineStep: number;
  onSelect: (id: string) => void;
  onMoveBy: (id: string, delta: number) => void;
  onTrimBy: (id: string, edge: "start" | "end", delta: number) => void;
  onBodyPointerDown: (clip: SfxClip, clientX: number) => void;
  onEdgePointerDown: (clip: SfxClip, edge: "start" | "end", clientX: number) => void;
  onDelete: (id: string) => void;
}) {
  const source = resolveSfxSource(clip.source, assets);
  const waveform = useSfxWaveform(source.url, props.selected, props.projectEpoch);
  return <SfxClipBlock clip={clip} missing={source.missing} waveform={waveform} {...props} />;
}


// ===========================================================================
// TrackWaveform -- Descript-style waveform INSIDE an audio bed block
// ===========================================================================
// Draws the decoded peaks for one Music/SFX block as bottom-anchored bars in a
// darker shade of the track's own hue (the reference look: dark wave on the
// tinted slab). Canvas redraws only when the block's pixel size or the sampled
// peaks change -- never per frame. pointer-events-none + behind the label chip
// so it is purely decorative. Renders nothing until peaks exist (block shows
// its plain tint while decoding, exactly as before).
function TrackWaveform({
  waveform,
  srcStart,
  srcEnd,
  width,
  height,
  color,
}: {
  waveform: FaceWaveform | null;
  /** Source-seconds range of the audio file this block represents. */
  srcStart: number;
  srcEnd: number;
  /** Block CSS pixel size (canvas backs it at DPR). */
  width: number;
  height: number;
  /** Bar ink -- a DARKER shade of the block hue, e.g. emerald-950/indigo-950. */
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // One bin per ~2 CSS px (same density as the face clips' ClipWaveform).
  const outBins = Math.max(4, Math.round(width / 2));
  const peaks = useMemo(
    () => sliceClipPeaks(waveform, srcStart, srcEnd, outBins),
    [waveform, srcStart, srcEnd, outBins]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    // Browsers cap a canvas dimension at ~32767px and this block spans the WHOLE
    // reel: 60s at max zoom (400px/s) on a 2x display = 48,000 backing px --
    // past the cap the canvas silently allocates nothing and the waveform
    // vanishes. Clamp the backing scale so width stays comfortably under it;
    // bars get slightly softer at extreme zoom instead of disappearing.
    const scale = Math.min(dpr, 16384 / w);
    canvas.width = Math.max(1, Math.floor(w * scale));
    canvas.height = Math.max(1, Math.floor(h * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (peaks.length === 0) return;

    // Bottom-anchored bars (the Descript audio-bed look) -- baseline sits on the
    // block floor, peaks grow upward. Hair of headroom so loud peaks never kiss
    // the top border.
    const maxAmp = h - 3;
    const barW = w / peaks.length;

    ctx.fillStyle = color;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(1, peaks[i] * maxAmp);
      const x = i * barW;
      ctx.fillRect(x, h - amp, Math.max(1, barW * 0.7), amp);
    }
  }, [peaks, width, height, color]);

  if (peaks.length === 0) return null;

  return (
    // Explicit CSS width (the audible span) instead of w-full: when the audio
    // file is SHORTER than its block (reel grew after the SFX render), the
    // bars must stop at the real audio end, not stretch across the silence.
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute left-0 top-0 h-full rounded-md opacity-60"
      style={{ width }}
      aria-hidden
    />
  );
}
