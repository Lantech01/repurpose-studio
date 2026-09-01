import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { FilesPanel } from "@/app/repurpose-studio/_components/FilesPanel";
import { overlayAABBNorm } from "@/lib/repurpose/overlay-geometry";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  VideoImportError,
  type ImportVideoOptions,
} from "@/lib/repurpose/video-import-client";
import type { Clip, VideoSourceRecord } from "@/lib/repurpose/types";

const source: VideoSourceRecord = {
  originalPath: "C:\\media\\library.mov",
  workingPath: "C:\\cache\\library.mp4",
  originalName: "library.mov",
  inspection: {
    fingerprint: "b".repeat(64),
    container: "mov,mp4",
    extension: ".mov",
    size: 2048,
    durationSec: 9.75,
    video: {
      codec: "hevc",
      codecTag: "hvc1",
      profile: "Main",
      pixelFormat: "yuv420p",
      width: 2560,
      height: 1440,
      fps: 30,
    },
    audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
  },
  nativeCompatible: false,
  compatibilityStatus: "converted",
};

function picker(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"][multiple]');
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing Files picker");
  return input;
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  importVideoFileMock.mockReset();
  ensureVideoProxyMock.mockReset();
  ensureVideoProxyMock.mockImplementation(async (videoSource) => videoSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FilesPanel video imports", () => {
  it("places media against the active scene endpoint instead of the opposing global split", () => {
    const clip: Clip = {
      id: "face-full",
      kind: "take",
      label: "Face full",
      srcStart: 0,
      srcEnd: 4,
      timelineStart: 0,
      timelineEnd: 4,
      kept: true,
      isKeeperTake: true,
      occurrences: [{ start: 0, end: 4 }],
      keeperIndex: 0,
      splitRatio: 0,
    };
    useRepurposeStore.setState({ clips: [clip], duration: 4, playhead: 2, splitRatio: 1 });
    useRepurposeStore.getState().addMediaAsset({
      kind: "image",
      name: "scene-overlay.png",
      src: "/scene-overlay.png",
      naturalWidth: 400,
      naturalHeight: 300,
    });
    render(<FilesPanel />);

    fireEvent.click(screen.getByText("scene-overlay.png").closest("button")!);

    const added = useRepurposeStore.getState().overlays[0];
    const box = overlayAABBNorm(
      added.transform,
      added.naturalWidth,
      added.naturalHeight,
      { left: 0, top: 0, width: 1080, height: 1920 }
    );
    expect(box.maxY).toBeCloseTo(0, 10);
  });

  it("starts a background proxy after compatibility import and updates only nested previewPath", async () => {
    const ready = { ...source, previewPath: "/preview/library.mp4" };
    importVideoFileMock.mockResolvedValue(source);
    ensureVideoProxyMock.mockResolvedValue(ready);
    const rendered = render(<FilesPanel />);

    fireEvent.change(picker(rendered.container), {
      target: {
        files: [new File(["video"], "library.mov", { type: "video/quicktime" })],
      },
    });

    await waitFor(() => expect(ensureVideoProxyMock).toHaveBeenCalledWith(
      source,
      expect.any(AbortSignal)
    ));
    await waitFor(() =>
      expect(useRepurposeStore.getState().mediaAssets[0].videoSource).toBe(ready)
    );
    expect(useRepurposeStore.getState().mediaAssets[0]).toMatchObject({
      src: `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`,
      sourcePath: source.workingPath,
    });
  });

  it("registers inspection metadata from the library pipeline and preserves videoSource when placed", async () => {
    importVideoFileMock.mockResolvedValue(source);
    const rendered = render(<FilesPanel />);

    fireEvent.change(picker(rendered.container), {
      target: {
        files: [new File(["video"], "library.mov", { type: "video/quicktime" })],
      },
    });

    await screen.findByText("library.mov");
    expect(importVideoFileMock).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ role: "library", signal: expect.any(AbortSignal) })
    );
    expect(useRepurposeStore.getState().mediaAssets[0]).toMatchObject({
      kind: "video",
      src: `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`,
      sourcePath: source.workingPath,
      videoSource: source,
      naturalWidth: 2560,
      naturalHeight: 1440,
      srcDuration: 9.75,
    });

    fireEvent.click(screen.getByText("library.mov").closest("button")!);
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      sourcePath: source.workingPath,
      videoSource: source,
    });
  });

  it("shows conversion progress and cancels without turning cancellation into an error", async () => {
    let options!: ImportVideoOptions;
    importVideoFileMock.mockImplementation(
      (_file: File, nextOptions: ImportVideoOptions) => {
        options = nextOptions;
        return new Promise((_resolve, reject) => {
          nextOptions.signal.addEventListener("abort", () => {
            nextOptions.onProgress({ phase: "cancelled", progress: null });
            reject(new VideoImportError("VIDEO_IMPORT_CANCELLED"));
          });
        });
      }
    );
    const rendered = render(<FilesPanel />);
    fireEvent.change(picker(rendered.container), {
      target: {
        files: [new File(["video"], "library.mov", { type: "video/quicktime" })],
      },
    });
    await waitFor(() => expect(options).toBeDefined());

    options.onProgress({ phase: "converting", progress: 0.3 });
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar conversão" }));

    expect(options.signal.aborted).toBe(true);
    expect(await screen.findByText("Importação cancelada.")).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível importar o vídeo.")).toBeNull();
  });

  it("surfaces concise compatibility failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    importVideoFileMock.mockRejectedValue(
      new VideoImportError("COMPATIBILITY_ENCODE_FAILED", {
        path: "C:\\secret\\library.mov",
      })
    );
    const rendered = render(<FilesPanel />);

    fireEvent.change(picker(rendered.container), {
      target: {
        files: [new File(["video"], "library.mov", { type: "video/quicktime" })],
      },
    });

    expect(
      await screen.findByText("Não foi possível converter o vídeo.")
    ).toBeInTheDocument();
    expect(rendered.container.textContent).not.toContain("secret");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps an earlier video failure visible after a later video succeeds", async () => {
    importVideoFileMock
      .mockRejectedValueOnce(
        new VideoImportError("COMPATIBILITY_ENCODE_FAILED", {
          path: "C:\\secret\\bad.mov",
        })
      )
      .mockImplementationOnce(
        async (_file: File, options: ImportVideoOptions) => {
          options.onProgress({ phase: "ready", progress: 1 });
          return source;
        }
      );
    const rendered = render(<FilesPanel />);

    fireEvent.change(picker(rendered.container), {
      target: {
        files: [
          new File(["bad"], "bad.mov", { type: "video/quicktime" }),
          new File(["good"], "good.mov", { type: "video/quicktime" }),
        ],
      },
    });

    await screen.findByText("good.mov");
    expect(useRepurposeStore.getState().mediaAssets).toHaveLength(1);
    expect(screen.getByText("Não foi possível converter o vídeo.")).toBeInTheDocument();
    expect(rendered.container.textContent).not.toContain("secret");
  });

  it("keeps cancellation final when an aborted later video resolves", async () => {
    importVideoFileMock
      .mockRejectedValueOnce(
        new VideoImportError("COMPATIBILITY_ENCODE_FAILED")
      )
      .mockImplementationOnce(
        (_file: File, options: ImportVideoOptions) =>
          new Promise<VideoSourceRecord>((resolve) => {
            options.onProgress({ phase: "converting", progress: 0.4 });
            options.signal.addEventListener("abort", () => {
              options.onProgress({ phase: "cancelled", progress: null });
              resolve(source);
            });
          })
      );
    const rendered = render(<FilesPanel />);
    fireEvent.change(picker(rendered.container), {
      target: {
        files: [
          new File(["bad"], "bad.mov", { type: "video/quicktime" }),
          new File(["cancel"], "cancel.mov", { type: "video/quicktime" }),
        ],
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Cancelar conversão" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
    });

    expect(screen.getByText("Importação cancelada.")).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível converter o vídeo.")).toBeNull();
  });

  it("rejects add-by-path videos with guidance to use the compatibility picker", async () => {
    render(<FilesPanel />);

    fireEvent.change(screen.getByLabelText("Add media by file path"), {
      target: { value: "C:\\media\\library.MKV" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add media by path" }));

    expect(
      await screen.findByText(
        "Para importar vídeos, use o seletor de arquivos para verificar a compatibilidade."
      )
    ).toBeInTheDocument();
    expect(importVideoFileMock).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState().mediaAssets).toEqual([]);
  });

  it("aborts a replaced image batch and ignores its late completion", async () => {
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
    const requests: Array<{
      resolve: (response: Response) => void;
      signal?: AbortSignal;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({ resolve, signal: init?.signal ?? undefined });
        })
      )
    );
    const rendered = render(<FilesPanel />);

    fireEvent.change(picker(rendered.container), {
      target: { files: [new File(["first"], "first.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.change(picker(rendered.container), {
      target: { files: [new File(["second"], "second.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    expect(requests[0].signal?.aborted).toBe(true);
    await act(async () => {
      requests[1].resolve(
        new Response(JSON.stringify({ ok: true, path: "C:\\media\\second.png" }))
      );
    });
    await screen.findByText("second.png");
    await act(async () => {
      requests[0].resolve(
        new Response(JSON.stringify({ ok: true, path: "C:\\media\\first.png" }))
      );
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState().mediaAssets).toHaveLength(1);
    expect(useRepurposeStore.getState().mediaAssets[0].name).toBe("second.png");
  });

  it("aborts an audio probe on unmount and suppresses its late store write", async () => {
    let audio!: {
      duration: number;
      onloadedmetadata: (() => void) | null;
    };
    class PendingAudio {
      duration = 4;
      preload = "";
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        audio = this;
      }
    }
    vi.stubGlobal("Audio", PendingAudio);
    let uploadSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        uploadSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, path: "C:\\media\\voice.wav" }))
        );
      })
    );
    const rendered = render(<FilesPanel />);
    fireEvent.change(picker(rendered.container), {
      target: { files: [new File(["audio"], "voice.wav", { type: "audio/wav" })] },
    });
    await waitFor(() => expect(audio).toBeDefined());

    rendered.unmount();
    expect(uploadSignal?.aborted).toBe(true);
    await act(async () => {
      audio.onloadedmetadata?.();
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState().mediaAssets).toEqual([]);
  });

  it("does not register a file whose upload resolves after project reset", async () => {
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
    let resolveUpload!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveUpload = resolve;
          })
      )
    );
    const rendered = render(<FilesPanel />);
    fireEvent.change(picker(rendered.container), {
      target: { files: [new File(["old"], "old.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(resolveUpload).toBeDefined());

    act(() => useRepurposeStore.getState().resetProject());
    await act(async () => {
      resolveUpload(
        new Response(JSON.stringify({ ok: true, path: "C:\\media\\old.png" }))
      );
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState().mediaAssets).toEqual([]);
  });
});
