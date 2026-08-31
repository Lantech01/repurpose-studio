// @vitest-environment node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVED_SFX_KEYS, SFX_CATALOG } from "@/lib/repurpose/sfx-effects";

vi.mock("server-only", () => ({}));

const tempRoots: string[] = [];
const originalCacheDir = process.env.REPURPOSE_SFX_CACHE_DIR;
const originalEngineDir = process.env.REPURPOSE_SFX_ENGINE_DIR;
const originalCacheMaxBytes = process.env.REPURPOSE_SFX_CACHE_MAX_BYTES;
const originalCacheTtlMs = process.env.REPURPOSE_SFX_CACHE_TTL_MS;
const originalMaxQueuedRenders = process.env.REPURPOSE_SFX_MAX_QUEUED_RENDERS;
const originalMaxWaitersPerJob = process.env.REPURPOSE_SFX_MAX_WAITERS_PER_JOB;
const assetNames = APPROVED_SFX_KEYS.map((key) => SFX_CATALOG[key].filename);

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function loadRoute(cacheDir: string, engineDir?: string) {
  process.env.REPURPOSE_SFX_CACHE_DIR = cacheDir;
  if (engineDir === undefined) delete process.env.REPURPOSE_SFX_ENGINE_DIR;
  else process.env.REPURPOSE_SFX_ENGINE_DIR = engineDir;
  vi.resetModules();
  return import("@/app/api/repurpose/sfx/route");
}

function post(body: string, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/repurpose/sfx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
}

function wavBuffer(durationMs: number): Buffer {
  const frames = Math.round(48_000 * durationMs / 1000);
  const dataSize = frames * 4;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(192_000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

async function installBuiltIns(engineDir: string): Promise<Map<string, Buffer>> {
  const installed = new Map<string, Buffer>();
  await mkdir(path.join(engineDir, "sfx"), { recursive: true });
  await Promise.all(APPROVED_SFX_KEYS.map(async (key, index) => {
    const content = Buffer.from(`raw-wav-variant-${index}-${key}`);
    installed.set(key, content);
    await writeFile(path.join(engineDir, "sfx", SFX_CATALOG[key].filename), content);
  }));
  return installed;
}

function installTimedEngine(delayMs = 40): {
  mockedExecFile: ReturnType<typeof vi.fn>;
  abortCount: () => number;
} {
  let aborts = 0;
  const mockedExecFile = vi.fn((
    _file: string,
    args: readonly string[],
    options: { signal?: AbortSignal },
    callback: (error: Error | null, stdout?: string, stderr?: string) => void
  ) => {
    const outputPath = args[args.indexOf("--output") + 1];
    const durationMs = Number(args[args.indexOf("--duration-ms") + 1]);
    const outputReady = writeFile(outputPath, wavBuffer(durationMs));
    let settled = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      void outputReady.then(() => callback(error, "", ""));
    };
    const abort = () => {
      aborts += 1;
      settle(Object.assign(new Error("render aborted"), { name: "AbortError" }));
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    setTimeout(() => settle(null), delayMs);
    return { kill: vi.fn() };
  });
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFile: mockedExecFile as unknown as typeof execFile,
  }));
  return { mockedExecFile, abortCount: () => aborts };
}

