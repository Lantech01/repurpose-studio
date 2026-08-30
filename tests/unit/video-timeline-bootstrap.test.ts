import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRepurposeStore } from "@/lib/repurpose/store";
import { splitRatioAt } from "@/lib/repurpose/time-map";
import type { Clip, FootageMeta, VideoSourceRecord, Word } from "@/lib/repurpose/types";

const BOOTSTRAP_ID = "video-full-span";

function source(name: string, durationSec: number): VideoSourceRecord {
  return {
    originalPath: `C:\\media\\${name}.mp4`,
    workingPath: `C:\\media\\${name}.mp4`,
    originalName: `${name}.mp4`,
    inspection: {
      fingerprint: name.padEnd(64, "a").slice(0, 64),
      container: "mov,mp4",
      extension: ".mp4",
      size: 1_024,
      durationSec,
      video: {
        codec: "h264",
        codecTag: "avc1",
        profile: "Main",
        pixelFormat: "yuv420p",
        width: 1920,
        height: 1080,
        fps: 30,
      },
      audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
    },
    nativeCompatible: true,
    compatibilityStatus: "native",
  };
}

function footage(screenDuration?: number, faceDuration?: number): FootageMeta {
  const screenSource =
    screenDuration === undefined ? undefined : source("screen", screenDuration);
  const faceCamSource =
    faceDuration === undefined ? undefined : source("face", faceDuration);
  return {
    faceCamPath: faceCamSource ? "/face" : "",
    screenPath: screenSource ? "/screen" : "",
    faceCamSource,
    screenSource,
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: faceDuration ?? screenDuration ?? 0,
  };
}

function expectBootstrap(duration: number): void {
  expect(useRepurposeStore.getState()).toMatchObject({
    clips: [
      {
        id: BOOTSTRAP_ID,
        srcStart: 0,
        srcEnd: duration,
        timelineStart: 0,
        timelineEnd: duration,
        kept: true,
      },
    ],
    duration,
  });
}

function initializeBootstrap(
  screenDuration = 12,
  faceDuration = 8
): void {
  useRepurposeStore.getState().setFootageMeta(footage(screenDuration));
  useRepurposeStore
    .getState()
    .setFootageMeta(footage(screenDuration, faceDuration));
  expectBootstrap(Math.min(screenDuration, faceDuration));
}

const transcriptWords: Word[] = [
  { text: "Transcript", start: 1, end: 1.5 },
  { text: "timeline", start: 1.5, end: 2 },
];

const transcriptClip: Clip = {
  id: "transcript-clip",
  kind: "take",
  label: "Transcript clip",
  srcStart: 1,
  srcEnd: 2,
  timelineStart: 0,
  timelineEnd: 1,
  kept: true,
  isKeeperTake: true,
  occurrences: [{ start: 1, end: 2 }],
  keeperIndex: 0,
};

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
});

it("canonicalizes repeated frame steps onto the FPS grid at a half-open cut", () => {
  const first = { ...transcriptClip, id: "first", srcStart: 0, srcEnd: 0.5, timelineEnd: 0.5, splitRatio: 0 };
  const second = {
    ...transcriptClip,
    id: "second",
    srcStart: 0.5,
    srcEnd: 1.1,
    timelineStart: 0.5,
    timelineEnd: 1.1,
    splitRatio: 1,
  };
  useRepurposeStore.setState({
    clips: [first, second],
    duration: 1.1,
    footageMeta: footage(1.1, 1.1),
    playhead: 0,
  });

  for (let frame = 0; frame < 15; frame += 1) {
    useRepurposeStore.getState().stepFrame(1);
  }

  const playhead = useRepurposeStore.getState().playhead;
  expect(playhead).toBe(0.5);
  expect(splitRatioAt([first, second], playhead, 0.5)).toBe(1);
});

describe("video timeline bootstrap", () => {
  it.each([
    { screenDuration: 12, faceDuration: 8, expected: 8 },
    { screenDuration: 6, faceDuration: 11, expected: 6 },
  ])(
    "waits for both sources and uses the shorter duration ($expected seconds)",
    ({ screenDuration, faceDuration, expected }) => {
      useRepurposeStore
        .getState()
        .setFootageMeta(footage(screenDuration));
      expect(useRepurposeStore.getState()).toMatchObject({ clips: [], duration: 0 });

      useRepurposeStore
        .getState()
        .setFootageMeta(footage(screenDuration, faceDuration));
      expectBootstrap(expected);
    }
  );

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not initialize from an invalid source duration (%s)",
    (invalidDuration) => {
      useRepurposeStore
        .getState()
        .setFootageMeta(footage(12, invalidDuration));

      expect(useRepurposeStore.getState()).toMatchObject({ clips: [], duration: 0 });
    }
  );

  it("preserves transcript-derived and existing timelines", () => {
    useRepurposeStore.getState().setClips([transcriptClip]);
    useRepurposeStore.getState().setWords(transcriptWords);

    useRepurposeStore.getState().setFootageMeta(footage(12, 8));

    expect(useRepurposeStore.getState()).toMatchObject({
      clips: [transcriptClip],
      duration: 1,
      words: transcriptWords,
    });
  });

  it("preserves overlays and keeps Undo and Redo on a playable timeline", () => {
    const overlayId = useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/overlay.png",
      naturalWidth: 800,
      naturalHeight: 600,
      atTime: 0,
    });

    initializeBootstrap();
    expect(useRepurposeStore.getState().overlays).toHaveLength(1);
    expect(useRepurposeStore.getState().past[0].clips[0]?.id).toBe(BOOTSTRAP_ID);

    useRepurposeStore.getState().undo();
    expectBootstrap(8);
    expect(useRepurposeStore.getState().overlays).toEqual([]);

    useRepurposeStore.getState().redo();
    expectBootstrap(8);
    expect(useRepurposeStore.getState().overlays[0]?.id).toBe(overlayId);
  });

  it("resizes a pristine bootstrap after source re-import", () => {
    initializeBootstrap(12, 8);

    useRepurposeStore.getState().setFootageMeta(footage(12, 5));

    expectBootstrap(5);
  });

  it("preserves a trimmed bootstrap on source re-import", () => {
    initializeBootstrap();
    useRepurposeStore.getState().trimClip(BOOTSTRAP_ID, "end", 7);

    useRepurposeStore.getState().setFootageMeta(footage(12, 5));

    expect(useRepurposeStore.getState()).toMatchObject({
      duration: 7,
      clips: [{ id: BOOTSTRAP_ID, srcEnd: 7, timelineEnd: 7 }],
    });
  });

  it("preserves a split bootstrap on source re-import", () => {
    initializeBootstrap();
    useRepurposeStore.getState().splitClipAtPlayhead(4);
    const before = useRepurposeStore.getState().clips;

    useRepurposeStore.getState().setFootageMeta(footage(12, 5));

    expect(useRepurposeStore.getState().clips).toEqual(before);
  });

  it("preserves duplicated and reordered clips on source re-import", () => {
    initializeBootstrap();
    useRepurposeStore.getState().duplicateClip(BOOTSTRAP_ID);
    const duplicateId = useRepurposeStore.getState().clips[1].id;
    useRepurposeStore.getState().reorderClips(duplicateId, 0);
    const before = useRepurposeStore.getState().clips;

    useRepurposeStore.getState().setFootageMeta(footage(12, 5));

    expect(useRepurposeStore.getState().clips).toEqual(before);
  });

  it("preserves a deleted bootstrap on source re-import", () => {
    initializeBootstrap();
    useRepurposeStore.getState().deleteClip(BOOTSTRAP_ID);

    useRepurposeStore.getState().setFootageMeta(footage(12, 5));

    expect(useRepurposeStore.getState()).toMatchObject({
      duration: 0,
      clips: [{ id: BOOTSTRAP_ID, kept: false, srcEnd: 8 }],
    });
  });

  it("resizes a styled bootstrap and its pristine history without losing style", () => {
    initializeBootstrap();
    useRepurposeStore.getState().setClipSplitRatio(BOOTSTRAP_ID, 0.2);

    useRepurposeStore.getState().setFootageMeta(footage(12, 5));

    expect(useRepurposeStore.getState().clips[0]).toMatchObject({
      id: BOOTSTRAP_ID,
      srcEnd: 5,
      timelineEnd: 5,
      splitRatio: 0.2,
    });
    expect(useRepurposeStore.getState().past[0].clips[0]).toMatchObject({
      id: BOOTSTRAP_ID,
      srcEnd: 5,
      timelineEnd: 5,
    });
  });
});

