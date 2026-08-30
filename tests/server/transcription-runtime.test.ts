// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTranscriptionRuntime,
  getTranscriptionRuntime,
  resetTranscriptionRuntimeForTests,
} from "@/lib/repurpose/transcription-runtime.server";
import type { PreparedTranscriptionRequest } from "@/lib/repurpose/transcription-cache.server";
import type { StartTranscriptionRequest, TranscriptionResult } from "@/lib/repurpose/transcription-contract";

const IDS = Array.from({ length: 35 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);

function request(observerId = IDS[0], sourcePath = "C:\\managed\\face.mp4"): StartTranscriptionRequest {
  return { observerId, path: sourcePath, language: "pt" };
}

function prepared(sourcePath = "C:\\managed\\face.mp4", admissionKey = `key:${sourcePath}`): PreparedTranscriptionRequest {
  return {
    sourcePath,
    expectedSourceHash: "a".repeat(64),
    language: "pt",
    admissionKey,
    cacheKey: "b".repeat(64),
  };
}

function result(): TranscriptionResult {
  return {
    words: [{ text: "ola", start: 0, end: 0.5 }],
    language: "pt",
    languageProbability: 1,
    device: "cuda",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function runtime(overrides: {
  prepare?: Parameters<typeof createTranscriptionRuntime>[0]["prepare"];
  run?: Parameters<typeof createTranscriptionRuntime>[0]["run"];
} = {}) {
  return createTranscriptionRuntime({
    prepare: overrides.prepare ?? vi.fn(async (value: StartTranscriptionRequest) => prepared(value.path)),
    run: overrides.run ?? vi.fn(async () => result()),
    now: () => Date.now(),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
  resetTranscriptionRuntimeForTests();
});

afterEach(() => {
  resetTranscriptionRuntimeForTests();
  vi.useRealTimers();
});

describe("observer-scoped transcription runtime", () => {
  it("finishes admission before scheduling exactly one process", async () => {
    const admission = deferred<PreparedTranscriptionRequest>();
    const prepare = vi.fn(() => admission.promise);
    const run = vi.fn(async () => result());
    const instance = runtime({ prepare, run });
    const start = instance.start(request(), new AbortController().signal);

    await flush();
    expect(prepare).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    admission.resolve(prepared());
    await expect(start).resolves.toEqual({ jobId: IDS[0] });
    await flush();
    expect(run).toHaveBeenCalledOnce();
  });

  it("joins identical prepared admission keys but never joins different canonical paths with the same durable key", async () => {
    const work = deferred<TranscriptionResult>();
    const run = vi.fn(() => work.promise);
    const prepare = vi.fn(async (value: StartTranscriptionRequest) => prepared(value.path, value.path.endsWith(".mp4") ? "same" : "different"));
    const instance = runtime({ prepare, run });

    await instance.start(request(IDS[0]), new AbortController().signal);
    await instance.start(request(IDS[1]), new AbortController().signal);
    await flush();
    expect(run).toHaveBeenCalledOnce();

    await expect(instance.start(request(IDS[2], "C:\\managed\\face.mov"), new AbortController().signal))
      .rejects.toMatchObject({ code: "TRANSCRIPTION_BUSY" });
    expect(run).toHaveBeenCalledOnce();
    work.resolve(result());
    await flush();
  });

  it("enforces 32 observer leases on one shared process", async () => {
    const work = deferred<TranscriptionResult>();
    const instance = runtime({
      prepare: vi.fn(async () => prepared("C:\\managed\\face.mp4", "same")),
      run: vi.fn(() => work.promise),
    });
    for (const observerId of IDS.slice(0, 32)) {
      await instance.start(request(observerId), new AbortController().signal);
    }
    await expect(instance.start(request(IDS[32]), new AbortController().signal))
      .rejects.toMatchObject({ code: "TRANSCRIPTION_BUSY" });
    work.resolve(result());
    await flush();
  });

  it("is idempotent for the same UUID and rejects UUID reuse for a different request", async () => {
    const work = deferred<TranscriptionResult>();
    const prepare = vi.fn(async (value: StartTranscriptionRequest) => prepared(value.path, "same"));
    const run = vi.fn(() => work.promise);
    const instance = runtime({ prepare, run });

    await expect(instance.start(request(), new AbortController().signal)).resolves.toEqual({ jobId: IDS[0] });
    await expect(instance.start(request(), new AbortController().signal)).resolves.toEqual({ jobId: IDS[0] });
    expect(prepare).toHaveBeenCalledOnce();
    await expect(instance.start({ ...request(), language: "auto" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "TRANSCRIPTION_OBSERVER_CONFLICT" });
    work.resolve(result());
    await flush();
  });

  it("renews a 30-second active lease on GET and expires it from the last renewal", async () => {
    const work = deferred<TranscriptionResult>();
    let runSignal: AbortSignal | undefined;
    const instance = runtime({ run: vi.fn(async (_prepared, signal: AbortSignal) => {
      runSignal = signal;
      return work.promise;
    }) });
    await instance.start(request(), new AbortController().signal);
    await flush();

    await vi.advanceTimersByTimeAsync(29_000);
    expect(instance.get(IDS[0])?.state).toBe("running");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(instance.peek(IDS[0])?.state).toBe("running");
    expect(runSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(instance.peek(IDS[0])).toBeNull();
    expect(runSignal?.aborted).toBe(true);
    work.reject(new Error("aborted"));
    await flush();
  });

  it("retains settled observers for ten minutes and a late GET resets retention", async () => {
    const instance = runtime();
    await instance.start(request(), new AbortController().signal);
    await flush();
    expect(instance.peek(IDS[0])?.state).toBe("completed");

    await vi.advanceTimersByTimeAsync(599_000);
    expect(instance.get(IDS[0])?.state).toBe("completed");
    await vi.advanceTimersByTimeAsync(599_000);
    expect(instance.peek(IDS[0])?.state).toBe("completed");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(instance.peek(IDS[0])).toBeNull();
  });

  it("releasing one observer preserves shared work while releasing the last cancels it", async () => {
    const work = deferred<TranscriptionResult>();
    let runSignal: AbortSignal | undefined;
    const instance = runtime({
      prepare: vi.fn(async () => prepared("C:\\managed\\face.mp4", "same")),
      run: vi.fn(async (_prepared, signal: AbortSignal) => {
        runSignal = signal;
        return work.promise;
      }),
    });
    await instance.start(request(IDS[0]), new AbortController().signal);
    await instance.start(request(IDS[1]), new AbortController().signal);
    await flush();

    expect(instance.release(IDS[0])).toBe(true);
    expect(instance.peek(IDS[0])).toBeNull();
    expect(runSignal?.aborted).toBe(false);
    expect(instance.release(IDS[1])).toBe(true);
    expect(runSignal?.aborted).toBe(true);
    expect(instance.release(IDS[1])).toBe(false);
    work.reject(new Error("aborted"));
    await flush();
  });

  it.each(["cancellation", "timeout"] as const)(
    "admits fresh work only after %s tree termination settles the active run",
    async (cause) => {
      const treeTerminated = deferred<void>();
      const runStarted = deferred<void>();
      let triggerTimeout!: () => void;
      const run = vi.fn(async (_prepared, signal: AbortSignal) => {
        runStarted.resolve();
        if (cause === "cancellation") {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        } else {
          await new Promise<void>((resolve) => { triggerTimeout = resolve; });
        }
        await treeTerminated.promise;
        throw Object.assign(new Error(cause), {
          code: cause === "cancellation" ? "TRANSCRIPTION_CANCELLED" : "TRANSCRIPTION_TIMEOUT",
        });
      });
      const instance = runtime({
        prepare: vi.fn(async (value: StartTranscriptionRequest) => prepared(value.path)),
        run,
      });

      await instance.start(request(IDS[0]), new AbortController().signal);
      await runStarted.promise;
      if (cause === "cancellation") instance.release(IDS[0]);
      else triggerTimeout();

      await expect(instance.start(request(IDS[1], "C:\\managed\\fresh.mp4"), new AbortController().signal))
        .rejects.toMatchObject({ code: "TRANSCRIPTION_BUSY" });
      expect(run).toHaveBeenCalledOnce();

      treeTerminated.resolve();
      await flush();
      await expect(instance.start(request(IDS[1], "C:\\managed\\fresh.mp4"), new AbortController().signal))
        .resolves.toEqual({ jobId: IDS[1] });
      await flush();
      expect(run).toHaveBeenCalledTimes(2);
    },
  );

  it("does not attach an observer when the start request aborts during admission", async () => {
    const admission = deferred<PreparedTranscriptionRequest>();
    const run = vi.fn();
    const instance = runtime({ prepare: vi.fn(() => admission.promise), run });
    const controller = new AbortController();
    const start = instance.start(request(), controller.signal);
    controller.abort();
    admission.resolve(prepared());

    await expect(start).rejects.toMatchObject({ code: "TRANSCRIPTION_CANCELLED" });
    expect(instance.peek(IDS[0])).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("makes completed, failed, and cancelled jobs non-joinable so fresh UUIDs retry", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(Object.assign(new Error("failed"), { code: "TRANSCRIPTION_ENGINE_FAILED" }))
      .mockRejectedValueOnce(Object.assign(new Error("cancelled"), { code: "TRANSCRIPTION_CANCELLED" }))
      .mockResolvedValueOnce(result());
    const instance = runtime({
      prepare: vi.fn(async () => prepared("C:\\managed\\face.mp4", "same")),
      run,
    });

    await instance.start(request(IDS[0]), new AbortController().signal);
    await flush();
    expect(instance.peek(IDS[0])?.state).toBe("completed");
    await instance.start(request(IDS[1]), new AbortController().signal);
    await flush();
    expect(instance.peek(IDS[1])?.state).toBe("failed");
    await instance.start(request(IDS[2]), new AbortController().signal);
    await flush();
    expect(instance.peek(IDS[2])?.state).toBe("cancelled");
    await instance.start(request(IDS[3]), new AbortController().signal);
    await flush();
    expect(instance.peek(IDS[3])?.state).toBe("completed");
    expect(run).toHaveBeenCalledTimes(4);

    await instance.start(request(IDS[0]), new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("shares process reports across observers without exposing process keys", async () => {
    const work = deferred<TranscriptionResult>();
    let sendReport!: (value: { phase: "transcribing"; progress: number; device: "cpu" }) => void;
    const instance = runtime({
      prepare: vi.fn(async () => prepared("C:\\managed\\face.mp4", "private-admission-key")),
      run: vi.fn(async (_prepared, _signal, report) => {
        sendReport = report;
        return work.promise;
      }),
    });
    await instance.start(request(IDS[0]), new AbortController().signal);
    await instance.start(request(IDS[1]), new AbortController().signal);
    await flush();
    sendReport({ phase: "transcribing", progress: 0.5, device: "cpu" });

    expect(instance.get(IDS[0])).toMatchObject({ jobId: IDS[0], state: "running", phase: "transcribing", progress: 0.5, device: "cpu" });
    expect(instance.get(IDS[1])).toMatchObject({ jobId: IDS[1], state: "running", phase: "transcribing", progress: 0.5, device: "cpu" });
    expect(JSON.stringify(instance.get(IDS[0]))).not.toContain("private-admission-key");
    work.resolve(result());
    await flush();
  });
});

describe("process-global transcription runtime", () => {
  it("reuses one singleton and can be reset for tests", () => {
    const first = getTranscriptionRuntime();
    const second = getTranscriptionRuntime();
    expect(second).toBe(first);
    resetTranscriptionRuntimeForTests();
    expect(getTranscriptionRuntime()).not.toBe(first);
  });
});
