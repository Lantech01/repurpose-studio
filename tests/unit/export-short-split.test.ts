import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CaptionBlock, CaptionStyle } from "@/lib/repurpose/captions";
import { overlayAABBNorm } from "@/lib/repurpose/overlay-geometry";
import type { Clip, Overlay } from "@/lib/repurpose/types";

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
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
  filter = "none";
  imageSmoothingEnabled = false;
  imageSmoothingQuality: ImageSmoothingQuality = "low";
  readonly draws: Bounds[] = [];
  readonly drawImageCalls: unknown[][] = [];
  readonly fillRectCalls: number[][] = [];

  private matrix: Matrix = { a: 1, d: 1, e: 0, f: 0 };
  private stack: Array<{ matrix: Matrix; alpha: number; lineWidth: number; font: string }> = [];
  private pathPoints: Array<{ x: number; y: number }> = [];
  private pathRect: Bounds | null = null;

  private fontSize(): number {
    return Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 16);
  }

  private record(bounds: Bounds): void {
    if (this.globalAlpha <= 0) return;
    const xs = [bounds.left * this.matrix.a + this.matrix.e, bounds.right * this.matrix.a + this.matrix.e];
    const ys = [bounds.top * this.matrix.d + this.matrix.f, bounds.bottom * this.matrix.d + this.matrix.f];
    this.draws.push({
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    });
  }

  save(): void {
    this.stack.push({
      matrix: { ...this.matrix },
      alpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      font: this.font,
    });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    this.matrix = state.matrix;
    this.globalAlpha = state.alpha;
    this.lineWidth = state.lineWidth;
    this.font = state.font;
  }

  translate(x: number, y: number): void {
    this.matrix.e += this.matrix.a * x;
    this.matrix.f += this.matrix.d * y;
  }

  scale(x: number, y: number): void {
    this.matrix.a *= x;
    this.matrix.d *= y;
  }

  rotate(): void {}

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
    });
  }

  strokeText(text: string, x: number, y: number): void {
    const metrics = this.measureText(text);
    const outset = this.lineWidth / 2;
    this.record({
      left: x - outset,
      top: y - metrics.actualBoundingBoxAscent - outset,
      right: x + metrics.width + outset,
      bottom: y + metrics.actualBoundingBoxDescent + outset,
    });
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fillRectCalls.push([x, y, width, height]);
    this.record({ left: x, top: y, right: x + width, bottom: y + height });
  }

  drawImage(...args: unknown[]): void {
    this.drawImageCalls.push(args);
  }

  beginPath(): void {
    this.pathPoints = [];
    this.pathRect = null;
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.pathRect = { left: x, top: y, right: x + width, bottom: y + height };
  }

  roundRect(x: number, y: number, width: number, height: number): void {
    this.rect(x, y, width, height);
  }

  moveTo(x: number, y: number): void {
    this.pathPoints.push({ x, y });
  }

  lineTo(x: number, y: number): void {
    this.pathPoints.push({ x, y });
  }

  fill(): void {
    if (this.pathRect) this.record(this.pathRect);
  }

  stroke(): void {
    if (this.pathPoints.length === 0) return;
    const outset = this.lineWidth / 2;
    const xs = this.pathPoints.map(({ x }) => x);
    const ys = this.pathPoints.map(({ y }) => y);
    this.record({
      left: Math.min(...xs) - outset,
      top: Math.min(...ys) - outset,
      right: Math.max(...xs) + outset,
      bottom: Math.max(...ys) + outset,
    });
  }

  clip(): void {}
  arcTo(): void {}
  closePath(): void {}

  createLinearGradient(): CanvasGradient {
    return { addColorStop() {} } as CanvasGradient;
  }
}

const harness = vi.hoisted(() => ({
  audioRequests: [] as Array<{ path: string; start: number; end: number }>,
  audioSources: [] as string[],
  contexts: [] as RecordingContext[],
  frameTimes: [] as number[],
  muxAudioBuffers: [] as AudioBuffer[],
  muxFinalized: 0,
  videoTimestampRequests: [] as Array<{ path: string; timestamps: number[] }>,
}));

