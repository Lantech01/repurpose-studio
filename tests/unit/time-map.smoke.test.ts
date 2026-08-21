import { describe, expect, it } from "vitest";

import { timelineToSourceTime } from "@/lib/repurpose/time-map";
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
