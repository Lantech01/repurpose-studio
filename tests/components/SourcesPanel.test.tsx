import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { importVideoFileMock, transcriptDialogCapture } = vi.hoisted(() => ({
  importVideoFileMock: vi.fn(),
  transcriptDialogCapture: {
    rebuild: undefined as (() => void) | undefined,
  },
}));

vi.mock("@/lib/repurpose/video-import-client", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/repurpose/video-import-client")
  >();
  return { ...original, importVideoFile: importVideoFileMock };
});

vi.mock(
  "@/app/repurpose-studio/_components/TranscriptApplyDialog",
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import("@/app/repurpose-studio/_components/TranscriptApplyDialog")
    >();
    const React = await import("react");
    type DialogProps = Parameters<typeof original.TranscriptApplyDialog>[0];
    return {
      ...original,
      TranscriptApplyDialog: (props: DialogProps) => {
        if (props.open) transcriptDialogCapture.rebuild = props.onRebuild;
        return React.createElement(original.TranscriptApplyDialog, props);
      },
    };
  }
);

import { SourcesPanel } from "@/app/repurpose-studio/_components/SourcesPanel";
import { TranscriptionControls } from "@/app/repurpose-studio/_components/TranscriptionControls";
import {
  useTranscriptApplication,
  type TranscriptOffer,
} from "@/app/repurpose-studio/_components/useTranscriptApplication";
import type { UseTranscriptionResult } from "@/app/repurpose-studio/_components/useTranscription";
import { TranscriptApplyDialog } from "@/app/repurpose-studio/_components/TranscriptApplyDialog";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { TranscriptionStatus } from "@/lib/repurpose/transcription-contract";
import {
  VideoImportError,
  type ImportVideoOptions,
} from "@/lib/repurpose/video-import-client";
import type { Clip, VideoSourceRecord } from "@/lib/repurpose/types";

function videoSource(
  name: string,
  width = 1920,
  durationSec = 12.25
): VideoSourceRecord {
  return {
    originalPath: `C:\\media\\${name}.mov`,
    workingPath: `C:\\cache\\${name}.mp4`,
    originalName: `${name}.mov`,
    inspection: {
      fingerprint: name.padEnd(64, "a").slice(0, 64),
      container: "mov,mp4",
      extension: ".mov",
      size: 1024,
      durationSec,
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

function expansionWords() {
  return [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ].map((text, index) => ({
    text,
    start: index * 0.8,
    end: (index + 1) * 0.8,
  }));
}

function timelineClip(id = "edited", start = 0, end = 3): Clip {
  return {
    id,
    kind: "take",
    label: id,
    srcStart: start,
    srcEnd: end,
    timelineStart: 0,
    timelineEnd: end - start,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start, end }],
    keeperIndex: 0,
    splitRatio: 0.6,
  };
}

function setDualFootage(screenDuration = 10, faceDuration = 8): void {
  const screenSource = videoSource("screen", 1920, screenDuration);
  const faceCamSource = videoSource("face", 1920, faceDuration);
  useRepurposeStore.getState().setFootageMeta({
    faceCamPath: "/screen-face",
    screenPath: "/screen-video",
    faceCamSource,
    screenSource,
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: faceDuration,
  });
}

function TranscriptApplicationHarness({
  offer,
  captureRebuild,
}: {
  offer: TranscriptOffer;
  captureRebuild?: (callback: () => void) => void;
}) {
  const application = useTranscriptApplication();
  const offerCandidate = application.offerCandidate;
  useEffect(() => offerCandidate(offer), [offerCandidate, offer]);
  useEffect(() => {
    if (application.pendingCandidate) {
      captureRebuild?.(application.applyRebuilding);
    }
  }, [application.applyRebuilding, application.pendingCandidate, captureRebuild]);
  return (
    <>
      <output data-testid="pending">{application.pendingCandidate ? "pending" : "none"}</output>
      <output data-testid="notice">{application.notice ?? "none"}</output>
      <button onClick={application.applyLater}>later</button>
      <button onClick={application.reopenPending}>reopen</button>
      <TranscriptApplyDialog
        open={application.dialogOpen}
        onPreserve={application.applyPreservingCuts}
        onRebuild={application.applyRebuilding}
        onApplyLater={application.applyLater}
      />
    </>
  );
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  importVideoFileMock.mockReset();
  transcriptDialogCapture.rebuild = undefined;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourcesPanel onboarding", () => {
  it("explains that source videos are required and the transcript is optional", () => {
    render(<SourcesPanel />);

    expect(screen.getByRole("heading", { name: "Sources" })).toBeVisible();
    expect(
      screen.getByText(
        "Choose both Screen and Face videos to enable Play. A raw transcript is optional and automatically builds an edited timeline."
      )
    ).toBeVisible();
  });

  it("stays expanded until both source videos are present", () => {
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "",
      screenPath: "/api/screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 3,
    });

    render(<SourcesPanel />);

    expect(screen.getByRole("heading", { name: "Sources" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Face" })).toBeVisible();
    expect(screen.queryByText("Re-import footage", { exact: true })).toBeNull();
  });

  it("stays expanded when restored source videos need reconnection", () => {
    useRepurposeStore.getState().setWords(wordsPayload("project").words);
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "reconnect:",
      screenPath: "reconnect:",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 3,
    });

    render(<SourcesPanel />);

    expect(screen.getByRole("heading", { name: "Sources" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Screen" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Face" })).toBeVisible();
    expect(screen.queryByText("Re-import footage", { exact: true })).toBeNull();
  });

  it("keeps overlay media available after source setup collapses", () => {
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "/api/face",
      screenPath: "/api/screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 3,
    });

    render(<SourcesPanel />);

    expect(screen.getByText("Re-import footage", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add media (image / video)" })).toBeVisible();
  });

  it("collapses source setup after both videos are present without words", () => {
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "/api/face",
      screenPath: "/api/screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 3,
    });

    render(<SourcesPanel />);

    expect(useRepurposeStore.getState().words).toEqual([]);
    expect(screen.getByText("Re-import footage", { exact: true })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Sources" })).toBeNull();
  });
});

