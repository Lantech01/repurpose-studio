import { beforeEach, describe, expect, test, vi } from "vitest";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Overlay } from "@/lib/repurpose/types";

const original: Overlay = {
  id: "transform-target",
  kind: "image",
  src: "/target.png",
  naturalWidth: 100,
  naturalHeight: 100,
  timelineStart: 0,
  timelineEnd: 4,
  srcStart: 0,
  srcDuration: 0,
  transform: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
  zIndex: 0,
  opacity: 1,
  band: "free",
};

beforeEach(() => {
  useRepurposeStore.getState().resetProject();
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({ overlays: [original], past: [], future: [] });
});

describe("overlay transform gesture ownership", () => {
  test("captures one history entry on the first effective update and round-trips Undo/Redo", () => {
    const store = useRepurposeStore.getState();
    const token = store.beginOverlayTransformGesture(original.id) as string;

    store.updateOverlayTransformGesture(token, { x: original.transform.x });
    expect(useRepurposeStore.getState().past).toHaveLength(0);

    store.updateOverlayTransformGesture(token, { x: 0.6 });
    store.updateOverlayTransformGesture(token, { x: 0.7, rotation: 15 });
    store.endOverlayTransformGesture(token);

    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(useRepurposeStore.getState().overlays[0].transform).toMatchObject({
      x: 0.7,
      rotation: 15,
    });
    useRepurposeStore.getState().undo();
    expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
      original.transform
    );
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().overlays[0].transform).toMatchObject({
      x: 0.7,
      rotation: 15,
    });
  });

  test("Undo closes an active gesture, signals once, rejects stale updates, and preserves Redo", () => {
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayTransformGestureCancellation(listener);
    const token = useRepurposeStore
      .getState()
      .beginOverlayTransformGesture(original.id) as string;
    useRepurposeStore.getState().updateOverlayTransformGesture(token, { x: 0.75 });

    useRepurposeStore.getState().undo();
    useRepurposeStore.getState().updateOverlayTransformGesture(token, { x: 0.9 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
      original.transform
    );
    expect(useRepurposeStore.getState()).toMatchObject({ past: [], future: [{}] });
    useRepurposeStore.getState().redo();
    expect(useRepurposeStore.getState().overlays[0].transform.x).toBe(0.75);
    unsubscribe();
  });

  test("a competing gesture cancels and rolls back the old owner before accepting updates", () => {
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayTransformGestureCancellation(listener);
    const first = useRepurposeStore
      .getState()
      .beginOverlayTransformGesture(original.id) as string;
    useRepurposeStore.getState().updateOverlayTransformGesture(first, { x: 0.8 });

    const second = useRepurposeStore
      .getState()
      .beginOverlayTransformGesture(original.id) as string;
    useRepurposeStore.getState().updateOverlayTransformGesture(first, { x: 0.9 });
    useRepurposeStore.getState().updateOverlayTransformGesture(second, { x: 0.65 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().past).toHaveLength(1);
    expect(useRepurposeStore.getState().overlays[0].transform.x).toBe(0.65);
    useRepurposeStore.getState().endOverlayTransformGesture(second);
    unsubscribe();
  });

  test("an intervening commit or project replacement invalidates the stale owner", () => {
    const listener = vi.fn();
    const unsubscribe = useRepurposeStore
      .getState()
      .subscribeOverlayTransformGestureCancellation(listener);
    const token = useRepurposeStore
      .getState()
      .beginOverlayTransformGesture(original.id) as string;
    useRepurposeStore.getState().updateOverlayTransformGesture(token, { x: 0.8 });

    useRepurposeStore.getState().addMarker(1);
    useRepurposeStore.getState().updateOverlayTransformGesture(token, { x: 0.9 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useRepurposeStore.getState().overlays[0].transform).toEqual(
      original.transform
    );
    expect(useRepurposeStore.getState().past).toHaveLength(1);

    const replacementToken = useRepurposeStore
      .getState()
      .beginOverlayTransformGesture(original.id) as string;
    useRepurposeStore
      .getState()
      .updateOverlayTransformGesture(replacementToken, { x: 0.7 });
    useRepurposeStore.getState().resetProject();
    useRepurposeStore
      .getState()
      .updateOverlayTransformGesture(replacementToken, { x: 0.95 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(useRepurposeStore.getState()).toMatchObject({ overlays: [], past: [] });
    unsubscribe();
  });
});
