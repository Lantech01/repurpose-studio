"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useProjectPersistence (per-project, disk-backed)
// ===========================================================================
// Loads + autosaves ONE project (identified by the route's projectId) to disk
// via the projects API, replacing the old single-slot sessionStorage snapshot.
// Projects live forever under ~/Downloads/repurpose-projects/<id>.json; a new
// video never overwrites an old one because each project is its own file under
// its own dated-slug URL.
//
// PROJECT ID SHAPES
//   - "new-<rand>": a provisional project the hub minted (no disk file yet). The
//     editor boots empty, the demo/manual ingest fills it, and on the first real
//     content we DERIVE a name, mint a dated slug (e.g.
//     "claude-routines-automation-13-jul-26"), CREATE the file, and
//     router.replace the URL to that slug.
//   - a real dated slug: loaded from disk on mount.
//
// LIFECYCLE
//   (A) LOAD -- effect keyed on projectId. new-* -> reset to empty. Same id we
//       already own (after a create's router.replace) -> no-op. Else fetch the
//       project, reset the store, hydrate the snapshot, reseed id counters.
//   (B) AUTOSAVE -- a debounced store subscription POSTs the snapshot to disk,
//       but only once the project actually EXISTS (has a built timeline or
//       footage). The FIRST such change auto-creates the project (see above).
//   (C) FLUSH -- pagehide/visibility-hidden beacons the latest snapshot so an
//       edit in the last <debounce> before a reload/close is not lost.
//   (D) [removed] -- no beforeunload confirm; autosave + (C) flush make it moot.
//   (E) WARM WORKER -- pre-spawn the export Worker on mount.
//
// KEPT VERBATIM from the old sessionStorage version: snapshotFromStore,
// migrateLegacyFraming, the src-re-derivation-from-sourcePath restore logic (so
// a reload never restores a dead blob: URL), reseedIdCounters, the caption
// self-heal, the footageNeedsReimport flagging, and the worker prespawn. Only
// the STORAGE BACKEND (sessionStorage -> disk) and the
// SCOPE (single slot -> per project) changed.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  normalizeCaptionBlockPlacement,
  useRepurposeStore,
  reseedIdCounters,
} from "@/lib/repurpose/store";
import { prespawnWorker, disposeWarmWorker } from "@/lib/export/workerBridge";
import type {
  Clip,
  FaceFraming,
  FootageMeta,
  MediaAsset,
  MusicTrack,
  Overlay,
  ProjectSnapshot,
  SfxTrack,
  VideoSourceRecord,
  VideoSourceTarget,
} from "@/lib/repurpose/types";
import type {
  CompatibilityState,
  MediaInspection,
} from "@/lib/repurpose/media-types";
import {
  footagePathFromUrl,
  footageUrlForPath,
} from "@/lib/repurpose/ingest";
import {
  cancelCompatibilityJob,
  VideoImportError,
  reconcileVideoPreview,
  reconcileVideoSource,
  videoUrlForWorkingSource,
} from "@/lib/repurpose/video-import-client";
import { ensureVideoProxy } from "@/lib/repurpose/video-proxy-client";
import { probeBrowserVideo } from "@/lib/repurpose/native-media-probe";
import { normalizeTranscriptWords } from "@/lib/repurpose/transcript-ingest";
import {
  clampSplitRatio,
  parsePersistedSplitRatio,
} from "@/lib/repurpose/split-ratio";
import { normalizeOverlayAppearance } from "@/lib/repurpose/overlay-effects";
import type { CaptionBlock, CaptionStyle } from "@/lib/repurpose/captions";
import { datedSlug, deriveProjectTitle } from "./naming";

/** Debounce window (ms) for autosave writes -- collapses a drag/trim storm to one POST. */
const SAVE_DEBOUNCE_MS = 500;
const RECONNECT_REQUIRED_PATH = "reconnect:";

