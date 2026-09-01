import { describe, expect, it } from "vitest";

import { mixSfxClipsPcm } from "@/lib/repurpose/export-short";
import { clampPcmChannels, sumPcmChannels } from "@/lib/repurpose/sfx-export";
import type { SfxClip } from "@/lib/repurpose/types";

const clip = (overrides: Partial<SfxClip> = {}): SfxClip => ({
  id: "clip-a",
  name: "Hit",
  source: { kind: "built-in", key: "ding" },
  origin: "manual",
  timelineStart: 0.25,
  sourceStart: 0.25,
  sourceEnd: 0.75,
  gain: 0.5,
  fadeInSec: 0.25,
  fadeOutSec: 0.25,
  muted: false,
  ...overrides,
});

describe("deterministic SFX clip PCM mixing", () => {
  it("defers clipping until every export audio layer has been accumulated", () => {
    const out = [Float32Array.from([1.5])];
    mixSfxClipsPcm(out, 1, [{
      clip: clip({ timelineStart: 0, sourceStart: 0, sourceEnd: 1, gain: 1, fadeInSec: 0, fadeOutSec: 0 }),
      channels: [Float32Array.from([0.75])],
      sampleRate: 1,
      sourceBaseGain: 1,
    }]);

    expect(out[0][0]).toBe(2.25);
  });

  it("applies rounded offsets, trims, gain, proportional fades, overlap, and final clamp", () => {
    const out = [new Float32Array(8)];
    const source = [Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1])];
    mixSfxClipsPcm(out, 8, [
      { clip: clip(), channels: source, sampleRate: 8, sourceBaseGain: 1 },
      { clip: clip({ id: "clip-b", fadeInSec: 0, fadeOutSec: 0, gain: 2 }), channels: source, sampleRate: 8, sourceBaseGain: 1 },
    ]);
    clampPcmChannels(out);
    expect(Array.from(out[0])).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
  });

  it("cancels clipped-positive narration and music with opposite-phase SFX before the one final clamp", () => {
    const out = [Float32Array.from([0.8])];
    sumPcmChannels(out, [Float32Array.from([0.8])], 0);
    mixSfxClipsPcm(out, 1, [{
      clip: clip({ timelineStart: 0, sourceStart: 0, sourceEnd: 1, gain: 1, fadeInSec: 0, fadeOutSec: 0 }),
      channels: [Float32Array.from([-1])],
      sampleRate: 1,
      sourceBaseGain: 1,
    }]);
    clampPcmChannels(out);

    const previewWebAudioSum = 0.8 + 0.8 - 1;
    expect(out[0][0]).toBeCloseTo(previewWebAudioSum);
    expect(out[0][0]).toBeCloseTo(0.6);
  });

  it("maps mono into stereo and skips muted clips", () => {
    const out = [new Float32Array(4), new Float32Array(4)];
    mixSfxClipsPcm(out, 4, [
      { clip: clip({ timelineStart: 0, sourceStart: 0, sourceEnd: 1, gain: 1, fadeInSec: 0, fadeOutSec: 0 }), channels: [Float32Array.from([0.25, 0.5, 0.75, 1])], sampleRate: 4, sourceBaseGain: 1 },
      { clip: clip({ id: "muted", muted: true }), channels: [Float32Array.from([1, 1, 1, 1])], sampleRate: 4, sourceBaseGain: 1 },
    ]);
    expect(Array.from(out[0])).toEqual([0.25, 0.5, 0.75, 1]);
    expect(Array.from(out[1])).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("clamps after summing all overlapping clips so source order cannot discard cancellation", () => {
    const positive = {
      clip: clip({ timelineStart: 0, sourceStart: 0, sourceEnd: 1, gain: 2, fadeInSec: 0, fadeOutSec: 0 }),
      channels: [Float32Array.from([1])],
      sampleRate: 1,
      sourceBaseGain: 1,
    };
    const negative = {
      clip: clip({ id: "negative", timelineStart: 0, sourceStart: 0, sourceEnd: 1, gain: 1, fadeInSec: 0, fadeOutSec: 0 }),
      channels: [Float32Array.from([-1])],
      sampleRate: 1,
      sourceBaseGain: 1,
    };
    const forward = [new Float32Array(1)];
    const reverse = [new Float32Array(1)];

    mixSfxClipsPcm(forward, 1, [positive, negative]);
    mixSfxClipsPcm(reverse, 1, [negative, positive]);

    expect(Array.from(forward[0])).toEqual([1]);
    expect(Array.from(reverse[0])).toEqual([1]);
  });
});
