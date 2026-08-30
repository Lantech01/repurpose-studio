import { normalizeTranscriptWords } from "./transcript-ingest";
import type { Word } from "./types";

export type TranscriptionLanguage = "pt" | "auto";
export type TranscriptionPhase =
  | "preparing"
  | "extracting-audio"
  | "downloading-model"
  | "transcribing"
  | "finalizing";

export const MAX_TRANSCRIPTION_RESULT_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSCRIPTION_WORDS = 100_000;

const ERROR_CODES = [
  "TRANSCRIPTION_INVALID_REQUEST",
  "TRANSCRIPTION_PAYLOAD_TOO_LARGE",
  "TRANSCRIPTION_OBSERVER_CONFLICT",
  "TRANSCRIPTION_NOT_FOUND",
  "TRANSCRIPTION_SOURCE_INVALID",
  "TRANSCRIPTION_SOURCE_CHANGED",
  "TRANSCRIPTION_SOURCE_TOO_LONG",
  "TRANSCRIPTION_PREPARATION_TIMEOUT",
  "TRANSCRIPTION_AUDIO_MISSING",
  "TRANSCRIPTION_AUDIO_EXTRACTION_FAILED",
  "TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT",
  "TRANSCRIPTION_ENGINE_UNAVAILABLE",
  "TRANSCRIPTION_MODEL_DOWNLOAD_FAILED",
  "TRANSCRIPTION_SETUP_TIMEOUT",
  "TRANSCRIPTION_ENGINE_FAILED",
  "TRANSCRIPTION_INVALID_OUTPUT",
  "TRANSCRIPTION_BUSY",
  "TRANSCRIPTION_CANCELLED",
  "TRANSCRIPTION_TIMEOUT",
] as const;

export type TranscriptionErrorCode = (typeof ERROR_CODES)[number];

export const TRANSCRIPTION_ERROR_MESSAGES: Readonly<
  Record<TranscriptionErrorCode, string>
> = {
  TRANSCRIPTION_INVALID_REQUEST: "A solicitação de transcrição é inválida.",
  TRANSCRIPTION_PAYLOAD_TOO_LARGE: "Os dados da transcrição excedem o limite permitido.",
  TRANSCRIPTION_OBSERVER_CONFLICT: "Este identificador já está sendo usado por outra transcrição.",
  TRANSCRIPTION_NOT_FOUND: "A transcrição solicitada não foi encontrada.",
  TRANSCRIPTION_SOURCE_INVALID: "O vídeo Face importado não é válido para transcrição.",
  TRANSCRIPTION_SOURCE_CHANGED: "O vídeo Face mudou durante a transcrição. Tente novamente.",
  TRANSCRIPTION_SOURCE_TOO_LONG: "O vídeo Face excede o limite de duas horas.",
  TRANSCRIPTION_PREPARATION_TIMEOUT: "A preparação do vídeo excedeu o tempo limite.",
  TRANSCRIPTION_AUDIO_MISSING: "O vídeo Face não contém uma faixa de áudio.",
  TRANSCRIPTION_AUDIO_EXTRACTION_FAILED: "Não foi possível extrair o áudio do vídeo Face.",
  TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT: "A extração do áudio excedeu o tempo limite.",
  TRANSCRIPTION_ENGINE_UNAVAILABLE: "O mecanismo local de transcrição não está disponível.",
  TRANSCRIPTION_MODEL_DOWNLOAD_FAILED: "Não foi possível baixar o modelo local de transcrição.",
  TRANSCRIPTION_SETUP_TIMEOUT: "A preparação do modelo local excedeu o tempo limite.",
  TRANSCRIPTION_ENGINE_FAILED: "O mecanismo local não conseguiu concluir a transcrição.",
  TRANSCRIPTION_INVALID_OUTPUT: "O mecanismo local retornou uma transcrição inválida.",
  TRANSCRIPTION_BUSY: "Outra transcrição está em andamento. Tente novamente em instantes.",
  TRANSCRIPTION_CANCELLED: "A transcrição foi cancelada.",
  TRANSCRIPTION_TIMEOUT: "A transcrição excedeu o tempo limite.",
};

export interface TranscriptionError {
  code: TranscriptionErrorCode;
  message: string;
}

export interface TranscriptionResult {
  words: Word[];
  language: string;
  languageProbability: number | null;
  device: "cuda" | "cpu";
}

export interface StartTranscriptionRequest {
  observerId: string;
  path: string;
  language: TranscriptionLanguage;
}

