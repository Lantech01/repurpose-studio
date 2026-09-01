import { describe, expect, test } from "vitest";

import {
  activeCaptionBlockAt,
  CAPTION_TEMPLATES,
  drawCaptions,
  resolveCaptionLayout,
  type CaptionBlock,
  type CaptionStyle,
  type DrawCaptionsOptions,
} from "@/lib/repurpose/captions";
import { useRepurposeStore } from "@/lib/repurpose/store";

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  operation?: string;
}

interface Matrix {
  a: number;
  d: number;
  e: number;
  f: number;
}

class RecordingContext {
  font = "16px sans-serif";
  fillStyle: string | CanvasGradient = "#000";
  strokeStyle: string | CanvasGradient = "#000";
  globalAlpha = 1;
  lineWidth = 1;
  lineJoin: CanvasLineJoin = "miter";
  lineCap: CanvasLineCap = "butt";
  miterLimit = 10;
  textBaseline: CanvasTextBaseline = "alphabetic";
  textAlign: CanvasTextAlign = "start";
  readonly draws: Bounds[] = [];

  private matrix: Matrix = { a: 1, d: 1, e: 0, f: 0 };
  private stack: Array<{
    matrix: Matrix;
    globalAlpha: number;
    lineWidth: number;
    font: string;
    lineCap: CanvasLineCap;
  }> = [];
  private pathPoints: Array<{ x: number; y: number }> = [];
  private pathRect: Bounds | null = null;
  private restoreCount = 0;

  constructor(private readonly onFirstRestore?: () => void) {}

  private fontSize(): number {
    return Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 16);
  }

  private transformed(bounds: Bounds): Bounds {
    const xs = [
      bounds.left * this.matrix.a + this.matrix.e,
      bounds.right * this.matrix.a + this.matrix.e,
    ];
    const ys = [
      bounds.top * this.matrix.d + this.matrix.f,
      bounds.bottom * this.matrix.d + this.matrix.f,
    ];
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    };
  }

  private record(bounds: Bounds, operation: string): void {
    if (this.globalAlpha > 0) {
      this.draws.push({ ...this.transformed(bounds), operation });
    }
  }

  save(): void {
    this.stack.push({
      matrix: { ...this.matrix },
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      font: this.font,
      lineCap: this.lineCap,
    });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    this.matrix = state.matrix;
    this.globalAlpha = state.globalAlpha;
    this.lineWidth = state.lineWidth;
    this.font = state.font;
    this.lineCap = state.lineCap;
    if (this.restoreCount++ === 0) this.onFirstRestore?.();
  }

  translate(x: number, y: number): void {
    this.matrix.e += this.matrix.a * x;
    this.matrix.f += this.matrix.d * y;
  }

  scale(x: number, y: number): void {
    this.matrix.a *= x;
    this.matrix.d *= y;
  }

  measureText(text: string): TextMetrics {
    const size = this.fontSize();
    return {
      width: [...text].length * size * 0.55,
      actualBoundingBoxAscent: size * 0.75,
      actualBoundingBoxDescent: size * 0.2,
    } as TextMetrics;
  }

  fillText(text: string, x: number, y: number): void {
    const metrics = this.measureText(text);
    this.record({
      left: x,
      top: y - metrics.actualBoundingBoxAscent,
      right: x + metrics.width,
      bottom: y + metrics.actualBoundingBoxDescent,
    }, "fillText");
  }

  strokeText(text: string, x: number, y: number): void {
    const metrics = this.measureText(text);
    const outset = this.lineWidth / 2;
    this.record({
      left: x - outset,
      top: y - metrics.actualBoundingBoxAscent - outset,
      right: x + metrics.width + outset,
      bottom: y + metrics.actualBoundingBoxDescent + outset,
    }, "strokeText");
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.record(
      { left: x, top: y, right: x + width, bottom: y + height },
      "fillRect"
    );
  }

  beginPath(): void {
    this.pathPoints = [];
    this.pathRect = null;
  }

  roundRect(x: number, y: number, width: number, height: number): void {
    this.pathRect = { left: x, top: y, right: x + width, bottom: y + height };
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.pathRect = { left: x, top: y, right: x + width, bottom: y + height };
  }

  moveTo(x: number, y: number): void {
    this.pathPoints.push({ x, y });
  }

  lineTo(x: number, y: number): void {
    this.pathPoints.push({ x, y });
  }

  fill(): void {
    if (this.pathRect) this.record(this.pathRect, "fillPath");
  }

  stroke(): void {
    if (this.pathPoints.length === 0) return;
    const outset = this.lineWidth / 2;
    const xs = this.pathPoints.map((point) => point.x);
    const ys = this.pathPoints.map((point) => point.y);
    this.record({
      left: Math.min(...xs) - outset,
      top: Math.min(...ys) - outset,
      right: Math.max(...xs) + outset,
      bottom: Math.max(...ys) + outset,
    }, "strokePath");
  }

  clip(): void {}
  arcTo(): void {}
  closePath(): void {}

  createLinearGradient(): CanvasGradient {
    return { addColorStop() {} } as unknown as CanvasGradient;
  }
}

