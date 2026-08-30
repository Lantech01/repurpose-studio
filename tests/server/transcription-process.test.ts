// @vitest-environment node

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTranscriptionCache,
  deriveTranscriptionCacheKey,
  prepareTranscriptionRequest,
  resolveTranscriptionCachePaths,
} from "@/lib/repurpose/transcription-cache.server";
import {
  buildTranscriptionAudioArguments,
  createTranscriptionProcessor,
  parseEngineEventStream,
  transcriptionDeadlines,
  TranscriptionProcessError,
} from "@/lib/repurpose/transcription-process.server";
import { parseTranscriptionResult, type TranscriptionResult } from "@/lib/repurpose/transcription-contract";
import { createNodeProcessAdapter, terminateOwnedProcessTree } from "@/lib/repurpose/ffmpeg-process.server";

const roots: string[] = [];
const HASH_A = "a".repeat(64);
const OBSERVER_ID = "00000000-0000-4000-8000-000000000001";

async function tempRoot(prefix = "repurpose-transcription-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function result(device: "cuda" | "cpu" = "cuda"): TranscriptionResult {
  return {
    words: [{ text: "ola", start: 0, end: 0.4 }],
    language: "pt",
    languageProbability: 0.99,
    device,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("transcription cache", () => {
  it.each([
    ["win32", { LOCALAPPDATA: "C:\\Local" }, "C:\\Users\\test", path.win32.join("C:\\Local", "Repurpose Studio")],
    ["win32", {}, "C:\\Users\\test", path.win32.join("C:\\Users\\test", "AppData", "Local", "Repurpose Studio")],
    ["linux", { XDG_CACHE_HOME: "/cache" }, "/home/test", "/cache/repurpose-studio"],
    ["darwin", {}, "/Users/test", "/Users/test/Library/Caches/Repurpose Studio"],
    ["linux", {}, "/home/test", "/home/test/.cache/repurpose-studio"],
  ] as const)("resolves model and transcript roots on %s", (platform, env, homeDir, expectedRoot) => {
    const paths = resolveTranscriptionCachePaths({ platform, env, homeDir });
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    expect(paths).toEqual({
      models: pathApi.join(expectedRoot, "models"),
      transcripts: pathApi.join(expectedRoot, "transcripts"),
    });
  });

  it("keys immutable results by verified source and every engine setting", () => {
    const base = {
      sourceHash: HASH_A,
      language: "pt" as const,
      modelId: "model",
      modelRevision: "revision",
      engineSchema: "schema",
      decodingSettings: { beamSize: 5, wordTimestamps: true },
    };
    const first = deriveTranscriptionCacheKey(base);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveTranscriptionCacheKey({ ...base })).toBe(first);
    expect(deriveTranscriptionCacheKey({ ...base, language: "auto" })).not.toBe(first);
    expect(deriveTranscriptionCacheKey({ ...base, modelRevision: "other" })).not.toBe(first);
    expect(deriveTranscriptionCacheKey({ ...base, decodingSettings: { beamSize: 1, wordTimestamps: true } })).not.toBe(first);
  });

  it("prepares a path-scoped admission key without reading cache or source bytes", async () => {
    const sourcePath = path.join("C:\\managed", `${HASH_A}.mp4`);
    const resolvePath = vi.fn().mockResolvedValue(sourcePath);
    const prepared = await prepareTranscriptionRequest(
      { observerId: OBSERVER_ID, path: sourcePath, language: "pt" },
      new AbortController().signal,
      { resolvePath },
    );
    const other = await prepareTranscriptionRequest(
      { observerId: OBSERVER_ID, path: sourcePath.replace(/\.mp4$/, ".mov"), language: "pt" },
      new AbortController().signal,
      { resolvePath: vi.fn().mockResolvedValue(sourcePath.replace(/\.mp4$/, ".mov")) },
    );

    expect(resolvePath).toHaveBeenCalledOnce();
    expect(prepared.expectedSourceHash).toBe(HASH_A);
    expect(prepared.cacheKey).toBe(other.cacheKey);
    expect(prepared.admissionKey).not.toBe(other.admissionKey);
    expect(prepared).not.toHaveProperty("sourceBytes");
  });

  it("rejects invalid managed paths and admission cancellation safely", async () => {
    await expect(prepareTranscriptionRequest(
      { observerId: OBSERVER_ID, path: "C:\\private\\video.mp4", language: "pt" },
      new AbortController().signal,
      { resolvePath: vi.fn().mockResolvedValue(null) },
    )).rejects.toMatchObject({ code: "TRANSCRIPTION_SOURCE_INVALID" });

    const controller = new AbortController();
    controller.abort();
    await expect(prepareTranscriptionRequest(
      { observerId: OBSERVER_ID, path: "ignored", language: "pt" },
      controller.signal,
      { resolvePath: vi.fn() },
    )).rejects.toMatchObject({ code: "TRANSCRIPTION_CANCELLED" });
  });

  it("validates bounded cache hits, removes corruption, and publishes atomically without replacement", async () => {
    const directory = path.join(await tempRoot(), "cache");
    const cache = createTranscriptionCache({ directory });
    const key = "b".repeat(64);

    expect(await cache.get(key, 10)).toBeNull();
    await cache.publish(key, result());
    expect(await cache.get(key, 10)).toEqual(result());
    await expect(cache.publish(key, result("cpu"))).rejects.toMatchObject({ code: "TRANSCRIPTION_INVALID_OUTPUT" });
    expect(await cache.get(key, 10)).toEqual(result());

    await writeFile(path.join(directory, `${key}.json`), "{bad-json");
    expect(await cache.get(key, 10)).toBeNull();
    expect(await readdir(directory)).toEqual([]);

    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${key}.json`), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(await cache.get(key, 10)).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("transcription process protocol", () => {
  it("turns progress callback failures into owned-process rejection instead of an event-loop throw", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      stdio: [],
      exitCode: null,
      signalCode: null,
      killed: false,
      connected: false,
      spawnargs: [],
      spawnfile: "engine",
      kill: vi.fn(() => true),
      send: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn(),
      ref: vi.fn(),
    });
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
    const adapter = createNodeProcessAdapter({
      platform: "win32",
      spawnProcess: vi.fn(() => child) as never,
    });
    const spawned = adapter.run("engine", [], {
      onStdout: () => {
        throw new Error("invalid protocol line");
      },
    });

    expect(() => child.stdout.write("bad event\n")).not.toThrow();
    await expect(spawned.completion).rejects.toThrow("invalid protocol line");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not reject adapter completion on a termination error event before taskkill and child close", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      killed: false,
      kill: vi.fn(() => true),
    });
    const taskkill = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn(() => true) });
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(taskkill);
    const adapter = createNodeProcessAdapter({ platform: "win32", spawnProcess: spawnProcess as never });
    const spawned = adapter.run("engine", []);
    let settled = false;
    const outcome = spawned.completion.catch((error: unknown) => error).finally(() => { settled = true; });
    const termination = spawned.kill();

    child.emit("error", new Error("kill raced with exit"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    taskkill.emit("close", 0);
    child.emit("close", null, "SIGKILL");
    await termination;
    await expect(outcome).resolves.toMatchObject({ message: "kill raced with exit" });
  });

  it("awaits both taskkill and the owned Windows child close", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, kill: vi.fn() });
    const taskkill = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn() });
    const spawnTaskkill = vi.fn(() => taskkill);
    let settled = false;
    const termination = terminateOwnedProcessTree(child as never, "win32", spawnTaskkill as never)
      .finally(() => { settled = true; });

    expect(spawnTaskkill).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "42", "/T", "/F"],
      expect.objectContaining({ windowsHide: true, shell: false }),
    );
    taskkill.emit("close", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(termination).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("escalates a completed taskkill when the owned Windows child does not close within grace", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, kill: vi.fn() });
    const taskkill = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn() });
    const termination = terminateOwnedProcessTree(child as never, "win32", vi.fn(() => taskkill) as never, {
      graceMs: 100,
    });

    taskkill.emit("close", 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
    await expect(termination).resolves.toBeUndefined();
  });

  it("signals only the owned POSIX group, escalates after grace, and awaits child close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 43, exitCode: null, kill: vi.fn() });
    const killProcessGroup = vi.fn();
    let settled = false;
    const termination = terminateOwnedProcessTree(child as never, "linux", undefined, {
      graceMs: 100,
      killProcessGroup,
    }).finally(() => { settled = true; });

    expect(killProcessGroup).toHaveBeenCalledWith(-43, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    expect(killProcessGroup).toHaveBeenLastCalledWith(-43, "SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(termination).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("never targets a process tree without an owned child PID", async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, kill: vi.fn() });
    const spawnTaskkill = vi.fn();
    const termination = terminateOwnedProcessTree(child as never, "win32", spawnTaskkill as never);

    expect(spawnTaskkill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", null, "SIGTERM");
    await expect(termination).resolves.toBeUndefined();
  });

  it("builds the exact mono 16 kHz PCM extraction arguments and scales deadlines", () => {
    expect(buildTranscriptionAudioArguments("verified.mp4", "audio.wav")).toEqual([
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", "verified.mp4",
      "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-progress", "pipe:1", "-nostats", "audio.wav",
    ]);
    expect(transcriptionDeadlines(60)).toEqual({ preparationMs: 1_800_000, extractionMs: 600_000, setupMs: 1_800_000, transcriptionMs: 1_800_000 });
    expect(transcriptionDeadlines(7_200)).toEqual({ preparationMs: 1_800_000, extractionMs: 3_600_000, setupMs: 1_800_000, transcriptionMs: 28_800_000 });
  });

  it("accepts exact CUDA, CPU, and fallback grammars while reporting state", () => {
    const reports: unknown[] = [];
    const parsed = parseEngineEventStream([
      '{"type":"phase","phase":"downloading-model"}',
      '{"type":"model-ready","device":"cuda"}',
      '{"type":"progress","phase":"transcribing","device":"cuda","progress":0.4}',
      '{"type":"warning","code":"GPU_FALLBACK"}',
      '{"type":"model-ready","device":"cpu"}',
      '{"type":"progress","phase":"transcribing","device":"cpu","progress":0.1}',
      '{"type":"completed","device":"cpu"}',
    ], (report) => reports.push(report));

    expect(parsed).toEqual({ terminal: "completed", device: "cpu", engineError: null });
    expect(reports).toContainEqual({ warning: { code: "TRANSCRIPTION_GPU_FALLBACK", message: "GPU indisponível; continuando na CPU." } });
    expect(reports).toContainEqual({ phase: "transcribing", device: "cpu", progress: 0.1 });

    expect(() => parseEngineEventStream([
      '{"type":"phase","phase":"downloading-model"}',
      '{"type":"model-ready","device":"cpu"}',
      '{"type":"completed","device":"cpu"}',
    ], vi.fn())).not.toThrow();
    expect(() => parseEngineEventStream([
      '{"type":"phase","phase":"downloading-model"}',
      '{"type":"warning","code":"GPU_FALLBACK"}',
      '{"type":"model-ready","device":"cpu"}',
      '{"type":"completed","device":"cpu"}',
    ], vi.fn())).not.toThrow();
  });

  it.each([
    ["unknown keys", ['{"type":"phase","phase":"downloading-model","path":"C:/private"}']],
    ["oversized line", ["x".repeat(64 * 1024 + 1)]],
    ["progress before device", ['{"type":"phase","phase":"downloading-model"}', '{"type":"progress","phase":"transcribing","device":"cuda","progress":0.2}']],
    ["same-device progress regression", ['{"type":"phase","phase":"downloading-model"}', '{"type":"model-ready","device":"cuda"}', '{"type":"progress","phase":"transcribing","device":"cuda","progress":0.5}', '{"type":"progress","phase":"transcribing","device":"cuda","progress":0.4}']],
    ["missing terminal", ['{"type":"phase","phase":"downloading-model"}']],
    ["event after terminal", ['{"type":"error","code":"INVALID_INPUT"}', '{"type":"phase","phase":"downloading-model"}']],
    ["duplicate phase", ['{"type":"phase","phase":"downloading-model"}', '{"type":"phase","phase":"downloading-model"}']],
  ])("rejects %s", (_label, lines) => {
    expect(() => parseEngineEventStream(lines, vi.fn())).toThrowError(TranscriptionProcessError);
  });
});

describe("verified transcription pipeline", () => {
  async function fixture() {
    const root = await tempRoot();
    const contents = Buffer.from("verified source bytes");
    const sourceHash = createHash("sha256").update(contents).digest("hex");
    const sourcePath = path.join(root, `${sourceHash}.mp4`);
    await writeFile(sourcePath, contents);
    const cache = createTranscriptionCache({ directory: path.join(root, "cache") });
    const prepared = {
      sourcePath,
      expectedSourceHash: sourceHash,
      language: "pt" as const,
      admissionKey: `path:${sourcePath}`,
      cacheKey: deriveTranscriptionCacheKey({ sourceHash, language: "pt" }),
    };
    return { root, contents, sourceHash, sourcePath, cache, prepared };
  }

  it("hashes before cache lookup, inspects/extracts only a private snapshot, rechecks source, and cleans all temp files", async () => {
    const setup = await fixture();
    await setup.cache.publish(setup.prepared.cacheKey, result());
    const order: string[] = [];
    const cache = {
      get: vi.fn(async (...args: Parameters<typeof setup.cache.get>) => {
        order.push("cache");
        return setup.cache.get(...args);
      }),
      publish: vi.fn(setup.cache.publish),
    };
    const inspect = vi.fn(async (snapshotPath: string) => {
      order.push("inspect");
      expect(snapshotPath).not.toBe(setup.sourcePath);
      expect(await readFile(snapshotPath)).toEqual(setup.contents);
      return { durationSec: 12, audio: { codec: "aac" } };
    });
    const extract = vi.fn();
    const runEngine = vi.fn();
    const processor = createTranscriptionProcessor({
      cache,
      inspect,
      extract,
      runEngine,
      temporaryRoot: setup.root,
      onSourceHashed: () => order.push("hash"),
    });

    await expect(processor.run(setup.prepared, new AbortController().signal, vi.fn())).resolves.toEqual(result());
    expect(order).toEqual(["hash", "inspect", "cache"]);
    expect(extract).not.toHaveBeenCalled();
    expect(runEngine).not.toHaveBeenCalled();
    expect((await readdir(setup.root)).filter((name) => name.startsWith("transcription-"))).toEqual([]);
  });

  it("rejects a filename/content mismatch before cache lookup or children", async () => {
    const setup = await fixture();
    setup.prepared.expectedSourceHash = HASH_A;
    const get = vi.fn();
    const inspect = vi.fn();
    const processor = createTranscriptionProcessor({
      cache: { get, publish: vi.fn() }, inspect, extract: vi.fn(), runEngine: vi.fn(), temporaryRoot: setup.root,
    });
    await expect(processor.run(setup.prepared, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "TRANSCRIPTION_SOURCE_CHANGED" });
    expect(get).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("maps an unreadable verified snapshot to a source error before extraction", async () => {
    const setup = await fixture();
    const extract = vi.fn();
    const processor = createTranscriptionProcessor({
      cache: setup.cache,
      temporaryRoot: setup.root,
      inspect: vi.fn(async () => {
        throw new Error("ffprobe rejected private snapshot path");
      }),
      extract,
      runEngine: vi.fn(),
    });

    await expect(processor.run(setup.prepared, new AbortController().signal, vi.fn()))
      .rejects.toMatchObject({ code: "TRANSCRIPTION_SOURCE_INVALID" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("uses the verified snapshot through a replace/restore race and rejects persistent replacement before publication", async () => {
    const setup = await fixture();
    const replacement = Buffer.from("replacement bytes");
    const backup = path.join(setup.root, "backup.mp4");
    let extracted = Buffer.alloc(0);
    const processor = createTranscriptionProcessor({
      cache: setup.cache,
      temporaryRoot: setup.root,
      inspect: vi.fn(async () => ({ durationSec: 12, audio: { codec: "aac" } })),
      extract: vi.fn(async ({ inputPath, outputPath }) => {
        await rename(setup.sourcePath, backup);
        await writeFile(setup.sourcePath, replacement);
        extracted = await readFile(inputPath);
        await writeFile(outputPath, "wav");
        await rm(setup.sourcePath);
        await rename(backup, setup.sourcePath);
      }),
      runEngine: vi.fn(async ({ outputPath, report }) => {
        report('{"type":"phase","phase":"downloading-model"}\n');
        report('{"type":"model-ready","device":"cuda"}\n');
        await writeFile(outputPath, JSON.stringify(result()));
        report('{"type":"completed","device":"cuda"}\n');
        return { code: 0, stderr: "" };
      }),
    });
    await expect(processor.run(setup.prepared, new AbortController().signal, vi.fn())).resolves.toEqual(result());
    expect(extracted).toEqual(setup.contents);

    await rm(path.join(setup.root, "cache"), { recursive: true, force: true });
    const changed = createTranscriptionProcessor({
      cache: setup.cache,
      temporaryRoot: setup.root,
      inspect: vi.fn(async () => ({ durationSec: 12, audio: { codec: "aac" } })),
      extract: vi.fn(async ({ outputPath }) => {
        await writeFile(outputPath, "wav");
      }),
      runEngine: vi.fn(async ({ outputPath, report }) => {
        report('{"type":"phase","phase":"downloading-model"}\n');
        report('{"type":"model-ready","device":"cuda"}\n');
        await writeFile(outputPath, JSON.stringify(result()));
        await writeFile(setup.sourcePath, replacement);
        report('{"type":"completed","device":"cuda"}\n');
        return { code: 0, stderr: "" };
      }),
    });
    await expect(changed.run(setup.prepared, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "TRANSCRIPTION_SOURCE_CHANGED" });
    expect(await setup.cache.get(setup.prepared.cacheKey, 12)).toBeNull();
  });

  it("enforces inspection limits, engine publication ordering, result bounds, cancellation, and deterministic cleanup", async () => {
    const setup = await fixture();
    const base = {
      cache: setup.cache,
      temporaryRoot: setup.root,
      extract: vi.fn(async ({ outputPath }: { outputPath: string }) => writeFile(outputPath, "wav")),
    };
    const tooLong = createTranscriptionProcessor({
      ...base,
      inspect: vi.fn(async () => ({ durationSec: 7_201, audio: { codec: "aac" } })),
      runEngine: vi.fn(),
    });
    await expect(tooLong.run(setup.prepared, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "TRANSCRIPTION_SOURCE_TOO_LONG" });

    const missingAudio = createTranscriptionProcessor({
      ...base,
      inspect: vi.fn(async () => ({ durationSec: 12, audio: null })),
      runEngine: vi.fn(),
    });
    await expect(missingAudio.run(setup.prepared, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "TRANSCRIPTION_AUDIO_MISSING" });

    const earlyCompletion = createTranscriptionProcessor({
      ...base,
      inspect: vi.fn(async () => ({ durationSec: 12, audio: { codec: "aac" } })),
      runEngine: vi.fn(async ({ report }) => {
        report('{"type":"phase","phase":"downloading-model"}\n');
        report('{"type":"model-ready","device":"cuda"}\n');
        report('{"type":"completed","device":"cuda"}\n');
        return { code: 0, stderr: "" };
      }),
    });
    await expect(earlyCompletion.run(setup.prepared, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "TRANSCRIPTION_INVALID_OUTPUT" });

    const controller = new AbortController();
    controller.abort();
    await expect(earlyCompletion.run(setup.prepared, controller.signal, vi.fn())).rejects.toMatchObject({ code: "TRANSCRIPTION_CANCELLED" });
    expect((await readdir(setup.root)).filter((name) => name.startsWith("transcription-"))).toEqual([]);
  });

  it.each(["cancellation", "timeout"] as const)(
    "keeps the workspace until extraction tree termination is confirmed after %s",
    async (cause) => {
      const setup = await fixture();
      const extractionStarted = deferred<void>();
      const treeTerminated = deferred<void>();
      const timers: Array<() => void> = [];
      const controller = new AbortController();
      const processor = createTranscriptionProcessor({
        cache: setup.cache,
        temporaryRoot: setup.root,
        inspect: vi.fn(async () => ({ durationSec: 12, audio: { codec: "aac" } })),
        extract: vi.fn(async ({ signal }) => {
          extractionStarted.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          await treeTerminated.promise;
          throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
        }),
        runEngine: vi.fn(),
        setTimer: ((callback: () => void) => {
          timers.push(callback);
          return {} as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimer: vi.fn() as unknown as typeof clearTimeout,
      });
      let settled = false;
      const outcome = processor.run(setup.prepared, controller.signal, vi.fn())
        .catch((error: unknown) => error)
        .finally(() => { settled = true; });

      await extractionStarted.promise;
      if (cause === "cancellation") controller.abort();
      else timers.at(-1)!();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(settled).toBe(false);
      expect((await readdir(setup.root)).some((name) => name.startsWith("transcription-"))).toBe(true);

      treeTerminated.resolve();
      await expect(outcome).resolves.toMatchObject({
        code: cause === "cancellation"
          ? "TRANSCRIPTION_CANCELLED"
          : "TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT",
      });
      expect((await readdir(setup.root)).filter((name) => name.startsWith("transcription-"))).toEqual([]);
    },
  );

  it("maps engine terminal errors and rejects mismatched or oversized output", async () => {
    const setup = await fixture();
    const run = async (engine: (input: { outputPath: string; report(chunk: string): void }) => Promise<{ code: number; stderr: string }>) => createTranscriptionProcessor({
      cache: setup.cache,
      temporaryRoot: setup.root,
      inspect: vi.fn(async () => ({ durationSec: 12, audio: { codec: "aac" } })),
      extract: vi.fn(async ({ outputPath }) => writeFile(outputPath, "wav")),
      runEngine: vi.fn(engine),
    }).run(setup.prepared, new AbortController().signal, vi.fn());

    await expect(run(async ({ report }) => {
      report('{"type":"phase","phase":"downloading-model"}\n');
      report('{"type":"error","code":"MODEL_DOWNLOAD_FAILED"}\n');
      return { code: 1, stderr: "C:/private/model" };
    })).rejects.toMatchObject({ code: "TRANSCRIPTION_MODEL_DOWNLOAD_FAILED" });

    await expect(run(async ({ outputPath, report }) => {
      report('{"type":"phase","phase":"downloading-model"}\n');
      report('{"type":"model-ready","device":"cuda"}\n');
      await writeFile(outputPath, JSON.stringify(result("cpu")));
      report('{"type":"completed","device":"cuda"}\n');
      return { code: 0, stderr: "" };
    })).rejects.toMatchObject({ code: "TRANSCRIPTION_INVALID_OUTPUT" });

    await expect(run(async ({ outputPath, report }) => {
      report('{"type":"phase","phase":"downloading-model"}\n');
      report('{"type":"model-ready","device":"cuda"}\n');
      await writeFile(outputPath, Buffer.alloc(16 * 1024 * 1024 + 1));
      report('{"type":"completed","device":"cuda"}\n');
      return { code: 0, stderr: "" };
    })).rejects.toMatchObject({ code: "TRANSCRIPTION_INVALID_OUTPUT" });

    expect(() => parseTranscriptionResult({ ...result(), words: Array.from({ length: 100_001 }, () => ({ text: "x", start: 0, end: 1 })) })).toThrow();
  });
});
