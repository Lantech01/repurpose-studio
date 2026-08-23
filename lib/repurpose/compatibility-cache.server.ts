import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { link, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ffmpegProcessRunner, type CompatibilityEncodeRequest } from "@/lib/repurpose/ffmpeg-process.server";
import { inspectMedia } from "@/lib/repurpose/media-inspection.server";
import type { CompatibilityState, MediaInspection } from "@/lib/repurpose/media-types";

export const COMPATIBILITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const COMPATIBILITY_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
export const COMPATIBILITY_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
export const COMPATIBILITY_CACHE_DIR = path.join(os.tmpdir(), "repurpose-compatible");

const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_PARTIAL_ORPHAN_MS = 60 * 60 * 1_000;
const DEFAULT_CLEANUP_RETRY_ATTEMPTS = 3;
const DEFAULT_CLEANUP_RETRY_DELAY_MS = 40;

export class CompatibilityError extends Error {
  constructor(
    public readonly code: "COMPATIBILITY_VALIDATION_FAILED" | "COMPATIBILITY_ENCODE_FAILED" | "FFMPEG_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "CompatibilityError";
  }
}

function rotationDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return Math.min(delta, 360 - delta);
}

export function validateCompatibilityOutput(input: MediaInspection, output: MediaInspection): void {
  const frameSec = Number.isFinite(input.video.fps) && input.video.fps > 0 ? 1 / input.video.fps : 1 / 30;
  const durationTolerance = Math.max(0.25, frameSec);
  const valid = output.video.codec.toLowerCase() === "h264"
    && output.video.pixelFormat.toLowerCase() === "yuv420p"
    && output.video.width === input.video.width
    && output.video.height === input.video.height
    && rotationDistance(output.video.rotationDeg ?? 0, input.video.rotationDeg ?? 0) <= 0.01 + Number.EPSILON
    && Math.abs(output.durationSec - input.durationSec) <= durationTolerance + Number.EPSILON
    && (!(Number.isFinite(input.video.fps) && input.video.fps > 0)
      || (Number.isFinite(output.video.fps) && output.video.fps > 0
        && Math.abs(output.video.fps - input.video.fps) <= 0.01 + Number.EPSILON))
    && (!input.audio || output.audio?.codec.toLowerCase() === "aac");
  if (!valid) {
    throw new CompatibilityError("COMPATIBILITY_VALIDATION_FAILED", "Converted video failed validation.");
  }
}

interface FileSystemDependencies {
  link: typeof link;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rm: typeof rm;
  stat: (file: string) => Promise<Stats>;
  utimes: typeof utimes;
  writeFile: typeof writeFile;
}

type Encode = (request: CompatibilityEncodeRequest) => Promise<{ encoder: string }>;
type InspectOutput = (mediaPath: string, controls?: { signal?: AbortSignal }) => Promise<MediaInspection>;

export interface CompatibilityCache {
  get: (fingerprint: string) => CompatibilityState;
  start: (input: { originalPath: string; inspection: MediaInspection }) => Promise<CompatibilityState>;
  cancel: (fingerprint: string) => Promise<CompatibilityState>;
  sweep: () => Promise<void>;
}

interface LockOwner {
  fingerprint: string;
  pid: number;
  token: string;
  ownerPath: string;
  lockPath: string;
  partialPath: string;
  terminalPath: string;
  cancelPath: string;
}

interface LockSnapshot {
  owner: LockOwner;
  metadata: Stats;
  terminal: CompatibilityState | null;
}

interface ActiveJob {
  controller: AbortController;
  promise: Promise<void>;
  owner?: LockOwner;
}

type ExistingFinalResult =
  | { kind: "missing" }
  | { kind: "ready"; state: CompatibilityState }
  | { kind: "error"; state: CompatibilityState };

