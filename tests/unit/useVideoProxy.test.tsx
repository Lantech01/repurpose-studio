import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  rawPathFromRef,
  useVideoProxy,
} from "@/app/repurpose-studio/_components/useVideoProxy";
import {
  createVideoProxyClient,
  VideoProxyError,
} from "@/lib/repurpose/video-proxy-client";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { VideoSourceRecord } from "@/lib/repurpose/types";

const source: VideoSourceRecord = {
  originalPath: "C:\\Users\\editor\\Videos\\camera.mov",
  workingPath: "C:\\Users\\editor\\Videos\\camera.mp4",
  originalName: "camera.mov",
  inspection: {
    fingerprint: "a".repeat(64),
    container: "mov,mp4",
    extension: ".mov",
    size: 4_096,
    durationSec: 8,
    video: {
      codec: "h264",
      codecTag: "avc1",
      profile: "High",
      pixelFormat: "yuv420p",
      width: 1920,
      height: 1080,
      fps: 30,
    },
    audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
  },
  nativeCompatible: true,
  compatibilityStatus: "native",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("video proxy client", () => {
  it("round-trips Windows drive paths and existing video URL refs", () => {
    const windowsPath = "C:\\Users\\editor\\Videos\\video.mp4";
    const url = `/api/repurpose/video?path=${encodeURIComponent(windowsPath)}`;

    expect(rawPathFromRef(windowsPath)).toBe(windowsPath);
    expect(rawPathFromRef(url)).toBe(windowsPath);
    expect(rawPathFromRef("https://example.com/video.mp4")).toBeNull();
  });

  it("starts once, polls with visibility-aware cadence, and returns only a validated ready preview", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "building", outTimeSec: 2 }))
      .mockResolvedValueOnce(json({ status: "building", outTimeSec: 4 }))
      .mockResolvedValueOnce(json({ status: "ready" }));
    const waits: number[] = [];
    let visibility: DocumentVisibilityState = "hidden";
    const client = createVideoProxyClient({
      fetch: fetcher,
      visibilityState: () => visibility,
      wait: async (ms) => {
        waits.push(ms);
        visibility = "visible";
      },
    });
    const progress: Array<number | null> = [];

    const result = await client.ensureVideoProxy(
      source,
      new AbortController().signal,
      (value) => progress.push(value)
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/repurpose/proxy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: source.workingPath }),
      }),
    ]);
    expect(waits).toEqual([2_500, 750]);
    expect(progress).toEqual([0.25, 0.5, 1]);
    expect(result).toEqual({
      ...source,
      previewPath: `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}&quality=proxy`,
    });
  });

  it("restarts idempotently when a non-mutating poll loses the shared job", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "building" }))
      .mockResolvedValueOnce(json({ status: "none" }))
      .mockResolvedValueOnce(json({ status: "ready" }));
    const waits: number[] = [];
    const client = createVideoProxyClient({
      fetch: fetcher,
      visibilityState: () => "visible",
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    const result = await client.ensureVideoProxy(
      source,
      new AbortController().signal
    );

    expect(waits).toEqual([750]);
    expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "POST",
      "GET",
      "POST",
    ]);
    expect(result.previewPath).toContain("quality=proxy");
  });

  it("bounds repeated lost-job restarts without leaking its poll timer or abort listener", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "building" }))
      .mockResolvedValueOnce(json({ status: "none" }))
      .mockImplementation(() => Promise.resolve(json({ status: "none" })));
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const client = createVideoProxyClient({ fetch: fetcher });

    const pending = client.ensureVideoProxy(source, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "VIDEO_PROXY_FAILED",
      message: "Não foi possível criar o proxy de prévia.",
    });
    await vi.advanceTimersByTimeAsync(750);

    await rejection;
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST")
    ).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      addListener.mock.calls.filter(([type]) => type === "abort")
    ).toHaveLength(1);
    expect(
      removeListener.mock.calls.filter(([type]) => type === "abort")
    ).toHaveLength(1);
  });

  it("clears a stale preview on 404 and reports failures and aborts with concise typed errors", async () => {
    const stale = { ...source, previewPath: "/stale-proxy.mp4" };
    const missingClient = createVideoProxyClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json(null, 404)),
    });

    await expect(
      missingClient.ensureVideoProxy(stale, new AbortController().signal)
    ).resolves.toEqual({ ...source, previewPath: undefined });

    const failedClient = createVideoProxyClient({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ status: "failed" })),
    });
    await expect(
      failedClient.ensureVideoProxy(source, new AbortController().signal)
    ).rejects.toEqual(
      expect.objectContaining<Partial<VideoProxyError>>({
        name: "VideoProxyError",
        code: "VIDEO_PROXY_FAILED",
        message: "Não foi possível criar o proxy de prévia.",
      })
    );

    const aborter = new AbortController();
    aborter.abort();
    await expect(
      failedClient.ensureVideoProxy(source, aborter.signal)
    ).rejects.toMatchObject({ code: "VIDEO_PROXY_CANCELLED" });
  });
});

