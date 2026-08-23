// @vitest-environment node

import { mkdtemp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type FootageRoute = typeof import("@/app/api/repurpose/footage/route");
type MediaPaths = typeof import("@/lib/repurpose/media-paths.server");

const tempRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:os");
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))));
});

async function loadRoute(): Promise<{ route: FootageRoute; paths: MediaPaths; originals: string }> {
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
  return { route, paths, originals: path.join(home, "Downloads", "repurpose-footage", "originals") };
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
