import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { MediaInspection } from "@/lib/repurpose/media-types";

const execFileAsync = promisify(execFile);
const DEFAULT_COMPATIBILITY_SETTINGS_VERSION = "compat-v1";

export type MediaInspectionErrorCode = "MEDIA_INVALID" | "FFPROBE_UNAVAILABLE";

export class MediaInspectionError extends Error {
  constructor(
    public readonly code: MediaInspectionErrorCode,
    message: string,
    public readonly stderr = "",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaInspectionError";
  }
}

export type FfprobeRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export interface InspectMediaOptions {
  ffprobePath?: string;
  compatibilitySettingsVersion?: string;
  runFfprobe?: FfprobeRunner;
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

function invalidMedia(stderr = "", cause?: unknown): MediaInspectionError {
  return new MediaInspectionError("MEDIA_INVALID", "This file is not a readable video.", stderr, { cause });
}

const runFfprobe: FfprobeRunner = (executable, args) => execFileAsync(
  executable,
  args,
  { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
);

export async function createMediaFingerprint(
  mediaPath: string,
  compatibilitySettingsVersion = DEFAULT_COMPATIBILITY_SETTINGS_VERSION,
): Promise<string> {
  const [resolvedPath, metadata] = await Promise.all([realpath(mediaPath), stat(mediaPath)]);
  return createHash("sha256")
    .update(JSON.stringify({
      path: resolvedPath,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      compatibilitySettingsVersion,
    }))
    .digest("hex");
}

export async function inspectMedia(
  mediaPath: string,
  options: InspectMediaOptions = {},
): Promise<MediaInspection> {
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const args = ["-v", "error", "-show_format", "-show_streams", "-of", "json", mediaPath];
  let stdout: string | Buffer;
  try {
    ({ stdout } = await (options.runFfprobe ?? runFfprobe)(ffprobePath, args));
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: unknown };
    if (error.code === "ENOENT") {
      throw new MediaInspectionError(
        "FFPROBE_UNAVAILABLE",
        "Media inspection is unavailable.",
        "",
        { cause },
      );
    }
    throw invalidMedia(sanitizeStderr(error.stderr, mediaPath), cause);
  }

  let document: ProbeDocument;
  try {
    const parsed = JSON.parse(stdout.toString()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid ffprobe document");
    document = parsed as ProbeDocument;
  } catch (cause) {
    throw invalidMedia("", cause);
  }

  if (!Array.isArray(document.streams)) throw invalidMedia();
  if (document.streams.some((stream) => !stream || typeof stream !== "object" || Array.isArray(stream))) {
    throw invalidMedia();
  }
  const streams = document.streams as ProbeStream[];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const width = finiteNumber(video?.width);
  const height = finiteNumber(video?.height);
  const durationSec = finiteNumber(document.format?.duration ?? video?.duration);
  if (!video || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw invalidMedia();
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw invalidMedia();

  const metadata = await stat(mediaPath).catch((cause) => {
    throw invalidMedia("", cause);
  });
  const fingerprint = await createMediaFingerprint(
    mediaPath,
    options.compatibilitySettingsVersion ?? DEFAULT_COMPATIBILITY_SETTINGS_VERSION,
  ).catch((cause) => {
    throw invalidMedia("", cause);
  });

  return {
    fingerprint,
    container: stringValue(document.format?.format_name),
    extension: path.extname(mediaPath).toLowerCase(),
    size: metadata.size,
    durationSec,
    video: {
      codec: stringValue(video.codec_name),
      codecTag: stringValue(video.codec_tag_string),
      profile: stringValue(video.profile),
      pixelFormat: stringValue(video.pix_fmt),
      width,
      height,
      fps: parseRationalFrameRate(video.avg_frame_rate) || parseRationalFrameRate(video.r_frame_rate),
    },
    audio: audio
      ? {
          codec: stringValue(audio.codec_name),
          channels: finiteNumber(audio.channels) || 0,
          sampleRate: finiteNumber(audio.sample_rate) || 0,
        }
      : null,
  };
}
