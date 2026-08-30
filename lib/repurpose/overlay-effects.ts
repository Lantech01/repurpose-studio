import {
  isOverlayBandVisible,
  overlayAABBNorm,
  resolveOverlayTransformForFrame,
  type PreviewRect,
} from "./overlay-geometry";
import type {
  Overlay,
  OverlayEffect,
  OverlayEffectType,
  OverlaySlideDirection,
  OverlayTransform,
} from "./types";

const DEFAULT_EFFECT: OverlayEffect = { type: "none", durationSec: 0.35 };
const EFFECT_TYPES: readonly OverlayEffectType[] = [
  "none",
  "zoom",
  "slide",
  "pop",
  "fade",
];
const SLIDE_DIRECTIONS: readonly OverlaySlideDirection[] = [
  "left",
  "right",
  "up",
  "down",
];

export interface NormalizedOverlayAppearance {
  entranceEffect: OverlayEffect;
  exitEffect: OverlayEffect;
  cornerRadius: number;
}

export interface ResolvedOverlayAppearance {
  transform: OverlayTransform;
  opacityMultiplier: number;
  cornerRadius: number;
  interactive: boolean;
}

/** The exact overlay sample used by the latest preview compositor frame. */
export interface OverlayFrameSnapshot {
  outputTime: number;
  splitRatio: number;
  appearances: ReadonlyMap<string, ResolvedOverlayAppearance>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeEffect(value: unknown): OverlayEffect {
  if (!isRecord(value) || !EFFECT_TYPES.includes(value.type as OverlayEffectType)) {
    return { ...DEFAULT_EFFECT };
  }

  const type = value.type as OverlayEffectType;
  const durationSec =
    typeof value.durationSec === "number" && Number.isFinite(value.durationSec)
      ? clamp(value.durationSec, 0.1, 2)
      : DEFAULT_EFFECT.durationSec;

  if (type !== "slide") return { type, durationSec };
  const direction = SLIDE_DIRECTIONS.includes(
    value.direction as OverlaySlideDirection
  )
    ? (value.direction as OverlaySlideDirection)
    : "left";
  return { type, durationSec, direction };
}

export function normalizeOverlayAppearance(
  value: unknown
): NormalizedOverlayAppearance {
  const source = isRecord(value) ? value : {};
  const cornerRadius =
    typeof source.cornerRadius === "number" && Number.isFinite(source.cornerRadius)
      ? clamp(source.cornerRadius, 0, 0.5)
      : 0;

  return {
    entranceEffect: normalizeEffect(source.entranceEffect),
    exitEffect: normalizeEffect(source.exitEffect),
    cornerRadius,
  };
}

function easeInOutCubic(p: number): number {
  return p < 0.5
    ? 4 * p * p * p
    : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

function popScaleAt(p: number): number {
  if (p <= 0.7) {
    return 0.6 + (1.08 - 0.6) * easeOutCubic(p / 0.7);
  }
  return 1.08 + (1 - 1.08) * easeInOutCubic((p - 0.7) / 0.3);
}

function slideOrigin(
  overlay: Overlay,
  base: OverlayTransform,
  frameRect: PreviewRect,
  direction: OverlaySlideDirection
): OverlayTransform {
  const box = overlayAABBNorm(
    base,
    overlay.naturalWidth,
    overlay.naturalHeight,
    frameRect
  );
  switch (direction) {
    case "left":
      return { ...base, x: base.x - box.maxX };
    case "right":
      return { ...base, x: base.x + (1 - box.minX) };
    case "up":
      return { ...base, y: base.y - box.maxY };
    case "down":
      return { ...base, y: base.y + (1 - box.minY) };
  }
}

function applyEffect(
  overlay: Overlay,
  base: OverlayTransform,
  frameRect: PreviewRect,
  effect: OverlayEffect,
  p: number
): { transform: OverlayTransform; opacityMultiplier: number } {
  const eased = easeInOutCubic(p);
  switch (effect.type) {
    case "none":
      return { transform: base, opacityMultiplier: 1 };
    case "fade":
      return { transform: base, opacityMultiplier: eased };
    case "zoom":
      return {
        transform: { ...base, scale: base.scale * (0.75 + 0.25 * eased) },
        opacityMultiplier: eased,
      };
    case "pop":
      return {
        transform: { ...base, scale: base.scale * popScaleAt(p) },
        opacityMultiplier: eased,
      };
    case "slide": {
      const origin = slideOrigin(overlay, base, frameRect, effect.direction ?? "left");
      return {
        transform: {
          ...base,
          x: origin.x + (base.x - origin.x) * eased,
          y: origin.y + (base.y - origin.y) * eased,
        },
        opacityMultiplier: eased,
      };
    }
  }
}

interface EffectSample {
  active: boolean;
  effect: OverlayEffect | null;
  p: number;
}

function sampleEffectAt(
  overlay: Overlay,
  outputTime: number,
  normalized: NormalizedOverlayAppearance
): EffectSample {
  const life = overlay.timelineEnd - overlay.timelineStart;
  const active =
    Number.isFinite(life) &&
    life > 0 &&
    Number.isFinite(outputTime) &&
    outputTime >= overlay.timelineStart &&
    outputTime < overlay.timelineEnd;
  if (!active) return { active: false, effect: null, p: 1 };

  let entranceDuration =
    normalized.entranceEffect.type === "none"
      ? 0
      : normalized.entranceEffect.durationSec;
  let exitDuration =
    normalized.exitEffect.type === "none" ? 0 : normalized.exitEffect.durationSec;
  const requestedTotal = entranceDuration + exitDuration;
  if (requestedTotal > life) {
    const durationScale = life / requestedTotal;
    entranceDuration *= durationScale;
    exitDuration *= durationScale;
  }

  if (
    entranceDuration > 0 &&
    outputTime < overlay.timelineStart + entranceDuration
  ) {
    return {
      active: true,
      effect: normalized.entranceEffect,
      p: clamp((outputTime - overlay.timelineStart) / entranceDuration, 0, 1),
    };
  }
  if (exitDuration > 0 && outputTime >= overlay.timelineEnd - exitDuration) {
    return {
      active: true,
      effect: normalized.exitEffect,
      p: clamp((overlay.timelineEnd - outputTime) / exitDuration, 0, 1),
    };
  }
  return { active: true, effect: null, p: 1 };
}

export function resolveOverlayAppearanceAt(
  overlay: Overlay,
  outputTime: number,
  frameRect: PreviewRect,
  splitRatio: number
): ResolvedOverlayAppearance {
  const normalized = normalizeOverlayAppearance(overlay);
  const base = resolveOverlayTransformForFrame(overlay, frameRect, splitRatio);
  const sample = sampleEffectAt(overlay, outputTime, normalized);

  if (!sample.active) {
    return {
      transform: base,
      opacityMultiplier: 0,
      cornerRadius: normalized.cornerRadius,
      interactive: false,
    };
  }

  const resolved = sample.effect
    ? applyEffect(overlay, base, frameRect, sample.effect, sample.p)
    : { transform: base, opacityMultiplier: 1 };
  return {
    ...resolved,
    cornerRadius: normalized.cornerRadius,
    interactive:
      isOverlayBandVisible(overlay.band, splitRatio) &&
      resolved.opacityMultiplier > 0.01,
  };
}

/**
 * Invert the frame-time appearance transform back into an authored transform.
 * Slide is solved analytically because its off-frame origin depends on the
 * rotation-aware AABB; scale effects are divided out before the Slide solve.
 */
export function solvePersistedOverlayTransformForVisual(
  overlay: Overlay,
  desiredVisual: OverlayTransform,
  outputTime: number,
  frameRect: PreviewRect,
  splitRatio: number
): OverlayTransform {
  const normalized = normalizeOverlayAppearance(overlay);
  const sample = sampleEffectAt(overlay, outputTime, normalized);
  const current = resolveOverlayAppearanceAt(
    overlay,
    outputTime,
    frameRect,
    splitRatio
  ).transform;
  const finiteOr = (value: number, fallback: number): number =>
    Number.isFinite(value) ? value : fallback;
  const desired = {
    x: finiteOr(desiredVisual.x, current.x),
    y: finiteOr(desiredVisual.y, current.y),
    scale:
      Number.isFinite(desiredVisual.scale) && desiredVisual.scale > 0
        ? desiredVisual.scale
        : current.scale,
    rotation: finiteOr(desiredVisual.rotation, current.rotation),
  };

  let scaleMultiplier = 1;
  if (sample.effect?.type === "zoom") {
    scaleMultiplier = 0.75 + 0.25 * easeInOutCubic(sample.p);
  } else if (sample.effect?.type === "pop") {
    scaleMultiplier = popScaleAt(sample.p);
  }
  const base: OverlayTransform = {
    ...desired,
    scale:
      Number.isFinite(scaleMultiplier) && scaleMultiplier > 1e-9
        ? desired.scale / scaleMultiplier
        : overlay.transform.scale,
  };

  if (sample.effect?.type === "slide") {
    const eased = easeInOutCubic(sample.p);
    if (eased > 1e-9) {
      const probe = overlayAABBNorm(
        { ...base, x: 0.5, y: 0.5 },
        overlay.naturalWidth,
        overlay.naturalHeight,
        frameRect
      );
      const halfWidth = (probe.maxX - probe.minX) / 2;
      const halfHeight = (probe.maxY - probe.minY) / 2;
      const outsideWeight = 1 - eased;
      switch (sample.effect.direction ?? "left") {
        case "left":
          base.x = (desired.x + outsideWeight * halfWidth) / eased;
          break;
        case "right":
          base.x =
            (desired.x - outsideWeight * (1 + halfWidth)) / eased;
          break;
        case "up":
          base.y = (desired.y + outsideWeight * halfHeight) / eased;
          break;
        case "down":
          base.y =
            (desired.y - outsideWeight * (1 + halfHeight)) / eased;
          break;
      }
    } else {
      const originalBase = resolveOverlayTransformForFrame(
        overlay,
        frameRect,
        splitRatio
      );
      if (
        sample.effect.direction === "left" ||
        sample.effect.direction === "right"
      ) {
        base.x = originalBase.x;
      } else {
        base.y = originalBase.y;
      }
    }
  }

  const originalBase = resolveOverlayTransformForFrame(
    overlay,
    frameRect,
    splitRatio
  );
  const seamOffset = overlay.transform.y - originalBase.y;
  const persisted: OverlayTransform = {
    ...base,
    y: Math.abs(seamOffset) > 1e-12 ? base.y + seamOffset : base.y,
  };
  return {
    x: finiteOr(persisted.x, overlay.transform.x),
    y: finiteOr(persisted.y, overlay.transform.y),
    scale:
      Number.isFinite(persisted.scale) && persisted.scale > 0
        ? persisted.scale
        : overlay.transform.scale,
    rotation: finiteOr(persisted.rotation, overlay.transform.rotation),
  };
}
