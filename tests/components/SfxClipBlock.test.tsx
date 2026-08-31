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

afterEach(cleanup);

describe("SfxClipBlock", () => {
  it("uses a non-interactive group with separate focusable controls and announces state", () => {
    const onSelect = vi.fn();
    render(<SfxClipBlock clip={clip} left={10} width={90} top={3} height={28}
      selected missing waveform={null} onSelect={onSelect} onBodyPointerDown={vi.fn()}
      onEdgePointerDown={vi.fn()} onDelete={vi.fn()} />);

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
      onBodyPointerDown={vi.fn()} onEdgePointerDown={vi.fn()} onDelete={onDelete} />);

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

  it("routes body, trim, selection, and delete actions exclusively", () => {
    const onSelect = vi.fn();
    const onBodyPointerDown = vi.fn();
    const onEdgePointerDown = vi.fn();
    const onDelete = vi.fn();
    render(<SfxClipBlock clip={clip} left={0} width={100} top={0} height={30}
      selected={false} missing={false} waveform={null} onSelect={onSelect}
      onBodyPointerDown={onBodyPointerDown} onEdgePointerDown={onEdgePointerDown}
      onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: /Select Whoosh/ }));
    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh start"), { clientX: 4 });
    fireEvent.pointerDown(screen.getByLabelText("Trim Whoosh end"), { clientX: 90 });
    fireEvent.click(screen.getByRole("button", { name: "Delete Whoosh" }));
    expect(onSelect).toHaveBeenCalledWith("sfx-1");
    expect(onEdgePointerDown).toHaveBeenNthCalledWith(1, clip, "start", 4);
    expect(onEdgePointerDown).toHaveBeenNthCalledWith(2, clip, "end", 90);
    expect(onDelete).toHaveBeenCalledWith("sfx-1");
  });
});
