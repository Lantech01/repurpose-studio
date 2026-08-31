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
}

export interface AudioDifferenceWindow {
  centerSec: number;
  rms: number;
  hz660: number;
  hz880: number;
  hz1100: number;
}

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
  const length = Math.min(reference.length, candidate.length);
  const difference = new Float32Array(length);
  for (let i = 0; i < length; i++) difference[i] = candidate[i] - reference[i];
  return {
    ...measureTimedSfxWindow(difference, sfxCenterSec),
    fullRms: rms(difference),
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
  const length = Math.min(reference.length, candidate.length);
  const difference = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    difference[index] = candidate[index] - reference[index];
  }
  const halfWindow = Math.round(0.05 * 48_000);
  return centersSec.map((centerSec) => {
    const center = Math.round(centerSec * 48_000);
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
