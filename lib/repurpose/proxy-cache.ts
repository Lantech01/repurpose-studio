import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  encoderCandidates,
  parseFfmpegProgress,
  type CompatibilityEncoder,
  type ProcessAdapter,
  type ProcessResult,
  type SpawnedProcess,
} from "./ffmpeg-process.server";
import { inspectMedia } from "./media-inspection.server";
import type { MediaInspection } from "./media-types";

export const PROXY_SHORT_SIDE = 540;
export const PROXY_SETTINGS_VERSION = "proxy-v2-540p-gop-half-second";
export const PROXY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const PROXY_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const PROXY_CACHE_DIR = path.join(os.tmpdir(), "repurpose-proxy");

const PROXY_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
const PROXY_PARTIAL_ORPHAN_GRACE_MS = PROXY_SWEEP_INTERVAL_MS;
const PROXYABLE_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const CURRENT_PROXY_FINAL_NAME = new RegExp(
  `^[a-f0-9]{24}-${PROXY_SETTINGS_VERSION}\\.mp4$`
);
const CURRENT_PROXY_PARTIAL_NAME = new RegExp(
  `^[a-f0-9]{24}-${PROXY_SETTINGS_VERSION}\\.mp4\\.\\d+-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.partial\\.mp4$`
);
const LEGACY_PROXY_FINAL_NAME = /^[a-f0-9]{16}-144p\.mp4$/;
const LEGACY_PROXY_PARTIAL_NAME =
  /^[a-f0-9]{16}-144p\.mp4\.\d+\.partial\.mp4$/;

export type ProxyStatus = "ready" | "building" | "none" | "unavailable" | "failed";

export interface ProxyState {
  status: ProxyStatus;
  proxyPath?: string;
  progress?: number;
  error?: { code: string; message: string };
}

export interface ProxyInput {
  filePath: string;
  mtimeMs: number;
  size: number;
}

export interface ProxyEncodeRequest {
  inputPath: string;
  outputPath: string;
  inspection: MediaInspection;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}

type EncodeProxy = (request: ProxyEncodeRequest) => Promise<{ encoder: CompatibilityEncoder | string }>;

export interface ProxyPlaybackInspection {
  keyframeTimesSec: number[];
  audioDurationSec: number | null;
}

type InspectPlayback = (
  mediaPath: string,
  controls?: { signal?: AbortSignal }
) => Promise<ProxyPlaybackInspection>;

const execFileAsync = promisify(execFile);
const PROXY_VALIDATION_TIMEOUT_MS = 15_000;
const PROXY_VALIDATION_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_PROXY_KEYFRAME_GAP_SEC = 0.6;

export class ProxyBuildError extends Error {
  constructor(
    public readonly code:
      | "VIDEO_PROXY_FAILED"
      | "VIDEO_PROXY_CANCELLED"
      | "FFMPEG_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "ProxyBuildError";
  }
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function proxyDimensions(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: PROXY_SHORT_SIDE, height: PROXY_SHORT_SIDE };
  if (width >= height) {
    return {
      width: even((width / height) * PROXY_SHORT_SIDE),
      height: PROXY_SHORT_SIDE,
    };
  }
  return {
    width: PROXY_SHORT_SIDE,
    height: even((height / width) * PROXY_SHORT_SIDE),
  };
}

export function proxyGopFrames(fps: number): number {
  return Math.max(1, Math.round((Number.isFinite(fps) && fps > 0 ? fps : 30) * 0.5));
}

const PROXY_ENCODER_ARGUMENTS: Record<CompatibilityEncoder, readonly string[]> = {
  h264_nvenc: ["-preset", "p4", "-cq", "25", "-b:v", "0"],
  h264_qsv: [
    "-preset",
    "veryfast",
    "-global_quality",
    "25",
    "-forced_idr",
    "true",
  ],
  h264_amf: ["-quality", "speed", "-qp_i", "25", "-qp_p", "25"],
  h264_videotoolbox: ["-q:v", "45", "-realtime", "true"],
  libx264: ["-preset", "veryfast", "-crf", "25"],
};

