import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { mediabunny, muxResources } = vi.hoisted(() => {
  const audioAdd = vi.fn(async () => undefined);
  const outputCancel = vi.fn(async () => undefined);
  const outputFinalize = vi.fn(async () => undefined);
  const outputStart = vi.fn(async () => undefined);

  class Input {
    async getPrimaryVideoTrack() {
      return {
        codec: "avc",
        getDecoderConfig: async () => ({ codec: "avc1.42001f" }),
      };
    }

    async dispose() {}
  }

  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }

  class Output {
    addVideoTrack() {}
    addAudioTrack() {}
    cancel = outputCancel;
    finalize = outputFinalize;
    start = outputStart;
  }

  class EncodedVideoPacketSource {
    async add() {}
  }

  class EncodedPacketSink {
    async *packets() {}
  }

  class AudioBufferSource {
    add = audioAdd;
  }

  return {
    muxResources: {
      audioAdd,
      outputCancel,
      outputFinalize,
      outputStart,
    },
    mediabunny: {
      Input,
      BlobSource: class BlobSource {},
      ALL_FORMATS: [],
      Output,
      Mp4OutputFormat: class Mp4OutputFormat {},
      BufferTarget,
      EncodedVideoPacketSource,
      EncodedPacketSink,
      AudioBufferSource,
      getFirstEncodableAudioCodec: vi.fn(async () => "aac"),
      QUALITY_HIGH: 1,
    },
  };
});

vi.mock("mediabunny", () => mediabunny);

interface AudioFallbackModule {
  assembleClipAudio?: (
    faceCamPath: string | undefined,
    clips: readonly [],
    duration: number,
    onWarning: (message: string) => void,
    abortSignal?: AbortSignal
  ) => Promise<AudioBuffer | null>;
  finalizeExportAudio?: (input: {
    videoResult: { url: string; blob: Blob };
    audioBuffer: AudioBuffer | null;
    fps: number;
    warnings: string[];
    download: boolean;
    fileName: string;
    abortSignal?: AbortSignal;
  }) => Promise<{ url: string; blob: Blob; warnings: string[] }>;
}

