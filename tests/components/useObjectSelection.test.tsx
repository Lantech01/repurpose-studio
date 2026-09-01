import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useObjectSelection } from "@/app/repurpose-studio/_components/useObjectSelection";
import {
  resolveOverlayTransformForFrame,
  solveEdgeResize,
  solveRotate,
} from "@/lib/repurpose/overlay-geometry";
import { resolveOverlayAppearanceAt } from "@/lib/repurpose/overlay-effects";
import { effectiveSplitRatio } from "@/lib/repurpose/split-ratio";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Overlay } from "@/lib/repurpose/types";
import type { PointerRoute } from "@/app/repurpose-studio/_components/useObjectSelection";

const rect = { left: 0, top: 0, width: 900, height: 1600 };
let lastRoute: PointerRoute | null = null;

function overlay(
  id: string,
  band: Overlay["band"],
  x: number,
  y: number,
  scale = 0.1
): Overlay {
  return {
    id,
    kind: "image",
    src: `/${id}.png`,
    naturalWidth: 100,
    naturalHeight: 100,
    timelineStart: 0,
    timelineEnd: 10,
    srcStart: 0,
    srcDuration: 0,
    transform: { x, y, scale, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    band,
  };
}

function Harness({
  ratio,
  getFrameSnapshot,
}: {
  ratio: number;
  getFrameSnapshot?: () => {
    outputTime: number;
    splitRatio: number;
    appearances: Map<string, ReturnType<typeof resolveOverlayAppearanceAt>>;
  };
}) {
  const selection = useObjectSelection({
    getRect: () => rect,
    getFrameSnapshot: getFrameSnapshot ?? (() => {
      const { overlays, playhead } = useRepurposeStore.getState();
      return {
        outputTime: playhead,
        splitRatio: ratio,
        appearances: new Map(
          overlays.map((candidate) => [
            candidate.id,
            resolveOverlayAppearanceAt(candidate, playhead, rect, ratio),
          ])
        ),
      };
    }),
  });
  return (
    <>
      <div
        data-testid="interaction"
        onPointerDown={(event) => {
          lastRoute = selection.routePointerDown(event);
        }}
      />
      <button
        data-testid="resize-e"
        onPointerDown={(event) => selection.beginHandleGesture("e", event)}
        onKeyDown={(event) =>
          selection.adjustHandleByKeyboard("e", event.key, event.shiftKey)
        }
      />
      <button
        data-testid="resize-n"
        onKeyDown={(event) =>
          selection.adjustHandleByKeyboard("n", event.key, event.shiftKey)
        }
      />
      <button
        data-testid="rotate"
        onPointerDown={(event) => selection.beginHandleGesture("rotate", event)}
        onKeyDown={(event) =>
          selection.adjustHandleByKeyboard("rotate", event.key, event.shiftKey)
        }
      />
    </>
  );
}

test("resizes and rotates the effective primary from keyboard handle arrows", () => {
  const selected = overlay("keyboard-handle", "free", 0.5, 0.5, 0.3);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
  });
  render(<Harness ratio={0.5} />);

  fireEvent.keyDown(screen.getByTestId("resize-e"), { key: "ArrowRight" });
  expect(useRepurposeStore.getState().overlays[0].transform.scale).toBeGreaterThan(0.3);

  fireEvent.keyDown(screen.getByTestId("rotate"), {
    key: "ArrowRight",
    shiftKey: true,
  });
  expect(useRepurposeStore.getState().overlays[0].transform.rotation).toBe(15);
});

test.each([
  { control: "resize-e", key: "ArrowUp" },
  { control: "resize-e", key: "ArrowDown" },
  { control: "resize-n", key: "ArrowLeft" },
  { control: "resize-n", key: "ArrowRight" },
])("does not record an orthogonal $key on $control", ({ control, key }) => {
  const selected = overlay(`orthogonal-${control}-${key}`, "free", 0.5, 0.5, 0.3);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
    past: [],
  });
  render(<Harness ratio={0.5} />);

  fireEvent.keyDown(screen.getByTestId(control), { key });

  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
    selected.transform
  );
  expect(useRepurposeStore.getState().past).toHaveLength(0);
});