describe("SourcesPanel video imports", () => {
  it("builds a full-span timeline after Screen and Face import without a transcript", async () => {
    importVideoFileMock
      .mockResolvedValueOnce(videoSource("screen", 1920, 10))
      .mockResolvedValueOnce(videoSource("face", 1920, 6));
    render(<SourcesPanel />);

    fireEvent.change(sourceInput("Screen"), {
      target: { files: [new File(["screen"], "screen.mp4", { type: "video/mp4" })] },
    });
    await waitFor(() =>
      expect(useRepurposeStore.getState().footageMeta?.screenSource).toBeDefined()
    );
    expect(useRepurposeStore.getState().clips).toEqual([]);

    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["face"], "face.mp4", { type: "video/mp4" })] },
    });

    await waitFor(() =>
      expect(useRepurposeStore.getState()).toMatchObject({
        clips: [
          {
            id: "video-full-span",
            srcStart: 0,
            srcEnd: 6,
            timelineStart: 0,
            timelineEnd: 6,
          },
        ],
        duration: 6,
        words: [],
      })
    );
  });

  it("replaces the video bootstrap when a raw transcript is loaded later", async () => {
    importVideoFileMock
      .mockResolvedValueOnce(videoSource("screen", 1920, 10))
      .mockResolvedValueOnce(videoSource("face", 1920, 6));
    render(<SourcesPanel />);

    fireEvent.change(sourceInput("Screen"), {
      target: { files: [new File(["screen"], "screen.mp4", { type: "video/mp4" })] },
    });
    await waitFor(() =>
      expect(useRepurposeStore.getState().footageMeta?.screenSource).toBeDefined()
    );
    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["face"], "face.mp4", { type: "video/mp4" })] },
    });
    await waitFor(() =>
      expect(useRepurposeStore.getState().clips[0]?.id).toBe("video-full-span")
    );

    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: {
        files: [
          new File(
            [JSON.stringify(wordsPayload("manual-transcript"))],
            "manual.words.json",
            { type: "application/json" }
          ),
        ],
      },
    });

    await waitFor(() =>
      expect(useRepurposeStore.getState().words[0]?.text).toBe("manual-transcript")
    );
    expect(useRepurposeStore.getState().clips).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "video-full-span" })])
    );
    expect(useRepurposeStore.getState().clips.length).toBeGreaterThan(0);
  });

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
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const currentFace = useRepurposeStore.getState().footageMeta?.faceCamPath;
        const project = currentFace === "b-face" ? "project-b" : "project-a";
        if (url.endsWith("claude-routines-words.json")) {
          return Promise.resolve(
            new Response(JSON.stringify(wordsPayload(project)), { status: 200 })
          );
        }
        if (url.endsWith("footage-manifest.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                faceCamPath: project === "project-b" ? "b-face" : "a-face",
                screenPath: project === "project-b" ? "b-screen" : "a-screen",
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
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

  it("does not backfill staged demo words into unrelated footage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("claude-routines-words.json")) {
          return Promise.resolve(
            new Response(JSON.stringify(wordsPayload("demo")), { status: 200 })
          );
        }
        if (url.endsWith("footage-manifest.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ faceCamPath: "demo-face", screenPath: "demo-screen" }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      })
    );
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "manual-face",
      screenPath: "manual-screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 3,
    });

    render(<SourcesPanel />);
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState().words).toEqual([]);
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

  it("does not auto-load demo content after a manual source import starts", async () => {
    const pendingResponses = new Map<
      string,
      { resolve: (response: Response) => void }
    >();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            pendingResponses.set(String(input), { resolve });
          })
      )
    );
    importVideoFileMock.mockImplementation(() => new Promise(() => undefined));
    render(<SourcesPanel />);
    await waitFor(() => expect(pendingResponses.size).toBe(3));

    fireEvent.change(sourceInput("Screen"), {
      target: { files: [new File(["manual"], "manual.mp4", { type: "video/mp4" })] },
    });
    expect(useRepurposeStore.getState().sourceImportOwners.screen).not.toBeNull();

    pendingResponses.get("/repurpose/claude-routines-words.json")?.resolve(
      new Response(JSON.stringify(wordsPayload("demo")), { status: 200 })
    );
    pendingResponses.get("/repurpose/final-transcript.txt")?.resolve(
      new Response("demo words only", { status: 200 })
    );
    pendingResponses.get("/repurpose/footage-manifest.json")?.resolve(
      new Response(
        JSON.stringify({
          faceCamPath: "demo-face",
          screenPath: "demo-screen",
          fps: 30,
          width: 1920,
          height: 1080,
          durationSec: 3,
        }),
        { status: 200 }
      )
    );
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState()).toMatchObject({
      clips: [],
      words: [],
      footageMeta: null,
    });
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