vi.mock("@/lib/export/videoExporter", () => ({
  downloadBlob: vi.fn(),
  exportVideo: vi.fn(async (options) => {
    for (const time of harness.frameTimes) {
      await options.renderVideoFrame(time, Math.round(time * 1_000_000), 33_333);
    }
    return { blob: new Blob(["video"]), url: "blob:video" };
  }),
}));

vi.mock("@/lib/repurpose/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/compositor")>();
  return { ...actual, drawFrame: vi.fn(actual.drawFrame) };
});

vi.mock("@/lib/repurpose/captions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/captions")>();
  return { ...actual, drawCaptions: vi.fn(actual.drawCaptions) };
});

vi.mock("@/lib/repurpose/split-ratio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/split-ratio")>();
  return { ...actual, effectiveSplitRatio: vi.fn(actual.effectiveSplitRatio) };
});

vi.mock("@/lib/repurpose/overlay-effects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/overlay-effects")>();
  return {
    ...actual,
    resolveOverlayAppearanceAt: vi.fn(actual.resolveOverlayAppearanceAt),
  };
});

vi.mock("@/lib/repurpose/caption-fonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/caption-fonts")>();
  return { ...actual, loadCaptionFonts: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("mediabunny", () => {
  class UrlSource {
    constructor(readonly path: string) {}
  }

  class BlobSource {
    constructor(readonly blob: Blob) {}
  }

  class Input {
    readonly path: string | undefined;

    constructor(options: { source: UrlSource | BlobSource }) {
      this.path = options.source instanceof UrlSource ? options.source.path : undefined;
    }

    getPrimaryVideoTrack = vi.fn().mockImplementation(async () => ({
      path: this.path,
      codec: "avc",
      canDecode: vi.fn().mockResolvedValue(true),
      getDecoderConfig: vi.fn().mockResolvedValue({ codec: "avc1.42001f" }),
    }));

    getPrimaryAudioTrack = vi.fn().mockImplementation(async () => ({
      path: this.path,
      sampleRate: 30,
      numberOfChannels: 2,
      canDecode: vi.fn().mockResolvedValue(true),
    }));

    dispose = vi.fn().mockResolvedValue(undefined);
  }

  class CanvasSink {
    constructor(private readonly track: { path: string }) {}

    canvasesAtTimestamps(timestamps: number[]) {
      const track = this.track;
      harness.videoTimestampRequests.push({
        path: track.path,
        timestamps: [...timestamps],
      });
      return {
        next: vi.fn().mockImplementation(async () => ({
          done: false,
          value: { canvas: { id: `frame:${track.path}`, width: 320, height: 180 } },
        })),
        return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      };
    }
  }

  class AudioBufferSink {
    constructor(private readonly track: { path: string }) {
      harness.audioSources.push(track.path);
    }

    async *buffers(start: number, end: number) {
      harness.audioRequests.push({ path: this.track.path, start, end });
      const length = Math.max(1, Math.round((end - start) * 30));
      const channels = [
        Float32Array.from({ length }, (_, index) => 0.75 + index / 100),
        Float32Array.from({ length }, (_, index) => -0.25 - index / 100),
      ];
      yield {
        timestamp: start,
        buffer: {
          duration: length / 30,
          length,
          numberOfChannels: 2,
          sampleRate: 30,
          getChannelData: (channel: number) => channels[channel],
        },
      };
    }
  }

  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }

  class Output {
    private readonly target: BufferTarget;

    constructor(options: { target: BufferTarget }) {
      this.target = options.target;
    }

    addVideoTrack() {}
    addAudioTrack() {}
    start = vi.fn().mockResolvedValue(undefined);
    cancel = vi.fn().mockResolvedValue(undefined);
    finalize = vi.fn().mockImplementation(async () => {
      this.target.buffer = Uint8Array.from([1, 2, 3]).buffer;
      harness.muxFinalized += 1;
    });
  }

  class AudioBufferSource {
    add = vi.fn().mockImplementation(async (buffer: AudioBuffer) => {
      harness.muxAudioBuffers.push(buffer);
    });
  }

  class EncodedVideoPacketSource {
    add = vi.fn().mockResolvedValue(undefined);
  }

  class EncodedPacketSink {
    async *packets() {
      yield { type: "key", timestamp: 0 };
    }
  }

  return {
    ALL_FORMATS: [],
    AudioBufferSink,
    AudioBufferSource,
    BlobSource,
    BufferTarget,
    CanvasSink,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat: class Mp4OutputFormat {},
    Output,
    QUALITY_HIGH: 1,
    UrlSource,
    getFirstEncodableAudioCodec: vi.fn().mockResolvedValue("aac"),
  };
});

