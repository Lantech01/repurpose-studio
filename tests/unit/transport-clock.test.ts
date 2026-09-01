import { describe, expect, it } from "vitest";
import {
  BASE_MEDIA_DRIFT_TOLERANCE_SEC,
  OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC,
  reanchorTransport,
  sampleTransport,
  shouldCorrectDrift,
  startTransport,
} from "@/lib/repurpose/transport-clock";

describe("transport clock", () => {
  it("advances exactly one output second in 1000 ms at 1x", () => {
    const anchor = startTransport(4, 1_000, 1, 7);

    expect(sampleTransport(anchor, 2_000, 0, 20)).toBe(5);
  });

  it("advances exactly two output seconds in 1000 ms at 2x", () => {
    const anchor = startTransport(4, 1_000, 2, 7);

    expect(sampleTransport(anchor, 2_000, 0, 20)).toBe(6);
  });

  it("clamps a sample at the playback-region end", () => {
    const anchor = startTransport(9.5, 0, 1, 7);

    expect(sampleTransport(anchor, 1_000, 2, 10)).toBe(10);
  });

  it("shows that a paused caller must retain the last sample instead of sampling a later timestamp", () => {
    const anchor = startTransport(4, 1_000, 1, 7);
    const frozenAtPause = sampleTransport(anchor, 1_500, 0, 20);
    const sampleIfPlaybackContinued = sampleTransport(anchor, 5_000, 0, 20);

    expect(frozenAtPause).toBe(4.5);
    expect(sampleIfPlaybackContinued).toBe(8);
    expect(sampleIfPlaybackContinued).toBeGreaterThan(frozenAtPause);
  });

  it("re-anchors a seek into a new generation without mutating the old anchor", () => {
    const oldAnchor = startTransport(2, 1_000, 1, 3);
    const nextAnchor = reanchorTransport(oldAnchor, 8, 2_000);

    expect(oldAnchor.generation).toBe(3);
    expect(sampleTransport(oldAnchor, 3_000, 0, 20)).toBe(4);
    expect(nextAnchor).toMatchObject({ outputSec: 8, monotonicMs: 2_000, rate: 1, generation: 4 });
    expect(sampleTransport(nextAnchor, 3_000, 0, 20)).toBe(9);
  });

  it("uses the fixed base-media drift threshold", () => {
    expect(shouldCorrectDrift(10.149, 10, BASE_MEDIA_DRIFT_TOLERANCE_SEC)).toBe(false);
    expect(shouldCorrectDrift(10.151, 10, BASE_MEDIA_DRIFT_TOLERANCE_SEC)).toBe(true);
  });

  it("exports the fixed overlay-media drift threshold", () => {
    expect(OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC).toBe(0.25);
  });

  it("does not schedule animation frames when anchors are created", () => {
    const requestAnimationFrame = globalThis.requestAnimationFrame;
    let calls = 0;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: () => ++calls,
    });

    try {
      startTransport(0, 0, 1, 0);
      startTransport(0, 0, 1, 1);
      expect(calls).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestAnimationFrame,
      });
    }
  });
});
