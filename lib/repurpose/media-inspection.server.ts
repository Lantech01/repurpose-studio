import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { MediaInspection } from "@/lib/repurpose/media-types";

const execFileAsync = promisify(execFile);
const DEFAULT_COMPATIBILITY_SETTINGS_VERSION = "compat-v1";
const DEFAULT_FFPROBE_TIMEOUT_MS = 15_000;

export type MediaInspectionErrorCode =
  | "MEDIA_INVALID"
  | "FFPROBE_UNAVAILABLE"
  | "MEDIA_PROBE_TIMEOUT"
  | "MEDIA_PROBE_ABORTED"
  | "MEDIA_CHANGED";

export class MediaInspectionError extends Error {
  constructor(
    public readonly code: MediaInspectionErrorCode,
    message: string,
    public readonly stderr = "",
  ) {
    super(message);
    this.name = "MediaInspectionError";
  }
}

export interface FfprobeControls {
  signal: AbortSignal;
  timeoutMs: number;
}

export type FfprobeRunner = (
  executable: string,
  args: string[],
  controls: FfprobeControls,
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export type MediaStat = Pick<Stats, "size" | "mtimeMs" | "dev" | "ino" | "isFile">;

export interface InspectMediaOptions {
  ffprobePath?: string;
  compatibilitySettingsVersion?: string;
  runFfprobe?: FfprobeRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
  statMedia?: (mediaPath: string) => Promise<MediaStat>;
  realpathMedia?: (mediaPath: string) => Promise<string>;
}

interface ProbeStream {
  codec_type?: unknown;
  codec_name?: unknown;
  codec_tag_string?: unknown;
  profile?: unknown;
  pix_fmt?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
  duration?: unknown;
  channels?: unknown;
  sample_rate?: unknown;
  disposition?: unknown;
  side_data_list?: unknown;
  tags?: unknown;
}

interface ProbeDocument {
  format?: { format_name?: unknown; duration?: unknown };
  streams?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function parseRationalFrameRate(value: unknown): number {
  if (typeof value !== "string") return 0;
  const [numeratorText, denominatorText, ...extra] = value.split("/");
  if (extra.length > 0) return 0;
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function sanitizeStderr(stderr: unknown, mediaPath: string): string {
  let text = typeof stderr === "string" || Buffer.isBuffer(stderr) ? stderr.toString() : "";
  for (const privatePath of new Set([mediaPath, mediaPath.replaceAll("\\", "/")])) {
    if (privatePath) text = text.replaceAll(privatePath, "[media]");
  }
  return text
    .replace(/\r/g, "")
    .replace(/[^\x09\x0A\x20-\x7E\u00A0-\uFFFF]/g, "")
    .slice(0, 600);
}

function invalidMedia(stderr = ""): MediaInspectionError {
  return new MediaInspectionError("MEDIA_INVALID", "This file is not a readable video.", stderr);
}

function probeError(code: MediaInspectionErrorCode): MediaInspectionError {
  switch (code) {
    case "MEDIA_PROBE_TIMEOUT":
      return new MediaInspectionError(code, "Media inspection timed out.");
    case "MEDIA_PROBE_ABORTED":
      return new MediaInspectionError(code, "Media inspection was cancelled.");
    case "MEDIA_CHANGED":
      return new MediaInspectionError(code, "The media changed during inspection. Try again.");
    default:
      return invalidMedia();
  }
}

const runFfprobe: FfprobeRunner = (executable, args, controls) => execFileAsync(
  executable,
  args,
  {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    signal: controls.signal,
    timeout: controls.timeoutMs,
  },
);

function fingerprintSnapshot(
  resolvedPath: string,
  metadata: MediaStat,
  compatibilitySettingsVersion: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      path: resolvedPath,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      compatibilitySettingsVersion,
    }))
    .digest("hex");
}

function sameSnapshot(before: MediaStat, after: MediaStat): boolean {
  return before.isFile() && after.isFile()
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.dev === after.dev
    && before.ino === after.ino;
}

class ProbeControlError extends Error {
  constructor(public readonly kind: "timeout" | "aborted") {
    super(kind);
  }
}

async function runControlledProbe(
  runner: FfprobeRunner,
  executable: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ stdout: string | Buffer; stderr?: string | Buffer }> {
  if (signal?.aborted) throw new ProbeControlError("aborted");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handleCallerAbort: (() => void) | undefined;
  const controlFailure = new Promise<never>((_resolve, reject) => {
    handleCallerAbort = () => {
      controller.abort();
      reject(new ProbeControlError("aborted"));
    };
    signal?.addEventListener("abort", handleCallerAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeControlError("timeout"));
    }, timeoutMs);
  });
  const execution = Promise.resolve().then(() => runner(executable, args, {
    signal: controller.signal,
    timeoutMs,
  }));

  try {
    return await Promise.race([execution, controlFailure]);
  } finally {
    if (timer) clearTimeout(timer);
    if (handleCallerAbort) signal?.removeEventListener("abort", handleCallerAbort);
  }
}

export async function createMediaFingerprint(
  mediaPath: string,
  compatibilitySettingsVersion = DEFAULT_COMPATIBILITY_SETTINGS_VERSION,
): Promise<string> {
  const [resolvedPath, metadata] = await Promise.all([realpath(mediaPath), stat(mediaPath)]);
  if (!metadata.isFile()) throw invalidMedia();
  return fingerprintSnapshot(resolvedPath, metadata, compatibilitySettingsVersion);
}

