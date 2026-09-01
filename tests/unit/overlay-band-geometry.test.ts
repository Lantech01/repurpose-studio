import { beforeEach, describe, expect, test } from "vitest";
import {
  applyVisualTransformDeltaToPersisted,
  alignOverlays as computeAlignOverlays,
  clampOverlayToBand,
  overlayAABBNorm,
  resolveEffectivePrimaryOverlay,
  resolveOverlayTransformForFrame,
  type PreviewRect,
} from "@/lib/repurpose/overlay-geometry";
import { resolveOverlayAppearanceAt } from "@/lib/repurpose/overlay-effects";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Overlay, OverlayTransform } from "@/lib/repurpose/types";

const rect: PreviewRect = { left: 0, top: 0, width: 900, height: 1600 };

function overlay(
  id: string,
  band: Overlay["band"],
  transform: OverlayTransform
): Overlay {
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
    transform,
    zIndex: 0,
    opacity: 1,
    band,
  };
}

describe("resolveEffectivePrimaryOverlay", () => {
  test.each([
    { selectedIds: ["visible-face", "visible-free", "hidden"], expected: "visible-face" },
    { selectedIds: ["visible-free", "visible-face", "hidden"], expected: "visible-free" },
  ])(
    "falls back by selection order at an endpoint: $selectedIds",
    ({ selectedIds, expected }) => {
      const hidden = overlay("hidden", "screen", {
        x: 0.5,
        y: 0.2,
        scale: 0.2,
        rotation: 0,
      });
      const face = overlay("visible-face", "face", {
        x: 0.2,
        y: 0.8,
        scale: 0.2,
        rotation: 0,
      });
      const free = overlay("visible-free", "free", {
        x: 0.8,
        y: 0.5,
        scale: 0.2,
        rotation: 0,
      });

      expect(
        resolveEffectivePrimaryOverlay(
          [hidden, free, face],
          selectedIds,
          hidden.id,
          0
        )?.id
      ).toBe(expected);
    }
  );

  test("prefers the stored primary when it is eligible during a transition", () => {
    const storedPrimary = overlay("stored-screen", "screen", {
      x: 0.7,
      y: 0.2,
      scale: 0.2,
      rotation: 0,
    });
    const firstSelected = overlay("first-free", "free", {
      x: 0.2,
      y: 0.5,
      scale: 0.2,
      rotation: 0,
    });

    expect(
      resolveEffectivePrimaryOverlay(
        [firstSelected, storedPrimary],
        [firstSelected.id, storedPrimary.id],
        storedPrimary.id,
        0.4
      )?.id
    ).toBe(storedPrimary.id);
  });
});

describe("clampOverlayToBand", () => {
  test("moves a rotated Screen AABB up to the seam without changing its shape", () => {
    const input = overlay("screen", "screen", {
      x: 0.5,
      y: 0.58,
      scale: 0.6,
      rotation: 37,
    });
    const result = clampOverlayToBand(input, input.transform, rect, 0.5);
    const box = overlayAABBNorm(result, input.naturalWidth, input.naturalHeight, rect);
    expect(box.maxY).toBeCloseTo(0.5, 10);
    expect(result.x).toBe(input.transform.x);
    expect(result.scale).toBe(input.transform.scale);
    expect(result.rotation).toBe(input.transform.rotation);
  });

  test("moves a rotated Face AABB down to the seam", () => {
    const input = overlay("face", "face", {
      x: 0.5,
      y: 0.42,
      scale: 0.6,
      rotation: -29,
    });
    const result = clampOverlayToBand(input, input.transform, rect, 0.5);
    const box = overlayAABBNorm(result, input.naturalWidth, input.naturalHeight, rect);
    expect(box.minY).toBeCloseTo(0.5, 10);
  });

  test("leaves Free overlays unchanged", () => {
    const input = overlay("free", "free", {
      x: -0.2,
      y: 1.2,
      scale: 2,
      rotation: 45,
    });
    expect(clampOverlayToBand(input, input.transform, rect, 0.5)).toBe(input.transform);
  });

  test.each([
    { band: "screen" as const, split: 0, edge: "maxY" as const },
    { band: "face" as const, split: 1, edge: "minY" as const },
  ])("keeps an oversized $band overlay's seam edge at an endpoint", ({ band, split, edge }) => {
    const input = overlay(band, band, {
      x: 0.5,
      y: 0.5,
      scale: 3,
      rotation: 20,
    });
    const result = clampOverlayToBand(input, input.transform, rect, split);
    const box = overlayAABBNorm(result, input.naturalWidth, input.naturalHeight, rect);
    expect(box[edge]).toBeCloseTo(split, 10);
    if (edge === "maxY") expect(box.minY).toBeLessThan(0);
    else expect(box.maxY).toBeGreaterThan(1);
  });
});

