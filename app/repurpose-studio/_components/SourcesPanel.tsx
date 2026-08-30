"use client";

// ===========================================================================
// REPURPOSE STUDIO -- SourcesPanel
// ===========================================================================
// FOOTAGE / TRANSCRIPT INGEST, now living in the Inspector (right rail) instead
// of the transcript rail. This owns everything take-matching needs to start:
//   1. Load a `<base>.words.json` (raw face-cam words) OR a raw .srt (what
//      Descript exports) + optional final transcript, run the take-matcher
//      pipeline, and push Clip[] into the store (setClips) -- populating the
//      timeline for the first time.
//   2. Point the two source videos at picked media files (setFootageMeta) so
//      the PreviewCanvas composites real footage instead of placeholders.
//   3. Auto-load the staged demo footage on first mount + backfill words for
//      captions on a restored project (both moved here from TranscriptPanel so
//      the transcript rail is purely the editable word view).
//
// LAYOUT: while either source video is missing, the ingest buttons show
// prominently under a "Sources" header. Once both videos are loaded, they
// collapse behind "Re-import footage". Transcripts remain optional.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadSimple, Warning, FilmSlate, ImageSquare } from "@phosphor-icons/react";
import {
  useRepurposeStore,
  type MediaReadiness,
} from "@/lib/repurpose/store";
import type { FootageMeta } from "@/lib/repurpose/types";
import {
  buildShortWithStats,
} from "@/lib/repurpose/ingest";
import {
  parseRawWordsFile,
  parseSrtWords,
  srtToPlainText,
} from "@/lib/repurpose/transcript-ingest";
import {
  buildTranscriptCandidate,
  effectiveVideoTimelineDuration,
} from "@/lib/repurpose/transcript-application";
import type { TranscriptionResult } from "@/lib/repurpose/transcription-contract";
import {
  ingestOverlayFiles,
  type OverlayImportOwner,
} from "@/lib/repurpose/overlay-ingest";
import {
  importVideoFile,
  VideoImportError,
  videoUrlForWorkingSource,
} from "@/lib/repurpose/video-import-client";
import {
  VideoImportProgress,
  type VideoImportProgressState,
} from "./VideoImportProgress";
import { TranscriptApplyDialog } from "./TranscriptApplyDialog";
import { TranscriptionControls } from "./TranscriptionControls";
import { useTranscriptApplication } from "./useTranscriptApplication";
import { useTranscription } from "./useTranscription";

