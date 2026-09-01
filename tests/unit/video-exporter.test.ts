import { afterEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({
  dispose: vi.fn(),
  finalize: vi.fn().mockResolvedValue({
    buffer: new ArrayBuffer(1),
    mimeType: "video/mp4",
  }),
  initVideo: vi.fn().mockResolvedValue("avc1.640033"),
  sendFrame: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/export/workerBridge", () => ({
  EncodeWorkerBridge: class EncodeWorkerBridgeStub {
    dispose = worker.dispose;
    finalize = worker.finalize;
    initVideo = worker.initVideo;
    sendFrame = worker.sendFrame;
  },
  isWorkerEncodingSupported: () => true,
}));

import { exportVideo } from "@/lib/export/videoExporter";

describe("video exporter worker contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propagates forceH264 to worker initialization", async () => {
    vi.stubGlobal("ImageBitmap", class ImageBitmapStub {});
    vi.stubGlobal("VideoFrame", class VideoFrameStub {});
    vi.stubGlobal("VideoEncoder", {
      isConfigSupported: vi.fn().mockResolvedValue({ supported: true }),
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn().mockReturnValue("blob:export"),
    });

    await exportVideo({
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 1 / 30,
      quality: "high",
      forceH264: true,
      onProgress: vi.fn(),
      renderFrame: vi.fn().mockResolvedValue({}),
    });

    expect(worker.initVideo).toHaveBeenCalledWith(
      expect.objectContaining({ forceH264: true }),
      expect.any(Object)
    );
  });
});
