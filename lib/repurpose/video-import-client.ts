import { footageUrlForPath } from "./ingest";
import { probeBrowserVideo } from "./native-media-probe";
import type {
  BrowserMediaProbe,
  CompatibilityState,
  MediaInspection,
  UploadedVideo,
  VideoRole,
} from "./media-types";
import type {
  VideoImportPhase,
  VideoSourceRecord,
} from "./types";

export interface ImportVideoOptions {
  role: VideoRole;
  signal: AbortSignal;
  onProgress: (state: {
    phase: VideoImportPhase;
    progress: number | null;
    codec?: string;
  }) => void;
}

export interface VideoImportClientDependencies {
  fetch: typeof globalThis.fetch;
  createXhr: () => XMLHttpRequest;
  probeBrowserVideo: (
    src: string,
    signal?: AbortSignal
  ) => Promise<BrowserMediaProbe>;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  visibilityState: () => DocumentVisibilityState;
  logError: (message: string, error: unknown) => void;
}

type ProgressState = Parameters<ImportVideoOptions["onProgress"]>[0];

const CANCELLATION_CLEANUP_TIMEOUT_MS = 1_000;

const PORTUGUESE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UPLOAD_FAILED: "Não foi possível copiar o vídeo.",
  MEDIA_PATH_INVALID: "Não foi possível acessar o vídeo.",
  MEDIA_INSPECTION_FAILED: "Não foi possível inspecionar o vídeo.",
  FFPROBE_UNAVAILABLE: "A inspeção de vídeo não está disponível.",
  MEDIA_PROBE_TIMEOUT: "A inspeção do vídeo demorou demais.",
  MEDIA_CHANGED: "O vídeo mudou durante a importação. Tente novamente.",
  MEDIA_INVALID: "O arquivo não é um vídeo válido.",
  COMPATIBILITY_FINGERPRINT_INVALID: "Não foi possível identificar o vídeo.",
  COMPATIBILITY_INPUT_INVALID: "Não foi possível acessar o vídeo.",
  COMPATIBILITY_CACHE_BUSY:
    "A conversão está ocupada. Reinicie o servidor e tente novamente.",
  COMPATIBILITY_START_FAILED: "Não foi possível iniciar a conversão.",
  COMPATIBILITY_ENCODE_FAILED: "Não foi possível converter o vídeo.",
  COMPATIBILITY_VALIDATION_FAILED:
    "O vídeo convertido não passou na validação.",
  COMPATIBILITY_CACHE_ERROR: "Não foi possível acessar o vídeo convertido.",
  COMPATIBILITY_LOCK_LOST: "A conversão foi interrompida. Tente novamente.",
  FFMPEG_UNAVAILABLE: "A conversão de vídeo não está disponível.",
  BROWSER_DECODE_FAILED:
    "O Chrome não conseguiu abrir o vídeo convertido.",
  VIDEO_SOURCE_RECONNECT_REQUIRED: "Reconecte o arquivo de vídeo original.",
  VIDEO_IMPORT_CANCELLED: "Importação cancelada.",
  COMPATIBILITY_CANCELLED: "Importação cancelada.",
  MEDIA_PROBE_ABORTED: "Importação cancelada.",
};

export function videoImportMessageForCode(code: string): string {
  return (
    PORTUGUESE_ERROR_MESSAGES[code] ?? "Não foi possível importar o vídeo."
  );
}

export class VideoImportError extends Error {
  readonly name = "VideoImportError";

  constructor(
    public readonly code: string,
    public readonly detail?: unknown
  ) {
    super(videoImportMessageForCode(code));
  }
}

