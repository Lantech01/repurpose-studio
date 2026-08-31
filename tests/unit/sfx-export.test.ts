import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SfxExportPreflightError,
  mixPreparedSfxIntoBuffer,
  prepareSfxForExport,
} from "@/lib/repurpose/sfx-export";
import type { SfxAsset, SfxClip } from "@/lib/repurpose/types";

const asset: SfxAsset = {
  id: "asset-a",
  name: "Impact",
  sourcePath: "C:\\audio\\impact.wav",
  srcDuration: 1,
};

function clip(overrides: Partial<SfxClip> = {}): SfxClip {
  return {
    id: "clip-a",
    name: "Impact",
    source: { kind: "imported", assetId: asset.id, srcDuration: 1 },
    origin: "manual",
    timelineStart: 0,
    sourceStart: 0,
    sourceEnd: 0.5,
    gain: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
    ...overrides,
  };
}

function audioBuffer(duration = 1, sampleRate = 4, value = 0.5): AudioBuffer {
  const data = Float32Array.from({ length: Math.round(duration * sampleRate) }, () => value);
  return {
    duration,
    sampleRate,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

function installAudioContext(decoded = audioBuffer()) {
  const decodeAudioData = vi.fn().mockResolvedValue(decoded);
  const createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      duration: length / sampleRate,
      sampleRate,
      length,
      numberOfChannels: channels,
      getChannelData: (channel: number) => data[channel],
    } as AudioBuffer;
  });
  class OfflineAudioContextMock {
    decodeAudioData = decodeAudioData;
    createBuffer = createBuffer;
  }
  vi.stubGlobal("OfflineAudioContext", OfflineAudioContextMock);
  return { decodeAudioData, createBuffer };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SFX export preflight", () => {
  it("decodes each authoritative identity once and mixes every referencing clip", async () => {
    const { decodeAudioData } = installAudioContext();
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(4), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const clips = [clip(), clip({ id: "clip-b", timelineStart: 0.5 })];

    const prepared = await prepareSfxForExport(clips, [asset]);
    const mixed = mixPreparedSfxIntoBuffer(audioBuffer(1, 4, 0), clips, [asset], prepared, 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(Array.from(mixed.getChannelData(0))).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("rejects a clip beyond actual decoded duration using a named atomic error", async () => {
    installAudioContext(audioBuffer(0.5, 4));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(
      new Response(new ArrayBuffer(4), { status: 200 })
    )));

    await expect(prepareSfxForExport([
      clip({ sourceStart: 0.25, sourceEnd: 1 }),
    ], [asset])).rejects.toMatchObject({
      name: "SfxExportPreflightError",
      code: "invalid-source-bounds",
      clipId: "clip-a",
    } satisfies Partial<SfxExportPreflightError>);
  });

  it("allows sourceEnd to exceed decoded duration by at most one decoded sample", async () => {
    installAudioContext(audioBuffer(0.5, 4));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(
      new Response(new ArrayBuffer(4), { status: 200 })
    )));

    await expect(prepareSfxForExport([
      clip({ sourceEnd: 0.75 }),
    ], [asset])).resolves.toHaveProperty("size", 1);
    await expect(prepareSfxForExport([
      clip({ sourceEnd: 0.750001 }),
    ], [asset])).rejects.toMatchObject({ code: "invalid-source-bounds" });
  });

  it.each([
    { label: "missing asset", source: { kind: "imported", assetId: "missing", srcDuration: 1 } as const, assets: [asset] },
    { label: "blob asset", source: { kind: "imported", assetId: "blob", srcDuration: 1 } as const, assets: [{ ...asset, id: "blob", sourcePath: "blob:stale" }] },
  ])("rejects a $label before fetching", async ({ source, assets }) => {
    installAudioContext();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(prepareSfxForExport([clip({ source })], assets)).rejects.toMatchObject({
      code: "missing-source",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports corrupt audio as a named decode failure", async () => {
    const { decodeAudioData } = installAudioContext();
    decodeAudioData.mockRejectedValueOnce(new Error("bad codec"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ArrayBuffer(4), { status: 200 })));

    await expect(prepareSfxForExport([clip()], [asset])).rejects.toMatchObject({
      code: "decode-failed",
      clipId: "clip-a",
    });
  });

  it("prepares a migrated legacy source through the same authoritative boundary", async () => {
    installAudioContext();
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(4), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const legacy = clip({
      source: { kind: "legacy", sourcePath: "C:\\audio\\legacy.wav", srcDuration: 1 },
    });

    await expect(prepareSfxForExport([legacy], [])).resolves.toHaveProperty("size", 1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("legacy.wav"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