test("does not record a keyboard resize already clamped at maximum scale", () => {
  const selected = overlay("clamped-keyboard-resize", "free", 0.5, 0.5, 4);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
    past: [],
  });
  render(<Harness ratio={0.5} />);

  fireEvent.keyDown(screen.getByTestId("resize-e"), { key: "ArrowRight" });

  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
    selected.transform
  );
  expect(useRepurposeStore.getState().past).toHaveLength(0);
});

test("records one meaningful keyboard step on the effective primary and Undo restores it", () => {
  const hiddenPrimary = overlay("keyboard-hidden-primary", "screen", 0.8, 0.2, 0.2);
  const visibleFallback = overlay("keyboard-visible-fallback", "free", 0.2, 0.5, 0.2);
  useRepurposeStore.setState({
    overlays: [hiddenPrimary, visibleFallback],
    selectedOverlayId: hiddenPrimary.id,
    selectedOverlayIds: [visibleFallback.id, hiddenPrimary.id],
    playhead: 1,
    past: [],
  });
  render(<Harness ratio={0} />);

  fireEvent.keyDown(screen.getByTestId("resize-e"), { key: "ArrowRight" });

  let state = useRepurposeStore.getState();
  expect(state.overlays[0].transform).toEqual(hiddenPrimary.transform);
  expect(state.overlays[1].transform.scale).toBeGreaterThan(
    visibleFallback.transform.scale
  );
  expect(state.past).toHaveLength(1);
  act(() => state.undo());
  state = useRepurposeStore.getState();
  expect(state.overlays[1].transform).toEqual(visibleFallback.transform);
});

test("hit-tests from the compositor snapshot when store time and split disagree", () => {
  const animated = overlay("snapshot-hit", "free", 0.7, 0.5, 0.3);
  animated.entranceEffect = {
    type: "slide",
    durationSec: 1,
    direction: "left",
  };
  const appearance = resolveOverlayAppearanceAt(animated, 0.6, rect, 0.5);
  useRepurposeStore.setState({ overlays: [animated], playhead: 0 });
  render(
    <Harness
      ratio={0.1}
      getFrameSnapshot={() => ({
        outputTime: 0.6,
        splitRatio: 0.5,
        appearances: new Map([[animated.id, appearance]]),
      })}
    />
  );

  fireEvent.pointerDown(screen.getByTestId("interaction"), {
    pointerId: 60,
    clientX: appearance.transform.x * rect.width,
    clientY: appearance.transform.y * rect.height,
  });
  fireEvent.pointerUp(window, { pointerId: 60 });
  expect(lastRoute).toEqual({ kind: "overlay", id: animated.id });
});

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  lastRoute = null;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([
  {
    label: "Screen at a rounded-zero split",
    band: "screen" as const,
    ratio: effectiveSplitRatio(0.49 / 1920, 1920),
    visibleRegion: "face" as const,
  },
  {
    label: "Face at split one",
    band: "face" as const,
    ratio: 1,
    visibleRegion: "screen" as const,
  },
])("hidden $label", ({ band, ratio, visibleRegion }) => {
  test("cannot be hit-tested", () => {
    const hidden = overlay("hidden", band, 0.5, 0.5, 1);
    useRepurposeStore.setState({ overlays: [hidden], playhead: 1 });
    render(<Harness ratio={ratio} />);

    fireEvent.pointerDown(screen.getByTestId("interaction"), {
      pointerId: 1,
      clientX: 450,
      clientY: 800,
    });

    expect(lastRoute).toEqual({ kind: "base", region: visibleRegion });
    expect(useRepurposeStore.getState().selectedOverlayId).toBeNull();
    expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
      hidden.transform
    );
  });

  test("cannot become a snap target", () => {
    const dragged = overlay("dragged", "free", 0.2, 0.4);
    const hidden = overlay("hidden", band, 0.7, 0.4);
    hidden.zIndex = 1;
    useRepurposeStore.setState({ overlays: [dragged, hidden], playhead: 1 });
    render(<Harness ratio={ratio} />);

    fireEvent.pointerDown(screen.getByTestId("interaction"), {
      pointerId: 2,
      clientX: 180,
      clientY: 640,
    });
    fireEvent.pointerMove(window, {
      pointerId: 2,
      clientX: 0.644 * rect.width,
      clientY: 640,
    });
    fireEvent.pointerUp(window, { pointerId: 2 });

    expect(
      useRepurposeStore.getState().overlays.find((item) => item.id === dragged.id)
        ?.transform.x
    ).toBeCloseTo(0.644, 6);
    expect(useRepurposeStore.getState().activeSnapGuides).toEqual([]);
  });
});

