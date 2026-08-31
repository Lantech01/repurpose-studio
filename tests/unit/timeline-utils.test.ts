import { describe, expect, it } from "vitest";

import { packLanes } from "@/app/repurpose-studio/_components/timeline-utils";

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
