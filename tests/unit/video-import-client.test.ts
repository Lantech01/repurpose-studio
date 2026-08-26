import { describe, expect, it, vi } from "vitest";

import {
  VideoImportError,
  createVideoImportClient,
  videoImportMessageForCode,
  videoUrlForWorkingSource,
} from "@/lib/repurpose/video-import-client";
import type {
  MediaInspection,
  UploadedVideo,
} from "@/lib/repurpose/media-types";
import type { VideoImportPhase } from "@/lib/repurpose/types";

const fingerprint = "a".repeat(64);

function inspection(codec = "h264"): MediaInspection {
  return {
    fingerprint,
    container: "mov,mp4",
    extension: codec === "h264" ? ".mp4" : ".mov",
    size: 1_024,
    durationSec: 3,
    video: {
      codec,
      codecTag: codec === "h264" ? "avc1" : "hvc1",
      profile: "Main",
      pixelFormat: "yuv420p",
      width: 320,
      height: 180,
      fps: 30,
    },
    audio: { codec: "aac", channels: 1, sampleRate: 48_000 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeXhr {
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseType: XMLHttpRequestResponseType = "";
  response: unknown = null;
  responseText = "";
  status = 0;
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  autoComplete = true;
  progress: Array<{ loaded: number; total: number }> = [];

  open = vi.fn((method: string, url: string) => {
    this.method = method;
    this.url = url;
  });

  send = vi.fn((body: Document | XMLHttpRequestBodyInit | null) => {
    this.body = body;
    for (const progress of this.progress) {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: progress.loaded,
        total: progress.total,
      } as ProgressEvent);
    }
    if (this.autoComplete) queueMicrotask(() => this.onload?.());
  });

  abort = vi.fn(() => this.onabort?.());
}

function uploaded(originalPath = "C:\\media\\original.mp4"): UploadedVideo {
  return {
    originalPath,
    contentHash: "b".repeat(64),
    size: 1_024,
    name: "original.mp4",
  };
}

function uploadXhr(result = uploaded()): FakeXhr {
  const xhr = new FakeXhr();
  xhr.status = 200;
  xhr.response = result;
  return xhr;
}

function phasesOf(
  progress: Array<{ phase: VideoImportPhase; progress: number | null }>
): VideoImportPhase[] {
  return progress.map((state) => state.phase);
}

describe("video import orchestration", () => {
  it("keeps a browser-decodable H.264 original as the working source", async () => {
    const events: Array<{ phase: VideoImportPhase; progress: number | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      expect(String(input)).toContain("/api/repurpose/media?path=");
      return jsonResponse(inspection());
    });
    const client = createVideoImportClient({
      createXhr: () => uploadXhr() as unknown as XMLHttpRequest,
      fetch: fetcher,
      probeBrowserVideo: vi.fn().mockResolvedValue({
        decodable: true,
        durationSec: 3,
        width: 320,
        height: 180,
      }),
      wait: vi.fn(),
    });

    const source = await client.importVideoFile(
      new File(["video"], "original.mp4", { type: "video/mp4" }),
      {
        role: "face",
        signal: new AbortController().signal,
        onProgress: (state) => events.push(state),
      }
    );

    expect(phasesOf(events)).toEqual([
      "copying",
      "inspecting",
      "checking-browser",
      "ready",
    ]);
    expect(source).toMatchObject({
      originalPath: "C:\\media\\original.mp4",
      workingPath: "C:\\media\\original.mp4",
      originalName: "original.mp4",
      nativeCompatible: true,
      compatibilityStatus: "native",
      inspection: inspection(),
    });
    expect(
      fetcher.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/api/repurpose/compatibility") &&
          init?.method === "POST"
      )
    ).toBe(false);
  });

  it("converts a 0x0 browser result and probes the validated master again", async () => {
    const events: Array<{ phase: VideoImportPhase; progress: number | null }> = [];
    const masterPath = "C:\\cache\\master.mp4";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/repurpose/media?")) {
        return jsonResponse(inspection("hevc"));
      }
      if (url.endsWith("/api/repurpose/compatibility") && init?.method === "POST") {
        return jsonResponse({
          status: "ready",
          progress: 1,
          workingPath: masterPath,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const probe = vi
      .fn()
      .mockResolvedValueOnce({
        decodable: false,
        durationSec: 3,
        width: 0,
        height: 0,
        reason: "invalid-metadata",
      })
      .mockResolvedValueOnce({
        decodable: true,
        durationSec: 3,
        width: 320,
        height: 180,
      });
    const client = createVideoImportClient({
      createXhr: () => uploadXhr(uploaded("C:\\media\\original.mov")) as unknown as XMLHttpRequest,
      fetch: fetcher,
      probeBrowserVideo: probe,
      wait: vi.fn(),
    });

    const source = await client.importVideoFile(
      new File(["video"], "original.mov", { type: "video/quicktime" }),
      {
        role: "screen",
        signal: new AbortController().signal,
        onProgress: (state) => events.push(state),
      }
    );

    expect(phasesOf(events)).toEqual([
      "copying",
      "inspecting",
      "checking-browser",
      "converting",
      "checking-browser",
      "ready",
    ]);
    expect(probe).toHaveBeenNthCalledWith(
      2,
      `/api/repurpose/video?path=${encodeURIComponent(masterPath)}`,
      expect.any(AbortSignal)
    );
    expect(source).toMatchObject({
      originalPath: "C:\\media\\original.mov",
      workingPath: masterPath,
      nativeCompatible: false,
      compatibilityStatus: "converted",
    });
  });

  it("fails when the compatibility master still reports decoded 0x0 dimensions", async () => {
    const logger = vi.fn();
    const events: Array<{ phase: VideoImportPhase; progress: number | null }> = [];
    const client = createVideoImportClient({
      createXhr: () => uploadXhr(uploaded("C:\\media\\original.mov")) as unknown as XMLHttpRequest,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/api/repurpose/media?")
          ? jsonResponse(inspection("hevc"))
          : jsonResponse(
              {
                status: "ready",
                progress: 1,
                workingPath: "C:\\cache\\master.mp4",
              },
              init?.method === "POST" ? 200 : 500
            )
      ),
      probeBrowserVideo: vi.fn().mockResolvedValue({
        decodable: false,
        durationSec: 3,
        width: 0,
        height: 0,
        reason: "invalid-metadata",
      }),
      logError: logger,
      wait: vi.fn(),
    });

    await expect(
      client.importVideoFile(
        new File(["video"], "original.mov", { type: "video/quicktime" }),
        {
          role: "overlay",
          signal: new AbortController().signal,
          onProgress: (state) => events.push(state),
        }
      )
    ).rejects.toMatchObject({
      code: "BROWSER_DECODE_FAILED",
      message: "O Chrome não conseguiu abrir o vídeo convertido.",
    });
    expect(phasesOf(events).at(-1)).toBe("error");
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("BROWSER_DECODE_FAILED"),
      expect.anything()
    );
  });

  it("aborts an upload XHR when cancelled during copying", async () => {
    const xhr = uploadXhr();
    xhr.autoComplete = false;
    const aborter = new AbortController();
    const client = createVideoImportClient({
      createXhr: () => xhr as unknown as XMLHttpRequest,
      fetch: vi.fn(),
      probeBrowserVideo: vi.fn(),
      wait: vi.fn(),
    });
    const importing = client.importVideoFile(
      new File(["video"], "original.mp4", { type: "video/mp4" }),
      { role: "library", signal: aborter.signal, onProgress: vi.fn() }
    );

    aborter.abort();

    await expect(importing).rejects.toMatchObject({
      code: "VIDEO_IMPORT_CANCELLED",
    });
    expect(xhr.abort).toHaveBeenCalledTimes(1);
    expect(xhr.upload.onprogress).toBeNull();
    expect(xhr.onload).toBeNull();
    expect(xhr.onerror).toBeNull();
    expect(xhr.onabort).toBeNull();
  });

  it("aborts polling fetch and DELETEs the active fingerprint job", async () => {
    const aborter = new AbortController();
    let pollingSignal: AbortSignal | undefined;
    let markPolling!: () => void;
    const polling = new Promise<void>((resolve) => {
      markPolling = resolve;
    });
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/repurpose/media?")) {
          return jsonResponse(inspection("hevc"));
        }
        if (url.endsWith("/api/repurpose/compatibility") && init?.method === "POST") {
          return jsonResponse({ status: "building", progress: 0.1 }, 202);
        }
        if (url.includes("/api/repurpose/compatibility?")) {
          pollingSignal = init?.signal ?? undefined;
          markPolling();
          return await new Promise<Response>((_resolve, reject) => {
            const cancel = () => reject(new DOMException("Aborted", "AbortError"));
            if (pollingSignal?.aborted) cancel();
            else pollingSignal?.addEventListener("abort", cancel, { once: true });
          });
        }
        if (url.endsWith("/api/repurpose/compatibility") && init?.method === "DELETE") {
          return jsonResponse({ status: "cancelled", progress: null });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const client = createVideoImportClient({
      createXhr: () => uploadXhr(uploaded("C:\\media\\original.mov")) as unknown as XMLHttpRequest,
      fetch: fetcher,
      probeBrowserVideo: vi.fn().mockResolvedValue({
        decodable: false,
        durationSec: 3,
        width: 0,
        height: 0,
      }),
      wait: vi.fn().mockResolvedValue(undefined),
    });
    const importing = client.importVideoFile(
      new File(["video"], "original.mov", { type: "video/quicktime" }),
      { role: "face", signal: aborter.signal, onProgress: vi.fn() }
    );
    await polling;

    aborter.abort();

    await expect(importing).rejects.toMatchObject({
      code: "VIDEO_IMPORT_CANCELLED",
    });
    expect(pollingSignal?.aborted).toBe(true);
    const cancellation = fetcher.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/repurpose/compatibility") &&
        init?.method === "DELETE"
    );
    expect(cancellation).toBeDefined();
    expect(cancellation?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("finishes local cancellation when compatibility DELETE never settles", async () => {
    vi.useFakeTimers();
    try {
      const aborter = new AbortController();
      let pollingStarted!: () => void;
      const polling = new Promise<void>((resolve) => {
        pollingStarted = resolve;
      });
      const fetcher = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = String(input);
          if (url.includes("/api/repurpose/media?")) {
            return jsonResponse(inspection("hevc"));
          }
          if (
            url.endsWith("/api/repurpose/compatibility") &&
            init?.method === "POST"
          ) {
            return jsonResponse({ status: "building", progress: 0.1 }, 202);
          }
          if (url.includes("/api/repurpose/compatibility?")) {
            pollingStarted();
            const signal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
              const cancel = () =>
                reject(new DOMException("Aborted", "AbortError"));
              if (signal?.aborted) cancel();
              else signal?.addEventListener("abort", cancel, { once: true });
            });
          }
          if (
            url.endsWith("/api/repurpose/compatibility") &&
            init?.method === "DELETE"
          ) {
            return new Promise<Response>(() => undefined);
          }
          throw new Error(`Unexpected request: ${url}`);
        }
      );
      const progress: Array<{ phase: VideoImportPhase; progress: number | null }> = [];
      const client = createVideoImportClient({
        createXhr: () =>
          uploadXhr(uploaded("C:\\media\\original.mov")) as unknown as XMLHttpRequest,
        fetch: fetcher,
        probeBrowserVideo: vi.fn().mockResolvedValue({
          decodable: false,
          durationSec: 3,
          width: 0,
          height: 0,
        }),
        wait: vi.fn().mockResolvedValue(undefined),
      });
      let settled = false;
      const importing = client
        .importVideoFile(new File(["video"], "original.mov"), {
          role: "face",
          signal: aborter.signal,
          onProgress: (state) => progress.push(state),
        })
        .catch((error) => {
          settled = true;
          throw error;
        });
      void importing.catch(() => undefined);
      await polling;

      aborter.abort();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(true);
      await expect(importing).rejects.toMatchObject({
        code: "VIDEO_IMPORT_CANCELLED",
      });
      const cancellation = fetcher.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/repurpose/compatibility") &&
          init?.method === "DELETE"
      );
      expect(cancellation?.[1]?.signal?.aborted).toBe(true);
      expect(phasesOf(progress).at(-1)).toBe("cancelled");
      expect(phasesOf(progress)).not.toContain("ready");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["visible", 750],
    ["hidden", 2_000],
  ] as const)(
    "cleans the real %s poll timer when cancelled during its %dms delay",
    async (visibilityState, pollDelay) => {
      vi.useFakeTimers();
      try {
        const aborter = new AbortController();
        let compatibilityStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          compatibilityStarted = resolve;
        });
        const fetcher = vi.fn(
          async (
            input: RequestInfo | URL,
            init?: RequestInit
          ): Promise<Response> => {
            const url = String(input);
            if (url.includes("/api/repurpose/media?")) {
              return jsonResponse(inspection("hevc"));
            }
            if (
              url.endsWith("/api/repurpose/compatibility") &&
              init?.method === "POST"
            ) {
              compatibilityStarted();
              return jsonResponse({ status: "building", progress: 0.1 }, 202);
            }
            if (url.includes("/api/repurpose/compatibility?")) {
              return jsonResponse({
                status: "ready",
                progress: 1,
                workingPath: "C:\\cache\\master.mp4",
              });
            }
            if (
              url.endsWith("/api/repurpose/compatibility") &&
              init?.method === "DELETE"
            ) {
              return jsonResponse({ status: "cancelled", progress: null });
            }
            throw new Error(`Unexpected request: ${url}`);
          }
        );
        const client = createVideoImportClient({
          createXhr: () =>
            uploadXhr(uploaded("C:\\media\\original.mov")) as unknown as XMLHttpRequest,
          fetch: fetcher,
          probeBrowserVideo: vi.fn().mockResolvedValue({
            decodable: false,
            durationSec: 3,
            width: 0,
            height: 0,
          }),
          visibilityState: () => visibilityState,
        });
        const importing = client.importVideoFile(
          new File(["video"], "original.mov", { type: "video/quicktime" }),
          { role: "face", signal: aborter.signal, onProgress: vi.fn() }
        );
        await started;
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(pollDelay - 1);
        expect(
          fetcher.mock.calls.filter(([input]) =>
            String(input).includes("/api/repurpose/compatibility?")
          )
        ).toHaveLength(0);

        aborter.abort();

        await expect(importing).rejects.toMatchObject({
          code: "VIDEO_IMPORT_CANCELLED",
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(
          fetcher.mock.calls.filter(
            ([input, init]) =>
              String(input).endsWith("/api/repurpose/compatibility") &&
              init?.method === "DELETE"
          )
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("keeps phase progress monotonic and uses visible/hidden poll cadences", async () => {
    const xhr = uploadXhr(uploaded("C:\\media\\original.mov"));
    xhr.progress = [
      { loaded: 8, total: 10 },
      { loaded: 4, total: 10 },
    ];
    const states = [
      { status: "building", progress: 0.3 },
      {
        status: "ready",
        progress: 1,
        workingPath: "C:\\cache\\master.mp4",
      },
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/repurpose/media?")) {
        return jsonResponse(inspection("hevc"));
      }
      if (url.endsWith("/api/repurpose/compatibility") && init?.method === "POST") {
        return jsonResponse({ status: "building", progress: 0.7 }, 202);
      }
      return jsonResponse(states.shift());
    });
    const wait = vi.fn().mockResolvedValue(undefined);
    const visibilityState = vi
      .fn<() => DocumentVisibilityState>()
      .mockReturnValueOnce("visible")
      .mockReturnValueOnce("hidden");
    const progress: Array<{ phase: VideoImportPhase; progress: number | null }> = [];
    const client = createVideoImportClient({
      createXhr: () => xhr as unknown as XMLHttpRequest,
      fetch: fetcher,
      probeBrowserVideo: vi
        .fn()
        .mockResolvedValueOnce({ decodable: false, durationSec: 3, width: 0, height: 0 })
        .mockResolvedValueOnce({ decodable: true, durationSec: 3, width: 320, height: 180 }),
      wait,
      visibilityState,
    });

    await client.importVideoFile(
      new File(["video"], "original.mov", { type: "video/quicktime" }),
      {
        role: "screen",
        signal: new AbortController().signal,
        onProgress: (state) => progress.push(state),
      }
    );

    for (const phase of ["copying", "converting"] as const) {
      const numeric = progress
        .filter((state) => state.phase === phase && state.progress !== null)
        .map((state) => state.progress as number);
      expect(numeric).toEqual([...numeric].sort((left, right) => left - right));
    }
    expect(wait).toHaveBeenNthCalledWith(1, 750, expect.any(AbortSignal));
    expect(wait).toHaveBeenNthCalledWith(2, 2_000, expect.any(AbortSignal));
  });

  it.each([
    [
      "failed",
      { code: "COMPATIBILITY_ENCODE_FAILED", message: "encode failed" },
      "COMPATIBILITY_ENCODE_FAILED",
    ],
    [
      "unavailable",
      { code: "FFMPEG_UNAVAILABLE", message: "ffmpeg unavailable" },
      "FFMPEG_UNAVAILABLE",
    ],
    ["cancelled", undefined, "VIDEO_IMPORT_CANCELLED"],
    ["none", undefined, "COMPATIBILITY_LOCK_LOST"],
  ] as const)(
    "stops polling after the server reports terminal status %s",
    async (status, error, expectedCode) => {
      const wait = vi.fn().mockResolvedValue(undefined);
      const fetcher = vi.fn(
        async (
          input: RequestInfo | URL,
          init?: RequestInit
        ): Promise<Response> => {
          const url = String(input);
          if (url.includes("/api/repurpose/media?")) {
            return jsonResponse(inspection("hevc"));
          }
          if (
            url.endsWith("/api/repurpose/compatibility") &&
            init?.method === "POST"
          ) {
            return jsonResponse({ status: "building", progress: 0.2 }, 202);
          }
          if (url.includes("/api/repurpose/compatibility?")) {
            return jsonResponse({ status, progress: null, error });
          }
          if (
            url.endsWith("/api/repurpose/compatibility") &&
            init?.method === "DELETE"
          ) {
            return jsonResponse({ status: "cancelled", progress: null });
          }
          throw new Error(`Unexpected request: ${url}`);
        }
      );
      const client = createVideoImportClient({
        createXhr: () =>
          uploadXhr(uploaded("C:\\media\\original.mov")) as unknown as XMLHttpRequest,
        fetch: fetcher,
        probeBrowserVideo: vi.fn().mockResolvedValue({
          decodable: false,
          durationSec: 3,
          width: 0,
          height: 0,
        }),
        wait,
        logError: vi.fn(),
      });

      await expect(
        client.importVideoFile(
          new File(["video"], "original.mov", { type: "video/quicktime" }),
          {
            role: "screen",
            signal: new AbortController().signal,
            onProgress: vi.fn(),
          }
        )
      ).rejects.toMatchObject({ code: expectedCode });

      expect(wait).toHaveBeenCalledTimes(1);
      expect(
        fetcher.mock.calls.filter(([input]) =>
          String(input).includes("/api/repurpose/compatibility?")
        )
      ).toHaveLength(1);
      expect(
        fetcher.mock.calls.filter(
          ([input, init]) =>
            String(input).endsWith("/api/repurpose/compatibility") &&
            init?.method === "DELETE"
        )
      ).toHaveLength(0);
    }
  );

  it("treats a POST none response as a start failure without polling", async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/repurpose/media?")) {
          return jsonResponse(inspection("hevc"));
        }
        if (
          url.endsWith("/api/repurpose/compatibility") &&
          init?.method === "POST"
        ) {
          return jsonResponse({ status: "none", progress: null });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const client = createVideoImportClient({
      createXhr: () =>
        uploadXhr(uploaded("C:\\media\\original.mov")) as unknown as XMLHttpRequest,
      fetch: fetcher,
      probeBrowserVideo: vi.fn().mockResolvedValue({
        decodable: false,
        durationSec: 3,
        width: 0,
        height: 0,
      }),
      wait,
      logError: vi.fn(),
    });

    await expect(
      client.importVideoFile(
        new File(["video"], "original.mov", { type: "video/quicktime" }),
        {
          role: "screen",
          signal: new AbortController().signal,
          onProgress: vi.fn(),
        }
      )
    ).rejects.toMatchObject({ code: "COMPATIBILITY_START_FAILED" });
    expect(wait).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).includes("/api/repurpose/compatibility?")
      )
    ).toBe(false);
  });
});

