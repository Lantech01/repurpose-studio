"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useSfxPreview
// ===========================================================================
// Schedules every editable SFX clip against the output-timeline playhead. The
// face-cam <video> remains the master clock and carries narration independently.
// ===========================================================================

import { useEffect, useRef } from "react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { MusicTrack, SfxAsset, SfxClip } from "@/lib/repurpose/types";
import { resolveSfxSource } from "@/lib/repurpose/sfx-source";
import { loadResolvedSfxAudio } from "@/lib/repurpose/sfx-audio";
import { effectiveSfxFadeDurations, sfxClipTimelineEnd } from "@/lib/repurpose/sfx-clips";

/** A playhead delta larger than this (seconds) while playing counts as a seek. */
const SEEK_JUMP_SEC = 0.3;

type AudioCtxCtor = typeof AudioContext;

/**
 * Plays editable SFX clips through WebAudio in sync with preview playback.
 */
export function useSfxPreview(
  clips: readonly SfxClip[],
  assets: readonly SfxAsset[],
  onWarning: (message: string | null) => void = () => {}
): void {
  const contextRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<Array<{ source: AudioBufferSourceNode; gain: GainNode; token: number }>>([]);
  const cacheRef = useRef(new Map<string, {
    controller: AbortController;
    status: "pending" | "ready" | "failed";
    promise: Promise<{ buffer: AudioBuffer; sourceBaseGain: number }>;
  }>());
  const operationRef = useRef<{
    token: number;
    documentToken: number;
    projectEpoch: number;
    revision: number;
    playhead: number;
    contextTime: number;
    playbackRate: number;
  } | null>(null);
  const tokenRef = useRef(0);
  const documentTokenRef = useRef(0);
  const clipsRef = useRef(clips);
  const assetsRef = useRef(assets);
  const warningRef = useRef(onWarning);
  clipsRef.current = clips;
  assetsRef.current = assets;
  warningRef.current = onWarning;

  const getContext = (): AudioContext | null => {
    if (contextRef.current) return contextRef.current;
    if (typeof window === "undefined") return null;
    const Ctor: AudioCtxCtor | undefined = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioCtxCtor }).webkitAudioContext;
    if (!Ctor) return null;
    contextRef.current = new Ctor();
    return contextRef.current;
  };

  const disposeNode = (
    node: { source: AudioBufferSourceNode; gain: GainNode; token: number },
    stop: boolean
  ) => {
    node.source.onended = null;
    if (stop) {
      try { node.source.stop(); } catch { /* already stopped */ }
    }
    node.source.disconnect();
    node.gain.disconnect();
    nodesRef.current = nodesRef.current.filter((candidate) => candidate !== node);
  };

  const stopNodes = () => {
    for (const node of [...nodesRef.current]) disposeNode(node, true);
  };

  const invalidateSchedule = () => {
    tokenRef.current += 1;
    operationRef.current = null;
    stopNodes();
  };

  const retireLoadsExcept = (identities: ReadonlySet<string> | null) => {
    for (const [identity, entry] of cacheRef.current) {
      if (identities?.has(identity)) continue;
      cacheRef.current.delete(identity);
      if (entry.status === "pending") entry.controller.abort();
    }
  };

  const loadSource = (
    resolved: ReturnType<typeof resolveSfxSource>,
    context: AudioContext
  ) => {
    const existing = cacheRef.current.get(resolved.identity);
    if (existing && existing.status !== "failed") return existing.promise;
    if (existing) cacheRef.current.delete(resolved.identity);
    const controller = new AbortController();
    const entry: {
      controller: AbortController;
      status: "pending" | "ready" | "failed";
      promise: Promise<{ buffer: AudioBuffer; sourceBaseGain: number }>;
    } = {
      controller,
      status: "pending",
      promise: Promise.resolve(null as never),
    };
    entry.promise = loadResolvedSfxAudio(resolved, context, controller.signal).then(
      (loaded) => {
        entry.status = "ready";
        return loaded;
      },
      (error) => {
        entry.status = "failed";
        if (cacheRef.current.get(resolved.identity) === entry) {
          cacheRef.current.delete(resolved.identity);
        }
        throw error;
      }
    );
    cacheRef.current.set(resolved.identity, entry);
    return entry.promise;
  };

  const schedule = () => {
    invalidateSchedule();
    const state = useRepurposeStore.getState();
    if (!state.isPlaying) return;
    const context = getContext();
    if (!context) {
      warningRef.current("Sound-effect preview is unavailable in this browser.");
      return;
    }
    const operation = {
      token: ++tokenRef.current,
      documentToken: documentTokenRef.current,
      projectEpoch: state.projectEpoch,
      revision: state.sfxDocumentRevision,
      playhead: state.playhead,
      contextTime: context.currentTime,
      playbackRate: state.playbackRate > 0 ? state.playbackRate : 1,
    };
    operationRef.current = operation;
    warningRef.current(null);
    void context.resume();

    for (const clip of clipsRef.current) {
      const resolved = resolveSfxSource(clip.source, assetsRef.current);
      if (resolved.missing || !resolved.url) {
        warningRef.current(`Sound effect “${clip.name}” is unavailable and was skipped.`);
        continue;
      }
      const loaded = loadSource(resolved, context);
      void loaded.then(({ buffer, sourceBaseGain }) => {
        const liveState = useRepurposeStore.getState();
        if (
          operationRef.current !== operation
          || operation.documentToken !== documentTokenRef.current
          || liveState.projectEpoch !== operation.projectEpoch
          || liveState.sfxDocumentRevision !== operation.revision
          || !liveState.isPlaying
        ) return;
        const liveClip = clipsRef.current.find((candidate) => candidate.id === clip.id);
        if (!liveClip) return;
        const liveResolved = resolveSfxSource(liveClip.source, assetsRef.current);
        if (liveResolved.identity !== resolved.identity || liveResolved.missing) return;
        const head = liveState.playhead;
        const rate = liveState.playbackRate > 0 ? liveState.playbackRate : 1;
        const clipEnd = sfxClipTimelineEnd(liveClip);
        if (liveClip.muted || clipEnd <= head) return;
        const now = context.currentTime;
        const active = head >= liveClip.timelineStart;
        const when = active ? now : now + (liveClip.timelineStart - head) / rate;
        const offset = liveClip.sourceStart + (active ? head - liveClip.timelineStart : 0);
        const duration = Math.max(0, Math.min(liveClip.sourceEnd, buffer.duration) - offset);
        if (duration <= 0 || offset >= buffer.duration) return;
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(gain);
        gain.connect(context.destination);
        const baseGain = sourceBaseGain * liveClip.gain;
        const fades = effectiveSfxFadeDurations(liveClip);
        const local = Math.max(0, head - liveClip.timelineStart);
        const initialFadeIn = fades.fadeInSec > 0 ? Math.min(1, local / fades.fadeInSec) : 1;
        const remaining = clipEnd - head;
        const initialFadeOut = fades.fadeOutSec > 0 ? Math.min(1, remaining / fades.fadeOutSec) : 1;
        gain.gain.setValueAtTime(baseGain * Math.min(initialFadeIn, initialFadeOut), when);
        const fadeInEnd = liveClip.timelineStart + fades.fadeInSec;
        if (fades.fadeInSec > 0 && fadeInEnd > head) {
          gain.gain.linearRampToValueAtTime(baseGain, now + (fadeInEnd - head) / rate);
        }
        const fadeOutStart = clipEnd - fades.fadeOutSec;
        if (fades.fadeOutSec > 0) {
          if (fadeOutStart > head) {
            gain.gain.setValueAtTime(baseGain, now + (fadeOutStart - head) / rate);
          }
          gain.gain.linearRampToValueAtTime(0, now + (clipEnd - head) / rate);
        }
        const node = { source, gain, token: operation.token };
        source.onended = () => disposeNode(node, false);
        nodesRef.current.push(node);
        source.start(when, offset, duration);
      }).catch((error) => {
        if (operationRef.current !== operation) return;
        warningRef.current(`Sound effect “${clip.name}” could not be decoded: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    }
  };

  useEffect(() => {
    documentTokenRef.current += 1;
    const identities = new Set(clips.map((clip) => resolveSfxSource(clip.source, assets).identity));
    retireLoadsExcept(identities);
    const state = useRepurposeStore.getState();
    if (state.isPlaying) schedule();
    // Document identity changes invalidate every scheduled node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, assets]);

  useEffect(() => {
    let previous = useRepurposeStore.getState();
    const unsubscribe = useRepurposeStore.subscribe((state) => {
      const playChanged = state.isPlaying !== previous.isPlaying;
      const operation = operationRef.current;
      const context = contextRef.current;
      const expectedPlayhead = operation && context
        ? operation.playhead
          + Math.max(0, context.currentTime - operation.contextTime) * operation.playbackRate
        : state.playhead;
      const seeked = state.isPlaying
        && operation !== null
        && Math.abs(state.playhead - expectedPlayhead) > SEEK_JUMP_SEC;
      const pausedSeeked = !state.isPlaying
        && Math.abs(state.playhead - previous.playhead) > 0.001;
      const rateChanged = state.playbackRate !== previous.playbackRate;
      const revisionChanged = state.sfxDocumentRevision !== previous.sfxDocumentRevision;
      const projectChanged = state.projectEpoch !== previous.projectEpoch;
      if (projectChanged) {
        invalidateSchedule();
        retireLoadsExcept(null);
      } else if (revisionChanged) {
        invalidateSchedule();
      } else if (playChanged || seeked || rateChanged) {
        schedule();
      } else if (pausedSeeked) {
        invalidateSchedule();
      }
      previous = state;
    });
    return () => {
      unsubscribe();
      invalidateSchedule();
      retireLoadsExcept(null);
      const context = contextRef.current;
      contextRef.current = null;
      if (context) void context.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ===========================================================================
// useMusicPreview
// ===========================================================================
// The music twin of {@link useSfxPreview}. Plays the store's manual BACKGROUND-
// MUSIC bed through WebAudio so it's audible live, summing acoustically with the
// face-cam <video> AND the SFX bed at the speakers -- we never touch the <video>.
//
// The one difference from useSfxPreview is the START OFFSET: the music begins at
// OUTPUT time `startAtSec` (SFX begins at 0). So the music's internal read
// offset for a given output playhead P is `P - startAtSec`:
//   - P >= startAtSec: music is already sounding -> start(0, P - startAtSec).
//   - P <  startAtSec: the reel hasn't reached the music yet -> schedule the
//     source to begin after a real-time delay of (startAtSec - P) seconds via
//     start(ctx.currentTime + delay, 0), so it comes in on cue as playback runs.
//   - P - startAtSec >= srcDuration: the music has fully played out by P -> play
//     nothing.
// Everything else (restart-on-play, seek-jump restart, live gain, decode-race
// token) mirrors useSfxPreview exactly.
// ===========================================================================

/**
 * Plays the store's `musicTrack` through WebAudio in sync with preview playback
 * so the background-music bed is audible live, honoring its `startAtSec` output
 * offset. Pass the current `musicTrack` (from
 * `useRepurposeStore((s) => s.musicTrack)`); passing `null` stops any playback.
 */
export function useMusicPreview(musicTrack: MusicTrack | null): void {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  // The active graph while the bed is sounding (null when silent).
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  // Monotonic token so a stale async decode (src changed again mid-fetch) is
  // dropped instead of clobbering the current buffer.
  const decodeTokenRef = useRef(0);
  // Last playhead we (re)started the source at -- used to detect seek jumps.
  const lastPlayheadRef = useRef(0);

  const src = musicTrack?.src ?? null;
  const gain = musicTrack?.gain ?? 1;

  // --- Lazy AudioContext accessor (guarded for SSR / unsupported browsers) ----
  const getCtx = (): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current;
    if (typeof window === "undefined") return null;
    const Ctor: AudioCtxCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtxCtor })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioCtxRef.current = new Ctor();
    return audioCtxRef.current;
  };

  // --- Stop + tear down the active source (safe to call when already silent) --
  const stopSource = () => {
    const source = sourceRef.current;
    const gainNode = gainNodeRef.current;
    if (source) {
      try {
        source.stop();
      } catch {
        // stop() throws if the node never started / already stopped -- ignore.
      }
      source.disconnect();
    }
    if (gainNode) gainNode.disconnect();
    sourceRef.current = null;
    gainNodeRef.current = null;
  };

  // --- (Re)start the bed for the current output playhead ----------------------
  // `head` is the OUTPUT-timeline playhead; the music starts at output time
  // `startAtSec`, so its internal read offset is `head - startAtSec`.
  const startAt = (head: number) => {
    const ctx = getCtx();
    const buffer = bufferRef.current;
    const track = useRepurposeStore.getState().musicTrack;
    if (!ctx || !buffer || !track) return;
    stopSource(); // never stack two sources
    void ctx.resume();

    const rate = useRepurposeStore.getState().playbackRate;
    const playbackRate = rate > 0 ? rate : 1;
    const startAtSec = track.startAtSec;
    // Where the playhead sits RELATIVE to the music's output start. Negative =
    // the reel hasn't reached the music yet.
    const relative = head - startAtSec;

    // The music has already fully played out by this playhead -- nothing to do.
    if (relative >= buffer.duration) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    const gainNode = ctx.createGain();
    gainNode.gain.value = track.gain ?? 1;
    source.connect(gainNode).connect(ctx.destination);

    if (relative >= 0) {
      // Music is already sounding at this playhead -> start immediately, offset in.
      source.start(0, relative);
    } else {
      // Playhead is BEFORE the music start -> schedule it to come in on cue after
      // a real-time delay. The delay shrinks with playbackRate so a sped-up
      // preview reaches the music proportionally sooner.
      const delay = -relative / playbackRate;
      source.start(ctx.currentTime + delay, 0);
    }
    sourceRef.current = source;
    gainNodeRef.current = gainNode;
    lastPlayheadRef.current = head;
  };

  // --- Decode the music file whenever the source URL changes ------------------
  useEffect(() => {
    const token = ++decodeTokenRef.current;
    // Any src change invalidates the currently-sounding bed.
    stopSource();
    if (!src) {
      bufferRef.current = null;
      return;
    }
    const ctx = getCtx();
    if (!ctx) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        const bytes = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(bytes);
        // Drop if a newer src won the race (or this effect was cleaned up).
        if (cancelled || token !== decodeTokenRef.current) return;
        bufferRef.current = decoded;
        // If we're already playing when the decode lands, begin at the live head.
        const state = useRepurposeStore.getState();
        if (state.isPlaying) startAt(state.playhead);
      } catch {
        if (cancelled || token !== decodeTokenRef.current) return;
        bufferRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // getCtx / startAt / stopSource are stable refs-only closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // --- Drive start / stop / seek off the store (subscribe, no re-render) ------
  useEffect(() => {
    // Seed the play/head baseline from the current state.
    let prevPlaying = useRepurposeStore.getState().isPlaying;
    lastPlayheadRef.current = useRepurposeStore.getState().playhead;

    const unsub = useRepurposeStore.subscribe((state) => {
      const playing = state.isPlaying;
      const head = state.playhead;

      if (playing && !prevPlaying) {
        // PLAY transition -> (re)start for the current output head.
        startAt(head);
      } else if (!playing && prevPlaying) {
        // PAUSE / stop -> silence; next play recreates at the new offset.
        stopSource();
      } else if (playing) {
        // Still playing: a big playhead jump = a seek -> restart at new offset.
        if (Math.abs(head - lastPlayheadRef.current) > SEEK_JUMP_SEC) {
          startAt(head);
        } else {
          lastPlayheadRef.current = head;
        }
      }

      prevPlaying = playing;
    });

    // If we mounted mid-playback, get the bed sounding right away.
    if (prevPlaying) startAt(lastPlayheadRef.current);

    return () => {
      unsub();
      stopSource();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Live gain: update the GainNode without restarting ---------------------
  useEffect(() => {
    const gainNode = gainNodeRef.current;
    const ctx = audioCtxRef.current;
    if (!gainNode) return;
    if (ctx) {
      // setTargetAtTime avoids a click on abrupt gain changes.
      gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
    } else {
      gainNode.gain.value = gain;
    }
  }, [gain]);
}