import { CAPTION_TEMPLATES, drawCaptions } from "@/lib/repurpose/captions";
import { easings } from "@/lib/engine/easing";
import { drawFrame } from "@/lib/repurpose/compositor";
import {
  exportShort,
  resolveExportOverlaySource,
} from "@/lib/repurpose/export-short";
import { resolveOverlayAppearanceAt } from "@/lib/repurpose/overlay-effects";
import { effectiveSplitRatio } from "@/lib/repurpose/split-ratio";

const screenUrl = "/api/repurpose/video?path=screen.mp4";
const faceUrl = "/api/repurpose/video?path=face.mp4";

const captionBlock: CaptionBlock = {
  id: "caption",
  words: [{ text: "NARRATION", start: 0, end: 1 }],
  start: 0,
  end: 1,
  keywordIndex: 0,
};

const captionStyle: CaptionStyle = {
  ...CAPTION_TEMPLATES["bold-outline"],
  pinToSplit: true,
};

function clip(
  id: string,
  timelineStart: number,
  timelineEnd: number,
  splitRatio: number,
  easing?: "natural" | "bounce"
): Clip {
  return {
    id,
    kind: "take",
    label: id,
    srcStart: 0.01 + timelineStart,
    srcEnd: 0.01 + timelineEnd,
    timelineStart,
    timelineEnd,
    kept: true,
    isKeeperTake: true,
    occurrences: [],
    keeperIndex: 0,
    splitRatio,
    ...(easing
      ? {
          transitionIn: {
            type: "zoom-settle" as const,
            durationSec: 0.4,
            amount: 0.06,
            easing,
          },
        }
      : {}),
  };
}

function overlays(): Overlay[] {
  return (["screen", "face", "free"] as const).map((band, zIndex) => ({
    id: `${band}-overlay`,
    kind: "image",
    src: `blob:${band}-overlay`,
    naturalWidth: 100,
    naturalHeight: 100,
    timelineStart: 0,
    timelineEnd: 1,
    srcStart: 0,
    srcDuration: 1,
    transform: { x: 0.5, y: 0.5, scale: 1.4, rotation: 37 },
    zIndex,
    opacity: 1,
    muted: true,
    band,
  }));
}

function appearanceOverlays(): Overlay[] {
  return [
    {
      id: "appearance-image",
      kind: "image",
      src: "/media/appearance-image.png",
      sourcePath: "C:\\media\\appearance-image.png",
      naturalWidth: 640,
      naturalHeight: 360,
      timelineStart: 0,
      timelineEnd: 0.4,
      srcStart: 0,
      srcDuration: 0.4,
      transform: { x: 0.45, y: 0.3, scale: 0.36, rotation: 23 },
      zIndex: 0,
      opacity: 0.6,
      muted: true,
      band: "screen",
      entranceEffect: { type: "slide", durationSec: 0.4, direction: "left" },
      exitEffect: { type: "zoom", durationSec: 0.4 },
      cornerRadius: 0.16,
    },
    {
      id: "appearance-video",
      kind: "video",
      src: "/media/appearance-video-proxy.mp4",
      sourcePath: "C:\\media\\appearance-video.mp4",
      naturalWidth: 1280,
      naturalHeight: 720,
      timelineStart: 0,
      timelineEnd: 0.4,
      srcStart: 7,
      srcDuration: 12,
      transform: { x: 0.55, y: 0.7, scale: 0.42, rotation: -17 },
      zIndex: 1,
      opacity: 0.35,
      muted: true,
      band: "face",
      entranceEffect: { type: "fade", durationSec: 0.4 },
      exitEffect: { type: "pop", durationSec: 0.4 },
      cornerRadius: 0.5,
    },
  ];
}

function appearanceClips(): Clip[] {
  return [
    clip("appearance-outgoing", 0, 0.1, 0),
    {
      ...clip("appearance-incoming", 0.1, 0.5, 1, "natural"),
      transitionIn: {
        type: "zoom-settle",
        durationSec: 0.2,
        amount: 0.06,
        easing: "natural",
      },
    },
  ];
}

