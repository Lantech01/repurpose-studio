"use client";

import { useEffect, useMemo, useRef } from "react";
import { Trash, Warning, SpeakerSlash } from "@phosphor-icons/react";

import type { SfxClip } from "@/lib/repurpose/types";
import { sfxClipTimelineEnd } from "@/lib/repurpose/sfx-clips";
import { formatTimecode } from "./timeline-utils";
import { sliceClipPeaks, type FaceWaveform } from "./useFaceWaveform";

export interface SfxClipBlockProps {
  clip: SfxClip;
  left: number;
  width: number;
  top: number;
  height: number;
  selected: boolean;
  missing: boolean;
  waveform: FaceWaveform | null;
  onSelect: (id: string) => void;
  onBodyPointerDown: (clip: SfxClip, clientX: number) => void;
  onEdgePointerDown: (clip: SfxClip, edge: "start" | "end", clientX: number) => void;
  onDelete: (id: string) => void;
}

export function SfxClipBlock(props: SfxClipBlockProps) {
  const { clip, left, width, top, height, selected, missing, waveform } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaks = useMemo(() => sliceClipPeaks(
    waveform,
    clip.sourceStart,
    clip.sourceEnd,
    Math.max(4, Math.round(width / 2))
  ), [clip.sourceEnd, clip.sourceStart, waveform, width]);
  const end = sfxClipTimelineEnd(clip);
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
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    canvas.width = w;
    canvas.height = h;
    context.clearRect(0, 0, w, h);
    context.fillStyle = "rgba(6, 78, 59, .8)";
    const barWidth = w / peaks.length;
    peaks.forEach((peak, index) => {
      const barHeight = Math.max(1, peak * (h - 4));
      context.fillRect(index * barWidth, h - barHeight, Math.max(1, barWidth * .7), barHeight);
    });
  }, [height, peaks, width]);

  return (
    <div
      role="group"
      aria-label={label}
      data-sfx-clip-id={clip.id}
      data-testid={`sfx-block-${clip.id}`}
      className={`group absolute overflow-hidden rounded border bg-emerald-500/20 text-[10px] text-emerald-100 ${selected ? "border-emerald-200 ring-2 ring-emerald-300/70" : "border-emerald-500/50"}`}
      style={{ left, width: Math.max(6, width), top, height }}
    >
      {peaks.length > 0 && <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full opacity-60" />}
      <button
        type="button"
        aria-label={`Select ${label}`}
        aria-pressed={selected}
        data-sfx-select-id={clip.id}
        className="absolute inset-0 z-10 flex items-center overflow-hidden px-2 text-left"
        onFocus={() => props.onSelect(clip.id)}
        onClick={(event) => {
          event.stopPropagation();
          props.onSelect(clip.id);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          props.onSelect(clip.id);
          props.onBodyPointerDown(clip, event.clientX);
        }}
      >
        <span className="relative truncate font-medium">{clip.name}</span>
        <span className="relative ml-1 rounded bg-black/40 px-1">{clip.origin === "automatic" ? "Automatic" : "Manual"}</span>
        {clip.muted && <SpeakerSlash aria-label="Muted" className="relative ml-1" size={12} />}
        {missing && <span className="relative ml-1 flex items-center gap-0.5 text-amber-300"><Warning size={11} />Missing</span>}
      </button>
      <button type="button" aria-label={`Trim ${clip.name} start`} className="absolute inset-y-0 left-0 z-20 w-2 border-l-2 border-emerald-200/70"
        onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { event.stopPropagation(); props.onEdgePointerDown(clip, "start", event.clientX); }} />
      <button type="button" aria-label={`Trim ${clip.name} end`} className="absolute inset-y-0 right-0 z-20 w-2 border-r-2 border-emerald-200/70"
        onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { event.stopPropagation(); props.onEdgePointerDown(clip, "end", event.clientX); }} />
      <button type="button" aria-label={`Delete ${clip.name}`} className="absolute right-2 top-1/2 z-30 -translate-y-1/2 rounded bg-black/70 p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
        onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onDelete(clip.id); }}><Trash size={11} /></button>
    </div>
  );
}