/** A projectId is provisional (no disk file yet) when it carries the hub's "new-" prefix. */
function isProvisionalId(id: string): boolean {
  return id.startsWith("new-");
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/** True when a footage path is a `blob:` object URL, which is dead after reload. */
function isDeadBlobPath(path: string | undefined | null): boolean {
  return typeof path === "string" && path.startsWith("blob:");
}

function needsMediaReconnect(path: string | undefined | null): boolean {
  return path === RECONNECT_REQUIRED_PATH || isDeadBlobPath(path);
}

function assetUrlForPath(path: string): string {
  return `/api/repurpose/asset?path=${encodeURIComponent(path)}`;
}

export function restoreFootageMeta(
  meta: FootageMeta | null
): FootageMeta | null {
  if (!meta) return null;
  const legacyFacePath = footagePathFromUrl(meta.faceCamPath);
  const legacyScreenPath = footagePathFromUrl(meta.screenPath);
  return {
    ...meta,
    faceCamPath: meta.faceCamSource
      ? videoUrlForWorkingSource(meta.faceCamSource)
      : legacyFacePath
        ? footageUrlForPath(legacyFacePath)
        : meta.faceCamPath,
    screenPath: meta.screenSource
      ? videoUrlForWorkingSource(meta.screenSource)
      : legacyScreenPath
        ? footageUrlForPath(legacyScreenPath)
        : meta.screenPath,
  };
}

export function restoreMediaAsset(asset: MediaAsset): MediaAsset {
  if (asset.kind === "video") {
    if (asset.videoSource) {
      return {
        ...asset,
        src: videoUrlForWorkingSource(asset.videoSource),
        sourcePath: asset.videoSource.workingPath,
      };
    }
    const legacyPath = asset.sourcePath ?? footagePathFromUrl(asset.src);
    return legacyPath
      ? {
          ...asset,
          src: footageUrlForPath(legacyPath),
          sourcePath: legacyPath,
        }
      : asset;
  }
  return asset.sourcePath
    ? { ...asset, src: assetUrlForPath(asset.sourcePath) }
    : asset;
}

function restoreOverlay(overlay: Overlay): Overlay {
  if (!isStructurallyValidOverlay(overlay)) {
    throw new TypeError("Invalid persisted overlay");
  }
  const appearance = normalizeOverlayAppearance(overlay);
  const normalized: Overlay = {
    ...overlay,
    entranceEffect: { ...appearance.entranceEffect },
    exitEffect: { ...appearance.exitEffect },
    cornerRadius: appearance.cornerRadius,
  };
  if (normalized.kind !== "video") return normalized;
  if (normalized.videoSource) {
    return {
      ...normalized,
      src: videoUrlForWorkingSource(normalized.videoSource),
      sourcePath: normalized.videoSource.workingPath,
    };
  }
  const legacyPath = normalized.sourcePath ?? footagePathFromUrl(normalized.src);
  return legacyPath
    ? {
        ...normalized,
        src: footageUrlForPath(legacyPath),
        sourcePath: legacyPath,
      }
    : normalized;
}

/** Build a snapshot (the persisted slice) from the current store state. */
function snapshotFromStore(): ProjectSnapshot {
  const s = useRepurposeStore.getState();
  const footageMeta = restoreFootageMeta(s.footageMeta);
  const mediaAssets = s.mediaAssets
    .map(restoreMediaAsset)
    .map((asset) =>
      isDeadBlobPath(asset.src)
        ? { ...asset, src: RECONNECT_REQUIRED_PATH }
        : asset
    );
  const overlays = s.overlays
    .map(restoreOverlay)
    .map((overlay) =>
      isDeadBlobPath(overlay.src)
        ? { ...overlay, src: RECONNECT_REQUIRED_PATH }
        : overlay
    );
  return {
    // Per-scene framing (screenFraming / faceFraming) rides inside each clip, so
    // persisting `clips` persists it too -- no separate keyframe/global fields.
    clips: s.clips,
    duration: s.duration,
    splitRatio: s.splitRatio,
    screenGrade: s.screenGrade,
    faceGrade: s.faceGrade,
    playhead: s.playhead,
    inPoint: s.inPoint,
    outPoint: s.outPoint,
    loopPlayback: s.loopPlayback,
    footageMeta: footageMeta
      ? {
          ...footageMeta,
          faceCamPath: isDeadBlobPath(footageMeta.faceCamPath)
            ? RECONNECT_REQUIRED_PATH
            : footageMeta.faceCamPath,
          screenPath: isDeadBlobPath(footageMeta.screenPath)
            ? RECONNECT_REQUIRED_PATH
            : footageMeta.screenPath,
        }
      : null,
    words: s.words,
    captionsEnabled: s.captionsEnabled,
    captionStyle: s.captionStyle,
    captionBlocks: s.captionBlocks,
    snapEnabled: s.snapEnabled,
    markers: s.markers,
    deletedWordIndices: s.deletedWordIndices,
    overlays,
    sfxTrack:
      s.sfxTrack?.sourcePath
        ? {
            ...s.sfxTrack,
            src: `/api/repurpose/sfx?path=${encodeURIComponent(s.sfxTrack.sourcePath)}`,
          }
        : null,
    musicTrack:
      s.musicTrack?.sourcePath
        ? {
            ...s.musicTrack,
            src: assetUrlForPath(s.musicTrack.sourcePath),
          }
        : null,
    mediaAssets,
  };
}

/** A framing is neutral (identity) when it neither pans nor zooms. */
function isIdentityFraming(f: { x: number; y: number; scale: number }): boolean {
  return f.x === 0 && f.y === 0 && f.scale === 1;
}

/** Clamp a legacy framing into the store's valid pan/zoom ranges. */
function clampFraming(f: { x: number; y: number; scale: number }): FaceFraming {
  return {
    x: Math.min(1, Math.max(-1, f.x)),
    y: Math.min(1, Math.max(-1, f.y)),
    scale: Math.min(6, Math.max(1, f.scale)),
  };
}

/**
 * Migrate a LEGACY snapshot's flat pan/zoom onto per-clip framing (unchanged from
 * the old version). Old model: SCREEN pan/zoom as keyframes (`screenKeyframes`),
 * FACE as ONE global framing. New model: one static framing per scene on the clip.
 * Folds legacy values onto each kept clip so an old project keeps its zooms.
 */
function migrateLegacyFraming(clips: Clip[], snapshot: ProjectSnapshot): Clip[] {
  const legacyScreenKfs = snapshot.screenKeyframes ?? [];
  const legacyFaceRaw = snapshot.faceFraming ?? snapshot.faceKeyframes?.[0];
  const legacyFace =
    legacyFaceRaw && !isIdentityFraming(legacyFaceRaw)
      ? clampFraming(legacyFaceRaw)
      : undefined;

  if (legacyScreenKfs.length === 0 && !legacyFace) return clips;

  return clips.map((clip) => {
    if (!clip.kept) return clip;
    let next = clip;

    if (clip.screenFraming === undefined && legacyScreenKfs.length > 0) {
      const kf = legacyScreenKfs.find(
        (k) => k.t >= clip.timelineStart && k.t < clip.timelineEnd
      );
      if (kf && !isIdentityFraming(kf)) {
        next = { ...next, screenFraming: clampFraming(kf) };
      }
    }

    if (clip.faceFraming === undefined && legacyFace) {
      next = { ...next, faceFraming: legacyFace };
    }

    return next;
  });
}

/**
 * The current default Smart transition (kept in sync with ingest.ts and
 * lib/repurpose/fcpxml-import.ts). DESCRIPT-FEEL: a SUBTLE settle, never a pop.
 * `amount: 0.025` -> the incoming clip starts 2.5% larger and eases to normal
 * (compositor boost = 1 + amount*(1-e)), giving every real cut a gentle "landed"
 * motion even when framing matches -- the smooth, natural feel of Descript's
 * Smart Transition, far below a zoom "pop". ~0.4s natural matches Descript's soft
 * window.
 */
const NEW_DEFAULT_TRANSITION: NonNullable<Clip["transitionIn"]> = {
  type: "zoom-settle",
  durationSec: 0.4,
  amount: 0.025,
  easing: "natural",
};

/**
 * A continuous same-take join: two adjacent clips whose source is within this
 * many seconds are one take the timeline split (e.g. a caption boundary), NOT a
 * scene change. Those must carry NO transition -- a transition there is the
 * forced "pop after every scene" Manthan flagged. Mirrors CUT_GAP in the tool.
 */
const CUT_GAP = 0.4;

/** Is `tr` an auto-generated Smart transition (vs. a deliberate user choice we
 *  must never touch)? Auto shapes are the historical app defaults: the legacy 5%
 *  pop (0.05), the interim pure-ease (0), and the current subtle Descript-feel
 *  settle (0.025). A `type: "none"` (explicit hard cut), a slide, or any other
 *  amount is treated as user intent and preserved untouched. */
function isAutoTransition(tr: Clip["transitionIn"]): boolean {
  return (
    !!tr &&
    tr.type === "zoom-settle" &&
    (tr.amount === 0.05 || tr.amount === 0 || tr.amount === 0.025)
  );
}

/**
 * Bring a project's cuts to the "gentle ease on a REAL cut, NOTHING on a
 * continuous same-take join" rule -- and heal the OLD "pop on every cut" era.
 *
 * The old default put a 5% zoom-push on EVERY non-opening cut (and rule (2) here
 * force-added one to any kept clip missing it), so continuous speech the timeline
 * merely split read as a zoom pop after every line. Now:
 *   - CONTINUOUS join (source gap <= CUT_GAP): drop any AUTO transition -> a
 *     clean, jump-free cut. One take must read as one shot.
 *   - REAL cut (source gap > CUT_GAP): normalize any AUTO transition (legacy 5%
 *     pop or interim amount-0 ease) to the current subtle Descript-feel settle
 *     (NEW_DEFAULT_TRANSITION). We do NOT force-add one where absent.
 *
 * PRESERVED: the opening frame (nothing before it), an explicit `type: "none"`
 * hard cut, a slide, or any user-customized amount/duration (see isAutoTransition).
 * Idempotent: a clip already on the current default over a real cut is unchanged.
 */
function migrateSmartTransitions(clips: Clip[]): Clip[] {
  return clips.map((clip, i) => {
    const tr = clip.transitionIn;
    if (i === 0 || !isAutoTransition(tr)) return clip; // opening / user-owned

    const prev = clips[i - 1];
    const gap =
      prev && typeof prev.srcEnd === "number" && typeof clip.srcStart === "number"
        ? clip.srcStart - prev.srcEnd
        : Infinity; // unknown source -> treat as a real cut (keep a gentle ease)

    // Continuous same-take join -> no transition (kill the forced pop).
    // +1e-6 absorbs float error so a gap of exactly CUT_GAP counts as continuous.
    if (gap <= CUT_GAP + 1e-6) return { ...clip, transitionIn: undefined };

    // Real cut -> current subtle settle. No-op if it's already exactly that.
    if (
      tr &&
      tr.amount === NEW_DEFAULT_TRANSITION.amount &&
      tr.durationSec === NEW_DEFAULT_TRANSITION.durationSec
    ) {
      return clip;
    }
    return { ...clip, transitionIn: { ...NEW_DEFAULT_TRANSITION } };
  });
}

/**
 * Heal divergent per-clip `faceFraming` overrides left over from BEFORE the
 * face-cam sync toggle existed (or from a session with sync off). The face cam
 * is a locked camera -- Manthan flagged the pan/zoom EASING between two
 * different per-clip crops at every cut as a visible "jump"/"pop" on his face,
 * not the intended subtle Smart-transition settle (see `faceFramingAt` in
 * ../../../lib/repurpose/time-map.ts, which eases whenever two clips' framings
 * differ). Collapses every kept clip's `faceFraming` onto the FIRST one found
 * (deterministic, no picking/UI needed), so a reload of an old project reads as
 * one still face cam again. No-op when framings already agree or none is set.
 */
function migrateFaceFramingSync(clips: Clip[]): Clip[] {
  const kept = clips.filter((c) => c.kept);
  const first = kept.find((c) => c.faceFraming !== undefined)?.faceFraming;
  if (!first) return clips; // nobody has an override -> nothing to reconcile

  const allMatch = kept.every(
    (c) =>
      c.faceFraming !== undefined &&
      c.faceFraming.x === first.x &&
      c.faceFraming.y === first.y &&
      c.faceFraming.scale === first.scale
  );
  if (allMatch) return clips;

  return clips.map((c) =>
    c.kept && c.faceFraming !== first ? { ...c, faceFraming: { ...first } } : c
  );
}

/**
 * Default SCREEN zoom for every scene that has never been framed by hand:
 * 115%, BOTTOM-ANCHORED (Manthan, 2026-07-10). The whole point of the zoom is
 * to hide the macOS menu bar + Chrome tab strip + URL bar that live along the
 * TOP of his screen recordings: y=+1 pins the crop to the source's bottom
 * edge (crop center = center + y*maxOffset in the compositor, so +1 = bottom
 * flush with the split line) and the ~13% the 1.15x crop removes comes
 * entirely off the top -- exactly the browser chrome. Applied as a load-time
 * migration per the "every default change auto-migrates all saved projects"
 * rule: any kept clip with NO screenFraming at all gets {0, 1, 1.15}. A clip
 * with ANY explicit framing -- including one Manthan deliberately set back to
 * 100% -- is user intent and stays byte-for-byte, with ONE exception: the
 * short-lived center-anchored default {0, 0, 1.15} is
 * rewritten to the bottom-anchored form, healing projects that loaded during
 * the hour it existed. Reset framing clears back to undefined, so a reset
 * scene re-adopts this default on next load; that IS the default now.
 * Idempotent; runs on every project open, so future projects are covered the
 * first time they load.
 */
const DEFAULT_SCREEN_FRAMING = { x: 0, y: 1, scale: 1.15 } as const;
function migrateScreenZoomDefault(clips: Clip[]): Clip[] {
  return clips.map((c) => {
    if (!c.kept) return c;
    const f = c.screenFraming;
    const isOldCenterDefault =
      !!f && f.x === 0 && f.y === 0 && f.scale === 1.15;
    if (f !== undefined && !isOldCenterDefault) return c; // user-owned framing
    return { ...c, screenFraming: { ...DEFAULT_SCREEN_FRAMING } };
  });
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "video";
}

async function inspectLegacyVideoPath(
  path: string,
  signal: AbortSignal
): Promise<MediaInspection> {
  const response = await fetch(
    `/api/repurpose/media?path=${encodeURIComponent(path)}`,
    { signal }
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    if (code === "MEDIA_PATH_INVALID" || code === "MEDIA_INVALID") {
      throw new VideoImportError("VIDEO_SOURCE_RECONNECT_REQUIRED", body);
    }
    throw new VideoImportError(
      typeof code === "string" ? code : "MEDIA_INSPECTION_FAILED",
      body
    );
  }
  return body as MediaInspection;
}

function waitForLegacyCompatibility(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new VideoImportError("VIDEO_IMPORT_CANCELLED"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new VideoImportError("VIDEO_IMPORT_CANCELLED"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function readLegacyCompatibilityState(
  response: Response
): Promise<CompatibilityState> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    throw new VideoImportError(
      typeof code === "string" ? code : "COMPATIBILITY_START_FAILED",
      body
    );
  }
  return body as CompatibilityState;
}

async function reconcileLegacyVideoPath(
  path: string,
  originalName: string | undefined,
  signal: AbortSignal
): Promise<VideoSourceRecord> {
  const inspection = await inspectLegacyVideoPath(path, signal);
  const originalProbe = await probeBrowserVideo(footageUrlForPath(path), signal);
  if (signal.aborted) {
    throw new VideoImportError("VIDEO_IMPORT_CANCELLED");
  }
  if (originalProbe.decodable) {
    return {
      originalPath: path,
      workingPath: path,
      originalName: originalName || fileNameFromPath(path),
      inspection,
      nativeCompatible: true,
      compatibilityStatus: "native",
    };
  }

  let compatibilityActive = true;
  try {
    let state = await readLegacyCompatibilityState(
      await fetch("/api/repurpose/compatibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, fingerprint: inspection.fingerprint }),
        signal,
      })
    );
    while (state.status === "queued" || state.status === "building") {
      await waitForLegacyCompatibility(
        document.visibilityState === "hidden" ? 2_000 : 750,
        signal
      );
      state = await readLegacyCompatibilityState(
        await fetch(
          `/api/repurpose/compatibility?fingerprint=${encodeURIComponent(inspection.fingerprint)}`,
          { signal }
        )
      );
    }
    compatibilityActive = false;
    if (state.status !== "ready" || !state.workingPath) {
      throw new VideoImportError(
        state.error?.code ?? "COMPATIBILITY_ENCODE_FAILED",
        state
      );
    }
    const convertedProbe = await probeBrowserVideo(
      footageUrlForPath(state.workingPath),
      signal
    );
    if (signal.aborted) {
      throw new VideoImportError("VIDEO_IMPORT_CANCELLED");
    }
    if (!convertedProbe.decodable) {
      throw new VideoImportError("BROWSER_DECODE_FAILED", convertedProbe.reason);
    }
    return {
      originalPath: path,
      workingPath: state.workingPath,
      originalName: originalName || fileNameFromPath(path),
      inspection,
      nativeCompatible: false,
      compatibilityStatus: "converted",
    };
  } catch (error) {
    if (signal.aborted && compatibilityActive) {
      await cancelCompatibilityJob(inspection.fingerprint);
    }
    if (signal.aborted) {
      throw new VideoImportError("VIDEO_IMPORT_CANCELLED");
    }
    throw error;
  }
}

interface SourceAttempt {
  source: VideoSourceRecord | null;
  error: VideoImportError | null;
}

function sourceAtTarget(target: VideoSourceTarget): VideoSourceRecord | undefined {
  const state = useRepurposeStore.getState();
  if (target.kind === "footage") {
    return target.role === "face"
      ? state.footageMeta?.faceCamSource
      : state.footageMeta?.screenSource;
  }
  if (target.kind === "asset") {
    return state.mediaAssets.find((asset) => asset.id === target.id)?.videoSource;
  }
  return state.overlays.find((overlay) => overlay.id === target.id)?.videoSource;
}

function queuePreviewReconciliation(
  entries: Array<{
    target: VideoSourceTarget;
    source: VideoSourceRecord | null | undefined;
  }>,
  signal: AbortSignal
): void {
  const projectEpoch = useRepurposeStore.getState().projectEpoch;
  for (const { target, source } of entries) {
    if (!source) continue;
    let ownedSource = source;
    void reconcileVideoPreview(source, signal)
      .then(async (reconciledSource) => {
        if (
          signal.aborted ||
          useRepurposeStore.getState().projectEpoch !== projectEpoch ||
          sourceAtTarget(target) !== source
        ) {
          return null;
        }
        if (reconciledSource !== source) {
          useRepurposeStore
            .getState()
            .setVideoSourceRecord(target, reconciledSource);
          ownedSource = reconciledSource;
        }
        return ensureVideoProxy(reconciledSource, signal);
      })
      .then((nextSource) => {
        if (
          !nextSource ||
          signal.aborted ||
          useRepurposeStore.getState().projectEpoch !== projectEpoch
        ) {
          return;
        }
        if (sourceAtTarget(target) === ownedSource) {
          useRepurposeStore.getState().setVideoSourceRecord(target, nextSource);
        }
      })
      .catch(() => undefined);
  }
}

async function reconcileHydratedMedia(signal: AbortSignal): Promise<{
  needsReimport: boolean;
  safeToPersist: boolean;
}> {
  const current = useRepurposeStore.getState();
  const sourcePromises = new Map<string, Promise<VideoSourceRecord>>();

  const resolveSource = (
    existing: VideoSourceRecord | undefined,
    legacyPath: string | null,
    legacyName?: string
  ): Promise<VideoSourceRecord> | null => {
    if (existing) {
      const key = [
        "record",
        existing.originalPath,
        existing.workingPath,
        existing.previewPath ?? "",
        existing.originalName,
        existing.inspection.fingerprint,
        existing.compatibilityStatus,
      ].join("\u0000");
      let pending = sourcePromises.get(key);
      if (!pending) {
        pending = reconcileVideoSource(existing, signal);
        sourcePromises.set(key, pending);
      }
      return pending;
    }
    if (!legacyPath) return null;
    const key = `legacy\u0000${legacyPath}`;
    let pending = sourcePromises.get(key);
    if (!pending) {
      pending = reconcileLegacyVideoPath(
        legacyPath,
        legacyName,
        signal
      );
      sourcePromises.set(key, pending);
    }
    return pending;
  };

  const attempt = async (
    pending: Promise<VideoSourceRecord> | null
  ): Promise<SourceAttempt> => {
    if (!pending) return { source: null, error: null };
    try {
      return { source: await pending, error: null };
    } catch (cause) {
      if (signal.aborted) throw cause;
      return {
        source: null,
        error:
          cause instanceof VideoImportError
            ? cause
            : new VideoImportError("MEDIA_INSPECTION_FAILED", cause),
      };
    }
  };

  const meta = current.footageMeta;
  const faceAttempt = attempt(
    meta
      ? resolveSource(
          meta.faceCamSource,
          footagePathFromUrl(meta.faceCamPath)
        )
      : null
  );
  const screenAttempt = attempt(
    meta
      ? resolveSource(
          meta.screenSource,
          footagePathFromUrl(meta.screenPath)
        )
      : null
  );
  const assetAttempts = current.mediaAssets.map(async (asset) => ({
    asset,
    result:
      asset.kind === "video"
        ? await attempt(
            resolveSource(
              asset.videoSource,
              asset.sourcePath ?? footagePathFromUrl(asset.src),
              asset.name
            )
          )
        : { source: null, error: null },
  }));
  const overlayAttempts = current.overlays.map(async (overlay) => ({
    overlay,
    result:
      overlay.kind === "video"
        ? await attempt(
            resolveSource(
              overlay.videoSource,
              overlay.sourcePath ?? footagePathFromUrl(overlay.src)
            )
          )
        : { source: null, error: null },
  }));

  const [face, screen, assets, overlays] = await Promise.all([
    faceAttempt,
    screenAttempt,
    Promise.all(assetAttempts),
    Promise.all(overlayAttempts),
  ]);
  if (signal.aborted) throw new VideoImportError("VIDEO_IMPORT_CANCELLED");

  const deadBaseBlob = Boolean(
    meta &&
      (isDeadBlobPath(meta.faceCamPath) || isDeadBlobPath(meta.screenPath))
  );
  let needsReimport =
    deadBaseBlob ||
    current.mediaAssets.some(
      (asset) => asset.kind === "video" && isDeadBlobPath(asset.src)
    ) ||
    current.overlays.some(
      (overlay) => overlay.kind === "video" && isDeadBlobPath(overlay.src)
    );
  let baseError: string | null = deadBaseBlob
    ? new VideoImportError("VIDEO_SOURCE_RECONNECT_REQUIRED").message
    : null;

  const sourceNeedsReconnect = (error: VideoImportError | null): boolean =>
    error?.code === "VIDEO_SOURCE_RECONNECT_REQUIRED" ||
    error?.code === "MEDIA_PATH_INVALID";
  for (const result of [face, screen]) {
    if (result.error && !baseError) baseError = result.error.message;
    if (sourceNeedsReconnect(result.error)) needsReimport = true;
  }

  const nextMeta = meta
    ? {
        ...meta,
        ...(face.source
          ? {
              faceCamSource: face.source,
              faceCamPath: videoUrlForWorkingSource(face.source),
            }
          : {}),
        ...(screen.source
          ? {
              screenSource: screen.source,
              screenPath: videoUrlForWorkingSource(screen.source),
            }
          : {}),
      }
    : null;
  const nextAssets = assets.map(({ asset, result }) => {
    if (sourceNeedsReconnect(result.error)) needsReimport = true;
    return result.source
      ? {
          ...asset,
          src: videoUrlForWorkingSource(result.source),
          sourcePath: result.source.workingPath,
          videoSource: result.source,
        }
      : asset;
  });
  const nextOverlays = overlays.map(({ overlay, result }) => {
    if (sourceNeedsReconnect(result.error)) needsReimport = true;
    return result.source
      ? {
          ...overlay,
          src: videoUrlForWorkingSource(result.source),
          sourcePath: result.source.workingPath,
          videoSource: result.source,
        }
      : overlay;
  });

  useRepurposeStore.setState({
    mediaAssets: nextAssets,
    overlays: nextOverlays,
  });
  useRepurposeStore.getState().setFootageMeta(nextMeta);
  const safeToPersist = !deadBaseBlob && !face.error && !screen.error;
  queuePreviewReconciliation(
    [
      {
        target: { kind: "footage", role: "face" },
        source: face.source,
      },
      {
        target: { kind: "footage", role: "screen" },
        source: screen.source,
      },
      ...assets.map(({ asset, result }) => ({
        target: { kind: "asset", id: asset.id } as const,
        source: result.source,
      })),
      ...overlays.map(({ overlay, result }) => ({
        target: { kind: "overlay", id: overlay.id } as const,
        source: result.source,
      })),
    ],
    signal
  );
  if (baseError) {
    useRepurposeStore.getState().setMediaReadiness("error", baseError);
  }
  return {
    needsReimport,
    safeToPersist,
  };
}

/**
 * Apply a loaded snapshot to the store. This is the OLD restore block, lifted out
 * so both the disk-load path and a future importer can call it. It:
 *   - migrates legacy framing onto clips, then setClips (re-derives the timeline),
 *   - RE-DERIVES sfx/music/media `src` fresh from `sourcePath` so a reload never
 *     restores a dead blob: URL,
 *   - restores the plain non-derived slices (split/grades/captions/markers/etc.),
 *   - reseeds the id counters past every restored id,
 *   - self-heals caption blocks,
 *   - flags footageNeedsReimport when footage/overlays used dead blob: URLs.
 * Returns true when a re-import banner should show.
 */
function hydrateSnapshot(snapshot: ProjectSnapshot): boolean {
  const store = useRepurposeStore.getState();
  let restoredWords: ProjectSnapshot["words"];
  let persistedWordsValid = true;
  if (snapshot.words !== undefined) {
    try {
      restoredWords = normalizeTranscriptWords(snapshot.words, { allowEmpty: true });
    } catch {
      restoredWords = [];
      persistedWordsValid = false;
    }
  }
  const restoredCaptionBlocks = persistedWordsValid
    ? normalizeCaptionBlocks(snapshot.captionBlocks)
    : { blocks: [] as CaptionBlock[], repaired: false };

  // MIGRATION: fold any legacy flat framing onto the clips, then upgrade any
  // dead-default (amount-0) Smart transitions to the new snappy 5% push so every
  // cut in an old project gains visible motion.
  const normalizedClips = snapshot.clips.map((clip) => {
    if (clip.splitRatio === undefined) return clip;
    const splitRatio =
      typeof clip.splitRatio === "number"
        ? clampSplitRatio(clip.splitRatio)
        : null;
    if (splitRatio !== null) {
      return splitRatio === clip.splitRatio ? clip : { ...clip, splitRatio };
    }
    const { splitRatio: _invalidSplitRatio, ...rest } = clip;
    return rest as Clip;
  });
  const migratedClips = migrateScreenZoomDefault(
    migrateFaceFramingSync(
      migrateSmartTransitions(migrateLegacyFraming(normalizedClips, snapshot))
    )
  );

  // setClips runs recomputeTimeline (idempotent on already-laid-out clips) and
  // re-derives duration.
  store.setClips(migratedClips);

  // SFX track -- re-derive `src` from `sourcePath` (never trust the persisted src).
  const restoredSfxTrack: SfxTrack | null | undefined =
    snapshot.sfxTrack === undefined
      ? undefined
      : snapshot.sfxTrack && snapshot.sfxTrack.sourcePath
        ? {
            ...snapshot.sfxTrack,
            src: `/api/repurpose/sfx?path=${encodeURIComponent(
              snapshot.sfxTrack.sourcePath
            )}`,
          }
        : null;

  // MUSIC track -- same safe pattern; music is served by the asset route.
  const restoredMusicTrack: MusicTrack | null | undefined =
    snapshot.musicTrack === undefined
      ? undefined
      : snapshot.musicTrack && snapshot.musicTrack.sourcePath
        ? {
            ...snapshot.musicTrack,
            src: `/api/repurpose/asset?path=${encodeURIComponent(
              snapshot.musicTrack.sourcePath
            )}`,
          }
        : null;

  // MEDIA BIN -- re-derive each asset's src from its working source/path.
  const restoredMediaAssets: MediaAsset[] | undefined =
    snapshot.mediaAssets === undefined
      ? undefined
      : snapshot.mediaAssets.map(restoreMediaAsset);
  const restoredOverlays: Overlay[] | undefined =
    snapshot.overlays === undefined
      ? undefined
      : snapshot.overlays.map(restoreOverlay);
  const restoredFootageMeta = restoreFootageMeta(snapshot.footageMeta);

  // Restore the plain, non-derived slices. Transient UI state stays at defaults;
  // footage goes through its action below so valid paths re-enter `loading`.
  useRepurposeStore.setState({
    splitRatio: parsePersistedSplitRatio(snapshot.splitRatio, 0.5),
    screenGrade: snapshot.screenGrade,
    faceGrade: snapshot.faceGrade,
    playhead: snapshot.playhead,
    inPoint: snapshot.inPoint,
    outPoint: snapshot.outPoint,
    loopPlayback: snapshot.loopPlayback,
    ...(restoredWords !== undefined ? { words: restoredWords } : {}),
    ...(!persistedWordsValid
      ? { captionsEnabled: false }
      : snapshot.captionsEnabled !== undefined
        ? { captionsEnabled: snapshot.captionsEnabled }
        : {}),
    ...(snapshot.captionStyle !== undefined
      ? { captionStyle: snapshot.captionStyle }
      : {}),
    ...(!persistedWordsValid
      ? { captionBlocks: [] }
      : snapshot.captionBlocks !== undefined
        ? { captionBlocks: restoredCaptionBlocks.blocks }
        : {}),
    ...(snapshot.snapEnabled !== undefined
      ? { snapEnabled: snapshot.snapEnabled }
      : {}),
    ...(snapshot.markers !== undefined ? { markers: snapshot.markers } : {}),
    ...(snapshot.deletedWordIndices !== undefined
      ? {
          deletedWordIndices: persistedWordsValid
            ? snapshot.deletedWordIndices
            : [],
        }
      : {}),
    ...(restoredOverlays !== undefined ? { overlays: restoredOverlays } : {}),
    ...(restoredSfxTrack !== undefined ? { sfxTrack: restoredSfxTrack } : {}),
    ...(restoredMusicTrack !== undefined ? { musicTrack: restoredMusicTrack } : {}),
    ...(restoredMediaAssets !== undefined ? { mediaAssets: restoredMediaAssets } : {}),
  });
  store.setFootageMeta(restoredFootageMeta);

  // Reseed id counters past every restored id (they reset to 0 on module re-eval).
  const seed = useRepurposeStore.getState();
  reseedIdCounters({
    clips: seed.clips,
    markers: seed.markers,
    overlays: seed.overlays,
    mediaAssets: seed.mediaAssets,
  });

  // SELF-HEAL captions: words present but no blocks -> chunk them now.
  const after = useRepurposeStore.getState();
  if (
    after.words.length > 0 &&
    (after.captionBlocks.length === 0 || restoredCaptionBlocks.repaired)
  ) {
    after.rebuildCaptionBlocks();
  }

  // Flag dead blob footage/overlays so the UI can prompt a re-import.
  const meta = restoredFootageMeta;
  const overlayNeedsReconnect = (restoredOverlays ?? []).some((o) =>
    needsMediaReconnect(o.src)
  );
  const assetNeedsReconnect = (restoredMediaAssets ?? []).some((asset) =>
    needsMediaReconnect(asset.src)
  );
  return (
    overlayNeedsReconnect ||
    assetNeedsReconnect ||
    (!!meta &&
      (needsMediaReconnect(meta.faceCamPath) ||
        needsMediaReconnect(meta.screenPath)))
  );
}

const SAVE_WRITER_REALM_KEY = Symbol.for("repurpose-studio.save-writer-id");
const PROVISIONAL_CREATE_ATTEMPT_KEY_PREFIX =
  "repurpose-studio-provisional-create:";
const SAVE_OUTBOX_KEY_PREFIX = "repurpose-studio-save-outbox:";

interface SaveWriterRealmState {
  writerId: string;
  issuedRevisionByProject: Map<string, number>;
  acknowledgedRevisionByProject: Map<string, number>;
  latestSnapshotByProject: Map<
    string,
    { issuedRevision: number; snapshot: ProjectSnapshot }
  >;
  createRequestIdByProject: Map<string, string>;
}

function cloneProjectSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const CAPTION_OVERRIDE_NUMBER_FIELDS = new Set<keyof CaptionStyle>([
  "weight",
  "sizePct",
  "letterSpacingPct",
  "lineHeightMul",
  "strokeWidthPct",
  "activePop",
  "boxRadiusPct",
  "boxPadXPct",
  "boxPadYPct",
  "splitOffsetPct",
  "positionYPct",
  "maxWordsPerLine",
  "maxCharsPerLine",
  "maxLines",
  "animDurationMs",
]);
const CAPTION_OVERRIDE_BOOLEAN_FIELDS = new Set<keyof CaptionStyle>([
  "uppercase",
  "pinToSplit",
]);

function normalizeCaptionOverride(
  value: unknown
): { overrideStyle?: Partial<CaptionStyle>; repaired: boolean } | null {
  if (value === undefined) return { repaired: false };
  if (!isRecord(value)) return null;
  const overrideStyle: Record<string, unknown> = {};
  let repaired = false;
  for (const [key, field] of Object.entries(value)) {
    if (CAPTION_OVERRIDE_NUMBER_FIELDS.has(key as keyof CaptionStyle)) {
      if (isFiniteNumber(field)) overrideStyle[key] = field;
      else repaired = true;
      continue;
    }
    if (CAPTION_OVERRIDE_BOOLEAN_FIELDS.has(key as keyof CaptionStyle)) {
      if (typeof field === "boolean") overrideStyle[key] = field;
      else repaired = true;
      continue;
    }
    if (typeof field === "string") overrideStyle[key] = field;
    else repaired = true;
  }
  return {
    overrideStyle: overrideStyle as Partial<CaptionStyle>,
    repaired,
  };
}

function normalizeCaptionBlock(
  value: unknown
): { block: CaptionBlock; repaired: boolean } | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return null;
  }
  let words: CaptionBlock["words"];
  try {
    words = normalizeTranscriptWords(value.words, { allowEmpty: false });
  } catch {
    return null;
  }
  const override = normalizeCaptionOverride(value.overrideStyle);
  if (!override) return null;

  const start = words[0].start;
  const end = words[words.length - 1].end;
  let repaired = override.repaired || value.start !== start || value.end !== end;
  const block: CaptionBlock = { id: value.id, words, start, end };
  if (override.overrideStyle !== undefined) {
    block.overrideStyle = override.overrideStyle;
  }
  if (value.keywordIndex !== undefined) {
    if (
      typeof value.keywordIndex === "number" &&
      Number.isInteger(value.keywordIndex) &&
      value.keywordIndex >= -1 &&
      value.keywordIndex < words.length
    ) {
      block.keywordIndex = value.keywordIndex;
    } else {
      repaired = true;
    }
  }
  if (value.textOverride !== undefined) {
    if (
      Array.isArray(value.textOverride) &&
      value.textOverride.length === words.length &&
      value.textOverride.every((entry) => typeof entry === "string")
    ) {
      block.textOverride = [...value.textOverride] as string[];
    } else {
      repaired = true;
    }
  }
  return {
    block: normalizeCaptionBlockPlacement(block),
    repaired,
  };
}