export function buildProxyArguments(input: {
  inputPath: string;
  outputPath: string;
  inspection: MediaInspection;
  encoder: CompatibilityEncoder;
}): string[] {
  const gop = proxyGopFrames(input.inspection.video.fps);
  const landscape = input.inspection.video.width >= input.inspection.video.height;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-noautorotate",
    "-i", input.inputPath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", landscape ? `scale=-2:${PROXY_SHORT_SIDE}` : `scale=${PROXY_SHORT_SIDE}:-2`,
    "-c:v", input.encoder,
    ...PROXY_ENCODER_ARGUMENTS[input.encoder],
    "-pix_fmt", "yuv420p",
    "-g", String(gop),
    "-force_key_frames", "expr:gte(t,n_forced*0.5)",
  ];
  if (input.encoder === "libx264") {
    args.push("-keyint_min", String(gop), "-sc_threshold", "0");
  }
  args.push(
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    input.outputPath
  );
  return args;
}

function rotationDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return Math.min(delta, 360 - delta);
}

export function validateProxyOutput(input: MediaInspection, output: MediaInspection): void {
  const dimensions = proxyDimensions(input.video.width, input.video.height);
  const frameSec = input.video.fps > 0 ? 1 / input.video.fps : 1 / 30;
  const valid =
    output.video.codec.toLowerCase() === "h264" &&
    output.video.pixelFormat.toLowerCase() === "yuv420p" &&
    output.video.width === dimensions.width &&
    output.video.height === dimensions.height &&
    output.video.width % 2 === 0 &&
    output.video.height % 2 === 0 &&
    rotationDistance(output.video.rotationDeg ?? 0, input.video.rotationDeg ?? 0) <= 0.01 + Number.EPSILON &&
    Math.abs(output.durationSec - input.durationSec) <= Math.max(0.25, frameSec) + Number.EPSILON &&
    (!input.audio || output.audio?.codec.toLowerCase() === "aac");
  if (!valid) {
    throw new ProxyBuildError("VIDEO_PROXY_FAILED", "Proxy output failed validation.");
  }
}

export function validateProxyPlayback(
  input: MediaInspection,
  output: MediaInspection,
  playback: ProxyPlaybackInspection
): void {
  const keyframes = playback.keyframeTimesSec
    .filter(
      (time) =>
        Number.isFinite(time) &&
        time >= 0 &&
        time <= output.durationSec + Number.EPSILON
    )
    .sort((left, right) => left - right);
  let previousKeyframe = 0;
  let maxGap = 0;
  for (const keyframe of keyframes) {
    maxGap = Math.max(maxGap, keyframe - previousKeyframe);
    previousKeyframe = keyframe;
  }
  maxGap = Math.max(maxGap, output.durationSec - previousKeyframe);
  const frameSec = input.video.fps > 0 ? 1 / input.video.fps : 1 / 30;
  const durationTolerance = Math.max(0.25, frameSec) + Number.EPSILON;
  const audioIsComplete =
    !input.audio ||
    (output.audio !== null &&
      playback.audioDurationSec !== null &&
      Number.isFinite(playback.audioDurationSec) &&
      playback.audioDurationSec + durationTolerance >=
        (input.audio.durationSec ?? input.durationSec));
  if (
    keyframes.length === 0 ||
    maxGap > MAX_PROXY_KEYFRAME_GAP_SEC + Number.EPSILON ||
    !audioIsComplete
  ) {
    throw new ProxyBuildError(
      "VIDEO_PROXY_FAILED",
      "Proxy output failed playback validation."
    );
  }
}

