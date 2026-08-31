import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTranscriptCandidate,
  effectiveVideoTimelineDuration,
  isUntouchedVideoTimeline,
} from "@/lib/repurpose/transcript-application";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { VIDEO_TIMELINE_CLIP_ID, type Clip, type FootageMeta, type SfxClip, type VideoSourceRecord, type Word } from "@/lib/repurpose/types";

function source(name: string, durationSec: number): VideoSourceRecord {
  return {
    originalPath: `C:\\media\\${name}.mp4`,
    workingPath: `C:\\media\\${name}.mp4`,
    originalName: `${name}.mp4`,
    inspection: {
      fingerprint: name.padEnd(64, "a").slice(0, 64),
      container: "mov,mp4",
      extension: ".mp4",
      size: 1024,
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

function footage(screenDuration: number, faceDuration: number): FootageMeta {
  return {
    faceCamPath: "/face",
    screenPath: "/screen",
    faceCamSource: source("face", faceDuration),
    screenSource: source("screen", screenDuration),
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: faceDuration,
  };
}

function bootstrap(duration = 8): Clip {
  return {
    id: VIDEO_TIMELINE_CLIP_ID,
    kind: "take",
    label: "Full video",
    srcStart: 0,
    srcEnd: duration,
    timelineStart: 0,
    timelineEnd: duration,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 0, end: duration }],
    keeperIndex: 0,
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
});

describe("pure transcript applicability", () => {
  it("uses the shorter positive inspected Screen/Face duration", () => {
    expect(effectiveVideoTimelineDuration(footage(12, 8))).toBe(8);
    expect(effectiveVideoTimelineDuration(footage(6, 11))).toBe(6);
    expect(effectiveVideoTimelineDuration(null)).toBeNull();
    expect(effectiveVideoTimelineDuration(footage(0, 8))).toBeNull();
    expect(effectiveVideoTimelineDuration(footage(Number.NaN, 8))).toBeNull();
    expect(effectiveVideoTimelineDuration(footage(8, Number.POSITIVE_INFINITY))).toBeNull();
  });

  it("treats an empty timeline and the exact styled bootstrap as untouched", () => {
    expect(
      isUntouchedVideoTimeline({ clips: [], words: [], effectiveDuration: null })
    ).toBe(true);
    expect(
      isUntouchedVideoTimeline({
        clips: [
          {
            ...bootstrap(),
            splitRatio: 0.6,
            transitionIn: {
              type: "zoom-settle",
              durationSec: 0.4,
              amount: 0.025,
            },
            faceFraming: { x: 0.2, y: -0.1, scale: 1.2 },
            manualScene: true,
          },
        ],
        words: [],
        effectiveDuration: 8,
      })
    ).toBe(true);
  });

  it.each([
    ["trim", [{ ...bootstrap(), srcEnd: 7, timelineEnd: 7 }]],
    ["split", [{ ...bootstrap(), srcEnd: 4, timelineEnd: 4 }, { ...bootstrap(), id: "split", srcStart: 4, timelineStart: 4 }]],
    ["duplicate", [bootstrap(), { ...bootstrap(), id: "duplicate", timelineStart: 8, timelineEnd: 16 }]],
    ["reorder", [{ ...bootstrap(), id: "other" }, bootstrap()]],
    ["deletion", [{ ...bootstrap(), kept: false, timelineEnd: 0 }]],
    ["transcript clip", [{ ...bootstrap(), id: "clip-0-0" }]],
  ] as Array<[string, Clip[]]>)("treats %s as edited", (_name, clips) => {
    expect(
      isUntouchedVideoTimeline({ clips, words: [], effectiveDuration: 8 })
    ).toBe(false);
  });

  it("treats any transcript words as edited", () => {
    expect(
      isUntouchedVideoTimeline({
        clips: [bootstrap()],
        words: [{ text: "Olá", start: 0, end: 0.5 }],
        effectiveDuration: 8,
      })
    ).toBe(false);
  });

  it("bounds candidate clips and occurrence ranges without changing full raw words", () => {
    const words: Word[] = [
      { text: "primeiro", start: 1, end: 2 },
      { text: "limite", start: 2, end: 9.5 },
      { text: "fora", start: 9.5, end: 12 },
    ];
    const before = structuredClone(words);

    const candidate = buildTranscriptCandidate({ words, maxSourceDuration: 10 });

    expect(candidate.kind).toBe("ready");
    if (candidate.kind !== "ready") return;
    expect(words).toEqual(before);
    expect(candidate.words).toEqual(words);
    expect(candidate.clips).toHaveLength(1);
    expect(candidate.clips[0]).toMatchObject({ srcStart: 1, srcEnd: 10 });
    expect(candidate.clips[0].occurrences).toEqual([{ start: 1, end: 10 }]);
  });

  it("removes generated clips wholly outside the shared duration", () => {
    const words: Word[] = [
      { text: "antes", start: 0, end: 1 },
      { text: "muito", start: 15, end: 16 },
      { text: "depois", start: 16, end: 17 },
    ];
    const candidate = buildTranscriptCandidate({
      words,
      finalTranscript: "antes muito depois",
      maxSourceDuration: 10,
    });
    expect(candidate.kind).toBe("ready");
    if (candidate.kind !== "ready") return;
    expect(candidate.clips.every((clip) => clip.srcStart < 10 && clip.srcEnd <= 10)).toBe(
      true
    );
  });

  it("returns an explicit non-applicable result when no speech overlaps", () => {
    expect(
      buildTranscriptCandidate({
        words: [
          { text: "sem", start: 11, end: 11.5 },
          { text: "sobreposição", start: 11.5, end: 12 },
        ],
        maxSourceDuration: 10,
      })
    ).toEqual({ kind: "no-shared-speech" });
  });
});

const oldWords: Word[] = [
  { text: "antiga", start: 0, end: 0.5 },
  { text: "fala", start: 0.5, end: 1 },
];
const newWords: Word[] = [
  { text: "nova", start: 0, end: 0.75 },
  { text: "transcrição", start: 0.75, end: 1.5 },
];

function editedClip(): Clip {
  return {
    ...bootstrap(6),
    id: "edited-clip",
    label: "Edited clip",
    splitRatio: 0.6,
    transitionIn: { type: "slide", durationSec: 0.3, amount: 0.04, direction: "left" },
    faceFraming: { x: 0.2, y: 0.1, scale: 1.4 },
    screenFraming: { x: -0.2, y: 0, scale: 1.3 },
    facePunch: { atSrc: 1, amount: 0.2, holdSec: 0.2 },
    screenPunch: { atSrc: 2, amount: 0.3, holdSec: 0.3 },
    manualScene: true,
  };
}

function seedRichState(): void {
  const clip = editedClip();
  const initial = useRepurposeStore.getInitialState();
  useRepurposeStore.setState({
    clips: [clip],
    duration: 6,
    words: oldWords,
    deletedWordIndices: [1],
    selectedWordRange: { lo: 0, hi: 1 },
    selectedClipId: clip.id,
    selectedCaptionBlockId: "old-block",
    captionsEnabled: false,
    captionBlocks: [
      {
        id: "old-block",
        words: oldWords,
        start: 0,
        end: 1,
        overrideStyle: { fill: "#ff0000" },
        keywordIndex: 1,
        textOverride: ["velha", "legenda"],
      },
    ],
    overlays: [
      {
        id: "overlay-after-new-end",
        kind: "image",
        src: "/overlay.png",
        naturalWidth: 100,
        naturalHeight: 100,
        timelineStart: 5,
        timelineEnd: 6,
        srcStart: 0,
        srcDuration: 0,
        transform: { x: 0.5, y: 0.25, scale: 0.4, rotation: 0 },
        zIndex: 0,
        opacity: 1,
      },
    ],
    markers: [{ id: "marker-after-new-end", t: 5.5, label: "keep" }],
    sfxTrack: null,
    sfxClips: [
      {
        id: "sfx-crossing-new-end",
        name: "Crossing",
        source: { kind: "imported", assetId: "sfx-asset-1", srcDuration: 6 },
        origin: "manual",
        timelineStart: 1.5,
        sourceStart: 0,
        sourceEnd: 4,
        gain: 1,
        fadeInSec: 0,
        fadeOutSec: 0,
        muted: false,
      },
      {
        id: "sfx-after-new-end",
        name: "After",
        source: { kind: "built-in", key: "ding" },
        origin: "automatic",
        timelineStart: 5,
        sourceStart: 0,
        sourceEnd: 1,
        gain: 1,
        fadeInSec: 0,
        fadeOutSec: 0,
        muted: false,
      },
    ] satisfies SfxClip[],
    musicTrack: {
      src: "/music.mp3",
      sourcePath: "C:\\media\\music.mp3",
      name: "music.mp3",
      srcDuration: 20,
      startAtSec: 5,
      gain: 0.5,
    },
    mediaAssets: [
      {
        id: "asset-1",
        kind: "image",
        name: "overlay.png",
        src: "/overlay.png",
        sourcePath: "C:\\media\\overlay.png",
      },
    ],
    splitRatio: 0.55,
    screenGrade: "warm",
    faceGrade: "neutral",
    playhead: 5.5,
    inPoint: 4,
    outPoint: 5.8,
    editStats: {
      retakesRemoved: 4,
      silencesTrimmed: 3,
      secondsSaved: 2,
      finalRuntimeSec: 6,
    },
    past: [],
    future: [],
    captionStyle: initial.captionStyle,
  });
}

describe("atomic transcript store action", () => {
  it("rolls back appearance before capturing preserve-cuts transcript history", () => {
    seedRichState();
    const overlayId = useRepurposeStore.getState().overlays[0].id;
    const appearanceToken = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(overlayId, "cornerRadius") as string;
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(appearanceToken, 0.4);
    const cancellationListener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(cancellationListener);

    useRepurposeStore.getState().applyTranscript({
      words: newWords,
      mode: "preserve-cuts",
    });
    expect(cancellationListener).toHaveBeenCalledTimes(1);
    useRepurposeStore
      .getState()
      .updateOverlayAppearanceGesture(appearanceToken, 0.8);
    useRepurposeStore.getState().endOverlayAppearanceGesture(appearanceToken);

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays[0]).not.toHaveProperty(
      "cornerRadius"
    );
    expect(useRepurposeStore.getState().words).toEqual(newWords);
    expect(useRepurposeStore.getState().past).toHaveLength(1);

    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().words).toEqual(oldWords);
    expect(useRepurposeStore.getState().overlays[0]).not.toHaveProperty(
      "cornerRadius"
    );
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().words).toEqual(newWords);
    expect(useRepurposeStore.getState().overlays[0]).not.toHaveProperty(
      "cornerRadius"
    );
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    unsubscribe();
  });

  it.each([
    ["global preserve-cuts", { kind: "global" } as const, "preserve-cuts" as const],
    [
      "clip rebuild",
      { kind: "clip", id: "edited-clip" } as const,
      "rebuild" as const,
    ],
  ])(
    "finalizes an active %s split before transcript history",
    (_name, target, mode) => {
      seedRichState();
      const splitToken = useRepurposeStore
        .getState()
        .beginSplitRatioGesture(target) as string;
      useRepurposeStore
        .getState()
        .updateSplitRatioGesture(splitToken, 0.72);
      const cancellationListener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeSplitRatioGestureCancellation(cancellationListener);

      useRepurposeStore.getState().applyTranscript(
        mode === "preserve-cuts"
          ? { words: newWords, mode }
          : {
              words: newWords,
              mode,
              rebuiltClips: [{ ...bootstrap(2), id: "rebuilt" }],
            }
      );
      expect(cancellationListener).toHaveBeenCalledTimes(1);
      useRepurposeStore
        .getState()
        .updateSplitRatioGesture(splitToken, 0.91);
      useRepurposeStore.getState().endSplitRatioGesture(splitToken);

      expect(cancellationListener).toHaveBeenCalledTimes(1);
      expect(useRepurposeStore.getState().words).toEqual(newWords);
      expect(useRepurposeStore.getState().past).toHaveLength(2);
      if (target.kind === "global") {
        expect(useRepurposeStore.getState().splitRatio).toBe(0.72);
      } else {
        expect(useRepurposeStore.getState().clips).toMatchObject([
          { id: "rebuilt" },
        ]);
      }

      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().words).toEqual(oldWords);
      expect(useRepurposeStore.getState().splitRatio).toBe(
        target.kind === "global" ? 0.72 : 0.55
      );
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(
        target.kind === "clip" ? 0.72 : 0.6
      );

      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().splitRatio).toBe(0.55);
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.6);

      useRepurposeStore.getState().redo();
      expect(useRepurposeStore.getState().splitRatio).toBe(
        target.kind === "global" ? 0.72 : 0.55
      );
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(
        target.kind === "clip" ? 0.72 : 0.6
      );
      useRepurposeStore.getState().redo();
      expect(useRepurposeStore.getState().words).toEqual(newWords);
      expect(useRepurposeStore.getState().past).toHaveLength(2);
      if (mode === "rebuild") {
        expect(useRepurposeStore.getState().clips).toMatchObject([
          { id: "rebuilt" },
        ]);
      }
      unsubscribe();
    }
  );

  it("publishes history and transcript document changes in one coherent notification", () => {
    seedRichState();
    const notifications: Array<{
      words: Word[];
      captionsEnabled: boolean;
      pastLength: number;
      futureLength: number;
    }> = [];
    const unsubscribe = useRepurposeStore.subscribe((state) => {
      notifications.push({
        words: state.words,
        captionsEnabled: state.captionsEnabled,
        pastLength: state.past.length,
        futureLength: state.future.length,
      });
    });

    useRepurposeStore.getState().applyTranscript({
      words: newWords,
      mode: "preserve-cuts",
    });
    unsubscribe();

    expect(notifications).toEqual([
      {
        words: newWords,
        captionsEnabled: true,
        pastLength: 1,
        futureLength: 0,
      },
    ]);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().words).toEqual(oldWords);
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().words).toEqual(newWords);
  });

  it("preserves cuts and every clip-local visual field while replacing words and captions in one Undo step", () => {
    seedRichState();
    const before = useRepurposeStore.getState();

    before.applyTranscript({ words: newWords, mode: "preserve-cuts" });

    let state = useRepurposeStore.getState();
    expect(state.clips).toEqual(before.clips);
    expect(state.duration).toBe(6);
    expect(state.words).toEqual(newWords);
    expect(state.deletedWordIndices).toEqual([]);
    expect(state.selectedWordRange).toBeNull();
    expect(state.selectedCaptionBlockId).toBeNull();
    expect(state.selectedClipId).toBe("edited-clip");
    expect(state.captionsEnabled).toBe(true);
    expect(state.captionBlocks.length).toBeGreaterThan(0);
    expect(state.captionBlocks).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          overrideStyle: expect.anything(),
          textOverride: expect.anything(),
        }),
      ])
    );
    expect(state.overlays).toEqual(before.overlays);
    expect(state.markers).toEqual(before.markers);
    // Mixed imported/built-in documents never own the temporary runtime bridge.
    expect(state.sfxTrack).toBeNull();
    expect(state.sfxClips).toEqual(before.sfxClips);
    expect(state.musicTrack).toEqual(before.musicTrack);
    expect(state.mediaAssets).toEqual(before.mediaAssets);
    expect(state.editStats).toEqual(before.editStats);
    expect(state.playhead).toBe(5.5);
    expect(state.inPoint).toBe(4);
    expect(state.outPoint).toBe(5.8);
    expect(state.past).toHaveLength(1);

    state.undo();
    state = useRepurposeStore.getState();
    expect(state.words).toEqual(oldWords);
    expect(state.deletedWordIndices).toEqual([1]);
    expect(state.captionsEnabled).toBe(false);
    expect(state.captionBlocks[0]).toMatchObject({
      id: "old-block",
      textOverride: ["velha", "legenda"],
    });

    state.redo();
    expect(useRepurposeStore.getState()).toMatchObject({
      words: newWords,
      deletedWordIndices: [],
      captionsEnabled: true,
    });
  });

  it("rebuilds clips atomically, preserves unrelated project data, and leaves derived fields outside Undo", () => {
    seedRichState();
    const before = useRepurposeStore.getState();
    const rebuiltClips: Clip[] = [
      {
        ...bootstrap(2),
        id: "rebuilt",
        label: "Rebuilt",
        timelineStart: 99,
        timelineEnd: 101,
      },
    ];
    const stats = {
      retakesRemoved: 1,
      silencesTrimmed: 2,
      secondsSaved: 3,
      finalRuntimeSec: 2,
    };

    before.applyTranscript({
      words: newWords,
      mode: "rebuild",
      rebuiltClips,
      editStats: stats,
    });

    let state = useRepurposeStore.getState();
    expect(state.clips).toEqual([
      expect.objectContaining({
        id: "rebuilt",
        timelineStart: 0,
        timelineEnd: 2,
      }),
    ]);
    expect(state.clips[0]).not.toHaveProperty("splitRatio");
    expect(state.clips[0]).not.toHaveProperty("faceFraming");
    expect(state.clips[0]).not.toHaveProperty("screenFraming");
    expect(state.clips[0]).not.toHaveProperty("manualScene");
    expect(state.duration).toBe(2);
    expect(state.selectedClipId).toBeNull();
    expect(state.sfxTrack).toBeNull();
    expect(state.sfxClips).toEqual([
      expect.objectContaining({
        id: "sfx-crossing-new-end",
        timelineStart: 1.5,
        sourceStart: 0,
        sourceEnd: 0.5,
      }),
    ]);
    expect(state.editStats).toEqual(stats);
    expect(state.playhead).toBe(2);
    expect(state.inPoint).toBeNull();
    expect(state.outPoint).toBeNull();
    expect(state.overlays).toEqual(before.overlays);
    expect(state.overlays[0]).toMatchObject({ timelineStart: 5, timelineEnd: 6 });
    expect(state.markers).toEqual(before.markers);
    expect(state.markers[0].t).toBe(5.5);
    expect(state.musicTrack).toEqual(before.musicTrack);
    expect(state.mediaAssets).toEqual(before.mediaAssets);
    expect(state.splitRatio).toBe(0.55);
    expect(state.screenGrade).toBe("warm");
    expect(state.faceGrade).toBe("neutral");
    expect(state.past).toHaveLength(1);

    state.undo();
    state = useRepurposeStore.getState();
    expect(state.clips).toEqual(before.clips);
    expect(state.words).toEqual(oldWords);
    expect(state.overlays).toEqual(before.overlays);
    expect(state.markers).toEqual(before.markers);
    // The restored SFX document has no automatic legacy bridge clip, so history
    // restoration deterministically clears the temporary runtime track.
    expect(state.sfxTrack).toBeNull();
    expect(state.sfxClips).toEqual(before.sfxClips);
    expect(state.editStats).toEqual(stats);
    expect(state.playhead).toBe(2);
    expect(state.inPoint).toBeNull();
    expect(state.outPoint).toBeNull();

    state.redo();
    state = useRepurposeStore.getState();
    expect(state.clips[0]).toMatchObject({ id: "rebuilt", timelineStart: 0, timelineEnd: 2 });
    expect(state.words).toEqual(newWords);
    expect(state.captionsEnabled).toBe(true);
    expect(state.sfxTrack).toBeNull();
    expect(state.sfxClips).toEqual([
      expect.objectContaining({ id: "sfx-crossing-new-end", sourceEnd: 0.5 }),
    ]);
  });

  it("keeps deleted-scene overlay recovery for preserve-cuts", () => {
    const clips = [editedClip(), { ...bootstrap(2), id: "second", srcStart: 6, srcEnd: 8 }];
    useRepurposeStore.getState().setClips(clips);
    useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/scene-overlay.png",
      naturalWidth: 100,
      naturalHeight: 100,
      atTime: 1,
    });
    useRepurposeStore.getState().deleteClip("edited-clip");
    expect(useRepurposeStore.getState().overlays).toEqual([]);
    useRepurposeStore.setState({ past: [], future: [] });

    useRepurposeStore.getState().applyTranscript({
      words: newWords,
      mode: "preserve-cuts",
    });
    useRepurposeStore.getState().restoreClip("edited-clip");

    expect(useRepurposeStore.getState().overlays).toHaveLength(1);
  });

  it("clears deleted-scene overlay recovery for rebuild and Undo does not recreate it", () => {
    const clips = [editedClip(), { ...bootstrap(2), id: "second", srcStart: 6, srcEnd: 8 }];
    useRepurposeStore.getState().setClips(clips);
    useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/scene-overlay.png",
      naturalWidth: 100,
      naturalHeight: 100,
      atTime: 1,
    });
    useRepurposeStore.getState().deleteClip("edited-clip");
    useRepurposeStore.setState({ past: [], future: [] });

    useRepurposeStore.getState().applyTranscript({
      words: newWords,
      mode: "rebuild",
      rebuiltClips: [{ ...bootstrap(2), id: "rebuilt" }],
    });
    useRepurposeStore.getState().undo();
    useRepurposeStore.getState().restoreClip("edited-clip");

    expect(useRepurposeStore.getState().overlays).toEqual([]);
  });
});

