import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GhostOverflowLayer } from "@/app/repurpose-studio/_components/GhostOverflowLayer";
import { resolveOverlayTransformForFrame } from "@/lib/repurpose/overlay-geometry";
import { resolveOverlayAppearanceAt } from "@/lib/repurpose/overlay-effects";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Overlay } from "@/lib/repurpose/types";

function bleedingOverlay(band: Overlay["band"]): Overlay {
  return {
    id: `bleed-${band}`,
    kind: "image",
    src: `/${band}.png`,
    naturalWidth: 400,
    naturalHeight: 300,
    timelineStart: 0,
    timelineEnd: 10,
    srcStart: 0,
    srcDuration: 0,
    transform: { x: -0.1, y: 0.2, scale: 0.5, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    band,
  };
}

let frame: FrameRequestCallback | undefined;

function frameSnapshot(
  splitRatio: number,
  rect = { left: 0, top: 0, width: 900, height: 1600 }
) {
  const { overlays, playhead } = useRepurposeStore.getState();
  return {
    outputTime: playhead,
    splitRatio,
    appearances: new Map(
      overlays.map((overlay) => [
        overlay.id,
        resolveOverlayAppearanceAt(overlay, playhead, rect, splitRatio),
      ])
    ),
  };
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  frame = undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("does not render ghost media for a hidden band", () => {
  useRepurposeStore.setState({ overlays: [bleedingOverlay("screen")], playhead: 1 });
  render(
    <GhostOverflowLayer
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0)}
    />
  );
  act(() => frame?.(0));
  expect(document.querySelector('img[src="/screen.png"]')).not.toBeInTheDocument();
});

test("renders ghost media for a visible band", () => {
  useRepurposeStore.setState({ overlays: [bleedingOverlay("screen")], playhead: 1 });
  render(
    <GhostOverflowLayer
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0.5)}
    />
  );
  act(() => frame?.(0));
  expect(document.querySelector('img[src="/screen.png"]')).toBeInTheDocument();
});

test.each([
  { band: "screen" as const, split: 0.2 },
  { band: "face" as const, split: 0.8 },
  { band: "free" as const, split: 0.2 },
])("positions $band ghost media at the frame-resolved transform", ({ band, split }) => {
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const persisted = bleedingOverlay(band);
  persisted.transform = { x: -0.1, y: 0.5, scale: 1.4, rotation: 37 };
  const before = { ...persisted.transform };
  useRepurposeStore.setState({ overlays: [persisted], playhead: 1 });
  render(
    <GhostOverflowLayer
      getRect={() => rect}
      getFrameSnapshot={() => frameSnapshot(split, rect)}
    />
  );
  act(() => frame?.(0));

  const media = document.querySelector(`img[src="/${band}.png"]`)!;
  const box = media.parentElement as HTMLDivElement;
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(
    box.style.transform
  );
  const resolved = resolveOverlayTransformForFrame(persisted, rect, split);
  const expectedTop =
    resolved.y * rect.height -
    (resolved.scale * rect.width * persisted.naturalHeight) /
      persisted.naturalWidth /
      2;
  expect(Number(match?.[2])).toBeCloseTo(expectedTop, 10);
  expect(useRepurposeStore.getState().overlays[0].transform).toEqual(before);
});

test("uses animated geometry and compositor-equivalent rounded CSS clipping", () => {
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const animated = bleedingOverlay("free");
  animated.transform = { x: -0.1, y: 0.5, scale: 0.8, rotation: 20 };
  animated.entranceEffect = { type: "pop", durationSec: 1 };
  animated.cornerRadius = 0.16;
  useRepurposeStore.setState({ overlays: [animated], playhead: 0.5 });
  render(
    <GhostOverflowLayer
      getRect={() => rect}
      getFrameSnapshot={() => frameSnapshot(0.5, rect)}
    />
  );
  act(() => frame?.(0));

  const appearance = resolveOverlayAppearanceAt(animated, 0.5, rect, 0.5);
  const media = document.querySelector('img[src="/free.png"]')!;
  const box = media.parentElement as HTMLDivElement;
  const expectedWidth = appearance.transform.scale * rect.width;
  const expectedHeight = expectedWidth * animated.naturalHeight / animated.naturalWidth;
  expect(parseFloat(box.style.width)).toBeCloseTo(expectedWidth, 10);
  expect(box.style.overflow).toBe("hidden");
  expect(parseFloat(box.style.borderRadius)).toBeCloseTo(
    0.16 * Math.min(expectedWidth, expectedHeight),
    10
  );
});

test("does not mount a ghost at or below the animation opacity cutoff", () => {
  const invisible = bleedingOverlay("free");
  invisible.entranceEffect = { type: "fade", durationSec: 1 };
  useRepurposeStore.setState({ overlays: [invisible], playhead: 0.1 });
  render(
    <GhostOverflowLayer
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0.5)}
    />
  );
  act(() => frame?.(0));
  expect(document.querySelector('img[src="/free.png"]')).not.toBeInTheDocument();
});

test("uses snapshot time and appearance for ghost geometry and video source time", () => {
  const rect = { left: 0, top: 0, width: 900, height: 1600 };
  const animated = bleedingOverlay("free");
  animated.kind = "video";
  animated.src = "/snapshot.mp4";
  animated.srcStart = 3;
  const appearance = {
    ...resolveOverlayAppearanceAt(animated, 0.75, rect, 0.5),
    transform: { x: -0.2, y: 0.5, scale: 0.6, rotation: 12 },
  };
  useRepurposeStore.setState({ overlays: [animated], playhead: 0.1 });
  render(
    <GhostOverflowLayer
      getRect={() => rect}
      getFrameSnapshot={() => ({
        outputTime: 0.75,
        splitRatio: 0.5,
        appearances: new Map([[animated.id, appearance]]),
      })}
    />
  );
  act(() => frame?.(0));

  const video = document.querySelector('video[src="/snapshot.mp4"]') as HTMLVideoElement;
  expect(video).toBeInTheDocument();
  expect(parseFloat(video.parentElement!.style.width)).toBeCloseTo(540, 10);
});

test("uses the resolved preview proxy for a ghost video and keeps image sources unchanged", () => {
  const video = bleedingOverlay("free");
  video.id = "proxy-video";
  video.kind = "video";
  video.src = "/working-master.mp4";
  const image = bleedingOverlay("free");
  image.id = "plain-image";
  image.src = "/plain-image.png";
  image.zIndex = 1;
  useRepurposeStore.setState({ overlays: [video, image], playhead: 1 });
  render(
    <GhostOverflowLayer
      getRect={() => ({ left: 0, top: 0, width: 900, height: 1600 })}
      getFrameSnapshot={() => frameSnapshot(0.5)}
      getOverlayPreviewSrc={(id) =>
        id === video.id ? "/preview-proxy.mp4" : undefined
      }
    />
  );
  act(() => frame?.(0));

  expect(document.querySelector('video[src="/preview-proxy.mp4"]')).toBeInTheDocument();
  expect(document.querySelector('video[src="/working-master.mp4"]')).not.toBeInTheDocument();
  expect(document.querySelector('img[src="/plain-image.png"]')).toBeInTheDocument();
});
