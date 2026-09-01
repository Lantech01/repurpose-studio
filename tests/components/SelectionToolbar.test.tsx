import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SelectionToolbar } from "@/app/repurpose-studio/_components/SelectionToolbar";
import { resolveOverlayAppearanceAt } from "@/lib/repurpose/overlay-effects";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Overlay } from "@/lib/repurpose/types";

function overlay(id: string, band: Overlay["band"], x: number): Overlay {
  return {
    id,
    kind: "image",
    src: `/${id}.png`,
    naturalWidth: 400,
    naturalHeight: 300,
    timelineStart: 0,
    timelineEnd: 10,
    srcStart: 0,
    srcDuration: 0,
    transform: { x, y: 0.2, scale: 0.3, rotation: 0 },
    zIndex: x,
    opacity: 1,
    band,
  };
}

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
      overlays.map((candidate) => [
        candidate.id,
        resolveOverlayAppearanceAt(candidate, playhead, rect, splitRatio),
      ])
    ),
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
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

function renderToolbar(split = 0.5, settledSplit = split) {
  render(
    <SelectionToolbar
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(split)}
      getSettledSplitRatio={() => settledSplit}
    />
  );
  act(() => frame?.(0));
}

test("does not render toolbar controls for an overlay in a hidden band", () => {
  const hidden = overlay("hidden", "screen", 0.2);
  useRepurposeStore.setState({
    overlays: [hidden],
    selectedOverlayId: hidden.id,
    selectedOverlayIds: [hidden.id],
  });
  render(
    <SelectionToolbar
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0)}
      getSettledSplitRatio={() => 0}
    />
  );
  act(() => frame?.(0));
  expect(screen.queryByTitle("Delete overlay (Delete)")).not.toBeInTheDocument();
});

test("renders from the visual split but passes the settled split to alignment mutations", () => {
  const freeA = overlay("free-a", "free", 0.2);
  const freeB = overlay("free-b", "free", 0.8);
  const freeC = overlay("free-c", "free", 0.5);
  const align = vi.fn();
  const distribute = vi.fn();
  useRepurposeStore.setState({
    overlays: [freeA, freeB, freeC],
    selectedOverlayId: freeB.id,
    selectedOverlayIds: [freeA.id, freeB.id, freeC.id],
    alignOverlays: align,
    distributeOverlays: distribute,
  });
  const getRect = () => ({ left: 0, top: 0, width: 900, height: 1600 });
  render(
    <SelectionToolbar
      getRect={getRect}
      getFrameSnapshot={() => frameSnapshot(0.8, getRect())}
      getSettledSplitRatio={() => 0.34}
    />
  );
  act(() => frame?.(0));

  fireEvent.click(screen.getByTitle("Align left edges"));
  fireEvent.click(screen.getByTitle("Distribute horizontally (needs 3+)"));
  expect(align).toHaveBeenCalledWith("left", getRect(), 0.34);
  expect(distribute).toHaveBeenCalledWith("h", getRect(), 0.34);
});

test("shows transient visual chrome without allowing a settled-hidden overlay mutation", () => {
  const transientlyVisible = overlay("transient-screen", "screen", 0.5);
  const remove = vi.fn();
  useRepurposeStore.setState({
    overlays: [transientlyVisible],
    selectedOverlayId: transientlyVisible.id,
    selectedOverlayIds: [transientlyVisible.id],
    removeOverlay: remove,
  });
  render(
    <SelectionToolbar
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0.8)}
      getSettledSplitRatio={() => 0}
    />
  );
  act(() => frame?.(0));

  fireEvent.click(screen.getByTitle("Delete overlay (Delete)"));
  expect(remove).not.toHaveBeenCalled();
});

