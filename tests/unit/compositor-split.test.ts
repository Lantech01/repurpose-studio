import { describe, expect, test, vi } from "vitest";
import {
  drawFrame,
  type AnyCtx2D,
  type OverlayDraw,
  type RegionSource,
} from "@/lib/repurpose/compositor";

type DrawCall = [unknown, ...number[]];

function recordingContext() {
  const drawImage = vi.fn((..._args: DrawCall) => undefined);
  const fillRect = vi.fn();
  const fillText = vi.fn();
  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    filter: "none",
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect,
    fillText,
    drawImage,
  } as unknown as AnyCtx2D;
  return { ctx, drawImage, fillRect, fillText };
}

function region(source: object | null, label: string): RegionSource {
  return {
    source: source as RegionSource["source"],
    sourceWidth: source ? 1920 : 0,
    sourceHeight: source ? 1080 : 0,
    transform: { x: 0, y: 0, scale: 1 },
    placeholderLabel: label,
  };
}

function overlay(source: object, band: OverlayDraw["band"]): OverlayDraw {
  return {
    source: source as OverlayDraw["source"],
    naturalWidth: 100,
    naturalHeight: 100,
    transform: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0, opacity: 1 },
    band,
    cornerRadius: 0,
  };
}

interface OrderedEvent {
  name: string;
  args: unknown[];
  alpha: number;
  clipDepth: number;
  translated: boolean;
}

function orderedContext() {
  const events: OrderedEvent[] = [];
  const stack: Array<{
    alpha: number;
    clipDepth: number;
    translated: boolean;
  }> = [];
  let alpha = 1;
  let clipDepth = 0;
  let translated = false;
  const record = (name: string, ...args: unknown[]) => {
    events.push({ name, args, alpha, clipDepth, translated });
  };
  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    filter: "none",
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(value: number) {
      alpha = value;
      record("globalAlpha", value);
    },
    save() {
      stack.push({ alpha, clipDepth, translated });
      record("save");
    },
    restore() {
      record("restore");
      const state = stack.pop();
      if (!state) return;
      alpha = state.alpha;
      clipDepth = state.clipDepth;
      translated = state.translated;
    },
    beginPath() {
      record("beginPath");
    },
    rect(...args: number[]) {
      record("rect", ...args);
    },
    roundRect(...args: Array<number | number[]>) {
      record("roundRect", ...args);
    },
    clip() {
      clipDepth += 1;
      record("clip");
    },
    stroke() {
      record("stroke");
    },
    moveTo(...args: number[]) {
      record("moveTo", ...args);
    },
    lineTo(...args: number[]) {
      record("lineTo", ...args);
    },
    translate(...args: number[]) {
      translated = true;
      record("translate", ...args);
    },
    rotate(...args: number[]) {
      record("rotate", ...args);
    },
    fillRect(...args: number[]) {
      record("fillRect", ...args);
    },
    fillText(...args: unknown[]) {
      record("fillText", ...args);
    },
    drawImage(...args: unknown[]) {
      record("drawImage", ...args);
    },
  } as unknown as AnyCtx2D;
  return { ctx, events, stack };
}

