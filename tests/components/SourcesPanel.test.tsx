import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { importVideoFileMock } = vi.hoisted(() => ({
  importVideoFileMock: vi.fn(),
}));

vi.mock("@/lib/repurpose/video-import-client", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/repurpose/video-import-client")
  >();
  return { ...original, importVideoFile: importVideoFileMock };
});

import { SourcesPanel } from "@/app/repurpose-studio/_components/SourcesPanel";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  VideoImportError,
  type ImportVideoOptions,
} from "@/lib/repurpose/video-import-client";
import type { VideoSourceRecord } from "@/lib/repurpose/types";

function videoSource(name: string, width = 1920): VideoSourceRecord {
  return {
    originalPath: `C:\\media\\${name}.mov`,
    workingPath: `C:\\cache\\${name}.mp4`,
    originalName: `${name}.mov`,
    inspection: {
      fingerprint: name.padEnd(64, "a").slice(0, 64),
      container: "mov,mp4",
      extension: ".mov",
      size: 1024,
      durationSec: 12.25,
      video: {
        codec: "hevc",
        codecTag: "hvc1",
        profile: "Main",
        pixelFormat: "yuv420p",
        width,
        height: 1080,
        fps: 29.97,
      },
      audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
    },
    nativeCompatible: false,
    compatibilityStatus: "converted",
  };
}

function sourceInput(label: "Face" | "Screen"): HTMLInputElement {
  const button = screen.getByText(label).closest("button");
  const input = button?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${label} input`);
  return input;
}

function ingestInput(label: string): HTMLInputElement {
  const button = screen.getByText(label).closest("button");
  const input = button?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${label} input`);
  return input;
}

