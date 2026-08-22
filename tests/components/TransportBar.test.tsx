import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TransportBar } from "@/app/repurpose-studio/_components/TransportBar";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, FootageMeta } from "@/lib/repurpose/types";

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
