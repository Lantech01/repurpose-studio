import { createWriteStream } from "node:fs";
import { link, mkdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { REPURPOSE_FOOTAGE_DIR } from "@/lib/repurpose/media-paths.server";
import type { UploadedVideo, VideoRole } from "@/lib/repurpose/media-types";

const ORIGINALS_DIR = path.join(REPURPOSE_FOOTAGE_DIR, "originals");

export async function storeUploadedVideo({
  body,
  name,
  role: _role,
}: {
  body: ReadableStream<Uint8Array>;
  name: string;
  role: VideoRole;
}): Promise<UploadedVideo> {
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
      createWriteStream(partialPath, { flags: "wx" })
    );

    const contentHash = hash.digest("hex");
    const originalPath = path.join(ORIGINALS_DIR, `${contentHash}${extension}`);
    try {
      // link() atomically publishes only if the content-addressed destination
      // does not exist. Unlike rename(), it cannot overwrite a concurrent upload.
      await link(partialPath, originalPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await rm(partialPath, { force: true });

    return { originalPath, contentHash, size, name };
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}
