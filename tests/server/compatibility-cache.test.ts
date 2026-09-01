// @vitest-environment node

import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const syncFileSystem = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  syncFileSystem.readFileSync.mockImplementation(actual.readFileSync);
  syncFileSystem.statSync.mockImplementation(actual.statSync);
  return {
    ...actual,
    readFileSync: syncFileSystem.readFileSync,
    statSync: syncFileSystem.statSync,
  };
});

import {
  COMPATIBILITY_CACHE_MAX_BYTES,
  COMPATIBILITY_CACHE_TTL_MS,
  createCompatibilityCache,
  getProcessCompatibilityCache,
  validateCompatibilityOutput,
} from "@/lib/repurpose/compatibility-cache.server";
import {
  buildCompatibilityArguments,
  boundProcessDiagnostic,
  createFfmpegProcessRunner,
  encoderCandidates,
  MAX_PROCESS_DIAGNOSTIC_CHARS,
  parseFfmpegProgress,
  type SpawnedProcess,
} from "@/lib/repurpose/ffmpeg-process.server";
import { inspectMedia } from "@/lib/repurpose/media-inspection.server";
import type { MediaInspection } from "@/lib/repurpose/media-types";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  }));
});

function media(overrides: Partial<MediaInspection> = {}): MediaInspection {
  return {
    fingerprint: "a".repeat(64),
    container: "mov,mp4",
    extension: ".mov",
    size: 1_024,
    durationSec: 3,
    video: {
      codec: "hevc",
      codecTag: "hvc1",
      profile: "Main",
      pixelFormat: "yuv420p",
      width: 320,
      height: 180,
      fps: 30,
    },
    audio: { codec: "aac", channels: 1, sampleRate: 48_000 },
    ...overrides,
  };
}

function compatibleOutput(input = media(), overrides: Partial<MediaInspection> = {}): MediaInspection {
  return {
    ...input,
    fingerprint: "b".repeat(64),
    extension: ".mp4",
    video: { ...input.video, codec: "h264", pixelFormat: "yuv420p" },
    audio: input.audio ? { ...input.audio, codec: "aac" } : null,
    ...overrides,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-compat-test-"));
  roots.push(root);
  return root;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw lastError;
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

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type CompatibilityCacheOptions = Parameters<typeof createCompatibilityCache>[0];
type CompatibilityCacheModule = {
  getProcessCompatibilityCache: (options?: CompatibilityCacheOptions) => ReturnType<typeof createCompatibilityCache>;
};

async function importCompatibilityCacheModule(): Promise<CompatibilityCacheModule> {
  return await import("@/lib/repurpose/compatibility-cache.server") as unknown as CompatibilityCacheModule;
}

describe("ffmpeg compatibility process", () => {
  it("parses progress from both ffmpeg microsecond keys", () => {
    expect(parseFfmpegProgress("out_time_ms=1500000\n", 3)).toBeCloseTo(0.5);
    expect(parseFfmpegProgress("frame=2\nout_time_us=750000\n", 3)).toBeCloseTo(0.25);
    expect(parseFfmpegProgress("out_time_us=9000000\n", 3)).toBe(1);
  });

  it("orders and filters platform candidates without treating listing support as success", () => {
    const listed = new Set(["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
    expect(encoderCandidates("win32", listed)).toEqual([
      "h264_nvenc", "h264_qsv", "h264_amf", "libx264",
    ]);
    expect(encoderCandidates("darwin", listed)).toEqual(["libx264"]);
    expect(encoderCandidates("linux", listed)).toEqual(["h264_nvenc", "h264_qsv", "libx264"]);
  });

  it("uses exact common mappings, disables autorotate before input, and preserves VFR timestamps", () => {
    const args = buildCompatibilityArguments({
      inputPath: "input.mov",
      outputPath: "output.partial.mp4",
      encoder: "libx264",
      inspection: media(),
    });
    expect(args).toEqual(expect.arrayContaining([
      "-i", "input.mov", "-map", "0:v:0", "-map", "0:a:0?", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-c:v", "libx264",
      "-preset", "medium", "-crf", "18", "output.partial.mp4",
    ]));
    expect(args.indexOf("-noautorotate")).toBeLessThan(args.indexOf("-i"));
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-r");
    expect(buildCompatibilityArguments({
      inputPath: "vfr.mov",
      outputPath: "vfr.partial.mp4",
      encoder: "libx264",
      inspection: media({ video: { ...media().video, fps: 29.97 } }),
    })).not.toContain("-r");
  });

  it("bounds captured process diagnostics while progress remains incremental", () => {
    const huge = "prefix-" + "x".repeat(MAX_PROCESS_DIAGNOSTIC_CHARS * 3) + "-tail";
    const bounded = boundProcessDiagnostic("old", huge);

    expect(bounded.length).toBe(MAX_PROCESS_DIAGNOSTIC_CHARS);
    expect(bounded.endsWith("-tail")).toBe(true);
    expect(bounded).not.toContain("prefix-");
  });

  it("discovers encoders once, falls through actual hardware failures, and uses libx264", async () => {
    const commands: string[][] = [];
    const adapter = {
      run: vi.fn((_executable: string, args: string[]): SpawnedProcess => {
        commands.push(args);
        if (args.includes("-encoders")) {
          return { completion: Promise.resolve({ code: 0, stdout: " V..... h264_nvenc\n V..... h264_qsv\n V..... libx264\n", stderr: "" }), kill: vi.fn() };
        }
        const encoder = args[args.indexOf("-c:v") + 1];
        return {
          completion: Promise.resolve({ code: encoder === "libx264" ? 0 : 1, stdout: "", stderr: "device failed" }),
          kill: vi.fn(),
        };
      }),
    };
    const runner = createFfmpegProcessRunner({ adapter, platform: "win32" });

    await runner.encode({
      inputPath: "input.mov",
      outputPath: "one.partial.mp4",
      inspection: media(),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });
    await runner.encode({
      inputPath: "input.mov",
      outputPath: "two.partial.mp4",
      inspection: media(),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(adapter.run.mock.calls.filter(([, args]) => args.includes("-encoders"))).toHaveLength(1);
    expect(commands.filter((args) => args.includes("-c:v")).map((args) => args[args.indexOf("-c:v") + 1])).toEqual([
      "h264_nvenc", "h264_qsv", "libx264", "h264_nvenc", "h264_qsv", "libx264",
    ]);
  });

  it("kills only the currently active child when cancelled", async () => {
    const running = deferred<{ code: number; stdout: string; stderr: string }>();
    const discoveryKill = vi.fn();
    const encodeKill = vi.fn(() => running.resolve({ code: 1, stdout: "", stderr: "cancelled" }));
    const adapter = {
      run: vi.fn((_executable: string, args: string[]): SpawnedProcess => args.includes("-encoders")
        ? { completion: Promise.resolve({ code: 0, stdout: " V..... libx264\n", stderr: "" }), kill: discoveryKill }
        : { completion: running.promise, kill: encodeKill }),
    };
    const controller = new AbortController();
    const execution = createFfmpegProcessRunner({ adapter, platform: "linux" }).encode({
      inputPath: "input.mov",
      outputPath: "output.partial.mp4",
      inspection: media(),
      signal: controller.signal,
      onProgress: vi.fn(),
    });
    await eventually(() => expect(adapter.run).toHaveBeenCalledTimes(2));

    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "COMPATIBILITY_CANCELLED" });
    expect(encodeKill).toHaveBeenCalledTimes(1);
    expect(discoveryKill).not.toHaveBeenCalled();
  });

  it("cancels stalled encoder discovery and retries discovery on a later start", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const discoveryStarted = deferred<void>();
    const stalledDiscovery = deferred<{ code: number; stdout: string; stderr: string }>();
    const stalledDiscoveryKill = vi.fn(() => {
      stalledDiscovery.resolve({ code: 1, stdout: "", stderr: "cancelled" });
    });
    const retryDiscoveryKill = vi.fn();
    let discoveryRuns = 0;
    let encodeRuns = 0;
    const adapter = {
      run: vi.fn((_executable: string, args: string[]): SpawnedProcess => {
        if (args.includes("-encoders")) {
          discoveryRuns += 1;
          if (discoveryRuns === 1) {
            discoveryStarted.resolve();
            return { completion: stalledDiscovery.promise, kill: stalledDiscoveryKill };
          }
          return {
            completion: Promise.resolve({ code: 0, stdout: " V..... libx264\n", stderr: "" }),
            kill: retryDiscoveryKill,
          };
        }
        encodeRuns += 1;
        const outputPath = args.at(-1)!;
        return {
          completion: writeFile(outputPath, "complete").then(() => ({ code: 0, stdout: "", stderr: "" })),
          kill: vi.fn(),
        };
      }),
    };
    const runner = createFfmpegProcessRunner({ adapter, platform: "linux" });
    const cache = createCompatibilityCache({
      cacheDir,
      processId: 515,
      randomUUID: (() => {
        let generation = 0;
        return () => `discovery-${++generation}`;
      })(),
      encode: (request) => runner.encode(request),
      inspectOutput: async () => compatibleOutput(),
    });
    const input = { originalPath: "source.mov", inspection: media() };

    const starting = cache.start(input);
    await discoveryStarted.promise;
    const cancelling = cache.cancel(fingerprint);
    let abortFailure: unknown;
    try {
      await eventually(() => expect(stalledDiscoveryKill).toHaveBeenCalledTimes(1));
    } catch (error) {
      abortFailure = error;
    } finally {
      stalledDiscovery.resolve({ code: 1, stdout: "", stderr: "forced test cleanup" });
      if (abortFailure) await Promise.allSettled([starting, cancelling]);
    }
    if (abortFailure) throw abortFailure;
    const [startState, cancelState] = await Promise.all([starting, cancelling]);

    expect({
      startStatus: startState.status,
      cancelStatus: cancelState.status,
      settledStatus: cache.get(fingerprint).status,
      discoveryRuns,
      encodeRuns,
      discoveryKills: stalledDiscoveryKill.mock.calls.length,
      artifacts: (await readdir(cacheDir)).filter((name) => name.endsWith(".partial.mp4") || name.endsWith("-compat-v1.mp4")),
    }).toEqual({
      startStatus: "queued",
      cancelStatus: "cancelled",
      settledStatus: "cancelled",
      discoveryRuns: 1,
      encodeRuns: 0,
      discoveryKills: 1,
      artifacts: [],
    });

    await cache.start(input);
    await eventually(() => expect(cache.get(fingerprint).status).toBe("ready"));
    await expect(cache.cancel(fingerprint)).resolves.toMatchObject({ status: "ready" });
    expect({ discoveryRuns, encodeRuns }).toEqual({ discoveryRuns: 2, encodeRuns: 1 });
    expect(stalledDiscoveryKill).toHaveBeenCalledTimes(1);
    expect(retryDiscoveryKill).not.toHaveBeenCalled();
    await expect(readFile(path.join(cacheDir, `${fingerprint}-compat-v1.mp4`), "utf8")).resolves.toBe("complete");
  });

  it("preserves coded geometry and Display Matrix rotation in a real conversion", async () => {
    const root = await tempRoot();
    const rotated = path.join(root, "rotated.mp4");
    const output = path.join(root, "rotated-output.partial.mp4");
    const fixture = path.resolve("tests", "fixtures", "generated", "h264-aac.mp4");
    const prepared = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-display_rotation:v:0", "90", "-i", fixture,
      "-map", "0", "-c", "copy", rotated,
    ], { shell: false, encoding: "utf8" });
    expect(prepared.status, prepared.stderr).toBe(0);
    const input = await inspectMedia(rotated);
    expect(input.video).toMatchObject({ width: 320, height: 180, rotationDeg: 90 });

    await createFfmpegProcessRunner({ platform: "darwin" }).encode({
      inputPath: rotated,
      outputPath: output,
      inspection: input,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });
    const converted = await inspectMedia(output);

    expect(converted.video).toMatchObject({ width: 320, height: 180, rotationDeg: 90 });
    expect(() => validateCompatibilityOutput(input, converted)).not.toThrow();
  });
});

describe("compatibility validation", () => {
  it("accepts ffmpeg normalization of the actual 4K60 source average rate", () => {
    const actualAverageFps = 358_800 / 5_983;
    const input = media({
      video: { ...media().video, width: 3_840, height: 2_160, fps: actualAverageFps },
    });
    const output = compatibleOutput(input, {
      video: { ...input.video, codec: "h264", fps: 60 },
    });

    expect(() => validateCompatibilityOutput(input, output)).not.toThrow();
  });

  it.each([
    ["codec", compatibleOutput(media(), { video: { ...media().video, codec: "hevc" } })],
    ["pixel format", compatibleOutput(media(), { video: { ...media().video, codec: "h264", pixelFormat: "yuv444p" } })],
    ["width", compatibleOutput(media(), { video: { ...media().video, codec: "h264", width: 318 } })],
    ["height", compatibleOutput(media(), { video: { ...media().video, codec: "h264", height: 178 } })],
    ["frame rate", compatibleOutput(media(), { video: { ...media().video, codec: "h264", fps: 30.04 } })],
    ["audio codec", compatibleOutput(media(), { audio: { codec: "mp3", channels: 1, sampleRate: 48_000 } })],
  ])("rejects an invalid %s", (_label, output) => {
    let thrown: unknown;
    try {
      validateCompatibilityOutput(media(), output);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "COMPATIBILITY_VALIDATION_FAILED" });
  });

  it("uses max(0.25 seconds, one source frame) as duration tolerance", () => {
    expect(() => validateCompatibilityOutput(media({ durationSec: 3 }), compatibleOutput(media(), { durationSec: 3.25 }))).not.toThrow();
    expect(() => validateCompatibilityOutput(media({ durationSec: 3 }), compatibleOutput(media(), { durationSec: 3.251 }))).toThrow();
    const slow = media({ durationSec: 3, video: { ...media().video, fps: 2 } });
    expect(() => validateCompatibilityOutput(slow, compatibleOutput(slow, { durationSec: 3.5 }))).not.toThrow();
  });

  it("does not require audio when the input is silent", () => {
    const silent = media({ audio: null });
    expect(() => validateCompatibilityOutput(silent, compatibleOutput(silent, { audio: null }))).not.toThrow();
  });

  it("rejects a changed display rotation even when coded dimensions match", () => {
    const input = media({ video: { ...media().video, rotationDeg: 90 } });
    const output = compatibleOutput(input, { video: { ...input.video, codec: "h264", rotationDeg: 0 } });

    expect(() => validateCompatibilityOutput(input, output)).toThrowError(/validation/i);
  });
});

