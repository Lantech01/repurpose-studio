import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useProjectPersistence } from "@/app/repurpose-studio/_components/useProjectPersistence";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  VIDEO_TIMELINE_CLIP_ID,
  type Clip,
  type FootageMeta,
  type Overlay,
  type ProjectSnapshot,
} from "@/lib/repurpose/types";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("@/lib/export/workerBridge", () => ({
  prespawnWorker: vi.fn(),
  disposeWarmWorker: vi.fn(),
}));

const clip: Clip = {
  id: VIDEO_TIMELINE_CLIP_ID,
  kind: "take",
  label: "Restored clip",
  srcStart: 0,
  srcEnd: 5,
  timelineStart: 0,
  timelineEnd: 5,
  kept: true,
  isKeeperTake: true,
  occurrences: [{ start: 0, end: 5 }],
  keeperIndex: 0,
};

const footageMeta: FootageMeta = {
  faceCamPath: "/media/face.mp4",
  screenPath: "/media/screen.mp4",
  fps: 30,
  width: 1920,
  height: 1080,
  durationSec: 5,
};

const snapshot: ProjectSnapshot = {
  clips: [clip],
  duration: 5,
  splitRatio: 0.5,
  screenGrade: "none",
  faceGrade: "neutral",
  playhead: 0,
  inPoint: null,
  outPoint: null,
  loopPlayback: false,
  footageMeta,
};

