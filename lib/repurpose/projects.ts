import 'server-only';

// ===========================================================================
// lib/repurpose/projects.ts  —  disk-backed project store for Repurpose Studio
// ===========================================================================
// Each project is one JSON file under PROJECTS_DIR (by default
// ~/Downloads/repurpose-projects) named <id>.json. The id IS the filename stem,
// so ID_RE below is the security gate: it forbids `/`, `\`, `.`, `..`, and any
// traversal. Because the configured root is server-owned and the id is
// regex-clamped to a single path segment, there is no way to escape it, so NO
// realpath allow-list is needed here (unlike /api/repurpose/asset, which serves
// arbitrary user-picked absolute paths). Node runtime required for fs.
// ===========================================================================

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { ProjectSnapshot } from './types';
import { isApprovedSfxKey } from './sfx-effects';
import { resolveRepurposeProjectsDir } from './project-root';

export const PROJECTS_DIR = resolveRepurposeProjectsDir();

// Single path segment: lowercase alnum start, then alnum/hyphen, 1..100 chars.
// Forbids `/ \ . ..` and traversal because none of those characters match.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_RETRY_MIN_MS = 10;
const LOCK_RETRY_JITTER_MS = 15;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_OWNER_GRACE_MS = 1_000;
const PROJECT_REFERENCE_RUNTIME_KEY = Symbol.for(
  'repurpose-studio.project-reference-runtime',
);
const PERSISTED_SFX_CLIP_FIELDS = new Set([
  'id',
  'name',
  'source',
  'origin',
  'timelineStart',
  'sourceStart',
  'sourceEnd',
  'gain',
  'fadeInSec',
  'fadeOutSec',
  'muted',
]);

interface ProjectReferenceRuntime {
  locked: boolean;
  waiters: Array<() => void>;
}

const projectReferenceGlobal = globalThis as unknown as Record<
  symbol,
  ProjectReferenceRuntime | undefined
>;
const projectReferenceRuntime = projectReferenceGlobal[
  PROJECT_REFERENCE_RUNTIME_KEY
] ??= { locked: false, waiters: [] };

export function isValidProjectId(id: unknown): id is string {
  return (
    typeof id === 'string' && ID_RE.test(id) && path.basename(id) === id
  );
}

export interface ProjectFile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  durationSec: number;
  saveRevision: number;
  saveWriterId: string | null;
  saveWriterBaseRevision: number;
  createRequestId: string | null;
  createWriterId: string | null;
  snapshot: ProjectSnapshot;
}

export type ProjectMeta = Pick<
  ProjectFile,
  'id' | 'name' | 'createdAt' | 'updatedAt' | 'durationSec'
>;

function ensureDir(): void {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function filePath(id: string): string {
  return path.join(PROJECTS_DIR, `${id}.json`);
}

function lockPath(id: string): string {
  return path.join(PROJECTS_DIR, `.${id}.lock`);
}

interface ProjectLockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

export class ProjectMutationLockTimeoutError extends Error {
  readonly code = 'PROJECT_MUTATION_LOCK_TIMEOUT';

  constructor(readonly projectId: string) {
    super(`Timed out waiting for the project mutation lock: ${projectId}`);
    this.name = 'ProjectMutationLockTimeoutError';
  }
}

export class ProjectReferenceSnapshotUnavailableError extends Error {
  readonly code = 'PROJECT_REFERENCE_SNAPSHOT_UNAVAILABLE';

  constructor() {
    super('Persisted project references could not be read safely.');
    this.name = 'ProjectReferenceSnapshotUnavailableError';
  }
}

async function withProjectReferenceLock<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  if (projectReferenceRuntime.locked) {
    await new Promise<void>((resolve) => {
      projectReferenceRuntime.waiters.push(resolve);
    });
  } else {
    projectReferenceRuntime.locked = true;
  }
  try {
    return await operation();
  } finally {
    const next = projectReferenceRuntime.waiters.shift();
    if (next) next();
    else projectReferenceRuntime.locked = false;
  }
}

export function withProjectReferenceMutation<T>(
  mutation: () => Promise<T> | T,
): Promise<T> {
  return withProjectReferenceLock(mutation);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function readLockOwner(projectLockPath: string): ProjectLockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(projectLockPath, LOCK_OWNER_FILE), 'utf8'),
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const owner = parsed as Record<string, unknown>;
  if (
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== 'string' ||
    owner.token.length < 8 ||
    typeof owner.acquiredAt !== 'string' ||
    !Number.isFinite(Date.parse(owner.acquiredAt))
  ) {
    return null;
  }
  return owner as unknown as ProjectLockOwner;
}

function ownerProcessIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Anything other
    // than ESRCH is likewise insufficient evidence to steal its lock.
    return isErrnoCode(error, 'ESRCH');
  }
}

function recoverDeadLock(projectLockPath: string): boolean {
  const owner = readLockOwner(projectLockPath);
  if (owner) {
    if (!ownerProcessIsDefinitelyDead(owner.pid)) return false;
  } else {
    // mkdir happens before owner.json is published. A contender must allow
    // that short publication window, but an old ownerless/malformed directory
    // is a crash artifact and would otherwise block every save forever.
    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(projectLockPath).mtimeMs;
    } catch (error) {
      return isErrnoCode(error, 'ENOENT');
    }
    if (ageMs < LOCK_OWNER_GRACE_MS) return false;
  }

  // Rename first so two recovery contenders cannot delete a newly acquired
  // lock at the original path. Directory rename is atomic on the same volume
  // and works on Windows without relying on POSIX advisory locking.
  const quarantinePath = `${projectLockPath}.dead.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(projectLockPath, quarantinePath);
  } catch (error) {
    return isErrnoCode(error, 'ENOENT');
  }
  fs.rmSync(quarantinePath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 10,
  });
  return true;
}

function releaseProjectLock(
  projectLockPath: string,
  ownerToken: string,
): void {
  const owner = readLockOwner(projectLockPath);
  if (owner?.token !== ownerToken) return;
  fs.rmSync(projectLockPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 10,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize one project's read/validate/write mutation across module reloads
 * and server processes. A lock owned by a live PID is never stolen based on
 * age alone; only an owner that the OS reports as absent is recovered.
 */
export async function withProjectMutationLock<T>(
  projectId: string,
  mutation: () => Promise<T> | T,
): Promise<T> {
  if (!isValidProjectId(projectId)) {
    throw new TypeError('valid project id required for mutation lock');
  }
  ensureDir();
  const projectLockPath = lockPath(projectId);
  const owner: ProjectLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      fs.mkdirSync(projectLockPath);
      try {
        fs.writeFileSync(
          path.join(projectLockPath, LOCK_OWNER_FILE),
          JSON.stringify(owner),
          { encoding: 'utf8', flag: 'wx' },
        );
      } catch (error) {
        fs.rmSync(projectLockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error;
      if (recoverDeadLock(projectLockPath)) continue;
      if (Date.now() >= deadline) {
        throw new ProjectMutationLockTimeoutError(projectId);
      }
      await delay(
        LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS),
      );
    }
  }

  try {
    return await mutation();
  } finally {
    releaseProjectLock(projectLockPath, owner.token);
  }
}

/**
 * Read + JSON.parse + shape-validate a project file. Returns null on any
 * failure (missing, unreadable, invalid JSON, wrong shape) so callers never
 * throw on a corrupt or partial file on disk.
 */
function readFileSafe(fp: string): ProjectFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!isValidProjectId(p.id)) return null;
  if (typeof p.name !== 'string') return null;
  if (typeof p.createdAt !== 'string') return null;
  if (typeof p.updatedAt !== 'string') return null;
  if (typeof p.durationSec !== 'number') return null;
  if (!p.snapshot || typeof p.snapshot !== 'object') return null;
  const saveRevisionValue = p.saveRevision ?? p.revision;
  const saveRevision =
    typeof saveRevisionValue === 'number' &&
    Number.isSafeInteger(saveRevisionValue) &&
    saveRevisionValue >= 0
      ? saveRevisionValue
      : 0;
  const saveWriterId =
    typeof p.saveWriterId === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(p.saveWriterId)
      ? p.saveWriterId
      : null;
  const saveWriterBaseRevision =
    saveWriterId !== null &&
    typeof p.saveWriterBaseRevision === 'number' &&
    Number.isSafeInteger(p.saveWriterBaseRevision) &&
    p.saveWriterBaseRevision >= 0 &&
    p.saveWriterBaseRevision <= saveRevision
      ? p.saveWriterBaseRevision
      : saveRevision;
  const createWriterId =
    typeof p.createWriterId === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(p.createWriterId)
      ? p.createWriterId
      : null;
  const createRequestId =
    createWriterId !== null &&
    typeof p.createRequestId === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(p.createRequestId)
      ? p.createRequestId
      : null;
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    durationSec: p.durationSec,
    saveRevision,
    saveWriterId,
    saveWriterBaseRevision,
    createRequestId,
    createWriterId: createRequestId ? createWriterId : null,
    snapshot: p.snapshot as ProjectSnapshot,
  };
}

/**
 * List all valid projects as lightweight metadata (no snapshot), sorted
 * newest-first by updatedAt. Corrupt/misshaped files are silently skipped.
 * ISO strings sort lexicographically == chronologically, so newest-first is
 * `b.updatedAt` before `a.updatedAt`.
 */
export function listProjects(): ProjectMeta[] {
  ensureDir();
  let names: string[];
  try {
    names = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  const metas: ProjectMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    if (!isValidProjectId(stem)) continue;
    const file = readFileSafe(path.join(PROJECTS_DIR, name));
    if (!file) continue;
    metas.push({
      id: file.id,
      name: file.name,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      durationSec: file.durationSec,
    });
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return metas;
}

/** Read a full project by id. Invalid id, or missing/corrupt file -> null. */
export function readProject(id: string): ProjectFile | null {
  if (!isValidProjectId(id)) return null;
  ensureDir();
  return readFileSafe(filePath(id));
}

/** Normalize a persisted media path to the same identity used by this host's routes. */
export function normalizeProjectMediaPath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes('?') ||
    value.startsWith('//') ||
    value === '/api' ||
    value.startsWith('/api/')
  ) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    if (!path.win32.isAbsolute(value)) return null;
    const normalized = path.win32.normalize(path.win32.resolve(value));
    if (
      normalized === path.win32.parse(normalized).root ||
      normalized.endsWith(path.win32.sep)
    ) return null;
    return normalized.toLowerCase();
  }
  if (!path.isAbsolute(value)) return null;
  const normalized = path.normalize(path.resolve(value));
  if (normalized === path.parse(normalized).root || normalized.endsWith(path.sep)) {
    return null;
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function readReferencedSfxPaths(): Set<string> {
  const referenced = new Set<string>();
  try {
    ensureDir();
    const names = fs.readdirSync(PROJECTS_DIR);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const stem = name.slice(0, -'.json'.length);
      if (!isValidProjectId(stem)) continue;
      const project = readFileSafe(path.join(PROJECTS_DIR, name));
      if (!project || project.id !== stem) {
        throw new ProjectReferenceSnapshotUnavailableError();
      }
      const snapshot = project.snapshot as unknown as Record<string, unknown>;
      const track = snapshot.sfxTrack;
      if (track !== undefined && track !== null) {
        if (typeof track !== 'object' || Array.isArray(track)) {
          throw new ProjectReferenceSnapshotUnavailableError();
        }
        const normalized = normalizeProjectMediaPath(
          (track as Record<string, unknown>).sourcePath,
        );
        if (!normalized) throw new ProjectReferenceSnapshotUnavailableError();
        referenced.add(normalized);
      }

      const clips = snapshot.sfxClips;
      if (clips === undefined) continue;
      if (!Array.isArray(clips)) {
        throw new ProjectReferenceSnapshotUnavailableError();
      }
      for (const clip of clips) {
        if (!clip || typeof clip !== 'object' || Array.isArray(clip)) {
          throw new ProjectReferenceSnapshotUnavailableError();
        }
        const candidate = clip as Record<string, unknown>;
        if (
          Object.keys(candidate).some((key) => !PERSISTED_SFX_CLIP_FIELDS.has(key)) ||
          typeof candidate.id !== 'string' ||
          candidate.id.trim().length === 0 ||
          typeof candidate.name !== 'string' ||
          candidate.name.trim().length === 0 ||
          (candidate.origin !== 'automatic' && candidate.origin !== 'manual') ||
          typeof candidate.timelineStart !== 'number' ||
          !Number.isFinite(candidate.timelineStart) ||
          candidate.timelineStart < 0 ||
          typeof candidate.sourceStart !== 'number' ||
          !Number.isFinite(candidate.sourceStart) ||
          candidate.sourceStart < 0 ||
          typeof candidate.sourceEnd !== 'number' ||
          !Number.isFinite(candidate.sourceEnd) ||
          candidate.sourceEnd <= candidate.sourceStart ||
          typeof candidate.gain !== 'number' ||
          !Number.isFinite(candidate.gain) ||
          typeof candidate.fadeInSec !== 'number' ||
          !Number.isFinite(candidate.fadeInSec) ||
          candidate.fadeInSec < 0 ||
          typeof candidate.fadeOutSec !== 'number' ||
          !Number.isFinite(candidate.fadeOutSec) ||
          candidate.fadeOutSec < 0 ||
          typeof candidate.muted !== 'boolean'
        ) {
          throw new ProjectReferenceSnapshotUnavailableError();
        }
        const source = candidate.source;
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          throw new ProjectReferenceSnapshotUnavailableError();
        }
        const record = source as Record<string, unknown>;
        if (record.kind === 'built-in') {
          if (
            Object.keys(record).some((key) => key !== 'kind' && key !== 'key') ||
            !isApprovedSfxKey(record.key)
          ) {
            throw new ProjectReferenceSnapshotUnavailableError();
          }
          continue;
        }
        if (record.kind === 'imported') {
          if (
            Object.keys(record).some(
              (key) => key !== 'kind' && key !== 'assetId' && key !== 'srcDuration',
            ) ||
            typeof record.assetId !== 'string' ||
            record.assetId.trim().length === 0 ||
            typeof record.srcDuration !== 'number' ||
            !Number.isFinite(record.srcDuration) ||
            record.srcDuration <= 0
          ) {
            throw new ProjectReferenceSnapshotUnavailableError();
          }
          continue;
        }
        if (record.kind !== 'legacy') {
          throw new ProjectReferenceSnapshotUnavailableError();
        }
        if (
          Object.keys(record).some(
            (key) => key !== 'kind' && key !== 'sourcePath' && key !== 'srcDuration',
          ) ||
          typeof record.srcDuration !== 'number' ||
          !Number.isFinite(record.srcDuration) ||
          record.srcDuration <= 0
        ) {
          throw new ProjectReferenceSnapshotUnavailableError();
        }
        const normalized = normalizeProjectMediaPath(record.sourcePath);
        if (!normalized) throw new ProjectReferenceSnapshotUnavailableError();
        referenced.add(normalized);
      }
    }
  } catch (error) {
    if (error instanceof ProjectReferenceSnapshotUnavailableError) throw error;
    throw new ProjectReferenceSnapshotUnavailableError();
  }
  return referenced;
}

/** Hold a stable fail-closed reference snapshot for the full callback. */
export function withProjectReferenceSnapshot<T>(
  operation: (references: ReadonlySet<string>) => Promise<T> | T,
): Promise<T> {
  return withProjectReferenceLock(() => operation(readReferencedSfxPaths()));
}

/** Return every persisted project's referenced SFX final, failing closed. */
export function listReferencedSfxPaths(): Promise<Set<string>> {
  return withProjectReferenceSnapshot((references) => new Set(references));
}

/** Upsert a project through an atomic same-directory rename. */
export function writeProject(file: ProjectFile): Promise<void> {
  return withProjectReferenceMutation(async () => {
    ensureDir();
    const destination = filePath(file.id);
    const temporary = path.join(
      PROJECTS_DIR,
      `.${file.id}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.promises.writeFile(
        temporary,
        JSON.stringify(file, null, 2) + '\n',
        'utf8',
      );
      fs.renameSync(temporary, destination);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The rename consumed the temporary file; cleanup matters only on failure.
      }
    }
  });
}

