// ===========================================================================
// REPURPOSE STUDIO -- overlay ingest
// ===========================================================================
// The shared pipeline that turns a picked/dropped/pasted image or video File
// into a persisted Overlay in the store. It is the ONE place an overlay comes
// into existence, no matter the entry point (drag-drop onto the timeline, paste
// from the clipboard, or the "Add media" button in the Inspector).
//
// WHY A COPY-TO-DISK STEP: a browser blob: URL (URL.createObjectURL) dies the
// moment the page reloads, so an overlay stored with a bare blob: src would go
// dead on refresh. Instead we POST the raw bytes to /api/repurpose/asset, which
// writes them under ~/Downloads/repurpose-overlays and hands back a STABLE
// absolute path; that path is proxied through a range-serving route so <img>/
// <video> can load it, and it survives reload. The temporary blob: URL is used
// ONLY to read the file's intrinsic dimensions/duration (a throwaway <img>/
// <video>), then immediately revoked -- the persisted `src` is never a blob URL.
//
// FALLBACK: if the disk copy fails (route down / offline), we keep the overlay
// on the transient blob: URL and mark it needsReconnect so the session still
// works; a reload will surface the reconnect path rather than a dead frame.
// ===========================================================================

import { footageUrlForPath } from "./ingest";
import { effectiveSplitRatio } from "./split-ratio";
import { useRepurposeStore } from "./store";
import { splitRatioAt } from "./time-map";
import type { VideoImportPhase } from "./types";
import {
  importVideoFile,
  VideoImportError,
  videoUrlForWorkingSource,
} from "./video-import-client";
import { ensureVideoProxy } from "./video-proxy-client";

export interface OverlayImportState {
  phase: VideoImportPhase;
  progress: number | null;
  error?: string;
}

export interface OverlayImportOwner {
  readonly id: number;
}

const defaultOverlayImportOwner: OverlayImportOwner = { id: 0 };
const overlayImportListeners = new Map<
  OverlayImportOwner,
  Set<(state: OverlayImportState | null) => void>
>();
const overlayImportStates = new Map<
  OverlayImportOwner,
  OverlayImportState | null
>();
let overlayImportGeneration = 0;
let overlayImportOwnerId = 0;
let activeEditorOwner: OverlayImportOwner | null = null;
interface OverlayImportOperation {
  generation: number;
  controller: AbortController;
  owner: OverlayImportOwner;
  projectEpoch: number;
}
let activeOverlayImport: OverlayImportOperation | null = null;

const OVERLAY_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const OVERLAY_VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "webm", "mkv"]);
const CANONICAL_PREVIEW_RECT = { left: 0, top: 0, width: 1080, height: 1920 };

function addOverlayAtCurrentFrame(
  descriptor: Parameters<ReturnType<typeof useRepurposeStore.getState>["addOverlay"]>[0]
): string {
  const store = useRepurposeStore.getState();
  const split = effectiveSplitRatio(
    splitRatioAt(store.clips, store.playhead, store.splitRatio),
    CANONICAL_PREVIEW_RECT.height
  );
  return store.addOverlay(descriptor, CANONICAL_PREVIEW_RECT, split);
}

export function classifyOverlayFile(file: File): "image" | "video" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (OVERLAY_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (OVERLAY_VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

function isVideoImportCancellation(error: unknown): boolean {
  return (
    error instanceof VideoImportError &&
    [
      "VIDEO_IMPORT_CANCELLED",
      "COMPATIBILITY_CANCELLED",
      "MEDIA_PROBE_ABORTED",
    ].includes(error.code)
  );
}

function publishOverlayImport(
  owner: OverlayImportOwner,
  state: OverlayImportState | null
): void {
  overlayImportStates.set(owner, state);
  for (const listener of overlayImportListeners.get(owner) ?? []) listener(state);
}

export function overlayImportErrorMessage(error: unknown): string {
  return error instanceof VideoImportError
    ? error.message
    : "Não foi possível importar uma ou mais mídias.";
}

export function surfaceOverlayImportError(
  error: unknown,
  owner: OverlayImportOwner = defaultOverlayImportOwner
): void {
  if (isVideoImportCancellation(error)) {
    publishOverlayImport(owner, { phase: "cancelled", progress: null });
    return;
  }
  publishOverlayImport(owner, {
    phase: "error",
    progress: null,
    error: overlayImportErrorMessage(error),
  });
}

export function subscribeOverlayImport(
  listener: (state: OverlayImportState | null) => void,
  owner: OverlayImportOwner = defaultOverlayImportOwner
): () => void {
  const listeners = overlayImportListeners.get(owner) ?? new Set();
  listeners.add(listener);
  overlayImportListeners.set(owner, listeners);
  listener(overlayImportStates.get(owner) ?? null);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) overlayImportListeners.delete(owner);
  };
}

