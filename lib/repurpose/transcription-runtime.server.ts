import {
  prepareTranscriptionRequest,
  TranscriptionServerError,
  type PreparedTranscriptionRequest,
} from "./transcription-cache.server";
import { transcriptionProcessor, type Report } from "./transcription-process.server";
import {
  TRANSCRIPTION_ERROR_MESSAGES,
  type StartTranscriptionRequest,
  type StartTranscriptionResponse,
  type TranscriptionErrorCode,
  type TranscriptionResult,
  type TranscriptionStatus,
} from "./transcription-contract";

const ACTIVE_LEASE_MS = 30_000;
const SETTLED_RETENTION_MS = 10 * 60 * 1000;
const MAX_OBSERVERS_PER_JOB = 32;
const RUNTIME_SYMBOL = Symbol.for("repurpose-studio.transcription-runtime");

type Timer = ReturnType<typeof setTimeout>;
type ActiveStatus = Extract<TranscriptionStatus, { state: "queued" | "running" }>;
type SettledStatus = Extract<TranscriptionStatus, { state: "completed" | "failed" | "cancelled" }>;

interface SharedJob {
  admissionKey: string;
  prepared: PreparedTranscriptionRequest;
  controller: AbortController;
  observers: Set<string>;
  status: Omit<ActiveStatus, "jobId">;
}

interface Observer {
  id: string;
  requestSignature: string;
  job: SharedJob | null;
  settledStatus: SettledStatus | null;
  timer: Timer | null;
  expiresAt: number;
}

export interface TranscriptionRuntime {
  start(request: StartTranscriptionRequest, signal: AbortSignal): Promise<StartTranscriptionResponse>;
  get(observerId: string): TranscriptionStatus | null;
  peek(observerId: string): TranscriptionStatus | null;
  release(observerId: string): boolean;
}

function requestSignature(request: StartTranscriptionRequest): string {
  return JSON.stringify({ path: request.path, language: request.language });
}

function errorCode(error: unknown): TranscriptionErrorCode {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code in TRANSCRIPTION_ERROR_MESSAGES) {
    return code as TranscriptionErrorCode;
  }
  return "TRANSCRIPTION_ENGINE_FAILED";
}

function serverError(code: TranscriptionErrorCode): TranscriptionServerError {
  return new TranscriptionServerError(code);
}

function statusFor(observer: Observer): TranscriptionStatus {
  if (observer.job) return { jobId: observer.id, ...observer.job.status } as TranscriptionStatus;
  return observer.settledStatus!;
}

