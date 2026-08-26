import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { importVideoFileMock, ensureVideoProxyMock } = vi.hoisted(() => ({
  importVideoFileMock: vi.fn(),
  ensureVideoProxyMock: vi.fn(),
}));

vi.mock("@/lib/repurpose/video-import-client", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/repurpose/video-import-client")
  >();
  return { ...original, importVideoFile: importVideoFileMock };
});
vi.mock("@/lib/repurpose/video-proxy-client", () => ({
  ensureVideoProxy: ensureVideoProxyMock,
}));

import {
  cancelOverlayImport,
  clearOverlayImport,
  ingestOverlayFile,
  ingestOverlayFiles,
  registerOverlayImportOwner,
  releaseOverlayImportOwner,
  subscribeOverlayImport,
  surfaceOverlayImportError,
} from "@/lib/repurpose/overlay-ingest";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  VideoImportError,
  type ImportVideoOptions,
} from "@/lib/repurpose/video-import-client";
import type { VideoSourceRecord } from "@/lib/repurpose/types";

const source: VideoSourceRecord = {
  originalPath: "C:\\media\\clip.mov",
  workingPath: "C:\\cache\\clip.mp4",
  originalName: "clip.mov",
  inspection: {
    fingerprint: "a".repeat(64),
    container: "mov,mp4",
    extension: ".mov",
    size: 1024,
    durationSec: 8.5,
    video: {
      codec: "hevc",
      codecTag: "hvc1",
      profile: "Main",
      pixelFormat: "yuv420p",
      width: 1920,
      height: 1080,
      fps: 29.97,
    },
    audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
  },
  nativeCompatible: false,
  compatibilityStatus: "converted",
};

