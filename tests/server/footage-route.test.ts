// @vitest-environment node

import { linkSync as realLinkSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

  it("does not publish when aborted before the synchronous commit", async () => {
    const { uploader, originals } = await loadRoute();
    const bytes = new Uint8Array([5, 6, 7]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const originalPath = path.join(originals, `${hash}.mp4`);
    const aborter = new AbortController();
    const linkSync = vi.fn((source: string, destination: string) => realLinkSync(source, destination));
    aborter.abort(new Error("cancelled before commit"));

    await expect(uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "cancelled.mp4", role: "face", signal: aborter.signal },
      { linkSync }
    )).rejects.toBeDefined();

    expect(linkSync).not.toHaveBeenCalled();
    await expect(lstat(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
  });

  it("keeps an original when abort fires inside the synchronous commit", async () => {
    const { uploader } = await loadRoute();
    const bytes = new Uint8Array([5, 6, 8]);
    const aborter = new AbortController();
    const linkSync = vi.fn((source: string, destination: string) => {
      aborter.abort(new Error("cancelled during commit"));
      realLinkSync(source, destination);
    });

    const uploaded = await uploader.storeUploadedVideo(
      { body: chunkedBody(bytes), name: "committed.mp4", role: "face", signal: aborter.signal },
      { linkSync }
    );

    expect(aborter.signal.aborted).toBe(true);
    expect(linkSync).toHaveBeenCalledTimes(1);
    await expect(readFile(uploaded.originalPath)).resolves.toEqual(Buffer.from(bytes));
  });

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
    const linkSync = vi.fn(() => { throw errorWithCode("EEXIST"); });

    await expect(
      uploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: "collision.mp4", role: "face" },
        { linkSync }
      )
    ).rejects.toThrow("does not match");

    expect(linkSync).toHaveBeenCalledTimes(1);
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
    const linkSync = vi.fn(() => { throw errorWithCode("EEXIST"); });

    await expect(
      uploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: "collision.mp4", role: "face" },
        { linkSync }
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
    const linkSync = vi.fn((source: string, destination: string) => realLinkSync(source, destination));

    const uploads = await Promise.all(
      Array.from({ length: 4 }, (_, index) => uploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: `same-${index}.mp4`, role: "library" },
        { linkSync }
      ))
    );

    const expectedPath = uploads[0].originalPath;
    expect(uploads.map((upload) => upload.originalPath)).toEqual([expectedPath, expectedPath, expectedPath, expectedPath]);
    await expect(readFile(expectedPath)).resolves.toEqual(Buffer.from(bytes));
    expect(linkSync).toHaveBeenCalledTimes(4);
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
  });

  it("deduplicates concurrent uploads from independent module domains", async () => {
    const { uploader: firstUploader, originals } = await loadRoute();
    const secondUploader = await loadIndependentUploader();
    const bytes = new Uint8Array([8, 8, 8]);
    const linkSync = vi.fn((source: string, destination: string) => realLinkSync(source, destination));

    const [first, second] = await Promise.all([
      firstUploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: "first.mp4", role: "face" },
        { linkSync }
      ),
      secondUploader.storeUploadedVideo(
        { body: chunkedBody(bytes), name: "second.mp4", role: "screen" },
        { linkSync }
      ),
    ]);

    expect(first.originalPath).toBe(second.originalPath);
    expect(linkSync).toHaveBeenCalledTimes(2);
    await expect(readFile(first.originalPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(listPartialFiles(originals)).resolves.toEqual([]);
  });

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
