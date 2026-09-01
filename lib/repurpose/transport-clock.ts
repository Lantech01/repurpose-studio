export const BASE_MEDIA_DRIFT_TOLERANCE_SEC = 0.15;
export const OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC = 0.25;
export const EXTERNAL_SEEK_TOLERANCE_SEC = 0.25;

export interface TransportAnchor {
  outputSec: number;
  monotonicMs: number;
  rate: number;
  generation: number;
}

export function startTransport(
  outputSec: number,
  monotonicMs: number,
  rate: number,
  generation: number
): TransportAnchor {
  return { outputSec, monotonicMs, rate, generation };
}

export function sampleTransport(
  anchor: TransportAnchor,
  monotonicMs: number,
  regionStart: number,
  regionEnd: number
): number {
  const sampled = anchor.outputSec + ((monotonicMs - anchor.monotonicMs) / 1000) * anchor.rate;
  return Math.max(regionStart, Math.min(regionEnd, sampled));
}

export function reanchorTransport(
  anchor: TransportAnchor,
  outputSec: number,
  monotonicMs: number,
  rate = anchor.rate
): TransportAnchor {
  return startTransport(outputSec, monotonicMs, rate, anchor.generation + 1);
}

export function shouldCorrectDrift(
  actualSourceSec: number,
  targetSourceSec: number,
  toleranceSec: number
): boolean {
  return Math.abs(actualSourceSec - targetSourceSec) > toleranceSec;
}
