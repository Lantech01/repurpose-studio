import { afterEach, describe, expect, it, vi } from "vitest";

const resources = vi.hoisted(() => ({
  canDecode: vi.fn().mockResolvedValue(true),
  exportVideo: vi.fn(),
  inputDispose: vi.fn().mockResolvedValue(undefined),
  iteratorReturn: vi.fn().mockResolvedValue({ done: true, value: undefined }),
}));

vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  CanvasSink: class CanvasSinkStub {
    canvasesAtTimestamps() {
      return {
        next: vi.fn(),
        return: resources.iteratorReturn,
      };
    }
  },
  Input: class InputStub {
    dispose = resources.inputDispose;
    getPrimaryVideoTrack = vi.fn().mockResolvedValue({
      canDecode: resources.canDecode,
    });
  },
  UrlSource: class UrlSourceStub {},
}));

vi.mock("@/lib/export/videoExporter", () => ({
  downloadBlob: vi.fn(),
  exportVideo: resources.exportVideo,
}));

import { exportShort } from "@/lib/repurpose/export-short";

describe("exportShort resource boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resources.exportVideo.mockReset();
  });

  it("disposes partially acquired decoders when canvas setup fails", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
      this: HTMLMediaElement
    ) {
      this.dispatchEvent(new Event("loadeddata"));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 206 })
    );
    vi.stubGlobal("OffscreenCanvas", class OffscreenCanvasStub {
      getContext() {
        return null;
      }
    });

    await expect(
      exportShort({
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
        download: false,
      })
    ).rejects.toThrow("could not get 2D context");

    expect(resources.canDecode).toHaveBeenCalledTimes(2);
    expect(resources.iteratorReturn).toHaveBeenCalledTimes(2);
    expect(resources.inputDispose).toHaveBeenCalledTimes(2);
  });

  it("unloads fallback videos when setup fails after loading them", async () => {
    resources.canDecode.mockResolvedValue(false);
    const cleanupLoads: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
      this: HTMLMediaElement
    ) {
      if (this.getAttribute("src")) {
        this.dispatchEvent(new Event("loadeddata"));
      } else {
        cleanupLoads.push(this);
      }
    });
    const removeAttribute = vi.spyOn(Element.prototype, "removeAttribute");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 206 })
    );
    vi.stubGlobal("OffscreenCanvas", class OffscreenCanvasStub {
      getContext() {
        return null;
      }
    });

    await expect(
      exportShort({
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
        download: false,
      })
    ).rejects.toThrow("could not get 2D context");

    expect(cleanupLoads).toHaveLength(2);
    expect(removeAttribute.mock.calls.filter(([name]) => name === "src")).toHaveLength(2);
    expect(cleanupLoads.every((video) => video.getAttribute("src") === null)).toBe(true);
  });

  it("unloads fallback videos whose initial load fails", async () => {
    resources.canDecode.mockResolvedValue(false);
    const failedVideos: HTMLMediaElement[] = [];
    const cleanupLoads: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
      this: HTMLMediaElement
    ) {
      if (this.getAttribute("src")) {
        failedVideos.push(this);
        this.dispatchEvent(new Event("error"));
      } else {
        cleanupLoads.push(this);
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 206 }));
    vi.stubGlobal("OffscreenCanvas", class OffscreenCanvasStub {
      getContext() {
        return null;
      }
    });

    await expect(
      exportShort({
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
        download: false,
      })
    ).rejects.toThrow("could not get 2D context");

    expect(failedVideos).toHaveLength(2);
    expect(cleanupLoads).toHaveLength(2);
    expect(failedVideos.every((video) => video.getAttribute("src") === null)).toBe(true);
  });

  it("aborts a pending fallback-video seek and releases both videos", async () => {
    vi.useFakeTimers();
    resources.canDecode.mockResolvedValue(false);
    const cleanupLoads: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
      this: HTMLMediaElement
    ) {
      if (this.getAttribute("src")) {
        this.dispatchEvent(new Event("loadeddata"));
      } else {
        cleanupLoads.push(this);
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 206 }));
    vi.stubGlobal("OffscreenCanvas", class OffscreenCanvasStub {
      getContext() {
        return {};
      }
    });
    vi.stubGlobal("VideoFrame", class VideoFrameStub {});
    let renderStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      renderStarted = resolve;
    });
    resources.exportVideo.mockImplementation(async (options) => {
      renderStarted();
      await options.renderVideoFrame(0.5, 500_000, 33_333);
      return { blob: new Blob(["video"]), url: "blob:video" };
    });
    const controller = new AbortController();
    const exporting = exportShort({
      clips: [
        {
          id: "clip",
          kind: "take",
          label: "Clip",
          srcStart: 1,
          srcEnd: 2,
          timelineStart: 0,
          timelineEnd: 1,
          kept: true,
          isKeeperTake: true,
          occurrences: [{ start: 1, end: 2 }],
          keeperIndex: 0,
        },
      ],
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
      abortSignal: controller.signal,
      download: false,
    });
    await started;

    const settled = exporting.then(
      () => null,
      (error: unknown) => error
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(settled).resolves.toMatchObject({ name: "AbortError" });
    expect(cleanupLoads).toHaveLength(2);
  });
});
