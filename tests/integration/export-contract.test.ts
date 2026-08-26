// @vitest-environment node

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  actionableExportError,
  resolveExportOverlaySource,
  resolveExportSources,
} from "@/lib/repurpose/export-short";
import type {
  FootageMeta,
  Overlay,
  VideoSourceRecord,
} from "@/lib/repurpose/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function source(
  originalPath: string,
  workingPath: string,
  options: {
    compatibilityStatus?: "native" | "converted";
    previewPath?: string;
  } = {}
): VideoSourceRecord {
  const compatibilityStatus = options.compatibilityStatus ?? "native";
  return {
    originalPath,
    workingPath,
    previewPath: options.previewPath,
    originalName: originalPath.split(/[\\/]/).pop() ?? "video.mp4",
    inspection: {
      fingerprint: "a".repeat(64),
      container: "mov,mp4",
      extension: ".mp4",
      size: 1024,
      durationSec: 3,
      video: {
        codec: compatibilityStatus === "native" ? "h264" : "hevc",
        codecTag: compatibilityStatus === "native" ? "avc1" : "hvc1",
        profile: "Main",
        pixelFormat: "yuv420p",
        width: 320,
        height: 180,
        fps: 30,
      },
      audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
    },
    nativeCompatible: compatibilityStatus === "native",
    compatibilityStatus,
  };
}

function footage(
  faceCamSource?: VideoSourceRecord,
  screenSource?: VideoSourceRecord
): FootageMeta {
  return {
    faceCamPath: "/legacy/face.mp4",
    screenPath: "/legacy/screen.mp4",
    faceCamSource,
    screenSource,
    fps: 30,
    width: 320,
    height: 180,
    durationSec: 3,
  };
}

describe("resolveExportSources", () => {
  test("derives browser URLs from new working source records", () => {
    const face = source(
      "C:\\media\\face-original.mp4",
      "C:\\media\\face-working.mp4"
    );
    const screen = source(
      "C:\\media\\screen-original.mp4",
      "C:\\media\\screen-working.mp4"
    );

    expect(resolveExportSources(footage(face, screen))).toEqual({
      face: `/api/repurpose/video?path=${encodeURIComponent(face.workingPath)}`,
      screen: `/api/repurpose/video?path=${encodeURIComponent(screen.workingPath)}`,
    });
  });

  test("uses a native original as the full-quality working source", () => {
    const native = source(
      "C:\\media\\native.mp4",
      "C:\\media\\native.mp4",
      { previewPath: "C:\\cache\\native-preview.mp4" }
    );

    expect(resolveExportSources(footage(native, native))).toEqual({
      face: `/api/repurpose/video?path=${encodeURIComponent(native.originalPath)}`,
      screen: `/api/repurpose/video?path=${encodeURIComponent(native.originalPath)}`,
    });
  });

  test("uses a converted compatibility master and always ignores previewPath", () => {
    const converted = source(
      "C:\\media\\camera-hevc.mov",
      "C:\\cache\\camera-compat-v1.mp4",
      {
        compatibilityStatus: "converted",
        previewPath: "C:\\cache\\camera-preview-540p.mp4",
      }
    );

    const resolved = resolveExportSources(footage(converted, converted));

    expect(resolved.face).toContain(encodeURIComponent(converted.workingPath));
    expect(resolved.screen).toContain(encodeURIComponent(converted.workingPath));
    expect(resolved.face).not.toContain(encodeURIComponent(converted.previewPath!));
  });

  test("keeps legacy browser paths and safely upgrades legacy raw OS paths", () => {
    expect(
      resolveExportSources({
        ...footage(),
        faceCamPath: "/api/repurpose/video?path=legacy-face.mp4",
        screenPath: "C:\\media\\legacy-screen.mp4",
      })
    ).toEqual({
      face: "/api/repurpose/video?path=legacy-face.mp4",
      screen: `/api/repurpose/video?path=${encodeURIComponent(
        "C:\\media\\legacy-screen.mp4"
      )}`,
    });
  });

  test("turns reconnect placeholders and missing sources into actionable absence", () => {
    expect(resolveExportSources(null)).toEqual({
      face: undefined,
      screen: undefined,
    });
    expect(
      resolveExportSources({
        ...footage(),
        faceCamPath: "reconnect:",
        screenPath: "",
      })
    ).toEqual({ face: undefined, screen: undefined });
  });
});

