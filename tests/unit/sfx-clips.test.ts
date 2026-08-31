import { describe, expect, it } from "vitest";

import {
  constrainSfxClipsToDuration,
  duplicateSfxClip,
  effectiveSfxFadeDurations,
  isSfxClipSourceAvailable,
  migrateLegacySfxTrack,
  moveSfxClip,
  normalizeSfxClip,
  normalizeSfxDocument,
  placeSfxClip,
  replaceAutomaticSfxClips,
  replaceSfxClipSource,
  resolveSfxClipAt,
  sfxClipDuration,
  sfxClipTimelineEnd,
  sfxClipsFromEvents,
  sfxSourceDuration,
  trimSfxClipLeft,
  trimSfxClipRight,
} from "@/lib/repurpose/sfx-clips";
import type { SfxAsset, SfxClip, SfxClipSource } from "@/lib/repurpose/types";

function clip(overrides: Partial<SfxClip> = {}): SfxClip {
  return {
    id: "sfx-1",
    name: "Whoosh",
    source: { kind: "built-in", key: "whoosh" },
    origin: "automatic",
    timelineStart: 3,
    sourceStart: 0,
    sourceEnd: 1,
    gain: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
    ...overrides,
  };
}

describe("SFX clip timing and source structure", () => {
  it("derives clip duration, timeline end, and source duration", () => {
    expect(sfxClipDuration(clip({ sourceStart: 0.2, sourceEnd: 0.8 }))).toBeCloseTo(0.6);
    expect(sfxClipTimelineEnd(clip())).toBe(4);
    expect(sfxSourceDuration({ kind: "built-in", key: "mouse_click" })).toBe(0.9288125);
    expect(sfxSourceDuration({ kind: "imported", assetId: "asset-1", srcDuration: 4 })).toBe(4);
    expect(sfxSourceDuration({ kind: "legacy", sourcePath: "C:\\old.wav", srcDuration: 5 })).toBe(5);
  });

  it("keeps missing imported inventory structurally valid and unavailable", () => {
    const source: SfxClipSource = { kind: "imported", assetId: "missing", srcDuration: 2 };
    expect(normalizeSfxClip(clip({ source }), 10)).not.toBeNull();
    expect(isSfxClipSourceAvailable(source, [])).toBe(false);
    expect(isSfxClipSourceAvailable(source, [{ id: "other", name: "Other", sourcePath: "C:\\other.wav", srcDuration: 2 }])).toBe(false);
  });
});

describe("SFX clip normalization", () => {
  it("clamps source/output ranges, gain, and requested fades", () => {
    expect(normalizeSfxClip(clip({
      timelineStart: -1,
      sourceStart: -1,
      sourceEnd: 3,
      gain: 4,
      fadeInSec: 4,
      fadeOutSec: -1,
    }), 0.75)).toMatchObject({
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: 0.75,
      gain: 2,
      fadeInSec: 2,
      fadeOutSec: 0,
    });
  });

  it("rejects malformed, non-finite, and non-positive ranges independently", () => {
    expect(normalizeSfxClip(clip({ sourceEnd: 0 }), 10)).toBeNull();
    expect(normalizeSfxClip(clip({ timelineStart: Number.NaN }), 10)).toBeNull();
    expect(normalizeSfxClip(clip({ source: { kind: "imported", assetId: "a", srcDuration: 0 } }), 10)).toBeNull();
    expect(normalizeSfxDocument([
      clip(),
      { ...clip({ id: "bad" }), sourceEnd: Number.POSITIVE_INFINITY },
      null,
    ], 10)).toEqual([clip()]);
  });
});

describe("SFX fades and resolution", () => {
  it("retains requested fades while scaling overlapping effective fades proportionally", () => {
    const faded = clip({ sourceEnd: 1.5, fadeInSec: 2, fadeOutSec: 1 });
    expect(faded).toMatchObject({ fadeInSec: 2, fadeOutSec: 1 });
    expect(effectiveSfxFadeDurations(faded)).toEqual({ fadeInSec: 1, fadeOutSec: 0.5 });
  });

  it("resolves start-inclusive/end-exclusive source time and effective gain", () => {
    const resolvedClip = clip({ fadeInSec: 1, fadeOutSec: 1 });
    expect(resolveSfxClipAt(resolvedClip, 3, 10, 1, 0.4)).toMatchObject({
      active: true,
      sourceTime: 0,
      effectiveGain: 0,
      audibleStart: 3,
      audibleEnd: 4,
    });
    expect(resolveSfxClipAt(resolvedClip, 3.5, 10, 1, 0.4)).toMatchObject({
      active: true,
      sourceTime: 0.5,
      effectiveGain: 0.4,
    });
    expect(resolveSfxClipAt(resolvedClip, 4, 10, 1, 0.4).active).toBe(false);
  });

  it("rejects playback outside project/source bounds and silences muted clips", () => {
    expect(resolveSfxClipAt(clip(), 3, 2, 1, 1).active).toBe(false);
    expect(resolveSfxClipAt(clip(), 3, 10, 0.5, 1).active).toBe(false);
    expect(resolveSfxClipAt(clip({ muted: true }), 3.5, 10, 1, 1)).toMatchObject({ active: false, effectiveGain: 0 });
  });
});

