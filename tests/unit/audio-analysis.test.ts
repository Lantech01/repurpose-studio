// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as audioAnalysis from "@/tests/e2e/helpers/audio-analysis";

interface TimedWindowMeasurement {
  eventRms: number;
  beforeRms: number;
  afterRms: number;
  localContrast: number;
}

describe("timed SFX audio evidence", () => {
  it("distinguishes a smeared event from a continuous music bed", () => {
    const measure = (
      audioAnalysis as typeof audioAnalysis & {
        measureTimedSfxWindow?: (
          samples: Float32Array,
          centerSec: number,
          sampleRate: number
        ) => TimedWindowMeasurement;
      }
    ).measureTimedSfxWindow;
    expect(measure).toBeTypeOf("function");
    if (!measure) return;

    const sampleRate = 1_000;
    const continuous = Float32Array.from({ length: 3_000 }, (_, i) =>
      0.2 * Math.sin((2 * Math.PI * 40 * i) / sampleRate)
    );
    const withSmearedEvent = continuous.slice();
    for (let i = 1_420; i < 1_580; i++) {
      const envelope = 1 - Math.abs(i - 1_500) / 80;
      withSmearedEvent[i] += 0.35 * Math.max(0, envelope);
    }

    const bed = measure(continuous, 1.5, sampleRate);
    const event = measure(withSmearedEvent, 1.5, sampleRate);

    expect(bed.localContrast).toBeCloseTo(1, 1);
    expect(event.localContrast).toBeGreaterThan(1.2);
    expect(event.eventRms).toBeGreaterThan(event.beforeRms);
    expect(event.eventRms).toBeGreaterThan(event.afterRms);
  });
});
