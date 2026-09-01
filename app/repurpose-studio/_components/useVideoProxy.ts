import { useCallback, useEffect, useRef, useState } from "react";

import { ensureVideoProxy } from "@/lib/repurpose/video-proxy-client";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type {
  VideoSourceRecord,
  VideoSourceTarget,
} from "@/lib/repurpose/types";

export interface VideoProxyState {
  src: string | undefined;
  usingProxy: boolean;
  buildProgress: number | null;
  onSrcError: () => void;
}

export interface UseVideoProxyOptions {
  target: VideoSourceTarget;
  source: VideoSourceRecord | undefined;
  fallbackSrc: string | undefined;
  durationSec?: number;
  isPlaying: boolean;
}

export function rawPathFromRef(ref: string | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith("/api/repurpose/video?")) {
    try {
      return new URL(ref, "http://localhost").searchParams.get("path");
    } catch {
      return null;
    }
  }
  if (
    ref.startsWith("/Users/") ||
    ref.startsWith("/home/") ||
    ref.startsWith("/Volumes/") ||
    ref.startsWith("/tmp/") ||
    /^[A-Za-z]:[\\/]/.test(ref)
  ) {
    return ref;
  }
  return null;
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

export function useVideoProxy({
  target,
  source,
  fallbackSrc,
  isPlaying,
}: UseVideoProxyOptions): VideoProxyState {
  const [readyPreview, setReadyPreview] = useState<string | null>(null);
  const [activePreview, setActivePreview] = useState<string | null>(null);
  const [buildProgress, setBuildProgress] = useState<number | null>(null);
  const [rebuildGeneration, setRebuildGeneration] = useState(0);
  const activePreviewRef = useRef<string | null>(null);
  const failedPreviewRef = useRef<{
    sourceIdentity: string;
    previewPath: string;
  } | null>(null);
  const ownedSourceRef = useRef<VideoSourceRecord | undefined>(source);
  const settledSourceRef = useRef<VideoSourceRecord | undefined>(undefined);
  const targetRef = useRef(target);
  const mountedRef = useRef(true);
  targetRef.current = target;
  const targetKey =
    target.kind === "footage"
      ? `footage:${target.role}`
      : `${target.kind}:${target.id}`;
  const sourceIdentity = source
    ? `${targetKey}\u0000${source.workingPath}\u0000${source.inspection.fingerprint}`
    : `${targetKey}\u0000${fallbackSrc ?? ""}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const target = targetRef.current;
    if (failedPreviewRef.current?.sourceIdentity !== sourceIdentity) {
      failedPreviewRef.current = null;
    }
    activePreviewRef.current = null;
    setReadyPreview(null);
    setActivePreview(null);
    setBuildProgress(null);
    ownedSourceRef.current = source;
    if (source === settledSourceRef.current) {
      setReadyPreview(source?.previewPath ?? null);
      return;
    }
    if (!source || !rawPathFromRef(fallbackSrc ?? source.workingPath)) return;

    const controller = new AbortController();
    const projectEpoch = useRepurposeStore.getState().projectEpoch;
    void ensureVideoProxy(source, controller.signal, (progress) => {
      if (mountedRef.current && !controller.signal.aborted) {
        setBuildProgress(progress);
      }
    }).then(
      (nextSource) => {
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          useRepurposeStore.getState().projectEpoch !== projectEpoch ||
          sourceAtTarget(target) !== source
        ) {
          return;
        }
        settledSourceRef.current = nextSource;
        ownedSourceRef.current = nextSource;
        useRepurposeStore.getState().setVideoSourceRecord(target, nextSource);
        setBuildProgress(null);
        setReadyPreview(nextSource.previewPath ?? null);
      },
      () => {
        if (controller.signal.aborted || !mountedRef.current) return;
        const current = sourceAtTarget(target);
        if (current === source && current.previewPath) {
          const cleared = { ...current, previewPath: undefined };
          settledSourceRef.current = cleared;
          ownedSourceRef.current = cleared;
          useRepurposeStore.getState().setVideoSourceRecord(target, cleared);
        }
        setBuildProgress(null);
      }
    );
    return () => controller.abort();
  }, [
    fallbackSrc,
    rebuildGeneration,
    source,
    sourceIdentity,
    targetKey,
  ]);

  useEffect(() => {
    if (!isPlaying && readyPreview && activePreview !== readyPreview) {
      activePreviewRef.current = readyPreview;
      setActivePreview(readyPreview);
    }
  }, [activePreview, isPlaying, readyPreview]);

  const onSrcError = useCallback(() => {
    const failedPreview = activePreviewRef.current;
    if (!failedPreview) return;
    activePreviewRef.current = null;
    setActivePreview(null);
    setReadyPreview(null);
    const target = targetRef.current;
    const current = sourceAtTarget(target);
    const shouldRetry =
      failedPreviewRef.current?.sourceIdentity !== sourceIdentity ||
      failedPreviewRef.current.previewPath !== failedPreview;
    failedPreviewRef.current = {
      sourceIdentity,
      previewPath: failedPreview,
    };
    if (current && current === ownedSourceRef.current && current.previewPath) {
      const cleared = { ...current, previewPath: undefined };
      if (!shouldRetry) settledSourceRef.current = cleared;
      ownedSourceRef.current = cleared;
      useRepurposeStore.getState().setVideoSourceRecord(target, cleared);
    }
    if (shouldRetry) {
      setRebuildGeneration((generation) => generation + 1);
    }
  }, [sourceIdentity]);

  return {
    src: activePreview ?? fallbackSrc,
    usingProxy: activePreview !== null,
    buildProgress,
    onSrcError,
  };
}
