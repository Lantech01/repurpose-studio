import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PreviewCanvas,
  type PreviewFrameScheduler,
} from "@/app/repurpose-studio/_components/PreviewCanvas";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, FootageMeta, Overlay } from "@/lib/repurpose/types";

const { drawFrameMock, synchronizeMediaTimeMock } = vi.hoisted(() => ({
  drawFrameMock: vi.fn(),
  synchronizeMediaTimeMock: vi.fn(),
}));

vi.mock("@/lib/engine/crisp-canvas", () => ({
  setupCrispCanvas: () => ({}),
}));
vi.mock("@/lib/repurpose/compositor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repurpose/compositor")>()),
  drawFrame: drawFrameMock,
}));
vi.mock("@/lib/repurpose/media-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/media-sync")>();
  synchronizeMediaTimeMock.mockImplementation(actual.synchronizeMediaTime);
  return { ...actual, synchronizeMediaTime: synchronizeMediaTimeMock };
});
vi.mock("@/app/repurpose-studio/_components/GhostOverflowLayer", () => ({
  GhostOverflowLayer: () => null,
}));
vi.mock("@/app/repurpose-studio/_components/SnapGuides", () => ({
  SnapGuides: () => null,
}));
vi.mock("@/app/repurpose-studio/_components/SelectionOverlay", () => ({
  SelectionOverlay: () => null,
}));
vi.mock("@/app/repurpose-studio/_components/SelectionToolbar", () => ({
  SelectionToolbar: () => null,
}));
vi.mock("@/app/repurpose-studio/_components/useSfxPreview", () => ({
  useSfxPreview: () => undefined,
  useMusicPreview: () => undefined,
}));
vi.mock("@/app/repurpose-studio/_components/useFacecamProxy", () => ({
  useFacecamProxy: (src: string | undefined) => ({
    src,
    usingProxy: false,
    buildProgress: null,
    onSrcError: () => undefined,
  }),
}));

const footageMeta: FootageMeta = {
  faceCamPath: "/media/face.mp4",
  screenPath: "/media/screen.mp4",
  fps: 30,
  width: 1920,
  height: 1080,
  durationSec: 12,
};

const clips: Clip[] = [
  {
    id: "clip-a",
    kind: "take",
    label: "First take",
    srcStart: 0,
    srcEnd: 1,
    timelineStart: 0,
    timelineEnd: 1,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 0, end: 1 }],
    keeperIndex: 0,
  },
  {
    id: "clip-b",
    kind: "take",
    label: "Second take after a source gap",
    srcStart: 10,
    srcEnd: 12,
    timelineStart: 1,
    timelineEnd: 3,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 10, end: 12 }],
    keeperIndex: 0,
  },
];

const rapidDoubleCutClips: Clip[] = [
  clips[0],
  {
    ...clips[1],
    srcEnd: 11,
    timelineEnd: 2,
    occurrences: [{ start: 10, end: 11 }],
  },
  {
    ...clips[1],
    id: "clip-c",
    label: "Third take after another source gap",
    srcStart: 20,
    srcEnd: 21,
    timelineStart: 2,
    timelineEnd: 3,
    occurrences: [{ start: 20, end: 21 }],
  },
];

const overlay: Overlay = {
  id: "overlay-video",
  kind: "video",
  src: "/media/overlay.mp4",
  naturalWidth: 1280,
  naturalHeight: 720,
  timelineStart: 0,
  timelineEnd: 3,
  srcStart: 20,
  srcDuration: 23,
  transform: { x: 0.5, y: 0.25, scale: 1, rotation: 0 },
  zIndex: 0,
  opacity: 1,
  muted: true,
  band: "screen",
};

let mediaTimes: WeakMap<HTMLMediaElement, number>;
let mediaReadyStates: WeakMap<HTMLMediaElement, number>;
let playingMedia: WeakSet<HTMLMediaElement>;
let playImpl: ReturnType<
  typeof vi.fn<(this: HTMLMediaElement) => Promise<void>>
>;
let rafCallbacks: Map<number, FrameRequestCallback>;
let nextRafId: number;
let frameScheduler: PreviewFrameScheduler;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function resetStore() {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  const store = useRepurposeStore.getState();
  store.setClips(clips);
  store.setFootageMeta(footageMeta);
  useRepurposeStore.setState({ overlays: [overlay] });
}

