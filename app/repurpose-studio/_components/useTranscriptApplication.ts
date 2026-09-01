"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildTranscriptCandidate,
  effectiveVideoTimelineDuration,
  isUntouchedVideoTimeline,
} from "@/lib/repurpose/transcript-application";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { EditStats } from "@/lib/repurpose/ingest";
import type { Clip, Word } from "@/lib/repurpose/types";

export type TranscriptOffer =
  | {
      kind: "ready";
      words: Word[];
      clips: Clip[];
      stats: EditStats | null;
      origin: "automatic";
    }
  | {
      kind: "ready";
      words: Word[];
      clips: Clip[];
      stats: EditStats | null;
      origin: "manual";
      recipe:
        | { kind: "raw"; fullWords: Word[] }
        | { kind: "final-transcript"; fullWords: Word[]; transcript: string };
    }
  | {
      kind: "no-shared-speech";
      origin: "automatic";
    };

type PendingTranscript = {
  offer: Extract<TranscriptOffer, { kind: "ready" }>;
  projectEpoch: number;
  faceOriginalPath: string | null;
  deferred: boolean;
  owner: number;
};

export type TranscriptApplicationNotice = "no-speech" | "no-shared-speech";

export function useTranscriptApplication() {
  const projectEpoch = useRepurposeStore((state) => state.projectEpoch);
  const faceOriginalPath = useRepurposeStore(
    (state) => state.footageMeta?.faceCamSource?.originalPath ?? null
  );
  const effectiveDuration = useRepurposeStore((state) =>
    effectiveVideoTimelineDuration(state.footageMeta)
  );
  const applyTranscript = useRepurposeStore((state) => state.applyTranscript);
  const ownerRef = useRef(0);
  const [pending, setPending] = useState<PendingTranscript | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<TranscriptApplicationNotice | null>(null);

  const clearPending = useCallback(() => {
    ownerRef.current += 1;
    setPending(null);
    setDialogOpen(false);
  }, []);

  const rebound = useCallback((record: PendingTranscript) => {
    const state = useRepurposeStore.getState();
    if (
      state.projectEpoch !== record.projectEpoch ||
      record.owner !== ownerRef.current ||
      (state.footageMeta?.faceCamSource?.originalPath ?? null) !==
        record.faceOriginalPath
    ) {
      return null;
    }
    const duration = effectiveVideoTimelineDuration(state.footageMeta);
    if (record.offer.origin === "automatic") {
      if (duration === null) return undefined;
      const candidate = buildTranscriptCandidate({
        words: record.offer.words,
        maxSourceDuration: duration,
      });
      return candidate.kind === "ready"
        ? {
            ...record.offer,
            clips: candidate.clips,
            stats: candidate.stats,
          }
        : candidate;
    }
    const candidate = buildTranscriptCandidate({
      words: record.offer.recipe.fullWords,
      ...(record.offer.recipe.kind === "final-transcript"
        ? { finalTranscript: record.offer.recipe.transcript }
        : {}),
      ...(duration === null ? {} : { maxSourceDuration: duration }),
    });
    return candidate.kind === "ready"
      ? {
          ...record.offer,
          words: candidate.words,
          clips: candidate.clips,
          stats: candidate.stats,
        }
      : candidate;
  }, []);

  const decide = useCallback(
    (record: PendingTranscript) => {
      const candidate = rebound(record);
      if (candidate === null) {
        clearPending();
        return;
      }
      if (candidate === undefined) return;
      if (candidate.kind === "no-shared-speech") {
        clearPending();
        setNotice("no-shared-speech");
        return;
      }
      const state = useRepurposeStore.getState();
      if (
        isUntouchedVideoTimeline({
          clips: state.clips,
          words: state.words,
          effectiveDuration: effectiveVideoTimelineDuration(state.footageMeta),
        })
      ) {
        applyTranscript({
          words: candidate.words,
          mode: "rebuild",
          rebuiltClips: candidate.clips,
          editStats: candidate.stats,
        });
        clearPending();
        return;
      }
      setDialogOpen(true);
    },
    [applyTranscript, clearPending, rebound]
  );

  const offerCandidate = useCallback(
    (offer: TranscriptOffer) => {
      setNotice(null);
      if (offer.kind === "no-shared-speech") {
        clearPending();
        setNotice("no-shared-speech");
        return;
      }
      if (offer.words.length === 0) {
        clearPending();
        setNotice("no-speech");
        return;
      }
      const state = useRepurposeStore.getState();
      const owner = ownerRef.current + 1;
      ownerRef.current = owner;
      const record: PendingTranscript = {
        offer,
        projectEpoch: state.projectEpoch,
        faceOriginalPath: state.footageMeta?.faceCamSource?.originalPath ?? null,
        deferred: false,
        owner,
      };
      setPending(record);
      decide(record);
    },
    [clearPending, decide]
  );

  const apply = useCallback(
    (mode: "preserve-cuts" | "rebuild") => {
      if (!pending) return;
      const candidate = rebound(pending);
      if (candidate === null) {
        clearPending();
        return;
      }
      if (candidate === undefined) {
        setDialogOpen(false);
        return;
      }
      if (candidate.kind === "no-shared-speech") {
        clearPending();
        setNotice("no-shared-speech");
        return;
      }
      applyTranscript({
        words: candidate.words,
        mode,
        ...(mode === "rebuild"
          ? { rebuiltClips: candidate.clips, editStats: candidate.stats }
          : {}),
      });
      clearPending();
    },
    [applyTranscript, clearPending, pending, rebound]
  );

  const applyPreservingCuts = useCallback(
    () => apply("preserve-cuts"),
    [apply]
  );
  const applyRebuilding = useCallback(() => apply("rebuild"), [apply]);
  const applyLater = useCallback(() => {
    setDialogOpen(false);
    setPending((current) => (current ? { ...current, deferred: true } : current));
  }, []);
  const reopenPending = useCallback(() => {
    if (!pending) return;
    const next = { ...pending, deferred: false };
    setPending(next);
    decide(next);
  }, [decide, pending]);

  useEffect(() => {
    clearPending();
    setNotice(null);
  }, [clearPending, faceOriginalPath, projectEpoch]);

  useEffect(() => {
    if (
      pending?.offer.origin === "automatic" &&
      !pending.deferred &&
      !dialogOpen &&
      effectiveDuration !== null
    ) {
      decide(pending);
    }
  }, [decide, dialogOpen, effectiveDuration, pending]);

  return {
    offerCandidate,
    applyPreservingCuts,
    applyRebuilding,
    applyLater,
    reopenPending,
    clearPending,
    pendingCandidate: pending?.offer ?? null,
    dialogOpen,
    notice,
  };
}