test("handle gestures target the visible selection-order fallback without changing stored primary", () => {
  const hiddenPrimary = overlay("hidden-primary", "screen", 0.8, 0.2, 0.2);
  const visibleFallback = overlay("visible-fallback", "free", 0.2, 0.5, 0.2);
  const selectedIds = [visibleFallback.id, hiddenPrimary.id];
  useRepurposeStore.setState({
    overlays: [hiddenPrimary, visibleFallback],
    selectedOverlayId: hiddenPrimary.id,
    selectedOverlayIds: selectedIds,
  });
  render(<Harness ratio={0} />);

  const eastX =
    (visibleFallback.transform.x + visibleFallback.transform.scale / 2) *
    rect.width;
  fireEvent.pointerDown(screen.getByTestId("resize-e"), {
    pointerId: 20,
    clientX: eastX,
    clientY: visibleFallback.transform.y * rect.height,
  });
  fireEvent.pointerMove(window, {
    pointerId: 20,
    clientX: eastX + 90,
    clientY: visibleFallback.transform.y * rect.height,
  });
  fireEvent.pointerUp(window, { pointerId: 20 });

  const state = useRepurposeStore.getState();
  expect(
    state.overlays.find((item) => item.id === visibleFallback.id)?.transform.scale
  ).toBeGreaterThan(visibleFallback.transform.scale);
  expect(
    state.overlays.find((item) => item.id === hiddenPrimary.id)?.transform
  ).toEqual(hiddenPrimary.transform);
  expect(state.selectedOverlayId).toBe(hiddenPrimary.id);
  expect(state.selectedOverlayIds).toEqual(selectedIds);
});

test.each([
  { label: "endpoint fallback", ratio: 0, expectedId: "effective-free" },
  { label: "transition stored primary", ratio: 0.4, expectedId: "stored-screen" },
] as const)(
  "$label body drag prefers the visual effective primary over overlapping selected overlays",
  ({ ratio, expectedId }) => {
    const stored = overlay("stored-screen", "screen", 0.5, 0.38, 0.2);
    stored.zIndex = 0;
    const effective = overlay("effective-free", "free", 0.5, 0.38, 0.2);
    effective.zIndex = 1;
    const topmost = overlay("topmost-face", "face", 0.5, 0.38, 0.2);
    topmost.zIndex = 10;
    useRepurposeStore.setState({
      overlays: [stored, effective, topmost],
      playhead: 1,
      selectedOverlayId: stored.id,
      selectedOverlayIds: [effective.id, topmost.id, stored.id],
    });
    render(<Harness ratio={ratio} />);

    fireEvent.pointerDown(screen.getByTestId("interaction"), {
      pointerId: 21,
      clientX: 450,
      clientY: 608,
    });
    expect(lastRoute).toEqual({ kind: "overlay", id: expectedId });
    fireEvent.pointerMove(window, {
      pointerId: 21,
      clientX: 540,
      clientY: 608,
      altKey: true,
    });
    fireEvent.pointerUp(window, { pointerId: 21 });

    const state = useRepurposeStore.getState();
    expect(
      state.overlays.find((item) => item.id === expectedId)?.transform.x
    ).toBeCloseTo(0.6, 10);
    expect(
      state.overlays.find((item) => item.id === topmost.id)?.transform.x
    ).toBe(0.5);
  }
);