function wordsPayload(project: string) {
  return {
    text: `${project} words only`,
    words: [
      { text: project, start: 0, end: 0.4 },
      { text: "words", start: 0.4, end: 0.8 },
      { text: "only", start: 0.8, end: 1.2 },
    ],
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  importVideoFileMock.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourcesPanel video imports", () => {
  it("does not rebuild Project B from Project A raw words after reset", async () => {
    render(<SourcesPanel />);
    const projectAWords = new File(
      [JSON.stringify(wordsPayload("project-a"))],
      "project-a.words.json",
      { type: "application/json" }
    );
    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: { files: [projectAWords] },
    });
    await waitFor(() =>
      expect(useRepurposeStore.getState().words[0]?.text).toBe("project-a")
    );

    act(() => useRepurposeStore.getState().resetProject());
    fireEvent.change(ingestInput("Load final transcript (.srt)"), {
      target: {
        files: [new File(["Project B final transcript"], "project-b.txt", { type: "text/plain" })],
      },
    });
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState().words).toEqual([]);
    expect(useRepurposeStore.getState().clips).toEqual([]);
  });

  it("allows transcript backfill to run again in a new project epoch", async () => {
    let wordsRequest = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (!String(input).endsWith("claude-routines-words.json")) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        const project = wordsRequest++ === 0 ? "project-a" : "project-b";
        return Promise.resolve(
          new Response(JSON.stringify(wordsPayload(project)), { status: 200 })
        );
      })
    );
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "a-face",
      screenPath: "a-screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 3,
    });
    render(<SourcesPanel />);
    await waitFor(() =>
      expect(useRepurposeStore.getState().words[0]?.text).toBe("project-a")
    );

    act(() => {
      useRepurposeStore.getState().resetProject();
      useRepurposeStore.getState().setFootageMeta({
        faceCamPath: "b-face",
        screenPath: "b-screen",
        fps: 30,
        width: 1920,
        height: 1080,
        durationSec: 3,
      });
    });

    await waitFor(() =>
      expect(useRepurposeStore.getState().words[0]?.text).toBe("project-b")
    );
  });

  it("allows demo auto-load to run in a new project epoch", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("claude-routines-words.json")) {
        return Promise.resolve(
          new Response(JSON.stringify(wordsPayload("project-b")), { status: 200 })
        );
      }
      if (url.endsWith("final-transcript.txt")) {
        return Promise.resolve(new Response("project-b words only", { status: 200 }));
      }
      if (url.endsWith("footage-manifest.json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              faceCamPath: "/api/project-b-face",
              screenPath: "/api/project-b-screen",
              fps: 30,
              width: 1920,
              height: 1080,
              durationSec: 3,
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "a-face",
      screenPath: "a-screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 3,
    });
    useRepurposeStore.getState().setWords(wordsPayload("project-a").words);
    render(<SourcesPanel />);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => useRepurposeStore.getState().resetProject());

    await waitFor(() =>
      expect(useRepurposeStore.getState().footageMeta).toMatchObject({
        faceCamPath: "/api/project-b-face",
        screenPath: "/api/project-b-screen",
      })
    );
    expect(useRepurposeStore.getState().words[0]?.text).toBe("project-b");
  });

  it("uses server inspection, preserves the other role, and resets the picker", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    const oldFace = videoSource("old-face", 640);
    const screenSource = videoSource("screen", 1280);
    const nextFace = videoSource("next-face", 3840);
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "old-face-url",
      screenPath: "screen-url",
      faceCamSource: oldFace,
      screenSource,
      fps: 24,
      width: 640,
      height: 360,
      durationSec: 3,
    });
    importVideoFileMock.mockResolvedValue(nextFace);
    render(<SourcesPanel />);
    const input = sourceInput("Face");

    fireEvent.change(input, {
      target: {
        files: [new File(["face"], "next-face.mov", { type: "video/quicktime" })],
      },
    });

    expect(input.value).toBe("");
    await waitFor(() => {
      expect(useRepurposeStore.getState().footageMeta?.faceCamSource).toBe(nextFace);
    });
    expect(importVideoFileMock).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ role: "face", signal: expect.any(AbortSignal) })
    );
    expect(useRepurposeStore.getState().footageMeta).toMatchObject({
      faceCamPath: `/api/repurpose/video?path=${encodeURIComponent(nextFace.workingPath)}`,
      screenSource,
      width: 3840,
      height: 1080,
      fps: 29.97,
      durationSec: 12.25,
    });
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("marks media loading during import and ignores a replaced role's stale completion", async () => {
    const first = videoSource("first");
    const second = videoSource("second");
    let firstOptions!: ImportVideoOptions;
    let resolveFirst!: (source: VideoSourceRecord) => void;
    importVideoFileMock
      .mockImplementationOnce((_file: File, options: ImportVideoOptions) => {
        firstOptions = options;
        return new Promise<VideoSourceRecord>((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce(second);
    render(<SourcesPanel />);
    const input = sourceInput("Face");

    fireEvent.change(input, {
      target: { files: [new File(["first"], "first.mov", { type: "video/quicktime" })] },
    });
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    fireEvent.change(input, {
      target: { files: [new File(["second"], "second.mov", { type: "video/quicktime" })] },
    });
    await waitFor(() => {
      expect(useRepurposeStore.getState().footageMeta?.faceCamSource).toBe(second);
    });
    expect(firstOptions.signal.aborted).toBe(true);

    resolveFirst(first);
    await Promise.resolve();
    expect(useRepurposeStore.getState().footageMeta?.faceCamSource).toBe(second);
  });

  it("keeps the replacement role token when an obsolete import settles", async () => {
    const first = videoSource("first-owned");
    const second = videoSource("second-owned");
    let resolveFirst!: (source: VideoSourceRecord) => void;
    let resolveSecond!: (source: VideoSourceRecord) => void;
    importVideoFileMock
      .mockImplementationOnce(
        () =>
          new Promise<VideoSourceRecord>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<VideoSourceRecord>((resolve) => {
            resolveSecond = resolve;
          })
      );
    render(<SourcesPanel />);
    const input = sourceInput("Face");

    fireEvent.change(input, {
      target: { files: [new File(["first"], "first.mov", { type: "video/quicktime" })] },
    });
    const firstToken = useRepurposeStore.getState().sourceImportOwners.face;
    fireEvent.change(input, {
      target: { files: [new File(["second"], "second.mov", { type: "video/quicktime" })] },
    });
    const secondToken = useRepurposeStore.getState().sourceImportOwners.face;
    expect(secondToken).not.toBe(firstToken);

    resolveFirst(first);
    await act(async () => Promise.resolve());
    expect(useRepurposeStore.getState().sourceImportOwners.face).toBe(secondToken);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    resolveSecond(second);
    await waitFor(() => {
      expect(useRepurposeStore.getState().footageMeta?.faceCamSource).toBe(second);
    });
    expect(useRepurposeStore.getState().sourceImportOwners.face).toBeNull();
  });

  it("does not write a source import that resolves after project reset", async () => {
    let resolveImport!: (source: VideoSourceRecord) => void;
    importVideoFileMock.mockImplementation(
      () =>
        new Promise<VideoSourceRecord>((resolve) => {
          resolveImport = resolve;
        })
    );
    render(<SourcesPanel />);
    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["old"], "old.mov", { type: "video/quicktime" })] },
    });
    await waitFor(() => expect(resolveImport).toBeDefined());
    const previousEpoch = useRepurposeStore.getState().projectEpoch;

    act(() => useRepurposeStore.getState().resetProject());
    expect(useRepurposeStore.getState().projectEpoch).toBe(previousEpoch + 1);
    resolveImport(videoSource("old-project"));
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState()).toMatchObject({
      footageMeta: null,
      mediaReadiness: "idle",
      sourceImportOwners: { screen: null, face: null },
    });
  });

  it("clears old import bookkeeping so a new failure restores only the new-project baseline", async () => {
    const oldFace = videoSource("old-face");
    const oldScreen = videoSource("old-screen");
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "old-face-url",
      screenPath: "old-screen-url",
      faceCamSource: oldFace,
      screenSource: oldScreen,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 10,
    });
    useRepurposeStore.getState().setMediaReadiness("ready");
    let oldOptions!: ImportVideoOptions;
    let newOptions!: ImportVideoOptions;
    let resolveOld!: (source: VideoSourceRecord) => void;
    let rejectNew!: (error: VideoImportError) => void;
    importVideoFileMock
      .mockImplementationOnce((_file: File, options: ImportVideoOptions) => {
        oldOptions = options;
        return new Promise<VideoSourceRecord>((resolve) => {
          resolveOld = resolve;
        });
      })
      .mockImplementationOnce((_file: File, options: ImportVideoOptions) => {
        newOptions = options;
        return new Promise<VideoSourceRecord>((_resolve, reject) => {
          rejectNew = reject;
        });
      });
    render(<SourcesPanel />);

    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["old"], "old.mov", { type: "video/quicktime" })] },
    });
    await waitFor(() => expect(oldOptions).toBeDefined());
    act(() => oldOptions.onProgress({ phase: "converting", progress: 0.4 }));
    expect(screen.getByText("Convertendo HEVC para H.264 40%")).toBeInTheDocument();

    act(() => useRepurposeStore.getState().resetProject());
    expect(oldOptions.signal.aborted).toBe(true);
    expect(screen.queryByText("Convertendo HEVC para H.264 40%")).toBeNull();
    act(() =>
      useRepurposeStore
        .getState()
        .setMediaReadiness("error", "New project media error.")
    );

    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["new"], "new.mov", { type: "video/quicktime" })] },
    });
    await waitFor(() => expect(newOptions).toBeDefined());
    rejectNew(new VideoImportError("COMPATIBILITY_ENCODE_FAILED"));
    await screen.findByText("Não foi possível converter o vídeo.");

    resolveOld(videoSource("late-old"));
    await act(async () => Promise.resolve());
    expect(useRepurposeStore.getState()).toMatchObject({
      footageMeta: null,
      mediaReadiness: "error",
      playbackBlockedReason: "New project media error.",
      sourceImportOwners: { screen: null, face: null },
    });
  });

  it("aborts an active source import when unmounted", async () => {
    let options!: ImportVideoOptions;
    importVideoFileMock.mockImplementation(
      (_file: File, nextOptions: ImportVideoOptions) => {
        options = nextOptions;
        return new Promise(() => undefined);
      }
    );
    const rendered = render(<SourcesPanel />);

    fireEvent.change(sourceInput("Screen"), {
      target: { files: [new File(["screen"], "screen.mov", { type: "video/quicktime" })] },
    });
    await waitFor(() => expect(options).toBeDefined());
    expect(useRepurposeStore.getState().sourceImportOwners.screen).not.toBeNull();
    rendered.unmount();

    expect(options.signal.aborted).toBe(true);
    expect(useRepurposeStore.getState().sourceImportOwners).toEqual({
      screen: null,
      face: null,
    });
  });

  it("does not write progress or media readiness after unmount", async () => {
    const existingFace = videoSource("existing-face");
    const existingScreen = videoSource("existing-screen");
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "face-url",
      screenPath: "screen-url",
      faceCamSource: existingFace,
      screenSource: existingScreen,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 10,
    });
    useRepurposeStore.getState().setMediaReadiness("ready");
    let options!: ImportVideoOptions;
    let resolveImport!: (source: VideoSourceRecord) => void;
    importVideoFileMock.mockImplementation(
      (_file: File, nextOptions: ImportVideoOptions) => {
        options = nextOptions;
        return new Promise<VideoSourceRecord>((resolve) => {
          resolveImport = resolve;
        });
      }
    );
    const rendered = render(<SourcesPanel />);
    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["face"], "face.mov", { type: "video/quicktime" })] },
    });
    await waitFor(() => expect(options).toBeDefined());
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
    const readinessWrites: string[] = [];
    const unsubscribe = useRepurposeStore.subscribe((state, previous) => {
      if (state.mediaReadiness !== previous.mediaReadiness) {
        readinessWrites.push(state.mediaReadiness);
      }
    });

    rendered.unmount();
    options.onProgress({ phase: "ready", progress: 1 });
    resolveImport(videoSource("late-face"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(readinessWrites).toEqual([]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
    unsubscribe();
  });

  it("stays loading until concurrent role imports settle", async () => {
    const pending = new Map<
      string,
      { resolve: (source: VideoSourceRecord) => void }
    >();
    importVideoFileMock.mockImplementation(
      (file: File) =>
        new Promise<VideoSourceRecord>((resolve) => {
          pending.set(file.name, { resolve });
        })
    );
    render(<SourcesPanel />);

    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["face"], "face.mov", { type: "video/quicktime" })] },
    });
    fireEvent.change(sourceInput("Screen"), {
      target: { files: [new File(["screen"], "screen.mov", { type: "video/quicktime" })] },
    });
    pending.get("face.mov")?.resolve(videoSource("face"));

    await waitFor(() => {
      expect(useRepurposeStore.getState().footageMeta?.faceCamSource).toBeDefined();
    });
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    pending.get("screen.mov")?.resolve(videoSource("screen"));
    await waitFor(() => {
      expect(useRepurposeStore.getState().footageMeta?.screenSource).toBeDefined();
    });
  });

  it("restores readiness after all concurrent role imports fail", async () => {
    const existingFace = videoSource("existing-face");
    const existingScreen = videoSource("existing-screen");
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "face-url",
      screenPath: "screen-url",
      faceCamSource: existingFace,
      screenSource: existingScreen,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 10,
    });
    useRepurposeStore.getState().setMediaReadiness("ready");
    const pending = new Map<string, { reject: (error: Error) => void }>();
    importVideoFileMock.mockImplementation(
      (file: File) =>
        new Promise<VideoSourceRecord>((_resolve, reject) => {
          pending.set(file.name, { reject });
        })
    );
    render(<SourcesPanel />);

    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["face"], "face.mov", { type: "video/quicktime" })] },
    });
    fireEvent.change(sourceInput("Screen"), {
      target: { files: [new File(["screen"], "screen.mov", { type: "video/quicktime" })] },
    });
    pending.get("face.mov")?.reject(new Error("ffmpeg C:\\secret\\face.mov"));
    pending.get("screen.mov")?.reject(new Error("ffprobe C:\\secret\\screen.mov"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Não foi possível importar o vídeo.").length
      ).toBeGreaterThan(0);
    });
    expect(document.body.textContent).not.toContain("secret");
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });
});
