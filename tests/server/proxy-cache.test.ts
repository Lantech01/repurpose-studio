// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildProxyArguments,
  createProxyCache,
  createProxyEncoder,
  inspectProxyPlayback,
  PROXY_CACHE_MAX_BYTES,
  PROXY_CACHE_TTL_MS,
  PROXY_SETTINGS_VERSION,
  PROXY_SHORT_SIDE,
  proxyCachePath,
  proxyDimensions,
  proxyGopFrames,
  validateProxyOutput,
  validateProxyPlayback,
} from "@/lib/repurpose/proxy-cache";
import type { SpawnedProcess } from "@/lib/repurpose/ffmpeg-process.server";
import type { MediaInspection } from "@/lib/repurpose/media-types";
import { inspectMedia } from "@/lib/repurpose/media-inspection.server";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
      fps: 29.97,
    },
    audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
    ...overrides,
  };
}

function proxyOutput(input = media()): MediaInspection {
  const dimensions = proxyDimensions(input.video.width, input.video.height);
  return {
    ...input,
    fingerprint: "b".repeat(64),
    extension: ".mp4",
    video: {
      ...input.video,
      codec: "h264",
      pixelFormat: "yuv420p",
      ...dimensions,
    },
    audio: input.audio ? { ...input.audio, codec: "aac" } : null,
  };
}