test("Undo mid-move cancels the follower and stale pointer work before Redo restores the sampled drag", () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  }));
  const cancelRaf = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancelRaf);
  const selected = overlay("undo-mid-move", "free", 0.5, 0.5, 0.2);
  useRepurposeStore.setState({ overlays: [selected], playhead: 1, past: [] });
  const cancellation = vi.fn();
  const unsubscribe = useRepurposeStore
    .getState()
    .subscribeOverlayTransformGestureCancellation(cancellation);
  render(<Harness ratio={0.5} />);

  fireEvent.pointerDown(screen.getByTestId("interaction"), {
    pointerId: 90,
    clientX: 450,
    clientY: 800,
  });
  fireEvent.pointerMove(window, {
    pointerId: 90,
    clientX: 630,
    clientY: 800,
    altKey: true,
  });
  expect(callbacks).toHaveLength(1);
  act(() => callbacks[0](1_000));
  const sampled = { ...useRepurposeStore.getState().overlays[0].transform };
  expect(sampled.x).toBeGreaterThan(selected.transform.x);
  expect(useRepurposeStore.getState().past).toHaveLength(1);

  act(() => useRepurposeStore.getState().undo());
  expect(cancellation).toHaveBeenCalledTimes(1);
  expect(cancelRaf).toHaveBeenCalledTimes(1);
  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
    selected.transform
  );
  expect(useRepurposeStore.getState()).toMatchObject({
    overlayDragging: false,
    activeSnapGuides: [],
    past: [],
  });

  act(() => callbacks[0](1_016));
  fireEvent.pointerMove(window, {
    pointerId: 90,
    clientX: 720,
    clientY: 800,
    altKey: true,
  });
  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
    selected.transform
  );
  expect(useRepurposeStore.getState().past).toHaveLength(0);

  act(() => useRepurposeStore.getState().redo());
  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(sampled);
  unsubscribe();
});

test("hit-tests and moves an animated Slide by the exact requested visual delta", () => {
  const animated = overlay("animated-slide", "screen", 0.7, 0.6, 0.3);
  animated.entranceEffect = {
    type: "slide",
    durationSec: 1,
    direction: "left",
  };
  const split = 0.35;
  const playhead = 0.5;
  const appearance = resolveOverlayAppearanceAt(animated, playhead, rect, split);
  useRepurposeStore.setState({ overlays: [animated], playhead });
  render(<Harness ratio={split} />);

  fireEvent.pointerDown(screen.getByTestId("interaction"), {
    pointerId: 30,
    clientX: appearance.transform.x * rect.width,
    clientY: appearance.transform.y * rect.height,
  });
  expect(lastRoute).toEqual({ kind: "overlay", id: animated.id });
  fireEvent.pointerMove(window, {
    pointerId: 30,
    clientX: appearance.transform.x * rect.width + 90,
    clientY: appearance.transform.y * rect.height,
    altKey: true,
  });
  fireEvent.pointerUp(window, { pointerId: 30 });

  const persisted = useRepurposeStore.getState().overlays[0];
  const resolved = resolveOverlayAppearanceAt(persisted, playhead, rect, split);
  expect(resolved.transform.x).toBeCloseTo(appearance.transform.x + 0.1, 10);
  expect(resolved.transform.y).toBeCloseTo(appearance.transform.y, 10);
  expect(resolved.transform.scale).toBeCloseTo(appearance.transform.scale, 10);
  expect(resolved.transform.rotation).toBeCloseTo(appearance.transform.rotation, 10);
});

test.each(["resize-e", "rotate"] as const)(
  "round-trips animated Slide visual geometry after a %s pointer gesture",
  (control) => {
    const animated = overlay(`animated-${control}`, "free", 0.55, 0.5, 0.3);
    animated.transform.rotation = 18;
    animated.entranceEffect = {
      type: "slide",
      durationSec: 1,
      direction: "up",
    };
    const playhead = 0.5;
    const split = 0.5;
    const start = resolveOverlayAppearanceAt(animated, playhead, rect, split).transform;
    useRepurposeStore.setState({
      overlays: [animated],
      selectedOverlayId: animated.id,
      selectedOverlayIds: [animated.id],
      playhead,
    });
    render(<Harness ratio={split} />);

    const startX = start.x * rect.width + start.scale * rect.width / 2;
    const startY = start.y * rect.height;
    const endX = control === "resize-e" ? startX + 90 : start.x * rect.width;
    const endY = control === "resize-e" ? startY : startY + 120;
    const gestureStart = {
      transform: start,
      naturalWidth: animated.naturalWidth,
      naturalHeight: animated.naturalHeight,
      pointerNorm: { x: startX / rect.width, y: startY / rect.height },
    };
    const desired =
      control === "resize-e"
        ? solveEdgeResize(
            gestureStart,
            "e",
            { x: endX / rect.width, y: endY / rect.height },
            rect,
            false
          )
        : solveRotate(
            gestureStart,
            { x: endX / rect.width, y: endY / rect.height },
            rect,
            false
          );
    fireEvent.pointerDown(screen.getByTestId(control), {
      pointerId: 32,
      clientX: startX,
      clientY: startY,
    });
    fireEvent.pointerMove(window, {
      pointerId: 32,
      clientX: endX,
      clientY: endY,
    });
    fireEvent.pointerUp(window, { pointerId: 32 });

    const persisted = useRepurposeStore.getState().overlays[0];
    const resolved = resolveOverlayAppearanceAt(persisted, playhead, rect, split).transform;
    expect(resolved.x).toBeCloseTo(desired.x, 9);
    expect(resolved.y).toBeCloseTo(desired.y, 9);
    expect(resolved.scale).toBeCloseTo(desired.scale, 9);
    expect(resolved.rotation).toBeCloseTo(desired.rotation, 9);
  }
);

