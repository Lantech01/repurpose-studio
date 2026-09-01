import { spawn } from "node:child_process";

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
}

export interface MediaProbe {
  streams: ProbeStream[];
  format?: { duration?: string; size?: string; format_name?: string };
}

export interface AudioMeasurements {
  hz220: number;
  hz440: number;
  sfxWindowRms: number;
  sfxBeforeRms: number;
  sfxAfterRms: number;
  sfxLocalContrast: number;
  fullRms: number;
}

export interface TimedSfxWindowMeasurement {
  eventRms: number;
  beforeRms: number;
  afterRms: number;
  localContrast: number;
}

export interface AudioDifferenceMeasurements extends TimedSfxWindowMeasurement {
  fullRms: number;
  hz220: number;
  hz440: number;
  alignmentLagSamples: number;
  alignmentCorrelation: number;
}

export interface AudioDifferenceWindow {
  centerSec: number;
  rms: number;
  hz660: number;
  hz880: number;
  hz1100: number;
}

export interface PcmAlignmentOptions {
  sampleRate?: number;
  maxLagSec?: number;
  minOverlapSec?: number;
  minOverlapRatio?: number;
  minCorrelation?: number;
}

export interface PcmAlignment {
  lagSamples: number;
  correlation: number;
  referenceStart: number;
  candidateStart: number;
  reference: Float32Array;
  candidate: Float32Array;
}

// AAC priming is normally about 21 ms at 48 kHz. A 100 ms cap allows encoder
// variance without permitting correlation to drift to unrelated edit content.
export const MAX_PCM_ALIGNMENT_LAG_SEC = 0.1;

function spawnToBuffer(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else {
        reject(
          new Error(
            `${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 600)}`
          )
        );
      }
    });
  });
}

export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const output = await spawnToBuffer("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  return JSON.parse(output.toString("utf8")) as MediaProbe;
}

async function decodeMonoFloat48k(filePath: string): Promise<Float32Array> {
  const output = await spawnToBuffer("ffmpeg", [
    "-v",
    "error",
    "-i",
    filePath,
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "pipe:1",
  ]);
  return new Float32Array(
    output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
  );
}