export async function inspectProxyPlayback(
  mediaPath: string,
  controls: { signal?: AbortSignal } = {}
): Promise<ProxyPlaybackInspection> {
  const options = {
    encoding: "utf8" as const,
    windowsHide: true,
    maxBuffer: PROXY_VALIDATION_MAX_BUFFER,
    signal: controls.signal,
    timeout: PROXY_VALIDATION_TIMEOUT_MS,
  };
  const [keyframeResult, audioResult] = await Promise.all([
    execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-skip_frame",
        "nokey",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        mediaPath,
      ],
      options
    ),
    execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "json",
        mediaPath,
      ],
      options
    ),
  ]);
  const keyframeDocument = JSON.parse(keyframeResult.stdout.toString()) as {
    frames?: Array<{ best_effort_timestamp_time?: unknown }>;
  };
  const audioDocument = JSON.parse(audioResult.stdout.toString()) as {
    streams?: Array<{ duration?: unknown }>;
  };
  return {
    keyframeTimesSec: Array.isArray(keyframeDocument.frames)
      ? keyframeDocument.frames
          .map((frame) => Number(frame.best_effort_timestamp_time))
          .filter(Number.isFinite)
      : [],
    audioDurationSec: Array.isArray(audioDocument.streams)
      ? Number.isFinite(Number(audioDocument.streams[0]?.duration))
        ? Number(audioDocument.streams[0]?.duration)
        : null
      : null,
  };
}

