import type { Word } from "./types";

export interface RawWordsFile {
  text: string;
  words: Word[];
}

const DURATION_TOLERANCE_SEC = 0.25;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label}: unknown field \`${unknown}\``);
  const missing = keys.find((key) => !(key in value));
  if (missing) throw new Error(`${label}: missing \`${missing}\``);
}

export function normalizeTranscriptWords(
  value: unknown,
  options: { allowEmpty: boolean; durationSec?: number }
): Word[] {
  if (!Array.isArray(value)) throw new Error("transcript words: expected an array");
  if (!options.allowEmpty && value.length === 0) {
    throw new Error("transcript words: empty transcript");
  }
  if (
    options.durationSec !== undefined &&
    (!Number.isFinite(options.durationSec) || options.durationSec <= 0)
  ) {
    throw new Error("transcript words: invalid duration");
  }

  let previousStart = -1;
  return value.map((entry, index) => {
    const word = record(entry, `transcript word ${index}`);
    exactKeys(word, ["text", "start", "end"], `transcript word ${index}`);
    if (typeof word.text !== "string") {
      throw new Error(`transcript word ${index}: invalid text`);
    }
    const text = word.text.trim();
    if (!text) throw new Error(`transcript word ${index}: empty text`);
    if (
      typeof word.start !== "number" ||
      typeof word.end !== "number" ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end <= word.start
    ) {
      throw new Error(`transcript word ${index}: invalid timestamps`);
    }
    if (word.start < previousStart) {
      throw new Error(`transcript word ${index}: non-monotonic start`);
    }
    if (
      options.durationSec !== undefined &&
      word.end > options.durationSec + DURATION_TOLERANCE_SEC
    ) {
      throw new Error(`transcript word ${index}: timestamp exceeds duration`);
    }
    previousStart = word.start;
    return { text, start: word.start, end: word.end };
  });
}

export function parseRawWordsFile(
  value: unknown,
  options: { durationSec?: number } = {}
): RawWordsFile {
  const input = record(value, "words.json");
  exactKeys(input, ["text", "words"], "words.json");
  if (typeof input.text !== "string") {
    throw new Error("words.json: invalid `text`");
  }
  const words = normalizeTranscriptWords(input.words, {
    allowEmpty: false,
    durationSec: options.durationSec,
  });
  return { text: input.text.trim(), words };
}

interface SrtCue {
  start: number;
  end: number;
  text: string;
}

function parseSrtTimestamp(value: string, cue: number): number {
  const match = value.match(/^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/);
  if (!match) throw new Error(`SRT cue ${cue}: malformed timecode`);
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function parseSrtCues(source: string): SrtCue[] {
  const normalized = source.replace(/^\uFEFF/, "").trim();
  if (!normalized) throw new Error("SRT: empty transcript");
  const blocks = normalized.split(/\r?\n\s*\r?\n/);
  return blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    const cue = index + 1;
    if (lines.length < 3 || !/^\d+$/.test(lines[0].trim())) {
      throw new Error(`SRT cue ${cue}: malformed block`);
    }
    const timing = lines[1].trim().match(/^(\S+)\s+-->\s+(\S+)$/);
    if (!timing) throw new Error(`SRT cue ${cue}: malformed timecode`);
    const start = parseSrtTimestamp(timing[1], cue);
    const end = parseSrtTimestamp(timing[2], cue);
    if (end <= start) throw new Error(`SRT cue ${cue}: reversed timecode`);
    const text = lines.slice(2).join(" ").replace(/\s+/g, " ").trim();
    if (!text) throw new Error(`SRT cue ${cue}: empty text`);
    return { start, end, text };
  });
}

export function parseSrtWords(
  source: string,
  options: { durationSec?: number } = {}
): RawWordsFile {
  if (typeof source !== "string") throw new Error("SRT: expected text");
  const cues = parseSrtCues(source);
  const words = cues.flatMap((cue) => {
    const tokens = cue.text.split(/\s+/);
    const wordDuration = (cue.end - cue.start) / tokens.length;
    return tokens.map((text, index) => ({
      text,
      start: cue.start + wordDuration * index,
      end: index === tokens.length - 1 ? cue.end : cue.start + wordDuration * (index + 1),
    }));
  });
  return {
    text: cues.map((cue) => cue.text).join(" "),
    words: normalizeTranscriptWords(words, {
      allowEmpty: false,
      durationSec: options.durationSec,
    }),
  };
}

export function srtToPlainText(source: string): string {
  return parseSrtCues(source)
    .map((cue) => cue.text)
    .join(" ");
}
