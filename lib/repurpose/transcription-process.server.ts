import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createNodeProcessAdapter,
  parseFfmpegProgress,
  type ProcessAdapter,
} from "./ffmpeg-process.server";
import { inspectMedia } from "./media-inspection.server";
import {
  createTranscriptionCache,
  resolveTranscriptionCachePaths,
  TranscriptionServerError,
  type PreparedTranscriptionRequest,
  type TranscriptionCache,
} from "./transcription-cache.server";
import {
  MAX_TRANSCRIPTION_RESULT_BYTES,
  parseTranscriptionResult,
  type TranscriptionErrorCode,
  type TranscriptionPhase,
  type TranscriptionResult,
  type TranscriptionWarning,
} from "./transcription-contract";
import { normalizeTranscriptWords } from "./transcript-ingest";

const MAX_SOURCE_DURATION_SEC = 2 * 60 * 60;
const MAX_ENGINE_LINE_BYTES = 64 * 1024;

export class TranscriptionProcessError extends TranscriptionServerError {
  constructor(code: TranscriptionErrorCode) {
    super(code);
    this.name = "TranscriptionProcessError";
  }
}

export interface Report {
  phase?: TranscriptionPhase;
  progress?: number | null;
  device?: "cuda" | "cpu" | null;
  warning?: TranscriptionWarning;
}

export function buildTranscriptionAudioArguments(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    "-progress", "pipe:1",
    "-nostats",
    outputPath,
  ];
}

export function transcriptionDeadlines(durationSec: number): {
  preparationMs: number;
  extractionMs: number;
  setupMs: number;
  transcriptionMs: number;
} {
  return {
    preparationMs: 30 * 60 * 1000,
    extractionMs: Math.min(60 * 60, Math.max(10 * 60, durationSec * 0.5)) * 1000,
    setupMs: 30 * 60 * 1000,
    transcriptionMs: Math.min(8 * 60 * 60, Math.max(30 * 60, durationSec * 4)) * 1000,
  };
}

type EngineTerminal = {
  terminal: "completed" | "error";
  device: "cuda" | "cpu" | null;
  engineError: "INVALID_INPUT" | "MODEL_DOWNLOAD_FAILED" | "ENGINE_FAILED" | null;
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function invalidOutput(): TranscriptionProcessError {
  return new TranscriptionProcessError("TRANSCRIPTION_INVALID_OUTPUT");
}

function createEngineProtocolParser(
  report: (value: Report) => void,
  onModelReady: () => void = () => undefined,
) {
  let state: "start" | "model" | "cuda" | "fallback" | "cpu" | "terminal" = "start";
  let latestDevice: "cuda" | "cpu" | null = null;
  const progress = new Map<"cuda" | "cpu", number>();
  let terminal: EngineTerminal | null = null;
  let buffer = "";

  const parseLine = (line: string) => {
    if (Buffer.byteLength(line, "utf8") > MAX_ENGINE_LINE_BYTES || !line) throw invalidOutput();
    let event: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidOutput();
      event = value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof TranscriptionProcessError) throw error;
      throw invalidOutput();
    }
    if (state === "terminal" || typeof event.type !== "string") throw invalidOutput();

    if (event.type === "phase") {
      if (!exactKeys(event, ["type", "phase"]) || event.phase !== "downloading-model" || state !== "start") {
        throw invalidOutput();
      }
      state = "model";
      report({ phase: "downloading-model", progress: null, device: null });
      return;
    }
    if (event.type === "warning") {
      if (!exactKeys(event, ["type", "code"]) || event.code !== "GPU_FALLBACK" || (state !== "model" && state !== "cuda")) {
        throw invalidOutput();
      }
      state = "fallback";
      report({ warning: { code: "TRANSCRIPTION_GPU_FALLBACK", message: "GPU indisponível; continuando na CPU." } });
      return;
    }
    if (event.type === "model-ready") {
      if (!exactKeys(event, ["type", "device"]) || (event.device !== "cuda" && event.device !== "cpu")) {
        throw invalidOutput();
      }
      const device = event.device;
      if (!((state === "model") || (state === "fallback" && device === "cpu"))) throw invalidOutput();
      state = device;
      latestDevice = device;
      onModelReady();
      report({ phase: "transcribing", progress: 0, device });
      return;
    }
    if (event.type === "progress") {
      if (
        !exactKeys(event, ["type", "phase", "device", "progress"])
        || event.phase !== "transcribing"
        || (event.device !== "cuda" && event.device !== "cpu")
        || typeof event.progress !== "number"
        || !Number.isFinite(event.progress)
        || event.progress < 0
        || event.progress > 1
        || state !== event.device
        || latestDevice !== event.device
        || event.progress < (progress.get(event.device) ?? 0)
      ) {
        throw invalidOutput();
      }
      progress.set(event.device, event.progress);
      report({ phase: "transcribing", device: event.device, progress: event.progress });
      return;
    }
    if (event.type === "completed") {
      if (
        !exactKeys(event, ["type", "device"])
        || (event.device !== "cuda" && event.device !== "cpu")
        || state !== event.device
        || latestDevice !== event.device
      ) {
        throw invalidOutput();
      }
      state = "terminal";
      terminal = { terminal: "completed", device: event.device, engineError: null };
      return;
    }
    if (event.type === "error") {
      if (
        !exactKeys(event, ["type", "code"])
        || (event.code !== "INVALID_INPUT" && event.code !== "MODEL_DOWNLOAD_FAILED" && event.code !== "ENGINE_FAILED")
      ) {
        throw invalidOutput();
      }
      const legal = (state === "start" && event.code === "INVALID_INPUT")
        || (state === "model" && (event.code === "MODEL_DOWNLOAD_FAILED" || event.code === "ENGINE_FAILED"))
        || ((state === "cuda" || state === "cpu" || state === "fallback") && event.code === "ENGINE_FAILED");
      if (!legal) throw invalidOutput();
      state = "terminal";
      terminal = { terminal: "error", device: latestDevice, engineError: event.code };
      return;
    }
    throw invalidOutput();
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_ENGINE_LINE_BYTES && !buffer.includes("\n")) {
        throw invalidOutput();
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        parseLine(line);
        newline = buffer.indexOf("\n");
      }
    },
    finish(): EngineTerminal {
      if (buffer) {
        parseLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
      if (!terminal) throw invalidOutput();
      return terminal;
    },
  };
}