test.each([
  { label: "forward overlay order", reverse: false },
  { label: "inverse overlay order", reverse: true },
])(
  "uses the first visible selected overlay when the stored primary is hidden in $label",
  ({ reverse }) => {
    const visibleA = overlay("visible-a", "free", 0.2);
    const visibleB = overlay("visible-b", "free", 0.8);
    const hiddenPrimary = overlay("hidden-primary", "screen", 0.5);
    const remove = vi.fn();
    const align = vi.fn();
    const ordered = reverse
      ? [hiddenPrimary, visibleB, visibleA]
      : [visibleA, visibleB, hiddenPrimary];
    useRepurposeStore.setState({
      overlays: ordered,
      selectedOverlayId: hiddenPrimary.id,
      selectedOverlayIds: [visibleB.id, visibleA.id, hiddenPrimary.id],
      removeOverlay: remove,
      alignOverlays: align,
    });
    const getRect = () => ({ left: 0, top: 0, width: 900, height: 1600 });
    render(
      <SelectionToolbar
        getRect={getRect}
        getFrameSnapshot={() => frameSnapshot(0, getRect())}
        getSettledSplitRatio={() => 0}
      />
    );
    act(() => frame?.(0));

    fireEvent.click(screen.getByTitle("Align left edges"));
    expect(align).toHaveBeenCalledWith("left", getRect(), 0);
    fireEvent.click(screen.getByTitle("Delete overlay (Delete)"));
    expect(remove).toHaveBeenCalledWith(visibleB.id);
    expect(remove).not.toHaveBeenCalledWith(hiddenPrimary.id);
    expect(useRepurposeStore.getState().selectedOverlayId).toBe(hiddenPrimary.id);
    expect(useRepurposeStore.getState().selectedOverlayIds).toEqual([
      visibleB.id,
      visibleA.id,
      hiddenPrimary.id,
    ]);
  }
);

test("shows compact Portuguese appearance groups with conditional Slide directions", () => {
  const selected = overlay("appearance", "free", 0.5);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
  });
  renderToolbar();

  expect(screen.getByText("Entrada")).toBeVisible();
  expect(screen.getByText("Saida")).toBeVisible();
  expect(screen.getByText("Cantos")).toBeVisible();
  expect(screen.getAllByText("Efeito")).toHaveLength(2);
  expect(screen.getAllByText("Duracao")).toHaveLength(2);
  expect(screen.getByText("Raio")).toBeVisible();
  const entrance = screen.getByRole("combobox", { name: "Efeito de entrada" });
  const exit = screen.getByRole("combobox", { name: "Efeito de saida" });
  expect(entrance).toHaveValue("none");
  expect(exit).toHaveValue("none");
  expect(
    Array.from(entrance.querySelectorAll("option")).map((option) => option.textContent)
  ).toEqual(["Nenhum", "Zoom", "Slide", "Pop", "Fade"]);
  expect(screen.getByRole("slider", { name: "Duracao da entrada" })).toHaveAttribute("min", "0.1");
  expect(screen.getByRole("slider", { name: "Duracao da entrada" })).toHaveAttribute("max", "2");
  expect(screen.getAllByText("0.35s")).toHaveLength(2);
  expect(screen.queryByRole("combobox", { name: "Direcao da entrada" })).not.toBeInTheDocument();

  fireEvent.change(entrance, { target: { value: "slide" } });
  expect(screen.getByText("Direcao")).toBeVisible();
  const direction = screen.getByRole("combobox", { name: "Direcao da entrada" });
  expect(
    Array.from(direction.querySelectorAll("option")).map((option) => option.textContent)
  ).toEqual(["Esquerda", "Direita", "Cima", "Baixo"]);
  fireEvent.change(entrance, { target: { value: "fade" } });
  expect(screen.queryByRole("combobox", { name: "Direcao da entrada" })).not.toBeInTheDocument();
});

test("keeps authored scale and effect values in inputs while Zoom is animating", () => {
  const animated = overlay("authored-values", "free", 0.5);
  animated.transform.scale = 0.3;
  animated.entranceEffect = { type: "zoom", durationSec: 1 };
  useRepurposeStore.setState({
    overlays: [animated],
    selectedOverlayId: animated.id,
    selectedOverlayIds: [animated.id],
    playhead: 0.5,
  });
  renderToolbar();

  const scaleGroup = screen.getByTitle("Overlay scale (fraction of frame width)");
  expect(scaleGroup.querySelector('input[type="text"]')).toHaveValue("30");
  expect(screen.getByRole("combobox", { name: "Efeito de entrada" })).toHaveValue("zoom");
  expect(screen.getByRole("slider", { name: "Duracao da entrada" })).toHaveValue("1");
});

test("gives both overlay scale inputs distinct accessible names", () => {
  const selected = overlay("named-scale", "free", 0.5);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
  });
  renderToolbar();

  expect(
    screen.getByRole("slider", {
      name: "Overlay scale (fraction of frame width) slider",
    })
  ).toBeVisible();
  expect(
    screen.getByRole("textbox", {
      name: "Overlay scale (fraction of frame width) percentage",
    })
  ).toBeVisible();
});

