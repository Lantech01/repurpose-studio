// @vitest-environment node

import { link as realLink, lstat, mkdtemp, mkdir, readdir, readFile, rename as realRename, stat, symlink, unlink as realUnlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type FootageRoute = typeof import("@/app/api/repurpose/footage/route");
type MediaPaths = typeof import("@/lib/repurpose/media-paths.server");
type MediaUploader = typeof import("@/lib/repurpose/media-upload.server");

const tempRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:os");
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))));
});

async function loadRoute(): Promise<{
  route: FootageRoute;
  paths: MediaPaths;
  uploader: MediaUploader;
  originals: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-footage-route-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  await Promise.all([mkdir(path.join(home, "Downloads"), { recursive: true }), mkdir(temp, { recursive: true })]);

  vi.resetModules();
  vi.doMock("node:os", () => ({
    default: { homedir: () => home, tmpdir: () => temp },
    homedir: () => home,
    tmpdir: () => temp,
  }));
  const route = (await import("@/app/api/repurpose/footage/route")) as FootageRoute;
  const paths = (await import("@/lib/repurpose/media-paths.server")) as MediaPaths;
  const uploader = (await import("@/lib/repurpose/media-upload.server")) as MediaUploader;
  return { route, paths, uploader, originals: path.join(home, "Downloads", "repurpose-footage", "originals") };
}