describe("SFX placement and editing", () => {
  it("places at requested time and backs a full default range up from reel end", () => {
    expect(placeSfxClip(clip({ timelineStart: 0 }), 4, 10)).toMatchObject({ timelineStart: 4, sourceEnd: 1 });
    expect(placeSfxClip(clip({ timelineStart: 0 }), 10, 10)).toMatchObject({ timelineStart: 9, sourceEnd: 1 });
    expect(placeSfxClip(clip({ timelineStart: 0 }), 20, 10)).toMatchObject({ timelineStart: 9, sourceEnd: 1 });
    expect(placeSfxClip(clip(), 0, 0)).toBeNull();
  });

  it("clamps moves while preserving the complete source duration", () => {
    const original = clip({ sourceStart: 0.2, sourceEnd: 0.8 });
    expect(moveSfxClip(original, -3, 5)).toMatchObject({ timelineStart: 0, sourceStart: 0.2, sourceEnd: 0.8 });
    expect(moveSfxClip(original, 5, 5)).toMatchObject({ timelineStart: 4.4, sourceStart: 0.2, sourceEnd: 0.8 });
  });

  it("left-trims source and output equally while preserving the right edge", () => {
    const original = clip({ timelineStart: 3, sourceStart: 0.1, sourceEnd: 0.9 });
    const trimmed = trimSfxClipLeft(original, 3.25);
    expect(trimmed).toMatchObject({ timelineStart: 3.25, sourceStart: 0.35, sourceEnd: 0.9 });
    expect(sfxClipTimelineEnd(trimmed)).toBeCloseTo(sfxClipTimelineEnd(original));
    expect(trimSfxClipLeft(original, 2)).toMatchObject({ timelineStart: 2.9, sourceStart: 0 });
  });

  it("right-trims sourceEnd only and respects source/project bounds", () => {
    const original = clip({ timelineStart: 3, sourceStart: 0.1, sourceEnd: 0.5 });
    expect(trimSfxClipRight(original, 3.8, 10, 1)).toMatchObject({ timelineStart: 3, sourceStart: 0.1, sourceEnd: 0.9 });
    expect(trimSfxClipRight(original, 20, 3.6, 1)).toMatchObject({ timelineStart: 3, sourceEnd: 0.7 });
  });

  it("destructively trims crossing clips and removes wholly out-of-range clips", () => {
    expect(constrainSfxClipsToDuration([
      clip({ id: "inside", timelineStart: 1 }),
      clip({ id: "crossing", timelineStart: 3.5 }),
      clip({ id: "outside", timelineStart: 5 }),
    ], 4)).toEqual([
      clip({ id: "inside", timelineStart: 1 }),
      clip({ id: "crossing", timelineStart: 3.5, sourceEnd: 0.5 }),
    ]);
  });

  it("replacement resets source range but preserves output controls and becomes manual", () => {
    const source: SfxClipSource = { kind: "imported", assetId: "asset-2", srcDuration: 4 };
    expect(replaceSfxClipSource(clip({
      timelineStart: 8,
      sourceStart: 0.4,
      sourceEnd: 0.8,
      gain: 1.5,
      fadeInSec: 1.5,
      fadeOutSec: 0.5,
      muted: true,
    }), { name: "Custom", source }, 10)).toEqual(clip({
      name: "Custom",
      source,
      origin: "manual",
      timelineStart: 8,
      sourceStart: 0,
      sourceEnd: 2,
      gain: 1.5,
      fadeInSec: 1.5,
      fadeOutSec: 0.5,
      muted: true,
    }));
  });

  it("duplicates manually after the source or overlaps without shortening", () => {
    expect(duplicateSfxClip(clip({ timelineStart: 2 }), "copy-1", 10)).toMatchObject({
      id: "copy-1",
      origin: "manual",
      timelineStart: 3,
      sourceEnd: 1,
    });
    expect(duplicateSfxClip(clip({ timelineStart: 9 }), "copy-2", 10)).toMatchObject({
      id: "copy-2",
      origin: "manual",
      timelineStart: 9,
      sourceEnd: 1,
    });
  });
});

describe("automatic clips and legacy migration", () => {
  it("maps each event to an independent normalized automatic built-in clip", () => {
    expect(sfxClipsFromEvents([
      { sfx: "mouse_click", atMs: 500 },
      { sfx: "whoosh", atMs: 9500 },
    ], 10, (index) => `auto-${index}`)).toEqual([
      clip({
        id: "auto-0",
        name: "Mouse Click",
        source: { kind: "built-in", key: "mouse_click" },
        timelineStart: 0.5,
        sourceEnd: 0.9288125,
      }),
      clip({ id: "auto-1", timelineStart: 9.5, sourceEnd: 0.5 }),
    ]);
  });

  it("partitions regeneration by replacing automatic clips and preserving manual clips", () => {
    const manual = clip({ id: "manual", origin: "manual" });
    const generated = clip({ id: "new-auto" });
    expect(replaceAutomaticSfxClips([clip({ id: "old-auto" }), manual], [generated]))
      .toEqual([manual, generated]);
  });

  it("migrates a legacy track with its timing and gain", () => {
    expect(migrateLegacySfxTrack({
      src: "/api/repurpose/sfx?path=old",
      sourcePath: "C:\\cache\\old.wav",
      durationSec: 12,
      gain: 0.7,
    }, 10, "legacy-1")).toEqual({
      id: "legacy-1",
      name: "Legacy Sound Effects",
      source: { kind: "legacy", sourcePath: "C:\\cache\\old.wav", srcDuration: 12 },
      origin: "automatic",
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: 10,
      gain: 0.7,
      fadeInSec: 0,
      fadeOutSec: 0,
      muted: false,
    });
  });

  it("recognizes imported inventory by id without substituting another asset", () => {
    const assets: SfxAsset[] = [{ id: "asset-1", name: "One", sourcePath: "C:\\one.wav", srcDuration: 2 }];
    expect(isSfxClipSourceAvailable({ kind: "imported", assetId: "asset-1", srcDuration: 2 }, assets)).toBe(true);
    expect(isSfxClipSourceAvailable({ kind: "imported", assetId: "missing", srcDuration: 2 }, assets)).toBe(false);
  });
});
