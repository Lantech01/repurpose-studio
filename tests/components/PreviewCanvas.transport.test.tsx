import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PreviewCanvas,
  type PreviewFrameScheduler,
} from "@/app/repurpose-studio/_components/PreviewCanvas";
import { CaptionPanel } from "@/app/repurpose-studio/_components/CaptionPanel";
import { TransportBar } from "@/app/repurpose-studio/_components/TransportBar";
import {
  CAPTION_TEMPLATE_ORDER,
  CAPTION_TEMPLATES,
  DEFAULT_CAPTION_STYLE,
  activeCaptionBlockAt,
  resolveBlockStyle,
  type CaptionBlock,
  type CaptionLayout,
  type DrawCaptionsOptions,
} from "@/lib/repurpose/captions";
import { effectiveSplitRatio } from "@/lib/repurpose/split-ratio";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  clampOverlayToBand,
  overlayAABBNorm,
} from "@/lib/repurpose/overlay-geometry";
import {
  resolveOverlayAppearanceAt,
  type OverlayFrameSnapshot,
} from "@/lib/repurpose/overlay-effects";
import { splitRatioAt } from "@/lib/repurpose/time-map";
import type { Clip, FootageMeta, Overlay } from "@/lib/repurpose/types";

const {
  drawFrameMock,
  drawCaptionsMock,
  synchronizeMediaTimeMock,
  screenProxyMock,
  faceProxyMock,
  ratioReaders,
} = vi.hoisted(() => ({
  drawFrameMock: vi.fn(),
  drawCaptionsMock: vi.fn(),
  synchronizeMediaTimeMock: vi.fn(),
  screenProxyMock: { src: undefined as string | undefined },
  faceProxyMock: { src: undefined as string | undefined },
  ratioReaders: {
    objectSelection: null as null | (() => OverlayFrameSnapshot | null),
    ghost: null as null | (() => OverlayFrameSnapshot | null),
    selection: null as null | (() => OverlayFrameSnapshot | null),
    toolbar: null as null | (() => OverlayFrameSnapshot | null),
    toolbarSettled: null as null | (() => number),
  },
}));

vi.mock("@/lib/engine/crisp-canvas", () => ({
  setupCrispCanvas: () => ({}),
}));
vi.mock("@/lib/repurpose/compositor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repurpose/compositor")>()),
  drawFrame: drawFrameMock,
}));
vi.mock("@/lib/repurpose/media-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/media-sync")>();
  synchronizeMediaTimeMock.mockImplementation(actual.synchronizeMediaTime);
  return { ...actual, synchronizeMediaTime: synchronizeMediaTimeMock };
});
vi.mock("@/lib/repurpose/captions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repurpose/captions")>()),
  drawCaptions: drawCaptionsMock,
}));
vi.mock("@/lib/repurpose/overlay-effects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repurpose/overlay-effects")>();
  return {
    ...actual,
    resolveOverlayAppearanceAt: vi.fn(actual.resolveOverlayAppearanceAt),
  };
});
vi.mock(
  "@/app/repurpose-studio/_components/GhostOverflowLayer",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/app/repurpose-studio/_components/GhostOverflowLayer")
    >();
    return {
      ...actual,
      GhostOverflowLayer: (
        props: Parameters<typeof actual.GhostOverflowLayer>[0]
      ) => {
        ratioReaders.ghost = props.getFrameSnapshot;
        return createElement(actual.GhostOverflowLayer, props);
      },
    };
  }
);
vi.mock("@/app/repurpose-studio/_components/SnapGuides", () => ({
  SnapGuides: () => null,
}));
vi.mock(
  "@/app/repurpose-studio/_components/SelectionOverlay",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/app/repurpose-studio/_components/SelectionOverlay")
    >();
    return {
      ...actual,
      SelectionOverlay: (props: Parameters<typeof actual.SelectionOverlay>[0]) => {
        ratioReaders.selection = props.getFrameSnapshot;
        return createElement(actual.SelectionOverlay, props);
      },
    };
  }
);
vi.mock(
  "@/app/repurpose-studio/_components/SelectionToolbar",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/app/repurpose-studio/_components/SelectionToolbar")
    >();
    return {
      ...actual,
      SelectionToolbar: (props: Parameters<typeof actual.SelectionToolbar>[0]) => {
        ratioReaders.toolbar = props.getFrameSnapshot;
        ratioReaders.toolbarSettled = props.getSettledSplitRatio ?? null;
        return createElement(actual.SelectionToolbar, props);
      },
    };
  }
);
vi.mock(
  "@/app/repurpose-studio/_components/useObjectSelection",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/app/repurpose-studio/_components/useObjectSelection")
    >();
    return {
      ...actual,
      useObjectSelection: (
        args: Parameters<typeof actual.useObjectSelection>[0]
      ) => {
        ratioReaders.objectSelection = args.getFrameSnapshot;
        return actual.useObjectSelection(args);
      },
    };
  }
);
vi.mock("@/app/repurpose-studio/_components/useSfxPreview", () => ({
  useSfxPreview: () => undefined,
  useMusicPreview: () => undefined,
}));
vi.mock("@/app/repurpose-studio/_components/useVideoProxy", () => ({
  useVideoProxy: ({ target, source, fallbackSrc }: {
    target: { kind: string; role?: string };
    source?: { previewPath?: string };
    fallbackSrc?: string;
  }) => {
    const src =
      target.kind === "footage" && target.role === "face"
        ? faceProxyMock.src ?? source?.previewPath ?? fallbackSrc
        : target.kind === "footage" && target.role === "screen"
          ? screenProxyMock.src ?? source?.previewPath ?? fallbackSrc
          : source?.previewPath ?? fallbackSrc;
    return {
      src,
      usingProxy: src !== fallbackSrc,
      buildProgress: null,
      onSrcError: () => undefined,
    };
  },
}));

const footageMeta: FootageMeta = {
  faceCamPath: "/media/face.mp4",
  screenPath: "/media/screen.mp4",
  fps: 30,
  width: 1920,
  height: 1080,
  durationSec: 12,
};

const clips: Clip[] = [
  {
    id: "clip-a",
    kind: "take",
    label: "First take",
    srcStart: 0,
    srcEnd: 1,
    timelineStart: 0,
    timelineEnd: 1,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 0, end: 1 }],
    keeperIndex: 0,
  },
  {
    id: "clip-b",
    kind: "take",
    label: "Second take after a source gap",
    srcStart: 10,
    srcEnd: 12,
    timelineStart: 1,
    timelineEnd: 3,
    kept: true,
    isKeeperTake: true,
    occurrences: [{ start: 10, end: 12 }],
    keeperIndex: 0,
  },
];

const rapidDoubleCutClips: Clip[] = [
  clips[0],
  {
    ...clips[1],
    srcEnd: 11,
    timelineEnd: 2,
    occurrences: [{ start: 10, end: 11 }],
  },
  {
    ...clips[1],
    id: "clip-c",
    label: "Third take after another source gap",
    srcStart: 20,
    srcEnd: 21,
    timelineStart: 2,
    timelineEnd: 3,
    occurrences: [{ start: 20, end: 21 }],
  },
];

const overlay: Overlay = {
  id: "overlay-video",
  kind: "video",
  src: "/media/overlay.mp4",
  naturalWidth: 1280,
  naturalHeight: 720,
  timelineStart: 0,
  timelineEnd: 3,
  srcStart: 20,
  srcDuration: 23,
  transform: { x: 0.5, y: 0.25, scale: 1, rotation: 0 },
  zIndex: 0,
  opacity: 1,
  muted: true,
  band: "screen",
};

const overlayVideoSource = {
  originalPath: "C:\\media\\overlay.mov",
  workingPath: "C:\\media\\overlay.mp4",
  previewPath: "/media/overlay-proxy.mp4",
  originalName: "overlay.mov",
  inspection: {
    fingerprint: "a".repeat(64),
    container: "mov,mp4",
    extension: ".mov",
    size: 1_024,
    durationSec: 23,
    video: {
      codec: "h264",
      codecTag: "avc1",
      profile: "High",
      pixelFormat: "yuv420p",
      width: 1280,
      height: 720,
      fps: 30,
    },
    audio: null,
  },
  nativeCompatible: true,
  compatibilityStatus: "native" as const,
};

function appearanceOverlays(): Overlay[] {
  return [
    {
      id: "appearance-image",
      kind: "image",
      src: "/media/appearance-image.png",
      naturalWidth: 640,
      naturalHeight: 360,
      timelineStart: 0,
      timelineEnd: 0.4,
      srcStart: 0,
      srcDuration: 0.4,
      transform: { x: 0.45, y: 0.3, scale: 0.36, rotation: 23 },
      zIndex: 0,
      opacity: 0.6,
      muted: true,
      band: "screen",
      entranceEffect: { type: "slide", durationSec: 0.4, direction: "left" },
      exitEffect: { type: "zoom", durationSec: 0.4 },
      cornerRadius: 0.16,
    },
    {
      ...overlay,
      id: "appearance-video",
      naturalWidth: 1920,
      naturalHeight: 1080,
      timelineEnd: 0.4,
      srcStart: 7,
      srcDuration: 12,
      transform: { x: 0.55, y: 0.7, scale: 0.42, rotation: -17 },
      zIndex: 1,
      opacity: 0.35,
      band: "face",
      entranceEffect: { type: "fade", durationSec: 0.4 },
      exitEffect: { type: "pop", durationSec: 0.4 },
      cornerRadius: 0.5,
    },
  ];
}

function appearanceClips(): Clip[] {
  return [
    { ...clips[0], timelineEnd: 0.1, srcEnd: 0.1, splitRatio: 0 },
    {
      ...clips[1],
      timelineStart: 0.1,
      timelineEnd: 0.5,
      srcStart: 10,
      srcEnd: 10.4,
      splitRatio: 1,
      transitionIn: {
        type: "zoom-settle",
        durationSec: 0.2,
        amount: 0.06,
        easing: "natural",
      },
    },
  ];
}

let mediaTimes: WeakMap<HTMLMediaElement, number>;
let mediaReadyStates: WeakMap<HTMLMediaElement, number>;
let playingMedia: WeakSet<HTMLMediaElement>;
let playImpl: ReturnType<
  typeof vi.fn<(this: HTMLMediaElement) => Promise<void>>
>;
let rafCallbacks: Map<number, FrameRequestCallback>;
let nextRafId: number;
let frameScheduler: PreviewFrameScheduler;
let schedulerNow: number;
let chromeRafCallbacks: Map<number, FrameRequestCallback>;
let nextChromeRafId: number;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function resetStore() {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  const store = useRepurposeStore.getState();
  store.setClips(clips);
  store.setFootageMeta(footageMeta);
  useRepurposeStore.setState({ overlays: [overlay] });
}

function mediaFor(container: HTMLElement) {
  const all = Array.from(container.querySelectorAll("video"));
  return {
    screen: all.slice(0, 3) as HTMLVideoElement[],
    face: all.slice(3, 6) as HTMLVideoElement[],
    overlay: all[6] as HTMLVideoElement,
  };
}

function decode(video: HTMLVideoElement, readyState = 4) {
  mediaReadyStates.set(video, readyState);
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
  });
  fireEvent.loadedMetadata(video);
  fireEvent.canPlay(video);
}

function runFrame(timestamp: number) {
  expect(rafCallbacks.size).toBe(1);
  const [id, callback] = Array.from(rafCallbacks.entries())[0];
  rafCallbacks.delete(id);
  schedulerNow = timestamp;
  act(() => callback(timestamp));
}

function runChromeFrame(timestamp = 1_000) {
  const callbacks = Array.from(chromeRafCallbacks.values());
  chromeRafCallbacks.clear();
  act(() => {
    for (const callback of callbacks) callback(timestamp);
  });
}

