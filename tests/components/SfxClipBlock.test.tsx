import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

describe("SfxClipBlock", () => {
  it("is focusable, selectable, and announces document state", () => {
    render(<SfxClipBlock clip={clip} left={10} width={90} top={3} height={28}
      selected missing waveform={null} onSelect={vi.fn()} onBodyPointerDown={vi.fn()}
      onEdgePointerDown={vi.fn()} onDelete={vi.fn()} />);

    const block = screen.getByRole("button", { name: /Whoosh.*automatic.*0:01.0.*0:02.0.*muted.*missing/i });
    expect(block).toHaveAttribute("data-sfx-clip-id", "sfx-1");
    expect(block).toHaveAttribute("aria-pressed", "true");
    expect(block).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Automatic")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
  });

  it("routes body, trim, selection, and delete actions exclusively", () => {
    const onSelect = vi.fn();
    const onBodyPointerDown = vi.fn();
    const onEdgePointerDown = vi.fn();
    const onDelete = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={onSelect}
      onBodyPointerDown={onBodyPointerDown} onEdgePointerDown={onEdgePointerDown}
      onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId("sfx-block-sfx-1"));
    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh start"), { clientX: 4 });
    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh end"), { clientX: 90 });
    fireEvent.click(screen.getByRole("button", { name: "Delete Whoosh" }));
    expect(onSelect).toHaveBeenCalledWith("sfx-1");
    expect(onEdgePointerDown).toHaveBeenNthCalledWith(1, clip, "start", 4);
    expect(onEdgePointerDown).toHaveBeenNthCalledWith(2, clip, "end", 90);
    expect(onDelete).toHaveBeenCalledWith("sfx-1");
  });
});
