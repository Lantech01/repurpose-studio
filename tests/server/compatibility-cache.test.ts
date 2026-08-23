// @vitest-environment node

import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPATIBILITY_CACHE_MAX_BYTES,
  COMPATIBILITY_CACHE_TTL_MS,
  createCompatibilityCache,
  validateCompatibilityOutput,
} from "@/lib/repurpose/compatibility-cache.server";
import {
  buildCompatibilityArguments,
  createFfmpegProcessRunner,
  encoderCandidates,
  parseFfmpegProgress,
  type SpawnedProcess,
} from "@/lib/repurpose/ffmpeg-process.server";
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

  it("uses exact common mappings and preserves geometry and valid frame rate", () => {
    const args = buildCompatibilityArguments({
      inputPath: "input.mov",
      outputPath: "output.partial.mp4",
      encoder: "libx264",
      inspection: media(),
    });
    expect(args).toEqual(expect.arrayContaining([
      "-i", "input.mov", "-map", "0:v:0", "-map", "0:a:0?", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-c:v", "libx264",
      "-preset", "medium", "-crf", "18", "-r", "30", "output.partial.mp4",
    ]));
    expect(args).not.toContain("-vf");
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
});

describe("compatibility validation", () => {
  it.each([
    ["codec", compatibleOutput(media(), { video: { ...media().video, codec: "hevc" } })],
    ["pixel format", compatibleOutput(media(), { video: { ...media().video, codec: "h264", pixelFormat: "yuv444p" } })],
    ["width", compatibleOutput(media(), { video: { ...media().video, codec: "h264", width: 318 } })],
    ["height", compatibleOutput(media(), { video: { ...media().video, codec: "h264", height: 178 } })],
    ["frame rate", compatibleOutput(media(), { video: { ...media().video, codec: "h264", fps: 30.02 } })],
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
});

describe("compatibility cache lifecycle", () => {
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
    expect([first.status, second.status]).toEqual(expect.arrayContaining(["queued", "building"]));
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
    expect((await readdir(cacheDir)).filter((name) => name.includes("job-1"))).toEqual([]);

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
    expect(await readdir(cacheDir)).toEqual([]);
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
    expect(await readdir(cacheDir)).toEqual([]);
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

  it("evicts expired and oldest files over 20 GiB without deleting active partials", async () => {
    const cacheDir = await tempRoot();
    const now = Date.UTC(2026, 7, 23);
    const expired = path.join(cacheDir, `${"1".repeat(64)}-compat-v1.mp4`);
    const oldest = path.join(cacheDir, `${"2".repeat(64)}-compat-v1.mp4`);
    const newest = path.join(cacheDir, `${"3".repeat(64)}-compat-v1.mp4`);
    const active = path.join(cacheDir, `.${"4".repeat(64)}.123.active.partial.mp4`);
    await Promise.all([expired, oldest, newest, active].map((file) => writeFile(file, "x")));
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

    expect(await readdir(cacheDir)).toEqual([path.basename(active), path.basename(newest)].sort());
  });
});