function hasDisposition(stream: ProbeStream, name: "attached_pic" | "default"): boolean {
  if (!stream.disposition || typeof stream.disposition !== "object" || Array.isArray(stream.disposition)) {
    return false;
  }
  const value = (stream.disposition as Record<string, unknown>)[name];
  return value === true || value === 1 || value === "1";
}

function normalizedRotation(value: unknown): number {
  const numeric = finiteNumber(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = ((numeric % 360) + 360) % 360;
  const signed = normalized > 180 ? normalized - 360 : normalized;
  return Math.abs(signed) < 0.000_001 ? 0 : signed;
}

function streamRotation(stream: ProbeStream): number {
  if (Array.isArray(stream.side_data_list)) {
    for (const entry of stream.side_data_list) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.side_data_type === "Display Matrix" && Number.isFinite(finiteNumber(record.rotation))) {
        return normalizedRotation(record.rotation);
      }
    }
  }
  if (stream.tags && typeof stream.tags === "object" && !Array.isArray(stream.tags)) {
    return normalizedRotation((stream.tags as Record<string, unknown>).rotate);
  }
  return 0;
}

export async function inspectMedia(
  mediaPath: string,
  options: InspectMediaOptions = {},
): Promise<MediaInspection> {
  const statMedia = options.statMedia ?? stat;
  const realpathMedia = options.realpathMedia ?? realpath;
  let resolvedPath: string;
  let before: MediaStat;
  try {
    resolvedPath = await realpathMedia(mediaPath);
    before = await statMedia(resolvedPath);
  } catch {
    throw invalidMedia();
  }
  if (!before.isFile()) throw invalidMedia();
  if (options.signal?.aborted) throw probeError("MEDIA_PROBE_ABORTED");

  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? options.timeoutMs as number
    : DEFAULT_FFPROBE_TIMEOUT_MS;
  const args = ["-v", "error", "-show_format", "-show_streams", "-of", "json", resolvedPath];
  let stdout: string | Buffer;
  try {
    ({ stdout } = await runControlledProbe(
      options.runFfprobe ?? runFfprobe,
      ffprobePath,
      args,
      options.signal,
      timeoutMs,
    ));
  } catch (cause) {
    if (cause instanceof ProbeControlError) {
      throw probeError(cause.kind === "timeout" ? "MEDIA_PROBE_TIMEOUT" : "MEDIA_PROBE_ABORTED");
    }
    if (options.signal?.aborted) throw probeError("MEDIA_PROBE_ABORTED");
    const error = cause as NodeJS.ErrnoException & { stderr?: unknown };
    if (error.code === "ENOENT") {
      throw new MediaInspectionError("FFPROBE_UNAVAILABLE", "Media inspection is unavailable.");
    }
    throw invalidMedia(sanitizeStderr(error.stderr, resolvedPath));
  }

  let afterPath: string;
  let after: MediaStat;
  try {
    afterPath = await realpathMedia(resolvedPath);
    after = await statMedia(afterPath);
  } catch {
    throw probeError("MEDIA_CHANGED");
  }
  if (afterPath !== resolvedPath || !sameSnapshot(before, after)) throw probeError("MEDIA_CHANGED");

  let document: ProbeDocument;
  try {
    const parsed = JSON.parse(stdout.toString()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid ffprobe document");
    document = parsed as ProbeDocument;
  } catch {
    throw invalidMedia();
  }

  if (!Array.isArray(document.streams)) throw invalidMedia();
  if (document.streams.some((stream) => !stream || typeof stream !== "object" || Array.isArray(stream))) {
    throw invalidMedia();
  }
  const streams = document.streams as ProbeStream[];
  const videos = streams.filter((stream) => stream.codec_type === "video" && !hasDisposition(stream, "attached_pic"));
  const video = videos.find((stream) => hasDisposition(stream, "default")) ?? videos[0];
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const width = finiteNumber(video?.width);
  const height = finiteNumber(video?.height);
  const durationSec = finiteNumber(document.format?.duration ?? video?.duration);
  if (!video || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw invalidMedia();
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw invalidMedia();

  const fingerprint = fingerprintSnapshot(
    resolvedPath,
    before,
    options.compatibilitySettingsVersion ?? DEFAULT_COMPATIBILITY_SETTINGS_VERSION,
  );

  return {
    fingerprint,
    container: stringValue(document.format?.format_name),
    extension: path.extname(resolvedPath).toLowerCase(),
    size: before.size,
    durationSec,
    video: {
      codec: stringValue(video.codec_name),
      codecTag: stringValue(video.codec_tag_string),
      profile: stringValue(video.profile),
      pixelFormat: stringValue(video.pix_fmt),
      width,
      height,
      fps: parseRationalFrameRate(video.avg_frame_rate) || parseRationalFrameRate(video.r_frame_rate),
      rotationDeg: streamRotation(video),
    },
    audio: audio
      ? {
          codec: stringValue(audio.codec_name),
          channels: finiteNumber(audio.channels) || 0,
          sampleRate: finiteNumber(audio.sample_rate) || 0,
          ...(finiteNumber(audio.duration) > 0
            ? { durationSec: finiteNumber(audio.duration) }
            : {}),
        }
      : null,
  };
}
