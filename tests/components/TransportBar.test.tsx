import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TransportBar } from "@/app/repurpose-studio/_components/TransportBar";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, FootageMeta, Overlay } from "@/lib/repurpose/types";

const footageMeta: FootageMeta = {
  faceCamPath: "/media/face.mp4",
  screenPath: "/media/screen.mp4",
  fps: 30,
  width: 1920,
  height: 1080,
  durationSec: 5,
};

const clip: Clip = {
  id: "clip-1",
  kind: "take",
  label: "Playable clip",
  srcStart: 0,
  srcEnd: 5,
  timelineStart: 0,
  timelineEnd: 5,
  kept: true,
  isKeeperTake: true,
  occurrences: [{ start: 0, end: 5 }],
  keeperIndex: 0,
};

function resetStore() {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
}

function loadPlayableProject() {
  const store = useRepurposeStore.getState();
  store.setClips([clip]);
  store.setFootageMeta(footageMeta);
  store.setMediaReadiness("ready");
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
});

describe("media readiness", () => {
  test("setFootageMeta marks complete source paths as loading and missing paths as idle", () => {
    const store = useRepurposeStore.getState();

    expect(store.mediaReadiness).toBe("idle");

    store.setFootageMeta(footageMeta);
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "loading",
      playbackBlockedReason: "Media is still loading.",
    });

    useRepurposeStore.getState().setMediaReadiness("ready");
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });

    useRepurposeStore.getState().setFootageMeta({
      ...footageMeta,
      screenPath: "",
    });
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "idle",
      playbackBlockedReason: null,
    });
  });

  test("an error records a concise reason, pauses, and resets playback to 1x", () => {
    loadPlayableProject();
    useRepurposeStore.setState({ isPlaying: true, playbackRate: 2 });

    useRepurposeStore
      .getState()
      .setMediaReadiness("error", "Preview media failed to load.");

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason: "Preview media failed to load.",
      isPlaying: false,
      playbackRate: 1,
    });
  });

  test("readiness and its error reason stay out of editable history snapshots", () => {
    const store = useRepurposeStore.getState();
    store.setMediaReadiness("error", "Preview media failed to load.");
    store.commitHistory();

    expect(useRepurposeStore.getState().past[0]).not.toHaveProperty(
      "mediaReadiness"
    );
    expect(useRepurposeStore.getState().past[0]).not.toHaveProperty(
      "playbackBlockedReason"
    );
  });
});

describe("playback guards", () => {
  test.each([
    ["zero duration", () => useRepurposeStore.setState({ duration: 0 })],
    ["missing clips", () => useRepurposeStore.setState({ clips: [] })],
    [
      "missing footage paths",
      () =>
        useRepurposeStore.setState({
          footageMeta: { ...footageMeta, faceCamPath: "" },
        }),
    ],
    [
      "loading media",
      () => useRepurposeStore.getState().setMediaReadiness("loading"),
    ],
    [
      "errored media",
      () => useRepurposeStore.getState().setMediaReadiness("error"),
    ],
  ])("play refuses %s", (_label, arrangeBlockedState) => {
    loadPlayableProject();
    arrangeBlockedState();

    useRepurposeStore.getState().play();

    expect(useRepurposeStore.getState().isPlaying).toBe(false);
    expect(useRepurposeStore.getState().playbackBlockedReason).toBeTruthy();
  });

  test("play and pause are idempotent, and pause resets the rate", () => {
    loadPlayableProject();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore.subscribe(listener);

    useRepurposeStore.getState().play();
    expect(useRepurposeStore.getState().isPlaying).toBe(true);
    const callsAfterPlay = listener.mock.calls.length;

    useRepurposeStore.getState().play();
    expect(listener).toHaveBeenCalledTimes(callsAfterPlay);

    useRepurposeStore.setState({ playbackRate: 2 });
    useRepurposeStore.getState().pause();
    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      playbackRate: 1,
    });
    const callsAfterPause = listener.mock.calls.length;

    useRepurposeStore.getState().pause();
    expect(listener).toHaveBeenCalledTimes(callsAfterPause);

    unsubscribe();
  });
});