describe("resolveOverlayTransformForFrame", () => {
  test.each([
    { band: "screen" as const, split: 0.2, edge: "maxY" as const },
    { band: "face" as const, split: 0.8, edge: "minY" as const },
  ])(
    "ephemerally resolves a rotated oversized $band overlay at a changed split",
    ({ band, split, edge }) => {
      const persisted = overlay(`resolved-${band}`, band, {
        x: 0.5,
        y: 0.5,
        scale: 1.4,
        rotation: 37,
      });
      const before = { ...persisted.transform };

      const result = resolveOverlayTransformForFrame(persisted, rect, split);
      const box = overlayAABBNorm(
        result,
        persisted.naturalWidth,
        persisted.naturalHeight,
        rect
      );

      expect(box[edge]).toBeCloseTo(split, 10);
      expect(result).toMatchObject({
        x: before.x,
        scale: before.scale,
        rotation: before.rotation,
      });
      expect(persisted.transform).toEqual(before);
      expect(result).not.toBe(persisted.transform);
    }
  );

  test("leaves a free overlay on its persisted transform", () => {
    const persisted = overlay("resolved-free", "free", {
      x: 0.5,
      y: 0.5,
      scale: 1.4,
      rotation: 37,
    });

    expect(resolveOverlayTransformForFrame(persisted, rect, 0.2)).toBe(
      persisted.transform
    );
  });
});

describe("applyVisualTransformDeltaToPersisted", () => {
  test.each([
    { type: "zoom" as const, time: 0.5 },
    { type: "pop" as const, time: 0.5 },
    { type: "slide" as const, time: 0.5 },
  ])(
    "maps authored deltas exactly without baking a $type entrance or seam correction",
    ({ type, time }) => {
      const persisted = overlay(`animated-${type}`, "screen", {
        x: 0.62,
        y: 0.7,
        scale: 0.48,
        rotation: 17,
      });
      persisted.entranceEffect = {
        type,
        durationSec: 1,
        ...(type === "slide" ? { direction: "left" as const } : {}),
      };
      const startVisual = resolveOverlayAppearanceAt(
        persisted,
        time,
        rect,
        0.35
      ).transform;
      const desiredVisual = {
        x: startVisual.x + 0.12,
        y: startVisual.y - 0.07,
        scale: startVisual.scale * 1.25,
        rotation: startVisual.rotation + 31,
      };

      expect(
        applyVisualTransformDeltaToPersisted(
          persisted.transform,
          startVisual,
          desiredVisual
        )
      ).toEqual({
        x: persisted.transform.x + 0.12,
        y: persisted.transform.y - 0.07,
        scale: persisted.transform.scale * 1.25,
        rotation: persisted.transform.rotation + 31,
      });
    }
  );

  test.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps persisted scale when the frozen visual scale is invalid: %s",
    (startScale) => {
      expect(
        applyVisualTransformDeltaToPersisted(
          { x: 0.4, y: 0.6, scale: 0.75, rotation: 20 },
          { x: 0.2, y: 0.3, scale: startScale, rotation: 80 },
          { x: Number.NaN, y: Number.POSITIVE_INFINITY, scale: 1.5, rotation: 110 }
        )
      ).toEqual({ x: 0.4, y: 0.6, scale: 0.75, rotation: 50 });
    }
  );
});

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
});

test("alignment excludes hidden participants before cardinality and history", () => {
  const hidden = overlay("hidden-screen", "screen", {
    x: 0.2,
    y: 0.1,
    scale: 0.2,
    rotation: 0,
  });
  const visible = overlay("visible-free", "free", {
    x: 0.8,
    y: 0.8,
    scale: 0.2,
    rotation: 0,
  });
  useRepurposeStore.setState({
    overlays: [hidden, visible],
    selectedOverlayId: visible.id,
    selectedOverlayIds: [hidden.id, visible.id],
    past: [],
  });

  useRepurposeStore.getState().alignOverlays("left", rect, 0);

  expect(useRepurposeStore.getState().overlays.map((o) => o.transform)).toEqual([
    hidden.transform,
    visible.transform,
  ]);
  expect(useRepurposeStore.getState().past).toHaveLength(0);
});

