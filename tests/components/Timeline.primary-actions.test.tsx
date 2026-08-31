import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Timeline } from "@/app/repurpose-studio/_components/Timeline";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { createSfxImportOwner, registerSfxImportOwner, releaseSfxImportOwner } from "@/lib/repurpose/sfx-ingest-client";
import type { Clip, Overlay, SfxClip } from "@/lib/repurpose/types";

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
vi.mock("@/app/repurpose-studio/_components/SfxClipBlock", () => ({
  SfxClipBlock: ({ clip, top, onSelect, onBodyPointerDown }: { clip: SfxClip; top: number; onSelect: (id: string) => void; onBodyPointerDown: (clip: SfxClip, clientX: number) => void }) => (
    <button data-testid={`sfx-${clip.id}`} data-top={top} data-sfx-clip-id={clip.id} onClick={() => onSelect(clip.id)} onPointerDown={(event) => { event.stopPropagation(); onBodyPointerDown(clip, event.clientX); }}>{clip.name}</button>
  ),
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

test("renders overlapping SFX in deterministic mini-lanes and grows the row", () => {
  const sfx = (id: string, start: number, end: number): SfxClip => ({
    id, name: id, source: { kind: "built-in", key: "ding" }, origin: "manual",
    timelineStart: start, sourceStart: 0, sourceEnd: end - start, gain: 1,
    fadeInSec: 0, fadeOutSec: 0, muted: false,
  });
  useRepurposeStore.setState({ duration: 5, sfxClips: [sfx("a", 0, 2), sfx("b", 1, 3), sfx("c", 2, 4)] });
  const { getByTestId } = render(<Timeline />);
  expect(getByTestId("sfx-a")).toHaveAttribute("data-top", "0");
  expect(getByTestId("sfx-b")).not.toHaveAttribute("data-top", "0");
  expect(getByTestId("sfx-c")).toHaveAttribute("data-top", "0");
  expect(getByTestId("sfx-row")).toHaveStyle({ height: "63px" });
});

test("Delete and Cmd+D target selected SFX before scene, word, and overlay paths", () => {
  const effect: SfxClip = {
    id: "sfx", name: "Hit", source: { kind: "built-in", key: "ding" }, origin: "manual",
    timelineStart: 0, sourceStart: 0, sourceEnd: 1, gain: 1, fadeInSec: 0,
    fadeOutSec: 0, muted: false,
  };
  const removeSfxClip = vi.fn();
  const duplicateSfxClip = vi.fn().mockReturnValue("copy");
  const deleteClip = vi.fn();
  const removeOverlay = vi.fn();
  useRepurposeStore.setState({
    duration: 2, clips, sfxClips: [effect], selectedSfxClipId: effect.id,
    selectedClipId: "incoming", selectedOverlayId: "overlay", selectedOverlayIds: ["overlay"],
    removeSfxClip, duplicateSfxClip, deleteClip, removeOverlay,
  });
  const { container } = render(<Timeline />);
  fireEvent.keyDown(container.firstElementChild!, { key: "Delete", code: "Delete" });
  useRepurposeStore.setState({ selectedSfxClipId: "sfx" });
  fireEvent.keyDown(container.firstElementChild!, { key: "d", code: "KeyD", ctrlKey: true });
  expect(removeSfxClip).toHaveBeenCalledWith("sfx");
  expect(duplicateSfxClip).toHaveBeenCalledWith("sfx");
  expect(deleteClip).not.toHaveBeenCalled();
  expect(removeOverlay).not.toHaveBeenCalled();
});

test("an SFX drag does not snap back to its own live edge", () => {
  const effect: SfxClip = {
    id: "sfx", name: "Hit", source: { kind: "built-in", key: "ding" }, origin: "manual",
    timelineStart: 0, sourceStart: 0, sourceEnd: 1, gain: 1, fadeInSec: 0,
    fadeOutSec: 0, muted: false,
  };
  useRepurposeStore.setState({ duration: 2, clips, sfxClips: [effect], snapEnabled: true });
  const { getByTestId } = render(<Timeline />);

  fireEvent.pointerDown(getByTestId("sfx-sfx"), { button: 0, clientX: 0 });
  fireEvent.pointerMove(window, { clientX: 10 });
  fireEvent.pointerMove(window, { clientX: 15 });
  fireEvent.pointerUp(window);

  expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBeCloseTo(15 / 90, 5);
});

test.each(["ogg", "aac"])("reports an unsupported .%s audio drop and allows a supported retry", async (extension) => {
  const owner = registerSfxImportOwner(createSfxImportOwner("timeline-project"));
  class AudioContextMock {
    decodeAudioData = vi.fn().mockResolvedValue({ duration: 1 });
    close = vi.fn().mockResolvedValue(undefined);
  }
  vi.stubGlobal("AudioContext", AudioContextMock);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, path: "C:\\audio\\retry.wav" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    .mockResolvedValueOnce(new Response(new ArrayBuffer(4), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  useRepurposeStore.setState({ clips, duration: 2 });
  const { getByTestId } = render(<Timeline sfxImportOwner={owner} />);
  const target = getByTestId("sfx-row").parentElement as HTMLElement;
  const dropFile = (file: File) => {
    const dataTransfer = { types: ["Files"], files: [file], getData: () => "", dropEffect: "none" };
    const event = createEvent.drop(target, { dataTransfer });
    Object.defineProperty(event, "clientX", { value: 0 });
    fireEvent(target, event);
  };

  dropFile(new File(["x"], `unsupported.${extension}`, { type: `audio/${extension}` }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
    new RegExp(`unsupported\\.${extension}.*choose a \\.wav, \\.mp3, or \\.m4a`, "i")
  ));
  expect(useRepurposeStore.getState().sfxClips).toEqual([]);
  expect(useRepurposeStore.getState().overlays).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();

  dropFile(new File(["x"], "retry.wav", { type: "audio/wav" }));
  await waitFor(() => {
    const retryError = screen.queryByRole("alert");
    if (retryError) throw new Error(retryError.textContent ?? "retry failed");
    expect(useRepurposeStore.getState().sfxClips).toHaveLength(1);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  releaseSfxImportOwner(owner);
  vi.unstubAllGlobals();
});