export function SourcesPanel({
  overlayImportOwner,
}: {
  overlayImportOwner?: OverlayImportOwner;
} = {}) {
  const clips = useRepurposeStore((s) => s.clips);
  const footageMeta = useRepurposeStore((s) => s.footageMeta);
  const hydrating = useRepurposeStore((s) => s.hydrating);
  const projectEpoch = useRepurposeStore((s) => s.projectEpoch);
  const setClips = useRepurposeStore((s) => s.setClips);
  const setWords = useRepurposeStore((s) => s.setWords);
  const setFootageMeta = useRepurposeStore((s) => s.setFootageMeta);
  const setMediaReadiness = useRepurposeStore((s) => s.setMediaReadiness);
  const beginSourceImport = useRepurposeStore((s) => s.beginSourceImport);
  const endSourceImport = useRepurposeStore((s) => s.endSourceImport);
  const setEditStats = useRepurposeStore((s) => s.setEditStats);

  const [ingestError, setIngestError] = useState<string | null>(null);
  const [videoProgress, setVideoProgress] = useState<
    Partial<Record<"screen" | "face", VideoImportProgressState>>
  >({});
  const transcriptApplication = useTranscriptApplication();
  const { clearPending, offerCandidate } = transcriptApplication;
  const handleTranscriptionResult = useCallback(
    (result: TranscriptionResult) => {
      if (result.words.length === 0) {
        offerCandidate({
          kind: "ready",
          words: [],
          clips: [],
          stats: null,
          origin: "automatic",
        });
        return;
      }
      const duration = effectiveVideoTimelineDuration(
        useRepurposeStore.getState().footageMeta
      );
      const candidate = buildTranscriptCandidate({
        words: result.words,
        ...(duration === null ? {} : { maxSourceDuration: duration }),
      });
      offerCandidate({ ...candidate, origin: "automatic" });
    },
    [offerCandidate]
  );
  const transcription = useTranscription({ onResult: handleTranscriptionResult });
  const cancelTranscription = transcription.cancel;
  const backfilledRef = useRef(false);
  const autoLoadedRef = useRef(false);
  const videoImportsRef = useRef<
    Partial<Record<"screen" | "face", AbortController>>
  >({});
  const videoImportGenerationRef = useRef({ screen: 0, face: 0 });
  const transcriptReadGenerationRef = useRef(0);
  const sourceImportTokensRef = useRef<
    Partial<Record<"screen" | "face", number>>
  >({});
  const mountedRef = useRef(true);
  const videoImportBaselineRef = useRef<{
    readiness: MediaReadiness;
    reason: string | null;
  } | null>(null);
  const videoImportSucceededRef = useRef(false);
  const sourceImportEpochRef = useRef(
    useRepurposeStore.getState().projectEpoch
  );

  const invalidateSourceImports = useCallback(
    (releaseOwners: boolean, clearLocalState: boolean) => {
      videoImportGenerationRef.current.face += 1;
      videoImportGenerationRef.current.screen += 1;
      const imports = videoImportsRef.current;
      const tokens = sourceImportTokensRef.current;
      videoImportsRef.current = {};
      sourceImportTokensRef.current = {};
      videoImportBaselineRef.current = null;
      videoImportSucceededRef.current = false;
      imports.face?.abort();
      imports.screen?.abort();
      if (releaseOwners) {
        if (tokens.face !== undefined) {
          useRepurposeStore.getState().endSourceImport("face", tokens.face);
        }
        if (tokens.screen !== undefined) {
          useRepurposeStore.getState().endSourceImport("screen", tokens.screen);
        }
      }
      if (clearLocalState && mountedRef.current) {
        setVideoProgress({});
        setIngestError(null);
      }
    },
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = useRepurposeStore.subscribe((state, previous) => {
      if (state.projectEpoch === previous.projectEpoch) return;
      sourceImportEpochRef.current = state.projectEpoch;
      backfilledRef.current = false;
      autoLoadedRef.current = false;
      invalidateSourceImports(false, true);
    });
    return () => {
      unsubscribe();
      mountedRef.current = false;
      invalidateSourceImports(true, false);
    };
  }, [invalidateSourceImports]);

  // --- Backfill words for captions on a restored project ---------------------
  // A project restored from a pre-captions snapshot has clips but no `words`, so
  // captions have nothing to chunk. The restore effect and this effect race on
  // mount, so we can't rely on reading `clips` once -- instead SUBSCRIBE to the
  // store and fire the moment we ever observe "a project is loaded but words are
  // empty". Fetches the raw words matching the restored demo footage and
  // setWords() them (which re-chunks caption blocks). One-shot via
  // backfilledRef, and guarded so a user's own transcript is never clobbered.
  useEffect(() => {
    let cancelled = false;

    const tryBackfill = () => {
      if (backfilledRef.current) return;
      const st = useRepurposeStore.getState();
      const projectLoaded = st.clips.length > 0 || !!st.footageMeta;
      if (!projectLoaded || st.words.length > 0) return; // nothing to fix (yet)
      backfilledRef.current = true;
      const projectEpoch = st.projectEpoch;
      (async () => {
        try {
          const [wordsRes, manifestRes] = await Promise.all([
            fetch("/repurpose/claude-routines-words.json"),
            fetch("/repurpose/footage-manifest.json"),
          ]);
          if (
            !wordsRes.ok ||
            !manifestRes.ok ||
            cancelled ||
            useRepurposeStore.getState().projectEpoch !== projectEpoch
          )
            return;
          const [parsed, manifest] = await Promise.all([
            wordsRes.json().then(parseRawWordsFile),
            manifestRes.json() as Promise<Partial<FootageMeta>>,
          ]);
          const current = useRepurposeStore.getState();
          if (
            cancelled ||
            current.projectEpoch !== projectEpoch ||
            current.words.length > 0 ||
            current.footageMeta?.faceCamPath !== manifest.faceCamPath ||
            current.footageMeta?.screenPath !== manifest.screenPath
          )
            return;
          setWords(parsed.words); // setWords also rebuilds caption blocks
        } catch {
          /* assets absent -> captions stay empty until a manual transcript load */
        }
      })();
    };

    tryBackfill(); // in case the project is already present at mount
    const unsub = useRepurposeStore.subscribe(tryBackfill); // and when it lands later
    return () => {
      cancelled = true;
      unsub();
    };
  }, [setWords]);

  // --- Auto-load the staged demo footage on first mount ----------------------
  // The raw words + final transcript + a footage manifest (streaming URLs for
  // the two raw videos) are staged in public/repurpose/. On an EMPTY editor we
  // fetch all three and build the cut immediately, so opening the page shows
  // the finished short playing real footage -- no manual file-picking. Guarded
  // so it never clobbers a manually-loaded project or a session-restored one:
  // it only runs when there are no clips AND no footage yet. Runs once.
  useEffect(() => {
    if (autoLoadedRef.current) return;
    // A saved project is loading from disk (useProjectPersistence set `hydrating`).
    // The store is briefly empty in that window, so DON'T latch or auto-load yet --
    // wait for hydration to finish (this effect re-runs when `hydrating` clears; if
    // the project had clips/footage the guard below then latches without loading).
    if (hydrating) return;
    // Don't fight a project that's already present (manual load, restored, or just
    // hydrated from disk).
    if (clips.length > 0 || footageMeta) {
      autoLoadedRef.current = true;
      return;
    }
    autoLoadedRef.current = true;
    let cancelled = false;
    const projectEpoch = useRepurposeStore.getState().projectEpoch;
    (async () => {
      try {
        const [wordsRes, finalRes, manifestRes] = await Promise.all([
          fetch("/repurpose/claude-routines-words.json"),
          fetch("/repurpose/final-transcript.txt"),
          fetch("/repurpose/footage-manifest.json"),
        ]);
        if (!wordsRes.ok || !finalRes.ok || !manifestRes.ok) return; // assets absent -> stay on manual ingest
        const rawWords = parseRawWordsFile(await wordsRes.json());
        const finalText = (await finalRes.text()).replace(/\s+/g, " ").trim();
        const manifest = (await manifestRes.json()) as Partial<FootageMeta>;
        const epochIsCurrent = () =>
          useRepurposeStore.getState().projectEpoch === projectEpoch;
        if (
          cancelled ||
          !epochIsCurrent()
        )
          return;
        // Bail if the user started loading something while we were fetching.
        const current = useRepurposeStore.getState();
        if (
          current.clips.length > 0 ||
          current.footageMeta ||
          current.sourceImportOwners.screen !== null ||
          current.sourceImportOwners.face !== null
        ) {
          return;
        }

        // The short Reel (selectShort window), not the full 8-minute assembly,
        // plus the auto-cut savings summary for the transcript-rail readout.
        const { clips: built, stats } = buildShortWithStats({
          rawWords: rawWords.words,
          finalTranscript: finalText,
        });
        if (!epochIsCurrent()) return;
        setClips(built);
        if (!epochIsCurrent()) return;
        setEditStats(stats);
        // Feed the raw words to the store too, so captions can chunk them into
        // on-screen blocks (the manual rebuild path does this; the auto-load
        // path must as well or captions have nothing to draw).
        if (!epochIsCurrent()) return;
        setWords(rawWords.words);
        // Manifest paths are already streaming URLs (/api/repurpose/video?...),
        // so set footageMeta directly rather than through makeFootageMeta.
        if (manifest.faceCamPath && manifest.screenPath) {
          if (!epochIsCurrent()) return;
          setFootageMeta({
            faceCamPath: manifest.faceCamPath,
            screenPath: manifest.screenPath,
            fps: manifest.fps ?? 30,
            width: manifest.width ?? 1080,
            height: manifest.height ?? 1920,
            durationSec: manifest.durationSec ?? 0,
          });
        }
        setIngestError(null);
      } catch {
        // Network/parse failure -> silently fall back to manual ingest buttons.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-runs when `hydrating` flips (a disk load finishing), then latches via
    // autoLoadedRef; otherwise a one-shot on mount, guarded internally against
    // re-entry. Other store reads are intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrating, projectEpoch]);

  const handleWordsFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const projectEpoch = useRepurposeStore.getState().projectEpoch;
      const transcriptReadGeneration = transcriptReadGenerationRef.current;
      try {
        const text = await file.text();
        if (
          useRepurposeStore.getState().projectEpoch !== projectEpoch ||
          transcriptReadGenerationRef.current !== transcriptReadGeneration
        ) {
          return;
        }
        // Accept EITHER a pre-parsed words.json OR a raw .srt (what Descript
        // exports). An .srt is parsed into per-word timings in-app so Manthan
        // never has to pre-convert -- he just drops the file Descript gave him.
        const state = useRepurposeStore.getState();
        const faceDuration = state.footageMeta?.faceCamSource?.inspection.durationSec;
        const parsed = file.name.toLowerCase().endsWith(".srt")
          ? parseSrtWords(text, { durationSec: faceDuration })
          : parseRawWordsFile(JSON.parse(text), { durationSec: faceDuration });
        const candidate = buildTranscriptCandidate({
          words: parsed.words,
          maxSourceDuration:
            effectiveVideoTimelineDuration(state.footageMeta) ?? undefined,
        });
        if (candidate.kind === "no-shared-speech") {
          throw new Error("No transcribed speech overlaps the shared source duration.");
        }
        setIngestError(null);
        offerCandidate({
          ...candidate,
          origin: "manual",
          recipe: { kind: "raw", fullWords: parsed.words },
        });
      } catch (err) {
        if (useRepurposeStore.getState().projectEpoch === projectEpoch) {
          setIngestError(
            err instanceof Error ? err.message : "Could not read that file"
          );
        }
      }
    },
    [offerCandidate]
  );

  const handleFinalTranscriptFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const projectEpoch = useRepurposeStore.getState().projectEpoch;
      const transcriptReadGeneration = transcriptReadGenerationRef.current;
      const text = await file.text();
      if (
        useRepurposeStore.getState().projectEpoch !== projectEpoch ||
        transcriptReadGenerationRef.current !== transcriptReadGeneration
      ) {
        return;
      }
      // Strip SRT block numbers + timestamps to plain narration text; a .txt
      // just collapses whitespace.
      try {
        const finalTranscript = file.name.toLowerCase().endsWith(".srt")
          ? srtToPlainText(text)
          : text.replace(/\s+/g, " ").trim();
        if (!finalTranscript) throw new Error("Final transcript is empty.");
        const state = useRepurposeStore.getState();
        const candidate = buildTranscriptCandidate({
          words: state.words,
          finalTranscript,
          maxSourceDuration:
            effectiveVideoTimelineDuration(state.footageMeta) ?? undefined,
        });
        if (candidate.kind === "no-shared-speech") {
          throw new Error("No transcript words are available to match.");
        }
        offerCandidate({
          ...candidate,
          origin: "manual",
          recipe: {
            kind: "final-transcript",
            fullWords: state.words,
            transcript: finalTranscript,
          },
        });
        setIngestError(null);
      } catch (error) {
        setIngestError(
          error instanceof Error ? error.message : "Could not read that file"
        );
      }
    },
    [offerCandidate]
  );

  // --- Import source videos through the compatibility pipeline ---------------
  const handleMediaFiles = useCallback(
    (which: "screen" | "face") => async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      if (which === "face") {
        void cancelTranscription();
        transcriptReadGenerationRef.current += 1;
        clearPending();
      }

      const stateAtStart = useRepurposeStore.getState();
      if (sourceImportEpochRef.current !== stateAtStart.projectEpoch) {
        sourceImportEpochRef.current = stateAtStart.projectEpoch;
        invalidateSourceImports(false, true);
      }
      const previousController = videoImportsRef.current[which];
      const generation = ++videoImportGenerationRef.current[which];
      const controller = new AbortController();
      const projectEpoch = stateAtStart.projectEpoch;
      const isCurrent = () =>
        mountedRef.current &&
        videoImportGenerationRef.current[which] === generation &&
        videoImportsRef.current[which] === controller &&
        useRepurposeStore.getState().projectEpoch === projectEpoch;
      if (!videoImportBaselineRef.current) {
        videoImportBaselineRef.current = {
          readiness: stateAtStart.mediaReadiness,
          reason: stateAtStart.playbackBlockedReason,
        };
        videoImportSucceededRef.current = false;
      }
      videoImportsRef.current[which] = controller;
      previousController?.abort();
      const importToken = beginSourceImport(which);
      sourceImportTokensRef.current[which] = importToken;
      setIngestError(null);
      setMediaReadiness("loading");
      try {
        const source = await importVideoFile(file, {
          role: which,
          signal: controller.signal,
          onProgress: (state) => {
            if (isCurrent()) {
              setVideoProgress((current) => ({ ...current, [which]: state }));
            }
          },
        });
        if (controller.signal.aborted || !isCurrent()) {
          return;
        }

        const existing = useRepurposeStore.getState().footageMeta;
        const url = videoUrlForWorkingSource(source);
        videoImportSucceededRef.current = true;
        setFootageMeta({
          faceCamPath: which === "face" ? url : existing?.faceCamPath ?? "",
          screenPath: which === "screen" ? url : existing?.screenPath ?? "",
          faceCamSource:
            which === "face" ? source : existing?.faceCamSource,
          screenSource:
            which === "screen" ? source : existing?.screenSource,
          fps: source.inspection.video.fps,
          width: source.inspection.video.width,
          height: source.inspection.video.height,
          durationSec: source.inspection.durationSec,
        });
        if (!isCurrent()) return;
        setMediaReadiness("loading");
      } catch (error) {
        const cancelled =
          controller.signal.aborted ||
          (error instanceof VideoImportError &&
            [
              "VIDEO_IMPORT_CANCELLED",
              "COMPATIBILITY_CANCELLED",
              "MEDIA_PROBE_ABORTED",
            ].includes(error.code));
        if (!isCurrent()) {
          return;
        }
        if (!cancelled) {
          const message =
            error instanceof VideoImportError
              ? error.message
              : "Não foi possível importar o vídeo.";
          setVideoProgress((current) => ({
            ...current,
            [which]: {
              phase: "error",
              progress: null,
              error: message,
            },
          }));
        }
      } finally {
        endSourceImport(which, importToken);
        if (
          mountedRef.current &&
          videoImportGenerationRef.current[which] === generation &&
          videoImportsRef.current[which] === controller
        ) {
          delete videoImportsRef.current[which];
          delete sourceImportTokensRef.current[which];
          if (Object.keys(videoImportsRef.current).length === 0) {
            const baseline = videoImportBaselineRef.current;
            const epochIsCurrent =
              useRepurposeStore.getState().projectEpoch === projectEpoch;
            if (epochIsCurrent && videoImportSucceededRef.current) {
              const meta = useRepurposeStore.getState().footageMeta;
              setMediaReadiness(
                meta?.faceCamPath.trim() && meta.screenPath.trim()
                  ? "loading"
                  : "idle"
              );
            } else if (epochIsCurrent && baseline) {
              setMediaReadiness(baseline.readiness, baseline.reason ?? undefined);
            }
            videoImportBaselineRef.current = null;
            videoImportSucceededRef.current = false;
          }
        }
      }
    },
    [
      beginSourceImport,
      endSourceImport,
      invalidateSourceImports,
      setFootageMeta,
      setMediaReadiness,
      cancelTranscription,
      clearPending,
    ]
  );

  // --- Add a free-floating overlay (image/video) at the current playhead ------
  // Runs the SAME shared ingest as drag-drop + paste: copy-to-disk, then
  // addOverlay. Placed at the playhead so it lands where the user is scrubbed.
  const handleAddMedia = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const atTime = useRepurposeStore.getState().playhead;
      // Reset the input BEFORE the await so re-picking the same file re-fires.
      const input = e.target;
      await ingestOverlayFiles(
        files,
        atTime,
        undefined,
        overlayImportOwner
      ).catch(() => undefined);
      input.value = "";
    },
    [overlayImportOwner]
  );

  // Keep onboarding open until every prerequisite for playback is present.
  const footageReady = Boolean(
    footageMeta?.screenPath &&
      footageMeta.screenPath !== "reconnect:" &&
      footageMeta.faceCamPath &&
      footageMeta.faceCamPath !== "reconnect:"
  );

  // The four ingest controls -- shared between the prominent open state and the
  // collapsed "Re-import footage" fold.
  const buttons = (
    <div className="flex flex-col gap-2">
      <IngestButton
        label="Load raw transcript (.srt / .json)"
        accept=".srt,.json,.txt,application/json,text/plain"
        onChange={handleWordsFile}
      />
      <IngestButton
        label="Load final transcript (.srt)"
        accept=".srt,.txt,text/plain"
        onChange={handleFinalTranscriptFile}
      />
      <div className="flex gap-2">
        <IngestButton compact label="Screen" accept="video/*" onChange={handleMediaFiles("screen")} />
        <IngestButton compact label="Face" accept="video/*" onChange={handleMediaFiles("face")} />
      </div>
      {(["screen", "face"] as const).map((role) =>
        videoProgress[role] ? (
          <VideoImportProgress
            key={role}
            state={videoProgress[role]}
            onCancel={() => videoImportsRef.current[role]?.abort()}
          />
        ) : null
      )}
      {ingestError && (
        <div className="flex items-start gap-1.5 rounded-md border border-[#FF6B35]/40 bg-[#FF6B35]/10 px-2 py-1.5 text-[11px] text-[#FF8F6B]">
          <Warning size={13} weight="fill" className="mt-px shrink-0" />
          <span>{ingestError}</span>
        </div>
      )}
    </div>
  );

  const waitingForScreen = Boolean(
    transcription.status?.state === "completed" &&
      transcription.status.result.words.length > 0 &&
      transcriptApplication.pendingCandidate?.origin === "automatic" &&
      effectiveVideoTimelineDuration(footageMeta) === null
  );
  const transcriptionUi = (
    <>
      <TranscriptionControls
        transcription={transcription}
        legacyFace={Boolean(footageMeta?.faceCamPath)}
        notice={transcriptApplication.notice}
        hasPendingApplication={Boolean(transcriptApplication.pendingCandidate)}
        waitingForScreen={waitingForScreen}
      />
      {transcriptApplication.pendingCandidate &&
        !transcriptApplication.dialogOpen &&
        !waitingForScreen && (
        <button
          type="button"
          onClick={transcriptApplication.reopenPending}
          className="text-left text-[11px] font-medium text-[#FF8F6B]"
        >
          Revisar transcrição pendente
        </button>
      )}
      <TranscriptApplyDialog
        open={transcriptApplication.dialogOpen}
        onPreserve={transcriptApplication.applyPreservingCuts}
        onRebuild={transcriptApplication.applyRebuilding}
        onApplyLater={transcriptApplication.applyLater}
      />
    </>
  );

  // Collapsed: footage is loaded, so tuck the ingest behind a small fold and
  // give the grading controls below the room.
  if (footageReady) {
    return (
      <div className="flex flex-col gap-2.5">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground/80">
            <FilmSlate size={13} weight="bold" className="shrink-0" />
            Re-import footage
          </summary>
          <div className="mt-3">{buttons}</div>
        </details>
        {transcriptionUi}
        <AddMediaButton onChange={handleAddMedia} />
      </div>
    );
  }

  // Prominent: no footage yet -- this is the first thing to do on an empty editor.
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <FilmSlate size={13} weight="bold" className="shrink-0" />
        Sources
      </h3>
      <p className="text-[11px] leading-4 text-muted-foreground">
        Choose both Screen and Face videos to enable Play. A raw transcript is optional
        and automatically builds an edited timeline.
      </p>
      {buttons}
      {transcriptionUi}
      <AddMediaButton onChange={handleAddMedia} />
    </div>
  );
}

/**
 * The "Add media" action -- picks one or more image/video files and drops each
 * as a free-floating overlay at the current playhead (multiple = multi-select).
 * Coral-accented so it reads as "add a layer", distinct from the source ingests.
 */
function AddMediaButton({
  onChange,
}: {
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      className="flex items-center justify-center gap-1.5 rounded-md border border-[#FF6B35]/50 bg-[#FF6B35]/10 px-3 py-2 text-xs font-medium text-[#FF8F6B] transition-colors hover:bg-[#FF6B35]/20"
    >
      <ImageSquare size={14} weight="bold" />
      Add media (image / video)
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={onChange}
        className="hidden"
      />
    </button>
  );
}

function IngestButton({
  label,
  accept,
  onChange,
  compact,
}: {
  label: string;
  accept: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      className={`flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary text-xs font-medium text-foreground transition-colors hover:bg-secondary/70 ${
        compact ? "flex-1 px-2 py-1.5" : "px-3 py-2"
      }`}
    >
      <UploadSimple size={13} weight="bold" />
      {label}
      <input ref={inputRef} type="file" accept={accept} onChange={onChange} className="hidden" />
    </button>
  );
}