test("wires a long duration pointer drag to one history entry with Undo and Redo", () => {
  const selected = overlay("duration-history", "free", 0.5);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    past: [],
    future: [],
  });
  renderToolbar();
  const slider = screen.getByRole("slider", { name: "Duracao da entrada" });

  fireEvent.pointerDown(slider, { pointerId: 40 });
  fireEvent.change(slider, { target: { value: "0.8" } });
  fireEvent.change(slider, { target: { value: "1.2" } });
  fireEvent.change(slider, { target: { value: "1.7" } });
  fireEvent.pointerUp(slider, { pointerId: 40 });

  expect(useRepurposeStore.getState().past).toHaveLength(1);
  expect(useRepurposeStore.getState().overlays[0].entranceEffect?.durationSec).toBe(1.7);
  act(() => useRepurposeStore.getState().undo());
  expect(useRepurposeStore.getState().overlays[0].entranceEffect).toBeUndefined();
  act(() => useRepurposeStore.getState().redo());
  expect(useRepurposeStore.getState().overlays[0].entranceEffect?.durationSec).toBe(1.7);
});

test("cancels pointer sliders and groups a keyboard radius gesture into one history entry", () => {
  const selected = overlay("slider-cancel", "free", 0.5);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    past: [],
  });
  renderToolbar();
  const duration = screen.getByRole("slider", { name: "Duracao da saida" });
  fireEvent.pointerDown(duration, { pointerId: 41 });
  fireEvent.change(duration, { target: { value: "1.5" } });
  fireEvent.pointerCancel(duration, { pointerId: 41 });
  expect(useRepurposeStore.getState().overlays[0].exitEffect).toBeUndefined();
  expect(useRepurposeStore.getState().past).toHaveLength(0);

  const radius = screen.getByRole("slider", { name: "Raio dos cantos" });
  fireEvent.keyDown(radius, { key: "ArrowRight" });
  fireEvent.change(radius, { target: { value: "0.04" } });
  fireEvent.change(radius, { target: { value: "0.16" } });
  fireEvent.keyUp(radius, { key: "ArrowRight" });
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0.16);
  expect(useRepurposeStore.getState().past).toHaveLength(1);
  expect(screen.getByText("16%")).toBeVisible();
});

test("ignores queued slider events after store cancellation until a fresh physical start", () => {
  const selected = overlay("stale-slider", "free", 0.5);
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    past: [],
    future: [],
  });
  renderToolbar();
  const radius = screen.getByRole("slider", { name: "Raio dos cantos" });

  fireEvent.pointerDown(radius, { pointerId: 55 });
  fireEvent.change(radius, { target: { value: "0.16" } });
  act(() => useRepurposeStore.getState().undo());
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBeUndefined();

  fireEvent.change(radius, { target: { value: "0.3" } });
  fireEvent.pointerUp(radius, { pointerId: 55 });
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBeUndefined();
  expect(useRepurposeStore.getState().past).toHaveLength(0);

  fireEvent.pointerDown(radius, { pointerId: 56 });
  fireEvent.change(radius, { target: { value: "0.4" } });
  fireEvent.pointerUp(radius, { pointerId: 56 });
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0.4);
  expect(useRepurposeStore.getState().past).toHaveLength(1);
});

test.each([
  { name: "Quadrado", value: 0 },
  { name: "Suave", value: 0.04 },
  { name: "Redondo", value: 0.16 },
  { name: "Maximo", value: 0.5 },
])("applies the $name corner preset as one discrete action", ({ name, value }) => {
  const selected = overlay(`preset-${name}`, "free", 0.5);
  selected.cornerRadius = 0.08;
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    past: [],
  });
  renderToolbar();

  fireEvent.click(screen.getByRole("button", { name: `${name} ${Math.round(value * 100)}%` }));
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(value);
  expect(useRepurposeStore.getState().past).toHaveLength(1);
});

test("appearance controls target the animated visible effective primary and preserve stored selection", () => {
  const invisiblePrimary = overlay("invisible-primary", "free", 0.8);
  invisiblePrimary.entranceEffect = { type: "fade", durationSec: 1 };
  const visibleFallback = overlay("visible-fallback", "free", 0.2);
  useRepurposeStore.setState({
    overlays: [invisiblePrimary, visibleFallback],
    selectedOverlayId: invisiblePrimary.id,
    selectedOverlayIds: [visibleFallback.id, invisiblePrimary.id],
    playhead: 0.1,
  });
  renderToolbar();

  fireEvent.change(screen.getByRole("combobox", { name: "Efeito de saida" }), {
    target: { value: "pop" },
  });
  expect(useRepurposeStore.getState().overlays.find((item) => item.id === visibleFallback.id)?.exitEffect?.type).toBe("pop");
  expect(useRepurposeStore.getState().overlays.find((item) => item.id === invisiblePrimary.id)?.exitEffect).toBeUndefined();
  expect(useRepurposeStore.getState().selectedOverlayId).toBe(invisiblePrimary.id);
  expect(useRepurposeStore.getState().selectedOverlayIds).toEqual([visibleFallback.id, invisiblePrimary.id]);
});

