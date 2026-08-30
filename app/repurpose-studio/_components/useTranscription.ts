"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  parseStartTranscriptionResponse,
  parseTranscriptionErrorResponse,
  parseTranscriptionStatus,
  TRANSCRIPTION_ERROR_MESSAGES,
  type TranscriptionLanguage,
  type TranscriptionResult,
  type TranscriptionStatus,
} from "@/lib/repurpose/transcription-contract";
import { useRepurposeStore } from "@/lib/repurpose/store";

const JOBS_URL = "/api/repurpose/transcription/jobs";
const VISIBLE_POLL_MS = 1_000;
const HIDDEN_POLL_MS = 10_000;
const RELEASE_TIMEOUT_MS = 5_000;
const INVALID_RESPONSE_MESSAGE =
  "Resposta inválida do serviço de transcrição. Tente novamente.";

type Owner = {
  generation: number;
  observerId: string;
  projectEpoch: number;
  originalPath: string;
};

type PollRequest = {
  controller: AbortController;
};

class PublicTranscriptionError extends Error {}

export interface UseTranscriptionResult {
  language: TranscriptionLanguage;
  setLanguage(language: TranscriptionLanguage): void;
  status: TranscriptionStatus | null;
  error: string | null;
  start(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  available: boolean;
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) throw new Error("empty response");
  return JSON.parse(body) as unknown;
}

async function decodedError(response: Response): Promise<PublicTranscriptionError> {
  const value = await responseJson(response);
  const parsed = parseTranscriptionErrorResponse(value, response.status);
  return new PublicTranscriptionError(parsed.error.message);
}

