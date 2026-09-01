import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SelectionOverlay } from "@/app/repurpose-studio/_components/SelectionOverlay";
import { resolveOverlayTransformForFrame } from "@/lib/repurpose/overlay-geometry";
import { resolveOverlayAppearanceAt } from "@/lib/repurpose/overlay-effects";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Overlay } from "@/lib/repurpose/types";

const selected: Overlay = {
  id: "selected",
  kind: "image",
  src: "/selected.png",
  naturalWidth: 400,
  naturalHeight: 300,
  timelineStart: 0,
  timelineEnd: 10,
  srcStart: 0,
  srcDuration: 0,
  transform: { x: 0.5, y: 0.2, scale: 0.4, rotation: 0 },
  zIndex: 0,
  opacity: 1,
  band: "screen",
};

let frame: FrameRequestCallback | undefined;

function frameSnapshot(
  splitRatio: number,
  rect = { left: 0, top: 0, width: 900, height: 1600 }
) {
  const { overlays, playhead } = useRepurposeStore.getState();
  return {
    outputTime: playhead,
    splitRatio,
    appearances: new Map(
      overlays.map((overlay) => [
        overlay.id,
        resolveOverlayAppearanceAt(overlay, playhead, rect, splitRatio),
      ])
    ),
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
  });
  frame = undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("does not render selection chrome for an overlay in a hidden band", () => {
  const before = { ...selected.transform };
  render(
    <SelectionOverlay
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0)}
      beginHandleGesture={vi.fn()}
      adjustHandleByKeyboard={vi.fn()}
    />
  );
  act(() => frame?.(0));

  expect(screen.queryByTitle(/Rotate/)).not.toBeInTheDocument();
  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(before);
});

test("renders selection chrome when the overlay band is visible", () => {
  render(
    <SelectionOverlay
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0.5)}
      beginHandleGesture={vi.fn()}
      adjustHandleByKeyboard={vi.fn()}
    />
  );
  act(() => frame?.(0));
  expect(screen.getByTitle(/Rotate/)).toBeInTheDocument();
});

test("exposes named keyboard-operable resize and rotation handles", () => {
  const adjustHandleByKeyboard = vi.fn();
  const parentKeyDown = vi.fn();
  render(
    <div onKeyDown={parentKeyDown}>
      <SelectionOverlay
        getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
        getFrameSnapshot={() => frameSnapshot(0.5)}
        beginHandleGesture={vi.fn()}
        adjustHandleByKeyboard={adjustHandleByKeyboard}
      />
    </div>
  );
  act(() => frame?.(0));

  expect(screen.getAllByRole("button", { name: /Resize overlay/ })).toHaveLength(8);
  const east = screen.getByRole("button", { name: "Resize overlay east" });
  const rotate = screen.getByRole("button", { name: "Rotate overlay" });
  fireEvent.keyDown(east, { key: "ArrowRight" });
  fireEvent.keyDown(rotate, { key: "ArrowRight", shiftKey: true });

  expect(adjustHandleByKeyboard).toHaveBeenNthCalledWith(1, "e", "ArrowRight", false);
  expect(adjustHandleByKeyboard).toHaveBeenNthCalledWith(2, "rotate", "ArrowRight", true);
  expect(parentKeyDown).not.toHaveBeenCalled();
});

test.each([
  {
    label: "endpoint fallback",
    split: 0,
    storedBand: "screen" as const,
    expectedBand: "face" as const,
  },
  {
    label: "transition stored-primary preference",
    split: 0.4,
    storedBand: "screen" as const,
    expectedBand: "screen" as const,
  },
])(
  "binds primary handles to the shared effective primary for $label",
  ({ split, storedBand, expectedBand }) => {
    const hiddenOrPrimary = {
      ...selected,
      id: "stored-primary",
      band: storedBand,
      transform: { ...selected.transform, x: 0.8 },
    };
    const firstSelected = {
      ...selected,
      id: "first-selected",
      band: expectedBand === "screen" ? ("free" as const) : expectedBand,
      transform: { ...selected.transform, x: 0.2 },
    };
    const secondVisible = {
      ...selected,
      id: "second-visible",
      band: "free" as const,
      transform: { ...selected.transform, x: 0.5 },
    };
    const selectedIds = [firstSelected.id, secondVisible.id, hiddenOrPrimary.id];
    useRepurposeStore.setState({
      overlays: [hiddenOrPrimary, secondVisible, firstSelected],
      selectedOverlayId: hiddenOrPrimary.id,
      selectedOverlayIds: selectedIds,
    });
    render(
      <SelectionOverlay
        getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
        getFrameSnapshot={() => frameSnapshot(split)}
        beginHandleGesture={vi.fn()}
        adjustHandleByKeyboard={vi.fn()}
      />
    );
    act(() => frame?.(0));

    const expectedId = split === 0 ? firstSelected.id : hiddenOrPrimary.id;
    expect(screen.getByTitle(/Rotate/).parentElement).toHaveAttribute(
      "data-overlay-id",
      expectedId
    );
    expect(useRepurposeStore.getState().selectedOverlayId).toBe(
      hiddenOrPrimary.id
    );
    expect(useRepurposeStore.getState().selectedOverlayIds).toEqual(selectedIds);
  }
);

