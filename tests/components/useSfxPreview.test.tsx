import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSfxPreview } from "@/app/repurpose-studio/_components/useSfxPreview";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { SfxClip } from "@/lib/repurpose/types";

const starts: ReturnType<typeof vi.fn>[] = [];
const stops: ReturnType<typeof vi.fn>[] = [];
const rates: Array<{ value: number }> = [];
const gains: Array<{ value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }> = [];
const sourceNodes: Array<{ disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
const gainDisconnects: ReturnType<typeof vi.fn>[] = [];
let close: ReturnType<typeof vi.fn>;
let decodeMock: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const decodedBuffer = {
  duration: 3, length: 6, sampleRate: 2, numberOfChannels: 1,
  getChannelData: () => Float32Array.from([.1, .5, .2, .1, .1, .1]),
};

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
  sourceNodes.length = 0;
  gainDisconnects.length = 0;
  close = vi.fn().mockResolvedValue(undefined);
  decodeMock = vi.fn().mockResolvedValue(decodedBuffer);
  class AudioContextMock {
    currentTime = 10;
    destination = {};
    resume = vi.fn().mockResolvedValue(undefined);
    close = close;
    decodeAudioData = decodeMock;
    createBufferSource() {
      const start = vi.fn();
      const stop = vi.fn();
      const rate = { value: 1 };
      starts.push(start); stops.push(stop); rates.push(rate);
      const node = { buffer: null, playbackRate: rate, connect: vi.fn(), disconnect: vi.fn(), start, stop, onended: null as (() => void) | null };
      sourceNodes.push(node);
      return node;
    }
    createGain() {
      const gain = { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() };
      gains.push(gain);
      const disconnect = vi.fn();
      gainDisconnects.push(disconnect);
      return { gain, connect: vi.fn().mockReturnThis(), disconnect };
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

  it("uses the live playhead after a delayed decode instead of the captured schedule head", async () => {
    const decode = deferred<typeof decodedBuffer>();
    decodeMock.mockReturnValueOnce(decode.promise);
    useRepurposeStore.setState({ playhead: 1.1, playbackRate: 1 });
    render(<Harness clips={[effect("delayed", 1)]} />);

    useRepurposeStore.setState({ isPlaying: true });
    await waitFor(() => expect(decodeMock).toHaveBeenCalledOnce());
    useRepurposeStore.setState({ playhead: 1.25 });
    decode.resolve(decodedBuffer);

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toHaveBeenCalledWith(10, .5, .75);
  });

  it("reuses a pending decode across seek and rate reschedules and schedules only the newest owner", async () => {
    const decode = deferred<typeof decodedBuffer>();
    decodeMock.mockReturnValueOnce(decode.promise);
    useRepurposeStore.setState({ playhead: 1.1, playbackRate: 1 });
    render(<Harness clips={[effect("pending", 1)]} />);

    useRepurposeStore.setState({ isPlaying: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    useRepurposeStore.setState({ playhead: 1.6, playbackRate: .5 });
    decode.resolve(decodedBuffer);

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(fetch).toHaveBeenCalledOnce();
    expect(rates[0].value).toBe(.5);
    const [, offset, duration] = starts[0].mock.calls[0] as [number, number, number];
    expect(offset).toBeCloseTo(.85);
    expect(duration).toBeCloseTo(.4);
  });

  it("evicts a failed load so the same source can retry on the next play", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(new ArrayBuffer(4), { status: 200 }));
    const onWarning = vi.fn();
    render(<Harness clips={[effect("retry", 1)]} onWarning={onWarning} />);

    useRepurposeStore.setState({ isPlaying: true });
    await waitFor(() => expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/network down/i)));
    useRepurposeStore.setState({ isPlaying: false });
    useRepurposeStore.setState({ isPlaying: true });

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retires an aborted source load and fetches it again when that identity returns", async () => {
    const requests: Array<{ url: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ url, signal: init?.signal as AbortSignal, resolve });
    })));
    const old = effect("old", 0);
    const replacement = { ...effect("new", 0), source: { kind: "built-in", key: "ding" } as const };
    const rendered = render(<Harness clips={[old]} />);
    useRepurposeStore.setState({ playhead: 0, isPlaying: true });
    await waitFor(() => expect(requests).toHaveLength(1));

    rendered.rerender(<Harness clips={[replacement]} />);
    await waitFor(() => expect(requests[0].signal.aborted).toBe(true));
    rendered.rerender(<Harness clips={[old]} />);
    await waitFor(() => expect(requests.filter((request) => request.url.includes("whoosh"))).toHaveLength(2));
  });

  it("does not schedule a pending decode after project ownership changes", async () => {
    const decode = deferred<typeof decodedBuffer>();
    decodeMock.mockReturnValueOnce(decode.promise);
    render(<Harness clips={[effect("project", 0)]} />);
    useRepurposeStore.setState({ playhead: 0, isPlaying: true });
    await waitFor(() => expect(decodeMock).toHaveBeenCalledOnce());

    useRepurposeStore.getState().resetProject();
    decode.resolve(decodedBuffer);

    await Promise.resolve();
    expect(starts).toHaveLength(0);
  });

  it("disconnects ended nodes without stopping nodes scheduled by a newer owner", async () => {
    render(<Harness clips={[effect("ended", 0)]} />);
    useRepurposeStore.setState({ playhead: 0, isPlaying: true });
    await waitFor(() => expect(starts).toHaveLength(1));
    const ended = sourceNodes[0];

    expect(ended.onended).toBeTypeOf("function");
    ended.onended?.();
    expect(ended.disconnect).toHaveBeenCalledOnce();
    expect(gainDisconnects[0]).toHaveBeenCalledOnce();
    expect(stops[0]).not.toHaveBeenCalled();

    useRepurposeStore.setState({ playhead: .5 });
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(stops[1]).not.toHaveBeenCalled();
  });

  it("schedules a migrated legacy source through the authoritative SFX path", async () => {
    const legacy = {
      ...effect("legacy", 0),
      source: { kind: "legacy", sourcePath: "C:\\audio\\legacy.wav", srcDuration: 3 } as const,
    };
    render(<Harness clips={[legacy]} />);
    useRepurposeStore.setState({ playhead: 0, isPlaying: true });

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith(
      `/api/repurpose/sfx?path=${encodeURIComponent("C:\\audio\\legacy.wav")}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