function nodeProcessAdapter(): ProcessAdapter {
  return {
    run(executable, args, options = {}) {
      let child: ReturnType<typeof spawn> | undefined;
      let stdout = "";
      let stderr = "";
      const completion = new Promise<ProcessResult>((resolve, reject) => {
        child = spawn(executable, args, {
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout = `${stdout}${chunk}`.slice(-64 * 1024);
          options.onStdout?.(chunk);
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr = `${stderr}${chunk}`.slice(-64 * 1024);
        });
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

function cancelled(): ProxyBuildError {
  return new ProxyBuildError("VIDEO_PROXY_CANCELLED", "Proxy build was cancelled.");
}

function listedEncoders(output: string): Set<string> {
  return new Set(
    [...output.matchAll(/\b(?:h264_nvenc|h264_qsv|h264_amf|h264_videotoolbox|libx264)\b/g)].map(
      (match) => match[0]
    )
  );
}

export function createProxyEncoder(options: {
  adapter?: ProcessAdapter;
  ffmpegPath?: string;
  platform?: NodeJS.Platform;
} = {}): { encode: EncodeProxy } {
  const adapter = options.adapter ?? nodeProcessAdapter();
  const executable = options.ffmpegPath ?? "ffmpeg";
  const platform = options.platform ?? process.platform;
  let discovered: Promise<Set<string>> | null = null;

  const discover = (): Promise<Set<string>> => {
    discovered ??= (() => {
      let process: SpawnedProcess;
      try {
        process = adapter.run(executable, ["-hide_banner", "-encoders"]);
      } catch {
        return Promise.reject(new ProxyBuildError("FFMPEG_UNAVAILABLE", "Preview proxy is unavailable."));
      }
      return process.completion.then(
        (result) => {
          if (result.code !== 0) throw new ProxyBuildError("FFMPEG_UNAVAILABLE", "Preview proxy is unavailable.");
          return listedEncoders(`${result.stdout}\n${result.stderr}`);
        },
        () => {
          discovered = null;
          throw new ProxyBuildError("FFMPEG_UNAVAILABLE", "Preview proxy is unavailable.");
        }
      );
    })();
    return discovered;
  };

  return {
    async encode(request) {
      if (request.signal.aborted) throw cancelled();
      const candidates = encoderCandidates(platform, await discover());
      if (candidates.length === 0) {
        throw new ProxyBuildError("FFMPEG_UNAVAILABLE", "Preview proxy is unavailable.");
      }
      for (const encoder of candidates) {
        if (request.signal.aborted) throw cancelled();
        let progressBuffer = "";
        let process: SpawnedProcess;
        try {
          process = adapter.run(
            executable,
            buildProxyArguments({ ...request, encoder }),
            {
              onStdout(chunk) {
                progressBuffer = `${progressBuffer}${chunk}`.slice(-2_048);
                const progress = parseFfmpegProgress(progressBuffer, request.inspection.durationSec);
                if (progress !== null) request.onProgress(progress);
              },
            }
          );
        } catch {
          throw new ProxyBuildError("FFMPEG_UNAVAILABLE", "Preview proxy is unavailable.");
        }
        const abort = () => process.kill();
        request.signal.addEventListener("abort", abort, { once: true });
        try {
          const result = await process.completion;
          if (request.signal.aborted) throw cancelled();
          if (result.code === 0) return { encoder };
        } catch (error) {
          if (request.signal.aborted) throw cancelled();
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ProxyBuildError("FFMPEG_UNAVAILABLE", "Preview proxy is unavailable.");
          }
        } finally {
          request.signal.removeEventListener("abort", abort);
        }
      }
      throw new ProxyBuildError("VIDEO_PROXY_FAILED", "Preview proxy encode failed.");
    },
  };
}

export function proxyCachePath(
  filePath: string,
  mtimeMs: number,
  size: number,
  cacheDir = PROXY_CACHE_DIR
): string {
  const key = createHash("sha256")
    .update(`${filePath}\u0000${Math.round(mtimeMs)}\u0000${size}\u0000${PROXY_SETTINGS_VERSION}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(cacheDir, `${key}-${PROXY_SETTINGS_VERSION}.mp4`);
}

interface ProxyCacheOptions {
  cacheDir?: string;
  ttlMs?: number;
  maxBytes?: number;
  now?: () => number;
  encode?: EncodeProxy;
  inspectInput?: (mediaPath: string, controls?: { signal?: AbortSignal }) => Promise<MediaInspection>;
  inspectOutput?: (mediaPath: string, controls?: { signal?: AbortSignal }) => Promise<MediaInspection>;
  inspectPlayback?: InspectPlayback;
  remove?: (filePath: string) => Promise<void>;
}

export interface ProxyCache {
  get: (input: ProxyInput) => ProxyState;
  lookup: (input: ProxyInput) => Promise<ProxyState>;
  start: (input: ProxyInput) => Promise<ProxyState>;
  sweep: () => Promise<void>;
  acquireLease: (proxyPath: string) => (() => void) | null;
}

function managedProxyArtifact(name: string): "final" | "partial" | null {
  if (
    CURRENT_PROXY_FINAL_NAME.test(name) ||
    LEGACY_PROXY_FINAL_NAME.test(name)
  ) {
    return "final";
  }
  if (
    CURRENT_PROXY_PARTIAL_NAME.test(name) ||
    LEGACY_PROXY_PARTIAL_NAME.test(name)
  ) {
    return "partial";
  }
  return null;
}

export function createProxyCache(options: ProxyCacheOptions = {}): ProxyCache {
  const cacheDir = options.cacheDir ?? PROXY_CACHE_DIR;
  const ttlMs = options.ttlMs ?? PROXY_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? PROXY_CACHE_MAX_BYTES;
  const now = options.now ?? Date.now;
  const encode = options.encode ?? createProxyEncoder().encode;
  const inspectInput = options.inspectInput ?? inspectMedia;
  const inspectOutput = options.inspectOutput ?? inspectMedia;
  const inspectPlayback = options.inspectPlayback ?? inspectProxyPlayback;
  const remove = options.remove ?? ((filePath: string) => rm(filePath, { force: true }));
  const jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const activePartials = new Set<string>();
  const finalLeases = new Map<string, number>();
  const deletingFinals = new Set<string>();
  const states = new Map<string, ProxyState>();
  let lastSweepAt = 0;
  let maintenance = Promise.resolve();

  const finalPath = (input: ProxyInput) =>
    proxyCachePath(input.filePath, input.mtimeMs, input.size, cacheDir);

  const acquireLease = (proxyPath: string): (() => void) | null => {
    const normalizedPath = path.resolve(proxyPath);
    if (
      path.dirname(normalizedPath) !== path.resolve(cacheDir) ||
      managedProxyArtifact(path.basename(normalizedPath)) !== "final" ||
      deletingFinals.has(normalizedPath)
    ) {
      return null;
    }
    finalLeases.set(normalizedPath, (finalLeases.get(normalizedPath) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (finalLeases.get(normalizedPath) ?? 1) - 1;
      if (remaining > 0) finalLeases.set(normalizedPath, remaining);
      else finalLeases.delete(normalizedPath);
    };
  };

  const isLeased = (file: string): boolean =>
    (finalLeases.get(path.resolve(file)) ?? 0) > 0;

  const removeManaged = async (
    file: string,
    artifact: "final" | "partial"
  ): Promise<boolean> => {
    const normalizedPath = path.resolve(file);
    if (artifact === "final") {
      if (isLeased(normalizedPath)) return false;
      deletingFinals.add(normalizedPath);
    }
    try {
      await remove(file);
      states.delete(file);
      return true;
    } catch {
      return false;
    } finally {
      if (artifact === "final") deletingFinals.delete(normalizedPath);
    }
  };

  const get = (input: ProxyInput): ProxyState =>
    states.get(finalPath(input)) ?? { status: "none" };

  const lookup = async (input: ProxyInput): Promise<ProxyState> => {
    const outputPath = finalPath(input);
    const current = states.get(outputPath);
    if (current?.status === "building" || current?.status === "failed" || current?.status === "unavailable") {
      return current;
    }
    try {
      const metadata = await stat(outputPath);
      if (metadata.isFile() && metadata.size > 0) {
        const ready = { status: "ready", proxyPath: outputPath } as const;
        states.set(outputPath, ready);
        return ready;
      }
    } catch {
      if (current?.status === "ready") states.delete(outputPath);
    }
    return { status: "none" };
  };

  const performSweep = async (
    force: boolean,
    protectedPath?: string
  ): Promise<void> => {
    const timestamp = now();
    if (
      !force &&
      timestamp - lastSweepAt < PROXY_SWEEP_INTERVAL_MS &&
      lastSweepAt !== 0
    ) {
      return;
    }
    lastSweepAt = timestamp;
    let names: string[];
    try {
      names = await readdir(cacheDir);
    } catch {
      return;
    }
    const entries: Array<{
      path: string;
      metadata: Stats;
      artifact: "final" | "partial";
    }> = [];
    for (const name of names) {
      const artifact = managedProxyArtifact(name);
      if (!artifact) continue;
      const isPartial = artifact === "partial";
      const file = path.join(cacheDir, name);
      if (isPartial && activePartials.has(file)) continue;
      try {
        const metadata = await stat(file);
        if (!metadata.isFile()) continue;
        const expired = isPartial
          ? timestamp - metadata.mtimeMs > PROXY_PARTIAL_ORPHAN_GRACE_MS
          : timestamp - metadata.mtimeMs > ttlMs;
        if (expired) {
          if (
            !(await removeManaged(file, artifact))
          ) {
            entries.push({ path: file, metadata, artifact });
          }
        } else {
          entries.push({ path: file, metadata, artifact });
        }
      } catch {
        // Cache entries may disappear while maintenance is scanning them.
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.metadata.size, 0);
    entries.sort((left, right) => {
      if (left.path === protectedPath) return 1;
      if (right.path === protectedPath) return -1;
      return left.metadata.mtimeMs - right.metadata.mtimeMs;
    });
    for (const entry of entries) {
      if (total <= maxBytes) break;
      if (
        entry.path === protectedPath ||
        (entry.artifact === "final" && isLeased(entry.path))
      ) {
        continue;
      }
      if (await removeManaged(entry.path, entry.artifact)) {
        total -= entry.metadata.size;
      }
    }
  };

  const queueSweep = (
    force = false,
    protectedPath?: string
  ): Promise<void> => {
    const pending = maintenance.then(() =>
      performSweep(force, protectedPath)
    );
    maintenance = pending.catch(() => undefined);
    return pending;
  };

  const sweep = (): Promise<void> => queueSweep();

  const start = async (input: ProxyInput): Promise<ProxyState> => {
    if (!PROXYABLE_EXTENSIONS.has(path.extname(input.filePath).toLowerCase())) {
      return { status: "unavailable" };
    }
    const outputPath = finalPath(input);
    const current = await lookup(input);
    if (current.status === "ready" || current.status === "building") return current;
    if (jobs.has(outputPath)) return states.get(outputPath) ?? { status: "building", progress: 0 };

    const controller = new AbortController();
    states.set(outputPath, { status: "building", progress: 0 });
    const partialPath = `${outputPath}.${process.pid}-${randomUUID()}.partial.mp4`;
    activePartials.add(partialPath);
    const promise = (async () => {
      try {
        await mkdir(cacheDir, { recursive: true });
        void sweep().catch(() => undefined);
        const inspection = await inspectInput(input.filePath, { signal: controller.signal });
        await encode({
          inputPath: input.filePath,
          outputPath: partialPath,
          inspection,
          signal: controller.signal,
          onProgress(progress) {
            states.set(outputPath, { status: "building", progress });
          },
        });
        const output = await inspectOutput(partialPath, { signal: controller.signal });
        validateProxyOutput(inspection, output);
        const playback = await inspectPlayback(partialPath, {
          signal: controller.signal,
        });
        validateProxyPlayback(inspection, output, playback);
        await maintenance;
        const releasePublicationLease = acquireLease(outputPath);
        if (!releasePublicationLease) {
          throw new ProxyBuildError(
            "VIDEO_PROXY_FAILED",
            "Proxy output could not be published."
          );
        }
        try {
          await rename(partialPath, outputPath);
          await queueSweep(true, outputPath);
          try {
            const metadata = await stat(outputPath);
            if (metadata.isFile() && metadata.size > 0) {
              states.set(outputPath, { status: "ready", proxyPath: outputPath });
            } else {
              states.delete(outputPath);
            }
          } catch {
            states.delete(outputPath);
          }
        } finally {
          releasePublicationLease();
        }
      } catch (error) {
        const code = error instanceof ProxyBuildError ? error.code : "VIDEO_PROXY_FAILED";
        await remove(partialPath).catch(() => undefined);
        states.set(outputPath, {
          status: code === "FFMPEG_UNAVAILABLE" ? "unavailable" : "failed",
          error: {
            code,
            message: code === "FFMPEG_UNAVAILABLE" ? "Preview proxy is unavailable." : "Preview proxy build failed.",
          },
        });
      } finally {
        activePartials.delete(partialPath);
        jobs.delete(outputPath);
      }
    })();
    jobs.set(outputPath, { controller, promise });
    void promise.catch(() => undefined);
    return states.get(outputPath) ?? { status: "building", progress: 0 };
  };

  return { get, lookup, start, sweep, acquireLease };
}

const PROCESS_CACHE_KEY = Symbol.for("repurpose-studio.video-proxy-cache");
type ProxyGlobal = typeof globalThis & { [PROCESS_CACHE_KEY]?: ProxyCache };

export function getProcessProxyCache(options?: ProxyCacheOptions): ProxyCache {
  const global = globalThis as ProxyGlobal;
  if (!global[PROCESS_CACHE_KEY]) global[PROCESS_CACHE_KEY] = createProxyCache(options);
  return global[PROCESS_CACHE_KEY];
}

export async function getProxyState(
  filePath: string,
  mtimeMs: number,
  size: number
): Promise<ProxyState> {
  if (!PROXYABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return { status: "unavailable" };
  }
  return getProcessProxyCache().lookup({ filePath, mtimeMs, size });
}

export async function startProxyBuild(
  filePath: string,
  mtimeMs: number,
  size: number
): Promise<ProxyState> {
  return getProcessProxyCache().start({ filePath, mtimeMs, size });
}

export function acquireProxyLease(proxyPath: string): (() => void) | null {
  return getProcessProxyCache().acquireLease(proxyPath);
}
