import {
  SFX_CATALOG,
  defaultBuiltInDuration,
  isApprovedSfxKey,
} from "./sfx-effects";
import type { SfxEvent } from "./sfx-placement";
import type {
  SfxAsset,
  SfxClip,
  SfxClipSource,
  SfxTrack,
} from "./types";

const MAX_GAIN = 2;
const MAX_FADE_SEC = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanTime(value: number): number {
  const rounded = Math.round(value * 1e12) / 1e12;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function claimUniqueId(preferredId: string, usedIds: Set<string>): string {
  let id = preferredId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${preferredId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function normalizeSource(value: unknown): SfxClipSource | null {
  if (!isRecord(value)) return null;
  if (value.kind === "built-in" && isApprovedSfxKey(value.key)) {
    return { kind: "built-in", key: value.key };
  }
  if (
    value.kind === "imported"
    && typeof value.assetId === "string"
    && value.assetId.length > 0
    && isFiniteNumber(value.srcDuration)
    && value.srcDuration > 0
  ) {
    return { kind: "imported", assetId: value.assetId, srcDuration: value.srcDuration };
  }
  if (
    value.kind === "legacy"
    && typeof value.sourcePath === "string"
    && value.sourcePath.length > 0
    && isFiniteNumber(value.srcDuration)
    && value.srcDuration > 0
  ) {
    return { kind: "legacy", sourcePath: value.sourcePath, srcDuration: value.srcDuration };
  }
  return null;
}

export function sfxSourceDuration(source: SfxClipSource): number {
  return source.kind === "built-in"
    ? SFX_CATALOG[source.key].sourceDuration
    : source.srcDuration;
}

export function isSfxClipSourceAvailable(
  source: SfxClipSource,
  assets: readonly SfxAsset[]
): boolean {
  if (source.kind !== "imported") return true;
  return assets.some((asset) => (
    asset.id === source.assetId
    && asset.sourcePath.length > 0
    && Number.isFinite(asset.srcDuration)
    && asset.srcDuration > 0
  ));
}

export function sfxClipDuration(clip: SfxClip): number {
  return clip.sourceEnd - clip.sourceStart;
}

export function sfxClipTimelineEnd(clip: SfxClip): number {
  return clip.timelineStart + sfxClipDuration(clip);
}

export function normalizeSfxClip(value: unknown, projectDuration: number): SfxClip | null {
  if (!isRecord(value) || !isFiniteNumber(projectDuration) || projectDuration <= 0) return null;
  if (
    typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.name !== "string"
    || value.name.length === 0
    || (value.origin !== "automatic" && value.origin !== "manual")
    || !isFiniteNumber(value.timelineStart)
    || !isFiniteNumber(value.sourceStart)
    || !isFiniteNumber(value.sourceEnd)
    || value.sourceEnd <= value.sourceStart
  ) {
    return null;
  }

  const source = normalizeSource(value.source);
  if (!source) return null;
  const sourceDuration = sfxSourceDuration(source);
  const timelineStart = Math.max(0, value.timelineStart);
  if (timelineStart >= projectDuration) return null;

  const sourceStart = clamp(value.sourceStart, 0, sourceDuration);
  const maximumDuration = projectDuration - timelineStart;
  const sourceEnd = Math.min(value.sourceEnd, sourceDuration, sourceStart + maximumDuration);
  if (!Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) return null;

  return {
    id: value.id,
    name: value.name,
    source,
    origin: value.origin,
    timelineStart: cleanTime(timelineStart),
    sourceStart: cleanTime(sourceStart),
    sourceEnd: cleanTime(sourceEnd),
    gain: clamp(isFiniteNumber(value.gain) ? value.gain : 1, 0, MAX_GAIN),
    fadeInSec: clamp(isFiniteNumber(value.fadeInSec) ? value.fadeInSec : 0, 0, MAX_FADE_SEC),
    fadeOutSec: clamp(isFiniteNumber(value.fadeOutSec) ? value.fadeOutSec : 0, 0, MAX_FADE_SEC),
    muted: value.muted === true,
  };
}

export function normalizeSfxDocument(value: unknown, projectDuration: number): SfxClip[] {
  if (!Array.isArray(value)) return [];
  const clips: SfxClip[] = [];
  const usedIds = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeSfxClip(entry, projectDuration);
    if (!normalized || usedIds.has(normalized.id)) continue;
    usedIds.add(normalized.id);
    clips.push(normalized);
  }
  return clips;
}

export function effectiveSfxFadeDurations(
  clip: SfxClip,
  audibleDuration = sfxClipDuration(clip)
): { fadeInSec: number; fadeOutSec: number } {
  if (!Number.isFinite(audibleDuration) || audibleDuration <= 0) {
    return { fadeInSec: 0, fadeOutSec: 0 };
  }
  const fadeInSec = clamp(
    Number.isFinite(clip.fadeInSec) ? clip.fadeInSec : 0,
    0,
    MAX_FADE_SEC
  );
  const fadeOutSec = clamp(
    Number.isFinite(clip.fadeOutSec) ? clip.fadeOutSec : 0,
    0,
    MAX_FADE_SEC
  );
  const requestedTotal = fadeInSec + fadeOutSec;
  if (requestedTotal <= audibleDuration) return { fadeInSec, fadeOutSec };
  const scale = audibleDuration / requestedTotal;
  return { fadeInSec: fadeInSec * scale, fadeOutSec: fadeOutSec * scale };
}

export interface ResolvedSfxClip {
  active: boolean;
  sourceTime: number;
  effectiveGain: number;
  audibleStart: number;
  audibleEnd: number;
}

export function resolveSfxClipAt(
  clip: SfxClip,
  outputTime: number,
  projectDuration: number,
  sourceDuration: number,
  sourceBaseGain: number
): ResolvedSfxClip {
  const invalid = (
    !Number.isFinite(outputTime)
    || !Number.isFinite(projectDuration)
    || projectDuration <= 0
    || !Number.isFinite(sourceDuration)
    || sourceDuration <= 0
    || !Number.isFinite(sourceBaseGain)
    || sourceBaseGain < 0
    || !Number.isFinite(clip.timelineStart)
    || !Number.isFinite(clip.sourceStart)
    || !Number.isFinite(clip.sourceEnd)
    || clip.sourceStart < 0
    || clip.sourceEnd <= clip.sourceStart
    || clip.sourceEnd > sourceDuration
  );
  const audibleStart = Math.max(0, clip.timelineStart);
  const availableSourceEnd = Math.min(clip.sourceEnd, sourceDuration);
  const audibleDuration = Math.max(0, availableSourceEnd - clip.sourceStart);
  const audibleEnd = Math.min(projectDuration, audibleStart + audibleDuration);
  const localTime = outputTime - audibleStart;
  const sourceTime = clip.sourceStart + localTime;
  const temporalActive = !invalid
    && outputTime >= audibleStart
    && outputTime < audibleEnd
    && sourceTime >= clip.sourceStart
    && sourceTime < availableSourceEnd;
  if (!temporalActive || clip.muted) {
    return { active: false, sourceTime, effectiveGain: 0, audibleStart, audibleEnd };
  }

  const fades = effectiveSfxFadeDurations(clip, audibleEnd - audibleStart);
  const fadeInGain = fades.fadeInSec > 0 ? Math.min(1, localTime / fades.fadeInSec) : 1;
  const remaining = audibleEnd - outputTime;
  const fadeOutGain = fades.fadeOutSec > 0 ? Math.min(1, remaining / fades.fadeOutSec) : 1;
  return {
    active: true,
    sourceTime,
    effectiveGain: sourceBaseGain * clamp(clip.gain, 0, MAX_GAIN) * Math.min(fadeInGain, fadeOutGain),
    audibleStart,
    audibleEnd,
  };
}

export function placeSfxClip(
  clip: SfxClip,
  requestedTime: number,
  projectDuration: number
): SfxClip | null {
  if (
    !Number.isFinite(requestedTime)
    || !Number.isFinite(projectDuration)
    || projectDuration <= 0
  ) return null;
  const duration = sfxClipDuration(clip);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const timelineStart = requestedTime >= projectDuration
    ? Math.max(0, projectDuration - duration)
    : Math.max(0, requestedTime);
  return normalizeSfxClip({ ...clip, timelineStart }, projectDuration);
}

export function moveSfxClip(
  clip: SfxClip,
  requestedTime: number,
  projectDuration: number
): SfxClip {
  if (!Number.isFinite(requestedTime) || !Number.isFinite(projectDuration)) return clip;
  const duration = sfxClipDuration(clip);
  if (duration <= 0 || duration > projectDuration) return clip;
  return {
    ...clip,
    timelineStart: cleanTime(clamp(requestedTime, 0, projectDuration - duration)),
  };
}

export function trimSfxClipLeft(clip: SfxClip, requestedTimelineStart: number): SfxClip {
  if (!Number.isFinite(requestedTimelineStart)) return clip;
  const rightEdge = sfxClipTimelineEnd(clip);
  const earliestStart = Math.max(0, clip.timelineStart - clip.sourceStart);
  if (requestedTimelineStart >= rightEdge) return clip;
  const timelineStart = clamp(requestedTimelineStart, earliestStart, rightEdge);
  const delta = timelineStart - clip.timelineStart;
  const sourceStart = clip.sourceStart + delta;
  if (sourceStart >= clip.sourceEnd) return clip;
  return {
    ...clip,
    timelineStart: cleanTime(timelineStart),
    sourceStart: cleanTime(sourceStart),
  };
}

export function trimSfxClipRight(
  clip: SfxClip,
  requestedTimelineEnd: number,
  projectDuration: number,
  sourceDuration: number
): SfxClip {
  if (
    !Number.isFinite(requestedTimelineEnd)
    || !Number.isFinite(projectDuration)
    || !Number.isFinite(sourceDuration)
  ) return clip;
  const timelineEnd = Math.min(requestedTimelineEnd, projectDuration);
  const sourceEnd = Math.min(
    sourceDuration,
    clip.sourceStart + Math.max(0, timelineEnd - clip.timelineStart)
  );
  if (sourceEnd <= clip.sourceStart) return clip;
  return { ...clip, sourceEnd: cleanTime(sourceEnd) };
}

export function constrainSfxClipsToDuration(
  clips: readonly SfxClip[],
  projectDuration: number
): SfxClip[] {
  if (!Number.isFinite(projectDuration) || projectDuration <= 0) return [];
  return clips.flatMap((clip) => {
    if (clip.timelineStart < 0 || clip.timelineStart >= projectDuration) return [];
    const maximumDuration = projectDuration - clip.timelineStart;
    const sourceEnd = Math.min(clip.sourceEnd, clip.sourceStart + maximumDuration);
    if (sourceEnd <= clip.sourceStart) return [];
    return [{ ...clip, sourceEnd: cleanTime(sourceEnd) }];
  });
}

export function replaceSfxClipSource(
  clip: SfxClip,
  replacement: { name: string; source: SfxClipSource },
  projectDuration: number
): SfxClip | null {
  const sourceDuration = replacement.source.kind === "built-in"
    ? defaultBuiltInDuration(replacement.source.key)
    : sfxSourceDuration(replacement.source);
  return normalizeSfxClip({
    ...clip,
    name: replacement.name,
    source: replacement.source,
    origin: "manual",
    sourceStart: 0,
    sourceEnd: sourceDuration,
  }, projectDuration);
}

export function duplicateSfxClip(
  clip: SfxClip,
  id: string,
  projectDuration: number
): SfxClip | null {
  const duration = sfxClipDuration(clip);
  if (duration <= 0 || duration > projectDuration) return null;
  const afterSource = sfxClipTimelineEnd(clip);
  const timelineStart = afterSource + duration <= projectDuration
    ? afterSource
    : clip.timelineStart;
  return normalizeSfxClip({ ...clip, id, origin: "manual", timelineStart }, projectDuration);
}

export function sfxClipsFromEvents(
  events: readonly SfxEvent[],
  projectDuration: number,
  idForIndex: (index: number) => string = (index) => `sfx-auto-${index + 1}`
): SfxClip[] {
  const usedIds = new Set<string>();
  return events.flatMap((event, index) => {
    const metadata = SFX_CATALOG[event.sfx];
    const candidate: SfxClip = {
      id: idForIndex(index),
      name: metadata.displayName,
      source: { kind: "built-in", key: event.sfx },
      origin: "automatic",
      timelineStart: event.atMs / 1000,
      sourceStart: 0,
      sourceEnd: defaultBuiltInDuration(event.sfx),
      gain: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      muted: false,
    };
    const normalized = normalizeSfxClip(candidate, projectDuration);
    return normalized
      ? [{ ...normalized, id: claimUniqueId(normalized.id, usedIds) }]
      : [];
  });
}

export function replaceAutomaticSfxClips(
  current: readonly SfxClip[],
  automatic: readonly SfxClip[]
): SfxClip[] {
  const manual = current.filter((clip) => clip.origin === "manual");
  const usedIds = new Set(manual.map((clip) => clip.id));
  return [
    ...manual,
    ...automatic.map((clip) => ({
      ...clip,
      id: claimUniqueId(clip.id, usedIds),
      origin: "automatic" as const,
    })),
  ];
}

export function migrateLegacySfxTrack(
  track: SfxTrack,
  projectDuration: number,
  id = "sfx-legacy"
): SfxClip | null {
  if (
    !Number.isFinite(track.durationSec)
    || track.durationSec <= 0
    || !Number.isFinite(track.gain)
    || typeof track.sourcePath !== "string"
    || track.sourcePath.length === 0
  ) return null;
  return normalizeSfxClip({
    id,
    name: "Legacy Sound Effects",
    source: { kind: "legacy", sourcePath: track.sourcePath, srcDuration: track.durationSec },
    origin: "automatic",
    timelineStart: 0,
    sourceStart: 0,
    sourceEnd: Math.min(track.durationSec, projectDuration),
    gain: track.gain,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
  }, projectDuration);
}