afterEach(async () => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:os");
  vi.doUnmock("@/lib/repurpose/projects");
  vi.resetModules();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("repurpose-studio.sfx-runtime")];
  if (originalCacheDir === undefined) delete process.env.REPURPOSE_SFX_CACHE_DIR;
  else process.env.REPURPOSE_SFX_CACHE_DIR = originalCacheDir;
  if (originalEngineDir === undefined) delete process.env.REPURPOSE_SFX_ENGINE_DIR;
  else process.env.REPURPOSE_SFX_ENGINE_DIR = originalEngineDir;
  if (originalCacheMaxBytes === undefined) delete process.env.REPURPOSE_SFX_CACHE_MAX_BYTES;
  else process.env.REPURPOSE_SFX_CACHE_MAX_BYTES = originalCacheMaxBytes;
  if (originalCacheTtlMs === undefined) delete process.env.REPURPOSE_SFX_CACHE_TTL_MS;
  else process.env.REPURPOSE_SFX_CACHE_TTL_MS = originalCacheTtlMs;
  if (originalMaxQueuedRenders === undefined) delete process.env.REPURPOSE_SFX_MAX_QUEUED_RENDERS;
  else process.env.REPURPOSE_SFX_MAX_QUEUED_RENDERS = originalMaxQueuedRenders;
  if (originalMaxWaitersPerJob === undefined) delete process.env.REPURPOSE_SFX_MAX_WAITERS_PER_JOB;
  else process.env.REPURPOSE_SFX_MAX_WAITERS_PER_JOB = originalMaxWaitersPerJob;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("SFX route", () => {
  it("serves every catalog key without requiring generated-WAV format", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-cache-"), "missing-cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-built-in-engine-"), "engine");
    const installed = await installBuiltIns(engineDir);
    const route = await loadRoute(cacheDir, engineDir);

    for (const key of APPROVED_SFX_KEYS) {
      const response = await route.GET(new Request(
        `http://localhost/api/repurpose/sfx?key=${encodeURIComponent(key)}`
      ));
      expect(response.status, key).toBe(200);
      expect(response.headers.get("content-type"), key).toBe("audio/wav");
      expect(Buffer.from(await response.arrayBuffer()), key).toEqual(installed.get(key));
    }
    await expect(stat(cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports HEAD and full, prefix, open-ended, and suffix built-in ranges", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-range-cache-"), "cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-built-in-range-engine-"), "engine");
    const installed = await installBuiltIns(engineDir);
    const route = await loadRoute(cacheDir, engineDir);
    const content = installed.get("ding")!;
    const url = "http://localhost/api/repurpose/sfx?key=ding";

    const head = await route.HEAD(new Request(url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(content.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const cases = [
      ["bytes=0-3", 0, 3],
      ["bytes=4-", 4, content.length - 1],
      ["bytes=-5", content.length - 5, content.length - 1],
    ] as const;
    for (const [header, start, end] of cases) {
      const response = await route.GET(new Request(url, { headers: { range: header } }));
      expect(response.status, header).toBe(206);
      expect(response.headers.get("content-range"), header).toBe(`bytes ${start}-${end}/${content.length}`);
      expect(Buffer.from(await response.arrayBuffer()), header).toEqual(content.subarray(start, end + 1));
    }
  });

  it.each(["bytes=", "bytes=9-2", "bytes=999-", "items=0-1", "bytes=-0", "bytes=0-1,3-4"])(
    "returns 416 for malformed or unsatisfiable built-in range %s",
    async (range) => {
      const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-416-cache-"), "cache");
      const engineDir = path.join(await tempDir("repurpose-sfx-built-in-416-engine-"), "engine");
      const installed = await installBuiltIns(engineDir);
      const route = await loadRoute(cacheDir, engineDir);
      const response = await route.GET(new Request("http://localhost/api/repurpose/sfx?key=ding", {
        headers: { range },
      }));

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${installed.get("ding")!.length}`);
    }
  );

  it.each([
    ["neither mode", ""],
    ["both modes", "?key=ding&path=C%3A%5Cprivate.wav"],
  ])("returns 400 for %s", async (_name, query) => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-mode-cache-"), "cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-built-in-mode-engine-"), "engine");
    await installBuiltIns(engineDir);
    const route = await loadRoute(cacheDir, engineDir);

    expect((await route.GET(new Request(`http://localhost/api/repurpose/sfx${query}`))).status).toBe(400);
  });

  it.each([
    "unknown",
    "../ding",
    "ding/../../private",
    "ding%00",
    "ding&path=C:\\private.wav",
    "",
  ])("returns a path-free 404 for malformed built-in key %j", async (key) => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-key-cache-"), "cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-built-in-key-engine-"), "private-engine");
    await installBuiltIns(engineDir);
    const route = await loadRoute(cacheDir, engineDir);
    const response = await route.GET(new Request(
      `http://localhost/api/repurpose/sfx?key=${encodeURIComponent(key)}`
    ));
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain(engineDir);
    expect(body).not.toContain(SFX_CATALOG.ding.filename);
  });

  it("returns a path-free 404 when a catalog built-in file is missing", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-missing-cache-"), "cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-built-in-missing-engine-"), "private-engine");
    await installBuiltIns(engineDir);
    await rm(path.join(engineDir, "sfx", SFX_CATALOG.ding.filename));
    const route = await loadRoute(cacheDir, engineDir);
    const response = await route.GET(new Request("http://localhost/api/repurpose/sfx?key=ding"));
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain(engineDir);
    expect(body).not.toContain(SFX_CATALOG.ding.filename);
  });

  it("rejects a catalog target whose real path escapes the built-in root", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-realpath-cache-"), "cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-built-in-realpath-engine-"), "private-engine");
    const outsidePath = path.join(await tempDir("repurpose-sfx-built-in-realpath-outside-"), "private.wav");
    await installBuiltIns(engineDir);
    await writeFile(outsidePath, "private audio");
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...original,
        realpath: vi.fn(async (candidate: string) => (
          path.basename(candidate) === SFX_CATALOG.ding.filename
            ? outsidePath
            : original.realpath(candidate)
        )),
      };
    });
    const route = await loadRoute(cacheDir, engineDir);
    const response = await route.GET(new Request("http://localhost/api/repurpose/sfx?key=ding"));
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain(engineDir);
    expect(body).not.toContain(outsidePath);
  });

  it("does not enter generated cache sweep or project-reference coordination for built-ins", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-built-in-side-effect-cache-"), "missing-cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-built-in-side-effect-engine-"), "engine");
    await installBuiltIns(engineDir);
    const coordinatedSnapshot = vi.fn();
    vi.doMock("@/lib/repurpose/projects", () => ({
      withProjectReferenceSnapshot: coordinatedSnapshot,
      normalizeProjectMediaPath: vi.fn(),
      ProjectReferenceSnapshotUnavailableError: class extends Error {},
    }));
    const route = await loadRoute(cacheDir, engineDir);

    const response = await route.GET(new Request("http://localhost/api/repurpose/sfx?key=ding"));
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(response.status).toBe(200);
    expect(coordinatedSnapshot).not.toHaveBeenCalled();
    await expect(stat(cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-object payload", "null"],
    ["an empty event list", JSON.stringify({ events: [], durationMs: 1000 })],
    ["an unknown effect", JSON.stringify({ events: [{ sfx: "../ding", atMs: 0 }], durationMs: 1000 })],
    ["one malformed event", JSON.stringify({ events: [{ sfx: "ding", atMs: 0 }, { sfx: "impact", atMs: "20" }], durationMs: 1000 })],
    ["an out-of-range event", JSON.stringify({ events: [{ sfx: "ding", atMs: 1000 }], durationMs: 1000 })],
    ["too many events", JSON.stringify({ events: Array.from({ length: 501 }, () => ({ sfx: "ding", atMs: 0 })), durationMs: 1000 })],
    ["an excessive duration", JSON.stringify({ events: [{ sfx: "ding", atMs: 0 }], durationMs: 600_001 })],
    ["an unknown top-level key", JSON.stringify({ events: [{ sfx: "ding", atMs: 0 }], durationMs: 1000, output: "C:/private.wav" })],
  ])("rejects %s before checking or launching the engine", async (_name, body) => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-route-invalid-"), "cache");
    const missingEngine = path.join(await tempDir("repurpose-sfx-route-missing-"), "engine");
    const route = await loadRoute(cacheDir, missingEngine);

    const response = await route.POST(post(body));

    expect(response.status).toBe(400);
    await expect(stat(cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized request body before parsing it", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-route-large-"), "cache");
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(`{"padding":"${"x".repeat(256 * 1024)}"}`));

    expect(response.status).toBe(413);
    await expect(stat(cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns actionable SFX_ENGINE_UNAVAILABLE without leaking the engine path", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-route-unavailable-"), "cache");
    const missingEngine = path.join(await tempDir("repurpose-sfx-route-missing-"), "private-engine");
    const route = await loadRoute(cacheDir, missingEngine);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));
    const body = await response.json() as { code: string; error: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("SFX_ENGINE_UNAVAILABLE");
    expect(body.error).toContain("uv sync --frozen --project scripts/sfx-engine");
    expect(JSON.stringify(body)).not.toContain(missingEngine);
  });

  it("returns install guidance and cleans up when uv is missing", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-no-uv-");
    const mockedExecFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error) => void
    ) => {
      callback(Object.assign(new Error("spawn uv C:/private-engine ENOENT"), { code: "ENOENT" }));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));
    const body = await response.json() as { code: string; error: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("SFX_ENGINE_UNAVAILABLE");
    expect(body.error).toContain("https://docs.astral.sh/uv/getting-started/installation/");
    expect(JSON.stringify(body)).not.toContain("C:/private-engine");
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it("reports the engine unavailable before launch when an approved WAV is missing", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-route-asset-cache-"), "cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-route-asset-engine-"), "engine");
    await mkdir(path.join(engineDir, "sfx"), { recursive: true });
    await Promise.all([
      writeFile(path.join(engineDir, "build_sfx_track.py"), "pass"),
      writeFile(path.join(engineDir, "pyproject.toml"), "[project]"),
      writeFile(path.join(engineDir, "uv.lock"), "version = 1"),
      writeFile(path.join(engineDir, "sfx-catalog.json"), "{}"),
      ...assetNames.slice(0, -1).map((name) => writeFile(path.join(engineDir, "sfx", name), "wav")),
    ]);
    const mockedExecFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error) => void
    ) => {
      callback(Object.assign(new Error("engine should not launch"), { code: "MOCK_LAUNCHED" }));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir, engineDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SFX_ENGINE_UNAVAILABLE" });
    expect(mockedExecFile).not.toHaveBeenCalled();
    await expect(stat(cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports the engine unavailable before launch when the SFX catalog is missing", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-route-catalog-cache-"), "cache");
    const engineDir = path.join(await tempDir("repurpose-sfx-route-catalog-engine-"), "engine");
    await mkdir(path.join(engineDir, "sfx"), { recursive: true });
    await Promise.all([
      writeFile(path.join(engineDir, "build_sfx_track.py"), "pass"),
      writeFile(path.join(engineDir, "pyproject.toml"), "[project]"),
      writeFile(path.join(engineDir, "uv.lock"), "version = 1"),
      ...assetNames.map((name) => writeFile(path.join(engineDir, "sfx", name), "wav")),
    ]);
    const mockedExecFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error) => void
    ) => {
      callback(Object.assign(new Error("engine should not launch"), { code: "MOCK_LAUNCHED" }));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir, engineDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SFX_ENGINE_UNAVAILABLE" });
    expect(mockedExecFile).not.toHaveBeenCalled();
    await expect(stat(cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes cache setup failures instead of rejecting the route promise", async () => {
    const cacheDir = path.join(await tempDir("repurpose-sfx-route-cache-error-"), "private-cache");
    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs/promises")>()),
      mkdir: vi.fn().mockRejectedValue(Object.assign(new Error(`EACCES ${cacheDir}`), { code: "EACCES" })),
    }));
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));
    const body = await response.json() as { code: string; error: string };

    expect(response.status).toBe(500);
    expect(body.code).toBe("SFX_CACHE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain(cacheDir);
  });

  it("serves a cached final when the project reference snapshot is unavailable", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-reference-cache-hit-");
    const home = await tempDir("repurpose-sfx-route-reference-cache-home-");
    const projectsDir = path.join(home, "Downloads", "repurpose-projects");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(path.join(projectsDir, "corrupt.json"), "{not-json");
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    const payload = { events: [{ sfx: "ding", atMs: 0 }], durationMs: 1000 };
    const hash = createHash("sha256")
      .update(JSON.stringify({ events: [{ sfx: "ding", at_ms: 0 }], durationMs: 1000 }))
      .digest("hex");
    const finalPath = path.join(cacheDir, `sfx-${hash}.wav`);
    await writeFile(finalPath, wavBuffer(1000));
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify(payload)));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: finalPath });
  });

  it("publishes a new render when the project reference snapshot is unavailable", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-reference-new-render-");
    const home = await tempDir("repurpose-sfx-route-reference-new-home-");
    const projectsDir = path.join(home, "Downloads", "repurpose-projects");
    const projectPath = path.join(projectsDir, "unreadable.json");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(projectPath, JSON.stringify({
      id: "unreadable",
      name: "Unreadable",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      durationSec: 1,
      snapshot: {},
    }));
    vi.doMock("node:os", () => ({
      default: { homedir: () => home },
      homedir: () => home,
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:fs")>();
      const readFileSync = original.readFileSync;
      return {
        ...original,
        default: {
          ...original,
          readFileSync: (file: import("node:fs").PathOrFileDescriptor, options?: unknown) => {
            if (path.resolve(String(file)) === path.resolve(projectPath)) {
              throw Object.assign(new Error("unreadable"), { code: "EACCES" });
            }
            return readFileSync(file, options as never);
          },
        },
      };
    });
    installTimedEngine();
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));
    const body = await response.json() as { path: string };

    expect(response.status).toBe(200);
    await expect(stat(body.path)).resolves.toMatchObject({ size: wavBuffer(1000).length });
  });

  it("rejects malformed engine output and cleans all transient files", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-output-");
    const mockedExecFile = vi.fn((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const outputPath = args[args.indexOf("--output") + 1];
      void writeFile(outputPath, "not a wav").then(() => callback(null, "", ""));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "SFX_INVALID_OUTPUT" });
    expect(mockedExecFile).toHaveBeenCalledWith(
      "uv",
      expect.arrayContaining(["run", "--frozen", "python", "build_sfx_track.py"]),
      expect.objectContaining({ shell: false, timeout: expect.any(Number), signal: expect.any(AbortSignal) }),
      expect.any(Function)
    );
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it("returns SFX_RENDER_TIMEOUT when the engine process times out", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-timeout-");
    const mockedExecFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error) => void
    ) => {
      callback(Object.assign(new Error("timed out"), { killed: true }));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "SFX_RENDER_TIMEOUT" });
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it("publishes a duration-matched WAV and serves only it with byte ranges", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-valid-");
    const outsidePath = path.join(await tempDir("repurpose-sfx-route-outside-"), "outside.wav");
    await writeFile(outsidePath, "RIFF-private");
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 100 }],
      durationMs: 1250,
    })));
    const body = await response.json() as { ok: boolean; path: string; url: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(path.dirname(body.path)).toBe(cacheDir);
    expect(path.basename(body.path)).toMatch(/^sfx-[a-f0-9]{64}\.wav$/);
    expect((await stat(body.path)).size).toBeGreaterThan(44);
    const wav = await readFile(body.path);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(48_000);

    const range = await route.GET(new Request(`http://localhost${body.url}`, {
      headers: { range: "bytes=0-15" },
    }));
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 0-15/${wav.length}`);
    expect((await range.arrayBuffer()).byteLength).toBe(16);

    const outside = await route.GET(new Request(
      `http://localhost/api/repurpose/sfx?path=${encodeURIComponent(outsidePath)}`
    ));
    expect(outside.status).toBe(404);
  });

  it("returns a typed 404 instead of serving a corrupt content-hashed cache entry", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-corrupt-");
    const corruptPath = path.join(cacheDir, `sfx-${"a".repeat(64)}.wav`);
    await writeFile(corruptPath, "RIFF-corrupt");
    const route = await loadRoute(cacheDir);

    const response = await route.GET(new Request(
      `http://localhost/api/repurpose/sfx?path=${encodeURIComponent(corruptPath)}`
    ));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "SFX_INVALID_CACHE_ENTRY" });
  });

  it("singleflights concurrent identical renders to one Python invocation", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-concurrent-");
    let finishRender: (() => void) | undefined;
    const renderGate = new Promise<void>((resolve) => {
      finishRender = resolve;
    });
    const mockedExecFile = vi.fn((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const outputPath = args[args.indexOf("--output") + 1];
      const durationMs = Number(args[args.indexOf("--duration-ms") + 1]);
      void writeFile(outputPath, wavBuffer(durationMs)).then(async () => {
        await renderGate;
        callback(null, "", "");
      });
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);
    const body = JSON.stringify({ events: [{ sfx: "impact", atMs: 100 }], durationMs: 900 });

    const firstResponse = route.POST(post(body));
    await vi.waitFor(() => expect(mockedExecFile).toHaveBeenCalledTimes(1));
    vi.resetModules();
    const reloadedRoute = await import("@/app/api/repurpose/sfx/route");
    const secondResponse = reloadedRoute.POST(post(body));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    finishRender?.();
    const responses = await Promise.all([firstResponse, secondResponse]);
    const payloads = await Promise.all(responses.map((response) => response.json())) as Array<{ path: string }>;

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(payloads[0].path).toBe(payloads[1].path);
    expect((await stat(payloads[0].path)).size).toBeGreaterThan(44);
    expect(await readdir(cacheDir)).toEqual([path.basename(payloads[0].path)]);
  });

  it("lets a later identical waiter survive when the first waiter aborts", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-first-abort-");
    const engine = installTimedEngine(100);
    const route = await loadRoute(cacheDir);
    const body = JSON.stringify({ events: [{ sfx: "ding", atMs: 0 }], durationMs: 1000 });
    const firstController = new AbortController();
    const laterController = new AbortController();

    const first = route.POST(post(body, firstController.signal));
    await vi.waitFor(() => expect(engine.mockedExecFile).toHaveBeenCalledTimes(1));
    const later = route.POST(post(body, laterController.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstController.abort();

    expect((await first).status).toBe(499);
    expect((await later).status).toBe(200);
    expect(engine.abortCount()).toBe(0);
    expect(engine.mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it("lets the first identical waiter survive when a later waiter aborts", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-later-abort-");
    const engine = installTimedEngine();
    const route = await loadRoute(cacheDir);
    const body = JSON.stringify({ events: [{ sfx: "impact", atMs: 0 }], durationMs: 1000 });
    const firstController = new AbortController();
    const laterController = new AbortController();

    const first = route.POST(post(body, firstController.signal));
    await vi.waitFor(() => expect(engine.mockedExecFile).toHaveBeenCalledTimes(1));
    const later = route.POST(post(body, laterController.signal));
    laterController.abort();

    expect((await later).status).toBe(499);
    expect((await first).status).toBe(200);
    expect(engine.abortCount()).toBe(0);
  });

  it("aborts the child and cleans transients when every identical waiter aborts", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-all-abort-");
    const engine = installTimedEngine(100);
    const route = await loadRoute(cacheDir);
    const body = JSON.stringify({ events: [{ sfx: "riser", atMs: 0 }], durationMs: 1000 });
    const firstController = new AbortController();
    const laterController = new AbortController();

    const first = route.POST(post(body, firstController.signal));
    await vi.waitFor(() => expect(engine.mockedExecFile).toHaveBeenCalledTimes(1));
    const later = route.POST(post(body, laterController.signal));
    firstController.abort();
    laterController.abort();

    expect((await first).status).toBe(499);
    expect((await later).status).toBe(499);
    await vi.waitFor(() => expect(engine.abortCount()).toBe(1));
    await vi.waitFor(async () => expect(await readdir(cacheDir)).toEqual([]));
    expect((await route.POST(post(body))).status).toBe(200);
    expect(engine.mockedExecFile).toHaveBeenCalledTimes(2);
  });

  it("caps identical waiters and recovers capacity after one aborts", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-waiter-cap-");
    process.env.REPURPOSE_SFX_MAX_WAITERS_PER_JOB = "2";
    const engine = installTimedEngine(100);
    const route = await loadRoute(cacheDir);
    const body = JSON.stringify({ events: [{ sfx: "ding", atMs: 0 }], durationMs: 1000 });
    const secondController = new AbortController();

    const first = route.POST(post(body));
    await vi.waitFor(() => expect(engine.mockedExecFile).toHaveBeenCalledTimes(1));
    const second = route.POST(post(body, secondController.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const saturated = await route.POST(post(body));

    expect(saturated.status).toBe(429);
    expect(await saturated.json()).toMatchObject({ code: "SFX_RENDER_BUSY" });
    expect(saturated.headers.get("retry-after")).toBe("1");
    secondController.abort();
    expect((await second).status).toBe(499);

    const replacement = route.POST(post(body));
    expect((await replacement).status).toBe(200);
    expect((await first).status).toBe(200);
    expect(engine.mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it("limits distinct renders to two concurrent Python processes", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-semaphore-");
    let active = 0;
    let maxActive = 0;
    const mockedExecFile = vi.fn((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const outputPath = args[args.indexOf("--output") + 1];
      const durationMs = Number(args[args.indexOf("--duration-ms") + 1]);
      void writeFile(outputPath, wavBuffer(durationMs)).then(() => {
        setTimeout(() => {
          active -= 1;
          callback(null, "", "");
        }, 30);
      });
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);

    const responses = await Promise.all(["ding", "impact", "riser"].map((sfx) => route.POST(post(JSON.stringify({
      events: [{ sfx, atMs: 0 }],
      durationMs: 1000,
    })))));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(mockedExecFile).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(2);
  });

  it("rejects a distinct render with 429 when the pending queue is saturated", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-busy-");
    process.env.REPURPOSE_SFX_MAX_QUEUED_RENDERS = "1";
    installTimedEngine(50);
    const route = await loadRoute(cacheDir);
    const request = (sfx: string) => route.POST(post(JSON.stringify({
      events: [{ sfx, atMs: 0 }],
      durationMs: 1000,
    })));

    const first = request("ding");
    const second = request("impact");
    const queued = request("riser");
    const busy = await request("whoosh");

    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ code: "SFX_RENDER_BUSY" });
    expect(busy.headers.get("retry-after")).toBe("1");
    expect((await Promise.all([first, second, queued])).map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it("removes an all-aborted queued job so queue capacity recovers", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-queue-abort-");
    process.env.REPURPOSE_SFX_MAX_QUEUED_RENDERS = "1";
    installTimedEngine(50);
    const route = await loadRoute(cacheDir);
    const request = (sfx: string, signal?: AbortSignal) => route.POST(post(JSON.stringify({
      events: [{ sfx, atMs: 0 }],
      durationMs: 1000,
    }), signal));
    const queuedController = new AbortController();

    const first = request("ding");
    const second = request("impact");
    const queued = request("riser", queuedController.signal);
    queuedController.abort();
    const queuedResult = await Promise.race([
      queued,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    const replacement = request("whoosh");

    expect(queuedResult?.status).toBe(499);
    expect((await replacement).status).toBe(200);
    expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([200, 200]);
  });

  it("bounds completed cache files by TTL and byte cap", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-retention-");
    process.env.REPURPOSE_SFX_CACHE_MAX_BYTES = String(300_000);
    process.env.REPURPOSE_SFX_CACHE_TTL_MS = String(1000);
    const oldPaths = ["b", "c"].map((character) => path.join(cacheDir, `sfx-${character.repeat(64)}.wav`));
    await Promise.all(oldPaths.map((filePath) => writeFile(filePath, wavBuffer(1000))));
    const oldTime = new Date(Date.now() - 120_000);
    await Promise.all(oldPaths.map((filePath) => utimes(filePath, oldTime, oldTime)));
    const mockedExecFile = vi.fn((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const outputPath = args[args.indexOf("--output") + 1];
      const durationMs = Number(args[args.indexOf("--duration-ms") + 1]);
      void writeFile(outputPath, wavBuffer(durationMs)).then(() => callback(null, "", ""));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));
    const body = await response.json() as { path: string };

    expect(response.status).toBe(200);
    expect(await readdir(cacheDir)).toEqual([path.basename(body.path)]);
    expect((await stat(body.path)).size).toBeLessThanOrEqual(300_000);
  });

  it("retains an old persisted-project final while evicting an eligible final", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-project-retention-");
    process.env.REPURPOSE_SFX_CACHE_MAX_BYTES = String(300_000);
    process.env.REPURPOSE_SFX_CACHE_TTL_MS = String(1000);
    const referencedPath = path.join(cacheDir, `sfx-${"a".repeat(64)}.wav`);
    const eligiblePath = path.join(cacheDir, `sfx-${"b".repeat(64)}.wav`);
    await Promise.all([
      writeFile(referencedPath, wavBuffer(1000)),
      writeFile(eligiblePath, wavBuffer(1000)),
    ]);
    const oldTime = new Date(Date.now() - 120_000);
    await Promise.all([
      utimes(referencedPath, oldTime, oldTime),
      utimes(eligiblePath, oldTime, oldTime),
    ]);
    vi.doMock("@/lib/repurpose/projects", () => ({
      listReferencedSfxPaths: () => new Set([path.resolve(referencedPath).toLowerCase()]),
      withProjectReferenceSnapshot: async <T>(
        operation: (references: ReadonlySet<string>) => Promise<T> | T
      ) => operation(new Set([path.resolve(referencedPath).toLowerCase()])),
      normalizeProjectMediaPath: (value: unknown) => typeof value === "string"
        ? path.resolve(value).toLowerCase()
        : null,
    }));
    const mockedExecFile = vi.fn((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const outputPath = args[args.indexOf("--output") + 1];
      const durationMs = Number(args[args.indexOf("--duration-ms") + 1]);
      void writeFile(outputPath, wavBuffer(durationMs)).then(() => callback(null, "", ""));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);

    const response = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));

    expect(response.status).toBe(200);
    await expect(stat(referencedPath)).resolves.toMatchObject({ size: wavBuffer(1000).length });
    await expect(stat(eligiblePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not evict a final WAV while its GET response body is active", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-serving-");
    process.env.REPURPOSE_SFX_CACHE_MAX_BYTES = String(300_000);
    process.env.REPURPOSE_SFX_CACHE_TTL_MS = String(1_000_000);
    const servedPath = path.join(cacheDir, `sfx-${"a".repeat(64)}.wav`);
    await writeFile(servedPath, wavBuffer(1000));
    const oldTime = new Date(Date.now() - 120_000);
    await utimes(servedPath, oldTime, oldTime);
    const mockedExecFile = vi.fn((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const outputPath = args[args.indexOf("--output") + 1];
      const durationMs = Number(args[args.indexOf("--duration-ms") + 1]);
      void writeFile(outputPath, wavBuffer(durationMs)).then(() => callback(null, "", ""));
      return { kill: vi.fn() };
    });
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:child_process")>()),
      execFile: mockedExecFile as unknown as typeof execFile,
    }));
    const route = await loadRoute(cacheDir);
    const served = await route.GET(new Request(
      `http://localhost/api/repurpose/sfx?path=${encodeURIComponent(servedPath)}`
    ));

    const firstRender = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));

    expect(firstRender.status).toBe(200);
    await expect(stat(servedPath)).resolves.toMatchObject({ size: wavBuffer(1000).length });
    await served.body?.cancel();

    const secondRender = await route.POST(post(JSON.stringify({
      events: [{ sfx: "impact", atMs: 0 }],
      durationMs: 1000,
    })));
    expect(secondRender.status).toBe(200);
    await expect(stat(servedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a newly published overbudget final through its first lease-release sweep", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-publication-grace-");
    process.env.REPURPOSE_SFX_CACHE_MAX_BYTES = "100000";
    installTimedEngine();
    const route = await loadRoute(cacheDir);
    const rendered = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));
    const payload = await rendered.json() as { path: string; url: string };

    const served = await route.GET(new Request(`http://localhost${payload.url}`));
    await served.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rendered.status).toBe(200);
    expect((await stat(payload.path)).size).toBeGreaterThan(100000);
  });

  it("does not evict a final WAV while GET is still validating it", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-validating-");
    process.env.REPURPOSE_SFX_CACHE_TTL_MS = "1";
    const servedPath = path.join(cacheDir, `sfx-${"a".repeat(64)}.wav`);
    await writeFile(servedPath, wavBuffer(1000));
    const oldTime = new Date(Date.now() - 120_000);
    await utimes(servedPath, oldTime, oldTime);
    let validationStarted!: () => void;
    let resumeValidation!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    const resume = new Promise<void>((resolve) => { resumeValidation = resolve; });
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...original,
        open: vi.fn(async (filePath: string, flags: string) => {
          if (path.resolve(filePath) === path.resolve(servedPath)) {
            validationStarted();
            await resume;
          }
          return original.open(filePath, flags);
        }),
      };
    });
    installTimedEngine();
    const route = await loadRoute(cacheDir);

    const pendingGet = route.GET(new Request(
      `http://localhost/api/repurpose/sfx?path=${encodeURIComponent(servedPath)}`
    ));
    await started;
    const render = await route.POST(post(JSON.stringify({
      events: [{ sfx: "ding", atMs: 0 }],
      durationMs: 1000,
    })));
    resumeValidation();
    const served = await pendingGet;

    expect(render.status).toBe(200);
    expect(served.status).toBe(200);
    await expect(stat(servedPath)).resolves.toMatchObject({ size: wavBuffer(1000).length });
    await served.body?.cancel();
  });

  it("does not request cache sweeps for a flood of invalid GET paths", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-invalid-get-flood-");
    const legacySnapshot = vi.fn(() => new Set<string>());
    const coordinatedSnapshot = vi.fn(async <T>(
      operation: (references: ReadonlySet<string>) => Promise<T> | T
    ) => operation(new Set<string>()));
    vi.doMock("@/lib/repurpose/projects", () => ({
      listReferencedSfxPaths: legacySnapshot,
      withProjectReferenceSnapshot: coordinatedSnapshot,
      normalizeProjectMediaPath: (value: unknown) => typeof value === "string"
        ? path.resolve(value).toLowerCase()
        : null,
    }));
    const route = await loadRoute(cacheDir);
    const invalidPath = path.join(cacheDir, "not-a-content-hash.wav");

    const responses = await Promise.all(Array.from({ length: 25 }, () => route.GET(new Request(
      `http://localhost/api/repurpose/sfx?path=${encodeURIComponent(invalidPath)}`
    ))));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(responses.every((response) => response.status === 404)).toBe(true);
    expect(legacySnapshot).not.toHaveBeenCalled();
    expect(coordinatedSnapshot).not.toHaveBeenCalled();
  });

  it("coalesces concurrent valid lease releases to one running sweep and one rerun", async () => {
    const cacheDir = await tempDir("repurpose-sfx-route-sweep-coalescing-");
    const servedPath = path.join(cacheDir, `sfx-${"a".repeat(64)}.wav`);
    await writeFile(servedPath, wavBuffer(1000));
    vi.doMock("@/lib/repurpose/projects", () => ({
      listReferencedSfxPaths: () => new Set<string>(),
      withProjectReferenceSnapshot: async <T>(
        operation: (references: ReadonlySet<string>) => Promise<T> | T
      ) => operation(new Set<string>()),
      normalizeProjectMediaPath: (value: unknown) => typeof value === "string"
        ? path.resolve(value).toLowerCase()
        : null,
    }));
    let cacheReaddirCount = 0;
    let firstSweepStarted!: () => void;
    let resumeFirstSweep!: () => void;
    const firstSweep = new Promise<void>((resolve) => { firstSweepStarted = resolve; });
    const resumeSweep = new Promise<void>((resolve) => { resumeFirstSweep = resolve; });
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:fs/promises")>();
      const originalReaddir = original.readdir as unknown as (
        directory: string,
        options: { withFileTypes: true }
      ) => Promise<import("node:fs").Dirent[]>;
      return {
        ...original,
        readdir: vi.fn(async (directory: string, options: { withFileTypes: true }) => {
          if (path.resolve(directory) === path.resolve(cacheDir)) {
            cacheReaddirCount += 1;
            if (cacheReaddirCount === 1) {
              firstSweepStarted();
              await resumeSweep;
            }
          }
          return originalReaddir(directory, options);
        }),
      };
    });
    const route = await loadRoute(cacheDir);

    const responses = await Promise.all(Array.from({ length: 10 }, () => route.GET(new Request(
      `http://localhost/api/repurpose/sfx?path=${encodeURIComponent(servedPath)}`,
      { method: "HEAD" }
    ))));
    await firstSweep;
    resumeFirstSweep();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(cacheReaddirCount).toBe(2);
  });
});