beforeEach(() => {
  resetStore();
  drawCaptionsMock.mockReturnValue(null);
  for (const key of Object.keys(ratioReaders) as (keyof typeof ratioReaders)[]) {
    ratioReaders[key] = null;
  }
  screenProxyMock.src = undefined;
  faceProxyMock.src = undefined;
  vi.mocked(resolveOverlayAppearanceAt).mockClear();
  mediaTimes = new WeakMap();
  mediaReadyStates = new WeakMap();
  playingMedia = new WeakSet();
  playImpl = vi.fn(function (this: HTMLMediaElement) {
    playingMedia.add(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(playImpl);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    function (this: HTMLMediaElement) {
      playingMedia.delete(this);
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return mediaTimes.get(this) ?? 0;
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(
    function (this: HTMLMediaElement, value: number) {
      mediaTimes.set(this, value);
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return !playingMedia.has(this);
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return mediaReadyStates.get(this) ?? 4;
    }
  );
  vi.spyOn(performance, "now").mockReturnValue(1_000);

  rafCallbacks = new Map();
  nextRafId = 1;
  schedulerNow = 1_000;
  chromeRafCallbacks = new Map();
  nextChromeRafId = 1;
  frameScheduler = {
    request(callback) {
      const id = nextRafId++;
      rafCallbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      rafCallbacks.delete(id);
    },
    now: () => schedulerNow,
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextChromeRafId++;
    chromeRafCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    chromeRafCallbacks.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const previewBounds = (cssHeight = 1_000, cssWidth = 562.5) =>
  ({
    left: 0,
    top: 0,
    right: cssWidth,
    bottom: cssHeight,
    width: cssWidth,
    height: cssHeight,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

function activeCaption(id = "canvas-caption"): CaptionBlock {
  return {
    id,
    words: [{ text: "DRAG", start: 0, end: 1 }],
    start: 0,
    end: 1,
    keywordIndex: 0,
  };
}

function captionLayout(
  block: CaptionBlock,
  overrides: Partial<CaptionLayout> = {}
): CaptionLayout {
  return {
    activeBlockId: block.id,
    activeBlock: block,
    style: DEFAULT_CAPTION_STYLE,
    requestedAnchorY: 960,
    anchorY: 960,
    rawVisualBounds: { left: 270, top: 900, right: 810, bottom: 1_020 },
    visualBounds: { left: 270, top: 900, right: 810, bottom: 1_020 },
    anchorRange: { min: 60, max: 1_860 },
    blockScale: 1,
    blockAlpha: 1,
    attachedTargetAnchorY: 960,
    ...overrides,
  };
}

function renderCaptionCanvas(options: {
  block?: CaptionBlock;
  layout?: CaptionLayout;
  width?: number;
  height?: number;
  bounds?: DOMRect;
  onAncestorPointerDown?: () => void;
} = {}) {
  const block = options.block ?? activeCaption();
  const layout = options.layout ?? captionLayout(block);
  useRepurposeStore.setState({
    words: block.words,
    captionBlocks: [block],
    captionsEnabled: true,
    captionStyle: DEFAULT_CAPTION_STYLE,
    playhead: 0.5,
    selectedCaptionBlockId: null,
    past: [],
    future: [],
  });
  drawCaptionsMock.mockReturnValue(layout);
  const canvas = (
    <PreviewCanvas
      width={options.width}
      height={options.height}
      frameScheduler={frameScheduler}
    />
  );
  const result = render(
    options.onAncestorPointerDown ? (
      <div onPointerDown={options.onAncestorPointerDown}>{canvas}</div>
    ) : (
      canvas
    )
  );
  const preview = (options.onAncestorPointerDown
    ? result.container.firstElementChild?.firstElementChild
    : result.container.firstElementChild) as HTMLDivElement;
  vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(
    options.bounds ?? previewBounds()
  );
  runFrame(1_000);
  return {
    ...result,
    preview,
    block,
    layout,
    captionTarget: result.getByLabelText("Move active caption") as HTMLDivElement,
    separator: result.getByRole("separator"),
    interaction: result.container.querySelector<HTMLDivElement>(
      '[title^="Click an overlay"]'
    )!,
  };
}

function followCaptionTransient(
  block: CaptionBlock,
  base: CaptionLayout,
  outputHeight = 1_920
) {
  drawCaptionsMock.mockImplementation(
    (_context: unknown, options: DrawCaptionsOptions) => {
      const anchorY =
        options.transientPosition?.blockId === block.id
          ? options.transientPosition.positionYPct * outputHeight
          : base.anchorY;
      const delta = anchorY - base.anchorY;
      return captionLayout(block, {
        ...base,
        requestedAnchorY: anchorY,
        anchorY,
        rawVisualBounds: {
          left: base.rawVisualBounds.left,
          top: base.rawVisualBounds.top + delta,
          right: base.rawVisualBounds.right,
          bottom: base.rawVisualBounds.bottom + delta,
        },
        visualBounds: {
          left: base.visualBounds.left,
          top: base.visualBounds.top + delta,
          right: base.visualBounds.right,
          bottom: base.visualBounds.bottom + delta,
        },
      });
    }
  );
}

function followCurrentCaptionDocument(
  base: CaptionLayout,
  outputHeight = 1_920
) {
  drawCaptionsMock.mockImplementation(
    (_context: unknown, options: DrawCaptionsOptions) => {
      if (options.srcT === null) return null;
      const block = activeCaptionBlockAt(options.blocks, options.srcT);
      if (!block) return null;
      const style = resolveBlockStyle(options.style, block);
      const attachedTargetAnchorY =
        ((options.splitRatio ?? style.positionYPct) + style.splitOffsetPct) *
        outputHeight;
      const requestedAnchorY = style.pinToSplit
        ? attachedTargetAnchorY
        : style.positionYPct * outputHeight;
      return captionLayout(block, {
        ...base,
        activeBlockId: block.id,
        activeBlock: block,
        style,
        requestedAnchorY,
        anchorY: Math.max(
          base.anchorRange.min,
          Math.min(base.anchorRange.max, requestedAnchorY)
        ),
        attachedTargetAnchorY,
      });
    }
  );
}

function captionCapture(target: HTMLElement) {
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperties(target, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { setPointerCapture, releasePointerCapture };
}

function beginCaptionDrag(target: HTMLElement, pointerId = 401) {
  fireEvent.pointerDown(target, {
    pointerId,
    clientX: 281.25,
    clientY: 500,
  });
}

function moveCaption(pointerId: number, clientY: number, clientX = 281.25) {
  fireEvent.pointerMove(window, { pointerId, clientX, clientY });
}

function renderDivider(options: { height?: number; cssHeight?: number } = {}) {
  const result = render(
    <PreviewCanvas
      height={options.height}
      frameScheduler={frameScheduler}
    />
  );
  const preview = result.container.firstElementChild as HTMLDivElement;
  vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(
    previewBounds(options.cssHeight)
  );
  const separator = result.container.querySelector<HTMLDivElement>(
    ".cursor-ns-resize"
  );
  expect(separator).not.toBeNull();
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperties(separator!, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return {
    ...result,
    preview,
    separator: separator!,
    setPointerCapture,
    releasePointerCapture,
  };
}

function pointerDown(separator: HTMLElement, pointerId = 1) {
  fireEvent.pointerDown(separator, {
    pointerId,
    clientX: 100,
    clientY: 500,
  });
}

function pointerMove(pointerId: number, clientY: number) {
  fireEvent.pointerMove(window, { pointerId, clientX: 100, clientY });
}

function setTransitionSplitAtCut() {
  useRepurposeStore.setState({
    clips: [
      { ...clips[0], splitRatio: 0.34 },
      {
        ...clips[1],
        splitRatio: 0.9,
        transitionIn: {
          type: "zoom-settle",
          durationSec: 0.4,
          amount: 0.025,
          easing: "natural",
        },
      },
    ],
    duration: 3,
    playhead: 1,
    past: [],
    future: [],
  });
}

function exerciseEndpointRouting({
  sceneClips,
  playhead,
  globalSplit,
  resolvedSplit,
  activeClipId,
}: {
  sceneClips: Clip[];
  playhead: number;
  globalSplit: number;
  resolvedSplit: 0 | 1;
  activeClipId: string;
}) {
  const hiddenBand = resolvedSplit === 0 ? "screen" : "face";
  const visibleRegion = resolvedSplit === 0 ? "face" : "screen";
  const pointerY = resolvedSplit === 0 ? 0 : 1600;
  const hidden: Overlay = {
    ...overlay,
    id: `hidden-${hiddenBand}`,
    band: hiddenBand,
    transform: { x: 0.5, y: 0.5, scale: 4, rotation: 0 },
  };
  useRepurposeStore.setState({
    clips: sceneClips,
    duration: sceneClips.at(-1)?.timelineEnd ?? 0,
    playhead,
    splitRatio: globalSplit,
    overlays: [hidden],
    syncFaceCam: false,
  });
  const { container } = render(<PreviewCanvas frameScheduler={frameScheduler} />);
  const preview = container.firstElementChild as HTMLDivElement;
  const interaction = container.querySelector<HTMLDivElement>(
    '[title^="Click an overlay"]'
  );
  expect(interaction).not.toBeNull();
  const bounds = {
    left: 0,
    top: 0,
    right: 900,
    bottom: 1600,
    width: 900,
    height: 1600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(bounds);
  vi.spyOn(interaction!, "getBoundingClientRect").mockReturnValue(bounds);
  runFrame(1_000);

  fireEvent.pointerDown(interaction!, {
    pointerId: 7,
    clientX: 450,
    clientY: pointerY,
  });
  fireEvent.pointerMove(window, {
    pointerId: 7,
    clientX: 500,
    clientY: pointerY === 0 ? 20 : 1580,
  });
  fireEvent.pointerUp(window, { pointerId: 7 });
  fireEvent.wheel(interaction!, {
    clientX: 450,
    clientY: pointerY,
    deltaY: -100,
  });

  const state = useRepurposeStore.getState();
  const active = state.clips.find((item) => item.id === activeClipId);
  expect(state.selectedOverlayId).toBeNull();
  expect(state.selectedClipId).toBe(activeClipId);
  expect(active?.[`${visibleRegion}Framing`]).toBeDefined();
  expect(
    active?.[visibleRegion === "face" ? "screenFraming" : "faceFraming"]
  ).toBeUndefined();
  expect(state.overlays[0].transform).toEqual(hidden.transform);
}

describe("PreviewCanvas caption hit target", () => {
  test("maps logical bounds to CSS and exposes a semantic vertical position control", () => {
    const block = activeCaption();
    const layout = captionLayout(block, {
      visualBounds: { left: 540, top: 1_440, right: 1_620, bottom: 1_920 },
    });
    const { captionTarget } = renderCaptionCanvas({
      block,
      layout,
      width: 2_160,
      height: 3_840,
      bounds: previewBounds(960, 540),
    });

    expect(captionTarget).toBeVisible();
    expect(captionTarget).toHaveAccessibleName("Move active caption");
    expect(captionTarget).toHaveAttribute("role", "slider");
    expect(captionTarget).toHaveAttribute("aria-orientation", "vertical");
    expect(captionTarget).toHaveAttribute("aria-valuemin", "0");
    expect(captionTarget).toHaveAttribute("aria-valuemax", "100");
    expect(captionTarget).toHaveAttribute("aria-valuenow", "25");
    expect(captionTarget).toHaveAttribute(
      "aria-valuetext",
      "Attached to split at 25%"
    );
    expect(captionTarget).toHaveAttribute("tabindex", "0");
    expect(captionTarget.style.left).toBe("135px");
    expect(captionTarget.style.top).toBe("360px");
    expect(captionTarget.style.width).toBe("270px");
    expect(captionTarget.style.height).toBe("120px");
    expect(captionTarget.style.cursor).toBe("ns-resize");
    expect(Number(captionTarget.style.zIndex)).toBeGreaterThan(10);
    expect(Number(captionTarget.style.zIndex)).toBeLessThan(20);
  });

  test("direct caption dispatch selects its block without starting a split", () => {
    const { captionTarget, block, separator } = renderCaptionCanvas();
    const captionCapture = vi.fn();
    const splitCapture = vi.fn();
    Object.defineProperty(captionTarget, "setPointerCapture", {
      configurable: true,
      value: captionCapture,
    });
    Object.defineProperty(separator, "setPointerCapture", {
      configurable: true,
      value: splitCapture,
    });

    fireEvent.pointerDown(captionTarget, {
      pointerId: 301,
      clientX: 280,
      clientY: 500,
    });

    expect(captionCapture).toHaveBeenCalledWith(301);
    expect(splitCapture).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState().selectedCaptionBlockId).toBe(block.id);
    fireEvent.pointerUp(window, { pointerId: 301, clientX: 280, clientY: 500 });
    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  test("keeps overlay routing outside the caption bounds", () => {
    const outsideOverlay: Overlay = {
      ...overlay,
      id: "outside-caption-overlay",
      transform: { x: 0.1, y: 0.1, scale: 0.1, rotation: 0 },
    };
    useRepurposeStore.setState({ overlays: [outsideOverlay] });
    const { interaction } = renderCaptionCanvas();
    vi.spyOn(interaction, "getBoundingClientRect").mockReturnValue(previewBounds());

    fireEvent.pointerDown(interaction, {
      pointerId: 302,
      clientX: 56.25,
      clientY: 100,
    });

    expect(useRepurposeStore.getState().selectedOverlayId).toBe(
      outsideOverlay.id
    );
    fireEvent.pointerUp(window, { pointerId: 302 });
  });

  test("renders the real layer stack in one root and stops higher-layer pointer propagation", () => {
    useRepurposeStore.setState({
      selectedOverlayId: overlay.id,
      selectedOverlayIds: [overlay.id],
    });
    const bubbled = vi.fn();
    const view = renderCaptionCanvas({ onAncestorPointerDown: bubbled });
    runChromeFrame();

    const handle = view.getByRole("button", { name: "Rotate overlay" });
    const selectionFrame = handle.parentElement as HTMLElement;
    const toolbarButton = view.getByTitle("Delete overlay (Delete)");
    const toolbar = toolbarButton.closest(".fixed") as HTMLElement;
    const layers = [
      toolbar,
      selectionFrame,
      view.captionTarget,
      view.separator,
      view.interaction,
    ];
    for (const layer of layers) expect(layer.parentElement).toBe(view.preview);

    const z = layers.map((layer) => Number(getComputedStyle(layer).zIndex));
    expect(z[0]).toBeGreaterThan(z[2]);
    expect(z[1]).toBeGreaterThan(z[2]);
    expect(z[2]).toBeGreaterThan(z[3]);
    expect(z[3]).toBeGreaterThan(z[4]);
    expect(getComputedStyle(handle).pointerEvents).toBe("auto");
    expect(getComputedStyle(toolbar).pointerEvents).toBe("auto");
    expect(getComputedStyle(view.captionTarget).pointerEvents).toBe("auto");
    expect(getComputedStyle(view.separator).pointerEvents).toBe("auto");
    expect(getComputedStyle(view.interaction).pointerEvents).toBe("auto");
    expect(view.preview.style.transform).toBe("");
    expect(view.preview.style.zIndex).toBe("");
    expect(view.preview.style.isolation).toBe("");

    captionCapture(handle);
    captionCapture(view.captionTarget);
    captionCapture(view.separator);
    fireEvent.pointerDown(handle, { pointerId: 303, clientX: 280, clientY: 500 });
    fireEvent.pointerCancel(window, { pointerId: 303 });
    fireEvent.pointerDown(toolbarButton, { pointerId: 304 });
    fireEvent.pointerDown(view.captionTarget, {
      pointerId: 305,
      clientX: 280,
      clientY: 500,
    });
    fireEvent.pointerCancel(window, { pointerId: 305 });
    fireEvent.pointerDown(view.separator, { pointerId: 306, clientY: 500 });
    fireEvent.pointerCancel(window, { pointerId: 306 });
    expect(bubbled).not.toHaveBeenCalled();
  });
});

describe("PreviewCanvas caption frame freshness", () => {
  test.each(["pointer", "keyboard"] as const)(
    "accepts a deep-cloned active block snapshot for %s input",
    (input) => {
      const block = activeCaption();
      const clonedBlock = structuredClone(block);
      const layout = captionLayout(clonedBlock);
      const view = renderCaptionCanvas({ block, layout });
      const capture = captionCapture(view.captionTarget);
      expect(layout.activeBlock).not.toBe(block);
      expect(layout.activeBlock).toEqual(block);

      if (input === "pointer") {
        fireEvent.pointerDown(view.captionTarget, {
          pointerId: 318,
          clientX: 281.25,
          clientY: 500,
        });
        expect(capture.setPointerCapture).toHaveBeenCalledWith(318);
        expect(useRepurposeStore.getState().selectedCaptionBlockId).toBe(block.id);
        fireEvent.pointerUp(window, { pointerId: 318 });
        expect(useRepurposeStore.getState().past).toEqual([]);
        return;
      }

      fireEvent.keyDown(view.captionTarget, { key: "ArrowDown" });
      expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
        pinToSplit: false,
        positionYPct: 0.51,
      });
      expect(useRepurposeStore.getState().past).toHaveLength(1);
    }
  );

  test.each(["pointer", "keyboard"] as const)(
    "rejects a cloned layout whose active block ID is stale for %s input",
    (input) => {
      const block = activeCaption();
      const layout = captionLayout({
        ...structuredClone(block),
        id: "stale-caption-id",
      });
      const view = renderCaptionCanvas({ block, layout });
      const capture = captionCapture(view.captionTarget);
      const before = useRepurposeStore.getState().captionBlocks;

      if (input === "pointer") {
        fireEvent.pointerDown(view.captionTarget, {
          pointerId: 319,
          clientX: 281.25,
          clientY: 500,
        });
      } else {
        fireEvent.keyDown(view.captionTarget, { key: "ArrowDown" });
      }

      expect(capture.setPointerCapture).not.toHaveBeenCalled();
      expect(useRepurposeStore.getState().selectedCaptionBlockId).toBeNull();
      expect(useRepurposeStore.getState().captionBlocks).toBe(before);
      expect(useRepurposeStore.getState().past).toEqual([]);
      expect(view.captionTarget).not.toBeVisible();
    }
  );

  test.each([
    ["seek", () => useRepurposeStore.getState().setPlayhead(0.6)],
    [
      "style change",
      () =>
        useRepurposeStore.setState((state) => ({
          captionStyle: { ...state.captionStyle, fill: "#abcdef" },
        })),
    ],
    [
      "block change",
      () =>
        useRepurposeStore.setState((state) => ({
          captionBlocks: state.captionBlocks.map((block) => ({ ...block })),
        })),
    ],
    [
      "clip change",
      () =>
        useRepurposeStore.setState((state) => ({
          clips: state.clips.map((clip) => ({ ...clip })),
        })),
    ],
  ] as const)(
    "rejects a layout invalidated by %s and accepts the next rendered frame",
    (_label, mutate) => {
      const view = renderCaptionCanvas();
      followCurrentCaptionDocument(view.layout);
      const capture = captionCapture(view.captionTarget);

      act(() => mutate());
      fireEvent.pointerDown(view.captionTarget, {
        pointerId: 320,
        clientX: 281.25,
        clientY: 500,
      });
      moveCaption(320, 700);
      fireEvent.pointerUp(window, { pointerId: 320 });

      expect(capture.setPointerCapture).not.toHaveBeenCalled();
      expect(useRepurposeStore.getState().selectedCaptionBlockId).toBeNull();
      expect(useRepurposeStore.getState().past).toEqual([]);
      expect(view.captionTarget).not.toBeVisible();

      runFrame(1_016);
      expect(view.captionTarget).toBeVisible();
      fireEvent.pointerDown(view.captionTarget, {
        pointerId: 321,
        clientX: 281.25,
        clientY: 500,
      });
      expect(capture.setPointerCapture).toHaveBeenCalledWith(321);
      expect(useRepurposeStore.getState().selectedCaptionBlockId).toBe(
        view.block.id
      );
      fireEvent.pointerUp(window, { pointerId: 321 });
      expect(useRepurposeStore.getState().past).toEqual([]);
    }
  );

  test("rejects focused keyboard input from a stale or hidden layout", async () => {
    const user = userEvent.setup();
    const view = renderCaptionCanvas();
    followCurrentCaptionDocument(view.layout);
    const before = useRepurposeStore.getState().captionBlocks;
    await user.tab();
    expect(document.activeElement).toBe(view.captionTarget);
    act(() =>
      useRepurposeStore.setState((state) => ({
        captionStyle: { ...state.captionStyle, fill: "#fedcba" },
      }))
    );

    await user.keyboard("{ArrowDown}");
    expect(useRepurposeStore.getState().captionBlocks).toBe(before);
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(view.captionTarget).not.toBeVisible();

    runFrame(1_016);
    drawCaptionsMock.mockReturnValue(null);
    runFrame(1_032);
    await user.keyboard("{ArrowDown}");
    expect(useRepurposeStore.getState().captionBlocks).toBe(before);
    expect(useRepurposeStore.getState().past).toEqual([]);
  });
});

describe("PreviewCanvas caption keyboard positioning", () => {
  test("keeps the slider focused while repeated arrows accumulate before the next frame", async () => {
    const user = userEvent.setup();
    const view = renderCaptionCanvas();
    await user.tab();
    expect(document.activeElement).toBe(view.captionTarget);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(view.captionTarget);
    expect(view.captionTarget).toBeVisible();
    expect(view.captionTarget).toHaveAttribute("aria-valuenow", "51");
    expect(view.captionTarget).toHaveAttribute("aria-valuetext", "Detached at 51%");
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.51);
    expect(useRepurposeStore.getState().past).toHaveLength(1);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(view.captionTarget);
    expect(view.captionTarget).toBeVisible();
    expect(view.captionTarget).toHaveAttribute("aria-valuenow", "52");
    expect(view.captionTarget).toHaveAttribute("aria-valuetext", "Detached at 52%");
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.52);
    expect(useRepurposeStore.getState().past).toHaveLength(2);
  });

  test("keeps held Shift semantics and discrete Undo across repeated arrows", async () => {
    const user = userEvent.setup();
    const view = renderCaptionCanvas();
    await user.tab();
    await user.keyboard("{Shift>}");

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(view.captionTarget);
    expect(view.captionTarget).toHaveAttribute("aria-valuenow", "40");
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.4);
    expect(useRepurposeStore.getState().past).toHaveLength(1);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(view.captionTarget);
    expect(view.captionTarget).toHaveAttribute("aria-valuenow", "30");
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBeCloseTo(0.3, 10);
    expect(useRepurposeStore.getState().past).toHaveLength(2);
    await user.keyboard("{/Shift}");
  });

  test.each(["{Enter}", "[Space]"])(
    "%s reattaches without removing focus or its optimistic frame",
    async (key) => {
      const user = userEvent.setup();
      const view = renderCaptionCanvas();
      await user.tab();
      await user.keyboard("{ArrowDown}");

      await user.keyboard(key);

      expect(document.activeElement).toBe(view.captionTarget);
      expect(view.captionTarget).toBeVisible();
      expect(view.captionTarget).toHaveAttribute("aria-valuenow", "50");
      expect(view.captionTarget).toHaveAttribute(
        "aria-valuetext",
        "Attached to split at 50%"
      );
      expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
        pinToSplit: true,
      });
      expect(useRepurposeStore.getState().past).toHaveLength(2);

      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(view.captionTarget);
      expect(
        useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
      ).toBe(0.51);
      expect(useRepurposeStore.getState().past).toHaveLength(3);
    }
  );

  test.each([
    [
      "document",
      () =>
        useRepurposeStore.setState((state) => ({
          captionBlocks: state.captionBlocks.map((block) => ({ ...block })),
        })),
    ],
    [
      "style",
      () =>
        useRepurposeStore.setState((state) => ({
          captionStyle: { ...state.captionStyle, fill: "#aabbcc" },
        })),
    ],
    ["playhead", () => useRepurposeStore.getState().setPlayhead(0.6)],
  ] as const)(
    "rejects an unrelated external %s mutation after an optimistic key edit",
    async (_label, mutate) => {
      const user = userEvent.setup();
      const view = renderCaptionCanvas();
      await user.tab();
      await user.keyboard("{ArrowDown}");
      const afterAcceptedKey = useRepurposeStore.getState().captionBlocks;
      expect(document.activeElement).toBe(view.captionTarget);

      act(() => mutate());
      const afterExternalMutation = useRepurposeStore.getState().captionBlocks;
      await user.keyboard("{ArrowDown}");

      expect(useRepurposeStore.getState().captionBlocks).toBe(
        afterExternalMutation
      );
      expect(
        useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
      ).toBe(0.51);
      expect(useRepurposeStore.getState().past).toHaveLength(1);
      expect(view.captionTarget).not.toBeVisible();
      if (_label !== "document") {
        expect(afterExternalMutation).toBe(afterAcceptedKey);
      }
    }
  );

  test("uses the effective block offset against the settled split during a transient divider drag", () => {
    const block = activeCaption();
    block.words = [{ text: "DRAG", start: 10, end: 11 }];
    block.start = 10;
    block.end = 11;
    block.overrideStyle = { pinToSplit: true, splitOffsetPct: 0.1 };
    const style = resolveBlockStyle(DEFAULT_CAPTION_STYLE, block);
    const layout = captionLayout(block, {
      style,
      requestedAnchorY: 0.6 * 1_920,
      anchorY: 0.6 * 1_920,
      attachedTargetAnchorY: 0.6 * 1_920,
    });
    const view = renderCaptionCanvas({ block, layout });
    setTransitionSplitAtCut();
    runFrame(1_008);
    captionCapture(view.separator);
    fireEvent.pointerDown(view.separator, { pointerId: 330, clientY: 500 });
    pointerMove(330, 800);
    runFrame(1_016);
    const settledSplit = ratioReaders.toolbarSettled?.();
    expect(settledSplit).toBeDefined();

    fireEvent.keyDown(view.captionTarget, { key: "ArrowDown" });

    const override = useRepurposeStore.getState().captionBlocks[0].overrideStyle;
    expect(override).toMatchObject({
      pinToSplit: false,
    });
    expect(override?.positionYPct).toBeCloseTo(settledSplit! + 0.11, 10);
  });

  test.each([
    ["ArrowUp", false, 0.49],
    ["ArrowDown", false, 0.51],
    ["ArrowUp", true, 0.4],
    ["ArrowDown", true, 0.6],
    ["Home", false, 0],
    ["End", false, 1],
  ] as const)(
    "%s with shift=%s detaches to %s with one Undo step",
    (key, shiftKey, expected) => {
      const view = renderCaptionCanvas();

      fireEvent.keyDown(view.captionTarget, { key, shiftKey });

      expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
        pinToSplit: false,
        positionYPct: expected,
      });
      expect(useRepurposeStore.getState().past).toHaveLength(1);
      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().captionBlocks[0]).toEqual(view.block);
    }
  );

  test("keeps rapid keyboard nudges as separate Undo steps and updates its value", () => {
    const view = renderCaptionCanvas();
    followCurrentCaptionDocument(view.layout);
    const bubbled = vi.fn();
    window.addEventListener("keydown", bubbled);

    fireEvent.keyDown(view.captionTarget, { key: "ArrowDown" });
    runFrame(1_016);
    expect(view.captionTarget).toHaveAttribute("aria-valuenow", "51");
    expect(view.captionTarget).toHaveAttribute("aria-valuetext", "Detached at 51%");
    fireEvent.keyDown(view.captionTarget, { key: "ArrowDown" });

    expect(bubbled).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: false,
      positionYPct: 0.52,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(2);
    useRepurposeStore.getState().undo();
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle?.positionYPct
    ).toBe(0.51);
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().captionBlocks[0]).toEqual(view.block);
    window.removeEventListener("keydown", bubbled);
  });

  test.each(["Enter", " "])(
    "%s reattaches a keyboard-detached caption with one Undo step",
    (key) => {
      const view = renderCaptionCanvas();
      followCurrentCaptionDocument(view.layout);
      fireEvent.keyDown(view.captionTarget, { key: "ArrowDown" });
      runFrame(1_016);

      fireEvent.keyDown(view.captionTarget, { key });

      expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
        pinToSplit: true,
      });
      expect(
        useRepurposeStore.getState().captionBlocks[0].overrideStyle
      ).not.toHaveProperty("positionYPct");
      expect(useRepurposeStore.getState().past).toHaveLength(2);
      useRepurposeStore.getState().undo();
      expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
        pinToSplit: false,
        positionYPct: 0.51,
      });
    }
  );
});

