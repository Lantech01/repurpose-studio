import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SfxClipBlock } from "@/app/repurpose-studio/_components/SfxClipBlock";
import type { SfxClip } from "@/lib/repurpose/types";

const clip: SfxClip = {
  id: "sfx-1",
  name: "Whoosh",
  source: { kind: "built-in", key: "whoosh" },
  origin: "automatic",
  timelineStart: 1,
  sourceStart: 0.25,
  sourceEnd: 1.25,
  gain: 1,
  fadeInSec: 0,
  fadeOutSec: 0,
  muted: true,
};

const editProps = {
  projectDuration: 3,
  sourceDuration: 2,
  timelineStep: 0.1,
  onMoveBy: vi.fn(),
  onTrimBy: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SfxClipBlock", () => {
  it("uses a non-interactive group with separate focusable controls and announces state", () => {
    const onSelect = vi.fn();
    render(<SfxClipBlock clip={clip} left={10} width={90} top={3} height={28}
      selected missing waveform={null} onSelect={onSelect} onBodyPointerDown={vi.fn()}
      onEdgePointerDown={vi.fn()} onDelete={vi.fn()} {...editProps} />);

    const block = screen.getByRole("group", { name: /Whoosh.*automatic.*0:01.0.*0:02.0.*muted.*missing/i });
    expect(block).toHaveAttribute("data-sfx-clip-id", "sfx-1");
    const select = screen.getByRole("button", { name: /Select Whoosh.*automatic.*muted.*missing/i });
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(block.querySelector("button button")).toBeNull();
    expect(screen.getByText("Automatic")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
  });

  it("supports keyboard selection and exposes delete in the tab order", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={onSelect}
      onBodyPointerDown={vi.fn()} onEdgePointerDown={vi.fn()} onDelete={onDelete} {...editProps} />);

    await user.tab();
    expect(screen.getByRole("button", { name: /Select Whoosh/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Delete Whoosh" })).toHaveFocus();
    await user.keyboard(" ");

    expect(onSelect).toHaveBeenCalledWith("sfx-1");
    expect(onDelete).toHaveBeenCalledWith("sfx-1");
  });

  it("selects when its actual focusable selection control receives focus", () => {
    const onSelect = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={onSelect}
      onBodyPointerDown={vi.fn()} onEdgePointerDown={vi.fn()} onDelete={vi.fn()} {...editProps} />);

    screen.getByRole("button", { name: /Select Whoosh/ }).focus();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("sfx-1");
  });

  it("routes body, trim, selection, and delete actions exclusively", () => {
    const onSelect = vi.fn();
    const onBodyPointerDown = vi.fn();
    const onEdgePointerDown = vi.fn();
    const onDelete = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={onSelect}
      onBodyPointerDown={onBodyPointerDown} onEdgePointerDown={onEdgePointerDown}
      onDelete={onDelete} {...editProps} />);

    fireEvent.click(screen.getByRole("button", { name: /Select Whoosh/ }));
    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh start"), { clientX: 4 });
    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh end"), { clientX: 90 });
    fireEvent.click(screen.getByRole("button", { name: "Delete Whoosh" }));
    expect(onSelect).toHaveBeenCalledWith("sfx-1");
    expect(onEdgePointerDown).toHaveBeenNthCalledWith(1, clip, "start", expect.objectContaining({
      clientX: 4,
      captureTarget: screen.getByLabelText("Trim Whoosh start"),
    }));
    expect(onEdgePointerDown).toHaveBeenNthCalledWith(2, clip, "end", expect.objectContaining({
      clientX: 90,
      captureTarget: screen.getByLabelText("Trim Whoosh end"),
    }));
    expect(onDelete).toHaveBeenCalledWith("sfx-1");
  });

  it("moves by deterministic keyboard steps and accelerates with Shift", () => {
    const onMoveBy = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={vi.fn()}
      onBodyPointerDown={vi.fn()} onEdgePointerDown={vi.fn()} onDelete={vi.fn()}
      {...editProps} onMoveBy={onMoveBy} />);
    const selection = screen.getByRole("button", { name: /Select Whoosh/ });

    fireEvent.keyDown(selection, { key: "ArrowRight" });
    fireEvent.keyDown(selection, { key: "ArrowLeft", shiftKey: true });

    expect(onMoveBy).toHaveBeenNthCalledWith(1, "sfx-1", 0.1);
    expect(onMoveBy).toHaveBeenNthCalledWith(2, "sfx-1", -1);
  });

  it("exposes keyboard-adjustable trim sliders with meaningful ranges", () => {
    const onSelect = vi.fn();
    const onTrimBy = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={onSelect}
      onBodyPointerDown={vi.fn()} onEdgePointerDown={vi.fn()} onDelete={vi.fn()}
      {...editProps} onTrimBy={onTrimBy} />);
    const start = screen.getByRole("slider", { name: "Trim Whoosh start" });
    const end = screen.getByRole("slider", { name: "Trim Whoosh end" });

    expect(start).toHaveAttribute("aria-valuemin", "0.75");
    expect(start).toHaveAttribute("aria-valuemax", "1.999");
    expect(start).toHaveAttribute("aria-valuenow", "1");
    expect(end).toHaveAttribute("aria-valuemin", "1.001");
    expect(end).toHaveAttribute("aria-valuemax", "2.75");
    expect(end).toHaveAttribute("aria-valuenow", "2");
    fireEvent.keyDown(start, { key: "ArrowRight" });
    fireEvent.keyDown(end, { key: "ArrowLeft" });
    fireEvent.keyDown(start, { key: "Enter" });

    expect(onTrimBy).toHaveBeenNthCalledWith(1, "sfx-1", "start", 0.1);
    expect(onTrimBy).toHaveBeenNthCalledWith(2, "sfx-1", "end", -0.1);
    expect(onSelect).toHaveBeenCalledWith("sfx-1");
  });

  it("ignores non-primary pointer presses on both trim handles", () => {
    const onEdgePointerDown = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={vi.fn()}
      onBodyPointerDown={vi.fn()} onEdgePointerDown={onEdgePointerDown} onDelete={vi.fn()}
      {...editProps} />);

    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh start"), { button: 1, clientX: 4 });
    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh end"), { button: 2, clientX: 90 });

    expect(onEdgePointerDown).not.toHaveBeenCalled();
  });

  it("bounds waveform sampling and canvas dimensions at extreme zoom and high DPR", () => {
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      setTransform: vi.fn(),
      fillStyle: "",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.stubGlobal("devicePixelRatio", 8);
    const longClip: SfxClip = {
      ...clip,
      source: { kind: "imported", assetId: "long", srcDuration: 3600 },
      sourceStart: 0,
      sourceEnd: 3600,
    };
    const waveform = {
      duration: 3600,
      peaks: new Float32Array(4000).fill(0.5),
    };

    const rendered = render(<SfxClipBlock clip={longClip} left={0} width={3600 * 400} top={0} height={30}
      selected={false} missing={false} waveform={waveform} onSelect={vi.fn()}
      onBodyPointerDown={vi.fn()} onEdgePointerDown={vi.fn()} onDelete={vi.fn()} {...editProps} />);
    const longCanvas = rendered.container.querySelector("canvas") as HTMLCanvasElement;

    expect(longCanvas.style.width).toBe("8192px");
    expect(longCanvas.style.height).toBe("30px");
    expect(longCanvas.width).toBeLessThanOrEqual(16384);
    expect(longCanvas.height).toBeLessThanOrEqual(16384);
    expect(context.fillRect.mock.calls.length).toBeLessThanOrEqual(4096);

    rendered.rerender(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={{ duration: 2, peaks: waveform.peaks }} onSelect={vi.fn()}
      onBodyPointerDown={vi.fn()} onEdgePointerDown={vi.fn()} onDelete={vi.fn()} {...editProps} />);
    const shortCanvas = rendered.container.querySelector("canvas") as HTMLCanvasElement;

    expect(shortCanvas.style.width).toBe("100px");
    expect(shortCanvas.width).toBe(200);
    expect(context.fillRect).toHaveBeenCalled();
  });
});