describe("TransportBar", () => {
  test.each([
    { label: "endpoint fallback", playhead: 0.5, expectedId: "visible-face" },
    { label: "transition stored primary", playhead: 1.2, expectedId: "stored-screen" },
    { label: "no visible selection", playhead: 0.5, expectedId: null },
  ] as const)(
    "copies attributes from the settled effective primary at a $label",
    ({ playhead, expectedId }) => {
      const transitionClips: Clip[] = [
        {
          ...clip,
          id: "outgoing",
          srcEnd: 1,
          timelineEnd: 1,
          splitRatio: 0,
          occurrences: [{ start: 0, end: 1 }],
        },
        {
          ...clip,
          id: "incoming",
          srcStart: 1,
          timelineStart: 1,
          timelineEnd: 2,
          splitRatio: 1,
          transitionIn: {
            type: "zoom-settle",
            durationSec: 0.4,
            amount: 0.025,
            easing: "natural",
          },
        },
      ];
      const stored: Overlay = {
        id: "stored-screen",
        kind: "image",
        src: "/stored.png",
        naturalWidth: 400,
        naturalHeight: 300,
        timelineStart: 0,
        timelineEnd: 2,
        srcStart: 0,
        srcDuration: 0,
        transform: { x: 0.8, y: 0.2, scale: 0.4, rotation: 10 },
        zIndex: 1,
        opacity: 0.8,
        band: "screen",
      };
      const visible: Overlay = {
        ...stored,
        id: "visible-face",
        src: "/visible.png",
        transform: { x: 0.2, y: 0.8, scale: 0.3, rotation: -10 },
        opacity: 0.3,
        band: "face",
      };
      const selectedIds = expectedId === null ? [stored.id] : [visible.id, stored.id];
      useRepurposeStore.setState({
        clips: transitionClips,
        duration: 2,
        playhead,
        overlays: [stored, visible],
        selectedOverlayId: stored.id,
        selectedOverlayIds: selectedIds,
      });
      render(<TransportBar />);

      const event = new KeyboardEvent("keydown", {
        code: "KeyC",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(window, event);

      expect(event.defaultPrevented).toBe(expectedId !== null);
      if (expectedId === null) {
        expect(useRepurposeStore.getState().attributeClipboard).toBeNull();
      } else {
        const expected = expectedId === stored.id ? stored : visible;
        expect(useRepurposeStore.getState().attributeClipboard).toEqual({
          kind: "overlay",
          transform: expected.transform,
          opacity: expected.opacity,
          entranceEffect: { type: "none", durationSec: 0.35 },
          exitEffect: { type: "none", durationSec: 0.35 },
          cornerRadius: 0,
        });
      }
      expect(useRepurposeStore.getState().selectedOverlayId).toBe(stored.id);
      expect(useRepurposeStore.getState().selectedOverlayIds).toEqual(selectedIds);
    }
  );

  test.each([
    {
      label: "per-scene endpoint",
      clips: [{ ...clip, splitRatio: 0 }],
      playhead: 0.5,
    },
    {
      label: "incoming transition endpoint",
      clips: [
        {
          ...clip,
          id: "outgoing",
          srcEnd: 1,
          timelineEnd: 1,
          splitRatio: 0,
          occurrences: [{ start: 0, end: 1 }],
        },
        {
          ...clip,
          id: "incoming",
          srcStart: 1,
          timelineStart: 1,
          splitRatio: 1,
          transitionIn: {
            type: "zoom-settle" as const,
            durationSec: 0.4,
            amount: 0.025,
            easing: "natural" as const,
          },
        },
      ],
      playhead: 1,
    },
  ])(
    "uses the frame-effective split for paste at a $label",
    ({ clips, playhead }) => {
      const hidden: Overlay = {
        id: "hidden-screen",
        kind: "image",
        src: "/hidden.png",
        naturalWidth: 400,
        naturalHeight: 300,
        timelineStart: 0,
        timelineEnd: 5,
        srcStart: 0,
        srcDuration: 0,
        transform: { x: 0.5, y: 0.2, scale: 0.4, rotation: 0 },
        zIndex: 0,
        opacity: 1,
        band: "screen",
      };
      useRepurposeStore.getState().setClips(clips);
      useRepurposeStore.setState({
        splitRatio: 1,
        playhead,
        overlays: [hidden],
        selectedOverlayId: hidden.id,
        selectedOverlayIds: [hidden.id],
        attributeClipboard: {
          kind: "overlay",
          transform: { x: 0.8, y: 0.7, scale: 0.7, rotation: 25 },
          opacity: 0.4,
          entranceEffect: { type: "none", durationSec: 0.35 },
          exitEffect: { type: "none", durationSec: 0.35 },
          cornerRadius: 0,
        },
        past: [],
      });
      render(<TransportBar />);

      const event = new KeyboardEvent("keydown", {
        code: "KeyV",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(window, event);

      expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
        hidden.transform
      );
      expect(useRepurposeStore.getState().past).toHaveLength(0);
      expect(event.defaultPrevented).toBe(false);
    }
  );

  test("guides a blank project to choose both source videos before Play", () => {
    render(createElement(TransportBar));

    const playButton = screen.getByRole("button", { name: "Play" });
    expect(playButton).toBeDisabled();
    expect(playButton).toHaveAccessibleDescription(
      "Choose both source videos before playing."
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose both source videos before playing."
    );
  });

  test("reports media loading and errors before a missing timeline", () => {
    const store = useRepurposeStore.getState();
    store.setFootageMeta(footageMeta);

    render(createElement(TransportBar));

    expect(screen.getByRole("button", { name: "Play" })).toHaveAccessibleDescription(
      "Media is still loading."
    );

    act(() => {
      useRepurposeStore
        .getState()
        .setMediaReadiness("error", "Preview media failed to load.");
    });

    expect(screen.getByRole("button", { name: "Play" })).toHaveAccessibleDescription(
      "Preview media failed to load."
    );
  });

  test("reports duration only after both sources are ready", () => {
    const store = useRepurposeStore.getState();
    store.setFootageMeta(footageMeta);
    store.setMediaReadiness("ready");

    render(createElement(TransportBar));

    expect(screen.getByRole("button", { name: "Play" })).toHaveAccessibleDescription(
      "This project has no playable duration."
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "This project has no playable duration."
    );
  });

  test("disables Play and describes an incomplete footage source", () => {
    const store = useRepurposeStore.getState();
    store.setClips([clip]);
    store.setFootageMeta({ ...footageMeta, screenPath: "" });

    render(createElement(TransportBar));

    const playButton = screen.getByRole("button", { name: "Play" });
    expect(playButton).toBeDisabled();
    expect(playButton).toHaveAccessibleDescription(
      "Choose both source videos before playing."
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose both source videos before playing."
    );
  });

  test("keeps the Play button and describes loading and error blocks accessibly", () => {
    const store = useRepurposeStore.getState();
    store.setClips([clip]);
    store.setFootageMeta(footageMeta);

    render(createElement(TransportBar));

    const playButton = screen.getByRole("button", { name: "Play" });
    expect(playButton).toBeDisabled();
    expect(playButton).toHaveAccessibleDescription("Media is still loading.");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Media is still loading."
    );

    act(() => {
      useRepurposeStore
        .getState()
        .setMediaReadiness("error", "Preview media failed to load.");
    });

    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Play" })).toHaveAccessibleDescription(
      "Preview media failed to load."
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preview media failed to load."
    );
  });
});
