"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, MusicNotes, Pause, Play, Trash, Upload, Warning } from "@phosphor-icons/react";

import { useRepurposeStore, type SfxGestureKind } from "@/lib/repurpose/store";
import { APPROVED_SFX_KEYS, SFX_CATALOG, type ApprovedSfxKey } from "@/lib/repurpose/sfx-effects";
import { maximumSfxSourceEnd, sfxClipsFromEvents } from "@/lib/repurpose/sfx-clips";
import { planSfxEvents } from "@/lib/repurpose/sfx-placement";
import { resolveSfxSource } from "@/lib/repurpose/sfx-source";
import { loadResolvedSfxAudio } from "@/lib/repurpose/sfx-audio";
import { importSfxFile, type SfxImportOwner } from "@/lib/repurpose/sfx-ingest-client";
import type { SfxAsset, SfxClipSource } from "@/lib/repurpose/types";
import { SFX_DRAG_MIME, type SfxDragPayload } from "@/lib/repurpose/sfx-drag";
import { focusSfxTimelineTarget } from "./sfx-focus";

function dragPayload(event: React.DragEvent, payload: SfxDragPayload): void {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(SFX_DRAG_MIME, JSON.stringify(payload));
}

function sourceForAsset(asset: SfxAsset): SfxClipSource {
  return { kind: "imported", assetId: asset.id, srcDuration: asset.srcDuration };
}

function Slider({
  clipId,
  kind,
  label,
  value,
  min,
  max,
  step,
}: {
  clipId: string;
  kind: SfxGestureKind;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
}) {
  const tokenRef = useRef<string | null>(null);
  const begin = () => {
    tokenRef.current = useRepurposeStore.getState().beginSfxGesture(clipId, kind);
  };
  const end = () => {
    if (tokenRef.current) useRepurposeStore.getState().endSfxGesture(tokenRef.current);
    tokenRef.current = null;
  };
  const cancel = () => {
    if (tokenRef.current) useRepurposeStore.getState().cancelSfxGesture(tokenRef.current);
    tokenRef.current = null;
  };
  useEffect(() => {
    const unsubscribe = useRepurposeStore.getState().subscribeSfxGestureCancellation(() => {
      tokenRef.current = null;
    });
    return () => {
      unsubscribe();
      cancel();
    };
  }, []);
  return (
    <label className="block text-[10px] text-muted-foreground">
      <span className="flex justify-between"><span>{label}</span><span className="tabular-nums">{Math.round(value * 100) / 100}</span></span>
      <input type="range" aria-label={`${label} for ${useRepurposeStore.getState().sfxClips.find((clip) => clip.id === clipId)?.name ?? "effect"}`}
        min={min} max={max} step={step} value={value} className="w-full accent-emerald-400"
        onPointerDown={begin} onChange={(event) => {
          if (!tokenRef.current) begin();
          if (tokenRef.current) useRepurposeStore.getState().updateSfxGesture(tokenRef.current, Number(event.target.value));
        }} onPointerUp={end} onPointerCancel={cancel} onBlur={end} />
    </label>
  );
}