function playbackOutput(input = media()) {
  return {
    keyframeTimesSec: Array.from(
      { length: Math.floor(input.durationSec / 0.5) + 1 },
      (_, index) => index * 0.5
    ),
    audioDurationSec: input.audio ? input.durationSec : null,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-proxy-test-"));
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

describe("540p proxy settings", () => {
  it("versions filenames and enforces the approved cache policy", () => {
    expect(PROXY_SETTINGS_VERSION).toBe("proxy-v2-540p-gop-half-second");
    expect(PROXY_SHORT_SIDE).toBe(540);
    expect(PROXY_CACHE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(PROXY_CACHE_MAX_BYTES).toBe(10 * 1024 * 1024 * 1024);
    expect(proxyCachePath("C:\\media\\clip.mov", 123.4, 99)).toContain(
      "proxy-v2-540p-gop-half-second"
    );
  });

  it.each([
    [1920, 1080, 960, 540],
    [1080, 1920, 540, 960],
    [853, 480, 960, 540],
    [320, 180, 960, 540],
  ])("scales %ix%i to an even 540px short side", (width, height, expectedWidth, expectedHeight) => {
    const dimensions = proxyDimensions(width, height);
    expect(dimensions).toEqual({ width: expectedWidth, height: expectedHeight });
    expect(dimensions.width % 2).toBe(0);
    expect(dimensions.height % 2).toBe(0);
  });

  it("derives a half-second GOP and emits H.264/yuv420p/AAC/faststart arguments", () => {
    expect(proxyGopFrames(29.97)).toBe(15);
    expect(proxyGopFrames(1)).toBe(1);
    const args = buildProxyArguments({
      inputPath: "input.mov",
      outputPath: "output.partial.mp4",
      inspection: media(),
      encoder: "libx264",
    });

    expect(args).toEqual(expect.arrayContaining([
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15",
      "-force_key_frames", "expr:gte(t,n_forced*0.5)",
      "-keyint_min", "15", "-sc_threshold", "0", "-c:a", "aac",
      "-movflags", "+faststart", "output.partial.mp4",
    ]));
    expect(args[args.indexOf("-vf") + 1]).toContain("540");
  });

  it("rejects output before publication unless codec, geometry, duration, and audio are valid", () => {
    expect(() => validateProxyOutput(media(), proxyOutput())).not.toThrow();
    expect(() =>
      validateProxyOutput(media(), {
        ...proxyOutput(),
        video: { ...proxyOutput().video, width: 958 },
      })
    ).toThrowError(/validation/i);
    expect(() =>
      validateProxyOutput(media(), {
        ...proxyOutput(),
        video: { ...proxyOutput().video, codec: "hevc" },
      })
    ).toThrowError(/validation/i);
  });

  it("compares output audio with the input audio stream duration", () => {
    const input = media({
      audio: {
        codec: "aac",
        channels: 2,
        sampleRate: 48_000,
        durationSec: 1,
      },
    } as Partial<MediaInspection>);
    const output = proxyOutput(input);

    expect(() =>
      validateProxyPlayback(input, output, {
        keyframeTimesSec: [0, 0.5, 1, 1.5, 2, 2.5, 3],
        audioDurationSec: 1,
      })
    ).not.toThrow();
  });

  it("validates long keyframe timelines without exhausting the call stack", () => {
    const input = media({ durationSec: 100_000 });
    const output = proxyOutput(input);
    const keyframeTimesSec = Array.from(
      { length: 200_001 },
      (_, index) => index * 0.5
    );

    expect(() =>
      validateProxyPlayback(input, output, {
        keyframeTimesSec,
        audioDurationSec: input.durationSec,
      })
    ).not.toThrow();
  });
});

describe("proxy encoder and cache lifecycle", () => {
  it("produces a validated 540p proxy with no keyframe gap above 0.6 seconds", async () => {
    const root = await tempRoot();
    const inputPath = path.resolve(
      "tests",
      "fixtures",
      "generated",
      "h264-aac.mp4"
    );
    const outputPath = path.join(root, "actual-proxy.partial.mp4");
    const input = await inspectMedia(inputPath);

    const encoded = await createProxyEncoder({ platform: "win32" }).encode({
      inputPath,
      outputPath,
      inspection: input,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });
    const output = await inspectMedia(outputPath);
    expect(() => validateProxyOutput(input, output)).not.toThrow();
    expect(output.video).toMatchObject({
      codec: "h264",
      pixelFormat: "yuv420p",
      width: 960,
      height: 540,
    });
    expect(output.audio?.codec).toBe("aac");

    const playback = await inspectProxyPlayback(outputPath);
    expect(() => validateProxyPlayback(input, output, playback)).not.toThrow();
    const times = playback.keyframeTimesSec;
    expect(times.length, `encoder ${encoded.encoder}`).toBeGreaterThan(1);
    expect(
      Math.max(...times.slice(1).map((time, index) => time - times[index]))
    ).toBeLessThanOrEqual(0.6);
  });

  it("uses platform hardware order and falls back after real encode failures", async () => {
    const encoders: string[] = [];
    const adapter = {
      run: vi.fn((_executable: string, args: string[]): SpawnedProcess => {
        if (args.includes("-encoders")) {
          return {
            completion: Promise.resolve({
              code: 0,
              stdout: "h264_nvenc\nh264_qsv\nh264_amf\nlibx264\n",
              stderr: "",
            }),
            kill: vi.fn(),
          };
        }
        const encoder = args[args.indexOf("-c:v") + 1];
        encoders.push(encoder);
        return {
          completion: Promise.resolve({
            code: encoder === "libx264" ? 0 : 1,
            stdout: "",
            stderr: encoder === "libx264" ? "" : "device failed",
          }),
          kill: vi.fn(),
        };
      }),
    };

    await createProxyEncoder({ adapter, platform: "win32" }).encode({
      inputPath: "input.mov",
      outputPath: "output.partial.mp4",
      inspection: media(),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(encoders).toEqual(["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
  });

  it("deduplicates one fingerprinted job and atomically publishes only after validation", async () => {
    const cacheDir = await tempRoot();
    const release = Promise.withResolvers<void>();
    const encode = vi.fn(async ({ outputPath }: { outputPath: string }) => {
      await writeFile(outputPath, "partial");
      await release.promise;
      await writeFile(outputPath, "validated");
      return { encoder: "libx264" as const };
    });
    const cache = createProxyCache({
      cacheDir,
      encode,
      inspectInput: async () => media(),
      inspectOutput: async () => proxyOutput(),
      inspectPlayback: async () => playbackOutput(),
    });
    const input = { filePath: "C:\\media\\clip.mov", mtimeMs: 12, size: 34 };

    await Promise.all([cache.start(input), cache.start(input), cache.start(input)]);
    await eventually(() => expect(encode).toHaveBeenCalledTimes(1));
    expect(await readdir(cacheDir)).toEqual([
      expect.stringMatching(/\.partial\.mp4$/),
    ]);
    expect(cache.get(input)).toMatchObject({ status: "building" });

    release.resolve();
    await eventually(() => expect(cache.get(input).status).toBe("ready"));
    const ready = cache.get(input);
    expect(ready).toMatchObject({ status: "ready" });
    expect(ready.proxyPath).toContain(PROXY_SETTINGS_VERSION);
    await expect(readFile(ready.proxyPath!, "utf8")).resolves.toBe("validated");
    expect((await readdir(cacheDir)).some((name) => name.includes("partial"))).toBe(false);
  });

  it("removes invalid partial output and never exposes a final", async () => {
    const cacheDir = await tempRoot();
    const cache = createProxyCache({
      cacheDir,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "invalid");
        return { encoder: "libx264" };
      },
      inspectInput: async () => media(),
      inspectOutput: async () => ({
        ...proxyOutput(),
        video: { ...proxyOutput().video, codec: "hevc" },
      }),
    });
    const input = { filePath: "C:\\media\\clip.mov", mtimeMs: 12, size: 34 };

    await cache.start(input);
    await eventually(() => expect(cache.get(input).status).toBe("failed"));

    expect(await readdir(cacheDir)).toEqual([]);
  });

  it.each([
    {
      name: "a measured keyframe gap above 0.6 seconds",
      playback: {
        keyframeTimesSec: [0, 0.5, 1.2, 1.7, 2.2, 2.7],
        audioDurationSec: 3,
      },
    },
    {
      name: "materially truncated audio",
      playback: {
        keyframeTimesSec: [0, 0.5, 1, 1.5, 2, 2.5, 3],
        audioDurationSec: 1,
      },
    },
  ])("rejects $name before publication", async ({ playback }) => {
    const cacheDir = await tempRoot();
    const cache = createProxyCache({
      cacheDir,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "invalid-playback");
        return { encoder: "libx264" };
      },
      inspectInput: async () => media(),
      inspectOutput: async () => proxyOutput(),
      inspectPlayback: async () => playback,
    } as Parameters<typeof createProxyCache>[0] & {
      inspectPlayback: () => Promise<typeof playback>;
    });
    const input = {
      filePath: "C:\\media\\invalid-playback.mov",
      mtimeMs: 12,
      size: 34,
    };

    await cache.start(input);
    await eventually(() => expect(cache.get(input).status).toBe("failed"));

    expect(await readdir(cacheDir)).toEqual([]);
  });

  it("does not publish terminal failure until invalid partial cleanup settles", async () => {
    const cacheDir = await tempRoot();
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const removeFile = vi.fn(async (filePath: string) => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
      await rm(filePath, { force: true });
    });
    const cache = createProxyCache({
      cacheDir,
      remove: removeFile,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "invalid");
        return { encoder: "libx264" };
      },
      inspectInput: async () => media(),
      inspectOutput: async () => ({
        ...proxyOutput(),
        video: { ...proxyOutput().video, codec: "hevc" },
      }),
    } as Parameters<typeof createProxyCache>[0] & {
      remove: (filePath: string) => Promise<void>;
    });
    const input = { filePath: "C:\\media\\invalid.mov", mtimeMs: 12, size: 34 };

    await cache.start(input);
    await eventually(() => expect(removeFile).toHaveBeenCalledTimes(1));
    await cleanupStarted.promise;

    expect(cache.get(input)).toMatchObject({ status: "building" });
    expect(await readdir(cacheDir)).toEqual([
      expect.stringMatching(/\.partial\.mp4$/),
    ]);

    releaseCleanup.resolve();
    await eventually(() => expect(cache.get(input).status).toBe("failed"));
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it("reclaims stale orphan partials without touching active work, finals, or originals", async () => {
    const cacheDir = await tempRoot();
    let timestamp = Date.now();
    let cleanupFailures = 1;
    const activeStarted = Promise.withResolvers<string>();
    const releaseActive = Promise.withResolvers<void>();
    const removeFile = vi.fn(async (filePath: string) => {
      if (filePath.endsWith(".partial.mp4") && cleanupFailures > 0) {
        cleanupFailures -= 1;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      await rm(filePath, { force: true });
    });
    const cache = createProxyCache({
      cacheDir,
      maxBytes: 4,
      now: () => timestamp,
      remove: removeFile,
      encode: async ({ inputPath, outputPath }) => {
        await writeFile(outputPath, "12345678");
        if (inputPath.includes("active")) {
          activeStarted.resolve(outputPath);
          await releaseActive.promise;
        }
        throw new Error("encode failed");
      },
      inspectInput: async () => media(),
      inspectOutput: async () => proxyOutput(),
    } as Parameters<typeof createProxyCache>[0] & {
      remove: (filePath: string) => Promise<void>;
    });
    const sourcePath = path.join(cacheDir, "immutable-source.mov");
    const finalInput = { filePath: "C:\\media\\ready.mov", mtimeMs: 1, size: 1 };
    const finalPath = proxyCachePath(
      finalInput.filePath,
      finalInput.mtimeMs,
      finalInput.size,
      cacheDir
    );
    await writeFile(sourcePath, "source");
    await writeFile(finalPath, "1234");
    await expect(cache.lookup(finalInput)).resolves.toMatchObject({ status: "ready" });
    await cache.sweep();
    const failedInput = { filePath: "C:\\media\\failed.mov", mtimeMs: 2, size: 2 };
    await cache.start(failedInput);
    await eventually(() => expect(cache.get(failedInput).status).toBe("failed"));
    expect(removeFile).toHaveBeenCalledTimes(1);
    const orphan = (await readdir(cacheDir)).find((name) =>
      name.endsWith(".partial.mp4")
    );
    expect(orphan).toBeDefined();
    const orphanPath = path.join(cacheDir, orphan!);

    const activeInput = { filePath: "C:\\media\\active.mov", mtimeMs: 3, size: 3 };
    await cache.start(activeInput);
    const activePartial = await activeStarted.promise;
    timestamp += 20 * 60 * 1_000;

    await cache.sweep();

    expect(
      removeFile.mock.calls.filter(([filePath]) => filePath === orphanPath)
    ).toHaveLength(2);
    expect(removeFile).not.toHaveBeenCalledWith(activePartial);
    await expect(stat(orphanPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(activePartial, "utf8")).resolves.toBe("12345678");
    await expect(readFile(finalPath, "utf8")).resolves.toBe("1234");
    await expect(readFile(sourcePath, "utf8")).resolves.toBe("source");
    expect(cache.get(finalInput)).toMatchObject({ status: "ready" });
    expect(cache.get(activeInput)).toMatchObject({ status: "building" });

    releaseActive.resolve();
    await eventually(() => expect(cache.get(activeInput).status).toBe("failed"));
  });

  it("sweeps expired and over-budget finals without modifying source media", async () => {
    const cacheDir = await tempRoot();
    const sourcePath = path.join(cacheDir, "immutable-source.mov");
    await writeFile(sourcePath, "source");
    const before = await stat(sourcePath);
    const cache = createProxyCache({
      cacheDir,
      maxBytes: 4,
      ttlMs: 10,
      now: () => 100,
      encode: vi.fn(),
      inspectInput: async () => media(),
      inspectOutput: async () => proxyOutput(),
      inspectPlayback: async () => playbackOutput(),
    });
    await writeFile(path.join(cacheDir, `old-${PROXY_SETTINGS_VERSION}.mp4`), "1234");
    await writeFile(path.join(cacheDir, `new-${PROXY_SETTINGS_VERSION}.mp4`), "5678");

    await cache.sweep();

    expect(await readFile(sourcePath, "utf8")).toBe("source");
    expect((await stat(sourcePath)).size).toBe(before.size);
  });

  it("evicts known legacy 144p finals and partials without touching unrelated lookalikes", async () => {
    const cacheDir = await tempRoot();
    const timestamp = Date.now();
    const expiredLegacyFinal = path.join(
      cacheDir,
      "1111111111111111-144p.mp4"
    );
    const staleLegacyPartial = path.join(
      cacheDir,
      "2222222222222222-144p.mp4.123.partial.mp4"
    );
    const budgetLegacyFinal = path.join(
      cacheDir,
      "3333333333333333-144p.mp4"
    );
    const currentInput = {
      filePath: "C:\\media\\current.mov",
      mtimeMs: 4,
      size: 4,
    };
    const currentFinal = proxyCachePath(
      currentInput.filePath,
      currentInput.mtimeMs,
      currentInput.size,
      cacheDir
    );
    const unrelated = [
      path.join(cacheDir, "not-a-hash-144p.mp4"),
      path.join(cacheDir, "4444444444444444-144p.mp4.backup"),
      path.join(
        cacheDir,
        `${"4".repeat(24)}-proxy-v3-540p-forced-half-second-keyframes.mp4`
      ),
      path.join(cacheDir, "notes.txt"),
    ];
    await Promise.all([
      writeFile(expiredLegacyFinal, "expired"),
      writeFile(staleLegacyPartial, "orphan"),
      writeFile(budgetLegacyFinal, "1234"),
      writeFile(currentFinal, "5678"),
      ...unrelated.map((file) => writeFile(file, "unrelated-managed-lookalike")),
    ]);
    await Promise.all([
      utimes(
        expiredLegacyFinal,
        new Date(timestamp - PROXY_CACHE_TTL_MS - 1_000),
        new Date(timestamp - PROXY_CACHE_TTL_MS - 1_000)
      ),
      utimes(
        staleLegacyPartial,
        new Date(timestamp - 20 * 60 * 1_000),
        new Date(timestamp - 20 * 60 * 1_000)
      ),
      utimes(
        budgetLegacyFinal,
        new Date(timestamp - 1_000),
        new Date(timestamp - 1_000)
      ),
      utimes(currentFinal, new Date(timestamp), new Date(timestamp)),
    ]);
    const cache = createProxyCache({
      cacheDir,
      maxBytes: 4,
      now: () => timestamp,
      encode: vi.fn(),
      inspectInput: async () => media(),
      inspectOutput: async () => proxyOutput(),
    });
    await expect(cache.lookup(currentInput)).resolves.toMatchObject({
      status: "ready",
    });

    await cache.sweep();

    await expect(stat(expiredLegacyFinal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(staleLegacyPartial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(budgetLegacyFinal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(currentFinal, "utf8")).resolves.toBe("5678");
    for (const file of unrelated) {
      await expect(readFile(file, "utf8")).resolves.toBe(
        "unrelated-managed-lookalike"
      );
    }
  });

  it("serially trims over-budget finals after publication even when the pre-build sweep was throttled", async () => {
    const cacheDir = await tempRoot();
    const timestamp = Date.now();
    const oldInput = { filePath: "C:\\media\\old.mov", mtimeMs: 1, size: 1 };
    const newInput = { filePath: "C:\\media\\new.mov", mtimeMs: 2, size: 2 };
    const oldFinal = proxyCachePath(
      oldInput.filePath,
      oldInput.mtimeMs,
      oldInput.size,
      cacheDir
    );
    await writeFile(oldFinal, "1234");
    await utimes(oldFinal, new Date(timestamp - 1_000), new Date(timestamp - 1_000));
    const cache = createProxyCache({
      cacheDir,
      maxBytes: 6,
      now: () => timestamp,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "5678");
        return { encoder: "libx264" };
      },
      inspectInput: async () => media(),
      inspectOutput: async () => proxyOutput(),
      inspectPlayback: async () => playbackOutput(),
    });
    await expect(cache.lookup(oldInput)).resolves.toMatchObject({ status: "ready" });
    await cache.sweep();

    await cache.start(newInput);
    await eventually(() => expect(cache.get(newInput).status).toBe("ready"));

    expect(cache.get(oldInput)).toEqual({ status: "none" });
    const finals = (await readdir(cacheDir)).filter((name) => name.endsWith(".mp4"));
    const total = (
      await Promise.all(finals.map((name) => stat(path.join(cacheDir, name))))
    ).reduce((sum, metadata) => sum + metadata.size, 0);
    expect(total).toBeLessThanOrEqual(6);
    expect(finals).toEqual([
      path.basename(
        proxyCachePath(
          newInput.filePath,
          newInput.mtimeMs,
          newInput.size,
          cacheDir
        )
      ),
    ]);
  });

  it("keeps a leased final readable while another publication triggers trim", async () => {
    const cacheDir = await tempRoot();
    let timestamp = Date.now();
    const oldInput = { filePath: "C:\\media\\leased.mov", mtimeMs: 1, size: 1 };
    const newInput = { filePath: "C:\\media\\new.mov", mtimeMs: 2, size: 2 };
    const oldFinal = proxyCachePath(
      oldInput.filePath,
      oldInput.mtimeMs,
      oldInput.size,
      cacheDir
    );
    await writeFile(oldFinal, "1234");
    await utimes(oldFinal, new Date(timestamp - 1_000), new Date(timestamp - 1_000));
    const cache = createProxyCache({
      cacheDir,
      maxBytes: 6,
      now: () => timestamp,
      encode: async ({ outputPath }) => {
        await writeFile(outputPath, "5678");
        return { encoder: "libx264" };
      },
      inspectInput: async () => media(),
      inspectOutput: async () => proxyOutput(),
      inspectPlayback: async () => playbackOutput(),
    });
    await expect(cache.lookup(oldInput)).resolves.toMatchObject({ status: "ready" });
    const leaseCache = cache as typeof cache & {
      acquireLease: (proxyPath: string) => (() => void) | null;
    };

    expect(typeof leaseCache.acquireLease).toBe("function");
    const release = leaseCache.acquireLease(oldFinal);
    expect(release).toEqual(expect.any(Function));

    await cache.start(newInput);
    await eventually(() => expect(cache.get(newInput).status).toBe("ready"));
    await expect(readFile(oldFinal, "utf8")).resolves.toBe("1234");
    await expect(readFile(cache.get(newInput).proxyPath!, "utf8")).resolves.toBe(
      "5678"
    );

    release?.();
    timestamp += 20 * 60 * 1_000;
    await cache.sweep();
    await expect(stat(oldFinal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(cache.get(newInput).proxyPath!, "utf8")).resolves.toBe(
      "5678"
    );
  });
});
