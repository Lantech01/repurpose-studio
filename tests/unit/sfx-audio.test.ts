import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyzeBuiltInPeak,
  builtInSourceBaseGain,
  loadResolvedSfxAudio,
  secondsToSample,
  sourceBaseGain,
} from "@/lib/repurpose/sfx-audio";
import { resolveSfxSource } from "@/lib/repurpose/sfx-source";
import type { SfxAsset } from "@/lib/repurpose/types";

function audioBuffer(
  channels: number[][],
  sampleRate = 4,
  duration = channels[0]?.length / sampleRate
): AudioBuffer {
  return {
    duration,
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData: (channel: number) => Float32Array.from(channels[channel]),
  } as AudioBuffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SFX source resolution", () => {
  it("resolves built-ins from public keys without exposing installation paths", () => {
    const resolved = resolveSfxSource({ kind: "built-in", key: "mouse_click" }, []);

    expect(resolved).toEqual({
      kind: "built-in",
      identity: "built-in:mouse_click",
      url: "/api/repurpose/sfx?key=mouse_click",
      sourceDuration: 0.9288125,
      targetAmplitude: 0.5,
      missing: false,
    });
    expect(JSON.stringify(resolved)).not.toMatch(/[A-Z]:\\|scripts[/\\]sfx-engine/i);
  });

  it("uses exact imported inventory paths while retaining structural duration", () => {
    const assets: SfxAsset[] = [
      { id: "other", name: "Other", sourcePath: "C:\\audio\\other.wav", srcDuration: 9 },
      { id: "asset-1", name: "Chosen", sourcePath: "C:\\audio\\chosen #1.wav", srcDuration: 7 },
    ];
    const resolved = resolveSfxSource(
      { kind: "imported", assetId: "asset-1", srcDuration: 2.5 },
      assets
    );

    expect(resolved).toMatchObject({
      kind: "imported",
      url: `/api/repurpose/asset?path=${encodeURIComponent("C:\\audio\\chosen #1.wav")}`,
      sourceDuration: 2.5,
      targetAmplitude: 1,
      missing: false,
    });
    expect(resolved.identity).toContain("asset-1");
    expect(resolveSfxSource(
      { kind: "imported", assetId: "asset-1", srcDuration: 2.5 },
      [{ ...assets[1], sourcePath: "C:\\audio\\moved.wav" }]
    ).identity).not.toBe(resolved.identity);
  });

  it("marks a missing imported asset without substituting another inventory entry", () => {
    const resolved = resolveSfxSource(
      { kind: "imported", assetId: "missing", srcDuration: 3 },
      [{ id: "other", name: "Other", sourcePath: "C:\\other.wav", srcDuration: 3 }]
    );

    expect(resolved).toEqual({
      kind: "imported",
      identity: "imported:missing:missing",
      url: null,
      sourceDuration: 3,
      targetAmplitude: 1,
      missing: true,
    });
    expect(resolveSfxSource(
      { kind: "imported", assetId: "missing", srcDuration: 3 },
      [{ id: "missing", name: "Found", sourcePath: "missing", srcDuration: 3 }]
    ).identity).not.toBe(resolved.identity);
  });

  it("resolves legacy paths with neutral base-gain semantics", () => {
    const sourcePath = "C:\\cache\\sfx-old.wav";
    expect(resolveSfxSource({ kind: "legacy", sourcePath, srcDuration: 8 }, [])).toEqual({
      kind: "legacy",
      identity: `legacy:${sourcePath}`,
      url: `/api/repurpose/sfx?path=${encodeURIComponent(sourcePath)}`,
      sourceDuration: 8,
      targetAmplitude: 1,
      missing: false,
    });
  });
});

