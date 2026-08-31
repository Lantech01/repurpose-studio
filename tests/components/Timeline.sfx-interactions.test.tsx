import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Timeline } from "@/app/repurpose-studio/_components/Timeline";
import { SfxPanel } from "@/app/repurpose-studio/_components/SfxPanel";
import { SFX_DRAG_MIME } from "@/lib/repurpose/sfx-drag";
import { createSfxImportOwner, registerSfxImportOwner, releaseSfxImportOwner } from "@/lib/repurpose/sfx-ingest-client";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, SfxClip } from "@/lib/repurpose/types";

vi.mock("@/app/repurpose-studio/_components/ClipBlock", () => ({ ClipBlock: () => null }));
vi.mock("@/app/repurpose-studio/_components/OverlayBlock", () => ({
  OverlayBlock: () => null,
  useOverlayThumbnails: () => new Map(),
}));
vi.mock("@/app/repurpose-studio/_components/TransportBar", () => ({ TransportBar: () => null }));
vi.mock("@/app/repurpose-studio/_components/useFaceWaveform", () => ({
  useFaceWaveform: () => null,
  useAudioWaveform: () => null,
  sliceClipPeaks: () => [],
}));

const scenes: Clip[] = [
  {
    id: "first", kind: "take", label: "First", srcStart: 0, srcEnd: 5,
    timelineStart: 0, timelineEnd: 5, kept: true, isKeeperTake: true,
    occurrences: [{ start: 0, end: 5 }], keeperIndex: 0,
  },
  {
    id: "second", kind: "take", label: "Second", srcStart: 5, srcEnd: 10,
    timelineStart: 5, timelineEnd: 10, kept: true, isKeeperTake: true,
    occurrences: [{ start: 5, end: 10 }], keeperIndex: 1,
  },
];

function effect(overrides: Partial<SfxClip> = {}): SfxClip {
  return {
    id: "effect", name: "Impact", source: { kind: "built-in", key: "ding" },
    origin: "manual", timelineStart: 1, sourceStart: 0, sourceEnd: 2,
    gain: 1, fadeInSec: 0, fadeOutSec: 0, muted: false, ...overrides,
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({ clips: scenes, duration: 10, sfxClips: [effect()], past: [], future: [] });
});

afterEach(cleanup);