describe("useVideoProxy and nested source ownership", () => {
  it("immutably updates only the requested nested source and preserves export-facing identities", () => {
    const face = { ...source };
    const screen = {
      ...source,
      workingPath: "C:\\Users\\editor\\Videos\\screen.mp4",
    };
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "/working-face",
      screenPath: "/working-screen",
      faceCamSource: face,
      screenSource: screen,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    const metaBefore = useRepurposeStore.getState().footageMeta!;
    const faceCamPathBefore = metaBefore.faceCamPath;
    const screenPathBefore = metaBefore.screenPath;
    const ready = { ...face, previewPath: "/face-preview" };

    useRepurposeStore.getState().setVideoSourceRecord(
      { kind: "footage", role: "face" },
      ready
    );

    const metaAfter = useRepurposeStore.getState().footageMeta!;
    expect(metaAfter).not.toBe(metaBefore);
    expect(metaAfter.faceCamSource).toBe(ready);
    expect(metaAfter.screenSource).toBe(screen);
    expect(metaAfter.faceCamPath).toBe(faceCamPathBefore);
    expect(metaAfter.screenPath).toBe(screenPathBefore);
  });

  it("updates only matching video asset and overlay records", () => {
    const ready = { ...source, previewPath: "/preview.mp4" };
    useRepurposeStore.setState({
      mediaAssets: [
        {
          id: "video-asset",
          kind: "video",
          name: "video.mp4",
          src: "/working-asset",
          sourcePath: source.workingPath,
          videoSource: source,
        },
        {
          id: "image-asset",
          kind: "image",
          name: "image.png",
          src: "/image",
        },
      ],
      overlays: [
        {
          id: "video-overlay",
          kind: "video",
          src: "/working-overlay",
          sourcePath: source.workingPath,
          videoSource: source,
          naturalWidth: 1920,
          naturalHeight: 1080,
          timelineStart: 0,
          timelineEnd: 2,
          srcStart: 0,
          srcDuration: 2,
          transform: { x: 0.5, y: 0.25, scale: 1, rotation: 0 },
          zIndex: 0,
          opacity: 1,
          muted: true,
        },
        {
          id: "image-overlay",
          kind: "image",
          src: "/image-overlay",
          naturalWidth: 100,
          naturalHeight: 100,
          timelineStart: 0,
          timelineEnd: 2,
          srcStart: 0,
          srcDuration: 0,
          transform: { x: 0.5, y: 0.25, scale: 1, rotation: 0 },
          zIndex: 1,
          opacity: 1,
        },
      ],
    });

    const store = useRepurposeStore.getState();
    store.setVideoSourceRecord({ kind: "asset", id: "video-asset" }, ready);
    store.setVideoSourceRecord({ kind: "overlay", id: "video-overlay" }, ready);
    store.setVideoSourceRecord({ kind: "asset", id: "image-asset" }, ready);
    store.setVideoSourceRecord({ kind: "overlay", id: "image-overlay" }, ready);

    const state = useRepurposeStore.getState();
    expect(state.mediaAssets[0]).toMatchObject({
      src: "/working-asset",
      sourcePath: source.workingPath,
      videoSource: ready,
    });
    expect(state.overlays[0]).toMatchObject({
      src: "/working-overlay",
      sourcePath: source.workingPath,
      videoSource: ready,
    });
    expect(state.mediaAssets[1]).not.toHaveProperty("videoSource");
    expect(state.overlays[1]).not.toHaveProperty("videoSource");
  });

  it("queues a ready proxy while playing, swaps while paused, and falls back immediately after a proxy 404", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ status: "ready" }));
    vi.stubGlobal("fetch", fetcher);
    const workingUrl = `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`;
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: workingUrl,
      screenPath: "/screen",
      faceCamSource: source,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    const { result, rerender } = renderHook(
      ({ playing }) =>
        useVideoProxy({
          target: { kind: "footage", role: "face" },
          source: useRepurposeStore.getState().footageMeta?.faceCamSource,
          fallbackSrc: workingUrl,
          durationSec: 8,
          isPlaying: playing,
        }),
      { initialProps: { playing: true } }
    );

    await waitFor(() =>
      expect(
        useRepurposeStore.getState().footageMeta?.faceCamSource?.previewPath
      ).toContain("quality=proxy")
    );
    expect(result.current.src).toBe(workingUrl);

    rerender({ playing: false });
    await waitFor(() => expect(result.current.usingProxy).toBe(true));
    expect(result.current.src).toContain("quality=proxy");

    act(() => result.current.onSrcError());
    expect(result.current.src).toBe(workingUrl);
    expect(
      useRepurposeStore.getState().footageMeta?.faceCamSource?.previewPath
    ).toBeUndefined();
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1));
  });

  it("retries a failed proxy artifact once and quarantines repeated slot errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(json({ status: "ready" })));
    vi.stubGlobal("fetch", fetcher);
    const workingUrl = `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`;
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: workingUrl,
      screenPath: "/screen",
      faceCamSource: source,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    const { result } = renderHook(() => {
      const currentSource = useRepurposeStore(
        (state) => state.footageMeta?.faceCamSource
      );
      return useVideoProxy({
        target: { kind: "footage", role: "face" },
        source: currentSource,
        fallbackSrc: workingUrl,
        durationSec: 8,
        isPlaying: false,
      });
    });

    await waitFor(() => expect(result.current.usingProxy).toBe(true));
    act(() => {
      result.current.onSrcError();
      result.current.onSrcError();
      result.current.onSrcError();
    });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([, init]) => init?.method === "POST")
      ).toHaveLength(2)
    );
    await waitFor(() =>
      expect(
        useRepurposeStore.getState().footageMeta?.faceCamSource?.previewPath
      ).toContain("quality=proxy")
    );
    await waitFor(() => expect(result.current.usingProxy).toBe(true));

    act(() => {
      result.current.onSrcError();
      result.current.onSrcError();
      result.current.onSrcError();
    });
    await waitFor(() => expect(result.current.src).toBe(workingUrl));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.usingProxy).toBe(false);
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST")
    ).toHaveLength(2);
  });

  it("ignores a completion owned by a replaced source or project epoch", async () => {
    let resolveReady!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveReady = resolve;
          })
      )
    );
    const workingUrl = `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`;
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: workingUrl,
      screenPath: "/screen",
      faceCamSource: source,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    const rendered = renderHook(() =>
      useVideoProxy({
        target: { kind: "footage", role: "face" },
        source,
        fallbackSrc: workingUrl,
        durationSec: 8,
        isPlaying: false,
      })
    );
    await waitFor(() => expect(resolveReady).toBeDefined());

    act(() => useRepurposeStore.getState().resetProject());
    await act(async () => {
      resolveReady(json({ status: "ready" }));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState().footageMeta).toBeNull();
    expect(rendered.result.current.src).toBe(workingUrl);
  });

  it("restarts for an external same-fingerprint source replacement without looping on its own preview update", async () => {
    const first = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      const postCount = fetcher.mock.calls.filter(
        ([, callInit]) => callInit?.method === "POST"
      ).length;
      if (init?.method === "POST" && postCount === 1) return first.promise;
      return Promise.resolve(json({ status: "ready" }));
    });
    vi.stubGlobal("fetch", fetcher);
    const workingUrl = `/api/repurpose/video?path=${encodeURIComponent(source.workingPath)}`;
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: workingUrl,
      screenPath: "/screen",
      faceCamSource: source,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    renderHook(() => {
      const currentSource = useRepurposeStore(
        (state) => state.footageMeta?.faceCamSource
      );
      return useVideoProxy({
        target: { kind: "footage", role: "face" },
        source: currentSource,
        fallbackSrc: workingUrl,
        durationSec: 8,
        isPlaying: false,
      });
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    const replacement = { ...source, originalName: "replacement.mov" };
    act(() =>
      useRepurposeStore.getState().setVideoSourceRecord(
        { kind: "footage", role: "face" },
        replacement
      )
    );

    await waitFor(() =>
      expect(
        useRepurposeStore.getState().footageMeta?.faceCamSource
      ).toMatchObject({
        originalName: "replacement.mov",
        previewPath: expect.stringContaining("quality=proxy"),
      })
    );
    first.resolve(json({ status: "ready" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST")
    ).toHaveLength(2);
    expect(
      useRepurposeStore.getState().footageMeta?.faceCamSource?.originalName
    ).toBe("replacement.mov");
  });
});
