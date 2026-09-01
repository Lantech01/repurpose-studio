import type { BrowserMediaProbe } from "@/lib/repurpose/media-types";

const PROBE_TIMEOUT_MS = 15_000;

function failedProbe(reason: string): BrowserMediaProbe {
  return { decodable: false, durationSec: 0, width: 0, height: 0, reason };
}

export function probeBrowserVideo(src: string, signal?: AbortSignal): Promise<BrowserMediaProbe> {
  if (signal?.aborted) return Promise.resolve(failedProbe("aborted"));

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
      video.removeAttribute("src");
      video.load();
    };
    const finish = (result: BrowserMediaProbe) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const handleMetadata = () => {
      const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
      const width = Number.isFinite(video.videoWidth) ? video.videoWidth : 0;
      const height = Number.isFinite(video.videoHeight) ? video.videoHeight : 0;
      finish(durationSec > 0 && width > 0 && height > 0
        ? { decodable: true, durationSec, width, height }
        : { decodable: false, durationSec, width, height, reason: "invalid-metadata" });
    };
    const handleError = () => finish(failedProbe("media-error"));
    const handleAbort = () => finish(failedProbe("aborted"));
    const timeout = setTimeout(() => finish(failedProbe("timeout")), PROBE_TIMEOUT_MS);

    video.addEventListener("loadedmetadata", handleMetadata);
    video.addEventListener("error", handleError);
    signal?.addEventListener("abort", handleAbort, { once: true });
    video.src = src;
  });
}