describe.each([
  { width: 9, height: 16 },
  { width: 1080, height: 1920 },
  { width: 2160, height: 3840 },
])("drawFrame endpoint bands at $width x $height", ({ width, height }) => {
  test.each([
    { ratio: 0, hidden: "screen" as const },
    { ratio: 0.49 / height, hidden: "screen" as const },
    { ratio: 1, hidden: "face" as const },
    { ratio: 1 - 0.49 / height, hidden: "face" as const },
  ])("skips every $hidden draw at ratio $ratio", ({ ratio, hidden }) => {
    const screenSource = { id: "screen", pause: vi.fn() };
    const faceSource = { id: "face", pause: vi.fn() };
    const screenOverlay = { id: "screen-overlay" };
    const faceOverlay = { id: "face-overlay" };
    const freeOverlay = { id: "free-overlay" };
    const { ctx, drawImage, fillRect, fillText } = recordingContext();

    drawFrame(ctx, {
      screen: region(screenSource, "SCREEN"),
      face: region(faceSource, "FACE"),
      splitRatio: ratio,
      width,
      height,
      dividerColor: "divider",
      overlays: [
        overlay(screenOverlay, "screen"),
        overlay(faceOverlay, "face"),
        overlay(freeOverlay, "free"),
      ],
    });

    const sources = drawImage.mock.calls.map((call) => call[0]);
    const hiddenSource = hidden === "screen" ? screenSource : faceSource;
    const visibleSource = hidden === "screen" ? faceSource : screenSource;
    const hiddenOverlay = hidden === "screen" ? screenOverlay : faceOverlay;
    const visibleOverlay = hidden === "screen" ? faceOverlay : screenOverlay;
    expect(sources).not.toContain(hiddenSource);
    expect(sources).not.toContain(hiddenOverlay);
    expect(sources).toContain(visibleSource);
    expect(sources).toContain(visibleOverlay);
    expect(sources).toContain(freeOverlay);

    const baseCall = drawImage.mock.calls.find((call) => call[0] === visibleSource);
    expect(baseCall?.slice(-4)).toEqual([0, 0, width, height]);
    expect(fillText).not.toHaveBeenCalledWith(hidden.toUpperCase(), expect.anything(), expect.anything());
    expect(fillRect.mock.calls.some((call) => call[3] === 2)).toBe(false);
    expect(screenSource.pause).not.toHaveBeenCalled();
    expect(faceSource.pause).not.toHaveBeenCalled();
  });
});

test("does not draw a placeholder for a rounded-zero band", () => {
  const { ctx, fillText } = recordingContext();
  drawFrame(ctx, {
    screen: region(null, "SCREEN"),
    face: region(null, "FACE"),
    splitRatio: 0.49 / 1920,
    width: 1080,
    height: 1920,
  });
  expect(fillText).not.toHaveBeenCalledWith("SCREEN", expect.anything(), expect.anything());
  expect(fillText).toHaveBeenCalledWith("FACE", 540, 960);
});

test("keeps the radius-zero overlay call path unchanged", () => {
  const source = { id: "square-overlay" };
  const { ctx, events } = orderedContext();

  drawFrame(ctx, {
    screen: region({ id: "screen" }, "SCREEN"),
    face: region({ id: "face" }, "FACE"),
    splitRatio: 0.5,
    width: 1080,
    height: 1920,
    showDivider: false,
    overlays: [overlay(source, "free")],
  });

  const drawIndex = events.findIndex(
    (event) => event.name === "drawImage" && event.args[0] === source
  );
  expect(events.slice(drawIndex - 2, drawIndex + 2).map((event) => event.name)).toEqual([
    "save",
    "translate",
    "drawImage",
    "restore",
  ]);
  expect(events.some((event) => event.name === "roundRect")).toBe(false);
});

