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

function deterministicSignal(length: number, seed = 17, frequency = 37): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, (_, index) => {
    state = (state * 48271) % 0x7fffffff;
    return (state / 0x7fffffff - 0.5) * 0.4
      + 0.6 * Math.sin((2 * Math.PI * frequency * index) / 1_000);
  });
}

function padded(signal: Float32Array, before: number, after = 0): Float32Array {
  const result = new Float32Array(before + signal.length + after);
  result.set(signal, before);
  return result;
}

describe("PCM difference alignment", () => {
  const options = {
    sampleRate: 1_000,
    maxLagSec: 0.05,
    minOverlapSec: 0.5,
    minCorrelation: 0.8,
  };
  const align = () => (
    audioAnalysis as typeof audioAnalysis & {
      alignPcmForDifference?: (
        reference: Float32Array,
        candidate: Float32Array,
        configuration: typeof options
      ) => {
        lagSamples: number;
        correlation: number;
        reference: Float32Array;
        candidate: Float32Array;
      };
    }
  ).alignPcmForDifference;

  it("leaves unchanged aligned signals at zero lag", () => {
    const signal = deterministicSignal(1_200);
    expect(align()).toBeTypeOf("function");
    const result = align()!(signal, signal.slice(), options);
    expect(result.lagSamples).toBe(0);
    expect(result.correlation).toBeCloseTo(1, 6);
    expect(result.reference).toEqual(signal);
    expect(result.candidate).toEqual(signal);
  });

  it("aligns a candidate with a positive leading delay", () => {
    const signal = deterministicSignal(1_200);
    const result = align()!(signal, padded(signal, 19), options);
    expect(result.lagSamples).toBe(19);
    expect(result.reference).toEqual(signal);
    expect(result.candidate).toEqual(signal);
  });

  it("aligns a candidate that starts before the reference", () => {
    const signal = deterministicSignal(1_200);
    const result = align()!(padded(signal, 23), signal, options);
    expect(result.lagSamples).toBe(-23);
    expect(result.reference).toEqual(signal);
    expect(result.candidate).toEqual(signal);
  });

  it("handles encoder-like delay, gain drift, and unequal lengths", () => {
    const signal = deterministicSignal(1_500);
    const encoded = Float32Array.from(signal, (sample, index) =>
      sample * 0.97 + 0.001 * Math.sin(index)
    );
    const result = align()!(signal, padded(encoded, 31, 17), options);
    expect(result.lagSamples).toBe(31);
    expect(result.reference).toHaveLength(signal.length);
    expect(result.candidate).toHaveLength(signal.length);
    expect(result.correlation).toBeGreaterThan(0.99);
  });

  it("prefers zero lag when a periodic baseline has equally correlated cycle shifts", () => {
    const reference = Float32Array.from({ length: 2_000 }, (_, index) =>
      0.4 * Math.sin((2 * Math.PI * 20 * index) / 1_000)
      + 0.3 * Math.sin((2 * Math.PI * 40 * index) / 1_000)
    );
    const candidate = reference.slice();
    for (let index = 0; index < 50; index += 1) candidate[index] += 0.2;
    const result = align()!(reference, candidate, options);
    expect(result.lagSamples).toBe(0);
  });

  it("rejects signals without sufficient correlation", () => {
    expect(() => align()!(
      deterministicSignal(1_200, 11),
      deterministicSignal(1_200, 29, 113),
      options
    )).toThrow(/correlation/i);
  });

  it("rejects aligned overlap shorter than the configured duration", () => {
    const signal = deterministicSignal(300);
    expect(() => align()!(signal, signal, options)).toThrow(/overlap/i);
  });
});