test("excludes an overlay at the animation opacity cutoff from overlap preference and hit-testing", () => {
  const invisiblePrimary = overlay("invisible-primary", "free", 0.5, 0.5, 0.4);
  invisiblePrimary.zIndex = 20;
  invisiblePrimary.entranceEffect = { type: "fade", durationSec: 1 };
  const visibleUnderlay = overlay("visible-underlay", "free", 0.5, 0.5, 0.4);
  visibleUnderlay.zIndex = 1;
  useRepurposeStore.setState({
    overlays: [visibleUnderlay, invisiblePrimary],
    playhead: 0.1,
    selectedOverlayId: invisiblePrimary.id,
    selectedOverlayIds: [invisiblePrimary.id, visibleUnderlay.id],
  });
  render(<Harness ratio={0.5} />);

  fireEvent.pointerDown(screen.getByTestId("interaction"), {
    pointerId: 31,
    clientX: 450,
    clientY: 800,
  });
  fireEvent.pointerUp(window, { pointerId: 31 });

  expect(lastRoute).toEqual({ kind: "overlay", id: visibleUnderlay.id });
});

test.each([
  { label: "endpoint fallback", ratio: 0, expectedId: "effective-free" },
  { label: "transition stored primary", ratio: 0.4, expectedId: "stored-screen" },
] as const)(
  "$label body clone duplicates the visual effective primary",
  ({ ratio, expectedId }) => {
    const stored = overlay("stored-screen", "screen", 0.5, 0.38, 0.2);
    stored.zIndex = 0;
    const effective = overlay("effective-free", "free", 0.5, 0.38, 0.2);
    effective.zIndex = 1;
    const topmost = overlay("topmost-face", "face", 0.5, 0.38, 0.2);
    topmost.zIndex = 10;
    useRepurposeStore.setState({
      overlays: [stored, effective, topmost],
      playhead: 1,
      selectedOverlayId: stored.id,
      selectedOverlayIds: [effective.id, topmost.id, stored.id],
    });
    render(<Harness ratio={ratio} />);

    fireEvent.pointerDown(screen.getByTestId("interaction"), {
      pointerId: 22,
      clientX: 450,
      clientY: 608,
      ctrlKey: true,
    });
    fireEvent.pointerUp(window, { pointerId: 22 });

    const copy = useRepurposeStore.getState().overlays.at(-1)!;
    expect(copy.id).not.toBe(expectedId);
    expect(copy.src).toBe(`/${expectedId}.png`);
  }
);

test.each([
  {
    band: "screen" as const,
    ratio: 1,
    globalSplit: 0,
    y: 0.971875,
    edge: "maxY" as const,
  },
  {
    band: "face" as const,
    ratio: 0,
    globalSplit: 0,
    y: 0.028125,
    edge: "minY" as const,
  },
  {
    band: "free" as const,
    ratio: 0,
    globalSplit: 0,
    y: 0.5,
    edge: null,
  },
])(
  "uses the preview geometry for a no-movement Ctrl/Cmd $band clone",
  ({ band, ratio, globalSplit, y, edge }) => {
    const source = overlay(`clone-${band}`, band, 0.5, y);
    useRepurposeStore.setState({
      overlays: [source],
      playhead: 1,
      splitRatio: globalSplit,
    });
    render(<Harness ratio={ratio} />);

    fireEvent.pointerDown(screen.getByTestId("interaction"), {
      pointerId: 3,
      clientX: 450,
      clientY: y * rect.height,
      ctrlKey: true,
    });
    fireEvent.pointerUp(window, { pointerId: 3 });

    const copy = useRepurposeStore.getState().overlays[1];
    expect(copy).toBeDefined();
    const halfY = (copy.transform.scale * rect.width) / rect.height / 2;
    if (edge === "maxY") {
      expect(copy.transform.y + halfY).toBeCloseTo(ratio, 10);
    } else if (edge === "minY") {
      expect(copy.transform.y - halfY).toBeGreaterThanOrEqual(ratio);
    } else {
      expect(copy.transform.x).toBeCloseTo(source.transform.x + 0.04, 10);
      expect(copy.transform.y).toBeCloseTo(source.transform.y + 0.04, 10);
    }
  }
);