describe("Timeline real SFX interactions", () => {
  it.each([
    { edge: "start", moveTo: 135, expected: { timelineStart: 1.5, sourceStart: 0.5, sourceEnd: 2 } },
    { edge: "end", moveTo: 225, expected: { timelineStart: 1, sourceStart: 0, sourceEnd: 1.5 } },
  ] as const)("commits one Undo entry for the $edge trim", ({ edge, moveTo, expected }) => {
    render(<Timeline />);
    const handle = screen.getByRole("button", { name: `Trim Impact ${edge}` });
    fireEvent.pointerDown(handle, { button: 0, clientX: edge === "start" ? 90 : 270 });
    fireEvent.pointerMove(window, { clientX: moveTo });
    fireEvent.pointerUp(window);

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(expected);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
  });

  it.each([
    { label: "leading", moveTo: 447, expectedStart: 5 },
    { label: "trailing", moveTo: 273, expectedStart: 3 },
  ])("snaps the $label body edge while translating the whole clip", ({ moveTo, expectedStart }) => {
    render(<Timeline />);
    const body = screen.getByRole("button", { name: /Select Impact/ });
    fireEvent.pointerDown(body, { button: 0, clientX: 90 });
    fireEvent.pointerMove(window, { clientX: moveTo });
    fireEvent.pointerUp(window);

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
      timelineStart: expectedStart,
      sourceStart: 0,
      sourceEnd: 2,
    });
  });

  it("rolls a live body drag back on pointer cancellation and unmount", () => {
    const first = render(<Timeline />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select Impact/ }), { button: 0, clientX: 90 });
    fireEvent.pointerMove(window, { clientX: 180 });
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(2);
    fireEvent.pointerCancel(window);
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(1);
    expect(useRepurposeStore.getState().past).toEqual([]);

    fireEvent.pointerDown(screen.getByRole("button", { name: /Select Impact/ }), { button: 0, clientX: 90 });
    fireEvent.pointerMove(window, { clientX: 180 });
    first.unmount();
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(1);
    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  it("accepts built-in and project-import internal drops without changing overlays", () => {
    const overlays = [{
      id: "overlay", kind: "image" as const, src: "/overlay.png", naturalWidth: 10,
      naturalHeight: 10, timelineStart: 0, timelineEnd: 1, srcStart: 0, srcDuration: 0,
      transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 }, zIndex: 0, opacity: 1,
      band: "screen" as const,
    }];
    useRepurposeStore.setState({
      sfxClips: [], overlays,
      sfxAssets: [{ id: "asset", name: "Imported", sourcePath: "C:\\audio\\hit.wav", srcDuration: 1 }],
    });
    render(<Timeline />);
    const target = screen.getByTestId("sfx-row").parentElement as HTMLElement;
    const drop = (payload: object, clientX: number) => {
      const dataTransfer = {
        types: [SFX_DRAG_MIME],
        files: [],
        getData: (type: string) => type === SFX_DRAG_MIME ? JSON.stringify(payload) : "",
        dropEffect: "none",
      };
      const event = createEvent.drop(target, { dataTransfer });
      Object.defineProperty(event, "clientX", { value: clientX });
      fireEvent(target, event);
    };

    drop({ builtInKey: "ding" }, 90);
    drop({ assetId: "asset" }, 180);

    expect(useRepurposeStore.getState().sfxClips).toEqual([
      expect.objectContaining({ timelineStart: 1, source: { kind: "built-in", key: "ding" } }),
      expect.objectContaining({ timelineStart: 2, source: { kind: "imported", assetId: "asset", srcDuration: 1 } }),
    ]);
    expect(useRepurposeStore.getState().overlays).toBe(overlays);
  });

  it("selects a focused block so Duplicate targets it and restores focus to the copy", async () => {
    useRepurposeStore.setState({
      sfxClips: [
        effect({ id: "first", name: "First" }),
        effect({ id: "focused", name: "Focused", timelineStart: 4 }),
      ],
      selectedSfxClipId: null,
      past: [],
      future: [],
    });
    render(<Timeline />);
    const focused = screen.getByRole("button", { name: /Select Focused/ });

    focused.focus();
    expect(useRepurposeStore.getState().selectedSfxClipId).toBe("focused");
    fireEvent.keyDown(focused, { key: "d", code: "KeyD", ctrlKey: true });

    await waitFor(() => expect(useRepurposeStore.getState().sfxClips).toHaveLength(3));
    const copyId = useRepurposeStore.getState().selectedSfxClipId as string;
    expect(useRepurposeStore.getState().sfxClips.find((clip) => clip.id === copyId)).toMatchObject({
      name: "Focused",
      source: { kind: "built-in", key: "ding" },
    });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-sfx-select-id", copyId));
  });

  it("deletes a middle clip, selects the nearest survivor, and focuses its selection control", async () => {
    useRepurposeStore.setState({
      sfxClips: [
        effect({ id: "first", name: "First", timelineStart: 0 }),
        effect({ id: "middle", name: "Middle", timelineStart: 3 }),
        effect({ id: "last", name: "Last", timelineStart: 6 }),
      ],
      selectedSfxClipId: null,
      past: [],
      future: [],
    });
    render(<Timeline />);
    const middle = screen.getByRole("button", { name: /Select Middle/ });
    middle.focus();

    fireEvent.keyDown(middle, { key: "Delete", code: "Delete" });

    await waitFor(() => expect(useRepurposeStore.getState().selectedSfxClipId).toBe("last"));
    expect(useRepurposeStore.getState().sfxClips.map((clip) => clip.id)).toEqual(["first", "last"]);
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-sfx-select-id", "last"));
  });

  it("focuses the labelled SFX row fallback after deleting the final clip", async () => {
    render(<Timeline />);
    const selection = screen.getByRole("button", { name: /Select Impact/ });
    selection.focus();

    fireEvent.keyDown(selection, { key: "Delete", code: "Delete" });

    await waitFor(() => expect(useRepurposeStore.getState().sfxClips).toEqual([]));
    const row = screen.getByRole("region", { name: "Sound effects timeline" });
    await waitFor(() => expect(row).toHaveFocus());
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("retains selection-control focus after replacing from the SFX panel", async () => {
    const owner = registerSfxImportOwner(createSfxImportOwner("focus-project"));
    useRepurposeStore.setState({ selectedSfxClipId: "effect" });
    try {
      render(<><Timeline /><SfxPanel projectId="focus-project" sfxImportOwner={owner} /></>);
      screen.getByRole("button", { name: /Select Impact/ }).focus();

      const replace = screen.getByRole("button", { name: "Replace Impact with Mouse Click" });
      replace.focus();
      fireEvent.click(replace);

      await waitFor(() => expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
        id: "effect",
        name: "Mouse Click",
        source: { kind: "built-in", key: "mouse_click" },
      }));
      await waitFor(() => expect(document.activeElement).toHaveAttribute("data-sfx-select-id", "effect"));
    } finally {
      releaseSfxImportOwner(owner);
    }
  });
});
