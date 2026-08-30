import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_TRANSCRIPTION_RESULT_BYTES,
  parseTranscriptionResult,
  type StartTranscriptionRequest,
  type TranscriptionErrorCode,
  type TranscriptionLanguage,
  type TranscriptionResult,
} from "./transcription-contract";
import { normalizeTranscriptWords } from "./transcript-ingest";
import { resolveImportedOriginalVideoPath } from "./media-paths.server";

export const TRANSCRIPTION_MODEL_ID = "Systran/faster-whisper-small";
export const TRANSCRIPTION_MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120";
export const TRANSCRIPTION_ENGINE_SCHEMA = "repurpose-transcription-v1";
export const TRANSCRIPTION_DECODING_SETTINGS = Object.freeze({
  beamSize: 5,
  wordTimestamps: true,
});

export class TranscriptionServerError extends Error {
  constructor(public readonly code: TranscriptionErrorCode) {
    super(code);
    this.name = "TranscriptionServerError";
  }
}

export interface PreparedTranscriptionRequest {
  sourcePath: string;
  expectedSourceHash: string;
  language: TranscriptionLanguage;
  admissionKey: string;
  cacheKey: string;
}

interface CachePathOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
}

export function resolveTranscriptionCachePaths(options: CachePathOptions = {}): {
  models: string;
  transcripts: string;
} {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let root: string;
  if (platform === "win32") {
    root = env.LOCALAPPDATA
      ? pathApi.join(env.LOCALAPPDATA, "Repurpose Studio")
      : pathApi.join(homeDir, "AppData", "Local", "Repurpose Studio");
  } else if (env.XDG_CACHE_HOME) {
    root = pathApi.join(env.XDG_CACHE_HOME, "repurpose-studio");
  } else if (platform === "darwin") {
    root = pathApi.join(homeDir, "Library", "Caches", "Repurpose Studio");
  } else {
    root = pathApi.join(homeDir, ".cache", "repurpose-studio");
  }
  return {
    models: pathApi.join(root, "models"),
    transcripts: pathApi.join(root, "transcripts"),
  };
}

interface CacheKeyInput {
  sourceHash: string;
  language: TranscriptionLanguage;
  modelId?: string;
  modelRevision?: string;
  engineSchema?: string;
  decodingSettings?: Readonly<Record<string, unknown>>;
}

export function deriveTranscriptionCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sourceHash: input.sourceHash,
      language: input.language,
      modelId: input.modelId ?? TRANSCRIPTION_MODEL_ID,
      modelRevision: input.modelRevision ?? TRANSCRIPTION_MODEL_REVISION,
      engineSchema: input.engineSchema ?? TRANSCRIPTION_ENGINE_SCHEMA,
      decodingSettings: input.decodingSettings ?? TRANSCRIPTION_DECODING_SETTINGS,
    }))
    .digest("hex");
}

function cancelled(): TranscriptionServerError {
  return new TranscriptionServerError("TRANSCRIPTION_CANCELLED");
}

export async function prepareTranscriptionRequest(
  request: StartTranscriptionRequest,
  signal: AbortSignal,
  options: {
    resolvePath?: (rawPath: string) => Promise<string | null>;
  } = {},
): Promise<PreparedTranscriptionRequest> {
  if (signal.aborted) throw cancelled();
  const sourcePath = await (options.resolvePath ?? resolveImportedOriginalVideoPath)(request.path);
  if (signal.aborted) throw cancelled();
  if (!sourcePath) throw new TranscriptionServerError("TRANSCRIPTION_SOURCE_INVALID");
  const match = /^([a-f0-9]{64})\.(?:mp4|mov|m4v|webm|mkv)$/i.exec(path.basename(sourcePath));
  if (!match || match[1] !== match[1].toLowerCase()) {
    throw new TranscriptionServerError("TRANSCRIPTION_SOURCE_INVALID");
  }
  const expectedSourceHash = match[1];
  const cacheKey = deriveTranscriptionCacheKey({
    sourceHash: expectedSourceHash,
    language: request.language,
  });
  const admissionKey = createHash("sha256")
    .update(JSON.stringify({ sourcePath, cacheKey }))
    .digest("hex");
  return {
    sourcePath,
    expectedSourceHash,
    language: request.language,
    admissionKey,
    cacheKey,
  };
}

export interface TranscriptionCache {
  get(key: string, durationSec: number): Promise<TranscriptionResult | null>;
  publish(key: string, result: TranscriptionResult): Promise<void>;
}

function cacheFile(directory: string, key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new TranscriptionServerError("TRANSCRIPTION_INVALID_OUTPUT");
  }
  return path.join(directory, `${key}.json`);
}

export function createTranscriptionCache(options: {
  directory?: string;
} = {}): TranscriptionCache {
  const directory = options.directory ?? resolveTranscriptionCachePaths().transcripts;
  return {
    async get(key, durationSec) {
      const target = cacheFile(directory, key);
      let handle;
      try {
        handle = await open(target, "r");
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_TRANSCRIPTION_RESULT_BYTES) {
          throw new Error("invalid cache entry");
        }
        const contents = await handle.readFile();
        if (contents.byteLength > MAX_TRANSCRIPTION_RESULT_BYTES) {
          throw new Error("invalid cache entry");
        }
        const parsed = parseTranscriptionResult(JSON.parse(contents.toString("utf8")));
        return {
          ...parsed,
          words: normalizeTranscriptWords(parsed.words, { allowEmpty: true, durationSec }),
        };
      } catch {
        await rm(target, { force: true }).catch(() => undefined);
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    async publish(key, result) {
      const target = cacheFile(directory, key);
      const encoded = Buffer.from(JSON.stringify(parseTranscriptionResult(result)), "utf8");
      if (encoded.byteLength > MAX_TRANSCRIPTION_RESULT_BYTES) {
        throw new TranscriptionServerError("TRANSCRIPTION_INVALID_OUTPUT");
      }
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `.${key}.${randomUUID()}.partial`);
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(encoded);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new TranscriptionServerError("TRANSCRIPTION_INVALID_OUTPUT");
        }
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
}

export const transcriptionCache = createTranscriptionCache();
