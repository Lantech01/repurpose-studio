// @vitest-environment node

import { describe, expect, it } from "vitest";

import { APPROVED_SFX_KEYS, SFX_CATALOG } from "@/lib/repurpose/sfx-effects";
import { planSfxEvents } from "@/lib/repurpose/sfx-placement";
import type { Clip, Word } from "@/lib/repurpose/types";

function clip(id: string, srcStart: number, timelineStart: number): Clip {
  return {
    id,
    kind: "take",
    label: id,
    srcStart,
    srcEnd: srcStart + 4,
    timelineStart,
    timelineEnd: timelineStart + 4,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: srcStart, end: srcStart + 4 }],
    keeperIndex: 0,
  };
}

describe("planner-to-route SFX contract", () => {
  it("keeps typical multi-clip planner output inside the route's exact allowlist", () => {
    expect(APPROVED_SFX_KEYS).toEqual(Object.keys(SFX_CATALOG));
    const clips = [clip("one", 0, 0), clip("two", 10, 4), clip("three", 20, 8), clip("four", 30, 12)];
    const words: Word[] = [
      { text: "switch", start: 1, end: 1.2 },
      { text: "ready", start: 12, end: 12.2 },
      { text: "connected", start: 22, end: 22.2 },
    ];

    const events = planSfxEvents(words, clips, 16);
    const allowed = new Set<string>(APPROVED_SFX_KEYS);

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => allowed.has(event.sfx))).toBe(true);
    expect(events.map((event) => event.sfx)).toEqual(expect.arrayContaining([
      "whoosh",
      "digital_shutter",
      "impact",
      "notification",
    ]));
  });

  it("never emits an event on the route's exclusive duration boundary", () => {
    const clips = [clip("boundary", 0, 0)];
    const events = planSfxEvents([
      { text: "click", start: 4, end: 4 },
    ], clips, 4);

    expect(events.every((event) => event.atMs < 4000)).toBe(true);
    expect(events).not.toContainEqual({ sfx: "mouse_click", atMs: 4000 });
  });

  it("does not place a whoosh on a zero-duration final cut at the track end", () => {
    const finalCut = {
      ...clip("final", 10, 4),
      srcEnd: 10,
      timelineEnd: 4,
      occurrences: [{ start: 10, end: 10 }],
    };

    expect(planSfxEvents([], [clip("body", 0, 0), finalCut], 4))
      .not.toContainEqual({ sfx: "whoosh", atMs: 4000 });
  });
});
