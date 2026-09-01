"use client";

import { useEffect, useMemo, useRef } from "react";
import { Trash, Warning, SpeakerSlash } from "@phosphor-icons/react";

import type { SfxClip } from "@/lib/repurpose/types";
import { sfxClipTimelineEnd } from "@/lib/repurpose/sfx-clips";
import { formatTimecode } from "./timeline-utils";
import {
  sliceClipPeaks,
  waveformRenderMetrics,
  type FaceWaveform,
} from "./useFaceWaveform";
import type { TimelinePointerStart } from "./timeline-pointer";

export interface SfxClipBlockProps {
  clip: SfxClip;
  left: number;
  width: number;
  top: number;
  height: number;
  selected: boolean;
  missing: boolean;
  waveform: FaceWaveform | null;
  projectDuration: number;
  sourceDuration: number;
  timelineStep: number;
  onSelect: (id: string) => void;
  onMoveBy: (id: string, delta: number) => void;
  onTrimBy: (id: string, edge: "start" | "end", delta: number) => void;
  onBodyPointerDown: (clip: SfxClip, pointer: TimelinePointerStart) => void;
  onEdgePointerDown: (clip: SfxClip, edge: "start" | "end", pointer: TimelinePointerStart) => void;
  onDelete: (id: string) => void;
}

export function SfxClipBlock(props: SfxClipBlockProps) {
  const { clip, left, width, top, height, selected, missing, waveform } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderMetrics = useMemo(() => waveformRenderMetrics(
    width,
    height,
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
  ), [height, width]);
  const peaks = useMemo(() => sliceClipPeaks(
    waveform,
    clip.sourceStart,
    clip.sourceEnd,
    renderMetrics.binCount
  ), [clip.sourceEnd, clip.sourceStart, renderMetrics.binCount, waveform]);
  const end = sfxClipTimelineEnd(clip);
  const trimStartMin = Math.max(0, clip.timelineStart - clip.sourceStart);
  const trimStartMax = Math.max(trimStartMin, end - 1 / 1000);
  const trimEndMin = clip.timelineStart + 1 / 1000;
  const trimEndMax = Math.max(trimEndMin, Math.min(
    props.projectDuration,
    clip.timelineStart + props.sourceDuration - clip.sourceStart
  ));
  const keyboardDelta = (event: React.KeyboardEvent, direction: -1 | 1) =>
    direction * props.timelineStep * (event.shiftKey ? 10 : 1);
  const handleTrimKeyDown = (edge: "start" | "end") =>
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        props.onTrimBy(clip.id, edge, keyboardDelta(event, event.key === "ArrowLeft" ? -1 : 1));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        props.onSelect(clip.id);
      }
    };
  const label = [
    clip.name,
    clip.origin,
    `${formatTimecode(clip.timelineStart, true)} to ${formatTimecode(end, true)}`,
    clip.muted ? "muted" : null,
    missing ? "missing" : null,
  ].filter(Boolean).join(", ");

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || peaks.length === 0) return;
    const { backingHeight, backingWidth, cssHeight: h, cssWidth: w, scale } = renderMetrics;
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, w, h);
    context.fillStyle = "rgba(6, 78, 59, .8)";
    const barWidth = w / peaks.length;
    peaks.forEach((peak, index) => {
      const barHeight = Math.max(1, peak * (h - 4));
      context.fillRect(index * barWidth, h - barHeight, Math.max(1, barWidth * .7), barHeight);
    });
  }, [peaks, renderMetrics]);

  return (
    <div
      role="group"
      aria-label={label}
      data-sfx-clip-id={clip.id}
      data-testid={`sfx-block-${clip.id}`}
      className={`group absolute overflow-hidden rounded border bg-emerald-500/20 text-[10px] text-emerald-100 ${selected ? "border-emerald-200 ring-2 ring-emerald-300/70" : "border-emerald-500/50"}`}
      style={{ left, width: Math.max(6, width), top, height }}
    >
      {peaks.length > 0 && <canvas ref={canvasRef} aria-hidden
        className="pointer-events-none absolute left-0 top-0 opacity-60"
        style={{ width: renderMetrics.cssWidth, height: renderMetrics.cssHeight }} />}
      <button
        type="button"
        aria-label={`Select ${label}`}
        aria-pressed={selected}
        data-sfx-select-id={clip.id}
        className="absolute inset-0 z-10 flex items-center overflow-hidden px-2 text-left"
        onFocus={() => props.onSelect(clip.id)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          props.onMoveBy(clip.id, keyboardDelta(event, event.key === "ArrowLeft" ? -1 : 1));
        }}
        onClick={(event) => {
          event.stopPropagation();
          props.onSelect(clip.id);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          props.onSelect(clip.id);
          props.onBodyPointerDown(clip, {
            clientX: event.clientX,
            pointerId: event.pointerId,
            captureTarget: event.currentTarget,
          });
        }}
      >
        <span className="relative truncate font-medium">{clip.name}</span>
        <span className="relative ml-1 rounded bg-black/40 px-1">{clip.origin === "automatic" ? "Automatic" : "Manual"}</span>
        {clip.muted && <SpeakerSlash aria-label="Muted" className="relative ml-1" size={12} />}
        {missing && <span className="relative ml-1 flex items-center gap-0.5 text-amber-300"><Warning size={11} />Missing</span>}
      </button>
      <button type="button" role="slider" aria-label={`Trim ${clip.name} start`}
        aria-valuemin={trimStartMin} aria-valuemax={trimStartMax} aria-valuenow={clip.timelineStart}
        className="absolute inset-y-0 left-0 z-20 w-2 border-l-2 border-emerald-200/70"
        onKeyDown={handleTrimKeyDown("start")}
        onClick={(event) => { event.stopPropagation(); props.onSelect(clip.id); }}
        onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); props.onEdgePointerDown(clip, "start", {
          clientX: event.clientX, pointerId: event.pointerId, captureTarget: event.currentTarget,
        }); }} />
      <button type="button" role="slider" aria-label={`Trim ${clip.name} end`}
        aria-valuemin={trimEndMin} aria-valuemax={trimEndMax} aria-valuenow={end}
        className="absolute inset-y-0 right-0 z-20 w-2 border-r-2 border-emerald-200/70"
        onKeyDown={handleTrimKeyDown("end")}
        onClick={(event) => { event.stopPropagation(); props.onSelect(clip.id); }}
        onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); props.onEdgePointerDown(clip, "end", {
          clientX: event.clientX, pointerId: event.pointerId, captureTarget: event.currentTarget,
        }); }} />
      <button type="button" aria-label={`Delete ${clip.name}`} className="absolute right-2 top-1/2 z-30 -translate-y-1/2 rounded bg-black/70 p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
        onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onDelete(clip.id); }}><Trash size={11} /></button>
    </div>
  );
}