test("revalidates snapshot interactivity before mutating a stale toolbar target", () => {
  const selected = overlay("stale-toolbar", "free", 0.5);
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const visible = resolveOverlayAppearanceAt(selected, 1, rect, 0.5);
  let currentAppearance = visible;
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
  });
  render(
    <SelectionToolbar
      getRect={() => rect}
      getSettledSplitRatio={() => 0.5}
      getFrameSnapshot={() => ({
        outputTime: 1,
        splitRatio: 0.5,
        appearances: new Map([[selected.id, currentAppearance]]),
      })}
    />
  );
  act(() => frame?.(0));
  currentAppearance = { ...visible, opacityMultiplier: 0, interactive: false };

  fireEvent.change(screen.getByRole("combobox", { name: "Efeito de entrada" }), {
    target: { value: "pop" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Redondo 16%" }));

  expect(useRepurposeStore.getState().overlays[0].entranceEffect).toBeUndefined();
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBeUndefined();
  expect(useRepurposeStore.getState().past).toHaveLength(0);
});

test("revalidates a duration pointer start and only opens a fresh valid gesture", () => {
  const selected = overlay("stale-pointer-duration", "free", 0.5);
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const visible = resolveOverlayAppearanceAt(selected, 1, rect, 0.5);
  let currentAppearance = visible;
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
    past: [],
  });
  render(
    <SelectionToolbar
      getRect={() => rect}
      getSettledSplitRatio={() => 0.5}
      getFrameSnapshot={() => ({
        outputTime: 1,
        splitRatio: 0.5,
        appearances: new Map([[selected.id, currentAppearance]]),
      })}
    />
  );
  act(() => frame?.(0));
  const duration = screen.getByRole("slider", { name: "Duracao da entrada" });
  currentAppearance = { ...visible, opacityMultiplier: 0, interactive: false };

  fireEvent.pointerDown(duration, { pointerId: 70 });
  fireEvent.change(duration, { target: { value: "1.2" } });
  fireEvent.pointerUp(duration, { pointerId: 70 });
  expect(useRepurposeStore.getState().overlays[0].entranceEffect).toBeUndefined();
  expect(useRepurposeStore.getState().past).toHaveLength(0);

  currentAppearance = visible;
  fireEvent.pointerDown(duration, { pointerId: 71 });
  fireEvent.change(duration, { target: { value: "1.2" } });
  fireEvent.pointerUp(duration, { pointerId: 71 });
  expect(useRepurposeStore.getState().overlays[0].entranceEffect?.durationSec).toBe(1.2);
  expect(useRepurposeStore.getState().past).toHaveLength(1);
});

test("revalidates a radius keyboard start against the current effective primary", () => {
  const stalePrimary = overlay("stale-keyboard-radius", "free", 0.8);
  const fallback = overlay("fresh-keyboard-primary", "free", 0.2);
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const staleVisible = resolveOverlayAppearanceAt(stalePrimary, 1, rect, 0.5);
  const fallbackVisible = resolveOverlayAppearanceAt(fallback, 1, rect, 0.5);
  let staleAppearance = staleVisible;
  useRepurposeStore.setState({
    overlays: [stalePrimary, fallback],
    selectedOverlayId: stalePrimary.id,
    selectedOverlayIds: [fallback.id, stalePrimary.id],
    playhead: 1,
    past: [],
  });
  render(
    <SelectionToolbar
      getRect={() => rect}
      getSettledSplitRatio={() => 0.5}
      getFrameSnapshot={() => ({
        outputTime: 1,
        splitRatio: 0.5,
        appearances: new Map([
          [stalePrimary.id, staleAppearance],
          [fallback.id, fallbackVisible],
        ]),
      })}
    />
  );
  act(() => frame?.(0));
  const radius = screen.getByRole("slider", { name: "Raio dos cantos" });
  staleAppearance = { ...staleVisible, opacityMultiplier: 0, interactive: false };

  fireEvent.keyDown(radius, { key: "ArrowRight" });
  fireEvent.change(radius, { target: { value: "0.16" } });
  fireEvent.keyUp(radius, { key: "ArrowRight" });
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBeUndefined();
  expect(useRepurposeStore.getState().past).toHaveLength(0);

  staleAppearance = staleVisible;
  fireEvent.keyDown(radius, { key: "ArrowRight" });
  fireEvent.change(radius, { target: { value: "0.16" } });
  fireEvent.keyUp(radius, { key: "ArrowRight" });
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0.16);
  expect(useRepurposeStore.getState().overlays[1].cornerRadius).toBeUndefined();
  expect(useRepurposeStore.getState().past).toHaveLength(1);
});