function normalizeCaptionBlocks(value: unknown): {
  blocks: CaptionBlock[];
  repaired: boolean;
} {
  if (value === undefined) return { blocks: [], repaired: false };
  if (!Array.isArray(value)) return { blocks: [], repaired: true };
  const blocks: CaptionBlock[] = [];
  let repaired = false;
  for (const entry of value) {
    const normalized = normalizeCaptionBlock(entry);
    if (!normalized) {
      repaired = true;
      continue;
    }
    blocks.push(normalized.block);
    repaired ||= normalized.repaired;
  }
  return { blocks, repaired };
}

function isStructurallyValidVideoSource(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.inspection)) return false;
  const inspection = value.inspection;
  if (!isRecord(inspection.video)) return false;
  const video = inspection.video;
  const audio = inspection.audio;
  const validAudio =
    audio === null ||
    (isRecord(audio) &&
      typeof audio.codec === "string" &&
      isFiniteNumber(audio.channels) &&
      Number.isInteger(audio.channels) &&
      audio.channels > 0 &&
      isFiniteNumber(audio.sampleRate) &&
      audio.sampleRate > 0 &&
      (audio.durationSec === undefined ||
        (isFiniteNumber(audio.durationSec) && audio.durationSec >= 0)));

  return (
    typeof value.originalPath === "string" &&
    value.originalPath.trim().length > 0 &&
    typeof value.workingPath === "string" &&
    value.workingPath.trim().length > 0 &&
    (value.previewPath === undefined || typeof value.previewPath === "string") &&
    typeof value.originalName === "string" &&
    value.originalName.trim().length > 0 &&
    typeof value.nativeCompatible === "boolean" &&
    (value.compatibilityStatus === "native" ||
      value.compatibilityStatus === "converted") &&
    typeof inspection.fingerprint === "string" &&
    typeof inspection.container === "string" &&
    typeof inspection.extension === "string" &&
    isFiniteNumber(inspection.size) &&
    inspection.size >= 0 &&
    isFiniteNumber(inspection.durationSec) &&
    inspection.durationSec >= 0 &&
    typeof video.codec === "string" &&
    typeof video.codecTag === "string" &&
    typeof video.profile === "string" &&
    typeof video.pixelFormat === "string" &&
    isFiniteNumber(video.width) &&
    video.width > 0 &&
    isFiniteNumber(video.height) &&
    video.height > 0 &&
    isFiniteNumber(video.fps) &&
    video.fps > 0 &&
    (video.rotationDeg === undefined || isFiniteNumber(video.rotationDeg)) &&
    validAudio
  );
}