export function createOverlayImportOwner(): OverlayImportOwner {
  return { id: ++overlayImportOwnerId };
}

export function registerOverlayImportOwner(
  owner: OverlayImportOwner = createOverlayImportOwner()
): OverlayImportOwner {
  const previousOwner = activeEditorOwner;
  activeEditorOwner = owner;
  if (activeOverlayImport && activeOverlayImport.owner !== owner) {
    activeOverlayImport.controller.abort();
    activeOverlayImport = null;
  }
  if (previousOwner) publishOverlayImport(previousOwner, null);
  return owner;
}

export function cancelOverlayImport(
  owner: OverlayImportOwner = defaultOverlayImportOwner
): void {
  if (activeOverlayImport?.owner === owner) {
    activeOverlayImport.controller.abort();
  }
}

export function clearOverlayImport(
  owner: OverlayImportOwner = defaultOverlayImportOwner
): void {
  const operation = activeOverlayImport?.owner === owner
    ? activeOverlayImport
    : null;
  if (operation) activeOverlayImport = null;
  overlayImportGeneration += 1;
  operation?.controller.abort();
  publishOverlayImport(owner, null);
}

export function releaseOverlayImportOwner(owner: OverlayImportOwner): void {
  if (activeOverlayImport?.owner === owner) {
    const operation = activeOverlayImport;
    activeOverlayImport = null;
    operation.controller.abort();
  }
  if (activeEditorOwner === owner) activeEditorOwner = null;
  publishOverlayImport(owner, null);
  overlayImportStates.delete(owner);
}

function ownerIsCurrent(owner: OverlayImportOwner): boolean {
  return owner === defaultOverlayImportOwner || activeEditorOwner === owner;
}

function beginOverlayImport(owner: OverlayImportOwner): OverlayImportOperation {
  if (!ownerIsCurrent(owner)) {
    throw new VideoImportError("VIDEO_IMPORT_CANCELLED");
  }
  activeOverlayImport?.controller.abort();
  const operation = {
    generation: ++overlayImportGeneration,
    controller: new AbortController(),
    owner,
    projectEpoch: useRepurposeStore.getState().projectEpoch,
  };
  activeOverlayImport = operation;
  publishOverlayImport(owner, null);
  return operation;
}

function ownsOverlayImport(operation: OverlayImportOperation): boolean {
  return (
    activeOverlayImport === operation &&
    activeOverlayImport.generation === operation.generation &&
    ownerIsCurrent(operation.owner) &&
    useRepurposeStore.getState().projectEpoch === operation.projectEpoch
  );
}

function isActiveOverlayImport(operation: OverlayImportOperation): boolean {
  return ownsOverlayImport(operation) && !operation.controller.signal.aborted;
}

function assertActiveOverlayImport(operation: OverlayImportOperation): void {
  if (!isActiveOverlayImport(operation)) {
    throw new VideoImportError("VIDEO_IMPORT_CANCELLED");
  }
}

function queueOverlayVideoProxy(
  source: Parameters<typeof ensureVideoProxy>[0],
  overlayId: string,
  assetId: string,
  projectEpoch: number
): void {
  const controller = new AbortController();
  const unsubscribe = useRepurposeStore.subscribe((state) => {
    if (state.projectEpoch !== projectEpoch) controller.abort();
  });
  void ensureVideoProxy(source, controller.signal)
    .then((nextSource) => {
      const state = useRepurposeStore.getState();
      if (controller.signal.aborted || state.projectEpoch !== projectEpoch) return;
      if (
        state.overlays.find((overlay) => overlay.id === overlayId)?.videoSource ===
        source
      ) {
        state.setVideoSourceRecord(
          { kind: "overlay", id: overlayId },
          nextSource
        );
      }
      if (
        state.mediaAssets.find((asset) => asset.id === assetId)?.videoSource ===
        source
      ) {
        state.setVideoSourceRecord({ kind: "asset", id: assetId }, nextSource);
      }
    })
    .catch(() => undefined)
    .finally(unsubscribe);
}

/**
 * Resolve an overlay's on-disk (or already-loadable) source reference into a URL
 * an <img>/<video> can actually load. Images are proxied through the still-image
 * range route (`/api/repurpose/asset?path=...`); videos ride the existing footage
 * video route (`/api/repurpose/video?path=...`, which owns range + faststart).
 * Already-loadable references (blob:, data:, http(s):, app-relative /api/...)
 * pass straight through -- this only rewrites raw OS paths.
 */
