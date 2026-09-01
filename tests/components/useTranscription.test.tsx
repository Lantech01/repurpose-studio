import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTranscription } from "@/app/repurpose-studio/_components/useTranscription";
import {
  TRANSCRIPTION_ERROR_MESSAGES,
  type TranscriptionStatus,
} from "@/lib/repurpose/transcription-contract";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { VideoSourceRecord } from "@/lib/repurpose/types";

const OBSERVER_A = "11111111-1111-4111-8111-111111111111";
const OBSERVER_B = "22222222-2222-4222-8222-222222222222";

function source(originalPath = "C:\\managed\\face.mov"): VideoSourceRecord {
  return {
    originalPath,
    workingPath: "C:\\cache\\face.mp4",
    originalName: "face.mov",
    inspection: {
      fingerprint: "a".repeat(64),
      container: "mov,mp4",
      extension: ".mov",
      size: 1024,
      durationSec: 8,
      video: {
        codec: "h264",
        codecTag: "avc1",
        profile: "Main",
        pixelFormat: "yuv420p",
        width: 1920,
        height: 1080,
        fps: 30,
      },
      audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
    },
    nativeCompatible: true,
    compatibilityStatus: "native",
  };
}

function installFace(originalPath?: string): void {
  const faceCamSource = source(originalPath);
  useRepurposeStore.getState().setFootageMeta({
    faceCamPath: "/api/face",
    screenPath: "/api/screen",
    faceCamSource,
    screenSource: source("C:\\managed\\screen.mov"),
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: 8,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function running(
  jobId = OBSERVER_A,
  overrides: Partial<TranscriptionStatus> = {}
): TranscriptionStatus {
  return {
    jobId,
    state: "running",
    phase: "transcribing",
    progress: 0.4,
    device: "cuda",
    warning: null,
    result: null,
    error: null,
    ...overrides,
  } as TranscriptionStatus;
}

function completed(jobId = OBSERVER_A, words = [{ text: "olá", start: 0, end: 0.5 }]): TranscriptionStatus {
  return {
    jobId,
    state: "completed",
    phase: "finalizing",
    progress: 1,
    device: "cuda",
    warning: null,
    result: {
      words,
      language: "pt",
      languageProbability: 0.99,
      device: "cuda",
    },
    error: null,
  };
}

function settled(
  state: "failed" | "cancelled",
  jobId = OBSERVER_A
): TranscriptionStatus {
  const code =
    state === "cancelled"
      ? "TRANSCRIPTION_CANCELLED"
      : "TRANSCRIPTION_ENGINE_FAILED";
  return {
    jobId,
    state,
    phase: "transcribing",
    progress: null,
    device: "cpu",
    warning: null,
    result: null,
    error: { code, message: TRANSCRIPTION_ERROR_MESSAGES[code] },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  vi.useFakeTimers();
  vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce(OBSERVER_A)
    .mockReturnValueOnce(OBSERVER_B);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useTranscription", () => {
  it("remains live after React Strict Mode replays its mount effect", async () => {
    installFace();
    const onResult = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ jobId: OBSERVER_A }, 202))
        .mockResolvedValueOnce(json(completed()))
    );
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(() => useTranscription({ onResult }), { wrapper });

    await act(async () => result.current.start());

    expect(onResult).toHaveBeenCalledOnce();
  });

  it("is unavailable for a legacy Face URL without a durable original", () => {
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "/legacy-face",
      screenPath: "/legacy-screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));

    expect(result.current.available).toBe(false);
    act(() => void result.current.start());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the observer before POST, sends only the Face original path, and hands off a cache hit once", async () => {
    installFace();
    const onResult = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ jobId: OBSERVER_A }, 202))
      .mockResolvedValueOnce(json(completed()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult }));

    await act(async () => result.current.start());

    const [, postInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(postInit.body))).toEqual({
      observerId: OBSERVER_A,
      path: "C:\\managed\\face.mov",
      language: "pt",
    });
    expect(Object.keys(JSON.parse(String(postInit.body)))).toEqual([
      "observerId",
      "path",
      "language",
    ]);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(completed().result);

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("supports automatic language and renews the lease while visible and hidden", async () => {
    installFace();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ jobId: OBSERVER_A }, 202))
      .mockResolvedValueOnce(json(running()))
      .mockResolvedValueOnce(json(running(OBSERVER_A, { progress: 0.6 })))
      .mockResolvedValueOnce(json(completed()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));

    act(() => result.current.setLanguage("auto"));
    await act(async () => result.current.start());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      language: "auto",
    });

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("aborts a pending POST and independently releases its known observer", async () => {
    installFace();
    let postSignal!: AbortSignal;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (init?.method === "POST") {
        postSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));

    act(() => void result.current.start());
    expect(postSignal.aborted).toBe(false);
    await act(async () => result.current.cancel());

    expect(postSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/repurpose/transcription/jobs/${OBSERVER_A}`,
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) })
    );
    expect(result.current.status?.state).toBe("cancelled");
  });

  it("represents a pending POST locally, ignores a duplicate start, and keeps cancellation available", async () => {
    installFace();
    let postSignal!: AbortSignal;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        postSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          postSignal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        });
      }
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error("Unexpected GET");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));

    act(() => {
      void result.current.start();
      void result.current.start();
    });

    expect(result.current.status).toMatchObject({
      jobId: OBSERVER_A,
      state: "queued",
      phase: "preparing",
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(0);

    await act(async () => result.current.cancel());

    expect(postSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/repurpose/transcription/jobs/${OBSERVER_A}`,
      expect.objectContaining({ method: "DELETE" })
    );
    expect(result.current.status?.state).toBe("cancelled");
  });

  it("does not accept a body-bearing non-204 DELETE success", async () => {
    installFace();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ jobId: OBSERVER_A }, 202))
      .mockResolvedValueOnce(json(running()))
      .mockResolvedValueOnce(json({ released: true }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));
    await act(async () => result.current.start());

    await act(async () => result.current.cancel());

    expect(result.current.status?.state).toBe("cancelled");
    expect(result.current.error).toMatch(/resposta|response|204/i);
  });

  it("cancels on project change and suppresses a late GET result", async () => {
    installFace();
    const onResult = vi.fn();
    let resolveGet!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(json({ jobId: OBSERVER_A }, 202));
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return new Promise<Response>((resolve) => {
        resolveGet = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult }));
    act(() => void result.current.start());
    await act(async () => Promise.resolve());

    act(() => useRepurposeStore.getState().resetProject());
    await act(async () => Promise.resolve());
    resolveGet(json(completed()));
    await act(async () => Promise.resolve());

    expect(onResult).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/repurpose/transcription/jobs/${OBSERVER_A}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("cancels on Face replacement without an epoch change and on unmount", async () => {
    installFace();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const observerId = JSON.parse(String(init.body)).observerId as string;
        return Promise.resolve(json({ jobId: observerId }, 202));
      }
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = renderHook(() => useTranscription({ onResult: vi.fn() }));
    act(() => void rendered.result.current.start());
    await act(async () => Promise.resolve());
    const epoch = useRepurposeStore.getState().projectEpoch;

    act(() => installFace("C:\\managed\\replacement.mov"));
    await act(async () => Promise.resolve());
    expect(useRepurposeStore.getState().projectEpoch).toBe(epoch);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/repurpose/transcription/jobs/${OBSERVER_A}`,
      expect.objectContaining({ method: "DELETE" })
    );

    act(() => void rendered.result.current.start());
    await act(async () => Promise.resolve());
    rendered.unmount();
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/repurpose/transcription/jobs/${OBSERVER_B}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it.each(["failed", "cancelled"] as const)(
    "retries a %s observer with a fresh UUID",
    async (state) => {
      installFace();
      const posts: string[] = [];
      let startCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const observerId = JSON.parse(String(init.body)).observerId as string;
          posts.push(observerId);
          startCount += 1;
          return Promise.resolve(json({ jobId: observerId }, 202));
        }
        if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(
          json(startCount === 1 ? settled(state) : completed(OBSERVER_B))
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));
      await act(async () => result.current.start());
      expect(result.current.status?.state).toBe(state);

      await act(async () => result.current.retry());

      expect(posts).toEqual([OBSERVER_A, OBSERVER_B]);
      expect(result.current.status?.state).toBe("completed");
    }
  );

  it("represents retry while releasing the prior observer and ignores a duplicate retry", async () => {
    installFace();
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReset()
      .mockReturnValueOnce(OBSERVER_A)
      .mockReturnValue(OBSERVER_B);
    let releasePrior!: () => void;
    const posts: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const observerId = JSON.parse(String(init.body)).observerId as string;
        posts.push(observerId);
        return Promise.resolve(json({ jobId: observerId }, 202));
      }
      if (init?.method === "DELETE") {
        if (requestUrl(input).endsWith(OBSERVER_A)) {
          return new Promise<Response>((resolve) => {
            releasePrior = () => resolve(new Response(null, { status: 204 }));
          });
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        json(posts.length === 1 ? settled("failed") : running(OBSERVER_B))
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));
    await act(async () => result.current.start());

    let retryPromise!: Promise<void>;
    act(() => {
      retryPromise = result.current.retry();
      void result.current.retry();
    });

    expect(result.current.status).toMatchObject({
      jobId: OBSERVER_B,
      state: "queued",
      phase: "preparing",
    });
    expect(posts).toEqual([OBSERVER_A]);
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          init?.method === "DELETE" && requestUrl(input).endsWith(OBSERVER_A)
      )
    ).toHaveLength(1);

    await act(async () => {
      releasePrior();
      await retryPromise;
    });

    expect(posts).toEqual([OBSERVER_A, OBSERVER_B]);
  });

  it("best-effort releases a completed observer before retranscribing in a new language", async () => {
    installFace();
    const requestOrder: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          observerId: string;
          language: string;
        };
        requestOrder.push(`POST:${body.observerId}:${body.language}`);
        return Promise.resolve(json({ jobId: body.observerId }, 202));
      }
      if (init?.method === "DELETE") {
        requestOrder.push(`DELETE:${requestUrl(input).split("/").at(-1)}`);
        return Promise.reject(new TypeError("release unavailable"));
      }
      const observerId = requestUrl(input).split("/").at(-1)!;
      return Promise.resolve(json(completed(observerId)));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));
    await act(async () => result.current.start());

    act(() => result.current.setLanguage("auto"));
    await act(async () => result.current.start());

    expect(requestOrder).toEqual([
      `POST:${OBSERVER_A}:pt`,
      `DELETE:${OBSERVER_A}`,
      `POST:${OBSERVER_B}:auto`,
    ]);
    expect(result.current.status).toMatchObject({
      jobId: OBSERVER_B,
      state: "completed",
    });
  });

  it("serializes visibility polling, ignores an obsolete response, and aborts the active GET on cancel", async () => {
    installFace();
    const getRequests: Array<{
      resolve: (response: Response) => void;
      signal: AbortSignal;
    }> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const observerId = JSON.parse(String(init.body)).observerId as string;
        return Promise.resolve(json({ jobId: observerId }, 202));
      }
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return new Promise<Response>((resolve) => {
        getRequests.push({ resolve, signal: init?.signal as AbortSignal });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));
    act(() => void result.current.start());
    await act(async () => Promise.resolve());
    expect(getRequests).toHaveLength(1);

    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const obsolete = getRequests[1];
    await act(async () => {
      getRequests[0].resolve(json(completed()));
      await Promise.resolve();
      obsolete?.resolve(json(running()));
      await Promise.resolve();
    });

    expect(getRequests).toHaveLength(1);
    expect(result.current.status?.state).toBe("completed");

    act(() => void result.current.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRequests).toHaveLength(2);
    await act(async () => result.current.cancel());
    expect(getRequests[1].signal.aborted).toBe(true);
    expect(result.current.status?.state).toBe("cancelled");
  });

  it("preserves a validated CUDA fallback warning and an empty speech result", async () => {
    installFace();
    const onResult = vi.fn();
    const warning = {
      code: "TRANSCRIPTION_GPU_FALLBACK" as const,
      message: "GPU indisponível; continuando na CPU." as const,
    };
    const empty = completed(OBSERVER_A, []);
    empty.device = "cpu";
    empty.warning = warning;
    empty.result!.device = "cpu";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ jobId: OBSERVER_A }, 202))
      .mockResolvedValueOnce(json(empty));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult }));

    await act(async () => result.current.start());

    expect(result.current.status?.warning).toEqual(warning);
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].words).toEqual([]);
  });

  it.each([
    ["unknown POST success keys", json({ jobId: OBSERVER_A, privatePath: "C:\\secret" }, 202)],
    [
      "HTTP status/code mismatch",
      json(
        {
          error: {
            code: "TRANSCRIPTION_NOT_FOUND",
            message: TRANSCRIPTION_ERROR_MESSAGES.TRANSCRIPTION_NOT_FOUND,
          },
        },
        500
      ),
    ],
  ])("rejects %s without handing off a result", async (_label, response) => {
    installFace();
    const onResult = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { result } = renderHook(() => useTranscription({ onResult }));

    await act(async () => result.current.start());

    expect(onResult).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
  });

  it("rejects unknown GET status keys and safe-decodes a valid GET error", async () => {
    installFace();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ jobId: OBSERVER_A }, 202))
      .mockResolvedValueOnce(json({ ...running(), stderr: "C:\\secret" }))
      .mockResolvedValueOnce(json({ jobId: OBSERVER_B }, 202))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "TRANSCRIPTION_NOT_FOUND",
              message: TRANSCRIPTION_ERROR_MESSAGES.TRANSCRIPTION_NOT_FOUND,
            },
          },
          404
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTranscription({ onResult: vi.fn() }));

    await act(async () => result.current.start());
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toContain("secret");
    await act(async () => result.current.retry());
    expect(result.current.error).toBe(TRANSCRIPTION_ERROR_MESSAGES.TRANSCRIPTION_NOT_FOUND);
  });
});
