import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { replaceMock, probeBrowserVideoMock, routerMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    replaceMock,
    probeBrowserVideoMock: vi.fn(),
    routerMock: { replace: replaceMock },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/export/workerBridge", () => ({
  prespawnWorker: vi.fn(),
  disposeWarmWorker: vi.fn(),
}));

vi.mock("@/lib/repurpose/native-media-probe", () => ({
  probeBrowserVideo: probeBrowserVideoMock,
}));

import {
  restoreFootageMeta,
  restoreMediaAsset,
  useProjectPersistence,
} from "@/app/repurpose-studio/_components/useProjectPersistence";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { isSfxClipSourceAvailable } from "@/lib/repurpose/sfx-clips";
import type { MediaInspection } from "@/lib/repurpose/media-types";
import {
  VIDEO_TIMELINE_CLIP_ID,
  type Clip,
  type FootageMeta,
  type MediaAsset,
  type Overlay,
  type ProjectSnapshot,
  type SfxAsset,
  type SfxClip,
  type SfxTrack,
  type VideoSourceRecord,
} from "@/lib/repurpose/types";

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

const OUTBOX_KEY_PREFIX = "repurpose-studio-save-outbox:";

function clearProjectOutboxes(): void {
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(OUTBOX_KEY_PREFIX)) storage.removeItem(key);
    }
  }
}

function inspection(
  fingerprintCharacter = "a",
  codec = "h264"
): MediaInspection {
  return {
    fingerprint: fingerprintCharacter.repeat(64),
    container: "mov,mp4",
    extension: codec === "h264" ? ".mp4" : ".mov",
    size: 1_024,
    durationSec: 5,
    video: {
      codec,
      codecTag: codec === "h264" ? "avc1" : "hvc1",
      profile: "Main",
      pixelFormat: "yuv420p",
      width: 1920,
      height: 1080,
      fps: 30,
    },
    audio: { codec: "aac", channels: 1, sampleRate: 48_000 },
  };
}

function source(
  originalPath: string,
  workingPath = originalPath,
  overrides: Partial<VideoSourceRecord> = {}
): VideoSourceRecord {
  const converted = originalPath !== workingPath;
  return {
    originalPath,
    workingPath,
    originalName: originalPath.split(/[\\/]/).at(-1) ?? "video.mp4",
    inspection: inspection(converted ? "b" : "a", converted ? "hevc" : "h264"),
    nativeCompatible: !converted,
    compatibilityStatus: converted ? "converted" : "native",
    ...overrides,
  };
}

function videoUrl(path: string): string {
  return `/api/repurpose/video?path=${encodeURIComponent(path)}`;
}

function footage(
  faceCamSource?: VideoSourceRecord,
  screenSource?: VideoSourceRecord
): FootageMeta {
  return {
    faceCamPath: faceCamSource
      ? videoUrl(faceCamSource.workingPath)
      : "/media/face.mp4",
    screenPath: screenSource
      ? videoUrl(screenSource.workingPath)
      : "/media/screen.mp4",
    faceCamSource,
    screenSource,
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: 5,
  };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    clips: [clip],
    duration: 5,
    splitRatio: 0.5,
    screenGrade: "none",
    faceGrade: "neutral",
    playhead: 0,
    inPoint: null,
    outPoint: null,
    loopPlayback: false,
    footageMeta: footage(),
    ...overrides,
  };
}

function sfxClip(overrides: Partial<SfxClip> = {}): SfxClip {
  return {
    id: "sfx-clip-1",
    name: "Ding",
    source: { kind: "built-in", key: "ding" },
    origin: "manual",
    timelineStart: 1,
    sourceStart: 0,
    sourceEnd: 2,
    gain: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
    ...overrides,
  };
}

const persistedLegacyTrack: SfxTrack = {
  src: "blob:must-not-be-restored",
  sourcePath: "C:\\cache\\generated.wav",
  durationSec: 8,
  gain: 1.25,
};

function installSfxRoundTrip(initial: ProjectSnapshot): {
  saved: () => ProjectSnapshot | null;
} {
  let persisted = initial;
  let saved: ProjectSnapshot | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/repurpose/projects/") && !init?.method) {
        return jsonResponse({
          project: {
            id: "task-6-project",
            name: "Task 6 project",
            createdAt: "2026-08-24T00:00:00.000Z",
            snapshot: persisted,
          },
        });
      }
      if (url === "/api/repurpose/projects" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as ControlledSaveBody;
        persisted = body.snapshot;
        saved = body.snapshot;
        return jsonResponse({
          project: {
            id: "task-6-project",
            name: "Task 6 project",
            createdAt: "2026-08-24T00:00:00.000Z",
            saveRevision: body.saveRevision,
            saveWriterId: body.writerId,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    })
  );
  return { saved: () => saved };
}

function videoAsset(
  id: string,
  videoSource?: VideoSourceRecord,
  overrides: Partial<MediaAsset> = {}
): MediaAsset {
  const workingPath = videoSource?.workingPath;
  return {
    id,
    kind: "video",
    name: videoSource?.originalName ?? "legacy.mp4",
    src: workingPath ? videoUrl(workingPath) : "",
    sourcePath: workingPath,
    videoSource,
    naturalWidth: 1920,
    naturalHeight: 1080,
    srcDuration: 5,
    ...overrides,
  };
}

function videoOverlay(
  id: string,
  videoSource?: VideoSourceRecord,
  overrides: Partial<Overlay> = {}
): Overlay {
  const workingPath = videoSource?.workingPath;
  return {
    id,
    kind: "video",
    src: workingPath ? videoUrl(workingPath) : "",
    sourcePath: workingPath,
    videoSource,
    naturalWidth: 1920,
    naturalHeight: 1080,
    timelineStart: 0,
    timelineEnd: 5,
    srcStart: 0,
    srcDuration: 5,
    transform: { x: 0.5, y: 0.25, scale: 1, rotation: 0 },
    zIndex: 0,
    opacity: 1,
    muted: true,
    ...overrides,
  };
}

function legacyImageOverlay(
  id: string,
  overrides: Partial<Overlay> = {}
): Overlay {
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
    zIndex: 0,
    opacity: 1,
    band: "screen",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

interface ControlledSaveBody {
  writerId: string;
  baseRevision: number;
  saveRevision: number;
  snapshot: ProjectSnapshot;
}

interface PersistedSaveControl {
  saveRevision: number;
  saveWriterId: string | null;
  saveWriterBaseRevision: number;
}

function acceptControlledSave(
  state: PersistedSaveControl,
  body: ControlledSaveBody
): boolean {
  if (state.saveRevision === 0) {
    if (body.baseRevision !== 0 || body.saveRevision <= 0) return false;
    state.saveWriterId = body.writerId;
    state.saveWriterBaseRevision = 0;
  } else if (state.saveWriterId === body.writerId) {
    if (
      body.baseRevision < state.saveWriterBaseRevision ||
      body.baseRevision > state.saveRevision ||
      body.saveRevision <= state.saveRevision
    ) {
      return false;
    }
  } else {
    if (
      body.baseRevision !== state.saveRevision ||
      body.saveRevision <= state.saveRevision
    ) {
      return false;
    }
    state.saveWriterId = body.writerId;
    state.saveWriterBaseRevision = body.baseRevision;
  }
  state.saveRevision = body.saveRevision;
  return true;
}

function mediaPath(input: RequestInfo | URL): string | null {
  const raw = String(input);
  if (!raw.startsWith("/api/repurpose/media?")) return null;
  return new URL(raw, "http://localhost").searchParams.get("path");
}

function installProjectFetch(
  projectSnapshot: ProjectSnapshot,
  handleMedia: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response> | Response
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).startsWith("/api/repurpose/projects/")) {
        return jsonResponse({
          project: {
            id: "task-6-project",
            name: "Task 6 project",
            createdAt: "2026-08-24T00:00:00.000Z",
            snapshot: projectSnapshot,
          },
        });
      }
      return handleMedia(input, init);
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function loadProject(): Promise<
  ReturnType<typeof renderHook<ReturnType<typeof useProjectPersistence>, unknown>>
> {
  const rendered = renderHook(() => useProjectPersistence("task-6-project"));
  await waitFor(() => expect(rendered.result.current.ready).toBe(true));
  return rendered;
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  clearProjectOutboxes();
  const realmState = (
    window as unknown as Record<symbol, unknown>
  )[Symbol.for("repurpose-studio.save-writer-id")] as
    | {
        issuedRevisionByProject?: Map<string, number>;
        acknowledgedRevisionByProject?: Map<string, number>;
        latestSnapshotByProject?: Map<string, unknown>;
        createRequestIdByProject?: Map<string, string>;
      }
    | undefined;
  realmState?.issuedRevisionByProject?.clear();
  realmState?.acknowledgedRevisionByProject?.clear();
  realmState?.latestSnapshotByProject?.clear();
  realmState?.createRequestIdByProject?.clear();
  replaceMock.mockReset();
  probeBrowserVideoMock.mockReset().mockResolvedValue({
    decodable: true,
    durationSec: 5,
    width: 1920,
    height: 1080,
  });
});

afterEach(() => {
  cleanup();
  clearProjectOutboxes();
  vi.unstubAllGlobals();
});

describe("SFX project persistence", () => {
  test("saves and reopens a near-tail source-out edit without silently shortening it", async () => {
    const nearTail = sfxClip({
      id: "sfx-near-tail",
      source: { kind: "imported", assetId: "near-tail-asset", srcDuration: 4 },
      timelineStart: 4.5,
      sourceStart: 1,
      sourceEnd: 1.25,
    });
    const asset: SfxAsset = {
      id: "near-tail-asset",
      name: "Near tail.wav",
      sourcePath: "C:\\audio\\near-tail.wav",
      srcDuration: 4,
    };
    const persistence = installSfxRoundTrip(snapshot({
      footageMeta: null,
      sfxAssets: [asset],
      sfxClips: [nearTail],
    }));
    const firstMount = await loadProject();

    act(() => useRepurposeStore.getState().setSfxClipSourceEnd(nearTail.id, 4));
    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBe(1.5);
    await waitFor(() => expect(persistence.saved()?.sfxClips?.[0].sourceEnd).toBe(1.5));
    const savedClip = persistence.saved()!.sfxClips![0];
    firstMount.unmount();
    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);

    const reopened = await loadProject();
    expect(useRepurposeStore.getState().sfxClips[0]).toEqual(savedClip);
    expect(useRepurposeStore.getState().sfxClips[0].sourceEnd).toBe(1.5);
    reopened.unmount();
  });

  test("writes normalized clips and assets without legacy or transient fields, then reopens every source kind", async () => {
    const persistence = installSfxRoundTrip(snapshot({ footageMeta: null }));
    const firstMount = await loadProject();
    const asset: SfxAsset = {
      id: "sfx-asset-41",
      name: "Imported hit.wav",
      sourcePath: "C:\\audio\\imported-hit.wav",
      srcDuration: 4,
    };
    const authoredClips = [
      sfxClip({ id: "sfx-clip-41" }),
      sfxClip({
        id: "sfx-clip-42",
        name: "Imported hit",
        source: { kind: "imported", assetId: asset.id, srcDuration: 4 },
        sourceEnd: 3,
      }),
      sfxClip({
        id: "sfx-clip-43",
        name: "Legacy render",
        source: {
          kind: "legacy",
          sourcePath: persistedLegacyTrack.sourcePath,
          srcDuration: 5,
        },
        origin: "automatic",
        sourceEnd: 4,
      }),
    ];

    act(() => {
      useRepurposeStore.setState({
        sfxAssets: [{ ...asset, src: "blob:derived", waveform: [0.1] } as unknown as SfxAsset],
        sfxClips: authoredClips.map((entry) => ({
          ...entry,
          src: "blob:derived",
          decodedBuffer: { stale: true },
          waveform: [0.1],
          lane: 3,
          selected: true,
          error: "stale",
        })) as unknown as SfxClip[],
        selectedSfxClipId: "sfx-clip-43",
        sfxGenerating: true,
      });
    });

    await waitFor(() => expect(persistence.saved()).not.toBeNull());
    const saved = persistence.saved()!;
    expect(saved.sfxAssets).toEqual([asset]);
    expect(saved.sfxClips).toEqual(authoredClips);
    expect(saved).not.toHaveProperty("sfxTrack");
    for (const field of [
      "selectedSfxClipId",
      "sfxGenerating",
      "sfxDocumentRevision",
      "audition",
      "lanes",
      "gesture",
      "error",
    ]) {
      expect(saved).not.toHaveProperty(field);
    }
    firstMount.unmount();
    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);

    const reopened = await loadProject();
    expect(useRepurposeStore.getState()).toMatchObject({
      sfxAssets: [asset],
      sfxClips: authoredClips,
      past: [],
      future: [],
    });
    reopened.unmount();
  });

  test("does not serialize URL-like or query-bearing SFX source paths", async () => {
    const persistence = installSfxRoundTrip(snapshot({ footageMeta: null }));
    const rendered = await loadProject();
    const invalidPaths = [
      "/api/repurpose/sfx?path=C%3A%5Caudio%5Chit.wav",
      "blob:temporary",
      "https://example.com/hit.wav",
      "relative/hit.wav",
      "C:\\audio\\hit.wav?token=derived",
    ];

    act(() => {
      useRepurposeStore.setState({
        sfxAssets: invalidPaths.map((sourcePath, index) => ({
          id: `sfx-asset-invalid-${index}`,
          name: `Invalid ${index}`,
          sourcePath,
          srcDuration: 2,
        })),
        sfxClips: invalidPaths.map((sourcePath, index) => sfxClip({
          id: `sfx-clip-invalid-${index}`,
          name: `Invalid ${index}`,
          source: { kind: "legacy", sourcePath, srcDuration: 2 },
        })),
      });
    });

    await waitFor(() => expect(persistence.saved()).not.toBeNull());
    expect(persistence.saved()).toMatchObject({ sfxAssets: [], sfxClips: [] });
    rendered.unmount();
  });

  test("treats an explicit empty clip array as authoritative over a stale track", async () => {
    installSfxRoundTrip(snapshot({
      footageMeta: null,
      sfxClips: [],
      sfxAssets: [],
      sfxTrack: persistedLegacyTrack,
    }));

    const rendered = await loadProject();

    expect(useRepurposeStore.getState()).toMatchObject({
      sfxClips: [],
      sfxAssets: [],
      past: [],
    });
    rendered.unmount();
  });

  test("isolates malformed clips while retaining an unavailable imported sibling", async () => {
    const missingImported = sfxClip({
      id: "sfx-clip-52",
      name: "Missing import",
      source: { kind: "imported", assetId: "sfx-asset-missing", srcDuration: 4 },
      sourceEnd: 4,
    });
    const malformed = [
      sfxClip({ id: "sfx-clip-51", sourceEnd: 99 }),
      { ...sfxClip({ id: "bad-key" }), source: { kind: "built-in", key: "unknown" } },
      { ...sfxClip({ id: "zero" }), sourceStart: 1, sourceEnd: 1 },
      { ...sfxClip({ id: "nan" }), timelineStart: Number.NaN },
      { ...sfxClip({ id: "relative" }), source: { kind: "legacy", sourcePath: "relative.wav", srcDuration: 2 } },
      { ...sfxClip({ id: "api-url" }), source: { kind: "legacy", sourcePath: "/api/repurpose/sfx?path=derived", srcDuration: 2 } },
      { ...sfxClip({ id: "blob-url" }), source: { kind: "legacy", sourcePath: "blob:temporary", srcDuration: 2 } },
      { ...sfxClip({ id: "http-url" }), source: { kind: "legacy", sourcePath: "https://example.com/hit.wav", srcDuration: 2 } },
      { ...sfxClip({ id: "query-path" }), source: { kind: "legacy", sourcePath: "C:\\audio\\hit.wav?token=derived", srcDuration: 2 } },
      missingImported,
    ] as unknown as SfxClip[];
    installSfxRoundTrip(snapshot({
      footageMeta: null,
      sfxClips: malformed,
      sfxAssets: [],
    }));

    const rendered = await loadProject();
    const state = useRepurposeStore.getState();

    expect(state.sfxClips.map((entry) => entry.id)).toEqual([
      "sfx-clip-51",
      "sfx-clip-52",
    ]);
    expect(state.sfxClips[0].sourceEnd).toBe(2.951854167);
    expect(isSfxClipSourceAvailable(state.sfxClips[1].source, state.sfxAssets)).toBe(false);
    rendered.unmount();
  });

  test("normalizes inventory paths and repeated IDs without aliasing", async () => {
    const assets = [
      { id: "sfx-asset-71", name: "First.wav", sourcePath: "C:\\audio\\first.wav", srcDuration: 2 },
      { id: "sfx-asset-71", name: "Second.wav", sourcePath: "C:\\audio\\second.wav", srcDuration: 3 },
      { id: "blank", name: "   ", sourcePath: "C:\\audio\\blank.wav", srcDuration: 1 },
      { id: "relative", name: "Relative.wav", sourcePath: "relative.wav", srcDuration: 1 },
      { id: "api", name: "API.wav", sourcePath: "/api/repurpose/sfx?path=derived", srcDuration: 1 },
      { id: "blob", name: "Blob.wav", sourcePath: "blob:temporary", srcDuration: 1 },
      { id: "http", name: "HTTP.wav", sourcePath: "https://example.com/hit.wav", srcDuration: 1 },
      { id: "query", name: "Query.wav", sourcePath: "C:\\audio\\hit.wav?token=derived", srcDuration: 1 },
      { id: "zero", name: "Zero.wav", sourcePath: "C:\\audio\\zero.wav", srcDuration: 0 },
    ] as SfxAsset[];
    installSfxRoundTrip(snapshot({ footageMeta: null, sfxClips: [], sfxAssets: assets }));

    const rendered = await loadProject();

    expect(useRepurposeStore.getState().sfxAssets).toEqual([
      assets[0],
      { ...assets[1], id: "sfx-asset-71-2" },
    ]);
    rendered.unmount();
  });

  test.each([
    "C:\\audio\\drive.wav",
    "\\\\server\\share\\unc.wav",
    "/var/tmp/posix.wav",
  ])("hydrates valid absolute local SFX path %s", async (sourcePath) => {
    const asset: SfxAsset = {
      id: "sfx-asset-local",
      name: "Local.wav",
      sourcePath,
      srcDuration: 2,
    };
    const clip = sfxClip({
      id: "sfx-clip-local",
      name: "Local legacy",
      origin: "automatic",
      timelineStart: 0,
      source: { kind: "legacy", sourcePath, srcDuration: 2 },
      sourceEnd: 2,
    });
    installSfxRoundTrip(snapshot({
      footageMeta: null,
      sfxAssets: [asset],
      sfxClips: [clip],
    }));

    const rendered = await loadProject();

    expect(useRepurposeStore.getState()).toMatchObject({
      sfxAssets: [asset],
      sfxClips: [clip],
    });
    rendered.unmount();
  });

  test("migrates an old track exactly, saves only new arrays, and reopens it", async () => {
    const persistence = installSfxRoundTrip(snapshot({
      footageMeta: null,
      sfxTrack: persistedLegacyTrack,
    }));
    const firstMount = await loadProject();

    expect(useRepurposeStore.getState()).toMatchObject({
      sfxClips: [{
        name: "Legacy Sound Effects",
        source: {
          kind: "legacy",
          sourcePath: persistedLegacyTrack.sourcePath,
          srcDuration: 8,
        },
        origin: "automatic",
        timelineStart: 0,
        sourceStart: 0,
        sourceEnd: 5,
        gain: 1.25,
        fadeInSec: 0,
        fadeOutSec: 0,
        muted: false,
      }],
      past: [],
    });
    act(() => useRepurposeStore.getState().addMarker(1));
    await waitFor(() => expect(persistence.saved()).not.toBeNull());
    expect(persistence.saved()).not.toHaveProperty("sfxTrack");
    expect(persistence.saved()?.sfxClips).toHaveLength(1);
    firstMount.unmount();
    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);

    const reopened = await loadProject();
    expect(useRepurposeStore.getState().sfxClips).toEqual(persistence.saved()?.sfxClips);
    expect(useRepurposeStore.getState()).not.toHaveProperty("sfxTrack");
    reopened.unmount();
  });

  test.each([
    { ...persistedLegacyTrack, durationSec: 0 },
    { ...persistedLegacyTrack, gain: Number.NaN },
    { ...persistedLegacyTrack, sourcePath: "relative.wav" },
    { ...persistedLegacyTrack, sourcePath: "/api/repurpose/sfx?path=derived" },
    { ...persistedLegacyTrack, sourcePath: "blob:temporary" },
    { ...persistedLegacyTrack, sourcePath: "https://example.com/hit.wav" },
    { ...persistedLegacyTrack, sourcePath: "C:\\audio\\hit.wav?token=derived" },
  ])("does not create an incoherent bridge from an invalid old track", async (invalidTrack) => {
    installSfxRoundTrip(snapshot({ footageMeta: null, sfxTrack: invalidTrack }));

    const rendered = await loadProject();

    expect(useRepurposeStore.getState()).toMatchObject({ sfxClips: [] });
    rendered.unmount();
  });

  test("keeps hydrated inventory through placement Undo and reseeds both ID domains", async () => {
    const asset: SfxAsset = {
      id: "sfx-asset-9100000",
      name: "Hydrated.wav",
      sourcePath: "C:\\audio\\hydrated.wav",
      srcDuration: 4,
    };
    installSfxRoundTrip(snapshot({
      footageMeta: null,
      sfxAssets: [asset],
      sfxClips: [sfxClip({ id: "sfx-clip-9200000" })],
    }));
    const rendered = await loadProject();

    const placedId = useRepurposeStore.getState().addSfxClip({
      name: asset.name,
      source: { kind: "imported", assetId: asset.id, srcDuration: asset.srcDuration },
      atTime: 2,
    }) as string;
    useRepurposeStore.getState().undo();
    const addedAssetId = useRepurposeStore.getState().addSfxAsset({
      name: "Next.wav",
      sourcePath: "C:\\audio\\next.wav",
      srcDuration: 2,
    });

    expect(Number(placedId.slice("sfx-clip-".length))).toBeGreaterThan(9_200_000);
    expect(Number(addedAssetId.slice("sfx-asset-".length))).toBeGreaterThan(9_100_000);
    expect(useRepurposeStore.getState().sfxAssets).toEqual([
      asset,
      expect.objectContaining({ id: addedAssetId, name: "Next.wav" }),
    ]);
    expect(useRepurposeStore.getState().sfxClips).toEqual([
      expect.objectContaining({ id: "sfx-clip-9200000" }),
    ]);
    rendered.unmount();
  });
});

