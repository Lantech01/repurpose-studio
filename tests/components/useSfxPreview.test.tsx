import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSfxPreview } from "@/app/repurpose-studio/_components/useSfxPreview";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { SfxClip } from "@/lib/repurpose/types";

const starts: ReturnType<typeof vi.fn>[] = [];
const stops: ReturnType<typeof vi.fn>[] = [];
const rates: Array<{ value: number }> = [];
const gains: Array<{ value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }> = [];
let close: ReturnType<typeof vi.fn>;

const effect = (id: string, timelineStart: number): SfxClip => ({
  id, name: "Whoosh", source: { kind: "built-in", key: "whoosh" }, origin: "manual",
  timelineStart, sourceStart: .25, sourceEnd: 1.25, gain: .5, fadeInSec: .2,
  fadeOutSec: .4, muted: false,
});

function Harness({ clips = [effect("a", 1), effect("b", 2)], onWarning = vi.fn() }: { clips?: SfxClip[]; onWarning?: (message: string | null) => void }) {
  useSfxPreview(clips, [], onWarning);
  return null;
}

beforeEach(() => {
  starts.length = 0;
  stops.length = 0;
  rates.length = 0;
  gains.length = 0;
  close = vi.fn().mockResolvedValue(undefined);
  class AudioContextMock {
    currentTime = 10;
    destination = {};
    resume = vi.fn().mockResolvedValue(undefined);
    close = close;
    decodeAudioData = vi.fn().mockResolvedValue({
      duration: 3, length: 6, sampleRate: 2, numberOfChannels: 1,
      getChannelData: () => Float32Array.from([.1, .5, .2, .1, .1, .1]),
    });
    createBufferSource() {
      const start = vi.fn();
      const stop = vi.fn();
      const rate = { value: 1 };
      starts.push(start); stops.push(stop); rates.push(rate);
      return { buffer: null, playbackRate: rate, connect: vi.fn(), disconnect: vi.fn(), start, stop };
    }
    createGain() {
      const gain = { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() };
      gains.push(gain);
      return { gain, connect: vi.fn().mockReturnThis(), disconnect: vi.fn() };
    }
  }
  vi.stubGlobal("AudioContext", AudioContextMock);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new ArrayBuffer(4), { status: 200 })));
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({ playhead: 1.5, playbackRate: 2, isPlaying: false, duration: 5 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSfxPreview", () => {
  it("decodes repeated identities once and schedules active and future overlapping clips", async () => {
    render(<Harness />);
    useRepurposeStore.setState({ isPlaying: true });
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(starts[0]).toHaveBeenCalledWith(10, .75, .5);
    expect(starts[1]).toHaveBeenCalledWith(10.25, .25, 1);
    expect(rates.map((rate) => rate.value)).toEqual([2, 2]);
    expect(gains[0].linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.25);
    expect(gains[1].linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.75);
  });

  it("stops obsolete nodes on seek, edit, pause, and unmount", async () => {
    const rendered = render(<Harness />);
    useRepurposeStore.setState({ isPlaying: true });
    await waitFor(() => expect(starts).toHaveLength(2));
    useRepurposeStore.setState({ playhead: 3 });
    await waitFor(() => expect(stops.every((stop) => stop.mock.calls.length > 0)).toBe(true));
    rendered.rerender(<Harness clips={[effect("replacement", 0)]} />);
    useRepurposeStore.setState({ isPlaying: false });
    rendered.unmount();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports and skips unavailable imported sources without mutating clips", async () => {
    const onWarning = vi.fn();
    const missing = { ...effect("missing", 0), source: { kind: "imported", assetId: "lost", srcDuration: 1 } as const };
    render(<Harness clips={[missing]} onWarning={onWarning} />);
    useRepurposeStore.setState({ playhead: 0, isPlaying: true });
    await waitFor(() => expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i)));
    expect(starts).toHaveLength(0);
    expect(missing.source.assetId).toBe("lost");
  });

  it("continues an active fade-out without resetting the clip to full gain", async () => {
    render(<Harness clips={[effect("fading", 1)]} />);
    useRepurposeStore.setState({ playhead: 1.8, isPlaying: true });

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(gains[0].setValueAtTime).toHaveBeenCalledTimes(1);
    expect(gains[0].linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.1);
  });
});
