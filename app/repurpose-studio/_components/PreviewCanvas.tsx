"use client";

// ===========================================================================
// REPURPOSE STUDIO -- PreviewCanvas
// ===========================================================================
// The live 1080x1920 vertical compositor preview. Owns:
//   - SLOT_COUNT hidden <video> elements per source: an ACTIVE screen+face
//     pair (frame-locked, seeked to the same source time) that the compositor
//     paints, plus STANDBY pairs pre-seeked to the next discontinuous cuts'
//     source in-points so a real cut is an element SWAP, not a live seek --
//     and a rapid double-cut is TWO warm swaps (see preview-preseek).
//   - A DPR-correct <canvas> that calls the pure `drawFrame` (lib/repurpose/
//     compositor.ts) every rAF / store change to composite screen (top) +
//     face (bottom) per the current splitRatio and pan/zoom keyframes.
//   - A draggable split-handle overlay (drag to change splitRatio across its
//     full range, with endpoint snapping).
//   - Per-region drag-to-pan and scroll-to-zoom, which write a new pan/zoom
//     keyframe at the current playhead for that track.
//
// No footage yet -> `drawFrame` draws labeled "SCREEN"/"FACE" placeholder
// rectangles so the split-screen layout is visible standalone (see
// PreviewPanelPlaceholder in ../page.tsx, which this component replaces).
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setupCrispCanvas } from "@/lib/engine/crisp-canvas";
import {
  drawFrame,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  type RegionSource,
  type OverlayDraw,
} from "@/lib/repurpose/compositor";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { synchronizeMediaTime } from "@/lib/repurpose/media-sync";
import {
  BASE_MEDIA_DRIFT_TOLERANCE_SEC,
  EXTERNAL_SEEK_TOLERANCE_SEC,
  OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC,
  reanchorTransport,
  sampleTransport,
  startTransport,
  type TransportAnchor,
} from "@/lib/repurpose/transport-clock";
import {
  timelineToSourceTime,
  transitionProgressAt,
  splitRatioAt,
  screenFramingAt,
  faceFramingAt,
  punchScaleAt,
} from "@/lib/repurpose/time-map";
import { gradeFilter } from "@/lib/repurpose/color-grade";
import {
  activeCaptionBlockAt,
  drawCaptions,
  type CaptionBlock,
  type CaptionLayout,
  type CaptionStyle,
} from "@/lib/repurpose/captions";
import { loadCaptionFonts } from "@/lib/repurpose/caption-fonts";
import type { Clip, Overlay } from "@/lib/repurpose/types";
import {
  CONTIGUOUS_CUT_EPSILON,
  nextDiscontinuousCutsAfter,
  StandbySeeker,
} from "@/lib/repurpose/preview-preseek";
import type { PreviewRect } from "@/lib/repurpose/overlay-geometry";
import {
  isOverlayBandVisible,
  resolveEffectivePrimaryOverlay,
} from "@/lib/repurpose/overlay-geometry";
import {
  resolveOverlayAppearanceAt,
  type OverlayFrameSnapshot,
} from "@/lib/repurpose/overlay-effects";
import {
  clampSplitRatio,
  effectiveSplitRatio,
  snapPointerSplitRatio,
} from "@/lib/repurpose/split-ratio";
import { GhostOverflowLayer } from "./GhostOverflowLayer";
import { SnapGuides } from "./SnapGuides";
import { useObjectSelection } from "./useObjectSelection";
import { useDeselectOnOutsideClick } from "./useDeselectOnOutsideClick";
import { useSfxPreview, useMusicPreview } from "./useSfxPreview";
import { useVideoProxy } from "./useVideoProxy";
import { SelectionOverlay } from "./SelectionOverlay";
import { SelectionToolbar } from "./SelectionToolbar";

// Output <-> source time mapping lives in lib/repurpose/time-map.ts so the
// preview, the exporter, and the store's keyframe-ripple remap all share ONE
// implementation. `timelineToSourceTime` there uses a half-open
// [timelineStart, timelineEnd) boundary, so a frame landing exactly on a cut
// belongs to the incoming clip (no one-frame flash of the outgoing tail).

/** Output resolution the canvas is backed by (export-matching). Overridable for tests/storybook. */
export interface PreviewCanvasProps {
  /** Output width in px. Default 1080. */
  width?: number;
  /** Output height in px. Default 1920. */
  height?: number;
  /** Extra className applied to the outer wrapper (sizing/positioning is the caller's job). */
  className?: string;
  /** Test/dev injection for deterministic monotonic-frame scheduling. */
  frameScheduler?: PreviewFrameScheduler;
}

export interface PreviewFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
  now(): number;
}

const BROWSER_FRAME_SCHEDULER: PreviewFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
};

const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const BASE_MEDIA_LOAD_ERROR =
  "Chrome could not load this video. Re-import it to create a compatible copy.";
const BASE_MEDIA_PLAY_ERROR =
  "Chrome could not start this video. Re-import it to create a compatible copy.";
const BASE_MEDIA_FUTURE_DATA = 3;

interface OverlayFailure {
  id: string;
  src: string;
  reason: string;
  wasActive: boolean;
}

function overlayFailureKey(id: string, src: string): string {
  return `${id}\u0000${src}`;
}

// Size of the double-buffer video pool PER SOURCE: 1 active pair +
// (SLOT_COUNT - 1) standby pairs. Depth 2 means the NEXT cut *and* the cut
// AFTER it are both pre-seeked, so a rapid double-cut (<1s apart) is two warm
// swaps -- with a single standby the freed pair never re-seeked in time and
// the second cut fell back to the ~1s hard-seek freeze. Bump this if
// machine-gun triple-cuts ever hiccup; each +1 costs two more hidden <video>s.
const SLOT_COUNT = 3;
const STANDBY_DEPTH = SLOT_COUNT - 1;
const SLOT_INDICES = Array.from({ length: SLOT_COUNT }, (_, i) => i);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The kept clip whose output span [timelineStart, timelineEnd) contains t, or null. */
function activeClipAt(clips: readonly Clip[], t: number): Clip | null {
  let lastKept: Clip | null = null;
  for (const clip of clips) {
    if (!clip.kept) continue;
    lastKept = clip;
    if (t >= clip.timelineStart && t < clip.timelineEnd) return clip;
  }
  // At/just past the very end, the last kept clip is still the active one.
  if (lastKept && t >= lastKept.timelineEnd) return lastKept;
  return null;
}

// A cut is "contiguous" when the next kept clip resumes the SAME source file at
// (essentially) the same source time the current clip ends -- i.e. no retake was
// trimmed out between them and nothing was reordered. In that case the source
// videos are ALREADY decoding the exact frames the next clip wants, so the
// hard-seek at the cut is pure waste: on a streaming range-request source it
// stalls playback for ~1s (seek -> rebuffer -> resume) while the last frame
// freezes on screen. Skipping the seek here is what makes scene changes instant.
// CONTIGUOUS_CUT_EPSILON (one frame of slack for float error in back-to-back
// srcEnd/srcStart) now lives in lib/repurpose/preview-preseek.ts -- the single
// source of truth shared with nextDiscontinuousCutsAfter, which uses the SAME
// test to decide which upcoming cuts the standby pool should pre-seek to.

/** Drag/zoom interaction state for one region (screen or face). */
interface RegionDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startTransform: { x: number; y: number; scale: number };
}

interface SplitDividerGesture {
  pointerId: number;
  token: string;
  element: HTMLDivElement;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
}

interface CaptionPointerGesture {
  pointerId: number;
  token: string;
  element: HTMLDivElement;
  blockId: string;
  sourceFrame: number;
  startClientY: number;
  cssHeight: number;
  startAnchorY: number;
  finalAnchorY: number;
  anchorRange: { min: number; max: number };
  settledSplit: number;
  attachedTargetAnchorY: number | null;
  activated: boolean;
  snapped: boolean;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
}

interface CaptionFrameLayout {
  layout: CaptionLayout;
  outputTime: number;
  sourceTime: number;
  renderedSplit: number;
  settledSplit: number;
  projectEpoch: number;
  captionStyle: CaptionStyle;
  captionBlocks: CaptionBlock[];
  clips: Clip[];
  keyboardPlacement: {
    attached: boolean;
    requestedPositionYPct: number;
  } | null;
}

function updateCaptionSliderValue(
  target: HTMLDivElement,
  requestedPositionYPct: number,
  attached: boolean
): void {
  const value = Math.round(
    Math.max(0, Math.min(1, requestedPositionYPct)) * 100
  );
  target.setAttribute("aria-valuenow", String(value));
  target.setAttribute(
    "aria-valuetext",
    `${attached ? "Attached to split" : "Detached"} at ${value}%`
  );
}

function PreviewOverlayVideo({
  overlay,
  isPlaying,
  register,
  reportFailure,
}: {
  overlay: Overlay;
  isPlaying: boolean;
  register: (element: HTMLVideoElement | null, previewSrc: string) => void;
  reportFailure: () => void;
}) {
  const proxy = useVideoProxy({
    target: { kind: "overlay", id: overlay.id },
    source: overlay.videoSource,
    fallbackSrc: overlay.src,
    durationSec: overlay.srcDuration,
    isPlaying,
  });
  const previewSrc = proxy.src ?? overlay.src;

  return (
    <video
      data-overlay-id={overlay.id}
      data-overlay-src={previewSrc}
      ref={(element) => register(element, previewSrc)}
      src={previewSrc}
      muted
      playsInline
      preload="auto"
      className="hidden"
      onError={() => {
        if (proxy.usingProxy) proxy.onSrcError();
        else reportFailure();
      }}
      onLoadedMetadata={(event) => {
        const element = event.currentTarget;
        if (element.videoWidth <= 0 || element.videoHeight <= 0) return;
        const current = useRepurposeStore
          .getState()
          .overlays.find(
            (candidate) =>
              candidate.id === overlay.id && candidate.src === overlay.src
          );
        if (current && (current.naturalWidth <= 0 || current.naturalHeight <= 0)) {
          useRepurposeStore.setState((state) => ({
            overlays: state.overlays.map((candidate) =>
              candidate.id === overlay.id
                ? {
                    ...candidate,
                    naturalWidth: element.videoWidth,
                    naturalHeight: element.videoHeight,
                  }
                : candidate
            ),
          }));
        }
      }}
    />
  );
}

/**
 * Live 1080x1920 split-screen compositor preview. Renders the current frame
 * via the pure `drawFrame` module, and exposes drag-to-pan / scroll-to-zoom /
 * drag-the-split-handle interactions that write back to `useRepurposeStore`.
 */
