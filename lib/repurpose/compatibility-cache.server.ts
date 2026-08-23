import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ffmpegProcessRunner, type CompatibilityEncodeRequest } from "@/lib/repurpose/ffmpeg-process.server";
import { inspectMedia } from "@/lib/repurpose/media-inspection.server";
import type { CompatibilityState, MediaInspection } from "@/lib/repurpose/media-types";

export const COMPATIBILITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const COMPATIBILITY_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
export const COMPATIBILITY_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
export const COMPATIBILITY_CACHE_DIR = path.join(os.tmpdir(), "repurpose-compatible");

export class CompatibilityError extends Error {
  constructor(
    public readonly code: "COMPATIBILITY_VALIDATION_FAILED" | "COMPATIBILITY_ENCODE_FAILED" | "FFMPEG_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "CompatibilityError";
  }
}

export function validateCompatibilityOutput(input: MediaInspection, output: MediaInspection): void {
  const frameSec = Number.isFinite(input.video.fps) && input.video.fps > 0 ? 1 / input.video.fps : 1 / 30;
  const durationTolerance = Math.max(0.25, frameSec);
  const valid = output.video.codec.toLowerCase() === "h264"
    && output.video.pixelFormat.toLowerCase() === "yuv420p"
    && output.video.width === input.video.width
    && output.video.height === input.video.height
    && Math.abs(output.durationSec - input.durationSec) <= durationTolerance + Number.EPSILON
    && (!(Number.isFinite(input.video.fps) && input.video.fps > 0)
      || (Number.isFinite(output.video.fps) && output.video.fps > 0 && Math.abs(output.video.fps - input.video.fps) <= 0.01 + Number.EPSILON))
    && (!input.audio || output.audio?.codec.toLowerCase() === "aac");
  if (!valid) {
    throw new CompatibilityError("COMPATIBILITY_VALIDATION_FAILED", "Converted video failed validation.");
  }
}

interface FileSystemDependencies {
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  rename: typeof rename;
  rm: typeof rm;
  stat: (file: string) => Promise<Stats>;
  utimes: typeof utimes;
}

type Encode = (request: CompatibilityEncodeRequest) => Promise<{ encoder: string }>;
type InspectOutput = (mediaPath: string, controls?: { signal?: AbortSignal }) => Promise<MediaInspection>;

export interface CompatibilityCache {
  get: (fingerprint: string) => CompatibilityState;
  start: (input: { originalPath: string; inspection: MediaInspection }) => Promise<CompatibilityState>;
  cancel: (fingerprint: string) => Promise<CompatibilityState>;
  sweep: () => Promise<void>;
}

interface ActiveJob {
  controller: AbortController;
  partialPath: string;
  promise: Promise<void>;
}

function safeFailure(error: unknown): CompatibilityState {
  const code = (error as { code?: unknown }).code;
  if (code === "FFMPEG_UNAVAILABLE") {
    return { status: "unavailable", progress: null, error: { code, message: "Video conversion is unavailable." } };
  }
  if (code === "COMPATIBILITY_VALIDATION_FAILED") {
    return { status: "failed", progress: null, error: { code, message: "Converted video failed validation." } };
  }
  return {
    status: "failed",
    progress: null,
    error: { code: "COMPATIBILITY_ENCODE_FAILED", message: "Video conversion failed." },
  };
}

function isFinalName(name: string): boolean {
  return /^[a-f0-9]{64}-compat-v1\.mp4$/.test(name);
}