test("distribution excludes hidden participants before cardinality and history", () => {
  const overlays = [
    overlay("free-a", "free", { x: 0.1, y: 0.2, scale: 0.1, rotation: 0 }),
    overlay("hidden-face", "face", { x: 0.7, y: 0.8, scale: 0.1, rotation: 0 }),
    overlay("free-b", "free", { x: 0.9, y: 0.4, scale: 0.1, rotation: 0 }),
  ];
  useRepurposeStore.setState({
    overlays,
    selectedOverlayId: overlays[2].id,
    selectedOverlayIds: overlays.map((o) => o.id),
    past: [],
  });

  useRepurposeStore.getState().distributeOverlays("h", rect, 1);

  expect(useRepurposeStore.getState().overlays.map((o) => o.transform)).toEqual(
    overlays.map((o) => o.transform)
  );
  expect(useRepurposeStore.getState().past).toHaveLength(0);
});

describe.each([
  {
    band: "screen" as const,
    split: 0.2,
    alignEdge: "top" as const,
    noOpEdge: "bottom" as const,
  },
  {
    band: "face" as const,
    split: 0.8,
    alignEdge: "bottom" as const,
    noOpEdge: "top" as const,
  },
])("$band frame-resolved alignment and distribution", ({ band, split, alignEdge, noOpEdge }) => {
  test("maps a visual alignment delta onto each persisted transform", () => {
    const items = [
      overlay(`align-${band}-a`, band, {
        x: 0.2,
        y: 0.5,
        scale: 0.2,
        rotation: 25,
      }),
      overlay(`align-${band}-b`, band, {
        x: 0.8,
        y: 0.5,
        scale: 0.4,
        rotation: -20,
      }),
    ];
    const visual = items.map((item) => ({
      id: item.id,
      transform: resolveOverlayTransformForFrame(item, rect, split),
      naturalWidth: item.naturalWidth,
      naturalHeight: item.naturalHeight,
    }));
    const desired = computeAlignOverlays(visual, alignEdge, rect);
    useRepurposeStore.setState({
      overlays: items,
      selectedOverlayId: items[1].id,
      selectedOverlayIds: items.map((item) => item.id),
      past: [],
    });

    useRepurposeStore.getState().alignOverlays(alignEdge, rect, split);

    const state = useRepurposeStore.getState();
    for (const original of items) {
      const startVisual = visual.find((item) => item.id === original.id)!.transform;
      const desiredVisual = desired.get(original.id) ?? startVisual;
      const result = state.overlays.find((item) => item.id === original.id)!.transform;
      expect(result.x).toBeCloseTo(original.transform.x, 10);
      expect(result.y).toBeCloseTo(
        original.transform.y + desiredVisual.y - startVisual.y,
        10
      );
    }
    expect(state.past).toHaveLength(1);
  });

  test("creates no history when alignment is already a visual no-op", () => {
    const items = [
      overlay(`noop-align-${band}-a`, band, {
        x: 0.3,
        y: 0.4,
        scale: 0.3,
        rotation: 0,
      }),
      overlay(`noop-align-${band}-b`, band, {
        x: 0.7,
        y: 0.6,
        scale: 0.3,
        rotation: 0,
      }),
    ];
    useRepurposeStore.setState({
      overlays: items,
      selectedOverlayId: items[1].id,
      selectedOverlayIds: items.map((item) => item.id),
      past: [],
    });

    useRepurposeStore.getState().alignOverlays(noOpEdge, rect, split);

    expect(useRepurposeStore.getState().overlays.map((item) => item.transform)).toEqual(
      items.map((item) => item.transform)
    );
    expect(useRepurposeStore.getState().past).toHaveLength(0);
  });

  test("distributes resolved visuals horizontally without baking seam y", () => {
    const items = [
      overlay(`distribute-${band}-a`, band, {
        x: 0.1,
        y: 0.5,
        scale: 0.15,
        rotation: 20,
      }),
      overlay(`distribute-${band}-b`, band, {
        x: 0.35,
        y: 0.5,
        scale: 0.15,
        rotation: -15,
      }),
      overlay(`distribute-${band}-c`, band, {
        x: 0.9,
        y: 0.5,
        scale: 0.15,
        rotation: 10,
      }),
    ];
    useRepurposeStore.setState({
      overlays: items,
      selectedOverlayId: items[2].id,
      selectedOverlayIds: items.map((item) => item.id),
      past: [],
    });

    useRepurposeStore.getState().distributeOverlays("h", rect, split);

    const state = useRepurposeStore.getState();
    expect(state.overlays[1].transform.x).not.toBe(items[1].transform.x);
    expect(state.overlays.map((item) => item.transform.y)).toEqual(
      items.map((item) => item.transform.y)
    );
    expect(state.past).toHaveLength(1);
  });

  test("creates no history when distribution is already a visual no-op", () => {
    const items = [0.4, 0.5, 0.6].map((y, index) =>
      overlay(`noop-distribute-${band}-${index}`, band, {
        x: 0.5,
        y,
        scale: 0.3,
        rotation: 0,
      })
    );
    useRepurposeStore.setState({
      overlays: items,
      selectedOverlayId: items[2].id,
      selectedOverlayIds: items.map((item) => item.id),
      past: [],
    });

    useRepurposeStore.getState().distributeOverlays("v", rect, split);

    expect(useRepurposeStore.getState().overlays.map((item) => item.transform)).toEqual(
      items.map((item) => item.transform)
    );
    expect(useRepurposeStore.getState().past).toHaveLength(0);
  });
});

