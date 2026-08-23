import { spawn } from "node:child_process";

import type { MediaInspection } from "@/lib/repurpose/media-types";

export type CompatibilityEncoder =
  | "h264_nvenc"
  | "h264_qsv"
  | "h264_amf"
  | "h264_videotoolbox"
  | "libx264";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnedProcess {
  completion: Promise<ProcessResult>;
  kill: () => void;
}

export interface ProcessAdapter {
  run: (
    executable: string,
    args: string[],
    options?: { onStdout?: (chunk: string) => void },
  ) => SpawnedProcess;
}

export interface CompatibilityEncodeRequest {
  inputPath: string;
  outputPath: string;
  inspection: MediaInspection;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}

export interface CompatibilityEncoderRunner {
  encode: (request: CompatibilityEncodeRequest) => Promise<{ encoder: CompatibilityEncoder }>;
}

export class FfmpegProcessError extends Error {
  constructor(
    public readonly code: "FFMPEG_UNAVAILABLE" | "COMPATIBILITY_ENCODE_FAILED" | "COMPATIBILITY_CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "FfmpegProcessError";
  }
}

const PLATFORM_ENCODERS: Record<"win32" | "darwin" | "linux", readonly CompatibilityEncoder[]> = {
  win32: ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"],
  darwin: ["h264_videotoolbox", "libx264"],
  linux: ["h264_nvenc", "h264_qsv", "libx264"],
};

const ENCODER_ARGUMENTS: Record<CompatibilityEncoder, readonly string[]> = {
  h264_nvenc: ["-preset", "p7", "-cq", "18", "-b:v", "0"],
  h264_qsv: ["-preset", "medium", "-global_quality", "18"],
  h264_amf: ["-quality", "quality", "-qp_i", "18", "-qp_p", "18"],
  h264_videotoolbox: ["-q:v", "65"],
  libx264: ["-preset", "medium", "-crf", "18"],
};

function nodeProcessAdapter(): ProcessAdapter {
  return {
    run(executable, args, options = {}) {
      let child: ReturnType<typeof spawn> | undefined;
      let stdout = "";
      let stderr = "";
      const completion = new Promise<ProcessResult>((resolve, reject) => {
        try {
          child = spawn(executable, args, {
            windowsHide: true,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          reject(error);
          return;
        }
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
          options.onStdout?.(chunk);
        });
        child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
      return {
        completion,
        kill: () => {
          if (child && child.exitCode === null && !child.killed) child.kill();
        },
      };
    },
  };
}

function platformKey(platform: NodeJS.Platform): "win32" | "darwin" | "linux" {
  if (platform === "win32" || platform === "darwin") return platform;
  return "linux";
}

export function encoderCandidates(platform: NodeJS.Platform, listed: ReadonlySet<string>): CompatibilityEncoder[] {
  return PLATFORM_ENCODERS[platformKey(platform)].filter((encoder) => listed.has(encoder));
}

function parseEncoderListing(output: string): Set<string> {
  const encoders = new Set<string>();
  for (const match of output.matchAll(/\b(?:h264_nvenc|h264_qsv|h264_amf|h264_videotoolbox|libx264)\b/g)) {
    encoders.add(match[0]);
  }
  return encoders;
}

export function parseFfmpegProgress(output: string, durationSec: number): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const values = [...output.matchAll(/(?:^|\r?\n)out_time_(?:ms|us)=(\d+(?:\.\d+)?)(?=\r?\n|$)/g)];
  const raw = Number(values.at(-1)?.[1]);
  if (!Number.isFinite(raw)) return null;
  return Math.min(1, Math.max(0, raw / 1_000_000 / durationSec));
}

export function buildCompatibilityArguments(input: {
  inputPath: string;
  outputPath: string;
  encoder: CompatibilityEncoder;
  inspection: MediaInspection;
}): string[] {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input.inputPath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", input.encoder,
    ...ENCODER_ARGUMENTS[input.encoder],
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
  ];
  if (Number.isFinite(input.inspection.video.fps) && input.inspection.video.fps > 0) {
    args.push("-r", String(input.inspection.video.fps));
  }
  args.push("-progress", "pipe:1", "-nostats", input.outputPath);
  return args;
}

function cancelled(): FfmpegProcessError {
  return new FfmpegProcessError("COMPATIBILITY_CANCELLED", "Video conversion was cancelled.");
}

export function createFfmpegProcessRunner(options: {
  adapter?: ProcessAdapter;
  ffmpegPath?: string;
  platform?: NodeJS.Platform;
} = {}): CompatibilityEncoderRunner {
  const adapter = options.adapter ?? nodeProcessAdapter();
  const executable = options.ffmpegPath ?? "ffmpeg";
  const platform = options.platform ?? process.platform;
  let discovery: Promise<Set<string>> | undefined;

  const discover = (): Promise<Set<string>> => {
    discovery ??= (async () => {
      let result: ProcessResult;
      try {
        result = await adapter.run(executable, ["-hide_banner", "-encoders"]).completion;
      } catch {
        throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
      }
      if (result.code !== 0) throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
      return parseEncoderListing(`${result.stdout}\n${result.stderr}`);
    })();
    return discovery;
  };

  return {
    async encode(request) {
      if (request.signal.aborted) throw cancelled();
      const candidates = encoderCandidates(platform, await discover());
      if (request.signal.aborted) throw cancelled();
      if (candidates.length === 0) {
        throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "No H.264 encoder is available.");
      }

      for (const encoder of candidates) {
        if (request.signal.aborted) throw cancelled();
        let progressBuffer = "";
        let spawned: SpawnedProcess;
        try {
          spawned = adapter.run(
            executable,
            buildCompatibilityArguments({ ...request, encoder }),
            {
              onStdout(chunk) {
                progressBuffer = `${progressBuffer}${chunk}`.slice(-2_048);
                const progress = parseFfmpegProgress(progressBuffer, request.inspection.durationSec);
                if (progress !== null) request.onProgress(progress);
              },
            },
          );
        } catch {
          throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
        }
        const handleAbort = () => spawned.kill();
        request.signal.addEventListener("abort", handleAbort, { once: true });
        try {
          const result = await spawned.completion;
          if (request.signal.aborted) throw cancelled();
          if (result.code === 0) return { encoder };
        } catch (error) {
          if (request.signal.aborted) throw cancelled();
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
          }
        } finally {
          request.signal.removeEventListener("abort", handleAbort);
        }
      }
      throw new FfmpegProcessError("COMPATIBILITY_ENCODE_FAILED", "Video conversion failed.");
    },
  };
}

export const ffmpegProcessRunner = createFfmpegProcessRunner();