const block: CaptionBlock = {
  id: "endpoint-caption",
  words: [
    { text: "BOUND", start: 0, end: 0.35 },
    { text: "CHECK", start: 0.5, end: 1 },
  ],
  start: 0,
  end: 1,
  keywordIndex: 0,
};

const nearWidthBlock: CaptionBlock = {
  id: "near-width-caption",
  words: [{ text: "FRAMEBOUNDARYOVERFLOWCHECK", start: 0, end: 1 }],
  start: 0,
  end: 1,
  keywordIndex: 0,
};

const paths: Array<{ name: string; style: CaptionStyle }> = [
  ...Object.entries(CAPTION_TEMPLATES).map(([name, style]) => ({ name, style })),
  {
    name: "active-word-pop",
    style: { ...CAPTION_TEMPLATES["bold-outline"], activePop: 0.4 },
  },
];

function options(
  style: CaptionStyle,
  splitRatio: number,
  overrides: Partial<DrawCaptionsOptions> = {}
): DrawCaptionsOptions {
  return {
    style,
    blocks: [block],
    srcT: 0.62,
    width: 360,
    height: 640,
    splitRatio,
    ...overrides,
  };
}

function expectBoundsInFrame(bounds: Bounds): void {
  expect(bounds.left).toBeGreaterThanOrEqual(-1e-6);
  expect(bounds.top).toBeGreaterThanOrEqual(-1e-6);
  expect(bounds.right).toBeLessThanOrEqual(360 + 1e-6);
  expect(bounds.bottom).toBeLessThanOrEqual(640 + 1e-6);
}

const ANTIALIAS_EPSILON_PX = 0.01;