function scene(id: string, start: number, splitRatio?: number): Clip {
  return {
    id,
    kind: "take",
    label: id,
    srcStart: start,
    srcEnd: start + 1,
    timelineStart: start,
    timelineEnd: start + 1,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start, end: start + 1 }],
    keeperIndex: 0,
    splitRatio,
  };
}

function beginSplitGesture(
  target: { kind: "clip"; id: string } | { kind: "global" }
): string {
  const token = useRepurposeStore.getState().beginSplitRatioGesture(target);
  expect(token).toEqual(expect.any(String));
  return token as unknown as string;
}

function addTestOverlay(): string {
  const id = useRepurposeStore.getState().addOverlay({
    kind: "image",
    src: "/overlay.png",
    naturalWidth: 800,
    naturalHeight: 600,
    atTime: 0,
  });
  useRepurposeStore.setState({ past: [], future: [] });
  return id;
}

function seedCaptionBlock(
  overrideStyle: Record<string, unknown> = {
    fill: "#123456",
    pinToSplit: true,
  }
): string {
  const id = "caption-gesture-target";
  const words = [{ text: "Caption", start: 0, end: 0.8 }];
  useRepurposeStore.setState({
    clips: [scene("caption-scene", 0)],
    duration: 1,
    words,
    captionBlocks: [
      {
        id,
        words,
        start: 0,
        end: 0.8,
        overrideStyle,
      },
    ],
    past: [],
    future: [],
  });
  return id;
}

function beginCaptionGesture(id: string): string {
  const token = useRepurposeStore.getState().beginCaptionGesture(id);
  expect(token).toEqual(expect.any(String));
  return token as unknown as string;
}

