"use client";

import { useEffect, useState } from "react";

import type { FaceWaveform } from "./useFaceWaveform";

const BIN_COUNT = 4000;
const MAX_CACHE_ENTRIES = 8;
const MAX_CONCURRENT_DECODES = 2;

type Listener = (waveform: FaceWaveform | null) => void;

interface WaveformJob {
  key: string;
  url: string;
  controller: AbortController;
  context: AudioContext | null;
  listeners: Set<Listener>;
  status: "queued" | "running";
  slotReleased: boolean;
}

const cache = new Map<string, FaceWaveform | null>();
const jobs = new Map<string, WaveformJob>();
const queue: WaveformJob[] = [];
let activeJobs = 0;

function channelToPeaks(channel: Float32Array): Float32Array {
  const samplesPerBin = Math.max(1, Math.ceil(channel.length / BIN_COUNT));
  const peaks = new Float32Array(BIN_COUNT);
  let globalMax = 0;
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const start = index * samplesPerBin;
    const end = Math.min(channel.length, start + samplesPerBin);
    let peak = 0;
    for (let sample = start; sample < end; sample += 1) {
      peak = Math.max(peak, Math.abs(channel[sample]));
    }
    peaks[index] = peak;
    globalMax = Math.max(globalMax, peak);
  }
  if (globalMax > 0) {
    for (let index = 0; index < peaks.length; index += 1) peaks[index] /= globalMax;
  }
  return peaks;
}

function remember(key: string, waveform: FaceWaveform | null): void {
  cache.delete(key);
  cache.set(key, waveform);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function decode(job: WaveformJob): Promise<FaceWaveform | null> {
  const response = await fetch(job.url, { signal: job.controller.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const encoded = await response.arrayBuffer();
  job.controller.signal.throwIfAborted();
  const Ctor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  const context = new Ctor();
  job.context = context;
  try {
    const buffer = await context.decodeAudioData(encoded);
    job.controller.signal.throwIfAborted();
    return {
      peaks: channelToPeaks(buffer.getChannelData(0)),
      duration: buffer.duration,
    };
  } finally {
    if (job.context === context) {
      job.context = null;
      await context.close().catch(() => undefined);
    }
  }
}

function releaseSlot(job: WaveformJob): void {
  if (job.slotReleased) return;
  job.slotReleased = true;
  activeJobs -= 1;
  pumpQueue();
}

function pumpQueue(): void {
  while (activeJobs < MAX_CONCURRENT_DECODES && queue.length > 0) {
    const job = queue.shift()!;
    if (job.listeners.size === 0 || job.controller.signal.aborted) {
      jobs.delete(job.key);
      continue;
    }
    job.status = "running";
    job.slotReleased = false;
    activeJobs += 1;
    void decode(job)
      .then((waveform) => {
        if (job.controller.signal.aborted || job.listeners.size === 0) return;
        remember(job.key, waveform);
        for (const listener of job.listeners) listener(waveform);
      })
      .catch(() => {
        if (job.controller.signal.aborted || job.listeners.size === 0) return;
        remember(job.key, null);
        for (const listener of job.listeners) listener(null);
      })
      .finally(() => {
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        releaseSlot(job);
      });
  }
}

function subscribe(key: string, url: string, listener: Listener): () => void {
  if (cache.has(key)) {
    const waveform = cache.get(key) ?? null;
    listener(waveform);
    return () => undefined;
  }
  let job = jobs.get(key);
  if (!job) {
    job = {
      key,
      url,
      controller: new AbortController(),
      context: null,
      listeners: new Set(),
      status: "queued",
      slotReleased: true,
    };
    jobs.set(key, job);
    queue.push(job);
  }
  job.listeners.add(listener);
  pumpQueue();
  return () => {
    job!.listeners.delete(listener);
    if (job!.listeners.size > 0) return;
    if (job!.status === "queued") {
      const index = queue.indexOf(job!);
      if (index >= 0) queue.splice(index, 1);
      if (jobs.get(key) === job) jobs.delete(key);
    } else {
      if (jobs.get(key) === job) jobs.delete(key);
      job!.controller.abort();
      const context = job!.context;
      if (context) {
        job!.context = null;
        void context.close().catch(() => undefined);
      }
      releaseSlot(job!);
    }
  };
}

export function useSfxWaveform(
  url: string | null,
  enabled: boolean,
  projectEpoch: number
): FaceWaveform | null {
  const [waveform, setWaveform] = useState<FaceWaveform | null>(null);

  useEffect(() => {
    setWaveform(null);
    if (!enabled || !url) return;
    return subscribe(`${projectEpoch}:${url}`, url, setWaveform);
  }, [enabled, projectEpoch, url]);

  return waveform;
}