export function PreviewCanvas({
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  className,
  frameScheduler = BROWSER_FRAME_SCHEDULER,
}: PreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The consolidated interaction-layer div -- held so the wheel-zoom handler can
  // be attached as a NON-PASSIVE native listener (React's onWheel is passive).
  const interactionLayerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // DOUBLE-BUFFERED base videos: SLOT_COUNT
  // hidden <video> slots per source file, ordered by slotOrderRef -- a ring
  // where order[0] is the ACTIVE pair (the compositor paints it and the face
  // element of that pair carries audio) and order[1..] are
  // the STANDBY pairs: paused, pre-seeked (by the StandbySeekers below) to the
  // next STANDBY_DEPTH discontinuous cuts' source in-points. Crossing a cut
  // ROTATES the ring (order[1] promotes to active, the freed active goes to
  // the back and re-targets the farthest tracked cut) instead of hard-seeking
  // the big raw file over the byte-range stream (~1s freeze). Ref callbacks in
  // the JSX write the slots; slotOrderRef is a ref (not state) because a swap
  // happens inside the rAF loop and must not trigger a React render.
  const screenElsRef = useRef<(HTMLVideoElement | null)[]>(
    Array(SLOT_COUNT).fill(null)
  );
  const faceElsRef = useRef<(HTMLVideoElement | null)[]>(
    Array(SLOT_COUNT).fill(null)
  );
  const slotOrderRef = useRef<number[]>([...SLOT_INDICES]);
  const activeScreen = useCallback(
    () => screenElsRef.current[slotOrderRef.current[0]],
    []
  );
  const activeFace = useCallback(
    () => faceElsRef.current[slotOrderRef.current[0]],
    []
  );
  const normalizeBaseMute = useCallback(() => {
    const activeSlot = slotOrderRef.current[0];
    for (const video of screenElsRef.current) {
      if (video) video.muted = true;
    }
    for (const [slot, video] of faceElsRef.current.entries()) {
      if (video) video.muted = slot !== activeSlot;
    }
  }, []);
  // Serialized pre-seek managers, one per STANDBY ring position (k = 0 parks
  // at the next cut, k = 1 at the cut after, ...). getEl() is resolved fresh
  // on every call because WHICH element sits at each position rotates at every
  // swap; StandbySeeker rebinds itself when the resolved element changes.
  const faceSeekersRef = useRef<StandbySeeker[] | null>(null);
  const screenSeekersRef = useRef<StandbySeeker[] | null>(null);
  if (!faceSeekersRef.current) {
    faceSeekersRef.current = Array.from(
      { length: STANDBY_DEPTH },
      (_, k) =>
        new StandbySeeker(() => faceElsRef.current[slotOrderRef.current[k + 1]])
    );
  }
  if (!screenSeekersRef.current) {
    screenSeekersRef.current = Array.from(
      { length: STANDBY_DEPTH },
      (_, k) =>
        new StandbySeeker(
          () => screenElsRef.current[slotOrderRef.current[k + 1]]
        )
    );
  }
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  // The sole playback authority: output time sampled from one monotonic anchor.
  // Media currentTime values are followers and may only be drift-corrected.
  const transportAnchorRef = useRef<TransportAnchor | null>(null);
  const transportGenerationRef = useRef(0);
  const playbackAttemptRef = useRef(0);
  const transportConfirmedRef = useRef(false);
  const sourceIdentityRef = useRef("");
  const screenSourceIdentityRef = useRef("");
  const faceSourceIdentityRef = useRef("");
  const screenWorkingSourceIdentityRef = useRef("");
  const mountedRef = useRef(true);
  const overlayPlaybackSessionRef = useRef(0);
  const overlayPlaybackAttemptRef = useRef(0);
  const overlayPlayPendingRef = useRef<
    Map<
      string,
      {
        attempt: number;
        session: number;
        video: HTMLVideoElement;
        src: string;
      }
    >
  >(new Map());
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const overlayFailuresRef = useRef<Map<string, OverlayFailure>>(new Map());
  const blockedOverlayFailureRef = useRef<string | null>(null);
  const baseReadinessRef = useRef({
    sourceIdentity: "",
    screenErrorReason: null as string | null,
    faceErrorReason: null as string | null,
    playbackErrorReason: null as string | null,
    screenReady: false,
    faceReady: false,
  });
  // The last output time written by the transport. A larger mismatch means an
  // external timeline/transcript seek, which re-anchors before the next sample.
  const expectedPlayheadRef = useRef<number | null>(null);
  // The settled per-frame split, excluding direct divider manipulation. Mutation
  // paths read only this ref; visual paths may layer transientSplitRef over it.
  const liveSplitRef = useRef<number>(0.5);
  const transientSplitRef = useRef<number | null>(null);
  const splitGestureRef = useRef<SplitDividerGesture | null>(null);
  const splitGestureStoreUpdateRef = useRef(false);
  const captionLayoutRef = useRef<CaptionLayout | null>(null);
  const captionFrameRef = useRef<CaptionFrameLayout | null>(null);
  const captionHitTargetRef = useRef<HTMLDivElement>(null);
  const captionSnapGuideRef = useRef<HTMLDivElement>(null);
  const captionTransientPositionRef = useRef<{
    blockId: string;
    positionYPct: number;
  } | null>(null);
  const captionGestureRef = useRef<CaptionPointerGesture | null>(null);
  const [handleSplit, setHandleSplit] = useState<number>(0.5);
  const handleSplitRef = useRef<number>(0.5);
  const getEffectiveSplitRatio = useCallback(
    () =>
      effectiveSplitRatio(
        transientSplitRef.current ?? liveSplitRef.current,
        height
      ),
    [height]
  );
  const getSettledSplitRatio = useCallback(() => liveSplitRef.current, []);
  const overlayFrameSnapshotRef = useRef<OverlayFrameSnapshot | null>(null);
  const getOverlayFrameSnapshot = useCallback(
    () => overlayFrameSnapshotRef.current,
    []
  );
  const publishCaptionLayout = useCallback(
    (layout: CaptionLayout | null) => {
      captionLayoutRef.current = layout;
      const target = captionHitTargetRef.current;
      const container = containerRef.current;
      if (!target || !container || !layout) {
        if (target) {
          target.hidden = true;
          target.style.pointerEvents = "none";
          target.style.cursor = "";
        }
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        target.hidden = true;
        target.style.pointerEvents = "none";
        target.style.cursor = "";
        return;
      }
      const bounds = layout.visualBounds;
      target.style.left = `${(bounds.left / width) * rect.width}px`;
      target.style.top = `${(bounds.top / height) * rect.height}px`;
      target.style.width = `${((bounds.right - bounds.left) / width) * rect.width}px`;
      target.style.height = `${((bounds.bottom - bounds.top) / height) * rect.height}px`;
      target.style.pointerEvents = "auto";
      target.style.cursor = "ns-resize";
      updateCaptionSliderValue(
        target,
        layout.requestedAnchorY / height,
        layout.style.pinToSplit
      );
      target.hidden = false;
    },
    [height, width]
  );
  const hideCaptionSnapGuide = useCallback(() => {
    const guide = captionSnapGuideRef.current;
    if (guide) guide.hidden = true;
  }, []);
  // Alignment grid (rule-of-thirds + center crosshair) to eyeball-center an
  // overlay. Toggled from the top bar (store-owned so the navbar button and this
  // preview share one source of truth). DOM-only -- it is a sibling above the
  // canvas, so it NEVER bakes into the exported frames.
  const showGrid = useRepurposeStore((s) => s.showGrid);

  // Whether Cmd/Ctrl is currently held, so the interaction layer shows a `copy`
  // cursor -- the affordance that a drag now CLONES the overlay (matches Figma).
  const [cloneModifier, setCloneModifier] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setCloneModifier(e.metaKey || e.ctrlKey);
    const onBlur = () => setCloneModifier(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const splitRatio = useRepurposeStore((s) => s.splitRatio);
  const setClipFaceFraming = useRepurposeStore((s) => s.setClipFaceFraming);
  const setClipScreenFraming = useRepurposeStore((s) => s.setClipScreenFraming);
  const playhead = useRepurposeStore((s) => s.playhead);
  const clips = useRepurposeStore((s) => s.clips);
  const footageMeta = useRepurposeStore((s) => s.footageMeta);
  const duration = useRepurposeStore((s) => s.duration);
  const isPlaying = useRepurposeStore((s) => s.isPlaying);
  const playbackRate = useRepurposeStore((s) => s.playbackRate);
  const inPoint = useRepurposeStore((s) => s.inPoint);
  const outPoint = useRepurposeStore((s) => s.outPoint);
  const loopPlayback = useRepurposeStore((s) => s.loopPlayback);
  const screenGrade = useRepurposeStore((s) => s.screenGrade);
  const faceGrade = useRepurposeStore((s) => s.faceGrade);
  const captionsEnabled = useRepurposeStore((s) => s.captionsEnabled);
  const captionStyle = useRepurposeStore((s) => s.captionStyle);
  const captionBlocks = useRepurposeStore((s) => s.captionBlocks);
  const overlays = useRepurposeStore((s) => s.overlays);
  const sourceImportActive = useRepurposeStore(
    (s) =>
      s.sourceImportOwners.screen !== null ||
      s.sourceImportOwners.face !== null
  );
  const setPlayhead = useRepurposeStore((s) => s.setPlayhead);
  const pause = useRepurposeStore((s) => s.pause);
  const setMediaReadiness = useRepurposeStore((s) => s.setMediaReadiness);

  // Make the generated SFX bed audible during live preview, synced to the
  // playhead and summing acoustically with the face-cam <video> audio.
  const sfxTrack = useRepurposeStore((s) => s.sfxTrack);
  useSfxPreview(sfxTrack);
  const musicTrack = useRepurposeStore((s) => s.musicTrack);
  useMusicPreview(musicTrack);

  const screenProxy = useVideoProxy({
    target: { kind: "footage", role: "screen" },
    source: footageMeta?.screenSource,
    fallbackSrc: footageMeta?.screenPath || undefined,
    durationSec: footageMeta?.durationSec,
    isPlaying,
  });
  const faceProxy = useVideoProxy({
    target: { kind: "footage", role: "face" },
    source: footageMeta?.faceCamSource,
    fallbackSrc: footageMeta?.faceCamPath || undefined,
    durationSec: footageMeta?.durationSec,
    isPlaying,
  });
  const screenSourceIdentity = screenProxy.src ?? "";
  const faceSourceIdentity = faceProxy.src ?? "";
  const baseSourceIdentity = `${screenSourceIdentity}\u0000${faceSourceIdentity}`;
  const screenWorkingSourceIdentity = footageMeta?.screenSource
    ? `${footageMeta.screenSource.workingPath}\u0000${footageMeta.screenSource.inspection.fingerprint}`
    : footageMeta?.screenPath ?? "";

  const reconcileMediaReadiness = useCallback(() => {
    const state = useRepurposeStore.getState();
    if (
      state.sourceImportOwners.screen !== null ||
      state.sourceImportOwners.face !== null
    ) {
      return;
    }
    let activeOverlayFailure: [string, OverlayFailure] | null = null;
    for (const [key, failure] of overlayFailuresRef.current) {
      const overlay = state.overlays.find(
        (candidate) =>
          candidate.id === failure.id &&
          candidate.kind === "video" &&
          candidate.src === failure.src
      );
      if (!overlay) {
        overlayFailuresRef.current.delete(key);
        continue;
      }
      const isActive =
        state.playhead >= overlay.timelineStart &&
        state.playhead < overlay.timelineEnd;
      if (isActive) {
        failure.wasActive = true;
        activeOverlayFailure ??= [key, failure];
      } else if (failure.wasActive) {
        overlayFailuresRef.current.delete(key);
      }
    }

    const cycle = baseReadinessRef.current;
    const baseErrorReason =
      cycle.playbackErrorReason ??
      cycle.screenErrorReason ??
      cycle.faceErrorReason;
    if (
      cycle.sourceIdentity === sourceIdentityRef.current &&
      baseErrorReason
    ) {
      setMediaReadiness("error", baseErrorReason);
      return;
    }
    if (activeOverlayFailure) {
      const [key, failure] = activeOverlayFailure;
      blockedOverlayFailureRef.current = key;
      pause();
      setMediaReadiness("error", failure.reason);
      return;
    }

    blockedOverlayFailureRef.current = null;
    if (!screenSourceIdentity || !faceSourceIdentity) {
      setMediaReadiness("idle");
      return;
    }
    setMediaReadiness(
      cycle.screenReady && cycle.faceReady ? "ready" : "loading"
    );
  }, [faceSourceIdentity, pause, screenSourceIdentity, setMediaReadiness]);

  const reportBaseCanPlay = useCallback(
    (
      role: "screen" | "face",
      slot: number,
      video: HTMLVideoElement
    ) => {
      const cycle = baseReadinessRef.current;
      if (
        cycle.sourceIdentity !== sourceIdentityRef.current ||
        slotOrderRef.current[0] !== slot ||
        video.readyState < BASE_MEDIA_FUTURE_DATA ||
        video.videoWidth <= 0 ||
        video.videoHeight <= 0
      )
        return;

      if (role === "screen") cycle.screenReady = true;
      else cycle.faceReady = true;
      reconcileMediaReadiness();
    },
    [reconcileMediaReadiness]
  );

  const reportRequiredBaseError = useCallback(
    (role: "screen" | "face", slot: number) => {
      if (slotOrderRef.current[0] !== slot) {
        const standbyIndex = slotOrderRef.current.indexOf(slot) - 1;
        if (standbyIndex >= 0) {
          const seekers =
            role === "screen" ? screenSeekersRef.current : faceSeekersRef.current;
          seekers?.[standbyIndex]?.reset();
        }
        return;
      }
      const cycle = baseReadinessRef.current;
      if (
        cycle.sourceIdentity !== sourceIdentityRef.current ||
        (role === "screen"
          ? cycle.screenErrorReason !== null
          : cycle.faceErrorReason !== null)
      )
        return;
      if (role === "screen") cycle.screenErrorReason = BASE_MEDIA_LOAD_ERROR;
      else cycle.faceErrorReason = BASE_MEDIA_LOAD_ERROR;
      pause();
      reconcileMediaReadiness();
    },
    [pause, reconcileMediaReadiness]
  );

  // Keep latest store values in refs so the rAF loop (mounted once) always
  // reads current state without re-subscribing the loop itself. The loop is
  // both the renderer AND the playback clock, so it needs the playback flags
  // (isPlaying / in-out region / loop) and the grades on top of the draw state.
  const liveRef = useRef({
    splitRatio,
    playhead,
    clips,
    duration,
    isPlaying,
    playbackRate,
    inPoint,
    outPoint,
    loopPlayback,
    screenGrade,
    faceGrade,
    captionsEnabled,
    captionStyle,
    captionBlocks,
    overlays,
  });
  useEffect(() => {
    liveRef.current = {
      splitRatio,
      playhead,
      clips,
      duration,
      isPlaying,
      playbackRate,
      inPoint,
      outPoint,
      loopPlayback,
      screenGrade,
      faceGrade,
      captionsEnabled,
      captionStyle,
      captionBlocks,
      overlays,
    };
  }, [
    splitRatio,
    playhead,
    clips,
    duration,
    isPlaying,
    playbackRate,
    inPoint,
    outPoint,
    loopPlayback,
    screenGrade,
    faceGrade,
    captionsEnabled,
    captionStyle,
    captionBlocks,
    overlays,
  ]);

  const invalidatePlaybackAttempt = useCallback(() => {
    playbackAttemptRef.current += 1;
    transportConfirmedRef.current = false;
    transportAnchorRef.current = null;
    expectedPlayheadRef.current = null;
  }, []);

  const invalidateOverlayPlayback = useCallback(() => {
    overlayPlaybackSessionRef.current += 1;
    overlayPlayPendingRef.current.clear();
  }, []);

  const playRequiredBaseMedia = useCallback(
    (
      screenVideo: HTMLVideoElement | null,
      faceVideo: HTMLVideoElement | null,
      preferredOutput?: number
    ): number | null => {
      invalidatePlaybackAttempt();
      if (!screenVideo || !faceVideo) return null;
      const attempt = playbackAttemptRef.current;
      const sourceIdentity = sourceIdentityRef.current;
      const failRequiredBaseMedia = () => {
        const owners = useRepurposeStore.getState().sourceImportOwners;
        if (owners.screen !== null || owners.face !== null) return;
        const stillCurrent =
          mountedRef.current &&
          playbackAttemptRef.current === attempt &&
          sourceIdentityRef.current === sourceIdentity &&
          useRepurposeStore.getState().isPlaying;
        if (!stillCurrent) return;
        const cycle = baseReadinessRef.current;
        if (cycle.sourceIdentity === sourceIdentity) {
          cycle.playbackErrorReason = BASE_MEDIA_PLAY_ERROR;
        }
        screenVideo.pause();
        faceVideo.pause();
        pause();
        reconcileMediaReadiness();
      };
      const playPromises = [screenVideo, faceVideo].map((video) => {
        try {
          return Promise.resolve(video.play());
        } catch (error) {
          return Promise.reject(error);
        }
      });
      for (const playPromise of playPromises) {
        void playPromise.catch(failRequiredBaseMedia);
      }

      void Promise.allSettled(playPromises).then((results) => {
        const stillCurrent =
          mountedRef.current &&
          playbackAttemptRef.current === attempt &&
          sourceIdentityRef.current === sourceIdentity &&
          useRepurposeStore.getState().isPlaying;
        if (!stillCurrent) return;

        if (results.some((result) => result.status === "rejected")) {
          failRequiredBaseMedia();
          return;
        }

        const state = useRepurposeStore.getState();
        const outputSec = preferredOutput ?? state.playhead;
        const rate = state.playbackRate > 0 ? state.playbackRate : 1;
        transportAnchorRef.current = startTransport(
          outputSec,
          frameScheduler.now(),
          rate,
          ++transportGenerationRef.current
        );
        expectedPlayheadRef.current = outputSec;
        transportConfirmedRef.current = true;
      });
      return attempt;
    },
    [
      frameScheduler,
      invalidatePlaybackAttempt,
      pause,
      reconcileMediaReadiness,
    ]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateOverlayPlayback();
      invalidatePlaybackAttempt();
    };
  }, [invalidateOverlayPlayback, invalidatePlaybackAttempt]);

  useEffect(() => {
    const previousCycle = baseReadinessRef.current;
    const screenChanged =
      screenSourceIdentityRef.current !== screenSourceIdentity;
    const faceChanged = faceSourceIdentityRef.current !== faceSourceIdentity;
    const screenWorkingChanged =
      screenWorkingSourceIdentityRef.current !== screenWorkingSourceIdentity;
    screenSourceIdentityRef.current = screenSourceIdentity;
    faceSourceIdentityRef.current = faceSourceIdentity;
    screenWorkingSourceIdentityRef.current = screenWorkingSourceIdentity;
    sourceIdentityRef.current = baseSourceIdentity;
    baseReadinessRef.current = {
      sourceIdentity: baseSourceIdentity,
      screenErrorReason: screenChanged
        ? null
        : previousCycle.screenErrorReason,
      faceErrorReason: faceChanged ? null : previousCycle.faceErrorReason,
      playbackErrorReason:
        screenChanged || faceChanged
          ? null
          : previousCycle.playbackErrorReason,
      screenReady: screenChanged ? false : previousCycle.screenReady,
      faceReady: faceChanged ? false : previousCycle.faceReady,
    };
    if (screenWorkingChanged) {
      slotOrderRef.current = [...SLOT_INDICES];
      faceSeekersRef.current?.forEach((seeker) => seeker.reset());
      screenSeekersRef.current?.forEach((seeker) => seeker.reset());
    } else {
      if (faceChanged) {
        faceSeekersRef.current?.forEach((seeker) => seeker.reset());
      }
      if (screenChanged) {
        screenSeekersRef.current?.forEach((seeker) => seeker.reset());
      }
    }
    if (screenChanged || faceChanged) {
      const live = liveRef.current;
      const srcTime = timelineToSourceTime(live.clips, live.playhead);
      const sourceIdentity = baseSourceIdentity;
      const seekActive = (
        role: "screen" | "face",
        video: HTMLVideoElement | null
      ) => {
        if (!video || srcTime === null) return;
        const apply = () => {
          const current = role === "screen" ? activeScreen() : activeFace();
          if (
            sourceIdentityRef.current === sourceIdentity &&
            current === video &&
            Math.abs(video.currentTime - srcTime) > 1 / 60
          ) {
            video.currentTime = srcTime;
          }
        };
        if (video.readyState >= 1) apply();
        else video.addEventListener("loadedmetadata", apply, { once: true });
      };
      seekActive("screen", activeScreen());
      seekActive("face", activeFace());
      const cuts = nextDiscontinuousCutsAfter(
        live.clips,
        live.playhead,
        STANDBY_DEPTH
      );
      cuts.forEach((cut, k) => {
        faceSeekersRef.current?.[k]?.target(cut.seekSrc);
        screenSeekersRef.current?.[k]?.target(cut.seekSrc);
      });
    }
    normalizeBaseMute();
    invalidateOverlayPlayback();
    invalidatePlaybackAttempt();
    reconcileMediaReadiness();
    return invalidatePlaybackAttempt;
  }, [
    baseSourceIdentity,
    faceSourceIdentity,
    screenSourceIdentity,
    screenWorkingSourceIdentity,
    activeFace,
    activeScreen,
    invalidateOverlayPlayback,
    invalidatePlaybackAttempt,
    normalizeBaseMute,
    reportBaseCanPlay,
    reconcileMediaReadiness,
  ]);

  const reportOverlayFailure = useCallback(
    (overlayId: string, src: string) => {
      if (!mountedRef.current) return;
      const key = overlayFailureKey(overlayId, src);
      if (!overlayFailuresRef.current.has(key)) {
        overlayFailuresRef.current.set(key, {
          id: overlayId,
          src,
          reason: `Overlay video ${overlayId} could not play. Re-import it to create a compatible copy.`,
          wasActive: false,
        });
      }
      reconcileMediaReadiness();
    },
    [reconcileMediaReadiness]
  );

  const playActiveOverlay = useCallback(
    (overlay: Overlay, video: HTMLVideoElement) => {
      const session = overlayPlaybackSessionRef.current;
      const pending = overlayPlayPendingRef.current.get(overlay.id);
      if (
        !video.paused ||
        (pending &&
          pending.session === session &&
          pending.video === video &&
          pending.src === overlay.src)
      )
        return;
      const attempt = {
        attempt: ++overlayPlaybackAttemptRef.current,
        session,
        video,
        src: overlay.src,
      };
      overlayPlayPendingRef.current.set(overlay.id, attempt);
      let playPromise: Promise<void>;
      try {
        playPromise = Promise.resolve(video.play());
      } catch (error) {
        playPromise = Promise.reject(error);
      }
      void playPromise.then(
        () => {
          if (overlayPlayPendingRef.current.get(overlay.id) === attempt) {
            overlayPlayPendingRef.current.delete(overlay.id);
          }
        },
        () => {
          const state = useRepurposeStore.getState();
          const currentOverlay = state.overlays.find(
            (candidate) =>
              candidate.id === overlay.id &&
              candidate.kind === "video" &&
              candidate.src === attempt.src
          );
          const isCurrent =
            mountedRef.current &&
            overlayPlaybackSessionRef.current === attempt.session &&
            overlayPlayPendingRef.current.get(overlay.id) === attempt &&
            videoPoolRef.current.get(overlay.id) === attempt.video &&
            state.isPlaying &&
            !!currentOverlay;
          if (!isCurrent) return;
          overlayPlayPendingRef.current.delete(overlay.id);
          if (state.isPlaying) {
            reportOverlayFailure(overlay.id, attempt.src);
          }
        }
      );
    },
    [reportOverlayFailure]
  );

  useEffect(() => {
    const currentSources = new Map(
      overlays
        .filter((overlay) => overlay.kind === "video")
        .map((overlay) => [overlay.id, overlay.src])
    );
    for (const [id, pending] of overlayPlayPendingRef.current) {
      if (currentSources.get(id) !== pending.src) {
        overlayPlayPendingRef.current.delete(id);
      }
    }
  }, [overlays]);

  useEffect(() => {
    reconcileMediaReadiness();
  }, [overlays, playhead, sourceImportActive, reconcileMediaReadiness]);

  // --- Overlay media pools ----------------------------------------------------
  // Image overlays decode ONCE into an HTMLImageElement (kept in imgPoolRef,
  // keyed by overlay id). Video overlays get one hidden pooled <video> each
  // (videoPoolRef, populated by the ref callbacks on the hidden <video> pool
  // rendered in JSX below). The single rAF loop reads both pools every frame to
  // build the OverlayDraw[] it hands drawFrame, WITHOUT re-subscribing -- exactly
  // like the two base videos. A video overlay is ALWAYS muted (an overlay never
  // emits audio); the pooled <video> below sets `muted`.
  const imgPoolRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const overlayPreviewSrcRef = useRef<Map<string, string>>(new Map());
  const getOverlayPreviewSrc = useCallback(
    (overlayId: string) => overlayPreviewSrcRef.current.get(overlayId),
    []
  );

  // --- Register the caption faces for canvas text (once on mount) -------------
  // Captions are drawn via ctx.fillText, so the browser must have loaded + added
  // the faces to document.fonts before the first caption draw or it silently
  // falls back to a system font. loadCaptionFonts() is idempotent (shared
  // promise), so calling it here just warms the faces for the rAF loop below.
  useEffect(() => {
    loadCaptionFonts();
  }, []);

  // --- Decode image overlays once + backfill intrinsic size -------------------
  // On first sight of an image overlay id, kick off a decode (HTMLImageElement).
  // Once loaded it lives in imgPoolRef so the rAF loop can drawImage it every
  // frame with zero per-frame decode. If the store's naturalWidth/Height is
  // still 0 (added before the media resolved), backfill it so the timeline,
  // selection box, and export all get the true aspect ratio. Videos backfill
  // their size from videoWidth/Height in the pooled <video>'s loadedmetadata.
  // Prune pool entries whose overlay was removed so the map can't leak.
  useEffect(() => {
    const pool = imgPoolRef.current;
    for (const ov of overlays) {
      if (ov.kind !== "image" || pool.has(ov.id)) continue;
      const img = new Image();
      img.decoding = "async";
      const id = ov.id;
      img.onload = () => {
        if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
        const cur = useRepurposeStore.getState().overlays.find((o) => o.id === id);
        if (cur && (cur.naturalWidth <= 0 || cur.naturalHeight <= 0)) {
          // Metadata backfill only -- not an editable mutation, so it bypasses
          // history (setState, not an action). Guarded to the one overlay.
          useRepurposeStore.setState((s) => ({
            overlays: s.overlays.map((o) =>
              o.id === id
                ? { ...o, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }
                : o
            ),
          }));
        }
      };
      img.src = ov.src;
      pool.set(id, img);
    }
    // Prune images for overlays that no longer exist.
    const liveIds = new Set(overlays.filter((o) => o.kind === "image").map((o) => o.id));
    for (const key of pool.keys()) {
      if (!liveIds.has(key)) pool.delete(key);
    }
  }, [overlays]);

  // --- Neutralize OS/browser media keys over the preview <video>s -------------
  // The studio's own transport is Space / J-K-L / arrows (see TransportBar). But
  // the preview uses real <video> elements, so macOS hardware media keys
  // (F7 prev / F8 play-pause / F9 next -- and the Touch Bar / Now-Playing
  // equivalents) get routed by the browser straight into those videos, toggling
  // playback out from under the app. Manthan doesn't use those keys for this
  // tool and they fight the rAF clock. We claim the MediaSession and register
  // NO-OP handlers for the transport actions so pressing F7/F8/F9 does nothing
  // to the preview. This is scoped to while the studio is mounted (handlers are
  // cleared on unmount) and does not touch the user's OS media keys anywhere
  // else. Guarded because mediaSession is browser-only and not in every engine.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const actions: MediaSessionAction[] = [
      "play",
      "pause",
      "stop",
      "seekbackward",
      "seekforward",
      "previoustrack",
      "nexttrack",
    ];
    const noop = () => {
      /* swallow the media key: the app's own transport owns playback */
    };
    for (const action of actions) {
      try {
        ms.setActionHandler(action, noop);
      } catch {
        // Some engines throw on unsupported actions -- ignore and continue.
      }
    }
    // Mark nothing as actively playing so the OS "Now Playing" target stays idle.
    try {
      ms.playbackState = "none";
    } catch {
      /* not settable in every engine */
    }
    return () => {
      for (const action of actions) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // --- Seek both videos to the frame-locked SOURCE time (SCRUB only) ----------
  // playhead is OUTPUT-timeline seconds; video.currentTime is RAW SOURCE
  // seconds. Map through the assembled clip list so trimmed/deleted/reordered
  // retakes never leak into the preview. Both videos share one source time
  // (screen + face are frame-locked to a single raw timebase).
  //
  // This is the PAUSED (scrub) path: it hard-seeks on any playhead change while
  // the clock is stopped, exactly as before. During playback the clock owns
  // currentTime (the videos free-run and the rAF loop resyncs on drift), so we
  // must NOT hard-seek here -- doing so would fight the running video and stutter
  // it. Gate on isPlaying so the seek only fires when NOT playing.
  useEffect(() => {
    if (isPlaying) return; // clock owns currentTime while playing
    const srcTime = timelineToSourceTime(clips, playhead);
    if (srcTime === null) return; // no kept clip here -- hold the current frame
    const screenVideo = activeScreen();
    const faceVideo = activeFace();
    if (screenVideo && Math.abs(screenVideo.currentTime - srcTime) > 1 / 60) {
      screenVideo.currentTime = srcTime;
    }
    if (faceVideo && Math.abs(faceVideo.currentTime - srcTime) > 1 / 60) {
      faceVideo.currentTime = srcTime;
    }
  }, [playhead, clips, isPlaying, activeScreen, activeFace]);

  // --- Pre-seek the STANDBY pool at the next discontinuous cuts -------------
  // Whenever the clip list or playhead moves, park standby pair k at the
  // source in-point of the (k+1)-th real (discontinuous) cut ahead of the
  // playhead. StandbySeeker serializes the seeks and no-ops when the target is
  // unchanged, so running this on every playhead tick is cheap. Fewer cuts
  // ahead than standbys -> the extra standbys keep their old park (harmless).
  // Runs paused or playing: pre-seeking while paused means the very first cuts
  // after pressing play are already warm. Keyed on footageMeta so a project
  // load re-targets once the sources exist.
  useEffect(() => {
    const cuts = nextDiscontinuousCutsAfter(clips, playhead, STANDBY_DEPTH);
    cuts.forEach((cut, k) => {
      faceSeekersRef.current?.[k]?.target(cut.seekSrc);
      screenSeekersRef.current?.[k]?.target(cut.seekSrc);
    });
  }, [clips, playhead, footageMeta]);

  // Forget in-flight seek state when the component unmounts (or the sources
  // change identity) so a stale 'seeked' listener never fires on a dead node.
  useEffect(() => {
    return () => {
      faceSeekersRef.current?.forEach((s) => s.reset());
      screenSeekersRef.current?.forEach((s) => s.reset());
    };
  }, [footageMeta]);

  // --- Start/stop the source <video>s in lockstep with isPlaying -------------
  // Synchronizing the real play state of two external <video> elements with the
  // store flag is a true external-system sync -> Effect (keyed on isPlaying).
  // When flipping TRUE: seed the clock (reset lastTimestamp so the first frame
  // doesn't jump), seek both videos to the current source time, then .play()
  // both. Because isPlaying only ever flips true from a user gesture (play
  // button / space), this .play() runs inside that gesture's continuation, so
  // the unmuted FACE video is allowed to start; .catch(() => {}) swallows any
  // stray rejection so a blocked promise never throws.
  // When flipping FALSE (pause / end-of-region): .pause() both videos.
  useEffect(() => {
    let attempt: number | null = null;
    const screenVideo = activeScreen();
    const faceVideo = activeFace();
    if (isPlaying) {
      const live = liveRef.current;
      const srcTime = timelineToSourceTime(
        live.clips,
        live.playhead
      );
      if (srcTime !== null) {
        if (screenVideo)
          synchronizeMediaTime(
            screenVideo,
            srcTime,
            BASE_MEDIA_DRIFT_TOLERANCE_SEC
          );
        if (faceVideo)
          synchronizeMediaTime(
            faceVideo,
            srcTime,
            BASE_MEDIA_DRIFT_TOLERANCE_SEC
          );
      }
      // FACE carries the audio (see the unmuted FACE <video> below); SCREEN
      // stays muted, so only the narration plays. Both still .play() to keep
      // their frames advancing in real time. The playback-rate effect below
      // (keyed on isPlaying too) sets .playbackRate on both, so the first
      // playing frame already runs at the chosen speed.
      normalizeBaseMute();
      attempt = playRequiredBaseMedia(screenVideo, faceVideo);
    } else {
      invalidatePlaybackAttempt();
      invalidateOverlayPlayback();
      // Pause BOTH slots -- the standby pair is normally already paused (it
      // only ever sits pre-seeked), but a swap that raced the pause could have
      // left the freed pair rolling; belt-and-braces stop everything.
      for (const v of screenElsRef.current) v?.pause();
      for (const v of faceElsRef.current) v?.pause();
      for (const v of videoPoolRef.current.values()) v.pause();
    }
    return () => {
      if (attempt !== null && playbackAttemptRef.current === attempt) {
        invalidatePlaybackAttempt();
      }
    };
  }, [
    isPlaying,
    activeScreen,
    activeFace,
    baseSourceIdentity,
    invalidateOverlayPlayback,
    invalidatePlaybackAttempt,
    normalizeBaseMute,
    playRequiredBaseMedia,
  ]);

  // --- Apply playback rate and re-anchor the one monotonic clock --------------
  // Every media follower receives the same rate. A rate change during playback
  // preserves the current output time and starts a fresh monotonic anchor.
  useEffect(() => {
    const rate = playbackRate > 0 ? playbackRate : 1;
    // BOTH slots get the rate -- the standby pair must already carry the right
    // playbackRate the instant a swap promotes it to active, or the first
    // post-cut frames would run at 1x.
    for (const v of screenElsRef.current) if (v) v.playbackRate = rate;
    for (const v of faceElsRef.current) if (v) v.playbackRate = rate;
    // Overlay videos honor J/K/L speed too so their motion stays rate-matched.
    for (const v of videoPoolRef.current.values()) v.playbackRate = rate;
    const anchor = transportAnchorRef.current;
    if (isPlaying && anchor && anchor.rate !== rate) {
      const outputSec = expectedPlayheadRef.current ?? liveRef.current.playhead;
      transportAnchorRef.current = reanchorTransport(
        anchor,
        outputSec,
        frameScheduler.now(),
        rate
      );
      transportGenerationRef.current = transportAnchorRef.current.generation;
    }
  }, [playbackRate, isPlaying, frameScheduler]);

  // --- Canvas setup (DPR-correct backing store, resizes with container) -----
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      // The canvas is always logically `width x height` (1080x1920) and the
      // compositor draws in that coordinate space. setupCrispCanvas backs the
      // bitmap at native resolution for that logical size, but it also pins an
      // inline CSS width/height of 1080x1920px -- which would overflow this
      // small preview panel (inline styles beat the `h-full w-full` utility
      // classes). Clear those two inline dimensions afterwards so the canvas
      // bitmap scales down to fill the aspect-ratio-locked container instead.
      ctxRef.current = setupCrispCanvas(canvas, width, height);
      canvas.style.width = "";
      canvas.style.height = "";
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [width, height]);

  // --- Playback clock + render loop ------------------------------------------
  // ONE rAF loop is both the clock (advances the playhead over real wall time
  // while playing) and the compositor (draws the current frame every frame,
  // playing or not, preserving scrub-preview when paused).
  //
  // Clock: while isPlaying, each frame advances an OUTPUT-time playhead by the
  // real elapsed wall time (rAF timestamp delta / 1000 -- never assume 60fps)
  // and writes it back via setPlayhead. Region: regionStart = inPoint ?? 0,
  // regionEnd = outPoint ?? duration. Crossing regionEnd either wraps to
  // regionStart (loop) or clamps to regionEnd + pause()s and stops the videos.
  //
  // Frame-lock: source videos free-run as followers. Each sampled output time is
  // mapped through the kept clips and only corrects media beyond its drift limit.
  useEffect(() => {
    const tick = (timestamp: number) => {
      // The callback being executed is no longer pending. Only the single
      // schedule at the bottom may populate rafRef again.
      rafRef.current = null;
      const live = liveRef.current;
      let sampledOutput: number | null = null;
      // Resolve the ACTIVE pair fresh every frame -- a cut swap in an earlier
      // frame changes which physical elements these are, so they can never be
      // captured once at effect mount like they used to be.
      let screenVideo = screenElsRef.current[slotOrderRef.current[0]];
      let faceVideo = faceElsRef.current[slotOrderRef.current[0]];

      // 1) CLOCK -- output time comes only from the monotonic transport anchor.
      // Base and overlay media follow the mapped source time within drift limits.
      if (
        live.isPlaying &&
        transportConfirmedRef.current &&
        captionGestureRef.current === null
      ) {
        const regionStart = live.inPoint ?? 0;
        const regionEnd = live.outPoint ?? live.duration;
        const rate = live.playbackRate > 0 ? live.playbackRate : 1;
        let anchor = transportAnchorRef.current;
        if (!anchor) {
          anchor = startTransport(
            live.playhead,
            timestamp,
            rate,
            ++transportGenerationRef.current
          );
          transportAnchorRef.current = anchor;
        }

        let previousOutput = expectedPlayheadRef.current ?? live.playhead;
        const isExternalSeek =
          expectedPlayheadRef.current !== null &&
          Math.abs(live.playhead - expectedPlayheadRef.current) >
            EXTERNAL_SEEK_TOLERANCE_SEC;
        if (isExternalSeek) {
          anchor = reanchorTransport(anchor, live.playhead, timestamp, rate);
          transportAnchorRef.current = anchor;
          transportGenerationRef.current = anchor.generation;
          previousOutput = live.playhead;
          const externalSeekSource = timelineToSourceTime(
            live.clips,
            live.playhead
          );
          if (externalSeekSource !== null) {
            screenVideo && (screenVideo.currentTime = externalSeekSource);
            faceVideo && (faceVideo.currentTime = externalSeekSource);
          }
        }

        let next = sampleTransport(anchor, timestamp, regionStart, regionEnd);
        let reachedEnd = next >= regionEnd;
        if (reachedEnd && live.loopPlayback) {
          next = regionStart;
          reachedEnd = false;
          anchor = reanchorTransport(anchor, next, timestamp, rate);
          transportAnchorRef.current = anchor;
          transportGenerationRef.current = anchor.generation;
        }

        const previousClip = activeClipAt(live.clips, previousOutput);
        const nextClip = activeClipAt(live.clips, next);
        const crossedCut =
          !!previousClip && !!nextClip && previousClip.id !== nextClip.id;
        if (crossedCut && previousClip && nextClip) {
          const discontinuous =
            Math.abs(nextClip.srcStart - previousClip.srcEnd) >
            CONTIGUOUS_CUT_EPSILON;
          if (discontinuous) {
            const seekSrc = timelineToSourceTime(live.clips, next);
            const order = slotOrderRef.current;
            const standbyFace = faceElsRef.current[order[1]];
            const standbyScreen = screenElsRef.current[order[1]];
            const swapReady =
              seekSrc !== null &&
              !!standbyFace &&
              !!standbyScreen &&
              !!faceVideo &&
              !!screenVideo &&
              !!faceSeekersRef.current?.[0]?.readyAt(nextClip.srcStart) &&
              !!screenSeekersRef.current?.[0]?.readyAt(nextClip.srcStart);
            if (swapReady && standbyFace && standbyScreen) {
              slotOrderRef.current = [...order.slice(1), order[0]];
              faceSeekersRef.current?.forEach((seeker) => seeker.reset());
              screenSeekersRef.current?.forEach((seeker) => seeker.reset());
              standbyFace.playbackRate = rate;
              standbyScreen.playbackRate = rate;
              normalizeBaseMute();
              faceVideo!.pause();
              screenVideo!.pause();
              playRequiredBaseMedia(standbyScreen, standbyFace, next);

              const upcoming = nextDiscontinuousCutsAfter(
                live.clips,
                next,
                STANDBY_DEPTH
              );
              upcoming.forEach((cut, index) => {
                faceSeekersRef.current?.[index]?.target(cut.seekSrc);
                screenSeekersRef.current?.[index]?.target(cut.seekSrc);
              });
            }
          }
          anchor = reanchorTransport(anchor, next, timestamp, rate);
          transportAnchorRef.current = anchor;
          transportGenerationRef.current = anchor.generation;
        }

        const targetSource = timelineToSourceTime(live.clips, next);
        const currentScreen = activeScreen();
        const currentFace = activeFace();
        if (targetSource !== null) {
          if (currentScreen)
            synchronizeMediaTime(
              currentScreen,
              targetSource,
              BASE_MEDIA_DRIFT_TOLERANCE_SEC
            );
          if (currentFace)
            synchronizeMediaTime(
              currentFace,
              targetSource,
              BASE_MEDIA_DRIFT_TOLERANCE_SEC
            );
        }
        // Exactly one playhead write per playing tick.
        sampledOutput = next;
        setPlayhead(next);
        expectedPlayheadRef.current = next;

        if (reachedEnd) {
          pause();
          for (const video of screenElsRef.current) video?.pause();
          for (const video of faceElsRef.current) video?.pause();
          for (const video of videoPoolRef.current.values()) video.pause();
          transportAnchorRef.current = null;
        }
      }

      // A discontinuous cut may have rotated the ring above. Render the newly
      // promoted pair in this same half-open-boundary frame, never the retired
      // pair captured at the beginning of the tick.
      screenVideo = activeScreen();
      faceVideo = activeFace();

      // 3) RENDER -- composite the current frame (playing or paused). Read the
      // freshest playhead from the ref (setPlayhead above updates it next frame,
      // but we want this frame drawn at whatever the store currently holds).
      const ctx = ctxRef.current;
      if (ctx) {
        const {
          splitRatio: globalSplit,
          playhead: storedPlayhead,
          clips: liveClips,
          screenGrade: sg,
          faceGrade: fg,
          captionsEnabled: capsOn,
          captionStyle: capStyle,
          captionBlocks: capBlocks,
          overlays: liveOverlays,
          isPlaying: requestedPlaying,
        } = liveRef.current;
        const t = sampledOutput ?? storedPlayhead;
        const playing = requestedPlaying && transportConfirmedRef.current;

        // Resolve the settled per-scene split first, then layer a direct divider
        // gesture over visual consumers only. Persisted mutations keep reading
        // liveSplitRef while the compositor, captions, hit tests, and DOM chrome
        // use liveSplit. Mirror visual changes to state only when needed.
        const settledSplit = effectiveSplitRatio(
          splitRatioAt(liveClips, t, globalSplit),
          height
        );
        liveSplitRef.current = settledSplit;
        const liveSplit =
          transientSplitRef.current === null
            ? settledSplit
            : effectiveSplitRatio(transientSplitRef.current, height);
        if (Math.abs(liveSplit - handleSplitRef.current) > 1e-4) {
          handleSplitRef.current = liveSplit;
          setHandleSplit(liveSplit);
        }

        // SCREEN: one static per-scene pan/zoom (clip.screenFraming), eased
        // across cuts by the Smart transition -- resolved inside screenFramingAt,
        // shared verbatim with the export. A scene with no framing of its own
        // frames as shot (identity). Then FOLD IN the mid-clip zoom punch-in
        // (clip.screenPunch): a transient scale multiplier (1 outside the
        // envelope, so a no-op) applied on top of the base framing scale. Same
        // punchScaleAt the export calls with the same output time -> frame-identical.
        const screenBase = screenFramingAt(liveClips, t);
        const screenPunch = punchScaleAt(liveClips, t, "screen");
        const screenTransform =
          screenPunch === 1
            ? screenBase
            : { ...screenBase, scale: screenBase.scale * screenPunch };
        // FACE: one static per-scene framing (clip.faceFraming), eased across
        // cuts the same way -- resolved inside faceFramingAt, shared with export.
        // Fold in the face punch envelope identically.
        const faceBase = faceFramingAt(liveClips, t);
        const facePunch = punchScaleAt(liveClips, t, "face");
        const faceTransform =
          facePunch === 1
            ? faceBase
            : { ...faceBase, scale: faceBase.scale * facePunch };

        // Per-cut Smart transition (Descript-style zoom-settle motion, NOT a
        // fade). transitionProgressAt is a PURE function of the current playhead
        // shared with the export frame-walk, so preview and export render the
        // SAME motion frame-for-frame. It returns non-null only while inside an
        // incoming clip's transition window; null the rest of the time, in which
        // case we pass no `transition` and drawFrame behaves exactly as before.
        // This fires whether playing OR paused-and-scrubbing, which is correct --
        // scrubbing into a transition window should preview that motion frame.
        const tp = transitionProgressAt(liveClips, t);

        // Draw the video whenever it HAS a frame to give -- gate on
        // videoWidth > 0, NOT readyState >= 2. A <video> keeps its last decoded
        // frame available to drawImage across a seek (readyState briefly drops
        // to 1 mid-seek), so the old gate blanked to the "SCREEN"/"FACE"
        // placeholder for the 1-2s a cut's seek took -- the black flash at every
        // scene change. With videoWidth as the gate the previous frame holds on
        // screen until the next one decodes, then swaps: a clean cut, no black.
        const screenReady = !!screenVideo && screenVideo.videoWidth > 0;
        const faceReady = !!faceVideo && faceVideo.videoWidth > 0;
        const screenRegion: RegionSource = {
          source: screenReady ? screenVideo : null,
          sourceWidth: screenVideo?.videoWidth ?? 0,
          sourceHeight: screenVideo?.videoHeight ?? 0,
          transform: screenTransform,
          placeholderLabel: "SCREEN",
          filter: gradeFilter(sg),
        };
        const faceRegion: RegionSource = {
          source: faceReady ? faceVideo : null,
          sourceWidth: faceVideo?.videoWidth ?? 0,
          sourceHeight: faceVideo?.videoHeight ?? 0,
          transform: faceTransform,
          placeholderLabel: "FACE",
          filter: gradeFilter(fg),
        };

        // FREE-FLOATING OVERLAYS -- resolve every overlay active at this playhead
        // into an OverlayDraw the compositor draws on top of the base composite,
        // bottom-to-top by zIndex. Built from the SAME overlays array + window
        // filter + z-sort the export uses, so preview == export for overlays.
        //
        // Video overlays are never a clock. While SCRUBBING (paused) we hard-seek each active
        // overlay video to its source frame `want`. While PLAYING the pooled
        // <video> free-runs at playbackRate and we only issue a LIGHT drift
        // resync when it strays > 0.25s (a rare correction, not per-frame), and
        // .play()/.pause() it as it enters/leaves its window. Sources gate on a
        // decoded frame (naturalWidth / videoWidth > 0) so an overlay never draws
        // a black rectangle before its media is ready.
        const active = liveOverlays
          .filter((o) => t >= o.timelineStart && t < o.timelineEnd)
          .sort((a, b) => a.zIndex - b.zIndex);
        const overlayDraws: OverlayDraw[] = [];
        const outputRect = { left: 0, top: 0, width, height };
        const appearances = new Map(
          liveOverlays.map((overlay) => [
            overlay.id,
            resolveOverlayAppearanceAt(overlay, t, outputRect, liveSplit),
          ] as const)
        );
        overlayFrameSnapshotRef.current = {
          outputTime: t,
          splitRatio: liveSplit,
          appearances,
        };
        for (const o of active) {
          const appearance = appearances.get(o.id)!;
          if (o.kind === "image") {
            const img = imgPoolRef.current.get(o.id) ?? null;
            const ready = !!img && img.naturalWidth > 0 && img.naturalHeight > 0;
            if (!ready) continue; // no black first frame -- skip until decoded
            overlayDraws.push({
              source: img,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              transform: {
                ...appearance.transform,
                opacity: o.opacity * appearance.opacityMultiplier,
              },
              cornerRadius: appearance.cornerRadius,
              band: o.band,
            });
          } else {
            const v = videoPoolRef.current.get(o.id) ?? null;
            if (!v || v.videoWidth <= 0) continue; // gate on a decoded frame
            const want = o.srcStart + (t - o.timelineStart);
            if (playing) {
              // Light drift correction only -- the overlay is not the clock.
              playActiveOverlay(o, v);
              synchronizeMediaTime(
                v,
                want,
                OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC
              );
            } else if (!requestedPlaying) {
              // Scrub: hard-seek to the exact source frame for this output time.
              if (Math.abs(v.currentTime - want) > 1 / 30) v.currentTime = want;
            }
            overlayDraws.push({
              source: v,
              naturalWidth: v.videoWidth,
              naturalHeight: v.videoHeight,
              transform: {
                ...appearance.transform,
                opacity: o.opacity * appearance.opacityMultiplier,
              },
              cornerRadius: appearance.cornerRadius,
              band: o.band,
            });
          }
        }
        // Pause overlay videos that fell OUT of their window this frame so an
        // idle B-roll clip isn't left decoding in the background during playback.
        if (playing) {
          const activeVideoIds = new Set(
            active.filter((o) => o.kind === "video").map((o) => o.id)
          );
          for (const [id, v] of videoPoolRef.current) {
            if (!activeVideoIds.has(id) && !v.paused) v.pause();
          }
        }

        drawFrame(ctx, {
          screen: screenRegion,
          face: faceRegion,
          splitRatio: liveSplit,
          width,
          height,
          // Overlays drawn on top of the base composite; an empty array is a
          // strict no-op. Sorted ascending by zIndex so index 0 is bottom-most.
          // Overlays are the LAST thing drawFrame paints; captions then draw
          // AFTER this drawFrame call (below), so text always stays above every
          // overlay. Do not move the drawCaptions call before this one.
          overlays: overlayDraws,
          // Only feed a transition while one is actually playing at this
          // playhead; when tp is null, omit it so drawFrame renders a hard cut
          // exactly as it did before this field existed (strictly additive).
          ...(tp
            ? {
                transition: {
                  type: tp.transition.type,
                  progress: tp.progress,
                  amount: tp.transition.amount,
                  direction: tp.transition.direction,
                  easing: tp.transition.easing,
                },
              }
            : {}),
        });

        // CAPTIONS ARE THE TOP LAYER -- they always draw AFTER overlays; nothing
        // composites above them. INVARIANT (do not reorder): this drawCaptions
        // call MUST stay the last draw of the pass, strictly after the drawFrame
        // above (which paints the base regions, the divider, and every overlay).
        // Overlays are the last thing drawFrame paints, so keeping captions here
        // guarantees text sits above the split video AND every media overlay. The
        // export mirrors this exact order (see export-short.ts drawOneFrame), so
        // preview == export. (The split handle is a DOM overlay, so in the preview
        // it visually sits above canvas captions -- expected; in the export there
        // is no DOM and captions are truly on top of everything.) Word timings are
        // SOURCE seconds, so map the current playhead t -> source time first.
        if (capsOn) {
          const srcT = timelineToSourceTime(liveClips, t);
          const transientPosition = captionTransientPositionRef.current;
          const captionLayout = drawCaptions(ctx, {
            style: capStyle,
            blocks: capBlocks,
            srcT,
            width,
            height,
            // Pin captions to the split seam so dragging the split (face-cam up/
            // down) carries the captions with it -- see CaptionStyle.pinToSplit.
            splitRatio: liveSplit,
            ...(transientPosition ? { transientPosition } : {}),
          });
          captionFrameRef.current =
            captionLayout && srcT !== null
              ? {
                  layout: captionLayout,
                  outputTime: t,
                  sourceTime: srcT,
                  renderedSplit: liveSplit,
                  settledSplit,
                  projectEpoch: useRepurposeStore.getState().projectEpoch,
                  captionStyle: capStyle,
                  captionBlocks: capBlocks,
                  clips: liveClips,
                  keyboardPlacement: null,
                }
              : null;
          publishCaptionLayout(captionLayout);
        } else {
          captionFrameRef.current = null;
          publishCaptionLayout(null);
        }
      }
      if (rafRef.current === null) {
        rafRef.current = frameScheduler.request(tick);
      }
    };

    if (rafRef.current === null) {
      rafRef.current = frameScheduler.request(tick);
    }
    return () => {
      if (rafRef.current !== null) {
        frameScheduler.cancel(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    width,
    height,
    setPlayhead,
    pause,
    activeScreen,
    activeFace,
    frameScheduler,
    normalizeBaseMute,
    playActiveOverlay,
    playRequiredBaseMedia,
    publishCaptionLayout,
  ]);

  const finishCaptionGesture = useCallback(
    (
      gesture: CaptionPointerGesture,
      mode: "end" | "cancel" | "store-cancel"
    ) => {
      if (captionGestureRef.current !== gesture) return;
      captionGestureRef.current = null;
      window.removeEventListener("pointermove", gesture.onMove);
      window.removeEventListener("pointerup", gesture.onUp);
      window.removeEventListener("pointercancel", gesture.onCancel);
      try {
        gesture.element.releasePointerCapture(gesture.pointerId);
      } catch {
        // Capture may already be gone after browser cancellation or node removal.
      }
      captionTransientPositionRef.current = null;
      hideCaptionSnapGuide();
      if (mode === "store-cancel") return;
      const store = useRepurposeStore.getState();
      if (mode === "end" && gesture.activated) {
        store.completeCaptionGesture(
          gesture.token,
          gesture.snapped
            ? { kind: "attach" }
            : {
                kind: "detach",
                positionYPct: gesture.finalAnchorY / height,
              }
        );
      } else {
        store.cancelCaptionGesture(gesture.token);
      }
    },
    [height, hideCaptionSnapGuide]
  );

  useEffect(() => {
    const unsubscribeCancellation = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(() => {
        const gesture = captionGestureRef.current;
        if (gesture) finishCaptionGesture(gesture, "store-cancel");
      });
    const unsubscribeStore = useRepurposeStore.subscribe((state, previous) => {
      const gesture = captionGestureRef.current;
      if (!gesture) return;
      if (
        state.projectEpoch !== previous.projectEpoch ||
        state.captionBlocks !== previous.captionBlocks ||
        !state.captionsEnabled ||
        !state.captionBlocks.some((block) => block.id === gesture.blockId)
      ) {
        finishCaptionGesture(gesture, "cancel");
      }
    });
    return () => {
      unsubscribeCancellation();
      unsubscribeStore();
      const gesture = captionGestureRef.current;
      if (gesture) finishCaptionGesture(gesture, "cancel");
    };
  }, [finishCaptionGesture]);

  const currentCaptionFrame = useCallback((): CaptionFrameLayout | null => {
    const frame = captionFrameRef.current;
    if (!frame) return null;
    const store = useRepurposeStore.getState();
    const sourceTime = timelineToSourceTime(store.clips, store.playhead);
    const activeBlock =
      sourceTime === null
        ? null
        : activeCaptionBlockAt(store.captionBlocks, sourceTime);
    if (
      !store.captionsEnabled ||
      store.projectEpoch !== frame.projectEpoch ||
      store.playhead !== frame.outputTime ||
      sourceTime !== frame.sourceTime ||
      store.captionStyle !== frame.captionStyle ||
      store.captionBlocks !== frame.captionBlocks ||
      store.clips !== frame.clips ||
      activeBlock?.id !== frame.layout.activeBlock.id ||
      frame.layout.activeBlockId !== frame.layout.activeBlock.id
    ) {
      captionFrameRef.current = null;
      publishCaptionLayout(null);
      return null;
    }
    return frame;
  }, [publishCaptionLayout]);

  const settledCaptionAnchorY = useCallback(
    (frame: CaptionFrameLayout): number | null =>
      frame.renderedSplit === frame.settledSplit
        ? frame.layout.attachedTargetAnchorY
        : Math.min(
            frame.layout.anchorRange.max,
            Math.max(
              frame.layout.anchorRange.min,
              (frame.settledSplit + frame.layout.style.splitOffsetPct) * height
            )
          ),
    [height]
  );

  const handleCaptionPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const frame = currentCaptionFrame();
      const layout = frame?.layout ?? null;
      const container = containerRef.current;
      if (!frame || !layout || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const outputX = ((event.clientX - rect.left) / rect.width) * width;
      const outputY = ((event.clientY - rect.top) / rect.height) * height;
      const bounds = layout.visualBounds;
      if (
        outputX < bounds.left ||
        outputX > bounds.right ||
        outputY < bounds.top ||
        outputY > bounds.bottom
      ) {
        return;
      }
      const store = useRepurposeStore.getState();
      const previous = captionGestureRef.current;
      if (previous) finishCaptionGesture(previous, "cancel");
      pause();
      store.selectCaptionBlock(layout.activeBlockId);
      const token = store.beginCaptionGesture(layout.activeBlockId);
      if (token === null) return;
      const pointerId = event.pointerId;
      const element = event.currentTarget;
      try {
        element.setPointerCapture(pointerId);
      } catch {
        // Window listeners still provide safe cleanup where capture is unavailable.
      }
      const attachedTargetAnchorY = settledCaptionAnchorY(frame);
      const onMove = (moveEvent: PointerEvent) => {
        const gesture = captionGestureRef.current;
        if (
          !gesture ||
          gesture.token !== token ||
          moveEvent.pointerId !== pointerId
        ) {
          return;
        }
        const deltaCss = moveEvent.clientY - gesture.startClientY;
        if (!gesture.activated && Math.abs(deltaCss) < 3) return;
        gesture.activated = true;
        const deltaLogical = (deltaCss / gesture.cssHeight) * height;
        const rawAnchor = Math.min(
          gesture.anchorRange.max,
          Math.max(gesture.anchorRange.min, gesture.startAnchorY + deltaLogical)
        );
        const snapDistanceCss =
          gesture.attachedTargetAnchorY === null
            ? Infinity
            : (Math.abs(rawAnchor - gesture.attachedTargetAnchorY) /
                height) *
              gesture.cssHeight;
        gesture.snapped = snapDistanceCss <= 12;
        gesture.finalAnchorY = gesture.snapped
          ? gesture.attachedTargetAnchorY!
          : rawAnchor;
        captionTransientPositionRef.current = {
          blockId: gesture.blockId,
          positionYPct: gesture.finalAnchorY / height,
        };
        const guide = captionSnapGuideRef.current;
        if (guide) {
          guide.hidden = !gesture.snapped;
          if (gesture.snapped) {
            guide.style.top = `${
              (gesture.finalAnchorY / height) * gesture.cssHeight
            }px`;
          }
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        const gesture = captionGestureRef.current;
        if (gesture?.token === token) finishCaptionGesture(gesture, "end");
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        const gesture = captionGestureRef.current;
        if (gesture?.token === token) finishCaptionGesture(gesture, "cancel");
      };
      captionGestureRef.current = {
        pointerId,
        token,
        element,
        blockId: layout.activeBlockId,
        sourceFrame: frame.sourceTime,
        startClientY: event.clientY,
        cssHeight: rect.height,
        startAnchorY: layout.anchorY,
        finalAnchorY: layout.anchorY,
        anchorRange: { ...layout.anchorRange },
        settledSplit: frame.settledSplit,
        attachedTargetAnchorY,
        activated: false,
        snapped: false,
        onMove,
        onUp,
        onCancel,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [
      currentCaptionFrame,
      finishCaptionGesture,
      height,
      pause,
      settledCaptionAnchorY,
      width,
    ]
  );

  const handleCaptionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const isAttach = event.key === "Enter" || event.key === " ";
      const isPosition = ["ArrowUp", "ArrowDown", "Home", "End"].includes(
        event.key
      );
      if (!isAttach && !isPosition) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hidden) return;
      const frame = currentCaptionFrame();
      if (!frame) return;

      const store = useRepurposeStore.getState();
      let keyboardPlacement: NonNullable<CaptionFrameLayout["keyboardPlacement"]>;
      if (isAttach) {
        store.attachCaptionBlock(frame.layout.activeBlockId);
        const attachedAnchorY = settledCaptionAnchorY(frame);
        keyboardPlacement = {
          attached: true,
          requestedPositionYPct:
            (attachedAnchorY ?? frame.layout.requestedAnchorY) / height,
        };
      } else {
        const attachedAnchorY = settledCaptionAnchorY(frame);
        const current = frame.keyboardPlacement
          ? frame.keyboardPlacement.requestedPositionYPct
          : frame.layout.style.pinToSplit
            ? (attachedAnchorY ?? frame.layout.requestedAnchorY) / height
            : frame.layout.requestedAnchorY / height;
        const step = event.shiftKey ? 0.1 : 0.01;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? 1
              : Math.max(
                  0,
                  Math.min(
                    1,
                    current + (event.key === "ArrowUp" ? -step : step)
                  )
                );
        store.detachCaptionBlock(frame.layout.activeBlockId, next, {
          discrete: true,
        });
        keyboardPlacement = {
          attached: false,
          requestedPositionYPct: next,
        };
      }
      const nextStore = useRepurposeStore.getState();
      captionFrameRef.current = {
        ...frame,
        projectEpoch: nextStore.projectEpoch,
        captionBlocks: nextStore.captionBlocks,
        keyboardPlacement,
      };
      updateCaptionSliderValue(
        event.currentTarget,
        keyboardPlacement.requestedPositionYPct,
        keyboardPlacement.attached
      );
    },
    [currentCaptionFrame, height, settledCaptionAnchorY]
  );

  // ---------------------------------------------------------------------
  // Split-handle drag: freeze the scene/global target and store transaction at
  // pointer-down. A local transient ratio bypasses cut easing during direct
  // manipulation; releasing returns every consumer to frame-resolved playback.
  // ---------------------------------------------------------------------
  const finishSplitGesture = useCallback(
    (
      gesture: SplitDividerGesture,
      mode: "end" | "cancel",
      restoreFrame = true
    ) => {
      if (splitGestureRef.current !== gesture) return;
      splitGestureRef.current = null;
      window.removeEventListener("pointermove", gesture.onMove);
      window.removeEventListener("pointerup", gesture.onUp);
      window.removeEventListener("pointercancel", gesture.onCancel);
      try {
        gesture.element.releasePointerCapture(gesture.pointerId);
      } catch {
        // Capture may already have been released by the browser or node removal.
      }
      transientSplitRef.current = null;
      const store = useRepurposeStore.getState();
      if (mode === "end") store.endSplitRatioGesture(gesture.token);
      else store.cancelSplitRatioGesture(gesture.token);

      if (restoreFrame) {
        const resolved = effectiveSplitRatio(
          splitRatioAt(store.clips, store.playhead, store.splitRatio),
          height
        );
        liveSplitRef.current = resolved;
        handleSplitRef.current = resolved;
        setHandleSplit(resolved);
      }
    },
    [height]
  );

  useEffect(() => {
    const unsubscribe = useRepurposeStore.subscribe((state, previous) => {
      const gesture = splitGestureRef.current;
      if (!gesture || splitGestureStoreUpdateRef.current) return;
      if (
        state.projectEpoch !== previous.projectEpoch ||
        state.clips !== previous.clips ||
        state.splitRatio !== previous.splitRatio
      ) {
        finishSplitGesture(gesture, "cancel");
      }
    });
    const unsubscribeCancellation = useRepurposeStore
      .getState()
      .subscribeSplitRatioGestureCancellation(() => {
        const gesture = splitGestureRef.current;
        if (gesture) finishSplitGesture(gesture, "cancel");
      });
    return () => {
      unsubscribe();
      unsubscribeCancellation();
      const gesture = splitGestureRef.current;
      if (gesture) finishSplitGesture(gesture, "cancel", false);
    };
  }, [finishSplitGesture]);

  const handleDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const container = containerRef.current;
      if (!container) return;

      const previous = splitGestureRef.current;
      if (previous) finishSplitGesture(previous, "cancel");

      pause();
      const store = useRepurposeStore.getState();
      const active = activeClipAt(store.clips, store.playhead);
      const gestureTarget = active
        ? ({ kind: "clip", id: active.id } as const)
        : ({ kind: "global" } as const);
      const token = store.beginSplitRatioGesture(gestureTarget);
      if (token === null) return;

      const pointerId = e.pointerId;
      const target = e.currentTarget;
      target.setPointerCapture(pointerId);
      const onMove = (moveEvent: PointerEvent) => {
        const gesture = splitGestureRef.current;
        if (!gesture || gesture.token !== token || moveEvent.pointerId !== pointerId) {
          return;
        }
        const rect = container.getBoundingClientRect();
        if (rect.height <= 0) return;
        const localY = moveEvent.clientY - rect.top;
        const ratio = snapPointerSplitRatio(localY / rect.height);
        transientSplitRef.current = ratio;
        const effective = effectiveSplitRatio(ratio, height);
        handleSplitRef.current = effective;
        setHandleSplit(effective);
        splitGestureStoreUpdateRef.current = true;
        try {
          useRepurposeStore
            .getState()
            .updateSplitRatioGesture(token, ratio);
        } finally {
          splitGestureStoreUpdateRef.current = false;
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        const gesture = splitGestureRef.current;
        if (gesture?.token === token) finishSplitGesture(gesture, "end");
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        const gesture = splitGestureRef.current;
        if (gesture?.token === token) finishSplitGesture(gesture, "cancel");
      };
      splitGestureRef.current = {
        pointerId,
        token,
        element: target,
        onMove,
        onUp,
        onCancel,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [finishSplitGesture, height, pause]
  );

  const handleDividerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let delta = 0;
      let endpoint: number | null = null;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") delta = -0.01;
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") delta = 0.01;
      else if (e.key === "Home") endpoint = 0;
      else if (e.key === "End") endpoint = 1;
      else return;
      e.preventDefault();

      const store = useRepurposeStore.getState();
      const active = activeClipAt(store.clips, store.playhead);
      const current = active?.splitRatio ?? store.splitRatio;
      const next = endpoint ?? clampSplitRatio(current + delta);
      if (next === null) return;
      if (active) store.setClipSplitRatio(active.id, next);
      else store.setSplitRatio(next);
    },
    []
  );

  // ---------------------------------------------------------------------
  // Per-region drag-to-pan + scroll-to-zoom. Both regions write ONE static
  // framing onto the ACTIVE scene (the clip under the playhead) -- no keyframes.
  //   SCREEN: clip.screenFraming for this scene.
  //   FACE:   clip.faceFraming for this scene.
  // The scene holds that framing; the cut into the next scene eases to ITS
  // framing via the Smart transition (screenFramingAt / faceFramingAt).
  // ---------------------------------------------------------------------
  const dragStateRef = useRef<Record<"screen" | "face", RegionDragState | null>>({
    screen: null,
    face: null,
  });

  const currentTransformFor = useCallback(
    (track: "screen" | "face") => {
      // The framing actually composited at the playhead for this region (the
      // active scene's own static framing, transition-eased across the cut) --
      // so a drag STARTS from exactly what's on screen. A scene with no framing
      // of its own reads identity, not a previous scene's held-forward value.
      return track === "face"
        ? faceFramingAt(liveRef.current.clips, liveRef.current.playhead)
        : screenFramingAt(liveRef.current.clips, liveRef.current.playhead);
    },
    []
  );

  const writeTransform = useCallback(
    (track: "screen" | "face", patch: { x: number; y: number; scale: number }) => {
      const clamped = {
        x: clamp(patch.x, -1, 1),
        y: clamp(patch.y, -1, 1),
        scale: clamp(patch.scale, ZOOM_MIN, ZOOM_MAX),
      };
      // Both regions write ONE static framing onto the ACTIVE scene (the clip
      // under the playhead). No keyframes: the scene holds this framing, and the
      // cut into the next scene eases to ITS framing via the Smart transition.
      const active = activeClipAt(liveRef.current.clips, liveRef.current.playhead);
      if (!active) return;
      if (track === "face") setClipFaceFraming(active.id, clamped);
      else setClipScreenFraming(active.id, clamped);
    },
    [setClipFaceFraming, setClipScreenFraming]
  );

  // Core of a base-region reframe drag, decoupled from the DOM element it was
  // dispatched from. The consolidated preview pointer-down router (below) calls
  // this when a pointer-down MISSED every overlay and fell into a base band, so
  // face/screen still pan/zoom by drag exactly as before -- but through the ONE
  // interaction layer that also owns overlay selection (no fighting layers). The
  // region's pixel size is passed in explicitly (the router derives it from the
  // container rect + composited split) since there is no longer a per-region div
  // to measure from `e.currentTarget`.
  const beginRegionReframe = useCallback(
    (
      track: "screen" | "face",
      e: React.PointerEvent,
      regionWidthPx: number,
      regionHeightPx: number
    ) => {
      const pointerId = e.pointerId;
      const startTransform = currentTransformFor(track);
      dragStateRef.current[track] = {
        pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTransform,
      };

      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragStateRef.current[track];
        if (!drag) return;
        const dxPx = moveEvent.clientX - drag.startClientX;
        const dyPx = moveEvent.clientY - drag.startClientY;
        // Normalize screen-pixel drag delta to the [-1, 1] pan range. Dividing
        // by half the region size means dragging fully across the region pans
        // the full available range at scale 1; feels proportional at higher
        // zoom too since the underlying crop range shrinks with it.
        const dx = (dxPx / (regionWidthPx / 2)) * -1; // drag right -> pan left (content follows pointer)
        const dy = (dyPx / (regionHeightPx / 2)) * -1;
        writeTransform(track, {
          x: drag.startTransform.x + dx,
          y: drag.startTransform.y + dy,
          scale: drag.startTransform.scale,
        });
      };
      const onUp = () => {
        dragStateRef.current[track] = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [currentTransformFor, writeTransform]
  );

  // Scroll-to-zoom on the ONE consolidated interaction layer. Which base region
  // zooms is decided by the cursor's Y against the composited split seam (the
  // same seam the pan bands used to be split at), so screen (top) and face
  // (bottom) still zoom independently under the wheel.
  //
  // Attached NATIVELY with { passive: false } (see the effect below), NOT via
  // React's onWheel prop: React 17+ registers its delegated root 'wheel' listener
  // as PASSIVE, so an onWheel handler's preventDefault() is silently ignored and
  // the surrounding panel scrolls WHILE the region zooms (plus a console warning).
  // The Timeline already uses this same native-listener pattern for its zoom.
  const onLayerWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const el = interactionLayerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      const split = getEffectiveSplitRatio();
      const track: "screen" | "face" =
        split <= 0
          ? "face"
          : split >= 1
            ? "screen"
            : localY / rect.height < split
              ? "screen"
              : "face";
      const current = currentTransformFor(track);
      const zoomDelta = -e.deltaY * 0.0015;
      const nextScale = clamp(current.scale * (1 + zoomDelta), ZOOM_MIN, ZOOM_MAX);
      writeTransform(track, { x: current.x, y: current.y, scale: nextScale });
    },
    [currentTransformFor, getEffectiveSplitRatio, writeTransform]
  );

  // Bind the wheel-zoom handler as a NON-PASSIVE native listener so its
  // preventDefault() actually suppresses the page/panel scroll (a React onWheel
  // prop is passive, so preventDefault there is a no-op). Re-attaches if the
  // handler identity changes; cleans up on unmount.
  useEffect(() => {
    const el = interactionLayerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onLayerWheel, { passive: false });
    return () => el.removeEventListener("wheel", onLayerWheel);
  }, [onLayerWheel]);

  // ---------------------------------------------------------------------
  // CANVAS DIRECT-MANIPULATION -- one consolidated pointer-down router.
  // getRect feeds normalized<->screen mapping to the pure geometry + the DOM
  // chrome; it returns the preview canvas's live on-screen box (the container,
  // which the canvas fills edge-to-edge). All coordinates are fractions of this
  // rect, so the math is identical at preview size and at 1080p/4K export.
  // ---------------------------------------------------------------------
  const getRect = useCallback((): PreviewRect | null => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, []);

  const { routePointerDown, beginHandleGesture, adjustHandleByKeyboard } = useObjectSelection({
    getRect,
    getFrameSnapshot: getOverlayFrameSnapshot,
  });

  // Clicking ANYWHERE outside the preview container (transcript rail, inspector,
  // timeline, top bar, or the dark margin around the 9:16) clears the canvas
  // selection so the coral chrome disappears. The container -- not the canvas
  // rect -- is the boundary: the selection handles + toolbar are DOM siblings
  // that may bleed past the canvas box, but they still live inside this
  // container, so clicking them (to manipulate the selection) never deselects.
  useDeselectOnOutsideClick(containerRef);

  const selectClip = useRepurposeStore((s) => s.selectClip);
  const selectOverlay = useRepurposeStore((s) => s.selectOverlay);

  // The single pointer-down on the interaction layer. Order (topmost first):
  //   overlay hit -> the hook already selected it + began a move drag (nothing
  //     more to do here).
  //   base hit -> select the ACTIVE clip (so the base gets a selection + the
  //     reset-framing toolbar) AND reuse the region reframe drag for pan.
  //   empty -> deselect everything.
  const onLayerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // A pointer-down on a child that stopped propagation (the split handle, a
      // selection handle, the toolbar) never reaches here. Everything else routes.
      const route = routePointerDown(e);
      if (route.kind === "overlay") {
        e.preventDefault();
        e.stopPropagation();
        return; // hook owns the move drag
      }
      if (route.kind === "base") {
        e.preventDefault();
        e.stopPropagation();
        // Select the clip under the playhead so the base object reads as
        // selected (toolbar reset-framing); no clip = leave selection cleared.
        const active = activeClipAt(liveRef.current.clips, liveRef.current.playhead);
        if (active) selectClip(active.id);
        else selectOverlay(null);
        // Reuse the existing per-region reframe drag. Region pixel height is the
        // band's share of the container per the composited split.
        const rect = e.currentTarget.getBoundingClientRect();
        const regionWidthPx = rect.width;
        const split = getEffectiveSplitRatio();
        const regionHeightPx =
          route.region === "screen" ? rect.height * split : rect.height * (1 - split);
        beginRegionReframe(route.region, e, regionWidthPx, regionHeightPx);
        return;
      }
      // Empty -> clear any selection.
      selectOverlay(null);
      selectClip(null);
    },
    [
      routePointerDown,
      beginRegionReframe,
      selectClip,
      selectOverlay,
      getEffectiveSplitRatio,
    ]
  );

  // ---------------------------------------------------------------------
  // Keyboard on a SELECTED OVERLAY: pixel arrow-nudge, z-order chords, and
  // Esc-deselect. Delete/Backspace and Cmd+D are already owned by the Timeline's
  // window handler (gated on the same selectedOverlayId), so we deliberately do
  // NOT re-bind them here -- that would double-fire. We own the behaviors the
  // timeline doesn't:
  //   - Arrow = 1px nudge, Shift+Arrow = 10px (industry convention). "1px" is one
  //     ON-SCREEN preview pixel, mapped through the live preview rect to normalized
  //     (dxNorm = px / rect.width, dyNorm = px / rect.height) -- the exact same
  //     screen-px -> normalized mapping the drag paths use, so nudge and drag agree.
  //   - Cmd/Ctrl+] bring forward, Cmd/Ctrl+[ send backward (setOverlayZ).
  //   - Esc clears the selection.
  // Nudge writes only the explicit user delta onto the persisted transform. The
  // frame resolver keeps the rendered overlay seam-safe without baking a
  // transition's temporary correction. Gated off the transcript panel + any
  // editable target so typing never nudges or re-stacks an overlay.
  // ---------------------------------------------------------------------
  const updateOverlayTransform = useRepurposeStore((s) => s.updateOverlayTransform);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("#transcript-panel") ||
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      const store = useRepurposeStore.getState();
      if (!store.selectedOverlayId && store.selectedOverlayIds.length === 0) return;

      if (e.key === "Escape") {
        e.preventDefault();
        store.selectOverlay(null);
        return;
      }

      const settledSplit = getSettledSplitRatio();
      const primary = resolveEffectivePrimaryOverlay(
        store.overlays,
        store.selectedOverlayIds,
        store.selectedOverlayId,
        settledSplit
      );
      if (!primary) return;
      const id = primary.id;

      // Overlay Cmd/Ctrl+D belongs here rather than Timeline: only the preview
      // owns the current CSS rect and frame-effective (possibly per-scene) split.
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyD") {
        const rect = getRect();
        if (!rect) return;
        e.preventDefault();
        useRepurposeStore
          .getState()
          .duplicateOverlay(id, rect, settledSplit);
        return;
      }

      // ] / [ -- restack the overlay among overlays (layer up / layer down).
      // Bare press = one step; Shift = all the way to front/back. The legacy
      // Cmd/Ctrl chords keep working (same one-step action). code-based so it
      // is keyboard-layout stable, matching the Timeline chords.
      if (e.code === "BracketRight") {
        e.preventDefault();
        useRepurposeStore
          .getState()
          .setOverlayZ(id, e.shiftKey ? "front" : "forward");
        return;
      }
      if (e.code === "BracketLeft") {
        e.preventDefault();
        useRepurposeStore
          .getState()
          .setOverlayZ(id, e.shiftKey ? "back" : "backward");
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        return; // any other mod-chord (undo/redo/dupe) is owned elsewhere
      }

      // Pixel nudge: 1px, Shift = 10px. Resolve to normalized through the LIVE
      // preview rect so a press moves exactly N on-screen pixels at any zoom.
      const px = e.shiftKey ? 10 : 1;
      let signX = 0;
      let signY = 0;
      if (e.key === "ArrowLeft") signX = -1;
      else if (e.key === "ArrowRight") signX = 1;
      else if (e.key === "ArrowUp") signY = -1;
      else if (e.key === "ArrowDown") signY = 1;
      else return;
      e.preventDefault();

      const rect = getRect();
      if (!rect) return;
      const ov = useRepurposeStore.getState().overlays.find((o) => o.id === id);
      if (!ov) return;

      updateOverlayTransform(id, {
        x: ov.transform.x + (signX * px) / rect.width,
        y: ov.transform.y + (signY * px) / rect.height,
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [updateOverlayTransform, getRect, getSettledSplitRatio]);

  // ---------------------------------------------------------------------
  // "P" = drop a mid-clip ZOOM PUNCH-IN at the playhead on the active scene.
  //   P        -> SCREEN region (the common case: punch into the screen detail)
  //   Shift+P  -> FACE region
  // Adds a default punch (amount 0.25 = +25%, holdSec 0.6) centered at the
  // active clip's SOURCE time under the playhead. A keypress has no cursor, so
  // the region is chosen by the modifier, not by pointer Y. Gated off the
  // transcript panel + any editable target so typing a "p" never punches. One
  // discrete undo step (setClipPunch commits with its own coalesce key).
  // ---------------------------------------------------------------------
  const setClipPunch = useRepurposeStore((s) => s.setClipPunch);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "p" && e.key !== "P") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd/Ctrl+P (print) alone
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("#transcript-panel") ||
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      const { clips: liveClips, playhead: t } = liveRef.current;
      const active = activeClipAt(liveClips, t);
      if (!active) return; // no scene under the playhead -- nothing to punch
      e.preventDefault();
      const region: "screen" | "face" = e.shiftKey ? "face" : "screen";
      // TOGGLE: if this region already carries a punch, the keypress REMOVES it
      // (mirrors the toolbar buttons); otherwise it adds the default punch.
      const existing = region === "screen" ? active.screenPunch : active.facePunch;
      if (existing != null) {
        setClipPunch(active.id, region, null);
        return;
      }
      const atSrc = active.srcStart + (t - active.timelineStart);
      setClipPunch(active.id, region, { atSrc, amount: 0.25, holdSec: 0.6, ease: "natural" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setClipPunch]);

  // ---------------------------------------------------------------------
  // The handle + region dividers follow the LIVE composited split (per-scene,
  // eased across cuts -- published each frame by the rAF loop), so the coral
  // handle always sits on the seam actually drawn, not the raw global default.
  const topPct = useMemo(() => handleSplit * 100, [handleSplit]);

  return (
    <div
      ref={containerRef}
      // overflow-VISIBLE: the ghosted off-frame overlay bleed + the
      // selection handles for an overlay dragged partway off-frame must be able
      // to paint OUTSIDE the 9:16 box. The black fill lives on the <canvas> leaf
      // node itself, so its bitmap edge clips the composited video to a crisp
      // FLAT rect (no rounded corners -- matches the exported reel) while its
      // siblings (ghost layer, snap guides, chrome) are free to bleed. The
      // page.tsx wrapper (max-w-[340px], no overflow-hidden)
      // and the flanking asides bound the bleed, and overflow:visible never
      // creates a page scrollbar, so nothing scrolls horizontally.
      className={`relative w-full select-none overflow-visible shadow-2xl ${className ?? ""}`}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      {/* Hidden source videos -- decoded frames only, never displayed directly. */}
      {/* src omitted until footage loads -- passing "" makes the browser try to
          load the page URL and logs an error. undefined leaves the element idle. */}
      {/* Audio source of truth: only ONE track plays. The ACTIVE face slot
          carries the narration (unmuted); everything else stays muted.
          SLOT_COUNT slots per source (double-buffer ring):
          slot 0 starts active, the rest sit paused + pre-seeked at the next
          discontinuous cuts. `muted` is set here only for the INITIAL state --
          after a swap it is managed imperatively in the rAF loop, and React
          never rewrites a prop whose value didn't change between renders, so
          the imperative flips stick. */}
      {SLOT_INDICES.map((slot) => (
        <video
          key={`screen-${screenSourceIdentity}-${slot}`}
          data-source-role="screen"
          data-slot-index={slot}
          ref={(el) => {
            screenElsRef.current[slot] = el;
            if (el) normalizeBaseMute();
          }}
          src={screenProxy.src}
          muted
          playsInline
          preload="auto"
          className="hidden"
          onCanPlay={(event) =>
            reportBaseCanPlay("screen", slot, event.currentTarget)
          }
          onError={() => {
            if (screenProxy.usingProxy) screenProxy.onSrcError();
            else reportRequiredBaseError("screen", slot);
          }}
        />
      ))}
      {/* Face slots read faceProxy.src -- the original streaming URL until the
          low-res preview proxy is built + a pause lets it swap in. Export
          never sees this: it reads footageMeta.faceCamPath directly. onError
          falls back for a purged proxy, but reports a real raw-source failure. */}
      {SLOT_INDICES.map((slot) => (
        <video
          key={`face-${faceSourceIdentity}-${slot}`}
          data-source-role="face"
          data-slot-index={slot}
          ref={(el) => {
            faceElsRef.current[slot] = el;
            if (el) normalizeBaseMute();
          }}
          src={faceProxy.src}
          muted
          playsInline
          preload="auto"
          className="hidden"
          onCanPlay={(event) =>
            reportBaseCanPlay("face", slot, event.currentTarget)
          }
          onError={() => {
            if (faceProxy.usingProxy) faceProxy.onSrcError();
            else reportRequiredBaseError("face", slot);
          }}
        />
      ))}

      {/* Overlay <video> pool -- one hidden, ALWAYS-muted element per video
          overlay, keyed by id. The ref callback registers/unregisters it in
          videoPoolRef so the rAF loop can seek + drawImage it every frame; a
          removed overlay's element unmounts and its map entry is cleared. An
          overlay never emits audio, so `muted` is permanent. */}
      {overlays
        .filter((o) => o.kind === "video")
        .map((o) => (
          <PreviewOverlayVideo
            key={`${o.id}\u0000${o.src}`}
            overlay={o}
            isPlaying={isPlaying}
            register={(el, previewSrc) => {
              if (el) {
                videoPoolRef.current.set(o.id, el);
                overlayPreviewSrcRef.current.set(o.id, previewSrc);
              } else if (
                videoPoolRef.current.get(o.id)?.dataset.overlaySrc === previewSrc
              ) {
                videoPoolRef.current.delete(o.id);
                if (overlayPreviewSrcRef.current.get(o.id) === previewSrc) {
                  overlayPreviewSrcRef.current.delete(o.id);
                }
              }
            }}
            reportFailure={() => reportOverlayFailure(o.id, o.src)}
          />
        ))}
      {/* GHOSTED OFF-FRAME OVERFLOW -- a dim, non-interactive copy of
          each active overlay's media, positioned with the SAME normalized ->
          screen mapping the compositor uses, sitting BEHIND the canvas (z-0).
          The part of each ghost that falls INSIDE the 9:16 frame is painted over
          by the opaque canvas (z-[1]) at full fidelity; only the part that bleeds
          OUTSIDE the frame shows through, at reduced opacity -- so an overlay
          dragged/zoomed off-frame stays visible + grabbable without any change to
          the clipped canvas render or the export (DOM-only, like the grid). */}
      <GhostOverflowLayer
        getRect={getRect}
        getFrameSnapshot={getOverlayFrameSnapshot}
        getOverlayPreviewSrc={getOverlayPreviewSrc}
      />

      {/* The composited video. FLAT-edged to match the exported reel exactly --
          the real 1080x1920 output has no rounded corners, so the preview must not
          fake a phone-frame roundness (it was purely cosmetic CSS, never in the
          export). z-[1] so it paints OVER the inside portion of the ghost. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-[1] h-full w-full bg-black"
      />

      {/* Alignment grid -- rule-of-thirds guides + a brighter center crosshair,
          so an overlay can be eyeballed to dead center. pointer-events:none so
          it never blocks a drag; DOM-only so it is NEVER in the export. Percent
          positions, so it tracks any preview size. z-10 keeps it under the
          selection chrome. */}
      {showGrid && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {/* rule-of-thirds -- faint white lines at 1/3 and 2/3 */}
          <div className="absolute inset-y-0 left-1/3 w-px bg-white/20" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-white/20" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-white/20" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-white/20" />
          {/* center crosshair -- brighter coral so "dead center" reads instantly */}
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#FF6B35]/60" />
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#FF6B35]/60" />
          <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#FF6B35]/80" />
        </div>
      )}

      {/* MAGNETIC SNAP GUIDES -- the coral dashed alignment lines drawn
          while an overlay is being dragged and one of its edges/center snaps to a
          frame line, the split seam, a rule-of-thirds line, or another overlay.
          Reads the transient `activeSnapGuides` from the store (set by the move
          gesture, [] otherwise, so the lines appear only mid-drag). Sits above the
          grid (z-10) and interaction layer but below the selection chrome (z-20);
          pointer-events:none + DOM-only, so it NEVER blocks a drag or bakes into
          the export. */}
      <SnapGuides />

      {/* low-res proxy build progress -- a quiet pill while the one-time ffmpeg
          pass runs in the background. DOM-only (never in the export), gone the
          moment the proxy is ready. Playback keeps using the original file
          until the swap, so this is purely informational. */}
      {(faceProxy.buildProgress !== null || screenProxy.buildProgress !== null) && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium tracking-wide text-white/75">
          Preparing fast preview {Math.round(Math.max(faceProxy.buildProgress ?? 0, screenProxy.buildProgress ?? 0) * 100)}%
        </div>
      )}

      {/* CONSOLIDATED interaction layer -- ONE full-canvas surface that routes
          every pointer-down through the overlay hit-test first (select + drag an
          overlay), then falls back to the base-region reframe (pan/zoom the
          face/screen scene), then to deselect. This replaces the two separate
          pan bands so the overlay selection never fights them. The split handle,
          the selection handles, and the toolbar are siblings ABOVE this layer
          with pointer-events + stopPropagation, so they win the hit-test and
          this router never sees their grabs. */}
      <div
        ref={interactionLayerRef}
        className={`absolute inset-0 z-[2] ${cloneModifier ? "cursor-copy" : "cursor-move"}`}
        style={{ zIndex: 2, pointerEvents: "auto" }}
        onPointerDown={onLayerPointerDown}
        title="Click an overlay to select; drag to move it. Shift-click to multi-select, Cmd/Ctrl-drag to clone. Drag the canvas to pan / scroll to zoom."
      />

      {/* Bounds-sized transparent caption surface. The render loop projects the
          exact layout it just painted into CSS pixels without scheduling React. */}
      <div
        ref={captionHitTargetRef}
        role="slider"
        aria-label="Move active caption"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        tabIndex={0}
        className="absolute touch-none"
        style={{ zIndex: 15 }}
        hidden
        onPointerDown={handleCaptionPointerDown}
        onKeyDown={handleCaptionKeyDown}
      />
      <div
        ref={captionSnapGuideRef}
        data-caption-snap-guide
        className="pointer-events-none absolute inset-x-0"
        style={{ zIndex: 16, height: 1, backgroundColor: "#FF6B35" }}
        hidden
      />

      {/* Split handle -- the seam stays draggable and keyboard-adjustable, but
          the always-on coral pill is GONE: it
          overlapped the captions sitting on the seam and got in the way. The pill
          now shows ONLY on hover, so the divider is discoverable when you reach
          for it yet invisible the rest of the time. */}
      <div
        role="separator"
        aria-label="Adjust screen and face split"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={topPct}
        tabIndex={0}
        className="group absolute inset-x-0 z-10 flex touch-none cursor-ns-resize items-center justify-center"
        style={{
          top: `${topPct}%`,
          height: 16,
          marginTop: -8,
          zIndex: 10,
          pointerEvents: "auto",
        }}
        onPointerDown={handleDividerPointerDown}
        onKeyDown={handleDividerKeyDown}
      >
        <div className="h-[3px] w-10 rounded-full bg-[#FF6B35] opacity-0 shadow-[0_0_0_3px_rgba(0,0,0,0.35)] transition-opacity group-hover:opacity-100" />
      </div>

      {/* Selection chrome (DOM only -- never drawn into the canvas, so the
          export stays clean). The box body is pointer-events:none so a drag on
          the media falls through to the router above; only the 8 resize handles
          + the rotate grip opt in and forward to beginHandleGesture. */}
      <SelectionOverlay
        getRect={getRect}
        getFrameSnapshot={getOverlayFrameSnapshot}
        beginHandleGesture={beginHandleGesture}
        adjustHandleByKeyboard={adjustHandleByKeyboard}
      />
      {/* Floating, always-upright toolbar for whatever is selected. */}
      <SelectionToolbar
        getRect={getRect}
        getFrameSnapshot={getOverlayFrameSnapshot}
        getSettledSplitRatio={getSettledSplitRatio}
      />
    </div>
  );
}