export function useTranscription({
  onResult,
}: {
  onResult: (result: TranscriptionResult) => void;
}): UseTranscriptionResult {
  const projectEpoch = useRepurposeStore((state) => state.projectEpoch);
  const originalPath = useRepurposeStore(
    (state) => state.footageMeta?.faceCamSource?.originalPath ?? null
  );
  const [language, setLanguage] = useState<TranscriptionLanguage>("pt");
  const [status, setStatusState] = useState<TranscriptionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const ownerRef = useRef<Owner | null>(null);
  const actionOwnerRef = useRef<number | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const pollRequestRef = useRef<PollRequest | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<TranscriptionStatus | null>(null);
  const onResultRef = useRef(onResult);
  const handedOffRef = useRef<string | null>(null);
  const identityRef = useRef({ projectEpoch, originalPath });

  onResultRef.current = onResult;

  const setStatus = useCallback((next: TranscriptionStatus | null) => {
    statusRef.current = next;
    if (mountedRef.current) setStatusState(next);
  }, []);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const isCurrent = useCallback((owner: Owner) => {
    const current = ownerRef.current;
    const store = useRepurposeStore.getState();
    return (
      mountedRef.current &&
      current?.generation === owner.generation &&
      current.observerId === owner.observerId &&
      store.projectEpoch === owner.projectEpoch &&
      store.footageMeta?.faceCamSource?.originalPath === owner.originalPath
    );
  }, []);

  const releaseObserver = useCallback(async (observerId: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
    try {
      const response = await fetch(`${JOBS_URL}/${observerId}`, {
        method: "DELETE",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw await decodedError(response);
      const body = await response.text();
      if (response.status !== 204 || body !== "") {
        throw new Error("DELETE response must be an empty 204");
      }
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  const invalidate = useCallback(
    (clearState: boolean): string | null => {
      generationRef.current += 1;
      fetchControllerRef.current?.abort();
      fetchControllerRef.current = null;
      pollRequestRef.current = null;
      actionOwnerRef.current = null;
      clearPollTimer();
      const observerId = ownerRef.current?.observerId ?? null;
      ownerRef.current = null;
      handedOffRef.current = null;
      if (clearState) {
        setStatus(null);
        if (mountedRef.current) setError(null);
      }
      return observerId;
    },
    [clearPollTimer, setStatus]
  );

  const reportFailure = useCallback(
    (failure: unknown, owner: Owner) => {
      if (!isCurrent(owner)) return;
      clearPollTimer();
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(
        failure instanceof PublicTranscriptionError
          ? failure.message
          : INVALID_RESPONSE_MESSAGE
      );
    },
    [clearPollTimer, isCurrent]
  );

  const pollRef = useRef<(owner: Owner) => Promise<void>>(async () => undefined);

  const schedulePoll = useCallback(
    (owner: Owner) => {
      clearPollTimer();
      if (!isCurrent(owner)) return;
      const delay =
        document.visibilityState === "hidden"
          ? HIDDEN_POLL_MS
          : VISIBLE_POLL_MS;
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        void pollRef.current(owner);
      }, delay);
    },
    [clearPollTimer, isCurrent]
  );

  const poll = useCallback(
    async (owner: Owner) => {
      if (!isCurrent(owner) || pollRequestRef.current !== null) return;
      const controller = new AbortController();
      const request: PollRequest = { controller };
      pollRequestRef.current = request;
      fetchControllerRef.current = controller;
      try {
        const response = await fetch(`${JOBS_URL}/${owner.observerId}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!isCurrent(owner) || pollRequestRef.current !== request) return;
        if (!response.ok) throw await decodedError(response);
        if (response.status !== 200) throw new Error("GET response must be 200");
        const next = parseTranscriptionStatus(await responseJson(response));
        if (!isCurrent(owner) || pollRequestRef.current !== request) return;
        if (next.jobId !== owner.observerId) {
          throw new Error("GET observer mismatch");
        }
        if (statusRef.current?.state === "completed") return;
        pollRequestRef.current = null;
        if (fetchControllerRef.current === controller) {
          fetchControllerRef.current = null;
        }
        setError(null);
        setStatus(next);
        if (next.state === "completed") {
          clearPollTimer();
          if (handedOffRef.current !== owner.observerId) {
            handedOffRef.current = owner.observerId;
            onResultRef.current(next.result);
          }
          return;
        }
        if (next.state === "failed" || next.state === "cancelled") {
          clearPollTimer();
          return;
        }
        schedulePoll(owner);
      } catch (failure) {
        if (pollRequestRef.current === request) {
          pollRequestRef.current = null;
          if (fetchControllerRef.current === controller) {
            fetchControllerRef.current = null;
          }
          reportFailure(failure, owner);
        }
      } finally {
        if (pollRequestRef.current === request) pollRequestRef.current = null;
        if (fetchControllerRef.current === controller) {
          fetchControllerRef.current = null;
        }
      }
    },
    [clearPollTimer, isCurrent, reportFailure, schedulePoll, setStatus]
  );

  pollRef.current = poll;

  const start = useCallback(async () => {
    if (actionOwnerRef.current !== null) return;
    const store = useRepurposeStore.getState();
    const path = store.footageMeta?.faceCamSource?.originalPath;
    if (!path) return;

    const previousObserverId = invalidate(false);
    const owner: Owner = {
      generation: generationRef.current + 1,
      observerId: crypto.randomUUID(),
      projectEpoch: store.projectEpoch,
      originalPath: path,
    };
    generationRef.current = owner.generation;
    actionOwnerRef.current = owner.generation;
    ownerRef.current = owner;
    handedOffRef.current = null;
    setStatus({
      jobId: owner.observerId,
      state: "queued",
      phase: "preparing",
      progress: null,
      device: null,
      warning: null,
      result: null,
      error: null,
    });
    setError(null);

    let controller: AbortController | null = null;
    try {
      if (previousObserverId) {
        await releaseObserver(previousObserverId).catch(() => undefined);
      }
      if (!isCurrent(owner)) return;

      controller = new AbortController();
      fetchControllerRef.current = controller;
      const response = await fetch(JOBS_URL, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          observerId: owner.observerId,
          path: owner.originalPath,
          language,
        }),
        signal: controller.signal,
      });
      if (!isCurrent(owner)) return;
      if (!response.ok) throw await decodedError(response);
      if (response.status !== 202) throw new Error("POST response must be 202");
      const started = parseStartTranscriptionResponse(await responseJson(response));
      if (!isCurrent(owner)) return;
      if (started.jobId !== owner.observerId) {
        throw new Error("POST observer mismatch");
      }
      if (fetchControllerRef.current === controller) {
        fetchControllerRef.current = null;
      }
      await poll(owner);
    } catch (failure) {
      reportFailure(failure, owner);
    } finally {
      if (controller && fetchControllerRef.current === controller) {
        fetchControllerRef.current = null;
      }
      if (actionOwnerRef.current === owner.generation) {
        actionOwnerRef.current = null;
      }
    }
  }, [invalidate, isCurrent, language, poll, releaseObserver, reportFailure, setStatus]);

  const cancel = useCallback(async () => {
    const current = ownerRef.current;
    if (!current) return;
    const previous = statusRef.current;
    const observerId = invalidate(false);
    setStatus({
      jobId: current.observerId,
      state: "cancelled",
      phase: previous?.phase ?? "preparing",
      progress: previous?.progress ?? null,
      device: previous?.device ?? null,
      warning: previous?.warning ?? null,
      result: null,
      error: {
        code: "TRANSCRIPTION_CANCELLED",
        message: TRANSCRIPTION_ERROR_MESSAGES.TRANSCRIPTION_CANCELLED,
      },
    });
    setError(null);
    if (!observerId) return;
    try {
      await releaseObserver(observerId);
    } catch (failure) {
      if (mountedRef.current) {
        setError(
          failure instanceof PublicTranscriptionError
            ? failure.message
            : INVALID_RESPONSE_MESSAGE
        );
      }
    }
  }, [invalidate, releaseObserver, setStatus]);

  const retry = useCallback(async () => start(), [start]);

  useEffect(() => {
    const previous = identityRef.current;
    identityRef.current = { projectEpoch, originalPath };
    if (
      previous.projectEpoch === projectEpoch &&
      previous.originalPath === originalPath
    ) {
      return;
    }
    const observerId = invalidate(true);
    if (observerId) void releaseObserver(observerId).catch(() => undefined);
  }, [invalidate, originalPath, projectEpoch, releaseObserver]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const current = ownerRef.current;
      const currentStatus = statusRef.current;
      if (
        current &&
        actionOwnerRef.current === null &&
        pollRequestRef.current === null &&
        (!currentStatus ||
          currentStatus.state === "queued" ||
          currentStatus.state === "running")
      ) {
        schedulePoll(current);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [schedulePoll]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      const observerId = invalidate(false);
      if (observerId) void releaseObserver(observerId).catch(() => undefined);
    },
    [invalidate, releaseObserver]
  );

  return {
    language,
    setLanguage,
    status,
    error,
    start,
    cancel,
    retry,
    available: Boolean(originalPath),
  };
}