test("rejects pointer and keyboard slider starts after the target band becomes hidden", () => {
  const selected = overlay("stale-hidden-band", "screen", 0.5);
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  let splitRatio = 0.5;
  useRepurposeStore.setState({
    overlays: [selected],
    selectedOverlayId: selected.id,
    selectedOverlayIds: [selected.id],
    playhead: 1,
    past: [],
  });
  render(
    <SelectionToolbar
      getRect={() => rect}
      getSettledSplitRatio={() => splitRatio}
      getFrameSnapshot={() => ({
        outputTime: 1,
        splitRatio,
        appearances: new Map([
          [selected.id, resolveOverlayAppearanceAt(selected, 1, rect, splitRatio)],
        ]),
      })}
    />
  );
  act(() => frame?.(0));
  const duration = screen.getByRole("slider", { name: "Duracao da entrada" });
  const radius = screen.getByRole("slider", { name: "Raio dos cantos" });
  splitRatio = 0;

  fireEvent.pointerDown(duration, { pointerId: 72 });
  fireEvent.change(duration, { target: { value: "1.2" } });
  fireEvent.pointerUp(duration, { pointerId: 72 });
  fireEvent.keyDown(radius, { key: "ArrowRight" });
  fireEvent.change(radius, { target: { value: "0.16" } });
  fireEvent.keyUp(radius, { key: "ArrowRight" });

  expect(useRepurposeStore.getState().overlays[0].entranceEffect).toBeUndefined();
  expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBeUndefined();
  expect(useRepurposeStore.getState().past).toHaveLength(0);
});

test.each([
  {
    label: "endpoint fallback",
    split: 0,
    settledSplit: 0,
    storedBand: "screen" as const,
    expectedBand: "face" as const,
  },
  {
    label: "transition stored-primary preference",
    split: 0.4,
    settledSplit: 0.4,
    storedBand: "screen" as const,
    expectedBand: "free" as const,
  },
])(
  "binds scale, opacity, z-order, delete, and geometry to the effective primary for $label",
  ({ split, settledSplit, storedBand, expectedBand }) => {
    const storedPrimary = overlay("stored-primary", storedBand, 0.8);
    storedPrimary.transform.scale = 0.6;
    storedPrimary.opacity = 0.7;
    const firstSelected = overlay("first-selected", expectedBand, 0.2);
    firstSelected.transform.scale = 0.25;
    firstSelected.opacity = 0.4;
    const selectedIds = [firstSelected.id, storedPrimary.id];
    const updateTransform = vi.fn();
    const setOpacity = vi.fn();
    const setZ = vi.fn();
    const remove = vi.fn();
    useRepurposeStore.setState({
      overlays: [storedPrimary, firstSelected],
      selectedOverlayId: storedPrimary.id,
      selectedOverlayIds: selectedIds,
      updateOverlayTransform: updateTransform,
      setOverlayOpacity: setOpacity,
      setOverlayZ: setZ,
      removeOverlay: remove,
    });
    render(
      <SelectionToolbar
        getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
        getFrameSnapshot={() => frameSnapshot(split)}
        getSettledSplitRatio={() => settledSplit}
      />
    );
    act(() => frame?.(0));

    const expectedId = split === 0 ? firstSelected.id : storedPrimary.id;
    const deleteButton = screen.getByTitle("Delete overlay (Delete)");
    expect(deleteButton.closest("[data-overlay-id]")).toHaveAttribute(
      "data-overlay-id",
      expectedId
    );
    expect(useRepurposeStore.getState().selectedOverlayId).toBe(storedPrimary.id);
    expect(useRepurposeStore.getState().selectedOverlayIds).toEqual(selectedIds);

    fireEvent.click(screen.getByTitle("Zoom in 5%"));
    fireEvent.change(
      screen.getByTitle("Overlay opacity").querySelector('input[type="range"]')!,
      { target: { value: "0.3" } }
    );
    fireEvent.click(screen.getByTitle("Send backward ([)"));
    fireEvent.click(deleteButton);

    expect(updateTransform).toHaveBeenCalledWith(expectedId, {
      scale: (split === 0 ? firstSelected.transform.scale : storedPrimary.transform.scale) + 0.05,
    });
    expect(setOpacity).toHaveBeenCalledWith(expectedId, 0.3);
    expect(setZ).toHaveBeenCalledWith(expectedId, "backward");
    expect(remove).toHaveBeenCalledWith(expectedId);
  }
);