function abortError(): VideoImportError {
  return new VideoImportError("VIDEO_IMPORT_CANCELLED");
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(abortError());
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function resolveDependencies(
  overrides: Partial<VideoImportClientDependencies>
): VideoImportClientDependencies {
  return {
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    createXhr:
      overrides.createXhr ?? (() => new globalThis.XMLHttpRequest()),
    probeBrowserVideo: overrides.probeBrowserVideo ?? probeBrowserVideo,
    wait: overrides.wait ?? defaultWait,
    visibilityState:
      overrides.visibilityState ??
      (() =>
        typeof document === "undefined" ? "visible" : document.visibilityState),
    logError:
      overrides.logError ??
      ((message, error) => {
        console.error(message, error);
      }),
  };
}

function createProgressReporter(onProgress: ImportVideoOptions["onProgress"]): (
  state: ProgressState
) => void {
  const numericByPhase = new Map<VideoImportPhase, number>();
  return (state) => {
    if (state.progress === null) {
      const previous = numericByPhase.get(state.phase);
      onProgress(previous === undefined ? state : { ...state, progress: previous });
      return;
    }
    const bounded = Math.min(1, Math.max(0, state.progress));
    const progress = Math.max(numericByPhase.get(state.phase) ?? 0, bounded);
    numericByPhase.set(state.phase, progress);
    onProgress({ ...state, progress });
  };
}

function responseBody(xhr: XMLHttpRequest): unknown {
  if (xhr.response && typeof xhr.response === "object") return xhr.response;
  if (!xhr.responseText) return null;
  try {
    return JSON.parse(xhr.responseText) as unknown;
  } catch {
    return null;
  }
}

function uploadVideo(
  file: File,
  role: VideoRole,
  signal: AbortSignal,
  report: (state: ProgressState) => void,
  createXhr: () => XMLHttpRequest
): Promise<UploadedVideo> {
  if (signal.aborted) return Promise.reject(abortError());
  report({ phase: "copying", progress: null });

  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      xhr.upload.onprogress = null;
      xhr.onload = null;
      xhr.onerror = null;
      xhr.onabort = null;
      action();
    };
    const cancel = () => {
      xhr.abort();
      finish(() => reject(abortError()));
    };

    xhr.upload.onprogress = (event) => {
      report({
        phase: "copying",
        progress:
          event.lengthComputable && event.total > 0
            ? event.loaded / event.total
            : null,
      });
    };
    xhr.onload = () => {
      finish(() => {
        const body = responseBody(xhr) as Partial<UploadedVideo> | null;
        if (
          xhr.status >= 200 &&
          xhr.status < 300 &&
          body &&
          typeof body.originalPath === "string" &&
          typeof body.contentHash === "string" &&
          typeof body.size === "number" &&
          typeof body.name === "string"
        ) {
          resolve(body as UploadedVideo);
          return;
        }
        reject(new VideoImportError("UPLOAD_FAILED", body));
      });
    };
    xhr.onerror = () =>
      finish(() => reject(new VideoImportError("UPLOAD_FAILED")));
    xhr.onabort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", cancel, { once: true });
    xhr.open(
      "POST",
      `/api/repurpose/footage?name=${encodeURIComponent(file.name)}&role=${encodeURIComponent(role)}`
    );
    xhr.responseType = "json";
    xhr.send(file);
  });
}

async function jsonFromResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown } } | null)?.error;
    const code =
      typeof error?.code === "string" ? error.code : "MEDIA_INSPECTION_FAILED";
    throw new VideoImportError(code, body);
  }
  return body as T;
}

async function inspectVideo(
  path: string,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch
): Promise<MediaInspection> {
  const response = await fetcher(
    `/api/repurpose/media?path=${encodeURIComponent(path)}`,
    { signal }
  );
  return jsonFromResponse<MediaInspection>(response);
}

function compatibilityFailure(state: CompatibilityState): VideoImportError {
  return new VideoImportError(
    state.error?.code ?? "COMPATIBILITY_ENCODE_FAILED",
    state.error
  );
}

function isCancelledCode(code: string): boolean {
  return (
    code === "VIDEO_IMPORT_CANCELLED" ||
    code === "COMPATIBILITY_CANCELLED" ||
    code === "MEDIA_PROBE_ABORTED"
  );
}

export async function cancelCompatibilityJob(
  fingerprint: string,
  fetcher: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)
): Promise<void> {
  const cancellation = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const cleanupRequest = fetcher("/api/repurpose/compatibility", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint }),
      signal: cancellation.signal,
    }).then(
      () => undefined,
      () => undefined
    );
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        cancellation.abort();
        resolve();
      }, CANCELLATION_CLEANUP_TIMEOUT_MS);
    });
    await Promise.race([cleanupRequest, deadline]);
  } catch {
    // The caller is already cancelling; cleanup is best-effort from the client.
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    cancellation.abort();
  }
}