function isStructurallyValidOverlay(value: unknown): value is Overlay {
  if (!isRecord(value)) return false;
  const overlay = value;
  const transform = overlay.transform;
  if (!isRecord(transform)) return false;
  const band = overlay.band;
  const videoSource = overlay.videoSource;
  const validVideoSource =
    videoSource === undefined ||
    (overlay.kind === "video" && isStructurallyValidVideoSource(videoSource));
  const validMuted =
    overlay.muted === undefined ||
    (overlay.kind === "video" && overlay.muted === true);

  return (
    typeof overlay.id === "string" &&
    overlay.id.trim().length > 0 &&
    (overlay.kind === "image" || overlay.kind === "video") &&
    typeof overlay.src === "string" &&
    overlay.src.trim().length > 0 &&
    (overlay.sourcePath === undefined || typeof overlay.sourcePath === "string") &&
    validMuted &&
    validVideoSource &&
    isFiniteNumber(overlay.naturalWidth) &&
    overlay.naturalWidth > 0 &&
    isFiniteNumber(overlay.naturalHeight) &&
    overlay.naturalHeight > 0 &&
    isFiniteNumber(transform.x) &&
    isFiniteNumber(transform.y) &&
    isFiniteNumber(transform.scale) &&
    transform.scale > 0 &&
    isFiniteNumber(transform.rotation) &&
    isFiniteNumber(overlay.timelineStart) &&
    overlay.timelineStart >= 0 &&
    isFiniteNumber(overlay.timelineEnd) &&
    overlay.timelineEnd > overlay.timelineStart &&
    isFiniteNumber(overlay.srcStart) &&
    overlay.srcStart >= 0 &&
    isFiniteNumber(overlay.srcDuration) &&
    overlay.srcDuration >= 0 &&
    isFiniteNumber(overlay.zIndex) &&
    Number.isInteger(overlay.zIndex) &&
    overlay.zIndex >= 0 &&
    isFiniteNumber(overlay.opacity) &&
    overlay.opacity >= 0 &&
    overlay.opacity <= 1 &&
    (band === undefined ||
      band === "screen" ||
      band === "face" ||
      band === "free")
  );
}

function isStructurallyValidSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ProjectSnapshot>;
  if (
    !Array.isArray(snapshot.clips) ||
    snapshot.clips.some((clip) => {
      if (!clip || typeof clip !== "object" || Array.isArray(clip)) return true;
      const candidate = clip as unknown as Record<string, unknown>;
      const finite = (field: unknown) =>
        typeof field === "number" && Number.isFinite(field);
      return (
        typeof candidate.id !== "string" ||
        (candidate.kind !== "take" && candidate.kind !== "silence") ||
        typeof candidate.label !== "string" ||
        !finite(candidate.srcStart) ||
        !finite(candidate.srcEnd) ||
        !finite(candidate.timelineStart) ||
        !finite(candidate.timelineEnd) ||
        typeof candidate.kept !== "boolean" ||
        typeof candidate.isKeeperTake !== "boolean" ||
        !Array.isArray(candidate.occurrences) ||
        !Number.isInteger(candidate.keeperIndex)
      );
    })
  ) {
    return false;
  }
  if (
    snapshot.overlays !== undefined &&
    (!Array.isArray(snapshot.overlays) ||
      snapshot.overlays.some((overlay) => !isStructurallyValidOverlay(overlay)))
  ) {
    return false;
  }
  const optionalArrays = [
    snapshot.words,
    snapshot.markers,
    snapshot.deletedWordIndices,
    snapshot.mediaAssets,
  ];
  return optionalArrays.every(
    (entry) => entry === undefined || Array.isArray(entry)
  );
}