function expectDrawInsideLayout(
  draw: Bounds,
  layoutBounds: Bounds,
  evidence: string
): void {
  expect(draw.left, evidence).toBeGreaterThanOrEqual(
    layoutBounds.left - ANTIALIAS_EPSILON_PX
  );
  expect(draw.top, evidence).toBeGreaterThanOrEqual(
    layoutBounds.top - ANTIALIAS_EPSILON_PX
  );
  expect(draw.right, evidence).toBeLessThanOrEqual(
    layoutBounds.right + ANTIALIAS_EPSILON_PX
  );
  expect(draw.bottom, evidence).toBeLessThanOrEqual(
    layoutBounds.bottom + ANTIALIAS_EPSILON_PX
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
}

describe("shared caption layout", () => {
  test.each(paths)(
    "exposes complete, in-frame $name geometry at every split position",
    ({ style }) => {
      for (const splitRatio of [0, 0.43, 1]) {
        const context = new RecordingContext();
        const drawOptions = options({ ...style, pinToSplit: true }, splitRatio);
        const layout = resolveCaptionLayout(
          context as unknown as CanvasRenderingContext2D,
          drawOptions
        );

        expect(layout).not.toBeNull();
        expect(layout?.activeBlock).toEqual(block);
        expect(layout?.activeBlock).not.toBe(block);
        expect(layout?.activeBlockId).toBe(block.id);
        expect(layout?.style).toEqual(drawOptions.style);
        expect(layout?.requestedAnchorY).toBeCloseTo(
          (splitRatio + style.splitOffsetPct) * 640
        );
        expect(layout?.anchorY).toBe(
          clamp(
            layout?.requestedAnchorY ?? 0,
            layout?.anchorRange.min ?? 0,
            layout?.anchorRange.max ?? 0
          )
        );
        expect(layout?.blockScale).toBeGreaterThan(0);
        expect(layout?.blockAlpha).toBeGreaterThan(0);
        expect(layout?.rawVisualBounds.bottom).toBeGreaterThan(
          layout?.rawVisualBounds.top ?? 0
        );
        const translatedY = (layout?.anchorY ?? 0) - (layout?.requestedAnchorY ?? 0);
        expect(
          (layout?.visualBounds.top ?? 0) - (layout?.rawVisualBounds.top ?? 0)
        ).toBeCloseTo(translatedY);
        expect(
          (layout?.visualBounds.bottom ?? 0) - (layout?.rawVisualBounds.bottom ?? 0)
        ).toBeCloseTo(translatedY);
        expect(
          (layout?.visualBounds.left ?? 0) - (layout?.rawVisualBounds.left ?? 0)
        ).toBeCloseTo(
          (layout?.visualBounds.right ?? 0) - (layout?.rawVisualBounds.right ?? 0)
        );
        expectBoundsInFrame(layout!.visualBounds);
        expect(layout?.attachedTargetAnchorY).toBe(layout?.anchorY);
        expect(context.draws).toEqual([]);

        const drawn = drawCaptions(
          context as unknown as CanvasRenderingContext2D,
          drawOptions
        );
        expect(drawn).toEqual(layout);
        expect(context.draws.length).toBeGreaterThan(0);
        for (const bounds of context.draws) {
          expectBoundsInFrame(bounds);
          expectDrawInsideLayout(
            bounds,
            drawn!.visualBounds,
            `${style.template} split=${splitRatio} operation=${bounds.operation}`
          );
        }
      }
    }
  );

  test("uses activeCaptionBlockAt as the active block contract", () => {
    const prior = { ...block, id: "prior", start: -1, end: 0.6 };
    const current = { ...block, id: "current", start: 0.6, end: 1.2 };
    const blocks = [prior, current];
    const srcT = 0.61;
    const context = new RecordingContext();

    const layout = resolveCaptionLayout(
      context as unknown as CanvasRenderingContext2D,
      options(CAPTION_TEMPLATES["bold-outline"], 0.5, { blocks, srcT })
    );

    expect(activeCaptionBlockAt(blocks, srcT)).toBe(current);
    expect(layout?.activeBlock).toEqual(current);
    expect(layout?.activeBlock).not.toBe(current);
  });

  test("keeps detached placement independent from split movement", () => {
    const style = {
      ...CAPTION_TEMPLATES["clean-minimal"],
      pinToSplit: false,
      positionYPct: 0.37,
    };

    const anchors = [0, 0.45, 1].map((splitRatio) => {
      const context = new RecordingContext();
      return resolveCaptionLayout(
        context as unknown as CanvasRenderingContext2D,
        options(style, splitRatio)
      )?.anchorY;
    });

    expect(new Set(anchors).size).toBe(1);
  });

  test("applies a matching transient as an absolute anchor without mutation", () => {
    const style = { ...CAPTION_TEMPLATES["clawd-hop"], pinToSplit: true };
    const blocks = [
      {
        ...block,
        overrideStyle: { fill: "#123456", pinToSplit: false, positionYPct: 0.22 },
      },
    ];
    const originalStyle = structuredClone(style);
    const originalBlocks = structuredClone(blocks);
    const context = new RecordingContext();
    const baseOptions = options(style, 0.78, { blocks });

    const transient = resolveCaptionLayout(
      context as unknown as CanvasRenderingContext2D,
      { ...baseOptions, transientPosition: { blockId: block.id, positionYPct: 0.61 } }
    );
    const transientAtOtherSplit = resolveCaptionLayout(
      context as unknown as CanvasRenderingContext2D,
      {
        ...baseOptions,
        splitRatio: 0.12,
        transientPosition: { blockId: block.id, positionYPct: 0.61 },
      }
    );
    const nonMatching = resolveCaptionLayout(
      context as unknown as CanvasRenderingContext2D,
      { ...baseOptions, transientPosition: { blockId: "another-block", positionYPct: 0.61 } }
    );
    const persisted = resolveCaptionLayout(
      context as unknown as CanvasRenderingContext2D,
      baseOptions
    );

    expect(transient?.requestedAnchorY).toBeCloseTo(0.61 * 640);
    expect(transientAtOtherSplit?.anchorY).toBe(transient?.anchorY);
    expect(nonMatching).toEqual(persisted);
    expect(style).toEqual(originalStyle);
    expect(blocks).toEqual(originalBlocks);
  });

  test.each([0, 0.42, 1])(
    "resolves the split %s attached candidate from inherited global offset",
    (splitRatio) => {
      const globalStyle = {
        ...CAPTION_TEMPLATES["highlight-box"],
        pinToSplit: false,
        splitOffsetPct: 0.08,
      };
      const detachedBlock: CaptionBlock = {
        ...block,
        overrideStyle: {
          fill: "#ABCDEF",
          pinToSplit: false,
          positionYPct: 0.31,
          splitOffsetPct: -0.24,
        },
      };
      const before = structuredClone(detachedBlock);
      const context = new RecordingContext();

      const layout = resolveCaptionLayout(
        context as unknown as CanvasRenderingContext2D,
        options(globalStyle, splitRatio, { blocks: [detachedBlock] })
      );

      expect(layout?.style.fill).toBe("#ABCDEF");
      expect(layout?.requestedAnchorY).toBeCloseTo(0.31 * 640);
      expect(layout?.attachedTargetAnchorY).toBe(
        clamp(
          (splitRatio + globalStyle.splitOffsetPct) * 640,
          layout!.anchorRange.min,
          layout!.anchorRange.max
        )
      );
      expect(detachedBlock).toEqual(before);
    }
  );

  test.each(paths)(
    "preserves the clamped $name geometry when endpoint attachment becomes detached",
    ({ style }) => {
      for (const splitRatio of [0, 1]) {
        const inheritedOffset = splitRatio === 0 ? -0.2 : 0.2;
        const rawRequestedPosition = splitRatio + inheritedOffset;
        const globalStyle = {
          ...style,
          pinToSplit: false,
          splitOffsetPct: inheritedOffset,
        };
        const attachedBlock: CaptionBlock = {
          ...block,
          overrideStyle: { fill: "#ABCDEF", pinToSplit: true },
        };
        useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
        useRepurposeStore.setState({
          captionStyle: globalStyle,
          captionBlocks: [attachedBlock],
        });
        const attached = resolveCaptionLayout(
          new RecordingContext() as unknown as CanvasRenderingContext2D,
          options(globalStyle, splitRatio, { blocks: [attachedBlock] })
        );

        useRepurposeStore
          .getState()
          .detachCaptionBlock(attachedBlock.id, rawRequestedPosition);
        const detachedBlock = useRepurposeStore.getState().captionBlocks[0];
        const detached = resolveCaptionLayout(
          new RecordingContext() as unknown as CanvasRenderingContext2D,
          options(globalStyle, splitRatio, { blocks: [detachedBlock] })
        );

        expect(rawRequestedPosition).toBe(splitRatio === 0 ? -0.2 : 1.2);
        expect(detachedBlock.overrideStyle).toMatchObject({
          fill: "#ABCDEF",
          pinToSplit: false,
          positionYPct: splitRatio,
        });
        expect(attached?.anchorY).toBeCloseTo(detached!.anchorY, 10);
        expect(attached?.visualBounds.left).toBeCloseTo(
          detached!.visualBounds.left,
          10
        );
        expect(attached?.visualBounds.top).toBeCloseTo(
          detached!.visualBounds.top,
          10
        );
        expect(attached?.visualBounds.right).toBeCloseTo(
          detached!.visualBounds.right,
          10
        );
        expect(attached?.visualBounds.bottom).toBeCloseTo(
          detached!.visualBounds.bottom,
          10
        );
        expectBoundsInFrame(attached!.visualBounds);
        expectBoundsInFrame(detached!.visualBounds);
      }
    }
  );

  test("is deterministic across repeated measurement and drawing calls", () => {
    const drawOptions = options(CAPTION_TEMPLATES["typewriter"], 0.5, {
      srcT: 0.72,
    });
    const context = new RecordingContext();

    const first = resolveCaptionLayout(
      context as unknown as CanvasRenderingContext2D,
      drawOptions
    );
    const second = resolveCaptionLayout(
      context as unknown as CanvasRenderingContext2D,
      drawOptions
    );
    const drawn = drawCaptions(
      context as unknown as CanvasRenderingContext2D,
      drawOptions
    );

    expect(second).toEqual(first);
    expect(drawn).toEqual(first);
  });

  test("independent resolve and draw calls cannot cross-contaminate current options", () => {
    expect(drawCaptions.length).toBe(2);
    const firstContext = new RecordingContext();
    const firstOptions = options(CAPTION_TEMPLATES["clawd-hop"], 0, {
      srcT: 0.62,
    });
    const first = resolveCaptionLayout(
      firstContext as unknown as CanvasRenderingContext2D,
      firstOptions
    );
    expect(first).not.toBeNull();

    const otherContext = new RecordingContext();
    const otherOptions = options(CAPTION_TEMPLATES["typewriter"], 1, {
      srcT: 0.72,
      width: 720,
      height: 1280,
      transientPosition: { blockId: block.id, positionYPct: 0.24 },
    });
    const other = resolveCaptionLayout(
      otherContext as unknown as CanvasRenderingContext2D,
      otherOptions
    );
    expect(other).not.toEqual(first);

    const repeatedFirst = resolveCaptionLayout(
      firstContext as unknown as CanvasRenderingContext2D,
      firstOptions
    );
    expect(repeatedFirst).toEqual(first);
    expect(repeatedFirst).not.toBe(first);

    const drawContext = new RecordingContext();
    const drawn = drawCaptions(
      drawContext as unknown as CanvasRenderingContext2D,
      firstOptions
    );

    expect(drawn).toEqual(first);
    expect(drawn).not.toBe(first);
    expect(drawn).not.toEqual(other);
    expect(drawContext.draws.length).toBeGreaterThan(0);
    for (const bounds of drawContext.draws) expectBoundsInFrame(bounds);
    expect(firstContext.draws).toEqual([]);
    expect(otherContext.draws).toEqual([]);

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first!.rawVisualBounds)).toBe(true);
    expect(Object.isFrozen(first!.visualBounds)).toBe(true);
    expect(Object.isFrozen(first!.anchorRange)).toBe(true);
    const internalValues = Object.getOwnPropertySymbols(first!).map(
      (symbol) => (first! as unknown as Record<symbol, unknown>)[symbol]
    );
    expect(internalValues.length).toBeGreaterThan(0);
    for (const value of internalValues) expectDeepFrozen(value);
  });

  test("snapshots authoring data before measurement and drawing", () => {
    const mutableStyle = structuredClone(CAPTION_TEMPLATES["highlight-box"]);
    const mutableBlock = structuredClone(block);
    mutableBlock.textOverride = ["ORIGINAL", "SNAPSHOT"];
    mutableBlock.overrideStyle = {
      shadowColor: "rgba(0,0,0,0.5)",
      splitOffsetPct: 0.04,
    };
    const drawOptions = options(mutableStyle, 0.43, {
      blocks: [mutableBlock],
      srcT: 0.62,
    });
    const baselineContext = new RecordingContext();
    const baseline = drawCaptions(
      baselineContext as unknown as CanvasRenderingContext2D,
      structuredClone(drawOptions)
    );

    const mutatingContext = new RecordingContext(() => {
      mutableStyle.template = "clean-minimal";
      mutableStyle.strokeWidthPct = 0.4;
      mutableStyle.boxPadXPct = 1;
      mutableBlock.words[1].start = 5;
      mutableBlock.words[1].end = 6;
      mutableBlock.textOverride![0] = "MUTATED";
      mutableBlock.overrideStyle!.shadowColor = "";
      mutableBlock.overrideStyle!.splitOffsetPct = -0.3;
    });
    const drawn = drawCaptions(
      mutatingContext as unknown as CanvasRenderingContext2D,
      drawOptions
    );

    expect(drawn).toEqual(baseline);
    expect(mutatingContext.draws).toEqual(baselineContext.draws);
    expect(drawn?.activeBlock).not.toBe(mutableBlock);
    expect(drawn?.style).not.toBe(mutableStyle);
    expect(drawn?.activeBlock.words).not.toBe(mutableBlock.words);
    expect(drawn?.activeBlock.overrideStyle).not.toBe(mutableBlock.overrideStyle);
    expectDeepFrozen(drawn);
  });
});