test("pasted transforms use the rotated band clamp", () => {
  const target = overlay("face", "face", {
    x: 0.5,
    y: 0.8,
    scale: 0.2,
    rotation: 0,
  });
  useRepurposeStore.setState({
    overlays: [target],
    selectedOverlayId: target.id,
    selectedOverlayIds: [target.id],
    attributeClipboard: {
      kind: "overlay",
      transform: { x: 0.5, y: 0.2, scale: 0.8, rotation: 45 },
      opacity: 0.7,
      entranceEffect: { type: "none", durationSec: 0.35 },
      exitEffect: { type: "none", durationSec: 0.35 },
      cornerRadius: 0,
    },
  });

  expect(useRepurposeStore.getState().pasteAttributesToSelection(rect, 0.5)).toBe(true);
  const pasted = useRepurposeStore.getState().overlays[0];
  expect(
    overlayAABBNorm(pasted.transform, pasted.naturalWidth, pasted.naturalHeight, rect).minY
  ).toBeCloseTo(0.5, 10);
});

test.each([
  { band: "screen" as const, split: 0, edge: "maxY" as const },
  { band: "face" as const, split: 1, edge: "minY" as const },
  { band: "free" as const, split: 0, edge: null },
])(
  "publishes a new $band overlay clamped to the caller's effective endpoint",
  ({ band, split, edge }) => {
    useRepurposeStore.setState({ splitRatio: 1 - split, duration: 4 });

    const id = useRepurposeStore.getState().addOverlay(
      {
        kind: "image",
        src: `/${band}.png`,
        naturalWidth: 400,
        naturalHeight: 300,
        atTime: 0,
        atPoint: { x: 0.5, y: 0.5 },
        scale: 0.4,
        band,
      },
      rect,
      split
    );
    const added = useRepurposeStore
      .getState()
      .overlays.find((item) => item.id === id)!;
    const box = overlayAABBNorm(
      added.transform,
      added.naturalWidth,
      added.naturalHeight,
      rect
    );

    expect(added.band).toBe(band);
    if (edge) expect(box[edge]).toBeCloseTo(split, 10);
    else expect(added.transform).toMatchObject({ x: 0.5, y: 0.5, scale: 0.4 });
  }
);

test.each([
  {
    band: "screen" as const,
    split: 0,
    globalSplit: 1,
    transform: { x: 0.5, y: -0.05625, scale: 0.2, rotation: 0 },
  },
  {
    band: "face" as const,
    split: 1,
    globalSplit: 0,
    transform: { x: 0.5, y: 1.05625, scale: 0.2, rotation: 0 },
  },
  {
    band: "free" as const,
    split: 0,
    globalSplit: 1,
    transform: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
  },
])(
  "duplicates a $band overlay against the caller's endpoint without an invalid nudge",
  ({ band, split, globalSplit, transform }) => {
    const source = {
      ...overlay(`duplicate-${band}`, band, transform),
      naturalWidth: 100,
      naturalHeight: 100,
    };
    useRepurposeStore.setState({ overlays: [source], splitRatio: globalSplit });

    const copyId = useRepurposeStore
      .getState()
      .duplicateOverlay(source.id, rect, split);
    const copy = useRepurposeStore
      .getState()
      .overlays.find((item) => item.id === copyId)!;
    const box = overlayAABBNorm(
      copy.transform,
      copy.naturalWidth,
      copy.naturalHeight,
      rect
    );

    if (band === "screen") expect(box.maxY).toBeCloseTo(split, 10);
    if (band === "face") expect(box.minY).toBeGreaterThanOrEqual(split);
    if (band === "free") {
      expect(copy.transform.x).toBeCloseTo(source.transform.x + 0.04, 10);
      expect(copy.transform.y).toBeCloseTo(source.transform.y + 0.04, 10);
    }
  }
);
