import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SfxPanel } from "@/app/repurpose-studio/_components/SfxPanel";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip } from "@/lib/repurpose/types";

const baseClip: Clip = {
  id: "clip-1",
  kind: "take",
  label: "Clip 1",
  srcStart: 0,
  srcEnd: 4,
  timelineStart: 0,
  timelineEnd: 4,
  kept: true,
  isKeeperTake: true,
  occurrences: [{ start: 0, end: 4 }],
  keeperIndex: 0,
};

function prepareProject(): void {
  useRepurposeStore.setState({
    clips: [baseClip],
    words: [{ text: "click", start: 1, end: 1.2 }],
    duration: 4,
    sfxTrack: null,
    sfxGenerating: false,
  });
}

function delayedFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  resolve: () => void;
  signal: () => AbortSignal;
} {
  let resolve!: (response: Response) => void;
  let requestSignal!: AbortSignal;
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>((responseResolve) => { resolve = responseResolve; });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    resolve: () => resolve(new Response(JSON.stringify({
      path: "C:\\cache\\sfx-result.wav",
      url: "/api/repurpose/sfx?path=result",
    }), { status: 200, headers: { "Content-Type": "application/json" } })),
    signal: () => requestSignal,
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  prepareProject();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SfxPanel generation ownership", () => {
  it("aborts and ignores a delayed render after plan inputs are edited", async () => {
    const request = delayedFetch();
    render(<SfxPanel projectId="project-a" />);

    fireEvent.click(screen.getByRole("button", { name: "Generate SFX track" }));
    await waitFor(() => expect(request.fetchMock).toHaveBeenCalledTimes(1));
    act(() => useRepurposeStore.setState({ clips: [{ ...baseClip, label: "Edited" }] }));
    await waitFor(() => expect(request.signal().aborted).toBe(true));
    await act(async () => request.resolve());

    expect(useRepurposeStore.getState().sfxTrack).toBeNull();
    expect(useRepurposeStore.getState().sfxGenerating).toBe(false);
    expect(screen.queryByText(/SFX render failed|SFX generation failed/i)).not.toBeInTheDocument();
  });

  it("aborts and ignores a delayed render across a project route reset", async () => {
    const request = delayedFetch();
    const rendered = render(<SfxPanel projectId="project-a" />);

    fireEvent.click(screen.getByRole("button", { name: "Generate SFX track" }));
    await waitFor(() => expect(request.fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      rendered.rerender(<SfxPanel projectId="project-b" />);
      useRepurposeStore.getState().resetProject();
    });
    await waitFor(() => expect(request.signal().aborted).toBe(true));
    await act(async () => request.resolve());

    expect(useRepurposeStore.getState().sfxTrack).toBeNull();
    expect(useRepurposeStore.getState().projectEpoch).toBe(1);
  });

  it("aborts the server request and cannot publish after unmount", async () => {
    const request = delayedFetch();
    const rendered = render(<SfxPanel projectId="project-a" />);

    fireEvent.click(screen.getByRole("button", { name: "Generate SFX track" }));
    await waitFor(() => expect(request.fetchMock).toHaveBeenCalledTimes(1));
    rendered.unmount();
    expect(request.signal().aborted).toBe(true);
    await act(async () => request.resolve());

    expect(useRepurposeStore.getState().sfxTrack).toBeNull();
    expect(useRepurposeStore.getState().sfxGenerating).toBe(false);
  });
});