describe("overlay appearance authoring", () => {
  it("stamps normalized appearance defaults on new overlays", () => {
    const id = addTestOverlay();

    expect(
      useRepurposeStore.getState().overlays.find((overlay) => overlay.id === id)
    ).toMatchObject({
      entranceEffect: { type: "none", durationSec: 0.35 },
      exitEffect: { type: "none", durationSec: 0.35 },
      cornerRadius: 0,
    });
  });

  it("normalizes discrete effects and radius into separate Undo steps", () => {
    const id = addTestOverlay();

    useRepurposeStore.getState().setOverlayEntranceEffect(id, {
      type: "slide",
      durationSec: 9,
      direction: "down",
    });
    useRepurposeStore.getState().setOverlayExitEffect(id, {
      type: "fade",
      durationSec: 0,
      direction: "right",
    });
    useRepurposeStore.getState().setOverlayCornerRadius(id, 0.8);

    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      entranceEffect: { type: "slide", durationSec: 2, direction: "down" },
      exitEffect: { type: "fade", durationSec: 0.1 },
      cornerRadius: 0.5,
    });
    expect(useRepurposeStore.getState().overlays[0].exitEffect).not.toHaveProperty(
      "direction"
    );
    expect(useRepurposeStore.getState().past).toHaveLength(3);

    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0].exitEffect).toEqual({
      type: "none",
      durationSec: 0.35,
    });
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().overlays[0].exitEffect).toEqual({
      type: "fade",
      durationSec: 0.1,
    });
  });

  it("suppresses invalid and normalized no-op discrete writes", () => {
    const id = addTestOverlay();
    const before = useRepurposeStore.getState();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore.subscribe(listener);

    useRepurposeStore.getState().setOverlayEntranceEffect(id, {
      type: "none",
      durationSec: 0.35,
    });
    useRepurposeStore.getState().setOverlayCornerRadius(id, Number.NaN);
    useRepurposeStore.getState().setOverlayCornerRadius("missing", 0.2);
    unsubscribe();

    expect(useRepurposeStore.getState().overlays).toBe(before.overlays);
    expect(useRepurposeStore.getState().past).toBe(before.past);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "entrance",
      field: "entranceDuration" as const,
      preview: 0.9,
      setOriginal: (id: string) =>
        useRepurposeStore.getState().setOverlayEntranceEffect(id, {
          type: "none",
          durationSec: 0.35,
        }),
      read: () => useRepurposeStore.getState().overlays[0].entranceEffect,
      original: { type: "none", durationSec: 0.35 },
    },
    {
      label: "exit",
      field: "exitDuration" as const,
      preview: 1.1,
      setOriginal: (id: string) =>
        useRepurposeStore.getState().setOverlayExitEffect(id, {
          type: "none",
          durationSec: 0.35,
        }),
      read: () => useRepurposeStore.getState().overlays[0].exitEffect,
      original: { type: "none", durationSec: 0.35 },
    },
    {
      label: "radius",
      field: "cornerRadius" as const,
      preview: 0.4,
      setOriginal: (id: string) =>
        useRepurposeStore.getState().setOverlayCornerRadius(id, 0),
      read: () => useRepurposeStore.getState().overlays[0].cornerRadius,
      original: 0,
    },
  ])(
    "cancels a provisional $label gesture before original-value no-op comparison",
    ({ field, preview, setOriginal, read, original }) => {
      const id = addTestOverlay();
      useRepurposeStore.getState().addMarker(0.25);
      useRepurposeStore.getState().undo();
      const prePast = useRepurposeStore.getState().past;
      const preFuture = useRepurposeStore.getState().future;
      const token = useRepurposeStore
        .getState()
        .beginOverlayAppearanceGesture(id, field) as string;
      const listener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeOverlayAppearanceGestureCancellation(listener);
      useRepurposeStore
        .getState()
        .updateOverlayAppearanceGesture(token, preview);

      setOriginal(id);
      useRepurposeStore.getState().cancelOverlayAppearanceGesture(token);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(read()).toEqual(original);
      expect(useRepurposeStore.getState().past).toBe(prePast);
      expect(useRepurposeStore.getState().future).toBe(preFuture);
      unsubscribe();
    }
  );

  it.each([
    {
      label: "entrance",
      field: "entranceDuration" as const,
      preview: 0.9,
      setDifferent: (id: string) =>
        useRepurposeStore.getState().setOverlayEntranceEffect(id, {
          type: "slide",
          durationSec: 0.6,
          direction: "right",
        }),
      read: () => useRepurposeStore.getState().overlays[0].entranceEffect,
      expected: { type: "slide", durationSec: 0.6, direction: "right" },
      original: { type: "none", durationSec: 0.35 },
    },
    {
      label: "exit",
      field: "exitDuration" as const,
      preview: 1.1,
      setDifferent: (id: string) =>
        useRepurposeStore.getState().setOverlayExitEffect(id, {
          type: "fade",
          durationSec: 0.7,
        }),
      read: () => useRepurposeStore.getState().overlays[0].exitEffect,
      expected: { type: "fade", durationSec: 0.7 },
      original: { type: "none", durationSec: 0.35 },
    },
    {
      label: "radius",
      field: "cornerRadius" as const,
      preview: 0.4,
      setDifferent: (id: string) =>
        useRepurposeStore.getState().setOverlayCornerRadius(id, 0.2),
      read: () => useRepurposeStore.getState().overlays[0].cornerRadius,
      expected: 0.2,
      original: 0,
    },
  ])(
    "records one direct $label edit after cancelling its provisional gesture",
    ({ field, preview, setDifferent, read, expected, original }) => {
      const id = addTestOverlay();
      const token = useRepurposeStore
        .getState()
        .beginOverlayAppearanceGesture(id, field) as string;
      const listener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeOverlayAppearanceGestureCancellation(listener);
      useRepurposeStore
        .getState()
        .updateOverlayAppearanceGesture(token, preview);

      setDifferent(id);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(read()).toEqual(expected);
      expect(useRepurposeStore.getState().past).toHaveLength(1);
      expect(useRepurposeStore.getState().future).toEqual([]);
      useRepurposeStore.getState().undo();
      expect(read()).toEqual(original);
      useRepurposeStore.getState().redo();
      expect(read()).toEqual(expected);
      unsubscribe();
    }
  );

  it("records one history entry for a long explicit slider gesture", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const id = addTestOverlay();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius");
    expect(token).toEqual(expect.any(String));

    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(token as string, 0);
    expect(useRepurposeStore.getState().past).toEqual([]);

    now.mockReturnValue(1_000);
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(token as string, 0.04);
    now.mockReturnValue(2_000);
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(token as string, 0.16);
    useRepurposeStore
      .getState()
      .endOverlayAppearanceGesture(token as string);

    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0.16);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    now.mockRestore();
  });

  it("clamps effect duration gestures and ignores stale or invalid updates", () => {
    const id = addTestOverlay();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "entranceDuration");

    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(token as string, 9);
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(token as string, Number.NaN);
    useRepurposeStore
      .getState()
      .endOverlayAppearanceGesture(token as string);
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(token as string, 0.1);

    expect(useRepurposeStore.getState().overlays[0].entranceEffect).toEqual({
      type: "none",
      durationSec: 2,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("cancels atomically to the pre-gesture value and exact redo branch", () => {
    const id = addTestOverlay();
    useRepurposeStore.getState().setOverlayCornerRadius(id, 0.2);
    useRepurposeStore.getState().undo();
    const prePast = useRepurposeStore.getState().past;
    const preFuture = useRepurposeStore.getState().future;
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius");

    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(token as string, 0.4);
    expect(useRepurposeStore.getState().future).toEqual([]);
    useRepurposeStore
      .getState()
      .cancelOverlayAppearanceGesture(token as string);
    useRepurposeStore
      .getState()
      .cancelOverlayAppearanceGesture(token as string);

    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    expect(useRepurposeStore.getState().past).toBe(prePast);
    expect(useRepurposeStore.getState().future).toBe(preFuture);
    expect(listener).toHaveBeenCalledTimes(1);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0.2);
    unsubscribe();
  });

  it("cancels before Undo and Redo, then rejects the stale token", () => {
    const id = addTestOverlay();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    useRepurposeStore.getState().setOverlayCornerRadius(id, 0.2);
    const undoToken = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(undoToken, 0.4);
    useRepurposeStore.getState().undo();
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(undoToken, 0.3);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);

    const redoToken = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(redoToken, 0.1);
    useRepurposeStore.getState().redo();
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(redoToken, 0.3);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0.2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("cancels before a new gesture, project replacement, and reset", () => {
    const id = addTestOverlay();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    const first = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    useRepurposeStore.getState().updateOverlayAppearanceGesture(first, 0.2);
    const second = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "exitDuration") as string;
    useRepurposeStore.getState().updateOverlayAppearanceGesture(first, 0.4);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);

    useRepurposeStore.getState().updateOverlayAppearanceGesture(second, 0.7);
    useRepurposeStore.getState().setClips([scene("replacement", 0)]);
    useRepurposeStore.getState().updateOverlayAppearanceGesture(second, 1.2);
    expect(useRepurposeStore.getState().overlays).toEqual([]);

    const resetId = addTestOverlay();
    const resetToken = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(resetId, "cornerRadius") as string;
    useRepurposeStore.getState().updateOverlayAppearanceGesture(resetToken, 0.2);
    useRepurposeStore.getState().resetProject();
    useRepurposeStore.getState().updateOverlayAppearanceGesture(resetToken, 0.4);
    expect(useRepurposeStore.getState().overlays).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("does not publish for a missing target or a no-movement gesture", () => {
    const id = addTestOverlay();
    const before = useRepurposeStore.getState();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore.subscribe(listener);

    expect(
      useRepurposeStore
        .getState()
        .beginOverlayAppearanceGesture("missing", "cornerRadius")
    ).toBeNull();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0);
    useRepurposeStore.getState().endOverlayAppearanceGesture(token);
    unsubscribe();

    expect(useRepurposeStore.getState().overlays).toBe(before.overlays);
    expect(useRepurposeStore.getState().past).toBe(before.past);
    expect(listener).not.toHaveBeenCalled();
  });

  it("cancels before removing the gesture target and records only the deletion", () => {
    const id = addTestOverlay();
    useRepurposeStore.getState().setOverlayCornerRadius(id, 0.2);
    useRepurposeStore.getState().undo();
    const priorRedo = useRepurposeStore.getState().future;
    const listener = vi.fn();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.4);

    useRepurposeStore.getState().removeOverlay(id);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState()).toMatchObject({
      overlays: [],
      future: [],
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(priorRedo).toHaveLength(1);
    useRepurposeStore.getState().cancelOverlayAppearanceGesture(token);
    expect(listener).toHaveBeenCalledTimes(1);

    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      id,
      cornerRadius: 0,
    });
    expect(useRepurposeStore.getState().future).toHaveLength(1);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().overlays).toEqual([]);
    unsubscribe();
  });

  it("cancels before media-asset removal deletes the gesture target", () => {
    const sourcePath = "C:\\media\\shared-overlay.png";
    const assetId = useRepurposeStore.getState().addMediaAsset({
      kind: "image",
      name: "Shared overlay",
      src: "/shared-overlay.png",
      sourcePath,
      naturalWidth: 800,
      naturalHeight: 600,
    });
    const id = useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/shared-overlay.png",
      sourcePath,
      naturalWidth: 800,
      naturalHeight: 600,
      atTime: 0,
    });
    useRepurposeStore.setState({ past: [], future: [] });
    useRepurposeStore.getState().setOverlayCornerRadius(id, 0.2);
    useRepurposeStore.getState().undo();
    const listener = vi.fn();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.4);

    useRepurposeStore.getState().removeMediaAsset(assetId);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaAssets: [],
      overlays: [],
      future: [],
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      id,
      cornerRadius: 0,
    });
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().overlays).toEqual([]);
    unsubscribe();
  });

  it("cancels before a different overlay removal without reapplying preview state", () => {
    const targetId = addTestOverlay();
    const unrelatedId = addTestOverlay();
    useRepurposeStore.getState().setOverlayCornerRadius(targetId, 0.2);
    useRepurposeStore.getState().undo();
    const priorRedo = useRepurposeStore.getState().future;
    const listener = vi.fn();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(targetId, "cornerRadius") as string;
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.3);

    useRepurposeStore.getState().removeOverlay(unrelatedId);
    useRepurposeStore.getState().cancelOverlayAppearanceGesture(token);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays).toMatchObject([
      { id: targetId, cornerRadius: 0 },
    ]);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(useRepurposeStore.getState().future).toEqual([]);
    expect(priorRedo).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays).toMatchObject([
      { id: targetId, cornerRadius: 0 },
      { id: unrelatedId },
    ]);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().overlays).toMatchObject([
      { id: targetId, cornerRadius: 0 },
    ]);
    unsubscribe();
  });

  it("cancels centrally before unrelated marker history and leaves its token stale", () => {
    const id = addTestOverlay();
    useRepurposeStore.getState().setOverlayCornerRadius(id, 0.2);
    useRepurposeStore.getState().undo();
    const listener = vi.fn();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);

    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.4);
    expect(listener).not.toHaveBeenCalled();
    useRepurposeStore.getState().addMarker(0.25);
    useRepurposeStore.getState().endOverlayAppearanceGesture(token);
    useRepurposeStore.getState().cancelOverlayAppearanceGesture(token);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    expect(useRepurposeStore.getState().markers).toHaveLength(1);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(useRepurposeStore.getState().future).toEqual([]);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().markers).toEqual([]);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().markers).toHaveLength(1);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    unsubscribe();
  });

  it("does not let an overlay mutation reapply the cancelled preview value", () => {
    const id = addTestOverlay();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.4);

    useRepurposeStore.getState().updateOverlayTransform(id, { x: 0.6 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      cornerRadius: 0,
      transform: { x: 0.6 },
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      cornerRadius: 0,
      transform: { x: 0.5 },
    });
    unsubscribe();
  });

  it("cancels before clip deletion cascades to the gesture target", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    const id = addTestOverlay();
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(id, "cornerRadius") as string;
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.4);

    useRepurposeStore.getState().deleteClip("scene");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays).toEqual([]);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      id,
      cornerRadius: 0,
    });
    unsubscribe();
  });

  it("copies normalized appearance from the caller-supplied effective primary", () => {
    const sourceId = addTestOverlay();
    const otherId = addTestOverlay();
    useRepurposeStore.getState().selectOverlay(otherId);
    useRepurposeStore.getState().setOverlayEntranceEffect(sourceId, {
      type: "slide",
      durationSec: 0.6,
      direction: "right",
    });
    useRepurposeStore.getState().setOverlayExitEffect(sourceId, {
      type: "pop",
      durationSec: 0.8,
    });
    useRepurposeStore.getState().setOverlayCornerRadius(sourceId, 0.2);

    expect(useRepurposeStore.getState().copySelectedAttributes(sourceId)).toBe(true);
    const source = useRepurposeStore
      .getState()
      .overlays.find((overlay) => overlay.id === sourceId)!;
    const clipboard = useRepurposeStore.getState().attributeClipboard;
    expect(clipboard).toMatchObject({
      kind: "overlay",
      entranceEffect: { type: "slide", durationSec: 0.6, direction: "right" },
      exitEffect: { type: "pop", durationSec: 0.8 },
      cornerRadius: 0.2,
    });
    if (clipboard?.kind === "overlay") {
      expect(clipboard.entranceEffect).not.toBe(source.entranceEffect);
      expect(clipboard.exitEffect).not.toBe(source.exitEffect);
    }
  });

  it("pastes deep-copied appearance only to visible selected overlays", () => {
    const sourceId = addTestOverlay();
    const visibleId = addTestOverlay();
    const hiddenId = addTestOverlay();
    useRepurposeStore.setState({
      overlays: useRepurposeStore.getState().overlays.map((overlay) =>
        overlay.id === sourceId
          ? {
              ...overlay,
              band: "free",
              entranceEffect: {
                type: "zoom" as const,
                durationSec: 0.7,
              },
              exitEffect: { type: "fade" as const, durationSec: 0.9 },
              cornerRadius: 0.3,
            }
          : overlay.id === visibleId
            ? { ...overlay, band: "face" }
            : { ...overlay, band: "screen" }
      ),
      selectedOverlayIds: [visibleId, hiddenId],
      selectedOverlayId: hiddenId,
      past: [],
      future: [],
    });
    useRepurposeStore.getState().copySelectedAttributes(sourceId);

    expect(
      useRepurposeStore.getState().pasteAttributesToSelection(undefined, 0)
    ).toBe(true);
    const state = useRepurposeStore.getState();
    const source = state.overlays.find((overlay) => overlay.id === sourceId)!;
    const visible = state.overlays.find((overlay) => overlay.id === visibleId)!;
    const hidden = state.overlays.find((overlay) => overlay.id === hiddenId)!;
    expect(visible).toMatchObject({
      entranceEffect: source.entranceEffect,
      exitEffect: source.exitEffect,
      cornerRadius: 0.3,
    });
    expect(visible.entranceEffect).not.toBe(source.entranceEffect);
    expect(visible.exitEffect).not.toBe(source.exitEffect);
    expect(hidden).toMatchObject({
      entranceEffect: { type: "none", durationSec: 0.35 },
      exitEffect: { type: "none", durationSec: 0.35 },
      cornerRadius: 0,
    });
    expect(state.past).toHaveLength(1);

    expect(
      useRepurposeStore.getState().pasteAttributesToSelection(undefined, 0)
    ).toBe(false);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("duplicates appearance without aliasing nested effects", () => {
    const id = addTestOverlay();
    useRepurposeStore.getState().setOverlayEntranceEffect(id, {
      type: "slide",
      durationSec: 0.4,
      direction: "up",
    });
    useRepurposeStore.getState().setOverlayExitEffect(id, {
      type: "fade",
      durationSec: 1.2,
    });
    useRepurposeStore.getState().setOverlayCornerRadius(id, 0.25);
    const duplicateId = useRepurposeStore.getState().duplicateOverlay(
      id,
      { left: 0, top: 0, width: 1080, height: 1920 },
      0.5
    );

    const source = useRepurposeStore.getState().overlays.find((o) => o.id === id)!;
    const duplicate = useRepurposeStore
      .getState()
      .overlays.find((o) => o.id === duplicateId)!;
    expect(duplicate).toMatchObject({
      entranceEffect: source.entranceEffect,
      exitEffect: source.exitEffect,
      cornerRadius: source.cornerRadius,
    });
    expect(duplicate.entranceEffect).not.toBe(source.entranceEffect);
    expect(duplicate.exitEffect).not.toBe(source.exitEffect);
  });

  it("never rewrites authored effect durations while trimming", () => {
    const id = addTestOverlay();
    useRepurposeStore.getState().setOverlayEntranceEffect(id, {
      type: "zoom",
      durationSec: 1.8,
    });
    useRepurposeStore.getState().setOverlayExitEffect(id, {
      type: "fade",
      durationSec: 1.7,
    });

    useRepurposeStore.getState().trimOverlay(id, "end", 0.5);

    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      timelineEnd: 0.5,
      entranceEffect: { type: "zoom", durationSec: 1.8 },
      exitEffect: { type: "fade", durationSec: 1.7 },
    });
  });
});