export function createVideoImportClient(
  overrides: Partial<VideoImportClientDependencies> = {}
): {
  importVideoFile: (
    file: File,
    options: ImportVideoOptions
  ) => Promise<VideoSourceRecord>;
  reconcileVideoSource: (
    source: VideoSourceRecord,
    signal: AbortSignal
  ) => Promise<VideoSourceRecord>;
  reconcileVideoPreview: (
    source: VideoSourceRecord,
    signal: AbortSignal
  ) => Promise<VideoSourceRecord>;
} {
  const dependencies = resolveDependencies(overrides);

  const createCompatibilityMaster = async (
    originalPath: string,
    mediaInspection: MediaInspection,
    signal: AbortSignal,
    report: (state: ProgressState) => void
  ): Promise<string> => {
    const fingerprint = mediaInspection.fingerprint;
    let active = true;
    report({
      phase: "converting",
      progress: null,
      codec: mediaInspection.video.codec,
    });
    try {
      let state = await jsonFromResponse<CompatibilityState>(
        await dependencies.fetch("/api/repurpose/compatibility", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: originalPath, fingerprint }),
          signal,
        })
      );
      let polledAfterStart = false;

      while (state.status === "queued" || state.status === "building") {
        report({
          phase: "converting",
          progress: state.progress,
          codec: mediaInspection.video.codec,
        });
        const delay =
          dependencies.visibilityState() === "hidden" ? 2_000 : 750;
        await dependencies.wait(delay, signal);
        state = await jsonFromResponse<CompatibilityState>(
          await dependencies.fetch(
            `/api/repurpose/compatibility?fingerprint=${encodeURIComponent(fingerprint)}`,
            { signal }
          )
        );
        polledAfterStart = true;
      }

      active = false;
      if (state.status === "ready" && state.workingPath) {
        return state.workingPath;
      }
      if (state.status === "cancelled") throw abortError();
      if (state.status === "none") {
        throw new VideoImportError(
          polledAfterStart
            ? "COMPATIBILITY_LOCK_LOST"
            : "COMPATIBILITY_START_FAILED",
          state
        );
      }
      if (
        state.status === "failed" ||
        state.status === "unavailable"
      ) {
        throw compatibilityFailure(state);
      }
      throw new VideoImportError("COMPATIBILITY_ENCODE_FAILED", state);
    } catch (error) {
      if (signal.aborted && active) {
        await cancelCompatibilityJob(fingerprint, dependencies.fetch);
      }
      if (signal.aborted) throw abortError();
      throw error;
    }
  };

  const inspectIfPresent = async (
    path: string,
    signal: AbortSignal
  ): Promise<MediaInspection | null> => {
    try {
      return await inspectVideo(path, signal, dependencies.fetch);
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (
        error instanceof VideoImportError &&
        (error.code === "MEDIA_PATH_INVALID" || error.code === "MEDIA_INVALID")
      ) {
        return null;
      }
      throw error;
    }
  };

  const queuePreviewRebuild = (
    workingPath: string,
    signal: AbortSignal
  ): void => {
    if (signal.aborted) return;
    void dependencies
      .fetch(
        `/api/repurpose/proxy?path=${encodeURIComponent(workingPath)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: workingPath }),
          signal,
        }
      )
      .catch(() => undefined);
  };

  const previewIsReady = async (
    workingPath: string,
    signal: AbortSignal
  ): Promise<boolean> => {
    try {
      const response = await dependencies.fetch(
        `/api/repurpose/proxy?path=${encodeURIComponent(workingPath)}`,
        { signal }
      );
      if (!response.ok) return false;
      const state = (await response.json()) as { status?: unknown };
      return state.status === "ready";
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  };

  const reconcile = async (
    source: VideoSourceRecord,
    signal: AbortSignal
  ): Promise<VideoSourceRecord> => {
    if (signal.aborted) throw abortError();
    const originalInspectionPromise = inspectIfPresent(
      source.originalPath,
      signal
    );
    const workingInspectionPromise =
      source.workingPath === source.originalPath
        ? originalInspectionPromise
        : inspectIfPresent(source.workingPath, signal);
    const [originalInspection, workingInspection] = await Promise.all([
      originalInspectionPromise,
      workingInspectionPromise,
    ]);
    if (signal.aborted) throw abortError();

    if (
      source.compatibilityStatus === "native" &&
      originalInspection === null
    ) {
      throw new VideoImportError("VIDEO_SOURCE_RECONNECT_REQUIRED");
    }
    if (originalInspection === null && workingInspection === null) {
      throw new VideoImportError("VIDEO_SOURCE_RECONNECT_REQUIRED");
    }

    let workingPath =
      source.compatibilityStatus === "native"
        ? source.originalPath
        : source.workingPath;
    if (workingInspection === null) {
      if (!originalInspection) {
        throw new VideoImportError("VIDEO_SOURCE_RECONNECT_REQUIRED");
      }
      if (source.compatibilityStatus === "native") {
        workingPath = source.originalPath;
      } else {
        workingPath = await createCompatibilityMaster(
          source.originalPath,
          originalInspection,
          signal,
          () => undefined
        );
        const probe = await dependencies.probeBrowserVideo(
          footageUrlForPath(workingPath),
          signal
        );
        if (signal.aborted) throw abortError();
        if (!probe.decodable) {
          throw new VideoImportError("BROWSER_DECODE_FAILED", probe.reason);
        }
      }
    }

    const workingChanged = workingPath !== source.workingPath;
    return {
      ...source,
      workingPath,
      inspection: originalInspection ?? source.inspection,
      ...(workingChanged ? { previewPath: undefined } : {}),
    };
  };

  const reconcilePreview = async (
    source: VideoSourceRecord,
    signal: AbortSignal
  ): Promise<VideoSourceRecord> => {
    if (signal.aborted) throw abortError();
    if (!source.previewPath) {
      queuePreviewRebuild(source.workingPath, signal);
      return source;
    }
    if (await previewIsReady(source.workingPath, signal)) return source;
    if (signal.aborted) throw abortError();
    queuePreviewRebuild(source.workingPath, signal);
    return { ...source, previewPath: undefined };
  };

  return {
    async importVideoFile(file, options) {
      const report = createProgressReporter(options.onProgress);
      try {
        const uploaded = await uploadVideo(
          file,
          options.role,
          options.signal,
          report,
          dependencies.createXhr
        );
        report({ phase: "inspecting", progress: null });
        const mediaInspection = await inspectVideo(
          uploaded.originalPath,
          options.signal,
          dependencies.fetch
        );
        report({
          phase: "checking-browser",
          progress: null,
          codec: mediaInspection.video.codec,
        });
        const originalProbe = await dependencies.probeBrowserVideo(
          footageUrlForPath(uploaded.originalPath),
          options.signal
        );
        if (options.signal.aborted) throw abortError();

        if (originalProbe.decodable) {
          const source: VideoSourceRecord = {
            originalPath: uploaded.originalPath,
            workingPath: uploaded.originalPath,
            originalName: file.name || uploaded.name,
            inspection: mediaInspection,
            nativeCompatible: true,
            compatibilityStatus: "native",
          };
          report({
            phase: "ready",
            progress: 1,
            codec: mediaInspection.video.codec,
          });
          return source;
        }

        const workingPath = await createCompatibilityMaster(
          uploaded.originalPath,
          mediaInspection,
          options.signal,
          report
        );
        report({
          phase: "checking-browser",
          progress: null,
          codec: "h264",
        });
        const convertedProbe = await dependencies.probeBrowserVideo(
          footageUrlForPath(workingPath),
          options.signal
        );
        if (options.signal.aborted) throw abortError();
        if (!convertedProbe.decodable) {
          throw new VideoImportError(
            "BROWSER_DECODE_FAILED",
            convertedProbe.reason
          );
        }

        const source: VideoSourceRecord = {
          originalPath: uploaded.originalPath,
          workingPath,
          originalName: file.name || uploaded.name,
          inspection: mediaInspection,
          nativeCompatible: false,
          compatibilityStatus: "converted",
        };
        report({ phase: "ready", progress: 1, codec: "h264" });
        return source;
      } catch (cause) {
        const error =
          cause instanceof VideoImportError
            ? cause
            : options.signal.aborted
              ? abortError()
              : new VideoImportError("MEDIA_INSPECTION_FAILED", cause);
        if (isCancelledCode(error.code)) {
          report({ phase: "cancelled", progress: null });
        } else {
          dependencies.logError(`[video-import] ${error.code}`, error.detail ?? cause);
          report({ phase: "error", progress: null });
        }
        throw error;
      }
    },
    async reconcileVideoSource(source, signal) {
      try {
        return await reconcile(source, signal);
      } catch (cause) {
        const error =
          cause instanceof VideoImportError
            ? cause
            : signal.aborted
              ? abortError()
              : new VideoImportError("MEDIA_INSPECTION_FAILED", cause);
        if (!isCancelledCode(error.code)) {
          dependencies.logError(
            `[video-import] ${error.code}`,
            error.detail ?? cause
          );
        }
        throw error;
      }
    },
    async reconcileVideoPreview(source, signal) {
      try {
        return await reconcilePreview(source, signal);
      } catch (cause) {
        const error =
          cause instanceof VideoImportError
            ? cause
            : signal.aborted
              ? abortError()
              : new VideoImportError("MEDIA_INSPECTION_FAILED", cause);
        if (!isCancelledCode(error.code)) {
          dependencies.logError(
            `[video-import] ${error.code}`,
            error.detail ?? cause
          );
        }
        throw error;
      }
    },
  };
}

export async function importVideoFile(
  file: File,
  options: ImportVideoOptions
): Promise<VideoSourceRecord> {
  return createVideoImportClient().importVideoFile(file, options);
}

export function videoUrlForWorkingSource(source: VideoSourceRecord): string {
  return footageUrlForPath(source.workingPath);
}

export async function reconcileVideoSource(
  source: VideoSourceRecord,
  signal: AbortSignal
): Promise<VideoSourceRecord> {
  return createVideoImportClient().reconcileVideoSource(source, signal);
}

export async function reconcileVideoPreview(
  source: VideoSourceRecord,
  signal: AbortSignal
): Promise<VideoSourceRecord> {
  return createVideoImportClient().reconcileVideoPreview(source, signal);
}
