import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Timeline } from "@/app/repurpose-studio/_components/Timeline";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, SfxClip } from "@/lib/repurpose/types";

vi.mock("@/app/repurpose-studio/_components/OverlayBlock", () => ({
  OverlayBlock: () => null,
  useOverlayThumbnails: () => new Map(),
}));
vi.mock("@/app/repurpose-studio/_components/TransportBar", () => ({ TransportBar: () => null }));
vi.mock("@/app/repurpose-studio/_components/useFaceWaveform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/repurpose-studio/_components/useFaceWaveform")>(),
  useFaceWaveform: () => null,
  useAudioWaveform: () => null,
  sliceClipPeaks: () => [],
}));
vi.mock("@/app/repurpose-studio/_components/useSfxWaveform", () => ({
  useSfxWaveform: () => null,
}));

const scene: Clip = {
  id: "scene",
  kind: "take",
  label: "Scene",
  srcStart: 0,
  srcEnd: 4,
  timelineStart: 0,
  timelineEnd: 4,
  kept: true,
  isKeeperTake: true,
  occurrences: [{ start: 0, end: 4 }],
  keeperIndex: 0,
};

const effect: SfxClip = {
  id: "effect",
  name: "Impact",
  source: { kind: "built-in", key: "ding" },
  origin: "manual",
  timelineStart: 1,
  sourceStart: 0,
  sourceEnd: 1,
  gain: 1,
  fadeInSec: 0,
  fadeOutSec: 0,
  muted: false,
};

function installPointerCapture(element: HTMLElement) {
  let captured: number | null = null;
  const setPointerCapture = vi.fn((pointerId: number) => { captured = pointerId; });
  const releasePointerCapture = vi.fn((pointerId: number) => {
    if (captured === pointerId) captured = null;
  });
  Object.defineProperties(element, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: (pointerId: number) => captured === pointerId },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { setPointerCapture, releasePointerCapture };
}

function wordBody(): HTMLElement {
  const body = document.querySelector('[data-clip-id="scene"]') as HTMLElement;
  Object.defineProperty(body, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 360, 40),
  });
  return body;
}

function sfxBody(): HTMLElement {
  return screen.getByRole("button", { name: /Select Impact/ });
}