export function overlayUrlForPath(ref: string, kind: "image" | "video"): string {
  if (ref === "") return ref;
  // Anything already loadable by the browser (a scheme, protocol-relative, or an
  // app-root URL) is returned untouched. footageUrlForPath handles that same set
  // plus the video-path proxy, so reuse it for videos directly.
  if (kind === "video") return footageUrlForPath(ref);

  // A Windows drive prefix looks like a URI scheme, so proxy it before the
  // generic scheme check below.
  if (/^[A-Za-z]:[\\/]/.test(ref)) {
    return `/api/repurpose/asset?path=${encodeURIComponent(ref)}`;
  }
  // Images: pass loadable URLs through, proxy raw disk paths via the asset route.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("/api/")) {
    return ref;
  }
  const looksLikeOsPath =
    ref.startsWith("/Users/") ||
    ref.startsWith("/home/") ||
    ref.startsWith("/var/") ||
    ref.startsWith("/tmp/") ||
    ref.startsWith("/private/") ||
    /^[A-Za-z]:[\\/]/.test(ref);
  if (looksLikeOsPath) {
    return `/api/repurpose/asset?path=${encodeURIComponent(ref)}`;
  }
  return ref;
}

/** Intrinsic media measurements read off a throwaway element. */
interface MediaProbe {
  width: number;
  height: number;
  /** Source duration in seconds (0 for stills). */
  duration: number;
}

/**
 * Read an image's intrinsic pixel size from a temporary object URL. The URL is
 * the caller's to revoke (we don't revoke here -- the same URL doubles as the
 * blob: fallback src if the disk copy later fails).
 */
function probeImage(objectUrl: string, signal: AbortSignal): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      img.onload = null;
      img.onerror = null;
      img.src = "";
      reject(new VideoImportError("VIDEO_IMPORT_CANCELLED"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    img.onload = () => {
      cleanup();
      resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
    };
    img.onerror = () => {
      cleanup();
      reject(new Error("Could not decode that image"));
    };
    img.src = objectUrl;
  });
}

/** kebab-case a filename stem for the asset route's `name` field (2..61 chars). */
function kebabName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  let kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (kebab.length < 2) kebab = `overlay-${kebab}`.replace(/-+$/g, "");
  if (kebab.length < 2) kebab = "overlay-media";
  return kebab.slice(0, 61);
}

/**
 * POST the raw bytes to /api/repurpose/asset (copy-to-disk) and return the stable
 * absolute path the route wrote. Throws on any non-ok response so the caller can
 * fall back to the blob: URL.
 */
async function persistToDisk(file: File, signal: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", kebabName(file.name || "overlay-media"));
  const res = await fetch("/api/repurpose/asset", {
    method: "POST",
    body: form,
    signal,
  });
  if (!res.ok) {
    throw new Error(`asset upload failed (${res.status})`);
  }
  const json = (await res.json()) as { ok?: boolean; path?: string; error?: string };
  if (!json.ok || !json.path) {
    throw new Error(json.error || "asset upload returned no path");
  }
  return json.path;
}

/** The result of an ingest -- the new overlay id, plus whether it fell back. */
export interface IngestOverlayResult {
  /** The store id of the created overlay (`ovl-N`). */
  id: string;
  /**
   * True when the disk copy failed and the overlay is on a transient blob: URL
   * (needsReconnect) -- it works this session but won't survive a reload.
   */
  needsReconnect: boolean;
}

/**
 * The shared ingest pipeline. Given a picked image/video File, an output time to
 * place it at (playhead or drop time), and an optional normalized drop point on
 * the 9:16 canvas:
 *   1. createObjectURL ONLY to read intrinsic dims/duration off a throwaway
 *      <img>/<video>,
 *   2. POST the bytes to /api/repurpose/asset (copy to disk) -> stable path,
 *   3. addOverlay with the proxied stable src (never a bare blob: URL),
 *   4. revoke the temp object URL.
 * On upload failure: keep the blob: URL as a transient src and flag needsReconnect
 * so the session still plays; a reload then asks Manthan to re-add it.
 *
 * Returns null for a file that isn't an image or video (caller ignores it).
 */
