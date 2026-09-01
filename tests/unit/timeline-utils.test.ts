import { describe, expect, it } from "vitest";

import { SNAP_PX, packLanes, snapMovedSpan } from "@/app/repurpose-studio/_components/timeline-utils";

it("uses the specified four-pixel snap threshold", () => {
  expect(SNAP_PX).toBe(4);
});

describe("packLanes", () => {
  it("reuses lanes for touching intervals and separates overlaps", () => {
    expect(packLanes([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ])).toEqual({ lanes: [0, 1, 0, 0], laneCount: 2 });
  });

  it("breaks equal-start ties deterministically by id", () => {
    const spans = [
      { id: "z", start: 1, end: 2 },
      { id: "a", start: 1, end: 3 },
    ];
    expect(packLanes(spans)).toEqual(packLanes([...spans]));
    expect(packLanes([...spans].reverse()).laneCount).toBe(2);
  });
});

describe("snapMovedSpan", () => {
  it("preserves leading-edge snapping", () => {
    expect(snapMovedSpan(1.04, 1, [1], .05)).toEqual({
      start: 1,
      snapped: true,
      snapTarget: 1,
      edge: "leading",
    });
  });

  it("translates the whole clip when only the trailing edge is in range", () => {
    expect(snapMovedSpan(1.1, .95, [2], .06)).toEqual({
      start: 1.05,
      snapped: true,
      snapTarget: 2,
      edge: "trailing",
    });
  });

  it("deterministically prefers the leading edge on an equal-distance tie", () => {
    expect(snapMovedSpan(1.05, .9, [2, 1], .06)).toEqual({
      start: 1,
      snapped: true,
      snapTarget: 1,
      edge: "leading",
    });
  });
});