describe("caption gesture ownership", () => {
  it.each([
    ["seekToStart", 0],
    ["seekToEnd", 1],
    ["nextMarker", 0.8],
    ["prevMarker", 0.2],
  ] as const)(
    "blocks %s from moving the owned frame and restores it after cancellation",
    (action, expectedAfterCancel) => {
      const id = seedCaptionBlock();
      useRepurposeStore.setState({
        playhead: 0.5,
        markers: [
          { id: "before", t: 0.2, label: "Before" },
          { id: "after", t: 0.8, label: "After" },
        ],
      });
      const blockBefore = useRepurposeStore.getState().captionBlocks[0];
      const token = beginCaptionGesture(id);
      const listener = vi.fn();
      const unsubscribe = useRepurposeStore.subscribe(listener);

      useRepurposeStore.getState()[action]();

      expect(useRepurposeStore.getState().playhead).toBe(0.5);
      expect(useRepurposeStore.getState().captionBlocks[0]).toBe(blockBefore);
      expect(useRepurposeStore.getState().past).toEqual([]);
      expect(listener).not.toHaveBeenCalled();

      useRepurposeStore.getState().cancelCaptionGesture(token);
      useRepurposeStore.getState().completeCaptionGesture(token, {
        kind: "detach",
        positionYPct: 0.8,
      });
      useRepurposeStore.getState()[action]();

      expect(useRepurposeStore.getState().playhead).toBe(expectedAfterCancel);
      expect(useRepurposeStore.getState().captionBlocks[0]).toBe(blockBefore);
      expect(useRepurposeStore.getState().past).toEqual([]);
      unsubscribe();
    }
  );

  it("allows selection-only actions without moving the frame or losing caption ownership", () => {
    const id = seedCaptionBlock();
    useRepurposeStore.setState({ playhead: 0.5 });
    const token = beginCaptionGesture(id);

    useRepurposeStore.getState().selectClip("caption-scene");
    expect(useRepurposeStore.getState().selectedClipId).toBe("caption-scene");
    useRepurposeStore.getState().selectWords(0);
    expect(useRepurposeStore.getState().selectedWordRange).toEqual({ lo: 0, hi: 0 });
    expect(useRepurposeStore.getState().playhead).toBe(0.5);

    useRepurposeStore.getState().completeCaptionGesture(token, {
      kind: "detach",
      positionYPct: 0.7,
    });

    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: false,
      positionYPct: 0.7,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("lets appearance ownership cancel caption before capturing its own history", () => {
    const overlayId = addTestOverlay();
    const captionId = seedCaptionBlock();
    const cancellationListener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(cancellationListener);
    const captionToken = beginCaptionGesture(captionId);

    const appearanceToken = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(overlayId, "cornerRadius") as string;

    expect(appearanceToken).toEqual(expect.any(String));
    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().past).toEqual([]);
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(appearanceToken, 0.4);
    useRepurposeStore.getState().completeCaptionGesture(captionToken, {
      kind: "detach",
      positionYPct: 0.8,
    });
    useRepurposeStore.getState().cancelCaptionGesture(captionToken);

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: true,
    });
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0.4);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().endOverlayAppearanceGesture(appearanceToken);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: true,
    });
    unsubscribe();
  });

  it("writes once on completion and creates exactly one Undo entry", () => {
    const id = seedCaptionBlock();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore.subscribe(listener);
    const token = beginCaptionGesture(id);

    expect(listener).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState().past).toEqual([]);
    useRepurposeStore.getState().completeCaptionGesture(token, {
      kind: "detach",
      positionYPct: 0.64,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: false,
      positionYPct: 0.64,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: true,
    });
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: false,
      positionYPct: 0.64,
    });
    unsubscribe();
  });

  it("cancels without a store write and makes completion stale", () => {
    const id = seedCaptionBlock();
    const before = useRepurposeStore.getState();
    const stateListener = vi.fn();
    const cancellationListener = vi.fn();
    const unsubscribeState = useRepurposeStore.subscribe(stateListener);
    const unsubscribeCancellation = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(cancellationListener);
    const token = beginCaptionGesture(id);

    useRepurposeStore.getState().cancelCaptionGesture(token);
    useRepurposeStore.getState().cancelCaptionGesture(token);
    useRepurposeStore.getState().completeCaptionGesture(token, {
      kind: "detach",
      positionYPct: 0.8,
    });

    expect(stateListener).not.toHaveBeenCalled();
    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().captionBlocks).toBe(before.captionBlocks);
    expect(useRepurposeStore.getState().past).toBe(before.past);
    unsubscribeState();
    unsubscribeCancellation();
  });

  it("treats missing, replaced, and no-movement ownership as no-ops", () => {
    const id = seedCaptionBlock();
    const before = useRepurposeStore.getState();
    const stateListener = vi.fn();
    const cancellationListener = vi.fn();
    const unsubscribeState = useRepurposeStore.subscribe(stateListener);
    const unsubscribeCancellation = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(cancellationListener);

    expect(useRepurposeStore.getState().beginCaptionGesture("missing")).toBeNull();
    const stale = beginCaptionGesture(id);
    const current = beginCaptionGesture(id);
    useRepurposeStore.getState().completeCaptionGesture(stale, {
      kind: "detach",
      positionYPct: 0.7,
    });
    useRepurposeStore
      .getState()
      .completeCaptionGesture(current, { kind: "attach" });

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(stateListener).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState().captionBlocks).toBe(before.captionBlocks);
    expect(useRepurposeStore.getState().past).toBe(before.past);
    unsubscribeState();
    unsubscribeCancellation();
  });

  it.each([
    ["undo", false],
    ["redo", false],
    ["undo", true],
    ["redo", true],
  ] as const)(
    "cancels exactly once before %s with unrelated history=%s",
    (operation, withHistory) => {
      const id = seedCaptionBlock();
      if (withHistory) {
        useRepurposeStore.getState().addMarker(0.25);
        if (operation === "redo") useRepurposeStore.getState().undo();
      }
      const listener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeCaptionGestureCancellation(listener);
      const token = beginCaptionGesture(id);

      useRepurposeStore.getState()[operation]();
      useRepurposeStore.getState().completeCaptionGesture(token, {
        kind: "detach",
        positionYPct: 0.8,
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(
        useRepurposeStore.getState().captionBlocks[0]?.overrideStyle
      ).toMatchObject({ pinToSplit: true });
      unsubscribe();
    }
  );

  it("cancels on rebuild, transcript application, project replacement, and reset", () => {
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(listener);

    let id = seedCaptionBlock();
    let token = beginCaptionGesture(id);
    useRepurposeStore.getState().rebuildCaptionBlocks();
    useRepurposeStore.getState().completeCaptionGesture(token, {
      kind: "detach",
      positionYPct: 0.8,
    });

    id = seedCaptionBlock();
    token = beginCaptionGesture(id);
    useRepurposeStore.getState().applyTranscript({
      words: [{ text: "Fresh", start: 0, end: 0.7 }],
      mode: "preserve-cuts",
    });
    useRepurposeStore
      .getState()
      .completeCaptionGesture(token, { kind: "attach" });

    id = seedCaptionBlock();
    token = beginCaptionGesture(id);
    useRepurposeStore.getState().setClips([scene("replacement", 0)]);
    useRepurposeStore.getState().completeCaptionGesture(token, {
      kind: "detach",
      positionYPct: 0.8,
    });

    id = seedCaptionBlock();
    token = beginCaptionGesture(id);
    useRepurposeStore.getState().resetProject();
    useRepurposeStore.getState().completeCaptionGesture(token, {
      kind: "detach",
      positionYPct: 0.8,
    });

    expect(listener).toHaveBeenCalledTimes(4);
    expect(useRepurposeStore.getState().captionBlocks).toEqual([]);
    unsubscribe();
  });

  it("coordinates caption ownership with split and appearance gestures", () => {
    const id = seedCaptionBlock();
    const overlayId = addTestOverlay();
    const splitListener = vi.fn();
    const appearanceListener = vi.fn();
    const captionListener = vi.fn();
    const unsubscribeSplit = useRepurposeStore
      .getState()
      .subscribeSplitRatioGestureCancellation(splitListener);
    const unsubscribeAppearance = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(appearanceListener);
    const unsubscribeCaption = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(captionListener);
    const splitToken = beginSplitGesture({ kind: "global" });
    const appearanceToken = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(overlayId, "cornerRadius") as string;
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(appearanceToken, 0.4);

    const captionToken = beginCaptionGesture(id);

    expect(splitListener).toHaveBeenCalledTimes(1);
    expect(appearanceListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    useRepurposeStore.getState().updateSplitRatioGesture(splitToken, 0.8);
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(appearanceToken, 0.2);

    useRepurposeStore.getState().beginSplitRatioGesture({ kind: "global" });
    useRepurposeStore.getState().completeCaptionGesture(captionToken, {
      kind: "detach",
      positionYPct: 0.8,
    });
    expect(captionListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: true,
    });
    unsubscribeSplit();
    unsubscribeAppearance();
    unsubscribeCaption();
  });

  it("cancels before an unrelated normal history commit can make completion stale", () => {
    const id = seedCaptionBlock();
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(listener);
    const token = beginCaptionGesture(id);

    useRepurposeStore.getState().addMarker(0.25);
    useRepurposeStore.getState().completeCaptionGesture(token, {
      kind: "detach",
      positionYPct: 0.8,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: true,
    });
    expect(useRepurposeStore.getState().markers).toHaveLength(1);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().markers).toEqual([]);
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: true,
    });
    unsubscribe();
  });

  it("keeps a slow provisional caption position gesture in one Undo step", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const id = seedCaptionBlock({
      fill: "#123456",
      pinToSplit: false,
      positionYPct: 0.63,
    });
    const token = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;

    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.68);
    now.mockReturnValue(1_000);
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.72);
    useRepurposeStore.getState().endCaptionPositionGesture(token);

    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: false,
      positionYPct: 0.72,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
      fill: "#123456",
      pinToSplit: false,
      positionYPct: 0.63,
    });
    now.mockRestore();
  });

  it("restores the exact caption block and redo stack when position is cancelled", () => {
    const id = seedCaptionBlock({
      fill: "#123456",
      pinToSplit: false,
      positionYPct: 0.63,
    });
    useRepurposeStore.getState().addMarker(0.25);
    useRepurposeStore.getState().undo();
    const before = useRepurposeStore.getState();
    const token = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.8);

    useRepurposeStore.getState().cancelCaptionPositionGesture(token);

    expect(useRepurposeStore.getState().captionBlocks).toBe(before.captionBlocks);
    expect(useRepurposeStore.getState().past).toBe(before.past);
    expect(useRepurposeStore.getState().future).toBe(before.future);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().markers).toHaveLength(1);
  });

  it("ignores stale caption position events until a fresh gesture begins", () => {
    const id = seedCaptionBlock({
      pinToSplit: false,
      positionYPct: 0.63,
    });
    const staleToken = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;
    useRepurposeStore.getState().updateCaptionPositionGesture(staleToken, 0.7);
    useRepurposeStore.getState().cancelCaptionPositionGesture(staleToken);
    useRepurposeStore.getState().updateCaptionPositionGesture(staleToken, 0.9);

    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);
    expect(useRepurposeStore.getState().past).toEqual([]);

    const freshToken = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;
    useRepurposeStore.getState().updateCaptionPositionGesture(freshToken, 0.75);
    useRepurposeStore.getState().endCaptionPositionGesture(freshToken);
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.75);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  it("rolls back provisional caption position before a competing normal edit", () => {
    const id = seedCaptionBlock({
      pinToSplit: false,
      positionYPct: 0.63,
    });
    const cancellationListener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(cancellationListener);
    const token = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.8);

    useRepurposeStore.getState().addMarker(0.25);
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.9);

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);
    expect(useRepurposeStore.getState().markers).toHaveLength(1);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().markers).toEqual([]);
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);
    unsubscribe();
  });

  it("does not capture history for a no-op caption position gesture", () => {
    const id = seedCaptionBlock({
      pinToSplit: false,
      positionYPct: 0.63,
    });
    const token = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;

    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.63);
    useRepurposeStore.getState().endCaptionPositionGesture(token);

    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  it("rolls back an active caption position transaction before Undo", () => {
    const id = seedCaptionBlock({
      pinToSplit: false,
      positionYPct: 0.63,
    });
    const cancellationListener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(cancellationListener);
    const token = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.8);

    useRepurposeStore.getState().undo();
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.9);

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(useRepurposeStore.getState().future).toEqual([]);
    unsubscribe();
  });

  it("lets split ownership roll back caption position before its own history", () => {
    const id = seedCaptionBlock({
      pinToSplit: false,
      positionYPct: 0.63,
    });
    const cancellationListener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(cancellationListener);
    const captionToken = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture(id) as string;
    useRepurposeStore
      .getState()
      .updateCaptionPositionGesture(captionToken, 0.8);

    const splitToken = beginSplitGesture({ kind: "global" });
    useRepurposeStore
      .getState()
      .updateCaptionPositionGesture(captionToken, 0.9);
    useRepurposeStore.getState().updateSplitRatioGesture(splitToken, 0.72);
    useRepurposeStore.getState().endSplitRatioGesture(splitToken);

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);
    expect(useRepurposeStore.getState().splitRatio).toBe(0.72);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.63);
    unsubscribe();
  });
});