function goertzelMagnitude(
  samples: Float32Array,
  frequency: number,
  sampleRate = 48_000
): number {
  if (samples.length === 0) return 0;
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (const sample of samples) {
    q0 = coefficient * q1 - q2 + sample;
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * Math.cos(omega);
  const imaginary = q2 * Math.sin(omega);
  return (2 * Math.hypot(real, imaginary)) / samples.length;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function normalizedCorrelationAtLag(
  reference: Float32Array,
  candidate: Float32Array,
  lagSamples: number,
  stride: number
): number {
  const referenceStart = lagSamples < 0 ? -lagSamples : 0;
  const candidateStart = lagSamples > 0 ? lagSamples : 0;
  const length = Math.min(
    reference.length - referenceStart,
    candidate.length - candidateStart
  );
  if (length <= 1) return Number.NEGATIVE_INFINITY;
  let count = 0;
  let sumReference = 0;
  let sumCandidate = 0;
  let sumReferenceSquared = 0;
  let sumCandidateSquared = 0;
  let sumProduct = 0;
  for (let index = 0; index < length; index += stride) {
    const left = reference[referenceStart + index];
    const right = candidate[candidateStart + index];
    count += 1;
    sumReference += left;
    sumCandidate += right;
    sumReferenceSquared += left * left;
    sumCandidateSquared += right * right;
    sumProduct += left * right;
  }
  const covariance = sumProduct - sumReference * sumCandidate / count;
  const referenceVariance = sumReferenceSquared - sumReference * sumReference / count;
  const candidateVariance = sumCandidateSquared - sumCandidate * sumCandidate / count;
  const denominator = Math.sqrt(referenceVariance * candidateVariance);
  return denominator > 0 ? covariance / denominator : Number.NEGATIVE_INFINITY;
}

export function alignPcmForDifference(
  reference: Float32Array,
  candidate: Float32Array,
  options: PcmAlignmentOptions = {}
): PcmAlignment {
  const sampleRate = options.sampleRate ?? 48_000;
  const maxLagSec = options.maxLagSec ?? MAX_PCM_ALIGNMENT_LAG_SEC;
  const minOverlapSec = options.minOverlapSec ?? 0.5;
  const minOverlapRatio = options.minOverlapRatio ?? 0.8;
  const minCorrelation = options.minCorrelation ?? 0.8;
  if (
    !Number.isFinite(sampleRate) || sampleRate <= 0 ||
    !Number.isFinite(maxLagSec) || maxLagSec < 0 ||
    !Number.isFinite(minOverlapSec) || minOverlapSec < 0 ||
    !Number.isFinite(minOverlapRatio) || minOverlapRatio <= 0 || minOverlapRatio > 1 ||
    !Number.isFinite(minCorrelation) || minCorrelation < -1 || minCorrelation > 1
  ) {
    throw new Error("Invalid PCM alignment options");
  }
  const maxLagSamples = Math.min(
    Math.round(maxLagSec * sampleRate),
    Math.max(0, Math.min(reference.length, candidate.length) - 1)
  );
  const stride = Math.max(1, Math.ceil(Math.max(reference.length, candidate.length) / 12_000));
  let bestLag = 0;
  let bestCorrelation = Number.NEGATIVE_INFINITY;
  const consider = (lag: number, correlation: number) => {
    if (
      correlation > bestCorrelation + 1e-12 ||
      (Math.abs(correlation - bestCorrelation) <= 1e-12 && Math.abs(lag) < Math.abs(bestLag))
    ) {
      bestLag = lag;
      bestCorrelation = correlation;
    }
  };
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += stride) {
    consider(lag, normalizedCorrelationAtLag(reference, candidate, lag, stride));
  }
  const coarseLag = bestLag;
  bestCorrelation = Number.NEGATIVE_INFINITY;
  for (
    let lag = Math.max(-maxLagSamples, coarseLag - stride);
    lag <= Math.min(maxLagSamples, coarseLag + stride);
    lag += 1
  ) {
    consider(lag, normalizedCorrelationAtLag(reference, candidate, lag, 1));
  }
  // Candidate-only effects can make a whole-cycle lag score slightly better by
  // excluding mismatched samples. Treat correlations within 0.02 as equivalent
  // and prefer zero; real encoder delays still need a materially stronger score.
  const zeroLagCorrelation = normalizedCorrelationAtLag(reference, candidate, 0, 1);
  if (bestCorrelation - zeroLagCorrelation <= 0.02) {
    bestLag = 0;
    bestCorrelation = zeroLagCorrelation;
  }
  const referenceStart = bestLag < 0 ? -bestLag : 0;
  const candidateStart = bestLag > 0 ? bestLag : 0;
  const overlapLength = Math.min(
    reference.length - referenceStart,
    candidate.length - candidateStart
  );
  const minimumLength = Math.ceil(minOverlapSec * sampleRate);
  const minimumRatioLength = Math.ceil(Math.min(reference.length, candidate.length) * minOverlapRatio);
  if (overlapLength < minimumLength || overlapLength < minimumRatioLength) {
    throw new Error(
      `PCM alignment overlap is insufficient: ${overlapLength} samples at ${sampleRate} Hz`
    );
  }
  if (!Number.isFinite(bestCorrelation) || bestCorrelation < minCorrelation) {
    throw new Error(
      `PCM alignment correlation ${bestCorrelation.toFixed(4)} is below ${minCorrelation}`
    );
  }
  return {
    lagSamples: bestLag,
    correlation: bestCorrelation,
    referenceStart,
    candidateStart,
    reference: reference.subarray(referenceStart, referenceStart + overlapLength),
    candidate: candidate.subarray(candidateStart, candidateStart + overlapLength),
  };
}

export function measureTimedSfxWindow(
  samples: Float32Array,
  centerSec: number,
  sampleRate = 48_000
): TimedSfxWindowMeasurement {
  const halfWindow = Math.round(0.05 * sampleRate);
  const neighborOffset = Math.round(0.25 * sampleRate);
  const center = Math.round(centerSec * sampleRate);
  const windowRms = (windowCenter: number) =>
    rms(
      samples.subarray(
        Math.max(0, windowCenter - halfWindow),
        Math.min(samples.length, windowCenter + halfWindow)
      )
    );
  const eventRms = windowRms(center);
  const beforeRms = windowRms(center - neighborOffset);
  const afterRms = windowRms(center + neighborOffset);
  const localBaseline = Math.max(beforeRms, afterRms);
  return {
    eventRms,
    beforeRms,
    afterRms,
    localContrast: localBaseline > 0 ? eventRms / localBaseline : 0,
  };
}

export async function analyzeAudio(
  filePath: string,
  sfxCenterSec: number
): Promise<AudioMeasurements> {
  const samples = await decodeMonoFloat48k(filePath);
  const timedSfx = measureTimedSfxWindow(samples, sfxCenterSec);
  return {
    hz220: goertzelMagnitude(samples, 220),
    hz440: goertzelMagnitude(samples, 440),
    sfxWindowRms: timedSfx.eventRms,
    sfxBeforeRms: timedSfx.beforeRms,
    sfxAfterRms: timedSfx.afterRms,
    sfxLocalContrast: timedSfx.localContrast,
    fullRms: rms(samples),
  };
}

export async function analyzeAudioDifference(
  referencePath: string,
  candidatePath: string,
  sfxCenterSec: number
): Promise<AudioDifferenceMeasurements> {
  const [reference, candidate] = await Promise.all([
    decodeMonoFloat48k(referencePath),
    decodeMonoFloat48k(candidatePath),
  ]);
  const aligned = alignPcmForDifference(reference, candidate);
  const length = aligned.reference.length;
  const difference = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    difference[i] = aligned.candidate[i] - aligned.reference[i];
  }
  const alignedCenterSec = sfxCenterSec - aligned.referenceStart / 48_000;
  return {
    ...measureTimedSfxWindow(difference, alignedCenterSec),
    fullRms: rms(difference),
    hz220: goertzelMagnitude(difference, 220),
    hz440: goertzelMagnitude(difference, 440),
    alignmentLagSamples: aligned.lagSamples,
    alignmentCorrelation: aligned.correlation,
  };
}