async function renderAppearanceCase(resolution: "1080p" | "4k") {
  const overlayInput = appearanceOverlays();
  const before = structuredClone(overlayInput);
  harness.frameTimes = Array.from({ length: 15 }, (_, index) => index / 30);

  await exportShort({
    clips: appearanceClips(),
    duration: 0.5,
    splitRatio: 0.5,
    footageMeta: {
      faceCamPath: faceUrl,
      screenPath: screenUrl,
      fps: 30,
      width: 320,
      height: 180,
      durationSec: 1,
    },
    overlays: overlayInput,
    resolution,
    download: false,
  });

  return { overlayInput, before };
}

async function renderCase(input: {
  ratio: number;
  resolution: "1080p" | "4k";
  easing?: "natural" | "bounce";
  fromRatio?: number;
}): Promise<RecordingContext> {
  const frameStep = 1 / 30;
  const clips = input.easing
    ? [
        clip("outgoing", 0, frameStep, input.fromRatio ?? 0.5),
        clip("incoming", frameStep, frameStep * 5, input.ratio, input.easing),
      ]
    : [clip("plain", 0, frameStep, input.ratio)];
  harness.frameTimes = input.easing ? [0, frameStep, frameStep * 2] : [0];

  await exportShort({
    clips,
    duration: input.easing ? frameStep * 5 : frameStep,
    splitRatio: 0.5,
    footageMeta: {
      faceCamPath: faceUrl,
      screenPath: screenUrl,
      fps: 30,
      width: 320,
      height: 180,
      durationSec: 1,
    },
    overlays: overlays(),
    captionsEnabled: true,
    captionStyle,
    captionBlocks: [captionBlock],
    resolution: input.resolution,
    download: false,
  });

  return harness.contexts.at(-1)!;
}