describe("video import errors and URLs", () => {
  it("normalizes a persisted native source back to its original working identity", async () => {
    const originalPath = "C:\\media\\native.mp4";
    const staleWorkingPath = "C:\\media\\stale-working.mp4";
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        String(input).startsWith("/api/repurpose/media?")
          ? jsonResponse(inspection())
          : init?.method === "POST"
            ? jsonResponse({ status: "building" })
            : jsonResponse({ status: "none" })
    );
    const client = createVideoImportClient({
      fetch: fetcher,
      createXhr: vi.fn(),
      probeBrowserVideo: vi.fn(),
      wait: vi.fn(),
      logError: vi.fn(),
    });

    await expect(
      client.reconcileVideoSource(
        {
          originalPath,
          workingPath: staleWorkingPath,
          originalName: "native.mp4",
          inspection: inspection(),
          nativeCompatible: true,
          compatibilityStatus: "native",
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      originalPath,
      workingPath: originalPath,
      compatibilityStatus: "native",
    });
  });

  it("separates optional preview failure from working-source reconciliation", async () => {
    const workingPath = "C:\\media\\source.mp4";
    const previewPath = "C:\\preview\\source.mp4";
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.startsWith("/api/repurpose/media?")) {
          return jsonResponse(inspection());
        }
        if (url.startsWith("/api/repurpose/proxy?") && !init?.method) {
          return jsonResponse(
            { error: { code: "PROXY_UNAVAILABLE" } },
            503
          );
        }
        if (url.startsWith("/api/repurpose/proxy?") && init?.method === "POST") {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const client = createVideoImportClient({
      fetch: fetcher,
      createXhr: vi.fn(),
      probeBrowserVideo: vi.fn(),
      wait: vi.fn(),
      logError: vi.fn(),
    });

    const persistedSource = {
      originalPath: workingPath,
      workingPath,
      previewPath,
      originalName: "source.mp4",
      inspection: inspection(),
      nativeCompatible: true,
      compatibilityStatus: "native" as const,
    };
    const signal = new AbortController().signal;

    const reconciled = await client.reconcileVideoSource(
      persistedSource,
      signal
    );

    expect(reconciled).toMatchObject({
      originalPath: workingPath,
      workingPath,
      previewPath,
    });
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).startsWith("/api/repurpose/proxy?")
      )
    ).toBe(false);

    await expect(
      client.reconcileVideoPreview(reconciled, signal)
    ).resolves.toMatchObject({ previewPath: undefined });
    expect(
      fetcher.mock.calls.some(
        ([input, init]) =>
          String(input).startsWith("/api/repurpose/proxy?") &&
          init?.method === "POST"
      )
    ).toBe(true);
  });

  it.each([
    ["UPLOAD_FAILED", "Não foi possível copiar o vídeo."],
    ["MEDIA_PATH_INVALID", "Não foi possível acessar o vídeo."],
    ["MEDIA_INSPECTION_FAILED", "Não foi possível inspecionar o vídeo."],
    ["FFPROBE_UNAVAILABLE", "A inspeção de vídeo não está disponível."],
    ["MEDIA_PROBE_TIMEOUT", "A inspeção do vídeo demorou demais."],
    ["MEDIA_CHANGED", "O vídeo mudou durante a importação. Tente novamente."],
    ["MEDIA_INVALID", "O arquivo não é um vídeo válido."],
    ["COMPATIBILITY_FINGERPRINT_INVALID", "Não foi possível identificar o vídeo."],
    ["COMPATIBILITY_INPUT_INVALID", "Não foi possível acessar o vídeo."],
    ["COMPATIBILITY_CACHE_BUSY", "A conversão está ocupada. Reinicie o servidor e tente novamente."],
    ["COMPATIBILITY_START_FAILED", "Não foi possível iniciar a conversão."],
    ["FFMPEG_UNAVAILABLE", "A conversão de vídeo não está disponível."],
    ["COMPATIBILITY_ENCODE_FAILED", "Não foi possível converter o vídeo."],
    ["COMPATIBILITY_VALIDATION_FAILED", "O vídeo convertido não passou na validação."],
    ["COMPATIBILITY_CACHE_ERROR", "Não foi possível acessar o vídeo convertido."],
    ["COMPATIBILITY_LOCK_LOST", "A conversão foi interrompida. Tente novamente."],
    ["BROWSER_DECODE_FAILED", "O Chrome não conseguiu abrir o vídeo convertido."],
    ["VIDEO_SOURCE_RECONNECT_REQUIRED", "Reconecte o arquivo de vídeo original."],
    ["VIDEO_IMPORT_CANCELLED", "Importação cancelada."],
    ["COMPATIBILITY_CANCELLED", "Importação cancelada."],
    ["MEDIA_PROBE_ABORTED", "Importação cancelada."],
  ])("maps %s to concise Portuguese copy", (code, message) => {
    expect(videoImportMessageForCode(code)).toBe(message);
    expect(new VideoImportError(code)).toMatchObject({ code, message });
  });

  it("keeps an English server code in logs while exposing Portuguese UI copy", async () => {
    const logger = vi.fn();
    const client = createVideoImportClient({
      createXhr: () => uploadXhr() as unknown as XMLHttpRequest,
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "FFPROBE_UNAVAILABLE",
              message: "Media inspection is unavailable.",
            },
          },
          503
        )
      ),
      probeBrowserVideo: vi.fn(),
      logError: logger,
      wait: vi.fn(),
    });

    await expect(
      client.importVideoFile(new File(["video"], "original.mp4"), {
        role: "face",
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "FFPROBE_UNAVAILABLE",
        message: "A inspeção de vídeo não está disponível.",
      })
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("FFPROBE_UNAVAILABLE"),
      expect.anything()
    );
  });

  it("derives the browser URL from the full-quality working path", () => {
    expect(
      videoUrlForWorkingSource({
        originalPath: "C:\\media\\source.mov",
        workingPath: "C:\\cache\\master.mp4",
        previewPath: "C:\\cache\\preview.mp4",
        originalName: "source.mov",
        inspection: inspection("hevc"),
        nativeCompatible: false,
        compatibilityStatus: "converted",
      })
    ).toBe(
      `/api/repurpose/video?path=${encodeURIComponent("C:\\cache\\master.mp4")}`
    );
  });

  it("provides a typed import error for Task 7 callers", () => {
    expect(new VideoImportError("MEDIA_INVALID")).toMatchObject({
      code: "MEDIA_INVALID",
      message: "O arquivo não é um vídeo válido.",
    });
  });
});