export async function analyzeAudioDifferenceWindows(
  referencePath: string,
  candidatePath: string,
  centersSec: readonly number[]
): Promise<AudioDifferenceWindow[]> {
  const [reference, candidate] = await Promise.all([
    decodeMonoFloat48k(referencePath),
    decodeMonoFloat48k(candidatePath),
  ]);
  const aligned = alignPcmForDifference(reference, candidate);
  const length = aligned.reference.length;
  const difference = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    difference[index] = aligned.candidate[index] - aligned.reference[index];
  }
  const halfWindow = Math.round(0.05 * 48_000);
  return centersSec.map((centerSec) => {
    const center = Math.round(centerSec * 48_000) - aligned.referenceStart;
    const window = difference.subarray(
      Math.max(0, center - halfWindow),
      Math.min(difference.length, center + halfWindow)
    );
    return {
      centerSec,
      rms: rms(window),
      hz660: goertzelMagnitude(window, 660),
      hz880: goertzelMagnitude(window, 880),
      hz1100: goertzelMagnitude(window, 1100),
    };
  });
}

export function frameRate(stream: ProbeStream): number {
  const raw = stream.avg_frame_rate ?? stream.r_frame_rate ?? "0/1";
  const [numerator, denominator] = raw.split("/").map(Number);
  return denominator > 0 ? numerator / denominator : 0;
}

export function mediaDuration(probe: MediaProbe): number {
  const formatDuration = Number(probe.format?.duration);
  if (Number.isFinite(formatDuration) && formatDuration > 0) return formatDuration;
  return Math.max(0, ...probe.streams.map((stream) => Number(stream.duration) || 0));
}
