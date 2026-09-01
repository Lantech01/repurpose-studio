import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/repurpose/caption-fonts", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/repurpose/caption-fonts")
  >();
  return { ...original, loadCaptionFonts: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/repurpose/captions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/repurpose/captions")>();
  return { ...original, drawCaptions: vi.fn() };
});

import { CaptionPanel } from "@/app/repurpose-studio/_components/CaptionPanel";
import {
  DEFAULT_CAPTION_STYLE,
  resolveBlockStyle,
  type CaptionBlock,
} from "@/lib/repurpose/captions";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { splitRatioAt } from "@/lib/repurpose/time-map";
import type { Clip } from "@/lib/repurpose/types";

function clip(
  id: string,
  timelineStart: number,
  splitRatio: number,
  transitionIn?: Clip["transitionIn"]
): Clip {
  return {
    id,
    kind: "take",
    label: id,
    srcStart: timelineStart,
    srcEnd: timelineStart + 1,
    timelineStart,
    timelineEnd: timelineStart + 1,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: timelineStart, end: timelineStart + 1 }],
    keeperIndex: 0,
    splitRatio,
    transitionIn,
  };
}

function selectedBlock(start: number, splitOffsetPct: number): CaptionBlock {
  return {
    id: "selected-caption",
    words: [{ text: "VISIBLE", start, end: start + 0.8 }],
    start,
    end: start + 0.8,
    keywordIndex: 0,
    overrideStyle: { splitOffsetPct },
  };
}