/** Whether the requested project path exists, even when its JSON is corrupt. */
export function projectFileExists(id: string): boolean {
  if (!isValidProjectId(id)) return false;
  ensureDir();
  return fs.existsSync(filePath(id));
}

/** Resolve a keyed create retry to the project already committed for that key. */
export function findProjectByCreateRequestId(
  createRequestId: string,
): ProjectFile | null {
  ensureDir();
  let names: string[];
  try {
    names = fs.readdirSync(PROJECTS_DIR).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const project = readFileSafe(path.join(PROJECTS_DIR, name));
    if (project?.createRequestId === createRequestId) return project;
  }
  return null;
}

/**
 * Delete a project file. Returns whether a file was actually removed. No-op
 * (false) if the id is invalid or the file is already absent.
 */
export function deleteProject(id: string): Promise<boolean> {
  if (!isValidProjectId(id)) return Promise.resolve(false);
  return withProjectReferenceMutation(() => {
    ensureDir();
    const fp = filePath(id);
    if (!fs.existsSync(fp)) return false;
    try {
      fs.unlinkSync(fp);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Return `base` if no <base>.json exists yet, else the first free
 * `base-2`, `base-3`, ... Caps the scan to avoid an unbounded loop and falls
 * back to a timestamp-suffixed id if somehow every slot is taken (Date.now is
 * fine here -- this runs inside a Node route, not a deterministic workflow).
 */
export function uniqueId(base: string): string {
  ensureDir();
  if (!fs.existsSync(filePath(base))) return base;
  for (let n = 2; n <= 10000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    if (!fs.existsSync(filePath(candidate))) return candidate;
  }
  const suffix = `-${Date.now()}`;
  return `${base.slice(0, 100 - suffix.length)}${suffix}`;
}