function createHighEntropyId(prefix: string): string {
  let random: string;
  if (window.crypto?.randomUUID) {
    random = window.crypto.randomUUID();
  } else if (window.crypto?.getRandomValues) {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } else {
    random = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return `${prefix}-${random}`;
}

function getSaveWriterRealmState(): SaveWriterRealmState {
  if (!isBrowser()) {
    return {
      writerId: "writer-server-render",
      issuedRevisionByProject: new Map(),
      acknowledgedRevisionByProject: new Map(),
      latestSnapshotByProject: new Map(),
      createRequestIdByProject: new Map(),
    };
  }
  const realm = window as unknown as Record<symbol, unknown>;
  const existing = realm[SAVE_WRITER_REALM_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    typeof (existing as SaveWriterRealmState).writerId === "string" &&
    (existing as SaveWriterRealmState).issuedRevisionByProject instanceof Map
  ) {
    const state = existing as SaveWriterRealmState;
    if (!(state.createRequestIdByProject instanceof Map)) {
      state.createRequestIdByProject = new Map();
    }
    if (!(state.acknowledgedRevisionByProject instanceof Map)) {
      state.acknowledgedRevisionByProject = new Map();
    }
    if (!(state.latestSnapshotByProject instanceof Map)) {
      state.latestSnapshotByProject = new Map();
    }
    return state;
  }
  const state: SaveWriterRealmState = {
    writerId:
      typeof existing === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(existing)
        ? existing
        : createHighEntropyId("writer"),
    issuedRevisionByProject: new Map(),
    acknowledgedRevisionByProject: new Map(),
    latestSnapshotByProject: new Map(),
    createRequestIdByProject: new Map(),
  };
  Object.defineProperty(realm, SAVE_WRITER_REALM_KEY, {
    value: state,
    configurable: true,
  });
  return state;
}

function getSaveWriterId(): string {
  return getSaveWriterRealmState().writerId;
}

function getCreateRequestId(projectId: string): string {
  const createRequests = getSaveWriterRealmState().createRequestIdByProject;
  let requestId = createRequests.get(projectId);
  if (!requestId) {
    requestId = createHighEntropyId("create");
    createRequests.set(projectId, requestId);
  }
  return requestId;
}

interface ProvisionalCreateAttempt {
  writerId: string;
  createRequestId: string;
  baseRevision: number;
  saveRevision: number;
}

function provisionalCreateAttemptKey(projectId: string): string {
  return `${PROVISIONAL_CREATE_ATTEMPT_KEY_PREFIX}${projectId}`;
}

function readProvisionalCreateAttempt(
  projectId: string
): ProvisionalCreateAttempt | null {
  if (!isBrowser() || !isProvisionalId(projectId)) return null;
  try {
    const raw = window.sessionStorage.getItem(
      provisionalCreateAttemptKey(projectId)
    );
    if (!raw) return null;
    const attempt = JSON.parse(raw) as Partial<ProvisionalCreateAttempt>;
    if (
      typeof attempt.writerId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(attempt.writerId) ||
      typeof attempt.createRequestId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(attempt.createRequestId) ||
      !Number.isSafeInteger(attempt.baseRevision) ||
      (attempt.baseRevision ?? -1) < 0 ||
      !Number.isSafeInteger(attempt.saveRevision) ||
      (attempt.saveRevision ?? 0) <= 0
    ) {
      return null;
    }
    return attempt as ProvisionalCreateAttempt;
  } catch {
    return null;
  }
}

function rememberProvisionalCreateAttempt(
  projectId: string,
  attempt: ProvisionalCreateAttempt
): void {
  if (!isBrowser() || !isProvisionalId(projectId)) return;
  try {
    window.sessionStorage.setItem(
      provisionalCreateAttemptKey(projectId),
      JSON.stringify(attempt)
    );
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts. The
    // in-realm retry remains safe; only cross-reload recovery is unavailable.
  }
}

function forgetProvisionalCreateAttempt(projectId: string): void {
  if (!isBrowser() || !isProvisionalId(projectId)) return;
  try {
    window.sessionStorage.removeItem(provisionalCreateAttemptKey(projectId));
  } catch {
    // Best-effort cleanup; an exact replay stays idempotent if storage is locked.
  }
}

function rememberIssuedRevision(projectId: string, revision: number): number {
  const issued = getSaveWriterRealmState().issuedRevisionByProject;
  const highWater = Math.max(issued.get(projectId) ?? 0, revision);
  issued.set(projectId, highWater);
  return highWater;
}

function rememberAcknowledgedRevision(
  projectId: string,
  revision: number
): number {
  const acknowledged = getSaveWriterRealmState().acknowledgedRevisionByProject;
  const current = Math.max(acknowledged.get(projectId) ?? 0, revision);
  acknowledged.set(projectId, current);
  return current;
}

function rememberIssuedSnapshot(
  projectId: string,
  issuedRevision: number,
  snapshot: ProjectSnapshot
): void {
  const snapshots = getSaveWriterRealmState().latestSnapshotByProject;
  const current = snapshots.get(projectId);
  if (!current || issuedRevision >= current.issuedRevision) {
    snapshots.set(projectId, {
      issuedRevision,
      snapshot: cloneProjectSnapshot(snapshot),
    });
  }
}

function moveRealmProjectState(fromProjectId: string, toProjectId: string): void {
  const state = getSaveWriterRealmState();
  const issuedRevision = state.issuedRevisionByProject.get(fromProjectId) ?? 0;
  const acknowledgedRevision =
    state.acknowledgedRevisionByProject.get(fromProjectId) ?? 0;
  const latestSnapshot = state.latestSnapshotByProject.get(fromProjectId);
  rememberIssuedRevision(toProjectId, issuedRevision);
  rememberAcknowledgedRevision(toProjectId, acknowledgedRevision);
  if (latestSnapshot) {
    rememberIssuedSnapshot(
      toProjectId,
      latestSnapshot.issuedRevision,
      latestSnapshot.snapshot
    );
  }
  state.issuedRevisionByProject.delete(fromProjectId);
  state.acknowledgedRevisionByProject.delete(fromProjectId);
  state.latestSnapshotByProject.delete(fromProjectId);
}

interface ProjectSaveRequest {
  id: string;
  name: string;
  createdAt?: string;
  writerId: string;
  baseRevision: number;
  saveRevision: number;
  snapshot: ProjectSnapshot;
  mode?: "create";
  createRequestId?: string;
}

function saveOutboxKey(projectId: string): string {
  return `${SAVE_OUTBOX_KEY_PREFIX}${projectId}`;
}

function readSaveOutbox(projectId: string): ProjectSaveRequest | null {
  if (!isBrowser()) return null;
  const readFrom = (getStorage: () => Storage): ProjectSaveRequest | null => {
    try {
      const storage = getStorage();
      const raw = storage.getItem(saveOutboxKey(projectId));
      if (!raw) return null;
      const request = JSON.parse(raw) as Partial<ProjectSaveRequest>;
      if (
        request.id !== projectId ||
        typeof request.name !== "string" ||
        typeof request.writerId !== "string" ||
        !Number.isSafeInteger(request.baseRevision) ||
        (request.baseRevision ?? -1) < 0 ||
        !Number.isSafeInteger(request.saveRevision) ||
        (request.saveRevision ?? 0) <= 0 ||
        !isStructurallyValidSnapshot(request.snapshot)
      ) {
        return null;
      }
      return request as ProjectSaveRequest;
    } catch {
      return null;
    }
  };
  const local = readFrom(() => window.localStorage);
  const session = readFrom(() => window.sessionStorage);
  if (!local) return session;
  if (!session) return local;
  return session.saveRevision > local.saveRevision ? session : local;
}

function writeSaveOutbox(request: ProjectSaveRequest): boolean {
  if (!isBrowser()) return false;
  const value = JSON.stringify(request);
  try {
    window.localStorage.setItem(saveOutboxKey(request.id), value);
    return true;
  } catch {
    try {
      // Same-tab reloads retain sessionStorage, providing a realistic fallback
      // when localStorage is quota-blocked or unavailable.
      window.sessionStorage.setItem(saveOutboxKey(request.id), value);
      return true;
    } catch {
      return false;
    }
  }
}

function clearSaveOutbox(projectId: string, confirmedRevision?: number): void {
  if (!isBrowser()) return;
  try {
    if (
      confirmedRevision !== undefined &&
      (readSaveOutbox(projectId)?.saveRevision ?? 0) > confirmedRevision
    ) {
      return;
    }
    window.localStorage.removeItem(saveOutboxKey(projectId));
  } catch {
    // Continue to the alternate store.
  }
  try {
    window.sessionStorage.removeItem(saveOutboxKey(projectId));
  } catch {
    // Best-effort cleanup; a confirmed replay remains idempotent if retained.
  }
}

type ProjectSaveResult =
  | {
      kind: "saved";
      project: {
        id: string;
        name: string;
        createdAt: string;
        saveRevision?: number;
        saveWriterId?: string | null;
      };
    }
  | {
      kind: "conflict";
      reason: string | null;
      project: {
        id?: string;
        saveRevision?: number;
        saveWriterId?: string | null;
      } | null;
    }
  | { kind: "failed" };

function confirmedSameWriterRevision(
  result: Extract<ProjectSaveResult, { kind: "conflict" }>,
  request: ProjectSaveRequest
): number | null {
  const revision = result.project?.saveRevision;
  return result.reason === "SUPERSEDED_SAME_WRITER" &&
    result.project?.saveWriterId === request.writerId &&
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= request.saveRevision
    ? revision
    : null;
}

/** POST a controlled project save and preserve conflicts as a distinct result. */
async function postProject(
  body: ProjectSaveRequest,
  keepalive = false
): Promise<ProjectSaveResult> {
  try {
    const res = await fetch("/api/repurpose/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive,
    });
    const data = (await res.json().catch(() => null)) as {
      error?: { code?: unknown; reason?: unknown };
      project?: {
        id: string;
        name: string;
        createdAt: string;
        saveRevision?: number;
        saveWriterId?: string | null;
      };
    } | null;
    if (
      res.status === 409 &&
      data?.error?.code === "PROJECT_SAVE_CONFLICT"
    ) {
      return {
        kind: "conflict",
        reason:
          typeof data.error.reason === "string" ? data.error.reason : null,
        project: data.project ?? null,
      };
    }
    if (res.status === 409 && data?.error?.code === "PROJECT_FILE_CORRUPT") {
      return {
        kind: "conflict",
        reason: "PROJECT_FILE_CORRUPT",
        project: data.project ?? null,
      };
    }
    if (!res.ok || !data?.project) return { kind: "failed" };
    return { kind: "saved", project: data.project };
  } catch {
    return { kind: "failed" };
  }
}

interface ProjectSaveControl {
  acknowledgedRevision: number;
  nextRevision: number;
  blocked: boolean;
}

interface RecoverableSaveConflict {
  projectId: string;
  reason: string | null;
  serverRevision: number | null;
  serverWriterId: string | null;
}

interface ConflictedSaveEntry {
  id: string;
  name: string;
  createdAt?: string;
  snapshot: ProjectSnapshot;
  version: number;
  serverRevision: number | null;
  origin: "live" | "outbox";
}

function issueProjectSaveRevision(
  projectId: string,
  control: ProjectSaveControl,
  snapshot: ProjectSnapshot
): number {
  const highWater = rememberIssuedRevision(projectId, control.nextRevision);
  control.nextRevision = highWater + 1;
  const revision = rememberIssuedRevision(projectId, control.nextRevision);
  rememberIssuedSnapshot(projectId, revision, snapshot);
  return revision;
}

/**
 * Per-project disk persistence. Mount once from the editor with the route's
 * projectId. Returns:
 *   - footageNeedsReimport: restored footage used dead blob: URLs -> nudge a re-pick.
 *   - projectName: the resolved (derived, then frozen) project title, or null.
 *   - ready: false until the initial load/404 resolves (first paint gate).
 */
