import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSfxWaveform } from "@/app/repurpose-studio/_components/useSfxWaveform";

function Harness({ url, enabled = true, epoch = 1 }: {
  url: string;
  enabled?: boolean;
  epoch?: number;
}) {
  const waveform = useSfxWaveform(url, enabled, epoch);
  return <output data-testid={url}>{waveform ? waveform.peaks.length : 0}</output>;
}

let decodeAudioData: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;

beforeEach(() => {
  decodeAudioData = vi.fn().mockResolvedValue({
    duration: 1,
    getChannelData: () => Float32Array.from([0, 0.25, -1, 0.5]),
  });
  close = vi.fn().mockResolvedValue(undefined);
  class AudioContextMock {
    decodeAudioData = decodeAudioData;
    close = close;
  }
  vi.stubGlobal("AudioContext", AudioContextMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSfxWaveform", () => {
  it("only decodes the selected source when many placed clips mount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(4), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<>
      {Array.from({ length: 24 }, (_, index) => (
        <Harness key={index} url={`/unselected-${index}.wav`} enabled={false} />
      ))}
      <Harness url="/selected-waveform.wav" />
    </>);

    await waitFor(() => expect(screen.getByTestId("/selected-waveform.wav")).toHaveTextContent("4000"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/selected-waveform.wav", expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(decodeAudioData).toHaveBeenCalledOnce();
  });

  it("caps shared decode work at two concurrent source requests", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        resolvers.push(resolve);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<>
      <Harness url="/queued-a.wav" />
      <Harness url="/queued-b.wav" />
      <Harness url="/queued-c.wav" />
      <Harness url="/queued-d.wav" />
    </>);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvers[0](new Response(new ArrayBuffer(4), { status: 200 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("aborts retired project work and cleans up the replacement request", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = render(<Harness url="/retired.wav" epoch={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rendered.rerender(<Harness url="/replacement.wav" epoch={2} />);

    await waitFor(() => expect(signals[0].aborted).toBe(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    rendered.unmount();
    expect(signals[1].aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it("starts fresh work when the same source is immediately reselected after retirement", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = render(<Harness url="/reselected.wav" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rendered.rerender(<Harness url="/reselected.wav" enabled={false} />);
    rendered.rerender(<Harness url="/reselected.wav" enabled />);

    expect(signals[0].aborted).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("closes an active decode context immediately when its source retires", async () => {
    decodeAudioData.mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(new ArrayBuffer(4), { status: 200 })
    ));
    const rendered = render(<Harness url="/decoding.wav" />);
    await waitFor(() => expect(decodeAudioData).toHaveBeenCalledOnce());

    rendered.rerender(<Harness url="/decoding.wav" enabled={false} />);

    expect(close).toHaveBeenCalledOnce();
  });
});