beforeEach(() => {
  clearOverlayImport();
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  importVideoFileMock.mockReset();
  ensureVideoProxyMock.mockReset();
  ensureVideoProxyMock.mockImplementation(async (videoSource) => videoSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("overlay ingest compatibility pipeline", () => {
  it("starts one background proxy and applies it to overlay and media-bin records only", async () => {
    const ready = { ...source, previewPath: "/preview/overlay.mp4" };
    importVideoFileMock.mockResolvedValue(source);
    ensureVideoProxyMock.mockResolvedValue(ready);

    await ingestOverlayFile(
      new File(["video"], "clip.mov", { type: "video/quicktime" }),
      2
    );

    await vi.waitFor(() =>
      expect(ensureVideoProxyMock).toHaveBeenCalledWith(
        source,
        expect.any(AbortSignal)
      )
    );
    await vi.waitFor(() => {
      expect(useRepurposeStore.getState().overlays[0].videoSource).toBe(ready);
      expect(useRepurposeStore.getState().mediaAssets[0].videoSource).toBe(ready);
    });
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      src: `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`,
      sourcePath: source.workingPath,
    });
  });

  it("imports videos once and persists the authoritative working source on overlay and asset", async () => {
    importVideoFileMock.mockResolvedValue(source);

    const result = await ingestOverlayFile(
      new File(["video"], "clip.mov", { type: "video/quicktime" }),
      2
    );

    expect(importVideoFileMock).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ role: "overlay", signal: expect.any(AbortSignal) })
    );
    expect(result).toMatchObject({ needsReconnect: false });
    const state = useRepurposeStore.getState();
    expect(state.overlays[0]).toMatchObject({
      src: `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`,
      sourcePath: source.workingPath,
      videoSource: source,
      naturalWidth: 1920,
      naturalHeight: 1080,
      srcDuration: 8.5,
    });
    expect(state.mediaAssets[0]).toMatchObject({
      sourcePath: source.workingPath,
      videoSource: source,
    });
  });

  it.each(["mov", "mp4", "m4v", "webm", "mkv"])(
    "classifies an empty-MIME .%s file as video",
    async (extension) => {
      importVideoFileMock.mockResolvedValue(source);

      const result = await ingestOverlayFile(
        new File(["video"], `clip.${extension.toUpperCase()}`, { type: "" }),
        0
      );

      expect(result).not.toBeNull();
      expect(importVideoFileMock).toHaveBeenCalledWith(
        expect.any(File),
        expect.objectContaining({ role: "overlay" })
      );
    }
  );

  it("keeps images on the lightweight asset route without invoking video import", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:image"),
      revokeObjectURL,
    });
    class LoadedImage {
      naturalWidth = 640;
      naturalHeight = 360;
      onload: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, path: "C:\\media\\still.png" }))
      )
    );

    await ingestOverlayFile(
      new File(["image"], "still.PNG", { type: "" }),
      0
    );

    expect(importVideoFileMock).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      kind: "image",
      src: `/api/repurpose/asset?path=${encodeURIComponent("C:\\media\\still.png")}`,
      sourcePath: "C:\\media\\still.png",
      naturalWidth: 640,
      naturalHeight: 360,
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image");
  });

  it("publishes conversion progress, exposes cancellation, and preserves typed cancellation", async () => {
    let options!: ImportVideoOptions;
    importVideoFileMock.mockImplementation(
      (_file: File, nextOptions: ImportVideoOptions) => {
        options = nextOptions;
        return new Promise((_resolve, reject) => {
          nextOptions.signal.addEventListener("abort", () => {
            reject(new VideoImportError("VIDEO_IMPORT_CANCELLED"));
          });
        });
      }
    );
    const states: Array<{ phase: string; error?: string }> = [];
    const unsubscribe = subscribeOverlayImport((state) => {
      if (state) states.push(state);
    });
    const importing = ingestOverlayFile(
      new File(["video"], "clip.mov", { type: "video/quicktime" }),
      0
    );
    await vi.waitFor(() => expect(options).toBeDefined());

    options.onProgress({ phase: "converting", progress: 0.4 });
    cancelOverlayImport();

    await expect(importing).rejects.toMatchObject({
      code: "VIDEO_IMPORT_CANCELLED",
    });
    expect(options.signal.aborted).toBe(true);
    expect(states).toContainEqual(
      expect.objectContaining({ phase: "converting" })
    );
    expect(states.at(-1)).toMatchObject({ phase: "cancelled" });
    unsubscribe();
  });

  it("does not turn caller-surfaced cancellation into an error", async () => {
    let options!: ImportVideoOptions;
    importVideoFileMock.mockImplementation(
      (_file: File, nextOptions: ImportVideoOptions) => {
        options = nextOptions;
        return new Promise((_resolve, reject) => {
          nextOptions.signal.addEventListener("abort", () => {
            reject(new VideoImportError("VIDEO_IMPORT_CANCELLED"));
          });
        });
      }
    );
    const states: Array<{ phase: string; error?: string }> = [];
    const unsubscribe = subscribeOverlayImport((state) => {
      if (state) states.push(state);
    });
    const importing = ingestOverlayFile(
      new File(["video"], "clip.mov", { type: "video/quicktime" }),
      0
    ).catch(surfaceOverlayImportError);
    await vi.waitFor(() => expect(options).toBeDefined());

    cancelOverlayImport();
    await importing;

    expect(states.at(-1)).toMatchObject({ phase: "cancelled" });
    unsubscribe();
  });

  it("publishes concise conversion errors and returns them to the caller", async () => {
    importVideoFileMock.mockRejectedValue(
      new VideoImportError("COMPATIBILITY_ENCODE_FAILED", {
        command: "ffmpeg C:\\secret\\clip.mov",
      })
    );
    const states: Array<{ phase: string; error?: string }> = [];
    const unsubscribe = subscribeOverlayImport((state) => {
      if (state) states.push(state);
    });

    await expect(
      ingestOverlayFile(
        new File(["video"], "clip.mov", { type: "video/quicktime" }),
        0
      )
    ).rejects.toMatchObject({ code: "COMPATIBILITY_ENCODE_FAILED" });

    expect(states.at(-1)).toEqual({
      phase: "error",
      progress: null,
      error: "Não foi possível converter o vídeo.",
    });
    expect(JSON.stringify(states)).not.toContain("secret");
    unsubscribe();
  });

  it("returns a typed video failure from the shared multi-file picker path", async () => {
    importVideoFileMock.mockRejectedValue(
      new VideoImportError("COMPATIBILITY_VALIDATION_FAILED")
    );

    await expect(
      ingestOverlayFiles(
        [new File(["video"], "clip.mov", { type: "video/quicktime" })],
        0
      )
    ).rejects.toMatchObject({ code: "COMPATIBILITY_VALIDATION_FAILED" });
  });

  it("publishes the earlier failure after a later video succeeds", async () => {
    importVideoFileMock
      .mockRejectedValueOnce(
        new VideoImportError("COMPATIBILITY_ENCODE_FAILED", {
          command: "ffmpeg C:\\secret\\first.mov",
        })
      )
      .mockImplementationOnce(
        async (_file: File, options: ImportVideoOptions) => {
          options.onProgress({ phase: "ready", progress: 1 });
          return source;
        }
      );
    const states: Array<{ phase: string; error?: string }> = [];
    const unsubscribe = subscribeOverlayImport((state) => {
      if (state) states.push(state);
    });

    await expect(
      ingestOverlayFiles(
        [
          new File(["first"], "first.mov", { type: "video/quicktime" }),
          new File(["second"], "second.mov", { type: "video/quicktime" }),
        ],
        0
      )
    ).rejects.toMatchObject({ code: "COMPATIBILITY_ENCODE_FAILED" });

    expect(useRepurposeStore.getState().overlays).toHaveLength(1);
    expect(states.at(-1)).toEqual({
      phase: "error",
      progress: null,
      error: "Não foi possível converter o vídeo.",
    });
    expect(JSON.stringify(states.at(-1))).not.toContain("secret");
    unsubscribe();
  });

  it("stops a multi-file sequence after cancellation without logging it as a generic error", async () => {
    importVideoFileMock.mockRejectedValueOnce(
      new VideoImportError("VIDEO_IMPORT_CANCELLED")
    );

    await expect(
      ingestOverlayFiles(
        [
          new File(["first"], "first.mov", { type: "video/quicktime" }),
          new File(["second"], "second.mov", { type: "video/quicktime" }),
        ],
        0
      )
    ).resolves.toEqual([]);
    expect(importVideoFileMock).toHaveBeenCalledTimes(1);
  });

  it("clears completed overlay progress between editor lifecycles", async () => {
    importVideoFileMock.mockResolvedValue(source);
    await ingestOverlayFile(
      new File(["video"], "clip.mov", { type: "video/quicktime" }),
      0
    );
    clearOverlayImport();
    const listener = vi.fn();

    const unsubscribe = subscribeOverlayImport(listener);

    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });

  it("does not republish cancellation after an active lifecycle is cleared", async () => {
    importVideoFileMock.mockImplementation(
      (_file: File, options: ImportVideoOptions) =>
        new Promise<VideoSourceRecord>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new VideoImportError("VIDEO_IMPORT_CANCELLED"));
          });
        })
    );
    const importing = ingestOverlayFile(
      new File(["video"], "clip.mov", { type: "video/quicktime" }),
      0
    );

    cancelOverlayImport();
    clearOverlayImport();
    await expect(importing).rejects.toMatchObject({
      code: "VIDEO_IMPORT_CANCELLED",
    });
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayImport(listener);

    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });

  it("lets a newer video supersede an image probe without a stale overlay write", async () => {
    let pendingImage!: {
      onload: (() => void) | null;
    };
    class PendingImage {
      naturalWidth = 640;
      naturalHeight = 360;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        pendingImage = this;
      }
      set src(_value: string) {}
    }
    vi.stubGlobal("Image", PendingImage);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:stale-image"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, path: "C:\\media\\stale.png" }))
      )
    );
    importVideoFileMock.mockResolvedValue(source);

    const staleImage = ingestOverlayFile(
      new File(["image"], "stale.png", { type: "image/png" }),
      0
    ).catch((error) => error);
    await vi.waitFor(() => expect(pendingImage).toBeDefined());
    await ingestOverlayFile(
      new File(["video"], "latest.mov", { type: "video/quicktime" }),
      0
    );
    pendingImage.onload?.();
    await staleImage;

    expect(useRepurposeStore.getState().overlays).toHaveLength(1);
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      kind: "video",
      sourcePath: source.workingPath,
    });
  });

  it("lets a newer image supersede a video that resolves after abort", async () => {
    let resolveVideo!: (value: VideoSourceRecord) => void;
    let videoOptions!: ImportVideoOptions;
    importVideoFileMock.mockImplementation(
      (_file: File, options: ImportVideoOptions) => {
        videoOptions = options;
        return new Promise<VideoSourceRecord>((resolve) => {
          resolveVideo = resolve;
        });
      }
    );
    class LoadedImage {
      naturalWidth = 320;
      naturalHeight = 180;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:latest-image"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, path: "C:\\media\\latest.png" }))
      )
    );

    const staleVideo = ingestOverlayFile(
      new File(["video"], "stale.mov", { type: "video/quicktime" }),
      0
    ).catch((error) => error);
    await vi.waitFor(() => expect(videoOptions).toBeDefined());
    await ingestOverlayFile(
      new File(["image"], "latest.png", { type: "image/png" }),
      0
    );
    expect(videoOptions.signal.aborted).toBe(true);
    resolveVideo(source);
    await staleVideo;

    expect(useRepurposeStore.getState().overlays).toHaveLength(1);
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      kind: "image",
      sourcePath: "C:\\media\\latest.png",
    });
  });

  it("invalidates an image import on clear and ignores its late completion", async () => {
    let pendingImage!: { onload: (() => void) | null };
    class PendingImage {
      naturalWidth = 640;
      naturalHeight = 360;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        pendingImage = this;
      }
      set src(_value: string) {}
    }
    vi.stubGlobal("Image", PendingImage);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:cleared-image"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, path: "C:\\media\\cleared.png" }))
      )
    );

    const importing = ingestOverlayFile(
      new File(["image"], "cleared.png", { type: "image/png" }),
      0
    ).catch((error) => error);
    await vi.waitFor(() => expect(pendingImage).toBeDefined());
    clearOverlayImport();
    pendingImage.onload?.();
    await importing;

    expect(useRepurposeStore.getState().overlays).toEqual([]);
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayImport(listener);
    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });

  it("aborts an image upload on clear and ignores a late response", async () => {
    class LoadedImage {
      naturalWidth = 640;
      naturalHeight = 360;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:upload-image"),
      revokeObjectURL: vi.fn(),
    });
    let resolveUpload!: (response: Response) => void;
    let uploadSignal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        uploadSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      })
    );

    const importing = ingestOverlayFile(
      new File(["image"], "upload.png", { type: "image/png" }),
      0
    ).catch((error) => error);
    await vi.waitFor(() => expect(uploadSignal).toBeDefined());
    clearOverlayImport();
    expect(uploadSignal.aborted).toBe(true);
    resolveUpload(
      new Response(JSON.stringify({ ok: true, path: "C:\\media\\upload.png" }))
    );
    await importing;

    expect(useRepurposeStore.getState().overlays).toEqual([]);
    const listener = vi.fn();
    const unsubscribe = subscribeOverlayImport(listener);
    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });

  it("publishes one central error for a corrupt image while active", async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:broken-image"),
      revokeObjectURL: vi.fn(),
    });
    const states: Array<{ phase: string; error?: string } | null> = [];
    const unsubscribe = subscribeOverlayImport((state) => states.push(state));

    await expect(
      ingestOverlayFile(
        new File(["broken"], "broken.png", { type: "image/png" }),
        0
      )
    ).rejects.toThrow("Could not decode that image");

    expect(states.filter((state) => state?.phase === "error")).toEqual([
      {
        phase: "error",
        progress: null,
        error: "Não foi possível importar uma ou mais mídias.",
      },
    ]);
    unsubscribe();
  });

  it("publishes a batch failure exactly once", async () => {
    importVideoFileMock
      .mockRejectedValueOnce(new VideoImportError("COMPATIBILITY_ENCODE_FAILED"))
      .mockResolvedValueOnce(source);
    const states: Array<{ phase: string; error?: string } | null> = [];
    const unsubscribe = subscribeOverlayImport((state) => states.push(state));

    await expect(
      ingestOverlayFiles(
        [
          new File(["bad"], "bad.mov", { type: "video/quicktime" }),
          new File(["good"], "good.mov", { type: "video/quicktime" }),
        ],
        0
      )
    ).rejects.toMatchObject({ code: "COMPATIBILITY_ENCODE_FAILED" });

    expect(states.filter((state) => state?.phase === "error")).toHaveLength(1);
    unsubscribe();
  });

  it("does not let a stale editor release cancel or clear a newer owner", async () => {
    const options: ImportVideoOptions[] = [];
    const resolvers: Array<(value: VideoSourceRecord) => void> = [];
    importVideoFileMock.mockImplementation(
      (_file: File, nextOptions: ImportVideoOptions) => {
        options.push(nextOptions);
        return new Promise<VideoSourceRecord>((resolve) => {
          resolvers.push(resolve);
        });
      }
    );
    const oldOwner = registerOverlayImportOwner();
    const oldImport = ingestOverlayFile(
      new File(["old"], "old.mov", { type: "video/quicktime" }),
      0,
      undefined,
      oldOwner
    ).catch((error) => error);
    await vi.waitFor(() => expect(options).toHaveLength(1));

    const newOwner = registerOverlayImportOwner();
    expect(options[0].signal.aborted).toBe(true);
    const newStates: Array<{ phase: string; progress: number | null } | null> = [];
    const unsubscribe = subscribeOverlayImport(
      (state) => newStates.push(state),
      newOwner
    );
    const newImport = ingestOverlayFile(
      new File(["new"], "new.mov", { type: "video/quicktime" }),
      0,
      undefined,
      newOwner
    );
    await vi.waitFor(() => expect(options).toHaveLength(2));
    options[1].onProgress({ phase: "converting", progress: 0.4 });

    releaseOverlayImportOwner(oldOwner);
    expect(options[1].signal.aborted).toBe(false);
    expect(newStates.at(-1)).toMatchObject({
      phase: "converting",
      progress: 0.4,
    });

    resolvers[1](source);
    await newImport;
    resolvers[0](source);
    await oldImport;
    expect(useRepurposeStore.getState().overlays).toHaveLength(1);
    unsubscribe();
    releaseOverlayImportOwner(newOwner);
  });

  it("does not write an overlay import that resolves after project reset", async () => {
    let resolveVideo!: (value: VideoSourceRecord) => void;
    importVideoFileMock.mockImplementation(
      () =>
        new Promise<VideoSourceRecord>((resolve) => {
          resolveVideo = resolve;
        })
    );
    const importing = ingestOverlayFile(
      new File(["old"], "old.mov", { type: "video/quicktime" }),
      0
    ).catch((error) => error);
    await vi.waitFor(() => expect(resolveVideo).toBeDefined());

    useRepurposeStore.getState().resetProject();
    resolveVideo(source);
    await importing;

    expect(useRepurposeStore.getState().overlays).toEqual([]);
    expect(useRepurposeStore.getState().mediaAssets).toEqual([]);
  });
});
