import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  events: [] as string[],
  exportVideo: vi.fn(),
  inputDisposes: [] as ReturnType<typeof vi.fn>[],
  iteratorReturns: [] as ReturnType<typeof vi.fn>[],
}));

vi.mock("@/lib/export/videoExporter", () => ({
  downloadBlob: vi.fn(),
  exportVideo: harness.exportVideo,
}));

vi.mock("@/lib/repurpose/compositor", () => ({
  drawFrame: vi.fn(),
}));

vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  CanvasSink: class CanvasSinkStub {
    canvasesAtTimestamps() {
      const index = harness.iteratorReturns.length;
      const iteratorReturn = vi.fn(async () => {
        harness.events.push(`dispose-${index}`);
        return { done: true, value: undefined };
      });
      harness.iteratorReturns.push(iteratorReturn);
      return {
        next: vi.fn().mockResolvedValue({
          done: false,
          value: { canvas: { width: 320, height: 180 } },
        }),
        return: iteratorReturn,
      };
    }
  },
  Input: class InputStub {
    dispose: ReturnType<typeof vi.fn>;

    constructor() {
      this.dispose = vi.fn().mockResolvedValue(undefined);
      harness.inputDisposes.push(this.dispose);
    }

    getPrimaryVideoTrack = vi.fn().mockResolvedValue({
      canDecode: vi.fn().mockResolvedValue(true),
    });
  },
  UrlSource: class UrlSourceStub {},
}));

import { exportShort } from "@/lib/repurpose/export-short";

describe("overlay decoder restart cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    harness.events.length = 0;
    harness.inputDisposes.length = 0;
    harness.iteratorReturns.length = 0;
    harness.exportVideo.mockReset();
  });

  it("disposes a retired overlay decoder before loading its fallback video", async () => {
    const overlaySrc = "/api/repurpose/video?path=overlay.mp4";
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
      this: HTMLMediaElement
    ) {
      harness.events.push(`load-${this.getAttribute("src")}`);
      this.dispatchEvent(new Event("loadeddata"));
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 206 }));
    vi.stubGlobal("AudioBuffer", undefined);
    vi.stubGlobal("OffscreenCanvas", class OffscreenCanvasStub {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return {};
      }
    });
    vi.stubGlobal("VideoFrame", class VideoFrameStub {
      close = vi.fn();
    });
    harness.exportVideo.mockImplementation(async (options) => {
      await options.renderVideoFrame(0, 0, 33_333);
      await options.renderVideoFrame(0, 0, 33_333);
      return { blob: new Blob(["video"]), url: "blob:video" };
    });

    await exportShort({
      clips: [],
      duration: 1,
      splitRatio: 0.5,
      footageMeta: {
        faceCamPath: "/face.mp4",
        screenPath: "/screen.mp4",
        fps: 30,
        width: 320,
        height: 180,
        durationSec: 1,
      },
      overlays: [
        {
          id: "overlay-video",
          kind: "video",
          src: overlaySrc,
          naturalWidth: 320,
          naturalHeight: 180,
          timelineStart: 0,
          timelineEnd: 1,
          srcStart: 0,
          srcDuration: 1,
          transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
          zIndex: 0,
          opacity: 1,
          muted: true,
        },
      ],
      download: false,
    });

    const disposeIndex = harness.events.indexOf("dispose-2");
    const fallbackLoadIndex = harness.events.indexOf(`load-${overlaySrc}`);
    expect(disposeIndex).toBeGreaterThanOrEqual(0);
    expect(fallbackLoadIndex).toBeGreaterThan(disposeIndex);
    expect(harness.iteratorReturns).toHaveLength(3);
    for (const iteratorReturn of harness.iteratorReturns) {
      expect(iteratorReturn).toHaveBeenCalledOnce();
    }
    for (const inputDispose of harness.inputDisposes) {
      expect(inputDispose).toHaveBeenCalledOnce();
    }
  });
});