export function createTranscriptionRuntime(deps: {
  prepare: (
    request: StartTranscriptionRequest,
    signal: AbortSignal,
  ) => Promise<PreparedTranscriptionRequest>;
  run: (
    request: PreparedTranscriptionRequest,
    signal: AbortSignal,
    report: (report: Report) => void,
  ) => Promise<TranscriptionResult>;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}): TranscriptionRuntime {
  const observers = new Map<string, Observer>();
  const sharedJobs = new Map<string, SharedJob>();

  const removeObserver = (observer: Observer): boolean => {
    if (!observers.delete(observer.id)) return false;
    if (observer.timer) deps.clearTimer(observer.timer);
    observer.timer = null;
    const job = observer.job;
    observer.job = null;
    if (job) {
      job.observers.delete(observer.id);
      if (job.observers.size === 0) job.controller.abort();
    }
    return true;
  };

  const scheduleExpiry = (observer: Observer, milliseconds: number) => {
    if (observer.timer) deps.clearTimer(observer.timer);
    observer.expiresAt = deps.now() + milliseconds;
    observer.timer = deps.setTimer(() => {
      if (deps.now() >= observer.expiresAt) removeObserver(observer);
    }, milliseconds);
  };

  const settle = (job: SharedJob, outcome: {
    result?: TranscriptionResult;
    error?: unknown;
  }) => {
    if (sharedJobs.get(job.admissionKey) === job) sharedJobs.delete(job.admissionKey);
    const code = outcome.error ? errorCode(outcome.error) : null;
    for (const observerId of job.observers) {
      const observer = observers.get(observerId);
      if (!observer || observer.job !== job) continue;
      observer.job = null;
      if (outcome.result) {
        observer.settledStatus = {
          jobId: observer.id,
          state: "completed",
          phase: "finalizing",
          progress: 1,
          device: outcome.result.device,
          warning: job.status.warning,
          result: outcome.result,
          error: null,
        };
      } else {
        const finalCode = code ?? "TRANSCRIPTION_ENGINE_FAILED";
        observer.settledStatus = {
          jobId: observer.id,
          state: finalCode === "TRANSCRIPTION_CANCELLED" ? "cancelled" : "failed",
          phase: job.status.phase,
          progress: job.status.progress,
          device: job.status.device,
          warning: job.status.warning,
          result: null,
          error: {
            code: finalCode,
            message: TRANSCRIPTION_ERROR_MESSAGES[finalCode],
          },
        };
      }
      scheduleExpiry(observer, SETTLED_RETENTION_MS);
    }
    job.observers.clear();
  };

  const launch = (job: SharedJob) => {
    void Promise.resolve().then(async () => {
      job.status = { ...job.status, state: "running" };
      try {
        const result = await deps.run(job.prepared, job.controller.signal, (update) => {
          if (job.controller.signal.aborted && job.observers.size === 0) return;
          job.status = {
            ...job.status,
            ...(update.phase !== undefined ? { phase: update.phase } : {}),
            ...(update.progress !== undefined ? { progress: update.progress } : {}),
            ...(update.device !== undefined ? { device: update.device } : {}),
            ...(update.warning !== undefined ? { warning: update.warning } : {}),
          };
        });
        settle(job, { result });
      } catch (error) {
        settle(job, { error });
      }
    });
  };

  const runtime: TranscriptionRuntime = {
    async start(request, signal) {
      const signature = requestSignature(request);
      const existingBeforeAdmission = observers.get(request.observerId);
      if (existingBeforeAdmission) {
        if (existingBeforeAdmission.requestSignature !== signature) {
          throw serverError("TRANSCRIPTION_OBSERVER_CONFLICT");
        }
        return { jobId: request.observerId };
      }
      if (signal.aborted) throw serverError("TRANSCRIPTION_CANCELLED");
      const prepared = await deps.prepare(request, signal);
      if (signal.aborted) throw serverError("TRANSCRIPTION_CANCELLED");

      const existingAfterAdmission = observers.get(request.observerId);
      if (existingAfterAdmission) {
        if (existingAfterAdmission.requestSignature !== signature) {
          throw serverError("TRANSCRIPTION_OBSERVER_CONFLICT");
        }
        return { jobId: request.observerId };
      }

      let job = sharedJobs.get(prepared.admissionKey);
      if (job?.controller.signal.aborted) job = undefined;
      if (!job && sharedJobs.size > 0) throw serverError("TRANSCRIPTION_BUSY");
      if (job && job.observers.size >= MAX_OBSERVERS_PER_JOB) {
        throw serverError("TRANSCRIPTION_BUSY");
      }

      let shouldLaunch = false;
      if (!job) {
        job = {
          admissionKey: prepared.admissionKey,
          prepared,
          controller: new AbortController(),
          observers: new Set(),
          status: {
            state: "queued",
            phase: "preparing",
            progress: null,
            device: null,
            warning: null,
            result: null,
            error: null,
          },
        };
        sharedJobs.set(prepared.admissionKey, job);
        shouldLaunch = true;
      }

      const observer: Observer = {
        id: request.observerId,
        requestSignature: signature,
        job,
        settledStatus: null,
        timer: null,
        expiresAt: 0,
      };
      observers.set(observer.id, observer);
      job.observers.add(observer.id);
      scheduleExpiry(observer, ACTIVE_LEASE_MS);
      if (shouldLaunch) launch(job);
      return { jobId: observer.id };
    },

    get(observerId) {
      const observer = observers.get(observerId);
      if (!observer) return null;
      scheduleExpiry(observer, observer.job ? ACTIVE_LEASE_MS : SETTLED_RETENTION_MS);
      return statusFor(observer);
    },

    peek(observerId) {
      const observer = observers.get(observerId);
      return observer ? statusFor(observer) : null;
    },

    release(observerId) {
      const observer = observers.get(observerId);
      return observer ? removeObserver(observer) : false;
    },
  };

  return runtime;
}

type RuntimeGlobal = typeof globalThis & { [RUNTIME_SYMBOL]?: TranscriptionRuntime };

export function getTranscriptionRuntime(): TranscriptionRuntime {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  runtimeGlobal[RUNTIME_SYMBOL] ??= createTranscriptionRuntime({
    prepare: prepareTranscriptionRequest,
    run: (request, signal, report) => transcriptionProcessor.run(request, signal, report),
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  });
  return runtimeGlobal[RUNTIME_SYMBOL];
}

export function resetTranscriptionRuntimeForTests(): void {
  delete (globalThis as RuntimeGlobal)[RUNTIME_SYMBOL];
}
