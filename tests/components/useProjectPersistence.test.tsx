import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useProjectPersistence } from "@/app/repurpose-studio/_components/useProjectPersistence";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, FootageMeta, ProjectSnapshot } from "@/lib/repurpose/types";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("@/lib/export/workerBridge", () => ({
  prespawnWorker: vi.fn(),
  disposeWarmWorker: vi.fn(),
}));

const clip: Clip = {
  id: "clip-1",
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
});