export function SfxPanel({ projectId, sfxImportOwner }: { projectId: string; sfxImportOwner: SfxImportOwner }) {
  const clips = useRepurposeStore((state) => state.clips);
  const words = useRepurposeStore((state) => state.words);
  const duration = useRepurposeStore((state) => state.duration);
  const playhead = useRepurposeStore((state) => state.playhead);
  const projectEpoch = useRepurposeStore((state) => state.projectEpoch);
  const revision = useRepurposeStore((state) => state.sfxDocumentRevision);
  const sfxClips = useRepurposeStore((state) => state.sfxClips);
  const assets = useRepurposeStore((state) => state.sfxAssets);
  const selectedId = useRepurposeStore((state) => state.selectedSfxClipId);
  const generating = useRepurposeStore((state) => state.sfxGenerating);
  const selected = sfxClips.find((clip) => clip.id === selectedId) ?? null;
  const selectedImportedAssetId = selected?.source.kind === "imported"
    ? selected.source.assetId
    : null;
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [auditionIdentity, setAuditionIdentity] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const generationRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const tokenRef = useRef(0);

  const retireAudition = useCallback((audio: HTMLAudioElement, stopPlayback: boolean) => {
    audio.onended = null;
    audio.onerror = null;
    if (stopPlayback) {
      audio.pause();
      audio.currentTime = 0;
    }
    if (audioRef.current !== audio) return;
    audioRef.current = null;
    setAuditionIdentity(null);
  }, []);

  const stopAudition = useCallback(() => {
    const audio = audioRef.current;
    if (audio) retireAudition(audio, true);
  }, [retireAudition]);

  useEffect(() => () => stopAudition(), [projectId, stopAudition]);
  useEffect(() => () => {
    const operation = generationRef.current;
    if (!operation) return;
    operation.controller.abort();
    generationRef.current = null;
    useRepurposeStore.getState().setSfxGenerating(false);
  }, [clips, duration, projectEpoch, projectId, revision, words]);
  useEffect(() => () => {
    generationRef.current?.controller.abort();
    generationRef.current = null;
    useRepurposeStore.getState().setSfxGenerating(false);
  }, []);

  const builtIns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return APPROVED_SFX_KEYS.filter((key) => {
      const entry = SFX_CATALOG[key];
      return !needle || `${entry.displayName} ${entry.category}`.toLowerCase().includes(needle);
    });
  }, [query]);
  const imported = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) => !needle || `${asset.name} project imports`.toLowerCase().includes(needle));
  }, [assets, query]);
  const grouped = useMemo(() => {
    const groups = new Map<string, ApprovedSfxKey[]>();
    for (const key of builtIns) {
      const category = SFX_CATALOG[key].category;
      groups.set(category, [...(groups.get(category) ?? []), key]);
    }
    return groups;
  }, [builtIns]);

  const audition = (identity: string, url: string | null, unavailable: boolean) => {
    if (auditionIdentity === identity) {
      stopAudition();
      return;
    }
    stopAudition();
    if (unavailable || !url) {
      setError("That imported sound effect is unavailable. Re-import it to audition.");
      return;
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    setAuditionIdentity(identity);
    audio.onended = () => retireAudition(audio, false);
    audio.onerror = () => {
      if (audioRef.current !== audio) return;
      retireAudition(audio, true);
      setError("Could not audition that sound effect.");
    };
    void audio.play().catch(() => {
      if (audioRef.current === audio) {
        retireAudition(audio, true);
        setError("Could not audition that sound effect.");
      }
    });
  };

  const add = (name: string, source: SfxClipSource) => {
    const id = useRepurposeStore.getState().addSfxClip({ name, source, atTime: playhead });
    if (id) useRepurposeStore.getState().selectSfxClip(id);
  };

  const replace = (id: string, name: string, source: SfxClipSource) => {
    const state = useRepurposeStore.getState();
    state.replaceSfxClipSource(id, { name, source });
    state.selectSfxClip(id);
    focusSfxTimelineTarget(id);
  };

  const duplicate = (id: string) => {
    const state = useRepurposeStore.getState();
    const duplicateId = state.duplicateSfxClip(id);
    if (!duplicateId) return;
    state.selectSfxClip(duplicateId);
    focusSfxTimelineTarget(duplicateId);
  };

  const remove = (id: string) => {
    const state = useRepurposeStore.getState();
    const index = state.sfxClips.findIndex((clip) => clip.id === id);
    if (index < 0) return;
    const nearest = state.sfxClips[index + 1] ?? state.sfxClips[index - 1] ?? null;
    state.removeSfxClip(id);
    state.selectSfxClip(nearest?.id ?? null);
    focusSfxTimelineTarget(nearest?.id ?? null);
  };

  const generate = async () => {
    const state = useRepurposeStore.getState();
    if (state.duration <= 0 || state.sfxGenerating) return;
    const controller = new AbortController();
    const token = ++tokenRef.current;
    generationRef.current?.controller.abort();
    generationRef.current = { token, controller };
    const operation = {
      projectId,
      projectEpoch: state.projectEpoch,
      clips: state.clips,
      words: state.words,
      duration: state.duration,
      revision: state.sfxDocumentRevision,
    };
    const owns = () => {
      const current = useRepurposeStore.getState();
      return generationRef.current?.token === token && !controller.signal.aborted
        && projectId === operation.projectId && current.projectEpoch === operation.projectEpoch
        && current.clips === operation.clips && current.words === operation.words
        && current.duration === operation.duration && current.sfxDocumentRevision === operation.revision;
    };
    setError(null);
    state.setSfxGenerating(true);
    try {
      const events = planSfxEvents(operation.words, operation.clips, operation.duration);
      if (events.length === 0) throw new Error("No automatic sound-effect beats were found in this reel.");
      const automatic = sfxClipsFromEvents(events, operation.duration);
      const context = new AudioContext();
      try {
        const keys = [...new Set(automatic.flatMap((clip) => clip.source.kind === "built-in" ? [clip.source.key] : []))];
        for (const key of keys) {
          if (!owns()) return;
          await loadResolvedSfxAudio(resolveSfxSource({ kind: "built-in", key }, []), context, controller.signal);
          if (!owns()) return;
        }
      } finally {
        await context.close().catch(() => undefined);
      }
      if (!owns()) return;
      generationRef.current = null;
      state.setSfxGenerating(false);
      useRepurposeStore.getState().replaceAutomaticSfxClips(automatic);
    } catch (cause) {
      if (!controller.signal.aborted && owns()) {
        setError(cause instanceof Error ? cause.message : "Automatic SFX generation failed.");
      }
    } finally {
      if (generationRef.current?.token === token) {
        generationRef.current = null;
        useRepurposeStore.getState().setSfxGenerating(false);
      }
    }
  };

  const renderBuiltIn = (key: ApprovedSfxKey) => {
    const entry = SFX_CATALOG[key];
    const resolved = resolveSfxSource({ kind: "built-in", key }, assets);
    return (
      <div key={key} draggable onDragStart={(event) => dragPayload(event, { builtInKey: key })} className="flex items-center gap-1 rounded border border-border px-1.5 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px]">{entry.displayName}</span>
        <button type="button" aria-label={`${auditionIdentity === resolved.identity ? "Stop" : "Audition"} ${entry.displayName}`} title={`${auditionIdentity === resolved.identity ? "Stop" : "Audition"} ${entry.displayName}`} onClick={() => audition(resolved.identity, resolved.url, false)}>{auditionIdentity === resolved.identity ? <Pause size={12} /> : <Play size={12} />}</button>
        <button type="button" aria-label={`Add ${entry.displayName} at playhead`} onClick={() => add(entry.displayName, { kind: "built-in", key })} className="text-[10px]">Add</button>
        {selected && <button type="button" aria-label={`Replace ${selected.name} with ${entry.displayName}`} onClick={() => replace(selected.id, entry.displayName, { kind: "built-in", key })} className="text-[10px]">Replace</button>}
      </div>
    );
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1.5"><MusicNotes size={14} className="text-emerald-400" /><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sound Effects</h3></div>
      <div className="flex gap-1.5">
        <button type="button" onClick={() => void generate()} disabled={generating} aria-label="Generate automatic effects" className="flex flex-1 items-center justify-center gap-1 rounded border border-emerald-500/50 bg-emerald-500/15 px-2 py-1.5 text-[11px] text-emerald-100"><ArrowClockwise size={12} className={generating ? "animate-spin" : ""} />{sfxClips.some((clip) => clip.origin === "automatic") ? "Regenerate" : "Generate"}</button>
        <label className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-[11px]"><Upload size={12} />Import<input type="file" accept=".wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4" className="sr-only" aria-label="Import sound effect" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setError(null);
          void importSfxFile(file, playhead, sfxImportOwner).catch((cause) => {
            if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Sound-effect import failed.");
          });
        }} /></label>
      </div>
      <input type="search" aria-label="Search sound effects" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search library" className="w-full rounded border border-border bg-secondary px-2 py-1.5 text-[11px]" />
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {[...grouped].map(([category, keys]) => <div key={category}><h4 className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{category}</h4><div className="space-y-1">{keys.map(renderBuiltIn)}</div></div>)}
        {imported.length > 0 && <div><h4 className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Project imports</h4><div className="space-y-1">{imported.map((asset) => {
          const unavailable = !asset.sourcePath || asset.srcDuration <= 0;
          const resolved = resolveSfxSource(sourceForAsset(asset), assets);
          const active = auditionIdentity === resolved.identity;
          const auditionLabel = `${active ? "Stop" : "Audition"} ${asset.name}`;
          return <div key={asset.id} draggable={!unavailable} onDragStart={(event) => dragPayload(event, { assetId: asset.id })} className="flex items-center gap-1 rounded border border-border px-1.5 py-1"><span className="min-w-0 flex-1 truncate text-[11px]">{asset.name}</span>{unavailable && <span className="text-[9px] text-amber-300">Unavailable</span>}<button type="button" disabled={unavailable} aria-label={auditionLabel} title={auditionLabel} onClick={() => audition(resolved.identity, resolved.url, unavailable)}>{active ? <Pause size={12} /> : <Play size={12} />}</button><button type="button" disabled={unavailable} aria-label={`Add ${asset.name} at playhead`} onClick={() => add(asset.name, sourceForAsset(asset))} className="text-[10px]">Add</button>{selected && <button type="button" disabled={unavailable} aria-label={`Replace ${selected.name} with ${asset.name}`} onClick={() => replace(selected.id, asset.name, sourceForAsset(asset))} className="text-[10px]">Replace</button>}</div>;
        })}</div></div>}
      </div>
      {selected && <div className="space-y-2 rounded border border-emerald-500/30 bg-emerald-500/5 p-2"><div className="flex items-center justify-between"><strong className="truncate text-[11px]">{selected.name}</strong>{selectedImportedAssetId !== null && !assets.some((asset) => asset.id === selectedImportedAssetId && asset.sourcePath) && <span className="text-[9px] text-amber-300">Unavailable</span>}</div>
        <Slider clipId={selected.id} kind="gain" label="Gain" value={selected.gain} min={0} max={2} step={0.01} />
        <Slider clipId={selected.id} kind="source-in" label="Source in" value={selected.sourceStart} min={0} max={Math.max(0, selected.sourceEnd - .001)} step={.01} />
        <Slider clipId={selected.id} kind="source-out" label="Source out" value={selected.sourceEnd} min={Math.min(selected.sourceStart + .001, maximumSfxSourceEnd(selected, duration))} max={maximumSfxSourceEnd(selected, duration)} step={.01} />
        <Slider clipId={selected.id} kind="fade-in" label="Fade in" value={selected.fadeInSec} min={0} max={2} step={.01} />
        <Slider clipId={selected.id} kind="fade-out" label="Fade out" value={selected.fadeOutSec} min={0} max={2} step={.01} />
        <div className="flex flex-wrap gap-1"><button type="button" aria-label={`${selected.muted ? "Unmute" : "Mute"} ${selected.name}`} onClick={() => useRepurposeStore.getState().setSfxClipMuted(selected.id, !selected.muted)} className="rounded border border-border px-1.5 py-1 text-[10px]">{selected.muted ? "Unmute" : "Mute"}</button><button type="button" aria-label={`Duplicate ${selected.name}`} onClick={() => duplicate(selected.id)} className="rounded border border-border px-1.5 py-1 text-[10px]">Duplicate</button><button type="button" aria-label={`Delete ${selected.name}`} onClick={() => remove(selected.id)} className="rounded border border-red-500/30 px-1.5 py-1 text-[10px] text-red-300"><Trash size={11} /></button></div>
      </div>}
      {error && <p role="alert" className="flex gap-1 text-[10px] text-red-300"><Warning size={12} />{error}</p>}
    </section>
  );
}
