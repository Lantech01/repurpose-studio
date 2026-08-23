import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { link, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { REPURPOSE_FOOTAGE_DIR } from "@/lib/repurpose/media-paths.server";
import type { UploadedVideo, VideoRole } from "@/lib/repurpose/media-types";

const ORIGINALS_DIR = path.join(REPURPOSE_FOOTAGE_DIR, "originals");
const PUBLISH_LOCK_SUFFIX = ".publish-lock";
const PUBLISH_LOCK_OWNER_FILE = "owner.json";
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 60 * 60 * 1000;
const RETRY_ATTEMPTS = 3;

export type MediaUploadDependencies = Partial<{
  link: (existingPath: string, newPath: string) => Promise<void>;
  lstat: (targetPath: string) => Promise<Stats>;
  mkdir: (targetPath: string, options?: { recursive?: boolean }) => Promise<string | undefined>;
  readFile: (targetPath: string, encoding: BufferEncoding) => Promise<string>;
  writeFile: (targetPath: string, data: string, options: { flag: "w" | "wx" }) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (targetPath: string, options: { force: boolean; recursive?: boolean }) => Promise<void>;
  unlink: (targetPath: string) => Promise<void>;
}>;

type UploadFileOperations = Required<MediaUploadDependencies>;

type PublicationLock = {
  lockPath: string;
  ownerPath: string;
  token: string;
};

type PublicationOwner = {
  token: string;
  pid: number;
  phase: "publishing" | "rollback-failed";
};

function resolveFileOperations(overrides?: MediaUploadDependencies): UploadFileOperations {
  return {
    link: overrides?.link ?? link,
    lstat: overrides?.lstat ?? lstat,
    mkdir: overrides?.mkdir ?? mkdir,
    readFile: overrides?.readFile ?? readFile,
    writeFile: overrides?.writeFile ?? writeFile,
    rename: overrides?.rename ?? rename,
    rm: overrides?.rm ?? rm,
    unlink: overrides?.unlink ?? unlink,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Footage upload aborted");
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Footage upload aborted"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrno(error, "EPERM");
  }
}

async function readPublicationOwner(
  ownerPath: string,
  operations: UploadFileOperations
): Promise<PublicationOwner | null> {
  try {
    const candidate: unknown = JSON.parse(await operations.readFile(ownerPath, "utf8"));
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as { token?: unknown }).token === "string" &&
      typeof (candidate as { pid?: unknown }).pid === "number"
    ) {
      return candidate as PublicationOwner;
    }
  } catch {
    // A partially-written/corrupt owner file is reclaimable only after the lock ages out.
  }
  return null;
}

async function writePublicationOwner(
  lock: PublicationLock,
  phase: PublicationOwner["phase"],
  flag: "w" | "wx",
  operations: UploadFileOperations
): Promise<void> {
  await operations.writeFile(
    lock.ownerPath,
    JSON.stringify({ token: lock.token, pid: process.pid, phase }),
    { flag }
  );
}