async function ingestOverlayFileForOperation(
  file: File,
  atTime: number,
  atPoint: { x: number; y: number } | undefined,
  operation: OverlayImportOperation
): Promise<IngestOverlayResult | null> {
  const kind = classifyOverlayFile(file);
  if (!kind) return null;
  const isVideo = kind === "video";

  if (isVideo) {
    const videoSource = await importVideoFile(file, {
      role: "overlay",
      signal: operation.controller.signal,
      onProgress: (state) => {
        if (isActiveOverlayImport(operation)) {
          publishOverlayImport(operation.owner, state);
        }
      },
    });
    assertActiveOverlayImport(operation);
    const inspection = videoSource.inspection;
    const src = videoUrlForWorkingSource(videoSource);
    const descriptor = {
      kind,
      src,
      sourcePath: videoSource.workingPath,
      videoSource,
      naturalWidth: Math.max(1, inspection.video.width),
      naturalHeight: Math.max(1, inspection.video.height),
      atTime,
      srcDuration: Math.max(0, inspection.durationSec),
      atPoint,
    } as const;
    const id = addOverlayAtCurrentFrame(descriptor);
    assertActiveOverlayImport(operation);
    const assetId = useRepurposeStore.getState().addMediaAsset({
      kind,
      name: file.name || "video",
      src,
      sourcePath: videoSource.workingPath,
      videoSource,
      naturalWidth: descriptor.naturalWidth,
      naturalHeight: descriptor.naturalHeight,
      srcDuration: descriptor.srcDuration,
    });
    queueOverlayVideoProxy(videoSource, id, assetId, operation.projectEpoch);
    return { id, needsReconnect: false };
  }

  // (1) Throwaway object URL, used only to measure the media (and, if the disk
  // copy fails, kept alive as the transient fallback src).
  const objectUrl = URL.createObjectURL(file);
  let keepObjectUrl = false;
  try {
    const probe = await probeImage(objectUrl, operation.controller.signal);
    assertActiveOverlayImport(operation);
    const naturalWidth = probe.width > 0 ? probe.width : 1;
    const naturalHeight = probe.height > 0 ? probe.height : 1;

    let src: string;
    let sourcePath: string | undefined;
    let needsReconnect = false;
    try {
      const diskPath = await persistToDisk(file, operation.controller.signal);
      assertActiveOverlayImport(operation);
      sourcePath = diskPath;
      src = overlayUrlForPath(diskPath, kind);
    } catch (error) {
      assertActiveOverlayImport(operation);
      src = objectUrl;
      needsReconnect = true;
    }

    assertActiveOverlayImport(operation);
    const id = addOverlayAtCurrentFrame({
      kind,
      src,
      sourcePath,
      naturalWidth,
      naturalHeight,
      atTime,
      atPoint,
    });
    assertActiveOverlayImport(operation);
    useRepurposeStore.getState().addMediaAsset({
      kind,
      name: file.name || "image",
      src,
      sourcePath,
      naturalWidth,
      naturalHeight,
    });
    keepObjectUrl = needsReconnect;
    return { id, needsReconnect };
  } finally {
    if (!keepObjectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export async function ingestOverlayFile(
  file: File,
  atTime: number,
  atPoint?: { x: number; y: number },
  owner: OverlayImportOwner = defaultOverlayImportOwner
): Promise<IngestOverlayResult | null> {
  if (!classifyOverlayFile(file)) return null;
  const operation = beginOverlayImport(owner);
  try {
    return await ingestOverlayFileForOperation(file, atTime, atPoint, operation);
  } catch (error) {
    if (ownsOverlayImport(operation)) {
      if (operation.controller.signal.aborted || isVideoImportCancellation(error)) {
        publishOverlayImport(owner, { phase: "cancelled", progress: null });
      } else {
        surfaceOverlayImportError(error, owner);
      }
    }
    throw error;
  } finally {
    if (activeOverlayImport === operation) activeOverlayImport = null;
  }
}

/**
 * Ingest EVERY image/video File in a list (a multi-file drop / paste / picker),
 * one after another, all placed at the same output time + drop point. Non-media
 * files are skipped. Returns the results for the files that produced an overlay.
 */
export async function ingestOverlayFiles(
  files: FileList | File[],
  atTime: number,
  atPoint?: { x: number; y: number },
  owner: OverlayImportOwner = defaultOverlayImportOwner
): Promise<IngestOverlayResult[]> {
  const mediaFiles = Array.from(files).filter(classifyOverlayFile);
  if (mediaFiles.length === 0) return [];
  const operation = beginOverlayImport(owner);
  const results: IngestOverlayResult[] = [];
  const failures: unknown[] = [];
  try {
    for (const file of mediaFiles) {
      try {
        const res = await ingestOverlayFileForOperation(
          file,
          atTime,
          atPoint,
          operation
        );
        if (res) results.push(res);
      } catch (error) {
        if (
          operation.controller.signal.aborted ||
          activeOverlayImport !== operation ||
          isVideoImportCancellation(error)
        ) {
          if (ownsOverlayImport(operation)) {
            publishOverlayImport(owner, { phase: "cancelled", progress: null });
          }
          return results;
        }
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      const failure =
        failures.find((error) => error instanceof VideoImportError) ??
        new Error(overlayImportErrorMessage(failures[0]));
      if (isActiveOverlayImport(operation)) {
        surfaceOverlayImportError(failure, owner);
      }
      throw failure;
    }
    return results;
  } finally {
    if (activeOverlayImport === operation) activeOverlayImport = null;
  }
}