describe("PreviewCanvas caption drag", () => {
  test.each(CAPTION_TEMPLATE_ORDER)(
    "uses the shared %s layout bounds without template-specific hit geometry",
    (template) => {
      const block = activeCaption(`caption-${template}`);
      const layout = captionLayout(block, {
        style: CAPTION_TEMPLATES[template],
        visualBounds: { left: 216, top: 768, right: 864, bottom: 1_152 },
      });
      const { captionTarget } = renderCaptionCanvas({ block, layout });

      expect(captionTarget).toBeVisible();
      expect(captionTarget.style.left).toBe("112.5px");
      expect(captionTarget.style.top).toBe("400px");
      expect(captionTarget.style.width).toBe("337.5px");
      expect(captionTarget.style.height).toBe("200px");
    }
  );

  test("ignores horizontal movement and activates at exactly three vertical CSS pixels", () => {
    const block = activeCaption();
    const layout = captionLayout(block, { attachedTargetAnchorY: 300 });
    const view = renderCaptionCanvas({ block, layout });
    followCaptionTransient(block, layout);
    captionCapture(view.captionTarget);
    beginCaptionDrag(view.captionTarget, 410);
    const stateAfterDown = useRepurposeStore.getState();
    const stateListener = vi.fn();
    const unsubscribe = useRepurposeStore.subscribe(stateListener);

    moveCaption(410, 502.999, 500);
    runFrame(1_016);
    expect(drawCaptionsMock.mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "transientPosition"
    );
    expect(useRepurposeStore.getState().captionBlocks).toBe(
      stateAfterDown.captionBlocks
    );
    expect(useRepurposeStore.getState().past).toEqual([]);

    moveCaption(410, 503, 10);
    runFrame(1_032);
    expect(
      drawCaptionsMock.mock.calls.at(-1)?.[1].transientPosition
    ).toEqual({ blockId: block.id, positionYPct: 965.76 / 1_920 });
    expect(useRepurposeStore.getState().captionBlocks).toBe(
      stateAfterDown.captionBlocks
    );
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(stateListener).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { pointerId: 410, clientY: 503 });
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: false,
      positionYPct: 965.76 / 1_920,
    });
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(stateListener).toHaveBeenCalledTimes(1);
    unsubscribe();
    act(() => useRepurposeStore.getState().undo());
    expect(useRepurposeStore.getState().captionBlocks[0]).toEqual(block);
  });

  test("converts CSS delta to logical output Y once and clamps the complete visual bounds", () => {
    const block = activeCaption();
    const layout = captionLayout(block, {
      requestedAnchorY: 1_920,
      anchorY: 1_920,
      anchorRange: { min: 240, max: 3_200 },
      attachedTargetAnchorY: 240,
      rawVisualBounds: { left: 540, top: 1_800, right: 1_620, bottom: 2_040 },
      visualBounds: { left: 540, top: 1_800, right: 1_620, bottom: 2_040 },
    });
    const view = renderCaptionCanvas({
      block,
      layout,
      width: 2_160,
      height: 3_840,
      bounds: previewBounds(960, 540),
    });
    followCaptionTransient(block, layout, 3_840);
    captionCapture(view.captionTarget);
    fireEvent.pointerDown(view.captionTarget, {
      pointerId: 411,
      clientX: 270,
      clientY: 480,
    });

    moveCaption(411, 576, 270);
    runFrame(1_016);
    expect(
      drawCaptionsMock.mock.calls.at(-1)?.[1].transientPosition.positionYPct
    ).toBeCloseTo(2_304 / 3_840, 10);

    moveCaption(411, 2_000, 270);
    runFrame(1_032);
    expect(
      drawCaptionsMock.mock.calls.at(-1)?.[1].transientPosition.positionYPct
    ).toBeCloseTo(3_200 / 3_840, 10);
    fireEvent.pointerCancel(window, { pointerId: 411 });
  });

  test.each([
    { label: "inside", cssDistance: 12, snaps: true },
    { label: "outside", cssDistance: 12.001, snaps: false },
  ])(
    "$label the inclusive 12 CSS px attachment zone",
    ({ cssDistance, snaps }) => {
      const block = activeCaption();
      block.overrideStyle = { pinToSplit: false, positionYPct: 0.5 };
      const layout = captionLayout(block, { attachedTargetAnchorY: 1_200 });
      const view = renderCaptionCanvas({ block, layout });
      followCaptionTransient(block, layout);
      captionCapture(view.captionTarget);
      beginCaptionDrag(view.captionTarget, snaps ? 412 : 413);
      const targetDeltaCss = ((1_200 - 960) / 1_920) * 1_000;

      moveCaption(snaps ? 412 : 413, 500 + targetDeltaCss + cssDistance);
      runFrame(1_016);

      const transient = drawCaptionsMock.mock.calls.at(-1)?.[1]
        .transientPosition.positionYPct;
      const guide = view.container.querySelector<HTMLDivElement>(
        "[data-caption-snap-guide]"
      );
      expect(transient).toBeCloseTo(
        snaps
          ? 1_200 / 1_920
          : (1_200 + (cssDistance * 1_920) / 1_000) / 1_920,
        10
      );
      expect(guide?.hidden).toBe(!snaps);
      if (snaps) {
        expect(guide).toHaveClass("pointer-events-none");
        expect(guide?.style.backgroundColor).toBe("rgb(255, 107, 53)");
        expect(guide?.style.top).toBe("625px");
      }

      fireEvent.pointerUp(window, {
        pointerId: snaps ? 412 : 413,
        clientY: 500 + targetDeltaCss + cssDistance,
      });
      const override = useRepurposeStore.getState().captionBlocks[0].overrideStyle;
      if (snaps) {
        expect(override).toMatchObject({ pinToSplit: true });
        expect(override).not.toHaveProperty("positionYPct");
      } else {
        expect(override).toMatchObject({
          pinToSplit: false,
          positionYPct: (1_200 + (cssDistance * 1_920) / 1_000) / 1_920,
        });
      }
      expect(useRepurposeStore.getState().past).toHaveLength(1);
    }
  );

  test.each([
    { split: 0, target: 60 },
    { split: 1, target: 1_860 },
  ])("snaps to the clamped attached target at split $split", ({ split, target }) => {
    const block = activeCaption();
    const layout = captionLayout(block, {
      requestedAnchorY: target,
      anchorY: target,
      attachedTargetAnchorY: target,
      visualBounds: {
        left: 270,
        top: target - 60,
        right: 810,
        bottom: target + 60,
      },
    });
    useRepurposeStore.setState({ splitRatio: split });
    const view = renderCaptionCanvas({ block, layout });
    captionCapture(view.captionTarget);
    fireEvent.pointerDown(view.captionTarget, {
      pointerId: 420 + split,
      clientX: 281.25,
      clientY: (target / 1_920) * 1_000,
    });
    moveCaption(420 + split, (target / 1_920) * 1_000 + 3);
    fireEvent.pointerUp(window, { pointerId: 420 + split });

    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: true,
    });
  });

  test("pointercancel restores persisted placement and clears transient drawing, guide, and stale events", () => {
    const block = activeCaption();
    block.overrideStyle = { pinToSplit: false, positionYPct: 0.5 };
    const layout = captionLayout(block, { attachedTargetAnchorY: 1_200 });
    const view = renderCaptionCanvas({ block, layout });
    followCaptionTransient(block, layout);
    const capture = captionCapture(view.captionTarget);
    beginCaptionDrag(view.captionTarget, 414);
    moveCaption(414, 700);
    runFrame(1_016);
    expect(
      drawCaptionsMock.mock.calls.at(-1)?.[1].transientPosition
    ).toBeDefined();

    fireEvent.pointerCancel(window, { pointerId: 414 });
    moveCaption(414, 800);
    runFrame(1_032);

    expect(capture.releasePointerCapture).toHaveBeenCalledWith(414);
    expect(drawCaptionsMock.mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "transientPosition"
    );
    expect(
      view.container.querySelector<HTMLDivElement>("[data-caption-snap-guide]")
        ?.hidden
    ).toBe(true);
    expect(useRepurposeStore.getState().captionBlocks[0]).toEqual(block);
    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  test.each(["undo", "redo", "rebuild", "project replacement"] as const)(
    "store cancellation from %s clears local ownership before stale pointer events",
    (operation) => {
      const block = activeCaption();
      const layout = captionLayout(block, { attachedTargetAnchorY: 300 });
      const view = renderCaptionCanvas({ block, layout });
      followCaptionTransient(block, layout);
      captionCapture(view.captionTarget);
      beginCaptionDrag(view.captionTarget, 430);
      moveCaption(430, 650);
      runFrame(1_016);

      act(() => {
        if (operation === "undo") useRepurposeStore.getState().undo();
        else if (operation === "redo") useRepurposeStore.getState().redo();
        else if (operation === "rebuild") {
          useRepurposeStore.getState().rebuildCaptionBlocks();
        } else {
          useRepurposeStore.getState().setClips([{ ...clips[0], id: "replacement" }]);
        }
      });
      moveCaption(430, 800);
      fireEvent.pointerUp(window, { pointerId: 430 });
      runFrame(1_032);

      expect(drawCaptionsMock.mock.calls.at(-1)?.[1]).not.toHaveProperty(
        "transientPosition"
      );
      expect(useRepurposeStore.getState().past).toEqual([]);
    }
  );

  test("block disappearance and unmount cancel ownership and make old pointer events inert", () => {
    const block = activeCaption();
    const layout = captionLayout(block, { attachedTargetAnchorY: 300 });
    const first = renderCaptionCanvas({ block, layout });
    drawCaptionsMock.mockImplementation(
      (_context: unknown, options: DrawCaptionsOptions) =>
        options.blocks.length > 0 ? layout : null
    );
    captionCapture(first.captionTarget);
    beginCaptionDrag(first.captionTarget, 431);
    moveCaption(431, 650);
    act(() => useRepurposeStore.setState({ captionBlocks: [] }));
    runFrame(1_016);
    moveCaption(431, 800);
    fireEvent.pointerUp(window, { pointerId: 431 });
    expect(first.captionTarget.hidden).toBe(true);
    expect(useRepurposeStore.getState().past).toEqual([]);
    first.unmount();

    const secondBlock = activeCaption("unmount-caption");
    const secondLayout = captionLayout(secondBlock, { attachedTargetAnchorY: 300 });
    const second = renderCaptionCanvas({ block: secondBlock, layout: secondLayout });
    captionCapture(second.captionTarget);
    beginCaptionDrag(second.captionTarget, 432);
    moveCaption(432, 650);
    second.unmount();
    moveCaption(432, 800);
    fireEvent.pointerUp(window, { pointerId: 432 });
    expect(useRepurposeStore.getState().captionBlocks[0]).toEqual(secondBlock);
    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  test("split and caption gestures cancel each other without leaving local transients", () => {
    const block = activeCaption();
    const layout = captionLayout(block, { attachedTargetAnchorY: 300 });
    const view = renderCaptionCanvas({ block, layout });
    followCaptionTransient(block, layout);
    captionCapture(view.captionTarget);
    captionCapture(view.separator);
    beginCaptionDrag(view.captionTarget, 433);
    moveCaption(433, 650);

    fireEvent.pointerDown(view.separator, {
      pointerId: 434,
      clientX: 100,
      clientY: 500,
    });
    moveCaption(433, 800);
    runFrame(1_016);
    expect(drawCaptionsMock.mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "transientPosition"
    );

    fireEvent.pointerDown(view.captionTarget, {
      pointerId: 435,
      clientX: 281.25,
      clientY: 500,
    });
    pointerMove(434, 900);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
    fireEvent.pointerCancel(window, { pointerId: 435 });
  });

  test("freezes playback and shuttle actions until caption ownership ends without auto-resume", () => {
    const view = renderCaptionCanvas();
    captionCapture(view.captionTarget);
    useRepurposeStore.setState({ mediaReadiness: "ready", isPlaying: true });
    const frozen = useRepurposeStore.getState().playhead;
    beginCaptionDrag(view.captionTarget, 436);

    act(() => {
      const store = useRepurposeStore.getState();
      store.play();
      store.shuttle(1);
      store.stepFrame(1);
      store.setPlayhead(frozen + 0.5);
    });
    runFrame(2_000);

    expect(useRepurposeStore.getState().isPlaying).toBe(false);
    expect(useRepurposeStore.getState().playhead).toBe(frozen);
    fireEvent.pointerUp(window, { pointerId: 436 });
    expect(useRepurposeStore.getState().isPlaying).toBe(false);
  });

  test("freezes direct seeks and marker jumps until caption ownership is cancelled", () => {
    const view = renderCaptionCanvas();
    render(<TransportBar />);
    useRepurposeStore.setState({
      markers: [
        { id: "before", t: 0.25, label: "Before" },
        { id: "after", t: 0.75, label: "After" },
      ],
    });
    captionCapture(view.captionTarget);
    const frozenBlock = useRepurposeStore.getState().captionBlocks[0];
    const frozenOptions = drawCaptionsMock.mock.calls.at(-1)?.[1];
    beginCaptionDrag(view.captionTarget, 438);
    const frozenTargetStyle = view.captionTarget.getAttribute("style");

    for (const code of ["Home", "End", "BracketRight", "BracketLeft"]) {
      fireEvent.keyDown(view.separator, { code });
      runFrame(2_000);
      const options = drawCaptionsMock.mock.calls.at(-1)?.[1];
      expect(useRepurposeStore.getState().playhead).toBe(0.5);
      expect(useRepurposeStore.getState().captionBlocks[0]).toBe(frozenBlock);
      expect(options.srcT).toBe(frozenOptions.srcT);
      expect(options.blocks[0]).toBe(frozenBlock);
      expect(view.captionTarget.getAttribute("style")).toBe(frozenTargetStyle);
    }

    fireEvent.pointerCancel(window, { pointerId: 438 });
    fireEvent.pointerUp(window, { pointerId: 438 });
    expect(useRepurposeStore.getState().captionBlocks[0]).toBe(frozenBlock);
    expect(useRepurposeStore.getState().past).toEqual([]);

    fireEvent.keyDown(view.separator, { code: "Home" });
    expect(useRepurposeStore.getState().playhead).toBe(0);
    fireEvent.keyDown(view.separator, { code: "End" });
    expect(useRepurposeStore.getState().playhead).toBe(3);
    useRepurposeStore.getState().setPlayhead(0.5);
    fireEvent.keyDown(view.separator, { code: "BracketRight" });
    expect(useRepurposeStore.getState().playhead).toBe(0.75);
    useRepurposeStore.getState().setPlayhead(0.5);
    fireEvent.keyDown(view.separator, { code: "BracketLeft" });
    expect(useRepurposeStore.getState().playhead).toBe(0.25);
  });

  test("keeps transient placement out of store snapshots and persistence-shaped data", () => {
    const block = activeCaption();
    const layout = captionLayout(block, { attachedTargetAnchorY: 300 });
    const view = renderCaptionCanvas({ block, layout });
    followCaptionTransient(block, layout);
    captionCapture(view.captionTarget);
    beginCaptionDrag(view.captionTarget, 437);
    const beforeBlocks = useRepurposeStore.getState().captionBlocks;

    moveCaption(437, 650);
    runFrame(1_016);

    const state = useRepurposeStore.getState();
    expect(state.captionBlocks).toBe(beforeBlocks);
    expect(state.past).toEqual([]);
    expect(JSON.stringify(state.captionBlocks)).not.toContain("transient");
    expect(drawCaptionsMock.mock.calls.at(-1)?.[1].transientPosition).toEqual({
      blockId: block.id,
      positionYPct: 1_248 / 1_920,
    });
    fireEvent.pointerCancel(window, { pointerId: 437 });
  });
});

describe("PreviewCanvas split divider", () => {
  test("keeps caption controls and edits on the settled frame while canvas captions follow a direct transition drag", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const transitionClips: Clip[] = [
      { ...clips[0], splitRatio: 0.34 },
      {
        ...clips[1],
        splitRatio: 0.9,
        transitionIn: {
          type: "zoom-settle",
          durationSec: 0.4,
          amount: 0.025,
          easing: "natural",
        },
      },
    ];
    const block: CaptionBlock = {
      id: "transition-caption",
      words: [{ text: "DIRECT", start: 10, end: 10.8 }],
      start: 10,
      end: 10.8,
      keywordIndex: 0,
      overrideStyle: { splitOffsetPct: 0.1 },
    };
    useRepurposeStore.setState({
      clips: transitionClips,
      duration: 3,
      playhead: 1.2,
      words: block.words,
      captionBlocks: [block],
      selectedCaptionBlockId: block.id,
      captionsEnabled: true,
      captionStyle: { ...DEFAULT_CAPTION_STYLE, pinToSplit: true },
    });
    const { separator } = renderDivider();
    runFrame(1_000);
    const caption = render(<CaptionPanel />);
    expect(
      caption.getByRole("button", { name: "Soltar legenda" })
    ).toBeVisible();
    expect(
      caption.queryByRole("slider", { name: "Posicao absoluta da legenda" })
    ).toBeNull();

    pointerDown(separator, 140);
    const storeSubscriber = vi.fn();
    const unsubscribe = useRepurposeStore.subscribe(storeSubscriber);
    pointerMove(140, 800);
    runFrame(1_016);
    const settledDuringDrag = effectiveSplitRatio(
      splitRatioAt(
        useRepurposeStore.getState().clips,
        useRepurposeStore.getState().playhead,
        useRepurposeStore.getState().splitRatio
      ),
      1920
    );
    const rawSettledDuringDrag = splitRatioAt(
      useRepurposeStore.getState().clips,
      useRepurposeStore.getState().playhead,
      useRepurposeStore.getState().splitRatio
    );

    expect(separator).toHaveAttribute("aria-valuenow", "80");
    expect(drawCaptionsMock.mock.calls.at(-1)?.[1].splitRatio).toBeCloseTo(0.8, 10);
    fireEvent.click(caption.getByRole("button", { name: "Soltar legenda" }));
    expect(useRepurposeStore.getState().captionBlocks[0].overrideStyle).toMatchObject({
      pinToSplit: false,
      positionYPct: rawSettledDuringDrag + 0.1,
    });
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle
    ).not.toHaveProperty("splitOffsetPct");
    const slider = caption.getByRole("slider", {
      name: "Posicao absoluta da legenda",
    }) as HTMLInputElement;
    expect(slider.valueAsNumber).toBeCloseTo(rawSettledDuringDrag + 0.1, 10);
    fireEvent.pointerDown(slider, { pointerId: 141 });
    fireEvent.change(slider, { target: { value: "0.75" } });
    fireEvent.pointerUp(slider, { pointerId: 141 });
    expect(
      useRepurposeStore.getState().captionBlocks[0].overrideStyle!.positionYPct
    ).toBeCloseTo(0.75, 10);
    expect(slider.valueAsNumber).toBeCloseTo(0.75, 10);
    const notificationsBeforeClear = storeSubscriber.mock.calls.length;

    fireEvent.pointerUp(window, { pointerId: 140 });

    expect(Number(separator.getAttribute("aria-valuenow"))).toBeCloseTo(
      settledDuringDrag * 100
    );
    expect(slider.valueAsNumber).toBeCloseTo(0.75, 10);
    expect(storeSubscriber).toHaveBeenCalledTimes(notificationsBeforeClear);
    unsubscribe();
  });

  test.each([
    [-0.2, 0],
    [0.0199, 0],
    [0.02, 0],
    [0.0201, 0.0201],
    [0.9799, 0.9799],
    [0.98, 1],
    [0.9801, 1],
    [1.2, 1],
  ])("clamps and snaps pointer ratio %s to %s", (input, expected) => {
    const { separator } = renderDivider();
    runFrame(1_000);
    const pointerId = Math.round((input + 2) * 10_000);

    pointerDown(separator, pointerId);
    pointerMove(pointerId, input * 1_000);

    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(expected);
    fireEvent.pointerUp(window, { pointerId });
  });

  test("recovers from a snapped endpoint to the middle in the same drag", () => {
    const { separator } = renderDivider();
    runFrame(1_000);
    pointerDown(separator, 11);

    pointerMove(11, 0);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0);
    pointerMove(11, 500);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.5);

    fireEvent.pointerUp(window, { pointerId: 11 });
  });

  test("pauses, freezes the scene target, and records one Undo for a slow drag across a cut", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    useRepurposeStore.setState({ playhead: 0.5, isPlaying: true });
    const { separator, setPointerCapture, releasePointerCapture } = renderDivider();
    runFrame(1_000);

    pointerDown(separator, 12);
    expect(useRepurposeStore.getState().isPlaying).toBe(false);
    expect(setPointerCapture).toHaveBeenCalledWith(12);

    act(() => useRepurposeStore.getState().setPlayhead(1.5));
    now.mockReturnValue(1_000);
    pointerMove(12, 750);
    expect(useRepurposeStore.getState().clips[0]).toMatchObject({
      id: "clip-a",
      splitRatio: 0.75,
    });
    expect(useRepurposeStore.getState().clips[1].splitRatio).toBeUndefined();
    expect(useRepurposeStore.getState().past).toHaveLength(1);

    fireEvent.pointerUp(window, { pointerId: 12 });
    expect(releasePointerCapture).toHaveBeenCalledWith(12);
    act(() => useRepurposeStore.getState().undo());
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
    now.mockRestore();
  });

  test("creates no history for a no-op drag", () => {
    const { separator } = renderDivider();
    runFrame(1_000);

    pointerDown(separator, 13);
    pointerMove(13, 500);
    fireEvent.pointerUp(window, { pointerId: 13 });

    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
    expect(useRepurposeStore.getState().past).toEqual([]);
  });

  test("uses the frozen global target when no scene owns the pointer-down frame", () => {
    useRepurposeStore.setState({ clips: [], duration: 0, past: [] });
    const { separator } = renderDivider();
    runFrame(1_000);

    pointerDown(separator, 131);
    pointerMove(131, 750);
    fireEvent.pointerUp(window, { pointerId: 131 });

    expect(useRepurposeStore.getState().splitRatio).toBe(0.75);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  test("uses one height-effective direct ratio for the handle, compositor, captions, overlays, and hit tests", () => {
    const transitionClips: Clip[] = [
      { ...clips[0], splitRatio: 0.34 },
      {
        ...clips[1],
        splitRatio: 0.9,
        transitionIn: {
          type: "zoom-settle",
          durationSec: 0.4,
          amount: 0.025,
          easing: "natural",
        },
      },
    ];
    useRepurposeStore.setState({
      clips: transitionClips,
      playhead: 1,
      captionsEnabled: true,
    });
    const { separator } = renderDivider({ height: 3 });
    runFrame(1_000);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBeCloseTo(1 / 3);

    pointerDown(separator, 14);
    pointerMove(14, 600);
    runFrame(1_016);

    const expected = 2 / 3;
    expect(useRepurposeStore.getState().clips[1].splitRatio).toBe(0.6);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBeCloseTo(expected);
    expect(drawCaptionsMock.mock.calls.at(-1)?.[1].splitRatio).toBeCloseTo(expected);
    expect(parseFloat(separator.style.top)).toBeCloseTo(expected * 100);
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeCloseTo(
      expected * 100
    );
    const frameSnapshots = [
      ratioReaders.objectSelection,
      ratioReaders.ghost,
      ratioReaders.selection,
      ratioReaders.toolbar,
    ].map((readFrame) => readFrame?.());
    for (const frame of frameSnapshots) {
      expect(frame?.splitRatio).toBeCloseTo(expected);
    }
    expect(new Set(frameSnapshots).size).toBe(1);
    expect(ratioReaders.toolbarSettled?.()).toBeCloseTo(1 / 3);

    fireEvent.pointerUp(window, { pointerId: 14 });
    pointerMove(14, 900);
    runFrame(1_032);
    expect(useRepurposeStore.getState().clips[1].splitRatio).toBe(0.6);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBeCloseTo(1 / 3);
    expect(parseFloat(separator.style.top)).toBeCloseTo((1 / 3) * 100);
  });

  test("uses the settled frame ratio when pasting during a transient divider drag", () => {
    setTransitionSplitAtCut();
    const target: Overlay = {
      ...overlay,
      id: "transient-paste",
      kind: "image",
      src: "/transient-paste.png",
      naturalWidth: 400,
      naturalHeight: 300,
      transform: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
      band: "screen",
    };
    useRepurposeStore.setState({
      overlays: [target],
      selectedOverlayId: target.id,
      selectedOverlayIds: [target.id],
      attributeClipboard: {
        kind: "overlay",
        transform: { x: 0.8, y: 0.7, scale: 0.4, rotation: 0 },
        opacity: 0.4,
        entranceEffect: { type: "none", durationSec: 0.35 },
        exitEffect: { type: "none", durationSec: 0.35 },
        cornerRadius: 0,
      },
    });
    const { separator } = renderDivider();
    runFrame(1_000);
    pointerDown(separator, 141);
    pointerMove(141, 800);
    expect(separator).toHaveAttribute("aria-valuenow", "80");
    render(<TransportBar />);
    const settledSplit = effectiveSplitRatio(
      splitRatioAt(
        useRepurposeStore.getState().clips,
        useRepurposeStore.getState().playhead,
        useRepurposeStore.getState().splitRatio
      ),
      1920
    );
    const clipboard = useRepurposeStore.getState().attributeClipboard;
    if (clipboard?.kind !== "overlay") {
      throw new Error("Expected overlay attributes in clipboard");
    }
    const expectedTransform = clampOverlayToBand(
      target,
      clipboard.transform,
      { left: 0, top: 0, width: 1080, height: 1920 },
      settledSplit
    );

    const event = new KeyboardEvent("keydown", {
      code: "KeyV",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(separator, event);

    expect(event.defaultPrevented).toBe(true);
    expect(useRepurposeStore.getState().overlays[0]).toMatchObject({
      transform: expectedTransform,
      opacity: 0.4,
    });
    fireEvent.pointerUp(window, { pointerId: 141 });
  });

  test("pointercancel restores frame interpolation and ignores later moves", () => {
    setTransitionSplitAtCut();
    const { separator, releasePointerCapture } = renderDivider({ height: 100 });
    runFrame(1_000);
    pointerDown(separator, 15);
    pointerMove(15, 600);
    runFrame(1_016);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBe(0.6);
    expect(separator).toHaveAttribute("aria-valuenow", "60");

    fireEvent.pointerCancel(window, { pointerId: 15 });
    pointerMove(15, 900);
    runFrame(1_032);

    expect(releasePointerCapture).toHaveBeenCalledWith(15);
    expect(useRepurposeStore.getState().clips[1].splitRatio).toBe(0.6);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBe(0.34);
    expect(separator).toHaveAttribute("aria-valuenow", "34");
  });

  test("re-entry cancels the old pointer and token before starting a new gesture", () => {
    const { separator } = renderDivider();
    runFrame(1_000);
    pointerDown(separator, 16);
    pointerMove(16, 600);
    expect(separator).toHaveAttribute("aria-valuenow", "60");
    act(() => useRepurposeStore.getState().setPlayhead(1.5));
    pointerDown(separator, 17);
    expect(separator).toHaveAttribute("aria-valuenow", "50");

    pointerMove(16, 200);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.6);
    expect(useRepurposeStore.getState().clips[1].splitRatio).toBeUndefined();

    pointerMove(17, 800);
    expect(separator).toHaveAttribute("aria-valuenow", "80");
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.6);
    expect(useRepurposeStore.getState().clips[1]).toMatchObject({
      id: "clip-b",
      splitRatio: 0.8,
    });
    fireEvent.pointerUp(window, { pointerId: 17 });
    expect(separator).toHaveAttribute("aria-valuenow", "80");
  });

  test.each(["project epoch replacement", "setClips", "resetProject"] as const)(
    "clears transient state and listeners after %s",
    (operation) => {
      const { separator } = renderDivider();
      runFrame(1_000);
      pointerDown(separator, 18);
      pointerMove(18, 700);
      expect(separator).toHaveAttribute("aria-valuenow", "70");

      const replacement = { ...clips[0], id: "replacement", splitRatio: 0.2 };
      act(() => {
        if (operation === "project epoch replacement") {
          const state = useRepurposeStore.getState();
          useRepurposeStore.setState({
            projectEpoch: state.projectEpoch + 1,
            clips: [replacement],
            duration: 1,
          });
        } else if (operation === "setClips") {
          useRepurposeStore.getState().setClips([replacement]);
        } else {
          useRepurposeStore.getState().resetProject();
        }
      });

      pointerMove(18, 900);
      runFrame(1_016);
      const state = useRepurposeStore.getState();
      if (operation === "resetProject") {
        expect(state.clips).toEqual([]);
        expect(state.splitRatio).toBe(0.5);
        expect(Number(separator.getAttribute("aria-valuenow"))).toBeCloseTo(50);
      } else {
        expect(state.clips).toMatchObject([{ id: "replacement", splitRatio: 0.2 }]);
        expect(Number(separator.getAttribute("aria-valuenow"))).toBeCloseTo(20);
      }
    }
  );

  test("clears local gesture state when Undo or Redo closes the store transaction", () => {
    const { separator } = renderDivider();
    runFrame(1_000);
    pointerDown(separator, 19);
    pointerMove(19, 700);
    expect(separator).toHaveAttribute("aria-valuenow", "70");
    act(() => useRepurposeStore.getState().undo());
    pointerMove(19, 900);
    runFrame(1_016);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeCloseTo(50);

    pointerDown(separator, 20);
    act(() => useRepurposeStore.getState().redo());
    pointerMove(20, 200);
    runFrame(1_032);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.7);
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeCloseTo(70);
  });

  test.each(["undo", "redo"] as const)(
    "clears transient preview state when successful %s restores only unrelated history",
    (operation) => {
      setTransitionSplitAtCut();
      useRepurposeStore.getState().addMarker(0.25);
      if (operation === "redo") useRepurposeStore.getState().undo();
      const stableClips = useRepurposeStore.getState().clips;
      const cancellationListener = vi.fn();
      const unsubscribe = useRepurposeStore
        .getState()
        .subscribeSplitRatioGestureCancellation(cancellationListener);
      const { separator } = renderDivider({ height: 100 });
      runFrame(1_000);

      pointerDown(separator, operation === "undo" ? 193 : 194);
      pointerMove(operation === "undo" ? 193 : 194, 900);
      expect(separator).toHaveAttribute("aria-valuenow", "90");
      expect(useRepurposeStore.getState().clips).toBe(stableClips);

      act(() => useRepurposeStore.getState()[operation]());

      expect(cancellationListener).toHaveBeenCalledTimes(1);
      expect(useRepurposeStore.getState().clips).toBe(stableClips);
      expect(useRepurposeStore.getState().markers).toHaveLength(
        operation === "undo" ? 0 : 1
      );
      expect(separator).toHaveAttribute("aria-valuenow", "34");

      pointerMove(operation === "undo" ? 193 : 194, 700);
      runFrame(1_016);

      expect(cancellationListener).toHaveBeenCalledTimes(1);
      expect(useRepurposeStore.getState().clips[1].splitRatio).toBe(0.9);
      expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBe(0.34);
      expect(separator).toHaveAttribute("aria-valuenow", "34");
      unsubscribe();
    }
  );

  test("empty-history Undo cancels a no-op active drag and its stale pointer listener", () => {
    setTransitionSplitAtCut();
    const { separator } = renderDivider({ height: 100 });
    runFrame(1_000);
    pointerDown(separator, 191);
    pointerMove(191, 900);
    expect(separator).toHaveAttribute("aria-valuenow", "90");
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(separator).toHaveAttribute("aria-valuenow", "90");

    act(() => useRepurposeStore.getState().undo());
    expect(separator).toHaveAttribute("aria-valuenow", "34");
    pointerMove(191, 700);
    runFrame(1_016);

    expect(useRepurposeStore.getState().clips[1].splitRatio).toBe(0.9);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBe(0.34);
    expect(separator).toHaveAttribute("aria-valuenow", "34");
  });

  test("empty-future Redo cancels a no-op active drag and its stale pointer listener", () => {
    setTransitionSplitAtCut();
    const { separator } = renderDivider({ height: 100 });
    runFrame(1_000);
    pointerDown(separator, 192);
    pointerMove(192, 900);
    expect(separator).toHaveAttribute("aria-valuenow", "90");
    expect(useRepurposeStore.getState().future).toEqual([]);
    expect(separator).toHaveAttribute("aria-valuenow", "90");

    act(() => useRepurposeStore.getState().redo());
    expect(separator).toHaveAttribute("aria-valuenow", "34");
    pointerMove(192, 700);
    runFrame(1_016);

    expect(useRepurposeStore.getState().clips[1].splitRatio).toBe(0.9);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBe(0.34);
    expect(separator).toHaveAttribute("aria-valuenow", "34");
  });

  test("unmount removes gesture listeners and invalidates the token", () => {
    const { separator, unmount } = renderDivider();
    runFrame(1_000);
    pointerDown(separator, 21);
    pointerMove(21, 700);
    expect(separator).toHaveAttribute("aria-valuenow", "70");
    unmount();

    pointerMove(21, 900);
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(0.7);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
  });

  test("exposes horizontal separator semantics and applies every keyboard command discretely", () => {
    const { separator } = renderDivider();
    runFrame(1_000);

    expect(separator).toHaveAttribute("role", "separator");
    expect(separator).toHaveAttribute("tabindex", "0");
    expect(separator).toHaveClass("touch-none");
    expect(separator).toHaveAccessibleName(/split/i);
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    expect(separator).toHaveAttribute("aria-valuemin", "0");
    expect(separator).toHaveAttribute("aria-valuemax", "100");
    expect(separator).toHaveAttribute("aria-valuenow", "50");

    const commands: [string, number][] = [
      ["ArrowUp", 0.49],
      ["ArrowLeft", 0.48],
      ["ArrowDown", 0.49],
      ["ArrowRight", 0.5],
      ["Home", 0],
      ["End", 1],
    ];
    for (const [key, expected] of commands) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(separator, event);
      expect(event.defaultPrevented).toBe(true);
      expect(useRepurposeStore.getState().clips[0].splitRatio).toBe(expected);
    }
    expect(useRepurposeStore.getState().past).toHaveLength(commands.length);
  });

  test("keeps rapid Arrow presses as separate Undo steps without transient rendering", () => {
    const { separator } = renderDivider();
    runFrame(1_000);

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeCloseTo(0.53);
    expect(useRepurposeStore.getState().past).toHaveLength(3);

    act(() => useRepurposeStore.getState().undo());
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeCloseTo(0.52);
    act(() => useRepurposeStore.getState().undo());
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeCloseTo(0.51);
    act(() => useRepurposeStore.getState().undo());
    expect(useRepurposeStore.getState().clips[0].splitRatio).toBeUndefined();
  });

  test("keeps half of the 16px handle hit area inside the canvas at both endpoints", () => {
    useRepurposeStore.setState({
      clips: [{ ...clips[0], splitRatio: 0 }],
      duration: 1,
    });
    const { separator } = renderDivider();
    runFrame(1_000);
    expect(separator.style.top).toBe("0%");
    expect(separator.style.height).toBe("16px");
    expect(separator.style.marginTop).toBe("-8px");

    act(() => useRepurposeStore.getState().setClipSplitRatio("clip-a", 1));
    runFrame(1_016);
    expect(separator.style.top).toBe("100%");
    expect(separator.style.height).toBe("16px");
    expect(separator.style.marginTop).toBe("-8px");
  });
});

