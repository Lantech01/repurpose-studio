import { isAbsoluteLocalMediaPath } from "./local-media-path";
import { effectiveSfxFadeDurations } from "./sfx-clips";
import { loadResolvedSfxAudio, secondsToSample } from "./sfx-audio";
import { resolveSfxSource } from "./sfx-source";
import type { SfxAsset, SfxClip } from "./types";

export interface SfxPcmSource {
  clip: SfxClip;
  channels: readonly Float32Array[];
  sampleRate: number;
  sourceBaseGain: number;
}

export interface PreparedSfxSource {
  buffer: AudioBuffer;
  sourceBaseGain: number;
}

export type SfxExportPreflightErrorCode =
  | "missing-source"
  | "decode-failed"
  | "invalid-source-bounds";

export class SfxExportPreflightError extends Error {
  constructor(
    public readonly code: SfxExportPreflightErrorCode,
    public readonly clipId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SfxExportPreflightError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function offlineAudioContext(): OfflineAudioContext {
  const OfflineCtx =
    (typeof OfflineAudioContext !== "undefined" && OfflineAudioContext)
    || (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineCtx) throw new Error("Sound effects cannot be decoded in this browser.");
  return new OfflineCtx(1, 1, 48_000);
}

function assertAuthoritativeSource(clip: SfxClip, assets: readonly SfxAsset[]): void {
  if (clip.source.kind === "built-in") return;
  let sourcePath: string | undefined;
  if (clip.source.kind === "legacy") {
    sourcePath = clip.source.sourcePath;
  } else {
    const assetId = clip.source.assetId;
    sourcePath = assets.find((asset) => asset.id === assetId)?.sourcePath;
  }
  if (!isAbsoluteLocalMediaPath(sourcePath)) {
    throw new SfxExportPreflightError(
      "missing-source",
      clip.id,
      `Sound effect “${clip.name}” is missing or unavailable.`
    );
  }
}

function assertDecodedBounds(clip: SfxClip, buffer: AudioBuffer): void {
  // One decoded sample absorbs harmless metadata rounding without permitting a
  // clip to read a materially stale or truncated source.
  const tolerance = 1 / buffer.sampleRate;
  if (
    !Number.isFinite(clip.sourceStart)
    || !Number.isFinite(clip.sourceEnd)
    || clip.sourceStart < 0
    || clip.sourceEnd <= clip.sourceStart
    || clip.sourceStart > buffer.duration + tolerance
    || clip.sourceEnd > buffer.duration + tolerance
  ) {
    throw new SfxExportPreflightError(
      "invalid-source-bounds",
      clip.id,
      `Sound effect “${clip.name}” uses source range ${clip.sourceStart.toFixed(3)}-${clip.sourceEnd.toFixed(3)}s, but the decoded source is ${buffer.duration.toFixed(3)}s.`
    );
  }
}

export async function prepareSfxForExport(
  clips: readonly SfxClip[],
  assets: readonly SfxAsset[],
  abortSignal?: AbortSignal
): Promise<Map<string, PreparedSfxSource>> {
  const prepared = new Map<string, PreparedSfxSource>();
  const audibleClips = clips.filter((clip) => !clip.muted);
  if (audibleClips.length === 0) return prepared;
  const context = offlineAudioContext();
  const signal = abortSignal ?? new AbortController().signal;
  for (const clip of audibleClips) {
    signal.throwIfAborted();
    assertAuthoritativeSource(clip, assets);
    const resolved = resolveSfxSource(clip.source, assets);
    if (resolved.missing || !resolved.url) {
      throw new SfxExportPreflightError(
        "missing-source",
        clip.id,
        `Sound effect “${clip.name}” is missing or unavailable.`
      );
    }
    let source = prepared.get(resolved.identity);
    if (!source) {
      try {
        source = await loadResolvedSfxAudio(resolved, context, signal);
        prepared.set(resolved.identity, source);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        throw new SfxExportPreflightError(
          "decode-failed",
          clip.id,
          `Sound effect “${clip.name}” could not be decoded: ${error instanceof Error ? error.message : "unknown error"}`,
          { cause: error }
        );
      }
    }
    assertDecodedBounds(clip, source.buffer);
  }
  return prepared;
}

export function sumPcmChannels(
  outputChannels: readonly Float32Array[],
  sourceChannels: readonly Float32Array[],
  writeStart: number
): void {
  if (sourceChannels.length === 0 || !Number.isSafeInteger(writeStart) || writeStart < 0) return;
  for (let channel = 0; channel < outputChannels.length; channel += 1) {
    const output = outputChannels[channel];
    const source = sourceChannels[Math.min(channel, sourceChannels.length - 1)];
    const frames = Math.min(source.length, output.length - writeStart);
    for (let frame = 0; frame < frames; frame += 1) {
      output[writeStart + frame] += source[frame];
    }
  }
}

export function clampPcmChannels(channels: readonly Float32Array[]): void {
  for (const channel of channels) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      channel[frame] = Math.max(-1, Math.min(1, channel[frame]));
    }
  }
}