export function useProjectPersistence(projectId: string): {
  footageNeedsReimport: boolean;
  projectName: string | null;
  ready: boolean;
  loadError: string | null;
  saveError: string | null;
  retryLoad: () => void;
  saveConflict: RecoverableSaveConflict | null;
  resolveSaveConflict: (action: "save-copy" | "reload") => Promise<boolean>;
} {
  const router = useRouter();
  const [footageNeedsReimport, setFootageNeedsReimport] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);
  const [saveConflict, setSaveConflict] =
    useState<RecoverableSaveConflict | null>(null);
  const conflictedSaveRef = useRef<ConflictedSaveEntry | null>(null);
  const resolvingConflictRef = useRef(false);
  const forceReloadRef = useRef(false);
  const reloadConflictProjectRef = useRef<string | null>(null);
  const reloadConflictResultRef = useRef<{
    projectId: string;
    resolve: (succeeded: boolean) => void;
  } | null>(null);
  const settleConflictReload = useCallback(
    (reloadedProjectId: string, succeeded: boolean) => {
      const pending = reloadConflictResultRef.current;
      if (!pending || pending.projectId !== reloadedProjectId) return;
      reloadConflictResultRef.current = null;
      pending.resolve(succeeded);
    },
    []
  );
  const discardConflictedPendingRef = useRef<
    ((conflictedProjectId: string) => void) | null
  >(null);
  const routeProjectIdRef = useRef(projectId);
  routeProjectIdRef.current = projectId;

  // The id of the project we currently hold in memory (a real dated slug once
  // created/loaded, or null while provisional). Guards the router.replace re-entry.
  const currentIdRef = useRef<string | null>(null);
  // True once a disk file exists for the current project.
  const createdRef = useRef(false);
  // Synchronous lock so a setClips storm can't fire concurrent auto-creates.
  const creatingRef = useRef(false);
  const createRetryBlockedRef = useRef(false);
  // Mirrors of the resolved name / createdAt for the autosave POST body.
  const projectNameRef = useRef<string | null>(null);
  const createdAtRef = useRef<string | undefined>(undefined);
  const saveControlsRef = useRef(new Map<string, ProjectSaveControl>());
  const saveControlFor = useCallback((id: string): ProjectSaveControl => {
    const realmState = getSaveWriterRealmState();
    const issuedHighWater = realmState.issuedRevisionByProject.get(id) ?? 0;
    const acknowledgedRevision =
      realmState.acknowledgedRevisionByProject.get(id) ?? 0;
    let control = saveControlsRef.current.get(id);
    if (!control) {
      control = {
        acknowledgedRevision,
        nextRevision: issuedHighWater,
        blocked: false,
      };
      saveControlsRef.current.set(id, control);
    } else {
      control.acknowledgedRevision = Math.max(
        control.acknowledgedRevision,
        acknowledgedRevision
      );
      control.nextRevision = Math.max(control.nextRevision, issuedHighWater);
    }
    return control;
  }, []);
  // True once the load effect has settled -- gates the autosave subscription so
  // hydration's setState storm doesn't POST straight back.
  const readyRef = useRef(false);
  const hydrationOwnerRef = useRef<AbortController | null>(null);
  const loadOwnershipRef = useRef(0);
  const mountOwnershipRef = useRef<object | null>(null);
  const scheduleCatchUpSaveRef = useRef<
    ((expectedProjectId: string) => void) | null
  >(null);
  const replaySaveOutboxRef = useRef<
    ((expectedProjectId: string) => Promise<boolean>) | null
  >(null);

  useEffect(() => {
    const ownership = {};
    mountOwnershipRef.current = ownership;
    return () => {
      if (mountOwnershipRef.current === ownership) {
        mountOwnershipRef.current = null;
      }
      const pendingReload = reloadConflictResultRef.current;
      if (pendingReload) {
        reloadConflictResultRef.current = null;
        pendingReload.resolve(false);
      }
    };
  }, []);

  // --- (E) WARM THE ENCODE WORKER -------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    prespawnWorker();
    return () => disposeWarmWorker();
  }, []);

  // --- (A) LOAD (keyed on projectId) ----------------------------------------
  useEffect(() => {
    loadOwnershipRef.current++;
    createRetryBlockedRef.current = false;
    let cancelled = false;
    const reconciliationAborter = new AbortController();
    const previousConflict = conflictedSaveRef.current;
    if (previousConflict && previousConflict.id !== projectId) {
      settleConflictReload(previousConflict.id, false);
      saveControlFor(previousConflict.id).blocked = false;
      conflictedSaveRef.current = null;
      resolvingConflictRef.current = false;
      if (reloadConflictProjectRef.current === previousConflict.id) {
        reloadConflictProjectRef.current = null;
      }
      setSaveConflict(null);
    }
    const releaseHydration = () => {
      if (hydrationOwnerRef.current !== reconciliationAborter) return;
      hydrationOwnerRef.current = null;
      useRepurposeStore.getState().setHydrating(false);
    };
    setReady(false);
    setLoadError(null);
    readyRef.current = false;

    const markReady = () => {
      if (cancelled) return;
      readyRef.current = true;
      setReady(true);
    };

    // Provisional new project: empty baseline, no disk file yet. The demo/manual
    // ingest path is allowed to run (hydrating stays false).
    if (isProvisionalId(projectId)) {
      useRepurposeStore.getState().resetProject();
      useRepurposeStore.getState().setHydrating(false);
      currentIdRef.current = null;
      createdRef.current = false;
      creatingRef.current = false;
      projectNameRef.current = null;
      createdAtRef.current = undefined;
      const control = saveControlFor(projectId);
      control.acknowledgedRevision = rememberAcknowledgedRevision(
        projectId,
        control.acknowledgedRevision
      );
      control.nextRevision = rememberIssuedRevision(
        projectId,
        control.nextRevision
      );
      control.blocked = false;
      setProjectName(null);
      setFootageNeedsReimport(false);
      markReady();
      return () => {
        cancelled = true;
        reconciliationAborter.abort();
        releaseHydration();
      };
    }

    // The URL just caught up to a project we already hold in memory (the
    // router.replace right after auto-create). Do NOT re-fetch/reset -- that would
    // wipe the in-progress edit. Just settle.
    if (projectId === currentIdRef.current && !forceReloadRef.current) {
      markReady();
      return () => {
        cancelled = true;
        reconciliationAborter.abort();
        releaseHydration();
      };
    }
    // A real dated slug we don't hold yet: load it from disk.
    const store = useRepurposeStore.getState();
    hydrationOwnerRef.current = reconciliationAborter;
    store.setHydrating(true);

    (async () => {
      let found: {
        name: string;
        saveRevision: number;
        saveWriterId: string | null;
        snapshot: ProjectSnapshot;
      } | null = null;
      try {
        const res = await fetch(
          `/api/repurpose/projects/${encodeURIComponent(projectId)}`,
          { signal: reconciliationAborter.signal }
        );
        if (res.status === 404) {
          found = null;
        } else if (res.status === 409) {
          const errorData = (await res.json().catch(() => null)) as {
            error?: { code?: unknown };
          } | null;
          if (errorData?.error?.code === "PROJECT_FILE_CORRUPT") {
            throw new Error("PROJECT_LOAD_FILE_CORRUPT");
          }
          throw new Error("PROJECT_LOAD_HTTP_409");
        } else if (!res.ok) {
          throw new Error(`PROJECT_LOAD_HTTP_${res.status}`);
        } else {
          const data = (await res.json()) as {
            project?: {
              id: string;
              name: string;
              createdAt: string;
              saveRevision?: number;
              saveWriterId?: string | null;
              revision?: number;
              snapshot: ProjectSnapshot;
            };
          };
          if (!data.project) {
            throw new Error("PROJECT_LOAD_INVALID_RESPONSE");
          }
          if (!isStructurallyValidSnapshot(data.project.snapshot)) {
            throw new Error("PROJECT_LOAD_INVALID_SNAPSHOT");
          }
          found = {
              name: data.project.name,
              saveRevision:
                typeof (data.project.saveRevision ?? data.project.revision) ===
                  "number" &&
                Number.isSafeInteger(
                  data.project.saveRevision ?? data.project.revision
                ) &&
                (data.project.saveRevision ?? data.project.revision ?? -1) >= 0
                  ? (data.project.saveRevision ?? data.project.revision ?? 0)
                  : 0,
              saveWriterId:
                typeof data.project.saveWriterId === "string"
                  ? data.project.saveWriterId
                  : null,
              snapshot: data.project.snapshot,
          };
          createdAtRef.current = data.project.createdAt;
        }
      } catch (error) {
        if (cancelled || reconciliationAborter.signal.aborted) return;
        console.error("[Repurpose Studio] PROJECT_LOAD_FAILED", error);
        if (reloadConflictProjectRef.current === projectId) {
          reloadConflictProjectRef.current = null;
          forceReloadRef.current = false;
          releaseHydration();
          markReady();
          settleConflictReload(projectId, false);
          return;
        }
        const corruptFile =
          error instanceof Error &&
          error.message === "PROJECT_LOAD_FILE_CORRUPT";
        setLoadError(
          corruptFile
            ? "O arquivo do projeto está corrompido. Restaure uma cópia válida antes de continuar."
            : "Não foi possível carregar o projeto. Tente novamente."
        );
        if (
          error instanceof Error &&
          (error.message === "PROJECT_LOAD_INVALID_SNAPSHOT" || corruptFile)
        ) {
          if (!corruptFile) useRepurposeStore.getState().resetProject();
          releaseHydration();
        }
        if (reloadConflictProjectRef.current === projectId) {
          forceReloadRef.current = true;
        }
        return;
      }

      if (cancelled) {
        return;
      }

      if (!found && reloadConflictProjectRef.current === projectId) {
        reloadConflictProjectRef.current = null;
        forceReloadRef.current = false;
        releaseHydration();
        markReady();
        settleConflictReload(projectId, false);
        return;
      }

      const missingProjectOutbox = !found ? readSaveOutbox(projectId) : null;
      if (missingProjectOutbox) {
        let needsReconnect: boolean;
        try {
          useRepurposeStore.getState().resetProject();
          needsReconnect = hydrateSnapshot(missingProjectOutbox.snapshot);
        } catch (error) {
          console.error("[Repurpose Studio] PROJECT_RESTORE_FAILED", error);
          useRepurposeStore.getState().resetProject();
          forceReloadRef.current = true;
          setLoadError(
            "Não foi possível sincronizar as alterações pendentes. Tente novamente."
          );
          releaseHydration();
          return;
        }
        currentIdRef.current = projectId;
        createdRef.current = true;
        creatingRef.current = false;
        projectNameRef.current = missingProjectOutbox.name;
        createdAtRef.current = missingProjectOutbox.createdAt;
        saveControlFor(projectId).blocked = true;
        conflictedSaveRef.current = {
          id: projectId,
          name: missingProjectOutbox.name,
          createdAt: missingProjectOutbox.createdAt,
          snapshot: cloneProjectSnapshot(missingProjectOutbox.snapshot),
          version: 0,
          serverRevision: null,
          origin: "outbox",
        };
        setProjectName(missingProjectOutbox.name);
        setFootageNeedsReimport(needsReconnect);
        setSaveConflict({
          projectId,
          reason: "PROJECT_NOT_FOUND",
          serverRevision: null,
          serverWriterId: null,
        });
        forceReloadRef.current = false;
        releaseHydration();
        markReady();
        return;
      }

      let usedIssuedLocalSnapshot = false;
      let usedDurableOutbox = false;
      if (found) {
        const realmState = getSaveWriterRealmState();
        const issuedHighWater =
          realmState.issuedRevisionByProject.get(projectId) ?? 0;
        const localSnapshot = realmState.latestSnapshotByProject.get(projectId);
        const useLatestLocalSnapshot =
          found.saveWriterId === realmState.writerId &&
          found.saveRevision < issuedHighWater &&
          localSnapshot?.issuedRevision === issuedHighWater;
        rememberAcknowledgedRevision(projectId, found.saveRevision);
        rememberIssuedRevision(projectId, found.saveRevision);
        if (useLatestLocalSnapshot && localSnapshot) {
          found.snapshot = cloneProjectSnapshot(localSnapshot.snapshot);
          usedIssuedLocalSnapshot = true;
        } else {
          realmState.latestSnapshotByProject.set(projectId, {
            issuedRevision: found.saveRevision,
            snapshot: cloneProjectSnapshot(found.snapshot),
          });
        }
        const durableOutbox = readSaveOutbox(projectId);
        if (
          durableOutbox &&
          durableOutbox.baseRevision === found.saveRevision
        ) {
          found.snapshot = cloneProjectSnapshot(durableOutbox.snapshot);
          rememberIssuedRevision(projectId, durableOutbox.saveRevision);
          rememberIssuedSnapshot(
            projectId,
            durableOutbox.saveRevision,
            durableOutbox.snapshot
          );
          usedDurableOutbox = true;
        } else if (
          durableOutbox &&
          useLatestLocalSnapshot &&
          localSnapshot?.issuedRevision === durableOutbox.saveRevision &&
          JSON.stringify(localSnapshot.snapshot) ===
            JSON.stringify(durableOutbox.snapshot)
        ) {
          // The in-memory high-water snapshot already represents this durable
          // request even when the server GET is stale. Replay it without also
          // scheduling a redundant catch-up POST for the same snapshot.
          usedDurableOutbox = true;
        }
      }

      let hydrationSafeToPersist = false;
      let reconciliationChanged = false;
      let completedConflictReload = false;
      if (found) {
        let synchronousReconnect: boolean;
        try {
          // Reset before applying the target, then treat the entire synchronous
          // restore as one boundary so malformed nested persisted data cannot
          // strand hydration or leave a partially applied project behind.
          useRepurposeStore.getState().resetProject();
          synchronousReconnect = hydrateSnapshot(found.snapshot);
        } catch (error) {
          if (cancelled || reconciliationAborter.signal.aborted) return;
          console.error("[Repurpose Studio] PROJECT_RESTORE_FAILED", error);
          useRepurposeStore.getState().resetProject();
          const preservedConflict = conflictedSaveRef.current;
          if (
            reloadConflictProjectRef.current === projectId &&
            preservedConflict?.id === projectId
          ) {
            hydrateSnapshot(preservedConflict.snapshot);
            reloadConflictProjectRef.current = null;
            forceReloadRef.current = false;
            releaseHydration();
            markReady();
            settleConflictReload(projectId, false);
            return;
          }
          setLoadError("Não foi possível carregar o projeto. Tente novamente.");
          releaseHydration();
          if (reloadConflictProjectRef.current === projectId) {
            forceReloadRef.current = true;
          }
          return;
        }
        let reconciled: { needsReimport: boolean; safeToPersist: boolean };
        try {
          reconciled = await reconcileHydratedMedia(
            reconciliationAborter.signal
          );
          hydrationSafeToPersist = reconciled.safeToPersist;
          const current = useRepurposeStore.getState();
          reconciliationChanged =
            JSON.stringify({
              footageMeta: found.snapshot.footageMeta ?? null,
              mediaAssets: found.snapshot.mediaAssets ?? [],
              overlays: (found.snapshot.overlays ?? []).map(restoreOverlay),
            }) !==
            JSON.stringify({
              footageMeta: current.footageMeta,
              mediaAssets: current.mediaAssets,
              overlays: current.overlays,
            });
        } catch {
          if (cancelled || reconciliationAborter.signal.aborted) return;
          reconciled = { needsReimport: true, safeToPersist: false };
          useRepurposeStore
            .getState()
            .setMediaReadiness(
              "error",
              "Não foi possível verificar os arquivos de vídeo."
            );
        }
        if (cancelled || reconciliationAborter.signal.aborted) return;
        currentIdRef.current = projectId;
        createdRef.current = true;
        creatingRef.current = false;
        projectNameRef.current = found.name;
        const control = saveControlFor(projectId);
        control.acknowledgedRevision = rememberAcknowledgedRevision(
          projectId,
          Math.max(control.acknowledgedRevision, found.saveRevision)
        );
        control.nextRevision = rememberIssuedRevision(
          projectId,
          Math.max(control.nextRevision, found.saveRevision)
        );
        control.blocked = false;
        setProjectName(found.name);
        setFootageNeedsReimport(
          synchronousReconnect || reconciled.needsReimport
        );
        if (reloadConflictProjectRef.current === projectId) {
          discardConflictedPendingRef.current?.(projectId);
          reloadConflictProjectRef.current = null;
          conflictedSaveRef.current = null;
          setSaveConflict(null);
          completedConflictReload = true;
        }
      } else {
        // Reset before establishing the empty baseline for a genuine not-found.
        useRepurposeStore.getState().resetProject();
        // Valid-looking slug with no disk record (a mid-create reload). Treat like
        // an empty editor but re-create under THIS id once a name derives.
        currentIdRef.current = null;
        createdRef.current = false;
        creatingRef.current = false;
        projectNameRef.current = null;
        createdAtRef.current = undefined;
        const control = saveControlFor(projectId);
        control.acknowledgedRevision = rememberAcknowledgedRevision(
          projectId,
          control.acknowledgedRevision
        );
        control.nextRevision = rememberIssuedRevision(
          projectId,
          control.nextRevision
        );
        control.blocked = false;
        setProjectName(null);
        setFootageNeedsReimport(false);
      }

      const snapshotBeforeReplay = found
        ? JSON.stringify(snapshotFromStore())
        : null;
      const hadDurableOutbox = readSaveOutbox(projectId) !== null;
      const replaySettled = hadDurableOutbox
        ? (await replaySaveOutboxRef.current?.(projectId)) ?? false
        : true;
      if (cancelled || reconciliationAborter.signal.aborted) return;
      if (!replaySettled) {
        forceReloadRef.current = true;
        setLoadError(
          "Não foi possível sincronizar as alterações pendentes. Verifique sua conexão e tente novamente."
        );
        releaseHydration();
        return;
      }
      const changedDuringReplay =
        snapshotBeforeReplay !== null &&
        JSON.stringify(snapshotFromStore()) !== snapshotBeforeReplay;

      forceReloadRef.current = false;
      releaseHydration();
      markReady();
      if (completedConflictReload) {
        settleConflictReload(projectId, true);
      }
      if (
        found &&
        replaySettled &&
        hydrationSafeToPersist &&
        (reconciliationChanged ||
          changedDuringReplay ||
          (usedIssuedLocalSnapshot && !usedDurableOutbox))
      ) {
        scheduleCatchUpSaveRef.current?.(projectId);
      }
    })();

    return () => {
      cancelled = true;
      reconciliationAborter.abort();
      releaseHydration();
    };
    // Re-run whenever the route's project changes.
  }, [loadAttempt, projectId, saveControlFor, settleConflictReload]);

  const resolveSaveConflict = useCallback(
    async (action: "save-copy" | "reload"): Promise<boolean> => {
      const entry = conflictedSaveRef.current;
      if (!entry || resolvingConflictRef.current) return false;
      const expectedMountOwnership = mountOwnershipRef.current;
      const expectedRouteProjectId = routeProjectIdRef.current;
      if (
        !expectedMountOwnership ||
        expectedRouteProjectId !== entry.id ||
        currentIdRef.current !== entry.id
      ) {
        return false;
      }

      resolvingConflictRef.current = true;
      try {
        if (action === "reload") {
          reloadConflictProjectRef.current = entry.id;
          forceReloadRef.current = true;
          return await new Promise<boolean>((resolve) => {
            reloadConflictResultRef.current = {
              projectId: entry.id,
              resolve,
            };
            setLoadAttempt((attempt) => attempt + 1);
          });
        }

        const copyKey = `conflict-copy-${entry.id}-${entry.serverRevision ?? "unknown"}`;
        const createRequestId = getCreateRequestId(copyKey);
        const createControlId = `create-${createRequestId}`;
        const control = saveControlFor(createControlId);
        const requestSnapshot = cloneProjectSnapshot(
          entry.origin === "outbox" ? entry.snapshot : snapshotFromStore()
        );
        const saveRevision = issueProjectSaveRevision(
          createControlId,
          control,
          requestSnapshot
        );
        const result = await postProject({
          id: `${entry.id}-copy`,
          name: `${entry.name} (cópia)`,
          createdAt: new Date().toISOString(),
          writerId: getSaveWriterId(),
          baseRevision: 0,
          saveRevision,
          snapshot: requestSnapshot,
          mode: "create",
          createRequestId,
        });
        if (result.kind !== "saved") return false;
        if (
          mountOwnershipRef.current !== expectedMountOwnership ||
          routeProjectIdRef.current !== expectedRouteProjectId ||
          currentIdRef.current !== entry.id ||
          conflictedSaveRef.current !== entry
        ) {
          return false;
        }

        const saved = result.project;
        currentIdRef.current = saved.id;
        projectNameRef.current = saved.name;
        createdAtRef.current = saved.createdAt;
        createdRef.current = true;
        creatingRef.current = false;
        control.acknowledgedRevision = saved.saveRevision ?? saveRevision;
        control.nextRevision = Math.max(
          control.nextRevision,
          control.acknowledgedRevision
        );
        rememberAcknowledgedRevision(
          createControlId,
          control.acknowledgedRevision
        );
        moveRealmProjectState(createControlId, saved.id);
        saveControlsRef.current.delete(createControlId);
        saveControlsRef.current.set(saved.id, control);
        discardConflictedPendingRef.current?.(entry.id);
        clearSaveOutbox(entry.id);
        conflictedSaveRef.current = null;
        setSaveConflict(null);
        setProjectName(saved.name);
        if (saved.id !== projectId) {
          router.replace(`/repurpose-studio/${saved.id}`);
        }
        return true;
      } finally {
        resolvingConflictRef.current = false;
      }
    },
    [projectId, router, saveControlFor]
  );

  // --- auto-create the dated-slug project on first real content --------------
  const createProjectFromStore = useCallback(async () => {
    if (
      creatingRef.current ||
      createdRef.current ||
      createRetryBlockedRef.current
    ) {
      return false;
    }
    const s = useRepurposeStore.getState();
    const name = deriveProjectTitle(s.words, s.footageMeta, s.clips);
    // No derivable title yet -> defer; a later store change retries.
    if (!name) return false;
    const expectedMountOwnership = mountOwnershipRef.current;
    if (!expectedMountOwnership) return false;

    creatingRef.current = true; // synchronous lock BEFORE the await
    const expectedLoadOwnership = loadOwnershipRef.current;
    const nowIso = new Date().toISOString();
    // If the URL already carried a valid slug (a 404 mid-create reload), re-use it;
    // otherwise mint a fresh dated slug from the derived name + the real clock.
    const baseId =
      !isProvisionalId(projectId) && currentIdRef.current === null
        ? projectId
        : datedSlug(name, new Date());

    const realmWriterId = getSaveWriterId();
    const pendingCreateAttempt = readProvisionalCreateAttempt(projectId);
    const createRequestId =
      pendingCreateAttempt?.createRequestId ?? getCreateRequestId(projectId);
    const createControlId = `create-${createRequestId}`;
    const control = saveControlFor(createControlId);
    const createSnapshot = cloneProjectSnapshot(snapshotFromStore());
    // A reload creates a fresh browser realm (and therefore a fresh normal-save
    // writer). If the provisional URL still has an unacknowledged create, replay
    // its exact writer/revision tuple so the server can return the original
    // commit. Same-realm retries continue issuing higher revisions as before.
    const replayAfterReload =
      pendingCreateAttempt !== null &&
      pendingCreateAttempt.writerId !== realmWriterId;
    const writerId = replayAfterReload
      ? pendingCreateAttempt.writerId
      : realmWriterId;
    const baseRevision = replayAfterReload
      ? pendingCreateAttempt.baseRevision
      : control.acknowledgedRevision;
    const saveRevision = replayAfterReload
      ? pendingCreateAttempt.saveRevision
      : issueProjectSaveRevision(createControlId, control, createSnapshot);
    rememberProvisionalCreateAttempt(projectId, {
      writerId,
      createRequestId,
      baseRevision,
      saveRevision,
    });
    const result = await postProject({
      id: baseId,
      name,
      createdAt: nowIso,
      writerId,
      baseRevision,
      saveRevision,
      createRequestId,
      snapshot: createSnapshot,
      // Force a collision-free id: a new project must never overwrite an existing
      // one, even when the derived name+date slug is identical (append -2/-3).
      mode: "create",
    });

    const stillOwnsCreate =
      mountOwnershipRef.current === expectedMountOwnership &&
      routeProjectIdRef.current === projectId &&
      loadOwnershipRef.current === expectedLoadOwnership &&
      currentIdRef.current === null &&
      !createdRef.current;
    if (!stillOwnsCreate) return false;

    if (result.kind !== "saved") {
      if (result.kind === "conflict") {
        createRetryBlockedRef.current = true;
        control.blocked = true;
        console.error("[Repurpose Studio] PROJECT_SAVE_CONFLICT", {
          projectId: baseId,
          serverProject: result.project,
        });
      } else {
        createRetryBlockedRef.current = false;
      }
      // Create failed (offline/disk error) -> unlock and let a later change retry.
      creatingRef.current = false;
      return false;
    }
    const saved = result.project;
    createRetryBlockedRef.current = false;

    currentIdRef.current = saved.id; // authoritative -- may be -2/-3 suffixed
    projectNameRef.current = saved.name;
    createdAtRef.current = saved.createdAt;
    control.acknowledgedRevision =
      typeof saved.saveRevision === "number"
        ? saved.saveRevision
        : saveRevision;
    rememberAcknowledgedRevision(
      createControlId,
      control.acknowledgedRevision
    );
    control.nextRevision = Math.max(
      control.nextRevision,
      control.acknowledgedRevision
    );
    moveRealmProjectState(createControlId, saved.id);
    control.nextRevision = rememberIssuedRevision(saved.id, control.nextRevision);
    control.acknowledgedRevision = rememberAcknowledgedRevision(
      saved.id,
      control.acknowledgedRevision
    );
    saveControlsRef.current.delete(createControlId);
    saveControlsRef.current.set(saved.id, control);
    createdRef.current = true;
    creatingRef.current = false;
    setProjectName(saved.name);
    forgetProvisionalCreateAttempt(projectId);

    return true;
  }, [projectId, saveControlFor]);

  // --- (B) AUTOSAVE (LEVEL-TRIGGERED -- cannot drop a change) -----------------
  // Why level-triggered, not edge-triggered: the old design used a `dirty` flag
  // that some early-return paths (notably the create-in-flight lock) forgot to
  // set, so store changes that landed during a save/create window were silently
  // dropped -- that lost footageMeta, and mediaAssets/overlays/music the same way.
  //
  // This version can NEVER drop a change. Every store change bumps a monotonic
  // `storeVersion`. A single debounced saver saves the CURRENT snapshot whenever
  // `storeVersion !== savedVersion`, then re-checks after the async POST resolves;
  // if anything changed while that POST was in flight, it saves again. There is no
  // per-field logic and no lock that can swallow an update -- convergence to
  // "disk == latest store" is guaranteed for ANY field, in ANY order.
  useEffect(() => {
    if (!isBrowser()) return;

    let storeVersion = 0; // bumped on every store change
    let savedVersion = 0; // the version last successfully persisted
    let saving = false; // a POST is in flight
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    // Keep the retry strictly after the one-second backoff boundary. This avoids
    // re-entering the save in the same fake-timer tick that observed the failure.
    let retryDelayMs = 1_001;
    let createRetryDelayMs = 1_001;
    let createRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushingVersion = 0;
    let flushPromise: Promise<void> | null = null;
    type PendingSaveEntry = {
      id: string;
      name: string;
      createdAt?: string;
      snapshot?: ProjectSnapshot;
      version: number;
    };
    let pendingSave: PendingSaveEntry | null = null;

    const discardConflictedPending = (conflictedProjectId: string) => {
      if (pendingSave?.id === conflictedProjectId) {
        savedVersion = Math.max(savedVersion, pendingSave.version);
        pendingSave = null;
      }
      saveControlFor(conflictedProjectId).blocked = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    discardConflictedPendingRef.current = discardConflictedPending;

    const ownsRoute = (id: string, name: string) =>
      currentIdRef.current === id &&
      projectNameRef.current === name &&
      (routeProjectIdRef.current === id ||
        (isProvisionalId(projectId) && routeProjectIdRef.current === projectId));

    const recordRecoverableConflict = (
      entry: PendingSaveEntry,
      request: ProjectSaveRequest,
      result: Extract<ProjectSaveResult, { kind: "conflict" }>,
      origin: ConflictedSaveEntry["origin"]
    ) => {
      if (!active || !ownsRoute(entry.id, entry.name)) return;
      const control = saveControlFor(entry.id);
      control.blocked = true;
      const serverRevision =
        typeof result.project?.saveRevision === "number"
          ? result.project.saveRevision
          : null;
      conflictedSaveRef.current = {
        ...entry,
        snapshot: cloneProjectSnapshot(request.snapshot),
        serverRevision,
        origin,
      };
      setSaveConflict({
        projectId: entry.id,
        reason: result.reason,
        serverRevision,
        serverWriterId:
          typeof result.project?.saveWriterId === "string"
            ? result.project.saveWriterId
            : null,
      });
      console.error("[Repurpose Studio] PROJECT_SAVE_CONFLICT", {
        projectId: entry.id,
        serverProject: result.project,
      });
    };

    let replayingOutbox = false;
    const replaySaveOutbox = async (
      expectedProjectId: string
    ): Promise<boolean> => {
      if (replayingOutbox || !active) return false;
      const request = readSaveOutbox(expectedProjectId);
      if (!request) return true;
      if (!ownsRoute(request.id, request.name)) return false;
      replayingOutbox = true;
      try {
        const result = await postProject(request);
        if (!active || !ownsRoute(request.id, request.name)) return false;
        const supersededRevision =
          result.kind === "conflict"
            ? confirmedSameWriterRevision(result, request)
            : null;
        const confirmedRevision =
          result.kind === "saved"
            ? (result.project.saveRevision ?? request.saveRevision)
            : supersededRevision;
        if (confirmedRevision !== null) {
          const control = saveControlFor(request.id);
          control.acknowledgedRevision = Math.max(
            control.acknowledgedRevision,
            confirmedRevision
          );
          control.nextRevision = Math.max(
            control.nextRevision,
            control.acknowledgedRevision
          );
          rememberAcknowledgedRevision(
            request.id,
            control.acknowledgedRevision
          );
          rememberIssuedRevision(request.id, control.nextRevision);
          clearSaveOutbox(request.id, confirmedRevision);
          if (
            flushingVersion > 0 &&
            pendingSave?.id === request.id &&
            pendingSave.version <= flushingVersion
          ) {
            savedVersion = Math.max(savedVersion, flushingVersion);
            pendingSave = null;
          }
        } else if (result.kind === "conflict") {
          recordRecoverableConflict(
            {
              id: request.id,
              name: request.name,
              createdAt: request.createdAt,
              snapshot: request.snapshot,
              version: storeVersion,
            },
            request,
            result,
            "outbox"
          );
          return true;
        }
        return result.kind !== "failed";
      } finally {
        replayingOutbox = false;
      }
    };
    replaySaveOutboxRef.current = replaySaveOutbox;
    if (readyRef.current) void replaySaveOutbox(projectId);

    // Perform one save of the current store state, then loop if more changes
    // arrived during the POST (so an in-flight-window change is never lost).
    const runSave = async () => {
      if (saving) return;
      saving = true;
      try {
        while (savedVersion !== storeVersion) {
          const currentId = currentIdRef.current;
          const currentName = projectNameRef.current;
          if (!currentId || !currentName) break;
          let entry = pendingSave;
          if (!entry) {
            entry = {
              id: currentId,
              name: currentName,
              createdAt: createdAtRef.current,
              version: storeVersion,
            };
            pendingSave = entry;
          }
          if (!ownsRoute(entry.id, entry.name)) break;
          const control = saveControlFor(entry.id);
          if (control.blocked) {
            break;
          }
          const materializedSnapshot =
            entry.snapshot ?? cloneProjectSnapshot(snapshotFromStore());
          entry.snapshot = materializedSnapshot;
          const requestSnapshot = cloneProjectSnapshot(materializedSnapshot);
          const request: ProjectSaveRequest = {
            id: entry.id,
            name: entry.name,
            createdAt: entry.createdAt,
            writerId: getSaveWriterId(),
            baseRevision: control.acknowledgedRevision,
            saveRevision: issueProjectSaveRevision(
              entry.id,
              control,
              requestSnapshot
            ),
            snapshot: requestSnapshot,
          };
          const result = await postProject(request);
          const supersededRevision =
            result.kind === "conflict"
              ? confirmedSameWriterRevision(result, request)
              : null;
          const confirmedRevision =
            result.kind === "saved"
              ? (result.project.saveRevision ?? request.saveRevision)
              : supersededRevision;
          // Only advance savedVersion on a confirmed write; a failed POST leaves
          // savedVersion behind so the next tick retries.
          if (confirmedRevision !== null) {
            retryDelayMs = 1_001;
            control.acknowledgedRevision = Math.max(
              control.acknowledgedRevision,
              confirmedRevision
            );
            control.nextRevision = Math.max(
              control.nextRevision,
              control.acknowledgedRevision
            );
            rememberAcknowledgedRevision(
              entry.id,
              control.acknowledgedRevision
            );
            rememberIssuedRevision(entry.id, control.nextRevision);
            clearSaveOutbox(entry.id, confirmedRevision);
            savedVersion = Math.max(savedVersion, entry.version);
            if (pendingSave === entry) pendingSave = null;
          } else if (result.kind === "conflict") {
            recordRecoverableConflict(entry, request, result, "live");
            break;
          } else {
            if (timer === null && ownsRoute(entry.id, entry.name)) {
              const delay = retryDelayMs;
              retryDelayMs = Math.min(retryDelayMs * 2, 8_000);
              timer = setTimeout(() => {
                timer = null;
                if (active) void runSave();
              }, delay);
            }
            break;
          }
        }
      } finally {
        saving = false;
      }
    };

    const scheduleCreateRetry = () => {
      if (createRetryTimer !== null || !active || createdRef.current) return;
      const delay = createRetryDelayMs;
      createRetryDelayMs = Math.min((createRetryDelayMs - 1) * 2 + 1, 8_001);
      createRetryTimer = setTimeout(() => {
        createRetryTimer = null;
        void attemptCreate();
      }, delay);
    };

    const attemptCreate = async () => {
      const state = useRepurposeStore.getState();
      if (!deriveProjectTitle(state.words, state.footageMeta, state.clips)) return;
      const createdByThisAttempt = await createProjectFromStore();
      if (!active) return;
      if (createdByThisAttempt) {
        createRetryDelayMs = 1_001;
        if (createRetryTimer !== null) {
          clearTimeout(createRetryTimer);
          createRetryTimer = null;
        }
        // Enter the catch-up into the normal pending-save path before changing
        // routes so effect cleanup can durably transfer an in-flight save.
        void runSave();
        const createdId = currentIdRef.current;
        if (createdId && createdId !== projectId) {
          router.replace(`/repurpose-studio/${createdId}`);
        }
        return;
      }
      if (
        !creatingRef.current &&
        !createdRef.current &&
        !createRetryBlockedRef.current &&
        readyRef.current
      ) {
        scheduleCreateRetry();
      }
    };

    const enqueueSave = () => {
      // Any qualifying change bumps the version -- this is the ONLY place a change
      // is recorded, so nothing downstream can forget to.
      const id = currentIdRef.current;
      const name = projectNameRef.current;
      if (id && saveControlFor(id).blocked) return;
      storeVersion++;
      if (id && name) {
        pendingSave = {
          id,
          name,
          createdAt: createdAtRef.current,
          version: storeVersion,
        };
      }
      // Preserve the newer version while the older durable request owns network
      // ordering. resumeSave will replay it first, then run this pending entry.
      if (id && readSaveOutbox(id)) return;

      // Not yet created on disk -> create first (createProjectFromStore sets
      // createdRef + the id/name refs), then run one level-triggered save. We do
      // NOT optimistically advance savedVersion here: the create snapshotted at
      // create time, but later changes from the same ingest burst (footageMeta,
      // mediaAssets) may have arrived after that snapshot. Leaving savedVersion at
      // 0 forces runSave() to persist the CURRENT state after create, converging
      // disk to the true latest -- so nothing from the burst is ever lost.
      if (!createdRef.current) {
        void attemptCreate();
        return;
      }

      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runSave();
      }, SAVE_DEBOUNCE_MS);
    };

    const scheduleSave = () => {
      // Don't autosave until the initial load settled (avoid a hydrate-driven POST).
      if (!readyRef.current) return;
      const s = useRepurposeStore.getState();
      // This guard applies to new-project autosave only. A successfully loaded
      // existing project uses the catch-up path below even when it contains only
      // media-bin assets or overlays.
      if (!createdRef.current) {
        const exists = s.clips.length > 0 || s.footageMeta != null;
        if (!exists) return;
      }
      enqueueSave();
    };

    const scheduleCatchUpSave = (expectedProjectId: string) => {
      if (
        currentIdRef.current !== expectedProjectId ||
        !createdRef.current ||
        !readyRef.current
      ) {
        return;
      }
      storeVersion++;
      void runSave();
    };
    scheduleCatchUpSaveRef.current = scheduleCatchUpSave;

    const flushSave = (durable: boolean) => {
      // Nothing unsaved -> no-op.
      if (
        savedVersion === storeVersion ||
        flushingVersion >= storeVersion
      ) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const entry = pendingSave;
      if (!entry) return;
      const { id, name } = entry;
      const versionAtSend = entry.version;
      const control = saveControlFor(id);
      if (control.blocked) {
        return;
      }
      flushingVersion = versionAtSend;
      // sendBeacon is the reliable unload-time POST (a normal fetch is cancelled).
      const materializedSnapshot =
        entry.snapshot ?? cloneProjectSnapshot(snapshotFromStore());
      entry.snapshot = materializedSnapshot;
      const requestSnapshot = cloneProjectSnapshot(materializedSnapshot);
      const request: ProjectSaveRequest = {
        id,
        name,
        createdAt: entry.createdAt,
        writerId: getSaveWriterId(),
        baseRevision: control.acknowledgedRevision,
        saveRevision: issueProjectSaveRevision(id, control, requestSnapshot),
        snapshot: requestSnapshot,
      };
      const durableStored = durable ? writeSaveOutbox(request) : true;
      if (!durableStored) {
        setSaveError(
          "Não foi possível proteger as alterações pendentes neste navegador."
        );
      }
      const fallback = () => {
        const pendingFlush = postProject(request, true)
          .then((result) => {
            if (result.kind === "saved") {
              control.acknowledgedRevision = Math.max(
                control.acknowledgedRevision,
                result.project.saveRevision ?? request.saveRevision
              );
              rememberAcknowledgedRevision(id, control.acknowledgedRevision);
              rememberIssuedRevision(id, control.acknowledgedRevision);
              clearSaveOutbox(id, control.acknowledgedRevision);
              if (active) setSaveError(null);
              savedVersion = Math.max(savedVersion, versionAtSend);
              if (pendingSave === entry) pendingSave = null;
            } else if (result.kind === "conflict") {
              const supersededRevision = confirmedSameWriterRevision(
                result,
                request
              );
              if (supersededRevision === null) {
                recordRecoverableConflict(entry, request, result, "live");
              } else {
                control.acknowledgedRevision = Math.max(
                  control.acknowledgedRevision,
                  supersededRevision
                );
                rememberAcknowledgedRevision(id, control.acknowledgedRevision);
                rememberIssuedRevision(id, control.acknowledgedRevision);
                clearSaveOutbox(id, control.acknowledgedRevision);
                savedVersion = Math.max(savedVersion, versionAtSend);
                if (pendingSave === entry) pendingSave = null;
              }
            }
          })
          .finally(() => {
            if (flushingVersion === versionAtSend) flushingVersion = 0;
            if (flushPromise === pendingFlush) flushPromise = null;
          });
        flushPromise = pendingFlush;
      };
      try {
        const body = JSON.stringify(request);
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon("/api/repurpose/projects", blob)) {
          // `true` only means that the browser accepted the beacon for delivery;
          // it is not an application-level acknowledgement. Keep the captured
          // entry pending so a normal POST can confirm it if the page resumes.
          if (!durableStored) fallback();
        } else {
          fallback();
        }
      } catch {
        fallback();
      }
    };

    const unsubscribe = useRepurposeStore.subscribe(scheduleSave);

    const onPageHide = () => flushSave(true);
    const resumeSave = async () => {
      // A keepalive fallback may still be settling when visibility resumes.
      // Serialize the normal POST after every active flush so the same snapshot
      // is not sent concurrently and runSave can re-check route ownership.
      while (flushPromise) await flushPromise;
      if (!active || document.visibilityState === "hidden") return;
      await replaySaveOutbox(projectId);
      flushingVersion = 0;
      await runSave();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSave(true);
      else void resumeSave();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      active = false;
      if (discardConflictedPendingRef.current === discardConflictedPending) {
        discardConflictedPendingRef.current = null;
      }
      if (scheduleCatchUpSaveRef.current === scheduleCatchUpSave) {
        scheduleCatchUpSaveRef.current = null;
      }
      if (replaySaveOutboxRef.current === replaySaveOutbox) {
        replaySaveOutboxRef.current = null;
      }
      unsubscribe();
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flushSave(true);
      if (timer !== null) clearTimeout(timer);
      if (createRetryTimer !== null) clearTimeout(createRetryTimer);
    };
  }, [createProjectFromStore, projectId, router, saveControlFor]);

  // --- (D) [removed] no beforeunload confirm ---------------------------------
  // The old native "Reload site? Changes may not be saved" confirm is gone:
  // every edit autosaves (debounced subscription above) and section (C) flushes
  // the latest snapshot on pagehide / visibility-hidden, so a reload or close
  // never loses work. The prompt was pure friction. Do not re-add it.

  return {
    footageNeedsReimport,
    projectName,
    ready,
    loadError,
    saveError,
    retryLoad,
    saveConflict,
    resolveSaveConflict,
  };
}
