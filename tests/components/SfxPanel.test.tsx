import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SfxPanel } from "@/app/repurpose-studio/_components/SfxPanel";
import { createSfxImportOwner, registerSfxImportOwner, releaseSfxImportOwner } from "@/lib/repurpose/sfx-ingest-client";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, SfxClip } from "@/lib/repurpose/types";

const scene: Clip = {
  id: "scene", kind: "take", label: "Scene", srcStart: 0, srcEnd: 5,
  timelineStart: 0, timelineEnd: 5, kept: true, isKeeperTake: true,
  occurrences: [{ start: 0, end: 5 }], keeperIndex: 0,
};

const manual: SfxClip = {
  id: "manual", name: "Manual ding", source: { kind: "built-in", key: "ding" },
  origin: "manual", timelineStart: 2, sourceStart: 0, sourceEnd: 1, gain: 1,
  fadeInSec: 0, fadeOutSec: 0, muted: false,
};

let owner: ReturnType<typeof createSfxImportOwner>;
let close: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({ clips: [scene], words: [{ text: "click", start: 1, end: 1.2 }], duration: 5 });
  owner = registerSfxImportOwner(createSfxImportOwner("project-a"));
  close = vi.fn().mockResolvedValue(undefined);
  class AudioContextMock {
    decodeAudioData = vi.fn().mockResolvedValue({
      duration: 1, length: 2, numberOfChannels: 1, sampleRate: 2,
      getChannelData: () => Float32Array.from([0.2, 0.5]),
    });
    close = close;
  }
  vi.stubGlobal("AudioContext", AudioContextMock);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new ArrayBuffer(4), { status: 200 })));
});

afterEach(() => {
  releaseSfxImportOwner(owner);
  cleanup();
  vi.unstubAllGlobals();
});

describe("SfxPanel workspace", () => {
  it("groups searchable built-ins and adds at the current playhead", () => {
    useRepurposeStore.setState({ playhead: 1.5 });
    render(<SfxPanel projectId="project-a" sfxImportOwner={owner} />);
    expect(screen.getByText("Interaction")).toBeInTheDocument();
    expect(screen.getByText("Transition")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sound effects" }), { target: { value: "correct ding" } });
    expect(screen.getByText("Correct Ding")).toBeInTheDocument();
    expect(screen.queryByText("Mouse Click")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Correct Ding at playhead" }));
    expect(useRepurposeStore.getState().sfxClips[0]).toMatchObject({ timelineStart: 1.5, origin: "manual" });
  });

  it("auditions one source at a time and cleans up on unmount", () => {
    const pause = vi.fn();
    const play = vi.fn().mockResolvedValue(undefined);
    class AudioMock {
      pause = pause;
      play = play;
      currentTime = 0;
    }
    vi.stubGlobal("Audio", AudioMock);
    const rendered = render(<SfxPanel projectId="project-a" sfxImportOwner={owner} />);
    fireEvent.click(screen.getByRole("button", { name: "Audition Mouse Click" }));
    fireEvent.click(screen.getByRole("button", { name: "Audition Whoosh" }));
    expect(play).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it("regenerates automatic clips atomically while preserving manual clips", async () => {
    useRepurposeStore.setState({ sfxClips: [manual], past: [], future: [] });
    render(<SfxPanel projectId="project-a" sfxImportOwner={owner} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate automatic effects" }));
    await waitFor(() => expect(useRepurposeStore.getState().sfxGenerating).toBe(false));
    expect(useRepurposeStore.getState().sfxClips).toEqual(expect.arrayContaining([
      manual,
      expect.objectContaining({ origin: "automatic", source: { kind: "built-in", key: "mouse_click" } }),
    ]));
    expect(vi.mocked(fetch).mock.calls.every(([url, init]) => String(url).includes("?key=") && init?.method !== "POST")).toBe(true);
  });

  it("leaves the complete collection unchanged when validation fails or the document revision changes", async () => {
    useRepurposeStore.setState({ sfxClips: [manual], past: [], future: [] });
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; })));
    render(<SfxPanel projectId="project-a" sfxImportOwner={owner} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate automatic effects" }));
    await waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    act(() => {
      useRepurposeStore.getState().setSfxClipMuted("manual", true);
      useRepurposeStore.getState().undo();
    });
    resolveFetch(new Response(new ArrayBuffer(4), { status: 200 }));
    await waitFor(() => expect(useRepurposeStore.getState().sfxGenerating).toBe(false));
    expect(useRepurposeStore.getState().sfxClips).toEqual([manual]);
  });

  it("edits selected clip controls with one gesture history entry and supports replace, duplicate, mute, and delete", () => {
    useRepurposeStore.setState({ sfxClips: [manual], selectedSfxClipId: manual.id, past: [], future: [] });
    render(<SfxPanel projectId="project-a" sfxImportOwner={owner} />);
    const gain = screen.getByRole("slider", { name: "Gain for Manual ding" });
    fireEvent.pointerDown(gain);
    fireEvent.change(gain, { target: { value: "1.5" } });
    fireEvent.pointerUp(gain);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Mute Manual ding" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Manual ding" }));
    expect(useRepurposeStore.getState().sfxClips).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Replace Manual ding with Mouse Click" }));
    expect(useRepurposeStore.getState().sfxClips.find((clip) => clip.id === useRepurposeStore.getState().selectedSfxClipId)).toMatchObject({ origin: "manual", source: { kind: "built-in", key: "mouse_click" } });
    fireEvent.click(screen.getByRole("button", { name: /Delete Mouse Click/ }));
    expect(useRepurposeStore.getState().sfxClips).toHaveLength(1);
  });

  it("shows unavailable imported inventory without removing selected state", () => {
    useRepurposeStore.setState({
      sfxAssets: [{ id: "asset", name: "Lost hit", sourcePath: "", srcDuration: 1 }],
      sfxClips: [{ ...manual, source: { kind: "imported", assetId: "missing", srcDuration: 1 } }],
      selectedSfxClipId: manual.id,
    });
    render(<SfxPanel projectId="project-a" sfxImportOwner={owner} />);
    expect(screen.getAllByText(/Unavailable/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Manual ding")).toBeInTheDocument();
  });
});