describe("compatibility cache lifecycle", () => {
  it("reuses one process-global cache and active job across module reload", async () => {
    const cacheDir = await tempRoot();
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "partial");
      await gate.promise;
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const firstModule = await importCompatibilityCacheModule();
    const first = firstModule.getProcessCompatibilityCache({
      cacheDir,
      encode,
      inspectOutput: async () => compatibleOutput(),
      lockPollMs: 2,
    });
    await first.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(encode).toHaveBeenCalledTimes(1));

    vi.resetModules();
    const secondModule = await importCompatibilityCacheModule();
    const duplicateEncode = vi.fn();
    const second = secondModule.getProcessCompatibilityCache({
      cacheDir,
      encode: duplicateEncode,
      inspectOutput: async () => compatibleOutput(),
    });
    await second.start({ originalPath: "source.mov", inspection: media() });

    expect(second).toBe(first);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(duplicateEncode).not.toHaveBeenCalled();
    gate.resolve();
    await eventually(() => expect(second.get(media().fingerprint).status).toBe("ready"));
  });

  it("maps equivalent spellings to one normalized cache directory identity", async () => {
    const cacheDir = await tempRoot();
    const cacheModule = await importCompatibilityCacheModule();
    const first = cacheModule.getProcessCompatibilityCache({ cacheDir });
    const dotted = cacheModule.getProcessCompatibilityCache({ cacheDir: path.join(cacheDir, ".") });
    const caseVariant = process.platform === "win32"
      ? cacheModule.getProcessCompatibilityCache({ cacheDir: cacheDir.toUpperCase() })
      : first;

    expect(dotted).toBe(first);
    expect(caseVariant).toBe(first);
  });

  it("cancels and restarts the exact shared job through a reloaded module reference", async () => {
    const cacheDir = await tempRoot();
    const encodeStarted = deferred<string>();
    let invocation = 0;
    const encode = vi.fn(async ({ outputPath, signal }) => {
      invocation += 1;
      await writeFile(outputPath, invocation === 1 ? "partial" : "complete");
      if (invocation === 1) {
        encodeStarted.resolve(outputPath);
        await new Promise<void>((_resolve, reject) => {
          const cancel = () => reject(Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" }));
          if (signal.aborted) cancel();
          else signal.addEventListener("abort", cancel, { once: true });
        });
      }
      return { encoder: "libx264" };
    });
    const firstModule = await importCompatibilityCacheModule();
    const first = firstModule.getProcessCompatibilityCache({
      cacheDir,
      encode,
      inspectOutput: async () => compatibleOutput(),
      randomUUID: () => `hmr-${invocation + 1}`,
      lockPollMs: 2,
    });
    await first.start({ originalPath: "source.mov", inspection: media() });
    const partialPath = await encodeStarted.promise;

    vi.resetModules();
    const secondModule = await importCompatibilityCacheModule();
    const second = secondModule.getProcessCompatibilityCache({ cacheDir });
    expect(second).toBe(first);
    await expect(second.cancel(media().fingerprint)).resolves.toMatchObject({ status: "cancelled" });
    await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(first.get(media().fingerprint).status).toBe("cancelled");

    await second.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(first.get(media().fingerprint).status).toBe("ready"));
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("does not perform shared synchronous I/O while a local job is active", async () => {
    const cacheDir = await tempRoot();
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath }) => {
      await gate.promise;
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const cache = createCompatibilityCache({ cacheDir, encode, inspectOutput: async () => compatibleOutput() });
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(encode).toHaveBeenCalledTimes(1));
    syncFileSystem.readFileSync.mockClear();
    syncFileSystem.statSync.mockClear();

    expect(cache.get(media().fingerprint)).toMatchObject({ status: "building" });

    expect(syncFileSystem.statSync).not.toHaveBeenCalled();
    expect(syncFileSystem.readFileSync).not.toHaveBeenCalled();
    gate.resolve();
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("ready"));
  });

  it("deduplicates simultaneous starts, publishes atomically, reports progress, and reuses the final", async () => {
    const cacheDir = await tempRoot();
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath, onProgress }: { outputPath: string; onProgress: (progress: number) => void }) => {
      onProgress(0.4);
      await gate.promise;
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const inspectOutput = vi.fn(async () => compatibleOutput());
    const cache = createCompatibilityCache({ cacheDir, encode, inspectOutput, randomUUID: () => "job-one", processId: 42 });
    const input = { originalPath: path.join(cacheDir, "source.mov"), inspection: media() };

    const [first, second] = await Promise.all([cache.start(input), cache.start(input)]);
    expect([first.status, second.status].every((status) => status === "queued" || status === "building")).toBe(true);
    await eventually(() => expect(cache.get(input.inspection.fingerprint)).toMatchObject({ status: "building", progress: 0.4 }));
    expect(encode).toHaveBeenCalledTimes(1);
    const partialPath = encode.mock.calls[0][0].outputPath;
    expect(partialPath).toContain(".42.job-one.partial.mp4");

    gate.resolve();
    await eventually(() => expect(cache.get(input.inspection.fingerprint)).toMatchObject({ status: "ready" }));
    const ready = cache.get(input.inspection.fingerprint);
    expect(ready.workingPath).toBe(path.join(cacheDir, `${input.inspection.fingerprint}-compat-v1.mp4`));
    await expect(stat(ready.workingPath!)).resolves.toMatchObject({ size: 8 });
    await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await cache.start(input)).toMatchObject({ status: "ready", workingPath: ready.workingPath });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(inspectOutput).toHaveBeenCalled();
  });

  it("cancels the globally shared job, removes only its partial, and restarts after cancellation", async () => {
    const cacheDir = await tempRoot();
    const unrelated = path.join(cacheDir, "unrelated.partial.mp4");
    await writeFile(unrelated, "keep");
    let invocation = 0;
    const encode = vi.fn(async ({ outputPath, signal }: { outputPath: string; signal: AbortSignal }) => {
      invocation += 1;
      if (invocation === 1) {
        await writeFile(outputPath, "partial");
        if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" });
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" })), { once: true }));
      }
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const cache = createCompatibilityCache({ cacheDir, encode, inspectOutput: async () => compatibleOutput(), randomUUID: () => `job-${invocation + 1}` });
    const input = { originalPath: path.join(cacheDir, "source.mov"), inspection: media() };

    await Promise.all([cache.start(input), cache.start(input)]);
    await eventually(() => expect(cache.get(input.inspection.fingerprint).status).toBe("building"));
    await expect(cache.cancel(input.inspection.fingerprint)).resolves.toMatchObject({ status: "cancelled" });
    expect(cache.get(input.inspection.fingerprint)).toMatchObject({ status: "cancelled", progress: null });
    await expect(stat(unrelated)).resolves.toBeTruthy();
    expect((await readdir(cacheDir)).filter((name) => name.includes("job-1") && name.endsWith(".partial.mp4"))).toEqual([]);

    await cache.start(input);
    await eventually(() => expect(cache.get(input.inspection.fingerprint).status).toBe("ready"));
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("never publishes a final when every encoder fails", async () => {
    const cacheDir = await tempRoot();
    const cache = createCompatibilityCache({
      cacheDir,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "broken");
        throw Object.assign(new Error(`ffmpeg failed at ${outputPath}`), { code: "COMPATIBILITY_ENCODE_FAILED" });
      },
      inspectOutput: async () => compatibleOutput(),
    });
    const input = { originalPath: "private-source.mov", inspection: media() };

    await cache.start(input);
    await eventually(() => expect(cache.get(input.inspection.fingerprint).status).toBe("failed"));

    const state = cache.get(input.inspection.fingerprint);
    expect(state.error).toEqual({ code: "COMPATIBILITY_ENCODE_FAILED", message: "Video conversion failed." });
    expect(JSON.stringify(state)).not.toContain(cacheDir);
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".mp4"))).toEqual([]);
  });

  it("rejects invalid encoded output before publication", async () => {
    const cacheDir = await tempRoot();
    const cache = createCompatibilityCache({
      cacheDir,
      encode: async ({ outputPath }) => { await writeFile(outputPath, "invalid"); return { encoder: "libx264" }; },
      inspectOutput: async () => compatibleOutput(media(), { video: { ...media().video, codec: "hevc" } }),
    });
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("failed"));
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".mp4"))).toEqual([]);
  });

  it.each([
    ["FFPROBE_UNAVAILABLE", "unavailable"],
    ["MEDIA_PROBE_TIMEOUT", "failed"],
    ["MEDIA_PROBE_ABORTED", "cancelled"],
    ["MEDIA_CHANGED", "failed"],
    ["EBUSY", "failed"],
  ] as const)("preserves an existing master on transient %s inspection errors", async (code, statusName) => {
    const cacheDir = await tempRoot();
    const finalPath = path.join(cacheDir, `${media().fingerprint}-compat-v1.mp4`);
    await writeFile(finalPath, "existing-master");
    const encode = vi.fn(async () => { throw new Error("must not encode"); });
    const cache = createCompatibilityCache({
      cacheDir,
      encode,
      inspectOutput: async () => { throw Object.assign(new Error("transient private failure"), { code }); },
    });

    const state = await cache.start({ originalPath: "source.mov", inspection: media() });

    expect(state.status).toBe(statusName);
    expect(encode).not.toHaveBeenCalled();
    await expect(stat(finalPath)).resolves.toMatchObject({ size: 15 });
  });

  it("deletes and rebuilds an existing master only when inspection proves it invalid", async () => {
    const cacheDir = await tempRoot();
    const finalPath = path.join(cacheDir, `${media().fingerprint}-compat-v1.mp4`);
    await writeFile(finalPath, "invalid-master");
    const encode = vi.fn(async ({ outputPath }) => { await writeFile(outputPath, "rebuilt"); return { encoder: "libx264" }; });
    const inspectOutput = vi.fn(async (target: string) => {
      if (target === finalPath && inspectOutput.mock.calls.length === 1) {
        throw Object.assign(new Error("invalid"), { code: "MEDIA_INVALID" });
      }
      return compatibleOutput();
    });
    const cache = createCompatibilityCache({ cacheDir, encode, inspectOutput });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("ready"));

    expect(encode).toHaveBeenCalledTimes(1);
    await expect(stat(finalPath)).resolves.toMatchObject({ size: 7 });
  });

  it("cancels source-backed existing-final validation before encode is queued", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const inspectionStarted = deferred<AbortSignal | undefined>();
    const releaseInspection = deferred<void>();
    let finalInspections = 0;
    await writeFile(finalPath, "existing-master");
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "unexpected-encode");
      return { encoder: "libx264" };
    });
    const inspectOutput = vi.fn(async (target: string, controls?: { signal?: AbortSignal }) => {
      if (target === finalPath && finalInspections++ === 0) {
        inspectionStarted.resolve(controls?.signal);
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("cancelled"), { code: "MEDIA_PROBE_ABORTED" }));
          if (controls?.signal?.aborted) abort();
          else controls?.signal?.addEventListener("abort", abort, { once: true });
          void releaseInspection.promise.then(resolve);
        });
        throw Object.assign(new Error("invalid existing final"), { code: "MEDIA_INVALID" });
      }
      return compatibleOutput();
    });
    const first = getProcessCompatibilityCache({ cacheDir, encode, inspectOutput, randomUUID: () => "preflight" });
    const second = getProcessCompatibilityCache({ cacheDir });

    const starting = first.start({ originalPath: "source.mov", inspection: media() });
    const preflightSignal = await inspectionStarted.promise;
    const cancelled = await second.cancel(fingerprint);
    releaseInspection.resolve();
    const startState = await starting;
    await eventually(() => expect(["ready", "cancelled"]).toContain(first.get(fingerprint).status));

    expect({
      sharedReference: second === first,
      hasSignal: preflightSignal instanceof AbortSignal,
      signalAborted: preflightSignal?.aborted ?? false,
      cancelStatus: cancelled.status,
      startStatus: startState.status,
      settledStatus: first.get(fingerprint).status,
      encodeCalls: encode.mock.calls.length,
    }).toEqual({
      sharedReference: true,
      hasSignal: true,
      signalAborted: true,
      cancelStatus: "cancelled",
      startStatus: "cancelled",
      settledStatus: "cancelled",
      encodeCalls: 0,
    });
    expect((await readdir(cacheDir)).filter((name) => name.startsWith(`.${fingerprint}.`))).toEqual([]);

    await expect(first.start({ originalPath: "source.mov", inspection: media() })).resolves.toMatchObject({
      status: "ready",
      workingPath: finalPath,
    });
    expect(encode).not.toHaveBeenCalled();
  });

  it("stays cancelled when existing-final inspection resolves successfully after abort", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const inspectionStarted = deferred<AbortSignal | undefined>();
    const releaseInspection = deferred<void>();
    await writeFile(finalPath, "existing-master");
    const encode = vi.fn();
    const cache = createCompatibilityCache({
      cacheDir,
      randomUUID: () => "late-inspection",
      encode,
      inspectOutput: async (target, controls) => {
        if (target === finalPath) {
          inspectionStarted.resolve(controls?.signal);
          await releaseInspection.promise;
        }
        return compatibleOutput();
      },
    });

    const starting = cache.start({ originalPath: "source.mov", inspection: media() });
    const inspectionSignal = await inspectionStarted.promise;
    const cancelling = cache.cancel(fingerprint);
    await eventually(() => expect(inspectionSignal?.aborted).toBe(true));
    releaseInspection.resolve();
    const [startState, cancelState] = await Promise.all([starting, cancelling]);

    expect({
      startStatus: startState.status,
      cancelStatus: cancelState.status,
      settledStatus: cache.get(fingerprint).status,
      encodeCalls: encode.mock.calls.length,
    }).toEqual({
      startStatus: "cancelled",
      cancelStatus: "cancelled",
      settledStatus: "cancelled",
      encodeCalls: 0,
    });
    await expect(readFile(finalPath, "utf8")).resolves.toBe("existing-master");
  });

  it("cancels a shared start paused at its first await without creating work", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const mkdirReached = deferred<void>();
    const releaseMkdir = deferred<void>();
    let mkdirCalls = 0;
    const encode = vi.fn();
    const linkInternal = vi.fn(link);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const first = getProcessCompatibilityCache({
      cacheDir,
      encode,
      inspectOutput: vi.fn(),
      fileSystem: {
        mkdir: (async (target, options) => {
          mkdirCalls += 1;
          mkdirReached.resolve();
          await releaseMkdir.promise;
          return mkdir(target, options);
        }) as typeof mkdir,
        link: linkInternal,
      },
    });
    const second = getProcessCompatibilityCache({ cacheDir });

    const starting = first.start({ originalPath: "source.mov", inspection: media() });
    await mkdirReached.promise;
    const cancelling = second.cancel(fingerprint);
    releaseMkdir.resolve();
    const [startState, cancelState] = await Promise.all([starting, cancelling]);
    await eventually(() => expect(["cancelled", "failed", "ready"]).toContain(first.get(fingerprint).status));
    await eventually(async () => expect((await readdir(cacheDir)).filter((name) => name.startsWith(`.${fingerprint}.`))).toEqual([]));

    expect({
      sharedReference: second === first,
      startStatus: startState.status,
      cancelStatus: cancelState.status,
      settledStatus: first.get(fingerprint).status,
      mkdirCalls,
      linkCalls: linkInternal.mock.calls.length,
      encodeCalls: encode.mock.calls.length,
      intervalCalls: setIntervalSpy.mock.calls.length,
      internalArtifacts: (await readdir(cacheDir)).filter((name) => name.startsWith(`.${fingerprint}.`)),
    }).toEqual({
      sharedReference: true,
      startStatus: "cancelled",
      cancelStatus: "cancelled",
      settledStatus: "cancelled",
      mkdirCalls: 1,
      linkCalls: 0,
      encodeCalls: 0,
      intervalCalls: 0,
      internalArtifacts: [],
    });
    await expect(stat(path.join(cacheDir, `${fingerprint}-compat-v1.mp4`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares a pending cancelled start and permits one later fresh lifecycle", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const firstMkdirReached = deferred<void>();
    const releasePendingMkdir = deferred<void>();
    let mkdirCalls = 0;
    let lockLinkCalls = 0;
    let uuid = 0;
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const cache = getProcessCompatibilityCache({
      cacheDir,
      randomUUID: () => `pending-${++uuid}`,
      encode,
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        mkdir: (async (target, options) => {
          mkdirCalls += 1;
          firstMkdirReached.resolve();
          await releasePendingMkdir.promise;
          return mkdir(target, options);
        }) as typeof mkdir,
        link: async (existingPath, newPath) => {
          if (newPath.toString() === lockPath) lockLinkCalls += 1;
          return link(existingPath, newPath);
        },
      },
    });

    const firstStarting = cache.start({ originalPath: "source.mov", inspection: media() });
    await firstMkdirReached.promise;
    const cancelling = cache.cancel(fingerprint);
    const secondStarting = cache.start({ originalPath: "source.mov", inspection: media() });
    const pendingMkdirCalls = mkdirCalls;
    releasePendingMkdir.resolve();
    const [firstState, cancelState, secondState] = await Promise.all([firstStarting, cancelling, secondStarting]);
    await eventually(() => expect(["cancelled", "ready"]).toContain(cache.get(fingerprint).status));

    const freshState = await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(fingerprint).status).toBe("ready"));
    await expect(cache.cancel(fingerprint)).resolves.toMatchObject({ status: "ready" });

    expect({
      firstStatus: firstState.status,
      cancelStatus: cancelState.status,
      secondStatus: secondState.status,
      pendingMkdirCalls,
      totalMkdirCalls: mkdirCalls,
      lockLinkCalls,
      encodeCalls: encode.mock.calls.length,
      freshStatus: freshState.status,
      settledStatus: cache.get(fingerprint).status,
    }).toEqual({
      firstStatus: "cancelled",
      cancelStatus: "cancelled",
      secondStatus: "cancelled",
      pendingMkdirCalls: 1,
      totalMkdirCalls: 3,
      lockLinkCalls: 1,
      encodeCalls: 1,
      freshStatus: "queued",
      settledStatus: "ready",
    });
    expect((await readdir(cacheDir)).filter((name) => name.startsWith(`.${fingerprint}.`))).toEqual([]);
  });

  it("rejects an unsupported independent cache owner without duplicating encode work", async () => {
    const cacheDir = await tempRoot();
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "partial");
      await gate.promise;
      await writeFile(outputPath, "winner");
      return { encoder: "libx264" };
    });
    const options = {
      cacheDir,
      encode,
      inspectOutput: async () => compatibleOutput(),
      lockPollMs: 2,
      isProcessAlive: (pid: number) => pid === 101 || pid === 202,
    };
    const first = createCompatibilityCache({ ...options, processId: 101, randomUUID: () => "first" });
    const second = createCompatibilityCache({ ...options, processId: 202, randomUUID: () => "second" });
    const input = { originalPath: "source.mov", inspection: media() };

    const starts = await Promise.all([first.start(input), second.start(input)]);
    await eventually(() => expect(encode).toHaveBeenCalled());
    const callsBeforeRelease = encode.mock.calls.length;
    expect(starts).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", error: expect.objectContaining({ code: "COMPATIBILITY_CACHE_BUSY" }) }),
      expect.objectContaining({ status: "queued" }),
    ]));
    gate.resolve();
    const winner = starts[0].status === "queued" ? first : second;
    const rejected = winner === first ? second : first;
    await eventually(() => expect(winner.get(media().fingerprint).status).toBe("ready"));
    await eventually(async () => expect(stat(path.join(cacheDir, `.${media().fingerprint}.compat-v1.lock`))).rejects.toMatchObject({ code: "ENOENT" }));

    expect(callsBeforeRelease).toBe(1);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(rejected.get(media().fingerprint).status).toBe("failed");
    await rejected.start(input);
    expect(rejected.get(media().fingerprint)).toMatchObject({
      status: "ready",
      workingPath: path.join(cacheDir, `${media().fingerprint}-compat-v1.mp4`),
    });
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("requires source-backed validation before a fresh cache reports a published final ready", async () => {
    const cacheDir = await tempRoot();
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "partial");
      await gate.promise;
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const options = {
      cacheDir,
      encode,
      inspectOutput: async () => compatibleOutput(),
      lockPollMs: 2,
      isProcessAlive: () => true,
    };
    const owner = createCompatibilityCache({ ...options, processId: 101, randomUUID: () => "owner" });
    await owner.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(encode).toHaveBeenCalledTimes(1));

    const during = createCompatibilityCache({ ...options, processId: 202, randomUUID: () => "during" });
    expect(during.get(media().fingerprint)).toEqual({ status: "building", progress: null });

    gate.resolve();
    await eventually(() => expect(owner.get(media().fingerprint).status).toBe("ready"));
    await eventually(async () => expect(stat(path.join(cacheDir, `.${media().fingerprint}.compat-v1.lock`))).rejects.toMatchObject({ code: "ENOENT" }));
    const after = createCompatibilityCache({ ...options, processId: 303, randomUUID: () => "after" });
    expect(after.get(media().fingerprint)).toEqual({ status: "none", progress: null });
    await after.start({ originalPath: "source.mov", inspection: media() });
    expect(after.get(media().fingerprint)).toMatchObject({
      status: "ready",
      progress: 1,
      workingPath: path.join(cacheDir, `${media().fingerprint}-compat-v1.mp4`),
    });
  });

  it("bounds repeated GET-only polling while fresh instances reconcile shared publication", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.501.polling-owner.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const terminalPath = path.join(cacheDir, `.${fingerprint}.501.polling-owner.terminal.json`);
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    let now = Date.now();
    await writeFile(ownerPath, JSON.stringify({ pid: 501, token: "polling-owner" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    const options = {
      cacheDir,
      now: () => now,
      lockPollMs: 20,
      lockStaleMs: 1_000,
      isProcessAlive: () => true,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    };
    const polling = createCompatibilityCache(options);
    syncFileSystem.readFileSync.mockClear();
    syncFileSystem.statSync.mockClear();

    expect(polling.get(fingerprint)).toEqual({ status: "building", progress: null });
    const firstReads = {
      readFile: syncFileSystem.readFileSync.mock.calls.length,
      stat: syncFileSystem.statSync.mock.calls.length,
    };
    for (let poll = 0; poll < 20; poll += 1) {
      expect(polling.get(fingerprint)).toEqual({ status: "building", progress: null });
    }
    expect({
      readFile: syncFileSystem.readFileSync.mock.calls.length,
      stat: syncFileSystem.statSync.mock.calls.length,
    }).toEqual(firstReads);

    await writeFile(finalPath, "published");
    await writeFile(terminalPath, JSON.stringify({ status: "ready", progress: 1, workingPath: finalPath }));
    const fresh = createCompatibilityCache(options);
    expect(fresh.get(fingerprint)).toEqual({ status: "ready", progress: 1, workingPath: finalPath });

    now += 21;
    expect(polling.get(fingerprint)).toEqual({ status: "ready", progress: 1, workingPath: finalPath });
    await rm(finalPath, { force: true });
    expect(polling.get(fingerprint)).toEqual({ status: "none", progress: null });
  });

  it("does not synchronously read an oversized GET-only lock file", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const readInternal = vi.fn(() => {
      throw new Error("oversized internal file was read");
    });
    const statInternal = vi.fn((target: string) => {
      if (target === lockPath) {
        return { isFile: () => true, size: Number.MAX_SAFE_INTEGER };
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const cache = createCompatibilityCache({
      cacheDir,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      syncFileSystem: {
        readFile: readInternal as unknown as typeof import("node:fs").readFileSync,
        stat: statInternal as unknown as typeof import("node:fs").statSync,
      },
    });

    expect(cache.get(fingerprint)).toEqual({ status: "none", progress: null });
    expect(readInternal).not.toHaveBeenCalled();
  });

  it("removes a pre-link crash orphan owner descriptor without touching unknown files", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.601.pre-link.owner.json`);
    const nearMatchPath = path.join(cacheDir, `.${fingerprint}.601.pre-link.owner.json.backup`);
    const originalPath = path.join(cacheDir, "source.mov");
    await writeFile(ownerPath, JSON.stringify({ pid: 601, token: "pre-link" }));
    await writeFile(nearMatchPath, "unknown");
    await writeFile(originalPath, "original");
    const cache = createCompatibilityCache({
      cacheDir,
      sweepIntervalMs: 0,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    await cache.sweep();

    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(nearMatchPath, "utf8")).resolves.toBe("unknown");
    await expect(readFile(originalPath, "utf8")).resolves.toBe("original");
  });

  it("removes post-release owner terminal and cancel artifacts", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const prefix = path.join(cacheDir, `.${fingerprint}.602.post-release`);
    const ownerPath = `${prefix}.owner.json`;
    const terminalPath = `${prefix}.terminal.json`;
    const cancelPath = `${prefix}.cancel`;
    await writeFile(ownerPath, JSON.stringify({ pid: 602, token: "post-release" }));
    await writeFile(terminalPath, JSON.stringify({ status: "cancelled", progress: null }));
    await writeFile(cancelPath, "cancel");
    const cache = createCompatibilityCache({
      cacheDir,
      sweepIntervalMs: 0,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    await cache.sweep();

    for (const artifact of [ownerPath, terminalPath, cancelPath]) {
      await expect(stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("cleans an orphan generation on next start while preserving and revalidating its valid final", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const prefix = path.join(cacheDir, `.${fingerprint}.608.crashed-release`);
    const orphanPaths = [
      `${prefix}.owner.json`,
      `${prefix}.terminal.json`,
      `${prefix}.cancel`,
      `${prefix}.partial.mp4`,
    ];
    const now = Date.UTC(2026, 7, 24);
    await writeFile(finalPath, "valid-final");
    await writeFile(orphanPaths[0], JSON.stringify({ pid: 608, token: "crashed-release" }));
    await writeFile(orphanPaths[1], JSON.stringify({ status: "ready", progress: 1, workingPath: finalPath }));
    await writeFile(orphanPaths[2], "cancel");
    await writeFile(orphanPaths[3], "orphan-partial");
    await utimes(orphanPaths[3], new Date(now - 101), new Date(now - 101));
    const encode = vi.fn();
    const inspectOutput = vi.fn(async () => compatibleOutput());
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      ttlMs: Number.POSITIVE_INFINITY,
      partialOrphanMs: 100,
      sweepIntervalMs: 0,
      encode,
      inspectOutput,
    });

    await expect(cache.start({ originalPath: "source.mov", inspection: media() })).resolves.toMatchObject({
      status: "ready",
      workingPath: finalPath,
    });

    expect(encode).not.toHaveBeenCalled();
    expect(inspectOutput).toHaveBeenCalledWith(finalPath, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await expect(readFile(finalPath, "utf8")).resolves.toBe("valid-final");
    for (const artifact of orphanPaths) {
      await expect(stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves active generation metadata while removing another fingerprint orphan", async () => {
    const cacheDir = await tempRoot();
    const activeFingerprint = media().fingerprint;
    const orphanFingerprint = "b".repeat(64);
    const activeOwnerPath = path.join(cacheDir, `.${activeFingerprint}.603.active.owner.json`);
    const activeCancelPath = path.join(cacheDir, `.${activeFingerprint}.603.active.cancel`);
    const activeLockPath = path.join(cacheDir, `.${activeFingerprint}.compat-v1.lock`);
    const orphanOwnerPath = path.join(cacheDir, `.${orphanFingerprint}.604.orphan.owner.json`);
    await writeFile(activeOwnerPath, JSON.stringify({ pid: 603, token: "active" }));
    await writeFile(activeCancelPath, "cancel");
    await link(activeOwnerPath, activeLockPath);
    await writeFile(orphanOwnerPath, JSON.stringify({ pid: 604, token: "orphan" }));
    const cache = createCompatibilityCache({
      cacheDir,
      sweepIntervalMs: 0,
      isProcessAlive: (pid) => pid === 603,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    await cache.sweep();

    await expect(readFile(activeOwnerPath, "utf8")).resolves.toContain("active");
    await expect(readFile(activeCancelPath, "utf8")).resolves.toBe("cancel");
    await expect(readFile(activeLockPath, "utf8")).resolves.toContain("active");
    await expect(stat(orphanOwnerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a different live generation without deleting metadata referenced by the current lock", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const currentPrefix = path.join(cacheDir, `.${fingerprint}.605.current`);
    const stalePrefix = path.join(cacheDir, `.${fingerprint}.606.stale-live`);
    const currentOwnerPath = `${currentPrefix}.owner.json`;
    const currentCancelPath = `${currentPrefix}.cancel`;
    const stalePaths = [
      `${stalePrefix}.owner.json`,
      `${stalePrefix}.terminal.json`,
      `${stalePrefix}.cancel`,
    ];
    await writeFile(currentOwnerPath, JSON.stringify({ pid: 605, token: "current" }));
    await writeFile(currentCancelPath, "cancel");
    await link(currentOwnerPath, lockPath);
    await writeFile(stalePaths[0], JSON.stringify({ pid: 606, token: "stale-live" }));
    await writeFile(stalePaths[1], JSON.stringify({ status: "cancelled", progress: null }));
    await writeFile(stalePaths[2], "cancel");
    const cache = createCompatibilityCache({
      cacheDir,
      sweepIntervalMs: 0,
      isProcessAlive: (pid) => pid === 605 || pid === 606,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    await cache.sweep();

    await expect(readFile(currentOwnerPath, "utf8")).resolves.toContain("current");
    await expect(readFile(currentCancelPath, "utf8")).resolves.toBe("cancel");
    await expect(readFile(lockPath, "utf8")).resolves.toContain("current");
    for (const artifact of stalePaths) {
      await expect(stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not sweep generation metadata for a local job still finalizing after lock removal", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const ownerPath = path.join(cacheDir, `.${fingerprint}.607.finalizing.owner.json`);
    const terminalPath = path.join(cacheDir, `.${fingerprint}.607.finalizing.terminal.json`);
    const ownerCleanupStarted = deferred<void>();
    const releaseOwnerCleanup = deferred<void>();
    let ownerCleanupCalls = 0;
    const cache = createCompatibilityCache({
      cacheDir,
      processId: 607,
      randomUUID: () => "finalizing",
      sweepIntervalMs: 0,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "complete");
        return { encoder: "libx264" };
      },
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        rm: async (target, options) => {
          if (target.toString() === ownerPath && ++ownerCleanupCalls === 1) {
            ownerCleanupStarted.resolve();
            await releaseOwnerCleanup.promise;
          }
          return rm(target, options);
        },
      },
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await ownerCleanupStarted.promise;
    try {
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await cache.sweep();

      await expect(readFile(ownerPath, "utf8")).resolves.toContain("finalizing");
      await expect(readFile(terminalPath, "utf8")).resolves.toContain('"status":"ready"');
      await expect(readFile(finalPath, "utf8")).resolves.toBe("complete");
    } finally {
      releaseOwnerCleanup.resolve();
      await cache.cancel(fingerprint);
    }
  });

  it("preserves terminal metadata when owned lock removal is exhausted and retries later", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const firstOwnerPath = path.join(cacheDir, `.${fingerprint}.707.release-1.owner.json`);
    const firstTerminalPath = path.join(cacheDir, `.${fingerprint}.707.release-1.terminal.json`);
    const cleanupRetryAttempts = 2;
    let now = 1_000;
    let rejectLockRemoval = true;
    let lockRemovalAttempts = 0;
    let generation = 0;
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const removeTrackedLock = async (target: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
      if (target.toString() === lockPath) {
        lockRemovalAttempts += 1;
        if (rejectLockRemoval) {
          throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
        }
      }
      return rm(target, options);
    };
    const cache = createCompatibilityCache({
      cacheDir,
      processId: 707,
      randomUUID: () => `release-${++generation}`,
      now: () => now,
      cleanupRetryAttempts,
      cleanupRetryDelayMs: 0,
      sweepIntervalMs: 0,
      encode,
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        rm: removeTrackedLock,
      },
    });
    const input = { originalPath: "source.mov", inspection: media() };

    await cache.start(input);
    await eventually(() => expect(cache.get(fingerprint).status).toBe("ready"));
    syncFileSystem.statSync.mockClear();
    await eventually(() => {
      expect(cache.get(fingerprint).status).toBe("ready");
      expect(syncFileSystem.statSync).toHaveBeenCalledWith(lockPath);
    });
    expect(lockRemovalAttempts).toBe(cleanupRetryAttempts);

    const attemptsBeforeCancelRecovery = lockRemovalAttempts;
    await expect(cache.cancel(fingerprint)).resolves.toMatchObject({ status: "ready" });
    expect(lockRemovalAttempts - attemptsBeforeCancelRecovery).toBeGreaterThan(0);
    expect(lockRemovalAttempts - attemptsBeforeCancelRecovery).toBeLessThanOrEqual(cleanupRetryAttempts);
    await expect(readFile(lockPath, "utf8")).resolves.toContain("release-1");
    await expect(readFile(firstOwnerPath, "utf8")).resolves.toContain("release-1");
    await expect(readFile(firstTerminalPath, "utf8")).resolves.toContain('"status":"ready"');
    const observer = createCompatibilityCache({
      cacheDir,
      isProcessAlive: (pid) => pid === 707,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: { rm: removeTrackedLock },
    });
    const attemptsBeforePolling = lockRemovalAttempts;
    for (let poll = 0; poll < 10; poll += 1) {
      expect(cache.get(fingerprint)).toMatchObject({ status: "ready", workingPath: finalPath });
      expect(observer.get(fingerprint)).toMatchObject({ status: "ready", workingPath: finalPath });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lockRemovalAttempts).toBe(attemptsBeforePolling);

    rejectLockRemoval = false;
    now += 10_000;
    await expect(cache.start(input)).resolves.toMatchObject({ status: "ready", workingPath: finalPath });

    expect(encode).toHaveBeenCalledTimes(1);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("complete");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(firstOwnerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(firstTerminalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds start coordination when a malformed lock pathname remains", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    let linkAttempts = 0;
    await writeFile(lockPath, "{");
    const cache = createCompatibilityCache({
      cacheDir,
      lockPollMs: 2,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        link: async (existingPath, newPath) => {
          linkAttempts += 1;
          return link(existingPath, newPath);
        },
      },
    });
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(fingerprint).status).toBe("failed"));
    const observed = cache.get(fingerprint);
    await cache.cancel(fingerprint);

    expect(linkAttempts).toBeLessThanOrEqual(3);
    expect(observed.status).toBe("failed");
    expect(await readFile(lockPath, "utf8").catch(() => null)).not.toBe("{");
  });

  it("backs off failed malformed-lock recovery across GET polling and retries after the clock advances", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    let now = 1_000;
    let rejectRemoval = true;
    let removalAttempts = 0;
    await writeFile(lockPath, "{");
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      cleanupRetryAttempts: 2,
      cleanupRetryDelayMs: 0,
      lockPollMs: 2,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        rm: async (target, options) => {
          if (target.toString() === lockPath) {
            removalAttempts += 1;
            if (rejectRemoval) {
              throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
            }
          }
          return rm(target, options);
        },
      },
    });

    expect(cache.get(fingerprint)).toEqual({ status: "none", progress: null });
    await eventually(() => expect(removalAttempts).toBe(2));

    const polled = Array.from({ length: 20 }, () => cache.get(fingerprint));
    let backoffFailure: unknown;
    try {
      for (const state of polled) {
        expect(state).toMatchObject({
          status: "failed",
          error: { code: "COMPATIBILITY_CACHE_BUSY" },
        });
      }
      expect(removalAttempts).toBe(2);
    } catch (error) {
      backoffFailure = error;
    }

    rejectRemoval = false;
    now += 10_000;
    cache.get(fingerprint);
    await eventually(async () => expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" }));
    if (backoffFailure) throw backoffFailure;

    expect(removalAttempts).toBe(3);
    expect(cache.get(fingerprint)).toEqual({ status: "none", progress: null });
  });

  it("coalesces GET recovery so a delayed attempt cannot remove a replacement lock", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const releaseRecoveryStats = deferred<void>();
    const allRecoveryReads = deferred<void>();
    const oldLockRemoved = deferred<void>();
    const releaseDelayedCleanup = deferred<void>();
    const delayedCleanupDone = deferred<void>();
    const encodeStarted = deferred<void>();
    const releaseEncode = deferred<void>();
    let collectRecoveryStats = true;
    let trackRecoveryCleanup = true;
    let recoveryStatCalls = 0;
    let recoveryReadCalls = 0;
    let recoveryCleanupCalls = 0;
    let scheduledRecoveries = 0;
    await writeFile(lockPath, "{");
    const cache = createCompatibilityCache({
      cacheDir,
      lockPollMs: 2,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "partial");
        encodeStarted.resolve();
        await releaseEncode.promise;
        await writeFile(outputPath, "complete");
        return { encoder: "libx264" };
      },
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        stat: async (target) => {
          if (collectRecoveryStats && target === lockPath) {
            recoveryStatCalls += 1;
            await releaseRecoveryStats.promise;
          }
          return stat(target);
        },
        readFile: (async (target, options) => {
          const contents = await readFile(target, options);
          if (target.toString() === lockPath && contents.toString() === "{") {
            recoveryReadCalls += 1;
            if (recoveryReadCalls === scheduledRecoveries) allRecoveryReads.resolve();
            await allRecoveryReads.promise;
          }
          return contents;
        }) as typeof readFile,
        rm: async (target, options) => {
          if (trackRecoveryCleanup && target.toString() === lockPath) {
            recoveryCleanupCalls += 1;
            if (recoveryCleanupCalls === 1) {
              const result = await rm(target, options);
              oldLockRemoved.resolve();
              return result;
            }
            await releaseDelayedCleanup.promise;
            const result = await rm(target, options);
            delayedCleanupDone.resolve();
            return result;
          }
          return rm(target, options);
        },
      },
    });

    cache.get(fingerprint);
    cache.get(fingerprint);
    scheduledRecoveries = recoveryStatCalls;
    collectRecoveryStats = false;
    releaseRecoveryStats.resolve();
    await allRecoveryReads.promise;
    await oldLockRemoved.promise;

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await encodeStarted.promise;
    await eventually(() => expect(recoveryCleanupCalls).toBe(scheduledRecoveries));
    releaseDelayedCleanup.resolve();
    if (scheduledRecoveries > 1) await delayedCleanupDone.promise;
    trackRecoveryCleanup = false;
    releaseEncode.resolve();
    await eventually(() => expect(["ready", "failed"]).toContain(cache.get(fingerprint).status));

    expect({
      scheduledRecoveries,
      recoveryCleanupCalls,
      status: cache.get(fingerprint).status,
      finalContents: await readFile(path.join(cacheDir, `${fingerprint}-compat-v1.mp4`), "utf8").catch(() => null),
    }).toEqual({
      scheduledRecoveries: 1,
      recoveryCleanupCalls: 1,
      status: "ready",
      finalContents: "complete",
    });
  });

  it("recovers an oversized lock in bounded work", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    let linkAttempts = 0;
    const oversizedLock = "x".repeat(128 * 1024);
    await writeFile(lockPath, oversizedLock);
    const cache = createCompatibilityCache({
      cacheDir,
      lockPollMs: 2,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        link: async (existingPath, newPath) => {
          linkAttempts += 1;
          return link(existingPath, newPath);
        },
      },
    });
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(fingerprint).status).toBe("failed"));
    const observed = cache.get(fingerprint);
    await cache.cancel(fingerprint);

    expect(linkAttempts).toBeLessThanOrEqual(3);
    expect(observed.status).toBe("failed");
    expect(await readFile(lockPath, "utf8").catch(() => null)).not.toBe(oversizedLock);
  });

  it("recovers an oversized dead-owner terminal without reading it or hot spinning", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.999999.oversized-terminal.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const terminalPath = path.join(cacheDir, `.${fingerprint}.999999.oversized-terminal.terminal.json`);
    let linkAttempts = 0;
    const terminalReads = vi.fn();
    const statInternal = vi.fn((target: string) => stat(target));
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999, token: "oversized-terminal" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    await writeFile(terminalPath, "x".repeat(128 * 1024));
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const cache = createCompatibilityCache({
      cacheDir,
      lockPollMs: 2,
      isProcessAlive: () => false,
      encode,
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        stat: statInternal,
        link: async (existingPath, newPath) => {
          linkAttempts += 1;
          return link(existingPath, newPath);
        },
        readFile: (async (target, options) => {
          if (target.toString() === terminalPath) {
            terminalReads();
            throw new Error("oversized terminal contents were read");
          }
          return readFile(target, options);
        }) as typeof readFile,
      },
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(fingerprint).status).toBe("ready"));

    expect(terminalReads).not.toHaveBeenCalled();
    expect(statInternal).toHaveBeenCalledWith(terminalPath);
    expect(linkAttempts).toBeLessThanOrEqual(3);
    expect(encode).toHaveBeenCalledTimes(1);
    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(terminalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not report building for a dead stale GET-only lock and reaps it", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.999999.dead-get.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const now = Date.UTC(2026, 7, 23);
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999, token: "dead-get" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    await utimes(ownerPath, new Date(now - 1_000), new Date(now - 1_000));
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      lockStaleMs: 100,
      isProcessAlive: () => false,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    expect(cache.get(fingerprint)).toEqual({ status: "none", progress: null });
    await eventually(async () => expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" }));
  });

  it("recovers a fresh lock owned by a dead PID and starts safely", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.999999.fresh-dead.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999, token: "fresh-dead" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const cache = createCompatibilityCache({
      cacheDir,
      lockStaleMs: 60_000,
      lockPollMs: 2,
      isProcessAlive: () => false,
      encode,
      inspectOutput: async () => compatibleOutput(),
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(fingerprint).status).toBe("ready"));

    expect(encode).toHaveBeenCalledTimes(1);
    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(cacheDir, `${fingerprint}-compat-v1.mp4`), "utf8")).resolves.toBe("complete");
  });

  it("defers maintenance and reports actionable busy state for an old live-PID lock", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.777.live-stale.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const partialPath = path.join(cacheDir, `.${fingerprint}.777.live-stale.partial.mp4`);
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const now = Date.now();
    await writeFile(ownerPath, JSON.stringify({ pid: 777, token: "live-stale" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    await writeFile(partialPath, "active-partial");
    await writeFile(finalPath, "expired-final");
    const old = new Date(now - 10_000);
    await utimes(ownerPath, old, old);
    await utimes(partialPath, old, old);
    await utimes(finalPath, old, old);
    const encode = vi.fn();
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      ttlMs: 100,
      maxBytes: 0,
      partialOrphanMs: 100,
      lockStaleMs: 100,
      lockPollMs: 2,
      sweepIntervalMs: 0,
      isProcessAlive: (pid) => pid === 777,
      encode,
      inspectOutput: vi.fn(),
    });

    await cache.sweep();
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(fingerprint)).toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY", message: expect.stringMatching(/restart|server/i) },
    }));

    expect(encode).not.toHaveBeenCalled();
    await expect(readFile(partialPath, "utf8")).resolves.toBe("active-partial");
    await expect(readFile(finalPath, "utf8")).resolves.toBe("expired-final");
    await expect(readFile(lockPath, "utf8")).resolves.toContain("live-stale");
  });

  it("does not let an unsupported follower cancel a live owner", async () => {
    const cacheDir = await tempRoot();
    const encodeStarted = deferred<string>();
    let ownerSignal: AbortSignal | undefined;
    const encode = vi.fn(async ({ outputPath, signal }: { outputPath: string; signal: AbortSignal }) => {
      ownerSignal = signal;
      await writeFile(outputPath, "active-partial");
      encodeStarted.resolve(outputPath);
      await new Promise<void>((_resolve, reject) => {
        const rejectCancelled = () => reject(Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" }));
        if (signal.aborted) rejectCancelled();
        else signal.addEventListener("abort", rejectCancelled, { once: true });
      });
      return { encoder: "libx264" };
    });
    const options = {
      cacheDir,
      encode,
      inspectOutput: async () => compatibleOutput(),
      lockPollMs: 20,
      isProcessAlive: (pid: number) => pid === 301 || pid === 302,
    };
    const owner = createCompatibilityCache({ ...options, processId: 301, randomUUID: () => "owner-token" });
    const follower = createCompatibilityCache({ ...options, processId: 302, randomUUID: () => "follower-token" });
    const input = { originalPath: "source.mov", inspection: media() };
    await owner.start(input);
    const partialPath = await encodeStarted.promise;
    await expect(follower.start(input)).resolves.toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });

    await expect(follower.cancel(media().fingerprint)).resolves.toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });

    expect(ownerSignal?.aborted).toBe(false);
    await expect(readFile(partialPath, "utf8")).resolves.toBe("active-partial");
    await owner.cancel(media().fingerprint);
    await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    await eventually(() => expect(owner.get(media().fingerprint).status).toBe("cancelled"));
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stat", "EPERM"],
    ["readFile", "EACCES"],
  ] as const)("sanitizes cancel lock-inspection %s failures as cache busy", async (operation, code) => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, token: "private-cancel-owner" }));
    const permissionFailure = () => Object.assign(new Error(`permission denied for ${lockPath}`), { code });
    const cache = createCompatibilityCache({
      cacheDir,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        stat: async (target) => {
          if (operation === "stat" && target === lockPath) throw permissionFailure();
          return stat(target);
        },
        readFile: (async (target, options) => {
          if (operation === "readFile" && target.toString() === lockPath) throw permissionFailure();
          return readFile(target, options);
        }) as typeof readFile,
      },
    });

    const cancelled = await withTimeout(cache.cancel(fingerprint), `${operation} cancellation failure`);

    expect(cancelled).toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });
    expect(JSON.stringify(cancelled)).not.toContain(cacheDir);
    expect(JSON.stringify(cancelled)).not.toContain("private-cancel-owner");
  });

  it("keeps cancellation and subsequent starts busy while canonical lock recovery is exhausted", async () => {
    const cacheDir = await tempRoot();
    const inspection = media();
    const fingerprint = inspection.fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.999999.cancel-recovery.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    let now = 1_000;
    let rejectLockRemoval = true;
    let lockRemovalAttempts = 0;
    let generation = 0;
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999, token: "cancel-recovery" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "recovered-build");
      return { encoder: "libx264" };
    });
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      randomUUID: () => `cancel-retry-${++generation}`,
      cleanupRetryAttempts: 2,
      cleanupRetryDelayMs: 0,
      lockPollMs: 2,
      isProcessAlive: () => false,
      encode,
      inspectOutput: async () => compatibleOutput(inspection),
      fileSystem: {
        rm: async (target, options) => {
          if (target.toString() === lockPath) {
            lockRemovalAttempts += 1;
            if (rejectLockRemoval) {
              throw Object.assign(new Error(`sharing violation at ${lockPath}`), { code: "EBUSY" });
            }
          }
          return rm(target, options);
        },
      },
    });

    const cancelled = await withTimeout(cache.cancel(fingerprint), "exhausted cancel recovery");

    expect(cancelled).toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });
    expect(JSON.stringify(cancelled)).not.toContain(cacheDir);
    expect(lockRemovalAttempts).toBe(2);
    await expect(readFile(lockPath, "utf8")).resolves.toContain("cancel-recovery");

    const blocked = await withTimeout(
      cache.start({ originalPath: "source.mov", inspection }),
      "start blocked by failed cancel recovery",
    );
    expect(blocked).toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });
    expect(encode).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("cancel-recovery");

    rejectLockRemoval = false;
    now += 1_000;
    await withTimeout(cache.start({ originalPath: "source.mov", inspection }), "start after cancel recovery");
    await withTimeout(eventually(() => expect(cache.get(fingerprint).status).toBe("ready")), "build after cancel recovery");

    expect(encode).toHaveBeenCalledTimes(1);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("recovered-build");
    await expect(cache.cancel(fingerprint)).resolves.toMatchObject({ status: "ready", workingPath: finalPath });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports ready when cancellation loses the race to atomic publication", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const published = deferred<void>();
    const releasePublication = deferred<void>();
    const cache = createCompatibilityCache({
      cacheDir,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "complete");
        return { encoder: "libx264" };
      },
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        async utimes(target, atime, mtime) {
          if (target.toString() === finalPath) {
            published.resolve();
            await releasePublication.promise;
          }
          return utimes(target, atime, mtime);
        },
      },
    });
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await published.promise;

    const cancellation = cache.cancel(fingerprint);
    releasePublication.resolve();

    await expect(cancellation).resolves.toMatchObject({ status: "ready", workingPath: finalPath });
    expect(cache.get(fingerprint)).toMatchObject({ status: "ready", workingPath: finalPath });
  });

  it("removes its just-linked final when cancellation precedes the actual publication link", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const publicationDispatched = deferred<void>();
    const performPublication = deferred<void>();
    let jobSignal: AbortSignal | undefined;
    const cache = createCompatibilityCache({
      cacheDir,
      randomUUID: () => "cancelled-publication",
      encode: async ({ outputPath, signal }) => {
        jobSignal = signal;
        await writeFile(outputPath, "complete");
        return { encoder: "libx264" };
      },
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        link: async (existingPath, newPath) => {
          if (newPath.toString() === finalPath) {
            publicationDispatched.resolve();
            await performPublication.promise;
          }
          return link(existingPath, newPath);
        },
      },
    });

    const startState = await cache.start({ originalPath: "source.mov", inspection: media() });
    await publicationDispatched.promise;
    const cancelling = cache.cancel(fingerprint);
    await eventually(() => expect(jobSignal?.aborted).toBe(true));
    performPublication.resolve();
    const cancelState = await cancelling;

    expect({
      startStatus: startState.status,
      cancelStatus: cancelState.status,
      settledStatus: cache.get(fingerprint).status,
    }).toEqual({
      startStatus: "queued",
      cancelStatus: "cancelled",
      settledStatus: "cancelled",
    });
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".partial.mp4"))).toEqual([]);
  });

  it("does not publish when cancellation arrives during the final lock ownership check", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const ownershipRead = deferred<void>();
    const releaseOwnershipRead = deferred<void>();
    let paused = false;
    let jobSignal: AbortSignal | undefined;
    const cache = createCompatibilityCache({
      cacheDir,
      encode: async ({ outputPath, signal }) => {
        jobSignal = signal;
        await writeFile(outputPath, "complete");
        return { encoder: "libx264" };
      },
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        readFile: (async (target, options) => {
          const contents = await readFile(target, options);
          if (!paused && target.toString() === lockPath) {
            paused = true;
            ownershipRead.resolve();
            await releaseOwnershipRead.promise;
          }
          return contents;
        }) as typeof readFile,
      },
    });
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await ownershipRead.promise;

    const cancellation = cache.cancel(fingerprint);
    await eventually(() => expect(jobSignal?.aborted).toBe(true));
    releaseOwnershipRead.resolve();

    await expect(cancellation).resolves.toMatchObject({ status: "cancelled" });
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers one dead generation and still starts one process-global job", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const staleOwner = path.join(cacheDir, `.${fingerprint}.999999.stale-token.owner.json`);
    const staleLock = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    await writeFile(staleOwner, JSON.stringify({ pid: 999_999, token: "stale-token" }), { flag: "wx" });
    await link(staleOwner, staleLock);
    const now = Date.UTC(2026, 7, 23);
    await utimes(staleOwner, new Date(now - 1_000), new Date(now - 1_000));
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "partial");
      await gate.promise;
      await writeFile(outputPath, "winner");
      return { encoder: "libx264" };
    });
    const options = {
      cacheDir, encode, inspectOutput: async () => compatibleOutput(), now: () => now,
      lockStaleMs: 100, lockPollMs: 2, isProcessAlive: (pid: number) => pid !== 999_999,
      processId: 401, randomUUID: () => "new-one",
    };
    const first = getProcessCompatibilityCache(options);
    const second = getProcessCompatibilityCache({ cacheDir });

    await Promise.all([
      first.start({ originalPath: "source.mov", inspection: media() }),
      second.start({ originalPath: "source.mov", inspection: media() }),
    ]);
    await eventually(() => expect(encode).toHaveBeenCalled());
    const callsBeforeRelease = encode.mock.calls.length;
    gate.resolve();
    await eventually(() => expect(first.get(fingerprint).status).toBe("ready"));

    expect(second).toBe(first);
    expect(callsBeforeRelease).toBe(1);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("never reaps a live owner solely because its heartbeat is old", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const ownerPath = path.join(cacheDir, `.${fingerprint}.777.live-token.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const now = Date.UTC(2026, 7, 23);
    await writeFile(ownerPath, JSON.stringify({ pid: 777, token: "live-token" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    await utimes(ownerPath, new Date(now - 1_000), new Date(now - 1_000));
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      lockStaleMs: 100,
      lockPollMs: 2,
      isProcessAlive: () => true,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    await expect(cache.start({ originalPath: "source.mov", inspection: media() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY", message: expect.stringMatching(/restart|server/i) },
    });
    const ownerSurvived = await stat(ownerPath).then(() => true, () => false);

    expect(ownerSurvived).toBe(true);
    await expect(readFile(lockPath, "utf8")).resolves.toContain("live-token");
  });

  it("never overwrites a valid winner that appears at publication time", async () => {
    const cacheDir = await tempRoot();
    const finalPath = path.join(cacheDir, `${media().fingerprint}-compat-v1.mp4`);
    const cache = createCompatibilityCache({
      cacheDir,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "loser");
        await writeFile(finalPath, "winner");
        return { encoder: "libx264" };
      },
      inspectOutput: async () => compatibleOutput(),
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("ready"));

    await expect((await import("node:fs/promises")).readFile(finalPath, "utf8")).resolves.toBe("winner");
  });

  it("surfaces a filesystem coordination failure instead of leaving an unhandled queued job", async () => {
    const cacheDir = await tempRoot();
    const cache = createCompatibilityCache({
      cacheDir,
      fileSystem: {
        link: (async () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); }) as typeof link,
      },
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("failed"));

    expect(cache.get(media().fingerprint).error).toMatchObject({ code: "COMPATIBILITY_CACHE_BUSY" });
  });

  it("passes the job signal into output inspection so validation is cancellable", async () => {
    const cacheDir = await tempRoot();
    const inspectOutput = vi.fn(async () => compatibleOutput());
    const cache = createCompatibilityCache({
      cacheDir,
      encode: async ({ outputPath }) => { await writeFile(outputPath, "complete"); return { encoder: "libx264" }; },
      inspectOutput,
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("ready"));

    expect(inspectOutput).toHaveBeenCalledWith(
      expect.stringContaining(".partial.mp4"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("invalidates ready state in every cache instance when its final disappears", async () => {
    const cacheDir = await tempRoot();
    const encode = vi.fn(async ({ outputPath }) => { await writeFile(outputPath, "complete"); return { encoder: "libx264" }; });
    const options = { cacheDir, encode, inspectOutput: async () => compatibleOutput(), lockPollMs: 2 };
    const first = createCompatibilityCache(options);
    const second = createCompatibilityCache(options);
    const input = { originalPath: "source.mov", inspection: media() };
    await first.start(input);
    await eventually(() => expect(first.get(media().fingerprint).status).toBe("ready"));
    await second.start(input);
    const finalPath = first.get(media().fingerprint).workingPath!;
    expect(second.get(media().fingerprint).status).toBe("ready");

    const { rm } = await import("node:fs/promises");
    await rm(finalPath, { force: true });

    expect(first.get(media().fingerprint)).toEqual({ status: "none", progress: null });
    expect(second.get(media().fingerprint)).toEqual({ status: "none", progress: null });
  });

  it("invalidates a real ready state when TTL sweep removes its final", async () => {
    const cacheDir = await tempRoot();
    let now = Date.UTC(2026, 7, 23);
    const cache = createCompatibilityCache({
      cacheDir, now: () => now, ttlMs: 100, sweepIntervalMs: 0,
      encode: async ({ outputPath }) => { await writeFile(outputPath, "complete"); return { encoder: "libx264" }; },
      inspectOutput: async () => compatibleOutput(),
    });
    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("ready"));
    await expect(cache.cancel(media().fingerprint)).resolves.toMatchObject({ status: "ready" });
    const finalPath = cache.get(media().fingerprint).workingPath!;
    now += 101;

    await cache.sweep();

    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(cache.get(media().fingerprint)).toEqual({ status: "none", progress: null });
  });

  it("protects a ready final until its local job fully settles and rechecks its path", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const jobReleaseReached = deferred<void>();
    const releaseJobFinalization = deferred<void>();
    const finalRemoved = deferred<void>();
    const releaseFinalRemoval = deferred<void>();
    let lockRemovalCalls = 0;
    let reportFinalMissing = false;
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const cache = createCompatibilityCache({
      cacheDir,
      maxBytes: 0,
      sweepIntervalMs: 0,
      randomUUID: () => "finalizing-job",
      pathExists: (target) => target === finalPath && !reportFinalMissing,
      encode,
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        rm: async (target, options) => {
          if (target.toString() === lockPath && ++lockRemovalCalls === 1) {
            jobReleaseReached.resolve();
            await releaseJobFinalization.promise;
          }
          if (target.toString() === finalPath) {
            const result = await rm(target, options);
            finalRemoved.resolve();
            await releaseFinalRemoval.promise;
            return result;
          }
          return rm(target, options);
        },
      },
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await jobReleaseReached.promise;
    const sweeping = cache.sweep();
    const maintenanceOutcome = await Promise.race([
      finalRemoved.promise.then(() => "removed" as const),
      sweeping.then(() => "deferred" as const),
    ]);
    reportFinalMissing = true;
    const stateWhenPathIsMissing = cache.get(fingerprint);
    const finalExistsDuringJob = await stat(finalPath).then(() => true, () => false);

    releaseFinalRemoval.resolve();
    await sweeping;
    releaseJobFinalization.resolve();
    await eventually(async () => expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" }));

    expect({
      maintenanceOutcome,
      statusWhenPathIsMissing: stateWhenPathIsMissing.status,
      finalExistsDuringJob,
      encodeCalls: encode.mock.calls.length,
    }).toEqual({
      maintenanceOutcome: "deferred",
      statusWhenPathIsMissing: "none",
      finalExistsDuringJob: true,
      encodeCalls: 1,
    });
  });

  it("recovers a dead stale lock before evicting its expired final", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const ownerPath = path.join(cacheDir, `.${fingerprint}.999999.dead-token.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const now = Date.UTC(2026, 7, 23);
    await writeFile(finalPath, "expired");
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999, token: "dead-token" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    await utimes(finalPath, new Date(now - 101), new Date(now - 101));
    await utimes(ownerPath, new Date(now - 1_000), new Date(now - 1_000));
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      ttlMs: 100,
      lockStaleMs: 100,
      sweepIntervalMs: 0,
      isProcessAlive: () => false,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
    });

    await cache.sweep();

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not evict a replacement final published after the sweep scan", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const ownerPath = path.join(cacheDir, `.${fingerprint}.999999.dead-race.owner.json`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const now = Date.UTC(2026, 7, 23);
    await writeFile(finalPath, "expired-invalid");
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999, token: "dead-race" }), { flag: "wx" });
    await link(ownerPath, lockPath);
    await utimes(finalPath, new Date(now - 101), new Date(now - 101));
    await utimes(ownerPath, new Date(now - 1_000), new Date(now - 1_000));
    const evictionReached = deferred<void>();
    const releaseEviction = deferred<void>();
    let evictionPaused = false;
    const sweeper = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 808,
      randomUUID: () => "eviction-claim",
      ttlMs: 100,
      lockStaleMs: 100,
      sweepIntervalMs: 0,
      isProcessAlive: () => false,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        rm: (async (target, options) => {
          if (!evictionPaused && target.toString() === finalPath) {
            evictionPaused = true;
            evictionReached.resolve();
            await releaseEviction.promise;
          }
          return rm(target, options);
        }) as typeof rm,
      },
    });
    const sweeping = sweeper.sweep();
    await evictionReached.promise;
    const evictionOwner = await readFile(lockPath, "utf8").then(
      (contents) => JSON.parse(contents) as { pid: number; token: string },
      () => null,
    );
    if (!evictionOwner) {
      releaseEviction.resolve();
      await sweeping;
      expect(evictionOwner).toMatchObject({ pid: 808, token: "eviction-claim" });
      return;
    }

    let inspectedOldFinal = false;
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "replacement");
      return { encoder: "libx264" };
    });
    const replacement = createCompatibilityCache({
      cacheDir,
      encode,
      isProcessAlive: (pid) => pid === 808 || pid === process.pid,
      inspectOutput: async (target) => {
        if (target === finalPath && !inspectedOldFinal) {
          inspectedOldFinal = true;
          throw Object.assign(new Error("invalid old final"), { code: "MEDIA_INVALID" });
        }
        return compatibleOutput();
      },
    });
    await expect(replacement.start({ originalPath: "source.mov", inspection: media() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });
    expect(inspectedOldFinal).toBe(false);
    expect(encode).not.toHaveBeenCalled();

    releaseEviction.resolve();
    await sweeping;
    await replacement.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(replacement.get(fingerprint).status).toBe("ready"));

    expect(evictionOwner).toMatchObject({ pid: 808, token: "eviction-claim" });
    expect(encode).toHaveBeenCalledTimes(1);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("replacement");
  });

  it("does not expose or reuse a valid final while an eviction claim can still delete it", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    let now = Date.now();
    await writeFile(finalPath, "expired-valid");
    await utimes(finalPath, new Date(now - 101), new Date(now - 101));
    const evictionReached = deferred<void>();
    const releaseEviction = deferred<void>();
    let evictionPaused = false;
    const sweeper = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 901,
      randomUUID: () => "valid-eviction",
      ttlMs: 100,
      lockStaleMs: 1_000_000,
      sweepIntervalMs: 0,
      isProcessAlive: () => true,
      encode: vi.fn(),
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        rm: (async (target, options) => {
          if (!evictionPaused && target.toString() === finalPath) {
            evictionPaused = true;
            evictionReached.resolve();
            await releaseEviction.promise;
          }
          return rm(target, options);
        }) as typeof rm,
      },
    });
    const sweeping = sweeper.sweep();
    await evictionReached.promise;

    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "rebuilt");
      return { encoder: "libx264" };
    });
    const reader = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 902,
      randomUUID: () => "reader",
      ttlMs: Number.POSITIVE_INFINITY,
      lockStaleMs: 1_000_000,
      sweepIntervalMs: 0,
      lockPollMs: 2,
      isProcessAlive: () => true,
      encode,
      inspectOutput: async () => compatibleOutput(),
    });

    let getDuringEviction: ReturnType<typeof reader.get> | undefined;
    let startDuringEviction: Awaited<ReturnType<typeof reader.start>> | undefined;
    try {
      getDuringEviction = reader.get(fingerprint);
      startDuringEviction = await reader.start({ originalPath: "source.mov", inspection: media() });
    } finally {
      releaseEviction.resolve();
      await sweeping;
    }

    expect(getDuringEviction).toEqual({ status: "building", progress: null });
    expect(startDuringEviction).toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });
    await reader.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(reader.get(fingerprint).status).toBe("ready"));
    expect(encode).toHaveBeenCalledTimes(1);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("rebuilt");
  });

  it("defers a replacement while a live maintenance owner has an expired heartbeat", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    let now = Date.now();
    await writeFile(finalPath, "expired-invalid");
    await utimes(finalPath, new Date(now - 101), new Date(now - 101));
    const maintenancePaused = deferred<void>();
    const releaseMaintenance = deferred<void>();
    let finalRemovalAttempts = 0;
    let maintenanceHeartbeats = 0;
    let refreshMaintenanceLease = true;
    const oldSweeper = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 911,
      randomUUID: () => "expired-maintenance",
      ttlMs: 100,
      lockStaleMs: 10,
      sweepIntervalMs: 0,
      cleanupRetryDelayMs: 0,
      isProcessAlive: () => true,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        rm: async (target, options) => {
          if (target.toString() === finalPath && ++finalRemovalAttempts === 1) {
            maintenancePaused.resolve();
            await releaseMaintenance.promise;
            throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
          }
          return rm(target, options);
        },
        utimes: async (target, accessTime, modifiedTime) => {
          if (target.toString().includes("expired-maintenance.owner.json")) {
            maintenanceHeartbeats += 1;
            if (!refreshMaintenanceLease) return;
          }
          return utimes(target, accessTime, modifiedTime);
        },
      },
    });
    const sweeping = oldSweeper.sweep();
    await maintenancePaused.promise;
    await eventually(() => expect(maintenanceHeartbeats).toBeGreaterThan(0));
    refreshMaintenanceLease = false;
    now += 1_000;

    const replacement = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 912,
      randomUUID: () => "replacement-owner",
      ttlMs: Number.POSITIVE_INFINITY,
      lockStaleMs: 10,
      sweepIntervalMs: 0,
      lockPollMs: 2,
      isProcessAlive: () => true,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "replacement");
        return { encoder: "libx264" };
      },
      inspectOutput: async (target) => {
        if (target === finalPath && await readFile(target, "utf8") === "expired-invalid") {
          throw Object.assign(new Error("invalid old final"), { code: "MEDIA_INVALID" });
        }
        return compatibleOutput();
      },
    });
    await expect(replacement.start({ originalPath: "source.mov", inspection: media() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "COMPATIBILITY_CACHE_BUSY" },
    });
    await expect(readFile(lockPath, "utf8")).resolves.toContain("expired-maintenance");

    releaseMaintenance.resolve();
    await sweeping;
    await replacement.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(replacement.get(fingerprint).status).toBe("ready"));
    const stoppedHeartbeatCount = maintenanceHeartbeats;
    await eventually(async () => expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" }));

    const [contents, lock] = await Promise.all([
      readFile(finalPath, "utf8").catch(() => null),
      readFile(lockPath, "utf8").then((value) => JSON.parse(value) as { pid: number; token: string }, () => null),
    ]);
    expect({ contents, lock }).toEqual({
      contents: "replacement",
      lock: null,
    });
    expect(maintenanceHeartbeats).toBe(stoppedHeartbeatCount);
  });

  it("preserves a same-cache maintenance claim until expired-final eviction releases it", async () => {
    const cacheDir = await tempRoot();
    const startAInspection = media({ fingerprint: "a".repeat(64) });
    const evictedBInspection = media({ fingerprint: "b".repeat(64) });
    const finalBPath = path.join(cacheDir, `${evictedBInspection.fingerprint}-compat-v1.mp4`);
    const lockBPath = path.join(cacheDir, `.${evictedBInspection.fingerprint}.compat-v1.lock`);
    const now = Date.now();
    const evictionPaused = deferred<void>();
    const releaseEviction = deferred<void>();
    let pauseEviction = true;
    let generation = 0;
    let inspectedExpiredFinal = false;
    await writeFile(finalBPath, "expired-valid");
    await utimes(finalBPath, new Date(now - 101), new Date(now - 101));
    const encode = vi.fn(async ({ outputPath, inspection }) => {
      await writeFile(outputPath, `rebuilt-${inspection.fingerprint}`);
      return { encoder: "libx264" };
    });
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 951,
      randomUUID: () => `same-cache-${++generation}`,
      ttlMs: 100,
      sweepIntervalMs: 1,
      lockPollMs: 2,
      isProcessAlive: (pid) => pid === 951,
      encode,
      inspectOutput: async (target) => {
        if (target === finalBPath) inspectedExpiredFinal = true;
        return compatibleOutput(evictedBInspection);
      },
      fileSystem: {
        rm: async (target, options) => {
          if (pauseEviction && target.toString() === finalBPath) {
            pauseEviction = false;
            evictionPaused.resolve();
            await releaseEviction.promise;
          }
          return rm(target, options);
        },
      },
    });
    const startA = cache.start({ originalPath: "source-a.mov", inspection: startAInspection });
    await withTimeout(evictionPaused.promise, "same-cache B eviction pause");
    const maintenanceOwner = await withTimeout(readFile(lockBPath, "utf8"), "same-cache B maintenance lock");

    let startBDuringEviction: Awaited<ReturnType<typeof cache.start>> | undefined;
    try {
      startBDuringEviction = await withTimeout(
        cache.start({ originalPath: "source-b.mov", inspection: evictedBInspection }),
        "same-cache B start during eviction",
      );
      expect(startBDuringEviction).toMatchObject({
        status: "failed",
        error: { code: "COMPATIBILITY_CACHE_BUSY" },
      });
      await expect(readFile(lockBPath, "utf8")).resolves.toBe(maintenanceOwner);
      expect(inspectedExpiredFinal).toBe(false);
    } finally {
      releaseEviction.resolve();
    }

    await withTimeout(startA, "A start after B maintenance release");
    await withTimeout(eventually(() => expect(cache.get(startAInspection.fingerprint).status).toBe("ready")), "A build completion");
    await withTimeout(
      cache.start({ originalPath: "source-b.mov", inspection: evictedBInspection }),
      "later B start",
    );
    await withTimeout(eventually(() => expect(cache.get(evictedBInspection.fingerprint).status).toBe("ready")), "later B build completion");

    expect(startBDuringEviction?.status).not.toBe("ready");
    expect(encode).toHaveBeenCalledTimes(2);
    await expect(readFile(finalBPath, "utf8")).resolves.toBe(`rebuilt-${evictedBInspection.fingerprint}`);
    await expect(cache.cancel(evictedBInspection.fingerprint)).resolves.toMatchObject({
      status: "ready",
      workingPath: finalBPath,
    });
  });

  // Unsupported-topology evidence. Re-enable if multiprocess/shared-cache support reopens:
  // docs/superpowers/decisions/2026-08-24-compatibility-cache-single-process.md
  describe.skip("multiprocess and external-writer evidence", () => {
  it("does not unlink a replacement lock after release verified the old generation", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    const lockPath = path.join(cacheDir, `.${fingerprint}.compat-v1.lock`);
    const replacementOwnerPath = path.join(cacheDir, `.${fingerprint}.922.replacement-lock.owner.json`);
    const unlinkReached = deferred<void>();
    const releaseUnlink = deferred<void>();
    let pauseUnlink = true;
    await writeFile(finalPath, "valid");
    const cache = createCompatibilityCache({
      cacheDir,
      processId: 921,
      randomUUID: () => "old-release",
      encode: vi.fn(),
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        rm: async (target, options) => {
          if (pauseUnlink && target.toString() === lockPath) {
            pauseUnlink = false;
            unlinkReached.resolve();
            await releaseUnlink.promise;
          }
          return rm(target, options);
        },
      },
    });
    const starting = cache.start({ originalPath: "source.mov", inspection: media() });
    await unlinkReached.promise;
    try {
      await rm(lockPath, { force: true });
      await writeFile(replacementOwnerPath, JSON.stringify({ pid: 922, token: "replacement-lock" }), { flag: "wx" });
      await link(replacementOwnerPath, lockPath);
    } finally {
      releaseUnlink.resolve();
    }
    await starting;

    await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify({ pid: 922, token: "replacement-lock" }));
  });

  it("does not delete a replacement final when an in-flight eviction loses its lease", async () => {
    const cacheDir = await tempRoot();
    const fingerprint = media().fingerprint;
    const finalPath = path.join(cacheDir, `${fingerprint}-compat-v1.mp4`);
    let now = Date.now();
    let refreshMaintenanceLease = true;
    const deletionReached = deferred<void>();
    const releaseDeletion = deferred<void>();
    let pauseDeletion = true;
    await writeFile(finalPath, "expired-invalid");
    await utimes(finalPath, new Date(now - 101), new Date(now - 101));
    const oldSweeper = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 931,
      randomUUID: () => "in-flight-eviction",
      ttlMs: 100,
      lockStaleMs: 10,
      sweepIntervalMs: 0,
      isProcessAlive: () => true,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        rm: async (target, options) => {
          if (pauseDeletion && target.toString() === finalPath) {
            pauseDeletion = false;
            deletionReached.resolve();
            await releaseDeletion.promise;
          }
          return rm(target, options);
        },
        utimes: async (target, accessTime, modifiedTime) => {
          if (target.toString().includes("in-flight-eviction.owner.json") && !refreshMaintenanceLease) return;
          return utimes(target, accessTime, modifiedTime);
        },
      },
    });
    const sweeping = oldSweeper.sweep();
    await deletionReached.promise;
    refreshMaintenanceLease = false;
    now += 1_000;

    const replacement = createCompatibilityCache({
      cacheDir,
      now: () => now,
      processId: 932,
      randomUUID: () => "in-flight-replacement",
      ttlMs: Number.POSITIVE_INFINITY,
      lockStaleMs: 10,
      sweepIntervalMs: 0,
      lockPollMs: 2,
      isProcessAlive: () => true,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "replacement");
        return { encoder: "libx264" };
      },
      inspectOutput: async (target) => {
        if (target === finalPath && await readFile(target, "utf8") === "expired-invalid") {
          throw Object.assign(new Error("invalid old final"), { code: "MEDIA_INVALID" });
        }
        return compatibleOutput();
      },
    });
    try {
      await replacement.start({ originalPath: "source.mov", inspection: media() });
      await eventually(() => expect(replacement.get(fingerprint).status).toBe("ready"));
    } finally {
      releaseDeletion.resolve();
      await sweeping;
    }

    await expect(readFile(finalPath, "utf8")).resolves.toBe("replacement");
  });

  it("preserves a scanned orphan partial that becomes actively owned before cleanup", async () => {
    const cacheDir = await tempRoot();
    const triggerFingerprint = "b".repeat(64);
    const activeFingerprint = media().fingerprint;
    const triggerName = `.${triggerFingerprint}.700.trigger.partial.mp4`;
    const activeName = `.${activeFingerprint}.777.active-token.partial.mp4`;
    const triggerPath = path.join(cacheDir, triggerName);
    const activePath = path.join(cacheDir, activeName);
    const activeOwnerPath = path.join(cacheDir, `.${activeFingerprint}.777.active-token.owner.json`);
    const activeLockPath = path.join(cacheDir, `.${activeFingerprint}.compat-v1.lock`);
    const now = Date.now();
    await writeFile(triggerPath, "trigger");
    await writeFile(activePath, "active");
    await utimes(triggerPath, new Date(now - 101), new Date(now - 101));
    await utimes(activePath, new Date(now - 101), new Date(now - 101));
    let activated = false;
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      partialOrphanMs: 100,
      sweepIntervalMs: 0,
      isProcessAlive: () => true,
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      fileSystem: {
        readdir: async () => [triggerName, activeName] as never,
        rm: async (target, options) => {
          if (!activated && target.toString() === triggerPath) {
            activated = true;
            await writeFile(activeOwnerPath, JSON.stringify({ pid: 777, token: "active-token" }), { flag: "wx" });
            await link(activeOwnerPath, activeLockPath);
          }
          return rm(target, options);
        },
      },
    });

    await cache.sweep();

    await expect(stat(activePath)).resolves.toMatchObject({ size: 6 });
    await expect(readFile(activeLockPath, "utf8")).resolves.toContain("active-token");
  });
  });

  it("revalidates a partial activated by the same cache before cleanup", async () => {
    const cacheDir = await tempRoot();
    const triggerFingerprint = "b".repeat(64);
    const fingerprint = media().fingerprint;
    const triggerName = `.${triggerFingerprint}.700.trigger.partial.mp4`;
    const activeName = `.${fingerprint}.${process.pid}.same-process.partial.mp4`;
    const triggerPath = path.join(cacheDir, triggerName);
    const activePath = path.join(cacheDir, activeName);
    const now = Date.now();
    const encodeStarted = deferred<void>();
    const releaseEncode = deferred<void>();
    await writeFile(triggerPath, "trigger");
    await writeFile(activePath, "orphan");
    await utimes(triggerPath, new Date(now - 101), new Date(now - 101));
    await utimes(activePath, new Date(now - 101), new Date(now - 101));
    let activated = false;
    let cache!: ReturnType<typeof createCompatibilityCache>;
    cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      randomUUID: () => "same-process",
      partialOrphanMs: 100,
      sweepIntervalMs: 1_000,
      lockPollMs: 2,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "active");
        encodeStarted.resolve();
        await releaseEncode.promise;
        await writeFile(outputPath, "complete");
        return { encoder: "libx264" };
      },
      inspectOutput: async () => compatibleOutput(),
      fileSystem: {
        readdir: (async () => [triggerName, activeName]) as unknown as typeof readdir,
        rm: async (target, options) => {
          if (!activated && target.toString() === triggerPath) {
            activated = true;
            await cache.start({ originalPath: "source.mov", inspection: media() });
            await encodeStarted.promise;
          }
          return rm(target, options);
        },
      },
    });

    await cache.sweep();

    const activeContents = await readFile(activePath, "utf8").catch(() => null);
    releaseEncode.resolve();
    await eventually(() => expect(cache.get(fingerprint).status).toBe("ready"));
    expect(activeContents).toBe("active");
  });

  it("retries cleanup of its own partial a limited number of times", async () => {
    const cacheDir = await tempRoot();
    const { rm } = await import("node:fs/promises");
    let partialAttempts = 0;
    const cache = createCompatibilityCache({
      cacheDir,
      cleanupRetryAttempts: 3,
      cleanupRetryDelayMs: 0,
      fileSystem: {
        rm: (async (target, options) => {
          if (target.toString().includes(".partial.mp4") && partialAttempts < 2) {
            partialAttempts += 1;
            throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
          }
          return rm(target, options);
        }) as typeof rm,
      },
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "partial");
        throw Object.assign(new Error("encode failed"), { code: "COMPATIBILITY_ENCODE_FAILED" });
      },
      inspectOutput: async () => compatibleOutput(),
    });

    await cache.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(cache.get(media().fingerprint).status).toBe("failed"));

    expect(partialAttempts).toBe(2);
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".partial.mp4"))).toEqual([]);
  });

  it("defers orphan cleanup while an unsupported live owner is active", async () => {
    const cacheDir = await tempRoot();
    const now = Date.UTC(2026, 7, 23);
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "active");
      await gate.promise;
      await writeFile(outputPath, "complete");
      return { encoder: "libx264" };
    });
    const owner = createCompatibilityCache({
      cacheDir, encode, inspectOutput: async () => compatibleOutput(), processId: 101,
      randomUUID: () => "active-token", now: () => now, lockPollMs: 2,
    });
    await owner.start({ originalPath: "source.mov", inspection: media() });
    await eventually(() => expect(encode).toHaveBeenCalled());
    const activePartial = encode.mock.calls[0][0].outputPath;
    await eventually(async () => expect((await stat(activePartial)).isFile()).toBe(true));
    const orphan = path.join(cacheDir, `.${"b".repeat(64)}.999.orphan-token.partial.mp4`);
    await writeFile(orphan, "orphan");
    await utimes(orphan, new Date(now - 60_001), new Date(now - 60_001));
    const sweeper = createCompatibilityCache({
      cacheDir, now: () => now, partialOrphanMs: 60_000, sweepIntervalMs: 0,
      maxBytes: COMPATIBILITY_CACHE_MAX_BYTES, lockPollMs: 2,
      isProcessAlive: (pid) => pid === 101,
    });

    await sweeper.sweep();

    await expect(stat(activePartial)).resolves.toBeTruthy();
    await expect(stat(orphan)).resolves.toBeTruthy();
    gate.resolve();
    await eventually(() => expect(owner.get(media().fingerprint).status).toBe("ready"));
    await sweeper.sweep();
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("evicts expired and oldest files over 20 GiB while counting a young orphan partial", async () => {
    const cacheDir = await tempRoot();
    const now = Date.UTC(2026, 7, 23);
    const expired = path.join(cacheDir, `${"1".repeat(64)}-compat-v1.mp4`);
    const oldest = path.join(cacheDir, `${"2".repeat(64)}-compat-v1.mp4`);
    const newest = path.join(cacheDir, `${"3".repeat(64)}-compat-v1.mp4`);
    const youngPartial = path.join(cacheDir, `.${"4".repeat(64)}.123.young.partial.mp4`);
    await Promise.all([expired, oldest, newest, youngPartial].map((file) => writeFile(file, "x")));
    await utimes(expired, new Date(now - COMPATIBILITY_CACHE_TTL_MS - 1), new Date(now - COMPATIBILITY_CACHE_TTL_MS - 1));
    await utimes(oldest, new Date(now - 3_000), new Date(now - 3_000));
    await utimes(newest, new Date(now - 1_000), new Date(now - 1_000));
    const fakeStat = async (file: string) => {
      const actual = await stat(file);
      return Object.assign(actual, { size: file === newest ? COMPATIBILITY_CACHE_MAX_BYTES : 10 });
    };
    const cache = createCompatibilityCache({
      cacheDir,
      now: () => now,
      fileSystem: { stat: fakeStat },
      encode: vi.fn(),
      inspectOutput: vi.fn(),
      sweepIntervalMs: 0,
    });

    await cache.sweep();

    expect(await readdir(cacheDir)).toEqual([path.basename(youngPartial)]);
  });
});