async function reclaimStaleLock(lockPath: string, operations: UploadFileOperations): Promise<void> {
  let info: Stats;
  try {
    info = await operations.lstat(lockPath);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;

  const owner = await readPublicationOwner(path.join(lockPath, PUBLISH_LOCK_OWNER_FILE), operations);
  if (owner && isProcessAlive(owner.pid)) return;

  const retiredPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    // Rename removes the canonical lock atomically, so an old owner can never
    // release or delete a lock acquired by a new publisher.
    await operations.rename(lockPath, retiredPath);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  await operations.rm(retiredPath, { recursive: true, force: true }).catch(() => {});
}

async function acquirePublicationLock(
  originalPath: string,
  signal: AbortSignal | undefined,
  operations: UploadFileOperations
): Promise<PublicationLock> {
  const lockPath = `${originalPath}${PUBLISH_LOCK_SUFFIX}`;
  const lock: PublicationLock = {
    lockPath,
    ownerPath: path.join(lockPath, PUBLISH_LOCK_OWNER_FILE),
    token: randomUUID(),
  };

  while (true) {
    throwIfAborted(signal);
    try {
      await operations.mkdir(lockPath);
      try {
        await writePublicationOwner(lock, "publishing", "wx", operations);
        return lock;
      } catch (error) {
        await operations.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      await reclaimStaleLock(lockPath, operations);
      await wait(LOCK_RETRY_MS, signal);
    }
  }
}

async function releasePublicationLock(lock: PublicationLock, operations: UploadFileOperations): Promise<void> {
  const owner = await readPublicationOwner(lock.ownerPath, operations);
  if (!owner || owner.token !== lock.token) return;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const retiredPath = `${lock.lockPath}.released-${randomUUID()}`;
    try {
      await operations.rename(lock.lockPath, retiredPath);
      await operations.rm(retiredPath, { recursive: true, force: true }).catch(() => {});
      return;
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return;
      if (attempt + 1 < RETRY_ATTEMPTS) await wait(LOCK_RETRY_MS);
    }
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyExistingOriginal(
  originalPath: string,
  expectedSize: number,
  expectedHash: string,
  operations: UploadFileOperations
): Promise<void> {
  const info = await operations.lstat(originalPath);
  if (!info.isFile() || info.size !== expectedSize || await hashFile(originalPath) !== expectedHash) {
    throw new Error("Content-addressed destination exists but does not match the upload");
  }
}

async function cleanupPartial(partialPath: string, operations: UploadFileOperations): Promise<void> {
  // Cleanup is deliberately best-effort after commit: a valid immutable original
  // remains a success even if Windows temporarily holds the partial open.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await operations.rm(partialPath, { force: true });
      return;
    } catch {
      // A second attempt handles transient sharing violations; persistent failures
      // leave only this UUID partial for later recovery.
    }
  }
}

async function rollbackCreatedOriginal(
  originalPath: string,
  operations: UploadFileOperations
): Promise<boolean> {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      await operations.unlink(originalPath);
      return true;
    } catch {
      if (attempt + 1 < RETRY_ATTEMPTS) await wait(LOCK_RETRY_MS);
    }
  }
  return false;
}

export async function storeUploadedVideo({
  body,
  name,
  role: _role,
  signal,
}: {
  body: ReadableStream<Uint8Array>;
  name: string;
  role: VideoRole;
  signal?: AbortSignal;
}, overrides?: MediaUploadDependencies): Promise<UploadedVideo> {
  const operations = resolveFileOperations(overrides);
  await operations.mkdir(ORIGINALS_DIR, { recursive: true });

  const extension = path.extname(name).toLowerCase();
  const partialPath = path.join(ORIGINALS_DIR, `.${randomUUID()}.partial`);
  const hash = createHash("sha256");
  let size = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as never),
      hasher,
      createWriteStream(partialPath, { flags: "wx" }),
      { signal }
    );

    const contentHash = hash.digest("hex");
    const originalPath = path.join(ORIGINALS_DIR, `${contentHash}${extension}`);
    const lock = await acquirePublicationLock(originalPath, signal, operations);
    let retainLock = false;
    try {
      let createdDestination = false;
      try {
        // Pre-commit: an aborted upload must never start publication.
        throwIfAborted(signal);
        try {
          // Commit: hard-link publication is atomic and never overwrites.
          await operations.link(partialPath, originalPath);
          createdDestination = true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await verifyExistingOriginal(originalPath, size, contentHash, operations);
        }

        // An abort racing with link() rolls back only the destination this caller made.
        throwIfAborted(signal);
        // Cleanup: failure is non-fatal after a successful immutable commit.
        await cleanupPartial(partialPath, operations);
        // Cleanup can yield, so check once more before reporting success.
        throwIfAborted(signal);
        return { originalPath, contentHash, size, name };
      } catch (error) {
        if (createdDestination) {
          const rolledBack = await rollbackCreatedOriginal(originalPath, operations);
          if (!rolledBack) {
            retainLock = true;
            // Retaining this owner lock prevents any follower from accepting the
            // still-published file as a valid deduplication result.
            await writePublicationOwner(lock, "rollback-failed", "w", operations).catch(() => {});
          }
        }
        throw error;
      }
    } finally {
      if (!retainLock) await releasePublicationLock(lock, operations);
    }
  } catch (error) {
    await cleanupPartial(partialPath, operations);
    throw error;
  }
}