describe("SourcesPanel safe manual transcript application", () => {
  it.each([
    ["broken.words.json", JSON.stringify({ text: "bad", words: [{ text: "bad", start: 2, end: 1 }] })],
    ["broken.srt", "1\nnot-a-time --> 00:00:02,000\nbad"],
  ])("rejects strict %s input without mutating the project", async (name, contents) => {
    useRepurposeStore.getState().setClips([timelineClip()]);
    useRepurposeStore.getState().setWords(wordsPayload("existing").words);
    const before = useRepurposeStore.getState();
    render(<SourcesPanel />);

    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: { files: [new File([contents], name, { type: "text/plain" })] },
    });

    await waitFor(() =>
      expect(
        screen.getByText((_text, element) =>
          element?.tagName === "SPAN"
            ? /invalid|malformed|timestamp|SRT/i.test(element.textContent ?? "")
            : false
        )
      ).toBeVisible()
    );
    expect(useRepurposeStore.getState().clips).toEqual(before.clips);
    expect(useRepurposeStore.getState().words).toEqual(before.words);
  });

  it("applies a valid source-less manual transcript atomically", async () => {
    render(<SourcesPanel />);
    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: {
        files: [new File([JSON.stringify(wordsPayload("manual"))], "manual.json")],
      },
    });

    await waitFor(() => expect(useRepurposeStore.getState().words[0]?.text).toBe("manual"));
    expect(useRepurposeStore.getState().clips.length).toBeGreaterThan(0);
    expect(useRepurposeStore.getState().captionsEnabled).toBe(true);
  });

  it("automatically rebuilds an untouched video bootstrap and preserves overlays", async () => {
    setDualFootage();
    const overlayId = useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/overlay.png",
      naturalWidth: 100,
      naturalHeight: 100,
      atTime: 1,
    });
    render(<SourcesPanel />);

    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: {
        files: [new File([JSON.stringify(wordsPayload("automatic"))], "manual.json")],
      },
    });

    await waitFor(() => expect(useRepurposeStore.getState().words[0]?.text).toBe("automatic"));
    expect(useRepurposeStore.getState().clips[0]?.id).not.toBe("video-full-span");
    expect(useRepurposeStore.getState().overlays[0]?.id).toBe(overlayId);
  });

  it("offers preserve cuts, rebuild, and apply later for an edited timeline", async () => {
    useRepurposeStore.getState().setClips([timelineClip()]);
    render(<SourcesPanel />);
    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: {
        files: [new File([JSON.stringify(wordsPayload("decision"))], "manual.json")],
      },
    });

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /framing.*transitions.*punches/
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("SFX");
    expect(screen.getByRole("dialog")).toHaveTextContent("recovery");
    expect(screen.getByRole("dialog")).toHaveTextContent(/split-ratio/i);
    expect(screen.getByRole("dialog")).toHaveTextContent(/manual scene markers/i);
    fireEvent.click(screen.getByRole("button", { name: "Aplicar depois" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useRepurposeStore.getState().words).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Revisar transcrição pendente" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Preservar cortes e adicionar legendas" })
    );
    expect(useRepurposeStore.getState().clips[0]).toEqual(timelineClip());
    expect(useRepurposeStore.getState().words[0]?.text).toBe("decision");
  });

  it("explicitly rebuilds an edited timeline without deleting overlays", async () => {
    useRepurposeStore.getState().setClips([timelineClip()]);
    const overlayId = useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/overlay.png",
      naturalWidth: 100,
      naturalHeight: 100,
      atTime: 1,
    });
    render(<SourcesPanel />);
    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: {
        files: [new File([JSON.stringify(wordsPayload("rebuild"))], "manual.json")],
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Reconstruir timeline com a transcrição" })
    );
    expect(useRepurposeStore.getState().clips[0]?.id).not.toBe("edited");
    expect(useRepurposeStore.getState().overlays[0]?.id).toBe(overlayId);
  });

  it("builds a final-transcript candidate from current store words", async () => {
    useRepurposeStore.getState().setClips([timelineClip()]);
    useRepurposeStore.getState().setWords([
      { text: "alpha", start: 0, end: 0.5 },
      { text: "beta", start: 0.5, end: 1 },
    ]);
    render(<SourcesPanel />);
    fireEvent.change(ingestInput("Load final transcript (.srt)"), {
      target: { files: [new File(["alpha beta"], "final.txt", { type: "text/plain" })] },
    });

    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Reconstruir timeline com a transcrição" })
    );
    expect(useRepurposeStore.getState().words.map((word) => word.text)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("rebuilds a deferred manual raw transcript when the shared duration expands", async () => {
    setDualFootage(6, 8);
    useRepurposeStore.getState().setClips([timelineClip("edited", 0, 6)]);
    const words = expansionWords();
    render(<SourcesPanel />);

    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: {
        files: [
          new File(
            [JSON.stringify({ text: words.map((word) => word.text).join(" "), words })],
            "expanding.words.json",
            { type: "application/json" }
          ),
        ],
      },
    });
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar depois" }));

    act(() => setDualFootage(7, 8));
    fireEvent.click(screen.getByRole("button", { name: "Revisar transcrição pendente" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reconstruir timeline com a transcrição" })
    );

    const state = useRepurposeStore.getState();
    expect(Math.max(...state.clips.map((clip) => clip.srcEnd))).toBe(7);
    expect(state.words).toEqual(words);
  });

  it("rebuilds deferred manual final clips and stats at the expanded shared duration", async () => {
    setDualFootage(5, 8);
    useRepurposeStore.getState().setClips([timelineClip("edited", 0, 5)]);
    const phrase = ["ship", "clean", "edits", "with", "reliable", "captions", "every", "time"];
    const words = [
      ...phrase.map((text, index) => ({
        text,
        start: index * 0.5,
        end: (index + 1) * 0.5,
      })),
      ...phrase.map((text, index) => ({
        text,
        start: 4.5 + index * 0.4375,
        end: 4.5 + (index + 1) * 0.4375,
      })),
    ];
    useRepurposeStore.getState().setWords(words);
    render(<SourcesPanel />);

    fireEvent.change(ingestInput("Load final transcript (.srt)"), {
      target: {
        files: [
          new File([`${phrase.join(" ")}.`], "final.txt", {
            type: "text/plain",
          }),
        ],
      },
    });
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar depois" }));

    act(() => setDualFootage(8, 8));
    fireEvent.click(screen.getByRole("button", { name: "Revisar transcrição pendente" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reconstruir timeline com a transcrição" })
    );

    const state = useRepurposeStore.getState();
    expect(state.clips.filter((clip) => clip.kept)).toEqual([
      expect.objectContaining({ srcStart: 4.5, srcEnd: 8 }),
    ]);
    expect(state.words).toEqual(words);
    expect(state.editStats).toMatchObject({
      retakesRemoved: 1,
      finalRuntimeSec: 3.5,
    });
  });

  it("invalidates a stale transcript callback as soon as a Face import begins", async () => {
    setDualFootage(8, 8);
    const originalClip = timelineClip("edited", 0, 8);
    useRepurposeStore.getState().setClips([originalClip]);
    importVideoFileMock.mockImplementation(() => new Promise(() => undefined));
    render(<SourcesPanel />);

    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: {
        files: [
          new File([JSON.stringify(wordsPayload("stale"))], "stale.words.json", {
            type: "application/json",
          }),
        ],
      },
    });
    expect(await screen.findByRole("dialog")).toBeVisible();
    const staleApplyRebuilding = transcriptDialogCapture.rebuild;
    expect(staleApplyRebuilding).toBeDefined();

    fireEvent.change(sourceInput("Face"), {
      target: {
        files: [new File(["replacement"], "replacement.mov", { type: "video/quicktime" })],
      },
    });
    act(() => staleApplyRebuilding?.());

    expect(useRepurposeStore.getState().clips).toEqual([originalClip]);
    expect(useRepurposeStore.getState().words).toEqual([]);
    expect(importVideoFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not offer a raw transcript whose file read finishes after Face replacement begins", async () => {
    setDualFootage(8, 8);
    const originalClip = timelineClip("edited", 0, 8);
    useRepurposeStore.getState().setClips([originalClip]);
    importVideoFileMock.mockImplementation(() => new Promise(() => undefined));
    let resolveText!: (text: string) => void;
    const transcript = new File([], "stale.words.json", {
      type: "application/json",
    });
    vi.spyOn(transcript, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveText = resolve;
        })
    );
    render(<SourcesPanel />);

    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: { files: [transcript] },
    });
    await waitFor(() => expect(resolveText).toBeDefined());
    fireEvent.change(sourceInput("Face"), {
      target: {
        files: [new File(["replacement"], "replacement.mov", { type: "video/quicktime" })],
      },
    });
    await act(async () => resolveText(JSON.stringify(wordsPayload("stale-read"))));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Revisar transcrição pendente" })).toBeNull();
    expect(useRepurposeStore.getState().clips).toEqual([originalClip]);
    expect(useRepurposeStore.getState().words).toEqual([]);
  });

  it("does not offer a final transcript whose file read finishes after Face replacement begins", async () => {
    setDualFootage(8, 8);
    const originalClip = timelineClip("edited", 0, 8);
    const originalWords = wordsPayload("existing").words;
    useRepurposeStore.getState().setClips([originalClip]);
    useRepurposeStore.getState().setWords(originalWords);
    importVideoFileMock.mockImplementation(() => new Promise(() => undefined));
    let resolveText!: (text: string) => void;
    const transcript = new File([], "stale-final.txt", { type: "text/plain" });
    vi.spyOn(transcript, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveText = resolve;
        })
    );
    render(<SourcesPanel />);

    fireEvent.change(ingestInput("Load final transcript (.srt)"), {
      target: { files: [transcript] },
    });
    await waitFor(() => expect(resolveText).toBeDefined());
    fireEvent.change(sourceInput("Face"), {
      target: {
        files: [new File(["replacement"], "replacement.mov", { type: "video/quicktime" })],
      },
    });
    await act(async () => resolveText("existing words only"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Revisar transcrição pendente" })).toBeNull();
    expect(useRepurposeStore.getState().clips).toEqual([originalClip]);
    expect(useRepurposeStore.getState().words).toEqual(originalWords);
  });

  it("invalidates a pending manual decision on project switch", async () => {
    useRepurposeStore.getState().setClips([timelineClip()]);
    render(<SourcesPanel />);
    fireEvent.change(ingestInput("Load raw transcript (.srt / .json)"), {
      target: { files: [new File([JSON.stringify(wordsPayload("old"))], "old.json")] },
    });
    expect(await screen.findByRole("dialog")).toBeVisible();

    act(() => useRepurposeStore.getState().resetProject());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Revisar transcrição pendente" })).toBeNull();
  });
});