describe("resolveExportOverlaySource", () => {
  const overlay = (overrides: Partial<Overlay> = {}): Overlay => ({
    id: "overlay-video",
    kind: "video",
    src: "/api/repurpose/video?path=stale-preview.mp4",
    sourcePath: "C:\\cache\\stale-preview.mp4",
    naturalWidth: 160,
    naturalHeight: 90,
    timelineStart: 0,
    timelineEnd: 2,
    srcStart: 0,
    srcDuration: 2,
    transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    muted: true,
    ...overrides,
  });

  test("derives video overlay URLs from workingPath and ignores previewPath", () => {
    const videoSource = source(
      "C:\\media\\overlay-original.mov",
      "C:\\cache\\overlay-working.mp4",
      {
        compatibilityStatus: "converted",
        previewPath: "C:\\cache\\overlay-preview.mp4",
      }
    );

    const resolved = resolveExportOverlaySource(overlay({ videoSource }));

    expect(resolved).toBe(
      `/api/repurpose/video?path=${encodeURIComponent(videoSource.workingPath)}`
    );
    expect(resolved).not.toContain(encodeURIComponent(videoSource.previewPath!));
  });

  test("derives persisted image and legacy video URLs from sourcePath before src", () => {
    expect(
      resolveExportOverlaySource(
        overlay({
          kind: "image",
          sourcePath: "C:\\media\\still.png",
          src: "blob:stale-image-preview",
        })
      )
    ).toBe(
      `/api/repurpose/asset?path=${encodeURIComponent("C:\\media\\still.png")}`
    );
    expect(
      resolveExportOverlaySource(
        overlay({
          sourcePath: "C:\\media\\legacy-overlay.mov",
          src: "blob:stale-video-preview",
        })
      )
    ).toBe(
      `/api/repurpose/video?path=${encodeURIComponent("C:\\media\\legacy-overlay.mov")}`
    );
  });

  test("falls back from a missing nested working source to sourcePath, then transient src", () => {
    expect(
      resolveExportOverlaySource(
        overlay({
          videoSource: source("C:\\media\\overlay.mov", ""),
          sourcePath: "C:\\media\\persisted-overlay.mov",
          src: "blob:transient-overlay",
        })
      )
    ).toBe(
      `/api/repurpose/video?path=${encodeURIComponent("C:\\media\\persisted-overlay.mov")}`
    );
    expect(
      resolveExportOverlaySource(
        overlay({ sourcePath: undefined, videoSource: undefined, src: "blob:transient-overlay" })
      )
    ).toBe("blob:transient-overlay");
  });
});

describe("exportShort source preflight", () => {
  test("honors an already-aborted export before acquiring media", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { exportShort } = await import("@/lib/repurpose/export-short");

    await expect(
      exportShort({
        clips: [],
        duration: 3,
        splitRatio: 0.5,
        footageMeta: footage(),
        abortSignal: controller.signal,
        download: false,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("checks only authoritative working sources and reports an actionable failure", async () => {
    const face = source(
      "C:\\media\\face-original.mov",
      "C:\\cache\\face-working.mp4",
      { previewPath: "C:\\cache\\face-preview.mp4" }
    );
    const screen = source(
      "C:\\media\\screen-original.mov",
      "C:\\cache\\screen-working.mp4",
      { previewPath: "C:\\cache\\screen-preview.mp4" }
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    const { exportShort } = await import("@/lib/repurpose/export-short");

    let failure: unknown;
    try {
      await exportShort({
        clips: [],
        duration: 3,
        splitRatio: 0.5,
        footageMeta: footage(face, screen),
        download: false,
      });
    } catch (error) {
      failure = error;
    }

    const requested = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requested).toEqual([
      `/api/repurpose/video?path=${encodeURIComponent(screen.workingPath)}`,
      `/api/repurpose/video?path=${encodeURIComponent(face.workingPath)}`,
    ]);
    expect(requested.join(" ")).not.toContain("preview");
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/working source/i);
    expect((failure as Error).message).toMatch(/re-import or reconvert/i);
  });
});

describe("actionableExportError", () => {
  test.each([
    "No supported video codec found.",
    "WebCodecs API not supported in this browser.",
    "Encoder creation failed (tried 4 codecs).",
    "Export configuration not supported by browser.",
  ])("names H.264/HEVC WebCodecs availability for encoder failure: %s", (message) => {
    const actionable = actionableExportError(new Error(message)).message;
    expect(actionable).toMatch(
      /H\.264\/HEVC WebCodecs encoder/i
    );
    expect(actionable).toContain(message);
  });

  test("normalizes and bounds producer details before displaying them", () => {
    const detail = `Encoder failed\n\t${"x".repeat(400)}`;
    const actionable = actionableExportError(
      new Error(`WebCodecs ${detail}`)
    ).message;

    expect(actionable).not.toMatch(/[\r\n\t]/);
    expect(actionable.length).toBeLessThan(500);
  });

  test("preserves unrelated export errors", () => {
    const error = new Error("Canvas rendering failed");
    expect(actionableExportError(error)).toBe(error);
  });
});