function mediaFor(container: HTMLElement) {
  const all = Array.from(container.querySelectorAll("video"));
  return {
    screen: all.slice(0, 3) as HTMLVideoElement[],
    face: all.slice(3, 6) as HTMLVideoElement[],
    overlay: all[6] as HTMLVideoElement,
  };
}

function decode(video: HTMLVideoElement, readyState = 4) {
  mediaReadyStates.set(video, readyState);
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
  });
  fireEvent.loadedMetadata(video);
  fireEvent.canPlay(video);
}

function runFrame(timestamp: number) {
  expect(rafCallbacks.size).toBe(1);
  const [id, callback] = Array.from(rafCallbacks.entries())[0];
  rafCallbacks.delete(id);
  act(() => callback(timestamp));
}

beforeEach(() => {
  resetStore();
  mediaTimes = new WeakMap();
  mediaReadyStates = new WeakMap();
  playingMedia = new WeakSet();
  playImpl = vi.fn(function (this: HTMLMediaElement) {
    playingMedia.add(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(playImpl);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    function (this: HTMLMediaElement) {
      playingMedia.delete(this);
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return mediaTimes.get(this) ?? 0;
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(
    function (this: HTMLMediaElement, value: number) {
      mediaTimes.set(this, value);
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return !playingMedia.has(this);
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return mediaReadyStates.get(this) ?? 4;
    }
  );
  vi.spyOn(performance, "now").mockReturnValue(1_000);

  rafCallbacks = new Map();
  nextRafId = 1;
  frameScheduler = {
    request(callback) {
      const id = nextRafId++;
      rafCallbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      rafCallbacks.delete(id);
    },
    now: () => performance.now(),
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PreviewCanvas transport", () => {
  test("disarms promoted standby seekers across a rapid double cut", async () => {
    useRepurposeStore.getState().setClips(rapidDoubleCutClips);
    useRepurposeStore.setState({ playhead: 0.8, overlays: [overlay] });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    media.screen.forEach((video) => decode(video));
    media.face.forEach((video) => decode(video));
    decode(media.overlay);
    fireEvent(media.screen[1], new Event("seeked"));
    fireEvent(media.face[1], new Event("seeked"));
    fireEvent(media.screen[2], new Event("seeked"));
    fireEvent(media.face[2], new Event("seeked"));
    useRepurposeStore.getState().setMediaReadiness("ready");

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    runFrame(1_000);
    runFrame(1_200);
    await act(async () => Promise.resolve());
    runFrame(2_200);

    const lastDraw = drawFrameMock.mock.calls.at(-1)?.[1];
    expect(lastDraw.screen.source).toBe(media.screen[2]);
    expect(lastDraw.face.source).toBe(media.face[2]);

    media.screen[2].currentTime = 21;
    media.face[2].currentTime = 21;
    fireEvent(media.screen[2], new Event("seeked"));
    fireEvent(media.face[2], new Event("seeked"));

    expect(media.screen[2].currentTime).toBe(21);
    expect(media.face[2].currentTime).toBe(21);
  });

  test("does not advance the transport while required base play promises are pending", () => {
    const screenPlay = deferred<void>();
    const facePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => screenPlay.promise)
      .mockImplementationOnce(() => facePlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    act(() => useRepurposeStore.getState().play());
    runFrame(1_000);
    runFrame(2_000);

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: true,
      playhead: 0,
    });
  });

  test("ignores a late AbortError after Play then Pause", async () => {
    const screenPlay = deferred<void>();
    const facePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => screenPlay.promise)
      .mockImplementationOnce(() => facePlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    act(() => useRepurposeStore.getState().play());
    act(() => useRepurposeStore.getState().pause());

    await act(async () => {
      screenPlay.reject(new DOMException("stopped", "AbortError"));
      facePlay.reject(new DOMException("stopped", "AbortError"));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("ignores an obsolete rejection after a newer playback session starts", async () => {
    const oldScreenPlay = deferred<void>();
    const oldFacePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => oldScreenPlay.promise)
      .mockImplementationOnce(() => oldFacePlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    act(() => useRepurposeStore.getState().play());
    act(() => useRepurposeStore.getState().pause());
    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());

    await act(async () => {
      oldScreenPlay.reject(new Error("obsolete session"));
      oldFacePlay.reject(new Error("obsolete session"));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: true,
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("ignores obsolete play results after unmount and source replacement", async () => {
    const oldScreenPlay = deferred<void>();
    const oldFacePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => oldScreenPlay.promise)
      .mockImplementationOnce(() => oldFacePlay.promise);
    const { container, unmount } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    act(() => useRepurposeStore.getState().play());
    act(() =>
      useRepurposeStore.getState().setFootageMeta({
        ...footageMeta,
        screenPath: "/media/replacement-screen.mp4",
        faceCamPath: "/media/replacement-face.mp4",
      })
    );
    unmount();

    await act(async () => {
      oldScreenPlay.reject(new Error("obsolete source"));
      oldFacePlay.reject(new Error("obsolete source"));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "loading",
      playbackBlockedReason: "Media is still loading.",
    });
  });

  test("reports ready only after both active base videos have decoded dimensions", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);

    decode(media.screen[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    decode(media.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });

  test("requires future data and positive dimensions from both active slots", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);

    decode(media.screen[0], 2);
    decode(media.face[0], 2);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    decode(media.screen[0], HTMLMediaElement.HAVE_FUTURE_DATA);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
    decode(media.face[0], HTMLMediaElement.HAVE_FUTURE_DATA);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });

  test("keeps a healthy active pair ready when a standby emits an error", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    fireEvent.error(media.screen[1]);
    fireEvent.error(media.face[1]);

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("keeps an active-pair error sticky against late standby and active metadata", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    fireEvent.error(media.screen[0]);

    decode(media.screen[1]);
    decode(media.face[1]);
    decode(media.screen[0]);
    decode(media.face[0]);

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason:
        "Chrome could not load this video. Re-import it to create a compatible copy.",
    });
  });

  test("starts a fresh loading-to-ready cycle when required sources change", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const oldMedia = mediaFor(container);
    decode(oldMedia.screen[0]);
    decode(oldMedia.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");

    act(() =>
      useRepurposeStore.getState().setFootageMeta({
        ...footageMeta,
        screenPath: "/media/new-screen.mp4",
        faceCamPath: "/media/new-face.mp4",
      })
    );
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    fireEvent.loadedMetadata(oldMedia.screen[0]);
    fireEvent.canPlay(oldMedia.screen[0]);
    fireEvent.loadedMetadata(oldMedia.face[0]);
    fireEvent.canPlay(oldMedia.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    const newMedia = mediaFor(container);
    decode(newMedia.screen[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
    decode(newMedia.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });

  test.each(["screen", "face"] as const)(
    "pauses and reports a real required %s media error",
    async (role) => {
      const { container } = render(
        createElement(PreviewCanvas, { frameScheduler })
      );
      const media = mediaFor(container);
      decode(media.screen[0]);
      decode(media.face[0]);
      act(() => useRepurposeStore.getState().play());
      await act(async () => Promise.resolve());

      fireEvent.error(media[role][0]);

      expect(useRepurposeStore.getState()).toMatchObject({
        isPlaying: false,
        mediaReadiness: "error",
        playbackBlockedReason:
          "Chrome could not load this video. Re-import it to create a compatible copy.",
      });
    }
  );

  test("uses one monotonic clock through play, seek, and a discontinuous swap", async () => {
    useRepurposeStore.setState({ playhead: 0.8 });
    const { container, unmount, getByRole } = render(
      createElement(
        "div",
        null,
        createElement(PreviewCanvas, { frameScheduler }),
        createElement(
          "button",
          { onClick: () => useRepurposeStore.getState().play() },
          "Play"
        )
      )
    );
    const media = mediaFor(container);
    media.screen.forEach((video) => decode(video));
    media.face.forEach((video) => decode(video));
    decode(media.overlay);

    // Finish the standby pre-seek so slot 1 is warm at the discontinuous cut.
    fireEvent(media.screen[1], new Event("seeked"));
    fireEvent(media.face[1], new Event("seeked"));
    useRepurposeStore.getState().setMediaReadiness("ready");

    const playButton = getByRole("button", { name: "Play" });
    for (let click = 0; click < 5; click += 1) fireEvent.click(playButton);
    await act(async () => Promise.resolve());
    expect(rafCallbacks.size).toBe(1);
    expect(media.screen[0].currentTime).toBeCloseTo(0.8, 5);
    expect(media.face[0].currentTime).toBeCloseTo(0.8, 5);

    // Deliberately poison the former face-video clock. Output time must still
    // follow rAF, and the real media elements must be corrected to source time.
    mediaTimes.set(media.face[0], 42);
    runFrame(1_000);
    expect(media.overlay.currentTime).toBeCloseTo(20.8, 5);
    runFrame(1_200);

    expect(useRepurposeStore.getState().playhead).toBeCloseTo(1, 5);
    expect(Math.abs(media.screen[1].currentTime - 10)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(media.face[1].currentTime - 10)).toBeLessThanOrEqual(0.15);
    expect(playImpl.mock.contexts).toContain(media.screen[1]);
    expect(playImpl.mock.contexts).toContain(media.face[1]);

    await act(async () => Promise.resolve());
    runFrame(1_400);

    expect(useRepurposeStore.getState().playhead).toBeCloseTo(1.2, 5);
    expect(media.screen[1].currentTime).toBeCloseTo(10.2, 5);
    expect(media.face[1].currentTime).toBeCloseTo(10.2, 5);
    expect(media.overlay.currentTime).toBeCloseTo(21.2, 5);
    const lastDraw = drawFrameMock.mock.calls.at(-1)?.[1];
    expect(lastDraw.screen.source).toBe(media.screen[1]);
    expect(lastDraw.face.source).toBe(media.face[1]);

    act(() => useRepurposeStore.getState().setPlayhead(2));
    runFrame(1_450);
    expect(useRepurposeStore.getState().playhead).toBeCloseTo(2, 5);
    expect(media.screen[1].currentTime).toBeCloseTo(11, 5);
    expect(media.face[1].currentTime).toBeCloseTo(11, 5);
    expect(media.overlay.currentTime).toBeCloseTo(22, 5);

    act(() => useRepurposeStore.getState().pause());
    runFrame(2_450);
    expect(useRepurposeStore.getState().playhead).toBeCloseTo(2, 5);

    expect(container.querySelector('[data-source-role="screen"][data-slot-index="1"]')).toBe(
      media.screen[1]
    );
    expect(container.querySelector('[data-source-role="face"][data-slot-index="1"]')).toBe(
      media.face[1]
    );
    expect(container.querySelector('[data-overlay-id="overlay-video"]')).toBe(media.overlay);

    unmount();
    expect(rafCallbacks.size).toBe(0);
  });

  test("pauses with an actionable reason when an active overlay play rejects", async () => {
    playImpl
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error("overlay codec")));
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);

    act(() => useRepurposeStore.getState().play());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    runFrame(1_000);
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "error",
      playbackBlockedReason:
        "Overlay video overlay-video could not play. Re-import it to create a compatible copy.",
    });
  });

  test("reports an active overlay error event but ignores one outside its window", async () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);
    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());

    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason:
        "Overlay video overlay-video could not play. Re-import it to create a compatible copy.",
    });

    useRepurposeStore.getState().setMediaReadiness("ready");
    useRepurposeStore.setState({
      overlays: [{ ...overlay, timelineStart: 1, timelineEnd: 2 }],
      playhead: 0,
    });
    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("synchronizes an active overlay exactly once per playing frame", async () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);
    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    synchronizeMediaTimeMock.mockClear();

    runFrame(1_000);

    const overlaySyncs = synchronizeMediaTimeMock.mock.calls.filter(
      ([element]) => element === media.overlay
    );
    expect(overlaySyncs).toHaveLength(1);
  });

  test("surfaces a required base play rejection instead of swallowing it", async () => {
    playImpl.mockImplementationOnce(function (this: HTMLMediaElement) {
      playingMedia.add(this);
      return Promise.reject(new Error("codec rejected"));
    });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    useRepurposeStore.getState().setMediaReadiness("ready");

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "error",
      playbackBlockedReason:
        "Chrome could not start this video. Re-import it to create a compatible copy.",
    });
  });
});