function installSavePicker() {
  const write = vi.fn(async () => undefined);
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({
      createWritable: async () => ({
        write,
        close: async () => undefined,
      }),
    })),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  return write;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  muxResources.audioAdd.mockReset().mockResolvedValue(undefined);
  muxResources.outputCancel.mockReset().mockResolvedValue(undefined);
  muxResources.outputFinalize.mockReset().mockResolvedValue(undefined);
  muxResources.outputStart.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("export audio fallbacks", () => {
  test("does not turn cancellation into an audio warning", async () => {
    vi.stubGlobal("AudioBuffer", undefined);
    const exportModule = (await import(
      "@/lib/repurpose/export-short"
    )) as AudioFallbackModule;
    const controller = new AbortController();
    const warnings: string[] = [];
    controller.abort();

    await expect(
      exportModule.assembleClipAudio?.(
        "/api/repurpose/video?path=face.mp4",
        [],
        3,
        (warning) => warnings.push(warning),
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(warnings).toEqual([]);
  });

  test("warns when narration/source audio cannot be decoded", async () => {
    vi.stubGlobal("AudioBuffer", undefined);
    const exportModule = (await import(
      "@/lib/repurpose/export-short"
    )) as AudioFallbackModule;
    expect(exportModule.assembleClipAudio).toBeTypeOf("function");
    if (!exportModule.assembleClipAudio) return;
    const warnings: string[] = [];

    const audio = await exportModule.assembleClipAudio(
      "/api/repurpose/video?path=face.mp4",
      [],
      3,
      (warning) => warnings.push(warning)
    );

    expect(audio).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/narration|source audio/i);
  });

  test("downloads the video-only blob and warns when no audio buffer exists", async () => {
    const write = installSavePicker();
    const exportModule = (await import(
      "@/lib/repurpose/export-short"
    )) as AudioFallbackModule;
    expect(exportModule.finalizeExportAudio).toBeTypeOf("function");
    if (!exportModule.finalizeExportAudio) return;
    const videoBlob = new Blob(["video"], { type: "video/mp4" });

    const result = await exportModule.finalizeExportAudio({
      videoResult: { url: "blob:video-only", blob: videoBlob },
      audioBuffer: null,
      fps: 30,
      warnings: [],
      download: true,
      fileName: "silent.mp4",
    });

    expect(write).toHaveBeenCalledWith(videoBlob);
    expect(result.blob).toBe(videoBlob);
    expect(result.warnings.join(" ")).toMatch(/audio|silent/i);
    expect(result.warnings).toEqual([...new Set(result.warnings)]);
  });

  test("cancels audio mux output exactly once when writing audio fails", async () => {
    const write = installSavePicker();
    muxResources.audioAdd.mockRejectedValueOnce(new Error("audio write failed"));
    const exportModule = (await import(
      "@/lib/repurpose/export-short"
    )) as AudioFallbackModule;
    const videoBlob = new Blob(["video"], { type: "video/mp4" });

    const result = await exportModule.finalizeExportAudio!({
      videoResult: { url: "blob:video-only", blob: videoBlob },
      audioBuffer: { numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer,
      fps: 30,
      warnings: [],
      download: true,
      fileName: "mux-failed.mp4",
    });

    expect(write).toHaveBeenCalledWith(videoBlob);
    expect(result.warnings.join(" ")).toMatch(/audio|silent/i);
    expect(muxResources.outputCancel).toHaveBeenCalledOnce();
    expect(muxResources.outputFinalize).not.toHaveBeenCalled();
  });

  test("cancels audio mux output exactly once when aborted after start", async () => {
    const write = installSavePicker();
    const controller = new AbortController();
    muxResources.outputStart.mockImplementationOnce(async () => {
      controller.abort();
    });
    const exportModule = (await import(
      "@/lib/repurpose/export-short"
    )) as AudioFallbackModule;

    await expect(
      exportModule.finalizeExportAudio!({
        videoResult: {
          url: "blob:video-only",
          blob: new Blob(["video"], { type: "video/mp4" }),
        },
        audioBuffer: { numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer,
        fps: 30,
        warnings: [],
        download: true,
        fileName: "mux-aborted.mp4",
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(write).not.toHaveBeenCalled();
    expect(muxResources.outputCancel).toHaveBeenCalledOnce();
    expect(muxResources.outputFinalize).not.toHaveBeenCalled();
  });

  test("downloads the video-only blob and warns when mux output is absent", async () => {
    const write = installSavePicker();
    const exportModule = (await import(
      "@/lib/repurpose/export-short"
    )) as AudioFallbackModule;
    expect(exportModule.finalizeExportAudio).toBeTypeOf("function");
    if (!exportModule.finalizeExportAudio) return;
    const videoBlob = new Blob(["video"], { type: "video/mp4" });
    const fakeAudio = {
      numberOfChannels: 1,
      sampleRate: 48_000,
    } as AudioBuffer;

    const result = await exportModule.finalizeExportAudio({
      videoResult: { url: "blob:video-only", blob: videoBlob },
      audioBuffer: fakeAudio,
      fps: 30,
      warnings: [],
      download: true,
      fileName: "mux-missing.mp4",
    });

    expect(write).toHaveBeenCalledWith(videoBlob);
    expect(result.blob).toBe(videoBlob);
    expect(result.warnings.join(" ")).toMatch(/audio|silent/i);
    expect(result.warnings).toEqual([...new Set(result.warnings)]);
    expect(muxResources.outputFinalize).toHaveBeenCalledOnce();
    expect(muxResources.outputCancel).not.toHaveBeenCalled();
  });

  test("does not download or warn when audio finalization is cancelled", async () => {
    const write = installSavePicker();
    const exportModule = (await import(
      "@/lib/repurpose/export-short"
    )) as AudioFallbackModule;
    const controller = new AbortController();
    controller.abort();

    await expect(
      exportModule.finalizeExportAudio?.({
        videoResult: {
          url: "blob:video-only",
          blob: new Blob(["video"], { type: "video/mp4" }),
        },
        audioBuffer: null,
        fps: 30,
        warnings: [],
        download: true,
        fileName: "cancelled.mp4",
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(write).not.toHaveBeenCalled();
  });
});