function playhead(): HTMLElement {
  return screen.getByLabelText("Playhead");
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({
    clips: [scene],
    duration: 4,
    words: [
      { text: "one", start: 0, end: 1 },
      { text: "two", start: 1, end: 2 },
      { text: "three", start: 2, end: 3 },
      { text: "four", start: 3, end: 4 },
    ],
    sfxClips: [effect],
    past: [],
    future: [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Timeline word-range pointer ownership", () => {
  it("does not let a secondary word pointer steal an active SFX drag", () => {
    render(<Timeline />);
    const words = wordBody();
    const sfx = sfxBody();
    installPointerCapture(words);
    installPointerCapture(sfx);

    fireEvent.pointerDown(sfx, { button: 0, clientX: 90, pointerId: 1 });
    fireEvent.pointerDown(words, { button: 0, clientX: 20, pointerId: 2 });
    fireEvent.pointerMove(words, { clientX: 120, pointerId: 2 });
    fireEvent.pointerUp(words, { pointerId: 2 });

    expect(useRepurposeStore.getState().selectedWordRange).toBeNull();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect);

    fireEvent.pointerMove(window, { clientX: 180, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(2);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it.each([
    ["SFX", () => sfxBody()],
    ["scene trim", () => document.querySelector('[data-clip-id="scene"] [data-trim-edge="start"]') as HTMLElement],
    ["playhead", () => playhead()],
  ])("does not let a secondary %s drag steal an active word range", (_label, secondaryTarget) => {
    render(<Timeline />);
    const words = wordBody();
    const secondary = secondaryTarget();
    installPointerCapture(words);
    installPointerCapture(secondary);

    fireEvent.pointerDown(words, { button: 0, clientX: 20, pointerId: 10 });
    fireEvent.pointerDown(secondary, { button: 0, clientX: 270, pointerId: 11 });
    fireEvent.pointerMove(window, { clientX: 360, pointerId: 11 });
    fireEvent.pointerUp(window, { pointerId: 11 });
    fireEvent.pointerCancel(window, { pointerId: 11 });

    expect(useRepurposeStore.getState()).toMatchObject({
      playhead: 0,
      selectedWordRange: null,
      sfxClips: [expect.objectContaining(effect)],
      clips: [expect.objectContaining(scene)],
      past: [],
    });

    fireEvent.pointerMove(words, { clientX: 120, pointerId: 10 });
    fireEvent.pointerUp(words, { pointerId: 10 });
    expect(useRepurposeStore.getState().selectedWordRange).toEqual({ lo: 0, hi: 1 });
  });

  it("ignores a second word pointer and all of its move/up/cancel events", () => {
    render(<Timeline />);
    const words = wordBody();
    const capture = installPointerCapture(words);

    fireEvent.pointerDown(words, { button: 0, clientX: 20, pointerId: 21 });
    fireEvent.pointerDown(words, { button: 0, clientX: 220, pointerId: 22 });
    fireEvent.pointerMove(words, { clientX: 320, pointerId: 22 });
    fireEvent.pointerUp(words, { pointerId: 22 });
    fireEvent.pointerCancel(words, { pointerId: 22 });

    expect(useRepurposeStore.getState().selectedWordRange).toBeNull();
    expect(capture.releasePointerCapture).not.toHaveBeenCalledWith(22);

    fireEvent.pointerMove(words, { clientX: 120, pointerId: 21 });
    fireEvent.pointerUp(words, { pointerId: 21 });

    expect(useRepurposeStore.getState().selectedWordRange).toEqual({ lo: 0, hi: 1 });
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(21);
  });

  it("restores selection on owner cancel and permits sequential word and timeline gestures", () => {
    useRepurposeStore.setState({ selectedWordRange: { lo: 1, hi: 1 } });
    render(<Timeline />);
    const words = wordBody();
    const capture = installPointerCapture(words);

    fireEvent.pointerDown(words, { button: 0, clientX: 20, pointerId: 31 });
    fireEvent.pointerMove(words, { clientX: 320, pointerId: 31 });
    expect(useRepurposeStore.getState().selectedWordRange).toEqual({ lo: 0, hi: 3 });
    fireEvent.pointerCancel(words, { pointerId: 31 });

    expect(useRepurposeStore.getState().selectedWordRange).toEqual({ lo: 1, hi: 1 });
    expect(useRepurposeStore.getState().playhead).toBe(0);
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(31);

    fireEvent.pointerDown(words, { button: 0, clientX: 20, pointerId: 32 });
    fireEvent.pointerMove(words, { clientX: 120, pointerId: 32 });
    fireEvent.pointerUp(words, { pointerId: 32 });
    expect(useRepurposeStore.getState().selectedWordRange).toEqual({ lo: 0, hi: 1 });

    const sfx = sfxBody();
    installPointerCapture(sfx);
    fireEvent.pointerDown(sfx, { button: 0, clientX: 90, pointerId: 33 });
    fireEvent.pointerMove(window, { clientX: 180, pointerId: 33 });
    fireEvent.pointerUp(window, { pointerId: 33 });
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(2);
  });

  it("retains ownership through a zoom rerender and releases it when the clip unmounts", () => {
    render(<Timeline />);
    const words = wordBody();
    const capture = installPointerCapture(words);

    fireEvent.pointerDown(words, { button: 0, clientX: 20, pointerId: 41 });
    fireEvent.click(screen.getByTitle("Zoom in"));
    fireEvent.pointerMove(words, { clientX: 120, pointerId: 41 });
    fireEvent.pointerUp(words, { pointerId: 41 });
    expect(useRepurposeStore.getState().selectedWordRange).toEqual({ lo: 0, hi: 1 });

    fireEvent.pointerDown(words, { button: 0, clientX: 20, pointerId: 42 });
    act(() => useRepurposeStore.setState({ clips: [] }));
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(42);

    const sfx = sfxBody();
    installPointerCapture(sfx);
    fireEvent.pointerDown(sfx, { button: 0, clientX: 90, pointerId: 43 });
    fireEvent.pointerMove(window, { clientX: 180, pointerId: 43 });
    fireEvent.pointerUp(window, { pointerId: 43 });
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBeCloseTo(1.8);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });
});
