import { describe, expect, it } from "vitest";

import {
  MAX_TRANSCRIPTION_RESULT_BYTES,
  MAX_TRANSCRIPTION_WORDS,
  TRANSCRIPTION_ERROR_MESSAGES,
  parseStartTranscriptionRequest,
  parseStartTranscriptionResponse,
  parseTranscriptionErrorResponse,
  parseTranscriptionResult,
  parseTranscriptionStatus,
  type TranscriptionErrorCode,
  type TranscriptionPhase,
} from "@/lib/repurpose/transcription-contract";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const words = [{ text: "Olá", start: 0, end: 0.5 }];

const errorStatuses: ReadonlyArray<
  readonly [number, readonly TranscriptionErrorCode[]]
> = [
  [
    400,
    [
      "TRANSCRIPTION_INVALID_REQUEST",
      "TRANSCRIPTION_SOURCE_INVALID",
      "TRANSCRIPTION_SOURCE_TOO_LONG",
      "TRANSCRIPTION_AUDIO_MISSING",
    ],
  ],
  [404, ["TRANSCRIPTION_NOT_FOUND"]],
  [409, ["TRANSCRIPTION_OBSERVER_CONFLICT", "TRANSCRIPTION_SOURCE_CHANGED"]],
  [413, ["TRANSCRIPTION_PAYLOAD_TOO_LARGE"]],
  [429, ["TRANSCRIPTION_BUSY"]],
  [
    500,
    [
      "TRANSCRIPTION_AUDIO_EXTRACTION_FAILED",
      "TRANSCRIPTION_ENGINE_FAILED",
      "TRANSCRIPTION_INVALID_OUTPUT",
    ],
  ],
  [
    503,
    [
      "TRANSCRIPTION_ENGINE_UNAVAILABLE",
      "TRANSCRIPTION_MODEL_DOWNLOAD_FAILED",
    ],
  ],
  [
    504,
    [
      "TRANSCRIPTION_PREPARATION_TIMEOUT",
      "TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT",
      "TRANSCRIPTION_SETUP_TIMEOUT",
      "TRANSCRIPTION_TIMEOUT",
    ],
  ],
];