describe("full-range split ratio store contract", () => {
  it("accepts endpoints, clamps finite values, and ignores non-finite setters", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);

    useRepurposeStore.getState().setSplitRatio(0);
    expect(useRepurposeStore.getState().splitRatio).toBe(0);
    useRepurposeStore.getState().setSplitRatio(1);
    expect(useRepurposeStore.getState().splitRatio).toBe(1);
    useRepurposeStore.getState().setSplitRatio(-1);
    expect(useRepurposeStore.getState().splitRatio).toBe(0);
    useRepurposeStore.getState().setSplitRatio(2);
    expect(useRepurposeStore.getState().splitRatio).toBe(1);
    useRepurposeStore.getState().setClipSplitRatio("scene", 0);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0);
    useRepurposeStore.getState().setClipSplitRatio("scene", 1);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(1);
    useRepurposeStore.getState().setClipSplitRatio("scene", -1);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0);
    useRepurposeStore.getState().setClipSplitRatio("scene", 2);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(1);

    const before = useRepurposeStore.getState();
    let notifications = 0;
    const unsubscribe = useRepurposeStore.subscribe(() => notifications++);
    useRepurposeStore.getState().setSplitRatio(Number.NaN);
    useRepurposeStore.getState().setSplitRatio(Number.POSITIVE_INFINITY);
    useRepurposeStore.getState().setClipSplitRatio("scene", Number.NaN);
    useRepurposeStore
      .getState()
      .setClipSplitRatio("scene", Number.NEGATIVE_INFINITY);
    unsubscribe();

    expect(useRepurposeStore.getState().past).toBe(before.past);
    expect(useRepurposeStore.getState().clips).toBe(before.clips);
    expect(notifications).toBe(0);
  });

  it("keeps rapid regular setter calls as separate Undo steps", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    useRepurposeStore.getState().setSplitRatio(0.2);
    useRepurposeStore.getState().setSplitRatio(0.21);

    expect(useRepurposeStore.getState().past).toHaveLength(2);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.2);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.5);

    useRepurposeStore.getState().setClipSplitRatio("scene", 0.79);
    useRepurposeStore.getState().setClipSplitRatio("scene", 0.8);
    expect(useRepurposeStore.getState().past).toHaveLength(2);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.79);
  });

  it("redoes rapid discrete global setter calls one at a time", () => {
    useRepurposeStore.getState().setSplitRatio(0.2);
    useRepurposeStore.getState().setSplitRatio(0.21);

    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.2);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.21);
  });

  it("redoes rapid discrete per-clip setter calls one at a time", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    useRepurposeStore.getState().setClipSplitRatio("scene", 0.79);
    useRepurposeStore.getState().setClipSplitRatio("scene", 0.8);

    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.79);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.8);
  });

  it("does not pointer-snap near-endpoint programmatic setter values", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);

    useRepurposeStore.getState().setSplitRatio(0.0199);
    expect(useRepurposeStore.getState().splitRatio).toBe(0.0199);
    useRepurposeStore.getState().setSplitRatio(0.9801);
    expect(useRepurposeStore.getState().splitRatio).toBe(0.9801);

    useRepurposeStore.getState().setClipSplitRatio("scene", 0.0199);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.0199);
    useRepurposeStore.getState().setClipSplitRatio("scene", 0.9801);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.9801);
  });

  it("clears an endpoint override through resetAllFraming and history", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0, 1)]);

    useRepurposeStore.getState().resetAllFraming();
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();

    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(1);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
  });

  it("records one Undo entry for a long gesture after its first effective move", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    const token = beginSplitGesture({ kind: "clip", id: "scene" });
    useRepurposeStore.getState().updateSplitRatioGesture(token, 0.5);
    expect(useRepurposeStore.getState().past).toHaveLength(0);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();

    now.mockReturnValue(1_000);
    useRepurposeStore.getState().updateSplitRatioGesture(token, 0.8);
    useRepurposeStore.getState().endSplitRatioGesture(token);

    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.8);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
    now.mockRestore();
  });

  it.each([
    ["global", { kind: "global" } as const],
    ["clip", { kind: "clip", id: "scene" } as const],
  ])(
    "closes a moved %s split before an appearance edit without crossing history",
    (_name, target) => {
      useRepurposeStore.getState().setClips([scene("scene", 0)]);
      const overlayId = addTestOverlay();
      const cancellationListener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeSplitRatioGestureCancellation(cancellationListener);
      const splitToken = beginSplitGesture(target);
      useRepurposeStore.getState().updateSplitRatioGesture(splitToken, 0.72);

      const appearanceToken = useRepurposeStore
        .getState()
        .beginOverlayAppearanceGesture(overlayId, "cornerRadius") as string;
      useRepurposeStore.getState().updateSplitRatioGesture(splitToken, 0.91);
      useRepurposeStore
        .getState()
        .updateOverlayAppearanceGesture(appearanceToken, 0.4);
      useRepurposeStore.getState().endOverlayAppearanceGesture(appearanceToken);

      expect(cancellationListener).toHaveBeenCalledTimes(1);
      expect(useRepurposeStore.getState().splitRatio).toBe(
        target.kind === "global" ? 0.72 : 0.5
      );
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(
        target.kind === "clip" ? 0.72 : undefined
      );
      expect(useRepurposeStore.getState().past).toHaveLength(2);
      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
      expect(useRepurposeStore.getState().splitRatio).toBe(
        target.kind === "global" ? 0.72 : 0.5
      );
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(
        target.kind === "clip" ? 0.72 : undefined
      );
      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
      unsubscribe();
    }
  );

  it.each([
    ["global", { kind: "global" } as const],
    ["clip", { kind: "clip", id: "scene" } as const],
  ])(
    "closes a moved %s split before a direct caption edit without crossing history",
    (_name, target) => {
      const words = [{ text: "Caption", start: 0, end: 0.8 }];
      useRepurposeStore.setState({
        clips: [scene("scene", 0)],
        duration: 1,
        words,
        captionBlocks: [
          {
            id: "caption",
            words,
            start: 0,
            end: 0.8,
            overrideStyle: { fill: "#123456", pinToSplit: true },
          },
        ],
      });
      const cancellationListener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeSplitRatioGestureCancellation(cancellationListener);
      const splitToken = beginSplitGesture(target);
      useRepurposeStore.getState().updateSplitRatioGesture(splitToken, 0.72);

      useRepurposeStore.getState().detachCaptionBlock("caption", 0.64);
      useRepurposeStore.getState().updateSplitRatioGesture(splitToken, 0.91);

      expect(cancellationListener).toHaveBeenCalledTimes(1);
      expect(useRepurposeStore.getState().splitRatio).toBe(
        target.kind === "global" ? 0.72 : 0.5
      );
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(
        target.kind === "clip" ? 0.72 : undefined
      );
      expect(useRepurposeStore.getState().past).toHaveLength(2);
      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toEqual({
        fill: "#123456",
        pinToSplit: true,
      });
      expect(useRepurposeStore.getState().splitRatio).toBe(
        target.kind === "global" ? 0.72 : 0.5
      );
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(
        target.kind === "clip" ? 0.72 : undefined
      );
      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
      unsubscribe();
    }
  );

  it("lets split ownership cancel and roll back an active appearance transaction", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    const overlayId = addTestOverlay();
    const cancellationListener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(cancellationListener);
    const appearanceToken = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(overlayId, "cornerRadius") as string;
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(appearanceToken, 0.4);

    const splitToken = beginSplitGesture({ kind: "global" });
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(appearanceToken, 0.7);
    useRepurposeStore.getState().updateSplitRatioGesture(splitToken, 0.72);
    useRepurposeStore.getState().endSplitRatioGesture(splitToken);

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    expect(useRepurposeStore.getState().splitRatio).toBe(0.72);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
    expect(useRepurposeStore.getState().overlays[0].cornerRadius).toBe(0);
    unsubscribe();
  });

  it("does not record a no-op gesture", () => {
    const token = beginSplitGesture({ kind: "global" });
    useRepurposeStore.getState().updateSplitRatioGesture(token, 0.5);
    useRepurposeStore.getState().endSplitRatioGesture(token);

    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  it("ignores delayed callbacks from a gesture replaced by re-entry", () => {
    useRepurposeStore
      .getState()
      .setClips([scene("first", 0), scene("second", 1)]);
    const tokenA = beginSplitGesture({ kind: "clip", id: "first" });
    useRepurposeStore.getState().setPlayhead(1.5);
    useRepurposeStore.getState().updateSplitRatioGesture(tokenA, 0.2);

    const tokenB = beginSplitGesture({ kind: "clip", id: "second" });
    expect(tokenB).not.toBe(tokenA);
    useRepurposeStore.getState().updateSplitRatioGesture(tokenA, 0.9);
    useRepurposeStore.getState().endSplitRatioGesture(tokenA);
    useRepurposeStore.getState().cancelSplitRatioGesture(tokenA);
    useRepurposeStore.getState().updateSplitRatioGesture(tokenB, 0.8);
    useRepurposeStore.getState().endSplitRatioGesture(tokenB);

    expect(useRepurposeStore.getState().clips).toMatchObject([
      { id: "first", splitRatio: 0.2 },
      { id: "second", splitRatio: 0.8 },
    ]);
    expect(useRepurposeStore.getState().past).toHaveLength(2);
  });

  it("closes a cancelled gesture without applying later updates", () => {
    const token = beginSplitGesture({ kind: "global" });
    useRepurposeStore.getState().cancelSplitRatioGesture(token);
    useRepurposeStore.getState().updateSplitRatioGesture(token, 0.8);

    expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  it("refuses to begin a clip gesture for a missing or deleted target", () => {
    useRepurposeStore
      .getState()
      .setClips([{ ...scene("deleted", 0), kept: false }]);

    expect(
      useRepurposeStore
        .getState()
        .beginSplitRatioGesture({ kind: "clip", id: "missing" })
    ).toBeNull();
    expect(
      useRepurposeStore
        .getState()
        .beginSplitRatioGesture({ kind: "clip", id: "deleted" })
    ).toBeNull();
  });

  it("invalid re-entry cancels the previous gesture token", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    const oldToken = beginSplitGesture({ kind: "global" });

    expect(
      useRepurposeStore
        .getState()
        .beginSplitRatioGesture({ kind: "clip", id: "missing" })
    ).toBeNull();
    useRepurposeStore.getState().updateSplitRatioGesture(oldToken, 0.8);

    expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  it("cancels gestures before reset, replacement, Undo, and Redo", () => {
    const resetToken = beginSplitGesture({ kind: "global" });
    useRepurposeStore.getState().resetProject();
    useRepurposeStore.getState().updateSplitRatioGesture(resetToken, 0.9);
    expect(useRepurposeStore.getState().splitRatio).toBe(0.5);

    useRepurposeStore.getState().setClips([scene("old", 0)]);
    const replacementToken = beginSplitGesture({ kind: "clip", id: "old" });
    useRepurposeStore.getState().setClips([scene("replacement", 0, 0.2)]);
    useRepurposeStore
      .getState()
      .updateSplitRatioGesture(replacementToken, 0.9);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.2);

    useRepurposeStore.getState().setSplitRatio(0.2);
    const undoToken = beginSplitGesture({ kind: "global" });
    useRepurposeStore.getState().undo();
    useRepurposeStore.getState().updateSplitRatioGesture(undoToken, 0.9);
    expect(useRepurposeStore.getState().splitRatio).toBe(0.5);

    const redoToken = beginSplitGesture({ kind: "global" });
    useRepurposeStore.getState().redo();
    useRepurposeStore.getState().updateSplitRatioGesture(redoToken, 0.9);
    expect(useRepurposeStore.getState().splitRatio).toBe(0.2);
  });

  it("signals empty-stack Undo and Redo cancellation without publishing store state", () => {
    const cancellationListener = vi.fn();
    const stateListener = vi.fn();
    const unsubscribeCancellation = useRepurposeStore
      .getState()
      .subscribeSplitRatioGestureCancellation(cancellationListener);
    const unsubscribeState = useRepurposeStore.subscribe(stateListener);

    const undoToken = beginSplitGesture({ kind: "global" });
    useRepurposeStore.getState().undo();
    useRepurposeStore.getState().updateSplitRatioGesture(undoToken, 0.8);
    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(stateListener).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState()).toMatchObject({
      splitRatio: 0.5,
      past: [],
      future: [],
    });

    const redoToken = beginSplitGesture({ kind: "global" });
    useRepurposeStore.getState().redo();
    useRepurposeStore.getState().updateSplitRatioGesture(redoToken, 0.8);
    expect(cancellationListener).toHaveBeenCalledTimes(2);
    expect(stateListener).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState()).toMatchObject({
      splitRatio: 0.5,
      past: [],
      future: [],
    });

    unsubscribeState();
    unsubscribeCancellation();
  });

  it.each(["undo", "redo"] as const)(
    "signals exactly once when successful %s restores unrelated history during a gesture",
    (operation) => {
      useRepurposeStore.getState().setClips([scene("stable-scene", 0, 0.4)]);
      useRepurposeStore.getState().addMarker(0.25);
      if (operation === "redo") useRepurposeStore.getState().undo();

      const stableClips = useRepurposeStore.getState().clips;
      const cancellationListener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeSplitRatioGestureCancellation(cancellationListener);
      const token = beginSplitGesture({ kind: "global" });

      useRepurposeStore.getState()[operation]();

      expect(cancellationListener).toHaveBeenCalledTimes(1);
      expect(useRepurposeStore.getState().clips).toBe(stableClips);
      expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
      expect(useRepurposeStore.getState().markers).toHaveLength(
        operation === "undo" ? 0 : 1
      );

      useRepurposeStore.getState().updateSplitRatioGesture(token, 0.8);
      expect(cancellationListener).toHaveBeenCalledTimes(1);
      expect(useRepurposeStore.getState().splitRatio).toBe(0.5);
      unsubscribe();
    }
  );

  it("rejects gesture updates when the frozen clip target is missing or deleted", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    const missingToken = beginSplitGesture({ kind: "clip", id: "scene" });
    useRepurposeStore.setState({ clips: [] });
    useRepurposeStore.getState().updateSplitRatioGesture(missingToken, 0.8);
    expect(useRepurposeStore.getState().past).toEqual([]);

    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    const deletedToken = beginSplitGesture({ kind: "clip", id: "scene" });
    useRepurposeStore.setState({
      clips: useRepurposeStore
        .getState()
        .clips.map((clip) => ({ ...clip, kept: false })),
    });
    useRepurposeStore.getState().updateSplitRatioGesture(deletedToken, 0.8);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
    expect(useRepurposeStore.getState().past).toEqual([]);
    useRepurposeStore.getState().endSplitRatioGesture(deletedToken);
  });

  it("prevents deleted clip gestures from hiding ratio mutations in restore history", () => {
    useRepurposeStore.getState().setClips([scene("scene", 0)]);
    const token = beginSplitGesture({ kind: "clip", id: "scene" });

    useRepurposeStore.getState().deleteClip("scene");
    useRepurposeStore.getState().updateSplitRatioGesture(token, 0.8);
    useRepurposeStore.getState().restoreClip("scene");
    useRepurposeStore.getState().updateSplitRatioGesture(token, 0.9);
    expect(useRepurposeStore.getState().clips[0]).toMatchObject({
      kept: true,
      splitRatio: undefined,
    });

    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().clips[0]).toMatchObject({
      kept: false,
      splitRatio: undefined,
    });
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().clips[0]).toMatchObject({
      kept: true,
      splitRatio: undefined,
    });
  });

  it("preserves full-range ratios through paste, duplication, split, restore, and history", () => {
    useRepurposeStore
      .getState()
      .setClips([scene("source", 0, 0), scene("target", 1, 0.79)]);
    useRepurposeStore.getState().selectClip("source");
    expect(useRepurposeStore.getState().copySelectedAttributes()).toBe(true);
    useRepurposeStore.getState().selectClip("target");
    expect(useRepurposeStore.getState().pasteAttributesToSelection()).toBe(true);
    expect(useRepurposeStore.getState().clips[1].splitRatio).toBe(0);

    useRepurposeStore.getState().duplicateClip("target");
    const duplicate = useRepurposeStore.getState().clips[2];
    expect(duplicate.splitRatio).toBe(0);
    useRepurposeStore.getState().splitClipAtPlayhead(2.5);
    expect(useRepurposeStore.getState().clips.slice(2, 4)).toMatchObject([
      { splitRatio: 0 },
      { splitRatio: 0 },
    ]);

    const splitId = useRepurposeStore.getState().clips[3].id;
    useRepurposeStore.getState().deleteClip(splitId);
    useRepurposeStore.getState().restoreClip(splitId);
    expect(
      useRepurposeStore.getState().clips.find((clip) => clip.id === splitId)
        ?.splitRatio
    ).toBe(0);
    useRepurposeStore.getState().undo();
    useRepurposeStore.getState().redo();
    expect(
      useRepurposeStore.getState().clips.find((clip) => clip.id === splitId)
        ?.splitRatio
    ).toBe(0);
  });

  it("copies the selected clip's global split instead of a previous clip override", () => {
    useRepurposeStore
      .getState()
      .setClips([
        scene("previous", 0, 0.2),
        scene("selected", 1),
        scene("paste-target", 2, 0.9),
      ]);
    useRepurposeStore.getState().setSplitRatio(0.7);
    useRepurposeStore.getState().selectClip("selected");

    expect(useRepurposeStore.getState().copySelectedAttributes()).toBe(true);
    expect(useRepurposeStore.getState().attributeClipboard).toMatchObject({
      kind: "clip",
      splitRatio: 0.7,
    });

    useRepurposeStore.getState().selectClip("paste-target");
    expect(useRepurposeStore.getState().pasteAttributesToSelection()).toBe(true);
    expect(useRepurposeStore.getState().clips[2].splitRatio).toBe(0.7);
  });

  it("normalizes ratios when clips replace the project", () => {
    useRepurposeStore
      .getState()
      .setClips([
        scene("low", 0, -1),
        scene("high", 1, 2),
        scene("invalid", 2, Number.NaN),
      ]);

    expect(useRepurposeStore.getState().clips).toMatchObject([
      { id: "low", splitRatio: 0 },
      { id: "high", splitRatio: 1 },
      { id: "invalid" },
    ]);
    expect(useRepurposeStore.getState().clips[2]).not.toHaveProperty("splitRatio");
  });
});
