import { afterEach, describe, expect, it, vi } from "vitest";

const mediabunny = vi.hoisted(() => ({
  addVideoTrack: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("mediabunny", () => ({
  BufferTarget: class BufferTargetStub {},
  EncodedPacket: class EncodedPacketStub {},
  EncodedVideoPacketSource: class EncodedVideoPacketSourceStub {},
  Mp4OutputFormat: class Mp4OutputFormatStub {},
  Output: class OutputStub {
    addVideoTrack = mediabunny.addVideoTrack;
    start = mediabunny.start;
  },
  StreamTarget: class StreamTargetStub {},
}));

describe("encode worker codec contract", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("never probes or selects HEVC when forceH264 is true", async () => {
    const postMessage = vi.fn();
    const workerScope = { onmessage: null, postMessage };
    const isConfigSupported = vi.fn(async (config: VideoEncoderConfig) => ({
      supported: config.codec.startsWith("hvc1"),
      config,
    }));

    vi.stubGlobal("self", workerScope);
    vi.stubGlobal("VideoEncoder", class VideoEncoderStub {
      static isConfigSupported = isConfigSupported;
      state = "unconfigured";
      close = vi.fn();
      configure = vi.fn();
    });

    await import("@/lib/export/encode.worker");
    expect(workerScope.onmessage).toBeTypeOf("function");

    (workerScope.onmessage as unknown as (event: { data: unknown }) => void)({
      data: {
        type: "init-video",
        config: {
          width: 1080,
          height: 1920,
          fps: 30,
          quality: "high",
          duration: 1,
          totalFrames: 30,
          addWatermark: false,
          estimatedBytes: 1_000,
          forceH264: true,
        },
      },
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: "error",
        error: "No supported H.264 video codec found for this resolution.",
        fatal: true,
      });
    });
    expect(isConfigSupported).toHaveBeenCalled();
    expect(
      isConfigSupported.mock.calls.map(([config]) => config.codec)
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^avc1/)]));
    expect(
      isConfigSupported.mock.calls.some(([config]) => config.codec.startsWith("hvc1"))
    ).toBe(false);
  });
});
