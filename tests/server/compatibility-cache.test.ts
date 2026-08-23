// @vitest-environment node

import { link, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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

  it("rejects a changed display rotation even when coded dimensions match", () => {
    const input = media({ video: { ...media().video, rotationDeg: 90 } });
    const output = compatibleOutput(input, { video: { ...input.video, codec: "h264", rotationDeg: 0 } });

    expect(() => validateCompatibilityOutput(input, output)).toThrowError(/validation/i);
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

  it("coordinates two independent cache instances so one encodes and both reuse one final", async () => {
    const cacheDir = await tempRoot();
    const gate = deferred<void>();
    const encode = vi.fn(async ({ outputPath }) => {
      await writeFile(outputPath, "partial");
      await gate.promise;
      await writeFile(outputPath, "winner");
      return { encoder: "libx264" };
    });
    const options = { cacheDir, encode, inspectOutput: async () => compatibleOutput(), lockPollMs: 2 };
    const first = createCompatibilityCache({ ...options, processId: 101, randomUUID: () => "first" });
    const second = createCompatibilityCache({ ...options, processId: 202, randomUUID: () => "second" });
    const input = { originalPath: "source.mov", inspection: media() };

    await Promise.all([first.start(input), second.start(input)]);
    await eventually(() => expect(encode).toHaveBeenCalled());
    const callsBeforeRelease = encode.mock.calls.length;
    gate.resolve();
    await eventually(() => expect([first.get(media().fingerprint).status, second.get(media().fingerprint).status]).toEqual(["ready", "ready"]));

    expect(callsBeforeRelease).toBe(1);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(first.get(media().fingerprint).workingPath).toBe(second.get(media().fingerprint).workingPath);
    await expect(stat(first.get(media().fingerprint).workingPath!)).resolves.toMatchObject({ size: 6 });
  });

  it("lets a follower cancel the filesystem-wide owner and waits for its partial cleanup", async () => {
    const cacheDir = await tempRoot();
    const encodeStarted = deferred<string>();
    const encode = vi.fn(async ({ outputPath, signal }: { outputPath: string; signal: AbortSignal }) => {
      await writeFile(outputPath, "active-partial");
      encodeStarted.resolve(outputPath);
      await new Promise<void>((_resolve, reject) => {
        const rejectCancelled = () => reject(Object.assign(new Error("cancelled"), { code: "COMPATIBILITY_CANCELLED" }));
        if (signal.aborted) rejectCancelled();
        else signal.addEventListener("abort", rejectCancelled, { once: true });
      });
      return { encoder: "libx264" };
    });
    const options = { cacheDir, encode, inspectOutput: async () => compatibleOutput(), lockPollMs: 20 };
    const owner = createCompatibilityCache({ ...options, processId: 301, randomUUID: () => "owner-token" });
    const follower = createCompatibilityCache({ ...options, processId: 302, randomUUID: () => "follower-token" });
    const input = { originalPath: "source.mov", inspection: media() };
    await owner.start(input);
    const partialPath = await encodeStarted.promise;
    await follower.start(input);

    await follower.cancel(media().fingerprint);

    await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    await eventually(() => expect(owner.get(media().fingerprint).status).toBe("cancelled"));
    expect(encode).toHaveBeenCalledTimes(1);
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

  it("reaps one stale generation without ABA and still elects one winner", async () => {
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
      lockStaleMs: 100, lockPollMs: 2, isProcessAlive: () => false,
    };
    const first = createCompatibilityCache({ ...options, processId: 401, randomUUID: () => "new-one" });
    const second = createCompatibilityCache({ ...options, processId: 402, randomUUID: () => "new-two" });

    await Promise.all([
      first.start({ originalPath: "source.mov", inspection: media() }),
      second.start({ originalPath: "source.mov", inspection: media() }),
    ]);
    await eventually(() => expect(encode).toHaveBeenCalled());
    const callsBeforeRelease = encode.mock.calls.length;
    gate.resolve();
    await eventually(() => expect([first.get(fingerprint).status, second.get(fingerprint).status]).toEqual(["ready", "ready"]));

    expect(callsBeforeRelease).toBe(1);
    expect(encode).toHaveBeenCalledTimes(1);
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
    const finalPath = cache.get(media().fingerprint).workingPath!;
    now += 101;

    await cache.sweep();

    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(cache.get(media().fingerprint)).toEqual({ status: "none", progress: null });
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

  it("sweeps old orphan partials but preserves a partial owned by another active cache", async () => {
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
    });

    await sweeper.sweep();

    await expect(stat(activePartial)).resolves.toBeTruthy();
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    gate.resolve();
    await eventually(() => expect(owner.get(media().fingerprint).status).toBe("ready"));
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
