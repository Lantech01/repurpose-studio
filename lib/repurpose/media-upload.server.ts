import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { link, lstat, mkdir, rm, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { REPURPOSE_FOOTAGE_DIR } from "@/lib/repurpose/media-paths.server";
import type { UploadedVideo, VideoRole } from "@/lib/repurpose/media-types";

const ORIGINALS_DIR = path.join(REPURPOSE_FOOTAGE_DIR, "originals");

export type MediaUploadDependencies = Partial<{
  link: (existingPath: string, newPath: string) => Promise<void>;
  lstat: (targetPath: string) => Promise<Stats>;
  rm: (targetPath: string, options: { force: boolean }) => Promise<void>;
  unlink: (targetPath: string) => Promise<void>;
}>;

type UploadFileOperations = Required<MediaUploadDependencies>;

const publicationLocks = new Map<string, Promise<void>>();

function resolveFileOperations(overrides?: MediaUploadDependencies): UploadFileOperations {
  return {
    link: overrides?.link ?? link,
    lstat: overrides?.lstat ?? lstat,
    rm: overrides?.rm ?? rm,
    unlink: overrides?.unlink ?? unlink,
  };
}

async function withPublicationLock<T>(originalPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = publicationLocks.get(originalPath) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  publicationLocks.set(originalPath, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release!();
    if (publicationLocks.get(originalPath) === queued) publicationLocks.delete(originalPath);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Footage upload aborted");
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
  await mkdir(ORIGINALS_DIR, { recursive: true });

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
    return await withPublicationLock(originalPath, async () => {
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
        if (createdDestination) await operations.unlink(originalPath);
        throw error;
      }
    });
  } catch (error) {
    await cleanupPartial(partialPath, operations);
    throw error;
  }
}