export function createCompatibilityCache(options: {
  cacheDir?: string;
  encode?: Encode;
  inspectOutput?: InspectOutput;
  fileSystem?: Partial<FileSystemDependencies>;
  now?: () => number;
  randomUUID?: () => string;
  processId?: number;
  ttlMs?: number;
  maxBytes?: number;
  sweepIntervalMs?: number;
} = {}): CompatibilityCache {
  const cacheDir = options.cacheDir ?? COMPATIBILITY_CACHE_DIR;
  const encode = options.encode ?? ((request) => ffmpegProcessRunner.encode(request));
  const inspectOutput = options.inspectOutput ?? ((mediaPath, controls) => inspectMedia(mediaPath, controls));
  const fs: FileSystemDependencies = {
    mkdir,
    readdir,
    rename,
    rm,
    stat,
    utimes,
    ...options.fileSystem,
  };
  const now = options.now ?? Date.now;
  const makeUuid = options.randomUUID ?? randomUUID;
  const processId = options.processId ?? process.pid;
  const ttlMs = options.ttlMs ?? COMPATIBILITY_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? COMPATIBILITY_CACHE_MAX_BYTES;
  const sweepIntervalMs = options.sweepIntervalMs ?? COMPATIBILITY_SWEEP_INTERVAL_MS;
  const states = new Map<string, CompatibilityState>();
  const jobs = new Map<string, ActiveJob>();
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  const finalPathFor = (fingerprint: string) => path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);

  const sweep = async (): Promise<void> => {
    const sweepAt = now();
    if (sweepAt - lastSweepAt < sweepIntervalMs) return;
    lastSweepAt = sweepAt;
    await fs.mkdir(cacheDir, { recursive: true });
    const names = await fs.readdir(cacheDir);
    const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      if (!isFinalName(name)) continue;
      const file = path.join(cacheDir, name);
      try {
        const metadata = await fs.stat(file);
        if (metadata.isFile()) entries.push({ path: file, size: metadata.size, mtimeMs: metadata.mtimeMs });
      } catch {
        // A concurrent cache operation won the race; the next bounded sweep reconciles it.
      }
    }
    const retained: typeof entries = [];
    for (const entry of entries) {
      if (sweepAt - entry.mtimeMs > ttlMs) {
        await fs.rm(entry.path, { force: true }).catch(() => undefined);
      } else {
        retained.push(entry);
      }
    }
    retained.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let total = retained.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of retained) {
      if (total <= maxBytes) break;
      await fs.rm(entry.path, { force: true }).catch(() => undefined);
      total -= entry.size;
    }
  };

  const runJob = async (
    fingerprint: string,
    input: { originalPath: string; inspection: MediaInspection },
    job: ActiveJob,
  ): Promise<void> => {
    const finalPath = finalPathFor(fingerprint);
    states.set(fingerprint, { status: "building", progress: 0 });
    try {
      await encode({
        inputPath: input.originalPath,
        outputPath: job.partialPath,
        inspection: input.inspection,
        signal: job.controller.signal,
        onProgress(progress) {
          if (jobs.get(fingerprint) === job && !job.controller.signal.aborted) {
            states.set(fingerprint, { status: "building", progress: Math.min(1, Math.max(0, progress)) });
          }
        },
      });
      if (job.controller.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      const output = await inspectOutput(job.partialPath, { signal: job.controller.signal });
      validateCompatibilityOutput(input.inspection, output);
      if (job.controller.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      await fs.rename(job.partialPath, finalPath);
      if (job.controller.signal.aborted) {
        await fs.rm(finalPath, { force: true }).catch(() => undefined);
        throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      }
      if (jobs.get(fingerprint) === job) {
        states.set(fingerprint, { status: "ready", progress: 1, workingPath: finalPath });
      }
    } catch (error) {
      await fs.rm(job.partialPath, { force: true }).catch(() => undefined);
      if (jobs.get(fingerprint) === job) {
        if (job.controller.signal.aborted || (error as { code?: unknown }).code === "COMPATIBILITY_CANCELLED") {
          states.set(fingerprint, { status: "cancelled", progress: null });
        } else {
          states.set(fingerprint, safeFailure(error));
        }
      }
    } finally {
      if (jobs.get(fingerprint) === job) jobs.delete(fingerprint);
    }
  };

  return {
    get(fingerprint) {
      return states.get(fingerprint) ?? { status: "none", progress: null };
    },

    async start(input) {
      await fs.mkdir(cacheDir, { recursive: true });
      await sweep();
      const fingerprint = input.inspection.fingerprint;
      const active = jobs.get(fingerprint);
      if (active) return states.get(fingerprint) ?? { status: "queued", progress: null };

      const finalPath = finalPathFor(fingerprint);
      try {
        const metadata = await fs.stat(finalPath);
        if (metadata.isFile()) {
          const output = await inspectOutput(finalPath);
          validateCompatibilityOutput(input.inspection, output);
          const timestamp = new Date(now());
          await fs.utimes(finalPath, timestamp, timestamp).catch(() => undefined);
          const ready: CompatibilityState = { status: "ready", progress: 1, workingPath: finalPath };
          states.set(fingerprint, ready);
          return ready;
        }
      } catch {
        await fs.rm(finalPath, { force: true }).catch(() => undefined);
      }

      const raced = jobs.get(fingerprint);
      if (raced) return states.get(fingerprint) ?? { status: "queued", progress: null };
      const partialPath = path.join(cacheDir, `.${fingerprint}.${processId}.${makeUuid()}.partial.mp4`);
      const job: ActiveJob = { controller: new AbortController(), partialPath, promise: Promise.resolve() };
      states.set(fingerprint, { status: "queued", progress: null });
      jobs.set(fingerprint, job);
      job.promise = Promise.resolve().then(() => runJob(fingerprint, input, job));
      return states.get(fingerprint)!;
    },

    async cancel(fingerprint) {
      const job = jobs.get(fingerprint);
      if (!job) return states.get(fingerprint) ?? { status: "none", progress: null };
      states.set(fingerprint, { status: "cancelled", progress: null });
      job.controller.abort();
      await job.promise;
      await fs.rm(job.partialPath, { force: true }).catch(() => undefined);
      return { status: "cancelled", progress: null };
    },

    sweep,
  };
}

export const compatibilityCache = createCompatibilityCache();
