import { afterEach, describe, expect, it, vi } from "vitest";

import { probeBrowserVideo } from "@/lib/repurpose/native-media-probe";

type MediaEvent = "loadedmetadata" | "error";

class FakeVideo {
  muted = false;
  preload = "";
  src = "";
  duration = 3;
  videoWidth = 320;
  videoHeight = 180;
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  private listeners = new Map<MediaEvent, Set<EventListener>>();

  addEventListener(type: MediaEvent, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: MediaEvent, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: MediaEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

function installVideo(): FakeVideo {
  const video = new FakeVideo();
  vi.spyOn(document, "createElement").mockReturnValue(video as unknown as HTMLVideoElement);
  return video;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("probeBrowserVideo", () => {
  it("reports decoded metadata and cleans up the detached video", async () => {
    const video = installVideo();
    const probe = probeBrowserVideo("/api/repurpose/video?path=clip.mp4");

    expect(video.muted).toBe(true);
    expect(video.preload).toBe("metadata");
    video.emit("loadedmetadata");

    await expect(probe).resolves.toEqual({ decodable: true, durationSec: 3, width: 320, height: 180 });
    expect(video.listenerCount()).toBe(0);
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.src).toBe("");
  });

  it("does not accept finite duration when decoded dimensions are zero", async () => {
    const video = installVideo();
    video.videoWidth = 0;
    video.videoHeight = 0;
    const probe = probeBrowserVideo("clip.mov");

    video.emit("loadedmetadata");

    await expect(probe).resolves.toMatchObject({
      decodable: false,
      durationSec: 3,
      width: 0,
      height: 0,
      reason: "invalid-metadata",
    });
  });

  it("reports media errors and cleans up", async () => {
    const video = installVideo();
    const probe = probeBrowserVideo("clip.mov");

    video.emit("error");

    await expect(probe).resolves.toEqual({
      decodable: false,
      durationSec: 0,
      width: 0,
      height: 0,
      reason: "media-error",
    });
    expect(video.listenerCount()).toBe(0);
    expect(video.src).toBe("");
  });

  it("reports abort and detaches the signal listener", async () => {
    const video = installVideo();
    const aborter = new AbortController();
    const removeEventListener = vi.spyOn(aborter.signal, "removeEventListener");
    const probe = probeBrowserVideo("clip.mov", aborter.signal);

    aborter.abort();

    await expect(probe).resolves.toEqual({
      decodable: false,
      durationSec: 0,
      width: 0,
      height: 0,
      reason: "aborted",
    });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(video.listenerCount()).toBe(0);
  });

  it("times out after 15 seconds and cleans up", async () => {
    vi.useFakeTimers();
    const video = installVideo();
    const probe = probeBrowserVideo("clip.mov");

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(probe).resolves.toEqual({
      decodable: false,
      durationSec: 0,
      width: 0,
      height: 0,
      reason: "timeout",
    });
    expect(video.listenerCount()).toBe(0);
    expect(video.src).toBe("");
  });
});