describe("pure project media restoration", () => {
  test("new source records always rederive full-quality browser URLs", () => {
    const face = source("C:\\originals\\face.mov", "C:\\masters\\face.mp4");
    const screen = source("C:\\originals\\screen.mp4");
    const restored = restoreFootageMeta({
      ...footage(face, screen),
      faceCamPath: "blob:stale-face",
      screenPath: "blob:stale-screen",
    });
    const asset = restoreMediaAsset({
      ...videoAsset("asset-1", face),
      src: "blob:stale-asset",
      sourcePath: "C:\\stale.mp4",
    });

    expect(restored).toMatchObject({
      faceCamPath: videoUrl(face.workingPath),
      screenPath: videoUrl(screen.workingPath),
      faceCamSource: face,
      screenSource: screen,
    });
    expect(asset).toMatchObject({
      src: videoUrl(face.workingPath),
      sourcePath: face.workingPath,
      videoSource: face,
    });
  });

  test("legacy proxy URLs recover their raw working paths without inventing metadata", () => {
    const facePath = "C:\\legacy\\face.mp4";
    const assetPath = "C:\\legacy\\overlay.mp4";

    expect(
      restoreFootageMeta({
        ...footage(),
        faceCamPath: videoUrl(facePath),
      })
    ).toMatchObject({ faceCamPath: videoUrl(facePath) });
    expect(
      restoreMediaAsset(
        videoAsset("asset-legacy", undefined, {
          src: videoUrl(assetPath),
          sourcePath: undefined,
        })
      )
    ).toMatchObject({
      src: videoUrl(assetPath),
      sourcePath: assetPath,
      videoSource: undefined,
    });
  });

  test("legacy blob URLs remain unchanged so the existing reconnect state can flag them", () => {
    const restored = restoreFootageMeta({
      ...footage(),
      faceCamPath: "blob:dead-face",
      screenPath: "blob:dead-screen",
    });
    const asset = restoreMediaAsset(
      videoAsset("asset-blob", undefined, {
        src: "blob:dead-asset",
        sourcePath: undefined,
      })
    );

    expect(restored).toMatchObject({
      faceCamPath: "blob:dead-face",
      screenPath: "blob:dead-screen",
      faceCamSource: undefined,
      screenSource: undefined,
    });
    expect(asset).toMatchObject({
      src: "blob:dead-asset",
      sourcePath: undefined,
      videoSource: undefined,
    });
  });

  test("store writers keep legacy URLs on the full-quality working source", () => {
    const imported = source(
      "C:\\originals\\clip.mov",
      "C:\\masters\\clip.mp4"
    );
    const store = useRepurposeStore.getState();

    store.setFootageMeta({
      ...footage(imported, imported),
      faceCamPath: "blob:stale-face",
      screenPath: "blob:stale-screen",
    });
    const assetId = store.addMediaAsset({
      kind: "video",
      name: imported.originalName,
      src: "blob:stale-asset",
      sourcePath: "C:\\stale-asset.mp4",
      videoSource: imported,
    });
    const overlayId = store.addOverlay({
      kind: "video",
      src: "blob:stale-overlay",
      sourcePath: "C:\\stale-overlay.mp4",
      videoSource: imported,
      naturalWidth: 1920,
      naturalHeight: 1080,
      srcDuration: 5,
      atTime: 0,
    });
    const next = useRepurposeStore.getState();

    expect(next.footageMeta).toMatchObject({
      faceCamPath: videoUrl(imported.workingPath),
      screenPath: videoUrl(imported.workingPath),
    });
    expect(next.mediaAssets.find((asset) => asset.id === assetId)).toMatchObject({
      src: videoUrl(imported.workingPath),
      sourcePath: imported.workingPath,
      videoSource: imported,
    });
    expect(next.overlays.find((overlay) => overlay.id === overlayId)).toMatchObject({
      src: videoUrl(imported.workingPath),
      sourcePath: imported.workingPath,
      videoSource: imported,
    });
  });
});

