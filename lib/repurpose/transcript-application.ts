import {
  buildClipsFromIngest,
  buildShortWithStats,
  type EditStats,
} from "./ingest";
import {
  VIDEO_TIMELINE_CLIP_ID,
  type Clip,
  type FootageMeta,
  type Word,
} from "./types";

const TIMELINE_EPSILON = 1e-6;

export function effectiveVideoTimelineDuration(
  meta: FootageMeta | null
): number | null {
  const screenDuration = meta?.screenSource?.inspection.durationSec;
  const faceDuration = meta?.faceCamSource?.inspection.durationSec;
  if (
    !Number.isFinite(screenDuration) ||
    !Number.isFinite(faceDuration) ||
    (screenDuration ?? 0) <= 0 ||
    (faceDuration ?? 0) <= 0
  ) {
    return null;
  }
  return Math.min(screenDuration!, faceDuration!);
}

export function isUntouchedVideoTimeline(input: {
  clips: readonly Clip[];
  words: readonly Word[];
  effectiveDuration: number | null;
}): boolean {
  if (input.words.length > 0) return false;
  if (input.clips.length === 0) return true;
  if (input.clips.length !== 1 || input.effectiveDuration === null) return false;
  const clip = input.clips[0];
  return (
    clip.id === VIDEO_TIMELINE_CLIP_ID &&
    clip.kind === "take" &&
    clip.kept &&
    clip.isKeeperTake &&
    clip.keeperIndex === 0 &&
    Math.abs(clip.srcStart) <= TIMELINE_EPSILON &&
    Math.abs(clip.timelineStart) <= TIMELINE_EPSILON &&
    Math.abs(clip.srcEnd - input.effectiveDuration) <= TIMELINE_EPSILON &&
    Math.abs(clip.timelineEnd - input.effectiveDuration) <= TIMELINE_EPSILON &&
    clip.occurrences.length === 1 &&
    Math.abs(clip.occurrences[0].start) <= TIMELINE_EPSILON &&
    Math.abs(clip.occurrences[0].end - input.effectiveDuration) <= TIMELINE_EPSILON
  );
}

function boundClip(clip: Clip, maxSourceDuration: number): Clip | null {
  const srcStart = Math.max(0, clip.srcStart);
  const srcEnd = Math.min(clip.srcEnd, maxSourceDuration);
  if (srcEnd <= srcStart) return null;

  const occurrences = clip.occurrences.flatMap((occurrence, originalIndex) => {
    const start = Math.max(srcStart, occurrence.start);
    const end = Math.min(srcEnd, occurrence.end);
    if (end <= start) return [];
    return [{ start, end, originalIndex }];
  });
  const boundedOccurrences = occurrences.map(({ start, end }) => ({ start, end }));
  const selectedIndex = occurrences.findIndex(
    (occurrence) => occurrence.originalIndex === clip.keeperIndex
  );

  return {
    ...clip,
    srcStart,
    srcEnd,
    occurrences: boundedOccurrences,
    keeperIndex:
      clip.keeperIndex < 0
        ? clip.keeperIndex
        : selectedIndex >= 0
          ? selectedIndex
          : boundedOccurrences.length > 0
            ? 0
            : clip.keeperIndex,
  };
}

export function boundTranscriptClips(
  clips: readonly Clip[],
  maxSourceDuration: number
): Clip[] {
  if (!Number.isFinite(maxSourceDuration) || maxSourceDuration <= 0) return [];
  return clips.flatMap((clip) => {
    const bounded = boundClip(clip, maxSourceDuration);
    return bounded ? [bounded] : [];
  });
}

export function buildTranscriptCandidate(input: {
  words: Word[];
  finalTranscript?: string;
  maxSourceDuration?: number;
}):
  | { kind: "ready"; words: Word[]; clips: Clip[]; stats: EditStats | null }
  | { kind: "no-shared-speech" } {
  const duration = input.maxSourceDuration;
  if (
    duration !== undefined &&
    (!Number.isFinite(duration) || duration <= 0)
  ) {
    return { kind: "no-shared-speech" };
  }
  const words = input.words;
  const built = input.finalTranscript
    ? buildShortWithStats(
        {
          rawWords: words,
          finalTranscript: input.finalTranscript,
        },
        duration === undefined ? {} : { maxSourceDuration: duration }
      )
    : {
        clips: buildClipsFromIngest({ rawWords: words }),
        stats: null,
      };

  if (duration === undefined) {
    return built.clips.some((clip) => clip.kept)
      ? { kind: "ready", words, clips: built.clips, stats: built.stats }
      : { kind: "no-shared-speech" };
  }

  const clips = boundTranscriptClips(built.clips, duration);
  return clips.some((clip) => clip.kept)
    ? { kind: "ready", words, clips, stats: built.stats }
    : { kind: "no-shared-speech" };
}