test.each([
  { band: "screen" as const, split: 0.2 },
  { band: "face" as const, split: 0.8 },
  { band: "free" as const, split: 0.2 },
])("positions $band selection chrome at the frame-resolved transform", ({ band, split }) => {
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const persisted: Overlay = {
    ...selected,
    id: `selected-${band}`,
    band,
    transform: { x: 0.5, y: 0.5, scale: 1.4, rotation: 37 },
  };
  const before = { ...persisted.transform };
  useRepurposeStore.setState({
    overlays: [persisted],
    selectedOverlayId: persisted.id,
    selectedOverlayIds: [persisted.id],
  });
  render(
    <SelectionOverlay
      getRect={() => rect}
      getFrameSnapshot={() => frameSnapshot(split, rect)}
      beginHandleGesture={vi.fn()}
      adjustHandleByKeyboard={vi.fn()}
    />
  );
  act(() => frame?.(0));

  const box = screen.getByTitle(/Rotate/).parentElement as HTMLDivElement;
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(
    box.style.transform
  );
  const resolved = resolveOverlayTransformForFrame(persisted, rect, split);
  const expectedTop =
    resolved.y * rect.height -
    (resolved.scale * rect.width * persisted.naturalHeight) /
      persisted.naturalWidth /
      2;
  expect(Number(match?.[2])).toBeCloseTo(expectedTop, 10);
  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(before);
});

test.each([
  { type: "zoom" as const, direction: undefined },
  { type: "pop" as const, direction: undefined },
  { type: "slide" as const, direction: "right" as const },
])("positions selection chrome from the animated $type appearance", ({ type, direction }) => {
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const animated: Overlay = {
    ...selected,
    id: `animated-${type}`,
    band: "free",
    entranceEffect: { type, durationSec: 1, direction },
  };
  useRepurposeStore.setState({
    overlays: [animated],
    selectedOverlayId: animated.id,
    selectedOverlayIds: [animated.id],
    playhead: 0.5,
  });
  render(
    <SelectionOverlay
      getRect={() => rect}
      getFrameSnapshot={() => frameSnapshot(0.5, rect)}
      beginHandleGesture={vi.fn()}
      adjustHandleByKeyboard={vi.fn()}
    />
  );
  act(() => frame?.(0));

  const appearance = resolveOverlayAppearanceAt(animated, 0.5, rect, 0.5);
  const box = screen.getByTitle(/Rotate/).parentElement as HTMLDivElement;
  expect(parseFloat(box.style.width)).toBeCloseTo(
    appearance.transform.scale * rect.width,
    10
  );
  expect(box.style.transform).toContain(
    `translate(${appearance.transform.x * rect.width - parseFloat(box.style.width) / 2}px`
  );
});

test("removes selection chrome at the animation opacity cutoff without clearing selection", () => {
  const invisible: Overlay = {
    ...selected,
    id: "invisible-selected",
    band: "free",
    entranceEffect: { type: "fade", durationSec: 1 },
  };
  useRepurposeStore.setState({
    overlays: [invisible],
    selectedOverlayId: invisible.id,
    selectedOverlayIds: [invisible.id],
    playhead: 0.1,
  });
  render(
    <SelectionOverlay
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0.5)}
      beginHandleGesture={vi.fn()}
      adjustHandleByKeyboard={vi.fn()}
    />
  );
  act(() => frame?.(0));

  expect(screen.queryByTitle(/Rotate/)).not.toBeInTheDocument();
  expect(useRepurposeStore.getState().selectedOverlayId).toBe(invisible.id);
  expect(useRepurposeStore.getState().selectedOverlayIds).toEqual([invisible.id]);
});

test("uses the compositor frame snapshot when store playhead disagrees", () => {
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const animated: Overlay = {
    ...selected,
    id: "snapshot-selected",
    band: "free",
    entranceEffect: { type: "slide", durationSec: 1, direction: "right" },
  };
  const appearance = resolveOverlayAppearanceAt(animated, 0.6, rect, 0.5);
  useRepurposeStore.setState({
    overlays: [animated],
    selectedOverlayId: animated.id,
    selectedOverlayIds: [animated.id],
    playhead: 0,
  });
  render(
    <SelectionOverlay
      getRect={() => rect}
      getFrameSnapshot={() => ({
        outputTime: 0.6,
        splitRatio: 0.5,
        appearances: new Map([[animated.id, appearance]]),
      })}
      beginHandleGesture={vi.fn()}
      adjustHandleByKeyboard={vi.fn()}
    />
  );
  act(() => frame?.(0));

  const box = screen.getByTitle(/Rotate/).parentElement as HTMLDivElement;
  expect(box.style.transform).toContain(
    `translate(${appearance.transform.x * rect.width - parseFloat(box.style.width) / 2}px`
  );
});