export function parseEngineEventStream(
  lines: readonly string[],
  report: (value: Report) => void,
): EngineTerminal {
  const parser = createEngineProtocolParser(report);
  for (const line of lines) parser.push(`${line}\n`);
  return parser.finish();
}

interface FileIdentity {
  realPath: string;
  size: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  birthtimeNs: bigint;
}

async function captureIdentity(sourcePath: string): Promise<FileIdentity> {
  const realPath = await realpath(sourcePath);
  const metadata = await stat(realPath, { bigint: true });
  if (!metadata.isFile()) throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_CHANGED");
  return {
    realPath,
    size: metadata.size,
    dev: metadata.dev,
    ino: metadata.ino,
    mtimeNs: metadata.mtimeNs,
    birthtimeNs: metadata.birthtimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.realPath === right.realPath
    && left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function identityFromOpen(realPath: string, metadata: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>): FileIdentity {
  return {
    realPath,
    size: BigInt(metadata.size),
    dev: BigInt(metadata.dev),
    ino: BigInt(metadata.ino),
    mtimeNs: "mtimeNs" in metadata ? BigInt(metadata.mtimeNs as bigint) : BigInt(Math.round(metadata.mtimeMs * 1_000_000)),
    birthtimeNs: "birthtimeNs" in metadata ? BigInt(metadata.birthtimeNs as bigint) : BigInt(Math.round(metadata.birthtimeMs * 1_000_000)),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
}

function preservePrimaryError(primary: unknown, secondary: unknown): unknown {
  if (primary instanceof Error) {
    primary.cause = primary.cause === undefined
      ? secondary
      : new AggregateError([primary.cause, secondary], "Multiple transcription cleanup failures");
  }
  return primary;
}

async function copyAndHashSource(
  sourcePath: string,
  snapshotPath: string,
  signal: AbortSignal,
): Promise<{ hash: string; identity: FileIdentity }> {
  const identity = await captureIdentity(sourcePath);
  const source = await open(identity.realPath, "r");
  let destination;
  try {
    const openedIdentity = identityFromOpen(identity.realPath, await source.stat({ bigint: true }));
    if (!sameIdentity(identity, openedIdentity)) {
      throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_CHANGED");
    }
    destination = await open(snapshotPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const write = await destination.write(chunk, written, bytesRead - written);
        written += write.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.sync();
    const after = await captureIdentity(sourcePath);
    if (!sameIdentity(identity, after)) {
      throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_CHANGED");
    }
    return { hash: hash.digest("hex"), identity };
  } catch (error) {
    if (error instanceof TranscriptionProcessError) throw error;
    throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_CHANGED");
  } finally {
    await source.close().catch(() => undefined);
    await destination?.close().catch(() => undefined);
  }
}

async function hashAndVerifyIdentity(
  sourcePath: string,
  expectedIdentity: FileIdentity,
  expectedHash: string,
  signal: AbortSignal,
): Promise<void> {
  const before = await captureIdentity(sourcePath).catch(() => null);
  if (!before || !sameIdentity(expectedIdentity, before)) {
    throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_CHANGED");
  }
  const source = await open(before.realPath, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await captureIdentity(sourcePath).catch(() => null);
    if (!after || !sameIdentity(expectedIdentity, after) || hash.digest("hex") !== expectedHash) {
      throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_CHANGED");
    }
  } finally {
    await source.close().catch(() => undefined);
  }
}

async function controlled<T>(input: {
  parentSignal: AbortSignal;
  timeoutMs: number;
  timeoutCode: TranscriptionErrorCode;
  work(signal: AbortSignal): Promise<T>;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}): Promise<T> {
  throwIfAborted(input.parentSignal);
  const controller = new AbortController();
  let timedOut = false;
  let controlError: TranscriptionProcessError | undefined;
  let rejectControl!: (error: unknown) => void;
  const control = new Promise<never>((_resolve, reject) => {
    rejectControl = reject;
  });
  const abort = () => {
    controller.abort();
    controlError ??= new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
    rejectControl(controlError);
  };
  input.parentSignal.addEventListener("abort", abort, { once: true });
  const timer = input.setTimer(() => {
    timedOut = true;
    controller.abort();
    controlError ??= new TranscriptionProcessError(input.timeoutCode);
    rejectControl(controlError);
  }, input.timeoutMs);
  const work = Promise.resolve().then(() => input.work(controller.signal));
  try {
    return await Promise.race([work, control]);
  } catch (error) {
    const primary = timedOut
      ? controlError ?? new TranscriptionProcessError(input.timeoutCode)
      : input.parentSignal.aborted
        ? controlError ?? new TranscriptionProcessError("TRANSCRIPTION_CANCELLED")
        : error;
    if (controller.signal.aborted) {
      try {
        await work;
      } catch (workError) {
        if (workError !== primary) preservePrimaryError(primary, workError);
      }
    }
    throw primary;
  } finally {
    input.clearTimer(timer);
    input.parentSignal.removeEventListener("abort", abort);
  }
}

interface Inspection {
  durationSec: number;
  audio: unknown | null;
}

interface ExtractRequest {
  inputPath: string;
  outputPath: string;
  durationSec: number;
  signal: AbortSignal;
  onProgress(progress: number): void;
}

interface EngineRequest {
  inputPath: string;
  outputPath: string;
  modelCache: string;
  language: "pt" | "auto";
  preferredDevice: "cuda" | "cpu";
  signal: AbortSignal;
  report(chunk: string): void;
}

function defaultExtractor(adapter: ProcessAdapter, ffmpegPath = "ffmpeg") {
  return async (request: ExtractRequest): Promise<void> => {
    let progressBuffer = "";
    let child;
    try {
      child = adapter.run(ffmpegPath, buildTranscriptionAudioArguments(request.inputPath, request.outputPath), {
        onStdout(chunk) {
          progressBuffer = `${progressBuffer}${chunk}`.slice(-2_048);
          const progress = parseFfmpegProgress(progressBuffer, request.durationSec);
          if (progress !== null) request.onProgress(progress);
        },
      });
    } catch {
      throw new TranscriptionProcessError("TRANSCRIPTION_AUDIO_EXTRACTION_FAILED");
    }
    const abort = () => child.kill();
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const completed = await child.completion;
      if (request.signal.aborted) throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
      if (completed.code !== 0) throw new TranscriptionProcessError("TRANSCRIPTION_AUDIO_EXTRACTION_FAILED");
    } catch (error) {
      if (error instanceof TranscriptionProcessError) throw error;
      if (request.signal.aborted) throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
      throw new TranscriptionProcessError("TRANSCRIPTION_AUDIO_EXTRACTION_FAILED");
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  };
}

function defaultEngineRunner(adapter: ProcessAdapter, engineDirectory: string) {
  return async (request: EngineRequest): Promise<{ code: number; stderr: string }> => {
    await mkdir(request.modelCache, { recursive: true });
    const script = path.join(engineDirectory, "transcribe.py");
    let child;
    try {
      child = adapter.run("uv", [
        "run", "--frozen", "--project", engineDirectory,
        "python", script,
        "--input-wav", request.inputPath,
        "--output", request.outputPath,
        "--model-cache", request.modelCache,
        "--language", request.language,
        "--preferred-device", request.preferredDevice,
      ], { onStdout: request.report });
    } catch {
      throw new TranscriptionProcessError("TRANSCRIPTION_ENGINE_UNAVAILABLE");
    }
    const abort = () => child.kill();
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const completed = await child.completion;
      if (request.signal.aborted) throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
      return { code: completed.code, stderr: completed.stderr };
    } catch (error) {
      if (error instanceof TranscriptionProcessError) throw error;
      if (request.signal.aborted) throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TranscriptionProcessError("TRANSCRIPTION_ENGINE_UNAVAILABLE");
      }
      throw new TranscriptionProcessError("TRANSCRIPTION_ENGINE_FAILED");
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  };
}

export function createTranscriptionProcessor(deps: {
  cache?: TranscriptionCache;
  inspect?: (snapshotPath: string, signal: AbortSignal) => Promise<Inspection>;
  extract?: (request: ExtractRequest) => Promise<void>;
  runEngine?: (request: EngineRequest) => Promise<{ code: number; stderr: string }>;
  temporaryRoot?: string;
  modelCache?: string;
  engineDirectory?: string;
  processAdapter?: ProcessAdapter;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onSourceHashed?: () => void;
} = {}) {
  const paths = resolveTranscriptionCachePaths();
  const adapter = deps.processAdapter ?? createNodeProcessAdapter();
  const cache = deps.cache ?? createTranscriptionCache({ directory: paths.transcripts });
  const inspect = deps.inspect ?? ((snapshotPath: string, signal: AbortSignal) => inspectMedia(snapshotPath, { signal }));
  const extract = deps.extract ?? defaultExtractor(adapter);
  const engineDirectory = deps.engineDirectory ?? path.join(process.cwd(), "scripts", "transcription-engine");
  const runEngine = deps.runEngine ?? defaultEngineRunner(adapter, engineDirectory);
  const temporaryRoot = deps.temporaryRoot ?? os.tmpdir();
  const modelCache = deps.modelCache ?? paths.models;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  return {
    async run(
      request: PreparedTranscriptionRequest,
      signal: AbortSignal,
      report: (value: Report) => void,
    ): Promise<TranscriptionResult> {
      throwIfAborted(signal);
      await mkdir(temporaryRoot, { recursive: true });
      const workspace = await mkdtemp(path.join(temporaryRoot, "transcription-"));
      const snapshotPath = path.join(workspace, `source${path.extname(request.sourcePath).toLowerCase()}`);
      const audioPath = path.join(workspace, "audio.wav");
      const resultPath = path.join(workspace, "result.partial.json");
      let primaryError: unknown;
      try {
        report({ phase: "preparing", progress: null, device: null });
        const prepared = await controlled({
          parentSignal: signal,
          timeoutMs: transcriptionDeadlines(0).preparationMs,
          timeoutCode: "TRANSCRIPTION_PREPARATION_TIMEOUT",
          setTimer,
          clearTimer,
          work: async (phaseSignal) => {
            const verified = await copyAndHashSource(request.sourcePath, snapshotPath, phaseSignal);
            deps.onSourceHashed?.();
            if (verified.hash !== request.expectedSourceHash) {
              throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_CHANGED");
            }
            let inspection: Inspection;
            try {
              inspection = await inspect(snapshotPath, phaseSignal);
            } catch (error) {
              if (error instanceof TranscriptionServerError) throw error;
              if (phaseSignal.aborted) throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
              throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_INVALID");
            }
            throwIfAborted(phaseSignal);
            if (!Number.isFinite(inspection.durationSec) || inspection.durationSec <= 0) {
              throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_INVALID");
            }
            if (inspection.durationSec > MAX_SOURCE_DURATION_SEC) {
              throw new TranscriptionProcessError("TRANSCRIPTION_SOURCE_TOO_LONG");
            }
            if (!inspection.audio) {
              throw new TranscriptionProcessError("TRANSCRIPTION_AUDIO_MISSING");
            }
            const cached = await cache.get(request.cacheKey, inspection.durationSec);
            return { ...verified, inspection, cached };
          },
        });
        if (prepared.cached) return prepared.cached;

        const deadlines = transcriptionDeadlines(prepared.inspection.durationSec);
        report({ phase: "extracting-audio", progress: 0, device: null });
        await controlled({
          parentSignal: signal,
          timeoutMs: deadlines.extractionMs,
          timeoutCode: "TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT",
          setTimer,
          clearTimer,
          work: (phaseSignal) => extract({
            inputPath: snapshotPath,
            outputPath: audioPath,
            durationSec: prepared.inspection.durationSec,
            signal: phaseSignal,
            onProgress: (progress) => report({ phase: "extracting-audio", progress, device: null }),
          }),
        });

        const engineController = new AbortController();
        let timeoutCode: TranscriptionErrorCode = "TRANSCRIPTION_SETUP_TIMEOUT";
        let controlError: TranscriptionProcessError | undefined;
        let timer: ReturnType<typeof setTimeout>;
        let rejectControl!: (error: unknown) => void;
        const control = new Promise<never>((_resolve, reject) => { rejectControl = reject; });
        const schedule = (milliseconds: number) => {
          timer = setTimer(() => {
            engineController.abort();
            controlError ??= new TranscriptionProcessError(timeoutCode);
            rejectControl(controlError);
          }, milliseconds);
        };
        const abort = () => {
          engineController.abort();
          controlError ??= new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
          rejectControl(controlError);
        };
        signal.addEventListener("abort", abort, { once: true });
        schedule(deadlines.setupMs);
        const parser = createEngineProtocolParser(report, () => {
          clearTimer(timer);
          timeoutCode = "TRANSCRIPTION_TIMEOUT";
          schedule(deadlines.transcriptionMs);
        });
        let engineResult: { code: number; stderr: string };
        const engineWork = Promise.resolve().then(() => runEngine({
          inputPath: audioPath,
          outputPath: resultPath,
          modelCache,
          language: request.language,
          preferredDevice: "cuda",
          signal: engineController.signal,
          report: (chunk) => parser.push(chunk),
        }));
        try {
          try {
            engineResult = await Promise.race([engineWork, control]);
          } catch (error) {
            const primary = signal.aborted
              ? controlError ?? new TranscriptionProcessError("TRANSCRIPTION_CANCELLED")
              : controlError ?? error;
            if (engineController.signal.aborted) {
              try {
                await engineWork;
              } catch (workError) {
                if (workError !== primary) preservePrimaryError(primary, workError);
              }
            }
            throw primary;
          }
        } finally {
          clearTimer(timer!);
          signal.removeEventListener("abort", abort);
        }
        if (signal.aborted) throw new TranscriptionProcessError("TRANSCRIPTION_CANCELLED");
        const terminal = parser.finish();
        if (terminal.terminal === "error") {
          const code = terminal.engineError === "MODEL_DOWNLOAD_FAILED"
            ? "TRANSCRIPTION_MODEL_DOWNLOAD_FAILED"
            : terminal.engineError === "INVALID_INPUT"
              ? "TRANSCRIPTION_ENGINE_FAILED"
              : "TRANSCRIPTION_ENGINE_FAILED";
          throw new TranscriptionProcessError(code);
        }
        if (engineResult.code !== 0) throw new TranscriptionProcessError("TRANSCRIPTION_ENGINE_FAILED");

        let handle;
        let result: TranscriptionResult;
        try {
          handle = await open(resultPath, "r");
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.size > MAX_TRANSCRIPTION_RESULT_BYTES) throw invalidOutput();
          const encoded = await handle.readFile();
          if (encoded.byteLength > MAX_TRANSCRIPTION_RESULT_BYTES) throw invalidOutput();
          result = parseTranscriptionResult(JSON.parse(encoded.toString("utf8")));
          result = {
            ...result,
            words: normalizeTranscriptWords(result.words, {
              allowEmpty: true,
              durationSec: prepared.inspection.durationSec,
            }),
          };
        } catch (error) {
          if (error instanceof TranscriptionProcessError) throw error;
          throw invalidOutput();
        } finally {
          await handle?.close().catch(() => undefined);
        }
        if (result.device !== terminal.device) throw invalidOutput();

        report({ phase: "finalizing", progress: null, device: result.device });
        await hashAndVerifyIdentity(
          request.sourcePath,
          prepared.identity,
          request.expectedSourceHash,
          signal,
        );
        await cache.publish(request.cacheKey, result);
        report({ phase: "finalizing", progress: 1, device: result.device });
        return result;
      } catch (error) {
        primaryError = error instanceof TranscriptionServerError
          ? error
          : signal.aborted
            ? new TranscriptionProcessError("TRANSCRIPTION_CANCELLED")
            : new TranscriptionProcessError("TRANSCRIPTION_ENGINE_FAILED");
        throw primaryError;
      } finally {
        try {
          await rm(workspace, { recursive: true, force: true });
        } catch (cleanupError) {
          if (primaryError) preservePrimaryError(primaryError, cleanupError);
          else {
            const cleanupFailure = new TranscriptionProcessError("TRANSCRIPTION_ENGINE_FAILED");
            preservePrimaryError(cleanupFailure, cleanupError);
            throw cleanupFailure;
          }
        }
      }
    },
  };
}

export const transcriptionProcessor = createTranscriptionProcessor();