export interface StartTranscriptionResponse {
  jobId: string;
}

export interface TranscriptionErrorResponse {
  error: TranscriptionError;
}

export type TranscriptionWarning = {
  code: "TRANSCRIPTION_GPU_FALLBACK";
  message: "GPU indisponível; continuando na CPU.";
};

export type TranscriptionStatus =
  | {
      jobId: string;
      state: "queued" | "running";
      phase: TranscriptionPhase;
      progress: number | null;
      device: "cuda" | "cpu" | null;
      warning: TranscriptionWarning | null;
      result: null;
      error: null;
    }
  | {
      jobId: string;
      state: "completed";
      phase: "finalizing";
      progress: 1;
      device: "cuda" | "cpu";
      warning: TranscriptionWarning | null;
      result: TranscriptionResult;
      error: null;
    }
  | {
      jobId: string;
      state: "failed" | "cancelled";
      phase: TranscriptionPhase;
      progress: number | null;
      device: "cuda" | "cpu" | null;
      warning: TranscriptionWarning | null;
      result: null;
      error: TranscriptionError;
    };

const PHASES = new Set<TranscriptionPhase>([
  "preparing",
  "extracting-audio",
  "downloading-model",
  "transcribing",
  "finalizing",
]);
const DEVICES = new Set(["cuda", "cpu"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label}: unknown field \`${unknown}\``);
  const missing = expected.find((key) => !(key in value));
  if (missing) throw new Error(`${label}: missing \`${missing}\``);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${label}: invalid UUID`);
  }
  return value;
}

function phase(value: unknown): TranscriptionPhase {
  if (typeof value !== "string" || !PHASES.has(value as TranscriptionPhase)) {
    throw new Error("transcription status: invalid phase");
  }
  return value as TranscriptionPhase;
}

function progress(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error("transcription status: invalid progress");
  }
  return value;
}

function device(value: unknown, nullable: boolean): "cuda" | "cpu" | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !DEVICES.has(value)) {
    throw new Error("transcription status: invalid device");
  }
  return value as "cuda" | "cpu";
}

function warning(value: unknown): TranscriptionWarning | null {
  if (value === null) return null;
  const input = object(value, "transcription warning");
  keys(input, ["code", "message"], "transcription warning");
  if (
    input.code !== "TRANSCRIPTION_GPU_FALLBACK" ||
    input.message !== "GPU indisponível; continuando na CPU."
  ) {
    throw new Error("transcription warning: invalid code or message");
  }
  return input as unknown as TranscriptionWarning;
}

function transcriptionError(value: unknown): TranscriptionError {
  const input = object(value, "transcription error");
  keys(input, ["code", "message"], "transcription error");
  if (
    typeof input.code !== "string" ||
    !ERROR_CODES.includes(input.code as TranscriptionErrorCode)
  ) {
    throw new Error("transcription error: invalid code");
  }
  const code = input.code as TranscriptionErrorCode;
  if (input.message !== TRANSCRIPTION_ERROR_MESSAGES[code]) {
    throw new Error("transcription error: invalid message");
  }
  return { code, message: TRANSCRIPTION_ERROR_MESSAGES[code] };
}

function encodedSize(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("transcription result: invalid JSON value");
  }
  return new TextEncoder().encode(json).byteLength;
}

export function parseStartTranscriptionRequest(
  value: unknown
): StartTranscriptionRequest {
  const input = object(value, "transcription request");
  keys(input, ["observerId", "path", "language"], "transcription request");
  const observerId = uuid(input.observerId, "observerId");
  if (typeof input.path !== "string" || !input.path.trim()) {
    throw new Error("transcription request: invalid path");
  }
  if (input.language !== "pt" && input.language !== "auto") {
    throw new Error("transcription request: invalid language");
  }
  return { observerId, path: input.path, language: input.language };
}

export function parseStartTranscriptionResponse(
  value: unknown
): StartTranscriptionResponse {
  const input = object(value, "transcription start response");
  keys(input, ["jobId"], "transcription start response");
  return { jobId: uuid(input.jobId, "jobId") };
}

export function parseTranscriptionResult(value: unknown): TranscriptionResult {
  if (encodedSize(value) > MAX_TRANSCRIPTION_RESULT_BYTES) {
    throw new Error("transcription result exceeds 16 MiB");
  }
  const input = object(value, "transcription result");
  keys(
    input,
    ["words", "language", "languageProbability", "device"],
    "transcription result"
  );
  if (!Array.isArray(input.words) || input.words.length > MAX_TRANSCRIPTION_WORDS) {
    throw new Error("transcription result exceeds 100000 words");
  }
  const parsedWords = normalizeTranscriptWords(input.words, { allowEmpty: true });
  if (typeof input.language !== "string" || !input.language.trim()) {
    throw new Error("transcription result: invalid language");
  }
  const probability = input.languageProbability;
  if (
    probability !== null &&
    (typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1)
  ) {
    throw new Error("transcription result: invalid language probability");
  }
  return {
    words: parsedWords,
    language: input.language,
    languageProbability: probability as number | null,
    device: device(input.device, false)!,
  };
}

export function parseTranscriptionStatus(value: unknown): TranscriptionStatus {
  const input = object(value, "transcription status");
  keys(
    input,
    ["jobId", "state", "phase", "progress", "device", "warning", "result", "error"],
    "transcription status"
  );
  const jobId = uuid(input.jobId, "jobId");
  const parsedWarning = warning(input.warning);

  if (input.state === "queued" || input.state === "running") {
    if (input.result !== null || input.error !== null) {
      throw new Error("transcription status: active result and error must be null");
    }
    return {
      jobId,
      state: input.state,
      phase: phase(input.phase),
      progress: progress(input.progress),
      device: device(input.device, true),
      warning: parsedWarning,
      result: null,
      error: null,
    };
  }

  if (input.state === "completed") {
    if (input.phase !== "finalizing" || input.progress !== 1 || input.error !== null) {
      throw new Error("transcription status: invalid completed fields");
    }
    const parsedDevice = device(input.device, false)!;
    const result = parseTranscriptionResult(input.result);
    if (result.device !== parsedDevice) {
      throw new Error("transcription status: result device mismatch");
    }
    return {
      jobId,
      state: "completed",
      phase: "finalizing",
      progress: 1,
      device: parsedDevice,
      warning: parsedWarning,
      result,
      error: null,
    };
  }

  if (input.state === "failed" || input.state === "cancelled") {
    if (input.result !== null) {
      throw new Error("transcription status: failed result must be null");
    }
    const error = transcriptionError(input.error);
    if (
      (input.state === "cancelled") !==
      (error.code === "TRANSCRIPTION_CANCELLED")
    ) {
      throw new Error("transcription status: error does not match state");
    }
    return {
      jobId,
      state: input.state,
      phase: phase(input.phase),
      progress: progress(input.progress),
      device: device(input.device, true),
      warning: parsedWarning,
      result: null,
      error,
    };
  }

  throw new Error("transcription status: invalid state");
}

const HTTP_ERROR_CODES: Readonly<Record<number, readonly TranscriptionErrorCode[]>> = {
  400: [
    "TRANSCRIPTION_INVALID_REQUEST",
    "TRANSCRIPTION_SOURCE_INVALID",
    "TRANSCRIPTION_SOURCE_TOO_LONG",
    "TRANSCRIPTION_AUDIO_MISSING",
  ],
  404: ["TRANSCRIPTION_NOT_FOUND"],
  409: ["TRANSCRIPTION_OBSERVER_CONFLICT", "TRANSCRIPTION_SOURCE_CHANGED"],
  413: ["TRANSCRIPTION_PAYLOAD_TOO_LARGE"],
  429: ["TRANSCRIPTION_BUSY"],
  500: [
    "TRANSCRIPTION_AUDIO_EXTRACTION_FAILED",
    "TRANSCRIPTION_ENGINE_FAILED",
    "TRANSCRIPTION_INVALID_OUTPUT",
  ],
  503: ["TRANSCRIPTION_ENGINE_UNAVAILABLE", "TRANSCRIPTION_MODEL_DOWNLOAD_FAILED"],
  504: [
    "TRANSCRIPTION_PREPARATION_TIMEOUT",
    "TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT",
    "TRANSCRIPTION_SETUP_TIMEOUT",
    "TRANSCRIPTION_TIMEOUT",
  ],
};

export function parseTranscriptionErrorResponse(
  value: unknown,
  status: number
): TranscriptionErrorResponse {
  const allowed = HTTP_ERROR_CODES[status];
  if (!allowed) throw new Error("transcription error response: unsupported HTTP status");
  const input = object(value, "transcription error response");
  keys(input, ["error"], "transcription error response");
  const error = transcriptionError(input.error);
  if (!allowed.includes(error.code)) {
    throw new Error("transcription error response: code does not match HTTP status");
  }
  return { error };
}
