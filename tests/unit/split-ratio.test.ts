import { describe, expect, it } from "vitest";

import {
  clampSplitRatio,
  effectiveSplitRatio,
  parsePersistedSplitRatio,
  snapPointerSplitRatio,
} from "@/lib/repurpose/split-ratio";

describe("split ratio contract", () => {
  it.each([
    [-1, 0],
    [0, 0],
    [0.2, 0.2],
    [0.79, 0.79],
    [1, 1],
    [2, 1],
  ])("clamps finite ratio %s to %s", (value, expected) => {
    expect(clampSplitRatio(value)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite ratio %s",
    (value) => {
      expect(clampSplitRatio(value)).toBeNull();
    }
  );

  it("uses a clamped fallback for invalid persisted values without snapping", () => {
    expect(parsePersistedSplitRatio("0.8", 0.37)).toBe(0.37);
    expect(parsePersistedSplitRatio(Number.NaN, 2)).toBe(1);
    expect(parsePersistedSplitRatio(undefined, Number.NaN)).toBe(0.5);
    expect(parsePersistedSplitRatio(0.0199, 0.5)).toBe(0.0199);
    expect(parsePersistedSplitRatio(0.9801, 0.5)).toBe(0.9801);
  });

  it.each([
    [0.0199, 0],
    [0.02, 0],
    [0.0201, 0.0201],
    [0.9799, 0.9799],
    [0.98, 1],
    [0.9801, 1],
  ])("snaps pointer ratio %s to %s at the exact thresholds", (value, expected) => {
    expect(snapPointerSplitRatio(value)).toBe(expected);
  });

  it("clamps before pointer snapping", () => {
    expect(snapPointerSplitRatio(-1)).toBe(0);
    expect(snapPointerSplitRatio(2)).toBe(1);
  });

  it("rounds ratios to the effective pixel boundary", () => {
    expect(effectiveSplitRatio(0.005, 100)).toBe(0.01);
    expect(effectiveSplitRatio(0.9996, 1920)).toBe(0.9994791666666667);
  });

  it.each([
    { height: 100, nearZero: 0.004, nearFull: 0.996 },
    { height: 1920, nearZero: 0.0002, nearFull: 0.9998 },
    { height: 3840, nearZero: 0.0001, nearFull: 0.9999 },
  ])(
    "rounds sub-pixel bands to exact endpoints on a $height-high surface",
    ({ height, nearZero, nearFull }) => {
      expect(effectiveSplitRatio(nearZero, height)).toBe(0);
      expect(effectiveSplitRatio(nearFull, height)).toBe(1);
    }
  );

  it("uses a safe fallback for invalid ratios and heights", () => {
    expect(effectiveSplitRatio(Number.NaN, 100)).toBe(0.5);
    expect(effectiveSplitRatio(0.8, 0)).toBe(0.5);
    expect(effectiveSplitRatio(0.8, Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});
