import { describe, expect, it } from "vitest";

import {
  normalizeTranscriptWords,
  parseRawWordsFile,
  parseSrtWords,
  srtToPlainText,
} from "@/lib/repurpose/transcript-ingest";

const VALID_SRT = `1
00:00:01,000 --> 00:00:03,000
  Olá,   mundo!${"  "}

2
00:00:04.000 --> 00:00:05.000
Tudo bem?`;

describe("transcript ingest", () => {
  it("parses strict JSON and normalizes only surrounding word whitespace", () => {
    expect(
      parseRawWordsFile({
        text: " Olá, mundo! ",
        words: [
          { text: "  Olá,  ", start: 1, end: 1.5 },
          { text: " mundo!\n", start: 1.5, end: 2 },
        ],
      })
    ).toEqual({
      text: "Olá, mundo!",
      words: [
        { text: "Olá,", start: 1, end: 1.5 },
        { text: "mundo!", start: 1.5, end: 2 },
      ],
    });
  });

  it("parses strict SRT, preserves punctuation, and spreads each cue over its words", () => {
    expect(parseSrtWords(VALID_SRT)).toEqual({
      text: "Olá, mundo! Tudo bem?",
      words: [
        { text: "Olá,", start: 1, end: 2 },
        { text: "mundo!", start: 2, end: 3 },
        { text: "Tudo", start: 4, end: 4.5 },
        { text: "bem?", start: 4.5, end: 5 },
      ],
    });
    expect(srtToPlainText(VALID_SRT)).toBe("Olá, mundo! Tudo bem?");
  });

  it.each([
    "1\nnot-a-time --> 00:00:02,000\nOlá",
    "1\n00:00:01,000 --> nope\nOlá",
    "1\n00:61:01,000 --> 00:61:02,000\nOlá",
    "1\n00:00:01,000 -> 00:00:02,000\nOlá",
    "1\n00:00:02,000 --> 00:00:01,000\nOlá",
  ])("rejects malformed SRT timecodes: %s", (source) => {
    expect(() => parseSrtWords(source)).toThrow(/SRT/i);
  });

  it.each([
    { words: [{ text: "", start: 0, end: 1 }] },
    { words: [{ text: "   ", start: 0, end: 1 }] },
    { words: [{ text: "word", start: Number.NaN, end: 1 }] },
    { words: [{ text: "word", start: 0, end: Number.POSITIVE_INFINITY }] },
    { words: [{ text: "word", start: -0.01, end: 1 }] },
    { words: [{ text: "word", start: 2, end: 1 }] },
    { words: [{ text: "word", start: 1, end: 1 }] },
    {
      words: [
        { text: "later", start: 2, end: 3 },
        { text: "earlier", start: 1, end: 1.5 },
      ],
    },
  ])("rejects invalid words %#", ({ words }) => {
    expect(() => normalizeTranscriptWords(words, { allowEmpty: true })).toThrow();
  });

  it("allows a small duration tolerance only when duration is supplied", () => {
    const words = [{ text: "word", start: 9.9, end: 10.25 }];
    expect(
      normalizeTranscriptWords(words, { allowEmpty: false, durationSec: 10 })
    ).toEqual(words);
    expect(() =>
      normalizeTranscriptWords(
        [{ text: "word", start: 9.9, end: 10.251 }],
        { allowEmpty: false, durationSec: 10 }
      )
    ).toThrow(/duration/i);
    expect(
      normalizeTranscriptWords(
        [{ text: "word", start: 9.9, end: 999 }],
        { allowEmpty: false }
      )
    ).toHaveLength(1);
  });

  it("accepts empty automatic output but rejects empty manual JSON and SRT", () => {
    expect(normalizeTranscriptWords([], { allowEmpty: true })).toEqual([]);
    expect(() => parseRawWordsFile({ text: "", words: [] })).toThrow(/empty/i);
    expect(() => parseSrtWords("  \n")).toThrow(/empty/i);
  });

  it("rejects malformed JSON structure and unknown fields", () => {
    expect(() => parseRawWordsFile(null)).toThrow();
    expect(() => parseRawWordsFile({ text: "hello" })).toThrow();
    expect(() =>
      parseRawWordsFile({
        text: "hello",
        words: [{ text: "hello", start: 0, end: 1, confidence: 1 }],
      })
    ).toThrow(/unknown/i);
    expect(() =>
      parseRawWordsFile({ text: "hello", words: [], extra: true })
    ).toThrow(/unknown/i);
  });
});
