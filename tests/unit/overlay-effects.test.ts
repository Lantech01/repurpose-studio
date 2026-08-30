import { describe, expect, test } from "vitest";
import {
  normalizeOverlayAppearance,
  resolveOverlayAppearanceAt,
  solvePersistedOverlayTransformForVisual,
} from "@/lib/repurpose/overlay-effects";
import {
  overlayAABBNorm,
  resolveOverlayTransformForFrame,
  type PreviewRect,
} from "@/lib/repurpose/overlay-geometry";
import type { Overlay } from "@/lib/repurpose/types";

const frameRect: PreviewRect = { left: 0, top: 0, width: 900, height: 1600 };

function overlay(overrides: Partial<Overlay> = {}): Overlay {
  return {
    id: "overlay",
    kind: "image",
    src: "/overlay.png",
    naturalWidth: 400,
    naturalHeight: 300,
    timelineStart: 1,
    timelineEnd: 5,
    srcStart: 0,
    srcDuration: 0,
    transform: { x: 0.5, y: 0.5, scale: 0.4, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    band: "free",
    ...overrides,
  };
}

function easeInOutCubic(p: number): number {
  return p < 0.5
    ? 4 * p * p * p
    : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

describe("normalizeOverlayAppearance", () => {
  test.each([undefined, null, {}, { entranceEffect: null, exitEffect: "fade" }])(
    "gives legacy or malformed appearance %j stable defaults",
    (input) => {
      expect(normalizeOverlayAppearance(input)).toEqual({
        entranceEffect: { type: "none", durationSec: 0.35 },
        exitEffect: { type: "none", durationSec: 0.35 },
        cornerRadius: 0,
      });
    }
  );

  test.each(["none", "zoom", "pop", "fade"] as const)(
    "normalizes the %s effect and discards non-slide direction",
    (type) => {
      expect(
        normalizeOverlayAppearance({
          entranceEffect: { type, durationSec: 0.6, direction: "right" },
        }).entranceEffect
      ).toEqual({ type, durationSec: 0.6 });
    }
  );

  test.each(["left", "right", "up", "down"] as const)(
    "preserves the valid slide direction %s",
    (direction) => {
      expect(
        normalizeOverlayAppearance({
          entranceEffect: { type: "slide", durationSec: 0.4, direction },
        }).entranceEffect
      ).toEqual({ type: "slide", durationSec: 0.4, direction });
    }
  );

  test.each([undefined, "diagonal", 42])(
    "defaults malformed slide direction %j to left",
    (direction) => {
      expect(
        normalizeOverlayAppearance({
          exitEffect: { type: "slide", durationSec: 0.4, direction },
        }).exitEffect
      ).toEqual({ type: "slide", durationSec: 0.4, direction: "left" });
    }
  );

  test.each([
    { durationSec: -5, expected: 0.1 },
    { durationSec: 0.05, expected: 0.1 },
    { durationSec: 0.1, expected: 0.1 },
    { durationSec: 2, expected: 2 },
    { durationSec: 9, expected: 2 },
  ])("clamps duration $durationSec to $expected", ({ durationSec, expected }) => {
    expect(
      normalizeOverlayAppearance({
        entranceEffect: { type: "fade", durationSec },
      }).entranceEffect.durationSec
    ).toBe(expected);
  });

  test.each([undefined, null, "0.5", Number.NaN, Number.POSITIVE_INFINITY])(
    "defaults malformed duration %j",
    (durationSec) => {
      expect(
        normalizeOverlayAppearance({
          entranceEffect: { type: "fade", durationSec },
        }).entranceEffect.durationSec
      ).toBe(0.35);
    }
  );

  test("defaults an invalid effect type instead of retaining malformed fields", () => {
    expect(
      normalizeOverlayAppearance({
        entranceEffect: { type: "spin", durationSec: 1, direction: "right" },
      }).entranceEffect
    ).toEqual({ type: "none", durationSec: 0.35 });
  });

  test.each([
    { cornerRadius: -1, expected: 0 },
    { cornerRadius: 0, expected: 0 },
    { cornerRadius: 0.16, expected: 0.16 },
    { cornerRadius: 0.5, expected: 0.5 },
    { cornerRadius: 1, expected: 0.5 },
  ])(
    "clamps corner radius $cornerRadius to $expected",
    ({ cornerRadius, expected }) => {
      expect(normalizeOverlayAppearance({ cornerRadius }).cornerRadius).toBe(expected);
    }
  );

  test.each([undefined, null, "0.2", Number.NaN, Number.NEGATIVE_INFINITY])(
    "defaults malformed radius %j",
    (cornerRadius) => {
      expect(normalizeOverlayAppearance({ cornerRadius }).cornerRadius).toBe(0);
    }
  );
});

describe("resolveOverlayAppearanceAt", () => {
  test("treats none as settled for the full active interval and timelineEnd as inactive", () => {
    const input = overlay({
      entranceEffect: { type: "none", durationSec: 2 },
      exitEffect: { type: "none", durationSec: 2 },
      cornerRadius: 0.16,
    });

    for (const time of [input.timelineStart, 3, input.timelineEnd - 0.001]) {
      expect(resolveOverlayAppearanceAt(input, time, frameRect, 0.5)).toEqual({
        transform: input.transform,
        opacityMultiplier: 1,
        cornerRadius: 0.16,
        interactive: true,
      });
    }

    for (const time of [input.timelineStart - 0.001, input.timelineEnd, Number.NaN]) {
      const result = resolveOverlayAppearanceAt(input, time, frameRect, 0.5);
      expect(result.opacityMultiplier).toBe(0);
      expect(result.interactive).toBe(false);
      expect(result.transform).toEqual(input.transform);
      expect(result.cornerRadius).toBe(0.16);
    }
  });

  test.each([
    { timelineStart: 2, timelineEnd: 2 },
    { timelineStart: 3, timelineEnd: 2 },
  ])(
    "renders a $timelineStart..$timelineEnd lifetime inactive without non-finite output",
    ({ timelineStart, timelineEnd }) => {
      const result = resolveOverlayAppearanceAt(
        overlay({
          timelineStart,
          timelineEnd,
          entranceEffect: { type: "zoom", durationSec: 0.1 },
          exitEffect: { type: "pop", durationSec: 0.1 },
        }),
        timelineStart,
        frameRect,
        0.5
      );

      expect(result.opacityMultiplier).toBe(0);
      expect(result.interactive).toBe(false);
      expect(Object.values(result.transform).every(Number.isFinite)).toBe(true);
    }
  );

  test("uses exact fade easing at entrance and exit boundaries and midpoints", () => {
    const input = overlay({
      timelineStart: 2,
      timelineEnd: 6,
      entranceEffect: { type: "fade", durationSec: 1 },
      exitEffect: { type: "fade", durationSec: 1 },
    });

    expect(resolveOverlayAppearanceAt(input, 2, frameRect, 0.5).opacityMultiplier).toBe(0);
    expect(resolveOverlayAppearanceAt(input, 2.5, frameRect, 0.5).opacityMultiplier).toBe(0.5);
    expect(resolveOverlayAppearanceAt(input, 3, frameRect, 0.5).opacityMultiplier).toBe(1);
    expect(resolveOverlayAppearanceAt(input, 5, frameRect, 0.5).opacityMultiplier).toBe(1);
    expect(resolveOverlayAppearanceAt(input, 5.5, frameRect, 0.5).opacityMultiplier).toBe(0.5);
    expect(resolveOverlayAppearanceAt(input, 6, frameRect, 0.5).opacityMultiplier).toBe(0);
  });

  test("uses exact zoom scale and alpha values", () => {
    const input = overlay({
      entranceEffect: { type: "zoom", durationSec: 1 },
      exitEffect: { type: "zoom", durationSec: 1 },
    });

    const entranceStart = resolveOverlayAppearanceAt(input, 1, frameRect, 0.5);
    const entranceMid = resolveOverlayAppearanceAt(input, 1.5, frameRect, 0.5);
    const entranceEnd = resolveOverlayAppearanceAt(input, 2, frameRect, 0.5);
    const exitMid = resolveOverlayAppearanceAt(input, 4.5, frameRect, 0.5);

    expect(entranceStart.transform.scale).toBe(input.transform.scale * 0.75);
    expect(entranceStart.opacityMultiplier).toBe(0);
    expect(entranceMid.transform.scale).toBe(input.transform.scale * 0.875);
    expect(entranceMid.opacityMultiplier).toBe(0.5);
    expect(entranceEnd.transform.scale).toBe(input.transform.scale);
    expect(entranceEnd.opacityMultiplier).toBe(1);
    expect(exitMid.transform.scale).toBe(input.transform.scale * 0.875);
    expect(exitMid.opacityMultiplier).toBe(0.5);
  });

  test("follows the exact pop overshoot path and reverses it on exit", () => {
    const input = overlay({
      entranceEffect: { type: "pop", durationSec: 1 },
      exitEffect: { type: "pop", durationSec: 1 },
    });
    const expectedAtHalf =
      0.6 + (1.08 - 0.6) * (1 - Math.pow(1 - 0.5 / 0.7, 3));

    const start = resolveOverlayAppearanceAt(input, 1, frameRect, 0.5);
    const firstMid = resolveOverlayAppearanceAt(input, 1.5, frameRect, 0.5);
    const overshoot = resolveOverlayAppearanceAt(input, 1.7, frameRect, 0.5);
    const settleMid = resolveOverlayAppearanceAt(input, 1.85, frameRect, 0.5);
    const reverseSettleMid = resolveOverlayAppearanceAt(input, 4.15, frameRect, 0.5);
    const reverseFirstMid = resolveOverlayAppearanceAt(input, 4.5, frameRect, 0.5);

    expect(start.transform.scale).toBeCloseTo(input.transform.scale * 0.6, 12);
    expect(start.opacityMultiplier).toBe(0);
    expect(firstMid.transform.scale).toBeCloseTo(
      input.transform.scale * expectedAtHalf,
      12
    );
    expect(firstMid.opacityMultiplier).toBe(0.5);
    expect(overshoot.transform.scale).toBeCloseTo(input.transform.scale * 1.08, 12);
    expect(settleMid.transform.scale).toBeCloseTo(input.transform.scale * 1.04, 12);
    expect(reverseSettleMid.transform.scale).toBeCloseTo(settleMid.transform.scale, 12);
    expect(reverseFirstMid.transform.scale).toBeCloseTo(firstMid.transform.scale, 12);
  });

  test.each(["left", "right", "up", "down"] as const)(
    "slides a rotated overlay from and toward the fully clear %s side",
    (direction) => {
      const input = overlay({
        transform: { x: 0.43, y: 0.57, scale: 0.52, rotation: 37 },
        entranceEffect: { type: "slide", durationSec: 1, direction },
        exitEffect: { type: "slide", durationSec: 1, direction },
      });
      const base = resolveOverlayTransformForFrame(input, frameRect, 0.5);
      const start = resolveOverlayAppearanceAt(input, 1, frameRect, 0.5);
      const entranceMid = resolveOverlayAppearanceAt(input, 1.5, frameRect, 0.5);
      const settled = resolveOverlayAppearanceAt(input, 2, frameRect, 0.5);
      const exitMid = resolveOverlayAppearanceAt(input, 4.5, frameRect, 0.5);
      const nearExit = resolveOverlayAppearanceAt(input, 4.75, frameRect, 0.5);
      const startBox = overlayAABBNorm(
        start.transform,
        input.naturalWidth,
        input.naturalHeight,
        frameRect
      );

      if (direction === "left") expect(startBox.maxX).toBeCloseTo(0, 12);
      if (direction === "right") expect(startBox.minX).toBeCloseTo(1, 12);
      if (direction === "up") expect(startBox.maxY).toBeCloseTo(0, 12);
      if (direction === "down") expect(startBox.minY).toBeCloseTo(1, 12);
      expect(start.opacityMultiplier).toBe(0);
      expect(entranceMid.transform.x).toBeCloseTo((start.transform.x + base.x) / 2, 12);
      expect(entranceMid.transform.y).toBeCloseTo((start.transform.y + base.y) / 2, 12);
      expect(entranceMid.opacityMultiplier).toBe(0.5);
      expect(settled.transform).toEqual(base);
      expect(exitMid.transform).toEqual(entranceMid.transform);
      expect(nearExit.opacityMultiplier).toBe(easeInOutCubic(0.25));
    }
  );

  test("scales two requested windows proportionally without overlap", () => {
    const input = overlay({
      timelineStart: 0,
      timelineEnd: 1,
      entranceEffect: { type: "fade", durationSec: 2 },
      exitEffect: { type: "zoom", durationSec: 1 },
    });

    const entranceMid = resolveOverlayAppearanceAt(input, 1 / 3, frameRect, 0.5);
    const sharedBoundary = resolveOverlayAppearanceAt(input, 2 / 3, frameRect, 0.5);
    const exitMid = resolveOverlayAppearanceAt(input, 5 / 6, frameRect, 0.5);

    expect(entranceMid.opacityMultiplier).toBeCloseTo(0.5, 12);
    expect(sharedBoundary.opacityMultiplier).toBe(1);
    expect(sharedBoundary.transform).toEqual(input.transform);
    expect(exitMid.opacityMultiplier).toBeCloseTo(0.5, 12);
    expect(exitMid.transform.scale).toBeCloseTo(input.transform.scale * 0.875, 12);
  });

  test("lets one active effect consume the overlay's complete short lifetime", () => {
    const input = overlay({
      timelineStart: 2,
      timelineEnd: 2.5,
      entranceEffect: { type: "zoom", durationSec: 2 },
      exitEffect: { type: "none", durationSec: 2 },
    });

    const midpoint = resolveOverlayAppearanceAt(input, 2.25, frameRect, 0.5);
    expect(midpoint.opacityMultiplier).toBe(0.5);
    expect(midpoint.transform.scale).toBe(input.transform.scale * 0.875);
  });

  test.each([
    { band: "screen" as const, splitRatio: 0.4 },
    { band: "face" as const, splitRatio: 0.4 },
    { band: "free" as const, splitRatio: 0 },
  ])("resolves the persisted $band transform against the frame split first", ({ band, splitRatio }) => {
    const input = overlay({
      band,
      transform: { x: 0.5, y: 0.5, scale: 0.8, rotation: 31 },
      cornerRadius: 0.9,
    });
    const expectedBase = resolveOverlayTransformForFrame(input, frameRect, splitRatio);

    const result = resolveOverlayAppearanceAt(input, 3, frameRect, splitRatio);
    expect(result.transform).toEqual(expectedBase);
    expect(result.cornerRadius).toBe(0.5);
    expect(result.interactive).toBe(true);
  });

  test.each([
    { band: "screen" as const, splitRatio: 0 },
    { band: "face" as const, splitRatio: 1 },
  ])("keeps a hidden $band overlay non-interactive", ({ band, splitRatio }) => {
    const result = resolveOverlayAppearanceAt(
      overlay({ band }),
      3,
      frameRect,
      splitRatio
    );
    expect(result.opacityMultiplier).toBe(1);
    expect(result.interactive).toBe(false);
  });

  test("uses the inclusive opacity-multiplier interaction threshold", () => {
    const thresholdProgress = Math.cbrt(0.01 / 4);
    const input = overlay({ entranceEffect: { type: "fade", durationSec: 1 } });

    expect(
      resolveOverlayAppearanceAt(
        input,
        input.timelineStart + thresholdProgress,
        frameRect,
        0.5
      ).interactive
    ).toBe(false);
    expect(
      resolveOverlayAppearanceAt(
        input,
        input.timelineStart + thresholdProgress + 0.001,
        frameRect,
        0.5
      ).interactive
    ).toBe(true);
  });

  test("is deterministic and never mutates persisted input", () => {
    const input = overlay({
      band: "screen",
      transform: { x: 0.41, y: 0.63, scale: 0.7, rotation: -28 },
      entranceEffect: { type: "slide", durationSec: 1.2, direction: "up" },
      exitEffect: { type: "pop", durationSec: 0.8 },
      cornerRadius: 0.2,
    });
    const before = structuredClone(input);
    Object.freeze(input.transform);
    Object.freeze(input.entranceEffect);
    Object.freeze(input.exitEffect);
    Object.freeze(input);

    const first = resolveOverlayAppearanceAt(input, 1.4, frameRect, 0.35);
    const second = resolveOverlayAppearanceAt(input, 1.4, frameRect, 0.35);

    expect(second).toEqual(first);
    expect(input).toEqual(before);
    expect(first.transform).not.toBe(input.transform);
  });
});

describe("solvePersistedOverlayTransformForVisual", () => {
  test.each(
    (["left", "right", "up", "down"] as const).flatMap((direction) =>
      [0.25, 0.5, 0.8].map((progress) => ({ direction, progress }))
    )
  )(
    "round-trips a $direction Slide visual at progress $progress after move, scale, and rotation",
    ({ direction, progress }) => {
      const input = overlay({
        band: "free",
        transform: { x: 0.47, y: 0.54, scale: 0.42, rotation: 23 },
        entranceEffect: { type: "slide", durationSec: 1, direction },
      });
      const before = structuredClone(input);
      const time = input.timelineStart + progress;
      const start = resolveOverlayAppearanceAt(input, time, frameRect, 0.5).transform;
      const desired = {
        x: start.x + 0.071,
        y: start.y - 0.043,
        scale: start.scale * 1.17,
        rotation: start.rotation + 19,
      };

      const persisted = solvePersistedOverlayTransformForVisual(
        input,
        desired,
        time,
        frameRect,
        0.5
      );
      const roundTrip = resolveOverlayAppearanceAt(
        { ...input, transform: persisted },
        time,
        frameRect,
        0.5
      ).transform;

      expect(roundTrip.x).toBeCloseTo(desired.x, 10);
      expect(roundTrip.y).toBeCloseTo(desired.y, 10);
      expect(roundTrip.scale).toBeCloseTo(desired.scale, 10);
      expect(roundTrip.rotation).toBeCloseTo(desired.rotation, 10);
      expect(input).toEqual(before);
    }
  );

  test.each([
    { band: "screen" as const, split: 0.35 },
    { band: "face" as const, split: 0.65 },
  ])(
    "round-trips a seam-bound $band Slide while retaining latent authored seam offset",
    ({ band, split }) => {
      const input = overlay({
        band,
        transform: { x: 0.52, y: 0.5, scale: 0.66, rotation: 31 },
        entranceEffect: { type: "slide", durationSec: 1, direction: "right" },
      });
      const time = input.timelineStart + 0.55;
      const start = resolveOverlayAppearanceAt(input, time, frameRect, split).transform;
      const desired = {
        ...start,
        x: start.x + 0.08,
        scale: start.scale * 1.1,
        rotation: start.rotation - 14,
      };
      desired.y = resolveOverlayTransformForFrame(
        {
          ...input,
          transform: {
            ...input.transform,
            scale: desired.scale,
            rotation: desired.rotation,
          },
        },
        frameRect,
        split
      ).y;
      const initialBase = resolveOverlayTransformForFrame(input, frameRect, split);

      const persisted = solvePersistedOverlayTransformForVisual(
        input,
        desired,
        time,
        frameRect,
        split
      );
      const roundTrip = resolveOverlayAppearanceAt(
        { ...input, transform: persisted },
        time,
        frameRect,
        split
      ).transform;

      expect(roundTrip).toEqual(
        expect.objectContaining({ rotation: desired.rotation })
      );
      expect(roundTrip.x).toBeCloseTo(desired.x, 10);
      expect(roundTrip.y).toBeCloseTo(desired.y, 10);
      expect(roundTrip.scale).toBeCloseTo(desired.scale, 10);
      expect(Math.sign(persisted.y - roundTrip.y)).toBe(
        Math.sign(input.transform.y - initialBase.y)
      );
    }
  );

  test("returns finite authored values when Slide progress cannot be inverted", () => {
    const input = overlay({
      entranceEffect: { type: "slide", durationSec: 1, direction: "left" },
    });
    const result = solvePersistedOverlayTransformForVisual(
      input,
      { x: Number.NaN, y: 0.4, scale: 0, rotation: Number.POSITIVE_INFINITY },
      input.timelineStart,
      frameRect,
      0.5
    );
    expect(Object.values(result).every(Number.isFinite)).toBe(true);
  });
});
