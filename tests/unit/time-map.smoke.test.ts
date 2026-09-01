import { describe, expect, it } from "vitest";

import { splitRatioAt, timelineToSourceTime } from "@/lib/repurpose/time-map";
import type { Clip } from "@/lib/repurpose/types";

describe("timelineToSourceTime", () => {
  it("maps an output time into the kept clip's source range", () => {
    const clip: Clip = {
      id: "kept-clip",
      kind: "take",
      label: "Kept clip",
      srcStart: 10,
      srcEnd: 12,
      timelineStart: 0,
      timelineEnd: 2,
      kept: true,
      isKeeperTake: true,
      occurrences: [{ start: 10, end: 12 }],
      keeperIndex: 0,
    };

    expect(timelineToSourceTime([clip], 0.5)).toBe(10.5);
  });
});

function ratioClip(
  id: string,
  timelineStart: number,
  splitRatio?: number,
  transitionIn?: Clip["transitionIn"]
): Clip {
  return {
    id,
    kind: "take",
    label: id,
    srcStart: timelineStart,
    srcEnd: timelineStart + 1,
    timelineStart,
    timelineEnd: timelineStart + 1,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: timelineStart, end: timelineStart + 1 }],
    keeperIndex: 0,
    splitRatio,
    transitionIn,
  };
}

describe("splitRatioAt", () => {
  it("resolves exact full-frame endpoint overrides", () => {
    const clips = [ratioClip("face", 0, 0), ratioClip("screen", 1, 1)];

    expect(splitRatioAt(clips, 0.5, 0.5)).toBe(0);
    expect(splitRatioAt(clips, 1.5, 0.5)).toBe(1);
  });

  it("interpolates between full-frame endpoints", () => {
    const clips = [
      ratioClip("face", 0, 0),
      ratioClip("screen", 1, 1, {
        type: "zoom-settle",
        durationSec: 0.8,
        amount: 0.025,
        easing: "natural",
      }),
    ];

    expect(splitRatioAt(clips, 1.4, 0.5)).toBeCloseTo(0.5);
  });

  it("clamps bounce overshoot and malformed runtime ratios", () => {
    const clips = [
      ratioClip("screen", 0, 1),
      ratioClip("face", 1, 0, {
        type: "zoom-settle",
        durationSec: 0.8,
        amount: 0.025,
        easing: "bounce",
      }),
    ];
    const malformed = ratioClip("malformed", 0, Number.NaN);

    expect(splitRatioAt(clips, 1.6, 0.5)).toBe(0);
    expect(splitRatioAt([malformed], 0.5, 0.79)).toBe(0.79);
    expect(splitRatioAt([], 0, Number.NaN)).toBe(0.5);
    expect(splitRatioAt([ratioClip("too-high", 0, 2)], 0.5, 0.5)).toBe(1);
  });

  it.each([
    { globalSplit: 0.2, expected: 0.2 },
    { globalSplit: 0.79, expected: 0.79 },
    { globalSplit: -1, expected: 0 },
    { globalSplit: 2, expected: 1 },
  ])(
    "uses valid or clamped global $globalSplit when the clip has no override",
    ({ globalSplit, expected }) => {
      expect(splitRatioAt([ratioClip("inherited", 0)], 0.5, globalSplit)).toBe(
        expected
      );
    }
  );

  it("prefers an explicit valid clip override when the global ratio is malformed", () => {
    expect(
      splitRatioAt([ratioClip("explicit", 0, 0.2)], 0.5, Number.NaN)
    ).toBe(0.2);
  });
});