export function mixSfxClipsPcm(
  outputChannels: readonly Float32Array[],
  outputSampleRate: number,
  sources: readonly SfxPcmSource[]
): void {
  for (const { clip, channels, sampleRate, sourceBaseGain } of sources) {
    if (clip.muted || channels.length === 0 || sampleRate <= 0 || outputSampleRate <= 0) continue;
    const outputStart = secondsToSample(clip.timelineStart, outputSampleRate);
    const sourceStart = secondsToSample(clip.sourceStart, sampleRate);
    const sourceEnd = secondsToSample(clip.sourceEnd, sampleRate);
    const sourceFrames = Math.max(0, sourceEnd - sourceStart);
    const outputFrames = secondsToSample(clip.sourceEnd - clip.sourceStart, outputSampleRate);
    const frames = Math.min(outputFrames, outputChannels[0]?.length - outputStart);
    if (frames <= 0 || sourceFrames <= 0) continue;
    const fades = effectiveSfxFadeDurations(clip, clip.sourceEnd - clip.sourceStart);
    const fadeInFrames = secondsToSample(fades.fadeInSec, outputSampleRate);
    const fadeOutFrames = secondsToSample(fades.fadeOutSec, outputSampleRate);
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const source = channels[Math.min(channel, channels.length - 1)];
      const output = outputChannels[channel];
      for (let frame = 0; frame < frames; frame += 1) {
        const sourcePosition = sourceStart + frame * sampleRate / outputSampleRate;
        const low = Math.min(source.length - 1, Math.floor(sourcePosition));
        const high = Math.min(source.length - 1, low + 1);
        const fraction = sourcePosition - low;
        const sample = source[low] + (source[high] - source[low]) * fraction;
        const fadeIn = fadeInFrames > 0 ? Math.min(1, frame / fadeInFrames) : 1;
        const remaining = frames - frame;
        const fadeOut = fadeOutFrames > 0 ? Math.min(1, remaining / fadeOutFrames) : 1;
        output[outputStart + frame] +=
          sample * sourceBaseGain * clip.gain * Math.min(fadeIn, fadeOut);
      }
    }
  }
}

export function mixPreparedSfxIntoBuffer(
  base: AudioBuffer | null,
  clips: readonly SfxClip[],
  assets: readonly SfxAsset[],
  prepared: ReadonlyMap<string, PreparedSfxSource>,
  duration: number,
  abortSignal?: AbortSignal
): AudioBuffer {
  abortSignal?.throwIfAborted();
  const audibleClips = clips.filter((clip) => !clip.muted);
  if (audibleClips.length === 0 && base) return base;
  const context = offlineAudioContext();
  const sampleRate = base?.sampleRate ?? 48_000;
  const channelCount = base?.numberOfChannels ?? 2;
  const frameCount = base?.length ?? Math.max(1, secondsToSample(duration, sampleRate));
  const output = context.createBuffer(channelCount, frameCount, sampleRate);
  const channels = Array.from({ length: channelCount }, (_, channel) => output.getChannelData(channel));
  if (base) channels.forEach((channel, index) => channel.set(base.getChannelData(index)));
  const sources = audibleClips.map((clip) => {
    const resolved = resolveSfxSource(clip.source, assets);
    const source = prepared.get(resolved.identity);
    if (!source) throw new Error(`Sound effect “${clip.name}” was not prepared for export.`);
    return {
      clip,
      channels: Array.from(
        { length: source.buffer.numberOfChannels },
        (_, channel) => source.buffer.getChannelData(channel)
      ),
      sampleRate: source.buffer.sampleRate,
      sourceBaseGain: source.sourceBaseGain,
    };
  });
  mixSfxClipsPcm(channels, sampleRate, sources);
  abortSignal?.throwIfAborted();
  return output;
}