test.each([
  { label: "image", source: { id: "rounded-image" } },
  { label: "video", source: { id: "rounded-video", currentTime: 1 } },
])(
  "clips a rotated $label locally after the output-space band clip",
  ({ source }) => {
    const { ctx, events } = orderedContext();
    const rounded: OverlayDraw = {
      source: source as OverlayDraw["source"],
      naturalWidth: 200,
      naturalHeight: 100,
      transform: {
        x: 0.4,
        y: 0.3,
        scale: 0.4,
        rotation: 30,
        opacity: 0.35,
      },
      band: "screen",
      cornerRadius: 0.25,
    };

    drawFrame(ctx, {
      screen: region({ id: "screen" }, "SCREEN"),
      face: region({ id: "face" }, "FACE"),
      splitRatio: 0.4,
      width: 1080,
      height: 1920,
      showDivider: false,
      overlays: [rounded],
    });

    const drawIndex = events.findIndex(
      (event) => event.name === "drawImage" && event.args[0] === source
    );
    const overlayEvents = events.slice(
      events.map((event) => event.name).lastIndexOf("save", drawIndex),
      drawIndex + 2
    );
    expect(overlayEvents.map((event) => event.name)).toEqual([
      "save",
      "beginPath",
      "rect",
      "clip",
      "globalAlpha",
      "translate",
      "rotate",
      "beginPath",
      "roundRect",
      "clip",
      "drawImage",
      "restore",
    ]);
    expect(overlayEvents.find((event) => event.name === "rect")?.args).toEqual([
      0,
      0,
      1080,
      768,
    ]);
    expect(overlayEvents.find((event) => event.name === "roundRect")?.args).toEqual([
      -216,
      -108,
      432,
      216,
      54,
    ]);
    expect(overlayEvents.find((event) => event.name === "roundRect")?.translated).toBe(true);
    expect(overlayEvents.find((event) => event.name === "drawImage")).toMatchObject({
      alpha: 0.35,
      clipDepth: 2,
      translated: true,
    });
  }
);

test("caps radius at half the rendered short side", () => {
  const source = { id: "max-radius" };
  const { ctx, events } = orderedContext();
  drawFrame(ctx, {
    screen: region({ id: "screen" }, "SCREEN"),
    face: region({ id: "face" }, "FACE"),
    splitRatio: 0.5,
    width: 1000,
    height: 1600,
    showDivider: false,
    overlays: [
      {
        ...overlay(source, "free"),
        naturalWidth: 400,
        naturalHeight: 100,
        transform: {
          x: 0.5,
          y: 0.5,
          scale: 0.8,
          rotation: 0,
          opacity: 1,
        },
        cornerRadius: 2,
      },
    ],
  });

  expect(events.find((event) => event.name === "roundRect")?.args).toEqual([
    -400,
    -100,
    800,
    200,
    100,
  ]);
});

test("restores clip, transform, and alpha between overlays and the caller caption", () => {
  const first = { id: "first-overlay" };
  const second = { id: "second-overlay" };
  const { ctx, events, stack } = orderedContext();
  drawFrame(ctx, {
    screen: region({ id: "screen" }, "SCREEN"),
    face: region({ id: "face" }, "FACE"),
    splitRatio: 0.5,
    width: 1080,
    height: 1920,
    dividerColor: "divider",
    overlays: [
      {
        ...overlay(first, "screen"),
        transform: {
          ...overlay(first, "screen").transform,
          rotation: 15,
          opacity: 0.2,
        },
        cornerRadius: 0.1,
      },
      {
        ...overlay(second, "free"),
        transform: { ...overlay(second, "free").transform, opacity: 0.8 },
        cornerRadius: 0.5,
      },
    ],
  });
  ctx.fillText("caption", 10, 20);

  const drawFor = (source: object) =>
    events.find(
      (event) => event.name === "drawImage" && event.args[0] === source
    );
  expect(drawFor(first)).toMatchObject({ alpha: 0.2, clipDepth: 2 });
  expect(drawFor(second)).toMatchObject({ alpha: 0.8, clipDepth: 1 });
  expect(events.at(-1)).toMatchObject({
    name: "fillText",
    args: ["caption", 10, 20],
    alpha: 1,
    clipDepth: 0,
    translated: false,
  });
  expect(stack).toHaveLength(0);
  expect(events.filter((event) => event.name === "save")).toHaveLength(
    events.filter((event) => event.name === "restore").length
  );

  const background = events.findIndex((event) => event.name === "fillRect");
  const divider = events.findIndex(
    (event, index) => event.name === "fillRect" && index > background
  );
  const firstOverlay = events.indexOf(drawFor(first)!);
  const caption = events.length - 1;
  expect(background).toBeLessThan(divider);
  expect(divider).toBeLessThan(firstOverlay);
  expect(firstOverlay).toBeLessThan(caption);
});