describe("SFX PCM analysis", () => {
  it("rounds finite nonnegative seconds to sample positions safely", () => {
    expect(secondsToSample(0.49, 10)).toBe(5);
    expect(secondsToSample(0, 48_000)).toBe(0);
    expect(secondsToSample(-1, 48_000)).toBe(0);
    expect(secondsToSample(Number.NaN, 48_000)).toBe(0);
    expect(secondsToSample(1, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("finds the maximum absolute peak across every channel in the usable interval", () => {
    const buffer = audioBuffer([
      [0.1, -0.4, 0.2, 0.9],
      [-0.2, 0.75, -0.3, 0.95],
    ]);

    expect(analyzeBuiltInPeak(buffer, 0.75)).toBeCloseTo(0.75);
  });

  it("limits built-in peak analysis to the usable first second", () => {
    const buffer = audioBuffer([[0.1, -0.4, 0.2, 0.3, 0.95, -1, 0.8, 0.7]], 4, 2);

    expect(analyzeBuiltInPeak(buffer, 2)).toBeCloseTo(0.4);
  });

  it.each([
    ["silent PCM", audioBuffer([[0, 0], [0, 0]])],
    ["non-finite PCM", audioBuffer([[0.2, Number.NaN]])],
    ["zero channels", audioBuffer([])],
    ["zero usable samples", audioBuffer([[0.2]], 4, 0.25)],
  ])("rejects %s", (_name, buffer) => {
    const duration = _name === "zero usable samples" ? 0 : 0.5;
    expect(() => analyzeBuiltInPeak(buffer, duration)).toThrow(/usable|finite|silent/i);
  });

  it("computes target-over-peak gain for built-ins and neutral gain otherwise", () => {
    expect(builtInSourceBaseGain(0.2, 0.5)).toBeCloseTo(0.4);
    expect(() => builtInSourceBaseGain(0.2, 0)).toThrow(/peak/i);
    expect(() => builtInSourceBaseGain(Number.NaN, 0.5)).toThrow(/target/i);
    expect(sourceBaseGain("built-in", 0.2, 0.5)).toBeCloseTo(0.4);
    expect(sourceBaseGain("imported", 1, Number.NaN)).toBe(1);
    expect(sourceBaseGain("legacy", 1, 0)).toBe(1);
  });
});

describe("resolved SFX audio loading", () => {
  it("fetches, decodes, validates, and normalizes built-in audio", async () => {
    const bytes = new ArrayBuffer(8);
    const decoded = audioBuffer([[0.1, -0.5], [0.2, 0.25]], 2, 1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = {
      decodeAudioData: vi.fn().mockResolvedValue(decoded),
    } as unknown as BaseAudioContext;
    const resolved = resolveSfxSource({ kind: "built-in", key: "mouse_click" }, []);

    await expect(loadResolvedSfxAudio(resolved, context, new AbortController().signal))
      .resolves.toEqual({ buffer: decoded, sourceBaseGain: 1 });
    expect(fetchMock).toHaveBeenCalledWith(resolved.url, { signal: expect.any(AbortSignal) });
    expect(context.decodeAudioData).toHaveBeenCalledWith(bytes);
  });

  it("returns neutral gain for decoded imported audio", async () => {
    const decoded = audioBuffer([[0]], 1, 1);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new ArrayBuffer(1))));
    const context = { decodeAudioData: vi.fn().mockResolvedValue(decoded) } as unknown as BaseAudioContext;
    const resolved = resolveSfxSource(
      { kind: "imported", assetId: "a", srcDuration: 1 },
      [{ id: "a", name: "A", sourcePath: "C:\\a.wav", srcDuration: 1 }]
    );

    await expect(loadResolvedSfxAudio(resolved, context, new AbortController().signal))
      .resolves.toEqual({ buffer: decoded, sourceBaseGain: 1 });
  });

  it("rejects missing sources, non-OK HTTP, decode failures, and unusable buffers", async () => {
    const context = { decodeAudioData: vi.fn() } as unknown as BaseAudioContext;
    const missing = resolveSfxSource({ kind: "imported", assetId: "missing", srcDuration: 1 }, []);
    await expect(loadResolvedSfxAudio(missing, context, new AbortController().signal))
      .rejects.toThrow(/missing/i);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 404 })));
    const legacy = resolveSfxSource({ kind: "legacy", sourcePath: "C:\\old.wav", srcDuration: 1 }, []);
    await expect(loadResolvedSfxAudio(legacy, context, new AbortController().signal))
      .rejects.toThrow(/404/);

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new ArrayBuffer(1))));
    vi.mocked(context.decodeAudioData).mockRejectedValueOnce(new Error("decode failed"));
    await expect(loadResolvedSfxAudio(legacy, context, new AbortController().signal))
      .rejects.toThrow("decode failed");
    vi.mocked(context.decodeAudioData).mockResolvedValueOnce(audioBuffer([[0.1]], 1, Number.NaN));
    await expect(loadResolvedSfxAudio(legacy, context, new AbortController().signal))
      .rejects.toThrow(/duration/i);
  });

  it("rejects aborted work before fetch and promptly during an uncancellable decode", async () => {
    const before = new AbortController();
    before.abort();
    const resolved = resolveSfxSource({ kind: "legacy", sourcePath: "C:\\old.wav", srcDuration: 1 }, []);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = { decodeAudioData: vi.fn() } as unknown as BaseAudioContext;
    await expect(loadResolvedSfxAudio(resolved, context, before.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();

    let finishDecode!: (value: AudioBuffer) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ArrayBuffer(1))));
    vi.mocked(context.decodeAudioData).mockReturnValue(new Promise((resolve) => { finishDecode = resolve; }));
    const during = new AbortController();
    const removeAbortListener = vi.spyOn(during.signal, "removeEventListener");
    let staleSuccess = false;
    const pending = loadResolvedSfxAudio(resolved, context, during.signal);
    void pending.then(() => { staleSuccess = true; }, () => {});
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalled());
    during.abort();

    await expect(Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("decode still pending"), 20)),
    ])).rejects.toMatchObject({ name: "AbortError" });
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));

    finishDecode(audioBuffer([[0.2]], 1, 1));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(staleSuccess).toBe(false);
  });

  it("consumes a late decode rejection after prompt abort rejection", async () => {
    const resolved = resolveSfxSource({ kind: "legacy", sourcePath: "C:\\old.wav", srcDuration: 1 }, []);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ArrayBuffer(1))));
    let rejectDecode!: (error: Error) => void;
    const context = {
      decodeAudioData: vi.fn().mockReturnValue(new Promise((_resolve, reject) => { rejectDecode = reject; })),
    } as unknown as BaseAudioContext;
    const controller = new AbortController();
    const pending = loadResolvedSfxAudio(resolved, context, controller.signal);
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalled());

    controller.abort();
    await expect(Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("decode still pending"), 20)),
    ])).rejects.toMatchObject({ name: "AbortError" });
    rejectDecode(new Error("late decode failure"));
    await Promise.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
