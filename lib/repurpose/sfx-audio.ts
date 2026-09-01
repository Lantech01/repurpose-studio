import type { ResolvedSfxSource } from "./sfx-source";

export function secondsToSample(seconds: number, sampleRate: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return 0;
  }
  const sample = Math.round(seconds * sampleRate);
  return Number.isSafeInteger(sample) && sample >= 0 ? sample : 0;
}

export function analyzeBuiltInPeak(buffer: AudioBuffer, sourceDuration: number): number {
  if (
    !Number.isFinite(sourceDuration)
    || sourceDuration <= 0
    || !Number.isFinite(buffer.duration)
    || buffer.duration <= 0
    || !Number.isFinite(buffer.sampleRate)
    || buffer.sampleRate <= 0
    || !Number.isSafeInteger(buffer.length)
    || buffer.length <= 0
    || !Number.isSafeInteger(buffer.numberOfChannels)
    || buffer.numberOfChannels <= 0
  ) {
    throw new Error("Built-in audio has no usable PCM data");
  }

  const usableDuration = Math.min(sourceDuration, 1);
  const sampleCount = Math.min(buffer.length, secondsToSample(usableDuration, buffer.sampleRate));
  if (sampleCount <= 0) throw new Error("Built-in audio has no usable PCM data");

  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const pcm = buffer.getChannelData(channel);
    if (pcm.length < sampleCount) throw new Error("Built-in audio has unusable PCM data");
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const value = pcm[sample];
      if (!Number.isFinite(value)) throw new Error("Built-in audio contains non-finite PCM data");
      peak = Math.max(peak, Math.abs(value));
    }
  }
  if (peak <= 0) throw new Error("Built-in audio is silent");
  return peak;
}

export function builtInSourceBaseGain(targetAmplitude: number, peak: number): number {
  if (!Number.isFinite(targetAmplitude) || targetAmplitude <= 0) {
    throw new Error("Built-in target amplitude must be finite and positive");
  }
  if (!Number.isFinite(peak) || peak <= 0) {
    throw new Error("Built-in audio peak must be finite and positive");
  }
  const gain = targetAmplitude / peak;
  if (!Number.isFinite(gain) || gain <= 0) throw new Error("Built-in source gain is unusable");
  return gain;
}

export function sourceBaseGain(
  kind: ResolvedSfxSource["kind"],
  targetAmplitude: number,
  peak: number
): number {
  return kind === "built-in" ? builtInSourceBaseGain(targetAmplitude, peak) : 1;
}

function verifyDecodedBuffer(buffer: AudioBuffer): void {
  if (
    !Number.isFinite(buffer.duration)
    || buffer.duration <= 0
    || !Number.isFinite(buffer.sampleRate)
    || buffer.sampleRate <= 0
    || !Number.isSafeInteger(buffer.length)
    || buffer.length <= 0
    || !Number.isSafeInteger(buffer.numberOfChannels)
    || buffer.numberOfChannels <= 0
  ) {
    throw new Error("Decoded SFX audio has an invalid duration or buffer");
  }
}

function decodeAudioDataWithAbort(
  context: BaseAudioContext,
  bytes: ArrayBuffer,
  signal: AbortSignal
): Promise<AudioBuffer> {
  signal.throwIfAborted();
  const decode = context.decodeAudioData(bytes);
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void decode.then(
      (buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(buffer);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

export async function loadResolvedSfxAudio(
  source: ResolvedSfxSource,
  context: BaseAudioContext,
  signal: AbortSignal
): Promise<{ buffer: AudioBuffer; sourceBaseGain: number }> {
  signal.throwIfAborted();
  if (source.missing || !source.url) throw new Error("SFX source is missing");

  const response = await fetch(source.url, { signal });
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`SFX source request failed with HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  const buffer = await decodeAudioDataWithAbort(context, bytes, signal);
  signal.throwIfAborted();
  verifyDecodedBuffer(buffer);

  const peak = source.kind === "built-in"
    ? analyzeBuiltInPeak(buffer, source.sourceDuration)
    : 1;
  const gain = sourceBaseGain(source.kind, source.targetAmplitude, peak);
  signal.throwIfAborted();
  return { buffer, sourceBaseGain: gain };
}