beforeEach(() => {
  harness.audioRequests.length = 0;
  harness.audioSources.length = 0;
  harness.contexts.length = 0;
  harness.frameTimes.length = 0;
  harness.muxAudioBuffers.length = 0;
  harness.muxFinalized = 0;
  harness.videoTimestampRequests.length = 0;
  vi.mocked(drawFrame).mockClear();
  vi.mocked(drawCaptions).mockClear();
  vi.mocked(effectiveSplitRatio).mockClear();
  vi.mocked(resolveOverlayAppearanceAt).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    status: 206,
    blob: async () => ({ sourceUrl: String(url) }),
  })));
  vi.stubGlobal("createImageBitmap", vi.fn().mockImplementation(async (blob) => ({
    id: `bitmap:${blob.sourceUrl}`,
    width: 100,
    height: 100,
    close: vi.fn(),
  })));
  vi.stubGlobal("AudioBuffer", class AudioBufferStub {});
  vi.stubGlobal("OfflineAudioContext", class OfflineAudioContextStub {
    createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
      const channels = Array.from(
        { length: numberOfChannels },
        () => new Float32Array(length)
      );
      return {
        duration: length / sampleRate,
        length,
        numberOfChannels,
        sampleRate,
        getChannelData: (channel: number) => channels[channel],
      };
    }
  });
  vi.stubGlobal("OffscreenCanvas", class OffscreenCanvasStub {
    readonly context = new RecordingContext();

    constructor(readonly width: number, readonly height: number) {
      harness.contexts.push(this.context);
    }

    getContext() {
      return this.context;
    }
  });
  vi.stubGlobal("VideoFrame", class VideoFrameStub {
    close = vi.fn();
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:muxed-video");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

describe.each([
  { resolution: "1080p" as const, width: 1080, height: 1920 },
  { resolution: "4k" as const, width: 2160, height: 3840 },
])("export overlay appearance descriptors at $resolution", ({ resolution, width, height }) => {
  test("uses the shared frame appearance for image/video short windows without mutation", async () => {
    const { overlayInput, before } = await renderAppearanceCase(resolution);
    const samples = [
      { label: "entrance start", time: 0 },
      { label: "entrance midpoint", time: 0.1 },
      { label: "settled", time: 0.2 },
      { label: "exit midpoint", time: 0.3 },
    ];

    expect(resolveOverlayAppearanceAt).toHaveBeenCalledTimes(24);
    for (const { time } of samples) {
      const frameIndex = Math.round(time * 30);
      const draw = vi.mocked(drawFrame).mock.calls[frameIndex][1];
      expect(draw.overlays).toHaveLength(2);
      for (const [overlayIndex, sourceOverlay] of overlayInput.entries()) {
        const resolverCallIndex = frameIndex * 2 + overlayIndex;
        const resolverCall = vi.mocked(resolveOverlayAppearanceAt).mock.calls[
          resolverCallIndex
        ];
        const appearance = vi.mocked(resolveOverlayAppearanceAt).mock.results[
          resolverCallIndex
        ].value;
        expect(resolverCall[0]).toEqual({
          ...sourceOverlay,
          src: resolveExportOverlaySource(sourceOverlay),
        });
        expect(resolverCall[1]).toBe(time);
        expect(resolverCall[2]).toEqual({ left: 0, top: 0, width, height });
        expect(resolverCall[3]).toBe(draw.splitRatio);
        expect(draw.overlays![overlayIndex]).toMatchObject({
          transform: {
            ...appearance.transform,
            opacity: sourceOverlay.opacity * appearance.opacityMultiplier,
          },
          cornerRadius: appearance.cornerRadius,
          band: sourceOverlay.band,
        });
      }
    }

    const entranceStart = vi.mocked(drawFrame).mock.calls[0][1].overlays!;
    expect(entranceStart).toHaveLength(2);
    expect(entranceStart.map((item) => item.transform.opacity)).toEqual([0, 0]);
    expect((entranceStart[0].source as { id: string }).id).toContain(
      "appearance-image.png"
    );
    expect((entranceStart[1].source as { id: string }).id).toContain(
      "appearance-video.mp4"
    );

    const endDraw = vi.mocked(drawFrame).mock.calls[Math.round(0.4 * 30)][1];
    expect(endDraw.overlays).toEqual([]);
    expect(endDraw.splitRatio).toBe(1);
    expect(overlayInput).toEqual(before);

    const videoPath = resolveExportOverlaySource(overlayInput[1]);
    const videoTimestamps = harness.videoTimestampRequests.find(
      (request) => request.path === videoPath
    )?.timestamps;
    expect(videoTimestamps).toHaveLength(12);
    expect(videoTimestamps?.[0]).toBe(7);
    expect(videoTimestamps?.at(-1)).toBeCloseTo(7 + 11 / 30, 12);
    expect(harness.audioSources).toEqual([faceUrl]);
    expect(harness.audioSources).not.toContain(videoPath);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  { resolution: "1080p" as const, width: 1080, height: 1920 },
  { resolution: "4k" as const, width: 2160, height: 3840 },
])("export split parity at $resolution", ({ resolution, width, height }) => {
  test.each([
    { name: "Face endpoint", ratio: 0, expected: 0 },
    { name: "Screen endpoint", ratio: 1, expected: 1 },
    { name: "tiny rounded-zero Screen band", ratio: 0.49 / height, expected: 0 },
    { name: "tiny rounded-zero Face band", ratio: 1 - 0.49 / height, expected: 1 },
  ])("uses one effective split for a plain $name frame", async ({ ratio, expected }) => {
    const context = await renderCase({ ratio, resolution });

    expect(effectiveSplitRatio).toHaveBeenCalledOnce();
    expect(effectiveSplitRatio).toHaveBeenCalledWith(ratio, height);
    expect(drawFrame).toHaveBeenCalledOnce();
    expect(drawCaptions).toHaveBeenCalledOnce();
    expect(vi.mocked(drawFrame).mock.calls[0][1].splitRatio).toBe(expected);
    expect(vi.mocked(drawCaptions).mock.calls[0][1].splitRatio).toBe(expected);

    const hidden = expected === 0 ? "screen" : "face";
    const visible = expected === 0 ? "face" : "screen";
    const sources = context.drawImageCalls.map(([source]) => (source as { id?: string }).id);
    expect(sources).not.toContain(`frame:${hidden === "screen" ? screenUrl : faceUrl}`);
    expect(sources).not.toContain(`bitmap:blob:${hidden}-overlay`);
    expect(sources).toContain(`bitmap:blob:${visible}-overlay`);
    expect(sources).toContain("bitmap:blob:free-overlay");

    const baseCall = context.drawImageCalls.find(
      ([source]) => (source as { id?: string }).id === `frame:${visible === "screen" ? screenUrl : faceUrl}`
    );
    expect(baseCall?.slice(-4)).toEqual([0, 0, width, height]);
    expect(context.fillRectCalls).not.toContainEqual([0, expect.any(Number), width, 2]);
    expect(context.draws.length).toBeGreaterThan(1);
    for (const bounds of context.draws) {
      expect(bounds.left).toBeGreaterThanOrEqual(-1e-6);
      expect(bounds.top).toBeGreaterThanOrEqual(-1e-6);
      expect(bounds.right).toBeLessThanOrEqual(width + 1e-6);
      expect(bounds.bottom).toBeLessThanOrEqual(height + 1e-6);
    }

    if (expected === 1) expect(harness.audioSources).toEqual([faceUrl]);
  });

  test.each(["natural", "bounce"] as const)(
    "shares the effective interpolated split inside a %s transition to each endpoint",
    async (easing) => {
      for (const ratio of [0, 1]) {
        const fromRatio = ratio === 0 ? 0.6 : 0;
        vi.mocked(drawFrame).mockClear();
        vi.mocked(drawCaptions).mockClear();
        vi.mocked(effectiveSplitRatio).mockClear();
        await renderCase({ ratio, resolution, easing, fromRatio });

        const eased = easing === "bounce"
          ? easings.easeOutBack(0.25)
          : easings.easeInOutCubic(0.25);
        const interpolated = fromRatio + (ratio - fromRatio) * eased;
        const expected = Math.round(interpolated * height) / height;

        expect(effectiveSplitRatio).toHaveBeenCalledTimes(3);
        expect(effectiveSplitRatio).toHaveBeenNthCalledWith(3, expect.closeTo(interpolated, 12), height);
        expect(vi.mocked(drawFrame).mock.calls[2][1].splitRatio).toBe(expected);
        expect(vi.mocked(drawCaptions).mock.calls[2][1].splitRatio).toBe(expected);
        expect(expected).not.toBe(fromRatio);
        expect(expected).not.toBe(ratio);
        expect(vi.mocked(drawFrame).mock.calls.at(-1)?.[1].transition).toMatchObject({
          easing,
          progress: 0.25,
        });
        const overlayDraws = vi.mocked(drawFrame).mock.calls[2][1].overlays!;
        const screenBox = overlayAABBNorm(
          overlayDraws[0].transform,
          overlayDraws[0].naturalWidth,
          overlayDraws[0].naturalHeight,
          { left: 0, top: 0, width, height }
        );
        const faceBox = overlayAABBNorm(
          overlayDraws[1].transform,
          overlayDraws[1].naturalWidth,
          overlayDraws[1].naturalHeight,
          { left: 0, top: 0, width, height }
        );
        expect(screenBox.maxY).toBeLessThanOrEqual(expected + 1e-10);
        expect(faceBox.minY).toBeGreaterThanOrEqual(expected - 1e-10);
        expect(overlayDraws[2].transform).toMatchObject(overlays()[2].transform);
      }
    }
  );
});

test("keeps Face narration synchronized and muxed while Screen is full-frame", async () => {
  await renderCase({ ratio: 1, resolution: "1080p" });

  expect(harness.audioSources).toEqual([faceUrl]);
  expect(harness.audioSources).not.toContain(screenUrl);
  expect(harness.audioRequests).toEqual([
    { path: faceUrl, start: 0.01, end: 0.01 + 1 / 30 },
  ]);
  expect(harness.muxAudioBuffers).toHaveLength(1);
  const muxedFaceAudio = harness.muxAudioBuffers[0];
  expect(muxedFaceAudio).toMatchObject({
    length: 1,
    numberOfChannels: 2,
    sampleRate: 30,
  });
  expect([...muxedFaceAudio.getChannelData(0)]).toEqual([0.75]);
  expect([...muxedFaceAudio.getChannelData(1)]).toEqual([-0.25]);
  expect(harness.muxFinalized).toBe(1);
});