function chunkedBody(bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function requestFor(
  name: string,
  role: string,
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Request {
  const request = new Request(`http://localhost/api/repurpose/footage?name=${encodeURIComponent(name)}&role=${role}`, {
    method: "POST",
    body,
    signal,
    duplex: "half",
  } as RequestInit);
  Object.defineProperty(request, "formData", { value: vi.fn(() => { throw new Error("formData must not be called"); }) });
  return request;
}

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function listPartialFiles(originals: string): Promise<string[]> {
  return (await readdir(originals)).filter((name) => name.endsWith(".partial"));
}

async function loadIndependentUploader(): Promise<MediaUploader> {
  vi.resetModules();
  return (await import("@/lib/repurpose/media-upload.server")) as MediaUploader;
}

type MediaUploadOverrides = NonNullable<Parameters<MediaUploader["storeUploadedVideo"]>[1]>;

function lockAttemptBarrier(lockPath: string): {
  attempted: Promise<void>;
  release: () => void;
  mkdir: NonNullable<MediaUploadOverrides["mkdir"]>;
} {
  let announceAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => { announceAttempt = resolve; });
  let releaseAttempt!: () => void;
  const mayContinue = new Promise<void>((resolve) => { releaseAttempt = resolve; });
  let blocked = false;
  const mkdirWithBarrier: NonNullable<MediaUploadOverrides["mkdir"]> = async (target, options) => {
    try {
      return await mkdir(target, options);
    } catch (error) {
      if (target === lockPath && !blocked && (error as NodeJS.ErrnoException).code === "EEXIST") {
        blocked = true;
        announceAttempt();
        await mayContinue;
      }
      throw error;
    }
  };
  return { attempted, release: releaseAttempt, mkdir: mkdirWithBarrier };
}

describe("POST /api/repurpose/footage", () => {
  it("streams a 5 MiB request to an immutable content-addressed original", async () => {
    const { route, originals } = await loadRoute();
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(42);
    const request = requestFor("Camera Roll.MOV", "face", chunkedBody(bytes));
    const fileArrayBuffer = vi.spyOn(File.prototype, "arrayBuffer");

    const response = await route.POST(request);

    expect(response.status).toBe(200);
    const uploaded = await response.json();
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(uploaded).toEqual({
      originalPath: path.join(originals, `${hash}.mov`),
      contentHash: hash,
      size: bytes.byteLength,
      name: "Camera Roll.MOV",
    });
    await expect(stat(uploaded.originalPath)).resolves.toMatchObject({ size: bytes.byteLength });
    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(readdir(originals)).resolves.toEqual([`${hash}.mov`]);
    expect(request.formData).not.toHaveBeenCalled();
    expect(fileArrayBuffer).not.toHaveBeenCalled();
  });

  it("removes its exact partial when the body errors", async () => {
    const { route, originals } = await loadRoute();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("connection lost"));
      },
    });

    const response = await route.POST(requestFor("failed.mp4", "screen", body));

    expect(response.status).toBe(500);
    await expect(readdir(originals)).resolves.toEqual([]);
  });

  it("cancels an in-flight request and removes only its partial", async () => {
    const { route, originals } = await loadRoute();
    const aborter = new AbortController();
    let cancelled = false;
    let beginWaiting: () => void;
    const waiting = new Promise<void>((resolve) => { beginWaiting = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      pull() {
        beginWaiting();
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const upload = route.POST(requestFor("aborted.mp4", "screen", body, aborter.signal));

    await waiting;
    aborter.abort();
    const response = await Promise.race([
      upload,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upload did not abort")), 250)),
    ]);

    expect(response.status).toBe(500);
    expect(cancelled).toBe(true);
    await expect(readdir(originals)).resolves.toEqual([]);
  });

  it("rolls back an original when the request aborts while publication is blocked", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([5, 6, 7]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const originalPath = path.join(originals, `${hash}.mp4`);
    const aborter = new AbortController();
    let releaseLink: (() => void) | undefined;
    const linkMayFinish = new Promise<void>((resolve) => { releaseLink = resolve; });
    let enteredLink: () => void;
    const linkStarted = new Promise<void>((resolve) => { enteredLink = resolve; });
    const link = vi.fn(async (source: string, destination: string) => {
      enteredLink();
      await linkMayFinish;
      await realLink(source, destination);
    });

    const upload = uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "blocked.mp4", role: "face", signal: aborter.signal },
      { link }
    );
    await linkStarted;
    aborter.abort();
    if (!releaseLink) throw new Error("publication barrier was not initialized");
    releaseLink();

    await expect(upload).rejects.toBeDefined();
    expect(link).toHaveBeenCalledTimes(1);
    await expect(lstat(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
  }, 1_000);

  it.each([
    {
      label: "a directory",
      create: async (destination: string) => mkdir(destination),
      assertIntact: async (destination: string) => expect((await stat(destination)).isDirectory()).toBe(true),
    },
    {
      label: "a symlink",
      create: async (destination: string, originals: string) => symlink(originals, destination, "junction"),
      assertIntact: async (destination: string) => expect((await lstat(destination)).isSymbolicLink()).toBe(true),
    },
    {
      label: "a truncated file",
      create: async (destination: string) => writeFile(destination, new Uint8Array([9, 8])),
      assertIntact: async (destination: string) => expect(await readFile(destination)).toEqual(Buffer.from([9, 8])),
    },
    {
      label: "a same-sized file with different bytes",
      create: async (destination: string) => writeFile(destination, new Uint8Array([9, 9, 9])),
      assertIntact: async (destination: string) => expect(await readFile(destination)).toEqual(Buffer.from([9, 9, 9])),
    },
  ])("rejects EEXIST for %s and preserves the destination", async ({ create, assertIntact }) => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([5, 6, 7]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const destination = path.join(originals, `${hash}.mp4`);
    await mkdir(originals, { recursive: true });
    await create(destination, originals);
    const link = vi.fn(async () => { throw errorWithCode("EEXIST"); });

    await expect(
      uploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: "collision.mp4", role: "face" },
        { link }
      )
    ).rejects.toThrow("does not match");

    expect(link).toHaveBeenCalledTimes(1);
    await assertIntact(destination);
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
  });

  it("keeps an unrelated partial sentinel when publication is rejected", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([5, 6, 7]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const destination = path.join(originals, `${hash}.mp4`);
    const sentinel = path.join(originals, ".sentinel.partial");
    await mkdir(destination, { recursive: true });
    await writeFile(sentinel, "keep me");
    const link = vi.fn(async () => { throw errorWithCode("EEXIST"); });

    await expect(
      uploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: "collision.mp4", role: "face" },
        { link }
      )
    ).rejects.toThrow("does not match");

    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep me");
    await expect(readdir(originals)).resolves.toEqual([".sentinel.partial", `${hash}.mp4`]);
  });

  it("returns success when a transient partial cleanup fails after publication", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([4, 3, 2, 1]);
    let partialCleanupAttempts = 0;
    const rm = vi.fn(async (target: string) => {
      if (target.endsWith(".partial") && partialCleanupAttempts++ === 0) {
        throw errorWithCode("EBUSY");
      }
      await import("node:fs/promises").then(({ rm: realRm }) => realRm(target, { force: true }));
    });

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "transient.mp4", role: "face" },
      { rm }
    );

    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    expect(partialCleanupAttempts).toBe(2);
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
  });

  it("returns success and leaves only its own retryable partial when cleanup keeps failing", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([4, 3, 2, 1]);
    const sentinel = path.join(originals, ".sentinel.partial");
    await mkdir(originals, { recursive: true });
    await writeFile(sentinel, "keep me");
    const rm = vi.fn(async (target: string) => {
      if (target.endsWith(".partial")) throw errorWithCode("EBUSY");
      await import("node:fs/promises").then(({ rm: realRm }) => realRm(target, { force: true }));
    });

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "persistent.mp4", role: "face" },
      { rm }
    );

    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep me");
    expect(await listPartialFiles(originals)).toHaveLength(2);
  });

  it("coordinates concurrent identical uploads around one immutable original", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const link = vi.fn(async (source: string, destination: string) => realLink(source, destination));

    const uploads = await Promise.all(
      Array.from({ length: 4 }, (_, index) => uploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: `same-${index}.mp4`, role: "library" },
        { link }
      ))
    );

    const expectedPath = uploads[0].originalPath;
    expect(uploads.map((upload) => upload.originalPath)).toEqual([expectedPath, expectedPath, expectedPath, expectedPath]);
    await expect(readFile(expectedPath)).resolves.toEqual(Buffer.from(bytes));
    expect(link).toHaveBeenCalledTimes(4);
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
  });

  it("coordinates two module lock domains until an aborted publisher rolls back", async () => {
    const { uploader: publisherUploader, originals } = await loadRoute();
    const followerUploader = await loadIndependentUploader();
    const bytes = new Uint8Array([8, 8, 8]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const originalPath = path.join(originals, `${hash}.mp4`);
    const lockPath = `${originalPath}.publish-lock`;
    const publisherAbort = new AbortController();
    let releasePublisherLink: (() => void) | undefined;
    const publisherMayFinish = new Promise<void>((resolve) => { releasePublisherLink = resolve; });
    let publisherLinked: () => void;
    const publisherHasLinked = new Promise<void>((resolve) => { publisherLinked = resolve; });
    const link = vi.fn(async (source: string, destination: string) => {
      await realLink(source, destination);
      publisherLinked();
      await publisherMayFinish;
    });
    const abortReason = new Error("publisher cancelled");
    const publisher = publisherUploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "publisher.mp4", role: "face", signal: publisherAbort.signal },
      { link }
    );
    await publisherHasLinked;
    const followerLock = lockAttemptBarrier(lockPath);
    const follower = followerUploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "follower.mp4", role: "face" },
      { mkdir: followerLock.mkdir }
    );

    await followerLock.attempted;
    publisherAbort.abort(abortReason);
    if (!releasePublisherLink) throw new Error("publisher barrier was not initialized");
    releasePublisherLink();

    await expect(publisher).rejects.toBe(abortReason);
    followerLock.release();
    const uploaded = await follower;
    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(lstat(originalPath)).resolves.toMatchObject({ size: bytes.byteLength });
  });

  it("preserves the AbortError and lets a follower proceed after transient rollback unlink failures", async () => {
    const { uploader: publisherUploader, originals } = await loadRoute();
    const followerUploader = await loadIndependentUploader();
    const bytes = new Uint8Array([6, 6, 6]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const lockPath = path.join(originals, `${hash}.mp4.publish-lock`);
    const publisherAbort = new AbortController();
    const abortReason = new Error("publisher cancelled");
    let releasePublisherLink: (() => void) | undefined;
    const publisherMayFinish = new Promise<void>((resolve) => { releasePublisherLink = resolve; });
    let publisherLinked: () => void;
    const publisherHasLinked = new Promise<void>((resolve) => { publisherLinked = resolve; });
    const link = vi.fn(async (source: string, destination: string) => {
      await realLink(source, destination);
      publisherLinked();
      await publisherMayFinish;
    });
    let unlinkAttempts = 0;
    const unlink = vi.fn(async (target: string) => {
      if (unlinkAttempts++ === 0) throw errorWithCode("EBUSY");
      await realUnlink(target);
    });
    const publisher = publisherUploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "publisher.mp4", role: "face", signal: publisherAbort.signal },
      { link, unlink }
    );
    await publisherHasLinked;
    const followerLock = lockAttemptBarrier(lockPath);
    const follower = followerUploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "follower.mp4", role: "face" },
      { mkdir: followerLock.mkdir }
    );

    await followerLock.attempted;
    publisherAbort.abort(abortReason);
    if (!releasePublisherLink) throw new Error("publisher barrier was not initialized");
    releasePublisherLink();

    await expect(publisher).rejects.toBe(abortReason);
    expect(unlink).toHaveBeenCalledTimes(2);
    followerLock.release();
    await expect(follower).resolves.toMatchObject({ size: bytes.byteLength });
  });

  it("recovers a failed rollback under lock before the follower republishes", async () => {
    const { uploader: publisherUploader, originals } = await loadRoute();
    const followerUploader = await loadIndependentUploader();
    const bytes = new Uint8Array([3, 3, 3]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const originalPath = path.join(originals, `${hash}.mp4`);
    const publisherAbort = new AbortController();
    const abortReason = new Error("publisher cancelled");
    let releasePublisherLink: (() => void) | undefined;
    const publisherMayFinish = new Promise<void>((resolve) => { releasePublisherLink = resolve; });
    let publisherLinked: () => void;
    const publisherHasLinked = new Promise<void>((resolve) => { publisherLinked = resolve; });
    const link = vi.fn(async (source: string, destination: string) => {
      await realLink(source, destination);
      publisherLinked();
      await publisherMayFinish;
    });
    const unlink = vi.fn(async () => { throw errorWithCode("EBUSY"); });
    const publisher = publisherUploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "publisher.mp4", role: "face", signal: publisherAbort.signal },
      { link, unlink }
    );
    await publisherHasLinked;
    const followerLock = lockAttemptBarrier(`${originalPath}.publish-lock`);
    const followerLink = vi.fn(async (source: string, destination: string) => {
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      await realLink(source, destination);
    });
    const follower = followerUploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "follower.mp4", role: "face" },
      { link: followerLink, mkdir: followerLock.mkdir }
    );

    await followerLock.attempted;
    publisherAbort.abort(abortReason);
    if (!releasePublisherLink) throw new Error("publisher barrier was not initialized");
    releasePublisherLink();
    await expect(publisher).rejects.toBe(abortReason);
    followerLock.release();
    const uploaded = await follower;
    expect(followerLink).toHaveBeenCalledTimes(1);
    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
  });

  it("reclaims only a stale publish lock whose recorded owner is no longer alive", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([2, 2, 2]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const lockPath = path.join(originals, `${hash}.mp4.publish-lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "dead", pid: -1, phase: "publishing" }));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lockPath, old, old);

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "stale.mp4", role: "face" }
    );

    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a fresh dead rollback-failed owner before a follower publishes", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([2, 4, 2]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const originalPath = path.join(originals, `${hash}.mp4`);
    const lockPath = `${originalPath}.publish-lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(originalPath, bytes);
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ token: "dead", pid: -1, phase: "rollback-failed" })
    );
    const link = vi.fn(async (source: string, destination: string) => {
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      await realLink(source, destination);
    });

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "recovered.mp4", role: "face" },
      { link }
    );

    expect(link).toHaveBeenCalledTimes(1);
    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 1_000);

  it("treats an already-missing rollback destination as recovered", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([2, 4, 3]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const originalPath = path.join(originals, `${hash}.mp4`);
    const lockPath = `${originalPath}.publish-lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ token: "dead", pid: -1, phase: "rollback-failed" })
    );
    const link = vi.fn(async (source: string, destination: string) => realLink(source, destination));

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "missing-rollback.mp4", role: "face" },
      { link }
    );

    expect(link).toHaveBeenCalledTimes(1);
    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 1_000);

  it("records committed and lets a follower reclaim a lock whose owner could not release it", async () => {
    const { uploader, originals } = await loadRoute();
    const followerUploader = await loadIndependentUploader();
    const bytes = new Uint8Array([1, 4, 1]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const originalPath = path.join(originals, `${hash}.mp4`);
    const lockPath = `${originalPath}.publish-lock`;
    const rename = vi.fn(async (from: string, to: string) => {
      if (from === lockPath) throw errorWithCode("EBUSY");
      await realRename(from, to);
    });

    const first = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "committed.mp4", role: "face" },
      { rename }
    );
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    const followerLock = lockAttemptBarrier(lockPath);
    const followerUpload = followerUploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "follower.mp4", role: "face" },
      { mkdir: followerLock.mkdir }
    );
    await followerLock.attempted;
    followerLock.release();
    const follower = await followerUpload;

    expect(owner.phase).toBe("committed");
    await expect(readFile(first.originalPath)).resolves.toEqual(Buffer.from(bytes));
    expect(follower.originalPath).toBe(first.originalPath);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 1_000);

  it("reclaims old invalid phase metadata instead of treating a live PID as an owner", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([9, 4, 9]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const lockPath = path.join(originals, `${hash}.mp4.publish-lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "bad", pid: process.pid, phase: "unknown" }));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lockPath, old, old);

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "invalid-phase.mp4", role: "face" }
    );

    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 1_000);

  it("reclaims a fresh publishing lock immediately when its recorded PID is dead", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([5, 4, 5]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const lockPath = path.join(originals, `${hash}.mp4.publish-lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "dead", pid: -1, phase: "publishing" }));

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "dead-owner.mp4", role: "face" }
    );

    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 1_000);

  it("aborts a follower after its lock polling attempt is observed", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([5, 4, 6]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const lockPath = path.join(originals, `${hash}.mp4.publish-lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ token: "live", pid: process.pid, phase: "publishing" })
    );
    const aborter = new AbortController();
    const abortReason = new Error("follower cancelled");
    const followerLock = lockAttemptBarrier(lockPath);
    const follower = uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "cancelled-follower.mp4", role: "face", signal: aborter.signal },
      { mkdir: followerLock.mkdir }
    );

    await followerLock.attempted;
    aborter.abort(abortReason);
    followerLock.release();

    await expect(follower).rejects.toBe(abortReason);
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
  }, 1_000);

  it("reuses one original for byte-identical uploads without overwriting it", async () => {
    const { route, originals } = await loadRoute();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const first = await route.POST(requestFor("first.mp4", "library", chunkedBody(bytes)));
    const firstUploaded = await first.json();
    const firstMtime = (await stat(firstUploaded.originalPath)).mtimeMs;
    const second = await route.POST(requestFor("different-name.mp4", "overlay", chunkedBody(bytes)));
    const secondUploaded = await second.json();

    expect(secondUploaded.originalPath).toBe(firstUploaded.originalPath);
    expect(secondUploaded.contentHash).toBe(firstUploaded.contentHash);
    expect(await readdir(originals)).toEqual([`${firstUploaded.contentHash}.mp4`]);
    expect((await stat(firstUploaded.originalPath)).mtimeMs).toBe(firstMtime);
  });

  it("rejects invalid names, extensions, roles, and empty bodies", async () => {
    const { route } = await loadRoute();
    const body = () => chunkedBody(new Uint8Array([1]));
    await expect(route.POST(requestFor("../escape.mp4", "face", body()))).resolves.toMatchObject({ status: 400 });
    await expect(route.POST(requestFor("clip.txt", "face", body()))).resolves.toMatchObject({ status: 400 });
    await expect(route.POST(requestFor("clip.mp4", "invalid", body()))).resolves.toMatchObject({ status: 400 });
    await expect(route.POST(new Request("http://localhost/api/repurpose/footage?name=clip.mp4&role=face", { method: "POST" }))).resolves.toMatchObject({ status: 400 });
  });
});