function imageOverlay(id: string, zIndex: number): Overlay {
  return {
    id,
    kind: "image",
    src: `/media/${id}.png`,
    naturalWidth: 800,
    naturalHeight: 600,
    timelineStart: 0,
    timelineEnd: 4,
    srcStart: 0,
    srcDuration: 0,
    transform: { x: 0.5, y: 0.25, scale: 1, rotation: 0 },
    zIndex,
    opacity: 1,
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  replaceMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project: {
          id: "saved-project",
          name: "Saved project",
          createdAt: "2026-08-22T00:00:00.000Z",
          snapshot,
        },
      }),
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useProjectPersistence hydration", () => {
  test("preserves an unnamespaced legacy caption through reopen and rebuild", async () => {
    const legacyWords = [
      { text: "legacy", start: 0, end: 0.4 },
      { text: "caption", start: 0.4, end: 0.8 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: {
              ...snapshot,
              words: legacyWords,
              captionsEnabled: true,
              captionBlocks: [
                {
                  id: "legacy-cap-0",
                  words: legacyWords,
                  start: 0,
                  end: 0.8,
                  keywordIndex: 1,
                  textOverride: ["LEGACY", "CAPTION"],
                  overrideStyle: {
                    fill: "#abcdef",
                    pinToSplit: false,
                    positionYPct: 0.72,
                  },
                },
              ],
            },
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(useRepurposeStore.getState().captionBlocks[0].id).toBe("legacy-cap-0");

    useRepurposeStore.getState().rebuildCaptionBlocks();

    expect(useRepurposeStore.getState().captionBlocks[0]).toMatchObject({
      id: expect.stringMatching(new RegExp(`^${clip.id}--cap-`)),
      keywordIndex: 1,
      textOverride: ["LEGACY", "CAPTION"],
      overrideStyle: {
        fill: "#abcdef",
        pinToSplit: false,
        positionYPct: 0.72,
      },
    });
  });

  test("cancels caption ownership exactly once through the actual hydration path", async () => {
    const oldWords = [{ text: "old", start: 0, end: 0.5 }];
    useRepurposeStore.setState({
      clips: [clip],
      duration: 5,
      words: oldWords,
      captionBlocks: [
        {
          id: "old-caption",
          words: oldWords,
          start: 0,
          end: 0.5,
          overrideStyle: { pinToSplit: false, positionYPct: 0.63 },
        },
      ],
    });
    useRepurposeStore.getState().addMarker(0.25);
    const token = useRepurposeStore
      .getState()
      .beginCaptionPositionGesture("old-caption") as string;
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.9);
    const cancellationListener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeCaptionGestureCancellation(cancellationListener);
    const hydratedWords = [{ text: "hydrated", start: 0, end: 0.75 }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: {
              ...snapshot,
              words: hydratedWords,
              captionsEnabled: true,
              captionBlocks: [
                {
                  id: "hydrated-caption",
                  words: hydratedWords,
                  start: 0,
                  end: 0.75,
                  textOverride: ["HYDRATED"],
                  overrideStyle: {
                    fill: "#abcdef",
                    pinToSplit: false,
                    positionYPct: 0.72,
                  },
                },
              ],
              markers: [{ id: "hydrated-marker", t: 0.5, label: "Hydrated" }],
            },
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    useRepurposeStore.getState().updateCaptionPositionGesture(token, 0.95);
    useRepurposeStore.getState().cancelCaptionPositionGesture(token);

    expect(cancellationListener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState()).toMatchObject({
      words: hydratedWords,
      captionsEnabled: true,
      captionBlocks: [
        {
          id: "hydrated-caption",
          textOverride: ["HYDRATED"],
          overrideStyle: {
            fill: "#abcdef",
            pinToSplit: false,
            positionYPct: 0.72,
          },
        },
      ],
      markers: [{ id: "hydrated-marker", t: 0.5, label: "Hydrated" }],
      past: [],
      future: [],
    });
    unsubscribe();
  });

  test("normalizes explicit caption placement without losing text or unrelated style", async () => {
    const words = [
      { text: "attached", start: 0, end: 0.5 },
      { text: "detached", start: 0.5, end: 1 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: {
              ...snapshot,
              words,
              captionsEnabled: true,
              captionBlocks: [
                {
                  id: "attached",
                  words: [words[0]],
                  start: 0,
                  end: 0.5,
                  textOverride: ["ATTACHED"],
                  overrideStyle: {
                    fill: "#123456",
                    pinToSplit: true,
                    positionYPct: 0.2,
                    splitOffsetPct: 0.1,
                  },
                },
                {
                  id: "detached",
                  words: [words[1]],
                  start: 0.5,
                  end: 1,
                  textOverride: ["DETACHED"],
                  overrideStyle: {
                    activeFill: "#abcdef",
                    pinToSplit: false,
                    positionYPct: 1.4,
                    splitOffsetPct: -0.2,
                  },
                },
              ],
            },
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    const [attached, detached] = useRepurposeStore.getState().captionBlocks;
    expect(attached).toMatchObject({
      textOverride: ["ATTACHED"],
      overrideStyle: { fill: "#123456", pinToSplit: true },
    });
    expect(attached.overrideStyle).not.toHaveProperty("positionYPct");
    expect(attached.overrideStyle).not.toHaveProperty("splitOffsetPct");
    expect(detached).toMatchObject({
      textOverride: ["DETACHED"],
      overrideStyle: {
        activeFill: "#abcdef",
        pinToSplit: false,
        positionYPct: 1,
      },
    });
    expect(detached.overrideStyle).not.toHaveProperty("splitOffsetPct");
  });

  test("normalizes missing and malformed overlay appearance while preserving valid values", async () => {
    const legacy = imageOverlay("legacy", 0);
    const malformed = {
      ...imageOverlay("malformed", 1),
      entranceEffect: "slide",
      exitEffect: { type: "unknown", durationSec: 9 },
      cornerRadius: Number.NaN,
    } as unknown as Overlay;
    const valid: Overlay = {
      ...imageOverlay("valid", 2),
      entranceEffect: { type: "slide", durationSec: 0.6, direction: "down" },
      exitEffect: { type: "fade", durationSec: 1.2 },
      cornerRadius: 0.25,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: { ...snapshot, overlays: [legacy, malformed, valid] },
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(useRepurposeStore.getState().overlays).toMatchObject([
      {
        id: "legacy",
        entranceEffect: { type: "none", durationSec: 0.35 },
        exitEffect: { type: "none", durationSec: 0.35 },
        cornerRadius: 0,
      },
      {
        id: "malformed",
        entranceEffect: { type: "none", durationSec: 0.35 },
        exitEffect: { type: "none", durationSec: 0.35 },
        cornerRadius: 0,
      },
      {
        id: "valid",
        entranceEffect: { type: "slide", durationSec: 0.6, direction: "down" },
        exitEffect: { type: "fade", durationSec: 1.2 },
        cornerRadius: 0.25,
      },
    ]);
  });

  test("cancels an active appearance gesture before hydrating a replacement", async () => {
    const oldId = useRepurposeStore.getState().addOverlay({
      kind: "image",
      src: "/old.png",
      naturalWidth: 800,
      naturalHeight: 600,
      atTime: 0,
    });
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayAppearanceGestureCancellation(listener);
    const token = useRepurposeStore
      .getState()
      .beginOverlayAppearanceGesture(oldId, "cornerRadius") as string;
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.4);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: {
              ...snapshot,
              overlays: [
                {
                  ...imageOverlay("replacement", 0),
                  cornerRadius: 0.2,
                },
              ],
            },
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    useRepurposeStore.getState().updateOverlayAppearanceGesture(token, 0.5);

    expect(useRepurposeStore.getState().overlays).toMatchObject([
      { id: "replacement", cornerRadius: 0.2 },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test.each([
    [0, 0],
    [1, 1],
    [-0.25, 0],
    [1.25, 1],
    [0.2, 0.2],
    [0.79, 0.79],
    [Number.NaN, 0.5],
    [Infinity, 0.5],
    ["0.2", 0.5],
  ])("normalizes persisted global split ratio %s to %s", async (persisted, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: { ...snapshot, splitRatio: persisted },
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(useRepurposeStore.getState().splitRatio).toBe(expected);
  });

  test("clamps finite clip overrides and removes invalid overrides without snapping", async () => {
    const splitRatios: unknown[] = [0, 1, -0.25, 1.25, 0.2, 0.79, Number.NaN, Infinity, "0.2"];
    const clips = splitRatios.map((splitRatio, index) => ({
      ...clip,
      id: `clip-${index}`,
      srcStart: index * 5,
      srcEnd: index * 5 + 5,
      timelineStart: index * 5,
      timelineEnd: index * 5 + 5,
      splitRatio,
    })) as Clip[];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: { ...snapshot, clips },
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    const restored = useRepurposeStore.getState().clips;
    expect(restored.slice(0, 6).map((entry) => entry.splitRatio)).toEqual([
      0,
      1,
      0,
      1,
      0.2,
      0.79,
    ]);
    for (const entry of restored.slice(6)) {
      expect(entry).not.toHaveProperty("splitRatio");
    }
  });

  test("restored footage re-enters loading until its media decodes", async () => {
    const { result } = renderHook(() =>
      useProjectPersistence("saved-project")
    );

    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(useRepurposeStore.getState()).toMatchObject({
      footageMeta,
      mediaReadiness: "loading",
      playbackBlockedReason: "Media is still loading.",
    });
  });

  test("restores a transcript-free bootstrap with its duration and empty words", async () => {
    const { result } = renderHook(() =>
      useProjectPersistence("saved-project")
    );

    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(useRepurposeStore.getState()).toMatchObject({
      clips: [
        {
          id: VIDEO_TIMELINE_CLIP_ID,
          srcStart: 0,
          srcEnd: 5,
          timelineStart: 0,
          timelineEnd: 5,
        },
      ],
      duration: 5,
      words: [],
    });
  });

  test("restores applied transcript words, enabled captions, and fresh blocks", async () => {
    const appliedWords = [
      { text: "nova", start: 0, end: 0.5 },
      { text: "legenda", start: 0.5, end: 1 },
    ];
    const appliedSnapshot: ProjectSnapshot = {
      ...snapshot,
      words: appliedWords,
      captionsEnabled: true,
      captionBlocks: [
        {
          id: `${clip.id}--cap-0`,
          words: appliedWords,
          start: 0,
          end: 1,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: appliedSnapshot,
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(useRepurposeStore.getState()).toMatchObject({
      words: appliedWords,
      captionsEnabled: true,
      captionBlocks: appliedSnapshot.captionBlocks,
    });
  });

  test("does not hydrate malformed persisted words into the store", async () => {
    const malformedSnapshot = {
      ...snapshot,
      words: [{ text: "bad", start: Number.NaN, end: 1 }],
      captionsEnabled: true,
      captionBlocks: [{ id: "stale", words: [], start: 0, end: 0 }],
    } as ProjectSnapshot;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          project: {
            id: "saved-project",
            name: "Saved project",
            createdAt: "2026-08-22T00:00:00.000Z",
            snapshot: malformedSnapshot,
          },
        }),
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(useRepurposeStore.getState().words).toEqual([]);
    expect(useRepurposeStore.getState().captionBlocks).toEqual([]);
    expect(useRepurposeStore.getState().captionsEnabled).toBe(false);
  });

  test.each([
    ["a null entry", [null]],
    ["a non-array value", {}],
    [
      "malformed block words",
      [{ id: "bad-words", words: {}, start: 0, end: 1 }],
    ],
    [
      "malformed block timing",
      [{
        id: "bad-time",
        words: [{ text: "first", start: 0, end: 0.5 }],
        start: Number.NaN,
        end: 0.5,
      }],
    ],
    [
      "malformed placement override",
      [{
        id: "bad-placement",
        words: [{ text: "first", start: 0, end: 0.5 }],
        start: 0,
        end: 0.5,
        overrideStyle: { pinToSplit: false, positionYPct: "0.7" },
      }],
    ],
  ])("repairs captionBlocks containing %s without rejecting the project", async (_label, captionBlocks) => {
    const words = [
      { text: "first", start: 0, end: 0.5 },
      { text: "second", start: 0.5, end: 1 },
    ];
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ project: {} }));
        }
        return {
          ok: true,
          json: async () => ({
            project: {
              id: "saved-project",
              name: "Saved project",
              createdAt: "2026-08-22T00:00:00.000Z",
              snapshot: {
                ...snapshot,
                words,
                captionsEnabled: true,
                captionBlocks,
              },
            },
          }),
        } as Response;
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState()).toMatchObject({
      words,
      captionsEnabled: true,
    });
    expect(useRepurposeStore.getState().captionBlocks).toEqual([
      expect.objectContaining({ words, start: 0, end: 1 }),
    ]);
    expect(posts).toEqual([]);
  });

  test("filters a malformed caption block and preserves valid legacy text, style, and normalized placement", async () => {
    const words = [
      { text: "first", start: 0, end: 0.5 },
      { text: "second", start: 0.5, end: 1 },
    ];
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ project: {} }));
        }
        return {
          ok: true,
          json: async () => ({
            project: {
              id: "saved-project",
              name: "Saved project",
              createdAt: "2026-08-22T00:00:00.000Z",
              snapshot: {
                ...snapshot,
                words,
                captionsEnabled: true,
                captionBlocks: [
                  {
                    id: "valid-legacy",
                    words,
                    start: 0,
                    end: 1,
                    keywordIndex: 1,
                    textOverride: ["FIRST", "SECOND"],
                    overrideStyle: {
                      fill: "#abcdef",
                      pinToSplit: false,
                      positionYPct: 1.4,
                      splitOffsetPct: -0.2,
                    },
                  },
                  null,
                ],
              },
            },
          }),
        } as Response;
      })
    );

    const { result } = renderHook(() => useProjectPersistence("saved-project"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState().captionBlocks).toEqual([
      expect.objectContaining({
        words,
        keywordIndex: 1,
        textOverride: ["FIRST", "SECOND"],
        overrideStyle: {
          fill: "#abcdef",
          pinToSplit: false,
          positionYPct: 1,
        },
      }),
    ]);
    expect(posts).toEqual([]);
  });
});