describe("useTranscriptApplication automatic offers", () => {
  it.each([
    [{ kind: "ready", words: [], clips: [], stats: null, origin: "automatic" } as TranscriptOffer, "no-speech"],
    [{ kind: "no-shared-speech", origin: "automatic" } as TranscriptOffer, "no-shared-speech"],
  ])("distinguishes empty engine speech from no shared speech", async (offer, notice) => {
    render(<TranscriptApplicationHarness offer={offer} />);
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent(notice));
    expect(useRepurposeStore.getState().words).toEqual([]);
  });

  it("waits for Screen, then automatically applies and bounds an untouched automatic offer", async () => {
    const faceCamSource = videoSource("face", 1920, 8);
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "/face",
      screenPath: "",
      faceCamSource,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    const offer: TranscriptOffer = {
      kind: "ready",
      words: [
        { text: "inside", start: 0, end: 1 },
        { text: "boundary", start: 1, end: 7 },
      ],
      clips: [timelineClip("automatic", 0, 7)],
      stats: null,
      origin: "automatic",
    };
    render(<TranscriptApplicationHarness offer={offer} />);
    expect(screen.getByTestId("pending")).toHaveTextContent("pending");
    expect(useRepurposeStore.getState().words).toEqual([]);

    act(() => setDualFootage(5, 8));

    await waitFor(() => expect(useRepurposeStore.getState().words).toEqual(offer.words));
    expect(useRepurposeStore.getState().clips[0].srcEnd).toBe(5);
  });

  it("re-bounds an apply-later offer against the current Screen duration without another request", async () => {
    setDualFootage(8, 8);
    useRepurposeStore.getState().setClips([timelineClip("edited", 0, 8)]);
    const offer: TranscriptOffer = {
      kind: "ready",
      words: [
        { text: "inside", start: 0, end: 1 },
        { text: "boundary", start: 1, end: 7 },
      ],
      clips: [timelineClip("automatic", 0, 7)],
      stats: null,
      origin: "automatic",
    };
    render(<TranscriptApplicationHarness offer={offer} />);
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar depois" }));
    act(() => setDualFootage(4, 8));
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reconstruir timeline com a transcrição" })
    );

    expect(useRepurposeStore.getState().clips[0].srcEnd).toBe(4);
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/transcription/jobs"),
      expect.anything()
    );
  });

  it("rebuilds an apply-later offer from full words after the shared duration expands", async () => {
    setDualFootage(4, 8);
    useRepurposeStore.getState().setClips([timelineClip("edited", 0, 4)]);
    const offer: TranscriptOffer = {
      kind: "ready",
      words: [
        { text: "inside", start: 0, end: 1 },
        { text: "recovered", start: 1, end: 7 },
      ],
      clips: [timelineClip("automatic", 0, 4)],
      stats: {
        retakesRemoved: 99,
        silencesTrimmed: 99,
        secondsSaved: 99,
        finalRuntimeSec: 4,
      },
      origin: "automatic",
    };
    render(<TranscriptApplicationHarness offer={offer} />);
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar depois" }));

    act(() => setDualFootage(8, 8));
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reconstruir timeline com a transcrição" })
    );

    expect(useRepurposeStore.getState().clips[0].srcEnd).toBe(7);
    expect(useRepurposeStore.getState().editStats).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/transcription/jobs"),
      expect.anything()
    );
  });

  it("invalidates pending state and stale apply callbacks when Face is replaced in the same project", async () => {
    setDualFootage(8, 8);
    const originalClip = timelineClip("edited", 0, 8);
    useRepurposeStore.getState().setClips([originalClip]);
    const offer: TranscriptOffer = {
      kind: "ready",
      words: [{ text: "stale", start: 0, end: 1 }],
      clips: [timelineClip("automatic", 0, 1)],
      stats: null,
      origin: "automatic",
    };
    let staleApplyRebuilding: (() => void) | undefined;
    render(
      <TranscriptApplicationHarness
        offer={offer}
        captureRebuild={(callback) => {
          staleApplyRebuilding ??= callback;
        }}
      />
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(staleApplyRebuilding).toBeDefined();
    const epoch = useRepurposeStore.getState().projectEpoch;

    act(() => {
      const current = useRepurposeStore.getState().footageMeta!;
      useRepurposeStore.getState().setFootageMeta({
        ...current,
        faceCamPath: "/replacement-face",
        faceCamSource: videoSource("replacement-face", 1920, 8),
      });
    });

    await waitFor(() => expect(screen.getByTestId("pending")).toHaveTextContent("none"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useRepurposeStore.getState().projectEpoch).toBe(epoch);
    act(() => staleApplyRebuilding?.());
    expect(useRepurposeStore.getState().clips).toEqual([originalClip]);
    expect(useRepurposeStore.getState().words).toEqual([]);
  });
});