function positionSlider(container: HTMLElement): HTMLInputElement {
  const slider = container.querySelector(
    'input[type="range"][aria-label="Posicao absoluta da legenda"]'
  );
  if (!(slider instanceof HTMLInputElement)) {
    throw new Error("Missing selected caption position slider");
  }
  return slider;
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(cleanup);

describe("CaptionPanel explicit caption placement", () => {
  test("keeps a pointer drag longer than 700ms in one explicit transaction", () => {
    vi.useFakeTimers();
    try {
      const block: CaptionBlock = {
        ...selectedBlock(0, 0),
        overrideStyle: { pinToSplit: false, positionYPct: 0.63 },
      };
      useRepurposeStore.setState({
        clips: [clip("scene", 0, 0.5)],
        playhead: 0.4,
        words: block.words,
        captionBlocks: [block],
        selectedCaptionBlockId: block.id,
      });
      const rendered = render(<CaptionPanel />);
      const slider = positionSlider(rendered.container);

      fireEvent.pointerDown(slider, { pointerId: 11 });
      fireEvent.change(slider, { target: { value: "0.68" } });
      vi.advanceTimersByTime(1_000);
      fireEvent.change(slider, { target: { value: "0.72" } });
      fireEvent.pointerUp(slider, { pointerId: 11 });

      expect(
        useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
      ).toBe(0.72);
      expect(useRepurposeStore.getState().past).toHaveLength(1);
      useRepurposeStore.getState().undo();
      expect(
        useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
      ).toBe(0.63);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps a held keyboard adjustment in one explicit transaction", () => {
    vi.useFakeTimers();
    try {
      const block: CaptionBlock = {
        ...selectedBlock(0, 0),
        overrideStyle: { pinToSplit: false, positionYPct: 0.63 },
      };
      useRepurposeStore.setState({
        clips: [clip("scene", 0, 0.5)],
        playhead: 0.4,
        words: block.words,
        captionBlocks: [block],
        selectedCaptionBlockId: block.id,
      });
      const rendered = render(<CaptionPanel />);
      const slider = positionSlider(rendered.container);

      slider.focus();
      fireEvent.keyDown(slider, { key: "ArrowRight" });
      vi.advanceTimersByTime(1_000);
      fireEvent.keyDown(slider, { key: "ArrowRight", repeat: true });
      fireEvent.keyUp(slider, { key: "ArrowRight" });

      expect(
        useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
      ).toBeCloseTo(0.64, 10);
      expect(useRepurposeStore.getState().past).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rolls back pointercancel and ignores a queued change until fresh pointerdown", () => {
    const block: CaptionBlock = {
      ...selectedBlock(0, 0),
      overrideStyle: { pinToSplit: false, positionYPct: 0.63 },
    };
    useRepurposeStore.setState({
      clips: [clip("scene", 0, 0.5)],
      playhead: 0.4,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
    });
    const rendered = render(<CaptionPanel />);
    const slider = positionSlider(rendered.container);

    fireEvent.pointerDown(slider, { pointerId: 12 });
    fireEvent.change(slider, { target: { value: "0.7" } });
    fireEvent.pointerCancel(slider, { pointerId: 12 });
    fireEvent.change(slider, { target: { value: "0.9" } });

    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);
    expect(useRepurposeStore.getState().past).toEqual([]);

    fireEvent.pointerDown(slider, { pointerId: 13 });
    fireEvent.change(slider, { target: { value: "0.75" } });
    fireEvent.pointerUp(slider, { pointerId: 13 });
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.75);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  test("does not capture history for a no-op pointer transaction", () => {
    const block: CaptionBlock = {
      ...selectedBlock(0, 0),
      overrideStyle: { pinToSplit: false, positionYPct: 0.63 },
    };
    useRepurposeStore.setState({
      clips: [clip("scene", 0, 0.5)],
      playhead: 0.4,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
    });
    const rendered = render(<CaptionPanel />);
    const slider = positionSlider(rendered.container);

    fireEvent.pointerDown(slider, { pointerId: 14 });
    fireEvent.change(slider, { target: { value: "0.63" } });
    fireEvent.pointerUp(slider, { pointerId: 14 });

    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  test("starts a position transaction when detached mode is inherited globally", () => {
    const block: CaptionBlock = {
      ...selectedBlock(0, 0),
      overrideStyle: { fill: "#abcdef" },
    };
    useRepurposeStore.setState({
      clips: [clip("scene", 0, 0.5)],
      playhead: 0.4,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
      captionStyle: {
        ...DEFAULT_CAPTION_STYLE,
        pinToSplit: false,
        positionYPct: 0.55,
      },
    });
    const rendered = render(<CaptionPanel />);
    const slider = positionSlider(rendered.container);

    fireEvent.pointerDown(slider, { pointerId: 16 });
    fireEvent.change(slider, { target: { value: "0.7" } });
    fireEvent.pointerUp(slider, { pointerId: 16 });

    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#abcdef",
      pinToSplit: false,
      positionYPct: 0.7,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  test("moves a detached caption with Tab and held Arrow keys in one Undo step", async () => {
    const user = userEvent.setup();
    const block: CaptionBlock = {
      ...selectedBlock(0, 0),
      overrideStyle: {
        fill: "#abcdef",
        pinToSplit: false,
        positionYPct: 0.63,
      },
    };
    useRepurposeStore.setState({
      clips: [clip("scene", 0, 0.5)],
      playhead: 0.4,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
      captionStyle: { ...DEFAULT_CAPTION_STYLE, pinToSplit: true },
    });
    const rendered = render(<CaptionPanel />);
    const attachButton = rendered.getByRole("button", {
      name: "Fixar na divisao",
    });
    const slider = rendered.getByRole("slider", {
      name: "Posicao absoluta da legenda",
    });

    attachButton.focus();
    await user.tab();
    expect(slider).toHaveFocus();
    await user.keyboard("{ArrowRight>2/}");

    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBeCloseTo(0.64, 10);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBeCloseTo(0.63, 10);
  });

  test("operates detach and attach buttons through Tab with Enter and Space", async () => {
    const user = userEvent.setup();
    const block: CaptionBlock = {
      ...selectedBlock(0, 0),
      overrideStyle: { fill: "#123456", pinToSplit: true },
    };
    useRepurposeStore.setState({
      clips: [clip("scene", 0, 0.5)],
      playhead: 0.4,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
      captionStyle: {
        ...DEFAULT_CAPTION_STYLE,
        pinToSplit: false,
        splitOffsetPct: 0.1,
      },
    });
    const rendered = render(<CaptionPanel />);
    const textInput = rendered.getByRole("textbox");

    textInput.focus();
    await user.tab();
    expect(
      rendered.getByRole("button", { name: "Soltar legenda" })
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: false,
      positionYPct: 0.6,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);

    textInput.focus();
    await user.tab();
    expect(
      rendered.getByRole("button", { name: "Fixar na divisao" })
    ).toHaveFocus();
    await user.keyboard(" ");
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: true,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(2);
  });

  test.each([
    [0, -0.2],
    [1, 0.2],
  ])(
    "requests raw settled split %s plus inherited offset %s on detach",
    (settledSplit, inheritedOffset) => {
      const block: CaptionBlock = {
        ...selectedBlock(0, 0),
        overrideStyle: { pinToSplit: true },
      };
      const detachCaptionBlock = vi.fn();
      useRepurposeStore.setState({
        clips: [clip("endpoint", 0, settledSplit)],
        playhead: 0.4,
        words: block.words,
        captionBlocks: [block],
        selectedCaptionBlockId: block.id,
        captionStyle: {
          ...DEFAULT_CAPTION_STYLE,
          pinToSplit: false,
          splitOffsetPct: inheritedOffset,
        },
        detachCaptionBlock,
      });
      const rendered = render(<CaptionPanel />);

      fireEvent.click(rendered.getByRole("button", { name: "Soltar legenda" }));

      expect(detachCaptionBlock).toHaveBeenCalledWith(
        block.id,
        settledSplit + inheritedOffset
      );
    }
  );

  test("detaches an attached block from the settled split plus inherited offset", () => {
    const clips = [clip("screen-full", 0, 1)];
    const block: CaptionBlock = {
      ...selectedBlock(0, 0),
      textOverride: ["FIXED"],
      overrideStyle: { fill: "#123456", pinToSplit: true },
    };
    useRepurposeStore.setState({
      clips,
      playhead: 0.4,
      splitRatio: 0,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
      captionStyle: {
        ...DEFAULT_CAPTION_STYLE,
        pinToSplit: false,
        splitOffsetPct: -0.4,
      },
    });

    const rendered = render(<CaptionPanel />);
    expect(
      rendered.getByRole("button", { name: "Soltar legenda" })
    ).toBeVisible();
    expect(
      rendered.queryByRole("slider", { name: "Posicao absoluta da legenda" })
    ).toBeNull();

    fireEvent.click(rendered.getByRole("button", { name: "Soltar legenda" }));

    expect(splitRatioAt(clips, 0.4, 0)).toBe(1);
    expect(useRepurposeStore.getState().captionBlocks[0]).toMatchObject({
      textOverride: ["FIXED"],
      overrideStyle: {
        fill: "#123456",
        pinToSplit: false,
        positionYPct: 0.6,
      },
    });
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle
    ).not.toHaveProperty("splitOffsetPct");
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  test("offers a keyboard-labelled full-range slider only while detached", () => {
    const block: CaptionBlock = {
      ...selectedBlock(0, 0),
      textOverride: ["VISIBLE"],
      overrideStyle: {
        fill: "#abcdef",
        pinToSplit: false,
        positionYPct: 0.63,
        splitOffsetPct: 0.2,
      },
    };
    useRepurposeStore.setState({
      clips: [clip("scene", 0, 0.5)],
      playhead: 0.4,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
      captionStyle: { ...DEFAULT_CAPTION_STYLE, pinToSplit: true },
    });

    const rendered = render(<CaptionPanel />);
    const slider = positionSlider(rendered.container);
    expect(slider).toHaveAccessibleName("Posicao absoluta da legenda");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "1");
    expect(slider.valueAsNumber).toBeCloseTo(0.63, 10);
    expect(
      rendered.getByRole("button", { name: "Fixar na divisao" })
    ).toBeVisible();
    expect(
      rendered.getByRole("button", { name: "Reset block overrides" })
    ).toBeVisible();
    expect(rendered.queryByRole("button", { name: /^Reset$/ })).toBeNull();

    fireEvent.pointerDown(slider, { pointerId: 15 });
    fireEvent.change(slider, { target: { value: "0.68" } });
    fireEvent.change(slider, { target: { value: "0.72" } });
    fireEvent.pointerUp(slider, { pointerId: 15 });

    expect(useRepurposeStore.getState().captionBlocks[0]).toMatchObject({
      textOverride: ["VISIBLE"],
      overrideStyle: {
        fill: "#abcdef",
        pinToSplit: false,
        positionYPct: 0.72,
      },
    });
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle
    ).not.toHaveProperty("splitOffsetPct");
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);

    fireEvent.click(rendered.getByRole("button", { name: "Fixar na divisao" }));
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#abcdef",
      pinToSplit: true,
    });
    expect(
      rendered.queryByRole("slider", { name: "Posicao absoluta da legenda" })
    ).toBeNull();
    expect(
      rendered.getByRole("button", { name: "Soltar legenda" })
    ).toBeVisible();
  });
});

describe("caption block attachment store contract", () => {
  test("attaches explicitly while preserving unrelated style and inheriting future global offsets", () => {
    const block: CaptionBlock = {
      ...selectedBlock(0, -0.2),
      overrideStyle: {
        fill: "#123456",
        pinToSplit: false,
        positionYPct: 0.73,
        splitOffsetPct: -0.2,
      },
    };
    useRepurposeStore.setState({
      captionBlocks: [block],
      captionStyle: {
        ...DEFAULT_CAPTION_STYLE,
        pinToSplit: true,
        splitOffsetPct: 0.04,
      },
    });

    useRepurposeStore.getState().attachCaptionBlock(block.id);

    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: true,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);

    useRepurposeStore
      .getState()
      .patchCaptionStyle({ pinToSplit: false, splitOffsetPct: 0.18 });
    const resolved = resolveBlockStyle(
      useRepurposeStore.getState().captionStyle,
      useRepurposeStore.getState().captionBlocks[0]
    );
    expect(resolved).toMatchObject({ pinToSplit: true, splitOffsetPct: 0.18 });
  });

  test.each([
    [-1, 0],
    [0.63, 0.63],
    [2, 1],
  ])("detaches at requested position %s clamped to %s", (requested, expected) => {
    const block: CaptionBlock = {
      ...selectedBlock(0, 0.08),
      overrideStyle: {
        fill: "#abcdef",
        pinToSplit: true,
        positionYPct: 0.2,
        splitOffsetPct: 0.08,
      },
    };
    useRepurposeStore.setState({ captionBlocks: [block] });

    useRepurposeStore.getState().detachCaptionBlock(block.id, requested);

    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#abcdef",
      pinToSplit: false,
      positionYPct: expected,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  test("does not publish history for missing or unchanged attachment actions", () => {
    const attached: CaptionBlock = {
      ...selectedBlock(0, 0),
      overrideStyle: { fill: "#123456", pinToSplit: true },
    };
    const detached: CaptionBlock = {
      ...selectedBlock(1, 0),
      id: "detached-caption",
      overrideStyle: {
        fill: "#abcdef",
        pinToSplit: false,
        positionYPct: 0.62,
      },
    };
    useRepurposeStore.setState({ captionBlocks: [attached, detached] });
    const before = useRepurposeStore.getState();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore.subscribe(listener);

    useRepurposeStore.getState().attachCaptionBlock("missing");
    useRepurposeStore.getState().attachCaptionBlock(attached.id);
    useRepurposeStore.getState().detachCaptionBlock("missing", 0.5);
    useRepurposeStore.getState().detachCaptionBlock(detached.id, 0.62);
    unsubscribe();

    expect(useRepurposeStore.getState().captionBlocks).toBe(before.captionBlocks);
    expect(useRepurposeStore.getState().past).toBe(before.past);
    expect(listener).not.toHaveBeenCalled();
  });
});