describe("project media reconciliation", () => {
  test("round-trips normalized overlay appearance without changing authored effects", async () => {
    const legacy: Overlay = {
      id: "overlay-legacy-appearance",
      kind: "image",
      src: "/legacy.png",
      naturalWidth: 800,
      naturalHeight: 600,
      timelineStart: 0,
      timelineEnd: 4,
      srcStart: 0,
      srcDuration: 0,
      transform: { x: 0.5, y: 0.25, scale: 1, rotation: 0 },
      zIndex: 0,
      opacity: 1,
    };
    const authored: Overlay = {
      ...legacy,
      id: "overlay-authored-appearance",
      zIndex: 1,
      entranceEffect: { type: "slide", durationSec: 0.6, direction: "right" },
      exitEffect: { type: "pop", durationSec: 1.1 },
      cornerRadius: 0.2,
    };
    let persisted = snapshot({ overlays: [legacy, authored] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/repurpose/projects/") && !init?.method) {
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              snapshot: persisted,
            },
          });
        }
        if (String(input) === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          persisted = body.snapshot;
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      })
    );

    const firstMount = await loadProject();
    useRepurposeStore
      .getState()
      .setOverlayCornerRadius("overlay-authored-appearance", 0.3);
    await waitFor(() =>
      expect(persisted.overlays?.[1]?.cornerRadius).toBe(0.3)
    );
    expect(persisted.overlays).toMatchObject([
      {
        entranceEffect: { type: "none", durationSec: 0.35 },
        exitEffect: { type: "none", durationSec: 0.35 },
        cornerRadius: 0,
      },
      {
        entranceEffect: { type: "slide", durationSec: 0.6, direction: "right" },
        exitEffect: { type: "pop", durationSec: 1.1 },
        cornerRadius: 0.3,
      },
    ]);
    firstMount.unmount();
    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);

    const reopened = await loadProject();
    expect(useRepurposeStore.getState().overlays).toMatchObject(
      persisted.overlays ?? []
    );
    reopened.unmount();
  });

  test.each([0, 1])(
    "round-trips global and per-clip split endpoint %s without schema changes",
    async (endpoint) => {
      let persisted = snapshot({
        footageMeta: null,
        splitRatio: endpoint,
        clips: [
          { ...clip, splitRatio: endpoint },
          {
            ...clip,
            id: "clip-opposite",
            srcStart: 5,
            srcEnd: 10,
            timelineStart: 5,
            timelineEnd: 10,
            splitRatio: 1 - endpoint,
          },
        ],
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).startsWith("/api/repurpose/projects/") && !init?.method) {
            return jsonResponse({
              project: {
                id: "task-6-project",
                name: "Task 6 project",
                createdAt: "2026-08-24T00:00:00.000Z",
                snapshot: persisted,
              },
            });
          }
          if (String(input) === "/api/repurpose/projects" && init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as ControlledSaveBody;
            persisted = body.snapshot;
            return jsonResponse({
              project: {
                id: "task-6-project",
                name: "Task 6 project",
                createdAt: "2026-08-24T00:00:00.000Z",
                saveRevision: body.saveRevision,
                saveWriterId: body.writerId,
              },
            });
          }
          throw new Error(`Unexpected request: ${String(input)}`);
        })
      );

      const firstMount = await loadProject();
      useRepurposeStore.setState({ splitRatio: endpoint });
      await waitFor(() => expect(persisted.splitRatio).toBe(endpoint));
      firstMount.unmount();
      useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);

      const reopened = await loadProject();
      expect(useRepurposeStore.getState().splitRatio).toBe(endpoint);
      expect(useRepurposeStore.getState().clips.map((entry) => entry.splitRatio)).toEqual([
        endpoint,
        1 - endpoint,
      ]);
      expect(persisted).not.toHaveProperty("splitMode");
      reopened.unmount();
    }
  );

  test("retains and checks footage, media-bin, and overlay source records before ready", async () => {
    const face = source("C:\\originals\\face.mov", "C:\\masters\\face.mp4");
    const screen = source("C:\\originals\\screen.mp4");
    const library = source("C:\\originals\\library.mp4");
    const overlaySource = source(
      "C:\\originals\\overlay.mov",
      "C:\\masters\\overlay.mp4"
    );
    const requestedPaths: string[] = [];
    installProjectFetch(
      snapshot({
        footageMeta: footage(face, screen),
        mediaAssets: [videoAsset("asset-1", library)],
        overlays: [videoOverlay("overlay-1", overlaySource)],
      }),
      (input) => {
        const path = mediaPath(input);
        if (path) {
          requestedPaths.push(path);
          return jsonResponse(
            path.includes("originals")
              ? source(path).inspection
              : inspection("f")
          );
        }
        if (String(input).startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "unavailable" });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }
    );

    const { result } = await loadProject();
    const state = useRepurposeStore.getState();

    expect(result.current.footageNeedsReimport).toBe(false);
    expect(state.footageMeta).toMatchObject({
      faceCamPath: videoUrl(face.workingPath),
      screenPath: videoUrl(screen.workingPath),
      faceCamSource: expect.objectContaining({
        originalPath: face.originalPath,
        workingPath: face.workingPath,
      }),
      screenSource: expect.objectContaining({
        originalPath: screen.originalPath,
        workingPath: screen.workingPath,
      }),
    });
    expect(state.mediaAssets[0]).toMatchObject({
      src: videoUrl(library.workingPath),
      sourcePath: library.workingPath,
      videoSource: expect.objectContaining({ workingPath: library.workingPath }),
    });
    expect(state.overlays[0]).toMatchObject({
      src: videoUrl(overlaySource.workingPath),
      sourcePath: overlaySource.workingPath,
      videoSource: expect.objectContaining({
        workingPath: overlaySource.workingPath,
      }),
    });
    expect(state.mediaReadiness).toBe("loading");
    expect(requestedPaths).toEqual(
      expect.arrayContaining([
        face.originalPath,
        face.workingPath,
        screen.originalPath,
        library.originalPath,
        overlaySource.originalPath,
        overlaySource.workingPath,
      ])
    );
  });

  test("lazily creates source records from legacy proxy paths", async () => {
    const facePath = "C:\\legacy\\face.mp4";
    const screenPath = "C:\\legacy\\screen.mp4";
    const assetPath = "C:\\legacy\\library.mp4";
    const overlayPath = "C:\\legacy\\overlay.mp4";
    installProjectFetch(
      snapshot({
        footageMeta: {
          ...footage(),
          faceCamPath: videoUrl(facePath),
          screenPath: videoUrl(screenPath),
        },
        mediaAssets: [
          videoAsset("asset-legacy", undefined, {
            src: videoUrl(assetPath),
            sourcePath: undefined,
          }),
        ],
        overlays: [
          videoOverlay("overlay-legacy", undefined, {
            src: videoUrl(overlayPath),
            sourcePath: undefined,
          }),
        ],
      }),
      (input) => {
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (String(input).startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "unavailable" });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }
    );

    await loadProject();
    const state = useRepurposeStore.getState();

    expect(state.footageMeta?.faceCamSource).toMatchObject({
      originalPath: facePath,
      workingPath: facePath,
      originalName: "face.mp4",
      compatibilityStatus: "native",
    });
    expect(state.footageMeta?.screenSource).toMatchObject({
      originalPath: screenPath,
      workingPath: screenPath,
      originalName: "screen.mp4",
      compatibilityStatus: "native",
    });
    expect(state.mediaAssets[0].videoSource).toMatchObject({
      originalPath: assetPath,
      workingPath: assetPath,
    });
    expect(state.overlays[0].videoSource).toMatchObject({
      originalPath: overlayPath,
      workingPath: overlayPath,
    });
  });

  test("browser-probes a legacy HEVC path and converts it before marking it compatible", async () => {
    const legacyPath = "C:\\legacy\\hevc-face.mov";
    const compatiblePath = "C:\\masters\\hevc-face-h264.mp4";
    probeBrowserVideoMock
      .mockResolvedValueOnce({
        decodable: false,
        durationSec: 0,
        width: 0,
        height: 0,
        reason: "invalid-metadata",
      })
      .mockResolvedValueOnce({
        decodable: true,
        durationSec: 5,
        width: 1920,
        height: 1080,
      });
    installProjectFetch(
      snapshot({
        footageMeta: {
          ...footage(),
          faceCamPath: videoUrl(legacyPath),
        },
      }),
      (input, init) => {
        const url = String(input);
        const path = mediaPath(input);
        if (path === legacyPath) return jsonResponse(inspection("h", "hevc"));
        if (
          url === "/api/repurpose/compatibility" &&
          init?.method === "POST"
        ) {
          return jsonResponse({
            status: "ready",
            progress: 1,
            workingPath: compatiblePath,
          });
        }
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    await loadProject();

    expect(probeBrowserVideoMock).toHaveBeenNthCalledWith(
      1,
      videoUrl(legacyPath),
      expect.any(AbortSignal)
    );
    expect(probeBrowserVideoMock).toHaveBeenNthCalledWith(
      2,
      videoUrl(compatiblePath),
      expect.any(AbortSignal)
    );
    expect(useRepurposeStore.getState().footageMeta).toMatchObject({
      faceCamPath: videoUrl(compatiblePath),
      faceCamSource: {
        originalPath: legacyPath,
        workingPath: compatiblePath,
        nativeCompatible: false,
        compatibilityStatus: "converted",
      },
    });
  });

  test("cancels an active legacy conversion with a bounded best-effort DELETE", async () => {
    vi.useFakeTimers();
    try {
      const legacyPath = "C:\\legacy\\cancel-hevc.mov";
      let markCompatibilityStarted!: () => void;
      const compatibilityStarted = new Promise<void>((resolve) => {
        markCompatibilityStarted = resolve;
      });
      let cancellationSignal: AbortSignal | undefined;
      probeBrowserVideoMock.mockResolvedValue({
        decodable: false,
        durationSec: 0,
        width: 0,
        height: 0,
        reason: "invalid-metadata",
      });
      const fetchMock = installProjectFetch(
        snapshot({
          footageMeta: {
            ...footage(),
            faceCamPath: videoUrl(legacyPath),
          },
        }),
        (input, init) => {
          const url = String(input);
          const path = mediaPath(input);
          if (path === legacyPath) return jsonResponse(inspection("h", "hevc"));
          if (
            url === "/api/repurpose/compatibility" &&
            init?.method === "POST"
          ) {
            markCompatibilityStarted();
            return jsonResponse({ status: "building", progress: 0.1 }, 202);
          }
          if (
            url === "/api/repurpose/compatibility" &&
            init?.method === "DELETE"
          ) {
            cancellationSignal = init.signal ?? undefined;
            return new Promise<Response>(() => undefined);
          }
          if (url.startsWith("/api/repurpose/proxy?")) {
            return jsonResponse({ status: "unavailable" });
          }
          throw new Error(`Unexpected request: ${url}`);
        }
      );
      const rendered = renderHook(
        ({ projectId }) => useProjectPersistence(projectId),
        { initialProps: { projectId: "task-6-project" } }
      );
      await compatibilityStarted;

      rendered.rerender({ projectId: "new-reset" });
      await act(async () => {
        await Promise.resolve();
      });

      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === "/api/repurpose/compatibility" &&
            init?.method === "DELETE"
        )
      ).toBe(true);
      expect(cancellationSignal?.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(cancellationSignal?.aborted).toBe(true);
      expect(rendered.result.current.ready).toBe(true);
      expect(useRepurposeStore.getState().hydrating).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("persists reconciled legacy sources without another store mutation", async () => {
    const facePath = "C:\\legacy\\face.mp4";
    const screenPath = "C:\\legacy\\screen.mp4";
    const assetPath = "C:\\legacy\\library.mp4";
    const overlayPath = "C:\\legacy\\overlay.mp4";
    const projectPosts: Array<{
      id: string;
      snapshot: ProjectSnapshot;
    }> = [];
    installProjectFetch(
      snapshot({
        footageMeta: {
          ...footage(),
          faceCamPath: videoUrl(facePath),
          screenPath: videoUrl(screenPath),
        },
        mediaAssets: [
          videoAsset("asset-legacy", undefined, {
            src: videoUrl(assetPath),
            sourcePath: undefined,
          }),
        ],
        overlays: [
          videoOverlay("overlay-legacy", undefined, {
            src: videoUrl(overlayPath),
            sourcePath: undefined,
          }),
        ],
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    await loadProject();
    await waitFor(() => expect(projectPosts).toHaveLength(1));

    expect(projectPosts[0]).toMatchObject({
      id: "task-6-project",
      snapshot: {
        footageMeta: expect.objectContaining({
          faceCamPath: videoUrl(facePath),
          screenPath: videoUrl(screenPath),
          faceCamSource: expect.objectContaining({
            originalPath: facePath,
            workingPath: facePath,
          }),
          screenSource: expect.objectContaining({
            originalPath: screenPath,
            workingPath: screenPath,
          }),
        }),
        mediaAssets: [
          expect.objectContaining({
            src: videoUrl(assetPath),
            sourcePath: assetPath,
            videoSource: expect.objectContaining({
              originalPath: assetPath,
              workingPath: assetPath,
            }),
          }),
        ],
        overlays: [
          expect.objectContaining({
            src: videoUrl(overlayPath),
            sourcePath: overlayPath,
            videoSource: expect.objectContaining({
              originalPath: overlayPath,
              workingPath: overlayPath,
            }),
          }),
        ],
      },
    });
  });

  test("persists a rebuilt source in an existing media-only project", async () => {
    const originalPath = "C:\\originals\\library.mov";
    const oldWorkingPath = "C:\\masters\\evicted-library.mp4";
    const newWorkingPath = "C:\\masters\\rebuilt-library.mp4";
    const stalePreviewPath = "C:\\preview\\stale-library.mp4";
    const imported = source(originalPath, oldWorkingPath, {
      previewPath: stalePreviewPath,
    });
    const projectPosts: Array<{ id: string; snapshot: ProjectSnapshot }> = [];
    installProjectFetch(
      snapshot({
        clips: [],
        duration: 0,
        footageMeta: null,
        mediaAssets: [videoAsset("asset-only", imported)],
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path === oldWorkingPath) {
          return jsonResponse(
            { error: { code: "MEDIA_PATH_INVALID", message: "missing" } },
            400
          );
        }
        if (path === originalPath) return jsonResponse(inspection("c", "hevc"));
        if (
          url.endsWith("/api/repurpose/compatibility") &&
          init?.method === "POST"
        ) {
          return jsonResponse({
            status: "ready",
            progress: 1,
            workingPath: newWorkingPath,
          });
        }
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    await loadProject();
    await waitFor(() => expect(projectPosts).toHaveLength(1));

    expect(projectPosts[0]).toMatchObject({
      id: "task-6-project",
      snapshot: {
        clips: [],
        footageMeta: null,
        mediaAssets: [
          expect.objectContaining({
            src: videoUrl(newWorkingPath),
            sourcePath: newWorkingPath,
            videoSource: expect.objectContaining({
              originalPath,
              workingPath: newWorkingPath,
            }),
          }),
        ],
      },
    });
    expect(
      projectPosts[0].snapshot.mediaAssets?.[0].videoSource
    ).not.toHaveProperty("previewPath");
  });

  test("persists a normalized source in an existing overlay-only project", async () => {
    const originalPath = "C:\\originals\\overlay.mp4";
    const staleWorkingPath = "C:\\masters\\stale-overlay.mp4";
    const imported = source(originalPath, staleWorkingPath, {
      previewPath: "C:\\preview\\stale-overlay.mp4",
      nativeCompatible: true,
      compatibilityStatus: "native",
    });
    const projectPosts: Array<{ id: string; snapshot: ProjectSnapshot }> = [];
    installProjectFetch(
      snapshot({
        clips: [],
        duration: 0,
        footageMeta: null,
        overlays: [videoOverlay("overlay-only", imported)],
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(inspection());
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    await loadProject();
    await waitFor(() => expect(projectPosts).toHaveLength(1));

    expect(projectPosts[0]).toMatchObject({
      id: "task-6-project",
      snapshot: {
        clips: [],
        footageMeta: null,
        overlays: [
          expect.objectContaining({
            src: videoUrl(originalPath),
            sourcePath: originalPath,
            videoSource: expect.objectContaining({
              originalPath,
              workingPath: originalPath,
              compatibilityStatus: "native",
            }),
          }),
        ],
      },
    });
    expect(projectPosts[0].snapshot.overlays?.[0].videoSource).not.toHaveProperty(
      "previewPath"
    );
  });

  test("does not apply the existing-project catch-up bypass to a provisional media-only project", async () => {
    const projectPosts: unknown[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (
          String(input) === "/api/repurpose/projects" &&
          init?.method === "POST"
        ) {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({
            project: {
              id: "should-not-exist",
              name: "Should not exist",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const rendered = renderHook(() =>
      useProjectPersistence("new-media-only")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    const imported = source("C:\\originals\\library.mp4");
    useRepurposeStore.setState({
      words: [{ text: "Media only", start: 0, end: 1 }],
      mediaAssets: [videoAsset("asset-provisional", imported)],
    });

    expect(projectPosts).toHaveLength(0);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  test("creates a transcript-free project only after both sources and prefers the Screen filename", async () => {
    type CreatePost = ControlledSaveBody & {
      id: string;
      name: string;
      mode?: "create";
    };
    const posts: CreatePost[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url !== "/api/repurpose/projects" || init?.method !== "POST") {
          throw new Error(`Unexpected request: ${url}`);
        }
        const body = JSON.parse(String(init.body)) as CreatePost;
        posts.push(body);
        return jsonResponse({
          project: {
            id: body.id,
            name: body.name,
            createdAt: "2026-08-27T00:00:00.000Z",
            saveRevision: body.saveRevision,
            saveWriterId: body.writerId,
          },
        });
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("new-transcript-free")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    const face = source("C:\\media\\Face Camera.mov");
    const screenSource = source("C:\\media\\screen.mp4", undefined, {
      originalName: "Launch/\u0000 Demo.final.mp4",
    });

    act(() => {
      useRepurposeStore.getState().setFootageMeta({
        ...footage(face),
        screenPath: "",
        screenSource: undefined,
      });
    });
    await act(async () => Promise.resolve());
    expect(posts).toHaveLength(0);

    act(() => {
      useRepurposeStore.getState().setFootageMeta(footage(face, screenSource));
    });
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));

    expect(posts[0]).toMatchObject({
      mode: "create",
      name: "Launch Demo.final",
      snapshot: {
        clips: [{ id: VIDEO_TIMELINE_CLIP_ID, srcEnd: 5, timelineEnd: 5 }],
        duration: 5,
        words: [],
        footageMeta: {
          faceCamSource: { originalName: "Face Camera.mov" },
          screenSource: { originalName: "Launch/\u0000 Demo.final.mp4" },
        },
      },
    });
    expect(posts[0].id).toMatch(/^launch-demo-final-\d{1,2}-[a-z]{3}-\d{2}$/);
    expect(replaceMock).toHaveBeenCalledWith(
      `/repurpose-studio/${posts[0].id}`
    );
    rendered.unmount();
  });

  test("falls back to the Face filename after both sources are ready", async () => {
    const posts: Array<ControlledSaveBody & { id: string; name: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url !== "/api/repurpose/projects" || init?.method !== "POST") {
          throw new Error(`Unexpected request: ${url}`);
        }
        const body = JSON.parse(String(init.body)) as ControlledSaveBody & {
          id: string;
          name: string;
        };
        posts.push(body);
        return jsonResponse({
          project: {
            id: body.id,
            name: body.name,
            createdAt: "2026-08-27T00:00:00.000Z",
            saveRevision: body.saveRevision,
            saveWriterId: body.writerId,
          },
        });
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("new-face-title-fallback")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    const face = source("C:\\media\\Face Camera.mov");
    const screenSource = source("C:\\media\\screen.mp4", undefined, {
      originalName: "\u0000.mp4",
    });

    act(() => {
      useRepurposeStore.getState().setFootageMeta(footage(face, screenSource));
    });
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));

    expect(posts[0].name).toBe("Face Camera");
    expect(posts[0].snapshot.clips[0]?.id).toBe(VIDEO_TIMELINE_CLIP_ID);
    rendered.unmount();
  });

  test("autosaves media-only changes for an existing project without clips or footage", async () => {
    const imagePath = "C:\\media\\still.png";
    const imageSrc = `/api/repurpose/asset?path=${encodeURIComponent(imagePath)}`;
    const imageAsset: MediaAsset = {
      id: "asset-image-only",
      kind: "image",
      name: "Still",
      src: imageSrc,
      sourcePath: imagePath,
      naturalWidth: 1200,
      naturalHeight: 800,
    };
    const imageOverlay: Overlay = {
      id: "overlay-image-only",
      kind: "image",
      src: imageSrc,
      sourcePath: imagePath,
      naturalWidth: 1200,
      naturalHeight: 800,
      timelineStart: 0,
      timelineEnd: 1,
      srcStart: 0,
      srcDuration: 0,
      transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
      zIndex: 0,
      opacity: 1,
    };
    const projectPosts: ControlledSaveBody[] = [];
    installProjectFetch(
      snapshot({
        clips: [],
        duration: 0,
        footageMeta: null,
        mediaAssets: [imageAsset],
        overlays: [imageOverlay],
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          projectPosts.push(body);
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const rendered = await loadProject();

    useRepurposeStore.setState({
      mediaAssets: [{ ...imageAsset, name: "Renamed still" }],
      overlays: [{ ...imageOverlay, opacity: 0.5 }],
    });

    await waitFor(() => expect(projectPosts).toHaveLength(1));
    expect(projectPosts[0].snapshot).toMatchObject({
      clips: [],
      footageMeta: null,
      mediaAssets: [{ id: imageAsset.id, name: "Renamed still" }],
      overlays: [{ id: imageOverlay.id, opacity: 0.5 }],
    });
    rendered.unmount();
  });

  test("autosaves an applied transcript without transient coordination state", async () => {
    const projectPosts: ControlledSaveBody[] = [];
    installProjectFetch(
      snapshot({
        words: [{ text: "old", start: 0, end: 1 }],
        captionsEnabled: false,
        captionBlocks: [],
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          projectPosts.push(body);
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const rendered = await loadProject();
    const appliedWords = [
      { text: "nova", start: 0, end: 0.5 },
      { text: "legenda", start: 0.5, end: 1 },
    ];

    act(() =>
      useRepurposeStore.getState().applyTranscript({
        words: appliedWords,
        mode: "rebuild",
        rebuiltClips: [{ ...clip, id: "transcript-rebuild" }],
      })
    );

    await waitFor(() => expect(projectPosts).toHaveLength(1));
    expect(projectPosts[0].snapshot).toMatchObject({
      clips: [{ id: "transcript-rebuild" }],
      words: appliedWords,
      captionsEnabled: true,
      captionBlocks: [
        expect.objectContaining({
          id: expect.stringMatching(/^transcript-rebuild--cap-/),
          words: appliedWords,
        }),
      ],
    });
    expect(projectPosts[0].snapshot.captionBlocks?.[0]).not.toHaveProperty(
      "textOverride"
    );
    for (const transient of [
      "pendingCandidate",
      "dialogOpen",
      "observerId",
      "progress",
      "cacheKey",
    ]) {
      expect(projectPosts[0].snapshot).not.toHaveProperty(transient);
    }
    rendered.unmount();
  });

  test("saves and reopens attached and detached caption placement with text and style", async () => {
    const words = [
      { text: "first", start: 0, end: 0.5 },
      { text: "second", start: 0.5, end: 1 },
    ];
    let persistedSnapshot = snapshot({
      words,
      captionsEnabled: true,
      captionBlocks: [
        {
          id: "first-caption",
          words: [words[0]],
          start: 0,
          end: 0.5,
          textOverride: ["FIRST"],
          overrideStyle: { fill: "#123456", pinToSplit: true },
        },
        {
          id: "second-caption",
          words: [words[1]],
          start: 0.5,
          end: 1,
          textOverride: ["SECOND"],
          overrideStyle: {
            activeFill: "#abcdef",
            pinToSplit: false,
            positionYPct: 0.76,
          },
        },
      ],
    });
    let savedSnapshot: ProjectSnapshot | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/repurpose/projects/") && !init?.method) {
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              snapshot: persistedSnapshot,
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          savedSnapshot = body.snapshot;
          persistedSnapshot = body.snapshot;
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const firstMount = await loadProject();

    act(() => {
      useRepurposeStore
        .getState()
        .detachCaptionBlock("first-caption", 0.34);
      useRepurposeStore.getState().attachCaptionBlock("second-caption");
    });

    await waitFor(() => expect(savedSnapshot).not.toBeNull());
    expect(savedSnapshot!.captionBlocks).toEqual([
      expect.objectContaining({
        textOverride: ["FIRST"],
        overrideStyle: {
          fill: "#123456",
          pinToSplit: false,
          positionYPct: 0.34,
        },
      }),
      expect.objectContaining({
        textOverride: ["SECOND"],
        overrideStyle: { activeFill: "#abcdef", pinToSplit: true },
      }),
    ]);
    firstMount.unmount();
    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);

    const reopened = await loadProject();

    expect(useRepurposeStore.getState().captionBlocks).toEqual(
      savedSnapshot!.captionBlocks
    );
    reopened.unmount();
  });

  test("reopens the exact serialized snapshot produced after applying a transcript", async () => {
    const oldWords = [{ text: "old", start: 0, end: 1 }];
    let persistedSnapshot = snapshot({
      words: oldWords,
      captionsEnabled: false,
      captionBlocks: [
        {
          id: "stale-block",
          words: oldWords,
          start: 0,
          end: 1,
          textOverride: ["stale"],
          overrideStyle: { fill: "#ff0000" },
        },
      ],
    });
    let serializedSnapshot: ProjectSnapshot | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/repurpose/projects/") && !init?.method) {
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              snapshot: persistedSnapshot,
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          serializedSnapshot = body.snapshot;
          persistedSnapshot = body.snapshot;
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const firstMount = await loadProject();
    const appliedWords = [
      { text: "nova", start: 0, end: 0.5 },
      { text: "legenda", start: 0.5, end: 1 },
    ];

    act(() =>
      useRepurposeStore.getState().applyTranscript({
        words: appliedWords,
        mode: "rebuild",
        rebuiltClips: [{ ...clip, id: "round-trip-transcript" }],
      })
    );
    await waitFor(() => expect(serializedSnapshot).not.toBeNull());
    const exactSavedSnapshot = serializedSnapshot!;
    expect(exactSavedSnapshot.captionBlocks?.[0]).not.toHaveProperty("textOverride");
    expect(exactSavedSnapshot.captionBlocks?.[0]).not.toHaveProperty("overrideStyle");
    firstMount.unmount();
    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);

    const reopened = await loadProject();

    expect(useRepurposeStore.getState()).toMatchObject({
      clips: [
        expect.objectContaining({
          id: "round-trip-transcript",
          srcStart: 0,
          srcEnd: 5,
        }),
      ],
      words: appliedWords,
      captionsEnabled: true,
      captionBlocks: exactSavedSnapshot.captionBlocks,
    });
    reopened.unmount();
  });

  test("flushes project A's captured debounce entry when the route switches to project B", async () => {
    const beaconBodies: Array<{
      id: string;
      baseRevision: number;
      saveRevision: number;
      snapshot: ProjectSnapshot;
    }> = [];
    const sendBeaconMock = vi.fn(
      (_url: string | URL, data?: BodyInit | null): boolean => {
        if (!(data instanceof Blob)) throw new Error("Expected a Blob beacon body");
        void blobText(data).then((text) => beaconBodies.push(JSON.parse(text)));
        return true;
      }
    );
    vi.stubGlobal("navigator", { sendBeacon: sendBeaconMock });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/project-a")) {
          return jsonResponse({
            project: {
              id: "project-a",
              name: "Project A",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 4,
              saveWriterId: "writer-otheraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.4 }),
            },
          });
        }
        if (url.endsWith("/project-b")) {
          return jsonResponse({
            project: {
              id: "project-b",
              name: "Project B",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-otherbbb",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.2 }),
            },
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "unavailable" });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "project-a" } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    const projectAEpoch = useRepurposeStore.getState().projectEpoch;

    useRepurposeStore.setState({ splitRatio: 0.7 });
    rendered.rerender({ projectId: "project-b" });

    await waitFor(() => expect(beaconBodies).toHaveLength(1));
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(beaconBodies[0]).toMatchObject({
      id: "project-a",
      baseRevision: 4,
      saveRevision: 5,
      snapshot: { splitRatio: 0.7 },
    });
    expect(beaconBodies[0].snapshot).not.toHaveProperty("saveRevision");
    expect(beaconBodies[0].snapshot).not.toHaveProperty("projectEpoch");
    expect(beaconBodies[0].snapshot).not.toMatchObject({ splitRatio: 0.2 });
    expect(useRepurposeStore.getState().projectEpoch).toBeGreaterThan(
      projectAEpoch
    );
  });

  test.each(["queued-first", "newest-first"] as const)(
    "keeps rebuilt media identity when stale A hydrates and %s arrives",
    async (arrivalOrder) => {
      const projectA = `media-a-${arrivalOrder}`;
      const projectB = `media-b-${arrivalOrder}`;
      const originalPath = `C:\\originals\\${arrivalOrder}.mov`;
      const oldSource = source(originalPath, `C:\\masters\\old-${arrivalOrder}.mp4`, {
        previewPath: `C:\\preview\\old-${arrivalOrder}.mp4`,
      });
      const rebuiltSource = source(
        originalPath,
        `C:\\masters\\rebuilt-${arrivalOrder}.mp4`,
        { previewPath: undefined }
      );
      const staleSnapshot = snapshot({
        footageMeta: footage(oldSource, oldSource),
        splitRatio: 0.5,
      });
      const posts: ControlledSaveBody[] = [];
      const queuedBeacons: ControlledSaveBody[] = [];
      const persistedControl: PersistedSaveControl = {
        saveRevision: 5,
        saveWriterId: "writer-serveraaa",
        saveWriterBaseRevision: 0,
      };
      let persistedSnapshot = staleSnapshot;
      let aLoads = 0;
      const sendBeaconMock = vi.fn(
        (_url: string | URL, data?: BodyInit | null): boolean => {
          if (!(data instanceof Blob)) {
            throw new Error("Expected a Blob beacon body");
          }
          void blobText(data).then((text) => queuedBeacons.push(JSON.parse(text)));
          return true;
        }
      );
      vi.stubGlobal("navigator", { sendBeacon: sendBeaconMock });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = String(input);
          if (url.endsWith(`/${projectA}`)) {
            aLoads++;
            return jsonResponse({
              project: {
                id: projectA,
                name: "Project A",
                createdAt: "2026-08-24T00:00:00.000Z",
                saveRevision: 5,
                saveWriterId:
                  aLoads === 1 ? "writer-serveraaa" : posts[0].writerId,
                snapshot: staleSnapshot,
              },
            });
          }
          if (url.endsWith(`/${projectB}`)) {
            return jsonResponse({
              project: {
                id: projectB,
                name: "Project B",
                createdAt: "2026-08-24T00:00:00.000Z",
                saveRevision: 1,
                saveWriterId: "writer-serverbbb",
                snapshot: snapshot({ footageMeta: null, splitRatio: 0.2 }),
              },
            });
          }
          if (url === "/api/repurpose/projects" && init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as ControlledSaveBody;
            posts.push(body);
            const accepted = acceptControlledSave(persistedControl, body);
            if (accepted) persistedSnapshot = body.snapshot;
            const sameWriterStale =
              persistedControl.saveWriterId === body.writerId &&
              persistedControl.saveRevision >= body.saveRevision;
            return jsonResponse(
              accepted
                ? {
                    project: {
                      id: projectA,
                      name: "Project A",
                      createdAt: "2026-08-24T00:00:00.000Z",
                      ...persistedControl,
                    },
                  }
                : {
                    error: {
                      code: "PROJECT_SAVE_CONFLICT",
                      reason: sameWriterStale
                        ? "SUPERSEDED_SAME_WRITER"
                        : "BASE_MISMATCH",
                    },
                    project: {
                      id: projectA,
                      saveRevision: persistedControl.saveRevision,
                      saveWriterId: persistedControl.saveWriterId,
                    },
                  },
              accepted ? 200 : 409
            );
          }
          const path = mediaPath(input);
          if (path) return jsonResponse(oldSource.inspection);
          if (url.startsWith("/api/repurpose/proxy?")) {
            return jsonResponse({ status: init?.method === "POST" ? "building" : "ready" });
          }
          throw new Error(`Unexpected request: ${url}`);
        })
      );
      const rendered = renderHook(
        ({ projectId }) => useProjectPersistence(projectId),
        { initialProps: { projectId: projectA } }
      );
      await waitFor(() => expect(rendered.result.current.ready).toBe(true));

      useRepurposeStore
        .getState()
        .setFootageMeta(footage(rebuiltSource, rebuiltSource));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toMatchObject({ baseRevision: 5, saveRevision: 6 });

      useRepurposeStore.setState({ splitRatio: 0.7 });
      rendered.rerender({ projectId: projectB });
      await waitFor(() => expect(queuedBeacons).toHaveLength(1));
      expect(queuedBeacons[0]).toMatchObject({
        writerId: posts[0].writerId,
        baseRevision: 6,
        saveRevision: 7,
        snapshot: {
          footageMeta: {
            faceCamSource: { workingPath: rebuiltSource.workingPath },
          },
        },
      });
      expect(
        queuedBeacons[0].snapshot.footageMeta?.faceCamSource
      ).not.toHaveProperty("previewPath");
      await waitFor(() => expect(rendered.result.current.ready).toBe(true));
      if (arrivalOrder === "queued-first") {
        expect(acceptControlledSave(persistedControl, queuedBeacons[0])).toBe(true);
        persistedSnapshot = queuedBeacons[0].snapshot;
      }

      rendered.rerender({ projectId: projectA });
      await waitFor(() => expect(rendered.result.current.ready).toBe(true));
      expect(
        useRepurposeStore.getState().footageMeta?.faceCamSource
      ).toMatchObject({ workingPath: rebuiltSource.workingPath });
      expect(
        useRepurposeStore.getState().footageMeta?.faceCamSource
      ).not.toHaveProperty("previewPath");
      useRepurposeStore.setState({ splitRatio: 0.8 });
      await waitFor(() => expect(posts).toHaveLength(3));

      expect(posts[2]).toMatchObject({
        writerId: posts[0].writerId,
        saveRevision: 8,
        snapshot: {
          footageMeta: {
            faceCamSource: { workingPath: rebuiltSource.workingPath },
          },
        },
      });
      expect(posts[2].snapshot.footageMeta?.faceCamSource).not.toHaveProperty(
        "previewPath"
      );
      if (arrivalOrder === "newest-first") {
        expect(acceptControlledSave(persistedControl, queuedBeacons[0])).toBe(false);
      }
      expect(persistedControl.saveRevision).toBe(8);
      expect(persistedSnapshot.footageMeta?.faceCamSource).toMatchObject({
        workingPath: rebuiltSource.workingPath,
      });
      expect(persistedSnapshot.footageMeta?.faceCamSource).not.toHaveProperty(
        "previewPath"
      );
    }
  );

  test("uses a different writer's server snapshot before surfacing a durable pending conflict", async () => {
    const projectA = "different-writer-cache-a";
    const projectB = "different-writer-cache-b";
    const originalPath = "C:\\originals\\different-writer.mov";
    const oldSource = source(originalPath, "C:\\masters\\old-writer.mp4", {
      previewPath: "C:\\preview\\old-writer.mp4",
    });
    const localSource = source(originalPath, "C:\\masters\\local-writer.mp4", {
      previewPath: undefined,
    });
    const serverSource = source(originalPath, "C:\\masters\\server-writer.mp4", {
      previewPath: "C:\\preview\\server-writer.mp4",
    });
    const posts: ControlledSaveBody[] = [];
    let aLoads = 0;
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith(`/${projectA}`)) {
          aLoads++;
          return jsonResponse({
            project: {
              id: projectA,
              name: "Different writer A",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: aLoads === 1 ? 5 : 8,
              saveWriterId:
                aLoads === 1 ? "writer-serveraaa" : "writer-serverbbb",
              snapshot: snapshot({
                footageMeta:
                  aLoads === 1
                    ? footage(oldSource, oldSource)
                    : footage(serverSource, serverSource),
              }),
            },
          });
        }
        if (url.endsWith(`/${projectB}`)) {
          return jsonResponse({
            project: {
              id: projectB,
              name: "Different writer B",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 1,
              saveWriterId: "writer-serverbbb",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          if (posts.length === 1) throw new TypeError("network unavailable");
          if (body.baseRevision === 5) {
            return jsonResponse(
              {
                error: { code: "PROJECT_SAVE_CONFLICT", reason: "BASE_MISMATCH" },
                project: {
                  id: projectA,
                  saveRevision: 8,
                  saveWriterId: "writer-serverbbb",
                },
              },
              409
            );
          }
          return jsonResponse({
            project: {
              id: projectA,
              name: "Different writer A",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(oldSource.inspection);
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: init?.method === "POST" ? "building" : "ready" });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: projectA } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.getState().setFootageMeta(footage(localSource, localSource));
    await waitFor(() => expect(posts).toHaveLength(1));
    useRepurposeStore.setState({ splitRatio: 0.7 });
    rendered.rerender({ projectId: projectB });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    rendered.rerender({ projectId: projectA });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(useRepurposeStore.getState().footageMeta?.faceCamSource).toMatchObject({
      workingPath: serverSource.workingPath,
      previewPath: serverSource.previewPath,
    });
    expect(rendered.result.current.saveConflict).toMatchObject({
      projectId: projectA,
      reason: "BASE_MISMATCH",
      serverRevision: 8,
      serverWriterId: "writer-serverbbb",
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      baseRevision: 5,
      saveRevision: 7,
      snapshot: {
        footageMeta: {
          faceCamSource: {
            workingPath: localSource.workingPath,
          },
        },
      },
    });
  });

  test("sends writer control and stops autosave retries after an observable conflict", async () => {
    const projectPosts: Array<Record<string, unknown>> = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/conflicted-project")) {
          return jsonResponse({
            project: {
              id: "conflicted-project",
              name: "Conflicted project",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 7,
              saveWriterId: "writer-otheraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse(
            {
              error: { code: "PROJECT_SAVE_CONFLICT" },
              project: {
                id: "conflicted-project",
                saveRevision: 8,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("conflicted-project")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ splitRatio: 0.7 });
      await vi.advanceTimersByTimeAsync(501);

      expect(projectPosts).toHaveLength(1);
      expect(projectPosts[0]).toMatchObject({
        writerId: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
        baseRevision: 7,
        saveRevision: 8,
        snapshot: { splitRatio: 0.7 },
      });
      expect(projectPosts[0].snapshot).not.toHaveProperty("saveRevision");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("PROJECT_SAVE_CONFLICT"),
        expect.objectContaining({ projectId: "conflicted-project" })
      );

      useRepurposeStore.setState({ splitRatio: 0.8 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(projectPosts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  test("blocks a malformed same-writer conflict instead of treating it as superseded", async () => {
    const posts: ControlledSaveBody[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/same-writer-malformed-conflict")) {
          return jsonResponse({
            project: {
              id: "same-writer-malformed-conflict",
              name: "Malformed conflict",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 5,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse(
            {
              error: {
                code: "PROJECT_SAVE_CONFLICT",
                reason: "BASE_MISMATCH",
              },
              project: {
                id: "same-writer-malformed-conflict",
                saveRevision: body.saveRevision,
                saveWriterId: body.writerId,
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("same-writer-malformed-conflict")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ splitRatio: 0.6 });
      await vi.advanceTimersByTimeAsync(501);
      expect(posts).toHaveLength(1);

      useRepurposeStore.setState({ splitRatio: 0.7 });
      await vi.advanceTimersByTimeAsync(501);
      expect(posts).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("PROJECT_SAVE_CONFLICT"),
        expect.objectContaining({
          projectId: "same-writer-malformed-conflict",
        })
      );
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  test("retries a failed takeover with a higher revision from the same acknowledged base", async () => {
    const posts: ControlledSaveBody[] = [];
    const persistedControl: PersistedSaveControl = {
      saveRevision: 5,
      saveWriterId: "writer-serveraaa",
      saveWriterBaseRevision: 0,
    };
    let persistedSnapshot = snapshot({ footageMeta: null, splitRatio: 0.5 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/takeover-retry")) {
          return jsonResponse({
            project: {
              id: "takeover-retry",
              name: "Takeover retry",
              createdAt: "2026-08-24T00:00:00.000Z",
              ...persistedControl,
              snapshot: persistedSnapshot,
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          if (posts.length === 1) throw new TypeError("network unavailable");
          const accepted = acceptControlledSave(persistedControl, body);
          if (accepted) persistedSnapshot = body.snapshot;
          return jsonResponse(
            accepted
              ? {
                  project: {
                    id: "takeover-retry",
                    name: "Takeover retry",
                    createdAt: "2026-08-24T00:00:00.000Z",
                    ...persistedControl,
                  },
                }
              : {
                  error: { code: "PROJECT_SAVE_CONFLICT" },
                  project: {
                    id: "takeover-retry",
                    saveRevision: persistedControl.saveRevision,
                    saveWriterId: persistedControl.saveWriterId,
                  },
                },
            accepted ? 200 : 409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence("takeover-retry"));
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ splitRatio: 0.6 });
      await vi.advanceTimersByTimeAsync(501);
      expect(posts).toHaveLength(1);

      useRepurposeStore.setState({ splitRatio: 0.7 });
      await vi.advanceTimersByTimeAsync(501);

      expect(posts).toHaveLength(2);
      expect(posts[0]).toMatchObject({ baseRevision: 5, saveRevision: 6 });
      expect(posts[1]).toMatchObject({
        writerId: posts[0].writerId,
        baseRevision: 5,
        saveRevision: 7,
        snapshot: { splitRatio: 0.7 },
      });
      expect(persistedControl).toMatchObject({
        saveRevision: 7,
        saveWriterId: posts[0].writerId,
        saveWriterBaseRevision: 5,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries an ambiguously committed create under one idempotency key", async () => {
    type CreatePost = ControlledSaveBody & {
      id: string;
      name: string;
      mode?: "create";
      createRequestId?: string;
    };
    interface StoredProject {
      id: string;
      name: string;
      createRequestId: string | null;
      createWriterId: string;
      control: PersistedSaveControl;
      snapshot: ProjectSnapshot;
    }
    const posts: CreatePost[] = [];
    const projects: StoredProject[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as CreatePost;
          posts.push(body);
          let project =
            body.mode === "create" && body.createRequestId
              ? projects.find(
                  (item) => item.createRequestId === body.createRequestId
                )
              : projects.find((item) => item.id === body.id);
          if (!project) {
            const id = projects.some((item) => item.id === body.id)
              ? `${body.id}-2`
              : body.id;
            project = {
              id,
              name: body.name,
              createRequestId: body.createRequestId ?? null,
              createWriterId: body.writerId,
              control: {
                saveRevision: 0,
                saveWriterId: null,
                saveWriterBaseRevision: 0,
              },
              snapshot: body.snapshot,
            };
            projects.push(project);
          }
          const sameCreateWriter =
            body.mode !== "create" || project.createWriterId === body.writerId;
          const accepted =
            sameCreateWriter && acceptControlledSave(project.control, body);
          if (accepted) project.snapshot = body.snapshot;
          if (posts.length === 1) {
            expect(accepted).toBe(true);
            throw new TypeError("response lost after commit");
          }
          return jsonResponse(
            accepted
              ? {
                  project: {
                    id: project.id,
                    name: project.name,
                    createdAt: "2026-08-24T00:00:00.000Z",
                    ...project.control,
                  },
                }
              : {
                  error: { code: "PROJECT_SAVE_CONFLICT" },
                  project: {
                    id: project.id,
                    saveRevision: project.control.saveRevision,
                    saveWriterId: project.control.saveWriterId,
                  },
                },
            accepted ? 200 : 409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence("new-create-retry"));
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({
      clips: [clip],
      duration: 5,
      words: [{ text: "Create retry", start: 0, end: 1 }],
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    useRepurposeStore.setState({
      splitRatio: 0.7,
      words: [{ text: "Renamed retry", start: 0, end: 1 }],
    });

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[0]).toMatchObject({
      mode: "create",
      createRequestId: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
      baseRevision: 0,
      saveRevision: 1,
    });
    expect(posts[1]).toMatchObject({
      mode: "create",
      createRequestId: posts[0].createRequestId,
      writerId: posts[0].writerId,
      baseRevision: 0,
      saveRevision: 2,
      snapshot: { splitRatio: 0.7 },
    });
    expect(posts[1].id).not.toBe(posts[0].id);
    expect(posts[0].snapshot).not.toHaveProperty("createRequestId");
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: posts[0].id,
      createRequestId: posts[0].createRequestId,
      createWriterId: posts[0].writerId,
      snapshot: { splitRatio: 0.7 },
    });
    expect(projects[0].control.saveRevision).toBeGreaterThanOrEqual(2);
    expect(replaceMock).toHaveBeenCalledWith(
      `/repurpose-studio/${posts[0].id}`
    );
  });

  test("automatically retries a failed create with backoff under one idempotency key", async () => {
    type CreatePost = ControlledSaveBody & {
      id: string;
      name: string;
      mode?: "create";
      createRequestId?: string;
    };
    const posts: CreatePost[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url !== "/api/repurpose/projects" || init?.method !== "POST") {
          throw new Error(`Unexpected request: ${url}`);
        }
        const body = JSON.parse(String(init.body)) as CreatePost;
        posts.push(body);
        if (posts.length === 1) throw new TypeError("offline");
        if (posts.length === 2) {
          return jsonResponse({ error: "temporarily unavailable" }, 503);
        }
        return jsonResponse({
          project: {
            id: body.id,
            name: body.name,
            createdAt: "2026-08-25T00:00:00.000Z",
            saveRevision: body.saveRevision,
            saveWriterId: body.writerId,
          },
        });
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("new-automatic-create-retry")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({
        clips: [clip],
        duration: 5,
        words: [{ text: "Automatic create retry", start: 0, end: 1 }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(posts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(posts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(posts).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(2_001);
      const createPosts = posts.filter((post) => post.mode === "create");
      expect(createPosts).toHaveLength(3);
      expect(createPosts.map((post) => post.createRequestId)).toEqual([
        createPosts[0].createRequestId,
        createPosts[0].createRequestId,
        createPosts[0].createRequestId,
      ]);
      expect(createPosts.map((post) => post.writerId)).toEqual([
        createPosts[0].writerId,
        createPosts[0].writerId,
        createPosts[0].writerId,
      ]);
      expect(replaceMock).toHaveBeenCalledTimes(1);

      await act(async () => Promise.resolve());
      rendered.unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(posts.filter((post) => post.mode === "create")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not start an automatic retry loop after a create conflict", async () => {
    const posts: ControlledSaveBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse(
            {
              error: {
                code: "PROJECT_SAVE_CONFLICT",
                reason: "CREATE_WRITER_MISMATCH",
              },
              project: {
                id: "create-conflict",
                saveRevision: 1,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("new-create-conflict")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({
        clips: [clip],
        duration: 5,
        words: [{ text: "Create conflict", start: 0, end: 1 }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(posts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(posts).toHaveLength(1);
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a provisional create until a title becomes derivable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Create should remain deferred without a title");
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = renderHook(() =>
      useProjectPersistence("new-no-title-retry")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ clips: [clip], words: [] });
      await act(async () => Promise.resolve());

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("gives fresh browser realms distinct writer IDs despite copied session storage", async () => {
    const hostWindow = window;
    const createRealm = (): Window => {
      return {
        addEventListener: hostWindow.addEventListener.bind(hostWindow),
        removeEventListener: hostWindow.removeEventListener.bind(hostWindow),
        crypto: hostWindow.crypto,
        document: hostWindow.document,
        sessionStorage: hostWindow.sessionStorage,
      } as unknown as Window;
    };
    const firstRealm = createRealm();
    const secondRealm = createRealm();
    const posts: ControlledSaveBody[] = [];
    hostWindow.sessionStorage.setItem(
      "repurpose-studio-save-writer",
      "writer-copied-storage"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.startsWith("/api/repurpose/projects/")) {
          const id = url.split("/").at(-1) ?? "realm";
          return jsonResponse({
            project: {
              id,
              name: id,
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 0,
              saveWriterId: null,
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody & {
            id: string;
            name: string;
          };
          posts.push(body);
          return jsonResponse({
            project: {
              id: body.id,
              name: body.name,
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", firstRealm);
      const first = renderHook(() => useProjectPersistence("realm-a"));
      await vi.waitFor(() => expect(first.result.current.ready).toBe(true));
      useRepurposeStore.setState({ splitRatio: 0.6 });
      await vi.advanceTimersByTimeAsync(501);
      expect(posts).toHaveLength(1);
      first.unmount();

      useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
      const sameRealm = renderHook(() =>
        useProjectPersistence("realm-a-again")
      );
      await vi.waitFor(() => expect(sameRealm.result.current.ready).toBe(true));
      useRepurposeStore.setState({ splitRatio: 0.65 });
      await vi.advanceTimersByTimeAsync(501);
      expect(posts).toHaveLength(2);
      expect(posts[1].writerId).toBe(posts[0].writerId);
      sameRealm.unmount();

      useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
      vi.stubGlobal("window", secondRealm);
      const second = renderHook(() => useProjectPersistence("realm-b"));
      await vi.waitFor(() => expect(second.result.current.ready).toBe(true));
      useRepurposeStore.setState({ splitRatio: 0.7 });
      await vi.advanceTimersByTimeAsync(501);

      expect(posts).toHaveLength(3);
      expect(posts[0].writerId).not.toBe("writer-copied-storage");
      expect(posts[2].writerId).not.toBe("writer-copied-storage");
      expect(posts[2].writerId).not.toBe(posts[0].writerId);
      second.unmount();
    } finally {
      vi.useRealTimers();
      hostWindow.sessionStorage.removeItem("repurpose-studio-save-writer");
      vi.stubGlobal("window", hostWindow);
    }
  });

  test("replays the same create attempt after reloading a provisional new URL", async () => {
    type CreatePost = ControlledSaveBody & {
      id: string;
      name: string;
      mode?: "create";
      createRequestId?: string;
    };
    const hostWindow = window;
    const createRealm = (): Window =>
      ({
        addEventListener: hostWindow.addEventListener.bind(hostWindow),
        removeEventListener: hostWindow.removeEventListener.bind(hostWindow),
        crypto: hostWindow.crypto,
        document: hostWindow.document,
        sessionStorage: hostWindow.sessionStorage,
      }) as unknown as Window;
    const firstRealm = createRealm();
    const secondRealm = createRealm();
    const posts: CreatePost[] = [];
    let committed: CreatePost | null = null;
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as CreatePost;
          posts.push(body);
          if (!committed) {
            committed = body;
            throw new TypeError("response lost after create commit");
          }
          const exactReplay =
            body.createRequestId === committed.createRequestId &&
            body.writerId === committed.writerId &&
            body.saveRevision === committed.saveRevision;
          if (!exactReplay) {
            return jsonResponse(
              {
                error: {
                  code: "PROJECT_SAVE_CONFLICT",
                  reason: "CREATE_WRITER_MISMATCH",
                },
                project: {
                  id: committed.id,
                  saveRevision: committed.saveRevision,
                  saveWriterId: committed.writerId,
                },
              },
              409
            );
          }
          return jsonResponse({
            project: {
              id: committed.id,
              name: committed.name,
              createdAt: "2026-08-25T00:00:00.000Z",
              saveRevision: committed.saveRevision,
              saveWriterId: committed.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    try {
      vi.stubGlobal("window", firstRealm);
      const first = renderHook(() =>
        useProjectPersistence("new-stable-create")
      );
      await waitFor(() => expect(first.result.current.ready).toBe(true));
      useRepurposeStore.setState({
        clips: [clip],
        duration: 5,
        words: [{ text: "Stable create", start: 0, end: 1 }],
      });
      await waitFor(() => expect(posts).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      first.unmount();

      useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
      vi.stubGlobal("window", secondRealm);
      const second = renderHook(() =>
        useProjectPersistence("new-stable-create")
      );
      await waitFor(() => expect(second.result.current.ready).toBe(true));
      useRepurposeStore.setState({
        clips: [clip],
        duration: 5,
        words: [{ text: "Stable create", start: 0, end: 1 }],
      });
      await waitFor(() => expect(posts).toHaveLength(2));
      await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));

      expect(posts[1]).toMatchObject({
        mode: "create",
        createRequestId: posts[0].createRequestId,
        writerId: posts[0].writerId,
        baseRevision: posts[0].baseRevision,
        saveRevision: posts[0].saveRevision,
      });
      second.unmount();
    } finally {
      vi.stubGlobal("window", hostWindow);
    }
  });

  test("ignores an abandoned create response after a real project finishes loading", async () => {
    const posts: Array<
      ControlledSaveBody & { id: string; name: string; mode?: "create" }
    > = [];
    let releaseCreate!: (response: Response) => void;
    const deferredCreate = new Promise<Response>((resolve) => {
      releaseCreate = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/project-b")) {
          return jsonResponse({
            project: {
              id: "project-b",
              name: "Project B",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 3,
              saveWriterId: "writer-serverbbb",
              snapshot: snapshot({
                footageMeta: null,
                splitRatio: 0.2,
                words: [{ text: "Project B", start: 0, end: 1 }],
              }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody & {
            id: string;
            name: string;
            mode?: "create";
          };
          posts.push(body);
          if (posts.length === 1) return deferredCreate;
          return jsonResponse({
            project: {
              id: body.id,
              name: body.name,
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "new-abandoned-create" } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    useRepurposeStore.setState({
      clips: [clip],
      duration: 5,
      words: [{ text: "Project A", start: 0, end: 1 }],
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].mode).toBe("create");

    rendered.rerender({ projectId: "project-b" });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(useRepurposeStore.getState()).toMatchObject({
      splitRatio: 0.2,
      words: [{ text: "Project B", start: 0, end: 1 }],
    });

    releaseCreate(
      jsonResponse({
        project: {
          id: "created-project-a",
          name: "Project A",
          createdAt: "2026-08-24T00:00:00.000Z",
          saveRevision: posts[0].saveRevision,
          saveWriterId: posts[0].writerId,
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replaceMock).not.toHaveBeenCalled();
    expect(rendered.result.current.projectName).toBe("Project B");
    expect(useRepurposeStore.getState()).toMatchObject({
      splitRatio: 0.2,
      words: [{ text: "Project B", start: 0, end: 1 }],
    });
    expect(posts).toHaveLength(1);

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ splitRatio: 0.8 });
      await vi.advanceTimersByTimeAsync(501);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toMatchObject({
        id: "project-b",
        baseRevision: 3,
        saveRevision: 4,
        snapshot: {
          splitRatio: 0.8,
          words: [{ text: "Project B", start: 0, end: 1 }],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("ignores a deferred create response after the persistence hook unmounts", async () => {
    const posts: Array<
      ControlledSaveBody & { id: string; name: string; mode?: "create" }
    > = [];
    let releaseCreate!: (response: Response) => void;
    const deferredCreate = new Promise<Response>((resolve) => {
      releaseCreate = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody & {
            id: string;
            name: string;
            mode?: "create";
          };
          posts.push(body);
          if (posts.length === 1) return deferredCreate;
          return jsonResponse({
            project: {
              id: body.id,
              name: body.name,
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(
      () => useProjectPersistence("new-unmounted-create"),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>{children}</StrictMode>
        ),
      }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    useRepurposeStore.setState({
      clips: [clip],
      duration: 5,
      words: [{ text: "Project A", start: 0, end: 1 }],
    });
    await waitFor(() => expect(posts).toHaveLength(1));

    rendered.unmount();
    useRepurposeStore.setState({
      splitRatio: 0.2,
      words: [{ text: "Hub state", start: 0, end: 1 }],
    });
    releaseCreate(
      jsonResponse({
        project: {
          id: "created-after-unmount",
          name: "Project A",
          createdAt: "2026-08-24T00:00:00.000Z",
          saveRevision: posts[0].saveRevision,
          saveWriterId: posts[0].writerId,
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replaceMock).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(useRepurposeStore.getState()).toMatchObject({
      splitRatio: 0.2,
      words: [{ text: "Hub state", start: 0, end: 1 }],
    });
  });

  test("does not continue a catch-up save loop after flushing the captured route save", async () => {
    const face = source(
      "C:\\originals\\face.mp4",
      "C:\\masters\\stale-face.mp4",
      { nativeCompatible: true, compatibilityStatus: "native" }
    );
    const screen = source("C:\\originals\\screen.mp4");
    const projectPosts: Array<{ id: string; snapshot: ProjectSnapshot }> = [];
    let releaseFirstSave!: (response: Response) => void;
    const firstSave = new Promise<Response>((resolve) => {
      releaseFirstSave = resolve;
    });
    installProjectFetch(
      snapshot({ footageMeta: footage(face, screen) }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          if (projectPosts.length === 1) return firstSave;
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "task-6-project" } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    await waitFor(() => expect(projectPosts).toHaveLength(1));

    useRepurposeStore.setState({ splitRatio: 0.6 });
    rendered.rerender({ projectId: "new-reset" });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    await waitFor(() => expect(projectPosts).toHaveLength(2));
    vi.useFakeTimers();
    try {
      releaseFirstSave(
        jsonResponse({
          project: {
            id: "task-6-project",
            name: "Task 6 project",
            createdAt: "2026-08-24T00:00:00.000Z",
          },
        })
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(projectPosts).toHaveLength(2);
      expect(projectPosts[0].id).toBe("task-6-project");
      expect(projectPosts[0].snapshot.footageMeta?.faceCamPath).toBe(
        videoUrl(face.originalPath)
      );
      expect(projectPosts[1]).toMatchObject({
        id: "task-6-project",
        snapshot: { splitRatio: 0.6 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("prevents an older in-flight POST from overwriting a newer beacon after a route switch", async () => {
    const originalPath = "C:\\originals\\face.mp4";
    const staleWorkingPath = "C:\\masters\\stale-face.mp4";
    const face = source(originalPath, staleWorkingPath, {
      nativeCompatible: true,
      compatibilityStatus: "native",
    });
    const screen = source("C:\\originals\\screen.mp4");
    const fetchPosts: Array<{
      writerId: string;
      baseRevision: number;
      saveRevision: number;
      snapshot: ProjectSnapshot;
    }> = [];
    const persistedControl: PersistedSaveControl = {
      saveRevision: 0,
      saveWriterId: null,
      saveWriterBaseRevision: 0,
    };
    let persistedSnapshot = snapshot({ footageMeta: footage(face, screen) });
    const applySave = (body: ControlledSaveBody): boolean => {
      if (acceptControlledSave(persistedControl, body)) {
        persistedSnapshot = body.snapshot;
        return true;
      }
      return false;
    };
    let releaseFirstPost!: () => void;
    let firstPostApplied!: () => void;
    const firstApplied = new Promise<void>((resolve) => {
      firstPostApplied = resolve;
    });
    const sendBeaconMock = vi.fn(
      (_url: string | URL, data?: BodyInit | null): boolean => {
        if (!(data instanceof Blob)) throw new Error("Expected a Blob beacon body");
        void blobText(data).then((text) => {
          applySave(JSON.parse(text));
          beaconApplied();
        });
        return true;
      }
    );
    let beaconApplied!: () => void;
    const beaconDone = new Promise<void>((resolve) => {
      beaconApplied = resolve;
    });
    vi.stubGlobal("navigator", { sendBeacon: sendBeaconMock });
    installProjectFetch(
      snapshot({ footageMeta: footage(face, screen) }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            writerId: string;
            baseRevision: number;
            saveRevision: number;
            snapshot: ProjectSnapshot;
          };
          fetchPosts.push(body);
          return new Promise<Response>((resolve) => {
            releaseFirstPost = () => {
              const accepted = applySave(body);
              resolve(
                jsonResponse(
                  accepted
                    ? {
                        project: {
                          id: "task-6-project",
                          name: "Task 6 project",
                          createdAt: "2026-08-24T00:00:00.000Z",
                          saveRevision: body.saveRevision,
                          saveWriterId: body.writerId,
                        },
                      }
                    : {
                        error: {
                          code: "PROJECT_SAVE_CONFLICT",
                          reason: "SUPERSEDED_SAME_WRITER",
                        },
                        project: {
                          id: "task-6-project",
                          saveRevision: persistedControl.saveRevision,
                          saveWriterId: persistedControl.saveWriterId,
                        },
                      },
                  accepted ? 200 : 409
                )
              );
              firstPostApplied();
            };
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(inspection());
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "task-6-project" } }
    );
    await waitFor(() => expect(fetchPosts).toHaveLength(1));

    useRepurposeStore.setState({ splitRatio: 0.7 });
    window.dispatchEvent(new Event("pagehide"));
    await beaconDone;
    rendered.rerender({ projectId: "new-after-beacon" });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    releaseFirstPost();
    await firstApplied;

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(fetchPosts).toHaveLength(1);
    expect(fetchPosts[0]).toMatchObject({
      baseRevision: 0,
      saveRevision: expect.any(Number),
    });
    expect(fetchPosts[0].snapshot).not.toHaveProperty("saveRevision");
    const beaconBody = JSON.parse(
      await blobText(sendBeaconMock.mock.calls[0][1] as Blob)
    ) as {
      writerId: string;
      baseRevision: number;
      saveRevision: number;
      snapshot: ProjectSnapshot;
    };
    expect(beaconBody).toMatchObject({
      writerId: fetchPosts[0].writerId,
      baseRevision: 0,
      saveRevision: fetchPosts[0].saveRevision + 1,
      snapshot: { splitRatio: 0.7 },
    });
    expect(persistedControl.saveRevision).toBe(beaconBody.saveRevision);
    expect(persistedSnapshot.splitRatio).toBe(0.7);
  });

  test("falls back to one ordered keepalive POST when sendBeacon returns false", async () => {
    const originalPath = "C:\\originals\\face.mp4";
    const face = source(originalPath, "C:\\masters\\stale-face.mp4", {
      nativeCompatible: true,
      compatibilityStatus: "native",
    });
    const screen = source("C:\\originals\\screen.mp4");
    const projectPosts: Array<{
      body: {
        writerId: string;
        baseRevision: number;
        saveRevision: number;
        snapshot: ProjectSnapshot;
      };
      keepalive?: boolean;
    }> = [];
    let releaseFallback!: () => void;
    let fallbackReleased!: () => void;
    const fallbackDone = new Promise<void>((resolve) => {
      fallbackReleased = resolve;
    });
    const sendBeaconMock = vi.fn(() => false);
    vi.stubGlobal("navigator", { sendBeacon: sendBeaconMock });
    installProjectFetch(
      snapshot({ footageMeta: footage(face, screen) }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            writerId: string;
            baseRevision: number;
            saveRevision: number;
            snapshot: ProjectSnapshot;
          };
          projectPosts.push({ body, keepalive: init.keepalive });
          if (projectPosts.length === 2) {
            return new Promise<Response>((resolve) => {
              releaseFallback = () => {
                resolve(
                  jsonResponse({
                    project: {
                      id: "task-6-project",
                      name: "Task 6 project",
                      createdAt: "2026-08-24T00:00:00.000Z",
                      saveRevision: body.saveRevision,
                      saveWriterId: body.writerId,
                    },
                  })
                );
                fallbackReleased();
              };
            });
          }
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(inspection());
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const rendered = renderHook(() =>
      useProjectPersistence("task-6-project")
    );
    await waitFor(() => expect(projectPosts).toHaveLength(1));

    useRepurposeStore.setState({ splitRatio: 0.8 });
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(projectPosts).toHaveLength(2));

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(projectPosts[1]).toMatchObject({
      keepalive: true,
      body: {
        writerId: projectPosts[0].body.writerId,
        baseRevision: projectPosts[0].body.saveRevision,
        saveRevision: projectPosts[0].body.saveRevision + 1,
        snapshot: { splitRatio: 0.8 },
      },
    });
    try {
      rendered.unmount();
      expect(projectPosts).toHaveLength(2);
      expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseFallback();
      await fallbackDone;
    }
  });

  test("flags legacy blob footage for re-import without persisting a transient flag", async () => {
    const projectPosts: unknown[] = [];
    const fetchMock = installProjectFetch(
      snapshot({
        footageMeta: {
          ...footage(),
          faceCamPath: "blob:dead-face",
          screenPath: "blob:dead-screen",
        },
      }),
      (input, init) => {
        if (
          String(input) === "/api/repurpose/projects" &&
          init?.method === "POST"
        ) {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }
    );

    const { result } = await loadProject();

    expect(result.current.footageNeedsReimport).toBe(true);
    expect(useRepurposeStore.getState().footageMeta).toMatchObject({
      faceCamPath: "blob:dead-face",
      screenPath: "blob:dead-screen",
    });
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason: "Reconecte o arquivo de vídeo original.",
      isPlaying: false,
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/repurpose/media?")
      )
    ).toBe(false);
    expect(projectPosts).toHaveLength(0);
    expect(snapshot()).not.toHaveProperty("footageNeedsReimport");
  });

  test("persists blob-backed media as reconnect placeholders and restores their identities", async () => {
    const projectId = "blob-reconnect-placeholders";
    const posts: ControlledSaveBody[] = [];
    let loads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          loads++;
          return jsonResponse({
            project: {
              id: projectId,
              name: "Blob reconnect placeholders",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: loads === 1 ? 3 : posts[0].saveRevision,
              saveWriterId:
                loads === 1 ? "writer-serveraaa" : posts[0].writerId,
              snapshot:
                loads === 1
                  ? snapshot({ footageMeta: null })
                  : posts[0].snapshot,
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse({
            project: {
              id: projectId,
              name: "Blob reconnect placeholders",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const first = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() => expect(first.result.current.ready).toBe(true));

    useRepurposeStore.setState({
      footageMeta: {
        faceCamPath: "blob:face-camera",
        screenPath: "blob:screen-recording",
        fps: 30,
        width: 1920,
        height: 1080,
        durationSec: 5,
      },
      mediaAssets: [
        videoAsset("blob-bin-video", undefined, {
          name: "bin-video.mov",
          src: "blob:bin-video",
          sourcePath: undefined,
        }),
      ],
      overlays: [
        videoOverlay("blob-video-overlay", undefined, {
          src: "blob:video-overlay",
          sourcePath: undefined,
        }),
      ],
      mediaReadiness: "loading",
    });
    await waitFor(() => expect(posts).toHaveLength(1));

    expect(JSON.stringify(posts[0].snapshot)).not.toContain("blob:");
    expect(posts[0].snapshot).not.toHaveProperty("mediaReadiness");
    expect(posts[0].snapshot).toMatchObject({
      footageMeta: {
        faceCamPath: "reconnect:",
        screenPath: "reconnect:",
      },
      mediaAssets: [{ id: "blob-bin-video", src: "reconnect:" }],
      overlays: [{ id: "blob-video-overlay", src: "reconnect:" }],
    });

    first.unmount();
    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
    const second = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() => expect(second.result.current.ready).toBe(true));

    expect(second.result.current.footageNeedsReimport).toBe(true);
    expect(useRepurposeStore.getState()).toMatchObject({
      footageMeta: {
        faceCamPath: "reconnect:",
        screenPath: "reconnect:",
      },
      mediaAssets: [{ id: "blob-bin-video", src: "reconnect:" }],
      overlays: [{ id: "blob-video-overlay", src: "reconnect:" }],
    });
  });

  test("keeps valid footage preview work independent from a missing optional asset", async () => {
    const face = source("C:\\originals\\face.mp4", undefined, {
      previewPath: "C:\\preview\\stale-face.mp4",
    });
    const screen = source("C:\\originals\\screen.mp4");
    const missingAsset = source(
      "C:\\missing\\asset.mov",
      "C:\\missing\\asset-master.mp4"
    );
    const proxyPosts: string[] = [];
    installProjectFetch(
      snapshot({
        footageMeta: footage(face, screen),
        mediaAssets: [videoAsset("asset-missing", missingAsset)],
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path?.startsWith("C:\\missing\\")) {
          return jsonResponse(
            { error: { code: "MEDIA_PATH_INVALID", message: "missing" } },
            400
          );
        }
        if (path) return jsonResponse(source(path).inspection);
        if (url.startsWith("/api/repurpose/proxy?") && !init?.method) {
          return jsonResponse({ status: "none" });
        }
        if (url.startsWith("/api/repurpose/proxy?") && init?.method === "POST") {
          proxyPosts.push(JSON.parse(String(init.body)).path);
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    const { result } = await loadProject();
    await waitFor(() =>
      expect(
        useRepurposeStore.getState().footageMeta?.faceCamSource?.previewPath
      ).toBeUndefined()
    );

    const state = useRepurposeStore.getState();
    expect(result.current).toMatchObject({ ready: true, footageNeedsReimport: true });
    expect(state).toMatchObject({
      mediaReadiness: "loading",
      isPlaying: false,
      mediaAssets: [
        expect.objectContaining({
          sourcePath: missingAsset.workingPath,
          videoSource: missingAsset,
        }),
      ],
    });
    expect(proxyPosts).toContain(face.workingPath);
    expect(proxyPosts).not.toContain(missingAsset.workingPath);
  });

  test("queues valid asset and overlay previews when a missing base keeps autosave unsafe", async () => {
    const missingFace = source("C:\\missing\\face.mp4");
    const screen = source("C:\\originals\\screen.mp4");
    const assetSource = source("C:\\originals\\asset.mp4", undefined, {
      previewPath: "C:\\preview\\stale-asset.mp4",
    });
    const overlaySource = source("C:\\originals\\overlay.mp4", undefined, {
      previewPath: "C:\\preview\\stale-overlay.mp4",
    });
    const proxyStarts: string[] = [];
    const projectPosts: unknown[] = [];
    installProjectFetch(
      snapshot({
        footageMeta: footage(missingFace, screen),
        mediaAssets: [videoAsset("asset-valid", assetSource)],
        overlays: [videoOverlay("overlay-valid", overlaySource)],
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({ project: { id: "task-6-project" } });
        }
        const path = mediaPath(input);
        if (path === missingFace.workingPath) {
          return jsonResponse(
            { error: { code: "MEDIA_PATH_INVALID", message: "missing" } },
            400
          );
        }
        if (path) return jsonResponse(source(path).inspection);
        if (url.startsWith("/api/repurpose/proxy?") && !init?.method) {
          return jsonResponse({ status: "none" });
        }
        if (url === "/api/repurpose/proxy" && init?.method === "POST") {
          proxyStarts.push(JSON.parse(String(init.body)).path);
          return jsonResponse({ status: "ready" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    const { result } = await loadProject();
    await waitFor(() => {
      const state = useRepurposeStore.getState();
      expect(state.mediaAssets[0].videoSource?.previewPath).toContain(
        "quality=proxy"
      );
      expect(state.overlays[0].videoSource?.previewPath).toContain(
        "quality=proxy"
      );
    });

    expect(result.current).toMatchObject({
      ready: true,
      footageNeedsReimport: true,
    });
    expect(useRepurposeStore.getState()).toMatchObject({
      mediaReadiness: "error",
      isPlaying: false,
    });
    expect(new Set(proxyStarts)).toEqual(
      new Set([
        screen.workingPath,
        assetSource.workingPath,
        overlaySource.workingPath,
      ])
    );
    expect(proxyStarts).not.toContain(missingFace.workingPath);
    expect(projectPosts).toHaveLength(0);
  });

  test("does not catch-up save a safe hydration when media records are unchanged", async () => {
    const face = source("C:\\originals\\face.mp4");
    const screen = source("C:\\originals\\screen.mp4");
    const projectPosts: unknown[] = [];
    installProjectFetch(
      snapshot({
        clips: [],
        duration: 0,
        footageMeta: footage(face, screen),
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path === face.originalPath) return jsonResponse(face.inspection);
        if (path === screen.originalPath) return jsonResponse(screen.inspection);
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    await loadProject();

    expect(projectPosts).toHaveLength(0);
  });

  test("clears an evicted preview identity and starts a non-blocking rebuild", async () => {
    const face = source("C:\\originals\\face.mp4", undefined, {
      previewPath: "C:\\preview\\evicted.mp4",
    });
    const fetchMock = installProjectFetch(
      snapshot({ footageMeta: footage(face, source("C:\\originals\\screen.mp4")) }),
      (input, init) => {
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (
          String(input).startsWith("/api/repurpose/proxy?") &&
          !init?.method
        ) {
          return jsonResponse({ status: "none" });
        }
        if (
          String(input).startsWith("/api/repurpose/proxy?") &&
          init?.method === "POST"
        ) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }
    );

    await loadProject();

    expect(
      useRepurposeStore.getState().footageMeta?.faceCamSource?.previewPath
    ).toBeUndefined();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).startsWith("/api/repurpose/proxy?") &&
            init?.method === "POST"
        )
      ).toBe(true)
    );
    expect(useRepurposeStore.getState().mediaReadiness).toBe("loading");
  });

  test("reconciles validated proxies into footage, media-bin, and overlay records without changing working URLs", async () => {
    const face = source("C:\\originals\\face.mp4", undefined, {
      previewPath: "C:\\preview\\stale-face.mp4",
    });
    const screen = source("C:\\originals\\screen.mp4", undefined, {
      previewPath: "C:\\preview\\stale-screen.mp4",
    });
    const assetSource = source("C:\\originals\\asset.mp4", undefined, {
      previewPath: "C:\\preview\\stale-asset.mp4",
    });
    const overlaySource = source("C:\\originals\\overlay.mp4", undefined, {
      previewPath: "C:\\preview\\stale-overlay.mp4",
    });
    const proxyStarts: string[] = [];
    installProjectFetch(
      snapshot({
        footageMeta: footage(face, screen),
        mediaAssets: [videoAsset("asset-video", assetSource)],
        overlays: [videoOverlay("overlay-video", overlaySource)],
      }),
      (input, init) => {
        const url = String(input);
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (url === "/api/repurpose/proxy" && init?.method === "POST") {
          proxyStarts.push(JSON.parse(String(init.body)).path);
          return jsonResponse({ status: "ready" });
        }
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "ready" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    await loadProject();
    const expectedPreview = (workingPath: string) =>
      `${videoUrl(workingPath)}&quality=proxy`;
    await waitFor(() => {
      const state = useRepurposeStore.getState();
      expect(state.footageMeta?.faceCamSource?.previewPath).toBe(
        expectedPreview(face.workingPath)
      );
      expect(state.footageMeta?.screenSource?.previewPath).toBe(
        expectedPreview(screen.workingPath)
      );
      expect(state.mediaAssets[0].videoSource?.previewPath).toBe(
        expectedPreview(assetSource.workingPath)
      );
      expect(state.overlays[0].videoSource?.previewPath).toBe(
        expectedPreview(overlaySource.workingPath)
      );
    });

    const state = useRepurposeStore.getState();
    expect(new Set(proxyStarts)).toEqual(
      new Set([
        face.workingPath,
        screen.workingPath,
        assetSource.workingPath,
        overlaySource.workingPath,
      ])
    );
    expect(state.footageMeta).toMatchObject({
      faceCamPath: videoUrl(face.workingPath),
      screenPath: videoUrl(screen.workingPath),
    });
    expect(state.mediaAssets[0]).toMatchObject({
      src: videoUrl(assetSource.workingPath),
      sourcePath: assetSource.workingPath,
    });
    expect(state.overlays[0]).toMatchObject({
      src: videoUrl(overlaySource.workingPath),
      sourcePath: overlaySource.workingPath,
    });
  });

  test("becomes ready before optional preview validation settles", async () => {
    const workingPath = "C:\\masters\\face.mp4";
    const previewPath = "C:\\preview\\face.mp4";
    const face = source("C:\\originals\\face.mov", workingPath, {
      previewPath,
    });
    const screen = source("C:\\originals\\screen.mp4");
    let releasePreview!: (response: Response) => void;
    const previewBarrier = new Promise<Response>((resolve) => {
      releasePreview = resolve;
    });
    let markPreviewRequested!: () => void;
    const previewRequested = new Promise<void>((resolve) => {
      markPreviewRequested = resolve;
    });
    const ordering: string[] = [];
    const requestedMedia = new Set<string>();
    const fetchMock = installProjectFetch(
      snapshot({ footageMeta: footage(face, screen) }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path) {
          requestedMedia.add(path);
          return jsonResponse(
            path === face.originalPath ? face.inspection : inspection("f")
          );
        }
        if (url.startsWith("/api/repurpose/proxy?") && !init?.method) {
          ordering.push("preview-pending");
          markPreviewRequested();
          return previewBarrier;
        }
        if (url.startsWith("/api/repurpose/proxy?") && init?.method === "POST") {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const rendered = renderHook(() =>
      useProjectPersistence("task-6-project")
    );

    await waitFor(() =>
      expect(requestedMedia).toEqual(
        new Set([face.originalPath, face.workingPath, screen.originalPath])
      )
    );
    await previewRequested;
    try {
      await waitFor(() => expect(rendered.result.current.ready).toBe(true));
      ordering.push("ready");
    } finally {
      ordering.push("preview-released");
      releasePreview(jsonResponse({ status: "none" }));
    }
    expect(ordering).toEqual([
      "preview-pending",
      "ready",
      "preview-released",
    ]);

    expect(useRepurposeStore.getState().footageMeta).toMatchObject({
      faceCamPath: videoUrl(workingPath),
      faceCamSource: expect.objectContaining({
        workingPath,
        previewPath,
      }),
    });
    await waitFor(() =>
      expect(
        useRepurposeStore.getState().footageMeta?.faceCamSource?.previewPath
      ).toBeUndefined()
    );
    expect(useRepurposeStore.getState().footageMeta?.faceCamPath).toBe(
      videoUrl(workingPath)
    );
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).startsWith("/api/repurpose/proxy?") &&
          init?.method === "POST"
      )
    ).toBe(true);
  });

  test("aborts background preview validation without writing into a reset project", async () => {
    const face = source("C:\\originals\\face.mp4", undefined, {
      previewPath: "C:\\preview\\face.mp4",
    });
    const screen = source("C:\\originals\\screen.mp4");
    let previewSignal: AbortSignal | undefined;
    installProjectFetch(
      snapshot({ footageMeta: footage(face, screen) }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (url.startsWith("/api/repurpose/proxy?") && !init?.method) {
          previewSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            const cancel = () =>
              reject(new DOMException("Aborted", "AbortError"));
            if (previewSignal?.aborted) cancel();
            else previewSignal?.addEventListener("abort", cancel, { once: true });
          });
        }
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "building" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "task-6-project" } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    await waitFor(() => expect(previewSignal).toBeInstanceOf(AbortSignal));

    rendered.rerender({ projectId: "new-reset" });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    await waitFor(() => expect(previewSignal?.aborted).toBe(true));

    expect(useRepurposeStore.getState()).toMatchObject({
      footageMeta: null,
      mediaReadiness: "idle",
      playbackBlockedReason: null,
    });
  });

  test("ignores a late proxy completion after the target source is replaced with the same fingerprint", async () => {
    const face = source("C:\\originals\\face.mp4", undefined, {
      previewPath: "C:\\preview\\face.mp4",
    });
    const screen = source("C:\\originals\\screen.mp4");
    let releaseProxy!: (response: Response) => void;
    const proxyBarrier = new Promise<Response>((resolve) => {
      releaseProxy = resolve;
    });
    let proxyStarted!: () => void;
    const proxyStart = new Promise<void>((resolve) => {
      proxyStarted = resolve;
    });
    installProjectFetch(
      snapshot({ footageMeta: footage(face, screen) }),
      (input, init) => {
        const url = String(input);
        const path = mediaPath(input);
        if (path) return jsonResponse(source(path).inspection);
        if (url.startsWith("/api/repurpose/proxy?") && !init?.method) {
          return jsonResponse({ status: "ready" });
        }
        if (url === "/api/repurpose/proxy" && init?.method === "POST") {
          const requestedPath = JSON.parse(String(init.body)).path;
          if (requestedPath === face.workingPath) {
            proxyStarted();
            return proxyBarrier;
          }
          return jsonResponse({ status: "ready" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    await loadProject();
    await proxyStart;
    const current = useRepurposeStore.getState().footageMeta?.faceCamSource;
    expect(current).toBeDefined();
    const replacement = {
      ...current!,
      originalName: "replacement.mp4",
      previewPath: undefined,
    };
    act(() =>
      useRepurposeStore.getState().setVideoSourceRecord(
        { kind: "footage", role: "face" },
        replacement
      )
    );

    await act(async () => {
      releaseProxy(jsonResponse({ status: "ready" }));
      await Promise.resolve();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      useRepurposeStore.getState().footageMeta?.faceCamSource
    ).toBe(replacement);
  });

  test("rebuilds an evicted converted master from the immutable original", async () => {
    const oldWorking = "C:\\masters\\evicted.mp4";
    const newWorking = "C:\\masters\\rebuilt.mp4";
    const original = "C:\\originals\\camera.mov";
    const converted = source(original, oldWorking, {
      previewPath: "C:\\preview\\old-master-preview.mp4",
    });
    let compatibilityPolls = 0;
    const projectPosts: Array<{ id: string; snapshot: ProjectSnapshot }> = [];
    const fetchMock = installProjectFetch(
      snapshot({
        footageMeta: footage(
          converted,
          source("C:\\originals\\screen.mp4")
        ),
      }),
      (input, init) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          projectPosts.push(JSON.parse(String(init.body)));
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "Task 6 project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        const path = mediaPath(input);
        if (path === oldWorking) {
          return jsonResponse(
            { error: { code: "MEDIA_PATH_INVALID", message: "missing" } },
            400
          );
        }
        if (path) {
          return jsonResponse(
            path === original ? inspection("c", "hevc") : inspection("d")
          );
        }
        if (url.endsWith("/api/repurpose/compatibility") && init?.method === "POST") {
          return jsonResponse({ status: "building", progress: 0.4 }, 202);
        }
        if (url.startsWith("/api/repurpose/compatibility?")) {
          compatibilityPolls += 1;
          return jsonResponse({
            status: "ready",
            progress: 1,
            workingPath: newWorking,
          });
        }
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "unavailable" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );

    const { result } = await loadProject();
    const state = useRepurposeStore.getState();

    expect(result.current.footageNeedsReimport).toBe(false);
    expect(compatibilityPolls).toBe(1);
    expect(probeBrowserVideoMock).toHaveBeenCalledWith(
      videoUrl(newWorking),
      expect.any(AbortSignal)
    );
    expect(state.footageMeta).toMatchObject({
      faceCamPath: videoUrl(newWorking),
      faceCamSource: expect.objectContaining({
        originalPath: original,
        workingPath: newWorking,
        inspection: inspection("c", "hevc"),
        compatibilityStatus: "converted",
      }),
    });
    expect(state.footageMeta?.faceCamSource?.previewPath).toBeUndefined();
    expect(state.mediaReadiness).toBe("loading");
    const start = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/api/repurpose/compatibility") &&
        init?.method === "POST"
    );
    expect(JSON.parse(String(start?.[1]?.body))).toEqual({
      path: original,
      fingerprint: inspection("c", "hevc").fingerprint,
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (
            !String(input).startsWith("/api/repurpose/proxy?") ||
            init?.method !== "POST"
          ) {
            return false;
          }
          return JSON.parse(String(init.body)).path === newWorking;
        })
      ).toBe(true)
    );
    await waitFor(() => expect(projectPosts).toHaveLength(1));
    expect(projectPosts[0]).toMatchObject({
      id: "task-6-project",
      snapshot: {
        footageMeta: {
          faceCamPath: videoUrl(newWorking),
          faceCamSource: expect.objectContaining({
            originalPath: original,
            workingPath: newWorking,
          }),
        },
      },
    });
    expect(
      projectPosts[0].snapshot.footageMeta?.faceCamSource
    ).not.toHaveProperty("previewPath");
  });

  test("reports reconnect when original and working files are both missing", async () => {
    const missing = source(
      "C:\\missing\\original.mov",
      "C:\\missing\\working.mp4"
    );
    const requested: string[] = [];
    const fetchMock = installProjectFetch(
      snapshot({
        footageMeta: footage(
          missing,
          source("C:\\originals\\screen.mp4")
        ),
      }),
      (input) => {
        const path = mediaPath(input);
        if (path?.includes("missing")) {
          requested.push(path);
          return jsonResponse(
            { error: { code: "MEDIA_PATH_INVALID", message: "missing" } },
            400
          );
        }
        if (path) return jsonResponse(source(path).inspection);
        if (String(input).startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "unavailable" });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }
    );

    const { result } = await loadProject();
    const store = useRepurposeStore.getState();

    expect(result.current.footageNeedsReimport).toBe(true);
    expect(requested).toEqual(
      expect.arrayContaining([missing.originalPath, missing.workingPath])
    );
    expect(store).toMatchObject({
      mediaReadiness: "error",
      playbackBlockedReason: "Reconecte o arquivo de vídeo original.",
      isPlaying: false,
    });
    store.play();
    expect(useRepurposeStore.getState().isPlaying).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/api/repurpose/compatibility") &&
          init?.method === "POST"
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/repurpose/projects" &&
          init?.method === "POST"
      )
    ).toBe(false);
  });

  test("releases hydration ownership when switching an active load through a provisional reset", async () => {
    const firstFace = source("C:\\first\\face.mp4");
    const firstScreen = source("C:\\first\\screen.mp4");
    const nextFace = source("C:\\next\\face.mp4");
    const nextScreen = source("C:\\next\\screen.mp4");
    const reconciliationSignals: AbortSignal[] = [];
    let reconciliationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reconciliationStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/repurpose/projects/task-6-project")) {
          return jsonResponse({
            project: {
              id: "task-6-project",
              name: "First project",
              createdAt: "2026-08-24T00:00:00.000Z",
              snapshot: snapshot({
                footageMeta: footage(firstFace, firstScreen),
              }),
            },
          });
        }
        if (url.includes("/api/repurpose/projects/task-6-next")) {
          return jsonResponse({
            project: {
              id: "task-6-next",
              name: "Next project",
              createdAt: "2026-08-24T00:00:00.000Z",
              snapshot: snapshot({
                footageMeta: footage(nextFace, nextScreen),
              }),
            },
          });
        }
        const path = mediaPath(input);
        if (path?.startsWith("C:\\first\\")) {
          const signal = init?.signal;
          if (!signal) throw new Error("Missing reconciliation signal");
          reconciliationSignals.push(signal);
          reconciliationStarted();
          return await new Promise<Response>((_resolve, reject) => {
            const cancel = () =>
              reject(new DOMException("Aborted", "AbortError"));
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
          });
        }
        if (path?.startsWith("C:\\next\\")) {
          return jsonResponse(source(path).inspection);
        }
        if (url.startsWith("/api/repurpose/proxy?")) {
          return jsonResponse({ status: "unavailable" });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          return jsonResponse({
            project: {
              id: "task-6-next",
              name: "Next project",
              createdAt: "2026-08-24T00:00:00.000Z",
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "task-6-project" } }
    );
    await started;
    expect(useRepurposeStore.getState()).toMatchObject({
      hydrating: true,
      mediaReadiness: "loading",
      isPlaying: false,
    });

    rendered.rerender({ projectId: "new-reset" });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    expect(reconciliationSignals.length).toBeGreaterThan(0);
    expect(reconciliationSignals.every((signal) => signal.aborted)).toBe(true);
    expect(useRepurposeStore.getState()).toMatchObject({
      hydrating: false,
      footageMeta: null,
      mediaReadiness: "idle",
      playbackBlockedReason: null,
      isPlaying: false,
    });

    rendered.rerender({ projectId: "task-6-next" });
    await waitFor(() =>
      expect(useRepurposeStore.getState().footageMeta?.faceCamPath).toBe(
        videoUrl(nextFace.workingPath)
      )
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(useRepurposeStore.getState().hydrating).toBe(false);
  });

  test.each([
    ["network failure", () => Promise.reject(new TypeError("offline"))],
    [
      "HTTP 500",
      () => Promise.resolve(jsonResponse({ error: "disk unavailable" }, 500)),
    ],
    [
      "invalid JSON",
      () =>
        Promise.resolve(
          new Response("{not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        ),
    ],
  ])(
    "keeps hydration blocked after %s and loads only after an explicit retry",
    async (_label, firstResponse) => {
      let loads = 0;
      const posts: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/load-retry-project")) {
            loads++;
            if (loads === 1) return firstResponse();
            return jsonResponse({
              project: {
                id: "load-retry-project",
                name: "Recovered project",
                createdAt: "2026-08-24T00:00:00.000Z",
                saveRevision: 3,
                saveWriterId: "writer-serveraaa",
                snapshot: snapshot({ footageMeta: null, splitRatio: 0.72 }),
              },
            });
          }
          if (url === "/api/repurpose/projects" && init?.method === "POST") {
            posts.push(JSON.parse(String(init.body)));
            return jsonResponse({ project: {} });
          }
          throw new Error(`Unexpected request: ${url}`);
        })
      );

      const rendered = renderHook(() =>
        useProjectPersistence("load-retry-project")
      );
      await waitFor(() =>
        expect(rendered.result.current.loadError).toEqual(expect.any(String))
      );

      expect(rendered.result.current.ready).toBe(false);
      expect(useRepurposeStore.getState().hydrating).toBe(true);
      expect(posts).toHaveLength(0);

      act(() => rendered.result.current.retryLoad());
      await waitFor(() => expect(rendered.result.current.ready).toBe(true));

      expect(rendered.result.current.loadError).toBeNull();
      expect(useRepurposeStore.getState().splitRatio).toBe(0.72);
      expect(posts).toHaveLength(0);
    }
  );

  test("releases hydration and allows retry after a malformed snapshot", async () => {
    let loads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/malformed-snapshot")) {
          throw new Error(`Unexpected request: ${url}`);
        }
        loads++;
        return jsonResponse({
          project: {
            id: "malformed-snapshot",
            name: "Malformed snapshot",
            createdAt: "2026-08-24T00:00:00.000Z",
            saveRevision: 2,
            saveWriterId: "writer-serveraaa",
            snapshot:
              loads === 1 ? null : snapshot({ footageMeta: null, splitRatio: 0.64 }),
          },
        });
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("malformed-snapshot")
    );

    await waitFor(() =>
      expect(rendered.result.current.loadError).toEqual(expect.any(String))
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(useRepurposeStore.getState().hydrating).toBe(false);

    act(() => rendered.result.current.retryLoad());
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(rendered.result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.64);
  });

  test("shows an actionable load error instead of opening a corrupt project as blank", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/corrupt-project-get")) {
          return jsonResponse(
            {
              error: {
                code: "PROJECT_FILE_CORRUPT",
                message: "Project file is corrupt.",
              },
              project: { id: "corrupt-project-get" },
            },
            409
          );
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return jsonResponse({ project: {} });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("corrupt-project-get")
    );

    await waitFor(() =>
      expect(rendered.result.current.loadError).toContain("corrompido")
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(useRepurposeStore.getState().hydrating).toBe(false);
    expect(posts).toHaveLength(0);
  });

  test("releases hydration and allows retry after a malformed nested clip", async () => {
    let loads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/malformed-nested-clip")) {
          throw new Error(`Unexpected request: ${url}`);
        }
        loads++;
        return jsonResponse({
          project: {
            id: "malformed-nested-clip",
            name: "Malformed nested clip",
            createdAt: "2026-08-24T00:00:00.000Z",
            saveRevision: 2,
            saveWriterId: "writer-serveraaa",
            snapshot:
              loads === 1
                ? snapshot({ clips: [null as unknown as Clip] })
                : snapshot({ footageMeta: null, splitRatio: 0.66 }),
          },
        });
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("malformed-nested-clip")
    );

    await waitFor(() =>
      expect(rendered.result.current.loadError).toEqual(expect.any(String))
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(useRepurposeStore.getState().hydrating).toBe(false);

    act(() => rendered.result.current.retryLoad());
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(rendered.result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.66);
  });

  test("rejects a clip object missing required timeline fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/malformed-clip-object")) {
          throw new Error(`Unexpected request: ${url}`);
        }
        return jsonResponse({
          project: {
            id: "malformed-clip-object",
            name: "Malformed clip object",
            createdAt: "2026-08-24T00:00:00.000Z",
            saveRevision: 2,
            saveWriterId: "writer-serveraaa",
            snapshot: snapshot({ clips: [{} as Clip], footageMeta: null }),
          },
        });
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("malformed-clip-object")
    );

    await waitFor(() =>
      expect(rendered.result.current.loadError).toEqual(expect.any(String))
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(useRepurposeStore.getState()).toMatchObject({
      clips: [],
      hydrating: false,
    });
  });

  test("cleans partial hydration and allows retry after a malformed nested overlay", async () => {
    let loads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/malformed-nested-overlay")) {
          throw new Error(`Unexpected request: ${url}`);
        }
        loads++;
        return jsonResponse({
          project: {
            id: "malformed-nested-overlay",
            name: "Malformed nested overlay",
            createdAt: "2026-08-24T00:00:00.000Z",
            saveRevision: 2,
            saveWriterId: "writer-serveraaa",
            snapshot:
              loads === 1
                ? snapshot({
                    footageMeta: null,
                    overlays: [null as unknown as Overlay],
                  })
                : snapshot({ footageMeta: null, splitRatio: 0.67 }),
          },
        });
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("malformed-nested-overlay")
    );

    await waitFor(() =>
      expect(rendered.result.current.loadError).toEqual(expect.any(String))
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(useRepurposeStore.getState()).toMatchObject({
      clips: [],
      overlays: [],
      hydrating: false,
    });

    act(() => rendered.result.current.retryLoad());
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(rendered.result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.67);
  });

  test.each([
    ["empty object", {} as Overlay],
    ["array entry", [] as unknown as Overlay],
    [
      "invalid identity",
      {
        ...legacyImageOverlay("identity"),
        id: "",
        kind: "audio",
        src: 42,
      } as unknown as Overlay,
    ],
    [
      "invalid intrinsic dimensions",
      legacyImageOverlay("dimensions", {
        naturalWidth: 0,
        naturalHeight: Number.POSITIVE_INFINITY,
      }),
    ],
    [
      "malformed transform",
      legacyImageOverlay("transform", {
        transform: {
          x: Number.NaN,
          y: 0.25,
          scale: 0,
          rotation: Number.POSITIVE_INFINITY,
        },
      }),
    ],
    [
      "non-finite timeline",
      legacyImageOverlay("timeline", {
        timelineEnd: Number.POSITIVE_INFINITY,
      }),
    ],
    [
      "invalid source timing",
      legacyImageOverlay("source", { srcStart: -1, srcDuration: Number.NaN }),
    ],
    ["invalid z-index", legacyImageOverlay("z-index", { zIndex: 0.5 })],
    ["invalid opacity", legacyImageOverlay("opacity", { opacity: 1.1 })],
    [
      "invalid band",
      legacyImageOverlay("band", { band: "invalid" as Overlay["band"] }),
    ],
    [
      "non-string source path",
      legacyImageOverlay("source-path", {
        sourcePath: 42 as unknown as string,
      }),
    ],
    [
      "false muted flag",
      { ...legacyImageOverlay("muted-false"), muted: false } as unknown as Overlay,
    ],
    [
      "string muted flag",
      { ...legacyImageOverlay("muted-string"), muted: "true" } as unknown as Overlay,
    ],
    [
      "empty video source",
      {
        ...legacyImageOverlay("video-source-empty", {
          kind: "video",
          srcDuration: 4,
          muted: true,
        }),
        videoSource: {},
      } as unknown as Overlay,
    ],
    [
      "invalid video source paths",
      {
        ...legacyImageOverlay("video-source-paths", {
          kind: "video",
          srcDuration: 4,
          muted: true,
        }),
        videoSource: {
          ...source("C:\\originals\\source.mp4"),
          workingPath: 42,
          previewPath: false,
        },
      } as unknown as Overlay,
    ],
    [
      "non-finite video source duration",
      {
        ...legacyImageOverlay("video-source-duration", {
          kind: "video",
          srcDuration: 4,
          muted: true,
        }),
        videoSource: {
          ...source("C:\\originals\\source.mp4"),
          inspection: {
            ...inspection(),
            durationSec: Number.NaN,
          },
        },
      } as unknown as Overlay,
    ],
    [
      "invalid video source frame metadata",
      {
        ...legacyImageOverlay("video-source-frame", {
          kind: "video",
          srcDuration: 4,
          muted: true,
        }),
        videoSource: {
          ...source("C:\\originals\\source.mp4"),
          inspection: {
            ...inspection(),
            video: {
              ...inspection().video,
              width: 0,
              fps: Number.POSITIVE_INFINITY,
            },
          },
        },
      } as unknown as Overlay,
    ],
    [
      "invalid video source audio metadata",
      {
        ...legacyImageOverlay("video-source-audio", {
          kind: "video",
          srcDuration: 4,
          muted: true,
        }),
        videoSource: {
          ...source("C:\\originals\\source.mp4"),
          inspection: {
            ...inspection(),
            audio: {
              codec: "aac",
              channels: 2,
              sampleRate: Number.NaN,
            },
          },
        },
      } as unknown as Overlay,
    ],
  ])(
    "rejects a persisted overlay with %s and recovers without autosaving",
    async (label, malformedOverlay) => {
      let loads = 0;
      const posts: unknown[] = [];
      const projectId = `malformed-overlay-${String(label).replaceAll(" ", "-")}`;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith(`/${projectId}`)) {
            loads++;
            return {
              ok: true,
              status: 200,
              json: async () => ({
                project: {
                  id: projectId,
                  name: "Overlay validation",
                  createdAt: "2026-08-24T00:00:00.000Z",
                  saveRevision: 2,
                  saveWriterId: "writer-serveraaa",
                  snapshot:
                    loads === 1
                      ? snapshot({
                          footageMeta: null,
                          overlays: [malformedOverlay],
                        })
                      : snapshot({
                          footageMeta: null,
                          splitRatio: 0.68,
                          overlays: [legacyImageOverlay("valid-legacy")],
                        }),
                },
              }),
            } as Response;
          }
          if (url === "/api/repurpose/projects" && init?.method === "POST") {
            posts.push(JSON.parse(String(init.body)));
            return jsonResponse({ project: {} });
          }
          throw new Error(`Unexpected request: ${url}`);
        })
      );
      const rendered = renderHook(() => useProjectPersistence(projectId));

      await waitFor(() =>
        expect(rendered.result.current.loadError).toEqual(expect.any(String))
      );
      expect(rendered.result.current.ready).toBe(false);
      expect(useRepurposeStore.getState()).toMatchObject({
        overlays: [],
        hydrating: false,
      });
      expect(posts).toEqual([]);

      act(() => rendered.result.current.retryLoad());
      await waitFor(() => expect(rendered.result.current.ready).toBe(true));
      expect(rendered.result.current.loadError).toBeNull();
      expect(useRepurposeStore.getState().overlays).toMatchObject([
        {
          id: "valid-legacy",
          entranceEffect: { type: "none", durationSec: 0.35 },
          exitEffect: { type: "none", durationSec: 0.35 },
          cornerRadius: 0,
        },
      ]);
      expect(useRepurposeStore.getState().splitRatio).toBe(0.68);
      expect(posts).toEqual([]);
    }
  );

  test("accepts a valid legacy overlay without destructive autosave", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/valid-legacy-overlay")) {
          return jsonResponse({
            project: {
              id: "valid-legacy-overlay",
              name: "Valid legacy overlay",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({
                footageMeta: null,
              overlays: [
                legacyImageOverlay("valid-legacy-image"),
                legacyImageOverlay("valid-legacy-video", {
                  kind: "video",
                  src: "/media/valid-legacy-video.mp4",
                  srcDuration: 4,
                  zIndex: 1,
                }),
              ],
              }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return jsonResponse({ project: {} });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const rendered = renderHook(() =>
      useProjectPersistence("valid-legacy-overlay")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    expect(rendered.result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState().overlays).toMatchObject([
      { id: "valid-legacy-image", cornerRadius: 0 },
      { id: "valid-legacy-video", cornerRadius: 0 },
    ]);
    expect(posts).toEqual([]);
  });

  test("retries a failed autosave with backoff without another store mutation", async () => {
    const posts: ControlledSaveBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/autosave-backoff")) {
          return jsonResponse({
            project: {
              id: "autosave-backoff",
              name: "Autosave backoff",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 4,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          if (posts.length === 1) {
            return jsonResponse({ error: "temporarily unavailable" }, 503);
          }
          return jsonResponse({
            project: {
              id: "autosave-backoff",
              name: "Autosave backoff",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("autosave-backoff")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ splitRatio: 0.73 });
      await vi.advanceTimersByTimeAsync(501);
      expect(posts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(posts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(posts).toHaveLength(2);
      expect(posts[1]).toMatchObject({
        baseRevision: 4,
        snapshot: { splitRatio: 0.73 },
      });
      expect(posts[1].saveRevision).toBeGreaterThan(posts[0].saveRevision);
      rendered.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("blocks autosave retries when the project file is corrupt", async () => {
    const posts: ControlledSaveBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/corrupt-autosave")) {
          return jsonResponse({
            project: {
              id: "corrupt-autosave",
              name: "Corrupt autosave",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 4,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as ControlledSaveBody);
          return jsonResponse(
            {
              error: { code: "PROJECT_FILE_CORRUPT" },
              project: {
                id: "corrupt-autosave",
                saveRevision: 0,
                saveWriterId: null,
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("corrupt-autosave")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ splitRatio: 0.74 });
      await vi.advanceTimersByTimeAsync(501);
      await act(async () => Promise.resolve());

      expect(rendered.result.current.saveConflict).toMatchObject({
        projectId: "corrupt-autosave",
        reason: "PROJECT_FILE_CORRUPT",
      });
      expect(posts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(20_000);
      useRepurposeStore.setState({ splitRatio: 0.75 });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(posts).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("preserves corrupt conflicted edits when authoritative reload returns 404", async () => {
    const posts: Array<
      ControlledSaveBody & {
        id: string;
        name: string;
        mode?: "create";
      }
    > = [];
    let loads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/corrupt-reload")) {
          loads++;
          if (loads > 1) return jsonResponse({ error: "not found" }, 404);
          return jsonResponse({
            project: {
              id: "corrupt-reload",
              name: "Corrupt reload",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 4,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.5 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (body.mode === "create") {
            return jsonResponse({
              project: {
                id: "corrupt-reload-copy",
                name: body.name,
                createdAt: "2026-08-25T00:00:00.000Z",
                saveRevision: body.saveRevision,
                saveWriterId: body.writerId,
              },
            });
          }
          return jsonResponse(
            {
              error: { code: "PROJECT_FILE_CORRUPT" },
              project: {
                id: "corrupt-reload",
                saveRevision: 0,
                saveWriterId: null,
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("corrupt-reload")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    useRepurposeStore.setState({ splitRatio: 0.79 });
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).toMatchObject({
        reason: "PROJECT_FILE_CORRUPT",
      })
    );

    let reloadResolution!: Promise<boolean>;
    act(() => {
      reloadResolution = rendered.result.current.resolveSaveConflict("reload");
    });

    await expect(reloadResolution).resolves.toBe(false);
    expect(loads).toBe(2);
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    expect(rendered.result.current.saveConflict).toMatchObject({
      projectId: "corrupt-reload",
      reason: "PROJECT_FILE_CORRUPT",
    });
    expect(useRepurposeStore.getState().splitRatio).toBe(0.79);

    let copied = false;
    await act(async () => {
      copied = await rendered.result.current.resolveSaveConflict("save-copy");
    });

    expect(copied).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      id: "corrupt-reload-copy",
      mode: "create",
      snapshot: { splitRatio: 0.79 },
    });
  });

  test("save-copy includes a newer edit made while the conflicting autosave is in flight", async () => {
    const posts: Array<
      ControlledSaveBody & {
        id: string;
        name: string;
        mode?: "create";
      }
    > = [];
    let releaseConflict!: (response: Response) => void;
    const deferredConflict = new Promise<Response>((resolve) => {
      releaseConflict = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/copy-newer-in-flight")) {
          return jsonResponse({
            project: {
              id: "copy-newer-in-flight",
              name: "Copy newer in flight",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 7,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.5 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (body.mode === "create") {
            return jsonResponse({
              project: {
                id: "copy-newer-in-flight-copy",
                name: body.name,
                createdAt: "2026-08-25T00:00:00.000Z",
                saveRevision: body.saveRevision,
                saveWriterId: body.writerId,
              },
            });
          }
          return deferredConflict;
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("copy-newer-in-flight")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.61 });
    await waitFor(() => expect(posts).toHaveLength(1));
    useRepurposeStore.setState({ splitRatio: 0.72 });
    releaseConflict(
      jsonResponse(
        {
          error: { code: "PROJECT_SAVE_CONFLICT", reason: "BASE_MISMATCH" },
          project: {
            id: "copy-newer-in-flight",
            saveRevision: 8,
            saveWriterId: "writer-competing",
          },
        },
        409
      )
    );
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).not.toBeNull()
    );

    let copied = false;
    await act(async () => {
      copied = await rendered.result.current.resolveSaveConflict("save-copy");
    });

    expect(copied).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      id: "copy-newer-in-flight-copy",
      mode: "create",
      snapshot: { splitRatio: 0.72 },
    });
  });

  test("preserves a conflicted snapshot and can save it as a collision-free copy", async () => {
    const posts: Array<
      ControlledSaveBody & {
        id: string;
        name: string;
        mode?: "create";
        createRequestId?: string;
      }
    > = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/copy-on-conflict")) {
          return jsonResponse({
            project: {
              id: "copy-on-conflict",
              name: "Copy on conflict",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 7,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.5 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (body.mode === "create") {
            return jsonResponse({
              project: {
                id: "copy-on-conflict-copy",
                name: body.name,
                createdAt: "2026-08-25T00:00:00.000Z",
                saveRevision: body.saveRevision,
                saveWriterId: body.writerId,
              },
            });
          }
          return jsonResponse(
            {
              error: {
                code: "PROJECT_SAVE_CONFLICT",
                reason: "BASE_MISMATCH",
              },
              project: {
                id: "copy-on-conflict",
                saveRevision: 8,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("copy-on-conflict")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ splitRatio: 0.81 });
      await vi.advanceTimersByTimeAsync(501);
      await act(async () => Promise.resolve());
      expect(rendered.result.current.saveConflict).toMatchObject({
        projectId: "copy-on-conflict",
        reason: "BASE_MISMATCH",
        serverRevision: 8,
      });

      const imagePath = "C:\\media\\newest-copy.png";
      useRepurposeStore.setState({
        splitRatio: 0.82,
        mediaAssets: [
          {
            id: "newest-copy-image",
            kind: "image",
            name: "newest-copy.png",
            src: "blob:transient-newest-copy",
            sourcePath: imagePath,
            naturalWidth: 1920,
            naturalHeight: 1080,
          },
        ],
        mediaReadiness: "error",
      });

      let resolved = false;
      await act(async () => {
        resolved = await rendered.result.current.resolveSaveConflict(
          "save-copy"
        );
      });

      expect(resolved).toBe(true);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toMatchObject({
        id: "copy-on-conflict-copy",
        mode: "create",
        baseRevision: 0,
        snapshot: {
          splitRatio: 0.82,
          mediaAssets: [
            {
              id: "newest-copy-image",
              src: `/api/repurpose/asset?path=${encodeURIComponent(imagePath)}`,
            },
          ],
        },
      });
      expect(JSON.stringify(posts[1].snapshot)).not.toContain("blob:");
      expect(posts[1].snapshot).not.toHaveProperty("mediaReadiness");
      expect(posts[1].createRequestId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(rendered.result.current.saveConflict).toBeNull();
      expect(replaceMock).toHaveBeenCalledWith(
        "/repurpose-studio/copy-on-conflict-copy"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("ignores a delayed conflict-copy response after the route changes", async () => {
    const posts: Array<
      ControlledSaveBody & { id: string; name: string; mode?: "create" }
    > = [];
    let releaseCopy!: (response: Response) => void;
    const deferredCopy = new Promise<Response>((resolve) => {
      releaseCopy = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/ownership-conflict-a")) {
          return jsonResponse({
            project: {
              id: "ownership-conflict-a",
              name: "Ownership conflict A",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url.endsWith("/ownership-conflict-b")) {
          return jsonResponse({
            project: {
              id: "ownership-conflict-b",
              name: "Ownership conflict B",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 1,
              saveWriterId: "writer-serverbbb",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.24 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (body.mode === "create") return deferredCopy;
          return jsonResponse(
            {
              error: {
                code: "PROJECT_SAVE_CONFLICT",
                reason: "BASE_MISMATCH",
              },
              project: {
                id: "ownership-conflict-a",
                saveRevision: 3,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "ownership-conflict-a" } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    useRepurposeStore.setState({ splitRatio: 0.86 });
    await waitFor(() => expect(rendered.result.current.saveConflict).not.toBeNull());

    let resolution!: Promise<boolean>;
    act(() => {
      resolution = rendered.result.current.resolveSaveConflict("save-copy");
    });
    await waitFor(() => expect(posts).toHaveLength(2));
    rendered.rerender({ projectId: "ownership-conflict-b" });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    releaseCopy(
      jsonResponse({
        project: {
          id: "ownership-conflict-a-copy",
          name: "Ownership conflict A (cópia)",
          createdAt: "2026-08-25T00:00:00.000Z",
          saveRevision: posts[1].saveRevision,
          saveWriterId: posts[1].writerId,
        },
      })
    );
    await expect(resolution).resolves.toBe(false);

    expect(replaceMock).not.toHaveBeenCalled();
    expect(rendered.result.current.projectName).toBe("Ownership conflict B");
    expect(rendered.result.current.saveConflict).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.24);
  });

  test("reloads the authoritative server project to resolve a save conflict", async () => {
    let loads = 0;
    const posts: ControlledSaveBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/reload-on-conflict")) {
          loads++;
          return jsonResponse({
            project: {
              id: "reload-on-conflict",
              name: "Reload on conflict",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: loads === 1 ? 4 : 6,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({
                footageMeta: null,
                splitRatio: loads === 1 ? 0.4 : 0.22,
              }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse(
            {
              error: {
                code: "PROJECT_SAVE_CONFLICT",
                reason: "BASE_MISMATCH",
              },
              project: {
                id: "reload-on-conflict",
                saveRevision: 6,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("reload-on-conflict")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.84 });
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).not.toBeNull()
    );

    let reloadResolution!: Promise<boolean>;
    act(() => {
      reloadResolution = rendered.result.current.resolveSaveConflict("reload");
    });
    await expect(reloadResolution).resolves.toBe(true);
    await waitFor(() => expect(loads).toBe(2));
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    expect(rendered.result.current.saveConflict).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.22);
    expect(posts).toHaveLength(1);
  });

  test("catch-up saves an emitted local revision after reopening an older same-writer disk revision", async () => {
    const projectA = "unconfirmed-catch-up-a";
    const projectB = "unconfirmed-catch-up-b";
    const posts: ControlledSaveBody[] = [];
    let localWriter: string | null = null;
    let aLoads = 0;
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectA}`)) {
          aLoads++;
          return jsonResponse({
            project: {
              id: projectA,
              name: "Unconfirmed A",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 5,
              saveWriterId:
                aLoads === 1 ? "writer-serveraaa" : localWriter,
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.5 }),
            },
          });
        }
        if (url.endsWith(`/${projectB}`)) {
          return jsonResponse({
            project: {
              id: projectB,
              name: "Unconfirmed B",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 1,
              saveWriterId: "writer-serverbbb",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.2 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          localWriter = body.writerId;
          if (posts.length === 1) throw new TypeError("response lost");
          return jsonResponse({
            project: {
              id: projectA,
              name: "Unconfirmed A",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: projectA } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.79 });
    await waitFor(() => expect(posts).toHaveLength(1));
    rendered.rerender({ projectId: projectB });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    rendered.rerender({ projectId: projectA });
    await waitFor(() => expect(aLoads).toBe(2));
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    await waitFor(() => expect(posts).toHaveLength(2));

    expect(posts[1]).toMatchObject({
      writerId: localWriter,
      baseRevision: 5,
      snapshot: { splitRatio: 0.79 },
    });
  });

  test("keeps a true sendBeacon pending until visibility resumes and a POST confirms it", async () => {
    const posts: Array<{ body: ControlledSaveBody; keepalive?: boolean }> = [];
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/beacon-reconcile")) {
          return jsonResponse({
            project: {
              id: "beacon-reconcile",
              name: "Beacon reconcile",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push({ body, keepalive: init.keepalive });
          return jsonResponse({
            project: {
              id: "beacon-reconcile",
              name: "Beacon reconcile",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("beacon-reconcile")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.76 });
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(sendBeacon).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(0);

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(posts).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      keepalive: false,
      body: { snapshot: { splitRatio: 0.76 } },
    });
  });

  test("durably replays an unconfirmed large beacon without blobs or transient state", async () => {
    const posts: ControlledSaveBody[] = [];
    const imagePath = "C:\\media\\outbox.png";
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/durable-outbox")) {
          return jsonResponse({
            project: {
              id: "durable-outbox",
              name: "Durable outbox",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 3,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse({
            project: {
              id: "durable-outbox",
              name: "Durable outbox",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const first = renderHook(() => useProjectPersistence("durable-outbox"));
    await waitFor(() => expect(first.result.current.ready).toBe(true));

    useRepurposeStore.setState({
      words: [{ text: "x".repeat(70_000), start: 0, end: 1 }],
      mediaAssets: [
        {
          id: "outbox-image",
          kind: "image",
          name: "outbox.png",
          src: "blob:transient-preview",
          sourcePath: imagePath,
          naturalWidth: 1920,
          naturalHeight: 1080,
        },
      ],
      mediaReadiness: "ready",
      hydrating: false,
    });
    window.dispatchEvent(new Event("pagehide"));

    const outboxKey = `${OUTBOX_KEY_PREFIX}durable-outbox`;
    await waitFor(() => expect(localStorage.getItem(outboxKey)).not.toBeNull());
    const stored = localStorage.getItem(outboxKey) ?? "";
    expect(stored).not.toContain("blob:");
    expect(stored).not.toContain("mediaReadiness");
    expect(stored).not.toContain("hydrating");
    expect(JSON.parse(stored)).toMatchObject({
      id: "durable-outbox",
      snapshot: {
        mediaAssets: [
          {
            id: "outbox-image",
            src: `/api/repurpose/asset?path=${encodeURIComponent(imagePath)}`,
            sourcePath: imagePath,
          },
        ],
      },
    });
    expect(posts).toHaveLength(0);
    first.unmount();

    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
    const second = renderHook(() => useProjectPersistence("durable-outbox"));
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].snapshot.words?.[0]?.text).toHaveLength(70_000);
    expect(localStorage.getItem(outboxKey)).toBeNull();
  });

  test("persists an SPA unmount flush for replay after remount", async () => {
    const projectId = "spa-unmount-outbox";
    const posts: ControlledSaveBody[] = [];
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          return jsonResponse({
            project: {
              id: projectId,
              name: "SPA unmount outbox",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.4 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse({
            project: {
              id: projectId,
              name: "SPA unmount outbox",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const first = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    useRepurposeStore.setState({ splitRatio: 0.88 });

    first.unmount();

    const outboxKey = `${OUTBOX_KEY_PREFIX}${projectId}`;
    expect(localStorage.getItem(outboxKey)).not.toBeNull();
    expect(posts).toHaveLength(0);

    useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
    const second = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() => expect(second.result.current.ready).toBe(true));

    expect(posts).toHaveLength(1);
    expect(posts[0].snapshot.splitRatio).toBe(0.88);
    expect(localStorage.getItem(outboxKey)).toBeNull();
  });

  test("uses keepalive and exposes unsaved state when both durable stores reject", async () => {
    const posts: Array<{ body: ControlledSaveBody; keepalive?: boolean }> = [];
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key.startsWith(OUTBOX_KEY_PREFIX)) {
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/no-durable-channel")) {
          return jsonResponse({
            project: {
              id: "no-durable-channel",
              name: "No durable channel",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          posts.push({
            body: JSON.parse(String(init.body)) as ControlledSaveBody,
            keepalive: init.keepalive,
          });
          throw new TypeError("offline");
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("no-durable-channel")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    useRepurposeStore.setState({ splitRatio: 0.71 });

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      keepalive: true,
      body: { snapshot: { splitRatio: 0.71 } },
    });
    await waitFor(() =>
      expect(rendered.result.current.saveError).toEqual(expect.any(String))
    );
  });

  test("save-copy preserves stale-base edits from a cross-reload outbox conflict", async () => {
    const projectId = "outbox-stale-copy";
    const posts: Array<
      ControlledSaveBody & { id: string; name: string; mode?: "create" }
    > = [];
    localStorage.setItem(
      `${OUTBOX_KEY_PREFIX}${projectId}`,
      JSON.stringify({
        id: projectId,
        name: "Outbox stale copy",
        createdAt: "2026-08-24T00:00:00.000Z",
        writerId: "writer-previous-realm",
        baseRevision: 4,
        saveRevision: 6,
        snapshot: snapshot({ footageMeta: null, splitRatio: 0.91 }),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          return jsonResponse({
            project: {
              id: projectId,
              name: "Outbox stale copy",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 5,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.2 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (body.mode === "create") {
            return jsonResponse({
              project: {
                id: "outbox-stale-copy-copy",
                name: body.name,
                createdAt: "2026-08-25T00:00:00.000Z",
                saveRevision: body.saveRevision,
                saveWriterId: body.writerId,
              },
            });
          }
          return jsonResponse(
            {
              error: { code: "PROJECT_SAVE_CONFLICT", reason: "BASE_MISMATCH" },
              project: {
                id: projectId,
                saveRevision: 5,
                saveWriterId: "writer-serveraaa",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).toMatchObject({
        projectId,
        reason: "BASE_MISMATCH",
      })
    );
    expect(useRepurposeStore.getState().splitRatio).toBe(0.2);

    let copied = false;
    await act(async () => {
      copied = await rendered.result.current.resolveSaveConflict("save-copy");
    });

    expect(copied).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      id: "outbox-stale-copy-copy",
      mode: "create",
      snapshot: { splitRatio: 0.91 },
    });
  });

  test("serializes slow outbox replay before a newer catch-up save", async () => {
    const projectId = "outbox-ordered-replay";
    const posts: ControlledSaveBody[] = [];
    let releaseReplay!: (response: Response) => void;
    const deferredReplay = new Promise<Response>((resolve) => {
      releaseReplay = resolve;
    });
    localStorage.setItem(
      `${OUTBOX_KEY_PREFIX}${projectId}`,
      JSON.stringify({
        id: projectId,
        name: "Outbox ordered replay",
        createdAt: "2026-08-24T00:00:00.000Z",
        writerId: "writer-previous-realm",
        baseRevision: 5,
        saveRevision: 6,
        snapshot: snapshot({ footageMeta: null, splitRatio: 0.6 }),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          return jsonResponse({
            project: {
              id: projectId,
              name: "Outbox ordered replay",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 5,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.2 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          if (posts.length === 1) return deferredReplay;
          return jsonResponse({
            project: {
              id: projectId,
              name: "Outbox ordered replay",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() => expect(posts).toHaveLength(1));

    expect(rendered.result.current.ready).toBe(false);
    useRepurposeStore.setState({ splitRatio: 0.74 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(posts).toHaveLength(1);

    releaseReplay(
      jsonResponse({
        project: {
          id: projectId,
          name: "Outbox ordered replay",
          createdAt: "2026-08-24T00:00:00.000Z",
          saveRevision: 6,
          saveWriterId: "writer-previous-realm",
        },
      })
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));
    await waitFor(() => expect(posts).toHaveLength(2));

    expect(posts[0]).toMatchObject({
      writerId: "writer-previous-realm",
      baseRevision: 5,
      saveRevision: 6,
      snapshot: { splitRatio: 0.6 },
    });
    expect(posts[1]).toMatchObject({
      baseRevision: 6,
      snapshot: { splitRatio: 0.74 },
    });
    expect(posts[1].writerId).not.toBe("writer-previous-realm");
  });

  test("continues the keepalive fallback when durable outbox storage exceeds quota", async () => {
    const posts: ControlledSaveBody[] = [];
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key.startsWith(OUTBOX_KEY_PREFIX)) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/outbox-quota")) {
          return jsonResponse({
            project: {
              id: "outbox-quota",
              name: "Outbox quota",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 1,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse({
            project: {
              id: "outbox-quota",
              name: "Outbox quota",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence("outbox-quota"));
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.69 });
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].snapshot.splitRatio).toBe(0.69);
  });

  test("retries a large keepalive failure normally when the page becomes visible", async () => {
    const posts: Array<{ body: ControlledSaveBody; keepalive?: boolean }> = [];
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/large-beacon-fallback")) {
          return jsonResponse({
            project: {
              id: "large-beacon-fallback",
              name: "Large beacon fallback",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 1,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push({ body, keepalive: init.keepalive });
          if (init.keepalive) throw new TypeError("keepalive body too large");
          return jsonResponse({
            project: {
              id: "large-beacon-fallback",
              name: "Large beacon fallback",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("large-beacon-fallback")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({
      splitRatio: 0.67,
      words: [{ text: "x".repeat(70_000), start: 0, end: 1 }],
    });
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].keepalive).toBe(true);

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({
      keepalive: false,
      body: { snapshot: { splitRatio: 0.67 } },
    });
  });

  test("surfaces a keepalive fallback conflict through the recoverable conflict flow", async () => {
    const posts: Array<{ body: ControlledSaveBody; keepalive?: boolean }> = [];
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/keepalive-conflict")) {
          return jsonResponse({
            project: {
              id: "keepalive-conflict",
              name: "Keepalive conflict",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 4,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push({ body, keepalive: init.keepalive });
          return jsonResponse(
            {
              error: {
                code: "PROJECT_SAVE_CONFLICT",
                reason: "BASE_MISMATCH",
              },
              project: {
                id: "keepalive-conflict",
                saveRevision: 5,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("keepalive-conflict")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.83 });
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).toMatchObject({
        projectId: "keepalive-conflict",
        reason: "BASE_MISMATCH",
        serverRevision: 5,
      })
    );
    expect(posts[0]).toMatchObject({
      keepalive: true,
      body: { snapshot: { splitRatio: 0.83 } },
    });
  });

  test("materializes one debounced snapshot instead of deep-cloning every playhead tick", async () => {
    const posts: ControlledSaveBody[] = [];
    let nestedReads = 0;
    const countedAsset = {
      id: "counted-asset",
      kind: "image" as const,
      get name() {
        nestedReads++;
        return "counted.png";
      },
      src: "data:image/png;base64,AA==",
      naturalWidth: 1,
      naturalHeight: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/snapshot-materialization")) {
          return jsonResponse({
            project: {
              id: "snapshot-materialization",
              name: "Snapshot materialization",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 1,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse({
            project: {
              id: "snapshot-materialization",
              name: "Snapshot materialization",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() =>
      useProjectPersistence("snapshot-materialization")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    vi.useFakeTimers();
    try {
      useRepurposeStore.setState({ mediaAssets: [countedAsset] });
      for (let index = 0; index < 50; index++) {
        useRepurposeStore.setState({ playhead: index / 10 });
      }

      expect(nestedReads).toBe(0);
      await vi.advanceTimersByTimeAsync(501);

      expect(posts).toHaveLength(1);
      expect(posts[0].snapshot.playhead).toBe(4.9);
      expect(posts[0].snapshot.mediaAssets?.[0]).toMatchObject({
        name: "counted.png",
      });
      expect(nestedReads).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears a recoverable save conflict when the route changes", async () => {
    const posts: ControlledSaveBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/route-conflict-a")) {
          return jsonResponse({
            project: {
              id: "route-conflict-a",
              name: "Route conflict A",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url.endsWith("/route-conflict-b")) {
          return jsonResponse({
            project: {
              id: "route-conflict-b",
              name: "Route conflict B",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 1,
              saveWriterId: "writer-serverbbb",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.31 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          return jsonResponse(
            {
              error: {
                code: "PROJECT_SAVE_CONFLICT",
                reason: "BASE_MISMATCH",
              },
              project: {
                id: "route-conflict-a",
                saveRevision: 3,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "route-conflict-a" } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.82 });
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).toMatchObject({
        projectId: "route-conflict-a",
      })
    );

    rendered.rerender({ projectId: "route-conflict-b" });
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    expect(rendered.result.current.projectName).toBe("Route conflict B");
    expect(rendered.result.current.saveConflict).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.31);
  });

  test("treats a valid same-writer supersession as an autosave acknowledgement", async () => {
    const posts: ControlledSaveBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/same-writer-confirmation")) {
          return jsonResponse({
            project: {
              id: "same-writer-confirmation",
              name: "Same writer confirmation",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 4,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          if (posts.length === 1) {
            return jsonResponse(
              {
                error: {
                  code: "PROJECT_SAVE_CONFLICT",
                  reason: "SUPERSEDED_SAME_WRITER",
                },
                project: {
                  id: "same-writer-confirmation",
                  saveRevision: body.saveRevision + 1,
                  saveWriterId: body.writerId,
                },
              },
              409
            );
          }
          return jsonResponse({
            project: {
              id: "same-writer-confirmation",
              name: "Same writer confirmation",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const rendered = renderHook(() =>
      useProjectPersistence("same-writer-confirmation")
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({ splitRatio: 0.61 });
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => Promise.resolve());
    expect(rendered.result.current.saveConflict).toBeNull();

    useRepurposeStore.setState({ splitRatio: 0.72 });
    await waitFor(() => expect(posts).toHaveLength(2));

    expect(posts[1].baseRevision).toBe(posts[0].saveRevision + 1);
    expect(posts[1].snapshot.splitRatio).toBe(0.72);
    expect(rendered.result.current.saveConflict).toBeNull();
  });

  test("preserves forced replay across a failed GET until a later retry synchronizes it", async () => {
    const projectId = "failed-replay-newer-edit";
    const posts: ControlledSaveBody[] = [];
    let loads = 0;
    let releaseReplay!: (response: Response) => void;
    const deferredReplay = new Promise<Response>((resolve) => {
      releaseReplay = resolve;
    });
    localStorage.setItem(
      `${OUTBOX_KEY_PREFIX}${projectId}`,
      JSON.stringify({
        id: projectId,
        name: "Failed replay newer edit",
        createdAt: "2026-08-24T00:00:00.000Z",
        writerId: "writer-previous-realm",
        baseRevision: 5,
        saveRevision: 6,
        snapshot: snapshot({ footageMeta: null, splitRatio: 0.6 }),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          loads++;
          if (loads === 2) throw new TypeError("GET offline");
          return jsonResponse({
            project: {
              id: projectId,
              name: "Failed replay newer edit",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 5,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.2 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as ControlledSaveBody;
          posts.push(body);
          if (posts.length === 1) throw new TypeError("offline");
          if (posts.length === 2) return deferredReplay;
          return jsonResponse({
            project: {
              id: projectId,
              name: "Failed replay newer edit",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() =>
      expect(rendered.result.current.loadError).toEqual(
        expect.stringContaining(
          "Não foi possível sincronizar as alterações pendentes"
        )
      )
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(posts).toHaveLength(1);
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}${projectId}`)).not.toBeNull();

    useRepurposeStore.setState({ splitRatio: 0.79 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(posts).toHaveLength(1);

    act(() => rendered.result.current.retryLoad());
    await waitFor(() => expect(loads).toBe(2));
    await waitFor(() =>
      expect(rendered.result.current.loadError).toBe(
        "Não foi possível carregar o projeto. Tente novamente."
      )
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(posts).toHaveLength(1);
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}${projectId}`)).not.toBeNull();

    act(() => rendered.result.current.retryLoad());
    await waitFor(() => expect(posts).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(posts).toHaveLength(2);
    expect(rendered.result.current.ready).toBe(false);

    releaseReplay(
      jsonResponse({
        project: {
          id: projectId,
          name: "Failed replay newer edit",
          createdAt: "2026-08-24T00:00:00.000Z",
          saveRevision: 6,
          saveWriterId: "writer-previous-realm",
        },
      })
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    expect(posts[1]).toMatchObject({
      writerId: "writer-previous-realm",
      baseRevision: 5,
      saveRevision: 6,
      snapshot: { splitRatio: 0.6 },
    });
    expect(rendered.result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.6);
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}${projectId}`)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(posts).toHaveLength(2);
  });

  test("surfaces conflict recovery when retrying a failed outbox replay", async () => {
    const projectId = "failed-replay-conflict";
    const posts: Array<
      ControlledSaveBody & { id: string; name: string; mode?: "create" }
    > = [];
    localStorage.setItem(
      `${OUTBOX_KEY_PREFIX}${projectId}`,
      JSON.stringify({
        id: projectId,
        name: "Failed replay conflict",
        createdAt: "2026-08-24T00:00:00.000Z",
        writerId: "writer-previous-realm",
        baseRevision: 5,
        saveRevision: 6,
        snapshot: snapshot({ footageMeta: null, splitRatio: 0.61 }),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          return jsonResponse({
            project: {
              id: projectId,
              name: "Failed replay conflict",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 5,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null, splitRatio: 0.2 }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (posts.length === 1) throw new TypeError("offline");
          if (body.mode === "create") {
            return jsonResponse({
              project: {
                id: `${projectId}-copy`,
                name: body.name,
                createdAt: "2026-08-25T00:00:00.000Z",
                saveRevision: body.saveRevision,
                saveWriterId: body.writerId,
              },
            });
          }
          return jsonResponse(
            {
              error: { code: "PROJECT_SAVE_CONFLICT", reason: "BASE_MISMATCH" },
              project: {
                id: projectId,
                saveRevision: 7,
                saveWriterId: "writer-competing",
              },
            },
            409
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() =>
      expect(rendered.result.current.loadError).toEqual(
        expect.stringContaining(
          "Não foi possível sincronizar as alterações pendentes"
        )
      )
    );
    expect(rendered.result.current.ready).toBe(false);
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}${projectId}`)).not.toBeNull();

    act(() => rendered.result.current.retryLoad());
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).toMatchObject({
        projectId,
        reason: "BASE_MISMATCH",
        serverRevision: 7,
      })
    );

    expect(rendered.result.current.ready).toBe(true);
    expect(rendered.result.current.loadError).toBeNull();
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}${projectId}`)).not.toBeNull();
    let copied = false;
    await act(async () => {
      copied = await rendered.result.current.resolveSaveConflict("save-copy");
    });

    expect(copied).toBe(true);
    expect(posts).toHaveLength(3);
    expect(posts[2]).toMatchObject({
      id: `${projectId}-copy`,
      mode: "create",
      snapshot: { splitRatio: 0.61 },
    });
  });

  test("offers save-copy from the retained outbox when the project was deleted", async () => {
    const projectId = "deleted-with-durable-outbox";
    const outboxKey = `${OUTBOX_KEY_PREFIX}${projectId}`;
    const posts: Array<
      ControlledSaveBody & { id: string; name: string; mode?: "create" }
    > = [];
    let loads = 0;
    localStorage.setItem(
      outboxKey,
      JSON.stringify({
        id: projectId,
        name: "Deleted durable project",
        createdAt: "2026-08-24T00:00:00.000Z",
        writerId: "writer-previous-realm",
        baseRevision: 5,
        saveRevision: 6,
        snapshot: snapshot({ footageMeta: null, splitRatio: 0.64 }),
      })
    );
    useRepurposeStore.setState({ splitRatio: 0.33 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          loads++;
          return jsonResponse({ error: { code: "PROJECT_NOT_FOUND" } }, 404);
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (body.mode !== "create") {
            throw new Error("Missing projects must not receive update POSTs");
          }
          return jsonResponse({
            project: {
              id: `${projectId}-copy-2`,
              name: body.name,
              createdAt: "2026-08-25T00:00:00.000Z",
              saveRevision: body.saveRevision,
              saveWriterId: body.writerId,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence(projectId));
    await waitFor(() =>
      expect(rendered.result.current.saveConflict).toMatchObject({
        projectId,
        reason: "PROJECT_NOT_FOUND",
        serverRevision: null,
      })
    );

    expect(rendered.result.current.ready).toBe(true);
    expect(rendered.result.current.loadError).toBeNull();
    expect(useRepurposeStore.getState().splitRatio).toBe(0.64);
    expect(localStorage.getItem(outboxKey)).not.toBeNull();
    expect(posts).toHaveLength(0);

    let reloadResolution!: Promise<boolean>;
    act(() => {
      reloadResolution = rendered.result.current.resolveSaveConflict("reload");
    });
    await expect(reloadResolution).resolves.toBe(false);
    expect(loads).toBe(2);
    expect(rendered.result.current.saveConflict).toMatchObject({
      projectId,
      reason: "PROJECT_NOT_FOUND",
    });
    expect(localStorage.getItem(outboxKey)).not.toBeNull();
    expect(posts).toHaveLength(0);

    let copied = false;
    await act(async () => {
      copied = await rendered.result.current.resolveSaveConflict("save-copy");
    });

    expect(copied).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: `${projectId}-copy`,
      mode: "create",
      snapshot: { splitRatio: 0.64 },
    });
    expect(localStorage.getItem(outboxKey)).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith(
      `/repurpose-studio/${projectId}-copy-2`
    );
  });

  test("durably transfers a post-create catch-up across router replacement", async () => {
    const realProjectId = "created-durable-catchup";
    const posts: Array<
      ControlledSaveBody & { id: string; name: string; mode?: "create" }
    > = [];
    let releaseCreate!: (response: Response) => void;
    let releaseCatchUp!: (response: Response) => void;
    let releaseReplay!: (response: Response) => void;
    const deferredCreate = new Promise<Response>((resolve) => {
      releaseCreate = resolve;
    });
    const deferredCatchUp = new Promise<Response>((resolve) => {
      releaseCatchUp = resolve;
    });
    const deferredReplay = new Promise<Response>((resolve) => {
      releaseReplay = resolve;
    });
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as (typeof posts)[number];
          posts.push(body);
          if (posts.length === 1) return deferredCreate;
          if (posts.length === 2) return deferredCatchUp;
          if (posts.length === 3) return deferredReplay;
          throw new Error("Unexpected duplicate project POST");
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(
      ({ projectId }) => useProjectPersistence(projectId),
      { initialProps: { projectId: "new-durable-catchup" } }
    );
    await waitFor(() => expect(rendered.result.current.ready).toBe(true));

    useRepurposeStore.setState({
      clips: [clip],
      duration: 5,
      words: [{ text: "Durable catchup", start: 0, end: 1 }],
      splitRatio: 0.4,
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].mode).toBe("create");
    useRepurposeStore.setState({ splitRatio: 0.86 });

    releaseCreate(
      jsonResponse({
        project: {
          id: realProjectId,
          name: "Durable catchup",
          createdAt: "2026-08-24T00:00:00.000Z",
          saveRevision: posts[0].saveRevision,
          saveWriterId: posts[0].writerId,
        },
      })
    );
    await waitFor(() => expect(posts).toHaveLength(2));
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        `/repurpose-studio/${realProjectId}`
      )
    );
    expect(posts[1]).toMatchObject({
      id: realProjectId,
      snapshot: { splitRatio: 0.86 },
    });
    expect(posts[1]).not.toHaveProperty("mode");

    rendered.rerender({ projectId: realProjectId });
    await waitFor(() => expect(posts).toHaveLength(3));
    const outboxKey = `${OUTBOX_KEY_PREFIX}${realProjectId}`;
    expect(localStorage.getItem(outboxKey)).not.toBeNull();
    expect(posts.filter((post) => post.mode === "create")).toHaveLength(1);
    expect(new Set(posts.map((post) => post.saveRevision)).size).toBe(3);
    expect(posts[2].snapshot.splitRatio).toBe(0.86);

    releaseCatchUp(jsonResponse({ error: { code: "OFFLINE" } }, 503));
    releaseReplay(
      jsonResponse({
        project: {
          id: realProjectId,
          name: "Durable catchup",
          createdAt: "2026-08-24T00:00:00.000Z",
          saveRevision: posts[2].saveRevision,
          saveWriterId: posts[2].writerId,
        },
      })
    );
    await waitFor(() => expect(localStorage.getItem(outboxKey)).toBeNull());
    expect(posts).toHaveLength(3);
  });

  test("loads and exposes an unsaved warning when storage getters throw", async () => {
    const projectId = "storage-getter-security-error";
    const posts: Array<{ body: ControlledSaveBody; keepalive?: boolean }> = [];
    const localGetter = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("Storage denied", "SecurityError");
      });
    const sessionGetter = vi
      .spyOn(window, "sessionStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("Storage denied", "SecurityError");
      });
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${projectId}`)) {
          return jsonResponse({
            project: {
              id: projectId,
              name: "Storage getter security error",
              createdAt: "2026-08-24T00:00:00.000Z",
              saveRevision: 2,
              saveWriterId: "writer-serveraaa",
              snapshot: snapshot({ footageMeta: null }),
            },
          });
        }
        if (url === "/api/repurpose/projects" && init?.method === "POST") {
          posts.push({
            body: JSON.parse(String(init.body)) as ControlledSaveBody,
            keepalive: init.keepalive,
          });
          throw new TypeError("offline");
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const rendered = renderHook(() => useProjectPersistence(projectId));
    try {
      await waitFor(() => expect(rendered.result.current.ready).toBe(true));
      expect(sessionGetter).toHaveBeenCalled();

      useRepurposeStore.setState({ splitRatio: 0.73 });
      window.dispatchEvent(new Event("pagehide"));

      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toMatchObject({
        keepalive: true,
        body: { snapshot: { splitRatio: 0.73 } },
      });
      await waitFor(() =>
        expect(rendered.result.current.saveError).toEqual(expect.any(String))
      );
    } finally {
      rendered.unmount();
      localGetter.mockRestore();
      sessionGetter.mockRestore();
    }
  });
});