function errorCode(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "COMPATIBILITY_CACHE_ERROR";
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isConclusiveInvalid(error: unknown): boolean {
  const code = errorCode(error);
  return code === "MEDIA_INVALID" || code === "COMPATIBILITY_VALIDATION_FAILED";
}

function safeFailure(error: unknown): CompatibilityState {
  const code = errorCode(error);
  if (code === "FFMPEG_UNAVAILABLE" || code === "FFPROBE_UNAVAILABLE") {
    return { status: "unavailable", progress: null, error: { code, message: "Video conversion is unavailable." } };
  }
  if (code === "MEDIA_PROBE_ABORTED" || code === "COMPATIBILITY_CANCELLED") {
    return { status: "cancelled", progress: null, error: { code, message: "Video conversion was cancelled." } };
  }
  if (code === "COMPATIBILITY_VALIDATION_FAILED") {
    return { status: "failed", progress: null, error: { code, message: "Converted video failed validation." } };
  }
  if (code === "MEDIA_PROBE_TIMEOUT") {
    return { status: "failed", progress: null, error: { code, message: "Converted video inspection timed out." } };
  }
  if (code === "MEDIA_CHANGED") {
    return { status: "failed", progress: null, error: { code, message: "The converted video changed during inspection. Try again." } };
  }
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return { status: "failed", progress: null, error: { code: "COMPATIBILITY_CACHE_BUSY", message: "The compatibility cache is busy. Try again." } };
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

function partialIdentity(name: string): { fingerprint: string; token: string } | null {
  const match = /^\.([a-f0-9]{64})\.\d+\.([A-Za-z0-9-]+)\.partial\.mp4$/.exec(name);
  return match ? { fingerprint: match[1], token: match[2] } : null;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]+$/.test(value);
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
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
  lockPollMs?: number;
  lockStaleMs?: number;
  partialOrphanMs?: number;
  cleanupRetryAttempts?: number;
  cleanupRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pathExists?: (target: string) => boolean;
  isProcessAlive?: (pid: number) => boolean;
} = {}): CompatibilityCache {
  const cacheDir = options.cacheDir ?? COMPATIBILITY_CACHE_DIR;
  const encode = options.encode ?? ((request) => ffmpegProcessRunner.encode(request));
  const inspectOutput = options.inspectOutput ?? ((mediaPath, controls) => inspectMedia(mediaPath, controls));
  const fs: FileSystemDependencies = {
    link,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    utimes,
    writeFile,
    ...options.fileSystem,
  };
  const now = options.now ?? Date.now;
  const makeUuid = options.randomUUID ?? randomUUID;
  const processId = options.processId ?? process.pid;
  const ttlMs = options.ttlMs ?? COMPATIBILITY_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? COMPATIBILITY_CACHE_MAX_BYTES;
  const sweepIntervalMs = options.sweepIntervalMs ?? COMPATIBILITY_SWEEP_INTERVAL_MS;
  const lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const partialOrphanMs = options.partialOrphanMs ?? DEFAULT_PARTIAL_ORPHAN_MS;
  const cleanupRetryAttempts = Math.max(1, options.cleanupRetryAttempts ?? DEFAULT_CLEANUP_RETRY_ATTEMPTS);
  const cleanupRetryDelayMs = Math.max(0, options.cleanupRetryDelayMs ?? DEFAULT_CLEANUP_RETRY_DELAY_MS);
  const sleep = options.sleep ?? sleepFor;
  const pathExists = options.pathExists ?? existsSync;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const states = new Map<string, CompatibilityState>();
  const jobs = new Map<string, ActiveJob>();
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  const finalPathFor = (fingerprint: string) => path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
  const lockPathFor = (fingerprint: string) => path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);

  const ownerFor = (fingerprint: string, token: string): LockOwner => {
    const prefix = `.${fingerprint}.${processId}.${token}`;
    return {
      fingerprint,
      pid: processId,
      token,
      ownerPath: path.join(cacheDir, `${prefix}.owner.json`),
      lockPath: lockPathFor(fingerprint),
      partialPath: path.join(cacheDir, `${prefix}.partial.mp4`),
      terminalPath: path.join(cacheDir, `${prefix}.terminal.json`),
      cancelPath: path.join(cacheDir, `${prefix}.cancel`),
    };
  };

  const ownerFromRecord = (record: unknown, fingerprint: string): LockOwner | null => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const candidate = record as { pid?: unknown; token?: unknown };
    if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0 || !validToken(candidate.token)) return null;
    const pid = candidate.pid as number;
    const token = candidate.token;
    const prefix = `.${fingerprint}.${pid}.${token}`;
    return {
      fingerprint,
      pid,
      token,
      ownerPath: path.join(cacheDir, `${prefix}.owner.json`),
      lockPath: lockPathFor(fingerprint),
      partialPath: path.join(cacheDir, `${prefix}.partial.mp4`),
      terminalPath: path.join(cacheDir, `${prefix}.terminal.json`),
      cancelPath: path.join(cacheDir, `${prefix}.cancel`),
    };
  };

  const cleanup = async (target: string): Promise<boolean> => {
    for (let attempt = 0; attempt < cleanupRetryAttempts; attempt += 1) {
      try {
        await fs.rm(target, { force: true });
        return true;
      } catch (error) {
        if (isMissing(error)) return true;
        if (attempt + 1 === cleanupRetryAttempts) return false;
        await sleep(cleanupRetryDelayMs);
      }
    }
    return false;
  };

  const readTerminal = async (owner: LockOwner): Promise<CompatibilityState | null> => {
    try {
      const parsed = JSON.parse((await fs.readFile(owner.terminalPath, "utf8")).toString()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const state = parsed as CompatibilityState;
      return ["ready", "failed", "cancelled", "unavailable"].includes(state.status) ? state : null;
    } catch {
      return null;
    }
  };

  const readLock = async (fingerprint: string): Promise<LockSnapshot | null> => {
    const lockPath = lockPathFor(fingerprint);
    try {
      const [raw, metadata] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
      const owner = ownerFromRecord(JSON.parse(raw.toString()) as unknown, fingerprint);
      if (!owner) return null;
      return { owner, metadata, terminal: await readTerminal(owner) };
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
  };

  const staleLock = (snapshot: LockSnapshot): boolean => {
    const age = now() - snapshot.metadata.mtimeMs;
    if (age <= lockStaleMs) return false;
    return !isProcessAlive(snapshot.owner.pid) || age > lockStaleMs * 2;
  };

  const reapLock = async (snapshot: LockSnapshot): Promise<boolean> => {
    const reaperPath = path.join(cacheDir, `.${snapshot.owner.fingerprint}.${snapshot.owner.pid}.${snapshot.owner.token}.reaper`);
    try {
      await fs.writeFile(reaperPath, "reaping", { flag: "wx" });
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      return false;
    }
    try {
      const current = await readLock(snapshot.owner.fingerprint);
      if (!current || current.owner.token !== snapshot.owner.token || current.owner.pid !== snapshot.owner.pid) {
        return false;
      }
      await cleanup(snapshot.owner.lockPath);
      await cleanup(snapshot.owner.ownerPath);
      await cleanup(snapshot.owner.terminalPath);
      await cleanup(snapshot.owner.cancelPath);
      return true;
    } finally {
      await cleanup(reaperPath);
    }
  };

  const writeTerminal = async (owner: LockOwner, state: CompatibilityState): Promise<void> => {
    try {
      await fs.writeFile(owner.terminalPath, JSON.stringify(state), { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  };

  const requestCancellation = async (owner: LockOwner): Promise<void> => {
    try {
      await fs.writeFile(owner.cancelPath, "cancel", { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  };

  const acquireLock = async (fingerprint: string): Promise<LockOwner | null> => {
    const owner = ownerFor(fingerprint, makeUuid());
    await fs.writeFile(owner.ownerPath, JSON.stringify({ pid: owner.pid, token: owner.token }), { flag: "wx" });
    try {
      await fs.link(owner.ownerPath, owner.lockPath);
      return owner;
    } catch (error) {
      await cleanup(owner.ownerPath);
      if (isAlreadyExists(error)) return null;
      throw error;
    }
  };

  const ownsLock = async (owner: LockOwner): Promise<boolean> => {
    const current = await readLock(owner.fingerprint);
    return current?.owner.pid === owner.pid && current.owner.token === owner.token;
  };

  const existingFinal = async (
    input: { inspection: MediaInspection },
    removeInvalid: boolean,
  ): Promise<ExistingFinalResult> => {
    const finalPath = finalPathFor(input.inspection.fingerprint);
    let metadata: Stats;
    try {
      metadata = await fs.stat(finalPath);
    } catch (error) {
      if (isMissing(error)) return { kind: "missing" };
      const state = safeFailure(error);
      states.set(input.inspection.fingerprint, state);
      return { kind: "error", state };
    }
    if (!metadata.isFile()) {
      const state = safeFailure(Object.assign(new Error("invalid cache entry"), { code: "EBUSY" }));
      states.set(input.inspection.fingerprint, state);
      return { kind: "error", state };
    }
    try {
      const output = await inspectOutput(finalPath);
      validateCompatibilityOutput(input.inspection, output);
      const timestamp = new Date(now());
      await fs.utimes(finalPath, timestamp, timestamp).catch(() => undefined);
      const state: CompatibilityState = { status: "ready", progress: 1, workingPath: finalPath };
      states.set(input.inspection.fingerprint, state);
      return { kind: "ready", state };
    } catch (error) {
      if (removeInvalid && isConclusiveInvalid(error)) {
        if (await cleanup(finalPath)) {
          states.delete(input.inspection.fingerprint);
          return { kind: "missing" };
        }
      }
      const state = safeFailure(error);
      states.set(input.inspection.fingerprint, state);
      return { kind: "error", state };
    }
  };

  const invalidateFinal = (file: string): void => {
    for (const [fingerprint, state] of states) {
      if (state.status === "ready" && state.workingPath === file) {
        states.set(fingerprint, { status: "none", progress: null });
      }
    }
  };

  const partialIsActive = async (identity: { fingerprint: string; token: string }): Promise<boolean> => {
    const snapshot = await readLock(identity.fingerprint);
    return Boolean(snapshot && snapshot.owner.token === identity.token && !snapshot.terminal && !staleLock(snapshot));
  };

  const sweep = async (): Promise<void> => {
    const sweepAt = now();
    if (sweepAt - lastSweepAt < sweepIntervalMs) return;
    lastSweepAt = sweepAt;
    await fs.mkdir(cacheDir, { recursive: true });
    const names = await fs.readdir(cacheDir);
    const entries: Array<{ path: string; size: number; mtimeMs: number; kind: "final" | "partial"; active: boolean }> = [];
    for (const name of names) {
      const identity = partialIdentity(name);
      if (!isFinalName(name) && !identity) continue;
      const file = path.join(cacheDir, name);
      try {
        const metadata = await fs.stat(file);
        if (!metadata.isFile()) continue;
        const active = identity
          ? await partialIsActive(identity)
          : Boolean((await readLock(name.slice(0, 64)))?.terminal === null);
        entries.push({ path: file, size: metadata.size, mtimeMs: metadata.mtimeMs, kind: identity ? "partial" : "final", active });
      } catch {
        // A concurrent cache operation won the race; a later bounded sweep reconciles it.
      }
    }

    const retained: typeof entries = [];
    for (const entry of entries) {
      const expiredFinal = entry.kind === "final" && sweepAt - entry.mtimeMs > ttlMs;
      const orphanPartial = entry.kind === "partial" && !entry.active && sweepAt - entry.mtimeMs > partialOrphanMs;
      if (!entry.active && (expiredFinal || orphanPartial) && await cleanup(entry.path)) {
        if (entry.kind === "final") invalidateFinal(entry.path);
      } else {
        retained.push(entry);
      }
    }

    let total = retained.reduce((sum, entry) => sum + entry.size, 0);
    const removable = retained.filter((entry) => !entry.active).sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of removable) {
      if (total <= maxBytes) break;
      if (await cleanup(entry.path)) {
        total -= entry.size;
        if (entry.kind === "final") invalidateFinal(entry.path);
      }
    }
  };

  const startOwnerMonitors = (owner: LockOwner, controller: AbortController): (() => void) => {
    const heartbeatMs = Math.max(10, Math.min(2_000, Math.floor(lockStaleMs / 3)));
    const heartbeat = setInterval(() => {
      const timestamp = new Date(now());
      void fs.utimes(owner.ownerPath, timestamp, timestamp).catch(() => undefined);
    }, heartbeatMs);
    const cancellation = setInterval(() => {
      if (pathExists(owner.cancelPath)) controller.abort();
    }, Math.max(2, lockPollMs));
    heartbeat.unref?.();
    cancellation.unref?.();
    return () => {
      clearInterval(heartbeat);
      clearInterval(cancellation);
    };
  };

  const publish = async (owner: LockOwner, input: { inspection: MediaInspection }): Promise<string> => {
    const finalPath = finalPathFor(owner.fingerprint);
    if (!await ownsLock(owner)) {
      throw Object.assign(new Error("compatibility lock lost"), { code: "COMPATIBILITY_LOCK_LOST" });
    }
    try {
      await fs.link(owner.partialPath, finalPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await existingFinal(input, false);
      if (existing.kind === "ready") return finalPath;
      if (existing.kind === "error") {
        throw Object.assign(new Error("existing compatibility master is unavailable"), {
          code: existing.state.error?.code ?? "COMPATIBILITY_CACHE_ERROR",
        });
      }
      throw error;
    }
    return finalPath;
  };

  const runOwner = async (
    input: { originalPath: string; inspection: MediaInspection },
    job: ActiveJob,
    owner: LockOwner,
  ): Promise<void> => {
    const fingerprint = input.inspection.fingerprint;
    job.owner = owner;
    states.set(fingerprint, { status: "building", progress: 0 });
    const stopMonitors = startOwnerMonitors(owner, job.controller);
    try {
      await encode({
        inputPath: input.originalPath,
        outputPath: owner.partialPath,
        inspection: input.inspection,
        signal: job.controller.signal,
        onProgress(progress) {
          if (jobs.get(fingerprint) === job && !job.controller.signal.aborted) {
            const current = states.get(fingerprint)?.progress ?? 0;
            states.set(fingerprint, { status: "building", progress: Math.max(current, Math.min(1, Math.max(0, progress))) });
          }
        },
      });
      if (job.controller.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      const output = await inspectOutput(owner.partialPath, { signal: job.controller.signal });
      validateCompatibilityOutput(input.inspection, output);
      if (job.controller.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      const finalPath = await publish(owner, input);
      const publishedAt = new Date(now());
      await fs.utimes(finalPath, publishedAt, publishedAt).catch(() => undefined);
      await cleanup(owner.partialPath);
      const ready: CompatibilityState = { status: "ready", progress: 1, workingPath: finalPath };
      await writeTerminal(owner, ready).catch(() => undefined);
      if (jobs.get(fingerprint) === job) states.set(fingerprint, ready);
    } catch (error) {
      await cleanup(owner.partialPath);
      const state = job.controller.signal.aborted
        ? { status: "cancelled", progress: null } satisfies CompatibilityState
        : safeFailure(error);
      await writeTerminal(owner, state).catch(() => undefined);
      if (jobs.get(fingerprint) === job) states.set(fingerprint, state);
    } finally {
      stopMonitors();
    }
  };

  const coordinate = async (
    input: { originalPath: string; inspection: MediaInspection },
    job: ActiveJob,
  ): Promise<void> => {
    const fingerprint = input.inspection.fingerprint;
    while (!job.controller.signal.aborted) {
      const final = await existingFinal(input, false);
      if (final.kind === "ready" || final.kind === "error") return;

      const snapshot = await readLock(fingerprint);
      if (!snapshot) {
        const owner = await acquireLock(fingerprint);
        if (owner) {
          await runOwner(input, job, owner);
          return;
        }
        continue;
      }
      job.owner = snapshot.owner;
      if (snapshot.terminal) {
        states.set(fingerprint, snapshot.terminal);
        return;
      }
      if (staleLock(snapshot)) {
        await reapLock(snapshot);
        continue;
      }
      states.set(fingerprint, { status: "building", progress: null });
      await sleep(lockPollMs);
    }
    if (job.owner) await requestCancellation(job.owner).catch(() => undefined);
    states.set(fingerprint, { status: "cancelled", progress: null });
  };

  const prepareLock = async (fingerprint: string): Promise<void> => {
    const snapshot = await readLock(fingerprint);
    if (snapshot && (snapshot.terminal || staleLock(snapshot))) await reapLock(snapshot);
  };

  return {
    get(fingerprint) {
      const state = states.get(fingerprint) ?? { status: "none", progress: null };
      if (state.status === "ready" && state.workingPath && !pathExists(state.workingPath)) {
        const missing: CompatibilityState = { status: "none", progress: null };
        states.set(fingerprint, missing);
        return missing;
      }
      return state;
    },

    async start(input) {
      await fs.mkdir(cacheDir, { recursive: true });
      await sweep();
      const fingerprint = input.inspection.fingerprint;
      const active = jobs.get(fingerprint);
      if (active) return states.get(fingerprint) ?? { status: "queued", progress: null };

      const final = await existingFinal(input, true);
      if (final.kind === "ready" || final.kind === "error") return final.state;
      await prepareLock(fingerprint);

      const raced = jobs.get(fingerprint);
      if (raced) return states.get(fingerprint) ?? { status: "queued", progress: null };
      const job: ActiveJob = { controller: new AbortController(), promise: Promise.resolve() };
      states.set(fingerprint, { status: "queued", progress: null });
      jobs.set(fingerprint, job);
      job.promise = Promise.resolve()
        .then(() => coordinate(input, job))
        .catch((error) => {
          const state = safeFailure(error);
          if (jobs.get(fingerprint) === job) states.set(fingerprint, state);
        })
        .finally(() => {
          if (jobs.get(fingerprint) === job) jobs.delete(fingerprint);
        });
      return states.get(fingerprint)!;
    },

    async cancel(fingerprint) {
      const job = jobs.get(fingerprint);
      const snapshot = await readLock(fingerprint);
      if (snapshot && !snapshot.terminal) await requestCancellation(snapshot.owner).catch(() => undefined);
      if (job) {
        job.controller.abort();
        await job.promise;
      }
      if (snapshot && !snapshot.terminal) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const current = await readLock(fingerprint);
          if (!current || current.terminal) break;
          await sleep(lockPollMs);
        }
      }
      const settled = (await readLock(fingerprint))?.terminal ?? states.get(fingerprint);
      if (settled?.status === "ready" && settled.workingPath && pathExists(settled.workingPath)) {
        states.set(fingerprint, settled);
        return settled;
      }
      const cancelled: CompatibilityState = { status: "cancelled", progress: null };
      states.set(fingerprint, cancelled);
      return cancelled;
    },

    sweep,
  };
}

export const compatibilityCache = createCompatibilityCache();
