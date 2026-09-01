import { createReadStream, createWriteStream, linkSync, type Stats } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { REPURPOSE_ORIGINALS_DIR } from "@/lib/repurpose/media-paths.server";
import type { UploadedVideo, VideoRole } from "@/lib/repurpose/media-types";

export type MediaUploadDependencies = Partial<{
  linkSync: (existingPath: string, newPath: string) => void;
  lstat: (targetPath: string) => Promise<Stats>;
  mkdir: (targetPath: string, options?: { recursive?: boolean }) => Promise<string | undefined>;
  rm: (targetPath: string, options: { force: boolean; recursive?: boolean }) => Promise<void>;
}>;

type UploadFileOperations = Required<MediaUploadDependencies>;

function resolveFileOperations(overrides?: MediaUploadDependencies): UploadFileOperations {
  return {
    linkSync: overrides?.linkSync ?? linkSync,
    lstat: overrides?.lstat ?? lstat,
    mkdir: overrides?.mkdir ?? mkdir,
    rm: overrides?.rm ?? rm,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
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
  // Cleanup remains best-effort after commit: a valid immutable original is success
  // even if Windows temporarily keeps the caller's UUID partial open.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await operations.rm(partialPath, { force: true });
      return;
    } catch {
      // A persistent failure leaves only this upload's unique partial for recovery.
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
  await operations.mkdir(REPURPOSE_ORIGINALS_DIR, { recursive: true });

  const extension = path.extname(name).toLowerCase();
  const partialPath = path.join(REPURPOSE_ORIGINALS_DIR, `.${randomUUID()}.partial`);
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
    const originalPath = path.join(
      REPURPOSE_ORIGINALS_DIR,
      `${contentHash}${extension}`
    );

    // The signal is observed immediately before the synchronous, atomic hard-link.
    // That call is the commit point: after it starts, the upload is committed and
    // cancellation never deletes an immutable original. EEXIST is an earlier commit
    // by another worker and succeeds only after validating the existing bytes.
    throwIfAborted(signal);
    try {
      operations.linkSync(partialPath, originalPath);
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
      await verifyExistingOriginal(originalPath, size, contentHash, operations);
    }

    await cleanupPartial(partialPath, operations);
    return { originalPath, contentHash, size, name };
  } catch (error) {
    await cleanupPartial(partialPath, operations);
    throw error;
  }
}