describe("caption placement rebuild preservation", () => {
  const captionWords: Word[] = [
    { text: "one", start: 0, end: 0.4 },
    { text: "two", start: 0.4, end: 0.8 },
    { text: "three", start: 0.8, end: 1.2 },
    { text: "four", start: 1.2, end: 1.6 },
  ];

  it("preserves attached and detached modes while removing stale position keys", () => {
    useRepurposeStore.getState().setClips([bootstrap(2)]);
    useRepurposeStore.getState().setWords(captionWords);
    const [detached, attached] = useRepurposeStore.getState().captionBlocks;
    expect(detached).toBeDefined();
    expect(attached).toBeDefined();
    useRepurposeStore.setState({
      captionBlocks: useRepurposeStore.getState().captionBlocks.map((block) =>
        block.id === detached.id
          ? {
              ...block,
              textOverride: block.words.map((word) => word.text.toUpperCase()),
              overrideStyle: {
                fill: "#123456",
                pinToSplit: false,
                positionYPct: 0.73,
                splitOffsetPct: 0.2,
              },
            }
          : block.id === attached.id
            ? {
                ...block,
                textOverride: block.words.map((word) => word.text.toUpperCase()),
                overrideStyle: {
                  activeFill: "#abcdef",
                  pinToSplit: true,
                  positionYPct: 0.2,
                  splitOffsetPct: -0.1,
                },
              }
            : block
      ),
    });

    useRepurposeStore.getState().rebuildCaptionBlocks();

    const rebuilt = useRepurposeStore.getState().captionBlocks;
    expect(rebuilt[0]).toMatchObject({
      textOverride: detached.words.map((word) => word.text.toUpperCase()),
      overrideStyle: {
        fill: "#123456",
        pinToSplit: false,
        positionYPct: 0.73,
      },
    });
    expect(rebuilt[0].overrideStyle).not.toHaveProperty("splitOffsetPct");
    expect(rebuilt[1]).toMatchObject({
      textOverride: attached.words.map((word) => word.text.toUpperCase()),
      overrideStyle: { activeFill: "#abcdef", pinToSplit: true },
    });
    expect(rebuilt[1].overrideStyle).not.toHaveProperty("positionYPct");
    expect(rebuilt[1].overrideStyle).not.toHaveProperty("splitOffsetPct");
  });

  it("drops placement and text overrides when the first-word anchor disappears", () => {
    useRepurposeStore.getState().setClips([bootstrap(2)]);
    useRepurposeStore.getState().setWords(captionWords);
    const first = useRepurposeStore.getState().captionBlocks[0];
    useRepurposeStore.setState({
      captionBlocks: useRepurposeStore.getState().captionBlocks.map((block) =>
        block.id === first.id
          ? {
              ...block,
              id: "legacy-anchor-that-disappears",
              textOverride: block.words.map(() => "OVERRIDE"),
              overrideStyle: {
                fill: "#123456",
                pinToSplit: false,
                positionYPct: 0.73,
              },
            }
          : block
      ),
      words: captionWords.slice(1),
    });

    useRepurposeStore.getState().rebuildCaptionBlocks();

    const newFirst = useRepurposeStore.getState().captionBlocks[0];
    expect(newFirst.words[0].start).toBe(captionWords[1].start);
    expect(newFirst).not.toHaveProperty("textOverride");
    expect(newFirst).not.toHaveProperty("overrideStyle");
  });

  it("consumes one ambiguous legacy override only once in clip order", () => {
    const sharedWords: Word[] = [{ text: "shared", start: 0, end: 0.4 }];
    useRepurposeStore.setState({
      clips: [
        { ...bootstrap(1), id: "first" },
        { ...bootstrap(1), id: "second" },
      ],
      words: sharedWords,
      captionBlocks: [
        {
          id: "legacy-cap-0",
          words: sharedWords,
          start: 0,
          end: 0.4,
          textOverride: ["LEGACY"],
          overrideStyle: {
            fill: "#ff0000",
            pinToSplit: false,
            positionYPct: 0.7,
          },
        },
      ],
    });

    useRepurposeStore.getState().rebuildCaptionBlocks();

    const [first, second] = useRepurposeStore.getState().captionBlocks;
    expect(first).toMatchObject({
      id: expect.stringMatching(/^first--cap-/),
      textOverride: ["LEGACY"],
      overrideStyle: {
        fill: "#ff0000",
        pinToSplit: false,
        positionYPct: 0.7,
      },
    });
    expect(second.id).toMatch(/^second--cap-/);
    expect(second).not.toHaveProperty("textOverride");
    expect(second).not.toHaveProperty("overrideStyle");
  });

  it("prefers an exact namespaced override before legacy fallback at the same start", () => {
    const sharedWords: Word[] = [{ text: "shared", start: 0, end: 0.4 }];
    useRepurposeStore.setState({
      clips: [
        { ...bootstrap(1), id: "first" },
        { ...bootstrap(1), id: "second" },
      ],
      words: sharedWords,
      captionBlocks: [
        {
          id: "legacy-cap-0",
          words: sharedWords,
          start: 0,
          end: 0.4,
          overrideStyle: { fill: "#ff0000", pinToSplit: true },
        },
        {
          id: "second--old-cap-0",
          words: sharedWords,
          start: 0,
          end: 0.4,
          overrideStyle: {
            fill: "#00ff00",
            pinToSplit: false,
            positionYPct: 0.8,
          },
        },
      ],
    });

    useRepurposeStore.getState().rebuildCaptionBlocks();

    expect(useRepurposeStore.getState().captionBlocks).toMatchObject([
      {
        id: expect.stringMatching(/^first--cap-/),
        overrideStyle: { fill: "#ff0000", pinToSplit: true },
      },
      {
        id: expect.stringMatching(/^second--cap-/),
        overrideStyle: {
          fill: "#00ff00",
          pinToSplit: false,
          positionYPct: 0.8,
        },
      },
    ]);
  });
});