describe("SourcesPanel automatic transcription", () => {
  function transcriptionFetch(statuses: TranscriptionStatus[]) {
    let statusIndex = 0;
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/repurpose/transcription/jobs")) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (init?.method === "POST") {
        const observerId = JSON.parse(String(init.body)).observerId;
        return Promise.resolve(
          new Response(JSON.stringify({ jobId: observerId }), { status: 202 })
        );
      }
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const status = statuses[Math.min(statusIndex++, statuses.length - 1)];
      return Promise.resolve(
        new Response(JSON.stringify(status), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
  }

  function completedStatus(words = wordsPayload("automática").words): TranscriptionStatus {
    return {
      jobId: "11111111-1111-4111-8111-111111111111",
      state: "completed",
      phase: "finalizing",
      progress: 1,
      device: "cuda",
      warning: null,
      result: {
        words,
        language: "pt",
        languageProbability: 0.98,
        device: "cuda",
      },
      error: null,
    };
  }

  beforeEach(() => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111"
    );
  });

  it("keeps Transcrever áudio outside collapsed re-import controls with Portuguese default and local privacy copy", () => {
    setDualFootage();
    render(<SourcesPanel />);

    const details = screen.getByText("Re-import footage", { exact: true }).closest("details");
    const transcribe = screen.getByRole("button", { name: "Transcrever áudio" });
    expect(details).not.toContainElement(transcribe);
    expect(screen.getByRole("combobox", { name: "Idioma da transcrição" })).toHaveTextContent(
      "Português"
    );
    expect(document.body).toHaveTextContent("dependências locais do Python");
    expect(document.body).toHaveTextContent("nunca saem deste computador");
    expect(document.body).toHaveTextContent("offline");
  });

  it("shows disabled re-import guidance for a legacy Face source", () => {
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "/legacy-face",
      screenPath: "/legacy-screen",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    render(<SourcesPanel />);

    expect(screen.getByRole("button", { name: "Transcrever áudio" })).toBeDisabled();
    expect(screen.getByText("Reimporte o vídeo Face para transcrever")).toBeVisible();
  });

  it("renders phase, progress, device, fallback, and cancellation controls", async () => {
    setDualFootage();
    const warning = {
      code: "TRANSCRIPTION_GPU_FALLBACK" as const,
      message: "GPU indisponível; continuando na CPU." as const,
    };
    const status: TranscriptionStatus = {
      jobId: "11111111-1111-4111-8111-111111111111",
      state: "running",
      phase: "extracting-audio",
      progress: 0.42,
      device: "cpu",
      warning,
      result: null,
      error: null,
    };
    const fetchMock = transcriptionFetch([status]);
    vi.stubGlobal("fetch", fetchMock);
    render(<SourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));

    expect(await screen.findByText("Extraindo áudio do Face")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Progresso da transcrição" })).toHaveAttribute(
      "value",
      "0.42"
    );
    expect(screen.getByText("CPU")).toBeVisible();
    expect(screen.getByText("GPU indisponível; continuando na CPU.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/repurpose/transcription/jobs/"),
        expect.objectContaining({ method: "DELETE" })
      )
    );
    expect(await screen.findByText("Transcrição cancelada.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  });

  it("shows model setup and GPU transcription presentation", async () => {
    setDualFootage();
    const fetchMock = transcriptionFetch([
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        state: "running",
        phase: "downloading-model",
        progress: null,
        device: "cuda",
        warning: null,
        result: null,
        error: null,
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<SourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));

    expect(await screen.findByText("Baixando modelo local")).toBeVisible();
    expect(screen.getByText("GPU NVIDIA")).toBeVisible();
    expect(screen.getByText(/áudio permanece neste computador/i)).toBeVisible();
  });

  it("automatically applies speech to an untouched timeline and enables captions", async () => {
    setDualFootage(8, 8);
    vi.stubGlobal("fetch", transcriptionFetch([completedStatus()]));
    render(<SourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));

    await waitFor(() =>
      expect(useRepurposeStore.getState().words[0]?.text).toBe("automática")
    );
    expect(useRepurposeStore.getState().captionsEnabled).toBe(true);
    expect(screen.getByText(/3 palavras transcritas/)).toBeVisible();
  });

  it("waits for Screen, then re-bounds and applies the completed Face result", async () => {
    const faceCamSource = videoSource("face", 1920, 8);
    useRepurposeStore.getState().setFootageMeta({
      faceCamPath: "/face",
      screenPath: "",
      faceCamSource,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: 8,
    });
    const words = [
      { text: "dentro", start: 0, end: 1 },
      { text: "limite", start: 1, end: 7 },
    ];
    vi.stubGlobal("fetch", transcriptionFetch([completedStatus(words)]));
    render(<SourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));
    expect(await screen.findByText("Aguardando vídeo Screen para aplicar a transcrição.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Revisar transcrição pendente" })
    ).toBeNull();
    expect(useRepurposeStore.getState().words).toEqual([]);

    act(() => setDualFootage(5, 8));
    await waitFor(() => expect(useRepurposeStore.getState().words).toEqual(words));
    expect(useRepurposeStore.getState().clips[0].srcEnd).toBe(5);
  });

  it("offers retranscription after a completed no-speech result", async () => {
    setDualFootage(8, 8);
    vi.stubGlobal("fetch", transcriptionFetch([completedStatus([])]));
    render(<SourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));

    expect(await screen.findByText("Nenhuma fala detectada")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Transcrever novamente" })
    ).toBeEnabled();
  });

  it("shows detected language and confidence for automatic completion", () => {
    const start = vi.fn(async () => undefined);
    const autoStatus = completedStatus();
    if (autoStatus.state !== "completed") throw new Error("Expected completed status");
    const transcription: UseTranscriptionResult = {
      language: "auto",
      setLanguage: vi.fn(),
      status: {
        ...autoStatus,
        result: {
          ...autoStatus.result,
          language: "en",
          languageProbability: 0.876,
        },
      },
      error: null,
      start,
      cancel: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      available: true,
    };

    render(
      <TranscriptionControls
        transcription={transcription}
        legacyFace={false}
        notice={null}
        hasPendingApplication={false}
        waitingForScreen={false}
      />
    );

    expect(screen.getByText(/Idioma detectado: en.*88%/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Transcrever novamente" }));
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([
    [[], "Nenhuma fala detectada"],
    [[{ text: "fora", start: 9, end: 10 }], "Nenhuma fala coincide com a duração compartilhada dos vídeos"],
  ])("reports no-speech outcomes without mutating the timeline", async (words, message) => {
    setDualFootage(8, 8);
    const before = useRepurposeStore.getState().clips;
    vi.stubGlobal("fetch", transcriptionFetch([completedStatus(words)]));
    render(<SourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));

    expect(await screen.findByText(message)).toBeVisible();
    expect(useRepurposeStore.getState().words).toEqual([]);
    expect(useRepurposeStore.getState().clips).toEqual(before);
  });

  it("opens the existing edited-timeline dialog and preserves cuts", async () => {
    setDualFootage(8, 8);
    useRepurposeStore.getState().setClips([timelineClip("edited", 0, 8)]);
    vi.stubGlobal("fetch", transcriptionFetch([completedStatus()]));
    render(<SourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /framing.*transitions.*punches.*SFX.*recovery/i
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preservar cortes e adicionar legendas" })
    );

    expect(useRepurposeStore.getState().clips).toEqual([timelineClip("edited", 0, 8)]);
    expect(useRepurposeStore.getState().words[0]?.text).toBe("automática");
    expect(useRepurposeStore.getState().captionsEnabled).toBe(true);
  });

  it("cancels the observer as soon as Face replacement begins", async () => {
    setDualFootage(8, 8);
    importVideoFileMock.mockImplementation(() => new Promise(() => undefined));
    const runningStatus: TranscriptionStatus = {
      jobId: "11111111-1111-4111-8111-111111111111",
      state: "running",
      phase: "transcribing",
      progress: null,
      device: "cuda",
      warning: null,
      result: null,
      error: null,
    };
    const fetchMock = transcriptionFetch([runningStatus]);
    vi.stubGlobal("fetch", fetchMock);
    render(<SourcesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transcrever áudio" }));
    expect(await screen.findByText("Transcrevendo áudio")).toBeVisible();

    fireEvent.change(sourceInput("Face"), {
      target: { files: [new File(["face"], "replacement.mov", { type: "video/quicktime" })] },
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/repurpose/transcription/jobs/"),
        expect.objectContaining({ method: "DELETE" })
      )
    );
  });
});