test.each([
  { band: "screen" as const, split: 0.2 },
  { band: "face" as const, split: 0.8 },
  { band: "free" as const, split: 0.2 },
])("hit-tests a visible $band overlay at its frame-resolved position", ({ band, split }) => {
  const persisted = overlay(`resolved-hit-${band}`, band, 0.5, 0.5, 0.4);
  persisted.transform.rotation = 37;
  const before = { ...persisted.transform };
  const resolved = resolveOverlayTransformForFrame(persisted, rect, split);
  useRepurposeStore.setState({ overlays: [persisted], playhead: 1 });
  render(<Harness ratio={split} />);

  fireEvent.pointerDown(screen.getByTestId("interaction"), {
    pointerId: 4,
    clientX: resolved.x * rect.width,
    clientY: resolved.y * rect.height,
  });
  fireEvent.pointerUp(window, { pointerId: 4 });

  expect(lastRoute).toEqual({ kind: "overlay", id: persisted.id });
  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(before);
});

describe.each([
  { band: "screen" as const, split: 0.2 },
  { band: "face" as const, split: 0.8 },
])("$band transition gesture persistence", ({ band, split }) => {
  function arrange(id: string) {
    const persisted = overlay(id, band, 0.5, 0.5, 0.4);
    useRepurposeStore.setState({
      overlays: [persisted],
      playhead: 1,
      selectedOverlayId: persisted.id,
      selectedOverlayIds: [persisted.id],
    });
    render(<Harness ratio={split} />);
    return {
      persisted,
      visual: resolveOverlayTransformForFrame(persisted, rect, split),
    };
  }

  test("maps an x-only move onto the persisted transform without baking seam y", () => {
    const { persisted, visual } = arrange(`move-${band}`);
    fireEvent.pointerDown(screen.getByTestId("interaction"), {
      pointerId: 10,
      clientX: visual.x * rect.width,
      clientY: visual.y * rect.height,
    });
    fireEvent.pointerMove(window, {
      pointerId: 10,
      clientX: visual.x * rect.width + 90,
      clientY: visual.y * rect.height,
      altKey: true,
    });
    fireEvent.pointerUp(window, { pointerId: 10 });

    const result = useRepurposeStore.getState().overlays[0].transform;
    expect(result.x).toBeCloseTo(persisted.transform.x + 0.1, 10);
    expect(result.y).toBe(persisted.transform.y);
  });

  test("maps an east-edge resize onto persisted scale without baking seam y", () => {
    const { persisted, visual } = arrange(`resize-${band}`);
    const eastX = (visual.x + visual.scale / 2) * rect.width;
    fireEvent.pointerDown(screen.getByTestId("resize-e"), {
      pointerId: 11,
      clientX: eastX,
      clientY: visual.y * rect.height,
    });
    fireEvent.pointerMove(window, {
      pointerId: 11,
      clientX: eastX + 90,
      clientY: visual.y * rect.height,
    });
    fireEvent.pointerUp(window, { pointerId: 11 });

    const result = useRepurposeStore.getState().overlays[0].transform;
    expect(result.scale).toBeGreaterThan(persisted.transform.scale);
    expect(result.y).toBe(persisted.transform.y);
  });

  test("maps rotation onto the persisted transform without baking seam y", () => {
    const { persisted, visual } = arrange(`rotate-${band}`);
    const radius = (visual.scale * rect.width) / 2;
    fireEvent.pointerDown(screen.getByTestId("rotate"), {
      pointerId: 12,
      clientX: visual.x * rect.width + radius,
      clientY: visual.y * rect.height,
    });
    fireEvent.pointerMove(window, {
      pointerId: 12,
      clientX: visual.x * rect.width,
      clientY: visual.y * rect.height + radius,
    });
    fireEvent.pointerUp(window, { pointerId: 12 });

    const result = useRepurposeStore.getState().overlays[0].transform;
    expect(result.rotation).toBeCloseTo(90, 10);
    expect(result.y).toBe(persisted.transform.y);
  });
});
