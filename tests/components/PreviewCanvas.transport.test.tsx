import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PreviewCanvas,
  type PreviewFrameScheduler,
} from "@/app/repurpose-studio/_components/PreviewCanvas";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, FootageMeta, Overlay } from "@/lib/repurpose/types";

const { drawFrameMock } = vi.hoisted(() => ({ drawFrameMock: vi.fn() }));

vi.mock("@/lib/engine/crisp-canvas", () => ({
  setupCrispCanvas: () => ({}),
}));
vi.mock("@/lib/repurpose/compositor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repurpose/compositor")>()),
  drawFrame: drawFrameMock,
}));
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
let playingMedia: WeakSet<HTMLMediaElement>;
let playImpl: ReturnType<
  typeof vi.fn<(this: HTMLMediaElement) => Promise<void>>
>;
let rafCallbacks: Map<number, FrameRequestCallback>;
let nextRafId: number;
let frameScheduler: PreviewFrameScheduler;

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

function decode(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
  });
  fireEvent.loadedMetadata(video);
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
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
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
  vi.unstubAllGlobals();
});

describe("PreviewCanvas transport", () => {
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
    media.screen.forEach(decode);
    media.face.forEach(decode);
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
    expect(media.overlay.currentTime).toBeCloseTo(20.8, 5);

    // Deliberately poison the former face-video clock. Output time must still
    // follow rAF, and the real media elements must be corrected to source time.
    mediaTimes.set(media.face[0], 42);
    runFrame(1_000);
    runFrame(1_200);

    expect(useRepurposeStore.getState().playhead).toBeCloseTo(1, 5);
    expect(Math.abs(media.screen[1].currentTime - 10)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(media.face[1].currentTime - 10)).toBeLessThanOrEqual(0.15);
    expect(playImpl.mock.contexts).toContain(media.screen[1]);
    expect(playImpl.mock.contexts).toContain(media.face[1]);

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
