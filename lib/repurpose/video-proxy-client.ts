import type { VideoSourceRecord } from "./types";

type ProxyApiState = {
  status?: "ready" | "building" | "none" | "unavailable" | "failed";
  progress?: number;
  outTimeSec?: number;
};

const MAX_NONE_RESTARTS = 3;

export interface VideoProxyClientDependencies {
  fetch: typeof globalThis.fetch;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  visibilityState: () => DocumentVisibilityState;
}

export class VideoProxyError extends Error {
  constructor(
    public readonly code:
      | "VIDEO_PROXY_CANCELLED"
      | "VIDEO_PROXY_FAILED"
      | "VIDEO_PROXY_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "VideoProxyError";
  }
}

function cancelled(): VideoProxyError {
  return new VideoProxyError("VIDEO_PROXY_CANCELLED", "Criação do proxy cancelada.");
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function previewUrl(workingPath: string): string {
  return `/api/repurpose/video?path=${encodeURIComponent(workingPath)}&quality=proxy`;
}

function withoutPreview(source: VideoSourceRecord): VideoSourceRecord {
  if (!source.previewPath) return source;
  return { ...source, previewPath: undefined };
}

export function createVideoProxyClient(
  overrides: Partial<VideoProxyClientDependencies> = {}
): {
  ensureVideoProxy: (
    source: VideoSourceRecord,
    signal: AbortSignal,
    onProgress?: (progress: number | null) => void
  ) => Promise<VideoSourceRecord>;
} {
  const dependencies: VideoProxyClientDependencies = {
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    wait: overrides.wait ?? defaultWait,
    visibilityState:
      overrides.visibilityState ??
      (() => (typeof document === "undefined" ? "visible" : document.visibilityState)),
  };

  const readState = async (response: Response): Promise<ProxyApiState | null> => {
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new VideoProxyError("VIDEO_PROXY_FAILED", "Não foi possível criar o proxy de prévia.");
    }
    try {
      return (await response.json()) as ProxyApiState;
    } catch {
      throw new VideoProxyError("VIDEO_PROXY_FAILED", "Não foi possível criar o proxy de prévia.");
    }
  };

  return {
    async ensureVideoProxy(source, signal, onProgress) {
      if (signal.aborted) throw cancelled();
      try {
        const start = async (): Promise<ProxyApiState | null> =>
          readState(await dependencies.fetch("/api/repurpose/proxy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: source.workingPath }),
            signal,
          }));
        let state = await start();
        if (!state) return withoutPreview(source);
        let noneRestarts = 0;

        while (state.status === "building" || state.status === "none") {
          if (state.status === "none") {
            if (noneRestarts >= MAX_NONE_RESTARTS) {
              throw new VideoProxyError(
                "VIDEO_PROXY_FAILED",
                "Não foi possível criar o proxy de prévia."
              );
            }
            noneRestarts += 1;
            state = await start();
            if (!state) return withoutPreview(source);
            continue;
          }
          const progress =
            typeof state.progress === "number"
              ? state.progress
              : typeof state.outTimeSec === "number" && source.inspection.durationSec > 0
                ? state.outTimeSec / source.inspection.durationSec
                : null;
          onProgress?.(
            progress === null ? null : Math.min(1, Math.max(0, progress))
          );
          await dependencies.wait(
            dependencies.visibilityState() === "hidden" ? 2_500 : 750,
            signal
          );
          state = await readState(
            await dependencies.fetch(
              `/api/repurpose/proxy?path=${encodeURIComponent(source.workingPath)}`,
              { signal }
            )
          );
          if (!state) return withoutPreview(source);
        }

        if (state.status === "ready") {
          onProgress?.(1);
          return { ...source, previewPath: previewUrl(source.workingPath) };
        }
        if (state.status === "unavailable") {
          throw new VideoProxyError(
            "VIDEO_PROXY_UNAVAILABLE",
            "O proxy de prévia não está disponível."
          );
        }
        throw new VideoProxyError(
          "VIDEO_PROXY_FAILED",
          "Não foi possível criar o proxy de prévia."
        );
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof VideoProxyError) throw error;
        throw new VideoProxyError(
          "VIDEO_PROXY_FAILED",
          "Não foi possível criar o proxy de prévia."
        );
      }
    },
  };
}

export async function ensureVideoProxy(
  source: VideoSourceRecord,
  signal: AbortSignal,
  onProgress?: (progress: number | null) => void
): Promise<VideoSourceRecord> {
  return createVideoProxyClient().ensureVideoProxy(source, signal, onProgress);
}
