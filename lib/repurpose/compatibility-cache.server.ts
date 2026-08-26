import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
const MAX_INTERNAL_STATE_BYTES = 64 * 1024;
const MAX_OWNER_DESCRIPTOR_BYTES = 4 * 1024;

export class CompatibilityError extends Error {
  constructor(
    public readonly code: "COMPATIBILITY_VALIDATION_FAILED" | "COMPATIBILITY_ENCODE_FAILED" | "FFMPEG_UNAVAILABLE" | "COMPATIBILITY_CACHE_BUSY",
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
  // ffprobe may report a timestamp-derived average (for example 59.9666) for
  // the source and the nominal rate (60) after ffmpeg preserves every frame.
  const frameRateTolerance = Math.max(0.01, input.video.fps * 0.001);
  const valid = output.video.codec.toLowerCase() === "h264"
    && output.video.pixelFormat.toLowerCase() === "yuv420p"
    && output.video.width === input.video.width
    && output.video.height === input.video.height
    && rotationDistance(output.video.rotationDeg ?? 0, input.video.rotationDeg ?? 0) <= 0.01 + Number.EPSILON
    && Math.abs(output.durationSec - input.durationSec) <= durationTolerance + Number.EPSILON
    && (!(Number.isFinite(input.video.fps) && input.video.fps > 0)
      || (Number.isFinite(output.video.fps) && output.video.fps > 0
        && Math.abs(output.video.fps - input.video.fps) <= frameRateTolerance + Number.EPSILON))
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

interface SyncFileSystemDependencies {
  readFile: typeof readFileSync;
  stat: typeof statSync;
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

type LockInspection =
  | { kind: "absent" }
  | { kind: "invalid"; lockPath: string; metadata: Stats }
  | { kind: "owned"; snapshot: LockSnapshot };

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
  if (code === "COMPATIBILITY_CACHE_BUSY") {
    return {
      status: "failed",
      progress: null,
      error: {
        code,
        message: "Another live server owns this compatibility cache. Restart the server or use a separate cache directory.",
      },
    };
  }
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
    return {
      status: "failed",
      progress: null,
      error: { code: "COMPATIBILITY_CACHE_BUSY", message: "The compatibility cache is busy. Restart the server and try again." },
    };
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

interface GenerationIdentity {
  fingerprint: string;
  pid: number;
  token: string;
}

function generationMetadataIdentity(name: string): GenerationIdentity | null {
  const match = /^\.([a-f0-9]{64})\.([1-9]\d*)\.([A-Za-z0-9-]+)\.(?:owner\.json|terminal\.json|cancel)$/.exec(name);
  if (!match) return null;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) ? { fingerprint: match[1], pid, token: match[3] } : null;
}

function generationIdentityKey(identity: GenerationIdentity): string {
  return `${identity.fingerprint}.${identity.pid}.${identity.token}`;
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
  syncFileSystem?: Partial<SyncFileSystemDependencies>;
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
  const syncFs: SyncFileSystemDependencies = {
    readFile: readFileSync,
    stat: statSync,
    ...options.syncFileSystem,
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
  const recoveryFailureBackoffMs = Math.max(100, Math.min(1_000, lockPollMs * 10));
  const sleep = options.sleep ?? sleepFor;
  const pathExists = options.pathExists ?? existsSync;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const states = new Map<string, CompatibilityState>();
  const jobs = new Map<string, ActiveJob>();
  const recoveries = new Map<string, Promise<boolean>>();
  const recoveryRetryAt = new Map<string, number>();
  const localGenerations = new Set<string>();
  const sharedBuildingUntil = new Map<string, number>();
  const sharedBuildingTtlMs = Math.max(10, Math.min(250, lockPollMs));
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  const finalPathFor = (fingerprint: string) => path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
  const lockPathFor = (fingerprint: string) => path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);

  const ownerForGeneration = (fingerprint: string, pid: number, token: string): LockOwner => {
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

  const ownerFor = (fingerprint: string, token: string): LockOwner => (
    ownerForGeneration(fingerprint, processId, token)
  );

  const ownerFromRecord = (record: unknown, fingerprint: string): LockOwner | null => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const candidate = record as { pid?: unknown; token?: unknown };
    if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0 || !validToken(candidate.token)) return null;
    return ownerForGeneration(fingerprint, candidate.pid as number, candidate.token);
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
      const metadata = await fs.stat(owner.terminalPath);
      if (!metadata.isFile() || metadata.size > MAX_INTERNAL_STATE_BYTES) return null;
      const parsed = JSON.parse((await fs.readFile(owner.terminalPath, "utf8")).toString()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const state = parsed as CompatibilityState;
      return ["ready", "failed", "cancelled", "unavailable"].includes(state.status) ? state : null;
    } catch {
      return null;
    }
  };

  const inspectLock = async (fingerprint: string): Promise<LockInspection> => {
    const lockPath = lockPathFor(fingerprint);
    let metadata: Stats;
    try {
      metadata = await fs.stat(lockPath);
    } catch (error) {
      if (isMissing(error)) return { kind: "absent" };
      throw error;
    }
    if (!metadata.isFile() || metadata.size > MAX_OWNER_DESCRIPTOR_BYTES) {
      return { kind: "invalid", lockPath, metadata };
    }
    try {
      const raw = await fs.readFile(lockPath, "utf8");
      const owner = ownerFromRecord(JSON.parse(raw.toString()) as unknown, fingerprint);
      if (!owner) return { kind: "invalid", lockPath, metadata };
      return { kind: "owned", snapshot: { owner, metadata, terminal: await readTerminal(owner) } };
    } catch (error) {
      if (isMissing(error)) return { kind: "absent" };
      if (error instanceof SyntaxError) return { kind: "invalid", lockPath, metadata };
      throw error;
    }
  };

  const readLock = async (fingerprint: string): Promise<LockSnapshot | null> => {
    const inspected = await inspectLock(fingerprint);
    return inspected.kind === "owned" ? inspected.snapshot : null;
  };

  const sameOwner = (left: LockOwner, right: LockOwner): boolean => (
    left.pid === right.pid && left.token === right.token
  );

  const removeOwnedLock = async (owner: LockOwner): Promise<boolean> => {
    const current = await readLock(owner.fingerprint);
    if (!current || !sameOwner(current.owner, owner)) return false;
    return cleanup(owner.lockPath);
  };

  const recoverInspection = async (inspection: LockInspection): Promise<boolean> => {
    if (inspection.kind === "absent") return true;
    if (inspection.kind === "owned") {
      const { owner, terminal } = inspection.snapshot;
      const localOwner = jobs.get(owner.fingerprint)?.owner;
      if ((localOwner && sameOwner(localOwner, owner))
        || localGenerations.has(generationIdentityKey(owner))) {
        return false;
      }
      if (!terminal && owner.pid !== processId && isProcessAlive(owner.pid)) return false;
      if (!await removeOwnedLock(owner)) return false;
      await cleanup(owner.ownerPath);
      await cleanup(owner.terminalPath);
      await cleanup(owner.cancelPath);
      await cleanup(owner.partialPath);
      return true;
    }
    return cleanup(inspection.lockPath);
  };

  const recoverFingerprint = (fingerprint: string): Promise<boolean> => {
    const active = recoveries.get(fingerprint);
    if (active) return active;
    const retryAt = recoveryRetryAt.get(fingerprint);
    if (retryAt !== undefined) {
      if (now() < retryAt) return Promise.resolve(false);
      recoveryRetryAt.delete(fingerprint);
    }
    let recovery!: Promise<boolean>;
    recovery = (async () => {
      try {
        const recovered = await recoverInspection(await inspectLock(fingerprint));
        if (recovered) recoveryRetryAt.delete(fingerprint);
        else recoveryRetryAt.set(fingerprint, now() + recoveryFailureBackoffMs);
        return recovered;
      } catch (error) {
        recoveryRetryAt.set(fingerprint, now() + recoveryFailureBackoffMs);
        throw error;
      } finally {
        if (recoveries.get(fingerprint) === recovery) recoveries.delete(fingerprint);
      }
    })();
    recoveries.set(fingerprint, recovery);
    return recovery;
  };

  const scheduleRecovery = (fingerprint: string): void => {
    void recoverFingerprint(fingerprint).catch(() => undefined);
  };

  const recoveryFailureState = (fingerprint: string): CompatibilityState | null => {
    const retryAt = recoveryRetryAt.get(fingerprint);
    if (retryAt === undefined) return null;
    if (now() >= retryAt) {
      recoveryRetryAt.delete(fingerprint);
      return null;
    }
    return safeFailure(new CompatibilityError("COMPATIBILITY_CACHE_BUSY", "cache recovery is temporarily blocked"));
  };

  const readSharedState = (fingerprint: string): CompatibilityState | null => {
    const finalPath = finalPathFor(fingerprint);
    try {
      const lockPath = lockPathFor(fingerprint);
      const metadata = syncFs.stat(lockPath);
      if (!metadata.isFile() || metadata.size > MAX_OWNER_DESCRIPTOR_BYTES) {
        const failure = recoveryFailureState(fingerprint);
        if (failure) return failure;
        scheduleRecovery(fingerprint);
        return null;
      }
      const owner = ownerFromRecord(JSON.parse(syncFs.readFile(lockPath, "utf8")) as unknown, fingerprint);
      if (!owner) {
        const failure = recoveryFailureState(fingerprint);
        if (failure) return failure;
        scheduleRecovery(fingerprint);
        return null;
      }
      try {
        const terminalMetadata = syncFs.stat(owner.terminalPath);
        if (!terminalMetadata.isFile() || terminalMetadata.size > MAX_INTERNAL_STATE_BYTES) {
          throw new Error("invalid compatibility terminal state");
        }
        const terminal = JSON.parse(syncFs.readFile(owner.terminalPath, "utf8")) as CompatibilityState;
        if (terminal.status === "ready") {
          try {
            if (syncFs.stat(finalPath).isFile()) {
              return { status: "ready", progress: 1, workingPath: finalPath };
            }
          } catch {
            return { status: "none", progress: null };
          }
          return { status: "none", progress: null };
        }
        if (["failed", "cancelled", "unavailable"].includes(terminal.status)) return terminal;
      } catch {
        // A fresh live owner may not have written its terminal state yet.
      }
      const snapshot: LockSnapshot = { owner, metadata, terminal: null };
      if (!isProcessAlive(owner.pid)) {
        scheduleRecovery(fingerprint);
        return { status: "none", progress: null };
      }
      if (now() - metadata.mtimeMs > lockStaleMs) {
        return safeFailure(new CompatibilityError("COMPATIBILITY_CACHE_BUSY", "live compatibility owner is stale"));
      }
      return { status: "building", progress: null };
    } catch (error) {
      if (!isMissing(error)) {
        const failure = recoveryFailureState(fingerprint);
        if (failure) return failure;
        scheduleRecovery(fingerprint);
        return null;
      }
    }

    return null;
  };

  const reapLock = async (snapshot: LockSnapshot): Promise<boolean> => {
    if (!snapshot.terminal && isProcessAlive(snapshot.owner.pid)) return false;
    return recoverFingerprint(snapshot.owner.fingerprint);
  };

  const writeTerminal = async (owner: LockOwner, state: CompatibilityState): Promise<void> => {
    try {
      await fs.writeFile(owner.terminalPath, JSON.stringify(state), { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  };

  const acquireLock = async (fingerprint: string): Promise<LockOwner> => {
    const pendingRecovery = recoveries.get(fingerprint);
    if (pendingRecovery) await pendingRecovery;
    const owner = ownerFor(fingerprint, makeUuid());
    const generationKey = generationIdentityKey(owner);
    localGenerations.add(generationKey);
    let acquired = false;
    try {
      await fs.writeFile(owner.ownerPath, JSON.stringify({ pid: owner.pid, token: owner.token }), { flag: "wx" });
      try {
        try {
          await fs.link(owner.ownerPath, owner.lockPath);
          acquired = true;
          return owner;
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }

        if (!await recoverFingerprint(fingerprint)) {
          throw new CompatibilityError("COMPATIBILITY_CACHE_BUSY", "a live server owns the compatibility cache");
        }
        try {
          await fs.link(owner.ownerPath, owner.lockPath);
          acquired = true;
          return owner;
        } catch (error) {
          if (isAlreadyExists(error)) {
            throw new CompatibilityError("COMPATIBILITY_CACHE_BUSY", "compatibility cache ownership changed during recovery");
          }
          throw error;
        }
      } finally {
        if (!acquired) await cleanup(owner.ownerPath);
      }
    } finally {
      if (!acquired) localGenerations.delete(generationKey);
    }
  };

  const releaseLock = async (owner: LockOwner): Promise<boolean> => {
    try {
      if (!await removeOwnedLock(owner)) return false;
      await cleanup(owner.ownerPath);
      await cleanup(owner.terminalPath);
      await cleanup(owner.cancelPath);
      await cleanup(owner.partialPath);
      return true;
    } finally {
      localGenerations.delete(generationIdentityKey(owner));
    }
  };

  const ownsLock = async (owner: LockOwner): Promise<boolean> => {
    const current = await readLock(owner.fingerprint);
    return Boolean(current && sameOwner(current.owner, owner));
  };

  const startHeartbeat = (owner: LockOwner): (() => void) => {
    const heartbeatMs = Math.max(10, Math.min(2_000, Math.floor(lockStaleMs / 3)));
    const heartbeat = setInterval(() => {
      const timestamp = new Date(now());
      void fs.utimes(owner.ownerPath, timestamp, timestamp).catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref?.();
    return () => clearInterval(heartbeat);
  };

  const existingFinal = async (
    input: { inspection: MediaInspection },
    removeInvalid: boolean,
    signal?: AbortSignal,
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
      if (signal?.aborted) {
        throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      }
      const output = await inspectOutput(finalPath, { signal });
      if (signal?.aborted) {
        throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      }
      validateCompatibilityOutput(input.inspection, output);
      const timestamp = new Date(now());
      await fs.utimes(finalPath, timestamp, timestamp).catch(() => undefined);
      if (signal?.aborted) {
        throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      }
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
    const localOwner = jobs.get(identity.fingerprint)?.owner;
    if (localOwner?.token === identity.token) return true;
    const snapshot = await readLock(identity.fingerprint);
    return Boolean(snapshot
      && snapshot.owner.token === identity.token
      && !snapshot.terminal
      && isProcessAlive(snapshot.owner.pid));
  };

  const finalIsActive = async (fingerprint: string): Promise<boolean> => {
    if (jobs.has(fingerprint)) return true;
    const snapshot = await readLock(fingerprint);
    if (!snapshot || snapshot.terminal) return false;
    if (isProcessAlive(snapshot.owner.pid)) return true;
    await reapLock(snapshot);
    const current = await readLock(fingerprint);
    return Boolean(current && !current.terminal);
  };

  interface SweepEntry {
    path: string;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    kind: "final" | "partial";
    active: boolean;
  }

  const removeClaimedFinal = async (owner: LockOwner, entry: SweepEntry): Promise<boolean> => {
    for (let attempt = 0; attempt < cleanupRetryAttempts; attempt += 1) {
      let current: Stats;
      try {
        current = await fs.stat(entry.path);
      } catch (error) {
        return isMissing(error);
      }
      if (!current.isFile()
        || current.dev !== entry.dev
        || current.ino !== entry.ino
        || current.size !== entry.size
        || current.mtimeMs !== entry.mtimeMs
        || !await ownsLock(owner)) {
        return false;
      }
      try {
        await fs.rm(entry.path, { force: true });
        return true;
      } catch (error) {
        if (isMissing(error)) return true;
        if (attempt + 1 === cleanupRetryAttempts) return false;
        await sleep(cleanupRetryDelayMs);
      }
    }
    return false;
  };

  const evictFinal = async (entry: SweepEntry): Promise<boolean> => {
    const fingerprint = path.basename(entry.path).slice(0, 64);
    if (jobs.has(fingerprint)) return false;
    const snapshot = await readLock(fingerprint);
    if (snapshot) {
      if (!snapshot.terminal && isProcessAlive(snapshot.owner.pid)) return false;
      await reapLock(snapshot);
      if (await readLock(fingerprint)) return false;
    }
    let claim: LockOwner;
    try {
      claim = await acquireLock(fingerprint);
    } catch {
      return false;
    }
    let stopHeartbeat: (() => void) | undefined;
    try {
      stopHeartbeat = startHeartbeat(claim);
      return await removeClaimedFinal(claim, entry);
    } finally {
      stopHeartbeat?.();
      await releaseLock(claim);
    }
  };

  const removeSweepEntry = async (entry: SweepEntry): Promise<boolean> => {
    if (entry.kind === "final") return evictFinal(entry);
    const identity = partialIdentity(path.basename(entry.path));
    if (identity && await partialIsActive(identity)) return false;
    return cleanup(entry.path);
  };

  const removeOrphanMetadata = async (identity: GenerationIdentity, file: string): Promise<void> => {
    const generationKey = generationIdentityKey(identity);
    const owner = ownerForGeneration(identity.fingerprint, identity.pid, identity.token);
    const activeLocally = () => {
      const localOwner = jobs.get(identity.fingerprint)?.owner;
      return localGenerations.has(generationKey)
        || Boolean(localOwner && sameOwner(localOwner, owner));
    };
    for (let attempt = 0; attempt < cleanupRetryAttempts; attempt += 1) {
      if (activeLocally()) return;
      const current = await inspectLock(identity.fingerprint);
      if (current.kind === "owned" && sameOwner(current.snapshot.owner, owner)) return;
      if (activeLocally()) return;
      try {
        await fs.rm(file, { force: true });
        return;
      } catch (error) {
        if (isMissing(error)) return;
        if (attempt + 1 === cleanupRetryAttempts) return;
        await sleep(cleanupRetryDelayMs);
      }
    }
  };

  const reconcileGenerationMetadata = async (names: string[]): Promise<void> => {
    const generations = new Map<string, { identity: GenerationIdentity; files: string[] }>();
    for (const name of names) {
      const identity = generationMetadataIdentity(name);
      if (!identity) continue;
      const key = generationIdentityKey(identity);
      const generation = generations.get(key) ?? { identity, files: [] };
      generation.files.push(path.join(cacheDir, name));
      generations.set(key, generation);
    }
    for (const generation of generations.values()) {
      for (const file of generation.files) {
        await removeOrphanMetadata(generation.identity, file);
      }
    }
  };

  const sweep = async (): Promise<void> => {
    const sweepAt = now();
    if (sweepAt - lastSweepAt < sweepIntervalMs) return;
    lastSweepAt = sweepAt;
    await fs.mkdir(cacheDir, { recursive: true });
    const names = await fs.readdir(cacheDir);
    await reconcileGenerationMetadata(names);
    for (const name of names) {
      const match = /^\.([a-f0-9]{64})\.compat-v1\.lock$/.exec(name);
      if (!match) continue;
      const fingerprint = match[1];
      const inspection = await inspectLock(fingerprint);
      if (inspection.kind === "owned") {
        const localOwner = jobs.get(fingerprint)?.owner;
        if ((localOwner && sameOwner(localOwner, inspection.snapshot.owner))
          || localGenerations.has(generationIdentityKey(inspection.snapshot.owner))) continue;
        if (!inspection.snapshot.terminal && isProcessAlive(inspection.snapshot.owner.pid)) {
          states.set(fingerprint, safeFailure(new CompatibilityError("COMPATIBILITY_CACHE_BUSY", "live cache owner blocks maintenance")));
          return;
        }
      }
      await recoverFingerprint(fingerprint);
    }
    const entries: SweepEntry[] = [];
    for (const name of names) {
      const identity = partialIdentity(name);
      if (!isFinalName(name) && !identity) continue;
      const file = path.join(cacheDir, name);
      try {
        const metadata = await fs.stat(file);
        if (!metadata.isFile()) continue;
        const active = identity
          ? await partialIsActive(identity)
          : await finalIsActive(name.slice(0, 64));
        entries.push({
          path: file,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          dev: metadata.dev,
          ino: metadata.ino,
          kind: identity ? "partial" : "final",
          active,
        });
      } catch {
        // A concurrent cache operation won the race; a later bounded sweep reconciles it.
      }
    }

    const retained: typeof entries = [];
    for (const entry of entries) {
      const expiredFinal = entry.kind === "final" && sweepAt - entry.mtimeMs > ttlMs;
      const orphanPartial = entry.kind === "partial" && !entry.active && sweepAt - entry.mtimeMs > partialOrphanMs;
      const removed = !entry.active && (expiredFinal || orphanPartial)
        ? await removeSweepEntry(entry)
        : false;
      if (removed) {
        if (entry.kind === "final") invalidateFinal(entry.path);
      } else {
        retained.push(entry);
      }
    }

    let total = retained.reduce((sum, entry) => sum + entry.size, 0);
    const removable = retained.filter((entry) => !entry.active).sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of removable) {
      if (total <= maxBytes) break;
      const removed = await removeSweepEntry(entry);
      if (removed) {
        total -= entry.size;
        if (entry.kind === "final") invalidateFinal(entry.path);
      }
    }
  };

  const startOwnerMonitors = (owner: LockOwner, controller: AbortController): (() => void) => {
    const stopHeartbeat = startHeartbeat(owner);
    const cancellation = setInterval(() => {
      if (pathExists(owner.cancelPath)) controller.abort();
    }, Math.max(2, lockPollMs));
    cancellation.unref?.();
    return () => {
      stopHeartbeat();
      clearInterval(cancellation);
    };
  };

  const removePublishedLink = async (owner: LockOwner, finalPath: string): Promise<boolean> => {
    for (let attempt = 0; attempt < cleanupRetryAttempts; attempt += 1) {
      let partialMetadata: Stats;
      let finalMetadata: Stats;
      try {
        [partialMetadata, finalMetadata] = await Promise.all([
          fs.stat(owner.partialPath),
          fs.stat(finalPath),
        ]);
      } catch (error) {
        return isMissing(error);
      }
      if (!partialMetadata.isFile()
        || !finalMetadata.isFile()
        || partialMetadata.dev !== finalMetadata.dev
        || partialMetadata.ino !== finalMetadata.ino
        || !await ownsLock(owner)) {
        return false;
      }
      try {
        await fs.rm(finalPath, { force: true });
        return true;
      } catch (error) {
        if (isMissing(error)) return true;
        if (attempt + 1 === cleanupRetryAttempts) return false;
        await sleep(cleanupRetryDelayMs);
      }
    }
    return false;
  };

  const publish = async (
    owner: LockOwner,
    input: { inspection: MediaInspection },
    signal: AbortSignal,
  ): Promise<string> => {
    const finalPath = finalPathFor(owner.fingerprint);
    if (!await ownsLock(owner)) {
      throw Object.assign(new Error("compatibility lock lost"), { code: "COMPATIBILITY_LOCK_LOST" });
    }
    if (signal.aborted) {
      throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
    }
    try {
      await fs.link(owner.partialPath, finalPath);
      if (signal.aborted) {
        await removePublishedLink(owner, finalPath);
        throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await existingFinal(input, false, signal);
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
      const finalPath = await publish(owner, input, job.controller.signal);
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

  return {
    get(fingerprint) {
      const local = states.get(fingerprint);
      if (jobs.has(fingerprint) && local) {
        if (local.status === "ready" && local.workingPath && !pathExists(local.workingPath)) {
          const missing: CompatibilityState = { status: "none", progress: null };
          states.set(fingerprint, missing);
          return missing;
        }
        return local;
      }
      const buildingUntil = sharedBuildingUntil.get(fingerprint);
      if (buildingUntil !== undefined && now() < buildingUntil) {
        return { status: "building", progress: null };
      }
      if (buildingUntil !== undefined) sharedBuildingUntil.delete(fingerprint);
      const shared = readSharedState(fingerprint);
      if (shared?.status === "building") {
        sharedBuildingUntil.set(fingerprint, now() + sharedBuildingTtlMs);
      }
      const state = shared ?? local ?? { status: "none", progress: null };
      if (state.status === "ready" && state.workingPath && !pathExists(state.workingPath)) {
        const missing: CompatibilityState = { status: "none", progress: null };
        states.set(fingerprint, missing);
        return missing;
      }
      return state;
    },

    async start(input) {
      const fingerprint = input.inspection.fingerprint;
      sharedBuildingUntil.delete(fingerprint);
      const active = jobs.get(fingerprint);
      if (active) {
        const current = states.get(fingerprint) ?? { status: "queued", progress: null } satisfies CompatibilityState;
        if (active.controller.signal.aborted && current.status !== "ready") {
          const cancelled: CompatibilityState = { status: "cancelled", progress: null };
          states.set(fingerprint, cancelled);
          return cancelled;
        }
        return current;
      }

      const job: ActiveJob = { controller: new AbortController(), promise: Promise.resolve() };
      const queued: CompatibilityState = { status: "queued", progress: null };
      states.set(fingerprint, queued);
      jobs.set(fingerprint, job);
      let initialized = false;
      let resolveInitialization!: (state: CompatibilityState) => void;
      const initialization = new Promise<CompatibilityState>((resolve) => {
        resolveInitialization = resolve;
      });
      const settleInitialization = (state: CompatibilityState): void => {
        if (initialized) return;
        initialized = true;
        resolveInitialization(state);
      };
      const cancelState = (): CompatibilityState => {
        const cancelled: CompatibilityState = { status: "cancelled", progress: null };
        states.set(fingerprint, cancelled);
        settleInitialization(cancelled);
        return cancelled;
      };

      job.promise = (async () => {
        let claim: LockOwner | undefined;
        try {
          await fs.mkdir(cacheDir, { recursive: true });
          if (job.controller.signal.aborted) {
            cancelState();
            return;
          }
          await sweep();
          if (job.controller.signal.aborted) {
            cancelState();
            return;
          }
          claim = await acquireLock(fingerprint);
          job.owner = claim;
          if (job.controller.signal.aborted) {
            cancelState();
            return;
          }
          const final = await existingFinal(input, true, job.controller.signal);
          if (final.kind === "ready" || final.kind === "error") {
            settleInitialization(final.state);
            return;
          }
          if (job.controller.signal.aborted) {
            cancelState();
            return;
          }
          settleInitialization(queued);
          await Promise.resolve();
          if (job.controller.signal.aborted) {
            cancelState();
            return;
          }
          await runOwner(input, job, claim);
        } catch (error) {
          const state = job.controller.signal.aborted
            ? cancelState()
            : safeFailure(error);
          states.set(fingerprint, state);
          settleInitialization(state);
        } finally {
          if (claim) await releaseLock(claim);
        }
      })()
        .catch((error) => {
          const state = job.controller.signal.aborted
            ? cancelState()
            : safeFailure(error);
          if (jobs.get(fingerprint) === job) states.set(fingerprint, state);
          settleInitialization(state);
        })
        .finally(() => {
          if (jobs.get(fingerprint) === job) jobs.delete(fingerprint);
        });

      const initial = await initialization;
      if (initial.status === "queued" || initial.status === "building") return initial;
      await job.promise;
      return states.get(fingerprint) ?? initial;
    },

    async cancel(fingerprint) {
      const job = jobs.get(fingerprint);
      let recoveryBlocked = false;
      if (job) {
        job.controller.abort();
        if (states.get(fingerprint)?.status !== "ready") {
          states.set(fingerprint, { status: "cancelled", progress: null });
        }
        await job.promise;
      } else {
        try {
          const inspection = await inspectLock(fingerprint);
          if (inspection.kind === "owned"
            && !inspection.snapshot.terminal
            && isProcessAlive(inspection.snapshot.owner.pid)) {
            const busy = safeFailure(new CompatibilityError("COMPATIBILITY_CACHE_BUSY", "cannot cancel a job owned by another live server"));
            states.set(fingerprint, busy);
            return busy;
          }
          recoveryBlocked = !await recoverFingerprint(fingerprint);
        } catch (error) {
          const failure = safeFailure(error);
          states.set(fingerprint, failure);
          return failure;
        }
      }
      const settled = states.get(fingerprint);
      if (settled?.status === "ready" && settled.workingPath && pathExists(settled.workingPath)) {
        states.set(fingerprint, settled);
        return settled;
      }
      if (recoveryBlocked) {
        const busy = safeFailure(new CompatibilityError("COMPATIBILITY_CACHE_BUSY", "cache recovery is temporarily blocked"));
        states.set(fingerprint, busy);
        return busy;
      }
      const cancelled: CompatibilityState = { status: "cancelled", progress: null };
      states.set(fingerprint, cancelled);
      return cancelled;
    },

    sweep,
  };
}

const PROCESS_CACHE_REGISTRY_KEY = "__repurposeCompatibilityCacheRegistryV1";
type CompatibilityCacheOptions = Parameters<typeof createCompatibilityCache>[0];
type CompatibilityCacheGlobal = typeof globalThis & {
  [PROCESS_CACHE_REGISTRY_KEY]?: Map<string, CompatibilityCache>;
};

function normalizedCacheIdentity(cacheDir: string): string {
  const normalized = path.normalize(path.resolve(cacheDir));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getProcessCompatibilityCache(options: CompatibilityCacheOptions = {}): CompatibilityCache {
  const processGlobal = globalThis as CompatibilityCacheGlobal;
  const registry = processGlobal[PROCESS_CACHE_REGISTRY_KEY]
    ??= new Map<string, CompatibilityCache>();
  const cacheDir = options.cacheDir ?? COMPATIBILITY_CACHE_DIR;
  const identity = normalizedCacheIdentity(cacheDir);
  const existing = registry.get(identity);
  if (existing) return existing;
  const cache = createCompatibilityCache({ ...options, cacheDir: path.normalize(path.resolve(cacheDir)) });
  registry.set(identity, cache);
  return cache;
}

export const compatibilityCache = getProcessCompatibilityCache();