describe("PreviewCanvas transport", () => {
  describe.each([
    { width: 1080, height: 1920 },
    { width: 2160, height: 3840 },
  ])("overlay appearance descriptors at $width x $height", ({ width, height }) => {
    test("uses the shared image/video appearance through a short split transition without mutation", () => {
      class LoadedImage {
        naturalWidth = 640;
        naturalHeight = 360;
        decoding = "";
        onload: null | (() => void) = null;
        private value = "";

        get src() {
          return this.value;
        }

        set src(value: string) {
          this.value = value;
        }
      }
      vi.stubGlobal("Image", LoadedImage);
      const persisted = appearanceOverlays();
      const before = structuredClone(persisted);
      useRepurposeStore.setState({
        clips: appearanceClips(),
        duration: 0.5,
        playhead: 0,
        overlays: persisted,
      });
      const { container } = render(
        <PreviewCanvas
          width={width}
          height={height}
          frameScheduler={frameScheduler}
        />
      );
      const media = mediaFor(container);
      decode(media.screen[0]);
      decode(media.face[0]);
      decode(media.overlay);
      const samples = [
        { time: 0, active: true },
        { time: 0.1, active: true },
        { time: 0.2, active: true },
        { time: 0.3, active: true },
        { time: 0.4, active: false },
      ];
      const resolvedSplits: number[] = [];

      samples.forEach(({ time, active }, sampleIndex) => {
        act(() => useRepurposeStore.getState().setPlayhead(time));
        drawFrameMock.mockClear();
        vi.mocked(resolveOverlayAppearanceAt).mockClear();
        runFrame(1_000 + sampleIndex * 16);
        const draw = drawFrameMock.mock.calls.at(-1)?.[1];
        resolvedSplits.push(draw.splitRatio);

        expect(resolveOverlayAppearanceAt).toHaveBeenCalledTimes(2);
        expect(draw.overlays).toHaveLength(active ? 2 : 0);
        const snapshots = [
          ratioReaders.objectSelection?.(),
          ratioReaders.ghost?.(),
          ratioReaders.selection?.(),
          ratioReaders.toolbar?.(),
        ];
        expect(new Set(snapshots).size).toBe(1);
        const snapshot = snapshots[0];
        expect(snapshot).toMatchObject({ outputTime: time, splitRatio: draw.splitRatio });
        expect(snapshot?.appearances.size).toBe(2);
        if (!active) return;

        persisted.forEach((sourceOverlay, overlayIndex) => {
          const resolverCall = vi.mocked(resolveOverlayAppearanceAt).mock.calls[
            overlayIndex
          ];
          const appearance = vi.mocked(resolveOverlayAppearanceAt).mock.results[
            overlayIndex
          ].value;
          expect(resolverCall).toEqual([
            sourceOverlay,
            time,
            { left: 0, top: 0, width, height },
            draw.splitRatio,
          ]);
          expect(draw.overlays[overlayIndex]).toMatchObject({
            transform: {
              ...appearance.transform,
              opacity: sourceOverlay.opacity * appearance.opacityMultiplier,
            },
            cornerRadius: appearance.cornerRadius,
            band: sourceOverlay.band,
          });
          expect(snapshot?.appearances.get(sourceOverlay.id)).toBe(appearance);
        });

        if (time === 0) {
          expect(
            draw.overlays.map(
              (item: { transform: { opacity: number } }) => item.transform.opacity
            )
          ).toEqual([0, 0]);
          expect(draw.overlays[0].source.src).toBe("/media/appearance-image.png");
          expect(draw.overlays[1].source).toBe(media.overlay);
        }
        expect(media.overlay.currentTime).toBeCloseTo(7 + time, 12);
        expect(media.overlay.muted).toBe(true);
      });

      expect(resolvedSplits[0]).toBe(0);
      expect(resolvedSplits[2]).toBeGreaterThan(0);
      expect(resolvedSplits[2]).toBeLessThan(1);
      expect(resolvedSplits[3]).toBe(1);
      expect(resolvedSplits[4]).toBe(1);
      expect(useRepurposeStore.getState().overlays).toEqual(before);
    });
  });

  test("resolves a persisted Screen overlay against the current frame split", () => {
    const persisted: Overlay = {
      ...overlay,
      transform: { x: 0.5, y: 0.5, scale: 1.4, rotation: 37 },
    };
    const before = { ...persisted.transform };
    useRepurposeStore.setState({
      clips: [{ ...clips[0], splitRatio: 0.2 }],
      duration: 1,
      playhead: 0,
      overlays: [persisted],
    });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);

    runFrame(1_000);

    const draw = drawFrameMock.mock.calls.at(-1)?.[1];
    const resolved = draw.overlays[0].transform;
    const box = overlayAABBNorm(
      resolved,
      persisted.naturalWidth,
      persisted.naturalHeight,
      { left: 0, top: 0, width: 1080, height: 1920 }
    );
    expect(draw.splitRatio).toBe(0.2);
    expect(box.maxY).toBeCloseTo(0.2, 10);
    expect(resolved).toMatchObject({
      x: before.x,
      scale: before.scale,
      rotation: before.rotation,
      opacity: persisted.opacity,
    });
    expect(useRepurposeStore.getState().overlays[0].transform).toEqual(before);
  });

  test.each(
    (["natural", "bounce"] as const).flatMap((easing) =>
      (["screen", "face", "free"] as const).flatMap((band) =>
        [
          { geometry: "rotated", scale: 0.6, rotation: 37 },
          { geometry: "oversized", scale: 1.4, rotation: -29 },
        ].map((shape) => ({ easing, band, ...shape }))
      )
    )
  )(
    "keeps a $geometry $band overlay seam-safe and ephemeral in a $easing transition",
    ({ easing, band, scale, rotation }) => {
      const fromSplit = band === "face" ? 0.4 : 0.6;
      const toSplit = band === "face" ? 0.8 : 0.2;
      const transitionClips: Clip[] = [
        { ...clips[0], splitRatio: fromSplit },
        {
          ...clips[1],
          splitRatio: toSplit,
          transitionIn: {
            type: "zoom-settle",
            durationSec: 0.4,
            amount: 0.025,
            easing,
          },
        },
      ];
      const persisted: Overlay = {
        ...overlay,
        id: `${easing}-${band}-${scale}`,
        band,
        transform: { x: 0.5, y: 0.5, scale, rotation },
      };
      const before = { ...persisted.transform };
      useRepurposeStore.setState({
        clips: transitionClips,
        duration: 3,
        playhead: 1.1,
        overlays: [persisted],
      });
      const { container } = render(
        createElement(PreviewCanvas, { frameScheduler })
      );
      const media = mediaFor(container);
      decode(media.screen[0]);
      decode(media.face[0]);
      decode(media.overlay);

      runFrame(1_000);

      const draw = drawFrameMock.mock.calls.at(-1)?.[1];
      const transform = draw.overlays[0].transform;
      const box = overlayAABBNorm(
        transform,
        persisted.naturalWidth,
        persisted.naturalHeight,
        { left: 0, top: 0, width: 1080, height: 1920 }
      );
      if (band === "screen") {
        expect(box.maxY).toBeLessThanOrEqual(draw.splitRatio + 1e-10);
      } else if (band === "face") {
        expect(box.minY).toBeGreaterThanOrEqual(draw.splitRatio - 1e-10);
      } else {
        expect(transform).toMatchObject(before);
      }
      expect(useRepurposeStore.getState().overlays[0].transform).toEqual(before);
    }
  );

  test.each([
    { band: "screen" as const, split: 0.2 },
    { band: "face" as const, split: 0.8 },
  ])("keeps persisted y during an x-only $band keyboard nudge", ({ band, split }) => {
    const persisted: Overlay = {
      ...overlay,
      id: `nudge-${band}`,
      kind: "image",
      src: `/nudge-${band}.png`,
      naturalWidth: 400,
      naturalHeight: 300,
      band,
      transform: { x: 0.5, y: 0.5, scale: 0.4, rotation: 37 },
    };
    useRepurposeStore.setState({
      clips: [{ ...clips[0], splitRatio: split }],
      duration: 1,
      playhead: 0.5,
      overlays: [persisted],
      selectedOverlayId: persisted.id,
      selectedOverlayIds: [persisted.id],
    });
    const { container } = render(<PreviewCanvas frameScheduler={frameScheduler} />);
    const preview = container.firstElementChild as HTMLDivElement;
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(
      previewBounds(1600, 900)
    );
    runFrame(1_000);

    fireEvent.keyDown(preview, { key: "ArrowRight", code: "ArrowRight" });

    const result = useRepurposeStore.getState().overlays[0].transform;
    expect(result.x).toBeCloseTo(persisted.transform.x + 1 / 900, 10);
    expect(result.y).toBe(persisted.transform.y);
  });

  test.each([
    { label: "endpoint fallback", endpoint: true, expectedId: "visible-face" },
    { label: "transition stored primary", endpoint: false, expectedId: "stored-screen" },
  ] as const)(
    "uses the settled effective primary for duplicate, z-order, and nudge at a $label",
    ({ endpoint, expectedId }) => {
      if (endpoint) {
        useRepurposeStore.setState({
          clips: [{ ...clips[0], splitRatio: 0 }],
          duration: 1,
          playhead: 0.5,
        });
      } else {
        setTransitionSplitAtCut();
        useRepurposeStore.setState({ playhead: 1.1 });
      }
      const stored: Overlay = {
        ...overlay,
        id: "stored-screen",
        kind: "image",
        src: "/stored-screen.png",
        naturalWidth: 100,
        naturalHeight: 100,
        band: "screen",
        transform: { x: 0.8, y: 0.2, scale: 0.2, rotation: 0 },
      };
      const visible: Overlay = {
        ...stored,
        id: "visible-face",
        src: "/visible-face.png",
        band: "face",
        transform: { ...stored.transform, x: 0.2, y: 0.8 },
      };
      const selectedIds = [visible.id, stored.id];
      const setOverlayZ = vi.fn();
      useRepurposeStore.setState({
        overlays: [stored, visible],
        selectedOverlayId: stored.id,
        selectedOverlayIds: selectedIds,
        setOverlayZ,
      });
      const { preview } = renderDivider({ cssHeight: 1600 });
      runFrame(1_000);

      fireEvent.keyDown(preview, {
        key: "]",
        code: "BracketRight",
      });
      expect(setOverlayZ).toHaveBeenCalledWith(expectedId, "forward");

      const before = useRepurposeStore
        .getState()
        .overlays.find((item) => item.id === expectedId)!.transform.x;
      fireEvent.keyDown(preview, { key: "ArrowRight", code: "ArrowRight" });
      expect(
        useRepurposeStore
          .getState()
          .overlays.find((item) => item.id === expectedId)!.transform.x
      ).toBeCloseTo(before + 1 / previewBounds(1600).width, 10);
      expect(useRepurposeStore.getState().selectedOverlayId).toBe(stored.id);
      expect(useRepurposeStore.getState().selectedOverlayIds).toEqual(selectedIds);

      fireEvent.keyDown(preview, { code: "KeyD", ctrlKey: true });
      const copy = useRepurposeStore.getState().overlays.at(-1)!;
      expect(copy.src).toBe(`/${expectedId}.png`);
    }
  );

  test("overlay keyboard commands no-op when the settled selection has no visible primary", () => {
    const hidden: Overlay = {
      ...overlay,
      id: "keyboard-hidden-screen",
      kind: "image",
      src: "/keyboard-hidden-screen.png",
      naturalWidth: 100,
      naturalHeight: 100,
      band: "screen",
      transform: { x: 0.5, y: 0.2, scale: 0.2, rotation: 0 },
    };
    const setOverlayZ = vi.fn();
    useRepurposeStore.setState({
      clips: [{ ...clips[0], splitRatio: 0 }],
      duration: 1,
      playhead: 0.5,
      overlays: [hidden],
      selectedOverlayId: hidden.id,
      selectedOverlayIds: [hidden.id],
      setOverlayZ,
      past: [],
    });
    const { preview } = renderDivider({ cssHeight: 1600 });
    runFrame(1_000);

    fireEvent.keyDown(preview, { key: "]", code: "BracketRight" });
    fireEvent.keyDown(preview, { key: "ArrowRight", code: "ArrowRight" });
    fireEvent.keyDown(preview, { code: "KeyD", ctrlKey: true });

    expect(setOverlayZ).not.toHaveBeenCalled();
    expect(useRepurposeStore.getState().overlays).toEqual([hidden]);
    expect(useRepurposeStore.getState().past).toEqual([]);
    expect(useRepurposeStore.getState().selectedOverlayId).toBe(hidden.id);
  });

  test("keyboard duplicate and nudge no-op when only a transient split makes the selection visible", () => {
    setTransitionSplitAtCut();
    useRepurposeStore.setState({
      clips: [
        { ...useRepurposeStore.getState().clips[0], splitRatio: 0 },
        useRepurposeStore.getState().clips[1],
      ],
    });
    const source: Overlay = {
      ...overlay,
      id: "transient-keyboard-screen",
      kind: "image",
      src: "/transient-keyboard-screen.png",
      naturalWidth: 100,
      naturalHeight: 100,
      band: "screen",
      transform: { x: 0.5, y: 0.2, scale: 0.2, rotation: 0 },
    };
    useRepurposeStore.setState({
      overlays: [source],
      selectedOverlayId: source.id,
      selectedOverlayIds: [source.id],
    });
    const { preview, separator } = renderDivider({ cssHeight: 1600 });
    runFrame(1_000);
    pointerDown(separator, 142);
    pointerMove(142, 1280);
    runFrame(1_016);
    expect(drawFrameMock.mock.calls.at(-1)?.[1].splitRatio).toBeCloseTo(0.8, 10);

    fireEvent.keyDown(preview, { code: "KeyD", ctrlKey: true });

    let state = useRepurposeStore.getState();
    expect(state.overlays).toEqual([source]);
    const beforeNudge = useRepurposeStore.getState().overlays[0].transform;
    const historyBeforeNudge = useRepurposeStore.getState().past.length;
    fireEvent.keyDown(preview, { key: "ArrowRight", code: "ArrowRight" });

    state = useRepurposeStore.getState();
    expect(state.overlays[0].transform).toEqual(beforeNudge);
    expect(state.past).toHaveLength(historyBeforeNudge);
    fireEvent.pointerUp(window, { pointerId: 142 });
  });

  test.each([
    { clipSplit: 0 as const, globalSplit: 1 },
    { clipSplit: 1 as const, globalSplit: 0 },
  ])(
    "routes pointer and wheel to the visible region at a static clip split of $clipSplit against global $globalSplit",
    ({ clipSplit, globalSplit }) => {
      const scene = { ...clips[0], splitRatio: clipSplit };
      exerciseEndpointRouting({
        sceneClips: [scene],
        playhead: 0.5,
        globalSplit,
        resolvedSplit: clipSplit,
        activeClipId: scene.id,
      });
    }
  );

  test.each([
    {
      band: "screen" as const,
      clipSplit: 0 as const,
      globalSplit: 1,
      transform: { x: 0.5, y: -0.05625, scale: 0.2, rotation: 0 },
      duplicates: false,
    },
    {
      band: "face" as const,
      clipSplit: 1 as const,
      globalSplit: 0,
      transform: { x: 0.5, y: 1.05625, scale: 0.2, rotation: 0 },
      duplicates: false,
    },
    {
      band: "free" as const,
      clipSplit: 0 as const,
      globalSplit: 1,
      transform: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
      duplicates: true,
    },
  ])(
    "Cmd/Ctrl+D keeps a no-movement $band clone valid at the per-scene endpoint",
    ({ band, clipSplit, globalSplit, transform, duplicates }) => {
      const scene = { ...clips[0], splitRatio: clipSplit };
      const source: Overlay = {
        ...overlay,
        id: `keyboard-${band}`,
        naturalWidth: 100,
        naturalHeight: 100,
        band,
        transform,
      };
      useRepurposeStore.setState({
        clips: [scene],
        duration: scene.timelineEnd,
        playhead: 0.5,
        splitRatio: globalSplit,
        overlays: [source],
        selectedOverlayId: source.id,
        selectedOverlayIds: [source.id],
      });
      const { container } = render(<PreviewCanvas frameScheduler={frameScheduler} />);
      const preview = container.firstElementChild as HTMLDivElement;
      const bounds = {
        left: 0,
        top: 0,
        right: 900,
        bottom: 1600,
        width: 900,
        height: 1600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
      vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(bounds);
      runFrame(1_000);

      fireEvent.keyDown(preview, { code: "KeyD", ctrlKey: true });

      const state = useRepurposeStore.getState();
      if (!duplicates) {
        expect(state.overlays).toEqual([source]);
        return;
      }
      expect(state.overlays).toHaveLength(2);
      const copy = state.overlays[1];
      const box = overlayAABBNorm(
        copy.transform,
        copy.naturalWidth,
        copy.naturalHeight,
        bounds
      );
      if (band === "screen") expect(box.maxY).toBeCloseTo(clipSplit, 10);
      if (band === "face") expect(box.minY).toBeGreaterThanOrEqual(clipSplit);
      if (band === "free") {
        expect(copy.transform.x).toBeCloseTo(source.transform.x + 0.04, 10);
        expect(copy.transform.y).toBeCloseTo(source.transform.y + 0.04, 10);
      }
    }
  );

  test.each([
    {
      resolvedSplit: 0 as const,
      globalSplit: 1,
      hiddenBand: "screen" as const,
      visibleRegion: "face" as const,
      pointerY: 0,
    },
    {
      resolvedSplit: 1 as const,
      globalSplit: 0,
      hiddenBand: "face" as const,
      visibleRegion: "screen" as const,
      pointerY: 1600,
    },
  ])(
    "routes pointer and wheel to $visibleRegion at a transition-resolved split of $resolvedSplit",
    ({ resolvedSplit, globalSplit }) => {
      const transitionClips: Clip[] = [
        {
          ...clips[0],
          splitRatio: resolvedSplit,
        },
        {
          ...clips[1],
          splitRatio: resolvedSplit === 0 ? 1 : 0,
          transitionIn: {
            type: "zoom-settle",
            durationSec: 0.4,
            amount: 0.025,
            easing: "natural",
          },
        },
      ];
      exerciseEndpointRouting({
        sceneClips: transitionClips,
        playhead: 1,
        globalSplit,
        resolvedSplit,
        activeClipId: clips[1].id,
      });
    }
  );

  test("uses one video overlay previewPath for the main decoder and ghost while preserving its working src", () => {
    useRepurposeStore.setState({
      footageMeta,
      clips,
      duration: 3,
      overlays: [{
        ...overlay,
        transform: { ...overlay.transform, x: -0.1 },
        videoSource: overlayVideoSource,
      }],
      isPlaying: false,
    });

    const { container } = render(<PreviewCanvas frameScheduler={frameScheduler} />);
    vi.spyOn(
      container.firstElementChild as HTMLDivElement,
      "getBoundingClientRect"
    ).mockReturnValue(previewBounds(1_600, 900));
    runFrame(1_000);
    runChromeFrame();
    const decoder = container.querySelector<HTMLVideoElement>(
      '[data-overlay-id="overlay-video"]'
    );
    const proxyVideos = container.querySelectorAll<HTMLVideoElement>(
      `video[src="${overlayVideoSource.previewPath}"]`
    );

    expect(decoder?.getAttribute("src")).toBe(overlayVideoSource.previewPath);
    expect(decoder?.dataset.overlaySrc).toBe(overlayVideoSource.previewPath);
    expect(proxyVideos).toHaveLength(2);
    expect(
      container.querySelector('video[src="/media/overlay.mp4"]')
    ).not.toBeInTheDocument();
    expect(useRepurposeStore.getState().overlays[0].src).toBe(overlay.src);
  });

  test("disarms promoted standby seekers across a rapid double cut", async () => {
    useRepurposeStore.getState().setClips(rapidDoubleCutClips);
    useRepurposeStore.setState({ playhead: 0.8, overlays: [overlay] });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    media.screen.forEach((video) => decode(video));
    media.face.forEach((video) => decode(video));
    decode(media.overlay);
    fireEvent(media.screen[1], new Event("seeked"));
    fireEvent(media.face[1], new Event("seeked"));
    fireEvent(media.screen[2], new Event("seeked"));
    fireEvent(media.face[2], new Event("seeked"));
    useRepurposeStore.getState().setMediaReadiness("ready");

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    runFrame(1_000);
    runFrame(1_200);
    await act(async () => Promise.resolve());
    runFrame(2_200);

    const lastDraw = drawFrameMock.mock.calls.at(-1)?.[1];
    expect(lastDraw.screen.source).toBe(media.screen[2]);
    expect(lastDraw.face.source).toBe(media.face[2]);

    media.screen[2].currentTime = 21;
    media.face[2].currentTime = 21;
    fireEvent(media.screen[2], new Event("seeked"));
    fireEvent(media.face[2], new Event("seeked"));

    expect(media.screen[2].currentTime).toBe(21);
    expect(media.face[2].currentTime).toBe(21);
  });

  test("does not advance the transport while required base play promises are pending", () => {
    const screenPlay = deferred<void>();
    const facePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => screenPlay.promise)
      .mockImplementationOnce(() => facePlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    act(() => useRepurposeStore.getState().play());
    runFrame(1_000);
    runFrame(2_000);

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: true,
      playhead: 0,
    });
  });

  test("anchors transport when both delayed base plays confirm", async () => {
    const screenPlay = deferred<void>();
    const facePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => screenPlay.promise)
      .mockImplementationOnce(() => facePlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    act(() => useRepurposeStore.getState().play());
    runFrame(1_000);
    runFrame(2_000);
    expect(useRepurposeStore.getState().playhead).toBe(0);

    await act(async () => {
      screenPlay.resolve();
      facePlay.resolve();
      await Promise.resolve();
    });
    runFrame(2_000);
    expect(useRepurposeStore.getState().playhead).toBe(0);

    runFrame(2_200);
    expect(useRepurposeStore.getState().playhead).toBeCloseTo(0.2, 5);
  });

  test("ignores a late AbortError after Play then Pause", async () => {
    const screenPlay = deferred<void>();
    const facePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => screenPlay.promise)
      .mockImplementationOnce(() => facePlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    act(() => useRepurposeStore.getState().play());
    act(() => useRepurposeStore.getState().pause());

    await act(async () => {
      screenPlay.reject(new DOMException("stopped", "AbortError"));
      facePlay.reject(new DOMException("stopped", "AbortError"));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("ignores an obsolete rejection after a newer playback session starts", async () => {
    const oldScreenPlay = deferred<void>();
    const oldFacePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => oldScreenPlay.promise)
      .mockImplementationOnce(() => oldFacePlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    act(() => useRepurposeStore.getState().play());
    act(() => useRepurposeStore.getState().pause());
    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());

    await act(async () => {
      oldScreenPlay.reject(new Error("obsolete session"));
      oldFacePlay.reject(new Error("obsolete session"));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: true,
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("ignores obsolete play results after unmount and source replacement", async () => {
    const oldScreenPlay = deferred<void>();
    const oldFacePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => oldScreenPlay.promise)
      .mockImplementationOnce(() => oldFacePlay.promise);
    const { container, unmount } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    act(() => useRepurposeStore.getState().play());
    act(() =>
      useRepurposeStore.getState().setFootageMeta({
        ...footageMeta,
        screenPath: "/media/replacement-screen.mp4",
        faceCamPath: "/media/replacement-face.mp4",
      })
    );
    unmount();

    await act(async () => {
      oldScreenPlay.reject(new Error("obsolete source"));
      oldFacePlay.reject(new Error("obsolete source"));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "loading",
      playbackBlockedReason: "Media is still loading.",
    });
  });

  test("reports ready only after both active base videos have decoded dimensions", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);

    decode(media.screen[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    decode(media.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });

  test("requires future data and positive dimensions from both active slots", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);

    decode(media.screen[0], 2);
    decode(media.face[0], 2);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    decode(media.screen[0], HTMLMediaElement.HAVE_FUTURE_DATA);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
    decode(media.face[0], HTMLMediaElement.HAVE_FUTURE_DATA);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });

  test("keeps a healthy active pair ready when a standby emits an error", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    fireEvent.error(media.screen[1]);
    fireEvent.error(media.face[1]);

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("keeps an active-pair error sticky against late standby and active metadata", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    fireEvent.error(media.screen[0]);

    decode(media.screen[1]);
    decode(media.face[1]);
    decode(media.screen[0]);
    decode(media.face[0]);

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason:
        "Chrome could not load this video. Re-import it to create a compatible copy.",
    });
  });

  test("starts a fresh loading-to-ready cycle when required sources change", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const oldMedia = mediaFor(container);
    decode(oldMedia.screen[0]);
    decode(oldMedia.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");

    act(() =>
      useRepurposeStore.getState().setFootageMeta({
        ...footageMeta,
        screenPath: "/media/new-screen.mp4",
        faceCamPath: "/media/new-face.mp4",
      })
    );
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    fireEvent.loadedMetadata(oldMedia.screen[0]);
    fireEvent.canPlay(oldMedia.screen[0]);
    fireEvent.loadedMetadata(oldMedia.face[0]);
    fireEvent.canPlay(oldMedia.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    const newMedia = mediaFor(container);
    decode(newMedia.screen[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
    decode(newMedia.face[0]);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });

  test("records concurrent source canplay events and publishes ready when the final owner settles", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    const screenToken = useRepurposeStore.getState().beginSourceImport("screen");
    const faceToken = useRepurposeStore.getState().beginSourceImport("face");
    act(() => useRepurposeStore.getState().setMediaReadiness("loading"));

    decode(media.screen[0]);
    act(() =>
      useRepurposeStore.getState().endSourceImport("screen", screenToken)
    );
    decode(media.face[0]);

    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
    act(() => useRepurposeStore.getState().endSourceImport("face", faceToken));
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");
  });

  test("records a concurrent source error and publishes it when the final owner settles", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    const screenToken = useRepurposeStore.getState().beginSourceImport("screen");
    const faceToken = useRepurposeStore.getState().beginSourceImport("face");
    act(() => useRepurposeStore.getState().setMediaReadiness("loading"));

    decode(media.screen[0]);
    fireEvent.error(media.face[0]);
    act(() =>
      useRepurposeStore.getState().endSourceImport("screen", screenToken)
    );
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");

    act(() => useRepurposeStore.getState().endSourceImport("face", faceToken));
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason:
        "Chrome could not load this video. Re-import it to create a compatible copy.",
    });
  });

  test("keeps an active overlay failure over base source loading and ready events", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    fireEvent.error(media.overlay);

    act(() =>
      useRepurposeStore.getState().setFootageMeta({
        ...footageMeta,
        screenPath: "/media/overlay-priority-screen.mp4",
        faceCamPath: "/media/overlay-priority-face.mp4",
      })
    );
    const replacement = mediaFor(container);
    decode(replacement.screen[0]);
    decode(replacement.face[0]);

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason:
        "Overlay video overlay-video could not play. Re-import it to create a compatible copy.",
    });
  });

  test("keeps the base error reason when an active overlay fails, exits, changes, or is removed", () => {
    const baseError =
      "Chrome could not load this video. Re-import it to create a compatible copy.";
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    fireEvent.error(media.screen[0]);
    fireEvent.error(media.overlay);

    const expectBaseError = () =>
      expect(useRepurposeStore.getState()).toMatchObject({
        mediaReadiness: "error",
        playbackBlockedReason: baseError,
      });

    expectBaseError();
    act(() => useRepurposeStore.getState().setPlayhead(3));
    expectBaseError();

    act(() => useRepurposeStore.getState().setPlayhead(0));
    fireEvent.error(media.overlay);
    act(() =>
      useRepurposeStore.setState({
        overlays: [{ ...overlay, src: "/media/overlay-replacement.mp4" }],
      })
    );
    expectBaseError();

    act(() => useRepurposeStore.setState({ overlays: [] }));
    expectBaseError();
  });

  test("recovers readiness when the active overlay and failed base cycle are both replaced", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    fireEvent.error(media.overlay);
    fireEvent.error(media.screen[0]);

    act(() =>
      useRepurposeStore.getState().setFootageMeta({
        ...footageMeta,
        screenPath: "/media/recovered-screen.mp4",
        faceCamPath: "/media/recovered-face.mp4",
      })
    );
    const replacement = mediaFor(container);
    decode(replacement.screen[0]);
    decode(replacement.face[0]);

    expect(useRepurposeStore.getState().playbackBlockedReason).toBe(
      "Overlay video overlay-video could not play. Re-import it to create a compatible copy."
    );

    act(() =>
      useRepurposeStore.setState({
        overlays: [{ ...overlay, src: "/media/recovered-overlay.mp4" }],
      })
    );

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("keeps the screen standby warm across a paused face proxy swap", async () => {
    useRepurposeStore.setState({ playhead: 0.8 });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const beforeProxy = mediaFor(container);
    beforeProxy.screen.forEach((video) => decode(video));
    beforeProxy.face.forEach((video) => decode(video));
    decode(beforeProxy.overlay);
    fireEvent(beforeProxy.screen[1], new Event("seeked"));
    fireEvent(beforeProxy.face[1], new Event("seeked"));

    faceProxyMock.src = "/media/face-proxy.mp4";
    act(() => useRepurposeStore.setState({ showGrid: true }));
    const afterProxy = mediaFor(container);
    expect(afterProxy.screen[0]).toBe(beforeProxy.screen[0]);
    expect(afterProxy.screen[1]).toBe(beforeProxy.screen[1]);

    afterProxy.face.forEach((video) => decode(video));
    fireEvent(afterProxy.face[1], new Event("seeked"));
    useRepurposeStore.getState().setMediaReadiness("ready");

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    runFrame(1_000);
    runFrame(1_200);

    expect(playImpl.mock.contexts).toContain(afterProxy.screen[1]);
    expect(playImpl.mock.contexts).toContain(afterProxy.face[1]);
    await act(async () => Promise.resolve());
    runFrame(1_400);
    const lastDraw = drawFrameMock.mock.calls.at(-1)?.[1];
    expect(lastDraw.screen.source).toBe(afterProxy.screen[1]);
    expect(lastDraw.face.source).toBe(afterProxy.face[1]);
  });

  test("keeps the promoted face slot audible after a paused proxy swap", async () => {
    useRepurposeStore.setState({ playhead: 0.8 });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const beforeProxy = mediaFor(container);
    beforeProxy.screen.forEach((video) => decode(video));
    beforeProxy.face.forEach((video) => decode(video));
    fireEvent(beforeProxy.screen[1], new Event("seeked"));
    fireEvent(beforeProxy.face[1], new Event("seeked"));

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    runFrame(1_000);
    runFrame(1_200);
    act(() => useRepurposeStore.getState().pause());

    faceProxyMock.src = "/media/face-proxy.mp4";
    act(() => useRepurposeStore.setState({ showGrid: true }));
    const afterProxy = mediaFor(container);

    expect(afterProxy.screen.every((video) => video.muted)).toBe(true);
    expect(afterProxy.face[0].muted).toBe(true);
    expect(afterProxy.face[1].muted).toBe(false);
    expect(afterProxy.face[2].muted).toBe(true);
  });

  test("keeps the promoted pair synchronized after a paused screen proxy swap", async () => {
    useRepurposeStore.setState({
      clips: rapidDoubleCutClips,
      duration: 3,
      playhead: 0.8,
    });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const beforeProxy = mediaFor(container);
    beforeProxy.screen.forEach((video) => decode(video));
    beforeProxy.face.forEach((video) => decode(video));
    fireEvent(beforeProxy.screen[1], new Event("seeked"));
    fireEvent(beforeProxy.face[1], new Event("seeked"));
    fireEvent(beforeProxy.screen[2], new Event("seeked"));
    fireEvent(beforeProxy.face[2], new Event("seeked"));

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    runFrame(1_000);
    runFrame(1_200);
    act(() => useRepurposeStore.getState().pause());

    screenProxyMock.src = "/media/screen-proxy.mp4";
    act(() => useRepurposeStore.setState({ showGrid: true }));
    const afterProxy = mediaFor(container);
    afterProxy.screen.forEach((video) => decode(video));
    runFrame(1_250);

    const lastDraw = drawFrameMock.mock.calls.at(-1)?.[1];
    expect(lastDraw.screen.source).toBe(afterProxy.screen[1]);
    expect(lastDraw.face.source).toBe(beforeProxy.face[1]);
    expect(afterProxy.screen[1].currentTime).toBeCloseTo(10, 5);
    expect(afterProxy.screen[2].currentTime).toBeCloseTo(20, 5);
    expect(beforeProxy.face[1].muted).toBe(false);
  });

  test("restores slot zero as the only audible face after a screen-only source reset", async () => {
    useRepurposeStore.setState({ playhead: 0.8 });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const beforeScreenSwap = mediaFor(container);
    beforeScreenSwap.screen.forEach((video) => decode(video));
    beforeScreenSwap.face.forEach((video) => decode(video));
    fireEvent(beforeScreenSwap.screen[1], new Event("seeked"));
    fireEvent(beforeScreenSwap.face[1], new Event("seeked"));

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    runFrame(1_000);
    runFrame(1_200);
    act(() => useRepurposeStore.getState().pause());

    act(() =>
      useRepurposeStore.getState().setFootageMeta({
        ...footageMeta,
        screenPath: "/media/replacement-screen.mp4",
      })
    );
    const afterScreenSwap = mediaFor(container);

    expect(afterScreenSwap.screen.every((video) => video.muted)).toBe(true);
    expect(afterScreenSwap.face[0].muted).toBe(false);
    expect(afterScreenSwap.face[1].muted).toBe(true);
    expect(afterScreenSwap.face[2].muted).toBe(true);
  });

  test.each(["screen", "face"] as const)(
    "pauses and reports a real required %s media error",
    async (role) => {
      const { container } = render(
        createElement(PreviewCanvas, { frameScheduler })
      );
      const media = mediaFor(container);
      decode(media.screen[0]);
      decode(media.face[0]);
      act(() => useRepurposeStore.getState().play());
      await act(async () => Promise.resolve());

      fireEvent.error(media[role][0]);

      expect(useRepurposeStore.getState()).toMatchObject({
        isPlaying: false,
        mediaReadiness: "error",
        playbackBlockedReason:
          "Chrome could not load this video. Re-import it to create a compatible copy.",
      });
    }
  );

  test("uses one monotonic clock through play, seek, and a discontinuous swap", async () => {
    useRepurposeStore.setState({ playhead: 0.8 });
    const { container, unmount, getByRole } = render(
      createElement(
        "div",
        null,
        createElement(PreviewCanvas, { frameScheduler }),
        createElement(
          "button",
          { onClick: () => useRepurposeStore.getState().play() },
          "Play"
        )
      )
    );
    const media = mediaFor(container);
    media.screen.forEach((video) => decode(video));
    media.face.forEach((video) => decode(video));
    decode(media.overlay);

    // Finish the standby pre-seek so slot 1 is warm at the discontinuous cut.
    fireEvent(media.screen[1], new Event("seeked"));
    fireEvent(media.face[1], new Event("seeked"));
    useRepurposeStore.getState().setMediaReadiness("ready");

    const playButton = getByRole("button", { name: "Play" });
    for (let click = 0; click < 5; click += 1) fireEvent.click(playButton);
    await act(async () => Promise.resolve());
    expect(rafCallbacks.size).toBe(1);
    expect(media.screen[0].currentTime).toBeCloseTo(0.8, 5);
    expect(media.face[0].currentTime).toBeCloseTo(0.8, 5);

    // Deliberately poison the former face-video clock. Output time must still
    // follow rAF, and the real media elements must be corrected to source time.
    mediaTimes.set(media.face[0], 42);
    runFrame(1_000);
    expect(media.overlay.currentTime).toBeCloseTo(20.8, 5);
    runFrame(1_200);

    expect(useRepurposeStore.getState().playhead).toBeCloseTo(1, 5);
    expect(Math.abs(media.screen[1].currentTime - 10)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(media.face[1].currentTime - 10)).toBeLessThanOrEqual(0.15);
    expect(playImpl.mock.contexts).toContain(media.screen[1]);
    expect(playImpl.mock.contexts).toContain(media.face[1]);

    await act(async () => Promise.resolve());
    runFrame(1_400);

    expect(useRepurposeStore.getState().playhead).toBeCloseTo(1.2, 5);
    expect(media.screen[1].currentTime).toBeCloseTo(10.2, 5);
    expect(media.face[1].currentTime).toBeCloseTo(10.2, 5);
    expect(media.overlay.currentTime).toBeCloseTo(21.2, 5);
    const lastDraw = drawFrameMock.mock.calls.at(-1)?.[1];
    expect(lastDraw.screen.source).toBe(media.screen[1]);
    expect(lastDraw.face.source).toBe(media.face[1]);

    act(() => useRepurposeStore.getState().setPlayhead(2));
    runFrame(1_450);
    expect(useRepurposeStore.getState().playhead).toBeCloseTo(2, 5);
    expect(media.screen[1].currentTime).toBeCloseTo(11, 5);
    expect(media.face[1].currentTime).toBeCloseTo(11, 5);
    expect(media.overlay.currentTime).toBeCloseTo(22, 5);

    act(() => useRepurposeStore.getState().pause());
    runFrame(2_450);
    expect(useRepurposeStore.getState().playhead).toBeCloseTo(2, 5);

    expect(container.querySelector('[data-source-role="screen"][data-slot-index="1"]')).toBe(
      media.screen[1]
    );
    expect(container.querySelector('[data-source-role="face"][data-slot-index="1"]')).toBe(
      media.face[1]
    );
    expect(container.querySelector('[data-overlay-id="overlay-video"]')).toBe(media.overlay);

    unmount();
    expect(rafCallbacks.size).toBe(0);
  });

  test("hard-seeks both active base videos after an external seek within drift tolerance", async () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    runFrame(1_000);

    media.screen[0].currentTime = 0.5;
    media.face[0].currentTime = 0.7;
    act(() => useRepurposeStore.getState().setPlayhead(0.6));
    runFrame(1_100);

    expect(useRepurposeStore.getState().playhead).toBeCloseTo(0.6, 5);
    expect(media.screen[0].currentTime).toBe(0.6);
    expect(media.face[0].currentTime).toBe(0.6);
  });

  test("pauses with an actionable reason when an active overlay play rejects", async () => {
    playImpl
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error("overlay codec")));
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);

    act(() => useRepurposeStore.getState().play());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    runFrame(1_000);
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "error",
      playbackBlockedReason:
        "Overlay video overlay-video could not play. Re-import it to create a compatible copy.",
    });
  });

  test("ignores an old overlay rejection after Pause then a new Play", async () => {
    const oldOverlayPlay = deferred<void>();
    const newOverlayPlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => oldOverlayPlay.promise)
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => newOverlayPlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);

    act(() => useRepurposeStore.getState().play());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    runFrame(1_000);

    act(() => useRepurposeStore.getState().pause());
    act(() => useRepurposeStore.getState().play());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    runFrame(1_200);

    await act(async () => {
      oldOverlayPlay.reject(new Error("old overlay session"));
      await Promise.resolve();
    });

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: true,
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("ignores an old overlay rejection when the same id receives a new source", async () => {
    const oldOverlayPlay = deferred<void>();
    const newOverlayPlay = deferred<void>();
    playImpl
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => oldOverlayPlay.promise)
      .mockImplementationOnce(() => newOverlayPlay.promise);
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);

    act(() => useRepurposeStore.getState().play());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    runFrame(1_000);

    act(() =>
      useRepurposeStore.setState({
        overlays: [{ ...overlay, src: "/media/overlay-replacement.mp4" }],
      })
    );
    const replacement = mediaFor(container).overlay;
    decode(replacement);
    playingMedia.delete(replacement);
    runFrame(1_100);

    await act(async () => {
      oldOverlayPlay.reject(new Error("old overlay source"));
      await Promise.resolve();
    });

    expect(playImpl).toHaveBeenCalledTimes(4);
    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: true,
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("reports an active overlay error event but ignores one outside its window", async () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);
    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());

    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason:
        "Overlay video overlay-video could not play. Re-import it to create a compatible copy.",
    });

    useRepurposeStore.getState().setMediaReadiness("ready");
    useRepurposeStore.setState({
      overlays: [{ ...overlay, timelineStart: 1, timelineEnd: 2 }],
      playhead: 0,
    });
    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("blocks when an overlay that failed outside its window enters the timeline", () => {
    useRepurposeStore.setState({
      overlays: [{ ...overlay, timelineStart: 1, timelineEnd: 2 }],
      playhead: 0,
    });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("ready");

    act(() => useRepurposeStore.getState().setPlayhead(1));

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "error",
      playbackBlockedReason:
        "Overlay video overlay-video could not play. Re-import it to create a compatible copy.",
    });
  });

  test("clears an active overlay failure after seeking outside its window", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("error");

    act(() => useRepurposeStore.getState().setPlayhead(3));

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
    act(() => useRepurposeStore.getState().play());
    expect(useRepurposeStore.getState().isPlaying).toBe(true);
  });

  test("clears an active overlay failure when that overlay is removed", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("error");

    act(() => useRepurposeStore.setState({ overlays: [] }));

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
  });

  test("clears an active overlay failure when the same id receives a new source", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    fireEvent.error(media.overlay);
    expect(useRepurposeStore.getState().mediaReadiness).toBe("error");

    act(() =>
      useRepurposeStore.setState({
        overlays: [{ ...overlay, src: "/media/overlay-recovered.mp4" }],
      })
    );

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
    });
    act(() => useRepurposeStore.getState().play());
    expect(useRepurposeStore.getState().isPlaying).toBe(true);
  });

  test("ignores stale DOM overlay events after the same id receives a new source", () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    const staleOverlay = media.overlay;

    act(() =>
      useRepurposeStore.setState({
        overlays: [
          {
            ...overlay,
            src: "/media/overlay-dom-replacement.mp4",
            naturalWidth: 0,
            naturalHeight: 0,
          },
        ],
      })
    );
    const replacement = mediaFor(container).overlay;
    expect(replacement).not.toBe(staleOverlay);

    Object.defineProperties(staleOverlay, {
      videoWidth: { configurable: true, value: 640 },
      videoHeight: { configurable: true, value: 360 },
    });
    fireEvent.error(staleOverlay);
    fireEvent.loadedMetadata(staleOverlay);

    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "ready",
      playbackBlockedReason: null,
      overlays: [
        expect.objectContaining({ naturalWidth: 0, naturalHeight: 0 }),
      ],
    });

    fireEvent.error(replacement);
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason:
        "Overlay video overlay-video could not play. Re-import it to create a compatible copy.",
    });
  });

  test("synchronizes an active overlay exactly once per playing frame", async () => {
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    decode(media.overlay);
    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    synchronizeMediaTimeMock.mockClear();

    runFrame(1_000);

    const overlaySyncs = synchronizeMediaTimeMock.mock.calls.filter(
      ([element]) => element === media.overlay
    );
    expect(overlaySyncs).toHaveLength(1);
  });

  test("surfaces a required base play rejection instead of swallowing it", async () => {
    playImpl.mockImplementationOnce(function (this: HTMLMediaElement) {
      playingMedia.add(this);
      return Promise.reject(new Error("codec rejected"));
    });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);
    useRepurposeStore.getState().setMediaReadiness("ready");

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "error",
      playbackBlockedReason:
        "Chrome could not start this video. Re-import it to create a compatible copy.",
    });
  });

  test("fails fast when one required base play rejects while the other is pending", async () => {
    const facePlay = deferred<void>();
    playImpl
      .mockImplementationOnce(function (this: HTMLMediaElement) {
        playingMedia.add(this);
        return Promise.reject(new Error("screen codec rejected"));
      })
      .mockImplementationOnce(function (this: HTMLMediaElement) {
        playingMedia.add(this);
        return facePlay.promise;
      });
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());

    expect(media.screen[0].paused).toBe(true);
    expect(media.face[0].paused).toBe(true);
    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "error",
      playbackBlockedReason:
        "Chrome could not start this video. Re-import it to create a compatible copy.",
    });
  });

  test("keeps a base play failure sticky when active media later emits canplay", async () => {
    playImpl.mockImplementationOnce(() =>
      Promise.reject(new Error("screen codec rejected"))
    );
    const { container } = render(
      createElement(PreviewCanvas, { frameScheduler })
    );
    const media = mediaFor(container);
    decode(media.screen[0]);
    decode(media.face[0]);

    act(() => useRepurposeStore.getState().play());
    await act(async () => Promise.resolve());
    fireEvent.canPlay(media.screen[0]);
    fireEvent.canPlay(media.face[0]);

    expect(useRepurposeStore.getState()).toMatchObject({
      isPlaying: false,
      mediaReadiness: "error",
      playbackBlockedReason:
        "Chrome could not start this video. Re-import it to create a compatible copy.",
    });
  });
});
