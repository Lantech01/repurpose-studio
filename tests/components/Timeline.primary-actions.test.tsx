import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Timeline } from "@/app/repurpose-studio/_components/Timeline";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, Overlay } from "@/lib/repurpose/types";

vi.mock("@/app/repurpose-studio/_components/ClipBlock", () => ({
  ClipBlock: () => null,
}));
vi.mock("@/app/repurpose-studio/_components/OverlayBlock", () => ({
  OverlayBlock: () => null,
  useOverlayThumbnails: () => new Map(),
}));
vi.mock("@/app/repurpose-studio/_components/TransportBar", () => ({
  TransportBar: () => null,
}));
vi.mock("@/app/repurpose-studio/_components/useFaceWaveform", () => ({
  useFaceWaveform: () => null,
  useAudioWaveform: () => null,
  sliceClipPeaks: () => [],
}));

const clips: Clip[] = [
  {
    id: "outgoing",
    kind: "take",
    label: "Outgoing",
    srcStart: 0,
    srcEnd: 1,
    timelineStart: 0,
    timelineEnd: 1,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 0, end: 1 }],
    keeperIndex: 0,
    splitRatio: 0,
  },
  {
    id: "incoming",
    kind: "take",
    label: "Incoming",
    srcStart: 1,
    srcEnd: 2,
    timelineStart: 1,
    timelineEnd: 2,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 1, end: 2 }],
    keeperIndex: 1,
    splitRatio: 1,
    transitionIn: {
      type: "zoom-settle",
      durationSec: 0.4,
      amount: 0.025,
      easing: "natural",
    },
  },
];

function overlay(id: string, band: Overlay["band"], zIndex: number): Overlay {
  return {
    id,
    kind: "image",
    src: `/${id}.png`,
    naturalWidth: 400,
    naturalHeight: 300,
    timelineStart: 0,
    timelineEnd: 2,
    srcStart: 0,
    srcDuration: 0,
    transform: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
    zIndex,
    opacity: 1,
    band,
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
});

afterEach(cleanup);

test.each([
  { label: "endpoint fallback", playhead: 0.5, expectedId: "visible-face" },
  { label: "transition stored primary", playhead: 1.2, expectedId: "hidden-screen" },
  { label: "no visible selection", playhead: 0.5, expectedId: null },
] as const)(
  "$label routes Delete and Backspace to the settled effective primary",
  ({ playhead, expectedId }) => {
    const hidden = overlay("hidden-screen", "screen", 3);
    const visible = overlay("visible-face", "face", 1);
    const selectedIds = expectedId === null ? [hidden.id] : [visible.id, hidden.id];
    const removeOverlay = vi.fn();
    useRepurposeStore.setState({
      clips,
      duration: 2,
      playhead,
      overlays: [hidden, visible],
      selectedOverlayId: hidden.id,
      selectedOverlayIds: selectedIds,
      removeOverlay,
    });
    const { container } = render(<Timeline />);
    const timeline = container.firstElementChild as HTMLElement;

    for (const key of ["Delete", "Backspace"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(timeline, event);
      expect(event.defaultPrevented).toBe(expectedId !== null);
    }

    if (expectedId === null) expect(removeOverlay).not.toHaveBeenCalled();
    else expect(removeOverlay).toHaveBeenNthCalledWith(1, expectedId);
    if (expectedId !== null) expect(removeOverlay).toHaveBeenNthCalledWith(2, expectedId);
    expect(useRepurposeStore.getState().selectedOverlayId).toBe(hidden.id);
    expect(useRepurposeStore.getState().selectedOverlayIds).toEqual(selectedIds);
  }
);
