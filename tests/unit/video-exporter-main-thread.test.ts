import { afterEach, describe, expect, it, vi } from "vitest";

const resources = vi.hoisted(() => ({
  encoderClose: vi.fn(),
  outputCancel: vi.fn().mockResolvedValue(undefined),
  outputFinalize: vi.fn().mockResolvedValue(undefined),
  sourceClose: vi.fn(),
}));

vi.mock("@/lib/export/workerBridge", () => ({
  EncodeWorkerBridge: class EncodeWorkerBridgeStub {},
  isWorkerEncodingSupported: () => false,
}));

vi.mock("mediabunny", () => ({
  BufferTarget: class BufferTargetStub {
    buffer = new ArrayBuffer(1);
  },
  EncodedPacket: { fromEncodedChunk: vi.fn() },
  EncodedVideoPacketSource: class EncodedVideoPacketSourceStub {
    add = vi.fn();
    close = resources.sourceClose;
  },
  Mp4OutputFormat: class Mp4OutputFormatStub {},
  Output: class OutputStub {
    addVideoTrack = vi.fn();
    cancel = resources.outputCancel;
    finalize = resources.outputFinalize;
    start = vi.fn().mockResolvedValue(undefined);
  },
}));

import { exportVideo } from "@/lib/export/videoExporter";

describe("main-thread video exporter resources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("closes a rendered bitmap when VideoFrame construction fails", async () => {
    const bitmap = { close: vi.fn() };
    vi.stubGlobal("VideoEncoder", class VideoEncoderStub {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      close = resources.encoderClose;
      configure = vi.fn();
      encode = vi.fn();
      flush = vi.fn().mockResolvedValue(undefined);
    });
    vi.stubGlobal("VideoFrame", class VideoFrameStub {
      constructor() {
        throw new Error("frame construction failed");
      }
    });

    await expect(
      exportVideo({
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 1 / 30,
        quality: "high",
        forceH264: true,
        onProgress: vi.fn(),
        renderFrame: vi.fn().mockResolvedValue(bitmap),
      })
    ).rejects.toThrow("frame construction failed");

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(resources.encoderClose).toHaveBeenCalledOnce();
    expect(resources.sourceClose).toHaveBeenCalledOnce();
    expect(resources.outputCancel).toHaveBeenCalledOnce();
    expect(resources.outputFinalize).not.toHaveBeenCalled();
  });

  it("stops after an in-flight render observes cancellation", async () => {
    const controller = new AbortController();
    const bitmap = { close: vi.fn() };
    const constructVideoFrame = vi.fn();
    vi.stubGlobal("VideoEncoder", class VideoEncoderStub {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      close = resources.encoderClose;
      configure = vi.fn();
      encode = vi.fn();
      flush = vi.fn().mockResolvedValue(undefined);
    });
    vi.stubGlobal("VideoFrame", class VideoFrameStub {
      close = vi.fn();

      constructor() {
        constructVideoFrame();
      }
    });

    await expect(
      exportVideo({
        width: 1080,
        height: 1920,
        fps: 30,
        duration: 1 / 30,
        quality: "high",
        forceH264: true,
        abortSignal: controller.signal,
        onProgress: vi.fn(),
        renderFrame: vi.fn().mockImplementation(async () => {
          controller.abort();
          return bitmap;
        }),
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(constructVideoFrame).not.toHaveBeenCalled();
    expect(resources.encoderClose).toHaveBeenCalledOnce();
    expect(resources.sourceClose).toHaveBeenCalledOnce();
    expect(resources.outputCancel).toHaveBeenCalledOnce();
    expect(resources.outputFinalize).not.toHaveBeenCalled();
  });

  it("does not cancel a successfully finalized output", async () => {
    const bitmap = { close: vi.fn() };
    const frameClose = vi.fn();
    vi.stubGlobal("VideoEncoder", class VideoEncoderStub {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      close = resources.encoderClose;
      configure = vi.fn();
      encode = vi.fn();
      flush = vi.fn().mockResolvedValue(undefined);
    });
    vi.stubGlobal("VideoFrame", class VideoFrameStub {
      close = frameClose;
    });

    const result = await exportVideo({
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 1 / 30,
      quality: "high",
      forceH264: true,
      onProgress: vi.fn(),
      renderFrame: vi.fn().mockResolvedValue(bitmap),
    });

    expect(result.blob.type).toBe("video/mp4");
    expect(resources.outputFinalize).toHaveBeenCalledOnce();
    expect(resources.outputCancel).not.toHaveBeenCalled();
  });
});