describe("split-pinned caption endpoint placement", () => {
  test.each(paths)("keeps the complete $name composition inside the output", ({ style }) => {
    const savedOffset = style.splitOffsetPct;

    for (const splitRatio of [0, 1]) {
      for (const srcT of [0.01, 0.08, 0.18, 0.43, 0.5, 0.62, 0.95]) {
        const context = new RecordingContext();
        const layout = drawCaptions(context as unknown as CanvasRenderingContext2D, {
          style: { ...style, pinToSplit: true, splitOffsetPct: savedOffset },
          blocks: [block],
          srcT,
          width: 360,
          height: 640,
          splitRatio,
        });

        expect(context.draws.length).toBeGreaterThan(0);
        for (const bounds of context.draws) {
          const evidence = `${style.template} split=${splitRatio} srcT=${srcT} operation=${bounds.operation}`;
          expect(bounds.left).toBeGreaterThanOrEqual(-1e-6);
          expect(bounds.top).toBeGreaterThanOrEqual(-1e-6);
          expect(bounds.right).toBeLessThanOrEqual(360 + 1e-6);
          expect(bounds.bottom).toBeLessThanOrEqual(640 + 1e-6);
          expectDrawInsideLayout(bounds, layout!.visualBounds, evidence);
        }
      }
    }

    expect(style.splitOffsetPct).toBe(savedOffset);
  });

  test.each(paths)(
    "refits the complete long $name composition inside the output",
    ({ style }) => {
      const savedStyle = { ...style };

      for (const splitRatio of [0, 1]) {
        for (const srcT of [0.01, 0.08, 0.18, 0.43, 0.62, 0.95]) {
          const context = new RecordingContext();
          const layout = drawCaptions(context as unknown as CanvasRenderingContext2D, {
            style: { ...style, pinToSplit: true },
            blocks: [nearWidthBlock],
            srcT,
            width: 360,
            height: 640,
            splitRatio,
          });

          expect(context.draws.length).toBeGreaterThan(0);
          for (const bounds of context.draws) {
            const evidence = `split=${splitRatio} srcT=${srcT} bounds=${JSON.stringify(bounds)}`;
            expect(bounds.left, evidence).toBeGreaterThanOrEqual(-1e-6);
            expect(bounds.top, evidence).toBeGreaterThanOrEqual(-1e-6);
            expect(bounds.right, evidence).toBeLessThanOrEqual(360 + 1e-6);
            expect(bounds.bottom, evidence).toBeLessThanOrEqual(640 + 1e-6);
            expectDrawInsideLayout(bounds, layout!.visualBounds, evidence);
          }
        }
      }

      expect(style).toEqual(savedStyle);
    }
  );
});
