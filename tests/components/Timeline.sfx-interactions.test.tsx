import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Timeline } from "@/app/repurpose-studio/_components/Timeline";
import { SfxPanel } from "@/app/repurpose-studio/_components/SfxPanel";
import { SFX_DRAG_MIME } from "@/lib/repurpose/sfx-drag";
import { createSfxImportOwner, registerSfxImportOwner, releaseSfxImportOwner } from "@/lib/repurpose/sfx-ingest-client";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, Overlay, SfxClip } from "@/lib/repurpose/types";

vi.mock("@/app/repurpose-studio/_components/ClipBlock", () => ({
  ClipBlock: ({ clip, onDragBodyStart, onDragEdgeStart }: {
    clip: Clip;
    onDragBodyStart: (clip: Clip, pointer: { clientX: number; pointerId: number; captureTarget: HTMLDivElement }) => void;
    onDragEdgeStart: (clip: Clip, edge: "start" | "end", pointer: { clientX: number; pointerId: number; captureTarget: HTMLButtonElement }) => void;
  }) => <div data-testid={`scene-body-${clip.id}`} onPointerDown={(event) => {
    event.stopPropagation();
    onDragBodyStart(clip, { clientX: event.clientX, pointerId: event.pointerId, captureTarget: event.currentTarget });
  }}>
    <button data-testid={`scene-trim-${clip.id}`} onPointerDown={(event) => {
      event.stopPropagation();
      onDragEdgeStart(clip, "start", { clientX: event.clientX, pointerId: event.pointerId, captureTarget: event.currentTarget });
    }} />
  </div>,
}));
vi.mock("@/app/repurpose-studio/_components/OverlayBlock", () => ({
  OverlayBlock: ({ overlay, onDragBodyStart, onDragEdgeStart }: {
    overlay: Overlay;
    onDragBodyStart: (overlay: Overlay, pointer: { clientX: number; pointerId: number; captureTarget: HTMLDivElement }) => void;
    onDragEdgeStart: (overlay: Overlay, edge: "start" | "end", pointer: { clientX: number; pointerId: number; captureTarget: HTMLButtonElement }) => void;
  }) => <div data-testid={`overlay-body-${overlay.id}`} onPointerDown={(event) => {
    event.stopPropagation();
    onDragBodyStart(overlay, { clientX: event.clientX, pointerId: event.pointerId, captureTarget: event.currentTarget });
  }}>
    <button data-testid={`overlay-trim-${overlay.id}`} onPointerDown={(event) => {
      event.stopPropagation();
      onDragEdgeStart(overlay, "start", { clientX: event.clientX, pointerId: event.pointerId, captureTarget: event.currentTarget });
    }} />
  </div>,
  useOverlayThumbnails: () => new Map(),
}));
vi.mock("@/app/repurpose-studio/_components/TransportBar", () => ({ TransportBar: () => null }));
vi.mock("@/app/repurpose-studio/_components/useFaceWaveform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/repurpose-studio/_components/useFaceWaveform")>(),
  useFaceWaveform: () => null,
  useAudioWaveform: () => null,
  sliceClipPeaks: () => [],
}));
const useSfxWaveformMock = vi.hoisted(() => vi.fn().mockReturnValue(null));
vi.mock("@/app/repurpose-studio/_components/useSfxWaveform", () => ({
  useSfxWaveform: useSfxWaveformMock,
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

function overlay(): Overlay {
  return {
    id: "overlay",
    kind: "image",
    src: "/overlay.png",
    naturalWidth: 100,
    naturalHeight: 100,
    timelineStart: 1,
    timelineEnd: 3,
    srcStart: 0,
    srcDuration: 0,
    transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    band: "screen",
  };
}

function rulerWithPointerCapture(): HTMLElement {
  const rulerLabel = screen.getByText("0:00");
  const timelineContent = rulerLabel.parentElement?.parentElement?.parentElement as HTMLElement;
  Object.defineProperties(timelineContent, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn().mockReturnValue(true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  return rulerLabel;
}

beforeEach(() => {
  useSfxWaveformMock.mockClear();
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
    const handle = screen.getByRole("slider", { name: `Trim Impact ${edge}` });
    fireEvent.pointerDown(handle, { button: 0, clientX: edge === "start" ? 90 : 270 });
    fireEvent.pointerMove(window, { clientX: moveTo });
    fireEvent.pointerUp(window);

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(expected);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
  });

  it("keeps a body drag owned by its initiating pointer through move, up, and cancel", () => {
    render(<Timeline />);
    const body = screen.getByRole("button", { name: /Select Impact/ });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(body, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: (pointerId: number) => pointerId === 11 },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    fireEvent.pointerDown(body, { button: 0, clientX: 90, pointerId: 11 });
    fireEvent.pointerMove(window, { clientX: 180, pointerId: 22 });
    fireEvent.pointerUp(window, { pointerId: 22 });
    fireEvent.pointerCancel(window, { pointerId: 22 });

    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(1);
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(releasePointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { clientX: 180, pointerId: 11 });
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(2);
    fireEvent.pointerUp(window, { pointerId: 11 });

    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(setPointerCapture).toHaveBeenCalledWith(11);
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
  });

  it("keeps a trim drag owned by its initiating pointer through move, up, and cancel", () => {
    render(<Timeline />);
    const handle = screen.getByRole("slider", { name: "Trim Impact start" });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(handle, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: (pointerId: number) => pointerId === 31 },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });

    fireEvent.pointerDown(handle, { button: 0, clientX: 90, pointerId: 31 });
    fireEvent.pointerMove(window, { clientX: 180, pointerId: 32 });
    fireEvent.pointerUp(window, { pointerId: 32 });
    fireEvent.pointerCancel(window, { pointerId: 32 });

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(releasePointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { clientX: 135, pointerId: 31 });
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({
      timelineStart: 1.5,
      sourceStart: 0.5,
    });
    fireEvent.pointerUp(window, { pointerId: 31 });

    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(setPointerCapture).toHaveBeenCalledWith(31);
    expect(releasePointerCapture).toHaveBeenCalledWith(31);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
  });

  it.each([
    ["ruler", () => screen.getByText("0:00")],
    ["scene body", () => screen.getByTestId("scene-body-first")],
    ["scene trim", () => screen.getByTestId("scene-trim-first")],
    ["overlay body", () => screen.getByTestId("overlay-body-overlay")],
    ["overlay trim", () => screen.getByTestId("overlay-trim-overlay")],
    ["another SFX trim", () => screen.getByRole("slider", { name: "Trim Other start" })],
  ])("does not let a secondary %s pointerdown steal an active SFX drag", (_label, secondaryTarget) => {
    useRepurposeStore.setState({
      overlays: [overlay()],
      sfxClips: [effect(), effect({ id: "other", name: "Other", timelineStart: 4 })],
      past: [],
      future: [],
    });
    render(<Timeline />);
    rulerWithPointerCapture();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Select Impact/ }), {
      button: 0,
      clientX: 90,
      pointerId: 101,
    });
    fireEvent.pointerDown(secondaryTarget(), { button: 0, clientX: 360, pointerId: 202 });
    fireEvent.pointerMove(window, { clientX: 450, pointerId: 202 });
    fireEvent.pointerUp(window, { pointerId: 202 });
    fireEvent.pointerCancel(window, { pointerId: 202 });

    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
    expect(useRepurposeStore.getState().past).toEqual([]);

    fireEvent.pointerMove(window, { clientX: 180, pointerId: 101 });
    fireEvent.pointerUp(window, { pointerId: 101 });

    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(2);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
  });

  it("keeps a playhead owner from an SFX secondary and allows a new gesture after completion", () => {
    render(<Timeline />);
    const ruler = rulerWithPointerCapture();

    fireEvent.pointerDown(ruler, { button: 0, clientX: 90, pointerId: 301 });
    expect(useRepurposeStore.getState().playhead).toBe(1);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Select Impact/ }), {
      button: 0,
      clientX: 90,
      pointerId: 302,
    });
    fireEvent.pointerMove(window, { clientX: 360, pointerId: 302 });
    fireEvent.pointerUp(window, { pointerId: 302 });
    fireEvent.pointerCancel(window, { pointerId: 302 });

    expect(useRepurposeStore.getState().playhead).toBe(1);
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());

    fireEvent.pointerMove(window, { clientX: 180, pointerId: 301 });
    fireEvent.pointerUp(window, { pointerId: 301 });
    expect(useRepurposeStore.getState().playhead).toBe(2);

    fireEvent.pointerDown(screen.getByRole("button", { name: /Select Impact/ }), {
      button: 0,
      clientX: 90,
      pointerId: 303,
    });
    fireEvent.pointerMove(window, { clientX: 180, pointerId: 303 });
    fireEvent.pointerUp(window, { pointerId: 303 });

    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBe(2);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
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

  it("moves and trims from the keyboard with one Undo step per keypress", () => {
    render(<Timeline />);
    const selection = screen.getByRole("button", { name: /Select Impact/ });

    fireEvent.keyDown(selection, { key: "ArrowRight" });
    expect(useRepurposeStore.getState().sfxClips[0].timelineStart).toBeCloseTo(1 + 1 / 30);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());

    const start = screen.getByRole("slider", { name: "Trim Impact start" });
    fireEvent.keyDown(start, { key: "ArrowRight" });
    const leftTrimmed = useRepurposeStore.getState().sfxClips[0];
    expect(leftTrimmed.timelineStart).toBeCloseTo(1 + 1 / 30);
    expect(leftTrimmed.sourceStart).toBeCloseTo(1 / 30);
    expect(leftTrimmed.timelineStart + leftTrimmed.sourceEnd - leftTrimmed.sourceStart).toBeCloseTo(3);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();

    const end = screen.getByRole("slider", { name: "Trim Impact end" });
    fireEvent.keyDown(end, { key: "ArrowLeft" });
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({ timelineStart: 1 });
    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBeCloseTo(2 - 1 / 30);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject(effect());
  });

  it("requests an SFX waveform only for the selected placed source", () => {
    useRepurposeStore.setState({
      sfxClips: [
        effect({ id: "unselected", name: "Unselected", source: { kind: "built-in", key: "ding" } }),
        effect({ id: "selected", name: "Selected", source: { kind: "built-in", key: "whoosh" } }),
      ],
      selectedSfxClipId: "selected",
    });

    render(<Timeline />);

    const enabledCalls = useSfxWaveformMock.mock.calls.filter((call) => call[1] === true);
    expect(enabledCalls).toHaveLength(1);
    expect(enabledCalls[0][0]).toContain("whoosh");
  });

  it("stops an older multi-file drop after a newer batch aborts its active file", async () => {
    const owner = registerSfxImportOwner(createSfxImportOwner("batch-project"));
    const uploads: string[] = [];
    let oldStarted!: () => void;
    const oldStartedPromise = new Promise<void>((resolve) => { oldStarted = resolve; });
    class AudioContextMock {
      decodeAudioData = vi.fn().mockResolvedValue({ duration: 1 });
      close = vi.fn().mockResolvedValue(undefined);
    }
    vi.stubGlobal("AudioContext", AudioContextMock);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/repurpose/asset") {
        const file = (init?.body as FormData).get("file") as File;
        uploads.push(file.name);
        if (file.name === "old-first.wav") {
          oldStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        }
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          path: `C:\\audio\\${file.name}`,
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(new ArrayBuffer(4), { status: 200 }));
    }));
    try {
      useRepurposeStore.setState({ sfxClips: [], past: [], future: [] });
      render(<Timeline sfxImportOwner={owner} />);
      const target = screen.getByTestId("sfx-row").parentElement as HTMLElement;
      const drop = (files: File[]) => {
        const event = createEvent.drop(target, {
          dataTransfer: { types: ["Files"], files, getData: () => "", dropEffect: "none" },
        });
        Object.defineProperty(event, "clientX", { value: 90 });
        fireEvent(target, event);
      };

      drop([
        new File(["x"], "old-first.wav", { type: "audio/wav" }),
        new File(["x"], "old-second.wav", { type: "audio/wav" }),
      ]);
      await oldStartedPromise;
      drop([new File(["x"], "new.wav", { type: "audio/wav" })]);

      await waitFor(() => expect(useRepurposeStore.getState().sfxClips).toEqual([
        expect.objectContaining({ name: "new.wav" }),
      ]));
      expect(uploads).toEqual(["old-first.wav", "new.wav"]);
    } finally {
      releaseSfxImportOwner(owner);
      vi.unstubAllGlobals();
    }
  });
});