describe("transcription contract", () => {
  it.each(["pt", "auto"] as const)(
    "parses an exact start request in %s mode",
    (language) => {
      const request = { observerId: JOB_ID, path: "C:\\media\\face.mp4", language };
      expect(parseStartTranscriptionRequest(request)).toEqual(request);
    }
  );

  it("rejects invalid UUIDs, language, paths, missing fields, and unknown fields", () => {
    const valid = { observerId: JOB_ID, path: "C:\\media\\face.mp4", language: "pt" };
    expect(() =>
      parseStartTranscriptionRequest({ ...valid, observerId: "not-a-uuid" })
    ).toThrow(/observerId/i);
    expect(() =>
      parseStartTranscriptionRequest({ ...valid, language: "en" })
    ).toThrow(/language/i);
    expect(() => parseStartTranscriptionRequest({ ...valid, path: " " })).toThrow(
      /path/i
    );
    expect(() =>
      parseStartTranscriptionRequest({ observerId: JOB_ID, path: valid.path })
    ).toThrow();
    expect(() =>
      parseStartTranscriptionRequest({ ...valid, duration: 10 })
    ).toThrow(/unknown/i);
  });

  it("parses only an exact UUID start response", () => {
    expect(parseStartTranscriptionResponse({ jobId: JOB_ID })).toEqual({
      jobId: JOB_ID,
    });
    expect(() => parseStartTranscriptionResponse({ jobId: "bad" })).toThrow();
    expect(() =>
      parseStartTranscriptionResponse({ jobId: JOB_ID, state: "queued" })
    ).toThrow(/unknown/i);
  });

  it("accepts empty automatic results and validates completed result fields", () => {
    expect(
      parseTranscriptionResult({
        words: [],
        language: "pt",
        languageProbability: null,
        device: "cpu",
      })
    ).toEqual({
      words: [],
      language: "pt",
      languageProbability: null,
      device: "cpu",
    });
    expect(
      parseTranscriptionResult({
        words,
        language: "pt",
        languageProbability: 0.98,
        device: "cuda",
      })
    ).toMatchObject({ words, languageProbability: 0.98, device: "cuda" });
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid language probability %s",
    (languageProbability) => {
      expect(() =>
        parseTranscriptionResult({
          words,
          language: "pt",
          languageProbability,
          device: "cpu",
        })
      ).toThrow(/probability/i);
    }
  );

  it("rejects result unknown fields and enforces word and byte limits", () => {
    expect(() =>
      parseTranscriptionResult({
        words,
        language: "pt",
        languageProbability: null,
        device: "cpu",
        path: "C:\\secret.wav",
      })
    ).toThrow(/unknown/i);

    expect(MAX_TRANSCRIPTION_WORDS).toBe(100_000);
    expect(() =>
      parseTranscriptionResult({
        words: Array.from({ length: MAX_TRANSCRIPTION_WORDS + 1 }, (_, index) => ({
          text: "w",
          start: index,
          end: index + 0.5,
        })),
        language: "pt",
        languageProbability: null,
        device: "cpu",
      })
    ).toThrow(/100000|words/i);

    expect(MAX_TRANSCRIPTION_RESULT_BYTES).toBe(16 * 1024 * 1024);
    expect(() =>
      parseTranscriptionResult({
        words: [{ text: "x".repeat(MAX_TRANSCRIPTION_RESULT_BYTES), start: 0, end: 1 }],
        language: "pt",
        languageProbability: null,
        device: "cpu",
      })
    ).toThrow(/16 MiB|large/i);
  });

  it.each([
    "preparing",
    "extracting-audio",
    "downloading-model",
    "transcribing",
    "finalizing",
  ] as TranscriptionPhase[])("accepts running phase %s", (phase) => {
    expect(
      parseTranscriptionStatus({
        jobId: JOB_ID,
        state: "running",
        phase,
        progress: null,
        device: null,
        warning: null,
        result: null,
        error: null,
      })
    ).toMatchObject({ state: "running", phase });
  });

  it.each(["queued", "running"] as const)(
    "accepts valid %s progress, device, and warning",
    (state) => {
      expect(
        parseTranscriptionStatus({
          jobId: JOB_ID,
          state,
          phase: "transcribing",
          progress: 0.5,
          device: "cpu",
          warning: {
            code: "TRANSCRIPTION_GPU_FALLBACK",
            message: "GPU indisponível; continuando na CPU.",
          },
          result: null,
          error: null,
        })
      ).toMatchObject({ state, progress: 0.5, device: "cpu" });
    }
  );

  it("enforces completed state-dependent fields", () => {
    const result = {
      words,
      language: "pt",
      languageProbability: 1,
      device: "cuda",
    } as const;
    expect(
      parseTranscriptionStatus({
        jobId: JOB_ID,
        state: "completed",
        phase: "finalizing",
        progress: 1,
        device: "cuda",
        warning: null,
        result,
        error: null,
      })
    ).toMatchObject({ state: "completed", result });
    expect(() =>
      parseTranscriptionStatus({
        jobId: JOB_ID,
        state: "completed",
        phase: "transcribing",
        progress: 0.9,
        device: "cuda",
        warning: null,
        result,
        error: null,
      })
    ).toThrow();
    expect(() =>
      parseTranscriptionStatus({
        jobId: JOB_ID,
        state: "completed",
        phase: "finalizing",
        progress: 1,
        device: "cpu",
        warning: null,
        result,
        error: null,
      })
    ).toThrow(/device/i);
  });

  it.each(["failed", "cancelled"] as const)(
    "enforces %s state-dependent nullable fields",
    (state) => {
      const code =
        state === "cancelled"
          ? "TRANSCRIPTION_CANCELLED"
          : "TRANSCRIPTION_ENGINE_FAILED";
      expect(
        parseTranscriptionStatus({
          jobId: JOB_ID,
          state,
          phase: "transcribing",
          progress: null,
          device: "cpu",
          warning: null,
          result: null,
          error: { code, message: TRANSCRIPTION_ERROR_MESSAGES[code] },
        })
      ).toMatchObject({ state, error: { code } });
    }
  );

  it("rejects invalid progress, warning text, status keys, and unsafe errors", () => {
    const running = {
      jobId: JOB_ID,
      state: "running",
      phase: "transcribing",
      progress: 0.5,
      device: "cpu",
      warning: null,
      result: null,
      error: null,
    };
    for (const progress of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseTranscriptionStatus({ ...running, progress })).toThrow(
        /progress/i
      );
    }
    expect(() =>
      parseTranscriptionStatus({
        ...running,
        warning: {
          code: "TRANSCRIPTION_GPU_FALLBACK",
          message: "CUDA failed at C:\\private\\model",
        },
      })
    ).toThrow(/warning|message/i);
    expect(() => parseTranscriptionStatus({ ...running, stderr: "secret" })).toThrow(
      /unknown/i
    );
    expect(() =>
      parseTranscriptionStatus({
        ...running,
        state: "failed",
        error: {
          code: "TRANSCRIPTION_ENGINE_FAILED",
          message: "uv failed at C:\\private\\engine.py",
        },
      })
    ).toThrow(/message/i);
  });

  it("accepts every fixed HTTP status/code pair with its safe Portuguese message", () => {
    for (const [status, codes] of errorStatuses) {
      for (const code of codes) {
        const value = {
          error: { code, message: TRANSCRIPTION_ERROR_MESSAGES[code] },
        };
        expect(parseTranscriptionErrorResponse(value, status)).toEqual(value);
      }
    }
  });

  it("rejects unsupported statuses, mismatched status/code pairs, unknown keys, and unsafe messages", () => {
    const invalidRequest = {
      error: {
        code: "TRANSCRIPTION_INVALID_REQUEST",
        message: TRANSCRIPTION_ERROR_MESSAGES.TRANSCRIPTION_INVALID_REQUEST,
      },
    };
    expect(() => parseTranscriptionErrorResponse(invalidRequest, 418)).toThrow(
      /status/i
    );
    expect(() => parseTranscriptionErrorResponse(invalidRequest, 500)).toThrow(
      /status|code/i
    );
    expect(() =>
      parseTranscriptionErrorResponse({ ...invalidRequest, retryAfter: 2 }, 400)
    ).toThrow(/unknown/i);
    expect(() =>
      parseTranscriptionErrorResponse(
        {
          error: {
            code: "TRANSCRIPTION_INVALID_REQUEST",
            message: "Invalid C:\\private\\face.mp4",
          },
        },
        400
      )
    ).toThrow(/message/i);
  });
});
